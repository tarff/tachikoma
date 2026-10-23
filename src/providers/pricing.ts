import type { Usage } from "../core/types.js";

export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// USD per million tokens, copied 2026-10-22 from the claude-api skill: input, output and cache reads
// from each model's notes in shared/models.md, cache writes 1.25x input for the 5-minute cache
// (shared/prompt-caching.md, "Economics"). Claude Haiku 5.5 is left out because its price changes
// above 100K-token prompts.
// A model missing here shows its cost as "?"; we never guess a price.
export const PRICES: Record<string, Rates> = {
  "anthropic:claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "anthropic:claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "anthropic:claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};

export function cost(provider: string, u: Usage): number | null {
  if (provider.startsWith("ollama:")) return 0; // runs locally
  if (provider.startsWith("chatgpt:")) return 0; // billed to the ChatGPT plan, not per token
  const r = PRICES[provider];
  if (!r) return null;
  return (u.input * r.input + u.output * r.output + u.cacheRead * r.cacheRead + u.cacheWrite * r.cacheWrite) / 1_000_000;
}
