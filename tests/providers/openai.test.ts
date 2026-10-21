import type { ChatCompletion } from "openai/resources/chat/completions";
import { describe, expect, it } from "vitest";
import type { Message } from "../../src/core/types.js";
import { fromOpenAI, toOpenAI } from "../../src/providers/openai.js";

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
    expect(toOpenAI("sys", history)).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "looking", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "Error: nope" },
      { role: "user", content: "and?" },
    ]);
  });

  it("converts Anthropic turns too, ignoring their native content", () => {
    const history: Message[] = [{ role: "assistant", parts: [{ type: "text", text: "hi" }], native: { provider: "anthropic", content: [] } }];
    expect(toOpenAI("s", history)[1]).toEqual({ role: "assistant", content: "hi" });
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
    );
    expect(turn.parts).toEqual([{ type: "tool_call", id: "c1", name: "read_file", input: { path: "a" } }]);
    expect(turn.usage).toEqual({ input: 60, output: 20, cacheRead: 40, cacheWrite: 0 });
  });

  it("passes broken tool arguments on so the schema check rejects them", () => {
    const turn = fromOpenAI(completion({ content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{oops" } }] }));
    expect(turn.parts[0]).toMatchObject({ input: { invalid_json: "{oops" } });
  });

  it("reports hitting the output limit and content filtering", () => {
    expect(fromOpenAI(completion({ content: "par" }, "length")).cutOff?.kind).toBe("max_tokens");
    expect(fromOpenAI(completion({ content: "" }, "content_filter")).cutOff?.kind).toBe("refusal");
  });
});
