import { Text, useCursor } from "ink";
import { useRef } from "react";
import type { Editor } from "./editor.js";
import { layout, scroll } from "./layout.js";

// The columns the prompt's text may use: two go before it ("› " on the first row), and one after a
// full row is kept for the cursor.
export const promptWidth = (columns: number) => Math.max(1, columns - 3);

// The prompt, wrapped to the screen (release 3 design, "Multi-line"), with the terminal's own cursor
// where typing goes, so input methods work. Shown only while the prompt has the keys: when it is not
// drawn, Ink hides the cursor. `offset` is the rows drawn above it, since Ink places the cursor from
// the top of what it draws. Taller than `space` rows, it shows the rows around the cursor. `top` is
// the window's first row, kept from one drawing to the next: the App passes its own, to map a click
// to a row (release 5 design, "Clicking").
export function Prompt({
  editor,
  columns,
  offset,
  space,
  top: given,
}: {
  editor: Editor;
  columns: number;
  offset: number;
  space: number;
  top?: { current: number };
}) {
  const { rows, places } = layout(editor.text, promptWidth(columns));
  const at = places.get(editor.cursor)!;
  const shown = Math.min(rows.length, Math.max(1, space));
  const own = useRef(0);
  const top = given ?? own;
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
          ) : (
            row
          )}
        </Text>
      ))}
    </>
  );
}
