import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { privateDir } from "../../src/auth/private.js";
import { type Ask, Declined, PermissionGate } from "../../src/core/permissions.js";
import { type Conversation, Session } from "../../src/core/session.js";
import { Stats } from "../../src/core/stats.js";
import { type Line, type Read, readTranscript, Transcript } from "../../src/core/transcript.js";
import type { Message, Part, Provider, Turn } from "../../src/core/types.js";
import { MAX_TOOL_OUTPUT } from "../../src/exec/executor.js";
import { fitted, LIMITS } from "../../src/providers/pictures.js";
import { judgeOf } from "../../src/safety/judge.js";
import { writeFileTool } from "../../src/tools/files.js";
import { defineTool } from "../../src/tools/tool.js";
import { Pictures } from "../../src/tui/pictures.js";
import { Bus, FakeProvider, Held, callTool, collectErrors, removeTree, reply, tempContext, texts, usage } from "../helpers.js";

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

  // Release 8a plan, choice 27 (user, 2026-11-06: "Record each reply's lead"): the lead that answered, the fallback that
  // rescued a refusal, or the model the provider says served it; never sent to a provider.
  it("keeps on each reply the lead that answered it, and sends none to the provider", async () => {
    const { session, lead } = await setup([reply("one"), { ...reply("two"), servedBy: "anthropic:claude-opus-4-8" }]);
    await session.send("hi");
    expect(session.messages[1]).toEqual({ role: "assistant", parts: [{ type: "text", text: "one" }], lead: "fake:a" });
    await session.send("again");
    expect(session.messages[3]!.lead).toBe("anthropic:claude-opus-4-8");
    expect(lead.seen[1]![1]).toEqual({ role: "assistant", parts: [{ type: "text", text: "one" }] });
    expect(lead.seen[1]![1]).not.toHaveProperty("lead");
    const refused = { ...reply(""), cutOff: { kind: "refusal" as const, detail: "declined" } };
    const rescue = new FakeProvider("b", [reply("b")]);
    const rescued = new Session({ lead: new FakeProvider("a", [refused]), fallback: rescue, tools: [], system: "t", ctx: await tempContext(), bus: new Bus() });
    await rescued.send("go");
    expect(rescued.messages[1]!.lead).toBe("fake:b");
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

  // Release 6 plan, choice 10: the 400 question reads the status, never an error's words.
  it("keeps a provider error's HTTP status on the error event, only when it is a number", async () => {
    const refused = Object.assign(new Error("bad image"), { status: 400 });
    const { session, errors } = await setup([refused, Object.assign(new Error("odd"), { status: "400" }), new Error("offline")]);
    for (const text of ["one", "two", "three"]) await session.send(text);
    expect(errors.map((e) => [e.kind, e.message, e.status])).toEqual([
      ["provider", "bad image", 400],
      ["provider", "odd", undefined],
      ["provider", "offline", undefined],
    ]);
  });

  it("answers every tool call when a response is cut off", async () => {
    const cut = { ...callTool("c1", "echo", { text: "x" }), cutOff: { kind: "max_tokens" as const, detail: "limit" } };
    const { session, errors } = await setup([cut]);
    await session.send("go");
    expect(session.messages.at(-1)!.parts[0]).toMatchObject({ type: "tool_result", callId: "c1", isError: true });
    expect(errors).toEqual([expect.objectContaining({ kind: "max_tokens", message: "limit" })]);
  });

  // Release 8a plan, choice 21: "window" changes nothing yet; Task 12 shortens the history and sends it again.
  it("answers a reply cut off at the window as one that hit a limit", async () => {
    const cut = { ...callTool("c1", "echo", { text: "x" }), cutOff: { kind: "window" as const, detail: "The conversation filled the context window" } };
    const { session, errors } = await setup([cut]);
    await session.send("go");
    expect(session.messages.at(-1)!.parts[0]).toMatchObject({ type: "tool_result", callId: "c1", isError: true });
    expect(errors).toEqual([expect.objectContaining({ kind: "max_tokens", message: "The conversation filled the context window" })]);
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

// Release 6 plan, Task 18: a request with pictures refused as invalid (400) asks before sending again without them.
describe("Session, when a request with pictures is refused", () => {
  const PNG = { mediaType: "image/png" as const, data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }; // a stand-in, never read from disk
  const look: Part[] = [{ type: "text", text: "look " }, { type: "image", id: 1, ...PNG }, { type: "image", id: 2, ...PNG }];
  const failure = (status?: number) => Object.assign(new Error(`failed with ${status ?? "no status"}`), status === undefined ? {} : { status });

  // A provider that fits each request's pictures as the adapters do (providers/pictures.ts, fitted), keeping what each
  // request sent for each picture: "picture", or the note in its place.
  function picturing(name: string, turns: (Turn | Error)[]) {
    const sent: string[][] = [];
    const provider: Provider = {
      id: `fake:${name}`,
      complete: async (req) => {
        const prepared = await fitted(req, LIMITS.ollama, (p) => p);
        const images = req.messages.flatMap((m) => m.parts.filter((p) => p.type === "image"));
        sent.push(images.map((p) => (typeof prepared.get(p.id) === "string" ? (prepared.get(p.id) as string) : "picture")));
        const next = turns.shift();
        if (!next) throw new Error(`fake:${name} ran out of turns`);
        if (next instanceof Error) throw next;
        return next;
      },
    };
    return { provider, sent };
  }

  async function setupAsked(answers: boolean[], lead: Provider, more: { fallback?: Provider; inbox?: () => string[] } = {}) {
    const bus = new Bus();
    const errors = collectErrors(bus);
    const notes: string[] = [];
    bus.on("note", (n) => notes.push(n));
    const asked: unknown[][] = [];
    const shown: number[] = []; // how many errors had been emitted at each question
    const ask: Ask = async (...a) => {
      asked.push(a);
      shown.push(errors.length);
      return answers.shift() ?? false;
    };
    const session = new Session({ lead, ...more, tools: [], system: "t", ctx: await tempContext(), bus, ask });
    return { session, errors, notes, asked, shown };
  }

  it("asks, with no owner, after a 400 to a request carrying pictures, once the error is shown", async () => {
    const { provider } = picturing("a", [failure(400)]);
    const { session, errors, asked, shown } = await setupAsked([false], provider);
    await session.send(look);
    expect(errors.map((e) => [e.kind, e.message, e.status])).toEqual([["provider", "failed with 400", 400]]);
    expect(asked).toEqual([["Send again without the pictures", undefined, undefined, true]]);
    expect(shown).toEqual([1]);
  });

  it("on y sends the request again with every picture as a note, and leaves pictures out for that lead", async () => {
    const { provider, sent } = picturing("a", [failure(400), reply("seen")]);
    const { session, errors, notes } = await setupAsked([true], provider);
    await session.send(look);
    expect(sent).toEqual([
      ["picture", "picture"],
      ["[Image #1 left out: fake:a refused pictures]", "[Image #2 left out: fake:a refused pictures]"],
    ]);
    expect(notes).toEqual(["Pictures are left out for fake:a from now on."]);
    expect(errors).toHaveLength(1);
    // The conversation is never changed (release 6 design, "When the provider refuses"): the pictures stay in it.
    expect(session.messages).toEqual([
      { role: "user", parts: look },
      { role: "assistant", parts: [{ type: "text", text: "seen" }], lead: "fake:a" },
    ]);
  });

  it("sends notes in every later request to a marked lead, without asking or saying so again, and pictures to another lead", async () => {
    const { provider: a, sent: toA } = picturing("a", [failure(400), reply("one"), failure(400), reply("three")]);
    const { provider: b, sent: toB } = picturing("b", [reply("two")]);
    const { session, notes, asked, errors } = await setupAsked([true], a);
    await session.send(look);
    session.setLead(b);
    await session.send("again");
    session.setLead(a);
    await session.send("and again"); // refused as invalid once more, now with no picture in it: nothing is asked
    await session.send("last");
    const note = (n: number) => `[Image #${n} left out: fake:a refused pictures]`;
    expect(toA.slice(1)).toEqual([
      [note(1), note(2)],
      [note(1), note(2)],
      [note(1), note(2)],
    ]);
    expect(toB).toEqual([["picture", "picture"]]);
    expect(asked).toHaveLength(1);
    expect(notes).toEqual(["Pictures are left out for fake:a from now on."]);
    expect(errors.map((e) => e.status)).toEqual([400, 400]);
  });

  it("on n changes nothing and ends the turn as after any failure", async () => {
    const { provider, sent } = picturing("a", [failure(400), reply("later")]);
    const { session, errors, notes, asked } = await setupAsked([false], provider);
    await session.send(look);
    expect(sent).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(notes).toEqual([]);
    expect(session.messages).toEqual([{ role: "user", parts: look }]);
    await session.send("again"); // not marked: the pictures still go, and nothing is asked
    expect(sent[1]).toEqual(["picture", "picture"]);
    expect(asked).toHaveLength(1);
  });

  it("asks nothing after a 400 without pictures, a 429, a 500, a network error or a stop", async () => {
    const { provider, sent } = picturing("a", [failure(400), failure(429), failure(500), failure(), failure(400)]);
    const { session, errors, asked } = await setupAsked([true, true, true, true, true], provider);
    await session.send("no pictures");
    for (const text of ["two", "three", "four"]) await session.send([{ type: "text", text }, { type: "image", id: 1, ...PNG }]);
    const stop = new AbortController();
    stop.abort();
    await session.send(look, stop.signal);
    expect(sent).toHaveLength(5);
    expect(errors.map((e) => e.status)).toEqual([400, 429, 500, undefined]); // a stop is not a failure
    expect(asked).toEqual([]);
  });

  it("asks about the fallback when its request is the one refused, and leaves pictures out for the fallback alone", async () => {
    const refused = { ...reply(""), cutOff: { kind: "refusal" as const, detail: "declined" } };
    const { provider: a, sent: toA } = picturing("a", [refused, reply("two")]);
    const { provider: b, sent: toB } = picturing("b", [failure(400), reply("rescued")]);
    const { session, notes, asked } = await setupAsked([true], a, { fallback: b });
    await session.send(look);
    expect(asked).toHaveLength(1);
    expect(toB).toEqual([
      ["picture", "picture"],
      ["[Image #1 left out: fake:b refused pictures]", "[Image #2 left out: fake:b refused pictures]"],
    ]);
    expect(notes).toEqual(["Pictures are left out for fake:b from now on."]);
    expect(session.messages.at(-1)!.parts).toEqual([{ type: "text", text: "rescued" }]);
    await session.send("again");
    expect(toA).toEqual([
      ["picture", "picture"],
      ["picture", "picture"],
    ]);
  });

  it("leaves the subagents' waiting answers waiting, on y and on n", async () => {
    for (const answer of [true, false]) {
      const box: string[] = [];
      const lead: Provider = {
        id: "fake:a",
        complete: async () => {
          if (!box.length) {
            box.push("t3 finished: found it"); // arrives while the refused request runs
            throw failure(400);
          }
          return reply("seen");
        },
      };
      const { session } = await setupAsked([answer], lead, { inbox: () => box.splice(0) });
      await session.send(look);
      expect(box).toEqual(["t3 finished: found it"]);
      expect(session.messages[0]).toEqual({ role: "user", parts: look });
    }
  });
});

// Release 8a plan, Task 5: the session saves each message as it joins the history, and takes a saved or new conversation in
// place. The sessions folder is inside a fresh temporary folder and made private once, as tests/core/transcript.test.ts
// does, each case with its own session in it.
describe("Session, saved and loaded", { timeout: 15_000 }, () => {
  let top: string;
  let shared: string;
  let sessions = 0;
  beforeAll(async () => {
    top = await mkdtemp(path.join(tmpdir(), "tachi-session-"));
    shared = path.join(top, "sessions", "project");
    privateDir(shared);
  });
  afterAll(() => removeTree(top));
  function place() {
    const id = `s${++sessions}`;
    return { id, file: path.join(shared, `${id}.jsonl`), pictures: path.join(shared, id, "pictures") };
  }
  const start = (id: string): Omit<Extract<Line, { t: "start" }>, "at"> => ({
    t: "start",
    v: 1,
    id,
    project: "C:\\a project",
    lead: "fake:a",
    version: "0.8.0",
    print: false,
    system: "test",
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
  const conversation = (over: Partial<Conversation> = {}): Conversation => ({
    id: "c",
    messages: [],
    system: "t",
    prompts: [],
    calls: [],
    nextPicture: 1,
    nextTask: 1,
    ...over,
  });
  // A transcript read back, as a new process would load it.
  const loaded = (r: Read, transcript: Transcript): Conversation => ({
    id: r.start.id,
    messages: r.messages,
    system: r.system,
    transcript,
    prompts: r.prompts,
    calls: r.calls,
    nextPicture: r.nextPicture,
    nextTask: r.nextTask,
  });
  const said = (text: string): Message => ({ role: "assistant", parts: [{ type: "text", text }] });
  const typed = (text: string): Message => ({ role: "user", parts: [{ type: "text", text }] });

  it("writes the user's message, the reply and the result in order, each line on disk before its message event", async () => {
    const p = place();
    const bus = new Bus();
    const seen: [Line | undefined, Message][] = [];
    bus.on("message", (m) => seen.push([lines(p.file).at(-1), m]));
    const lead = new FakeProvider("a", [callTool("c1", "echo", { text: "ping" }), reply("done")]);
    const session = new Session({ lead, tools: [echo], system: "test", ctx: await tempContext(), bus, transcript: new Transcript(p.file, p.pictures) });
    await session.send("go");
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(seen).toEqual(session.messages.map((m) => [{ t: "message", at: expect.any(String), message: m }, m]));
    expect(lines(p.file).map((l) => (l.t === "message" ? l.message : l))).toEqual(session.messages);
  });

  it("writes nothing for a refused reply", async () => {
    const p = place();
    const refused = { ...reply(""), cutOff: { kind: "refusal" as const, detail: "declined" } };
    const transcript = new Transcript(p.file, p.pictures);
    const session = new Session({ lead: new FakeProvider("a", [refused]), tools: [], system: "t", ctx: await tempContext(), bus: new Bus(), transcript });
    await session.send("go");
    expect(lines(p.file)).toEqual([{ t: "message", at: expect.any(String), message: typed("go") }]);
  });

  it("writes a line for a new lead", async () => {
    const p = place();
    const transcript = new Transcript(p.file, p.pictures);
    const session = new Session({ lead: new FakeProvider("a", []), tools: [], system: "t", ctx: await tempContext(), bus: new Bus(), transcript });
    session.setLead(new FakeProvider("b", []));
    expect(lines(p.file)).toEqual([{ t: "lead", at: expect.any(String), lead: "fake:b" }]);
  });

  // A transcript that cannot be written: a file where the sessions folder should be, with no permission changed (plan,
  // Task 3). The write fails before any folder is made private.
  async function unwritable(id = "s1") {
    const own = await mkdtemp(path.join(tmpdir(), "tachi-session-"));
    onTestFinished(() => removeTree(own));
    mkdirSync(path.join(own, "data"));
    writeFileSync(path.join(own, "data", "sessions"), "not a folder");
    const dir = path.join(own, "data", "sessions", "project");
    return new Transcript(path.join(dir, `${id}.jsonl`), path.join(dir, id, "pictures"));
  }
  // The approved "Saving fails" line (plan, "Lines this plan adds").
  const savingFails = (t: Transcript) =>
    `Saving this session stopped: ${t.file} could not be written (${t.failed}). ` +
    "It cannot be resumed, and a conversation too long for the model will end with an error.";

  it("goes on with the turn when a write fails, saving stopped with its reason, said once in the approved words", async () => {
    const transcript = await unwritable();
    const bus = new Bus();
    const errors = collectErrors(bus);
    const events: Message[] = [];
    bus.on("message", (m) => events.push(m));
    const lead = new FakeProvider("a", [reply("still here"), reply("and here")]);
    const session = new Session({ lead, tools: [], system: "t", ctx: await tempContext(), bus, transcript });
    await session.send("go");
    expect(events).toEqual([typed("go"), { ...said("still here"), lead: "fake:a" }]);
    expect(session.messages).toEqual(events);
    expect(transcript.failed).toEqual(expect.stringMatching(/\S/));
    expect(errors).toEqual([{ kind: "saving", attempted: transcript.file, message: savingFails(transcript), lead: "fake:a" }]);
    // Later writes, which saving no longer makes, say nothing more.
    await session.send("again");
    session.setLead(new FakeProvider("b", []));
    expect(texts(session.messages.at(-1)!)).toEqual(["and here"]);
    expect(errors).toHaveLength(1);
  });

  it("says saving stopped once per transcript at a load, for a write made elsewhere, such as Tasks' subagent line", async () => {
    const bus = new Bus();
    const errors = collectErrors(bus);
    const session = new Session({ lead: new FakeProvider("a", []), tools: [], system: "t", ctx: await tempContext(), bus });
    const first = await unwritable("s1");
    first.write({ t: "name", name: "x" });
    session.load(conversation({ transcript: first }));
    session.load(conversation({ transcript: first })); // the same transcript again: said already
    const second = await unwritable("s2");
    second.write({ t: "name", name: "x" });
    session.load(conversation({ transcript: second }));
    expect(errors.map((e) => [e.kind, e.message])).toEqual([
      ["saving", savingFails(first)],
      ["saving", savingFails(second)],
    ]);
  });

  it("loads a conversation in place, so an alias of its history sees it, with its prompts, calls, id and transcript", async () => {
    const p = place();
    const pictures = new Pictures();
    const tasks: number[] = [];
    const lead = new FakeProvider("a", [reply("one"), reply("three")]);
    const session = new Session({ lead, tools: [], system: "t", ctx: await tempContext(), bus: new Bus(), pictures, tasks: { from: (n) => tasks.push(n) } });
    await session.send("first");
    const alias = session.messages; // as tasks.ts holds a subagent's
    const history = [typed("before"), said("two")];
    const calls = [{ name: "read_file", input: { path: "a.txt" } }];
    const transcript = new Transcript(p.file, p.pictures);
    session.load(conversation({ id: p.id, messages: history, transcript, prompts: ["before"], calls, nextPicture: 7, nextTask: 4 }));
    expect(alias).toBe(session.messages);
    expect(alias).toEqual(history);
    expect([session.id, session.prompts, session.calls]).toEqual([p.id, ["before"], calls]);
    expect([pictures.next(), tasks]).toEqual([7, [4]]);
    await session.send("again");
    expect(lead.seen[1]).toEqual([...history, typed("again")]);
    expect(lines(p.file).map((l) => l.t === "message" && texts(l.message as Message))).toEqual([["again"], ["three"]]);
    // A new conversation's records are empty.
    session.load(conversation());
    expect([session.messages, session.prompts, session.calls]).toEqual([[], [], []]);
  });

  it("refuses to load while a turn runs, leaving the turn's history as it is", async () => {
    const lead = new Held("fake:a");
    const session = new Session({ lead, tools: [], system: "t", ctx: await tempContext(), bus: new Bus() });
    const turn = session.send("hi");
    await new Promise((r) => setTimeout(r, 20));
    expect(() => session.load(conversation({ messages: [said("other")] }))).toThrow("A turn is already running");
    lead.answer("ok");
    await turn;
    expect(session.messages).toEqual([typed("hi"), { ...said("ok"), lead: "fake:a" }]);
  });

  it("sends the loaded conversation's system prompt in the next turn", async () => {
    const systems: string[] = [];
    const lead: Provider = { id: "fake:a", complete: async (req) => (systems.push(req.system), reply("ok")) };
    const session = new Session({ lead, tools: [], system: "the first", ctx: await tempContext(), bus: new Bus() });
    await session.send("hi");
    session.load(conversation({ system: "the saved one" }));
    await session.send("hi again");
    expect(systems).toEqual(["the first", "the saved one"]);
    expect(session.system).toBe("the saved one");
  });

  it("sends the loaded conversation's own picture 1, not the last conversation's", async () => {
    // Stand-ins sharp cannot read, so each goes as it is (providers/pictures.ts, shrink), and the copy kept is its bytes.
    const a = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]);
    const b = Buffer.from([0x89, 0x50, 0x4e, 0x47, 2]);
    const sent: (Buffer | string)[] = [];
    const lead: Provider = {
      id: "fake:a",
      complete: async (req) => {
        const one = (await fitted(req, LIMITS.ollama, (p) => p)).get(1)!;
        sent.push(typeof one === "string" ? one : one.data);
        return reply("seen");
      },
    };
    const session = new Session({ lead, tools: [], system: "t", ctx: await tempContext(), bus: new Bus() });
    await session.send([{ type: "text", text: "look " }, { type: "image", id: 1, mediaType: "image/png", data: a }]);
    const other: Message = { role: "user", parts: [{ type: "text", text: "see " }, { type: "image", id: 1, mediaType: "image/png", data: b }] };
    session.load(conversation({ messages: [other, said("seen")] }));
    await session.send("again");
    expect(sent).toEqual([a, b]);
  });

  it("gives auto mode's judge the prompts and calls from before a shortening once read back and loaded, never the summary", async () => {
    const p = place();
    const saved = new Transcript(p.file, p.pictures);
    saved.write(start(p.id));
    const first = new Session({
      lead: new FakeProvider("a", [callTool("c1", "echo", { text: "ping" }), reply("pinged"), reply("ok")]),
      tools: [echo],
      system: "test",
      ctx: await tempContext(),
      bus: new Bus(),
      transcript: saved,
    });
    await first.send("ping it");
    await first.send("thanks");
    // The line a shortening writes (plan, choice 4), its summary standing in for the history.
    const summary = typed("This conversation was shortened. A summary of everything before this point:\n\nThe user had ping echoed.");
    saved.write({ t: "shortened", system: "test, rebuilt", message: summary });

    // A new window, in auto mode, as cli.tsx makes its judge.
    const bus = new Bus();
    const judge = new FakeProvider("judge", [reply(JSON.stringify({ allow: false, reason: "It was not asked for." }))]);
    const ctx = await tempContext();
    let session: Session | undefined;
    const gate = new PermissionGate("auto", async () => false, undefined, { root: ctx.root, headless: false, judge: judgeOf(judge, () => session!, "", bus) });
    const lead = new FakeProvider("a", [callTool("c2", "write_file", { path: path.join(top, "elsewhere", "a.txt"), content: "x" }), reply("done")]);
    session = new Session({ lead, tools: [writeFileTool], system: "t", ctx: { ...ctx, gate }, bus });
    session.load(loaded(read(p), new Transcript(p.file, p.pictures)));
    await session.send("write it");
    expect(lead.seen[0]).toEqual([summary, typed("write it")]);
    const asked = texts(judge.seen[0]![0]!)[0]!.split("\n"); // the prompts' block, then the calls' (judge.ts, request)
    expect(JSON.parse(asked[1]!)).toEqual(["ping it", "thanks", "write it"]);
    expect(JSON.parse(asked[4]!).map((c: { name: string }) => c.name)).toEqual(["echo", "write_file"]);
    expect(JSON.parse(asked[4]!)[0]).toEqual({ name: "echo", input: { text: "ping" } });
  });
});
