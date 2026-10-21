import type { Provider } from "../core/types.js";
import { AnthropicProvider, type Effort } from "./anthropic.js";
import { OpenAIProvider, PRESETS } from "./openai.js";

export function parseLead(spec: string): { kind: string; model: string } {
  const i = spec.indexOf(":"); // split at the first colon only: Ollama models look like "qwen3:8b"
  if (i <= 0 || i === spec.length - 1) throw new Error(`Expected <provider>:<model>, e.g. anthropic:claude-opus-5-5 (got "${spec}")`);
  return { kind: spec.slice(0, i), model: spec.slice(i + 1) };
}

export function createProvider(spec: string, opts: { effort?: Effort } = {}): Provider {
  const { kind, model } = parseLead(spec);
  if (kind === "anthropic") return new AnthropicProvider(model, opts.effort);
  if (kind in PRESETS) return new OpenAIProvider(kind, model);
  throw new Error(`Unknown provider "${kind}". Known: anthropic, ${Object.keys(PRESETS).join(", ")}`);
}
