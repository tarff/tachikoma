import { PRICES } from "./pricing.js";
import { parseLead } from "./registry.js";

// What a lead switch is described by, written once for PreModelSwitch and PostModelSwitch alike (release 8e plan, step
// 12; design, "Switching the lead model"; Q20). Plain functions, handed what they need: none reads the window's state.

export type SwitchSource = "command" | "picker" | "resume";
// When the lead's last conversation request got its reply, and which lead that was (Session.lastReply).
export interface LastReply {
  lead: string;
  at: number;
}

// The design's "under 5 minutes": the 5-minute cache, the only one Tachikoma asks for.
const WARM_MS = 5 * 60_000;

// A model's name without its provider, split at the first colon as parseLead splits it, so "ollama:qwen3:8b" is "qwen3:8b".
export const modelName = (id: string): string => parseLead(id).model;

// The name a switch hook's matcher is tried on (Q12): an `anthropic` model's name with a final -YYYYMMDD dropped; none for
// any other provider's model, an Anthropic model reached through another provider included. For matching only: it never
// decides whether two models are the same.
export function canonicalName(id: string): string | undefined {
  const { kind, model } = parseLead(id);
  return kind === "anthropic" ? model.replace(/-\d{8}$/, "") : undefined;
}

// The fields both switch events are sent, from the provider ids of the lead before and after. `requested`: the words
// typed or the settings file's value, null for a pick from the list and for "resume" whatever is handed in.
// `contextTokens`: the status line's context number, handed in by the caller (Q10). Warm when the lead before is an
// `anthropic` model whose own last conversation request got its reply under 5 minutes ago (Q11). The cache write is
// priced at the new model's cache-write price per million tokens, from the price list; null, with no `pricing`, when
// the list has no price for it.
export function switchFields(s: {
  from: string;
  to: string;
  source: SwitchSource;
  requested: string | null;
  contextTokens: number;
  lastReply: LastReply | undefined;
}) {
  const rates = PRICES[s.to];
  const last = s.lastReply;
  // How long ago the reply came: below 0 when the clock was set back since, which is never warm (step 12's review).
  const ago = last ? Date.now() - last.at : -1;
  return {
    from_model: modelName(s.from),
    to_model: modelName(s.to),
    requested_model: s.source === "command" ? s.requested : null,
    source: s.source,
    context_tokens: s.contextTokens,
    prompt_cache_warm: parseLead(s.from).kind === "anthropic" && last?.lead === s.from && ago >= 0 && ago < WARM_MS,
    cache_ttl: "5m" as const,
    estimated_cache_write_usd: rates ? (s.contextTokens * rates.cacheWrite) / 1_000_000 : null,
    ...(rates && { pricing: "catalog" as const }),
  };
}
