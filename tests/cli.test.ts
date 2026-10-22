import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Runs the real command through tsx. Every case here stops before any model is called.
function tachi(...args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", path.resolve("src/cli.tsx"), ...args], { input: "x\n", encoding: "utf8", env: { ...process.env, TACHI_LEAD: "" } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("tachi", () => {
  it("names --fallback when its value is bad", () => {
    const r = tachi("--lead", "ollama:none", "--fallback", "nope", "-p", "hi");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^--fallback: /);
  });

  it("refuses interactive mode without a terminal, before starting the interface", () => {
    const r = tachi("--lead", "ollama:none");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Interactive mode needs a terminal; use -p");
    expect(r.stderr).not.toContain("    at "); // no stack trace
  });
});
