import { Box, Text } from "ink";
import type { Found } from "./find.js";
import { drawn, ordered } from "./select.js";
import { bar, type Pos, type Row, type Rows } from "./view.js";

// The conversation in full screen (release 5 design, "The screen", "Scrolling"): `height` rows from `first`, each in its
// line's colour, then blank rows, so what is drawn under it stays at the bottom of the screen; a view held past the
// bottom (view.ts, first) draws only the rows there are. The rows are wrapped one column short (release 5 plan, choice
// 1), and that column takes the scroll bar once the lines are longer than the view. While the view does not follow, its
// last row counts the lines that came in (choice 5). Each row is a Box one row tall, as an empty Text takes no row. The
// selection shows in reverse colours on the text only, never on the bar's column (release 5 design, "Selecting"), and so
// do the detail view's search matches, `found` (DetailView.tsx; plan, choice 12). `bottom` is the key bound to
// scroll:bottom, which the count names (release 6 plan, Task 6), if any.
export function Conversation({
  rows,
  first,
  height,
  unseen,
  following,
  selection = null,
  found = [],
  bottom,
}: {
  rows: Rows;
  first: number;
  height: number;
  unseen: number;
  following: boolean;
  selection?: [Pos, Pos] | null;
  found?: readonly Found[];
  bottom?: string;
}) {
  const thumb = bar(rows.total, height, first);
  const note = !following && unseen > 0 ? `↓ ${unseen} new line${unseen === 1 ? "" : "s"}${bottom === undefined ? "" : ` · ${bottom}`}` : null;
  const marks = found.map((m): [Pos, Pos] => [
    { line: m.line, offset: m.start },
    { line: m.line, offset: m.end },
  ]);
  if (selection) marks.push(selection);
  return Array.from({ length: height }, (_, i) => {
    const row = note && i === height - 1 ? { text: note, color: "gray" } : first + i < rows.total ? rows.row(first + i) : null;
    const parts = row && "line" in row && marks.length ? marked(rows, row, marks) : null;
    return (
      <Box key={i} height={1}>
        <Box width={rows.width} flexShrink={0}>
          {row && (
            <Text color={row.color} wrap="truncate-end">
              {parts ? parts.map((p, k) => (p.inverse ? <Text key={k} inverse>{p.text}</Text> : p.text)) : row.text}
            </Text>
          )}
        </Box>
        {thumb && <Text color="gray">{i >= thumb.start && i < thumb.start + thumb.size ? "┃" : "│"}</Text>}
      </Box>
    );
  });
}

// A row drawn in runs, each inside the marks (the selection, the search's matches) or not, or null when no mark has any
// of its text. Its characters are drawn and found as select.ts's placeAt finds them (select.ts, drawn).
function marked(rows: Rows, r: Row, marks: [Pos, Pos][]): { text: string; inverse: boolean }[] | null {
  const spans = marks.flatMap((m) => {
    const [from, to] = ordered(...m);
    const a = r.line === from.line ? from.offset : r.line > from.line ? 0 : Infinity;
    const b = r.line === to.line ? to.offset : r.line < to.line ? Infinity : -Infinity;
    return a >= Math.min(b, r.end) || b <= r.start ? [] : [{ a, b }];
  });
  if (!spans.length) return null;
  const parts: { text: string; inverse: boolean }[] = [];
  for (const c of drawn(rows, r)) {
    // The "…" stands for all it cuts, which a mark reaches into or not.
    const inverse = spans.some(({ a, b }) => (c.cut ? b > c.offset : c.offset >= a && c.offset < b));
    if (parts.at(-1)?.inverse === inverse) parts.at(-1)!.text += c.text;
    else parts.push({ text: c.text, inverse });
  }
  return parts;
}
