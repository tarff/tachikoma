import path from "node:path";
import type { ExecResult, Running } from "../exec/executor.js";
import { deliver, headCommand } from "../exec/log.js";
import type { Hooks } from "../hooks/hooks.js";
import type { Paths } from "../hooks/tools.js";
import type { Servers } from "../mcp/servers.js";
import { approveOf, mcpTools } from "../mcp/tools.js";
import { cost } from "../providers/pricing.js";
import type { Tool, ToolContext } from "../tools/tool.js";
import { Bus, type ErrorEvent } from "./bus.js";
import type { Owner, PermissionGate } from "./permissions.js";
import { type Ended, Session, truncate } from "./session.js";
import { pathsOf, Transcript } from "./transcript.js";
import { errorText, type Message, type Provider } from "./types.js";

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
export interface SubagentTask {
  kind: "subagent";
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

// One background command, a task of its own kind (background commands plan, choice 5): `running`, then `done` for exit
// code 0, `failed` for any other end, `stopped` when stopped. Its ids come from the subagents' counter. `done` settles
// once the list has taken its end, never rejecting.
export interface CommandTask {
  kind: "command";
  id: string;
  command: string; // as the model gave it
  background: true;
  state: TaskState;
  started: number;
  ended?: number;
  shown: boolean;
  code?: number | null; // as it ended by itself
  signal?: NodeJS.Signals | null;
  // For shell_output's first line (background commands plan, Task 6): a stop at the -p time limit, told apart from a stop
  // by the user or stop_task, and a failed run's error (choice 23), cut as a command is in a first line (choice 24).
  limited?: true;
  error?: string;
  run: Running;
  done: Promise<void>;
}

export type Task = SubagentTask | CommandTask;

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
  // The servers each subagent's own MCP tools are made from here: its trusted read-only ones only, so no caller can give a
  // subagent more (release 8c plan, Task 7 and choice 17), with a tool_search and a loaded set of its own, starting with
  // none, never the lead's (choice 43).
  mcp?: Servers;
  // Under -p only, a background command's time limit in milliseconds: `started` for one started without a timeout,
  // `moved` for one moved from the foreground, `most` the most a timeout can ask for (background commands plan, choice 8;
  // the numbers are Task 11's).
  limits?: { started: number; moved: number; most: number };
}

// The task manager (release 4 design, "How it is built"): starts subagents, each its own Session,
// keeps their state and spend, stops one or all, and keeps finished background answers until the
// lead's next request takes them.
export class Tasks {
  readonly all: Task[] = [];
  // A command's ending is made into its text when take() runs, so output the model read meanwhile is not given again
  // (background commands plan, choice 7).
  #inbox: { id: string; kind: Task["kind"]; text: string | (() => string); wake: boolean }[] = [];
  #timers = new Map<string, NodeJS.Timeout>(); // each -p command's time limit, by its id (choice 8)
  // The foreground command Ctrl+B can move, set by the shell tool while one runs (choice 9).
  holding?: { move(): void };
  #max: number;
  #free: number; // below 0 while more run than a lowered max allows
  #worker: () => Provider;
  #fallback: Provider | undefined;
  #line: (() => void)[] = []; // subagents waiting for a free place, in order
  // `by` is who stopped it through stop(), for its words (choice 27); none when the lead's turn stopped it.
  #stops = new Map<string, { stop: AbortController; by?: "user" | "tool" }>();
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
  start(task: string, opts: { description?: string; background: boolean; signal?: AbortSignal }): SubagentTask {
    const provider = this.#worker();
    const id = `t${this.#next++}`;
    const stop = new AbortController();
    opts.signal?.addEventListener("abort", () => stop.abort(), { once: true });
    this.#stops.set(id, { stop });
    // `done` is set just below, before anything reads it.
    const made = {
      kind: "subagent", id, description: opts.description ?? task, task, model: provider.id, background: opts.background, state: "waiting",
      started: Date.now(), output: 0, cost: 0, costUnknown: false, lastTool: null, shown: true, messages: [],
    };
    const t = made as Omit<SubagentTask, "done"> as SubagentTask;
    this.all.push(t);
    t.done = this.#run(t, provider, this.#fallback, stop.signal);
    this.#changed();
    return t;
  }

  // A background command joins the list, started there or moved there from the foreground (background commands plan,
  // choice 6). Its line in the lead's transcript is written before this returns, as a subagent's is (#run), so the id the
  // shell tool hands the model is never handed out again. `limit` is the time limit the tool's timeout asks for under -p.
  adopt(run: Running, opts: { command: string; moved?: boolean; limit?: number }): CommandTask {
    const id = `t${this.#next++}`;
    // `done` is set just below, before anything reads it.
    const made = { kind: "command", id, command: opts.command, background: true, state: "running", started: Date.now(), shown: true, run };
    const t = made as Omit<CommandTask, "done"> as CommandTask;
    this.all.push(t);
    this.opts.transcript?.()?.write({ t: "command", id, command: opts.command });
    const { limits } = this.opts;
    if (limits) {
      const ms = opts.moved ? limits.moved : Math.min(opts.limit ?? limits.started, limits.most);
      this.#timers.set(id, setTimeout(() => this.#limit(t), ms));
    }
    // A rejection (Docker unreachable, a spawn error) is taken here, so none goes unhandled (choice 23).
    t.done = run.done.then(
      (r) => this.#exited(t, r),
      (err: unknown) => this.#failed(t, err),
    );
    this.#changed();
    return t;
  }

  get(id: string): Task | undefined {
    return this.all.find((t) => t.id === id);
  }

  // One subagent or command, or with no id all of them: by the user (/tasks stop) or by the model (stop_task). False when
  // none was running.
  stop(id?: string, by: "user" | "tool" = "user"): boolean {
    let any = false;
    for (const t of this.all) {
      if ((id === undefined || t.id === id) && (t.state === "running" || t.state === "waiting")) {
        if (t.kind === "command") this.#stopCommand(t, by);
        else {
          const s = this.#stops.get(t.id)!;
          s.by = by;
          s.stop.abort();
        }
        any = true;
      }
    }
    return any;
  }

  // Ctrl+B: the foreground command moves to the background (choice 9). False when none runs.
  moveForeground(): boolean {
    if (!this.holding) return false;
    this.holding.move();
    return true;
  }

  // shell_output gave the model an ended command's end and output, so its entry goes, and the model is not told twice
  // (choice 7).
  told(id: string): void {
    this.#inbox = this.#inbox.filter((i) => i.id !== id);
  }

  // Whether a waiting answer should start a turn: a stopped subagent's note waits for the next one.
  wakes(): boolean {
    return this.#inbox.some((i) => i.wake);
  }

  // The subagents and commands whose entries are waiting to start a turn, for its working line, each with its kind, as
  // the line names a subagent's answer and a command's output apart (background commands plan, choice 19).
  answering(): { id: string; kind: Task["kind"] }[] {
    return this.#inbox.filter((i) => i.wake).map(({ id, kind }) => ({ id, kind }));
  }

  // Everything waiting for the lead, removed, so each goes into exactly one request.
  take(): string[] {
    return this.#inbox.splice(0).map((i) => (typeof i.text === "string" ? i.text : i.text()));
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

  async #run(t: SubagentTask, provider: Provider, fallback: Provider | undefined, signal: AbortSignal): Promise<Result> {
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
    // The words, said after "was stopped": a stop by stop_task says so (choice 27, the user's, 2026-11-13).
    const byWhom = stopped.by ? ` by ${stopped.by === "user" ? "the user" : "stop_task"} before it finished` : "";
    const { hook, ...r }: Result & { hook?: string } = result ?? { state: "stopped", text: `${t.id} was stopped${byWhom}.` };
    // How it ended, when the lead was told it failed or was stopped, waiting or running, so a resumed session never
    // reports it lost (release 8a plan, choice 4). A finished one's answer, its last reply, says so already.
    if (r.state !== "done") own?.write({ t: "ended", state: r.state });
    t.state = r.state;
    t.answer = r.text;
    t.ended = Date.now();
    const name = `Background task ${t.id} (${t.description})`;
    const { id, kind } = t;
    if (t.background && r.state === "done") this.#inbox.push({ id, kind, text: `${name} finished:\n${truncate(r.text)}`, wake: true });
    if (t.background && r.state === "failed") this.#inbox.push({ id, kind, text: `${name} failed: ${r.text}`, wake: true });
    // Waking the lead, as a failure does; after an answer, the answer as a finished one's, then the stop's line (the user's
    // choices, 2026-11-09).
    if (t.background && hook !== undefined) {
      const text = r.stop
        ? `${name} finished:\n${truncate(r.stop.answer)}\n${r.stop.line}`
        : `${name} was stopped by a hook${hook ? `: ${hook}` : "."}`;
      this.#inbox.push({ id, kind, text, wake: true });
    }
    if (t.background && r.state === "stopped" && stopped.by) {
      this.#inbox.push({ id, kind, text: `${name} was stopped${byWhom}.`, wake: false });
    }
    this.#changed();
    return r;
  }

  // Null when it was stopped, by the user or the lead's turn; a hook's stop has its own result, with `hook` its stopReason.
  async #work(
    t: SubagentTask,
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
      // A reconnect's grey line goes to the lead's bus, which shows it, as the servers' own lines do.
      ...(this.opts.mcp ? { mcp: mcpTools(this.opts.mcp, this.opts.bus, approveOf(this.opts.mcp), { trustedOnly: true }) } : {}),
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

  // A command that came to its end by itself (choice 5). A command the list already stopped or timed out has had its
  // ending recorded, so the end its kill settles `done` with is ignored. With nothing unread the line is the plan's own,
  // in place of deliver's "No new output." ("Lines this plan adds").
  #exited(t: CommandTask, r: ExecResult): void {
    if (t.state !== "running") return;
    t.code = r.code;
    t.signal = r.signal;
    const head = `Background command ${t.id} (${headCommand(t.command)}) ${r.code !== null ? `ended with exit code ${r.code}` : `was killed by ${r.signal}`}`;
    const text = () => (t.run.log.unread() ? deliver(`${head}:`, t.run.log, t.id) : `${head}, with no new output.`);
    this.#ended(t, r.code === 0 ? "done" : "failed", text, true);
  }

  // Choice 23. The error is cut as a command is, so the head stays short and the output has room (As built, Task 1).
  #failed(t: CommandTask, err: unknown): void {
    if (t.state !== "running") return;
    t.error = headCommand(errorText(err));
    const head = `Background command ${t.id} (${headCommand(t.command)}) failed: ${t.error}`;
    this.#ended(t, "failed", () => deliver(head, t.run.log, t.id), true);
  }

  // The -p limit (choice 8), in the design's words ("With -p"), the output read from the log, as the box's `done` has
  // none for a stopped command (As built, Task 3).
  #limit(t: CommandTask): void {
    t.run.stop();
    t.limited = true;
    const head = `Background command "${headCommand(t.command)}" was stopped after reaching its background time limit`;
    this.#ended(t, "stopped", () => deliver(head, t.run.log, t.id), true);
  }

  // Said at the next turn without starting one, as a stopped subagent's note is (choice 7).
  #stopCommand(t: CommandTask, by: "user" | "tool"): void {
    t.run.stop();
    const text = `Background command ${t.id} (${headCommand(t.command)}) was stopped by ${by === "user" ? "the user" : "stop_task"}.`;
    this.#ended(t, "stopped", text, false);
  }

  #ended(t: CommandTask, state: "done" | "failed" | "stopped", text: string | (() => string), wake: boolean): void {
    clearTimeout(this.#timers.get(t.id));
    this.#timers.delete(t.id);
    t.state = state;
    t.ended = Date.now();
    this.opts.transcript?.()?.write({ t: "command-ended", id: t.id, state });
    this.#inbox.push({ id: t.id, kind: "command", text, wake });
    this.#changed();
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
