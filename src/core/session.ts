import { MAX_TOOL_OUTPUT } from "../exec/executor.js";
import type { Cache } from "../providers/pictures.js";
import type { Tool, ToolContext } from "../tools/tool.js";
import type { Bus, ToolOutcome } from "./bus.js";
import { type Ask, Declined } from "./permissions.js";
import { CUT_OFF, type Transcript } from "./transcript.js";
import { errorText, type Message, marker, type Part, type Provider, type ToolCall, type ToolResult, type Turn } from "./types.js";

export function truncate(s: string): string {
  return s.length <= MAX_TOOL_OUTPUT ? s : `${s.slice(0, MAX_TOOL_OUTPUT)}\n[cut: ${s.length - MAX_TOOL_OUTPUT} more characters]`;
}

export interface SessionOptions {
  lead: Provider;
  fallback?: Provider; // retries a turn the lead refused; chosen by the user, never by default
  tools: Tool[];
  system: string; // the starting value: Session.system is the conversation's (release 8a plan, choice 3)
  // The system prompt built afresh, the instruction files read again, for a shortening (release 8a plan, choice 3).
  systemNow?: () => string;
  id?: string; // the session's, as its transcript is named
  // Where each message is saved as it joins the history (release 8a design, "Saving sessions"); none, nothing is saved.
  transcript?: Transcript;
  // The window's picture numbers and subagent ids, which a loaded conversation's must not be handed out again (release
  // 8a plan, choices 4 and 5): tui/pictures.ts's Pictures and tasks.ts's Tasks.
  pictures?: { from(n: number): void };
  tasks?: { from(n: number): void };
  ctx: Omit<ToolContext, "signal">;
  bus: Bus;
  // Takes the text waiting for the lead, such as background subagents' answers, so each goes into
  // exactly one request (release 4 design, "Background subagents").
  inbox?: () => string[];
  // The permission question's path, for asking whether to send a refused request again without its pictures (release 6
  // plan, Task 18). Subagents have none: they are never sent pictures.
  ask?: Ask;
  // A subagent's session: the text it is sent is its brief, which the lead wrote, not the user's own words, so it is not
  // kept as a prompt (release 7 plan, choice 6).
  subagent?: boolean;
}

// A saved or new conversation for the session to take (release 8a plan, choice 1). `prompts` and `calls` come from the
// transcript's whole record, before and after its shortenings (choice 6); `nextPicture` and `nextTask` are the numbers
// its pictures and subagents leave free (choices 4 and 5).
export interface Conversation {
  id: string;
  messages: Message[];
  system: string;
  transcript?: Transcript;
  prompts: string[];
  calls: { name: string; input: unknown }[];
  nextPicture: number;
  nextTask: number;
}

export class Session {
  id: string;
  // The conversation's: kept unchanged, as prompt caching and Anthropic thinking blocks need it, and rebuilt only at a
  // shortening, /clear or a new session (release 8a plan, choice 3).
  system: string;
  // Earlier messages are never edited, for the same reason the system prompt is kept. The history only grows, except
  // when it is shortened or a conversation is loaded, which empty and refill this array in place, so a subagent's alias
  // of it (tasks.ts) stays its history (release 8a plan, choice 2).
  readonly messages: Message[] = [];
  // For the judge (release 7 plan, Task 9 and choice 6), in order: the user's own prompts, the text given to `send` with
  // each picture as its marker, never the tool results or waiting text that also travel in user messages; and each call
  // of a reply that is run, in the reply's order, by name and input, never its result.
  readonly prompts: string[] = [];
  readonly calls: { name: string; input: unknown }[] = [];
  #lead: Provider;
  #fallback: Provider | undefined;
  #running = false;
  // Shrunk copies of the conversation's pictures, kept for the session; each request, to the lead or the fallback,
  // still builds its own set from them (release 6 design, "What is sent, request by request").
  readonly #shrunk: Cache = new Map();
  // The providers the user said to send no pictures to, by id, for the session (release 6 design, "When the provider
  // refuses").
  readonly #refusedPictures = new Set<string>();
  // Run before a shortening's summary request: empty in 8a; 8b's hooks and 8d's memory save join it (release 8a plan,
  // choice 24).
  readonly onShorten: (() => void)[] = [];
  #transcript: Transcript | undefined;

  constructor(private readonly opts: SessionOptions) {
    this.#lead = opts.lead;
    this.#fallback = opts.fallback;
    this.id = opts.id ?? "";
    this.system = opts.system;
    this.#transcript = opts.transcript;
  }

  get lead(): Provider {
    return this.#lead;
  }

  get transcript(): Transcript | undefined {
    return this.#transcript;
  }

  setLead(provider: Provider): void {
    this.#lead = provider;
    this.#transcript?.write({ t: "lead", lead: provider.id });
    this.opts.bus.emit("lead", provider.id);
  }

  // Takes a saved or new conversation in place of this one, as the judge, the subagents' worker and the screen hold this
  // object (release 8a plan, choice 1).
  load(c: Conversation): void {
    this.id = c.id;
    this.system = c.system;
    this.#transcript = c.transcript;
    this.messages.splice(0, this.messages.length, ...c.messages);
    this.prompts.splice(0, this.prompts.length, ...c.prompts);
    this.calls.splice(0, this.calls.length, ...c.calls);
    // Its copies are keyed by picture number, so kept they would send the last conversation's picture 1 for this one's.
    this.#shrunk.clear();
    this.opts.pictures?.from(c.nextPicture);
    this.opts.tasks?.from(c.nextTask);
  }

  get fallback(): Provider | undefined {
    return this.#fallback;
  }

  // From the next refusal; a rescue already under way finishes on the one it started with (release 6 design, "When a
  // live change applies").
  setFallback(provider: Provider | undefined): void {
    this.#fallback = provider;
  }

  // An empty `text` starts a turn with only the waiting text, when there is any. The prompt sends its parts, pictures
  // among its text (release 6 plan, Task 14).
  async send(text: string | Part[], signal?: AbortSignal): Promise<void> {
    // Two turns at once would interleave their messages and tool results in the history.
    if (this.#running) throw new Error("A turn is already running");
    this.#running = true;
    try {
      await this.#turn(typeof text === "string" ? (text ? [{ type: "text", text }] : []) : text, signal);
    } finally {
      this.#running = false;
    }
  }

  async #turn(typed: Part[], signal?: AbortSignal): Promise<void> {
    const { bus } = this.opts;
    // A picture is its marker in its place, so the prompt is the words as typed, and none of the picture's data is kept.
    const words = typed.flatMap((p) => (p.type === "image" ? [marker(p.id)] : p.type === "text" && p.from === undefined ? [p.text] : [])).join("");
    if (words && !this.opts.subagent) this.prompts.push(words);
    const parts: Part[] = [...typed, ...this.#waiting()];
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
          this.#push({ role: "user", parts: calls.map((c) => result(c, `${CUT_OFF}${turn.cutOff!.detail}).`, true)) });
        }
        return;
      }
      if (calls.length === 0) return;
      // Kept for the judge in the reply's order, before any runs, as delegate's calls start before the others.
      for (const c of calls) this.calls.push({ name: c.name, input: c.input });

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
    const { bus, tools } = this.opts;
    const { system } = this;
    const refused = this.#refusedPictures.has(provider.id);
    try {
      // The line for pictures left out (release 6 design, "The whole request"); the conversation keeps them all.
      const leftOut = (n: number, over: string) =>
        bus.emit("note", `${n} ${n === 1 ? "picture was" : "pictures were"} left out of this request to fit ${over}.`);
      const turn = await provider.complete({
        system,
        messages: this.messages,
        tools: tools.map((t) => t.spec),
        signal,
        shrunk: this.#shrunk,
        leftOut,
        ...(refused ? { refusedBy: provider.id } : {}),
      });
      for (const d of turn.declined ?? []) bus.emit("usage", d);
      bus.emit("usage", { provider: turn.servedBy ?? provider.id, usage: turn.usage }); // last: it sets the context size
      return turn;
    } catch (err) {
      if (signal?.aborted) return undefined;
      // The SDKs' `APIError` and chatgpt.ts's ProviderError carry the HTTP status; anything else has none.
      const status: unknown = (err as { status?: unknown } | null | undefined)?.status;
      const error = {
        kind: "provider" as const,
        attempted: `request to ${provider.id}`,
        message: errorText(err),
        lead: this.#lead.id,
      };
      bus.emit("error", typeof status === "number" ? { ...error, status } : error);
      // A 400 does not say whether the pictures caused it, so the user is asked, after seeing the provider's words; y
      // leaves them out for this provider from now on, the conversation keeping them (release 6 design, "When the
      // provider refuses"). It is whichever provider was sent the request, the fallback included, as its id is the one
      // marked. A request already without pictures asks nothing, so a second refusal ends the turn.
      const pictures = !refused && this.messages.some((m) => m.parts.some((p) => p.type === "image"));
      const question = "Send again without the pictures";
      if (status === 400 && pictures && (await this.opts.ask?.(question, undefined, undefined, true))) {
        this.#refusedPictures.add(provider.id);
        bus.emit("note", `Pictures are left out for ${provider.id} from now on.`);
        return this.#request(provider, signal);
      }
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

  // The line is written before the event, so every message is on disk before anything else sees it (release 8a plan,
  // choice 4). A failed write stops saving and never the turn (transcript.ts).
  #push(message: Message): void {
    this.messages.push(message);
    this.#transcript?.write({ t: "message", message });
    this.opts.bus.emit("message", message);
  }
}

function result(call: ToolCall, output: string, isError: boolean): ToolResult {
  return { type: "tool_result", callId: call.id, output, isError };
}
