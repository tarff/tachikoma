import { Text } from "ink";
import { useRef } from "react";
import stringWidth from "string-width";
import { visible } from "../core/permissions.js";
import { scroll } from "./layout.js";
import type { Entry } from "./menus.js";

// An open `/` or `@` menu, under the prompt, in `rows` rows: past that it scrolls with the chosen
// entry, as the prompt does with the cursor, the first and last rows counting the entries cut off.
// `top` is the window's first entry: the App passes its own, to map a click to an entry (release 5
// design, "Clicking"). `columns` is the width its rows are drawn at, where Ink cuts them.
export function Menu({ entries, chosen, rows, columns, top: given }: { entries: Entry[]; chosen: number; rows: number; columns: number; top?: { current: number } }) {
  const shown = Math.min(entries.length, Math.max(1, rows));
  const own = useRef(0);
  const top = given ?? own;
  const w = scroll(entries.length, shown, chosen, top.current);
  top.current = w.top;
  // Each note starts in one column, two spaces after the longest label among the entries on screen, not the rows counting
  // those cut off (TUI design pass, Task 11; audit 9).
  const drawn = entries.slice(w.top, w.top + shown);
  // Whether the row at `i` counts the entries cut off above or below, in an entry's place.
  const counting = (i: number) => (i === 0 && w.above > 0) || (i === shown - 1 && w.below > 0);
  // A label sets the column only when its row has a note and room to show at least one character of it: Ink's cut keeps
  // the row's first columns less one and puts `…` in the last, so the row's first two spaces, the label, its two spaces
  // and that character must come before it. A long label's own note follows it by two spaces, cut at the row's end
  // (Task 11; the user's choices, 2026-11-15, "No room left", "Count the …" and "Leave it out").
  const width = (e: Entry) => stringWidth(visible(e.label));
  const labels = drawn.filter((e, i) => !counting(i) && e.note);
  const wide = Math.max(0, ...labels.map(width).filter((n) => 2 + n + 2 + 1 < columns));
  return (
    <>
      {drawn.map((e, i) =>
        counting(i) ? (
          <Text key={i} dimColor>
            {"  "}
            {i === 0 && w.above > 0 ? `↑ ${w.above}` : `↓ ${w.below}`} more
          </Text>
        ) : (
          <Text key={i} wrap="truncate-end" color={e.error ? "red" : undefined}>
            {"  "}
            <Text inverse={w.top + i === chosen && !e.error}>{visible(e.label)}</Text>
            {e.note && <Text dimColor>{`${" ".repeat(Math.max(0, wide - width(e)) + 2)}${e.note}`}</Text>}
          </Text>
        ),
      )}
    </>
  );
}
