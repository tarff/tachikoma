import { describe, expect, it } from "vitest";
import { type GateOptions, type Mode, PermissionGate } from "../../src/core/permissions.js";
import { shellTool } from "../../src/tools/shell.js";
import { tempContext } from "../helpers.js";

// `echo` and `exit` behave the same in sh and PowerShell.
describe("shell tool", () => {
  it("returns the output of a command", async () => {
    const ctx = await tempContext();
    const out = await shellTool.run({ command: "echo hi" }, ctx);
    expect(out).toContain("exit code: 0");
    expect(out).toContain("hi");
  });

  it("treats a non-zero exit as an error", async () => {
    const ctx = await tempContext();
    await expect(shellTool.run({ command: "exit 3" }, ctx)).rejects.toThrow("exit code: 3");
  });

  it("puts stderr before stdout, so a long stdout cannot push the errors out of the cut", async () => {
    const ctx = await tempContext();
    const out = await shellTool.run({ command: "echo hi" }, ctx);
    expect(out.indexOf("--- stderr ---")).toBeLessThan(out.indexOf("--- stdout ---"));
    expect(out.indexOf("exit code: 0")).toBe(0);
  });

  it("says which signal killed a command instead of a null exit code", async () => {
    const ctx = await tempContext();
    const executor = { ...ctx.executor, exec: async () => ({ code: null, signal: "SIGKILL" as const, stdout: "", stderr: "" }) };
    const run = shellTool.run({ command: "sleep 100" }, { ...ctx, executor });
    await expect(run).rejects.toThrow("killed by SIGKILL");
    await expect(run).rejects.not.toThrow("exit code");
  });

  it("always asks in project mode", async () => {
    const ctx = await tempContext("project", [true]);
    await shellTool.run({ command: "echo hi" }, ctx);
    expect(ctx.asked).toEqual(["run: echo hi"]);
  });
});

// Release 7 plan, Task 8: the tool gives the gate its command, which the dangerous-command check reads. The executor is a
// stand-in that records what it was given, so no command here runs.
describe("shell tool and the dangerous-command check", () => {
  const push = "git push --force";
  const danger = "rewriting or deleting git history";
  async function withFake(mode: Mode, answer: boolean, refusal?: string, options?: GateOptions) {
    const ctx = await tempContext();
    const ran: string[] = [];
    const warned: (string[] | undefined)[] = [];
    const ask = async (_summary: string, _detail?: string, _owner?: unknown, _plain?: boolean, warnings?: string[]) => (warned.push(warnings), answer);
    const gate = new PermissionGate(mode, ask, refusal, { root: ctx.root, ...options });
    const executor = { ...ctx.executor, exec: async (command: string) => (ran.push(command), { code: 0, signal: null, stdout: "", stderr: "" }) };
    return { ctx: { ...ctx, gate, executor }, ran, warned };
  }

  it.each(["ask", "project"] as const)("in %s, asks with the danger's red line, and runs the command only once allowed", async (mode) => {
    const yes = await withFake(mode, true);
    await shellTool.run({ command: push }, yes.ctx);
    expect(yes.warned).toEqual([[`Danger: ${danger}: ${push}`]]);
    expect(yes.ran).toEqual([push]);
    const no = await withFake(mode, false);
    await expect(shellTool.run({ command: push }, no.ctx)).rejects.toThrow(`The user declined: run: ${push}`);
    expect(no.ran).toEqual([]);
  });

  it("refuses a dangerous command in never, and runs nothing", async () => {
    const { ctx, ran, warned } = await withFake("never", true);
    await expect(shellTool.run({ command: push }, ctx)).rejects.toThrow(`Not allowed: this command matches the dangerous-command check (${danger}: ${push}).`);
    expect(ran).toEqual([]);
    expect(warned).toEqual([]);
  });

  it("refuses a dangerous command in -p mode, and runs nothing", async () => {
    const { ctx, ran } = await withFake("project", false, "Not allowed in -p mode, where nobody can approve it", { headless: true });
    await expect(shellTool.run({ command: push }, ctx)).rejects.toThrow(`Not allowed: this command matches the dangerous-command check (${danger}: ${push}).`);
    expect(ran).toEqual([]);
  });
});
