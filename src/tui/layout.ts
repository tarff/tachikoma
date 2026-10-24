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
  const row = from.row + dir;
  const aim = goal ?? from.col;
  let best: number | null = null;
  for (const [index, p] of places) {
    if (p.row !== row) continue;
    if (best === null || (p.col <= aim && p.col > places.get(best)!.col)) best = index;
  }
  return best === null ? null : { cursor: best, goal: aim };
}
