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

  it("does not ask when no approval is needed", async () => {
    let asked = false;
    const gate = new PermissionGate("ask", async () => (asked = true));
    await gate.require(act("read"));
    expect(asked).toBe(false);
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
  ])("shows %s literally", (_, text, shown) => {
    expect(visible(text)).toBe(shown);
  });

  it("shows a real line break differently from a typed backslash-n", () => {
    // Otherwise `echo done` + a line break + `rm -rf build` would look like one harmless echo.
    expect(visible("echo done\nrm -rf build")).not.toBe(visible("echo done\\nrm -rf build"));
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
