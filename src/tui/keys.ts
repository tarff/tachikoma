import type { Key } from "ink";
import { type Bindings, type Context, parseKeys, type Stroke } from "./bindings.js";
import type { Action } from "./editor.js";

// What a key means in the prompt (release 3 design, "Editing" and "Multi-line"), for the codes the
// user's terminal was seen to send on 2026-10-25. Enter sends; Up and Down move by screen row, which
// needs the screen's width, so App does them, and the rest of these App's own: Ctrl+R's search,
// Shift+Tab's permission mode, Alt+P's model list and Ctrl+O's last turn ("Menus and modes"), and
// Ctrl+T's to-do list (release 4 design, "On screen"); and scrolling the conversation (release 5 design, "Scrolling").
// The keys for all but the editor's own come from the table of actions (bindings.ts; App.tsx, ACTIONS).
export type Command = Action | "submit" | "up" | "down" | "search" | "mode" | "models" | "lastTurn" | "todos" | Scroll;
export type Scroll = "pageUp" | "pageDown" | "top" | "bottom" | "lineUp" | "lineDown";
const SCROLLS = new Set<Command>(["pageUp", "pageDown", "top", "bottom", "lineUp", "lineDown"]);
export const isScroll = (c: Command): c is Scroll => SCROLLS.has(c);

// Ink names a key held with Ctrl or Alt by its letter.
const CTRL: Record<string, Command> = { a: "home", e: "end", w: "deleteToSpace", k: "deleteToEnd", u: "deleteToStart", y: "yank" };
const ALT: Record<string, Command> = { b: "wordLeft", f: "wordRight", d: "deleteWordAfter" };

// How help and hints spell a key: "Ctrl+R", "Shift+↑", "PgUp", a letter alone as typed ("q", "G").
const SPELLED: Record<string, string> = {
  escape: "Esc",
  enter: "Enter",
  tab: "Tab",
  space: "Space",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  pageup: "PgUp",
  pagedown: "PgDn",
  home: "Home",
  end: "End",
  backspace: "Backspace",
  delete: "Delete",
  wheelup: "Wheel up",
  wheeldown: "Wheel down",
};
const spelled = (text: string) =>
  (parseKeys(text) as Stroke[])
    .map((s) =>
      !s.ctrl && !s.alt && [...s.key].length === 1
        ? s.shift
          ? s.key.toUpperCase()
          : s.key
        : [s.ctrl && "Ctrl", s.alt && "Alt", s.shift && "Shift", SPELLED[s.key] ?? s.key.toUpperCase()].filter(Boolean).join("+"),
    )
    .join(" ");

// The keys a hint or help names for an action: each of `usual`, the keys release 5's words name, still bound to it, or
// with none of them, its first key bound, or none, so the words stay release 5's with the default table and a rebind
// never leaves them stale (plan, Task 6, test 1: the same words).
export function named(b: Bindings, action: string, context: Context, usual: string[]): string[] {
  const bound = b.keysFor(action, context);
  const kept = usual.filter((k) => bound.includes(k));
  return (kept.length ? kept : bound.slice(0, 1)).map(spelled);
}

// "a", "a or b", "a, b, or c".
const either = (items: string[]) => (items.length < 3 ? items.join(" or ") : `${items.slice(0, -1).join(", ")}, or ${items.at(-1)}`);

// What `?` on an empty prompt prints, grey, in the scrollback: the editor's own keys as written, the rest from the
// table. Ctrl-C and Ctrl-D are reserved (bindings.ts, RESERVED), so they are written as release 5 wrote them.
export function keyList(b: Bindings): string[] {
  const k = (action: string, context: Context, ...usual: string[]) => named(b, action, context, usual);
  const scroll = (action: string, usual: string) => k(`scroll:${action}`, "Scroll", usual)[0];
  // A part of a line: its keys, then what they do, or nothing when no key is bound.
  const part = (keys: (string | undefined)[], words: string, join = (bound: string[]) => bound.join(" ")) => {
    const bound = keys.filter((x) => x !== undefined);
    return bound.length > 0 && `${join(bound)}  ${words}`;
  };
  const line = (...parts: (string | false)[]) => `  ${parts.filter(Boolean).join(" · ")}`;
  const [submit] = k("chat:submit", "Chat", "enter");
  const [cancel] = k("chat:cancel", "Chat", "escape");
  const [newline, ...newlines] = k("chat:newline", "Chat", "shift+enter", "ctrl+j");
  const previous = k("history:previous", "Chat", "up", "ctrl+p");
  const next = k("history:next", "Chat", "down", "ctrl+n");
  // "↑ ↓ or Ctrl+P Ctrl+N": each Up key beside its Down key.
  const pairs = Array.from({ length: Math.max(previous.length, next.length) }, (_, i) => [previous[i], next[i]].filter(Boolean).join(" "));
  return [
    "Keys:",
    line(part([submit], "send"), part([newline, submit && `\\ then ${submit}`, ...newlines], "new line", either)),
    line(part([cancel], "stop the turn"), part([cancel && `${cancel} ${cancel}`], "clear the prompt")),
    "  Ctrl-C  stop the turn and take back the queue, or clear the prompt · twice when empty  exit",
    "  Ctrl-D twice on an empty prompt  exit",
    line(
      part(pairs, `past prompts${previous[0] ? ` (${previous[0]} takes back a queue)` : ""}`, (bound) => bound.join(" or ")),
      part(k("history:search", "Chat", "ctrl+r"), "search them"),
    ),
    "  Home End or Ctrl+A Ctrl+E  line start, end · Alt+B Alt+F or Ctrl+← Ctrl+→  by word",
    "  Ctrl+W  delete back to a space · Alt+Backspace  the word before · Alt+D  the word after",
    line("Ctrl+K  delete to the line's end", "Ctrl+U  to its start", "Ctrl+Y  put it back", part(k("chat:undo", "Chat", "ctrl+z"), "undo")),
    line(
      "/  commands",
      "@  project paths",
      part(k("chat:cycleMode", "Chat", "shift+tab"), "permission mode"),
      part(k("chat:modelPicker", "Chat", "alt+p"), "pick the model"),
    ),
    line(part(k("app:toggleTranscript", "Global", "ctrl+o"), "the last turn's tool calls in full"), "a space first starts a message with ?"),
    line(part(k("app:toggleTodos", "Global", "ctrl+t"), "show or hide the to-do list")),
    line(
      part([scroll("pageUp", "pageup"), scroll("pageDown", "pagedown")], "half a screen"),
      part([scroll("top", "ctrl+home"), scroll("bottom", "ctrl+end")], "top, latest"),
      part([scroll("lineUp", "shift+up"), scroll("lineDown", "shift+down")], "a line (full screen)"),
    ),
  ];
}

export function commands(input: string, key: Key): Command[] {
  // Enter and a line feed alone (Ctrl+J) are chat:submit's and chat:newline's; typed together with text, below, they
  // still send and make a new line.
  if (key.return || input === "\n") return [];
  if (key.leftArrow) return [key.ctrl ? "wordLeft" : "left"];
  if (key.rightArrow) return [key.ctrl ? "wordRight" : "right"];
  if (key.home) return ["home"];
  if (key.end) return ["end"];
  // Backspace, Ctrl+Backspace and Ctrl+H all come as Backspace; Alt+Backspace is told apart.
  if (key.backspace) return [key.meta ? "deleteWord" : "backspace"];
  if (key.delete) return ["delete"];
  if (key.ctrl) return CTRL[input] ? [CTRL[input]] : [];
  if (key.meta) return ALT[input] ? [ALT[input]] : [];
  // Typed text. Keys typed fast enough arrive together, Enter among them: a carriage return sends,
  // a line feed (Ctrl+J) makes a new line, and other control characters are dropped.
  return input.split(/(\r|\n)/).flatMap((part): Command[] => {
    if (part === "\r") return ["submit"];
    if (part === "\n") return ["newline"];
    const text = part.replace(/\p{Cc}/gu, "");
    return text ? [{ type: "insert", text }] : [];
  });
}
