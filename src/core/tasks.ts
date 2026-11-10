import path from "node:path";
import type { Hooks } from "../hooks/hooks.js";
import type { Paths } from "../hooks/tools.js";
import { cost } from "../providers/pricing.js";
import type { Tool, ToolContext } from "../tools/tool.js";
import { Bus, type ErrorEvent } from "./bus.js";
import type { Owner, PermissionGate } from "./permissions.js";
import { type Ended, Session, truncate } from "./session.js";
import { pathsOf, Transcript } from "./transcript.js";
import type { Message, Provider } from "./types.js";

export type TaskState = "waiting" | "running" | "done" | "failed" | "stopped";

// How a subagent ended: its answer, the reason it failed, or that it was stopped.
export interface Result {
  state: "done" | "failed" | "stopped";
  text: string;
  // A hook's stop after the answer: `text` is the answer, then the stop's line, apart here so a cut of the answer leaves
  // the line whole (release 8b plan, Task 9's re-check).
  stop?: { answer: string; line: string };
}

// One subagent, as the panel and /tasks show it.
export interface Task {
  id: string; // t1, t2 and so on through the session
  description: string; // a few words naming the task, for the screen
  task: string; // what it was asked to find out, as the model wrote it
  model: string;
  background: boolean;
  state: TaskState;
  started: number;
  ended?: number;
  output: number; // tokens written
  cost: number; // USD, for requests whose price is known
  costUnknown: boolean;
  lastTool: { name: string; input: unknown } | null;
  answer?: string; // once it ended: its answer, why it failed, or that it was stopped
  shown: boolean; // on the panel: finished ones leave it at the next turn the user starts
  messages: Message[]; // its conversation, for /tasks t3
  done: Promise<Result>;
}

export interface TasksOptions {
  bus: Bus; // the lead's: subagents' spend and errors are reported there, marked with the subagent
  max: number; // --max-tasks
  // The model for a new subagent: the same one on every call until setWorker, so a setting made on it (App's effort)
  // holds; throws when none can be made, which cli.tsx's never does.
  worker: () => Provider;
  fallback?: Provider;
  system: string; // the subagents' system prompt, instructions included
  tools: Tool[];
  ctx: Omit<ToolContext, "signal" | "gate"> & { gate: PermissionGate }; // the lead's; each subagent asks through gate.for(itself)
  // The lead session's transcript, read at each start, as loading a conversation swaps it; each subagent saves beside it
  // (release 8a plan, Task 5).
  transcript?: () => Transcript | undefined;
  // The window's hooks, and the paths they are sent, as the lead's session has them; each subagent's session fires them
  // through hooks.for(itself), so its input carries its agent_id (release 8b plan, Task 6).
  hooks?: Hooks;
  paths?: Paths;
}

// The task manager (release 4 design, "How it is built"): starts subagents, each its own Session,
// keeps their state and spend, stops one or all, and keeps finished background answers until the
// lead's next request takes them.
export class Tasks {
  readonly all: Task[] = [];
  #inbox: { id: string; text: string; wake: boolean }[] = [];
  #max: number;
  #free: number; // below 0 while more run than a lowered max allows
  #worker: () => Provider;
  #fallback: Provider | undefined;
  #line: (() => void)[] = []; // subagents waiting for a free place, in order
  #stops = new Map<string, { stop: AbortController; byUser: boolean }>();
  #next = 1; // the next id's number: from(n) raises it past a loaded conversation's subagents (release 8a plan, choice 4)

  constructor(private readonly opts: TasksOptions) {
    this.#max = opts.max;
    this.#free = opts.max;
    this.#worker = opts.worker;
    this.#fallback = opts.fallback;
  }

  // The model a subagent started now would get (TasksOptions.worker: the same one on every call).
  get worker(): Provider {
    return this.#worker();
  }

  // For subagents started after the change; running ones keep theirs (release 6 design, "When a live change applies").
  setWorker(worker: () => Provider): void {
    this.#worker = worker;
  }

  // For subagents started after the change, as the lead's fallback (Session.setFallback).
  setFallback(fallback: Provider | undefined): void {
    this.#fallback = fallback;
  }

  // Lowering it stops none: it only holds back new starts until enough have ended. Raising it starts those waiting.
  setMax(max: number): void {
    this.#free += max - this.#max;
    this.#max = max;
    this.#wake();
  }

  get running(): number {
    return this.all.filter((t) => t.state === "running" || t.state === "waiting").length;
  }

  // The next id's number becomes at least `n`, never less, so a resumed session's next subagent never adds to a saved
  // one's file (release 8a plan, choice 4).
  from(n: number): void {
    this.#next = Math.max(this.#next, n);
  }

  // `signal` is the lead's turn, for a subagent it waits for: stopping the turn stops it too.
  start(task: string, opts: { description?: string; background: boolean; signal?: AbortSignal }): Task {
    const provider = this.#worker();
    const id = `t${this.#next++}`;
    const stop = new AbortController();
    opts.signal?.addEventListener("abort", () => stop.abort(), { once: true });
    this.#stops.set(id, { stop, byUser: false });
    // `done` is set just below, before anything reads it.
    const t = { id, description: opts.description ?? task, task, model: provider.id, background: opts.background, state: "waiting", started: Date.now(), output: 0, cost: 0, costUnknown: false, lastTool: null, shown: true, messages: [] } as Omit<Task, "done"> as Task;
    this.all.push(t);
    t.done = this.#run(t, provider, this.#fallback, stop.signal);
    this.#changed();
    return t;
  }

  // By the user: one subagent, or with no id all of them. False when none was running.
  stop(id?: string): boolean {
    let any = false;
    for (const t of this.all) {
      if ((id === undefined || t.id === id) && (t.state === "running" || t.state === "waiting")) {
        const s = this.#stops.get(t.id)!;
        s.byUser = true;
        s.stop.abort();
        any = true;
      }
    }
    return any;
  }

  // Whether a waiting answer should start a turn: a stopped subagent's note waits for the next one.
  wakes(): boolean {
    return this.#inbox.some((i) => i.wake);
  }

  // The subagents whose answers are waiting to start a turn, for its working line.
  answering(): string[] {
    return this.#inbox.filter((i) => i.wake).map((i) => i.id);
  }

  // Everything waiting for the lead, removed, so each goes into exactly one request.
  take(): string[] {
    return this.#inbox.splice(0).map((i) => i.text);
  }

  clearFinished(): void {
    for (const t of this.all) if (t.state !== "running" && t.state !== "waiting") t.shown = false;
    this.#changed();
  }

  // The finished ones leave the list, as the window takes another conversation; running ones stay until they end.
  forgetFinished(): void {
    this.all.splice(0, this.all.length, ...this.all.filter((t) => t.state === "running" || t.state === "waiting"));
    this.#changed();
  }

  async #run(t: Task, provider: Provider, fallback: Provider | undefined, signal: AbortSignal): Promise<Result> {
    // Its own file, <id>/subagents/<tN>.jsonl beside the lead's pictures folder, named by a line in the lead's (release 8a
    // design, "Saving sessions"). The lead's line is written before the first wait; the subagent's own file only with its
    // first message or its ended line, and a missing file reads as unfinished. So from start, before delegate says it
    // started and while it waits for a place, a closed window's subagent is found lost, never its id handed out again. None once
    // the lead's saving has stopped, so no file is saved that no line names. A subagent numbers the pictures its tools
    // answer with from its own 1, so they are saved in a folder of its own, <id>/subagents/<tN>/pictures, never over the
    // lead's (release 8c plan, Task 6's code review). The lead's write made the sessions folder private, so the subagents
    // folder inside it inherits that permission, as transcript.ts's pictures folder does.
    const lead = this.opts.transcript?.();
    lead?.write({ t: "subagent", id: t.id, description: t.description, file: `${t.id}.jsonl` });
    const file = (l: Transcript) => path.join(pathsOf(l.file).subagents, `${t.id}.jsonl`);
    const own = lead && !lead.failed ? new Transcript(file(lead), pathsOf(file(lead)).pictures, { inherits: true }) : undefined;
    const result = (await this.#place(signal)) ? await this.#work(t, provider, fallback, signal, own) : null;
    const stopped = this.#stops.get(t.id)!;
    // A hook's stop comes with its own result and its stopReason (#work).
    const byWhom = stopped.byUser ? " by the user before it finished" : ""; // the words, said after "was stopped"
    const { hook, ...r }: Result & { hook?: string } = result ?? { state: "stopped", text: `${t.id} was stopped${byWhom}.` };
    // How it ended, when the lead was told it failed or was stopped, waiting or running, so a resumed session never
    // reports it lost (release 8a plan, choice 4). A finished one's answer, its last reply, says so already.
    if (r.state !== "done") own?.write({ t: "ended", state: r.state });
    t.state = r.state;
    t.answer = r.text;
    t.ended = Date.now();
    const name = `Background task ${t.id} (${t.description})`;
    const { id } = t;
    if (t.background && r.state === "done") this.#inbox.push({ id, text: `${name} finished:\n${truncate(r.text)}`, wake: true });
    if (t.background && r.state === "failed") this.#inbox.push({ id, text: `${name} failed: ${r.text}`, wake: true });
    // Waking the lead, as a failure does; after an answer, the answer as a finished one's, then the stop's line (the user's
    // choices, 2026-11-09).
    if (t.background && hook !== undefined) {
      const text = r.stop
        ? `${name} finished:\n${truncate(r.stop.answer)}\n${r.stop.line}`
        : `${name} was stopped by a hook${hook ? `: ${hook}` : "."}`;
      this.#inbox.push({ id, text, wake: true });
    }
    if (t.background && r.state === "stopped" && stopped.byUser) this.#inbox.push({ id, text: `${name} was stopped by the user before it finished.`, wake: false });
    this.#changed();
    return r;
  }

  // Null when it was stopped, by the user or the lead's turn; a hook's stop has its own result, with `hook` its stopReason.
  async #work(
    t: Task,
    provider: Provider,
    fallback: Provider | undefined,
    signal: AbortSignal,
    own: Transcript | undefined,
  ): Promise<(Result & { hook?: string }) | null> {
    const bus = new Bus();
    let failure: ErrorEvent | undefined;
    bus.on("usage", (u) => {
      t.output += u.usage.output;
      const c = u.priceKnown === false ? null : cost(u.provider, u.usage);
      if (c === null) t.costUnknown = true;
      else t.cost += c;
      this.opts.bus.emit("usage", { ...u, task: t.id });
      this.#changed();
    });
    bus.on("error", (e) => {
      // A judge that cannot be reached refuses one action, as a no does, and fails no subagent (release 7 plan, choice 65);
      // nor does a file that cannot be saved (release 8a plan, Task 5), nor a hook's failure (release 8b plan review,
      // 2026-11-09, finding 1): a hook stops a subagent only through continue: false. A hook's red line is its message
      // alone, so it starts with the subagent too (release 8b plan, "Lines this plan adds"), and it names the subagent's
      // model, as the subagent's other errors do; its Hooks knows only the lead's (Task 4's spec review).
      if (e.kind !== "fallback" && e.kind !== "tool" && e.kind !== "judge" && e.kind !== "saving" && e.kind !== "hook") failure = e;
      const hook = e.kind === "hook" ? { message: `${t.id}: ${e.message}`, lead: provider.id } : {};
      this.opts.bus.emit("error", { ...e, attempted: `${t.id}: ${e.attempted}`, ...hook });
    });
    // A hook's grey lines reach the user through the lead's bus, as its errors do (second round, finding 3).
    bus.on("hook-note", (line, named) => this.opts.bus.emit("hook-note", named ? line : `${t.id}: ${line}`));
    bus.on("tool-start", ({ name, input }) => {
      t.lastTool = { name, input };
      this.#changed();
    });
    const owner: Owner = { name: `${t.id} (${t.description})`, signal, stop: () => this.stop(t.id) };
    const { ctx } = this.opts;
    const hooks = this.opts.hooks?.for({ id: t.id, ...(own ? { transcript: own.file } : {}) }, bus);
    // The judge sees the subagent's own calls after the lead's, and reports to its bus (release 7 plan, Task 10).
    const session: Session = new Session({
      lead: provider,
      ...(fallback ? { fallback } : {}),
      tools: this.opts.tools,
      system: this.opts.system,
      ctx: { ...ctx, gate: ctx.gate.for(owner, { calls: () => session.calls, bus }) },
      bus,
      subagent: true,
      id: t.id, // names it in its saving line
      ...(own ? { transcript: own } : {}),
      ...(hooks ? { hooks } : {}),
      ...(this.opts.paths ? { paths: this.opts.paths } : {}),
    });
    t.messages = session.messages;
    t.state = "running";
    this.#changed();
    let ended: Ended | void;
    try {
      // SubagentStart before its first request, matched on Claude Code's name for it (release 8b plan, Task 9), its text for
      // the model at the start of its first message (choice 6). A stop while its hooks run ends them (run.ts), and the
      // subagent as any stop does.
      if (hooks) {
        try {
          session.waitForNext((await hooks.fire("SubagentStart", {}, { match: "Explore", signal })).context);
        } catch (err) {
          if (!signal.aborted) throw err;
        }
      }
      if (signal.aborted) return null;
      ended = await session.send(t.task, signal);
    } finally {
      this.#release();
    }
    if (signal.aborted) return null;
    const last = session.messages.at(-1);
    const text = last?.role === "assistant" ? last.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n") : "";
    // A hook's continue: false in its session, at any of its events, ends it as stopped, never the lead's turn (release 8b
    // design, "What a hook's answer does"). At SubagentStop it came after the answer, which is kept, the stop's line after
    // it (the user's choice, 2026-11-09); a stop during a round of calls leaves no answer.
    if (ended && "stopped" in ended) {
      const line = `${t.id} was stopped by a hook${ended.stopped ? `: ${ended.stopped}` : "."}`;
      if (!text.trim()) return { state: "stopped", text: line, hook: ended.stopped };
      return { state: "stopped", text: `${text}\n${line}`, stop: { answer: text, line }, hook: ended.stopped };
    }
    if (text.trim() && !failure) return { state: "done", text };
    return { state: "failed", text: failure?.message ?? "it ended without an answer" };
  }

  // Resolves true once a place is free, taking it; false if the subagent is stopped first.
  #place(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.#free > 0) {
      this.#free--;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const go = () => {
        signal.removeEventListener("abort", leave);
        resolve(true);
      };
      const leave = () => {
        this.#line = this.#line.filter((g) => g !== go);
        resolve(false);
      };
      this.#line.push(go);
      signal.addEventListener("abort", leave, { once: true });
    });
  }

  #release(): void {
    this.#free++;
    this.#wake();
  }

  #wake(): void {
    while (this.#free > 0 && this.#line.length) {
      this.#free--;
      this.#line.shift()!();
    }
  }

  #changed(): void {
    this.opts.bus.emit("tasks");
  }
}
