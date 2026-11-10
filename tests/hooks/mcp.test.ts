import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { PermissionGate } from "../../src/core/permissions.js";
import { Session } from "../../src/core/session.js";
import type { Turn } from "../../src/core/types.js";
import { LocalExecutor, LocalWorkspace } from "../../src/exec/local.js";
import { type Event, type Hook, matcherOf } from "../../src/hooks/config.js";
import { Hooks, limitOf } from "../../src/hooks/hooks.js";
import type { ServerConfig } from "../../src/mcp/config.js";
import { Servers } from "../../src/mcp/servers.js";
import { type Approve, mcpTools } from "../../src/mcp/tools.js";
import { defineTool } from "../../src/tools/tool.js";
import { Bus, callTool, collectErrors, FakeProvider, removeTree, reply } from "../helpers.js";
import { type FakeOptions, fakeServer, readLog } from "../mcp/fake.js";

// Release 8c plan, Task 8: MCP calls as hooks see them, and mcp_tool hooks calling a fake server of tests/mcp/fake.ts
// directly. Every request the model is sent is a stand-in's; nothing of the user's is started or read.

// A wait on another process: a few seconds for a busy machine, well inside the test's 15 s (as tests/mcp/tools.test.ts).
const WAIT = { timeout: 5_000 };
const own = defineTool("own", "Tachikoma's own tool", z.object({}), async () => "own");

// An mcp_tool hook on the fake server, matching every value unless `fields` says otherwise.
const mcpHook = (event: Event, tool: string, input: Record<string, unknown> = {}, fields: Partial<Hook> = {}): Hook => ({
  event, matcher: { all: true }, command: "", mcp: { server: "fake", tool, input }, async: false, where: `"${event}"`, ...fields,
});
// A hook's answer as JSON, which the fake's echo says back, so an mcp_tool hook answers what a test gives it.
const answer = (event: Event, fields: object) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, ...fields } });

// The test's own folder, the project's root, with one fake server named "fake" logging every message it gets; started and
// ready unless `wait` is false. Its Servers are stopped before the folder is removed, as a running server holds it.
async function setup(fake: FakeOptions = {}, wait = true) {
  const dir = await mkdtemp(path.join(tmpdir(), "tachi-hooks-mcp-"));
  const bus = new Bus();
  const log = path.join(dir, "fake.jsonl");
  const config: ServerConfig = {
    name: "fake", safe: "fake", where: "user", trusted: null, trustedTools: [], alwaysLoad: true, written: "",
    entry: { kind: "stdio", command: process.execPath, args: [await fakeServer(dir, { log, ...fake })], env: {} },
  };
  const answers = () => {
    throw new Error("no project server here, so no answers are read");
  };
  const servers = new Servers([config], { root: dir, env: process.env, bus, answers, network: "none", lead: () => "fake:a" });
  onTestFinished(async () => {
    await servers.stopAll();
    await removeTree(dir);
  });
  servers.startAll();
  if (wait) await servers.ready();
  const errors = collectErrors(bus);
  // The question's stand-in: each MCP call it is asked about, by name and input.
  const asked: string[] = [];
  const approve: Approve = async (o, input) => void asked.push(`${o.spec.name} ${JSON.stringify(input)}`);
  const where = { sessionId: () => "s1", transcript: () => undefined, root: dir, mode: () => "ask" as const, effort: () => undefined, lead: () => "fake:a" };
  const hooksOf = (hooks: Hook[]) => {
    const made = new Hooks({ hooks, off: false, leftOut: [] }, where, bus);
    made.useServers(servers);
    return made;
  };
  const session = (hooks: Hooks, turns: Turn[]) => {
    const model = new FakeProvider("a", turns);
    const ctx = { root: dir, executor: new LocalExecutor(), workspace: new LocalWorkspace(dir), gate: new PermissionGate("never", async () => false) };
    return { session: new Session({ lead: model, tools: [own], system: "t", ctx, bus, mcp: mcpTools(servers, bus, approve), hooks }), model };
  };
  const results = (s: Session) =>
    s.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "tool_result" ? [{ output: p.output, isError: p.isError }] : [])));
  // Each tools/call the fake was sent, by name and arguments, and each cancellation it was told of.
  const calls = () => readLog(log).filter((m) => m.method === "tools/call").map((m) => [m.params.name, m.params.arguments]);
  const cancelled = () => readLog(log).filter((m) => m.method === "notifications/cancelled");
  const hookErrors = () => errors.filter((e) => e.kind === "hook").map((e) => e.message);
  return { dir, bus, servers, asked, hooksOf, session, results, calls, cancelled, hookErrors, where };
}

describe("MCP calls in hooks", { timeout: 15_000 }, () => {
  // Choice 18, and Claude Code's matcher rule: a bare mcp__fake matches nothing; the .* is needed.
  it("sends an MCP call as its mcp__ name with its arguments as tool_input; mcp__fake__.* matches it and a bare mcp__fake does not", async () => {
    const t = await setup();
    const hooks = t.hooksOf([
      mcpHook("PreToolUse", "echo", { text: "server: ${tool_name} ${tool_input.text}" }, { matcher: matcherOf("mcp__fake__.*") }),
      mcpHook("PreToolUse", "echo", { text: "bare" }, { matcher: matcherOf("mcp__fake") }),
    ]);
    const { session } = t.session(hooks, [callTool("c1", "mcp__fake__echo", { text: "hi" }), reply("done")]);
    await session.send("go");
    expect(t.calls()).toEqual([["echo", { text: "server: mcp__fake__echo hi" }], ["echo", { text: "hi" }]]);
    expect(t.hookErrors()).toEqual([]);
  });

  // Choice 19: the rewrite becomes the call's arguments, and the question shows it.
  it("takes a PreToolUse rewrite of an MCP call as its arguments, which the question shows and the server gets", async () => {
    const t = await setup();
    const rewrite = answer("PreToolUse", { updatedInput: { text: "rewritten" } });
    const hooks = t.hooksOf([mcpHook("PreToolUse", "echo", { text: rewrite }, { matcher: matcherOf("mcp__fake__echo") })]);
    const { session } = t.session(hooks, [callTool("c1", "mcp__fake__echo", { text: "hi" }), reply("done")]);
    await session.send("go");
    expect(t.asked).toEqual(['mcp__fake__echo {"text":"rewritten"}']);
    expect(t.calls()).toEqual([["echo", { text: rewrite }], ["echo", { text: "rewritten" }]]);
    expect(t.results(session)).toEqual([{ output: "rewritten", isError: false }]);
  });

  // Choice 20: a string replaces the text the model reads, and the answer's pictures go with it; anything else is ignored.
  it.each<[string, unknown, boolean]>([
    ["updatedMCPToolOutput", "replaced", true],
    ["updatedToolOutput", "replaced", true],
    ["updatedMCPToolOutput", { text: "replaced" }, false],
  ])("takes a PostToolUse %s of %j for an MCP call's text, its pictures dropped with it", async (field, value, taken) => {
    const t = await setup();
    const hooks = t.hooksOf([mcpHook("PostToolUse", "echo", { text: answer("PostToolUse", { [field]: value }) })]);
    const { session, model } = t.session(hooks, [callTool("c1", "mcp__fake__picture", {}), reply("done")]);
    await session.send("go");
    const [result] = t.results(session);
    const pictures = model.seen[1]!.at(-1)!.parts.filter((p) => p.type === "image");
    if (taken) expect([result, pictures]).toEqual([{ output: "replaced", isError: false }, []]);
    else {
      expect(result!.output).toMatch(/^\[The tool's answer has pictures: /);
      expect(pictures).toHaveLength(1);
    }
  });

  // The design review, finding 3: a hook's own call goes straight to the server, so no tool hook sees it, a catch-all one
  // cannot call itself, and nobody is asked about it.
  it("calls the server once for each model call from a catch-all PreToolUse and PostToolUse mcp_tool hook, asking nothing", async () => {
    const t = await setup();
    const hooks = t.hooksOf([mcpHook("PreToolUse", "echo", { text: "pre ${tool_name}" }), mcpHook("PostToolUse", "echo", { text: "post ${tool_name}" })]);
    const turns = [
      callTool("c1", "mcp__fake__echo", { text: "one" }), callTool("c2", "own", {}), callTool("c3", "mcp__fake__echo", { text: "two" }), reply("done"),
    ];
    const { session } = t.session(hooks, turns);
    await session.send("go");
    const around = (name: string, ...between: [string, object][]) => [["echo", { text: `pre ${name}` }], ...between, ["echo", { text: `post ${name}` }]];
    expect(t.calls()).toEqual([
      ...around("mcp__fake__echo", ["echo", { text: "one" }]),
      ...around("own"),
      ...around("mcp__fake__echo", ["echo", { text: "two" }]),
    ]);
    expect(t.asked).toEqual(['mcp__fake__echo {"text":"one"}', 'mcp__fake__echo {"text":"two"}']);
    expect(t.hookErrors()).toEqual([]);
  });

  // Choice 21: an isError answer is a failed hook, which never blocks, onFailure "block" or not.
  it("says an error answer in the approved line, and the call goes on", async () => {
    const t = await setup();
    const hooks = t.hooksOf([mcpHook("PreToolUse", "error", {}, { onFailure: "block" })]);
    const { session } = t.session(hooks, [callTool("c1", "mcp__fake__echo", { text: "hi" }), reply("done")]);
    await session.send("go");
    expect(t.hookErrors()).toEqual(["PreToolUse hook failed: fake error answered an error: it went wrong"]);
    expect(t.results(session)).toEqual([{ output: "hi", isError: false }]);
  });

  it("says a server that stopped, one not in the settings, and any without servers given, not running", async () => {
    const t = await setup();
    await t.servers.server("fake")!.callTool("exit", { code: 3 }, {}).catch(() => {});
    await vi.waitFor(() => expect(t.servers.server("fake")!.state.is).toBe("stopped"), WAIT);
    const gone = mcpHook("PreToolUse", "echo", {}, { mcp: { server: "gone", tool: "echo", input: {} } });
    const hooks = t.hooksOf([mcpHook("PreToolUse", "echo"), gone]);
    const lines = ["fake echo could not be called: fake is not running", "gone echo could not be called: gone is not running"];
    expect((await hooks.fire("PreToolUse", {})).failures).toEqual(lines);
    expect(t.hookErrors()).toEqual(lines.map((l) => `PreToolUse hook failed: ${l}`));
    const without = new Hooks({ hooks: [mcpHook("Stop", "echo")], off: false, leftOut: [] }, t.where, new Bus());
    expect((await without.fire("Stop", {})).failures).toEqual(["fake echo could not be called: fake is not running"]);
  });

  // Choice 22, and a subagent's hooks calling through the lead's servers.
  it("fills ${path} in the input's text from the hook's input, a missing path empty and a whole object as its JSON", async () => {
    const t = await setup();
    const input = {
      text: "${tool_input.file_path}|${tool_input.nope}|${tool_response}", whole: "${tool_input}", list: ["${tool_name}", 3], deep: { n: "${duration_ms}" },
    };
    const hooks = t.hooksOf([mcpHook("PostToolUse", "echo", input)]);
    const fields = { tool_name: "Read", tool_input: { file_path: "/p/a.ts" }, tool_response: "text", duration_ms: 5 };
    await hooks.fire("PostToolUse", fields, { match: "Read" });
    const filled = { text: "/p/a.ts||text", whole: '{"file_path":"/p/a.ts"}', list: ["Read", 3], deep: { n: "5" } };
    expect(t.calls()).toEqual([["echo", filled]]);
    await hooks.for({ id: "t1" }, t.bus).fire("PostToolUse", fields, { match: "Read" });
    expect(t.calls()).toEqual([["echo", filled], ["echo", filled]]);
  });

  // Choice 21: Claude Code skips mcp_tool hooks at the launch's SessionStart, the window's first, whatever its source.
  it("skips mcp_tool hooks at the launch's SessionStart without a line, running its command hooks, and runs them at a later one", async () => {
    const t = await setup();
    const command: Hook = { event: "SessionStart", matcher: { all: true }, command: process.execPath, args: ["-e", ""], async: false, where: '"SessionStart"' };
    const hooks = t.hooksOf([mcpHook("SessionStart", "echo", { text: "${source}" }), command]);
    await hooks.fire("SessionStart", { source: "resume" }, { match: "resume" });
    expect([t.calls(), t.hookErrors(), hooks.runs.map((r) => r.hook)]).toEqual([[], [], [command]]);
    await hooks.fire("SessionStart", { source: "clear" }, { match: "clear" });
    expect(t.calls()).toEqual([["echo", { text: "clear" }]]);
  });

  // Claude Code's hooks reference: 600 s, or 30 s at UserPromptSubmit, unless the hook's timeout says otherwise; the
  // library tells the server of a call it stops.
  it("ends a call at its time limit and at a stop, telling the server each time, the limit in the approved line", async () => {
    const t = await setup();
    expect([limitOf(mcpHook("PreToolUse", "echo")), limitOf(mcpHook("UserPromptSubmit", "echo"))]).toEqual([600, 30]);
    const hooks = t.hooksOf([mcpHook("PreToolUse", "slow", {}, { timeout: 0.5 })]);
    expect((await hooks.fire("PreToolUse", {})).failures).toEqual(["fake slow ran out of time after 0.5 s"]);
    await vi.waitFor(() => expect(t.cancelled()).toHaveLength(1), WAIT);
    hooks.set({ hooks: [mcpHook("PreToolUse", "slow")], off: false, leftOut: [] });
    const stop = new AbortController();
    const firing = hooks.fire("PreToolUse", {}, { signal: stop.signal });
    await vi.waitFor(() => expect(t.calls()).toHaveLength(2), WAIT);
    stop.abort();
    await expect(firing).rejects.toThrow("Cancelled");
    await vi.waitFor(() => expect(t.cancelled()).toHaveLength(2), WAIT);
  });

  // Choice 21: on the events that can block, a hook waits for a server still starting, within its own limit; on the
  // others it fails at once. The fake holds its start for a second before it reads anything.
  it("waits for a starting server at an event that can block, within its limit, and fails at once at one that cannot", async () => {
    const t = await setup({ start: "const t = Date.now(); while (Date.now() - t < 1000) {}" }, false);
    expect(t.servers.server("fake")!.state.is).toBe("starting");
    const hooks = t.hooksOf([
      mcpHook("PreToolUse", "echo", { text: "pre" }), mcpHook("PostToolUse", "echo", { text: "post" }), mcpHook("Stop", "echo", {}, { timeout: 0.2 }),
    ]);
    const [pre, post, stop] = await Promise.all([hooks.fire("PreToolUse", {}), hooks.fire("PostToolUse", {}), hooks.fire("Stop", {})]);
    expect([pre.failures, post.failures, stop.failures]).toEqual([
      [], ["fake echo could not be called: fake is not running"], ["fake echo ran out of time after 0.2 s"]]);
    expect(t.calls()).toEqual([["echo", { text: "pre" }]]);
  });
});
