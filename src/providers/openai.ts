import OpenAI from "openai";
import type { ChatCompletion, ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { CompletionRequest, Message, Part, Provider, Turn } from "../core/types.js";

// Providers that accept OpenAI's chat-completions format. Base URLs checked 2026-10-22 against each
// provider's docs: OpenRouter (openrouter.ai/docs), Moonshot/Kimi global platform (platform.kimi.ai),
// Ollama's OpenAI-compatible endpoint (ollama.com blog).
export const PRESETS: Record<string, { baseURL?: string; keyEnv?: string }> = {
  openai: { keyEnv: "OPENAI_API_KEY" },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY" },
  kimi: { baseURL: "https://api.moonshot.ai/v1", keyEnv: "MOONSHOT_API_KEY" },
  ollama: { baseURL: "http://localhost:11434/v1" }, // local; needs no key
};

// Reasoning fields some providers return and need back on later turns: Kimi's `reasoning_content`
// (platform.kimi.ai/docs/guide/use-thinking-models.md, 2026-10-22: tool-call loops fail without it) and
// OpenRouter's `reasoning` / `reasoning_details`. Only these are kept, as OpenAI rejects unknown fields.
const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_details"];

export function toOpenAI(system: string, messages: Message[], kind: string): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{ role: "system", content: system }];
  for (const m of messages) {
    const text = m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
    if (m.role === "assistant") {
      const calls = m.parts.flatMap((p) => (p.type === "tool_call" ? [p] : []));
      // The SDK requires content unless there are tool calls; an empty reply (all output spent on
      // reasoning) stays in the append-only history, so sending it would fail every later request.
      if (!text && !calls.length) continue;
      out.push({
        role: "assistant",
        content: text || null,
        ...(m.native?.provider === kind ? (m.native.content as Record<string, unknown>) : {}),
        ...(calls.length
          ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.input) } })) }
          : {}),
      });
      continue;
    }
    // Tool results must directly follow the assistant message that asked for them.
    for (const p of m.parts) {
      if (p.type === "tool_result") out.push({ role: "tool", tool_call_id: p.callId, content: p.isError ? `Error: ${p.output}` : p.output });
    }
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

// Anything but a JSON object is wrapped: it fails the tool's schema check, so the model is told, and
// Anthropic rejects tool input that is not an object if the history is later sent there.
function parseArgs(raw: string): unknown {
  try {
    const v: unknown = JSON.parse(raw || "{}");
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return v;
  } catch {
    // broken JSON, wrapped below
  }
  return { invalid_json: raw };
}

export function fromOpenAI(res: ChatCompletion, kind: string): Turn {
  const choice = res.choices[0];
  if (!choice) throw new Error("The provider returned no reply");
  const parts: Part[] = [];
  // Local and Kimi models often send "\n\n" next to tool calls; Anthropic rejects whitespace-only text.
  if (choice.message.content?.trim()) parts.push({ type: "text", text: choice.message.content });
  for (const c of choice.message.tool_calls ?? []) {
    if (c.type === "function") parts.push({ type: "tool_call", id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) });
  }
  const cached = res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const turn: Turn = {
    parts,
    usage: { input: (res.usage?.prompt_tokens ?? 0) - cached, output: res.usage?.completion_tokens ?? 0, cacheRead: cached, cacheWrite: 0 },
  };
  // Not in the SDK's type, so read from the raw message; null carries nothing to send back.
  const raw = choice.message as unknown as Record<string, unknown>;
  const reasoning = Object.fromEntries(REASONING_FIELDS.flatMap((f) => (raw[f] != null ? [[f, raw[f]]] : [])));
  if (Object.keys(reasoning).length) turn.native = { provider: kind, content: reasoning };
  if (choice.finish_reason === "length") turn.cutOff = { kind: "max_tokens", detail: "The response hit the output limit" };
  if (choice.finish_reason === "content_filter") turn.cutOff = { kind: "refusal", detail: "The provider's content filter stopped the response" };
  // OpenAI can decline with the reason in `refusal`, empty content and finish_reason "stop".
  const refusal: unknown = choice.message.refusal;
  if (typeof refusal === "string" && refusal) turn.cutOff = { kind: "refusal", detail: refusal };
  return turn;
}

// Why a connection failed. The SDK's message is only "Connection error."; Node's fetch error ("fetch
// failed") holds the real reason, such as ECONNREFUSED or ENOTFOUND, further down its causes. For
// "localhost" that is an AggregateError with an empty message (one try per address), so its first
// try is used.
function connectReason(err: Error): string {
  let found = err.message;
  const seen = new Set<unknown>([err]); // a chain that loops back on itself would never end
  for (let e: unknown = err.cause; e instanceof Error && !seen.has(e); e = e.cause) {
    seen.add(e);
    if (e instanceof AggregateError && e.errors[0] instanceof Error) found = e.errors[0].message;
    else if (e.message) found = e.message;
  }
  return found;
}

export class OpenAIProvider implements Provider {
  readonly id: string;
  #client: OpenAI;

  constructor(
    readonly kind: string,
    readonly model: string,
  ) {
    // hasOwn, so inherited names such as "constructor" are not taken for presets.
    const preset = Object.hasOwn(PRESETS, kind) ? PRESETS[kind] : undefined;
    if (!preset) throw new Error(`Unknown OpenAI-format provider "${kind}"`);
    const apiKey = preset.keyEnv ? process.env[preset.keyEnv] : "ollama"; // the SDK needs some key; Ollama ignores it
    if (!apiKey) throw new Error(`Set ${preset.keyEnv} to use ${kind}`);
    this.#client = new OpenAI({ apiKey, baseURL: preset.baseURL });
    this.id = `${kind}:${model}`;
  }

  async complete({ system, messages, tools, signal }: CompletionRequest): Promise<Turn> {
    const specs: ChatCompletionTool[] = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    try {
      const res = await this.#client.chat.completions.create(
        { model: this.model, messages: toOpenAI(system, messages, this.kind), ...(specs.length ? { tools: specs } : {}) },
        { signal },
      );
      return fromOpenAI(res, this.kind);
    } catch (err) {
      // The timeout error is a subclass of the connection error, so it is checked first.
      if (err instanceof OpenAI.APIConnectionTimeoutError) {
        throw new Error(`${this.#client.baseURL} did not answer in time (${err.message}). Check your network, or that the server is running.`);
      }
      if (err instanceof OpenAI.APIConnectionError) {
        throw new Error(`Could not reach ${this.#client.baseURL} (${connectReason(err)}). Check the address, your network, or that the server is running.`);
      }
      throw err;
    }
  }
}
