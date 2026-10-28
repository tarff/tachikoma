import { describe, expect, it } from "vitest";
import { readKeybindings } from "../src/keybindings.js";
import { Bindings, DEFAULTS, parseKeys, type Stroke, tableOf } from "../src/tui/bindings.js";

const CHAT = ["Chat", "Global"] as const;
const stroke = (text: string) => (parseKeys(text) as Stroke[])[0]!;
// The file laid over the defaults, which must read without a problem for the whole file.
const read = (file: object | string) => {
  const got = readKeybindings(typeof file === "string" ? file : JSON.stringify(file));
  if ("problem" in got) throw new Error(got.problem);
  return got;
};
const chat = (keys: Record<string, unknown>) => ({ bindings: [{ context: "Chat", bindings: keys }] });
const problemsOf = (file: object) => read(file).problems;
const parserWords = (text: string) => {
  try {
    JSON.parse(text);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("parsed");
};

// Release 6 plan, Task 11: the keys file in Claude Code's format, laid over the default table.
describe("readKeybindings", () => {
  // Claude Code's keybindings page's first example, as it stands there (read 2026-10-28).
  it("reads Claude Code's own example: Ctrl+E opens the editor, and null frees Ctrl+S", () => {
    const { table, problems } = read({
      $schema: "https://www.schemastore.org/claude-code-keybindings.json",
      $docs: "https://code.claude.com/docs/en/keybindings",
      bindings: [{ context: "Chat", bindings: { "ctrl+e": "chat:externalEditor", "ctrl+s": null } }],
    });
    expect(problems).toEqual([]);
    expect(table.press(stroke("ctrl+e"), [...CHAT], 0)).toEqual({ action: "chat:externalEditor" });
    expect(table.press(stroke("ctrl+s"), [...CHAT], 0)).toBeNull();
    expect(new Bindings(tableOf(DEFAULTS)).press(stroke("ctrl+s"), [...CHAT], 0)).toEqual({ action: "chat:stash" });
    expect(table.keysFor("chat:externalEditor", "Chat")).toEqual(["ctrl+g", "ctrl+x ctrl+e", "ctrl+e"]);
  });

  // The page's "Unbind default shortcuts" example, which reclaims Ctrl+X: its contexts Tachikoma lacks are counted in
  // one line, and Ctrl+X, free once the Ctrl+X Ctrl+E chord is unbound, makes a new line.
  it("counts the entries of Claude Code's example that Tachikoma has no use for in one line, and applies the rest", () => {
    const { table, problems } = read({
      bindings: [
        { context: "Task", bindings: { "ctrl+x ctrl+b": null } },
        { context: "DiffPanel", bindings: { "ctrl+x b": null } },
        { context: "Pane", bindings: { "ctrl+x left": null, "ctrl+x right": null, "ctrl+x up": null, "ctrl+x down": null, "ctrl+x x": null } },
        { context: "PaneField", bindings: { "ctrl+x x": null } },
        {
          context: "Chat",
          bindings: {
            "ctrl+x ctrl+k": null,
            "ctrl+x ctrl+e": null,
            "ctrl+x enter": null,
            "ctrl+x ctrl+a": null,
            "ctrl+x ctrl+s": null,
            "ctrl+x tab": null,
            "ctrl+x": "chat:newline",
          },
        },
      ],
    });
    expect(problems).toEqual(["keybindings.json: 8 entries skipped: Tachikoma has no Task, DiffPanel, Pane, PaneField"]);
    expect(table.press(stroke("ctrl+x"), [...CHAT], 0)).toEqual({ action: "chat:newline" });
  });

  it("counts Claude Code's own actions and cmd+ keys, each name once", () => {
    expect(
      problemsOf({
        bindings: [
          { context: "Chat", bindings: { "meta+o": "chat:fastMode", "cmd+k": "chat:clearScreen", "super+x": "chat:submit", "meta+t": "chat:fastMode" } },
          { context: "Footer", bindings: { x: "footer:close" } },
          { context: "Confirmation", bindings: { space: "confirm:toggle" } },
        ],
      }),
    ).toEqual(["keybindings.json: 6 entries skipped: Tachikoma has no chat:fastMode, cmd+ keys, Footer, confirm:toggle"]);
    expect(problemsOf(chat({ "win+k": "chat:submit" }))).toEqual(["keybindings.json: 1 entry skipped: Tachikoma has no cmd+ keys"]);
  });

  it("says each problem in one line, and applies the rest of the file", () => {
    const { table, problems } = read({
      bindings: [
        { context: "Chatt", bindings: { "ctrl+y": "app:toggleTodos" } },
        "Chat",
        { context: "Chat" },
        {
          context: "Chat",
          bindings: {
            "ctrl+e": "chat:foo",
            "ctrl+c": "chat:submit",
            "ctrl+x ctrl+c": "chat:submit",
            "ctrl+d": null,
            "ctl+k": "chat:submit",
            "ctrl+ k": "chat:submit",
            "ctrl+b": 5,
            "ctrl+y": "app:toggleTodos",
            "Ctrl+Y": "chat:submit",
          },
        },
        { context: "Chat", bindings: { "ctrl+y": "chat:newline" } },
      ],
    });
    expect(problems).toEqual([
      'keybindings.json: "Chatt" is not a context; its block was left out',
      'keybindings.json: block 2 needs a "context" and a "bindings" object; it was left out',
      'keybindings.json: block 3 needs a "context" and a "bindings" object; it was left out',
      'keybindings.json: Chat "ctrl+e": "chat:foo" is not an action; it was left out',
      'keybindings.json: Chat "ctrl+c" is a reserved key; it was left out',
      'keybindings.json: Chat "ctrl+x ctrl+c" is a reserved key; it was left out',
      'keybindings.json: Chat "ctrl+d" is a reserved key; it was left out',
      'keybindings.json: Chat "ctl+k": unknown modifier "ctl"; it was left out',
      'keybindings.json: Chat "ctrl+ k": a space beside "+"; it was left out',
      "keybindings.json: Chat \"ctrl+b\" must be an action's name in quotes, or null (got 5); it was left out",
      'keybindings.json: Chat "Ctrl+Y" is bound twice in Chat; the first stays',
      'keybindings.json: Chat "ctrl+y" is bound twice in Chat; the first stays',
    ]);
    expect(table.press(stroke("ctrl+y"), [...CHAT], 0)).toEqual({ action: "app:toggleTodos" });
    expect(table.press(stroke("ctrl+e"), [...CHAT], 0)).toBeNull(); // the editor's end-of-line, as before
    expect(table.press(stroke("ctrl+c"), [...CHAT], 0)).toEqual({ action: "app:interrupt" });
  });

  it("takes command: with the commands that take nothing after them, and no other", () => {
    const names = ["exit", "errors", "model", "screen", "tasks", "vim", "settings", "keybindings"];
    const { table, problems } = read(chat(Object.fromEntries(names.map((n, i) => [`alt+${i}`, `command:${n}`]))));
    expect(problems).toEqual([]);
    expect(table.press(stroke("alt+3"), [...CHAT], 0)).toEqual({ action: "command:screen" });
    const list = "(exit, errors, model, screen, tasks, vim, settings, keybindings)";
    expect(problemsOf(chat({ "meta+g": "command:compact", "meta+l": "command:lead" }))).toEqual([
      `keybindings.json: Chat "meta+g": "command:compact" is not a command a key can run ${list}; it was left out`,
      `keybindings.json: Chat "meta+l": "command:lead" is not a command a key can run ${list}; it was left out`,
    ]);
  });

  it("takes {}, an empty file and a byte-order mark as the default keys", () => {
    for (const text of ["{}", "", " \r\n", `${String.fromCharCode(0xfeff)}{"bindings": []}`]) {
      const { table, problems } = read(text);
      expect(problems).toEqual([]);
      expect(table.keysFor("chat:stash", "Chat")).toEqual(["ctrl+s"]);
    }
  });

  it("refuses a file that is not JSON, or not one object with a bindings list", () => {
    expect(readKeybindings('{"bindings": ')).toEqual({ problem: `keybindings.json is not valid JSON: ${parserWords('{"bindings": ')}` });
    const shape = 'keybindings.json must be one object with a "bindings" list, such as {"bindings": []}';
    expect(readKeybindings("[]")).toEqual({ problem: `${shape} (got [])` });
    expect(readKeybindings('{"bindings": {}}')).toEqual({ problem: `${shape} (got {"bindings":{}})` });
  });
});
