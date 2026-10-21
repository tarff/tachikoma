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

export function toOpenAI(system: string, messages: Message[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{ role: "system", content: system }];
  for (const m of messages) {
    const text = m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
    if (m.role === "assistant") {
      const calls = m.parts.flatMap((p) => (p.type === "tool_call" ? [p] : []));
      out.push({
        role: "assistant",
        content: text || null,
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

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return { invalid_json: raw }; // fails the tool's schema check, so the model is told
  }
}

export function fromOpenAI(res: ChatCompletion): Turn {
  const choice = res.choices[0];
  if (!choice) throw new Error("The provider returned no reply");
  const parts: Part[] = [];
  if (choice.message.content) parts.push({ type: "text", text: choice.message.content });
  for (const c of choice.message.tool_calls ?? []) {
    if (c.type === "function") parts.push({ type: "tool_call", id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) });
  }
  const cached = res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const turn: Turn = {
    parts,
    usage: { input: (res.usage?.prompt_tokens ?? 0) - cached, output: res.usage?.completion_tokens ?? 0, cacheRead: cached, cacheWrite: 0 },
  };
  if (choice.finish_reason === "length") turn.cutOff = { kind: "max_tokens", detail: "The response hit the output limit" };
  if (choice.finish_reason === "content_filter") turn.cutOff = { kind: "refusal", detail: "The provider's content filter stopped the response" };
  return turn;
}

export class OpenAIProvider implements Provider {
  readonly id: string;
  #client: OpenAI;

  constructor(
    readonly kind: string,
    readonly model: string,
  ) {
    const preset = PRESETS[kind];
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
        { model: this.model, messages: toOpenAI(system, messages), ...(specs.length ? { tools: specs } : {}) },
        { signal },
      );
      return fromOpenAI(res);
    } catch (err) {
      if (err instanceof OpenAI.APIConnectionError) {
        throw new Error(`Could not reach ${this.#client.baseURL} (${err.message}). Check the address, your network, or that the server is running.`);
      }
      throw err;
    }
  }
}
