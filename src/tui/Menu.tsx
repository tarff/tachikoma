import { Text } from "ink";
import { useRef } from "react";
import { visible } from "../core/permissions.js";
import { scroll } from "./layout.js";
import type { Entry } from "./menus.js";

// An open `/` or `@` menu, under the prompt, in `rows` rows: past that it scrolls with the chosen
// entry, as the prompt does with the cursor, the first and last rows counting the entries cut off.
export function Menu({ entries, chosen, rows }: { entries: Entry[]; chosen: number; rows: number }) {
  const shown = Math.min(entries.length, Math.max(1, rows));
  const top = useRef(0);
  const w = scroll(entries.length, shown, chosen, top.current);
  top.current = w.top;
  return (
    <>
      {entries.slice(w.top, w.top + shown).map((e, i) =>
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
            {e.note && <Text dimColor>{`  ${e.note}`}</Text>}
          </Text>
        ),
      )}
    </>
  );
}
