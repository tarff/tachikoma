#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import os, { constants } from "node:os";
import path from "node:path";
import { parseArgs, styleText } from "node:util";
import { type Instance, render } from "ink";
import type { ReactElement } from "react";
import { accountCommand } from "./auth/chatgpt.js";
import { withLock } from "./auth/lock.js";
import {
  approvalQuestion,
  checkOffLine,
  chooseSession,
  dropOnExit,
  endOnEpipe,
  exitOn,
  exitSignals,
  fullPossible,
  gitBashLine,
  gitUnread,
  givenBy,
  headlessAnswer,
  headlessDeclined,
  headlessExit,
  headlessLeftOut,
  instructionsLine,
  jsonLine,
  keptForReview,
  leadGone,
  leadOf,
  leadSession,
  MAX_TASKS,
  networkLine,
  newSaved,
  openSaved,
  prose,
  protectionOf,
  type Ready,
  resolve,
  resumed,
  resumeArgs,
  type Saved,
  sandboxReady,
  sandboxStart,
  screenMode,
  type Started,
  systemAgain,
  WindowSessions,
} from "./clilib.js";
import { Bus } from "./core/bus.js";
import { dataDir, KEYBINDINGS, projectFile, settingsDir } from "./core/datadir.js";
import { attachErrorLog } from "./core/errorlog.js";
import { type Reached, readInstructions } from "./core/instructions.js";
import { type Ask, PermissionGate, type Protection, visible } from "./core/permissions.js";
import { subagentPrompt, systemPrompt } from "./core/prompt.js";
import { type Row, sessionsDir, sweep } from "./core/sessions.js";
import { Stats } from "./core/stats.js";
import { Tasks } from "./core/tasks.js";
import { errorText, type Provider } from "./core/types.js";
import { LocalExecutor, LocalWorkspace } from "./exec/local.js";
import { Hooks } from "./hooks/hooks.js";
import { pathsFor } from "./hooks/tools.js";
import { readKeybindings } from "./keybindings.js";
import { EFFORTS } from "./providers/anthropic.js";
import { listModels } from "./providers/models.js";
import { createProvider } from "./providers/registry.js";
import { boxCheck, dropIfNothing, reviewCommand } from "./sandbox/copies.js";
import { sandboxCommand } from "./sandbox/image.js";
import { ignoresCase } from "./sandbox/mounts.js";
import { copyLock } from "./sandbox/snapshot.js";
import { gitSettings } from "./safety/gitconfig.js";
import { judgeOf } from "./safety/judge.js";
import { NO_RULES } from "./safety/rules.js";
import { hooksOf, loadSettings, SETTINGS, shownFile } from "./settings.js";
import { delegateTool } from "./tools/delegate.js";
import { SUBAGENT_TOOLS, TOOLS } from "./tools/index.js";
import { shellTool } from "./tools/shell.js";
import { todoTool } from "./tools/todo.js";
import { App } from "./tui/App.js";
import { NOT_GONE } from "./tui/app/constants.js";
import { Bindings, DEFAULTS, tableOf } from "./tui/bindings.js";
import { Clipboard, runTool, systemTool } from "./tui/clipboard.js";
import { conversationLines } from "./tui/describe.js";
import { historyFile } from "./tui/history.js";
import { InputFilter } from "./tui/input.js";
import { programRunning } from "./tui/owner.js";
import { Review, type ReviewCopy, type ReviewEnd } from "./tui/Review.js";
import { SessionList } from "./tui/SessionList.js";
import { SEGMENTS } from "./tui/StatusLine.js";
import { restoreOnExit, restoreWhenInkEnds, Screen, writeBestEffort } from "./tui/terminal.js";

const HELP = `tachi: a coding agent for your terminal

Usage:
  tachi [--lead <provider:model>] [options]          interactive session
  tachi [--lead <provider:model>] -p "<prompt>"      run one prompt, print the answer, exit
  tachi login chatgpt [--new | --account <number>]   sign in to use your ChatGPT plan;
                      [--keychain]                   --keychain seals the tokens with a key in the keychain
  tachi logout chatgpt                               sign out of ChatGPT
  tachi sandbox build                                build the sandbox's image, after asking
  tachi review [<name> [--discard]]                  list the copies kept for review, open one, or discard one

Options:
  --lead <spec>     anthropic:<model> | chatgpt:<model> | openai:<model> | openrouter:<model>
                    | kimi:<model> | ollama:<model> (or set TACHI_LEAD)
                    chatgpt: uses your ChatGPT plan; openai: uses OPENAI_API_KEY
  --mode <mode>     when to ask before acting (default: ask):
                    ask: before each write and shell command, and before anything outside the project
                    project: before shell commands and anything outside the project
                    auto: reads and edits in the project run, the judge model decides the rest,
                          and dangerous commands ask you
                    never: never ask; only with --sandbox copy, where you review changes at the end
  --sandbox <how>   off | live | copy (default: off): commands run in Docker on this folder or a copy
  --network <net>   off | on (default: off): whether commands in the sandbox can reach the internet
  --judge <spec>    the model that judges in auto mode; the lead's model unless set
  --effort <level>  Anthropic models only: ${EFFORTS.join(" | ")}
  --fallback <spec> retry a turn the lead refuses on this model, e.g. openai:<model> (off unless set)
  --worker <spec>   the model subagents run on (or set TACHI_WORKER); the lead's model unless set
  --max-tasks <n>   how many subagents run at once (default: ${MAX_TASKS})
  --status <list>   status line parts, comma-separated: ${SEGMENTS.join(",")}
  --classic         use the terminal's own scrollback, not the full screen (or set TACHI_CLASSIC=1)
  --scroll-speed <n>  lines a wheel notch scrolls in full screen, above 0 and up to 20
                      (default: 3; or set TACHI_SCROLL_SPEED)
  -p, --print <prompt>  run without the interface
  --json            with -p, print every event as one JSON line
  --raw             with -p, print the answer exactly as written, control codes and all
  -c, --continue    reopen the newest session saved in this folder (with -p, the newest -p run)
  -r, --resume [<id or name>]  reopen a saved session by its id or name, or pick one from a list
  -n, --name <name>  name this session, to reopen it with --resume <name>
  --fork-session    with -c or -r, open a copy of the session and leave the saved one as it was
  -h, --help        show this help
  Options --lead to --scroll-speed can also be set in ${shownFile()}; a flag or variable wins.

In a session: /lead <provider:model> switches the lead model, /lead or /model picks from a list,
/login chatgpt and /logout chatgpt sign in and out, /clear starts a new session in this window,
/resume switches the window to a saved one, /branch [name] carries on in a copy of this session,
/rename <name> names it, /export [file] writes the conversation to a file as text, or alone copies
it, /compact [words] shortens it into a summary now, /autocompact <tokens> shortens it once it
passes that many tokens (/autocompact off: only when a request would not fit), /tasks lists the
subagents (/tasks t1 shows one, /tasks stop stops them), /hooks lists the hooks in force,
/errors summarises the error log, /screen switches between full screen and classic,
/settings opens the settings file in your editor, /keybindings opens the keys file in your editor,
/vim switches vim mode in this window, /exit quits.
Esc or Ctrl-C stops the current turn. When idle, Ctrl-C clears the prompt, and twice on an empty
prompt quits. Ctrl+T hides or shows the to-do list. Esc and Ctrl+T can be moved in the keys file;
Ctrl-C and Ctrl-D cannot. ? on an empty prompt lists every key.`;

// Sessions are kept 30 days unless the settings file says otherwise: Claude Code's sessions page, "Change the 30-day
// retention" (release 8a plan, "Numbers in this plan").
const KEEP_DAYS = 30;
// Tachikoma's version, for a session's start line (release 8a plan, choice 4): package.json is one folder up from both
// src/ and dist/.
const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const NO_TERMINAL = 'Interactive mode needs a terminal; use -p "<prompt>" to run one prompt.';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// The question at the start, before the screen is drawn (release 4 design, "Files that lead elsewhere
// ask first"): y reads the files, any other key leaves them out, and Ctrl-C quits. Ink unrefs stdin when a screen drawn
// before this one ends (`tachi -r`'s list), and Node would then exit instead of waiting for the key, so it is ref'd again.
function askAtStart(question: string): Promise<boolean> {
  process.stdout.write(`${question} `);
  process.stdin.ref();
  process.stdin.setRawMode(true);
  return new Promise((resolve) => {
    process.stdin.once("data", (data) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      const key = String(data);
      if (key === "\u0003") process.exit(128 + constants.signals.SIGINT);
      const yes = key.toLowerCase() === "y";
      process.stdout.write(`${yes ? "y" : "n"}\n`);
      resolve(yes);
    });
  });
}

// A screen drawn alone before the session (`tachi review <name>`'s review, `tachi -r`'s list): in full screen where it can
// draw, with the keys file's bindings as it reads at this moment (its problems said first, on the normal screen); the
// mouse stays off, as nothing reads its reports. `draw` is given the bindings and the screen's close. Resolves once Ink
// has ended and the terminal is back, so the lines printed after it come after.
async function drawAlone(draw: (bindings: Bindings, close: () => void) => ReactElement): Promise<void> {
  const screen = new Screen((s) => process.stdout.write(s), (s) => writeBestEffort(1, s));
  let ink: Instance | undefined;
  restoreOnExit(screen, () => ink?.unmount());
  const bindings = keysNow();
  if (fullPossible(process.env, process.stdout.isTTY === true)) screen.setSecond(true);
  ink = render(draw(bindings, () => ink?.unmount()), { exitOnCtrlC: false });
  const exited = ink.waitUntilExit();
  restoreWhenInkEnds(screen, exited);
  await exited;
}

async function drawReview(copy: ReviewCopy, protection: Protection): Promise<ReviewEnd> {
  let end: ReviewEnd | undefined;
  await drawAlone((bindings, close) => (
    <Review
      copy={copy}
      bindings={bindings}
      protection={protection}
      onEnd={(e) => {
        end = e;
        close();
      }}
    />
  ));
  return end!;
}

// The session picked from the list (release 8a plan, choice 12), or none when it was closed.
async function drawSessions(rows: Row[], name: string | undefined): Promise<string | undefined> {
  let picked: string | undefined;
  await drawAlone((bindings, close) => (
    <SessionList
      rows={rows}
      {...(name === undefined ? {} : { name })}
      now={Date.now()}
      bindings={bindings}
      onPick={(id) => {
        picked = id;
        close();
      }}
      onClose={close}
    />
  ));
  return picked;
}

// The keys file laid over the defaults, as a session's start reads it (settingsWatch.ts); a file that cannot be read is
// none, and one with a problem keeps the defaults, as a session keeps the keys before it.
function keysNow(): Bindings {
  let text: string;
  try {
    text = readFileSync(path.join(settingsDir(), KEYBINDINGS), "utf8");
  } catch {
    return new Bindings(tableOf(DEFAULTS));
  }
  const got = readKeybindings(text);
  if ("problem" in got) {
    console.error(visible(got.problem));
    return new Bindings(tableOf(DEFAULTS));
  }
  for (const problem of got.problems) console.error(visible(problem));
  return got.table;
}

process.stdout.on("error", endOnEpipe);
process.stderr.on("error", endOnEpipe); // `tachi -p … 2>&1 | head -1`

// `tachi login chatgpt` and `tachi logout chatgpt` do only that, then exit.
const verb = process.argv[2];
if (verb === "login" || verb === "logout") {
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort()); // Ctrl-C while the browser part waits
  try {
    await accountCommand(verb, process.argv.slice(3), (line) => console.log(prose(line)), stop.signal);
    process.exit(stop.signal.aborted ? 128 + constants.signals.SIGINT : 0); // Ctrl-C can end the wait for OpenAI to cancel the sign-in, after signing out here
  } catch (err) {
    console.error(prose(errorText(err)));
    process.exit(stop.signal.aborted ? 128 + constants.signals.SIGINT : 1);
  }
}

// `tachi sandbox build` builds the sandbox's image after asking, or says it is up to date, then exits (release 7 plan,
// Task 11). The question needs a terminal; with none, nothing is built.
if (verb === "sandbox") {
  const stop = new AbortController();
  // Ctrl-C while the build runs, with raw mode off. `on`, not `once`: a second Ctrl-C while the build is being stopped
  // (2-4 s on Windows, docker.ts) must not get Node's default exit, which would end Tachikoma before the stop finished.
  process.on("SIGINT", () => stop.abort());
  try {
    const code = await sandboxCommand(process.argv.slice(3), process.cwd(), {
      ...(process.stdin.isTTY ? { ask: askAtStart } : {}),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
      signal: stop.signal,
    });
    process.exit(stop.signal.aborted ? 128 + constants.signals.SIGINT : code);
  } catch (err) {
    console.error(prose(errorText(err)));
    process.exit(stop.signal.aborted ? 128 + constants.signals.SIGINT : 1);
  }
}

// `tachi review` lists the copies copy mode kept for review, opens one in full screen, or discards one after asking, then
// exits (release 7 plan, Task 21; choice 28). Opening and discarding need a terminal; with none, nothing is done. Ctrl-C
// while Docker is asked or another review is waited for, with raw mode off, ends it through process.exit, so the lock's
// exit handler runs; in the review it is a key, and a discard's removal goes on through it (copies.ts, uninterrupted).
// The signals that end a session end it the same way, the terminal put back.
if (verb === "review") {
  process.on("SIGINT", () => process.exit(128 + constants.signals.SIGINT));
  for (const sig of exitSignals(process.platform)) process.on(sig, exitOn(sig, programRunning));
  try {
    const code = await reviewCommand(process.argv.slice(3), {
      ...(process.stdin.isTTY ? { ask: askAtStart, open: drawReview } : {}),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    });
    process.exit(code);
  } catch (err) {
    console.error(prose(errorText(err)));
    process.exit(1);
  }
}

let parsed;
try {
  parsed = parseArgs({
    options: {
      lead: { type: "string" },
      mode: { type: "string" },
      sandbox: { type: "string" },
      network: { type: "string" },
      judge: { type: "string" },
      effort: { type: "string" },
      fallback: { type: "string" },
      worker: { type: "string" },
      "max-tasks": { type: "string" },
      status: { type: "string" },
      classic: { type: "boolean" },
      "scroll-speed": { type: "string" },
      print: { type: "string", short: "p" },
      json: { type: "boolean" },
      raw: { type: "boolean" },
      continue: { type: "boolean", short: "c" },
      resume: { type: "string", short: "r" },
      name: { type: "string", short: "n" },
      "fork-session": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    args: resumeArgs(process.argv.slice(2)), // -r alone (release 8a plan, choice 11)
  }).values;
} catch (err) {
  fail(`${errorText(err)}\n\n${HELP}`);
}
if (parsed.help) {
  console.log(HELP);
  process.exit(0);
}

// Release 6 design, "The settings file": a broken file stops the launch as a bad flag does; its warnings come first. Then
// release 5's order: no lead, a blank -p, --raw, then the flags. What the file holds is escaped, so a value such as an
// OSC 52 cannot act on the terminal (release 6 plan, choice 30).
const loaded = loadSettings();
if ("problem" in loaded) fail(visible(loaded.problem));
for (const warning of loaded.warnings) console.error(visible(warning));
const leadSpec = leadOf(parsed, process.env, loaded.settings);
if (!leadSpec) fail(`No lead model given. Pass --lead, set TACHI_LEAD, or put "lead": "<provider:model>" in ${shownFile()}.\n\n${HELP}`);
if (parsed.print !== undefined && !parsed.print.trim()) fail("-p needs a prompt"); // a blank one would still be a paid request
if (parsed.raw && (parsed.print === undefined || parsed.json)) fail("--raw works only with -p, and not with --json, which is already exact");
// Approved by the user, 2026-11-07 (release 8a final review).
if (parsed["fork-session"] && !parsed.continue && parsed.resume === undefined) fail("--fork-session works only with -c or -r");
if (parsed.raw) console.error("warning: --raw prints the answer exactly as the model wrote it; control codes in it can act on a terminal that shows it");
let options;
try {
  options = resolve(parsed, process.env, loaded.settings);
} catch (err) {
  fail(errorText(err));
}
const { mode, effort, maxTasks, segments, speed, sandbox } = options;
// Checked once the options are resolved, so the flag and the file are caught alike, each named as its source.
// `never` only with copy mode, where nothing written reaches the folder before the user has reviewed it; live link is not
// enough (release 7 design, "Launching").
if (mode === "never" && sandbox !== "copy") {
  const source = parsed.mode === undefined ? `${SETTINGS}: "mode": ` : "--mode ";
  fail(`${source}never needs --sandbox copy, so nothing reaches your folder before you have reviewed it; launch with --sandbox copy --mode never.`);
}
const netLine = networkLine(parsed, sandbox);
if (netLine) console.error(netLine);

const root = process.cwd();
const errorFile = projectFile("errors", root);
const bus = new Bus();
// A new session's id, the box's label (sandbox/executor.ts) and its copy's name: a resumed session keeps its own id, and
// its box starts afresh (release 8a design, "Resuming").
const sessionId = randomUUID();
const stats = new Stats(bus);
const interactive = parsed.print === undefined;
const gray = (line: string) => styleText("gray", visible(line), { stream: process.stderr });
// Said once, when a hook run by a shell is in force and there is no Git Bash (release 8b plan, choice 2).
const bashLine = gitBashLine(loaded.settings);
if (bashLine) console.error(gray(bashLine));

// Once per launch, after the settings and before the lead (release 8a plan, choice 10), and before any session is opened
// here: a lock this process holds would look like an earlier process's, left behind, to a sweep that names it by another
// path. The sweep and the sessions folder take their paths from one data folder string.
const data = dataDir();
for (const line of sweep(data, loaded.settings.cleanupPeriodDays ?? KEEP_DAYS, new Date())) console.error(gray(line));
const sessions = sessionsDir(root, data);
let chosen: string | undefined;
if (parsed.continue || parsed.resume !== undefined) {
  const terminal = interactive && process.stdin.isTTY === true;
  const c = chooseSession(sessions, { continue: parsed.continue, resume: parsed.resume, print: !interactive, terminal });
  if ("fail" in c) fail(visible(c.fail));
  if (interactive && !terminal) fail(NO_TERMINAL); // before a held session is copied for a window that cannot start
  chosen = "id" in c ? c.id : await drawSessions(c.list, c.name);
  if (chosen === undefined) process.exit(0); // the list closed: nothing to open
}
// Opened, mended and read before anything starts, the instruction files' question and the sandbox among them, so a
// session that cannot be read starts nothing (release 8a design, "When something goes wrong"). Its lock is let go at
// /clear, /resume and /branch and when the window closes (release 8a plan, choice 8), and at the process's exit at the
// latest, however it exits (lock.ts).
let saved: Saved | undefined;
if (chosen !== undefined) {
  const got = openSaved(sessions, chosen, { fork: parsed["fork-session"] === true });
  if ("problem" in got) fail(visible(got.problem));
  saved = got;
}

const makeProvider = (spec: string): Provider => createProvider(spec, { effort });
// A value came from the settings file when no flag gave it, nor a variable where it has one (an empty variable is unset).
const fromFile = (flag: string | undefined, variable?: string) => flag === undefined && !variable;
// A spec the settings file gave names its entry, as one from a flag or variable names the flag (the plan's choice 8). Each
// caller escapes the whole message with visible(), as the spec may come from the file (choice 30).
const named = (entry: string, file: boolean, flag = "") => (file ? `${SETTINGS}: "${entry}": ` : flag);
const launchLead = (): Provider => {
  try {
    return makeProvider(leadSpec);
  } catch (err) {
    fail(visible(`${named("lead", fromFile(parsed.lead, process.env.TACHI_LEAD))}${errorText(err)}`));
  }
};
// A resumed session's lead is the one it last used, unless --lead is given; one that is no longer set up gives way to
// the launch's own, with a line (release 8a design, "Resuming"; plan, choice 13).
const savedLead = parsed.lead === undefined ? saved?.read.lead : undefined;
let leadLine: string | undefined;
let lead: Provider;
let fallback: Provider | undefined;
try {
  lead = savedLead !== undefined && savedLead !== leadSpec ? makeProvider(savedLead) : launchLead();
} catch (err) {
  leadLine = leadGone(savedLead!, err, leadSpec); // only the saved lead's failure comes here: launchLead's ends the launch
  lead = launchLead();
}
try {
  if (options.fallback) fallback = makeProvider(options.fallback);
} catch (err) {
  fail(visible(`${named("fallback", fromFile(parsed.fallback), "--fallback: ")}${errorText(err)}`)); // otherwise it reads like a bad lead
}
// Without --worker, a subagent uses the model leading when it starts.
let worker: Provider | undefined;
try {
  if (options.worker) worker = makeProvider(options.worker);
} catch (err) {
  fail(visible(`${named("worker", fromFile(parsed.worker, process.env.TACHI_WORKER), "--worker: ")}${errorText(err)}`));
}
// The judge for auto mode is made now, so a bad one stops the launch as a bad --worker does (release 7 plan, Task 7), and
// the gate gets it (Task 10). Unset (an empty --judge turns the file's off), the lead leading at each action judges
// (judgeOf), as a subagent gets the lead leading when it starts.
let judgeProvider: Provider | undefined;
try {
  if (options.judge) judgeProvider = makeProvider(options.judge);
} catch (err) {
  fail(visible(`${named("judge", fromFile(parsed.judge), "--judge: ")}${errorText(err)}`));
}

// Before the instruction files are read, so nothing is asked with no terminal to answer.
if (interactive && !process.stdin.isTTY) fail(NO_TERMINAL);
// Git's settings files, hooks folders and git folders are read once at launch and protected for the whole session
// (release 7 plan, Task 8; choices 57 and 59). Without git, only the fixed list applies (choice 11). If git's run fails,
// only the fixed list applies, and the launch says so here and again in full screen (App.tsx).
// In live link its launch's first steps read them (clilib.ts, sandboxReady; release 7 plan, Task 16), and refuse when they
// cannot be read; in copy mode they read them too, then take the snapshot, going on without git's settings as here (Task
// 21). Ctrl-C while the image builds, with raw mode off, stops the launch.
let protection: Protection = protectionOf(undefined);
let gitLine: string | undefined;
let ready: Ready | undefined;
// The executor stops running commands, and the sandbox's box is removed (src/sandbox/executor.ts), from "exit" handlers,
// which dying by a signal skips. SIGQUIT is ignored while the editor has the terminal (clilib.ts, exitOn). Set before the
// sandbox's launch, so a SIGTERM or SIGHUP during it, the copy among them, runs them too (Task 21's quality review).
for (const sig of exitSignals(process.platform)) process.on(sig, exitOn(sig, programRunning));
// Copy mode's copy is removed when the launch ends before the session starts, however it ends (clilib.ts, dropOnExit).
// From the image's steps until the box has started, Ctrl-C, with raw mode off, ends the launch through process.exit, so
// the exit handlers remove the copy and any box already started (executor.ts); at the instruction files' question, it
// is read as a key, and exits the same way (askAtStart).
const keepCopy = sandbox === "copy" ? dropOnExit(path.join(dataDir(), "copies", sessionId)) : undefined;
const quit = () => process.exit(128 + constants.signals.SIGINT);
if (sandbox !== "off") {
  const stop = new AbortController();
  // `on`, not `once`: a second Ctrl-C during a long step, the copy among them, must not get Node's default exit, which
  // skips the exit handlers and would leave a half-made copy.
  const onInt = () => stop.abort();
  process.on("SIGINT", onInt);
  const io = {
    ...(interactive ? { ask: askAtStart } : {}),
    out: (line: string) => console.log(line),
    err: (line: string) => console.error(line),
    note: (line: string) => console.error(styleText("gray", line, { stream: process.stderr })),
    signal: stop.signal,
  };
  const got = await sandboxReady(root, io, sandbox === "copy" ? { session: sessionId } : undefined);
  process.off("SIGINT", onInt);
  if ("exit" in got) process.exit(got.exit);
  ready = got;
  gitLine = got.gitLine;
  process.on("SIGINT", quit);
} else {
  try {
    protection = protectionOf(await gitSettings(root));
  } catch (err) {
    gitLine = gitUnread(err);
    console.error(gitLine);
  }
  // A folder that ignores letter case where the system does not, such as WSL's /mnt/c, has protected paths ignore it too.
  // Windows and macOS fold case anyway. A folder the probe cannot read counts as ignoring case, so more is protected.
  if (process.platform !== "win32" && process.platform !== "darwin") {
    try {
      protection.ignoresCase = ignoresCase(root);
    } catch {
      protection.ignoresCase = true;
    }
  }
}
// The user's own rules (release 7 plan, Task 4). A kind switched off is said at each launch (checkOffLine), and again in
// full screen (App.tsx).
const rules = loaded.settings.dangerousCommands ?? NO_RULES;
const offLine = checkOffLine(rules);
if (offLine) console.error(offLine);

// Read once, at the start (release 4 design, "Instruction files"). TACHI_INSTRUCTIONS_TOP moves where
// the walk down to the project starts, so tests never read the user's files. Each answer about a file outside the project
// is kept, for a shortening's prompt to give again (systemAgain).
const instructionsAt = { root, codexHome: process.env.CODEX_HOME || undefined, top: process.env.TACHI_INSTRUCTIONS_TOP || undefined };
const asked = new Map<string, boolean>();
const answer = async (reached: Reached[]): Promise<boolean> => {
  // As read_file reads outside the project then.
  if (mode === "never") return true;
  if (!interactive) {
    console.error(headlessLeftOut(reached));
    return false;
  }
  return askAtStart(approvalQuestion(reached));
};
const instructions = await readInstructions(instructionsAt, async (reached) => {
  const yes = await answer(reached);
  for (const r of reached) asked.set(r.path, yes);
  return yes;
});
// Then the box: leftover boxes removed, the box started and its node checked (sandboxStart). From here the model works in
// it, on /work (choice 19). Its launch lines are grey in the interface, and on stderr with -p.
let box: Started | undefined;
if (ready) {
  console.error(styleText("gray", "Starting the sandbox...", { stream: process.stderr })); // the user's words: the start takes seconds
  const started = await sandboxStart(root, ready, { network: options.network, limits: loaded.settings.sandboxLimits, session: sessionId }, {
    err: (line) => console.error(line),
  });
  process.off("SIGINT", quit);
  if ("exit" in started) process.exit(started.exit);
  box = started;
  keepCopy?.(); // the session starts: from here the copy is kept, for the review or `tachi review`
  if (!interactive) for (const line of box.lines) console.error(line);
}
const where = box ?? { root, executor: new LocalExecutor(), workspace: new LocalWorkspace(root) };
const first = box?.system ?? systemPrompt(root);
const system = [first, instructions.text].filter(Boolean).join("\n\n");

let declined = false;
let ask: Ask = async (summary, _detail, owner, _plain, warnings) => {
  declined = true;
  console.error(headlessDeclined(summary, owner?.name, warnings));
  return false;
};
// The judge reads the session's prompts and calls at each action, and the instruction files' text as read above (Task 10).
const gate = new PermissionGate(mode, (...a) => ask(...a), interactive ? undefined : "Not allowed in -p mode, where nobody can approve it", {
  ...(box?.gate ?? { root }),
  headless: !interactive,
  judge: judgeOf(judgeProvider, () => session, instructions.text, bus),
  // In -p a call a PreToolUse hook refused fails the run, as a refusal the ask reports does (the user's choice, 2026-11-09).
  ...(interactive ? {} : { hookRefused: () => void (declined = true) }),
});
gate.rules = rules;
gate.protection = box?.protection ?? protection;
// The user's hooks, one object for the window, handed to the lead's session and, through Tasks, each subagent's (release
// 8b plan, "Architecture"; Task 6). They run in the project's real folder, and are sent its real paths, or the box's in
// copy mode (design, "Tool hooks"). Its left-out rows, for /hooks, are the launch warnings' words (Task 1; settings.ts,
// hooksOf).
const hooks = new Hooks(
  hooksOf(loaded.settings, loaded.warnings),
  {
    sessionId: () => session.id,
    transcript: () => session.transcript?.file,
    root,
    mode: () => gate.mode,
    effort: () => session.lead.effort, // the lead's in force, so a live change is sent; only Anthropic's has one
    lead: () => session.lead.id,
  },
  bus,
);
const paths = pathsFor(root, box ? { mode: sandbox === "copy" ? "copy" : "live" } : null);
// ctx.root and the workspace's root are one place: /work in the box (Task 14's review).
const { executor, workspace } = where;
const tasks = new Tasks({
  bus,
  max: maxTasks,
  worker: () => worker ?? session.lead,
  ...(fallback ? { fallback } : {}),
  system: [box?.subagentSystem ?? subagentPrompt(root), instructions.text].filter(Boolean).join("\n\n"), // the same instructions as the lead
  tools: SUBAGENT_TOOLS,
  ctx: { root: where.root, executor, workspace, gate },
  transcript: () => session.transcript, // each subagent saves beside the lead (release 8a plan, Task 5)
  hooks,
  paths,
});
// The to-do list and delegate are the lead's alone; the screen shows the list from the bus. In the box the shell tool says
// bash, whatever the host.
const tools = [
  ...TOOLS.map((t) => (box && t === shellTool ? box.shellTool : t)),
  todoTool((items) => bus.emit("todo", items)),
  delegateTool(tasks, { headless: !interactive }),
];
// The session's transcript (release 8a plan, Task 6): a new one's start line, with -p marked so, or the saved session
// opened above, or its copy. Its lines are said before the conversation is loaded, and the error log's rows carry its id.
const specs = tools.map((t) => t.spec);
const name = parsed.name?.trim() || undefined;
const opened = saved
  ? resumed(saved, { tools: specs, lead: lead.id, ...(name ? { name } : {}), prompt: { box: box !== undefined, full: system }, interactive })
  : newSaved(
      sessions,
      { id: sessionId, project: root, lead: lead.id, version: VERSION, print: !interactive, system, box: box !== undefined, tools: specs },
      name,
    );
const said = [...opened.lines, ...(leadLine ? [{ text: leadLine }] : [])].map((l) => ({ ...l, text: visible(l.text) }));
// The subagents a crash cut short reach the model with its next request, as waiting answers do (release 8a design,
// "Resuming"), and are marked reported once handed out: the window's session's, which /clear, /resume and /branch switch
// (release 8a plan, Task 7).
const windowSessions = new WindowSessions(sessions, { project: root, version: VERSION, tools: specs }, { box: box !== undefined, full: system }, opened);
const { session, pictures } = leadSession({
  lead,
  fallback,
  tools,
  system,
  systemNow: systemAgain(first, instructionsAt, mode === "never" ? "all" : asked), // a shortening's and /clear's prompt (release 8a plan, choice 3)
  ctx: { root: where.root, executor, workspace, gate },
  bus,
  inbox: () => [...windowSessions.lost(), ...tasks.take()],
  ask: (...a) => ask(...a), // read at each call, as the gate's: the App binds its own once it starts
  tasks,
  hooks,
  paths,
});
// SessionStart's source, by how the launch opened the conversation (release 8b plan, Task 10): a copy opened as another
// window holds the session is still a resume, as -c or -r asked for one.
const source = saved ? (parsed["fork-session"] ? "fork" : "resume") : "startup";
// The settings file's /autocompact size, for -p too; a live edit or /autocompact changes it for the window (release 8a
// plan, choice 26).
session.autoCompact = loaded.settings.autoCompactWindow ?? null;
// The open session's id at each error, so after a switch its rows carry the new one's (release 8a plan, Task 7).
attachErrorLog(bus, errorFile, () => session.id);

if (parsed.print !== undefined) {
  let failed = false;
  bus.on("error", (e) => {
    // A judge that cannot be reached refuses one action, as a no does, and fails no run (release 7 plan, choice 65); nor
    // does a transcript that cannot be saved (release 8a plan, Task 5), nor a shortening's line after which the request was
    // sent as it is (Task 13): a later line that ends the turn has no mark, and still fails it. Nor does a hook that failed
    // (release 8b design, "What the user sees").
    if (e.kind !== "tool" && e.kind !== "fallback" && e.kind !== "judge" && e.kind !== "saving" && e.kind !== "hook" && !(e.kind === "shortening" && e.sent)) {
      failed = true;
    }
  });
  if (parsed.json) {
    // A hook's grey lines too, each a line of its own (release 8b plan, Task 8; the user's choice, 2026-11-09).
    for (const event of ["message", "usage", "error", "lead", "hook-note"] as const) {
      bus.on(event, (data: unknown) => console.log(jsonLine(event, data)));
    }
  } else {
    bus.on("error", (e) => {
      if (e.kind === "fallback") console.error(prose(`note: ${e.message}`));
      else if (e.kind === "saving" || e.kind === "shortening") console.error(prose(e.message)); // the line alone, as the window shows it
      // A hook's line is escaped whole, as the window escapes it (App.tsx): it carries the hook's own words and its command.
      else if (e.kind === "hook") console.error(`hook: ${visible(e.message, { tabs: true })}`);
      else if (e.kind !== "tool") console.error(prose(`${e.kind}: ${e.message}`));
    });
    // A hook's grey lines, as a fallback's note is written (release 8b plan, choice 23), escaped whole, so a line break in
    // the hook's own words cannot pass for a line of Tachikoma's (Task 6's review).
    bus.on("hook-note", (line) => console.error(`note: ${visible(line, { tabs: true })}`));
  }
  // Loaded once the error listeners are on, so a start line or mend that failed is said now, not at the first write.
  for (const line of said) console.error(gray(line.text));
  session.load(opened.conversation);
  session.start(source);
  // On macOS and Linux the running command is in its own process group, so Ctrl-C reaches only us.
  // A second Ctrl-C gets Node's default and ends at once.
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  // A prompt a UserPromptSubmit hook blocked, and a hook's continue: false, end the run with exit code 1, as its work was
  // cut short (release 8b plan, Task 8 and choice 9). A blocked prompt, or one a stop left unsent, leaves the history as it
  // was, so a resumed session's last answer is not printed as this run's; a stop later in the turn prints the answer it
  // came after, as a Stop hook's does (Task 9).
  const ended = await session.send(parsed.print, stop.signal);
  // Read now: a Ctrl-C during SessionEnd or copy mode's step below comes after the run's work, so it does not mark the run
  // stopped (Task 10's code review).
  const aborted = stop.signal.aborted;
  if (!parsed.json && !(ended && ("blocked" in ended || ended.unsent))) {
    const last = session.messages.at(-1);
    if (last?.role === "assistant") {
      const text = last.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
      const { out, note } = headlessAnswer(text, { raw: parsed.raw === true, tty: process.stdout.isTTY === true });
      console.log(out);
      if (note) console.error(note);
    }
  }
  // The run's session ends here, after its answer, however its turn ended, a stop by Ctrl-C too (release 8b plan, Task 10).
  await session.end("other");
  // Nobody can review here, so the copy is kept (choice 29), unless it has nothing to review: then, as at the session's
  // end in the interface (queue.ts, leave), once the box is gone and under the copy's lock, it is removed (choice 121).
  if (box?.copy) {
    const { folder, manifest } = box.copy;
    let line: string | undefined;
    try {
      await box.box.stop();
      if ((await boxCheck(manifest)) === "free") {
        const read = await withLock(copyLock(folder), () => dropIfNothing({ session: sessionId, folder, manifest }, (l) => console.error(l)));
        if (typeof read === "string") line = read;
      } else console.error(NOT_GONE); // as leave() says it
    } catch (err) {
      console.error(visible(errorText(err)));
    }
    console.error(line ?? keptForReview(sessionId));
  }
  process.exitCode = headlessExit({ aborted, failed: failed || ended !== undefined, declined });
} else {
  // Ctrl-C reaches the interface as a key, as raw mode is on, so a SIGINT here came from outside (`kill -INT`), or from
  // Ctrl-C typed while the editor has the terminal, with raw mode off: that one is ignored, as Git ignores it, and the
  // turn goes on (clilib.ts, exitOn; release 6 plan, choice 31).
  process.on("SIGINT", exitOn("SIGINT", programRunning));
  // After the instruction files' question, which stays on the normal screen, and before Ink's first frame, which goes to
  // the second (release 5 design, "The two modes"). restoreOnExit is set up in every mode, as /screen can enter full
  // screen later. tests/tui/terminal.test.tsx ("restoreOnExit") copies this order from here to restoreWhenInkEnds: keep
  // the two in step.
  const screen = new Screen((s) => process.stdout.write(s), (s) => writeBestEffort(1, s));
  // Ink reads the keys through the filter, which takes the mouse reports out for the App (release 5 design, "The mouse").
  // In Windows Terminal, which sets WT_SESSION, it turns win32 input mode on and off with raw mode, and reads its records,
  // so Shift+Enter comes apart from Enter (release 7 plan, Task 22; input.ts, RECORD); elsewhere nothing more is written.
  const wt = Boolean(process.env.WT_SESSION) && process.stdin.isTTY && process.stdout.isTTY;
  const keys = new InputFilter(process.stdin, undefined, wt ? (on) => screen.setWin32(on) : undefined);
  // Copies go to the terminal as OSC 52, in order with the screen's own codes, and to the system's tool where it has one
  // (release 5 design, "Copying").
  const tool = systemTool(process.platform, process.env);
  let ink: Instance | undefined;
  restoreOnExit(screen, () => ink?.unmount());
  // Copy mode's review at the end (App.tsx, copy; release 7 plan, Task 21): its lines, printed once Ink has ended, and the
  // protection worked out on the host when it opens, never the gate's view of the box; without it, no review.
  const reviewed: string[] = [];
  // SessionEnd's lines as the user left in full screen or copy mode, escaped, printed to stderr after the review's
  // (queue.ts, leave; approved by the user, 2026-11-09).
  const left: string[] = [];
  const copied = box?.copy;
  const copy = box && copied && {
    copy: { session: sessionId, folder: copied.folder, manifest: copied.manifest },
    // The check `tachi review` makes (copies.ts): the session is this process, so its box is removed, never refused.
    stop: async () => {
      await box.box.stop();
      return (await boxCheck(copied.manifest)) === "free";
    },
    protection: async () => protectionOf(await gitSettings(copied.manifest.root)), // throws: no review (App.tsx)
    ended: (lines: string[]) => reviewed.push(...lines),
  };
  if (screenMode(parsed.classic, process.env, process.stdout.isTTY === true, loaded.settings.screen) === "full") screen.enter();
  ink = render(
    <App
      session={session}
      tasks={tasks}
      bus={bus}
      stats={stats}
      mode={mode}
      onMode={(m) => {
        gate.mode = m;
      }}
      onRules={(r) => {
        gate.rules = r;
      }}
      project={path.basename(root) || root}
      root={root}
      workspace={workspace}
      // Before the first frame, which shows it. In the box a read that fails (Docker unreachable) is no branch, so it cannot
      // end the launch; the tools say what failed when used (Task 14's review).
      branch={await workspace.branch().catch(() => null)}
      historyFile={historyFile(root)}
      // A resumed conversation is drawn as a live one is, above the lines saying how it was resumed (release 8a plan,
      // Task 6).
      intro={[
        ...[instructionsLine(instructions, os.homedir()), ...(box?.lines ?? [])].flatMap((text) => (text === null ? [] : [{ text, color: "gray" as const }])),
        ...conversationLines(opened.conversation.messages),
        ...said.map((l) => ({ ...l, color: "gray" as const })),
      ]}
      pictures={pictures}
      errorFile={errorFile}
      segments={segments}
      makeProvider={makeProvider}
      login={accountCommand}
      listModels={(signal, warn) => listModels(signal, process.env, warn)}
      bindAsk={(fn) => {
        ask = fn;
      }}
      screen={screen}
      fullPossible={fullPossible(process.env, process.stdout.isTTY === true)}
      mouse={keys}
      input={keys}
      scrollSpeed={speed}
      clipboard={(report) => new Clipboard((s) => screen.write(s), tool && runTool(tool), report)}
      home={os.homedir()}
      live={{
        loaded,
        given: givenBy(parsed, process.env),
        ...(netLine ? { networkLine: netLine } : {}),
        ...(bashLine ? { bashLine } : {}),
        ...(gitLine ? { gitLine } : {}),
      }}
      {...(copy ? { copy } : {})}
      saved={windowSessions}
      leftLines={(lines) => left.push(...lines)}
      hooks={hooks}
    />,
    // The kitty keyboard protocol, where the terminal has it, tells Shift+Enter from Enter. 60 frames a second, not Ink's
    // 30: at 30 the wheel felt jumpy beside Claude Code, at 60 as smooth, in the user's terminal check (2026-10-28; drawing
    // only the lines that changed, Ink's incrementalRendering, made no difference felt).
    { stdin: keys as unknown as NodeJS.ReadStream, exitOnCtrlC: false, kittyKeyboard: { mode: "auto" }, maxFps: 60 },
  );
  // Ink's first render, in its legacy mode, runs the App's effects before render() returns (measured 2026-11-06), so its
  // listeners are on: a start line or mend that failed is said on screen now, not at the first write. So are SessionStart's
  // lines (release 8b plan, Task 10).
  session.load(opened.conversation);
  session.start(source);
  const exited = ink.waitUntilExit();
  restoreWhenInkEnds(screen, exited);
  // After the terminal is back, as restoreWhenInkEnds waits on the same promise first; an error is its to report. The
  // lines come escaped (Review.tsx, ReviewEnd).
  exited.then(
    () => {
      for (const line of reviewed) console.log(line);
      for (const line of left) console.error(line);
    },
    () => {},
  );
}
