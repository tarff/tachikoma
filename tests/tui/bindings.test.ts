import { createElement } from "react";
import { useInput } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import {
  Bindings,
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

// Past Ink's wait before it reads a lone ESC as Esc, 20 ms (pendingInputFlushDelayMilliseconds in Ink's App.js).
const tick = () => new Promise((r) => setTimeout(r, 25));
const k = (key: string, mods: Partial<Omit<Stroke, "key">> = {}): Stroke => ({ key, ctrl: false, alt: false, shift: false, ...mods });
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

  it("says what is wrong with a key it cannot read", () => {
    expect(parseKeys("ctl+k")).toEqual({ problem: 'unknown modifier "ctl"' });
    expect(parseKeys("Ctl+K")).toEqual({ problem: 'unknown modifier "Ctl"' });
    expect(parseKeys("ctrl+ k")).toEqual({ problem: 'a space beside "+"' });
    expect(parseKeys("ctrl +k")).toEqual({ problem: 'a space beside "+"' });
    expect(parseKeys("ctrl+foo")).toEqual({ problem: 'unknown key "foo"' });
    expect(parseKeys("cmd+k")).toEqual({ problem: 'Tachikoma has no "cmd" modifier' });
  });

  it("writes strokes back in one spelling", () => {
    expect(keyText(parseKeys("Shift+Control+K Meta+P") as Stroke[])).toBe("ctrl+shift+k alt+p");
    expect(keyText(parseKeys("esc") as Stroke[])).toBe("escape");
  });

  it("reserves the keys Claude Code reserves", () => {
    expect(RESERVED).toEqual(["ctrl+c", "ctrl+d", "ctrl+m", "ctrl+[", "ctrl+i", "ctrl+h"].map((t) => (parseKeys(t) as Stroke[])[0]));
  });
});

describe("strokeOf", () => {
  it("makes the stroke for what Ink reports for each default key", async () => {
    const cases: [string, Stroke][] = [
      ["\u0003", k("c", { ctrl: true })],
      ["\u0004", k("d", { ctrl: true })],
      ["\u0014", k("t", { ctrl: true })],
      ["\u000f", k("o", { ctrl: true })],
      ["\r", k("enter")],
      ["\u001b[13;2u", k("enter", { shift: true })], // Shift+Enter where the terminal tells it apart (the kitty protocol)
      ["\n", k("j", { ctrl: true })], // Ctrl+J, a line feed
      ["\u001b[Z", k("tab", { shift: true })],
      ["\u001bp", k("p", { alt: true })],
      ["\u001a", k("z", { ctrl: true })],
      ["\u001f", k("_", { ctrl: true })],
      ["\u001b", k("escape")],
      ["\u0012", k("r", { ctrl: true })],
      ["\u001b[A", k("up")],
      ["\u001b[B", k("down")],
      ["\u0010", k("p", { ctrl: true })],
      ["\u000e", k("n", { ctrl: true })],
      ["\u0007", k("g", { ctrl: true })], // the probe's Ctrl+G
      ["\u0013", k("s", { ctrl: true })], // the probe's Ctrl+S
      ["\u001bv", k("v", { alt: true })], // the probe's Alt+V
      ["\u0016", k("v", { ctrl: true })],
      ["\t", k("tab")],
      ["y", k("y")],
      ["n", k("n")],
      ["q", k("q")],
      ["[", k("[")],
      ["/", k("/")],
      ["N", k("n", { shift: true })],
      ["j", k("j")],
      ["k", k("k")],
      ["g", k("g")],
      ["G", k("g", { shift: true })],
      ["\u001b[H", k("home")],
      ["\u001b[F", k("end")],
      ["\u001b[5~", k("pageup")],
      ["\u001b[6~", k("pagedown")],
      ["\u001b[1;5H", k("home", { ctrl: true })],
      ["\u001b[1;5F", k("end", { ctrl: true })],
      ["\u001b[1;2A", k("up", { shift: true })],
      ["\u001b[1;2B", k("down", { shift: true })],
      [" ", k("space")],
    ];
    expect(await strokes(...cases.map(([read]) => read))).toEqual(cases.map(([, stroke]) => stroke));
  });

  it("makes the probe's Ctrl+X then Ctrl+E, two reads, two strokes", async () => {
    expect(await strokes("\u0018", "\u0005")).toEqual([k("x", { ctrl: true }), k("e", { ctrl: true })]);
  });

  it("makes no stroke of a paste, or of keys read together", async () => {
    expect(await strokes("\u001b[200~hello\u001b[201~", "yy", "a\r")).toEqual([null, null, null]);
  });

  it("every stroke it makes matches the same key written in the table", async () => {
    const [ctrlG, altV, shiftN] = await strokes("\u0007", "\u001bv", "N");
    expect(keyText([ctrlG!])).toBe("ctrl+g");
    expect(keyText([altV!])).toBe("alt+v");
    expect(keyText([shiftN!])).toBe("shift+n");
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

  it("waits on a chord's first stroke, and gives its action on the second within 3 s", () => {
    const bindings = b();
    expect(bindings.press(ctrl("x"), ["Chat", "Global"], 1000)).toEqual({ pending: [ctrl("x")] });
    expect(bindings.waiting(3999)).toEqual([ctrl("x")]);
    expect(bindings.press(ctrl("e"), ["Chat", "Global"], 4000)).toEqual({ action: "chat:externalEditor" });
    expect(bindings.waiting(4000)).toBeNull();
  });

  it("drops a chord after 3 s, and reads the next stroke as if none had waited", () => {
    const bindings = b();
    bindings.press(ctrl("x"), ["Chat", "Global"], 1000);
    expect(bindings.waiting(4001)).toBeNull();
    expect(bindings.press(ctrl("e"), ["Chat", "Global"], 4001)).toBeNull(); // Ctrl+E alone is the editor's end of line
    bindings.press(ctrl("x"), ["Chat", "Global"], 5000);
    expect(bindings.press(ctrl("g"), ["Chat", "Global"], 8001)).toEqual({ action: "chat:externalEditor" });
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

  it("takes no action for a key set to null, and looks on in the outer contexts", () => {
    const table = tableOf(DEFAULTS);
    table.Chat.set("ctrl+s", null);
    expect(new Bindings(table).press(ctrl("s"), ["Chat", "Global"], 0)).toBeNull();
    table.Global.set("ctrl+s", "app:toggleTodos");
    expect(new Bindings(table).press(ctrl("s"), ["Chat", "Global"], 0)).toEqual({ action: "app:toggleTodos" });
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
    const bindings = new Bindings(tableOf(defaultsFor("win32")));
    for (const [context, action, keys] of today) expect([context, action, bindings.keysFor(action, context)]).toEqual([context, action, keys]);
    const all = CONTEXTS.flatMap((c) => Object.values(defaultsFor("win32")[c]).map((a) => `${c} ${a}`));
    expect(new Set(all)).toEqual(new Set([...today.map(([c, a]) => `${c} ${a}`), "Chat chat:imagePaste"]));
  });

  it("pastes a picture on Alt+V on Windows, where Ctrl+V never arrives, and on Ctrl+V elsewhere", () => {
    expect(new Bindings(tableOf(defaultsFor("win32"))).keysFor("chat:imagePaste", "Chat")).toEqual(["alt+v"]);
    for (const platform of ["linux", "darwin"] as const)
      expect(new Bindings(tableOf(defaultsFor(platform))).keysFor("chat:imagePaste", "Chat")).toEqual(["ctrl+v"]);
    expect(DEFAULTS).toEqual(defaultsFor(process.platform));
  });

  it("writes every key in the spelling the table gives back", () => {
    for (const c of CONTEXTS) for (const text of Object.keys(DEFAULTS[c])) expect(keyText(parseKeys(text) as Stroke[])).toBe(text);
  });
});
