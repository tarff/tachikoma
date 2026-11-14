import { Text } from "ink";
import { useRef } from "react";
import stringWidth from "string-width";
import { visible } from "../core/permissions.js";
import { scroll } from "./layout.js";
import type { Entry } from "./menus.js";

// An open `/` or `@` menu, under the prompt, in `rows` rows: past that it scrolls with the chosen
// entry, as the prompt does with the cursor, the first and last rows counting the entries cut off.
// `top` is the window's first entry: the App passes its own, to map a click to an entry (release 5
// design, "Clicking").
export function Menu({ entries, chosen, rows, top: given }: { entries: Entry[]; chosen: number; rows: number; top?: { current: number } }) {
  const shown = Math.min(entries.length, Math.max(1, rows));
  const own = useRef(0);
  const top = given ?? own;
  const w = scroll(entries.length, shown, chosen, top.current);
  top.current = w.top;
  // Each note starts in one column, two spaces after the longest label among the entries on screen, not the rows counting
  // those cut off (TUI design pass, Task 11; audit 9).
  const drawn = entries.slice(w.top, w.top + shown);
  const labels = drawn.filter((_, i) => !(i === 0 && w.above) && !(i === shown - 1 && w.below));
  const wide = Math.max(0, ...labels.map((e) => stringWidth(visible(e.label))));
  return (
    <>
      {drawn.map((e, i) =>
        i === 0 && w.above ? (
          <Text key={i} dimColor>
            {"  "}↑ {w.above} more
          </Text>
        ) : i === shown - 1 && w.below ? (
          <Text key={i} dimColor>
            {"  "}↓ {w.below} more
          </Text>
        ) : (
          <Text key={i} wrap="truncate-end" color={e.error ? "red" : undefined}>
            {"  "}
            <Text inverse={w.top + i === chosen && !e.error}>{visible(e.label)}</Text>
            {e.note && <Text dimColor>{`${" ".repeat(wide - stringWidth(visible(e.label)) + 2)}${e.note}`}</Text>}
          </Text>
        ),
      )}
    </>
  );
}
