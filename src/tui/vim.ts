// Vim mode as plain data (release 6 design, "Vim mode"): `press` takes the state, the editor and one
// key, and gives them back changed, so every row of Claude Code's vim tables is a test fed key by key.
// Where Claude Code's docs leave a key's exact behaviour open, this does what Claude Code 2.1.312's own
// code does where that was read (2026-10-28), and otherwise what Vim does. Every change is one undo
// step through editor.ts's `change`, and `u` is the editor's undo.
import { after, apply, before, boundaries, change, changes, type Editor, lineEnd, lineStart, move, type Span } from "./editor.js";

export type VimMode = "INSERT" | "NORMAL" | "VISUAL" | "VISUAL LINE";
type Find = "f" | "F" | "t" | "T";
// A yank or delete, with the spans of the pictures' markers wholly inside it, counted from its start, so a put
// copies them (release 6 plan, Task 20).
type Register = { text: string; linewise: boolean; spans: readonly Span[] };
// The last change, for `.`: its keys without their count, the count apart so one typed before `.` can take its
// place, what the INSERT it began typed, and for a VISUAL change how many characters or lines it covered and what
// its p put, as Claude Code 2.1.312's own code keeps them (read 2026-10-29).
export type Change = { keys: string[]; count: string; typed?: string; selected?: { line: boolean; size: number }; put?: Register };
export interface Vim {
  mode: VimMode;
  pending: string; // the command typed so far after its count: an operator, its own count, a `g`, `r`, f/F/t/T or i/a
  count: string; // the digits typed before it
  lastFind?: { op: Find; ch: string }; // for ; and ,
  lastChange?: Change;
  register: Register; // the last yank or delete, kept here and never on the clipboard
  anchor?: number; // where VISUAL's selection began; the cursor is its other end
  // The text before and after the cursor when a command went into INSERT, or at the first character typed in an
  // INSERT no command began (`plain`). At Esc, what lies between them is what was typed, for `.`, whatever App's own
  // keys did in between: Backspace, the arrows and pastes are App's (plan, Task 21).
  entered?: { head: string; tail: string; plain?: true };
  // A remap pair's first character, typed at `at` (ms), with the editor before it and the text and cursor it left.
  remap?: { ch: string; at: number; before: Editor; text: string; cursor: number };
  // The column, in characters, that j and k keep across a shorter line (Infinity after $, the line's
  // end), kept with the cursor and text it was set at and used only while both are unchanged, so a
  // change App makes forgets it (Claude Code 2.1.312's own code, read 2026-10-28).
  goal?: { column: number; cursor: number; text: string };
}

export const start: Vim = { mode: "INSERT", pending: "", count: "", register: { text: "", linewise: false, spans: [] } };

type Result = { v: Vim; e: Editor; act?: string };

// The settings file's vimInsertModeRemaps and the time a key came, in ms, which App passes in.
export type Remaps = { pairs: Readonly<Record<string, "<Esc>">>; now: number };

// One key: a character, or a named key ("escape", "enter", "left", ...). The act is for App to do:
// "submit", "history:previous", "history:next", "history:search" or "help".
// Not every key is vim's. In INSERT only a typed character and Esc are; any other key comes back with
// the editor unchanged but `remap` dropped, as a pair's wait ends at any key, so App keeps the returned
// `v` and edits with `commands()` as without vim mode. A key App handles without `press` must drop
// `v.remap` too, as Claude Code clears it on every key (its `cancelPendingRemap`). When App puts new text
// in the prompt (a message sent, a history recall), it drops `v.entered`, so `.` takes what is typed next
// from its first character. In NORMAL a lone Esc, with nothing half typed, is App's own Esc, so App
// checks `v.pending || v.count` before giving NORMAL's Esc to vim.
// VISUAL's cursor is not put on a character first: there `$` selects the line break too, as in Vim.
export function press(v: Vim, e: Editor, key: string, remaps?: Remaps): Result {
  if (v.mode === "INSERT") return insert(v, e, key, remaps);
  return v.mode === "NORMAL" ? normal(v, onChar(e), key) : visual(v, e, key);
}

// Claude Code's docs, "Remap INSERT-mode key sequences": the second character "within one second". Its own code counts
// 1000 ms itself as within (2.1.312, read 2026-10-29).
const REMAP_MS = 1000;

// A character typed in INSERT goes in through editor.ts, as typing. A remap pair's first character goes in at once; the
// second within REMAP_MS, with nothing changed between, takes the first out, as if never typed, and goes to NORMAL. Any
// other key ends the wait, App's included, and so does App changing the text or cursor between.
function insert(v: Vim, e: Editor, key: string, remaps?: Remaps): Result {
  const { remap, ...rest } = v;
  if (!isChar(key)) return key === "escape" ? toNormal(rest, e) : { v: rest, e };
  if (remap && remaps?.pairs[remap.ch + key] === "<Esc>" && remaps.now - remap.at <= REMAP_MS && e.text === remap.text && e.cursor === remap.cursor) {
    return toNormal(rest, remap.before, true);
  }
  const typing = rest.entered ? rest : { ...rest, entered: { head: e.text.slice(0, e.cursor), tail: e.text.slice(e.cursor), plain: true as const } };
  const d = apply(e, { type: "insert", text: key });
  if (!remaps || !Object.keys(remaps.pairs).some((p) => p.startsWith(key))) return { v: typing, e: d };
  return { v: { ...typing, remap: { ch: key, at: remaps.now, before: e, text: d.text, cursor: d.cursor } }, e: d };
}

// Esc, or a remap (`remapped`): NORMAL, the cursor back onto the character before, as in Vim. What lies between the
// text before and after where INSERT began is what was typed: it joins the change of the command that went into
// INSERT, for `.`; when either piece is gone, the INSERT reached past where it began, and `.` has nothing to repeat
// rather than a part of it. An INSERT no command began is an insert of its own, as Claude Code 2.1.312's own code
// records it (read 2026-10-29): when something was typed, or when a remap ended it, even with nothing typed, unless
// the change before was a command that went into INSERT.
function toNormal(v: Vim, e: Editor, remapped = false): Result {
  const { entered, ...rest } = v;
  let { lastChange } = rest;
  if (entered) {
    const { head, tail, plain } = entered;
    const kept = e.text.length >= head.length + tail.length && e.text.startsWith(head) && e.text.endsWith(tail);
    const typed = e.text.slice(head.length, e.text.length - tail.length);
    const intoInsert = !!lastChange?.keys.length && lastChange.typed !== undefined;
    if (!kept) lastChange = undefined;
    else if (!plain) lastChange = lastChange && { ...lastChange, typed };
    else if (typed || (remapped && !intoInsert)) lastChange = { keys: [], count: "", typed };
  }
  const c = e.cursor;
  return { v: { ...rest, mode: "NORMAL", lastChange }, e: onChar(move(e, c === lineStart(e.text, c) ? c : before(e.text, c))) };
}

const MOTIONS = new Set(["h", "j", "k", "l", " ", "backspace", "left", "right", "up", "down", "w", "e", "b", "0", "$", "^", "G", ";", ",", "%"]);
// Keys that are an operator and a motion, as Vim defines them.
const SHORT = new Map([["x", "dl"], ["s", "cl"], ["D", "d$"], ["C", "c$"], ["S", "cc"], ["Y", "yy"]]);

// The keys of the command, for `.`, are kept without its counts: `count` holds them, multiplied.
function normal(v: Vim, e: Editor, key: string, keys = [...v.pending.replace(/\d/gu, ""), key]): Result {
  const [, op = "", opCount = "", prefix = ""] = /^([dcy<>]?)(\d*)([gfFtTria]?)$/u.exec(v.pending)!;
  const { goal, ...rest } = v; // a finished command forgets the column j and k keep, unless it is j, k or $
  const done: Vim = { ...rest, pending: "", count: "" };
  const n = Number(v.count || 1) * Number(opCount || 1); // `2d3w` is six words, as in Vim
  const counted = v.count + opCount !== "";
  const last: Change = { keys, count: counted ? String(n) : "" };
  const go = (name: string, lastFind = v.lastFind): Result => {
    const next = { ...done, lastFind };
    const kept = goal?.cursor === e.cursor && goal.text === e.text ? goal.column : undefined;
    const m = motion(e, name, n, counted, op, lastFind, kept);
    const browse = !m && !op && v.mode === "NORMAL"; // VISUAL's j and k stop at the first and last line
    if (browse && (name === "j" || name === "down")) return { v: next, e, act: "history:next" };
    if (browse && (name === "k" || name === "up")) return { v: next, e, act: "history:previous" };
    if (!m) return { v: next, e };
    if (op) return operate(next, e, op, m, last);
    const to = v.mode === "NORMAL" ? onChar(move(e, m.to)) : move(e, m.to);
    return { v: m.goal === undefined ? next : { ...next, goal: { column: m.goal, cursor: to.cursor, text: to.text } }, e: to };
  };
  if (prefix === "r") return isChar(key) ? replaceChars(done, e, key, n, last) : { v: done, e };
  if (prefix === "g") return key === "g" ? go("gg") : { v: done, e };
  if (prefix === "i" || prefix === "a") {
    const o = textObject(e.text, e.cursor, prefix, key);
    return o ? operate(done, move(e, o[0]), op, { to: o[1], kind: "object" }, last) : { v: done, e };
  }
  if (prefix) return isChar(key) ? go("find", { op: prefix as Find, ch: key }) : { v: done, e };
  // A digit adds to the count, after an operator to its own; 0 with no digits before it is the line's start. Each
  // count is 10,000 at most, as Claude Code 2.1.312's own code caps it as it is typed (`Math.min(t*10+digit, 1e4)`).
  if (/^\d$/u.test(key) && op && (key !== "0" || opCount)) return { v: { ...v, pending: op + upTo(opCount + key) }, e };
  if (/^\d$/u.test(key) && !op && (key !== "0" || v.count)) return { v: { ...v, count: upTo(v.count + key) }, e };
  // A text object follows d, c or y; Claude Code's > and < take only themselves again (2.1.312's own code).
  const object = /^[dcy]$/u.test(op) && /^[ia]$/u.test(key);
  if (object || /^[gfFtT]$/u.test(key) || (!op && /^[dcy<>r]$/u.test(key))) return { v: { ...v, pending: v.pending + key }, e };
  if (op && key === op) return go("line"); // dd cc yy >> <<
  const short = op ? undefined : SHORT.get(key);
  if (short) return normal({ ...v, pending: short[0]! }, e, short.slice(1), keys);
  if (MOTIONS.has(key)) return go(key);
  if (op) return { v: done, e }; // an operator then a key that is no motion drops both
  // VISUAL keeps the column j and k keep, as Claude Code's does; a count before v or V is dropped, as there.
  if (key === "v" || key === "V") return { v: { ...v, pending: "", count: "", mode: VISUALS[key], anchor: e.cursor }, e };
  if (key === ".") return repeat(done, e, v.count);
  return command(done, e, key, n, last);
}

const VISUALS = { v: "VISUAL", V: "VISUAL LINE" } as const;

// Claude Code 2.1.312's own cap on a count (its `mt=1e4`, read 2026-10-29).
const MAX_COUNT = 10000;
const upTo = (digits: string) => String(Math.min(Number(digits), MAX_COUNT));

function command(v: Vim, e: Editor, key: string, n: number, last: Change): Result {
  const { text, cursor: c } = e;
  switch (key) {
    case "i":
      return toInsert(v, e, last);
    case "a":
      return toInsert(v, move(e, Math.min(after(text, c), lineEnd(text, c))), last);
    case "I":
      return toInsert(v, move(e, firstNonBlank(text, c)), last);
    case "A":
      return toInsert(v, move(e, lineEnd(text, c)), last);
    case "o": {
      const at = lineEnd(text, c);
      return toInsert(v, change(e, at, at, "\n", { typing: true }), last);
    }
    case "O": {
      // The cursor before the new line break, the step still open for the typing to join.
      const at = lineStart(text, c);
      return toInsert(v, { ...change(e, at, at, "\n", { typing: true }), cursor: at }, last);
    }
    case "p":
    case "P":
      return put(v, e, key === "p", n, last);
    case "J":
      return join(v, e, n, last);
    case "u": {
      // The editor's undo, `n` steps or as many as there are; each puts back the text and the cursor
      // from before its step.
      let u = e;
      for (let i = 0; i < n && u.undo.length > 0; i++) u = apply(u, "undo");
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
function toInsert(v: Vim, e: Editor, last: Change): Result {
  const entered = { head: e.text.slice(0, e.cursor), tail: e.text.slice(e.cursor) };
  return { v: { ...v, mode: "INSERT", lastChange: last, entered }, e };
}

// In NORMAL the cursor is on a character, so never on a line's end unless the line is empty (Vim); App's
// `load` leaves it at the text's end. Through `move`, which also ends any run of typing.
function onChar(e: Editor): Editor {
  const { text, cursor: c } = e;
  return move(e, (c === text.length || text[c] === "\n") && c !== lineStart(text, c) ? before(text, c) : c);
}

// "object" is a text object's start (the cursor) to its end, taken as they are.
type Motion = { to: number; kind: "exclusive" | "inclusive" | "line" | "object"; goal?: number };

// An operator over the text from the cursor to where the motion goes, by Vim's rules: an inclusive
// motion takes the character it lands on, and an exclusive one ending at a line's start ends at the
// line before's end instead, taking whole lines when it began in its line's indent. `times` is how often
// VISUAL's > and < shift (Claude Code 2.1.312's own code, read 2026-10-29).
function operate(v: Vim, e: Editor, op: string, m: Motion, last: Change, times = 1): Result {
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
  // A yank reaching into a picture's marker takes all of it and its span, as a delete does (editor.ts, change).
  const [rf, rt] = cover(e.spans, from, to);
  const register = to > from || line ? { text: text.slice(rf, rt), linewise: line, spans: within(e.spans, rf, rt) } : v.register;
  if (op === "y") return { v: { ...v, register }, e: onChar(move(e, Math.min(c, m.to))) }; // the cursor to the yank's start
  if (op === "c") return toInsert({ ...v, register }, change(e, from, to, "", { typing: true }), last);
  const changed = { ...v, register: op === "d" ? register : v.register, lastChange: last };
  if (op === ">" || op === "<") {
    // Each line's own change at its start, as one step (editor.ts, changes); nothing to take off: no undo step. A count
    // too big for the text to hold shifts nothing, as `put` refuses one.
    const edits: [number, number, string][] = [];
    try {
      for (let s = from; s <= to; s = lineEnd(text, s) + 1) {
        const [cut, add] = shift(text.slice(s, lineEnd(text, s)), op, times);
        if (cut || add) edits.push([s, s + cut, add]);
      }
    } catch (err) {
      if (err instanceof RangeError) return { v, e };
      throw err;
    }
    const d = changes(e, edits);
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
// leading blanks, a blank being what `\s` matches, as Claude Code's `/\s/.test(i[u])` has it. An empty
// line is left alone. What to take off the line's start, and what to put there, shifting `times` times.
function shift(line: string, op: string, times: number): [number, string] {
  if (!line) return [0, ""];
  if (op === ">") return [0, "  ".repeat(times)];
  let cut = 0;
  for (let i = 0; i < times; i++) {
    const rest = line.slice(cut);
    const step = rest.startsWith("  ") ? 2 : rest.startsWith("\t") ? 1 : /^\s{0,2}/u.exec(rest)![0].length;
    if (!step) break;
    cut += step;
  }
  return [cut, ""];
}

// `r`: `n` characters from the cursor, each made `ch`, or nothing when the line has fewer (Vim).
function replaceChars(v: Vim, e: Editor, ch: string, n: number, last: Change): Result {
  const t = chars(e.text);
  const k = t.at.indexOf(e.cursor);
  if (k + n > t.ch.length || t.ch.slice(k, k + n).includes("\n")) return { v, e };
  // The cursor on the last character put: from where the change ended, as a change reaching into a picture's marker
  // takes the whole marker (editor.ts, change).
  const d = change(e, t.at[k]!, t.at[k + n]!, ch.repeat(n));
  return { v: { ...v, lastChange: last }, e: move(d, d.cursor - ch.length) };
}

// `p` and `P`: the register `n` times, after or before the cursor, or below or above its line for a
// yanked line. The cursor goes where Vim puts it: a line's first non-blank, or the last character put
// unless that was more than one line. A count too big for the text to hold puts nothing, as Vim
// refuses it (E1240). Each copy has the register's pictures' spans, and the cursor on a marker puts after
// or before all of it, so the marker stays whole.
function put(v: Vim, e: Editor, below: boolean, n: number, last: Change): Result {
  const { text: reg, linewise, spans } = v.register;
  if (!reg && !linewise) return { v, e };
  const { text, cursor: c } = e;
  const done = { ...v, lastChange: last };
  let block: string;
  try {
    block = linewise ? `${reg}\n`.repeat(n) : reg.repeat(n);
  } catch (err) {
    if (err instanceof RangeError) return { v, e };
    throw err;
  }
  if (linewise) {
    const at = below ? lineEnd(text, c) : lineStart(text, c);
    const d = withCopies(change(e, at, at, below ? `\n${block.slice(0, -1)}` : block), spans, below ? at + 1 : at, reg.length + 1, n);
    return { v: done, e: onChar(move(d, firstNonBlank(d.text, below ? at + 1 : at))) };
  }
  let at = below ? Math.min(after(text, c), lineEnd(text, c)) : c;
  const inside = e.spans.find((s) => s.from < at && at < s.to);
  if (inside) at = below ? inside.to : inside.from;
  const d = withCopies(change(e, at, at, block), spans, at, reg.length, n);
  return { v: done, e: onChar(move(d, block.includes("\n") ? at : before(d.text, at + block.length))) };
}

// The register's spans in `n` copies put in, the first from `at` and each `step` after the one before (release 6
// plan, Task 20: yank and put copy pictures' spans).
function withCopies(d: Editor, spans: readonly Span[], at: number, step: number, n: number): Editor {
  if (!spans.length) return d;
  const copies = Array.from({ length: n }, (_, i) => spans.map((s) => ({ ...s, from: s.from + at + i * step, to: s.to + at + i * step })));
  return { ...d, spans: [...d.spans, ...copies.flat()].sort((a, b) => a.from - b.from) };
}

// The range widened to the whole of any picture's marker it reaches into, as editor.ts's `change` widens a delete.
function cover(spans: readonly Span[], from: number, to: number): [number, number] {
  for (const s of spans) if (from < to && s.from < to && s.to > from) [from, to] = [Math.min(from, s.from), Math.max(to, s.to)];
  return [from, to];
}

// The spans wholly from `from` to `to`, counted from `from`, for the register.
function within(spans: readonly Span[], from: number, to: number): Span[] {
  return spans.filter((s) => s.from >= from && s.to <= to).map((s) => ({ ...s, from: s.from - from, to: s.to - from }));
}

// `J`: `n` lines (two at least) made one, as Claude Code 2.1.312's own code does it (read 2026-10-28).
// Each joined line loses its indent and gets one space before it, but none when it is empty or starts
// with ")", or the text before is empty or ends in a blank. The cursor goes to the last join.
function join(v: Vim, e: Editor, n: number, last: Change): Result {
  const { text, cursor: c } = e;
  const from = lineStart(text, c);
  let to = lineEnd(text, c);
  if (to === text.length) return { v, e };
  let joined = text.slice(from, to);
  let at = 0;
  // Each join's line break and indent replaced on its own, as one step (editor.ts, changes).
  const edits: [number, number, string][] = [];
  for (let i = 1; i < Math.max(n, 2) && to < text.length; i++) {
    const end = lineEnd(text, to + 1);
    const indent = /^[ \t]*/u.exec(text.slice(to + 1, end))![0].length;
    const next = text.slice(to + 1 + indent, end);
    at = joined.length;
    const space = next && !next.startsWith(")") && joined && !/[ \t]$/u.test(joined) ? " " : "";
    edits.push([to, to + 1 + indent, space]);
    joined += space + next;
    to = end;
  }
  const d = changes(e, edits);
  return { v: { ...v, lastChange: last }, e: onChar(move(d, from + at)) };
}

// VISUAL and VISUAL LINE (Claude Code's "Visual mode" table): motions move the cursor, the anchor stays,
// and the selection is all from one to the other, whole lines in VISUAL LINE. Counts, f F t T, g and the
// motions are NORMAL's. As Claude Code 2.1.312's own code has it (read 2026-10-29): Enter moves down a line,
// a text object is found from the cursor alone, and any other key does nothing.
function visual(v: Vim, e: Editor, key: string): Result {
  const done: Vim = { ...v, pending: "", count: "" };
  const { text, cursor: c } = e;
  if (v.pending === "i" || v.pending === "a") {
    const o = textObject(text, c, v.pending, key);
    return o ? { v: { ...done, anchor: o[0] }, e: move(e, o[1] > o[0] ? before(text, o[1]) : o[0]) } : { v: done, e };
  }
  const replacing = v.pending === "r"; // the next key is the character, even a digit or a motion's
  if (replacing && !isChar(key)) return { v: done, e };
  if (!replacing && (v.pending || /^\d$/u.test(key) || /^[gfFtT]$/u.test(key) || MOTIONS.has(key))) return normal(v, e, key);
  if (key === "enter") return normal(v, e, "j");
  if (key === "escape") return v.count ? { v: done, e } : leave(done, e);
  if (!v.pending && /^[ria]$/u.test(key)) return { v: { ...v, pending: key }, e };
  const a = v.anchor ?? c;
  const line = v.mode === "VISUAL LINE";
  const from = line ? lineStart(text, Math.min(a, c)) : Math.min(a, c);
  const end = Math.max(a, c); // where the last character selected starts
  const to = line ? lineEnd(text, end) : after(text, end);
  const out = leave(done, e).v;
  const lines = text.slice(from, end).split("\n").length;
  // For `.`: as many characters, or lines, from the cursor (Claude Code 2.1.312's own code).
  const size = line ? lines : chars(text.slice(from, to)).ch.length;
  const last: Change = { keys: replacing ? ["r", key] : [key], count: v.count, selected: { line, size } };
  const sel: Motion = { to: end, kind: line ? "line" : "inclusive" };
  if (replacing) return remake({ ...out, lastChange: last }, e, from, to, () => key, key);
  switch (key) {
    case "d":
    case "x":
      return operate(out, move(e, from), "d", sel, last);
    case "c":
    case "s":
      return operate(out, move(e, from), "c", sel, last);
    case "y":
      return operate(out, move(e, from), "y", sel, last);
    case ">":
    case "<":
      return operate(out, move(e, from), key, sel, last, Number(v.count || 1));
    case "~":
    case "u":
    case "U":
      return remake({ ...out, lastChange: last }, e, from, to, CASES[key]);
    case "p":
      return v.register.text || v.register.linewise ? putOver(out, e, from, to, line, last) : { v: done, e };
    case "J":
      return join(out, onChar(move(e, from)), Math.max(2, lines), last);
    case "o":
      return { v: { ...done, anchor: c }, e: move(e, a) };
    case "v":
    case "V":
      return VISUALS[key] === v.mode ? leave(done, e) : { v: { ...done, mode: VISUALS[key] }, e };
  }
  return { v: done, e };
}

// Out of VISUAL to NORMAL, the cursor onto a character.
function leave(v: Vim, e: Editor): Result {
  const { anchor, ...rest } = v;
  return { v: { ...rest, mode: "NORMAL" }, e: onChar(e) };
}

const CASES = {
  "~": (ch: string) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()),
  u: (ch: string) => ch.toLowerCase(),
  U: (ch: string) => ch.toUpperCase(),
};

// VISUAL's r, ~, u and U: each character from `from` to `to` made anew by `f`, line breaks kept, a run at a time
// between pictures' markers, as one step. A marker is one character (release 6 plan, choice 14) with no case: r
// makes it one `marker`, and ~ u U leave it and its span. The cursor goes to the selection's start, or to the start
// of a marker the selection began inside, as Claude Code 2.1.312's own code snaps it out of one.
function remake(v: Vim, e: Editor, from: number, to: number, f: (ch: string) => string, marker?: string): Result {
  const edits: [number, number, string][] = [];
  let at = from;
  const run = (end: number) => {
    const old = e.text.slice(at, end);
    const made = chars(old).ch.map((ch) => (ch === "\n" ? ch : f(ch))).join("");
    if (made !== old) edits.push([at, end, made]);
  };
  for (const s of e.spans) {
    if (s.to <= from || s.from >= to) continue;
    if (s.from > at) run(s.from);
    if (marker !== undefined) edits.push([s.from, s.to, marker]);
    at = Math.max(at, s.to);
  }
  if (to > at) run(to);
  return { v, e: onChar(move(changes(e, edits), cover(e.spans, from, to)[0])) };
}

// VISUAL's p, as Claude Code 2.1.312's own Wt() does it (read 2026-10-29): the selection replaced by the register's
// text, less a line break at its end, and with one after it when the selection ended with one and the text does
// not; the register then holds what was replaced. Claude Code's register holds yanked lines with a line break after
// them, which it takes off; this one never holds that break, so yanked lines keep every break they have. The cursor
// goes to the first line's first non-blank in VISUAL LINE, else to the last character put, or to its start when
// what was put ends with a line break, and onto a character.
function putOver(v: Vim, e: Editor, from: number, to: number, line: boolean, last: Change): Result {
  const reg = v.register;
  [from, to] = cover(e.spans, from, to);
  const old = e.text.slice(from, to);
  const body = !reg.linewise && reg.text.endsWith("\n") ? reg.text.slice(0, -1) : reg.text;
  const put = old.endsWith("\n") && !body.endsWith("\n") ? `${body}\n` : body;
  const d = withCopies(change(e, from, to, put), reg.spans, from, 0, 1);
  const at = line ? firstNonBlank(d.text, from) : put.endsWith("\n") ? from : Math.max(from, before(d.text, from + put.length));
  const register = { text: old, linewise: line, spans: within(e.spans, from, to) };
  return { v: { ...v, register, lastChange: { ...last, put: reg } }, e: onChar(move(d, at)) };
}

// `.`: the last change again from the cursor, with what its INSERT typed, as Claude Code 2.1.312's own code repeats
// it (read 2026-10-29). A count typed before `.` stands in for the change's own for this `.` alone, and only where
// `recounts` says. A VISUAL change is made over as many characters or lines from the cursor, and its p puts what it
// put then. An insert no command began puts its text at the cursor, as `i` would, and an empty one does nothing.
function repeat(v: Vim, e: Editor, count: string): Result {
  const last = v.lastChange;
  if (!last) return { v, e };
  const keys = last.keys.length ? last.keys : last.typed ? ["i"] : [];
  const n = count && recounts(last) ? count : last.count;
  let r: Result = { v: last.put ? { ...v, register: last.put } : v, e };
  if (last.selected) r = reselect(r.v, e, last.selected);
  for (const k of [...n, ...keys]) r = press(r.v, r.e, k);
  if (r.v.mode === "INSERT") r = press(r.v, apply(r.e, { type: "insert", text: last.typed ?? "" }), "escape");
  return { v: { ...r.v, lastChange: last }, e: r.e };
}

// The changes a count before `.` applies to, as Claude Code 2.1.312's own code has them (read 2026-10-29): x, s, p,
// P, D, C and S, and d or c over a text object or a motion other than h, l, Space, Backspace, % and a find. Not >>,
// <<, J, r, a command into INSERT or a VISUAL change.
const KEEPS_COUNT = new Set(["h", "l", " ", "backspace", "left", "right", "%", "f", "F", "t", "T", ";", ","]);
function recounts({ keys: [key = "", next = ""], selected }: Change): boolean {
  if (selected) return false;
  return key === "d" || key === "c" ? !KEEPS_COUNT.has(next) : ["x", "s", "p", "P", "D", "C", "S"].includes(key);
}

// VISUAL from the cursor over `size` characters, or lines, for `.`.
function reselect(v: Vim, e: Editor, { line, size }: { line: boolean; size: number }): Result {
  const { text, cursor: c } = e;
  const t = chars(text);
  const k = t.at.indexOf(c);
  const to = line ? (vertical(text, c, size - 1)?.to ?? c) : t.at[Math.max(k, Math.min(k + size, t.ch.length) - 1)]!;
  return { v: { ...v, mode: line ? "VISUAL LINE" : "VISUAL", anchor: c }, e: move(e, to) };
}

// Text objects (Claude Code's "Text objects" table), found as Claude Code 2.1.312's own code finds them (read
// 2026-10-29): where the object around `c` starts and ends, or nothing. A count does not change them, as there.
function textObject(text: string, c: number, scope: string, kind: string): [number, number] | undefined {
  const inner = scope === "i";
  if (kind === "w" || kind === "W") return word(text, c, inner, kind === "W");
  if (kind === '"' || kind === "'") return quoted(text, c, kind, inner);
  const close = BRACKETS.get(kind);
  return close ? bracketed(text, c, kind, close, inner) : undefined;
}
const BRACKETS = new Map([["(", ")"], ["[", "]"], ["{", "}"]]);

// `iw` and `aw`: the run of word characters, other marks or blanks the cursor is on (for `iW` and `aW`, of
// non-blanks or blanks). `aw` adds the blanks after, or when there are none those before; on blanks both take
// the blanks alone.
function word(text: string, c: number, inner: boolean, big: boolean): [number, number] | undefined {
  const t = chars(text);
  const len = t.ch.length;
  if (!len) return undefined;
  const kind = (i: number) => (big ? Math.min(cls(t, i), 1) : cls(t, i));
  const k = Math.min(t.at.indexOf(c), len - 1);
  const own = kind(k);
  let [s, f] = [k, k + 1];
  while (s > 0 && kind(s - 1) === own) s--;
  while (f < len && kind(f) === own) f++;
  if (own !== 0 && !inner) {
    if (kind(f) === 0) while (kind(f) === 0) f++;
    else while (s > 0 && kind(s - 1) === 0) s--;
  }
  return [t.at[s]!, t.at[f]!];
}

// `i"` and `a"`, `i'` and `a'`: the quotes on the cursor's line paired in order, the first with the second, the
// third with the fourth, and the pair the cursor is on or between; `a` takes the quotes too, and no blanks.
function quoted(text: string, c: number, q: string, inner: boolean): [number, number] | undefined {
  const at: number[] = [];
  for (let i = lineStart(text, c), end = lineEnd(text, c); i < end; i++) if (text[i] === q) at.push(i);
  for (let i = 0; i + 1 < at.length; i += 2) {
    const [open, close] = [at[i]!, at[i + 1]!];
    if (open <= c && c <= close) return inner ? [open + 1, close] : [open, close + 1];
  }
  return undefined;
}

// `i(` `a(`, `i[` `a[`, `i{` `a{`: the nearest `open` at or before the cursor that is not closed before it,
// and the `close` matching it, over lines; `a` takes the brackets too.
function bracketed(text: string, c: number, open: string, close: string, inner: boolean): [number, number] | undefined {
  let s = c;
  for (let depth = 0; s >= 0; s--) {
    if (text[s] === close && s !== c) depth++;
    else if (text[s] === open && depth-- === 0) break;
  }
  if (s < 0) return undefined;
  let f = s + 1;
  for (let depth = 0; f < text.length; f++) {
    if (text[f] === open) depth++;
    else if (text[f] === close && depth-- === 0) break;
  }
  return f < text.length ? (inner ? [s + 1, f] : [s, f + 1]) : undefined;
}

// Where a motion goes from `c`, `n` times, or nothing when it cannot go (Vim beeps then and the whole
// command is dropped). `counted` is whether a count was typed, for gg and G, which take it as a line.
// `lastFind` is for ; and , and `goal` the column j and k keep.
function motion(e: Editor, key: string, n: number, counted: boolean, op: string, lastFind?: Vim["lastFind"], goal?: number): Motion | undefined {
  const { text, cursor: c } = e;
  const t = chars(text);
  const k = t.at.indexOf(c);
  const exclusive = (i: number): Motion => ({ to: t.at[i]!, kind: "exclusive" });
  switch (key) {
    case "h":
    case "left":
      return exclusive(Math.max(t.at.indexOf(lineStart(text, c)), k - n));
    case "l":
    case "right":
      return exclusive(Math.min(t.at.indexOf(lineEnd(text, c)), k + n));
    case " ":
      return exclusive(across(t, k, n, 1));
    case "backspace":
      return exclusive(across(t, k, n, -1));
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
      return exclusive(wordForward(t, k, n, op !== ""));
    case "e":
      return { to: t.at[wordEnd(t, k, n, false)]!, kind: "inclusive" };
    case "b":
      return exclusive(wordBack(t, k, n));
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
  if (!lastFind) return undefined;
  const { op: f, ch } = lastFind;
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
    const was = s;
    if (n < 0) s = s === 0 ? 0 : lineStart(text, s - 1);
    else if (lineEnd(text, s) < text.length) s = lineEnd(text, s) + 1;
    if (s === was) break; // the first or last line: a bigger count goes no further
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

// `,` repeats a find the other way.
const REVERSE = { f: "F", F: "f", t: "T", T: "t" } as const;

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
