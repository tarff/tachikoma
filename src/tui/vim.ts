// Vim mode as plain data (release 6 design, "Vim mode"): `press` takes the state, the editor and one
// key, and gives them back changed, so every row of Claude Code's vim tables is a test fed key by key.
// Where Claude Code's docs leave a key's exact behaviour open, this does what Claude Code 2.1.312's own
// code does where that was read (2026-10-28), and otherwise what Vim does. Every change is one undo
// step through editor.ts's `change`, and `u` is the editor's undo.
import { after, apply, before, boundaries, change, type Editor, lineEnd, lineStart, move } from "./editor.js";

export type VimMode = "INSERT" | "NORMAL" | "VISUAL" | "VISUAL LINE";
type Find = "f" | "F" | "t" | "T";
export interface Vim {
  mode: VimMode;
  pending: string; // the command typed so far after its count: an operator, its own count, a `g`, `r` or f/F/t/T
  count: string; // the digits typed before it
  lastFind?: { op: Find; ch: string }; // for ; and ,
  lastChange?: string[]; // the keys of the last change, with its count, for `.`
  register: { text: string; linewise: boolean }; // the last yank or delete, kept here and never on the clipboard
  anchor?: number; // VISUAL's (Task 20)
  // The column, in characters, that j and k keep across a shorter line (Infinity after $, the line's
  // end), kept with the cursor and text it was set at and used only while both are unchanged, so a
  // change App makes forgets it (Claude Code 2.1.312's own code, read 2026-10-28).
  goal?: { column: number; cursor: number; text: string };
}

export const start: Vim = { mode: "INSERT", pending: "", count: "", register: { text: "", linewise: false } };

type Result = { v: Vim; e: Editor; act?: string };

// One key: a character, or a named key ("escape", "enter", "left", ...). The act is for App to do:
// "submit", "history:previous", "history:next", "history:search" or "help".
export function press(v: Vim, e: Editor, key: string): Result {
  return v.mode === "INSERT" ? insert(v, e, key) : normal(v, e, key);
}

// A character typed in INSERT goes in through editor.ts, as typing, so Task 20's remaps see it; other
// keys are App's own editing, as without vim mode. Esc goes to NORMAL, the cursor back onto the
// character before, as in Vim.
function insert(v: Vim, e: Editor, key: string): Result {
  if (isChar(key)) return { v, e: apply(e, { type: "insert", text: key }) };
  if (key !== "escape") return { v, e };
  const c = e.cursor;
  return { v: { ...v, mode: "NORMAL" }, e: onChar(move(e, c === lineStart(e.text, c) ? c : before(e.text, c))) };
}

const MOTIONS = new Set(["h", "j", "k", "l", " ", "backspace", "left", "right", "up", "down", "w", "e", "b", "0", "$", "^", "G", ";", ",", "%"]);
// Keys that are an operator and a motion, as Vim defines them.
const SHORT = new Map([["x", "dl"], ["s", "cl"], ["D", "d$"], ["C", "c$"], ["S", "cc"], ["Y", "yy"]]);

function normal(v: Vim, e: Editor, key: string, keys = [...v.count, ...v.pending, key]): Result {
  const [, op = "", opCount = "", prefix = ""] = /^([dcy<>]?)(\d*)([gfFtTr]?)$/u.exec(v.pending)!;
  const { goal, ...rest } = v; // a finished command forgets the column j and k keep, unless it is j, k or $
  const done: Vim = { ...rest, pending: "", count: "" };
  const n = Number(v.count || 1) * Number(opCount || 1); // `2d3w` is six words, as in Vim
  const go = (name: string, lastFind = v.lastFind): Result => {
    const w = { ...done, lastFind };
    const kept = goal?.cursor === e.cursor && goal.text === e.text ? goal.column : undefined;
    const m = motion(w, e.text, e.cursor, name, n, v.count + opCount !== "", op, kept);
    if (!m && !op && (name === "j" || name === "down")) return { v: w, e, act: "history:next" };
    if (!m && !op && (name === "k" || name === "up")) return { v: w, e, act: "history:previous" };
    if (!m) return { v: w, e };
    if (op) return operate(w, e, op, m, keys);
    const to = onChar(move(e, m.to));
    return { v: m.goal === undefined ? w : { ...w, goal: { column: m.goal, cursor: to.cursor, text: to.text } }, e: to };
  };
  if (prefix === "r") return isChar(key) ? replaceChars(done, e, key, n, keys) : { v: done, e };
  if (prefix === "g") return key === "g" ? go("gg") : { v: done, e };
  if (prefix) return isChar(key) ? go("find", { op: prefix as Find, ch: key }) : { v: done, e };
  // 0 is the line's start unless it follows a count's digits.
  if (/^\d$/u.test(key) && (key !== "0" || (op ? opCount : v.count))) return { v: op ? { ...v, pending: v.pending + key } : { ...v, count: v.count + key }, e };
  if (/^[gfFtT]$/u.test(key) || (!op && /^[dcy<>r]$/u.test(key))) return { v: { ...v, pending: v.pending + key }, e };
  if (op && key === op) return go("line"); // dd cc yy >> <<
  const short = op ? undefined : SHORT.get(key);
  if (short) return normal({ ...v, pending: short[0]! }, e, short.slice(1), keys);
  if (MOTIONS.has(key)) return go(key);
  return op ? { v: done, e } : command(done, e, key, n, keys); // an operator then a key that is no motion drops both
}

function command(v: Vim, e: Editor, key: string, n: number, keys: string[]): Result {
  const { text, cursor: c } = e;
  switch (key) {
    case "i":
      return toInsert(v, e, keys);
    case "a":
      return toInsert(v, move(e, Math.min(after(text, c), lineEnd(text, c))), keys);
    case "I":
      return toInsert(v, move(e, firstNonBlank(text, c)), keys);
    case "A":
      return toInsert(v, move(e, lineEnd(text, c)), keys);
    case "o": {
      const at = lineEnd(text, c);
      return toInsert(v, change(e, at, at, "\n", { typing: true }), keys);
    }
    case "O": {
      // The cursor before the new line break, the step still open for the typing to join.
      const at = lineStart(text, c);
      return toInsert(v, { ...change(e, at, at, "\n", { typing: true }), cursor: at }, keys);
    }
    case "p":
    case "P":
      return put(v, e, key === "p", n, keys);
    case "J":
      return join(v, e, n, keys);
    case "u": {
      // The editor's undo, `n` steps; each puts back the text and the cursor from before its step.
      let u = e;
      for (let i = 0; i < n; i++) u = apply(u, "undo");
      return { v, e: onChar(u) };
    }
    case "enter":
      return { v, e, act: "submit" };
    case "/":
      return { v, e, act: "history:search" };
    case "?":
      return { v, e, act: "help" };
  }
  return { v, e };
}

// INSERT where the editor's cursor is. A command that changed the text made its step with `typing`, so
// what is typed now joins it: `cw` and the word typed in its place undo together, as in Vim.
function toInsert(v: Vim, e: Editor, keys: string[]): Result {
  return { v: { ...v, mode: "INSERT", lastChange: keys }, e };
}

// In NORMAL the cursor is on a character, so never on a line's end unless the line is empty (Vim).
function onChar(e: Editor): Editor {
  const { text, cursor: c } = e;
  return (c === text.length || text[c] === "\n") && c !== lineStart(text, c) ? move(e, before(text, c)) : e;
}

type Motion = { to: number; kind: "exclusive" | "inclusive" | "line"; goal?: number };

// An operator over the text from the cursor to where the motion goes, by Vim's rules: an inclusive
// motion takes the character it lands on, and an exclusive one ending at a line's start ends at the
// line before's end instead, taking whole lines when it began in its line's indent.
function operate(v: Vim, e: Editor, op: string, m: Motion, keys: string[]): Result {
  const { text, cursor: c } = e;
  let from = Math.min(c, m.to);
  let to = Math.max(c, m.to);
  let line = m.kind === "line";
  if (m.kind === "inclusive") to = after(text, to);
  else if (m.kind === "exclusive" && to > from && text[to - 1] === "\n") {
    to--;
    line = from <= firstNonBlank(text, from);
  }
  if (line || op === ">" || op === "<") [from, to] = [lineStart(text, from), lineEnd(text, to)];
  const register = to > from || line ? { text: text.slice(from, to), linewise: line } : v.register;
  if (op === "y") return { v: { ...v, register }, e: onChar(move(e, Math.min(c, m.to))) }; // the cursor to the yank's start
  if (op === "c") return toInsert({ ...v, register }, change(e, from, to, "", { typing: true }), keys);
  const changed = { ...v, register: op === "d" ? register : v.register, lastChange: keys };
  if (op === ">" || op === "<") {
    const d = change(e, from, to, text.slice(from, to).split("\n").map((l) => shift(l, op)).join("\n"));
    return { v: changed, e: onChar(move(d, firstNonBlank(d.text, from))) };
  }
  if (!line) return { v: changed, e: onChar(change(e, from, to, "")) };
  // Whole lines go with the line break after them, or for the last line the one before.
  const [x, y] = to < text.length ? [from, to + 1] : [Math.max(0, from - 1), to];
  const d = change(e, x, y, "");
  return { v: changed, e: onChar(move(d, firstNonBlank(d.text, x))) };
}

// >> and << as Claude Code 2.1.312's own code does them (read 2026-10-28; the user's choice, two
// spaces): >> puts two spaces before a line; << takes off two spaces, else a tab, else up to two
// leading blanks. An empty line is left alone.
function shift(line: string, op: string): string {
  if (!line) return line;
  if (op === ">") return `  ${line}`;
  if (line.startsWith("  ")) return line.slice(2);
  if (line.startsWith("\t")) return line.slice(1);
  return line.replace(/^\s{1,2}/u, "");
}

// `r`: `n` characters from the cursor, each made `ch`, or nothing when the line has fewer (Vim).
function replaceChars(v: Vim, e: Editor, ch: string, n: number, keys: string[]): Result {
  const t = chars(e.text);
  const k = t.at.indexOf(e.cursor);
  if (k + n > t.ch.length || t.ch.slice(k, k + n).includes("\n")) return { v, e };
  const d = change(e, t.at[k]!, t.at[k + n]!, ch.repeat(n));
  return { v: { ...v, lastChange: keys }, e: move(d, e.cursor + ch.length * (n - 1)) };
}

// `p` and `P`: the register `n` times, after or before the cursor, or below or above its line for a
// yanked line. The cursor goes where Vim puts it: a line's first non-blank, or the last character put
// unless that was more than one line.
function put(v: Vim, e: Editor, below: boolean, n: number, keys: string[]): Result {
  const { text: reg, linewise } = v.register;
  if (!reg && !linewise) return { v, e };
  const { text, cursor: c } = e;
  const done = { ...v, lastChange: keys };
  if (linewise) {
    const lines = Array<string>(n).fill(reg).join("\n");
    const at = below ? lineEnd(text, c) : lineStart(text, c);
    const d = change(e, at, at, below ? `\n${lines}` : `${lines}\n`);
    return { v: done, e: onChar(move(d, firstNonBlank(d.text, below ? at + 1 : at))) };
  }
  const block = reg.repeat(n);
  const at = below ? Math.min(after(text, c), lineEnd(text, c)) : c;
  const d = change(e, at, at, block);
  return { v: done, e: onChar(move(d, block.includes("\n") ? at : before(d.text, at + block.length))) };
}

// `J`: `n` lines (two at least) made one, as Claude Code 2.1.312's own code does it (read 2026-10-28).
// Each joined line loses its indent and gets one space before it, but none when it is empty or starts
// with ")", or the text before is empty or ends in a blank. The cursor goes to the last join.
function join(v: Vim, e: Editor, n: number, keys: string[]): Result {
  const { text, cursor: c } = e;
  const from = lineStart(text, c);
  let to = lineEnd(text, c);
  if (to === text.length) return { v, e };
  let joined = text.slice(from, to);
  let at = 0;
  for (let i = 1; i < Math.max(n, 2) && to < text.length; i++) {
    const end = lineEnd(text, to + 1);
    const next = text.slice(to + 1, end).replace(/^[ \t]+/u, "");
    at = joined.length;
    if (next && !next.startsWith(")") && joined && !/[ \t]$/u.test(joined)) joined += " ";
    joined += next;
    to = end;
  }
  const d = change(e, from, to, joined);
  return { v: { ...v, lastChange: keys }, e: onChar(move(d, from + at)) };
}

// Where a motion goes from `c`, `n` times, or nothing when it cannot go (Vim beeps then and the whole
// command is dropped). `counted` is whether a count was typed, for gg and G, which take it as a line.
// `goal` is the column j and k keep.
function motion(v: Vim, text: string, c: number, key: string, n: number, counted: boolean, op: string, goal?: number): Motion | undefined {
  const t = chars(text);
  const k = t.at.indexOf(c);
  const ex = (i: number): Motion => ({ to: t.at[i]!, kind: "exclusive" });
  switch (key) {
    case "h":
    case "left":
      return ex(Math.max(t.at.indexOf(lineStart(text, c)), k - n));
    case "l":
    case "right":
      return ex(Math.min(t.at.indexOf(lineEnd(text, c)), k + n));
    case " ":
      return ex(across(t, k, n, 1));
    case "backspace":
      return ex(across(t, k, n, -1));
    case "j":
    case "down":
      return vertical(text, c, n, goal);
    case "k":
    case "up":
      return vertical(text, c, -n, goal);
    case "line":
      return vertical(text, c, n - 1);
    case "w":
      // `cw` on a word changes to its end, as `ce`, but not past a word's last character (Vim).
      if (op === "c" && k < t.ch.length && cls(t, k) !== 0) return { to: t.at[wordEnd(t, k, n, true)]!, kind: "inclusive" };
      return ex(wordForward(t, k, n, op !== ""));
    case "e":
      return { to: t.at[wordEnd(t, k, n, false)]!, kind: "inclusive" };
    case "b":
      return ex(wordBack(t, k, n));
    case "0":
      return { to: lineStart(text, c), kind: "exclusive" };
    case "^":
      return { to: firstNonBlank(text, c), kind: "exclusive" };
    case "$": {
      const m = vertical(text, c, n - 1);
      return m && { to: lineEnd(text, m.to), kind: "exclusive", goal: Infinity }; // j and k keep to the line's end
    }
    case "gg":
    case "G":
      // The line's start, as Claude Code's docs and code have it ("Beginning of input", "Beginning of last line").
      return { to: nthLine(text, counted ? n - 1 : key === "gg" ? 0 : Infinity), kind: "line" };
    case "%": {
      const i = bracket(t, k);
      return i === undefined ? undefined : { to: t.at[i]!, kind: "inclusive" };
    }
  }
  // find, ; and ,
  if (!v.lastFind) return undefined;
  const { op: f, ch } = v.lastFind;
  const REVERSE = { f: "F", F: "f", t: "T", T: "t" } as const;
  return find(t, k, key === "," ? REVERSE[f] : f, ch, n, key !== "find");
}

// `n` lines down (up when negative), keeping the column in characters, or `goal` when j and k have one;
// a count past the end stops at the end, but on the last line (or first) already there is nowhere to
// go (Vim).
function vertical(text: string, c: number, n: number, goal?: number): Motion | undefined {
  let s = lineStart(text, c);
  const col = goal ?? chars(text.slice(s, c)).ch.length;
  if (n > 0 && lineEnd(text, c) === text.length) return undefined;
  if (n < 0 && s === 0) return undefined;
  for (let i = 0; i < Math.abs(n); i++) {
    if (n < 0) s = s === 0 ? 0 : lineStart(text, s - 1);
    else if (lineEnd(text, s) < text.length) s = lineEnd(text, s) + 1;
  }
  const line = chars(text.slice(s, lineEnd(text, s)));
  return { to: s + line.at[Math.min(col, line.ch.length)]!, kind: "line", goal: col };
}

// Space and Backspace: `n` characters right or left, over a line break to the next line's start or the
// line before's last character, as Claude Code's do; an empty line is a stop of its own.
function across(t: Chars, k: number, n: number, step: 1 | -1): number {
  for (let i = 0; i < n && k + step >= 0 && k + step <= t.ch.length; i++) {
    k += step;
    if (t.ch[k] === "\n" && !emptyLine(t, k)) k += step;
  }
  return k;
}

// The start of line `n` (from 0), or of the last line when there are fewer.
function nthLine(text: string, n: number): number {
  let s = 0;
  for (let i = 0; i < n && lineEnd(text, s) < text.length; i++) s = lineEnd(text, s) + 1;
  return s;
}

// f F t T: the `n`th `ch` along the line. Repeated with ; or , a t or T passes the character it
// stopped before, or it would not move (Vim, without ';' in 'cpoptions').
function find(t: Chars, k: number, op: Find, ch: string, n: number, again: boolean): Motion | undefined {
  const step = op === "f" || op === "t" ? 1 : -1;
  let i = k;
  if (again && (op === "t" || op === "T") && t.ch[k + step] === ch) i += step;
  for (let left = n; left > 0; ) {
    i += step;
    if (i < 0 || i >= t.ch.length || t.ch[i] === "\n") return undefined;
    if (t.ch[i] === ch) left--;
  }
  if (op === "t") i--;
  else if (op === "T") i++;
  return { to: t.at[i]!, kind: step > 0 ? "inclusive" : "exclusive" };
}

// `%`: the bracket matching the one under the cursor, or the next one on its line.
const PAIRS = "()[]{}";
function bracket(t: Chars, k: number): number | undefined {
  let i = k;
  while (i < t.ch.length && t.ch[i] !== "\n" && !PAIRS.includes(t.ch[i]!)) i++;
  const p = PAIRS.indexOf(t.ch[i] ?? "\n");
  if (p < 0) return undefined;
  const step = p % 2 ? -1 : 1;
  for (let j = i, depth = 0; j >= 0 && j < t.ch.length; j += step) {
    if (t.ch[j] === PAIRS[p]) depth++;
    else if (t.ch[j] === PAIRS[p ^ 1] && --depth === 0) return j;
  }
  return undefined;
}

// Vim's words: a run of letters, digits and underscores, or a run of other marks. A blank, a line
// break among them, is class 0, and an empty line counts as a word.
function cls(t: Chars, i: number): number {
  const c = t.ch[i];
  if (c === undefined) return -1; // past the end
  if (/^\s/u.test(c)) return 0;
  return /^[\p{L}\p{N}\p{M}_]/u.test(c) ? 2 : 1;
}
const emptyLine = (t: Chars, i: number) => (i === 0 || t.ch[i - 1] === "\n") && (i === t.ch.length || t.ch[i] === "\n");

// `w`: the next word's start, `n` times. Under an operator the last word stops at its line's end, so
// `dw` on a line's last word leaves the line break (Vim).
function wordForward(t: Chars, k: number, n: number, eol: boolean): number {
  const len = t.ch.length;
  for (let left = n; left > 0 && k < len; left--) {
    const stop = (i: number) => eol && left === 1 && (t.ch[i] === "\n" || t.ch[i - 1] === "\n");
    const s = cls(t, k++);
    if (stop(k)) return k;
    if (s !== 0) while (cls(t, k) === s) if (stop(++k)) return k;
    while (cls(t, k) === 0 && !emptyLine(t, k)) if (stop(++k)) return k;
  }
  return k;
}

// `e`: the word's end, or from a word's end the next word's, `n` times. `stop` (for `cw`) leaves the
// first at a word's last character. With only blanks after, it goes nowhere (Vim).
function wordEnd(t: Chars, k: number, n: number, stop: boolean): number {
  for (; n > 0 && k + 1 < t.ch.length; n--, stop = false) {
    const s = cls(t, k);
    let i = k + 1;
    if (s !== 0 && cls(t, i) === s) while (cls(t, i) === s) i++;
    else if (!stop || s === 0) {
      while (cls(t, i) === 0) i++;
      if (i === t.ch.length) return k;
      const c = cls(t, i);
      while (cls(t, i) === c) i++;
    }
    k = i - 1;
  }
  return k;
}

// `b`: the word's start, or from a word's start the one before's, `n` times.
function wordBack(t: Chars, k: number, n: number): number {
  for (; n > 0 && k > 0; n--) {
    k--;
    while (k > 0 && cls(t, k) === 0 && !emptyLine(t, k)) k--;
    const c = cls(t, k);
    if (c !== 0) while (k > 0 && cls(t, k - 1) === c) k--;
  }
  return k;
}

// The text as the characters the screen shows, and where each starts, the text's end last, so an
// emoji made of several code points is one character to every motion.
function chars(text: string) {
  const at = boundaries(text);
  return { ch: at.slice(0, -1).map((a, i) => text.slice(a, at[i + 1])), at };
}
type Chars = ReturnType<typeof chars>;
const isChar = (key: string) => chars(key).ch.length === 1;
function firstNonBlank(text: string, i: number): number {
  let j = lineStart(text, i);
  while (text[j] === " " || text[j] === "\t") j++;
  return j;
}
