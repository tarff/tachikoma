import { describe, expect, it } from "vitest";
import { subagentPrompt, systemPrompt } from "../../src/core/prompt.js";

describe("systemPrompt", () => {
  it("gives PowerShell 5.1 a way to run a command only if the last one succeeded", () => {
    // `a; b` runs b even when a failed, so `;` alone is not a safe stand-in for `&&`.
    const prompt = systemPrompt("C:\\proj", "win32");
    expect(prompt).toContain("if ($?)");
    expect(prompt).not.toContain("chain commands with ;");
  });

  // Choice 19: in the box the model sees /work, and commands run there with bash (Task 16).
  it("names the box's folder and its shell when given them", () => {
    const prompt = systemPrompt("/work", "linux", "bash");
    expect(prompt).toContain("The project root is /work.");
    expect(prompt).toContain("Shell commands run with bash on linux.");
  });

  it("does not promise that someone will be asked", () => {
    // In headless runs nobody is there to ask: the action is refused instead.
    expect(systemPrompt("/proj", "linux")).not.toContain("asks the user before risky actions");
  });
});

describe("subagentPrompt", () => {
  it("says the subagent only reads, and reports what it found with paths and line numbers", () => {
    const prompt = subagentPrompt("/proj");
    expect(prompt).toContain("The project root is /proj.");
    expect(prompt).toContain("read_file, find_files and search_files");
    expect(prompt).toContain("file paths and line numbers");
  });
});
