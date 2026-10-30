import type { Key } from "ink";
import { describe, expect, it } from "vitest";
import { readKeybindings } from "../../src/keybindings.js";
import { Bindings, DEFAULTS, defaultsFor, tableOf } from "../../src/tui/bindings.js";
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

  // `?`'s list, word for word as release 5 wrote it by hand (plan, Task 6, test 1), with release 6's editor, stash and
  // picture keys after the to-do list's. Windows' table, so the picture key is the same on every machine.
  it("lists the keys with the default table in release 5's words", () => {
    expect(keyList(new Bindings(tableOf(defaultsFor("win32", false))))).toEqual([
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
      "  Ctrl+G or Ctrl+X Ctrl+E  open the prompt in your editor",
      "  Ctrl+S  stash the prompt or bring it back · Alt+V  paste a picture",
      "  PgUp PgDn  half a screen · Ctrl+Home Ctrl+End  top, latest · Shift+↑ Shift+↓  a line (full screen)",
    ]);
  });

  // Final review: where Esc goes to vim first (INSERT), the first Esc only goes to NORMAL (choice 31). A key held with
  // Ctrl never goes to vim.
  it("names Esc twice to stop the turn and three times to clear the prompt where Esc goes to vim first", () => {
    expect(keyList(defaults(), undefined, true)).toContain("  Esc Esc  stop the turn · Esc Esc Esc  clear the prompt");
    expect(keyList(over("Chat", { escape: null, "ctrl+q": "chat:cancel" }), undefined, true)).toContain(
      "  Ctrl+Q  stop the turn · Ctrl+Q Ctrl+Q  clear the prompt",
    );
  });

  // Release 6 plan, Task 23: the editor, stash and picture keys name every key bound to them, as the command keys do.
  it("lists the picture key each system binds: Ctrl+V on macOS and Linux, both under WSL", () => {
    const pictures = (platform: NodeJS.Platform, wsl: boolean) => keyList(new Bindings(tableOf(defaultsFor(platform, wsl))));
    expect(pictures("darwin", false)).toContain("  Ctrl+S  stash the prompt or bring it back · Ctrl+V  paste a picture");
    expect(pictures("linux", false)).toContain("  Ctrl+S  stash the prompt or bring it back · Ctrl+V  paste a picture");
    expect(pictures("linux", true)).toContain("  Ctrl+S  stash the prompt or bring it back · Alt+V or Ctrl+V  paste a picture");
  });

  it("lists a key the keys file adds to the editor, and leaves out stash and picture keys set to null", () => {
    // The terminal checklist's step 3: ctrl+e bound to chat:externalEditor in the keys file.
    const read = readKeybindings(JSON.stringify({ bindings: [{ context: "Chat", bindings: { "ctrl+e": "chat:externalEditor" } }] }));
    if ("problem" in read) throw new Error(read.problem);
    expect(keyList(read.table)).toContain("  Ctrl+G, Ctrl+X Ctrl+E, or Ctrl+E  open the prompt in your editor");
    const list = keyList(over("Chat", { "ctrl+s": null, "alt+v": null, "ctrl+v": null }));
    expect(list.join("\n")).not.toContain("stash");
    expect(list.join("\n")).not.toContain("picture");
    expect(keyList(over("Chat", { "ctrl+g": null, "ctrl+x ctrl+e": null })).join("\n")).not.toContain("your editor");
  });

  it("lists editor, stash and picture keys bound under Global too", () => {
    const list = keyList(over("Global", { "ctrl+q": "chat:externalEditor", "ctrl+b": "chat:stash", "alt+i": "chat:imagePaste" }));
    expect(list).toContain("  Ctrl+G, Ctrl+X Ctrl+E, or Ctrl+Q  open the prompt in your editor");
    expect(list.join("\n")).toMatch(/Ctrl\+S or Ctrl\+B {2}stash the prompt or bring it back · .* or Alt\+I {2}paste a picture/);
  });

  // Release 6 plan, Task 23's code review: a key is listed for an action only where the prompt runs that action on it.
  it("leaves out a key whose binding at the prompt is not the action: null in Chat over Global's, or a chord's first key", () => {
    const both = (chat: Record<string, string | null>, global: Record<string, string | null>) =>
      new Bindings(tableOf({ ...DEFAULTS, Chat: { ...DEFAULTS.Chat, ...chat }, Global: { ...DEFAULTS.Global, ...global } }));
    // Ctrl+S set to null in Chat does nothing at the prompt, though Global binds it to chat:stash (choice 18).
    expect(keyList(both({ "ctrl+s": null }, { "ctrl+s": "chat:stash" })).join("\n")).not.toContain("stash");
    // The same for a command key, and for the to-do list's Ctrl+T.
    expect(keyList(both({ "ctrl+q": null }, { "ctrl+q": "command:vim" })).join("\n")).not.toContain("/vim");
    expect(keyList(both({ "ctrl+t": null }, {})).join("\n")).not.toContain("to-do list");
    // Ctrl+G waits for a chord's next key once a chord starts with it, so it no longer opens the editor alone.
    expect(keyList(both({ "ctrl+g ctrl+s": "chat:stash" }, {}))).toContain("  Ctrl+X Ctrl+E  open the prompt in your editor");
  });

  // Release 6 plan, Task 23 (the spec review): an editing key a binding takes no longer edits, so `?` does not name it.
  it("leaves out of the editing keys' lines a key a Chat or Global binding takes, and a part with none left", () => {
    // The terminal checklist's step 3: Ctrl+E opens the editor, so it is no longer the line's end.
    const read = readKeybindings(JSON.stringify({ bindings: [{ context: "Chat", bindings: { "ctrl+e": "chat:externalEditor" } }] }));
    if ("problem" in read) throw new Error(read.problem);
    // The pair's key left gets its own words: Ctrl+A goes only to the line's start.
    const startOnly = "  Home End  line start, end · Ctrl+A  line start · Alt+B Alt+F or Ctrl+← Ctrl+→  by word";
    expect(keyList(read.table)).toContain(startOnly);
    expect(keyList(over("Global", { "ctrl+e": "app:toggleTodos" }))).toContain(startOnly);
    // A lone Home, a lone Alt+B and a lone Ctrl+→, the other of each pair taken.
    expect(keyList(over("Chat", { end: "chat:stash" }))).toContain("  Ctrl+A Ctrl+E  line start, end · Home  line start · Alt+B Alt+F or Ctrl+← Ctrl+→  by word");
    expect(keyList(over("Chat", { "alt+f": "chat:stash" }))).toContain("  Home End or Ctrl+A Ctrl+E  line start, end · Ctrl+← Ctrl+→  by word · Alt+B  a word left");
    expect(keyList(over("Chat", { "ctrl+left": "chat:stash" }))).toContain("  Home End or Ctrl+A Ctrl+E  line start, end · Alt+B Alt+F  by word · Ctrl+→  a word right");
    // Ctrl+K taken, by a key or by the first of a chord's keys: Ctrl+U's words then name the line themselves.
    for (const keys of [{ "ctrl+k": "chat:stash" }, { "ctrl+k ctrl+s": "chat:stash" }] as Record<string, string>[]) {
      expect(keyList(over("Chat", keys))).toContain("  Ctrl+U  delete to the line's start · Ctrl+Y  put it back · Ctrl+Z  undo");
    }
    const taken = keyList(over("Chat", { home: "chat:stash", end: "chat:stash", "alt+backspace": "chat:stash", "alt+d": "chat:stash", "ctrl+w": "chat:stash" }));
    expect(taken).toContain("  Ctrl+A Ctrl+E  line start, end · Alt+B Alt+F or Ctrl+← Ctrl+→  by word");
    expect(taken.join("\n")).not.toMatch(/delete back to a space|the word before|the word after/);
    // A key set to null in Chat frees it there, so Global's binding of it does not take it at the prompt (choice 18).
    const freed = new Bindings(tableOf({ ...DEFAULTS, Chat: { ...DEFAULTS.Chat, "ctrl+w": null }, Global: { ...DEFAULTS.Global, "ctrl+w": "app:toggleTodos" } }));
    expect(keyList(freed)).toContain("  Ctrl+W  delete back to a space · Alt+Backspace  the word before · Alt+D  the word after");
    // A key left alone keeps its verb: Ctrl+W taken, Alt+Backspace deletes; both taken, Alt+D deletes.
    const ctrlW = readKeybindings(JSON.stringify({ bindings: [{ context: "Chat", bindings: { "ctrl+w": "chat:stash" } }] }));
    if ("problem" in ctrlW) throw new Error(ctrlW.problem);
    expect(keyList(ctrlW.table)).toContain("  Alt+Backspace  delete the word before · Alt+D  the word after");
    expect(keyList(over("Chat", { "ctrl+w": "chat:stash", "alt+backspace": "chat:stash" }))).toContain("  Alt+D  delete the word after");
    // Ctrl+K and Ctrl+U both taken: Ctrl+Y says what it puts back.
    expect(keyList(over("Chat", { "ctrl+k": "chat:stash", "ctrl+u": "chat:stash" }))).toContain("  Ctrl+Y  put back the last delete · Ctrl+Z  undo");
  });

  // In full screen the prompt obeys Chat, Scroll and Global (app/constants.ts, contextsOf), so a Scroll binding takes
  // an editing key there; in classic mode, Chat and Global, Scroll is not in force.
  it("leaves out an editing key a Scroll binding takes only when asked with Scroll's context, as in full screen", () => {
    const b = over("Scroll", { end: "scroll:bottom" });
    expect(keyList(b, ["Chat", "Scroll", "Global"])).toContain("  Ctrl+A Ctrl+E  line start, end · Home  line start · Alt+B Alt+F or Ctrl+← Ctrl+→  by word");
    expect(keyList(b, ["Chat", "Global"])).toContain("  Home End or Ctrl+A Ctrl+E  line start, end · Alt+B Alt+F or Ctrl+← Ctrl+→  by word");
  });

  // The Scroll line names full screen's keys, where a Chat binding wins over Scroll's, so classic mode leaves it out too.
  it("in classic mode leaves out of the Scroll line a key a Chat binding takes in full screen", () => {
    const list = keyList(over("Chat", { pageup: "chat:stash" }));
    expect(list).toContain("  Ctrl+S or PgUp  stash the prompt or bring it back · Alt+V  paste a picture");
    expect(list).toContain("  PgDn  half a screen · Ctrl+Home Ctrl+End  top, latest · Shift+↑ Shift+↓  a line (full screen)");
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
