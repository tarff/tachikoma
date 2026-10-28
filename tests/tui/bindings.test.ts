import { createElement } from "react";
import { useInput } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import {
  Bindings,
  CHORD_MS,
  type Context,
  CONTEXTS,
  DEFAULTS,
  defaultsFor,
  keyText,
  parseKeys,
  RESERVED,
  type Stroke,
  strokeOf,
  tableOf,
} from "../../src/tui/bindings.js";

// Past Ink's wait before it reads a lone ESC as Esc, 20 ms (pendingInputFlushDelayMilliseconds in Ink's App.js). 25 ms is
// safe however busy the machine: Ink's timer is set first, inside the same write, and timers due earlier run first.
const tick = () => new Promise((r) => setTimeout(r, 25));
const k = (key: string, mods: Partial<Omit<Stroke, "key">> = {}): Stroke => ({ key, ctrl: false, alt: false, shift: false, ...mods });
const one = (text: string): Stroke => (parseKeys(text) as Stroke[])[0]!;
const empty = (): Record<Context, Map<string, string | null>> => Object.fromEntries(CONTEXTS.map((c) => [c, new Map()])) as never;

// What strokeOf makes of each read, through Ink's own useInput, so the Key it is given is the one Ink makes of the bytes.
// The test terminal hands Ink each write at once, on its own; only a lone ESC waits, to be told from the start of a longer
// sequence, and the next read must come after it is let go.
async function strokes(...reads: string[]): Promise<(Stroke | null)[]> {
  const seen: (Stroke | null)[] = [];
  const Probe = () => {
    useInput((input, key) => void seen.push(strokeOf(input, key)));
    return null;
  };
  const app = render(createElement(Probe));
  // useInput starts listening in its effects, which turn raw mode on, where Ink starts reading the terminal (Ink's App.js).
  while (app.stdin.listenerCount("readable") === 0) await tick();
  for (const read of reads) {
    app.stdin.write(read);
    if (read === "\u001b") await tick();
  }
  app.unmount();
  return seen;
}

describe("parseKeys", () => {
  it("reads every modifier by each of its names, case ignored", () => {
    for (const text of ["ctrl+k", "control+k", "CTRL+K", "Control+K"]) expect(parseKeys(text)).toEqual([k("k", { ctrl: true })]);
    for (const text of ["alt+p", "opt+p", "option+p", "meta+p", "Meta+P"]) expect(parseKeys(text)).toEqual([k("p", { alt: true })]);
    expect(parseKeys("ctrl+shift+c")).toEqual([k("c", { ctrl: true, shift: true })]);
    expect(parseKeys("shift+n")).toEqual([k("n", { shift: true })]);
    expect(parseKeys("N")).toEqual([k("n")]); // as in Claude Code: a capital is the letter; Shift is written out
  });

  it("names the special keys, with their other names", () => {
    expect(parseKeys("esc")).toEqual([k("escape")]);
    expect(parseKeys("Escape")).toEqual([k("escape")]);
    expect(parseKeys("return")).toEqual([k("enter")]);
    expect(parseKeys("shift+enter")).toEqual([k("enter", { shift: true })]);
    for (const name of ["tab", "space", "up", "down", "left", "right", "pageup", "pagedown", "home", "end", "backspace", "delete", "wheelup", "wheeldown"])
      expect(parseKeys(name)).toEqual([k(name)]);
    expect(parseKeys("ctrl+home")).toEqual([k("home", { ctrl: true })]);
    expect(parseKeys("[")).toEqual([k("[")]);
    expect(parseKeys("ctrl+_")).toEqual([k("_", { ctrl: true })]);
  });

  it("reads a chord as its strokes", () => {
    expect(parseKeys("ctrl+x ctrl+e")).toEqual([k("x", { ctrl: true }), k("e", { ctrl: true })]);
    expect(parseKeys("Ctrl+K  Ctrl+S")).toEqual([k("k", { ctrl: true }), k("s", { ctrl: true })]);
  });

  it("says what is wrong with a key it cannot read, quoting it as written", () => {
    expect(parseKeys("ctl+k")).toEqual({ problem: 'unknown modifier "ctl"' });
    expect(parseKeys("Ctl+K")).toEqual({ problem: 'unknown modifier "Ctl"' });
    expect(parseKeys("ctrl+ k")).toEqual({ problem: 'a space beside "+"' });
    expect(parseKeys("ctrl +k")).toEqual({ problem: 'a space beside "+"' });
    expect(parseKeys("ctrl+foo")).toEqual({ problem: 'unknown key "foo"' });
    expect(parseKeys("ctrl+Foo")).toEqual({ problem: 'unknown key "Foo"' });
    expect(parseKeys("cmd+k")).toEqual({ problem: 'Tachikoma has no "cmd" modifier' });
  });

  it("takes no name an object inherits for a key or a modifier", () => {
    expect(parseKeys("constructor")).toEqual({ problem: 'unknown key "constructor"' });
    expect(parseKeys("constructor+k")).toEqual({ problem: 'unknown modifier "constructor"' });
    expect(parseKeys("__proto__+k")).toEqual({ problem: 'unknown modifier "__proto__"' });
  });

  it("says plainly when a key is missing", () => {
    for (const text of ["", "   "]) expect(parseKeys(text)).toEqual({ problem: "no key" });
    for (const text of ["ctrl+", "+", "ctrl++"]) expect(parseKeys(text)).toEqual({ problem: 'a "+" with no key after it' });
    for (const text of ["+k", "ctrl++k"]) expect(parseKeys(text)).toEqual({ problem: 'a "+" with no modifier before it' });
  });

  it("writes strokes back in one spelling", () => {
    expect(keyText(parseKeys("Shift+Control+K Meta+P") as Stroke[])).toBe("ctrl+shift+k alt+p");
    expect(keyText(parseKeys("esc") as Stroke[])).toBe("escape");
  });

  it("reserves the keys Claude Code reserves", () => {
    expect(RESERVED).toEqual(["ctrl+c", "ctrl+d", "ctrl+m", "ctrl+[", "ctrl+i", "ctrl+h"].map(one));
  });
});

describe("strokeOf", () => {
  it("makes, for what Ink reports, the stroke the table's spelling of that key reads as", async () => {
    // Each read, and the key in the table's spelling, or null for no stroke.
    const cases: [string, string | null][] = [
      ["\u0003", "ctrl+c"],
      ["\u0004", "ctrl+d"],
      ["\u0014", "ctrl+t"],
      ["\u000f", "ctrl+o"],
      ["\r", "enter"],
      ["\u001b[13;2u", "shift+enter"], // where the terminal tells it apart (the kitty protocol)
      ["\n", "ctrl+j"], // a line feed
      ["\u001b[Z", "shift+tab"],
      ["\u001bp", "alt+p"],
      ["\u001a", "ctrl+z"],
      ["\u001f", "ctrl+_"],
      ["\u001b", "escape"],
      ["\u0012", "ctrl+r"],
      ["\u001b[A", "up"],
      ["\u001b[B", "down"],
      ["\u001b[D", "left"],
      ["\u001b[C", "right"],
      ["\u0010", "ctrl+p"],
      ["\u000e", "ctrl+n"],
      ["\u0007", "ctrl+g"], // the probe's Ctrl+G
      ["\u0013", "ctrl+s"], // the probe's Ctrl+S
      ["\u001bv", "alt+v"], // the probe's Alt+V
      ["\u0016", "ctrl+v"],
      ["\t", "tab"],
      ["y", "y"],
      ["n", "n"],
      ["q", "q"],
      ["[", "["],
      ["/", "/"],
      ["N", "shift+n"],
      ["\u001bN", "alt+shift+n"],
      ["j", "j"],
      ["k", "k"],
      ["g", "g"],
      ["G", "shift+g"],
      ["7", "7"],
      ["\u001b[H", "home"],
      ["\u001b[F", "end"],
      ["\u001b[5~", "pageup"],
      ["\u001b[6~", "pagedown"],
      ["\u001b[1;5H", "ctrl+home"],
      ["\u001b[1;5F", "ctrl+end"],
      ["\u001b[1;2A", "shift+up"],
      ["\u001b[1;2B", "shift+down"],
      [" ", "space"],
      ["\u007f", "backspace"],
      ["\b", "backspace"], // Ctrl+H, reserved for that
      ["\u001b[3~", "delete"],
      ["\u001c", "ctrl+\\"],
      ["\u001d", "ctrl+]"],
      ["\u001e", "ctrl+^"],
      ["\u0090", null], // a control character with no name
      ["\u001b[107;9u", null], // Super+K (the kitty protocol)
      ["\u001b[107;17u", null], // Hyper+K
      // Today's kitty differences, left as Ink gives them (strokeOf's comment).
      ["\u0000", "ctrl+`"], // Ctrl+Space on an ordinary terminal
      ["\u001b[32;5u", "ctrl+space"], // Ctrl+Space under kitty
      ["\u001b[45;6u", "ctrl+shift+-"], // Ctrl+_ under kitty
    ];
    expect(await strokes(...cases.map(([read]) => read))).toEqual(cases.map(([, text]) => (text === null ? null : one(text))));
  });

  it("makes the probe's Ctrl+X then Ctrl+E, two reads, two strokes", async () => {
    expect(await strokes("\u0018", "\u0005")).toEqual([one("ctrl+x"), one("ctrl+e")]);
  });

  it("makes no stroke of a paste, or of keys read together", async () => {
    expect(await strokes("\u001b[200~hello\u001b[201~", "yy", "a\r")).toEqual([null, null, null]);
  });
});

describe("Bindings.press", () => {
  const b = () => new Bindings(tableOf(DEFAULTS));
  const ctrl = (key: string) => k(key, { ctrl: true });

  it("takes the innermost context's binding first, then the outer ones", () => {
    expect(b().press(k("escape"), ["Autocomplete", "Chat", "Global"], 0)).toEqual({ action: "autocomplete:dismiss" });
    expect(b().press(k("escape"), ["Chat", "Global"], 0)).toEqual({ action: "chat:cancel" });
    expect(b().press(k("up"), ["Autocomplete", "Chat", "Global"], 0)).toEqual({ action: "autocomplete:previous" });
    expect(b().press(k("up"), ["Chat", "Global"], 0)).toEqual({ action: "history:previous" });
    expect(b().press(ctrl("r"), ["HistorySearch", "Global"], 0)).toEqual({ action: "historySearch:next" });
    expect(b().press(k("home"), ["Transcript", "Scroll", "Global"], 0)).toEqual({ action: "transcript:top" });
    expect(b().press(ctrl("home"), ["Transcript", "Scroll", "Global"], 0)).toEqual({ action: "scroll:top" });
    expect(b().press(ctrl("t"), ["Chat", "Global"], 0)).toEqual({ action: "app:toggleTodos" });
  });

  it("waits on a chord's first stroke, and gives its action on the second before 3 s are up", () => {
    const bindings = b();
    expect(bindings.press(ctrl("x"), ["Chat", "Global"], 1000)).toEqual({ pending: [ctrl("x")] });
    expect(bindings.waiting(1000 + CHORD_MS - 1)).toEqual([ctrl("x")]);
    expect(bindings.press(ctrl("e"), ["Chat", "Global"], 1000 + CHORD_MS - 1)).toEqual({ action: "chat:externalEditor" });
    expect(bindings.waiting(1000 + CHORD_MS - 1)).toBeNull();
  });

  it("drops a chord at 3 s, and reads the next stroke as if none had waited", () => {
    expect(CHORD_MS).toBe(3000);
    const bindings = b();
    bindings.press(ctrl("x"), ["Chat", "Global"], 1000);
    expect(bindings.waiting(4000)).toBeNull();
    expect(bindings.press(ctrl("e"), ["Chat", "Global"], 4000)).toBeNull(); // Ctrl+E alone is the editor's end of line
    bindings.press(ctrl("x"), ["Chat", "Global"], 5000);
    expect(bindings.press(ctrl("g"), ["Chat", "Global"], 8000)).toEqual({ action: "chat:externalEditor" });
  });

  it("drops a chord on a stroke that does not complete it, giving nothing, so the caller handles that stroke afresh", () => {
    const bindings = b();
    bindings.press(ctrl("x"), ["Chat", "Global"], 0);
    expect(bindings.press(ctrl("g"), ["Chat", "Global"], 100)).toBeNull();
    expect(bindings.waiting(100)).toBeNull();
    expect(bindings.press(ctrl("g"), ["Chat", "Global"], 100)).toEqual({ action: "chat:externalEditor" });
    bindings.press(ctrl("x"), ["Chat", "Global"], 200);
    expect(bindings.press(k("q"), ["Chat", "Global"], 300)).toBeNull();
    expect(bindings.press(k("q"), ["Chat", "Global"], 300)).toBeNull(); // typed, as no binding takes it
  });

  it("drops a chord started in one set of contexts and finished in another without it", () => {
    const bindings = b();
    bindings.press(ctrl("x"), ["Chat", "Global"], 0);
    expect(bindings.press(ctrl("e"), ["Confirmation", "Global"], 100)).toBeNull();
    expect(bindings.waiting(100)).toBeNull();
  });

  it("waits through a chord of three strokes", () => {
    const table = empty();
    table.Chat.set("ctrl+x ctrl+k ctrl+k", "chat:stash");
    const bindings = new Bindings(table);
    expect(bindings.press(ctrl("x"), ["Chat"], 0)).toEqual({ pending: [ctrl("x")] });
    expect(bindings.press(ctrl("k"), ["Chat"], 100)).toEqual({ pending: [ctrl("x"), ctrl("k")] });
    expect(bindings.press(ctrl("k"), ["Chat"], 200)).toEqual({ action: "chat:stash" });
  });

  it("hands out copies of a chord's strokes", () => {
    const bindings = b();
    const r = bindings.press(ctrl("x"), ["Chat", "Global"], 0) as { pending: Stroke[] };
    r.pending[0]!.key = "z";
    bindings.waiting(0)!.push(ctrl("y"));
    expect(bindings.waiting(0)).toEqual([ctrl("x")]);
  });

  it("gives nothing for a stroke that starts no chord and has no binding, so the editor's keys act", () => {
    for (const stroke of [k("a"), ctrl("a"), ctrl("e"), ctrl("k"), k("b", { alt: true })]) expect(b().press(stroke, ["Chat", "Global"], 0)).toBeNull();
    expect(b().press(k("y"), ["Chat", "Global"], 0)).toBeNull();
    expect(b().press(k("y"), ["Confirmation", "Global"], 0)).toEqual({ action: "confirm:yes" });
  });

  it("waits on a chord's prefix in any context in force, over a single key bound to it, until every chord on it is unbound", () => {
    const table = tableOf(DEFAULTS);
    table.Global.set("ctrl+x", "app:toggleTodos");
    expect(new Bindings(table).press(ctrl("x"), ["Autocomplete", "Chat", "Global"], 0)).toEqual({ pending: [ctrl("x")] });
    table.Chat.set("ctrl+x ctrl+e", null);
    expect(new Bindings(table).press(ctrl("x"), ["Autocomplete", "Chat", "Global"], 0)).toEqual({ action: "app:toggleTodos" });
  });

  it("does nothing for a key set to null in its context, even where an outer context binds it (choice 18)", () => {
    const table = tableOf(DEFAULTS);
    table.Chat.set("ctrl+s", null);
    table.Chat.set("ctrl+t", null);
    const bindings = new Bindings(table);
    expect(bindings.press(ctrl("s"), ["Chat", "Global"], 0)).toBeNull();
    expect(bindings.press(ctrl("t"), ["Chat", "Global"], 0)).toBeNull();
    expect(bindings.press(ctrl("t"), ["Transcript", "Global"], 0)).toEqual({ action: "app:toggleTodos" });
  });

  it("frees a chord's prefix where an inner context sets the chord to null, though an outer one binds it (choice 18)", () => {
    const table = empty();
    table.Global.set("ctrl+x ctrl+e", "app:toggleTodos");
    table.Chat.set("ctrl+x ctrl+e", null);
    const inner = new Bindings(table);
    expect(inner.press(ctrl("x"), ["Chat", "Global"], 0)).toBeNull();
    expect(inner.waiting(0)).toBeNull();
    table.Chat.set("ctrl+x", "chat:stash");
    expect(new Bindings(table).press(ctrl("x"), ["Chat", "Global"], 0)).toEqual({ action: "chat:stash" });
    const outer = new Bindings(table);
    expect(outer.press(ctrl("x"), ["Transcript", "Global"], 0)).toEqual({ pending: [ctrl("x")] });
    expect(outer.press(ctrl("e"), ["Transcript", "Global"], 1)).toEqual({ action: "app:toggleTodos" });
  });

  it("completes a chord the inner context binds, though an outer one sets it to null", () => {
    const table = empty();
    table.Chat.set("ctrl+x ctrl+e", "chat:externalEditor");
    table.Global.set("ctrl+x ctrl+e", null);
    const bindings = new Bindings(table);
    expect(bindings.press(ctrl("x"), ["Chat", "Global"], 0)).toEqual({ pending: [ctrl("x")] });
    expect(bindings.press(ctrl("e"), ["Chat", "Global"], 1)).toEqual({ action: "chat:externalEditor" });
  });

  it("reads a table's keys in any spelling", () => {
    const table = empty();
    table.Chat.set("Control+Shift+K", "chat:stash");
    table.Chat.set("Meta+P Esc", "chat:modelPicker");
    const bindings = new Bindings(table);
    expect(bindings.press(k("k", { ctrl: true, shift: true }), ["Chat"], 0)).toEqual({ action: "chat:stash" });
    expect(bindings.keysFor("chat:stash", "Chat")).toEqual(["ctrl+shift+k"]);
    expect(bindings.keysFor("chat:modelPicker", "Chat")).toEqual(["alt+p escape"]);
  });

  it("of two spellings of one key, takes the later's action, in the earlier's place", () => {
    const table = empty();
    table.Chat.set("Ctrl+G", "chat:undo");
    table.Chat.set("ctrl+s", "chat:stash");
    table.Chat.set("ctrl+g", "chat:stash");
    const bindings = new Bindings(table);
    expect(bindings.press(ctrl("g"), ["Chat"], 0)).toEqual({ action: "chat:stash" });
    expect(bindings.keysFor("chat:stash", "Chat")).toEqual(["ctrl+g", "ctrl+s"]);
    expect(bindings.keysFor("chat:undo", "Chat")).toEqual([]);
  });

  it("refuses a table with a key it cannot read, which the keys file's reader reports first", () => {
    const table = empty();
    table.Chat.set("ctl+k", "chat:stash");
    expect(() => new Bindings(table)).toThrow('Chat "ctl+k": unknown modifier "ctl"');
  });
});

describe("Bindings.keysFor", () => {
  it("lists an action's keys in a context, in the table's order", () => {
    const bindings = new Bindings(tableOf(DEFAULTS));
    expect(bindings.keysFor("chat:externalEditor", "Chat")).toEqual(["ctrl+g", "ctrl+x ctrl+e"]);
    expect(bindings.keysFor("chat:externalEditor", "Global")).toEqual([]);
  });
});

describe("DEFAULTS", () => {
  // Every action App handles today, in its context, with today's keys (plan, Task 5), and the new editor and stash keys.
  const today: [Context, string, string[]][] = [
    ["Global", "app:interrupt", ["ctrl+c"]],
    ["Global", "app:exit", ["ctrl+d"]],
    ["Global", "app:toggleTodos", ["ctrl+t"]],
    ["Global", "app:toggleTranscript", ["ctrl+o"]],
    ["Chat", "chat:submit", ["enter"]],
    ["Chat", "chat:newline", ["shift+enter", "ctrl+j"]],
    ["Chat", "chat:cycleMode", ["shift+tab"]],
    ["Chat", "chat:modelPicker", ["alt+p"]],
    ["Chat", "chat:undo", ["ctrl+z", "ctrl+_"]],
    ["Chat", "chat:cancel", ["escape"]],
    ["Chat", "history:search", ["ctrl+r"]],
    ["Chat", "history:previous", ["up", "ctrl+p"]],
    ["Chat", "history:next", ["down", "ctrl+n"]],
    ["Chat", "chat:externalEditor", ["ctrl+g", "ctrl+x ctrl+e"]],
    ["Chat", "chat:stash", ["ctrl+s"]],
    ["Autocomplete", "autocomplete:accept", ["tab"]],
    ["Autocomplete", "autocomplete:dismiss", ["escape"]],
    ["Autocomplete", "autocomplete:previous", ["up"]],
    ["Autocomplete", "autocomplete:next", ["down"]],
    ["Confirmation", "confirm:yes", ["y"]],
    ["Confirmation", "confirm:no", ["n", "escape"]],
    ["HistorySearch", "historySearch:next", ["ctrl+r"]],
    ["HistorySearch", "historySearch:accept", ["escape", "tab"]],
    ["HistorySearch", "historySearch:cancel", ["ctrl+c"]],
    ["HistorySearch", "historySearch:execute", ["enter"]],
    ["Select", "select:next", ["down"]],
    ["Select", "select:previous", ["up"]],
    ["Select", "select:accept", ["enter"]],
    ["Select", "select:cancel", ["escape"]],
    ["Transcript", "transcript:exit", ["q", "ctrl+c", "escape"]],
    ["Transcript", "transcript:print", ["["]],
    ["Transcript", "transcript:search", ["/"]],
    ["Transcript", "transcript:nextMatch", ["n"]],
    ["Transcript", "transcript:previousMatch", ["shift+n"]],
    ["Transcript", "transcript:lineDown", ["j", "down"]],
    ["Transcript", "transcript:lineUp", ["k", "up"]],
    ["Transcript", "transcript:top", ["g", "home"]],
    ["Transcript", "transcript:bottom", ["shift+g", "end"]],
    ["Scroll", "scroll:pageUp", ["pageup"]],
    ["Scroll", "scroll:pageDown", ["pagedown"]],
    ["Scroll", "scroll:top", ["ctrl+home"]],
    ["Scroll", "scroll:bottom", ["ctrl+end"]],
    ["Scroll", "scroll:lineUp", ["shift+up", "wheelup"]],
    ["Scroll", "scroll:lineDown", ["shift+down", "wheeldown"]],
  ];

  it("binds every action App handles today, on today's keys, and nothing else but picture pasting", () => {
    const bindings = new Bindings(tableOf(defaultsFor("win32", false)));
    for (const [context, action, keys] of today) expect(bindings.keysFor(action, context), `${context} ${action}`).toEqual(keys);
    const all = CONTEXTS.flatMap((c) => Object.values(defaultsFor("win32", false)[c]).map((a) => `${c} ${a}`));
    expect(new Set(all)).toEqual(new Set([...today.map(([c, a]) => `${c} ${a}`), "Chat chat:imagePaste"]));
  });

  it("pastes a picture on Alt+V on Windows, where Ctrl+V never arrives, on both on WSL, and on Ctrl+V elsewhere", () => {
    const paste = (platform: NodeJS.Platform, wsl: boolean) => new Bindings(tableOf(defaultsFor(platform, wsl))).keysFor("chat:imagePaste", "Chat");
    expect(paste("win32", false)).toEqual(["alt+v"]);
    expect(paste("linux", true)).toEqual(["alt+v", "ctrl+v"]);
    expect(paste("linux", false)).toEqual(["ctrl+v"]);
    expect(paste("darwin", false)).toEqual(["ctrl+v"]);
  });

  it("writes every key in the spelling the table gives back", () => {
    for (const c of CONTEXTS) for (const text of Object.keys(DEFAULTS[c])) expect(keyText(parseKeys(text) as Stroke[])).toBe(text);
  });
});
