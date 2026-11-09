import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { privateDir } from "../../src/auth/private.js";
import type { Events } from "../../src/core/bus.js";
import { callText } from "../../src/core/exportText.js";
import { characters } from "../../src/core/fit.js";
import { type Ask, Declined, type Judge, PermissionGate } from "../../src/core/permissions.js";
import { type Conversation, Session, UNSAVED } from "../../src/core/session.js";
import { CANCELLED, INSTRUCTIONS } from "../../src/core/shorten.js";
import { Stats } from "../../src/core/stats.js";
import { Tasks } from "../../src/core/tasks.js";
import { type Line, pathsOf, type Read, readTranscript, Transcript } from "../../src/core/transcript.js";
import { type CompletionRequest, type Message, type Part, type Provider, sentAll, type Turn } from "../../src/core/types.js";
import { MAX_TOOL_OUTPUT } from "../../src/exec/executor.js";
import { LocalExecutor, LocalWorkspace } from "../../src/exec/local.js";
import type { Event, Hook } from "../../src/hooks/config.js";
import { Hooks, type Where } from "../../src/hooks/hooks.js";
import { fitted, LIMITS } from "../../src/providers/pictures.js";
import { judgeOf } from "../../src/safety/judge.js";
import { delegateTool } from "../../src/tools/delegate.js";
import { editFileTool, readFileTool, writeFileTool } from "../../src/tools/files.js";
import { shellText } from "../../src/tools/shell.js";
import { defineTool, type Tool } from "../../src/tools/tool.js";
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

  // Release 8a plan, choice 21: a session that cannot shorten, here one saving nothing, never stores the reply, and reports
  // it as one that hit a limit, its size and window not known.
  it("never stores a reply cut off at the window, reporting it as one that hit a limit when it cannot be shortened", async () => {
    const cut = { ...callTool("c1", "echo", { text: "x" }), cutOff: { kind: "window" as const, detail: "The conversation filled the context window" } };
    const { session, errors } = await setup([cut]);
    await session.send("go");
    expect(session.messages).toEqual([{ role: "user", parts: [{ type: "text", text: "go" }] }]);
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
    // The prompt joins the shortening's message, so user and assistant messages alternate (Task 12).
    expect(lead.seen[0]).toEqual([{ role: "user", parts: [...summary.parts, ...typed("write it").parts] }]);
    const asked = texts(judge.seen[0]![0]!)[0]!.split("\n"); // the prompts' block, then the calls' (judge.ts, request)
    expect(JSON.parse(asked[1]!)).toEqual(["ping it", "thanks", "write it"]);
    expect(JSON.parse(asked[4]!).map((c: { name: string }) => c.name)).toEqual(["echo", "write_file"]);
    expect(JSON.parse(asked[4]!)[0]).toEqual({ name: "echo", input: { text: "ping" } });
  });
});

// Release 8a plan, Task 12: the session shortens a conversation that will not fit, before the request or after a "too
// long" answer (design, "When to shorten" and "How shortening works").
describe("Session, shortening", { timeout: 15_000 }, () => {
  let top: string;
  let n = 0;
  beforeAll(async () => {
    top = await mkdtemp(path.join(tmpdir(), "tachi-shorten-"));
  });
  afterAll(() => removeTree(top));
  // Two levels inside the test's temp folder; `inherits`, as a subagent's file is made, so no PowerShell starts.
  const saving = () => {
    const dir = path.join(top, "sessions", "project");
    const id = `s${++n}`;
    return new Transcript(path.join(dir, `${id}.jsonl`), path.join(dir, id, "pictures"), { inherits: true });
  };
  const savedLines = (t: Transcript) =>
    readFileSync(t.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Line);

  class TooLong extends Error {
    status = 400;
  }
  type Script = Turn | Error | ((req: CompletionRequest) => Turn | Promise<Turn>);
  // A scripted lead with a window, which calls a TooLong error too long, and records each request as it was sent.
  class Lead implements Provider {
    readonly seen: Omit<CompletionRequest, "signal" | "shrunk" | "leftOut">[] = [];
    readonly shrunk: unknown[] = [];
    constructor(
      readonly id: string,
      private readonly turns: Script[],
      private readonly window: number | null = null,
    ) {}
    async complete(req: CompletionRequest): Promise<Turn> {
      const { signal: _, shrunk, leftOut: __, ...rest } = req;
      this.seen.push(structuredClone(rest));
      this.shrunk.push(shrunk);
      const next = this.turns.shift();
      if (!next) throw new Error(`${this.id} ran out of turns`);
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next(req) : next;
    }
    tooLong(err: unknown): boolean {
      return err instanceof TooLong;
    }
    async contextWindow(): Promise<number | null> {
      return this.window;
    }
  }
  // A reply whose usage reports one token a character of the request it answers, so the session's ratio is 1.
  const measured =
    (text: string, more: Partial<Turn> = {}) =>
    (req: CompletionRequest): Turn => ({
      ...reply(text),
      ...more,
      usage: { input: characters(req.system, req.messages, req.tools), output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  const summaryOf = (text: string) => reply(text);
  const isSummary = (req: { messages: Message[] }) => texts(req.messages.at(-1)!).at(-1) === INSTRUCTIONS;
  const typed = (text: string): Message => ({ role: "user", parts: [{ type: "text", text }] });
  const shortened = (summary: string, request: string) =>
    `This conversation was shortened. A summary of everything before this point:\n\n${summary}\n\nThe request being worked on, word for word:\n${request}`;
  const big = "x".repeat(600);
  const cutAtWindow = { ...reply("half a repl"), cutOff: { kind: "window" as const, detail: "The conversation filled the context window" } };

  async function setup(lead: Provider, more: Partial<ConstructorParameters<typeof Session>[0]> = {}) {
    const bus = new Bus();
    const errors = collectErrors(bus);
    const summaries: string[] = [];
    bus.on("shortened", (s) => summaries.push(s));
    const usages: Events["usage"][0][] = [];
    bus.on("usage", (u) => usages.push(u));
    const transcript = saving();
    const ctx = await tempContext();
    const session = new Session({ lead, tools: [echo], system: "t", systemNow: async () => "t, read again", ctx, bus, transcript, ...more });
    return { session, bus, errors, summaries, usages, transcript };
  }
  // A transcript that cannot be written: a file where its folder should be, with no permission changed (Task 3).
  async function unsavable() {
    const own = await mkdtemp(path.join(tmpdir(), "tachi-session-"));
    onTestFinished(() => removeTree(own));
    mkdirSync(path.join(own, "data"));
    writeFileSync(path.join(own, "data", "sessions"), "not a folder");
    const dir = path.join(own, "data", "sessions", "project");
    return new Transcript(path.join(dir, "s.jsonl"), path.join(dir, "s", "pictures"));
  }
  // A lead that counts requests exactly, each count from `counts` in turn: a number, or "stop", which stops the turn
  // there, as Ctrl-C would, and rejects as the SDK does.
  function counting(lead: Lead, stop: AbortController, counts: (number | "stop")[]) {
    return Object.assign(lead, {
      countTokens: async () => {
        const next = counts.shift();
        if (next !== "stop") return next ?? 0;
        stop.abort();
        throw new Error("Request was aborted.");
      },
    });
  }
  // The approved line for a request still too long (plan, "Lines this plan adds"), at the ratio of 1.
  const tooLongLine = (session: Session, lead: string, window: number) =>
    `The request is too long for ${lead}: about ${characters(session.system, sentAll(session.messages), [echo.spec]).toLocaleString("en-US")} tokens, ` +
    `against a window of ${window.toLocaleString("en-US")}.`;

  it("shortens before a request its estimate puts over the window, the request holding the new history and the prompt", async () => {
    const lead = new Lead("fake:a", [measured("noted"), summaryOf("The user sent many x."), reply("done")], 700);
    const { session, errors, summaries, usages, transcript } = await setup(lead);
    await session.send(big);
    await session.send("now this");
    expect(lead.seen).toHaveLength(3);
    // The summary request: the whole history before the prompt, the instructions last, with the conversation's system prompt.
    expect(isSummary(lead.seen[1]!)).toBe(true);
    expect(lead.seen[1]!.system).toBe("t");
    expect(lead.seen[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const history: Message = typed(shortened("The user sent many x.", "now this"));
    expect(lead.seen[2]!.messages).toEqual([history]);
    expect(lead.seen[2]!.system).toBe("t, read again");
    expect(session.messages).toEqual([history, { role: "assistant", parts: [{ type: "text", text: "done" }], lead: "fake:a" }]);
    expect(session.system).toBe("t, read again");
    expect(summaries).toEqual(["The user sent many x."]);
    expect(errors).toEqual([]);
    // One line, the new system prompt and the new history together (choice 4), before the reply's.
    const saved = savedLines(transcript).map((l) => l.t);
    expect(saved).toEqual(["message", "message", "message", "shortened", "message"]);
    expect(savedLines(transcript)[3]).toEqual({ t: "shortened", at: expect.any(String), system: "t, read again", message: history });
    // The summary's usage is marked so (stats.ts leaves the context alone for it).
    expect(usages.map((u) => u.summary ?? false)).toEqual([false, true, false]);
  });

  it("shortens and sends once more after a reply cut off at the window, never storing that reply", async () => {
    const lead = new Lead("fake:a", [measured("noted"), cutAtWindow, summaryOf("Many x."), reply("whole")], 1_000_000);
    const { session, errors, summaries } = await setup(lead);
    await session.send(big);
    await session.send("now this");
    expect(lead.seen).toHaveLength(4);
    expect(isSummary(lead.seen[2]!)).toBe(true);
    expect(lead.seen[3]!.messages).toEqual([typed(shortened("Many x.", "now this"))]);
    expect(JSON.stringify(session.messages)).not.toContain("half a repl");
    expect(texts(session.messages.at(-1)!)).toEqual(["whole"]);
    expect([summaries, errors]).toEqual([["Many x."], []]);
  });

  it("shortens after a too-long 400 with pictures in the history, without asking about the pictures", async () => {
    const asked: unknown[] = [];
    const lead = new Lead("fake:a", [measured("seen"), new TooLong("prompt is too long"), summaryOf("A picture was shown."), reply("ok")], 1_000_000);
    const { session, errors, summaries } = await setup(lead, { ask: async (...a) => (asked.push(a), true) });
    await session.send([{ type: "text", text: "look " }, { type: "image", id: 1, mediaType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }]);
    await session.send("and now");
    expect(asked).toEqual([]);
    expect(errors).toEqual([]);
    expect(summaries).toEqual(["A picture was shown."]);
    expect(lead.seen[3]!.messages).toEqual([typed(shortened("A picture was shown.", "and now"))]);
    // The summary request carries the session's shrunk pictures, as the conversation's requests do (Task 11's reviews).
    expect(lead.shrunk[2]).toBe(lead.shrunk[0]);
    expect(lead.shrunk[2]).toBeInstanceOf(Map);
  });

  it("sends a summary without the pictures to a lead the user said to send none to", async () => {
    const PNG = { type: "image" as const, id: 1, mediaType: "image/png" as const, data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) };
    const refused = Object.assign(new Error("bad image"), { status: 400 });
    const lead = new Lead("fake:a", [refused, measured("seen"), new TooLong("prompt is too long"), summaryOf("A picture."), reply("ok")], 1_000_000);
    const { session } = await setup(lead, { ask: async () => true });
    await session.send([{ type: "text", text: "look " }, PNG]);
    await session.send("and now");
    expect(lead.seen.map((r) => r.refusedBy)).toEqual([undefined, "fake:a", "fake:a", "fake:a", "fake:a"]);
    expect(isSummary(lead.seen[3]!)).toBe(true);
  });

  it("ends the turn with the line when the request is still too long once shortened", async () => {
    const lead = new Lead("fake:a", [measured("noted"), new TooLong("prompt is too long"), summaryOf("Many x."), new TooLong("prompt is too long")], 1_000_000);
    const { session, errors, summaries } = await setup(lead);
    await session.send(big);
    await session.send("now this");
    expect(lead.seen).toHaveLength(4);
    expect(summaries).toEqual(["Many x."]);
    expect(session.messages).toEqual([typed(shortened("Many x.", "now this"))]);
    expect(errors).toEqual([{ kind: "shortening", attempted: "request to fake:a", message: tooLongLine(session, "fake:a", 1_000_000), lead: "fake:a" }]);
  });

  it("ends the turn with the provider's own error when the request's size or window is not known", async () => {
    const lead = new Lead("fake:a", [reply("noted"), new TooLong("prompt is too long"), summaryOf("Many x."), new TooLong("prompt is too long: 9 > 8")]);
    const { session, errors } = await setup(lead);
    await session.send(big);
    await session.send("now this");
    expect(errors).toEqual([{ kind: "provider", attempted: "request to fake:a", message: "prompt is too long: 9 > 8", lead: "fake:a", status: 400 }]);
  });

  it("refuses to shorten when saving has stopped, ending the turn with the line and the history unchanged", async () => {
    const lead = new Lead("fake:a", [measured("noted"), new TooLong("prompt is too long")], 1_000_000);
    const own = await mkdtemp(path.join(tmpdir(), "tachi-session-"));
    onTestFinished(() => removeTree(own));
    mkdirSync(path.join(own, "data"));
    writeFileSync(path.join(own, "data", "sessions"), "not a folder"); // a file where the folder should be (Task 3)
    const transcript = new Transcript(path.join(own, "data", "sessions", "project", "s.jsonl"), path.join(own, "data", "sessions", "project", "s", "pictures"));
    const { session, errors, summaries } = await setup(lead, { transcript });
    await session.send(big);
    await session.send("now this");
    expect(lead.seen).toHaveLength(2); // no summary request
    expect(summaries).toEqual([]);
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(errors.map((e) => e.kind)).toEqual(["saving", "shortening"]);
    expect(errors[1]!.message).toBe(tooLongLine(session, "fake:a", 1_000_000));
  });

  it("changes nothing when saving first fails at the shortened line, and ends the turn with the line", async () => {
    // A transcript whose write of the `shortened` line fails, as `write` records a failure: without throwing.
    class FailsThere extends Transcript {
      #broken: string | null = null;
      override get failed(): string | null {
        return this.#broken ?? super.failed;
      }
      override write(line: Parameters<Transcript["write"]>[0]): void {
        if (line.t === "shortened") this.#broken = "the disk is full";
        else super.write(line);
      }
    }
    const t = saving();
    const transcript = new FailsThere(t.file, t.pictures, { inherits: true });
    const lead = new Lead("fake:a", [measured("noted"), new TooLong("prompt is too long"), summaryOf("Many x.")], 1_000_000);
    const { session, errors, summaries } = await setup(lead, { transcript });
    await session.send(big);
    await session.send("now this");
    const before = [typed(big), { role: "assistant", parts: [{ type: "text", text: "noted" }], lead: "fake:a" }, typed("now this")];
    expect(session.messages).toEqual(before);
    expect(session.system).toBe("t");
    expect(summaries).toEqual([]);
    expect(errors.map((e) => [e.kind, e.message])).toEqual([
      [
        "saving",
        `Saving this session stopped: ${t.file} could not be written (the disk is full). ` +
          "It cannot be resumed, and a conversation too long for the model will end with an error.",
      ],
      ["shortening", tooLongLine(session, "fake:a", 1_000_000)],
    ]);
  });

  it("says why a summary failed, in the approved line, and leaves the conversation as it was", async () => {
    const refusal = { ...reply(""), cutOff: { kind: "refusal" as const, detail: "I can't summarise that." } };
    const lead = new Lead("fake:a", [measured("noted"), new TooLong("prompt is too long"), refusal], 1_000_000);
    const { session, errors } = await setup(lead);
    await session.send(big);
    await session.send("now this");
    expect(session.messages).toHaveLength(3);
    expect(errors).toEqual([
      {
        kind: "shortening",
        attempted: "request to fake:a",
        message: "The conversation could not be shortened (I can't summarise that.); it is unchanged.",
        lead: "fake:a",
      },
    ]);
  });

  it("keeps the turn's own request through a second shortening in the same turn, never the first one's message", async () => {
    const lead = new Lead(
      "fake:a",
      [
        measured("noted"),
        callTool("c1", "echo", { text: "one" }),
        new TooLong("prompt is too long"),
        summaryOf("First summary."),
        callTool("c2", "echo", { text: "two" }),
        new TooLong("prompt is too long"),
        summaryOf("Second summary."),
        reply("done"),
      ],
      1_000_000,
    );
    const { session, summaries, errors } = await setup(lead);
    await session.send(big);
    await session.send("do it");
    expect([summaries, errors]).toEqual([["First summary.", "Second summary."], []]);
    const last = texts(lead.seen[7]!.messages[0]!).join("");
    const round = callText({ type: "tool_call", id: "c2", name: "echo", input: { text: "two" } }, "two");
    expect(last).toBe(`${shortened("Second summary.", "do it")}\n\nThe latest round of tool calls, and their results:\n${round}`);
    // The second summary was given the first shortening's message to summarise.
    expect(texts(lead.seen[6]!.messages[0]!).join("")).toContain("First summary.");
  });

  it("joins the prompt after a shortening between turns to the new history's message", async () => {
    const a = new Lead("fake:a", [measured("noted"), summaryOf("Many x.")], 10_000);
    const b = new Lead("fake:b", [reply("hello")], 500);
    const { session, summaries } = await setup(a);
    await session.send(big);
    expect(await session.makeRoom(b)).toBeUndefined();
    session.setLead(b);
    await session.send("next");
    const history = "This conversation was shortened. A summary of everything before this point:\n\nMany x.";
    expect(summaries).toEqual(["Many x."]);
    expect(b.seen[0]!.messages).toEqual([{ role: "user", parts: [{ type: "text", text: history }, { type: "text", text: "next" }] }]);
  });

  it("shortens on a switch to a smaller window with the lead leading now, and keeps the conversation when that fails", async () => {
    const refusal = { ...reply(""), cutOff: { kind: "refusal" as const, detail: "declined" } };
    const a = new Lead("fake:a", [measured("noted"), refusal], 10_000);
    const { session, summaries } = await setup(a);
    await session.send(big);
    expect(await session.makeRoom(new Lead("fake:b", [], 500))).toBe("declined");
    expect([session.messages.length, summaries]).toEqual([2, []]);
    // A window as large, or one not known, needs no check.
    expect(await session.makeRoom(new Lead("fake:c", [], 10_000))).toBeUndefined();
    expect(await session.makeRoom(new Lead("fake:d", []))).toBeUndefined();
    expect(a.seen).toHaveLength(2);
  });

  it("refuses a switch that needs shortening when saving has stopped", async () => {
    const a = new Lead("fake:a", [measured("noted")], 10_000);
    const { session } = await setup(a, { transcript: await unsavable() });
    await session.send(big);
    expect(await session.makeRoom(new Lead("fake:b", [], 500))).toBe(UNSAVED);
    expect(a.seen).toHaveLength(1); // no summary request
  });

  it("refuses a switch while a turn runs, as it would shorten the history under it", async () => {
    const lead = new Held("fake:a");
    const { session } = await setup(lead);
    const turn = session.send("hi");
    await new Promise((r) => setTimeout(r, 20));
    await expect(session.makeRoom(new Lead("fake:b", [], 500))).rejects.toThrow("A turn is already running");
    lead.answer("ok");
    await turn;
  });

  it("shortens a subagent's conversation the same way", async () => {
    const turns = [measured("noted"), callTool("c1", "echo", { text: "one" }), new TooLong("prompt is too long"), summaryOf("Sub summary."), reply("done")];
    const lead = new Lead("fake:w", turns, 1_000_000);
    const { session, summaries } = await setup(lead, { subagent: true, id: "t1" });
    await session.send(big);
    await session.send("brief");
    expect(summaries).toEqual(["Sub summary."]);
    expect(texts(session.messages.at(-1)!)).toEqual(["done"]);
  });

  it("keeps the judge's prompts and calls whole through a shortening", async () => {
    const turns = [callTool("c1", "echo", { text: "one" }), measured("noted"), new TooLong("prompt is too long"), summaryOf("S."), reply("ok")];
    const lead = new Lead("fake:a", turns, 1_000_000);
    const { session, summaries } = await setup(lead);
    await session.send(big);
    await session.send("then this");
    expect(summaries).toEqual(["S."]);
    expect(session.prompts).toEqual([big, "then this"]);
    expect(session.calls).toEqual([{ name: "echo", input: { text: "one" } }]);
  });

  it("learns the ratio under the model that answered, so a lead with none has no advance check", async () => {
    const lead = new Lead("fake:a", [measured("noted", { servedBy: "fake:other" }), reply("sent as it is")], 700);
    const { session, summaries } = await setup(lead);
    await session.send(big);
    await session.send("now this");
    expect([lead.seen.length, summaries]).toEqual([2, []]);
  });

  it("starts the ratios afresh on a load, so a loaded conversation has no estimate yet", async () => {
    const lead = new Lead("fake:a", [measured("noted"), reply("sent as it is")], 700);
    const { session, summaries } = await setup(lead);
    await session.send(big);
    session.load({ id: "c", messages: [...session.messages], system: "t", transcript: saving(), prompts: [], calls: [], nextPicture: 1, nextTask: 1 });
    await session.send("now this");
    expect([lead.seen.length, summaries]).toEqual([2, []]);
  });

  it("has no advance check with no window known and no /autocompact size, and checks against the size when set", async () => {
    const lead = new Lead("fake:a", [measured("noted"), measured("sent as it is"), summaryOf("S."), reply("after")]);
    const { session, summaries } = await setup(lead);
    await session.send(big);
    await session.send("now this");
    expect([lead.seen.length, summaries]).toEqual([2, []]);
    session.autoCompact = 700;
    await session.send("and this");
    expect(summaries).toEqual(["S."]);
    expect(isSummary(lead.seen[2]!)).toBe(true);
  });

  // Task 12's review: a second reply that filled the window is no "too long" answer; the line would give a size within it.
  it("ends the turn with the reply's own words when it fills the window again once shortened", async () => {
    const lead = new Lead("fake:a", [measured("noted"), cutAtWindow, summaryOf("Many x."), cutAtWindow], 1_000_000);
    const { session, errors, summaries } = await setup(lead);
    await session.send(big);
    await session.send("now this");
    expect(summaries).toEqual(["Many x."]);
    expect(session.messages).toEqual([typed(shortened("Many x.", "now this"))]);
    expect(errors).toEqual([{ kind: "max_tokens", attempted: "response from fake:a", message: "The conversation filled the context window", lead: "fake:a" }]);
  });

  it("ends the turn with the line when a request shortened in advance is still too long, without shortening again", async () => {
    const lead = new Lead("fake:a", [measured("noted"), summaryOf("Many x."), new TooLong("prompt is too long")], 700);
    const { session, errors, summaries } = await setup(lead);
    await session.send(big);
    await session.send("now this");
    expect([lead.seen.length, summaries]).toEqual([3, ["Many x."]]);
    expect(errors).toEqual([{ kind: "shortening", attempted: "request to fake:a", message: tooLongLine(session, "fake:a", 700), lead: "fake:a" }]);
  });

  // Decision 3 of the build: the /autocompact size is not the model's limit, so the model's own answer decides.
  it("sends a request past the /autocompact size but within the window as it is when saving has stopped", async () => {
    const lead = new Lead("fake:a", [measured("noted"), reply("sent as it is")], 1_000_000);
    const { session, errors, summaries } = await setup(lead, { transcript: await unsavable() });
    session.autoCompact = 700;
    await session.send(big);
    await session.send("now this");
    expect([lead.seen.length, summaries]).toEqual([2, []]);
    expect(texts(session.messages.at(-1)!)).toEqual(["sent as it is"]);
    expect(errors.map((e) => e.kind)).toEqual(["saving"]);
  });

  // Task 13 (user, 2026-11-06: "Show the line, send anyway", then "Retry next turn"): the line's event is marked as sent,
  // so -p's run does not fail for it (cli.tsx); the rest of the turn sends without another summary, and the next turn
  // tries once again.
  it("sends a request past the /autocompact size but within the window as it is when its summary fails, trying again next turn", async () => {
    const refusal = { ...reply(""), cutOff: { kind: "refusal" as const, detail: "declined" } };
    const call = measured("", { parts: callTool("c1", "echo", { text: "one" }).parts });
    const lead = new Lead("fake:a", [measured("noted"), refusal, call, measured("rest of the turn"), summaryOf("S."), reply("after")], 1_000_000);
    const { session, errors, summaries } = await setup(lead);
    session.autoCompact = 700;
    await session.send(big);
    await session.send("now this");
    expect(lead.seen.map(isSummary)).toEqual([false, true, false, false]);
    expect(texts(lead.seen[2]!.messages.at(-1)!)).toEqual(["now this"]);
    expect(texts(session.messages.at(-1)!)).toEqual(["rest of the turn"]);
    const line = "The conversation could not be shortened (declined); it is unchanged.";
    expect(errors).toEqual([{ kind: "shortening", attempted: "request to fake:a", message: line, lead: "fake:a", sent: true }]);
    await session.send("and this");
    expect(lead.seen.map(isSummary)).toEqual([false, true, false, false, true, false]);
    expect([summaries, texts(session.messages.at(-1)!)]).toEqual([["S."], ["after"]]);
  });

  // Task 13's quality review: the wait for the next turn is the /autocompact size's alone, never the window's.
  it("still shortens for the window after a failed /autocompact summary, when the request sent anyway is too long", async () => {
    const refusal = { ...reply(""), cutOff: { kind: "refusal" as const, detail: "declined" } };
    const lead = new Lead("fake:a", [measured("noted"), refusal, new TooLong("prompt is too long"), summaryOf("S."), reply("after")], 1_000_000);
    const { session, errors, summaries } = await setup(lead);
    session.autoCompact = 700;
    await session.send(big);
    await session.send("now this");
    expect(lead.seen.map(isSummary)).toEqual([false, true, false, true, false]);
    expect(lead.seen[4]!.messages).toEqual([typed(shortened("S.", "now this"))]);
    expect([summaries, texts(session.messages.at(-1)!)]).toEqual([["S."], ["after"]]);
    expect(errors.map((e) => [e.message, e.sent])).toEqual([["The conversation could not be shortened (declined); it is unchanged.", true]]);
  });

  it("ends the turn with the line when a summary for the /autocompact size fails and the request does not fit the window either", async () => {
    const refusal = { ...reply(""), cutOff: { kind: "refusal" as const, detail: "declined" } };
    const lead = new Lead("fake:a", [measured("noted"), refusal], 700);
    const { session, errors } = await setup(lead);
    session.autoCompact = 600;
    await session.send(big);
    await session.send("now this");
    expect(lead.seen).toHaveLength(2);
    // Not marked as sent: the turn ends with it, so -p's run fails (cli.tsx).
    expect(errors).toEqual([
      { kind: "shortening", attempted: "request to fake:a", message: "The conversation could not be shortened (declined); it is unchanged.", lead: "fake:a" },
    ]);
  });

  // Task 13: /compact.
  it("shortens the whole conversation on /compact, with its words as the focus", async () => {
    const lead = new Lead("fake:a", [measured("noted"), summaryOf("Compacted."), reply("next")], 1_000_000);
    const { session, errors, summaries } = await setup(lead);
    await session.send(big);
    expect(await session.compact("focus on tests")).toBeUndefined();
    expect(texts(lead.seen[1]!.messages.at(-1)!).at(-1)).toBe(`${INSTRUCTIONS}\n\nFocus on: focus on tests`);
    expect(lead.seen[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(session.messages).toEqual([typed("This conversation was shortened. A summary of everything before this point:\n\nCompacted.")]);
    expect([summaries, errors]).toEqual([["Compacted."], []]);
  });

  it("says a failed /compact in the line, the conversation unchanged; a stop is the caller's to say", async () => {
    const refusal = { ...reply(""), cutOff: { kind: "refusal" as const, detail: "declined" } };
    const stop = new AbortController();
    const stopped = () => {
      stop.abort();
      throw new Error("Request was aborted.");
    };
    const lead = new Lead("fake:a", [measured("noted"), refusal, stopped], 1_000_000);
    const { session, errors, summaries } = await setup(lead);
    await session.send(big);
    expect(await session.compact("")).toBe("declined");
    expect(texts(lead.seen[1]!.messages.at(-1)!).at(-1)).toBe(INSTRUCTIONS);
    expect(await session.compact("", stop.signal)).toBe(CANCELLED);
    expect(session.messages).toHaveLength(2);
    expect(summaries).toEqual([]);
    expect(errors).toEqual([
      { kind: "shortening", attempted: "request to fake:a", message: "The conversation could not be shortened (declined); it is unchanged.", lead: "fake:a" },
    ]);
  });

  // PR #10's review: a stop while the instruction files are read again, after the summary came, saves and changes nothing.
  it("changes nothing when /compact is stopped while the instruction files are read again", async () => {
    const stop = new AbortController();
    const lead = new Lead("fake:a", [measured("noted"), summaryOf("Compacted.")], 1_000_000);
    const systemNow = async () => {
      stop.abort();
      return "t, read again";
    };
    const { session, summaries, transcript } = await setup(lead, { systemNow });
    await session.send(big);
    expect(await session.compact("", stop.signal)).toBe(CANCELLED);
    expect([session.messages.length, session.system, summaries]).toEqual([2, "t", []]);
    expect(savedLines(transcript).some((l) => l.t === "shortened")).toBe(false);
  });

  it("refuses /compact when saving has stopped, saying why in the line", async () => {
    const lead = new Lead("fake:a", [measured("noted")], 1_000_000);
    const { session, errors } = await setup(lead, { transcript: await unsavable() });
    await session.send(big);
    expect(await session.compact("")).toBe(UNSAVED);
    expect(lead.seen).toHaveLength(1);
    expect(errors.map((e) => e.message).at(-1)).toBe("The conversation could not be shortened (saving this session stopped); it is unchanged.");
  });

  // Task 12's review: a stop ends the turn as any stop does, saying nothing (session.ts, #execute).
  it("ends the turn quietly when it is stopped during a shortening, the conversation unchanged", async () => {
    const stop = new AbortController();
    const stopped = () => {
      stop.abort();
      throw new Error("Request was aborted.");
    };
    const lead = new Lead("fake:a", [measured("noted"), new TooLong("prompt is too long"), stopped], 1_000_000);
    const { session, errors, summaries } = await setup(lead);
    await session.send(big);
    await session.send("now this", stop.signal);
    expect([errors, summaries]).toEqual([[], []]);
    expect(session.messages).toHaveLength(3);
  });

  it("ends the turn quietly when it is stopped while the request is counted for the line, never as the provider's error", async () => {
    const stop = new AbortController();
    // No ratio (a usage of 0 teaches none) and no transcript, so the line's size is the count, which is stopped.
    const unmeasured = { ...reply("noted"), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const lead = counting(new Lead("fake:a", [unmeasured, new TooLong("prompt is too long")], 1_000_000), stop, [10, 10, "stop"]);
    const { session, errors } = await setup(lead, { transcript: undefined });
    await session.send(big);
    await session.send("now this", stop.signal);
    expect(errors).toEqual([]);
  });

  it("ends the turn quietly when it is stopped while the request is counted before it is sent", async () => {
    const stop = new AbortController();
    const lead = counting(new Lead("fake:a", [], 1_000_000), stop, ["stop"]);
    const { session, errors } = await setup(lead);
    await session.send(big, stop.signal);
    expect([errors, lead.seen]).toEqual([[], []]);
    expect(session.messages).toEqual([typed(big)]);
  });

  it("shortens a subagent's conversation through Tasks, saving the shortening in its own file", async () => {
    const lead = saving();
    const turns = [callTool("c1", "echo", { text: "one" }), new TooLong("prompt is too long"), summaryOf("Sub summary."), reply("done")];
    const worker = new Lead("fake:w", turns, 1_000_000);
    const bus = new Bus();
    const ctx = await tempContext();
    const tasks = new Tasks({ bus, max: 8, worker: () => worker, system: "sub", tools: [echo], ctx, transcript: () => lead });
    expect(await tasks.start("brief", { background: false }).done).toEqual({ state: "done", text: "done" });
    const own = new Transcript(path.join(pathsOf(lead.file).subagents, "t1.jsonl"), lead.pictures);
    expect(savedLines(own).map((l) => l.t)).toEqual(["message", "message", "message", "shortened", "message"]);
    expect(isSummary(worker.seen[2]!)).toBe(true);
  });
});

// Release 8b plan, Task 6 (design, "Tool hooks"; choices 10, 15 and 16): PreToolUse before each call, its answer against
// Tachikoma's own checks, and its rewrite kept in the record. Each hook is a Node script in the test's own folder, run in
// exec form; the shell tool here is a stand-in that only records the command the gate let through, so nothing runs it.
describe("Session, PreToolUse hooks", { timeout: 15_000 }, () => {
  // The hook appends its input to the file named by its first argument, waits for the file named by its fourth when one
  // is given, polling every 20 ms as helpers.ts's stand-in editor does, then prints its second and exits with its third.
  const SCRIPT = `const fs = require("fs");
const [out, stdout, code, go] = process.argv.slice(2);
let text = "";
process.stdin.setEncoding("utf8").on("data", (d) => (text += d)).on("end", () => {
  fs.appendFileSync(out, text + "\\n");
  const finish = () => (process.stdout.write(stdout), process.exit(Number(code)));
  const poll = () => (!go || fs.existsSync(go) ? finish() : setTimeout(poll, 20));
  poll();
});`;
  const P = "Not allowed in -p mode, where nobody can approve it"; // cli.tsx's refusal in -p
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // A folder of the test's own, removed when it finishes, tried every 50 ms up to 2 s, as tests/hooks/run.test.ts does:
  // Windows keeps the folder a killed program worked in for about 170 ms (measured 2026-10-31).
  async function folder(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "tachi-pretool-"));
    onTestFinished(async () => {
      for (let i = 0; ; i++) {
        try {
          return await removeTree(dir);
        } catch (err) {
          if (i === 40) throw err;
          await pause(50);
        }
      }
    });
    return dir;
  }
  // The hook appends its input to the file named by its first argument, as SCRIPT's does, then prints the answer its second,
  // a JSON list, gives for this firing of its event: the first the first time, and nothing once the list is used up. It counts
  // every input of its event in the file, so a test gives each event one such hook at most.
  const SEQ = `const fs = require("fs");
const [out, answers] = process.argv.slice(2);
let text = "";
process.stdin.setEncoding("utf8").on("data", (d) => (text += d)).on("end", () => {
  const event = JSON.parse(text).hook_event_name;
  const lines = fs.existsSync(out) ? fs.readFileSync(out, "utf8").split("\\n").filter(Boolean) : [];
  const before = lines.filter((l) => JSON.parse(l).hook_event_name === event).length;
  fs.appendFileSync(out, text + "\\n");
  process.stdout.write(JSON.parse(answers)[before] ?? "");
});`;

  // The hook's script and the file of its inputs, in a folder apart from the project, so a file tool never meets them.
  async function hookFolder() {
    const own = await folder();
    const script = path.join(own, "hook.cjs");
    writeFileSync(script, SCRIPT);
    const seq = path.join(own, "seq.cjs");
    writeFileSync(seq, SEQ);
    return { script, seq, out: path.join(own, "inputs.jsonl") };
  }

  const answer = (fields: object) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...fields } });
  const decide = (decision: string, reason?: string, more: object = {}) =>
    answer({ permissionDecision: decision, ...(reason === undefined ? {} : { permissionDecisionReason: reason }), ...more });
  const rewrite = (updatedInput: object, more: object = {}) => answer({ updatedInput, ...more });
  // `event` is PreToolUse unless given, and `names` the tools' Claude Code names it matches, every tool unless given. With
  // `seq` the hook is SEQ, answering each firing in turn, in place of `stdout`.
  type Says = { stdout: string; code?: number; go?: string; event?: Event; names?: string[]; seq?: string[] };
  type Mode5 = "ask" | "project" | "auto" | "never" | "-p";
  const FIVE: Mode5[] = ["ask", "project", "auto", "never", "-p"];

  // An answer may be a promise, for a question the test answers later.
  type Answers = (boolean | Promise<boolean>)[];
  // `judge` is auto mode's, which says no at once unless given. With `worker`, the lead has delegate, its subagents running
  // on that model with the lead's hooks, and the session has their Tasks.
  async function setup(o: {
    mode: Mode5; says: Says[]; turns: Turn[]; answers?: Answers; transcript?: Transcript; root?: string; tools?: Tool[]; judge?: Judge;
    inbox?: () => string[]; worker?: Provider;
  }) {
    const root = o.root ?? (await folder());
    const { script, seq, out } = await hookFolder();
    const hooks: Hook[] = o.says.map((s) => ({
      event: s.event ?? "PreToolUse",
      matcher: s.names ? { names: s.names } : { all: true },
      command: process.execPath,
      args: s.seq ? [seq, out, JSON.stringify(s.seq)] : [script, out, s.stdout, String(s.code ?? 0), ...(s.go ? [s.go] : [])],
      async: false,
      where: `"${s.event ?? "PreToolUse"}"`,
    }));
    const headless = o.mode === "-p";
    const asked: { summary: string; warnings?: string[]; note?: string }[] = [];
    const judged: string[] = [];
    const refusals: number[] = [];
    const answers = [...(o.answers ?? [])];
    const gate = new PermissionGate(
      o.mode === "-p" ? "project" : o.mode,
      async (summary, _detail, _owner, _plain, warnings, note) => {
        asked.push({ summary, ...(warnings?.length ? { warnings } : {}), ...(note ? { note } : {}) });
        return answers.shift() ?? false;
      },
      headless ? P : undefined,
      {
        root,
        headless,
        judge: async (action, signal, own) => (judged.push(action.summary), o.judge ? o.judge(action, signal, own) : { allow: false, reason: "no" }),
        hookRefused: () => void refusals.push(1),
      },
    );
    const ran: string[] = [];
    const reported: boolean[] = []; // whether each command was given ctx.report
    // It reports its parts as shell.ts does; the command "fail" fails with exit code 1, its result in shell.ts's layout.
    const shell = defineTool("shell", "Runs nothing: records the command the gate let through", z.object({ command: z.string() }), async ({ command }, ctx) => {
      await ctx.gate.require({ kind: "shell", outside: false, summary: `run: ${command}`, command }, ctx.signal);
      ran.push(command);
      reported.push(ctx.report !== undefined);
      const r = command === "fail"
        ? { code: 1, signal: null, stdout: "", stderr: "it failed" }
        : { code: 0, signal: null, stdout: `ran ${command}`, stderr: "" };
      ctx.report?.({ stdout: r.stdout, stderr: r.stderr, code: r.code });
      if (r.code !== 0) throw new Error(shellText(r));
      return `ran ${command}`;
    });
    const bus = new Bus();
    const notes: string[] = [];
    bus.on("hook-note", (line) => notes.push(line));
    const outcomes: string[] = [];
    bus.on("tool-end", (e) => outcomes.push(e.outcome));
    const where: Where = { sessionId: () => "s1", transcript: () => undefined, root, mode: () => gate.mode, effort: () => undefined, lead: () => "fake:a" };
    const ctx = { root, executor: new LocalExecutor(), workspace: new LocalWorkspace(root), gate };
    const lead = new FakeProvider("a", o.turns);
    const given = new Hooks({ hooks, off: false, leftOut: [] }, where, bus); // a test may set others in their place
    const worker = o.worker;
    const tasks = worker
      ? new Tasks({ bus, max: 8, worker: () => worker, system: "sub", tools: [readFileTool], ctx, transcript: () => session.transcript, hooks: given })
      : undefined;
    const session: Session = new Session({
      lead,
      tools: [shell, readFileTool, writeFileTool, editFileTool, ...(tasks ? [delegateTool(tasks, { headless })] : []), ...(o.tools ?? [])],
      system: "t",
      ctx,
      bus,
      hooks: given,
      ...(tasks ? { tasks, inbox: () => tasks.take() } : {}),
      ...(o.transcript ? { transcript: o.transcript } : {}),
      ...(o.inbox ? { inbox: o.inbox } : {}),
    });
    // Whole lines only: the last piece is empty once the hook has written its line, or the part of it written so far.
    const inputs = () => (existsSync(out) ? readFileSync(out, "utf8").split("\n").slice(0, -1).map((l) => JSON.parse(l) as Record<string, unknown>) : []);
    const errors = collectErrors(bus);
    const results = () => session.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "tool_result" ? [{ output: p.output, isError: p.isError }] : [])));
    const command = (h: Hook) => [h.command, ...(h.args ?? [])].join(" ");
    return { root, session, lead, bus, asked, judged, refusals, ran, reported, notes, outcomes, inputs, results, errors, hooks, given, command, tasks };
  }
  const oneCall = (name: string, input: object) => [callTool("c1", name, input), reply("ok")];
  const shellCall = (command: string) => oneCall("shell", { command });

  it.each(FIVE)("in %s, a deny refuses the call, telling the model the hook's reason, and fires with the call in Claude Code's names", async (mode) => {
    const s = await setup({ mode, says: [{ stdout: decide("deny", "no shell here") }], turns: shellCall("echo hi") });
    await s.session.send("go");
    expect(s.ran).toEqual([]);
    expect(s.asked).toEqual([]);
    expect(s.results()).toEqual([{ output: "no shell here", isError: true }]);
    expect(s.outcomes).toEqual(["declined"]);
    expect(s.notes).toEqual(["A PreToolUse hook refused shell: no shell here"]);
    const fired = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo hi" }, tool_use_id: "c1" };
    expect(s.inputs()).toEqual([expect.objectContaining(fired)]);
  });

  it("refuses on exit 2, and says a refusal with no reason in its own words", async () => {
    const exit2 = await setup({ mode: "ask", says: [{ stdout: "", code: 2 }], turns: shellCall("echo hi") });
    await exit2.session.send("go");
    expect(exit2.results()).toEqual([{ output: "A PreToolUse hook refused shell.", isError: true }]);
    expect(exit2.notes).toEqual(["A PreToolUse hook refused shell."]);
    const bare = await setup({ mode: "ask", says: [{ stdout: decide("deny") }], turns: shellCall("echo hi") });
    await bare.session.send("go");
    expect(bare.results()).toEqual([{ output: "A PreToolUse hook refused shell.", isError: true }]);
  });

  it.each(FIVE)("in %s, an allow runs a shell command ask mode would ask about, with no question and no judge", async (mode) => {
    const s = await setup({ mode, says: [{ stdout: decide("allow", "fine") }], turns: shellCall("echo hi") });
    await s.session.send("go");
    expect([s.ran, s.asked, s.judged, s.outcomes, s.notes]).toEqual([["echo hi"], [], [], ["ok"], []]);
  });

  const push = "git push --force";
  it.each(["ask", "project", "auto"] as const)("in %s, an allow on a dangerous command still asks, with its red line", async (mode) => {
    const s = await setup({ mode, says: [{ stdout: decide("allow") }], turns: shellCall(push), answers: [true] });
    await s.session.send("go");
    expect(s.asked).toEqual([{ summary: `run: ${push}`, warnings: [`Danger: rewriting or deleting git history: ${push}`] }]);
    expect(s.ran).toEqual([push]);
  });

  it.each(["never", "-p"] as const)("in %s, an allow on a dangerous command is still refused", async (mode) => {
    const s = await setup({ mode, says: [{ stdout: decide("allow") }], turns: shellCall(push) });
    await s.session.send("go");
    expect(s.ran).toEqual([]);
    const refusal = `Not allowed: this command matches the dangerous-command check (rewriting or deleting git history: ${push}).`;
    expect(s.results()).toEqual([{ output: refusal, isError: true }]);
  });

  it("in project, an allow on a protected write still asks", async () => {
    const s = await setup({ mode: "project", says: [{ stdout: decide("allow") }], turns: oneCall("write_file", { path: ".npmrc", content: "x" }) });
    await s.session.send("go");
    expect(s.asked).toEqual([{ summary: `write ${path.join(s.root, ".npmrc")}` }]);
    expect(existsSync(path.join(s.root, ".npmrc"))).toBe(false);
    expect(s.outcomes).toEqual(["declined"]);
  });

  // The user's choice, 2026-11-09: an allow skips only the mode's ordinary question and the judge.
  it.each(["ask", "project"] as const)("in %s, an allow on a write outside the project still asks", async (mode) => {
    const elsewhere = path.join(await folder(), "a.txt");
    const s = await setup({ mode, says: [{ stdout: decide("allow") }], turns: oneCall("write_file", { path: elsewhere, content: "x" }) });
    await s.session.send("go");
    expect(s.asked.map((a) => a.summary)).toEqual([expect.stringContaining(`write ${elsewhere}`)]);
    expect(existsSync(elsewhere)).toBe(false);
  });

  it("in project, an ask puts one question with the hook's note, and a yes runs the call with no second question", async () => {
    const root = await folder();
    writeFileSync(path.join(root, "a.txt"), "hello\n");
    const turns = [callTool("c1", "read_file", { path: "a.txt" }), callTool("c2", "shell", { command: "echo hi" }), reply("ok")];
    const s = await setup({ mode: "project", root, says: [{ stdout: decide("ask", "Check this first") }], turns, answers: [true, true] });
    await s.session.send("go");
    expect(s.asked).toEqual([
      { summary: 'read_file {"path":"a.txt"}', note: "A hook asks: Check this first" },
      { summary: 'shell {"command":"echo hi"}', note: "A hook asks: Check this first" },
    ]);
    expect(s.results()).toEqual([{ output: "     1\thello", isError: false }, { output: "ran echo hi", isError: false }]);
    expect(s.ran).toEqual(["echo hi"]);
  });

  it("declines the call on a no to a hook's question, as any no", async () => {
    const s = await setup({ mode: "ask", says: [{ stdout: decide("ask", "Sure?") }], turns: shellCall("echo hi"), answers: [false] });
    await s.session.send("go");
    expect(s.results()).toEqual([{ output: 'The user declined: shell {"command":"echo hi"}', isError: true }]);
    expect([s.ran, s.outcomes]).toEqual([[], ["declined"]]);
  });

  // The model's line is also the grey line (the user's choice, 2026-11-09), as a deny's is.
  it.each([
    ["never", "Sure?", "Not allowed in never mode: a PreToolUse hook asked for this call to be approved (Sure?)."],
    ["never", undefined, "Not allowed in never mode: a PreToolUse hook asked for this call to be approved."],
    ["-p", "Sure?", "Not allowed: a PreToolUse hook asked for this call to be approved (Sure?), and -p cannot ask."],
    ["-p", undefined, "Not allowed: a PreToolUse hook asked for this call to be approved, and -p cannot ask."],
  ] as const)("in %s, an ask (reason %s) refuses the call with its line to the model, and says it grey", async (mode, reason, line) => {
    const s = await setup({ mode, says: [{ stdout: decide("ask", reason) }], turns: shellCall("echo hi") });
    await s.session.send("go");
    expect([s.results(), s.notes, s.asked, s.ran, s.outcomes]).toEqual([[{ output: line, isError: true }], [line], [], [], ["declined"]]);
  });

  // The question names the call with its whole input, a write's content included, so its refusal is cut as a tool's
  // long output is (session.ts, truncate).
  it("cuts the refusal the model gets for a no to a hook's question on a large write", async () => {
    const content = "x".repeat(MAX_TOOL_OUTPUT);
    const s = await setup({ mode: "ask", says: [{ stdout: decide("ask") }], turns: oneCall("write_file", { path: "big.txt", content }), answers: [false] });
    await s.session.send("go");
    const whole = `The user declined: write_file ${JSON.stringify({ path: "big.txt", content })}`;
    const cut = `${whole.slice(0, MAX_TOOL_OUTPUT)}\n[cut: ${whole.length - MAX_TOOL_OUTPUT} more characters]`;
    expect([s.results(), s.outcomes]).toEqual([[{ output: cut, isError: true }], ["declined"]]);
    expect(existsSync(path.join(s.root, "big.txt"))).toBe(false);
  });

  // The user's own hook: it puts sfw before an install, which the stand-in shell records and never runs.
  it("runs a rewritten command, the sfw hook's shape, and the gate's check reads the rewritten command", async () => {
    const s = await setup({ mode: "ask", says: [{ stdout: rewrite({ command: "sfw npm install x" }) }], turns: shellCall("npm install x"), answers: [true] });
    await s.session.send("go");
    expect(s.ran).toEqual(["sfw npm install x"]);
    expect(s.asked.map((a) => a.summary)).toEqual(["run: sfw npm install x"]);
    expect(s.session.calls).toEqual([{ name: "shell", input: { command: "sfw npm install x" } }]);
    expect(s.session.messages[1]!.parts).toEqual([{ type: "tool_call", id: "c1", name: "shell", input: { command: "npm install x" } }]);
    const allowed = rewrite({ command: push }, { permissionDecision: "allow" });
    const danger = await setup({ mode: "project", says: [{ stdout: allowed }], turns: shellCall("echo hi"), answers: [false] });
    await danger.session.send("go");
    expect(danger.asked).toEqual([{ summary: `run: ${push}`, warnings: [`Danger: rewriting or deleting git history: ${push}`] }]);
  });

  it("names the rewritten call in a hook's question", async () => {
    const asks = rewrite({ command: "echo two" }, { permissionDecision: "ask" });
    const s = await setup({ mode: "ask", says: [{ stdout: asks }], turns: shellCall("echo one"), answers: [true] });
    await s.session.send("go");
    expect(s.asked).toEqual([{ summary: 'shell {"command":"echo two"}', note: "A hook asks." }]);
    expect(s.ran).toEqual(["echo two"]);
  });

  // Choice 16 and the design's review finding 4: the record of calls takes the input that ran, kept over a resume.
  it("keeps a read rewritten from A to B in the record, saved before the call runs and still there after a resume, the reply saying A", async () => {
    const top = await folder();
    const dir = path.join(top, "sessions", "project");
    privateDir(dir);
    const file = path.join(dir, "s1.jsonl");
    const transcript = new Transcript(file, path.join(dir, "s1", "pictures"));
    transcript.write({ t: "start", v: 1, id: "s1", project: top, lead: "fake:a", version: "0.8.0", print: false, system: "t", tools: [] });
    const root = await folder();
    writeFileSync(path.join(root, "a.txt"), "A\n");
    writeFileSync(path.join(root, "b.txt"), "B\n");
    const b = path.join(root, "b.txt");
    const s = await setup({ mode: "never", root, says: [{ stdout: rewrite({ file_path: b }) }], turns: oneCall("read_file", { path: "a.txt" }), transcript });
    await s.session.send("go");
    expect(s.results()).toEqual([{ output: "     1\tB", isError: false }]);
    expect(s.session.calls).toEqual([{ name: "read_file", input: { path: b } }]);
    const saved = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line);
    expect(saved.map((l) => l.t)).toEqual(["start", "message", "message", "rewritten", "message", "message"]);
    expect(saved[3]).toEqual({ t: "rewritten", at: expect.any(String), id: "c1", input: { path: b } });
    const r = readTranscript(file, path.join(dir, "s1", "pictures"));
    if ("problem" in r) throw new Error(r.problem);
    expect(r.calls).toEqual([{ name: "read_file", input: { path: b } }]);
    expect(r.messages[1]!.parts).toEqual([{ type: "tool_call", id: "c1", name: "read_file", input: { path: "a.txt" } }]);
  });

  it("refuses a rewrite with replace_all: true, with its line", async () => {
    const root = await folder();
    writeFileSync(path.join(root, "a.txt"), "hello\n");
    const edit = rewrite({ file_path: path.join(root, "a.txt"), old_string: "hello", new_string: "bye", replace_all: true });
    const turns = oneCall("edit_file", { path: "a.txt", old_text: "hello", new_text: "bye" });
    const s = await setup({ mode: "never", root, says: [{ stdout: edit }], turns });
    await s.session.send("go");
    const why = `"replace_all" must be false, as Tachikoma's edit_file replaces one exact match`;
    const line = `A PreToolUse hook's rewrite of edit_file could not be used (${why}): ${s.command(s.hooks[0]!)}`;
    expect([s.results(), s.notes, s.outcomes]).toEqual([[{ output: line, isError: true }], [line], ["declined"]]);
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("hello\n");
    expect(s.session.calls).toEqual([{ name: "edit_file", input: { path: "a.txt", old_text: "hello", new_text: "bye" } }]);
  });

  // Task 6's code review: the error log names the input that ran, as the record of calls does.
  it("names the rewritten input in the error log when the rewritten call fails", async () => {
    const root = await folder();
    writeFileSync(path.join(root, "a.txt"), "hello\n");
    const a = path.join(root, "a.txt");
    const edit = rewrite({ file_path: a, old_string: "not in the file", new_string: "bye" });
    const turns = oneCall("edit_file", { path: "a.txt", old_text: "hello", new_text: "bye" });
    const s = await setup({ mode: "never", root, says: [{ stdout: edit }], turns });
    await s.session.send("go");
    expect(s.outcomes).toEqual(["failed"]);
    expect(s.errors.map((e) => e.attempted)).toEqual([`edit_file ${JSON.stringify({ path: a, old_text: "not in the file", new_text: "bye" })}`]);
  });

  it("uses the first of two rewrites in the file, saying which was ignored", async () => {
    const says = [{ stdout: rewrite({ command: "echo first" }) }, { stdout: rewrite({ command: "echo second" }) }];
    const s = await setup({ mode: "never", says, turns: shellCall("echo hi") });
    await s.session.send("go");
    expect(s.ran).toEqual(["echo first"]);
    const second = s.command(s.hooks[1]!);
    expect(s.notes).toEqual([`Two PreToolUse hooks rewrote shell's input; the first in the settings file was used, and ${second} was ignored.`]);
  });

  // Task 3's carry-over: combine still collects a rewrite from a hook that also denied, which a refused call never uses.
  it.each([
    ["a deny with a rewrite", { stdout: decide("deny", "no", { updatedInput: { command: "echo other" } }) }],
    ["exit 2 with a rewrite", { stdout: rewrite({ command: "echo other" }), code: 2 }],
  ] as const)("never uses a rewrite of a refused call, nor says two rewrites: %s", async (_name, says) => {
    const s = await setup({ mode: "never", says: [says, { stdout: rewrite({ command: "echo second" }) }], turns: shellCall("echo hi") });
    await s.session.send("go");
    expect(s.ran).toEqual([]);
    expect(s.notes).toEqual([expect.stringMatching(/^A PreToolUse hook refused shell/)]);
    expect(s.session.calls).toEqual([{ name: "shell", input: { command: "echo hi" } }]);
  });

  // The user's choice, 2026-11-09: in -p a hook's refusal fails the run, so the gate is told of each (cli.tsx).
  it.each([
    ["a deny", { stdout: decide("deny", "no") }, 1],
    ["a block", { stdout: "", code: 2 }, 1],
    ["a rewrite that cannot be used", { stdout: rewrite({ command: "echo x", run_in_background: true }) }, 1],
    ["an ask -p cannot put", { stdout: decide("ask") }, 1],
    ["an allow", { stdout: decide("allow") }, 0],
    ["a rewrite that is used", { stdout: rewrite({ command: "echo x" }) }, 0],
  ] as const)("in -p, tells the gate of a call a hook refused: %s", async (_name, says, times) => {
    const s = await setup({ mode: "-p", says: [says], turns: shellCall("echo hi") });
    await s.session.send("go");
    expect(s.refusals).toHaveLength(times);
  });

  it("says a defer, and takes it as no opinion", async () => {
    const s = await setup({ mode: "ask", says: [{ stdout: decide("defer") }], turns: shellCall("echo hi"), answers: [true] });
    await s.session.send("go");
    expect(s.notes).toEqual(['A PreToolUse hook answered "defer", which Tachikoma takes as no opinion.']);
    expect(s.asked.map((a) => a.summary)).toEqual(["run: echo hi"]);
    expect(s.ran).toEqual(["echo hi"]);
  });

  it("cancels the call when the turn is stopped while its PreToolUse hook runs", async () => {
    const root = await folder();
    const abort = new AbortController();
    const says = [{ stdout: decide("allow"), go: path.join(root, "never-made") }];
    const s = await setup({ mode: "never", root, says, turns: shellCall("echo hi") });
    const sent = s.session.send("go", abort.signal);
    while (!s.inputs().length) await pause(20);
    abort.abort();
    await sent;
    expect([s.results(), s.outcomes, s.ran]).toEqual([[{ output: "Cancelled by the user.", isError: true }], ["cancelled"], []]);
  });

  it("fires a subagent's PreToolUse with its agent_id", async () => {
    const root = await folder();
    writeFileSync(path.join(root, "a.txt"), "A\n");
    const { script, out } = await hookFolder();
    const hook: Hook = { event: "PreToolUse", matcher: { names: ["Read"] }, command: process.execPath, args: [script, out, "", "0"], async: false, where: "" };
    const bus = new Bus();
    const gate = new PermissionGate("never", async () => false);
    const where: Where = { sessionId: () => "s1", transcript: () => undefined, root, mode: () => gate.mode, effort: () => undefined, lead: () => "fake:a" };
    const tasks = new Tasks({
      bus,
      max: 8,
      worker: () => new FakeProvider("w", [callTool("c1", "read_file", { path: "a.txt" }), reply("found it")]),
      system: "sub",
      tools: [readFileTool],
      ctx: { root, executor: new LocalExecutor(), workspace: new LocalWorkspace(root), gate },
      hooks: new Hooks({ hooks: [hook], off: false, leftOut: [] }, where, bus),
    });
    expect(await tasks.start("look", { background: false }).done).toEqual({ state: "done", text: "found it" });
    const inputs = readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const fired = { agent_id: "t1", agent_type: "Explore", tool_name: "Read", tool_input: { file_path: path.join(root, "a.txt") } };
    expect(inputs).toEqual([expect.objectContaining(fired)]);
  });

  // Release 8b plan, Task 7 (design, "Tool hooks", and its review's finding 1): the hooks after a call, and a hook's
  // continue: false stopping the turn as a user's stop does, every call of the reply answered once.
  const NOT_RUN = "Not run: a hook stopped the turn.";
  const after = (event: Event, fields: object, top: object = {}) => JSON.stringify({ ...top, hookSpecificOutput: { hookEventName: event, ...fields } });
  const stops = (reason?: string) => JSON.stringify({ continue: false, ...(reason === undefined ? {} : { stopReason: reason }) });
  const hookText = (event: Event, text: string) => ({ type: "text", text: `${event} hook:\n${text}`, from: "hooks" });
  const many = (...c: [string, string, unknown][]): Turn => ({ parts: c.map(([id, name, input]) => ({ type: "tool_call" as const, id, name, input })), usage });

  it("fires PostToolUse after a call that ran, with the input that ran, Bash's shape for a command and Write's type", async () => {
    const root = await folder();
    const a = path.join(root, "a.txt");
    const turns = [
      callTool("c1", "shell", { command: "echo hi" }),
      callTool("c2", "write_file", { path: "a.txt", content: "one" }),
      callTool("c3", "write_file", { path: "a.txt", content: "two" }),
      reply("ok"),
    ];
    const says: Says[] = [{ event: "PostToolUse", stdout: "" }, { names: ["Bash"], stdout: rewrite({ command: "echo rewritten" }) }];
    const s = await setup({ mode: "never", root, says, turns });
    await s.session.send("go");
    const ms = expect.any(Number);
    const bash = { stdout: "ran echo rewritten", stderr: "", interrupted: false, isImage: false };
    const write = (id: string, content: string, type: string) => {
      const fired = { tool_name: "Write", tool_input: { file_path: a, content }, tool_use_id: id, tool_response: { filePath: a, type } };
      return expect.objectContaining({ ...fired, duration_ms: ms });
    };
    expect(s.inputs().filter((i) => i.hook_event_name === "PostToolUse")).toEqual([
      expect.objectContaining({ tool_name: "Bash", tool_input: { command: "echo rewritten" }, tool_use_id: "c1", tool_response: bash, duration_ms: ms }),
      write("c2", "one", "create"),
      write("c3", "two", "update"),
    ]);
    expect([s.outcomes, s.notes]).toEqual([["ok", "ok", "ok"], []]);
  });

  it("fires PostToolUseFailure after a failed call, its error starting Exit code 1, and neither for a declined, unknown or schema-refused call", async () => {
    const turns = [
      callTool("c1", "shell", { command: "fail" }),
      callTool("c2", "shell", { command: "echo no" }),
      callTool("c3", "nope", {}),
      callTool("c4", "shell", { command: 5 }),
      reply("ok"),
    ];
    const says: Says[] = [{ event: "PostToolUse", stdout: "" }, { event: "PostToolUseFailure", stdout: "" }];
    const s = await setup({ mode: "ask", says, turns, answers: [true, false] });
    await s.session.send("go");
    expect(s.outcomes).toEqual(["failed", "declined", "failed", "failed"]);
    const failure = { tool_name: "Bash", tool_input: { command: "fail" }, tool_use_id: "c1", error: "Exit code 1\nit failed\n", is_interrupt: false };
    expect(s.inputs()).toEqual([expect.objectContaining({ hook_event_name: "PostToolUseFailure", ...failure, duration_ms: expect.any(Number) })]);
  });

  it("fires neither PostToolUse nor PostToolUseFailure for a call a PreToolUse hook refused, nor one the user's stop cancelled", async () => {
    const post: Says[] = [{ event: "PostToolUse", stdout: "" }, { event: "PostToolUseFailure", stdout: "" }];
    const denied = await setup({ mode: "never", says: [{ stdout: decide("deny", "no") }, ...post], turns: shellCall("echo hi") });
    await denied.session.send("go");
    expect([denied.outcomes, denied.inputs().map((i) => i.hook_event_name)]).toEqual([["declined"], ["PreToolUse"]]);
    const stop = new AbortController();
    // Stops the turn once it runs, as Esc does, then fails as a killed command does.
    const stopping = defineTool("stopping", "Stops the turn while it runs", z.object({}), (_input, c) =>
      new Promise((_ok, no) => {
        c.signal?.addEventListener("abort", () => no(new Error("killed")));
        stop.abort();
      }));
    const cancelled = await setup({ mode: "never", says: post, turns: [callTool("c1", "stopping", {})], tools: [stopping] });
    await cancelled.session.send("go", stop.signal);
    expect([cancelled.results(), cancelled.outcomes, cancelled.inputs()]).toEqual([[{ output: "Cancelled by the user.", isError: true }], ["cancelled"], []]);
  });

  it("gives the model a string updatedToolOutput in place of a read's result, and ignores one that does not match the tool's result", async () => {
    const root = await folder();
    writeFileSync(path.join(root, "a.txt"), "A\n");
    const turns = [callTool("c1", "read_file", { path: "a.txt" }), callTool("c2", "shell", { command: "echo hi" }), reply("ok")];
    const says: Says[] = [
      { event: "PostToolUse", names: ["Read"], stdout: after("PostToolUse", { updatedToolOutput: "not what the file says" }) },
      { event: "PostToolUse", names: ["Bash"], stdout: after("PostToolUse", { updatedToolOutput: "just words" }) },
    ];
    const s = await setup({ mode: "never", root, says, turns });
    await s.session.send("go");
    expect(s.results()).toEqual([{ output: "not what the file says", isError: false }, { output: "ran echo hi", isError: false }]);
    expect(s.outcomes).toEqual(["ok", "ok"]);
  });

  it("puts the hooks' text for the model after the reply's results, headed, a block's reason among it, the result and outcome unchanged", async () => {
    const says: Says[] = [
      { stdout: answer({ additionalContext: "before it ran" }) },
      { event: "PostToolUse", stdout: after("PostToolUse", { additionalContext: "after it ran" }, { decision: "block", reason: "looked odd" }) },
    ];
    const s = await setup({ mode: "never", says, turns: shellCall("echo hi") });
    await s.session.send("go");
    expect(s.lead.seen[1]!.at(-1)!.parts).toEqual([
      { type: "tool_result", callId: "c1", output: "ran echo hi", isError: false },
      hookText("PreToolUse", "before it ran"),
      hookText("PostToolUse", "looked odd"),
      hookText("PostToolUse", "after it ran"),
    ]);
    expect([s.outcomes, s.notes]).toEqual([["ok"], []]);
  });

  // Task 5's build: write_file reads the file to tell Write's create from update only when report is set.
  it.each<[string, Partial<Says>, boolean]>([
    ["a PostToolUse hook for Bash", { event: "PostToolUse", names: ["Bash"] }, true],
    ["a PostToolUseFailure hook for Bash", { event: "PostToolUseFailure", names: ["Bash"] }, true],
    ["a PostToolUse hook for Read alone", { event: "PostToolUse", names: ["Read"] }, false],
    ["a PreToolUse hook alone", {}, false],
  ])("gives a tool ctx.report only when a hook after the call matches it: %s", async (_name, hook, given) => {
    const s = await setup({ mode: "never", says: [{ stdout: "", ...hook }], turns: shellCall("echo hi") });
    await s.session.send("go");
    expect(s.reported).toEqual([given]);
  });

  it.each([
    ["halt", "A PreToolUse hook stopped the turn: halt"],
    [undefined, "A PreToolUse hook stopped the turn."],
  ] as const)("stops the turn at a PreToolUse hook's continue: false (reason %s), running no call, its text kept from the next turn", async (reason, line) => {
    const stopping = JSON.stringify({ ...JSON.parse(stops(reason)), hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "noted" } });
    const turns = [many(["c1", "shell", { command: "echo one" }], ["c2", "shell", { command: "echo two" }]), reply("next turn")];
    const s = await setup({ mode: "never", says: [{ stdout: stopping }], turns });
    expect(await s.session.send("go")).toEqual({ stopped: reason ?? "" });
    const notRun = { output: NOT_RUN, isError: true };
    expect([s.ran, s.results(), s.outcomes, s.notes]).toEqual([[], [notRun, notRun], ["cancelled", "cancelled"], [line]]);
    expect([s.inputs().length, s.lead.seen.length]).toEqual([1, 1]);
    expect(await s.session.send("again")).toBeUndefined();
    // The next request joins the stopped turn's results and the new prompt (types.ts, sentAll): the text is there once.
    const result = (callId: string) => ({ type: "tool_result", callId, ...notRun });
    const parts = [result("c1"), result("c2"), hookText("PreToolUse", "noted"), { type: "text", text: "again" }];
    expect(s.lead.seen[1]!.at(-1)!.parts).toEqual(parts);
  });

  it("stops the turn at a PostToolUseFailure hook's continue: false, the failed call keeping its own result and the next not run", async () => {
    const turns = [many(["c1", "shell", { command: "fail" }], ["c2", "shell", { command: "echo two" }])];
    const s = await setup({ mode: "never", says: [{ event: "PostToolUseFailure", stdout: stops("it broke") }], turns });
    expect(await s.session.send("go")).toEqual({ stopped: "it broke" });
    const failed = shellText({ code: 1, signal: null, stdout: "", stderr: "it failed" });
    expect(s.results()).toEqual([{ output: failed, isError: true }, { output: NOT_RUN, isError: true }]);
    expect([s.ran, s.outcomes, s.notes]).toEqual([["fail"], ["failed", "cancelled"], ["A PostToolUseFailure hook stopped the turn: it broke"]]);
  });

  // The design's review finding 1: the history stays one the providers take and a resume can load.
  it("stops the turn at a PostToolUse hook's continue: false while a delegate runs: every call answered once, the next request taken, the resume", async () => {
    const top = await folder();
    const dir = path.join(top, "sessions", "project");
    privateDir(dir);
    const file = path.join(dir, "s1.jsonl");
    const pictures = path.join(dir, "s1", "pictures");
    const transcript = new Transcript(file, pictures);
    transcript.write({ t: "start", v: 1, id: "s1", project: top, lead: "fake:a", version: "0.8.0", print: false, system: "t", tools: [] });
    const root = await folder();
    writeFileSync(path.join(root, "a.txt"), "A\n");
    const worker = new Held("fake:w"); // never answers, so the subagent runs until it is stopped
    const ctx = { root, executor: new LocalExecutor(), workspace: new LocalWorkspace(root), gate: new PermissionGate("never", async () => false) };
    const tasks = new Tasks({ bus: new Bus(), max: 8, worker: () => worker, system: "sub", tools: [readFileTool], ctx });
    const calls = many(
      ["c1", "shell", { command: "echo one" }],
      ["c2", "delegate", { description: "look", task: "find x" }],
      ["c3", "read_file", { path: "a.txt" }],
    );
    const says: Says[] = [{ event: "PostToolUse", names: ["Bash"], stdout: stops("enough") }];
    const s = await setup({ mode: "never", root, says, turns: [calls, reply("fine")], transcript, tools: [delegateTool(tasks, { headless: false })] });
    expect(await s.session.send("go")).toEqual({ stopped: "enough" });
    expect([tasks.all.map((t) => t.state), worker.asked.length]).toEqual([["stopped"], 1]);
    const answered = [
      { type: "tool_result", callId: "c1", output: "ran echo one", isError: false },
      { type: "tool_result", callId: "c2", output: "t1 was stopped.", isError: false },
      { type: "tool_result", callId: "c3", output: NOT_RUN, isError: true },
    ];
    expect(s.session.messages[2]!.parts).toEqual(answered);
    expect(s.notes).toEqual(["A PostToolUse hook stopped the turn: enough"]);
    await s.session.send("go on");
    // The results and the new prompt go as one user message (types.ts, sentAll).
    expect(s.lead.seen[1]!.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(s.lead.seen[1]![2]!.parts).toEqual([...answered, { type: "text", text: "go on" }]);
    const r = readTranscript(file, pictures);
    if ("problem" in r) throw new Error(r.problem);
    expect(r.messages[2]!.parts).toEqual(answered);
  });

  it("stops a call still running when a delegate's PostToolUse hook stops the turn, sent Agent's shape, in the approved words", async () => {
    const root = await folder();
    const ctx = { root, executor: new LocalExecutor(), workspace: new LocalWorkspace(root), gate: new PermissionGate("never", async () => false) };
    const tasks = new Tasks({ bus: new Bus(), max: 8, worker: () => new FakeProvider("w", [reply("found")]), system: "sub", tools: [readFileTool], ctx });
    // Runs until it is stopped, then fails as a killed command does.
    const slow = defineTool("slow", "Waits to be stopped", z.object({}), (_input, c) =>
      new Promise((_ok, no) => {
        if (c.signal?.aborted) return no(new Error("killed"));
        c.signal?.addEventListener("abort", () => no(new Error("killed")));
      }));
    const calls = many(["c1", "slow", {}], ["c2", "delegate", { description: "look", task: "find x" }]);
    const says: Says[] = [{ event: "PostToolUse", names: ["Agent"], stdout: stops() }];
    const s = await setup({ mode: "never", root, says, turns: [calls], tools: [delegateTool(tasks, { headless: false }), slow] });
    expect(await s.session.send("go")).toEqual({ stopped: "" });
    expect(s.results()).toEqual([{ output: "Stopped: a hook stopped the turn.", isError: true }, { output: "found", isError: false }]);
    expect([s.outcomes.sort(), s.errors, s.notes]).toEqual([["cancelled", "ok"], [], ["A PostToolUse hook stopped the turn."]]);
    const agent = { status: "completed", agentId: "t1", content: [{ type: "text", text: "found" }] };
    const input = { description: "look", prompt: "find x", subagent_type: "Explore" };
    expect(s.inputs()).toEqual([expect.objectContaining({ tool_name: "Agent", tool_input: input, tool_use_id: "c2", tool_response: agent })]);
  });

  // Task 7's code review: a question still open when a hook stops the turn runs nothing, whatever its answer, and the
  // model is told it was not run (Task 7's re-check).
  it.each<[string, Mode5, Says[]]>([
    ["the mode's question", "ask", []],
    ["a PreToolUse hook's ask", "project", [{ names: ["Write"], stdout: decide("ask") }]],
  ])("writes nothing on a yes to %s given after a delegate's PostToolUse hook stopped the turn", async (_name, mode, pre) => {
    const root = await folder();
    let yes!: (answer: boolean) => void;
    const answer = new Promise<boolean>((r) => (yes = r));
    const worker = new Held("fake:w"); // answered once the write's question is open
    const ctx = { root, executor: new LocalExecutor(), workspace: new LocalWorkspace(root), gate: new PermissionGate("never", async () => false) };
    const tasks = new Tasks({ bus: new Bus(), max: 8, worker: () => worker, system: "sub", tools: [readFileTool], ctx });
    // Runs beside the others until the turn is stopped, then says yes to the write's question.
    const watch = {
      ...defineTool("watch", "Says yes once the turn is stopped", z.object({}), (_input, c) =>
        new Promise<string>((ok) => {
          const go = () => (yes(true), ok("saw the stop"));
          if (c.signal?.aborted) go();
          else c.signal?.addEventListener("abort", go);
        })),
      parallel: true,
    };
    const calls = many(["c1", "write_file", { path: "a.txt", content: "x" }], ["c2", "delegate", { description: "look", task: "find x" }], ["c3", "watch", {}]);
    const says: Says[] = [...pre, { event: "PostToolUse", names: ["Agent"], stdout: stops("enough") }];
    const s = await setup({ mode, root, says, turns: [calls], answers: [answer], tools: [delegateTool(tasks, { headless: false }), watch] });
    const sent = s.session.send("go");
    while (!s.asked.length || !worker.asked.length) await pause(20);
    worker.answer("found");
    expect(await sent).toEqual({ stopped: "enough" });
    expect(existsSync(path.join(root, "a.txt"))).toBe(false);
    expect(s.results()).toEqual([{ output: NOT_RUN, isError: true }, { output: "found", isError: false }, { output: "saw the stop", isError: false }]);
    expect(s.asked).toHaveLength(1);
  });

  // Task 7's re-check: in auto mode, a stop while the judge decides runs nothing, whether the judge then still says yes or
  // its request is cut off, and the model is told the call was not run; the user's stop is a cancel, as before.
  const onStop = (signal: AbortSignal, then: () => void) => (signal.aborted ? then() : signal.addEventListener("abort", then));
  const judging: [string, Judge][] = [
    ["says yes after the stop", (_action, signal) => new Promise((ok) => onStop(signal, () => ok({ allow: true })))],
    ["has its request cut off", (_action, signal) => new Promise((_ok, no) => onStop(signal, () => no(signal.reason)))],
  ];

  it.each(judging)("runs nothing in auto mode when a delegate's PostToolUse hook stops the turn while the judge %s", async (_name, judge) => {
    const root = await folder();
    const worker = new Held("fake:w"); // answered once the judge is deciding
    const ctx = { root, executor: new LocalExecutor(), workspace: new LocalWorkspace(root), gate: new PermissionGate("never", async () => false) };
    const tasks = new Tasks({ bus: new Bus(), max: 8, worker: () => worker, system: "sub", tools: [readFileTool], ctx });
    const calls = many(["c1", "shell", { command: "echo hi" }], ["c2", "delegate", { description: "look", task: "find x" }]);
    const says: Says[] = [{ event: "PostToolUse", names: ["Agent"], stdout: stops("enough") }];
    const s = await setup({ mode: "auto", root, says, turns: [calls], judge, tools: [delegateTool(tasks, { headless: false })] });
    const sent = s.session.send("go");
    while (!s.judged.length || !worker.asked.length) await pause(20);
    worker.answer("found");
    expect(await sent).toEqual({ stopped: "enough" });
    expect([s.ran, s.results(), s.outcomes.sort()]).toEqual([[], [{ output: NOT_RUN, isError: true }, { output: "found", isError: false }], ["cancelled", "ok"]]);
  });

  it.each(judging)("cancels the call in auto mode when the user stops the turn while the judge %s", async (_name, judge) => {
    const stop = new AbortController();
    const s = await setup({ mode: "auto", says: [], turns: shellCall("echo hi"), judge: (action, signal, own) => (stop.abort(), judge(action, signal, own)) });
    await s.session.send("go", stop.signal);
    expect([s.ran, s.results(), s.outcomes, s.errors]).toEqual([[], [{ output: "Cancelled by the user.", isError: true }], ["cancelled"], []]);
  });

  // Task 7's code review: a throw after the call ran leaves its own result, so the history stays one the providers take.
  it("keeps a call's own result when a listener of the hooks' lines throws at PostToolUse, saying so, and the next send works", async () => {
    const says: Says[] = [{ event: "PostToolUse", stdout: JSON.stringify({ systemMessage: "hello" }) }];
    const s = await setup({ mode: "never", says, turns: [...shellCall("echo hi"), reply("again")] });
    s.bus.on("hook-note", () => {
      throw new Error("listener broke");
    });
    await s.session.send("go");
    expect([s.results(), s.outcomes]).toEqual([[{ output: "ran echo hi", isError: false }], ["ok"]]);
    expect(s.errors.map((e) => [e.kind, e.attempted, e.message])).toEqual([["hook", "PostToolUse hook", "PostToolUse hook failed: listener broke"]]);
    await s.session.send("more");
    expect(s.lead.seen[2]!.at(-1)!.parts).toEqual([{ type: "text", text: "more" }]);
  });

  // Release 8b plan, Task 8 (choices 6 and 17): UserPromptSubmit before a prompt goes, and the hooks' text for the model
  // in the prompt's message, saved with it.
  const prompted = (fields: object, top: object = {}) => after("UserPromptSubmit", fields, top);
  const own = (text: string, on: Says = { stdout: "" }): Says => ({ ...on, event: "UserPromptSubmit", stdout: text });

  it("fires UserPromptSubmit with the prompt, each picture its marker, and sends its context and plain text with the prompt, headed", async () => {
    const says = [own(prompted({ additionalContext: "the tests are in tests/" })), own("plain words")];
    const s = await setup({ mode: "never", says, turns: [reply("ok"), reply("again")] });
    const png = { type: "image", id: 3, mediaType: "image/png", data: Buffer.from("png") } as const;
    await s.session.send([{ type: "text", text: "what is in " }, png, { type: "text", text: "?" }]);
    expect(s.lead.seen[0]!.at(-1)!.parts).toEqual([
      { type: "text", text: "what is in " },
      { ...png, data: expect.anything() }, // the stand-in keeps a copy of each request, its Buffer a Uint8Array
      { type: "text", text: "?" },
      hookText("UserPromptSubmit", "the tests are in tests/"),
      hookText("UserPromptSubmit", "plain words"),
    ]);
    const first = { hook_event_name: "UserPromptSubmit", prompt: "what is in [Image #3]?", prompt_id: expect.any(String) };
    expect(s.inputs()).toEqual([expect.objectContaining(first), expect.objectContaining(first)]);
    // The judge's prompts hold the user's own words alone (choice 6).
    expect(s.session.prompts).toEqual(["what is in [Image #3]?"]);
    // Each prompt gets a prompt id of its own (Hooks.newPrompt).
    await s.session.send("more");
    const ids = s.inputs().map((i) => i.prompt_id);
    expect([ids[0] === ids[1], ids[2] === ids[0], ids[2] === ids[3]]).toEqual([true, false, true]);
  });

  it.each([
    ["a block", JSON.stringify({ decision: "block", reason: "not today" }), { blocked: "not today" }, "A UserPromptSubmit hook blocked the prompt: not today"],
    // No reason: its own words (approved by the user, 2026-11-09).
    ["exit 2 with no error output", "", { blocked: "" }, "A UserPromptSubmit hook blocked the prompt."],
    ["a continue: false", stops("halt"), { stopped: "halt", unsent: true }, "A UserPromptSubmit hook stopped the turn: halt"],
  ] as const)("sends nothing and saves nothing at a UserPromptSubmit hook's %s, leaving the waiting text for the next prompt", async (_name, stdout, ended, line) => {
    const top = await folder();
    const file = path.join(top, "s1.jsonl");
    const transcript = new Transcript(file, path.join(top, "s1", "pictures"));
    transcript.write({ t: "start", v: 1, id: "s1", project: top, lead: "fake:a", version: "0.8.0", print: false, system: "t", tools: [] });
    const waiting = ["t1 finished"];
    const says = [own(stdout, { stdout, code: stdout ? 0 : 2 })];
    const s = await setup({ mode: "never", says, turns: [reply("ok")], transcript, inbox: () => waiting.splice(0) });
    s.session.waitForNext([{ event: "SessionStart", text: "from the start" }]);
    expect(await s.session.send("go")).toEqual(ended);
    expect([s.session.messages, s.session.prompts, s.lead.seen, waiting]).toEqual([[], [], [], ["t1 finished"]]);
    expect(readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as Line).t)).toEqual(["start"]);
    expect(s.notes).toEqual([line]);
    // Both kinds of waiting text go with the next prompt that is sent (Task 8's code review).
    s.given.set({ hooks: [], off: false, leftOut: [] });
    await s.session.send("again");
    const next = [hookText("SessionStart", "from the start"), { type: "text", text: "again" }, { type: "text", text: "t1 finished", from: "tasks" }];
    expect(s.lead.seen[0]!.at(-1)!.parts).toEqual(next);
  });

  it("sends nothing and saves nothing when the user stops the turn while a UserPromptSubmit hook runs", async () => {
    const root = await folder();
    const abort = new AbortController();
    const s = await setup({ mode: "never", root, says: [own("", { stdout: "", go: path.join(root, "never-made") })], turns: [reply("ok")] });
    const sent = s.session.send("go", abort.signal);
    // Up to 10 s for the hook's process to start (Task 8's code review), then the test fails here, not at its timeout.
    for (let i = 0; !s.inputs().length; i++) {
      if (i === 500) throw new Error("the hook never started");
      await pause(20);
    }
    abort.abort();
    expect(await sent).toBeUndefined();
    expect([s.session.messages, s.session.prompts, s.lead.seen, s.notes, s.errors]).toEqual([[], [], [], [], []]);
  });

  it("fires no UserPromptSubmit for a subagent's brief, which the lead wrote", async () => {
    const root = await folder();
    const { script, out } = await hookFolder();
    const hook: Hook = { event: "UserPromptSubmit", matcher: { all: true }, command: process.execPath, args: [script, out, "", "0"], async: false, where: "" };
    const bus = new Bus();
    const gate = new PermissionGate("never", async () => false);
    const where: Where = { sessionId: () => "s1", transcript: () => undefined, root, mode: () => gate.mode, effort: () => undefined, lead: () => "fake:a" };
    const tasks = new Tasks({
      bus,
      max: 8,
      worker: () => new FakeProvider("w", [reply("found it")]),
      system: "sub",
      tools: [readFileTool],
      ctx: { root, executor: new LocalExecutor(), workspace: new LocalWorkspace(root), gate },
      hooks: new Hooks({ hooks: [hook], off: false, leftOut: [] }, where, bus),
    });
    expect(await tasks.start("look", { background: false }).done).toEqual({ state: "done", text: "found it" });
    expect(existsSync(out)).toBe(false);
  });

  // Task 10 fills it with SessionStart's text; a load empties it, as that text was the last conversation's.
  it("sends the text waiting for the next request at the start of the next prompt's message, once, and a load empties it", async () => {
    const s = await setup({ mode: "never", says: [], turns: [reply("ok"), reply("again"), reply("three")] });
    s.session.waitForNext([{ event: "SessionStart", text: "from the start" }]);
    await s.session.send("go");
    await s.session.send("more");
    expect(s.lead.seen[0]!.at(-1)!.parts).toEqual([hookText("SessionStart", "from the start"), { type: "text", text: "go" }]);
    expect(s.lead.seen[1]!.at(-1)!.parts).toEqual([{ type: "text", text: "more" }]);
    s.session.waitForNext([{ event: "SessionStart", text: "the last one's" }]);
    s.session.load({ id: "s2", messages: [], system: "t", prompts: [], calls: [], nextPicture: 1, nextTask: 1 });
    await s.session.send("three");
    expect(s.lead.seen[2]!.at(-1)!.parts).toEqual([{ type: "text", text: "three" }]);
  });

  it("keeps a UserPromptSubmit hook's text in the saved message, so a resumed session sends it again without running the hook", async () => {
    const top = await folder();
    const file = path.join(top, "s1.jsonl");
    const pictures = path.join(top, "s1", "pictures");
    const transcript = new Transcript(file, pictures);
    transcript.write({ t: "start", v: 1, id: "s1", project: top, lead: "fake:a", version: "0.8.0", print: false, system: "t", tools: [] });
    const says = [own(prompted({ additionalContext: "remember the tests" }))];
    const s = await setup({ mode: "never", says, turns: [reply("ok"), reply("again")], transcript });
    await s.session.send("go");
    const r = readTranscript(file, pictures);
    if ("problem" in r) throw new Error(r.problem);
    const message = [{ type: "text", text: "go" }, hookText("UserPromptSubmit", "remember the tests")];
    expect(r.messages[0]!.parts).toEqual(message);
    expect(r.prompts).toEqual(["go"]);
    s.session.load({ id: "s1", messages: r.messages, system: r.system, transcript, prompts: r.prompts, calls: r.calls, nextPicture: r.nextPicture, nextTask: r.nextTask });
    expect(s.inputs()).toHaveLength(1);
    await s.session.send("more");
    expect(s.lead.seen[1]![0]!.parts).toEqual(message);
    expect(s.inputs().map((i) => i.prompt)).toEqual(["go", "more"]);
  });

  // Release 8b plan, Task 9 (choices 8 and 21): Stop and SubagentStop at a turn's normal end, where a block or context keeps
  // it going, up to Claude Code's 8 in a row, and SubagentStart before a subagent's first request.
  const block = (reason: string) => JSON.stringify({ decision: "block", reason });
  const feedback = (text: string) => ({ type: "text", text: `Stop hook feedback:\n${text}`, from: "hooks" });
  const NO_REASON = "The hook gave no reason; carry on with the task.";
  const kept = (reason: string) => `A Stop hook kept the turn going: ${reason}`;
  const EIGHT = "Stop hooks kept the turn going 8 times in a row; it ends here.";
  const replies = (n: number, from = 1) => Array.from({ length: n }, (_, i) => reply(`try ${from + i}`));
  const look = callTool("c1", "delegate", { description: "look", task: "find x" });

  it("keeps the turn going at a Stop hook's block, the model reading its feedback, and fires Stop with the reply's words", async () => {
    const says: Says[] = [{ event: "Stop", stdout: "", seq: [block("run the tests")] }];
    const s = await setup({ mode: "never", says, turns: [reply("done, I think"), reply("the tests pass")] });
    expect(await s.session.send("go")).toBeUndefined();
    expect(s.lead.seen).toHaveLength(2);
    expect(s.lead.seen[1]!.at(-1)!.parts).toEqual([feedback("run the tests")]);
    expect(s.notes).toEqual([kept("run the tests")]);
    const stop = { hook_event_name: "Stop", background_tasks: [], session_crons: [] };
    expect(s.inputs()).toEqual([
      expect.objectContaining({ ...stop, stop_hook_active: false, last_assistant_message: "done, I think" }),
      expect.objectContaining({ ...stop, stop_hook_active: true, last_assistant_message: "the tests pass" }),
    ]);
    expect(s.session.messages.at(-1)).toMatchObject({ role: "assistant", parts: [{ type: "text", text: "the tests pass" }] });
  });

  // The user's choice, 2026-11-09: with no reason to name, its own line, the hook's text for the model left out of it.
  it.each([
    // The user's choice, 2026-11-09: the model is told to carry on.
    ["a block with no reason", JSON.stringify({ decision: "block" }), NO_REASON],
    ["additionalContext alone", after("Stop", { additionalContext: "check the docs" }), "check the docs"],
  ])("keeps the turn going at a Stop hook's %s, saying so in its own line", async (_name, said, text) => {
    const s = await setup({ mode: "never", says: [{ event: "Stop", stdout: "", seq: [said] }], turns: [reply("done"), reply("again")] });
    await s.session.send("go");
    expect(s.lead.seen[1]!.at(-1)!.parts).toEqual([feedback(text)]);
    expect(s.notes).toEqual(["A Stop hook kept the turn going."]);
  });

  it("ends the turn once Stop hooks have kept it going 8 times in a row: nine blocks give eight more requests, then the line", async () => {
    const s = await setup({ mode: "never", says: [{ event: "Stop", stdout: block("again") }], turns: replies(9) });
    expect(await s.session.send("go")).toBeUndefined();
    expect([s.lead.seen.length, s.inputs().length]).toEqual([9, 9]);
    expect(s.notes).toEqual([...Array<string>(8).fill(kept("again")), EIGHT]);
    // The ninth block's reason is not sent: the turn ends on the model's reply.
    expect(s.session.messages.at(-1)).toMatchObject({ role: "assistant", parts: [{ type: "text", text: "try 9" }] });
  });

  it("starts the count of Stop blocks again after a reply with a tool call, stop_hook_active staying true", async () => {
    const turns = [...replies(4), callTool("c1", "shell", { command: "echo hi" }), ...replies(9, 5)];
    const s = await setup({ mode: "never", says: [{ event: "Stop", stdout: block("again") }], turns });
    await s.session.send("go");
    expect([s.lead.seen.length, s.ran]).toEqual([14, ["echo hi"]]);
    expect(s.notes).toEqual([...Array<string>(12).fill(kept("again")), EIGHT]);
    expect(s.inputs().map((i) => i.stop_hook_active)).toEqual([false, ...Array<boolean>(12).fill(true)]);
  });

  it.each([
    ["enough", "A Stop hook stopped the turn: enough"],
    [undefined, "A Stop hook stopped the turn."],
  ] as const)("ends the turn at a Stop hook's continue: false (reason %s), the answer kept and a block beside it not followed", async (reason, line) => {
    const stopping = JSON.stringify({ ...JSON.parse(stops(reason)), decision: "block", reason: "go on" });
    const s = await setup({ mode: "never", says: [{ event: "Stop", stdout: stopping }], turns: [reply("the answer")] });
    expect(await s.session.send("go")).toEqual({ stopped: reason ?? "" });
    expect([s.lead.seen.length, s.notes]).toEqual([1, [line]]);
    expect(s.session.messages.at(-1)).toMatchObject({ role: "assistant", parts: [{ type: "text", text: "the answer" }] });
  });

  it("sends Stop each background subagent still running, in background_tasks", async () => {
    const worker = new Held("fake:w"); // never answers, so the subagent is still running at Stop
    const turns = [callTool("c1", "delegate", { description: "look", task: "find x", background: true }), reply("started it")];
    const s = await setup({ mode: "never", says: [{ event: "Stop", stdout: "" }], turns, worker });
    onTestFinished(() => void s.tasks!.stop());
    await s.session.send("go");
    const running = { id: "t1", type: "agent", status: "running", description: "look", agent_type: "Explore" };
    expect(s.inputs()).toEqual([expect.objectContaining({ hook_event_name: "Stop", background_tasks: [running] })]);
  });

  it("fires SubagentStart before a subagent's first request, matched on Explore, its text at the start of the subagent's first message", async () => {
    const worker = new FakeProvider("w", [reply("found it")]);
    const says: Says[] = [
      { event: "SubagentStart", names: ["Explore"], stdout: after("SubagentStart", { additionalContext: "look in src/" }) },
      { event: "SubagentStart", names: ["Plan"], stdout: after("SubagentStart", { additionalContext: "not this one" }) },
    ];
    const s = await setup({ mode: "never", says, turns: [look, reply("ok")], worker });
    await s.session.send("go");
    expect(worker.seen[0]).toEqual([{ role: "user", parts: [hookText("SubagentStart", "look in src/"), { type: "text", text: "find x" }] }]);
    expect(s.inputs()).toEqual([expect.objectContaining({ hook_event_name: "SubagentStart", agent_id: "t1", agent_type: "Explore" })]);
    expect(s.results()).toEqual([{ output: "found it", isError: false }]);
  });

  it("keeps a subagent going at a SubagentStop hook's block, sent its own fields, its line naming it", async () => {
    const top = await folder();
    const dir = path.join(top, "sessions", "project");
    privateDir(dir);
    const file = path.join(dir, "s1.jsonl");
    const transcript = new Transcript(file, path.join(dir, "s1", "pictures"));
    transcript.write({ t: "start", v: 1, id: "s1", project: top, lead: "fake:a", version: "0.8.0", print: false, system: "t", tools: [] });
    const worker = new FakeProvider("w", [reply("first"), reply("second")]);
    const says: Says[] = [{ event: "SubagentStop", names: ["Explore"], stdout: "", seq: [block("check again")] }];
    const s = await setup({ mode: "never", says, turns: [look, reply("ok")], worker, transcript });
    expect(await s.session.send("go")).toBeUndefined();
    expect(s.results()).toEqual([{ output: "second", isError: false }]);
    expect(worker.seen[1]!.at(-1)!.parts).toEqual([feedback("check again")]);
    // A line that names the subagent already is said without the "t1: " the others start with (the user's choice, 2026-11-09).
    expect(s.notes).toEqual(["A SubagentStop hook kept t1 going: check again"]);
    const own = { hook_event_name: "SubagentStop", agent_id: "t1", agent_type: "Explore", agent_transcript_path: path.join(pathsOf(file).subagents, "t1.jsonl") };
    const inputs = s.inputs();
    expect(inputs).toEqual([
      expect.objectContaining({ ...own, stop_hook_active: false, last_assistant_message: "first" }),
      expect.objectContaining({ ...own, stop_hook_active: true, last_assistant_message: "second" }),
    ]);
    expect("background_tasks" in inputs[0]!).toBe(false); // Stop's alone
  });

  it("ends a subagent once SubagentStop hooks have kept it going 8 times in a row, with its last reply as its answer", async () => {
    const worker = new FakeProvider("w", replies(9));
    const s = await setup({ mode: "never", says: [{ event: "SubagentStop", stdout: block("again") }], turns: [look, reply("ok")], worker });
    await s.session.send("go");
    expect(s.results()).toEqual([{ output: "try 9", isError: false }]);
    const line = "SubagentStop hooks kept t1 going 8 times in a row; it ends here.";
    expect(s.notes).toEqual([...Array<string>(8).fill("A SubagentStop hook kept t1 going: again"), line]);
  });

  it.each([
    ["a block with no reason", JSON.stringify({ decision: "block" }), NO_REASON],
    ["additionalContext alone", after("SubagentStop", { additionalContext: "look again" }), "look again"],
  ])("says a SubagentStop hook's %s kept a subagent going in its own line", async (_name, said, text) => {
    const worker = new FakeProvider("w", [reply("first"), reply("second")]);
    const says: Says[] = [{ event: "SubagentStop", stdout: "", seq: [said] }];
    const s = await setup({ mode: "never", says, turns: [look, reply("ok")], worker });
    await s.session.send("go");
    expect(worker.seen[1]!.at(-1)!.parts).toEqual([feedback(text)]);
    expect(s.notes).toEqual(["A SubagentStop hook kept t1 going."]);
  });

  // The user's choice, 2026-11-09: a background subagent a hook stopped wakes the lead, as a failed one does.
  it.each([
    ["enough", "Background task t1 (look) was stopped by a hook: enough"],
    [undefined, "Background task t1 (look) was stopped by a hook."],
  ] as const)("tells the lead, waking it, when a hook stops a background subagent (reason %s)", async (reason, told) => {
    const root = await folder();
    writeFileSync(path.join(root, "a.txt"), "A\n");
    const worker = new FakeProvider("w", [callTool("w1", "read_file", { path: "a.txt" }), reply("found it")]);
    const turns = [callTool("c1", "delegate", { description: "look", task: "find x", background: true }), reply("started it")];
    const s = await setup({ mode: "never", root, says: [{ names: ["Read"], stdout: stops(reason) }], turns, worker });
    await s.session.send("go");
    expect(await s.tasks!.all[0]!.done).toEqual({ state: "stopped", text: `t1 was stopped by a hook${reason ? `: ${reason}` : "."}` });
    expect([s.tasks!.wakes(), s.tasks!.take()]).toEqual([true, [told]]);
  });

  // The user's choice, 2026-11-09: a SubagentStop stop came after the answer, which the lead gets as a finished one's, cut
  // at the same size, the stop's line after it.
  it.each([
    ["enough", "t1 was stopped by a hook: enough"],
    [undefined, "t1 was stopped by a hook."],
  ] as const)("gives the lead a background subagent's answer, then the stop's line, when a SubagentStop hook stops it (reason %s)", async (reason, line) => {
    const long = "x".repeat(MAX_TOOL_OUTPUT + 5);
    const worker = new FakeProvider("w", [reply(long)]);
    const turns = [callTool("c1", "delegate", { description: "look", task: "find x", background: true }), reply("started it")];
    const s = await setup({ mode: "never", says: [{ event: "SubagentStop", stdout: stops(reason) }], turns, worker });
    await s.session.send("go");
    expect(await s.tasks!.all[0]!.done).toEqual({ state: "stopped", text: `${long}\n${line}` });
    const told = `Background task t1 (look) finished:\n${"x".repeat(MAX_TOOL_OUTPUT)}\n[cut: 5 more characters]\n${line}`;
    expect([s.tasks!.wakes(), s.tasks!.take()]).toEqual([true, [told]]);
  });

  // Task 9's code review: a stop that comes as the Stop hooks answer, or while they run, sends nothing more.
  it("ends the turn, sending no feedback and saying no line for the block, when the user stops it as a Stop hook blocks", async () => {
    const stop = new AbortController();
    const says: Says[] = [{ event: "Stop", stdout: JSON.stringify({ decision: "block", reason: "go on", systemMessage: "checking" }) }];
    const s = await setup({ mode: "never", says, turns: [reply("done"), reply("again")] });
    s.bus.on("hook-note", (line) => void (line === "Stop hook: checking" && stop.abort())); // as Esc is pressed
    expect(await s.session.send("go", stop.signal)).toBeUndefined();
    expect([s.lead.seen.length, s.notes, s.session.messages.length]).toEqual([1, ["Stop hook: checking"], 2]);
  });

  it("ends the turn, sending nothing more, when the user stops it while a Stop hook runs", async () => {
    const root = await folder();
    const abort = new AbortController();
    const says: Says[] = [{ event: "Stop", stdout: block("go on"), go: path.join(root, "never-made") }];
    const s = await setup({ mode: "never", root, says, turns: [reply("done"), reply("again")] });
    const sent = s.session.send("go", abort.signal);
    // Up to 10 s for the hook's process to start, as for UserPromptSubmit above.
    for (let i = 0; !s.inputs().length; i++) {
      if (i === 500) throw new Error("the hook never started");
      await pause(20);
    }
    abort.abort();
    expect(await sent).toBeUndefined();
    expect([s.lead.seen.length, s.notes, s.session.messages.length, s.errors]).toEqual([1, [], 2, []]);
  });

  it("stops a subagent the user stops while its SubagentStart hook runs, sending it nothing", async () => {
    const root = await folder();
    const worker = new Held("fake:w");
    const says: Says[] = [{ event: "SubagentStart", stdout: "", go: path.join(root, "never-made") }];
    const s = await setup({ mode: "never", root, says, turns: [look, reply("ok")], worker });
    const sent = s.session.send("go");
    for (let i = 0; !s.inputs().length; i++) {
      if (i === 500) throw new Error("the hook never started");
      await pause(20);
    }
    expect(s.tasks!.stop("t1")).toBe(true);
    await sent;
    expect(s.results()).toEqual([{ output: "t1 was stopped by the user before it finished.", isError: false }]);
    expect([worker.asked.length, s.tasks!.all[0]!.messages, s.tasks!.all[0]!.state]).toEqual([0, [], "stopped"]);
  });

  // Task 7's build: a subagent a hook stops ends as stopped, with its own result, never as failed. At SubagentStop the stop
  // comes after its answer, which is kept, the stop's line after it (the user's choice, 2026-11-09).
  it.each<[Event, string | undefined, string]>([
    ["PreToolUse", "enough", "t1 was stopped by a hook: enough"],
    ["PostToolUse", undefined, "t1 was stopped by a hook."],
    ["SubagentStop", "enough", "found it\nt1 was stopped by a hook: enough"],
    ["SubagentStop", undefined, "found it\nt1 was stopped by a hook."],
  ])("stops a subagent at a %s hook's continue: false (reason %s) with its result, leaving the lead's turn going", async (event, reason, result) => {
    const root = await folder();
    writeFileSync(path.join(root, "a.txt"), "A\n");
    const worker = new FakeProvider("w", [callTool("w1", "read_file", { path: "a.txt" }), reply("found it")]);
    const says: Says[] = [{ event, names: event === "SubagentStop" ? ["Explore"] : ["Read"], stdout: stops(reason) }];
    const s = await setup({ mode: "never", root, says, turns: [look, reply("ok")], worker });
    expect(await s.session.send("go")).toBeUndefined();
    expect(s.results()).toEqual([{ output: result, isError: false }]);
    expect(s.tasks!.all.map((t) => [t.state, t.answer])).toEqual([["stopped", result]]);
    expect([s.lead.seen.length, s.errors]).toEqual([2, []]);
    expect(s.notes).toEqual([`t1: A ${event} hook stopped the turn${reason ? `: ${reason}` : "."}`]);
  });
});
