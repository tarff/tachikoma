import { describe, expect, it } from "vitest";
import { EVENTS, matcherOf, matches, readHooks } from "../../src/hooks/config.js";
import { readSettings } from "../../src/settings.js";

const read = (data: unknown) => readSettings(JSON.stringify(data));
const problem = (data: unknown) => {
  const r = read(data);
  return "problem" in r ? r.problem : undefined;
};
const warnings = (hooks: unknown) => {
  const r = read({ hooks });
  if ("problem" in r) throw new Error(r.problem);
  return r.warnings;
};
const command = (more: Record<string, unknown> = {}) => ({ type: "command", command: "check.sh", ...more });
// One PreToolUse group holding the hooks given, as Claude Code's file has them.
const pre = (...hooks: unknown[]) => ({ PreToolUse: [{ matcher: "Bash", hooks }] });
const hooksOf = (hooks: unknown) => readHooks('settings.json: "hooks"', hooks, []);
const TIMEOUT = "a number of seconds above 0 and no more than 2147483, such as 30";

describe("readHooks", () => {
  // Release 8b design, "The settings entry": Claude Code's shape, each command hook's fields kept as written.
  it("reads Claude Code's shape, each command hook with its fields", () => {
    const file = {
      PreToolUse: [
        { matcher: "Edit|Write", hooks: [command({ args: ["a", "b"], timeout: 30, onFailure: "block", statusMessage: "Checking" })] },
        { hooks: [{ type: "command", command: "log.sh", shell: "powershell", async: true }] },
      ],
      SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "wake.sh", shell: "bash" }] }],
    };
    const r = read({ hooks: file });
    expect(r).toEqual({
      settings: {
        hooks: [
          {
            event: "PreToolUse", matcher: { names: ["Edit", "Write"] }, command: "check.sh", args: ["a", "b"], timeout: 30, async: false,
            onFailure: "block", statusMessage: "Checking", where: '"PreToolUse"',
          },
          { event: "PreToolUse", matcher: { all: true }, command: "log.sh", shell: "powershell", async: true, where: '"PreToolUse"' },
          { event: "SessionStart", matcher: { names: ["startup"] }, command: "wake.sh", shell: "bash", async: false, where: '"SessionStart"' },
        ],
      },
      warnings: [],
      hooksLeftOut: [],
    });
  });

  it("knows Claude Code's names for the 11 events", () => {
    expect(EVENTS).toEqual([
      "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
      "Stop", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact",
    ]);
  });

  it("leaves out an event it does not run hooks at, with a warning, and keeps the rest", () => {
    const hooks = { Setup: [{ hooks: [command()] }], Notification: "anything", PreToolUse: [{ hooks: [command()] }] };
    expect(warnings(hooks)).toEqual([
      'settings.json: "hooks": "Setup" is not an event Tachikoma runs hooks at; its hooks were left out',
      'settings.json: "hooks": "Notification" is not an event Tachikoma runs hooks at; its hooks were left out',
    ]);
    expect(hooksOf(hooks).map((h) => h.event)).toEqual(["PreToolUse"]);
  });

  // Matching minds letter case, so an event's name does too.
  it("takes an event's name only as Claude Code writes it", () => {
    expect(warnings({ pretooluse: [{ hooks: [command()] }] })).toEqual([
      'settings.json: "hooks": "pretooluse" is not an event Tachikoma runs hooks at; its hooks were left out',
    ]);
  });

  it("leaves out a hook of another kind, with a warning", () => {
    const hooks = pre({ type: "prompt", prompt: "Is this safe?" }, command(), { type: "http", url: "http://localhost" });
    expect(warnings(hooks)).toEqual([
      'settings.json: "hooks": "PreToolUse" has a "prompt" hook; only "command" hooks run, so it was left out',
      'settings.json: "hooks": "PreToolUse" has a "http" hook; only "command" hooks run, so it was left out',
    ]);
    expect(hooksOf(hooks)).toHaveLength(1);
  });

  // The coordinator's fix 3 at Task 1's review (the user's words): a hook's own warnings end with its command and args,
  // so two alike can be told apart.
  it("leaves out a hook with if, with a warning naming its command", () => {
    const hooks = pre(command({ command: "node", args: ["audit.js"], if: "Bash(git *)" }), command({ command: "other.sh" }));
    expect(warnings(hooks)).toEqual([
      'settings.json: "hooks": "PreToolUse" has a hook with "if", which Tachikoma cannot check, so it was left out: node audit.js',
    ]);
    expect(hooksOf(hooks).map((h) => h.command)).toEqual(["other.sh"]);
  });

  it("runs a hook with asyncRewake as plain async, with a warning naming its command", () => {
    const hooks = pre(command({ asyncRewake: true }));
    expect(warnings(hooks)).toEqual(['settings.json: "hooks": "PreToolUse" has a hook with "asyncRewake"; it runs as plain "async": check.sh']);
    expect(hooksOf(hooks)[0]!.async).toBe(true);
  });

  it("drops a field that is not a hook field, with a warning naming its command, and keeps the hook", () => {
    const hooks = pre(command({ comment: "mine", timeout: 5 }));
    expect(warnings(hooks)).toEqual([
      'settings.json: "hooks": "PreToolUse" has a hook with "comment", which is not a hook field; it was left out: check.sh',
    ]);
    expect(hooksOf(hooks)).toEqual([
      { event: "PreToolUse", matcher: { names: ["Bash"] }, command: "check.sh", timeout: 5, async: false, where: '"PreToolUse"' },
    ]);
  });

  // Release 8b design, "The settings entry": Claude Code ignores once in settings files.
  it("drops once without a word", () => {
    const hooks = pre(command({ once: true }));
    expect(warnings(hooks)).toEqual([]);
    expect(hooksOf(hooks)).toEqual([{ event: "PreToolUse", matcher: { names: ["Bash"] }, command: "check.sh", async: false, where: '"PreToolUse"' }]);
  });

  // The coordinator's fix 1 at Task 1's review (the user's words): a misspelled key is dropped, the rest of its entry kept.
  it("drops a key of an entry that is not matcher or hooks, with a warning, and reads the entry's hooks", () => {
    const hooks = { PreToolUse: [{ matchers: "Bash", hooks: [command()] }] };
    expect(warnings(hooks)).toEqual([
      'settings.json: "hooks": "PreToolUse" has an entry with "matchers", which is not "matcher" or "hooks"; it was left out',
    ]);
    expect(hooksOf(hooks)).toEqual([{ event: "PreToolUse", matcher: { all: true }, command: "check.sh", async: false, where: '"PreToolUse"' }]);
  });

  it("ignores a matcher on UserPromptSubmit and Stop, which take none", () => {
    const hooks = { UserPromptSubmit: [{ matcher: "Bash", hooks: [command()] }], Stop: [{ matcher: "(", hooks: [command()] }] };
    expect(hooksOf(hooks).map((h) => h.matcher)).toEqual([{ all: true }, { all: true }]);
  });

  it("refuses hooks that are not an object of events", () => {
    for (const bad of [[], "PreToolUse", null, 5]) {
      expect(problem({ hooks: bad })).toBe(
        'settings.json: "hooks" must be an object of events, each a list, such as ' +
          `{"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "check.sh"}]}]} (got ${JSON.stringify(bad)})`,
      );
    }
  });

  it("refuses an event that is not a list, and a list entry that is not an object with a list of hooks", () => {
    expect(problem({ hooks: { PreToolUse: { hooks: [] } } })).toBe(
      'settings.json: "hooks": "PreToolUse" must be a list, such as [{"matcher": "Bash", "hooks": [{"type": "command", "command": "check.sh"}]}] ' +
        '(got {"hooks":[]})',
    );
    for (const bad of [5, {}, { matcher: "Bash", hooks: command() }]) {
      expect(problem({ hooks: { PreToolUse: [bad] } })).toBe(
        'settings.json: "hooks": "PreToolUse": each entry must be an object with a list of "hooks", such as ' +
          `{"matcher": "Bash", "hooks": [{"type": "command", "command": "check.sh"}]} (got ${JSON.stringify(bad)})`,
      );
    }
  });

  it("refuses a hook that is not an object, and a matcher that is not text", () => {
    expect(problem({ hooks: pre("check.sh") })).toBe(
      'settings.json: "hooks": "PreToolUse": each hook must be an object, such as {"type": "command", "command": "check.sh"} (got "check.sh")',
    );
    expect(problem({ hooks: { PreToolUse: [{ matcher: 5, hooks: [] }] } })).toBe(
      'settings.json: "hooks": "PreToolUse": "matcher" must be text in quotes (got 5)',
    );
  });

  it("refuses a matcher that is not a regular expression that compiles, in the engine's words", () => {
    let words = "";
    try {
      new RegExp("Bash(");
    } catch (err) {
      words = (err as Error).message;
    }
    expect(problem({ hooks: { PreToolUse: [{ matcher: "Bash(", hooks: [] }] } })).toBe(
      `settings.json: "hooks": "PreToolUse": "matcher" "Bash(" is not a regular expression that can be read (${words})`,
    );
  });

  // The coordinator's fix 2 at Task 1's review (the user's words): a missing field is said to be missing.
  it("refuses a hook without a type or a command, saying which is missing", () => {
    const missing = (field: string) =>
      `settings.json: "hooks": "PreToolUse": a hook must have "${field}", such as {"type": "command", "command": "check.sh"}`;
    expect(problem({ hooks: pre({ type: "command" }) })).toBe(missing("command"));
    expect(problem({ hooks: pre({ command: "check.sh" }) })).toBe(missing("type"));
    expect(problem({ hooks: pre({ type: "command", if: "Bash(*)" }) })).toBe(missing("command")); // before the warning that names it
  });

  // Fix 3: the command is checked before the warnings that name it.
  it("refuses a command of the wrong type before a warning would name it", () => {
    expect(problem({ hooks: pre({ type: "command", command: 5, if: "Bash(*)" }) })).toBe(
      'settings.json: "hooks": "PreToolUse": a hook\'s "command" must be text in quotes (got 5)',
    );
    expect(problem({ hooks: pre(command({ args: "a b", asyncRewake: true })) })).toBe(
      'settings.json: "hooks": "PreToolUse": a hook\'s "args" must be a list of text in quotes (got "a b")',
    );
  });

  it("refuses each field of the wrong type", () => {
    const at = 'settings.json: "hooks": "PreToolUse": a hook\'s';
    const bad: [string, unknown, string][] = [
      ["command", 5, "text in quotes"],
      ["args", "a b", "a list of text in quotes"],
      ["args", ["a", 5], "a list of text in quotes"],
      ["shell", "zsh", '"bash" or "powershell"'],
      ["timeout", 0, TIMEOUT],
      ["timeout", -1, TIMEOUT],
      ["timeout", "30", TIMEOUT],
      ["async", "yes", "true or false, without quotes"],
      ["asyncRewake", 1, "true or false, without quotes"],
      ["onFailure", "stop", '"continue" or "block"'],
      ["statusMessage", 5, "text in quotes"],
    ];
    for (const [field, value, what] of bad) {
      expect(problem({ hooks: pre(command({ [field]: value })) })).toBe(`${at} "${field}" must be ${what} (got ${JSON.stringify(value)})`);
    }
    expect(readSettings('{"hooks": {"PreToolUse": [{"hooks": [{"type": "command", "command": "a", "timeout": 1e999}]}]}}')).toEqual({
      problem: `${at} "timeout" must be ${TIMEOUT} (got null)`,
    });
  });

  // Node's setTimeout waits at most 2,147,483,647 ms and fires after 1 ms past it, so a longer timeout would kill the
  // hook at once.
  it("takes a timeout up to 2147483 seconds and refuses one past it", () => {
    const at = 'settings.json: "hooks": "PreToolUse": a hook\'s';
    for (const timeout of [2147484, 2147483.5]) {
      expect(problem({ hooks: pre(command({ timeout })) })).toBe(`${at} "timeout" must be ${TIMEOUT} (got ${timeout})`);
    }
    expect(read({ hooks: pre(command({ timeout: 2147483 })) })).toMatchObject({ settings: { hooks: [{ timeout: 2147483 }] } });
  });
});

describe("matcherOf", () => {
  // Release 8b design, "The settings entry": Claude Code's rules.
  it("matches everything when empty, missing or *", () => {
    for (const text of ["", "*", undefined]) expect(matcherOf(text)).toEqual({ all: true });
  });

  it("takes letters, digits, _, -, spaces, commas and | as exact names", () => {
    expect(matcherOf("Bash")).toEqual({ names: ["Bash"] });
    expect(matcherOf("Edit|Write")).toEqual({ names: ["Edit", "Write"] });
    expect(matcherOf("Edit, Write")).toEqual({ names: ["Edit", "Write"] });
    expect(matcherOf("my_tool-2")).toEqual({ names: ["my_tool-2"] });
  });

  it("takes anything else as an unanchored regular expression", () => {
    expect(matcherOf("mcp__.*")).toEqual({ regex: /mcp__.*/ });
    expect(matcherOf("^Bash$")).toEqual({ regex: /^Bash$/ });
  });
});

describe("matches", () => {
  it("matches a name exactly, minding letter case", () => {
    expect(matches(matcherOf("Bash"), "Bash")).toBe(true);
    expect(matches(matcherOf("Bash"), "bash")).toBe(false);
    expect(matches(matcherOf("Bash"), "BashOutput")).toBe(false);
    expect(matches(matcherOf("Edit, Write"), "Write")).toBe(true);
  });

  it("matches a regular expression anywhere in the name, minding letter case", () => {
    expect(matches(matcherOf("mcp__.*"), "mcp__github__issue")).toBe(true);
    expect(matches(matcherOf("mcp__.*"), "x_mcp__y")).toBe(true);
    expect(matches(matcherOf("^Bash$"), "Bash")).toBe(true);
    expect(matches(matcherOf("^Bash$"), "bash")).toBe(false);
    expect(matches(matcherOf("^Bash$"), "BashOutput")).toBe(false);
  });

  it("matches anything with all", () => {
    expect(matches(matcherOf("*"), "anything")).toBe(true);
  });
});
