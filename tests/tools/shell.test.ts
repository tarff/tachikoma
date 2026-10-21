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

  it("always asks in project mode", async () => {
    const ctx = await tempContext("project", [true]);
    await shellTool.run({ command: "echo hi" }, ctx);
    expect(ctx.asked).toEqual(["run: echo hi"]);
  });
});
