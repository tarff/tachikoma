import os from "node:os";
import type { Verdict } from "../safety/judge.js";
import { type Context, type Danger, dangers, NO_RULES, shown as named, type UserRules } from "../safety/rules.js";
import { type Shell, shellOf } from "../safety/split.js";
import type { Bus } from "./bus.js";

// ask:     ask before every write and shell command, and before anything outside the project
// project: ask before shell commands and anything outside the project
// auto:    reads and edits in the project run, the judge decides the rest, and dangerous commands ask the user (release 7
//          design, "Auto mode"; release 7 plan, Task 10)
// never:   never ask; only with --sandbox copy, so nothing reaches the folder before the user has reviewed it
//          (release 7 design, "Launching")
export type Mode = "ask" | "project" | "auto" | "never";
export const MODES: Mode[] = ["ask", "project", "auto", "never"];
// The modes a mistake's words offer: all four, now that copy mode, which `never` needs, is built (release 7 plan, Task 21).
export const OFFERED: Mode[] = ["ask", "project", "auto", "never"];

export interface Action {
  kind: "read" | "write" | "shell";
  outside: boolean;
  summary: string;
  detail?: string; // what a write puts in the file, shown above the question; not escaped here
  command?: string; // a shell command's text, which the gate gives the dangerous-command check (release 7 plan, Task 8)
  // A write's protected part (safety/protected.ts), or "a file with another name" for a hard link (choice 61), and its
  // path as the question names it, for the refusal in `never` (Task 8).
  protectedPart?: string;
  path?: string;
}

// The git settings' paths the protected paths add, read once at launch (release 7 plan, Task 8; choices 57 and 59):
// `hooks` the hooks folders and git folders, `files` the settings files (safety/protected.ts, protectedPart). `ignoresCase`:
// the project's folder ignores letter case, read at launch too (cli.tsx), so protected paths ignore it on any system.
export interface Protection {
  hooks: string[];
  files: string[];
  ignoresCase?: boolean;
}

// In auto, true is what its fast path does not pass, a read or a write outside the project and a shell command, which the
// judge decides (release 7 plan, Task 10); a protected write and a danger the gate checks itself.
export function needsApproval(mode: Mode, action: Action): boolean {
  if (mode === "never") return false;
  if (action.outside) return true;
  if (mode === "ask") return action.kind !== "read";
  return action.kind === "shell";
}

// Symbols, not \n-style escapes: a typed backslash-n must not look like a real line break, or two
// commands could pass for one.
const NAMED: Record<string, string> = { "\n": "⏎", "\r": "␍", "\t": "⇥" };

// Shows control characters as escapes, so the approval prompt shows what will run: escape codes can
// hide or recolour text, \r and many \n can push part of a command out of sight, and bidi overrides
// can reorder it, as can invisible direction marks. `tabs` keeps tabs as they are, for prose in the
// scrollback.
export function visible(text: string, opts: { tabs?: boolean } = {}): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, (c) =>
    opts.tabs && c === "\t" ? c : (NAMED[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`),
  );
}

// Thrown when the user says no. The model is told; it is not logged as an error.
export class Declined extends Error {}

// Thrown for a yes given after the turn was stopped, or a stop while the judge decides, so the session tells the model
// the call was not run, not stopped while it ran (release 8b plan, Task 7's re-check).
export class StoppedFirst extends Error {
  constructor() {
    super("The turn was stopped before the call ran.");
  }
}

// Who asks a question, when it is not the lead's turn: a subagent's name, its stop signal, and how to
// stop it (release 4 design, "One line of questions, each with its owner").
export interface Owner {
  name: string;
  signal: AbortSignal;
  stop: () => void;
}

// `plain`: the summary is a question of its own, not an action to allow, such as the session's "Send again without the
// pictures" (release 6 plan, Task 18), so it is asked without "Allow" before it. `warnings`: the red lines above it, one
// per danger the dangerous-command check found, escaped (release 7 plan, Task 8). `note`: a grey line said with it, auto
// mode's pause (Task 10).
export type Ask = (summary: string, detail?: string, owner?: Owner, plain?: boolean, warnings?: string[], note?: string) => Promise<boolean>;

// Auto mode's judge, which cli.tsx gives the gate (release 7 plan, Task 10; safety/judge.ts, judgeOf). `own` is what a
// subagent's gate adds: its own session's calls, which follow the lead's, and its bus, so the judge's spend and errors
// are the subagent's.
export interface Own {
  calls: () => { name: string; input: unknown }[];
  bus: Bus;
}
export type Judge = (action: Action, signal: AbortSignal, own?: Own) => Promise<Verdict>;

// After this many of the judge's refusals in a row, or in the session, auto mode pauses: the next action that would go
// to the judge asks the user (release 7 plan, Task 10 and choice 8). Both are Claude Code's, from its docs (release 7
// design, Sources); they have not been measured for Tachikoma.
const IN_A_ROW = 3;
const IN_A_SESSION = 20;

// The refusals in `never`, and headless for a danger (release 7 plan, Task 8). Each holds the model's text, escaped.
const dangerRefusal = (found: Danger[]) => `Not allowed: this command matches the dangerous-command check (${found.map((d) => visible(named(d))).join("; ")}).`;
const protectedRefusal = (where: string, part: string) =>
  `Not allowed: ${visible(where)} is a protected path (${visible(part)}), which other programs run or read as settings.`;
const outsideRefusal = (summary: string) => `Not allowed in never mode: ${visible(summary)}, which is outside the project.`;
// A PreToolUse hook's ask where nobody can answer it (release 8b plan, "Lines this plan adds"), and its question's note.
const hookReason = (reason: string) => (reason ? ` (${visible(reason)})` : "");
const hookNeverRefusal = (reason: string) => `Not allowed in never mode: a PreToolUse hook asked for this call to be approved${hookReason(reason)}.`;
const hookHeadlessRefusal = (reason: string) => `Not allowed: a PreToolUse hook asked for this call to be approved${hookReason(reason)}, and -p cannot ask.`;
const hookNote = (reason: string) => (reason ? `A hook asks: ${visible(reason)}` : "A hook asks.");

// `root`: the project's, for the dangerous-command check; `headless`: -p mode, where a danger is refused (Task 8);
// `judge`: auto mode's (Task 10), which cli.tsx always gives. `home` and `shell` are the box's in the sandbox, its
// HOME=/tmp and bash (choices 3 and 77; Task 16), and the host's otherwise. `hookRefused`: told of each call a PreToolUse
// hook refused, so -p's exit code counts it as it counts a refusal its ask reports (release 8b plan, Task 6; the user's
// choice, 2026-11-09).
export interface GateOptions {
  root?: string;
  home?: string;
  shell?: Shell;
  headless?: boolean;
  judge?: Judge;
  hookRefused?: () => void;
}

export class PermissionGate {
  #mode: Mode;
  #rules: UserRules = NO_RULES;
  #protection: Protection = { hooks: [], files: [] };
  #parent?: PermissionGate;
  #own?: Own;
  // Auto mode's counts (release 7 plan, Task 10): the lead's gate's, for the session and its subagents' gates. The judge's
  // refusals in a row and in all; while auto mode is paused, the pause, holding the number its line names, made by the
  // refusal that starts it and kept, its count raised, by any that comes during it, so only a question asked under the
  // pause in force can lift it; and the version of the mode and the rules, which every set of either raises, for the
  // recheck.
  #inRow = 0;
  #refused = 0;
  #pause: { count: number } | null = null;
  #version = 0;
  // Set on a gate made for one call a PreToolUse hook allowed, or whose question the user said yes to (withHook).
  #hook: { allow: true } | { asked: true } | undefined;
  // Where the check reads a command (release 7 plan, Task 8): the project's root (cli.tsx gives its own, the folder it
  // started in), the home folder, and the shell the executor really runs, PowerShell on Windows and /bin/sh elsewhere
  // (exec/local.ts, shellFor; split.ts, shellOf); in live link the box's /work, /tmp and bash (GateOptions, Task 16).
  // Whether a file exists is the check's own default, on the host.
  readonly #context: Context;

  constructor(
    mode: Mode,
    private readonly ask: Ask,
    private readonly refusal = "The user declined", // what the model is told; in -p mode nobody was asked
    private readonly options: GateOptions = {},
  ) {
    this.#mode = mode;
    this.#context = { root: options.root ?? process.cwd(), home: options.home ?? os.homedir(), shell: options.shell ?? shellOf("host") };
  }

  // Read at each check: Shift+Tab changes it during a session. A subagent's gate reads the lead's.
  get mode(): Mode {
    return this.#parent?.mode ?? this.#mode;
  }
  set mode(mode: Mode) {
    this.#mode = mode;
    this.#version++; // a mode that leaves auto and comes back still throws away an answer that was out (Task 10)
  }
  // The user's own dangerous-command rules in force (release 7 plan, Task 4), as the launch read them and as a live edit
  // that tightens them changes them. A subagent's gate reads the lead's.
  get rules(): UserRules {
    return this.#parent?.rules ?? this.#rules;
  }
  set rules(rules: UserRules) {
    this.#rules = rules;
    this.#version++;
  }
  // The git settings' paths, read at launch and kept for the session; the file tools read them here (Task 8). A
  // subagent's gate reads the lead's.
  get protection(): Protection {
    return this.#parent?.protection ?? this.#protection;
  }
  set protection(protection: Protection) {
    this.#protection = protection;
  }

  // A subagent's gate: the lead's mode, rules, protection and auto mode's counts, questions that name the subagent, and
  // what it adds for the judge (Own).
  for(owner: Owner, own?: Own): PermissionGate {
    const ask: Ask = (summary, detail, _owner, plain, warnings, note) => this.ask(summary, detail, owner, plain, warnings, note);
    const gate = new PermissionGate(this.#mode, ask, this.refusal, this.options);
    gate.#parent = this;
    if (own) gate.#own = own;
    return gate;
  }

  // A gate for one call a PreToolUse hook allowed, or whose question the user said yes to (release 8b plan, Task 6 and
  // choice 15): the mode's question and the judge are skipped, except for a write outside the project (require); the rest
  // is this gate's, its questions, mode, rules, protection and auto mode's counts. The two are alike here: a yes to the
  // hook's question was about the call, so it stands in for the mode's question, as an allow does, and for nothing else.
  withHook(h: { allow: true } | { asked: true }): PermissionGate {
    const gate = new PermissionGate(this.#mode, this.ask, this.refusal, this.options);
    gate.#parent = this.#parent ?? this;
    if (this.#own) gate.#own = this.#own;
    gate.#hook = h;
    return gate;
  }

  // Where a PreToolUse hook's ask cannot be put, in never and headless, where nobody can answer it, the words of the
  // call's refusal (release 8b plan, choice 15; design, "Tool hooks"), which the session says and tells the model; else
  // undefined, and the question is put (hookAsks).
  hookCannotAsk(reason: string): string | undefined {
    if (this.mode === "never") return hookNeverRefusal(reason);
    if (this.options.headless) return hookHeadlessRefusal(reason);
    return undefined;
  }

  // A PreToolUse hook's ask, where it can be put (hookCannotAsk): one question, the call named by `summary`, with the
  // hook's reason as its grey note; a no declines as any no does. A yes returns, and the call runs with
  // withHook({ asked: true }).
  async hookAsks(summary: string, reason: string): Promise<void> {
    const shown = visible(summary);
    if (!(await this.ask(shown, undefined, undefined, undefined, [], hookNote(reason)))) throw new Declined(`${this.refusal}: ${shown}`);
  }

  // A call a PreToolUse hook refused (a deny, a block, a rewrite that cannot be used, or an ask nobody can answer), for
  // -p's exit code (GateOptions).
  hookRefused(): void {
    this.options.hookRefused?.();
  }

  // Release 7 plan, Task 8: a protected write asks in ask and project too (in release 6, project wrote one unasked), and
  // a dangerous command asks with its red lines; in `never` both are refused, as is a danger headless. Task 10: in auto, a
  // read and a write in the project that is not protected pass, a danger asks, and the judge decides the rest, under
  // `signal`, the turn's; while auto mode is paused, the user does, with the pause's line.
  async require(action: Action, signal?: AbortSignal): Promise<void> {
    const mode = this.mode;
    const found = action.command === undefined ? [] : dangers(action.command, this.#context, this.rules);
    const part = action.protectedPart;
    if (mode === "never") {
      if (part !== undefined) throw new Declined(protectedRefusal(action.path ?? action.summary, part));
      // A write outside the project, one whose real place cannot be told among them (a link that leads nowhere has no
      // protected part to find), could reach the folder unreviewed (Task 21, from Task 8's spec review).
      if (action.kind === "write" && action.outside) throw new Declined(outsideRefusal(action.summary));
      if (found.length) throw new Declined(dangerRefusal(found));
      return;
    }
    // A hook's allow, or a yes to its question, skips only the mode's ordinary question and the judge, and never a write
    // outside the project: that is asked about in ask and project, and goes to the judge in auto, as without the hook, as a
    // protected part and a danger are (the user's choices, 2026-11-09).
    const ordinary = this.#hook ? action.kind === "write" && action.outside : needsApproval(mode, action);
    if (part === undefined && !found.length && !ordinary) return;
    const top = this.#parent ?? this;
    // Headless never pauses: every refusal is final (Task 10).
    const pause = mode === "auto" && !found.length && !this.options.headless ? top.#pause : null;
    if (mode === "auto" && !found.length && pause === null) return this.#judged(action, signal ?? new AbortController().signal);
    const shown = visible(action.summary);
    const warnings = found.map((d) => visible(`Danger: ${named(d)}`));
    const note = pause === null ? undefined : `Auto mode paused after ${pause.count} refusals; approving this resumes it.`;
    const yes = await this.ask(shown, action.detail, undefined, undefined, warnings, note);
    // Headless, the ask is the launch's report of a refusal (cli.tsx), so the run fails and says so; a danger is
    // refused whatever it answers.
    if (this.options.headless && found.length) throw new Declined(dangerRefusal(found));
    if (!yes) throw new Declined(`${this.refusal}: ${shown}`);
    // A yes given after the turn was stopped, by a hook's continue: false while the question was open, runs nothing (release
    // 8b plan, Task 7's code review). A user's stop closes the question as a no, so it is declined above, as before.
    if (signal?.aborted) throw new StoppedFirst();
    // Approving one action resumes auto mode and starts the row again; the session's total keeps counting (choice 8). A
    // question still waiting from a pause that has since been lifted and come again lifts nothing.
    if (pause !== null && top.#pause === pause) {
      top.#pause = null;
      top.#inRow = 0;
    }
  }

  // Task 10, steps 3 to 5. The judge's answer counts only if nothing changed while it was out: a stopped turn runs
  // nothing, and a change of the mode, even one back to auto, or a live edit of the rules throws the answer away, and the
  // action is decided again from the start under what is in force now. Nothing is kept: the same action asked again goes
  // to the judge again.
  async #judged(action: Action, signal: AbortSignal): Promise<void> {
    const top = this.#parent ?? this;
    const version = top.#version;
    // A stop while the judge decides, its request cut off or its answer late, runs nothing (Task 7's re-check).
    const verdict = await this.options.judge!(action, signal, this.#own).catch((err: unknown) => {
      throw signal.aborted ? new StoppedFirst() : err;
    });
    if (signal.aborted) throw new StoppedFirst();
    if (top.#version !== version) return this.require(action, signal);
    if (verdict.allow) {
      top.#inRow = 0; // a yes ends the row
      return;
    }
    top.#inRow++;
    top.#refused++;
    // Once the session has had 20, each later refusal pauses it again, its line naming the session's count (choice 8). One
    // that comes during a pause, from a request already out, continues it, so the questions waiting under it still lift it.
    if (!this.options.headless && (top.#inRow >= IN_A_ROW || top.#refused >= IN_A_SESSION)) {
      const count = top.#refused >= IN_A_SESSION ? top.#refused : top.#inRow;
      if (top.#pause) top.#pause.count = count;
      else top.#pause = { count };
    }
    throw new Declined(`The judge refused: ${visible(verdict.reason)}`);
  }
}
