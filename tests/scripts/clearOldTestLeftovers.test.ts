import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { tempDir } from "../helpers.js";

// What another program does to a folder just before the script's next status call or listing of it, for the tests of
// entries that change while the script reads; the calls themselves are the real ones.
const before = vi.hoisted(() => ({
  lstat: undefined as ((p: string) => void) | undefined,
  readdir: undefined as ((p: string) => void) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const call = (fn: unknown, args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args);
  return {
    ...real,
    lstat: async (p: string, ...rest: unknown[]) => (before.lstat?.(String(p)), call(real.lstat, [p, ...rest])),
    readdir: async (p: string, ...rest: unknown[]) => (before.readdir?.(String(p)), call(real.readdir, [p, ...rest])),
  };
});

// The one-off script that clears the old test folders (cleanup plan, step 21), run on a pretend Temp the test made,
// with fixed answers. It is plain JavaScript outside the type-checked folders, so it is loaded by a path the type
// checker does not follow.
interface Script {
  PREFIXES: readonly string[];
  clearOldTestLeftovers(io: { temp: string; ask: (question: string) => Promise<string>; print: (line: string) => void }): Promise<void>;
}
const SCRIPT = new URL("../../scripts/clear-old-test-leftovers.mjs", import.meta.url).href;
const { PREFIXES, clearOldTestLeftovers } = (await import(SCRIPT)) as Script;

// Noon on that day, the PC's own time, so the date shown is that day wherever the test runs.
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12);
const OLD = day(2026, 11, 1);

// Runs the script on `temp` with `answer` to its one question; gives back every line, the question among them.
async function run(temp: string, answer: string): Promise<string[]> {
  const lines: string[] = [];
  await clearOldTestLeftovers({
    temp,
    ask: async (question) => (lines.push(question), answer),
    print: (line) => void lines.push(line),
  });
  return lines;
}

// A test folder made as the tests make theirs, holding one file of `bytes` bytes, last changed `at`.
function testFolder(temp: string, prefix: string, at: Date, bytes = 10): string {
  const dir = mkdtempSync(path.join(temp, prefix));
  writeFileSync(path.join(dir, "f.txt"), "x".repeat(bytes));
  utimesSync(dir, at, at);
  return dir;
}

const names = (dir: string) => readdirSync(dir).sort();

describe("the one-off script for the old test folders", () => {
  it("removes a folder for each listed name on y, and shows the others as not sure or not at all", async () => {
    expect(PREFIXES).toContain("tachi-");
    expect(PREFIXES).toContain("tachi editor ");
    const temp = tempDir("tachi-clear-temp-");
    PREFIXES.forEach((prefix, i) => testFolder(temp, prefix, i === 0 ? day(2026, 10, 12) : i === 1 ? day(2026, 11, 24) : OLD));
    const unsure = ["tachi-editor-", "tachi-build-", "tachikoma-proxy-", "tachi-editor-lookup-"].map((p) => testFolder(temp, p, day(2026, 11, 15)));
    mkdirSync(path.join(temp, "tachi-unlisted-thing"));
    utimesSync(path.join(temp, "tachi-unlisted-thing"), day(2026, 11, 15), day(2026, 11, 15));
    mkdirSync(path.join(temp, "other-folder"));
    const count = PREFIXES.length;

    expect(await run(temp, "y")).toEqual([
      `Old test folders in Temp (${temp})`,
      "Counted only if last changed before 2026-11-25 05:48 (+11:00).",
      "",
      `Test folders to delete: ${count}`,
      `  Total size: ${((count * 10) / 1024).toFixed(1)} KB`,
      "  Oldest: 2026-10-12",
      "  Newest: 2026-11-24",
      "Test folders changed after that time, left alone: 0",
      "",
      "Not sure (never deleted):",
      "  tachi-build-            1 folder, 2026-11-15",
      "  tachi-editor-           1 folder, 2026-11-15",
      "  tachi-editor-lookup-    1 folder, 2026-11-15",
      "  tachi-unlisted-         1 folder, 2026-11-15",
      "  tachikoma-proxy-        1 folder, 2026-11-15",
      "",
      "Delete these folders? (y/n) ",
      `Removed ${count} test folders.`,
      "Not sure, not touched: 5",
    ]);
    expect(names(temp)).toEqual([...unsure.map((d) => path.basename(d)), "other-folder", "tachi-unlisted-thing"].sort());
  });

  it("leaves a listed folder changed after the cut-off", async () => {
    const temp = tempDir("tachi-clear-temp-");
    testFolder(temp, "tachi-cli-", OLD);
    const late = testFolder(temp, "tachi-cli-", day(2026, 11, 26));
    const lines = await run(temp, "y");
    expect(lines).toContain("Test folders to delete: 1");
    expect(lines).toContain("Test folders changed after that time, left alone: 1");
    expect(lines).toContain("Removed 1 test folder.");
    expect(names(temp)).toEqual([path.basename(late)]);
  });

  it("leaves a listed name that is a junction, removes a junction inside a test folder as itself, and counts neither", async () => {
    const outside = tempDir("tachi-clear-outside-");
    writeFileSync(path.join(outside, "keep.txt"), "k".repeat(5000));
    const temp = tempDir("tachi-clear-temp-");
    symlinkSync(outside, path.join(temp, "tachi-cli-AbCd12"), "junction");
    const dir = mkdtempSync(path.join(temp, "tachi-home-"));
    writeFileSync(path.join(dir, "f.txt"), "x".repeat(700));
    symlinkSync(outside, path.join(dir, "in"), "junction");
    utimesSync(dir, OLD, OLD);

    const lines = await run(temp, "y");
    expect(lines).toContain("  Total size: 700 B");
    expect(lines).toContain("  tachi-cli-AbCd12    a link, not a folder");
    expect(lines).toContain("Removed 1 test folder.");
    expect(names(temp)).toEqual(["tachi-cli-AbCd12"]);
    expect(readdirSync(temp, { withFileTypes: true })[0]!.isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("k".repeat(5000));
  });

  it("skips a folder another program deletes between Temp's listing and the script's look at it", async () => {
    const temp = tempDir("tachi-clear-temp-");
    testFolder(temp, "tachi-cli-", OLD);
    const gone = testFolder(temp, "tachi-cli-", OLD);
    before.lstat = (p) => void (p === gone && rmSync(gone, { recursive: true }));
    onTestFinished(() => void (before.lstat = undefined));
    const lines = await run(temp, "y");
    expect(lines).toContain("Test folders to delete: 1");
    expect(lines).toContain("Removed 1 test folder.");
    expect(names(temp)).toEqual([]);
  });

  it("marks the total size as at least when a folder inside a test folder cannot be read", async () => {
    const temp = tempDir("tachi-clear-temp-");
    const dir = mkdtempSync(path.join(temp, "tachi-home-"));
    writeFileSync(path.join(dir, "f.txt"), "x".repeat(700));
    const locked = path.join(dir, "locked");
    mkdirSync(locked);
    writeFileSync(path.join(locked, "g.txt"), "x".repeat(300));
    utimesSync(dir, OLD, OLD);
    before.readdir = (p) => {
      if (p === locked) throw Object.assign(new Error(`EACCES: permission denied, scandir '${p}'`), { code: "EACCES" });
    };
    onTestFinished(() => void (before.readdir = undefined));
    const lines = await run(temp, "n");
    expect(lines).toContain("  Total size: at least 700 B");
    expect(lines.at(-1)).toBe("Nothing was deleted.");
  });

  for (const answer of ["n", "Y"]) {
    it(`changes nothing on the answer ${answer}`, async () => {
      const temp = tempDir("tachi-clear-temp-");
      const dirs = ["tachi-", "tachi-cli-", "tachi-home-"].map((p) => testFolder(temp, p, OLD));
      const before = dirs.map((d) => [names(d), statSync(d).mtimeMs]);
      const lines = await run(temp, answer);
      expect(lines.at(-1)).toBe("Nothing was deleted.");
      expect(names(temp)).toEqual(dirs.map((d) => path.basename(d)).sort());
      expect(dirs.map((d) => [names(d), statSync(d).mtimeMs])).toEqual(before);
    });
  }
});
