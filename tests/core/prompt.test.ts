import { describe, expect, it } from "vitest";
import { systemPrompt } from "../../src/core/prompt.js";

describe("systemPrompt", () => {
  it("gives PowerShell 5.1 a way to run a command only if the last one succeeded", () => {
    // `a; b` runs b even when a failed, so `;` alone is not a safe stand-in for `&&`.
    const prompt = systemPrompt("C:\\proj", "win32");
    expect(prompt).toContain("if ($?)");
    expect(prompt).not.toContain("chain commands with ;");
  });

  it("does not promise that someone will be asked", () => {
    // In headless runs nobody is there to ask: the action is refused instead.
    expect(systemPrompt("/proj", "linux")).not.toContain("asks the user before risky actions");
  });
});
