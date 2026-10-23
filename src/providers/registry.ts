import { ChatGPTAuth } from "../auth/access.js";
import { LoginStore } from "../auth/store.js";
import { dataDir } from "../core/datadir.js";
import type { Provider } from "../core/types.js";
import { AnthropicProvider, type Effort } from "./anthropic.js";
import { ChatGPTProvider } from "./chatgpt.js";
import { OpenAIProvider, PRESETS } from "./openai.js";

export function parseLead(spec: string): { kind: string; model: string } {
  const i = spec.indexOf(":"); // split at the first colon only: Ollama models look like "qwen3:8b"
  if (i <= 0 || i === spec.length - 1) throw new Error(`Expected <provider>:<model>, e.g. anthropic:claude-opus-5-5 (got "${spec}")`);
  return { kind: spec.slice(0, i), model: spec.slice(i + 1) };
}

export function createProvider(spec: string, opts: { effort?: Effort } = {}): Provider {
  const { kind, model } = parseLead(spec);
  if (kind === "anthropic") return new AnthropicProvider(model, opts.effort);
  // The plan, never an API key: `openai:` is the API key (release 2 design, "Choosing it").
  if (kind === "chatgpt") return new ChatGPTProvider(model, new ChatGPTAuth(new LoginStore(dataDir())));
  if (Object.hasOwn(PRESETS, kind)) return new OpenAIProvider(kind, model); // `in` would accept "constructor"
  throw new Error(`Unknown provider "${kind}". Known: anthropic, chatgpt, ${Object.keys(PRESETS).join(", ")}`);
}
