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

  // Background commands plan, choice 30 (the user's): in the box's prompt too, as it is built by the same function.
  it("tells the model to start a server or a watcher in the background, on the host and in the box", () => {
    const line = "Commands get no input, so do not start anything interactive. Start a server or a watcher with background: true.";
    for (const prompt of [systemPrompt("C:\\proj", "win32"), systemPrompt("/proj", "linux"), systemPrompt("/work", "linux", "bash")]) {
      expect(prompt.split("\n")).toContain(line);
      expect(prompt).not.toContain("no time limit");
    }
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
    // It has no shell (release 4 design), so nothing of commands or the background (background commands plan, choice 30).
    expect(prompt).not.toMatch(/command|background/i);
  });
});
