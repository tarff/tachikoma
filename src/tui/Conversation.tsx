import { Box, Text } from "ink";
import { segmenter } from "./editor.js";
import { ordered } from "./select.js";
import { bar, columnsAt, columnsOf, type Pos, type Row, type Rows } from "./view.js";

// The conversation in full screen (release 5 design, "The screen", "Scrolling"): `height` rows from `first`, each in its
// line's colour, then blank rows, so what is drawn under it stays at the bottom of the screen; a view held past the
// bottom (view.ts, first) draws only the rows there are. The rows are wrapped one column short (release 5 plan, choice
// 1), and that column takes the scroll bar once the lines are longer than the view. While the view does not follow, its
// last row counts the lines that came in (choice 5). Each row is a Box one row tall, as an empty Text takes no row. The
// selection shows in reverse colours on the text only, never on the bar's column (release 5 design, "Selecting").
export function Conversation({
  rows,
  first,
  height,
  unseen,
  following,
  selection = null,
}: {
  rows: Rows;
  first: number;
  height: number;
  unseen: number;
  following: boolean;
  selection?: [Pos, Pos] | null;
}) {
  const thumb = bar(rows.total, height, first);
  const note = !following && unseen > 0 ? `↓ ${unseen} new line${unseen === 1 ? "" : "s"} · Ctrl+End` : null;
  return Array.from({ length: height }, (_, i) => {
    const row = note && i === height - 1 ? { text: note, color: "gray" } : first + i < rows.total ? rows.row(first + i) : null;
    const parts = row && "line" in row && selection ? marked(rows, row, selection) : null;
    return (
      <Box key={i} height={1}>
        <Box width={rows.width} flexShrink={0}>
          {row && (
            <Text color={row.color} wrap="truncate-end">
              {parts ? (
                <>
                  {parts[0]}
                  <Text inverse>{parts[1]}</Text>
                  {parts[2]}
                </>
              ) : (
                row.text
              )}
            </Text>
          )}
        </Box>
        {thumb && <Text color="gray">{i >= thumb.start && i < thumb.start + thumb.size ? "┃" : "│"}</Text>}
      </Box>
    );
  });
}

// A row drawn in three parts, before, inside and after the selection, or null when the selection has none of its text.
// The row is drawn as view.ts draws it, and its characters found as select.ts's placeAt finds them: a tab as spaces to
// its stop, and a one-line entry cut with "…", which stands for the entry's end.
function marked(rows: Rows, r: Row, selection: [Pos, Pos]): [string, string, string] | null {
  const [from, to] = ordered(...selection);
  const a = r.line === from.line ? from.offset : r.line > from.line ? 0 : Infinity;
  const b = r.line === to.line ? to.offset : r.line < to.line ? Infinity : -Infinity;
  if (a >= Math.min(b, r.end) || b <= r.start) return null;
  const l = rows.lines[r.line]!;
  const room = l.oneLine && r.text !== l.text ? rows.width - 1 : Infinity; // 1: the column "…" takes
  const parts: [string, string, string] = ["", "", ""];
  const part = (offset: number) => (offset < a ? 0 : offset < b ? 1 : 2);
  let col = 0;
  for (const { segment, index } of segmenter.segment(l.text.slice(r.start, r.end))) {
    const w = l.oneLine ? columnsOf(segment) : columnsAt(segment, col, rows.width);
    if (col + w > room) {
      parts[b > r.start + index ? 1 : 2] += "…"; // it stands for all it cuts, which the selection reaches into or not
      break;
    }
    parts[part(r.start + index)] += !l.oneLine && segment === "\t" ? " ".repeat(w) : segment;
    col += w;
  }
  return parts;
}
