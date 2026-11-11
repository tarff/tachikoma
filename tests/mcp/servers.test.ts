import { mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type BetaMessage, Messages } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { projectFile, SETTINGS } from "../../src/core/datadir.js";
import { running } from "../../src/exec/local.js";
import { type Answers, answersFor } from "../../src/mcp/answers.js";
import { readServers, type ServerConfig } from "../../src/mcp/config.js";
import { NotReached } from "../../src/mcp/server.js";
import { type Offered, Servers } from "../../src/mcp/servers.js";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import { Bus, collectErrors, removeTree } from "../helpers.js";
import { type FakeOptions, fakeServer, httpFake, readLog } from "./fake.js";

// Release 8c plan, Task 5: the servers together, one table of unique names, against the fake servers of fake.ts.

// A wait on another process: a few seconds for a busy machine, well inside the test's 15 s.
const WAIT = { timeout: 5_000 };
const TEN = ["echo", "error", "picture", "structured", "slow", "progress", "whoami", "ask", "change", "exit"];
const tool = (name: string, inputSchema: object = { type: "object" }, description = name) => ({ name, description, inputSchema });
const plain = tool("plain", { type: "object", properties: { x: { type: "number" } } });
const nobody = (): Answers => {
  throw new Error("no project server here, so no answers are read");
};

// The test's own folder, the project's root, and its Servers, each stopped before the folder is removed: on Windows a
// running server holds the folder it works in.
async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "tachi-mcp-servers-"));
  const made: Servers[] = [];
  onTestFinished(async () => {
    await Promise.all(made.map((s) => s.stopAll()));
    await removeTree(dir);
  });
  const bus = new Bus();
  const notes: string[] = [];
  bus.on("mcp-note", (line) => notes.push(line));
  const errors = collectErrors(bus);
  let files = 0;
  const logs = new Map<string, string>();
  // A server named `name` running a fake with `fake`'s options, logging to its own file, kept in `logs` by its name.
  const config = async (name: string, fake: FakeOptions = {}, over: Partial<ServerConfig> = {}): Promise<ServerConfig> => {
    const log = path.join(dir, `log-${++files}.jsonl`);
    logs.set(name, log);
    const script = await fakeServer(dir, { log, ...fake });
    const safe = name.replace(/[^A-Za-z0-9_-]/g, "_");
    const entry = { kind: "stdio" as const, command: process.execPath, args: [script], env: {} };
    return { name, safe, where: "user", trusted: null, trustedTools: [], alwaysLoad: false, written: "", entry, asWritten: entry, ...over };
  };
  const make = (configs: ServerConfig[], opts: { answers?: () => Answers; unread?: Answers; network?: "on" | "off" | "none" } = {}) => {
    const answers = opts.answers ?? nobody;
    const unread = opts.unread ? { unread: opts.unread } : {};
    const servers = new Servers(configs, { root: dir, env: process.env, bus, answers, ...unread, network: opts.network ?? "none", lead: () => "fake:a" });
    made.push(servers);
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
  return { dir, bus, notes, errors, logs, config, make, gated };
}

// Every tool an offer gives, none loaded through a search (Task 6b): those loaded upfront, then the ones it names.
const every = (servers: Servers, opts: { trustedOnly?: boolean } = {}) => {
  const o = servers.offer({ loaded: new Set(), ...opts });
  return [...o.defined, ...o.named.flatMap((n) => n.tools)];
};
const names = (offered: Offered[]) => offered.map((o) => o.spec.name);
const owner = (offered: Offered[], name: string) => offered.filter((o) => o.spec.name === name).map((o) => `${o.server} ${o.tool}`);
const stateOf = (servers: Servers, name: string) => servers.list().find((s) => s.name === name)?.state;
const initializes = (log: string) => readLog(log).filter((m) => m.method === "initialize").length;

describe("Servers: names", () => {
  // 8 characters of mcp__s__, then the tool's own.
  it("leaves out a name over 64 characters with its line, keeping one of 64 and the server's other tools", async () => {
    const { notes, errors, config, make } = await setup();
    const t64 = "t".repeat(56);
    const t65 = "u".repeat(57);
    const servers = make([await config("s", { tools: [tool(t64), tool(t65), plain] })]);
    servers.startAll();
    expect(await servers.ready()).toBe(true);
    expect(names(every(servers))).toEqual([`mcp__s__${t64}`, "mcp__s__plain"]);
    expect(`mcp__s__${t64}`).toHaveLength(64);
    expect(notes).toEqual([`MCP server s: "${t65}" was left out: its name mcp__s__${t65} is 65 characters, over the 64 every provider takes`]);
    expect(errors).toEqual([]);
  });

  // release 8c design, finding 2: the character rule is not one-to-one.
  it("gives foo.bar and foo_bar one name, leaving out the later with a line naming the earlier; the same tool twice too", async () => {
    const { notes, config, make } = await setup();
    const servers = make([await config("s", { tools: [tool("foo.bar"), tool("foo_bar"), plain, tool("plain", { type: "object" }, "again")] })]);
    servers.startAll();
    await servers.ready();
    const offered = every(servers);
    expect(names(offered)).toEqual(["mcp__s__foo_bar", "mcp__s__plain"]);
    expect(owner(offered, "mcp__s__foo_bar")).toEqual(["s foo.bar"]);
    expect(offered[1]!.spec.description).toBe("plain");
    expect(notes).toEqual([
      'MCP server s: "foo_bar" was left out: its name mcp__s__foo_bar is already s\'s "foo.bar"',
      'MCP server s: "plain" was left out: its name mcp__s__plain is already s\'s "plain"',
    ]);
  });

  it("offers server a's tool b__c as mcp__a__b__c, server a__b being left out by the settings, so nothing collides", async () => {
    const { notes, config, make } = await setup();
    const a = await config("a", { tools: [tool("b__c")] });
    const ab = await config("a__b", { tools: [tool("c")] });
    const warnings: string[] = [];
    const entry = (c: ServerConfig) => c.entry as Extract<ServerConfig["entry"], { kind: "stdio" }>;
    const written = (c: ServerConfig) => ({ command: entry(c).command, args: entry(c).args });
    const configs = readServers(SETTINGS, { a__b: written(ab), a: written(a) }, {}, warnings);
    expect(warnings).toEqual([
      'settings.json: "mcpServers": "a__b" has a name that holds "__" once its characters are made safe, which tool names cannot carry; it was left out',
    ]);
    const servers = make(configs);
    servers.startAll();
    await servers.ready();
    expect(every(servers).map((o) => [o.spec.name, o.server, o.tool])).toEqual([["mcp__a__b__c", "a", "b__c"]]);
    expect(notes).toEqual([]);
  });

  it("leaves out the later server's tools, in the order the configs are given, when two come ready together", async () => {
    const { notes, config, make } = await setup();
    const servers = make([await config("x.y"), await config("x_y")]);
    servers.startAll();
    await servers.ready();
    const offered = every(servers);
    expect(owner(offered, "mcp__x_y__echo")).toEqual(["x.y echo"]);
    expect(offered).toHaveLength(10);
    expect(notes).toEqual(TEN.map((t) => `MCP server x_y: "${t}" was left out: its name mcp__x_y__${t} is already x.y's "${t}"`));
  });

  // Choice 7: a name already offered keeps its owner, so a late server never takes it, though its config comes first.
  it("keeps a name already offered for its owner when an earlier server is ready late", async () => {
    const { notes, config, make, gated } = await setup();
    const gate = gated();
    const servers = make([await config("x.y", { start: gate.start }), await config("x_y")]);
    servers.startAll();
    await vi.waitFor(() => expect(stateOf(servers, "x_y")?.is).toBe("ready"), WAIT);
    expect(owner(every(servers), "mcp__x_y__echo")).toEqual(["x_y echo"]);
    await gate.open();
    expect(await servers.ready()).toBe(true);
    expect(owner(every(servers), "mcp__x_y__echo")).toEqual(["x_y echo"]);
    expect(notes).toEqual(TEN.map((t) => `MCP server x.y: "${t}" was left out: its name mcp__x_y__${t} is already x_y's "${t}"`));
  });

  // Choice 7 for a changed list: the new tool comes first in the list, and still does not take the name in force.
  it("leaves out a changed list's new tool whose name is in force, with its line", async () => {
    const { notes, config, make } = await setup();
    const servers = make([await config("s", { tools: [tool("foo_bar"), tool("change")], added: [tool("foo.bar"), plain] })]);
    servers.startAll();
    await servers.ready();
    expect(names(every(servers))).toEqual(["mcp__s__foo_bar", "mcp__s__change"]);
    await servers.server("s")!.callTool("change", {}, {});
    await vi.waitFor(() => expect(notes).toEqual(['MCP server s: "foo.bar" was left out: its name mcp__s__foo_bar is already s\'s "foo_bar"']), WAIT);
    const offered = every(servers);
    expect(names(offered)).toEqual(["mcp__s__plain", "mcp__s__foo_bar", "mcp__s__change"]);
    expect(owner(offered, "mcp__s__foo_bar")).toEqual(["s foo_bar"]);
    expect(notes).toHaveLength(1); // said once, not again at the next offer
  });

  // Choice 1 and choice 8: the spec is cut, the definition is the whole text, so a view's cut never looks like a change.
  // Loaded upfront, as a search's load has its own cut (Task 6b).
  it("cuts each description at 4,096 characters, and builds the definition from the whole text", async () => {
    const { config, make } = await setup();
    const servers = make([await config("s", { description: `${"d".repeat(4_096)}MARK` }, { alwaysLoad: true })]);
    servers.startAll();
    await servers.ready();
    const echo = every(servers).find((o) => o.tool === "echo")!;
    expect(echo.spec.description).toBe("d".repeat(4_096));
    expect(echo.definition).toContain("MARK");
    expect(echo.spec.inputSchema).toEqual({ type: "object", properties: { text: { type: "string" } } });
  });

  // Task 5's code review: half an emoji is not valid text, which a provider may refuse with the whole request.
  it("never ends the cut on the first half of an emoji", async () => {
    const { config, make } = await setup();
    const servers = make([await config("s", { description: `${"d".repeat(4_095)}${String.fromCodePoint(0x1f600)}after` }, { alwaysLoad: true })]);
    servers.startAll();
    await servers.ready();
    expect(every(servers).find((o) => o.tool === "echo")!.spec.description).toBe("d".repeat(4_095));
  });

  // Task 5's code review: lines are said at the start and when a list changes, not at each new connection; a live edit's
  // restart is a server started anew, so it says its lines again.
  it("says a left-out line once while its list stands, and again when a live edit restarts the server", async () => {
    const { notes, config, make } = await setup();
    const bad = tool("bad", { type: "object", properties: { "has space": {} } });
    const s = await config("s", { tools: [plain, bad, tool("change")], added: [tool("other")] });
    const servers = make([s]);
    servers.startAll();
    await servers.ready();
    const line = 'MCP server s: "bad" was left out: its input schema has the property name "has space", which providers do not take ' +
      '(1 to 64 letters, digits, "_", "." or "-")';
    expect(notes).toEqual([line]);
    await servers.server("s")!.callTool("change", {}, {});
    await vi.waitFor(() => expect(every(servers).map((o) => o.tool)).toEqual(["other", "plain", "change"]), WAIT);
    expect(notes).toEqual([line]);
    const entry = s.entry as Extract<ServerConfig["entry"], { kind: "stdio" }>;
    servers.set([{ ...s, entry: { ...entry, args: [...entry.args, "again"] } }]);
    await servers.ready();
    expect(notes).toEqual([line, line]);
  });
});

describe("Servers: schemas (choice 36)", () => {
  const branch = (properties: object, required?: string[]) => ({ properties, ...(required && { required }) });
  const sets = [branch({ a: { type: "string" }, b: {} }, ["a", "b"]), branch({ c: {} }, ["c"]), branch({ d: {} })];
  const pick = tool("pick", { type: "object", properties: { mode: { type: "string" } }, anyOf: sets }, "Picks.");
  const either = tool("either", { type: "object", oneOf: [branch({ a: {} }, ["a"]), branch({ b: {} }, ["b"])] }, "Either.");
  const both = tool("both", { type: "object", required: ["r"], properties: { r: {} }, allOf: [branch({ p: {} }, ["p"]), branch({ q: {} }, ["q"])] }, "Both.");
  const notObject = tool("notObject", { type: "object", anyOf: [{ type: "string" }] });
  const badName = tool("badName", { type: "object", properties: { "has space": {} } });
  const broken = tool("broken", { type: "object", properties: { a: { type: "nope" } } });
  const left = [
    'MCP server s: "notObject" was left out: its input schema is not an object schema',
    'MCP server s: "badName" was left out: its input schema has the property name "has space", which providers do not take ' +
      '(1 to 64 letters, digits, "_", "." or "-")',
    'MCP server s: "broken" was left out: its input schema could not be read (type must be JSONType or JSONType[]: nope)',
  ];
  const flattened = (offered: Offered[]) => Object.fromEntries(offered.map((o) => [o.tool, { description: o.spec.description, schema: o.spec.inputSchema }]));
  const expected = {
    pick: {
      description: "This tool takes one of these sets of parameters: a, b; c; or (none needed). Picks.",
      schema: { type: "object", properties: { mode: { type: "string" }, a: { type: "string" }, b: {}, c: {}, d: {} } },
    },
    either: { description: "This tool takes one of these sets of parameters: a; or b. Either.", schema: { type: "object", properties: { a: {}, b: {} } } },
    both: { description: "Both.", schema: { type: "object", required: ["r", "p", "q"], properties: { r: {}, p: {}, q: {} } } },
    plain: { description: "plain", schema: plain.inputSchema },
  };

  it("flattens a root anyOf, oneOf or allOf into one object schema, the first two with their sentence, beside an ordinary tool", async () => {
    const { notes, config, make } = await setup();
    const servers = make([await config("s", { tools: [pick, either, both, plain] })]);
    servers.startAll();
    await servers.ready();
    expect(flattened(every(servers))).toEqual(expected);
    expect(notes).toEqual([]);
  });

  it("leaves out a schema that is not an object schema, has a property name providers refuse, or cannot be compiled, with their lines", async () => {
    const { notes, config, make } = await setup();
    const servers = make([await config("s", { tools: [notObject, badName, broken, plain] })]);
    servers.startAll();
    await servers.ready();
    expect(every(servers).map((o) => o.tool)).toEqual(["plain"]);
    expect(notes).toEqual(left);
  });

  // Task 5's code review: a sentence naming no parameter in any set tells the model nothing.
  it("says no sentence when no branch requires anything", async () => {
    const { config, make } = await setup();
    const any = tool("any", { type: "object", anyOf: [branch({ a: {} }), branch({ b: {} })] }, "Any.");
    const servers = make([await config("s", { tools: [any] })]);
    servers.startAll();
    await servers.ready();
    expect(flattened(every(servers))).toEqual({ any: { description: "Any.", schema: { type: "object", properties: { a: {}, b: {} } } } });
  });

  // Task 5's code review: for a format it does not know (Pydantic writes "path"), the library's checker warns on the
  // console with the server's own text, which would reach the terminal raw; a compile that fails warns first too.
  it("checks a schema with a format the checker does not know with nothing on the console, kept or left out", async () => {
    const { notes, config, make } = await setup();
    const warn = vi.spyOn(console, "warn");
    onTestFinished(() => warn.mockRestore());
    const path_ = { type: "string", format: "path" };
    const where = tool("where", { type: "object", properties: { file: path_ } });
    const failing = tool("failing", { type: "object", properties: { file: path_, n: { type: "nope" } } });
    const servers = make([await config("s", { tools: [where, failing] })]);
    servers.startAll();
    await servers.ready();
    expect(every(servers).map((o) => o.tool)).toEqual(["where"]);
    expect(notes).toEqual(['MCP server s: "failing" was left out: its input schema could not be read (type must be JSONType or JSONType[]: nope)']);
    expect(warn).not.toHaveBeenCalled();
    expect(console.warn).toBe(warn);
  });

  // The library's checker keeps each compiled schema by its $id, so a shared one would pass a broken schema reusing one.
  it("checks each schema on its own, so a broken one reusing an earlier $id is still left out", async () => {
    const { notes, config, make } = await setup();
    const id = "https://example.com/schema";
    const good = tool("good", { $id: id, type: "object", properties: { a: { type: "string" } } });
    const reused = tool("reused", { $id: id, type: "object", properties: { a: { type: "nope" } } });
    const servers = make([await config("s", { tools: [good, reused] })]);
    servers.startAll();
    await servers.ready();
    expect(every(servers).map((o) => o.tool)).toEqual(["good"]);
    expect(notes).toEqual(['MCP server s: "reused" was left out: its input schema could not be read (type must be JSONType or JSONType[]: nope)']);
  });

  it("does the same for tools arriving by a list change", async () => {
    const { notes, config, make } = await setup();
    const servers = make([await config("s", { tools: [plain, tool("change")], added: [pick, either, both, notObject, badName, broken] })]);
    servers.startAll();
    await servers.ready();
    expect(every(servers).map((o) => o.tool)).toEqual(["plain", "change"]);
    await servers.server("s")!.callTool("change", {}, {});
    await vi.waitFor(() => expect(notes).toEqual(left), WAIT);
    expect(flattened(every(servers))).toEqual({ ...expected, change: { description: "change", schema: { type: "object" } } });
  });

  // The session is wired to Servers in Task 6, so this is shown where the request is built: Anthropic's adapter.
  it("sends Anthropic only object schemas at the root, no anyOf, oneOf or allOf among them", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    // Shaped like a real response; only the fields the adapter reads are filled in.
    const reply = {
      id: "m",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      stop_reason: "end_turn",
      stop_details: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } as unknown as BetaMessage;
    const stream = vi.spyOn(Messages.prototype, "stream").mockReturnValue({ finalMessage: async () => reply } as never);
    onTestFinished(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });
    const { config, make } = await setup();
    const servers = make([await config("s", { tools: [pick, either, both, notObject, badName, broken, plain] })]);
    servers.startAll();
    await servers.ready();
    await new AnthropicProvider("claude-opus-5-5").complete({ system: "s", messages: [], tools: every(servers).map((o) => o.spec) });
    const sent = (stream.mock.calls[0]![0] as unknown as { tools: { name: string; input_schema: Record<string, unknown> }[] }).tools;
    expect(sent.map((t) => t.name)).toEqual(["mcp__s__pick", "mcp__s__either", "mcp__s__both", "mcp__s__plain"]);
    for (const t of sent) {
      expect(t.input_schema.type).toBe("object");
      expect(Object.keys(t.input_schema).filter((k) => ["anyOf", "oneOf", "allOf"].includes(k))).toEqual([]);
    }
  });
});

describe("Servers: starting, waiting and stopping", () => {
  it("is ready once one has started and one has failed, saying the failure in red", async () => {
    const { notes, errors, config, make } = await setup();
    const servers = make([await config("good"), await config("bad", { exit: 3, stderr: "boom\n" })]);
    servers.startAll();
    expect(servers.waitingFor()).toEqual(["good", "bad"]);
    expect(await servers.ready()).toBe(true);
    expect(servers.waitingFor()).toEqual([]);
    expect(stateOf(servers, "bad")).toEqual({ is: "failed", reason: "it exited with code 3: boom" });
    const line = "MCP server bad failed to start: it exited with code 3: boom";
    expect(errors).toEqual([{ kind: "mcp", attempted: "MCP server bad", message: line, lead: "fake:a" }]);
    expect(notes).toEqual([]); // nobody waited past it, so no ready line
    expect(every(servers)).toHaveLength(10);
  });

  // The error log's `attempted` is printed by /errors, so a name from the file is escaped there too.
  it("escapes a server's name in a failure's attempted, as in its line", async () => {
    const { errors, config, make } = await setup();
    const bell = String.fromCharCode(7);
    const servers = make([await config(`bad${bell}`, { exit: 3 })]);
    servers.startAll();
    await servers.ready();
    const shown = `bad${"\\"}u0007`;
    const line = `MCP server ${shown} failed to start: it exited with code 3`;
    expect(errors).toEqual([{ kind: "mcp", attempted: `MCP server ${shown}`, message: line, lead: "fake:a" }]);
  });

  // The user's choice (plan commit 25eca39, "A server stopped"): a dropped remote server is tried again at its next call,
  // so its drop says nothing; only a failed new connection says the stop, with that failure's reason.
  it("says nothing at a remote server's drop, nor when it connects again, and says the stop once when its new connection fails", async () => {
    const { dir, notes, errors, make } = await setup();
    // A tool left out, whose line is said at the start and not again at each new connection (Task 5's code review).
    const tools = [plain, tool("bad", { type: "object", properties: { "has space": {} } })];
    const first = await httpFake(dir, { tools });
    const remote: ServerConfig = {
      ...{ name: "r", safe: "r", where: "user", trusted: null, trustedTools: [], alwaysLoad: false, written: "" },
      entry: { kind: "http", url: first.url, headers: {} },
      asWritten: { url: first.url, headers: {} },
    };
    const servers = make([remote]);
    servers.startAll();
    await servers.ready();
    const drop = () => expect(servers.server("r")!.callTool("echo", { text: "x" }, {})).rejects.toThrow(NotReached);
    await first.stop();
    await drop();
    expect(stateOf(servers, "r")).toMatchObject({ is: "stopped", retry: true });
    expect(errors).toEqual([]);
    // Back on the same port: connected again, without a line here (the grey line is Task 6's); two callers at once share
    // the one new connection.
    const back = await httpFake(dir, { port: first.port, tools });
    expect(await Promise.all([servers.reconnect("r"), servers.reconnect("r")])).toEqual([true, true]);
    expect(stateOf(servers, "r")?.is).toBe("ready");
    expect(every(servers).map((o) => o.tool)).toEqual(["plain"]);
    // Ready, so there is nothing to reconnect: nothing is tried, and nothing said.
    expect(await servers.reconnect("r")).toBe(false);
    // Gone again, and not back: the new connection fails, and its reason is the line's.
    await back.stop();
    await drop();
    expect(errors).toEqual([]);
    expect(await servers.reconnect("r")).toBe(false);
    expect(await servers.reconnect("r")).toBe(false);
    const line = `MCP server r stopped: connect ECONNREFUSED 127.0.0.1:${first.port}; reconnect it from /mcp.`;
    expect(errors).toEqual([{ kind: "mcp", attempted: "MCP server r", message: line, lead: "fake:a" }]);
    expect(notes).toEqual([
      'MCP server r: "bad" was left out: its input schema has the property name "has space", which providers do not take ' +
        '(1 to 64 letters, digits, "_", "." or "-")',
    ]);
  });

  // Choices 13 and 33: a dropped remote server's next call connects it again, so its tools stay offered, its last list;
  // one stopped for good, or failed, offers none.
  it("keeps offering a dropped remote server's last tools, which current() calls stopped until a new connection replaces them", async () => {
    const { dir, config, make } = await setup();
    const fake = await httpFake(dir, { tools: [plain] });
    const remote: ServerConfig = {
      ...{ name: "r", safe: "r", where: "user", trusted: null, trustedTools: [], alwaysLoad: false, written: "" },
      entry: { kind: "http", url: fake.url, headers: {} },
      asWritten: { url: fake.url, headers: {} },
    };
    const servers = make([remote, await config("gone"), await config("bad", { exit: 3 })]);
    servers.startAll();
    await servers.ready();
    await servers.server("gone")!.callTool("exit", { code: 4 }, {}).catch(() => {});
    await vi.waitFor(() => expect(stateOf(servers, "gone")?.is).toBe("stopped"), WAIT);
    await servers.server("r")!.callTool("cut", {}, {}).catch(() => {});
    expect(stateOf(servers, "r")).toMatchObject({ is: "stopped", retry: true });
    const dropped = every(servers);
    expect(dropped.map((o) => `${o.server} ${o.tool}`)).toEqual(["r plain"]);
    expect(servers.current(dropped[0]!)).toBe("stopped");
    expect(await servers.reconnect("r")).toBe(true);
    expect(servers.current(dropped[0]!)).toBe("restarted");
    const now = every(servers);
    expect(now.map((o) => [o.spec.name, o.definition])).toEqual(dropped.map((o) => [o.spec.name, o.definition]));
    expect(servers.current(now[0]!)).toBe("same");
  });

  // Task 6's spec review: a call bound to the new connection keeps the view it was offered under (a subagent's trusted
  // tools only), and only a tool with the same definition is bound.
  it("rebinds an offered tool to its server's new connection, in the view it was offered under, or says why it cannot", async () => {
    const { dir, make } = await setup();
    const fake = await httpFake(dir, { tools: [plain, tool("other")] });
    const remote: ServerConfig = {
      ...{ name: "r", safe: "r", where: "user", trusted: null, trustedTools: ["plain"], alwaysLoad: false, written: "" },
      entry: { kind: "http", url: fake.url, headers: {} },
      asWritten: { url: fake.url, headers: {} },
    };
    const servers = make([remote]);
    servers.startAll();
    await servers.ready();
    const trusted = every(servers, { trustedOnly: true });
    expect(trusted.map((o) => [o.tool, o.trustedOnly])).toEqual([["plain", true]]);
    const [whole, other] = every(servers);
    expect(whole!.trustedOnly).toBeUndefined();
    await servers.server("r")!.callTool("cut", {}, {}).catch(() => {});
    expect(servers.rebind(whole!)).toEqual({ reason: "stopped" });
    expect(await servers.reconnect("r")).toBe(true);
    const bound = servers.rebind(trusted[0]!);
    if (!("offered" in bound)) throw new Error(`not bound: ${bound.reason}`);
    expect(bound.offered).toMatchObject({ spec: trusted[0]!.spec, definition: trusted[0]!.definition, trustedOnly: true });
    expect([servers.current(trusted[0]!), servers.current(bound.offered)]).toEqual(["restarted", "same"]);
    expect(servers.rebind(other!)).toMatchObject({ offered: { tool: "other" } });
    // Trust taken away by a live edit: the trusted view no longer holds the tool, the whole one still does.
    servers.set([{ ...remote, trustedTools: [] }]);
    expect(servers.rebind(trusted[0]!)).toEqual({ reason: "changed" });
    expect(servers.rebind(whole!)).toMatchObject({ offered: { tool: "plain" } });
    // A live edit's restart is another server, whose entry is not the one shown: no tool of the old one is rebound to it,
    // though the new one offers the same.
    const entry = remote.entry as Exclude<ServerConfig["entry"], { kind: "stdio" }>;
    servers.set([{ ...remote, entry: { ...entry, headers: { edited: "yes" } } }]);
    await servers.ready();
    expect(every(servers).map((o) => o.definition)).toEqual([whole!.definition, other!.definition]);
    expect(servers.rebind(whole!)).toEqual({ reason: "changed" });
  });

  it("rebinds no tool whose definition changed on the new connection", async () => {
    const { dir, make } = await setup();
    const first = await httpFake(dir, { tools: [plain] });
    const remote: ServerConfig = {
      ...{ name: "r", safe: "r", where: "user", trusted: null, trustedTools: [], alwaysLoad: false, written: "" },
      entry: { kind: "http", url: first.url, headers: {} },
      asWritten: { url: first.url, headers: {} },
    };
    const servers = make([remote]);
    servers.startAll();
    await servers.ready();
    const [was] = every(servers);
    await servers.server("r")!.callTool("cut", {}, {}).catch(() => {});
    await first.stop();
    await httpFake(dir, { port: first.port, tools: [{ ...plain, description: "a new plain" }] });
    expect(await servers.reconnect("r")).toBe(true);
    expect(servers.rebind(was!)).toEqual({ reason: "changed" });
  });

  // Task 5's code review: only a server stopped with retry has a new connection to try, so a failed one is not said again.
  it("tries no reconnect, and says nothing more, for a server that failed, stopped for good, or is ready", async () => {
    const { errors, config, make } = await setup();
    const servers = make([await config("bad", { exit: 3 }), await config("gone"), await config("fine")]);
    servers.startAll();
    await servers.ready();
    await servers.server("gone")!.callTool("exit", { code: 4 }, {}).catch(() => {});
    await vi.waitFor(() => expect(errors).toHaveLength(2), WAIT);
    expect(await Promise.all(["bad", "gone", "fine", "nobody"].map((name) => servers.reconnect(name)))).toEqual([false, false, false, false]);
    expect(errors.map((e) => e.message)).toEqual([
      "MCP server bad failed to start: it exited with code 3",
      "MCP server gone stopped: it exited with code 4; reconnect it from /mcp.",
    ]);
  });

  it("gives up the wait when its signal stops it, and then says the late server is ready", async () => {
    const { notes, config, make, gated } = await setup();
    const gate = gated();
    const one = gated();
    const servers = make([await config("late", { start: gate.start }), await config("single", { start: one.start, tools: [plain] })]);
    servers.startAll();
    const stop = new AbortController();
    const waited = servers.ready(stop.signal);
    expect(servers.waitingFor()).toEqual(["late", "single"]);
    stop.abort();
    expect(await waited).toBe(false);
    expect(notes).toEqual([]);
    await gate.open();
    await vi.waitFor(() => expect(notes).toEqual(["MCP server late is ready: 10 tools."]), WAIT);
    await one.open();
    await vi.waitFor(() => expect(notes).toEqual(["MCP server late is ready: 10 tools.", "MCP server single is ready: 1 tool."]), WAIT);
    expect(await servers.ready()).toBe(true);
  });

  it("says a server's stop once, in red, and offers none of its tools", async () => {
    const { errors, config, make } = await setup();
    const servers = make([await config("s"), await config("t")]);
    servers.startAll();
    await servers.ready();
    const echo = every(servers).find((o) => o.spec.name === "mcp__s__echo")!;
    await servers.server("s")!.callTool("exit", { code: 4, stderr: "gone\n" }, {}).catch(() => {});
    const line = "MCP server s stopped: it exited with code 4: gone; reconnect it from /mcp.";
    await vi.waitFor(() => expect(errors.map((e) => e.message)).toEqual([line]), WAIT);
    expect(errors[0]).toMatchObject({ kind: "mcp", attempted: "MCP server s" });
    expect(every(servers).map((o) => o.server)).toEqual(Array(10).fill("t"));
    expect(servers.current(echo)).toBe("stopped");
    expect(errors).toHaveLength(1);
  });

  it("tells whether an offered tool is the same, changed, restarted or stopped", async () => {
    const { config, make } = await setup();
    const s = await config("s", { tools: [tool("echo"), tool("change")], added: [tool("echo", { type: "object" }, "a new echo")] });
    const r = await config("r");
    const servers = make([s, r]);
    servers.startAll();
    await servers.ready();
    const first = every(servers);
    const echo = first.find((o) => o.spec.name === "mcp__s__echo")!;
    const other = first.find((o) => o.spec.name === "mcp__r__echo")!;
    expect([servers.current(echo), servers.current(other)]).toEqual(["same", "same"]);
    await servers.server("s")!.callTool("change", {}, {});
    await vi.waitFor(() => expect(servers.current(echo)).toBe("changed"), WAIT);
    // A live edit's restart is a new Server, whose own numbers start again: still "restarted".
    const entry = r.entry as Extract<ServerConfig["entry"], { kind: "stdio" }>;
    servers.set([s, { ...r, entry: { ...entry, args: [...entry.args, "again"] } }]);
    expect(servers.current(other)).toBe("restarted");
    await servers.ready();
    expect(servers.current(other)).toBe("restarted");
    expect(servers.current(every(servers).find((o) => o.spec.name === "mcp__r__echo")!)).toBe("same");
  });

  it("restarts only a changed server on a live edit, starts a new one, stops a removed one, and changes trust without a restart", async () => {
    const { dir, logs, config, make } = await setup();
    const pid = path.join(dir, "c.pid");
    const [a, b, c, d] = [await config("a"), await config("b"), await config("c", { pidFile: pid }), await config("d")];
    const servers = make([a, b, c]);
    servers.startAll();
    await servers.ready();
    expect(servers.trust("a", "echo")).toBe(false);
    const bEntry = b.entry as Extract<ServerConfig["entry"], { kind: "stdio" }>;
    // A user's entry as written holds its trust too, so a trust edit changes `written` and still restarts nothing.
    servers.set([{ ...a, trustedTools: ["echo"], written: "trust edited" }, { ...b, entry: { ...bEntry, args: [...bEntry.args, "again"] } }, d]);
    expect(servers.list().map((s) => [s.name, s.state.is])).toEqual([["a", "ready"], ["b", "starting"], ["d", "starting"]]);
    expect(await servers.ready()).toBe(true);
    expect(["a", "b", "d"].map((name) => initializes(logs.get(name)!))).toEqual([1, 2, 1]);
    expect(servers.trust("a", "echo")).toBe(true);
    expect(servers.trust("a", "error")).toBe(false);
    const cPid = Number(readFileSync(pid, "utf8"));
    await vi.waitFor(() => expect(alive(cPid)).toBe(false), WAIT);
    expect(new Set(every(servers).map((o) => o.server))).toEqual(new Set(["a", "b", "d"]));
  });

  // The whole-release review: a live edit's new server starts only once the old one has stopped, as a Reconnect's does,
  // so two never hold one lock file or port. Each fake takes the lock, refusing to start while the process that holds it
  // still runs, and the old one takes 200 ms to exit once its input closes, inside the stop's 300 ms.
  it("starts a live edit's new server only after the old one has stopped", async () => {
    const { dir, config, make, errors } = await setup();
    const lock = JSON.stringify(path.join(dir, "server.lock"));
    const start = `const fs = require("node:fs");
      let held = 0; try { held = Number(fs.readFileSync(${lock}, "utf8")); } catch {}
      let alive = false; if (held) try { process.kill(held, 0); alive = true; } catch (e) { alive = e.code === "EPERM"; }
      if (alive) throw new Error("the old server still holds the lock");
      fs.writeFileSync(${lock}, String(process.pid));
      const pause = new Int32Array(new SharedArrayBuffer(4));
      process.on("exit", () => Atomics.wait(pause, 0, 0, 200));`;
    const s = await config("s", { start });
    const servers = make([s]);
    servers.startAll();
    await servers.ready();
    expect(servers.list()[0]!.state.is).toBe("ready");
    const entry = s.entry as Extract<ServerConfig["entry"], { kind: "stdio" }>;
    expect(servers.set([{ ...s, entry: { ...entry, args: [...entry.args, "again"] } }]).restarted).toEqual(["s"]);
    await vi.waitFor(() => expect(servers.list()[0]!.state.is).toBe("ready"), WAIT);
    expect(errors).toEqual([]);
  });

  // Release 8c plan, Task 10's quality review: a new connection closes one still open, so two Reconnects close together
  // leave one server running, and the exit's stop leaves none.
  it("leaves one server running after two restarts at once, and none after stopAll", async () => {
    const { config, make } = await setup();
    const servers = make([await config("s")]);
    const live = () => [...running].filter((c) => c.exitCode === null && c.signalCode === null).length;
    servers.startAll();
    await servers.ready();
    await vi.waitFor(() => expect(live()).toBe(1), WAIT); // an earlier case's server may still be going
    await Promise.all([servers.restart("s"), servers.restart("s")]);
    expect(servers.list()[0]!.state.is).toBe("ready");
    await vi.waitFor(() => expect(live()).toBe(1), WAIT);
    await servers.stopAll();
    await vi.waitFor(() => expect(live()).toBe(0), WAIT);
  });

  // Task 10's quality review: the table is built again after a live edit, so a kept server's count and left-out lines are
  // current at once: here "a_b"'s tool, left out while "a.b" held its name, is offered once "a.b" is removed.
  it("counts a kept server's tools again after a live edit removes the one whose name it clashed with", async () => {
    const { notes, config, make } = await setup();
    const [dotted, under] = [await config("a.b", { tools: [tool("t")] }), await config("a_b", { tools: [tool("t")] })];
    const servers = make([dotted, under]);
    servers.startAll();
    await servers.ready();
    every(servers);
    expect(servers.list().map((s) => s.tools)).toEqual([1, 0]);
    expect(notes).toEqual(['MCP server a_b: "t" was left out: its name mcp__a_b__t is already a.b\'s "t"']);
    servers.set([under]);
    expect(servers.list().map((s) => s.tools)).toEqual([1]);
    expect(servers.tools("a_b")).toEqual({ names: ["mcp__a_b__t"], leftOut: [] });
    expect(notes).toHaveLength(1);
  });
});

describe("Servers: a project's servers and the network", () => {
  // Choice 24: an answer counts only for the entry it was given for (ServerConfig.written).
  const given = (yes: Record<string, [string, boolean]>): (() => Answers) => () => ({
    get: (name, entry) => (yes[name]?.[0] === entry ? yes[name][1] : undefined),
    set: () => {},
    reset: () => {},
  });

  it("starts a project's server only on a yes for its entry; a no and no answer are not started", async () => {
    const { config, make, errors } = await setup();
    const p = { where: "project" as const };
    const configs = [
      await config("u"),
      await config("yes", {}, { ...p, written: "w1" }),
      await config("no", {}, { ...p, written: "w2" }),
      await config("none", {}, { ...p, written: "w3" }),
      await config("other", {}, { ...p, written: "w4" }),
    ];
    const servers = make(configs, { answers: given({ yes: ["w1", true], no: ["w2", false], other: ["old", true] }) });
    servers.startAll();
    await servers.ready();
    // Choice 24 at a live edit: the same filled-in entry, written another way, is asked about again.
    servers.set(configs.map((c) => (c.name === "yes" ? { ...c, written: "w1, written again" } : c)));
    expect(stateOf(servers, "yes")).toEqual({ is: "waiting for your yes" });
    expect(servers.server("yes")).toBeUndefined();
    servers.set(configs); // the yes's own entry back: started again
    await servers.ready();
    expect(servers.list().map((s) => [s.name, s.where, s.state.is])).toEqual([
      ["u", "user", "ready"],
      ["yes", "project", "ready"],
      ["no", "project", "you said no"],
      ["none", "project", "waiting for your yes"],
      ["other", "project", "waiting for your yes"],
    ]);
    expect(new Set(every(servers).map((o) => o.server))).toEqual(new Set(["u", "yes"]));
    expect(errors).toEqual([]);
  });

  it("says in red that the answers could not be read, and asks about every project server again", async () => {
    const { dir, config, make, errors } = await setup();
    const data = path.join(dir, "data", "tachikoma");
    const file = projectFile("mcp-answers", dir, data);
    mkdirSync(file, { recursive: true }); // a folder where the file goes
    const servers = make([await config("u"), await config("p", {}, { where: "project", written: "w" })], { answers: () => answersFor(dir, data) });
    servers.startAll();
    await servers.ready();
    expect(errors).toEqual([
      {
        kind: "mcp",
        attempted: "MCP answers",
        message: `MCP answers for this project could not be read (${file} is not a plain file, so it was not used), so its servers are asked about again.`,
        lead: "fake:a",
      },
    ]);
    expect(servers.list().map((s) => s.state.is)).toEqual(["ready", "waiting for your yes"]);
  });

  // Release 8c plan, Task 9: in the window the launch asks about them again, each answer kept for that launch only, as
  // nothing can be written to the file; the red line is said all the same.
  it("takes the launch's own answers when the project's could not be read, still saying why in red", async () => {
    const { dir, config, make, errors } = await setup();
    const data = path.join(dir, "data", "tachikoma");
    mkdirSync(projectFile("mcp-answers", dir, data), { recursive: true });
    const p = { where: "project" as const };
    const configs = [await config("yes", {}, { ...p, written: "w1" }), await config("no", {}, { ...p, written: "w2" })];
    const unread = given({ yes: ["w1", true], no: ["w2", false] })();
    const servers = make(configs, { answers: () => answersFor(dir, data), unread });
    servers.startAll();
    await servers.ready();
    const unreadable = /^MCP answers for this project could not be read \(.+\), so its servers are asked about again\.$/;
    expect(errors.map((e) => e.message)).toEqual([expect.stringMatching(unreadable)]);
    expect(servers.list().map((s) => s.state.is)).toEqual(["ready", "you said no"]);
  });

  it("starts no server with the sandbox's network off, every one off", async () => {
    const { config, make } = await setup();
    const servers = make([await config("u"), await config("p", {}, { where: "project", written: "w" })], { network: "off" });
    servers.startAll();
    expect(await servers.ready()).toBe(true);
    expect(servers.list().map((s) => s.state)).toEqual([{ is: "off" }, { is: "off" }]);
    expect(every(servers)).toEqual([]);
  });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};
