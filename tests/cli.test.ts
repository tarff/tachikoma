import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Runs the real command through tsx. Every case here stops before any model is called.
function tachi(...args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", path.resolve("src/cli.tsx"), ...args], {
    input: "x\n",
    encoding: "utf8",
    env: { ...process.env, TACHI_LEAD: "", ANTHROPIC_API_KEY: "" },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("tachi", () => {
  it("names --fallback when its value is bad", () => {
    const r = tachi("--lead", "ollama:none", "--fallback", "nope", "-p", "hi");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^--fallback: /);
  });

  it("refuses a blank prompt instead of sending it", () => {
    for (const prompt of ["", "  "]) {
      const r = tachi("--lead", "ollama:none", "-p", prompt);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("-p needs a prompt");
    }
  });

  it("allows --raw only with -p, and without --json, which is already exact", () => {
    for (const args of [["--lead", "ollama:none", "--raw"], ["--lead", "ollama:none", "-p", "hi", "--json", "--raw"]]) {
      const r = tachi(...args);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--raw works only with -p, and not with --json");
    }
  });

  it("warns that --raw output is not made safe for a terminal", () => {
    const r = tachi("--lead", "ollama:none", "-p", "hi", "--raw");
    expect(r.stderr).toContain("warning: --raw prints the answer exactly as the model wrote it");
  });

  it("asks for the Anthropic key before starting", () => {
    const r = tachi("--lead", "anthropic:claude-opus-5-5", "-p", "hi");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Set ANTHROPIC_API_KEY to use anthropic");
  });

  it("refuses interactive mode without a terminal, before starting the interface", () => {
    const r = tachi("--lead", "ollama:none");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Interactive mode needs a terminal; use -p");
    expect(r.stderr).not.toContain("    at "); // no stack trace
  });
});
