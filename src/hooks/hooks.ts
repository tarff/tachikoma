import { randomUUID } from "node:crypto";
import type { Bus } from "../core/bus.js";
import type { Mode } from "../core/permissions.js";
import type { Effort } from "../providers/anthropic.js";
import { type Combined, combine, commandOf, type Outcome, outcomeOf } from "./answer.js";
import { type Event, type Hook, type HooksConfig, matches } from "./config.js";
import { type Ran, runHook } from "./run.js";

// The object a session fires events through (release 8b plan, Task 4): it picks the event's hooks, runs them at once,
// sends each the common fields in Claude Code's names, combines their answers, and says their failures and messages.
// What else an answer does is said by the caller that acts on it.

// `lead` names the model leading, which every error on the bus carries for the error log.
export interface Where {
  sessionId: () => string;
  transcript: () => string | undefined;
  root: string;
  mode: () => Mode;
  effort: () => Effort | undefined;
  lead: () => string;
  agent?: { id: string; transcript?: string };
}
// For Ctrl+O (release 8b plan, choice 24); `match`, what the event's matchers were matched against, names a tool hook's
// tool, for the line saying its updatedToolOutput was not used.
export interface Run { event: Event; hook: Hook; ran: Ran; outcome: Outcome; match?: string }

// Each mode under its nearest Claude Code name (release 8b design, "What a hook is sent").
export const MODE_NAMES: Record<Mode, string> = { ask: "default", project: "acceptEdits", auto: "auto", never: "bypassPermissions" };

// Claude Code's hooks reference, "Common fields": a hook's time limit is its timeout, or 600 s, or 30 s at UserPromptSubmit.
const LIMIT = 600;
const PROMPT_LIMIT = 30;
// The same: SessionEnd's hooks share 1.5 s, which a hook's own longer timeout raises, to 60 s at most.
const END_LIMIT = 1.5;
const END_MOST = 60;

// A hook's own time limit in seconds, as fire gives it; at SessionEnd, as when it runs alone, since a longer timeout among
// the hooks run with it raises their shared 1.5 s (fire). /hooks lists it (release 8b plan, "Lines this plan adds").
export const limitOf = (hook: Hook): number =>
  hook.event === "SessionEnd" ? Math.min(END_MOST, hook.timeout ?? END_LIMIT) : (hook.timeout ?? (hook.event === "UserPromptSubmit" ? PROMPT_LIMIT : LIMIT));

// Two entries are the same hook when every field of the entry is (release 8b design, "Running a hook"; review,
// 2026-11-09, finding 3); its event, matcher and place are not fields of the entry.
const entry = (h: Hook) => JSON.stringify([h.command, h.args, h.shell, h.timeout, h.async, h.onFailure, h.statusMessage]);

// Whether `hook` runs at `event` for `match`; without one, only a hook that matches everything does.
const runsFor = (hook: Hook, event: Event, match?: string) =>
  hook.event === event && (match === undefined ? "all" in hook.matcher : matches(hook.matcher, match));

// Held by the lead's Hooks and every subagent's, so a live edit reaches them all, and a subagent, which has no prompt of
// its own, sends the lead's prompt id.
interface Shared {
  config: HooksConfig;
  promptId?: string;
}

export class Hooks {
  #shared: Shared;
  #where: Where;
  #bus: Bus;
  #runs: Run[] = [];

  constructor(config: HooksConfig, where: Where, bus: Bus) {
    this.#shared = { config };
    this.#where = where;
    this.#bus = bus;
  }

  // A live edit (Task 12), from the next fire on; a fire under way finishes with the hooks it began with.
  set(config: HooksConfig): void {
    this.#shared.config = config;
  }

  get config(): HooksConfig {
    return this.#shared.config;
  }

  // This turn's runs, each added once it has answered, an async hook's to the turn it started in. A subagent's are its own,
  // as Ctrl+O lists the lead's turn.
  get runs(): Run[] {
    return this.#runs;
  }

  // A new list of runs, at each lead turn before its UserPromptSubmit, a turn of background answers alone too, and at a
  // load, so Ctrl+O lists exactly the runs of the turn it shows (Task 12's code review). A fire under way adds its runs
  // to the list it began with.
  newTurn(): void {
    this.#runs = [];
  }

  // A subagent's: the same hooks, its own fields and bus.
  for(agent: { id: string; transcript?: string }, bus: Bus): Hooks {
    const hooks = new Hooks(this.#shared.config, { ...this.#where, agent }, bus);
    hooks.#shared = this.#shared;
    return hooks;
  }

  // A new prompt_id for each prompt the user sends (release 8b design, "What a hook is sent").
  newPrompt(): void {
    this.#shared.promptId = randomUUID();
  }

  // Whether a fire of `event` with `match` would run any hook, without running one: the session gives a tool ctx.report
  // only when a hook after the call matches it (release 8b plan, Task 7).
  has(event: Event, match: string): boolean {
    const { hooks, off } = this.#shared.config;
    return !off && hooks.some((h) => runsFor(h, event, match));
  }

  // `match` is what the event's matchers are matched against: a tool's Claude Code name, SessionStart's source, and so
  // on. Without one only a hook that matches everything runs; UserPromptSubmit's and Stop's always do (config.ts).
  async fire(event: Event, fields: object, opts: { match?: string; signal?: AbortSignal } = {}): Promise<Combined> {
    const { hooks, off } = this.#shared.config;
    const seen = new Set<string>();
    const picked = off ? [] : hooks.filter((h) => {
      if (!runsFor(h, event, opts.match)) return false;
      const key = entry(h);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!picked.length) return combine(event, []);
    if (opts.signal?.aborted) throw new Error("Cancelled");
    const input = this.#input(event, fields);
    const runs = this.#runs;
    // Read once, so a late async hook's failure names the model that led when it started, not one a /lead switch
    // put in since (Task 4's code review).
    const lead = this.#where.lead();
    // One limit for all of SessionEnd's hooks, which run at once, so it is the time they share (release 8b plan, Task 10); a
    // hook's own shorter timeout still ends it sooner (Task 10's code review).
    const shared = event === "SessionEnd" ? Math.min(END_MOST, Math.max(END_LIMIT, ...picked.map((h) => h.timeout ?? 0))) : undefined;
    const run = async (hook: Hook, signal?: AbortSignal): Promise<Run> => {
      const limit = shared !== undefined ? Math.min(hook.timeout ?? shared, shared) : limitOf(hook);
      // The waiting line shows a statusMessage while its hook runs (release 8b design, "What the user sees"); an async hook
      // is not waited for, so it has none there.
      const status = hook.async ? undefined : hook.statusMessage;
      if (status !== undefined) this.#bus.emit("hook-status", status, true);
      let ran: Ran;
      try {
        // runHook adds commandEnv and CLAUDE_PROJECT_DIR; the folder is the project's root (release 8b plan, choice 3).
        ran = await runHook(hook, input, { cwd: this.#where.root, env: process.env, limit, signal });
      } finally {
        if (status !== undefined) this.#bus.emit("hook-status", status, false);
      }
      // An async hook blocks nothing, so its failure stays a failure, to be said: onFailure "continue" turns off both ways
      // outcomeOf makes one a block, onFailure "block" and a shell on Windows without Git Bash (Task 4's spec review).
      const outcome = outcomeOf(event, hook.async ? { ...hook, onFailure: "continue" } : hook, ran);
      return { event, hook, ran, outcome, ...(opts.match !== undefined ? { match: opts.match } : {}) };
    };
    // An async hook is started and left, and a stop of the turn does not end it; its answer is read only to say a failure
    // (release 8b plan, choice 5), or that it asked to stop or to block, which it cannot: whatever combine would take as a
    // sync hook's stop or block, the stop winning as there (the user's choices, 2026-11-09). SessionEnd alone waits for its
    // async hooks too, within its shared limit, as Tachikoma is ending: none is left running then, and no failure line is
    // lost (Task 10's code review, following the user's choices for the window's exit); being waited for, they are stopped
    // with the rest, as a switch's Esc stops them (the user's choice, 2026-11-09: "Esc stops it").
    const end = event === "SessionEnd";
    const left: Promise<void>[] = [];
    for (const hook of picked.filter((h) => h.async)) {
      const done = run(hook, end ? opts.signal : undefined).then((r) => {
        runs.push(r);
        const c = combine(event, [r]);
        const command = commandOf(hook);
        const asked = c.stop !== undefined ? [`${command} asked to stop, but an "async" hook cannot stop`]
          : c.block !== undefined ? [`${command} asked to block, but an "async" hook cannot block`] : [];
        // Its lines may be said after the turn, and a listener that throws then must not become an unhandled rejection,
        // which would end Tachikoma. A bug before them still surfaces as one (Task 4's re-check).
        try {
          this.#say(event, lead, [...c.failures, ...asked], []);
        } catch {}
      });
      left.push(done);
    }
    // A stop ends every hook given the signal and rejects with Cancelled, as a command does (run.ts). At SessionEnd one wait
    // takes both kinds, so a stop's Cancelled from either is heard, never an unhandled rejection.
    const sync = Promise.all(picked.filter((h) => !h.async).map((h) => run(h, opts.signal)));
    const [results] = await Promise.all([sync, end ? Promise.all(left) : undefined]);
    runs.push(...results);
    const combined = combine(event, results);
    this.#say(event, lead, combined.failures, combined.messages);
    return combined;
  }

  // The common fields, then the event's own (release 8b design, "What a hook is sent").
  #input(event: Event, fields: object): object {
    const w = this.#where;
    const effort = w.effort();
    const { promptId } = this.#shared;
    return {
      session_id: w.sessionId(),
      transcript_path: w.transcript(),
      cwd: w.root,
      hook_event_name: event,
      permission_mode: MODE_NAMES[w.mode()],
      ...(promptId ? { prompt_id: promptId } : {}),
      ...(effort ? { effort: { level: effort } } : {}),
      // Claude Code's name for its read-only subagent, as Tachikoma's subagents only read (design).
      ...(w.agent ? { agent_id: w.agent.id, agent_type: "Explore" } : {}),
      ...fields,
    };
  }

  // The approved lines (release 8b plan, "Lines this plan adds"; choices 22 and 23).
  #say(event: Event, lead: string, failures: string[], messages: string[]): void {
    for (const line of failures) this.#bus.emit("error", { kind: "hook", attempted: `${event} hook`, message: `${event} hook failed: ${line}`, lead });
    for (const message of messages) this.#bus.emit("hook-note", `${event} hook: ${message}`);
  }
}
