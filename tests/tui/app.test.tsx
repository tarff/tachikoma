import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { render } from "ink-testing-library";
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
import { type Segment, SEGMENTS } from "../../src/tui/StatusLine.js";
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
    />,
  );
  mounted.push(app);
  // ink-testing-library's terminal has no height; 24 rows is Ink's own default size (getWindowSize).
  Object.assign(app.stdout, { rows: opts.rows ?? 24 });
  app.stdout.emit("resize");
  await tick();
  return { app, session, ctx, bus, tasks, historyFile, ask: (s: string, d?: string, o?: Owner) => ask(s, d, o) };
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
    expect(app.lastFrame()).not.toMatch(/ctx \d+% left/);
  });

  it("asks for the context window again after a reply, when only a reply makes it known", async () => {
    let answered = false;
    const later = Object.assign(new FakeProvider("a", [reply("there")]), { contextWindow: async () => (answered ? 1000 : null) });
    const complete = later.complete.bind(later);
    later.complete = async (req) => ((answered = true), complete(req));
    const { app } = await mount([], { lead: later });
    expect(app.lastFrame()).not.toMatch(/ctx \d+%/);
    await type(app, "hi");
    await until(app, "there");
    await until(app, "% left");
    expect(app.lastFrame()).toMatch(/ctx \d+% left/);
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
  const bg = (id: string, task: string) => callTool(id, "delegate", { task, background: true });
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
    const lead = new FakeProvider("a", [{ parts: [...bg("c1", "a").parts, ...callTool("c2", "delegate", { task: "b" }).parts], usage }]);
    const { app, tasks } = await mount([], { lead, worker: new Held("fake:w") });
    await type(app, "go");
    await waitFor(() => tasks.all.length === 2 && tasks.all.every((t) => t.state === "running"));
    await press(app, "\u001b");
    await waitFor(() => tasks.all[1]!.state === "stopped");
    expect(tasks.all[0]!.state).toBe("running");
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
