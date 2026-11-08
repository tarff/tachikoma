import { randomUUID } from "node:crypto";
import type { Bus } from "../core/bus.js";
import type { Mode } from "../core/permissions.js";
import type { Effort } from "../providers/anthropic.js";
import { type Combined, combine, type Outcome, outcomeOf } from "./answer.js";
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
export interface Run { event: Event; hook: Hook; ran: Ran; outcome: Outcome } // for Ctrl+O (release 8b plan, choice 24)

// Each mode under its nearest Claude Code name (release 8b design, "What a hook is sent").
export const MODE_NAMES: Record<Mode, string> = { ask: "default", project: "acceptEdits", auto: "auto", never: "bypassPermissions" };

// Claude Code's hooks reference, "Common fields": a hook's time limit is its timeout, or 600 s, or 30 s at UserPromptSubmit.
const LIMIT = 600;
const PROMPT_LIMIT = 30;

// Two entries are the same hook when every field of the entry is (release 8b design, "Running a hook"; review,
// 2026-11-09, finding 3); its event, matcher and place are not fields of the entry.
const entry = (h: Hook) => JSON.stringify([h.command, h.args, h.shell, h.timeout, h.async, h.onFailure, h.statusMessage]);

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

  // A subagent's: the same hooks, its own fields and bus.
  for(agent: { id: string; transcript?: string }, bus: Bus): Hooks {
    const hooks = new Hooks(this.#shared.config, { ...this.#where, agent }, bus);
    hooks.#shared = this.#shared;
    return hooks;
  }

  // A new prompt_id for each prompt the user sends (release 8b design, "What a hook is sent").
  newPrompt(): void {
    this.#shared.promptId = randomUUID();
    this.#runs = [];
  }

  // `match` is what the event's matchers are matched against: a tool's Claude Code name, SessionStart's source, and so
  // on. Without one only a hook that matches everything runs; UserPromptSubmit's and Stop's always do (config.ts).
  async fire(event: Event, fields: object, opts: { match?: string; signal?: AbortSignal } = {}): Promise<Combined> {
    const { hooks, off } = this.#shared.config;
    const seen = new Set<string>();
    const picked = off ? [] : hooks.filter((h) => {
      if (h.event !== event || !(opts.match === undefined ? "all" in h.matcher : matches(h.matcher, opts.match))) return false;
      const key = entry(h);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!picked.length) return combine(event, []);
    if (opts.signal?.aborted) throw new Error("Cancelled");
    const input = this.#input(event, fields);
    const runs = this.#runs;
    const run = async (hook: Hook, signal?: AbortSignal) => {
      const limit = hook.timeout ?? (event === "UserPromptSubmit" ? PROMPT_LIMIT : LIMIT);
      // runHook adds commandEnv and CLAUDE_PROJECT_DIR; the folder is the project's root (release 8b plan, choice 3).
      const ran = await runHook(hook, input, { cwd: this.#where.root, env: process.env, limit, signal });
      return { event, hook, ran, outcome: outcomeOf(event, hook, ran) };
    };
    // An async hook is started and left, and a stop of the turn does not end it; its answer is read only to say a failure
    // (release 8b plan, choice 5).
    for (const hook of picked.filter((h) => h.async)) {
      void run(hook).then((r) => {
        runs.push(r);
        this.#say(event, combine(event, [r]).failures, []);
      });
    }
    // A stop ends every hook given the signal and rejects with Cancelled, as a command does (run.ts).
    const results = await Promise.all(picked.filter((h) => !h.async).map((h) => run(h, opts.signal)));
    runs.push(...results);
    const combined = combine(event, results);
    this.#say(event, combined.failures, combined.messages);
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
  #say(event: Event, failures: string[], messages: string[]): void {
    const lead = this.#where.lead();
    for (const line of failures) this.#bus.emit("error", { kind: "hook", attempted: `${event} hook`, message: `${event} hook failed: ${line}`, lead });
    for (const message of messages) this.#bus.emit("hook-note", `${event} hook: ${message}`);
  }
}
