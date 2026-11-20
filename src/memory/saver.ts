import { mkdirSync } from "node:fs";
import type { Bus } from "../core/bus.js";
import type { Palace } from "./client.js";
import { FIGURES } from "./hub.js";
import { type OsLock, tryLock } from "./oslock.js";

// The saver of turns (8d plan, step 22): each typed turn the lead's session hands it is saved as one entry in the
// project's room, or, past MemPalace's longest entry, as several parts (Q26), one turn at a time, each turn's whole
// sequence under the palace's save lock (step 17), shared by every Tachikoma process and freed by the system if its
// holder dies. For each entry: its exact label is looked up; the right count of pieces there, nothing to do; another
// count, they are removed by that label and the entry added again; none, it is added. Only when every entry of the turn
// is there is the turn's saved record written. A turn not saved now waits, and is tried again at the next send: a
// turn's end, a shortening, memory on again, or the exit's final save. Nothing here throws into a turn.

// The longest entry MemPalace takes, counted by it in code points (step 6 item 8; mempalace/config.py:283-291). A part
// is cut by Node's count of the string, never fewer than MemPalace's, so no part is over it.
export const LONGEST_ENTRY = 100_000;
// MemPalace splits each entry into pieces of 800 code points and counts a label's entries in pieces (step 6, items 7
// and 8; mempalace/config.py:415, mcp_server/tools_write.py:457-468).
const PIECE = 800;
// An entry's text: the typed words, then each piece of the model's text in order, a blank line between, as the
// measurements of steps 10, 13 and 14 joined them (scripts/8d/measure-save.mjs, JOIN).
const JOIN = "\n\n";

// A typed turn (Q4, Q5): the session's id, its number among the session's prompts, the typed words with each picture
// as its marker, and the model's text in the turn, in order. `record` writes the transcript's saved record, when the
// session is still the window's (Q6).
export interface Turn {
  session: string;
  n: number;
  typed: string;
  texts: string[];
  record: () => void;
}

// One entry of a turn: its label, sent as `source_file`, its text, and the pieces MemPalace makes of it.
export interface Entry {
  label: string;
  text: string;
  pieces: number;
}

// A text cut into parts of at most `limit` characters, by one fixed rule, so the same text always gives the same
// parts: every part but the last as long as the limit allows; a cut never falls between the two halves of a character
// Node holds as a pair, and that part ends one short instead.
function cut(text: string, limit: number): string[] {
  const parts: string[] = [];
  let at = 0;
  while (text.length - at > limit) {
    let end = at + limit;
    const c = text.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end--;
    parts.push(text.slice(at, end));
    at = end;
  }
  parts.push(text.slice(at));
  return parts;
}

const codePoints = (s: string) => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

// A turn's entries: one under the design's label, `tachikoma session <id>, turn <n>`, when it fits; else one per part,
// `tachikoma session <id>, turn <n>, part <k> of <m>` (the user's approval, 2026-11-20), none under the bare label.
export function entriesOf(turn: Omit<Turn, "record">): Entry[] {
  const label = `tachikoma session ${turn.session}, turn ${turn.n}`;
  const parts = cut([turn.typed, ...turn.texts].join(JOIN), LONGEST_ENTRY);
  return parts.map((text, k) => ({
    label: parts.length === 1 ? label : `${label}, part ${k + 1} of ${parts.length}`,
    text,
    pieces: Math.ceil(codePoints(text) / PIECE),
  }));
}

export interface SaverOptions {
  // Memory (step 21): its palace while connected, also while it winds down, read at each try.
  memory: { readonly palace: Palace | undefined };
  // Memory's events (step 21): the turns waiting are sent when memory is on again.
  bus?: Bus;
  // The project's room (step 16).
  room: string;
  // The save lock's folder, one per palace (step 17): made here if missing, inside a folder already private.
  folder: string;
  // Each request's time limit, the caller's.
  timeout: number;
  // The wait between tries for the save lock: M3's, decided at step 8, unless a test gives another.
  retry?: number;
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
const until = (p: Promise<unknown>, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    void p.then(done, done);
  });

export class Saver {
  readonly #o: SaverOptions;
  readonly #retry: number;
  // The turns not yet saved, in the order handed: "Unsaved turns" (step 28) is their count, a turn in parts one turn.
  // Those the palace refused stay unsaved and are not tried again in this run.
  readonly #queue: Turn[] = [];
  readonly #refused = new Set<Turn>();
  #busy: Promise<void> | undefined;
  #again = false;
  #made = false;
  // Fires when the final save's limit passes: nothing more is sent, and a wait for the lock ends at once.
  readonly #halt = new AbortController();

  constructor(o: SaverOptions) {
    this.#o = o;
    this.#retry = o.retry ?? FIGURES.lockRetry;
    o.bus?.on("memory", (state) => {
      if (state.is === "on") this.send();
    });
  }

  get unsaved(): number {
    return this.#queue.length;
  }

  // A turn to save, never waited on; one already waiting is not taken twice.
  hand(turn: Turn): void {
    if (!this.#queue.some((t) => t.session === turn.session && t.n === turn.n)) this.#queue.push(turn);
    this.send();
  }

  // Starts sending the turns not yet saved and returns at once; one pass at a time, and a send during it makes one more
  // pass after it. For onShorten, which cannot throw.
  send(): void {
    if (this.#halt.signal.aborted) return;
    if (this.#busy) {
      this.#again = true;
      return;
    }
    this.#again = false;
    this.#busy = (async () => {
      try {
        await this.#pass();
      } catch {
        // a lock that cannot be taken: the turn waits for the next send
      } finally {
        this.#busy = undefined;
      }
      if (this.#again) this.send();
    })();
  }

  // The final save (the exit, step 27, through memory's closing, step 21): the pass under way, or a new one, until the
  // queue is done or `signal` fires; from then on nothing more is sent. An arrow, as closing calls it unbound.
  readonly run = async (signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return void this.#halt.abort();
    signal.addEventListener("abort", () => this.#halt.abort(), { once: true });
    if (!this.#busy) this.send();
    await this.#settled(signal);
  };

  async #settled(signal: AbortSignal): Promise<void> {
    while (this.#busy && !signal.aborted) await until(this.#busy, signal);
  }

  // Each turn in order until one is not saved now.
  async #pass(): Promise<void> {
    for (;;) {
      const turn = this.#queue.find((t) => !this.#refused.has(t));
      if (!turn) return;
      const r = await this.#save(turn);
      if (r === "saved") this.#queue.splice(this.#queue.indexOf(turn), 1);
      else if (r === "refused") this.#refused.add(turn);
      else return;
    }
  }

  // A turn's whole sequence under the save lock, its saved record written last, then the lock let go.
  async #save(turn: Turn): Promise<"saved" | "refused" | "unsaved"> {
    const lock = await this.#lock();
    if (!lock) return "unsaved";
    try {
      for (const entry of entriesOf(turn)) {
        const palace = this.#o.memory.palace;
        if (!palace || this.#halt.signal.aborted) return "unsaved";
        const r = await this.#put(palace, entry);
        if (r !== "there") return r;
      }
      turn.record();
      return "saved";
    } finally {
      lock.release();
    }
  }

  // One entry made whole. Without the look-up (the user's own older MemPalace), it is added as it is (the design's
  // known limit: a turn a crash cut off may be saved twice). `already_exists` counts as there: the same text is in the
  // room under another label (step 6 item 9). A refusal other than a lost palace is the palace's last word in this run.
  async #put(palace: Palace, entry: Entry): Promise<"there" | "refused" | "unsaved"> {
    const { room, timeout } = this.#o;
    if (palace.offers.lookup) {
      const found = await palace.pieces(entry.label, timeout);
      if (found.is !== "counted") return "unsaved";
      if (found.pieces === entry.pieces) return "there";
      if (found.pieces > 0 && (await palace.remove(entry.label, timeout)).is !== "removed") return "unsaved";
    }
    const added = await palace.add(room, entry.label, entry.text, timeout);
    if (added.is === "added" || added.is === "already there") return "there";
    return added.is === "refused" ? "refused" : "unsaved";
  }

  // The save lock, tried again after the lock retry while another holds it; null once memory is not connected or the
  // final save's limit has passed.
  async #lock(): Promise<OsLock | null> {
    for (;;) {
      if (this.#halt.signal.aborted || !this.#o.memory.palace) return null;
      if (!this.#made) {
        mkdirSync(this.#o.folder, { recursive: true, mode: 0o700 });
        this.#made = true;
      }
      const lock = tryLock(this.#o.folder, "save");
      if (lock) return lock;
      await wait(this.#retry, this.#halt.signal);
    }
  }
}
