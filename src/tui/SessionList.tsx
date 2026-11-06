import { Box, Text, useInput, usePaste, useWindowSize } from "ink";
import { useRef, useState } from "react";
import type { Row } from "../core/sessions.js";
import { DRAFTS } from "./app/constants.js";
import { type Bindings, strokeOf } from "./bindings.js";
import { screen } from "./describe.js";
import { both, named, pieces } from "./keys.js";
import type { PickerKey } from "./ModelPicker.js";
import { k } from "./StatusLine.js";

// `tachi -r`'s list of this folder's saved sessions (release 8a design, "Resuming"; plan, choice 12): newest first, each
// row the session's name or first prompt, how long ago it was last used, its lead and its file's size. Up and Down move,
// Enter opens, Esc quits, as Select's keys are bound; Ctrl-C quits too. With `name`, only the sessions that name belongs
// to are listed, for a name more than one session has. Names and prompts are the user's text, so they are escaped.

// The header lines are Task 6's drafts, for the user's approval.
const heading = (name: string | undefined) =>
  name === undefined ? "Saved sessions in this folder, newest first:" : `Saved sessions named ${name}, newest first:`;

const MINUTE = 60_000;
// How long ago, in whole minutes, hours or days, as the status line writes how long a session has run (StatusLine.tsx,
// duration).
export function ago(ms: number): string {
  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 1) return "<1m ago";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

// One line of the user's text, escaped, for one row.
const shown = (text: string) => screen({ text, oneLine: true }).text;

export function SessionList({
  rows,
  name,
  now,
  bindings,
  onPick,
  onClose,
  keys,
  maxRows,
}: {
  rows: Row[]; // newest first (sessions.ts, listSessions)
  name?: string;
  now: number; // for how long ago each was used
  bindings: Bindings; // the table of keys, for Select's keys and the names the hint gives them
  onPick: (id: string) => void;
  onClose: () => void;
  // In the window, /resume's list (release 8a plan, choice 14): the App hands it the keys it finds in the table, as it
  // hands the model list its own (ModelPicker.tsx), so one stroke is looked up once; and the rows for the heading and the
  // sessions, the App's other rows drawn around them. Its Esc closes the list there, the session going on.
  keys?: { current: ((k: PickerKey) => void) | null };
  maxRows?: number;
}) {
  const { rows: tall } = useWindowSize();
  const listed = name === undefined ? rows : rows.filter((r) => r.name === name);
  // Each key reads and changes this at once, as in ModelPicker: several keys can arrive before the screen is drawn again.
  const state = useRef({ at: 0, first: 0, done: false });
  const s = state.current;
  const [, redraw] = useState(0);

  const act = (a: string | null) => {
    if (s.done) return;
    if (a === "select:previous") s.at = Math.max(0, s.at - 1);
    else if (a === "select:next") s.at = Math.min(listed.length - 1, s.at + 1);
    else if (a === "select:accept" && listed[s.at]) {
      s.done = true;
      return onPick(listed[s.at]!.id);
    } else if (a === "select:cancel" || a === "app:interrupt") {
      s.done = true;
      return onClose();
    } else return;
    redraw((n) => n + 1);
  };
  // A paste is dropped: Ink would otherwise give it to useInput as keys, as Review.tsx says of its own screen.
  usePaste(() => {});
  useInput((input, key) => {
    const single = strokeOf(input, key);
    const each = single ? [single] : key.ctrl || key.meta ? [] : pieces(input).map((p) => strokeOf(p, p === "\r" ? { ...key, return: true } : key));
    for (const stroke of each) {
      const got = stroke && bindings.press(stroke, ["Select", "Global"], Date.now());
      if (!got || !("pending" in got)) act(got?.action ?? null);
    }
  }, { isActive: keys === undefined });
  // Typed text has nothing to go into here.
  if (keys) keys.current = (k) => act(typeof k === "object" && "action" in k ? k.action : null);

  // The keys' names, from the bindings, as ModelPicker's hint names them; a part with no key is left out.
  const key = (action: string, usual: string) => named(bindings, action, "Select", [usual])[0];
  const moves = both(key("select:previous", "up"), key("select:next", "down"));
  const [enter, esc] = [key("select:accept", "enter"), key("select:cancel", "escape")];
  const hint = [moves && `${moves} move`, enter && `${enter} opens`, esc && `${esc} ${keys ? DRAFTS.closes : "quits"}`].filter(Boolean).join(" · ");

  // The list in the rows between the heading and the hint, its window moved only as far as keeps the chosen row in it.
  const room = Math.max(1, (maxRows ?? tall - 2) - 1); // the terminal's rows, less the one Ink ends on and the hint's
  if (s.at < s.first) s.first = s.at;
  if (s.at >= s.first + room) s.first = s.at - room + 1;
  // The columns after the label line up, each as wide as its widest entry.
  const cells = listed.map((r) => [ago(now - r.changed.getTime()), shown(r.lead), `${k(r.size)} bytes`] as const);
  const width = (i: number) => Math.max(0, ...cells.map((c) => c[i]!.length));
  const [w0, w1, w2] = [width(0), width(1), width(2)];
  return (
    <>
      <Text wrap="truncate-end">{shown(heading(name))}</Text>
      {listed.slice(s.first, s.first + room).map((r, i) => {
        const [when, lead, size] = cells[s.first + i]!;
        const chosen = s.first + i === s.at;
        return (
          <Box key={r.id} height={1}>
            <Box flexGrow={1} flexShrink={1}>
              <Text inverse={chosen} wrap="truncate-end">
                {shown(r.name ?? r.firstPrompt)}
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text inverse={chosen}>{`  ${when.padEnd(w0)}  ${lead.padEnd(w1)}  ${size.padStart(w2)}`}</Text>
            </Box>
          </Box>
        );
      })}
      <Text color="gray" wrap="truncate-end">
        {hint}
      </Text>
    </>
  );
}
