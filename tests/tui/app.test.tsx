import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type Instance, render as renderInk } from "ink";
import { render } from "ink-testing-library";
import chalk from "chalk";
import { Completions } from "openai/resources/chat/completions";
import { type BetaMessage, Messages } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { Models } from "@anthropic-ai/sdk/resources/models";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { privateDir } from "../../src/auth/private.js";
import { askServers, type Given, newSaved, WindowSessions } from "../../src/clilib.js";
import { type Answers, answersFor, launchAnswers } from "../../src/mcp/answers.js";
import { AuthStore } from "../../src/mcp/auth.js";
import { mergeServers, type ServerConfig } from "../../src/mcp/config.js";
import { Servers } from "../../src/mcp/servers.js";
import { approveOf, mcpTools } from "../../src/mcp/tools.js";
import { type Ask, type Mode, type Owner, PermissionGate } from "../../src/core/permissions.js";
import { system32 } from "../../src/exec/env.js";
import type { Executor } from "../../src/exec/executor.js";
import { LocalWorkspace } from "../../src/exec/local.js";
import type { Workspace } from "../../src/exec/workspace.js";
import { Session, type SessionOptions } from "../../src/core/session.js";
import { projectFile } from "../../src/core/datadir.js";
import { attachErrorLog } from "../../src/core/errorlog.js";
import { exportText } from "../../src/core/exportText.js";
import { characters } from "../../src/core/fit.js";
import { listSessions, openSession } from "../../src/core/sessions.js";
import { INSTRUCTIONS } from "../../src/core/shorten.js";
import { Stats } from "../../src/core/stats.js";
import { sessionPaths, Transcript } from "../../src/core/transcript.js";
import type { CompletionRequest, Message, Provider, Turn } from "../../src/core/types.js";
import type { TodoItem } from "../../src/tools/todo.js";
import { Tasks } from "../../src/core/tasks.js";
import { delegateTool } from "../../src/tools/delegate.js";
import { SUBAGENT_TOOLS, TOOLS } from "../../src/tools/index.js";
import type { Event as HookEvent, Hook, HooksConfig } from "../../src/hooks/config.js";
import { Hooks } from "../../src/hooks/hooks.js";
import { History } from "../../src/tui/history.js";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import type { ModelGroup } from "../../src/providers/models.js";
import { OpenAIProvider } from "../../src/providers/openai.js";
import { judgeOf } from "../../src/safety/judge.js";
import { dangers, NO_RULES } from "../../src/safety/rules.js";
import type { Manifest } from "../../src/sandbox/snapshot.js";
import { readSettings, type Settings, settingsDir, shownFile } from "../../src/settings.js";
import { App, type AppProps } from "../../src/tui/App.js";
import { Bindings, type Context, DEFAULTS, tableOf } from "../../src/tui/bindings.js";
import { Clipboard, type Reader, readImage } from "../../src/tui/clipboard.js";
import { conversationLines } from "../../src/tui/describe.js";
import { mcpRow } from "../../src/tui/McpList.js";
import { Pictures, type Read } from "../../src/tui/pictures.js";
import type { Mouse } from "../../src/tui/input.js";
import { type Segment, SEGMENTS } from "../../src/tui/StatusLine.js";
import { FIRST_SCREEN, MOUSE_OFF, MOUSE_ON, PASTE_OFF, PASTE_ON, SECOND_SCREEN, Screen } from "../../src/tui/terminal.js";
import { wrap } from "../../src/tui/view.js";
import { Bus, FakeProvider, Held, callTool, fakeWorkspace, removeTree, reply, standInEditor, tempContext, texts, usage } from "../helpers.js";
import { type FakeOptions, fakeServer, httpFake, readLog, signInFake } from "../mcp/fake.js";

const tick = () => new Promise((r) => setTimeout(r, 50));
// How long a test waits for the settings watcher: fs.watch reported each of 400 writes within 5 ms on this machine
// (measured 2026-10-28); 2 s is as long as until() waits (40 ticks of 50 ms), room for a busy machine.
const WATCHED = { timeout: 2_000 };

// How many times each file has been read, so a test can tell the settings watcher has read a file it wrote (readsOf,
// below); otherwise node:fs's own. It counts every reader, so a test reads `where` itself only outside a readsOf wait.
const reads = vi.hoisted(() => new Map<string, number>());
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const readFileSync = ((file: unknown, ...rest: unknown[]) => {
    if (typeof file === "string") reads.set(file, (reads.get(file) ?? 0) + 1);
    return (fs.readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFileSync;
  return { ...fs, readFileSync };
});

// Wait until the screen shows `text`; the session runs real file I/O in the background.
async function until(app: ReturnType<typeof render>, text: string) {
  for (let i = 0; i < 40 && !app.lastFrame()?.includes(text); i++) await tick();
  expect(app.lastFrame()).toContain(text);
}

// Wait until `check` holds.
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 40 && !check(); i++) await tick();
  expect(check()).toBe(true);
}

// Wait until the screen no longer shows `text`.
async function gone(app: ReturnType<typeof render>, text: string) {
  for (let i = 0; i < 40 && app.lastFrame()?.includes(text); i++) await tick();
  expect(app.lastFrame()).not.toContain(text);
}

// No test opens a real editor (release 6 plan, Task 12): Ctrl+G, Ctrl+X Ctrl+E, /settings and /keybindings run VISUAL,
// which a test that opens one sets to a stand-in (helpers.ts, standInEditor), and which names no program elsewhere.
// The variables go back only once the App is unmounted, so none it still runs reads the user's own.
beforeEach(() => {
  vi.stubEnv("VISUAL", "tachi-test-no-editor");
  vi.stubEnv("EDITOR", "");
});
const mounted: ReturnType<typeof render>[] = [];
afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  vi.unstubAllEnvs();
});

type Login = AppProps["login"];

// Each test's history is a file in one folder of this file's own, inside a fresh temp folder: the
// history makes its folder private, which takes about 1.5 s for a new folder on Windows (measured
// 2026-10-25), once a process.
const histories = path.join(mkdtempSync(path.join(tmpdir(), "tachi-")), "history");
mkdirSync(histories);
beforeAll(() => privateDir(histories)); // so the first test does not wait for it
let nextHistory = 0;
// The home folder whose settings and keys files /settings and /keybindings open, shared by the tests that do not look
// at them.
const sharedHome = mkdtempSync(path.join(tmpdir(), "tachi-home-"));
// The window's sessions for an App rendered without mount(), which saves none: nothing is written unless /clear, /resume
// or /branch runs, into one folder of this file's own, two levels inside a fresh temp folder, removed at the end.
const unsavedTop = mkdtempSync(path.join(tmpdir(), "tachi-app-data-"));
afterAll(() => removeTree(unsavedTop));
const unsaved = () => new WindowSessions(path.join(unsavedTop, "data", "sessions"), { project: "", version: "test", tools: [] }, { box: false, full: "" });

async function mount(
  turns: ConstructorParameters<typeof FakeProvider>[1],
  opts: {
    lead?: Provider;
    errorFile?: string;
    login?: Login;
    models?: ModelGroup[];
    note?: string;
    slow?: boolean;
    listing?: Promise<void>; // what the model lists' read waits on before it answers; nothing when not given
    made?: string[];
    segments?: Segment[];
    branches?: string[];
    historyFile?: string;
    past?: string[]; // the project's prompts from earlier sessions
    newLead?: Provider; // what /lead and the picker make
    rows?: number; // the terminal's height
    intro?: AppProps["intro"]; // the start line
    worker?: Provider; // the subagents' model
    mode?: Mode; // the mode the session starts in
    full?: boolean; // full screen; classic when not given
    fullPossible?: boolean; // whether full screen can draw, for /screen; true when not given
    scrollSpeed?: number; // rows a wheel notch scrolls; 3 when not given, the session's default
    leadFails?: string; // what /lead and the picker throw, in place of making a lead
    run?: ((text: string) => Promise<void>) | null; // the clipboard's stand-in tool; null for none, as on Linux over SSH
    written?: (s: string) => void; // called with each of the screen's writes, as it is made
    bindings?: Bindings; // the table of keys; the default table when not given
    home?: string; // the folder holding the settings file; sharedHome when not given
    live?: AppProps["live"]; // the settings file as launch read it, which the App then watches; not watched when not given
    pictures?: Pictures; // the session's pictures, whose reads the test ends
    readPicture?: AppProps["readPicture"]; // Alt+V's read; one that never answers when not given, null for no reader
    judge?: Provider; // auto mode's judge, given to the gate as cli.tsx gives it (release 7 plan, Task 10)
    executor?: Executor; // what the tools run through; a real one in a temp folder when not given
    workspace?: Workspace; // the project's files, for the tools and the App; the temp folder's, with `branches`, when not given
    copy?: AppProps["copy"]; // copy mode's copy, and what leave() does with it (release 7 plan, Task 21)
    sessions?: string; // the sessions folder, as sessionsDir gives it; a fresh one for this mount when not given
    save?: boolean; // the session saves there from the start, as cli.tsx starts one (App's sessions); unsaved otherwise
    // The user's hooks, as cli.tsx hands them to the session, the subagents and the App, or the whole of what the launch
    // read, with left-out rows and `off` for /hooks; none when not given (release 8b plan, Tasks 8 and 12).
    hooks?: Hook[] | HooksConfig;
    leftLines?: AppProps["leftLines"]; // takes SessionEnd's lines at the window's exit, in full screen or copy mode (Task 10)
    servers?: SessionOptions["servers"]; // the MCP servers the first prompt waits for (release 8c plan, Task 9); none when not given
    // Real MCP servers made on the mount's bus, as cli.tsx hands them to the session and the App, started once the App
    // listens and stopped at the test's end, with the project's from .mcp.json for live edits (Task 10); none when not given.
    mcp?: (bus: Bus) => { servers: Servers; project?: ServerConfig[] };
  } = {},
) {
  // Two levels inside a temp folder of the mount's own, so no mount saves into the user's data folder, and a case can
  // give an earlier mount's to find what it saved (release 8a plan, Task 2). Only a mount with `save` writes a
  // transcript there from the start; any other has none until /clear, /resume or /branch opens one.
  const sessions = opts.sessions ?? path.join(mkdtempSync(path.join(tmpdir(), "tachi-app-data-")), "data", "sessions");
  const bus = new Bus();
  const stats = new Stats(bus);
  const ctx = await tempContext();
  if (opts.executor) ctx.executor = opts.executor;
  ctx.workspace = opts.workspace ?? Object.assign(new LocalWorkspace(ctx.root), { branch: async () => opts.branches?.shift() ?? null });
  let ask: Ask = async () => false;
  const lead = opts.lead ?? new FakeProvider("a", turns);
  const judge = judgeOf(opts.judge, () => session, "", bus); // as cli.tsx gives it: unset, the lead leading judges
  const gate = new PermissionGate(opts.mode ?? "ask", (...a) => ask(...a), undefined, { root: ctx.root, judge });
  gate.rules = opts.live?.loaded.settings.dangerousCommands ?? NO_RULES; // as cli.tsx sets it at launch
  const config = Array.isArray(opts.hooks) ? { hooks: opts.hooks, off: false, leftOut: [] } : opts.hooks;
  const hooks =
    config &&
    new Hooks(
      config,
      {
        sessionId: () => session.id,
        transcript: () => session.transcript?.file,
        root: ctx.root,
        mode: () => gate.mode,
        effort: () => undefined,
        lead: () => session.lead.id,
      },
      bus,
    );
  const tasks = new Tasks({
    bus,
    max: 8,
    worker: () => opts.worker ?? new FakeProvider("w", []),
    system: "sub",
    tools: SUBAGENT_TOOLS,
    ctx: { ...ctx, gate },
    transcript: () => session.transcript, // as cli.tsx gives it
    ...(hooks ? { hooks } : {}),
  });
  // As cli.tsx makes them: one Pictures for the session and the App (leadSession), the window's sessions, and the inbox,
  // the lost subagents' lines first.
  const pictures = opts.pictures ?? new Pictures();
  const tools = [...TOOLS, delegateTool(tasks, { headless: false })];
  const start = { project: ctx.root, version: "test", tools: tools.map((t) => t.spec) };
  const opened = opts.save ? newSaved(sessions, { id: randomUUID(), ...start, lead: lead.id, print: false, system: "t", box: false }) : undefined;
  const windowSessions = new WindowSessions(sessions, start, { box: false, full: "t" }, opened);
  const mcp = opts.mcp && { project: [], ...opts.mcp(bus) };
  if (mcp) onTestFinished(() => mcp.servers.stopAll());
  if (mcp && hooks) mcp.servers.forms.useHooks(hooks); // as cli.tsx gives the servers' forms the hooks (release 8c plan, Task 12)
  const session = new Session({
    lead,
    tools,
    system: "t",
    systemNow: async () => "t, read again", // the instruction files read again (release 8a plan, choice 3)
    ctx: { ...ctx, gate },
    bus,
    pictures,
    tasks,
    inbox: () => [...windowSessions.lost(), ...tasks.take()],
    ask: (...a) => ask(...a), // as cli.tsx gives it
    ...(hooks ? { hooks } : {}),
    ...(opts.servers ? { servers: opts.servers } : {}),
    ...(mcp ? { servers: mcp.servers, mcp: mcpTools(mcp.servers, bus, approveOf(mcp.servers)) } : {}),
  });
  const historyFile = opts.historyFile ?? path.join(histories, `${nextHistory++}.jsonl`);
  if (opts.past) writeFileSync(historyFile, opts.past.map((p) => `${JSON.stringify(p)}\n`).join(""));
  const screen = new Screen(
    (s) => opts.written?.(s),
    () => {},
  );
  if (opts.full) screen.enter();
  const mouse = new EventEmitter(); // stands in for the InputFilter, which hands the App the terminal's mouse reports
  // What each copy's OSC 52 carries, decoded. The tool is a stand-in, so no test touches the user's clipboard.
  const copies: string[] = [];
  const write = (s: string) => copies.push(Buffer.from(s.slice(7, -1), "base64").toString("utf8")); // 7: ESC ] 52 ; c ;
  const run = opts.run === undefined ? async () => {} : opts.run;
  const app = render(
    <App
      session={session}
      tasks={tasks}
      bus={bus}
      stats={stats}
      mode={opts.mode ?? "ask"}
      onMode={(m) => {
        gate.mode = m;
      }}
      onRules={(r) => {
        gate.rules = r;
      }}
      project="proj"
      root={ctx.root}
      workspace={ctx.workspace}
      branch={opts.branches?.shift() ?? null}
      historyFile={historyFile}
      intro={opts.intro ?? []}
      errorFile={opts.errorFile ?? path.join(ctx.root, "errors.jsonl")}
      segments={opts.segments ?? SEGMENTS}
      makeProvider={(spec) => {
        opts.made?.push(spec);
        if (opts.leadFails) throw new Error(opts.leadFails);
        return opts.newLead ?? new FakeProvider("b", []);
      }}
      login={opts.login ?? (async () => {})}
      listModels={async (signal, warn) => {
        if (opts.note) warn(opts.note);
        if (opts.slow) await new Promise((resolve) => signal.addEventListener("abort", resolve)); // until Ctrl-C
        await opts.listing;
        return opts.models ?? [];
      }}
      bindAsk={(fn) => {
        ask = fn;
      }}
      screen={screen}
      fullPossible={opts.fullPossible ?? true}
      mouse={mouse}
      scrollSpeed={opts.scrollSpeed ?? 3}
      clipboard={(report) => new Clipboard(write, run, report)}
      bindings={opts.bindings}
      home={opts.home ?? sharedHome}
      live={opts.live}
      pictures={pictures}
      saved={windowSessions}
      // No test reads the user's clipboard: unless a test gives its own reader, Alt+V's read never answers, and the
      // test ends it through the session's Pictures.
      readPicture={opts.readPicture === undefined ? () => new Promise(() => {}) : opts.readPicture}
      copy={opts.copy}
      leftLines={opts.leftLines}
      hooks={hooks}
      {...(mcp ? { mcp } : {})}
    />,
  );
  mounted.push(app);
  mcp?.servers.startAll(); // once the App listens, as cli.tsx starts them
  // ink-testing-library's terminal has no height; 24 rows is Ink's own default size (getWindowSize).
  Object.assign(app.stdout, { rows: opts.rows ?? 24 });
  app.stdout.emit("resize");
  if (opened) session.load(opened.conversation); // once the App listens, as cli.tsx loads it
  await tick();
  return { app, session, ctx, bus, tasks, historyFile, sessions, mouse, copies, gate, pictures, hooks, mcp, ask: (...a: Parameters<Ask>) => ask(...a) };
}

async function type(app: ReturnType<typeof render>, text: string) {
  app.stdin.write(text);
  await tick();
  app.stdin.write("\r");
  await tick();
}

// A lead whose request never finishes until it is cancelled.
const hanging = (): Provider => ({
  id: "fake:hang",
  complete: ({ signal }) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))),
});

// What a model or provider might send to rewrite the clipboard (OSC 52), hide text, overwrite a line
// or reverse it.
const OSC52 = "\u001b]52;c;Y3VybA==\u0007";
const OSC52_SHOWN = "\\u001b]52;c;Y3VybA==\\u0007";

function expectNoRawControls(frame: string | undefined) {
  for (const c of ["\u001b", "\u0007", "\r", "\u202e", "\u009b"]) expect(frame).not.toContain(c);
}

describe("App", () => {
  it("shows the git branch, read again after each turn, since the model may switch it", async () => {
    const { app } = await mount([reply("ok")], { segments: ["project"], branches: ["main", "side"] });
    expect(app.lastFrame()).toContain("proj git:(main)");
    await type(app, "switch");
    await until(app, "proj git:(side)");
  });

  // Release 7 plan, Task 14: the branch after a turn comes from the Workspace, here a fake one, never the disk.
  it("reads the branch after a turn through the Workspace", async () => {
    const { workspace, calls } = fakeWorkspace(path.resolve("/made/up/project"));
    const { app } = await mount([reply("ok")], { segments: ["project"], workspace });
    expect(app.lastFrame()).not.toContain("git:(");
    await type(app, "switch");
    await until(app, "proj git:(made-up-branch)");
    expect(calls).toEqual(["branch"]);
  });

  it("shows the project folder, and counts the session's length once a minute", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const { app } = await mount([], { segments: ["project", "time"] });
      expect(app.lastFrame()).toContain("proj | ⏱ <1m");
      vi.advanceTimersByTime(60_000);
      await tick();
      expect(app.lastFrame()).toContain("proj | ⏱ 1m");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the start line, grey, first", async () => {
    const { app } = await mount([], { intro: [{ text: "Instructions: CLAUDE.md (12 bytes)", color: "gray" }] });
    expect(app.lastFrame()).toMatch(/^Instructions: CLAUDE.md \(12 bytes\)\n/);
  });

  // Release 8a plan, Task 6 (user, 2026-11-06: "Show it"): a resumed conversation is drawn as a live one, above the lines
  // saying how it was resumed, as cli.tsx gives them.
  it("draws a resumed conversation's prompts, replies and tool rows above the resume lines", async () => {
    const history: Message[] = [
      { role: "user", parts: [{ type: "text", text: "read the notes" }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "read_file", input: { path: "notes.txt" } }] },
      { role: "user", parts: [{ type: "tool_result", callId: "c1", output: "the notes", isError: false }] },
      { role: "assistant", parts: [{ type: "text", text: "They say hello." }] },
    ];
    const { app } = await mount([], { intro: [...conversationLines(history), { text: "Resumed: read the notes.", color: "gray" }] });
    const frame = app.lastFrame()!;
    expect(frame).toMatch(/^> read the notes\n● read_file notes\.txt\n {2}⎿ ok\nThey say hello\.\nResumed: read the notes\.\n/);
  });

  it("sends what the user types and shows the reply", async () => {
    const { app } = await mount([reply("hello there")]);
    await type(app, "hi");
    expect(app.lastFrame()).toContain("> hi");
    await until(app, "hello there");
    expect(app.lastFrame()).toContain("lead fake:a");
  });

  it("asks before a write and goes ahead on y", async () => {
    const { app, ctx } = await mount([callTool("c1", "write_file", { path: "a.txt", content: "x" }), reply("written")]);
    await type(app, "make a file");
    await until(app, `Allow write ${path.join(ctx.root, "a.txt")}? [y/n]`);
    app.stdin.write("y");
    await until(app, "written");
  });

  it("on Ctrl-C at an approval prompt, says no, stops the turn and gives the input line back", async () => {
    const { app, ctx } = await mount([callTool("c1", "write_file", { path: "a.txt", content: "x" }), reply("written")]);
    await type(app, "make a file");
    const target = path.join(ctx.root, "a.txt");
    await until(app, `Allow write ${target}? [y/n]`);
    app.stdin.write("\u0003");
    await until(app, `write ${target}: You cancelled this.`);
    await gone(app, "Esc to stop");
    expect(app.lastFrame()).toContain("  ⎿ You cancelled this."); // its result row, short, after the preview (release 7 plan, choice 67)
    expect(app.lastFrame()).not.toContain("[y/n]");
    expect(app.lastFrame()).not.toContain("written");
    expect(existsSync(target)).toBe(false);
  });

  it("says no at once, without a prompt, when asked after the turn was cancelled", async () => {
    const { app, ask } = await mount([], { lead: hanging() });
    await type(app, "hi");
    await until(app, "Esc to stop");
    app.stdin.write("\u0003");
    await gone(app, "Esc to stop");
    const answer = await Promise.race([ask("write x"), tick().then(() => "still waiting")]);
    expect(answer).toBe(false);
    expect(app.lastFrame()).not.toContain("[y/n]");
  });

  it("counts only the first of two answers typed together", async () => {
    const { app, ctx } = await mount([callTool("c1", "write_file", { path: "a.txt", content: "x" }), reply("written")]);
    await type(app, "make a file");
    const target = path.join(ctx.root, "a.txt");
    await until(app, `Allow write ${target}? [y/n]`);
    // Two key events before the screen redraws; one chunk "yn" would arrive as a single input.
    app.stdin.write("y");
    app.stdin.write("n");
    await until(app, "written");
    expect(app.lastFrame()).toContain(`write ${target}: You allowed this.`);
    expect(app.lastFrame()).not.toContain("declined");
  });

  it("switches the lead with /lead", async () => {
    const { app, session } = await mount([]);
    await type(app, "/lead fake:b");
    await waitFor(() => session.lead.id === "fake:b");
    expect(app.lastFrame()).toContain("lead is now fake:b");
  });

  // Release 8a plan, Task 12: a conversation that will not fit the new lead's smaller window is shortened first, with the
  // lead leading now; a summary that fails keeps that lead, with the approved line.
  it("shortens before /lead switches to a smaller window, and refuses the switch when the summary fails", async () => {
    let window = 0;
    const turns: ((req: CompletionRequest) => Turn)[] = [
      // One token a character, so the ratio is 1; the new lead's window then holds the tools and a summary, not the prompt.
      (req) => {
        window = characters(req.system, [], req.tools) + 1000;
        return { ...reply("noted"), usage: { ...usage, input: characters(req.system, req.messages, req.tools) } };
      },
      () => ({ ...reply(""), cutOff: { kind: "refusal", detail: "declined" } }),
      () => reply("The user sent many x."),
    ];
    const lead: Provider = { id: "fake:a", complete: async (req) => turns.shift()!(req) };
    const newLead: Provider = { id: "fake:b", complete: async () => reply("hi"), contextWindow: async () => window };
    const { app, session } = await mount([], { lead, newLead, save: true });
    await session.send("x".repeat(2000));
    const flat = () => app.lastFrame()!.replaceAll(/ *\n */g, " "); // a long line wraps
    await type(app, "/lead fake:b");
    await waitFor(() => flat().includes("fake:b was not made the lead: the conversation does not fit its window and could not be shortened (declined)."));
    expect([session.lead.id, session.messages.length]).toEqual(["fake:a", 2]);
    await type(app, "/lead fake:b");
    await until(app, "lead is now fake:b");
    expect(session.messages.map(texts)).toEqual([["This conversation was shortened. A summary of everything before this point:\n\nThe user sent many x."]]);
  });

  // Task 12's review: a stopped /lead says nothing, as a stopped turn does, and keeps the lead.
  it("keeps the lead, saying nothing, when Ctrl-C stops /lead's summary, and goes on after", async () => {
    let window = 0;
    let summarising = false;
    const turns: ((req: CompletionRequest) => Promise<Turn>)[] = [
      async (req) => {
        window = characters(req.system, [], req.tools) + 1000; // as above: the prompt does not fit, the summary would
        return { ...reply("noted"), usage: { ...usage, input: characters(req.system, req.messages, req.tools) } };
      },
      (req) =>
        new Promise((_, reject) => {
          summarising = true;
          req.signal?.addEventListener("abort", () => reject(new Error("Request was aborted.")), { once: true });
        }),
      async () => reply("still fake:a"),
    ];
    const lead: Provider = { id: "fake:a", complete: (req) => turns.shift()!(req) };
    const newLead: Provider = { id: "fake:b", complete: async () => reply("hi"), contextWindow: async () => window };
    const { app, session } = await mount([], { lead, newLead, save: true });
    await session.send("x".repeat(2000));
    await type(app, "/lead fake:b");
    await waitFor(() => summarising);
    app.stdin.write("\u0003"); // Ctrl-C
    await tick();
    await type(app, "and now");
    await until(app, "still fake:a");
    expect(session.lead.id).toBe("fake:a");
    expect(app.lastFrame()).not.toContain("was not made the lead");
    expect(app.lastFrame()).not.toContain("could not be shortened");
    expect(session.messages).toHaveLength(4);
  });

  // Release 6 plan, choice 34 (the user: "can we have lead list the models?"): /lead alone opens the model list, as
  // /model does; /lead with a model is unchanged (above).
  it("opens the model list on /lead alone, as /model does, and does not send it to the model", async () => {
    const made: string[] = [];
    const { app, session } = await mount([], { made, models: [{ provider: "fake", models: ["a", "b"] }] });
    await type(app, "/lead");
    await until(app, "● fake:a");
    await tick(); // the picker starts reading keys just after it first appears
    app.stdin.write("\u001b[B"); // down
    await tick();
    app.stdin.write("\r");
    await until(app, "lead is now fake:b");
    expect(made).toEqual(["fake:b"]);
    expect(session.messages).toEqual([]);
  });

  it("refuses an unknown command instead of sending it to the model", async () => {
    const { app, session } = await mount([]);
    await type(app, "/eror");
    expect(app.lastFrame()).toContain("Unknown command: /eror");
    expect(app.lastFrame()).toContain("/errors");
    expect(app.lastFrame()).toContain("/login chatgpt");
    expect(session.messages).toEqual([]);
  });

  it("refuses words after a command that takes none, instead of sending them to the model", async () => {
    const { app, session } = await mount([]);
    await type(app, "/exit now");
    await until(app, "/exit takes nothing after it.");
    await type(app, "/Errors please");
    await until(app, "/errors takes nothing after it.");
    expect(session.messages).toEqual([]);
  });

  it("signs in and out with /login and /logout, showing what they say, and never sends them to the model", async () => {
    const calls: string[] = [];
    const login: Login = async (verb, words, say, _signal, prefix) => {
      calls.push([prefix + verb, ...words].join(" "));
      say(`${verb} done ${calls.length}`);
    };
    const lead = new FakeProvider("a", []);
    const { app } = await mount([], { lead, login });
    await type(app, "/login chatgpt --new");
    await until(app, "login done 1");
    await type(app, "/logout chatgpt");
    await until(app, "logout done 2");
    // With the `/` menu closed, the command as typed: shown how to use it, not called an unknown command.
    await press(app, "/login", "\u001b", "\r");
    await until(app, "login done 3");
    await type(app, "/login"); // with the menu open, Enter runs what it has chosen
    await until(app, "login done 4");
    expect(calls).toEqual(["/login chatgpt --new", "/logout chatgpt", "/login", "/login chatgpt"]);
    expect(lead.seen).toEqual([]);
  });

  it("takes commands in any case, and sends a message as typed", async () => {
    const calls: string[] = [];
    const login: Login = async (verb, words, say) => {
      calls.push([verb, ...words].join(" "));
      say("signed in");
    };
    const lead = new FakeProvider("a", [reply("ok")]);
    const made: string[] = [];
    const { app, session } = await mount([], { lead, login, made });
    await type(app, "/LOGIN chatgpt");
    await until(app, "signed in");
    await type(app, "/Lead"); // the model list, as /lead opens it
    await until(app, "Filter:");
    await tick(); // the picker starts reading keys just after it first appears
    await press(app, "\u001b");
    await until(app, "? for shortcuts");
    await type(app, "/Errors");
    await until(app, "No errors logged yet.");
    await type(app, "/Tmp is full");
    await until(app, "ok");
    await type(app, "/LEAD fake:B"); // the words after a command keep their case
    await until(app, "lead is now fake:b");
    expect(calls).toEqual(["login chatgpt"]);
    expect(made).toEqual(["fake:B"]);
    expect(session.messages[0]).toMatchObject({ role: "user", parts: [{ type: "text", text: "/Tmp is full" }] });
  });

  it("stops a sign-in on Ctrl-C, and shows why it failed", async () => {
    const login: Login = (_verb, _words, _say, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("Sign-in was cancelled"))));
    const { app } = await mount([], { login });
    await type(app, "/login chatgpt");
    await until(app, "Esc to stop");
    app.stdin.write("\u0003");
    await until(app, "Sign-in was cancelled");
    await gone(app, "Esc to stop");
  });

  const models: ModelGroup[] = [
    { provider: "fake", models: ["a", "b", "c"] },
    { provider: "ollama", error: "not running" },
    { provider: "evil", models: [`x${OSC52}`] },
  ];

  it("lists every provider's models with /model, marks the lead, and picks with the arrow keys and Enter", async () => {
    const made: string[] = [];
    const { app } = await mount([], { models, made });
    await type(app, "/model");
    await until(app, "ollama (not running)");
    expect(app.lastFrame()).toContain("● fake:a");
    expect(app.lastFrame()).toContain(`evil:x${OSC52_SHOWN}`);
    expectNoRawControls(app.lastFrame());
    await tick(); // the picker starts reading keys just after it first appears
    app.stdin.write("\u001b[B"); // down
    await tick();
    app.stdin.write("\r");
    await until(app, "lead is now fake:b");
    expect(made).toEqual(["fake:b"]);
  });

  it("filters as the user types, and closes on Esc without changing the lead", async () => {
    const made: string[] = [];
    const { app } = await mount([], { models, made });
    await type(app, "/Model"); // commands ignore case
    await until(app, "fake:c");
    await tick();
    app.stdin.write("c");
    await tick();
    expect(app.lastFrame()).toContain("fake:c");
    expect(app.lastFrame()).not.toContain("● fake:a"); // the status line still names the lead
    expect(app.lastFrame()).not.toContain("not running");
    app.stdin.write("\u001b");
    await until(app, "›");
    expect(app.lastFrame()).not.toContain("fake:c");
    expect(made).toEqual([]);
  });

  it("refuses words after /model instead of sending them to the model", async () => {
    const { app, session } = await mount([], { models });
    await type(app, "/model gpt");
    await until(app, "/model takes nothing after it.");
    expect(session.messages).toEqual([]);
  });

  // Choice 26, the user's: /lead, a /model pick and /screen change this window only, and save nothing, nor does
  // Shift+Tab. Unwatched here, so nothing else makes ~/.tachikoma either.
  it("changes the lead with /lead and a /model pick, and the screen with /screen, in this window only, making no settings file", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "tachi-home-"));
    const made: string[] = [];
    const { app, session } = await mount([], { models, full: true, home, made });
    await press(app, "\u001b[Z");
    await until(app, "mode is now project");
    await type(app, "/lead ollama:a");
    await until(app, "lead is now fake:b");
    await type(app, "/model");
    await until(app, "fake:c");
    await tick(); // the picker starts reading keys just after it first appears
    app.stdin.write("c");
    await tick();
    app.stdin.write("\r");
    await waitFor(() => made.length === 2);
    await type(app, "/screen");
    await until(app, "screen is now classic");
    expect(made).toEqual(["ollama:a", "fake:c"]);
    expect(session.lead.id).toBe("fake:b");
    expect(existsSync(settingsDir(home))).toBe(false);
  });

  it("moves both ways, unfilters on Backspace, says when nothing matches, and closes on Ctrl-C", async () => {
    const made: string[] = [];
    const { app } = await mount([], { models, made });
    await type(app, "/model");
    await until(app, "fake:c");
    await tick();
    app.stdin.write("zz");
    await until(app, "No models match.");
    app.stdin.write("\u007f");
    await tick();
    app.stdin.write("\u007f");
    await until(app, "fake:c");
    for (const key of ["\u001b[B", "\u001b[B", "\u001b[A"]) {
      app.stdin.write(key); // down, down, up
      await tick();
    }
    app.stdin.write("\r");
    await until(app, "lead is now fake:b");
    expect(made).toEqual(["fake:b"]);
    await type(app, "/model");
    await until(app, "fake:c");
    await tick();
    app.stdin.write("\u0003");
    await until(app, "›");
    expect(app.lastFrame()).not.toContain("fake:c");
    await type(app, "/lead"); // still running: the list opens again
    await until(app, "fake:c");
  });

  it("shows a provider with no models, and what signing in says while the lists are read", async () => {
    const { app } = await mount([], { models: [{ provider: "fake", models: ["a"] }, { provider: "empty", models: [] }], note: "Waiting for Tachikoma (process 7)…" });
    await type(app, "/model");
    await until(app, "empty (no models)");
    expect(app.lastFrame()).toContain("Waiting for Tachikoma (process 7)…");
    await tick();
    app.stdin.write("a");
    await tick();
    expect(app.lastFrame()).toContain("fake:a");
    expect(app.lastFrame()).not.toContain("empty");
  });

  it("reads keys that arrive together in order, each after the one before", async () => {
    const made: string[] = [];
    const { app } = await mount([], { models, made });
    await type(app, "/model");
    await until(app, "fake:c");
    await tick();
    app.stdin.write("\u001b[B\u001b[B"); // two downs in one read of the terminal
    app.stdin.write("\r");
    await until(app, "›");
    await type(app, "/model");
    await until(app, "fake:c");
    await tick();
    app.stdin.write("b\r"); // a letter and Enter in one read of the terminal, as a paste ends
    await until(app, "›");
    expect(made).toEqual(["fake:c", "fake:b"]);
  });

  it("keeps control characters out of the filter, and shows the rest escaped", async () => {
    const { app } = await mount([], { models });
    await type(app, "/model");
    await until(app, "fake:c");
    await tick();
    app.stdin.write("b\t\u202e");
    await until(app, "Filter: b\\u202e ·");
    app.stdin.write("x\r"); // nothing matches, so the line end picks nothing
    await until(app, "Filter: b\\u202ex ·");
  });

  it("says when there is nothing to pick from", async () => {
    const { app } = await mount([], { models: [{ provider: "openai", error: "key rejected" }] });
    await type(app, "/model");
    await until(app, "openai (key rejected)");
    expect(app.lastFrame()).toContain("No models to pick from.");
    expect(app.lastFrame()).not.toContain("No models match.");
  });

  it("stops reading the lists on Ctrl-C, without opening the picker", async () => {
    const { app } = await mount([], { models, slow: true });
    await type(app, "/model");
    await until(app, "Esc to stop");
    app.stdin.write("\u0003");
    await gone(app, "Esc to stop");
    await tick();
    expect(app.lastFrame()).not.toContain("fake:c");
    expect(app.lastFrame()).not.toContain("Filter:");
  });

  it("sends a message that starts with a one-word path", async () => {
    const { app, session } = await mount([reply("ok")]);
    await type(app, "/tmp is full");
    await until(app, "ok");
    expect(session.messages[0]).toMatchObject({ role: "user", parts: [{ type: "text", text: "/tmp is full" }] });
  });

  it("sends a message that only starts with a path", async () => {
    const { app, session } = await mount([reply("ok")]);
    await type(app, "/usr/bin is missing");
    await until(app, "ok");
    expect(session.messages[0]).toMatchObject({ role: "user", parts: [{ type: "text", text: "/usr/bin is missing" }] });
  });

  it("ignores a context-window lookup that finishes after the lead changed", async () => {
    let finish: (n: number) => void = () => {};
    const slow = Object.assign(new FakeProvider("a", []), { contextWindow: () => new Promise<number>((r) => (finish = r)) });
    const { app } = await mount([], { lead: slow });
    await type(app, "/lead fake:b");
    finish(1000);
    await tick();
    expect(app.lastFrame()).toContain("lead fake:b");
    expect(app.lastFrame()).toContain("ctx 0 ");
    expect(app.lastFrame()).not.toMatch(/\d+% left/);
  });

  it("asks for the context window again after a reply, when only a reply makes it known", async () => {
    let answered = false;
    const later = Object.assign(new FakeProvider("a", [reply("there")]), { contextWindow: async () => (answered ? 1000 : null) });
    const complete = later.complete.bind(later);
    later.complete = async (req) => ((answered = true), complete(req));
    const { app } = await mount([], { lead: later });
    expect(app.lastFrame()).not.toMatch(/\d+% left/);
    await type(app, "hi");
    await until(app, "there");
    await until(app, "% left");
    expect(app.lastFrame()).toMatch(/\d+% left/);
  });

  it("keeps the window it knows when asking again after a reply fails", async () => {
    let asked = 0;
    const flaky = Object.assign(new FakeProvider("a", [reply("there")]), {
      contextWindow: () => (asked++ ? Promise.reject(new Error("offline")) : Promise.resolve(1000)),
    });
    const { app } = await mount([], { lead: flaky });
    await until(app, "% left");
    await type(app, "hi");
    await until(app, "there");
    await tick();
    expect(asked).toBe(3); // the launch's, the session's before its request (release 8a plan, Task 12), and the reply's
    expect(app.lastFrame()).toContain("% left");
  });

  it("shows only the latest lookup's answer, so a slow earlier one cannot undo it", async () => {
    let first: (n: number | null) => void = () => {};
    let asked = 0;
    const slow = Object.assign(new FakeProvider("a", [reply("there")]), {
      contextWindow: () => (asked++ ? Promise.resolve(1000) : new Promise<number | null>((r) => (first = r))),
    });
    const { app } = await mount([], { lead: slow });
    await type(app, "hi");
    await until(app, "% left");
    first(null); // as Anthropic's lookup answers when it gives up
    await tick();
    expect(app.lastFrame()).toContain("% left");
  });

  it("shows the bar for an OpenAI API lead once a reply says how much is in use", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_BASE_URL", "");
    onTestFinished(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });
    vi.spyOn(Completions.prototype, "create").mockResolvedValue({
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "there", refusal: null } }],
      usage: { prompt_tokens: 209_000, completion_tokens: 1_000, total_tokens: 210_000 },
    } as never);
    const { app } = await mount([], { lead: new OpenAIProvider("openai", "gpt-5.5") });
    await type(app, "hi");
    await until(app, "there");
    await until(app, "██░░░░░░░░ 80% left"); // 210,000 of gpt-5.5's 1,050,000
  });

  it("keeps going when the context-window lookup fails", async () => {
    const broken = Object.assign(new FakeProvider("a", [reply("still here")]), { contextWindow: () => Promise.reject(new Error("no window")) });
    const { app } = await mount([], { lead: broken });
    await type(app, "hi");
    await until(app, "still here");
    expect(app.lastFrame()).toContain("ctx 15 "); // the window stays unknown, so the raw size is shown
  });

  it("shows when another model answered a refused turn", async () => {
    const { app, bus } = await mount([]);
    bus.emit("error", { kind: "fallback", attempted: "x", message: "fake:a declined; fake:b answered instead", lead: "fake:a" });
    await until(app, "↪ fake:a declined; fake:b answered instead");
    expect(app.lastFrame()).toContain("0 errors");
  });

  it("says how many pictures a request left out to fit its provider", async () => {
    const lead: Provider = {
      id: "fake:a",
      complete: async (req) => {
        req.leftOut?.(2, "Anthropic's 32 MB");
        return reply("seen");
      },
    };
    const { app } = await mount([], { lead });
    await type(app, "hi");
    await until(app, "seen");
    expect(app.lastFrame()).toContain("2 pictures were left out of this request to fit Anthropic's 32 MB.");
    expect(app.lastFrame()).toContain("0 errors");
  });

  it("summarises the error log with /errors", async () => {
    const { app } = await mount([]);
    await type(app, "/errors");
    expect(app.lastFrame()).toContain("No errors logged yet.");
  });

  it("cuts each row of /errors to the screen's width", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachi-"));
    const errorFile = path.join(dir, "errors.jsonl");
    writeFileSync(errorFile, `${JSON.stringify({ at: "x", session: "s", kind: "tool", attempted: `write_file ${"x".repeat(300)}`, message: "y".repeat(300), lead: "a" })}\n`);
    const { app } = await mount([], { errorFile });
    await type(app, "/errors");
    const rows = app.lastFrame()!.split("\n");
    expect(rows.find((l) => l.startsWith("Most recent"))!.endsWith("…")).toBe(true);
    expect(rows.find((l) => l.startsWith("  yyy"))!.endsWith("…")).toBe(true);
  });

  it("cuts a tool call to the screen's width, counting a wide character as two columns", async () => {
    const { app } = await mount([callTool("c1", "x", { s: "漢".repeat(80) }), reply("done")]);
    await type(app, "hi");
    await until(app, "done");
    const line = app.lastFrame()!.split("\n").find((l) => l.startsWith("● x"))!;
    expect(line.endsWith("…")).toBe(true);
    expect([...line].filter((c) => c === "漢").length).toBeLessThan(50); // the test screen is 100 columns
  });

  it("shows what a write will put in the file before asking, under a heading", async () => {
    const { app, ctx } = await mount([callTool("c1", "write_file", { path: "a.txt", content: "line one\nline two\n" }), reply("written")]);
    await type(app, "make a file");
    await until(app, "Allow write");
    expect(app.lastFrame()).toContain(`┌ write ${path.join(ctx.root, "a.txt")} (2 lines)\nline one\nline two`);
  });

  it("says so when a write would leave the file empty", async () => {
    const { app } = await mount([callTool("c1", "write_file", { path: "a.txt", content: "" }), reply("written")]);
    await type(app, "empty it");
    await until(app, "Allow write");
    expect(app.lastFrame()).toContain("(0 lines)\n(empty)");
  });

  it("shows an error, and keeps running, when the error log cannot be read", async () => {
    // A folder in one the test made: the log's own folder is made private when it is read (review fixes plan, fix 3).
    const dir = path.join(await mkdtemp(path.join(tmpdir(), "tachi-")), "log");
    mkdirSync(dir);
    const { app } = await mount([reply("still here")], { errorFile: dir });
    await type(app, "/errors");
    await until(app, `${dir} is not a plain file, so it was not used`);
    await type(app, "hi");
    await until(app, "still here");
  });

  it("shows control characters in a reply as escapes, keeping real line breaks", async () => {
    const { app } = await mount([reply(`one${OSC52}\u001b[8mhidden\rover\u202eback\ntwo`)]);
    await type(app, "hi");
    await until(app, "two");
    const frame = app.lastFrame();
    expect(frame).toContain(`one${OSC52_SHOWN}\\u001b[8mhidden␍over\\u202eback\n`);
    expectNoRawControls(frame);
  });

  it("shows control characters in a tool call's name and input, and in its error, as escapes", async () => {
    const { app } = await mount([callTool("c1", `x${OSC52}\r`, { s: "\u202e\u009b" }), reply("done")]);
    await type(app, "hi");
    await until(app, "done");
    const frame = app.lastFrame();
    expect(frame).toContain(`● x${OSC52_SHOWN}␍ {"s":"\\u202e\\u009b"}`);
    expect(frame).toContain(`⎿ Unknown tool: x${OSC52_SHOWN}␍`);
    expectNoRawControls(frame);
  });

  it("shows control characters in the user's line and in provider errors as escapes", async () => {
    const { app, bus } = await mount([]);
    bus.emit("message", { role: "user", parts: [{ type: "text", text: "a\u001b[8mb\rc" }] });
    bus.emit("error", { kind: "provider", attempted: "x", message: `bad${OSC52}`, lead: "fake:a" });
    await until(app, "✗ provider");
    const frame = app.lastFrame();
    expect(frame).toContain("> a\\u001b[8mb␍c");
    expect(frame).toContain(`✗ provider: bad${OSC52_SHOWN}`);
    expectNoRawControls(frame);
  });

  // Release 7 plan, Task 8: one red line per danger above the yellow question, in full screen and classic mode, with the
  // model's text escaped as the question's is. The gate is asked directly, so nothing runs the command.
  it.each([true, false])("draws a dangerous command's red lines above its question, escaped (full screen: %s)", async (full) => {
    await inColour(async () => {
      const { app, gate } = await mount([], { full });
      const line = "git push --force origin a\u202eb\u001b[8m; git reset --hard HEAD~3";
      const asking = gate.require({ kind: "shell", outside: false, summary: `run: ${line}`, command: line }).then(
        () => "allowed",
        (err: Error) => err.message,
      );
      await until(app, "Allow run:");
      const frame = app.lastFrame()!;
      const red = [
        "Danger: rewriting or deleting git history: git push --force origin a\\u202eb\\u001b[8m",
        "Danger: rewriting or deleting git history: git reset --hard HEAD~3",
      ];
      for (const r of red) expect(frame).toContain(`\u001b[31m${r}`);
      expect(frame.indexOf(red[0]!)).toBeLessThan(frame.indexOf(red[1]!));
      expect(frame.indexOf(red[1]!)).toBeLessThan(frame.indexOf("\u001b[33mAllow run:"));
      for (const raw of ["\u202e", "\u001b[8m"]) expect(frame).not.toContain(raw);
      await press(app, "n");
      expect(await asking).toMatch(/^The user declined: run: git push --force/);
      // The red lines go with the question, and its answer's line keeps the dangers, red (release 7 plan, choice 66).
      const after = app.lastFrame()!;
      expect(after).not.toContain("Allow run:");
      expect(after).toContain("\u001b[31mrun: git push --force origin a\\u202eb\\u001b[8m; git reset --hard HEAD~3: You declined this.");
      expect(stripVTControlCharacters(after).split("Danger:")).toHaveLength(3);
      for (const raw of ["‮", "\u001b[8m"]) expect(after).not.toContain(raw);
    });
  });

  // Release 7 plan, Task 10 and choice 65: a judge that cannot be reached refuses the action, which the screen shows as an
  // error, and the turn goes on.
  it("shows a judge that cannot be reached as an error, refuses the action, and the turn goes on", async () => {
    const target = path.join(await mkdtemp(path.join(tmpdir(), "tachi-")), "a.txt");
    const judge = new FakeProvider("judge", [new Error("judge down")]);
    const { app } = await mount([callTool("c1", "write_file", { path: target, content: "x" }), reply("carried on")], { mode: "auto", judge });
    await type(app, "write it");
    await until(app, "carried on");
    expect(app.lastFrame()).toContain("✗ judge: judge down");
    expect(existsSync(target)).toBe(false);
  });

  // Release 8a plan, Task 5: the "Saving fails" line in red after ✗, with no label (user, 2026-11-06, "✗ then the line").
  it("shows saving stopped as ✗ and the line alone, in red", async () => {
    await inColour(async () => {
      const { app, session, bus } = await mount([reply("still here")]);
      const errors: string[] = [];
      bus.on("error", (e) => errors.push(e.message));
      // A file where the sessions folder should be, so the first write fails, with no permission changed.
      const own = await mkdtemp(path.join(tmpdir(), "tachi-"));
      onTestFinished(() => removeTree(own));
      writeFileSync(path.join(own, "sessions"), "not a folder");
      const dir = path.join(own, "sessions", "project");
      const transcript = new Transcript(path.join(dir, "s1.jsonl"), path.join(dir, "s1", "pictures"));
      session.load({ id: "s1", messages: [], system: "t", transcript, prompts: [], calls: [], nextPicture: 1, nextTask: 1 });
      await type(app, "hi");
      await until(app, "still here");
      const frame = app.lastFrame()!;
      expect(errors).toEqual([expect.stringMatching(/^Saving this session stopped: /)]);
      expect(frame).toContain("\u001b[31m✗ Saving this session stopped:");
      // The line wraps at the screen's width, so it is compared without its blanks and line breaks.
      const bare = (s: string) => s.replace(/\s/g, "");
      expect(bare(stripVTControlCharacters(frame))).toContain(bare(`✗ ${errors[0]}`));
      expect(frame).not.toContain("saving:");
    });
  });

  // Release 7 plan, Task 10: after 3 refusals in a row the next action that would go to the judge asks, with auto mode's
  // pause in grey just above it, in full screen and classic; approving it resumes auto mode, so the next goes to the judge.
  it.each([true, false])("says auto mode's pause in grey above its question, and approving resumes it (full screen: %s)", async (full) => {
    await inColour(async () => {
      const folder = await mkdtemp(path.join(tmpdir(), "tachi-"));
      const writes = ["a", "b", "c", "d", "e"].map((n, i) => callTool(`c${i + 1}`, "write_file", { path: path.join(folder, `${n}.txt`), content: n }).parts).flat();
      const no = reply('{"allow": false, "reason": "No."}');
      const judge = new FakeProvider("judge", [no, no, no, reply('{"allow": true}')]);
      const { app } = await mount([{ parts: writes, usage }, reply("carried on")], { mode: "auto", judge, full });
      await type(app, "write them");
      await until(app, "Allow write");
      const frame = app.lastFrame()!;
      const line = "\u001b[90mAuto mode paused after 3 refusals; approving this resumes it.";
      expect(frame).toContain(line);
      expect(frame.indexOf(line)).toBeLessThan(frame.indexOf(`\u001b[33mAllow write ${path.join(folder, "d.txt")}?`));
      await press(app, "y");
      await until(app, "carried on");
      expect(existsSync(path.join(folder, "d.txt"))).toBe(true);
      expect(existsSync(path.join(folder, "e.txt"))).toBe(true);
      expect(app.lastFrame()).toContain(`write ${path.join(folder, "d.txt")}: You allowed this.`); // after its preview (choice 66)
      expect(judge.seen).toHaveLength(4);
    });
  });

  // Release 7 plan, Task 10: auto mode's pause is a grey row of its own question, above its yellow rows, so it waits in
  // the line with that question and shows only while it is the one asked. The App's ask is called directly. The gate never
  // sends a grey line with red lines today (a paused question has no dangers); the two tests below give both, as the
  // screen takes both, the grey row above.
  const PAUSE = "Auto mode paused after 3 refusals; approving this resumes it.";
  it.each([true, false])("draws a question's grey line with that question, not under one ahead of it in the line (full screen: %s)", async (full) => {
    await inColour(async () => {
      const { app, ask } = await mount([], { full });
      const first = ask("run: git push --force", undefined, undefined, undefined, ["Danger: rewriting or deleting git history: git push --force"]);
      const second = ask("read /made/up/elsewhere/notes.txt", undefined, undefined, undefined, [], PAUSE);
      await until(app, "Allow run: git push --force?");
      expect(app.lastFrame()).not.toContain("Auto mode paused");
      await press(app, "n");
      expect(await first).toBe(false);
      await until(app, "Allow read /made/up/elsewhere/notes.txt?");
      const frame = app.lastFrame()!;
      expect(frame.split(`\u001b[90m${PAUSE}`)).toHaveLength(2); // once, in grey
      expect(frame.indexOf(PAUSE)).toBeLessThan(frame.indexOf("\u001b[33mAllow read /made/up/elsewhere/notes.txt?"));
      await press(app, "n");
      expect(await second).toBe(false);
      expect(app.lastFrame()).not.toContain("Auto mode paused"); // it went with its question
    });
  });

  it("puts a moved question's grey line in its block in the conversation, above any red lines, and keeps it above the short line", async () => {
    await inColour(async () => {
      const line = `echo ${"x".repeat(900)}`;
      const { app, ask } = await mount([], { full: true, rows: 12 });
      const asking = ask(`run: ${line}`, undefined, undefined, undefined, ["Danger: a made-up danger"], PAUSE);
      await until(app, "Allow run (shown above)?");
      const rows = app.lastFrame()!.split("\n");
      const heading = rows.findIndex((r) => r.includes(`┌ run (${line.length + "run: ".length} characters)`));
      expect(heading).toBeGreaterThanOrEqual(0);
      expect(rows[heading + 1]).toContain(`\u001b[90m${PAUSE}`);
      expect(rows[heading + 2]).toContain("\u001b[31mDanger: a made-up danger");
      expect(rows[heading + 3]).toContain("\u001b[90mrun: echo xxx");
      expect(rows.filter((r) => r.includes(PAUSE))).toHaveLength(2); // in the conversation, and above the short line
      await press(app, "n");
      expect(await asking).toBe(false);
    });
  });

  // Release 8c plan, choice 47: an MCP call's grey note, its tool's description, is one screen row in every view, as full
  // screen already drew every note; another note, auto mode's pause, still wraps outside full screen.
  const LONG_NOTE = `Draws ${"a shape ".repeat(20).trimEnd()}`; // 166 columns: more than the test screen's 100
  it("cuts an MCP call's grey note to one row in classic, and wraps another note there as before", async () => {
    const { app, ask } = await mount([]);
    const first = ask('tv: draw {"shape":"line"}', undefined, undefined, undefined, [], LONG_NOTE, true);
    await until(app, "Allow tv: draw");
    let rows = app.lastFrame()!.split("\n");
    const at = rows.findIndex((r) => r.startsWith("Draws a shape"));
    expect(rows[at]).toMatch(/^Draws a shape.*…$/);
    expect(rows[at]!.length).toBeLessThanOrEqual(100); // the test screen's width
    expect(rows[at + 1]).toMatch(/^Allow tv: draw/);
    await press(app, "n");
    expect(await first).toBe(false);
    const second = ask('tv: draw {"shape":"line"}', undefined, undefined, undefined, [], LONG_NOTE);
    await until(app, "Allow tv: draw");
    rows = app.lastFrame()!.split("\n");
    const from = rows.findIndex((r) => r.startsWith("Draws a shape"));
    expect(rows[from]).not.toContain("…");
    expect(rows[from + 1]).not.toMatch(/^Allow/); // the rest of the note, on a row of its own
    await press(app, "n");
    expect(await second).toBe(false);
  });

  it("cuts a moved question's MCP note to one row in the conversation", async () => {
    const input = `{"text":"${"x".repeat(900)}"}`;
    const { app, ask } = await mount([], { full: true, rows: 12 });
    const asking = ask(`tv: draw ${input}`, undefined, undefined, undefined, [], LONG_NOTE, true);
    await until(app, "Allow tv (shown above)?");
    const rows = app.lastFrame()!.split("\n");
    const heading = rows.findIndex((r) => r.includes("┌ tv ("));
    expect(rows[heading + 1]).toMatch(/^Draws a shape.*…┃$/); // ┃: the scroll bar's column
    expect(rows[heading + 2]).toMatch(/^tv: draw/);
    await press(app, "n");
    expect(await asking).toBe(false);
  });

  it("fits a question's grey line in a small terminal, with red lines given too, keeping a red row", async () => {
    await inColour(async () => {
      const warnings = Array.from({ length: 7 }, (_, i) => `Danger: rewriting or deleting git history: git push --force origin b${i + 1}`);
      const { app, ask } = await mount([], { full: true, rows: 8 });
      const asking = ask("run: git push --force origin b1", undefined, undefined, undefined, warnings, PAUSE);
      await until(app, "more dangers");
      const frame = app.lastFrame()!;
      expect(frame.split("\n").length).toBeLessThanOrEqual(7); // the frame's row short of the terminal's eight
      expect(frame).toContain(`\u001b[90m${PAUSE}`);
      expect(frame).toContain(`\u001b[31m${warnings[0]}`);
      expect(frame).toContain("\u001b[31m…and 5 more dangers"); // eight rows: a row short, the conversation, grey, three red, the question, status
      expect(frame.indexOf(PAUSE)).toBeLessThan(frame.indexOf(warnings[0]!));
      expect(frame).toContain("\u001b[33mAllow run: git push --force origin b1?");
      await press(app, "n");
      expect(await asking).toBe(false);
    });
  });

  // Release 7 plan, Task 8's code review: a question too long to fit moves into the conversation, its red lines with it,
  // in red, under its heading and above its text, so its short line's "shown above" shows the dangers too.
  it("puts a moved question's red lines in the conversation, above its text", async () => {
    await inColour(async () => {
      const line = `echo ${"x".repeat(900)}; git push --force`;
      const { app, gate } = await mount([], { full: true, rows: 12 });
      const asking = gate.require({ kind: "shell", outside: false, summary: `run: ${line}`, command: line }).then(
        () => "allowed",
        (err: Error) => err.message,
      );
      await until(app, "Allow run (shown above)?");
      const rows = app.lastFrame()!.split("\n");
      const red = "\u001b[31mDanger: rewriting or deleting git history: git push --force";
      const heading = rows.findIndex((r) => r.includes(`┌ run (${line.length + "run: ".length} characters)`));
      expect(heading).toBeGreaterThanOrEqual(0);
      expect(rows[heading + 1]).toContain(red);
      expect(rows[heading + 2]).toContain("\u001b[90mrun: echo xxx");
      expect(rows.filter((r) => r.includes(red))).toHaveLength(2); // in the conversation, and above the short line
      await press(app, "n");
      expect(await asking).toMatch(/^The user declined: run: echo/);
    });
  });

  // Release 7 plan, choice 63: in full screen the red lines are a row each, cut at the terminal's width, and those that do
  // not fit are counted in the last red row, so the frame stays inside the terminal. Classic mode draws them whole.
  it("cuts the red lines to a row each in full screen, and counts those that do not fit, keeping the frame inside the terminal", async () => {
    await inColour(async () => {
      const line = [`git push --force origin ${"x".repeat(120)}`, ...Array.from({ length: 6 }, (_, i) => `git push --force origin b${i + 1}`)].join("; ");
      const { app, gate } = await mount([], { full: true, rows: 10 });
      const asking = gate.require({ kind: "shell", outside: false, summary: `run: ${line}`, command: line }).then(
        () => "allowed",
        (err: Error) => err.message,
      );
      await until(app, "more dangers");
      const frame = app.lastFrame()!;
      expect(frame.split("\n").length).toBeLessThanOrEqual(9); // the frame's row short of the terminal's ten
      expect(frame).toContain(`\u001b[31mDanger: rewriting or deleting git history: git push --force origin ${"x".repeat(32)}…`);
      // Ten rows: the frame's row short, the conversation's one, the question's four and the status line leave three.
      expect(frame).toContain("\u001b[31mDanger: rewriting or deleting git history: git push --force origin b1\u001b[39m");
      expect(frame).toContain("\u001b[31m…and 5 more dangers");
      expect(frame).not.toContain("\u001b[31mDanger: rewriting or deleting git history: git push --force origin b2");
      await press(app, "n");
      expect(await asking).toMatch(/^The user declined: run: git push --force/);
      const classic = await mount([], { rows: 10 });
      const whole = classic.gate.require({ kind: "shell", outside: false, summary: `run: ${line}`, command: line }).then(
        () => "allowed",
        (err: Error) => err.message,
      );
      await until(classic.app, "origin b6");
      expect(classic.app.lastFrame()!.split("\u001b[31mDanger: ").length - 1).toBe(7);
      expect(classic.app.lastFrame()).not.toContain("…"); // the long one wraps, whole
      expect(classic.app.lastFrame()).not.toContain("more dangers");
      await press(classic.app, "n");
      expect(await whole).toMatch(/^The user declined/);
    });
  });
});

// Each key in its own read of the terminal, as a person types them.
async function press(app: ReturnType<typeof render>, ...keys: string[]) {
  for (const k of keys) {
    app.stdin.write(k);
    await tick();
  }
}

const sent = (session: Session) => session.messages[0]?.parts[0];

describe("App's prompt", () => {
  it("edits with the line-editing keys, and sends what they leave", async () => {
    const { app, session } = await mount([reply("ok")]);
    // Ctrl+W, Home, Ctrl+Right (to the end of "hello"), Alt+Backspace.
    await press(app, "hello big world", "\u0017", "there", "\u001b[H", ">", "\u001b[1;5C", "\u001b\u007f", "hi");
    expect(app.lastFrame()).toContain("› >hi big there");
    await press(app, "\r");
    await until(app, "ok");
    expect(sent(session)).toEqual({ type: "text", text: ">hi big there" });
  });

  it("undoes a run of typing with Ctrl+Z", async () => {
    const { app } = await mount([]);
    await press(app, "one", "\u0017", "two", "\u001a");
    expect(app.lastFrame()).toMatch(/^›$/m); // undo took back the typing after Ctrl+W
    await press(app, "\u001a");
    expect(app.lastFrame()).toContain("› one");
  });

  it("makes a new line with backslash and Enter, and with Ctrl+J, and sends the lines as one message", async () => {
    const { app, session } = await mount([reply("ok")]);
    await press(app, "one\\", "\r", "two", "\n", "three");
    expect(app.lastFrame()).toContain("› one\n  two\n  three");
    expect(session.messages).toEqual([]);
    await press(app, "\r");
    await until(app, "ok");
    expect(sent(session)).toEqual({ type: "text", text: "one\ntwo\nthree" });
  });

  it("makes a new line on Shift+Enter where the terminal reports it apart from Enter", async () => {
    const { app, session } = await mount([]);
    await press(app, "one", "\u001b[13;2u", "two"); // Shift+Enter in the kitty keyboard protocol
    expect(app.lastFrame()).toContain("› one\n  two");
    expect(session.messages).toEqual([]);
  });

  it("takes a pasted block whole, without sending it at its line breaks", async () => {
    const { app, session } = await mount([reply("ok")]);
    await press(app, "\u001b[200~first line\rsecond line\u001b[201~");
    expect(app.lastFrame()).toContain("› first line\n  second line");
    expect(session.messages).toEqual([]);
    await press(app, "\r");
    await until(app, "ok");
    expect(sent(session)).toEqual({ type: "text", text: "first line\nsecond line" });
  });

  it("wraps at the screen's width, leaving a column for the cursor, and moves up and down by screen row", async () => {
    const { app } = await mount([]);
    await press(app, "x".repeat(150)); // the test screen is 100 columns: "› " and 97 of them fit on a row
    expect(app.lastFrame()).toContain(`› ${"x".repeat(97)}\n  ${"x".repeat(53)}`);
    await press(app, "\u001b[A", "a", "\u001b[B", "b"); // up, then down again
    expect(app.lastFrame()).toContain(`› ${"x".repeat(53)}a${"x".repeat(43)}\n  ${"x".repeat(54)}b`);
  });
});

// After an exit Ink reads no more keys, so a letter typed then never reaches the prompt.
async function expectExited(app: ReturnType<typeof render>) {
  await press(app, "x");
  expect(app.lastFrame()).not.toContain("› x");
}

describe("App's keys for stopping and exiting", () => {
  it("stops a turn on Esc, keeping what was done so far", async () => {
    const { app } = await mount([], { lead: hanging() });
    await type(app, "hi");
    await until(app, "Esc to stop");
    await press(app, "\u001b");
    await gone(app, "Esc to stop");
    expect(app.lastFrame()).toContain("> hi");
  });

  // Release 7 plan, Task 10: Esc while the judge is out stops its request, and the action does not run.
  it("runs nothing when Esc stops the turn while the judge is out", async () => {
    const judge = new Held("fake:judge");
    const target = path.join(await mkdtemp(path.join(tmpdir(), "tachi-")), "a.txt");
    const { app } = await mount([callTool("c1", "write_file", { path: target, content: "x" }), reply("never sent")], { mode: "auto", judge });
    await type(app, "write it");
    await waitFor(() => judge.asked.length === 1);
    await press(app, "\u001b");
    await gone(app, "Esc to stop");
    await tick();
    expect(existsSync(target)).toBe(false);
    expect(app.lastFrame()).not.toContain("never sent");
    expect(app.lastFrame()).not.toContain("✗");
  });

  it("declines one action on Esc at a question, and the turn carries on", async () => {
    const { app, ctx } = await mount([callTool("c1", "write_file", { path: "a.txt", content: "x" }), reply("carried on")]);
    await type(app, "make a file");
    const target = path.join(ctx.root, "a.txt");
    await until(app, `Allow write ${target}? [y/n] · Esc to decline`);
    await press(app, "\u001b");
    await until(app, "carried on");
    expect(app.lastFrame()).toContain(`write ${target}: You declined this.`);
    expect(existsSync(target)).toBe(false);
  });

  it("clears the prompt on Esc pressed twice, and not on one Esc or two with a key between", async () => {
    const { app } = await mount([]);
    await press(app, "abc", "\u001b");
    expect(app.lastFrame()).toContain("› abc");
    await press(app, "d", "\u001b");
    expect(app.lastFrame()).toContain("› abcd");
    await press(app, "\u001b");
    expect(app.lastFrame()).toMatch(/^›$/m);
    await press(app, "\u001b", "\u001b"); // on an empty prompt, nothing
    expect(app.lastFrame()).toMatch(/^›$/m);
  });

  it("clears the prompt on Ctrl-C, and on an empty prompt asks for a second press, which exits", async () => {
    const { app } = await mount([]);
    await press(app, "abc", "\u0003");
    expect(app.lastFrame()).toMatch(/^›$/m);
    expect(app.lastFrame()).toContain("? for shortcuts");
    await press(app, "\u0003");
    expect(app.lastFrame()).toContain("Press Ctrl-C again to exit");
    expect(app.lastFrame()).not.toContain("? for shortcuts");
    await press(app, "\u0003");
    await expectExited(app);
  });

  it("deletes the character after the cursor on Ctrl-D, and on an empty prompt asks for a second press, which exits", async () => {
    const { app } = await mount([]);
    await press(app, "ab", "\u001b[D", "\u0004");
    expect(app.lastFrame()).toContain("› a\n");
    await press(app, "\u0015", "\u0004"); // Ctrl+U empties the prompt
    expect(app.lastFrame()).toContain("Press Ctrl-D again to exit");
    await press(app, "\u0004");
    await expectExited(app);
  });

  it("forgets a first press after 800 ms, and after any other key", async () => {
    const { app } = await mount([]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // Then one turn of the event loop (setImmediate is not faked), in which the screen is drawn again.
      const wait = async (ms: number) => {
        await vi.advanceTimersByTimeAsync(ms);
        await new Promise((resolve) => setImmediate(resolve));
      };
      app.stdin.write("\u0003");
      await wait(799);
      expect(app.lastFrame()).toContain("Press Ctrl-C again to exit");
      await wait(1);
      expect(app.lastFrame()).toContain("? for shortcuts");
      app.stdin.write("\u0003");
      await wait(10);
      expect(app.lastFrame()).toContain("Press Ctrl-C again to exit"); // a first press again, not an exit
      app.stdin.write("\u0004"); // another key
      await wait(10);
      expect(app.lastFrame()).toContain("Press Ctrl-D again to exit");
      app.stdin.write("\u0003");
      await wait(10);
      expect(app.lastFrame()).toContain("Press Ctrl-C again to exit");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the shortcuts hint only while the prompt waits for the user", async () => {
    const { app } = await mount([], { lead: hanging() });
    expect(app.lastFrame()).toContain("? for shortcuts");
    await type(app, "hi");
    await until(app, "Esc to stop");
    expect(app.lastFrame()).not.toContain("? for shortcuts");
  });

  // Found at the final review: Ink ending during a turn (a drawing error) leaves nothing on screen to show it, and the
  // turn would go on paying.
  it("stops a turn when Ink ends during it", async () => {
    const lead = new Held();
    let signal: AbortSignal | undefined;
    const complete = lead.complete.bind(lead);
    lead.complete = (req) => {
      signal = req.signal;
      return complete(req);
    };
    const { app } = await mount([], { lead });
    await type(app, "hi");
    await until(app, "Esc to stop");
    app.unmount();
    expect(signal?.aborted).toBe(true);
  });
});

describe("App's history", () => {
  it("steps back through the project's past prompts with Up, and forward again to what was being typed", async () => {
    const { app } = await mount([], { past: ["old one", "old two"] });
    await press(app, "draft", "\u001b[A");
    expect(app.lastFrame()).toContain("› old two");
    await press(app, "\u001b[A", "\u001b[A"); // and no further than the oldest
    expect(app.lastFrame()).toContain("› old one");
    await press(app, "\u001b[B");
    expect(app.lastFrame()).toContain("› old two");
    await press(app, "\u001b[B");
    expect(app.lastFrame()).toContain("› draft");
    await press(app, "\u0010"); // Ctrl+P, as Up
    expect(app.lastFrame()).toContain("› old two");
    await press(app, "\u000e"); // Ctrl+N, as Down
    expect(app.lastFrame()).toContain("› draft");
  });

  it("moves through a prompt's rows first, and reaches the history from the first row", async () => {
    const { app } = await mount([], { past: ["past"] });
    await press(app, "a", "\n", "b", "\u001b[A", "x");
    expect(app.lastFrame()).toContain("› ax\n  b");
    await press(app, "\u001b[A");
    expect(app.lastFrame()).toContain("› past");
  });

  it("saves each sent prompt, once when sent twice in a row, and one cleared with Ctrl-C or Esc Esc", async () => {
    const { app, historyFile } = await mount([reply("r1"), reply("r2")]);
    await type(app, "one");
    await until(app, "r1");
    await type(app, "  one ");
    await until(app, "r2");
    await press(app, "two", "\u0003", "three", "\u001b", "\u001b");
    expect(new History(historyFile, () => {}).load()).toEqual(["one", "two", "three"]);
    await press(app, "\u001b[A");
    expect(app.lastFrame()).toContain("› three");
  });

  it("says once when the history cannot be read or saved, and still sends the prompt", async () => {
    // A folder where the file should be, inside a folder of the test's own: the history makes its
    // folder private, which must never be the system's temp folder.
    const dir = path.join(await mkdtemp(path.join(tmpdir(), "tachi-")), "history.jsonl");
    mkdirSync(dir);
    const { app } = await mount([reply("still sent")], { historyFile: dir });
    await until(app, "The prompt history could not be read or saved");
    await type(app, "hi");
    await until(app, "still sent");
    expect(app.lastFrame()!.split("The prompt history could not").length).toBe(2);
  });

  it("searches the past prompts with Ctrl+R, an older match on each press, and puts one in the prompt on Tab", async () => {
    const { app } = await mount([], { past: ["git status", "npm test", "git commit -m x", "ls"] });
    await press(app, "\u0012", "git");
    expect(app.lastFrame()).toContain("› git commit -m x");
    expect(app.lastFrame()).toContain("search: git ·");
    await press(app, "\u0012");
    expect(app.lastFrame()).toContain("› git status");
    await press(app, "\u0012"); // no older match: it stays
    expect(app.lastFrame()).toContain("› git status");
    await press(app, "\t", "!");
    expect(app.lastFrame()).toContain("› git status!");
    expect(app.lastFrame()).toContain("? for shortcuts");
  });

  it("sends the match on Enter, and puts it in the prompt on Esc", async () => {
    const { app, session } = await mount([reply("ok")], { past: ["say hi", "say bye"] });
    await press(app, "\u0012", "bye", "\u001b");
    expect(app.lastFrame()).toContain("› say bye");
    await press(app, "\u0015", "\u0012", "hi", "\r"); // Ctrl+U empties the prompt first
    await until(app, "ok");
    expect(sent(session)).toEqual({ type: "text", text: "say hi" });
  });

  it("gives back what was typed when the search is cancelled with Ctrl-C, or with Backspace on an empty search", async () => {
    const { app } = await mount([], { past: ["say hi"] });
    await press(app, "draft", "\u0012", "zz");
    expect(app.lastFrame()).toContain("search: zz (no match)");
    expect(app.lastFrame()).toContain("› draft");
    await press(app, "\u0003");
    expect(app.lastFrame()).toContain("› draft");
    expect(app.lastFrame()).toContain("? for shortcuts");
    await press(app, "\u0012", "h");
    expect(app.lastFrame()).toContain("› say hi");
    await press(app, "\u007f", "\u007f");
    expect(app.lastFrame()).toContain("› draft");
    expect(app.lastFrame()).not.toContain("search:");
  });
});

// A lead that answers in turn, the first request only once `release` is called (or Esc stops it).
function gated(turns: ConstructorParameters<typeof FakeProvider>[1]) {
  const fake = new FakeProvider("a", turns);
  let release!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  const lead: Provider = {
    id: fake.id,
    complete: async (req) => {
      if (first) {
        first = false;
        await new Promise<void>((resolve, reject) => {
          void open.then(resolve);
          req.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return fake.complete(req);
    },
  };
  return { lead, fake, release };
}

// The user's messages, in the order the model was sent them.
const prompts = (session: Session) => session.messages.filter((m) => m.role === "user").flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])));

describe("App's queue", () => {
  it("keeps the prompt open during a turn, queues each Enter under the working line, and sends prompts next to each other as one", async () => {
    const { lead, release } = gated([reply("r1"), reply("r2")]);
    const { app, session, historyFile } = await mount([], { lead });
    await type(app, "one");
    await until(app, "Esc to stop");
    await press(app, "two", "\r", "three", "\r", "fo");
    expect(app.lastFrame()).toMatch(/Esc to stop\ntwo\nthree\n› fo\n↑ to edit queued messages\n/);
    release();
    await until(app, "r2");
    expect(prompts(session)).toEqual(["one", "two\n\nthree"]);
    expect(app.lastFrame()).toContain("› fo");
    expect(app.lastFrame()).not.toContain("queued");
    expect(new History(historyFile, () => {}).load()).toEqual(["one", "two", "three"]); // saved as each was added
  });

  it("queues a prompt typed straight after another, in one read of the terminal", async () => {
    const { lead, release } = gated([reply("r1"), reply("r2")]);
    const { app, session } = await mount([], { lead });
    app.stdin.write("one\rtwo\r");
    await until(app, "Esc to stop");
    expect(app.lastFrame()).toMatch(/Esc to stop\ntwo\n›/);
    release();
    await until(app, "r2");
    expect(prompts(session)).toEqual(["one", "two"]);
  });

  it("keeps the queue waiting for a turn started straight after a command, in one read of the terminal", async () => {
    const { lead, release } = gated([reply("r1"), reply("r2")]);
    const { app, session } = await mount([], { lead, newLead: lead });
    app.stdin.write("/lead fake:b\rone\rtwo\r");
    await tick(); // the command is done, and its turn-end would take the queue on
    expect(app.lastFrame()).toMatch(/\ntwo\n›/); // still queued: one is running
    release();
    await until(app, "r2");
    expect(prompts(session)).toEqual(["one", "two"]);
  });

  it("takes a /command alone, as if typed then, and the prompts after it wait until it is done", async () => {
    const { lead, fake, release } = gated([reply("r1"), reply("r2")]);
    const b = new FakeProvider("b", [reply("from b")]);
    const { app, session } = await mount([], { lead, newLead: b });
    await type(app, "one");
    await until(app, "Esc to stop");
    await press(app, "two", "\r", "/lead fake:b", "\r", "three", "\r");
    release();
    await until(app, "from b");
    expect(prompts(session)).toEqual(["one", "two", "three"]);
    expect(fake.seen).toHaveLength(2);
    expect(b.seen).toHaveLength(1);
    expect(app.lastFrame()).toMatch(/r2[\s\S]*lead is now fake:b[\s\S]*> three/);
  });

  it("goes on with the queue after Esc stops a turn, and after a turn that ends in an error", async () => {
    const { lead, release } = gated([new Error("boom"), reply("last")]);
    const { app, session } = await mount([], { lead });
    await type(app, "one");
    await until(app, "Esc to stop");
    await press(app, "two", "\r", "/tasks", "\r", "three", "\r", "\u001b");
    await until(app, "last");
    release();
    expect(prompts(session)).toEqual(["one", "two", "three"]);
    expect(app.lastFrame()).toMatch(/boom[\s\S]*No subagents yet.[\s\S]*> three/);
  });

  it("brings the queue back into the prompt on Ctrl-C, after what is typed, one entry a line, and sends nothing more", async () => {
    const { app, session } = await mount([], { lead: hanging() });
    await type(app, "one");
    await until(app, "Esc to stop");
    await press(app, "two", "\r", "three", "\r", "draft", "\u0003");
    await gone(app, "Esc to stop");
    expect(app.lastFrame()).toContain("› draft\n  two\n  three\n? for shortcuts");
    await tick();
    expect(prompts(session)).toEqual(["one"]);
  });

  it("brings the queue back on Ctrl-C at a question too", async () => {
    const { lead, release } = gated([callTool("c1", "write_file", { path: "a.txt", content: "x" })]);
    const { app, ctx } = await mount([], { lead });
    await type(app, "make a file");
    await until(app, "Esc to stop");
    await press(app, "two", "\r");
    release();
    await until(app, `Allow write ${path.join(ctx.root, "a.txt")}?`);
    await press(app, "\u0003");
    await gone(app, "Esc to stop");
    expect(app.lastFrame()).toContain("› two\n? for shortcuts");
  });

  it("exits on a queued /exit, sending nothing after it", async () => {
    const { lead, release } = gated([reply("r1"), reply("r2")]);
    const { app, session } = await mount([], { lead });
    await type(app, "one");
    await until(app, "Esc to stop");
    await press(app, "/exit", "\r", "two", "\r");
    release();
    await vi.waitFor(() => expect(session.messages.at(-1)?.role).toBe("assistant")); // the screen is gone once it exits
    await tick();
    expect(prompts(session)).toEqual(["one"]);
    await expectExited(app);
  });

  it("shows the queue's hint only while the prompt has the keys", async () => {
    const { lead, release } = gated([callTool("c1", "write_file", { path: "a.txt", content: "x" }), reply("done")]);
    const { app } = await mount([], { lead });
    await type(app, "make a file");
    await until(app, "Esc to stop");
    await press(app, "two", "\r");
    expect(app.lastFrame()).toContain("↑ to edit queued messages");
    release();
    await until(app, "[y/n]");
    expect(app.lastFrame()).not.toContain("queued");
  });

  it.each(["/model", "/lead"])("waits after a queued %s until the list is closed", async (command) => {
    const { lead, release } = gated([reply("r1"), reply("r2")]);
    const { app, session } = await mount([], { lead, models: [{ provider: "fake", models: ["a", "c"] }] });
    await type(app, "one");
    await until(app, "Esc to stop");
    await press(app, command, "\r", "two", "\r");
    release();
    await until(app, "fake:c");
    await tick();
    expect(prompts(session)).toEqual(["one"]);
    await press(app, "\u001b");
    await until(app, "r2");
    expect(prompts(session)).toEqual(["one", "two"]);
  });

  it("takes the queue back on Up from an empty prompt", async () => {
    const { app } = await mount([], { lead: hanging(), past: ["old"] });
    await type(app, "one");
    await until(app, "Esc to stop");
    await press(app, "two", "\r", "three", "\r", "\u001b[A");
    expect(app.lastFrame()).toContain("› two\n  three\n");
    expect(app.lastFrame()).not.toContain("queued");
    await press(app, "\u001b[A", "\u001b[A"); // the prompt has text now: Up moves up its rows, then into the history
    expect(app.lastFrame()).toContain("› three");
  });
});

describe("App's space on screen", () => {
  const lines = (n: number) => [...Array(n).keys()].map((i) => `l${i}`).join("\r");

  it("keeps the live part a row shorter than the terminal, showing a tall paste around the cursor", async () => {
    const { app } = await mount([], { rows: 10 });
    await press(app, `\u001b[200~${lines(20)}\u001b[201~`);
    const frame = app.lastFrame()!;
    expect(frame.split("\n")).toHaveLength(9);
    expect(frame).toContain("› ↑ 14 rows above\n  l14\n");
    expect(frame).toContain("  l19\n? for shortcuts\n");
    await press(app, ...Array<string>(6).fill("\u001b[A")); // up to l13, past the window's top
    expect(app.lastFrame()!.split("\n")).toHaveLength(9);
    expect(app.lastFrame()).toContain("› ↑ 13 rows above\n  l13\n");
    expect(app.lastFrame()).toContain("  ↓ 2 rows below\n");
  });

  it("gives the queue the rows the prompt leaves, the last saying how many more, or the hint line the count", async () => {
    const { app } = await mount([], { lead: hanging(), rows: 8 });
    await type(app, "one");
    await until(app, "Esc to stop");
    for (const q of ["q1", "q2", "q3", "q4", "q5"]) await press(app, q, "\r");
    expect(app.lastFrame()).toMatch(/Esc to stop\nq1\nq2\n\+3 more\n›\n↑ to edit queued messages\n[^\n]*$/);
    await press(app, "a", "\n", "b", "\n", "c", "\n", "d"); // four rows: none left for the queue
    expect(app.lastFrame()).toMatch(/Esc to stop\n› a\n  b\n  c\n  d\n5 queued\n[^\n]*$/);
  });

  it("drops the hint line when the terminal is too short for it and the cursor's row", async () => {
    const { app } = await mount([], { rows: 3 });
    expect(app.lastFrame()).toMatch(/^›\n[^\n]*$/);
    Object.assign(app.stdout, { rows: 4 });
    app.stdout.emit("resize");
    await tick();
    expect(app.lastFrame()).toMatch(/^›\n\? for shortcuts\n[^\n]*$/);
  });
});

describe("App's background subagents", () => {
  const bg = (id: string, task: string) => callTool(id, "delegate", { description: task, task, background: true });
  const note = (text: string) => ({ type: "text", text, from: "tasks" });

  it("reads an answer that finishes while the lead is idle in a turn of its own, saying it finished", async () => {
    const worker = new Held("fake:w");
    const lead = new FakeProvider("a", [bg("c1", "find x"), reply("started it"), reply("t1 says found")]);
    const { app } = await mount([], { lead, worker });
    await type(app, "go");
    await until(app, "started it");
    worker.answer("found");
    await until(app, "t1 says found");
    expect(app.lastFrame()).toContain("t1 finished");
    expect(lead.seen[2]!.at(-1)!.parts).toEqual([note("Background task t1 (find x) finished:\nfound")]);
  });

  it("hands the lead a failure during its turn with the next request's tool results, with no turn of its own", async () => {
    const lead = new FakeProvider("a", [bg("c1", "find x"), reply("t1 broke")]);
    const { app } = await mount([], { lead, worker: new FakeProvider("w", [new Error("rate limited")]) });
    await type(app, "go");
    await until(app, "t1 broke");
    expect(app.lastFrame()).toContain("t1 failed");
    expect(lead.seen[1]!.at(-1)!.parts.at(-1)).toEqual(note("Background task t1 (find x) failed: rate limited"));
    await tick();
    expect(lead.seen).toHaveLength(2);
  });

  it("shows that turn as reading the answer, and Esc stops it like any other", async () => {
    const worker = new Held("fake:w");
    const lead = new Held("fake:a");
    const { app } = await mount([], { lead, worker });
    await type(app, "go");
    lead.answer(bg("c1", "find x"));
    await waitFor(() => lead.asked.length === 2);
    lead.answer("started");
    await until(app, "started");
    worker.answer("found");
    await until(app, "Reading t1's answer");
    await press(app, "\u001b");
    await gone(app, "Reading t1's answer");
  });

  it("reads an answer that came during the lead's last request when the turn ends, before a queued prompt", async () => {
    const worker = new Held("fake:w");
    const lead = new Held("fake:a");
    const { app } = await mount([], { lead, worker });
    await type(app, "go");
    lead.answer(bg("c1", "find x"));
    await waitFor(() => lead.asked.length === 2); // the lead's last request, already sent
    worker.answer("found");
    await press(app, "q1", "\r");
    lead.answer("started");
    await waitFor(() => lead.asked.length === 3);
    expect(lead.asked[2]!.messages.at(-1)!.parts).toEqual([note("Background task t1 (find x) finished:\nfound")]);
    lead.answer("read it");
    await waitFor(() => lead.asked.length === 4);
    expect(lead.asked[3]!.messages.at(-1)!.parts).toEqual([{ type: "text", text: "q1" }]);
    expect(lead.asked.flatMap((r) => r.messages).filter((m) => m.parts.some((p) => p.type === "text" && p.from === "tasks"))).toHaveLength(2); // in one request only, then in the history
  });

  it("waits while the model list is open, and reads the answer once it closes", async () => {
    const worker = new Held("fake:w");
    const lead = new FakeProvider("a", [bg("c1", "find x"), reply("started it"), reply("t1 says found")]);
    const { app } = await mount([], { lead, worker, models: [{ provider: "fake", models: ["a", "b"] }] });
    await type(app, "go");
    await until(app, "started it");
    await press(app, "\u001bp");
    await until(app, "fake:b");
    await tick(); // the picker starts reading keys just after it first appears
    worker.answer("found");
    await tick();
    expect(lead.seen).toHaveLength(2);
    await press(app, "\u001b");
    await until(app, "t1 says found");
  });

  it("on Esc, stops the turn and the subagents it waits for, not background ones", async () => {
    const lead = new FakeProvider("a", [{ parts: [...bg("c1", "a").parts, ...callTool("c2", "delegate", { description: "b", task: "b" }).parts], usage }]);
    const { app, tasks } = await mount([], { lead, worker: new Held("fake:w") });
    await type(app, "go");
    await waitFor(() => tasks.all.length === 2 && tasks.all.every((t) => t.state === "running"));
    await press(app, "\u001b");
    await waitFor(() => tasks.all[1]!.state === "stopped");
    expect(tasks.all[0]!.state).toBe("running");
  });

  it("shows each subagent in a panel under the prompt, a finished row staying until the user's next turn", async () => {
    const worker = new Held("fake:w");
    const lead = new FakeProvider("a", [bg("c1", "find x"), reply("started it"), reply("read it"), reply("next")]);
    const { app } = await mount([], { lead, worker, segments: ["tasks"] });
    await type(app, "go");
    await until(app, "started it");
    expect(app.lastFrame()).toMatch(/›\n◐ t1 find x\n  ⎿ w · \d+s · ↓ 0 tokens · \$0\.00\n\? for shortcuts\n 1 running$/);
    worker.answer("found");
    await until(app, "read it");
    expect(app.lastFrame()).toMatch(/›\n✓ t1 find x\n  ⎿ w · /);
    await type(app, "more");
    await until(app, "next");
    expect(app.lastFrame()).not.toContain("✓ t1 find x");
  });

  it("lists the session's subagents with /tasks, finished ones taken off the panel included", async () => {
    const lead = new FakeProvider("a", [bg("c1", "find x"), reply("started it"), reply("next")]);
    const { app } = await mount([], { lead, worker: new FakeProvider("w", [reply("found")]) });
    await type(app, "/tasks");
    await until(app, "No subagents yet.");
    await type(app, "go");
    await until(app, "started it");
    await type(app, "more");
    await until(app, "next");
    await type(app, "/tasks");
    await until(app, "Subagents: 1");
    expect(app.lastFrame()).toMatch(/Subagents: 1\n✓ t1 find x\n  ⎿ w · \d+s · ↓ 5 tokens · \$0\.00 \+ \?\n/);
  });

  it("prints a subagent's tool calls and answer in full with /tasks t1", async () => {
    const worker = new FakeProvider("w", [callTool("w1", "find_files", { pattern: "*.ts" }), reply("It is in a.ts")]);
    const { app } = await mount([callTool("c1", "delegate", { description: "find x", task: "find x" }), reply("done")], { worker });
    await type(app, "go");
    await until(app, "done");
    await type(app, "/tasks t1");
    await until(app, "t1 (find x), done: 1 tool call");
    expect(app.lastFrame()).toContain('● find_files {\n  "pattern": "*.ts"\n}\n  ⎿ No files match *.ts');
    expect(app.lastFrame()).toContain("Answer:\nIt is in a.ts");
    await type(app, "/tasks t9");
    await until(app, "No subagent t9. /tasks lists them.");
  });

  it("stops one subagent with /tasks stop t1, or all with /tasks stop", async () => {
    const lead = new FakeProvider("a", [{ parts: [...bg("c1", "a").parts, ...bg("c2", "b").parts], usage }, reply("started")]);
    const { app, tasks } = await mount([], { lead, worker: new Held("fake:w") });
    await type(app, "go");
    await until(app, "started");
    await type(app, "/tasks stop t1");
    await until(app, "Stopped t1.");
    expect(tasks.all.map((t) => t.state)).toEqual(["stopped", "running"]);
    await type(app, "/tasks stop t1");
    await until(app, "t1 is not running.");
    await type(app, "/tasks stop");
    await until(app, "Stopped every subagent.");
    expect(tasks.all[1]!.state).toBe("stopped");
    await type(app, "/tasks stop");
    await until(app, "No subagent is running.");
  });

  for (const [way, keys] of [
    ["/exit", ["/exit", "\r"]],
    ["Ctrl-C twice", ["\u0003", "\u0003"]],
    ["Ctrl-D twice", ["\u0004", "\u0004"]],
  ] as const) {
    it(`stops every subagent on ${way}`, async () => {
      const lead = new FakeProvider("a", [bg("c1", "a"), reply("started")]);
      const { app, tasks } = await mount([], { lead, worker: new Held("fake:w") });
      await type(app, "go");
      await until(app, "started");
      for (const key of keys) await press(app, key);
      await waitFor(() => tasks.all[0]!.state === "stopped");
    });
  }
});

// A subagent that asks: its name, its stop signal, and whether it was stopped.
function asker(name: string) {
  const stop = new AbortController();
  const a: { stopped: boolean; owner: Owner } = {
    stopped: false,
    owner: {
      name,
      signal: stop.signal,
      stop: () => {
        a.stopped = true;
        stop.abort();
      },
    },
  };
  return a;
}

describe("App's questions", () => {
  it("shows the lead's and the subagents' questions one at a time, in order, each naming who asks", async () => {
    const { app, ask } = await mount([]);
    const t2 = asker("t2 (find the login code)");
    const t3 = asker("t3 (read\rthe tests)");
    const answers = [ask("read /a"), ask("read /b", undefined, t2.owner), ask("read /c", undefined, t3.owner)];
    await until(app, "Allow read /a? [y/n]");
    await press(app, "y");
    await until(app, "Allow t2 (find the login code) to read /b? [y/n]");
    await press(app, "n");
    await until(app, "Allow t3 (read␍the tests) to read /c? [y/n]");
    await press(app, "\u001b");
    expect(await Promise.all(answers)).toEqual([true, false, false]);
    expect(app.lastFrame()).toContain("t2 (find the login code) to read /b: You declined this.");
  });

  it("on Ctrl-C at a subagent's question, stops that subagent, not the lead's turn", async () => {
    const { app, ask } = await mount([], { lead: hanging() });
    await type(app, "one");
    await until(app, "Esc to stop");
    const t2 = asker("t2 (find the login code)");
    const answer = ask("read /b", undefined, t2.owner);
    await until(app, "Allow t2");
    await press(app, "\u0003");
    expect(await answer).toBe(false);
    expect(t2.stopped).toBe(true);
    await until(app, "Esc to stop");
  });

  it("takes away a stopped subagent's questions, the one on screen included, and shows the next", async () => {
    const { app, ask } = await mount([]);
    const t2 = asker("t2 (x)");
    const t3 = asker("t3 (y)");
    const answers = [ask("read /b", undefined, t2.owner), ask("read /b2", undefined, t2.owner), ask("read /c", undefined, t3.owner)];
    await until(app, "Allow t2 (x) to read /b?");
    t2.owner.stop();
    await until(app, "Allow t3 (y) to read /c?");
    expect(await Promise.all(answers.slice(0, 2))).toEqual([false, false]);
    expect(app.lastFrame()).toContain("t2 (x) to read /b: This was cancelled.");
  });

  it("on Ctrl-C at the lead's question, stops the turn and takes away its questions only", async () => {
    const { app, ask } = await mount([callTool("c1", "write_file", { path: "a.txt", content: "x" }), reply("written")]);
    await type(app, "make a file");
    await until(app, "Allow write");
    const t3 = asker("t3 (y)");
    const answer = ask("read /c", undefined, t3.owner);
    await press(app, "\u0003");
    await until(app, "Allow t3 (y) to read /c?");
    await press(app, "y");
    expect(await answer).toBe(true);
    expect(t3.stopped).toBe(false);
  });
});

// A shell that runs nothing: it keeps each command it is given, as text, and says it succeeded, so a dangerous-looking
// command's answer can be shown without anything running it (release 7 plan, choice 66).
function noShell() {
  const ran: string[] = [];
  const executor: Executor = {
    exec: async (command) => {
      ran.push(command);
      return { code: 0, signal: null, stdout: "", stderr: "" };
    },
  };
  return { ran, executor };
}

// Release 7 plan, choice 66: an answered question is one line under its tool line, "You allowed this." or "You declined
// this." with each danger after it, red when it has one; a declined call's own result row is left out, as that line says
// it, while the model is told its full message. A line not under its tool line names what it answers, and the declined
// call keeps a short result row in its place, in call order (choice 67).
describe("App's answers", () => {
  // The frame's rows without colour, in full screen without the scroll bar's column (shown, below).
  const rows = (app: ReturnType<typeof render>, full: boolean) =>
    stripVTControlCharacters(app.lastFrame()!).split("\n").map((r) => (full ? r.slice(0, 99) : r).trimEnd());
  // The rows from the one that starts with `tool` on.
  const from = (app: ReturnType<typeof render>, full: boolean, tool: string) => {
    const r = rows(app, full);
    const at = r.findIndex((x) => x.startsWith(tool));
    expect(at).toBeGreaterThanOrEqual(0);
    return r.slice(at);
  };
  // The user's own example, from the auto-mode terminal check after Part 2, where the folder deleted was the project's,
  // so the check finds it whole: here the test's own project folder, which nothing runs against.
  it.each([true, false])("says a declined dangerous command once, its danger kept, red, under its tool line (full screen: %s)", async (full) => {
    await inColour(async () => {
      const { ran, executor } = noShell();
      const turns: Turn[] = [];
      const lead = new FakeProvider("a", turns);
      const { app, ctx } = await mount([], { lead, mode: "auto", full, executor });
      const line = `Set-Location ${path.dirname(ctx.root)}; Remove-Item -LiteralPath ${ctx.root} -Recurse -Force; Test-Path ${ctx.root}`;
      turns.push(callTool("c1", "shell", { command: line }), reply("left it"));
      await type(app, "delete the folder");
      await until(app, "Allow run:");
      await press(app, "n");
      await until(app, "left it");
      const r = from(app, full, "● shell Set-Location");
      const answer = r.slice(1, r.findIndex((x) => x.startsWith("left it")));
      expect(answer[0]).toMatch(/^ {2}⎿ You declined this\. Danger: deleting whole folders: Remove-Item/);
      // One line, wrapped: nothing else between the tool line and the reply, and no result row of its own.
      const red = `Danger: deleting whole folders: Remove-Item -LiteralPath ${ctx.root} -Recurse -Force`;
      expect(answer.join("").replace(/\s+/g, "")).toBe(`⎿ You declined this. ${red}`.replace(/\s+/g, ""));
      expect(app.lastFrame()).toContain("\u001b[31m  ⎿ You declined this.");
      expect(app.lastFrame()).not.toContain("The user declined");
      expect(app.lastFrame()).not.toContain("run: Set-Location");
      // The model is told as before.
      expect(lead.seen[1]!.at(-1)!.parts[0]).toMatchObject({ type: "tool_result", output: `The user declined: run: ${line}`, isError: true });
      expect(ran).toEqual([]);
    });
  });

  it.each([true, false])("says an allowed command without a danger in grey under its tool line, its result after (full screen: %s)", async (full) => {
    await inColour(async () => {
      const { ran, executor } = noShell();
      const { app } = await mount([callTool("c1", "shell", { command: "git status" }), reply("looked")], { full, executor });
      await type(app, "look");
      await until(app, "Allow run: git status?");
      await press(app, "y");
      await until(app, "looked");
      expect(from(app, full, "● shell git status").slice(0, 3)).toEqual(["● shell git status", "  ⎿ You allowed this.", "  ⎿ ok"]);
      expect(app.lastFrame()).toContain("\u001b[90m  ⎿ You allowed this.");
      expect(app.lastFrame()).not.toContain("run: git status");
      expect(ran).toEqual(["git status"]);
    });
  });

  it("says an allowed command's danger, red, under its tool line, its result after", async () => {
    await inColour(async () => {
      const { ran, executor } = noShell();
      const { app } = await mount([callTool("c1", "shell", { command: "git push --force" }), reply("pushed")], { executor });
      await type(app, "push");
      await until(app, "Allow run: git push --force?");
      await press(app, "y");
      await until(app, "pushed");
      expect(from(app, false, "● shell git push --force").slice(0, 3)).toEqual([
        "● shell git push --force",
        "  ⎿ You allowed this. Danger: rewriting or deleting git history: git push --force",
        "  ⎿ ok",
      ]);
      expect(app.lastFrame()).toContain("\u001b[31m  ⎿ You allowed this. Danger:");
      expect(ran).toEqual(["git push --force"]);
    });
  });

  it.each([true, false])("says a question cancelled with Ctrl-C under its tool line, without its result row (full screen: %s)", async (full) => {
    const { ran, executor } = noShell();
    const lead = new FakeProvider("a", [callTool("c1", "shell", { command: "git status" }), reply("never sent")]);
    const { app, session } = await mount([], { lead, full, executor });
    await type(app, "look");
    await until(app, "Allow run: git status?");
    await press(app, "\u0003");
    await gone(app, "Esc to stop");
    const r = from(app, full, "● shell git status");
    expect(r.slice(0, 2)).toEqual(["● shell git status", "  ⎿ You cancelled this."]);
    expect(r[2] ?? "").not.toContain("⎿"); // no result row of its own, short or whole
    expect(app.lastFrame()).not.toContain("The user declined");
    expect(session.messages.at(-1)!.parts[0]).toMatchObject({ output: "The user declined: run: git status" });
    expect(ran).toEqual([]);
  });

  it("names a subagent's question in its answer, as the subagent's tool line is not in the conversation", async () => {
    await inColour(async () => {
      const { app, ask } = await mount([]);
      const t2 = asker("t2 (tidy up)");
      const red = "Danger: rewriting or deleting git history: git push --force";
      const answer = ask("run: git push --force", undefined, t2.owner, undefined, [red]);
      await until(app, "Allow t2 (tidy up) to run: git push --force?");
      await press(app, "n");
      expect(await answer).toBe(false);
      const said = `t2 (tidy up) to run: git push --force: You declined this. ${red}`;
      expect(from(app, false, "t2 (tidy up) to run:").slice(0, 2).join(" ").replace(/\s+/g, " ")).toBe(said); // wrapped at a space
      expect(app.lastFrame()).toContain("\u001b[31mt2 (tidy up) to run: git push --force: You declined this.");
    });
  });

  it.each([true, false])("names a write in its answer, as its preview comes between, and keeps a short result row (full screen: %s)", async (full) => {
    const lead = new FakeProvider("a", [callTool("c1", "write_file", { path: "a.txt", content: "x" }), reply("carried on")]);
    const { app, ctx } = await mount([], { lead, full });
    await type(app, "make a file");
    const target = path.join(ctx.root, "a.txt");
    await until(app, `Allow write ${target}?`);
    await press(app, "n");
    await until(app, "carried on");
    const r = from(app, full, "● write_file a.txt");
    expect(r.slice(0, 5)).toEqual(["● write_file a.txt", `┌ write ${target} (1 line)`, "x", `write ${target}: You declined this.`, "  ⎿ You declined this."]);
    expect(app.lastFrame()).not.toContain("The user declined");
    expect(lead.seen[1]!.at(-1)!.parts[0]).toMatchObject({ output: `The user declined: write ${target}` });
    expect(existsSync(target)).toBe(false);
  });

  it("names each of a reply's calls in its answer when another's line comes between", async () => {
    const { ran, executor } = noShell();
    const parts = [...callTool("c1", "shell", { command: "git status" }).parts, ...callTool("c2", "shell", { command: "git log" }).parts];
    const { app } = await mount([{ parts, usage }, reply("done")], { executor });
    await type(app, "look");
    await until(app, "Allow run: git status?");
    await press(app, "y");
    await until(app, "Allow run: git log?");
    await press(app, "n");
    await until(app, "done");
    expect(from(app, false, "● shell git status").slice(0, 6)).toEqual([
      "● shell git status",
      "● shell git log",
      "run: git status: You allowed this.",
      "run: git log: You declined this.",
      "  ⎿ ok",
      "  ⎿ You declined this.", // in call order, so the ok above is not read as git log's (choice 67)
    ]);
    expect(ran).toEqual(["git status"]);
  });

  // A call that asks nothing prints nothing, so a reply's last tool line is not under its question's answer when an
  // earlier call of the reply came first: the answer names its call, and each result keeps its place (choice 67).
  it("names a reply's last call in its answer when an earlier call asked nothing", async () => {
    const { ran, executor } = noShell();
    const parts = [...callTool("c1", "read_file", { path: "a.txt" }).parts, ...callTool("c2", "shell", { command: "git push --force" }).parts];
    const { app, ctx } = await mount([{ parts, usage }, reply("done")], { executor });
    writeFileSync(path.join(ctx.root, "a.txt"), "a line\n");
    await type(app, "look and push");
    await until(app, "Allow run: git push --force?");
    await press(app, "n");
    await until(app, "done");
    expect(from(app, false, "● read_file a.txt").slice(0, 6)).toEqual([
      "● read_file a.txt",
      "● shell git push --force",
      "run: git push --force: You declined this. Danger: rewriting or deleting git history: git push", // wrapped
      "--force",
      "  ⎿ ok",
      "  ⎿ You declined this.",
    ]);
    expect(ran).toEqual([]);
  });

  it("names the lead's question in its answer when another's answer came first, as it waited in the line", async () => {
    const { executor } = noShell();
    const lead = new Held();
    const { app, ask } = await mount([], { lead, executor });
    await type(app, "look");
    await until(app, "> look");
    const t2 = asker("t2 (x)");
    const first = ask("read /made/up/b.txt", undefined, t2.owner);
    await until(app, "Allow t2 (x) to read /made/up/b.txt?");
    lead.answer(callTool("c1", "shell", { command: "git status" })); // its question waits behind t2's
    await until(app, "● shell git status");
    await press(app, "y");
    expect(await first).toBe(true);
    await until(app, "Allow run: git status?");
    await press(app, "n");
    await waitFor(() => lead.asked.length === 2);
    lead.answer("done");
    await until(app, "done");
    expect(from(app, false, "● shell git status").slice(0, 4)).toEqual([
      "● shell git status",
      "t2 (x) to read /made/up/b.txt: You allowed this.",
      "run: git status: You declined this.",
      "  ⎿ You declined this.",
    ]);
  });

  // An answered call's id is let go with its result, as a provider may use an id again: a later call of the same id
  // shows its result.
  it("shows the result of a later call that has a declined call's id", async () => {
    const { ran, executor } = noShell();
    const turns = [callTool("c1", "shell", { command: "git status" }), callTool("c1", "shell", { command: "git log" }), reply("done")];
    const { app } = await mount(turns, { executor });
    await type(app, "look");
    await until(app, "Allow run: git status?");
    await press(app, "n");
    await until(app, "Allow run: git log?");
    await press(app, "y");
    await until(app, "done");
    expect(from(app, false, "● shell git status").slice(0, 4)).toEqual(["● shell git status", "  ⎿ You declined this.", "● shell git log", "  ⎿ You allowed this."]);
    expect(from(app, false, "● shell git log")[2]).toBe("  ⎿ ok");
    expect(ran).toEqual(["git log"]);
  });

  it("keeps the result row of a refusal nobody was asked about: the judge's, and a mode's", async () => {
    const target = path.join(await mkdtemp(path.join(tmpdir(), "tachi-")), "a.txt");
    const judge = new FakeProvider("judge", [reply('{"allow": false, "reason": "Not this one."}')]);
    const judged = await mount([callTool("c1", "write_file", { path: target, content: "x" }), reply("carried on")], { mode: "auto", judge });
    await type(judged.app, "write it");
    await until(judged.app, "carried on");
    expect(judged.app.lastFrame()).toContain("  ⎿ The judge refused: Not this one.");
    expect(judged.app.lastFrame()).not.toContain("You declined");
    const { ran, executor } = noShell();
    const never = await mount([callTool("c1", "shell", { command: "git push --force" }), reply("carried on")], { mode: "never", executor });
    await type(never.app, "push");
    await until(never.app, "carried on");
    expect(never.app.lastFrame()).toContain("  ⎿ Not allowed: this command matches the dangerous-command check");
    expect(never.app.lastFrame()).not.toContain("You declined");
    expect(ran).toEqual([]);
  });
});

describe("App's to-do list", () => {
  const items: TodoItem[] = [
    { text: "read the login code", status: "done" },
    { text: "find where the token is saved", status: "in_progress" },
    { text: "write the fix", status: "pending" },
  ];

  it("shows the lead's list above the prompt while any item is not done", async () => {
    const { app, bus } = await mount([]);
    bus.emit("todo", items);
    await tick();
    expect(app.lastFrame()).toContain("☑ read the login code\n◐ find where the token is saved\n☐ write the fix\n›");
    bus.emit("todo", items.map((i) => ({ ...i, status: "done" as const })));
    await tick();
    expect(app.lastFrame()).not.toContain("☑");
  });

  it("hides and shows it on Ctrl+T, and shows a new list", async () => {
    const { app, bus } = await mount([]);
    bus.emit("todo", items);
    await tick();
    await press(app, "\u0014");
    expect(app.lastFrame()).not.toContain("write the fix");
    await press(app, "\u0014");
    expect(app.lastFrame()).toContain("write the fix");
    await press(app, "\u0014");
    bus.emit("todo", [...items, { text: "test it", status: "pending" }]);
    await tick();
    expect(app.lastFrame()).toContain("☐ test it");
  });

  it("sits under the working line, above the queue, and gives way before the prompt", async () => {
    const { app, bus } = await mount([], { lead: hanging(), rows: 10 });
    await type(app, "one");
    await until(app, "Esc to stop");
    bus.emit("todo", [...items, { text: "test it", status: "pending" }]);
    await press(app, "q1", "\r");
    expect(app.lastFrame()).toMatch(/Esc to stop\n☑ read the login code\n◐ find where the token is saved\n☐ write the fix\n☐ test it\nq1\n›\n/);
    await press(app, "a", "\n", "b", "\n", "c", "\n", "d"); // four rows for the prompt: two left for the list, none for the queue
    expect(app.lastFrame()).toMatch(/Esc to stop\n◐ find where the token is saved\n\+3 more\n› a\n  b\n  c\n  d\n1 queued\n/);
  });

  it("escapes what the model wrote in it", async () => {
    const { app, bus } = await mount([]);
    bus.emit("todo", [{ text: `look ${OSC52}`, status: "pending" }]);
    await tick();
    expect(app.lastFrame()).toContain(`☐ look ${OSC52_SHOWN}`);
    expectNoRawControls(app.lastFrame());
  });
});

describe("App's menus", () => {
  it("lists the commands for / at the start of an empty prompt, narrowing as the command is typed", async () => {
    const { app } = await mount([]);
    await press(app, "/");
    expect(app.lastFrame()).toContain("› /\n  /lead <provider:model>  Switch the lead model; alone, pick it from a list\n  /model  Pick the lead model from a list\n");
    expect(app.lastFrame()).toContain("↑↓ choose · Tab fill · Enter run · Esc close");
    await press(app, "e");
    expect(app.lastFrame()).toContain(
      "› /e\n  /export [file]  Write the conversation to a file as text; alone, copy it\n  /errors  Summarise the error log\n  /exit  Quit\n",
    );
    expect(app.lastFrame()).not.toContain("/model");
  });

  it("runs the chosen command on Enter, Down choosing the next", async () => {
    const { app } = await mount([]);
    await press(app, "/", "e", "x", "\u001b[B", "\r"); // /export, then /exit
    await expectExited(app);
  });

  it("puts the command in the prompt on Tab, to add to it", async () => {
    const made: string[] = [];
    const { app } = await mount([], { made });
    await press(app, "/", "l", "\t");
    expect(app.lastFrame()).toContain("› /lead\n"); // the space after it is there, though not drawn
    expect(app.lastFrame()).not.toContain("Switch the lead model");
    await press(app, "fake:b", "\r");
    await until(app, "lead is now fake:b");
    expect(made).toEqual(["fake:b"]);
  });

  it("closes on Esc until the text changes, and a message starting with a slash is sent as typed", async () => {
    const { app, session } = await mount([reply("ok")]);
    await press(app, "/", "\u001b");
    expect(app.lastFrame()).not.toContain("/model");
    expect(app.lastFrame()).toContain("› /\n");
    await press(app, "m");
    expect(app.lastFrame()).toContain("/model  Pick the lead model from a list");
    await press(app, "\u007f"); // back at the text Esc closed it at, after a change: open
    expect(app.lastFrame()).toContain("/model  Pick the lead model from a list");
    await press(app, "\u007f", "/tmp is full", "\r");
    await until(app, "ok");
    expect(sent(session)).toEqual({ type: "text", text: "/tmp is full" });
  });

  it("lists the project folder for @, goes into a folder on Tab, and completes a file's path on Enter; only the path is sent", async () => {
    const { app, session, ctx } = await mount([reply("ok")]);
    await mkdir(path.join(ctx.root, "src"));
    await writeFile(path.join(ctx.root, "src", "x.ts"), "secret");
    await writeFile(path.join(ctx.root, "a.txt"), "");
    await press(app, "read @");
    expect(app.lastFrame()).toContain("› read @\n  src/\n  a.txt\n↑↓ choose · Tab or Enter fill · Esc close");
    await press(app, "s", "\t");
    expect(app.lastFrame()).toContain("› read @src/\n  src/x.ts\n");
    await press(app, "\r");
    expect(app.lastFrame()).toContain("› read @src/x.ts\n");
    await press(app, "\r");
    await until(app, "ok");
    expect(sent(session)).toEqual({ type: "text", text: "read @src/x.ts" });
  });

  it("says in the menu why a folder cannot be listed", async () => {
    const { app } = await mount([]);
    await press(app, "@nope/");
    expect(app.lastFrame()).toMatch(/› @nope\/\n {2}Cannot list nope\/: ENOENT/);
  });

  it("cuts the prompt to the cursor's row while a menu is open, and fits the menu in the rows left", async () => {
    const { app, ctx } = await mount([], { rows: 8 });
    for (const name of ["a1", "a2", "a3", "a4", "a5", "a6"]) await writeFile(path.join(ctx.root, name), "");
    await press(app, "one", "\n", "two", "\n", "@a");
    // Seven rows: the prompt's cursor row, four for the menu, the hint line and the status line.
    expect(app.lastFrame()).toMatch(/^› @a\n {2}a1\n {2}a2\n {2}a3\n {2}↓ 3 more\n↑↓ choose[^\n]*\n[^\n]*$/);
    await press(app, "\u001b[B", "\u001b[B", "\u001b[B");
    expect(app.lastFrame()).toMatch(/^› @a\n {2}↑ 2 more\n {2}a3\n {2}a4\n {2}↓ 2 more\n/);
  });
});

describe("App's keys for the modes, the model list and the last turn", () => {
  it("prints the key list, grey, on ? at an empty prompt; with a space first, ? is typed", async () => {
    const { app } = await mount([]);
    await press(app, "?");
    expect(app.lastFrame()).toContain("Keys:\n");
    expect(app.lastFrame()).toContain("Shift+Enter, \\ then Enter, or Ctrl+J  new line");
    expect(app.lastFrame()).toContain("Ctrl+O  the last turn's tool calls in full");
    expect(app.lastFrame()).toContain("Ctrl+T  show or hide the to-do list");
    expect(app.lastFrame()).toContain("  Ctrl+G or Ctrl+X Ctrl+E  open the prompt in your editor");
    expect(app.lastFrame()).toContain("  Ctrl+S  stash the prompt or bring it back · ");
    // Keys that work in Windows Terminal, where Ctrl+Backspace is Backspace and Ctrl+_ cannot be typed.
    expect(app.lastFrame()).toContain("Alt+Backspace  the word before");
    expect(app.lastFrame()).toContain("Ctrl+Z  undo");
    expect(app.lastFrame()).not.toContain("Ctrl+Backspace");
    expect(app.lastFrame()).toContain("\n›\n"); // the prompt stays empty
    await press(app, " ?");
    expect(app.lastFrame()).toContain("›  ?\n");
  });

  it("cycles ask, project and auto on Shift+Tab, saying so, and the check uses the new mode from the next action", async () => {
    const write = (id: string, file: string) => callTool(id, "write_file", { path: file, content: "x" });
    const { app, ctx } = await mount([write("c1", "a.txt"), reply("written"), write("c2", "b.txt"), reply("written again")]);
    await press(app, "\u001b[Z");
    expect(app.lastFrame()).toContain("mode is now project");
    expect(app.lastFrame()).toContain("perm project");
    await type(app, "go");
    await until(app, "written"); // not asked: project mode allows writes inside the project
    expect(existsSync(path.join(ctx.root, "a.txt"))).toBe(true);
    await press(app, "\u001b[Z");
    expect(app.lastFrame()).toContain("mode is now auto");
    expect(app.lastFrame()).toContain("perm auto");
    // Auto writes a file in the project without asking, as project does (release 7 plan, Task 10).
    await type(app, "again");
    await until(app, "written again");
    expect(existsSync(path.join(ctx.root, "b.txt"))).toBe(true);
    await press(app, "\u001b[Z");
    expect(app.lastFrame()).toContain("mode is now ask");
    expect(app.lastFrame()).toContain("perm ask");
    expect(app.lastFrame()).not.toContain("mode is now never");
  });

  // Release 7 plan, Task 10: the judge's answer counts only under the mode it was asked under. Shift+Tab while it is out
  // takes the session to ask, so the write asks, though the judge said yes.
  it("asks when Shift+Tab changes the mode while the judge is out, whatever it answers", async () => {
    const judge = new Held("fake:judge");
    const target = path.join(await mkdtemp(path.join(tmpdir(), "tachi-")), "a.txt");
    const { app } = await mount([callTool("c1", "write_file", { path: target, content: "x" }), reply("carried on")], { mode: "auto", judge });
    await type(app, "write it");
    await waitFor(() => judge.asked.length === 1);
    await press(app, "\u001b[Z");
    expect(app.lastFrame()).toContain("mode is now ask");
    judge.answer('{"allow": true}');
    await until(app, `Allow write ${target}?`);
    await press(app, "n");
    await until(app, "carried on");
    expect(existsSync(target)).toBe(false);
  });

  // Release 7 plan, Task 10: with no judge set, the lead judges, the one leading at each action (release 7 design, "The
  // modes": "Unset, the lead's own model judges, through the login already in use"), so a /lead switch moves the judge.
  it("judges with the lead leading at each action when no judge is set, so /lead moves the judge too", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "tachi-"));
    const write = (id: string, n: string) => callTool(id, "write_file", { path: path.join(folder, `${n}.txt`), content: n });
    const allow = reply('{"allow": true}');
    const a = new FakeProvider("a", [write("c1", "a"), allow, reply("first done")]);
    const b = new FakeProvider("b", [write("c2", "b"), allow, reply("second done")]);
    const { app } = await mount([], { lead: a, newLead: b, mode: "auto" });
    await type(app, "write a");
    await until(app, "first done");
    await type(app, "/lead fake:b");
    await until(app, "lead is now fake:b");
    await type(app, "write b");
    await until(app, "second done");
    // A judge's request is its one message of labelled blocks (safety/judge.ts, request).
    const judged = (p: FakeProvider) => p.seen.filter((m) => m.length === 1 && JSON.stringify(m[0]).includes("The user's own messages")).length;
    expect([judged(a), judged(b)]).toEqual([1, 1]);
    expect(["a", "b"].map((n) => existsSync(path.join(folder, `${n}.txt`)))).toEqual([true, true]);
  });

  // A judge that --judge or the settings file set stays the judge for the session, whoever leads (Task 10).
  it("keeps a set judge after /lead", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "tachi-"));
    const write = (id: string, n: string) => callTool(id, "write_file", { path: path.join(folder, `${n}.txt`), content: n });
    const judge = new FakeProvider("judge", [reply('{"allow": true}'), reply('{"allow": true}')]);
    const a = new FakeProvider("a", [write("c1", "a"), reply("first done")]);
    const b = new FakeProvider("b", [write("c2", "b"), reply("second done")]);
    const { app } = await mount([], { lead: a, newLead: b, mode: "auto", judge });
    await type(app, "write a");
    await until(app, "first done");
    await type(app, "/lead fake:b");
    await until(app, "lead is now fake:b");
    await type(app, "write b");
    await until(app, "second done");
    expect(judge.seen).toHaveLength(2);
    expect([a.seen.length, b.seen.length]).toEqual([2, 2]); // each lead's own two requests, and no judge's
    expect(["a", "b"].map((n) => existsSync(path.join(folder, `${n}.txt`)))).toEqual([true, true]);
  });

  it("takes never into the cycle only when the session started in it", async () => {
    const { app } = await mount([], { mode: "never" });
    await press(app, "\u001b[Z", "\u001b[Z", "\u001b[Z", "\u001b[Z");
    expect(app.lastFrame()).toContain("mode is now ask\nmode is now project\nmode is now auto\nmode is now never\n");
  });

  it("does nothing on Shift+Tab while a question is showing", async () => {
    const { app } = await mount([callTool("c1", "write_file", { path: "a.txt", content: "x" }), reply("written")]);
    await type(app, "go");
    await until(app, "Allow");
    await press(app, "\u001b[Z");
    expect(app.lastFrame()).not.toContain("mode is now");
    expect(app.lastFrame()).toContain("perm ask");
    await press(app, "n");
    await until(app, "written");
  });

  it("opens the model list on Alt+P, keeping what was typed", async () => {
    const { app } = await mount([], { models: [{ provider: "fake", models: ["a", "b"] }] });
    await press(app, "draft", "\u001bp");
    await until(app, "fake:b");
    await tick(); // the picker starts reading keys just after it first appears
    await press(app, "\u001b");
    await until(app, "› draft");
  });

  it("queues the model list on Alt+P during a turn, as /model typed then", async () => {
    const { app } = await mount([], { lead: hanging(), models: [{ provider: "fake", models: ["a", "b"] }] });
    await type(app, "hi");
    await until(app, "Esc to stop");
    await press(app, "\u001bp");
    expect(app.lastFrame()).toContain("/model\n");
    await press(app, "\u001b"); // stops the turn; the queue goes on
    await until(app, "fake:b");
  });

  it("prints the last turn's tool calls on Ctrl+O, and before any turn says there is none", async () => {
    const { app, ctx } = await mount([callTool("c1", "read_file", { path: "a.txt" }), reply("done")]);
    await press(app, "\u000f");
    expect(app.lastFrame()).toContain("No turn yet, so no tool calls to show.");
    await writeFile(path.join(ctx.root, "a.txt"), "hello there");
    await type(app, "go");
    await until(app, "done");
    await press(app, "\u000f");
    expect(app.lastFrame()).toContain('Last turn: 1 tool call\n● read_file {\n  "path": "a.txt"\n}\n  ⎿ ');
    expect(app.lastFrame()).toMatch(/⎿ [^\n]*hello there/);
  });
});

describe("App's working line and tool lines", () => {
  it("shows what is running, for how long, and the turn's tokens and cost, the spinner moving", async () => {
    const { app } = await mount([], { lead: hanging() });
    await type(app, "hi");
    await until(app, "Esc to stop");
    expect(app.lastFrame()).toMatch(/\n. Working · 0s · ↓ 0 tokens · \$0\.00 · Esc to stop\n/);
    const spinners = new Set<string>();
    for (let i = 0; i < 6; i++, await tick()) spinners.add(/\n(.) Working/.exec(app.lastFrame()!)![1]!);
    expect(spinners.size).toBeGreaterThan(1); // 300 ms: a few of its 80 ms steps
    await until(app, " Working · 1s · ");
  });

  it("names what it waits for: the browser for /login, signing out for /logout, the model lists for /model", async () => {
    const login: Login = (_verb, _words, _say, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
    const { app } = await mount([], { login, slow: true });
    await type(app, "/login chatgpt");
    await until(app, "Waiting for the browser");
    expect(app.lastFrame()).toMatch(/Waiting for the browser · \d+s · Esc to stop/);
    await press(app, "\u001b");
    await gone(app, "Esc to stop");
    await type(app, "/logout chatgpt");
    await until(app, "Signing out");
    expect(app.lastFrame()).toMatch(/Signing out · \d+s · Esc to stop/);
    await press(app, "\u001b");
    await gone(app, "Esc to stop");
    await type(app, "/model");
    await until(app, "Reading the model lists");
    expect(app.lastFrame()).toMatch(/Reading the model lists · \d+s · Esc to stop/);
  });

  it("shows a call's main detail, and counts the turn's calls under the status line until the next turn starts", async () => {
    const { app, ctx } = await mount([callTool("c1", "read_file", { path: "a.txt" }), callTool("c2", "read_file", { path: "a.txt" }), reply("done"), reply("again")]);
    await writeFile(path.join(ctx.root, "a.txt"), "x");
    await type(app, "go");
    await until(app, "done");
    expect(app.lastFrame()).toContain("● read_file a.txt\n");
    expect(app.lastFrame()).toMatch(/⏱[^\n]*\n✓ read_file ×2$/);
    await type(app, "more");
    await until(app, "again");
    expect(app.lastFrame()).not.toContain("✓ read_file");
  });

  it("shows the running call with its target, and a declined one under ⊘", async () => {
    const { app } = await mount([callTool("c1", "write_file", { path: "a.txt", content: "x" }), reply("written")]);
    await type(app, "go");
    await until(app, "Allow");
    expect(app.lastFrame()).toMatch(/\n◐ write_file a\.txt$/);
    await press(app, "n");
    await until(app, "written");
    expect(app.lastFrame()).toMatch(/\n⊘ write_file ×1$/);
  });

  it("has no tool line when --status leaves tools out", async () => {
    const { app, ctx } = await mount([callTool("c1", "read_file", { path: "a.txt" }), reply("done")], { segments: SEGMENTS.filter((s) => s !== "tools") });
    await writeFile(path.join(ctx.root, "a.txt"), "x");
    await type(app, "go");
    await until(app, "done");
    expect(app.lastFrame()).not.toContain("✓ read_file");
  });

  it("hides the tool line while the model list is open, which fills the rows above the status line", async () => {
    const { app, ctx } = await mount([callTool("c1", "read_file", { path: "a.txt" }), reply("done")], { rows: 8, models: [{ provider: "fake", models: ["a", "b", "c", "d", "e", "f"] }] });
    await writeFile(path.join(ctx.root, "a.txt"), "x");
    await type(app, "go");
    await until(app, "done");
    expect(app.lastFrame()).toContain("✓ read_file ×1");
    await type(app, "/model");
    await until(app, "fake:a");
    expect(app.lastFrame()).not.toContain("✓ read_file");
    await tick(); // the picker starts reading keys just after it first appears
    await press(app, "\u001b");
    await until(app, "✓ read_file ×1");
  });

  it("drops the tool line first when the terminal is too short", async () => {
    for (const [rows, shown] of [[4, false], [5, true]] as const) {
      const { app, ctx } = await mount([callTool("c1", "read_file", { path: "a.txt" }), reply("done")], { rows });
      await writeFile(path.join(ctx.root, "a.txt"), "x");
      await type(app, "go");
      await until(app, "done");
      expect(app.lastFrame()!.includes("✓ read_file ×1")).toBe(shown);
      expect(app.lastFrame()).toContain("? for shortcuts");
    }
  });
});

// The scroll keys as the terminal sends them (release 5 plan, "Before you start").
const PG_UP = "\u001b[5~";
const PG_DOWN = "\u001b[6~";
const CTRL_HOME = "\u001b[1;5H";
const CTRL_END = "\u001b[1;5F";
const SHIFT_UP = "\u001b[1;2A";
const SHIFT_DOWN = "\u001b[1;2B";

// `n` lines for the start, "said 0." and on: the full stop keeps "said 1." from matching "said 10.".
const said = (n: number, text = (i: number) => `said ${i}.`) => Array.from({ length: n }, (_, i) => ({ text: text(i) }));
// Each row of the frame, without the scroll bar's column (the last of ink-testing-library's 100) and the spaces before it.
const shown = (app: ReturnType<typeof render>, columns = 100) => app.lastFrame()!.split("\n").map((r) => r.slice(0, columns - 1).trimEnd());

describe("App in full screen", () => {
  it("draws the conversation at the top and the status line at the bottom, in a frame a row shorter than the terminal", async () => {
    const { app } = await mount([reply("hello there")], { full: true, intro: [{ text: "Instructions: CLAUDE.md (12 bytes)", color: "gray" }] });
    await type(app, "hi");
    await until(app, "hello there");
    const rows = shown(app);
    expect(rows).toHaveLength(23); // 24 rows: Ink clears the whole terminal for a frame as tall as it
    expect(rows.slice(0, 4)).toEqual(["Instructions: CLAUDE.md (12 bytes)", "> hi", "hello there", ""]);
    expect(rows.at(-1)).toContain("lead fake:a");
  });

  it("shows the newest lines, earlier ones on PgUp, holds the view while a reply arrives, and goes back to the newest on Ctrl+End", async () => {
    const lead = new Held();
    const { app } = await mount([], { full: true, lead, intro: said(60) });
    // 20 rows of conversation: 23 less the prompt, the hint and the status line.
    expect(shown(app).slice(0, 20)).toEqual(said(60).slice(40).map((l) => l.text));
    await press(app, PG_UP); // half of 20
    expect(shown(app)[0]).toBe("said 30.");
    expect(shown(app)[19]).toBe("said 49.");
    await type(app, "hi"); // sending goes to the bottom
    await until(app, "> hi");
    expect(shown(app)[19]).toBe("> hi"); // the working line takes the hint's row
    await press(app, PG_UP); // from row 41 of 61
    expect(shown(app)[0]).toBe("said 31.");
    lead.answer("a\nb");
    await until(app, "↓ 2 new lines · Ctrl+End");
    await gone(app, "Esc to stop");
    expect(shown(app)[0]).toBe("said 31.");
    expect(app.lastFrame()).not.toContain("> hi");
    await press(app, CTRL_END);
    expect(shown(app).slice(17, 20)).toEqual(["> hi", "a", "b"]);
    expect(app.lastFrame()).not.toContain("new lines");
  });

  it("puts the terminal's cursor in the prompt, counting the conversation's rows above it", async () => {
    // Ink's own drawing to a stand-in terminal, as in prompt.test.tsx: ink-testing-library's leaves the cursor out.
    const terminal = Object.assign(new EventEmitter(), { isTTY: true, columns: 100, rows: 24, out: "" });
    const stdout = Object.assign(terminal, { write: (s: string) => ((terminal.out += s), true) });
    const keyboard = Object.assign(new EventEmitter(), {
      isTTY: true,
      setRawMode() {},
      setEncoding() {},
      resume() {},
      pause() {},
      ref() {},
      unref() {},
      read: () => null,
    });
    const bus = new Bus();
    const ctx = await tempContext();
    const tasks = new Tasks({ bus, max: 8, worker: () => new FakeProvider("w", []), system: "sub", tools: SUBAGENT_TOOLS, ctx });
    const session = new Session({ lead: new FakeProvider("a", []), tools: TOOLS, system: "t", ctx, bus });
    const screen = new Screen(
      () => {},
      () => {},
    );
    screen.enter();
    const app = renderInk(
      <App
        session={session}
        tasks={tasks}
        bus={bus}
        stats={new Stats(bus)}
        mode="ask"
        saved={unsaved()}
        onMode={() => {}}
        onRules={() => {}}
        project="proj"
        root={ctx.root}
        workspace={ctx.workspace}
        branch={null}
        historyFile={path.join(histories, `${nextHistory++}.jsonl`)}
        intro={said(60)}
        errorFile={path.join(ctx.root, "errors.jsonl")}
        segments={SEGMENTS}
        makeProvider={() => new FakeProvider("b", [])}
        login={async () => {}}
        listModels={async () => []}
        bindAsk={() => {}}
        screen={screen}
        fullPossible
        scrollSpeed={3}
        clipboard={(report) => new Clipboard(() => {}, null, report)}
        readPicture={() => new Promise(() => {})} // never answers: no test reads the user's clipboard
        home={sharedHome}
      />,
      { stdout: stdout as never, stdin: keyboard as never, debug: false, patchConsole: false, exitOnCtrlC: false, interactive: true },
    );
    try {
      await tick();
      // The prompt's row is under 20 of conversation, in a frame of 23: up 3 from the frame's foot, then to after "› ".
      expect(terminal.out).toContain("\u001b[3A\u001b[3G\u001b[?25h");
    } finally {
      app.unmount();
    }
  });

  it("moves a row on Shift+Up and Shift+Down, goes to the top on Ctrl+Home, and stays at the bottom on PgDn", async () => {
    const { app } = await mount([], { full: true, intro: said(60) });
    await press(app, PG_DOWN);
    expect(shown(app)[0]).toBe("said 40.");
    await press(app, SHIFT_UP);
    expect(shown(app)[0]).toBe("said 39.");
    await press(app, SHIFT_DOWN);
    expect(shown(app)[0]).toBe("said 40.");
    await press(app, CTRL_HOME);
    expect(shown(app)[0]).toBe("said 0.");
  });

  it("wraps the lines again on a resize, keeping the line at the view's top at its top", async () => {
    const long = (i: number) => `said ${i}. ${"word ".repeat(14).trimEnd()}`; // under 80 columns: one row at 99, two at 59
    const { app } = await mount([], { full: true, intro: said(60, long) });
    await press(app, PG_UP);
    expect(shown(app)[0]).toBe(long(30));
    Object.defineProperty(app.stdout, "columns", { value: 60, configurable: true });
    app.stdout.emit("resize");
    await tick();
    const rows = shown(app, 60);
    expect(rows[0]).toMatch(/^said 30\. word/);
    expect(rows[1]).toMatch(/^word/);
    expect(rows[2]).toMatch(/^said 31\. word/);
    expect(rows).toHaveLength(23);
  });

  // Release 7 plan, choice 120 (the user's hand check): a tall prompt draws at most half the rows, twelve of 24.
  it("leaves the conversation the rows a tall prompt's half leaves, and the frame a row short of the terminal", async () => {
    const { app } = await mount([], { full: true, intro: said(60) });
    await press(app, Array.from({ length: 20 }, (_, i) => `p${i}`).join("\n")); // Ctrl+J between them
    const rows = shown(app);
    expect(rows).toHaveLength(23);
    expect(rows[0]).toBe("said 51.");
    expect(rows[8]).toBe("said 59.");
    expect(rows[9]).toBe("› ↑ 9 rows above");
    expect(rows[20]).toBe("  p19");
  });

  it("scrolls with PgUp while a question waits, and still answers it with y", async () => {
    const { app, ctx } = await mount([callTool("c1", "write_file", { path: "a.txt", content: "x" }), reply("written")], { full: true, intro: said(60) });
    await type(app, "make a file");
    await until(app, "[y/n]");
    expect(shown(app)).toHaveLength(23);
    const before = shown(app)[0]!;
    await press(app, PG_UP);
    const after = shown(app)[0]!;
    expect(after).toMatch(/^said \d+\.$/);
    expect(Number(after.slice(5, -1))).toBeLessThan(Number(before.slice(5, -1)));
    await press(app, "y");
    await gone(app, "[y/n]");
    await waitFor(() => existsSync(path.join(ctx.root, "a.txt")));
    await press(app, CTRL_END);
    await until(app, "written");
  });

  it("goes to the bottom, following, when a queued prompt starts", async () => {
    const lead = new Held();
    const { app } = await mount([], { full: true, lead, intro: said(60) });
    await type(app, "go");
    await type(app, "next"); // queued: a turn is running
    await until(app, "↑ to edit queued messages");
    await press(app, PG_UP);
    expect(app.lastFrame()).not.toContain("> go");
    lead.answer("first reply");
    await until(app, "> next");
    expect(app.lastFrame()).toContain("first reply");
    expect(app.lastFrame()).not.toContain("new lines");
    lead.answer("second reply"); // following: it shows as it comes
    await until(app, "second reply");
  });

  // What the user asks to see brings the view to the bottom (the user's choice, 2026-10-27, at Task 5's review). Ctrl+O
  // opens the detail view instead (Task 12).
  it.each([
    { name: "? (the key list)", key: "?", shows: "Ctrl+T  show or hide the to-do list" },
    { name: "Shift+Tab (the mode)", key: "\u001b[Z", shows: "mode is now project" },
    { name: "Alt+P (the model list, with what reading the login says)", key: "\u001bp", shows: "a note on the login" },
  ])("goes to the bottom, following, on $name", async ({ key, shows }) => {
    const { app } = await mount([], { full: true, intro: said(60), note: "a note on the login", models: [{ provider: "fake", models: ["a"] }] });
    await press(app, PG_UP);
    expect(shown(app)[0]).toBe("said 30.");
    await press(app, key);
    await until(app, shows);
    expect(app.lastFrame()).not.toContain("new lines");
  });

  it("scrolls with the scroll keys during Ctrl+R's search, leaving the search open as it was", async () => {
    const { app } = await mount([], { full: true, intro: said(60), past: ["about"] });
    await press(app, "\u0012", "ab");
    await until(app, "search: ab ·");
    expect(shown(app)[0]).toBe("said 40.");
    await press(app, PG_UP);
    expect(shown(app)[0]).toBe("said 30.");
    await press(app, SHIFT_DOWN, CTRL_HOME);
    expect(shown(app)[0]).toBe("said 0.");
    expect(app.lastFrame()).toContain("search: ab ·");
    expect(app.lastFrame()).toContain("› about");
  });

  // The live area's rows are counted by hand (layout.ts, frame's `live`): a count off by one would make the frame as
  // tall as the terminal, which Ink clears whole before drawing (release 5 plan, "Before you start").
  const bg = (id: string, task: string) => callTool(id, "delegate", { description: task, task, background: true });
  it.each([
    { name: "the / menu open", turns: [], last: "lead fake:a", setup: async (app: ReturnType<typeof render>) => press(app, "/") },
    { name: "Ctrl-D pressed once", turns: [], last: "lead fake:a", setup: async (app: ReturnType<typeof render>) => press(app, "\u0004") },
    { name: "Ctrl+R's search", turns: [], last: "lead fake:a", setup: async (app: ReturnType<typeof render>) => press(app, "\u0012") },
    {
      name: "a question, with the tool line under the status line",
      turns: [callTool("c1", "write_file", { path: "a.txt", content: "x" })],
      last: "write_file",
      setup: async (app: ReturnType<typeof render>) => {
        await type(app, "make a file");
        await until(app, "[y/n]");
      },
    },
    {
      name: "the subagent panel, and the tool line for its delegate call",
      turns: [bg("c1", "find x"), reply("started it")],
      last: "delegate",
      setup: async (app: ReturnType<typeof render>) => {
        await type(app, "go");
        await until(app, "started it");
        expect(app.lastFrame()).toContain("◐ t1 find x");
      },
    },
  ])("keeps the frame a row short of the terminal, the status line at its foot, with $name", async ({ turns, last, setup }) => {
    const { app } = await mount(turns, { full: true, intro: said(60), worker: new Held("fake:w") });
    await setup(app);
    await tick();
    const rows = shown(app);
    expect(rows).toHaveLength(23);
    expect(rows.at(-1)).toContain(last);
    if (last !== "lead fake:a") expect(rows.at(-2)).toContain("lead fake:a");
  });

  it("keeps the frame a row short of the terminal, the status line at its foot, while busy with to-dos and a queue", async () => {
    const { app, bus } = await mount([], { full: true, intro: said(60), lead: hanging() });
    await type(app, "go");
    bus.emit("todo", [
      { text: "one", status: "in_progress" },
      { text: "two", status: "pending" },
    ]);
    for (const text of ["q1", "q2", "q3"]) await type(app, text);
    await until(app, "Esc to stop");
    const rows = shown(app);
    expect(rows).toHaveLength(23);
    expect(rows.slice(-9)).toEqual([
      expect.stringContaining("Esc to stop"),
      "◐ one",
      "☐ two",
      "q1",
      "q2",
      "q3",
      "›",
      "↑ to edit queued messages",
      expect.stringContaining("lead fake:hang"),
    ]);
  });

  it("gives the model list the rows it needs and the conversation the rest, the status line staying at the bottom as the list is filtered", async () => {
    const { app } = await mount([], { full: true, intro: said(60), models: [{ provider: "fake", models: ["a", "b", "c"] }] });
    await type(app, "/model");
    await until(app, "fake:a");
    await tick(); // the picker starts reading keys just after it first appears
    // The heading and three models, the filter line and the status line: 17 rows of conversation.
    let rows = shown(app);
    expect(rows).toHaveLength(23);
    expect(rows.slice(16, 18)).toEqual(["said 59.", "fake"]);
    await press(app, "c");
    rows = shown(app);
    expect(rows).toHaveLength(23);
    expect(rows[16]).toBe("said 59.");
    expect(rows.slice(19)).toEqual(["fake", "  fake:c", "Filter: c · ↑↓ move · Enter picks · Esc closes", rows[22]]);
    expect(rows[22]).toContain("lead fake:a");
  });
});

// The mouse as the InputFilter reports it (src/tui/input.ts): 0-based cells. The scroll bar is the last of
// ink-testing-library's 100 columns.
const BAR = 99;
const at = (kind: Mouse["kind"], x: number, y: number, more: Partial<Mouse> = {}): Mouse => ({
  kind,
  button: "left",
  x,
  y,
  shift: false,
  alt: false,
  ctrl: false,
  ...more,
});
async function wheel(mouse: EventEmitter, dir: "up" | "down", notches = 1) {
  for (let i = 0; i < notches; i++) mouse.emit("mouse", at("wheel", 10, 5, { button: "none", wheel: dir }));
  await tick();
}
async function pointer(mouse: EventEmitter, ...events: Mouse[]) {
  for (const m of events) mouse.emit("mouse", m);
  await tick();
}
// The frame's rows that show the scroll bar's thumb.
const thumb = (app: ReturnType<typeof render>) =>
  app
    .lastFrame()!
    .split("\n")
    .flatMap((r, i) => ([...r][BAR] === "┃" ? [i] : []));

describe("App's wheel and scroll bar in full screen", () => {
  // 80 lines in 20 rows of conversation: the newest 20 show, said 60. to said 79.
  it("scrolls 3 rows a notch of the wheel, wherever the pointer is", async () => {
    const { app, mouse } = await mount([], { full: true, intro: said(80) });
    expect(shown(app)[0]).toBe("said 60.");
    await wheel(mouse, "up");
    expect(shown(app)[0]).toBe("said 57.");
    await wheel(mouse, "up", 2);
    expect(shown(app)[0]).toBe("said 51.");
    await wheel(mouse, "down");
    expect(shown(app)[0]).toBe("said 54.");
  });

  it("moves one row every second notch at a speed of 0.5", async () => {
    const { app, mouse } = await mount([], { full: true, intro: said(80), scrollSpeed: 0.5 });
    const tops = [];
    for (let i = 0; i < 4; i++) {
      await wheel(mouse, "up");
      tops.push(shown(app)[0]);
    }
    expect(tops).toEqual(["said 60.", "said 59.", "said 59.", "said 58."]);
  });

  it("follows again once the wheel reaches the bottom, so a new reply shows at once", async () => {
    const lead = new Held();
    const { app, mouse } = await mount([], { full: true, lead, intro: said(80) });
    await type(app, "go");
    await until(app, "> go");
    await wheel(mouse, "up", 2);
    expect(app.lastFrame()).not.toContain("> go");
    await wheel(mouse, "down", 5); // past the bottom
    expect(app.lastFrame()).toContain("> go");
    lead.answer("fresh");
    await until(app, "fresh");
    expect(app.lastFrame()).not.toContain("new lines");
  });

  it("goes to the first lines on a click on the bar's track near its top", async () => {
    const { app, mouse } = await mount([], { full: true, intro: said(80) });
    expect(thumb(app)).toEqual([15, 16, 17, 18, 19]); // 20 rows of 80 seen: a thumb of 5 rows, at the foot
    await pointer(mouse, at("press", BAR, 1), at("release", BAR, 1));
    expect(shown(app)[0]).toBe("said 0.");
    expect(thumb(app)).toEqual([0, 1, 2, 3, 4]);
  });

  it("centres the thumb on the row of the track clicked", async () => {
    const { app, mouse } = await mount([], { full: true, intro: said(80) });
    await pointer(mouse, at("press", BAR, 8), at("release", BAR, 8));
    expect(thumb(app)).toEqual([6, 7, 8, 9, 10]);
    expect(shown(app)[0]).toBe("said 24."); // the thumb at 6 of its 15 rows of travel: 6 * 60 / 15
  });

  it("moves the thumb with the pointer while it is dragged, keeping where on it it was pressed, until the button is let go", async () => {
    const { app, mouse } = await mount([], { full: true, intro: said(80) });
    await press(app, CTRL_HOME);
    expect(thumb(app)).toEqual([0, 1, 2, 3, 4]);
    await pointer(mouse, at("press", BAR, 1), at("drag", BAR, 8));
    expect(thumb(app)).toEqual([7, 8, 9, 10, 11]);
    expect(shown(app)[0]).toBe("said 28.");
    await pointer(mouse, at("drag", 40, 30)); // below the conversation, and off the bar: the thumb at its foot
    expect(shown(app)[19]).toBe("said 79.");
    await pointer(mouse, at("release", 40, 30), at("drag", BAR, 2));
    expect(shown(app)[19]).toBe("said 79.");
  });

  it("follows again when the thumb is dragged to the bottom, so a new reply shows at once", async () => {
    const lead = new Held();
    const { app, mouse } = await mount([], { full: true, lead, intro: said(80) });
    await type(app, "go");
    await until(app, "> go");
    await press(app, CTRL_HOME);
    await pointer(mouse, at("press", BAR, 0), at("drag", BAR, 19), at("release", BAR, 19));
    expect(shown(app)[19]).toBe("> go");
    lead.answer("fresh");
    await until(app, "fresh");
    expect(app.lastFrame()).not.toContain("new lines");
  });

  it("moves the thumb as PgUp scrolls", async () => {
    const { app } = await mount([], { full: true, intro: said(80) });
    await press(app, PG_UP); // 10 rows up, to row 50 of the 60 the view can start at: the thumb at 12.5 of 15, rounded
    expect(thumb(app)).toEqual([13, 14, 15, 16, 17]);
  });

  it("does nothing for a press on the bar's column below the conversation, one column left of the bar, or with another button", async () => {
    const { app, mouse } = await mount([], { full: true, intro: said(80) });
    await press(app, CTRL_HOME); // the thumb at the top, so a press taken as on the track would move it
    const frame = app.lastFrame();
    await pointer(mouse, at("press", BAR, 21), at("release", BAR, 21), at("press", BAR - 1, 10), at("release", BAR - 1, 10));
    await pointer(mouse, at("press", BAR, 10, { button: "right" }), at("release", BAR, 10, { button: "right" }));
    expect(app.lastFrame()).toBe(frame);
  });

  it("keeps the view where it is when the grabbed thumb moves sideways on its row, and draws nothing new", async () => {
    let { app, mouse } = await mount([], { full: true, intro: said(80) });
    await press(app, PG_UP);
    expect(thumb(app)).toEqual([13, 14, 15, 16, 17]);
    await pointer(mouse, at("press", BAR, 15), at("drag", BAR - 1, 15));
    expect(shown(app)[0]).toBe("said 50.");
    const frames = app.frames.length;
    for (let i = 0; i < 10; i++) await pointer(mouse, at("drag", BAR - 1, 15));
    expect(app.frames.length).toBe(frames);
    // 1,000 lines: a thumb of one row, which stands for many first rows
    ({ app, mouse } = await mount([], { full: true, intro: said(1000) }));
    await press(app, PG_UP, PG_UP);
    expect(shown(app)[0]).toBe("said 960.");
    await pointer(mouse, at("press", BAR, 19), at("drag", BAR - 1, 19));
    expect(shown(app)[0]).toBe("said 960.");
  });

  it("ends an earlier grab on a new press, as when its release was lost", async () => {
    const { app, mouse } = await mount([], { full: true, intro: said(80) });
    await pointer(mouse, at("press", BAR, 17), at("press", 10, 5), at("drag", 10, 12));
    expect(shown(app)[0]).toBe("said 60.");
  });

  it("grabs a thumb held at the bar's end by a track click where the pointer is on it", async () => {
    const { app, mouse } = await mount([], { full: true, intro: said(80) });
    await pointer(mouse, at("press", BAR, 1));
    expect(thumb(app)).toEqual([0, 1, 2, 3, 4]); // centred on row 1 it would start above the bar, so it starts at 0
    await pointer(mouse, at("drag", BAR, 5)); // 4 rows down
    expect(thumb(app)).toEqual([4, 5, 6, 7, 8]);
  });

  it("draws nothing new for a wheel notch that cannot move", async () => {
    const { app, mouse } = await mount([], { full: true, intro: said(80) });
    let frames = app.frames.length;
    await wheel(mouse, "down", 5); // following already
    expect(app.frames.length).toBe(frames);
    await press(app, CTRL_HOME);
    frames = app.frames.length;
    await wheel(mouse, "up", 5); // at the top already
    expect(app.frames.length).toBe(frames);
  });

  it("scrolls while the model list is open, and picking a model brings the view to the bottom to say so", async () => {
    const { app, mouse } = await mount([], { full: true, intro: said(80), models: [{ provider: "fake", models: ["a", "b"] }] });
    await type(app, "/model");
    await until(app, "fake:b");
    await tick(); // the picker starts reading keys just after it first appears
    const before = shown(app)[0];
    await wheel(mouse, "up", 3);
    expect(shown(app)[0]).not.toBe(before);
    await press(app, "\u001b[B", "\r"); // down to fake:b, and pick it
    await until(app, "lead is now fake:b");
    expect(app.lastFrame()).not.toContain("new lines");
  });

  it("brings the view to the bottom for a model that cannot be picked, to show why", async () => {
    const { app, mouse } = await mount([], { full: true, intro: said(80), models: [{ provider: "fake", models: ["a", "b"] }], leadFails: "no such model" });
    await type(app, "/model");
    await until(app, "fake:b");
    await tick();
    await wheel(mouse, "up", 3);
    await press(app, "\u001b[B", "\r");
    await until(app, "no such model");
    expect(app.lastFrame()).not.toContain("new lines");
  });
});

// The frame with its colours: Ink colours through chalk, which finds no colour in a test's output, so a test that looks
// for reverse colours turns them on for itself and back off after. chalk is Ink's dependency, not ours, reached through
// Ink's install; that is acceptable, as were it ever to move, the import fails loudly rather than a test passing
// silently.
async function inColour(test: () => Promise<void>) {
  const level = chalk.level;
  chalk.level = 1; // 1: chalk's basic 16 colours, enough for reverse (\u001b[7m)
  try {
    await test();
  } finally {
    chalk.level = level;
  }
}
// The text drawn in reverse colours on each row of the frame; the status line has some of its own.
const reverse = (row: string) => [...row.matchAll(/\u001b\[7m(.*?)\u001b\[27m/g)].map((m) => m[1]).join("");
const reversed = (app: ReturnType<typeof render>) => app.lastFrame()!.split("\n").map(reverse);
const click = (x: number, y: number) => [at("press", x, y), at("release", x, y)];

describe("App's selecting and copying in full screen", () => {
  // 149 columns of words: a row of 99, then the rest.
  const long = "word ".repeat(30).trimEnd();

  it("copies a drag over a wrapped line's rows as one line, and over two lines joined by a line break, saying how many characters until a key", async () => {
    const { app, mouse, copies } = await mount([], { full: true, intro: [{ text: long }, { text: "second line" }, { text: "third 🦀" }] });
    await pointer(mouse, at("press", 0, 0), at("drag", 40, 1), at("drag", 98, 1), at("release", 98, 1));
    expect(copies).toEqual([long]);
    expect(app.lastFrame()).toContain("Copied 149 characters");
    await pointer(mouse, at("press", 0, 2), at("drag", 98, 3), at("release", 98, 3));
    expect(copies.at(-1)).toBe("second line\nthird 🦀");
    expect(app.lastFrame()).toContain("Copied 19 characters"); // the crab is one character as a person sees it, two in UTF-16
    await press(app, "x");
    expect(app.lastFrame()).not.toContain("Copied");
    expect(app.lastFrame()).toContain("› x");
  });

  it("shows the selection in reverse colours as it grows, never on the scroll bar's column", async () => {
    await inColour(async () => {
      const { app, mouse } = await mount([], { full: true, intro: said(80) });
      await pointer(mouse, at("press", 2, 5), at("drag", 3, 6));
      expect(reversed(app).slice(4, 8)).toEqual(["", "id 65.", "said", ""]);
      await pointer(mouse, at("drag", BAR, 6));
      expect(reversed(app).slice(4, 8)).toEqual(["", "id 65.", "said 66.", ""]);
      expect(app.lastFrame()!.split("\n")[6]).toMatch(/\u001b\[27m[^\u001b]*\u001b\[90m│/); // the bar's column after the reverse ends
    });
  });

  it("scrolls a row for each drag report below the conversation, or on its top row for a drag started below it, copying lines off screen", async () => {
    const { app, mouse, copies } = await mount([], { full: true, intro: said(80) });
    await press(app, CTRL_HOME);
    await pointer(mouse, at("press", 0, 18), at("drag", 50, 21), at("drag", 50, 22), at("release", 50, 22));
    expect(shown(app)[0]).toBe("said 2.");
    expect(copies).toEqual(["said 18.\nsaid 19.\nsaid 20.\nsaid 21."]);
    await press(app, CTRL_END);
    await pointer(mouse, at("press", 0, 2), at("drag", 0, 0), at("drag", 0, 0), at("release", 0, 0));
    expect(shown(app)[0]).toBe("said 58.");
    expect(copies.at(-1)).toBe("said 58.\nsaid 59.\nsaid 60.\nsaid 61.\ns");
  });

  it("copies a path whole on a double-click and the line on a triple-click, and nothing for a double-click past a row's text", async () => {
    const { app, mouse, copies } = await mount([], { full: true, intro: [{ text: "see C:\\src\\a-b_c.ts now" }, { text: "" }, { text: "next" }] });
    await pointer(mouse, ...click(7, 0), ...click(7, 0));
    expect(copies).toEqual(["C:\\src\\a-b_c.ts"]);
    await pointer(mouse, ...click(7, 0));
    expect(copies).toEqual(["C:\\src\\a-b_c.ts", "see C:\\src\\a-b_c.ts now"]);
    await pointer(mouse, ...click(60, 2), ...click(60, 2)); // past "next"
    await pointer(mouse, ...click(3, 1), ...click(3, 1), ...click(3, 1)); // an empty line, double and triple
    expect(copies).toHaveLength(2);
    expect(app.lastFrame()).not.toContain("Copied");
  });

  it("clears a selection on a click without a drag, copying nothing", async () => {
    await inColour(async () => {
      const { app, mouse, copies } = await mount([], { full: true, intro: said(80) });
      await pointer(mouse, at("press", 0, 3), at("drag", 4, 3), at("release", 4, 3));
      expect(reversed(app)[3]).toBe("said ");
      expect(app.lastFrame()).toContain("Copied 5 characters");
      await pointer(mouse, ...click(2, 10));
      expect(reversed(app).slice(0, 20).join("")).toBe("");
      expect(copies).toEqual(["said "]);
      expect(app.lastFrame()).not.toContain("Copied");
    });
  });

  it("says when the clipboard tool fails that the terminal alone copied", async () => {
    const { app, mouse } = await mount([], { full: true, intro: said(80), run: async () => Promise.reject(new Error("xclip not found")) });
    await pointer(mouse, at("press", 0, 3), at("drag", 7, 3), at("release", 7, 3));
    await until(app, "Copied with the terminal only; xclip not found");
  });

  // Found at the final review: the reason comes from the tool's own error output.
  it("escapes the clipboard tool's reason for failing", async () => {
    const { app, mouse } = await mount([], { full: true, intro: said(80), run: async () => Promise.reject(new Error("xclip failed: a\u001b[2Jb")) });
    await pointer(mouse, at("press", 0, 3), at("drag", 7, 3), at("release", 7, 3));
    await until(app, "Copied with the terminal only; xclip failed: a\\u001b[2Jb");
    expectNoRawControls(app.lastFrame());
  });

  it("says the terminal alone copied, with no failure, where there is no tool, as on Linux over SSH", async () => {
    const { app, mouse, copies } = await mount([], { full: true, intro: said(80), run: null });
    await pointer(mouse, at("press", 0, 3), at("drag", 7, 3), at("release", 7, 3));
    expect(copies).toEqual(["said 63."]);
    expect(app.lastFrame()).toContain("Copied 8 characters with the terminal only");
  });

  it("keeps the selection on its text as new output moves the view, and as the wheel scrolls it", async () => {
    await inColour(async () => {
      const { app, mouse, bus } = await mount([], { full: true, intro: said(80) });
      await pointer(mouse, at("press", 0, 19), at("drag", 98, 19)); // said 79., the button still held
      expect(reversed(app)[19]).toBe("said 79.");
      bus.emit("error", { kind: "fallback", attempted: "x", message: "moved on", lead: "fake:a" });
      await until(app, "↪ moved on");
      expect(reversed(app)[18]).toBe("said 79.");
      await wheel(mouse, "up"); // 3 rows: said 79. goes below the view
      expect(reversed(app).slice(0, 20).join("")).toBe("");
      await wheel(mouse, "down");
      expect(reversed(app)[18]).toBe("said 79.");
    });
  });

  // Shift+Up and Shift+Down only scroll: moving the selection's end and copying again would put an old selection back
  // over newer clipboard contents (the user's choice at Task 9's review, 2026-10-27, dropping the plan's choice 9).
  it("only scrolls on Shift+Up with a selection showing, copying nothing and leaving the selection on its text", async () => {
    await inColour(async () => {
      const { app, mouse, copies } = await mount([], { full: true, intro: said(80) });
      await press(app, PG_UP);
      await pointer(mouse, at("press", 0, 2), at("drag", 50, 2), at("release", 50, 2));
      expect(copies).toEqual(["said 52."]);
      await press(app, SHIFT_UP);
      expect(shown(app)[0]).toBe("said 49.");
      expect(reversed(app)[3]).toBe("said 52.");
      expect(copies).toEqual(["said 52."]);
    });
  });

  it("keeps a double-clicked word and a dragged selection on their text when a resize wraps the line again", async () => {
    await inColour(async () => {
      const narrow = async (app: ReturnType<typeof render>) => {
        Object.defineProperty(app.stdout, "columns", { value: 50, configurable: true });
        app.stdout.emit("resize");
        await tick();
      };
      let { app, mouse, copies } = await mount([], { full: true, intro: [{ text: long }] });
      await pointer(mouse, ...click(80, 0), ...click(80, 0)); // the 17th word, at columns 80 to 83
      expect(copies).toEqual(["word"]);
      await narrow(app);
      expect(reversed(app).slice(0, 20).join("")).toBe("word");
      ({ app, mouse, copies } = await mount([], { full: true, intro: [{ text: long }] }));
      await pointer(mouse, at("press", 2, 0), at("drag", 80, 0), at("release", 80, 0));
      expect(copies).toEqual([long.slice(2, 81)]);
      await narrow(app);
      expect(reversed(app).slice(0, 20).join("")).toBe(long.slice(2, 81)); // now over two rows
    });
  });

  it("never scrolls for a drag that started on the conversation's top row, selecting within it", async () => {
    const { app, mouse, copies } = await mount([], { full: true, intro: said(80) });
    await pointer(mouse, at("press", 2, 0), at("drag", 5, 0), at("drag", 3, 2), at("drag", 6, 0), at("release", 6, 0));
    expect(shown(app)[0]).toBe("said 60.");
    expect(copies).toEqual(["id 60"]);
  });

  // The line about a copy takes the hint row's place only when it is showing, so a copy never moves the conversation
  // (the user's choice at Task 9's review, 2026-10-27).
  it("says nothing about a copy during a turn, which has no hint row, so the conversation stays where it is", async () => {
    const { app, mouse, copies } = await mount([], { full: true, intro: said(80), lead: hanging() });
    await type(app, "go");
    await until(app, "Esc to stop");
    const before = shown(app).slice(0, 19);
    await pointer(mouse, at("press", 0, 5), at("drag", 7, 5), at("release", 7, 5));
    expect(copies).toHaveLength(1);
    expect(app.lastFrame()).not.toContain("Copied");
    expect(shown(app).slice(0, 19)).toEqual(before);
  });

  it("keeps Ctrl+R's search line in the hint row over the line about a copy", async () => {
    const { app, mouse, copies } = await mount([], { full: true, intro: said(80), past: ["about"] });
    await press(app, "\u0012", "ab");
    await until(app, "search: ab ·");
    await pointer(mouse, at("press", 0, 5), at("drag", 7, 5), at("release", 7, 5));
    expect(copies).toHaveLength(1);
    expect(app.lastFrame()).toContain("search: ab ·");
    expect(app.lastFrame()).not.toContain("Copied");
  });

  it("shows a failed copy during a turn, though the turn has no hint row", async () => {
    const { app, mouse } = await mount([], { full: true, intro: said(80), lead: hanging(), run: async () => Promise.reject(new Error("xclip not found")) });
    await type(app, "go");
    await until(app, "Esc to stop");
    await pointer(mouse, at("press", 0, 5), at("drag", 7, 5), at("release", 7, 5));
    await until(app, "Copied with the terminal only; xclip not found");
  });

  // A failed copy is always reported: one that came while Ctrl+R's search held the row waits until it has been shown.
  it("keeps a failed copy that came during Ctrl+R's search until the search ends and shows it, through the keys typed meanwhile", async () => {
    const { app, mouse } = await mount([], { full: true, intro: said(80), past: ["about"], run: async () => Promise.reject(new Error("xclip not found")) });
    await press(app, "\u0012");
    await until(app, "search: ");
    await pointer(mouse, at("press", 0, 5), at("drag", 7, 5), at("release", 7, 5));
    await press(app, "a", "b");
    expect(app.lastFrame()).toContain("search: ab ·");
    expect(app.lastFrame()).not.toContain("Copied");
    await press(app, "\u001b"); // Esc leaves the search
    await until(app, "Copied with the terminal only; xclip not found");
    await press(app, "x"); // shown now, so the next key takes it away
    expect(app.lastFrame()).not.toContain("Copied");
  });

  // A successful copy's line that cannot be shown when the copy is made is dropped, so it never turns up later.
  it("drops the line about a copy made during a turn, so it does not show when the turn ends", async () => {
    const lead = new Held();
    const { app, mouse, copies } = await mount([], { full: true, intro: said(80), lead });
    await type(app, "go");
    await until(app, "Esc to stop");
    await pointer(mouse, at("press", 0, 5), at("drag", 7, 5), at("release", 7, 5));
    expect(copies).toHaveLength(1);
    lead.answer("done");
    await until(app, "? for shortcuts");
    expect(app.lastFrame()).not.toContain("Copied");
  });

  // The exit warning keeps the hint row (the user's choice at Task 9's review, 2026-10-27). Its 800 ms run on fake timers,
  // as in "forgets a first press after 800 ms", so the mouse reports are sent without pointer's real wait.
  async function behindExitWarning(run?: (text: string) => Promise<void>) {
    const { app, mouse, copies } = await mount([], { full: true, intro: said(80), ...(run ? { run } : {}) });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const wait = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      await new Promise((resolve) => setImmediate(resolve));
    };
    app.stdin.write("\u0004");
    await wait(10);
    expect(app.lastFrame()).toContain("Press Ctrl-D again to exit");
    for (const m of [at("press", 0, 5), at("drag", 7, 5), at("release", 7, 5)]) mouse.emit("mouse", m);
    await wait(10);
    expect(copies).toHaveLength(1);
    expect(app.lastFrame()).toContain("Press Ctrl-D again to exit");
    expect(app.lastFrame()).not.toContain("Copied");
    await wait(800);
    expect(app.lastFrame()).not.toContain("Press Ctrl-D again to exit");
    return app;
  }

  it("leaves the exit warning in the hint row over a copy, and drops the copy's line", async () => {
    try {
      const app = await behindExitWarning();
      expect(app.lastFrame()).toContain("? for shortcuts");
      expect(app.lastFrame()).not.toContain("Copied");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a failed copy that came behind the exit warning once the warning times out", async () => {
    try {
      const app = await behindExitWarning(async () => Promise.reject(new Error("xclip not found")));
      expect(app.lastFrame()).toContain("Copied with the terminal only; xclip not found");
    } finally {
      vi.useRealTimers();
    }
  });

  // A selection stays until a click: any press but one on the scroll bar, which scrolls as the wheel does (the user's
  // choice at Task 9's review, 2026-10-27).
  it("clears a selection on a press on the prompt, on the status line, or with another button, copying nothing", async () => {
    await inColour(async () => {
      const { app, mouse, copies } = await mount([], { full: true, intro: said(80) });
      for (const [i, press] of [at("press", 5, 20), at("press", 5, 22), at("press", 10, 10, { button: "right" })].entries()) {
        await pointer(mouse, at("press", 0, 3), at("drag", 7, 3), at("release", 7, 3));
        expect(reversed(app)[3]).toBe("said 63.");
        await pointer(mouse, press, { ...press, kind: "release" }); // the prompt's row, the status line's, a right click
        expect(reversed(app).slice(0, 20).join("")).toBe("");
        expect(copies).toHaveLength(i + 1);
      }
    });
  });

  it("keeps a selection while the scroll bar's thumb is dragged", async () => {
    await inColour(async () => {
      const { app, mouse } = await mount([], { full: true, intro: said(80) });
      await pointer(mouse, at("press", 0, 3), at("drag", 7, 3), at("release", 7, 3));
      await pointer(mouse, at("press", BAR, 17), at("drag", BAR, 15), at("release", BAR, 15));
      expect(shown(app)[0]).not.toBe("said 60.");
      expect(reversed(app).slice(0, 20)).toContain("said 63.");
    });
  });

  // The "↓ N new lines" row is not text: a press there starts nothing, and a drag onto it counts as the row above it.
  it("never selects or copies the line hidden under the new-lines row", async () => {
    const { app, mouse, bus, copies } = await mount([], { full: true, intro: said(80) });
    await press(app, PG_UP); // said 50. to said 69.
    bus.emit("error", { kind: "fallback", attempted: "x", message: "moved on", lead: "fake:a" });
    await until(app, "↓ 1 new line");
    await pointer(mouse, at("press", 0, 17), at("drag", 3, 19), at("drag", 50, 19), at("release", 50, 19));
    expect(copies).toEqual(["said 67.\nsaid 68."]);
    await pointer(mouse, ...click(2, 19), ...click(2, 19)); // a double-click on the row
    expect(copies).toHaveLength(1);
    expect(shown(app)[0]).toBe("said 50.");
  });

  // Clicks and the drawing agree on that row (found at Task 11's re-review): lines that came in on screen draw no row, so
  // the last row is text.
  it("selects on the conversation's last row when every line that came in shows", async () => {
    const { app, mouse, bus, copies } = await mount([], { full: true, intro: said(22) });
    await press(app, PG_UP); // held at said 0.
    Object.assign(app.stdout, { rows: 30 }); // 26 rows of conversation: said 0. to said 21., then 4 blank
    app.stdout.emit("resize");
    await tick();
    bus.emit("message", { role: "assistant", parts: [{ type: "text", text: "one\ntwo\nthree\nfour" }] });
    await until(app, "four");
    expect(shown(app)[25]).toBe("four");
    expect(app.lastFrame()).not.toContain("new line");
    await pointer(mouse, ...click(1, 25), ...click(1, 25));
    expect(copies).toEqual(["four"]);
  });

  it("takes away the line about a copy on a paste, as on a key", async () => {
    const { app, mouse } = await mount([], { full: true, intro: said(80) });
    await pointer(mouse, at("press", 0, 5), at("drag", 7, 5), at("release", 7, 5));
    expect(app.lastFrame()).toContain("Copied 8 characters");
    await press(app, "\u001b[200~abc\u001b[201~");
    expect(app.lastFrame()).toContain("› abc");
    expect(app.lastFrame()).not.toContain("Copied");
  });
});

// Clicks in the prompt and on menu entries (release 5 design, "Clicking"). With 24 rows and nothing else live, the prompt
// is the frame's row 20, under 20 rows of conversation; its text starts after the two columns of "› ".
describe("App's clicks in full screen", () => {
  it("puts the prompt's cursor at the character clicked, at a row's end past it, and on a wrapped prompt's second row", async () => {
    const { app, mouse } = await mount([], { full: true });
    await press(app, "hello world");
    await pointer(mouse, ...click(8, 20)); // the "w": column 6 of the text
    await press(app, "X");
    expect(app.lastFrame()).toContain("› hello Xworld\n");
    await pointer(mouse, ...click(60, 20));
    await press(app, "!");
    expect(app.lastFrame()).toContain("› hello Xworld!\n");
    await press(app, "\u0015", `${"a".repeat(97)}bcd`); // Ctrl+U empties it; 97 columns a row, so "bcd" wraps
    expect(app.lastFrame()).toContain(`› ${"a".repeat(97)}\n  bcd\n`); // two rows: 19 and 20
    await pointer(mouse, ...click(3, 20)); // the "c"
    await press(app, "X");
    expect(app.lastFrame()).toContain(`› ${"a".repeat(97)}\n  bXcd\n`);
  });

  it("puts the prompt's cursor at a row's start on a click in the row's first two columns", async () => {
    const { app, mouse } = await mount([], { full: true });
    await press(app, "ab", "\n", "cd");
    expect(shown(app).slice(19, 21)).toEqual(["› ab", "  cd"]);
    await pointer(mouse, ...click(1, 19)); // on the "›"'s space
    await press(app, "X");
    expect(shown(app).slice(19, 21)).toEqual(["› Xab", "  cd"]);
    await pointer(mouse, ...click(0, 20)); // a continuation row
    await press(app, "Y");
    expect(shown(app).slice(19, 21)).toEqual(["› Xab", "  Ycd"]);
  });

  // React draws no frame between a key and a mouse report from the same read of the terminal, so a click there would be
  // mapped onto the screen from before the key (found at Task 10's review).
  it("drops a click that comes in the same read as a key that changes the prompt", async () => {
    const { app, mouse } = await mount([], { full: true });
    await press(app, "ab", "\n", "cd", "\n", "ef");
    expect(shown(app).slice(18, 21)).toEqual(["› ab", "  cd", "  ef"]);
    app.stdin.write("\u0003"); // Ctrl-C empties the prompt to one row
    for (const m of click(3, 20)) mouse.emit("mouse", m); // on "ef", drawn before the key
    await tick();
    expect(app.lastFrame()).toContain("\n›\n");
    await press(app, "X");
    expect(app.lastFrame()).toContain("\n› X\n");
  });

  it("drops a click on a menu entry that comes in the same read as a key that changes the menu", async () => {
    const { app, mouse } = await mount([], { full: true });
    await press(app, "/");
    const row = shown(app).findIndex((r) => r.startsWith("  /tasks  "));
    expect(row).toBeGreaterThan(-1);
    app.stdin.write("m");
    for (const m of click(4, row)) mouse.emit("mouse", m); // on /tasks, drawn before the key
    await tick();
    await tick();
    expect(app.lastFrame()).toContain("\n› /m\n");
    expect(app.lastFrame()).not.toContain("No models");
    expect(app.lastFrame()).not.toContain("No subagents yet.");
  });

  it("runs a / command clicked in the menu, as Enter does", async () => {
    const { app, mouse } = await mount([], { full: true });
    await press(app, "/");
    const row = shown(app).findIndex((r) => r.startsWith("  /tasks  "));
    expect(row).toBeGreaterThan(-1);
    await pointer(mouse, ...click(4, row));
    await until(app, "No subagents yet.");
    expect(app.lastFrame()).toContain("\n›\n"); // the prompt emptied, as Enter leaves it
  });

  it("fills in an @ path clicked in the menu, as Enter does", async () => {
    const { app, mouse, ctx } = await mount([], { full: true });
    try {
      await writeFile(path.join(ctx.root, "a.txt"), "");
      await writeFile(path.join(ctx.root, "b.txt"), "");
      await press(app, "@");
      expect(shown(app).slice(18, 21)).toEqual(["› @", "  a.txt", "  b.txt"]);
      await pointer(mouse, ...click(4, 20));
      expect(app.lastFrame()).toContain("› @b.txt\n");
    } finally {
      await rm(ctx.root, { recursive: true, force: true });
    }
  });

  it("picks a model clicked in /model's list, as Enter does", async () => {
    const made: string[] = [];
    const { app, mouse } = await mount([], { full: true, made, models: [{ provider: "fake", models: ["a", "b"] }] });
    await type(app, "/model");
    await until(app, "fake:b");
    await tick(); // the picker starts reading keys just after it first appears
    expect(shown(app).slice(18, 22)).toEqual(["fake", "● fake:a", "  fake:b", "Filter: (type to filter) · ↑↓ move · Enter picks · Esc closes"]);
    await pointer(mouse, ...click(4, 20));
    await until(app, "lead is now fake:b");
    expect(made).toEqual(["fake:b"]);
  });

  // The list is mapped as it was drawn; a key in the same read of the terminal can change the filter first (found at
  // Task 10's review).
  it("picks the model clicked in /model's list when a key in the same read changed the filter", async () => {
    const made: string[] = [];
    const { app, mouse } = await mount([], { full: true, made, models: [{ provider: "fake", models: ["x1", "x2", "y1"] }] });
    await type(app, "/model");
    await until(app, "fake:y1");
    await tick(); // the picker starts reading keys just after it first appears
    expect(shown(app).slice(17, 21)).toEqual(["fake", "  fake:x1", "  fake:x2", "  fake:y1"]);
    app.stdin.write("x");
    for (const m of click(4, 20)) mouse.emit("mouse", m); // on fake:y1, drawn before the key
    await waitFor(() => made.length > 0);
    expect(made).toEqual(["fake:y1"]);
  });

  // A click or key read with the key that closed the list, or with an earlier click or Enter that picked, comes before the
  // list is gone from the screen (found at Task 10's review). Not Esc: Ink waits 20 ms for the rest of a key starting with
  // it (`pendingInputFlushDelayMilliseconds` in Ink's components/App.js), so a click read with it comes first.
  it("picks nothing on a click or Enter in /model's list read with Ctrl-C, and once on two picks in one read", async () => {
    const made: string[] = [];
    const { app, mouse } = await mount([], { full: true, made, models: [{ provider: "fake", models: ["a", "b"] }] });
    for (const after of [() => click(4, 20).forEach((m) => mouse.emit("mouse", m)), () => app.stdin.write("\r")]) {
      await type(app, "/model");
      await until(app, "fake:b");
      await tick(); // the picker starts reading keys just after it first appears
      app.stdin.write("\u0003");
      after(); // a click on fake:b, or Enter
      await gone(app, "Filter:");
      await tick();
      expect(made).toEqual([]);
    }
    await type(app, "/model");
    await until(app, "fake:b");
    await tick();
    for (const m of [...click(4, 20), ...click(4, 19)]) mouse.emit("mouse", m);
    await waitFor(() => made.length > 0);
    await tick();
    expect(made).toEqual(["fake:b"]);
    await type(app, "/model");
    await until(app, "fake:b");
    await tick();
    app.stdin.write("\r"); // Enter picks fake:b, the lead now, so chosen when the list opens
    for (const m of click(4, 19)) mouse.emit("mouse", m); // on fake:a
    await waitFor(() => made.length > 1);
    await tick();
    expect(made).toEqual(["fake:b", "fake:b"]);
  });

  // Release 5 plan, choice 10. The counts start at 2: a count takes the place of a row, and counts it (layout.ts, scroll).
  it("does nothing on a click on a menu's or the prompt's count of the rows cut off", async () => {
    const { app, mouse, ctx } = await mount([], { full: true, rows: 10 });
    try {
      for (const name of ["a1", "a2", "a3", "a4", "a5", "a6"]) await writeFile(path.join(ctx.root, name), "");
      await press(app, "@a");
      // Nine rows: one of conversation, the prompt, five of the menu, the hint and the status line.
      expect(shown(app).slice(1, 7)).toEqual(["› @a", "  a1", "  a2", "  a3", "  a4", "  ↓ 2 more"]);
      let frame = app.lastFrame();
      await pointer(mouse, ...click(4, 6));
      expect(app.lastFrame()).toBe(frame);
      await press(app, ...Array(4).fill("\u001b[B")); // a5 chosen
      expect(shown(app).slice(1, 7)).toEqual(["› @a", "  ↑ 2 more", "  a3", "  a4", "  a5", "  a6"]);
      frame = app.lastFrame();
      await pointer(mouse, ...click(4, 2));
      expect(app.lastFrame()).toBe(frame);
      // Ctrl+U empties it; ten lines, in five rows, half the terminal's (release 7 plan, choice 120).
      await press(app, "\u0015", "a", ..."bcdefghij".split("").flatMap((c) => ["\n", c]));
      expect(shown(app).slice(2, 7)).toEqual(["› ↑ 6 rows above", "  g", "  h", "  i", "  j"]);
      await pointer(mouse, ...click(4, 2));
      await press(app, "X");
      expect(shown(app)[6]).toBe("  jX");
      await press(app, "\u007f", ...Array(9).fill("\u001b[A")); // Backspace, then up to the first row
      expect(shown(app).slice(2, 7)).toEqual(["› a", "  b", "  c", "  d", "  ↓ 6 rows below"]);
      await pointer(mouse, ...click(4, 6));
      await press(app, "Y");
      expect(shown(app)[2]).toBe("› aY");
    } finally {
      await rm(ctx.root, { recursive: true, force: true });
    }
  });

  // Release 5 plan, choice 10: the list's own models take clicks, nothing else in it does.
  it("picks nothing on a click on the model list's heading or its filter line", async () => {
    const made: string[] = [];
    const { app, mouse } = await mount([], { full: true, made, models: [{ provider: "fake", models: ["a", "b"] }] });
    await type(app, "/model");
    await until(app, "fake:b");
    await tick(); // the picker starts reading keys just after it first appears
    expect(shown(app).slice(18, 22)).toEqual(["fake", "● fake:a", "  fake:b", "Filter: (type to filter) · ↑↓ move · Enter picks · Esc closes"]);
    await pointer(mouse, ...click(4, 18), ...click(4, 21));
    expect(made).toEqual([]);
    expect(app.lastFrame()).toContain("Filter: (type to filter)");
  });

  it("does nothing on a click while a question is open", async () => {
    const { app, mouse, ask } = await mount([], { full: true });
    await press(app, "hello world");
    const answer = ask("write x");
    await until(app, "Allow write x? [y/n]");
    const row = shown(app).findIndex((r) => r.startsWith("Allow write x?"));
    const frame = app.lastFrame();
    await pointer(mouse, ...click(8, row)); // where the prompt's "w" is when no question is open
    expect(app.lastFrame()).toBe(frame);
    await press(app, "y");
    expect(await answer).toBe(true);
    await press(app, "X");
    expect(app.lastFrame()).toContain("› hello worldX\n");
  });

  // The prompt during the search shows a match, not what is typed (release 5 plan, choice 10).
  it("does nothing on a click during Ctrl+R's search", async () => {
    const { app, mouse } = await mount([], { full: true, past: ["one\ntwo\nthree"] });
    await press(app, "d", "\u0012", "t");
    await until(app, "search: t ·");
    const row = shown(app).indexOf("  three"); // a row the prompt as typed, one row, does not have
    const frame = app.lastFrame();
    await pointer(mouse, ...click(4, row));
    await pointer(mouse, ...click(4, row)); // a frame drawn between: a click on the prompt as typed would have moved it
    expect(app.lastFrame()).toBe(frame);
    await press(app, "\u0003", "X"); // Ctrl-C gives back what was typed
    expect(app.lastFrame()).toContain("› dX\n");
  });

  // Ctrl-C gives back the very prompt the frame was drawn with, so only the frame's rows can tell that the match's rows
  // were not the prompt's (found at Task 10's re-review).
  it("does nothing on a click on the match's rows read with the Ctrl-C that ends Ctrl+R's search", async () => {
    const { app, mouse } = await mount([], { full: true, past: ["one\ntwo\nthree"] });
    await press(app, "d", "\u0012", "t");
    await until(app, "search: t ·");
    const row = shown(app).indexOf("  three");
    app.stdin.write("\u0003");
    for (const m of click(4, row)) mouse.emit("mouse", m);
    await tick();
    await press(app, "X");
    expect(app.lastFrame()).toContain("› dX\n");
  });

  // As a key between two presses does (the rule at app/keyRouting.ts's `remember`).
  it("starts the press-twice count again on a click", async () => {
    const { app, mouse } = await mount([], { full: true });
    await press(app, "abc", "\u001b");
    await pointer(mouse, ...click(3, 20));
    await press(app, "\u001b"); // within 800 ms of the first: a first press again
    expect(app.lastFrame()).toContain("› abc\n");
    await press(app, "\u001b"); // the second
    expect(app.lastFrame()).not.toContain("abc");
  });
});

// A permission question brings its own detail into view (release 5 design, "Scrolling"; plan, Task 11). While a question
// waits, the conversation has 21 rows: 23 less the question's row and the status line.
describe("App's questions in full screen", () => {
  // A detail of `n` lines, "line 0." and on.
  const detail = (n: number, name = "line") => Array.from({ length: n }, (_, i) => `${name} ${i}.`).join("\n");
  const headed = (text: string, name = "line") => [`┌ ${text} (5 lines)`, ...detail(5, name).split("\n")];

  it("brings a short detail into view, its last line on the conversation's second-last row", async () => {
    const { app, ask } = await mount([], { full: true, intro: said(60) });
    await press(app, PG_UP);
    expect(shown(app)[0]).toBe("said 30.");
    const answer = ask("write a.txt", detail(5));
    await until(app, "Allow write a.txt? [y/n]");
    expect(shown(app).slice(14, 21)).toEqual([...headed("write a.txt"), ""]); // the last row kept for "↓ N new lines"
    await press(app, "y");
    expect(await answer).toBe(true);
  });

  // Not following when the question came, the view stays once it is answered; following, it follows again.
  it.each([
    { name: "scrolled up", up: true },
    { name: "following", up: false },
  ])("puts a long detail's heading on the top row, $name, and scrolls through it before y", async ({ up }) => {
    const lead = new Held();
    const { app, mouse, ask } = await mount([], { full: true, lead, intro: said(60) });
    await type(app, "go");
    await until(app, "> go");
    if (up) await press(app, PG_UP);
    const answer = ask("write a.txt", detail(100));
    await until(app, "[y/n]");
    expect(shown(app)[0]).toBe("┌ write a.txt (100 lines)");
    await press(app, PG_DOWN); // half of 21
    expect(shown(app)[0]).toBe("line 9.");
    await wheel(mouse, "down");
    expect(shown(app)[0]).toBe("line 12.");
    await press(app, "y");
    expect(await answer).toBe(true);
    lead.answer("later reply");
    if (up) {
      await gone(app, "Esc to stop");
      expect(shown(app)[0]).toBe("line 12.");
      expect(app.lastFrame()).not.toContain("later reply");
      expect(app.lastFrame()).toContain("↓ 2 new lines · Ctrl+End"); // the answer's line and the reply
      await press(app, CTRL_END);
    }
    await until(app, "later reply");
    expect(app.lastFrame()).not.toContain("new lines");
  });

  it("leaves the view where it is for a question without a detail", async () => {
    const { app, ask } = await mount([], { full: true, intro: said(60) });
    await press(app, PG_UP);
    const answer = ask("run: ls");
    await until(app, "Allow run: ls? [y/n]");
    expect(shown(app)[0]).toBe("said 30.");
    await press(app, "y");
    expect(await answer).toBe(true);
    expect(shown(app)[0]).toBe("said 30.");
  });

  it("holds the view on the shown question's detail while another's and a reply arrive, then goes to the next one's, then follows", async () => {
    const lead = new Held();
    const { app, ask } = await mount([], { full: true, lead, intro: said(60) });
    await type(app, "go");
    await until(app, "> go");
    const t2 = asker("t2 (a)");
    const t3 = asker("t3 (b)");
    const first = ask("write a.txt", detail(5, "a"), t2.owner);
    await until(app, "Allow t2 (a) to write a.txt? [y/n]");
    expect(shown(app).slice(14, 21)).toEqual([...headed("write a.txt", "a"), ""]);
    const second = ask("write b.txt", detail(5, "b"), t3.owner);
    await until(app, "↓ 6 new lines · Ctrl+End"); // the second's heading and detail, below
    expect(shown(app).slice(14, 20)).toEqual(headed("write a.txt", "a"));
    lead.answer("a reply");
    await until(app, "↓ 7 new lines · Ctrl+End");
    expect(shown(app).slice(14, 20)).toEqual(headed("write a.txt", "a"));
    await press(app, "y");
    expect(await first).toBe(true);
    await until(app, "Allow t3 (b) to write b.txt? [y/n]");
    // Below the second's detail: the reply and the first's answer.
    expect(shown(app).slice(14, 21)).toEqual([...headed("write b.txt", "b"), "↓ 2 new lines · Ctrl+End"]);
    await press(app, "y");
    expect(await second).toBe(true);
    await gone(app, "[y/n]");
    expect(shown(app).slice(16, 20)).toEqual(["b 4.", "a reply", "t2 (a) to write a.txt: You allowed this.", "t3 (b) to write b.txt: You allowed this."]);
    expect(app.lastFrame()).not.toContain("new lines");
  });

  // Found at Task 11's review: a view held at the top of a short conversation counted the lines it showed as new.
  it("does not count a line that arrives on screen as new", async () => {
    const lead = new Held();
    const { app, ask } = await mount([], { full: true, lead, intro: said(3) });
    await type(app, "go");
    await until(app, "> go");
    const answer = ask("write a.txt", detail(5), asker("t2 (a)").owner);
    await until(app, "[y/n]");
    expect(shown(app).slice(3, 10)).toEqual(["> go", ...headed("write a.txt")]);
    lead.answer("short reply");
    await until(app, "short reply");
    expect(shown(app)[10]).toBe("short reply");
    expect(app.lastFrame()).not.toContain("new line");
    await press(app, "y");
    expect(await answer).toBe(true);
  });

  it("brings the detail of a question that came while the model list was open into view once the list closes", async () => {
    const { app, ask } = await mount([], { full: true, intro: said(60), models: [{ provider: "fake", models: ["a", "b"] }] });
    await type(app, "/model");
    await until(app, "Filter:");
    await tick(); // the picker starts reading keys just after it first appears
    const answer = ask("write a.txt", detail(5), asker("t2 (a)").owner);
    await tick();
    expect(app.lastFrame()).not.toContain("[y/n]");
    await press(app, "\u001b"); // closes the list
    await until(app, "Allow t2 (a) to write a.txt? [y/n]");
    expect(shown(app).slice(14, 21)).toEqual([...headed("write a.txt"), ""]);
    await press(app, "y");
    expect(await answer).toBe(true);
  });

  // The user's choices at Task 11's review.
  it("follows again after the answer when it was following as the question came, though scrolled up while it waited", async () => {
    const { app, ask } = await mount([], { full: true, intro: said(60) });
    const answer = ask("write a.txt", detail(5));
    await until(app, "[y/n]");
    await press(app, PG_UP);
    expect(app.lastFrame()).not.toContain("line 4.");
    await press(app, "y");
    expect(await answer).toBe(true);
    await until(app, "write a.txt: You allowed this.");
    expect(shown(app)[19]).toBe("write a.txt: You allowed this.");
    expect(app.lastFrame()).not.toContain("new lines");
  });

  it("leaves the view where it is when the terminal is resized while a question waits", async () => {
    const { app, ask } = await mount([], { full: true, intro: said(60) });
    const answer = ask("write a.txt", detail(5));
    await until(app, "[y/n]");
    expect(shown(app).slice(14, 20)).toEqual(headed("write a.txt"));
    Object.assign(app.stdout, { rows: 30 });
    app.stdout.emit("resize");
    await tick();
    const rows = shown(app);
    expect(rows).toHaveLength(29);
    expect(rows.slice(14, 20)).toEqual(headed("write a.txt")); // not put again on the taller view's second-last row
    await press(app, "y");
    expect(await answer).toBe(true);
  });

  // A question too long to leave the conversation its one row puts its text in the conversation (the user's choice at
  // Task 11's review). A command `m` times "echo word " long, its question taking `rows` rows at 100 columns.
  const command = (m: number) => `run: ${"echo word ".repeat(m)}`;
  const taking = (rows: number) => {
    let m = 1;
    while (wrap(`Allow ${command(m)}? [y/n] · Esc to decline`, 100, false).length < rows) m++;
    return command(m);
  };

  it.each([
    { key: "y", ok: true, how: "You allowed this." },
    { key: "n", ok: false, how: "You declined this." },
    { key: "\u001b", ok: false, how: "You declined this." },
  ])("puts all of a question too long to fit in the conversation, and answers it with $key", async ({ key, ok, how }) => {
    const { app, ask } = await mount([], { full: true, intro: said(60) });
    const long = command(300); // 3,005 characters
    const answer = ask(long);
    await until(app, "[y/n]");
    const rows = shown(app);
    expect(rows).toHaveLength(23);
    expect(rows[0]).toBe("┌ run (3005 characters)");
    expect(rows[21]).toBe("Allow run (shown above)? [y/n] · Esc to decline");
    expect(rows[1]).toMatch(/^run: echo word echo/);
    // Every row of it: rows 1 to 20 show, and the rest come onto the last row a row at a time.
    const text = rows.slice(1, 21);
    while (text.length < wrap(long, 99, false).length) {
      await press(app, SHIFT_DOWN);
      text.push(shown(app)[20]!);
    }
    expect(text.join("").replaceAll(" ", "")).toBe(long.replaceAll(" ", ""));
    await press(app, key);
    expect(await answer).toBe(ok);
    await until(app, `run (shown above): ${how}`);
  });

  it("shows a question as before while it leaves the conversation a row, and puts it in the conversation once it would not", async () => {
    let { app, ask } = await mount([], { full: true, intro: said(60) });
    const fits = taking(21); // 23 rows less the status line's
    void ask(fits);
    await until(app, "[y/n]");
    let rows = shown(app);
    expect(rows).toHaveLength(23);
    expect(rows.slice(0, 2)).toEqual(["said 59.", `Allow ${fits.slice(0, 93)}`]);
    expect(app.lastFrame()).not.toContain("shown above");

    ({ app, ask } = await mount([], { full: true, intro: said(60) }));
    void ask(taking(22));
    await until(app, "[y/n]");
    rows = shown(app);
    expect(rows).toHaveLength(23);
    expect(rows[21]).toBe("Allow run (shown above)? [y/n] · Esc to decline");
  });

  // The user's choices at Task 11's re-review: a question with a write's preview points at it, adding no copy; the line
  // names a subagent by its id; and a question is moved into the conversation on any draw where it no longer fits.
  it("points a long write's question at its preview, adding no copy, and brings the preview into view when it is shown", async () => {
    const { app, ask } = await mount([], { full: true, intro: said(60) });
    const path = "dir/".repeat(550); // 2,200 characters
    const first = ask("run: ls", undefined, asker("t2 (a)").owner);
    await until(app, "Allow t2 (a) to run: ls? [y/n]");
    const second = ask(`write ${path}`, detail(5, "b"), asker("t3 (b)").owner);
    const third = ask("write c.txt", detail(30, "c"), asker("t4 (c)").owner);
    await tick();
    await press(app, "y");
    expect(await first).toBe(true);
    await until(app, "Allow t3 to write (shown above)? [y/n] · Esc to decline");
    expect(shown(app)).toHaveLength(23);
    expect(shown(app)[0]).toBe(`┌ write ${path.slice(0, 91)}`); // the preview's heading, its path cut at the row's 99 columns
    await press(app, PG_DOWN, PG_DOWN); // past the heading's rows, to its preview's lines
    expect(shown(app)).toEqual(expect.arrayContaining(detail(5, "b").split("\n")));
    await press(app, CTRL_END);
    expect(shown(app).slice(19, 21)).toEqual(["c 29.", "t2 (a) to run: ls: You allowed this."]); // the newest lines: no copy of the path
    await press(app, "y");
    expect(await second).toBe(true);
    await until(app, "Allow t4 (c) to write c.txt? [y/n]");
    await press(app, "y");
    expect(await third).toBe(true);
  });

  it("names a subagent by its id alone in the line of a question too long to fit, however long its description", async () => {
    const { app, ask } = await mount([], { full: true, intro: said(60) });
    void ask(command(300), undefined, asker(`t2 (${"word ".repeat(510)})`).owner); // a 2,550-character description
    await until(app, "[y/n]");
    const rows = shown(app);
    expect(rows).toHaveLength(23);
    expect(rows[21]).toBe("Allow t2 to run (shown above)? [y/n] · Esc to decline");
    expect(rows[0]).toMatch(/^┌ t2 to run \(\d+ characters\)$/);
    expect(rows[1]).toMatch(/^t2 \(word word/); // the full name, in the conversation
  });

  // The rules Task 11's code review found untested.
  it("leaves the view where it was scrolled after answering a question without a detail, though following when it came", async () => {
    const { app, ask } = await mount([], { full: true, intro: said(60) });
    const answer = ask("run: ls");
    await until(app, "[y/n]");
    await press(app, PG_UP);
    const top = shown(app)[0];
    await press(app, "y");
    expect(await answer).toBe(true);
    await tick();
    expect(shown(app)[0]).toBe(top);
    expect(app.lastFrame()).not.toContain("run: ls: You allowed this.");
  });

  // Whether the view was following is kept from the question's first draw, not from when a resize moves it into the
  // conversation.
  it.each([
    { name: "following", before: false, after: "run (shown above): You allowed this." },
    { name: "scrolled up", before: true, after: "↓ 1 new line · Ctrl+End" },
  ])("after a question moved into the conversation by a resize, follows again only if it was $name when it came", async ({ before, after }) => {
    const { app, ask } = await mount([], { full: true, intro: said(60) });
    if (before) await press(app, PG_UP);
    const answer = ask(taking(15));
    await until(app, "[y/n]");
    if (!before) await press(app, PG_UP);
    Object.defineProperty(app.stdout, "columns", { value: 40, configurable: true });
    app.stdout.emit("resize");
    await until(app, "(shown above)");
    await press(app, "y");
    expect(await answer).toBe(true);
    await until(app, after);
    if (!before) expect(app.lastFrame()).not.toContain("new line");
  });

  // 21 rows of conversation: a detail fits in 20 with its heading, the last kept for "↓ N new lines".
  it("puts a detail that fits above the last row at the foot of the view, and one a row taller with its heading at the top", async () => {
    let { app, ask } = await mount([], { full: true, intro: said(60) });
    void ask("write a.txt", detail(18)); // 19 rows
    await until(app, "[y/n]");
    expect(shown(app).slice(19, 21)).toEqual(["line 17.", ""]);
    expect(shown(app)[1]).toBe("┌ write a.txt (18 lines)");
    ({ app, ask } = await mount([], { full: true, intro: said(60) }));
    void ask("write a.txt", detail(20)); // 21 rows
    await until(app, "[y/n]");
    expect(shown(app)[0]).toBe("┌ write a.txt (20 lines)");
  });

  it("counts the hint row when deciding whether a question fits", async () => {
    const { app, ask } = await mount([], { full: true, intro: said(60), past: ["hello"] });
    await press(app, "\u0012"); // Ctrl+R's search keeps the hint row while the question waits
    await until(app, "search:");
    void ask(taking(21)); // fits beside one row of conversation only without the hint row
    await until(app, "[y/n]");
    const rows = shown(app);
    expect(rows).toHaveLength(23);
    expect(rows[20]).toBe("Allow run (shown above)? [y/n] · Esc to decline");
    expect(rows[21]).toMatch(/^search: /);
  });

  it("moves a question into the conversation once a narrower terminal leaves it too long to fit, and keeps it there", async () => {
    const { app, ask } = await mount([], { full: true, intro: said(60) });
    const fits = taking(15);
    const answer = ask(fits);
    await until(app, "[y/n]");
    expect(shown(app)[7]).toBe(`Allow ${fits.slice(0, 93)}`); // under 7 rows of conversation
    Object.defineProperty(app.stdout, "columns", { value: 40, configurable: true });
    app.stdout.emit("resize");
    await tick();
    let rows = shown(app, 40);
    expect(rows).toHaveLength(23);
    expect(rows[0]).toBe(`┌ run (${fits.length} characters)`);
    expect(rows[1]).toMatch(/^run: echo word/);
    expect(`${rows[20]} ${rows[21]}`).toBe("Allow run (shown above)? [y/n] · Esc to decline"); // two rows at 40 columns
    Object.defineProperty(app.stdout, "columns", { value: 100, configurable: true });
    app.stdout.emit("resize");
    await tick();
    rows = shown(app);
    expect(rows).toHaveLength(23);
    expect(rows[0]).toBe(`┌ run (${fits.length} characters)`);
    expect(rows[21]).toBe("Allow run (shown above)? [y/n] · Esc to decline");
    await press(app, "y");
    expect(await answer).toBe(true);
  });
});

// The detail view (release 5 design, "The detail view"; plan, Task 12): Ctrl+O's last turn and `/tasks t1`'s record in a
// view of their own, in the conversation's place, the prompt hidden, a grey row naming the keys over the status line.
describe("App's detail view in full screen", () => {
  const KEYS = "j k ↑ ↓ line · g G Home End top, bottom · / search · [ print · q Esc close";
  const UP = "\u001b[A";
  const DOWN = "\u001b[B";
  const HOME = "\u001b[H";
  const END = "\u001b[F";
  // `n` lines, "line 0." and on.
  const lines = (n: number, text = (i: number) => `line ${i}.`) => Array.from({ length: n }, (_, i) => text(i)).join("\n");
  // A turn that starts t1, whose answer is `answer`, then t1's record opened with /tasks t1. The delegate call puts the tool
  // line under the status line, so the view has 20 rows: 23 less the key row, the status line and the tool line.
  const record = async (answer: string) => {
    const worker = new FakeProvider("w", [reply(answer)]);
    const m = await mount([callTool("c1", "delegate", { description: "find x", task: "find x" }), reply("done")], { full: true, worker });
    await type(m.app, "go");
    await until(m.app, "done");
    await type(m.app, "/tasks t1");
    await until(m.app, "t1 (find x), done: 0 tool calls");
    return m;
  };
  // The frame's rows as `shown` gives them, with the colours taken out, for tests that turn colours on.
  const plain = (app: ReturnType<typeof render>) => app.lastFrame()!.split("\n").map((r) => r.replace(/\u001b\[[\d;]*m/g, "").slice(0, 99).trimEnd());

  it.each([
    { name: "q", key: "q" },
    { name: "Esc", key: "\u001b" },
    { name: "Ctrl+O", key: "\u000f" },
  ])("opens the last turn's tool calls in a view of their own on Ctrl+O, hiding the prompt, and closes it on $name", async ({ key }) => {
    const { app, ctx } = await mount([callTool("c1", "read_file", { path: "a.txt" }), reply("done")], { full: true });
    await writeFile(path.join(ctx.root, "a.txt"), "hello there");
    await type(app, "go");
    await until(app, "done");
    await press(app, "\u000f");
    let rows = shown(app);
    expect(rows).toHaveLength(23);
    expect(rows.slice(0, 4)).toEqual(["Last turn: 1 tool call", "● read_file {", '  "path": "a.txt"', "}"]);
    expect(rows.slice(20)).toEqual([KEYS, expect.stringContaining("lead fake:a"), expect.stringContaining("read_file")]);
    expect(rows).not.toContain("›");
    expect(app.lastFrame()).not.toContain("> go");
    await press(app, key);
    rows = shown(app);
    expect(rows).toHaveLength(23);
    expect(rows[19]).toBe("›");
    expect(app.lastFrame()).toContain("> go");
    expect(app.lastFrame()).not.toContain("Last turn"); // not put in the conversation
  });

  it("prints the last turn below on Ctrl+O in classic mode, as before", async () => {
    const { app } = await mount([]);
    await press(app, "\u000f");
    expect(app.lastFrame()).toMatch(/^No turn yet, so no tool calls to show\.\n›/);
  });

  it("opens a subagent's record in the view with /tasks t1, putting nothing in the conversation, and prints a mistake as before", async () => {
    const { app } = await record("It is in a.ts");
    const rows = shown(app);
    expect(rows.slice(0, 4)).toEqual(["t1 (find x), done: 0 tool calls", "Answer:", "It is in a.ts", ""]);
    expect(rows[20]).toBe(KEYS);
    await press(app, "q");
    expect(app.lastFrame()).not.toContain("t1 (find x), done");
    await type(app, "/tasks t9");
    await until(app, "No subagent t9. /tasks lists them.");
    expect(app.lastFrame()).toContain("›");
  });

  // 102 rows: the heading, "Answer:", then line 0. to line 99.; 20 on screen, so the last screenful starts at line 80.
  it("moves a row on j, k, Down and Up, to the top on g and Home, to the bottom on G and End, and scrolls as the conversation does", async () => {
    const { app, mouse } = await record(lines(100));
    const top = () => shown(app)[0];
    expect(top()).toBe("t1 (find x), done: 0 tool calls"); // it opens at its top
    expect(thumb(app)).toEqual([0, 1, 2, 3]); // 20 rows of 102 seen
    await press(app, "j", "j");
    expect(top()).toBe("line 0.");
    await press(app, "k");
    expect(top()).toBe("Answer:");
    await press(app, DOWN, DOWN);
    expect(top()).toBe("line 1.");
    await press(app, UP);
    expect(top()).toBe("line 0.");
    await press(app, "G");
    expect(top()).toBe("line 80.");
    expect(shown(app)[19]).toBe("line 99.");
    await press(app, "g");
    expect(top()).toBe("t1 (find x), done: 0 tool calls");
    await press(app, END);
    expect(top()).toBe("line 80.");
    await press(app, HOME);
    expect(top()).toBe("t1 (find x), done: 0 tool calls");
    await press(app, PG_DOWN); // half of 20
    expect(top()).toBe("line 8.");
    await wheel(mouse, "down"); // 3 rows
    expect(top()).toBe("line 11.");
    await press(app, SHIFT_UP);
    expect(top()).toBe("line 10.");
    await press(app, CTRL_END);
    expect(top()).toBe("line 80.");
    await press(app, CTRL_HOME);
    expect(top()).toBe("t1 (find x), done: 0 tool calls");
    await pointer(mouse, ...click(BAR, 18)); // the bar's track near its foot
    expect(shown(app)[19]).toBe("line 99.");
  });

  // "login" on lines 30, 60 and 90: rows 32, 62 and 92 of 102.
  const logins = () => lines(100, (i) => (i > 0 && i % 30 === 0 ? `the login ${i}.` : `line ${i}.`));

  it("searches as the query is typed, in any case, matches in reverse colours, keeps the search on Enter, and goes round with n and N", async () => {
    await inColour(async () => {
      const { app } = await record(logins());
      await press(app, "/");
      expect(plain(app)[20]).toBe("/");
      await press(app, "LOGIN"); // G and N are typed, not the keys they are outside the search
      expect(plain(app)[20]).toBe("/LOGIN");
      expect(plain(app)[0]).toBe("the login 30."); // the first match from the view's top, off screen: on the top row
      expect(reversed(app)[0]).toBe("login");
      await press(app, "\r");
      expect(plain(app)[20]).toBe('"LOGIN": 1 of 3 · n next · N previous');
      await press(app, "n");
      expect(plain(app)[0]).toBe("the login 60.");
      expect(plain(app)[20]).toBe('"LOGIN": 2 of 3 · n next · N previous');
      await press(app, "n"); // row 92: the view goes as far as its last screenful, rows 82 to 101
      expect(plain(app)[10]).toBe("the login 90.");
      expect(reversed(app)[10]).toBe("login");
      expect(plain(app)[20]).toBe('"LOGIN": 3 of 3 · n next · N previous');
      await press(app, "n"); // round to the first
      expect(plain(app)[0]).toBe("the login 30.");
      expect(plain(app)[20]).toBe('"LOGIN": 1 of 3 · n next · N previous');
      await press(app, "N"); // round back to the last
      expect(plain(app)[10]).toBe("the login 90.");
      expect(plain(app)[20]).toBe('"LOGIN": 3 of 3 · n next · N previous');
    });
  });

  it("edits the query with Backspace, and on Esc while typing drops the search and puts the view back where it was", async () => {
    await inColour(async () => {
      const { app } = await record(logins());
      await press(app, "j", "/", "loginx");
      expect(plain(app)[20]).toBe("/loginx (no match)"); // as Ctrl+R's row says it (the user's choice at Task 12's review)
      expect(plain(app)[0]).toBe("Answer:"); // no match: the view stays
      await press(app, "\u007f");
      expect(plain(app)[20]).toBe("/login");
      expect(plain(app)[0]).toBe("the login 30.");
      await press(app, "\u001b");
      expect(plain(app)[0]).toBe("Answer:");
      expect(plain(app)[20]).toBe(KEYS);
      expect(reversed(app).slice(0, 20).join("")).toBe("");
      await press(app, "n"); // no search kept: n does nothing
      expect(plain(app)[0]).toBe("Answer:");
    });
  });

  // The text-field rule (plan, Task 6): while a search is typed, a printable key goes into it.
  it("types q, n and / into a search, the view staying open and no match stepped, and drops the search on Esc", async () => {
    const { app } = await record(logins());
    await press(app, "/", "login", "\r", "/"); // a search kept, then a new one typed
    await press(app, "n");
    expect(plain(app)[20]).toBe("/n");
    await press(app, "q");
    expect(plain(app)[20]).toBe("/nq (no match)");
    await press(app, "/");
    expect(plain(app)[20]).toBe("/nq/ (no match)");
    expect(plain(app)[0]).toBe("the login 30."); // where the kept search left it: n stepped to no other match
    await press(app, "\u001b");
    expect(plain(app)[20]).toBe(KEYS);
    expect(plain(app)[0]).toBe("the login 30.");
  });

  // Review fixes plan, fix 4: keys that are not typed into the search can step while it has no match, which once crashed.
  it("stays drawn when moving between matches of a search with none", async () => {
    const bindings = new Bindings(
      tableOf({ ...DEFAULTS, Transcript: { ...DEFAULTS.Transcript, "ctrl+n": "transcript:nextMatch", "ctrl+p": "transcript:previousMatch" } }),
    );
    const { app } = await mount([], { full: true, bindings });
    await press(app, "\u000f", "/", "zzz");
    expect(app.lastFrame()).toContain("\n/zzz (no match)\n");
    await press(app, "\u000e", "\u0010");
    expect(app.lastFrame()).toContain("\n/zzz (no match)\n");
  });

  it("scrolls on PgUp, PgDn, Ctrl+Home and Ctrl+End", async () => {
    const { app } = await record(lines(100));
    const top = () => shown(app)[0];
    await press(app, PG_DOWN, PG_DOWN); // half of 20, twice
    expect(top()).toBe("line 18.");
    await press(app, PG_UP);
    expect(top()).toBe("line 8.");
    await press(app, CTRL_END);
    expect(top()).toBe("line 80.");
    await press(app, CTRL_HOME);
    expect(top()).toBe("t1 (find x), done: 0 tool calls");
  });

  it("closes the view for a question, which then brings its detail into the conversation's view, and takes n as its answer", async () => {
    const { app, ask } = await mount([], { full: true, intro: said(60) });
    await press(app, "\u000f");
    expect(shown(app)[0]).toBe("No turn yet, so no tool calls to show.");
    const answer = ask("write a.txt", ["line 0.", "line 1.", "line 2.", "line 3.", "line 4."].join("\n"));
    await until(app, "Allow write a.txt? [y/n]");
    expect(app.lastFrame()).not.toContain(KEYS);
    expect(app.lastFrame()).not.toContain("No turn yet");
    // The conversation's 21 rows beside the question: the detail's last line on the second-last (plan, Task 11).
    expect(shown(app).slice(14, 21)).toEqual(["┌ write a.txt (5 lines)", "line 0.", "line 1.", "line 2.", "line 3.", "line 4.", ""]);
    await press(app, "n");
    expect(await answer).toBe(false);
    await until(app, "write a.txt: You declined this.");
  });

  it("selects and copies in the view, saying so in the key row's place until a key, and clears the selection when it closes", async () => {
    await inColour(async () => {
      const { app, mouse, copies } = await record(lines(100));
      await pointer(mouse, at("press", 0, 2), at("drag", 98, 3), at("release", 98, 3));
      expect(copies).toEqual(["line 0.\nline 1."]);
      expect(plain(app)[20]).toBe("Copied 15 characters");
      expect(reversed(app).slice(2, 4)).toEqual(["line 0.", "line 1."]);
      await press(app, "j");
      expect(plain(app)[20]).toBe(KEYS);
      expect(reversed(app).slice(1, 3)).toEqual(["line 0.", "line 1."]); // keys move the view, not the selection
      await pointer(mouse, ...click(2, 0), ...click(2, 0)); // a double-click on "Answer:"
      expect(copies.at(-1)).toBe("Answer");
      await press(app, "q");
      expect(reversed(app).slice(0, 19).join("")).toBe("");
    });
  });

  // Keys and mouse reports in one read of the terminal are handled before the screen is drawn again, so a report read with
  // the key that opens or closes the view is on the screen from before the key (as at Task 10's review).
  it("drops a drag read with the Ctrl+O that opens the view, and one read with the q that closes it", async () => {
    const { app, mouse, copies } = await mount([], { full: true, intro: said(60) });
    const drag = [at("press", 0, 0), at("drag", 20, 0), at("release", 20, 0)];
    app.stdin.write("\u000f");
    for (const m of drag) mouse.emit("mouse", m);
    await tick();
    expect(app.lastFrame()).toContain(KEYS);
    app.stdin.write("q");
    for (const m of drag) mouse.emit("mouse", m);
    await tick();
    expect(app.lastFrame()).not.toContain(KEYS);
    expect(copies).toEqual([]);
  });

  // The user's choice at Task 12's review: with nothing running, Ctrl-C only closes the view.
  it("keeps the working line under the view during a turn, stops the turn on Ctrl-C, and with nothing running closes the view on Ctrl-C", async () => {
    const { app } = await mount([], { full: true, lead: hanging() });
    await type(app, "hi");
    await until(app, "Esc to stop");
    await press(app, "\u000f");
    let rows = shown(app);
    expect(rows[20]).toContain("Working");
    expect(rows[21]).toBe(KEYS);
    await press(app, "\u0003");
    await gone(app, "Working");
    rows = shown(app);
    expect(rows[21]).toBe(KEYS); // the view stays open, a row taller
    await press(app, "\u0003");
    expect(app.lastFrame()).not.toContain(KEYS);
    expect(app.lastFrame()).not.toContain("again to exit");
    expect(shown(app)[20]).toBe("›");
  });

  it("closes the view on Ctrl-C with nothing running, leaving the prompt's draft as it was and not counting toward exiting", async () => {
    const { app } = await mount([], { full: true });
    await press(app, "hello", "\u000f", "\u0003");
    expect(app.lastFrame()).not.toContain(KEYS);
    expect(app.lastFrame()).toContain("› hello\n");
    expect(app.lastFrame()).not.toContain("again to exit");
    await press(app, "\u0003"); // a first press again, which clears the draft as on any prompt
    expect(app.lastFrame()).toContain("\n›\n");
    expect(app.lastFrame()).not.toContain("again to exit");
  });

  // The frame gives the prompt no rows while the view hides it (plan, Task 10's rule): the key row is where the prompt is
  // drawn once the view closes.
  it("does nothing on a click on the key row, where the prompt is once the view closes", async () => {
    const { app, mouse } = await mount([], { full: true });
    await press(app, "hello", "\u000f");
    expect(shown(app)[21]).toBe(KEYS);
    await pointer(mouse, ...click(2, 21));
    await press(app, "q", "X");
    expect(app.lastFrame()).toContain("› helloX\n");
  });

  it("clears a selection in the conversation when the view opens, so none shows on the record's lines", async () => {
    await inColour(async () => {
      const worker = new FakeProvider("w", [reply(lines(100))]);
      const turns = [callTool("c1", "delegate", { description: "find x", task: "find x" }), reply("done")];
      const { app, mouse } = await mount(turns, { full: true, worker, intro: said(10) });
      await type(app, "go");
      await until(app, "done");
      await press(app, CTRL_HOME);
      await pointer(mouse, at("press", 0, 2), at("drag", 98, 4), at("release", 98, 4));
      expect(reversed(app).slice(2, 5)).toEqual(["said 2.", "said 3.", "said 4."]);
      await type(app, "/tasks t1");
      await until(app, "t1 (find x), done");
      expect(reversed(app).slice(0, 20).join("")).toBe("");
    });
  });

  it("searches from the view's top, not the record's first line, when the view is scrolled down", async () => {
    const { app } = await record(logins());
    await press(app, PG_DOWN, PG_DOWN, PG_DOWN, PG_DOWN); // row 40, past the first login's row 32
    expect(shown(app)[0]).toBe("line 38.");
    await press(app, "/", "login", "\r");
    expect(shown(app)[0]).toBe("the login 60.");
    expect(shown(app)[20]).toBe('"login": 2 of 3 · n next · N previous');
  });

  it("leaves the view where it is for a match already on screen", async () => {
    const { app } = await record(logins());
    await press(app, "/", "line 5.");
    expect(shown(app)[0]).toBe("t1 (find x), done: 0 tool calls");
    expect(shown(app)[7]).toBe("line 5.");
  });

  it("does nothing on a paste while the view is open", async () => {
    const { app } = await mount([], { full: true });
    await press(app, "\u000f", "\u001b[200~pasted\u001b[201~", "q");
    expect(app.lastFrame()).toContain("\n›\n");
    expect(app.lastFrame()).not.toContain("pasted");
  });

  // On a very short terminal the view needs a row and its key row another, with the status line under them; the prompt's
  // cursor row is not kept, as the prompt is not drawn.
  it("keeps the key row, and the search typed in it, on a terminal four rows tall", async () => {
    const { app } = await mount([], { full: true, rows: 4 });
    await press(app, "\u000f");
    let rows = shown(app);
    expect(rows).toHaveLength(3);
    expect(rows.slice(0, 2)).toEqual(["No turn yet, so no tool calls to show.", KEYS]);
    await press(app, "/", "ab");
    rows = shown(app);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toBe("/ab (no match)");
  });

  // The view needs a row, and its key row and the tool line one each, with the status line: no row is kept for the
  // prompt's cursor, which the view does not draw (found at Task 12's review).
  it("keeps the tool line under the view on a terminal five rows tall", async () => {
    const { app } = await mount([callTool("c1", "read_file", { path: "a.txt" }), reply("done")], { full: true, rows: 5 });
    await type(app, "go");
    await until(app, "done");
    await press(app, "\u000f");
    const rows = shown(app);
    expect(rows).toHaveLength(4);
    expect(rows.slice(0, 2)).toEqual(["Last turn: 1 tool call", KEYS]);
    expect(rows[2]).toContain("lead fake:a");
    expect(rows[3]).toContain("read_file");
  });

  it("brings the queued messages back to the prompt when Ctrl-C in the view stops the turn", async () => {
    const { app } = await mount([], { full: true, lead: hanging() });
    await type(app, "hi");
    await type(app, "next"); // queued: a turn is running
    await until(app, "↑ to edit queued messages");
    await press(app, "\u000f", "\u0003");
    await gone(app, "Esc to stop");
    await press(app, "q");
    expect(app.lastFrame()).toContain("› next\n");
  });

  const long = (i: number) => `said ${i}. ${"word ".repeat(14).trimEnd()}`; // under 80 columns: one row at 99, two at 59

  it("wraps the view's lines again on a resize", async () => {
    const { app } = await record(lines(3, long));
    expect(shown(app)[3]).toBe(long(1));
    Object.defineProperty(app.stdout, "columns", { value: 60, configurable: true });
    app.stdout.emit("resize");
    await tick();
    const rows = shown(app, 60);
    expect(rows[2]).toMatch(/^said 0\. word/);
    expect(rows[3]).toMatch(/^word/);
    expect(rows[4]).toMatch(/^said 1\. word/);
  });

  // A record opened by the queue going on from a listener set up once, at mount: a question's answer (bindAsk), the end
  // of a turn the bus's tasks event started, and the end of a command clicked in the menu (the mouse's listener). Each
  // way it wraps at the width the terminal has then. They pass on the code as it is because each drawing wraps an open
  // view again (app/state.ts, `detail`'s re-wrap); they catch a listener reading an old drawing only if that re-wrap
  // goes. The last, a turn started before the resize opening the record from its own next(), is the one that pins
  // openDetail reading the width from `frame`.
  const narrow = async (app: ReturnType<typeof render>) => {
    Object.defineProperty(app.stdout, "columns", { value: 60, configurable: true });
    app.stdout.emit("resize");
    await tick();
  };
  const wrappedAt60 = (app: ReturnType<typeof render>) => {
    const rows = shown(app, 60);
    expect(rows[0]).toBe("t1 (find x), done: 0 tool calls");
    expect(rows[2]).toMatch(/^said 0\. word/);
    expect(rows[3]).toMatch(/^word/);
    expect(rows[4]).toMatch(/^said 1\. word/);
  };

  it("wraps a record opened after a resize at the new width, when a question's answer lets the queue go on", async () => {
    const lead = new Held();
    const worker = new FakeProvider("w", [reply(lines(3, long))]);
    const { app, ask, session } = await mount([], { full: true, lead, worker });
    await type(app, "go");
    lead.answer(callTool("c1", "delegate", { description: "find x", task: "find x" }));
    await waitFor(() => lead.asked.length === 2);
    lead.answer("done");
    await gone(app, "Esc to stop");
    await type(app, "hi");
    await type(app, "/tasks t1"); // queued: a turn is running
    const answer = ask("write a.txt");
    await until(app, "Allow write a.txt? [y/n]");
    lead.answer("ok"); // the turn ends, and the queue waits for the question
    await waitFor(() => session.messages.at(-1)?.role === "assistant");
    await narrow(app);
    await press(app, "y");
    expect(await answer).toBe(true);
    await until(app, "t1 (find x), done: 0 tool calls");
    wrappedAt60(app);
  });

  it("wraps a record opened after a resize at the new width, when a background subagent's ending starts the turn before it", async () => {
    const lead = new Held();
    const worker = new Held("fake:w");
    const { app } = await mount([], { full: true, lead, worker });
    await type(app, "go");
    lead.answer(callTool("c1", "delegate", { description: "find x", task: "find x", background: true }));
    await waitFor(() => lead.asked.length === 2);
    lead.answer("started it");
    await gone(app, "Esc to stop");
    await narrow(app);
    worker.answer(lines(3, long)); // the bus's tasks event: the lead, idle, reads t1's answer in a turn of its own
    await waitFor(() => lead.asked.length === 3);
    await type(app, "/tasks t1"); // queued: the turn reading t1's answer is running
    lead.answer("t1 says found");
    await until(app, "t1 (find x), done: 0 tool calls");
    wrappedAt60(app);
  });

  it("wraps a record opened after a resize at the new width, when a command clicked in the menu lets the queue go on", async () => {
    let signedIn!: () => void;
    const login: Login = () => new Promise<void>((resolve) => (signedIn = resolve));
    const worker = new FakeProvider("w", [reply(lines(3, long))]);
    const { app, mouse } = await mount([callTool("c1", "delegate", { description: "find x", task: "find x" }), reply("done")], { full: true, worker, login });
    await type(app, "go");
    await until(app, "done");
    await narrow(app);
    await press(app, "/lo");
    const row = shown(app, 60).findIndex((r) => r.startsWith("  /login chatgpt"));
    expect(row).toBeGreaterThan(-1);
    await pointer(mouse, ...click(4, row));
    await until(app, "Waiting for the browser");
    await type(app, "/tasks t1"); // queued while signing in
    signedIn();
    await until(app, "t1 (find x), done: 0 tool calls");
    wrappedAt60(app);
  });

  it("wraps a record opened after a resize at the new width, when the turn it waited for ends", async () => {
    const lead = new Held();
    const worker = new FakeProvider("w", [reply(lines(3, long))]);
    const { app } = await mount([], { full: true, lead, worker });
    await type(app, "go");
    lead.answer(callTool("c1", "delegate", { description: "find x", task: "find x" }));
    await waitFor(() => lead.asked.length === 2);
    lead.answer("done");
    await gone(app, "Esc to stop");
    await type(app, "hi");
    await type(app, "/tasks t1"); // queued: a turn is running
    await narrow(app);
    lead.answer("ok"); // the turn, started at 100 columns, ends, and its own next() opens the record
    await until(app, "t1 (find x), done: 0 tool calls");
    wrappedAt60(app);
  });

  it("goes round to the first match when every match is above the view", async () => {
    const { app } = await record(logins());
    await press(app, "G", "/", "login 30");
    expect(shown(app)[0]).toBe("the login 30.");
    await press(app, "\r");
    expect(shown(app)[20]).toBe('"login 30": 1 of 1 · n next · N previous');
  });

  it("drops a search on Enter when nothing matches", async () => {
    const { app } = await record(logins());
    await press(app, "/", "zzz", "\r");
    expect(shown(app)[20]).toBe(KEYS);
    await press(app, "n");
    expect(shown(app)[0]).toBe("t1 (find x), done: 0 tool calls");
  });

  it("keeps the search row while a search is typed, not putting the line about a copy in its place", async () => {
    const { app, mouse, copies } = await record(logins());
    await press(app, "/", "line 1."); // on screen, on row 3: the view stays
    await pointer(mouse, at("press", 0, 3), at("drag", 98, 3), at("release", 98, 3));
    expect(copies).toEqual(["line 1."]);
    expect(shown(app)[20]).toBe("/line 1.");
  });

  // The checks that the view is still open, for keys read together.
  it("leaves the conversation where it is for a G read with the q that closes the view", async () => {
    const { app } = await mount([], { full: true, intro: said(60) });
    await press(app, PG_UP);
    expect(shown(app)[0]).toBe("said 30.");
    await press(app, "\u000f", "qG");
    expect(shown(app)[0]).toBe("said 30.");
  });

  // The user's choice at Task 12's review.
  it("adds a paste to a search being typed, up to its first line break", async () => {
    const { app } = await record(logins());
    await press(app, "/", "\u001b[200~log\nmore\u001b[201~");
    expect(shown(app)[20]).toBe("/log");
    expect(shown(app)[0]).toBe("the login 30.");
  });

  it("takes away the last whole character on Backspace in a search", async () => {
    const { app } = await record(logins());
    await press(app, "/", "a🇦🇺", "\u007f");
    expect(shown(app)[20]).toBe("/a");
  });

  // Found at Task 12's review: a key read before a question is first drawn cannot open the view over it, so what it asked
  // for is said in the conversation.
  it("says the last turn in the conversation for a Ctrl+O read before a waiting question is drawn", async () => {
    const { app, ask } = await mount([], { full: true });
    void ask("run: ls");
    app.stdin.write("\u000f");
    await until(app, "Allow run: ls? [y/n]");
    expect(app.lastFrame()).toContain("No turn yet, so no tool calls to show.");
    expect(app.lastFrame()).not.toContain(KEYS);
  });

  it("shows a model list queued during the turn under the view without the key row, and the key row again once it closes", async () => {
    const lead = new Held();
    const { app } = await mount([], { full: true, lead, models: [{ provider: "fake", models: ["a", "b"] }] });
    await type(app, "hi");
    await until(app, "Esc to stop");
    await press(app, "\u001bp", "\u000f"); // Alt+P waits in the queue as /model; Ctrl+O opens the view
    lead.answer("ok");
    await until(app, "Filter:");
    await tick(); // the picker starts reading keys just after it first appears
    expect(app.lastFrame()).not.toContain(KEYS);
    await press(app, "\u001b"); // closes the list
    await gone(app, "Filter:");
    expect(shown(app)[21]).toBe(KEYS);
  });

  it("leaves the prompt, the model list and Ctrl+R's search alone while the view is open", async () => {
    const { app } = await mount([], { full: true, models: [{ provider: "fake", models: ["a"] }], past: ["about"] });
    await press(app, "\u000f", "x", "\u001bp", "\u0012");
    await tick();
    expect(shown(app)[21]).toBe(KEYS);
    expect(app.lastFrame()).not.toContain("Filter:");
    await press(app, "q");
    expect(shown(app)[20]).toBe("›");
    expect(app.lastFrame()).not.toContain("search:");
  });

  it("takes [ into a search being typed, as any letter", async () => {
    const { app } = await mount([], { full: true });
    await press(app, "\u000f", "/", "[");
    expect(shown(app)[21]).toBe("/[ (no match)");
  });
});

// `[` prints the detail view into the normal scrollback (release 5 design, "The detail view"; plan, Task 13), and `/screen`
// switches screens (Task 14), in orders that matter. The App is drawn by Ink to a stand-in terminal, as in "puts the
// terminal's cursor in the prompt": ink-testing-library's Ink is not interactive, so its suspendTerminal() neither erases
// the frame nor draws it again on resume. What Ink and the Screen write, and each call to the stand-in input, go into
// `steps` in order. `classic`: start in classic mode; `step`: called with each step as it is recorded.
const inks: Instance[] = [];
afterEach(() => {
  for (const ink of inks.splice(0)) ink.unmount();
});

async function onTerminal(
  lead: Provider,
  opts: {
    worker?: Provider;
    listModels?: AppProps["listModels"];
    classic?: boolean;
    intro?: AppProps["intro"];
    step?: (s: string) => void;
    home?: string; // the folder holding the settings file; sharedHome when not given
    columns?: number; // the terminal's width; 100 when not given
  } = {},
) {
  const worker = opts.worker ?? new FakeProvider("w", []);
  const steps: string[] = [];
  const record = (s: string) => {
    steps.push(s);
    opts.step?.(s);
  };
  const terminal = Object.assign(new EventEmitter(), { isTTY: true, columns: opts.columns ?? 100, rows: 24, write: (s: string) => (record(s), true) });
  const typed: string[] = [];
  const keyboard = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode() {},
    setEncoding() {},
    resume() {},
    pause() {},
    ref() {},
    unref() {},
    read: () => typed.shift() ?? null,
  });
  let reader: ((keys: string) => void) | null = null;
  const input = {
    hold: (on: boolean) => record(`hold(${on})`),
    divert: (to: ((keys: string) => void) | null) => {
      reader = to;
      record(to ? "divert(reader)" : "divert(null)");
    },
    release: () => record("release"),
    retake: () => record("retake"),
  };
  const bus = new Bus();
  const ctx = await tempContext();
  let ask: (s: string, d?: string, o?: Owner) => Promise<boolean> = async () => false;
  const gate = new PermissionGate("ask", (s, d, o) => ask(s, d, o));
  const tasks = new Tasks({ bus, max: 8, worker: () => worker, system: "sub", tools: SUBAGENT_TOOLS, ctx: { ...ctx, gate } });
  const tools = [...TOOLS, delegateTool(tasks, { headless: false })];
  const session = new Session({ lead, tools, system: "t", ctx: { ...ctx, gate }, bus, inbox: () => tasks.take() });
  const screen = new Screen(record, () => {});
  if (!opts.classic) screen.enter();
  const ink = renderInk(
    <App
      session={session}
      tasks={tasks}
      bus={bus}
      stats={new Stats(bus)}
      mode="ask"
      saved={unsaved()}
      onMode={() => {}}
      onRules={() => {}}
      project="proj"
      root={ctx.root}
      workspace={ctx.workspace}
      branch={null}
      historyFile={path.join(histories, `${nextHistory++}.jsonl`)}
      intro={opts.intro ?? []}
      errorFile={path.join(ctx.root, "errors.jsonl")}
      segments={SEGMENTS}
      makeProvider={() => new FakeProvider("b", [])}
      login={async () => {}}
      listModels={opts.listModels ?? (async () => [])}
      bindAsk={(fn) => {
        ask = fn;
      }}
      screen={screen}
      fullPossible
      input={input}
      scrollSpeed={3}
      clipboard={(report) => new Clipboard(() => {}, null, report)}
      readPicture={() => new Promise(() => {})} // never answers: no test reads the user's clipboard
      home={opts.home ?? sharedHome}
    />,
    { stdout: terminal as never, stdin: keyboard as never, debug: false, patchConsole: false, exitOnCtrlC: false, interactive: true },
  );
  inks.push(ink);
  await tick();
  return {
    steps,
    ink,
    terminal,
    session,
    bus,
    // Each key in its own read, to Ink.
    key: async (...keys: string[]) => {
      for (const k of keys) {
        typed.push(k);
        keyboard.emit("readable");
        await tick();
      }
    },
    // Keys read at once, with nothing else let run before the next step. Several wait together, and Ink reads and handles
    // each in turn with nothing let run between them (Ink's components/App.js, handleReadable).
    now: (...keys: string[]) => {
      typed.push(...keys);
      keyboard.emit("readable");
    },
    // A read while the view is printed out, to the reader the App diverted the keys to, or to Ink once it has let them
    // go, as the InputFilter does.
    out: async (keys: string) => {
      if (reader) reader(keys);
      else {
        typed.push(keys);
        keyboard.emit("readable");
      }
      await tick();
    },
    ask: (s: string, d?: string) => ask(s, d),
  };
}
// The steps from the last `mark` on, and what they show with the escape codes taken out.
const since = (steps: string[], mark: string) => steps.slice(steps.lastIndexOf(mark));
const text = (steps: string[]) => stripVTControlCharacters(steps.join(""));

describe("App's detail view printed out", () => {
  const KEYS = "j k ↑ ↓ line · g G Home End top, bottom · / search · [ print · q Esc close";
  const LAST = "Printed. q, Esc or Ctrl-C to go back.";

  // t1's record open in the view: a turn starts t1, whose answer has a blank line and a line longer than the terminal's
  // 100 columns, then /tasks t1.
  const LONG = "x".repeat(150);
  const record = async () => {
    const p = await onTerminal(new FakeProvider("a", [callTool("c1", "delegate", { description: "find x", task: "find x" }), reply("done")]), {
      worker: new FakeProvider("w", [reply(`one\n\nthree\n${LONG}`)]),
    });
    await p.key("go", "\r");
    await waitFor(() => p.session.messages.at(-1)?.role === "assistant");
    await p.key("/tasks t1", "\r");
    await waitFor(() => text(p.steps).includes("t1 (find x), done: 0 tool calls"));
    return p;
  };

  it("prints the view on [: keyboard held, mouse off, Ink suspended, the normal screen, the lines and how to go back, keys to a reader", async () => {
    await inColour(async () => {
      const { steps, key } = await record();
      steps.length = 0;
      await key("[");
      expect(steps[0]).toBe("hold(true)");
      expect(steps[1]).toBe(MOUSE_OFF);
      const first = steps.indexOf(FIRST_SCREEN);
      expect(steps.slice(2, first)).toContain("\u001b[?2004l"); // Ink suspended: its bracketed paste goes off
      expect(steps.slice(first + 1)).toHaveLength(3);
      const printed = steps[first + 1]!;
      // The long line wrapped at the terminal's 100 columns, not the view's 99 nor renderToString's own 80.
      const lines = ["t1 (find x), done: 0 tool calls", "Answer:", "one", "", "three", LONG.slice(0, 100), LONG.slice(100), LAST, ""];
      expect(stripVTControlCharacters(printed)).toBe(lines.join("\n"));
      expect(printed).toContain("\u001b[90mt1 (find x), done: 0 tool calls\u001b[39m"); // the view's colours: its lines are grey
      expect(printed).toContain(`\u001b[90m${LAST}\u001b[39m`);
      expect(steps[first + 2]).toBe(PASTE_ON); // so a paste comes marked, and the reader can drop it
      expect(steps[first + 3]).toBe("divert(reader)");
    });
  });

  it("prints the view at the terminal's width after a resize", async () => {
    const { steps, key, terminal } = await record();
    terminal.columns = 60;
    terminal.emit("resize");
    await tick();
    steps.length = 0;
    await key("[");
    const first = steps.indexOf(FIRST_SCREEN);
    const lines = ["t1 (find x), done: 0 tool calls", "Answer:", "one", "", "three", LONG.slice(0, 60), LONG.slice(60, 120), LONG.slice(120), LAST, ""];
    expect(stripVTControlCharacters(steps[first + 1]!)).toBe(lines.join("\n"));
  });

  it("comes back on q, not on other keys: the reader let go, the second screen, the mouse on, the view drawn again, then the keyboard", async () => {
    const { steps, key, out } = await record();
    await key("[");
    const before = steps.length;
    await out("x");
    await out("\u001b[A"); // an arrow key: its Escape is not Esc
    expect(steps).toHaveLength(before);
    await out("q");
    const back = since(steps, "divert(null)");
    expect(back.slice(0, 4)).toEqual(["divert(null)", PASTE_OFF, SECOND_SCREEN, MOUSE_ON]);
    expect(back.at(-1)).toBe("hold(false)");
    expect(back.slice(4, -1)).toContain(PASTE_ON); // Ink's resume turns its bracketed paste on again
    expect(text(back.slice(4, -1))).toContain("t1 (find x), done: 0 tool calls");
    expect(text(back.slice(4, -1))).toContain(KEYS);
    await key("q"); // the keys reach Ink again: q closes the view
    expect(text(since(steps, "hold(false)"))).toContain("›");
  });

  it.each([
    { name: "Esc", keys: "\u001b" },
    { name: "Ctrl-C", keys: "\u0003" },
    { name: "a q read after another key", keys: "xq" },
  ])("comes back on $name", async ({ keys }) => {
    const { steps, key, out } = await record();
    await key("[");
    await out(keys);
    expect(since(steps, "divert(null)").at(-1)).toBe("hold(false)");
  });

  it("goes on with the turn while printed out, drawing nothing, and the reply is in the conversation after coming back", async () => {
    const lead = new Held();
    const { steps, key, out, session } = await onTerminal(lead);
    await key("hi", "\r");
    await waitFor(() => text(steps).includes("Esc to stop"));
    await key("\u000f", "[");
    const printed = steps.length;
    lead.answer("the reply");
    await waitFor(() => session.messages.at(-1)?.role === "assistant");
    await tick();
    expect(steps).toHaveLength(printed); // nothing drawn while out
    await out("q");
    await key("q");
    expect(text(since(steps, "hold(false)"))).toContain("the reply");
  });

  it("comes back at once for a question, which shows", async () => {
    const { steps, key, ask } = await onTerminal(new FakeProvider("a", []));
    await key("\u000f", "[");
    expect(steps.at(-1)).toBe("divert(reader)");
    const answer = ask("write a.txt", "line 0.\nline 1.");
    await tick();
    const back = since(steps, "divert(null)");
    expect(back.slice(0, 4)).toEqual(["divert(null)", PASTE_OFF, SECOND_SCREEN, MOUSE_ON]);
    expect(back.at(-1)).toBe("hold(false)");
    expect(text(back)).toContain("Allow write a.txt? [y/n]");
    await key("y");
    expect(await answer).toBe(true);
  });

  // Found at Task 13's review: a question asked in the moment the view is going out, before Ink is suspended for it.
  it("prints the view and comes straight back for a question asked while it was going out", async () => {
    const { steps, key, now, ask } = await onTerminal(new FakeProvider("a", []));
    await key("\u000f");
    now("[");
    const answer = ask("write a.txt", "line 0.\nline 1.");
    await tick();
    const marks = since(steps, "hold(true)").filter((s) => s.startsWith("divert(") || s.startsWith("hold("));
    expect(marks).toEqual(["hold(true)", "divert(reader)", "divert(null)", "hold(false)"]);
    expect(steps).toContain(FIRST_SCREEN);
    expect(text(since(steps, "divert(null)"))).toContain("Allow write a.txt? [y/n]");
    await key("y");
    expect(await answer).toBe(true);
  });

  // Found at Task 13's review: a `[` read while coming back, before Ink's redraw has finished, prints the view out again;
  // the first coming back must not then let the keyboard go while the view is out, which with the InputFilter would turn
  // raw mode off and leave the console reading whole lines.
  it("keeps the keyboard held when [ prints the view out again before coming back has finished", async () => {
    const { steps, key, now, out } = await record();
    await key("[");
    const back = out("q");
    now("[");
    await back;
    await tick();
    const marks = since(steps, "divert(null)").filter((s) => s.startsWith("divert(") || s.startsWith("hold("));
    expect(marks).toEqual(["divert(null)", "hold(true)", "divert(reader)"]);
    await out("q");
    expect(since(steps, "divert(null)").at(-1)).toBe("hold(false)");
  });

  // The user's choice, 2026-10-28: a paste while printed out does nothing, as Windows Terminal's right-click pastes by
  // accident when nothing is selected; only a typed q, Esc or Ctrl-C comes back.
  it("does nothing on a paste holding q, Esc and Ctrl-C while printed out, and comes back on a q typed after it", async () => {
    const { steps, key, out } = await record();
    await key("[");
    const before = steps.length;
    await out("\u001b[200~a q\u001b\u0003 b\u001b[201~");
    expect(steps).toHaveLength(before);
    await out("q");
    expect(since(steps, "divert(null)").at(-1)).toBe("hold(false)");
  });

  it("does nothing on a paste over several reads, its end marker split between two, and comes back on a q after it", async () => {
    const { steps, key, out } = await record();
    await key("[");
    const before = steps.length;
    for (const read of ["\u001b[200~abc", "q", "\u001b", "x q\u001b[20", "1~"]) await out(read);
    expect(steps).toHaveLength(before);
    await out("xq");
    expect(since(steps, "divert(null)").at(-1)).toBe("hold(false)");
  });

  it("lets the keyboard go if Ink ends while printed out", async () => {
    const { steps, key, ink } = await onTerminal(new FakeProvider("a", []));
    await key("\u000f", "[");
    ink.unmount();
    const end = since(steps, "divert(reader)");
    expect(end.filter((s) => s.startsWith("divert(") || s.startsWith("hold("))).toEqual(["divert(reader)", "divert(null)", "hold(false)"]);
    expect(end).toContain(PASTE_OFF); // Ink's own cleanup turns bracketed paste off, suspended or not
    expect(end).not.toContain(SECOND_SCREEN);
  });

  // The user's choice, 2026-10-28: the model list waits for the view to come back. Opening it while printed out would end
  // Ink's paste hook, and Ink would turn bracketed paste off at once, suspended or not, so a paste would come as keys.
  it("keeps a /model queued during the turn waiting while printed out, and opens the list once the view comes back", async () => {
    const lead = new Held();
    const { steps, key, out } = await onTerminal(lead);
    await key("hi", "\r");
    await waitFor(() => text(steps).includes("Esc to stop"));
    await key("\u001bp", "later", "\r", "\u000f", "["); // Alt+P waits in the queue as /model, a message behind it
    lead.answer("ok");
    await tick();
    await tick();
    expect(since(steps, "divert(reader)")).not.toContain(PASTE_OFF);
    expect(lead.asked).toHaveLength(1); // the message waits behind the list
    await out("q");
    await waitFor(() => text(since(steps, "divert(null)")).includes("Filter:"));
    expect(lead.asked).toHaveLength(1); // and waits while the list is open, as before
  });

  it("keeps the model list of a /model sent before [ waiting while printed out, and opens it once the view comes back", async () => {
    let lists!: (groups: ModelGroup[]) => void;
    const { steps, key, out } = await onTerminal(new FakeProvider("a", []), { listModels: () => new Promise((resolve) => (lists = resolve)) });
    await key("/model", "\r", "\u000f", "[");
    lists([{ provider: "fake", models: ["a"] }]);
    await tick();
    expect(since(steps, "divert(reader)")).not.toContain(PASTE_OFF);
    await out("q");
    await waitFor(() => text(since(steps, "divert(null)")).includes("Filter:"));
  });

  // A subagent's record would take the printed view's place unseen: it waits too, so the view comes back as printed.
  it("keeps a /tasks t1 queued during the turn waiting while printed out, and opens the record once the view comes back", async () => {
    const worker = new Held();
    const turns = [callTool("c1", "delegate", { description: "find x", task: "find x" }), reply("done")];
    const { steps, key, out } = await onTerminal(new FakeProvider("a", turns), { worker });
    await key("go", "\r");
    await waitFor(() => worker.asked.length === 1);
    await key("/tasks t1", "\r", "\u000f", "[");
    worker.answer("found");
    await tick();
    await tick();
    await out("q");
    await waitFor(() => text(since(steps, "divert(null)")).includes("t1 (find x), done"));
    const back = text(since(steps, "divert(null)"));
    expect(back.indexOf("Last turn: 1 tool call")).toBeGreaterThan(-1); // the printed view, drawn again first
    expect(back.indexOf("Last turn: 1 tool call")).toBeLessThan(back.indexOf("t1 (find x), done"));
  });

  // Found at round 3's check: Ink ending as the view comes back (a crash in its redraw, say) must not start what waited,
  // a paid turn with no screen to show it.
  it("starts nothing that waited when Ink ends as the view comes back, and lets the keyboard go", async () => {
    const lead = new Held();
    const worker = new Held();
    const { steps, key, out, ink } = await onTerminal(lead, { worker });
    await key("go", "\r");
    lead.answer(callTool("c1", "delegate", { description: "find x", task: "find x" }));
    await waitFor(() => worker.asked.length === 1);
    await key("/tasks t1", "\r", "later", "\r", "\u000f", "[");
    worker.answer("found");
    await waitFor(() => lead.asked.length === 2);
    lead.answer("done");
    await tick();
    expect(lead.asked).toHaveLength(2); // the queue waits behind /tasks t1 while printed out
    const back = out("q");
    ink.unmount();
    await back;
    await tick();
    expect(lead.asked).toHaveLength(2);
    expect(steps.filter((s) => s.startsWith("hold(")).at(-1)).toBe("hold(false)");
  });

  it("goes on with a message queued during the turn while printed out", async () => {
    const lead = new Held();
    const { steps, key } = await onTerminal(lead);
    await key("hi", "\r");
    await waitFor(() => text(steps).includes("Esc to stop"));
    await key("next", "\r", "\u000f", "[");
    lead.answer("ok");
    await waitFor(() => lead.asked.length === 2);
    expect(steps.at(-1)).toBe("divert(reader)"); // still printed out
  });

  // The user's choice, 2026-10-28: a question coming while a paste comes in brings the view back, and the rest of the
  // paste is dropped up to its end, so a y in it never answers the question.
  it("drops the rest of a paste still coming when a question brings the view back, and takes keys again after its end", async () => {
    const { steps, key, out, ask } = await record();
    await key("[");
    await out("\u001b[200~abc");
    let answered: boolean | undefined;
    void ask("write a.txt", "line 0.").then((ok) => (answered = ok));
    await tick();
    expect(text(since(steps, PASTE_OFF))).toContain("Allow write a.txt? [y/n]");
    expect(since(steps, PASTE_OFF).at(-1)).toBe("hold(false)");
    await out("y y");
    await out("y\u001b[20");
    await out("1~");
    expect(answered).toBeUndefined();
    expect(steps.at(-1)).toBe("divert(null)");
    await out("y");
    await waitFor(() => answered === true);
  });

  // Found at Task 13's code review: a paste starting in the read that comes back is dropped to its end as well, as the
  // InputFilter, inside that paste, passes the next reads on whole, and Ink would take the pasted q as closing the view.
  it("drops the rest of a paste that starts in the read that comes back, and takes keys again after its end", async () => {
    const { steps, key, out } = await record();
    await key("[");
    await out("q\u001b[200~ab");
    expect(since(steps, "divert(reader)").at(-1)).toBe("hold(false)"); // back, the keys still to the App to drop
    await out("cq\u001b[201~");
    expect(steps.at(-1)).toBe("divert(null)");
    expect(text(since(steps, PASTE_OFF))).not.toContain("›"); // the view stays open: no prompt drawn
    await key("q"); // typed after the paste, it closes the view
    expect(text(since(steps, "divert(null)"))).toContain("›");
  });

  it("lets the keyboard go if Ink ends while the rest of a paste is dropped", async () => {
    const { steps, key, out, ask, ink } = await record();
    await key("[");
    await out("\u001b[200~abc");
    void ask("write a.txt", "line 0.");
    await tick();
    ink.unmount();
    expect(steps.filter((s) => s.startsWith("divert(")).at(-1)).toBe("divert(null)");
    expect(steps.filter((s) => s.startsWith("hold(")).at(-1)).toBe("hold(false)");
  });
});

describe("App's /screen", () => {
  const intro = [1, 2, 3, 4, 5].map((i) => ({ text: `line ${i}.` }));
  const holds = (steps: string[]) => steps.filter((s) => s.startsWith("hold("));
  const inOrder = (...at: number[]) => at.every((n, i) => n >= 0 && (i === 0 || n > at[i - 1]!));
  const switched = async (key: (...keys: string[]) => Promise<void>, steps: string[], to: "full" | "classic") => {
    const from = steps.length;
    await key("/screen", "\r");
    await waitFor(() => text(steps.slice(from)).includes(`screen is now ${to}`));
    return since(steps, "hold(true)");
  };
  // What Ink first draws after step `at`: the first step that is not the input's and shows anything.
  const firstDrawn = (s: string[], at: number) =>
    text(s.slice(at + 1).filter((x) => !x.startsWith("hold(") && !x.startsWith("divert(") && stripVTControlCharacters(x).trim()).slice(0, 1));

  // Release 5 plan, Task 14, tests 1 and 4; the probe's flash (plan, "Before you start"): nothing is drawn before leaving.
  it("goes to classic: keyboard held, nothing drawn, Ink suspended, mouse off, the normal screen, resumed, every line printed, keyboard let go", async () => {
    const { steps, key } = await onTerminal(new FakeProvider("a", []), { intro });
    const s = await switched(key, steps, "classic");
    const suspended = s.indexOf(PASTE_OFF); // Ink's suspend turns its bracketed paste off
    const leave = s.indexOf(MOUSE_OFF);
    const resumed = s.indexOf(PASTE_ON, leave); // and its resume on again
    const free = s.indexOf("hold(false)");
    expect(inOrder(0, suspended, leave, resumed, free)).toBe(true);
    expect(s[leave + 1]).toBe(FIRST_SCREEN);
    expect(text(s.slice(1, suspended))).not.toContain("line 1."); // the full-screen frame is not drawn again first
    const printed = text(s.slice(leave).filter((x) => x !== "hold(false)"));
    expect(printed.trimStart().startsWith("line 1.")).toBe(true); // nor on the normal screen
    expect(inOrder(...intro.map((l) => printed.indexOf(l.text)), printed.indexOf("screen is now classic"), printed.indexOf("proj"))).toBe(true);
  });

  // Found at Task 14's re-review: a /screen run from the queue sets its state outside any key, so React draws it only later,
  // by its scheduler; without the wait, Ink's resume would draw the full-screen frame again on the normal screen.
  it("draws no full-screen frame on the normal screen for a /screen run from the queue", async () => {
    const lead = new Held();
    const { steps, key } = await onTerminal(lead, { intro });
    await key("hi", "\r");
    await waitFor(() => text(steps).includes("Esc to stop"));
    await key("/screen", "\r");
    lead.answer("ok");
    await waitFor(() => text(steps).includes("screen is now classic"));
    const s = since(steps, "hold(true)");
    const after = text(s.slice(s.indexOf(FIRST_SCREEN)));
    expect(after.split("line 1.")).toHaveLength(2); // printed once, by <Static>, with no frame drawn again first
  });

  it("goes back to full: keyboard held, Ink suspended, the second screen, mouse on, the view with every line drawn on resuming, keyboard let go", async () => {
    const { steps, key } = await onTerminal(new FakeProvider("a", []), { intro });
    await switched(key, steps, "classic");
    const s = await switched(key, steps, "full");
    const suspended = s.indexOf(PASTE_OFF);
    const enter = s.indexOf(SECOND_SCREEN);
    const resumed = s.indexOf(PASTE_ON, enter);
    const free = s.indexOf("hold(false)");
    expect(inOrder(0, suspended, enter, resumed, free)).toBe(true);
    expect(s[enter + 1]).toBe(MOUSE_ON);
    expect(text(s.slice(enter + 2, resumed))).not.toContain("line"); // nothing drawn on the second screen before resuming
    // What resuming draws first is the conversation view, committed before it, not the classic frame (the probe's flash).
    const drawn = firstDrawn(s, resumed);
    expect(inOrder(...intro.map((l) => drawn.indexOf(l.text)), drawn.indexOf("screen is now classic"))).toBe(true);
    expect(text(s.slice(free))).toContain("screen is now full");
  });

  it("goes to full screen from a session started in classic mode, the view holding every line said before", async () => {
    const { steps, key } = await onTerminal(new FakeProvider("a", []), { classic: true, intro });
    const s = await switched(key, steps, "full");
    const enter = s.indexOf(SECOND_SCREEN);
    expect(s[enter + 1]).toBe(MOUSE_ON);
    const drawn = firstDrawn(s, s.indexOf(PASTE_ON, enter));
    expect(inOrder(...intro.map((l) => drawn.indexOf(l.text)))).toBe(true);
    expect(holds(s)).toEqual(["hold(true)", "hold(false)"]);
  });

  it("refuses words after /screen, and the / menu and the unknown command's list name it", async () => {
    const { app } = await mount([], { full: true });
    await type(app, "/screen now");
    await until(app, "/screen takes nothing after it.");
    expect(app.lastFrame()).not.toContain("screen is now");
    await type(app, "/nope");
    await until(app, "Unknown command: /nope.");
    expect(app.lastFrame()!.replaceAll(/ *\n */g, " ")).toContain("/errors, /screen, /settings, /keybindings, /vim, /exit"); // a long line wraps
    await press(app, "/", "s");
    expect(app.lastFrame()).toContain("› /s\n  /screen  Switch between full screen and classic\n");
  });

  // Found at the final review: where the session started in classic as full screen can't draw (the output is not a
  // terminal, or CI), /screen says so in grey, as a note, and stays in classic.
  it("stays in classic, saying why, where full screen can't draw", async () => {
    await inColour(async () => {
      const writes: string[] = [];
      const { app } = await mount([], { fullPossible: false, written: (s) => writes.push(s) });
      await type(app, "/screen");
      await until(app, "Full screen needs a terminal (the output is not one, or CI is set)");
      expect(app.lastFrame()).toContain("\u001b[90mFull screen needs a terminal");
      expect(app.lastFrame()).not.toContain("screen is now");
      expect(writes).not.toContain(SECOND_SCREEN);
    });
  });

  // Found at Task 5's review: the bus listeners keep the first render's `say`, which must read the mode as it is now.
  it("shows a reply that comes after /screen to full screen in the conversation view", async () => {
    const { app } = await mount([reply("the reply")], { intro: said(3) });
    await type(app, "/screen");
    await until(app, "screen is now full");
    await type(app, "hi");
    await until(app, "the reply");
    const rows = shown(app);
    expect(rows).toHaveLength(23);
    expect(rows.slice(0, 7)).toEqual(["said 0.", "said 1.", "said 2.", "screen is now full", "> hi", "the reply", ""]);
  });

  it("prints a reply that comes after /screen to classic", async () => {
    const { app } = await mount([reply("the reply")], { full: true, intro: said(3) });
    await type(app, "/screen");
    await until(app, "screen is now classic");
    await type(app, "hi");
    await until(app, "the reply");
    expect(app.lastFrame()).toMatch(/^said 0\.\nsaid 1\.\nsaid 2\.\nscreen is now classic\n> hi\nthe reply\n›/);
  });

  // bindAsk is set up at mount too (Task 11): after a switch to full screen a question's detail is kept and brought into view.
  it("brings a question's detail into view after /screen to full screen", async () => {
    const { app, ask } = await mount([], { intro: said(60) });
    await type(app, "/screen");
    await until(app, "screen is now full");
    await press(app, PG_UP);
    expect(shown(app)[0]).not.toBe("said 0.");
    const answer = ask("write a.txt", "line 0.\nline 1.");
    await until(app, "Allow write a.txt? [y/n]");
    expect(shown(app).slice(17, 21)).toEqual(["┌ write a.txt (2 lines)", "line 0.", "line 1.", ""]);
    await press(app, "y");
    expect(await answer).toBe(true);
  });

  it("opens the last turn in the detail view after /screen to full screen", async () => {
    const { app } = await mount([reply("ok")]);
    await type(app, "hi");
    await until(app, "ok");
    await type(app, "/screen");
    await until(app, "screen is now full");
    await press(app, "\u000f");
    await until(app, "q Esc close");
    expect(app.lastFrame()).not.toContain("›");
  });

  // Found at Task 12's review: a /screen queued during the turn can run while the detail view is open.
  it("closes the detail view for a /screen queued during the turn", async () => {
    const lead = new Held();
    const { app } = await mount([], { full: true, lead });
    await type(app, "hi");
    await until(app, "Esc to stop");
    await type(app, "/screen");
    await press(app, "\u000f");
    await until(app, "q Esc close");
    lead.answer("ok");
    await until(app, "screen is now classic");
    expect(app.lastFrame()).not.toContain("q Esc close");
    await press(app, "x");
    expect(app.lastFrame()).toContain("› x");
  });

  it("keeps a /screen queued during the turn waiting while a question is open, and switches once it is answered", async () => {
    const lead = new Held();
    const { app, ask } = await mount([], { full: true, lead });
    await type(app, "hi");
    await until(app, "Esc to stop");
    await type(app, "/screen");
    const answer = ask("write a.txt", "line 0.");
    await until(app, "[y/n]");
    lead.answer("ok");
    await gone(app, "Esc to stop");
    await tick();
    expect(app.lastFrame()).not.toContain("screen is now");
    await press(app, "y");
    expect(await answer).toBe(true);
    await until(app, "screen is now classic");
  });

  // Ink is suspended while printed out, and a switch would suspend it again; and the user's rule, 2026-10-28: what would
  // change the printed view's screen unseen waits for it to come back (plan, Task 13).
  it("keeps a /screen queued during the turn waiting while the detail view is printed out, and switches once it comes back", async () => {
    const lead = new Held();
    const { steps, key, out } = await onTerminal(lead);
    await key("hi", "\r");
    await waitFor(() => text(steps).includes("Esc to stop"));
    await key("/screen", "\r", "\u000f", "[");
    lead.answer("ok");
    await tick();
    await tick();
    expect(steps.at(-1)).toBe("divert(reader)"); // still printed out, and no switch started
    await out("q");
    await waitFor(() => text(since(steps, "divert(null)")).includes("screen is now classic"));
    const back = since(steps, "divert(null)");
    expect(holds(back)).toEqual(["hold(false)", "hold(true)", "hold(false)"]);
    expect(back.indexOf(MOUSE_OFF)).toBeGreaterThan(back.indexOf("hold(true)"));
  });

  // A reply arriving in the middle of a switch, as the screen is switched: kept once, where the mode it lands in draws it.
  it.each([
    { to: "classic", full: true, mark: FIRST_SCREEN },
    { to: "full", full: false, mark: SECOND_SCREEN },
  ])("keeps a reply that arrives while switching to $to, once", async ({ to, full, mark }) => {
    let arrive: (() => void) | null = null;
    const { app, bus } = await mount([], { full, intro: said(3), written: (s) => s === mark && arrive?.() });
    arrive = () => {
      arrive = null;
      bus.emit("message", { role: "assistant", parts: [{ type: "text", text: "mid-switch reply" }] });
    };
    await type(app, "/screen");
    await until(app, `screen is now ${to}`);
    expect(app.lastFrame()!.split("mid-switch reply")).toHaveLength(2);
    expect(app.lastFrame()).toMatch(/said 2\.\nmid-switch reply\nscreen is now/);
  });

  // Found at Task 7's review: what the mouse was doing belongs to the screen before the switch.
  it("lets go of a held button and the wheel's carried fraction across a switch", async () => {
    const { app, mouse, copies } = await mount([], { full: true, intro: said(60), scrollSpeed: 0.5 });
    await wheel(mouse, "up"); // half a row carried
    await pointer(mouse, at("press", 2, 3));
    await type(app, "/screen");
    await until(app, "screen is now classic");
    await type(app, "/screen");
    await until(app, "screen is now full");
    const top = shown(app)[0];
    await wheel(mouse, "up");
    expect(shown(app)[0]).toBe(top); // the half row carried before is gone
    await pointer(mouse, at("drag", 8, 5), at("release", 8, 5));
    expect(copies).toEqual([]);
    expect(reversed(app).join("")).toBe("");
  });

  // Release 5 plan, "Before you start": if Ink ends during a switch (a render error), the keyboard is let go, so raw mode
  // goes off and the process can end, and nothing more is switched or said; nor does what was queued behind it start, a
  // paid turn with no screen to show it (the rule found at Task 13's round 3). Ink ends going to full screen once the
  // second screen is on, and going to classic as the switch starts, before its wait for React.
  it.each([
    { to: "full", classic: true, mark: SECOND_SCREEN, unwritten: [PASTE_ON] },
    { to: "classic", classic: false, mark: "hold(true)", unwritten: [MOUSE_OFF, FIRST_SCREEN, PASTE_ON] },
  ])("lets the keyboard go and goes no further if Ink ends during a switch to $to", async ({ classic, mark, unwritten }) => {
    const lead = new Held();
    let end: (() => void) | null = null;
    const p = await onTerminal(lead, { classic, step: (s) => s === mark && end?.() });
    end = () => {
      end = null;
      p.ink.unmount();
    };
    await p.key("hi", "\r");
    await waitFor(() => text(p.steps).includes("Esc to stop"));
    await p.key("/screen", "\r", "later", "\r");
    lead.answer("ok");
    await waitFor(() => end === null);
    await tick();
    const s = since(p.steps, "hold(true)");
    expect(holds(s)).toEqual(["hold(true)", "hold(false)", "hold(false)"]); // Ink's cleanup's, then the switch's (input.ts, hold)
    expect(text(s)).not.toContain("screen is now");
    for (const code of unwritten) expect(since(s, mark).slice(1)).not.toContain(code); // nothing more switched, never resumed
    expect(lead.asked).toHaveLength(1);
  });

  // Found at the final review: a signal ends the process as Ink unmounts, so the switch's own ending, later, never comes,
  // and the cleanup lets the keyboard go itself.
  it("lets the keyboard go as Ink ends during a switch, before the switch's own ending", async () => {
    let p: Awaited<ReturnType<typeof onTerminal>> | undefined;
    let atEnd: string[] | undefined;
    const step = (s: string) => {
      if (s !== "hold(true)" || atEnd) return;
      const from = p!.steps.length;
      p!.ink.unmount();
      atEnd = p!.steps.slice(from).filter((x) => x.startsWith("hold(") || x.startsWith("divert("));
    };
    p = await onTerminal(new FakeProvider("a", []), { step });
    await p.key("/screen", "\r");
    expect(atEnd).toEqual(["divert(null)", "hold(false)"]);
  });

  // Found at the final review: going to full screen suspends Ink in the handler of the Enter that sends /screen, and Ink
  // goes on through the keys it read with it. A Ctrl+O among them opens the detail view, and a `[` would suspend Ink
  // again, which throws, ending the process; so it does nothing.
  it("does nothing on a [ read with the Enter that sends /screen from classic", async () => {
    const p = await onTerminal(new FakeProvider("a", []), { classic: true });
    await p.key("/screen");
    p.now("\r", "\u000f", "[");
    await waitFor(() => p.steps.includes(SECOND_SCREEN) && holds(since(p.steps, "hold(true)")).includes("hold(false)"));
    expect(holds(since(p.steps, "hold(true)"))).toEqual(["hold(true)", "hold(false)"]); // the switch's, nothing printed out
    expect(p.steps).not.toContain("divert(reader)");
    expect(text(since(p.steps, SECOND_SCREEN))).toContain("q Esc close"); // the detail view the Ctrl+O opened
    await p.key("q");
    await waitFor(() => text(p.steps).includes("screen is now full"));
    expect(text(p.steps)).not.toContain("Printed.");
  });

  // As in coming back from `[` (found at Task 13's review): a `[` read once Ink reads keys again, before the redraw of the
  // switch to full screen is done, prints the view out, and the switch then leaves the keyboard held.
  // This relies on Ink 7.1.1's timing of resume: the setImmediate below lands inside its waitUntilRenderFlush. An upgrade
  // of Ink may need the test reworked.
  it("keeps the keyboard held when [ prints the view out while going to full screen is still drawing", async () => {
    let p: Awaited<ReturnType<typeof onTerminal>> | undefined;
    let entered = false;
    const step = (s: string) => {
      if (s === SECOND_SCREEN) entered = true;
      else if (entered && s === PASTE_ON) {
        entered = false;
        setImmediate(() => { // Ink's resume reads keys again, then waits this long for its drawing (ink.js, waitUntilRenderFlush)
          p!.now("\u000f");
          p!.now("[");
        });
      }
    };
    p = await onTerminal(new FakeProvider("a", []), { classic: true, step });
    await p.key("/screen", "\r");
    await waitFor(() => p!.steps.at(-1) === "divert(reader)");
    expect(holds(since(p.steps, SECOND_SCREEN))).toEqual(["hold(true)"]); // the print-out's; the switch let nothing go
    await p.out("q");
    expect(p.steps.filter((x) => x.startsWith("hold(")).at(-1)).toBe("hold(false)");
  });

  // Found at the final review: a /screen sent while coming back from `[` is still drawing (Ctrl+O closing the view, then
  // the prompt, in one read) starts a switch before comeBack's resume ends, and comeBack must not let the keyboard go in
  // the middle of it. Deterministic, as only setTimeout is faked: Ink's resume here waits on setImmediate alone (ink.js,
  // waitUntilRenderFlush, with a terminal that has no writable state), while the switch waits on a setTimeout before it
  // suspends Ink (switchScreen), so comeBack's resume always ends first.
  it("keeps the keyboard held through a /screen sent while coming back from [ is still drawing", async () => {
    let p: Awaited<ReturnType<typeof onTerminal>> | undefined;
    let armed = false;
    const step = (s: string) => {
      if (!armed || s !== PASTE_ON) return;
      armed = false;
      setImmediate(() => p!.now("\u000f", "/screen", "\r")); // Ink's resume reads keys again, then waits
    };
    p = await onTerminal(new FakeProvider("a", []), { step });
    await p.key("\u000f", "[");
    await waitFor(() => p!.steps.at(-1) === "divert(reader)");
    const from = p.steps.length;
    armed = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const back = p.out("q");
      const turn = () => new Promise((resolve) => setImmediate(resolve));
      for (let i = 0; i < 10; i++) await turn(); // comeBack's resume ends; the switch waits on its setTimeout
      expect(p.steps.slice(from)).toContain("hold(true)"); // the switch started
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(50);
        await turn();
      }
      await back;
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => text(p.steps.slice(from)).includes("screen is now classic"));
    const s = since(p.steps, "hold(true)");
    // The switch's own release, after its resume turned bracketed paste on again on the normal screen; none before.
    expect(holds(s)).toEqual(["hold(true)", "hold(false)"]);
    expect(s.indexOf("hold(false)")).toBeGreaterThan(s.indexOf(PASTE_ON, s.indexOf(FIRST_SCREEN)));
  });

  // Found at Task 14's spec review: a reply of several lines is one line said but several kept, and going back to full
  // screen must still find every line said in classic mode (release 5 design, "The two modes": both modes keep every line).
  it("keeps every line, once and in order, going full to classic and back, with a reply of several lines", async () => {
    const { app } = await mount([reply("alpha\nbeta")], { full: true });
    await type(app, "hi");
    await until(app, "beta");
    await type(app, "/screen");
    await until(app, "screen is now classic");
    await type(app, "/tasks");
    await until(app, "No subagents yet.");
    await type(app, "/screen");
    await until(app, "screen is now full");
    expect(shown(app).slice(0, 8)).toEqual(["> hi", "alpha", "beta", "screen is now classic", "No subagents yet.", "screen is now full", "", ""]);
  });

  // Found at Task 14's spec review: a switch holds the queue as a turn does. What is sent while it runs waits for it, and a
  // second /screen then switches back, rather than suspending Ink while it is suspended already.
  it("runs what is sent during a switch after it, a second /screen too", async () => {
    const { app } = await mount([reply("ok")], { full: true });
    await press(app, "/screen");
    for (const keys of ["\r", "hi", "\r", "/screen", "\r"]) app.stdin.write(keys); // one after another, the switch running
    await until(app, "screen is now full");
    const frame = app.lastFrame()!;
    expect(frame).not.toContain("suspended");
    expect(inOrder(...["screen is now classic", "> hi", "ok", "screen is now full"].map((s) => frame.indexOf(s)))).toBe(true);
  });

  // Found at Task 14's spec review: a question asked as the switch to full screen starts has its detail kept and brought
  // into view (plan, Task 11), as one asked in full screen has.
  it("brings into view the detail of a question asked as the switch to full screen starts", async () => {
    let question: (() => void) | null = null;
    const { app, ask } = await mount([], { intro: said(60), written: (s) => s === SECOND_SCREEN && question?.() });
    let answer: Promise<boolean> | undefined;
    question = () => {
      question = null;
      answer = ask("write a.txt", Array.from({ length: 100 }, (_, i) => `line ${i}.`).join("\n"));
    };
    await type(app, "/screen");
    await until(app, "Allow write a.txt? [y/n]");
    await waitFor(() => app.lastFrame()!.includes("screen is now full") || shown(app)[0] === "┌ write a.txt (100 lines)");
    expect(shown(app)[0]).toBe("┌ write a.txt (100 lines)");
    await press(app, "y");
    expect(await answer).toBe(true);
  });
});

describe("App in classic mode", () => {
  it("changes nothing on the mouse", async () => {
    const { app, mouse } = await mount([], { intro: said(80) });
    const frame = app.lastFrame();
    await wheel(mouse, "up", 3);
    await pointer(mouse, at("press", BAR, 0), at("drag", BAR, 10), at("release", BAR, 10));
    expect(app.lastFrame()).toBe(frame);
  });

  it("takes Shift+Up and Shift+Down as Up and Down, Ctrl+Home and Ctrl+End as Home and End, and does nothing on PgUp and PgDn", async () => {
    const { app } = await mount([], { intro: said(60) });
    await press(app, "a", "\n", "b", SHIFT_UP, "x");
    expect(app.lastFrame()).toContain("› ax\n  b");
    await press(app, SHIFT_DOWN, CTRL_HOME, ">", CTRL_END, "<");
    expect(app.lastFrame()).toContain("› ax\n  >b<");
    const frame = app.lastFrame();
    await press(app, PG_UP, PG_DOWN);
    expect(app.lastFrame()).toBe(frame);
  });

  it("does nothing on the scroll keys during Ctrl+R's search, as release 4 did", async () => {
    const { app } = await mount([], { intro: said(60), past: ["about"] });
    await press(app, "\u0012", "ab");
    await until(app, "search: ab ·");
    const frame = app.lastFrame();
    await press(app, PG_UP, PG_DOWN, SHIFT_UP, SHIFT_DOWN, CTRL_HOME, CTRL_END);
    expect(app.lastFrame()).toBe(frame);
  });

  it("does nothing on the scroll keys at a question, as release 4 did", async () => {
    const { app, ask } = await mount([], { intro: said(60) });
    void ask("write a.txt");
    await until(app, "Allow write a.txt? [y/n] · Esc to decline");
    const frame = app.lastFrame();
    await press(app, PG_UP, PG_DOWN, SHIFT_UP, SHIFT_DOWN, CTRL_HOME, CTRL_END);
    expect(app.lastFrame()).toBe(frame);
  });
});

// The keys as a table of actions (release 6 design, "Keys become named actions", "Bindings come first"; plan, Task 6).
describe("App's keys from the table of actions", () => {
  // The default table with `keys` laid over one context's.
  const table = (context: Context, keys: Record<string, string | null>) =>
    new Bindings(tableOf({ ...DEFAULTS, [context]: { ...DEFAULTS[context], ...keys } }));
  const todo: TodoItem[] = [{ text: "write the fix", status: "pending" }];
  const CTRL_X = "\u0018";

  it("takes Ctrl+E from the editor's end-of-line when the table binds it to chat:externalEditor", async () => {
    const editor = standInEditor();
    editor.next("edited");
    vi.stubEnv("VISUAL", editor.command("keep"));
    const { app } = await mount([], { bindings: table("Chat", { "ctrl+e": "chat:externalEditor" }) });
    await press(app, "ab", "\u0001", "\u0005"); // Ctrl+A, then Ctrl+E: the editor opens on the prompt
    await until(app, "› edited\n");
    expect(editor.given()!.text).toBe("ab");
    const { app: usual } = await mount([]);
    await press(usual, "ab", "\u0001", "\u0005", "x");
    expect(usual.lastFrame()).toContain("› abx\n");
  });

  // Release 6 plan, Task 23 (the spec review): `?` asks the contexts the prompt obeys, Scroll among them in full screen.
  it("leaves End out of ?'s line keys when Scroll binds it in full screen, and keeps it in classic mode", async () => {
    const bindings = table("Scroll", { end: "scroll:bottom" });
    const { app: full } = await mount([], { full: true, bindings });
    await press(full, "?");
    await until(full, "Keys:");
    expect(full.lastFrame()).toContain("  Ctrl+A Ctrl+E  line start, end · Home  line start · ");
    const { app: classic } = await mount([], { bindings });
    await press(classic, "?");
    expect(classic.lastFrame()).toContain("  Home End or Ctrl+A Ctrl+E  line start, end · ");
  });

  it("moves the to-do list's key to Ctrl+Y, Ctrl+T doing nothing, and lists Ctrl+Y on ?", async () => {
    const { app, bus } = await mount([], { bindings: table("Global", { "ctrl+t": null, "ctrl+y": "app:toggleTodos" }) });
    bus.emit("todo", todo);
    await tick();
    await press(app, "\u0014");
    expect(app.lastFrame()).toContain("☐ write the fix");
    await press(app, "\u0019");
    expect(app.lastFrame()).not.toContain("write the fix");
    await press(app, "?");
    expect(app.lastFrame()).toContain("  Ctrl+Y  show or hide the to-do list");
    expect(app.lastFrame()).not.toContain("Ctrl+T");
  });

  it("names the key chat:cancel is on in the working line, and stops the turn on it", async () => {
    const { app } = await mount([], { lead: hanging(), bindings: table("Chat", { escape: null, "ctrl+q": "chat:cancel" }) });
    await type(app, "hi");
    await until(app, "· Ctrl+Q to stop");
    await press(app, "\u0011");
    await gone(app, "Ctrl+Q to stop");
  });

  // Runs `body` on a fake clock (setTimeout and Date); `wait` moves it on by `ms`, then lets one turn of the event loop
  // pass (setImmediate is not faked), in which the screen is drawn again.
  const onFakeClock = async (body: (wait: (ms: number) => Promise<void>) => Promise<void>) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      await body(async (ms) => {
        await vi.advanceTimersByTimeAsync(ms);
        await new Promise((resolve) => setImmediate(resolve));
      });
    } finally {
      vi.useRealTimers();
    }
  };

  // Ctrl+X Ctrl+E is bound to a quiet action here: chat:externalEditor hands the terminal to an editor, which is tested
  // with the editor ("App's external editor").
  it("shows a chord's first key in the hint row until the second key, or for 3 s", async () => {
    const { app } = await mount([], { bindings: table("Chat", { "ctrl+x ctrl+e": "app:toggleTodos" }) });
    await onFakeClock(async (wait) => {
      app.stdin.write(CTRL_X);
      await wait(10);
      expect(app.lastFrame()).toContain("\nctrl+x ...\n");
      app.stdin.write("\u0005"); // Ctrl+X Ctrl+E
      await wait(10);
      expect(app.lastFrame()).not.toContain("ctrl+x");
      expect(app.lastFrame()).toContain("? for shortcuts");
      app.stdin.write(CTRL_X);
      await wait(2_980);
      expect(app.lastFrame()).toContain("\nctrl+x ...\n");
      await wait(20); // 3 s since Ctrl+X
      expect(app.lastFrame()).not.toContain("ctrl+x");
      expect(app.lastFrame()).toContain("? for shortcuts");
    });
  });

  // Each of the four keys moves the conversation: back up from the bottom, to the top, down from it, and to the bottom.
  const scrolls = async (app: ReturnType<typeof render>) => {
    const bottom = shown(app)[0];
    await press(app, PG_UP);
    expect(shown(app)[0]).not.toBe(bottom);
    await press(app, CTRL_HOME);
    expect(shown(app)[0]).toBe("said 0.");
    await press(app, PG_DOWN);
    expect(shown(app)[0]).not.toBe("said 0.");
    await press(app, CTRL_END);
    expect(shown(app)[0]).toBe(bottom);
  };

  it("scrolls on PgUp, PgDn, Ctrl+Home and Ctrl+End in full screen at the prompt, with a menu open, at a question and in Ctrl+R's search", async () => {
    const { app, ask } = await mount([], { full: true, intro: said(60), past: ["about"] });
    await scrolls(app);
    await press(app, "/");
    await until(app, "↑↓ choose");
    await scrolls(app);
    await press(app, "\u007f", "\u0012");
    await until(app, "search:");
    await scrolls(app);
    await press(app, "\u0003");
    const answer = ask("write a.txt");
    await until(app, "Allow write a.txt? [y/n] · Esc to decline");
    await scrolls(app);
    await press(app, "n");
    expect(await answer).toBe(false);
  });

  it("takes a letter bound in Chat as its action at the prompt, and types it into Ctrl+R's query", async () => {
    const { app, bus } = await mount([], { bindings: table("Chat", { x: "app:toggleTodos" }) });
    bus.emit("todo", todo);
    await tick();
    await press(app, "x");
    expect(app.lastFrame()).not.toContain("write the fix");
    expect(app.lastFrame()).toMatch(/^›$/m);
    await press(app, "\u0012", "x");
    expect(app.lastFrame()).toContain("search: x (no match) ·");
  });

  it("types q into Ctrl+R's query, and Esc still puts the match in the prompt", async () => {
    const { app } = await mount([], { past: ["quit now"] });
    await press(app, "\u0012", "q");
    expect(app.lastFrame()).toContain("› quit now\nsearch: q · Ctrl+R older · Enter send · Tab edit · Ctrl-C cancel");
    await press(app, "\u001b");
    expect(app.lastFrame()).toContain("› quit now\n? for shortcuts");
  });

  // A chord ending in a plain letter (plan, Task 6, "A chord under way comes first").
  const chord = () => table("Global", { "ctrl+x t": "app:toggleTodos" });

  it("completes a chord ending in a letter in Ctrl+R's query, and types a letter that does not complete it or comes after 3 s", async () => {
    const { app, bus } = await mount([], { bindings: chord(), past: ["quit now"] });
    bus.emit("todo", todo);
    await tick();
    await press(app, "\u0012", CTRL_X, "t");
    expect(app.lastFrame()).not.toContain("write the fix");
    expect(app.lastFrame()).toContain("search:  ·");
    await press(app, CTRL_X, "q");
    expect(app.lastFrame()).toContain("search: q ·");
    await onFakeClock(async (wait) => {
      app.stdin.write(CTRL_X);
      await wait(3_000);
      app.stdin.write("t");
      await wait(10);
    });
    expect(app.lastFrame()).toContain("search: qt (no match) ·");
    expect(app.lastFrame()).not.toContain("write the fix");
  });

  // PR #10's review: a letter bound in Select still goes into the model list's filter, as /resume's list takes it instead.
  it("types a letter bound in Select into the model list's filter", async () => {
    const { app } = await mount([], { bindings: table("Select", { j: "select:next" }), models: [{ provider: "fake", models: ["just", "slow"] }] });
    await type(app, "/model");
    await until(app, "fake:just");
    await tick(); // the picker starts reading keys just after it first appears
    await press(app, "j");
    expect(app.lastFrame()).toContain("Filter: j ·");
  });

  it("completes a chord ending in a letter in the model list's filter, and types a letter that does not complete it or comes after 3 s", async () => {
    const { app, bus } = await mount([], { bindings: chord(), models: [{ provider: "fake", models: ["quick", "slow"] }] });
    bus.emit("todo", todo);
    await type(app, "/model");
    await until(app, "fake:quick");
    await tick(); // the picker starts reading keys just after it first appears
    await press(app, CTRL_X, "t");
    expect(app.lastFrame()).toContain("Filter: (type to filter)");
    await press(app, CTRL_X, "q");
    expect(app.lastFrame()).toContain("Filter: q ·");
    await onFakeClock(async (wait) => {
      app.stdin.write(CTRL_X);
      await wait(3_000);
      app.stdin.write("u");
      await wait(10);
    });
    expect(app.lastFrame()).toContain("Filter: qu ·");
    await press(app, "\u001b");
    await gone(app, "Filter:");
    expect(app.lastFrame()).not.toContain("write the fix"); // hidden by the first chord
  });

  // Global's actions act wherever Global is in force (choice 19, the user's: "All three everywhere").
  it("shows the last turn on Ctrl+O at a question, in the conversation, the question staying", async () => {
    const { app, ask } = await mount([], { full: true });
    void ask("write a.txt");
    await until(app, "Allow write a.txt? [y/n] · Esc to decline");
    await press(app, "\u000f");
    expect(shown(app)[0]).toBe("No turn yet, so no tool calls to show.");
    expect(app.lastFrame()).toContain("Allow write a.txt? [y/n] · Esc to decline");
  });

  it("exits on Ctrl-D pressed twice at a question", async () => {
    const { app, ask } = await mount([]);
    let answered = false;
    void ask("write a.txt").then(() => (answered = true));
    await until(app, "Allow write a.txt? [y/n] · Esc to decline");
    await press(app, "\u0004");
    expect(app.lastFrame()).toContain("Allow write a.txt? [y/n] · Esc to decline\nPress Ctrl-D again to exit");
    await press(app, "\u0004", "y"); // gone: y answers nothing
    expect(answered).toBe(false);
  });

  // Two Escs read together reach Ink as one Esc with Alt, which release 5 took as Esc (Task 6's spec review).
  const ESC_ESC = "\u001b\u001b";

  it("stops a turn on two Escs read together", async () => {
    const { app } = await mount([], { lead: hanging() });
    await type(app, "hi");
    await until(app, "Esc to stop");
    await press(app, ESC_ESC);
    await gone(app, "Esc to stop");
  });

  it("closes the detail view on two Escs read together", async () => {
    const { app } = await mount([], { full: true });
    await press(app, "\u000f");
    expect(shown(app)[0]).toBe("No turn yet, so no tool calls to show.");
    await press(app, ESC_ESC);
    expect(shown(app)[0]).toBe("");
    expect(shown(app)).toContain("›");
  });

  it("declines a question on two Escs read together", async () => {
    const { app, ask } = await mount([]);
    const answer = ask("write a.txt");
    await until(app, "Allow write a.txt? [y/n] · Esc to decline");
    await press(app, ESC_ESC);
    expect(await answer).toBe(false);
    await until(app, "write a.txt: You declined this.");
  });

  it("warns at the first Ctrl-D in the detail view and in Ctrl+R's search", async () => {
    const { app } = await mount([], { full: true });
    await press(app, "\u000f", "\u0004");
    expect(shown(app)[0]).toBe("No turn yet, so no tool calls to show.");
    expect(app.lastFrame()).toContain("\nPress Ctrl-D again to exit\n");
    await press(app, "q", "\u0012", "\u0004");
    expect(app.lastFrame()).toContain("\nPress Ctrl-D again to exit\n");
    expect(app.lastFrame()).not.toContain("search:");
  });

  it("presses a wheel notch in a menu's contexts, Autocomplete first", async () => {
    const { app, mouse } = await mount([], { full: true, bindings: table("Autocomplete", { wheeldown: "autocomplete:next" }) });
    await press(app, "/", "e");
    await until(app, "  /exit  Quit");
    await wheel(mouse, "down");
    await press(app, "\t");
    // /export comes first, so a notch down is the second entry.
    expect(app.lastFrame()).toContain("› /errors");
  });

  it("scrolls on a wheel notch that drops a waiting chord, and takes the chord from the hint row", async () => {
    const { app, mouse } = await mount([], { full: true, intro: said(60) });
    const bottom = shown(app)[0];
    await press(app, CTRL_X);
    expect(app.lastFrame()).toContain("\nctrl+x ...\n");
    await wheel(mouse, "up");
    expect(shown(app)[0]).not.toBe(bottom);
    expect(app.lastFrame()).not.toContain("ctrl+x");
  });

  it("takes a dropped chord from the hint row on a wheel notch that has nowhere to scroll", async () => {
    const { app, mouse } = await mount([], { full: true, intro: said(60) });
    const bottom = shown(app)[0];
    await press(app, CTRL_X);
    expect(app.lastFrame()).toContain("\nctrl+x ...\n");
    await wheel(mouse, "down"); // following the bottom: the notch moves nothing
    expect(shown(app)[0]).toBe(bottom);
    expect(app.lastFrame()).not.toContain("ctrl+x");
  });

  // Task 6's code review: text read together is no keystroke, and drops a chord as any other key does.
  it("drops a waiting chord on text read together, so the next letter is typed", async () => {
    const { app, bus } = await mount([], { bindings: chord() });
    bus.emit("todo", todo);
    await tick();
    await press(app, CTRL_X, "ab", "t");
    expect(app.lastFrame()).toContain("☐ write the fix\n› abt\n? for shortcuts");
  });

  it("drops a waiting chord on a paste, so the next letter is typed", async () => {
    const { app, bus } = await mount([], { bindings: chord() });
    bus.emit("todo", todo);
    await tick();
    await press(app, CTRL_X, "\u001b[200~ab\u001b[201~", "t");
    expect(app.lastFrame()).toContain("☐ write the fix\n› abt\n? for shortcuts");
  });

  // Each hint names the keys a table leaves bound, in release 5's words (keys.ts, named).
  it("leaves out of the detail view's key row a group with no key, and its kept search's n with none", async () => {
    const { app } = await mount([], { full: true, bindings: table("Transcript", { "[": null, n: null }) });
    await press(app, "\u000f");
    expect(app.lastFrame()).toContain("\nj k ↑ ↓ line · g G Home End top, bottom · / search · q Esc close\n");
    await press(app, "/", "turn", "\r");
    expect(app.lastFrame()).toContain('\n"turn": 1 of 1 · N previous\n');
  });

  it("names the model list's moved keys in its help line", async () => {
    const bindings = table("Select", { up: null, down: null, "ctrl+p": "select:previous", "ctrl+n": "select:next" });
    const { app } = await mount([], { bindings, models: [{ provider: "fake", models: ["a", "b"] }] });
    await type(app, "/model");
    await until(app, "fake:a");
    expect(app.lastFrame()).toContain("Filter: (type to filter) · Ctrl+P Ctrl+N move · Enter picks · Esc closes");
  });

  it("names a menu's moved keys in its hint, leaving out what no key does", async () => {
    const bindings = new Bindings(
      tableOf({
        ...DEFAULTS,
        Autocomplete: { "ctrl+p": "autocomplete:previous", "ctrl+n": "autocomplete:next", escape: "autocomplete:dismiss" },
        Chat: { ...DEFAULTS.Chat, enter: null },
      }),
    );
    const { app, ctx } = await mount([], { bindings });
    await writeFile(path.join(ctx.root, "a.txt"), "");
    await press(app, "/");
    expect(app.lastFrame()).toContain("\nCtrl+P Ctrl+N choose · Esc close\n");
    await press(app, "\u007f", "@");
    await until(app, "  a.txt");
    expect(app.lastFrame()).toContain("\nCtrl+P Ctrl+N choose · Esc close\n");
  });

  it("names the key confirm:no is left on in a question's line", async () => {
    const { app, ask } = await mount([], { bindings: table("Confirmation", { escape: null }) });
    void ask("write a.txt");
    await until(app, "Allow write a.txt? [y/n] · n to decline");
  });
});

// Release 6 design, "The external editor"; plan, Task 12. Each test's editor is a stand-in (helpers.ts, standInEditor),
// set as VISUAL. While it runs Ink draws nothing (Ink's suspend), so the screen is looked at once it is back.
describe("App's external editor", () => {
  const CTRL_G = "\u0007";
  const flat = (app: ReturnType<typeof render>) => app.lastFrame()!.replaceAll("\n", " "); // a long line wraps
  const SET = `Set VISUAL or EDITOR, or "editor" in ${shownFile()}.`;

  it("opens the prompt in the editor on Ctrl+G and takes its text back, the cursor at the end, Ctrl+Z giving the text before", async () => {
    const editor = standInEditor();
    editor.next("after the edit\n");
    vi.stubEnv("VISUAL", editor.command("keep"));
    const { app } = await mount([]);
    await press(app, "before", "\u0001", CTRL_G); // Ctrl+A first: the cursor at the start
    await until(app, "› after the edit\n");
    expect(editor.given()!.text).toBe("before");
    await press(app, "!");
    expect(app.lastFrame()).toContain("› after the edit!\n");
    await press(app, "\u001a", "\u001a"); // Ctrl+Z: the typing, then the edit
    expect(app.lastFrame()).toContain("› before\n");
  });

  it("does the same on Ctrl+X Ctrl+E", async () => {
    const editor = standInEditor();
    editor.next("edited");
    vi.stubEnv("VISUAL", editor.command("keep"));
    const { app } = await mount([]);
    await press(app, "before", "\u0018", "\u0005");
    await until(app, "› edited\n");
  });

  it("shows what the turn said and a question it asked while the editor was open, once it is back", async () => {
    const editor = standInEditor();
    editor.next("edited");
    vi.stubEnv("VISUAL", editor.command("wait"));
    const { app, bus, ask } = await mount([]);
    await press(app, CTRL_G);
    await waitFor(editor.started);
    bus.emit("message", { role: "assistant", parts: [{ type: "text", text: "said while away" }] });
    const answer = ask("write a.txt");
    await tick();
    editor.go();
    await until(app, "Allow write a.txt? [y/n]");
    expect(app.lastFrame()).toContain("said while away");
    await press(app, "n");
    expect(await answer).toBe(false);
    expect(app.lastFrame()).toContain("› edited\n");
  });

  it("leaves the prompt as it was and says why when the editor fails, or is not found", async () => {
    const editor = standInEditor();
    vi.stubEnv("VISUAL", editor.command("fail"));
    const { app } = await mount([]);
    await press(app, "keep me", CTRL_G);
    await waitFor(() => flat(app).includes(`The editor failed (exit code 1). ${SET}`));
    expect(app.lastFrame()).toContain("› keep me\n");
    vi.stubEnv("VISUAL", "tachi-no-such-editor"); // cmd.exe prints its own "is not recognized" line to the inherited stderr
    await press(app, CTRL_G);
    await waitFor(() => flat(app).includes(`tachi-no-such-editor was not found. ${SET}`));
    expect(app.lastFrame()).toContain("› keep me\n");
  });

  // Nothing escapes as an unhandled rejection, which would end the program: here the terminal write that leaves full
  // screen fails, before the editor starts.
  it("says what went wrong when handing the terminal to the editor fails", async () => {
    const editor = standInEditor();
    vi.stubEnv("VISUAL", editor.command("keep"));
    let fail = false;
    const written = (s: string) => {
      if (fail && s === MOUSE_OFF) throw new Error("the terminal took no write");
    };
    const { app } = await mount([], { full: true, written });
    fail = true;
    await press(app, "keep me", CTRL_G);
    await waitFor(() => flat(app).includes("the terminal took no write"));
    expect(editor.given()).toBeNull();
    expect(app.lastFrame()).toContain("› keep me");
  });

  // The queue starts none of the commands that hand the terminal over while the editor has it; messages go on.
  // /keybindings makes its file as it starts, then opens the editor VISUAL names by then, the failing stand-in, whose
  // line shows that run has ended.
  type Shown = ReturnType<typeof render>;
  const keysFile = (home: string) => path.join(settingsDir(home), "keybindings.json");
  it.each([
    {
      command: "/screen",
      home: () => sharedHome,
      started: (app: Shown, _home: string) => flat(app).includes("screen is now full"),
      ended: (app: Shown, _home: string) => flat(app).includes("screen is now full"),
    },
    {
      command: "/keybindings",
      home: () => mkdtempSync(path.join(tmpdir(), "tachi-home-")),
      started: (_app: Shown, home: string) => existsSync(keysFile(home)),
      ended: (app: Shown, home: string) => existsSync(keysFile(home)) && flat(app).includes("The editor failed (exit code 1)"),
    },
  ])("holds a queued $command while the editor is open, and runs it once it closes", async ({ command, started, ended, ...made }) => {
    const editor = standInEditor();
    vi.stubEnv("VISUAL", editor.command("wait"));
    const lead = new Held();
    const home = made.home();
    if (home !== sharedHome) onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    const { app, session } = await mount([], { lead, home });
    await type(app, "go");
    await type(app, command);
    await press(app, CTRL_G);
    await waitFor(editor.started);
    vi.stubEnv("VISUAL", editor.command("fail"));
    lead.answer("done");
    await waitFor(() => session.messages.at(-1)?.role === "assistant");
    await tick();
    expect(started(app, home)).toBe(false);
    editor.go();
    await waitFor(() => ended(app, home));
    expect(flat(app)).not.toContain("suspended");
  });

  // As `[` does (printOut, comeBack): the mouse and the second screen go, and come back, Ink suspended meanwhile. A
  // program waits for no hold: the keyboard is let go of instead (owner.ts, program).
  it.each([
    { mode: "full screen", classic: false, marks: ["release", MOUSE_OFF, FIRST_SCREEN, SECOND_SCREEN, MOUSE_ON, "retake"] },
    { mode: "classic mode", classic: true, marks: ["release", "retake"] },
  ])("lets the keyboard go to the editor in $mode, leaving and coming back as [ does", async ({ classic, marks }) => {
    const editor = standInEditor();
    editor.next("edited");
    vi.stubEnv("VISUAL", editor.command("keep"));
    const { steps, key } = await onTerminal(new FakeProvider("a", []), { classic });
    steps.length = 0;
    await key(CTRL_G);
    await waitFor(() => steps.includes("retake"));
    const MARKS = ["release", "retake", "hold(true)", "hold(false)", MOUSE_OFF, MOUSE_ON, FIRST_SCREEN, SECOND_SCREEN];
    expect(steps.filter((s) => MARKS.includes(s))).toEqual(marks);
    await waitFor(() => text(since(steps, "retake")).includes("› edited"));
  });

  // Release 6 plan, choice 33 (the user's terminal checklist): with the editor in its own window, the terminal showed the
  // screen from before Tachikoma and nothing else, so it looked dead. A line says what it waits for, as Git does
  // (editor.c), once the screen is handed over, and is erased before Ink and full screen come back.
  const WAITING = "Waiting for your editor to close the file... (Tachikoma ignores Ctrl-C until then) ";
  const ERASE = "\r\u001b[K";
  it.each([
    { how: "Ctrl+G", mode: "full screen", classic: false },
    { how: "Ctrl+G", mode: "classic mode", classic: true },
    { how: "/settings", mode: "full screen", classic: false },
    { how: "/settings", mode: "classic mode", classic: true },
  ])("says it waits for the editor $how opens in $mode, and erases the line before the screen comes back", async ({ how, classic }) => {
    const editor = standInEditor();
    vi.stubEnv("VISUAL", editor.command("wait"));
    const home = mkdtempSync(path.join(tmpdir(), "tachi-home-"));
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    const { steps, key } = await onTerminal(new FakeProvider("a", []), { classic, home });
    steps.length = 0;
    if (how === "Ctrl+G") await key(CTRL_G);
    else await key("/settings", "\r");
    await waitFor(editor.started);
    expect(steps.filter((s) => s === WAITING || s === ERASE)).toEqual([WAITING]); // said while the editor runs
    editor.go();
    await waitFor(() => steps.includes("retake"));
    const MARKS = ["release", "retake", MOUSE_OFF, MOUSE_ON, FIRST_SCREEN, SECOND_SCREEN, WAITING, ERASE];
    const handed = classic ? [] : [MOUSE_OFF, FIRST_SCREEN];
    const back = classic ? [] : [SECOND_SCREEN, MOUSE_ON];
    expect(steps.filter((s) => MARKS.includes(s))).toEqual(["release", ...handed, WAITING, ERASE, ...back, "retake"]);
    expect(text(since(steps, "retake"))).not.toContain("Waiting for your editor"); // never in what Ink draws
  });

  // The code review of choice 33: an editor the shell cannot find still had the line written, and erased, and Tachikoma
  // comes back saying so. The shell's own error goes to the real terminal, after the line, which no test sees.
  it("writes and erases the waiting line for an editor that cannot start, and says it was not found", async () => {
    vi.stubEnv("VISUAL", "tachi-no-such-editor");
    const { steps, key } = await onTerminal(new FakeProvider("a", []), { classic: true });
    steps.length = 0;
    await key(CTRL_G);
    await waitFor(() => text(since(steps, "retake")).includes("tachi-no-such-editor was not found"));
    expect(steps.filter((s) => s === WAITING || s === ERASE || s === "retake")).toEqual([WAITING, ERASE, "retake"]);
  });

  // The code review of choice 33: a line wider than the terminal would wrap, and the erase take only its last row, so it
  // is cut to the width the App draws at, a column short.
  it("cuts the waiting line to a narrow terminal's width", async () => {
    const editor = standInEditor();
    vi.stubEnv("VISUAL", editor.command("keep"));
    const { steps, key } = await onTerminal(new FakeProvider("a", []), { classic: true, columns: 40 });
    steps.length = 0;
    await key(CTRL_G);
    await waitFor(() => steps.includes("retake"));
    expect(steps).toContain(WAITING.slice(0, 39));
    expect(steps).not.toContain(WAITING);
  });
});

// Release 6 design, "Stash"; plan, Task 13: one slot a session; the prompt and the slot swap when both have text.
describe("App's stash", () => {
  const CTRL_S = "\u0013";
  const LEFT = "\u001b[D";
  const CTRL_Q = "\u0011";
  const CTRL_Z = "\u001a";
  const STASHED = "Stashed · Ctrl+S to bring back";

  it("puts the prompt aside on Ctrl+S and brings it back on an empty prompt, the cursor where it was", async () => {
    const { app } = await mount([]);
    await press(app, "abcd", LEFT, LEFT, CTRL_S);
    expect(app.lastFrame()).toMatch(/^›$/m);
    await press(app, CTRL_S, "X");
    expect(app.lastFrame()).toContain("› abXcd\n? for shortcuts");
  });

  it("swaps the prompt and the slot when both have text", async () => {
    const { app } = await mount([]);
    await press(app, "one", CTRL_S, "two", CTRL_S);
    expect(app.lastFrame()).toContain(`› one\n${STASHED}`);
    await press(app, CTRL_S);
    expect(app.lastFrame()).toContain(`› two\n${STASHED}`);
  });

  it("shows the hint while the slot is full and no other hint takes the row: a menu's and the queue's come first", async () => {
    const { lead, release } = gated([reply("r1"), reply("r2")]);
    const { app } = await mount([], { lead });
    await press(app, "aside", CTRL_S);
    expect(app.lastFrame()).toContain(`›\n${STASHED}\n`);
    await press(app, "/");
    expect(app.lastFrame()).toContain("↑↓ choose");
    expect(app.lastFrame()).not.toContain("Stashed");
    await press(app, "\u007f", "go", "\r");
    await until(app, "Esc to stop");
    expect(app.lastFrame()).toContain(`›\n${STASHED}`); // during a turn too, where no hint shows otherwise
    await press(app, "later", "\r");
    expect(app.lastFrame()).toContain("›\n↑ to edit queued messages");
    release();
    await until(app, "r2");
    await press(app, CTRL_S);
    expect(app.lastFrame()).toContain("› aside\n? for shortcuts");
  });

  it("names the key chat:stash is bound to in the hint", async () => {
    const bindings = new Bindings(tableOf({ ...DEFAULTS, Chat: { ...DEFAULTS.Chat, "ctrl+s": null, "ctrl+q": "chat:stash" } }));
    const { app } = await mount([], { bindings });
    await press(app, "aside", CTRL_S);
    expect(app.lastFrame()).toContain("› aside\n? for shortcuts"); // Ctrl+S is bound to nothing now
    await press(app, CTRL_Q);
    expect(app.lastFrame()).toContain("›\nStashed · Ctrl+Q to bring back");
  });

  it("undoes within the text brought back", async () => {
    const { app } = await mount([]);
    // Backspace is a step of its own. On the cleared prompt Ctrl+Z takes nothing back: the steps went aside too.
    await press(app, "abc", "\u007f", CTRL_S, CTRL_Z);
    expect(app.lastFrame()).toMatch(/^›$/m);
    await press(app, CTRL_S, CTRL_Z);
    expect(app.lastFrame()).toContain("› abc\n");
    await press(app, CTRL_Z);
    expect(app.lastFrame()).toMatch(/^›$/m);
  });

  // Up after a stash starts again from the newest prompt, as after a clear: where Up had got to went with the text.
  it("steps back through the history from the newest prompt after a stash", async () => {
    const { app } = await mount([reply("r1"), reply("r2")]);
    await type(app, "one");
    await until(app, "r1");
    await type(app, "two");
    await until(app, "r2");
    await press(app, "\u001b[A", CTRL_S, "\u001b[A");
    expect(app.lastFrame()).toContain(`› two\n${STASHED}`);
  });

  // Final review: Ctrl+S after Up stashed the line Up showed and dropped the draft Up keeps, picture and all. The slot
  // keeps where Up had got to with the line, the draft included (choice 31).
  it("keeps the draft typed before Up with the line it stashes, Down bringing the draft back once that line is back", async () => {
    const PICTURE = process.platform === "win32" ? "\u001bv" : "\u0016"; // chat:imagePaste: Alt+V on Windows, else Ctrl+V
    const PNG = { mediaType: "image/png" as const, data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }; // a stand-in, never read from disk
    const pictures = new Pictures();
    const { app, session } = await mount([reply("seen")], { past: ["older"], pictures });
    await press(app, "draft ", PICTURE, "\u001b[A");
    expect(app.lastFrame()).toContain("› older\n");
    await press(app, CTRL_S, "\u001b[B");
    expect(app.lastFrame()).toMatch(/^›$/m); // Down: nothing, the walk went with the line
    await press(app, CTRL_S);
    expect(app.lastFrame()).toContain("› older\n");
    await press(app, "\u001b[B");
    expect(app.lastFrame()).toContain("› draft [Image #1]\n");
    pictures.set(1, PNG);
    await press(app, "\r");
    await until(app, "seen");
    expect(session.messages[0]!.parts).toEqual([{ type: "text", text: "draft " }, { type: "image", id: 1, ...PNG }]);
  });

  it("does nothing on Ctrl+S with an empty prompt and an empty slot", async () => {
    const { app } = await mount([]);
    const frame = app.lastFrame();
    await press(app, CTRL_S);
    expect(app.lastFrame()).toBe(frame);
    expect(frame).toContain("›\n? for shortcuts");
  });
});

// Release 6 plan, Task 14: a picture's marker is a span in the prompt, kept by the queue and the stash, and the message
// waits for its reads. The tests end each read through the session's Pictures; Task 15 reads the clipboard.
describe("App's pictures", () => {
  const PICTURE = process.platform === "win32" ? "\u001bv" : "\u0016"; // chat:imagePaste: Alt+V on Windows, else Ctrl+V
  const CTRL_S = "\u0013";
  const ESC = "\u001b";
  const PNG = { mediaType: "image/png" as const, data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }; // a stand-in, never read from disk
  const userParts = (session: Session) => session.messages.filter((m) => m.role === "user").map((m) => m.parts);

  it("waits on Enter for a picture still being read, then sends it with the picture in place", async () => {
    const pictures = new Pictures();
    const { app, session } = await mount([reply("seen")], { pictures });
    await press(app, "look at ", PICTURE);
    expect(app.lastFrame()).toContain("› look at [Image #1]");
    await press(app, "\r");
    expect(app.lastFrame()).toContain("Esc to stop");
    expect(session.messages).toEqual([]);
    pictures.set(1, PNG);
    await until(app, "seen");
    expect(userParts(session)).toEqual([[{ type: "text", text: "look at " }, { type: "image", id: 1, ...PNG }]]);
    expect(app.lastFrame()).toContain("> look at [Image #1]\n"); // in the conversation, one line (choice 22)
  });

  it("keeps the spans of a queued message and of the stash", async () => {
    const pictures = new Pictures();
    const { lead, release } = gated([reply("r1"), reply("r2"), reply("r3")]);
    const { app, session } = await mount([], { lead, pictures });
    await press(app, "first", "\r");
    await until(app, "Esc to stop");
    await press(app, PICTURE, " queued", "\r", "aside ", PICTURE, CTRL_S);
    pictures.set(1, PNG);
    pictures.set(2, PNG);
    release();
    await until(app, "r2");
    expect(userParts(session)[1]).toEqual([{ type: "image", id: 1, ...PNG }, { type: "text", text: " queued" }]);
    await press(app, CTRL_S, "\r");
    await until(app, "r3");
    expect(userParts(session)[2]).toEqual([{ type: "text", text: "aside " }, { type: "image", id: 2, ...PNG }]);
  });

  it("keeps a queued message's spans when Ctrl-C brings it back into the prompt", async () => {
    const pictures = new Pictures();
    const { lead } = gated([reply("ok")]); // the first request waits, and Ctrl-C stops it
    const { app, session } = await mount([], { lead, pictures });
    await press(app, "first", "\r");
    await until(app, "Esc to stop");
    await press(app, "see ", PICTURE, "\r", "\u0003");
    await gone(app, "Esc to stop");
    expect(app.lastFrame()).toContain("› see [Image #1]");
    pictures.set(1, PNG);
    await press(app, "\r");
    await until(app, "ok");
    expect(userParts(session).at(-1)).toEqual([{ type: "text", text: "see " }, { type: "image", id: 1, ...PNG }]);
  });

  it("sends a marker recalled from prompt history as text, carrying no picture", async () => {
    const pictures = new Pictures();
    const { app, session } = await mount([reply("ok")], { pictures, past: ["see [Image #1]"] });
    await press(app, PICTURE); // picture #1 in the prompt, never sent, so a recall that kept its span would send it
    pictures.set(1, PNG);
    await press(app, "\u001b[A", "\r");
    await until(app, "ok");
    expect(userParts(session)).toEqual([[{ type: "text", text: "see [Image #1]" }]]);
  });

  it("keeps the draft's pictures through Up and Down in the history", async () => {
    const pictures = new Pictures();
    const { app, session } = await mount([reply("ok")], { pictures, past: ["older"] });
    await press(app, "see ", PICTURE, "\u001b[A");
    expect(app.lastFrame()).toContain("› older\n");
    await press(app, "\u001b[B");
    expect(app.lastFrame()).toContain("› see [Image #1]\n");
    pictures.set(1, PNG);
    await press(app, "\r");
    await until(app, "ok");
    expect(userParts(session)).toEqual([[{ type: "text", text: "see " }, { type: "image", id: 1, ...PNG }]]);
  });

  // Release 6 design, "Which pictures a message carries": the editor's file is plain text, so on return a marker is a
  // span again only if it names a picture the prompt held when the editor opened.
  it("keeps a marker through the external editor as its picture, and takes one typed there as text", async () => {
    const editor = standInEditor();
    editor.next("now [Image #1] and [Image #2]\n");
    vi.stubEnv("VISUAL", editor.command("keep"));
    const pictures = new Pictures();
    const { app, session } = await mount([reply("ok")], { pictures });
    await press(app, "see ", PICTURE, "\u0007"); // Ctrl+G
    await until(app, "› now [Image #1] and [Image #2]\n");
    pictures.set(1, PNG);
    pictures.set(pictures.next(), PNG); // picture #2, which the prompt never held
    await press(app, "\r");
    await until(app, "ok");
    expect(userParts(session)).toEqual([[{ type: "text", text: "now " }, { type: "image", id: 1, ...PNG }, { type: "text", text: " and [Image #2]" }]]);
  });

  it("takes a marker the read found none of out of the draft Up keeps, so Down brings it back without it", async () => {
    const pictures = new Pictures();
    const { app } = await mount([], { pictures, past: ["older"] });
    await press(app, "see ", PICTURE, "\u001b[A");
    pictures.set(1, "none");
    await until(app, "No picture on the clipboard.");
    await press(app, "\u001b[B");
    expect(app.lastFrame()).toMatch(/› see ?\n/);
  });

  it("takes a marker the read found none of out of the prompt Ctrl+R gives back", async () => {
    const pictures = new Pictures();
    const { app } = await mount([], { pictures, past: ["older"] });
    await press(app, "see ", PICTURE, "\u0012"); // Ctrl+R
    pictures.set(1, "none");
    await until(app, "No picture on the clipboard.");
    await press(app, "\u0003"); // Ctrl-C: the prompt as it was
    expect(app.lastFrame()).toMatch(/› see ?\n/);
  });

  it("ends the reads as stopped when the detail view's Ctrl-C stops the turn during the wait, and the turn stops", async () => {
    const pictures = new Pictures();
    // A lead that refuses a request already stopped, as the real leads do: the Anthropic and OpenAI SDKs refuse a signal
    // already aborted, and fetch (ChatGPT) rejects at once.
    const lead: Provider = {
      id: "fake:a",
      complete: async ({ signal }) => {
        if (signal?.aborted) throw new Error("aborted");
        return reply("answered");
      },
    };
    const { app, session } = await mount([], { lead, pictures, full: true });
    await press(app, "look ", PICTURE, "\r", "\u000f", "\u0003"); // Ctrl+O opens the detail view, where Ctrl-C stops the turn
    await waitFor(() => session.messages.length > 0);
    await press(app, "q");
    await until(app, "Could not read the clipboard: stopped; [Image #1] was sent without it.");
    await gone(app, "Esc to stop");
    expect(userParts(session)).toEqual([[{ type: "text", text: "look" }]]);
    expect(app.lastFrame()).not.toContain("answered");
  });

  it("queues what is sent during the wait, sending it after the message waiting", async () => {
    const pictures = new Pictures();
    const { app, session } = await mount([reply("one"), reply("two")], { pictures });
    await press(app, "look ", PICTURE, "\r", "more", "\r");
    expect(app.lastFrame()).toContain("more");
    pictures.set(1, PNG);
    await until(app, "two");
    expect(userParts(session)).toEqual([[{ type: "text", text: "look " }, { type: "image", id: 1, ...PNG }], [{ type: "text", text: "more" }]]);
  });

  it("says nothing was sent when a message that was only a picture is left empty", async () => {
    const pictures = new Pictures();
    const { app, session } = await mount([reply("ok")], { pictures });
    await press(app, PICTURE, "\r");
    pictures.set(1, "none");
    await until(app, "No picture on the clipboard; nothing was sent.");
    await gone(app, "Esc to stop");
    expect(session.messages).toEqual([]);
  });

  it("sends without a picture whose read fails after Enter, its marker gone, and says so in red", async () => {
    await inColour(async () => {
      const pictures = new Pictures();
      const { app, session } = await mount([reply("ok")], { pictures });
      await press(app, "look ", PICTURE, " here", "\r");
      pictures.set(1, { failed: "access denied" });
      await until(app, "\u001b[31mCould not read the clipboard: access denied; [Image #1] was sent without it.");
      await until(app, "ok");
      expect(userParts(session)).toEqual([[{ type: "text", text: "look  here" }]]);
    });
  });

  it("sends without a picture the read found none of, and says so in grey", async () => {
    await inColour(async () => {
      const pictures = new Pictures();
      const { app, session } = await mount([reply("ok")], { pictures });
      await press(app, "look ", PICTURE, "\r");
      pictures.set(1, "none");
      await until(app, "\u001b[90mNo picture on the clipboard; [Image #1] was sent without it.");
      await until(app, "ok");
      expect(userParts(session)).toEqual([[{ type: "text", text: "look" }]]);
    });
  });

  it("takes a failed read's marker out of a queued message, which goes without it once the turn ends", async () => {
    const pictures = new Pictures();
    const { lead, release } = gated([reply("r1"), reply("r2")]);
    const { app, session } = await mount([], { lead, pictures });
    await press(app, "first", "\r");
    await until(app, "Esc to stop");
    await press(app, PICTURE, " later", "\r");
    pictures.set(1, { failed: "access denied" });
    await until(app, "Could not read the clipboard: access denied");
    expect(app.lastFrame()).not.toContain("was sent without it");
    release();
    await until(app, "r2");
    expect(userParts(session)[1]).toEqual([{ type: "text", text: "later" }]);
  });

  it("takes a marker the read found none of out of the prompt and the stash", async () => {
    const pictures = new Pictures();
    const { app } = await mount([], { pictures });
    await press(app, " ", PICTURE, CTRL_S, "b ", PICTURE); // the stash, left with a blank only, empties
    expect(app.lastFrame()).toContain("Reading picture..."); // in the hint row, over "Stashed", while a read runs (Task 15)
    await press(app, CTRL_S); // the two swap: the stash held the first marker
    expect(app.lastFrame()).toContain("›  [Image #1]");
    await press(app, CTRL_S);
    expect(app.lastFrame()).toContain("› b [Image #2]");
    pictures.set(1, "none");
    pictures.set(2, "none");
    await until(app, "No picture on the clipboard.\nNo picture on the clipboard.");
    expect(app.lastFrame()).toMatch(/› b ?\n\? for shortcuts/); // the stash, left empty, is gone too
  });

  // Found at the combined review: what Ctrl+K took, and vim's register, kept a failed read's marker, so Ctrl+Y or p put
  // back a marker for a picture that is gone.
  it("takes a failed read's marker out of what Ctrl+K took, so Ctrl+Y puts back none", async () => {
    const pictures = new Pictures();
    const { app, session } = await mount([reply("ok")], { pictures });
    await press(app, "a ", PICTURE, "\u0001", "\u000b"); // Ctrl+A, then Ctrl+K takes the line, marker and all
    pictures.set(1, { failed: "access denied" });
    await until(app, "Could not read the clipboard: access denied");
    await press(app, "\u0019", "\r"); // Ctrl+Y puts it back
    await until(app, "ok");
    expect(userParts(session)).toEqual([[{ type: "text", text: "a" }]]); // a message is sent trimmed
  });

  it("takes a failed read's marker out of vim's register, so p puts back none", async () => {
    const pictures = new Pictures();
    const { app, session } = await mount([reply("ok")], { pictures });
    await press(app, "/vim", "\r");
    await until(app, "editorMode is now vim");
    await press(app, "a ", PICTURE, ESC, "d", "d"); // dd takes the line, marker and all, into the register
    pictures.set(1, { failed: "access denied" });
    await until(app, "Could not read the clipboard: access denied");
    await press(app, "p", "\r");
    await until(app, "ok");
    expect(userParts(session)).toEqual([[{ type: "text", text: "a" }]]);
  });

  it.each([
    ["Esc", ESC],
    ["Ctrl-C", "\u0003"],
  ])("ends a read the message waits on when %s is pressed, and sends the message without it", async (_, key) => {
    const pictures = new Pictures();
    const { app, session } = await mount([reply("ok")], { pictures });
    await press(app, "look ", PICTURE, "\r", key);
    await until(app, "Could not read the clipboard: stopped; [Image #1] was sent without it.");
    await until(app, "ok");
    expect(userParts(session)).toEqual([[{ type: "text", text: "look" }]]);
    expect(pictures.get(1)).toEqual({ failed: "stopped" });
  });

  // Release 6 plan, Task 18: a request with pictures refused as invalid asks, on the permission question's line with no
  // owner, before sending again without them.
  const invalid = () => Object.assign(new Error("400 invalid image"), { status: 400 });
  const looked = [{ type: "text", text: "look " }, { type: "image", id: 1, ...PNG }];

  it("asks after a 400 to a request with pictures; y sends it again, says pictures are left out, and the queue goes on", async () => {
    const pictures = new Pictures();
    const { lead, fake, release } = gated([invalid(), reply("seen"), reply("next one")]);
    const { app, session } = await mount([], { lead, pictures });
    await press(app, "look ", PICTURE, "\r");
    pictures.set(1, PNG);
    await until(app, "Esc to stop");
    await press(app, "queued", "\r");
    release();
    await until(app, "Send again without the pictures? [y/n] · Esc to decline");
    expect(app.lastFrame()).toContain("✗ provider: 400 invalid image\n");
    expect(app.lastFrame()).not.toContain("Allow Send"); // a plain question, not a permission one
    await press(app, "y");
    await until(app, "next one");
    expect(app.lastFrame()).toContain("Send again without the pictures: yes\nPictures are left out for fake:a from now on.\nseen");
    expect(fake.seen).toHaveLength(3);
    expect(userParts(session)).toEqual([looked, [{ type: "text", text: "queued" }]]); // the conversation is never changed
  });

  it("ends the turn on n, as after any failure, and the queue goes on", async () => {
    const pictures = new Pictures();
    const { lead, fake, release } = gated([invalid(), reply("next one")]);
    const { app, session } = await mount([], { lead, pictures, full: true });
    await press(app, "look ", PICTURE, "\r");
    pictures.set(1, PNG);
    await until(app, "Esc to stop");
    await press(app, "queued", "\r");
    release();
    await until(app, "Send again without the pictures? [y/n] · Esc to decline");
    expect(app.lastFrame()).not.toContain("Allow Send");
    await press(app, "n");
    await until(app, "next one");
    expect(app.lastFrame()).toContain("Send again without the pictures: no");
    expect(app.lastFrame()).not.toContain("Pictures are left out");
    expect(fake.seen).toHaveLength(2);
    expect(userParts(session)).toEqual([looked, [{ type: "text", text: "queued" }]]);
  });

  // Task 18's code review: "allowed" and "declined" fit a permission; a plain question's answer is yes or no.
  it("logs a Ctrl-C at the question as no (cancelled), and sends nothing again", async () => {
    const pictures = new Pictures();
    const { lead, fake, release } = gated([invalid()]);
    const { app } = await mount([], { lead, pictures });
    await press(app, "look ", PICTURE, "\r");
    pictures.set(1, PNG);
    await until(app, "Esc to stop");
    release();
    await until(app, "Send again without the pictures? [y/n] · Esc to decline");
    await press(app, "\u0003");
    await until(app, "Send again without the pictures: no (cancelled)");
    expect(fake.seen).toHaveLength(1);
  });
});

// Release 6 plan, Task 15: Alt+V's read, through a reader the test gives (no test reads the user's clipboard), and a
// pasted path to a picture file, in a folder the test made.
describe("App's picture reads", () => {
  const PICTURE = process.platform === "win32" ? "\u001bv" : "\u0016"; // chat:imagePaste: Alt+V on Windows, else Ctrl+V
  const READING = "Reading picture...";
  const PNG = { mediaType: "image/png" as const, data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]) }; // PNG's signature
  const OTHER = { mediaType: "image/png" as const, data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]) };
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG's SOI marker, then another (ITU-T T.81, Table B.1)
  const userParts = (session: Session) => session.messages.filter((m) => m.role === "user").map((m) => m.parts);
  const paste = (text: string) => `\u001b[200~${text}\u001b[201~`;
  // Reads the test answers one by one, in the order Alt+V started them.
  const answered = () => {
    const answers: ((r: Read) => void)[] = [];
    return { read: () => new Promise<Read>((resolve) => answers.push(resolve)), answers };
  };
  const folder = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tachi-paste-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };
  // A stand-in reader (clipboard.ts, readImage) that fails as a real one does, run only once the test lets it start.
  const failing = () => {
    const file = path.join(folder(), "reader.mjs");
    writeFileSync(file, `console.error("no access"); process.exit(1);`);
    const reader: Reader = { command: process.execPath, args: [file], output: (b) => b, name: "stand-in" };
    let go!: () => void;
    const start = new Promise<void>((resolve) => (go = resolve));
    return { read: () => start.then(() => readImage(reader)), go };
  };

  it("puts the marker in at once, says it is reading, and fills the picture in when the read ends", async () => {
    const { read, answers } = answered();
    const { app, session } = await mount([reply("seen")], { readPicture: read });
    await press(app, "look ", PICTURE);
    expect(app.lastFrame()).toContain(`› look [Image #1]\n${READING}`);
    answers[0]!(PNG);
    await gone(app, READING);
    expect(app.lastFrame()).toContain("› look [Image #1]\n? for shortcuts");
    await press(app, "\r");
    await until(app, "seen");
    expect(userParts(session)).toEqual([[{ type: "text", text: "look " }, { type: "image", id: 1, ...PNG }]]);
  });

  // Final review: Ctrl+K then Ctrl+Y put the marker back as text only, and the message went without the picture.
  it("sends the picture of a marker Ctrl+K took and Ctrl+Y put back", async () => {
    const { app, session } = await mount([reply("seen")], { readPicture: async () => PNG });
    await press(app, "look ", PICTURE);
    await gone(app, READING);
    await press(app, "\u0001", "\u000b"); // Ctrl+A, Ctrl+K
    expect(app.lastFrame()).toMatch(/^›$/m);
    await press(app, "\u0019", "\r"); // Ctrl+Y, Enter
    await until(app, "seen");
    expect(userParts(session)).toEqual([[{ type: "text", text: "look " }, { type: "image", id: 1, ...PNG }]]);
  });

  it("keeps two pictures in the order asked for when the later read ends first, saying it is reading until both end", async () => {
    const { read, answers } = answered();
    const { app, session } = await mount([reply("ok")], { readPicture: read });
    await press(app, PICTURE, " and ", PICTURE);
    answers[1]!(OTHER);
    await tick();
    expect(app.lastFrame()).toContain(READING);
    answers[0]!(PNG);
    await gone(app, READING);
    await press(app, "\r");
    await until(app, "ok");
    expect(userParts(session)).toEqual([[{ type: "image", id: 1, ...PNG }, { type: "text", text: " and " }, { type: "image", id: 2, ...OTHER }]]);
  });

  // Release 6 design, "Testing": deleting the marker during the read, the read ending, then undo.
  it("keeps the picture of a marker deleted during its read when undo brings the marker back after, reading only once", async () => {
    const { read, answers } = answered();
    let reads = 0;
    const { app, session } = await mount([reply("ok")], {
      readPicture: () => {
        reads++;
        return read();
      },
    });
    await press(app, "see ", PICTURE, "\u007f"); // Backspace takes the whole marker (choice 14)
    expect(app.lastFrame()).toMatch(/› see ?\n/);
    answers[0]!(PNG);
    await tick();
    await press(app, "\u001a"); // Ctrl+Z
    expect(app.lastFrame()).toContain("› see [Image #1]");
    await press(app, "\r");
    await until(app, "ok");
    expect(userParts(session)).toEqual([[{ type: "text", text: "see " }, { type: "image", id: 1, ...PNG }]]);
    expect(reads).toBe(1);
  });

  // Release 6 design, "While a read runs": a copy of the marker that undo brings back after a read found nothing is
  // only text.
  it("sends a marker undo brings back after the read found no picture as text only", async () => {
    const { read, answers } = answered();
    const { app, session } = await mount([reply("ok")], { readPicture: read });
    await press(app, "see ", PICTURE);
    answers[0]!("none");
    await until(app, "No picture on the clipboard.");
    expect(app.lastFrame()).toMatch(/› see ?\n/);
    await press(app, "\u001a"); // Ctrl+Z
    expect(app.lastFrame()).toContain("› see [Image #1]");
    await press(app, "\r");
    await until(app, "ok");
    expect(userParts(session)).toEqual([[{ type: "text", text: "see [Image #1]" }]]);
  });

  it("takes a marker out of a queued message when the clipboard has no picture, and the message goes without it", async () => {
    const { read, answers } = answered();
    const { lead, release } = gated([reply("r1"), reply("r2")]);
    const { app, session } = await mount([], { lead, readPicture: read });
    await press(app, "first", "\r");
    await until(app, "Esc to stop");
    await press(app, PICTURE, " later", "\r");
    answers[0]!("none");
    await until(app, "No picture on the clipboard.");
    release();
    await until(app, "r2");
    expect(userParts(session)[1]).toEqual([{ type: "text", text: "later" }]);
  });

  it("sends a message without the picture when the reader fails after Enter, leaving nothing waiting", async () => {
    const { read, go } = failing();
    const { app, session } = await mount([reply("ok")], { readPicture: read });
    await press(app, "look ", PICTURE, " here", "\r");
    expect(app.lastFrame()).toContain(READING);
    go();
    await until(app, "Could not read the clipboard: stand-in failed: no access; [Image #1] was sent without it.");
    await until(app, "ok");
    expect(userParts(session)).toEqual([[{ type: "text", text: "look  here" }]]);
    await gone(app, "Esc to stop");
    expect(app.lastFrame()).not.toContain(READING);
  });

  it("takes the marker out of a queued message when the reader fails, and the message goes without it", async () => {
    const { read, go } = failing();
    const { lead, release } = gated([reply("r1"), reply("r2")]);
    const { app, session } = await mount([], { lead, readPicture: read });
    await press(app, "first", "\r");
    await until(app, "Esc to stop");
    await press(app, PICTURE, " later", "\r");
    go();
    await until(app, "Could not read the clipboard: stand-in failed: no access");
    expect(app.lastFrame()).not.toContain("was sent without it");
    release();
    await until(app, "r2");
    expect(userParts(session)[1]).toEqual([{ type: "text", text: "later" }]);
    await gone(app, "Esc to stop");
    expect(app.lastFrame()).not.toContain(READING);
  });

  it("says so in red where there is no clipboard reader, and puts no marker in", async () => {
    await inColour(async () => {
      const { app } = await mount([], { readPicture: null });
      await press(app, "see ", PICTURE);
      await until(app, "\u001b[31mNo clipboard reader here: install wl-paste or xclip.");
      expect(app.lastFrame()).not.toContain("[Image #1]");
      expect(app.lastFrame()).not.toContain(READING);
    });
  });

  it("makes a paste of paths to picture files those pictures, with or without quotes, each typed by its first bytes", async () => {
    const dir = folder();
    const shot = path.join(dir, "shot one.png");
    const photo = path.join(dir, "photo.png"); // a JPEG named .png
    writeFileSync(shot, PNG.data);
    writeFileSync(photo, JPEG);
    const { app, session } = await mount([reply("ok")]);
    await press(app, "see ", paste(`"${shot}"\n${photo}\n`));
    expect(app.lastFrame()).toContain("› see [Image #1][Image #2]");
    await press(app, "\r");
    await until(app, "ok");
    expect(userParts(session)).toEqual([
      [{ type: "text", text: "see " }, { type: "image", id: 1, ...PNG }, { type: "image", id: 2, mediaType: "image/jpeg", data: JPEG }],
    ]);
  });

  it("keeps a paste of paths as text when a file it names is missing", async () => {
    const dir = folder();
    const shot = path.join(dir, "shot.png");
    writeFileSync(shot, PNG.data);
    const text = `${shot}\n${path.join(dir, "missing.png")}`;
    const { app, session } = await mount([reply("ok")]);
    await press(app, paste(text), "\r");
    await until(app, "ok");
    expect(userParts(session)).toEqual([[{ type: "text", text }]]);
  });

  it("keeps a pasted path to a folder named like a picture as text, with no marker", async () => {
    const folderPath = path.join(folder(), "shots.png");
    mkdirSync(folderPath);
    const { app, session } = await mount([reply("ok")]);
    await press(app, paste(folderPath));
    expect(app.lastFrame()).not.toContain("[Image #");
    await press(app, "\r");
    await until(app, "ok");
    expect(userParts(session)).toEqual([[{ type: "text", text: folderPath }]]);
  });

  // The security review's finding 3 (release 6 plan, choice 30): a path starting with two slashes is pasted as text and
  // never looked at, so a pasted \\server\share\cat.png cannot reach that machine. This one leads to a real picture on
  // this machine (\\?\ before it on Windows, a doubled / elsewhere), which would be a picture without the rule.
  it("keeps a pasted path starting with two slashes as text, though it leads to a picture", async () => {
    const shot = path.join(folder(), "shot.png");
    writeFileSync(shot, PNG.data);
    const text = process.platform === "win32" ? `\\\\?\\${shot}` : `/${shot}`;
    const { app, session } = await mount([reply("ok")]);
    await press(app, paste(text));
    expect(app.lastFrame()).not.toContain("[Image #");
    await press(app, "\r");
    await until(app, "ok");
    expect(userParts(session)).toEqual([[{ type: "text", text }]]);
  });

  it("says in red that a pasted file that is not a picture could not be read, naming the file, and takes its marker out", async () => {
    await inColour(async () => {
      const { app, ctx } = await mount([]);
      writeFileSync(path.join(ctx.root, "notes.png"), "hello"); // a path in the project, as typed relative to it
      onTestFinished(() => rmSync(path.join(ctx.root, "notes.png"), { force: true }));
      await press(app, "see ", paste("notes.png"));
      await until(app, "\u001b[31mCould not read notes.png: not a PNG, JPEG, GIF or WebP picture");
      expect(app.lastFrame()).toMatch(/› see ?\n/);
    });
  });
});

// Release 6 plan, Task 21: vim mode at the prompt (vim.ts), switched by /vim and the settings file.
describe("App's vim mode", () => {
  const ESC = "\u{1b}";
  const CTRL_T = "\u{14}";
  const CTRL_K = "\u{b}";
  const CTRL_O = "\u{f}";
  const PICTURE = process.platform === "win32" ? "\u{1b}v" : "\u{16}"; // chat:imagePaste: Alt+V on Windows, else Ctrl+V
  const PNG = { mediaType: "image/png" as const, data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }; // a stand-in, never read from disk
  const todo: TodoItem[] = [{ text: "write the fix", status: "pending" }];
  // The default table with `keys` laid over one context's.
  const table = (context: Context, keys: Record<string, string | null>) =>
    new Bindings(tableOf({ ...DEFAULTS, [context]: { ...DEFAULTS[context], ...keys } }));
  // Vim mode on with /vim, which starts in INSERT; then `text` typed in one read, and Esc: NORMAL, the cursor on the
  // text's last character.
  const normal = async (app: ReturnType<typeof render>, text = "") => {
    await type(app, "/vim");
    await until(app, "-- INSERT --");
    await press(app, ...(text ? [text] : []), ESC);
    await until(app, "-- NORMAL --");
  };
  // The text drawn in reverse colours on the prompt's first row.
  const onPrompt = (app: ReturnType<typeof render>) => reverse(app.lastFrame()!.split("\n").find((r) => /^›( |$)/.test(r))!);

  it("switches on and off with /vim, /vim on and /vim off, saying so, in this window only", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "tachi-home-"));
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    const { app } = await mount([], { home });
    expect(app.lastFrame()).toContain("? for shortcuts");
    await type(app, "/vim");
    await until(app, "editorMode is now vim");
    expect(app.lastFrame()).toContain("-- INSERT --");
    expect(app.lastFrame()).not.toContain("? for shortcuts");
    await type(app, "/vim");
    await until(app, "editorMode is now normal");
    expect(app.lastFrame()).toContain("? for shortcuts");
    await type(app, "/vim on");
    await until(app, "-- INSERT --");
    await type(app, "/VIM OFF"); // typed in INSERT, in one read; commands ignore case
    await until(app, "? for shortcuts");
    expect(app.lastFrame()!.split("editorMode is now normal").length - 1).toBe(2);
    await type(app, "/vim maybe");
    await until(app, "Usage: /vim, /vim on, /vim off");
    expect(existsSync(path.join(settingsDir(home), "settings.json"))).toBe(false); // nothing saved (choice 26)
  });

  it("deletes a word on dw written in one read", async () => {
    const { app } = await mount([]);
    await normal(app, "one two");
    await press(app, "0", "dw");
    expect(app.lastFrame()).toContain("› two\n");
  });

  it("inserts a paste in NORMAL as text", async () => {
    const { app } = await mount([]);
    await normal(app, "ab");
    await press(app, "\u{1b}[200~dw\u{1b}[201~");
    expect(app.lastFrame()).toContain("› adwb\n");
    expect(app.lastFrame()).toContain("-- NORMAL --");
  });

  it("goes to NORMAL on Esc in INSERT during a turn, which goes on, and stops the turn on Esc in NORMAL", async () => {
    const { app } = await mount([], { lead: hanging() });
    await type(app, "/vim");
    await until(app, "-- INSERT --");
    await type(app, "hi");
    await until(app, "Esc to stop");
    await press(app, ESC);
    expect(app.lastFrame()).toContain("-- NORMAL --");
    expect(app.lastFrame()).toContain("Esc to stop");
    await press(app, ESC);
    await gone(app, "Esc to stop");
  });

  // Final review: in INSERT, and with a command half typed, the first Esc goes to vim and only the second stops the
  // turn, so the working line names Esc twice there (choice 31).
  it("says Esc Esc to stop in INSERT and with d half typed, and Esc to stop in NORMAL", async () => {
    const { app } = await mount([], { lead: hanging() });
    await type(app, "/vim");
    await until(app, "-- INSERT --");
    await type(app, "hi");
    await until(app, "· Esc Esc to stop");
    await press(app, ESC);
    expect(app.lastFrame()).toContain("-- NORMAL --");
    expect(app.lastFrame()).toContain("· Esc to stop");
    await press(app, "d");
    expect(app.lastFrame()).toContain("· Esc Esc to stop");
    await press(app, ESC);
    expect(app.lastFrame()).toContain("· Esc to stop");
    await press(app, ESC);
    await gone(app, "to stop");
  });

  it("lists Esc twice to stop the turn on ? in INSERT, and once in NORMAL", async () => {
    const { app } = await mount([]);
    await type(app, "/vim");
    await until(app, "-- INSERT --");
    await press(app, "?");
    await until(app, "  Esc Esc  stop the turn · Esc Esc Esc  clear the prompt");
    await press(app, ESC, "?");
    expect(app.lastFrame()).toContain("  Esc  stop the turn · Esc Esc  clear the prompt");
  });

  it("sends on Enter in NORMAL", async () => {
    const { app, session } = await mount([reply("ok")]);
    await normal(app, "hi");
    await press(app, "\r");
    await until(app, "ok");
    expect(sent(session)).toEqual({ type: "text", text: "hi" });
  });

  it("lists the keys on ?, recalls a past prompt on k, and opens Ctrl+R's search on /, in NORMAL", async () => {
    const { app } = await mount([], { past: ["older"] });
    await normal(app);
    await press(app, "?");
    expect(app.lastFrame()).toContain("Keys:");
    await press(app, "k");
    expect(app.lastFrame()).toContain("› /vim\n");
    await press(app, "/");
    expect(app.lastFrame()).toContain("search: ");
    await press(app, "o"); // typed into the search, not a vim key
    expect(app.lastFrame()).toContain("› older\n");
  });

  it("keeps the mode and the cursor across Ctrl+O's detail view", async () => {
    const { app } = await mount([], { full: true });
    await normal(app, "abc");
    await press(app, CTRL_O);
    expect(app.lastFrame()).not.toContain("-- NORMAL --"); // the view's key row takes the row
    await press(app, CTRL_O);
    expect(app.lastFrame()).toContain("-- NORMAL --");
    await press(app, "x");
    expect(shown(app)).toContain("› ab");
  });

  it("toggles the to-do list on Ctrl+T after d, leaving d pending", async () => {
    const { app, bus } = await mount([]);
    bus.emit("todo", todo);
    await normal(app, "one two");
    expect(app.lastFrame()).toContain("write the fix");
    await press(app, "0", "d", CTRL_T);
    expect(app.lastFrame()).not.toContain("write the fix");
    await press(app, "w");
    expect(app.lastFrame()).toContain("› two\n");
  });

  it("deletes a word on d then w, with w bound in Chat, which a lone w does", async () => {
    const { app, bus } = await mount([], { bindings: table("Chat", { w: "app:toggleTodos" }) });
    bus.emit("todo", todo);
    await normal(app, "one six");
    await press(app, "0", "w");
    expect(app.lastFrame()).not.toContain("write the fix");
    expect(app.lastFrame()).toContain("› one six\n");
    await press(app, "d", "w");
    expect(app.lastFrame()).toContain("› six\n");
  });

  it("goes to NORMAL on Esc in INSERT with chat:cancel rebound to Ctrl+Q, which stops the turn from INSERT", async () => {
    const { app } = await mount([], { lead: hanging(), bindings: table("Chat", { escape: null, "ctrl+q": "chat:cancel" }) });
    await type(app, "/vim");
    await until(app, "-- INSERT --");
    await type(app, "hi");
    await until(app, "Ctrl+Q to stop");
    await press(app, ESC);
    expect(app.lastFrame()).toContain("-- NORMAL --");
    expect(app.lastFrame()).toContain("Ctrl+Q to stop");
    await press(app, "i");
    expect(app.lastFrame()).toContain("-- INSERT --");
    await press(app, "\u{11}"); // Ctrl+Q: chat:cancel stops the turn, not a switch of mode
    await gone(app, "Ctrl+Q to stop");
    expect(app.lastFrame()).toContain("-- INSERT --");
  });

  // As Claude Code's vim hook does: any Ctrl or Meta key in VISUAL goes to NORMAL first; its text field then takes no
  // editing key, and a key the table binds does its action (the plan's choice 27).
  it("leaves VISUAL on a Ctrl or Alt key, which then does its table action but no editing", async () => {
    const { app, bus } = await mount([]);
    bus.emit("todo", todo);
    await normal(app, "one two");
    await press(app, "0", "v", "e");
    expect(app.lastFrame()).toContain("-- VISUAL --");
    await press(app, CTRL_T);
    expect(app.lastFrame()).toContain("-- NORMAL --");
    expect(app.lastFrame()).not.toContain("write the fix");
    await press(app, "x"); // one character: nothing is selected now
    expect(app.lastFrame()).toContain("› on two\n");
    await press(app, "V");
    expect(app.lastFrame()).toContain("-- VISUAL LINE --");
    await press(app, CTRL_K);
    expect(app.lastFrame()).toContain("-- NORMAL --");
    expect(app.lastFrame()).toContain("› on two\n");
    await press(app, CTRL_K); // in NORMAL the editor's own key: delete to the line's end
    expect(app.lastFrame()).toContain("› on\n");
  });

  // The plan's choice 28: VISUAL's selection in reverse colours, as Claude Code 2.1.312 draws it.
  it("draws VISUAL's selection in reverse colours, the cursor's character in it, and clears it on leaving", async () => {
    await inColour(async () => {
      const { app } = await mount([]);
      await normal(app, "one two");
      await press(app, "0", "v");
      expect(reversed(app)).toContain("o");
      await press(app, "l", "l");
      expect(reversed(app)).toContain("one");
      await press(app, ESC);
      expect(app.lastFrame()).toContain("-- NORMAL --");
      expect(onPrompt(app)).toBe("");
      await press(app, "v", "h", CTRL_T); // leaving on a Ctrl key clears it too
      expect(app.lastFrame()).toContain("-- NORMAL --");
      expect(onPrompt(app)).toBe("");
      await press(app, "0", "l", "v", "h"); // the anchor after the cursor: from the cursor to the anchor's character
      expect(onPrompt(app)).toBe("on");
    });
  });

  // Code review of Task 21: App changing the prompt's text under VISUAL left its anchor in the old text, and `o` then put
  // the cursor where the new text has no place, which threw while drawing. Changed text leaves VISUAL for NORMAL.
  it.each([
    { name: "a message sent", keys: ["\r"] },
    { name: "a past prompt recalled", keys: ["\u{1b}[A"] },
    { name: "a paste", keys: ["\u{1b}[200~\u{1f600}\u{1b}[201~"] },
  ])("leaves VISUAL for NORMAL when $name changes the text, and o then works", async ({ keys }) => {
    await inColour(async () => {
      // On from the settings file, so no /vim is in the history for Up to bring back.
      const home = mkdtempSync(path.join(tmpdir(), "tachi-home-"));
      onTestFinished(() => rmSync(home, { recursive: true, force: true }));
      const live = { loaded: { settings: { editorMode: "vim" as const }, warnings: [] }, given: {} };
      const { app } = await mount([reply("ok")], { past: ["hi"], home, live });
      await press(app, "hello world", ESC, "v", "0", ...keys);
      expect(app.lastFrame()).toContain("-- NORMAL --");
      expect(onPrompt(app)).toBe("");
      await press(app, "o");
      expect(app.lastFrame()).toContain("-- INSERT --");
    });
  });

  // Final review: a command or count half typed outlived App putting other text in the prompt, so `d`, Ctrl+P, `w`
  // deleted a word of the line recalled. Changed text drops them, as it leaves VISUAL.
  it.each([
    { name: "a past prompt recalled with Ctrl+P", keys: ["\u{10}"], after: "› /vim\n" },
    { name: "a picture's marker put in", keys: [PICTURE], after: "› [Image #1]alpha beta\n" },
  ])("drops a half-typed d when $name changes the text, so w only moves", async ({ keys, after }) => {
    const { app } = await mount([]);
    await normal(app, "alpha beta");
    await press(app, "0", "d", ...keys, "w");
    expect(app.lastFrame()).toContain(after);
  });

  it("leaves VISUAL for NORMAL when a picture's failed read takes its marker out", async () => {
    await inColour(async () => {
      const pictures = new Pictures();
      const { app } = await mount([], { pictures });
      await type(app, "/vim");
      await until(app, "-- INSERT --");
      await press(app, PICTURE, "ab", ESC, "v", "0");
      expect(onPrompt(app)).toBe("[Image #1]ab");
      pictures.set(1, "none");
      await until(app, "No picture on the clipboard.");
      expect(app.lastFrame()).toContain("-- NORMAL --");
      expect(onPrompt(app)).toBe("");
      await press(app, "o");
      expect(app.lastFrame()).toContain("-- INSERT --");
    });
  });

  // Claude Code's Enter in NORMAL goes to its text field, which sends, whatever is half typed (2.1.312's
  // `if(a.name==="return"&&l.mode!=="VISUAL"){f.handleKeyDown(a);return}`); here an operator's Enter drops the command
  // (choice 27), and a count's sends, as there.
  it("drops d on Enter, and sends after a count, in NORMAL", async () => {
    const { app, session } = await mount([reply("ok")]);
    await normal(app, "hi");
    await press(app, "d", "\r");
    await tick();
    expect(session.messages).toEqual([]);
    expect(app.lastFrame()).toContain("› hi\n");
    await press(app, "2", "\r");
    await until(app, "ok");
    expect(sent(session)).toEqual({ type: "text", text: "hi" });
  });

  // Code review of Task 21: new text in the prompt starts what `.` repeats afresh (app/keyRouting.ts, freshText).
  it("repeats on . an insert typed after a message was sent from INSERT", async () => {
    const { app } = await mount([reply("ok")]);
    await normal(app, "foo");
    await press(app, "A", "bar", "\r");
    await until(app, "ok");
    await press(app, "baz", ESC, ".");
    expect(app.lastFrame()).toContain("› babazz\n");
  });

  it("draws VISUAL LINE's selection over whole lines", async () => {
    await inColour(async () => {
      const { app } = await mount([]);
      await type(app, "/vim");
      await until(app, "-- INSERT --");
      await press(app, "one two", "\n", "six", ESC, "h", "V"); // a line feed is Ctrl+J, a new line
      expect(reversed(app)).toContain("six");
      expect(reversed(app)).not.toContain("one two");
      await press(app, "k");
      expect(reversed(app)).toEqual(expect.arrayContaining(["one two", "six"]));
    });
  });

  it("draws the whole of a picture's marker the selection reaches into, as a delete there takes all of it", async () => {
    await inColour(async () => {
      const { app } = await mount([]);
      await type(app, "/vim");
      await until(app, "-- INSERT --");
      await press(app, "see ", PICTURE, ESC, "0", "v", "l", "l", "l", "l", "l"); // to the marker's I
      expect(reversed(app)).toContain("see [Image #1]");
      await press(app, "d");
      expect(app.lastFrame()).not.toContain("[Image #1]");
    });
  });

  it("keeps a picture's span through a vim edit, so the message carries the picture", async () => {
    const pictures = new Pictures();
    const { app, session } = await mount([reply("seen")], { pictures });
    await type(app, "/vim");
    await until(app, "-- INSERT --");
    await press(app, "one see ", PICTURE, ESC, "0", "dw");
    expect(app.lastFrame()).toContain("› see [Image #1]\n");
    pictures.set(1, PNG);
    await press(app, "\r");
    await until(app, "seen");
    expect(session.messages[0]!.parts).toEqual([{ type: "text", text: "see " }, { type: "image", id: 1, ...PNG }]);
  });
});

// Release 6 plan, Task 9: edits to the settings file apply in the running session, by the design's table ("The settings
// file", "When a live change applies").
describe("App's live settings", () => {
  const FROM = "(from settings.json)";
  // A long line wraps, and Ink can carry the space it broke at onto the next row.
  const flat = (app: ReturnType<typeof render>) => app.lastFrame()!.replaceAll(/ *\n */g, " ");
  const sees = (app: ReturnType<typeof render>, text: string) => vi.waitFor(() => expect(flat(app)).toContain(text), WATCHED);
  const freshHome = () => mkdtempSync(path.join(tmpdir(), "tachi-home-"));
  const PINNED = (mode: string) => `"mode" changes in settings.json take effect at the next launch; the mode stays ${mode}`;

  // A home of the test's own whose settings file holds `file` at launch, and the App watching it; `given`, the
  // entries a flag or variable gave at launch. `write` changes the file as an editor does; `remove` takes it away.
  async function watching(
    turns: ConstructorParameters<typeof FakeProvider>[1],
    file: Settings,
    opts: Parameters<typeof mount>[1] = {},
    given: Given = {},
    home = freshHome(),
  ) {
    const where = path.join(settingsDir(home), "settings.json");
    mkdirSync(settingsDir(home), { recursive: true });
    writeFileSync(where, JSON.stringify(file));
    const m = await mount(turns, { ...opts, home, live: { loaded: { settings: file, warnings: [] }, given } });
    const write = (data: object | string) => writeFileSync(where, typeof data === "string" ? data : JSON.stringify(data));
    return { ...m, where, write, remove: () => unlinkSync(where) };
  }

  it("changes the lead as /lead does, once a turn running ends, and keeps it when the entry is removed", async () => {
    const lead = new Held();
    const made: string[] = [];
    const { app, session, write } = await watching([], {}, { lead, made });
    await type(app, "go");
    write({ lead: "ollama:b", mode: "project" });
    await sees(app, PINNED("ask")); // the edit was read while the turn runs
    expect(flat(app)).not.toContain("lead is now");
    lead.answer("done");
    await sees(app, `lead is now fake:b ${FROM}`);
    expect(session.lead.id).toBe("fake:b");
    expect(made).toEqual(["ollama:b"]);
    write({ mode: "project" });
    await sees(app, '"lead" was removed from settings.json; the lead stays fake:b');
    expect(session.lead.id).toBe("fake:b");
  });

  it("says why a lead, fallback or worker the file names cannot be made, and keeps the one before", async () => {
    const { app, session, write } = await watching([], {}, { leadFails: "no such model" });
    write({ lead: "x", fallback: "y", worker: "z" });
    await sees(app, 'settings.json: "lead": no such model');
    await sees(app, 'settings.json: "fallback": no such model');
    await sees(app, 'settings.json: "worker": no such model');
    expect(session.lead.id).toBe("fake:a");
  });

  // Release 6 plan, choice 32 (the outside review of PR #5): a shell command the user allowed could rewrite the file to
  // put the session in project mode, so a live edit of "mode" never changes it; Shift+Tab still does.
  it("keeps the mode as at launch on a live edit of it, says so, and still switches it on Shift+Tab", async () => {
    const { app, gate, write } = await watching([], {});
    write({ mode: "project" });
    await sees(app, PINNED("ask"));
    expect(gate.mode).toBe("ask");
    expect(app.lastFrame()).toContain("perm ask");
    await press(app, "\u001b[Z");
    await sees(app, "mode is now project");
    write({});
    await sees(app, PINNED("project")); // removing the entry is a change too
    expect(gate.mode).toBe("project");
  });

  // Release 7 plan, Task 7: `never` is no longer switched off, so a live one gets the same line as any other mode.
  it("keeps the mode as at launch on a live never, and a session started in never in it", async () => {
    const a = await watching([], {});
    a.write({ mode: "never" });
    await sees(a.app, PINNED("ask"));
    expect(flat(a.app)).not.toContain("switched off");
    expect(a.app.lastFrame()).toContain("perm ask");
    const b = await watching([], { mode: "never" }, { mode: "never" });
    b.write({ mode: "ask" });
    await sees(b.app, PINNED("never"));
    expect(b.app.lastFrame()).toContain("perm never");
  });

  // Release 7 design, "The modes": a live edit of the sandbox, its network or the judge waits for the next launch, as
  // "mode" does, with the same kind of grey line (release 7 plan, Task 7); one a flag gave stays as the flag set it.
  it("keeps the sandbox, the network and the judge as at launch on a live edit, and says so", async () => {
    const stays = (key: string, value: string) => `"${key}" changes in settings.json take effect at the next launch; it stays ${value}`;
    const a = await watching([], {});
    a.write({ sandbox: "copy", network: "on", judge: "ollama:j" });
    await sees(a.app, stays("sandbox", "off"));
    await sees(a.app, stays("network", "off"));
    await sees(a.app, stays("judge", "the lead's model"));
    const b = await watching([], { network: "on", judge: "ollama:j" });
    b.write({});
    await sees(b.app, stays("network", "on"));
    await sees(b.app, stays("judge", "ollama:j"));
    const c = await watching([], {}, {}, { sandbox: "--sandbox", network: "--network", judge: "--judge" });
    c.write({ sandbox: "live", network: "on", judge: "ollama:j" });
    for (const key of ["sandbox", "network", "judge"]) await sees(c.app, `settings.json's "${key}" was left as --${key} set it for this session`);
  });

  // Release 8a plan, choice 26: "autoCompactWindow" is LIVE, set as /autocompact sets it; a bad one keeps the last good.
  it("sets the /autocompact size from a live autoCompactWindow, off when removed, and says a bad one", async () => {
    const { app, session, write } = await watching([], {});
    write({ autoCompactWindow: 200000 });
    await sees(app, `autoCompactWindow is now 200,000 ${FROM}`);
    expect(session.autoCompact).toBe(200_000);
    write({ autoCompactWindow: 0 });
    await sees(app, 'settings.json: "autoCompactWindow" must be a whole number from 1 (got "0"); the last good settings still apply');
    expect(session.autoCompact).toBe(200_000);
    write({});
    await sees(app, `autoCompactWindow is now off ${FROM}`);
    expect(session.autoCompact).toBeNull();
  });

  // Release 7 plan, Task 4 (design, "Configurable"): an edit that loosens the dangerous-command check gets a red warning
  // and waits for the next launch, so a command the user allowed cannot loosen it in the session; one that tightens it
  // gets a grey notice and applies at once.
  describe("dangerousCommands", () => {
    const CHECK = "settings.json: dangerous-command check:";
    const LOOSENED = "in auto and never, those commands will run without the check. Takes effect at the next launch.";
    const OFF = `${CHECK} "installing software" switched off; ${LOOSENED}`;
    const REMOVED = `${CHECK} your rule "make deploy" removed; ${LOOSENED}`;
    const ADDED = `${CHECK} rule "make deploy" added; it applies now.`;
    const ON = `${CHECK} "installing software" switched back on; it applies now.`;
    const SH = { root: "/tmp/x", home: "/home/u", shell: "bash" as const, has: () => false };
    const kinds = (line: string, gate: PermissionGate) => dangers(line, SH, gate.rules).map((d) => d.kind);
    // The frame without its colours, as flat() gives it; a wrapped row's colours sit around its line break.
    const plain = (app: ReturnType<typeof render>) => stripVTControlCharacters(app.lastFrame()!).replaceAll(/ *\n */g, " ");

    it("leaves a kind switched off for the next launch, with a red warning, and applies an added rule at once, in grey", async () => {
      await inColour(async () => {
        const { app, gate, write } = await watching([], {});
        write({ dangerousCommands: { off: ["installing software"] } });
        await vi.waitFor(() => expect(plain(app)).toContain(OFF), WATCHED);
        expect(app.lastFrame()).toContain(`\u001b[31m${CHECK} "installing software" switched off;`);
        expect(gate.rules).toEqual({ add: [], off: [] });
        expect(kinds("npm install left-pad", gate)).toEqual(["installing software"]);
        write({ dangerousCommands: { off: ["installing software"], add: ["make deploy"] } });
        await vi.waitFor(() => expect(plain(app)).toContain(ADDED), WATCHED);
        expect(app.lastFrame()).toContain(`\u001b[90m${ADDED}`);
        expect(plain(app).split(OFF).length - 1).toBe(1); // said for the edit that switched it off
        expect(gate.rules).toEqual({ add: ["make deploy"], off: [] });
        expect(kinds("make deploy", gate)).toEqual(["your own rule: make deploy"]);
      });
    });

    it("leaves a removed rule for the next launch, with a red warning, and applies a kind switched back on at once, in grey", async () => {
      await inColour(async () => {
        const { app, gate, write } = await watching([], { dangerousCommands: { add: ["make deploy"], off: ["installing software"] } });
        expect(kinds("npm install left-pad", gate)).toEqual([]);
        write({});
        await vi.waitFor(() => expect(plain(app)).toContain(ON), WATCHED);
        expect(plain(app)).toContain(REMOVED);
        expect(app.lastFrame()).toContain(`\u001b[31m${CHECK} your rule "make deploy" removed;`);
        expect(app.lastFrame()).toContain(`\u001b[90m${CHECK} "installing software" switched back on;`);
        expect(gate.rules).toEqual({ add: ["make deploy"], off: [] });
        expect(kinds("npm install left-pad", gate)).toEqual(["installing software"]);
        expect(kinds("make deploy", gate)).toEqual(["your own rule: make deploy"]);
      });
    });

    it("gives a subagent's gate the rules in force, one made before the edit too", async () => {
      const { gate, write, app } = await watching([], {});
      const child = gate.for({ name: "t1", signal: new AbortController().signal, stop: () => {} });
      write({ dangerousCommands: { add: ["make deploy"] } });
      await sees(app, ADDED);
      expect(child.rules).toEqual({ add: ["make deploy"], off: [] });
    });

    // The kind was never off in force (the edit switching it off waited), so the check never stopped: nothing to say.
    it("says nothing when a kind switched off in the session, and so still checked, is switched back on", async () => {
      const { app, gate, write } = await watching([], {});
      write({ dangerousCommands: { off: ["installing software"] } });
      await vi.waitFor(() => expect(plain(app)).toContain(OFF), WATCHED);
      write({ dangerousCommands: { off: [], add: ["make deploy"] } });
      await vi.waitFor(() => expect(plain(app)).toContain(ADDED), WATCHED);
      expect(plain(app)).not.toContain("switched back on");
      expect(gate.rules).toEqual({ add: ["make deploy"], off: [] });
    });

    it("takes a spacing-only edit of a rule as no change", async () => {
      const { app, write } = await watching([], { dangerousCommands: { add: ["make deploy"], off: [] } });
      write({ dangerousCommands: { add: [" make  deploy "] }, maxTasks: 3 });
      await sees(app, `maxTasks is now 3 ${FROM}`);
      expect(plain(app)).not.toContain("dangerous-command check");
    });
  });

  // Test 7 too: a change made while a tool runs inside a turn is sent from the request after the tool's result.
  it("sends a changed effort from the lead's very next request, inside a turn, and none once the entry is removed", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    onTestFinished(() => void vi.unstubAllEnvs());
    const lookup = vi.spyOn(Models.prototype, "retrieve").mockResolvedValue({ max_input_tokens: 1_000 } as never); // no request leaves
    onTestFinished(() => lookup.mockRestore());
    // Nor does the count the session asks for before a request with no ratio yet (release 8a plan, Task 12).
    const count = vi.spyOn(Messages.prototype, "countTokens").mockResolvedValue({ input_tokens: 1 } as never);
    onTestFinished(() => count.mockRestore());
    const answer = (content: unknown[], stop_reason: string) =>
      ({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content,
        stop_reason,
        stop_details: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }) as unknown as BetaMessage;
    const answers = [
      answer([{ type: "tool_use", id: "c1", name: "write_file", input: { path: "a.txt", content: "x" } }], "tool_use"),
      answer([{ type: "text", text: "written" }], "end_turn"),
      answer([{ type: "text", text: "answered again" }], "end_turn"),
    ];
    const efforts: (string | undefined)[] = [];
    const stream = vi.spyOn(Messages.prototype, "stream").mockImplementation(((params: { output_config?: { effort?: string } }) => {
      efforts.push(params.output_config?.effort);
      const next = answers.shift();
      return { finalMessage: async () => next };
    }) as never);
    onTestFinished(() => stream.mockRestore());
    const { app, ctx, write } = await watching([], { effort: "high" }, { lead: new AnthropicProvider("claude-test", "high") });
    await type(app, "make a file");
    await until(app, `Allow write ${path.join(ctx.root, "a.txt")}? [y/n]`);
    write({ effort: "low" });
    await sees(app, `effort is now low ${FROM}`);
    app.stdin.write("y");
    await until(app, "written");
    write({});
    await sees(app, `effort is now the model's default ${FROM}`);
    await type(app, "again");
    await until(app, "answered again");
    expect(efforts).toEqual(["high", "low", undefined]);
  });

  it("rescues a refusal, the lead's and a subagent's, on a fallback the file names, and none once the entry is removed", async () => {
    const refused = { ...reply(""), cutOff: { kind: "refusal" as const, detail: "declined" } };
    const rescue = new FakeProvider("b", [reply("rescued"), reply("rescued the subagent")]);
    const worker = new FakeProvider("w", [refused, refused]);
    const { app, tasks, write } = await watching([refused, refused], {}, { newLead: rescue, worker });
    write({ fallback: "ollama:f" });
    await sees(app, `fallback is now fake:b ${FROM}`);
    await type(app, "one");
    await until(app, "rescued");
    expect(await tasks.start("one", { background: false }).done).toEqual({ state: "done", text: "rescued the subagent" });
    write({});
    await sees(app, `fallback is now off ${FROM}`);
    await type(app, "two");
    await until(app, "✗ refusal: declined");
    expect(await tasks.start("two", { background: false }).done).toEqual({ state: "failed", text: "declined" });
  });

  // As at launch (cli.tsx, makeProvider), the fallback and the subagents' worker take the effort too, not only the
  // lead.
  it("sends a changed effort to the fallback and the subagents' worker as well as the lead", async () => {
    // Records the effort each request goes with, as AnthropicProvider sends it.
    class Effortful extends FakeProvider {
      effort: Provider["effort"];
      readonly sent: (string | undefined)[] = [];
      setEffort(effort: Provider["effort"]) {
        this.effort = effort;
      }
      override complete(req: Parameters<FakeProvider["complete"]>[0]) {
        this.sent.push(this.effort);
        return super.complete(req);
      }
    }
    const refused = { ...reply(""), cutOff: { kind: "refusal" as const, detail: "declined" } };
    const lead = new Effortful("a", [refused]);
    const rescue = new Effortful("b", [reply("rescued")]);
    const worker = new Effortful("w", [reply("subagent done")]);
    const { app, tasks, write } = await watching([], {}, { lead, newLead: rescue, worker });
    write({ fallback: "ollama:f" });
    await sees(app, `fallback is now fake:b ${FROM}`);
    write({ fallback: "ollama:f", effort: "low" });
    await sees(app, `effort is now low ${FROM}`);
    await type(app, "go");
    await until(app, "rescued");
    expect(await tasks.start("one", { background: false }).done).toEqual({ state: "done", text: "subagent done" });
    expect([lead.sent, rescue.sent, worker.sent]).toEqual([["low"], ["low"], ["low"]]);
  });

  it("starts later subagents on the worker the file names, and on the lead's model once the entry is removed", async () => {
    const { app, tasks, write } = await watching([], {});
    write({ worker: "ollama:w" });
    await sees(app, `worker is now fake:b ${FROM}`);
    expect(tasks.start("one", { background: false }).model).toBe("fake:b");
    write({});
    await sees(app, `worker is now the lead's model ${FROM}`);
    expect(tasks.start("two", { background: false }).model).toBe("fake:a");
  });

  it("holds back new subagents past a lowered maxTasks, stopping none, and starts them once the entry is removed", async () => {
    const { app, tasks, write } = await watching([], {}, { worker: new Held("fake:w") });
    tasks.start("one", { background: false });
    tasks.start("two", { background: false });
    write({ maxTasks: 1 });
    await sees(app, `maxTasks is now 1 ${FROM}`);
    tasks.start("three", { background: false });
    await vi.waitFor(() => expect(tasks.all.map((t) => t.state)).toEqual(["running", "running", "waiting"]));
    write({});
    await sees(app, `maxTasks is now 8 ${FROM}`);
    await vi.waitFor(() => expect(tasks.all.map((t) => t.state)).toEqual(["running", "running", "running"]));
  });

  // Choice 26, the user's: a missing file is skipped, as an empty one is, so an editor that saves by renaming a new
  // file over the old one changes nothing while there is none.
  it("shows the status parts the file names at once, and keeps them while the file is missing and once it is back", async () => {
    const { app, write, remove, where } = await watching([], {});
    write({ status: ["lead"] });
    await sees(app, `status is now lead ${FROM}`);
    const read = readsOf(where);
    await read(remove);
    await read(() => write({ status: ["lead"] }));
    write({ status: ["lead"], mode: "project" });
    await sees(app, PINNED("ask"));
    expect(flat(app).split("status is now").length - 1).toBe(1);
    expect(app.lastFrame()).not.toContain("perm ask");
  });

  it("switches the screen as /screen does, once a turn running ends, and back once the entry is removed", async () => {
    const lead = new Held();
    const { app, write, where } = await watching([], {}, { lead, full: true });
    await type(app, "go");
    write({ screen: "classic", mode: "project" });
    await sees(app, PINNED("ask")); // the edit was read while the turn runs
    expect(flat(app)).not.toContain("screen is now");
    lead.answer("done");
    await sees(app, `screen is now classic ${FROM}`);
    write({ mode: "project" });
    await sees(app, `screen is now full ${FROM}`);
    expect(readFileSync(where, "utf8")).toBe('{"mode":"project"}'); // the file as the user wrote it
  });

  it("says full screen cannot draw here when the file asks for it", async () => {
    const { app, write } = await watching([], { screen: "classic" }, { fullPossible: false });
    write({});
    await sees(app, "Full screen needs a terminal (the output is not one, or CI is set)");
  });

  it("scrolls by the file's scrollSpeed from the next notch, and by 3 once the entry is removed", async () => {
    const { app, mouse, write } = await watching([], {}, { full: true, intro: said(80) });
    const top = () => Number(/^said (\d+)\.$/.exec(shown(app)[0]!)![1]);
    write({ scrollSpeed: 1 });
    await sees(app, `scrollSpeed is now 1 ${FROM}`);
    let from = top();
    await wheel(mouse, "up");
    expect(top()).toBe(from - 1);
    await wheel(mouse, "down", 5); // back to the bottom, following, so the next line shows
    write({});
    await sees(app, `scrollSpeed is now 3 ${FROM}`);
    from = top();
    await wheel(mouse, "up");
    expect(top()).toBe(from - 3);
  });

  // Release 8b plan, Task 1: hooks and disableAllHooks are LIVE, and until Task 12 applies them an edit of either does
  // nothing and says nothing; it once fell through to scrollSpeed's branch, setting the speed and saying "hooks is now 3".
  it("leaves the scroll speed as it is on a live edit of hooks or disableAllHooks, and says no line for them", async () => {
    const { app, mouse, write } = await watching([], {}, { full: true, intro: said(80), scrollSpeed: 1 }, { scrollSpeed: "--scroll-speed" });
    const top = () => Number(/^said (\d+)\.$/.exec(shown(app)[0]!)![1]);
    write({ mode: "project", hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "check.sh" }] }] }, disableAllHooks: true });
    await sees(app, PINNED("ask")); // the edit was read, its entries in LIVE's order, hooks after mode
    expect(flat(app)).not.toContain("hooks is now");
    expect(flat(app)).not.toContain("disableAllHooks is now");
    const from = top();
    await wheel(mouse, "up");
    expect(top()).toBe(from - 1);
  });

  // Release 8c plan, Task 2: mcpServers is LIVE, and until Task 10 applies it an edit does nothing and says nothing, so it
  // cannot fall through to scrollSpeed's branch as hooks' once did.
  it("leaves the scroll speed as it is on a live edit of mcpServers, and says no line for it", async () => {
    const { app, mouse, write } = await watching([], {}, { full: true, intro: said(80), scrollSpeed: 1 }, { scrollSpeed: "--scroll-speed" });
    const top = () => Number(/^said (\d+)\.$/.exec(shown(app)[0]!)![1]);
    write({ mode: "project", mcpServers: { tv: { command: "node", args: ["server.js"] } } });
    await sees(app, PINNED("ask")); // the edit was read, its entries in LIVE's order, mcpServers after mode
    expect(flat(app)).not.toContain("mcpServers is now");
    const from = top();
    await wheel(mouse, "up");
    expect(top()).toBe(from - 1);
  });

  // Review fixes plan, fix 6: 0.99 leaves 99 hundredths over, which speed 3 once read as 99 rows.
  it("starts a new scrollSpeed's first notch with nothing left over from the old one", async () => {
    const { app, mouse, write } = await watching([], { scrollSpeed: 0.99 }, { full: true, intro: said(80), scrollSpeed: 0.99 });
    const top = () => Number(/^said (\d+)\.$/.exec(shown(app)[0]!)![1]);
    await press(app, "\u001b[5~"); // PgUp, so there is room below
    await wheel(mouse, "down"); // moves no row, leaving 0.99 of one over
    write({ scrollSpeed: 3 });
    await sees(app, `scrollSpeed is now 3 ${FROM}`);
    const from = top();
    await wheel(mouse, "down");
    expect(top()).toBe(from + 3);
  });

  it("leaves an entry a flag or variable gave at launch as given, and says so", async () => {
    const { app, session, write } = await watching([], {}, {}, { lead: "TACHI_LEAD", mode: "--mode" });
    write({ lead: "ollama:b", mode: "project" });
    await sees(app, `settings.json's "lead" was left as TACHI_LEAD set it for this session`);
    await sees(app, `settings.json's "mode" was left as --mode set it for this session`);
    expect(session.lead.id).toBe("fake:a");
    expect(app.lastFrame()).toContain("perm ask");
  });

  // The watcher reads the settings file `where` on every event in its folder (settingsWatch.ts, watchSettings), so a
  // read of it once a file there is written shows the watcher has read what was written.
  const readsOf = (where: string) => async (write: () => void) => {
    const before = reads.get(where) ?? 0;
    write();
    await vi.waitFor(() => expect(reads.get(where) ?? 0).toBeGreaterThan(before), WATCHED);
  };

  // Choice 3: editors such as Notepad empty the file before writing it. Neither entry is given by a flag, so a reset
  // would show.
  it("takes an editor's empty write, then its full text, as one change, with no line resetting the rest", async () => {
    const { app, write, where } = await watching([], { mode: "project", maxTasks: 2 }, { mode: "project" });
    const read = readsOf(where);
    await read(() => write(""));
    write({ mode: "project", maxTasks: 3 });
    await sees(app, `maxTasks is now 3 ${FROM}`);
    expect(flat(app)).not.toContain('"mode" changes');
    expect(flat(app)).not.toContain("maxTasks is now 8");
  });

  it("keeps the last good settings through a broken edit, says what is wrong once, and applies good text after", async () => {
    let words = "";
    try {
      JSON.parse('{"mode": ');
    } catch (err) {
      words = (err as Error).message;
    }
    const line = `settings.json is not valid JSON: ${words}; the last good settings still apply`;
    const { app, write, where } = await watching([], { mode: "project" }, { mode: "project" });
    write('{"mode": ');
    await sees(app, line);
    expect(app.lastFrame()).toContain("perm project");
    const read = readsOf(where);
    await read(() => write("")); // an editor's empty write, then the same broken text again
    await read(() => write('{"mode": '));
    write({ mode: "ask" });
    await sees(app, PINNED("project"));
    expect(flat(app).split(line).length - 1).toBe(1);
  });

  // Choice 26, the user's: /lead, a /model pick and /screen change this window only, so the file keeps the user's own
  // text, and an edit of another entry does not put the file's lead back; an edit of "lead" or "screen" applies as any
  // edit does.
  it("leaves the file as it was on /lead, a /model pick and /screen, and applies a later edit of those entries", async () => {
    const made: string[] = [];
    const models = [{ provider: "fake", models: ["c"] }];
    const { app, write, where } = await watching([], { lead: "ollama:x" }, { models, made, full: true });
    await type(app, "/lead ollama:a");
    await type(app, "/model");
    await until(app, "fake:c");
    await tick(); // the picker starts reading keys just after it first appears
    app.stdin.write("\r");
    await waitFor(() => made.length === 2);
    await type(app, "/screen");
    await until(app, "screen is now classic");
    expect(readFileSync(where, "utf8")).toBe('{"lead":"ollama:x"}');
    write({ lead: "ollama:x", mode: "project" });
    await sees(app, PINNED("ask"));
    expect(made).toEqual(["ollama:a", "fake:c"]);
    write({ lead: "ollama:b", mode: "project", screen: "full" });
    await sees(app, `lead is now fake:b ${FROM}`);
    await sees(app, `screen is now full ${FROM}`);
    expect(made).toEqual(["ollama:a", "fake:c", "ollama:b"]);
    expect(readFileSync(where, "utf8")).toBe('{"lead":"ollama:b","mode":"project","screen":"full"}');
  });

  // Choice 16: on a first launch neither ~/.tachikoma nor the file is there yet.
  it("makes ~/.tachikoma on a first launch, and applies a settings file written there later", async () => {
    const home = freshHome();
    const { app } = await mount([], { home, live: { loaded: { settings: {}, warnings: [] }, given: {} } });
    expect(existsSync(settingsDir(home))).toBe(true);
    writeFileSync(path.join(settingsDir(home), "settings.json"), '{"mode": "project"}');
    await sees(app, PINNED("ask"));
  });

  // Choice 26: the settings file goes with the folder, and a missing one keeps the settings in force.
  it("keeps the settings and says the file is no longer watched once ~/.tachikoma is removed", async () => {
    const { app, where, write } = await watching([], { mode: "project" }, { mode: "project" });
    write({ mode: "project", maxTasks: 3 }); // an edit's line first, which the folder's line then replaces (noteAlone)
    await sees(app, `maxTasks is now 3 ${FROM}`);
    rmSync(path.dirname(where), { recursive: true });
    await sees(app, `${path.join("~", ".tachikoma")} was removed, so settings.json and keybindings.json are no longer watched this session`);
    expect(hintRow(app)!.startsWith(`${path.join("~", ".tachikoma")} was removed`)).toBe(true); // a live file's line (choice 35)
    expect(hintRow(app)).not.toContain("more above");
    expect(flat(app)).not.toContain('"mode" changes');
    expect(app.lastFrame()).toContain("perm project");
  });

  // mkdir and fs.watch can fail: a home that cannot be written, or Linux's limit on watches. Here `.tachikoma` is a
  // file, so no permission is changed.
  it("says the file is not watched when watching cannot start, and the session runs on", async () => {
    const home = freshHome();
    writeFileSync(settingsDir(home), "");
    let reason = "";
    try {
      mkdirSync(settingsDir(home), { recursive: true });
    } catch (err) {
      reason = (err as Error).message;
    }
    const { app } = await mount([reply("still here")], { home, live: { loaded: { settings: {}, warnings: [] }, given: {} } });
    expect(flat(app)).toContain(`settings.json and keybindings.json are not watched this session (${reason})`);
    await type(app, "hi");
    await until(app, "still here");
  });

  // The pick comes after the file's edit, so it wins, as a /lead typed then would.
  it("keeps the lead picked from the model list over one the file set while the list was open", async () => {
    const made: string[] = [];
    const { app, where, write } = await watching([], {}, { models: [{ provider: "fake", models: ["c"] }], made });
    const read = readsOf(where);
    await type(app, "/model");
    await until(app, "fake:c");
    await read(() => write({ lead: "ollama:y" }));
    app.stdin.write("\r");
    await sees(app, "lead is now fake:b");
    expect(made).toEqual(["fake:c"]); // the file's lead was never made, though the pick's closing the list ran next()
    expect(flat(app)).not.toContain(FROM);
  });

  // During the instruction files' question, say: the launch has read the file, and the watcher starts later.
  it("applies an edit made before watching started, without saying the launch's warnings again", async () => {
    const home = freshHome();
    mkdirSync(settingsDir(home));
    writeFileSync(path.join(settingsDir(home), "settings.json"), '{"leed": 1, "mode": "project"}');
    const loaded = readSettings('{"leed": 1}');
    if ("problem" in loaded) throw new Error(loaded.problem);
    const { app } = await mount([], { home, live: { loaded, given: {} } });
    await sees(app, PINNED("ask"));
    expect(flat(app)).not.toContain('"leed"');
  });

  it("says a new unknown entry's warning once", async () => {
    const warning = 'settings.json: "leed" is not a setting; it was left out';
    const { app, write } = await watching([], {});
    write({ leed: 1 });
    await sees(app, warning);
    write({ leed: 1, mode: "project" });
    await sees(app, PINNED("ask"));
    expect(flat(app).split(warning).length - 1).toBe(1);
  });

  // Release 6 plan, Task 9, "The launch's warnings show in the session too": full screen hides stderr, where the
  // launch printed them, until the user quits.
  it("shows the launch's settings warnings in full screen, but not in classic mode, where stderr is seen", async () => {
    const loaded = readSettings('{"leed": 1}');
    if ("problem" in loaded) throw new Error(loaded.problem);
    const warning = 'settings.json: "leed" is not a setting; it was left out';
    const full = await mount([], { full: true, home: freshHome(), live: { loaded, given: {} } });
    expect(full.app.lastFrame()).toContain(warning);
    const classic = await mount([], { home: freshHome(), live: { loaded, given: {} } });
    expect(classic.app.lastFrame()).not.toContain(warning);
  });

  // Release 7 plan, Task 4: the launch's line naming the kinds of the dangerous-command check that are off, in red, as it
  // says the check is weaker (the user's choice); in classic mode and -p only on stderr.
  it("shows in full screen, in red, which kinds of the dangerous-command check are off, and nothing while none is", async () => {
    await inColour(async () => {
      const start = "The dangerous-command check is off for: installing software, sending files out;";
      const line = `${start} in auto and never, those commands run without it.`;
      const launch = (dangerousCommands: Settings["dangerousCommands"]) => ({ loaded: { settings: { dangerousCommands }, warnings: [] }, given: {} });
      const off = launch({ add: [], off: ["installing software", "sending files out"] });
      const full = await mount([], { full: true, home: freshHome(), live: off });
      expect(full.app.lastFrame()).toContain(`\u001b[31m${start}`);
      expect(stripVTControlCharacters(full.app.lastFrame()!).replaceAll(/ *\n */g, " ")).toContain(line); // a wrapped row's colours sit around its break
      const classic = await mount([], { home: freshHome(), live: off });
      expect(classic.app.lastFrame()).not.toContain("dangerous-command check");
      const none = await mount([], { full: true, home: freshHome(), live: launch({ add: ["make deploy"], off: [] }) });
      expect(none.app.lastFrame()).not.toContain("dangerous-command check");
    });
  });

  // Release 7 plan, choice 22: the launch's line saying --network was ignored without the sandbox, which full screen hides
  // on stderr until the user quits, so it shows in the session too, grey as the settings file's warnings; in classic mode
  // only on stderr.
  it("shows in full screen, in grey, that --network was ignored without the sandbox, and nothing without the line", async () => {
    await inColour(async () => {
      const line = "--network acts only with the sandbox on; it was ignored";
      const live = { loaded: { settings: {}, warnings: [] }, given: { network: "--network" }, networkLine: line };
      const full = await mount([], { full: true, home: freshHome(), live });
      expect(full.app.lastFrame()).toContain(`\u001b[90m${line}`);
      const classic = await mount([], { home: freshHome(), live });
      expect(classic.app.lastFrame()).not.toContain(line);
      const none = await mount([], { full: true, home: freshHome(), live: { loaded: { settings: {}, warnings: [] }, given: {} } });
      expect(none.app.lastFrame()).not.toContain("--network");
    });
  });

  // Release 7 plan, Task 8: the launch's line saying git's settings could not be read, repeated in full screen as the
  // --network line is, grey as the settings file's warnings; in classic mode only on stderr.
  it("shows in full screen, in grey, that git's settings could not be read, and nothing without the line", async () => {
    await inColour(async () => {
      const line = "git's settings could not be read (stdout maxBuffer length exceeded); only the fixed list of protected paths applies";
      const live = { loaded: { settings: {}, warnings: [] }, given: {}, gitLine: line };
      const full = await mount([], { full: true, home: freshHome(), live });
      // Ink wraps it at the test terminal's 100 columns.
      expect(full.app.lastFrame()).toContain("\u001b[90mgit's settings could not be read (stdout maxBuffer length exceeded); only the fixed list of ");
      expect(full.app.lastFrame()).toContain("\u001b[90mprotected paths applies");
      const classic = await mount([], { home: freshHome(), live });
      expect(classic.app.lastFrame()).not.toContain("git's settings");
      const none = await mount([], { full: true, home: freshHome(), live: { loaded: { settings: {}, warnings: [] }, given: {} } });
      expect(none.app.lastFrame()).not.toContain("git's settings");
    });
  });

  // Release 6 plan, Task 11: the keys file beside the settings file, through the same watcher.
  const keysIn = (home: string) => path.join(settingsDir(home), "keybindings.json");
  const writeKeys = (home: string, data: object | string) => writeFileSync(keysIn(home), typeof data === "string" ? data : JSON.stringify(data));
  const globalKeys = (keys: Record<string, string | null>) => ({ bindings: [{ context: "Global", bindings: keys }] });
  const todo: TodoItem[] = [{ text: "write the fix", status: "pending" }];
  const parserWords = (text: string) => {
    try {
      JSON.parse(text);
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error("parsed");
  };

  it("rebinds a key from the keys file without a restart, and ? follows it", async () => {
    const home = freshHome();
    const { app, bus, where } = await watching([], {}, {}, {}, home);
    const read = readsOf(where);
    await read(() => writeKeys(home, globalKeys({ "ctrl+t": null, "ctrl+y": "app:toggleTodos" })));
    await tick();
    bus.emit("todo", todo);
    await tick();
    await press(app, "\u0014"); // Ctrl+T, now unbound
    expect(app.lastFrame()).toContain("write the fix");
    await press(app, "\u0019"); // Ctrl+Y
    expect(app.lastFrame()).not.toContain("write the fix");
    await press(app, "?");
    expect(app.lastFrame()).toContain("  Ctrl+Y  show or hide the to-do list");
    expect(app.lastFrame()).not.toContain("Ctrl+T");
    // Global is read at a question too, where Ctrl+T still does as at launch (choice 32).
    expect(flat(app)).toContain(HELD);
  });

  // Release 6 plan, choice 30 (security review finding 1): a shell command could rewrite the keys file so that n and Esc
  // answer yes. After a live edit every key answers a question as at launch, the rest of the edit applies, and a line
  // says so; at launch the file applies whole, as the user's own choice. Since choice 32 a question reads the launch's
  // keys whole, and its hint names them.
  const PAYLOAD = [
    { context: "Confirmation", bindings: { n: "confirm:yes", escape: "confirm:yes" } },
    { context: "Global", bindings: { enter: "confirm:yes" } },
  ];
  const HELD = "keybindings.json: at a permission question the keys stay as at launch, and a key newly bound to switch the mode does nothing, until the next launch; the rest apply now";

  it("keeps the keys that answer a question as at launch after a live edit, says so, and applies the rest", async () => {
    const home = freshHome();
    const { app, bus, ask, where } = await watching([], {}, {}, {}, home);
    const read = readsOf(where);
    await read(() => writeKeys(home, { bindings: [...PAYLOAD, { context: "Global", bindings: { "ctrl+y": "app:toggleTodos" } }] }));
    await sees(app, HELD);
    let answer = ask("write a.txt");
    await until(app, "Allow write a.txt? [y/n] · Esc to decline");
    await press(app, "\r"); // Enter answers nothing
    expect(app.lastFrame()).toContain("Allow write a.txt? [y/n]");
    await press(app, "n");
    expect(await answer).toBe(false);
    answer = ask("write b.txt");
    await until(app, "Allow write b.txt? [y/n]");
    await press(app, "\u001b");
    expect(await answer).toBe(false);
    answer = ask("write c.txt");
    await until(app, "Allow write c.txt? [y/n]");
    await press(app, "y");
    expect(await answer).toBe(true);
    bus.emit("todo", todo);
    await tick();
    await press(app, "\u0019"); // Ctrl+Y, from the same edit
    expect(app.lastFrame()).not.toContain("write the fix");
  });

  it("applies keys that answer a question from the keys file at launch, with no line", async () => {
    const home = freshHome();
    mkdirSync(settingsDir(home));
    writeKeys(home, { bindings: PAYLOAD });
    const { app, ask } = await watching([], {}, {}, {}, home);
    const answer = ask("write a.txt");
    await until(app, "Allow write a.txt?"); // no key left declines, so the question names none
    await press(app, "n");
    expect(await answer).toBe(true);
    expect(flat(app)).not.toContain(HELD);
  });

  // Found at the combined review: a chord the prompt started went on into a question, where Chat is not in force, so a
  // live Chat chord on a made a, then n at the question, the launch's Confirmation "a n" (yes), where at launch a was
  // typed and n said no. A question drops a chord waiting as it opens, so a stroke typed for the prompt never joins its keys.
  it("drops a chord the prompt started when a question opens, so n still declines", async () => {
    const home = freshHome();
    mkdirSync(settingsDir(home));
    const launchKeys = { context: "Confirmation", bindings: { "a n": "confirm:yes" } };
    writeKeys(home, { bindings: [launchKeys] });
    const { app, ask, where } = await watching([], {}, {}, {}, home);
    const read = readsOf(where);
    await read(() => writeKeys(home, { bindings: [launchKeys, { context: "Chat", bindings: { "a b": "chat:stash" } }] }));
    await tick();
    // The clock stands still from here (timers still run), so the chord's 3 s cannot end it however slow the machine,
    // and only the question's opening can (found at the re-review).
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await press(app, "a"); // Chat's chord a b waits
      expect(app.lastFrame()).toContain("a ...");      const answer = ask("write a.txt");
      await until(app, "Allow write a.txt? [y/n]");
      await press(app, "n");
      expect(await answer).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // Release 6 plan, choice 32 (the outside review of PR #5): the reviewer's repro. At launch, z x x a b at a question
  // reads z x (Global's z x a waiting), drops it at the second x, which then starts x a, and b answers nothing. A live
  // edit adding a harmless Global z x x passed choice 30's check, and regrouped the same keys into z x x, then a b, the
  // launch's own yes. A question now reads the launch's keys whole, so it is not answered.
  it("answers a question from the launch's keys whole, so a live chord cannot regroup keys into a launch answer", async () => {
    const home = freshHome();
    mkdirSync(settingsDir(home));
    const launchFile = [
      { context: "Confirmation", bindings: { "a b": "confirm:yes" } },
      { context: "Global", bindings: { "z x a": "app:toggleTodos", "x a": "app:toggleTodos" } },
    ];
    writeKeys(home, { bindings: launchFile });
    const { app, ask, where } = await watching([], {}, {}, {}, home);
    const read = readsOf(where);
    await read(() => writeKeys(home, { bindings: [...launchFile, { context: "Global", bindings: { "z x x": "app:toggleTodos" } }] }));
    await sees(app, HELD);
    vi.useFakeTimers({ toFake: ["Date"] }); // the clock stands still, so no chord's 3 s end it on a slow machine
    try {
      const answer = ask("write a.txt");
      await until(app, "Allow write a.txt? [y/n]");
      await press(app, "z", "x", "x", "a", "b");
      expect(app.lastFrame()).toContain("Allow write a.txt? [y/n]"); // still asked
      await press(app, "n");
      expect(await answer).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // Choice 32: a chord half typed at a question that closes without the key ending it (its owner stopped) is dropped
  // as the question closes, so it neither runs on into the prompt's keys nor stays in the hint row.
  it("drops a chord half typed at a question when the question closes", async () => {
    const home = freshHome();
    mkdirSync(settingsDir(home));
    writeKeys(home, globalKeys({ "z x": "app:toggleTodos" }));
    const { app, ask, bus } = await watching([], {}, {}, {}, home);
    bus.emit("todo", todo);
    vi.useFakeTimers({ toFake: ["Date"] }); // the clock stands still, so only the closing can end the chord
    try {
      const stop = new AbortController();
      const answer = ask("write a.txt", undefined, { name: "t1", signal: stop.signal, stop: () => stop.abort() });
      await until(app, "write a.txt? [y/n]");
      await press(app, "z");
      expect(app.lastFrame()).toContain("z ...");
      stop.abort();
      expect(await answer).toBe(false);
      await tick();
      expect(app.lastFrame()).not.toContain("z ...");
      await press(app, "x"); // typed, not the chord's end
      expect(app.lastFrame()).toContain("› x");
      expect(app.lastFrame()).toContain("write the fix");
    } finally {
      vi.useRealTimers();
    }
  });

  // Release 6 plan, choice 32 (the user's: "Yes, close it"): a shell command could bind chat:cycleMode to a key the user
  // types anyway, so typing would flip ask to project. A stroke switches the mode only where the launch's keys, reading
  // every stroke as if alone, switch it too; a stroke the live keys alone bind to it does nothing.
  it("switches the mode only on a key the launch's keys switch it on, whatever a live edit binds", async () => {
    const home = freshHome();
    const { app, gate, where } = await watching([], {}, {}, {}, home);
    const read = readsOf(where);
    await read(() => writeKeys(home, { bindings: [{ context: "Chat", bindings: { space: "chat:cycleMode", "z m": "chat:cycleMode" } }] }));
    await sees(app, HELD);
    vi.useFakeTimers({ toFake: ["Date"] }); // the clock stands still, so no chord's 3 s end it on a slow machine
    try {
      await press(app, "a", " ", "b", "z", "m");
      expect(gate.mode).toBe("ask");
      expect(flat(app)).not.toContain("mode is now");
      expect(app.lastFrame()).toContain("› ab"); // the space did nothing, and z m was a chord
      await press(app, "\u001b[Z");
      expect(gate.mode).toBe("project");
      expect(flat(app)).toContain("mode is now project");
    } finally {
      vi.useRealTimers();
    }
  });

  // Each table keeps its own chord: at launch a then Shift+Tab is the launch's chord a shift+tab, a stash, so a live
  // edit taking that chord out cannot make the same keys switch the mode, though Shift+Tab alone still does.
  it("reads a stroke by the launch's own chords, so a live edit cannot regroup keys into the mode key", async () => {
    const home = freshHome();
    mkdirSync(settingsDir(home));
    const launchFile = { context: "Chat", bindings: { "a shift+tab": "chat:stash" } };
    writeKeys(home, { bindings: [launchFile] });
    const { app, gate, where } = await watching([], {}, {}, {}, home);
    const read = readsOf(where);
    await read(() => writeKeys(home, { bindings: [{ context: "Chat", bindings: { "a shift+tab": null } }] }));
    await tick();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await press(app, "a");
      expect(app.lastFrame()).toContain("› a"); // the edit landed: only the live keys type a, the launch's wait on it
      await press(app, "\u001b[Z");
      expect(gate.mode).toBe("ask");
      await press(app, "\u001b[Z");
      expect(gate.mode).toBe("project");
    } finally {
      vi.useRealTimers();
    }
  });

  // Unbinding the mode key weakens nothing, so it applies at once, and ? names only a key that switches the mode.
  it("applies a live edit taking the mode key out at once, and ? names no key the launch's keys would not switch on", async () => {
    const home = freshHome();
    const { app, gate, where } = await watching([], {}, {}, {}, home);
    const read = readsOf(where);
    await read(() => writeKeys(home, { bindings: [{ context: "Chat", bindings: { "shift+tab": null, space: "chat:cycleMode" } }] }));
    await sees(app, HELD);
    await press(app, "\u001b[Z", " ");
    expect(gate.mode).toBe("ask");
    await press(app, "?");
    expect(app.lastFrame()).not.toContain("permission mode");
  });

  // Choice 32: outside a question the launch's keys read every stroke too, so a chord they start at the prompt is
  // dropped as a question opens, as the live keys' is (above), and never joins the question's keys.
  it("drops a chord the launch's keys started at the prompt when a question opens, after a live edit", async () => {
    const home = freshHome();
    mkdirSync(settingsDir(home));
    const launchFile = { context: "Global", bindings: { "a n": "confirm:yes" } };
    writeKeys(home, { bindings: [launchFile] });
    const { app, ask, where } = await watching([], {}, {}, {}, home);
    const read = readsOf(where);
    await read(() => writeKeys(home, { bindings: [{ context: "Global", bindings: { "ctrl+y": "app:toggleTodos" } }] }));
    await sees(app, HELD);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await press(app, "a"); // typed into the prompt by the live keys; the launch's a n waits
      const answer = ask("write a.txt");
      await until(app, "Allow write a.txt? [y/n]");
      await press(app, "n");
      expect(await answer).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // The code review of choice 32: the question on screen drops a chord waiting as it closes, so one half typed at it,
  // cancelled, never joins the keys of the next question in the line.
  it("drops a chord half typed at a cancelled question before the next question in the line reads a key", async () => {
    const home = freshHome();
    mkdirSync(settingsDir(home));
    writeKeys(home, globalKeys({ "z n": "confirm:yes" }));
    const { app, ask } = await watching([], {}, {}, {}, home);
    vi.useFakeTimers({ toFake: ["Date"] }); // the clock stands still, so only the closing can end the chord
    try {
      const stop = new AbortController();
      const first = ask("write a.txt", undefined, { name: "t1", signal: stop.signal, stop: () => stop.abort() });
      const second = ask("write b.txt");
      await until(app, "write a.txt? [y/n]");
      await press(app, "z");
      stop.abort();
      expect(await first).toBe(false);
      await until(app, "Allow write b.txt? [y/n]");
      await press(app, "n"); // n alone: no
      expect(await second).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // The code review of choice 32: a question asked while the model list is open waits under it, and the key that
  // closes the list is read by both tables. Here the launch's keys start their chord Esc n on it, which the live keys
  // no longer have; the first key read at the question drops it (app/keyRouting.ts, lookUp's `asked`), so n still
  // declines.
  it("drops a chord the launch's keys started in the model list before the question under it reads a key", async () => {
    const home = freshHome();
    mkdirSync(settingsDir(home));
    writeKeys(home, globalKeys({ "escape n": "confirm:yes" }));
    const { app, ask, where } = await watching([], {}, { models: [{ provider: "fake", models: ["c"] }] }, {}, home);
    const read = readsOf(where);
    await read(() => writeKeys(home, globalKeys({ "ctrl+y": "app:toggleTodos" })));
    await sees(app, HELD);
    await type(app, "/model");
    await until(app, "fake:c");
    await tick(); // the picker starts reading keys just after it first appears
    vi.useFakeTimers({ toFake: ["Date"] }); // the clock stands still, so no chord's 3 s end it on a slow machine
    try {
      const answer = ask("write a.txt");
      await tick();
      expect(app.lastFrame()).not.toContain("Allow write a.txt"); // the list is drawn over it
      await press(app, "\u001b"); // the live keys close the list
      await until(app, "Allow write a.txt? [y/n]");
      await press(app, "n");
      expect(await answer).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // The code review of choice 32: a click picks from the model list without a key, so a chord the list's keys started
  // still waits when the question under it is drawn. The question's keys are not waiting on it (the first key there
  // drops it, as above), so the hint row does not name it.
  it("names no chord over a question that the question's keys are not waiting on", async () => {
    const bindings = new Bindings(tableOf({ ...DEFAULTS, Global: { ...DEFAULTS.Global, "ctrl+k ctrl+x": "app:toggleTodos" } }));
    const { app, ask, mouse } = await mount([], { full: true, bindings, models: [{ provider: "fake", models: ["a", "b"] }] });
    await type(app, "/model");
    await until(app, "fake:b");
    await tick(); // the picker starts reading keys just after it first appears
    vi.useFakeTimers({ toFake: ["Date"] }); // the clock stands still, so no chord's 3 s end it on a slow machine
    try {
      const answer = ask("write a.txt");
      await tick();
      await press(app, "\u000b"); // Ctrl+K: the chord ctrl+k ctrl+x waits
      await pointer(mouse, ...click(4, shown(app).indexOf("  fake:b")));
      await until(app, "Allow write a.txt? [y/n]");
      expect(app.lastFrame()).not.toContain("ctrl+k ...");
      await press(app, "n");
      expect(await answer).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // The outside review of PR #5's second round: a question waiting in the line, not on screen, that is cancelled leaves
  // a chord half typed at the one on screen as it is, so z y still reads as the launch's z y (no), not y (yes).
  it("keeps a chord half typed at the question on screen when one waiting behind it is cancelled", async () => {
    const home = freshHome();
    mkdirSync(settingsDir(home));
    writeKeys(home, globalKeys({ "z y": "confirm:no" }));
    const { app, ask } = await watching([], {}, {}, {}, home);
    vi.useFakeTimers({ toFake: ["Date"] }); // the clock stands still, so no chord's 3 s end it on a slow machine
    try {
      const first = ask("write a.txt");
      const stop = new AbortController();
      const second = ask("write b.txt", undefined, { name: "t1", signal: stop.signal, stop: () => stop.abort() });
      await until(app, "Allow write a.txt? [y/n]");
      await press(app, "z");
      stop.abort();
      expect(await second).toBe(false);
      await press(app, "y"); // ends z y: no
      expect(await first).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // The code re-check of choice 32: the last key was read in the model list, not at a question, so cancelling the
  // question under it leaves the chord half typed in the list to the list's keys, and Ctrl+K Enter still toggles the
  // to-do list rather than Enter picking.
  it("keeps a chord half typed in the model list when the question under it is cancelled", async () => {
    const bindings = new Bindings(tableOf({ ...DEFAULTS, Global: { ...DEFAULTS.Global, "ctrl+k enter": "app:toggleTodos" } }));
    const made: string[] = [];
    const { app, ask, bus } = await mount([], { bindings, made, models: [{ provider: "fake", models: ["a", "b"] }] });
    bus.emit("todo", todo);
    await tick();
    expect(app.lastFrame()).toContain("write the fix");
    await type(app, "/model");
    await until(app, "fake:b");
    await tick(); // the picker starts reading keys just after it first appears
    vi.useFakeTimers({ toFake: ["Date"] }); // the clock stands still, so no chord's 3 s end it on a slow machine
    try {
      const stop = new AbortController();
      const answer = ask("write a.txt", undefined, { name: "t1", signal: stop.signal, stop: () => stop.abort() });
      await tick();
      await press(app, "\u000b"); // the chord ctrl+k enter waits; Ctrl+K alone does nothing in the list
      stop.abort();
      expect(await answer).toBe(false);
      await press(app, "\r"); // ends the chord
      expect(made).toEqual([]); // no model picked
      expect(app.lastFrame()).toContain("fake:b"); // the list still open
      await press(app, "\u001b");
      await until(app, "? for shortcuts");
      expect(app.lastFrame()).not.toContain("write the fix"); // the chord hid the to-do list
    } finally {
      vi.useRealTimers();
    }
  });

  // The code re-check of choice 32 (its fuzz's rare path): z typed at question A, the model list then opening over A
  // with no key between (its read ending), A cancelled under the list, and the list closed by a click, no key between
  // either. The chord z was typed at the question on screen, the last key read there, so A's closing drops it, and n at
  // the next question declines rather than ending the launch's z n (yes).
  it("drops a chord typed at a question that the model list then opened over, when that question is cancelled", async () => {
    const bindings = new Bindings(tableOf({ ...DEFAULTS, Global: { ...DEFAULTS.Global, "z n": "confirm:yes" } }));
    let list = () => {};
    const listing = new Promise<void>((resolve) => (list = resolve));
    const made: string[] = [];
    const { app, ask, mouse } = await mount([], { full: true, bindings, made, listing, models: [{ provider: "fake", models: ["a", "b"] }] });
    await type(app, "/model"); // its read waits
    vi.useFakeTimers({ toFake: ["Date"] }); // the clock stands still, so no chord's 3 s end it on a slow machine
    try {
      const stop = new AbortController();
      const first = ask("write a.txt", undefined, { name: "t1", signal: stop.signal, stop: () => stop.abort() });
      const second = ask("write b.txt");
      await until(app, "write a.txt? [y/n]");
      await press(app, "z"); // the launch's chord z n waits
      list();
      await until(app, "fake:b"); // the list opens over the question
      await tick(); // the picker starts reading keys just after it first appears
      stop.abort();
      expect(await first).toBe(false);
      await pointer(mouse, ...click(4, shown(app).indexOf("  fake:b")));
      await until(app, "Allow write b.txt? [y/n]");
      expect(made).toEqual(["fake:b"]);
      await press(app, "n"); // n alone: no
      expect(await second).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // Release 6 plan, choice 35 (the user's: "Hint row, until a key"): a live edit's lines show in the hint row too, the row
  // over the status line, until the next key, the last of an edit's lines with how many more are in the conversation.
  const hintRow = (app: ReturnType<typeof render>) => {
    const rows = app.lastFrame()!.split("\n");
    return rows[rows.findIndex((r) => /^ ?lead \S+ [|]/.test(r)) - 1];
  };
  it("shows a live edit's line in the hint row until the next key, and how many more an edit said", async () => {
    const { app, write } = await watching([], {});
    write({ maxTasks: 3 });
    await sees(app, `maxTasks is now 3 ${FROM}`);
    expect(hintRow(app)).toBe(`maxTasks is now 3 ${FROM}`);
    await press(app, "x");
    expect(hintRow(app)).toBe("? for shortcuts");
    expect(flat(app)).toContain(`maxTasks is now 3 ${FROM}`); // still in the conversation
    write({ maxTasks: 2, scrollSpeed: 1 });
    await sees(app, `scrollSpeed is now 1 ${FROM}`);
    expect(hintRow(app)).toBe(`scrollSpeed is now 1 ${FROM} (+1 more above)`);
    write({ maxTasks: 2, scrollSpeed: 1, mode: "project" }); // a newer edit replaces it
    await sees(app, PINNED("ask"));
    expect(hintRow(app)).toBe(PINNED("ask"));
  });

  it("shows a problem from a live edit in the hint row in red, until the next key", async () => {
    await inColour(async () => {
      const { app, write } = await watching([], {});
      write('{"mode": ');
      const red = "\u001b[31msettings.json is not valid JSON";
      await vi.waitFor(() => expect(app.lastFrame()!.split(red).length - 1).toBe(2), WATCHED); // the conversation's and the hint row's
      await press(app, "x");
      expect(app.lastFrame()!.split(red).length - 1).toBe(1);
    });
  });

  it("shows a line said while the editor was open in the hint row once Tachikoma is back", async () => {
    const editor = standInEditor();
    editor.next('{"effort": "low"}\n');
    vi.stubEnv("VISUAL", editor.command("wait"));
    const home = freshHome();
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    const lead = Object.assign(new FakeProvider("a", []), { setEffort: vi.fn() });
    const { app } = await mount([], { lead, home, live: { loaded: { settings: {}, warnings: [] }, given: {} } });
    await type(app, "/settings");
    await vi.waitFor(() => expect(lead.setEffort).toHaveBeenCalledWith("low"), WATCHED); // read while the editor is open
    editor.go();
    await sees(app, `effort is now low ${FROM}`);
    expect(hintRow(app)).toBe(`effort is now low ${FROM}`);
  });

  it("shows a keys file edit's line in the hint row until a key", async () => {
    const home = freshHome();
    const { app } = await watching([], {}, {}, {}, home);
    const reserved = 'keybindings.json: Global "ctrl+c" is a reserved key; it was left out';
    writeKeys(home, globalKeys({ "ctrl+c": null }));
    await sees(app, reserved);
    expect(hintRow(app)).toBe(reserved);
    await press(app, "x");
    expect(hintRow(app)).toBe("? for shortcuts");
  });

  // A lead the file set waits for the turn to end (applyEntry), and its line, said then, joins that edit's lines.
  it("adds a lead the file set, applied once the turn ends, to that edit's line in the hint row", async () => {
    const lead = new Held();
    const { app, write } = await watching([], {}, { lead });
    await type(app, "go");
    write({ lead: "ollama:b", maxTasks: 3 });
    await sees(app, `maxTasks is now 3 ${FROM}`);
    expect(hintRow(app)).toBe(`maxTasks is now 3 ${FROM}`); // shown during the turn, where the row was empty
    lead.answer("done");
    await sees(app, `lead is now fake:b ${FROM}`);
    expect(hintRow(app)).toBe(`lead is now fake:b ${FROM} (+1 more above)`);
  });

  // The user's: "Notice wins (Recommended)": over vim's mode until a key, which then shows again.
  it("shows a live edit's line over vim's mode until a key, and vim's mode after", async () => {
    const { app, write } = await watching([], { editorMode: "vim" });
    expect(hintRow(app)).toBe("-- INSERT --");
    write({ editorMode: "vim", maxTasks: 3 });
    await sees(app, `maxTasks is now 3 ${FROM}`);
    expect(hintRow(app)).toBe(`maxTasks is now 3 ${FROM}`);
    await press(app, "x");
    expect(hintRow(app)).toBe("-- INSERT --");
  });

  // What ranks over the line keeps the row: here the queue's hint, during a turn.
  it("leaves the hint row to the queue's hint while a live edit's line waits", async () => {
    const lead = new Held();
    const { app, write } = await watching([], {}, { lead });
    await type(app, "go");
    await type(app, "next");
    const queued = hintRow(app);
    expect(queued).toMatch(/queued/);
    write({ maxTasks: 3 });
    await sees(app, `maxTasks is now 3 ${FROM}`);
    expect(hintRow(app)).toBe(queued);
  });

  // The code review of choice 35: Node's JSON error quotes the file, line breaks and all, and the hint row has one row
  // (layout.ts, frame), so its copy of a line is one line: the frame keeps to the terminal's height.
  it.each(["settings.json", "keybindings.json"])("shows a %s problem with line breaks in one hint row", async (name) => {
    const home = freshHome();
    const { app, write } = await watching([], {}, { full: true }, {}, home);
    const rows = app.lastFrame()!.split("\n").length;
    if (name === "settings.json") write('{\n  "mode": ask\n}');
    else writeKeys(home, '{\n  "bindings": a\n}');
    await vi.waitFor(() => expect(hintRow(app)!.startsWith(`${name} is not valid JSON`)).toBe(true), WATCHED);
    expect(app.lastFrame()!.split("\n").length).toBe(rows);
  });

  // The code review of choice 35: a paste is pressing keys too, so it takes the line away; the wheel does not.
  it("takes a live edit's line out of the hint row on a paste", async () => {
    const { app, write } = await watching([], {});
    write({ maxTasks: 3 });
    await sees(app, `maxTasks is now 3 ${FROM}`);
    await press(app, "\u001b[200~pasted\u001b[201~");
    expect(app.lastFrame()).toContain("› pasted");
    expect(hintRow(app)).toBe("? for shortcuts");
  });

  // The code review of choice 35: the settings file and the keys file changed in one read of the folder are one edit.
  it("counts the lines of both files changed in one read as one edit's", async () => {
    const home = freshHome();
    const { app, write } = await watching([], {}, {}, {}, home);
    const reserved = 'keybindings.json: Global "ctrl+c" is a reserved key; it was left out';
    write({ maxTasks: 3 });
    writeKeys(home, globalKeys({ "ctrl+c": null }));
    await sees(app, reserved);
    expect(flat(app)).toContain(`maxTasks is now 3 ${FROM}`);
    expect(hintRow(app)).toBe(`${reserved} (+1 more above)`);
  });

  it("runs /screen from a key bound to command:screen, after the turn running, leaving the prompt as typed", async () => {
    const home = freshHome();
    mkdirSync(settingsDir(home));
    writeKeys(home, { bindings: [{ context: "Chat", bindings: { "ctrl+y": "command:screen" } }] });
    const lead = new Held();
    const { app } = await watching([], {}, { lead }, {}, home);
    await type(app, "go");
    await press(app, "ab", "\u0019");
    expect(flat(app)).not.toContain("screen is now");
    lead.answer("done");
    await sees(app, "screen is now full");
    expect(app.lastFrame()).toContain("› ab");
  });

  it("lists a key bound to a command on ?, and runs it at once when idle, leaving the prompt as typed", async () => {
    const home = freshHome();
    mkdirSync(settingsDir(home));
    writeKeys(home, { bindings: [{ context: "Chat", bindings: { "ctrl+y": "command:screen" } }] });
    const { app } = await watching([], {}, {}, {}, home);
    await press(app, "?");
    expect(app.lastFrame()).toContain("  Ctrl+Y  /screen");
    await press(app, "ab", "\u0019");
    await sees(app, "screen is now full");
    expect(app.lastFrame()).toContain("› ab");
  });

  // Choice 26, the user's: the keys file goes with the folder, and a missing one keeps the keys in force.
  it("keeps the keys file's keys once ~/.tachikoma is removed with it, and says it is no longer watched", async () => {
    const home = freshHome();
    const { app, bus, where } = await watching([], {}, {}, {}, home);
    const read = readsOf(where);
    await read(() => writeKeys(home, globalKeys({ "ctrl+t": null })));
    await tick();
    bus.emit("todo", todo);
    await tick();
    await press(app, "\u0014"); // Ctrl+T, unbound by the file
    expect(app.lastFrame()).toContain("write the fix");
    rmSync(path.dirname(where), { recursive: true });
    await sees(app, `${path.join("~", ".tachikoma")} was removed, so settings.json and keybindings.json are no longer watched this session`);
    await press(app, "\u0014"); // Ctrl+T, still unbound
    expect(app.lastFrame()).toContain("write the fix");
  });

  // Choice 26, the user's: an editor that saves by renaming a new file over the old one leaves no keys file for a
  // moment, which is skipped, so the keys stay and the file's problems are not said again.
  it("keeps the keys while the keys file is missing, and says its problems once when it is back the same", async () => {
    const home = freshHome();
    const { app, where, write } = await watching([], {}, {}, {}, home);
    const reserved = 'keybindings.json: Global "ctrl+c" is a reserved key; it was left out';
    writeKeys(home, globalKeys({ "ctrl+t": null, "ctrl+c": null }));
    await sees(app, reserved);
    const read = readsOf(where);
    await read(() => unlinkSync(keysIn(home)));
    await read(() => writeKeys(home, globalKeys({ "ctrl+t": null, "ctrl+c": null })));
    write({ mode: "project" });
    await sees(app, PINNED("ask")); // drawn after anything the reads above said
    expect(flat(app).split(reserved).length - 1).toBe(1);
  });

  it("says the keys file's problems in the conversation, each once while it stays, and keeps the keys before a broken edit", async () => {
    const home = freshHome();
    mkdirSync(settingsDir(home));
    writeKeys(home, '{"bindings": ');
    const { app, bus, where } = await watching([], {}, {}, {}, home);
    await sees(app, `keybindings.json is not valid JSON: ${parserWords('{"bindings": ')}; the default keys apply`);
    const reserved = 'keybindings.json: Global "ctrl+c" is a reserved key; it was left out';
    writeKeys(home, globalKeys({ "ctrl+t": null, "ctrl+c": null }));
    await sees(app, reserved);
    const read = readsOf(where);
    await read(() => writeKeys(home, globalKeys({ "ctrl+t": null, "ctrl+c": null, "ctrl+y": "app:toggleTodos" })));
    writeKeys(home, '{"bindings": [');
    await sees(app, `keybindings.json is not valid JSON: ${parserWords('{"bindings": [')}; the last good keys still apply`);
    expect(flat(app).split(reserved).length - 1).toBe(1);
    bus.emit("todo", todo);
    await tick();
    await press(app, "\u0019"); // Ctrl+Y, from the last good keys
    expect(app.lastFrame()).not.toContain("write the fix");
  });

  // Release 6 plan, Task 12: a live edit of "editor" says its line, as the entries above do; VISUAL and EDITOR come
  // before the file (release 6 design, "The external editor"), as a flag does.
  it("says a changed editor, the one that applies once the entry is removed, and that EDITOR keeps its own", async () => {
    vi.stubEnv("VISUAL", "");
    const { app, write, where } = await watching([], {});
    const home = path.dirname(path.dirname(where));
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    write({ editor: "code --wait" });
    await sees(app, `editor is now code --wait ${FROM}`);
    write({});
    await sees(app, `editor is now ${process.platform === "win32" ? system32("notepad.exe") : "vi"} ${FROM}`);
    vi.stubEnv("EDITOR", "nano");
    write({ editor: "vim" });
    await sees(app, `settings.json's "editor" was left as EDITOR set it for this session`);
  });

  // Release 6 plan, Task 12: the real file opens in the editor, made first when missing, so each save reaches the
  // watcher while the editor is still open. The stand-in saves, then waits for `go`.
  it("makes a missing settings file on /settings and opens it, the watcher applying a save while the editor is open", async () => {
    const editor = standInEditor();
    editor.next('{"effort": "low"}\n');
    vi.stubEnv("VISUAL", editor.command("wait"));
    const home = freshHome();
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    const lead = Object.assign(new FakeProvider("a", []), { setEffort: vi.fn() }); // a live mode edit changes nothing (choice 32)
    const { app } = await mount([], { lead, home, live: { loaded: { settings: {}, warnings: [] }, given: {} } });
    await type(app, "/settings");
    await vi.waitFor(() => expect(editor.started()).toBe(true), WATCHED);
    expect(editor.given()).toEqual({ file: path.join(settingsDir(home), "settings.json"), text: "{}\n" });
    await vi.waitFor(() => expect(lead.setEffort).toHaveBeenCalledWith("low"), WATCHED);
    editor.go();
    await sees(app, `effort is now low ${FROM}`);
  });

  it("makes a missing keys file on /keybindings, with two-space indents, and opens it", async () => {
    const editor = standInEditor();
    vi.stubEnv("VISUAL", editor.command("keep"));
    const home = freshHome();
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    const { app } = await mount([], { home });
    await type(app, "/keybindings");
    const file = path.join(settingsDir(home), "keybindings.json");
    await vi.waitFor(() => expect(editor.given()).toEqual({ file, text: '{\n  "bindings": []\n}\n' }), WATCHED);
  });

  it("opens the settings file as it is when there is one", async () => {
    const editor = standInEditor();
    vi.stubEnv("VISUAL", editor.command("keep"));
    const { app, where } = await watching([], { mode: "project" });
    const home = path.dirname(path.dirname(where));
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    await type(app, "/settings");
    await vi.waitFor(() => expect(editor.given()).toEqual({ file: where, text: '{"mode":"project"}' }), WATCHED);
  });

  it("names /settings and /keybindings in the unknown command's list and the / menu", async () => {
    const { app } = await mount([]);
    await type(app, "/nope");
    await sees(app, "/errors, /screen, /settings, /keybindings, /vim, /exit");
    await press(app, "/", "k");
    expect(app.lastFrame()).toContain("› /k\n  /keybindings  Open the keys file in your editor\n");
    await press(app, "\u007f", "s", "e");
    expect(app.lastFrame()).toContain("› /se\n  /settings  Open the settings file in your editor\n");
  });

  it("says /settings and /keybindings take nothing after them", async () => {
    const { app } = await mount([]);
    await type(app, "/settings now");
    await until(app, "/settings takes nothing after it.");
    await type(app, "/keybindings now");
    await until(app, "/keybindings takes nothing after it.");
  });

  it("says the editor failed on /settings as on Ctrl+G", async () => {
    const editor = standInEditor();
    vi.stubEnv("VISUAL", editor.command("fail"));
    const home = freshHome();
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    const { app } = await mount([], { home });
    await type(app, "/settings");
    await sees(app, `The editor failed (exit code 1). Set VISUAL or EDITOR, or "editor" in ${shownFile()}.`);
  });

  // "screen" applies as /screen does, waiting where /screen waits (release 6 design's table): here for the editor the
  // edit was made in to close.
  it("switches the screen a save in /settings's editor asks for once the editor closes", async () => {
    const editor = standInEditor();
    editor.next('{"screen": "classic", "effort": "low"}\n');
    vi.stubEnv("VISUAL", editor.command("wait"));
    const home = freshHome();
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    const lead = Object.assign(new FakeProvider("a", []), { setEffort: vi.fn() }); // a live mode edit changes nothing (choice 32)
    const { app } = await mount([], { lead, full: true, home, live: { loaded: { settings: {}, warnings: [] }, given: {} } });
    await type(app, "/settings");
    await vi.waitFor(() => expect(lead.setEffort).toHaveBeenCalledWith("low"), WATCHED); // the save read, its screen waiting
    await tick();
    editor.go();
    await sees(app, `screen is now classic ${FROM}`);
    expect(flat(app)).not.toContain("suspended");
  });

  // Release 6 plan, Task 21: editorMode at once, as /vim, whose own switch saves nothing, so a later edit applies.
  it("starts in vim mode from the file, switches it on an edit of editorMode, after /vim too, and says a remaps edit", async () => {
    const launched = await watching([], { editorMode: "vim" });
    expect(launched.app.lastFrame()).toContain("-- INSERT --");
    const { app, write } = await watching([], {});
    await type(app, "/vim");
    await until(app, "-- INSERT --");
    write({ editorMode: "vim" });
    await sees(app, `editorMode is now vim ${FROM}`);
    await press(app, "\u001b"); // the edit's line holds the hint row until a key (choice 35); vim takes Esc
    expect(app.lastFrame()).toContain("-- NORMAL --");
    write({ editorMode: "normal", vimInsertModeRemaps: { jj: "<Esc>", jk: "<Esc>" } });
    await sees(app, `editorMode is now normal ${FROM}`);
    await sees(app, `vimInsertModeRemaps is now jj, jk ${FROM}`);
    expect(app.lastFrame()).not.toMatch(/-- (INSERT|NORMAL) --/); // vim mode's hint gone; the edit's lines show (choice 35)
    write({ editorMode: "normal" });
    await sees(app, `vimInsertModeRemaps is now none ${FROM}`);
  });

  it("goes to NORMAL on a vimInsertModeRemaps pair typed within 1 s, from the key after the edit, leaving neither key", async () => {
    const { app, write } = await watching([], { editorMode: "vim" });
    write({ editorMode: "vim", vimInsertModeRemaps: { jj: "<Esc>" } });
    await sees(app, `vimInsertModeRemaps is now jj ${FROM}`);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // The clock moved on by `ms`, then one turn of the event loop (setImmediate is not faked), in which the screen is drawn.
    const wait = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      await new Promise((resolve) => setImmediate(resolve));
    };
    try {
      app.stdin.write("aj");
      await wait(10);
      expect(app.lastFrame()).toContain("› aj\n");
      await wait(990); // 1 s since the first j: within, as Claude Code counts it (vim.ts, REMAP_MS)
      app.stdin.write("j");
      await wait(10);
      expect(app.lastFrame()).toContain("› a\n");
      expect(app.lastFrame()).toContain("-- NORMAL --");
    } finally {
      vi.useRealTimers();
    }
  });

  // Code review of Task 21: a key App handles itself ends a remap pair's wait (app/keyRouting.ts, dropRemap).
  it("types both keys of a vimInsertModeRemaps pair with Ctrl+T between them", async () => {
    const { app } = await watching([], { editorMode: "vim", vimInsertModeRemaps: { jj: "<Esc>" } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const wait = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      await new Promise((resolve) => setImmediate(resolve));
    };
    try {
      app.stdin.write("j");
      await wait(10);
      app.stdin.write("\u{14}"); // Ctrl+T
      await wait(10);
      app.stdin.write("j");
      await wait(10);
      expect(app.lastFrame()).toContain("› jj\n");
      expect(app.lastFrame()).toContain("-- INSERT --");
    } finally {
      vi.useRealTimers();
    }
  });
});

// Release 7 plan, Task 21: in copy mode, leaving stops the box, and once Docker reports it gone the review opens in the
// App's place, with the App's own keys off; the review's end lines are handed back to print once Ink has ended. The copy
// is made by hand, as tests/tui/review.test.tsx makes it, in a data folder of the test's own, with one change the box
// made; the box is a stand-in.
describe("App's leave() in copy mode", () => {
  function copyWorld() {
    const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "tachi-leave-")));
    onTestFinished(() => removeTree(dir));
    const root = path.join(dir, "project");
    const folder = path.join(dir, "data", "copies", "s1");
    for (const f of [root, path.join(folder, "base"), path.join(folder, "work")]) mkdirSync(f, { recursive: true });
    for (const where of [root, path.join(folder, "base")]) writeFileSync(path.join(where, "a.txt"), "made-up text\n");
    writeFileSync(path.join(folder, "work", "a.txt"), "the box's text\n");
    const st = statSync(path.join(folder, "work", "a.txt"));
    const sha256 = createHash("sha256").update("made-up text\n").digest("hex");
    const manifest: Manifest = { session: "s1", pid: process.pid, root, at: new Date().toISOString(), entries: Object.create(null), leftOut: [] };
    manifest.entries["a.txt"] = { type: "file", sha256, exec: false, size: st.size, mtimeMs: st.mtimeMs };
    writeFileSync(path.join(folder, "manifest.json"), JSON.stringify(manifest));
    const said: string[] = [];
    const ended: string[][] = [];
    let release!: (gone: boolean) => void;
    const copy: NonNullable<AppProps["copy"]> = {
      copy: { session: "s1", folder, manifest },
      stop: () => {
        said.push("stop");
        return new Promise((resolve) => (release = resolve));
      },
      protection: async () => {
        said.push("protection");
        return { hooks: [], files: [] };
      },
      ended: (lines) => ended.push(lines),
    };
    return { folder, copy, said, ended, gone: (yes: boolean) => release(yes) };
  }

  it("opens the review at /exit once the box is gone, where keys never reach the prompt and Ctrl-C does only the review's", async () => {
    const w = copyWorld();
    const lead = new FakeProvider("a", []);
    const { app } = await mount([], { lead, copy: w.copy });
    await type(app, "/exit");
    expect(w.said).toEqual(["stop"]);
    await until(app, "Stopping the box...");
    await press(app, "x");
    expect(app.lastFrame()).not.toContain("› x");
    w.gone(true);
    await until(app, "Review the copy's changes: 1 file.");
    expect(w.said).toEqual(["stop", "protection"]);
    // Typed text and Enter go to the review, whose Enter opens the diff; nothing is sent to the lead.
    await press(app, "h", "i", "\r");
    await until(app, "changed a.txt");
    expect(lead.seen).toEqual([]);
    // Ctrl-C closes the diff only, and then leaves the copy for later; the App's own Ctrl-C, which counts toward exiting,
    // never acts.
    await press(app, "\u0003");
    await until(app, "Review the copy's changes: 1 file.");
    expect(app.lastFrame()).not.toContain("Press Ctrl-C again to exit");
    expect(w.ended).toEqual([]);
    await press(app, "\u0003");
    await waitFor(() => w.ended.length === 1);
    expect(w.ended).toEqual([["The copy is kept; tachi review s1 opens it again."]]);
    expect(existsSync(path.join(w.folder, "manifest.json"))).toBe(true);
    expect(existsSync(`${w.folder}.lock`)).toBe(false); // the lock beside the copy's folder is let go
    expect(lead.seen).toEqual([]);
  });

  it("opens the review on Ctrl-D twice too, and exits once it ends", async () => {
    const w = copyWorld();
    const { app } = await mount([], { copy: w.copy });
    await press(app, "\u0004", "\u0004");
    w.gone(true);
    await until(app, "Review the copy's changes: 1 file.");
    await press(app, "l");
    await waitFor(() => w.ended.length === 1);
    await expectExited(app);
  });

  it("keeps the copy unreviewed when Docker still lists the box, and says so", async () => {
    const w = copyWorld();
    const { app } = await mount([], { copy: w.copy });
    await type(app, "/exit");
    w.gone(false);
    await waitFor(() => w.ended.length === 1);
    expect(w.ended[0]).toEqual([
      "The box could not be removed, so the copy was not reviewed.",
      "The copy is kept; tachi review s1 opens it again.",
    ]);
    expect(w.said).toEqual(["stop"]);
    await expectExited(app);
    expect(existsSync(path.join(w.folder, "manifest.json"))).toBe(true);
  });

  // Task 21's review: without git's settings, a hooks folder they name would not be marked protected, so a file in it
  // could be applied unseen. The review does not open; the copy is kept, and the lines say why.
  it("keeps the copy unreviewed when git's settings cannot be read on the host, and says so", async () => {
    const w = copyWorld();
    w.copy.protection = async () => {
      w.said.push("protection");
      throw new Error("git was ended by SIGKILL\u001b[8m");
    };
    const { app } = await mount([], { copy: w.copy });
    await type(app, "/exit");
    w.gone(true);
    await waitFor(() => w.ended.length === 1);
    expect(w.ended[0]).toEqual([
      "The review did not open: git's settings could not be read (git was ended by SIGKILL\\u001b[8m), so the hooks folders they name could not be protected.",
      "The copy is kept; tachi review s1 opens it again.",
    ]);
    expect(app.lastFrame()).not.toContain("Review the copy's changes");
    expect(w.said).toEqual(["stop", "protection"]);
    await expectExited(app);
    expect(existsSync(path.join(w.folder, "manifest.json"))).toBe(true);
    expect(existsSync(`${w.folder}.lock`)).toBe(false);
  });

  // Choice 121 (the user's): with nothing to review there is no review; the copy is removed, still under the lock and
  // once the box is gone. The box's change is taken back here, so work/ is as the snapshot left it; with `ignored`, the
  // snapshot holds a .gitignore and the box made a file in a path it ignores.
  function unchanged(w: ReturnType<typeof copyWorld>, ignored = false) {
    writeFileSync(path.join(w.folder, "work", "a.txt"), "made-up text\n");
    if (!ignored) return;
    for (const where of ["base", "work"]) writeFileSync(path.join(w.folder, where, ".gitignore"), "*.log\n");
    const st = statSync(path.join(w.folder, "work", ".gitignore"));
    const sha256 = createHash("sha256").update("*.log\n").digest("hex");
    w.copy.copy.manifest.entries[".gitignore"] = { type: "file", sha256, exec: false, size: st.size, mtimeMs: st.mtimeMs };
    writeFileSync(path.join(w.folder, "work", "made.log"), "made-up log\n");
  }
  const reviewDrawn = (app: ReturnType<typeof render>) => app.frames.some((f) => f.includes("Review the copy's changes"));

  it("skips the review and removes the copy when nothing changed, saying so", async () => {
    const w = copyWorld();
    unchanged(w);
    const { app } = await mount([], { copy: w.copy });
    await type(app, "/exit");
    w.gone(true);
    await waitFor(() => w.ended.length === 1);
    expect(w.ended[0]).toEqual(["Nothing changed in the copy, so it was removed."]);
    expect(w.said).toEqual(["stop"]); // git's settings, which only a review needs, are never read
    expect(reviewDrawn(app)).toBe(false);
    expect(app.frames.some((f) => f.includes("Removing the copy (1 file)..."))).toBe(true);
    await expectExited(app);
    expect(existsSync(w.folder)).toBe(false);
    expect(existsSync(`${w.folder}.lock`)).toBe(false);
  });

  it("skips the review and removes the copy when its only changes are in paths git ignores, counting them", async () => {
    const w = copyWorld();
    unchanged(w, true);
    const { app } = await mount([], { copy: w.copy });
    await type(app, "/exit");
    w.gone(true);
    await waitFor(() => w.ended.length === 1);
    expect(w.ended[0]).toEqual(["Nothing to review (1 change only in paths git ignores, never applied), so the copy was removed."]);
    expect(reviewDrawn(app)).toBe(false);
    await expectExited(app);
    expect(existsSync(w.folder)).toBe(false);
  });

  it("says when the copy with nothing to review could not be removed", async () => {
    const w = copyWorld();
    unchanged(w);
    w.copy.remove = async () => {
      throw new Error("made-up failure");
    };
    const { app } = await mount([], { copy: w.copy });
    await type(app, "/exit");
    w.gone(true);
    await waitFor(() => w.ended.length === 1);
    expect(w.ended[0]).toEqual([`The copy could not be removed (made-up failure); delete ${w.folder} by hand.`]);
    expect(reviewDrawn(app)).toBe(false);
    await expectExited(app);
    expect(existsSync(path.join(w.folder, "manifest.json"))).toBe(true);
  });

  it("opens the review when the box left only something never applied, for the user to see it", async () => {
    const w = copyWorld();
    unchanged(w);
    mkdirSync(path.join(w.folder, "work", ".tachikoma"));
    const { app } = await mount([], { copy: w.copy });
    await type(app, "/exit");
    w.gone(true);
    await until(app, "Left out, never applied: .tachikoma");
    expect(existsSync(path.join(w.folder, "manifest.json"))).toBe(true);
  });

  it("opens the review as before when the copy's changes cannot be read", async () => {
    const w = copyWorld();
    renameSync(path.join(w.folder, "work"), path.join(w.folder, "elsewhere"));
    const { app } = await mount([], { copy: w.copy });
    await type(app, "/exit");
    w.gone(true);
    await until(app, "The copy's changes could not be read:");
    expect(existsSync(path.join(w.folder, "manifest.json"))).toBe(true);
  });

  // The quality review: a failure while leaving is said escaped, with where the copy is.
  it("says what failed while leaving, escaped, and that the copy is kept", async () => {
    const w = copyWorld();
    w.copy.stop = async () => {
      throw new Error("docker went away\u001b[8m");
    };
    const { app } = await mount([], { copy: w.copy });
    await type(app, "/exit");
    await waitFor(() => w.ended.length === 1);
    expect(w.ended[0]).toEqual(["docker went away\\u001b[8m", "The copy is kept; tachi review s1 opens it again."]);
    await expectExited(app);
  });

  // The App and the review read one table of keys (Bindings), which holds a chord's first strokes: were the App's own
  // keys or mouse on during the review, its lookups would take or drop the review's chord. Here a keys-file chord of the
  // Review context, Ctrl+X then z, leaves the copy for later, a wheel notch coming between in full screen.
  it("leaves the review's chords to it, the App's keys and mouse taking no part", async () => {
    for (const full of [false, true]) {
      const w = copyWorld();
      const bindings = new Bindings(tableOf({ ...DEFAULTS, Review: { ...DEFAULTS.Review, "ctrl+x z": "review:later" } }));
      const { app, mouse } = await mount([], { copy: w.copy, bindings, full });
      await type(app, "/exit");
      w.gone(true);
      await until(app, "Review the copy's changes: 1 file.");
      await press(app, "\u0018"); // Ctrl+X
      if (full) await wheel(mouse, "down");
      await press(app, "z");
      await waitFor(() => w.ended.length === 1);
      expect(w.ended[0], full ? "full screen" : "classic").toEqual(["The copy is kept; tachi review s1 opens it again."]);
    }
  });

  // A signal exit or a crash ends Ink without leave() (cli.tsx, restoreOnExit, unmounts it): the box is removed by the
  // executor's exit handler, and the copy stays, unreviewed, for `tachi review` (design: "Nothing is thrown away until the
  // user has reviewed it").
  it("keeps the copy, unreviewed, when Ink ends without leaving, as on a signal or a crash", async () => {
    const w = copyWorld();
    const { app } = await mount([], { copy: w.copy });
    app.unmount();
    await tick();
    expect(w.said).toEqual([]);
    expect(w.ended).toEqual([]);
    expect(existsSync(path.join(w.folder, "manifest.json"))).toBe(true);
    expect(existsSync(path.join(w.folder, "work", "a.txt"))).toBe(true);
  });
});

// Release 8a plan, Task 7: /clear, /resume, /branch and /rename switch and name the window's saved sessions. Every case
// saves into one sessions folder, made private once, as privateDir starts PowerShell for each new folder on Windows
// (about 1.5 s), so a case's /resume list holds earlier cases' sessions too, newest first: each picks the one it saved
// last, the newest.
describe("App's sessions", () => {
  const top = mkdtempSync(path.join(tmpdir(), "tachi-sessions-"));
  const dir = path.join(top, "data", "sessions");
  beforeAll(() => privateDir(dir));
  afterAll(() => removeTree(top));
  const saved = (turns: ConstructorParameters<typeof FakeProvider>[1], opts: Parameters<typeof mount>[1] = {}) =>
    mount(turns, { ...opts, save: true, sessions: dir });
  const bg = (id: string, task: string) => callTool(id, "delegate", { description: task, task, background: true });
  const note = (text: string) => ({ type: "text", text, from: "tasks" });
  const typed = (text: string): Message => ({ role: "user", parts: [{ type: "text", text }] });
  const fileOf = (id: string) => sessionPaths(dir, id).file;
  const rowOf = (id: string) => listSessions(dir, { print: false }).find((r) => r.id === id);
  // A line may wrap at the screen's width, so it is looked for without the frame's blanks and line breaks.
  const bare = (s: string) => s.replace(/\s/g, "");
  // A red line that may wrap: its start in red, and its words whole.
  const saidInRed = (app: ReturnType<typeof render>, line: string) => {
    expect(app.lastFrame()).toContain(`\u001b[31m${line.slice(0, 10)}`);
    expect(bare(stripVTControlCharacters(app.lastFrame()!))).toContain(bare(line));
  };
  // Whether another window could take the session's lock now, letting it go again at once.
  const free = (id: string) => {
    const lock = openSession(dir, id);
    lock?.release();
    return lock !== null;
  };
  // A session saved by an earlier window, which then closed, letting it go.
  const earlier = async (prompt: string, close = true) => {
    const first = await saved([reply("noted")]);
    await type(first.app, prompt);
    await until(first.app, "noted");
    if (close) first.app.unmount();
    return first;
  };

  it("starts a new session on /clear, with the instruction files read again, the last one kept and let go", async () => {
    const lead = new Held("fake:a");
    const { app, session } = await saved([], { lead });
    await type(app, "first");
    lead.answer("one");
    await until(app, "one");
    const old = session.id;
    const before = readFileSync(fileOf(old), "utf8");
    await type(app, "/clear");
    await until(app, "Started a new session; the last one is kept (tachi --resume lists it).");
    expect(session.id).not.toBe(old);
    expect(free(old)).toBe(true); // carry-over note b
    expect(free(session.id)).toBe(false);
    await type(app, "second");
    await waitFor(() => lead.asked.length === 2);
    expect(lead.asked[1]!.messages).toEqual([typed("second")]);
    expect(lead.asked[1]!.system).toBe("t, read again");
    lead.answer("two");
    await until(app, "two");
    expect(readFileSync(fileOf(old), "utf8")).toBe(before);
    expect(rowOf(session.id)?.firstPrompt).toBe("second");
  });

  // Choice 15.
  it("clears the to-do list, the tool line and the gauge's context on a switch", async () => {
    const { app, bus } = await saved([callTool("c1", "find_files", { pattern: "*.none" }), reply("looked")], { segments: ["context", "tools"] });
    await type(app, "go");
    await until(app, "looked");
    bus.emit("todo", [{ text: "write the fix", status: "pending" }]);
    await tick();
    expect(app.lastFrame()).toContain("☐ write the fix");
    expect(app.lastFrame()).toContain("ctx 15");
    expect(app.lastFrame()).toContain("find_files ×1");
    await type(app, "/clear");
    await until(app, "Started a new session");
    expect(app.lastFrame()).not.toContain("☐ write the fix");
    expect(app.lastFrame()).toContain("ctx 0");
    expect(app.lastFrame()).not.toContain("find_files ×1");
  });

  it("lists the other saved sessions on /resume, and a pick draws its conversation, then its line, and carries it on", async () => {
    const first = await earlier("remember apple");
    const lead = new FakeProvider("a", [reply("an apple")]); // the saved session's lead, so the window keeps it
    const { app, session } = await saved([], { lead });
    const own = session.id;
    await type(app, "/resume");
    await until(app, "Saved sessions in this folder, newest first:");
    expect(app.lastFrame()).toMatch(/Saved sessions in this folder, newest first:\nremember apple +<1m ago +fake:a +[\d.]+k? bytes\n/);
    expect(app.lastFrame()).toContain("↑↓ move · Enter opens · Esc closes");
    await press(app, "\r");
    await until(app, "Resumed: remember apple.");
    expect(app.lastFrame()).toMatch(/> remember apple\nnoted\nResumed: remember apple\.\n/);
    expect(session.id).toBe(first.session.id);
    expect(free(own)).toBe(true);
    await type(app, "which fruit?");
    await until(app, "an apple");
    expect(lead.seen[0]).toEqual([typed("remember apple"), { role: "assistant", parts: [{ type: "text", text: "noted" }] }, typed("which fruit?")]);
  });

  // User, 2026-11-06: "The session's saved lead", switched as /lead switches it, so the status line follows.
  it("switches to a resumed session's saved lead, as /lead does", async () => {
    const first = await earlier("lead a's session");
    const saidAgain = new FakeProvider("a", [reply("a again")]);
    const made: string[] = [];
    const { app, session } = await saved([], { lead: new FakeProvider("b", []), newLead: saidAgain, made });
    await type(app, "/resume");
    await until(app, "lead a's session");
    await press(app, "\r");
    await until(app, "lead is now fake:a");
    expect(made).toEqual(["fake:a"]);
    expect(app.lastFrame()).toMatch(/Resumed: lead a's session\.\nlead is now fake:a\n/);
    expect(app.lastFrame()).toMatch(/lead fake:a/); // the status line
    expect(session.lead).toBe(saidAgain);
    await type(app, "go on");
    await until(app, "a again");
    expect(rowOf(first.session.id)?.lead).toBe("fake:a");
  });

  it("keeps the window's lead when a resumed session's saved lead cannot be made, saying so", async () => {
    const first = await earlier("lead a's other session");
    const lead = new FakeProvider("b", [reply("b answers")]);
    const { app, session } = await saved([], { lead, leadFails: "no key for fake" });
    await type(app, "/resume");
    await until(app, "lead a's other session");
    await press(app, "\r");
    await until(app, "Resumed: lead a's other session.");
    expect(bare(app.lastFrame()!)).toContain(bare("The session's lead, fake:a, is not set up (no key for fake); fake:b leads instead."));
    expect(session.lead).toBe(lead);
    await type(app, "go on");
    await until(app, "b answers");
    expect(rowOf(first.session.id)?.lead).toBe("fake:b"); // written into it, as tachi -r writes it
  });

  // Release 8a plan, Task 7: the error log follows the open session, as cli.tsx attaches it.
  it("logs an error after /clear under the new session's id", async () => {
    const errors = path.join(path.dirname(dir), "errors", "log.jsonl"); // two levels inside the folder made for the sessions
    const { app, session, bus } = await saved([new Error("provider down")]);
    attachErrorLog(bus, errors, () => session.id);
    const old = session.id;
    await type(app, "/clear");
    await until(app, "Started a new session");
    await type(app, "hi");
    await until(app, "provider down");
    const rows = readFileSync(errors, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toMatchObject([{ session: session.id, message: "provider down" }]);
    expect(session.id).not.toBe(old);
  });

  // Release 8a plan, Task 7: /clear says its line once the new conversation is loaded, so a saving failure comes first.
  it("says /clear's line after the new session's saving failure", async () => {
    const own = await mkdtemp(path.join(tmpdir(), "tachi-"));
    onTestFinished(() => removeTree(own));
    writeFileSync(path.join(own, "data"), "not a folder"); // a file where the sessions folder's parent should be
    const { app } = await mount([], { sessions: path.join(own, "data", "sessions") });
    await type(app, "/clear");
    await until(app, "Started a new session");
    const frame = app.lastFrame()!;
    expect(frame.indexOf("✗ Saving this session stopped:")).toBeGreaterThan(-1);
    expect(frame.indexOf("✗ Saving this session stopped:")).toBeLessThan(frame.indexOf("Started a new session"));
  });

  it("opens a copy on /resume of a session open in another window, saying so, and leaves that one's file as it was", async () => {
    const first = await earlier("remember pear", false);
    const before = readFileSync(fileOf(first.session.id), "utf8");
    const { app, session } = await saved([reply("a pear")]);
    await type(app, "/resume");
    await until(app, "remember pear");
    await press(app, "\r");
    await until(app, "Resumed: remember pear.");
    expect(app.lastFrame()).toMatch(/noted\nOpened a copy: that session is open in another window\.\nResumed: remember pear\.\n/);
    expect(session.id).not.toBe(first.session.id);
    await type(app, "which fruit?");
    await until(app, "a pear");
    expect(session.messages).toHaveLength(4);
    expect(readFileSync(fileOf(first.session.id), "utf8")).toBe(before);
  });

  // A prompt read with /resume in one read of the terminal starts its turn under the list: a pick then cannot load, so it
  // leaves the turn's state as it was, and lets the picked session go.
  it("leaves a turn started under /resume's list alone when a pick cannot load, and lets the picked session go", async () => {
    const first = await earlier("picked mid-turn");
    const lead = new Held("fake:a");
    const { app, session, bus } = await saved([], { lead });
    const own = session.id;
    app.stdin.write("/resume\rhi\r");
    await until(app, "picked mid-turn");
    await waitFor(() => lead.asked.length === 1);
    bus.emit("todo", [{ text: "keep this", status: "pending" }]);
    await press(app, "\r");
    await until(app, "A turn is already running");
    expect(app.lastFrame()).toContain("☐ keep this");
    expect(session.id).toBe(own);
    expect(free(first.session.id)).toBe(true);
    lead.answer("done");
    await until(app, "done");
  });

  // PR #10's review: a letter bound in Select moves and opens in /resume's list, as in tachi -r's; only the model list's
  // filter takes typed letters.
  it("takes letters bound in Select in /resume's list", async () => {
    await earlier("the older one");
    await earlier("the newer one");
    const bindings = new Bindings(tableOf({ ...DEFAULTS, Select: { ...DEFAULTS.Select, j: "select:next", o: "select:accept" } }));
    const { app } = await saved([], { bindings });
    await type(app, "/resume");
    await until(app, "the older one");
    await press(app, "j", "o");
    await until(app, "Resumed: the older one.");
  });

  it("closes /resume's list on Esc, the window staying in its session", async () => {
    await earlier("a session to leave");
    const { app, session } = await saved([]);
    const own = session.id;
    await type(app, "/resume");
    await until(app, "a session to leave");
    await press(app, "\u001b");
    await gone(app, "Saved sessions in this folder");
    expect(session.id).toBe(own);
    expect(free(own)).toBe(false);
  });

  it("says so on /resume when no other session is saved", async () => {
    const { app } = await mount([]); // a folder of its own, with nothing saved in it
    await type(app, "/resume");
    await until(app, "No other saved sessions in this folder.");
  });

  it("says in red that a picked session could not be read, and stays in this one", async () => {
    await inColour(async () => {
      const first = await earlier("soon gone");
      const { app, session } = await saved([]);
      const own = session.id;
      await type(app, "/resume");
      await until(app, "soon gone");
      unlinkSync(fileOf(first.session.id)); // the earlier window's transcript, gone before it is picked
      await press(app, "\r");
      await until(app, "could not be read as a session");
      saidInRed(app, `${fileOf(first.session.id)} could not be read as a session (ENOENT`);
      expect(session.id).toBe(own);
      expect(free(own)).toBe(false);
    });
  });

  // Carry-over note a: a resumed session's own lost subagents reach its next request, and are then marked reported.
  it("hands the model a resumed session's lost subagents with its next request, then marks them reported", async () => {
    const first = await saved([reply("noted")]);
    await type(first.app, "start a search");
    await until(first.app, "noted");
    first.session.transcript!.write({ t: "subagent", id: "t1", description: "find x", file: "t1.jsonl" }); // t1 ran as the window closed
    first.app.unmount();
    const lead = new FakeProvider("a", [reply("ok")]);
    const { app } = await saved([], { lead });
    await type(app, "/resume");
    await until(app, "start a search");
    await press(app, "\r");
    await until(app, "Resumed: start a search.");
    await type(app, "go on");
    await until(app, "ok");
    const lost = "Subagent t1 (find x) had not finished when the session ended; its answer was lost.";
    expect(lead.seen[0]!.at(-1)!.parts).toEqual([{ type: "text", text: "go on" }, note(lost)]);
    expect(readFileSync(path.join(sessionPaths(dir, first.session.id).subagents, "t1.jsonl"), "utf8")).toContain('"state":"lost"');
  });

  it("drops a resumed session's lost subagents unsaid on /clear, so the new conversation never hears of them", async () => {
    const first = await saved([reply("noted")]);
    await type(first.app, "search again");
    await until(first.app, "noted");
    first.session.transcript!.write({ t: "subagent", id: "t1", description: "find y", file: "t1.jsonl" });
    first.app.unmount();
    const lead = new FakeProvider("a", [reply("fresh")]);
    const { app } = await saved([], { lead });
    await type(app, "/resume");
    await until(app, "search again");
    await press(app, "\r");
    await until(app, "Resumed: search again.");
    await type(app, "/clear");
    await until(app, "Started a new session");
    await type(app, "hello");
    await until(app, "fresh");
    expect(lead.seen[0]).toEqual([typed("hello")]);
    expect(existsSync(path.join(sessionPaths(dir, first.session.id).subagents, "t1.jsonl"))).toBe(false); // never reported, so still lost
  });

  // Carry-over note c: the window's pictures and the resumed session's saved ones never share a number.
  it("gives a picture numbered before /resume a new number, as the resumed session has saved one under its own", async () => {
    const PICTURE = process.platform === "win32" ? "\u001bv" : "\u0016"; // chat:imagePaste: Alt+V on Windows, else Ctrl+V
    const CTRL_S = "\u0013";
    const OLD = { mediaType: "image/png" as const, data: Buffer.from([1, 2, 3]) }; // stand-ins, never read from disk
    const NEW = { mediaType: "image/png" as const, data: Buffer.from([4, 5, 6]) };
    const first = await saved([reply("seen")]);
    await press(first.app, "look ", PICTURE);
    first.pictures.set(1, OLD);
    await press(first.app, "\r");
    await until(first.app, "seen");
    first.app.unmount();
    const { app, session, pictures } = await saved([reply("both seen")]);
    await press(app, "and ", PICTURE, CTRL_S); // this window's picture #1, stashed
    pictures.set(1, NEW);
    await type(app, "/resume");
    await until(app, "look [Image #1]");
    await press(app, "\r");
    await until(app, "Resumed: look [Image #1].");
    await press(app, CTRL_S, "\r");
    await until(app, "both seen");
    expect(session.messages[0]!.parts).toEqual([{ type: "text", text: "look " }, { type: "image", id: 1, ...OLD }]);
    expect(session.messages[2]!.parts).toEqual([{ type: "text", text: "and " }, { type: "image", id: 2, ...NEW }]);
    const folder = sessionPaths(dir, first.session.id).pictures;
    expect(readFileSync(path.join(folder, "1.png"))).toEqual(OLD.data);
    expect(readFileSync(path.join(folder, "2.png"))).toEqual(NEW.data);
  });

  it("branches on /branch <name>: the copy is named so, the next turn writes to it, and the original stays as it was", async () => {
    const { app, session } = await saved([reply("one"), reply("two")]);
    await type(app, "first");
    await until(app, "one");
    const original = session.id;
    const before = readFileSync(fileOf(original), "utf8");
    await type(app, "/branch side road");
    await until(app, "Branched:");
    // The same conversation, so it is not drawn again (release 8a final review, user, 2026-11-07: "Drop the reprint").
    expect(bare(app.lastFrame()!)).toContain(bare(`> first\none\nBranched: this window is now side road; the original is kept as ${original}.`));
    expect(app.lastFrame()!.split("> first")).toHaveLength(2);
    expect(session.id).not.toBe(original);
    expect(free(original)).toBe(true);
    await type(app, "second");
    await until(app, "two");
    expect(readFileSync(fileOf(original), "utf8")).toBe(before);
    expect(rowOf(session.id)).toMatchObject({ name: "side road", firstPrompt: "first" });
    expect(readFileSync(fileOf(session.id), "utf8")).toContain('"text":"second"');
  });

  // Release 8a final review (user, 2026-11-07: "Clear them"): /clear and /resume share the switch that lets them go.
  it("lets the last conversation's finished subagents go from /tasks on /clear, and keeps them on /branch", async () => {
    const lead = new FakeProvider("a", [callTool("c1", "delegate", { description: "find x", task: "find x" }), reply("done")]);
    const { app, tasks } = await saved([], { lead, worker: new FakeProvider("w", [reply("found")]) });
    await type(app, "go");
    await until(app, "done");
    await type(app, "/branch");
    await until(app, "Branched:");
    expect(tasks.all.map((t) => t.id)).toEqual(["t1"]);
    await type(app, "/clear");
    await until(app, "Started a new session");
    expect(tasks.all).toEqual([]);
    await type(app, "/tasks");
    await until(app, "No subagents yet.");
  });

  it("lets the last conversation's finished subagents go from /tasks on /resume", async () => {
    await earlier("an earlier one");
    const lead = new FakeProvider("a", [callTool("c1", "delegate", { description: "find y", task: "find y" }), reply("done")]);
    const { app, tasks } = await saved([], { lead, worker: new FakeProvider("w", [reply("found")]) });
    await type(app, "go");
    await until(app, "done");
    expect(tasks.all.map((t) => t.id)).toEqual(["t1"]);
    await type(app, "/resume");
    await until(app, "an earlier one");
    await press(app, "\r");
    await until(app, "Resumed: an earlier one.");
    expect(tasks.all).toEqual([]);
  });

  it("names a branch after the first prompt when /branch is given no name", async () => {
    const { app, session } = await saved([reply("one")]);
    await type(app, "plan the trip");
    await until(app, "one");
    const original = session.id;
    await type(app, "/branch");
    await until(app, "Branched:");
    expect(bare(app.lastFrame()!)).toContain(bare(`Branched: this window is now plan the trip; the original is kept as ${original}.`));
    expect(rowOf(session.id)?.name).toBe("plan the trip");
  });

  it("has nothing to branch before the first prompt", async () => {
    const { app, session } = await saved([]);
    const own = session.id;
    await type(app, "/branch");
    await until(app, "Nothing to branch yet: this session has no prompt.");
    expect(session.id).toBe(own);
  });

  it("says in red that this session could not be copied for /branch, and stays in it", async () => {
    await inColour(async () => {
      const { app, session } = await saved([reply("one")]);
      await type(app, "first");
      await until(app, "one");
      const own = session.id;
      unlinkSync(fileOf(own)); // this window's own transcript, gone
      await type(app, "/branch");
      await until(app, "could not be copied");
      saidInRed(app, `${fileOf(own)} could not be copied (ENOENT`);
      expect(session.id).toBe(own);
    });
  });

  it("names the session on /rename, as the list shows it, and says how it is used when given no name", async () => {
    await inColour(async () => {
      const { app, session } = await saved([reply("one")]);
      await type(app, "hello");
      await until(app, "one");
      await type(app, "/rename");
      await until(app, "\u001b[31mUsage: /rename <name>");
      await type(app, "/rename my work");
      await until(app, "Session named my work.");
      expect(rowOf(session.id)?.name).toBe("my work");
    });
  });

  // A name is the first line only, so none holds a line break (Ctrl+J, chat:newline, puts one in the prompt).
  it("names a session or a branch from the first line of what follows /rename or /branch", async () => {
    const { app, session } = await saved([reply("one")]);
    await type(app, "hello");
    await until(app, "one");
    await press(app, "/rename two words", "\n", "and more", "\r");
    await until(app, "Session named two words.");
    expect(rowOf(session.id)?.name).toBe("two words");
    await press(app, "/branch a side", "\n", "and more", "\r");
    await until(app, "Branched: this window is now a side;");
    expect(rowOf(session.id)?.name).toBe("a side");
  });

  it.each(["/clear", "/resume", "/branch"])("refuses %s in red while a subagent runs, naming it", async (command) => {
    await inColour(async () => {
      const { app, session } = await saved([bg("c1", "find x"), reply("started it")], { worker: new Held("fake:w") });
      await type(app, "go");
      await until(app, "started it");
      const own = session.id;
      await type(app, command);
      await until(app, `\u001b[31m${command} waits until no subagent is running: t1 still running. /tasks stop stops them.`);
      expect(session.id).toBe(own);
    });
  });

  it.each([
    ["/clear", "Started a new session"],
    ["/resume", "Saved sessions in this folder, newest first:"],
    ["/branch", "Branched: this window is now go on;"],
  ])("runs %s queued during a turn once the turn ends", async (command, line) => {
    await earlier("one to resume");
    const lead = new Held("fake:a");
    const { app } = await saved([], { lead });
    await type(app, "go on");
    await waitFor(() => lead.asked.length === 1);
    await type(app, command);
    expect(app.lastFrame()).not.toContain(line);
    lead.answer("done");
    await until(app, line);
  });

  it("leaves a stopped subagent's note with the last session: /clear's first request holds none of it", async () => {
    const lead = new FakeProvider("a", [bg("c1", "find x"), reply("started it"), reply("fresh")]);
    const { app, tasks } = await saved([], { lead, worker: new Held("fake:w") });
    await type(app, "go");
    await until(app, "started it");
    await type(app, "/tasks stop");
    await until(app, "Stopped every subagent.");
    await waitFor(() => tasks.all[0]!.state === "stopped");
    await type(app, "/clear");
    await until(app, "Started a new session");
    await type(app, "hello");
    await until(app, "fresh");
    expect(lead.seen[2]).toEqual([typed("hello")]);
  });

  it("gives the old conversation a subagent's answer that came while /clear waited in the queue, and the new one none", async () => {
    const worker = new Held("fake:w");
    const lead = new Held("fake:a");
    const { app } = await saved([], { lead, worker });
    await type(app, "go");
    lead.answer(bg("c1", "find x"));
    await waitFor(() => lead.asked.length === 2 && worker.asked.length === 1);
    await type(app, "/clear");
    worker.answer("found");
    await tick();
    lead.answer("started");
    await waitFor(() => lead.asked.length === 3);
    expect(lead.asked[2]!.messages.at(-1)!.parts).toEqual([note("Background task t1 (find x) finished:\nfound")]);
    lead.answer("read it");
    await until(app, "Started a new session");
    await type(app, "new");
    await waitFor(() => lead.asked.length === 4);
    expect(lead.asked[3]!.messages).toEqual([typed("new")]);
  });
});

// Release 8a plan, Task 8: /export writes the conversation as text to a file, from the project folder, never over one
// that exists, or alone copies it through the clipboard's stand-in.
describe("App's /export", () => {
  const bare = (s: string) => s.replace(/\s/g, "");
  // A line that may wrap at the screen's width: its start in red when it is red, and its words whole.
  const said = (app: ReturnType<typeof render>, line: string, red = false) => {
    if (red) expect(app.lastFrame()).toContain(`\u001b[31m${line.slice(0, 10)}`);
    expect(bare(stripVTControlCharacters(app.lastFrame()!))).toContain(bare(line));
  };
  const talk = async (opts: Parameters<typeof mount>[1] = {}) => {
    const m = await mount([callTool("c1", "find_files", { pattern: "*.none" }), reply("looked")], opts);
    await type(m.app, "go");
    await until(m.app, "looked");
    return m;
  };

  it("writes the conversation to a file in the project folder on /export <file>, with its call and result", async () => {
    const { app, ctx, session } = await talk();
    await type(app, "/export talk.txt");
    await until(app, "Exported to");
    const file = path.join(ctx.root, "talk.txt");
    said(app, `Exported to ${file}.`);
    const text = readFileSync(file, "utf8");
    expect(text).toBe(exportText(session.messages, "fake:a"));
    expect(text).toMatch(/^You:\ngo\n\nTachikoma \(fake:a\):\n● find_files \{\n {2}"pattern": "\*\.none"\n\}\n {2}⎿ .+\n\n/);
    expect(text.endsWith("\n\nTachikoma (fake:a):\nlooked\n")).toBe(true);
  });

  it("refuses a file that already exists, in red, and leaves it as it was", async () => {
    await inColour(async () => {
      const { app, ctx } = await talk();
      const file = path.join(ctx.root, "talk.txt");
      writeFileSync(file, "mine");
      await type(app, "/export talk.txt");
      await until(app, "already exists");
      said(app, `${file} already exists; nothing was written.`, true);
      expect(readFileSync(file, "utf8")).toBe("mine");
    });
  });

  // A file where a folder should be makes the write fail. The line was approved by the user on 2026-11-06 (constants.ts,
  // EXPORT_WORDS).
  // The reason is Node's code and words, without the path they end with, so the file is named once (quality review). Windows
  // reports a path through a file as missing.
  it("says in red when the file cannot be written", async () => {
    await inColour(async () => {
      const { app, ctx } = await talk();
      writeFileSync(path.join(ctx.root, "notes"), "a file, not a folder");
      await type(app, "/export notes/talk.txt");
      await until(app, "could not be written");
      const why = process.platform === "win32" ? "ENOENT: no such file or directory" : "ENOTDIR: not a directory";
      said(app, `${path.join(ctx.root, "notes", "talk.txt")} could not be written (${why}).`, true);
      expect(bare(stripVTControlCharacters(app.lastFrame()!))).not.toContain(bare(`open '${path.join(ctx.root, "notes")}`));
    });
  });

  // Quality review: a path in matching quotes, as a dropped one comes; on Windows only ", as an apostrophe is part of a name.
  it("takes a file's name out of the quotes around it", async () => {
    const { app, ctx } = await talk();
    await type(app, '/export "my notes.txt"');
    await until(app, "Exported to");
    said(app, `Exported to ${path.join(ctx.root, "my notes.txt")}.`);
    expect(existsSync(path.join(ctx.root, "my notes.txt"))).toBe(true);
  });

  // Quality review: `wx` follows a link at the name on Windows, a junction to a missing folder making that folder. Any link
  // there counts as a file already there. The junction is this test's own, in the mount's own folder, and is unlinked,
  // never followed. Links in the folders above are a known limit.
  it("refuses a link standing at the file's name, writing nothing where it points", async () => {
    await inColour(async () => {
      const { app, ctx } = await talk();
      const link = path.join(ctx.root, "planted.txt");
      const target = path.join(ctx.root, "elsewhere");
      symlinkSync(target, link, "junction");
      onTestFinished(() => unlinkSync(link));
      await type(app, "/export planted.txt");
      await until(app, "already exists");
      said(app, `${link} already exists; nothing was written.`, true);
      expect(existsSync(target)).toBe(false);
    });
  });

  it("takes the file's name from the first line of what follows /export", async () => {
    const { app, ctx } = await talk();
    await press(app, "/export one.txt", "\n", "and more", "\r");
    await until(app, "Exported to");
    expect(existsSync(path.join(ctx.root, "one.txt"))).toBe(true);
  });

  it("copies the conversation on /export alone through the clipboard, saying how many characters", async () => {
    const ran: string[] = [];
    const { app, copies, session } = await talk({ run: async (text) => void ran.push(text) });
    await type(app, "/export");
    await until(app, "Copied the conversation");
    const text = exportText(session.messages, "fake:a");
    expect(copies).toEqual([text]);
    expect(ran).toEqual([text]);
    said(app, `Copied the conversation (${[...text].length} characters).`);
  });

  // User, 2026-11-06: "Record each reply's lead".
  it("heads each reply with the lead that wrote it, across a /lead switch", async () => {
    const { app, copies } = await mount([reply("from a")], { newLead: new FakeProvider("b", [reply("from b")]) });
    await type(app, "one");
    await until(app, "from a");
    await type(app, "/lead fake:b");
    await until(app, "lead is now fake:b");
    await type(app, "two");
    await until(app, "from b");
    await type(app, "/export");
    await until(app, "Copied the conversation");
    expect(copies).toEqual(["You:\none\n\nTachikoma (fake:a):\nfrom a\n\nYou:\ntwo\n\nTachikoma (fake:b):\nfrom b\n"]);
  });

  // User, 2026-11-06: "Include, headed Subagents:". The answer as the lead got it, in the turn of its own it woke.
  it("puts a background subagent's answer under Subagents:, where it arrived", async () => {
    const bg = callTool("c1", "delegate", { description: "find x", task: "find x", background: true });
    const lead = new FakeProvider("a", [bg, reply("started it"), reply("read it")]);
    const worker = new Held("fake:w");
    const { app, copies } = await mount([], { lead, worker });
    await type(app, "go");
    await until(app, "started it");
    worker.answer("found it");
    await until(app, "read it");
    await type(app, "/export");
    await until(app, "Copied the conversation");
    expect(copies[0]).toContain(
      "Tachikoma (fake:a):\nstarted it\n\nSubagents:\nBackground task t1 (find x) finished:\nfound it\n\nTachikoma (fake:a):\nread it\n",
    );
  });

  it("says when the clipboard tool fails that the terminal alone copied, as a selection's copy says", async () => {
    const { app } = await talk({ run: async () => Promise.reject(new Error("xclip not found")) });
    await type(app, "/export");
    await until(app, "Copied with the terminal only; xclip not found");
  });
});

// Release 8a plan, Task 13: /compact, /autocompact, and the shortened line. A mount with `save`, as shortening needs the
// session saved.
describe("App's /compact and /autocompact", () => {
  const LINE = "Conversation shortened (Ctrl+O shows the summary)";
  const HISTORY = "This conversation was shortened. A summary of everything before this point:\n\n";
  // A line that may wrap at the screen's width.
  const flat = (app: ReturnType<typeof render>) => app.lastFrame()!.replaceAll(/ *\n */g, " ");
  const isSummary = (messages: Message[]) => texts(messages.at(-1)!).at(-1)!.startsWith(INSTRUCTIONS);
  const talked = async (turns: ConstructorParameters<typeof FakeProvider>[1], opts: Parameters<typeof mount>[1] = {}) => {
    const m = await mount([reply("noted"), ...turns], { save: true, ...opts });
    await type(m.app, "hi");
    await until(m.app, "noted");
    return m;
  };

  it("sends a summary request on /compact, shows the line, and Ctrl+O then shows the summary until the next turn", async () => {
    const lead = new FakeProvider("a", [reply("noted"), reply("Compacted."), reply("again")]);
    const { app, session } = await talked([], { lead });
    await type(app, "/compact");
    await until(app, LINE);
    expect(isSummary(lead.seen[1]!)).toBe(true);
    expect(texts(lead.seen[1]!.at(-1)!).at(-1)).toBe(INSTRUCTIONS);
    expect(session.messages.map(texts)).toEqual([[`${HISTORY}Compacted.`]]);
    await press(app, "\u000f");
    expect(app.lastFrame()).toContain(`${LINE}\nThe summary the conversation was shortened to:\nCompacted.\n`);
    await type(app, "more");
    await until(app, "again");
    await press(app, "\u000f");
    expect(app.lastFrame()).toContain("Last turn: 0 tool calls");
  });

  it("opens the summary in the detail view on Ctrl+O in full screen", async () => {
    const { app } = await talked([reply("Compacted.")], { full: true });
    await type(app, "/compact");
    await until(app, LINE);
    await press(app, "\u000f");
    expect(shown(app).slice(0, 2)).toEqual(["The summary the conversation was shortened to:", "Compacted."]);
  });

  it("puts /compact's words in the summary request as its focus", async () => {
    const lead = new FakeProvider("a", [reply("noted"), reply("Compacted.")]);
    const { app } = await talked([], { lead });
    await type(app, "/compact focus on tests");
    await until(app, LINE);
    expect(texts(lead.seen[1]!.at(-1)!).at(-1)).toBe(`${INSTRUCTIONS}\n\nFocus on: focus on tests`);
  });

  it("says there is nothing to shorten on /compact before any message, sending nothing", async () => {
    const lead = new FakeProvider("a", []);
    const { app } = await mount([], { lead, save: true });
    await type(app, "/compact");
    await until(app, "Nothing to shorten yet.");
    expect(lead.seen).toEqual([]);
  });

  it("says a failed /compact in red, the conversation unchanged", async () => {
    await inColour(async () => {
      const { app, session } = await talked([new Error("overloaded")]);
      await type(app, "/compact");
      await waitFor(() => flat(app).includes("✗ The conversation could not be shortened (overloaded); it is unchanged."));
      expect(app.lastFrame()).toContain("\u001b[31m✗ The conversation");
      expect(session.messages).toHaveLength(2);
    });
  });

  it("stops /compact on Ctrl-C with the line, the conversation unchanged, and goes on after", async () => {
    const lead = new Held("fake:a");
    const { app, session } = await mount([], { lead, save: true });
    await type(app, "hi");
    lead.answer("noted");
    await until(app, "noted");
    await type(app, "/compact");
    await waitFor(() => lead.asked.length === 2);
    app.stdin.write("\u0003"); // Ctrl-C
    await waitFor(() => flat(app).includes("✗ The conversation could not be shortened (cancelled by the user); it is unchanged."));
    expect(session.messages).toHaveLength(2);
    await type(app, "and now");
    await waitFor(() => lead.asked.length === 3);
    lead.answer("stale"); // the stopped summary request's, still first in Held's line, answered to no one
    lead.answer("still here");
    await until(app, "still here");
    expect(app.lastFrame()).not.toContain("stale");
  });

  it("reads the gauge's context as 0 after a shortening, until the next request reports", async () => {
    const { app } = await talked([reply("Compacted."), reply("again")], { segments: ["context"] });
    await until(app, "ctx 15");
    await type(app, "/compact");
    await until(app, LINE);
    expect(app.lastFrame()).toContain("ctx 0");
    await type(app, "more");
    await until(app, "ctx 15");
  });

  it("shortens a turn over the /autocompact size first, stops on /autocompact off, and says each", async () => {
    const seen: Message[][] = [];
    const answers = ["one", "two", "S.", "three", "four", "five"];
    // A thousand tokens a character, so each request is estimated at millions of tokens.
    const lead: Provider = {
      id: "fake:a",
      complete: async (req) => {
        seen.push(structuredClone(req.messages));
        return { ...reply(answers.shift()!), usage: { ...usage, input: 1000 * characters(req.system, req.messages, req.tools) } };
      },
    };
    const { app, session } = await mount([], { lead, save: true });
    await type(app, "a");
    await until(app, "one");
    await type(app, "b"); // no window known and no /autocompact size: no check
    await until(app, "two");
    await type(app, "/autocompact 200k");
    await until(app, "Shortens once the conversation passes 200,000 tokens.");
    expect(session.autoCompact).toBe(200_000);
    await type(app, "c");
    await until(app, "three");
    expect(seen.map(isSummary)).toEqual([false, false, true, false]);
    expect(app.lastFrame()).toContain(LINE);
    await type(app, "/autocompact off");
    await until(app, "Shortens only when a request would not fit.");
    expect(session.autoCompact).toBeNull();
    await type(app, "d");
    await until(app, "four");
    await type(app, "/autocompact 200M"); // more than the estimate
    await until(app, "Shortens once the conversation passes 200,000,000 tokens.");
    await type(app, "e");
    await until(app, "five");
    expect(seen.map(isSummary)).toEqual([false, false, true, false, false, false]);
  });

  it("gives the usage line in red for a wrong /autocompact, leaving the size as it was", async () => {
    await inColour(async () => {
      const { app, session } = await mount([]);
      session.autoCompact = 5;
      const wrongs = ["/autocompact", "/autocompact 0", "/autocompact 2g", "/autocompact 1.5k", "/autocompact 200k more", "/autocompact 9007199254740992"];
      for (const wrong of wrongs) await type(app, wrong);
      const usageLine = "Usage: /autocompact <tokens>, such as 200k, or /autocompact off";
      expect(flat(app).split(usageLine)).toHaveLength(wrongs.length + 1);
      expect(app.lastFrame()).toContain("\u001b[31mUsage: /autocompact");
      expect(session.autoCompact).toBe(5);
    });
  });
});

// Release 8b plan, Task 8: the user's hooks, as cli.tsx hands them to the session. Each hook is a Node script in a folder
// of the test's own, run in exec form, so no shell runs it.
// The waits for a hook's process are long, so each case has a minute (Task 8's code review).
describe("App's hooks", { timeout: 60_000 }, () => {
  const PICTURE = process.platform === "win32" ? "\u001bv" : "\u0016"; // chat:imagePaste: Alt+V on Windows, else Ctrl+V
  const PNG = { mediaType: "image/png" as const, data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }; // a stand-in, never read from disk
  const BLOCK = { decision: "block", reason: "not yet" };
  const BACK = "Your words are back in the prompt box.";
  // A hook's Node process may take a few seconds to start while other tests run: up to 10 s each.
  async function untilSlow(app: ReturnType<typeof render>, text: string) {
    for (let i = 0; i < 200 && !app.lastFrame()?.includes(text); i++) await tick();
    expect(app.lastFrame()).toContain(text);
  }
  // `ticks`: more for a wait that holds several hooks' runs, or a kill, which on Windows takes 2-4 s (taskkill /T).
  async function untilSlowly(check: () => boolean, ticks = 200) {
    for (let i = 0; i < ticks && !check(); i++) await tick();
    expect(check()).toBe(true);
  }
  // A UserPromptSubmit hook that gives `answer` to the `at`th prompt it is sent (the first unless given), once go() is
  // called when `held`, and lets the others through. `started()`: it has been sent that prompt; `answered()`: it has
  // printed its answer.
  function hookFor(answer: object, o: { at?: number; held?: boolean } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), "tachi-app-hook-"));
    onTestFinished(() => removeTree(dir));
    const at = (name: string) => path.join(dir, name);
    const script = at("hook.cjs");
    writeFileSync(
      script,
      `const fs = require("fs");
const at = (name) => require("path").join(${JSON.stringify(dir)}, name);
process.stdin.resume().on("end", () => {
  const n = (fs.existsSync(at("count")) ? Number(fs.readFileSync(at("count"), "utf8")) : 0) + 1;
  fs.writeFileSync(at("count"), String(n));
  if (n !== ${o.at ?? 1}) return;
  fs.writeFileSync(at("started"), "");
  const finish = () => (process.stdout.write(${JSON.stringify(JSON.stringify(answer))}), fs.writeFileSync(at("answered"), ""));
  const poll = () => (${o.held ? "true" : "false"} && !fs.existsSync(at("go")) ? setTimeout(poll, 20) : finish());
  poll();
});`,
    );
    const hooks: Hook[] = [{ event: "UserPromptSubmit", matcher: { all: true }, command: process.execPath, args: [script], async: false, where: "" }];
    return {
      hooks,
      started: () => existsSync(at("started")),
      answered: () => existsSync(at("answered")),
      go: () => writeFileSync(at("go"), ""),
      count: () => (existsSync(at("count")) ? Number(readFileSync(at("count"), "utf8")) : 0),
    };
  }

  // A stop gives the words back as a block does (approved by the user, 2026-11-09).
  it.each([
    ["blocked", BLOCK],
    ["stopped", { continue: false, stopReason: "not yet" }],
  ])("puts a %s prompt's words back into the prompt box, its picture too, saving nothing, and the picture goes with it when sent again", async (_name, answer) => {
    const pictures = new Pictures();
    const { app, session } = await mount([reply("seen")], { pictures, hooks: hookFor(answer).hooks });
    await press(app, "look at ", PICTURE);
    pictures.set(1, PNG);
    await press(app, "\r");
    await untilSlow(app, "Your words are back in the prompt box.");
    expect(app.lastFrame()).toContain("› look at [Image #1]");
    expect(app.lastFrame()).not.toContain("> look at");
    expect(session.messages).toEqual([]);
    await press(app, "\r");
    await untilSlow(app, "seen");
    expect(session.messages[0]!.parts).toEqual([{ type: "text", text: "look at " }, { type: "image", id: 1, ...PNG }]);
  });

  // The user's choice, 2026-11-09: as Ctrl-C brings the queue back.
  it("gives back the prompts queued behind a blocked one with it, in one line, sending none of them", async () => {
    const hook = hookFor(BLOCK, { held: true });
    const { app, session } = await mount([reply("never")], { hooks: hook.hooks });
    await press(app, "first", "\r");
    await untilSlowly(hook.started);
    await press(app, "second", "\r", "third", "\r");
    hook.go();
    await untilSlow(app, BACK);
    await tick();
    expect(app.lastFrame()).toMatch(/› first\n\s*second\n\s*third/);
    expect(app.lastFrame()!.split(BACK)).toHaveLength(2);
    expect([session.messages, hook.count()]).toEqual([[], 1]);
  });

  // Task 8's code review: the words land in the prompt as its text really is.
  it("ends Ctrl+R's search to give the words back, so its match cannot take their place", async () => {
    const hook = hookFor(BLOCK, { held: true });
    const { app } = await mount([], { hooks: hook.hooks, past: ["older"] });
    await press(app, "first", "\r");
    await untilSlowly(hook.started);
    await press(app, "\u0012", "old");
    expect(app.lastFrame()).toContain("search: old");
    hook.go();
    await untilSlow(app, BACK);
    expect(app.lastFrame()).not.toContain("search: old");
    expect(app.lastFrame()).toContain("› first\n");
  });

  it("ends a walk through the history to give the words back, with the draft it kept", async () => {
    const hook = hookFor(BLOCK, { held: true });
    const { app } = await mount([], { hooks: hook.hooks, past: ["older"] });
    await press(app, "first", "\r");
    await untilSlowly(hook.started);
    await press(app, "\u001b[A", "\u001b[A"); // past the prompt just sent, which the history keeps
    expect(app.lastFrame()).toContain("› older\n");
    hook.go();
    await untilSlow(app, BACK);
    expect(app.lastFrame()).toContain("› first\n");
    expect(app.lastFrame()).not.toContain("older");
    await press(app, "\u001b[B"); // the walk has ended, so Down brings back no draft in their place
    expect(app.lastFrame()).toContain("› first\n");
  });

  // Task 8's re-check: a recalled line the user changed is kept, after the draft, before the words.
  it("keeps a history line edited during the walk when it gives the words back", async () => {
    const hook = hookFor(BLOCK, { held: true });
    const { app } = await mount([], { hooks: hook.hooks, past: ["fix the tests"] });
    await press(app, "first", "\r");
    await untilSlowly(hook.started);
    await press(app, "\u001b[A", "\u001b[A", " in foo");
    expect(app.lastFrame()).toContain("› fix the tests in foo\n");
    hook.go();
    await untilSlow(app, BACK);
    expect(app.lastFrame()).toMatch(/› fix the tests in foo\n\s*first\n/);
  });

  // Whether the session has said the hook's block, after which the App gives the words back within the same run of
  // microtasks (queue.ts, perform); the screen is not drawn again while the editor has the terminal.
  const saidBlock = (bus: Bus) => {
    let said = false;
    bus.on("hook-note", (line) => void (said ||= line.startsWith("A UserPromptSubmit hook blocked the prompt")));
    return () => said;
  };

  it("keeps what the external editor saved over a recalled line when it gives the words back", async () => {
    const editor = standInEditor();
    editor.next("my long rewrite\n");
    vi.stubEnv("VISUAL", editor.command("wait"));
    const hook = hookFor(BLOCK, { held: true });
    const { app, bus } = await mount([], { hooks: hook.hooks, past: ["older"] });
    const blocked = saidBlock(bus);
    await press(app, "first", "\r");
    await untilSlowly(hook.started);
    await press(app, "\u001b[A", "\u001b[A", "\u0007"); // Up past the prompt just sent, then Ctrl+G
    await untilSlowly(editor.started);
    hook.go();
    await untilSlowly(blocked);
    await tick();
    editor.go();
    await untilSlow(app, BACK);
    expect(app.lastFrame()).toMatch(/› my long rewrite\n\s*first\n/);
  });

  it("gives the words back after the external editor returns, after what it saved, with their pictures", async () => {
    const editor = standInEditor();
    editor.next("edited\n");
    vi.stubEnv("VISUAL", editor.command("wait"));
    const pictures = new Pictures();
    const hook = hookFor(BLOCK, { held: true });
    const { app, session, bus } = await mount([reply("seen")], { pictures, hooks: hook.hooks });
    const blocked = saidBlock(bus);
    await press(app, "see ", PICTURE);
    pictures.set(1, PNG);
    await press(app, "\r");
    await untilSlowly(hook.started);
    await press(app, "draft", "\u0007"); // Ctrl+G
    await untilSlowly(editor.started);
    hook.go();
    // The block reaches the App while the editor is open, and the words wait for it to return: given back at once, the
    // editor's saved text would take their place, and the box would hold "edited" alone.
    await untilSlowly(blocked);
    await tick();
    editor.go();
    await untilSlow(app, BACK);
    expect(app.lastFrame()).toMatch(/› edited\n\s*see \[Image #1\]/);
    await press(app, "\r");
    await untilSlow(app, "seen");
    expect(session.messages[0]!.parts).toEqual([{ type: "text", text: "edited\nsee " }, { type: "image", id: 1, ...PNG }]);
  });

  // Task 8's last re-check: the editor reads the prompt's pictures as it opens, so one put in while its Ctrl+G waited for
  // the terminal, here held by /settings' editor, keeps its span through it.
  it("keeps the span of a picture put in while Ctrl+G waited for the terminal", async () => {
    const editor = standInEditor();
    vi.stubEnv("VISUAL", editor.command("wait"));
    const pictures = new Pictures();
    const { app, session } = await mount([reply("seen")], { pictures });
    await press(app, "/settings", "\r");
    await untilSlowly(editor.started);
    await press(app, "\u0007", "see ", PICTURE); // Ctrl+G waits for the terminal; the picture goes in meanwhile
    pictures.set(1, PNG);
    editor.next("see [Image #1]\n");
    editor.go(); // /settings' editor ends, and Ctrl+G's, the same stand-in, returns at once with the text above
    await untilSlow(app, "› see [Image #1]\n");
    await press(app, "\r");
    await untilSlow(app, "seen");
    expect(session.messages[0]!.parts).toEqual([{ type: "text", text: "see " }, { type: "image", id: 1, ...PNG }]);
  });

  // Task 8's re-check: a read that fails while the words wait for the editor takes its marker out of them, as it does
  // from the queue (pictureReads.ts, settle).
  it("takes a failed picture's marker out of the words waiting for the external editor", async () => {
    const editor = standInEditor();
    editor.next("edited\n");
    vi.stubEnv("VISUAL", editor.command("wait"));
    const pictures = new Pictures();
    const hook = hookFor(BLOCK, { held: true });
    const { app, bus } = await mount([], { pictures, hooks: hook.hooks });
    const blocked = saidBlock(bus);
    await press(app, "first", "\r");
    await untilSlowly(hook.started);
    await press(app, "queued ", PICTURE, "\r", "\u0007"); // a prompt queued with a picture still being read, then Ctrl+G
    await untilSlowly(editor.started);
    hook.go();
    await untilSlowly(blocked);
    await tick();
    pictures.set(1, { failed: "it broke" });
    await tick();
    editor.go();
    await untilSlow(app, BACK);
    expect(app.lastFrame()).toMatch(/› edited\n\s*first\n\s*queued *\n/);
    expect(app.lastFrame()).not.toContain("[Image #1]");
  });

  // giveBack's `before`: a picture an earlier message sent stays sent, so a copy of its marker goes as text.
  it("does not send twice a picture a blocked prompt held a copy of, sent with an earlier message", async () => {
    const pictures = new Pictures();
    const hook = hookFor(BLOCK, { at: 2 });
    const { app, session } = await mount([reply("one"), reply("two")], { pictures, hooks: hook.hooks });
    await press(app, PICTURE);
    pictures.set(1, PNG);
    await press(app, "\u0015", "\u0019", "\r"); // Ctrl+U takes the marker, Ctrl+Y puts it back, its picture kept
    await untilSlow(app, "one");
    await press(app, "\u0019", " again", "\r"); // the same marker again, its picture sent already
    await untilSlow(app, BACK);
    await press(app, "\r");
    await untilSlow(app, "two");
    const user = session.messages.filter((m) => m.role === "user").map((m) => m.parts);
    expect(user).toEqual([[{ type: "image", id: 1, ...PNG }], [{ type: "text", text: "[Image #1] again" }]]);
  });

  // Release 8b plan, Task 10 and choice 18: each switch ends the session it leaves, then starts the one it opens, and
  // SessionStart's context goes with the next request. The hook writes its input to a file in the test's folder.
  it("fires SessionEnd then SessionStart at /branch (other, fork), /clear (clear, clear) and /resume (resume, resume)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tachi-app-hook-"));
    onTestFinished(() => removeTree(dir));
    const out = path.join(dir, "inputs.jsonl");
    const script = path.join(dir, "hook.cjs");
    writeFileSync(
      script,
      `const fs = require("fs");
let text = "";
process.stdin.setEncoding("utf8").on("data", (d) => (text += d)).on("end", () => {
  fs.appendFileSync(${JSON.stringify(out)}, text + "\\n");
  const input = JSON.parse(text);
  if (input.hook_event_name === "SessionStart")
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "started by " + input.source } }));
});`,
    );
    const inputs = () => (existsSync(out) ? readFileSync(out, "utf8").split("\n").slice(0, -1).map((l) => JSON.parse(l) as Record<string, unknown>) : []);
    const sessions = path.join(dir, "data", "sessions");
    const earlier = await mount([reply("noted")], { save: true, sessions });
    await type(earlier.app, "remember apple");
    await untilSlow(earlier.app, "noted");
    earlier.app.unmount();
    const hooks: Hook[] = (["SessionStart", "SessionEnd"] as const).map((event) => ({
      event, matcher: { all: true }, command: process.execPath, args: [script], async: false, where: "",
    }));
    const lead = new FakeProvider("a", [reply("one"), reply("two")]);
    const { app, session } = await mount([], { lead, save: true, sessions, hooks });
    await type(app, "first");
    await untilSlow(app, "one");
    const ids = [session.id];
    // Each step's SessionStart has answered before the next command, so the file's lines come in the order fired.
    for (const [command, line, n] of [["/branch", "Branched:", 2], ["/clear", "Started a new session", 4], ["/resume", "Resumed:", 6]] as const) {
      await type(app, command);
      if (command === "/resume") {
        await untilSlow(app, "Saved sessions in this folder, newest first:");
        await press(app, "\r");
      }
      await untilSlow(app, line);
      await untilSlowly(() => inputs().length === n, 600);
      ids.push(session.id);
    }
    expect(inputs().map((i) => [i.hook_event_name, i.reason ?? i.source, i.session_id])).toEqual([
      ["SessionEnd", "other", ids[0]],
      ["SessionStart", "fork", ids[1]],
      ["SessionEnd", "clear", ids[1]],
      ["SessionStart", "clear", ids[2]],
      ["SessionEnd", "resume", ids[2]],
      ["SessionStart", "resume", ids[3]],
    ]);
    await type(app, "last");
    await untilSlow(app, "two");
    expect(lead.seen.at(-1)!.at(-1)!.parts).toEqual([
      { type: "text", text: "SessionStart hook:\nstarted by resume", from: "hooks" },
      { type: "text", text: "last" },
    ]);
  });

  // Release 8b plan, Task 10 (approved by the user, 2026-11-09): SessionEnd as the user leaves, its keys off meanwhile and
  // the screen as it was; in full screen its lines are handed back, to print once the window has closed. The window has
  // closed once its session's lock is let go (App's unmount). The hook writes its input to a file in the test's folder,
  // waits for the file `go` when one is given, and prints `stdout`; without `go` given it never ends.
  function endHook(stdout: string, held: "go" | "never") {
    const dir = mkdtempSync(path.join(tmpdir(), "tachi-app-hook-"));
    onTestFinished(() => removeTree(dir));
    const at = (name: string) => path.join(dir, name);
    const script = at("hook.cjs");
    writeFileSync(
      script,
      `const fs = require("fs");
let text = "";
process.stdin.setEncoding("utf8").on("data", (d) => (text += d)).on("end", () => {
  fs.writeFileSync(${JSON.stringify(at("pid"))}, String(process.pid));
  fs.appendFileSync(${JSON.stringify(at("inputs.jsonl"))}, text + "\\n");
  const poll = () => (fs.existsSync(${JSON.stringify(at(held))}) ? process.stdout.write(${JSON.stringify(stdout)}) : setTimeout(poll, 20));
  poll();
});`,
    );
    const hooks: Hook[] = [{ event: "SessionEnd", matcher: { all: true }, command: process.execPath, args: [script], async: false, where: "" }];
    const inputs = () => (existsSync(at("inputs.jsonl")) ? readFileSync(at("inputs.jsonl"), "utf8").split("\n").slice(0, -1).map((l) => JSON.parse(l)) : []);
    // Whether the hook's process is still running, once it has started.
    const alive = () => {
      try {
        process.kill(Number(readFileSync(at("pid"), "utf8")), 0);
        return true;
      } catch {
        return false;
      }
    };
    onTestFinished(() => void (existsSync(at("pid")) && alive() && process.kill(Number(readFileSync(at("pid"), "utf8")))));
    return { hooks, script, inputs, alive, go: () => writeFileSync(at("go"), "") };
  }
  const closed = (sessions: string, id: string) => {
    const lock = openSession(sessions, id);
    lock?.release();
    return lock !== null;
  };

  it("fires SessionEnd prompt_input_exit at /exit, its keys off and the screen as it was while its hooks run, then closes", async () => {
    const hook = endHook(JSON.stringify({ systemMessage: "bye\tnow\u0007" }), "go"); // a tab kept, a bell escaped
    const left: string[][] = [];
    const { app, session, sessions } = await mount([], { save: true, hooks: hook.hooks, full: true, leftLines: (l) => left.push(l) });
    await type(app, "/exit");
    await untilSlowly(() => hook.inputs().length === 1);
    expect(hook.inputs()[0]).toMatchObject({ hook_event_name: "SessionEnd", reason: "prompt_input_exit", session_id: session.id });
    const before = app.lastFrame();
    await press(app, "x");
    expect(app.lastFrame()).toBe(before);
    expect(before).toContain("›");
    expect(closed(sessions, session.id)).toBe(false);
    hook.go();
    await untilSlowly(() => closed(sessions, session.id));
    expect(left).toEqual([["SessionEnd hook: bye\tnow\\u0007"]]);
  });

  // Task 10's code review, point 5 (the user's choice, 2026-11-09: "Esc stops it"): a switch's SessionEnd shows the working
  // line, and Esc stops its hooks, saying nothing of them, and the switch goes ahead.
  it("shows the working line while /clear's SessionEnd hooks run, and Esc stops them and the switch goes ahead", async () => {
    const hook = endHook("", "never");
    const { app, session } = await mount([reply("one")], { save: true, hooks: hook.hooks });
    await type(app, "first");
    await untilSlow(app, "one");
    const old = session.id;
    await type(app, "/clear");
    await untilSlowly(() => hook.inputs().length === 1);
    await untilSlow(app, "Esc to stop");
    expect(app.lastFrame()).toMatch(/\n. Working · \d+s · Esc to stop\n/);
    await press(app, "\u001b");
    await untilSlow(app, "Started a new session; the last one is kept (tachi --resume lists it).");
    expect(session.id).not.toBe(old);
    await untilSlowly(() => !hook.alive(), 600); // a tree kill on Windows takes 2-4 s (taskkill /T)
    expect(app.lastFrame()).not.toContain("Esc to stop");
    expect(app.lastFrame()).not.toContain("✗");
  });

  // Task 10's code review: what is typed while a switch's SessionEnd runs waits in the queue, then goes to the new session.
  it("holds a prompt typed while /clear's SessionEnd hooks run, then sends it in the new session", async () => {
    const hook = endHook("", "go");
    const lead = new FakeProvider("a", [reply("one"), reply("two")]);
    const { app, session } = await mount([], { lead, save: true, hooks: hook.hooks });
    await type(app, "first");
    await untilSlow(app, "one");
    const old = session.id;
    await type(app, "/clear");
    await untilSlowly(() => hook.inputs().length === 1);
    await type(app, "hello");
    await tick();
    expect(lead.seen).toHaveLength(1);
    hook.go();
    await untilSlow(app, "two");
    expect(session.id).not.toBe(old);
    expect(lead.seen[1]).toEqual([{ role: "user", parts: [{ type: "text", text: "hello" }] }]);
  });

  // In copy mode the review, or the leaving line, is drawn in place of everything, so the line is handed back there too,
  // in classic mode as well (Task 10's spec review). The copy's box is never gone here, so no review opens.
  it.each([
    ["full screen", true, false],
    ["classic", false, false],
    ["classic, in copy mode", false, true],
  ])("kills a SessionEnd hook that sleeps at 1.5 s, says so, and the window still closes, in %s", async (_name, full, copied) => {
    const hook = endHook("", "never");
    const left: string[][] = [];
    const ended: string[][] = [];
    const copy: AppProps["copy"] = {
      copy: { session: "s1", folder: path.join(tmpdir(), "tachi-no-copy"), manifest: {} as never },
      stop: async () => false,
      protection: async () => ({ hooks: [], files: [] }),
      ended: (lines) => ended.push(lines),
    };
    const { app, session, sessions } = await mount([], { save: true, hooks: hook.hooks, full, leftLines: (l) => left.push(l), ...(copied ? { copy } : {}) });
    await press(app, "\u0003", "\u0003");
    await untilSlowly(() => hook.inputs().length === 1);
    await untilSlowly(() => closed(sessions, session.id), 600); // Node's start, 1.5 s, then the kill
    // Red with the line alone, as the window draws a hook's failure (release 8b plan, choice 22).
    const line = `✗ SessionEnd hook failed: ${process.execPath} ${hook.script} ran out of time after 1.5 s`;
    expect(ended).toHaveLength(copied ? 1 : 0); // after the copy's own lines
    // In plain classic mode the line stays in the terminal as the window drew it; otherwise it is printed once closed.
    if (full || copied) expect(left).toEqual([[line]]);
    else {
      expect(left).toEqual([]);
      expect(stripVTControlCharacters(app.frames.join("\n")).replace(/\s/g, "")).toContain(line.replace(/\s/g, "")); // drawn before Ink ended
    }
  });

  // Release 8b plan, Task 12 (choices 22 to 25). A hook of the test's own: `body` runs once the hook has read its input,
  // with `input`, the input as sent, and `n`, how many times the script has run, the first time 1.
  function nodeHook(body: string) {
    const dir = mkdtempSync(path.join(tmpdir(), "tachi-app-hook-"));
    onTestFinished(() => removeTree(dir));
    const script = path.join(dir, "hook.cjs");
    const count = path.join(dir, "count");
    writeFileSync(
      script,
      `const fs = require("fs");
let text = "";
process.stdin.setEncoding("utf8").on("data", (d) => (text += d)).on("end", () => {
  const input = JSON.parse(text);
  const n = (fs.existsSync(${JSON.stringify(count)}) ? Number(fs.readFileSync(${JSON.stringify(count)}, "utf8")) : 0) + 1;
  fs.writeFileSync(${JSON.stringify(count)}, String(n));
  ${body}
});`,
    );
    const hook = (event: HookEvent, more: Partial<Hook> = {}): Hook => ({
      event, matcher: { all: true }, command: process.execPath, args: [script], async: false, where: JSON.stringify(event), ...more,
    });
    return { script, hook, command: `${process.execPath} ${script}` };
  }
  // A frame without its colours and its white space, where Ink wraps a long line (the hooks' commands are long paths).
  const squashed = (text: string) => stripVTControlCharacters(text).replace(/\s/g, "");

  it("shows a hook's systemMessage grey and escaped, and a hook's failure red with the line alone", async () => {
    await inColour(async () => {
      const said = nodeHook('process.stdout.write(JSON.stringify({ systemMessage: "look\\u0007\\nnow" }));');
      const broken = nodeHook('process.stderr.write("broken\\n"); process.exitCode = 1;');
      const { app } = await mount([callTool("c1", "read_file", { path: "a.txt" }), reply("done")], {
        hooks: [said.hook("PreToolUse"), broken.hook("PreToolUse")],
      });
      await type(app, "go");
      await untilSlow(app, "done");
      const frame = app.lastFrame()!;
      // A bell would act on the terminal, and a line break could pass for a line of the window's own (Task 6's review).
      expect(frame).toContain("\u001b[90mPreToolUse hook: look\\u0007⏎now");
      expect(frame).toContain("\u001b[31m✗ PreToolUse hook failed: ");
      expect(squashed(frame)).toContain(squashed(`✗ PreToolUse hook failed: ${broken.command} exited with code 1: broken`));
    });
  });

  // Task 8's carry-over: the session says the block during send, before the App gives the words back.
  it("shows a UserPromptSubmit hook's block before saying the words are back in the prompt box", async () => {
    const { app } = await mount([], { hooks: hookFor(BLOCK).hooks });
    await type(app, "first");
    await untilSlow(app, BACK);
    expect(app.lastFrame()).toContain(`A UserPromptSubmit hook blocked the prompt: not yet\n${BACK}\n`);
  });

  // Plan review, second round, finding 3: a subagent's lines reach the window through the lead's bus, each naming it.
  it("shows a subagent's systemMessage, its SubagentStop block and its stop, each naming it", async () => {
    const stop = nodeHook(`const block = { decision: "block", reason: "again", systemMessage: "hi" };
  process.stdout.write(JSON.stringify(n === 1 ? block : { continue: false, stopReason: "enough" }));`);
    const worker = new FakeProvider("w", [reply("found it"), reply("found it again")]);
    const { app } = await mount([callTool("c1", "delegate", { description: "look", task: "look around" }), reply("all done")], {
      worker,
      hooks: [stop.hook("SubagentStop")],
    });
    await type(app, "go");
    await untilSlow(app, "all done");
    expect(app.lastFrame()).toContain("t1: SubagentStop hook: hi\nA SubagentStop hook kept t1 going: again\n");
    expect(app.lastFrame()).toContain("t1: A SubagentStop hook stopped the turn: enough\n");
  });

  // Choice 24, and Task 6's review: the call is shown as the model sent it, and the rewrite under its hook's run.
  it("lists the last turn's hook runs on Ctrl+O after its calls, with what each handed the model, rewrote or could not use", async () => {
    const h = nodeHook(`process.stdout.write(JSON.stringify(input.hook_event_name === "PreToolUse"
    ? { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { file_path: "b.txt" }, additionalContext: "checked" } }
    : { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: { not: "text" } } }));`);
    const { app, ctx } = await mount([callTool("c1", "read_file", { path: "a.txt" }), reply("done")], { hooks: [h.hook("PreToolUse"), h.hook("PostToolUse")] });
    await writeFile(path.join(ctx.root, "b.txt"), "from b");
    await type(app, "go");
    await untilSlow(app, "done");
    await press(app, "\u000f");
    const frame = app.lastFrame()!;
    expect(frame).toContain('Last turn: 1 tool call\n● read_file {\n  "path": "a.txt"\n}\n  ⎿ ');
    expect(frame).toMatch(/⎿ [^\n]*from b/);
    const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Named as /hooks names it, its program and script (the user's choice, 2026-11-10, terminal checklist).
    const run = (event: string) => `${literal(`◆${event}hooknodehook.cjsforread_file·exit0·`)}\\d+ms`;
    const shown = squashed(frame.slice(frame.lastIndexOf("Last turn:")));
    const rewrite = literal('⎿checked⎿{"file_path":"b.txt"}');
    const unused = literal("⎿itsupdatedToolOutputwasnotused:itdoesnotmatchread_file'sresult");
    expect(shown).toMatch(new RegExp(`fromb${run("PreToolUse")}${rewrite}${run("PostToolUse")}${unused}`));
  });

  // Choice 25: the list, printed once into the conversation, as /tasks prints its list. Each hook by its name, its matcher
  // when not every value, and its own timeout (the user's choice, 2026-11-10, terminal checklist).
  it("lists the hooks in force on /hooks, by event, each by its name, with the ones left out", async () => {
    const leftOut = ['"Notification" is not an event Tachikoma runs hooks at; its hooks were left out'];
    const hook = (event: HookEvent, matcher: Hook["matcher"], command: string, more: Partial<Hook> = {}): Hook => ({
      event, matcher, command, async: false, where: JSON.stringify(event), ...more,
    });
    const jq = `jq -r '.tool_input.command | test("^(npm|pnpm) (i|install)\\\\b") | not' | grep -q true || exit 2`;
    const hooks = [
      hook("PreToolUse", { names: ["Edit", "Write"] }, jq, { statusMessage: "protected paths guard" }),
      hook("PreToolUse", { names: ["Bash"] }, jq),
      hook("PreToolUse", { regex: /^mcp__/ }, "log", { args: ["--all"], timeout: 5, async: true }),
      hook("SessionStart", { names: ["startup", "resume", "clear"] }, 'bash "C:/a b/recall.sh" --quiet', { statusMessage: "recall\u0007" }),
      hook("UserPromptSubmit", { all: true }, 'node "C:/x y/block-prompt.js"'),
      hook("PostToolUse", { names: ["Glob"] }, "C:\\Program Files\\nodejs\\node.exe", { args: ["--no-warnings", "C:\\t\\fail.js"], statusMessage: "" }),
      hook("PostToolUse", { names: ["Grep"] }, "node", { args: ["sleep.js"], timeout: 2 }),
      hook("SessionEnd", { all: true }, "bye"),
      // The limit that applies, as limitOf gives it: at SessionEnd a hook's own timeout counts up to 60 s.
      hook("SessionEnd", { all: true }, "save", { timeout: 30 }),
      hook("SessionEnd", { all: true }, "long", { timeout: 90 }),
    ];
    const { app } = await mount([], { hooks: { hooks, off: false, leftOut } });
    await type(app, "/hooks");
    expect(app.lastFrame()).toContain(
      [
        `Hooks in force, from ${shownFile()}:`,
        "PreToolUse",
        "  protected paths guard · Edit|Write",
        "  jq · Bash",
        "  log · ^mcp__ · 5 s · async",
        "SessionStart",
        "  recall\\u0007 · startup|resume|clear",
        "UserPromptSubmit",
        "  node block-prompt.js",
        "PostToolUse",
        "  node fail.js · Glob",
        "  node sleep.js · Grep · 2 s",
        "SessionEnd",
        "  bye",
        "  save · 30 s",
        "  long · 60 s",
        "Left out:",
        `  ${leftOut[0]}`,
      ].join("\n"),
    );
    await type(app, "/hooks now");
    expect(app.lastFrame()).toContain("/hooks takes nothing after it.");
  });

  it.each([
    ["none in force", { hooks: [], off: false, leftOut: [] }, `No hooks in force. They go in "hooks" in ${shownFile()}.`],
    ["only left-out ones", { hooks: [], off: false, leftOut: ['"Notification" is not an event Tachikoma runs hooks at; its hooks were left out'] },
      `No hooks in force. They go in "hooks" in ${shownFile()}.\nLeft out:\n  "Notification" is not an event Tachikoma runs hooks at; its hooks were left out`],
    ["hooks turned off", { hooks: [{ event: "Stop", matcher: { all: true }, command: "x", async: false, where: '"Stop"' }], off: true, leftOut: [] },
      `Hooks are off: "disableAllHooks" is true in ${shownFile()}.`],
  ] as [string, HooksConfig, string][])("says so on /hooks with %s", async (_name, config, said) => {
    const { app } = await mount([], { hooks: config });
    await type(app, "/hooks");
    expect(app.lastFrame()).toContain(`${said}\n`);
    expect(app.lastFrame()).not.toContain("Hooks in force");
  });

  // Release 8b design, "What the user sees" ("Live, with a line"): an edit applies from the next event; a matcher's regular
  // expression stringifies to {}, so the comparison reads its text (Task 6's review); a broken file keeps the hooks.
  it("applies a live edit of the hooks from the next call, with its line, and keeps them when the file breaks", async () => {
    const h = nodeHook('process.stdout.write(JSON.stringify({ systemMessage: "fired " + n }));');
    const home = mkdtempSync(path.join(tmpdir(), "tachi-home-"));
    onTestFinished(() => removeTree(home));
    const where = path.join(settingsDir(home), "settings.json");
    mkdirSync(settingsDir(home), { recursive: true });
    writeFileSync(where, "{}");
    const { app, hooks } = await mount([callTool("c1", "read_file", { path: "a.txt" }), reply("done")], {
      home, live: { loaded: { settings: {}, warnings: [] }, given: {} }, hooks: [],
    });
    const entry = (matcher: string) => ({ PreToolUse: [{ matcher, hooks: [{ type: "command", command: process.execPath, args: [h.script] }] }] });
    const write = (settings: object | string) => writeFileSync(where, typeof settings === "string" ? settings : JSON.stringify(settings));
    // In the conversation, above the prompt: the hint row under it shows the edit's last line too, until a key (choice 35).
    const times = (text: string) => app.lastFrame()!.slice(0, app.lastFrame()!.lastIndexOf("›")).split(text).length - 1;
    const CHANGED = "Hooks changed: 1 hook at 1 event.";
    write({ hooks: entry("Read") });
    await vi.waitFor(() => expect(times(CHANGED)).toBe(1), WATCHED);
    await type(app, "go");
    await untilSlow(app, "PreToolUse hook: fired 1");
    await untilSlow(app, "done");
    write({ hooks: entry("R.ad") });
    await vi.waitFor(() => expect(times(CHANGED)).toBe(2), WATCHED);
    write({ hooks: entry("Re.d") }); // one regular expression for another
    await vi.waitFor(() => expect(times(CHANGED)).toBe(3), WATCHED);
    write("{");
    await untilSlow(app, "the last good settings still apply");
    expect(hooks!.config.hooks.map((x) => x.matcher)).toEqual([{ regex: /Re.d/ }]);
    write({ hooks: entry("Read"), disableAllHooks: true }); // both entries changed: one line
    await untilSlow(app, "Hooks changed: all off (disableAllHooks).");
    await tick();
    expect(times("Hooks changed: all off (disableAllHooks).")).toBe(1);
    expect(times(CHANGED)).toBe(3);
    expect(hooks!.config.off).toBe(true);
    write({});
    await untilSlow(app, "Hooks changed: none in force.");
    expect(hooks!.config).toEqual({ hooks: [], off: false, leftOut: [] });
    write({ hooks: { ...entry("Read"), Stop: entry("Read").PreToolUse.map(({ hooks: h }) => ({ hooks: [...h, { type: "command", command: "x" }] })) } });
    await untilSlow(app, "Hooks changed: 3 hooks at 2 events."); // the plural, approved by the user, 2026-11-10
  });

  it("shows a running hook's statusMessage on the waiting line, escaped, then the line's own words again", async () => {
    const hook = hookFor({}, { held: true });
    hook.hooks[0]!.statusMessage = "Checking\u0007 the prompt";
    const lead = new Held();
    const { app } = await mount([], { lead, hooks: hook.hooks });
    await type(app, "first");
    await untilSlowly(hook.started);
    await untilSlow(app, "Checking\\u0007 the prompt · ");
    hook.go();
    await untilSlow(app, "Working · ");
    expect(app.lastFrame()).not.toContain("Checking");
    lead.answer("done");
    await untilSlow(app, "done");
  });

  // Task 10's carry-over: in plain classic mode the window's own line is what the user keeps of a SessionEnd note at exit.
  it("draws a SessionEnd hook's systemMessage at /exit in plain classic mode before the window closes", async () => {
    const hook = endHook(JSON.stringify({ systemMessage: "bye" }), "go");
    const left: string[][] = [];
    const { app, session, sessions } = await mount([], { save: true, hooks: hook.hooks, leftLines: (l) => left.push(l) });
    await type(app, "/exit");
    await untilSlowly(() => hook.inputs().length === 1);
    hook.go();
    await untilSlowly(() => closed(sessions, session.id));
    expect(app.frames.join("\n")).toContain("SessionEnd hook: bye");
    expect(left).toEqual([]);
  });

  // Choice 2: the launch's line, which full screen hides on stderr until the user quits, shows in the session too, grey as
  // the settings file's warnings, as the --network line does.
  it("shows in full screen, in grey, that Git Bash was not found", async () => {
    await inColour(async () => {
      const line = "Git Bash was not found, so hooks run by a shell use Windows PowerShell; set CLAUDE_CODE_GIT_BASH_PATH to its bash.exe to change that.";
      const home = mkdtempSync(path.join(tmpdir(), "tachi-home-"));
      onTestFinished(() => removeTree(home));
      const { app } = await mount([], { full: true, home, live: { loaded: { settings: {}, warnings: [] }, given: {}, bashLine: line } });
      expect(app.lastFrame()).toContain("\u001b[90mGit Bash was not found");
      expect(squashed(app.lastFrame()!)).toContain(squashed(line));
    });
  });

  // Task 12's spec review (the user's words, 2026-11-10): each run names its own tool, by Tachikoma's name.
  it("names each tool hook run's tool on Ctrl+O, two calls in a turn", async () => {
    const h = nodeHook("");
    const calls = { parts: [...callTool("c1", "read_file", { path: "a.txt" }).parts, ...callTool("c2", "find_files", { pattern: "*.txt" }).parts], usage };
    const { app } = await mount([calls, reply("done")], { hooks: [h.hook("PreToolUse")] });
    await type(app, "go");
    await untilSlow(app, "done");
    await press(app, "\u000f");
    const shown = squashed(app.lastFrame()!);
    expect(shown).toMatch(new RegExp(`◆PreToolUsehook[^◆]*forread_file·exit0·\\d+ms◆PreToolUsehook[^◆]*forfind_files·exit0·\\d+ms`));
  });

  // Task 12's spec review: each line in the window, triggered for real ("Lines this plan adds"). A read of a.txt, which
  // ask mode runs unasked, with PreToolUse hooks answering as given; `line` gets the hooks' commands.
  const pre = (answer: object) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...answer } });
  it.each([
    [
      "a refusal with its reason",
      [pre({ permissionDecision: "deny", permissionDecisionReason: "not the notes" })],
      () => "A PreToolUse hook refused read_file: not the notes",
    ],
    ["a refusal with no reason", [pre({ permissionDecision: "deny" })], () => "A PreToolUse hook refused read_file."],
    [
      "a rewrite that cannot be used",
      [pre({ updatedInput: { file_path: 5 } })],
      (c: string[]) => `A PreToolUse hook's rewrite of read_file could not be used ("file_path" must be text in quotes): ${c[0]}`,
    ],
    [
      "two rewrites",
      [pre({ updatedInput: { file_path: "a.txt" } }), pre({ updatedInput: { file_path: "b.txt" } })],
      (c: string[]) => `Two PreToolUse hooks rewrote read_file's input; the first in the settings file was used, and ${c[1]} was ignored.`,
    ],
    ["defer", [pre({ permissionDecision: "defer" })], () => 'A PreToolUse hook answered "defer", which Tachikoma takes as no opinion.'],
  ] as [string, string[], (commands: string[]) => string][])("shows a PreToolUse hook's line in the window: %s", async (_name, answers, line) => {
    const made = answers.map((a) => nodeHook(`process.stdout.write(${JSON.stringify(a)});`));
    const { app } = await mount([callTool("c1", "read_file", { path: "a.txt" }), reply("done")], { hooks: made.map((m) => m.hook("PreToolUse")) });
    await type(app, "go");
    await untilSlow(app, "done");
    expect(squashed(app.lastFrame()!)).toContain(squashed(line(made.map((m) => m.command))));
  });

  it("shows in grey that never mode cannot put a PreToolUse hook's question", async () => {
    await inColour(async () => {
      const h = nodeHook(`process.stdout.write(${JSON.stringify(pre({ permissionDecision: "ask", permissionDecisionReason: "Sure?" }))});`);
      const { app } = await mount([callTool("c1", "read_file", { path: "a.txt" }), reply("done")], { mode: "never", hooks: [h.hook("PreToolUse")] });
      await type(app, "go");
      await untilSlow(app, "done");
      expect(app.lastFrame()).toContain("\u001b[90mNot allowed in never mode: a PreToolUse hook asked for this call to be approved (Sure?).");
    });
  });

  it("puts a PreToolUse hook's question with its reason as the question's grey note", async () => {
    const h = nodeHook(`process.stdout.write(${JSON.stringify(pre({ permissionDecision: "ask", permissionDecisionReason: "Sure?" }))});`);
    const { app } = await mount([callTool("c1", "read_file", { path: "a.txt" }), reply("done")], { hooks: [h.hook("PreToolUse")] });
    await type(app, "go");
    await untilSlow(app, "Allow");
    expect(app.lastFrame()).toMatch(/A hook asks: Sure\?\nAllow read_file/);
    await press(app, "n");
    await untilSlow(app, "done");
  });

  it.each([
    ["once", 'process.stdout.write(n === 1 ? JSON.stringify({ decision: "block", reason: "again" }) : "");', 2, "A Stop hook kept the turn going: again"],
    [
      "8 times in a row",
      'process.stdout.write(JSON.stringify({ decision: "block", reason: "again" }));',
      9,
      "Stop hooks kept the turn going 8 times in a row; it ends here.",
    ],
  ])("shows a Stop hook keeping the turn going %s", async (_name, body, replies, line) => {
    const h = nodeHook(body);
    const { app } = await mount(Array.from({ length: replies }, (_, i) => reply(`reply ${i + 1}`)), { hooks: [h.hook("Stop")] });
    await type(app, "go");
    await untilSlowly(() => app.lastFrame()!.includes(line), 600); // nine Node starts for the eight
    expect(app.lastFrame()).toContain(`reply ${replies}`);
  });

  it.each([
    ["block", 'process.stderr.write("no\\n"); process.exitCode = 2;', "asked to block, but an \"async\" hook cannot block"],
    ["stop", 'process.stdout.write(JSON.stringify({ continue: false, stopReason: "enough" }));', "asked to stop, but an \"async\" hook cannot stop"],
  ])("shows in red that an async hook cannot %s", async (_name, body, words) => {
    await inColour(async () => {
      const h = nodeHook(body);
      const { app } = await mount([callTool("c1", "read_file", { path: "a.txt" }), reply("done")], { hooks: [h.hook("PreToolUse", { async: true })] });
      await type(app, "go");
      await untilSlowly(() => squashed(app.lastFrame()!).includes(squashed(`✗ PreToolUse hook failed: ${h.command} ${words}`)));
      expect(app.lastFrame()).toContain("\u001b[31m✗ PreToolUse hook failed: ");
    });
  });

  // Nothing runs: no program of that name is on PATH, and exec form needs no shell.
  it("shows in red a hook that could not start", async () => {
    const hook: Hook = { event: "PreToolUse", matcher: { all: true }, command: "tachi-no-such-program", args: [], async: false, where: '"PreToolUse"' };
    const { app } = await mount([callTool("c1", "read_file", { path: "a.txt" }), reply("done")], { hooks: [hook] });
    await type(app, "go");
    await untilSlow(app, "done");
    expect(app.lastFrame()).toContain("✗ PreToolUse hook failed: tachi-no-such-program could not start (not found on PATH)");
  });

  // On Windows a Node process that kills itself so exits with code 1, no signal reported (measured 2026-11-10), so the line
  // can be seen only elsewhere.
  it.skipIf(process.platform === "win32")("shows in red a hook ended by a signal", async () => {
    const h = nodeHook('process.kill(process.pid, "SIGTERM");');
    const { app } = await mount([callTool("c1", "read_file", { path: "a.txt" }), reply("done")], { hooks: [h.hook("PreToolUse")] });
    await type(app, "go");
    await untilSlow(app, "done");
    expect(squashed(app.lastFrame()!)).toContain(squashed(`✗ PreToolUse hook failed: ${h.command} was ended by signal SIGTERM`));
  });

  // Task 11's line, through /compact: the shortened conversation fits the lead's window, but not with SessionStart's text.
  it("says SessionStart's text was left out of a shortening it would not let fit", async () => {
    const h = nodeHook('process.stdout.write("y".repeat(9000));');
    const first = { parts: [{ type: "text" as const, text: "noted" }], usage: { ...usage, input: 600 } }; // the window nearly full
    const lead = Object.assign(new FakeProvider("a", [first, reply("Compacted.")]), { contextWindow: async () => 700 });
    const { app } = await mount([], { lead, save: true, hooks: [h.hook("SessionStart", { matcher: { names: ["compact"] } })] });
    await type(app, "hi");
    await untilSlow(app, "noted");
    await type(app, "/compact");
    const line = "SessionStart hook text was left out: with it, the shortened conversation would not fit the model's window.";
    await untilSlowly(() => squashed(app.lastFrame()!).includes(squashed(line)));
  });

  // Task 12's code review: Ctrl+O lists exactly the runs of the lead turn it shows, so a turn that only reads background
  // answers starts a list of its own.
  it("lists on Ctrl+O none of an earlier turn's hook runs after a turn that only reads background answers", async () => {
    const h = nodeHook("");
    const worker = new Held("fake:w");
    const delegate = callTool("c1", "delegate", { description: "find x", task: "find x", background: true });
    const lead = new FakeProvider("a", [delegate, reply("started it"), reply("t1 says found")]);
    const { app } = await mount([], { lead, worker, hooks: [h.hook("PreToolUse")] });
    await type(app, "go");
    await untilSlow(app, "started it");
    await press(app, "\u000f");
    expect(squashed(app.lastFrame()!)).toContain("◆PreToolUsehook");
    worker.answer("found");
    await untilSlow(app, "t1 says found");
    await press(app, "\u000f");
    const frame = app.lastFrame()!;
    expect(frame.slice(frame.lastIndexOf("Last turn:"))).toMatch(/^Last turn: 0 tool calls\n/);
    expect(frame.slice(frame.lastIndexOf("Last turn:"))).not.toContain("◆");
  });

  // Task 12's code review: after a switch the old session's runs are gone, the switch's SessionEnd among them.
  it("lists on Ctrl+O none of the old session's hook runs after /resume", async () => {
    const h = nodeHook("");
    const sessions = path.join(mkdtempSync(path.join(tmpdir(), "tachi-app-hook-")), "data", "sessions");
    onTestFinished(() => removeTree(path.dirname(path.dirname(sessions))));
    const earlier = await mount([callTool("c1", "find_files", { pattern: "*.md" }), reply("noted")], { save: true, sessions });
    await type(earlier.app, "remember apple");
    await untilSlow(earlier.app, "noted");
    earlier.app.unmount();
    const { app } = await mount([callTool("c1", "read_file", { path: "a.txt" }), reply("done")], {
      save: true,
      sessions,
      hooks: [h.hook("PreToolUse"), h.hook("SessionEnd")],
    });
    await type(app, "go");
    await untilSlow(app, "done");
    await type(app, "/resume");
    await untilSlow(app, "Saved sessions in this folder, newest first:");
    await press(app, "\r");
    await untilSlow(app, "Resumed:");
    await press(app, "\u000f");
    const frame = app.lastFrame()!;
    const shown = frame.slice(frame.lastIndexOf("Last turn:"));
    expect(shown).toMatch(/^Last turn: 1 tool call\n● find_files/);
    expect(shown).not.toContain("◆");
  });

  // The user's choice, 2026-11-10: /branch keeps the last turn on screen and in Ctrl+O, so its hook runs stay, the branch's
  // own SessionEnd (other) and SessionStart (fork) runs after them.
  it("keeps the last turn's hook runs on Ctrl+O after /branch, with the branch's SessionEnd and SessionStart runs after them", async () => {
    const h = nodeHook("");
    const { app, hooks } = await mount([callTool("c1", "read_file", { path: "a.txt" }), reply("done")], {
      save: true,
      hooks: [h.hook("PreToolUse"), h.hook("SessionEnd"), h.hook("SessionStart")],
    });
    await type(app, "go");
    await untilSlow(app, "done");
    await type(app, "/branch");
    await untilSlow(app, "Branched:");
    await untilSlowly(() => hooks!.runs.length === 3);
    await press(app, "\u000f");
    const frame = app.lastFrame()!;
    const shown = squashed(frame.slice(frame.lastIndexOf("Last turn:")));
    expect(shown).toMatch(/^Lastturn:1toolcall●read_file.*◆PreToolUsehook[^◆]*forread_file[^◆]*◆SessionEndhook[^◆]*◆SessionStarthook/);
  });

  // Task 12's spec review: /hooks's left-out rows follow a live edit too.
  it("lists on /hooks the hooks a live edit left out", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "tachi-home-"));
    onTestFinished(() => removeTree(home));
    const where = path.join(settingsDir(home), "settings.json");
    mkdirSync(settingsDir(home), { recursive: true });
    writeFileSync(where, "{}");
    const { app } = await mount([], { home, live: { loaded: { settings: {}, warnings: [] }, given: {} }, hooks: [] });
    const audit = { type: "command", command: "node", args: [path.join(home, "audit.js")], if: "Bash(*)" };
    writeFileSync(where, JSON.stringify({ hooks: { Notification: [{ hooks: [{ type: "command", command: "x" }] }], Stop: [{ hooks: [audit] }] } }));
    const warning = '"Notification" is not an event Tachikoma runs hooks at; its hooks were left out';
    const unchecked = '"Stop" has a hook with "if", which Tachikoma cannot check, so it was left out: ';
    await untilSlowly(() => squashed(app.lastFrame()!).includes(squashed(`settings.json: "hooks": ${unchecked}node ${audit.args[0]}`)));
    expect(squashed(app.lastFrame()!)).toContain(squashed(`settings.json: "hooks": ${warning}`));
    await type(app, "/hooks");
    // The user's choice, 2026-11-10, terminal checklist: the left-out row names the hook as /hooks does; the warning above
    // keeps its whole command.
    expect(app.lastFrame()).toContain(`No hooks in force. They go in "hooks" in ${shownFile()}.\nLeft out:\n  ${warning}\n  ${unchecked}node audit.js\n`);
  });
});

// Release 8c plan, Task 9 (choices 25 and 26): the MCP servers in the window. The servers are a stand-in for Servers'
// ready and waitingFor, so no process starts here; the launch's own are tested with fake servers in tests/cli.test.ts.
describe("App's MCP", () => {
  // `names` are still starting until go(); each wait the session makes is kept with its signal, which Esc stops.
  function starting(names: string[]) {
    const waits: AbortSignal[] = [];
    let left = names;
    const done: (() => void)[] = [];
    const servers: NonNullable<SessionOptions["servers"]> = {
      waitingFor: () => left,
      ready: (signal) =>
        new Promise<boolean>((resolve) => {
          waits.push(signal!);
          if (!left.length) return resolve(true);
          done.push(() => resolve(true));
          signal?.addEventListener("abort", () => resolve(false), { once: true });
        }),
    };
    const go = () => {
      left = [];
      for (const d of done.splice(0)) d();
    };
    return { servers, waits, go };
  }

  it("names the servers the first prompt waits for on the waiting line, and Esc sends it without them", async () => {
    const s = starting(["tradingview", "sanity"]);
    const lead = new Held();
    const { app } = await mount([], { lead, servers: s.servers });
    await type(app, "first");
    await until(app, "Waiting for MCP servers: tradingview, sanity... · ");
    expect(lead.asked).toHaveLength(0);
    await press(app, "\u001b");
    await waitFor(() => lead.asked.length === 1);
    expect(s.waits.map((w) => w.aborted)).toEqual([true]);
    await until(app, "Working · ");
    lead.answer("done");
    await until(app, "done");
    // Only the first prompt waits: the late servers' tools join a request once they are ready (design, "Starting and
    // stopping servers").
    await type(app, "second");
    await waitFor(() => lead.asked.length === 2);
    expect(s.waits).toHaveLength(1);
    lead.answer("done again");
    await until(app, "done again");
  });

  it("sends the first prompt once the servers have started", async () => {
    const s = starting(["tradingview"]);
    const lead = new Held();
    const { app } = await mount([], { lead, servers: s.servers });
    await type(app, "first");
    await until(app, "Waiting for MCP servers: tradingview... · ");
    s.go();
    await waitFor(() => lead.asked.length === 1);
    expect(s.waits.map((w) => w.aborted)).toEqual([false]);
    await until(app, "Working · ");
    lead.answer("done");
    await until(app, "done");
  });

  // Ctrl-C stops the turn as ever, the wait with it, so nothing is sent, and a prompt queued behind it comes back into the
  // prompt box, as Ctrl-C brings the queue back during any turn (keyRouting.ts). The stopped prompt itself does not, as
  // during SessionStart's wait (release 8b plan, Task 10).
  it("sends nothing when Ctrl-C stops the first prompt's wait, and gives back the prompt queued behind it", async () => {
    const s = starting(["tradingview"]);
    const lead = new Held();
    const { app, session } = await mount([], { lead, servers: s.servers });
    await type(app, "first");
    await until(app, "Waiting for MCP servers: tradingview... · ");
    await type(app, "second");
    await press(app, "\u0003");
    await gone(app, "Waiting for MCP servers");
    expect(s.waits.map((w) => w.aborted)).toEqual([true]);
    expect(lead.asked).toEqual([]);
    expect(session.messages).toEqual([]);
    expect(app.lastFrame()).toContain("› second");
  });

  // Choice 26: an MCP grey line is grey, a failure red, each line alone, as it names what failed, as a hook's is; both
  // escaped whole, as they carry what a server sent.
  it("says an MCP note in grey and an MCP failure in red, escaped", async () => {
    await inColour(async () => {
      const { app, bus } = await mount([]);
      bus.emit("mcp-note", "MCP server tv is ready: 3 tools.\u0007");
      const message = "MCP server tv failed to start: it exited with code 3: bad\u001b[2J";
      bus.emit("error", { kind: "mcp", attempted: "MCP server tv", message, lead: "fake:a" });
      await until(app, "failed to start");
      const frame = app.lastFrame()!;
      expect(frame).toContain("\u001b[90mMCP server tv is ready: 3 tools.\\u0007");
      expect(frame).toContain("\u001b[31m✗ MCP server tv failed to start: it exited with code 3: bad\\u001b[2J");
    });
  });

  // Release 8c plan, Task 10: /mcp and its actions, and live edits of "mcpServers", on real Servers running the fake
  // servers of tests/mcp/fake.ts in a folder of the test's own.
  const DOWN = "\u001b[B";
  const HEADING = `MCP servers, from ${shownFile()} and .mcp.json:`;
  const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object" } });
  // A long line wraps, and Ink can carry the space it broke at onto the next row.
  const flat = (app: ReturnType<typeof render>) => app.lastFrame()!.replaceAll(/ *\n */g, " ");
  // A wait on another process: a few seconds for a busy machine, well inside the test's 15 s.
  const soon = (check: () => void) => vi.waitFor(check, { timeout: 5_000 });
  const shows = (app: ReturnType<typeof render>, text: string) => soon(() => expect(app.lastFrame()).toContain(text));

  // The test's folder, the project's root; `config` names a server running a fake with `fake`'s options; `servers` makes
  // the mount's Servers, each stopped before the folder is removed, as on Windows a running server holds the folder it
  // works in.
  async function mcpSetup() {
    const dir = await mkdtemp(path.join(tmpdir(), "tachi-app-mcp-"));
    const made: Servers[] = [];
    onTestFinished(async () => {
      await Promise.all(made.map((s) => s.stopAll()));
      await removeTree(dir);
    });
    const config = async (name: string, fake: FakeOptions = {}, over: Partial<ServerConfig> = {}): Promise<ServerConfig> => {
      const entry = { kind: "stdio" as const, command: process.execPath, args: [await fakeServer(dir, fake)], env: {} };
      return { name, safe: name, where: "user", trusted: null, trustedTools: [], alwaysLoad: false, written: "", entry, asWritten: entry, ...over };
    };
    const servers =
      (
        configs: ServerConfig[],
        opts: { answers?: () => Answers; network?: "on" | "off" | "none"; auth?: AuthStore; openBrowser?: (url: string) => void } = {},
      ) =>
      (bus: Bus) => {
        const { answers = launchAnswers, network = "none", ...signIn } = opts;
        const s = new Servers(configs, { root: dir, env: process.env, bus, answers, network, lead: () => "fake:a", ...signIn });
        made.push(s);
        return { servers: s };
      };
    // A settings file in a home of the test's own, holding `file`, read as the launch reads it, for the App to watch.
    const settings = (file: object) => {
      const home = mkdtempSync(path.join(tmpdir(), "tachi-home-"));
      onTestFinished(() => removeTree(home));
      const where = path.join(settingsDir(home), "settings.json");
      mkdirSync(settingsDir(home), { recursive: true });
      writeFileSync(where, JSON.stringify(file));
      const loaded = readSettings(JSON.stringify(file)) as { settings: Settings; warnings: string[] };
      return { home, where, live: { loaded, given: {} }, configs: loaded.settings.mcpServers ?? [] };
    };
    return { dir, config, servers, settings };
  }
  const states = (servers: Servers) => servers.list().map((s) => `${s.name} ${s.state.is}`);

  // "Lines this plan adds": the heading, then a row each, as the design draws them; Enter shows the actions that apply,
  // Esc goes back, then closes (choice 27).
  it("lists each server on /mcp in a row of its own, with its state, the project's mark and its trust", async () => {
    const { config, servers } = await mcpSetup();
    const answers = launchAnswers();
    answers.set("nope", "w-nope", false);
    const configs = [
      await config("ready", { tools: [tool("one"), tool("two")] }, { trusted: "read-only" }),
      await config("some", { tools: [tool("one")] }, { trustedTools: ["one", "two"] }),
      await config("slow", { silent: true }),
      await config("gone", {}, { entry: { kind: "stdio", command: "tachi-test-no-such-program", args: [], env: {} } }),
      await config("ends"),
      await config("asks", {}, { where: "project", written: "w-asks" }),
      await config("nope", {}, { where: "project", written: "w-nope" }),
    ];
    const { app, mcp } = await mount([], { mcp: servers(configs, { answers: () => answers }) });
    const s = mcp!.servers;
    await soon(() => expect(states(s).slice(0, 5)).toEqual(["ready ready", "some ready", "slow starting", "gone failed", "ends ready"]));
    await s.server("ends")!.callTool("exit", { code: 3 }, {}).catch(() => {});
    await shows(app, "MCP server ends stopped: it exited with code 3; reconnect it from /mcp.");
    await type(app, "/mcp");
    await shows(app, HEADING);
    expect(app.lastFrame()).toContain(
      [
        HEADING,
        "ready · 2 tools · trusted",
        "some · 1 tool · 2 trusted tools",
        "slow · starting",
        "gone · failed: tachi-test-no-such-program was not found on PATH",
        "ends · stopped: it exited with code 3",
        "asks (project) · waiting for your yes",
        "nope (project) · you said no",
        "↑↓ move · Enter opens · Esc closes", // choice 51's hint, as /resume's list ends
      ].join("\n"),
    );
    // A ready server's actions, with their own hint; Esc goes back to the list.
    await press(app, "\r");
    await shows(app, "ready · 2 tools · trusted\nReconnect\nShow tools\n↑↓ move · Enter runs · Esc back\n");
    expect(app.lastFrame()).not.toContain(HEADING);
    await press(app, "\u001b");
    await shows(app, `${HEADING}\nready`);
    // A failed server and a stopped one can be reconnected; their tools are not offered, so there are none to show.
    await press(app, DOWN, DOWN, DOWN, "\r");
    await shows(app, "gone · failed: tachi-test-no-such-program was not found on PATH\nReconnect\n");
    expect(app.lastFrame()).not.toContain("Show tools");
    await press(app, "\u001b", DOWN, "\r");
    await shows(app, "ends · stopped: it exited with code 3\nReconnect\n");
    // A project's server without an answer has nothing to do yet; one answered has its answer to reset.
    await press(app, "\u001b", DOWN, "\r");
    await shows(app, `${HEADING}\n`);
    expect(app.lastFrame()).toContain("asks (project) · waiting for your yes");
    await press(app, DOWN, "\r");
    await shows(app, "nope (project) · you said no\nReset my answer\n");
    // Esc twice: back to the list, then the list closes and the prompt is back.
    await press(app, "\u001b", "\u001b");
    await gone(app, HEADING);
    expect(app.lastFrame()).toContain("›");
  });

  it("shows a server the sandbox's network keeps off, its name escaped, and the rows Task 11 reaches", async () => {
    const { config, servers } = await mcpSetup();
    const { app } = await mount([], { mcp: servers([await config("far\u0007")], { network: "off" }) });
    await type(app, "/mcp");
    await shows(app, `${HEADING}\nfar\\u0007 · off: the sandbox's network is off`);
    // Its row's words; Task 11's tests below reach the state on a real server.
    const row = { name: "om", where: "user" as const, state: { is: "needs sign-in" as const }, trusted: null, trustedTools: [], tools: 0 };
    expect(mcpRow(row)).toBe("om · needs sign-in");
  });

  it("says where servers go on /mcp when there are none, and that /mcp takes nothing after it", async () => {
    const { app } = await mount([]);
    await type(app, "/mcp");
    await until(app, `No MCP servers. They go in "mcpServers" in ${shownFile()}, or in a project's .mcp.json.`);
    await type(app, "/mcp now");
    await until(app, "/mcp takes nothing after it.");
  });

  // Reconnect stops the server and starts it again, its connection number raised (design, finding 4), and the list shows
  // it as it starts and once it is ready.
  it("reconnects a stopped server from /mcp, its connection number raised, and goes back to the list", async () => {
    const { config, servers } = await mcpSetup();
    const { app, mcp } = await mount([], { mcp: servers([await config("ends", { tools: [tool("one")] })]) });
    const s = mcp!.servers;
    await soon(() => expect(states(s)).toEqual(["ends ready"]));
    const server = s.server("ends")!;
    expect(server.connection).toBe(1);
    await server.callTool("exit", { code: 3 }, {}).catch(() => {});
    await shows(app, "reconnect it from /mcp.");
    await type(app, "/mcp");
    await shows(app, `${HEADING}\nends · stopped: it exited with code 3`);
    await press(app, "\r");
    await shows(app, "ends · stopped: it exited with code 3\nReconnect\n");
    await press(app, "\r");
    await shows(app, `${HEADING}\nends · 1 tool`);
    expect(server.connection).toBe(2);
    expect(s.server("ends")).toBe(server);
    await press(app, "\u001b");
    await gone(app, HEADING);
  });

  it("draws /mcp's list and a server's actions in full screen, above the status line", async () => {
    const { config, servers } = await mcpSetup();
    const { app, mcp } = await mount([], { full: true, mcp: servers([await config("s", { tools: [tool("one")] })]) });
    await soon(() => expect(states(mcp!.servers)).toEqual(["s ready"]));
    await type(app, "/mcp");
    await shows(app, `${HEADING}\ns · 1 tool\n`);
    expect(app.lastFrame()).toMatch(/s · 1 tool\n↑↓ move · Enter opens · Esc closes\n.*lead fake:a/);
    await press(app, "\r");
    await shows(app, "s · 1 tool\nReconnect\nShow tools\n↑↓ move · Enter runs · Esc back\n");
    await press(app, "\u001b", "\u001b");
    await gone(app, HEADING);
  });

  // Show tools prints the server's tools into the conversation, as /hooks prints its list, the ones left out after them in
  // the name lines' words (choice 27).
  it("prints a server's tools on Show tools, and the ones left out", async () => {
    const { config, servers } = await mcpSetup();
    const { app, mcp } = await mount([], { mcp: servers([await config("s", { tools: [tool("foo.bar"), tool("foo_bar"), tool("plain")] })]) });
    await soon(() => expect(states(mcp!.servers)).toEqual(["s ready"]));
    await type(app, "/mcp");
    await shows(app, `${HEADING}\ns · 2 tools`);
    await press(app, "\r", DOWN, "\r");
    await gone(app, HEADING);
    expect(app.lastFrame()).toContain(
      ["s's tools:", "  mcp__s__foo_bar", "  mcp__s__plain", "Left out:", '  "foo_bar" was left out: its name mcp__s__foo_bar is already s\'s "foo.bar"'].join("\n"),
    );
  });

  // Choice 24: the reset is a line in the project's answers file, so the next launch asks again; this launch's server runs on.
  it("resets a project server's answer on Reset my answer, with its line, so the next launch asks again", async () => {
    const { dir, config, servers } = await mcpSetup();
    const data = path.join(dir, "data", "tachi");
    const c = await config("proj", {}, { where: "project", written: "w1" });
    answersFor(dir, data).set("proj", "w1", true);
    const { app, mcp } = await mount([], { mcp: servers([c], { answers: () => answersFor(dir, data) }) });
    await soon(() => expect(states(mcp!.servers)).toEqual(["proj ready"]));
    await type(app, "/mcp");
    await shows(app, `${HEADING}\nproj (project) · 10 tools`);
    await press(app, "\r");
    await shows(app, "proj (project) · 10 tools\nReconnect\nShow tools\nReset my answer\n");
    await press(app, DOWN, DOWN, "\r");
    await shows(app, "Your answer for proj was reset; Tachikoma asks again at the next launch.");
    expect(app.lastFrame()).not.toContain(HEADING);
    expect(states(mcp!.servers)).toEqual(["proj ready"]);
    const asked: string[] = [];
    await askServers([c], () => answersFor(dir, data), async (q) => (asked.push(q), false), () => {});
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^Start the MCP server "proj" from this project's \.mcp\.json: /);
  });

  // Choice 52: the answer is forgotten only once the reset line is written. The answers folder is moved aside and a file
  // the test makes put in its place, so the write fails; the answer holds, here and in the file, and Reset is still offered.
  it("keeps a project server's answer when its reset cannot be written, and says the next launch still uses it", async () => {
    const { dir, config, servers } = await mcpSetup();
    const data = path.join(dir, "data", "tachi");
    const c = await config("proj", {}, { where: "project", written: "w1" });
    answersFor(dir, data).set("proj", "w1", true);
    const folder = path.dirname(projectFile("mcp-answers", dir, data));
    const { app, mcp } = await mount([], { mcp: servers([c], { answers: () => answersFor(dir, data) }) });
    await soon(() => expect(states(mcp!.servers)).toEqual(["proj ready"]));
    renameSync(folder, `${folder}-aside`);
    writeFileSync(folder, "");
    await type(app, "/mcp");
    await press(app, "\r", DOWN, DOWN, "\r");
    await soon(() => expect(flat(app)).toMatch(/Your answer for proj could not be reset \(.+\); the next launch still uses it\./));
    expect(mcp!.servers.answered("proj")).toBe(true);
    await type(app, "/mcp");
    await press(app, "\r");
    await shows(app, "Reconnect\nShow tools\nReset my answer\n");
    await press(app, "\u001b", "\u001b");
    unlinkSync(folder);
    renameSync(`${folder}-aside`, folder);
    expect(answersFor(dir, data).get("proj", "w1")).toBe(true);
  });

  // The list draws a server's state as it changes, with no key pressed: here a start the test lets finish.
  it("redraws /mcp's list when a server's state changes", async () => {
    const { dir, config, servers } = await mcpSetup();
    const gate = path.join(dir, "gate");
    // Looked for every 20 ms: a test's own pause, short beside the wait for a process (as tests/mcp/servers.test.ts's).
    const start = `const fs = require("node:fs"); const pause = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(${JSON.stringify(gate)})) Atomics.wait(pause, 0, 0, 20);`;
    const { app } = await mount([], { mcp: servers([await config("s", { start, tools: [tool("one")] })]) });
    await type(app, "/mcp");
    await shows(app, `${HEADING}\ns · starting\n`);
    await writeFile(gate, "");
    await shows(app, `${HEADING}\ns · 1 tool\n`);
  });

  // Release 8c plan, Task 5's set(): an entry the edit changed restarts, a new one starts, a removed one stops, the others
  // untouched; a broken file keeps the servers in force (release 6 design, "Live edits").
  it("restarts only the server a live edit changed, with the line, and keeps the servers when the file breaks", async () => {
    const { dir, servers, settings } = await mcpSetup();
    const script = await fakeServer(dir, { tools: [tool("one")] });
    const entry = (...args: string[]) => ({ command: process.execPath, args: [script, ...args] });
    const { home, where, live, configs } = settings({ mcpServers: { a: entry(), b: entry(), c: entry() } });
    const { app, mcp } = await mount([], { home, live, mcp: servers(configs) });
    const s = mcp!.servers;
    await soon(() => expect(states(s)).toEqual(["a ready", "b ready", "c ready"]));
    const [a, b] = [s.server("a"), s.server("b")];
    writeFileSync(where, JSON.stringify({ mcpServers: { a: entry("again"), b: entry(), d: entry() } }));
    await soon(() => expect(flat(app)).toContain("MCP servers changed: a restarted, d added, c removed."));
    await soon(() => expect(states(s)).toEqual(["a ready", "b ready", "d ready"]));
    expect(s.server("a")).not.toBe(a);
    expect(s.server("b")).toBe(b);
    expect(b!.connection).toBe(1);
    writeFileSync(where, "{");
    await soon(() => expect(flat(app)).toContain("the last good settings still apply"));
    expect(states(s)).toEqual(["a ready", "b ready", "d ready"]);
  });

  // Choice 16: trust is read when the gate would decide, so a live edit that removes it takes effect at the next call,
  // which is asked; the server is not restarted, and no line says a server changed.
  it("asks at the next call once a live edit removes a server's trust, restarting nothing", async () => {
    const { dir, servers, settings } = await mcpSetup();
    const script = await fakeServer(dir);
    const file = (trusted: boolean) => ({ mcpServers: { s: { command: process.execPath, args: [script], alwaysLoad: true, ...(trusted && { trusted: "read-only" }) } } });
    const { home, where, live, configs } = settings(file(true));
    const turns = [callTool("c1", "mcp__s__echo", { text: "hi" }), reply("first answer"), callTool("c2", "mcp__s__echo", { text: "again" }), reply("second answer")];
    const { app, mcp } = await mount(turns, { home, live, mcp: servers(configs) });
    const s = mcp!.servers;
    await type(app, "go");
    await shows(app, "first answer");
    expect(app.lastFrame()).not.toContain("Allow s:");
    const server = s.server("s")!;
    writeFileSync(where, JSON.stringify(file(false)));
    await soon(() => expect(s.trust("s", "echo")).toBe(false));
    await type(app, "and again");
    await soon(() => expect(flat(app)).toContain('Allow s: echo {"text":"again"}?'));
    await press(app, "y");
    await shows(app, "second answer");
    expect(s.server("s")).toBe(server);
    expect(server.connection).toBe(1);
    expect(flat(app)).not.toContain("MCP servers changed");
  });

  // Release 8c plan, Task 11: Sign in and Sign out from /mcp, on the fake sign-in service of tests/mcp/fake.ts, the browser
  // a function of the test's own, the sign-ins kept in a data folder of the test's own.
  async function signInSetup() {
    const m = await mcpSetup();
    const fake = await signInFake();
    const opened: string[] = [];
    let browser: (u: string) => void = fake.browser;
    const url = fake.url;
    const config: ServerConfig = {
      name: "om", safe: "om", where: "user", trusted: null, trustedTools: [], alwaysLoad: false, written: "",
      entry: { kind: "http", url, headers: {} }, asWritten: { url },
    };
    const data = path.join(m.dir, "data", "tachi");
    const auth = new AuthStore(data);
    const mcp = m.servers([config], { auth, openBrowser: (u) => (opened.push(u), browser(u)) });
    const question = `Open your browser to sign in to om at ${new URL(fake.base).host}? [y/n]`;
    const waiting = (at: string) => `Waiting for the sign-in in your browser. If it did not open, go to: ${at}`;
    const lock = path.join(data, "mcp-auth.lock");
    return { fake, opened, mcp, question, waiting, lock, setBrowser: (b: (u: string) => void) => (browser = b) };
  }

  it("signs in from /mcp, asking before the browser opens, then signs out, each with its line", async () => {
    const t = await signInSetup();
    const { app, mcp } = await mount([], { mcp: t.mcp });
    const s = mcp!.servers;
    await soon(() => expect(states(s)).toEqual(["om needs sign-in"]));
    await type(app, "/mcp");
    await shows(app, `${HEADING}\nom · needs sign-in\n`);
    await press(app, "\r");
    await shows(app, "om · needs sign-in\nSign in\n↑↓ move");
    await press(app, "\r");
    await soon(() => expect(flat(app)).toContain(t.question));
    expect(t.opened).toEqual([]);
    await press(app, "y");
    await shows(app, "Signed in to om.");
    expect(flat(app)).toContain(t.waiting(t.opened[0]!));
    await soon(() => expect(states(s)).toEqual(["om ready"]));
    // Signed in, it offers Sign out, which forgets the sign-in, so the server needs it again.
    await type(app, "/mcp");
    await shows(app, `${HEADING}\nom · 1 tool\n`);
    await press(app, "\r");
    await shows(app, "om · 1 tool\nReconnect\nSign out\nShow tools\n");
    await press(app, DOWN, "\r");
    await shows(app, "Signed out of om.");
    expect(states(s)).toEqual(["om needs sign-in"]);
    expect(s.signedIn("om")).toBe(false);
  });

  // The service's own words when it refuses; Esc stops the wait and says nothing more, as the user stopped it.
  it("says why a sign-in failed, and stops waiting for the browser on Esc", async () => {
    const t = await signInSetup();
    t.setBrowser(t.fake.sendsBack({ error: "access_denied", error_description: "The user said no" }));
    const { app, mcp } = await mount([], { mcp: t.mcp });
    await soon(() => expect(states(mcp!.servers)).toEqual(["om needs sign-in"]));
    await type(app, "/mcp");
    await press(app, "\r", "\r");
    await soon(() => expect(flat(app)).toContain(t.question));
    await press(app, "y");
    await shows(app, "Sign-in to om failed: The user said no");
    // A client was registered before the question, but no tokens are kept, so there is nothing to sign out of (choice 58).
    await type(app, "/mcp");
    await press(app, "\r");
    await shows(app, "om · needs sign-in\nSign in\n↑↓ move");
    await press(app, "\u001b", "\u001b");
    await gone(app, HEADING);
    // A browser that never comes back.
    t.setBrowser(() => {});
    await type(app, "/mcp");
    await press(app, "\r", "\r");
    await soon(() => expect(flat(app)).toContain(t.question)); // the first one, answered, is gone from the prompt's place
    await press(app, "y");
    await soon(() => expect(flat(app)).toContain(t.waiting(t.opened[1]!)));
    await until(app, "Waiting for the browser · ");
    await press(app, "\u001b");
    await gone(app, "Waiting for the browser · ");
    expect(flat(app).split("Sign-in to om failed").length).toBe(2);
    expect(states(mcp!.servers)).toEqual(["om needs sign-in"]);
  });

  // Choice 56: a Sign out that cannot be written says so, and the sign-in stays. The test puts a folder of its own where
  // the sign-ins' lock file goes, so the change cannot take the lock.
  it("says a Sign out that cannot be written, and keeps the sign-in", async () => {
    const t = await signInSetup();
    const { app, mcp } = await mount([], { mcp: t.mcp });
    const s = mcp!.servers;
    await soon(() => expect(states(s)).toEqual(["om needs sign-in"]));
    await type(app, "/mcp");
    await press(app, "\r", "\r");
    await soon(() => expect(flat(app)).toContain(t.question));
    await press(app, "y");
    await shows(app, "Signed in to om.");
    await soon(() => expect(states(s)).toEqual(["om ready"]));
    mkdirSync(t.lock);
    try {
      await type(app, "/mcp");
      await press(app, "\r", DOWN, "\r");
      await soon(() => expect(flat(app)).toMatch(/Sign-out of om failed: .+/));
      expect(s.signedIn("om")).toBe(true);
      expect(states(s)).toEqual(["om ready"]);
    } finally {
      rmSync(t.lock, { recursive: true }); // the empty folder the test made
    }
  });

  // Release 8c plan, Task 12: a server's forms in the window. The fake's `ask` tool sends the form and answers with the
  // client's answer as its text, which the model reads as the tool's result. The server is trusted, so the call asks
  // nothing, and loaded upfront, so the model can call it at once.
  const FORM = {
    type: "object",
    properties: {
      name: { type: "string", title: "Name" },
      age: { type: "integer", title: "Age", description: "In years" },
      size: { type: "string", title: "Size", enum: ["s", "m"], enumNames: ["Small", "Medium"] },
      tea: { type: "boolean", title: "Tea" },
    },
    required: ["name", "age", "size"],
  };
  const asking = (params: object) => [callTool("c1", "mcp__s__ask", { method: "elicitation/create", params }), reply("answered")];
  const formOf = (requestedSchema: object = FORM, message = "About you") => ({ mode: "form", message, requestedSchema });
  const trusted = { trusted: "read-only" as const, alwaysLoad: true };
  const answerOf = (session: Session) => {
    const result = session.messages.flatMap((m) => m.parts).find((p) => p.type === "tool_result");
    return result && JSON.parse(result.output);
  };

  it("asks a server's form field by field in the prompt's place, says a wrong number and a missing field, and the server gets the values", async () => {
    const { config, servers } = await mcpSetup();
    const { app, session, mcp } = await mount(asking(formOf()), { mcp: servers([await config("s", {}, trusted)]) });
    await soon(() => expect(states(mcp!.servers)).toEqual(["s ready"]));
    await type(app, "go");
    await shows(app, "s asks: About you");
    await shows(app, "Name:"); // a line's trailing spaces are not in the frame
    await press(app, "\r");
    await shows(app, "This field is needed; type an answer, or Esc to decline the form.");
    await type(app, "Ada");
    await shows(app, "Name: Ada");
    // The field's description is the server's grey note above its question.
    await shows(app, "In years\nAge (a number):");
    expect(app.lastFrame()).not.toContain("Enter answers");
    await type(app, "x");
    await shows(app, "That is not a number; type one, or Esc to decline the form.");
    expect(app.lastFrame()).toContain("Age (a number): x");
    await press(app, "\u007f", "3", "6", "\r");
    await shows(app, "Age (a number): 36");
    // A pick is a menu of the server's labels under its question.
    await shows(app, "Size:\n  Small\n  Medium");
    // A pick of one has its hint row, as /mcp's lists end (choice 51), without Space's part; a typed field has none.
    await shows(app, "  Medium\n↑↓ move · Enter answers · Esc declines the form\n");
    await press(app, DOWN, "\r");
    await shows(app, "Size: Medium");
    await press(app, "\r"); // an empty optional field is left out
    await shows(app, "answered");
    expect(app.lastFrame()).toContain("Tea (yes or no) (optional):");
    expect(answerOf(session)).toEqual({ action: "accept", content: { name: "Ada", age: 36, size: "m" } });
    expect(app.lastFrame()).toContain("›");
  });

  it("declines a server's form on Esc, with its line, and shows what the server wrote escaped", async () => {
    const { config, servers } = await mcpSetup();
    const schema = { type: "object", properties: { name: { type: "string", title: "N\u0007" } } };
    const { app, session, mcp } = await mount(asking(formOf(schema, "Hi\u001b[2J")), { mcp: servers([await config("s", {}, trusted)]) });
    await soon(() => expect(states(mcp!.servers)).toEqual(["s ready"]));
    await type(app, "go");
    await shows(app, "s asks: Hi\\u001b[2J");
    await shows(app, "N\\u0007 (optional):");
    await press(app, "\u001b");
    await shows(app, "You declined s's form.");
    await shows(app, "answered");
    expect(answerOf(session)).toEqual({ action: "decline" });
  });

  it("draws a form's pick in full screen above the status line, the picks of several marked with Space", async () => {
    const { config, servers } = await mcpSetup();
    const items = { anyOf: [{ const: "c", title: "Cheese" }, { const: "h", title: "Ham" }] };
    const schema = { type: "object", properties: { tops: { type: "array", title: "Tops", items } } };
    const { app, session, mcp } = await mount(asking(formOf(schema)), { full: true, mcp: servers([await config("s", {}, trusted)]) });
    await soon(() => expect(states(mcp!.servers)).toEqual(["s ready"]));
    await type(app, "go");
    // A pick of several names Space too, in its hint row under the menu.
    await shows(app, "Tops (optional):\n  Cheese\n  Ham\n↑↓ move · Space marks · Enter answers · Esc declines the form\n");
    expect(app.lastFrame()).toMatch(/Esc declines the form\n.*lead fake:a/);
    await press(app, " ", DOWN, " ");
    await shows(app, "Tops (optional): Cheese, Ham");
    await press(app, "\r");
    await shows(app, "answered");
    expect(answerOf(session)).toEqual({ action: "accept", content: { tops: ["c", "h"] } });
  });

  it("takes an Elicitation hook's answer and shows no form", async () => {
    const { dir, config, servers } = await mcpSetup();
    const script = path.join(dir, "hook.cjs");
    const accept = { hookSpecificOutput: { hookEventName: "Elicitation", action: "accept", content: { name: "Hook" } } };
    writeFileSync(script, `process.stdin.resume().on("end", () => process.stdout.write(${JSON.stringify(JSON.stringify(accept))}));`);
    const hooks: Hook[] = [{ event: "Elicitation", matcher: { names: ["s"] }, command: process.execPath, args: [script], async: false, where: "" }];
    const { app, session, mcp } = await mount(asking(formOf()), { hooks, mcp: servers([await config("s", {}, trusted)]) });
    await soon(() => expect(states(mcp!.servers)).toEqual(["s ready"]));
    await type(app, "go");
    await shows(app, "answered");
    expect(answerOf(session)).toEqual({ action: "accept", content: { name: "Hook" } });
    expect(flat(app)).not.toContain("asks:");
  });

  // An optional pick of one with no default starts with nothing marked, so it can be left out: Space marks one, at most
  // one, and its hint names Space as a pick of several's does (Task 12's quality review).
  it("lets an optional pick of one be left out, Space marking at most one", async () => {
    const { config, servers } = await mcpSetup();
    const pick = (title: string) => ({ type: "string", title, enum: ["s", "m"], enumNames: ["Small", "Medium"] });
    const schema = { type: "object", properties: { a: pick("A"), b: pick("B") } };
    const { app, session, mcp } = await mount(asking(formOf(schema)), { mcp: servers([await config("s", {}, trusted)]) });
    await soon(() => expect(states(mcp!.servers)).toEqual(["s ready"]));
    await type(app, "go");
    await shows(app, "A (optional):\n  Small\n  Medium\n↑↓ move · Space marks · Enter answers · Esc declines the form\n");
    await press(app, " ", DOWN, " ");
    await shows(app, "A (optional): Medium\n");
    await press(app, "\r");
    await shows(app, "B (optional):\n");
    await press(app, "\r");
    await shows(app, "answered");
    expect(answerOf(session)).toEqual({ action: "accept", content: { a: "m" } });
  });

  // Typed text and Enter in one read of the terminal, as a fast typist or a paste of a line sends them (ModelPicker.tsx).
  it("takes text and Enter in one read as the field's answer", async () => {
    const { config, servers } = await mcpSetup();
    const schema = { type: "object", properties: { name: { type: "string", title: "Name" } } };
    const { app, session, mcp } = await mount(asking(formOf(schema)), { mcp: servers([await config("s", {}, trusted)]) });
    await soon(() => expect(states(mcp!.servers)).toEqual(["s ready"]));
    await type(app, "go");
    await shows(app, "Name (optional):");
    await press(app, "Bob\r");
    await shows(app, "answered");
    expect(answerOf(session)).toEqual({ action: "accept", content: { name: "Bob" } });
  });

  // A subagent's stop ends its form: the field goes, and the prompt is back.
  it("takes a subagent's form's field away when the subagent stops, and the prompt comes back", async () => {
    const { config, servers } = await mcpSetup();
    const { app, mcp } = await mount([], { mcp: servers([await config("s")]) });
    await soon(() => expect(states(mcp!.servers)).toEqual(["s ready"]));
    const stop = new AbortController();
    const owner: Owner = { name: "t1 (look around)", signal: stop.signal, stop: () => stop.abort() };
    const asking = mcp!.servers.server("s")!.callTool("ask", { method: "elicitation/create", params: formOf() }, { owner });
    await shows(app, "t1: s asks: About you");
    await shows(app, "Name:");
    expect(app.lastFrame()).not.toContain("›");
    stop.abort();
    await shows(app, "›");
    expect(app.lastFrame()).not.toContain("Name:");
    const r = await asking;
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ action: "cancel" });
  });

  // A subagent's visit question is the subagent's: Ctrl-C stops it, not the lead's turn, and its stop takes the question
  // away; the question reads as the form's heading does, its id first (Task 12's re-check).
  it("stops the subagent, not the lead's turn, on Ctrl-C at its visit question, and takes the question away when it stops", async () => {
    const { config, servers } = await mcpSetup();
    const lead = new Held();
    const { app, mcp } = await mount([], { lead, mcp: servers([await config("s")]) });
    await soon(() => expect(states(mcp!.servers)).toEqual(["s ready"]));
    await type(app, "go");
    await waitFor(() => lead.asked.length === 1);
    const visit = { mode: "url", message: "Sign there", elicitationId: "e1", url: "https://example.com/x" };
    const subagent = () => {
      const stop = new AbortController();
      const owner: Owner = { name: "t1 (look around)", signal: stop.signal, stop: () => stop.abort() };
      const asked = mcp!.servers.server("s")!.callTool("ask", { method: "elicitation/create", params: visit }, { owner });
      return { stop, answer: async () => JSON.parse(((await asked).content[0] as { text: string }).text) };
    };
    const question = "t1: s asks you to open https://example.com/x in your browser: Sign there. Open it? [y/n]";
    const first = subagent();
    await soon(() => expect(flat(app)).toContain(question));
    await press(app, "\u0003");
    expect(first.stop.signal.aborted).toBe(true);
    expect(await first.answer()).toEqual({ action: "cancel" });
    await until(app, "Working · "); // the lead's turn goes on
    const second = subagent();
    await soon(() => expect(flat(app)).toContain(question));
    second.stop.abort();
    await soon(() => expect(flat(app)).not.toContain(question));
    expect(await second.answer()).toEqual({ action: "cancel" });
    lead.answer("done");
    await until(app, "done");
  });

  it("asks before opening the browser for a server's visit request, and opens it on yes", async () => {
    const { config, servers } = await mcpSetup();
    const opened: string[] = [];
    const visit = { mode: "url", message: "Sign there", elicitationId: "e1", url: "https://example.com/x" };
    const s = servers([await config("s", {}, trusted)], { openBrowser: (u) => void opened.push(u) });
    const { app, session, mcp } = await mount(asking(visit), { mcp: s });
    await soon(() => expect(states(mcp!.servers)).toEqual(["s ready"]));
    await type(app, "go");
    await soon(() => expect(flat(app)).toContain("s asks you to open https://example.com/x in your browser: Sign there. Open it? [y/n]"));
    expect(opened).toEqual([]);
    await press(app, "y");
    await shows(app, "answered");
    expect(opened).toEqual(["https://example.com/x"]);
    expect(answerOf(session)).toEqual({ action: "accept" });
  });

  // Release 8c plan, Task 13: a server's resources through `@` and its prompts as `/` commands (choices 30, 31), what they
  // supply sent after the typed words, marked the server's (choice 34).
  const NOTE = { uri: "note://a", name: "a note", text: "the note's text" };
  const GREET = {
    name: "greet",
    description: "Greets someone\nat length",
    arguments: [{ name: "name", required: true }],
    messages: [{ role: "user", content: { type: "text", text: "Say hello to {name}." } }],
  };
  const BACK = "Your words are back in the prompt box.";
  const lastSent = (lead: FakeProvider, i = 0) => lead.seen[i]!.at(-1)!.parts;
  // A red line may wrap: its words looked for without colours or line breaks.
  const plain = (app: ReturnType<typeof render>) => stripVTControlCharacters(flat(app));

  it("lists a server's resources after the files on @, by prefix, and again once its list changes", async () => {
    const { config, servers } = await mcpSetup();
    const { app, ctx, mcp } = await mount([], { mcp: servers([await config("fake", { resources: [NOTE] })]) });
    await soon(() => expect(states(mcp!.servers)).toEqual(["fake ready"]));
    await writeFile(path.join(ctx.root, "notes.txt"), "");
    await press(app, "@");
    await shows(app, "  @fake:note://a\n");
    const frame = app.lastFrame()!;
    expect(frame).toContain("  notes.txt\n");
    expect(frame.indexOf("  notes.txt\n")).toBeLessThan(frame.indexOf("  @fake:note://a\n"));
    // A uri's slashes make what is typed a folder that cannot be listed, which says nothing while a resource matches.
    await press(app, "fake:note:/");
    await shows(app, "› @fake:note:/\n  @fake:note://a\n");
    expect(app.lastFrame()).not.toContain("notes.txt");
    expect(app.lastFrame()).not.toContain("Cannot list");
    await mcp!.servers.server("fake")!.callTool("add-resource", { resource: { uri: "note://b", name: "b" } }, {});
    // The library waits 300 ms for more changes before it reads the list again (its debounceMs); a key draws it.
    await soon(() => expect(mcp!.servers.server("fake")!.resources).toHaveLength(2));
    await press(app, "/");
    await shows(app, "› @fake:note://\n  @fake:note://a\n  @fake:note://b\n");
  });

  it("sends a picked resource's text after the typed words, as the server's, and shows the prompt as typed", async () => {
    const { config, servers } = await mcpSetup();
    const lead = new FakeProvider("a", [reply("summarised")]);
    const { app, mcp } = await mount([], { lead, mcp: servers([await config("fake", { resources: [NOTE] })]) });
    await soon(() => expect(states(mcp!.servers)).toEqual(["fake ready"]));
    await press(app, "@fa", "\t");
    expect(app.lastFrame()).toContain("› @fake:note://a\n"); // the space after it is there, though not drawn
    await type(app, "summarise");
    await shows(app, "summarised");
    expect(lastSent(lead)).toEqual([
      { type: "text", text: "@fake:note://a summarise" },
      { type: "text", text: "Resource @fake:note://a:\nthe note's text", from: "server" },
    ]);
    expect(app.lastFrame()).toContain("> @fake:note://a summarise\n");
    expect(app.lastFrame()).not.toContain("the note's text");
  });

  // A resource's picture is numbered as a pasted one, and drawn as a tool's is; a prompt's assistant message is headed
  // `(assistant)` (choice 31).
  it("sends a resource's picture, numbered as a pasted one, and heads a prompt's assistant message", async () => {
    const { config, servers } = await mcpSetup();
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const lead = new FakeProvider("a", [reply("seen"), reply("talked")]);
    const fake = {
      resources: [{ uri: "pic://dot", name: "dot", blob: png, mimeType: "image/png" }],
      prompts: [{ name: "talk", messages: [{ role: "user", content: { type: "text", text: "Hi." } }, { role: "assistant", content: { type: "text", text: "Hello." } }] }],
    };
    const { app, mcp } = await mount([], { lead, mcp: servers([await config("fake", fake)]) });
    await soon(() => expect(states(mcp!.servers)).toEqual(["fake ready"]));
    await type(app, "look at @fake:pic://dot now");
    await shows(app, "seen");
    const data = expect.anything(); // the stand-in keeps a copy of each request, its Buffer a Uint8Array
    expect(lastSent(lead)).toEqual([
      { type: "text", text: "look at @fake:pic://dot now" },
      { type: "text", text: "Resource @fake:pic://dot:", from: "server" },
      { type: "image", id: 1, mediaType: "image/png", data, from: "server" },
    ]);
    expect(app.lastFrame()).toContain("> look at @fake:pic://dot now\n  ⎿ [Image #1]\n");
    await type(app, "/fake:talk");
    await shows(app, "talked");
    expect(lastSent(lead, 1)).toEqual([
      { type: "text", text: "/fake:talk" },
      { type: "text", text: "Hi.", from: "server" },
      { type: "text", text: "(assistant)\nHello.", from: "server" },
    ]);
  });

  it("says in red that a picked resource could not be read, sends nothing, and keeps the words in the prompt box", async () => {
    await inColour(async () => {
      const { config, servers } = await mcpSetup();
      const lead = new FakeProvider("a", [reply("never")]);
      const { app, mcp } = await mount([], { lead, mcp: servers([await config("fake", { resources: [{ ...NOTE, fails: "it is gone" }] })]) });
      await soon(() => expect(states(mcp!.servers)).toEqual(["fake ready"]));
      await type(app, "read @fake:note://a please");
      await soon(() => expect(plain(app)).toContain(BACK));
      expect(app.lastFrame()).toContain("\u001b[31mCould not read @fake:note://a: ");
      expect(plain(app)).toContain("Could not read @fake:note://a: it is gone. Your words are back in the prompt box.");
      expect(plain(app).split(BACK)).toHaveLength(2); // said once, by the red line
      expect(app.lastFrame()).toContain("› read @fake:note://a please");
      expect(lead.seen).toEqual([]);
    });
  });

  it("lists a server's prompts in the / menu with their description, and /fake:greet Ann fills name and sends the prompt's text", async () => {
    const { config, servers } = await mcpSetup();
    const lead = new FakeProvider("a", [reply("greeted")]);
    const { app, mcp } = await mount([], { lead, mcp: servers([await config("fake", { prompts: [GREET] })]) });
    await soon(() => expect(states(mcp!.servers)).toEqual(["fake ready"]));
    await press(app, "/fa");
    await shows(app, "› /fa\n  /fake:greet  Greets someone\n"); // the description's first line
    await press(app, "\t", "Ann", "\r");
    await shows(app, "greeted");
    expect(lastSent(lead)).toEqual([
      { type: "text", text: "/fake:greet Ann" },
      { type: "text", text: "Say hello to Ann.", from: "server" },
    ]);
    expect(app.lastFrame()).toContain("> /fake:greet Ann\n");
  });

  // The fix round: the check is made once the prompt is let through, so its words come back, with the grey line saying so.
  it("says in red which argument a prompt needs, sending nothing, and gives the words back", async () => {
    await inColour(async () => {
      const { config, servers } = await mcpSetup();
      const lead = new FakeProvider("a", [reply("never")]);
      const { app, mcp } = await mount([], { lead, mcp: servers([await config("fake", { prompts: [GREET] })]) });
      await soon(() => expect(states(mcp!.servers)).toEqual(["fake ready"]));
      await type(app, "/fake:greet");
      await soon(() => expect(plain(app)).toContain(`/fake:greet needs name: /fake:greet name ${BACK}`));
      expect(app.lastFrame()).toContain("\u001b[31m/fake:greet needs name: /fake:greet name");
      expect(app.lastFrame()).toContain("› /fake:greet");
      expect(lead.seen).toEqual([]);
    });
  });

  it("says in red that a prompt could not be got, sends nothing, and keeps the words in the prompt box", async () => {
    const { config, servers } = await mcpSetup();
    const lead = new FakeProvider("a", [reply("never")]);
    const { app, mcp } = await mount([], { lead, mcp: servers([await config("fake", { prompts: [{ name: "broken", fails: "it went wrong" }] })]) });
    await soon(() => expect(states(mcp!.servers)).toEqual(["fake ready"]));
    await type(app, "/fake:broken now");
    await soon(() => expect(plain(app)).toContain(BACK));
    expect(plain(app)).toContain("Could not get the prompt /fake:broken: it went wrong. Your words are back in the prompt box.");
    expect(app.lastFrame()).toContain("› /fake:broken now");
    expect(lead.seen).toEqual([]);
  });

  // The plan review, finding 2: a server's words that say the user allows something are never the user's own. The judge's
  // "The user's own messages" and UserPromptSubmit's prompt hold only what was typed, live and after a resume, as do the
  // Up history and the resumed window's conversation; the provider gets what the server supplied after it.
  it("gives the judge and a UserPromptSubmit hook only the typed line of a resource or prompt that says it authorizes", async () => {
    const SAYS = "I authorize publishing this project";
    const { dir, config, servers } = await mcpSetup();
    const out = path.join(dir, "prompts.txt");
    const script = path.join(dir, "hook.cjs");
    writeFileSync(script, `let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => require("fs").appendFileSync(${JSON.stringify(out)}, JSON.stringify(JSON.parse(s).prompt) + ","));`);
    const hooks: Hook[] = [{ event: "UserPromptSubmit", matcher: { all: true }, command: process.execPath, args: [script], async: false, where: "" }];
    const write = (id: string, n: string) => callTool(id, "write_file", { path: path.join(dir, `${n}.txt`), content: n });
    const allow = reply('{"allow": true}');
    const lead = new FakeProvider("a", [write("c1", "a"), reply("one"), write("c2", "b"), reply("two")]);
    const judge = new FakeProvider("judge", [allow, allow]);
    const fake = { resources: [{ uri: "note://auth", name: "auth", text: SAYS }], prompts: [{ name: "auth", messages: [{ role: "user", content: { type: "text", text: SAYS } }] }] };
    const first = await mount([], { lead, judge, mode: "auto", hooks, save: true, mcp: servers([await config("fake", fake)]) });
    await soon(() => expect(states(first.mcp!.servers)).toEqual(["fake ready"]));
    await type(first.app, "read @fake:note://auth now");
    await shows(first.app, "one");
    await type(first.app, "/fake:auth");
    await shows(first.app, "two");
    const own = (p: FakeProvider) => p.seen.map((m) => (m[0]!.parts[0] as { text: string }).text);
    const heading = "The user's own messages, in order, each a JSON string:\n";
    expect(own(judge)[0]).toContain(`${heading}["read @fake:note://auth now"]\n`);
    expect(own(judge)[1]).toContain(`${heading}["read @fake:note://auth now","/fake:auth"]\n`);
    expect(JSON.parse(`[${readFileSync(out, "utf8").slice(0, -1)}]`)).toEqual(["read @fake:note://auth now", "/fake:auth"]);
    expect(lastSent(lead, 0)).toEqual([
      { type: "text", text: "read @fake:note://auth now" },
      { type: "text", text: `Resource @fake:note://auth:\n${SAYS}`, from: "server" },
    ]);
    expect(lastSent(lead, 2)).toEqual([
      { type: "text", text: "/fake:auth" },
      { type: "text", text: SAYS, from: "server" },
    ]);
    await press(first.app, "\u001b[A");
    expect(first.app.lastFrame()).toContain("› /fake:auth\n");
    first.app.unmount();
    // A window that resumes the session: its judge is given the typed lines alone.
    const judged = new FakeProvider("judge", [allow]);
    const again = new FakeProvider("a", [write("c3", "c"), reply("three")]);
    const { app } = await mount([], { lead: again, judge: judged, mode: "auto", save: true, sessions: first.sessions });
    await type(app, "/resume");
    await until(app, "Saved sessions in this folder, newest first:");
    await press(app, "\r");
    await until(app, "Resumed: read @fake:note://auth now.");
    expect(app.lastFrame()).not.toContain(SAYS);
    await type(app, "carry on");
    await until(app, "three");
    expect(own(judged)[0]).toContain(`${heading}["read @fake:note://auth now","/fake:auth","carry on"]\n`);
    expect(own(judged).join("")).not.toContain(SAYS);
  });

  // Task 13's fix round: what the servers supply is got once the first prompt's wait and UserPromptSubmit are done.
  it("gets a resource picked in the first prompt, sent while its server still starts", async () => {
    const { config, servers } = await mcpSetup();
    const lead = new FakeProvider("a", [reply("read it")]);
    const slow = "const began = Date.now(); while (Date.now() - began < 1500) {}"; // it answers nothing for 1.5 s
    const { app, mcp } = await mount([], { lead, mcp: servers([await config("fake", { resources: [NOTE], start: slow })]) });
    expect(states(mcp!.servers)).toEqual(["fake starting"]);
    await type(app, "read @fake:note://a now");
    await shows(app, "Waiting for MCP servers: fake...");
    await shows(app, "read it");
    expect(lastSent(lead)).toEqual([
      { type: "text", text: "read @fake:note://a now" },
      { type: "text", text: "Resource @fake:note://a:\nthe note's text", from: "server" },
    ]);
  });

  it("reads nothing from the server for a prompt a UserPromptSubmit hook blocks", async () => {
    const { dir, config, servers } = await mcpSetup();
    const log = path.join(dir, "log.jsonl");
    const script = path.join(dir, "block.cjs");
    writeFileSync(script, `process.stdin.resume().on("end", () => process.stdout.write(JSON.stringify({ decision: "block", reason: "not yet" })));`);
    const hooks: Hook[] = [{ event: "UserPromptSubmit", matcher: { all: true }, command: process.execPath, args: [script], async: false, where: "" }];
    const lead = new FakeProvider("a", [reply("never")]);
    const { app, mcp } = await mount([], { lead, hooks, mcp: servers([await config("fake", { resources: [NOTE], prompts: [GREET], log })]) });
    await soon(() => expect(states(mcp!.servers)).toEqual(["fake ready"]));
    await type(app, "read @fake:note://a now");
    await soon(() => expect(plain(app)).toContain("A UserPromptSubmit hook blocked the prompt: not yet"));
    await press(app, "\u0015"); // Ctrl+U empties the prompt of the words given back
    await type(app, "/fake:greet Ann");
    await soon(() => expect(plain(app).split("A UserPromptSubmit hook blocked the prompt: not yet")).toHaveLength(3));
    expect(app.lastFrame()).toContain("› /fake:greet Ann");
    expect(readLog(log).map((m) => m.method).filter((m) => m === "resources/read" || m === "prompts/get")).toEqual([]);
    expect(lead.seen).toEqual([]);
  });

  // A dropped remote server is connected again before the read, and a read that never reached it goes once more on a new
  // connection, as a tool call does (choices 13, 33).
  it("connects a dropped remote server again before reading from it, and reads once more when the read never reached it", async () => {
    const { dir, config, servers } = await mcpSetup();
    const resources = [NOTE];
    const first = await httpFake(dir, { resources });
    const entry = { kind: "http" as const, url: first.url, headers: {} };
    const lead = new FakeProvider("a", [reply("one"), reply("two")]);
    const { app, mcp } = await mount([], { lead, mcp: servers([await config("fake", {}, { entry, asWritten: { url: first.url } })]) });
    const s = mcp!.servers;
    await soon(() => expect(states(s)).toEqual(["fake ready"]));
    await first.stop();
    await s.server("fake")!.callTool("echo", { text: "x" }, {}).catch(() => {});
    expect(s.server("fake")!.state).toMatchObject({ is: "stopped", retry: true });
    const second = await httpFake(dir, { resources, port: first.port });
    await type(app, "read @fake:note://a now");
    await shows(app, "one");
    expect(app.lastFrame()).toContain("MCP server fake was connected again.");
    expect(lastSent(lead, 0)[1]).toEqual({ type: "text", text: "Resource @fake:note://a:\nthe note's text", from: "server" });
    // Restarted, it no longer knows the session (404): the read never reached it, so it goes once more.
    await second.stop();
    await httpFake(dir, { resources, port: first.port });
    await type(app, "read @fake:note://a again");
    await shows(app, "two");
    expect(lastSent(lead, 1)[1]).toEqual({ type: "text", text: "Resource @fake:note://a:\nthe note's text", from: "server" });
  });

  // The user's words for a server that is not ready (the fix round): /mcp's own state text.
  it("says a server that needs sign-in is not ready, for a resource and a prompt, and gives the words back", async () => {
    const t = await signInSetup();
    const lead = new FakeProvider("a", [reply("never")]);
    const { app, mcp } = await mount([], { lead, mcp: t.mcp });
    await soon(() => expect(states(mcp!.servers)).toEqual(["om needs sign-in"]));
    await type(app, "read @om:note://a now");
    await soon(() => expect(plain(app)).toContain(`Could not read @om:note://a: om is not ready (needs sign-in). ${BACK}`));
    expect(app.lastFrame()).toContain("› read @om:note://a now");
    await press(app, "\u0015"); // Ctrl+U empties the prompt of the words given back
    await type(app, "/om:summarise it");
    await soon(() => expect(plain(app)).toContain(`Could not get the prompt /om:summarise: om is not ready (needs sign-in). ${BACK}`));
    expect(app.lastFrame()).toContain("› /om:summarise it");
    expect(lead.seen).toEqual([]);
  });

  it("matches a resource and a prompt in their own letter case first, then in any", async () => {
    const { config, servers } = await mcpSetup();
    const lead = new FakeProvider("a", [reply("one"), reply("two")]);
    const { app, mcp } = await mount([], { lead, mcp: servers([await config("fake", { resources: [NOTE], prompts: [GREET] })]) });
    await soon(() => expect(states(mcp!.servers)).toEqual(["fake ready"]));
    await type(app, "read @FAKE:NOTE://A now");
    await shows(app, "one");
    expect(lastSent(lead, 0)[1]).toEqual({ type: "text", text: "Resource @fake:note://a:\nthe note's text", from: "server" });
    await type(app, "/Fake:Greet Ann");
    await shows(app, "two");
    expect(lastSent(lead, 1)).toEqual([
      { type: "text", text: "/Fake:Greet Ann" },
      { type: "text", text: "Say hello to Ann.", from: "server" },
    ]);
  });

  it("gives the words and their pictures back, saying nothing, when Esc stops a read", async () => {
    const { dir, config, servers } = await mcpSetup();
    const log = path.join(dir, "log.jsonl");
    const pictures = new Pictures();
    const lead = new FakeProvider("a", [reply("never")]);
    const { app, mcp } = await mount([], { lead, pictures, mcp: servers([await config("fake", { resources: [{ ...NOTE, hangs: true }], log })]) });
    await soon(() => expect(states(mcp!.servers)).toEqual(["fake ready"]));
    await press(app, "look at ", process.platform === "win32" ? "\u001bv" : "\u0016"); // chat:imagePaste
    pictures.set(1, { mediaType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    await type(app, " @fake:note://a now");
    await soon(() => expect(readLog(log).some((m) => m.method === "resources/read")).toBe(true));
    await press(app, "\u001b");
    await shows(app, "› look at [Image #1] @fake:note://a now");
    expect(plain(app)).not.toContain(BACK);
    expect(pictures.sent(1)).toBe(false);
    expect(lead.seen).toEqual([]);
  });

  it("numbers no picture when a later read fails, so the next paste is #1", async () => {
    const { config, servers } = await mcpSetup();
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const resources = [{ uri: "pic://dot", name: "dot", blob: png, mimeType: "image/png" }, { ...NOTE, fails: "it is gone" }];
    const { app, mcp } = await mount([], { mcp: servers([await config("fake", { resources })]) });
    await soon(() => expect(states(mcp!.servers)).toEqual(["fake ready"]));
    await type(app, "@fake:pic://dot @fake:note://a now");
    await soon(() => expect(plain(app)).toContain(`Could not read @fake:note://a: it is gone. ${BACK}`));
    await press(app, " ", process.platform === "win32" ? "\u001bv" : "\u0016"); // chat:imagePaste
    expect(app.lastFrame()).toContain("› @fake:pic://dot @fake:note://a now [Image #1]");
  });

  // The fix round: a key two servers share in any letter case, and a server whose name holds ":" or "/", are left out.
  it("leaves out of @ a key two servers share and a server whose name holds a colon", async () => {
    const { config, servers } = await mcpSetup();
    const configs = [
      await config("docs", { resources: [NOTE] }),
      await config("Docs", { resources: [NOTE] }),
      await config("a:b", { resources: [{ uri: "c", name: "c" }] }),
      await config("other", { resources: [{ uri: "x://y", name: "y" }] }),
    ];
    const { app, mcp } = await mount([], { mcp: servers(configs) });
    await soon(() => expect(states(mcp!.servers)).toEqual(["docs ready", "Docs ready", "a:b ready", "other ready"]));
    await soon(() => expect(mcp!.servers.server("other")!.resources).toHaveLength(1));
    await press(app, "@");
    await shows(app, "  @other:x://y\n");
    expect(app.lastFrame()).not.toMatch(/@docs:|@Docs:|@a:b:/);
  });
});
