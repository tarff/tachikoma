// The prompt editor as plain data (release 3 design, "How it is built"): `apply` takes the editor and
// one action and gives the new editor. Which key is which action is App's business, so every edit is
// tested here by feeding actions in.

export interface Editor {
  readonly text: string;
  readonly cursor: number; // a place between characters, as an index into `text`
  readonly undo: readonly { text: string; cursor: number }[]; // the states before each step, newest last
  readonly typing: boolean; // the last step was typing, so more typing joins it
  readonly killed: string; // what the last word or line delete took, for Ctrl+Y
}

export const empty: Editor = { text: "", cursor: 0, undo: [], typing: false, killed: "" };

export type Action =
  | { type: "insert"; text: string } // typed
  | { type: "paste"; text: string }
  | "newline"
  | "left"
  | "right"
  | "home" // the start of the line the cursor is on
  | "end"
  | "wordLeft"
  | "wordRight"
  | "backspace"
  | "delete"
  | "deleteToSpace" // Ctrl+W: back to the space before
  | "deleteWord" // Alt+Backspace: the word before
  | "deleteWordAfter" // Alt+D
  | "deleteToEnd" // Ctrl+K: to the end of the line
  | "deleteToStart" // Ctrl+U: to its start
  | "yank" // Ctrl+Y: put back what the last word or line delete took
  | "undo"; // Ctrl+Z or Ctrl+_

// A new prompt holding `text`, with the cursor at its end and nothing to undo. What the last delete
// took is kept, as a terminal's line editor keeps it from one command to the next.
export function load(e: Editor, text: string): Editor {
  return { ...empty, text, cursor: text.length, killed: e.killed };
}

export const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// The places between characters as the screen shows them, so an emoji made of several code points
// is passed over and deleted as one.
function boundaries(text: string): number[] {
  return [...[...segmenter.segment(text)].map((s) => s.index), text.length];
}
const before = (text: string, i: number) => boundaries(text).findLast((b) => b < i) ?? 0;
const after = (text: string, i: number) => boundaries(text).find((b) => b > i) ?? text.length;

// GNU Readline's words: letters and digits (with their accents, which are code points of their own).
const wordChar = (c: string) => /[\p{L}\p{N}\p{M}]/u.test(c);
const space = (c: string) => /\s/u.test(c);

// Back over characters that are not `inWord`, then over those that are, a character as the screen
// shows it, so the cursor never lands inside one. Each is judged by its first code point.
function back(text: string, i: number, inWord: (c: string) => boolean): number {
  const b = boundaries(text);
  let k = b.findLastIndex((x) => x < i); // the character before `i` starts at b[k]
  const char = () => String.fromCodePoint(text.codePointAt(b[k]!)!);
  while (k >= 0 && !inWord(char())) k--;
  while (k >= 0 && inWord(char())) k--;
  return b[k + 1]!;
}
function forward(text: string, i: number, inWord: (c: string) => boolean): number {
  const b = boundaries(text);
  let k = b.findIndex((x) => x >= i); // the character after `i` starts at b[k]
  const char = () => String.fromCodePoint(text.codePointAt(b[k]!)!);
  while (k < b.length - 1 && !inWord(char())) k++;
  while (k < b.length - 1 && inWord(char())) k++;
  return b[k]!;
}

// At 0 there is no line before: lastIndexOf would read -1 as 0 and find a line break there.
const lineStart = (text: string, i: number) => (i === 0 ? 0 : text.lastIndexOf("\n", i - 1) + 1);
const lineEnd = (text: string, i: number) => (text.indexOf("\n", i) + 1 || text.length + 1) - 1;

// One step: the text between `from` and `to` replaced. Typing joins the step before when that was
// typing too; everything else is a step of its own. A step that changes nothing is none.
function change(e: Editor, from: number, to: number, insert: string, how: { typing?: boolean; kill?: boolean } = {}): Editor {
  if (from === to && !insert) return { ...e, typing: false };
  const joins = how.typing === true && e.typing;
  return {
    text: e.text.slice(0, from) + insert + e.text.slice(to),
    cursor: from + insert.length,
    undo: joins ? e.undo : [...e.undo, { text: e.text, cursor: e.cursor }],
    typing: how.typing === true,
    killed: how.kill ? e.text.slice(from, to) : e.killed,
  };
}

const move = (e: Editor, cursor: number): Editor => ({ ...e, cursor, typing: false });

export function apply(e: Editor, a: Action): Editor {
  const { text, cursor: c } = e;
  if (typeof a === "object") return change(e, c, c, a.text, { typing: a.type === "insert" });
  switch (a) {
    case "newline":
      return change(e, c, c, "\n", { typing: true });
    case "left":
      return move(e, before(text, c));
    case "right":
      return move(e, after(text, c));
    case "home":
      return move(e, lineStart(text, c));
    case "end":
      return move(e, lineEnd(text, c));
    case "wordLeft":
      return move(e, back(text, c, wordChar));
    case "wordRight":
      return move(e, forward(text, c, wordChar));
    case "backspace":
      return change(e, before(text, c), c, "");
    case "delete":
      return change(e, c, after(text, c), "");
    case "deleteToSpace":
      return change(e, back(text, c, (ch) => !space(ch)), c, "", { kill: true });
    case "deleteWord":
      return change(e, back(text, c, wordChar), c, "", { kill: true });
    case "deleteWordAfter":
      return change(e, c, forward(text, c, wordChar), "", { kill: true });
    case "deleteToEnd": {
      const end = lineEnd(text, c);
      return change(e, c, end === c ? Math.min(text.length, c + 1) : end, "", { kill: true }); // at the end, the line break
    }
    case "deleteToStart": {
      const start = lineStart(text, c);
      return change(e, start === c ? Math.max(0, c - 1) : start, c, "", { kill: true });
    }
    case "yank":
      return change(e, c, c, e.killed);
    case "undo": {
      const last = e.undo.at(-1);
      return last ? { ...e, ...last, undo: e.undo.slice(0, -1), typing: false } : { ...e, typing: false };
    }
  }
}
