import { describe, expect, it } from "vitest";
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
