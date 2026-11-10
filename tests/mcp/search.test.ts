import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Models } from "@anthropic-ai/sdk/resources/models";
import { type BetaMessage, Messages } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { Completions } from "openai/resources/chat/completions";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { PermissionGate } from "../../src/core/permissions.js";
import { Session, type SessionOptions } from "../../src/core/session.js";
import { Tasks } from "../../src/core/tasks.js";
import { readTranscript, Transcript } from "../../src/core/transcript.js";
import type { CompletionRequest, Message, Provider, ToolSpec, Turn } from "../../src/core/types.js";
import { MAX_TOOL_OUTPUT } from "../../src/exec/executor.js";
import { LocalExecutor, LocalWorkspace } from "../../src/exec/local.js";
import { matcherOf } from "../../src/hooks/config.js";
import { Hooks } from "../../src/hooks/hooks.js";
import type { ServerConfig } from "../../src/mcp/config.js";
import { find, searchTool } from "../../src/mcp/search.js";
import { type Offer, Servers } from "../../src/mcp/servers.js";
import { type Approve, type McpTools, mcpTools } from "../../src/mcp/tools.js";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import { OpenAIProvider } from "../../src/providers/openai.js";
import { defineTool } from "../../src/tools/tool.js";
import { Bus, callTool, collectErrors, reply, removeTree } from "../helpers.js";
import { type FakeOptions, fakeServer, readLog } from "./fake.js";

// Release 8c plan, Task 6b: tool search, against the fake servers of fake.ts and a stand-in model. Every request the model
// is sent is the stand-in's; none reaches a provider.

const HEAD =
  'Finds MCP tools and loads them, so they can be called from the next step on. Search with words from a tool\'s name or what it does, or load tools by name with "select:<name>,<name>". MCP tools not loaded yet:';
const OBJECT = { type: "object" };
const tool = (name: string, description = name, extra: object = {}) => ({ name, description, inputSchema: OBJECT, ...extra });
const own = defineTool("own", "Tachikoma's own tool, which comes first", z.object({}), async () => "own");
const answered = (text: string) => ({ content: [{ type: "text", text }] });
// The fruit servers' tools: a's two, b's one, each answering its own name.
const apples = [tool("pick", "Picks an apple"), tool("peel", "Peels an apple")];
const fruit = (tools: { name: string }[]) => Object.fromEntries(tools.map((t) => [t.name, answered(`${t.name}ed`)]));
const loadedLine = (names: string[]) =>
  `Loaded ${names.length} ${names.length === 1 ? "tool; call it" : "tools; call them"} from the next step on:\n` +
  names.join("\n\n");
const entry = (full: string, description: string) => `${full}: ${description}\nInput: ${JSON.stringify(OBJECT)}`;

// A stand-in model: its turns in order, one made by a function when the test changes something once the request is made;
// each request's tools kept whole.
class Model implements Provider {
  readonly requests: ToolSpec[][] = [];
  readonly sent: Message[][] = [];
  constructor(
    readonly id: string,
    private readonly turns: (Turn | (() => Promise<Turn>))[],
  ) {}
  async complete(req: CompletionRequest): Promise<Turn> {
    this.requests.push(req.tools);
    this.sent.push(req.messages);
    const next = this.turns.shift();
    if (!next) throw new Error("the stand-in model ran out of turns");
    return typeof next === "function" ? next() : next;
  }
  names = (i: number) => this.requests[i]!.map((t) => t.name);
  // Each reply request `i` sends, by the label of its thinking, or "-" for one sent without it.
  thinking = (i: number) =>
    this.sent[i]!.filter((m) => m.role === "assistant").map((m) => (m.native ? (m.native.content as { thinking: string }[])[0]!.thinking : "-"));
}

// A turn as Anthropic's adapter gives one back, its thinking in its own content, labelled.
const thought = (turn: Turn, label: string): Turn => ({ ...turn, native: { provider: "anthropic", content: [{ type: "thinking", thinking: label, signature: "s" }] } });

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "tachi-mcp-search-"));
  const made: Servers[] = [];
  onTestFinished(async () => {
    await Promise.all(made.map((s) => s.stopAll()));
    await removeTree(dir);
  });
  const bus = new Bus();
  const errors = collectErrors(bus);
  const notes: string[] = [];
  bus.on("mcp-note", (line) => notes.push(line));
  const outcomes: string[] = [];
  bus.on("tool-end", (e) => outcomes.push(e.outcome));
  let files = 0;
  const logs = new Map<string, string>();
  const user = { safe: "", where: "user" as const, trusted: null, trustedTools: [], alwaysLoad: false, written: "" };
  // A local server named `name` running a fake with `fake`'s options, logging to its own file, kept in `logs` by its name.
  const local = async (name: string, fake: FakeOptions = {}, over: Partial<ServerConfig> = {}): Promise<ServerConfig> => {
    const file = path.join(dir, `log-${++files}.jsonl`);
    logs.set(name, file);
    const script = await fakeServer(dir, { log: file, ...fake });
    return { ...user, name, safe: name, entry: { kind: "stdio", command: process.execPath, args: [script], env: {} }, ...over };
  };
  const make = (configs: ServerConfig[]) => {
    const answers = () => {
      throw new Error("no project server here, so no answers are read");
    };
    const servers = new Servers(configs, { root: dir, env: process.env, bus, answers, network: "none", lead: () => "fake:a" });
    made.push(servers);
    return servers;
  };
  const ready = async (configs: ServerConfig[]) => {
    const servers = make(configs);
    servers.startAll();
    await servers.ready();
    return servers;
  };
  // A fake that waits to answer until `open()` writes its gate file, so a test decides when it is ready.
  const gated = () => {
    const gate = path.join(dir, `gate-${++files}`);
    // Looked for every 20 ms: a test's own pause, short beside the wait for a process.
    const start = `const fs = require("node:fs"); const pause = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(${JSON.stringify(gate)})) Atomics.wait(pause, 0, 0, 20);`;
    return { start, open: () => writeFile(gate, "") };
  };
  // Every call is let through: Task 7's gate is not built yet.
  const asked: string[] = [];
  const approve: Approve = async (o) => void asked.push(o.spec.name);
  const ctx = { root: dir, executor: new LocalExecutor(), workspace: new LocalWorkspace(dir), gate: new PermissionGate("never", async () => false) };
  const session = (servers: Servers, turns: ConstructorParameters<typeof Model>[1], over: Partial<SessionOptions> = {}) => {
    const model = new Model("fake:a", turns);
    const mcp = mcpTools(servers, bus, approve);
    const s = new Session({ lead: model, tools: [own], system: "t", ctx, bus, mcp, ...over });
    return { session: s, model, mcp };
  };
  const results = (s: Session) => s.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "tool_result" ? [p.output] : [])));
  const calls = (name: string, tool: string) => readLog(logs.get(name)!).filter((m) => m.method === "tools/call" && m.params.name === tool);
  return { dir, bus, errors, notes, outcomes, logs, local, make, ready, gated, asked, approve, ctx, session, results, calls };
}

describe("tool_search: what a request carries", () => {
  it("carries tool_search and no MCP definitions, naming each server's tools under its instructions, and the servers not ready", async () => {
    const t = await setup();
    const servers = await t.ready([
      await t.local("a", { tools: apples, instructions: "Use a for apples." }),
      await t.local("b", { tools: [tool("echo")] }),
      await t.local("bad", { exit: 3 }),
    ]);
    const { session, model } = t.session(servers, [reply("ok")]);
    await session.send("go");
    expect(model.names(0)).toEqual(["own", "tool_search"]);
    const search = model.requests[0]![1]!;
    const not = "Not ready:\nbad: failed: it exited with code 3";
    expect(search.description).toBe(`${HEAD}\na: Use a for apples.\n  mcp__a__pick, mcp__a__peel\nb:\n  mcp__b__echo\n${not}`);
    expect(search.inputSchema).toMatchObject({ type: "object", properties: { query: { type: "string" }, max_results: { type: "integer" } }, required: ["query"] });
  });

  it("cuts a server's instructions at 4,096 characters", async () => {
    const t = await setup();
    const servers = await t.ready([await t.local("a", { tools: apples, instructions: `${"i".repeat(4_096)}MORE` })]);
    expect(servers.offer({ loaded: new Set() }).named[0]!.instructions).toBe("i".repeat(4_096));
  });

  it("has no tool_search with no MCP server", async () => {
    const t = await setup();
    const { session, model } = t.session(t.make([]), [reply("ok")]);
    await session.send("go");
    expect(model.names(0)).toEqual(["own"]);
  });

  // Choice 42: a server's alwaysLoad, or a tool's own _meta, loads it upfront, with the upfront cut.
  it("defines upfront the tools of a server with alwaysLoad, and one whose _meta asks for it, with the 4,096 cut", async () => {
    const t = await setup();
    const long = `${"d".repeat(4_096)}MORE`;
    const meta = tool("meta", long, { _meta: { "anthropic/alwaysLoad": true } });
    const servers = await t.ready([
      await t.local("u", { tools: [tool("one", long), tool("two")] }, { alwaysLoad: true }),
      await t.local("m", { tools: [meta, tool("plain")] }),
    ]);
    const { session, model } = t.session(servers, [reply("ok")]);
    await session.send("go");
    expect(model.names(0)).toEqual(["own", "tool_search", "mcp__u__one", "mcp__u__two", "mcp__m__meta"]);
    expect(model.requests[0]!.find((s) => s.name === "mcp__u__one")!.description).toBe("d".repeat(4_096));
    expect(model.requests[0]!.find((s) => s.name === "mcp__m__meta")!.description).toBe("d".repeat(4_096));
    expect(model.requests[0]![1]!.description).toBe(`${HEAD}\nm:\n  mcp__m__plain`);
  });
});

describe("tool_search: searching", () => {
  it("loads a tool found by a word of its description, which the next request defines and the model's call reaches", async () => {
    const t = await setup();
    const servers = await t.ready([await t.local("a", { tools: apples, results: fruit(apples) })]);
    const turns = [callTool("c1", "tool_search", { query: "peels" }), callTool("c2", "mcp__a__peel", {}), reply("done")];
    const { session, model, mcp } = t.session(servers, turns);
    await session.send("peel one");
    expect(t.results(session)).toEqual([loadedLine([entry("mcp__a__peel", "Peels an apple")]), "peeled"]);
    expect([model.names(0), model.names(1)]).toEqual([
      ["own", "tool_search"],
      ["own", "tool_search", "mcp__a__peel"],
    ]);
    expect(model.requests[1]![1]!.description).toBe(`${HEAD}\na:\n  mcp__a__pick`);
    expect([...mcp.loaded]).toEqual(["mcp__a__peel"]);
    expect([t.asked, t.calls("a", "peel").length, t.outcomes, t.errors]).toEqual([["mcp__a__peel"], 1, ["ok", "ok"], []]);
  });

  it("loads by select: a known name, saying an unknown one is not a tool, the found one still loaded", async () => {
    const t = await setup();
    const servers = await t.ready([await t.local("a", { tools: apples })]);
    const { session, mcp } = t.session(servers, [callTool("c1", "tool_search", { query: "select:mcp__a__pick, mcp__a__nope" }), reply("ok")]);
    await session.send("go");
    expect(t.results(session)).toEqual([`${loadedLine([entry("mcp__a__pick", "Picks an apple")])}\n\nNo MCP tool is named mcp__a__nope.`]);
    expect([...mcp.loaded]).toEqual(["mcp__a__pick"]);
  });

  it("lists a tool already loaded again and changes nothing", async () => {
    const t = await setup();
    const servers = await t.ready([await t.local("a", { tools: apples })]);
    const loaded = new Set(["mcp__a__pick"]);
    const search = searchTool(servers, loaded);
    expect(await search.run({ query: "select:mcp__a__pick" }, t.ctx)).toBe(loadedLine([entry("mcp__a__pick", "Picks an apple")]));
    expect([...loaded]).toEqual(["mcp__a__pick"]);
  });

  it("finds at most 5 tools unless asked for another number", async () => {
    const t = await setup();
    const seven = [1, 2, 3, 4, 5, 6, 7].map((n) => tool(`t${n}`, "the same"));
    const servers = await t.ready([await t.local("s", { tools: seven })]);
    const names = (text: string) => [...text.matchAll(/^(mcp__\S+):/gm)].map((m) => m[1]);
    expect(names((await searchTool(servers, new Set()).run({ query: "same" }, t.ctx)) as string)).toEqual([1, 2, 3, 4, 5].map((n) => `mcp__s__t${n}`));
    expect(names((await searchTool(servers, new Set()).run({ query: "same", max_results: 1 }, t.ctx)) as string)).toEqual(["mcp__s__t1"]);
  });

  // Choice 39 (Task 6b's spec review): the session cuts an answer at MAX_TOOL_OUTPUT, so only the tools that fit are loaded.
  describe("fitting the answer", () => {
    // Four tools of 12,000 characters each: two fit, a third would not.
    const long = [1, 2, 3, 4].map((n) => tool(`l${n}`, `long ${"x".repeat(12_000)}`));
    const full = (n: number) => `mcp__s__l${n}`;

    it("loads by select: only the tools that fit, naming the rest in its line", async () => {
      const t = await setup();
      const servers = await t.ready([await t.local("s", { tools: long })]);
      const loaded = new Set<string>();
      const query = `select:${[1, 2, 3, 4].map(full).join(",")},mcp__s__nope`;
      const text = (await searchTool(servers, loaded).run({ query }, t.ctx)) as string;
      expect(text.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT);
      expect(text.startsWith("Loaded 2 tools; call them from the next step on:\n")).toBe(true);
      expect(text.endsWith(`No MCP tool is named mcp__s__nope.\n\nNot loaded, as the answer is full: ${full(3)}, ${full(4)}; load them with another search.`)).toBe(true);
      expect([...loaded]).toEqual([full(1), full(2)]);
    });

    it("stops a word search at the last tool that fits, with no line", async () => {
      const t = await setup();
      const servers = await t.ready([await t.local("s", { tools: long })]);
      const loaded = new Set<string>();
      const text = (await searchTool(servers, loaded).run({ query: "long" }, t.ctx)) as string;
      expect(text).toBe(loadedLine([1, 2].map((n) => entry(full(n), long[n - 1]!.description))));
      expect([...loaded]).toEqual([full(1), full(2)]);
    });

    it("still loads one tool whose entry alone is over the limit, the session cutting it", async () => {
      const t = await setup();
      const inputSchema = { type: "object", properties: { a: { type: "string", description: "y".repeat(MAX_TOOL_OUTPUT) } } };
      const servers = await t.ready([await t.local("s", { tools: [{ ...tool("huge"), inputSchema }, tool("small")] })]);
      const loaded = new Set<string>();
      const text = (await searchTool(servers, loaded).run({ query: "select:mcp__s__huge,mcp__s__small" }, t.ctx)) as string;
      expect(text.length).toBeGreaterThan(MAX_TOOL_OUTPUT);
      expect(text.startsWith("Loaded 1 tool; call it from the next step on:\nmcp__s__huge: huge\n")).toBe(true);
      expect(text.endsWith("Not loaded, as the answer is full: mcp__s__small; load them with another search.")).toBe(true);
      expect([...loaded]).toEqual(["mcp__s__huge"]);
    });
  });

  it("says no tool matched, listing a failed server and one needing sign-in", async () => {
    const t = await setup();
    // No server needs a sign-in until Task 11, so this one's state is given.
    const signIn = { server: "figma", state: { is: "needs sign-in" as const } };
    const failed = { server: "bad", state: { is: "failed" as const, reason: "it exited with code 3" } };
    const offer: Offer = { defined: [], named: [], notReady: [failed, signIn] };
    const servers = { offer: () => offer, ready: async () => true, list: () => [] } as unknown as Servers;
    expect(await searchTool(servers, new Set()).run({ query: "draw a frame" }, t.ctx)).toBe(
      'No MCP tool matched "draw a frame".\nNot ready:\nbad: failed: it exited with code 3\nfigma: needs sign-in, which the user does from /mcp',
    );
  });

  // Choice 40: as Claude Code's does, within the 30 s start, and stopped by Esc.
  it("waits for a server still starting, then searches what is ready", async () => {
    const t = await setup();
    const gate = t.gated();
    const servers = t.make([await t.local("late", { tools: apples, start: gate.start })]);
    servers.startAll();
    let done = false;
    const found = searchTool(servers, new Set()).run({ query: "peel" }, t.ctx);
    void found.then(() => (done = true));
    await new Promise((r) => setTimeout(r, 100));
    expect(done).toBe(false);
    await gate.open();
    expect(await found).toBe(loadedLine([entry("mcp__late__peel", "Peels an apple")]));
  });

  it("stops the wait at Esc, as any tool's", async () => {
    const t = await setup();
    const gate = t.gated();
    const servers = t.make([await t.local("late", { tools: apples, start: gate.start })]);
    servers.startAll();
    const stop = new AbortController();
    // Once the search is waiting: a test's own pause, as above.
    t.bus.on("tool-start", () => void setTimeout(() => stop.abort(), 100));
    const { session } = t.session(servers, [callTool("c1", "tool_search", { query: "peel" })]);
    await session.send("go", stop.signal);
    expect([t.results(session), t.outcomes, t.errors]).toEqual([["Cancelled by the user."], ["cancelled"], []]);
    // The wait it stopped was the search's, so the server, still starting then, says when it is ready.
    expect(servers.list()[0]!.state.is).toBe("starting");
    await gate.open();
    await vi.waitFor(() => expect(t.notes).toEqual(["MCP server late is ready: 2 tools."]), { timeout: 5_000 });
  });

  // The user's choice (Task 6b's spec review): words held anywhere first, then words in the name, then the order offered.
  it("ranks by the words held in a name or description, then by those in the name, letter case ignored, ties in the order offered", () => {
    const tools = [
      { full: "mcp__s__list", description: "Lists the files to read" },
      { full: "mcp__s__other", description: "Nothing here" },
      { full: "mcp__s__file_info", description: "Tells of a file" },
      { full: "mcp__s__read_file", description: "Reads a file" },
      { full: "mcp__s__file_size", description: "Sizes" },
    ];
    expect(find("READ file", 5, tools)).toEqual(["mcp__s__read_file", "mcp__s__list", "mcp__s__file_info", "mcp__s__file_size"]);
    expect(find("read file", 1, tools)).toEqual(["mcp__s__read_file"]);
    expect(find("nothing", 5, tools)).toEqual(["mcp__s__other"]);
    expect(find("zebra", 5, tools)).toEqual([]);
    // A description holding both words ranks above a name holding one.
    const two = [
      { full: "mcp__s__list", description: "Shows names" },
      { full: "mcp__s__dir", description: "Lists the files here" },
    ];
    expect(find("list files", 5, two)).toEqual(["mcp__s__dir", "mcp__s__list"]);
  });
});

// Choices 8 and 39: each view cuts the whole text, and the definition is the whole text, so loading never looks like a change.
describe("tool_search: the cuts", () => {
  it("cuts upfront and for the judge at 4,096, a search's load at 16,384, which a word past 4,096 finds, and calls it as the same tool", async () => {
    const t = await setup();
    const long = `${"d".repeat(4_096)}MARKER${"e".repeat(20_000)}`;
    const results = { long: answered("done long") };
    const servers = await t.ready([
      await t.local("up", { tools: [tool("long", long)], results }, { alwaysLoad: true }),
      await t.local("s", { tools: [tool("long", long)], results }),
    ]);
    const offered = servers.offer({ loaded: new Set() });
    const upfront = offered.defined[0]!;
    expect([upfront.spec.name, upfront.spec.description, upfront.forJudge]).toEqual(["mcp__up__long", "d".repeat(4_096), "d".repeat(4_096)]);
    const searched = long.slice(0, 16_384);
    const turns = [callTool("c1", "tool_search", { query: "marker" }), callTool("c2", "mcp__s__long", {}), reply("done")];
    const { session, model, mcp } = t.session(servers, turns);
    await session.send("go");
    expect(t.results(session)).toEqual([loadedLine([entry("mcp__s__long", searched)]), "done long"]);
    expect(model.requests[1]!.find((s) => s.name === "mcp__s__long")!.description).toBe(searched);
    expect(model.requests[1]!.find((s) => s.name === "mcp__up__long")!.description).toBe("d".repeat(4_096));
    const loaded = servers.offer({ loaded: mcp.loaded }).defined.find((o) => o.spec.name === "mcp__s__long")!;
    expect([loaded.spec.description, loaded.forJudge, servers.current(loaded)]).toEqual([searched, "d".repeat(4_096), "same"]);
    expect(loaded.definition).toBe(servers.offer({ loaded: new Set() }).named[0]!.tools[0]!.definition);
    expect(t.asked).toEqual(["mcp__s__long"]);
  });
});

describe("tool_search: the loaded set", () => {
  // Choice 41: saved after the result's line, read back by a resume (and /branch, which reads a copy), emptied by /clear.
  it("is saved in the transcript after the result, read back by a resume, and empty after /clear", async () => {
    const t = await setup();
    const servers = await t.ready([await t.local("a", { tools: apples })]);
    const folder = path.join(t.dir, "sessions", "project");
    const [file, pictures] = [path.join(folder, "s1.jsonl"), path.join(folder, "s1", "pictures")];
    const transcript = new Transcript(file, pictures, { inherits: true });
    transcript.write({ t: "start", v: 1, id: "s1", project: t.dir, lead: "fake:a", version: "0.8.0", print: false, system: "t", tools: [] });
    const first = t.session(servers, [callTool("c1", "tool_search", { query: "select:mcp__a__peel" }), reply("ok")], { transcript });
    await first.session.send("go");
    const kinds = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    // Each request whose tools differ from the last saved writes a tools line before its reply (the quality review).
    expect(kinds.map((l) => l.t)).toEqual(["start", "message", "tools", "message", "message", "loaded", "tools", "message"]);
    expect(kinds[4]!.message.parts[0].type).toBe("tool_result");
    expect(kinds[5]!.names).toEqual(["mcp__a__peel"]);
    expect([kinds[2], kinds[6]].map((l) => l.tools.map((s: ToolSpec) => s.name))).toEqual([
      ["own", "tool_search"],
      ["own", "tool_search", "mcp__a__peel"],
    ]);
    const r = readTranscript(file, pictures);
    if ("problem" in r) throw new Error(r.problem);
    expect(r.loaded).toEqual(["mcp__a__peel"]);

    const again = t.session(servers, [reply("resumed"), reply("cleared")]);
    const { messages, system, prompts, calls, nextPicture, nextTask, loaded } = r;
    again.session.load({ id: "s1", messages, system, prompts, calls, nextPicture, nextTask, loaded });
    await again.session.send("more");
    expect(again.model.names(0)).toEqual(["own", "tool_search", "mcp__a__peel"]);
    again.session.load({ id: "s2", messages: [], system: "t", prompts: [], calls: [], nextPicture: 1, nextTask: 1 });
    await again.session.send("fresh");
    expect([again.model.names(1), again.mcp.loaded.size]).toEqual([["own", "tool_search"], 0]);
  });

  // Choice 43: a subagent's search is over its trusted read-only tools, its loaded set its own, starting with none.
  it("gives a subagent its own search over its trusted tools only, the lead's set not its own", async () => {
    const t = await setup();
    const servers = await t.ready([await t.local("a", { tools: apples }, { trustedTools: ["pick"] })]);
    const lead = mcpTools(servers, t.bus, t.approve);
    lead.loaded.add("mcp__a__peel");
    const worker = new Model("fake:w", [callTool("c1", "tool_search", { query: "apple" }), reply("found it")]);
    const tasks = new Tasks({
      bus: t.bus,
      max: 1,
      worker: () => worker,
      system: "sub",
      tools: [],
      ctx: t.ctx,
      mcp: () => mcpTools(servers, t.bus, t.approve, { trustedOnly: true }),
    });
    const task = tasks.start("look", { background: false });
    expect(await task.done).toEqual({ state: "done", text: "found it" });
    expect(worker.names(0)).toEqual(["tool_search"]);
    expect(worker.requests[0]![0]!.description).toBe(`${HEAD}\na:\n  mcp__a__pick`);
    expect(worker.names(1)).toEqual(["tool_search", "mcp__a__pick"]);
    const result = task.messages[2]!.parts[0]!;
    expect(result).toMatchObject({ type: "tool_result", output: loadedLine([entry("mcp__a__pick", "Picks an apple")]) });
    expect([...lead.loaded]).toEqual(["mcp__a__peel"]);
  });
});

describe("tool_search: hooks and providers", () => {
  it("is ToolSearch to a PreToolUse hook, which sees its query and max_results", async () => {
    const t = await setup();
    const servers = await t.ready([await t.local("a", { tools: apples })]);
    const out = path.join(t.dir, "hook.jsonl");
    const script = path.join(t.dir, "hook.cjs");
    // The hook adds its input to the file named by its argument.
    writeFileSync(script, 'let t = ""; process.stdin.on("data", (d) => (t += d)).on("end", () => require("fs").appendFileSync(process.argv[2], t));');
    const hook = { event: "PreToolUse" as const, matcher: matcherOf("ToolSearch"), command: process.execPath, args: [script, out], async: false, where: '"PreToolUse"' };
    const where = { sessionId: () => "s1", transcript: () => undefined, root: t.dir, mode: () => "never" as const, effort: () => undefined };
    const hooks = new Hooks({ hooks: [hook], off: false, leftOut: [] }, { ...where, lead: () => "fake:a" }, t.bus);
    const { session } = t.session(servers, [callTool("c1", "tool_search", { query: "peel", max_results: 2 }), reply("ok")], { hooks });
    await session.send("go");
    const fired = { hook_event_name: "PreToolUse", tool_name: "ToolSearch", tool_input: { query: "peel", max_results: 2 }, tool_use_id: "c1" };
    expect(readLog(out)).toEqual([expect.objectContaining(fired)]);
  });

  it("sends the same tools to Anthropic and, after a /lead switch, to an OpenAI-format lead", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    onTestFinished(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });
    // No window lookup reaches Anthropic: one that fails counts as not known (anthropic.ts, contextWindow).
    vi.spyOn(Models.prototype, "retrieve").mockRejectedValue(new Error("no network in tests"));
    // Shaped like a real response; only the fields the adapter reads are filled in.
    const answer = {
      ...{ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }] },
      stop_reason: "end_turn",
      stop_details: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } as unknown as BetaMessage;
    const anthropic = vi.spyOn(Messages.prototype, "stream").mockReturnValue({ finalMessage: async () => answer } as never);
    const ok = { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
    const openai = vi.spyOn(Completions.prototype, "create").mockResolvedValue(ok as never);
    const t = await setup();
    const servers = await t.ready([await t.local("a", { tools: apples })]);
    const { session, mcp } = t.session(servers, [], { lead: new AnthropicProvider("claude-opus-5-5") });
    mcp.loaded.add("mcp__a__peel");
    await session.send("one");
    session.setLead(new OpenAIProvider("openai", "gpt-5"));
    await session.send("two");
    const names = ["own", "tool_search", "mcp__a__peel"];
    expect((anthropic.mock.calls[0]![0] as unknown as { tools: { name: string }[] }).tools.map((x) => x.name)).toEqual(names);
    expect((openai.mock.calls[0]![0] as unknown as { tools: { function: { name: string } }[] }).tools.map((x) => x.function.name)).toEqual(names);
  });
});

// Task 6b's quality review (the user's choice, "Drop older thinking"): Anthropic binds each thinking block to the system
// prompt, the set of tools and the messages before it, and lets thinking be removed only as a leading run, so a reply
// keeps its thinking only in the trailing run of replies made under the request's own set.
describe("tool_search: thinking under a changed tool set", () => {
  it("sends the replies made before a search's change without their thinking, keeping it from the new set's first step on", async () => {
    const t = await setup();
    const servers = await t.ready([await t.local("a", { tools: apples, results: fruit(apples) })]);
    const turns = [
      thought(callTool("c1", "tool_search", { query: "select:mcp__a__peel" }), "r1"),
      thought(callTool("c2", "mcp__a__peel", {}), "r2"),
      thought(reply("peeled"), "r3"),
      thought(reply("again"), "r4"),
    ];
    const { session, model } = t.session(servers, turns);
    await session.send("peel one");
    await session.send("and again");
    expect([0, 1, 2, 3].map((i) => model.thinking(i))).toEqual([[], ["-"], ["-", "r2"], ["-", "r2", "r3"]]);
    // Its words and calls stay, so every call keeps its result.
    expect(model.sent[1]![1]).toMatchObject({ role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "tool_search" }] });
    expect(model.sent[1]![2]!.parts[0]).toMatchObject({ type: "tool_result", callId: "c1" });
  });

  it("does the same when a server ready late changes the set", async () => {
    const t = await setup();
    const gate = t.gated();
    const servers = t.make([await t.local("a", { tools: apples }), await t.local("late", { tools: [tool("echo")], start: gate.start })]);
    servers.startAll();
    await vi.waitFor(() => expect(servers.list()[0]!.state.is).toBe("ready"), { timeout: 5_000 });
    // The late server is ready once the first request is made, so the second's set has its tools.
    const late = async () => {
      await gate.open();
      await servers.ready();
      return thought(callTool("c1", "own", {}), "r1");
    };
    const { session, model } = t.session(servers, [late, thought(callTool("c2", "own", {}), "r2"), thought(reply("done"), "r3")]);
    await session.send("go");
    expect(model.requests[0]![1]!.description).toContain("Not ready:\nlate: starting");
    expect(model.requests[1]![1]!.description).toContain("late:\n  mcp__late__echo");
    expect([1, 2].map((i) => model.thinking(i))).toEqual([["-"], ["-", "r2"]]);
  });

  it("keeps every reply's thinking while the set does not change", async () => {
    const t = await setup();
    const servers = await t.ready([await t.local("a", { tools: apples })]);
    const { session, model } = t.session(servers, [thought(callTool("c1", "own", {}), "r1"), thought(reply("one"), "r2"), thought(reply("two"), "r3")]);
    await session.send("go");
    await session.send("more");
    expect([1, 2].map((i) => model.thinking(i))).toEqual([["r1"], ["r1", "r2"]]);
  });

  // A set that changes and changes back: the replies made under the first A lose theirs too, as the B replies after them
  // do, so nothing is removed from the middle.
  it("strips nothing from the middle when the set goes from A to B and back to A", async () => {
    const t = await setup();
    let set = "A";
    const mcp: McpTools = {
      loaded: new Set(),
      offer: () => ({ defined: [], search: { spec: { name: "tool_search", description: set, inputSchema: OBJECT }, run: async () => "" } }),
      tool: () => {
        throw new Error("no MCP tool here");
      },
    };
    // The reply, and the set the next request is made under.
    const then = (next: string, turn: Turn) => async () => {
      set = next;
      return turn;
    };
    const model = new Model("fake:a", [
      then("B", thought(callTool("c1", "own", {}), "a1")),
      then("A", thought(callTool("c2", "own", {}), "b1")),
      thought(callTool("c3", "own", {}), "a2"),
      thought(reply("done"), "a3"),
    ]);
    const session = new Session({ lead: model, tools: [own], system: "t", ctx: t.ctx, bus: t.bus, mcp });
    await session.send("go");
    expect([1, 2, 3].map((i) => model.thinking(i))).toEqual([["-"], ["-", "-"], ["-", "-", "a2"]]);
  });

  // Release 8a's resume rule is the same one, so a resume sends what the live session would have.
  it("sends after a resume what the live session sends, the change before it included", async () => {
    const t = await setup();
    const servers = await t.ready([await t.local("a", { tools: apples, results: fruit(apples) })]);
    const folder = path.join(t.dir, "sessions", "project");
    const [file, pictures] = [path.join(folder, "s1.jsonl"), path.join(folder, "s1", "pictures")];
    const transcript = new Transcript(file, pictures, { inherits: true });
    transcript.write({ t: "start", v: 1, id: "s1", project: t.dir, lead: "fake:a", version: "0.8.0", print: false, system: "t", tools: [] });
    const turns = [
      thought(callTool("c1", "tool_search", { query: "select:mcp__a__peel" }), "r1"),
      thought(callTool("c2", "mcp__a__peel", {}), "r2"),
      thought(reply("peeled"), "r3"),
      thought(reply("again"), "r4"),
    ];
    const live = t.session(servers, turns, { transcript });
    await live.session.send("peel one");
    const r = readTranscript(file, pictures);
    if ("problem" in r) throw new Error(r.problem);
    await live.session.send("and again");

    const resumed = t.session(servers, [thought(reply("again"), "r4")]);
    const { messages } = r.withTools(r.tools, r.system);
    const { system, prompts, calls, nextPicture, nextTask, loaded, tools } = r;
    resumed.session.load({ id: "s1", messages, system, prompts, calls, nextPicture, nextTask, loaded, tools });
    await resumed.session.send("and again");
    expect(resumed.model.thinking(0)).toEqual(["-", "r2", "r3"]);
    expect([resumed.model.thinking(0), resumed.model.names(0)]).toEqual([live.model.thinking(3), live.model.names(3)]);
  });
});
