import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
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
  // The fake's `ask` sends the client `elicitation/create` and answers with the client's answer, as JSON text.
  const ask = async (params: object) => {
    const r = await servers.server("fake")!.callTool("ask", { method: "elicitation/create", params }, {});
    return JSON.parse((r.content as { text: string }[])[0]!.text);
  };
  // The same through the session's tool for it, called by the subagent `owner` through its own gate, as tasks.ts gives one.
  const askAs = async (owner: Owner, params: object) => {
    const [offered] = servers.offer({ loaded: new Set(["mcp__fake__ask"]) }).defined.filter((o) => o.tool === "ask");
    const gate = new PermissionGate("ask", async () => false).for(owner);
    const ctx = { root: dir, executor: new LocalExecutor(), workspace: new LocalWorkspace(dir), gate };
    return mcpTools(servers, bus, async () => {}).tool(offered!).run({ method: "elicitation/create", params }, ctx);
  };
  return { servers, notes, errors, opened, ask, askAs, hook, inputs, useHooks };
}

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
    expect(await t.ask(visit("https://example.com/x?\u0007"))).toEqual({ action: "accept" });
    expect(t.opened).toEqual(["https://example.com/x?\u0007"]);
    expect(await t.ask(visit("https://example.com/y", "Go\u001b[2J"))).toEqual({ action: "decline" });
    expect(t.opened).toHaveLength(1);
    expect(visited).toEqual([
      "fake asks you to open https://example.com/x?\\u0007 in your browser: Sign the form there. Open it",
      "fake asks you to open https://example.com/y in your browser: Go\\u001b[2J. Open it",
    ]);
    expect(t.inputs("first")[0]).toMatchObject({ mode: "url", url: "https://example.com/x?\u0007", elicitation_id: "e1", message: "Sign the form there" });
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
});
