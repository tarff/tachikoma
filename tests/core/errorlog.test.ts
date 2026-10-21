import { readFileSync, writeFileSync } from "node:fs";
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
    expect(summarize(file)).toContain("2 errors logged");
    expect(summarize(file)).toContain("  tool: 1");
    expect(summarize(file)).toContain("request\n  429");
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
    expect(summarize(path.join(tmpdir(), "does-not-exist.jsonl"))).toBe("No errors logged yet.");
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

  it("does not count a rescued refusal as an error", () => {
    const bus = new Bus();
    const stats = new Stats(bus);
    bus.emit("error", { kind: "fallback", attempted: "x", message: "a declined; b answered instead", lead: "a" });
    expect(stats.errors).toBe(0);
    expect(stats.fallbacks).toBe(1);
  });
});
