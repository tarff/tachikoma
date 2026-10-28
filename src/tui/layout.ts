import stringWidth from "string-width";
import { visible } from "../core/permissions.js";
import { segmenter } from "./editor.js";

// The prompt as the screen shows it (release 3 design, "Multi-line"): rows of at most `width`
// columns, wrapped at the column, not at a word, and a new row at each line break. Control characters
// show as the escapes the scrollback uses, and take the columns those take. `width` leaves out the
// column the cursor needs after a full row, so a place is always on screen.

export interface Place {
  row: number;
  col: number;
}

export interface Layout {
  rows: string[]; // what each row shows
  places: Map<number, Place>; // every place between characters, by its index in the text
}

export function layout(text: string, width: number): Layout {
  const rows = [""];
  const places = new Map<number, Place>();
  let col = 0;
  for (const { segment, index } of segmenter.segment(text)) {
    if (segment === "\n") {
      places.set(index, { row: rows.length - 1, col });
      rows.push("");
      col = 0;
      continue;
    }
    const shown = visible(segment);
    const w = stringWidth(shown);
    if (col > 0 && col + w > width) {
      rows.push("");
      col = 0;
    }
    places.set(index, { row: rows.length - 1, col }); // the place before a character is where it is drawn
    rows[rows.length - 1] += shown;
    col += w;
  }
  places.set(text.length, { row: rows.length - 1, col });
  return { rows, places };
}

// The cursor one row up (-1) or down (1), at the column `goal` (the column the moves started from),
// or at the end of a row too short for it. Null when there is no row there: Up and Down then step
// through the history instead.
export function vertical(text: string, width: number, cursor: number, dir: -1 | 1, goal: number | null): { cursor: number; goal: number } | null {
  const { places } = layout(text, width);
  const from = places.get(cursor)!;
  const aim = goal ?? from.col;
  const best = placeOn(places, from.row + dir, aim);
  return best === null ? null : { cursor: best, goal: aim };
}

// The place on screen row `row` at column `col`: before the character drawn there, or the row's
// last place for a column past its end, where a click in the prompt goes too (release 5 design,
// "Clicking"). Null when there is no such row.
export function placeOn(places: Map<number, Place>, row: number, col: number): number | null {
  let best: number | null = null;
  for (const [index, p] of places) {
    if (p.row !== row) continue;
    if (best === null || (p.col <= col && p.col > places.get(best)!.col)) best = index;
  }
  return best;
}

// Which rows of a prompt taller than its space are shown (release 3 design, "The prompt's space"):
// `space` rows from `top`, keeping the cursor's row in view, moved from the window shown before (its
// `top`) only as far as the cursor needs. A row cut off above or below gives its place to a count of
// the rows hidden there, itself included, when there are three rows or more: the cursor's row always
// stays between the counts.
export function scroll(total: number, space: number, cursor: number, top: number): { top: number; above: number; below: number } {
  if (total <= space) return { top: 0, above: 0, below: 0 };
  const marks = space >= 3;
  const clamp = (t: number) => Math.min(Math.max(t, 0), total - space);
  let t = clamp(top);
  const first = t + (marks && t > 0 ? 1 : 0); // the first and last rows of text shown
  const last = t + space - 1 - (marks && t + space < total ? 1 : 0);
  if (cursor < first) t = clamp(!marks ? cursor : cursor > 1 ? cursor - 1 : 0);
  else if (cursor > last) t = clamp(cursor - space + (marks && cursor < total - 1 ? 2 : 1));
  return { top: t, above: marks && t > 0 ? t + 1 : 0, below: marks && t + space < total ? total - (t + space - 1) : 0 };
}
