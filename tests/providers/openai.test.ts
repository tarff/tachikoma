import OpenAI from "openai";
import type { ChatCompletion } from "openai/resources/chat/completions";
import { Completions } from "openai/resources/chat/completions";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../src/core/types.js";
import { fromOpenAI, OpenAIProvider, toOpenAI } from "../../src/providers/openai.js";

function completion(message: Record<string, unknown>, finish_reason = "stop", usage?: Record<string, unknown>): ChatCompletion {
  return {
    id: "c1",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [{ index: 0, finish_reason, logprobs: null, message: { role: "assistant", refusal: null, ...message } }],
    usage: usage ?? { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  } as unknown as ChatCompletion;
}

describe("toOpenAI", () => {
  it("puts the system prompt first and tool results right after the call", () => {
    const history: Message[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      { role: "assistant", parts: [{ type: "text", text: "looking" }, { type: "tool_call", id: "c1", name: "read_file", input: { path: "a" } }] },
      { role: "user", parts: [{ type: "tool_result", callId: "c1", output: "nope", isError: true }, { type: "text", text: "and?" }] },
    ];
    expect(toOpenAI("sys", history, "openai")).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "looking", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "Error: nope" },
      { role: "user", content: "and?" },
    ]);
  });

  it("converts Anthropic turns too, ignoring their native content", () => {
    const history: Message[] = [{ role: "assistant", parts: [{ type: "text", text: "hi" }], native: { provider: "anthropic", content: [] } }];
    expect(toOpenAI("s", history, "openai")[1]).toEqual({ role: "assistant", content: "hi" });
  });

  it("leaves out assistant messages with neither text nor tool calls", () => {
    const history: Message[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      { role: "assistant", parts: [] },
      { role: "user", parts: [{ type: "text", text: "again" }] },
    ];
    expect(toOpenAI("s", history, "openai")).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
      { role: "user", content: "again" },
    ]);
  });
});

describe("fromOpenAI", () => {
  it("parses tool calls and splits out cached tokens", () => {
    const turn = fromOpenAI(
      completion(
        { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] },
        "tool_calls",
        { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } },
      ),
      "openai",
    );
    expect(turn.parts).toEqual([{ type: "tool_call", id: "c1", name: "read_file", input: { path: "a" } }]);
    expect(turn.usage).toEqual({ input: 60, output: 20, cacheRead: 40, cacheWrite: 0 });
    expect(turn.native).toBeUndefined();
  });

  it("passes broken tool arguments on so the schema check rejects them", () => {
    const turn = fromOpenAI(completion({ content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{oops" } }] }), "openai");
    expect(turn.parts[0]).toMatchObject({ input: { invalid_json: "{oops" } });
  });

  it("reports hitting the output limit and content filtering", () => {
    expect(fromOpenAI(completion({ content: "par" }, "length"), "openai").cutOff?.kind).toBe("max_tokens");
    expect(fromOpenAI(completion({ content: "" }, "content_filter"), "openai").cutOff?.kind).toBe("refusal");
  });

  it("reports a refusal given in message.refusal", () => {
    const turn = fromOpenAI(completion({ content: null, refusal: "I can't help with that." }), "openai");
    expect(turn.cutOff).toEqual({ kind: "refusal", detail: "I can't help with that." });
  });
});

describe("reasoning fields", () => {
  const call = { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } };

  it("keeps Kimi's reasoning_content and replays it only to Kimi", () => {
    const turn = fromOpenAI(completion({ content: null, reasoning_content: "think first", tool_calls: [call] }, "tool_calls"), "kimi");
    expect(turn.native).toEqual({ provider: "kimi", content: { reasoning_content: "think first" } });

    const history: Message[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      { role: "assistant", parts: turn.parts, ...(turn.native ? { native: turn.native } : {}) },
      { role: "user", parts: [{ type: "tool_result", callId: "c1", output: "ok", isError: false }] },
    ];
    expect(toOpenAI("s", history, "kimi")[2]).toEqual({
      role: "assistant",
      content: null,
      reasoning_content: "think first",
      tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }],
    });
    expect(toOpenAI("s", history, "openai")[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }],
    });
  });

  it("keeps OpenRouter's reasoning and reasoning_details and nothing else from the raw message", () => {
    const details = [{ type: "reasoning.encrypted", data: "abc" }];
    const turn = fromOpenAI(
      completion({ content: "hi", reasoning: "hmm", reasoning_details: details, annotations: [], audio: null }),
      "openrouter",
    );
    expect(turn.native).toEqual({ provider: "openrouter", content: { reasoning: "hmm", reasoning_details: details } });
  });
});

describe("OpenAIProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects names every object inherits", () => {
    expect(() => new OpenAIProvider("constructor", "m")).toThrow('Unknown OpenAI-format provider "constructor"');
    expect(() => new OpenAIProvider("toString", "m")).toThrow('Unknown OpenAI-format provider "toString"');
  });

  it("reports a timeout as a timeout", async () => {
    vi.spyOn(Completions.prototype, "create").mockRejectedValue(new OpenAI.APIConnectionTimeoutError());
    const p = new OpenAIProvider("ollama", "m");
    await expect(p.complete({ system: "s", messages: [], tools: [] })).rejects.toThrow("http://localhost:11434/v1 did not answer in time");
  });

  it("names the underlying reason a connection failed", async () => {
    // Node's fetch throws "fetch failed" and puts the real reason in its own cause.
    const fetchErr = new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:11434") });
    vi.spyOn(Completions.prototype, "create").mockRejectedValue(new OpenAI.APIConnectionError({ cause: fetchErr }));
    const p = new OpenAIProvider("ollama", "m");
    await expect(p.complete({ system: "s", messages: [], tools: [] })).rejects.toThrow(
      "Could not reach http://localhost:11434/v1 (connect ECONNREFUSED 127.0.0.1:11434)",
    );
  });

  it("stops walking a chain of causes that loops back on itself", async () => {
    const a = new Error("connect ECONNREFUSED 127.0.0.1:11434");
    const b = new TypeError("fetch failed", { cause: a });
    a.cause = b;
    vi.spyOn(Completions.prototype, "create").mockRejectedValue(new OpenAI.APIConnectionError({ cause: b }));
    const p = new OpenAIProvider("ollama", "m");
    await expect(p.complete({ system: "s", messages: [], tools: [] })).rejects.toThrow("Could not reach http://localhost:11434/v1");
  }, 5_000);

  it("names the reason when it is wrapped in an AggregateError with no message", async () => {
    // What Node 24 throws on Windows for "localhost": one try per address, grouped, with an empty message.
    const tries = [new Error("connect ECONNREFUSED ::1:11434"), new Error("connect ECONNREFUSED 127.0.0.1:11434")];
    const fetchErr = new TypeError("fetch failed", { cause: new AggregateError(tries, "") });
    vi.spyOn(Completions.prototype, "create").mockRejectedValue(new OpenAI.APIConnectionError({ cause: fetchErr }));
    const p = new OpenAIProvider("ollama", "m");
    await expect(p.complete({ system: "s", messages: [], tools: [] })).rejects.toThrow(
      "Could not reach http://localhost:11434/v1 (connect ECONNREFUSED ::1:11434)",
    );
  });
});
