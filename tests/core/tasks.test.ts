import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { privateDir } from "../../src/auth/private.js";
import { type Ask, type Owner, PermissionGate } from "../../src/core/permissions.js";
import { Session } from "../../src/core/session.js";
import { Stats } from "../../src/core/stats.js";
import { type SubagentTask, Tasks } from "../../src/core/tasks.js";
import { type Line, readTranscript, Transcript } from "../../src/core/transcript.js";
import type { Provider, Turn } from "../../src/core/types.js";
import { type ExecResult, MAX_TOOL_OUTPUT, type Running } from "../../src/exec/executor.js";
import { CommandLog, deliver } from "../../src/exec/log.js";
import type { Hook } from "../../src/hooks/config.js";
import { Hooks, type Where } from "../../src/hooks/hooks.js";
import type { ServerConfig } from "../../src/mcp/config.js";
import { Servers } from "../../src/mcp/servers.js";
import { BoxState } from "../../src/sandbox/executor.js";
import { delegateTool } from "../../src/tools/delegate.js";
import { readFileTool } from "../../src/tools/files.js";
import { Bus, FakeProvider, Held, callTool, collectErrors, removeTree, reply, tempContext, texts } from "../helpers.js";
import { fakeServer, readLog } from "../mcp/fake.js";

async function setup(
  worker: Provider | (() => Provider),
  opts: { max?: number; ask?: Ask; transcript?: () => Transcript | undefined; limits?: { started: number; moved: number; most: number } } = {},
) {
  const bus = new Bus();
  const ctx = await tempContext();
  const gate = new PermissionGate("project", opts.ask ?? (async () => false));
  const tasks = new Tasks({
    bus,
    max: opts.max ?? 8,
    worker: typeof worker === "function" ? worker : () => worker,
    system: "sub",
    tools: [readFileTool],
    ctx: { ...ctx, gate },
    ...(opts.transcript ? { transcript: opts.transcript } : {}),
    ...(opts.limits ? { limits: opts.limits } : {}),
  });
  return { bus, tasks, ctx, errors: collectErrors(bus) };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("Tasks", () => {
  it("runs a subagent in a conversation of its own, with its own prompt and tools, and returns its last reply", async () => {
    const worker = new Held();
    const { tasks } = await setup(worker);
    const t = tasks.start("find the login code", { background: false });
    await settle();
    expect(worker.asked[0]!.system).toBe("sub");
    expect(worker.asked[0]!.tools.map((s) => s.name)).toEqual(["read_file"]);
    expect(worker.asked[0]!.messages).toEqual([{ role: "user", parts: [{ type: "text", text: "find the login code" }] }]);
    expect(tasks.all).toEqual([t]);
    expect([t.id, t.state, t.model]).toEqual(["t1", "running", "fake:held"]);
    worker.answer("It is in src/auth.ts:12");
    expect(await t.done).toEqual({ state: "done", text: "It is in src/auth.ts:12" });
    expect(tasks.all[0]!.state).toBe("done");
    expect(tasks.take()).toEqual([]); // the waiting delegate call had it
  });

  // Release 7 plan, choice 6: a subagent's brief is the lead's words, so the judge never takes it for the user's.
  it("keeps no prompt in a subagent's session", async () => {
    const send = vi.spyOn(Session.prototype, "send");
    onTestFinished(() => send.mockRestore());
    const { tasks } = await setup(new FakeProvider("w", [reply("found it")]));
    await tasks.start("find the login code", { background: false }).done;
    const session = send.mock.contexts[0] as Session;
    expect(texts(session.messages[0]!)).toEqual(["find the login code"]); // the subagent's own session
    expect(session.prompts).toEqual([]);
  });

  it("numbers subagents through the session", async () => {
    const { tasks } = await setup(new FakeProvider("w", [reply("a"), reply("b"), reply("c")]));
    for (const task of ["a", "b", "c"]) await tasks.start(task, { background: false }).done;
    expect(tasks.all.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });

  // Release 8a plan, choice 4: a loaded conversation's subagents keep their names, so no id is handed out twice.
  it("numbers subagents on from a loaded conversation's next number, and never lowers it", async () => {
    const { tasks } = await setup(new FakeProvider("w", [reply("a"), reply("b"), reply("c")]));
    tasks.from(5);
    await tasks.start("a", { background: false }).done;
    tasks.from(2); // a conversation with fewer subagents, loaded after
    await tasks.start("b", { background: false }).done;
    tasks.from(6);
    await tasks.start("c", { background: false }).done;
    expect(tasks.all.map((t) => t.id)).toEqual(["t5", "t6", "t7"]);
  });

  it("keeps a background subagent's answer for the lead, handed over once, and says when anything changed", async () => {
    const { tasks, bus } = await setup(new FakeProvider("w", [reply("found it")]));
    let changes = 0;
    bus.on("tasks", () => changes++);
    await tasks.start("find x", { background: true }).done;
    expect(tasks.wakes()).toBe(true);
    expect(tasks.take()).toEqual(["Background task t1 (find x) finished:\nfound it"]);
    expect(tasks.take()).toEqual([]);
    expect(tasks.wakes()).toBe(false);
    expect(changes).toBeGreaterThan(0);
  });

  it("cuts a long answer at the size every tool's output is cut at", async () => {
    const { tasks } = await setup(new FakeProvider("w", [reply("x".repeat(MAX_TOOL_OUTPUT + 5))]));
    await tasks.start("find x", { background: true }).done;
    expect(tasks.take()[0]).toMatch(/\n\[cut: 5 more characters\]$/);
  });

  it("runs no more than the most at once; the next waits for a free place", async () => {
    const worker = new Held();
    const { tasks } = await setup(worker, { max: 2 });
    for (const n of [1, 2, 3]) tasks.start(`job ${n}`, { background: true });
    await settle();
    expect(tasks.all.map((t) => t.state)).toEqual(["running", "running", "waiting"]);
    expect(worker.asked).toHaveLength(2);
    worker.answer("one");
    await settle();
    expect(tasks.all.map((t) => t.state)).toEqual(["done", "running", "running"]);
  });

  it("gives a failure as the answer, with the reason, and logs it as the subagent's", async () => {
    const { tasks, errors } = await setup(new FakeProvider("w", [new Error("rate limited")]));
    expect(await tasks.start("find x", { background: true }).done).toEqual({ state: "failed", text: "rate limited" });
    expect(tasks.wakes()).toBe(true);
    expect(tasks.take()).toEqual(["Background task t1 (find x) failed: rate limited"]);
    expect(errors.map((e) => [e.kind, e.attempted, e.message])).toEqual([["provider", "t1: request to fake:w", "rate limited"]]);
  });

  it("does not wake the lead for a subagent the user stopped, but tells it with the next message", async () => {
    const worker = new Held();
    const { tasks } = await setup(worker);
    const bg = tasks.start("find x", { background: true });
    const fg = tasks.start("find y", { background: false });
    await settle();
    expect(tasks.stop("t1")).toBe(true);
    expect(await bg.done).toEqual({ state: "stopped", text: "t1 was stopped by the user before it finished." });
    expect(tasks.wakes()).toBe(false);
    expect(tasks.take()).toEqual(["Background task t1 (find x) was stopped by the user before it finished."]);
    expect(tasks.stop()).toBe(true); // all
    expect((await fg.done).state).toBe("stopped");
    expect(tasks.stop("t9")).toBe(false);
    expect(tasks.stop("t1")).toBe(false); // no longer running
  });

  it("stops the subagents a turn waits for when the turn stops, not background ones", async () => {
    const worker = new Held();
    const { tasks } = await setup(worker);
    const turn = new AbortController();
    const fg = tasks.start("a", { background: false, signal: turn.signal });
    tasks.start("b", { background: true });
    await settle();
    turn.abort();
    expect(await fg.done).toEqual({ state: "stopped", text: "t1 was stopped." });
    expect(tasks.all[1]!.state).toBe("running");
    expect(tasks.take()).toEqual([]);
  });

  it("never runs a subagent stopped while it waited for a place", async () => {
    const worker = new Held();
    const { tasks } = await setup(worker, { max: 1 });
    tasks.start("a", { background: true });
    const b = tasks.start("b", { background: true });
    await settle();
    tasks.stop("t2");
    expect((await b.done).state).toBe("stopped");
    worker.answer("x");
    await settle();
    expect(worker.asked).toHaveLength(1);
  });

  it("reports its spend on the lead's bus, marked, so the totals grow while the context stays the lead's", async () => {
    const { tasks, bus } = await setup(new FakeProvider("w", [reply("x")]));
    const stats = new Stats(bus);
    bus.emit("usage", { provider: "anthropic:claude-opus-5-5", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } });
    const marked: (string | undefined)[] = [];
    bus.on("usage", (u) => marked.push(u.task));
    await tasks.start("x", { background: false }).done;
    expect(marked).toEqual(["t1"]);
    expect([stats.input, stats.output, stats.context]).toEqual([110, 15, 110]);
    expect([(tasks.all[0] as SubagentTask).output, (tasks.all[0] as SubagentTask).costUnknown]).toEqual([5, true]); // a fake model has no price
  });

  it("keeps each subagent's latest tool call for the panel", async () => {
    const { tasks } = await setup(new FakeProvider("w", [callTool("c1", "read_file", { path: "a.txt" }), reply("none")]));
    await tasks.start("x", { background: false }).done;
    expect((tasks.all[0] as SubagentTask).lastTool).toEqual({ name: "read_file", input: { path: "a.txt" } });
  });

  it("asks before a read outside the project, naming the subagent, which Ctrl-C there stops", async () => {
    const owners: Owner[] = [];
    const elsewhere = path.resolve("/elsewhere/notes.txt");
    const { tasks } = await setup(new FakeProvider("w", [callTool("c1", "read_file", { path: elsewhere }), reply("x")]), {
      ask: async (_summary, _detail, owner) => {
        owners.push(owner!);
        owner!.stop();
        return false;
      },
    });
    expect((await tasks.start("find the notes", { background: false }).done).state).toBe("stopped");
    expect(owners.map((o) => o.name)).toEqual(["t1 (find the notes)"]);
  });

  it("fails to start when no worker model can be made", async () => {
    const { tasks } = await setup(() => {
      throw new Error("Set ANTHROPIC_API_KEY to use anthropic");
    });
    expect(() => tasks.start("x", { background: false })).toThrow("Set ANTHROPIC_API_KEY to use anthropic");
    expect(tasks.all).toEqual([]);
  });

  it("takes finished subagents off the panel at the next turn the user starts, keeping running ones", async () => {
    const worker = new Held();
    const { tasks } = await setup(worker);
    const a = tasks.start("a", { background: true });
    tasks.start("b", { background: true });
    await settle();
    worker.answer("x");
    await a.done;
    tasks.clearFinished();
    expect(tasks.all.map((t) => t.shown)).toEqual([false, true]);
    expect(tasks.running).toBe(1);
  });

  // The subagent's own bus, which #work hands its gate. Its session fires no hooks yet (release 8b plan, Tasks 6-12 wire
  // them), so a test says a hook's lines there as its Hooks (from `for`) will.
  function ownBus() {
    const made = vi.spyOn(PermissionGate.prototype, "for");
    onTestFinished(() => made.mockRestore());
    return () => made.mock.calls[0]![1]!.bus;
  }

  // Release 8b plan review, 2026-11-09, finding 1: a hook's failure never fails a subagent.
  it("finishes a subagent done with its answer when its hook times out, the failure on the lead's bus starting with its id", { timeout: 15_000 }, async () => {
    const own = ownBus();
    const root = await mkdtemp(path.join(tmpdir(), "tachi-tasks-hook-"));
    onTestFinished(async () => {
      // Windows keeps the folder a killed program worked in for about 170 ms (measured 2026-10-31), so the removal is
      // tried every 50 ms up to 2 s, as tests/hooks/run.test.ts does.
      for (let i = 0; ; i++) {
        try {
          return await removeTree(root);
        } catch (err) {
          if (i === 40) throw err;
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    });
    const script = path.join(root, "slow.cjs");
    writeFileSync(script, "setInterval(() => {}, 1000);"); // never ends by itself
    // Half a second keeps the test quick; the line is the same whether or not Node had started by then.
    const slow: Hook = { event: "PreToolUse", matcher: { all: true }, command: process.execPath, args: [script], timeout: 0.5, async: false, where: "" };
    const worker = new Held();
    const { tasks, bus, errors } = await setup(worker);
    const t = tasks.start("find x", { background: false });
    await settle();
    const where: Where = { sessionId: () => "s1", transcript: () => undefined, root, mode: () => "project", effort: () => undefined, lead: () => "fake:lead" };
    const hooks = new Hooks({ hooks: [slow], off: false, leftOut: [] }, where, bus).for({ id: "t1" }, own());
    await hooks.fire("PreToolUse", { tool_name: "Read" }, { match: "Read" });
    worker.answer("found it");
    expect(await t.done).toEqual({ state: "done", text: "found it" });
    const line = `PreToolUse hook failed: ${process.execPath} ${script} ran out of time after 0.5 s`;
    // The subagent's own model, as its other errors record (Task 4's spec review).
    expect(errors).toEqual([{ kind: "hook", attempted: "t1: PreToolUse hook", message: `t1: ${line}`, lead: worker.id }]);
  });

  // Release 8b plan review, 2026-11-09, second round, finding 3: a subagent's hook lines reach the user.
  it("passes on a hook note said on a subagent's bus to the lead's, starting with its id", async () => {
    const own = ownBus();
    const worker = new Held();
    const { tasks, bus } = await setup(worker);
    const notes: string[] = [];
    bus.on("hook-note", (line) => notes.push(line));
    const t = tasks.start("find x", { background: false });
    await settle();
    own().emit("hook-note", "PreToolUse hook: checked");
    worker.answer("found it");
    await t.done;
    expect(notes).toEqual(["t1: PreToolUse hook: checked"]);
  });

  // Release 8c plan, Task 7 and choice 17: a subagent only reads, so it is offered only the tools the user trusts as
  // read-only, which run without a question; the fake server (tests/mcp/fake.ts) is the only one started.
  it("gives a subagent only the MCP tools trusted as read-only, each run without a question", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachi-tasks-mcp-"));
    const log = path.join(dir, "log.jsonl");
    const script = await fakeServer(dir, { log });
    const entry = { kind: "stdio" as const, command: process.execPath, args: [script], env: {} };
    const config: ServerConfig = {
      name: "s", safe: "s", where: "user", trusted: null, trustedTools: ["echo"], alwaysLoad: true, written: "", entry, asWritten: entry,
    };
    const bus = new Bus();
    const answers = () => {
      throw new Error("no project server here, so no answers are read");
    };
    const servers = new Servers([config], { root: dir, env: process.env, bus, answers, network: "none", lead: () => "fake:a" });
    // Stopped before the folder is removed: on Windows a running server holds the folder it works in.
    onTestFinished(async () => {
      await servers.stopAll();
      await removeTree(dir);
    });
    servers.startAll();
    await servers.ready();
    const ctx = await tempContext("ask");
    const tools: string[][] = [];
    const turns = [callTool("c1", "mcp__s__echo", { text: "hi" }), reply("found it")];
    const worker: Provider = { id: "fake:w", complete: async (req) => (tools.push(req.tools.map((s) => s.name)), turns.shift()!) };
    const tasks = new Tasks({ bus, max: 1, worker: () => worker, system: "sub", tools: [], ctx, mcp: servers });
    const task = tasks.start("look", { background: false });
    expect(await task.done).toEqual({ state: "done", text: "found it" });
    expect(tools).toEqual([
      ["tool_search", "mcp__s__echo"],
      ["tool_search", "mcp__s__echo"],
    ]);
    expect(task.messages[2]!.parts).toEqual([{ type: "tool_result", callId: "c1", output: "hi", isError: false }]);
    expect(ctx.asked).toEqual([]);
    expect(readLog(log).filter((m) => m.method === "tools/call").map((m) => m.params.arguments)).toEqual([{ text: "hi" }]);
  });
});

// Release 8a plan, Task 5: each subagent saves its own transcript beside the lead's. The sessions folder is inside a fresh
// temporary folder and made private once, as tests/core/transcript.test.ts does, each case with its own session in it.
describe("Tasks, saved", { timeout: 15_000 }, () => {
  let top: string;
  let shared: string;
  let sessions = 0;
  beforeAll(async () => {
    top = await mkdtemp(path.join(tmpdir(), "tachi-tasks-"));
    shared = path.join(top, "sessions", "project");
    privateDir(shared);
  });
  afterAll(() => removeTree(top));
  function place() {
    const id = `s${++sessions}`;
    return { id, file: path.join(shared, `${id}.jsonl`), pictures: path.join(shared, id, "pictures"), subagents: path.join(shared, id, "subagents") };
  }
  const start = (id: string): Omit<Extract<Line, { t: "start" }>, "at"> => ({
    t: "start",
    v: 1,
    id,
    project: "C:\\a project",
    lead: "fake:lead",
    version: "0.8.0",
    print: false,
    system: "t",
    tools: [],
  });
  const lines = (file: string) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Line);
  const read = (p: { file: string; pictures: string }) => {
    const r = readTranscript(p.file, p.pictures);
    if ("problem" in r) throw new Error(r.problem);
    return r;
  };

  it("writes a subagent's turn to its own file, after a line in the lead's naming it with its description", async () => {
    const p = place();
    const lead = new Transcript(p.file, p.pictures);
    let before = "";
    const worker: Provider = {
      id: "fake:w",
      complete: async () => {
        before = readFileSync(p.file, "utf8");
        return reply("It is in src/auth.ts:12");
      },
    };
    const { tasks } = await setup(worker, { transcript: () => lead });
    await tasks.start("find the login code", { description: "find login", background: false }).done;
    const line = { t: "subagent", id: "t1", description: "find login", file: "t1.jsonl" };
    expect(lines(p.file)).toEqual([{ ...line, at: expect.any(String) }]);
    expect(JSON.parse(before)).toMatchObject(line); // there before the subagent's first request
    expect(lines(path.join(p.subagents, "t1.jsonl"))).toEqual([
      { t: "message", at: expect.any(String), message: { role: "user", parts: [{ type: "text", text: "find the login code" }] } },
      { t: "message", at: expect.any(String), message: { role: "assistant", parts: [{ type: "text", text: "It is in src/auth.ts:12" }], lead: "fake:w" } },
    ]);
  });

  it("finishes a subagent whose own file cannot be written, saying so in its own line, never failing it, the lead saving on", async () => {
    const p = place();
    // A file where its subagents folder should be, so only the subagent's own writes fail, with no permission changed.
    mkdirSync(path.dirname(p.subagents));
    writeFileSync(p.subagents, "not a folder");
    const lead = new Transcript(p.file, p.pictures);
    const { tasks, errors } = await setup(new FakeProvider("w", [reply("found it")]), { transcript: () => lead });
    expect(await tasks.start("find x", { description: "find", background: false }).done).toEqual({ state: "done", text: "found it" });
    const file = path.join(p.subagents, "t1.jsonl");
    // The reason its own write gave: a write to the same file fails the same way.
    const probe = new Transcript(file, p.pictures);
    probe.write({ t: "name", name: "x" });
    expect(probe.failed).toEqual(expect.stringMatching(/\S/));
    // The approved line for a subagent's saving (plan, "Lines this plan adds"; user, 2026-11-06, "Its own line"), and no
    // lead's line, as the lead saves on.
    const message =
      `Saving subagent t1 stopped: ${file} could not be written (${probe.failed}). ` +
      "A resumed session will report its answer as lost, and its conversation will end with an error if it grows too long for the model.";
    expect(errors).toEqual([{ kind: "saving", attempted: `t1: ${file}`, message, lead: "fake:w" }]);
    expect(lead.failed).toBeNull();
    expect(lines(p.file).map((l) => l.t)).toEqual(["subagent"]);
  });

  it("records a background subagent when it starts, so one stopped while it waited for a place reads as ended", async () => {
    const p = place();
    const lead = new Transcript(p.file, p.pictures);
    lead.write(start(p.id));
    const { tasks } = await setup(new Held(), { max: 1, transcript: () => lead });
    const first = tasks.start("find a", { description: "first", background: true });
    const second = tasks.start("find b", { description: "waits", background: true });
    // On disk before start returns, so before delegate answers "Started t2 in the background".
    expect(lines(p.file).flatMap((l) => (l.t === "subagent" ? [l.id] : []))).toEqual(["t1", "t2"]);
    await settle();
    expect(tasks.all.map((t) => t.state)).toEqual(["running", "waiting"]);
    tasks.stop("t2");
    expect((await second.done).state).toBe("stopped");
    expect(lines(path.join(p.subagents, "t2.jsonl"))).toEqual([{ t: "ended", at: expect.any(String), state: "stopped" }]);
    expect(read(p).unfinished).toEqual([{ id: "t1", description: "first" }]);
    tasks.stop("t1");
    await first.done;
  });

  it("saves no subagent file once the lead's saving has stopped, and the subagent still finishes", async () => {
    const p = place();
    // A folder where the lead's transcript should be, so its writes fail while its session folder could still be made.
    mkdirSync(p.file);
    const bus = new Bus();
    const errors = collectErrors(bus);
    const ctx = await tempContext();
    const gate = new PermissionGate("project", async () => false);
    let session: Session | undefined;
    const worker = new FakeProvider("w", [reply("a is here")]);
    const transcript = () => session?.transcript;
    const tasks = new Tasks({ bus, max: 8, worker: () => worker, system: "sub", tools: [readFileTool], ctx: { ...ctx, gate }, transcript });
    const lead = new FakeProvider("lead", [callTool("c1", "delegate", { description: "first", task: "find a" }), reply("a found")]);
    const tools = [delegateTool(tasks, { headless: false })];
    session = new Session({ lead, tools, system: "t", ctx: { ...ctx, gate }, bus, inbox: () => tasks.take(), transcript: new Transcript(p.file, p.pictures) });
    await session.send("find a");
    expect((tasks.all as SubagentTask[]).map((t) => [t.id, t.state, t.answer])).toEqual([["t1", "done", "a is here"]]);
    expect(existsSync(path.join(shared, p.id))).toBe(false); // no subagents folder, nor the session's own
    expect(errors.map((e) => [e.kind, e.message.split(":")[0]])).toEqual([["saving", "Saving this session stopped"]]);
  });

  it("ends the file of a subagent that failed, and of one that was stopped, with how it ended, so neither reads as unfinished", async () => {
    const p = place();
    const lead = new Transcript(p.file, p.pictures);
    lead.write(start(p.id));
    const held = new Held();
    const failing = new FakeProvider("w", [new Error("rate limited")]);
    const { tasks } = await setup(() => (tasks.all.length ? held : failing), { transcript: () => lead });
    expect((await tasks.start("find x", { description: "fails", background: true }).done).state).toBe("failed");
    const stopped = tasks.start("find y", { description: "stopped", background: true });
    const running = tasks.start("find z", { description: "still going", background: true });
    await settle();
    tasks.stop("t2");
    expect((await stopped.done).state).toBe("stopped");
    expect(lines(path.join(p.subagents, "t1.jsonl")).at(-1)).toEqual({ t: "ended", at: expect.any(String), state: "failed" });
    expect(lines(path.join(p.subagents, "t2.jsonl")).at(-1)).toEqual({ t: "ended", at: expect.any(String), state: "stopped" });
    for (const id of ["t1", "t2"]) expect(lines(path.join(p.subagents, `${id}.jsonl`)).filter((l) => l.t === "ended")).toHaveLength(1);
    // Only the one still running when the file was read had not finished.
    expect(read(p).unfinished).toEqual([{ id: "t3", description: "still going" }]);
    tasks.stop("t3");
    await running.done;
  });

  it("numbers a resumed session's next subagent after the saved ones, in a file of its own", async () => {
    const p = place();
    // One window, as cli.tsx makes it: the subagents save beside the session's transcript, read at each start.
    async function window(turns: Turn[], answer: string, saved?: Transcript) {
      const bus = new Bus();
      const ctx = await tempContext();
      const gate = new PermissionGate("project", async () => false);
      let session: Session | undefined;
      const tasks = new Tasks({
        bus,
        max: 8,
        worker: () => new FakeProvider("w", [reply(answer)]),
        system: "sub",
        tools: [readFileTool],
        ctx: { ...ctx, gate },
        transcript: () => session?.transcript,
      });
      session = new Session({
        lead: new FakeProvider("lead", turns),
        tools: [delegateTool(tasks, { headless: false })],
        system: "t",
        ctx: { ...ctx, gate },
        bus,
        inbox: () => tasks.take(),
        tasks,
        ...(saved ? { transcript: saved } : {}),
      });
      return { session, tasks };
    }
    const first = new Transcript(p.file, p.pictures);
    first.write(start(p.id));
    const one = await window([callTool("c1", "delegate", { description: "first", task: "find a" }), reply("a found")], "a is here", first);
    await one.session.send("find a");
    const t1 = readFileSync(path.join(p.subagents, "t1.jsonl"), "utf8");

    // A new process: the transcript read back and loaded into a new window's session.
    const r = read(p);
    expect(r.nextTask).toBe(2);
    const two = await window([callTool("c2", "delegate", { description: "second", task: "find b" }), reply("b found")], "b is here");
    const { messages, system, prompts, calls, nextPicture, nextTask } = r;
    two.session.load({ id: p.id, messages, system, transcript: new Transcript(p.file, p.pictures), prompts, calls, nextPicture, nextTask });
    await two.session.send("find b");
    expect(two.tasks.all.map((t) => t.id)).toEqual(["t2"]);
    expect(readFileSync(path.join(p.subagents, "t1.jsonl"), "utf8")).toBe(t1);
    expect(lines(path.join(p.subagents, "t2.jsonl"))[0]).toMatchObject({ t: "message", message: { role: "user", parts: [{ type: "text", text: "find b" }] } });
    expect(lines(p.file).flatMap((l) => (l.t === "subagent" ? [[l.id, l.description]] : []))).toEqual([
      ["t1", "first"],
      ["t2", "second"],
    ]);
    expect(read(p).unfinished).toEqual([]);
  });
});

// Background commands plan, Task 4: a background command joins the task list. Its Running is a stand-in the test drives:
// a log it adds to, a `done` it settles, and a stop that settles `done` at once, as the executors' does (choice 1).
describe("Tasks, background commands", () => {
  function command() {
    const log = new CommandLog();
    let s!: { end: (r: ExecResult) => void; fail: (err: Error) => void };
    const done = new Promise<ExecResult>((end, fail) => (s = { end, fail }));
    const stop = vi.fn(() => s.end({ code: null, signal: "SIGKILL", stdout: "", stderr: "" }));
    const run: Running = { log, done, stop };
    const end = (code: number | null, signal: NodeJS.Signals | null = null) => s.end({ code, signal, stdout: "", stderr: "" });
    return { run, stop, end, fail: (err: Error) => s.fail(err) };
  }
  // A command in the box (user choice 36, PR #18 review): a stop only starts its kill there, which the test then lets run,
  // ending `done` as a kill, or fail, rejecting it.
  function boxCommand() {
    const c = command();
    const stop = vi.fn();
    return { ...c, stop, run: { ...c.run, stop, stopsLater: true } as Running };
  }
  // The lead's transcript as the list writes to it, a stand-in so no file is made; `failed` keeps a subagent from saving a
  // file of its own beside it.
  function lead() {
    const lines: object[] = [];
    const transcript = () => ({ failed: "a stand-in", write: (l: object) => lines.push(l) }) as unknown as Transcript;
    return { lines, transcript };
  }
  // The -p limits Task 11 passes, from the plan's "Numbers in this plan" (Claude Code's tools reference): 10 minutes for a
  // start without a timeout and for a moved command, 2 hours at most.
  const limits = { started: 600_000, moved: 600_000, most: 7_200_000 };
  const fakeTimers = () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => void vi.useRealTimers());
  };

  it("numbers commands and subagents from one counter, so no id is handed out twice", async () => {
    const { tasks } = await setup(new Held());
    tasks.start("a", { background: true });
    const c = tasks.adopt(command().run, { command: "npm run dev" });
    tasks.start("b", { background: true });
    expect(tasks.all.map((t) => [t.id, t.kind])).toEqual([
      ["t1", "subagent"],
      ["t2", "command"],
      ["t3", "subagent"],
    ]);
    expect(c).toMatchObject({ kind: "command", id: "t2", command: "npm run dev", background: true, state: "running", shown: true });
    expect([tasks.get("t2"), tasks.get("t9")]).toEqual([c, undefined]);
    tasks.stop();
  });

  it("writes the command's line to the lead's transcript before adopt returns, and its ending line at the end", async () => {
    const saved = lead();
    const { tasks } = await setup(new Held(), { transcript: saved.transcript });
    const c = command();
    const t = tasks.adopt(c.run, { command: "npm run dev" });
    expect(saved.lines).toEqual([{ t: "command", id: "t1", command: "npm run dev" }]);
    c.end(0);
    await t.done;
    expect(saved.lines).toEqual([
      { t: "command", id: "t1", command: "npm run dev" },
      { t: "command-ended", id: "t1", state: "done" },
    ]);
  });

  // Choice 29, the user's: closing stops every command and subagent, but writes no ending line and leaves no note for a
  // command, so a resume reports it; one stopped before keeps its ending. The -p limit's timer goes too.
  it("stops everything on close, writing no ending line and leaving no note for a command still running", async () => {
    fakeTimers();
    const saved = lead();
    const worker = new Held();
    const { tasks } = await setup(worker, { transcript: saved.transcript, limits });
    const [a, b] = [command(), command()];
    const [ta, tb] = [tasks.adopt(a.run, { command: "npm run dev" }), tasks.adopt(b.run, { command: "npm test" })];
    const sub = tasks.start("find x", { background: true });
    tasks.stop("t2");
    tasks.take();
    tasks.close();
    await Promise.all([ta.done, tb.done, sub.done]);
    expect(a.stop).toHaveBeenCalled();
    expect([ta.state, tb.state, sub.state, tasks.running]).toEqual(["stopped", "stopped", "stopped", 0]);
    expect(saved.lines.filter((l) => (l as { t: string }).t.startsWith("command"))).toEqual([
      { t: "command", id: "t1", command: "npm run dev" },
      { t: "command", id: "t2", command: "npm test" },
      { t: "command-ended", id: "t2", state: "stopped" },
    ]);
    expect(tasks.take()).toEqual(["Background task t3 (find x) was stopped by the user before it finished."]); // as release 8a
    vi.advanceTimersByTime(limits.most);
    expect(tasks.take()).toEqual([]);
  });

  it("wakes the lead when a command ends, its entry holding the output since the last read", async () => {
    const { tasks } = await setup(new Held());
    const c = command();
    const t = tasks.adopt(c.run, { command: "npm test" });
    expect(tasks.running).toBe(1);
    c.run.log.add("one\n");
    expect(deliver("read", c.run.log, "t1")).toBe("read\none\n"); // as a shell_output read before the end
    c.run.log.add("two\n");
    c.end(0);
    await t.done;
    expect([t.state, t.code, t.signal, typeof t.ended, tasks.running]).toEqual(["done", 0, null, "number", 0]);
    expect(tasks.wakes()).toBe(true);
    expect(tasks.answering()).toEqual([{ id: "t1", kind: "command" }]);
    expect(tasks.take()).toEqual(["Background command t1 (npm test) ended with exit code 0:\ntwo\n"]);
    expect([tasks.take(), tasks.wakes()]).toEqual([[], false]);
  });

  it("ends a command failed on any other exit, its entry saying the code or the signal", async () => {
    const { tasks } = await setup(new Held());
    const [a, b] = [command(), command()];
    const [ta, tb] = [tasks.adopt(a.run, { command: "make" }), tasks.adopt(b.run, { command: "serve" })];
    a.run.log.add("no rule\n");
    b.run.log.add("listening\n");
    a.end(2);
    b.end(null, "SIGTERM");
    await Promise.all([ta.done, tb.done]);
    expect([ta.state, ta.code, tb.state, tb.signal]).toEqual(["failed", 2, "failed", "SIGTERM"]);
    expect(tasks.take()).toEqual([
      "Background command t1 (make) ended with exit code 2:\nno rule\n",
      "Background command t2 (serve) was killed by SIGTERM:\nlistening\n",
    ]);
  });

  // Choice 7: shell_output on an ended command calls told, so the exit code never reaches the model twice.
  it("drops a command's ending from the inbox once the model was told of it", async () => {
    const { tasks } = await setup(new Held());
    const c = command();
    const t = tasks.adopt(c.run, { command: "npm test" });
    c.end(1);
    await t.done;
    expect(tasks.wakes()).toBe(true);
    tasks.told("t1");
    expect([tasks.wakes(), tasks.answering(), tasks.take()]).toEqual([false, [], []]);
  });

  it("gives the output once in all when it is read after the end and before the ending is taken", async () => {
    const { tasks } = await setup(new Held());
    const [a, b] = [command(), command()];
    const [ta, tb] = [tasks.adopt(a.run, { command: "npm test" }), tasks.adopt(b.run, { command: "serve" })];
    a.run.log.add("all of it\n");
    a.end(0);
    b.end(null, "SIGTERM");
    await Promise.all([ta.done, tb.done]);
    expect(deliver("t1 ended with exit code 0.", a.run.log, "t1")).toBe("t1 ended with exit code 0.\nall of it\n");
    expect(tasks.take()).toEqual([
      "Background command t1 (npm test) ended with exit code 0, with no new output.",
      "Background command t2 (serve) was killed by SIGTERM, with no new output.",
    ]);
  });

  // Choice 24: the first line cuts its command as Claude Code cuts one it shows a hook.
  it("cuts a long command in an ending's first line at 1,000 characters", async () => {
    const { tasks } = await setup(new Held());
    const long = `echo ${"x".repeat(1_195)}`;
    const c = command();
    const t = tasks.adopt(c.run, { command: long });
    c.end(0);
    await t.done;
    expect(tasks.take()).toEqual([`Background command t1 (${long.slice(0, 1_000)}… [+200 chars]) ended with exit code 0, with no new output.`]);
  });

  it("stops a command for the user and for stop_task, each said once at the next turn, waking no one", async () => {
    const saved = lead();
    const { tasks } = await setup(new Held(), { transcript: saved.transcript });
    const [a, b] = [command(), command()];
    const [ta, tb] = [tasks.adopt(a.run, { command: "npm run dev" }), tasks.adopt(b.run, { command: "npm run watch" })];
    a.run.log.add("ready\n");
    expect(tasks.stop("t1")).toBe(true);
    expect(tasks.stop("t2", "tool")).toBe(true);
    await Promise.all([ta.done, tb.done]); // each stop's SIGKILL end adds no ending of its own
    expect([ta.state, tb.state, typeof ta.ended, tasks.running]).toEqual(["stopped", "stopped", "number", 0]);
    expect([tasks.wakes(), tasks.answering()]).toEqual([false, []]);
    expect(tasks.take()).toEqual([
      "Background command t1 (npm run dev) was stopped by the user.",
      "Background command t2 (npm run watch) was stopped by stop_task.",
    ]);
    expect(tasks.take()).toEqual([]);
    expect(tasks.stop("t1")).toBe(false); // no longer running
    expect([a.stop.mock.calls.length, b.stop.mock.calls.length]).toEqual([1, 1]);
    expect(saved.lines.slice(2)).toEqual([
      { t: "command-ended", id: "t1", state: "stopped" },
      { t: "command-ended", id: "t2", state: "stopped" },
    ]);
  });

  // Choice 23: Docker that cannot be reached, or a spawn error, rejects `done`.
  it("ends a command whose run fails as failed, telling the lead with its output, its -p timer cleared", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    onTestFinished(() => void process.off("unhandledRejection", unhandled));
    const saved = lead();
    const { tasks } = await setup(new Held(), { transcript: saved.transcript, limits });
    fakeTimers();
    const [a, b] = [command(), command()];
    const [ta, tb] = [tasks.adopt(a.run, { command: "npm run dev" }), tasks.adopt(b.run, { command: "serve" })];
    expect(vi.getTimerCount()).toBe(2);
    a.run.log.add("starting\n");
    a.fail(new Error("Docker could not be reached"));
    b.fail(new Error("e".repeat(1_200))); // a head stays short, so the output has room (As built, Task 1)
    await Promise.all([ta.done, tb.done]);
    expect([ta.state, tb.state, vi.getTimerCount()]).toEqual(["failed", "failed", 0]);
    expect(tasks.wakes()).toBe(true);
    expect(tasks.take()).toEqual([
      "Background command t1 (npm run dev) failed: Docker could not be reached\nstarting\n",
      `Background command t2 (serve) failed: ${"e".repeat(1_000)}… [+200 chars]\nNo new output.`,
    ]);
    expect(saved.lines.slice(2)).toEqual([
      { t: "command-ended", id: "t1", state: "failed" },
      { t: "command-ended", id: "t2", state: "failed" },
    ]);
    vi.advanceTimersByTime(limits.most);
    expect([a.stop.mock.calls.length, tasks.take(), ta.state]).toEqual([0, [], "failed"]);
    await new Promise((r) => setImmediate(r));
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("stops every subagent and every command when no id is given", async () => {
    const { tasks } = await setup(new Held());
    const sub = tasks.start("find x", { background: true });
    const c = command();
    const t = tasks.adopt(c.run, { command: "npm run dev" });
    await settle();
    expect(tasks.stop()).toBe(true);
    expect((await sub.done).state).toBe("stopped");
    await t.done;
    expect([t.state, c.stop.mock.calls.length, tasks.running]).toEqual(["stopped", 1, 0]);
    expect(tasks.stop()).toBe(false);
  });

  // Choice 8: under -p a background command has a time limit, as Claude Code's does.
  it("stops a -p command at its limit: 10 minutes without a timeout, its timeout up to 2 hours, 10 minutes from a move", async () => {
    const saved = lead();
    const { tasks } = await setup(new Held(), { transcript: saved.transcript, limits });
    fakeTimers();
    const [plain, long, over] = [command(), command(), command()];
    const tp = tasks.adopt(plain.run, { command: "npm run dev" });
    const tl = tasks.adopt(long.run, { command: "npm run e2e", limit: 7_200_000 });
    const to = tasks.adopt(over.run, { command: "npm run soak", limit: 9_000_000 }); // more than the most is cut to it
    plain.run.log.add("ready\n");
    vi.advanceTimersByTime(600_000 - 1);
    expect(plain.stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect([plain.stop.mock.calls.length, tp.state, typeof tp.ended, tasks.wakes()]).toEqual([1, "stopped", "number", true]);
    expect(tasks.take()).toEqual(['Background command "npm run dev" was stopped after reaching its background time limit\nready\n']);
    const moved = command();
    const tm = tasks.adopt(moved.run, { command: "npm run build", moved: true });
    vi.advanceTimersByTime(600_000 - 1);
    expect(moved.stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(tm.state).toBe("stopped");
    expect(tasks.take()).toEqual(['Background command "npm run build" was stopped after reaching its background time limit\nNo new output.']);
    vi.advanceTimersByTime(7_200_000 - 1_200_000 - 1); // 1,200,000 have passed
    expect([long.stop.mock.calls.length, over.stop.mock.calls.length]).toEqual([0, 0]);
    vi.advanceTimersByTime(1);
    expect([tl.state, to.state]).toEqual(["stopped", "stopped"]);
    expect(tasks.take()).toEqual([
      'Background command "npm run e2e" was stopped after reaching its background time limit\nNo new output.',
      'Background command "npm run soak" was stopped after reaching its background time limit\nNo new output.',
    ]);
    await Promise.all([tp.done, tl.done, to.done, tm.done]);
    expect(tasks.take()).toEqual([]); // a stop's SIGKILL end adds no ending
    expect(saved.lines.filter((l) => (l as { t: string }).t === "command-ended")).toEqual(
      ["t1", "t4", "t2", "t3"].map((id) => ({ t: "command-ended", id, state: "stopped" })),
    );
  });

  it("clears a -p command's time limit when the user stops it", async () => {
    const { tasks } = await setup(new Held(), { limits });
    fakeTimers();
    const c = command();
    tasks.adopt(c.run, { command: "npm run dev" });
    expect(tasks.stop("t1")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(600_000 + 1);
    expect(tasks.take()).toEqual(["Background command t1 (npm run dev) was stopped by the user."]);
    expect(c.stop).toHaveBeenCalledTimes(1);
  });

  // User choice 37, PR #18 review and its fixes' review: under -p each turn the wait starts takes one ending, at its first
  // take or at a later one, after a round of tool calls.
  it("gives one ending in all, the first, with every note, in a turn -p's wait starts", async () => {
    const { tasks } = await setup(new Held());
    const [a, b, c, d, e, f] = [command(), command(), command(), command(), command(), command()];
    const [ta, , tc, , te, tf] = [
      tasks.adopt(a.run, { command: "make" }),
      tasks.adopt(b.run, { command: "serve" }),
      tasks.adopt(c.run, { command: "npm test" }),
      tasks.adopt(d.run, { command: "npm run watch" }),
      tasks.adopt(e.run, { command: "npm run e2e" }),
      tasks.adopt(f.run, { command: "npm run lint" }),
    ];
    a.end(0);
    await ta.done;
    tasks.stop("t2");
    c.end(1);
    await tc.done;
    await tasks.oneEnding(async () => {
      expect(tasks.take()).toEqual([
        "Background command t1 (make) ended with exit code 0, with no new output.",
        "Background command t2 (serve) was stopped by the user.",
      ]);
      tasks.stop("t4");
      expect(tasks.take()).toEqual(["Background command t4 (npm run watch) was stopped by the user."]); // t3's ending waits
    });
    await tasks.oneEnding(async () => {
      expect(tasks.take()).toEqual(["Background command t3 (npm test) ended with exit code 1, with no new output."]);
      e.end(0);
      await te.done;
      expect(tasks.take()).toEqual([]); // t5's, ended during the turn, waits for one of its own
    });
    f.end(0);
    await tf.done;
    // A turn that failed ends its hold, and a window's take takes everything.
    await expect(tasks.oneEnding(() => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect(tasks.take()).toEqual([
      "Background command t5 (npm run e2e) ended with exit code 0, with no new output.",
      "Background command t6 (npm run lint) ended with exit code 0, with no new output.",
    ]);
  });

  // User choice 36, PR #18 review: in the box a stop counts once its kill has run there.
  it("counts a box stop once its kill has run, the command running until then, said once at the next turn", async () => {
    const saved = lead();
    const { tasks } = await setup(new Held(), { transcript: saved.transcript, limits });
    fakeTimers();
    const c = boxCommand();
    const t = tasks.adopt(c.run, { command: "npm run dev" });
    expect(tasks.stop("t1")).toBe(true);
    expect([t.state, t.stoppedBy, tasks.running, tasks.take()]).toEqual(["running", undefined, 1, []]);
    expect(tasks.stop("t1")).toBe(false); // the first stop's words stand
    vi.advanceTimersByTime(limits.started); // nor does the limit stop it again
    expect(c.stop).toHaveBeenCalledTimes(1);
    c.end(null, "SIGKILL");
    await t.done;
    expect([t.state, t.stoppedBy, tasks.running, tasks.wakes()]).toEqual(["stopped", "user", 0, false]);
    expect(tasks.take()).toEqual(["Background command t1 (npm run dev) was stopped by the user."]);
    expect(saved.lines.slice(1)).toEqual([{ t: "command-ended", id: "t1", state: "stopped" }]);
  });

  it("ends a box command failed when the user's stop cannot kill it, said once at the next turn, waking no one", async () => {
    const saved = lead();
    const { tasks } = await setup(new Held(), { transcript: saved.transcript });
    const c = boxCommand();
    const t = tasks.adopt(c.run, { command: "npm run dev" });
    c.run.log.add("ready\n");
    tasks.stop("t1");
    // The sandbox's own failure, as the box's `done` rejects with it (sandbox/executor.ts, inGroup and BoxState.fail).
    c.fail(new BoxState("b0x").fail("The stop could not reach the box (Docker is not running)"));
    await t.done;
    const error = "The sandbox stopped working: The stop could not reach the box (Docker is not running). Shell and file tools are off until Tachikoma is launched again.";
    expect([t.state, t.stoppedBy, t.error, tasks.wakes()]).toEqual(["failed", undefined, error, false]);
    expect(tasks.take()).toEqual([`Background command t1 (npm run dev) failed: ${error}\nready\n`]);
    expect(saved.lines.slice(1)).toEqual([{ t: "command-ended", id: "t1", state: "failed" }]);
  });

  // PR #18 fixes' review: a command that ends by itself while the box's kill is on its way is said stopped.
  it("says a box command stopped by its stopper when it ended by itself while the kill was on its way", async () => {
    const { tasks } = await setup(new Held());
    const c = boxCommand();
    const t = tasks.adopt(c.run, { command: "npm test" });
    tasks.stop("t1", "tool");
    c.end(0);
    await t.done;
    expect([t.state, t.stoppedBy, t.code]).toEqual(["stopped", "tool", undefined]);
    expect(tasks.take()).toEqual(["Background command t1 (npm test) was stopped by stop_task."]);
  });

  it("tells the lead of a box command's -p limit only once its kill has run, or that the kill failed", async () => {
    const { tasks } = await setup(new Held(), { limits });
    fakeTimers();
    const [a, b] = [boxCommand(), boxCommand()];
    const [ta, tb] = [tasks.adopt(a.run, { command: "npm run dev" }), tasks.adopt(b.run, { command: "npm run watch" })];
    vi.advanceTimersByTime(limits.started);
    expect([a.stop.mock.calls.length, b.stop.mock.calls.length, ta.state, tb.state]).toEqual([1, 1, "running", "running"]);
    expect([tasks.wakes(), tasks.take()]).toEqual([false, []]);
    a.end(null, "SIGKILL");
    await ta.done;
    expect([ta.state, ta.stoppedBy, tasks.wakes()]).toEqual(["stopped", "limit", true]);
    expect(tasks.take()).toEqual(['Background command "npm run dev" was stopped after reaching its background time limit\nNo new output.']);
    b.fail(new Error("The stop could not reach the box (Docker is not running)"));
    await tb.done;
    expect([tb.state, tb.stoppedBy, tasks.wakes()]).toEqual(["failed", undefined, true]);
    expect(tasks.take()).toEqual([
      "Background command t2 (npm run watch) failed at its background time limit: The stop could not reach the box (Docker is not running)\nNo new output.",
    ]);
  });

  it("gives a command no time limit outside -p", async () => {
    const { tasks } = await setup(new Held());
    fakeTimers();
    const c = command();
    const t = tasks.adopt(c.run, { command: "npm run dev", limit: 600_000 });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(7_200_000);
    expect([t.state, c.stop.mock.calls.length, tasks.wakes()]).toEqual(["running", 0, false]);
    tasks.stop();
  });

  // Choice 9: the shell tool holds its foreground command here while it runs, for Ctrl+B.
  it("moves the held foreground command, and says when none is held", async () => {
    const { tasks } = await setup(new Held());
    expect(tasks.moveForeground()).toBe(false);
    const move = vi.fn();
    tasks.holding = { move };
    expect([tasks.moveForeground(), move.mock.calls.length]).toEqual([true, 1]);
    tasks.holding = undefined;
    expect(tasks.moveForeground()).toBe(false);
  });

  // Choice 5: commands never take a place under --max-tasks.
  it("never holds a command back for --max-tasks, nor takes a subagent's place", async () => {
    const worker = new Held();
    const { tasks } = await setup(worker, { max: 8 });
    for (let n = 1; n <= 8; n++) tasks.start(`job ${n}`, { background: true });
    await settle();
    const t = tasks.adopt(command().run, { command: "npm run dev" });
    tasks.start("job 9", { background: true });
    await settle();
    expect([t.state, tasks.all.at(-1)!.state, tasks.running, worker.asked.length]).toEqual(["running", "waiting", 10, 8]);
    worker.answer("one");
    await settle();
    expect([tasks.all.at(-1)!.state, worker.asked.length]).toEqual(["running", 9]);
    tasks.stop();
  });
});
