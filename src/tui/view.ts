// The conversation in full screen (release 5 design, "The screen", "Scrolling"): every line is kept, wrapped to the
// screen's width, and only the rows on screen are drawn; the view is either following the bottom or held at a place in
// the lines, so a resize or new output does not move what the user is reading. All pure, so it is tested alone.
import stringWidth from "string-width";
import type { Line } from "./describe.js";
import { segmenter } from "./editor.js";

export interface Pos {
  line: number;
  offset: number; // before text[offset]
}
export interface Row {
  line: number;
  start: number;
  end: number;
  text: string;
  color?: string;
}
type Wrapped = { start: number; end: number; text: string };
type Kept = { text: string; color?: string; oneLine?: boolean };

// A tab is drawn as spaces to the next stop. Ink would draw a tab handed to it wrongly: its output puts "\t" in one cell
// (output.js) and string-width counts it as 0 columns, so the terminal's own jump to the next stop would push the rest
// of the row past its end. So the row's text carries spaces, and Ink draws exactly what was measured. Stops every 8
// columns, as wrap-ansi's TAB_SIZE (Ink's wrapping in classic mode) and terminals' default. They count from the row's
// start, so each row stands on its own; classic counts from the line's start, which differs only on a wrapped line's
// later rows.
const TAB = 8;

// One line's rows at `width` columns (release 5 plan, choice 1), broken as Ink's own wrapping breaks them in classic
// mode (wrap-ansi with hard: true, trim: false, in Ink's wrap-text.js): a word that does not fit goes to the next row,
// so a row breaks after the last space that fits, and a space that does not fit starts the next row. A word longer
// than a row starts on the row it is on, unless starting it on the next row takes fewer rows, and is cut at each row's
// end. A character is never split (graphemes, with string-width's columns). `start` and `end` index the line's text
// and cover it without gaps; `text` is what is drawn. One-line entries (choice 2) are one row, cut with "…" as Ink's
// truncate-end cuts them in classic mode, and end at the text's end, so selecting to the row's end takes the whole entry.
export function wrap(text: string, width: number, oneLine: boolean): Wrapped[] {
  if (oneLine) return [{ start: 0, end: text.length, text: cut(text, width) }];
  const parts = [...segmenter.segment(text)].map(({ segment, index }) => ({ s: segment, i: index, w: stringWidth(segment) }));
  const rows: Wrapped[] = [];
  let start = 0;
  let shown = "";
  let col = 0;
  const breakAt = (i: number) => {
    rows.push({ start, end: i, text: shown });
    start = i;
    shown = "";
    col = 0;
  };
  const space = (s: string) => s === " " || s === "\t";
  for (let k = 0; k < parts.length; ) {
    const p = parts[k]!;
    if (space(p.s)) {
      if (col > 0 && col >= width) breakAt(p.i);
      const w = p.s === " " ? 1 : Math.min(TAB - (col % TAB), width - col);
      shown += " ".repeat(w);
      col += w;
      k++;
      continue;
    }
    let m = k;
    let word = 0;
    for (; m < parts.length && !space(parts[m]!.s); m++) word += parts[m]!.w;
    if (word > width) {
      // wrap-ansi's own test: the rows the word starts here, against the rows it starts on the next row.
      if (col > 0 && Math.floor((word - 1) / width) < 1 + Math.floor((word - (width - col) - 1) / width)) breakAt(p.i);
      for (const g of parts.slice(k, m)) {
        if (g.w > 0 && col > 0 && col + g.w > width) breakAt(g.i);
        shown += g.s;
        col += g.w;
      }
    } else {
      if (col > 0 && col + word > width) breakAt(p.i);
      for (const g of parts.slice(k, m)) shown += g.s;
      col += word;
    }
    k = m;
  }
  rows.push({ start, end: text.length, text: shown });
  return rows;
}

// `text` cut to `width` columns with "…" in the last, as cli-truncate (Ink's truncate-end) cuts it: a wide character
// that would cross into that column is left out.
function cut(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  let shown = "";
  let col = 0;
  for (const { segment } of segmenter.segment(text)) {
    const w = stringWidth(segment);
    if (col + w > width - 1) break; // 1: the column "…" takes
    shown += segment;
    col += w;
  }
  return `${shown}…`;
}

// All the lines and their rows at the current width. Each line's rows are kept, with the count of rows before it, so
// finding a row is a binary search over the lines however long the session runs (release 5 design, "The screen").
export class Rows {
  #width: number;
  #lines: Kept[] = [];
  #rows: Wrapped[][] = [];
  #before: number[] = [];
  #total = 0;

  constructor(width: number) {
    this.#width = width;
  }

  // Each Line split at its line breaks into lines of its own, the same colour, so a place is a line and an offset.
  add(lines: Line[]): void {
    for (const l of lines) {
      for (const text of l.text.split("\n")) {
        const kept: Kept = { text, ...(l.color === undefined ? {} : { color: l.color }), ...(l.oneLine ? { oneLine: true } : {}) };
        this.#lines.push(kept);
        this.#keep(kept);
      }
    }
  }

  #keep(l: Kept): void {
    const rows = wrap(l.text, this.#width, l.oneLine ?? false);
    this.#before.push(this.#total);
    this.#rows.push(rows);
    this.#total += rows.length;
  }

  get lines(): readonly Kept[] {
    return this.#lines;
  }

  get width(): number {
    return this.#width;
  }

  // A resize wraps every line again (release 5 design, "The screen").
  setWidth(width: number): void {
    this.#width = width;
    this.#rows = [];
    this.#before = [];
    this.#total = 0;
    for (const l of this.#lines) this.#keep(l);
  }

  get total(): number {
    return this.#total;
  }

  row(i: number): Row {
    let lo = 0;
    let hi = this.#before.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1; // >> 1: halves, rounding down
      if (this.#before[mid]! <= i) lo = mid;
      else hi = mid - 1;
    }
    const color = this.#lines[lo]!.color;
    return { line: lo, ...this.#rows[lo]![i - this.#before[lo]!]!, ...(color === undefined ? {} : { color }) };
  }

  // Rows are half-open, start <= offset < end, and the line's own end is on its last row: where one row ends the next
  // starts, so a view held at a line's second row stays on that row (release 5 plan, from its review).
  rowOf(p: Pos): number {
    return this.#before[p.line]! + this.#rows[p.line]!.findLastIndex((r) => r.start <= p.offset);
  }
}

// Where the view is: the place at the start of its first row, or null while it follows the bottom; and how many lines
// came in while it did not (release 5 design, "Scrolling", "Following").
export interface View {
  at: Pos | null;
  unseen: number;
}
export const FOLLOWING: View = Object.freeze({ at: null, unseen: 0 });

const bottom = (rows: Rows, height: number) => Math.max(0, rows.total - height);

// The first row shown. A held view whose place is lower than the last screenful (the conversation got taller) shows the
// last screenful, so the screen stays full.
export function first(rows: Rows, v: View, height: number): number {
  return v.at === null ? bottom(rows, height) : Math.min(rows.rowOf(v.at), bottom(rows, height));
}

// Reaching the bottom, or past it, follows again with nothing unseen; above the top is the top.
export function scrollTo(rows: Rows, v: View, height: number, row: number): View {
  const to = Math.max(0, row);
  if (to >= bottom(rows, height)) return FOLLOWING;
  const r = rows.row(to);
  return { at: { line: r.line, offset: r.start }, unseen: v.unseen };
}

export function scrollBy(rows: Rows, v: View, height: number, n: number): View {
  return scrollTo(rows, v, height, first(rows, v, height) + n);
}

export function arrived(v: View, lines: number): View {
  return v.at === null ? v : { ...v, unseen: v.unseen + lines };
}

// The wheel (release 5 design, "Scrolling"): rows to move for one notch at `speed`, up negative, with the fraction
// carried to the next notch, so 0.5 moves a row every second notch. The carry is signed by its direction, and dropped
// when the wheel turns the other way (release 5 plan, choice 3).
export function notch(carry: number, speed: number, dir: -1 | 1): { rows: number; carry: number } {
  const total = (carry * dir > 0 ? carry : 0) + speed * dir;
  const rows = Math.trunc(total) + 0; // + 0: a notch that moves nothing gives 0, not -0
  return { rows, carry: total - rows };
}

// The scroll bar (release 5 design, "Scrolling"): null when everything fits; otherwise the thumb's first row and size,
// its size the share of the conversation seen, at least one row (release 5 plan, choice 4), and its place the share of
// the way down, both rounded to the nearest row.
export function bar(total: number, height: number, first: number): { start: number; size: number } | null {
  if (total <= height) return null;
  const size = Math.max(1, Math.round((height * height) / total));
  return { start: Math.round((first * (height - size)) / (total - height)), size };
}

// The thumb's start back to a first row, for clicks and drags on the bar. A thumb row can stand for several first rows,
// so a first row taken to the thumb and back may move.
export function barFirst(total: number, height: number, size: number, start: number): number {
  return Math.round((start * (total - height)) / (height - size));
}
