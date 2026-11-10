import type { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { privateDir } from "./auth/private.js";
import { type Instructions, type Reached, readInstructions, type Where } from "./core/instructions.js";
import { MODES, type Mode, OFFERED, type Protection, visible } from "./core/permissions.js";
import { subagentPrompt, systemPrompt } from "./core/prompt.js";
import { type Conversation, Session, type SessionOptions } from "./core/session.js";
import { copySession, entryOf, findSession, listSessions, openSession, removeSession, type Row, sessionPaths, Unreadable } from "./core/sessions.js";
import { type Line, pathsOf, type Read, readTranscript, Transcript } from "./core/transcript.js";
import { errorText, madeUnder, type Message, type ToolSpec } from "./core/types.js";
import { gitBash } from "./exec/env.js";
import type { Executor } from "./exec/executor.js";
import type { Answers } from "./mcp/answers.js";
import type { ServerConfig } from "./mcp/config.js";
import { SEARCH } from "./mcp/search.js";
import { KILL_MS } from "./mcp/server.js";
import type { Servers } from "./mcp/servers.js";
import { EFFORTS, type Effort } from "./providers/anthropic.js";
import { gitFolderOutside, type GitSettings, gitSettings, hasSubmodules, within } from "./safety/gitconfig.js";
import { NO_RULES, type UserRules } from "./safety/rules.js";
import { type Shell, shellOf } from "./safety/split.js";
import { BoxWorkspace } from "./sandbox/boxWorkspace.js";
import { docker } from "./sandbox/docker.js";
import { BOX_HOME, boxLimits, boxUser, DockerExecutor, dockerRoom, memoryText, NO_DOCKER, type Room, sweepBoxes, unlimitedLine } from "./sandbox/executor.js";
import { heldLine, type ImageIo, prepareImage } from "./sandbox/image.js";
import { CASE_REFUSED, ignoresCase, liveMounts, type Mount, sessionSettings } from "./sandbox/mounts.js";
import { MANIFEST, type Manifest, PENDING, removeCopySync, snapshot } from "./sandbox/snapshot.js";
import type { SandboxLimits, Settings } from "./settings.js";
import { shellToolOf } from "./tools/shell.js";
import type { Tool } from "./tools/tool.js";
import { screen } from "./tui/describe.js";
import { gitBranch } from "./tui/git.js";
import { Pictures } from "./tui/pictures.js";
import { leftOut, notRemoved, removing } from "./tui/Review.js";
import { k, type Segment, SEGMENTS } from "./tui/StatusLine.js";
import { writeBestEffort } from "./tui/terminal.js";

// Headless output reaches the terminal too, so model and provider text gets the scrollback's escaping.
export const prose = (text: string) => screen({ text }).text;

// The -p answer may be saved and read later, so it is escaped wherever it goes (gh and Gemini CLI do the
// same; see "Changed while building"). Unlike the scrollback, it keeps what is harmless and wanted in a
// saved file: \r\n (a \r just before \n cannot overwrite anything), tabs, and the plain direction marks
// U+200E, U+200F and U+061C of ordinary right-to-left text. Overrides and isolates, which can reorder
// text, are still escaped. Escaping is never silent off the terminal: the note says it happened.
const UNSAFE = /\r(?!\n)|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;

export function headlessAnswer(text: string, opts: { raw: boolean; tty: boolean }): { out: string; note?: string } {
  if (opts.raw) return { out: text };
  let n = 0;
  const out = text.replace(UNSAFE, (c) => (n++, visible(c)));
  if (!n || opts.tty) return { out };
  return { out, note: `note: ${n} control character${n === 1 ? " in the answer was" : "s in the answer were"} printed as escapes; --raw prints the answer exactly` };
}

// JSON.stringify has already escaped \n, \r, \t and the other C0 characters; visible() writes the rest
// (C1, DEL, bidi overrides) as the \uXXXX escapes JSON itself uses, so the line parses to the same value.
export const jsonLine = (event: string, data: unknown) => visible(JSON.stringify({ event, data }));

// The line for an action a -p run declines, as nobody can approve it: why, then the subagent that asked, if one did, and
// the action, already escaped by the gate (permissions.ts, require). A dangerous command's red lines, escaped by the gate
// as the action is, come first, a line each (release 7 plan, Task 8).
export function headlessDeclined(summary: string, owner?: string, warnings: string[] = []): string {
  const why =
    "declined, nobody to ask in -p mode (--mode project allows ordinary writes inside the project, " +
    "but protected files, shell commands and anything outside it are still refused)";
  return [...warnings, `${why}: ${owner ? `${prose(owner)}: ` : ""}${summary}`].join("\n");
}

// Stopped wins: an aborted request reports no error, and the shell reads 128 + n as "stopped by signal n".
// A declined action fails the run, or a script would take a run that did nothing for success.
export function headlessExit(run: { aborted: boolean; failed: boolean; declined: boolean }): number {
  if (run.aborted) return 128 + constants.signals.SIGINT;
  return run.failed || run.declined ? 1 : 0;
}

// Eight Claude Haiku 5.5 subagents ran at once on the user's account with none refused; eight was the
// most tried (release 4 design, "Before the build", 2026-10-26).
export const MAX_TASKS = 8;

// The flags' own checks take the name to put before their words: `--mode`, or the settings file's `settings.json: "mode"`
// (release 6 plan, choice 8), so a flag and the file get the same rule and the same words. `shown` is the list the words
// name, where a value is read but not offered.
export function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[], shown: readonly T[] = allowed): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`${name} must be one of: ${shown.join(", ")} (got "${value}")`);
  return value as T;
}

// Digits only: Number() would also take "1e1", " 8 " and "0x10".
export function taskCount(value: string, name: string): number {
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number from 1 (got "${value}")`);
  return n;
}

// A segment named twice is shown once, where it first appears. --status gives them comma-separated, the settings file as a
// list (the plan's choice 7).
export function statusSegments(value: string | string[] | undefined, name = "--status"): Segment[] {
  if (value === undefined) return SEGMENTS;
  const names = (typeof value === "string" ? value.split(",") : value).map((s) => {
    const segment = s.trim();
    if (!(SEGMENTS as string[]).includes(segment)) throw new Error(`${name} must be one of: ${SEGMENTS.join(", ")} (got "${segment}")`);
    return segment as Segment;
  });
  return [...new Set(names)];
}

// Full screen unless asked for classic (release 5 design, "The two modes"). An empty TACHI_CLASSIC or 0 reads as unset
// (the plan's choice 14), so `TACHI_CLASSIC=0` turns it off. Then the settings file's "screen" (release 6 design, "Which
// wins"). Classic too where full screen can't draw (fullPossible).
export function screenMode(classic: boolean | undefined, env: NodeJS.ProcessEnv, tty: boolean, file?: "full" | "classic"): "full" | "classic" {
  const value = env.TACHI_CLASSIC ?? "";
  return classic || (value !== "" && value !== "0") || file === "classic" || !fullPossible(env, tty) ? "classic" : "full";
}

// Where Ink would not use its own second screen (the user's choice, 2026-10-27, at Task 6's build), full screen can't
// draw: output that is not a terminal, or CI, which Ink counts as not interactive even on a terminal (ink.js,
// resolveInteractiveOption and resolveAlternateScreenOption, lines 706-713). CI as Ink's is-in-ci reads it: CI or
// CONTINUOUS_INTEGRATION set to anything but 0 or false (node_modules/is-in-ci/index.js). /screen asks it too (found at
// the final review).
export function fullPossible(env: NodeJS.ProcessEnv, tty: boolean): boolean {
  const ci = ["CI", "CONTINUOUS_INTEGRATION"].some((key) => key in env && env[key] !== "0" && env[key] !== "false");
  return tty && !ci;
}

// Rows a wheel notch scrolls (release 5 design, "Scrolling"): 3 unless given, the probe's Windows setting and Claude
// Code's note that 3 matches vim; up to 20, the range of Claude Code's CLAUDE_CODE_SCROLL_SPEED. Digits with an optional
// decimal point only (the plan's choice 15): Number() would also take "1e1", " 3" and "0x10". The option wins over the
// variable, and an empty variable is unset, as TACHI_LEAD and TACHI_WORKER are; then the settings file's, already checked.
export function scrollSpeed(option: string | undefined, env: NodeJS.ProcessEnv, file?: number): number {
  const [value, name] = option !== undefined ? [option, "--scroll-speed"] : [env.TACHI_SCROLL_SPEED || undefined, "TACHI_SCROLL_SPEED"];
  if (value === undefined) return file ?? 3;
  return speedValue(value, name);
}

export function speedValue(value: string, name: string): number {
  const speed = /^\d+(\.\d+)?$|^\.\d+$/.test(value) ? Number(value) : NaN;
  if (!(speed > 0 && speed <= 20)) throw new Error(`${name} must be a number above 0, up to 20 (got "${value}")`);
  return speed;
}

export interface Flags {
  lead?: string;
  mode?: string;
  effort?: string;
  fallback?: string;
  worker?: string;
  "max-tasks"?: string;
  status?: string;
  classic?: boolean;
  "scroll-speed"?: string;
  print?: string;
  sandbox?: string;
  network?: string;
  judge?: string;
}

// Where commands run, and whether the box reaches the internet (release 7 design, "Launching"): both off unless asked for.
export const SANDBOXES = ["off", "live", "copy"] as const;
export type Sandbox = (typeof SANDBOXES)[number];
export const NETWORKS = ["off", "on"] as const;
export type Network = (typeof NETWORKS)[number];

// Each launch option from its flag, then its TACHI_ variable, then the settings file, then the default (release 6 design,
// "Which wins"). A bad flag throws in its own words; the file's values were checked when it was read. An empty variable is
// unset; an empty --fallback, --worker or --judge still wins, so it turns the file's off as it turned the variable's off
// before. The screen is screenMode's, which also asks the terminal; createProvider checks the lead, fallback, worker and
// judge at use. The sandbox, the network and the judge have no TACHI_ variable (release 7 plan, Task 7).
// The flags are checked in release 5's order. The lead is leadOf's.
export function resolve(flags: Flags, env: NodeJS.ProcessEnv, settings: Settings) {
  return {
    mode: oneOf<Mode>("--mode", flags.mode, MODES, OFFERED) ?? settings.mode ?? "ask", // the safest mode is the default
    effort: oneOf<Effort>("--effort", flags.effort, EFFORTS) ?? settings.effort,
    fallback: flags.fallback ?? settings.fallback,
    worker: flags.worker ?? (env.TACHI_WORKER || undefined) ?? settings.worker,
    sandbox: oneOf<Sandbox>("--sandbox", flags.sandbox, SANDBOXES) ?? settings.sandbox ?? "off",
    network: oneOf<Network>("--network", flags.network, NETWORKS) ?? settings.network ?? "off",
    judge: flags.judge ?? settings.judge, // unset, the lead's model judges (release 7 design, "The modes")
    maxTasks: flags["max-tasks"] === undefined ? (settings.maxTasks ?? MAX_TASKS) : taskCount(flags["max-tasks"], "--max-tasks"),
    segments: flags.status === undefined ? (settings.status ?? SEGMENTS) : statusSegments(flags.status),
    // -p has no screen to scroll, so it ignores TACHI_SCROLL_SPEED as it does TACHI_CLASSIC, and the file's scrollSpeed too,
    // though the file is still checked whole, so a bad one there stops -p. A bad --scroll-speed, typed for this run, still
    // stops it (the user's choice, 2026-10-27, at release 5's Task 7 review).
    speed: flags.print === undefined ? scrollSpeed(flags["scroll-speed"], env, settings.scrollSpeed) : scrollSpeed(flags["scroll-speed"], {}),
  };
}

// The entries a flag or TACHI_ variable gave at launch, each with that flag's or variable's name: a live edit of the
// settings file leaves them as given for the session, and its line names which (release 6 design, "Live edits"). As
// resolve and screenMode read them: an empty variable is unset, and TACHI_CLASSIC=0 too; an empty --fallback is given.
export type Given = Partial<Record<keyof Settings, string>>;
const GIVERS: [keyof Settings, keyof Flags, string?][] = [
  ["lead", "lead", "TACHI_LEAD"],
  ["mode", "mode"],
  ["effort", "effort"],
  ["fallback", "fallback"],
  ["worker", "worker", "TACHI_WORKER"],
  ["maxTasks", "max-tasks"],
  ["status", "status"],
  ["screen", "classic", "TACHI_CLASSIC"],
  ["scrollSpeed", "scroll-speed", "TACHI_SCROLL_SPEED"],
  ["sandbox", "sandbox"],
  ["network", "network"],
  ["judge", "judge"],
];
export function givenBy(flags: Flags, env: NodeJS.ProcessEnv): Given {
  const given: Given = {};
  for (const [entry, flag, variable] of GIVERS) {
    if (flags[flag] !== undefined) given[entry] = `--${flag}`;
    else if (variable && env[variable] && !(variable === "TACHI_CLASSIC" && env[variable] === "0")) given[entry] = variable;
  }
  return given;
}

// Apart from resolve, since a missing lead is told before any bad flag, as in release 5.
export function leadOf(flags: Flags, env: NodeJS.ProcessEnv, settings: Settings): string | undefined {
  return flags.lead ?? (env.TACHI_LEAD || undefined) ?? settings.lead;
}

// The signals that end Tachikoma through process.exit, so `exit` handlers run: the executor's, which stops running
// commands, and the one that puts the terminal back (release 5 design, "When something goes wrong"). Ctrl+Break and
// SIGQUIT were added at Task 6's review (the user's choice, 2026-10-27): Windows sends SIGBREAK for Ctrl+Break even in
// raw mode ("CTRL+BREAK is always treated as a signal", Microsoft's "CTRL+C and CTRL+BREAK Signals", read 2026-10-27;
// raw mode turns off only Ctrl+C's). signal-exit (node_modules/signal-exit/signals.js) knows neither on Windows; elsewhere it catches SIGQUIT, but
// only to unmount Ink and send the signal again, so the process dies with no `exit` event, on the second screen.
export function exitSignals(platform: NodeJS.Platform): NodeJS.Signals[] {
  return ["SIGTERM", "SIGHUP", platform === "win32" ? "SIGBREAK" : "SIGQUIT"];
}

// The handler cli.tsx gives a signal that ends Tachikoma: exit with 128 and its number. While a program has the terminal
// (owner.ts, programRunning: the editor), raw mode is off, so Ctrl-C and Ctrl-\ come as SIGINT and SIGQUIT; they are
// the program's keys then and are ignored here, as Git's launch_specified_editor ignores both while the editor runs
// (editor.c, its sigchain_push(SIGINT, SIG_IGN), read 2026-10-29). The turn goes on (release 6 plan, choice 31).
// `before` runs first, the exit coming however it ends: the launch's stop of the MCP servers (release 8c plan, Task 9).
export function exitOn(sig: NodeJS.Signals, programRunning: () => boolean, before?: () => Promise<void>): () => void {
  return () => {
    if (programRunning() && (sig === "SIGINT" || sig === "SIGQUIT")) return;
    const exit = () => process.exit(128 + constants.signals[sig]);
    if (before) void before().then(exit, exit);
    else exit();
  };
}

// The MCP servers stopped for a signal's exit, waiting at most choice 3's wait, so a hung one cannot hold the exit; the
// exit's kill then takes any local one left (exec/local.ts, running), as a remote one has nothing left to run (release 8c
// plan, Task 9's spec review).
export function stopSoon(servers: Pick<Servers, "stopAll">): Promise<void> {
  return Promise.race([servers.stopAll(), sleep(KILL_MS)]);
}

// The answer a -p run prints: the reply its turn added, the last message, when it is the model's, its text parts joined;
// none when the turn added none, as one blocked, left unsent, or stopped before it sent anything, so a resumed run never
// prints the saved session's last answer as its own (Task 9's review). `before` is the last message before the turn.
export function turnAnswer(before: Message | undefined, messages: Message[]): string | undefined {
  const last = messages.at(-1);
  if (!last || last === before || last.role !== "assistant") return undefined;
  return last.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
}

// A reader such as `head` that stops early is a normal end, not a crash.
export function endOnEpipe(err: NodeJS.ErrnoException): void {
  if (err.code !== "EPIPE") throw err;
  process.exit();
}

// The launch's line while a kind of the dangerous-command check is off (release 7 plan, Task 4), so what is not checked
// stays in sight (release 7 design, "Configurable"); null while none is.
export function checkOffLine(rules: UserRules = NO_RULES): string | null {
  return rules.off.length ? `The dangerous-command check is off for: ${rules.off.join(", ")}; in auto and never, those commands run without it.` : null;
}

// What the gate holds of git's settings for the file tools (release 7 plan, Task 8; choices 57 and 59): the hooks folders
// and the git folders, protected whole, and the settings files. Without git, nothing, so only the fixed list protects
// (choice 11). The `problems` are for live link (Task 15), not the host.
export function protectionOf(git: GitSettings | undefined): Protection {
  return git ? { hooks: [...git.hooksPaths, ...git.gitDirs], files: git.files } : { hooks: [], files: [] };
}

// The line when git's settings cannot be read, so only the fixed list of protected paths applies (Task 8), escaped: with
// the sandbox off and in copy mode, which goes on without them, as nothing reaches the folder before the review.
export const gitUnread = (err: unknown) => visible(`git's settings could not be read (${errorText(err)}); only the fixed list of protected paths applies`);

// Headless copy mode's line on stderr after the answer (choice 29): the copy is kept, for `tachi review`.
export const keptForReview = (name: string) => `Changes kept for review: tachi review ${name}`;

// The network setting acts only in the sandbox (release 7 design, "Launching"), so a --network typed for this launch
// without it is said, and the session starts (release 7 plan, choice 22): at launch, and again in full screen (App.tsx).
// null when there is nothing to say.
export function networkLine(flags: Flags, sandbox: Sandbox): string | null {
  return flags.network !== undefined && sandbox === "off" ? "--network acts only with the sandbox on; it was ignored" : null;
}

// Without Git Bash, a hook run by a shell runs in Windows PowerShell (release 8b plan, choices 1 and 2), which the launch
// says once, when such a hook is in force, and again in full screen (App.tsx); one that asks for PowerShell, or runs
// without a shell (`args`), needs no Git Bash. Undefined when there is nothing to say. `bash` is the lookup (exec/env.ts),
// which a test gives, as Git for Windows' install folder cannot be hidden from a child process (Windows sets ProgramFiles
// for each one, seen 2026-11-10). An mcp_tool hook calls a server, with no shell (release 8c plan, Task 8).
export function gitBashLine(settings: Settings, platform: NodeJS.Platform = process.platform, bash: () => string | null = gitBash): string | undefined {
  const shelled = !settings.disableAllHooks && (settings.hooks ?? []).some((h) => !h.mcp && !h.args && h.shell !== "powershell");
  return platform === "win32" && shelled && bash() === null
    ? "Git Bash was not found, so hooks run by a shell use Windows PowerShell; set CLAUDE_CODE_GIT_BASH_PATH to its bash.exe to change that."
    : undefined;
}

// Live link's launch (release 7 plan, Task 16), in the plan's order: choice 13's refusal; Docker's state and the image
// (image.ts, prepareImage); git's settings and the submodules (choice 123); the mounts (mounts.ts); then cli.tsx reads
// the instruction files on the host; then sandboxStart removes leftover boxes, starts the box and checks its node (choice
// 17). Each refusal is printed by `io.err` and ends the launch with the code given. Docker is reached through `io.run`
// (choice 69); `gitSettings`, `submodules` and `ignoresCase` are given by tests, which run git with their own settings
// and take the letter-case check as passed on this PC's folders (choice 104). No flag or variable turns that check off.
// The box's folder for the project, where the model works (choice 19), and its home (executor.ts, choice 77).
const BOX_ROOT = "/work";

// `note`: a line said while the launch works, grey on a terminal (cli.tsx); `err` when not given.
export interface SandboxIo extends ImageIo {
  note?: (line: string) => void;
  gitSettings?: (root: string) => Promise<GitSettings | undefined>;
  submodules?: (root: string) => Promise<boolean>;
  ignoresCase?: (folder: string) => boolean;
}
// `gitOutside`: the project's `.git` is a file naming a git folder outside it (choice 107). `copy`: copy mode's copy
// (Task 21), and `gitLine` the line said when git's settings could not be read for it.
export type Ready = {
  tag: string;
  git: GitSettings | undefined;
  mounts: Mount[];
  env: Record<string, string>;
  gitOutside: boolean;
  copy?: Copied;
  gitLine?: string;
};
// The copy's folder (`copies/<session>/` in the data folder), its manifest, how long the copy took, and the host's branch
// for the box's repository, if it has one the box can take (boxBranch).
export interface Copied { folder: string; manifest: Manifest; ms: number; branch?: string }

// With `copy`, copy mode's launch (Task 21): Task 16's order, with the snapshot (Task 17) in the mounts' place. It is not
// refused on a folder that ignores letter case, which is live link's alone (choice 104), and it goes on when git's
// settings cannot be read, which only add to the gate's protected paths. A copy the launch stops after is removed at
// exit (dropOnExit), as nothing has run in it.
export async function sandboxReady(root: string, io: SandboxIo, copy?: { session: string }): Promise<Ready | { exit: number }> {
  const refuse = (line: string) => (io.err(visible(line)), { exit: 1 });
  const held = heldLine(root);
  if (held) return refuse(held);
  // The letter-case check right after, before Docker is asked anything, so Windows and macOS users are not asked to build
  // the image only to be refused (choice 108). The mounts below then take it as passed.
  if (!copy && (io.ignoresCase ?? ignoresCase)(root)) return refuse(CASE_REFUSED);
  const image = await prepareImage(root, io);
  if ("exit" in image) return image;
  let git: GitSettings | undefined;
  let submodules = false;
  let failed: unknown;
  try {
    git = await (io.gitSettings ?? gitSettings)(root);
    // Live link's alone (choice 123), and only once git's settings have nothing wrong, which is refused first: git reads
    // them as it lists the index. Its failure refuses live link as git's settings' does.
    if (!copy && git?.problems.length === 0) submodules = await (io.submodules ?? hasSubmodules)(root);
  } catch (err) {
    failed = err;
  }
  // A Ctrl-C meanwhile stops the launch as one during the image's steps does (image.ts), whether or not it ended git.
  if (io.signal.aborted) return { exit: 128 + constants.signals.SIGINT };
  if (copy) {
    const gitLine = failed === undefined ? undefined : gitUnread(failed);
    if (gitLine) io.err(gitLine);
    (io.note ?? io.err)(visible(`Copying ${root} for the sandbox...`)); // the user's choice and words
    const from = performance.now();
    let got: Awaited<ReturnType<typeof snapshot>>;
    try {
      got = await snapshot(root, copy.session, undefined, { signal: io.signal });
    } catch (err) {
      // A Ctrl-C during the copy ends the launch as one during the image's steps does, saying nothing more.
      if (io.signal.aborted) return { exit: 128 + constants.signals.SIGINT };
      return refuse(errorText(err));
    }
    const branch = boxBranch(gitBranch(root));
    const copied = { folder: path.dirname(got.work), manifest: got.manifest, ms: performance.now() - from, ...(branch ? { branch } : {}) };
    // A Ctrl-C after the copy's last entry.
    if (io.signal.aborted) return { exit: 128 + constants.signals.SIGINT };
    // safe.directory, as live link's mounts give it (mounts.ts): the copy's folder is not the box's user's either.
    const env = sessionSettings({ "safe.directory": BOX_ROOT });
    return { tag: image.tag, git, mounts: [], env, gitOutside: false, copy: copied, ...(gitLine ? { gitLine } : {}) };
  }
  // Without them the mounts cannot be worked out, so live link is refused, as for Task 5's problems.
  if (failed) return refuse(`Live link is refused: git's settings could not be read (${errorText(failed)}). Launch with --sandbox copy instead.`);
  const live = liveMounts(root, git, { ignoresCase: () => false, submodules });
  if ("refused" in live) return refuse(live.refused);
  return { tag: image.tag, git, ...live, gitOutside: gitFolderOutside(root) };
}


// What the session runs on once the box has started: the box's executor and workspace, sharing one stopped state
// (executor.ts, BoxState), and what the session tells the model and the gate, all in the box's terms.
export interface Started {
  box: DockerExecutor;
  root: string;
  executor: Executor;
  workspace: BoxWorkspace;
  system: string;
  subagentSystem: string;
  gate: { root: string; home: string; shell: Shell };
  shellTool: Tool;
  protection: Protection;
  lines: string[];
  copy?: Copied;
}

// Choice 24: the box makes /work a new git repository and commits the snapshot as one commit, by Tachikoma, each git run
// a docker exec of its own, given as words, never as shell text. Files git's ignore rules cover are left out of the
// commit, as `git add` leaves them, though they are in the copy. The repository takes the host's branch, if any (the
// user's choice; boxBranch).
const commitArgs = (branch: string | undefined) => [
  ["init", "-q", ...(branch ? [`--initial-branch=${branch}`] : [])],
  ["add", "-A"],
  ["-c", "user.name=Tachikoma", "-c", "user.email=tachikoma@localhost", "commit", "-q", "--allow-empty", "-m", "The project as Tachikoma copied it"],
];

// The host's branch (tui/git.ts, gitBranch, as the status line reads it) when the box's git can take it as it is: only
// letters, digits, `.`, `_`, `-` and `/`, not starting with `-`, `.` or `/`, with no `..`, `//` or `/.`, not ending in
// `/` or `.`, and no part ending in `.lock` (git-check-ref-format's rules, within that narrower set), so it can never act
// as an option nor be refused by git. Any other name, a detached HEAD ("HEAD") or no repository gives undefined, and
// git's own default.
export function boxBranch(name: string | null): string | undefined {
  const plain = /^(?![-./])(?!.*(\.\.|\/\/|\/\.))[A-Za-z0-9._/-]+(?<![/.])$/;
  return name !== null && name !== "HEAD" && plain.test(name) && !/\.lock(\/|$)/.test(name) ? name : undefined;
}

// Until copy mode's session starts, its copy, with nothing run in it, is removed when the process ends, however it ends:
// a refusal, Ctrl-C at a question, during the copy or while the box starts, a crash (Task 21's review). "exit" handlers
// cannot wait, so removeCopySync, which can take a while (10-30 s for a copy holding node_modules on Windows), so a line
// on stderr says so first (the user's words): with the manifest's count of files, as the review counts them, or without
// one for a copy stopped before its manifest. Nothing is said for a folder that is not there. The function returned
// keeps the copy from then on, giving its manifest its final name (snapshot.ts, PENDING), so from then on `tachi review`
// lists it, and finds its box running for a live session. `proc`, `say` and `remove` are a test's.
export function dropOnExit(
  folder: string,
  proc: Pick<EventEmitter, "on" | "off"> = process,
  say: (line: string) => void = (line) => writeBestEffort(2, `${line}\n`),
  remove: (folder: string) => void = removeCopySync,
): () => void {
  const drop = () => {
    if (!existsSync(folder)) return;
    let files: number | undefined;
    try {
      const manifest = JSON.parse(readFileSync(path.join(folder, PENDING), "utf8")) as Pick<Manifest, "entries">;
      files = Object.values(manifest.entries).filter((e) => e.type === "file").length;
    } catch {
      // no manifest yet, or one that cannot be read: a copy stopped midway
    }
    say(files === undefined ? "Removing the copy..." : removing(files));
    // What cannot be removed stays, for deleting by hand, as the line says: its manifest keeps its holding name, so it is
    // never reviewed.
    try {
      remove(folder);
    } catch (err) {
      say(notRemoved(errorText(err), folder));
    }
  };
  proc.on("exit", drop);
  return () => {
    renameSync(path.join(folder, PENDING), path.join(folder, MANIFEST));
    proc.off("exit", drop);
  };
}

export async function sandboxStart(
  root: string,
  ready: Ready,
  opts: { network: Network; limits: SandboxLimits | undefined; session: string; labels?: Record<string, string> },
  io: Pick<SandboxIo, "err" | "run">,
): Promise<Started | { exit: number }> {
  const run = io.run ?? docker;
  const { copy } = ready;
  const refuse = (line: string) => (io.err(visible(line)), { exit: 1 });
  await sweepBoxes(run);
  let box: DockerExecutor;
  let room: Room;
  try {
    room = await dockerRoom(run);
    const got = boxLimits(opts.limits, room);
    if ("problem" in got) return refuse(got.problem);
    const { mounts, env } = ready;
    const { network, session } = opts;
    const labels = opts.labels ? { labels: opts.labels } : {};
    const user = boxUser(room);
    const folder = copy ? path.join(copy.folder, "work") : root; // in copy mode only the copy's work/ is mounted
    const { unlimited } = room;
    box = await DockerExecutor.start({ image: ready.tag, folder, network, limits: got.limits, unlimited, mounts, env, session, user, ...labels }, run);
  } catch (err) {
    return refuse(errorText(err));
  }
  // Choices 17 and 97: the file tools' helper needs node in the box, with path.matchesGlob (Node 22.5 or newer, Node's own
  // docs). A failed check removes the box before the launch ends.
  const asked = `node -e 'process.stdout.write(process.version + " " + typeof require("node:path").matchesGlob)'`;
  const check = await box.exec(asked, BOX_ROOT).catch((err: Error) => err);
  // The check runs as every command does, through bash and util-linux's setsid (executor.ts, inGroup), so only bash's own
  // words say node is missing; an image without bash, or with busybox's setsid, fails before node is looked for.
  const problem = (() => {
    if (check instanceof Error) return errorText(check);
    if (check.code === 127 && /\bnode: (command )?not found/.test(check.stderr)) {
      return "The sandbox's image has no node, which Tachikoma's file tools need in the box.";
    }
    if (check.code !== 0) {
      const words = check.stderr.trim() || `exit code ${check.code}`;
      return `The sandbox's image could not run Tachikoma's check in the box (${words}). The box needs bash, util-linux's setsid and Node 22.5 or newer.`;
    }
    const [version, matchesGlob] = check.stdout.split(" ");
    if (matchesGlob !== "function") return `The sandbox's image has node ${version}, but Tachikoma's file tools need Node 22.5 or newer in the box.`;
    return undefined;
  })();
  if (problem) {
    await box.stop();
    return refuse(problem);
  }
  if (copy) {
    for (const args of commitArgs(copy.branch)) {
      const made = await run(["exec", "-w", BOX_ROOT, box.id, "git", ...args]).catch((err: Error) => err);
      if (made !== "missing" && !(made instanceof Error) && made.code === 0) continue;
      await box.stop();
      const words = made === "missing" ? NO_DOCKER : made instanceof Error ? errorText(made) : made.err.trim() || `exit code ${made.code}`;
      return refuse(`The sandbox could not make the copy a git repository in the box (${words}).`);
    }
  }
  const { limits } = box;
  const tail = `network ${opts.network}, limits ${memoryText(limits.memory)}, ${limits.cpus} CPUs, ${limits.pids} processes.`;
  const line = copy
    ? `Sandbox: copy of ${root} (${files(Object.values(copy.manifest.entries).filter((e) => e.type === "file").length)}, ` +
      `${(copy.ms / 1000).toFixed(1)} s), ${tail} Your folder is not touched until you review the changes.`
    : `Sandbox: live link on ${root}, ${tail}`;
  return {
    box,
    root: BOX_ROOT,
    executor: opts.network === "off" ? networkNoted(box) : box,
    workspace: new BoxWorkspace(box.id, run, BOX_ROOT, box.state),
    system: systemPrompt(BOX_ROOT, "linux", "bash"),
    subagentSystem: subagentPrompt(BOX_ROOT),
    gate: { root: BOX_ROOT, home: BOX_HOME, shell: shellOf("box") },
    shellTool: shellToolOf("bash"),
    protection: boxProtection(root, protectionOf(ready.git)),
    lines: [
      visible(line),
      ...(copy?.manifest.leftOut.map((l) => visible(leftOut(l.path, l.why))) ?? []),
      ...room.unlimited.map(unlimitedLine),
      ...(ready.gitOutside ? ["Git does not work in the box here: .git points to a git folder outside the project. Commit on this computer."] : []),
    ],
    ...(copy ? { copy } : {}),
  };
}

// Choice 21: with the box's network off, a failed command's result gets one more line. Which failures were the network's
// cannot be told, so every failure gets it.
export function networkNoted(executor: Executor): Executor {
  const line = "(The box's network is off, so nothing in it can reach the internet. To allow it, launch with --network on.)";
  return {
    exec: async (command, cwd, signal) => {
      const r = await executor.exec(command, cwd, signal);
      return r.code === 0 ? r : { ...r, stderr: `${r.stderr}${r.stderr && !r.stderr.endsWith("\n") ? "\n" : ""}${line}` };
    },
  };
}

// The hooks folders and settings files the gate protects (Task 8), as the box sees them: the write tools look at /work
// paths there (files.ts, protectedOf; Task 14's review). Task 5 lists each as written and at its real place, so either
// may be in the project. Those outside it the box cannot reach.
export function boxProtection(root: string, protection: Protection): Protection {
  const real = realpathSync.native(root);
  const inBox = (paths: string[]) => [
    ...new Set(
      paths.flatMap((p) => {
        const base = within(real, p) ? real : within(root, p) ? root : undefined;
        return base === undefined ? [] : [path.posix.join(BOX_ROOT, ...path.relative(base, p).split(path.sep))];
      }),
    ),
  ];
  return { hooks: inBox(protection.hooks), files: inBox(protection.files) };
}

// The grey line at the start of a session (release 4 design, "Instruction files"): the files read,
// the user's folder written as ~, their total size, and any left out and why. Paths come from the disk,
// so they are escaped.
export function instructionsLine(r: Instructions, home: string): string | null {
  if (!r.read.length && !r.left.length) return null;
  const short = (p: string) => visible(p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p);
  const size = r.read.reduce((n, f) => n + f.size, 0);
  const read = r.read.length ? `${r.read.map((f) => short(f.path)).join(", ")} (${k(size)} bytes)` : "none read";
  const left = r.left.length ? `; left out: ${r.left.map((l) => `${short(l.path)} (${visible(l.why)})`).join(", ")}` : "";
  return `Instructions: ${read}${left}`;
}

const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

// The one question at the start about files the instruction files lead to outside the project.
export function approvalQuestion(reached: Reached[]): string {
  return [`Read ${files(reached.length)} from outside the project, reached by the instruction files?`, ...reached.map((r) => `  ${visible(r.path)}, ${visible(r.how)}`), "[y/n]"].join("\n");
}

// The question for a project's MCP server at the launch (release 8c plan, choice 23; "Lines this plan adds"): its command
// and arguments, or its address, as .mcp.json writes them, ${VAR} unfilled, so a key filled in never reaches the screen,
// and the answer covers just what was shown (choice 48); a local one's then names the variables its entry sets, names
// only, as a value may hold a key (choice 49). A command, argument or name that is empty or holds a space or a quote is
// shown in quotes, a quote in it as \", so where each one ends can be seen; all of it escaped.
export function serverQuestion(c: ServerConfig): string {
  const name = visible(c.name);
  const w = c.asWritten;
  if (!("command" in w)) return `Connect to the MCP server "${name}" from this project's .mcp.json at ${visible(w.url)}? [y/n]`;
  const shown = (word: string) => (word === "" || /[\s"]/.test(word) ? `"${word.replaceAll('"', '\\"')}"` : word);
  const vars = c.entry.kind === "stdio" ? Object.keys(c.entry.env) : [];
  const sets = vars.length ? ` (sets ${vars.map(shown).join(", ")})` : "";
  return `Start the MCP server "${name}" from this project's .mcp.json: ${visible([w.command, ...w.args].map(shown).join(" ") + sets)}? [y/n]`;
}

// Each project server not yet answered for its entry as written, asked about one at a time, in the order the file gives
// them, its answer kept, a no too (choices 23 and 24). `answers` is called only when a project's server needs one, as
// reading the project's answers throws on a file it cannot read (answersFor). An answer that cannot be saved still holds
// for this launch, as answersFor keeps it before writing; `failed` gets its red line, and the launch goes on (choice 50).
export async function askServers(
  configs: ServerConfig[],
  answers: () => Answers,
  ask: (question: string) => Promise<boolean>,
  failed: (line: string) => void,
): Promise<void> {
  const project = configs.filter((c) => c.where === "project");
  if (!project.length) return;
  const given = answers();
  for (const c of project) {
    if (given.get(c.name, c.written) !== undefined) continue;
    const yes = await ask(serverQuestion(c));
    try {
      given.set(c.name, c.written, yes);
    } catch (err) {
      failed(`Your answer for ${visible(c.name)} could not be saved (${visible(errorText(err), { tabs: true })}); Tachikoma asks again at the next launch.`);
    }
  }
}

// The launch's MCP lines, said once the bus has its listeners (release 8c plan, Task 9; "Lines this plan adds"): with the
// sandbox's network off, once, that every server is off; in -p, each project server without a yes in the window, one
// answered no included, which is skipped (design, "A project's servers"; Task 9's spec review).
export function mcpLines(servers: Servers, opts: { print: boolean }): string[] {
  const list = servers.list();
  if (list.some((s) => s.state.is === "off")) {
    return ["MCP servers are off: the sandbox's network is off, and servers run outside the box until a later release. Start with --network on to use them."];
  }
  if (!opts.print) return [];
  return list
    .filter((s) => s.where === "project" && (s.state.is === "waiting for your yes" || s.state.is === "you said no"))
    .map((s) => `MCP server ${visible(s.name)} from .mcp.json was skipped: -p starts only the project's servers you said yes to in the window.`);
}

// With -p nobody can approve them, so they are left out, and stderr names them.
export function headlessLeftOut(reached: Reached[]): string {
  const n = reached.length;
  return `note: ${n} instruction file${n === 1 ? "" : "s"} from outside the project left out, since nobody can approve ${n === 1 ? "it" : "them"} in -p mode: ${reached.map((r) => `${visible(r.path)}, ${visible(r.how)}`).join("; ")}`;
}

// Release 8a plan, choice 11: parseArgs cannot take an optional value, so a -r or --resume that is last, or followed by
// another option, is given an empty value, which means "show the list".
export const resumeArgs = (args: string[]): string[] =>
  args.flatMap((a, i) => ((a === "-r" || a === "--resume") && (args[i + 1] ?? "-").startsWith("-") ? [a, ""] : [a]));

const NEEDS_TERMINAL = "tachi --resume needs a terminal to list sessions; give it a session's id or name.";
// Approved by the user, 2026-11-07 (release 8a final review): a resume's line when the saved system prompt was made under
// another sandbox setting (resumed), and -r's when more than one session has the name it was given.
const SANDBOX_CHANGED = "The sandbox setting has changed since this session was saved, so the model is told this launch's shell and project folder";
const SHARED_NAME = (n: number, name: string) => `${n} sessions are named ${name}; give one's id instead (tachi --resume lists them in a terminal).`;

// Which saved session a launch opens (release 8a design, "Resuming"; plan, choices 9, 11 and 12): `-c` the newest, with
// -p the newest -p run; `-r <id or name>` that one, or the list of the sessions a name belongs to; `-r` alone the list,
// which leaves -p runs out. The list needs a terminal; without one, or with -p, an id or a name is needed.
export function chooseSession(
  dir: string,
  o: { continue?: boolean; resume?: string; print: boolean; terminal: boolean },
): { id: string } | { list: Row[]; name?: string } | { fail: string } {
  if (o.resume === "") {
    if (!o.terminal) return { fail: NEEDS_TERMINAL };
    const list = listSessions(dir, { print: false });
    return list.length ? { list } : { fail: "No saved sessions in this folder." };
  }
  if (o.resume !== undefined) {
    const found = findSession(dir, o.resume);
    // An id whose file the list leaves out, as it cannot be read, is opened, so the launch says why (release 8a design,
    // "When something goes wrong"). It is found among the folder's own names, as a file, so no path or link can lead
    // elsewhere.
    if (!found && entryOf(dir, `${o.resume}.jsonl`)?.isFile()) return { id: o.resume };
    if (!found) return { fail: `No session named or numbered ${o.resume} in this folder; tachi --resume lists them.` };
    if (!Array.isArray(found)) return { id: found.id };
    return o.terminal ? { list: found, name: o.resume } : { fail: SHARED_NAME(found.length, o.resume) };
  }
  // listSessions with `print` lists every session, so the -p runs are picked out (choice 9).
  const newest = listSessions(dir, { print: o.print }).find((r) => r.print === o.print);
  return newest ? { id: newest.id } : { fail: "No saved session to continue in this folder." };
}

// A session opened for this window: the conversation for Session.load; the grey lines to say, one that names the session
// cut to the screen's width; the lines for the model about subagents whose answers were lost, which go into its next
// request as waiting text does, with `reported` to call once they have been handed out; and its lock's release.
export interface Opened {
  conversation: Conversation;
  lines: { text: string; oneLine?: boolean }[];
  lost: string[];
  reported: () => void;
  release: () => void;
}

// A new session's transcript, its start line first, then its name, then its lock (release 8a plan, choices 4 and 8).
// The start line makes the sessions folder private, so the folder is there before the lock's file is made in it. When it
// cannot be written, the session goes on unsaved and takes no lock; Session.load says so in the "Saving fails" line.
export function newSaved(dir: string, start: Omit<Extract<Line, { t: "start" }>, "t" | "at" | "v" | "box"> & { box: boolean }, name?: string): Opened {
  const { file, pictures } = sessionPaths(dir, start.id);
  const transcript = new Transcript(file, pictures);
  transcript.write({ t: "start", v: 1, ...start });
  if (name) transcript.write({ t: "name", name });
  const lock = transcript.failed ? null : openSession(dir, start.id);
  const conversation = { id: start.id, messages: [], system: start.system, transcript, prompts: [], calls: [], nextPicture: 1, nextTask: 1, tools: start.tools };
  return { conversation, lines: [], lost: [], reported: () => {}, release: () => lock?.release() };
}

// The reason a copy is not made when its new id's lock is held. Approved by the user, 2026-11-06.
const LOCK_HELD = "its lock could not be taken";

// A saved session opened and read, before anything of the launch starts, so one that cannot be read starts nothing
// (release 8a design, "When something goes wrong"; plan, Task 6). `copied`: a copy was opened as another window holds it.
export interface Saved {
  id: string;
  transcript: Transcript;
  read: Read;
  copied: boolean;
  release: () => void;
}

// A saved session opened under its lock, or a copy of it when another window holds it or `fork` asks for one, the copy's
// lock taken too (release 8a design, "Resuming" and "Names, branches and export"; plan, choice 8). A torn last line is
// mended under the lock before anything is added ("When something goes wrong"). A session that cannot be read is
// refused in the "could not be read" line, a copy that cannot be made in the "could not be copied" one (user,
// 2026-11-06), the lock let go and a copy made for it removed. The copy's lock is taken before anything of it is
// written. A cleanup that fails leaves the leftover to the sweep and the problem as it was. `copy` is the copy's id; it
// exists for the tests, as copySession's does.
export function openSaved(dir: string, id: string, o: { fork: boolean; copy?: string }): Saved | { problem: string } {
  const source = sessionPaths(dir, id).file;
  const unread = (why: string) => ({ problem: `${source} could not be read as a session (${why}).` });
  let lock: { release: () => void } | null = null;
  try {
    privateDir(dir); // before the lock's file is made there
    if (!o.fork) lock = openSession(dir, id);
  } catch (err) {
    return unread(errorText(err));
  }
  let open = id;
  if (!lock) {
    open = o.copy ?? randomUUID();
    const copied = (why: string) => ({ problem: `${source} could not be copied (${why}).` });
    try {
      lock = openSession(dir, open);
      if (!lock) return copied(LOCK_HELD);
      copySession(dir, id, open);
    } catch (err) {
      lock?.release();
      return err instanceof Unreadable ? unread(err.message) : copied(errorText(err));
    }
  }
  const { file, pictures } = sessionPaths(dir, open);
  const transcript = new Transcript(file, pictures);
  transcript.mend();
  const read = readTranscript(file, pictures);
  if ("problem" in read) {
    lock?.release();
    if (open === id) return read;
    try {
      removeSession(dir, open);
    } catch {}
    return { problem: read.problem.replace(file, () => source) }; // the session asked for, not the copy just removed
  }
  return { id: open, transcript, read, copied: open !== id && !o.fork, release: () => lock?.release() };
}

// A saved session made this window's, once the launch's lead and tools are known (release 8a design, "Resuming"; plan,
// choice 4). It writes `-n`'s name; a `lead` line when this launch leads with another model, so the next resume opens
// with it; no `tools` line, which the session's first request writes when its tools differ from those the history was
// last saved under, so a reply is sent with its thinking only under its own tools (release 8c plan, choice 46). Once
// the lost lines have been handed to the model (`reported`), `lost` goes into
// each unfinished subagent's file, so it is reported once (user, 2026-11-06: "Report once"). A session saved under
// another sandbox setting than this launch's, `prompt.box`, has a system prompt naming another shell and project root,
// so this launch's, `prompt.full`, takes its place and is written in a `system` line, the replies keeping their
// thinking only under it (release 8a final review, user, 2026-11-07: "Rebuild it", "Save the setting"). The setting is
// compared, not the prompt, whose root is the folder as typed. A -p run opened in the window becomes a session as any
// other, in -c and the list (same: "Becomes normal").
export function resumed(
  s: Saved,
  o: { tools: ToolSpec[]; lead: string; name?: string; prompt: { box: boolean; full: string }; interactive: boolean },
): Opened {
  const { read, transcript } = s;
  if (o.name) transcript.write({ t: "name", name: o.name });
  if (o.lead !== read.lead) transcript.write({ t: "lead", lead: o.lead });
  const rebuilt = read.box !== o.prompt.box;
  if (rebuilt) transcript.write({ t: "system", system: o.prompt.full, box: o.prompt.box });
  if (o.interactive && read.print) transcript.write({ t: "interactive" });
  const system = rebuilt ? o.prompt.full : read.system;
  // Each in the subagents folder, as tasks.ts names a subagent's file, made inside the private sessions folder; an id
  // from the file is used only when it is one Tasks gives, so no line can lead the write elsewhere.
  const reported = () => {
    for (const u of read.unfinished.filter((u) => /^t\d+$/.test(u.id))) {
      const file = path.join(pathsOf(transcript.file).subagents, `${u.id}.jsonl`);
      new Transcript(file, transcript.pictures, { inherits: true }).write({ t: "ended", state: "lost" });
    }
  };
  // The history under the tools it was last saved under, which hold tool_search and the MCP tools once a request has
  // offered them: a reply made under others, or under another system prompt, goes without its thinking here, and the
  // session's first request leaves out the rest's when its own tools differ, writing its tools line then (release 8c
  // plan, Task 9; choice 46). Its line is said only when Tachikoma's own tools changed, for a reply the session would send
  // without its thinking, Anthropic's (session.ts, #kept); a changed set of MCP tools says nothing, as servers come and go.
  const { messages, dropped } = read.withTools(read.tools, system);
  const own = (tools: ToolSpec[]) => madeUnder("", tools.filter((t) => t.name !== SEARCH && !t.name.startsWith("mcp__")));
  const otherTools = own(read.tools) !== own(o.tools) && messages.some((m) => m.native?.provider === "anthropic");
  const lines = [
    ...(s.copied ? [{ text: "Opened a copy: that session is open in another window." }] : []),
    { text: `Resumed: ${o.name || read.name || read.firstPrompt?.split(/\r?\n/)[0] || s.id}.`, oneLine: true },
    ...(read.damaged ? [{ text: `${read.damaged} damaged lines of this session were skipped.` }] : []),
    // Said at the resume that changed the setting, its thinking part only when a reply had the provider's own content to
    // leave out; a later resume leaves out the same replies' thinking without a word (user, 2026-11-07: "Only at the
    // change").
    ...(rebuilt
      ? [{ text: SANDBOX_CHANGED + (dropped ? ", and its earlier replies are sent without their thinking." : ".") }]
      : otherTools
        ? [{ text: "The tools have changed since this session was saved, so its earlier replies are sent without their thinking." }]
        : []),
  ];
  return {
    conversation: {
      id: s.id,
      messages,
      system,
      transcript,
      prompts: read.prompts,
      calls: read.calls,
      nextPicture: read.nextPicture,
      nextTask: read.nextTask,
      loaded: read.loaded, // a resume's and /branch's (release 8c plan, choice 41)
      tools: read.tools, // the tools saved last, which its replies were made under (Task 6b's quality review; choice 46)
    },
    lines,
    lost: read.unfinished.map((u) => `Subagent ${u.id} (${u.description}) had not finished when the session ended; its answer was lost.`),
    reported,
    release: s.release,
  };
}

// The line when a resumed session's saved lead cannot be made, so `instead` leads (release 8a plan, choice 13): at the
// launch and at /resume's pick.
export const leadGone = (saved: string, err: unknown, instead: string) =>
  `The session's lead, ${saved}, is not set up (${errorText(err)}); ${instead} leads instead.`;

// The saved sessions a window opens (release 8a plan, Task 7): its sessions folder, what a new session's start line holds
// besides its id, lead and system prompt, the launch's system prompt for a resumed one (resumed), and the session open
// now, with its lock and the lines about its lost subagents still to hand the model. /clear, /resume and /branch open
// the next session as the launch does, and once the window has switched to it, the last one's lock is let go and its
// lost lines dropped, so they never reach the new conversation.
export class WindowSessions {
  #open: Opened | undefined;
  #lost: string[];

  constructor(
    readonly dir: string,
    readonly start: { project: string; version: string; tools: ToolSpec[] },
    readonly prompt: { box: boolean; full: string },
    open?: Opened,
  ) {
    this.#open = open;
    this.#lost = [...(open?.lost ?? [])];
  }

  // The lost lines, once, for the model's next request, as waiting text goes; their subagents are then marked reported.
  lost(): string[] {
    const now = this.#lost.splice(0);
    if (now.length) this.#open?.reported();
    return now;
  }

  // /clear's session: a new one under a fresh id, as the launch starts one.
  fresh(lead: string, system: string): Opened {
    return newSaved(this.dir, { id: randomUUID(), ...this.start, lead, print: false, system, box: this.prompt.box });
  }

  // /resume's pick, opened as the launch opens it, a copy when another window holds it. `lead` is given the session's
  // saved lead and says which leads it now: one that differs from the saved one is written into it, as the launch writes
  // it.
  resume(id: string, lead: (saved: string) => string): Opened | { problem: string } {
    const s = openSaved(this.dir, id, { fork: false });
    return "problem" in s ? s : resumed(s, { tools: this.start.tools, lead: lead(s.read.lead), prompt: this.prompt, interactive: true });
  }

  // /branch's copy of the session open now, named, its lock taken before it is written, as --fork-session's is.
  branch(id: string, lead: string, name: string): Opened | { problem: string } {
    const s = openSaved(this.dir, id, { fork: true });
    return "problem" in s ? s : resumed(s, { tools: this.start.tools, lead, name, prompt: this.prompt, interactive: true });
  }

  // The window has switched to `next`: the last session's lock is let go (release 8a plan, choice 8).
  switched(next: Opened): void {
    this.#open?.release();
    this.#open = next;
    this.#lost = [...next.lost];
  }

  // The window has closed: its session's lock is let go then, as at /clear.
  release(): void {
    this.#open?.release();
  }
}

// A shortening's system prompt (release 8a plan, choice 3): the launch's own first part, and the instruction files read
// again. A file outside the project goes in only when the launch's question allowed it; one not asked about then is left
// out without asking (user, 2026-11-06: "Re-read, reuse launch's answer"). `asked` holds the launch's answer for each
// path it asked about, or is "all" in never mode, where the launch read them without asking.
export function systemAgain(first: string, where: Where, asked: ReadonlyMap<string, boolean> | "all"): () => Promise<string> {
  return async () => {
    const again = await readInstructions(where, async (reached) => asked === "all" || reached.every((r) => asked.get(r.path) === true));
    return [first, again.text].filter(Boolean).join("\n\n");
  };
}

// The lead's session and the window's pictures, made together, so the session's loads raise the one counter the screen
// numbers pictures by: with two, a picture made after a resume could take a saved one's number, and its line would then
// point at the old picture's file (release 8a plan, choice 5).
export function leadSession(opts: Omit<SessionOptions, "pictures">): { session: Session; pictures: Pictures } {
  const pictures = new Pictures();
  return { session: new Session({ ...opts, pictures }), pictures };
}
