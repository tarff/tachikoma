import { MAX_TOOL_OUTPUT } from "../exec/executor.js";
import { type Combined, commandOf } from "../hooks/answer.js";
import type { Event } from "../hooks/config.js";
import type { Hooks } from "../hooks/hooks.js";
import { errorOf, fromClaude, isMcp, outputFrom, type Paths, pathsFor, responseOf, toClaude } from "../hooks/tools.js";
import type { Offered, Servers } from "../mcp/servers.js";
import type { McpTools } from "../mcp/tools.js";
import type { Cache } from "../providers/pictures.js";
import { InvalidInput, type Tool, type ToolContext } from "../tools/tool.js";
import type { Bus, ToolOutcome } from "./bus.js";
import { characters, fits, Sizes } from "./fit.js";
import { type Ask, Declined, type PermissionGate, StoppedFirst, visible } from "./permissions.js";
import { CANCELLED, fit, type Shortening, shorten, type When } from "./shorten.js";
import type { Task } from "./tasks.js";
import { CUT_OFF, type Transcript } from "./transcript.js";
import {
  type CompletionRequest,
  errorText,
  type Image,
  keepThinking,
  madeUnder,
  type Message,
  marker,
  type Part,
  type Picture,
  type Provider,
  sentAll,
  type ToolCall,
  type ToolResult,
  type ToolSpec,
  type Turn,
} from "./types.js";

// Why /lead could not shorten the conversation when its transcript is not saved, for its refusal's line (release 8a
// design, "How shortening works", step 1).
export const UNSAVED = "saving this session stopped";

export function truncate(s: string): string {
  return s.length <= MAX_TOOL_OUTPUT ? s : `${s.slice(0, MAX_TOOL_OUTPUT)}\n[cut: ${s.length - MAX_TOOL_OUTPUT} more characters]`;
}

// `s` cut, as truncate cuts, so that with `around` more characters of a tool's output it all fits MAX_TOOL_OUTPUT, the
// cut's marker included, and the session's own cut leaves it whole: for a line that must follow it, such as a hook's stop
// after a subagent's answer (release 8b plan, Task 9's re-check).
export function truncateLeaving(s: string, around: number): string {
  const room = MAX_TOOL_OUTPUT - around;
  if (s.length <= room) return s;
  const marker = (n: number) => `\n[cut: ${n} more characters]`;
  // The marker for s.length is never shorter than the one given, whose count is smaller.
  const keep = Math.max(0, room - marker(s.length).length);
  return `${s.slice(0, keep)}${marker(s.length - keep)}`;
}

// What the model is told of a call a hook's continue: false came before, and of one it stopped while it ran (release 8b
// plan, "Lines this plan adds").
const NOT_RUN = "Not run: a hook stopped the turn.";
const STOPPED = "Stopped: a hook stopped the turn.";
// The grey line for a hook's continue: false, with its stopReason when it gave one (the same).
const stoppedTurn = (event: Event, reason: string) => (reason ? `A ${event} hook stopped the turn: ${reason}` : `A ${event} hook stopped the turn.`);
// Claude Code's hooks reference, "Stop input": Stop or SubagentStop blocks in a row, with no tool call between, before the
// turn ends anyway (release 8b plan, "Numbers in this plan").
const MAX_BLOCKS = 8;
// The heading of what a Stop or SubagentStop hook hands the model (release 8b plan, choice 8): Ctrl+O's last turn reads it
// (tui/describe.ts, lastTurn).
export const FEEDBACK = "Stop hook feedback:";
// What the model reads after "Stop hook feedback:" for a Stop or SubagentStop block with no reason (approved by the user,
// 2026-11-09).
const NO_REASON = "The hook gave no reason; carry on with the task.";
// The grey lines for a Stop or SubagentStop hook keeping the turn going, its reason when it gave one, never the text for the
// model (approved by the user, 2026-11-09), and for the turn ending at the limit; `id` names a subagent (release 8b plan,
// "Lines this plan adds").
const keptGoing = (id: string | undefined, reason: string) =>
  (id ? `A SubagentStop hook kept ${id} going` : "A Stop hook kept the turn going") + (reason ? `: ${reason}` : ".");
const keptTooOften = (id: string | undefined) =>
  `${id ? `SubagentStop hooks kept ${id} going` : "Stop hooks kept the turn going"} ${MAX_BLOCKS} times in a row; it ends here.`;
// The grey line for SessionStart's text left out of a shortening it would no longer let fit (release 8b plan, "Lines this
// plan adds"; Task 11).
const LEFT_OUT = "SessionStart hook text was left out: with it, the shortened conversation would not fit the model's window.";

// True once `p` has settled, false when `signal` stops the wait first: a turn waiting for SessionStart's hooks (Task 10).
const settled = (p: Promise<void>, signal?: AbortSignal) =>
  new Promise<boolean>((resolve) => {
    if (signal?.aborted) return resolve(false);
    const stop = () => resolve(false);
    signal?.addEventListener("abort", stop, { once: true });
    void p.then(() => {
      signal?.removeEventListener("abort", stop);
      resolve(true);
    });
  });

// How a turn ended, when a hook ended it (Session.send); `unsupplied`, when what the MCP servers supply for the prompt was
// not got, or a stop came while it was being got, so nothing was sent or saved (release 8c plan, Task 13).
export type Ended = { blocked: string } | { stopped: string; unsent?: true } | { unsupplied: true };

// What the MCP servers supply for a prompt, after its typed words (release 8c plan, Task 13; choice 34): a picked
// resource's text and pictures and a prompt command's messages, got under the turn's signal once the first prompt's wait
// for the servers and UserPromptSubmit are done; null when they could not be got, the caller saying why.
export type Supply = (signal?: AbortSignal) => Promise<Part[] | null>;

// One reply's calls (release 8b plan, Task 7): they run under `signal`, the reply's own, joined to the turn's; `stop` is a
// hook's continue: false, which stops them as a user's stop does, and `stopped` the first hook that said it. `pictures`:
// the calls' pictures, numbered, for after the results (release 8c plan, choice 10).
interface Round {
  signal: AbortSignal;
  stop(event: Event, reason: string): void;
  stopped?: { event: Event; reason: string };
  pictures: Image[];
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
  tasks?: { from(n: number): void; readonly all?: readonly Task[] }; // `all` gives Stop's background_tasks (release 8b plan, choice 21)
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
  // The MCP servers' tools (release 8c plan, Task 6; choice 9): each request takes one offer and sends its specs after
  // Tachikoma's own, and a reply's calls run on the tools that request offered, so each runs on the tool the model was
  // shown. `tool` makes the tool for one offered. The lead's offer holds every tool; a subagent's only trusted ones (Task 7).
  // The offer defines the tools loaded so far and gives tool_search, which loads the rest; `loaded` is the conversation's
  // set, saved here and replaced by a load (Task 6b; choices 37 and 41).
  mcp?: McpTools;
  // The MCP servers the launch's first prompt waits for, after SessionStart's hooks (release 8c plan, choice 25): `ready`
  // as Servers gives it; `waitingFor` names those still starting, for the waiting line. The lead's only.
  servers?: Pick<Servers, "ready" | "waitingFor">;
}

// A saved or new conversation for the session to take (release 8a plan, choice 1). `prompts` and `calls` come from the
// transcript's whole record, before and after its shortenings (choice 6); `nextPicture` and `nextTask` are the numbers
// its pictures and subagents leave free (choices 4 and 5). `loaded`: the MCP tools it loaded through tool_search, none
// when absent (release 8c plan, choice 41). `tools`: the tools its transcript was last saved under, which its replies kept
// with their thinking were made under; Tachikoma's own tools when absent (Task 6b's quality review).
export interface Conversation {
  id: string;
  messages: Message[];
  system: string;
  transcript?: Transcript;
  prompts: string[];
  calls: { name: string; input: unknown }[];
  nextPicture: number;
  nextTask: number;
  loaded?: string[];
  tools?: ToolSpec[];
  asked?: string[]; // the calls the user was asked about, read back from the transcript (release 8c plan, Task 15)
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
  // The calls of the conversation the user was asked about, by id, each saved as an asked line when its question opened,
  // so the window keeps their rows unfolded, live and once resumed (release 8c plan, Task 15). Refilled in place by a load.
  readonly asked = new Set<string>();
  #lead: Provider;
  #fallback: Provider | undefined;
  #running = false;
  // Shrunk copies of the conversation's pictures, kept for the session; each request, to the lead or the fallback,
  // still builds its own set from them (release 6 design, "What is sent, request by request").
  readonly #shrunk: Cache = new Map();
  // The providers the user said to send no pictures to, by id, for the session (release 6 design, "When the provider
  // refuses").
  readonly #refusedPictures = new Set<string>();
  // Run before a shortening's summary request: empty in 8a; 8d's memory save joins it (release 8a plan, choice 24). 8b's
  // PreCompact fires beside it, as its answer can stop the shortening (release 8b plan, Task 11).
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
  // The hooks' text waiting for the next request, SessionStart's (Task 10), sent at the start of the next user message
  // (Task 8).
  readonly #nextText: { event: Event; text: string }[] = [];
  // SessionStart's hooks still running (Task 10): the next turn waits for them, so their text reaches its request. `#stopStart`
  // stops them at a load or the session's end, never at a turn's stop, after which their text waits for the next turn. Only
  // its sync hooks take the stop: async ones are left running, as every event's are but SessionEnd's (hooks.ts).
  #starting: Promise<void> | undefined;
  #stopStart: AbortController | undefined;
  // The first prompt waits for the MCP servers still starting, once (choice 25); `#serverWait` stops that wait alone, so
  // Esc sends the prompt without the late ones (design, "Starting and stopping servers").
  #serversFirst: boolean;
  #serverWait: AbortController | undefined;
  // The MCP tools the request being made, or last made, offered, and its tool_search: its reply's calls run on these
  // (release 8c plan, choices 9 and 37).
  #offered: Offered[] = [];
  #search: Tool | undefined;
  // What each reply was made under, its request's system prompt and tools (types.ts, madeUnder), so each request sends
  // thinking only on the trailing run of replies made under its own (keepThinking); and the tools the transcript was last
  // saved under, so a request under others writes its tools line first, which a resume reads each reply's from (release
  // 8c plan, Task 6b's quality review: the user's choice, "Drop older thinking").
  readonly #under = new WeakMap<Message, string>();
  #savedTools: string;
  // The highest picture number the conversation has used, before and after its shortenings, so a tool's pictures are
  // numbered on from it and no number is used twice, as the transcript saves each picture under its number once (release
  // 8c plan, choice 10; release 8a plan, choice 5).
  #lastPicture = 0;

  constructor(private readonly opts: SessionOptions) {
    this.#lead = opts.lead;
    this.#fallback = opts.fallback;
    this.id = opts.id ?? "";
    this.system = opts.system;
    this.#transcript = opts.transcript;
    this.#serversFirst = opts.servers !== undefined;
    // A launch's start line holds Tachikoma's own tools.
    this.#savedTools = madeUnder("", this.#own());
  }

  #own(): ToolSpec[] {
    return this.opts.tools.map((t) => t.spec);
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
  // (user, 2026-11-06: "Keep for the window"). `keepRuns`: /branch's, the same conversation, whose last turn Ctrl+O still
  // shows with its hook runs (the user's choice, 2026-11-10).
  load(c: Conversation, opts: { keepRuns?: boolean } = {}): void {
    // A turn running would go on adding its messages and results to the conversation loaded.
    if (this.#running) throw new Error("A turn is already running");
    this.id = c.id;
    this.system = c.system;
    if (c.transcript !== this.#transcript) this.#saidFailed = false;
    this.#transcript = c.transcript;
    this.messages.splice(0, this.messages.length, ...c.messages);
    this.prompts.splice(0, this.prompts.length, ...c.prompts);
    this.asked.clear();
    for (const id of c.asked ?? []) this.asked.add(id);
    this.#hookText.splice(0); // the last conversation's hook text, not yet sent, is not this one's (Task 6's code review)
    this.#nextText.splice(0); // nor is the text waiting for its next request: SessionStart fires after the load (Task 10)
    this.#stopStarting(); // nor the text of SessionStart's hooks still running for it, which are stopped (Task 10's code review)
    // Nor its hook runs, a switch's SessionEnd among them, which Ctrl+O would list under this conversation's last turn; the
    // SessionStart fired after the load begins the new list (Task 12's code review).
    if (!this.opts.subagent && !opts.keepRuns) this.opts.hooks?.newTurn();
    // Nor its last prompt's id: the switch's SessionEnd, fired before the load, was sent it, and the SessionStart after
    // is sent none, as a launch's is (the user's choice, 2026-11-10; final review); /branch's too, as a fork's launch
    // sends none.
    if (!this.opts.subagent) this.opts.hooks?.forgetPrompt();
    this.calls.splice(0, this.calls.length, ...c.calls);
    // Its MCP tools loaded through tool_search, so a resume and /branch keep them and /clear starts with none (release 8c
    // plan, choice 41).
    this.opts.mcp?.loaded.clear();
    for (const name of c.loaded ?? []) this.opts.mcp?.loaded.add(name);
    // Its replies that kept their thinking were made under the tools it was last saved under (Task 6b's quality review).
    const tools = c.tools ?? this.#own();
    this.#savedTools = madeUnder("", tools);
    for (const m of c.messages) if (m.role === "assistant") this.#under.set(m, madeUnder(c.system, tools));
    // Its copies are keyed by picture number, so kept they would send the last conversation's picture 1 for this one's.
    this.#shrunk.clear();
    this.#sizes = new Sizes();
    this.#lastPicture = Math.max(c.nextPicture - 1, ...c.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "image" ? [p.id] : []))));
    this.opts.pictures?.from(c.nextPicture);
    this.opts.tasks?.from(c.nextTask);
    this.#saving(); // a write made before the load, such as launch's start line or mend
  }

  // The system prompt built afresh, for /clear (release 8a plan, Task 7): the instruction files read again, or without
  // systemNow the starting one.
  freshSystem(): Promise<string> {
    return this.opts.systemNow?.() ?? Promise.resolve(this.opts.system);
  }

  // Hooks' text for the model to go with the next request, at the start of the next user message: SessionStart's (release
  // 8b plan, Tasks 8 and 10).
  waitForNext(context: { event: Event; text: string }[]): void {
    this.#nextText.push(...context);
  }

  // SessionStart, once a conversation is loaded (release 8b plan, Task 10), matched on its source, with the lead as its
  // model (design, "What a hook is sent"). Not waited for here: the next turn waits for its hooks, so their text goes with
  // its request; a load or the session's end meanwhile stops its hooks and drops their text, as it was the last
  // conversation's. A shortening's (Task 11) is not fired here.
  start(source: "startup" | "resume" | "clear" | "fork"): void {
    const { hooks } = this.opts;
    if (!hooks) return;
    const stop = new AbortController();
    const fired: Promise<void> = hooks.fire("SessionStart", { source, model: this.#lead.id }, { match: source, signal: stop.signal }).then(
      (c) => {
        if (this.#starting !== fired) return;
        this.#starting = undefined;
        this.waitForNext(c.context);
      },
      // The Cancelled of a load's or an end's stop, or a listener of its lines that throws, which unheard would end
      // Tachikoma (hooks.ts).
      () => {
        if (this.#starting === fired) this.#starting = undefined;
      },
    );
    this.#starting = fired;
    this.#stopStart = stop;
  }

  // SessionEnd, as the session ends (Task 10), matched on its reason; its hooks share 1.5 s (hooks.ts). SessionStart's hooks
  // still running are stopped first (Task 10's code review). Refused while a turn runs, as a load is, so a switch that
  // cannot be made ends nothing: /resume's pick under a turn started under its list. The window's exit is let through
  // only as a guard: no exit happens during a turn, as /exit waits for it in the queue and the exit keys do nothing then
  // (keyRouting.ts), and were one to, the window would close all the same (queue.ts, leave). `signal`, a switch's Esc,
  // stops its hooks, saying nothing of them, as a stop during a turn says nothing, and the session ends all the same (the
  // user's choice, 2026-11-09: "Esc stops it"); the exit's SessionEnd has none.
  async end(reason: "prompt_input_exit" | "clear" | "resume" | "other", signal?: AbortSignal): Promise<void> {
    if (this.#running && reason !== "prompt_input_exit") throw new Error("A turn is already running");
    this.#stopStarting();
    try {
      await this.opts.hooks?.fire("SessionEnd", { reason }, { match: reason, signal });
    } catch (err) {
      if (!signal?.aborted) throw err;
    }
  }

  // Whether end(reason) would run a hook now, for a switch's working line (queue.ts, switchTo): never while a turn runs, as
  // end is refused then.
  ends(reason: "clear" | "resume" | "other"): boolean {
    return !this.#running && (this.opts.hooks?.has("SessionEnd", reason) ?? false);
  }

  #stopStarting(): void {
    this.#stopStart?.abort();
    this.#stopStart = undefined;
    this.#starting = undefined;
  }

  // The first prompt's wait for the MCP servers (choice 25), made once: false when the turn's own signal stopped it, so
  // nothing is sent; true once none is starting, or when Esc stopped this wait alone (stopWaiting). Either stop leaves
  // those still starting to say when they are ready (Servers, ready).
  async #serversReady(signal?: AbortSignal): Promise<boolean> {
    this.#serversFirst = false;
    const wait = new AbortController();
    const stop = () => wait.abort();
    if (signal?.aborted) stop();
    signal?.addEventListener("abort", stop, { once: true });
    this.#serverWait = wait;
    try {
      await this.opts.servers!.ready(wait.signal);
    } finally {
      signal?.removeEventListener("abort", stop);
      this.#serverWait = undefined;
    }
    return !signal?.aborted;
  }

  // The MCP servers the first prompt waits for now, escaped, for the waiting line (choice 25); none outside that wait.
  waitingFor(): string[] {
    return this.#serverWait ? this.opts.servers!.waitingFor() : [];
  }

  // Esc while the first prompt waits for the MCP servers: it is sent without those still starting, whose tools join a
  // later request once they are ready (design, "Starting and stopping servers").
  stopWaiting(): void {
    this.#serverWait?.abort();
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
      this.#offer();
      const lead = this.#lead;
      const now = await this.#window(lead, signal);
      const then = await this.#window(next, signal);
      if (now === undefined || then === undefined) return CANCELLED;
      if (then === null || (now !== null && then >= now)) return;
      const over = await this.#over(lead, then, signal);
      if (over === undefined) return CANCELLED;
      if (!over) return;
      // SessionStart compact's model is `next`, the lead that reads its text once the switch is made (Task 11's code review).
      const r = await this.#shorten(lead, "between", then, signal, undefined, undefined, next.id);
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
      this.#offer();
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
  // among its text (release 6 plan, Task 14). How the turn ended: `blocked`, a UserPromptSubmit hook's block, with its
  // reason, nothing sent or saved; `stopped`, a hook's continue: false, with its stopReason ("" when none), and `unsent`
  // when it came at UserPromptSubmit, nothing sent or saved either; nothing otherwise (release 8b plan, choice 17).
  // `supply`: the MCP servers' parts for the prompt (release 8c plan, Task 13), the window's only.
  async send(text: string | Part[], signal?: AbortSignal, supply?: Supply): Promise<Ended | void> {
    // Two turns at once would interleave their messages and tool results in the history.
    if (this.#running) throw new Error("A turn is already running");
    this.#running = true;
    try {
      return await this.#turn(typeof text === "string" ? (text ? [{ type: "text", text }] : []) : text, signal, supply);
    } finally {
      this.#running = false;
    }
  }

  async #turn(typed: Part[], signal?: AbortSignal, supply?: Supply): Promise<Ended | void> {
    const { bus, hooks } = this.opts;
    // SessionStart's hooks answer first, so their text goes with this request; a stop meanwhile sends and saves nothing and
    // says nothing, as a stop during UserPromptSubmit's does, and their text waits for the next one (Task 10).
    // The launch's first prompt waits for the MCP servers too, through the same wait, so one stop ends both, those still
    // starting saying when they are ready (choice 25); an Esc during the servers' wait alone sends the prompt without them.
    if (this.#starting && !(await settled(this.#starting, signal))) {
      // The wait made with the stop's signal ends at once (Servers, ready).
      if (this.#serversFirst) {
        this.#serversFirst = false;
        void this.opts.servers!.ready(signal);
      }
      return;
    }
    if (this.#serversFirst && !(await this.#serversReady(signal))) return;
    // A picture is its marker in its place, so the prompt is the words as typed, and none of the picture's data is kept. A
    // part a server supplied, a picture or a resource's or prompt's text, is not the user's (release 8c plan, choice 34).
    const words = typed
      .flatMap((p) => (p.type === "image" && p.from === undefined ? [marker(p.id)] : p.type === "text" && p.from === undefined ? [p.text] : []))
      .join("");
    // Ctrl+O's list of this turn's hook runs starts here, before UserPromptSubmit, for a turn of background answers alone
    // too (release 8b plan, Task 12's code review). A subagent's runs are its own Hooks' (hooks.ts, for). A fresh
    // conversation's first turn begins it with SessionStart's runs that have answered, which Ctrl+O listed before the
    // first prompt; an async one that answers later goes to the list before it, a known limit. A prompt that starts no
    // turn, one a UserPromptSubmit hook blocks or leaves unsent, or the user stops while its hooks run, puts back the
    // list Ctrl+O listed before, so it always shows one whole turn (the user's choices, 2026-11-10; final review).
    const before = this.opts.subagent ? undefined : hooks?.runs;
    if (before) hooks!.newTurn(this.messages.length ? [] : before.filter((r) => r.event === "SessionStart"));
    // The user's own prompt only: a subagent's brief is the lead's (release 8b design, "The events"). Before anything is
    // kept, pushed or taken, so a block or a stop sends and saves nothing, and the waiting text stays for the next prompt.
    const prompted = words && !this.opts.subagent && hooks ? await this.#userPromptSubmit(hooks, words, signal) : [];
    if (!Array.isArray(prompted)) {
      if (before) hooks!.restoreRuns(before);
      return prompted;
    }
    // Got only now, once the servers the first prompt waits for have started and a hook has let the prompt through, so a
    // blocked prompt asks no server for anything (Task 13); one not got sends and saves nothing, as a block does.
    const supplied = supply ? await supply(signal) : [];
    if (supply && (supplied === null || signal?.aborted)) {
      if (before) hooks!.restoreRuns(before);
      return { unsupplied: true };
    }
    if (words && !this.opts.subagent) this.prompts.push(words);
    const own: Part[] = [...typed, ...(supplied ?? []), ...prompted, ...this.#waiting()];
    if (!own.length) return;
    // The text waiting for the next request goes first (Task 8), taken so it goes into exactly one message.
    const parts: Part[] = [...this.#hookParts(this.#nextText), ...own];
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
    // `blocks`: the Stop or SubagentStop hooks that kept the turn going since its last reply with a call; `kept`: one did in
    // this turn, for their stop_hook_active (release 8b plan, Task 9).
    let blocks = 0;
    let kept = false;
    for (;;) {
      const lead = this.#lead;
      // Not waited for when the lead has no window to look up. A test-timing constraint: app.test.tsx's "hands the lead a
      // failure during its turn" has a subagent whose request fails at once reach the lead's next request, which an extra
      // wait before that subagent's request would make it miss.
      const window = lead.contextWindow ? await this.#window(lead, signal) : null;
      if (window === undefined) return; // stopped
      // This request's MCP tools, which its size check, any shortening for it, a fallback's answer and its calls share.
      this.#offer();
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
      // With the lead that answered: the fallback that rescued a refusal, or the model the provider says served it. Made
      // under this request's system prompt and tools, which this request's offer still gives (Task 6b's quality review).
      const answer: Message = { role: "assistant", parts: turn.parts, native: turn.native, lead: turn.servedBy ?? answeredBy.id };
      this.#under.set(answer, madeUnder(this.system, this.#specs()));
      this.#push(answer);

      const calls = turn.parts.filter((p) => p.type === "tool_call");
      if (turn.cutOff) {
        bus.emit("error", { kind: turn.cutOff.kind, attempted: `response from ${answeredBy.id}`, message: turn.cutOff.detail, lead: lead.id });
        // Every tool call needs a result before the next request, even ones we refuse to run.
        if (calls.length) {
          this.#push({ role: "user", parts: calls.map((c) => result(c, `${CUT_OFF}${turn.cutOff!.detail}).`, true)) });
        }
        return;
      }
      if (calls.length === 0) {
        // The turn's normal end (release 8b design, "The events"): a block, or text for the model, keeps it going, the
        // model reading it next, as Claude Code's "Stop hook feedback" (choice 8), until the limit in a row.
        const c = hooks ? await this.#stop(hooks, turn.parts, kept, signal) : undefined;
        // A stop as they answered sends nothing more, as any stop does (Task 9's code review).
        if (!c || signal?.aborted) return;
        const id = this.opts.subagent ? this.id : undefined;
        if (c.stop !== undefined) {
          bus.emit("hook-note", stoppedTurn(id ? "SubagentStop" : "Stop", c.stop));
          return { stopped: c.stop };
        }
        // A block with no reason tells the model to carry on (the user's choice, 2026-11-09).
        const given = [...(c.block !== undefined ? [c.block || NO_REASON] : []), ...c.context.map((x) => x.text)];
        if (!given.length) return;
        // Both lines name the subagent already, so Tasks says them without its id in front (the user's choice, 2026-11-09).
        if (blocks === MAX_BLOCKS) return void bus.emit("hook-note", keptTooOften(id), true);
        blocks++;
        kept = true;
        bus.emit("hook-note", keptGoing(id, c.block ?? ""), true);
        const said: Part[] = given.map((text) => ({ type: "text", text: `${FEEDBACK}\n${text}`, from: "hooks" }));
        this.#push({ role: "user", parts: [...said, ...this.#waiting()] });
        when = "during";
        shortened = false;
        continue;
      }
      blocks = 0;
      // Kept for the judge in the reply's order, before any runs, as delegate's calls start before the others. A hook's
      // rewrite replaces its call's entry before the call runs (#execute).
      const entries = calls.map((c) => ({ name: c.name, input: c.input }));
      this.calls.push(...entries);
      // A call with an asked call's id is another call, as a provider may use an id again (release 8c plan, Task 15).
      for (const c of calls) this.asked.delete(c.id);

      // The reply's calls run under a signal of its own, joined to the turn's, so a hook's continue: false stops them as a
      // user's stop does, a running delegate ending as a stopped one (release 8b plan, Task 7; design, review finding 1).
      const halt = new AbortController();
      const join = () => halt.abort();
      signal?.addEventListener("abort", join, { once: true });
      if (signal?.aborted) halt.abort();
      const round: Round = {
        signal: halt.signal,
        pictures: [],
        // The first stop wins, so a user's that came first keeps its words (Task 7's code review).
        stop: (event, reason) => {
          if (halt.signal.aborted) return;
          round.stopped = { event, reason };
          halt.abort();
        },
      };
      // Calls of a side-by-side tool (delegate) all start first, together; the rest run one after
      // another, MCP calls among them. The results go back in the reply's order, then the calls' pictures (release 8c plan,
      // choice 10), then the hooks' text for the model, so a stopped turn's text is never the next one's (Task 6's review),
      // then whatever is waiting for the lead, after the last tool result, as the providers want it.
      const results: ToolResult[] = new Array(calls.length);
      // The loaded set before the calls, so a search that grows it is saved (release 8c plan, choice 41).
      const loaded = this.opts.mcp?.loaded.size;
      try {
        // tool_search runs alongside the others too (release 8c plan, choice 44).
        const parallel = (name: string) => (this.opts.tools.find((t) => t.spec.name === name) ?? (this.#search?.spec.name === name ? this.#search : undefined))?.parallel;
        const together = calls.map((c, i) => (parallel(c.name) ? this.#runTool(c, entries[i]!, round).then((r) => (results[i] = r)) : null));
        // Each is handled now, so one that fails while a call after it runs is no unhandled rejection; Promise.all below
        // still rejects with it (Task 7's code review).
        for (const p of together) p?.catch(() => {});
        for (const [i, call] of calls.entries()) if (!together[i]) results[i] = await this.#runTool(call, entries[i]!, round);
        await Promise.all(together);
      } finally {
        signal?.removeEventListener("abort", join);
      }
      this.#push({ role: "user", parts: [...results, ...round.pictures, ...this.#hookParts(), ...this.#waiting()] });
      // The set whenever a search grew it, after the results' line (release 8c plan, Task 6b).
      if (this.opts.mcp && this.opts.mcp.loaded.size !== loaded) {
        this.#transcript?.write({ t: "loaded", names: [...this.opts.mcp.loaded] });
        this.#saving();
      }
      // Every call has its one result, saved, before the turn ends (design, review finding 1).
      if (round.stopped) {
        const { event, reason } = round.stopped;
        bus.emit("hook-note", stoppedTurn(event, reason));
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
    // Its tools, when they are not the ones last saved, before its reply's line, so a resume reads what each reply was made
    // under (Task 6b's quality review), in 8a's tools line.
    const tools = madeUnder("", req.tools);
    if (tools !== this.#savedTools) {
      this.#transcript?.write({ t: "tools", tools: req.tools });
      this.#savedTools = tools;
      this.#saving();
    }
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
    const tools = this.#specs();
    return {
      system: this.system,
      messages: sentAll(this.#kept(tools)),
      tools,
      signal,
      shrunk: this.#shrunk,
      ...(this.#refusedPictures.has(provider.id) ? { refusedBy: provider.id } : {}),
    };
  }

  // Tachikoma's own tools' specs, then tool_search's, then the MCP tools' this request defines (release 8c plan, choices 9
  // and 37).
  #specs(): ToolSpec[] {
    return [...this.opts.tools.map((t) => t.spec), ...(this.#search ? [this.#search.spec] : []), ...this.#offered.map((o) => o.spec)];
  }

  // The history as a request under `tools` sends it: Anthropic's thinking only on the trailing run of replies made under
  // them and this system prompt (keepThinking). Only Anthropic's is left out: the OpenAI-format providers' own content is
  // not bound so, and some of them want a tool call's reasoning sent back with it.
  #kept(tools: ToolSpec[]): Message[] {
    const now = madeUnder(this.system, tools);
    return keepThinking(this.messages, (m) => this.#under.get(m), now, (m) => m.native?.provider === "anthropic");
  }

  // The MCP tools for the request about to be made, taken once for it (choice 9).
  #offer(): void {
    const offer = this.opts.mcp?.offer();
    this.#offered = offer?.defined ?? [];
    this.#search = offer?.search;
  }

  // A call's tool: Tachikoma's own first, then the request's tool_search, then the MCP tool the request offered under that
  // name, so the call runs on the tool the model was shown (release 8c plan, choice 9; design, finding 4).
  #tool(name: string): Tool | undefined {
    const own = this.opts.tools.find((t) => t.spec.name === name);
    if (own) return own;
    if (this.#search?.spec.name === name) return this.#search;
    const offered = this.#offered.find((o) => o.spec.name === name);
    return offered && this.opts.mcp?.tool(offered);
  }

  // A tool's pictures (release 8c plan, choice 10), numbered on from the highest number the conversation has used, kept in
  // the round for after the results and marked as the server's (choice 34); the window's Pictures numbers on after them.
  // The text ends with a line naming them, cut so that the line still fits MAX_TOOL_OUTPUT.
  #pictured(ran: { text: string; pictures: Picture[] }, round: Round): string {
    if (!ran.pictures.length) return truncate(ran.text);
    const images = ran.pictures.map((p): Image => ({ type: "image", id: ++this.#lastPicture, mediaType: p.mediaType, data: p.data, from: "server" }));
    round.pictures.push(...images);
    this.opts.pictures?.from(this.#lastPicture + 1);
    const line = `[The tool's answer has pictures: ${images.map((p) => marker(p.id)).join(", ")}]`;
    return ran.text ? `${truncateLeaving(ran.text, line.length + 1)}\n${line}` : line;
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
  // shorten.ts words it, nothing changed either. `focus` is /compact's words, "" when it gives none, and set for /compact
  // alone, so the hooks' trigger is "manual" for /compact only and "auto" for /lead's and the turn's (release 8b plan,
  // choice 20). `model` is SessionStart compact's, the lead's unless given.
  async #shorten(
    lead: Provider,
    when: When,
    window: number | null,
    signal?: AbortSignal,
    asked?: Message,
    focus?: string,
    model = this.#lead.id,
  ): Promise<"done" | "unsaved" | { problem: string }> {
    const { bus, hooks } = this.opts;
    const t = this.#transcript;
    if (!t || t.failed !== null) return "unsaved";
    for (const f of this.onShorten) f();
    const trigger = focus === undefined ? "auto" : "manual";
    // PreCompact beside onShorten, before the summary request (Task 11): a block changes nothing, 8a's line giving its
    // reason, and without one, or with one only blank, ending at "blocked it" (the user's choice, 2026-11-09: "Drop the
    // colon"); its plain text joins the focus, after /compact's words (design, "What a hook's answer does").
    let instructions: string[] = [];
    if (hooks) {
      const c = await this.#aroundShortening(hooks, "PreCompact", { trigger, custom_instructions: focus || null }, trigger, signal);
      if (!c) return { problem: CANCELLED };
      // Trimmed, so no white space of the reason lands inside 8a's parentheses (Task 11's code review), and escaped as
      // every hook line is, so a line break in it cannot pass for a line of Tachikoma's (the user's choice, 2026-11-10;
      // final review).
      const reason = c.block?.trim();
      if (reason !== undefined) return { problem: `a PreCompact hook blocked it${reason ? `: ${visible(reason, { tabs: true })}` : ""}` };
      instructions = c.instructions;
    }
    const focused = [focus, ...instructions].filter(Boolean).join("\n\n");
    const tools = this.#specs(); // the same offer as the request it is made for (release 8c plan, choice 9)
    const s: Shortening = {
      lead,
      system: this.system,
      // Its summary requests replay the history, so their thinking goes as the request's would (Task 6b's quality review).
      messages: this.#kept(tools),
      ...(asked ? { asked } : {}),
      ...(focused ? { focus: focused } : {}),
      tools,
      calls: this.calls,
      workspace: this.opts.ctx.workspace,
      sizes: this.#sizes,
      window: window ?? Infinity, // not known: every fit passes, and the "too long" answer is the safety net
      ...(signal ? { signal } : {}),
      shrunk: this.#shrunk,
      ...(this.#refusedPictures.has(lead.id) ? { refusedBy: lead.id } : {}),
      // Counted as the judge's is, apart from the conversation's context (stats.ts).
      onUsage: (u) => bus.emit("usage", { ...u, summary: true }),
    };
    const r = await shorten(s, when);
    if ("problem" in r) return r;
    let message = r.messages[0]!;
    // PostCompact, then SessionStart compact, once the summary is made and before it is saved (Task 11; plan review,
    // 2026-11-09, finding 2). SessionStart's text joins the new history's one message, first, as it goes first in the
    // next request's message (Task 8), so it is saved with the shortening and goes with the very next request, never
    // through the queue for the next request. shorten() checked the message against the window without it, and a turn
    // shortens once a request, so it is checked again with the text; one that no longer fits is left out, with its line,
    // never cut, as no part of a hook's text is safe to drop (second round, finding 2). A subagent's shortening fires
    // PostCompact alone: SessionStart is about the user's session (the user's choice, 2026-11-09: "Pre/Post only").
    // `leftOut`: the line is said once the shortening is saved, so one that is then stopped or cannot be written says
    // nothing of it (Task 11's code review).
    let leftOut = false;
    if (hooks) {
      if (!(await this.#aroundShortening(hooks, "PostCompact", { trigger, compact_summary: r.summary }, trigger, signal))) return { problem: CANCELLED };
    }
    if (hooks && !this.opts.subagent) {
      const c = await this.#aroundShortening(hooks, "SessionStart", { source: "compact", model }, "compact", signal);
      if (!c) return { problem: CANCELLED };
      const text = this.#hookParts([...c.context]);
      if (text.length) {
        const joined: Message = { ...message, parts: [...text, ...message.parts] };
        let room: boolean;
        try {
          room = await fit(s, joined);
        } catch (err) {
          if (signal?.aborted) return { problem: CANCELLED }; // fits() lets a stop through
          throw err;
        }
        if (room) message = joined;
        else leftOut = true;
      }
    }
    // The new history goes with a system prompt built afresh, both in one line, so the shortening is saved whole or not
    // at all (choices 3 and 4). A line that cannot be written changes nothing, though the hooks above have run (a known
    // limit, Task 13).
    const system = await this.freshSystem();
    if (signal?.aborted) return { problem: CANCELLED }; // a stop while the files were read changes nothing either
    t.write({ t: "shortened", system, message });
    if (t.failed !== null) {
      this.#saving();
      return "unsaved";
    }
    this.system = system;
    this.messages.splice(0, this.messages.length, message);
    if (leftOut) bus.emit("hook-note", LEFT_OUT);
    bus.emit("shortened", r.summary);
    return "done";
  }

  // One of the events around a shortening (release 8b plan, Task 11), matched on its trigger or SessionStart's source,
  // under the shortening's signal. Undefined when a stop ended its hooks (run.ts), which changes nothing, as any stop
  // during a shortening does.
  async #aroundShortening(hooks: Hooks, event: Event, fields: object, match: string, signal?: AbortSignal): Promise<Combined | undefined> {
    try {
      return await hooks.fire(event, fields, { match, signal });
    } catch (err) {
      if (signal?.aborted) return undefined;
      throw err;
    }
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
    const tool = this.#tool(call.name);
    if (!tool) return fail(`Unknown tool: ${call.name}`);
    const { hooks } = this.opts;
    let parts: unknown; // the result's parts as the tool reported them, for the shape hooks are sent (choice 12)
    let started: number | undefined; // unset: the tool never started
    let text: string;
    let ms: number;
    let pictures: Image[] = []; // this call's in the round, which a hook's replaced output drops (release 8c plan, choice 20)
    try {
      // A stop while a PreToolUse hook runs kills it and rejects, so the call is cancelled below, as any stop (run.ts). The
      // call's own gate marks it asked when a question about it opens (Task 15); not once a stop came, as the window then
      // drops the question unshown (App.tsx, bindAsk).
      const own = this.opts.ctx.gate.noting(() => {
        if (!signal.aborted) this.#asked(call.id);
      });
      const pre = hooks ? await this.#preToolUse(call, entry, hooks, own, signal) : { input: call.input, gate: own };
      if ("stop" in pre) {
        round.stop("PreToolUse", pre.stop);
        return stopped(NOT_RUN);
      }
      if ("refused" in pre) return [result(call, pre.refused, true), "declined"];
      // Only when a hook after the call matches it, so a write with no such hook does not read the file first (files.ts).
      // A plain capture, which cannot throw into the tool (Task 5's code review).
      let report: Pick<ToolContext, "report"> = {};
      if (hooks) {
        const name = toClaude(entry, this.#hookPaths()).tool_name;
        if (hooks.has("PostToolUse", name) || hooks.has("PostToolUseFailure", name)) report = { report: (p: unknown) => void (parts = p) };
      }
      // A yes to a hook's own question, given after a hook stopped the turn, runs nothing either (Task 7's code review).
      if (signal.aborted) return stopped(NOT_RUN);
      started = Date.now();
      const ran = await tool.run(pre.input, { ...this.opts.ctx, gate: pre.gate, signal, ...report });
      const before = round.pictures.length; // #pictured adds this call's at once, so those after `before` are its own
      text = typeof ran === "string" ? truncate(ran) : this.#pictured(ran, round);
      pictures = round.pictures.slice(before);
      ms = Date.now() - started;
    } catch (err) {
      // Ctrl-C at a question declines it and stops the turn: the call was cancelled, not declined.
      // Cut as a failure's is: a hook's question names the call with its whole input, a write's content included.
      if (err instanceof Declined) return [result(call, truncate(err.message), true), signal.aborted ? "cancelled" : "declined"];
      // Not a failure, so not logged. A yes after the stop ran nothing, though the tool had started (Task 7's re-check).
      if (signal.aborted) return stopped(started === undefined || err instanceof StoppedFirst ? NOT_RUN : STOPPED);
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
    // 13). The outcome stays the call's own. For an MCP call a string in either field replaces it, updatedMCPToolOutput's
    // first, and the text replaced takes the answer's pictures with it, as they were part of it (release 8c plan, choice
    // 20); their numbers stay used, so no later picture takes one the hooks were sent.
    const mcp = c && isMcp(call.name) ? outputFrom(call.name, c.mcpOutput) : null;
    const output = mcp ?? (c && "output" in c ? outputFrom(call.name, c.output) : null);
    if (output !== null) round.pictures = round.pictures.filter((p) => !pictures.includes(p));
    return [result(call, output === null ? text : truncate(output), false), "ok"];
  }

  // PostToolUse or PostToolUseFailure after a call that ran (release 8b plan, Task 7; design, "Tool hooks"), sent the input
  // that ran, matched on the tool's Claude Code name, under the reply's signal. Its text for the model waits for the reply's
  // results, and its continue: false stops the reply's calls. Undefined when a stop ended its hooks (run.ts), or anything
  // else threw, so the call keeps its own result and the history stays paired (Task 7's code review).
  async #postToolUse(
    hooks: Hooks,
    event: "PostToolUse" | "PostToolUseFailure",
    call: ToolCall,
    entry: { name: string; input: unknown },
    fields: object,
    round: Round,
  ): Promise<Combined | undefined> {
    let c: Combined;
    try {
      const { tool_name, tool_input } = toClaude(entry, this.#hookPaths());
      c = await hooks.fire(event, { tool_name, tool_input, tool_use_id: call.id, ...fields }, { match: tool_name, signal: round.signal });
    } catch (err) {
      if (round.signal.aborted) return undefined;
      // Such as a listener of the hooks' lines that throws: a hook failure's red line, in its words with the error's own.
      const message = `${event} hook failed: ${errorText(err)}`;
      this.opts.bus.emit("error", { kind: "hook", attempted: `${event} hook`, message, lead: this.#lead.id });
      return undefined;
    }
    this.#hookText.push(...c.context);
    if (c.stop !== undefined) round.stop(event, c.stop);
    return c;
  }

  // The paths hooks are sent: the launch's, or without them ctx.root's on the host (SessionOptions.paths).
  #hookPaths(): Paths {
    return this.opts.paths ?? pathsFor(this.opts.ctx.root, null);
  }

  // The text the tool hooks handed the model during the reply, or the text in `held`, one part each, headed by its event
  // (release 8b plan, choice 6), taken so it goes into exactly one message.
  #hookParts(held = this.#hookText): Part[] {
    return held.splice(0).map(({ event, text }) => ({ type: "text", text: `${event} hook:\n${text}`, from: "hooks" }));
  }

  // UserPromptSubmit before the prompt goes (release 8b plan, Task 8; design, "What a hook's answer does"), each prompt with
  // a prompt id of its own, sent the prompt with each picture as its marker, under the turn's signal and the event's 30 s
  // limit (hooks.ts). Its text for the model, to join the prompt's message; how the turn ended, at a block or a continue:
  // false, with its grey line; or undefined when the user's stop ended its hooks (run.ts).
  async #userPromptSubmit(hooks: Hooks, prompt: string, signal?: AbortSignal): Promise<Part[] | Ended | undefined> {
    hooks.newPrompt();
    let c: Combined;
    try {
      c = await hooks.fire("UserPromptSubmit", { prompt }, { signal });
    } catch (err) {
      if (signal?.aborted) return undefined;
      throw err;
    }
    // A stop wins over a block (combine).
    // `unsent`: the prompt was not sent, so the window gives its words back, as for a block (approved by the user,
    // 2026-11-09).
    if (c.stop !== undefined) {
      this.opts.bus.emit("hook-note", stoppedTurn("UserPromptSubmit", c.stop));
      return { stopped: c.stop, unsent: true };
    }
    // No reason: its own words (approved by the user, 2026-11-09).
    if (c.block !== undefined) {
      this.opts.bus.emit("hook-note", c.block ? `A UserPromptSubmit hook blocked the prompt: ${c.block}` : "A UserPromptSubmit hook blocked the prompt.");
      return { blocked: c.block };
    }
    return this.#hookParts([...c.context]);
  }

  // Stop at the lead's turn's normal end, SubagentStop at a subagent's (release 8b plan, Task 9; design, "What a hook is
  // sent"), sent the reply's words and whether a hook kept this turn going before, under the turn's signal. A subagent's is
  // matched on its Claude Code name, as SubagentStart's is, its agent_id and agent_type among the common fields (hooks.ts).
  // Undefined when the user's stop ended its hooks (run.ts).
  async #stop(hooks: Hooks, reply: Part[], active: boolean, signal?: AbortSignal): Promise<Combined | undefined> {
    const last_assistant_message = reply.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
    // Each background subagent running or waiting, as choice 21 gives it: one waiting for a place is reported "running" on
    // purpose, as that choice says. Crons Tachikoma has none of (design).
    const background_tasks = (this.opts.tasks?.all ?? [])
      .filter((t) => t.background && (t.state === "running" || t.state === "waiting"))
      .map((t) => ({ id: t.id, type: "agent", status: "running", description: t.description, agent_type: "Explore" }));
    try {
      if (this.opts.subagent) {
        const fields = { agent_transcript_path: this.#transcript?.file, last_assistant_message, stop_hook_active: active };
        return await hooks.fire("SubagentStop", fields, { match: "Explore", signal });
      }
      return await hooks.fire("Stop", { stop_hook_active: active, last_assistant_message, background_tasks, session_crons: [] }, { signal });
    } catch (err) {
      if (signal?.aborted) return undefined;
      throw err;
    }
  }

  // PreToolUse before a call (release 8b plan, Task 6; design, "Tool hooks"), matched on the tool's Claude Code name, under
  // the turn's signal. The input to run and the gate to run it with, or what the model is told of a refusal. The lines
  // name the tool as the rest of the window does (choice 10).
  async #preToolUse(
    call: ToolCall,
    entry: { name: string; input: unknown },
    hooks: Hooks,
    given: PermissionGate,
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
    let gate = given;
    if (c.decision === "ask") {
      // Where nobody can be asked, in never and -p, the refusal is a grey line too, as a deny's is (the user's choice,
      // 2026-11-09); an MCP call's, the request's own MCP tool, is asked in never (release 8c plan, choice 47).
      const mcp = !this.opts.tools.some((t) => t.spec.name === call.name) && this.#offered.some((o) => o.spec.name === call.name);
      const cannot = gate.hookCannotAsk(c.reason ?? "", mcp);
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

  // A call the user is shown a question for, saved once (Task 15).
  #asked(id: string): void {
    if (this.asked.has(id)) return;
    this.asked.add(id);
    this.#transcript?.write({ t: "asked", id });
    this.#saving();
  }

  #waiting(): Part[] {
    return (this.opts.inbox?.() ?? []).map((text) => ({ type: "text", text, from: "tasks" }));
  }

  // The line is written before the event, so every message is on disk before anything else sees it (release 8a plan,
  // choice 4). A failed write stops saving and never the turn (transcript.ts).
  #push(message: Message): void {
    for (const p of message.parts) if (p.type === "image") this.#lastPicture = Math.max(this.#lastPicture, p.id);
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
