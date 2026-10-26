import { Box, Text } from "ink";
import { bar, type Rows } from "./view.js";

// The conversation in full screen (release 5 design, "The screen", "Scrolling"): `height` rows from `first`, each in its
// line's colour, then blank rows, so what is drawn under it stays at the bottom of the screen; a view held past the
// bottom (view.ts, first) draws only the rows there are. The rows are wrapped one column short (release 5 plan, choice
// 1), and that column takes the scroll bar once the lines are longer than the view. While the view does not follow, its
// last row counts the lines that came in (choice 5). Each row is a Box one row tall, as an empty Text takes no row.
export function Conversation({ rows, first, height, unseen, following }: { rows: Rows; first: number; height: number; unseen: number; following: boolean }) {
  const thumb = bar(rows.total, height, first);
  const note = !following && unseen > 0 ? `↓ ${unseen} new line${unseen === 1 ? "" : "s"} · Ctrl+End` : null;
  return Array.from({ length: height }, (_, i) => {
    const row = note && i === height - 1 ? { text: note, color: "gray" } : first + i < rows.total ? rows.row(first + i) : null;
    return (
      <Box key={i} height={1}>
        <Box width={rows.width} flexShrink={0}>
          {row && (
            <Text color={row.color} wrap="truncate-end">
              {row.text}
            </Text>
          )}
        </Box>
        {thumb && <Text color="gray">{i >= thumb.start && i < thumb.start + thumb.size ? "┃" : "│"}</Text>}
      </Box>
    );
  });
}
