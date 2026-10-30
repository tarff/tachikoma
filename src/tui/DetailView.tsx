import { visible } from "../core/permissions.js";
import type { Bindings } from "./bindings.js";
import { Conversation } from "./Conversation.js";
import { type Line, screen as escaped } from "./describe.js";
import { type Found, find } from "./find.js";
import { named } from "./keys.js";
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

// Opened at its top, so a record is read from its heading. The lines are escaped as the conversation's are
// (app/output.ts, say).
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

// Typing searches as it goes: the query's matches, and the first at or below the top row the view had when `/` was
// pressed, or, with none there, the first of all, as n goes round; brought into view from that view, so each query's
// view is the same however it was typed. With no match the view is where it was.
export function searchFor(d: Detail, query: string, height: number) {
  const s = d.search!;
  const top = first(d.rows, s.before, height);
  s.query = query;
  s.found = find(d.rows.lines, query);
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

// The row under the view: the keys; while typing a search, what is typed, saying so when nothing matches, as Ctrl+R's
// row does (the user's choice at Task 12's review); a search kept, which match shows of how many. The keys are those
// bound in the table, named as release 5 named them (keys.ts, named); `[` prints the view out (Task 13).
export function keyRow(d: Detail, b: Bindings): string {
  const k = (action: string, ...usual: string[]) => named(b, `transcript:${action}`, "Transcript", usual);
  // Each group's keys, then what they do; a group with no key bound is left out.
  const row = (...groups: [(string | undefined)[], string][]) =>
    groups
      .map(([keys, words]) => [keys.filter(Boolean), words] as const)
      .filter(([keys]) => keys.length)
      .map(([keys, words]) => `${keys.join(" ")} ${words}`)
      .join(" · ");
  const s = d.search;
  if (!s) {
    const [down, up, top, bottom] = [k("lineDown", "j", "down"), k("lineUp", "k", "up"), k("top", "g", "home"), k("bottom", "shift+g", "end")];
    return row(
      [[down[0], up[0], ...up.slice(1), ...down.slice(1)], "line"],
      [[top[0], bottom[0], ...top.slice(1), ...bottom.slice(1)], "top, bottom"],
      [k("search", "/"), "search"],
      [k("print", "["), "print"],
      [k("exit", "q", "escape"), "close"],
    );
  }
  if (s.typing) return `/${visible(s.query)}${s.query && !s.found.length ? " (no match)" : ""}`;
  const steps = row([k("nextMatch", "n"), "next"], [k("previousMatch", "shift+n"), "previous"]);
  return [`"${visible(s.query)}": ${s.at + 1} of ${s.found.length}`, steps].filter(Boolean).join(" · ");
}

// The matches on the lines of the `height` rows from `top`, which are all the drawing needs: it looks at each match it is
// given for every row (found at Task 12's review, where 24,000 matches took 23 ms a frame). `found` is in line order.
export function onScreen(rows: Rows, found: readonly Found[], top: number, height: number): Found[] {
  if (!rows.total) return [];
  const from = rows.row(top).line;
  const to = rows.row(Math.min(rows.total, top + height) - 1).line;
  return found.filter((m) => m.line >= from && m.line <= to);
}

// The view's rows, drawn as the conversation's are, the search's matches and the selection in reverse colours.
export function DetailView({ detail, height, selection }: { detail: Detail; height: number; selection: [Pos, Pos] | null }) {
  const { rows, view, search } = detail;
  const top = first(rows, view.current, height);
  return (
    <Conversation
      rows={rows}
      first={top}
      height={height}
      unseen={0}
      following={view.current.at === null}
      selection={selection}
      found={search ? onScreen(rows, search.found, top, height) : []}
    />
  );
}
