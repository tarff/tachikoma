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
// `lead`: the first half of a character typed as two win32 records (below), until the second comes.
type State = { held: string; pasting: boolean; tail: string; lead?: string };
type Source = Pick<NodeJS.ReadStream, "on" | "off" | "setRawMode" | "setEncoding" | "ref" | "unref" | "pause" | "resume">;

// The markers Ink reads pastes by (`pasteStart` and `pasteEnd` in Ink's input-parser.js).
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
// A whole SGR report, as the probe got them: ESC [ <, then b, x and y, then M (press, drag, wheel) or m (release).
const REPORT = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])/;
// What could still become a report or a win32 record if the rest came: ESC, ESC[, ESC[<, then up to three numbers and the
// semicolons between; or ESC[ and up to six numbers, any left out, and the semicolons between.
const PARTIAL = /^\u001b(\[(<(\d+;){0,2}\d*|(\d*;){0,5}\d*)?)?$/;
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

// Windows Terminal's win32 input mode (release 7 plan, Task 22), where Shift+Enter comes apart from Enter: the probe found
// Windows Terminal sends both as CR otherwise, and does not answer kitty's query. Each key comes as a record
// `CSI Vk;Sc;Uc;Kd;Cs;Rc _`, a KEY_EVENT_RECORD's virtual key, scan code, character, key down, modifier keys and repeat
// count, any left out taking its default (0, but Rc 1): the format of Microsoft's spec, "Improved keyboard handling in
// Conpty" (microsoft/terminal, doc/specs/#4999 - Improved keyboard handling in Conpty.md). Each becomes the bytes Windows
// Terminal sends for the key outside the mode, which Ink reads today, as its src/terminal/input/terminalInput.cpp makes
// them (read 2026-11-05), except Shift+Enter, which becomes Ctrl+J's LF, chat:newline's other key. A paste's text comes
// plain (the probe), its line breaks as records (pasted, below), and where the mode is not taken up (tmux inside Windows
// Terminal) every key does: plain bytes pass as before.
const RECORD = /^\u001b\[(\d*(?:;\d*){0,5})_/;
// Cs's bits, as wincon.h names them: RIGHT_ALT_PRESSED and LEFT_ALT_PRESSED, the two CTRL_PRESSED, SHIFT_PRESSED. The
// rest (NumLock on, the probe's 0x20, CapsLock, ENHANCED_KEY) are no modifier.
const ALT = 0x1 | 0x2;
const CTRL = 0x4 | 0x8;
const SHIFT = 0x10;
// By virtual key, the keys terminalInput.cpp's _encodeRegular gives a sequence of their own: PgUp, PgDn, End, Home, the
// arrows, Insert, Delete, F1 to F12, each as its number and final. A final letter comes as CSI and the letter (SS3 for F1
// to F4), or CSI 1;m and the letter with modifiers; a number and ~ as CSI n~, or CSI n;m~.
const KEYS: Record<number, [string, string]> = {
  33: ["5", "~"], 34: ["6", "~"], 35: ["", "F"], 36: ["", "H"], 37: ["", "D"], 38: ["", "A"], 39: ["", "C"], 40: ["", "B"],
  45: ["2", "~"], 46: ["3", "~"],
  112: ["", "P"], 113: ["", "Q"], 114: ["", "R"], 115: ["", "S"],
  116: ["15", "~"], 117: ["17", "~"], 118: ["18", "~"], 119: ["19", "~"], 120: ["20", "~"], 121: ["21", "~"],
  122: ["23", "~"], 123: ["24", "~"],
};

// terminalInput.cpp's _makeCtrlChar: what Ctrl makes of a character.
function ctrlChar(c: number): number {
  if (c === 0x20) return 0; // Space
  if (c === 0x2f) return 0x1f; // /
  if (c === 0x3f) return 0x7f; // ?
  if (c >= 0x40 && c <= 0x7e) return c & 0x1f;
  if (c >= 0x32 && c <= 0x38) return [0, 27, 28, 29, 30, 31, 127][c - 0x32]!; // 2 to 8
  return c;
}

// One record's keys, and the half character still waiting. Only a key going down types: key-ups, and a key held alone
// with no character (Shift, Ctrl, Alt, CapsLock), give nothing, as terminalInput.cpp's HandleKey drops them. Ctrl and
// Alt held with a printable character are AltGr (`@` on a German keyboard), and type the character alone, unless both
// Ctrls or both Alts are down (HandleKey's altGrPressed). Alt puts ESC first, as its _formatFallback does; Ctrl+Space is
// NUL whatever its character. A character in two halves (UTF-16's surrogate pair) waits for its second, over key-ups.
// The repeat count Rc is not followed: each key types once. The probe only ever got Rc 1, a held key coming as a record
// for each repeat, and a record with a huge Rc, which pasted or printed text could carry, would build a huge string.
function translate(record: string, lead: string | undefined): { keys: string; lead?: string } {
  const [vk = 0, , uc = 0, down = 0, cs = 0] = record.split(";").map((p) => (p === "" ? undefined : Number(p)));
  if (down !== 1) return { keys: "", lead };
  if (uc >= 0xd800 && uc <= 0xdbff) return { keys: "", lead: String.fromCharCode(uc) };
  const altGr = (cs & ALT) !== 0 && (cs & CTRL) !== 0 && uc > 0x20 && uc !== 0x7f;
  const alt = (cs & ALT) === ALT || ((cs & ALT) !== 0 && !altGr);
  const ctrl = (cs & CTRL) === CTRL || ((cs & CTRL) !== 0 && !altGr);
  const shift = (cs & SHIFT) !== 0;
  const esc = alt ? "\u001b" : "";
  const seq = KEYS[vk];
  let keys = "";
  if (seq) {
    const m = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0); // xterm's: 1, plus Shift 1, Alt 2, Ctrl 4
    const [n, final] = seq;
    keys = m > 1 ? `\u001b[${n || 1};${m}${final}` : vk >= 112 && vk <= 115 ? `\u001bO${final}` : `\u001b[${n}${final}`;
  } else if (vk === 13) keys = esc + (shift || ctrl ? "\n" : "\r"); // Enter: Ctrl+Enter is LF outside the mode too
  else if (vk === 8) keys = esc + (ctrl ? "\b" : "\u007f"); // Backspace
  else if (vk === 9) keys = esc + (shift ? "\u001b[Z" : "\t"); // Tab
  else {
    const c = ctrl && vk === 0x20 ? 0x20 : uc;
    if (c !== 0) keys = esc + (uc >= 0xdc00 && uc <= 0xdfff ? (lead ?? "") : "") + String.fromCharCode(ctrl ? ctrlChar(c) : c);
  }
  return keys ? { keys } : { keys, lead };
}

// What could still become a record inside a paste: ESC[ and up to six numbers, any left out, and the semicolons between.
const RECORD_PART = /^\u001b\[(\d*;){0,5}\d*$/;
// RECORD read where it stands (sticky), so a long paste is not copied again for each of its line breaks.
const RECORD_AT = new RegExp(RECORD.source.slice(1), "y");

// A paste's text between its markers, with its records translated. In win32 input mode Windows Terminal sends a paste's
// text plain but each line break as Enter's records, down and up, with no modifier (the user's check, 2026-11-05): so it
// becomes CR, as outside the mode, where Windows Terminal turns a pasted CRLF or LF into CR (ControlCore::PasteText's
// FilterStringForPaste, src/types/utils.cpp, read 2026-11-05). That filter also takes ESC out of every paste, so no
// pasted key can make one: a record whose keys would hold ESC is dropped, and nothing translated can end the paste early.
// Plain ESCs just before a record are dropped too (found at Task 22's review): a record that types nothing (a key-up)
// would otherwise join them to the text after it, so `ESC`, a key-up, `[201~` would end the paste for Ink while it goes
// on here. Windows Terminal's pastes hold no ESC, and other terminals' no records, so no real paste loses one.
function pasted(text: string, lead: string | undefined): { keys: string; lead?: string } {
  let keys = "";
  let i = 0;
  for (;;) {
    const esc = text.indexOf("\u001b", i);
    if (esc === -1) return { keys: keys + text.slice(i), lead };
    keys += text.slice(i, esc);
    RECORD_AT.lastIndex = esc;
    const record = RECORD_AT.exec(text);
    if (record) {
      const key = translate(record[1]!, lead);
      // The plain ESCs kept just before it, counted in `text`, not `keys`: reading the end of a string built by joining
      // makes V8 copy it whole, once per line break of a long paste.
      let n = 0;
      while (esc - n > 0 && text[esc - n - 1] === "\u001b") n++;
      if (n) keys = keys.slice(0, -n);
      if (!key.keys.includes("\u001b")) keys += key.keys;
      lead = key.lead;
      i = esc + record[0].length;
    } else {
      keys += "\u001b";
      i = esc + 1;
    }
  }
}

// One read's pieces, in order, and what is held back for the next read. `held` is the end of a read that could still be
// a report, a win32 record or a paste's start marker, or inside a paste a record; `tail` is the last characters of a
// paste, so an end marker split across reads is still found. Nothing is taken out of a paste, so pasted text shaped like
// a report arrives as text. Records are translated (translate, above), inside a paste too (pasted); `lead` carries half a
// character between them.
export function split(state: State, chunk: string): { pieces: Piece[]; state: State } {
  const pieces: Piece[] = [];
  const text = state.held + chunk;
  let { pasting, tail, lead } = state;
  let held = "";
  let record: RegExpExecArray | null;
  let keys = "";
  let i = 0;
  while (i < text.length) {
    if (pasting) {
      const rest = text.slice(i);
      const at = (tail + rest).indexOf(PASTE_END);
      if (at === -1) {
        // What could still be a record or the end marker waits for its rest, a record's start and the marker's being
        // alike (ESC[2). `tail` takes it too, so the marker is still found if the wait ends first; with it held, the
        // next read starts with it, and a marker can only start there, never in `tail`, as ESC opens it.
        const last = rest.lastIndexOf("\u001b");
        const part = rest.slice(last);
        let cut = last !== -1 && (RECORD_PART.test(part) || PASTE_END.startsWith(part)) ? last : rest.length;
        while (cut < rest.length && rest[cut - 1] === "\u001b") cut--; // with the plain ESCs before it (pasted, above)
        const got = pasted(rest.slice(0, cut), lead);
        keys += got.keys;
        lead = got.lead;
        held = rest.slice(cut);
        // One character short of the marker: a whole marker in it would already have been found.
        tail = (tail + rest).slice(-(PASTE_END.length - 1));
        break;
      }
      const end = at + PASTE_END.length - tail.length;
      const marker = Math.max(0, at - tail.length); // where the marker starts in this read, if it does
      const got = pasted(rest.slice(0, marker), lead);
      keys += got.keys + rest.slice(marker, end);
      lead = got.lead;
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
    } else if ((record = RECORD.exec(rest))) {
      const key = translate(record[1]!, lead);
      keys += key.keys;
      lead = key.lead;
      i = esc + record[0].length;
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
  return { pieces, state: { held, pasting, tail, lead } };
}

// One key: an Escape with a whole CSI or SS3 sequence after it (an arrow's ESC [ A), or with one other character (Alt
// and that character), or alone; or any other character. An Escape before another is a key of its own, so two Escapes
// read together are two Escs.
const KEY = /\u001b(?:\[[0-?]*[ -/]*[@-~]|O.|[^\u001b])?|[^]/gu;

// A read of the keys while the detail view is printed out (`[`; release 5 design, "The detail view"): whether it holds a
// q, an Esc or a Ctrl-C, which bring the view back, and where a paste stands after it. A read can hold several keys
// ("xq"), so each key in it is looked at; Esc is an Escape with nothing after it. A paste, from its start marker to its
// end marker, is dropped whole, over as many reads as it takes, its keys never coming back (the user's choice,
// 2026-10-28); `paste` is undefined outside one, and inside one its last characters, one short of the end marker, which
// can be split between two reads. A paste that starts after the key that comes back is kept too, so its rest is dropped
// once back. The start marker comes whole: the filter holds a read's end that could be one until the rest comes (split,
// above). That hold lasts the filter's 20 ms, the wait Ink's own paste reading has, so a start marker whose rest comes
// later is not seen as one; terminals send the marker with the text (a known limit, accepted at Task 13's review).
export function readOut(paste: string | undefined, keys: string): { back: boolean; paste: string | undefined } {
  let back = false;
  let rest = keys;
  for (;;) {
    if (paste !== undefined) {
      const text = paste + rest;
      const end = text.indexOf(PASTE_END);
      if (end === -1) return { back, paste: text.slice(-(PASTE_END.length - 1)) }; // one short: a whole one is found
      paste = undefined;
      rest = text.slice(end + PASTE_END.length);
    }
    const start = rest.indexOf(PASTE_START);
    for (const [k] of (start === -1 ? rest : rest.slice(0, start)).matchAll(KEY)) back ||= k === "q" || k === "\u001b" || k === "\u0003";
    if (start === -1) return { back, paste };
    paste = "";
    rest = rest.slice(start + PASTE_START.length);
  }
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
  readonly #win32: ((on: boolean) => void) | undefined;
  readonly #onData = (chunk: string | Buffer) => this.#take(String(chunk));

  // wait: 20 ms by default, Ink's own wait for the rest of a key (`pendingInputFlushDelayMilliseconds` in Ink's
  // components/App.js). Reading the source as utf8 makes a character split across reads arrive whole. win32: told each
  // time raw mode goes on or off on the source, to turn Windows Terminal's win32 input mode with it (cli.tsx; release 7
  // plan, Task 22). Raw mode is on exactly while the filter reads keys, and goes off on every way out (unmounting, a
  // program in the terminal, the end of a hold), so the mode's records never reach a shell or an editor.
  constructor(source: Source, wait = 20, win32?: (on: boolean) => void) {
    super();
    this.#source = source;
    this.#wait = wait;
    this.#win32 = win32;
    source.setEncoding("utf8");
    source.on("data", this.#onData);
    // A data listener doesn't wake a stream paused on purpose, as the question at the start leaves stdin (cli.tsx,
    // askAtStart); what the terminal gave since then comes now (on Windows, with raw mode off, only a finished line).
    source.resume();
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
    if (on || !this.#holding) this.#raw(on);
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
    if (this.#rawOff) this.#raw(false);
    if (this.#unrefd) this.#source.unref();
  }

  // For a program in the terminal (release 6 plan, Task 1; owner.ts, program): the filter stops reading the source, so
  // the program reads every key itself, and raw mode goes off on the source, whatever Ink's last word was, for a program
  // that reads whole lines. retake() puts both back, before Ink resumes.
  release(): void {
    this.#source.off("data", this.#onData);
    this.#source.pause();
    this.#raw(false);
  }

  retake(): void {
    this.#raw(true);
    this.#source.on("data", this.#onData);
    this.#source.resume();
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

  #raw(on: boolean): void {
    this.#source.setRawMode(on);
    this.#win32?.(on);
  }
}
