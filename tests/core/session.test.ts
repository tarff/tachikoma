import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Declined } from "../../src/core/permissions.js";
import { Session } from "../../src/core/session.js";
import { Stats } from "../../src/core/stats.js";
import { MAX_TOOL_OUTPUT } from "../../src/exec/executor.js";
import { defineTool } from "../../src/tools/tool.js";
import { Bus, FakeProvider, callTool, collectErrors, reply, tempContext, usage } from "../helpers.js";

const echo = defineTool("echo", "Echo text back", z.object({ text: z.string() }), async ({ text }) => text);
const boom = defineTool("boom", "Always fails", z.object({}), async () => {
  throw new Error("it broke");
});
const shy = defineTool("shy", "Always declined", z.object({}), async () => {
  throw new Declined("The user declined: shy");
});

async function setup(turns: ConstructorParameters<typeof FakeProvider>[1]) {
  const bus = new Bus();
  const lead = new FakeProvider("a", turns);
  const ctx = await tempContext();
  const session = new Session({ lead, tools: [echo, boom, shy], system: "test", ctx, bus });
  return { bus, lead, session, errors: collectErrors(bus) };
}

describe("Session", () => {
  it("stores the user's message and the reply", async () => {
    const { session } = await setup([reply("hello")]);
    await session.send("hi");
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(session.messages[1]!.parts).toEqual([{ type: "text", text: "hello" }]);
  });

  it("runs a tool and sends its result back before the final reply", async () => {
    const { session, lead } = await setup([callTool("c1", "echo", { text: "ping" }), reply("done")]);
    await session.send("go");
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(session.messages[2]!.parts).toEqual([{ type: "tool_result", callId: "c1", output: "ping", isError: false }]);
    expect(lead.seen).toHaveLength(2);
  });

  it("turns a failing tool into an error result and logs it", async () => {
    const { session, errors } = await setup([callTool("c1", "boom", {}), reply("sorry")]);
    await session.send("go");
    expect(session.messages[2]!.parts[0]).toMatchObject({ isError: true, output: "it broke" });
    expect(errors).toEqual([expect.objectContaining({ kind: "tool", message: "it broke", lead: "fake:a" })]);
  });

  it("cuts a very long tool input in the error it reports", async () => {
    const text = "x".repeat(MAX_TOOL_OUTPUT + 5);
    const { session, errors } = await setup([callTool("c1", "nope", { text }), reply("ok")]);
    await session.send("go");
    const full = `nope ${JSON.stringify({ text })}`;
    expect(errors[0]!.attempted).toBe(`${full.slice(0, MAX_TOOL_OUTPUT)}\n[cut: ${full.length - MAX_TOOL_OUTPUT} more characters]`);
  });

  it("reports an unknown tool to the model", async () => {
    const { session, errors } = await setup([callTool("c1", "nope", {}), reply("ok")]);
    await session.send("go");
    expect(session.messages[2]!.parts[0]).toMatchObject({ isError: true, output: "Unknown tool: nope" });
    expect(errors).toHaveLength(1);
  });

  it("tells the model about bad tool input", async () => {
    const { session } = await setup([callTool("c1", "echo", { text: 3 }), reply("ok")]);
    await session.send("go");
    expect(session.messages[2]!.parts[0]).toMatchObject({ isError: true, output: expect.stringContaining("Invalid input for echo") });
  });

  it("does not log a declined action as an error", async () => {
    const { session, errors } = await setup([callTool("c1", "shy", {}), reply("ok")]);
    await session.send("go");
    expect(session.messages[2]!.parts[0]).toMatchObject({ isError: true, output: "The user declined: shy" });
    expect(errors).toEqual([]);
  });

  it("does not log a tool cancelled by the user as an error", async () => {
    const abort = new AbortController();
    const slow = defineTool("slow", "Waits to be cancelled", z.object({}), async (_, ctx) => {
      abort.abort();
      throw new Error(ctx.signal?.aborted ? "Cancelled" : "not cancelled");
    });
    const bus = new Bus();
    const errors = collectErrors(bus);
    const session = new Session({ lead: new FakeProvider("a", [callTool("c1", "slow", {})]), tools: [slow], system: "t", ctx: await tempContext(), bus });
    await session.send("go", abort.signal);
    expect(session.messages.at(-1)!.parts[0]).toMatchObject({ isError: true, output: "Cancelled by the user." });
    expect(errors).toEqual([]);
  });

  it("retries a refused turn on the fallback provider and says so", async () => {
    const refused = { ...reply(""), cutOff: { kind: "refusal" as const, detail: "declined" } };
    const bus = new Bus();
    const errors = collectErrors(bus);
    const seen: string[] = [];
    bus.on("usage", (u) => seen.push(u.provider));
    const rescue = new FakeProvider("b", [reply("answered by b")]);
    const session = new Session({ lead: new FakeProvider("a", [refused]), fallback: rescue, tools: [], system: "t", ctx: await tempContext(), bus });
    await session.send("go");
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(session.messages[1]!.parts).toEqual([{ type: "text", text: "answered by b" }]);
    expect(errors.map((e) => e.kind)).toEqual(["fallback"]); // the rescued refusal is reported only as the rescue
    expect(errors[0]!.message).toBe("fake:a declined; fake:b answered instead");
    expect(seen).toEqual(["fake:a", "fake:b"]); // the refused attempt is billed too
  });

  it("does not count a rescued refusal in the status line's errors", async () => {
    const refused = { ...reply(""), cutOff: { kind: "refusal" as const, detail: "declined" } };
    const bus = new Bus();
    const stats = new Stats(bus);
    const session = new Session({ lead: new FakeProvider("a", [refused]), fallback: new FakeProvider("b", [reply("answered by b")]), tools: [], system: "t", ctx: await tempContext(), bus });
    await session.send("go");
    expect(stats.errors).toBe(0);
  });

  it("still reports the refusal when the fallback provider's request fails", async () => {
    const refused = { ...reply(""), cutOff: { kind: "refusal" as const, detail: "declined" } };
    const bus = new Bus();
    const errors = collectErrors(bus);
    const session = new Session({ lead: new FakeProvider("a", [refused]), fallback: new FakeProvider("b", [new Error("rate limited")]), tools: [], system: "t", ctx: await tempContext(), bus });
    await session.send("go");
    expect(errors.map((e) => [e.kind, e.attempted, e.message])).toEqual([
      ["provider", "request to fake:b", "rate limited"],
      ["refusal", "response from fake:a", "declined"],
    ]);
    expect(session.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("stops when the fallback provider refuses as well", async () => {
    const refused = (p: string) => ({ ...reply(""), cutOff: { kind: "refusal" as const, detail: `${p} declined` } });
    const bus = new Bus();
    const errors = collectErrors(bus);
    const session = new Session({ lead: new FakeProvider("a", [refused("a")]), fallback: new FakeProvider("b", [refused("b")]), tools: [], system: "t", ctx: await tempContext(), bus });
    await session.send("go");
    expect(errors.map((e) => [e.kind, e.attempted, e.message])).toEqual([
      ["refusal", "response from fake:a", "a declined"],
      ["refusal", "response from fake:b", "b declined"],
    ]);
    expect(session.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("never stores a refused reply when there is no fallback", async () => {
    // A refusal mid-stream can leave a half-written tool call; it must not be stored or run.
    const refused = { ...callTool("c1", "echo", { text: "x" }), cutOff: { kind: "refusal" as const, detail: "declined" } };
    const { session, errors } = await setup([refused]);
    await session.send("go");
    expect(session.messages.map((m) => m.role)).toEqual(["user"]);
    expect(errors).toEqual([expect.objectContaining({ kind: "refusal", attempted: "response from fake:a", message: "declined" })]);
  });

  it("does not report Anthropic's fallback when its reply is still a refusal", async () => {
    const turn = { ...reply(""), fallbacks: [{ from: "claude-opus-5-5", to: "claude-opus-4-8" }], cutOff: { kind: "refusal" as const, detail: "declined" } };
    const { session, errors } = await setup([turn]);
    await session.send("go");
    expect(errors.map((e) => e.kind)).toEqual(["refusal"]);
  });

  it("reports Anthropic's own fallback inside the fallback provider's reply", async () => {
    const refused = { ...reply(""), cutOff: { kind: "refusal" as const, detail: "declined" } };
    const rescued = { ...reply("answered"), fallbacks: [{ from: "claude-opus-5-5", to: "claude-opus-4-8" }] };
    const bus = new Bus();
    const errors = collectErrors(bus);
    const session = new Session({ lead: new FakeProvider("a", [refused]), fallback: new FakeProvider("b", [rescued]), tools: [], system: "t", ctx: await tempContext(), bus });
    await session.send("go");
    expect(errors.map((e) => [e.kind, e.attempted, e.message])).toEqual([
      ["fallback", "response from fake:a", "fake:a declined; fake:b answered instead"],
      ["fallback", "response from fake:b", "claude-opus-5-5 declined; claude-opus-4-8 answered instead (Anthropic's fallback)"],
    ]);
  });

  it("reports the rescue when the fallback provider's reply is cut off", async () => {
    const refused = { ...reply(""), cutOff: { kind: "refusal" as const, detail: "declined" } };
    const cut = { ...reply("partial"), cutOff: { kind: "max_tokens" as const, detail: "limit" } };
    const bus = new Bus();
    const errors = collectErrors(bus);
    const session = new Session({ lead: new FakeProvider("a", [refused]), fallback: new FakeProvider("b", [cut]), tools: [], system: "t", ctx: await tempContext(), bus });
    await session.send("go");
    expect(errors.map((e) => [e.kind, e.attempted, e.message])).toEqual([
      ["fallback", "response from fake:a", "fake:a declined; fake:b answered instead"],
      ["max_tokens", "response from fake:b", "limit"],
    ]);
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(session.messages[1]!.parts).toEqual([{ type: "text", text: "partial" }]);
  });

  it("refuses a second send while a turn is running", async () => {
    const { session } = await setup([reply("first"), reply("second")]);
    const first = session.send("one");
    await expect(session.send("two")).rejects.toThrow("A turn is already running");
    await first;
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    await session.send("three"); // the turn has ended, so sending works again
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("reports when Anthropic's own fallback answered", async () => {
    const bus = new Bus();
    const errors = collectErrors(bus);
    const seen: string[] = [];
    bus.on("usage", (u) => seen.push(u.provider));
    const turn = { ...reply("hi"), fallbacks: [{ from: "claude-opus-5-5", to: "claude-opus-4-8" }], servedBy: "anthropic:claude-opus-4-8" };
    const session = new Session({ lead: new FakeProvider("a", [turn]), tools: [], system: "t", ctx: await tempContext(), bus });
    await session.send("go");
    expect(errors).toEqual([expect.objectContaining({ kind: "fallback", message: "claude-opus-5-5 declined; claude-opus-4-8 answered instead (Anthropic's fallback)" })]);
    expect(seen).toEqual(["anthropic:claude-opus-4-8"]); // priced as the model that answered
  });

  it("logs a provider failure without throwing", async () => {
    const { session, errors } = await setup([new Error("rate limited")]);
    await session.send("go");
    expect(errors).toEqual([expect.objectContaining({ kind: "provider", message: "rate limited" })]);
  });

  it("answers every tool call when a response is cut off", async () => {
    const cut = { ...callTool("c1", "echo", { text: "x" }), cutOff: { kind: "max_tokens" as const, detail: "limit" } };
    const { session, errors } = await setup([cut]);
    await session.send("go");
    expect(session.messages.at(-1)!.parts[0]).toMatchObject({ type: "tool_result", callId: "c1", isError: true });
    expect(errors).toEqual([expect.objectContaining({ kind: "max_tokens", message: "limit" })]);
  });

  it("cuts very long tool output", async () => {
    const { session } = await setup([callTool("c1", "echo", { text: "x".repeat(MAX_TOOL_OUTPUT + 5) }), reply("ok")]);
    await session.send("go");
    const out = (session.messages[2]!.parts[0] as { output: string }).output;
    expect(out).toContain("[cut: 5 more characters]");
  });

  it("hands the whole history to a new lead", async () => {
    const { session, bus } = await setup([reply("first")]);
    await session.send("one");
    const b = new FakeProvider("b", [reply("second")]);
    const leads: string[] = [];
    bus.on("lead", (id) => leads.push(id));
    session.setLead(b);
    await session.send("two");
    expect(leads).toEqual(["fake:b"]);
    expect(b.seen[0]!.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("reports usage for every request", async () => {
    const { session, bus } = await setup([reply("hi")]);
    const seen: unknown[] = [];
    bus.on("usage", (u) => seen.push(u));
    await session.send("go");
    expect(seen).toEqual([{ provider: "fake:a", usage }]);
  });

  it("reports attempts the provider's own fallback declined, before the reply's usage", async () => {
    const declined = [{ provider: "fake:x", usage, priceKnown: false }];
    const { session, bus } = await setup([{ ...reply("hi"), servedBy: "fake:y", declined }]);
    const seen: unknown[] = [];
    bus.on("usage", (u) => seen.push(u));
    await session.send("go");
    expect(seen).toEqual([{ provider: "fake:x", usage, priceKnown: false }, { provider: "fake:y", usage }]); // last sets the context size
  });
});

describe("Session tool events", () => {
  // Every tool event in order, as "start <id> <name> <input>" and "end <id> <outcome>".
  function watch(bus: Bus): string[] {
    const seen: string[] = [];
    bus.on("tool-start", (c) => seen.push(`start ${c.id} ${c.name} ${JSON.stringify(c.input)}`));
    bus.on("tool-end", (c) => seen.push(`end ${c.id} ${c.outcome}`));
    return seen;
  }
  const calls = (...c: [string, string, unknown][]) => ({ parts: c.map(([id, name, input]) => ({ type: "tool_call" as const, id, name, input })), usage });

  it("reports each call as it starts and ends, before the results reach the conversation", async () => {
    const { session, bus } = await setup([calls(["c1", "echo", { text: "a" }], ["c2", "boom", {}], ["c3", "shy", {}], ["c4", "nope", {}]), reply("ok")]);
    const seen = watch(bus);
    bus.on("message", (m) => m.parts[0]?.type === "tool_result" && seen.push("results"));
    await session.send("go");
    expect(seen).toEqual([
      'start c1 echo {"text":"a"}',
      "end c1 ok",
      "start c2 boom {}",
      "end c2 failed",
      "start c3 shy {}",
      "end c3 declined",
      "start c4 nope {}",
      "end c4 failed",
      "results",
    ]);
  });

  it("ends a call stopped while it runs as cancelled, and one skipped after the stop too", async () => {
    const abort = new AbortController();
    const slow = defineTool("slow", "Stops the turn while it runs", z.object({}), async () => {
      abort.abort();
      throw new Error("Cancelled");
    });
    const bus = new Bus();
    const seen = watch(bus);
    const lead = new FakeProvider("a", [calls(["c1", "slow", {}], ["c2", "slow", {}])]);
    const session = new Session({ lead, tools: [slow], system: "t", ctx: await tempContext(), bus });
    await session.send("go", abort.signal);
    expect(seen).toEqual(["start c1 slow {}", "end c1 cancelled", "start c2 slow {}", "end c2 cancelled"]);
  });

  it("ends a call declined because the turn was stopped at its question as cancelled", async () => {
    const abort = new AbortController();
    const asked = defineTool("asked", "Stopped at its question", z.object({}), async () => {
      abort.abort(); // Ctrl-C at the question declines and stops the turn
      throw new Declined("The user declined: asked");
    });
    const bus = new Bus();
    const seen = watch(bus);
    const session = new Session({ lead: new FakeProvider("a", [calls(["c1", "asked", {}])]), tools: [asked], system: "t", ctx: await tempContext(), bus });
    await session.send("go", abort.signal);
    expect(seen).toEqual(["start c1 asked {}", "end c1 cancelled"]);
  });

  it("reports nothing for the calls in a reply that was cut off, since none of them runs", async () => {
    const cut = { ...callTool("c1", "echo", { text: "x" }), cutOff: { kind: "max_tokens" as const, detail: "limit" } };
    const { session, bus } = await setup([cut]);
    const seen = watch(bus);
    await session.send("go");
    expect(seen).toEqual([]);
  });
});

describe("Session, for subagents", () => {
  const calls = (...c: [string, string, unknown][]) => ({ parts: c.map(([id, name, input]) => ({ type: "tool_call" as const, id, name, input })), usage });
  const note = (text: string) => ({ type: "text" as const, text, from: "tasks" as const });

  it("puts text waiting for the lead after the next request's tool results, each once", async () => {
    const box: string[] = [];
    const finish = defineTool("finish", "A background task finishes while this runs", z.object({}), async () => (box.push("t3 finished: found it"), "ok"));
    const lead = new FakeProvider("a", [callTool("c1", "finish", {}), callTool("c2", "echo", { text: "x" }), reply("done")]);
    const session = new Session({ lead, tools: [finish, echo], system: "t", ctx: await tempContext(), bus: new Bus(), inbox: () => box.splice(0) });
    await session.send("go");
    expect(session.messages[0]!.parts).toEqual([{ type: "text", text: "go" }]);
    expect(session.messages[2]!.parts).toEqual([{ type: "tool_result", callId: "c1", output: "ok", isError: false }, note("t3 finished: found it")]);
    expect(session.messages[4]!.parts).toEqual([{ type: "tool_result", callId: "c2", output: "x", isError: false }]);
    expect(lead.seen[1]!.at(-1)!.parts.at(-1)).toEqual(note("t3 finished: found it"));
  });

  it("puts text already waiting after the user's prompt, and starts a turn with only waiting text", async () => {
    const box = ["t3 was stopped by the user"];
    const lead = new FakeProvider("a", [reply("ok"), reply("read it")]);
    const session = new Session({ lead, tools: [], system: "t", ctx: await tempContext(), bus: new Bus(), inbox: () => box.splice(0) });
    await session.send("go");
    expect(session.messages[0]!.parts).toEqual([{ type: "text", text: "go" }, note("t3 was stopped by the user")]);
    box.push("t4 finished: x");
    await session.send("");
    expect(session.messages[2]!.parts).toEqual([note("t4 finished: x")]);
    await session.send(""); // nothing typed and nothing waiting: no request
    expect(lead.seen).toHaveLength(2);
  });

  it("starts a reply's calls of a side-by-side tool together, the others one after another, results in order", async () => {
    const started: string[] = [];
    let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    // Each waits for the other to start, so run one after another they would never finish.
    const together = {
      ...defineTool("together", "Runs beside its kind", z.object({ n: z.number() }), async ({ n }) => {
        started.push(`together ${n}`);
        if (started.filter((s) => s.startsWith("together")).length === 2) release();
        await both;
        return `t${n}`;
      }),
      parallel: true,
    };
    const lead = new FakeProvider("a", [calls(["c1", "together", { n: 1 }], ["c2", "echo", { text: "e" }], ["c3", "together", { n: 2 }]), reply("done")]);
    const session = new Session({ lead, tools: [together, echo], system: "t", ctx: await tempContext(), bus: new Bus() });
    await session.send("go");
    expect(session.messages[2]!.parts.map((p) => (p.type === "tool_result" ? p.output : ""))).toEqual(["t1", "e", "t2"]);
  });
});
