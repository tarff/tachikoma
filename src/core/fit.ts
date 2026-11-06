import type { CompletionRequest, Message, Provider, ToolSpec, Usage } from "./types.js";

// The size check before each request (release 8a design, "When to shorten"; plan, choices 16-19).

// A request's size in characters (choice 16): the length of JSON.stringify of what Tachikoma's own format sends, the
// system prompt, every part's text, every call's input, every result's output and the tool specs. Only the parts are
// read, so a reply's `lead`, which sent() strips and no provider sees (choice 27), never counts, and neither does
// `native`, a provider's own copy of the same turn. Pictures count 0 characters: what they add is left to Anthropic's
// exact count and, elsewhere, to the "too long" safety net (choice 18).
export function characters(system: string, messages: Message[], tools: ToolSpec[]): number {
  const parts = messages.flatMap((m) =>
    m.parts.flatMap((p) => (p.type === "text" ? [p.text] : p.type === "tool_call" ? [p.input] : p.type === "tool_result" ? [p.output] : [])),
  );
  return JSON.stringify({ system, parts, tools }).length;
}

// Each provider's tokens per character in this session, one per session (choice 17), by provider id
// ("<provider>:<model>").
export class Sizes {
  #ratios = new Map<string, number>();

  // From a lead request that succeeded (the caller's to make sure of): its reported prompt over its characters, the
  // latest replacing any earlier one. A prompt reported as 0 is no measurement, as openai.ts reports a reply without
  // usage that way, so it teaches nothing and an earlier ratio stays.
  learn(provider: string, chars: number, usage: Usage): void {
    const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
    if (prompt > 0) this.#ratios.set(provider, prompt / chars);
  }

  // The request's tokens by that ratio; null before the provider has one (after a lead switch, a resume or /clear).
  estimate(provider: string, chars: number): number | null {
    const ratio = this.#ratios.get(provider);
    return ratio === undefined ? null : chars * ratio;
  }
}

// Whether `req` fits in `limit` tokens (the window, or the /autocompact size when smaller); null when there is no way to
// tell (design, "When to shorten"). A request at exactly the limit fits and one over it does not: Anthropic refuses only
// a larger one (Task 1: "prompt is too long: 1000050 tokens > 1000000 maximum").
// False needs the estimate to say it will not fit, and on a provider that can count, the exact count to agree, so a rough
// estimate never costs a needless summary; the count runs only then, or when there is no ratio yet.
export async function fits(lead: Provider, req: CompletionRequest, sizes: Sizes, limit: number): Promise<boolean | null> {
  const estimate = sizes.estimate(lead.id, characters(req.system, req.messages, req.tools));
  if (estimate !== null && estimate <= limit) return true;
  const guess = estimate === null ? null : false; // the answer without an exact count
  if (!lead.countTokens) return guess;
  // Without `leftOut`: the count fits the pictures as complete() does, and would post the "pictures were left out" note a
  // second time (Task 9's review).
  const { leftOut: _, ...count } = req;
  try {
    return (await lead.countTokens(count)) <= limit;
  } catch (err) {
    // A stop goes through, as session.ts ends a stopped turn; any other failure (the SDK's bare connection error, say)
    // leaves the answer to the estimate, as the "too long" safety net still covers the request.
    if (req.signal?.aborted) throw err;
    return guess;
  }
}
