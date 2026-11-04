#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import os, { constants } from "node:os";
import path from "node:path";
import { parseArgs, styleText } from "node:util";
import { type Instance, render } from "ink";
import { accountCommand } from "./auth/chatgpt.js";
import {
  approvalQuestion,
  checkOffLine,
  dropOnExit,
  endOnEpipe,
  exitOn,
  exitSignals,
  fullPossible,
  gitUnread,
  givenBy,
  headlessAnswer,
  headlessDeclined,
  headlessExit,
  headlessLeftOut,
  instructionsLine,
  jsonLine,
  keptForReview,
  leadOf,
  MAX_TASKS,
  networkLine,
  prose,
  protectionOf,
  type Ready,
  resolve,
  sandboxReady,
  sandboxStart,
  screenMode,
  type Started,
} from "./clilib.js";
import { Bus } from "./core/bus.js";
import { dataDir, projectFile } from "./core/datadir.js";
import { attachErrorLog } from "./core/errorlog.js";
import { readInstructions } from "./core/instructions.js";
import { type Ask, PermissionGate, type Protection, visible } from "./core/permissions.js";
import { subagentPrompt, systemPrompt } from "./core/prompt.js";
import { Session } from "./core/session.js";
import { Stats } from "./core/stats.js";
import { Tasks } from "./core/tasks.js";
import { errorText, type Provider } from "./core/types.js";
import { LocalExecutor, LocalWorkspace } from "./exec/local.js";
import { EFFORTS } from "./providers/anthropic.js";
import { listModels } from "./providers/models.js";
import { createProvider } from "./providers/registry.js";
import { sessionGone } from "./sandbox/executor.js";
import { sandboxCommand } from "./sandbox/image.js";
import { gitSettings } from "./safety/gitconfig.js";
import { judgeOf } from "./safety/judge.js";
import { NO_RULES } from "./safety/rules.js";
import { loadSettings, SETTINGS, shownFile } from "./settings.js";
import { delegateTool } from "./tools/delegate.js";
import { SUBAGENT_TOOLS, TOOLS } from "./tools/index.js";
import { shellTool } from "./tools/shell.js";
import { todoTool } from "./tools/todo.js";
import { App } from "./tui/App.js";
import { Clipboard, runTool, systemTool } from "./tui/clipboard.js";
import { historyFile } from "./tui/history.js";
import { InputFilter } from "./tui/input.js";
import { programRunning } from "./tui/owner.js";
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
  -h, --help        show this help
  Options --lead to --scroll-speed can also be set in ${shownFile()}; a flag or variable wins.

In a session: /lead <provider:model> switches the lead model, /lead or /model picks from a list,
/login chatgpt and /logout chatgpt sign in and out, /tasks lists the subagents (/tasks t1 shows one,
/tasks stop stops them), /errors summarises the error log, /screen switches between full
screen and classic, /settings opens the settings file in your editor, /keybindings opens the
keys file in your editor, /vim switches vim mode in this window, /exit quits. Esc or Ctrl-C stops
the current turn. When idle, Ctrl-C clears the prompt, and twice on an empty prompt quits. Ctrl+T
hides or shows the to-do list. Esc and Ctrl+T can be moved in the keys file; Ctrl-C and Ctrl-D
cannot. ? on an empty prompt lists every key.`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// The question at the start, before the screen is drawn (release 4 design, "Files that lead elsewhere
// ask first"): y reads the files, any other key leaves them out, and Ctrl-C quits.
function askAtStart(question: string): Promise<boolean> {
  process.stdout.write(`${question} `);
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
  process.once("SIGINT", () => stop.abort()); // Ctrl-C while the build runs, with raw mode off
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
      help: { type: "boolean", short: "h" },
    },
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
const sessionId = randomUUID(); // the error log's, and the box's label (sandbox/executor.ts)
attachErrorLog(bus, errorFile, sessionId);
const stats = new Stats(bus);

const makeProvider = (spec: string): Provider => createProvider(spec, { effort });
// A value came from the settings file when no flag gave it, nor a variable where it has one (an empty variable is unset).
const fromFile = (flag: string | undefined, variable?: string) => flag === undefined && !variable;
// A spec the settings file gave names its entry, as one from a flag or variable names the flag (the plan's choice 8). Each
// caller escapes the whole message with visible(), as the spec may come from the file (choice 30).
const named = (entry: string, file: boolean, flag = "") => (file ? `${SETTINGS}: "${entry}": ` : flag);
let lead: Provider;
let fallback: Provider | undefined;
try {
  lead = makeProvider(leadSpec);
} catch (err) {
  fail(visible(`${named("lead", fromFile(parsed.lead, process.env.TACHI_LEAD))}${errorText(err)}`));
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

const interactive = parsed.print === undefined;
// Before the instruction files are read, so nothing is asked with no terminal to answer.
if (interactive && !process.stdin.isTTY) fail('Interactive mode needs a terminal; use -p "<prompt>" to run one prompt.');
// Git's settings files, hooks folders and git folders are read once at launch and protected for the whole session
// (release 7 plan, Task 8; choices 57 and 59). Without git, only the fixed list applies (choice 11). If git's run fails,
// only the fixed list applies, and the launch says so here and again in full screen (App.tsx).
// In live link its launch's first steps read them (clilib.ts, sandboxReady; release 7 plan, Task 16), and refuse when they
// cannot be read; in copy mode they read them too, then take the snapshot, going on without git's settings as here (Task
// 21). Ctrl-C while the image builds, with raw mode off, stops the launch.
let protection: Protection = protectionOf(undefined);
let gitLine: string | undefined;
let ready: Ready | undefined;
// Copy mode's copy is removed when the launch ends before the session starts, however it ends (clilib.ts, dropOnExit).
// From the image's steps until the box has started, Ctrl-C, with raw mode off, ends the launch through process.exit, so
// the exit handlers remove the copy and any box already started (executor.ts); at the instruction files' question, it
// is read as a key, and exits the same way (askAtStart).
const keepCopy = sandbox === "copy" ? dropOnExit(path.join(dataDir(), "copies", sessionId)) : undefined;
const quit = () => process.exit(128 + constants.signals.SIGINT);
if (sandbox !== "off") {
  const stop = new AbortController();
  const onInt = () => stop.abort();
  process.once("SIGINT", onInt);
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
}
// The user's own rules (release 7 plan, Task 4). A kind switched off is said at each launch (checkOffLine), and again in
// full screen (App.tsx).
const rules = loaded.settings.dangerousCommands ?? NO_RULES;
const offLine = checkOffLine(rules);
if (offLine) console.error(offLine);

// Read once, at the start (release 4 design, "Instruction files"). TACHI_INSTRUCTIONS_TOP moves where
// the walk down to the project starts, so tests never read the user's files.
const instructions = await readInstructions({ root, codexHome: process.env.CODEX_HOME || undefined, top: process.env.TACHI_INSTRUCTIONS_TOP || undefined }, async (reached) => {
  // As read_file reads outside the project then.
  if (mode === "never") return true;
  if (!interactive) {
    console.error(headlessLeftOut(reached));
    return false;
  }
  return askAtStart(approvalQuestion(reached));
});
// Then the box: leftover boxes removed, the box started and its node checked (sandboxStart). From here the model works in
// it, on /work (choice 19). Its launch lines are grey in the interface, and on stderr with -p.
let box: Started | undefined;
if (ready) {
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
const system = [box?.system ?? systemPrompt(root), instructions.text].filter(Boolean).join("\n\n");

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
});
gate.rules = rules;
gate.protection = box?.protection ?? protection;
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
});
// The to-do list and delegate are the lead's alone; the screen shows the list from the bus. In the box the shell tool says
// bash, whatever the host.
const tools = [
  ...TOOLS.map((t) => (box && t === shellTool ? box.shellTool : t)),
  todoTool((items) => bus.emit("todo", items)),
  delegateTool(tasks, { headless: !interactive }),
];
const session: Session = new Session({
  lead,
  fallback,
  tools,
  system,
  ctx: { root: where.root, executor, workspace, gate },
  bus,
  inbox: () => tasks.take(),
  ask: (...a) => ask(...a), // read at each call, as the gate's: the App binds its own once it starts
});

// The executor stops running commands, and the sandbox's box is removed (src/sandbox/executor.ts), from "exit" handlers,
// which dying by a signal skips. SIGQUIT is ignored while the editor has the terminal (clilib.ts, exitOn).
for (const sig of exitSignals(process.platform)) process.on(sig, exitOn(sig, programRunning));

if (parsed.print !== undefined) {
  let failed = false;
  bus.on("error", (e) => {
    // A judge that cannot be reached refuses one action, as a no does, and fails no run (release 7 plan, choice 65).
    if (e.kind !== "tool" && e.kind !== "fallback" && e.kind !== "judge") failed = true;
  });
  if (parsed.json) {
    for (const event of ["message", "usage", "error", "lead"] as const) {
      bus.on(event, (data: unknown) => console.log(jsonLine(event, data)));
    }
  } else {
    bus.on("error", (e) => {
      if (e.kind === "fallback") console.error(prose(`note: ${e.message}`));
      else if (e.kind !== "tool") console.error(prose(`${e.kind}: ${e.message}`));
    });
  }
  // On macOS and Linux the running command is in its own process group, so Ctrl-C reaches only us.
  // A second Ctrl-C gets Node's default and ends at once.
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  await session.send(parsed.print, stop.signal);
  if (!parsed.json) {
    const last = session.messages.at(-1);
    if (last?.role === "assistant") {
      const text = last.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
      const { out, note } = headlessAnswer(text, { raw: parsed.raw === true, tty: process.stdout.isTTY === true });
      console.log(out);
      if (note) console.error(note);
    }
  }
  // Nobody can review here, so the copy is kept (choice 29).
  if (box?.copy) console.error(keptForReview(sessionId));
  process.exitCode = headlessExit({ aborted: stop.signal.aborted, failed, declined });
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
  const keys = new InputFilter(process.stdin);
  // Copies go to the terminal as OSC 52, in order with the screen's own codes, and to the system's tool where it has one
  // (release 5 design, "Copying").
  const tool = systemTool(process.platform, process.env);
  let ink: Instance | undefined;
  restoreOnExit(screen, () => ink?.unmount());
  // Copy mode's review at the end (App.tsx, copy; release 7 plan, Task 21): its lines, printed once Ink has ended, and the
  // protection worked out on the host when it opens, never the gate's view of the box; without it, no review.
  const reviewed: string[] = [];
  const copied = box?.copy;
  const copy = box && copied && {
    copy: { session: sessionId, folder: copied.folder, manifest: copied.manifest },
    stop: async () => {
      await box.box.stop();
      return sessionGone(sessionId);
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
      intro={[instructionsLine(instructions, os.homedir()), ...(box?.lines ?? [])].flatMap((text) => (text === null ? [] : [{ text, color: "gray" }]))}
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
      live={{ loaded, given: givenBy(parsed, process.env), ...(netLine ? { networkLine: netLine } : {}), ...(gitLine ? { gitLine } : {}) }}
      {...(copy ? { copy } : {})}
    />,
    // The kitty keyboard protocol, where the terminal has it, tells Shift+Enter from Enter. 60 frames a second, not Ink's
    // 30: at 30 the wheel felt jumpy beside Claude Code, at 60 as smooth, in the user's terminal check (2026-10-28; drawing
    // only the lines that changed, Ink's incrementalRendering, made no difference felt).
    { stdin: keys as unknown as NodeJS.ReadStream, exitOnCtrlC: false, kittyKeyboard: { mode: "auto" }, maxFps: 60 },
  );
  const exited = ink.waitUntilExit();
  restoreWhenInkEnds(screen, exited);
  // After the terminal is back, as restoreWhenInkEnds waits on the same promise first; an error is its to report. The
  // lines come escaped (Review.tsx, ReviewEnd).
  exited.then(
    () => {
      for (const line of reviewed) console.log(line);
    },
    () => {},
  );
}
