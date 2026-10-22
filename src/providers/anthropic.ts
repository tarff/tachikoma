import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlock, BetaContentBlockParam, BetaMessage, BetaMessageParam, BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { type CompletionRequest, connectReason, type Message, type Part, type Provider, type Turn } from "../core/types.js";

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
  return (
    messages
      .map((m): BetaMessageParam =>
        m.role === "assistant" && m.native?.provider === "anthropic"
          ? { role: "assistant", content: m.native.content as BetaContentBlockParam[] }
          : { role: m.role, content: m.parts.map(toBlock) },
      )
      // A reply can come back empty (context full before any output), but the API rejects an empty
      // message anywhere but last, and the history is append-only, so it would fail every later request.
      // A `fallback` block alone counts as empty: it is an ignored audit marker.
      .filter((m) => m.role === "user" || (m.content as { type: string }[]).some((b) => b.type !== "fallback"))
  );
}

// After a mid-output fallback, the declined model's unfinished work before the last `fallback` block must
// not be run or echoed back: keep only its text, server-tool calls that got their result, and the markers.
function withoutDeclinedPartial(content: BetaContentBlock[]): BetaContentBlock[] {
  const boundary = content.findLastIndex((b) => b.type === "fallback");
  if (boundary < 0) return content;
  const answered = new Set(content.flatMap((b) => ("tool_use_id" in b ? [b.tool_use_id] : [])));
  return content.filter(
    (b, i) =>
      i >= boundary ||
      b.type === "text" ||
      b.type === "fallback" || // kept: the server uses it to tell thinking runs apart on replay
      "tool_use_id" in b ||
      ((b.type === "server_tool_use" || b.type === "mcp_tool_use") && answered.has(b.id)),
  );
}

export function fromAnthropic(msg: BetaMessage): Turn {
  const content = withoutDeclinedPartial(msg.content);
  const parts: Part[] = [];
  const fallbacks: { from: string; to: string }[] = [];
  for (const b of content) {
    if (b.type === "text") parts.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") parts.push({ type: "tool_call", id: b.id, name: b.name, input: b.input });
    else if (b.type === "fallback") fallbacks.push({ from: b.from.model, to: b.to.model });
  }
  // Covers only the attempt that produced this message; each declined attempt is counted below.
  const u = msg.usage;
  const turn: Turn = {
    parts,
    native: { provider: "anthropic", content },
    usage: { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 },
  };
  // Blocks mark where this turn switched models (for the notice); sticky turns, served by the fallback
  // model with no switch, carry none, so who answered comes from usage.iterations and `model`.
  if (fallbacks.length) turn.fallbacks = fallbacks;
  const iterations = u.iterations ?? [];
  if (iterations.some((it) => it.type === "fallback_message")) {
    turn.servedBy = `anthropic:${msg.model}`;
    // Each model that declined first has a `message` entry (we use no server tools, which add more). From
    // platform.claude.com/docs/en/build-with-claude/refusals-and-fallback, "Billing and rate limits"
    // (2026-10-22): a decline after some output is billed at that model's rates; one before any output
    // only in some refusal categories, which the entry does not name, so its price is unknown.
    const declined = iterations.flatMap((it) =>
      it.type === "message"
        ? [
            {
              provider: `anthropic:${it.model ?? "unknown"}`,
              usage: { input: it.input_tokens, output: it.output_tokens, cacheRead: it.cache_read_input_tokens, cacheWrite: it.cache_creation_input_tokens },
              priceKnown: it.output_tokens > 0,
            },
          ]
        : [],
    );
    if (declined.length) turn.declined = declined;
  }
  if (msg.stop_reason === "max_tokens") turn.cutOff = { kind: "max_tokens", detail: "The response hit the output limit" };
  if (msg.stop_reason === "model_context_window_exceeded") turn.cutOff = { kind: "max_tokens", detail: "The conversation filled the context window" };
  if (msg.stop_reason === "refusal") turn.cutOff = { kind: "refusal", detail: `The model declined (category: ${msg.stop_details?.category ?? "none given"})` };
  return turn;
}

export class AnthropicProvider implements Provider {
  readonly id: string;
  #client: Anthropic;
  #window?: number | null;

  constructor(
    readonly model: string,
    private readonly effort?: Effort,
  ) {
    // An API key only. Left to itself the SDK also signs in with ANTHROPIC_AUTH_TOKEN or a stored login
    // profile, either of which can carry a subscription token, which the design rules out.
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("Set ANTHROPIC_API_KEY to use anthropic");
    this.#client = new Anthropic({ apiKey, authToken: null });
    this.id = `anthropic:${model}`;
  }

  async complete(req: CompletionRequest): Promise<Turn> {
    try {
      return await this.#complete(req);
    } catch (err) {
      // The timeout error is a subclass of the connection error, so it is checked first.
      if (err instanceof Anthropic.APIConnectionTimeoutError) {
        throw new Error(`${this.#client.baseURL} did not answer in time (${err.message}). Check your network.`);
      }
      if (err instanceof Anthropic.APIConnectionError) {
        throw new Error(`Could not reach ${this.#client.baseURL} (${connectReason(err)}). Check your network.`);
      }
      throw err;
    }
  }

  async #complete({ system, messages, tools, signal }: CompletionRequest): Promise<Turn> {
    const stream = this.#client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: MAX_TOKENS,
        system,
        // No eager_input_streaming: only finalMessage() is read, so streaming tool input early gains
        // nothing here, and it would move input validation from the API to us (claude-api skill, tool-use-concepts.md).
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

  // Only a successful lookup is kept; a failed one (offline, say) is tried again next time.
  async contextWindow(): Promise<number | null> {
    if (this.#window === undefined) {
      try {
        this.#window = (await this.#client.models.retrieve(this.model)).max_input_tokens;
      } catch {
        return null;
      }
    }
    return this.#window;
  }
}
