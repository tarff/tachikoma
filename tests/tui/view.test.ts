import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import type { Line } from "../../src/tui/describe.js";
import { arrived, bar, barFirst, first, FOLLOWING, notch, Rows, scrollBy, scrollTo, wrap, type View } from "../../src/tui/view.js";

const texts = (rows: { text: string }[]) => rows.map((r) => r.text);
const lines = (n: number, from = 0): Line[] => Array.from({ length: n }, (_, i) => ({ text: `line ${from + i}` }));

describe("wrap", () => {
  it("breaks after the last space that fits, and cuts a word too long for a row at the row's end", () => {
    expect(wrap("the quick brown fox", 10, false)).toEqual([
      { start: 0, end: 10, text: "the quick " }, // the space is drawn, and trimmed by Ink's output
      { start: 10, end: 19, text: "brown fox" },
    ]);
    expect(wrap("abcdefghijkl", 5, false).map((r) => [r.start, r.end])).toEqual([[0, 5], [5, 10], [10, 12]]);
  });

  it("breaks where Ink's own wrapping does in classic mode (wrap-ansi with hard: true, trim: false)", () => {
    expect(texts(wrap("the quickX brown", 10, false))).toEqual(["the quickX", " brown"]); // a space that does not fit starts the next row
    expect(texts(wrap("the quick  brown", 10, false))).toEqual(["the quick ", " brown"]);
    expect(texts(wrap("ab cdefghijklmn", 10, false))).toEqual(["ab cdefghi", "jklmn"]); // a long word starts on the row it is on...
    expect(texts(wrap("abcdefgh cdefghijklmnopqrst", 10, false))).toEqual(["abcdefgh ", "cdefghijkl", "mnopqrst"]); // ...unless that saves a row
    expect(texts(wrap("ab 日本語テキスト", 5, false))).toEqual(["ab ", "日本", "語テ", "キス", "ト"]);
  });

  it("never splits a wide character: two to a row of 5 columns, never three", () => {
    const rows = wrap("日本語テキスト", 5, false);
    expect(texts(rows)).toEqual(["日本", "語テ", "キス", "ト"]);
    for (const r of rows) expect(stringWidth(r.text)).toBeLessThanOrEqual(4);
  });

  it("gives an empty line one empty row, and a one-line entry one row cut with … that ends at the text's end", () => {
    expect(wrap("", 10, false)).toEqual([{ start: 0, end: 0, text: "" }]);
    expect(wrap("x".repeat(30), 10, true)).toEqual([{ start: 0, end: 30, text: `${"x".repeat(9)}…` }]);
    expect(wrap("日本語テキスト", 6, true)).toEqual([{ start: 0, end: 7, text: "日本…" }]); // as cli-truncate, Ink's truncate-end
    expect(wrap("short", 10, true)).toEqual([{ start: 0, end: 5, text: "short" }]);
  });

  it("draws a tab as spaces to the next stop of 8 from the row's start, never past the row's end, and breaks after it", () => {
    expect(wrap("a\tb", 20, false)).toEqual([{ start: 0, end: 3, text: "a       b" }]);
    expect(wrap("abcdefghi\tx", 10, false)).toEqual([
      { start: 0, end: 10, text: "abcdefghi " }, // the tab is cut to the one column left
      { start: 10, end: 11, text: "x" },
    ]);
    expect(wrap("abcdefghij\tx", 10, false)).toEqual([
      { start: 0, end: 10, text: "abcdefghij" },
      { start: 10, end: 12, text: "        x" }, // a tab with no column left starts the next row, as a space does
    ]);
    for (const r of wrap("\ta\tbb\tccc\tdddd\te", 12, false)) {
      expect(r.text).not.toContain("\t");
      expect(stringWidth(r.text)).toBeLessThanOrEqual(12);
    }
  });
});

// Lines of mixed lengths, the same each run: words of 1 to 12 letters, some wide characters, some empty lines and
// some one-line entries.
function mixed(n: number): Line[] {
  let seed = 1;
  const next = (m: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648; // the C library's rand(), for a fixed sequence
    return seed % m;
  };
  return Array.from({ length: n }, () => {
    const words = Array.from({ length: next(40) }, () => (next(10) === 0 ? "日本語" : "w".repeat(1 + next(12))));
    return { text: words.join(" "), ...(next(8) === 0 ? { oneLine: true } : {}) };
  });
}

describe("Rows", () => {
  it("splits each line at its line breaks into lines of their own, the same colour", () => {
    const rows = new Rows(10);
    rows.add([{ text: "a\nb", color: "red" }, { text: "c" }]);
    expect(rows.lines).toEqual([{ text: "a", color: "red" }, { text: "b", color: "red" }, { text: "c" }]);
    expect(rows.total).toBe(3);
    expect(rows.row(1)).toEqual({ line: 1, start: 0, end: 1, text: "b", color: "red" });
  });

  it("agrees on total, row and rowOf across 1,000 lines of mixed lengths", () => {
    const rows = new Rows(30);
    const all = mixed(1000);
    rows.add(all.slice(0, 400));
    rows.add(all.slice(400));
    expect(rows.total).toBe(all.reduce((n, l) => n + wrap(l.text, 30, l.oneLine ?? false).length, 0));
    for (let i = 0; i < rows.total; i++) {
      const r = rows.row(i);
      expect(rows.rowOf({ line: r.line, offset: r.start })).toBe(i);
    }
    for (let line = 0; line < 1000; line += 37) {
      const text = rows.lines[line]!.text;
      for (let offset = 0; offset <= text.length; offset++) {
        const r = rows.row(rows.rowOf({ line, offset }));
        expect(r.line).toBe(line);
        expect(r.start <= offset && (offset < r.end || (offset === text.length && r.end === text.length))).toBe(true);
      }
    }
  });

  it("puts the place where one row ends on the next row, and the line's own end on its last row", () => {
    const rows = new Rows(5);
    rows.add([{ text: "abcdef" }]);
    expect(rows.rowOf({ line: 0, offset: 4 })).toBe(0);
    expect(rows.rowOf({ line: 0, offset: 5 })).toBe(1);
    expect(rows.rowOf({ line: 0, offset: 6 })).toBe(1);
  });

  it("wraps everything again at a new width", () => {
    const rows = new Rows(5);
    rows.add([{ text: "abcdefghij" }]);
    expect(rows.rowOf({ line: 0, offset: 7 })).toBe(1);
    rows.setWidth(3);
    expect(rows.width).toBe(3);
    expect(rows.total).toBe(4);
    expect(rows.rowOf({ line: 0, offset: 7 })).toBe(2);
  });
});

describe("View", () => {
  it("shows the last rows while following, and the top when everything fits", () => {
    const rows = new Rows(20);
    rows.add(lines(20));
    expect(first(rows, FOLLOWING, 5)).toBe(15);
    expect(first(rows, FOLLOWING, 30)).toBe(0);
  });

  it("stays on a wrapped line's second row, not the line's first, as lines are added", () => {
    const rows = new Rows(5);
    rows.add([...lines(10), { text: "abcdefghij" }, ...lines(10, 10)]);
    const second = rows.rowOf({ line: 10, offset: 5 });
    const v = scrollTo(rows, FOLLOWING, 4, second);
    expect(v.at).toEqual({ line: 10, offset: 5 });
    expect(first(rows, v, 4)).toBe(second);
    rows.add(lines(10, 20));
    expect(first(rows, v, 4)).toBe(second);
    expect(rows.row(first(rows, v, 4))).toMatchObject({ line: 10, start: 5 });
  });

  it("stops following when scrolled up, and keeps its line as lines are added and the width changes", () => {
    const rows = new Rows(20);
    rows.add(Array.from({ length: 30 }, (_, i) => ({ text: `line ${i} ${"word ".repeat(i % 7)}` })));
    const v = scrollBy(rows, FOLLOWING, 10, -5);
    expect(v.at).not.toBeNull();
    const line = rows.row(first(rows, v, 10)).line;
    rows.add(lines(5, 30));
    expect(rows.row(first(rows, v, 10)).line).toBe(line);
    rows.setWidth(8);
    expect(rows.row(first(rows, v, 10)).line).toBe(line);
  });

  it("counts lines that arrive only while scrolled up", () => {
    const rows = new Rows(20);
    rows.add(lines(30));
    expect(arrived(FOLLOWING, 3)).toEqual({ at: null, unseen: 0 });
    const v = arrived(arrived(scrollBy(rows, FOLLOWING, 10, -5), 3), 2);
    expect(v.unseen).toBe(5);
  });

  it("follows again, with nothing unseen, once scrolled down to the bottom", () => {
    const rows = new Rows(20);
    rows.add(lines(30));
    const up = arrived(scrollBy(rows, FOLLOWING, 10, -5), 4);
    expect(scrollBy(rows, up, 10, 2)).toEqual({ ...up, at: { line: 17, offset: 0 } });
    expect(scrollBy(rows, up, 10, 5)).toEqual(FOLLOWING);
    expect(scrollBy(rows, up, 10, 1000)).toEqual(FOLLOWING);
    expect(scrollTo(rows, up, 10, 1000)).toEqual(FOLLOWING);
  });

  it("goes to the top with scrollTo(0), and stays following when everything fits", () => {
    const rows = new Rows(20);
    rows.add(lines(30));
    const top = scrollTo(rows, FOLLOWING, 10, 0);
    expect(top).toEqual({ at: { line: 0, offset: 0 }, unseen: 0 });
    expect(first(rows, top, 10)).toBe(0);
    expect(scrollBy(rows, top, 10, -3)).toEqual(top);
    expect(scrollBy(rows, FOLLOWING, 40, -5)).toEqual(FOLLOWING);
  });
});

describe("notch", () => {
  const run = (speed: number, dirs: (-1 | 1)[]) => {
    let carry = 0;
    return dirs.map((dir) => {
      const n = notch(carry, speed, dir);
      carry = n.carry;
      return n.rows;
    });
  };

  it("moves `speed` rows a notch, carrying fractions from notch to notch", () => {
    expect(run(3, [1, 1, 1])).toEqual([3, 3, 3]);
    expect(run(3, [-1, -1])).toEqual([-3, -3]);
    expect(run(0.5, [1, 1, 1, 1])).toEqual([0, 1, 0, 1]);
    expect(run(2.5, [1, 1, 1, 1])).toEqual([2, 3, 2, 3]);
    expect(run(2.5, [-1, -1])).toEqual([-2, -3]);
  });

  it("drops the carried fraction when the wheel turns the other way", () => {
    expect(run(0.5, [1, -1, 1, -1])).toEqual([0, 0, 0, 0]);
    expect(run(2.5, [1, -1])).toEqual([2, -2]);
  });
});

describe("bar", () => {
  it("is null when everything fits", () => {
    expect(bar(10, 10, 0)).toBeNull();
    expect(bar(3, 10, 0)).toBeNull();
  });

  it("shows how much is seen and where, the thumb at least one row", () => {
    expect(bar(100, 10, 0)).toEqual({ start: 0, size: 1 });
    const end = bar(100, 10, 90)!;
    expect(end.start + end.size).toBe(10);
    expect(bar(20, 10, 5)).toEqual({ start: 3, size: 5 }); // half its travel of 5, rounded up: Math.round(2.5)
    expect(bar(10_000, 10, 0)!.size).toBe(1);
  });

  it("turns a thumb's start back into a first row", () => {
    const back = [0, 1, 2, 3, 4, 5].map((s) => barFirst(20, 10, 5, s));
    expect(back).toEqual([0, 2, 4, 6, 8, 10]);
    for (const [s, f] of back.entries()) expect(bar(20, 10, f)!.start).toBe(s);
  });
});
