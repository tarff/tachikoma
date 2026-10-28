import type { Key } from "ink";
import { describe, expect, it } from "vitest";
import { Bindings, DEFAULTS, tableOf } from "../../src/tui/bindings.js";
import { commands, keyList, named, pieces, vimKey } from "../../src/tui/keys.js";

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
  });

  it("deletes with the keys the user's terminal sends for them", () => {
    expect(commands("", key({ backspace: true }))).toEqual(["backspace"]); // Backspace, Ctrl+Backspace and Ctrl+H alike
    expect(commands("", key({ backspace: true, meta: true }))).toEqual(["deleteWord"]); // Alt+Backspace
    expect(commands("", key({ delete: true }))).toEqual(["delete"]);
    expect(commands("w", key({ ctrl: true }))).toEqual(["deleteToSpace"]);
    expect(commands("d", key({ meta: true }))).toEqual(["deleteWordAfter"]);
    expect(commands("k", key({ ctrl: true }))).toEqual(["deleteToEnd"]);
    expect(commands("u", key({ ctrl: true }))).toEqual(["deleteToStart"]);
  });

  it("puts back with Ctrl+Y", () => {
    expect(commands("y", key({ ctrl: true }))).toEqual(["yank"]);
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

  // The keys the table holds are its actions' (release 6 design, "Bindings come first"; plan, Task 6), so a key the
  // keys file unbinds does nothing, and none of them comes here.
  it("gives nothing for the keys in the table", () => {
    expect(commands("\r", key({ return: true }))).toEqual([]); // Enter
    expect(commands("\r", key({ return: true, shift: true }))).toEqual([]); // Shift+Enter
    expect(commands("\n", key())).toEqual([]); // Ctrl+J, a line feed alone
    expect(commands("", key({ tab: true, shift: true }))).toEqual([]); // Shift+Tab
    expect(commands("p", key({ meta: true }))).toEqual([]); // Alt+P
    for (const letter of ["o", "t", "r", "p", "n", "z", "d"]) expect(commands(letter, key({ ctrl: true }))).toEqual([]);
    expect(commands("\u001f", key())).toEqual([]); // Ctrl+_
    expect(commands("", key({ upArrow: true }))).toEqual([]);
    expect(commands("", key({ downArrow: true }))).toEqual([]);
    expect(commands("", key({ pageUp: true }))).toEqual([]);
    expect(commands("", key({ pageDown: true }))).toEqual([]);
    expect(commands("", key({ upArrow: true, shift: true }))).toEqual([]);
    expect(commands("", key({ downArrow: true, shift: true }))).toEqual([]);
  });

  // Release 4's Home and End, read with Ctrl held: Ctrl+Home and Ctrl+End reach here only in classic mode, where
  // Scroll is never in force (plan, Task 6), and in the model list, where these keys do nothing.
  it("takes Ctrl+Home and Ctrl+End as Home and End", () => {
    expect(commands("", key({ home: true, ctrl: true }))).toEqual(["home"]);
    expect(commands("", key({ end: true, ctrl: true }))).toEqual(["end"]);
  });
});

describe("the keys named in help and hints", () => {
  const defaults = () => new Bindings(tableOf(DEFAULTS));
  // The default table with `keys` laid over one context's: bindings added, moved or set to null.
  const over = (context: keyof typeof DEFAULTS, keys: Record<string, string | null>) =>
    new Bindings(tableOf({ ...DEFAULTS, [context]: { ...DEFAULTS[context], ...keys } }));

  it("names the key today's words name while it is bound to the action, else the first key bound, else none", () => {
    expect(named(defaults(), "confirm:no", "Confirmation", ["escape"])).toEqual(["Esc"]);
    expect(named(defaults(), "historySearch:accept", "HistorySearch", ["tab"])).toEqual(["Tab"]);
    expect(named(defaults(), "transcript:exit", "Transcript", ["q", "escape"])).toEqual(["q", "Esc"]);
    expect(named(defaults(), "transcript:bottom", "Transcript", ["shift+g", "end"])).toEqual(["G", "End"]);
    expect(named(over("Transcript", { q: null }), "transcript:exit", "Transcript", ["q", "escape"])).toEqual(["Esc"]);
    expect(named(over("Confirmation", { escape: null }), "confirm:no", "Confirmation", ["escape"])).toEqual(["n"]);
    expect(named(over("Chat", { escape: null, "ctrl+q": "chat:cancel" }), "chat:cancel", "Chat", ["escape"])).toEqual(["Ctrl+Q"]);
    expect(named(over("Chat", { escape: null }), "chat:cancel", "Chat", ["escape"])).toEqual([]);
    expect(named(defaults(), "chat:externalEditor", "Chat", ["ctrl+x ctrl+e"])).toEqual(["Ctrl+X Ctrl+E"]);
  });

  // `?`'s list, word for word as release 5 wrote it by hand (plan, Task 6, test 1).
  it("lists the keys with the default table in release 5's words", () => {
    expect(keyList(defaults())).toEqual([
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
    ]);
  });

  it("lists the keys a table binds in place of the defaults", () => {
    const list = keyList(over("Chat", { "ctrl+n": null, enter: null, "alt+enter": "chat:submit", "ctrl+j": null }));
    expect(list[1]).toBe("  Alt+Enter  send · Shift+Enter or \\ then Alt+Enter  new line");
    expect(list[5]).toBe("  ↑ ↓ or Ctrl+P  past prompts (↑ takes back a queue) · Ctrl+R  search them");
  });

  it("leaves out a line whose only action has no key", () => {
    const list = keyList(over("Global", { "ctrl+t": null }));
    expect(list).toHaveLength(keyList(defaults()).length - 1);
    expect(list.join("\n")).not.toContain("to-do list");
    expect(list).not.toContain("  ");
  });
});

// Release 6 plan, Task 21: vim mode's keys.
describe("vim mode's keys", () => {
  it("splits text read together into one key a character, Enter and Ctrl+J apart, other control characters dropped", () => {
    expect(pieces("dw")).toEqual(["d", "w"]);
    expect(pieces("a\r\nb")).toEqual(["a", "\r", "\n", "b"]);
    expect(pieces("e\u{301}")).toEqual(["e\u{301}"]); // e with a combining accent: one character on screen
    expect(pieces("\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}")).toEqual(["\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}"]);
    expect(pieces("x\u{7}y")).toEqual(["x", "y"]);
  });

  it("names a key for vim: a character as typed, a named key by its name, none held with Ctrl or Alt but Esc", () => {
    expect(vimKey("k", key({ ctrl: true }))).toBeNull();
    expect(vimKey("b", key({ meta: true }))).toBeNull();
    expect(vimKey("", key({ escape: true, meta: true }))).toBe("escape"); // two Escs read together
    expect(vimKey(" ", key())).toBe(" ");
    expect(vimKey("A", key({ shift: true }))).toBe("A");
    expect(vimKey("", key({ upArrow: true }))).toBe("up");
    expect(vimKey("e\u{301}", key())).toBe("e\u{301}");
    expect(vimKey("dw", key())).toBeNull();
  });
});
