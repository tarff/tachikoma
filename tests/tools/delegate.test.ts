import { describe, expect, it } from "vitest";
import { PermissionGate } from "../../src/core/permissions.js";
import { Tasks } from "../../src/core/tasks.js";
import type { Provider } from "../../src/core/types.js";
import { delegateTool } from "../../src/tools/delegate.js";
import { SUBAGENT_TOOLS } from "../../src/tools/index.js";
import { Bus, FakeProvider, reply, tempContext } from "../helpers.js";

async function setup(worker: Provider, headless = false) {
  const ctx = await tempContext();
  const tasks = new Tasks({ bus: new Bus(), max: 8, worker: () => worker, system: "sub", tools: SUBAGENT_TOOLS, ctx: { ...ctx, gate: new PermissionGate("project", async () => false) } });
  return { tasks, ctx, tool: delegateTool(tasks, { headless }) };
}

// A worker that answers only when stopped: it never finishes on its own.
const hanging = (): Provider => ({
  id: "fake:hang",
  complete: ({ signal }) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))),
});

describe("delegate", () => {
  it("waits for the subagent and returns its answer", async () => {
    const { tool, ctx } = await setup(new FakeProvider("w", [reply("It is in src/auth.ts:12")]));
    expect(await tool.run({ task: "find the login code" }, ctx)).toBe("It is in src/auth.ts:12");
  });

  it("with background, returns at once, the answer coming in a later message", async () => {
    const { tool, ctx, tasks } = await setup(new FakeProvider("w", [reply("found")]));
    expect(await tool.run({ task: "find x", background: true }, ctx)).toBe("Started t1 in the background; its answer will come in a later message.");
    await tasks.all[0]!.done;
    expect(tasks.take()).toEqual(["Background task t1 (find x) finished:\nfound"]);
  });

  it("with -p, runs a background task in the foreground and says why", async () => {
    const { tool, ctx, tasks } = await setup(new FakeProvider("w", [reply("found")]), true);
    expect(await tool.run({ task: "find x", background: true }, ctx)).toBe("t1 ran in the foreground, since -p has no later turn to read a background answer in.\n\nfound");
    expect(tasks.take()).toEqual([]);
  });

  it("gives a failure, with its reason, as the answer, so the lead knows", async () => {
    const { tool, ctx } = await setup(new FakeProvider("w", [new Error("rate limited")]));
    expect(await tool.run({ task: "find x" }, ctx)).toBe("t1 failed: rate limited");
  });

  it("says when the user stopped the subagent", async () => {
    const { tool, ctx, tasks } = await setup(hanging());
    const answer = tool.run({ task: "find x" }, ctx);
    await new Promise((r) => setTimeout(r, 20));
    tasks.stop("t1");
    expect(await answer).toBe("t1 was stopped by the user before it finished.");
  });

  it("stops the subagent when the turn waiting for it stops", async () => {
    const { tool, ctx, tasks } = await setup(hanging());
    const turn = new AbortController();
    const answer = tool.run({ task: "find x" }, { ...ctx, signal: turn.signal });
    await new Promise((r) => setTimeout(r, 20));
    turn.abort();
    await answer;
    expect(tasks.all[0]!.state).toBe("stopped");
  });

  it("runs beside the reply's other delegate calls, and gives subagents only the reading tools", async () => {
    const { tool } = await setup(hanging());
    expect(tool.parallel).toBe(true);
    expect(SUBAGENT_TOOLS.map((t) => t.spec.name)).toEqual(["read_file", "find_files", "search_files"]);
  });
});
