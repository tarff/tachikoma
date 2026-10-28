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
    expect(commands("p", key({ ctrl: true }))).toEqual(["up"]);
    expect(commands("n", key({ ctrl: true }))).toEqual(["down"]);
  });

  it("shows or hides the to-do list with Ctrl+T", () => {
    expect(commands("t", key({ ctrl: true }))).toEqual(["todos"]);
  });

  it("searches the history with Ctrl+R", () => {
    expect(commands("r", key({ ctrl: true }))).toEqual(["search"]);
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

describe("commands for the modes, the model list and the last turn", () => {
  it("switches the permission mode on Shift+Tab, which arrives as Tab with Shift", () => {
    expect(commands("", key({ tab: true, shift: true }))).toEqual(["mode"]);
    expect(commands("", key({ tab: true }))).toEqual([]); // Tab alone is the menus'
  });

  it("opens the model list on Alt+P, and shows the last turn's tool calls on Ctrl+O", () => {
    expect(commands("p", key({ meta: true }))).toEqual(["models"]);
    expect(commands("o", key({ ctrl: true }))).toEqual(["lastTurn"]);
  });
});

describe("commands for scrolling the conversation", () => {
  // As Ink's parse-keypress reads ESC[5~, ESC[6~, ESC[1;5H, ESC[1;5F, ESC[1;2A and ESC[1;2B (release 5 plan, "Before you start").
  it("scrolls by half a screen on PgUp and PgDn, to the top and the latest on Ctrl+Home and Ctrl+End, and a line on Shift+Up and Shift+Down", () => {
    expect(commands("", key({ pageUp: true }))).toEqual(["pageUp"]);
    expect(commands("", key({ pageDown: true }))).toEqual(["pageDown"]);
    expect(commands("", key({ home: true, ctrl: true }))).toEqual(["top"]);
    expect(commands("", key({ end: true, ctrl: true }))).toEqual(["bottom"]);
    expect(commands("", key({ upArrow: true, shift: true }))).toEqual(["lineUp"]);
    expect(commands("", key({ downArrow: true, shift: true }))).toEqual(["lineDown"]);
  });

  it("leaves plain Up, Down, Home and End to the prompt", () => {
    expect(commands("", key({ upArrow: true }))).toEqual(["up"]);
    expect(commands("", key({ downArrow: true }))).toEqual(["down"]);
    expect(commands("", key({ home: true }))).toEqual(["home"]);
    expect(commands("", key({ end: true }))).toEqual(["end"]);
  });
});
