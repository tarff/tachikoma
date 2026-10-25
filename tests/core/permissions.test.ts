import { describe, expect, it } from "vitest";
import { type Action, Declined, needsApproval, PermissionGate, visible } from "../../src/core/permissions.js";

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
