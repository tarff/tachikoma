import { existsSync } from "node:fs";
import type { Bus } from "../core/bus.js";
import { connect, type Kind, type Palace, type Target } from "./client.js";
import { FIGURES, type Figures, Hub, type Joined, type Why } from "./hub.js";
import { install, type Program, readyFile } from "./install.js";
import { type MemoryPaths, memoryPaths } from "./paths.js";

// Memory's state (8d plan, step 21): the one object the rest of Tachikoma talks to. It runs the installer in the
// background (step 19) and joins the hub when the environment is ready (step 20), or starts the user's own MemPalace
// as it is; it answers "is memory on now?"; it sends each change of state once as an event, and each failure once to
// the error log under the kind `memory` (Q15); it owns the lesson requests still running; and it closes in two stages.
// Nothing here throws into a turn.

// Its states. "not set up" carries the design's no-uv line when the installer found no uv: that is not a failure of
// this run (Q14: it has its own launch line), so it writes no error row. "setting up" covers the install and the join
// (or the start of the user's own program) until memory is on.
export type MemoryState =
  | { is: "switched off" }
  | { is: "not set up"; reason?: string }
  | { is: "setting up" }
  | { is: "on" }
  | { is: "failing"; reason: string }
  | { is: "off"; reason: string }
  | { is: "winding down" }
  | { is: "closed" };

export interface MemoryOptions {
  // resolve(...).memory (step 15): switched off, Tachikoma's own palace, or the user's own program by its full path.
  memory: "off" | "own" | { use: string };
  bus: Bus;
  // The lead's id, for the error rows, as the MCP servers give it.
  lead: () => string;
  // Tachikoma's own memory folder (step 16); memoryPaths() when not given.
  paths?: MemoryPaths;
  // The environment the installer's and the hub's are built from (step 16). The user's own program gets this
  // process's commandEnv and nothing more (the palace client, step 18).
  env?: NodeJS.ProcessEnv;
  // How a program is started by its full path: as it is. A test starts the stand-ins with Node.
  launch?: (file: string) => Program;
  // The hub's figures (step 20); a test gives shorter ones.
  figures?: Partial<Figures>;
  // For the installer (step 19): uv as found on PATH when not given, and the model's address and hash.
  uv?: Program | null;
  model?: { url: string; sha256: string };
}

export interface CloseOptions {
  // The lesson requests still running: waited for (`-p`) or cancelled (the window), Q16.
  lessons: "wait" | "cancel";
  // The saver's last chance (step 22), given a signal that fires when its limit passes or the caller's signal fires.
  save?: { limit: number; run: (signal: AbortSignal) => Promise<unknown> };
  // The caller's stop signal: every wait of the first stage ends at once, and what it waited for is cancelled.
  signal?: AbortSignal;
}

// The lines, as the user approved them (the design's two; the plan's step 21, 2026-11-20; the hub's details and the
// read-back line, 2026-11-20). The installer's reasons (the user's choices at step 19) go inside "setting it up
// failed".
export const NO_UV = "Memory is off: it needs uv, which was not found on PATH. Install uv " +
  "(https://docs.astral.sh/uv/) and start Tachikoma again.";
const newerPalace = (version: string) =>
  `Memory is off: a newer Tachikoma has moved the palace to MemPalace ${version}. Update Tachikoma to use memory ` +
  "again.";
const setUpFailed = (said: string) => `Memory is off: setting it up failed (${said}). The next launch tries again.`;
const MODEL_HASH = "Memory is off: the downloaded model did not match its expected hash. The next launch tries again.";
const notStarted = (detail: string) => `Memory is off: the hub did not start (${detail}).`;
const notTachikomas = (reported: string) =>
  `Memory is off: the hub is not using Tachikoma's storage and model (${reported}).`;
const FAILING = "Memory is failing: the hub stopped answering; restarting it.";
const notRestarted = (detail: string) =>
  `Memory is off: the hub stopped answering and could not be restarted (${detail}).`;
const programNotStarted = (file: string, detail: string) => `Memory is off: ${file} could not be started (${detail}).`;
const lacking = (file: string, names: string[]) =>
  `Memory is off: your MemPalace at ${file} does not offer ${names.join(" and ")}, which Tachikoma needs.`;
const READ_BACK_LATE = "Memory is off: the hub did not say in time which storage and model it uses. The next launch " +
  "tries again.";
// Approved with step 21's review (the user, 2026-11-20): the read-back's other failures, the form of what the hub
// reported, the user's own program lost once on, and the error row's `attempted`.
const READ_BACK_NONE = "Memory is off: the hub did not say which storage and model it uses. The next launch tries " +
  "again.";
const reportedOf = (w: { backend?: string; model?: string }) =>
  [`backend: ${w.backend ?? "none"}`, ...(w.model === undefined ? [] : [`model: ${w.model}`])].join(", ");
const programLost = (file: string) => `Memory is off: your MemPalace at ${file} stopped answering.`;
const ATTEMPTED = "memory";

const seconds = (ms: number) => `${ms / 1000} s`;

// A hub's reason, by the hub's own kinds (step 20). `restart`: the start was the restart of a hub that stopped
// answering.
function hubLine(why: Why, restart: boolean, startLimit: number): string {
  if (why.is === "newer palace") return newerPalace(why.version);
  if (why.is === "read-back") return why.failed === "timed out" ? READ_BACK_LATE : READ_BACK_NONE;
  if (why.is === "not tachikoma's") return notTachikomas(reportedOf(why));
  const detail =
    why.is === "lock" ? "the hub lock could not be taken"
    : why.is === "no port" ? "no free port could be found"
    : why.is === "exited" ? (why.signal ? `ended by signal ${why.signal}` : `exit code: ${why.code}`)
    : why.is === "start limit" ? `it did not answer within ${seconds(startLimit)}`
    : why.is === "start time" ? "its start time could not be read"
    : why.detail; // Node's own words: a program that could not be started, or a folder that could not be made
  return restart ? notRestarted(detail) : notStarted(detail);
}

// Waits `ms`, or less when the signal fires.
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

// Waits for `p`, or less when the signal fires.
const until = (p: Promise<unknown>, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      signal?.removeEventListener("abort", done);
      resolve();
    };
    signal?.addEventListener("abort", done, { once: true });
    void p.then(done, done);
  });

interface Request {
  stop: AbortController;
  done: Promise<void>;
}

export class Memory {
  readonly #bus: Bus;
  readonly #lead: () => string;
  readonly #paths: MemoryPaths | undefined;
  readonly #use: string | undefined;
  readonly #env: NodeJS.ProcessEnv;
  readonly #launch: (file: string) => Program;
  readonly #f: Figures;
  readonly #o: MemoryOptions;
  #state: MemoryState;
  #palace: Palace | undefined;
  #hub: Hub | undefined;
  // Each connection's number: a loss is taken only from the connection in use.
  #link = 0;
  #started = false;
  // Stage one, and stage two.
  #winding = false;
  #closed = false;
  #closing: Promise<void> | undefined;
  // Stops a running install, and the wait on another window's install.
  readonly #stop = new AbortController();
  // What runs in the background: the install, the join, a restart, a connect; closing waits for it in stage two.
  readonly #tasks = new Set<Promise<void>>();
  readonly #requests = new Set<Request>();

  constructor(o: MemoryOptions) {
    this.#o = o;
    this.#bus = o.bus;
    this.#lead = o.lead;
    this.#use = typeof o.memory === "object" ? o.memory.use : undefined;
    this.#paths = o.memory === "own" ? (o.paths ?? memoryPaths()) : undefined;
    this.#env = o.env ?? process.env;
    this.#launch = o.launch ?? ((file) => ({ command: file, args: [] }));
    this.#f = { ...FIGURES, ...o.figures };
    this.#state =
      o.memory === "off" ? { is: "switched off" }
      : this.#use !== undefined || existsSync(readyFile(this.#paths!)) ? { is: "setting up" }
      : { is: "not set up" };
  }

  get state(): MemoryState {
    return this.#state;
  }

  // "Is memory on now?": connected and able to search and store.
  on(): boolean {
    return this.#state.is === "on";
  }

  // The palace while connected, for the saver and the tools; during the first stage of closing too, for what is
  // settled then.
  get palace(): Palace | undefined {
    return this.#closed ? undefined : this.#palace;
  }

  // Which of the optional tools the palace offers (the plan's table "What each palace must offer"): the look-up and
  // removal by exact label, and the counts. The user's own MemPalace may lack them; each user takes its fallback.
  get offers(): { lookup: boolean; counts: boolean } | undefined {
    const p = this.palace;
    return p && { lookup: p.offers.lookup, counts: p.offers.counts };
  }

  // At launch, in the background: joins the hub when the environment is ready, or starts the user's own program.
  start(): void {
    if (this.#started || this.#winding || this.#state.is !== "setting up") return;
    this.#started = true;
    if (this.#use !== undefined) {
      const p = this.#launch(this.#use);
      this.#track(this.#open({ command: p.command, args: p.args }, "use", false));
    } else this.#track(this.#join());
  }

  // Sets up Tachikoma's own palace in the background ("Yes", or /memory setup), then joins. Also off after an install
  // that failed in this launch, its environment still without a ready file (/memory setup's "Try again now", the
  // user's choice at step 28): the failed try let its lock go, and its folder is made again.
  setUp(): void {
    if (this.#use !== undefined || this.#winding) return;
    const failed = this.#state.is === "off" && !existsSync(readyFile(this.#paths!));
    if (this.#state.is !== "not set up" && !failed) return;
    this.#started = true;
    this.#change({ is: "setting up" });
    this.#track(this.#install());
  }

  // A lesson request (step 26), owned here with a stop signal of its own: `ask` runs now; what it answers is stored
  // by `store` while the palace is connected, also during the first stage of closing, and never once closed. A request
  // that fails or is cancelled stores nothing. None starts unless memory is on, so no paid request goes out in any
  // other state, once closing has begun included (the user's choice after step 26's review, 2026-11-20); the store
  // still goes by the palace, so a lesson waited for during closing's first stage is stored.
  lesson<T>(
    ask: (signal: AbortSignal) => Promise<T | undefined>,
    store: (palace: Palace, value: T) => Promise<unknown>,
  ): void {
    if (this.#winding || this.#state.is !== "on") return;
    const r: Request = { stop: new AbortController(), done: Promise.resolve() };
    this.#requests.add(r);
    r.done = (async () => {
      try {
        const value = await ask(r.stop.signal);
        const palace = this.palace;
        if (value === undefined || r.stop.signal.aborted || !palace) return;
        await store(palace, value);
      } catch {
        // stores nothing, and nothing of it reaches a turn
      } finally {
        this.#requests.delete(r);
      }
    })();
  }

  // Waits for the lesson requests running now (step 26): one that answers meanwhile stores its lesson, once, as at
  // any other time. When `signal` fires, the wait ends at once and they are cancelled.
  async waitLessons(signal?: AbortSignal): Promise<void> {
    const requests = [...this.#requests];
    await until(Promise.all(requests.map((r) => r.done)), signal);
    if (signal?.aborted) for (const r of requests) r.stop.abort();
  }

  // Cancels the lesson requests running now: each stores nothing and reports nothing.
  cancelLessons(): void {
    for (const r of this.#requests) r.stop.abort();
  }

  // A kill signal (8d plan, step 27): only this window's "in use" file is removed, as the process exits at once.
  killed(): void {
    this.#hub?.dropInUse();
  }

  // Closing, one operation for the whole service, safe to call twice: the first call's options hold.
  close(o: CloseOptions): Promise<void> {
    this.#closing ??= this.#close(o);
    return this.#closing;
  }

  // Stage one, winding down: nothing new starts; a running install is stopped and a wait on another window's install
  // ended; the lesson requests are waited for or cancelled; then the saver's last chance, up to its limit, which a join
  // and connect already under way are first let finish inside (the user's choice after step 27's review, "A: wait,
  // then save": M2's limit covers a hub still starting), a start that fails meanwhile saying so as at any other time.
  // Stage two,
  // closed: the palace connection is closed, which ends a request still out, the user's own program with it; the
  // supervisor is closed and the hub left (a leave behind a join that is starting a hub can take up to the start limit
  // and the stop, which the caller's signal does not cut, step 20); a connect still under way is waited for, up to its
  // own limit, and closes what it opened. From then on anything that completes is dropped.
  async #close(o: CloseOptions): Promise<void> {
    const cut = o.signal;
    this.#emit({ is: "winding down" });
    this.#winding = true;
    this.#stop.abort();
    if (o.lessons === "cancel") this.cancelLessons();
    else await this.waitLessons(cut);
    if (o.save && !cut?.aborted) {
      const limit = new AbortController();
      const timer = setTimeout(() => limit.abort(), o.save.limit);
      const end = () => limit.abort();
      cut?.addEventListener("abort", end, { once: true });
      const run = o.save.run;
      try {
        await until(Promise.all([...this.#tasks]), limit.signal);
        // Run inside an async function, so a saver that throws at once is caught as one that rejects.
        if (!limit.signal.aborted) await until((async () => run(limit.signal))().catch(() => {}), limit.signal);
      } finally {
        clearTimeout(timer);
        cut?.removeEventListener("abort", end);
        limit.abort();
      }
    }
    this.#closed = true;
    this.#emit({ is: "closed" });
    for (const r of this.#requests) r.stop.abort();
    const palace = this.#palace;
    this.#palace = undefined;
    await palace?.close();
    await this.#hub?.close(cut);
    while (this.#tasks.size) await Promise.all([...this.#tasks]);
  }

  // Runs the installer, trying again every lock retry while another window installs (M3), then joins.
  async #install(): Promise<void> {
    for (;;) {
      const r = await install({ paths: this.#paths!, env: this.#env, uv: this.#o.uv, model: this.#o.model,
        launch: this.#launch, signal: this.#stop.signal });
      if (this.#winding) return;
      if (r.is === "another window is installing") {
        await wait(this.#f.lockRetry, this.#stop.signal);
        if (this.#winding) return;
        continue;
      }
      if (r.is === "ready") return this.#join();
      if (r.is === "no uv") return this.#change({ is: "not set up", reason: NO_UV });
      if (r.is === "model hash") return this.#fail({ is: "off", reason: MODEL_HASH });
      if (r.is === "failed") return this.#fail({ is: "off", reason: setUpFailed(r.reason) });
      return; // "stopped": only by closing
    }
  }

  async #join(): Promise<void> {
    this.#hub ??= new Hub({ paths: this.#paths!, env: this.#env, launch: this.#launch, figures: this.#f,
      onEvent: (e) => {
        if (e.is === "failing") this.#track(this.#lost(this.#link));
      } });
    await this.#joined(await this.#hub.join(), false);
  }

  // A join's end. A start that exits with code 2 and ends in another window's hub is a plain join: on (Q8). One that
  // ends during closing's first stage is still taken, for the saver's last chance.
  async #joined(r: Joined, restart: boolean): Promise<void> {
    if (this.#closed || r.is === "closed") return;
    if (r.is === "off") return this.#fail({ is: "off", reason: hubLine(r.why, restart, this.#f.startLimit) });
    await this.#open({ url: r.url }, "own", restart);
  }

  // Connects this window's own palace client. To the hub within the read-back's limit, which was measured over a
  // connect and more (step 20's run 3); to the user's own program within the start limit, M3's one limit for every
  // start. A connect that completes during closing's first stage gives the saver the palace, memory's state staying
  // as it is, and starts no restart; one that completes once closed closes what it opened.
  async #open(target: Target, kind: Kind, restart: boolean): Promise<void> {
    const timeout = kind === "use" ? this.#f.startLimit : this.#f.readBack;
    const link = ++this.#link;
    const c = await connect(target, kind, { timeout, onLost: () => this.#track(this.#lost(link)) });
    if (this.#closed) {
      if (c.is === "connected") await c.palace.close();
      return;
    }
    if (c.is !== "connected") {
      const detail = c.is === "timed out" ? `it did not answer within ${seconds(timeout)}` : c.reason;
      if (kind === "use") return this.#fail({ is: "off", reason: programNotStarted(this.#use!, detail) });
      if (this.#winding) return;
      if (restart) return this.#fail({ is: "off", reason: notRestarted(detail) });
      return this.#restart();
    }
    if (kind === "use" && c.palace.offers.missing.length) {
      await c.palace.close();
      return this.#fail({ is: "off", reason: lacking(this.#use!, c.palace.offers.missing) });
    }
    this.#palace = c.palace;
    this.#change({ is: "on" });
  }

  // The palace was lost (a hub that cannot be reached, a program that exited), or the hub's timer found the hub gone
  // or stopping: Tachikoma's own hub is restarted once; the user's own program turns memory off.
  async #lost(link: number): Promise<void> {
    if (this.#winding || link !== this.#link || this.#state.is !== "on") return;
    const palace = this.#palace;
    this.#palace = undefined;
    this.#track(palace?.close() ?? Promise.resolve());
    if (this.#use !== undefined) return this.#fail({ is: "off", reason: programLost(this.#use) });
    return this.#restart();
  }

  // One restart: failing, then a join (which the hub's timer may be making too: the supervisor runs one at a time and
  // gives both the same answer), then on, or off with the reason.
  async #restart(): Promise<void> {
    this.#fail({ is: "failing", reason: FAILING });
    await this.#joined(await this.#hub!.join(), true);
  }

  #track(p: Promise<void>): void {
    const t = p.catch(() => {}).finally(() => this.#tasks.delete(t));
    this.#tasks.add(t);
  }

  // A change of state, sent once; none once closing has begun.
  #change(state: MemoryState): void {
    if (this.#winding) return;
    this.#emit(state);
  }

  // A failure: its change of state, and one error row; also during closing's first stage, as a join or connect under
  // way then still ends (none once closed).
  #fail(state: { is: "off" | "failing"; reason: string }): void {
    if (this.#closed) return;
    this.#emit(state);
    this.#bus.emit("error", { kind: "memory", attempted: ATTEMPTED, message: state.reason, lead: this.#lead() });
  }

  #emit(state: MemoryState): void {
    this.#state = state;
    this.#bus.emit("memory", state);
  }
}
