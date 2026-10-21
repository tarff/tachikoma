import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlockParam, BetaMessage, BetaMessageParam, BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { CompletionRequest, Message, Part, Provider, Turn } from "../core/types.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

// From the claude-api skill (2026-10-22): these models accept the server-side `fallbacks: "default"`
// option, which re-runs a refused request on Anthropic's recommended fallback model.
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
// The claude-api skill's default max_tokens for streamed requests.
const MAX_TOKENS = 64_000;

// Tool-call ids from other providers may hold characters Anthropic rejects.
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");

function toBlock(p: Part): BetaContentBlockParam {
  switch (p.type) {
    case "text":
      return { type: "text", text: p.text };
    case "tool_call":
      return { type: "tool_use", id: safeId(p.id), name: p.name, input: p.input };
    case "tool_result":
      return { type: "tool_result", tool_use_id: safeId(p.callId), content: p.output, is_error: p.isError };
  }
}

export function toAnthropic(messages: Message[]): BetaMessageParam[] {
  return messages.map((m) =>
    m.role === "assistant" && m.native?.provider === "anthropic"
      ? { role: "assistant", content: m.native.content as BetaContentBlockParam[] }
      : { role: m.role, content: m.parts.map(toBlock) },
  );
}

export function fromAnthropic(msg: BetaMessage): Turn {
  const parts: Part[] = [];
  const fallbacks: { from: string; to: string }[] = [];
  for (const b of msg.content) {
    if (b.type === "text") parts.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") parts.push({ type: "tool_call", id: b.id, name: b.name, input: b.input });
    else if (b.type === "fallback") fallbacks.push({ from: b.from.model, to: b.to.model });
  }
  const u = msg.usage;
  const turn: Turn = {
    parts,
    native: { provider: "anthropic", content: msg.content },
    usage: { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 },
  };
  if (fallbacks.length) {
    turn.fallbacks = fallbacks;
    turn.servedBy = `anthropic:${fallbacks.at(-1)!.to}`;
  }
  if (msg.stop_reason === "max_tokens") turn.cutOff = { kind: "max_tokens", detail: "The response hit the output limit" };
  if (msg.stop_reason === "model_context_window_exceeded") turn.cutOff = { kind: "max_tokens", detail: "The conversation filled the context window" };
  if (msg.stop_reason === "refusal") turn.cutOff = { kind: "refusal", detail: `The model declined (category: ${msg.stop_details?.category ?? "none given"})` };
  return turn;
}

export class AnthropicProvider implements Provider {
  readonly id: string;
  #client = new Anthropic(); // credentials from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile
  #window?: Promise<number | null>;

  constructor(
    readonly model: string,
    private readonly effort?: Effort,
  ) {
    this.id = `anthropic:${model}`;
  }

  async complete({ system, messages, tools, signal }: CompletionRequest): Promise<Turn> {
    const stream = this.#client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: MAX_TOKENS,
        system,
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as BetaTool["input_schema"] })),
        messages: toAnthropic(messages),
        cache_control: { type: "ephemeral" },
        ...(this.effort ? { output_config: { effort: this.effort } } : {}),
        ...(FALLBACK_MODELS.has(this.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      },
      { signal },
    );
    return fromAnthropic(await stream.finalMessage());
  }

  contextWindow(): Promise<number | null> {
    this.#window ??= this.#client.models.retrieve(this.model).then(
      (m) => m.max_input_tokens,
      () => null,
    );
    return this.#window;
  }
}
