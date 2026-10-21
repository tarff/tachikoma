// The conversation format Tachikoma stores. No provider owns it; each adapter converts to and from it.

export type Part =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; callId: string; output: string; isError: boolean };

export type ToolCall = Extract<Part, { type: "tool_call" }>;
export type ToolResult = Extract<Part, { type: "tool_result" }>;

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
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
