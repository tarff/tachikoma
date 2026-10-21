import type { Tool, ToolContext } from "../tools/tool.js";
import type { Bus } from "./bus.js";
import { Declined } from "./permissions.js";
import { errorText, type Message, type Provider, type ToolCall, type ToolResult, type Turn } from "./types.js";

// Claude Code's Bash tool cuts output at 30,000 characters. We start from the same cap until our
// own error log and transcripts show whether it should move.
export const MAX_TOOL_OUTPUT = 30_000;

function truncate(s: string): string {
  return s.length <= MAX_TOOL_OUTPUT ? s : `${s.slice(0, MAX_TOOL_OUTPUT)}\n[cut: ${s.length - MAX_TOOL_OUTPUT} more characters]`;
}

export interface SessionOptions {
  lead: Provider;
  fallback?: Provider; // retries a turn the lead refused; chosen by the user, never by default
  tools: Tool[];
  system: string; // fixed for the whole session: prompt caching and Anthropic thinking blocks need it unchanged
  ctx: Omit<ToolContext, "signal">;
  bus: Bus;
}

export class Session {
  // Append-only. Earlier messages are never edited, for the same reason the system prompt is fixed.
  readonly messages: Message[] = [];
  #lead: Provider;

  constructor(private readonly opts: SessionOptions) {
    this.#lead = opts.lead;
  }

  get lead(): Provider {
    return this.#lead;
  }

  setLead(provider: Provider): void {
    this.#lead = provider;
    this.opts.bus.emit("lead", provider.id);
  }

  async send(text: string, signal?: AbortSignal): Promise<void> {
    const { bus } = this.opts;
    this.#push({ role: "user", parts: [{ type: "text", text }] });

    for (;;) {
      const lead = this.#lead;
      let answeredBy = lead;
      let turn = await this.#request(lead, signal);
      if (!turn) return;
      for (const f of turn.fallbacks ?? []) {
        bus.emit("error", { kind: "fallback", attempted: `response from ${lead.id}`, message: `${f.from} declined; ${f.to} answered instead (Anthropic's fallback)`, lead: lead.id });
      }
      const rescue = this.opts.fallback;
      if (turn.cutOff?.kind === "refusal" && rescue) {
        // The refused reply is discarded, never stored, so the history stays append-only.
        bus.emit("error", { kind: "refusal", attempted: `response from ${lead.id}`, message: turn.cutOff.detail, lead: lead.id });
        answeredBy = rescue;
        turn = await this.#request(rescue, signal);
        if (!turn) return;
        if (!turn.cutOff) bus.emit("error", { kind: "fallback", attempted: `response from ${lead.id}`, message: `${lead.id} declined; ${rescue.id} answered instead`, lead: lead.id });
      }
      this.#push({ role: "assistant", parts: turn.parts, native: turn.native });

      const calls = turn.parts.filter((p) => p.type === "tool_call");
      if (turn.cutOff) {
        bus.emit("error", { kind: turn.cutOff.kind, attempted: `response from ${answeredBy.id}`, message: turn.cutOff.detail, lead: lead.id });
        // Every tool call needs a result before the next request, even ones we refuse to run.
        if (calls.length) {
          this.#push({ role: "user", parts: calls.map((c) => result(c, `Not run: the response was cut off (${turn.cutOff!.detail}).`, true)) });
        }
        return;
      }
      if (calls.length === 0) return;

      const results: ToolResult[] = [];
      for (const call of calls) results.push(await this.#runTool(call, signal));
      this.#push({ role: "user", parts: results });
      if (signal?.aborted) return;
    }
  }

  // One request. Its usage is reported even if the reply is then discarded, because it is billed.
  async #request(provider: Provider, signal?: AbortSignal): Promise<Turn | undefined> {
    const { bus, tools, system } = this.opts;
    try {
      const turn = await provider.complete({ system, messages: this.messages, tools: tools.map((t) => t.spec), signal });
      bus.emit("usage", { provider: turn.servedBy ?? provider.id, usage: turn.usage });
      return turn;
    } catch (err) {
      if (!signal?.aborted) bus.emit("error", { kind: "provider", attempted: `request to ${provider.id}`, message: errorText(err), lead: this.#lead.id });
      return undefined;
    }
  }

  async #runTool(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    if (signal?.aborted) return result(call, "Cancelled by the user.", true);
    const fail = (message: string) => {
      this.opts.bus.emit("error", { kind: "tool", attempted: `${call.name} ${JSON.stringify(call.input)}`, message, lead: this.#lead.id });
      return result(call, message, true);
    };
    const tool = this.opts.tools.find((t) => t.spec.name === call.name);
    if (!tool) return fail(`Unknown tool: ${call.name}`);
    try {
      return result(call, truncate(await tool.run(call.input, { ...this.opts.ctx, signal })), false);
    } catch (err) {
      if (err instanceof Declined) return result(call, err.message, true);
      if (signal?.aborted) return result(call, "Cancelled by the user.", true); // not a failure, so not logged
      return fail(truncate(errorText(err)));
    }
  }

  #push(message: Message): void {
    this.messages.push(message);
    this.opts.bus.emit("message", message);
  }
}

function result(call: ToolCall, output: string, isError: boolean): ToolResult {
  return { type: "tool_result", callId: call.id, output, isError };
}
