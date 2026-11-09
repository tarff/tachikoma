import { MAX_TOOL_OUTPUT } from "../exec/executor.js";
import { type Combined, commandOf } from "../hooks/answer.js";
import type { Event } from "../hooks/config.js";
import type { Hooks } from "../hooks/hooks.js";
import { errorOf, fromClaude, outputFrom, type Paths, pathsFor, responseOf, toClaude } from "../hooks/tools.js";
import type { Cache } from "../providers/pictures.js";
import { InvalidInput, type Tool, type ToolContext } from "../tools/tool.js";
import type { Bus, ToolOutcome } from "./bus.js";
import { characters, fits, Sizes } from "./fit.js";
import { type Ask, Declined, type PermissionGate } from "./permissions.js";
import { CANCELLED, shorten, type When } from "./shorten.js";
import { CUT_OFF, type Transcript } from "./transcript.js";
import {
  type CompletionRequest,
  errorText,
  type Message,
  marker,
  type Part,
  type Provider,
  sentAll,
  type ToolCall,
  type ToolResult,
  type Turn,
} from "./types.js";

// Why /lead could not shorten the conversation when its transcript is not saved, for its refusal's line (release 8a
// design, "How shortening works", step 1).
export const UNSAVED = "saving this session stopped";

export function truncate(s: string): string {
  return s.length <= MAX_TOOL_OUTPUT ? s : `${s.slice(0, MAX_TOOL_OUTPUT)}\n[cut: ${s.length - MAX_TOOL_OUTPUT} more characters]`;
}

// What the model is told of a call a hook's continue: false came before, and of one it stopped while it ran (release 8b
// plan, "Lines this plan adds").
const NOT_RUN = "Not run: a hook stopped the turn.";
const STOPPED = "Stopped: a hook stopped the turn.";

// One reply's calls (release 8b plan, Task 7): they run under `signal`, the reply's own, joined to the turn's; `stop` is a
// hook's continue: false, which stops them as a user's stop does, and `stopped` the first hook that said it.
interface Round {
  signal: AbortSignal;
  stop(event: Event, reason: string): void;
  stopped?: { event: Event; reason: string };
}

export interface SessionOptions {
  lead: Provider;
  fallback?: Provider; // retries a turn the lead refused; chosen by the user, never by default
  tools: Tool[];
  system: string; // the starting value: Session.system is the conversation's (release 8a plan, choice 3)
  // The system prompt built afresh, the instruction files read again, for a shortening (release 8a plan, choice 3).
  systemNow?: () => Promise<string>;
  id?: string; // the session's, as its transcript is named: a subagent's is its own, t1 and so on
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
  // The user's hooks (release 8b plan, Task 6): the window's, or a subagent's from hooks.for. `paths` turns a tool's paths
  // into the ones hooks are sent and back (hooks/tools.ts, pathsFor): the launch's, from the project's real root and the
  // sandbox's mode, as ctx.root is the box's /work there; without it, ctx.root's on the host.
  hooks?: Hooks;
  paths?: Paths;
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
  // The /autocompact size in tokens: a conversation past it is shortened before its next request, as one past the window
  // is; null, the window alone (release 8a design, "When to shorten"). Task 13's /autocompact sets it (plan, choice 26).
  autoCompact: number | null = null;
  // Each model's tokens per character in this conversation (fit.ts). A loaded conversation starts afresh, so on Anthropic
  // it is counted exactly (design, "When to shorten").
  #sizes = new Sizes();
  #transcript: Transcript | undefined;
  #saidFailed = false; // whether this transcript's failure has been said: once per transcript
  // The text the tool hooks handed the model during a reply, held until its results go back (release 8b plan, Tasks 6, 7).
  readonly #hookText: { event: Event; text: string }[] = [];

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
    this.#saving();
  }

  // Takes a saved or new conversation in place of this one, as the judge, the subagents' worker and the screen hold this
  // object (release 8a plan, choice 1). The providers sent no pictures stay so, as the user's answer holds for the window
  // (user, 2026-11-06: "Keep for the window").
  load(c: Conversation): void {
    // A turn running would go on adding its messages and results to the conversation loaded.
    if (this.#running) throw new Error("A turn is already running");
    this.id = c.id;
    this.system = c.system;
    if (c.transcript !== this.#transcript) this.#saidFailed = false;
    this.#transcript = c.transcript;
    this.messages.splice(0, this.messages.length, ...c.messages);
    this.prompts.splice(0, this.prompts.length, ...c.prompts);
    this.#hookText.splice(0); // the last conversation's hook text, not yet sent, is not this one's (Task 6's code review)
    this.calls.splice(0, this.calls.length, ...c.calls);
    // Its copies are keyed by picture number, so kept they would send the last conversation's picture 1 for this one's.
    this.#shrunk.clear();
    this.#sizes = new Sizes();
    this.opts.pictures?.from(c.nextPicture);
    this.opts.tasks?.from(c.nextTask);
    this.#saving(); // a write made before the load, such as launch's start line or mend
  }

  // The system prompt built afresh, for /clear (release 8a plan, Task 7): the instruction files read again, or without
  // systemNow the starting one.
  freshSystem(): Promise<string> {
    return this.opts.systemNow?.() ?? Promise.resolve(this.opts.system);
  }

  // Before /lead makes `next` the lead (release 8a design, "When to shorten"): a conversation that will not fit its smaller
  // window is shortened between turns by the lead leading now, estimated with that lead's ratio, as `next` has none yet
  // (plan, Task 12). The reason it could not be, for /lead's refusal; undefined when it fits, when that cannot be told, and
  // when it was shortened.
  // A stop gives CANCELLED, so the switch is not made.
  async makeRoom(next: Provider, signal?: AbortSignal): Promise<string | undefined> {
    // A turn running would go on with the history shortened under it, and one sent meanwhile likewise.
    if (this.#running) throw new Error("A turn is already running");
    this.#running = true;
    try {
      if (!this.messages.length) return;
      const lead = this.#lead;
      const now = await this.#window(lead, signal);
      const then = await this.#window(next, signal);
      if (now === undefined || then === undefined) return CANCELLED;
      if (then === null || (now !== null && then >= now)) return;
      const over = await this.#over(lead, then, signal);
      if (over === undefined) return CANCELLED;
      if (!over) return;
      const r = await this.#shorten(lead, "between", then, signal);
      return r === "done" ? undefined : r === "unsaved" ? UNSAVED : r.problem;
    } finally {
      this.#running = false;
    }
  }

  // /compact [words] (release 8a plan, Task 13): the whole history shortened between turns by the lead, the words as the
  // summary's focus. The reason it could not be, for its red line, said here on the bus as a turn's is, except a stop,
  // which gives CANCELLED for the caller to say, as a user's stop is no failure to log or count; undefined when shortened.
  async compact(focus: string, signal?: AbortSignal): Promise<string | undefined> {
    // As makeRoom: a turn running would go on with the history shortened under it.
    if (this.#running) throw new Error("A turn is already running");
    this.#running = true;
    try {
      const lead = this.#lead;
      const window = await this.#window(lead, signal);
      const r = window === undefined ? { problem: CANCELLED } : await this.#shorten(lead, "between", window, signal, undefined, focus);
      const problem = r === "done" ? undefined : r === "unsaved" ? UNSAVED : r.problem;
      if (problem !== undefined && problem !== CANCELLED) this.#say(lead, cannot(problem));
      return problem;
    } finally {
      this.#running = false;
    }
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
  // among its text (release 6 plan, Task 14). How the turn ended: `stopped`, a hook's continue: false, with its stopReason
  // ("" when none); nothing otherwise (release 8b plan, choice 17).
  async send(text: string | Part[], signal?: AbortSignal): Promise<{ stopped: string } | void> {
    // Two turns at once would interleave their messages and tool results in the history.
    if (this.#running) throw new Error("A turn is already running");
    this.#running = true;
    try {
      return await this.#turn(typeof text === "string" ? (text ? [{ type: "text", text }] : []) : text, signal);
    } finally {
      this.#running = false;
    }
  }

  async #turn(typed: Part[], signal?: AbortSignal): Promise<{ stopped: string } | void> {
    const { bus } = this.opts;
    // A picture is its marker in its place, so the prompt is the words as typed, and none of the picture's data is kept.
    const words = typed.flatMap((p) => (p.type === "image" ? [marker(p.id)] : p.type === "text" && p.from === undefined ? [p.text] : [])).join("");
    if (words && !this.opts.subagent) this.prompts.push(words);
    const parts: Part[] = [...typed, ...this.#waiting()];
    if (!parts.length) return;
    // The turn's request, kept for a shortening during the turn: after a first one it is no longer in the history.
    const asked: Message = { role: "user", parts };
    this.#push(asked);

    // Where the turn is, for a shortening: at its start until its first round of calls, during it after (release 8a
    // design, "How shortening works", step 4). `shortened`: this request was shortened for once, so a "too long" answer to
    // it now ends the turn (plan, "Numbers in this plan": 1 request sent again). `autoFailed`: a shortening for the
    // /autocompact size failed in this turn, so the size waits for the next one (below).
    let when: When = "start";
    let shortened = false;
    let autoFailed = false;
    for (;;) {
      const lead = this.#lead;
      // Not waited for when the lead has no window to look up. A test-timing constraint: app.test.tsx's "hands the lead a
      // failure during its turn" has a subagent whose request fails at once reach the lead's next request, which an extra
      // wait before that subagent's request would make it miss.
      const window = lead.contextWindow ? await this.#window(lead, signal) : null;
      if (window === undefined) return; // stopped
      // The check before the request, against the window and the /autocompact size; with neither known there is none, and
      // the "too long" answer is the safety net (design, "When to shorten").
      const limit = Math.min(window ?? Infinity, (autoFailed ? null : this.autoCompact) ?? Infinity);
      // A stop meanwhile ends the turn as any stop does, saying nothing (#execute).
      if (!shortened && limit < Infinity) {
        const over = await this.#over(lead, limit, signal);
        if (over === undefined) return;
        if (over) {
          const r = await this.#shorten(lead, when, window, signal, asked);
          if (signal?.aborted) return;
          if (r === "done") shortened = true;
          else if (r !== "unsaved") {
            // Past the /autocompact size alone, a request that still fits the window, or whose fit cannot be told as the
            // window is not known, is sent as it is after the line, its event marked so (plan, Task 13; user, 2026-11-06:
            // "Show the line, send anyway"), and the /autocompact size is not tried again until the next turn, so a summary
            // that keeps failing costs one request and one line a prompt (user, 2026-11-06: "Retry next turn"); the
            // window's check goes on. Over the window, the turn ends with the line.
            const overWindow = limit === window || (window !== null && (await this.#over(lead, window, signal)));
            if (overWindow === undefined) return; // stopped
            this.#say(lead, cannot(r.problem), !overWindow);
            if (overWindow) return;
            autoFailed = true;
          } else if (limit === window) {
            // Not saved, it cannot be shortened: over the window it ends with the line. Past the /autocompact size alone,
            // or with its size not known now, it is sent as it is, the model's own answer deciding.
            const line = await this.#tooLong(lead, window, signal);
            if (signal?.aborted) return;
            if (line) return this.#say(lead, line);
          }
        }
      }
      let answeredBy = lead;
      let turn = await this.#request(lead, signal);
      if (!turn) return;
      // A "too long" answer, or a reply that filled the window, is never stored: the history is shortened and the request
      // sent once more (plan, choices 20 and 21). Too long again, or not saved so not shortened, the turn ends: a "too long"
      // answer with the line, or as it came when the request's size or the window is not known; a reply that filled the
      // window with its own words, as the line would give a size within the window.
      if ("tooLong" in turn || turn.cutOff?.kind === "window") {
        if (!shortened) {
          const r = await this.#shorten(lead, when, window, signal, asked);
          if (signal?.aborted) return;
          if (r === "done") {
            shortened = true;
            continue;
          }
          if (r !== "unsaved") return this.#say(lead, cannot(r.problem));
        }
        if (!("tooLong" in turn)) {
          bus.emit("error", { kind: "max_tokens", attempted: `response from ${lead.id}`, message: turn.cutOff!.detail, lead: lead.id });
          return;
        }
        const line = await this.#tooLong(lead, window, signal);
        if (signal?.aborted) return;
        if (line) this.#say(lead, line);
        else this.#failed(lead, turn.tooLong);
        return;
      }
      const rescue = this.#fallback;
      if (turn.cutOff?.kind === "refusal" && rescue) {
        // The refused reply is discarded, never stored, so the history stays append-only.
        const refused = { kind: "refusal", attempted: `response from ${lead.id}`, message: turn.cutOff.detail, lead: lead.id } as const;
        answeredBy = rescue;
        const rescued = await this.#request(rescue, signal);
        // The rescue's "too long" answer is reported as it came: only the lead's request is shortened for.
        if (rescued && "tooLong" in rescued) this.#failed(rescue, rescued.tooLong);
        turn = rescued && !("tooLong" in rescued) ? rescued : undefined;
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
      if (turn.cutOff?.kind === "window") {
        // Only the rescue's comes here, the lead's having been shortened for above: never stored either, it ends the turn.
        bus.emit("error", { kind: "max_tokens", attempted: `response from ${answeredBy.id}`, message: turn.cutOff.detail, lead: lead.id });
        return;
      }
      // Reported only now, so a model that still refused is never shown as having answered.
      for (const f of turn.fallbacks ?? []) {
        bus.emit("error", { kind: "fallback", attempted: `response from ${answeredBy.id}`, message: `${f.from} declined; ${f.to} answered instead (Anthropic's fallback)`, lead: lead.id });
      }
      // With the lead that answered: the fallback that rescued a refusal, or the model the provider says served it.
      this.#push({ role: "assistant", parts: turn.parts, native: turn.native, lead: turn.servedBy ?? answeredBy.id });

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
      // Kept for the judge in the reply's order, before any runs, as delegate's calls start before the others. A hook's
      // rewrite replaces its call's entry before the call runs (#execute).
      const entries = calls.map((c) => ({ name: c.name, input: c.input }));
      this.calls.push(...entries);

      // The reply's calls run under a signal of its own, joined to the turn's, so a hook's continue: false stops them as a
      // user's stop does, a running delegate ending as a stopped one (release 8b plan, Task 7; design, review finding 1).
      const halt = new AbortController();
      const join = () => halt.abort();
      signal?.addEventListener("abort", join, { once: true });
      if (signal?.aborted) halt.abort();
      const round: Round = {
        signal: halt.signal,
        stop: (event, reason) => {
          round.stopped ??= { event, reason };
          halt.abort();
        },
      };
      // Calls of a side-by-side tool (delegate) all start first, together; the rest run one after
      // another. The results go back in the reply's order, then the hooks' text for the model, so a stopped turn's text
      // is never the next one's (Task 6's review), then whatever is waiting for the lead, after the last tool result, as
      // the providers want it.
      const results: ToolResult[] = new Array(calls.length);
      const together = calls.map((c, i) =>
        this.opts.tools.find((t) => t.spec.name === c.name)?.parallel ? this.#runTool(c, entries[i]!, round).then((r) => (results[i] = r)) : null,
      );
      for (const [i, call] of calls.entries()) if (!together[i]) results[i] = await this.#runTool(call, entries[i]!, round);
      await Promise.all(together);
      signal?.removeEventListener("abort", join);
      this.#push({ role: "user", parts: [...results, ...this.#hookParts(), ...this.#waiting()] });
      // Every call has its one result, saved, before the turn ends (design, review finding 1).
      if (round.stopped) {
        const { event, reason } = round.stopped;
        bus.emit("hook-note", reason ? `A ${event} hook stopped the turn: ${reason}` : `A ${event} hook stopped the turn.`);
        return { stopped: reason };
      }
      if (signal?.aborted) return;
      when = "during";
      shortened = false;
    }
  }

  // One request. Its usage is reported even if the reply is then discarded, because it is billed. A "too long" answer is
  // handed back as it came, with nothing said, for the turn to shorten the history (release 8a plan, choice 20).
  async #request(provider: Provider, signal?: AbortSignal): Promise<Turn | { tooLong: unknown } | undefined> {
    const { bus } = this.opts;
    const refused = this.#refusedPictures.has(provider.id);
    const req = this.#req(provider, signal);
    // Counted once, beside the request, from exactly what is sent, before the reply joins the history (plan, Task 12).
    const chars = characters(req.system, req.messages, req.tools);
    try {
      // The line for pictures left out (release 6 design, "The whole request"); the conversation keeps them all.
      const leftOut = (n: number, over: string) =>
        bus.emit("note", `${n} ${n === 1 ? "picture was" : "pictures were"} left out of this request to fit ${over}.`);
      const turn = await provider.complete({ ...req, leftOut });
      // By the model that answered, so a fallback's numbers never become the lead's ratio (choice 17).
      this.#sizes.learn(turn.servedBy ?? provider.id, chars, turn.usage);
      for (const d of turn.declined ?? []) bus.emit("usage", d);
      bus.emit("usage", { provider: turn.servedBy ?? provider.id, usage: turn.usage }); // last: it sets the context size
      return turn;
    } catch (err) {
      if (signal?.aborted) return undefined;
      // Before the pictures question, so a too-long 400 never asks it (choice 20).
      if (provider.tooLong?.(err)) return { tooLong: err };
      const status = this.#failed(provider, err);
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

  // A request's failure as the provider gave it; its HTTP status, for the pictures question.
  #failed(provider: Provider, err: unknown): unknown {
    // The SDKs' `APIError` and chatgpt.ts's ProviderError carry the HTTP status; anything else has none.
    const status: unknown = (err as { status?: unknown } | null | undefined)?.status;
    const error = {
      kind: "provider" as const,
      attempted: `request to ${provider.id}`,
      message: errorText(err),
      lead: this.#lead.id,
    };
    this.opts.bus.emit("error", typeof status === "number" ? { ...error, status } : error);
    return status;
  }

  // The request the conversation makes now to `provider`, as it is sent, measured and counted.
  #req(provider: Provider, signal?: AbortSignal): CompletionRequest {
    return {
      system: this.system,
      messages: sentAll(this.messages),
      tools: this.opts.tools.map((t) => t.spec),
      signal,
      shrunk: this.#shrunk,
      ...(this.#refusedPictures.has(provider.id) ? { refusedBy: provider.id } : {}),
    };
  }

  // A model's window, null when it is not known; undefined when the turn was stopped meanwhile.
  async #window(provider: Provider, signal?: AbortSignal): Promise<number | null | undefined> {
    try {
      return (await provider.contextWindow?.(signal)) ?? null;
    } catch {
      return signal?.aborted ? undefined : null;
    }
  }

  // Whether the conversation's next request to the lead will not fit `limit` (fit.ts): null, no way to tell, counts as
  // fitting, as such a request has no advance check. Undefined when stopped, as only a stop gets through fits().
  async #over(lead: Provider, limit: number, signal?: AbortSignal): Promise<boolean | undefined> {
    try {
      return (await fits(lead, this.#req(lead, signal), this.#sizes, limit)) === false;
    } catch (err) {
      if (!signal?.aborted) throw err;
      return undefined;
    }
  }

  // One shortening (release 8a design, "How shortening works"; plan, Task 12), by `lead`, into what fits `window`.
  // "unsaved": the transcript is not on disk, so nothing is summarised (step 1), or its `shortened` line could not be
  // written, which `write` records without throwing; either way nothing changes. The problem when it failed, as
  // shorten.ts words it, nothing changed either.
  async #shorten(
    lead: Provider,
    when: When,
    window: number | null,
    signal?: AbortSignal,
    asked?: Message,
    focus?: string,
  ): Promise<"done" | "unsaved" | { problem: string }> {
    const { bus } = this.opts;
    const t = this.#transcript;
    if (!t || t.failed !== null) return "unsaved";
    for (const f of this.onShorten) f();
    const r = await shorten(
      {
        lead,
        system: this.system,
        messages: this.messages,
        ...(asked ? { asked } : {}),
        ...(focus ? { focus } : {}),
        tools: this.opts.tools.map((t) => t.spec),
        calls: this.calls,
        workspace: this.opts.ctx.workspace,
        sizes: this.#sizes,
        window: window ?? Infinity, // not known: every fit passes, and the "too long" answer is the safety net
        ...(signal ? { signal } : {}),
        shrunk: this.#shrunk,
        ...(this.#refusedPictures.has(lead.id) ? { refusedBy: lead.id } : {}),
        // Counted as the judge's is, apart from the conversation's context (stats.ts).
        onUsage: (u) => bus.emit("usage", { ...u, summary: true }),
      },
      when,
    );
    if ("problem" in r) return r;
    // The new history goes with a system prompt built afresh, both in one line, so the shortening is saved whole or not
    // at all (choices 3 and 4).
    const system = await this.freshSystem();
    if (signal?.aborted) return { problem: CANCELLED }; // a stop while the files were read changes nothing either
    t.write({ t: "shortened", system, message: r.messages[0]! });
    if (t.failed !== null) {
      this.#saving();
      return "unsaved";
    }
    this.system = system;
    this.messages.splice(0, this.messages.length, ...r.messages);
    bus.emit("shortened", r.summary);
    return "done";
  }

  // The approved line for a request still too long for `lead`, with its size by the lead's ratio or its exact count; null
  // when that or the window is not known, so the line cannot be given.
  async #tooLong(lead: Provider, window: number | null, signal?: AbortSignal): Promise<string | null> {
    if (window === null) return null;
    const req = this.#req(lead, signal);
    let size = this.#sizes.estimate(lead.id, characters(req.system, req.messages, req.tools));
    if (size === null && lead.countTokens) size = await lead.countTokens(req).catch(() => null);
    if (size === null) return null;
    const n = (x: number) => Math.round(x).toLocaleString("en-US"); // as providers/pictures.ts writes a number
    return `The request is too long for ${lead.id}: about ${n(size)} tokens, against a window of ${n(window)}.`;
  }

  // A shortening's red line, which ends the turn, except past the /autocompact size alone (#turn) and for /compact.
  // `sent`: the request was sent as it is after it, so -p's run does not fail for it (cli.tsx).
  #say(lead: Provider, message: string, sent = false): void {
    const error = { kind: "shortening" as const, attempted: `request to ${lead.id}`, message, lead: this.#lead.id };
    this.opts.bus.emit("error", sent ? { ...error, sent: true } : error);
  }

  // `entry` is the call's place in the record of calls, which a hook's rewrite replaces.
  async #runTool(call: ToolCall, entry: { name: string; input: unknown }, round: Round): Promise<ToolResult> {
    const { bus } = this.opts;
    bus.emit("tool-start", { id: call.id, name: call.name, input: call.input });
    const [res, outcome] = await this.#execute(call, entry, round);
    bus.emit("tool-end", { id: call.id, outcome });
    return res;
  }

  async #execute(call: ToolCall, entry: { name: string; input: unknown }, round: Round): Promise<[ToolResult, ToolOutcome]> {
    const { signal } = round;
    // A call a stop came before or during: the user's, or a hook's continue: false, in its own words (release 8b plan,
    // Task 7).
    const stopped = (byHook: string): [ToolResult, ToolOutcome] => [result(call, round.stopped ? byHook : "Cancelled by the user.", true), "cancelled"];
    if (signal.aborted) return stopped(NOT_RUN);
    const fail = (message: string): [ToolResult, ToolOutcome] => {
      // Capped like the message: a failed write_file's input is the whole file. The input that ran, a hook's rewrite among
      // them, as the record of calls holds it (Task 6's code review).
      this.opts.bus.emit("error", { kind: "tool", attempted: truncate(`${call.name} ${JSON.stringify(entry.input)}`), message, lead: this.#lead.id });
      return [result(call, message, true), "failed"];
    };
    const tool = this.opts.tools.find((t) => t.spec.name === call.name);
    if (!tool) return fail(`Unknown tool: ${call.name}`);
    const { hooks } = this.opts;
    let parts: unknown; // the result's parts as the tool reported them, for the shape hooks are sent (choice 12)
    let started: number | undefined; // unset: the tool never started
    let text: string;
    let ms: number;
    try {
      // A stop while a PreToolUse hook runs kills it and rejects, so the call is cancelled below, as any stop (run.ts).
      const pre = hooks ? await this.#preToolUse(call, entry, hooks, signal) : { input: call.input, gate: this.opts.ctx.gate };
      if ("stop" in pre) {
        round.stop("PreToolUse", pre.stop);
        return stopped(NOT_RUN);
      }
      if ("refused" in pre) return [result(call, pre.refused, true), "declined"];
      // Only when a hook after the call matches it, so a write with no such hook does not read the file first (files.ts).
      // A plain capture, which cannot throw into the tool (Task 5's code review).
      const name = toClaude(entry, this.#hookPaths()).tool_name;
      const report = hooks?.has("PostToolUse", name) || hooks?.has("PostToolUseFailure", name) ? { report: (p: unknown) => void (parts = p) } : {};
      started = Date.now();
      text = truncate(await tool.run(pre.input, { ...this.opts.ctx, gate: pre.gate, signal, ...report }));
      ms = Date.now() - started;
    } catch (err) {
      // Ctrl-C at a question declines it and stops the turn: the call was cancelled, not declined.
      // Cut as a failure's is: a hook's question names the call with its whole input, a write's content included.
      if (err instanceof Declined) return [result(call, truncate(err.message), true), signal.aborted ? "cancelled" : "declined"];
      if (signal.aborted) return stopped(started === undefined ? NOT_RUN : STOPPED); // not a failure, so not logged
      const failed = fail(truncate(errorText(err)));
      // Not for a call that never started, nor an input the tool's schema refused (Claude Code's hooks reference).
      if (hooks && started !== undefined && !(err instanceof InvalidInput)) {
        const fields = { error: errorOf(call.name, failed[0].output, parts), is_interrupt: false, duration_ms: Date.now() - started };
        await this.#postToolUse(hooks, "PostToolUseFailure", call, entry, fields, round);
      }
      return failed;
    }
    // A call a stop came during keeps its own result, such as a stopped delegate's, and no hook after it runs.
    if (!hooks || signal.aborted) return [result(call, text, false), "ok"];
    const fields = { tool_response: responseOf(call.name, text, parts, this.#hookPaths()), duration_ms: ms };
    const c = await this.#postToolUse(hooks, "PostToolUse", call, entry, fields, round);
    // updatedToolOutput replaces what the model reads where it can be turned back into it, and is ignored otherwise (choice
    // 13). The outcome stays the call's own.
    const output = c && "output" in c ? outputFrom(call.name, c.output) : null;
    return [result(call, output === null ? text : truncate(output), false), "ok"];
  }

  // PostToolUse or PostToolUseFailure after a call that ran (release 8b plan, Task 7; design, "Tool hooks"), sent the input
  // that ran, matched on the tool's Claude Code name, under the reply's signal. Its text for the model waits for the reply's
  // results, and its continue: false stops the reply's calls. Undefined when a stop ended its hooks (run.ts), so the call
  // keeps its own result.
  async #postToolUse(
    hooks: Hooks,
    event: "PostToolUse" | "PostToolUseFailure",
    call: ToolCall,
    entry: { name: string; input: unknown },
    fields: object,
    round: Round,
  ): Promise<Combined | undefined> {
    const { tool_name, tool_input } = toClaude(entry, this.#hookPaths());
    let c: Combined;
    try {
      c = await hooks.fire(event, { tool_name, tool_input, tool_use_id: call.id, ...fields }, { match: tool_name, signal: round.signal });
    } catch (err) {
      if (round.signal.aborted) return undefined;
      throw err;
    }
    this.#hookText.push(...c.context);
    if (c.stop !== undefined) round.stop(event, c.stop);
    return c;
  }

  // The paths hooks are sent: the launch's, or without them ctx.root's on the host (SessionOptions.paths).
  #hookPaths(): Paths {
    return this.opts.paths ?? pathsFor(this.opts.ctx.root, null);
  }

  // The text the tool hooks handed the model during the reply, one part each, headed by its event (release 8b plan,
  // choice 6), taken so it goes into exactly one message.
  #hookParts(): Part[] {
    return this.#hookText.splice(0).map(({ event, text }) => ({ type: "text", text: `${event} hook:\n${text}`, from: "hooks" }));
  }

  // PreToolUse before a call (release 8b plan, Task 6; design, "Tool hooks"), matched on the tool's Claude Code name, under
  // the turn's signal. The input to run and the gate to run it with, or what the model is told of a refusal. The lines
  // name the tool as the rest of the window does (choice 10).
  async #preToolUse(
    call: ToolCall,
    entry: { name: string; input: unknown },
    hooks: Hooks,
    signal?: AbortSignal,
  ): Promise<{ input: unknown; gate: PermissionGate } | { refused: string } | { stop: string }> {
    const paths = this.#hookPaths();
    const { tool_name, tool_input } = toClaude(call, paths);
    const c = await hooks.fire("PreToolUse", { tool_name, tool_input, tool_use_id: call.id }, { match: tool_name, signal });
    this.#hookText.push(...c.context);
    // A continue: false stops the turn before the call runs; combine has dropped the rest of the answer (Task 6's build).
    if (c.stop !== undefined) return { stop: c.stop };
    const say = (line: string) => this.opts.bus.emit("hook-note", line);
    // Each refusal is told to the gate, for -p's exit code (the user's choice, 2026-11-09).
    const refused = (line: string, told = line) => {
      say(line);
      this.opts.ctx.gate.hookRefused();
      return { refused: told };
    };
    if (c.deferred) say('A PreToolUse hook answered "defer", which Tachikoma takes as no opinion.');
    // A deny, or a block (exit 2, or a failure that onFailure "block" makes one), refuses the call in every mode; the model
    // gets its reason. A rewrite beside it is never used, as nothing runs (Task 3's carry-over).
    if (c.block !== undefined) {
      const line = c.block ? `A PreToolUse hook refused ${call.name}: ${c.block}` : `A PreToolUse hook refused ${call.name}.`;
      return refused(line, c.block || line);
    }
    // A rewrite is turned back into the tool's fields, and Tachikoma's checks look at it as if the model had sent it.
    let input = call.input;
    if (c.rewrite) {
      const back = fromClaude(call.name, c.rewrite.input, paths);
      if ("problem" in back) return refused(`A PreToolUse hook's rewrite of ${call.name} could not be used (${back.problem}): ${commandOf(c.rewrite.from)}`);
      input = back.input;
    }
    // The question names the call that would run, by its name and input, as Ctrl+O does (choice 15).
    let gate = this.opts.ctx.gate;
    if (c.decision === "ask") {
      // Where nobody can be asked, in never and -p, the refusal is a grey line too, as a deny's is (the user's choice,
      // 2026-11-09).
      const cannot = gate.hookCannotAsk(c.reason ?? "");
      if (cannot !== undefined) return refused(cannot);
      await gate.hookAsks(`${call.name} ${JSON.stringify(input)}`, c.reason ?? "");
      gate = gate.withHook({ asked: true });
    } else if (c.decision === "allow") gate = gate.withHook({ allow: true });
    // What runs is what the record keeps, saved before it runs (choice 16; design, review finding 4); the reply in the
    // history stays as the model sent it.
    if (c.rewrite) {
      entry.input = input;
      this.#transcript?.write({ t: "rewritten", id: call.id, input });
      this.#saving();
      for (const h of c.rewrite.ignored) {
        say(`Two PreToolUse hooks rewrote ${call.name}'s input; the first in the settings file was used, and ${commandOf(h)} was ignored.`);
      }
    }
    return { input, gate };
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
    this.#saving();
  }

  // Says once that saving stopped, in the approved line, so the screen, `-p` and the error log have it. Checked after the
  // session's own writes and at a load, which also catches a failed write the session did not make: Tasks' subagent line,
  // launch's start line or mend (release 8a plan, Task 5). A subagent's own file failing leaves the lead saving, so it has
  // its own line (user, 2026-11-06: "Its own line").
  #saving(): void {
    const t = this.#transcript;
    if (!t?.failed || this.#saidFailed) return;
    this.#saidFailed = true;
    const message = this.opts.subagent
      ? `Saving subagent ${this.id} stopped: ${t.file} could not be written (${t.failed}). ` +
        "A resumed session will report its answer as lost, and its conversation will end with an error if it grows too long for the model."
      : `Saving this session stopped: ${t.file} could not be written (${t.failed}). ` +
        "It cannot be resumed, and a conversation too long for the model will end with an error.";
    this.opts.bus.emit("error", { kind: "saving", attempted: t.file, message, lead: this.#lead.id });
  }
}

// The approved line for a shortening that failed (release 8a plan, "Lines this plan adds"); /compact's stop says it too.
export const cannot = (reason: string) => `The conversation could not be shortened (${reason}); it is unchanged.`;

function result(call: ToolCall, output: string, isError: boolean): ToolResult {
  return { type: "tool_result", callId: call.id, output, isError };
}
