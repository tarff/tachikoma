import { describe, expect, it } from "vitest";
import { type Action, Declined, needsApproval, PermissionGate } from "../../src/core/permissions.js";

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
