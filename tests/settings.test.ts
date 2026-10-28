import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSettings, readSettings, settingsDir, shownFile } from "../src/settings.js";

const read = (data: unknown) => readSettings(JSON.stringify(data));
const problem = (data: unknown) => {
  const r = read(data);
  return "problem" in r ? r.problem : undefined;
};
const temp = () => mkdtempSync(path.join(tmpdir(), "tachi-settings-"));

describe("readSettings", () => {
  // The design's example file ("The settings file"), every entry with a good value.
  it("takes every entry's good value", () => {
    const file = {
      lead: "anthropic:claude-opus-5-5",
      mode: "ask",
      effort: "high",
      fallback: "openai:gpt-5.5",
      worker: "anthropic:claude-haiku-5-5",
      maxTasks: 8,
      status: ["lead", "context", "cost"],
      screen: "full",
      scrollSpeed: 3,
      editorMode: "vim",
      vimInsertModeRemaps: { jj: "<Esc>" },
      editor: "code --wait",
    };
    expect(read(file)).toEqual({ settings: file, warnings: [] });
    const others = { mode: "never", effort: "max", screen: "classic", editorMode: "normal", maxTasks: 1, scrollSpeed: 0.5 };
    expect(read(others)).toEqual({ settings: others, warnings: [] });
  });

  it("has every entry optional", () => {
    expect(readSettings("{}")).toEqual({ settings: {}, warnings: [] });
  });

  it("keeps the first of repeated status names, as --status does", () => {
    expect(read({ status: ["cost", "lead", "cost"] })).toEqual({ settings: { status: ["cost", "lead"] }, warnings: [] });
  });

  it("allows $schema and ignores it", () => {
    expect(read({ $schema: "https://example.com/schema.json", mode: "project" })).toEqual({ settings: { mode: "project" }, warnings: [] });
  });

  it("refuses a value its flag would refuse, in the flag's words after the file and the entry", () => {
    expect(problem({ mode: "x" })).toBe('settings.json: "mode" must be one of: ask, project, never (got "x")');
    expect(problem({ effort: "huge" })).toBe('settings.json: "effort" must be one of: low, medium, high, xhigh, max (got "huge")');
    expect(problem({ screen: "half" })).toBe('settings.json: "screen" must be one of: full, classic (got "half")');
    expect(problem({ editorMode: "emacs" })).toBe('settings.json: "editorMode" must be one of: normal, vim (got "emacs")');
    for (const bad of [0, 1.5, -1]) expect(problem({ maxTasks: bad })).toBe(`settings.json: "maxTasks" must be a whole number from 1 (got "${bad}")`);
    for (const bad of [0, 21, 20.5, -1]) {
      expect(problem({ scrollSpeed: bad })).toBe(`settings.json: "scrollSpeed" must be a number above 0, up to 20 (got "${bad}")`);
    }
    expect(problem({ status: ["lead", "nope"] })).toBe(
      'settings.json: "status" must be one of: lead, context, tokens, cost, mode, errors, project, time, tasks, tools (got "nope")',
    );
  });

  it("refuses a value of the wrong JSON type, naming the entry", () => {
    expect(problem({ maxTasks: "8" })).toBe('settings.json: "maxTasks" must be a number, without quotes (got "8")');
    expect(problem({ scrollSpeed: "3" })).toBe('settings.json: "scrollSpeed" must be a number, without quotes (got "3")');
    for (const name of ["lead", "fallback", "worker", "editor", "mode", "effort", "screen", "editorMode"]) {
      expect(problem({ [name]: 5 })).toBe(`settings.json: "${name}" must be text in quotes (got 5)`);
    }
    expect(problem({ lead: null })).toBe('settings.json: "lead" must be text in quotes (got null)');
    for (const bad of ["lead", [], ["lead", 5]]) {
      expect(problem({ status: bad })).toBe(`settings.json: "status" must be a list of names, such as ["lead", "context"] (got ${JSON.stringify(bad)})`);
    }
    for (const bad of ["jj", ["jj"], null]) {
      expect(problem({ vimInsertModeRemaps: bad })).toBe(
        `settings.json: "vimInsertModeRemaps" must be an object, such as {"jj": "<Esc>"} (got ${JSON.stringify(bad)})`,
      );
    }
  });

  it("leaves out an unknown name with a warning, and applies the rest", () => {
    expect(read({ leed: "ollama:a", mode: "project", other: 1 })).toEqual({
      settings: { mode: "project" },
      warnings: ['settings.json: "leed" is not a setting; it was left out', 'settings.json: "other" is not a setting; it was left out'],
    });
  });

  // Release 6 design, "Vim mode": two printable characters, and <Esc> the only target.
  it("keeps only vimInsertModeRemaps entries of two printable characters mapped to <Esc>, and warns of the rest", () => {
    const remaps = { jj: "<Esc>", "j k": "<Esc>", jk: "<Esc>", j: "<Esc>", jjj: "<Esc>", "j\t": "<Esc>", kj: "<CR>", "éé": "<Esc>", ab: 1 };
    const r = read({ vimInsertModeRemaps: remaps });
    expect(r).toEqual({
      settings: { vimInsertModeRemaps: { jj: "<Esc>", jk: "<Esc>", "éé": "<Esc>" } },
      warnings: [
        'settings.json: "vimInsertModeRemaps" entry "j k" is not two printable characters mapped to "<Esc>"; it was left out',
        'settings.json: "vimInsertModeRemaps" entry "j" is not two printable characters mapped to "<Esc>"; it was left out',
        'settings.json: "vimInsertModeRemaps" entry "jjj" is not two printable characters mapped to "<Esc>"; it was left out',
        'settings.json: "vimInsertModeRemaps" entry "j\\t" is not two printable characters mapped to "<Esc>"; it was left out',
        'settings.json: "vimInsertModeRemaps" entry "kj" is not two printable characters mapped to "<Esc>"; it was left out',
        'settings.json: "vimInsertModeRemaps" entry "ab" is not two printable characters mapped to "<Esc>"; it was left out',
      ],
    });
  });

  it("says when the file is not valid JSON, in the parser's words", () => {
    let words = "";
    try {
      JSON.parse("{");
    } catch (err) {
      words = (err as Error).message;
    }
    expect(readSettings("{")).toEqual({ problem: `settings.json is not valid JSON: ${words}` });
  });

  it("refuses a file that is not one object", () => {
    for (const text of ["[]", '"lead"', "null", "5"]) {
      expect(readSettings(text)).toEqual({ problem: `settings.json must be one object, such as {"lead": "ollama:qwen3:8b"} (got ${text})` });
    }
  });
});

describe("loadSettings", () => {
  it("reads ~/.tachikoma/settings.json", () => {
    const home = temp();
    mkdirSync(settingsDir(home));
    writeFileSync(path.join(settingsDir(home), "settings.json"), '{"lead": "ollama:a", "leed": 1}');
    expect(loadSettings(home)).toEqual({ settings: { lead: "ollama:a" }, warnings: ['settings.json: "leed" is not a setting; it was left out'] });
  });

  it("takes a missing file, or a missing folder, as {}", () => {
    const home = temp();
    expect(loadSettings(home)).toEqual({ settings: {}, warnings: [] });
    mkdirSync(settingsDir(home));
    expect(loadSettings(home)).toEqual({ settings: {}, warnings: [] });
  });

  it("gives a problem for a file it cannot read", () => {
    const home = temp();
    mkdirSync(path.join(settingsDir(home), "settings.json"), { recursive: true }); // a folder where the file goes
    const r = loadSettings(home);
    expect("problem" in r && r.problem).toMatch(/^settings\.json could not be read: EISDIR/);
  });
});

describe("where the file is", () => {
  it("is .tachikoma in the home folder", () => {
    expect(settingsDir(path.join("x", "home"))).toBe(path.join("x", "home", ".tachikoma"));
  });

  it("is shown with ~ for the home folder and the system's own separator", () => {
    expect(shownFile("win32")).toBe("~\\.tachikoma\\settings.json");
    expect(shownFile("linux")).toBe("~/.tachikoma/settings.json");
    expect(shownFile("darwin")).toBe("~/.tachikoma/settings.json");
  });
});
