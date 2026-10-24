import type { Key } from "ink";
import { describe, expect, it } from "vitest";
import { commands } from "../../src/tui/keys.js";

// A key as Ink's useInput reports it: no flags but the ones given.
const key = (flags: Partial<Key> = {}): Key => ({
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
  ...flags,
});

describe("commands", () => {
  it("sends on Enter, and makes a new line on Shift+Enter where the terminal tells them apart", () => {
    expect(commands("\r", key({ return: true }))).toEqual(["submit"]);
    expect(commands("\r", key({ return: true, shift: true }))).toEqual(["newline"]);
  });

  it("makes a new line on Ctrl+J, which arrives as a line feed", () => {
    expect(commands("\n", key())).toEqual(["newline"]);
  });

  it("moves with the arrows, Home and End, Ctrl+A and Ctrl+E, and by word with Ctrl or Alt", () => {
    expect(commands("", key({ leftArrow: true }))).toEqual(["left"]);
    expect(commands("", key({ rightArrow: true }))).toEqual(["right"]);
    expect(commands("", key({ leftArrow: true, ctrl: true }))).toEqual(["wordLeft"]);
    expect(commands("", key({ rightArrow: true, ctrl: true }))).toEqual(["wordRight"]);
    expect(commands("", key({ home: true }))).toEqual(["home"]);
    expect(commands("", key({ end: true }))).toEqual(["end"]);
    expect(commands("a", key({ ctrl: true }))).toEqual(["home"]);
    expect(commands("e", key({ ctrl: true }))).toEqual(["end"]);
    expect(commands("b", key({ meta: true }))).toEqual(["wordLeft"]);
    expect(commands("f", key({ meta: true }))).toEqual(["wordRight"]);
    expect(commands("", key({ upArrow: true }))).toEqual(["up"]);
    expect(commands("", key({ downArrow: true }))).toEqual(["down"]);
  });

  it("deletes with the keys the user's terminal sends for them", () => {
    expect(commands("", key({ backspace: true }))).toEqual(["backspace"]); // Backspace, Ctrl+Backspace and Ctrl+H alike
    expect(commands("", key({ backspace: true, meta: true }))).toEqual(["deleteWord"]); // Alt+Backspace
    expect(commands("", key({ delete: true }))).toEqual(["delete"]);
    expect(commands("d", key({ ctrl: true }))).toEqual(["delete"]);
    expect(commands("w", key({ ctrl: true }))).toEqual(["deleteToSpace"]);
    expect(commands("d", key({ meta: true }))).toEqual(["deleteWordAfter"]);
    expect(commands("k", key({ ctrl: true }))).toEqual(["deleteToEnd"]);
    expect(commands("u", key({ ctrl: true }))).toEqual(["deleteToStart"]);
  });

  it("puts back with Ctrl+Y, and undoes with Ctrl+Z or Ctrl+_", () => {
    expect(commands("y", key({ ctrl: true }))).toEqual(["yank"]);
    expect(commands("z", key({ ctrl: true }))).toEqual(["undo"]);
    expect(commands("\u001f", key())).toEqual(["undo"]);
  });

  it("types text, and reads keys typed fast enough to arrive together one after another", () => {
    expect(commands("a", key())).toEqual([{ type: "insert", text: "a" }]);
    expect(commands("ab\rc", key())).toEqual([{ type: "insert", text: "ab" }, "submit", { type: "insert", text: "c" }]);
    expect(commands("a\nb", key())).toEqual([{ type: "insert", text: "a" }, "newline", { type: "insert", text: "b" }]);
  });

  it("does nothing for other keys and control characters", () => {
    expect(commands("q", key({ ctrl: true }))).toEqual([]);
    expect(commands("q", key({ meta: true }))).toEqual([]);
    expect(commands("", key({ tab: true }))).toEqual([]);
    expect(commands("", key({ escape: true }))).toEqual([]);
    expect(commands("a\u0007b", key())).toEqual([{ type: "insert", text: "ab" }]);
  });
});
