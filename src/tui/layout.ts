import stringWidth from "string-width";
import { visible } from "../core/permissions.js";
import { segmenter } from "./editor.js";
import type { TaskRow } from "./TaskPanel.js";
import type { TodoRow } from "./TodoList.js";
import { wrap } from "./view.js";

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

// What the App draws, for the frame's sums below. The task panel and the to-do list say what they draw in so many rows
// (TaskPanel.tsx, taskRows; TodoList.tsx, todoRows), the to-do list nothing while Ctrl+T hides it or every item is done.
export interface FrameIn {
  rows: number; // the terminal's
  columns: number;
  full: boolean; // full screen
  promptRows: number; // the rows of the prompt drawn (layout, above), which during Ctrl+R's search is the match
  cursorRow: number; // the cursor's row among them
  promptTop: number; // the prompt window's first row last frame, which scroll() moves from
  working: boolean; // the working line
  toolLine: boolean; // a tool line to draw, when there is room for it: never under the model list
  detail: boolean; // the detail view, which draws no prompt
  hint: boolean; // a line for the hint row; whether there is one does not depend on the rows left for the queue
  menu: number | null; // an open menu's entries
  taskRows: (rows: number) => TaskRow[];
  todoRows: (rows: number) => TodoRow[];
  queued: number;
  pickerNeeded: number | null; // while the model list is open, the rows it needs: in full screen all of them unfiltered
  question: boolean; // a question drawn in the prompt's place
  askedText: string | null; // in full screen, the question's line, unless the model list is open
  askedShort: string | null; // the line it would show instead if too long to fit, while it can still move into the conversation
}

export interface FrameOut {
  tooled: boolean; // the tool line drawn
  hinted: boolean; // the hint row drawn
  menuRows: number;
  panel: TaskRow[];
  promptSpace: number; // the rows the prompt may take (Prompt.tsx, space)
  promptShown: number; // the rows it draws
  promptWindow: { top: number; above: number; below: number }; // which of its rows, as scroll() gives them
  todoShown: TodoRow[];
  left: number; // the rows left for the queue, which the hint reads; below zero when even the prompt is cut
  queuedShown: number; // the queue's rows, the last saying how many more there are when they do not all fit
  pickerRows: number;
  questionFits: boolean; // the question's line leaves the conversation its one row
  asked: string[]; // the rows of the question's line drawn: its short line's, when it does not fit and can move
  viewHeight: number; // the conversation's rows, in full screen
  promptFirst: number; // the prompt's first row
}

// The frame's rows. The prompt's space (release 3 design): the live part stays a row shorter than the terminal, since at
// full height Ink draws the whole scrollback again each time. First the status line and the working line; the tool line
// when there is room for it, the hint line and the cursor's row; the hint line when there is room for it and the
// cursor's row (under the detail view, which draws no prompt, there is no cursor's row to keep); then an open menu, with
// the prompt cut to the cursor's row; then the task panel (release 4 design, "On screen"); then the prompt; then the
// to-do list, which gives way before the prompt does; then the queue, the last row saying how many more there are when
// they do not all fit. The model list fills the rows above the status line itself. In full screen a row fewer is given
// out: the conversation's, the least it has (release 5 design, "The screen").
//
// Full screen: the conversation takes every row of the frame the live area does not draw, at least one. The live area's
// rows are counted as they are drawn; under the detail view only the working line, while something runs, and the key
// row in the hint's place (release 5 plan, Task 12). A question is wrapped and drawn a row a Text, so its rows are known;
// one whose rows would leave the conversation less than its one row draws its short line instead, when it has one to
// move to (release 5 plan, Task 11). The model list takes the rows it needs, up to all but the conversation's least row,
// its filter line and the status line (release 5 plan, choice 19).
export function frame(i: FrameIn): FrameOut {
  const base = i.rows - 1 - 1 - (i.working ? 1 : 0) - (i.full ? 1 : 0);
  const cursor = i.detail ? 0 : 1; // the cursor's row, kept while the prompt is drawn
  const tooled = i.toolLine && base >= 1 + cursor + (i.hint ? 1 : 0);
  const room = base - (tooled ? 1 : 0);
  const hinted = i.hint && room >= 1 + cursor;
  const space = Math.max(1, room - (hinted ? 1 : 0));
  const menuRows = i.menu !== null ? Math.min(i.menu, Math.max(1, space - 1)) : 0;
  const panel = i.taskRows(Math.max(0, space - 1 - menuRows));
  const promptSpace = i.menu !== null ? 1 : space - panel.length;
  const promptShown = Math.min(i.promptRows, Math.max(1, promptSpace));
  const promptLeft = space - menuRows - panel.length - Math.min(i.promptRows, promptSpace);
  const todoShown = i.todoRows(promptLeft);
  const left = promptLeft - todoShown.length;
  const queuedShown = i.queued <= left ? i.queued : Math.max(0, left);
  // The frame's row short, the conversation's, the filter line and the status line.
  const pickerRows = i.pickerNeeded === null ? 0 : Math.max(1, Math.min(i.pickerNeeded, i.rows - 1 - 1 - 1 - 1 - (hinted ? 1 : 0)));
  const abovePrompt = (i.working ? 1 : 0) + todoShown.length + queuedShown; // the live area's rows drawn above the prompt
  const live = (askedRows: number) =>
    (i.pickerNeeded !== null ? pickerRows + 1 : i.question ? askedRows : i.detail ? (i.working ? 1 : 0) : abovePrompt + promptShown + menuRows + panel.length) +
    (hinted ? 1 : 0) + 1 + (tooled ? 1 : 0);
  const linesOf = (text: string | null) => (text === null ? [] : wrap(text, i.columns, false).map((r) => r.text));
  const questionFits = i.askedText === null || i.rows - 1 - live(linesOf(i.askedText).length) >= 1; // as viewHeight, below
  const asked = linesOf(questionFits || i.askedShort === null ? i.askedText : i.askedShort);
  const viewHeight = Math.max(1, i.rows - 1 - live(asked.length));
  return {
    tooled,
    hinted,
    menuRows,
    panel,
    promptSpace,
    promptShown,
    promptWindow: scroll(i.promptRows, promptShown, i.cursorRow, i.promptTop),
    todoShown,
    left,
    queuedShown,
    pickerRows,
    questionFits,
    asked,
    viewHeight,
    promptFirst: (i.full ? viewHeight : 0) + abovePrompt,
  };
}
