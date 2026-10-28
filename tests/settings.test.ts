import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import { lastSaved, loadSettings, readSettings, saveSetting, settingsDir, shownFile } from "../src/settings.js";

const read = (data: unknown) => readSettings(JSON.stringify(data));
const problem = (data: unknown) => {
  const r = read(data);
  return "problem" in r ? r.problem : undefined;
};
const temp = () => mkdtempSync(path.join(tmpdir(), "tachi-settings-"));
const BOM = String.fromCharCode(0xfeff);

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

  // Release 6 design, "Vim mode": two printable characters, and <Esc> the only target; the plan's choice 24 says which.
  it("keeps only vimInsertModeRemaps entries of two letters, digits, punctuation marks or symbols mapped to <Esc>, and warns of the rest", () => {
    const kept = { "11": "<Esc>", ";;": "<Esc>", "++": "<Esc>" }; // digits, punctuation, symbols
    const remaps = { jj: "<Esc>", jk: "<Esc>", j: "<Esc>", jjj: "<Esc>", "j\t": "<Esc>", kj: "<CR>", "éé": "<Esc>", ab: 1, ...kept };
    const r = read({ vimInsertModeRemaps: remaps });
    expect(r).toEqual({
      settings: { vimInsertModeRemaps: { jj: "<Esc>", jk: "<Esc>", "éé": "<Esc>", ...kept } },
      warnings: [
        'settings.json: "vimInsertModeRemaps" entry "j" is not two letters, digits, punctuation marks or symbols mapped to "<Esc>"; it was left out',
        'settings.json: "vimInsertModeRemaps" entry "jjj" is not two letters, digits, punctuation marks or symbols mapped to "<Esc>"; it was left out',
        'settings.json: "vimInsertModeRemaps" entry "j\\t" is not two letters, digits, punctuation marks or symbols mapped to "<Esc>"; it was left out',
        'settings.json: "vimInsertModeRemaps" entry "kj" is not two letters, digits, punctuation marks or symbols mapped to "<Esc>"; it was left out',
        'settings.json: "vimInsertModeRemaps" entry "ab" is not two letters, digits, punctuation marks or symbols mapped to "<Esc>"; it was left out',
      ],
    });
  });

  // A pair is two keys typed in turn, so each must be a key typed alone: a letter, digit, punctuation mark or
  // symbol (release 6 plan, choice 24). A space is not one for now.
  it("leaves out a remap pair with a space, a combining accent, a line separator or a control character", () => {
    const pairs = ["j ", " j", `e${String.fromCharCode(0x301)}`, `j${String.fromCharCode(0x2028)}`, `j${String.fromCharCode(7)}`];
    const r = read({ vimInsertModeRemaps: Object.fromEntries(pairs.map((k) => [k, "<Esc>"])) });
    const words = (k: string) =>
      `settings.json: "vimInsertModeRemaps" entry ${JSON.stringify(k)} is not two letters, digits, punctuation marks or symbols mapped to "<Esc>"`;
    expect(r).toEqual({ settings: { vimInsertModeRemaps: {} }, warnings: pairs.map((k) => `${words(k)}; it was left out`) });
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

  // Windows PowerShell 5.1's Out-File and Set-Content -Encoding utf8 begin the file with one.
  it("reads past a byte-order mark at the start", () => {
    expect(readSettings(`${BOM}{"lead": "ollama:a"}`)).toEqual({ settings: { lead: "ollama:a" }, warnings: [] });
  });

  // An empty file means nothing set, not a broken file (the coordinator's decision, in the spirit of the plan's choice 3).
  it("takes an empty file, or one of only spaces and line breaks, as {}", () => {
    for (const text of ["", " ", "\r\n", " \t\n ", BOM, `${BOM}\r\n`]) expect(readSettings(text)).toEqual({ settings: {}, warnings: [] });
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

// Release 6 plan, Task 8 and choice 2: one entry set, every other kept in its order, written as two-space JSON.
describe("saveSetting", () => {
  const fileOf = (home: string) => path.join(settingsDir(home), "settings.json");
  const written = (data: object) => `${JSON.stringify(data, null, 2)}\n`;
  const settingsUrl = pathToFileURL(path.resolve("src/settings.ts")).href;

  it("sets one entry and keeps every other, unknown ones included, in their order", async () => {
    const home = temp();
    mkdirSync(settingsDir(home));
    writeFileSync(fileOf(home), '{"$schema": "x",  "mode": "project", "leed": 1,\n"lead": "ollama:old", "screen": "full"}');
    await saveSetting("lead", "ollama:a", home);
    expect(readFileSync(fileOf(home), "utf8")).toBe(written({ $schema: "x", mode: "project", leed: 1, lead: "ollama:a", screen: "full" }));
    await saveSetting("fallback", "ollama:b", home);
    const all = { $schema: "x", mode: "project", leed: 1, lead: "ollama:a", screen: "full", fallback: "ollama:b" };
    expect(readFileSync(fileOf(home), "utf8")).toBe(written(all));
  });

  // A type check, which tsc makes: undefined would make JSON.stringify drop the entry (Task 8's code review).
  it("takes a value for the entry, never undefined", () => {
    expectTypeOf(saveSetting<"lead">).parameter(1).toEqualTypeOf<string>();
  });

  it("makes the file, and its folder, when there is none", async () => {
    const home = temp();
    await saveSetting("screen", "classic", home);
    expect(readFileSync(fileOf(home), "utf8")).toBe('{\n  "screen": "classic"\n}\n');
  });

  // Release 6 plan, Task 9: so the settings watcher can tell Tachikoma's own save from an edit.
  it("records the text it wrote last, by file", async () => {
    const home = temp();
    await saveSetting("screen", "classic", home);
    await saveSetting("lead", "ollama:a", home);
    expect(lastSaved.get(fileOf(home))).toBe(readFileSync(fileOf(home), "utf8"));
  });

  // As readSettings reads them: past a byte-order mark, and an empty file as {}.
  it("saves into a file Windows PowerShell wrote with a byte-order mark, and into an empty one", async () => {
    const home = temp();
    mkdirSync(settingsDir(home));
    writeFileSync(fileOf(home), `${BOM}{"mode": "ask"}`);
    await saveSetting("lead", "ollama:a", home);
    expect(readFileSync(fileOf(home), "utf8")).toBe(written({ mode: "ask", lead: "ollama:a" }));
    writeFileSync(fileOf(home), "\r\n");
    await saveSetting("lead", "ollama:a", home);
    expect(readFileSync(fileOf(home), "utf8")).toBe(written({ lead: "ollama:a" }));
  });

  it("leaves a file that is not one JSON object as it is, and says why", async () => {
    const home = temp();
    mkdirSync(settingsDir(home));
    writeFileSync(fileOf(home), '["lead"]');
    await expect(saveSetting("lead", "ollama:a", home)).rejects.toThrow('settings.json must be one object, such as {"lead": "ollama:qwen3:8b"} (got ["lead"])');
    expect(readFileSync(fileOf(home), "utf8")).toBe('["lead"]');
    writeFileSync(fileOf(home), "{");
    await expect(saveSetting("lead", "ollama:a", home)).rejects.toThrow(/^settings\.json is not valid JSON: /);
    expect(readFileSync(fileOf(home), "utf8")).toBe("{");
  });

  it("loses neither of two saves made at once", async () => {
    const home = temp();
    await Promise.all([saveSetting("lead", "ollama:a", home), saveSetting("screen", "classic", home)]);
    expect(JSON.parse(readFileSync(fileOf(home), "utf8"))).toEqual({ lead: "ollama:a", screen: "classic" });
  });

  // Two processes each save twenty entries of their own, as tests/tui/history.test.ts's two sessions do; 15 s as there.
  it("loses no entry when two sessions save at once", async () => {
    const home = temp();
    const sessions = ["a", "b"].map((tag) => {
      const script = path.join(home, `${tag}.mts`);
      const saves = `for (let i = 0; i < 20; i++) await saveSetting("${tag}" + i, i, ${JSON.stringify(home)});`;
      writeFileSync(script, `import { saveSetting } from ${JSON.stringify(settingsUrl)};\n${saves}\n`);
      const child = spawn(process.execPath, ["--import", "tsx", script], { stdio: ["ignore", "ignore", "inherit"] });
      return new Promise((resolve) => child.on("close", resolve));
    });
    expect(await Promise.all(sessions)).toEqual([0, 0]);
    const saved = JSON.parse(readFileSync(fileOf(home), "utf8"));
    for (const tag of ["a", "b"]) {
      expect(Object.entries(saved).filter(([name]) => name.startsWith(tag))).toEqual([...Array(20).keys()].map((i) => [`${tag}${i}`, i]));
    }
  }, 15_000);
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
