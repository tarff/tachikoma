import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { History, historyFile, matches } from "../../src/tui/history.js";

const temp = () => mkdtempSync(path.join(tmpdir(), "tachi-history-"));
const historyUrl = pathToFileURL(path.resolve("src/tui/history.ts")).href;

describe("History", () => {
  it("keeps every prompt of a project, line breaks and all, for the next session", async () => {
    const file = path.join(temp(), "history", "p.jsonl");
    const one = new History(file, () => {});
    expect(one.load()).toEqual([]);
    await one.add("first");
    await one.add("two\nlines");
    expect(one.entries).toEqual(["first", "two\nlines"]);
    expect(new History(file, () => {}).load()).toEqual(["first", "two\nlines"]);
    expect(readFileSync(file, "utf8")).toBe(`"first"\n${JSON.stringify("two\nlines")}\n`); // one prompt a line
  });

  it("is a private file in Tachikoma's data folder, one for each project folder", () => {
    const data = temp();
    const a = historyFile(path.join(data, "..", "a"), data);
    expect(path.dirname(a)).toBe(path.join(data, "history"));
    expect(historyFile(path.join(data, "..", "b"), data)).not.toBe(a);
    expect(historyFile(path.join(data, "..", "a", "."), data)).toBe(a);
  });

  it.skipIf(process.platform === "win32")("can be read only by the user (macOS and Linux)", async () => {
    const file = path.join(temp(), "history", "p.jsonl");
    await new History(file, () => {}).add("x");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("skips a damaged line and keeps the rest", () => {
    const dir = path.join(temp(), "history");
    mkdirSync(dir);
    const file = path.join(dir, "p.jsonl");
    writeFileSync(file, '"good"\n{"half\n42\n"also good"\n');
    expect(new History(file, () => {}).load()).toEqual(["good", "also good"]);
  });

  // Two processes start. Alone it took 3.8 to 9.4 s on 2026-10-25, with the machine busy; 15 s, as for
  // the other tests that start processes (tests/cli.test.ts).
  it("keeps the prompts of two sessions saving at once", async () => {
    const dir = temp();
    const file = path.join(dir, "history", "p.jsonl");
    const sessions = ["a", "b"].map((tag) => {
      const script = path.join(dir, `${tag}.mts`);
      writeFileSync(script, `import { History } from ${JSON.stringify(historyUrl)};\nconst h = new History(${JSON.stringify(file)}, (l) => console.error(l));\nfor (let i = 0; i < 20; i++) await h.add("${tag}" + i);\n`);
      const child = spawn(process.execPath, ["--import", "tsx", script], { stdio: ["ignore", "ignore", "inherit"] });
      return new Promise((resolve) => child.on("close", resolve));
    });
    expect(await Promise.all(sessions)).toEqual([0, 0]);
    const saved = new History(file, () => {}).load();
    expect(saved).toHaveLength(40);
    for (const tag of ["a", "b"]) expect(saved.filter((s) => s.startsWith(tag))).toEqual([...Array(20).keys()].map((i) => `${tag}${i}`));
  }, 15_000);

  it("says once when the file cannot be read or saved, and keeps the prompts for this session", async () => {
    const dir = path.join(temp(), "history");
    const file = path.join(dir, "p.jsonl");
    mkdirSync(file, { recursive: true }); // a folder where the file should be
    const said: string[] = [];
    const h = new History(file, (line) => said.push(line));
    expect(h.load()).toEqual([]);
    await h.add("one");
    await h.add("two");
    expect(h.entries).toEqual(["one", "two"]);
    expect(said).toEqual([`The prompt history could not be read or saved: ${file} is not a plain file, so it was not used`]);
  });
});

describe("matches", () => {
  it("finds the past prompts holding the search, newest first, each once, in any case", () => {
    expect(matches(["git status", "ls", "Git log", "git status"], "git")).toEqual(["git status", "Git log"]);
    expect(matches(["a", "b"], "")).toEqual(["b", "a"]);
    expect(matches(["a"], "z")).toEqual([]);
  });
});
