import { mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type BetaMessage, Messages } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { projectFile, SETTINGS } from "../../src/core/datadir.js";
import { type Answers, answersFor } from "../../src/mcp/answers.js";
import { readServers, type ServerConfig } from "../../src/mcp/config.js";
import { type Offered, Servers } from "../../src/mcp/servers.js";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import { Bus, collectErrors, removeTree } from "../helpers.js";
import { type FakeOptions, fakeServer, readLog } from "./fake.js";

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
    return { name, safe, where: "user", trusted: null, trustedTools: [], alwaysLoad: false, written: "", entry, ...over };
  };
  const make = (configs: ServerConfig[], opts: { answers?: () => Answers; network?: "on" | "off" | "none" } = {}) => {
    const answers = opts.answers ?? nobody;
    const servers = new Servers(configs, { root: dir, env: process.env, bus, answers, network: opts.network ?? "none", lead: () => "fake:a" });
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
    expect(names(servers.offer())).toEqual([`mcp__s__${t64}`, "mcp__s__plain"]);
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
    const offered = servers.offer();
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
    expect(servers.offer().map((o) => [o.spec.name, o.server, o.tool])).toEqual([["mcp__a__b__c", "a", "b__c"]]);
    expect(notes).toEqual([]);
  });

  it("leaves out the later server's tools, in the order the configs are given, when two come ready together", async () => {
    const { notes, config, make } = await setup();
    const servers = make([await config("x.y"), await config("x_y")]);
    servers.startAll();
    await servers.ready();
    const offered = servers.offer();
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
    expect(owner(servers.offer(), "mcp__x_y__echo")).toEqual(["x_y echo"]);
    await gate.open();
    expect(await servers.ready()).toBe(true);
    expect(owner(servers.offer(), "mcp__x_y__echo")).toEqual(["x_y echo"]);
    expect(notes).toEqual(TEN.map((t) => `MCP server x.y: "${t}" was left out: its name mcp__x_y__${t} is already x_y's "${t}"`));
  });

  // Choice 7 for a changed list: the new tool comes first in the list, and still does not take the name in force.
  it("leaves out a changed list's new tool whose name is in force, with its line", async () => {
    const { notes, config, make } = await setup();
    const servers = make([await config("s", { tools: [tool("foo_bar"), tool("change")], added: [tool("foo.bar"), plain] })]);
    servers.startAll();
    await servers.ready();
    expect(names(servers.offer())).toEqual(["mcp__s__foo_bar", "mcp__s__change"]);
    await servers.server("s")!.callTool("change", {}, {});
    await vi.waitFor(() => expect(notes).toEqual(['MCP server s: "foo.bar" was left out: its name mcp__s__foo_bar is already s\'s "foo_bar"']), WAIT);
    const offered = servers.offer();
    expect(names(offered)).toEqual(["mcp__s__plain", "mcp__s__foo_bar", "mcp__s__change"]);
    expect(owner(offered, "mcp__s__foo_bar")).toEqual(["s foo_bar"]);
    expect(notes).toHaveLength(1); // said once, not again at the next offer
  });

  // Choice 1 and choice 8: the spec is cut, the definition is the whole text, so a view's cut never looks like a change.
  it("cuts each description at 4,096 characters, and builds the definition from the whole text", async () => {
    const { config, make } = await setup();
    const servers = make([await config("s", { description: `${"d".repeat(4_096)}MARK` })]);
    servers.startAll();
    await servers.ready();
    const echo = servers.offer().find((o) => o.tool === "echo")!;
    expect(echo.spec.description).toBe("d".repeat(4_096));
    expect(echo.definition).toContain("MARK");
    expect(echo.spec.inputSchema).toEqual({ type: "object", properties: { text: { type: "string" } } });
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
    expect(flattened(servers.offer())).toEqual(expected);
    expect(notes).toEqual([]);
  });

  it("leaves out a schema that is not an object schema, has a property name providers refuse, or cannot be compiled, with their lines", async () => {
    const { notes, config, make } = await setup();
    const servers = make([await config("s", { tools: [notObject, badName, broken, plain] })]);
    servers.startAll();
    await servers.ready();
    expect(servers.offer().map((o) => o.tool)).toEqual(["plain"]);
    expect(notes).toEqual(left);
  });

  it("does the same for tools arriving by a list change", async () => {
    const { notes, config, make } = await setup();
    const servers = make([await config("s", { tools: [plain, tool("change")], added: [pick, either, both, notObject, badName, broken] })]);
    servers.startAll();
    await servers.ready();
    expect(servers.offer().map((o) => o.tool)).toEqual(["plain", "change"]);
    await servers.server("s")!.callTool("change", {}, {});
    await vi.waitFor(() => expect(notes).toEqual(left), WAIT);
    expect(flattened(servers.offer())).toEqual({ ...expected, change: { description: "change", schema: { type: "object" } } });
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
    await new AnthropicProvider("claude-opus-5-5").complete({ system: "s", messages: [], tools: servers.offer().map((o) => o.spec) });
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
    expect(servers.offer()).toHaveLength(10);
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
    const echo = servers.offer().find((o) => o.spec.name === "mcp__s__echo")!;
    await servers.server("s")!.callTool("exit", { code: 4, stderr: "gone\n" }, {}).catch(() => {});
    const line = "MCP server s stopped: it exited with code 4: gone; reconnect it from /mcp.";
    await vi.waitFor(() => expect(errors.map((e) => e.message)).toEqual([line]), WAIT);
    expect(errors[0]).toMatchObject({ kind: "mcp", attempted: "MCP server s" });
    expect(servers.offer().map((o) => o.server)).toEqual(Array(10).fill("t"));
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
    const first = servers.offer();
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
    expect(servers.current(servers.offer().find((o) => o.spec.name === "mcp__r__echo")!)).toBe("same");
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
    servers.set([{ ...a, trustedTools: ["echo"] }, { ...b, entry: { ...bEntry, args: [...bEntry.args, "again"] } }, d]);
    expect(servers.list().map((s) => [s.name, s.state.is])).toEqual([["a", "ready"], ["b", "starting"], ["d", "starting"]]);
    expect(await servers.ready()).toBe(true);
    expect(["a", "b", "d"].map((name) => initializes(logs.get(name)!))).toEqual([1, 2, 1]);
    expect(servers.trust("a", "echo")).toBe(true);
    expect(servers.trust("a", "error")).toBe(false);
    const cPid = Number(readFileSync(pid, "utf8"));
    await vi.waitFor(() => expect(alive(cPid)).toBe(false), WAIT);
    expect(new Set(servers.offer().map((o) => o.server))).toEqual(new Set(["a", "b", "d"]));
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
    expect(servers.list().map((s) => [s.name, s.where, s.state.is])).toEqual([
      ["u", "user", "ready"],
      ["yes", "project", "ready"],
      ["no", "project", "you said no"],
      ["none", "project", "waiting for your yes"],
      ["other", "project", "waiting for your yes"],
    ]);
    expect(new Set(servers.offer().map((o) => o.server))).toEqual(new Set(["u", "yes"]));
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

  it("starts no server with the sandbox's network off, every one off", async () => {
    const { config, make } = await setup();
    const servers = make([await config("u"), await config("p", {}, { where: "project", written: "w" })], { network: "off" });
    servers.startAll();
    expect(await servers.ready()).toBe(true);
    expect(servers.list().map((s) => s.state)).toEqual([{ is: "off" }, { is: "off" }]);
    expect(servers.offer()).toEqual([]);
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
