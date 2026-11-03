import { describe, expect, it } from "vitest";
import { fileDiff, lineDiff } from "../../src/sandbox/diff.js";
import type { Line } from "../../src/tui/describe.js";
import { ZERO } from "../helpers.js";

const head = (text: string): Line => ({ text, color: "cyan" });
const del = (text: string): Line => ({ text: `-${text}`, color: "red" });
const add = (text: string): Line => ({ text: `+${text}`, color: "green" });
const same = (text: string): Line => ({ text: ` ${text}` });
const NO_NEWLINE: Line = { text: "\\ No newline at end of file" };
// Lines "1" to "n", each ending in a new line, with `swap`'s lines replaced.
const numbered = (n: number, swap: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => `${swap[i + 1] ?? i + 1}\n`).join("");

describe("lineDiff", () => {
  it("gives nothing for the same text, and for two empty ones", () => {
    expect(lineDiff("a\nb\n", "a\nb\n")).toEqual([]);
    expect(lineDiff("", "")).toEqual([]);
  });

  it("shows a changed line with three lines of context around it", () => {
    expect(lineDiff(numbered(10), numbered(10, { 5: "five" }))).toEqual([
      head("@@ -2,7 +2,7 @@"),
      same("2"),
      same("3"),
      same("4"),
      del("5"),
      add("five"),
      same("6"),
      same("7"),
      same("8"),
    ]);
  });

  it("gives a one-line range without its count, as GNU diff and git do", () => {
    expect(lineDiff("x\n", "y\n")).toEqual([head("@@ -1 +1 @@"), del("x"), add("y")]);
  });

  it("shows an added file and a deleted one against an empty text, its range starting at 0", () => {
    expect(lineDiff("", "a\nb\n")).toEqual([head("@@ -0,0 +1,2 @@"), add("a"), add("b")]);
    expect(lineDiff("a\nb\n", "")).toEqual([head("@@ -1,2 +0,0 @@"), del("a"), del("b")]);
  });

  it("starts an empty range at the line before it", () => {
    expect(lineDiff(numbered(6), numbered(6).replace("3\n", "3\nnew\n"))).toEqual([
      head("@@ -1,6 +1,7 @@"),
      same("1"),
      same("2"),
      same("3"),
      add("new"),
      same("4"),
      same("5"),
      same("6"),
    ]);
    expect(lineDiff("a\n", "a\nb\n")).toEqual([head("@@ -1 +1,2 @@"), same("a"), add("b")]);
    expect(lineDiff("a\nb\n", "a\n")).toEqual([head("@@ -1,2 +1 @@"), same("a"), del("b")]);
  });

  it("marks a last line with no new line, so adding one shows as a change", () => {
    expect(lineDiff("a\nb", "a\nb\n")).toEqual([head("@@ -1,2 +1,2 @@"), same("a"), del("b"), NO_NEWLINE, add("b")]);
    expect(lineDiff("a\n", "a\nb")).toEqual([head("@@ -1 +1,2 @@"), same("a"), add("b"), NO_NEWLINE]);
    expect(lineDiff("a", "")).toEqual([head("@@ -1 +0,0 @@"), del("a"), NO_NEWLINE]);
    expect(lineDiff("a", "a")).toEqual([]);
  });

  it("joins two changes six unchanged lines apart into one hunk, and splits them at seven", () => {
    expect(lineDiff(numbered(20), numbered(20, { 2: "two", 9: "nine" }))).toEqual([
      head("@@ -1,12 +1,12 @@"),
      same("1"),
      del("2"),
      add("two"),
      ...["3", "4", "5", "6", "7", "8"].map(same),
      del("9"),
      add("nine"),
      same("10"),
      same("11"),
      same("12"),
    ]);
    expect(lineDiff(numbered(20), numbered(20, { 2: "two", 10: "ten" }))).toEqual([
      head("@@ -1,5 +1,5 @@"),
      same("1"),
      del("2"),
      add("two"),
      same("3"),
      same("4"),
      same("5"),
      head("@@ -7,7 +7,7 @@"),
      same("7"),
      same("8"),
      same("9"),
      del("10"),
      add("ten"),
      same("11"),
      same("12"),
      same("13"),
    ]);
  });

  it("keeps a carriage return as part of its line, so a change of line endings shows", () => {
    expect(lineDiff("a\r\n", "a\n")).toEqual([head("@@ -1 +1 @@"), del("a\r"), add("a")]);
  });

  // Many small texts from a three-line alphabet, checked against what any right diff must give: the hunks turn the
  // first text into the second, and they hold as few removed and added lines as can be (a longest common subsequence's,
  // by the textbook table).
  it("gives a shortest diff that turns the first text into the second", () => {
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    const text = (most: number) => Array.from({ length: next() % most }, () => "abc"[next() % 3]!);
    for (let round = 0; round < 700; round++) {
      // Short ones for every small case, then longer ones, split more than once.
      const most = round < 500 ? 12 : 80;
      const a = text(most);
      const b = text(most);
      const rows = lineDiff(a.map((l) => `${l}\n`).join(""), b.map((l) => `${l}\n`).join(""));
      const out: string[] = [];
      let at = 0;
      let edits = 0;
      for (const row of rows) {
        const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@$/.exec(row.text);
        if (m) {
          const start = m[2] === "0" ? Number(m[1]) : Number(m[1]) - 1;
          out.push(...a.slice(at, start));
          at = start;
        } else if (row.text[0] === "+") {
          out.push(row.text.slice(1));
          edits++;
        } else {
          expect(a[at++]).toBe(row.text.slice(1));
          if (row.text[0] === " ") out.push(row.text.slice(1));
          else edits++;
        }
      }
      out.push(...a.slice(at));
      expect(out).toEqual(b);
      const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
      for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) lcs[i]![j] = a[i - 1] === b[j - 1] ? lcs[i - 1]![j - 1]! + 1 : Math.max(lcs[i - 1]![j]!, lcs[i]![j - 1]!);
      }
      expect(edits).toBe(a.length + b.length - 2 * lcs[a.length]![b.length]!);
    }
  });
});

describe("fileDiff", () => {
  it("shows a binary file as one row of sizes, by git's test (a zero byte in the first 8,000)", () => {
    expect(fileDiff(Buffer.from(`ab${ZERO}cde`), Buffer.from("xyz"))).toEqual([{ text: "binary file: 6 bytes before, 3 after" }]);
    expect(fileDiff(Buffer.from(""), Buffer.from(`${ZERO}`))).toEqual([{ text: "binary file: 0 bytes before, 1 after" }]);
  });

  it("shows text, a zero byte past the first 8,000 included, as lines", () => {
    const late = `${"x".repeat(8000)}${ZERO}\n`;
    expect(fileDiff(Buffer.from("a\n"), Buffer.from(late))).toEqual([head("@@ -1 +1 @@"), del("a"), add(late.slice(0, -1))]);
    expect(fileDiff(Buffer.from("café\n"), Buffer.from(""))).toEqual([head("@@ -1 +0,0 @@"), del("café")]);
  });

  // Choice 111: no diff when either side has more than 10,000 lines.
  it.each([
    ["before", 9_999, false],
    ["before", 10_000, false],
    ["before", 10_001, true],
    ["after", 9_999, false],
    ["after", 10_000, false],
    ["after", 10_001, true],
  ])("with %s at %i lines, gives one row instead of a diff: %s", (side, n, tooLarge) => {
    const long = Buffer.from(numbered(n, { 5: "five" }));
    const short = Buffer.from(numbered(9));
    const [before, after] = side === "before" ? [long, short] : [short, long];
    const [b, a] = side === "before" ? [n, 9] : [9, n];
    const rows = fileDiff(before, after);
    if (tooLarge) expect(rows).toEqual([{ text: `too large to show: ${b} lines before, ${a} after` }]);
    else expect(rows[0]?.color).toBe("cyan");
  });

  it("counts a last line with no new line, so the limit holds however a file ends", () => {
    const over = Buffer.from(`${numbered(10_000)}last`);
    expect(fileDiff(over, Buffer.from(""))).toEqual([{ text: "too large to show: 10001 lines before, 0 after" }]);
  });
});
