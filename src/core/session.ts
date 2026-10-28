import { MAX_TOOL_OUTPUT } from "../exec/executor.js";
import type { Tool, ToolContext } from "../tools/tool.js";
import type { Bus, ToolOutcome } from "./bus.js";
import { Declined } from "./permissions.js";
import { errorText, type Message, type Part, type Provider, type ToolCall, type ToolResult, type Turn } from "./types.js";

export function truncate(s: string): string {
  return s.length <= MAX_TOOL_OUTPUT ? s : `${s.slice(0, MAX_TOOL_OUTPUT)}\n[cut: ${s.length - MAX_TOOL_OUTPUT} more characters]`;
}

export interface SessionOptions {
  lead: Provider;
  fallback?: Provider; // retries a turn the lead refused; chosen by the user, never by default
  tools: Tool[];
  system: string; // fixed for the whole session: prompt caching and Anthropic thinking blocks need it unchanged
  ctx: Omit<ToolContext, "signal">;
  bus: Bus;
  // Takes the text waiting for the lead, such as background subagents' answers, so each goes into
  // exactly one request (release 4 design, "Background subagents").
  inbox?: () => string[];
}

export class Session {
  // Append-only. Earlier messages are never edited, for the same reason the system prompt is fixed.
  readonly messages: Message[] = [];
  #lead: Provider;
  #fallback: Provider | undefined;
  #running = false;

  constructor(private readonly opts: SessionOptions) {
    this.#lead = opts.lead;
    this.#fallback = opts.fallback;
  }

  get lead(): Provider {
    return this.#lead;
  }

  setLead(provider: Provider): void {
    this.#lead = provider;
    this.opts.bus.emit("lead", provider.id);
  }

  // From the next refusal; a rescue already under way finishes on the one it started with (release 6 design, "When a
  // live change applies").
  setFallback(provider: Provider | undefined): void {
    this.#fallback = provider;
  }

  // An empty `text` starts a turn with only the waiting text, when there is any.
  async send(text: string, signal?: AbortSignal): Promise<void> {
    // Two turns at once would interleave their messages and tool results in the history.
    if (this.#running) throw new Error("A turn is already running");
    this.#running = true;
    try {
      await this.#turn(text, signal);
    } finally {
      this.#running = false;
    }
  }

  async #turn(text: string, signal?: AbortSignal): Promise<void> {
    const { bus } = this.opts;
    const parts: Part[] = [...(text ? [{ type: "text" as const, text }] : []), ...this.#waiting()];
    if (!parts.length) return;
    this.#push({ role: "user", parts });

    for (;;) {
      const lead = this.#lead;
      let answeredBy = lead;
      let turn = await this.#request(lead, signal);
      if (!turn) return;
      const rescue = this.#fallback;
      if (turn.cutOff?.kind === "refusal" && rescue) {
        // The refused reply is discarded, never stored, so the history stays append-only.
        const refused = { kind: "refusal", attempted: `response from ${lead.id}`, message: turn.cutOff.detail, lead: lead.id } as const;
        answeredBy = rescue;
        turn = await this.#request(rescue, signal);
        // A rescued refusal is reported only as the rescue, so the status line does not count it as an error.
        if (!turn || turn.cutOff?.kind === "refusal") bus.emit("error", refused);
        else bus.emit("error", { kind: "fallback", attempted: `response from ${lead.id}`, message: `${lead.id} declined; ${rescue.id} answered instead`, lead: lead.id });
        if (!turn) return;
      }
      if (turn.cutOff?.kind === "refusal") {
        // Never stored, on any path: the output may be empty or half-written, and an empty assistant
        // message makes every later Anthropic request fail, with no way to remove it.
        bus.emit("error", { kind: "refusal", attempted: `response from ${answeredBy.id}`, message: turn.cutOff.detail, lead: lead.id });
        return;
      }
      // Reported only now, so a model that still refused is never shown as having answered.
      for (const f of turn.fallbacks ?? []) {
        bus.emit("error", { kind: "fallback", attempted: `response from ${answeredBy.id}`, message: `${f.from} declined; ${f.to} answered instead (Anthropic's fallback)`, lead: lead.id });
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

      // Calls of a side-by-side tool (delegate) all start first, together; the rest run one after
      // another. The results go back in the reply's order, then whatever is waiting for the lead,
      // after the last tool result, as the providers want it.
      const results: ToolResult[] = new Array(calls.length);
      const together = calls.map((c, i) => (this.opts.tools.find((t) => t.spec.name === c.name)?.parallel ? this.#runTool(c, signal).then((r) => (results[i] = r)) : null));
      for (const [i, call] of calls.entries()) if (!together[i]) results[i] = await this.#runTool(call, signal);
      await Promise.all(together);
      this.#push({ role: "user", parts: [...results, ...this.#waiting()] });
      if (signal?.aborted) return;
    }
  }

  // One request. Its usage is reported even if the reply is then discarded, because it is billed.
  async #request(provider: Provider, signal?: AbortSignal): Promise<Turn | undefined> {
    const { bus, tools, system } = this.opts;
    try {
      const turn = await provider.complete({ system, messages: this.messages, tools: tools.map((t) => t.spec), signal });
      for (const d of turn.declined ?? []) bus.emit("usage", d);
      bus.emit("usage", { provider: turn.servedBy ?? provider.id, usage: turn.usage }); // last: it sets the context size
      return turn;
    } catch (err) {
      if (!signal?.aborted) bus.emit("error", { kind: "provider", attempted: `request to ${provider.id}`, message: errorText(err), lead: this.#lead.id });
      return undefined;
    }
  }

  async #runTool(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const { bus } = this.opts;
    bus.emit("tool-start", { id: call.id, name: call.name, input: call.input });
    const [res, outcome] = await this.#execute(call, signal);
    bus.emit("tool-end", { id: call.id, outcome });
    return res;
  }

  async #execute(call: ToolCall, signal?: AbortSignal): Promise<[ToolResult, ToolOutcome]> {
    if (signal?.aborted) return [result(call, "Cancelled by the user.", true), "cancelled"];
    const fail = (message: string): [ToolResult, ToolOutcome] => {
      // Capped like the message: a failed write_file's input is the whole file.
      this.opts.bus.emit("error", { kind: "tool", attempted: truncate(`${call.name} ${JSON.stringify(call.input)}`), message, lead: this.#lead.id });
      return [result(call, message, true), "failed"];
    };
    const tool = this.opts.tools.find((t) => t.spec.name === call.name);
    if (!tool) return fail(`Unknown tool: ${call.name}`);
    try {
      return [result(call, truncate(await tool.run(call.input, { ...this.opts.ctx, signal })), false), "ok"];
    } catch (err) {
      // Ctrl-C at a question declines it and stops the turn: the call was cancelled, not declined.
      if (err instanceof Declined) return [result(call, err.message, true), signal?.aborted ? "cancelled" : "declined"];
      if (signal?.aborted) return [result(call, "Cancelled by the user.", true), "cancelled"]; // not a failure, so not logged
      return fail(truncate(errorText(err)));
    }
  }

  #waiting(): Part[] {
    return (this.opts.inbox?.() ?? []).map((text) => ({ type: "text", text, from: "tasks" }));
  }

  #push(message: Message): void {
    this.messages.push(message);
    this.opts.bus.emit("message", message);
  }
}

function result(call: ToolCall, output: string, isError: boolean): ToolResult {
  return { type: "tool_result", callId: call.id, output, isError };
}
