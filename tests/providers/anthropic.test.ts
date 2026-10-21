import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { Models } from "@anthropic-ai/sdk/resources/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../src/core/types.js";
import { AnthropicProvider, fromAnthropic, toAnthropic } from "../../src/providers/anthropic.js";

// Shaped like a real response; only the fields the adapter reads are filled in.
function message(fields: Partial<BetaMessage>): BetaMessage {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [],
    stop_reason: "end_turn",
    stop_details: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
    ...fields,
  } as unknown as BetaMessage;
}

describe("toAnthropic", () => {
  it("converts text, tool calls and tool results", () => {
    const history: Message[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "call:1", name: "read_file", input: { path: "a" } }] },
      { role: "user", parts: [{ type: "tool_result", callId: "call:1", output: "boom", isError: true }] },
    ];
    expect(toAnthropic(history)).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "boom", is_error: true }] },
    ]);
  });

  it("replays Anthropic's own content unchanged, thinking blocks included", () => {
    const native = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "hi" }];
    const history: Message[] = [{ role: "assistant", parts: [{ type: "text", text: "hi" }], native: { provider: "anthropic", content: native } }];
    expect(toAnthropic(history)[0]!.content).toBe(native);
  });

  it("leaves out an assistant message with nothing in it, which the API would reject", () => {
    const history: Message[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      { role: "assistant", parts: [], native: { provider: "anthropic", content: [] } },
      { role: "assistant", parts: [] },
      { role: "user", parts: [{ type: "text", text: "again" }] },
    ];
    expect(toAnthropic(history).map((m) => m.role)).toEqual(["user", "user"]);
  });
});

describe("fromAnthropic", () => {
  it("keeps text and tool calls, and counts cached tokens apart", () => {
    const turn = fromAnthropic(
      message({
        content: [
          { type: "thinking", thinking: "", signature: "s" },
          { type: "text", text: "reading", citations: null },
          { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a" } },
        ] as BetaMessage["content"],
        stop_reason: "tool_use",
      }),
    );
    expect(turn.parts).toEqual([
      { type: "text", text: "reading" },
      { type: "tool_call", id: "tu_1", name: "read_file", input: { path: "a" } },
    ]);
    expect(turn.usage).toEqual({ input: 100, output: 20, cacheRead: 50, cacheWrite: 10 });
    expect(turn.native?.provider).toBe("anthropic");
    expect(turn.cutOff).toBeUndefined();
  });

  it("records when Anthropic's fallback model answered", () => {
    const turn = fromAnthropic(
      message({
        model: "claude-opus-4-8",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          iterations: [
            { type: "message", model: "claude-opus-5-5", input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
            { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
          ],
        } as unknown as BetaMessage["usage"],
        content: [
          { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" }, trigger: { type: "refusal" } },
          { type: "text", text: "hi", citations: null },
        ] as unknown as BetaMessage["content"],
      }),
    );
    expect(turn.fallbacks).toEqual([{ from: "claude-opus-5-5", to: "claude-opus-4-8" }]);
    expect(turn.servedBy).toBe("anthropic:claude-opus-4-8");
    expect(turn.parts).toEqual([{ type: "text", text: "hi" }]);
  });

  it("names the fallback model on a sticky turn, which carries no fallback block", () => {
    const turn = fromAnthropic(
      message({
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "hi", citations: null }] as BetaMessage["content"],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          iterations: [{ type: "fallback_message", model: "claude-opus-4-8", input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null }],
        } as unknown as BetaMessage["usage"],
      }),
    );
    expect(turn.servedBy).toBe("anthropic:claude-opus-4-8");
    expect(turn.fallbacks).toBeUndefined();
  });

  it("drops the declined model's unfinished tool calls and thinking, keeping its text", () => {
    const turn = fromAnthropic(
      message({
        model: "claude-opus-4-8",
        content: [
          { type: "thinking", thinking: "", signature: "s" },
          { type: "text", text: "let me look", citations: null },
          { type: "tool_use", id: "tu_1", name: "shell", input: { command: "rm" } },
          { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" }, trigger: { type: "refusal" } },
          { type: "tool_use", id: "tu_2", name: "read_file", input: { path: "a" } },
        ] as unknown as BetaMessage["content"],
        stop_reason: "tool_use",
      }),
    );
    expect(turn.parts).toEqual([
      { type: "text", text: "let me look" },
      { type: "tool_call", id: "tu_2", name: "read_file", input: { path: "a" } },
    ]);
    expect((turn.native!.content as { type: string }[]).map((b) => b.type)).toEqual(["text", "fallback", "tool_use"]);
    expect(JSON.stringify(turn.native!.content)).not.toContain("tu_1");
  });

  it("reports refusals and hitting a limit", () => {
    const refused = fromAnthropic(message({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } as BetaMessage["stop_details"] }));
    expect(refused.cutOff).toEqual({ kind: "refusal", detail: "The model declined (category: cyber)" });
    expect(fromAnthropic(message({ stop_reason: "max_tokens" })).cutOff?.kind).toBe("max_tokens");
    expect(fromAnthropic(message({ stop_reason: "model_context_window_exceeded" })).cutOff?.kind).toBe("max_tokens");
  });
});

describe("AnthropicProvider.contextWindow", () => {
  afterEach(() => vi.restoreAllMocks());

  it("asks again after a failed lookup, and remembers a successful one", async () => {
    const retrieve = vi
      .spyOn(Models.prototype, "retrieve")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ max_input_tokens: 1_000 } as never);
    const provider = new AnthropicProvider("claude-opus-5-5");
    expect(await provider.contextWindow()).toBeNull();
    expect(await provider.contextWindow()).toBe(1_000);
    expect(await provider.contextWindow()).toBe(1_000);
    expect(retrieve).toHaveBeenCalledTimes(2);
  });
});
