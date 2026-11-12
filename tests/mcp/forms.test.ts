import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { type Owner, PermissionGate } from "../../src/core/permissions.js";
import { LocalExecutor, LocalWorkspace } from "../../src/exec/local.js";
import type { Hook } from "../../src/hooks/config.js";
import { Hooks } from "../../src/hooks/hooks.js";
import { launchAnswers } from "../../src/mcp/answers.js";
import type { ServerConfig } from "../../src/mcp/config.js";
import { check, type Field, type FormUI, fieldsOf } from "../../src/mcp/forms.js";
import { Servers } from "../../src/mcp/servers.js";
import { mcpTools } from "../../src/mcp/tools.js";
import { Bus, collectErrors, removeTree } from "../helpers.js";
import { fakeServer } from "./fake.js";

// Release 8c plan, Task 12 (design, "Forms a server asks for"; choices 29 and 35): a server's forms, through real Servers
// running the fake server of fake.ts, real Hooks running a Node script of the test's own, and a stand-in for the window's
// questions.

// Each test starts a fake server and perhaps a hook's Node process, about 0.1 s each here; 15 s leaves room under load.
const LIMIT = { timeout: 15_000 };

const SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", title: "Name" },
    age: { type: "integer", title: "Age", minimum: 1, maximum: 120 },
    tea: { type: "boolean", title: "Tea", default: true },
    size: { type: "string", title: "Size", enum: ["s", "m"], enumNames: ["Small", "Medium"], default: "m" },
    nick: { type: "string" },
  },
  required: ["name", "age", "size"],
};
const form = (requestedSchema: object = SCHEMA, message = "Tell me about you") => ({ mode: "form", message, requestedSchema });

// A hook that appends its input to `<name>.jsonl` in the test's folder, prints `stdout` and exits with `code`.
const SCRIPT = `const fs = require("fs");
const [out, stdout, code] = process.argv.slice(2);
let text = "";
process.stdin.setEncoding("utf8").on("data", (d) => (text += d)).on("end", () => {
  fs.appendFileSync(out, text + "\\n");
  process.stdout.write(stdout, () => process.exit(Number(code)));
});`;

async function setup(opts: { headless?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "tachi-mcp-forms-"));
  const bus = new Bus();
  const notes: string[] = [];
  bus.on("mcp-note", (line) => notes.push(line));
  const errors = collectErrors(bus);
  const opened: string[] = [];
  const entry = { kind: "stdio" as const, command: process.execPath, args: [await fakeServer(dir)], env: {} };
  const config: ServerConfig = {
    name: "fake", safe: "fake", where: "user", trusted: null, trustedTools: [], alwaysLoad: false, written: "", entry, asWritten: entry,
  };
  const servers = new Servers([config], {
    root: dir, env: process.env, bus, answers: launchAnswers, network: "none", lead: () => "fake:a",
    openBrowser: (url) => void opened.push(url), headless: opts.headless ?? false,
  });
  onTestFinished(async () => {
    await servers.stopAll();
    await removeTree(dir);
  });
  servers.startAll();
  await servers.ready();
  const script = path.join(dir, "hook.cjs");
  writeFileSync(script, SCRIPT);
  const out = (name: string) => path.join(dir, `${name}.jsonl`);
  // A hook at `event` for the fake server's forms, printing `printed` (an object, as JSON) and exiting with `code`.
  const hook = (name: string, event: "Elicitation" | "ElicitationResult", printed: object | string, code = 0): Hook => ({
    event, matcher: { names: ["fake"] }, command: process.execPath,
    args: [script, out(name), typeof printed === "string" ? printed : JSON.stringify(printed), String(code)], async: false, where: `"${event}"`,
  });
  const inputs = (name: string) => (existsSync(out(name)) ? readFileSync(out(name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const useHooks = (hooks: Hook[]) => {
    const where = { sessionId: () => "s1", transcript: () => undefined, root: dir, mode: () => "ask" as const, effort: () => undefined, lead: () => "fake:a" };
    servers.forms.useHooks(new Hooks({ hooks, off: false, leftOut: [] }, where, bus));
  };
  // The fake's `ask` sends the client `elicitation/create` and answers with the client's answer, as JSON text; with
  // `cancel` it cancels the request at once and answers "cancelled".
  const call = async (params: object, cancel = false) => {
    const r = await servers.server("fake")!.callTool("ask", { method: "elicitation/create", params, cancel }, {});
    return (r.content as { text: string }[])[0]!.text;
  };
  const ask = async (params: object) => JSON.parse(await call(params));
  // The same through the session's tool for it, called by the subagent `owner` through its own gate, as tasks.ts gives one.
  const askAs = async (owner: Owner, params: object) => {
    const [offered] = servers.offer({ loaded: new Set(["mcp__fake__ask"]) }).defined.filter((o) => o.tool === "ask");
    const gate = new PermissionGate("ask", async () => false).for(owner);
    const ctx = { root: dir, executor: new LocalExecutor(), workspace: new LocalWorkspace(dir), gate };
    return mcpTools(servers, bus, async () => {}).tool(offered!).run({ method: "elicitation/create", params }, ctx);
  };
  return { servers, notes, errors, opened, call, ask, askAs, hook, inputs, useHooks };
}

// The window's questions as the App asks them: each field waits until `answer` is called, or until its form's signal stops
// it, which takes the field away (null), as App.tsx's does.
function waiting() {
  const asked: string[] = [];
  let answer: (a: string | string[] | null) => void = () => {};
  const ui: FormUI = {
    field: (f, _given, signal) =>
      new Promise((resolve) => {
        asked.push(f.question);
        answer = resolve;
        signal.addEventListener("abort", () => resolve(null), { once: true });
      }),
    visit: async () => false,
  };
  return { ui, asked, answer: (a: string | string[] | null) => answer(a) };
}
const until = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true), { timeout: 5_000 }); // another process: a busy machine

// The window's questions, answered from `given` in turn; each field asked is kept with what it was given back.
function standIn(given: (string | string[] | null)[], visits: boolean[] = []) {
  const asked: { question: string; given: string | string[] | undefined }[] = [];
  const visited: string[] = [];
  const ui: FormUI = {
    field: async (f, again) => {
      asked.push({ question: f.question, given: again });
      return given.shift()!;
    },
    visit: async (question) => {
      visited.push(question);
      return visits.shift()!;
    },
  };
  return { ui, asked, visited };
}

describe("a form's fields", () => {
  it("asks each kind of field with the plan's question, its default filled in, a server's words escaped", () => {
    const fields = fieldsOf({
      type: "object",
      properties: {
        name: { type: "string", title: "Your\u001b[2J name", description: "As\u0007 written", default: "Ada" },
        n: { type: "number" },
        whole: { type: "integer", minimum: 0, maximum: 9, default: 3 },
        ok: { type: "boolean", default: false },
        one: { type: "string", enum: ["a", "b"] },
        titled: { type: "string", oneOf: [{ const: "x", title: "Ex\u0007" }, { const: "y", title: "Why" }], default: "y" },
        old: { type: "string", enum: ["p", "q"], enumNames: ["Pea"] },
        many: { type: "array", items: { type: "string", enum: ["r", "s"] }, default: ["s"] },
        manyTitled: { type: "array", items: { anyOf: [{ const: "t", title: "Tee" }] } },
      },
      required: ["name", "one", "many"],
    } as Parameters<typeof fieldsOf>[0]);
    const shown = fields.map((f): unknown[] => [f.question, f.note, f.kind, f.start, ...(f.kind === "pick" ? [f.multi, f.options] : [])]);
    expect(shown).toEqual([
      ["Your\\u001b[2J name: ", "As\\u0007 written", "text", "Ada"],
      ["n (a number) (optional): ", undefined, "number", ""],
      ["whole (a number) (optional): ", undefined, "number", "3"],
      ["ok (yes or no) (optional): ", undefined, "yes or no", "n"],
      ["one: ", undefined, "pick", [], false, [{ value: "a", label: "a" }, { value: "b", label: "b" }]],
      ["titled (optional): ", undefined, "pick", ["y"], false, [{ value: "x", label: "Ex\u0007" }, { value: "y", label: "Why" }]],
      ["old (optional): ", undefined, "pick", [], false, [{ value: "p", label: "Pea" }, { value: "q", label: "q" }]],
      ["many: ", undefined, "pick", ["s"], true, [{ value: "r", label: "r" }, { value: "s", label: "s" }]],
      ["manyTitled (optional): ", undefined, "pick", [], true, [{ value: "t", label: "Tee" }]],
    ]);
  });

  it("checks a number, a whole number, its limits, a yes or no and a needed field in the plan's words, and leaves out an empty optional one", () => {
    const [name, n, whole, ok, many] = fieldsOf({
      type: "object",
      properties: {
        name: { type: "string" },
        n: { type: "number" },
        whole: { type: "integer", minimum: 1, maximum: 9 },
        ok: { type: "boolean" },
        many: { type: "array", items: { type: "string", enum: ["r", "s"] } },
      },
      required: ["name", "ok"],
    } as Parameters<typeof fieldsOf>[0]) as [Field, Field, Field, Field, Field];
    const needed = { wrong: "This field is needed; type an answer, or Esc to decline the form." };
    expect(check(name, "")).toEqual(needed);
    expect(check(name, "Ada")).toEqual({ value: "Ada", shown: "Ada" });
    expect(check(n, "")).toEqual({ shown: "" });
    expect(check(n, "abc")).toEqual({ wrong: "That is not a number; type one, or Esc to decline the form." });
    expect(check(n, " 2.5 ")).toEqual({ value: 2.5, shown: "2.5" });
    expect(check(whole, "2.5")).toEqual({ wrong: "That is not a whole number; type one, or Esc to decline the form." });
    expect(check(whole, "0")).toEqual({ wrong: "That is under 1; type 1 or more, or Esc to decline the form." });
    expect(check(whole, "10")).toEqual({ wrong: "That is over 9; type 9 or less, or Esc to decline the form." });
    expect(check(whole, "9")).toEqual({ value: 9, shown: "9" });
    expect(check(ok, "")).toEqual(needed);
    expect(check(ok, "maybe")).toEqual({ wrong: "That is not yes or no; type y or n, or Esc to decline the form." });
    expect([check(ok, "Y"), check(ok, "no")]).toEqual([{ value: true, shown: "Y" }, { value: false, shown: "no" }]);
    expect(check(many, [])).toEqual({ shown: "" });
    expect(check(many, ["r", "s"])).toEqual({ value: ["r", "s"], shown: "r, s" });
  });
});

describe("a server's form", LIMIT, () => {
  it("is asked field by field, under its heading, again after a wrong answer, and the server gets the values", async () => {
    const t = await setup();
    const { ui, asked } = standIn(["Ada", "200", "30", "", ["s"], ""]);
    t.servers.forms.bind(ui);
    expect(await t.ask(form())).toEqual({ action: "accept", content: { name: "Ada", age: 30, size: "s" } });
    expect(asked).toEqual([
      { question: "Name: ", given: undefined },
      { question: "Age (a number): ", given: undefined },
      { question: "Age (a number): ", given: "200" }, // asked again with what was typed
      { question: "Tea (yes or no) (optional): ", given: undefined },
      { question: "Size: ", given: undefined },
      { question: "nick (optional): ", given: undefined },
    ]);
    expect(t.notes).toEqual([
      "fake asks: Tell me about you",
      "Name: Ada",
      "That is over 120; type 120 or less, or Esc to decline the form.",
      "Age (a number): 30",
      "Tea (yes or no) (optional): ",
      "Size: Small",
      "nick (optional): ",
    ]);
  });

  it("is declined by Esc, with its line, and the fields after it are not asked", async () => {
    const t = await setup();
    const { ui, asked } = standIn(["Ada", null]);
    t.servers.forms.bind(ui);
    expect(await t.ask(form())).toEqual({ action: "decline" });
    expect(asked).toHaveLength(2);
    expect(t.notes.at(-1)).toBe("You declined fake's form.");
  });

  it("heads a form with its message escaped, and a subagent's with its id", async () => {
    const t = await setup();
    const { ui } = standIn(["Ada", "Bob"]);
    t.servers.forms.bind(ui);
    const one = { type: "object", properties: { name: { type: "string" } } };
    await t.ask(form(one, "Hi\u001b[2J\nthere"));
    const owner: Owner = { name: "t1 (look around)", signal: new AbortController().signal, stop: () => {} };
    await t.askAs(owner, form(one, "Again"));
    expect(t.notes.filter((l) => l.includes("asks:"))).toEqual(["fake asks: Hi\\u001b[2J⏎there", "t1: fake asks: Again"]);
  });

  // Choice 29: a subagent's form's every line carries its id, as its other lines do (Task 12's quality review).
  it("puts a subagent's id before every line of its form: answers, a wrong answer and the decline", async () => {
    const t = await setup();
    const { ui } = standIn(["Ada", "x", "3", null]);
    t.servers.forms.bind(ui);
    const schema = { type: "object", properties: { name: { type: "string" }, n: { type: "number" }, more: { type: "string" } } };
    const owner: Owner = { name: "t1 (look around)", signal: new AbortController().signal, stop: () => {} };
    expect(JSON.parse(String(await t.askAs(owner, form(schema, "Go"))))).toEqual({ action: "decline" });
    expect(t.notes).toEqual([
      "t1: fake asks: Go",
      "t1: name (optional): Ada",
      "t1: That is not a number; type one, or Esc to decline the form.",
      "t1: n (a number) (optional): 3",
      "t1: You declined fake's form.",
    ]);
  });

  // A stop mid-form gives the server a cancel, never an error, and no ElicitationResult hook runs for it (Task 12's quality
  // review): the subagent's own stop, and the server's cancel of its request.
  it("is cancelled when its subagent stops mid-form, the field taken away and no ElicitationResult hook run", async () => {
    const t = await setup();
    const w = waiting();
    t.servers.forms.bind(w.ui);
    t.useHooks([t.hook("after", "ElicitationResult", "")]);
    const stop = new AbortController();
    const owner: Owner = { name: "t1 (look around)", signal: stop.signal, stop: () => stop.abort() };
    const asking = t.askAs(owner, form());
    await until(() => w.asked.length === 1);
    stop.abort();
    expect(JSON.parse(String(await asking))).toEqual({ action: "cancel" });
    expect([t.notes, t.inputs("after")]).toEqual([["t1: fake asks: Tell me about you"], []]);
  });

  it("is taken away when the server cancels its request, with no decline line and no ElicitationResult hook", async () => {
    const t = await setup();
    const w = waiting();
    t.servers.forms.bind(w.ui);
    t.useHooks([t.hook("after", "ElicitationResult", "")]);
    expect(await t.call(form(), true)).toBe("cancelled");
    // Forms are asked one at a time, so the next form is asked only once the cancelled one has ended, whenever the cancel
    // reached it.
    const one = { type: "object", properties: { name: { type: "string" } } };
    const next = t.ask(form(one, "Next"));
    await until(() => t.notes.includes("fake asks: Next") && w.asked.at(-1) === "name (optional): ");
    w.answer("Bob");
    expect(await next).toEqual({ action: "accept", content: { name: "Bob" } });
    expect(t.notes.filter((l) => l.startsWith("You declined"))).toEqual([]);
    // The ElicitationResult hook ran for the next form only.
    expect(t.inputs("after")).toMatchObject([{ message: "Next", action: "accept", content: { name: "Bob" } }]);
  });

  it("asks two forms one after the other, never their fields mixed", async () => {
    const t = await setup();
    const { ui, asked } = standIn(["a1", "a2", "b1", "b2"]);
    t.servers.forms.bind(ui);
    const two = { type: "object", properties: { first: { type: "string" }, second: { type: "string" } } };
    const [a, b] = await Promise.all([t.ask(form(two, "A")), t.ask(form(two, "B"))]);
    expect([a, b]).toEqual([{ action: "accept", content: { first: "a1", second: "a2" } }, { action: "accept", content: { first: "b1", second: "b2" } }]);
    expect(asked).toHaveLength(4);
    expect(t.notes).toEqual([
      "fake asks: A", "first (optional): a1", "second (optional): a2", "fake asks: B", "first (optional): b1", "second (optional): b2",
    ]);
  });

  it("is answered by an Elicitation hook with no form shown, the hook sent Claude Code's input, and no ElicitationResult hook runs", async () => {
    const t = await setup();
    const { ui, asked } = standIn([]);
    t.servers.forms.bind(ui);
    const accept = { hookSpecificOutput: { hookEventName: "Elicitation", action: "accept", content: { name: "Hook" } } };
    t.useHooks([t.hook("first", "Elicitation", accept), t.hook("after", "ElicitationResult", "")]);
    expect(await t.ask(form())).toEqual({ action: "accept", content: { name: "Hook" } });
    expect(asked).toEqual([]);
    expect(t.notes).toEqual([]);
    expect(t.inputs("first")).toMatchObject([
      { hook_event_name: "Elicitation", mcp_server_name: "fake", message: "Tell me about you", mode: "form", requested_schema: SCHEMA },
    ]);
    expect(t.inputs("after")).toEqual([]);
  });

  it("is declined by an Elicitation hook's exit code 2, with its line", async () => {
    const t = await setup();
    const { ui, asked } = standIn([]);
    t.servers.forms.bind(ui);
    t.useHooks([t.hook("no", "Elicitation", "", 2)]);
    expect(await t.ask(form())).toEqual({ action: "decline" });
    expect([asked, t.notes]).toEqual([[], ["An Elicitation hook declined fake's form."]]);
  });

  it("is declined when an ElicitationResult hook exits with code 2, which sees the user's answer, with its line", async () => {
    const t = await setup();
    const one = { type: "object", properties: { name: { type: "string" } } };
    const { ui } = standIn(["Ada"]);
    t.servers.forms.bind(ui);
    t.useHooks([t.hook("result", "ElicitationResult", "", 2)]);
    expect(await t.ask(form(one))).toEqual({ action: "decline" });
    expect(t.inputs("result")).toMatchObject([{ hook_event_name: "ElicitationResult", mcp_server_name: "fake", action: "accept", content: { name: "Ada" } }]);
    expect(t.notes.at(-1)).toBe("An ElicitationResult hook declined fake's form.");
  });

  it("takes an ElicitationResult hook's accept in place of the user's answer", async () => {
    const t = await setup();
    const one = { type: "object", properties: { name: { type: "string" } } };
    const { ui } = standIn([null]);
    t.servers.forms.bind(ui);
    const accept = { hookSpecificOutput: { hookEventName: "ElicitationResult", action: "accept", content: { name: "Hook" } } };
    t.useHooks([t.hook("result", "ElicitationResult", accept)]);
    expect(await t.ask(form(one))).toEqual({ action: "accept", content: { name: "Hook" } });
    expect(t.inputs("result")).toMatchObject([{ action: "decline" }]);
  });

  it("is declined in -p, with its note, an Elicitation hook still answering there", async () => {
    const t = await setup({ headless: true });
    expect(await t.ask(form())).toEqual({ action: "decline" });
    expect(await t.ask({ mode: "url", message: "Go", elicitationId: "e1", url: "https://example.com/" })).toEqual({ action: "decline" });
    expect(t.notes).toEqual(["MCP server fake asked for a form; -p declines every form.", "MCP server fake asked for a form; -p declines every form."]);
    const accept = { hookSpecificOutput: { hookEventName: "Elicitation", action: "accept", content: { name: "Hook" } } };
    t.useHooks([t.hook("first", "Elicitation", accept)]);
    expect(await t.ask(form())).toEqual({ action: "accept", content: { name: "Hook" } });
    expect(t.notes).toHaveLength(2);
  });

  // The note is said only when -p's decline is still the answer once the ElicitationResult hooks have run (Task 12's
  // quality review).
  it("says -p's note only when no ElicitationResult hook replaced its decline", async () => {
    const t = await setup({ headless: true });
    const accept = { hookSpecificOutput: { hookEventName: "ElicitationResult", action: "accept", content: { name: "Hook" } } };
    t.useHooks([t.hook("after", "ElicitationResult", accept)]);
    expect(await t.ask(form())).toEqual({ action: "accept", content: { name: "Hook" } });
    expect(t.inputs("after")).toMatchObject([{ action: "decline" }]);
    expect(t.notes).toEqual([]);
  });

  it("is declined with no question once the window has gone", async () => {
    const t = await setup();
    const { ui, asked } = standIn(["Ada"]);
    t.servers.forms.bind(ui)();
    expect(await t.ask(form())).toEqual({ action: "decline" });
    expect([asked, t.notes]).toEqual([[], []]);
  });
});

describe("a visit request", LIMIT, () => {
  const visit = (url: string, message = "Sign the form there") => ({ mode: "url", message, elicitationId: "e1", url });

  it("asks its question and opens the browser on yes; a no declines; the hooks are sent its address", async () => {
    const t = await setup();
    const { ui, visited } = standIn([], [true, false]);
    t.servers.forms.bind(ui);
    t.useHooks([t.hook("first", "Elicitation", "")]);
    expect(await t.ask(visit("https://example.com/x?\u0007y"))).toEqual({ action: "accept" });
    expect(t.opened).toEqual(["https://example.com/x?%07y"]); // the address as parsed, its control character encoded
    expect(await t.ask(visit("https://example.com/y", "Go\u001b[2J"))).toEqual({ action: "decline" });
    expect(t.opened).toHaveLength(1);
    expect(visited).toEqual([
      "fake asks you to open https://example.com/x?\\u0007y in your browser: Sign the form there. Open it",
      "fake asks you to open https://example.com/y in your browser: Go\\u001b[2J. Open it",
    ]);
    expect(t.inputs("first")[0]).toMatchObject({ mode: "url", url: "https://example.com/x?\u0007y", elicitation_id: "e1", message: "Sign the form there" });
  });

  // The system's opener runs what it is given (on Windows, url.dll's FileProtocolHandler starts a file:// program), so
  // only a web address is offered.
  it("declines an address that is not http or https without asking, with its line", async () => {
    const t = await setup();
    const { ui, visited } = standIn([], [true]);
    t.servers.forms.bind(ui);
    expect(await t.ask(visit("file:///C:/Windows/System32/calc.exe"))).toEqual({ action: "decline" });
    expect([visited, t.opened, t.notes]).toEqual([[], [], []]);
    expect(t.errors.map((e) => [e.kind, e.message])).toEqual([
      ["mcp", "MCP server fake asked to open file:///C:/Windows/System32/calc.exe, which is not an http or https address, so it was declined."],
    ]);
    // Escaped, as everything a server sends is.
    expect(await t.ask(visit("file:///x\u0007"))).toEqual({ action: "decline" });
    expect(t.errors.at(-1)!.message).toContain("file:///x\\u0007,");
  });

  // A subagent's visit is asked in its heading's form, its id first, not as "<id> (<description>) to ..." (Task 12's quality
  // review); its refused address's line carries the id too.
  it("puts a subagent's id before its visit's question and its refused address's line", async () => {
    const t = await setup();
    const { ui, visited } = standIn([], [false]);
    t.servers.forms.bind(ui);
    const owner: Owner = { name: "t1 (look around)", signal: new AbortController().signal, stop: () => {} };
    expect(JSON.parse(String(await t.askAs(owner, visit("https://example.com/"))))).toEqual({ action: "decline" });
    expect(visited).toEqual(["t1: fake asks you to open https://example.com/ in your browser: Sign the form there. Open it"]);
    await t.askAs(owner, visit("file:///x"));
    expect(t.errors.at(-1)!.message).toBe("t1: MCP server fake asked to open file:///x, which is not an http or https address, so it was declined.");
  });
});
