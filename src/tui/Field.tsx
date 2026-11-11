import { Text, usePaste } from "ink";
import { useRef, useState } from "react";
import { visible } from "../core/permissions.js";
import type { Field as FormField } from "../mcp/forms.js";
import type { Bindings } from "./bindings.js";
import { segmenter } from "./editor.js";
import { both, named } from "./keys.js";
import { Menu } from "./Menu.js";
import type { PickerKey } from "./ModelPicker.js";

// One field of a server's form, in the prompt's place (release 8c plan, Task 12; choice 29): the server's description of
// it grey above it, then its question with what is typed after it, and for a pick the server's labels as a menu under it.
// The App hands it the picker phase's keys, as /mcp's list gets them (McpList.tsx): typed text and a paste go in,
// Backspace takes the last character away, Up and Down move in a pick, Space marks one of a pick of several, Enter
// answers, Esc declines the form. forms.ts checks the answer and asks the field again with it when it is wrong. A pick
// ends with its hint row, as /mcp's lists do (choice 51), the keys named from the bindings; Space is no binding, so it is
// named as it is (the user's choice, 2026-11-11).

// The field being asked, and where its answer goes: what was typed, the values picked, or null for Esc. `id` gives each ask
// a Field of its own (App.tsx), so a field asked again starts from `given`.
export interface Asked {
  id: number;
  field: FormField;
  given?: string | string[];
  done: (answer: string | string[] | null) => void;
}

export function Field({
  asked,
  bindings,
  keys,
  rows,
  full,
}: {
  asked: Asked;
  bindings: Bindings; // the table of keys, for the names the hint gives Select's keys
  keys: { current: ((k: PickerKey) => void) | null };
  rows: number; // the rows it may draw, as the App's frame gives them
  full: boolean;
}) {
  const { field, given } = asked;
  const pick = field.kind === "pick" ? field : null;
  const from = Array.isArray(given) ? given : (pick?.start ?? []);
  // Each key reads and changes `state` at once, as in McpList: several keys can arrive before the screen is drawn again.
  const state = useRef({
    text: typeof given === "string" ? given : field.kind === "pick" ? "" : field.start,
    at: Math.max(0, pick?.options.findIndex((o) => o.value === from[0]) ?? 0),
    marked: new Set(pick?.multi ? from : []),
    done: false,
  });
  const s = state.current;
  const [, redraw] = useState(0);
  const answer = (a: string | string[] | null) => {
    if (s.done) return;
    s.done = true;
    asked.done(a);
  };
  // One row of text: a line break typed or pasted is a space, and other control characters are dropped, as the detail
  // view's search drops them.
  const add = (text: string) => {
    if (!pick) s.text += text.replace(/\r\n?|\n/g, " ").replace(/\p{Cc}/gu, "");
  };
  const picked = () => (pick ? pick.options.filter((o) => s.marked.has(o.value)) : []);
  usePaste((text) => {
    add(text);
    redraw((n) => n + 1);
  });
  keys.current = (k) => {
    if (s.done) return;
    if (k === "backspace") s.text = s.text.slice(0, [...segmenter.segment(s.text)].at(-1)?.index ?? 0);
    else if ("text" in k) {
      const o = pick?.options[s.at];
      if (pick?.multi && k.text === " " && o) {
        if (!s.marked.delete(o.value)) s.marked.add(o.value);
      } else add(k.text);
    } else if (pick && (k.action === "select:previous" || k.action === "select:next")) {
      s.at = Math.max(0, Math.min(pick.options.length - 1, s.at + (k.action === "select:next" ? 1 : -1)));
    } else if (k.action === "select:accept") {
      const chosen = pick?.options[s.at];
      return answer(!pick ? s.text : pick.multi ? picked().map((o) => o.value) : chosen ? [chosen.value] : []);
    } else if (k.action === "select:cancel") return answer(null);
    else return;
    redraw((n) => n + 1);
  };

  const typed = pick ? picked().map((o) => o.label).join(", ") : s.text;
  const noteRows = field.note === undefined ? 0 : 1;
  const key = (action: string, usual: string) => named(bindings, action, "Select", [usual])[0];
  const moves = both(key("select:previous", "up"), key("select:next", "down"));
  const [enter, esc] = [key("select:accept", "enter"), key("select:cancel", "escape")];
  const hint = [moves && `${moves} move`, pick?.multi && "Space marks", enter && `${enter} answers`, esc && `${esc} declines the form`]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      {field.note !== undefined && (
        <Text color="gray" wrap="truncate-end">
          {field.note}
        </Text>
      )}
      {/* In full screen one row, its end kept, where the typing is. */}
      <Text wrap={full ? "truncate-start" : "wrap"}>
        {field.question}
        {visible(typed)}
        {!pick && <Text inverse> </Text>}
      </Text>
      {pick && <Menu entries={pick.options.map((o) => ({ label: o.label, fill: o.value }))} chosen={s.at} rows={Math.max(1, rows - noteRows - 2)} />}
      {pick && (
        <Text color="gray" wrap="truncate-end">
          {hint}
        </Text>
      )}
    </>
  );
}
