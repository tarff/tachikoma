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
const BOM = "\u{FEFF}";

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
      sandbox: "off",
      network: "off",
      judge: "anthropic:claude-haiku-5-5",
    };
    expect(read(file)).toEqual({ settings: file, warnings: [] });
    const others = { mode: "never", effort: "max", screen: "classic", editorMode: "normal", maxTasks: 1, scrollSpeed: 0.5, sandbox: "copy", network: "on" };
    expect(read(others)).toEqual({ settings: others, warnings: [] });
    expect(read({ mode: "auto", sandbox: "live" })).toEqual({ settings: { mode: "auto", sandbox: "live" }, warnings: [] });
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
    expect(problem({ mode: "x" })).toBe('settings.json: "mode" must be one of: ask, project, auto (got "x")');
    expect(problem({ sandbox: "on" })).toBe('settings.json: "sandbox" must be one of: off, live, copy (got "on")');
    expect(problem({ network: "yes" })).toBe('settings.json: "network" must be one of: off, on (got "yes")');
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
    for (const name of ["lead", "fallback", "worker", "editor", "mode", "effort", "screen", "editorMode", "sandbox", "network", "judge"]) {
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
  it("leaves out a remap pair with a space, a combining accent, a line separator, a control character, or one character on screen", () => {
    const pairs = ["j ", " j", "e\u{301}", "j\u{2028}", "j\u{7}", "\u{1F44D}\u{1F3FD}", "\u{1F1E6}\u{1F1FA}"]; // the last two: a thumb and a flag
    const r = read({ vimInsertModeRemaps: Object.fromEntries(pairs.map((k) => [k, "<Esc>"])) });
    const words = (k: string) =>
      `settings.json: "vimInsertModeRemaps" entry ${JSON.stringify(k)} is not two letters, digits, punctuation marks or symbols mapped to "<Esc>"`;
    expect(r).toEqual({ settings: { vimInsertModeRemaps: {} }, warnings: pairs.map((k) => `${words(k)}; it was left out`) });
  });

  // Release 7 plan, Task 4 and choice 5: the user's own dangerous-command rules.
  describe("dangerousCommands", () => {
    const KINDS_LIST =
      "wiping or formatting disks, deleting whole folders, permissions and system settings, stopping processes or the machine, " +
      "rewriting or deleting git history, sending files out, installing software, downloading and running code, acting outside the machine";

    it("takes commands added and kinds switched off, each list optional, a repeat kept once", () => {
      const both = { add: ["terraform apply", "make deploy"], off: ["installing software", "sending files out"] };
      expect(read({ dangerousCommands: both })).toEqual({ settings: { dangerousCommands: both }, warnings: [] });
      expect(read({ dangerousCommands: { add: ["make deploy", "make deploy"] } })).toEqual({
        settings: { dangerousCommands: { add: ["make deploy"], off: [] } },
        warnings: [],
      });
      expect(read({ dangerousCommands: { off: ["installing software"] } })).toEqual({
        settings: { dangerousCommands: { add: [], off: ["installing software"] } },
        warnings: [],
      });
      expect(read({ dangerousCommands: {} })).toEqual({ settings: { dangerousCommands: { add: [], off: [] } }, warnings: [] });
    });

    it("refuses an off that names no kind, listing the kinds", () => {
      expect(problem({ dangerousCommands: { off: ["x"] } })).toBe(`settings.json: "dangerousCommands.off" must be a list of: ${KINDS_LIST} (got "x")`);
      expect(problem({ dangerousCommands: { off: ["installing software", "Installing software"] } })).toBe(
        `settings.json: "dangerousCommands.off" must be a list of: ${KINDS_LIST} (got "Installing software")`,
      );
      expect(problem({ dangerousCommands: { off: [5] } })).toBe(`settings.json: "dangerousCommands.off" must be a list of: ${KINDS_LIST} (got 5)`);
      expect(problem({ dangerousCommands: { off: "installing software" } })).toBe(
        `settings.json: "dangerousCommands.off" must be a list of: ${KINDS_LIST} (got "installing software")`,
      );
    });

    it("refuses an add that is not a list of non-empty text", () => {
      for (const bad of ["terraform apply", [""], ["  "], [5], ["make deploy", null], null]) {
        expect(problem({ dangerousCommands: { add: bad } })).toBe(
          'settings.json: "dangerousCommands.add" must be a list of commands in quotes, such as ["terraform apply"]',
        );
      }
    });

    it("takes a rule's words with any spacing as one rule, written with single spaces", () => {
      expect(read({ dangerousCommands: { add: [" make deploy ", "make  deploy", "make\tdeploy", "terraform apply"] } })).toEqual({
        settings: { dangerousCommands: { add: ["make deploy", "terraform apply"], off: [] } },
        warnings: [],
      });
    });

    // A command's words have their quotes taken off (split.ts), so a rule holding one could never match.
    it("refuses a rule holding a quote", () => {
      for (const bad of ['git commit -m "wip"', "echo 'x'", 'say"hi']) {
        expect(problem({ dangerousCommands: { add: ["make deploy", bad] } })).toBe(
          `settings.json: "dangerousCommands.add" rules are matched word by word and cannot hold quotes (got ${JSON.stringify(bad)})`,
        );
      }
    });

    it("refuses a value that is not an object, and leaves out an unknown name in it with a warning", () => {
      for (const bad of ["installing software", ["installing software"], null]) {
        expect(problem({ dangerousCommands: bad })).toBe(
          `settings.json: "dangerousCommands" must be an object, such as {"add": ["terraform apply"], "off": ["installing software"]} (got ${JSON.stringify(bad)})`,
        );
      }
      expect(read({ dangerousCommands: { of: ["installing software"], add: ["make deploy"] } })).toEqual({
        settings: { dangerousCommands: { add: ["make deploy"], off: [] } },
        warnings: ['settings.json: "dangerousCommands.of" is not a setting; it was left out'],
      });
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
