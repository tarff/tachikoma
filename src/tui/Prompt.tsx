import { Text, useCursor } from "ink";
import type { Editor } from "./editor.js";
import { layout } from "./layout.js";

// The columns the prompt's text may use: two go before it ("› " on the first row), and one after a
// full row is kept for the cursor.
export const promptWidth = (columns: number) => Math.max(1, columns - 3);

// The prompt, wrapped to the screen (release 3 design, "Multi-line"), with the terminal's own cursor
// where typing goes, so input methods work. Shown only while the prompt has the keys: when it is not
// drawn, Ink hides the cursor.
export function Prompt({ editor, columns }: { editor: Editor; columns: number }) {
  const { rows, places } = layout(editor.text, promptWidth(columns));
  const at = places.get(editor.cursor)!;
  useCursor().setCursorPosition({ x: 2 + at.col, y: at.row });
  return (
    <>
      {rows.map((row, i) => (
        <Text key={i}>
          {i ? "  " : "› "}
          {row}
        </Text>
      ))}
    </>
  );
}
