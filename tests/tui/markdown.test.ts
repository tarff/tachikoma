import { describe, expect, it } from "vitest";
import type { Line } from "../../src/tui/describe.js";
import { markdownLines } from "../../src/tui/markdown.js";
import { type Look, palette } from "../../src/tui/theme.js";

// TUI design pass, Task 15: a reply's markdown as styled lines (design, "5. Markdown"), laid out for the width it is given.
const FULL: Look = { light: false, color: true, full: true };
const NONE: Look = { light: false, color: false, full: false };
const P = palette(FULL);
const ACCENT = P.accent;
const MUTED = P.muted;

const texts = (lines: Line[]) => lines.map((l) => l.text);

describe("markdownLines, each piece", () => {
  it("draws a paragraph as its text, one line however long, as the screen wraps it", () => {
    expect(markdownLines("hello world", 80, P)).toEqual([{ text: "hello world" }]);
    const long = "word ".repeat(30).trim();
    expect(markdownLines(long, 20, P)).toEqual([{ text: long }]);
  });

  it("keeps a paragraph's line breaks, a line for each", () => {
    expect(markdownLines("one\ntwo", 80, P)).toEqual([{ text: "one" }, { text: "two" }]);
  });

  it("draws a heading bold in the accent colour, its marks not drawn", () => {
    expect(markdownLines("# Title", 80, P)).toEqual([{ text: "Title", styles: [{ start: 0, end: 5, bold: true, color: ACCENT }] }]);
    expect(markdownLines("### Small `x`", 80, P)).toEqual([
      { text: "Small x", styles: [{ start: 0, end: 7, bold: true, color: ACCENT }, { start: 6, end: 7, color: ACCENT }] },
    ]);
    expect(texts(markdownLines("Setext\n===", 80, P))).toEqual(["Setext"]);
  });

  it("draws bold, italic and inline code, the marks not drawn", () => {
    expect(markdownLines("a **b** *c* `d`", 80, P)).toEqual([
      {
        text: "a b c d",
        styles: [
          { start: 2, end: 3, bold: true },
          { start: 4, end: 5, italic: true },
          { start: 6, end: 7, color: ACCENT },
        ],
      },
    ]);
    // Nested: bold italic.
    expect(markdownLines("***x***", 80, P)[0]!.styles).toEqual(
      expect.arrayContaining([
        { start: 0, end: 1, bold: true },
        { start: 0, end: 1, italic: true },
      ]),
    );
  });

  it("draws a bulleted list two columns in, `-` before each item, later rows under the item's text", () => {
    expect(markdownLines("- one\n- two", 80, P)).toEqual([
      { text: "  - one", indent: 4 },
      { text: "  - two", indent: 4 },
    ]);
    expect(texts(markdownLines("* star\n* again", 80, P))).toEqual(["  - star", "  - again"]);
  });

  it("draws a numbered list by its own numbers, from its start", () => {
    expect(markdownLines("3. x\n4. y", 80, P)).toEqual([
      { text: "  3. x", indent: 5 },
      { text: "  4. y", indent: 5 },
    ]);
  });

  it("puts a nested list under its item's text, further in at each level", () => {
    expect(markdownLines("- a\n  - b\n    - c\n- d", 80, P)).toEqual([
      { text: "  - a", indent: 4 },
      { text: "    - b", indent: 6 },
      { text: "      - c", indent: 8 },
      { text: "  - d", indent: 4 },
    ]);
    expect(markdownLines("1. a\n   - b", 80, P)).toEqual([
      { text: "  1. a", indent: 5 },
      { text: "     - b", indent: 7 },
    ]);
  });

  it("keeps an item's later lines and paragraphs under its text, and an empty line where the source has one", () => {
    expect(markdownLines("- a\n  more\n\n  second\n- b", 80, P)).toEqual([
      { text: "  - a", indent: 4 },
      { text: "    more", indent: 4 },
      { text: "" },
      { text: "    second", indent: 4 },
      { text: "  - b", indent: 4 },
    ]);
    expect(texts(markdownLines("- a\n\n- b", 80, P))).toEqual(["  - a", "", "  - b"]);
  });

  it("draws a task item's box as written", () => {
    expect(texts(markdownLines("- [ ] to do\n- [x] done", 80, P))).toEqual(["  - [ ] to do", "  - [x] done"]);
    expect(texts(markdownLines("- [ ] a\n\n- [x] b", 80, P))).toEqual(["  - [ ] a", "", "  - [x] b"]);
  });

  it("draws a block quote behind a muted `│ `, a bare `│` on its empty lines", () => {
    const bar = { start: 0, end: 2, color: MUTED };
    expect(markdownLines("> hi\n>\n> there", 80, P)).toEqual([
      { text: "│ hi", styles: [bar], indent: 2 },
      { text: "│", styles: [{ start: 0, end: 1, color: MUTED }] },
      { text: "│ there", styles: [bar], indent: 2 },
    ]);
    expect(texts(markdownLines("> > deep\n> - li", 80, P))).toEqual(["│ │ deep", "│   - li"]);
    expect(markdownLines("> **b**", 80, P)[0]!.styles).toEqual([bar, { start: 2, end: 3, bold: true }]);
  });

  it("draws a link's text underlined and its address after it, muted", () => {
    expect(markdownLines("see [docs](https://x.y/z)", 80, P)).toEqual([
      {
        text: "see docs https://x.y/z",
        styles: [
          { start: 4, end: 8, underline: true },
          { start: 9, end: 22, color: MUTED },
        ],
      },
    ]);
  });

  it("draws a link whose text is its address once", () => {
    const once = [{ text: "https://x.y", styles: [{ start: 0, end: 11, underline: true }] }];
    expect(markdownLines("[https://x.y](https://x.y)", 80, P)).toEqual(once);
    expect(markdownLines("<https://x.y>", 80, P)).toEqual(once);
    expect(markdownLines("https://x.y", 80, P)).toEqual(once);
    // An autolink's text is its address as written (marked's `autolink`), though marked adds "mailto:" or "http://".
    expect(texts(markdownLines("<a@b.c> www.x.y", 80, P))).toEqual(["a@b.c www.x.y"]);
  });

  it("draws a code block on the band, one colour, its fences and language not drawn", () => {
    expect(markdownLines("```ts\nconst a = 1;\n\n  b();\n```", 80, P)).toEqual([
      { text: "const a = 1;", band: true },
      { text: "", band: true },
      { text: "  b();", band: true },
    ]);
    expect(markdownLines("    indented", 80, P)).toEqual([{ text: "indented", band: true }]);
  });

  it("draws a code block's markdown-looking lines raw", () => {
    expect(markdownLines("```\n# not a heading\n**not bold** `x`\n- not a list\n| a | b |\n|---|---|\n```", 80, P)).toEqual([
      { text: "# not a heading", band: true },
      { text: "**not bold** `x`", band: true },
      { text: "- not a list", band: true },
      { text: "| a | b |", band: true },
      { text: "|---|---|", band: true },
    ]);
  });

  it("draws a code block in a list under the item's text", () => {
    expect(markdownLines("- item\n\n  ```\n  code\n  ```", 80, P)).toEqual([
      { text: "  - item", indent: 4 },
      { text: "" },
      { text: "    code", band: true, indent: 4 },
    ]);
  });

  it("draws a rule as a muted `─` line the width given, on one row", () => {
    expect(markdownLines("---", 10, P)).toEqual([{ text: "─".repeat(10), styles: [{ start: 0, end: 10, color: MUTED }], oneLine: true }]);
    expect(markdownLines("> ***", 10, P)[0]!.text).toBe(`│ ${"─".repeat(8)}`);
  });

  it("draws raw HTML as its text", () => {
    expect(texts(markdownLines("<div>\nhi\n</div>", 80, P))).toEqual(["<div>", "hi", "</div>"]);
    expect(markdownLines("a <b>x</b> c", 80, P)).toEqual([{ text: "a <b>x</b> c" }]);
  });

  it("draws anything else the lexer gives as its raw text", () => {
    expect(markdownLines("~~gone~~ ![alt](p.png)", 80, P)).toEqual([{ text: "~~gone~~ ![alt](p.png)" }]);
    expect(texts(markdownLines("[r][1]\n\n[1]: https://r.s", 80, P))).toEqual(["r https://r.s", "", "[1]: https://r.s"]);
    expect(markdownLines("a\\*b", 80, P)).toEqual([{ text: "a*b" }]); // an escape is its character
  });
});

describe("markdownLines, tables", () => {
  const TABLE = "| a | bb |\n|---|---:|\n| 1 | **2** |";
  const BOX = ["╭───┬────╮", "│ a │ bb │", "├───┼────┤", "│ 1 │  2 │", "╰───┴────╯"];

  it("draws a table that fits with rounded box lines, each row one line, the lines muted", () => {
    const lines = markdownLines(TABLE, 10, P);
    expect(texts(lines)).toEqual(BOX);
    for (const l of lines) expect(l.oneLine).toBe(true);
    expect(lines[0]!.styles).toEqual([{ start: 0, end: 10, color: MUTED }]);
    expect(lines[3]!.styles).toEqual([
      { start: 0, end: 1, color: MUTED },
      { start: 4, end: 5, color: MUTED },
      { start: 7, end: 8, bold: true },
      { start: 9, end: 10, color: MUTED },
    ]);
  });

  it("aligns a column as its row of dashes says", () => {
    expect(texts(markdownLines("| left | mid | right |\n|:-|:-:|-:|\n| a | b | c |", 80, P))).toEqual([
      "╭──────┬─────┬───────╮",
      "│ left │ mid │ right │",
      "├──────┼─────┼───────┤",
      "│ a    │  b  │     c │",
      "╰──────┴─────┴───────╯",
    ]);
  });

  it("leaves a table one column too wide as its raw text, lines that wrap", () => {
    expect(markdownLines(TABLE, 9, P)).toEqual([{ text: "| a | bb |" }, { text: "|---|---:|" }, { text: "| 1 | **2** |" }]);
  });

  it("measures a table in a list or a quote against the width less their lead", () => {
    const listed = `- x\n\n  ${TABLE.replaceAll("\n", "\n  ")}`;
    expect(texts(markdownLines(listed, 14, P)).slice(2)).toEqual(BOX.map((r) => `    ${r}`));
    expect(texts(markdownLines(listed, 13, P)).slice(2)).toEqual(["    | a | bb |", "    |---|---:|", "    | 1 | **2** |"]);
    expect(texts(markdownLines(`> ${TABLE.replaceAll("\n", "\n> ")}`, 12, P))[0]).toBe(`│ ${BOX[0]}`);
  });

  it("measures cells by the columns they take, wide characters and links' addresses included", () => {
    expect(texts(markdownLines("| 日本 | [l](u) |\n|---|---|\n| x | y |", 80, P))).toEqual([
      "╭──────┬─────╮",
      "│ 日本 │ l u │",
      "├──────┼─────┤",
      "│ x    │ y   │",
      "╰──────┴─────╯",
    ]);
  });
});

describe("markdownLines, mixed", () => {
  it("draws a reply of many pieces, an empty line where the source has blank ones, none at its ends", () => {
    const md = "\n\n## Plan\nDo **this**:\n\n1. read\n2. `edit`\n\n\n```\nx\n```\n\n| k | v |\n|---|---|\n| a | b |\n\n";
    const lines = markdownLines(md, 40, P);
    expect(texts(lines)).toEqual([
      "Plan",
      "Do this:",
      "",
      "  1. read",
      "  2. edit",
      "",
      "x",
      "",
      "╭───┬───╮",
      "│ k │ v │",
      "├───┼───┤",
      "│ a │ b │",
      "╰───┴───╯",
    ]);
    expect(lines[0]!.styles).toEqual([{ start: 0, end: 4, bold: true, color: ACCENT }]);
    expect(lines[1]!.styles).toEqual([{ start: 3, end: 7, bold: true }]);
    expect(lines[4]!.styles).toEqual([{ start: 5, end: 9, color: ACCENT }]);
    expect(lines[6]!.band).toBe(true);
  });

  it("gives nothing for empty text", () => {
    expect(markdownLines("", 80, P)).toEqual([]);
    expect(markdownLines("\n\n", 80, P)).toEqual([]);
  });
});

describe("markdownLines, what it shows", () => {
  it("escapes control characters as the screen does, keeping tabs in prose", () => {
    expect(markdownLines("a\u001b[31mb\tc", 80, P)).toEqual([{ text: "a\\u001b[31mb\tc" }]);
    expect(markdownLines("**x\u0007**", 80, P)).toEqual([{ text: "x\\u0007", styles: [{ start: 0, end: 7, bold: true }] }]);
    expect(markdownLines("```\n\u001b]52;c;x\u0007\n```", 80, P)[0]!.text).toBe("\\u001b]52;c;x\\u0007");
  });

  it("measures a table cell as escaped, its tab shown as one column", () => {
    const lines = markdownLines("| a\u0007 | b\tc |\n|---|---|\n| 1 | 2 |", 80, P);
    expect(lines[1]!.text).toBe("│ a\\u0007 │ b⇥c │");
    expect(lines[0]!.text).toBe("╭─────────┬─────╮");
  });

  it("draws with no colour: the same text, bold, italic and underline kept, no colour anywhere", () => {
    const none = palette(NONE);
    const md = "# H\n\n**b** *i* `c` [l](u)\n\n> q\n\n---\n\n```\nk\n```\n\n| a |\n|---|\n| 1 |";
    const lines = markdownLines(md, 20, none);
    expect(texts(lines)).toEqual(texts(markdownLines(md, 20, P)));
    for (const l of lines) for (const s of l.styles ?? []) expect(s.color === undefined && s.bg === undefined).toBe(true);
    expect(lines[0]!.styles).toEqual([{ start: 0, end: 1, bold: true }]);
    expect(lines[2]!.styles).toEqual([
      { start: 0, end: 1, bold: true },
      { start: 2, end: 3, italic: true },
      { start: 6, end: 7, underline: true },
    ]);
    expect(lines.find((l) => l.text === "k")!.band).toBe(true); // the band is drawn as plain rows without colour (theme.ts)
  });
});
