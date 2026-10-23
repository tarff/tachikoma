import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionGate } from "../../src/core/permissions.js";
import { Session } from "../../src/core/session.js";
import { Stats } from "../../src/core/stats.js";
import type { Provider } from "../../src/core/types.js";
import { TOOLS } from "../../src/tools/index.js";
import { App, type AppProps } from "../../src/tui/App.js";
import { SEGMENTS } from "../../src/tui/StatusLine.js";
import { Bus, FakeProvider, callTool, reply, tempContext } from "../helpers.js";

const tick = () => new Promise((r) => setTimeout(r, 50));

// Wait until the screen shows `text`; the session runs real file I/O in the background.
async function until(app: ReturnType<typeof render>, text: string) {
  for (let i = 0; i < 40 && !app.lastFrame()?.includes(text); i++) await tick();
  expect(app.lastFrame()).toContain(text);
}

const mounted: ReturnType<typeof render>[] = [];
afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
});

type Login = AppProps["login"];

async function mount(
  turns: ConstructorParameters<typeof FakeProvider>[1],
  opts: { lead?: Provider; errorFile?: string; login?: Login } = {},
) {
  const bus = new Bus();
  const stats = new Stats(bus);
  const ctx = await tempContext();
  let ask: (s: string, d?: string) => Promise<boolean> = async () => false;
  const gate = new PermissionGate("ask", (s, d) => ask(s, d));
  const lead = opts.lead ?? new FakeProvider("a", turns);
  const session = new Session({ lead, tools: TOOLS, system: "t", ctx: { ...ctx, gate }, bus });
  const app = render(
    <App
      session={session}
      bus={bus}
      stats={stats}
      mode="ask"
      errorFile={opts.errorFile ?? path.join(ctx.root, "errors.jsonl")}
      segments={SEGMENTS}
      makeProvider={() => new FakeProvider("b", [])}
      login={opts.login ?? (async () => {})}
      bindAsk={(fn) => {
        ask = fn;
      }}
    />,
  );
  mounted.push(app);
  await tick();
  return { app, session, ctx, bus, ask: (s: string) => ask(s) };
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
    await until(app, "›");
    expect(app.lastFrame()).not.toContain("working");
    expect(app.lastFrame()).not.toContain("[y/n]");
    expect(app.lastFrame()).not.toContain("written");
    expect(existsSync(target)).toBe(false);
  });

  it("says no at once, without a prompt, when asked after the turn was cancelled", async () => {
    const { app, ask } = await mount([], { lead: hanging() });
    await type(app, "hi");
    await until(app, "working");
    app.stdin.write("\u0003");
    await until(app, "›");
    expect(app.lastFrame()).not.toContain("working");
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
    expect(session.messages).toEqual([]);
  });

  it("signs in and out with /login and /logout, showing what they say, and never sends them to the model", async () => {
    const calls: string[] = [];
    const login: Login = async (verb, words, say) => {
      calls.push(`${verb} ${words.join(" ")}`);
      say(`${verb} done`);
    };
    const lead = new FakeProvider("a", []);
    const { app } = await mount([], { lead, login });
    await type(app, "/login chatgpt --new");
    await until(app, "login done");
    await type(app, "/logout chatgpt");
    await until(app, "logout done");
    expect(calls).toEqual(["login chatgpt --new", "logout chatgpt"]);
    expect(lead.seen).toEqual([]);
  });

  it("stops a sign-in on Ctrl-C, and shows why it failed", async () => {
    const login: Login = (_verb, _words, _say, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("Sign-in was cancelled"))));
    const { app } = await mount([], { login });
    await type(app, "/login chatgpt");
    await until(app, "working");
    app.stdin.write("\u0003");
    await until(app, "Sign-in was cancelled");
    await until(app, "›");
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
