import type { Key } from "ink";
import type { Action } from "./editor.js";

// What a key means in the prompt (release 3 design, "Editing" and "Multi-line"), for the codes the
// user's terminal was seen to send on 2026-10-25. Enter sends; Up and Down move by screen row, which
// needs the screen's width, so App does them, and the rest of these App's own: Ctrl+R's search,
// Shift+Tab's permission mode, Alt+P's model list and Ctrl+O's last turn ("Menus and modes"), and
// Ctrl+T's to-do list (release 4 design, "On screen"); and scrolling the conversation (release 5 design, "Scrolling").
export type Command = Action | "submit" | "up" | "down" | "search" | "mode" | "models" | "lastTurn" | "todos" | Scroll;
export type Scroll = "pageUp" | "pageDown" | "top" | "bottom" | "lineUp" | "lineDown";
const SCROLLS = new Set<Command>(["pageUp", "pageDown", "top", "bottom", "lineUp", "lineDown"]);
export const isScroll = (c: Command): c is Scroll => SCROLLS.has(c);

// Ink names a key held with Ctrl or Alt by its letter.
// Ctrl+P and Ctrl+N are Up and Down, as in Claude Code.
const CTRL: Record<string, Command> = { a: "home", e: "end", d: "delete", w: "deleteToSpace", k: "deleteToEnd", u: "deleteToStart", y: "yank", z: "undo", p: "up", n: "down", r: "search", o: "lastTurn", t: "todos" };
const ALT: Record<string, Command> = { b: "wordLeft", f: "wordRight", d: "deleteWordAfter", p: "models" };

// What `?` on an empty prompt prints, grey, in the scrollback.
export const KEY_LIST = [
  "Keys:",
  "  Enter  send · Shift+Enter, \\ then Enter, or Ctrl+J  new line",
  "  Esc  stop the turn · Esc Esc  clear the prompt",
  "  Ctrl-C  stop the turn and take back the queue, or clear the prompt · twice when empty  exit",
  "  Ctrl-D twice on an empty prompt  exit",
  "  ↑ ↓ or Ctrl+P Ctrl+N  past prompts (↑ takes back a queue) · Ctrl+R  search them",
  "  Home End or Ctrl+A Ctrl+E  line start, end · Alt+B Alt+F or Ctrl+← Ctrl+→  by word",
  "  Ctrl+W  delete back to a space · Alt+Backspace  the word before · Alt+D  the word after",
  "  Ctrl+K  delete to the line's end · Ctrl+U  to its start · Ctrl+Y  put it back · Ctrl+Z  undo",
  "  /  commands · @  project paths · Shift+Tab  permission mode · Alt+P  pick the model",
  "  Ctrl+O  the last turn's tool calls in full · a space first starts a message with ?",
  "  Ctrl+T  show or hide the to-do list",
  "  PgUp PgDn  half a screen · Ctrl+Home Ctrl+End  top, latest · Shift+↑ Shift+↓  a line (full screen)",
];

export function commands(input: string, key: Key): Command[] {
  if (key.return) return [key.shift ? "newline" : "submit"]; // Shift+Enter only where the terminal tells it apart
  // Before the plain arrows and Home and End, which come with the same names and Shift or Ctrl held.
  if (key.pageUp) return ["pageUp"];
  if (key.pageDown) return ["pageDown"];
  if (key.home && key.ctrl) return ["top"];
  if (key.end && key.ctrl) return ["bottom"];
  if (key.upArrow && key.shift) return ["lineUp"];
  if (key.downArrow && key.shift) return ["lineDown"];
  if (key.upArrow) return ["up"];
  if (key.downArrow) return ["down"];
  if (key.leftArrow) return [key.ctrl ? "wordLeft" : "left"];
  if (key.rightArrow) return [key.ctrl ? "wordRight" : "right"];
  if (key.home) return ["home"];
  if (key.end) return ["end"];
  // Backspace, Ctrl+Backspace and Ctrl+H all come as Backspace; Alt+Backspace is told apart.
  if (key.backspace) return [key.meta ? "deleteWord" : "backspace"];
  if (key.delete) return ["delete"];
  if (key.tab && key.shift) return ["mode"];
  if (key.ctrl) return CTRL[input] ? [CTRL[input]] : [];
  if (key.meta) return ALT[input] ? [ALT[input]] : [];
  if (input === "\u001f") return ["undo"]; // Ctrl+_
  // Typed text. Keys typed fast enough arrive together, Enter among them: a carriage return sends,
  // a line feed (Ctrl+J) makes a new line, and other control characters are dropped.
  return input.split(/(\r|\n)/).flatMap((part): Command[] => {
    if (part === "\r") return ["submit"];
    if (part === "\n") return ["newline"];
    const text = part.replace(/\p{Cc}/gu, "");
    return text ? [{ type: "insert", text }] : [];
  });
}
