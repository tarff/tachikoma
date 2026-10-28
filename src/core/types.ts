import type { Effort } from "../providers/anthropic.js";

// The conversation format Tachikoma stores. No provider owns it; each adapter converts to and from it.

export type Part =
  // `from: "tasks"`: text the session added for the lead, such as a background subagent's answer, not
  // something the user typed.
  | { type: "text"; text: string; from?: "tasks" }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; callId: string; output: string; isError: boolean }
  // A picture the user added, the original as read, kept in memory for the session (release 6 plan, choice 9); `id` is
  // its number, the N of its marker `[Image #N]` (release 6 design, "Pictures").
  | { type: "image"; id: number; mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: Buffer };

export type ToolCall = Extract<Part, { type: "tool_call" }>;
export type ToolResult = Extract<Part, { type: "tool_result" }>;
export type Image = Extract<Part, { type: "image" }>;
export type Picture = Pick<Image, "mediaType" | "data">;

// A picture's marker, in the prompt and before the picture in each request (release 6 design, "Pictures").
export const marker = (id: number) => `[Image #${id}]`;

// The pictures of one request, by number, as that request sends them: shrunk to its provider's limits, or a note's
// text in a left-out picture's place (release 6 design, "What is sent, request by request"). A picture not in the map
// goes as it was read.
export type Prepared = ReadonlyMap<number, Picture | string>;

export interface Message {
  role: "user" | "assistant";
  parts: Part[];
  // The provider's own content for this turn, replayed unchanged when the same kind of provider leads
  // again. Anthropic needs this: thinking blocks must come back byte-identical.
  native?: { provider: string; content: unknown };
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Token counts for one request. `input` excludes tokens read from or written to the prompt cache.
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Turn {
  parts: Part[];
  native?: Message["native"];
  usage: Usage;
  // Set when the model stopped before finishing: output limit, context limit or refusal.
  cutOff?: { kind: "max_tokens" | "refusal"; detail: string };
  // Set when the provider itself handed the request to another model (Anthropic's fallback).
  fallbacks?: { from: string; to: string }[];
  servedBy?: string; // "<provider>:<model>" that actually answered, when not the one asked
  // Attempts by models that declined before this reply, each with its own usage; `usage` above covers
  // only the attempt that answered. `priceKnown` is false when whether it was billed is not known.
  declined?: { provider: string; usage: Usage; priceKnown: boolean }[];
}

export interface CompletionRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  signal?: AbortSignal;
}

export interface Provider {
  readonly id: string; // "<provider>:<model>", e.g. "anthropic:claude-opus-5-5"
  complete(req: CompletionRequest): Promise<Turn>;
  contextWindow?(): Promise<number | null>;
  setEffort?(effort: Effort | undefined): void; // Anthropic's only, as --effort is
}

// A provider's failure with the HTTP status it came with, so the session can tell a refused request (400) apart without
// reading the provider's words (release 6 plan, choice 10). The SDKs' own `APIError` carries `status` the same way.
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Why a connection failed, for both SDKs. Their message is only "Connection error."; Node's fetch
// error ("fetch failed") holds the real reason, such as ECONNREFUSED or ENOTFOUND, further down its
// causes. For "localhost" that is an AggregateError with an empty message (one try per address), so
// its first try is used.
export function connectReason(err: Error): string {
  let found = err.message;
  const seen = new Set<unknown>([err]); // a chain that loops back on itself would never end
  for (let e: unknown = err.cause; e instanceof Error && !seen.has(e); e = e.cause) {
    seen.add(e);
    if (e instanceof AggregateError && e.errors[0] instanceof Error) found = e.errors[0].message;
    else if (e.message) found = e.message;
  }
  return found;
}
