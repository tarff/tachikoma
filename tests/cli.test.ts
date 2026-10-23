import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Runs the real command through tsx. Every case here stops before any model is called.
function tachi(...args: (string | Record<string, string>)[]) {
  const env = args.find((a) => typeof a === "object") ?? {};
  const words = args.filter((a) => typeof a === "string");
  const r = spawnSync(process.execPath, ["--import", "tsx", path.resolve("src/cli.tsx"), ...words], {
    input: "x\n",
    encoding: "utf8",
    env: { ...process.env, TACHI_LEAD: "", ANTHROPIC_API_KEY: "", ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Each start takes about a second; with the whole suite running, two starts took up to 5 s (2026-10-23),
// past Vitest's default. 15 s, as for the other tests that start processes (tests/exec/local.test.ts).
describe("tachi", { timeout: 15_000 }, () => {
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

  it("signs out of ChatGPT on its own, and says when nobody was signed in", () => {
    const data = path.join(mkdtempSync(path.join(tmpdir(), "tachi-cli-")), "data");
    const r = tachi("logout", "chatgpt", { TACHI_DATA_DIR: data });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("Not signed in to ChatGPT.");
  });

  it("explains login's usage instead of starting a sign-in", () => {
    expect(tachi("login", "openai").stderr).toContain("Only ChatGPT has a login: `login chatgpt`. Other providers use an API key.");
    const r = tachi("login", "chatgpt", "--account", "x");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Usage: login chatgpt [--new | --account <number>]");
  });

  it("refuses interactive mode without a terminal, before starting the interface", () => {
    const r = tachi("--lead", "ollama:none");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Interactive mode needs a terminal; use -p");
    expect(r.stderr).not.toContain("    at "); // no stack trace
  });
});
