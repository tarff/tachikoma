// Selecting and copying's pure parts (release 5 design, "Selecting", "Copying"): which places a drag or a click covers,
// and the text between two places. A selection is two places in the lines, not screen rows, so it stays on its text
// as the view moves or rewraps.
import { segmenter } from "./editor.js";
import { columnsAt, columnsOf, type Pos, type Rows } from "./view.js";

export const CLICK_MS = 500; // Windows' default double-click time (Microsoft, SetDoubleClickTime)

export function ordered(a: Pos, b: Pos): [Pos, Pos] {
  return a.line < b.line || (a.line === b.line && a.offset <= b.offset) ? [a, b] : [b, a];
}

// The text from a up to b (b's character not included: places are between characters), lines joined by "\n"; a wrapped
// line comes whole, as it is one line (release 5 design, "Copying"). It is exactly the text selected, spaces and all,
// at a line's end too (the user's choice, 2026-10-27).
export function textOf(lines: readonly { text: string }[], a: Pos, b: Pos): string {
  const [from, to] = ordered(a, b);
  const out: string[] = [];
  for (let i = from.line; i <= to.line; i++) {
    const text = lines[i]!.text;
    out.push(text.slice(i === from.line ? from.offset : 0, i === to.line ? to.offset : text.length));
  }
  return out.join("\n");
}

// The place before the character under column x of the row, or the row's end past its text, with `past` saying which.
// The columns are counted as view.ts draws the row: a tab as spaces to its stop, and a one-line entry, which is drawn
// cut (view.ts, cut), by string-width alone. Where "…" cuts a one-line entry, it and past it stand for the entry's end,
// so selecting to the row's end takes the whole entry (release 5 plan, choice 2).
export function placeAt(rows: Rows, row: number, x: number): { pos: Pos; past: boolean } {
  const r = rows.row(row);
  const l = rows.lines[r.line]!;
  const room = l.oneLine && r.text !== l.text ? rows.width - 1 : Infinity; // 1: the column "…" takes
  let col = 0;
  for (const { segment, index } of segmenter.segment(l.text.slice(r.start, r.end))) {
    const w = l.oneLine ? columnsOf(segment) : columnsAt(segment, col, rows.width);
    if (col + w > room) break;
    if (x < col + w) return { pos: { line: r.line, offset: r.start + index }, past: false };
    col += w;
  }
  return { pos: { line: r.line, offset: r.end }, past: true };
}

// A selection from the pressed cell to the current one, as places, both cells' characters in (release 5 plan, choice
// 6): forward, from before the pressed cell's character to after the current cell's; backward, from before the
// current cell's to after the pressed cell's. A cell past a row's text stands for the row's end and adds nothing.
export function span(rows: Rows, press: { row: number; x: number }, now: { row: number; x: number }): [Pos, Pos] {
  const forward = now.row > press.row || (now.row === press.row && now.x >= press.x);
  const [from, to] = forward ? [press, now] : [now, press];
  const start = placeAt(rows, from.row, from.x).pos;
  const end = placeAt(rows, to.row, to.x);
  if (end.past) return [start, end.pos];
  const g = segmenter.segment(rows.lines[end.pos.line]!.text).containing(end.pos.offset)!;
  return [start, { line: end.pos.line, offset: g.index + g.segment.length }];
}

// A word's characters (release 5 design, "Selecting"): letters, digits, marks and iTerm2's default /-+\~_. , by a
// character's first code point.
const WORD = /^[\p{L}\p{N}\p{M}/\-+\\~_.]/u;
const LINK = /https?:\/\/\S*/g;

// A link without the punctuation after it, as most terminals leave it off (the user's choice, 2026-10-27): a final
// . , ; : ! ? , a closing bracket the link has fewer openers for, and a quote the link has an odd number of, again and
// again while the end is one of these. So "(see https://x.dev/a)." gives https://x.dev/a, and a Wikipedia link ending
// in "_(bar)" keeps its ")".
const OPENER: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
const count = (s: string, c: string) => s.split(c).length - 1;
function linkEnd(link: string): number {
  for (;;) {
    const c = link.at(-1)!;
    const loose = ".,;:!?".includes(c) || (c in OPENER && count(link, c) > count(link, OPENER[c]!)) || ((c === "'" || c === '"') && count(link, c) % 2 === 1);
    if (!loose) return link.length;
    link = link.slice(0, -1);
  }
}

// Double-click (release 5 design, "Selecting"; plan, choice 6): a URL from http:// or https:// to the next space whole,
// less the punctuation after it (linkEnd), which is taken alone (the user's choice at Task 9's review, 2026-10-27);
// otherwise the word around the character, with a colon in it where it is a drive's (a single letter starting the word
// before it, \ or / after it: C:\ or C:/), so a Windows path is one word; any other character alone.
export function wordAt(text: string, offset: number): { start: number; end: number } {
  for (const m of text.matchAll(LINK)) {
    if (offset < m.index || offset >= m.index + m[0].length) continue;
    const end = m.index + linkEnd(m[0]);
    return offset < end ? { start: m.index, end } : { start: offset, end: offset + 1 }; // 1: what linkEnd leaves off is ASCII
  }
  const segments = segmenter.segment(text);
  const at = (i: number) => segments.containing(i);
  const plain = (s: Intl.SegmentData | undefined) => s !== undefined && WORD.test(s.segment);
  const drive = (s: Intl.SegmentData) =>
    s.segment === ":" && /^[A-Za-z]$/.test(at(s.index - 1)?.segment ?? "") && !plain(at(s.index - 2)) && /[\\/]/.test(text[s.index + 1] ?? "");
  const word = (s: Intl.SegmentData | undefined): s is Intl.SegmentData => s !== undefined && (plain(s) || drive(s));
  const here = at(offset);
  if (here === undefined) return { start: offset, end: offset }; // past the line's end: no character
  let start = here.index;
  let end = here.index + here.segment.length;
  if (!word(here)) return { start, end };
  for (let s = at(start - 1); word(s); s = at(start - 1)) start = s.index;
  for (let s = at(end); word(s); s = at(end)) end += s.segment.length;
  return { start, end };
}

// Same cell within CLICK_MS of the last press: one more click; after three, one again (release 5 plan, choice 6).
export function clicks(last: { at: number; x: number; y: number; count: number } | null, at: number, x: number, y: number): number {
  return last !== null && last.x === x && last.y === y && at - last.at <= CLICK_MS ? (last.count % 3) + 1 : 1; // 3: a triple click
}
