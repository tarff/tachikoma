import { describe, expect, it } from "vitest";
import { clicks, CLICK_MS, ordered, placeAt, span, textOf, wordAt } from "../../src/tui/select.js";
import { Rows } from "../../src/tui/view.js";
import type { Line } from "../../src/tui/describe.js";

const rowsOf = (width: number, lines: Line[]) => {
  const rows = new Rows(width);
  rows.add(lines);
  return rows;
};

describe("ordered", () => {
  it("puts the earlier place first, by line and then offset", () => {
    expect(ordered({ line: 1, offset: 0 }, { line: 0, offset: 5 })).toEqual([{ line: 0, offset: 5 }, { line: 1, offset: 0 }]);
    expect(ordered({ line: 0, offset: 2 }, { line: 0, offset: 4 })).toEqual([{ line: 0, offset: 2 }, { line: 0, offset: 4 }]);
  });
});

describe("textOf", () => {
  const lines = [{ text: "one  " }, { text: "two   " }, { text: "three" }];

  it("takes the text within a line, up to the end place's character and not including it", () => {
    expect(textOf([{ text: "hello world" }], { line: 0, offset: 0 }, { line: 0, offset: 5 })).toBe("hello");
  });

  it("joins lines with line breaks, keeping the spaces at their ends", () => {
    expect(textOf(lines, { line: 0, offset: 1 }, { line: 2, offset: 3 })).toBe("ne  \ntwo   \nthr");
  });

  it("takes the same text when the end place is before the start", () => {
    expect(textOf(lines, { line: 2, offset: 3 }, { line: 0, offset: 1 })).toBe("ne  \ntwo   \nthr");
  });

  it("takes exactly the text selected, its spaces kept mid-line and at a line's real end", () => {
    expect(textOf([{ text: "foo bar" }], { line: 0, offset: 0 }, { line: 0, offset: 4 })).toBe("foo ");
    expect(textOf([{ text: "see now" }], { line: 0, offset: 3 }, { line: 0, offset: 4 })).toBe(" ");
    expect(textOf(lines, { line: 0, offset: 0 }, { line: 1, offset: 4 })).toBe("one  \ntwo ");
    expect(textOf(lines, { line: 0, offset: 0 }, { line: 1, offset: 6 })).toBe("one  \ntwo   ");
  });

  it("takes an empty line as an empty line, and a place at a line's end as its end", () => {
    const three = [{ text: "a" }, { text: "" }, { text: "b" }];
    expect(textOf(three, { line: 0, offset: 0 }, { line: 2, offset: 1 })).toBe("a\n\nb");
    expect(textOf(three, { line: 0, offset: 1 }, { line: 2, offset: 0 })).toBe("\n\n");
  });

  it("gives a line wrapped over several rows as one line", () => {
    const rows = rowsOf(10, [{ text: "the quick brown fox" }, { text: "end" }]);
    expect(rows.total).toBe(3);
    const [a, b] = span(rows, { row: 0, x: 0 }, { row: 2, x: 2 });
    expect(textOf(rows.lines, a, b)).toBe("the quick brown fox\nend");
  });
});

describe("span", () => {
  const rows = rowsOf(20, [{ text: "hello world" }, { text: "second line" }]);

  it("takes both cells' characters in a forward drag", () => {
    expect(span(rows, { row: 0, x: 1 }, { row: 0, x: 4 })).toEqual([{ line: 0, offset: 1 }, { line: 0, offset: 5 }]);
    expect(textOf(rows.lines, ...span(rows, { row: 0, x: 6 }, { row: 1, x: 5 }))).toBe("world\nsecond");
  });

  it("takes both cells' characters in a backward drag", () => {
    expect(span(rows, { row: 0, x: 4 }, { row: 0, x: 1 })).toEqual([{ line: 0, offset: 1 }, { line: 0, offset: 5 }]);
    expect(textOf(rows.lines, ...span(rows, { row: 1, x: 5 }, { row: 0, x: 6 }))).toBe("world\nsecond");
  });

  it("ends a drag past a row's text at that row's end, not after the next row's first character", () => {
    const wrapped = rowsOf(12, [{ text: "the quick brown fox" }]);
    expect(wrapped.row(0)).toMatchObject({ start: 0, end: 10 }); // "the quick ", then "brown fox"
    expect(span(wrapped, { row: 0, x: 0 }, { row: 0, x: 11 })).toEqual([{ line: 0, offset: 0 }, { line: 0, offset: 10 }]);
    expect(textOf(wrapped.lines, ...span(wrapped, { row: 0, x: 0 }, { row: 0, x: 11 }))).toBe("the quick "); // mid-line: the space stays
  });

  it("takes a wide character whole from either of its columns", () => {
    const wide = rowsOf(20, [{ text: "a日本b" }]);
    expect(textOf(wide.lines, ...span(wide, { row: 0, x: 2 }, { row: 0, x: 3 }))).toBe("日本");
  });

  it("takes a letter with combining marks whole", () => {
    const marked = rowsOf(20, [{ text: "aé̂b" }]);
    expect(span(marked, { row: 0, x: 1 }, { row: 0, x: 1 })).toEqual([{ line: 0, offset: 1 }, { line: 0, offset: 4 }]);
  });

  it("ends a backward drag across rows that starts past a row's text at that row's end", () => {
    const two = rowsOf(20, [{ text: "abc" }, { text: "defgh" }]);
    expect(span(two, { row: 1, x: 2 }, { row: 0, x: 9 })).toEqual([{ line: 0, offset: 3 }, { line: 1, offset: 3 }]);
    expect(textOf(two.lines, ...span(two, { row: 1, x: 2 }, { row: 0, x: 9 }))).toBe("\ndef");
  });
});

describe("wordAt", () => {
  const word = (text: string, at: string, skip = 0) => {
    const offset = text.indexOf(at, skip);
    const { start, end } = wordAt(text, offset);
    return text.slice(start, end);
  };

  it("takes a Windows path whole, from its drive, a folder or its extension", () => {
    const text = "see C:\\src\\a-b_c.ts now";
    expect(word(text, "C")).toBe("C:\\src\\a-b_c.ts");
    expect(word(text, "src")).toBe("C:\\src\\a-b_c.ts");
    expect(word(text, "ts")).toBe("C:\\src\\a-b_c.ts");
    expect(word("see c:/x now", "x")).toBe("c:/x");
    expect(word("see c:/x now", ":")).toBe("c:/x");
  });

  it("keeps a colon out of a word when it is not a drive's", () => {
    expect(word("a: b", ":")).toBe(":");
    expect(word("a: b", "a")).toBe("a");
    expect(word("ab:\\x", ":")).toBe(":");
    expect(word("ab:\\x", "b")).toBe("ab");
    expect(word("ab:\\x", "x")).toBe("\\x");
  });

  it("takes a URL whole, to the next space", () => {
    const text = "go to https://x.dev/a?b=1 now";
    expect(word(text, "https")).toBe("https://x.dev/a?b=1");
    expect(word(text, "=")).toBe("https://x.dev/a?b=1");
  });

  it("leaves off a link's trailing punctuation, and a closing bracket or quote the link does not open", () => {
    expect(word("(see https://x.dev/a).", "https")).toBe("https://x.dev/a");
    expect(word("at https://en.wikipedia.org/wiki/Foo_(bar) now", "https")).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
    expect(word("at https://en.wikipedia.org/wiki/Foo_(bar).", "wiki")).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
    expect(word('"https://x.dev/a?", she said', "x.dev")).toBe("https://x.dev/a");
    expect(word("[https://x.dev/a]: and https://x.dev/b'.", "https")).toBe("https://x.dev/a");
    expect(word("[https://x.dev/a]: and https://x.dev/b'.", "x.dev/b")).toBe("https://x.dev/b");
    expect(word("it's https://x.dev/'a' ok", "https")).toBe("https://x.dev/'a'");
    expect(word("go to https://x.dev/a?b=1 now", "https")).toBe("https://x.dev/a?b=1");
  });

  it("takes a character a link leaves off alone (the user's choice at Task 9's review, 2026-10-27)", () => {
    expect(word("(see https://x.dev/a).", ")")).toBe(")");
    expect(word("(see https://x.dev/a).", ".", 20)).toBe(".");
    expect(word("see https://x.dev/a.", ".", 14)).toBe("."); // the final ., not the word to its left
  });

  it("takes a character that is not part of a word alone", () => {
    expect(word("see now", " ")).toBe(" ");
    expect(word("f(x)", "(")).toBe("(");
  });

  it("takes letters of any script as letters", () => {
    expect(word("日本 語", "本")).toBe("日本");
    expect(word("x a\u{1d4b3}b y", "\u{1d4b3}")).toBe("a\u{1d4b3}b"); // a letter outside the basic plane, two UTF-16 units
    expect(word("x cafés y", "f")).toBe("cafés"); // a combining mark
  });

  it("takes an emoji alone", () => {
    expect(word("a 🦀 b", "🦀")).toBe("🦀");
    expect(word("ab🦀cd", "🦀")).toBe("🦀");
  });

  it("takes nothing at a line's end or on an empty line", () => {
    expect(wordAt("abc", 3)).toEqual({ start: 3, end: 3 });
    expect(wordAt("", 0)).toEqual({ start: 0, end: 0 });
  });
});

describe("clicks", () => {
  it("counts 1, 2, 3 on the same cell within CLICK_MS, then 1 again", () => {
    expect(clicks(null, 1000, 5, 3)).toBe(1);
    expect(clicks({ at: 1000, x: 5, y: 3, count: 1 }, 1200, 5, 3)).toBe(2);
    expect(clicks({ at: 1200, x: 5, y: 3, count: 2 }, 1400, 5, 3)).toBe(3);
    expect(clicks({ at: 1400, x: 5, y: 3, count: 3 }, 1600, 5, 3)).toBe(1);
    expect(clicks({ at: 1000, x: 5, y: 3, count: 1 }, 1000 + CLICK_MS, 5, 3)).toBe(2);
  });

  it("counts a press 501 ms later, or one cell away, as 1", () => {
    expect(clicks({ at: 1000, x: 5, y: 3, count: 1 }, 1501, 5, 3)).toBe(1);
    expect(clicks({ at: 1000, x: 5, y: 3, count: 1 }, 1100, 6, 3)).toBe(1);
    expect(clicks({ at: 1000, x: 5, y: 3, count: 1 }, 1100, 5, 4)).toBe(1);
  });
});

describe("placeAt", () => {
  it("gives the place before the character under a cell inside the text", () => {
    expect(placeAt(rowsOf(20, [{ text: "hello" }]), 0, 1)).toEqual({ pos: { line: 0, offset: 1 }, past: false });
  });

  it("gives a wide character from its second column", () => {
    const rows = rowsOf(20, [{ text: "a日本b" }]);
    expect(placeAt(rows, 0, 2)).toEqual({ pos: { line: 0, offset: 1 }, past: false });
    expect(placeAt(rows, 0, 4)).toEqual({ pos: { line: 0, offset: 2 }, past: false });
    expect(placeAt(rows, 0, 5)).toEqual({ pos: { line: 0, offset: 3 }, past: false });
  });

  it("gives the row's end past its text, a wrapped row's end being where the next row starts", () => {
    expect(placeAt(rowsOf(20, [{ text: "hello" }]), 0, 9)).toEqual({ pos: { line: 0, offset: 5 }, past: true });
    const wrapped = rowsOf(12, [{ text: "the quick brown fox" }]);
    expect(placeAt(wrapped, 0, 11)).toEqual({ pos: { line: 0, offset: 10 }, past: true });
    expect(placeAt(wrapped, 1, 0)).toEqual({ pos: { line: 0, offset: 10 }, past: false });
  });

  it("gives an empty line's only place, past its text", () => {
    expect(placeAt(rowsOf(20, [{ text: "a" }, { text: "" }]), 1, 0)).toEqual({ pos: { line: 1, offset: 0 }, past: true });
  });

  it("gives a one-line entry's end past its row's text, and on the … that cuts it", () => {
    const rows = rowsOf(10, [{ text: "x".repeat(30), oneLine: true }, { text: "short", oneLine: true }]);
    expect(placeAt(rows, 0, 3)).toEqual({ pos: { line: 0, offset: 3 }, past: false });
    expect(placeAt(rows, 0, 9)).toEqual({ pos: { line: 0, offset: 30 }, past: true });
    expect(placeAt(rows, 0, 12)).toEqual({ pos: { line: 0, offset: 30 }, past: true });
    expect(placeAt(rows, 1, 7)).toEqual({ pos: { line: 1, offset: 5 }, past: true });
  });

  it("gives the tab for a column inside the spaces it is drawn as, its stops counted from the row's start", () => {
    const rows = rowsOf(20, [{ text: "a\tb" }]);
    expect(placeAt(rows, 0, 3)).toEqual({ pos: { line: 0, offset: 1 }, past: false });
    expect(placeAt(rows, 0, 7)).toEqual({ pos: { line: 0, offset: 1 }, past: false });
    expect(placeAt(rows, 0, 8)).toEqual({ pos: { line: 0, offset: 2 }, past: false });
    const wrapped = rowsOf(10, [{ text: "abcdefghij\tx" }]); // the second row is "\tx", drawn "        x"
    expect(placeAt(wrapped, 1, 4)).toEqual({ pos: { line: 0, offset: 10 }, past: false });
    expect(placeAt(wrapped, 1, 8)).toEqual({ pos: { line: 0, offset: 11 }, past: false });
  });
});
