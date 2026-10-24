import type { Key } from "ink";
import type { Action } from "./editor.js";

// What a key means in the prompt (release 3 design, "Editing" and "Multi-line"), for the codes the
// user's terminal was seen to send on 2026-10-25. Enter sends; Up and Down move by screen row, which
// needs the screen's width, so App does them.
export type Command = Action | "submit" | "up" | "down";

// Ink names a key held with Ctrl or Alt by its letter.
const CTRL: Record<string, Action> = { a: "home", e: "end", d: "delete", w: "deleteToSpace", k: "deleteToEnd", u: "deleteToStart", y: "yank", z: "undo" };
const ALT: Record<string, Action> = { b: "wordLeft", f: "wordRight", d: "deleteWordAfter" };

export function commands(input: string, key: Key): Command[] {
  if (key.return) return [key.shift ? "newline" : "submit"]; // Shift+Enter only where the terminal tells it apart
  if (key.upArrow) return ["up"];
  if (key.downArrow) return ["down"];
  if (key.leftArrow) return [key.ctrl ? "wordLeft" : "left"];
  if (key.rightArrow) return [key.ctrl ? "wordRight" : "right"];
  if (key.home) return ["home"];
  if (key.end) return ["end"];
  // Backspace, Ctrl+Backspace and Ctrl+H all come as Backspace; Alt+Backspace is told apart.
  if (key.backspace) return [key.meta ? "deleteWord" : "backspace"];
  if (key.delete) return ["delete"];
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
