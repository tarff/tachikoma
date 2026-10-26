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
// A line as Rows keeps it: one line of text, with no line break in it.
export interface KeptLine {
  text: string;
  color?: string;
  oneLine?: boolean;
}

// A tab is drawn as spaces to the next stop. Ink would draw a tab handed to it wrongly: its output puts "\t" in one cell
// (output.js) and string-width counts it as 0 columns, so the terminal's own jump to the next stop would push the rest
// of the row past its end. So the row's text carries spaces, and Ink draws exactly what was measured. Stops every 8
// columns, as wrap-ansi's TAB_SIZE (Ink's wrapping in classic mode) and terminals' default. They count from the row's
// start, so each row stands on its own; classic counts from the line's start, which differs on a wrapped line's later
// rows. A tab cut at a row's end does not carry its spaces to the next row either: "abcdefghi\tx" at 10 columns
// has "      x" as its second row in classic, and "x" here.
const TAB = 8;

// Printable ASCII is one column a character, each its own grapheme, so its columns are counted without the segmenter
// or string-width: wrap-ansi's own shortcut (its ASCII_PRINTABLE_REGEX). A tab is not in it, so a line with one is
// counted the long way.
const ASCII = /^[ -~]*$/;

// Outside ASCII, string-width takes about 1 µs a character (3 million graphemes: 3.1 s, against 0.2 s from this cache,
// measured for release 5's Task 3 review), so each character's columns are kept once found. Ink keeps its own for one
// frame (OutputCaches belongs to one Output, and renderer.js makes a new Output each frame); this one lasts one pass,
// cleared at each add and setWidth, so text with endless different characters cannot grow it without limit.
const known = new Map<string, number>();
function columnsOf(g: string): number {
  let w = known.get(g);
  if (w === undefined) known.set(g, (w = stringWidth(g)));
  return w;
}

// Where each of one line's rows starts at `width` columns, the first at 0 (release 5 plan, choice 1). The rows break as
// Ink's own wrapping breaks them in classic mode (wrap-ansi with hard: true, trim: false, in Ink's wrap-text.js): a
// word that does not fit goes to the next row, so a row breaks after the last space that fits, and a space that does
// not fit starts the next row. A word longer than a row starts on the row it is on, unless starting it on the next
// row takes fewer rows, and is cut at each row's end. A character is never split (graphemes, with string-width's
// columns). A space or tab that the segmenter joins with a mark after it (a combining mark, ZWJ, FE0F) is still a
// place to break, with the joined character's columns.
function starts(text: string, width: number): number[] {
  const segs = ASCII.test(text) ? null : [...segmenter.segment(text)];
  const widths = segs?.map((s) => columnsOf(s.segment));
  const n = segs ? segs.length : text.length;
  const at = (k: number) => (segs ? segs[k]!.index : k);
  const columns = (k: number) => (widths ? widths[k]! : 1);
  const blank = (k: number) => text[at(k)] === " " || text[at(k)] === "\t";
  const found = [0];
  let col = 0;
  const breakAt = (i: number) => {
    found.push(i);
    col = 0;
  };
  for (let k = 0; k < n; ) {
    if (blank(k)) {
      if (col > 0 && col >= width) breakAt(at(k));
      col += text[at(k)] === "\t" ? Math.min(TAB - (col % TAB), width - col) : columns(k);
      k++;
      continue;
    }
    let m = k;
    let word = 0;
    for (; m < n && !blank(m); m++) word += columns(m);
    if (word > width) {
      // wrap-ansi's own test: the rows the word starts here, against the rows it starts on the next row.
      if (col > 0 && Math.floor((word - 1) / width) < 1 + Math.floor((word - (width - col) - 1) / width)) breakAt(at(k));
      for (let g = k; g < m; g++) {
        const w = columns(g);
        if (w > 0 && col > 0 && col + w > width) breakAt(at(g));
        col += w;
      }
    } else {
      if (col > 0 && col + word > width) breakAt(at(k));
      col += word;
    }
    k = m;
  }
  return found;
}

// What a row of text[start, end) shows: the text itself, with each tab as spaces to its stop, cut at `width`.
function draw(text: string, start: number, end: number, width: number): string {
  const part = text.slice(start, end);
  if (!part.includes("\t")) return part;
  let shown = "";
  let col = 0;
  for (const { segment } of segmenter.segment(part)) {
    if (segment === "\t") {
      const w = Math.min(TAB - (col % TAB), width - col);
      shown += " ".repeat(w);
      col += w;
    } else {
      shown += segment;
      col += columnsOf(segment);
    }
  }
  return shown;
}

// One line's rows at `width` columns: where each starts and ends in the line's text, covering it without gaps, and what
// it shows. An empty line is one empty row. One-line entries (choice 2) are one row, cut with "…" as Ink's truncate-end
// cuts them in classic mode, and end at the text's end, so selecting to the row's end takes the whole entry.
export function wrap(text: string, width: number, oneLine: boolean): Wrapped[] {
  if (oneLine) return [{ start: 0, end: text.length, text: cut(text, width) }];
  const found = starts(text, width);
  return found.map((start, k) => {
    const end = found[k + 1] ?? text.length;
    return { start, end, text: draw(text, start, end, width) };
  });
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

// All the lines, and where their rows start at the current width. Only places are kept, nothing for a line of one row,
// and a row's text is made when it is drawn, so a long session costs little more than its text; with the count of rows
// before each line, finding a row is a binary search (release 5 design, "The screen").
export class Rows {
  #width: number;
  #lines: KeptLine[] = [];
  #starts: (number[] | null)[] = []; // null: one row
  #before: number[] = [];
  #total = 0;

  constructor(width: number) {
    this.#width = width;
  }

  // Each Line split at its line breaks into lines of its own, the same colour, so a place is a line and an offset.
  add(lines: Line[]): void {
    known.clear();
    for (const l of lines) {
      for (const text of l.text.split("\n")) {
        const kept: KeptLine = { text, ...(l.color === undefined ? {} : { color: l.color }), ...(l.oneLine ? { oneLine: true } : {}) };
        this.#lines.push(kept);
        this.#keep(kept);
      }
    }
  }

  #keep(l: KeptLine): void {
    const found = l.oneLine ? null : starts(l.text, this.#width);
    this.#before.push(this.#total);
    this.#starts.push(found && found.length > 1 ? found : null);
    this.#total += found ? found.length : 1;
  }

  get lines(): readonly KeptLine[] {
    return this.#lines;
  }

  get width(): number {
    return this.#width;
  }

  // A resize wraps every line again (release 5 design, "The screen").
  setWidth(width: number): void {
    known.clear();
    this.#width = width;
    this.#starts = [];
    this.#before = [];
    this.#total = 0;
    for (const l of this.#lines) this.#keep(l);
  }

  get total(): number {
    return this.#total;
  }

  row(i: number): Row {
    if (i < 0 || i >= this.#total) throw new RangeError(`row ${i} of ${this.#total}`);
    let lo = 0;
    let hi = this.#before.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1; // >> 1: halves, rounding down
      if (this.#before[mid]! <= i) lo = mid;
      else hi = mid - 1;
    }
    const l = this.#lines[lo]!;
    const found = this.#starts[lo];
    const k = i - this.#before[lo]!;
    const start = found ? found[k]! : 0;
    const end = found?.[k + 1] ?? l.text.length;
    const text = l.oneLine ? cut(l.text, this.#width) : draw(l.text, start, end, this.#width);
    return { line: lo, start, end, text, ...(l.color === undefined ? {} : { color: l.color }) };
  }

  // Rows are half-open, start <= offset < end, and the line's own end is on its last row: where one row ends the next
  // starts, so a view held at a line's second row stays on that row (release 5 plan, from its review).
  rowOf(p: Pos): number {
    const found = this.#starts[p.line];
    return this.#before[p.line]! + (found ? found.findLastIndex((s) => s <= p.offset) : 0);
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

// The first row shown. Following, the last screenful. Held, the row of its place, whatever the height or the lines
// that arrive: a held view stays where it was put (release 5 design, "Scrolling"), even past the bottom, where a
// question's detail (Task 11) or a change of height or width can leave it; the rows past the last line are blank.
export function first(rows: Rows, v: View, height: number): number {
  return v.at === null ? bottom(rows, height) : rows.rowOf(v.at);
}

// Scrolling to the bottom, or past it, follows again with nothing unseen, so scrolling never parks a view past the
// bottom; above the top is the top. Moving down from a view held past the bottom therefore reaches the bottom and
// follows, and the text moves up by as much as a screen: on purpose, as reaching the bottom follows (release 5 design,
// "Scrolling").
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
// when the wheel turns the other way (release 5 plan, choice 3). It counts whole units of the speed's own decimal
// places (tenths for 0.5), so no row is lost to rounding, and it holds for one speed: the session's, which Task 7 checks
// is finite and above 0.
export function notch(carry: number, speed: number, dir: -1 | 1): { rows: number; carry: number } {
  let unit = 1; // the power of 10 that makes the speed a whole number, so every sum below is exact
  while (Math.round(speed * unit) / unit !== speed) unit *= 10;
  const total = (carry * dir > 0 ? carry : 0) + Math.round(speed * unit) * dir; // carry: in 1/unit rows
  const rest = total % unit;
  return { rows: (total - rest) / unit + 0, carry: rest + 0 }; // + 0: a notch that moves nothing gives 0, not -0
}

// The scroll bar (release 5 design, "Scrolling"): null when everything fits; otherwise the thumb's first row and size,
// its size the share of the conversation seen, at least one row (release 5 plan, choice 4), and its place the share of
// the way down, both rounded to the nearest row.
export function bar(total: number, height: number, first: number): { start: number; size: number } | null {
  if (total <= height) return null;
  const size = Math.max(1, Math.round((height * height) / total));
  // A view held past the bottom (see first) shows the thumb at the bar's foot, not past it.
  return { start: Math.round((Math.min(first, total - height) * (height - size)) / (total - height)), size };
}

// The thumb's start back to a first row, for clicks and drags on the bar. A thumb row can stand for several first rows,
// so a first row taken to the thumb and back may move. A thumb as tall as the bar has nowhere to go: the top.
export function barFirst(total: number, height: number, size: number, start: number): number {
  if (height === size) return 0;
  return Math.round((start * (total - height)) / (height - size));
}
