import { describe, expect, it } from "vitest";
import { type Action, Declined, type Mode, needsApproval, PermissionGate, visible } from "../../src/core/permissions.js";

const act = (kind: Action["kind"], outside = false): Action => ({ kind, outside, summary: `${kind}${outside ? " outside" : ""}` });

describe("needsApproval", () => {
  it.each([
    ["ask", act("read"), false],
    ["ask", act("write"), true],
    ["ask", act("shell"), true],
    ["ask", act("read", true), true],
    ["project", act("read"), false],
    ["project", act("write"), false],
    ["project", act("shell"), true],
    ["project", act("write", true), true],
    ["project", act("read", true), true],
    ["never", act("shell"), false],
    ["never", act("write", true), false],
    ["never", act("read", true), false],
    // Until Task 10 gives auto its judge, it asks what ask asks, never less (release 7 plan, Task 7).
    ["auto", act("read"), false],
    ["auto", act("write"), true],
    ["auto", act("shell"), true],
    ["auto", act("read", true), true],
    ["auto", act("write", true), true],
  ] as const)("%s mode, %o -> %s", (mode, action, expected) => {
    expect(needsApproval(mode, action)).toBe(expected);
  });
});

describe("PermissionGate", () => {
  it("throws Declined when the user says no", async () => {
    const gate = new PermissionGate("ask", async () => false);
    await expect(gate.require(act("write"))).rejects.toBeInstanceOf(Declined);
  });

  it("asks with the action's summary, and goes ahead when the user says yes", async () => {
    const asked: string[] = [];
    const gate = new PermissionGate("ask", async (summary) => (asked.push(summary), true));
    await expect(gate.require(act("shell"))).resolves.toBeUndefined();
    expect(asked).toEqual(["shell"]);
  });

  it("passes the action's detail on with its summary", async () => {
    const asked: [string, string | undefined][] = [];
    const gate = new PermissionGate("ask", async (summary, detail) => (asked.push([summary, detail]), true));
    await gate.require({ kind: "write", outside: false, summary: "write a", detail: "x\ny" });
    expect(asked).toEqual([["write a", "x\ny"]]);
  });

  it("words a refusal as told, so -p mode does not say a user declined", async () => {
    const gate = new PermissionGate("ask", async () => false, "Not allowed in -p mode");
    await expect(gate.require(act("shell"))).rejects.toThrow("Not allowed in -p mode: shell");
  });

  it("reads its mode at each check, so a change applies from the next action", async () => {
    let asked = 0;
    const gate = new PermissionGate("ask", async () => (asked++, true));
    await gate.require(act("write"));
    gate.mode = "project";
    await gate.require(act("write"));
    expect(asked).toBe(1);
  });

  it("does not ask when no approval is needed", async () => {
    let asked = false;
    const gate = new PermissionGate("ask", async () => (asked = true));
    await gate.require(act("read"));
    expect(asked).toBe(false);
  });
});

describe("a subagent's gate", () => {
  it("reads the lead's mode at each check, and names the subagent when it asks", async () => {
    const asked: [string, string | undefined][] = [];
    const gate = new PermissionGate("never", async (summary, _detail, owner) => (asked.push([summary, owner?.name]), false), "Not allowed");
    const child = gate.for({ name: "t2 (find the login code)", signal: new AbortController().signal, stop: () => {} });
    await child.require({ kind: "read", outside: true, summary: "read /x" });
    expect(asked).toEqual([]);
    gate.mode = "ask";
    expect(child.mode).toBe("ask");
    await expect(child.require({ kind: "read", outside: true, summary: "read /x" })).rejects.toThrow("Not allowed: read /x");
    expect(asked).toEqual([["read /x", "t2 (find the login code)"]]);
  });

  // Release 7 plan, Task 4: a live edit that tightens the user's own rules reaches subagents already running.
  it("reads the lead's dangerous-command rules at each check", () => {
    const gate = new PermissionGate("ask", async () => false);
    const child = gate.for({ name: "t2", signal: new AbortController().signal, stop: () => {} });
    expect(child.rules).toEqual({ add: [], off: [] });
    gate.rules = { add: ["make deploy"], off: ["installing software"] };
    expect(child.rules).toEqual({ add: ["make deploy"], off: ["installing software"] });
  });
});

describe("visible", () => {
  it.each([
    ["an escape code", "echo \u001b[8mhidden", "echo \\u001b[8mhidden"],
    ["a carriage return", "rm -rf ~\rls", "rm -rf ~␍ls"],
    ["newlines", "ls\n\nrm -rf ~", "ls⏎⏎rm -rf ~"],
    ["a tab", "a\tb", "a⇥b"],
    ["a NUL", "a\u0000b", "a\\u0000b"],
    ["a C1 control", "a\u009bb", "a\\u009bb"],
    ["a delete", "a\u007fb", "a\\u007fb"],
    ["a right-to-left override", "ls \u202etxt.exe", "ls \\u202etxt.exe"],
    ["a bidi isolate", "ls \u2066x\u2069", "ls \\u2066x\\u2069"],
    ["a direction mark", "ls \u200ex\u200f", "ls \\u200ex\\u200f"],
    ["an Arabic letter mark", "a\u061cb", "a\\u061cb"],
    ["a line or paragraph separator", "a\u2028b\u2029", "a\\u2028b\\u2029"],
  ])("shows %s literally", (_, text, shown) => {
    expect(visible(text)).toBe(shown);
  });

  it("shows a real line break differently from a typed backslash-n", () => {
    // Otherwise `echo done` + a line break + `rm -rf build` would look like one harmless echo.
    expect(visible("echo done\nrm -rf build")).not.toBe(visible("echo done\\nrm -rf build"));
  });

  it("can leave tabs as tabs, for prose", () => {
    expect(visible("a\tb\u001b[8m\n", { tabs: true })).toBe("a\tb\\u001b[8m⏎");
  });

  it("leaves ordinary text alone", () => {
    expect(visible("echo café costs 5€ > out.txt")).toBe("echo café costs 5€ > out.txt");
  });

  it("is what the gate asks with", async () => {
    const asked: string[] = [];
    const gate = new PermissionGate("ask", async (summary) => (asked.push(summary), false));
    await expect(gate.require({ kind: "shell", outside: false, summary: "run: ls\rrm -rf ~" })).rejects.toThrow("run: ls␍rm -rf ~");
    expect(asked).toEqual(["run: ls␍rm -rf ~"]);
  });
});

// Release 7 plan, Task 8: the dangerous-command check and the protected paths in the gate. The commands are text the
// gate reads; nothing here runs them.
describe("the gate's dangerous commands and protected writes", () => {
  type Asked = { summary: string; detail?: string; warnings?: string[] };
  const gateIn = (mode: Mode, answer = true, refusal?: string, options?: ConstructorParameters<typeof PermissionGate>[3]) => {
    const asked: Asked[] = [];
    const gate = new PermissionGate(
      mode,
      async (summary, detail, _owner, _plain, warnings) => {
        asked.push({ summary, ...(detail === undefined ? {} : { detail }), ...(warnings ? { warnings } : {}) });
        return answer;
      },
      refusal,
      options,
    );
    return { gate, asked };
  };
  const push = "git push --force";
  const run = (command: string): Action => ({ kind: "shell", outside: false, summary: `run: ${command}`, command });
  const write = (part?: string): Action => ({
    kind: "write",
    outside: false,
    summary: "write /p/.husky/pre-commit",
    path: "/p/.husky/pre-commit",
    ...(part ? { protectedPart: part } : {}),
  });
  const GIT = "rewriting or deleting git history";

  it.each(["ask", "project", "auto"] as const)("in %s, asks before a dangerous command, with one red line per danger", async (mode) => {
    const { gate, asked } = gateIn(mode);
    await gate.require(run(`${push}; git reset --hard HEAD~3`));
    const warnings = [`Danger: ${GIT}: ${push}`, `Danger: ${GIT}: git reset --hard HEAD~3`];
    expect(asked).toEqual([{ summary: `run: ${push}; git reset --hard HEAD~3`, warnings }]);
  });

  it("asks with no red lines for a command the check passes", async () => {
    const { gate, asked } = gateIn("project");
    await gate.require(run("echo hi"));
    expect(asked).toEqual([{ summary: "run: echo hi", warnings: [] }]);
  });

  it("declines a dangerous command the user says no to, as any other", async () => {
    const { gate } = gateIn("ask", false);
    await expect(gate.require(run(push))).rejects.toThrow(new Declined(`The user declined: run: ${push}`));
  });

  it("refuses a dangerous command in never, without asking, one clause per danger", async () => {
    const { gate, asked } = gateIn("never");
    const refused = gate.require(run(`${push}; npm install -g left-pad`));
    await expect(refused).rejects.toBeInstanceOf(Declined);
    await expect(refused).rejects.toThrow(
      `Not allowed: this command matches the dangerous-command check (${GIT}: ${push}; installing software: npm install -g left-pad).`,
    );
    expect(asked).toEqual([]);
    await gate.require(run("echo hi")); // and passes one the check passes, as never asks nothing
  });

  // In -p mode the ask is the launch's report of the refusal (cli.tsx): it says no, and the gate refuses whatever it says.
  it.each([false, true])("refuses a dangerous command headless, in its own words, whatever the ask answers (%s)", async (answer) => {
    const p = "Not allowed in -p mode, where nobody can approve it";
    const { gate, asked } = gateIn("project", answer, p, { headless: true });
    await expect(gate.require(run(push))).rejects.toThrow(new Declined(`Not allowed: this command matches the dangerous-command check (${GIT}: ${push}).`));
    expect(asked).toHaveLength(1);
    // One the check passes is refused as before.
    await expect(gateIn("project", false, p, { headless: true }).gate.require(run("echo hi"))).rejects.toThrow(new Declined(`${p}: run: echo hi`));
  });

  it("says the check cannot read a line it cannot read", async () => {
    const { gate, asked } = gateIn("ask");
    await gate.require(run("echo 'open"));
    expect(asked[0]!.warnings).toHaveLength(1);
    expect(asked[0]!.warnings![0]).toMatch(/^Danger: the check cannot read it: /);
  });

  it("names the user's own rules, which a subagent's gate reads from the lead's", async () => {
    const { gate, asked } = gateIn("ask");
    const child = gate.for({ name: "t2", signal: new AbortController().signal, stop: () => {} });
    await child.require(run("make deploy"));
    gate.rules = { add: ["make deploy"], off: [GIT] };
    await child.require(run(`make deploy; ${push}`));
    expect(asked.map((a) => a.warnings)).toEqual([[], ["Danger: your own rule: make deploy: make deploy"]]);
  });

  it("shows control characters in a red line and a refusal as escapes, as in the question", async () => {
    const line = `${push} origin a\u202eb\u001b[8m`;
    const { gate, asked } = gateIn("ask");
    await gate.require(run(line));
    expect(asked[0]!.warnings).toEqual([`Danger: ${GIT}: ${visible(line)}`]);
    expect(asked[0]!.warnings![0]).toContain("a\\u202eb\\u001b[8m");
    await expect(gateIn("never").gate.require(run(line))).rejects.toThrow(`(${GIT}: ${push} origin a\\u202eb\\u001b[8m).`);
  });

  it.each(["ask", "project", "auto"] as const)("in %s, asks before a protected write", async (mode) => {
    const { gate, asked } = gateIn(mode);
    await gate.require(write(".husky"));
    expect(asked).toEqual([{ summary: "write /p/.husky/pre-commit", warnings: [] }]);
  });

  it("in project, still writes an ordinary file in the project without asking", async () => {
    const { gate, asked } = gateIn("project");
    await gate.require(write());
    expect(asked).toEqual([]);
  });

  it("refuses a protected write in never, naming the path and its protected part", async () => {
    const { gate, asked } = gateIn("never");
    await expect(gate.require(write(".husky"))).rejects.toThrow(
      new Declined("Not allowed: /p/.husky/pre-commit is a protected path (.husky), which other programs run or read as settings."),
    );
    await expect(gate.require({ ...write("a file with another name"), path: "/p/notes\u001b[8m.txt" })).rejects.toThrow(
      "Not allowed: /p/notes\\u001b[8m.txt is a protected path (a file with another name), which other programs run or read as settings.",
    );
    expect(asked).toEqual([]);
    await gate.require(write()); // an ordinary write is not asked about in never
  });

  it("keeps the git settings' paths for the session, and a subagent's gate reads the lead's", () => {
    const { gate } = gateIn("ask");
    const child = gate.for({ name: "t2", signal: new AbortController().signal, stop: () => {} });
    expect(child.protection).toEqual({ hooks: [], files: [] });
    gate.protection = { hooks: ["/p/hooks"], files: ["/p/my.gitconfig"] };
    expect(child.protection).toEqual({ hooks: ["/p/hooks"], files: ["/p/my.gitconfig"] });
  });
});
