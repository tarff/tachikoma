import { visible } from "../core/permissions.js";
import { Conversation } from "./Conversation.js";
import { type Line, screen as escaped } from "./describe.js";
import { type Found, find } from "./find.js";
import { first, type Pos, Rows, scrollTo, type View } from "./view.js";

// The detail view (release 5 design, "The detail view"; plan, Task 12): Ctrl+O's last turn or `/tasks t3`'s record, in
// the conversation's place, with rows and a view of its own. Its lines are fixed when it opens (plan, choice 12), so
// none arrive and it never counts new lines. `search` is `/`'s: what is typed, its matches, the one brought into view,
// whether it is still being typed (Enter keeps it), and where the view was when `/` was pressed, for Esc.
export interface Detail {
  rows: Rows;
  view: { current: View };
  search: { query: string; found: Found[]; at: number; typing: boolean; before: View } | null;
}

// The grey row under the view naming its keys; `[` is Task 13's.
export const KEYS = "j k ↑ ↓ line · g G Home End top, bottom · / search · [ print · q Esc close";

// Opened at its top, so a record is read from its heading. The lines are escaped as the conversation's are (App.tsx, say).
export function opened(lines: Line[], width: number): Detail {
  const rows = new Rows(width);
  rows.add(lines.map(escaped));
  return { rows, view: { current: { at: { line: 0, offset: 0 }, unseen: 0 } }, search: null };
}

// Match `i` brought into view from the view `from`: left where it is when its row is on screen, otherwise its row on the
// view's top row (plan, choice 12), or as near as the last screenful lets it.
function bring(d: Detail, i: number, from: View, height: number) {
  const m = d.search!.found[i]!;
  const row = d.rows.rowOf({ line: m.line, offset: m.start });
  const top = first(d.rows, from, height);
  d.view.current = row >= top && row < top + height ? from : scrollTo(d.rows, from, height, row);
}

// Typing searches as it goes: the query's matches, and the first from the top of the view as it was when `/` was pressed
// on, or, with none below it, the first of all, as n goes round; brought into view from there, so each query's view is
// the same however it was typed. With no match the view is where it was.
export function searchFor(d: Detail, query: string, height: number) {
  const s = d.search!;
  const top = first(d.rows, s.before, height);
  Object.assign(s, { query, found: find(d.rows.lines, query) });
  s.at = Math.max(0, s.found.findIndex((m) => d.rows.rowOf({ line: m.line, offset: m.start }) >= top));
  if (s.found.length) bring(d, s.at, s.before, height);
  else d.view.current = s.before;
}

// n and N: the next or previous match, round from the last to the first and back (plan, choice 12).
export function step(d: Detail, by: 1 | -1, height: number) {
  const s = d.search!;
  s.at = (s.at + by + s.found.length) % s.found.length;
  bring(d, s.at, d.view.current, height);
}

// The row under the view: the keys; while typing a search, what is typed; a search kept, which match shows of how many.
export function keyRow(d: Detail): string {
  const s = d.search;
  if (!s) return KEYS;
  return s.typing ? `/${visible(s.query)}` : `"${visible(s.query)}": ${s.at + 1} of ${s.found.length} · n next · N previous`;
}

// The view's rows, drawn as the conversation's are, the search's matches and the selection in reverse colours.
export function DetailView({ detail, height, selection }: { detail: Detail; height: number; selection: [Pos, Pos] | null }) {
  const { rows, view, search } = detail;
  return (
    <Conversation
      rows={rows}
      first={first(rows, view.current, height)}
      height={height}
      unseen={0}
      following={view.current.at === null}
      selection={selection}
      found={search?.found}
    />
  );
}
