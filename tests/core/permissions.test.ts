import { describe, expect, it } from "vitest";
import { type Action, type Ask, type Decider, type Decision, Declined, type Mode, needsApproval, PermissionGate, StartAgain, StoppedFirst, visible } from "../../src/core/permissions.js";

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
    // In auto, what its fast path does not pass, which the judge decides, or the user for a danger (release 7 plan, Task 10).
    ["auto", act("read"), false],
    ["auto", act("write"), false],
    ["auto", act("shell"), true],
    ["auto", act("read", true), true],
    ["auto", act("write", true), true],
    // Release 8c plan, choice 32: an MCP call by its kind, in every mode, never included, whatever `outside` says.
    ["ask", act("mcp"), true],
    ["project", act("mcp"), true],
    ["auto", act("mcp"), true],
    ["never", act("mcp"), true],
    // 8c-2a plan, Task 7: a box server's call with the box's network off runs unasked in never, and only there.
    ["ask", { ...act("mcp"), boxed: true }, true],
    ["project", { ...act("mcp"), boxed: true }, true],
    ["auto", { ...act("mcp"), boxed: true }, true],
    ["never", { ...act("mcp"), boxed: true }, false],
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

  // Release 7 plan, Task 10: auto mode's counts are the lead's gate's, and a paused question names the subagent and
  // carries its grey line.
  it("counts its judge's refusals in the lead's gate, and asks with the pause's line", async () => {
    const asked: [string, string | undefined, string | undefined][] = [];
    const gate = new PermissionGate("auto", async (summary, _detail, owner, _plain, _warnings, note) => (asked.push([summary, owner?.name, note]), false), undefined, {
      judge: async () => ({ allow: false, reason: "No." }),
    });
    const child = gate.for({ name: "t2", signal: new AbortController().signal, stop: () => {} });
    for (let i = 0; i < 3; i++) await expect(child.require(act("read", true))).rejects.toThrow("The judge refused: No.");
    await expect(child.require(act("read", true))).rejects.toThrow("The user declined: read outside");
    await expect(gate.require(act("read", true))).rejects.toThrow("The user declined: read outside");
    const line = "Auto mode paused after 3 refusals; approving this resumes it.";
    expect(asked).toEqual([
      ["read outside", "t2", line],
      ["read outside", undefined, line],
    ]);
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

// Release 8e plan, step 5 (design, "The permission events"): the judge's refusal that reaches the session says which of
// three it was, with the judge's reason as it gave it, apart from the escaped sentence the model reads. The sentence and
// auto mode's pause are as before.
describe("the judge's refusal", () => {
  const ESC = String.fromCharCode(0x1b);
  const verdicts = [
    { allow: false, reason: `It pushes${ESC}[8m.` },
    { allow: false, reason: "the judge could not be reached: offline", noVerdict: "unreachable" },
    { allow: false, reason: "the judge's answer could not be read", noVerdict: "unreadable" },
  ] as const;

  it.each(verdicts)("carries which of three the judge's no was, with its reason as given, and words the refusal as before (%o)", async (verdict) => {
    const gate = new PermissionGate("auto", async () => false, undefined, { judge: async () => verdict });
    const err = await gate.require(act("read", true)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Declined);
    expect((err as Declined).message).toBe(`The judge refused: ${visible(verdict.reason)}`);
    expect((err as Declined).judged).toStrictEqual(verdict);
  });

  it("escapes only the sentence the model reads, not the reason it carries", async () => {
    const gate = new PermissionGate("auto", async () => false, undefined, { judge: async () => verdicts[0] });
    const err = (await gate.require(act("read", true)).catch((e: unknown) => e)) as Declined;
    expect(err.message).toBe("The judge refused: It pushes\\u001b[8m.");
    expect(err.judged?.reason).toBe(`It pushes${ESC}[8m.`);
  });

  it("counts a no with no verdict toward the pause as before, and a user's no carries no judge's result", async () => {
    const notes: (string | undefined)[] = [];
    let n = 0;
    const gate = new PermissionGate("auto", async (_s, _d, _o, _p, _w, note) => (notes.push(note), false), undefined, {
      judge: async () => verdicts[n++ % verdicts.length]!,
    });
    for (const verdict of verdicts) {
      const err = (await gate.require(act("read", true)).catch((e: unknown) => e)) as Declined;
      expect(err.judged).toStrictEqual(verdict);
    }
    const err = (await gate.require(act("read", true)).catch((e: unknown) => e)) as Declined;
    expect(err).toBeInstanceOf(Declined);
    expect(err.message).toBe("The user declined: read outside");
    expect(err.judged).toBeUndefined();
    expect([n, notes]).toEqual([3, ["Auto mode paused after 3 refusals; approving this resumes it."]]);
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

  // Choice 3: in the box the check reads bash, with the box's home (HOME=/tmp, choice 77) and its root, /work (Task 16).
  it("reads a command in the box's shell, home and root when given them", async () => {
    const box = gateIn("project", true, undefined, { root: "/work", home: "/tmp", shell: "bash" });
    await box.gate.require(run("rm -rf /tmp"));
    await box.gate.require(run("rm -rf /work"));
    expect(box.asked.map((a) => a.warnings!.length)).toEqual([1, 1]);
    const host = gateIn("project");
    await host.gate.require(run("rm -rf /tmp"));
    expect(host.asked[0]!.warnings).toEqual([]);
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

  // In auto a protected write goes to the judge instead (Task 10; tests/core/auto.test.ts).
  it.each(["ask", "project"] as const)("in %s, asks before a protected write", async (mode) => {
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

  // Release 7 plan, Task 21 (from Task 8's spec review): a write whose real place cannot be told, through a link that
  // leads nowhere, has no protected part to find, and counts as outside; never refuses it, as it refuses any write
  // outside the project. A read outside still passes.
  it("refuses a write outside the project in never, one through a link that leads nowhere among them", async () => {
    const { gate, asked } = gateIn("never");
    const nowhere = "write /p/dangling/x.txt (through a link that leads nowhere)";
    await expect(gate.require({ kind: "write", outside: true, summary: nowhere })).rejects.toThrow(
      new Declined(`Not allowed in never mode: ${nowhere}, which is outside the project.`),
    );
    await expect(gate.require({ kind: "write", outside: true, summary: "write /q/a\u001b[8m.txt" })).rejects.toThrow(
      "Not allowed in never mode: write /q/a\\u001b[8m.txt, which is outside the project.",
    );
    await gate.require({ kind: "read", outside: true, summary: "read /q/a.txt" });
    expect(asked).toEqual([]);
  });

  it("keeps the git settings' paths for the session, and a subagent's gate reads the lead's", () => {
    const { gate } = gateIn("ask");
    const child = gate.for({ name: "t2", signal: new AbortController().signal, stop: () => {} });
    expect(child.protection).toEqual({ hooks: [], files: [] });
    gate.protection = { hooks: ["/p/hooks"], files: ["/p/my.gitconfig"] };
    expect(child.protection).toEqual({ hooks: ["/p/hooks"], files: ["/p/my.gitconfig"] });
  });
});

// Release 8b plan, Task 6 and choice 15: a PreToolUse hook's allow, or the user's yes to its question, stands in for the
// mode's question and the judge for one call; the dangerous-command check, protected paths and never's refusals stay.
// The commands are text the gate reads; nothing here runs them.
describe("a gate for one call a hook allowed", () => {
  type Asked = { summary: string; owner?: string; warnings?: string[]; note?: string };
  const gateIn = (mode: Mode, answer = true, options: ConstructorParameters<typeof PermissionGate>[3] = {}, refusal?: string) => {
    const asked: Asked[] = [];
    const judged: string[] = [];
    const gate = new PermissionGate(
      mode,
      async (summary, _detail, owner, _plain, warnings, note) => {
        asked.push({ summary, ...(owner ? { owner: owner.name } : {}), ...(warnings?.length ? { warnings } : {}), ...(note ? { note } : {}) });
        return answer;
      },
      refusal,
      { judge: async (action) => (judged.push(action.summary), { allow: false, reason: "the judge says no" }), ...options },
    );
    return { gate, asked, judged };
  };
  const run = (command: string): Action => ({ kind: "shell", outside: false, summary: `run: ${command}`, command });
  const write: Action = { kind: "write", outside: false, summary: "write /p/a.txt" };
  const outsideWrite: Action = { kind: "write", outside: true, summary: "write /q/a.txt" };
  const outsideRead: Action = { kind: "read", outside: true, summary: "read /q/a.txt" };
  const husky: Action = { kind: "write", outside: false, summary: "write /p/.husky/pre-commit", path: "/p/.husky/pre-commit", protectedPart: ".husky" };
  const push = "git push --force";
  const hooked = [{ allow: true }, { asked: true }] as const;

  it.each(hooked)("skips the mode's question in ask and project, and the judge in auto (%o)", async (h) => {
    for (const mode of ["ask", "project", "auto"] as const) {
      const { gate, asked, judged } = gateIn(mode);
      await gate.withHook(h).require(run("echo hi"));
      await gate.withHook(h).require(write);
      await gate.withHook(h).require(outsideRead);
      expect([mode, asked, judged]).toEqual([mode, [], []]);
    }
  });

  it.each(hooked)("still asks before a dangerous command and a protected write in ask and project (%o)", async (h) => {
    for (const mode of ["ask", "project"] as const) {
      const { gate, asked } = gateIn(mode);
      await gate.withHook(h).require(run(push));
      await gate.withHook(h).require(husky);
      expect(asked).toEqual([{ summary: `run: ${push}`, warnings: [`Danger: rewriting or deleting git history: ${push}`] }, { summary: husky.summary }]);
    }
  });

  // As now in auto: a danger asks the user, and a protected write goes to the judge (release 7 plan, Task 10).
  it.each(hooked)("in auto, still asks before a dangerous command, and sends a protected write to the judge (%o)", async (h) => {
    const { gate, asked, judged } = gateIn("auto");
    await gate.withHook(h).require(run(push));
    await expect(gate.withHook(h).require(husky)).rejects.toThrow(new Declined("The judge refused: the judge says no"));
    expect(asked.map((a) => a.summary)).toEqual([`run: ${push}`]);
    expect(judged).toEqual([husky.summary]);
  });

  // The user's choices, 2026-11-09: a hook's allow skips only the mode's ordinary question and the judge, and never waves
  // a write outside the project through, in any mode.
  it.each(hooked)("in auto, still sends a write outside the project to the judge (%o)", async (h) => {
    const { gate, asked, judged } = gateIn("auto");
    await expect(gate.withHook(h).require(outsideWrite)).rejects.toThrow(new Declined("The judge refused: the judge says no"));
    expect([asked, judged]).toEqual([[], ["write /q/a.txt"]]);
  });

  it.each(hooked)("in ask and project, still asks before a write outside the project (%o)", async (h) => {
    for (const mode of ["ask", "project"] as const) {
      const { gate, asked } = gateIn(mode, false);
      await expect(gate.withHook(h).require(outsideWrite)).rejects.toThrow(new Declined("The user declined: write /q/a.txt"));
      expect(asked).toEqual([{ summary: "write /q/a.txt" }]);
    }
  });

  it.each(hooked)("keeps every refusal of never (%o)", async (h) => {
    const { gate, asked } = gateIn("never");
    await expect(gate.withHook(h).require(run(push))).rejects.toThrow(/^Not allowed: this command matches the dangerous-command check/);
    await expect(gate.withHook(h).require(husky)).rejects.toThrow(/is a protected path \(\.husky\)/);
    await expect(gate.withHook(h).require(outsideWrite)).rejects.toThrow("Not allowed in never mode: write /q/a.txt, which is outside the project.");
    expect(asked).toEqual([]);
  });

  it.each(hooked)("headless, still refuses a dangerous command and a protected write (%o)", async (h) => {
    const p = "Not allowed in -p mode, where nobody can approve it";
    const { gate } = gateIn("project", false, { headless: true }, p);
    await gate.withHook(h).require(run("echo hi"));
    await expect(gate.withHook(h).require(run(push))).rejects.toThrow(/^Not allowed: this command matches the dangerous-command check/);
    await expect(gate.withHook(h).require(husky)).rejects.toThrow(new Declined(`${p}: ${husky.summary}`));
  });

  it("asks through a subagent's gate naming the subagent, and reads the lead's mode", async () => {
    const { gate, asked } = gateIn("ask");
    const child = gate.for({ name: "t2 (look)", signal: new AbortController().signal, stop: () => {} }).withHook({ allow: true });
    await child.require(run(push));
    expect(asked.map((a) => a.owner)).toEqual(["t2 (look)"]);
    gate.mode = "never";
    await expect(child.require(run(push))).rejects.toThrow(/^Not allowed: this command/);
  });
});

// Release 8c plan, Task 7 and choices 14, 15 and 32: an MCP call goes past never's branch to the question, which has the
// tool's description's first line as its grey note; auto's judge decides it; -p's ask says no; a hook's allow skips it.
describe("the gate's MCP calls", () => {
  type Asked = { summary: string; owner?: string; note?: string; oneRow?: true };
  const gateIn = (mode: Mode, answer: boolean, options: ConstructorParameters<typeof PermissionGate>[3] = {}, refusal?: string) => {
    const asked: Asked[] = [];
    const judged: Action[] = [];
    const ask: Ask = async (summary, _detail, owner, _plain, _warnings, note, oneRow) => (
      asked.push({ summary, ...(owner ? { owner: owner.name } : {}), ...(note ? { note } : {}), ...(oneRow ? { oneRow } : {}) }), answer
    );
    const judge = async (action: Action) => (judged.push(action), { allow: false as const, reason: "the judge says no" });
    return { gate: new PermissionGate(mode, ask, refusal, { judge, ...options }), asked, judged };
  };
  const RLO = String.fromCharCode(0x202e); // a right-to-left override, made from its code (visible escapes it)
  // `note` is the tool's own description, as the server sent it; the judge's holds a flattened schema's sentence (choice 47).
  const mcp = (note: string): Action => ({ kind: "mcp", outside: true, summary: 's: echo {"text":"hi"}', description: "The judge's text", note });
  const one = { summary: 's: echo {"text":"hi"}', note: "Says it back", oneRow: true as const };

  it("asks in ask, project and never, the tool's own description's first line, escaped, as its note on one row, and declines on a no", async () => {
    for (const mode of ["ask", "project", "never"] as const) {
      const { gate, asked } = gateIn(mode, false);
      await expect(gate.require(mcp(`\n  Says it back${RLO} \nand more`))).rejects.toThrow(new Declined('The user declined: s: echo {"text":"hi"}'));
      expect([mode, asked]).toEqual([mode, [{ ...one, note: "Says it back\\u202e" }]]);
    }
  });

  it("asks with no note for a tool with no description, and goes ahead on a yes", async () => {
    const { gate, asked } = gateIn("never", true);
    await gate.require(mcp(""));
    expect(asked).toEqual([{ summary: 's: echo {"text":"hi"}', oneRow: true }]);
  });

  it("asks through a subagent's gate naming the subagent, the note on one row", async () => {
    const { gate, asked } = gateIn("ask", true);
    await gate.for({ name: "t2 (look)", signal: new AbortController().signal, stop: () => {} }).require(mcp("Says it back"));
    expect(asked).toEqual([{ ...one, owner: "t2 (look)" }]);
  });

  it("sends it to the judge in auto, its description for the judge with it, and asks nobody", async () => {
    const { gate, asked, judged } = gateIn("auto", true);
    await expect(gate.require(mcp("Says it back"))).rejects.toThrow(new Declined("The judge refused: the judge says no"));
    expect([asked, judged]).toEqual([[], [mcp("Says it back")]]);
  });

  it("refuses it in -p, through the ask, in never and project alike", async () => {
    const p = "Not allowed in -p mode, where nobody can approve it";
    for (const mode of ["never", "project"] as const) {
      const { gate, asked } = gateIn(mode, false, { headless: true }, p);
      await expect(gate.require(mcp("Says it back"))).rejects.toThrow(new Declined(`${p}: s: echo {"text":"hi"}`));
      expect(asked).toHaveLength(1);
    }
  });

  // Choice 47: in never, a hook's ask on an MCP call is put to the user, as in ask; -p still refuses it.
  it("puts a hook's ask on an MCP call in never, and refuses it headless, and on other actions in never", () => {
    const never = gateIn("never", true).gate;
    expect([never.hookCannotAsk("Sure?", true), never.hookCannotAsk("Sure?")]).toEqual([
      undefined,
      "Not allowed in never mode: a PreToolUse hook asked for this call to be approved (Sure?).",
    ]);
    const headless = "Not allowed: a PreToolUse hook asked for this call to be approved (Sure?), and -p cannot ask.";
    for (const mode of ["never", "project"] as const) expect(gateIn(mode, true, { headless: true }).gate.hookCannotAsk("Sure?", true)).toBe(headless);
  });

  // 8c-2a plan, Task 7 and choice 7: a box server's call with the box's network off, which runs unasked in never.
  const boxed: Action = { ...mcp("Says it back"), outside: false, boxed: true };
  it("runs a boxed call in never unasked, in the window and headless", async () => {
    const p = "Not allowed in -p mode, where nobody can approve it";
    for (const options of [{}, { headless: true }]) {
      const { gate, asked, judged } = gateIn("never", false, options, p);
      await gate.require(boxed);
      expect([options, asked, judged]).toEqual([options, [], []]);
    }
  });

  it("refuses a hook's ask on a boxed call in never with never's line, as on the box's own actions", () => {
    const line = "Not allowed in never mode: a PreToolUse hook asked for this call to be approved (Sure?).";
    for (const options of [{}, { headless: true }]) {
      expect(gateIn("never", true, options).gate.hookCannotAsk("Sure?", true, true)).toBe(line);
    }
  });

  it("skips the question and the judge for one call a hook allowed, in every mode", async () => {
    for (const mode of ["ask", "project", "auto", "never"] as const) {
      const { gate, asked, judged } = gateIn(mode, false);
      await gate.withHook({ allow: true }).require(mcp("Says it back"));
      expect([mode, asked, judged]).toEqual([mode, [], []]);
    }
  });
});

// Release 8b plan, choice 15 and "Lines this plan adds": a PreToolUse hook's ask puts one question with its grey note;
// in never and headless, where nobody can answer, the call is refused.
describe("a hook's question", () => {
  const gateIn = (mode: Mode, answer: boolean, options: ConstructorParameters<typeof PermissionGate>[3] = {}, refusal?: string) => {
    const asked: { summary: string; note?: string }[] = [];
    const ask: Ask = async (summary, _detail, _owner, _plain, _warnings, note) => (asked.push({ summary, ...(note ? { note } : {}) }), answer);
    const gate = new PermissionGate(mode, ask, refusal, options);
    return { gate, asked };
  };

  it("asks once, the hook's reason in its note, and goes ahead on a yes", async () => {
    const { gate, asked } = gateIn("project", true);
    await gate.hookAsks('read_file {"path":"a.txt"}', "Reading secrets?");
    await gate.hookAsks("shell {}", "");
    expect(asked).toEqual([
      { summary: 'read_file {"path":"a.txt"}', note: "A hook asks: Reading secrets?" },
      { summary: "shell {}", note: "A hook asks." },
    ]);
  });

  it("declines on a no as any no does, and shows control characters as escapes", async () => {
    const { gate, asked } = gateIn("ask", false);
    await expect(gate.hookAsks("shell a\u001b[8m", "b\u202e")).rejects.toThrow(new Declined("The user declined: shell a\\u001b[8m"));
    expect(asked).toEqual([{ summary: "shell a\\u001b[8m", note: "A hook asks: b\\u202e" }]);
  });

  it("gives the refusal's words in never and headless, where nobody can be asked, with and without a reason", () => {
    const never = gateIn("never", true).gate;
    expect(never.hookCannotAsk("Sure?")).toBe("Not allowed in never mode: a PreToolUse hook asked for this call to be approved (Sure?).");
    expect(never.hookCannotAsk("")).toBe("Not allowed in never mode: a PreToolUse hook asked for this call to be approved.");
    const headless = gateIn("project", true, { headless: true }).gate;
    expect(headless.hookCannotAsk("Sure?")).toBe("Not allowed: a PreToolUse hook asked for this call to be approved (Sure?), and -p cannot ask.");
    expect(headless.hookCannotAsk("")).toBe("Not allowed: a PreToolUse hook asked for this call to be approved, and -p cannot ask.");
    expect(gateIn("project", true).gate.hookCannotAsk("Sure?")).toBeUndefined();
  });
});

// Release 8e plan, step 7 (design, "The permission events"; Q4, Q5, Q6): a gate for one call can be given a decider,
// which stands in here for the PermissionRequest hooks the session fires (step 8). It is asked once for the call, just
// before the first question about it, or in -p before the refusal the ask reports; never where the judge decides, nor
// for never mode's refusals. The commands are text the gate reads; nothing here runs them.
describe("the gate's PermissionRequest decider", () => {
  const p = "Not allowed in -p mode, where nobody can approve it";
  const gateIn = (mode: Mode, headless = false) => {
    const log: string[] = [];
    const notes: string[] = [];
    const judged: string[] = [];
    // In -p the ask is the launch's report of a refusal (cli.tsx), which says no.
    const ask: Ask = async (summary, _detail, _owner, _plain, _warnings, note) => {
      log.push(`asked: ${summary}`);
      if (note) notes.push(note);
      return !headless;
    };
    const judge = async (action: Action) => (judged.push(action.summary), { allow: false as const, reason: "No." });
    const gate = new PermissionGate(mode, ask, headless ? p : undefined, { judge, headless });
    const decider = (decision: Decision): Decider => async () => (log.push("decider"), decision);
    return { gate, log, notes, judged, decider };
  };
  const push = "git push --force";
  const run = (command: string): Action => ({ kind: "shell", outside: false, summary: `run: ${command}`, command });
  const husky: Action = { kind: "write", outside: false, summary: "write /p/.husky/pre-commit", path: "/p/.husky/pre-commit", protectedPart: ".husky" };
  const outsideWrite: Action = { kind: "write", outside: true, summary: "write /q/a.txt" };
  const outsideRead: Action = { kind: "read", outside: true, summary: "read /q/a.txt" };
  const mcp: Action = { kind: "mcp", outside: true, summary: 's: echo {"text":"hi"}', description: "Says it back" };
  const PAUSED = "Auto mode paused after 3 refusals; approving this resumes it.";
  const pausing = async (gate: PermissionGate) => {
    for (let i = 0; i < 3; i++) await expect(gate.require(outsideRead)).rejects.toThrow("The judge refused: No.");
  };

  type Question = { name: string; mode: Mode; action: Action; paused?: boolean; headless?: boolean };
  const questions: Question[] = [
    { name: "ask mode's question", mode: "ask", action: { kind: "write", outside: false, summary: "write /p/a.txt" } },
    { name: "project mode's question", mode: "project", action: run("echo hi") },
    { name: "auto mode's question for a danger", mode: "auto", action: run(push) },
    { name: "auto mode's question under a pause", mode: "auto", action: outsideRead, paused: true },
    { name: "never mode's question for an MCP call", mode: "never", action: mcp },
    { name: "-p's refusal", mode: "project", action: run("echo hi"), headless: true },
  ];

  it.each(questions)("with no decision, $name goes ahead as before, after the decider is asked", async (q) => {
    const { gate, log, decider } = gateIn(q.mode, q.headless);
    if (q.paused) await pausing(gate);
    const call = gate.deciding(decider(undefined)).require(q.action);
    if (q.headless) await expect(call).rejects.toThrow(new Declined(`${p}: ${q.action.summary}`));
    else await call;
    expect(log).toEqual(["decider", `asked: ${q.action.summary}`]);
  });

  it.each(questions)("on an allow, runs the call with no question in place of $name", async (q) => {
    const { gate, log, decider } = gateIn(q.mode, q.headless);
    if (q.paused) await pausing(gate);
    await gate.deciding(decider({ allow: true })).require(q.action);
    expect(log).toEqual(["decider"]);
  });

  it.each(questions)("on a deny, refuses the call with its words in place of $name", async (q) => {
    const { gate, log, decider } = gateIn(q.mode, q.headless);
    if (q.paused) await pausing(gate);
    await expect(gate.deciding(decider({ deny: "A hook says no." })).require(q.action)).rejects.toThrow(new Declined("A hook says no."));
    expect(log).toEqual(["decider"]);
  });

  it("on an allow, skips the dangerous-command warning, a protected path, a write outside the project, and -p's refusal of a danger", async () => {
    for (const mode of ["ask", "project"] as const) {
      const { gate, log, decider } = gateIn(mode);
      for (const action of [run(push), husky, outsideWrite]) await gate.deciding(decider({ allow: true })).require(action);
      expect([mode, log]).toEqual([mode, ["decider", "decider", "decider"]]);
    }
    const headless = gateIn("project", true);
    await headless.gate.deciding(headless.decider({ allow: true })).require(run(push));
    expect(headless.log).toEqual(["decider"]);
  });

  it("is never asked for never mode's own refusals, nor where never mode asks nothing, in the window or -p", async () => {
    for (const headless of [false, true]) {
      const { gate, log, decider } = gateIn("never", headless);
      const call = () => gate.deciding(decider({ allow: true }));
      await expect(call().require(run(push))).rejects.toThrow(/^Not allowed: this command matches the dangerous-command check/);
      await expect(call().require(husky)).rejects.toThrow(/is a protected path \(\.husky\)/);
      await expect(call().require(outsideWrite)).rejects.toThrow("Not allowed in never mode: write /q/a.txt, which is outside the project.");
      await call().require(run("echo hi"));
      await call().require({ ...mcp, outside: false, boxed: true });
      expect([headless, log]).toEqual([headless, []]);
    }
  });

  it("is never asked where auto mode's judge decides", async () => {
    const { gate, log, judged, decider } = gateIn("auto");
    for (const action of [outsideRead, husky, mcp]) {
      await expect(gate.deciding(decider({ allow: true })).require(action)).rejects.toThrow("The judge refused: No.");
    }
    expect([log, judged]).toEqual([[], [outsideRead.summary, husky.summary, mcp.summary]]);
  });

  // A PreToolUse hook's ask, which the session puts before the tool runs (Codex round 1, point 1; round 2, point 2).
  const NEVER = "Not allowed in never mode: a PreToolUse hook asked for this call to be approved (Sure?).";
  const HEADLESS = "Not allowed: a PreToolUse hook asked for this call to be approved (Sure?), and -p cannot ask.";
  type HookAsk = { name: string; mode: Mode; headless?: boolean; mcp?: boolean; boxed?: boolean; decided: boolean; refused?: string };
  const hookAsks: HookAsk[] = [
    { name: "ask mode, the decider asked, then the question", mode: "ask", decided: true },
    { name: "-p, the decider asked, then refused with today's words", mode: "project", headless: true, decided: true, refused: HEADLESS },
    { name: "never mode on a call not an MCP tool's, refused, the decider not asked", mode: "never", decided: false, refused: NEVER },
    { name: "never mode on an MCP tool, the decider asked, then the question", mode: "never", mcp: true, decided: true },
    { name: "never mode on a box server's tool with the network off, refused, the decider not asked", mode: "never", mcp: true, boxed: true, decided: false, refused: NEVER },
    { name: "-p in never mode on an MCP tool, the decider asked, then refused with today's words", mode: "never", headless: true, mcp: true, decided: true, refused: HEADLESS },
    { name: "-p in never mode on a call not an MCP tool's, never mode's refusal, the decider not asked", mode: "never", headless: true, decided: false, refused: NEVER },
  ];

  it.each(hookAsks)("puts a PreToolUse hook's ask with no decider exactly as before: $name", async (h) => {
    const { gate, log } = gateIn(h.mode, h.headless);
    expect(await gate.putHookAsk("shell {}", "Sure?", h.mcp, h.boxed)).toBe(h.refused);
    expect(log).toEqual(h.refused === undefined ? ["asked: shell {}"] : []);
  });

  it.each(hookAsks)("puts a PreToolUse hook's ask with no decision: $name", async (h) => {
    const { gate, log, notes, decider } = gateIn(h.mode, h.headless);
    expect(await gate.deciding(decider(undefined)).putHookAsk("shell {}", "Sure?", h.mcp, h.boxed)).toBe(h.refused);
    expect(log).toEqual([...(h.decided ? ["decider"] : []), ...(h.refused === undefined ? ["asked: shell {}"] : [])]);
    expect(notes).toEqual(h.refused === undefined ? ["A hook asks: Sure?"] : []);
  });

  it.each(hookAsks)("runs a call whose PreToolUse ask the decider allows, where it is asked: $name", async (h) => {
    const { gate, log, decider } = gateIn(h.mode, h.headless);
    const refused = await gate.deciding(decider({ allow: true })).putHookAsk("shell {}", "Sure?", h.mcp, h.boxed);
    expect([refused, log]).toEqual(h.decided ? [undefined, ["decider"]] : [h.refused, []]);
  });

  it("refuses a call whose PreToolUse ask the decider denies, with its words, asking nobody", async () => {
    const { gate, log, decider } = gateIn("ask");
    await expect(gate.deciding(decider({ deny: "No shells." })).putHookAsk("shell {}", "Sure?")).rejects.toThrow(new Declined("No shells."));
    expect(log).toEqual(["decider"]);
  });

  // Codex round 3, point 1: one way out for a new input, from the gate's own question inside the tool and from a
  // PreToolUse hook's ask before it, which step 9 takes.
  it("raises its own signal to start the call again, carrying the new input, from its own question and from a hook's ask alike", async () => {
    const input = { command: "echo safer" };
    for (const headless of [false, true]) {
      const { gate, log, judged, decider } = gateIn(headless ? "project" : "ask", headless);
      const fromQuestion = await gate.deciding(decider({ input })).require(run(push)).catch((e: unknown) => e);
      const fromHook = await gate.deciding(decider({ input })).putHookAsk("shell {}", "Sure?").catch((e: unknown) => e);
      for (const err of [fromQuestion, fromHook]) {
        expect(err).toBeInstanceOf(StartAgain);
        expect((err as StartAgain).input).toBe(input);
        expect(err).not.toBeInstanceOf(Declined);
        expect(err).not.toBeInstanceOf(StoppedFirst);
      }
      expect([headless, log, judged]).toEqual([headless, ["decider", "decider"], []]);
    }
  });

  // Q5: one record for the call, shared by the copy that notes a question was asked and the copies a PreToolUse allow
  // or yes makes.
  it("is asked once for a call across its gate's copies, its allow covering every later question", async () => {
    const { gate, log, decider } = gateIn("ask");
    const call = gate.noting(() => log.push("noted")).deciding(decider({ allow: true }));
    expect(await call.putHookAsk("shell {}", "Sure?")).toBeUndefined();
    await call.withHook({ asked: true }).require(run(push));
    await call.withHook({ allow: true }).require(husky);
    await call.require(outsideWrite);
    expect(log).toEqual(["decider"]);
  });

  it("leaves every later question of a call to the user, without asking again, when it decided nothing", async () => {
    const { gate, log, decider } = gateIn("ask");
    const call = gate.noting(() => log.push("noted")).deciding(decider(undefined));
    expect(await call.putHookAsk("shell {}", "Sure?")).toBeUndefined();
    await call.withHook({ asked: true }).require(run(push));
    await call.require(husky);
    expect(log).toEqual(["decider", "noted", "asked: shell {}", "noted", `asked: run: ${push}`, "noted", `asked: ${husky.summary}`]);
    // In -p, refused without asking again.
    const headless = gateIn("project", true);
    const call2 = headless.gate.deciding(headless.decider(undefined));
    expect(await call2.putHookAsk("shell {}", "Sure?")).toBe(HEADLESS);
    await expect(call2.require(run("echo hi"))).rejects.toThrow(new Declined(`${p}: run: echo hi`));
    expect(headless.log).toEqual(["decider", "asked: run: echo hi"]);
  });

  // Step 9's call that starts again: its record is already asked, with no decision, so a decider the session's
  // PreToolUse handling points it to afterwards is never asked.
  it("never asks the decider of a gate made already asked, leaving its questions to the user, and re-points one not yet asked", async () => {
    const { gate, log, decider } = gateIn("ask");
    const again = gate.deciding(null).deciding(decider({ allow: true }));
    expect(await again.putHookAsk("shell {}", "")).toBeUndefined();
    await again.withHook({ asked: true }).require(run(push));
    expect(log).toEqual(["asked: shell {}", `asked: run: ${push}`]);
    const headless = gateIn("project", true);
    await expect(headless.gate.deciding(null).deciding(headless.decider({ allow: true })).require(run("echo hi"))).rejects.toThrow(new Declined(`${p}: run: echo hi`));
    expect(headless.log).toEqual(["asked: run: echo hi"]);
    // A decider pointed again before it was asked: the later one is asked, once.
    const first = gateIn("ask");
    const seen: string[] = [];
    const pointed = first.gate.deciding(async () => (seen.push("first"), { allow: true })).deciding(async () => (seen.push("second"), { allow: true }));
    await pointed.require(run(push));
    expect([seen, first.log]).toEqual([["second"], []]);
  });

  // The review of step 7: a call that starts again after a new input gets a record of its own, so it neither keeps the
  // new input as its answer nor changes the old call's copies.
  it("gives a gate made already asked from a call's gate a record of its own, so a new input is not raised again", async () => {
    const { gate, log, decider } = gateIn("ask");
    const call = gate.deciding(decider({ input: { command: "echo safer" } }));
    await expect(call.require(run(push))).rejects.toBeInstanceOf(StartAgain);
    await call.deciding(null).require(run(push));
    expect(log).toEqual(["decider", `asked: run: ${push}`]);
    await expect(call.withHook({ asked: true }).require(run(push))).rejects.toBeInstanceOf(StartAgain);
  });

  // Q6: only the user's own yes resumes auto mode.
  it("runs one call it allows under auto mode's pause and leaves the pause, which the user's yes to the next question still lifts", async () => {
    const { gate, log, notes, judged, decider } = gateIn("auto");
    await pausing(gate);
    await gate.deciding(decider({ allow: true })).require(outsideRead);
    await gate.deciding(decider(undefined)).require(outsideRead); // still paused: the user is asked, and says yes
    await expect(gate.require(outsideRead)).rejects.toThrow("The judge refused: No."); // resumed: the judge decides again
    expect([log, notes, judged.length]).toEqual([["decider", "decider", "asked: read /q/a.txt"], [PAUSED], 4]);
  });

  // Codex review of 8e, point 1: a mode switched while the decider runs, by Shift+Tab, is the one the call is decided
  // under, as a judge's answer is rechecked, and the decider is not asked again.
  it.each([
    { name: "decides nothing", decision: undefined },
    { name: "allows", decision: { allow: true } as const },
  ])("decides the call again under the mode switched to never while the decider runs, when it $name", async ({ decision }) => {
    const { gate, log } = gateIn("ask");
    const switching: Decider = async () => {
      log.push("decider");
      gate.mode = "never";
      return decision;
    };
    const call = gate.deciding(switching);
    await expect(call.require(run(push))).rejects.toThrow(/^Not allowed: this command matches the dangerous-command check/);
    await call.require(run("echo hi"));
    expect(log).toEqual(["decider"]);
  });

  // Codex review 2 of 8e, point 1: the same at a PreToolUse hook's ask, which never mode refuses.
  it.each([
    { name: "decides nothing", decision: undefined },
    { name: "allows", decision: { allow: true } as const },
  ])("refuses a PreToolUse hook's ask under the mode switched to never while the decider runs, when it $name", async ({ decision }) => {
    const { gate, log } = gateIn("ask");
    const switching: Decider = async () => {
      log.push("decider");
      gate.mode = "never";
      return decision;
    };
    expect(await gate.deciding(switching).putHookAsk("shell {}", "Sure?")).toBe(NEVER);
    expect(log).toEqual(["decider"]);
  });

  it("runs nothing when a stop comes while the decider runs, at its own question and at a hook's ask", async () => {
    for (const ends of ["rejects", "decides nothing", "allows", "rewrites"] as const) {
      const { gate, log } = gateIn("ask");
      const stopping = (stop: AbortController) => async (): Promise<Decision> => {
        stop.abort();
        if (ends === "rejects") throw new Error("stopped");
        if (ends === "decides nothing") return undefined;
        return ends === "allows" ? { allow: true } : { input: {} };
      };
      const one = new AbortController();
      await expect(gate.deciding(stopping(one)).require(run("echo hi"), one.signal)).rejects.toBeInstanceOf(StoppedFirst);
      const two = new AbortController();
      await expect(gate.deciding(stopping(two)).putHookAsk("shell {}", "", false, false, two.signal)).rejects.toBeInstanceOf(StoppedFirst);
      expect([ends, log]).toEqual([ends, []]);
    }
  });
});
