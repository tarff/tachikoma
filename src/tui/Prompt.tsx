import { Text, useCursor } from "ink";
import { useRef } from "react";
import { visible } from "../core/permissions.js";
import { type Editor, segmenter } from "./editor.js";
import { layout, type Place, scroll } from "./layout.js";

// The columns the prompt's text may use: two go before it ("› " on the first row), and one after a
// full row is kept for the cursor.
export const promptWidth = (columns: number) => Math.max(1, columns - 3);

// The prompt, wrapped to the screen (release 3 design, "Multi-line"), with the terminal's own cursor
// where typing goes, so input methods work. Shown only while the prompt has the keys: when it is not
// drawn, Ink hides the cursor. `offset` is the rows drawn above it, since Ink places the cursor from
// the top of what it draws. Taller than `space` rows, it shows the rows around the cursor. `top` is
// the window's first row, kept from one drawing to the next: the App passes its own, to map a click
// to a row (release 5 design, "Clicking"). `selected`, from and to as places in the text, is drawn in reverse colours:
// vim's VISUAL selection (release 6 plan, choice 28).
export function Prompt({
  editor,
  columns,
  offset,
  space,
  top: given,
  selected,
}: {
  editor: Editor;
  columns: number;
  offset: number;
  space: number;
  top?: { current: number };
  selected?: [number, number];
}) {
  const { rows, places } = layout(editor.text, promptWidth(columns));
  const at = places.get(editor.cursor)!;
  const shown = Math.min(rows.length, Math.max(1, space));
  const own = useRef(0);
  const top = given ?? own;
  const marked = selected && runs(editor.text, places, rows.length, selected);
  const w = scroll(rows.length, shown, at.row, top.current);
  top.current = w.top;
  useCursor().setCursorPosition({ x: 2 + at.col, y: offset + at.row - w.top });
  return (
    <>
      {rows.slice(w.top, w.top + shown).map((row, i) => (
        <Text key={i}>
          {i ? "  " : "› "}
          {i === 0 && w.above ? (
            <Text dimColor>↑ {w.above} rows above</Text>
          ) : i === shown - 1 && w.below ? (
            <Text dimColor>↓ {w.below} rows below</Text>
          ) : marked ? (
            marked[w.top + i]!.map((r, k) => (r.inverse ? <Text key={k} inverse>{r.text}</Text> : r.text))
          ) : (
            row
          )}
        </Text>
      ))}
    </>
  );
}

// Each row as runs of text, those from `from` to `to` marked to draw in reverse colours, a character at a time as
// layout() places and shows it. An empty line in the selection is one reversed space, as Claude Code 2.1.312 draws it
// (its cursor's render: `if(ee===Q)return ...n(" ")`).
function runs(text: string, places: Map<number, Place>, count: number, [from, to]: [number, number]) {
  const rows: { text: string; inverse: boolean }[][] = Array.from({ length: count }, () => []);
  const add = (row: number, shown: string, inverse: boolean) => {
    const last = rows[row]!.at(-1);
    if (last?.inverse === inverse) last.text += shown;
    else rows[row]!.push({ text: shown, inverse });
  };
  const inside = (i: number) => from <= i && i < to;
  for (const { segment, index } of segmenter.segment(text)) {
    const { row } = places.get(index)!;
    if (segment !== "\n") add(row, visible(segment), inside(index));
    else if (!rows[row]!.length && inside(index)) add(row, " ", true);
  }
  if (!rows[count - 1]!.length && inside(text.length)) add(count - 1, " ", true);
  return rows;
}
