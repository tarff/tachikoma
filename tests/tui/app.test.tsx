import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type Instance, render as renderInk } from "ink";
import { render } from "ink-testing-library";
import chalk from "chalk";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { privateDir } from "../../src/auth/private.js";
import { type Mode, type Owner, PermissionGate } from "../../src/core/permissions.js";
import { Session } from "../../src/core/session.js";
import { Stats } from "../../src/core/stats.js";
import type { Provider } from "../../src/core/types.js";
import type { TodoItem } from "../../src/tools/todo.js";
import { Tasks } from "../../src/core/tasks.js";
import { delegateTool } from "../../src/tools/delegate.js";
import { SUBAGENT_TOOLS, TOOLS } from "../../src/tools/index.js";
import { History } from "../../src/tui/history.js";
import type { ModelGroup } from "../../src/providers/models.js";
import { App, type AppProps } from "../../src/tui/App.js";
import { Clipboard } from "../../src/tui/clipboard.js";
import type { Mouse } from "../../src/tui/input.js";
import { type Segment, SEGMENTS } from "../../src/tui/StatusLine.js";
import { FIRST_SCREEN, MOUSE_OFF, MOUSE_ON, PASTE_OFF, PASTE_ON, SECOND_SCREEN, Screen } from "../../src/tui/terminal.js";
import { wrap } from "../../src/tui/view.js";
import { Bus, FakeProvider, Held, callTool, reply, tempContext, usage } from "../helpers.js";

const tick = () => new Promise((r) => setTimeout(r, 50));

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

const mounted: ReturnType<typeof render>[] = [];
afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
});

type Login = AppProps["login"];

// Each test's history is a file in one folder of this file's own, inside a fresh temp folder: the
// history makes its folder private, which takes about 1.5 s for a new folder on Windows (measured
// 2026-10-25), once a process.
const histories = path.join(mkdtempSync(path.join(tmpdir(), "tachi-")), "history");
mkdirSync(histories);
beforeAll(() => privateDir(histories)); // so the first test does not wait for it
let nextHistory = 0;

async function mount(
  turns: ConstructorParameters<typeof FakeProvider>[1],
  opts: {
    lead?: Provider;
    errorFile?: string;
    login?: Login;
    models?: ModelGroup[];
    note?: string;
    slow?: boolean;
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
  } = {},
) {
  const bus = new Bus();
  const stats = new Stats(bus);
  const ctx = await tempContext();
  let ask: (s: string, d?: string, o?: Owner) => Promise<boolean> = async () => false;
  const gate = new PermissionGate(opts.mode ?? "ask", (s, d, o) => ask(s, d, o));
  const lead = opts.lead ?? new FakeProvider("a", turns);
  const tasks = new Tasks({ bus, max: 8, worker: () => opts.worker ?? new FakeProvider("w", []), system: "sub", tools: SUBAGENT_TOOLS, ctx: { ...ctx, gate } });
  const session = new Session({ lead, tools: [...TOOLS, delegateTool(tasks, { headless: false })], system: "t", ctx: { ...ctx, gate }, bus, inbox: () => tasks.take() });
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
      project="proj"
      root={ctx.root}
      gitBranch={() => opts.branches?.shift() ?? null}
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
    />,
  );
  mounted.push(app);
  // ink-testing-library's terminal has no height; 24 rows is Ink's own default size (getWindowSize).
  Object.assign(app.stdout, { rows: opts.rows ?? 24 });
  app.stdout.emit("resize");
  await tick();
  return { app, session, ctx, bus, tasks, historyFile, mouse, copies, ask: (s: string, d?: string, o?: Owner) => ask(s, d, o) };
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
    await until(app, `write ${target}: declined (cancelled)`);
    await gone(app, "Esc to stop");
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
    expect(app.lastFrame()).toContain(`write ${target}: allowed`);
    expect(app.lastFrame()).not.toContain("declined");
  });

  it("switches the lead with /lead", async () => {
    const { app, session } = await mount([]);
    await type(app, "/lead fake:b");
    expect(session.lead.id).toBe("fake:b");
    expect(app.lastFrame()).toContain("lead is now fake:b");
  });

  it("shows how to use /lead, and does not send it to the model", async () => {
    const { app, session } = await mount([]);
    await type(app, "/lead");
    expect(app.lastFrame()).toContain("Usage: /lead <provider:model>");
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
    await type(app, "/Lead");
    await until(app, "Usage: /lead");
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
    await type(app, "/lead"); // still running
    await until(app, "Usage: /lead");
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
    expect(asked).toBe(2);
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
    const dir = await mkdtemp(path.join(tmpdir(), "tachi-"));
    const { app } = await mount([reply("still here")], { errorFile: dir });
    await type(app, "/errors");
    await until(app, "EISDIR");
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

  it("declines one action on Esc at a question, and the turn carries on", async () => {
    const { app, ctx } = await mount([callTool("c1", "write_file", { path: "a.txt", content: "x" }), reply("carried on")]);
    await type(app, "make a file");
    const target = path.join(ctx.root, "a.txt");
    await until(app, `Allow write ${target}? [y/n] · Esc to decline`);
    await press(app, "\u001b");
    await until(app, "carried on");
    expect(app.lastFrame()).toContain(`write ${target}: declined`);
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
    await press(app, "two", "\r", "/lead", "\r", "three", "\r", "\u001b");
    await until(app, "last");
    release();
    expect(prompts(session)).toEqual(["one", "two", "three"]);
    expect(app.lastFrame()).toMatch(/boom[\s\S]*Usage: \/lead[\s\S]*> three/);
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

  it("waits after a queued /model until the list is closed", async () => {
    const { lead, release } = gated([reply("r1"), reply("r2")]);
    const { app, session } = await mount([], { lead, models: [{ provider: "fake", models: ["a", "c"] }] });
    await type(app, "one");
    await until(app, "Esc to stop");
    await press(app, "/model", "\r", "two", "\r");
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
    expect(app.lastFrame()).toContain("t2 (find the login code) to read /b: declined");
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
    expect(app.lastFrame()).toContain("t2 (x) to read /b: cancelled");
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
    expect(app.lastFrame()).toContain("› /\n  /lead <provider:model>  Switch the lead model\n  /model  Pick the lead model from a list\n");
    expect(app.lastFrame()).toContain("↑↓ choose · Tab fill · Enter run · Esc close");
    await press(app, "e");
    expect(app.lastFrame()).toContain("› /e\n  /errors  Summarise the error log\n  /exit  Quit\n");
    expect(app.lastFrame()).not.toContain("/model");
  });

  it("runs the chosen command on Enter, Down choosing the next", async () => {
    const { app } = await mount([]);
    await press(app, "/", "e", "\u001b[B", "\r");
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
    // Keys that work in Windows Terminal, where Ctrl+Backspace is Backspace and Ctrl+_ cannot be typed.
    expect(app.lastFrame()).toContain("Alt+Backspace  the word before");
    expect(app.lastFrame()).toContain("Ctrl+Z  undo");
    expect(app.lastFrame()).not.toContain("Ctrl+Backspace");
    expect(app.lastFrame()).toContain("\n›\n"); // the prompt stays empty
    await press(app, " ?");
    expect(app.lastFrame()).toContain("›  ?\n");
  });

  it("switches between ask and project on Shift+Tab, saying so, and the check uses the new mode from the next action", async () => {
    const { app, ctx } = await mount([callTool("c1", "write_file", { path: "a.txt", content: "x" }), reply("written")]);
    await press(app, "\u001b[Z");
    expect(app.lastFrame()).toContain("mode is now project");
    expect(app.lastFrame()).toContain("perm project");
    await type(app, "go");
    await until(app, "written"); // not asked: project mode allows writes inside the project
    expect(existsSync(path.join(ctx.root, "a.txt"))).toBe(true);
    await press(app, "\u001b[Z");
    expect(app.lastFrame()).toContain("mode is now ask");
    expect(app.lastFrame()).toContain("perm ask");
  });

  it("takes never into the cycle only when the session started in it", async () => {
    const { app } = await mount([], { mode: "never" });
    await press(app, "\u001b[Z", "\u001b[Z", "\u001b[Z");
    expect(app.lastFrame()).toContain("mode is now ask\nmode is now project\nmode is now never\n");
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
        onMode={() => {}}
        project="proj"
        root={ctx.root}
        gitBranch={() => null}
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

  it("leaves the conversation a row however tall the prompt grows, and the frame a row short of the terminal", async () => {
    const { app } = await mount([], { full: true, intro: said(60) });
    await press(app, Array.from({ length: 20 }, (_, i) => `p${i}`).join("\n")); // Ctrl+J between them
    const rows = shown(app);
    expect(rows).toHaveLength(23);
    expect(rows[0]).toBe("said 59.");
    expect(rows[1]).toBe("› p0");
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

  // The live area's rows are counted by hand (App.tsx, liveRows): a count off by one would make the frame as tall as the
  // terminal, which Ink clears whole before drawing (release 5 plan, "Before you start").
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
      await press(app, "\u0015", "a", ..."bcdefghij".split("").flatMap((c) => ["\n", c])); // Ctrl+U empties it; ten lines
      expect(shown(app).slice(1, 7)).toEqual(["› ↑ 5 rows above", "  f", "  g", "  h", "  i", "  j"]);
      await pointer(mouse, ...click(4, 1));
      await press(app, "X");
      expect(shown(app)[6]).toBe("  jX");
      await press(app, "\u007f", ...Array(9).fill("\u001b[A")); // Backspace, then up to the first row
      expect(shown(app).slice(1, 7)).toEqual(["› a", "  b", "  c", "  d", "  e", "  ↓ 5 rows below"]);
      await pointer(mouse, ...click(4, 6));
      await press(app, "Y");
      expect(shown(app)[1]).toBe("› aY");
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

  // As a key between two presses does (the rule at App.tsx's `remember`).
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
    expect(shown(app).slice(16, 20)).toEqual(["b 4.", "a reply", "t2 (a) to write a.txt: allowed", "t3 (b) to write b.txt: allowed"]);
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
    await until(app, "write a.txt: allowed");
    expect(shown(app)[19]).toBe("write a.txt: allowed");
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
    { key: "y", ok: true, how: "allowed" },
    { key: "n", ok: false, how: "declined" },
    { key: "\u001b", ok: false, how: "declined" },
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
    expect(shown(app).slice(19, 21)).toEqual(["c 29.", "t2 (a) to run: ls: allowed"]); // the newest lines: no copy of the path
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
    expect(app.lastFrame()).not.toContain("run: ls: allowed");
  });

  // Whether the view was following is kept from the question's first draw, not from when a resize moves it into the
  // conversation.
  it.each([
    { name: "following", before: false, after: "run (shown above): allowed" },
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
    await until(app, "write a.txt: declined");
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

  it("wraps the view's lines again on a resize", async () => {
    const long = (i: number) => `said ${i}. ${"word ".repeat(14).trimEnd()}`; // under 80 columns: one row at 99, two at 59
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

  // A record opened by the queue going on from a listener set up once, at mount: a question's answer (bindAsk), and the
  // end of a command clicked in the menu (the mouse's listener). Either way it wraps at the width the terminal has then.
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
  const long = (i: number) => `said ${i}. ${"word ".repeat(14).trimEnd()}`; // under 80 columns: one row at 99, two at 59

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
  } = {},
) {
  const worker = opts.worker ?? new FakeProvider("w", []);
  const steps: string[] = [];
  const record = (s: string) => {
    steps.push(s);
    opts.step?.(s);
  };
  const terminal = Object.assign(new EventEmitter(), { isTTY: true, columns: 100, rows: 24, write: (s: string) => (record(s), true) });
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
      onMode={() => {}}
      project="proj"
      root={ctx.root}
      gitBranch={() => null}
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
    expect(app.lastFrame()).toContain("/errors, /screen, /exit");
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
});
