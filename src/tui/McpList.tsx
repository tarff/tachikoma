import { Text, usePaste } from "ink";
import { useEffect, useRef, useState } from "react";
import { visible } from "../core/permissions.js";
import type { Servers } from "../mcp/servers.js";
import { shownFile } from "../settings.js";
import { SESSION_WORDS } from "./app/constants.js";
import type { Bindings } from "./bindings.js";
import { both, named } from "./keys.js";
import type { PickerKey } from "./ModelPicker.js";

// `/mcp` (release 8c plan, Task 10; design, "What the user sees"; choice 27): the servers, a row each, in the prompt's
// place; Enter shows the chosen server's actions, only those that apply, under its row; Esc goes back, then closes. Up and
// Down move, as Select's keys are bound; the App hands it the keys it finds in the table, as /resume's list gets its own
// (SessionList.tsx). Sign in and Sign out are Task 11's. The words are the plan's ("Lines this plan adds").

export type Listed = ReturnType<Servers["list"]>[number];
export const ACTIONS = ["Reconnect", "Show tools", "Reset my answer"] as const;
export type Action = (typeof ACTIONS)[number];

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

// One server's row: its name, " (project)" for a project's, its state, then its trust; escaped whole, as the name comes
// from the settings and a reason from the server or the system.
export function mcpRow(s: Listed): string {
  const st = s.state;
  const state =
    st.is === "ready" ? count(s.tools, "tool")
    : st.is === "failed" || st.is === "stopped" ? `${st.is}: ${st.reason}`
    : st.is === "off" ? "off: the sandbox's network is off"
    : st.is;
  const trust = s.trusted === "read-only" ? " · trusted" : s.trustedTools.length ? ` · ${count(s.trustedTools.length, "trusted tool")}` : "";
  return visible(`${s.name}${s.where === "project" ? " (project)" : ""} · ${state}${trust}`);
}

// What applies to a server: Reconnect to one that was started, whatever came of it; Show tools to one whose tools are
// offered, a remote one whose connection dropped among them, as its next call connects it again (choices 13 and 33);
// Reset my answer to a project's server the user has answered.
export function actionsOf(s: Listed, answered: boolean): Action[] {
  const st = s.state;
  return [
    ...(st.is === "ready" || st.is === "failed" || st.is === "stopped" ? (["Reconnect"] as const) : []),
    ...(st.is === "ready" || (st.is === "stopped" && st.retry) ? (["Show tools"] as const) : []),
    ...(s.where === "project" && answered ? (["Reset my answer"] as const) : []),
  ];
}

export function McpList({
  servers,
  bindings,
  onAction,
  onClose,
  keys,
  maxRows,
}: {
  servers: Pick<Servers, "list" | "answered" | "watch">;
  bindings: Bindings; // the table of keys, for the names the hint gives Select's keys
  onAction: (name: string, action: Action) => void; // Reconnect keeps the list open, at the servers; the others close it
  onClose: () => void;
  keys: { current: ((k: PickerKey) => void) | null };
  maxRows: number; // the rows for the heading and the list, as SessionList's: the App's frame adds one for the hint
}) {
  // Each key reads and changes `state` at once, as in SessionList: several keys can arrive before the screen is drawn
  // again. `server`: the one whose actions are shown.
  const state = useRef<{ at: number; first: number; server: string | null; action: number; done: boolean }>({ at: 0, first: 0, server: null, action: 0, done: false });
  const s = state.current;
  const [, redraw] = useState(0);
  // Drawn again at each change of a server's state, as a start ending, which may say no line, so a row follows it with
  // no key pressed (Servers, watch).
  useEffect(() => servers.watch(() => redraw((n) => n + 1)), [servers]);
  // A server's row and its actions now, or none for one a live edit removed, or a change left with nothing to do.
  const opened = (name: string | null) => {
    const row = name === null ? undefined : servers.list().find((r) => r.name === name);
    const actions = row ? actionsOf(row, servers.answered(row.name)) : [];
    return row && actions.length ? { row, actions } : null;
  };

  const act = (a: string | null) => {
    if (s.done) return;
    const list = servers.list();
    const o = opened(s.server);
    if (!o) {
      s.server = null;
      if (a === "select:previous") s.at = Math.max(0, s.at - 1);
      else if (a === "select:next") s.at = Math.min(list.length - 1, s.at + 1);
      else if (a === "select:accept" && opened(list[s.at]?.name ?? null)) {
        s.server = list[s.at]!.name;
        s.action = 0;
      } else if (a === "select:cancel") {
        s.done = true;
        return onClose();
      } else return;
    } else {
      if (a === "select:previous") s.action = Math.max(0, s.action - 1);
      else if (a === "select:next") s.action = Math.min(o.actions.length - 1, s.action + 1);
      else if (a === "select:accept") {
        const action = o.actions[Math.min(s.action, o.actions.length - 1)]!;
        s.server = null;
        if (action !== "Reconnect") s.done = true;
        return onAction(o.row.name, action);
      } else if (a === "select:cancel") s.server = null;
      else return;
    }
    redraw((n) => n + 1);
  };
  // A paste is dropped: Ink would otherwise give it to the App's keys, as SessionList says of its own.
  usePaste(() => {});
  // Typed text has nothing to go into here.
  keys.current = (k) => act(typeof k === "object" && "action" in k ? k.action : null);

  // The keys' names, from the bindings, as SessionList's hint names them; a part with no key is left out (choice 51).
  const key = (action: string, usual: string) => named(bindings, action, "Select", [usual])[0];
  const moves = both(key("select:previous", "up"), key("select:next", "down"));
  const [enter, esc] = [key("select:accept", "enter"), key("select:cancel", "escape")];
  const hint = (opens: string, closes: string) =>
    [moves && `${moves} move`, enter && `${enter} ${opens}`, esc && `${esc} ${closes}`].filter(Boolean).join(" · ");

  // The heading, then the rows in the room left, the window moved only as far as keeps the chosen row in it, then the
  // hint. Read at each drawing; a live edit can remove servers while the list is open.
  const list = servers.list();
  s.at = Math.max(0, Math.min(s.at, list.length - 1));
  const o = opened(s.server);
  const room = Math.max(1, maxRows - 1);
  const rows = o ? o.actions : list.map(mcpRow);
  const at = o ? Math.min(s.action, o.actions.length - 1) : s.at;
  if (s.at < s.first) s.first = s.at;
  if (s.at >= s.first + room) s.first = s.at - room + 1;
  const first = o ? Math.max(0, at - room + 1) : s.first;
  return (
    <>
      <Text wrap="truncate-end">{o ? mcpRow(o.row) : `MCP servers, from ${shownFile()} and .mcp.json:`}</Text>
      {rows.slice(first, first + room).map((row, i) => (
        <Text key={i} inverse={first + i === at} wrap="truncate-end">
          {row}
        </Text>
      ))}
      <Text color="gray" wrap="truncate-end">
        {o ? hint("runs", "back") : hint("opens", SESSION_WORDS.closes)}
      </Text>
    </>
  );
}
