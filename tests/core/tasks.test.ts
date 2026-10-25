import path from "node:path";
import { describe, expect, it } from "vitest";
import { type Ask, type Owner, PermissionGate } from "../../src/core/permissions.js";
import { Stats } from "../../src/core/stats.js";
import { Tasks } from "../../src/core/tasks.js";
import type { CompletionRequest, Provider, Turn } from "../../src/core/types.js";
import { MAX_TOOL_OUTPUT } from "../../src/exec/executor.js";
import { readFileTool } from "../../src/tools/files.js";
import { Bus, FakeProvider, callTool, collectErrors, reply, tempContext } from "../helpers.js";

async function setup(worker: Provider | (() => Provider), opts: { max?: number; ask?: Ask } = {}) {
  const bus = new Bus();
  const ctx = await tempContext();
  const gate = new PermissionGate("project", opts.ask ?? (async () => false));
  const tasks = new Tasks({ bus, max: opts.max ?? 8, worker: typeof worker === "function" ? worker : () => worker, system: "sub", tools: [readFileTool], ctx: { ...ctx, gate } });
  return { bus, tasks, ctx, errors: collectErrors(bus) };
}

// A worker whose every reply waits until the test sends it, or until the subagent is stopped.
class Held implements Provider {
  readonly id = "fake:held";
  readonly asked: CompletionRequest[] = [];
  #replies: ((t: Turn) => void)[] = [];
  complete(req: CompletionRequest): Promise<Turn> {
    this.asked.push(req);
    return new Promise((resolve, reject) => {
      this.#replies.push(resolve);
      req.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  }
  answer(text: string) {
    this.#replies.shift()!(reply(text));
  }
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

  it("numbers subagents through the session", async () => {
    const { tasks } = await setup(new FakeProvider("w", [reply("a"), reply("b"), reply("c")]));
    for (const task of ["a", "b", "c"]) await tasks.start(task, { background: false }).done;
    expect(tasks.all.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
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
});
