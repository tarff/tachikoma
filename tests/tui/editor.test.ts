import { describe, expect, it } from "vitest";
import { type Action, apply, type Editor, empty, load } from "../../src/tui/editor.js";

// The text with the cursor shown as "|".
const show = (e: Editor) => `${e.text.slice(0, e.cursor)}|${e.text.slice(e.cursor)}`;
// An editor holding `text`, with "|" marking the cursor.
const at = (text: string) => ({ ...load(empty, text.replace("|", "")), cursor: text.indexOf("|") });
const run = (e: Editor, ...actions: Action[]) => actions.reduce(apply, e);
const typed = (text: string): Action => ({ type: "insert", text });

describe("editor", () => {
  it("types at the cursor", () => {
    expect(show(run(empty, typed("ab"), "left", typed("x")))).toBe("ax|b");
  });

  it("moves by character, past a character made of several code points as one", () => {
    expect(show(run(at("a👍🏽b|"), "left", "left"))).toBe("a|👍🏽b");
    expect(show(run(at("|ab"), "left"))).toBe("|ab");
    expect(show(run(at("ab|"), "right"))).toBe("ab|");
  });

  it("goes to the start and end of the line the cursor is on", () => {
    expect(show(run(at("one\ntw|o\nthree"), "home"))).toBe("one\n|two\nthree");
    expect(show(run(at("one\ntw|o\nthree"), "end"))).toBe("one\ntwo|\nthree");
  });

  it("moves by word, a word being letters and digits", () => {
    expect(show(run(at("|foo-bar baz9"), "wordRight"))).toBe("foo|-bar baz9");
    expect(show(run(at("|foo-bar baz9"), "wordRight", "wordRight", "wordRight"))).toBe("foo-bar baz9|");
    expect(show(run(at("foo-bar baz9|"), "wordLeft"))).toBe("foo-bar |baz9");
    expect(show(run(at("foo-bar |baz9"), "wordLeft"))).toBe("foo-|bar baz9");
    expect(show(run(at("café| x"), "wordLeft"))).toBe("|café x");
  });

  it("moves and deletes by word without splitting a character made of several code points", () => {
    const heart = "\u2764\uFE0F"; // a heart and the mark asking for it in colour
    expect(show(run(at(`hi ${heart}|`), "wordLeft"))).toBe(`|hi ${heart}`);
    expect(show(run(at(`|${heart} hi`), "wordRight"))).toBe(`${heart} hi|`);
    expect(show(run(at(`hi ${heart}|`), "deleteWord"))).toBe("|");
  });

  it("stays at the very start before a line break, for Home and Ctrl+U", () => {
    expect(show(run(at("|\nhello"), "home"))).toBe("|\nhello");
    expect(show(run(at("|\nhello"), "deleteToStart"))).toBe("|\nhello");
  });

  it("deletes the character before or after the cursor", () => {
    expect(show(run(at("ab|c"), "backspace"))).toBe("a|c");
    expect(show(run(at("ab|c"), "delete"))).toBe("ab|");
    expect(show(run(at("a👍🏽|b"), "backspace"))).toBe("a|b");
    expect(show(run(at("|ab"), "backspace"))).toBe("|ab");
    expect(show(run(at("ab|"), "delete"))).toBe("ab|");
  });

  it("deletes back to a space with Ctrl+W, and the word before with Alt+Backspace", () => {
    expect(show(run(at("git commit-msg  |"), "deleteToSpace"))).toBe("git |");
    expect(show(run(at("git commit-msg|"), "deleteWord"))).toBe("git commit-|");
  });

  it("deletes the word after the cursor", () => {
    expect(show(run(at("a |foo-bar"), "deleteWordAfter"))).toBe("a |-bar");
  });

  it("deletes to the end and to the start of the line, and the line break when there is nothing else", () => {
    expect(show(run(at("one\ntw|o\nthree"), "deleteToEnd"))).toBe("one\ntw|\nthree");
    expect(show(run(at("one\ntw|o\nthree"), "deleteToStart"))).toBe("one\n|o\nthree");
    expect(show(run(at("one|\ntwo"), "deleteToEnd"))).toBe("one|two");
    expect(show(run(at("one\n|two"), "deleteToStart"))).toBe("one|two");
  });

  it("puts back the text the last word or line delete took, but not a single character", () => {
    const e = run(at("hello world|"), "deleteToSpace", "home");
    expect(show(run(e, "yank"))).toBe("world|hello ");
    expect(show(run(e, "backspace", "end", "yank"))).toBe("hello world|"); // Backspace at the start deleted nothing
    expect(show(run(at("ab|"), "backspace", "yank"))).toBe("a|");
  });

  it("undoes a run of typing as one step, and each delete, paste and put-back as one", () => {
    const e = run(empty, typed("a"), typed("b"), typed(" "), typed("c"), "left", typed("d"), "backspace", { type: "paste", text: "P" }, "yank");
    expect(show(e)).toBe("ab P|c");
    const undone = [1, 2, 3, 4, 5].map((n) => show(run(e, ...Array<Action>(n).fill("undo"))));
    // The put-back had nothing to put back, so it was no step; then the paste, the Backspace, the
    // typed "d", and the first run of typing; then nothing more, at the start of the prompt.
    expect(undone).toEqual(["ab |c", "ab d|c", "ab |c", "|", "|"]);
  });

  it("puts a new line at the cursor, as part of typing", () => {
    const e = run(empty, typed("a"), "newline", typed("b"));
    expect(show(e)).toBe("a\nb|");
    expect(show(run(e, "undo"))).toBe("|");
  });

  it("starts a loaded prompt with the cursor at its end, nothing to undo, and the last deleted text kept", () => {
    const e = load(run(at("x yz|"), "deleteToSpace"), "two\nlines");
    expect(show(e)).toBe("two\nlines|");
    expect(show(run(e, "undo"))).toBe("two\nlines|");
    expect(show(run(e, "yank"))).toBe("two\nlinesyz|");
  });
});
