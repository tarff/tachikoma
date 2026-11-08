import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { privateDir } from "../../src/auth/private.js";
import { type Ask, type Owner, PermissionGate } from "../../src/core/permissions.js";
import { Session } from "../../src/core/session.js";
import { Stats } from "../../src/core/stats.js";
import { Tasks } from "../../src/core/tasks.js";
import { type Line, readTranscript, Transcript } from "../../src/core/transcript.js";
import type { Provider, Turn } from "../../src/core/types.js";
import { MAX_TOOL_OUTPUT } from "../../src/exec/executor.js";
import type { Hook } from "../../src/hooks/config.js";
import { Hooks, type Where } from "../../src/hooks/hooks.js";
import { delegateTool } from "../../src/tools/delegate.js";
import { readFileTool } from "../../src/tools/files.js";
import { Bus, FakeProvider, Held, callTool, collectErrors, removeTree, reply, tempContext, texts } from "../helpers.js";

async function setup(worker: Provider | (() => Provider), opts: { max?: number; ask?: Ask; transcript?: () => Transcript | undefined } = {}) {
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
    expect(tasks.all.map((x) => [x.id, x.state, x.model])).toEqual([["t1", "running", "fake:held"]]);
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
    expect([tasks.all[0]!.output, tasks.all[0]!.costUnknown]).toEqual([5, true]); // a fake model has no price
  });

  it("keeps each subagent's latest tool call for the panel", async () => {
    const { tasks } = await setup(new FakeProvider("w", [callTool("c1", "read_file", { path: "a.txt" }), reply("none")]));
    await tasks.start("x", { background: false }).done;
    expect(tasks.all[0]!.lastTool).toEqual({ name: "read_file", input: { path: "a.txt" } });
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
    expect(errors).toEqual([{ kind: "hook", attempted: "t1: PreToolUse hook", message: `t1: ${line}`, lead: "fake:lead" }]);
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
    expect(tasks.all.map((t) => [t.id, t.state, t.answer])).toEqual([["t1", "done", "a is here"]]);
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
