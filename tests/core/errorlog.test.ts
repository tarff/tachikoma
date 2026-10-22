import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Bus } from "../../src/core/bus.js";
import { attachErrorLog, summarize } from "../../src/core/errorlog.js";
import { Stats } from "../../src/core/stats.js";

describe("error log", () => {
  it("writes one JSON line per error and summarises them", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "tachi-")), ".tachikoma", "errors.jsonl");
    const bus = new Bus();
    attachErrorLog(bus, file, "s1");
    bus.emit("error", { kind: "tool", attempted: "shell", message: "exit code: 1\nmore", lead: "fake:a" });
    bus.emit("error", { kind: "provider", attempted: "request", message: "429", lead: "fake:a" });

    const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ session: "s1", kind: "tool", attempted: "shell", lead: "fake:a" });
    const out = summarize(file).join("\n");
    expect(out).toContain("2 errors logged");
    expect(out).toContain("  tool: 1");
    expect(out).toContain("request\n  429");
  });

  it("keeps its folder out of git, without touching the project's .gitignore", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tachi-"));
    const bus = new Bus();
    attachErrorLog(bus, path.join(root, ".tachikoma", "errors.jsonl"), "s1");
    bus.emit("error", { kind: "tool", attempted: "write_file secret", message: "x", lead: "fake:a" });
    expect(readFileSync(path.join(root, ".tachikoma", ".gitignore"), "utf8")).toBe("*\n");
    expect(existsSync(path.join(root, ".gitignore"))).toBe(false);
  });

  it("leaves an existing .gitignore in its folder alone", async () => {
    const dir = path.join(await mkdtemp(path.join(tmpdir(), "tachi-")), ".tachikoma");
    mkdirSync(dir);
    writeFileSync(path.join(dir, ".gitignore"), "errors.jsonl\n");
    const bus = new Bus();
    attachErrorLog(bus, path.join(dir, "errors.jsonl"), "s1");
    bus.emit("error", { kind: "tool", attempted: "shell", message: "x", lead: "fake:a" });
    expect(readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe("errors.jsonl\n");
  });

  it("turns itself off, saying so once, when the log cannot be written", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachi-"));
    writeFileSync(path.join(dir, "blocker"), "");
    const file = path.join(dir, "blocker", "errors.jsonl"); // its folder is a file, so writing fails
    const bus = new Bus();
    attachErrorLog(bus, file, "s1");
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    const report = { kind: "tool", attempted: "shell", message: "x", lead: "fake:a" } as const;
    expect(() => bus.emit("error", report)).not.toThrow();
    bus.emit("error", report);
    expect(said).toHaveBeenCalledTimes(1);
    expect(String(said.mock.calls[0]![0])).toContain("Error log turned off");
    said.mockRestore();
  });

  it("says so when there is no log yet", () => {
    expect(summarize(path.join(tmpdir(), "does-not-exist.jsonl"))).toEqual(["No errors logged yet."]);
  });

  const row = (attempted: string) => JSON.stringify({ at: "2026-10-22T00:00:00.000Z", session: "s1", kind: "tool", attempted, message: "it broke", lead: "fake:a" });
  async function logFile(...lines: string[]) {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "tachi-")), "errors.jsonl");
    writeFileSync(file, `${lines.join("\n")}\n`);
    return file;
  }

  it("skips a half-written line and says how many it skipped", async () => {
    const file = await logFile(row("shell").slice(0, 20), row("shell"));
    const out = summarize(file).join("\n");
    expect(out).toContain("1 errors logged");
    expect(out).toContain("shell\n  it broke");
    expect(out).toContain("(1 unreadable line skipped)");
  });

  it("skips rows missing fields and null lines", async () => {
    const file = await logFile(JSON.stringify({ kind: "tool", attempted: "shell" }), "null", "5", row("shell"));
    const out = summarize(file).join("\n");
    expect(out).toContain("1 errors logged");
    expect(out).toContain("(3 unreadable lines skipped)");
  });

  it("skips a last row that has no message", async () => {
    const out = summarize(await logFile(row("shell"), JSON.stringify({ at: "x", kind: "tool", attempted: "shell" }))).join("\n");
    expect(out).toContain("shell\n  it broke");
    expect(out).toContain("(1 unreadable line skipped)");
  });

  it("still reports skipped lines when no row could be read", async () => {
    expect(summarize(await logFile("{"))).toEqual(["No errors logged yet.", "(1 unreadable line skipped)"]);
  });

  it("keeps the most recent action and its message whole, each on a row of its own, for the screen to cut", async () => {
    const out = summarize(await logFile(row(`write_file ${"x".repeat(5000)}`)));
    expect(out).toContain(`Most recent (2026-10-22T00:00:00.000Z): write_file ${"x".repeat(5000)}`);
    expect(out).toContain("  it broke");
  });

  it("counts refusals another model answered apart from the errors", async () => {
    const rescue = JSON.stringify({ at: "x", session: "s1", kind: "fallback", attempted: "response", message: "a declined; b answered instead", lead: "a" });
    const out = summarize(await logFile(row("shell"), rescue));
    expect(out[0]).toMatch(/^1 errors and 1 refusals another model answered, logged in /);
    expect(out).toContain("  fallback: 1");
  });
});

describe("Stats", () => {
  it("adds up tokens and cost, and flags unknown prices", () => {
    const bus = new Bus();
    const stats = new Stats(bus);
    bus.emit("usage", { provider: "anthropic:claude-opus-5-5", usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } });
    bus.emit("usage", { provider: "openai:unknown", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } });
    expect(stats.cost).toBeCloseTo(4);
    expect(stats.costUnknown).toBe(true);
    expect(stats.input).toBe(1_000_010);
    expect(stats.context).toBe(15);
  });

  it("counts the tokens of an attempt whose price is not known, and shows the cost as unknown", () => {
    const bus = new Bus();
    const stats = new Stats(bus);
    bus.emit("usage", { provider: "anthropic:claude-opus-5-5", usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }, priceKnown: false });
    expect(stats.input).toBe(10);
    expect(stats.cost).toBe(0);
    expect(stats.costUnknown).toBe(true);
  });

  it("does not count a rescued refusal as an error", () => {
    const bus = new Bus();
    const stats = new Stats(bus);
    bus.emit("error", { kind: "fallback", attempted: "x", message: "a declined; b answered instead", lead: "a" });
    expect(stats.errors).toBe(0);
  });
});
