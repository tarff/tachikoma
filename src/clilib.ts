import type { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import type { Instructions, Reached } from "./core/instructions.js";
import { MODES, type Mode, OFFERED, type Protection, visible } from "./core/permissions.js";
import { subagentPrompt, systemPrompt } from "./core/prompt.js";
import { errorText } from "./core/types.js";
import type { Executor } from "./exec/executor.js";
import { EFFORTS, type Effort } from "./providers/anthropic.js";
import { gitFolderOutside, type GitSettings, gitSettings, within } from "./safety/gitconfig.js";
import { NO_RULES, type UserRules } from "./safety/rules.js";
import { type Shell, shellOf } from "./safety/split.js";
import { BoxWorkspace } from "./sandbox/boxWorkspace.js";
import { docker } from "./sandbox/docker.js";
import { BOX_HOME, boxLimits, boxUser, DockerExecutor, dockerRoom, memoryText, NO_DOCKER, type Room, sweepBoxes, unlimitedLine } from "./sandbox/executor.js";
import { heldLine, type ImageIo, prepareImage } from "./sandbox/image.js";
import { CASE_REFUSED, ignoresCase, liveMounts, type Mount, sessionSettings } from "./sandbox/mounts.js";
import { type Manifest, removeCopySync, snapshot } from "./sandbox/snapshot.js";
import type { SandboxLimits, Settings } from "./settings.js";
import { shellToolOf } from "./tools/shell.js";
import type { Tool } from "./tools/tool.js";
import { screen } from "./tui/describe.js";
import { gitBranch } from "./tui/git.js";
import { leftOut } from "./tui/Review.js";
import { k, type Segment, SEGMENTS } from "./tui/StatusLine.js";

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
export function exitOn(sig: NodeJS.Signals, programRunning: () => boolean): () => void {
  return () => {
    if (!(programRunning() && (sig === "SIGINT" || sig === "SIGQUIT"))) process.exit(128 + constants.signals[sig]);
  };
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

// Live link's launch (release 7 plan, Task 16), in the plan's order: choice 13's refusal; Docker's state and the image
// (image.ts, prepareImage); git's settings; the mounts (mounts.ts); then cli.tsx reads the instruction files on the host;
// then sandboxStart removes leftover boxes, starts the box and checks its node (choice 17). Each refusal is printed by
// `io.err` and ends the launch with the code given. Docker is reached through `io.run` (choice 69); `gitSettings` and
// `ignoresCase` are given by tests, which run git with their own settings and take the letter-case check as passed on
// this PC's folders (choice 104). No flag or variable turns that check off.
// The box's folder for the project, where the model works (choice 19), and its home (executor.ts, choice 77).
const BOX_ROOT = "/work";

// `note`: a line said while the launch works, grey on a terminal (cli.tsx); `err` when not given.
export interface SandboxIo extends ImageIo {
  note?: (line: string) => void;
  gitSettings?: (root: string) => Promise<GitSettings | undefined>;
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
  let failed: unknown;
  try {
    git = await (io.gitSettings ?? gitSettings)(root);
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
      got = await snapshot(root, copy.session);
    } catch (err) {
      return refuse(errorText(err));
    }
    const branch = boxBranch(gitBranch(root));
    const copied = { folder: path.dirname(got.work), manifest: got.manifest, ms: performance.now() - from, ...(branch ? { branch } : {}) };
    // A Ctrl-C during the copy, which cannot be stopped midway, is read once it is done.
    if (io.signal.aborted) return { exit: 128 + constants.signals.SIGINT };
    // safe.directory, as live link's mounts give it (mounts.ts): the copy's folder is not the box's user's either.
    const env = sessionSettings({ "safe.directory": BOX_ROOT });
    return { tag: image.tag, git, mounts: [], env, gitOutside: false, copy: copied, ...(gitLine ? { gitLine } : {}) };
  }
  // Without them the mounts cannot be worked out, so live link is refused, as for Task 5's problems.
  if (failed) return refuse(`Live link is refused: git's settings could not be read (${errorText(failed)}). Launch with --sandbox copy instead.`);
  const live = liveMounts(root, git, { ignoresCase: () => false });
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
// `/`, `.` or `.lock` (git-check-ref-format's rules, within that narrower set), so it can never act as an option nor be
// refused by git. Any other name, a detached HEAD ("HEAD") or no repository gives undefined, and git's own default.
export function boxBranch(name: string | null): string | undefined {
  const plain = /^(?![-./])(?!.*(\.\.|\/\/|\/\.))[A-Za-z0-9._/-]+(?<![/.])$/;
  return name !== null && name !== "HEAD" && plain.test(name) && !name.endsWith(".lock") ? name : undefined;
}

// Until copy mode's session starts, its copy, with nothing run in it, is removed when the process ends, however it ends:
// a refusal, Ctrl-C at a question or while the box starts, a crash (Task 21's review). "exit" handlers cannot wait, so
// removeCopySync. The function returned keeps the copy from then on. `proc` is a test's.
export function dropOnExit(folder: string, proc: Pick<EventEmitter, "on" | "off"> = process): () => void {
  const drop = () => {
    try {
      removeCopySync(folder);
    } catch {
      // what cannot be removed stays, as a copy with no changes; `tachi review` can discard it
    }
  };
  proc.on("exit", drop);
  return () => void proc.off("exit", drop);
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
    box = await DockerExecutor.start({ image: ready.tag, folder, network, limits: got.limits, mounts, env, session, user, ...labels }, run);
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

// With -p nobody can approve them, so they are left out, and stderr names them.
export function headlessLeftOut(reached: Reached[]): string {
  const n = reached.length;
  return `note: ${n} instruction file${n === 1 ? "" : "s"} from outside the project left out, since nobody can approve ${n === 1 ? "it" : "them"} in -p mode: ${reached.map((r) => `${visible(r.path)}, ${visible(r.how)}`).join("; ")}`;
}
