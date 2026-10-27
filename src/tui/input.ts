// The keyboard Ink reads in place of process.stdin (release 5 design, "The mouse", "Reading it"). With mouse reports on,
// the terminal sends them on stdin among the keys, and Ink would take each for an unknown key; so whole reports are taken
// out here for the App, and everything else reaches Ink unchanged and in order.
import { EventEmitter } from "node:events";

export interface Mouse {
  kind: "press" | "release" | "drag" | "wheel";
  button: "left" | "middle" | "right" | "none"; // "none" for the wheel
  wheel?: "up" | "down";
  x: number; // 0-based column
  y: number; // 0-based row
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}
export type Piece = { keys: string } | { mouse: Mouse };
type State = { held: string; pasting: boolean; tail: string };
type Source = Pick<NodeJS.ReadStream, "on" | "off" | "setRawMode" | "setEncoding" | "ref" | "unref">;

// The markers Ink reads pastes by (`pasteStart` and `pasteEnd` in Ink's input-parser.js).
export const PASTE_START = "\u001b[200~";
export const PASTE_END = "\u001b[201~";
// A whole SGR report, as the probe got them: ESC [ <, then b, x and y, then M (press, drag, wheel) or m (release).
const REPORT = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])/;
// What could still become a report if the rest came: ESC, ESC[, ESC[<, then up to three numbers and the semicolons between.
const PARTIAL = /^\u001b(\[(<(\d+;){0,2}\d*)?)?$/;
// The bits of b the report format names: 64 the wheel, 32 a drag, 16 Ctrl, 8 Alt, 4 Shift, 3 the button.
const NAMED = 64 | 32 | 16 | 8 | 4 | 3;
const BUTTONS = ["left", "middle", "right", "none"] as const; // b & 3: 0 left, 1 middle, 2 right, 3 none

// A report with a bit the format doesn't name, or a wheel with 2 or 32 also set (the probe never sent one), is not one the
// screen uses: it is still taken out (design, "Reading it"), and dropped, since Ink would type it into the prompt.
function decode(report: RegExpExecArray): Mouse | null {
  const b = Number(report[1]);
  const wheel = (b & 64) !== 0;
  if ((b & ~NAMED) !== 0 || (wheel && (b & (32 | 2)) !== 0)) return null;
  // x and y are 1-based in the report.
  const at = { x: Number(report[2]) - 1, y: Number(report[3]) - 1, shift: (b & 4) !== 0, alt: (b & 8) !== 0, ctrl: (b & 16) !== 0 };
  if (wheel) return { kind: "wheel", button: "none", wheel: (b & 1) !== 0 ? "down" : "up", ...at };
  return { kind: report[4] === "m" ? "release" : (b & 32) !== 0 ? "drag" : "press", button: BUTTONS[b & 3]!, ...at };
}

// One read's pieces, in order, and what is held back for the next read. `held` is the end of a read that could still be
// a report or a paste's start marker; `tail` is the last characters of a paste, so an end marker split across reads is
// still found. Nothing is taken out of a paste, so pasted text shaped like a report arrives as text.
export function split(state: State, chunk: string): { pieces: Piece[]; state: State } {
  const pieces: Piece[] = [];
  const text = state.held + chunk;
  let { pasting, tail } = state;
  let held = "";
  let keys = "";
  let i = 0;
  while (i < text.length) {
    if (pasting) {
      const rest = text.slice(i);
      const at = (tail + rest).indexOf(PASTE_END);
      if (at === -1) {
        keys += rest;
        // One character short of the marker: a whole marker in it would already have been found.
        tail = (tail + rest).slice(-(PASTE_END.length - 1));
        break;
      }
      const end = at + PASTE_END.length - tail.length;
      keys += rest.slice(0, end);
      i += end;
      pasting = false;
      tail = "";
      continue;
    }
    const esc = text.indexOf("\u001b", i);
    if (esc === -1) {
      keys += text.slice(i);
      break;
    }
    keys += text.slice(i, esc);
    const rest = text.slice(esc);
    const report = REPORT.exec(rest);
    if (report) {
      if (keys) pieces.push({ keys });
      keys = "";
      const mouse = decode(report);
      if (mouse) pieces.push({ mouse });
      i = esc + report[0].length;
    } else if (rest.startsWith(PASTE_START)) {
      keys += PASTE_START;
      i = esc + PASTE_START.length;
      pasting = true;
    } else if (PARTIAL.test(rest) || PASTE_START.startsWith(rest)) {
      held = rest;
      break;
    } else {
      keys += "\u001b";
      i = esc + 1;
    }
  }
  if (keys) pieces.push({ keys });
  return { pieces, state: { held, pasting, tail } };
}

// Ink reads it as it reads process.stdin: "readable", then read() until null (Ink's components/App.js). It emits "mouse"
// (a Mouse) for the App.
export class InputFilter extends EventEmitter {
  readonly isTTY = true;
  readonly #source: Source;
  readonly #wait: number;
  #state: State = { held: "", pasting: false, tail: "" };
  #waiting: string[] = [];
  #timer: NodeJS.Timeout | undefined;
  #holding = false;
  // Ink's last word on raw mode and ref, for when a hold ends.
  #rawOff = false;
  #unrefd = false;
  #divert: ((keys: string) => void) | null = null;

  // wait: 20 ms by default, Ink's own wait for the rest of a key (`pendingInputFlushDelayMilliseconds` in Ink's
  // components/App.js). Reading the source as utf8 makes a character split across reads arrive whole.
  constructor(source: Source, wait = 20) {
    super();
    this.#source = source;
    this.#wait = wait;
    source.setEncoding("utf8");
    source.on("data", (chunk: string | Buffer) => this.#take(String(chunk)));
    // A stream tells a readable listener added while data waits, on the next tick. Ink removes its listener in
    // suspendTerminal() and adds it back on resume, and adds it first when useInput mounts: keys typed meanwhile would
    // otherwise wait for the next key.
    this.on("newListener", (event: string | symbol) => {
      if (event === "readable" && this.#waiting.length > 0) process.nextTick(() => this.emit("readable"));
    });
  }

  // Ink's kitty check (confirmKittySupport in Ink's ink.js) hands back, as bytes, what it heard that was not the
  // terminal's answer.
  unshift(chunk: string | Uint8Array): void {
    this.#waiting.unshift(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    this.emit("readable");
  }

  setRawMode(on: boolean): this {
    this.#rawOff = !on;
    if (on || !this.#holding) this.#source.setRawMode(on);
    return this;
  }

  setEncoding(e: BufferEncoding): this {
    this.#source.setEncoding(e);
    return this;
  }

  ref(): this {
    this.#unrefd = false;
    this.#source.ref();
    return this;
  }

  unref(): this {
    this.#unrefd = true;
    if (!this.#holding) this.#source.unref();
    return this;
  }

  // While held, Ink's setRawMode(false) and unref() are not passed on: a switch's suspend and resume would turn raw mode
  // off and on within about 15 ms, which after a few switches left the Windows console reading whole lines (release 5
  // design, "Switching during a session"). Held around every switch and through `[`. If off or unref was still Ink's
  // last word when the hold ends (Ink unmounted meanwhile), it is passed on then, so the terminal isn't left raw and the
  // process can exit.
  hold(on: boolean): void {
    this.#holding = on;
    if (on) return;
    if (this.#rawOff) this.#source.setRawMode(false);
    if (this.#unrefd) this.#source.unref();
  }

  read(): string | null {
    return this.#waiting.shift() ?? null;
  }

  // For `[` (release 5 design, "The detail view"): keys go to `to` and reports are dropped, until divert(null). Keys come
  // as they were read, so one call can hold several keys ("qx", or Escape with more after it): look at each key in it,
  // not the whole string. Text held for the rest of a report goes, when its wait ends, to whoever has the keys then; and
  // after a divert(null) made during one read, that read's later pieces go to Ink and the App.
  divert(to: ((keys: string) => void) | null): void {
    this.#divert = to;
  }

  #take(chunk: string): void {
    clearTimeout(this.#timer);
    const { pieces, state } = split(this.#state, chunk);
    this.#state = state;
    for (const piece of pieces) {
      if ("keys" in piece) this.#keys(piece.keys);
      else if (!this.#divert) this.emit("mouse", piece.mouse);
    }
    // If the rest doesn't come in time, what was held goes to Ink as it was.
    if (state.held) {
      this.#timer = setTimeout(() => {
        const held = this.#state.held;
        this.#state = { ...this.#state, held: "" };
        this.#keys(held);
      }, this.#wait);
    }
  }

  #keys(keys: string): void {
    if (this.#divert) {
      this.#divert(keys);
      return;
    }
    this.#waiting.push(keys);
    // "data" as a stream emits it, for Ink's kitty check, which listens for the terminal's answer that way.
    this.emit("data", keys);
    this.emit("readable");
  }
}
