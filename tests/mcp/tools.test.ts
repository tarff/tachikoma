import { writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type BetaMessage, Messages } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { Models } from "@anthropic-ai/sdk/resources/models";
import { Completions } from "openai/resources/chat/completions";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { privateDir } from "../../src/auth/private.js";
import { PermissionGate } from "../../src/core/permissions.js";
import { Session, type SessionOptions } from "../../src/core/session.js";
import { readTranscript, Transcript } from "../../src/core/transcript.js";
import type { CompletionRequest, Message, Provider, Turn } from "../../src/core/types.js";
import { MAX_TOOL_OUTPUT } from "../../src/exec/executor.js";
import { LocalExecutor, LocalWorkspace } from "../../src/exec/local.js";
import { Hooks } from "../../src/hooks/hooks.js";
import type { ServerConfig } from "../../src/mcp/config.js";
import { type Offered, Servers } from "../../src/mcp/servers.js";
import { type Approve, mcpTools } from "../../src/mcp/tools.js";
import { AnthropicProvider, toAnthropic } from "../../src/providers/anthropic.js";
import { OpenAIProvider, toOpenAI } from "../../src/providers/openai.js";
import { judgeOf } from "../../src/safety/judge.js";
import { writeFileTool } from "../../src/tools/files.js";
import { defineTool } from "../../src/tools/tool.js";
import { Pictures } from "../../src/tui/pictures.js";
import { Bus, callTool, collectErrors, FakeProvider, removeTree, reply, texts, usage } from "../helpers.js";
import { type FakeOptions, fakeServer, httpFake, readLog } from "./fake.js";

// Release 8c plan, Task 6: MCP tools in the session, each call on the tool the model was shown, against the fake servers
// of fake.ts and a stand-in model. Every request the model is sent is the stand-in's; none reaches a provider.

// A wait on another process: a few seconds for a busy machine, well inside the test's 15 s.
const WAIT = { timeout: 5_000 };
const TEN = ["echo", "error", "picture", "structured", "slow", "progress", "whoami", "ask", "change", "exit"];
// The fake's own 1x1 PNG (fake.ts).
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const png = Buffer.from(PNG, "base64");
const tool = (name: string, inputSchema: object = { type: "object" }, description = name) => ({ name, description, inputSchema });
const echoSchema = { type: "object", properties: { text: { type: "string" } } };
const own = defineTool("own", "Tachikoma's own tool, which comes first", z.object({}), async () => "own");
const many = (...c: [string, string, unknown][]): Turn => ({ parts: c.map(([id, name, input]) => ({ type: "tool_call" as const, id, name, input })), usage });
const changedLine = (server: string, name: string) =>
  `Not run: ${server}'s tool "${name}" changed while this call waited; ` +
  "look at its definition in this request's tools, if it is still there, and call it again.";
const STOPPED = (server: string) => `The MCP server ${server} has stopped; the user can reconnect it from /mcp.`;
const AGAIN = (server: string) => `MCP server ${server} was connected again.`;

// A stand-in model: its turns in order, one made by a function when the test changes something once the request is made;
// each request's tool names and messages kept, the messages as sent, as the history is never edited.
class Model implements Provider {
  readonly requests: { tools: string[]; messages: Message[] }[] = [];
  constructor(
    readonly id: string,
    private readonly turns: (Turn | (() => Promise<Turn>))[],
  ) {}
  async complete(req: CompletionRequest): Promise<Turn> {
    this.requests.push({ tools: req.tools.map((t) => t.name), messages: [...req.messages] });
    const next = this.turns.shift();
    if (!next) throw new Error("the stand-in model ran out of turns");
    return typeof next === "function" ? next() : next;
  }
}

// The test's own folder, the project's root, and its Servers, each stopped before the folder is removed: on Windows a
// running server holds the folder it works in.
async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "tachi-mcp-tools-"));
  const made: Servers[] = [];
  onTestFinished(async () => {
    await Promise.all(made.map((s) => s.stopAll()));
    await removeTree(dir);
  });
  const bus = new Bus();
  const notes: string[] = [];
  bus.on("mcp-note", (line) => notes.push(line));
  const errors = collectErrors(bus);
  const outcomes: string[] = [];
  bus.on("tool-end", (e) => outcomes.push(e.outcome));
  let files = 0;
  const logs = new Map<string, string>();
  const log = () => path.join(dir, `log-${++files}.jsonl`);
  const user = { safe: "", where: "user" as const, trusted: null, trustedTools: [], alwaysLoad: false, written: "" };
  // A local server named `name` running a fake with `fake`'s options, logging to its own file, kept in `logs` by its name.
  const local = async (name: string, fake: FakeOptions = {}): Promise<ServerConfig> => {
    const file = log();
    logs.set(name, file);
    const script = await fakeServer(dir, { log: file, ...fake });
    return { ...user, name, safe: name, entry: { kind: "stdio", command: process.execPath, args: [script], env: {} } };
  };
  const remote = (name: string, url: string): ServerConfig => ({ ...user, name, safe: name, entry: { kind: "http", url, headers: {} } });
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
  // The question's stand-in until Task 7's gate: each call it is asked about, by name and input; `then` runs before it
  // answers yes, so a test changes things while a call waits for its question.
  const q: { asked: string[]; then?: (o: Offered) => unknown } = { asked: [] };
  const approve: Approve = async (o, input) => {
    q.asked.push(`${o.spec.name} ${JSON.stringify(input)}`);
    await q.then?.(o);
  };
  const ctx = { root: dir, executor: new LocalExecutor(), workspace: new LocalWorkspace(dir), gate: new PermissionGate("never", async () => false) };
  const session = (servers: Servers, turns: ConstructorParameters<typeof Model>[1], over: Partial<SessionOptions> = {}) => {
    const model = new Model("fake:a", turns);
    const s = new Session({ lead: model, tools: [own], system: "t", ctx, bus, mcp: mcpTools(servers, bus, approve), ...over });
    return { session: s, model };
  };
  const results = (s: Session) =>
    s.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "tool_result" ? [{ output: p.output, isError: p.isError }] : [])));
  // The messages a fake was sent, by method, over stdio or HTTP.
  const sent = (file: string) => readLog(file).flatMap((e) => (e.http ? (e.body ? [e.body] : []) : e.method ? [e] : []));
  const calls = (file: string, name: string) => sent(file).filter((m) => m.method === "tools/call" && m.params.name === name);
  return { dir, bus, notes, errors, outcomes, logs, log, local, remote, make, ready, q, ctx, session, results, sent, calls };
}

// A live edit's restart of a local server: its entry with one more argument, which the fake does not read.
const restarted = (c: ServerConfig): ServerConfig => {
  const entry = c.entry as Extract<ServerConfig["entry"], { kind: "stdio" }>;
  return { ...c, entry: { ...entry, args: [...entry.args, "again"] } };
};

describe("MCP tools in the session", () => {
  it("calls the server with the model's input and gives the model its answer, the request's MCP specs after Tachikoma's own", async () => {
    const t = await setup();
    const servers = await t.ready([await t.local("s")]);
    const { session, model } = t.session(servers, [callTool("c1", "mcp__s__echo", { text: "hi" }), reply("done")]);
    await session.send("go");
    expect(model.requests[0]!.tools).toEqual(["own", ...TEN.map((n) => `mcp__s__${n}`)]);
    expect(t.results(session)).toEqual([{ output: "hi", isError: false }]);
    expect(t.q.asked).toEqual(['mcp__s__echo {"text":"hi"}']);
    expect(t.calls(t.logs.get("s")!, "echo").map((m) => m.params.arguments)).toEqual([{ text: "hi" }]);
    expect([t.outcomes, t.errors, t.notes]).toEqual([["ok"], [], []]);
  });

  it("sends the same names to Anthropic and, after a /lead switch, to an OpenAI-format lead", async () => {
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
    const servers = await t.ready([await t.local("s")]);
    const { session } = t.session(servers, [], { lead: new AnthropicProvider("claude-opus-5-5") });
    await session.send("one");
    session.setLead(new OpenAIProvider("openai", "gpt-5"));
    await session.send("two");
    const names = ["own", ...TEN.map((n) => `mcp__s__${n}`)];
    expect((anthropic.mock.calls[0]![0] as unknown as { tools: { name: string }[] }).tools.map((x) => x.name)).toEqual(names);
    expect((openai.mock.calls[0]![0] as unknown as { tools: { function: { name: string } }[] }).tools.map((x) => x.function.name)).toEqual(names);
  });

  // The security check of Task 6: the question has no default that passes every call.
  it("takes MCP tools only with a question to ask, and without one, against the types, runs nothing", async () => {
    const t = await setup();
    const servers = await t.ready([await t.local("s")]);
    // @ts-expect-error: the question is required, so nothing wires MCP tools into a session without a gate.
    const mcp = mcpTools(servers, t.bus);
    const lead = new FakeProvider("a", [callTool("c1", "mcp__s__echo", { text: "hi" }), reply("ok")]);
    const session = new Session({ lead, tools: [], system: "t", ctx: t.ctx, bus: t.bus, mcp });
    await session.send("go");
    expect(t.results(session)[0]!.isError).toBe(true);
    expect(t.calls(t.logs.get("s")!, "echo")).toEqual([]);
  });

  it("cuts a text answer at 30,000 characters, as a command's output is cut", async () => {
    const t = await setup();
    const servers = await t.ready([await t.local("s")]);
    const long = "x".repeat(MAX_TOOL_OUTPUT + 5);
    const { session } = t.session(servers, [callTool("c1", "mcp__s__echo", { text: long }), reply("done")]);
    await session.send("go");
    expect(t.results(session)).toEqual([{ output: `${"x".repeat(MAX_TOOL_OUTPUT)}\n[cut: 5 more characters]`, isError: false }]);
  });

  // Choice 10: numbered on from the conversation's highest number, so the markers read as the user's do.
  it("passes an answer's two pictures on as #4 and #5 after a pasted [Image #3], marked the server's, through both providers' adapters", async () => {
    const t = await setup();
    const content = [
      { type: "text", text: "two of them" },
      { type: "image", data: PNG, mimeType: "image/png" },
      { type: "image", data: PNG, mimeType: "image/webp" },
    ];
    const servers = await t.ready([await t.local("s", { tools: [tool("pictures")], results: { pictures: { content } } })]);
    const pictures = new Pictures();
    for (let i = 0; i < 3; i++) pictures.next();
    const { session, model } = t.session(servers, [callTool("c1", "mcp__s__pictures", {}), reply("seen")], { pictures });
    await session.send([{ type: "text", text: "see " }, { type: "image", id: 3, mediaType: "image/png", data: png }]);
    const output = "two of them\n[The tool's answer has pictures: [Image #4], [Image #5]]";
    expect(session.messages[2]!.parts).toEqual([
      { type: "tool_result", callId: "c1", output, isError: false },
      { type: "image", id: 4, mediaType: "image/png", data: png, from: "server" },
      { type: "image", id: 5, mediaType: "image/webp", data: png, from: "server" },
    ]);
    expect([pictures.next(), session.prompts]).toEqual([6, ["see [Image #3]"]]);
    const asked = model.requests[1]!.messages;
    const base64 = png.toString("base64");
    expect(toAnthropic(asked).at(-1)).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "c1", content: output, is_error: false },
        { type: "text", text: "[Image #4]" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } },
        { type: "text", text: "[Image #5]" },
        { type: "image", source: { type: "base64", media_type: "image/webp", data: base64 } },
      ],
    });
    expect(toOpenAI("t", asked, "openai").slice(-2)).toEqual([
      { role: "tool", tool_call_id: "c1", content: output },
      {
        role: "user",
        content: [
          { type: "text", text: "[Image #4]" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
          { type: "text", text: "[Image #5]" },
          { type: "image_url", image_url: { url: `data:image/webp;base64,${base64}` } },
        ],
      },
    ]);
  });

  // Choices 11 and 12.
  it("sends structured content alone as its JSON, the text when there is some, a resource's text, and names the kinds it does not pass on", async () => {
    const t = await setup();
    const kinds = [
      { type: "text", text: "first" },
      { type: "audio", data: "AAAA", mimeType: "audio/wav" },
      { type: "resource_link", uri: "file:///a.txt", name: "a.txt" },
      { type: "resource", resource: { uri: "file:///b.txt", text: "b's text" } },
      { type: "resource", resource: { uri: "file:///c.bin", blob: "AAAA" } },
      { type: "image", data: PNG, mimeType: "image/bmp" },
    ];
    const results = { both: { content: [{ type: "text", text: "forty-two" }], structuredContent: { answer: 42 } }, kinds: { content: kinds } };
    const servers = await t.ready([await t.local("s", { tools: [tool("structured"), tool("both"), tool("kinds")], results })]);
    const turn = many(["c1", "mcp__s__structured", {}], ["c2", "mcp__s__both", {}], ["c3", "mcp__s__kinds", {}]);
    const { session } = t.session(servers, [turn, reply("done")]);
    await session.send("go");
    const not = (kind: string) => `[The tool's answer has ${kind} part, which Tachikoma does not pass on]`;
    expect(t.results(session)).toEqual([
      { output: '{"answer":42}', isError: false },
      { output: "forty-two", isError: false },
      {
        output: ["first", not("an audio"), not("a resource link"), "b's text", not("an embedded resource"), not("an image")].join("\n\n"),
        isError: false,
      },
    ]);
    expect(session.messages[2]!.parts.every((p) => p.type === "tool_result")).toBe(true);
  });

  it("makes an isError answer a failed call, the server's own text to the model, and fires PostToolUseFailure", async () => {
    const t = await setup();
    const servers = await t.ready([await t.local("s")]);
    const out = path.join(t.dir, "hook.jsonl");
    const script = path.join(t.dir, "hook.cjs");
    // The hook adds its input to the file named by its argument.
    writeFileSync(script, 'let t = ""; process.stdin.on("data", (d) => (t += d)).on("end", () => require("fs").appendFileSync(process.argv[2], t));');
    const matcher = { all: true as const };
    const hook = { event: "PostToolUseFailure" as const, matcher, command: process.execPath, args: [script, out], async: false, where: '"PostToolUseFailure"' };
    const where = { sessionId: () => "s1", transcript: () => undefined, root: t.dir, mode: () => "never" as const, effort: () => undefined };
    const hooks = new Hooks({ hooks: [hook], off: false, leftOut: [] }, { ...where, lead: () => "fake:a" }, t.bus);
    const { session } = t.session(servers, [callTool("c1", "mcp__s__error", {}), reply("sorry")], { hooks });
    await session.send("go");
    expect(t.results(session)).toEqual([{ output: "it went wrong", isError: true }]);
    expect(t.outcomes).toEqual(["failed"]);
    expect(t.errors).toEqual([{ kind: "tool", attempted: "mcp__s__error {}", message: "it went wrong", lead: "fake:a" }]);
    const fired = { hook_event_name: "PostToolUseFailure", tool_name: "mcp__s__error", tool_input: {}, tool_use_id: "c1", error: "it went wrong" };
    expect(readLog(out)).toEqual([expect.objectContaining(fired)]);
  });
});

// Release 8c design, finding 4: the call runs on the connection and definition the model was shown, or not at all.
describe("MCP tools in the session: what changed while a call waited", () => {
  it("refuses a call whose server restarted while it waited for its question, never reaching the server", async () => {
    const t = await setup();
    const s = await t.local("s");
    const servers = await t.ready([s]);
    t.q.then = () => servers.set([restarted(s)]);
    const { session } = t.session(servers, [callTool("c1", "mcp__s__echo", { text: "hi" }), reply("ok")]);
    await session.send("go");
    expect(t.results(session)).toEqual([{ output: changedLine("s", "echo"), isError: true }]);
    expect(t.q.asked).toHaveLength(1);
    await servers.ready();
    expect(t.calls(t.logs.get("s")!, "echo")).toEqual([]);
  });

  it("refuses a call whose tool changed while it waited for its question, never reaching the server", async () => {
    const t = await setup();
    const servers = await t.ready([await t.local("s", { added: [tool("echo", echoSchema, "a new echo")] })]);
    t.q.then = async (o) => {
      await servers.server("s")!.callTool("change", {}, {});
      await vi.waitFor(() => expect(servers.current(o)).toBe("changed"), WAIT);
    };
    const { session } = t.session(servers, [callTool("c1", "mcp__s__echo", { text: "hi" }), reply("ok")]);
    await session.send("go");
    expect(t.results(session)).toEqual([{ output: changedLine("s", "echo"), isError: true }]);
    expect(t.calls(t.logs.get("s")!, "echo")).toEqual([]);
  });

  // Task 6's spec review: a server stopped for good has nothing to run the call, so nobody is asked about it.
  it("gives a call whose local server exited after the request the stopped line, without asking", async () => {
    const t = await setup();
    const servers = await t.ready([await t.local("s")]);
    const exited = async () => {
      await servers.server("s")!.callTool("exit", { code: 4 }, {}).catch(() => {});
      await vi.waitFor(() => expect(servers.list()[0]!.state).toMatchObject({ is: "stopped", retry: false }), WAIT);
      return callTool("c1", "mcp__s__echo", { text: "hi" });
    };
    const { session } = t.session(servers, [exited, reply("ok")]);
    await session.send("go");
    expect(t.results(session)).toEqual([{ output: STOPPED("s"), isError: true }]);
    expect(t.q.asked).toEqual([]);
    expect(t.errors.map((e) => [e.kind, e.message])).toEqual([
      ["mcp", "MCP server s stopped: it exited with code 4; reconnect it from /mcp."],
      ["tool", STOPPED("s")],
    ]);
  });

  it("ends a call running when its server restarts with the restart line", async () => {
    const t = await setup();
    const s = await t.local("s");
    const servers = await t.ready([s]);
    const { session } = t.session(servers, [callTool("c1", "mcp__s__slow", {}), reply("ok")]);
    const turn = session.send("go");
    await vi.waitFor(() => expect(t.calls(t.logs.get("s")!, "slow")).toHaveLength(1), WAIT);
    servers.set([restarted(s)]);
    await turn;
    expect(t.results(session)).toEqual([{ output: "Stopped: the MCP server s restarted while the call ran.", isError: true }]);
    expect(t.outcomes).toEqual(["failed"]);
  });

  it("stops a slow call at Esc as any tool's, and tells the server", async () => {
    const t = await setup();
    const servers = await t.ready([await t.local("s")]);
    const { session } = t.session(servers, [callTool("c1", "mcp__s__slow", {})]);
    const stop = new AbortController();
    const turn = session.send("go", stop.signal);
    const log = t.logs.get("s")!;
    await vi.waitFor(() => expect(t.calls(log, "slow")).toHaveLength(1), WAIT);
    stop.abort();
    await turn;
    expect(t.results(session)).toEqual([{ output: "Cancelled by the user.", isError: true }]);
    expect([t.outcomes, t.errors]).toEqual([["cancelled"], []]);
    const id = t.calls(log, "slow")[0]!.id;
    await vi.waitFor(() => expect(t.sent(log).filter((m) => m.method === "notifications/cancelled").map((m) => m.params.requestId)).toEqual([id]), WAIT);
  });
});

// Release 8c plan, choices 13 and 33 (the plan review, finding 3): a dropped remote server gets one new connection, at the
// next call, before its question; a drop no answer showed is found by the call, which goes once more on the new one.
describe("MCP tools in the session: a remote server's drop", () => {
  const tools = [tool("cut"), tool("echo", echoSchema)];
  type Fake = Awaited<ReturnType<typeof httpFake>>;
  const echoCall = callTool("c2", "mcp__r__echo", { text: "back" });
  // A remote server, and a session whose model calls its echo; once the request offering that call is made, `change`
  // changes what the server will be: the fake stopped, or another in its place on its port, `log2` its log. A seen drop
  // comes first, by a call to "cut", a drop after the request reached the server, which leaves the server stopped with
  // its one new connection to come; it comes after the request, as Servers offers no stopped server's tools. An unseen
  // one (`unseen`) is a JSON-only server restarted after an earlier echo, the server still ready when the call runs.
  async function dropped(change: (fake: Fake, log2: string) => Promise<unknown>, opts: { unseen?: true; signal?: AbortSignal } = {}) {
    const t = await setup();
    const [log, log2] = [t.log(), t.log()];
    const fake = await httpFake(t.dir, { log, tools });
    const servers = await t.ready([t.remote("r", fake.url)]);
    const seen: string[] = []; // the server's state once the drop is seen
    const states: string[] = []; // the server's state at each question, with the grey lines said by then
    t.q.then = () => states.push(`${servers.server("r")!.state.is} ${t.notes.length}`);
    const later = async () => {
      if (!opts.unseen) {
        await servers.server("r")!.callTool("cut", {}, {}).catch(() => {});
        seen.push(servers.list()[0]!.state.is);
      }
      await change(fake, log2);
      return echoCall;
    };
    const turns = opts.unseen ? [callTool("c1", "mcp__r__echo", { text: "one" }), later, reply("done")] : [later, reply("done")];
    const { session } = t.session(servers, turns);
    return { t, log, log2, fake, seen, states, session, turn: session.send("go", opts.signal) };
  }

  it("connects again before the question, says so, and the call reaches the server", async () => {
    const d = await dropped(async () => {});
    await d.turn;
    expect(d.seen).toEqual(["stopped"]);
    expect(d.t.results(d.session)).toEqual([{ output: "back", isError: false }]);
    expect(d.t.q.asked).toEqual(['mcp__r__echo {"text":"back"}']);
    expect(d.states).toEqual(["ready 1"]);
    expect(d.t.notes).toEqual([AGAIN("r")]);
    expect(d.t.sent(d.log).filter((m) => m.method === "initialize")).toHaveLength(2);
    expect(d.t.calls(d.log, "echo")).toHaveLength(1);
    expect(d.t.errors).toEqual([]);
  });

  it("offers a server whose drop was seen before the request, and the model's call connects it again, is asked and reaches it", async () => {
    const t = await setup();
    const log = t.log();
    const fake = await httpFake(t.dir, { log, tools });
    const servers = await t.ready([t.remote("r", fake.url)]);
    await servers.server("r")!.callTool("cut", {}, {}).catch(() => {});
    expect(servers.list()[0]!.state).toMatchObject({ is: "stopped", retry: true });
    const states: string[] = [];
    t.q.then = () => states.push(`${servers.server("r")!.state.is} ${t.notes.length}`);
    const { session, model } = t.session(servers, [echoCall, reply("done")]);
    await session.send("go");
    expect(model.requests[0]!.tools).toEqual(["own", "mcp__r__cut", "mcp__r__echo"]);
    expect(t.results(session)).toEqual([{ output: "back", isError: false }]);
    expect([t.q.asked, states, t.notes, t.errors]).toEqual([['mcp__r__echo {"text":"back"}'], ["ready 1"], [AGAIN("r")], []]);
    expect(t.calls(log, "echo")).toHaveLength(1);
  });

  it("refuses the call with the changed line, before its question, when the new connection's tool is not the one shown", async () => {
    const d = await dropped(async (fake, log2) => {
      await fake.stop();
      await httpFake(path.dirname(log2), { port: fake.port, log: log2, tools: [tool("cut"), tool("echo", echoSchema, "a new echo")] });
    });
    await d.turn;
    expect(d.t.results(d.session)).toEqual([{ output: changedLine("r", "echo"), isError: true }]);
    expect(d.t.q.asked).toEqual([]);
    expect(d.t.notes).toEqual([AGAIN("r")]);
    expect(d.t.sent(d.log2).filter((m) => m.method === "initialize")).toHaveLength(1);
    expect(d.t.calls(d.log2, "echo")).toEqual([]);
  });

  it("refuses the call with the stopped line, before its question, when the new connection fails", async () => {
    const d = await dropped((fake) => fake.stop());
    await d.turn;
    expect(d.t.results(d.session)).toEqual([{ output: STOPPED("r"), isError: true }]);
    expect([d.t.q.asked, d.t.notes]).toEqual([[], []]);
    const line = `MCP server r stopped: connect ECONNREFUSED 127.0.0.1:${d.fake.port}; reconnect it from /mcp.`;
    expect(d.t.errors.map((e) => [e.kind, e.message])).toEqual([
      ["mcp", line],
      ["tool", STOPPED("r")],
    ]);
  });

  // Choice 13: a server answering in JSON keeps no open connection, so its restart is seen only when a request fails.
  it("finds a drop no answer showed at the call, which connects again and reaches the server once, asked once", async () => {
    const d = await dropped(
      async (fake, log2) => {
        await fake.stop();
        await httpFake(path.dirname(log2), { port: fake.port, log: log2, tools });
      },
      { unseen: true },
    );
    await d.turn;
    expect(d.t.results(d.session)).toEqual([
      { output: "one", isError: false },
      { output: "back", isError: false },
    ]);
    expect(d.t.q.asked).toEqual(['mcp__r__echo {"text":"one"}', 'mcp__r__echo {"text":"back"}']);
    // The call that found the drop (its old session unknown here), the new connection, the call once more.
    const methods = d.t.sent(d.log2).flatMap((m) => (m.method === "initialize" || m.method === "tools/call" ? [m.method] : []));
    expect(methods).toEqual(["tools/call", "initialize", "tools/call"]);
    expect([d.t.notes, d.t.errors]).toEqual([[AGAIN("r")], []]);
  });

  it("stops the wait for a new connection at Esc, as any tool's", async () => {
    const stop = new AbortController();
    const d = await dropped(
      async (fake, log2) => {
        await fake.stop();
        await httpFake(path.dirname(log2), { port: fake.port, log: log2, tools, silent: true }); // it never answers
      },
      { signal: stop.signal },
    );
    await vi.waitFor(() => expect(d.t.sent(d.log2).map((m) => m.method)).toContain("initialize"), WAIT);
    stop.abort();
    await d.turn;
    expect(d.t.results(d.session)).toEqual([{ output: "Cancelled by the user.", isError: true }]);
    expect([d.t.outcomes, d.t.q.asked, d.t.errors]).toEqual([["cancelled"], [], []]);
  });
});

// Release 8c plan, choice 34: a tool's picture is the server's, never words the user typed.
describe("MCP tools in the session: saved", () => {
  it("keeps a tool's picture out of the prompts a resumed window and its judge read", async () => {
    const t = await setup();
    const folder = path.join(t.dir, "sessions", "project");
    privateDir(folder);
    const [file, pictures] = [path.join(folder, "s1.jsonl"), path.join(folder, "s1", "pictures")];
    const transcript = new Transcript(file, pictures);
    const start = { v: 1 as const, id: "s1", project: t.dir, lead: "fake:a", version: "0.8.0", print: false, system: "t", tools: [] };
    transcript.write({ t: "start", ...start });
    const servers = await t.ready([await t.local("s")]);
    const { session } = t.session(servers, [callTool("c1", "mcp__s__picture", {}), reply("seen")], { transcript });
    await session.send("show it");
    const r = readTranscript(file, pictures);
    if ("problem" in r) throw new Error(r.problem);
    expect(r.messages[2]!.parts[1]).toEqual({ type: "image", id: 1, mediaType: "image/png", data: png, from: "server" });
    expect(r.prompts).toEqual(["show it"]);

    // A new window in auto mode, as cli.tsx makes its judge, which reads the loaded session's prompts.
    const judge = new FakeProvider("judge", [reply(JSON.stringify({ allow: false, reason: "It was not asked for." }))]);
    let resumed: Session | undefined;
    const gate = new PermissionGate("auto", async () => false, undefined, { root: t.dir, headless: false, judge: judgeOf(judge, () => resumed!, "", t.bus) });
    const outside = path.join(t.dir, "..", `${path.basename(t.dir)}-elsewhere`, "a.txt"); // refused, so never written
    const lead = new FakeProvider("a", [callTool("c2", "write_file", { path: outside, content: "x" }), reply("done")]);
    resumed = new Session({ lead, tools: [writeFileTool], system: "t", ctx: { ...t.ctx, gate }, bus: t.bus });
    const { start: s, messages, system, prompts, calls, nextPicture, nextTask } = r;
    resumed.load({ id: s.id, messages, system, transcript: new Transcript(file, pictures), prompts, calls, nextPicture, nextTask });
    await resumed.send("write it");
    const asked = texts(judge.seen[0]![0]!)[0]!.split("\n"); // the prompts' block, then the calls' (judge.ts, request)
    expect(JSON.parse(asked[1]!)).toEqual(["show it", "write it"]);
  });
});
