import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writePrivate } from "../../src/auth/private.js";
import { Bus } from "../../src/core/bus.js";
import { projectFile } from "../../src/core/datadir.js";
import { attachErrorLog, summarize } from "../../src/core/errorlog.js";
import { Stats } from "../../src/core/stats.js";
import { shortName } from "../helpers.js";

// Review fixes plan, fix 3: the log is in Tachikoma's data folder, named after the project's real path as the prompt
// history is, so nothing in a project can lead it elsewhere. Making that folder private starts PowerShell on Windows.
describe("error log", { timeout: 15_000 }, () => {
  afterEach(() => vi.unstubAllEnvs());

  // The project is a folder of its own inside one the test made, so its short name can be listed quickly.
  async function project() {
    const data = await mkdtemp(path.join(tmpdir(), "tachi-data-"));
    vi.stubEnv("TACHI_DATA_DIR", data);
    const root = path.join(await mkdtemp(path.join(tmpdir(), "tachi-")), "a project folder");
    mkdirSync(root);
    return { data, root };
  }
  const report = { kind: "provider", attempted: "request", message: "429", lead: "fake:a" } as const;

  it("writes to the data folder, named after the project's real path, and nothing in the project", async () => {
    const { data, root } = await project();
    const file = projectFile("errors", root);
    expect(file).toBe(path.join(data, "errors", `${createHash("sha256").update(realpathSync.native(root)).digest("hex")}.jsonl`));
    const bus = new Bus();
    attachErrorLog(bus, file, "s1");
    bus.emit("error", report);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ session: "s1", ...report });
    expect(readdirSync(path.join(data, "errors"))).toEqual([path.basename(file)]);
    expect(existsSync(path.join(root, ".tachikoma"))).toBe(false);
  });

  it("is not led out by a .tachikoma link in the project", async () => {
    const { root } = await project();
    const elsewhere = await mkdtemp(path.join(tmpdir(), "tachi-outside-"));
    // A junction on Windows needs no special rights; elsewhere it is an ordinary symlink.
    await symlink(elsewhere, path.join(root, ".tachikoma"), "junction");
    const bus = new Bus();
    attachErrorLog(bus, projectFile("errors", root), "s1");
    bus.emit("error", report);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("is one log for two spellings of one folder", async () => {
    const { root } = await project();
    const short = shortName(path.dirname(root), path.basename(root));
    const spellings = [root, path.join(root, "."), ...(short ? [path.join(path.dirname(root), short)] : [])];
    const file = projectFile("errors", root);
    for (const p of spellings) {
      expect(projectFile("errors", p)).toBe(file);
      const bus = new Bus();
      attachErrorLog(bus, projectFile("errors", p), "s1");
      bus.emit("error", report);
    }
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(spellings.length);
  });

  it("turns itself off, saying so once, when its folder cannot be made", async () => {
    const { data, root } = await project();
    const blocker = path.join(data, "blocker");
    writeFileSync(blocker, "");
    vi.stubEnv("TACHI_DATA_DIR", blocker); // the data folder is a file, so the errors folder cannot be made in it
    const file = projectFile("errors", root);
    const bus = new Bus();
    attachErrorLog(bus, file, "s1");
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => bus.emit("error", report)).not.toThrow();
    bus.emit("error", report);
    expect(said).toHaveBeenCalledTimes(1);
    expect(said.mock.calls[0]![0]).toBe(`Error log turned off: could not write ${file} (ENOTDIR: not a directory, mkdir '${path.dirname(file)}').`);
    said.mockRestore();
  });

  it("writes one JSON line per error and summarises them", async () => {
    const { root } = await project();
    const file = projectFile("errors", root);
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

  it("says so when there is no log yet", async () => {
    const { root } = await project();
    expect(summarize(projectFile("errors", root))).toEqual(["No errors logged yet."]);
  });

  const row = (attempted: string) => JSON.stringify({ at: "2026-10-22T00:00:00.000Z", session: "s1", kind: "tool", attempted, message: "it broke", lead: "fake:a" });
  async function logFile(...lines: string[]) {
    const { root } = await project();
    const file = projectFile("errors", root);
    writePrivate(file, `${lines.join("\n")}\n`);
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

  // Read as the prompt history is: a log with another name is refused, and one others could read is made private first,
  // which is said. Windows gives a new file the private folder's permissions, so only the first can be made there.
  it("refuses a log with another name (a hard link)", async () => {
    const file = await logFile(row("shell"));
    linkSync(file, path.join(path.dirname(file), "..", "other.jsonl"));
    expect(() => summarize(file)).toThrow(`${file} has other names (hard links), so it was not used`);
  });

  it.skipIf(process.platform === "win32")("says when it made a log others could read private (macOS and Linux)", async () => {
    const { root } = await project();
    const file = projectFile("errors", root);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${row("shell")}\n`, { mode: 0o644 });
    expect(summarize(file)[0]).toBe(`${file} could be read by others; it is now private to you.`);
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

  it("counts the calls without a known price, so a turn can tell its own", () => {
    const bus = new Bus();
    const stats = new Stats(bus);
    const usage = { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 };
    bus.emit("usage", { provider: "openai:unknown", usage });
    bus.emit("usage", { provider: "anthropic:claude-opus-5-5", usage, priceKnown: false });
    bus.emit("usage", { provider: "anthropic:claude-opus-5-5", usage });
    expect(stats.unpriced).toBe(2);
  });

  it("does not count a rescued refusal as an error", () => {
    const bus = new Bus();
    const stats = new Stats(bus);
    bus.emit("error", { kind: "fallback", attempted: "x", message: "a declined; b answered instead", lead: "a" });
    expect(stats.errors).toBe(0);
  });
});
