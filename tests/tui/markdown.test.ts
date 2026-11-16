import { describe, expect, it } from "vitest";
import { type Line, screen } from "../../src/tui/describe.js";
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

  it("draws a bulleted list two columns in, `•` before each item, later rows under the item's text", () => {
    expect(markdownLines("- one\n- two", 80, P)).toEqual([
      { text: "  • one", indent: 4 },
      { text: "  • two", indent: 4 },
    ]);
    expect(texts(markdownLines("* star\n* again", 80, P))).toEqual(["  • star", "  • again"]);
  });

  it("draws a numbered list by its own numbers, from its start", () => {
    expect(markdownLines("3. x\n4. y", 80, P)).toEqual([
      { text: "  3. x", indent: 5 },
      { text: "  4. y", indent: 5 },
    ]);
  });

  it("puts a nested list under its item's text, further in at each level", () => {
    expect(markdownLines("- a\n  - b\n    - c\n- d", 80, P)).toEqual([
      { text: "  • a", indent: 4 },
      { text: "    ◦ b", indent: 6 },
      { text: "      • c", indent: 8 },
      { text: "  • d", indent: 4 },
    ]);
    expect(markdownLines("1. a\n   - b", 80, P)).toEqual([
      { text: "  1. a", indent: 5 },
      { text: "     • b", indent: 7 },
    ]);
  });

  it("alternates `•` and `◦` by the bulleted lists above, a numbered list keeping its numbers between them", () => {
    // The user's choice (2026-11-16): "• then ◦ when nested"; the depth counts bulleted lists only.
    expect(texts(markdownLines("- a\n  1. n\n     - b\n       - c", 80, P))).toEqual(["  • a", "    1. n", "       ◦ b", "         • c"]);
    expect(texts(markdownLines("1. n\n   - a\n     - b", 80, P))).toEqual(["  1. n", "     • a", "       ◦ b"]);
    expect(texts(markdownLines("- a\n\n  > - q", 80, P))).toEqual(["  • a", "", "    │   ◦ q"]);
  });

  it("keeps an item's later lines and paragraphs under its text, and an empty line where the source has one", () => {
    expect(markdownLines("- a\n  more\n\n  second\n- b", 80, P)).toEqual([
      { text: "  • a", indent: 4 },
      { text: "    more", indent: 4 },
      { text: "" },
      { text: "    second", indent: 4 },
      { text: "  • b", indent: 4 },
    ]);
    expect(texts(markdownLines("- a\n\n- b", 80, P))).toEqual(["  • a", "", "  • b"]);
  });

  it("draws a task item's box as written", () => {
    expect(texts(markdownLines("- [ ] to do\n- [x] done", 80, P))).toEqual(["  • [ ] to do", "  • [x] done"]);
    expect(texts(markdownLines("- [ ] a\n\n- [x] b", 80, P))).toEqual(["  • [ ] a", "", "  • [x] b"]);
  });

  it("draws a block quote behind a muted `│ `, a bare `│` on its empty lines", () => {
    const bar = { start: 0, end: 2, color: MUTED };
    expect(markdownLines("> hi\n>\n> there", 80, P)).toEqual([
      { text: "│ hi", styles: [bar], indent: 2 },
      { text: "│", styles: [{ start: 0, end: 1, color: MUTED }] },
      { text: "│ there", styles: [bar], indent: 2 },
    ]);
    expect(texts(markdownLines("> > deep\n> - li", 80, P))).toEqual(["│ │ deep", "│   • li"]);
    expect(markdownLines("> **b**", 80, P)[0]!.styles).toEqual([bar, { start: 2, end: 3, bold: true }]);
  });

  // The user's choice (2026-11-16): "In brackets". Its text and the address inside the brackets, not the brackets, open
  // the address (clickable links plan, Task 4; decision 4).
  it("draws a link's text underlined and its address after it in brackets, muted, both linked", () => {
    expect(markdownLines("see [docs](https://x.y/z)", 80, P)).toEqual([
      {
        text: "see docs (https://x.y/z)",
        styles: [
          { start: 4, end: 8, underline: true },
          { start: 4, end: 8, link: "https://x.y/z" },
          { start: 9, end: 24, color: MUTED },
          { start: 10, end: 23, link: "https://x.y/z" },
        ],
      },
    ]);
  });

  // Task 15's code review: no space before the address where the link drew no text, no brackets with no address.
  it("draws a link with no text as its address alone, and one with no address as its text", () => {
    expect(markdownLines("see [](http://x.y)", 80, P)).toEqual([
      {
        text: "see (http://x.y)",
        styles: [
          { start: 4, end: 16, color: MUTED },
          { start: 5, end: 15, link: "http://x.y" },
        ],
      },
    ]);
    expect(texts(markdownLines("[](u)", 80, P))).toEqual(["(u)"]);
    expect(markdownLines("[x](<>)", 80, P)).toEqual([
      {
        text: "x",
        styles: [
          { start: 0, end: 1, underline: true },
          { start: 0, end: 1, link: "" },
        ],
      },
    ]);
  });

  it("draws a link whose text is its address once, linked", () => {
    const once = [
      {
        text: "https://x.y",
        styles: [
          { start: 0, end: 11, underline: true },
          { start: 0, end: 11, link: "https://x.y" },
        ],
      },
    ];
    expect(markdownLines("[https://x.y](https://x.y)", 80, P)).toEqual(once);
    expect(markdownLines("<https://x.y>", 80, P)).toEqual(once);
    expect(markdownLines("https://x.y", 80, P)).toEqual(once);
    // An autolink's text is its address as written (marked's `autolink`), though marked adds "mailto:" or "http://": a
    // www. one opens https:// (clickable links plan, decision 3), an e-mail none.
    expect(markdownLines("<a@b.c> www.x.y", 80, P)).toEqual([
      {
        text: "a@b.c www.x.y",
        styles: [
          { start: 0, end: 5, underline: true },
          { start: 0, end: 5, link: "" },
          { start: 6, end: 13, underline: true },
          { start: 6, end: 13, link: "https://www.x.y" },
        ],
      },
    ]);
  });

  // Clickable links plan, Task 4: the text opens the address in the brackets, even where it is another address
  // (decision 7). A link definition's use opens its address (below, "draws a reference link as any link").
  it("links a link's text to the address in its brackets, even where the text is another address", () => {
    expect(markdownLines("[https://a.example](https://b.example)", 80, P)[0]!.styles).toEqual([
      { start: 0, end: 17, underline: true },
      { start: 0, end: 17, link: "https://b.example" },
      { start: 18, end: 37, color: MUTED },
      { start: 19, end: 36, link: "https://b.example" },
    ]);
  });

  // Clickable links plan, Task 4: an address that is not http, https or www., or has no host (the review's finding 3),
  // is handled and not a link, `link: ""`, its text drawn as before.
  it.each([
    { md: "[x](mailto:a@b.c)", text: "x (mailto:a@b.c)" },
    { md: "[x](./a.md)", text: "x (./a.md)" },
    { md: "[x](file:///c:/a)", text: "x (file:///c:/a)" },
    { md: "[docs](https://)", text: "docs (https://)" },
    { md: "[d](http://)", text: "d (http://)" },
    { md: "[d](https://:80)", text: "d (https://:80)" },
  ])("marks a link to $md as no link, drawn as before", ({ md, text }) => {
    const label = text.indexOf(" (");
    expect(markdownLines(md, 80, P)).toEqual([
      {
        text,
        styles: [
          { start: 0, end: label, underline: true },
          { start: 0, end: label, link: "" },
          { start: label + 1, end: text.length, color: MUTED },
          { start: label + 2, end: text.length - 1, link: "" },
        ],
      },
    ]);
  });

  // The second review's finding 2: screen()'s pass for bare addresses leaves a refused link alone, its label and its
  // address, so a www. inside either is not opened as https://www.….
  it.each([
    { md: "[local](file:///www.example.org)", text: "local (file:///www.example.org)" },
    { md: "[see www.a.com](file:///x)", text: "see www.a.com (file:///x)" },
  ])("links no address inside a refused link to $md, once screened", ({ md, text }) => {
    const line = screen(markdownLines(md, 80, P)[0]!);
    expect(line.text).toBe(text);
    expect(line.styles?.filter((s) => s.link)).toEqual([]);
  });

  // Task 4's code review: a link's www. address opens https:// (decision 3), and a space in an address is encoded.
  it("opens a link to a www. address as https://, and one with a space with the space encoded", () => {
    expect(markdownLines("[x](www.a.b)", 80, P)[0]!.styles).toEqual([
      { start: 0, end: 1, underline: true },
      { start: 0, end: 1, link: "https://www.a.b" },
      { start: 2, end: 11, color: MUTED },
      { start: 3, end: 10, link: "https://www.a.b" },
    ]);
    expect(markdownLines("[x](<https://a.b/c d>)", 80, P)).toEqual([
      {
        text: "x (https://a.b/c d)",
        styles: [
          { start: 0, end: 1, underline: true },
          { start: 0, end: 1, link: "https://a.b/c%20d" },
          { start: 2, end: 19, color: MUTED },
          { start: 3, end: 18, link: "https://a.b/c%20d" },
        ],
      },
    ]);
  });

  // Task 4's code review: a picture is drawn as written; where its address is refused, as a refused link's is, its
  // text is no link, so screen() finds no www. inside it; with a web address, screen() links the address as in prose.
  it("marks a picture with a refused address as no link, and leaves one with a web address to screen()", () => {
    const refused = "![p](file:///www.x.y/p.png)";
    const none = { start: 0, end: refused.length, link: "" };
    expect(markdownLines(refused, 80, P)).toEqual([{ text: refused, styles: [none] }]);
    expect(screen(markdownLines(refused, 80, P)[0]!).styles?.filter((s) => s.link)).toEqual([]);
    const good = "![p](https://a.b/p.png)";
    expect(markdownLines(good, 80, P)).toEqual([{ text: good }]);
    expect(screen(markdownLines(good, 80, P)[0]!).styles).toEqual([{ start: 5, end: 22, link: "https://a.b/p.png" }]);
  });

  // Task 4's code review: a link's spans where a list's lead and a table's bar and space move its text.
  it("puts a link's spans under its text in a list item and in a table cell", () => {
    expect(markdownLines("- [d](https://a.b)", 80, P)).toEqual([
      {
        text: "  • d (https://a.b)",
        styles: [
          { start: 4, end: 5, underline: true },
          { start: 4, end: 5, link: "https://a.b" },
          { start: 6, end: 19, color: MUTED },
          { start: 7, end: 18, link: "https://a.b" },
        ],
        indent: 4,
      },
    ]);
    const header = markdownLines("| [d](https://a.b) |\n|---|\n| x |", 80, P)[1]!;
    expect(header.text).toBe("│ d (https://a.b) │");
    expect(header.styles).toEqual([
      { start: 0, end: 1, color: MUTED },
      { start: 2, end: 3, underline: true },
      { start: 2, end: 3, link: "https://a.b" },
      { start: 4, end: 17, color: MUTED },
      { start: 5, end: 16, link: "https://a.b" },
      { start: 18, end: 19, color: MUTED },
    ]);
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

  // Its band from where its text starts, an empty line's too (Task 16's spec review, "Band from the text").
  it("draws a code block in a list under the item's text", () => {
    expect(markdownLines("- item\n\n  ```\n  code\n\n  more\n  ```", 80, P)).toEqual([
      { text: "  • item", indent: 4 },
      { text: "" },
      { text: "    code", band: true, bandFrom: 4, indent: 4 },
      { text: "", band: true, bandFrom: 4 },
      { text: "    more", band: true, bandFrom: 4, indent: 4 },
    ]);
  });

  it("starts a code block's band in a quote after the quote's bar", () => {
    expect(markdownLines("> ```\n> code\n> ```", 80, P)).toEqual([
      { text: "│ code", band: true, bandFrom: 2, styles: [{ start: 0, end: 2, color: P.muted }], indent: 2 },
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

  // The user's choice (2026-11-16): "Struck through".
  it("draws a strikethrough struck through, its marks not drawn", () => {
    expect(markdownLines("a ~~gone~~ b", 80, P)).toEqual([{ text: "a gone b", styles: [{ start: 2, end: 6, strike: true }] }]);
  });

  // The user's choice (2026-11-16): "Hide them".
  it("draws a reference link as any link, its definition not at all, no empty line left in its place", () => {
    expect(markdownLines("[r][1]\n\n[1]: https://r.s", 80, P)).toEqual([
      {
        text: "r (https://r.s)",
        styles: [
          { start: 0, end: 1, underline: true },
          { start: 0, end: 1, link: "https://r.s" }, // its use opens its address (clickable links plan, Task 4)
          { start: 2, end: 15, color: MUTED },
          { start: 3, end: 14, link: "https://r.s" },
        ],
      },
    ]);
    expect(texts(markdownLines("a\n\n[1]: https://r.s\n\nb [x][1]", 80, P))).toEqual(["a", "", "b x (https://r.s)"]);
    expect(texts(markdownLines("- a\n\n  [1]: https://r.s\n\n  b", 80, P))).toEqual(["  • a", "", "    b"]);
  });

  it("draws anything else the lexer gives as its raw text", () => {
    // a picture's relative address no link (Task 4's code review)
    expect(markdownLines("![alt](p.png)", 80, P)).toEqual([
      { text: "![alt](p.png)", styles: [{ start: 0, end: 13, link: "" }] },
    ]);
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
      "╭──────┬───────╮",
      "│ 日本 │ l (u) │",
      "├──────┼───────┤",
      "│ x    │ y     │",
      "╰──────┴───────╯",
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

  // Task 15's code review: each style's piece on each row it reaches, in the spans' own order, so a later draws over an
  // earlier on every row.
  it("splits a styled paragraph's spans over its rows, in their order", () => {
    expect(markdownLines("**x *y\nz* w**\n`c` d", 80, P)).toEqual([
      { text: "x y", styles: [{ start: 0, end: 3, bold: true }, { start: 2, end: 3, italic: true }] },
      { text: "z w", styles: [{ start: 0, end: 3, bold: true }, { start: 0, end: 1, italic: true }] },
      { text: "c d", styles: [{ start: 0, end: 1, color: ACCENT }] },
    ]);
  });

  // Task 15's code review: marked's lexer recurses into each level, so input nested thousands deep overflows the stack;
  // it is drawn as its raw text instead. Ten times past where it overflows, as a warmed-up V8 goes deeper (the re-check).
  const DEEP = ">".repeat(30000);
  it("draws input nested too deep for the lexer as its raw text", () => {
    for (const deep of ["*".repeat(30000) + "x" + "*".repeat(30000), "- ".repeat(20000) + "x", "> - ".repeat(20000) + "x", `${DEEP} x`]) {
      expect(markdownLines(deep, 80, P)).toEqual([{ text: deep }]);
    }
    expect(markdownLines(`${DEEP} x\r\n\ty`, 80, P)).toEqual([{ text: `${DEEP} x` }, { text: "\ty" }]);
  });

  // The re-check: the raw text's blank lines as the markdown path draws them, none at either end and a run of them one.
  it("draws too-deep input with no empty line at either end and one for a run of blank lines", () => {
    expect(markdownLines(`\n\n${DEEP} x\n\n\n\ny\n \n`, 80, P)).toEqual([{ text: `${DEEP} x` }, { text: "" }, { text: "y" }]);
  });
});

// Task 15's code review: what the reviewer found right, pinned.
describe("markdownLines, edges", () => {
  it("reads CRLF line breaks as line breaks", () => {
    expect(texts(markdownLines("a\r\nb\r\n\r\n- c\r\n\r\n```\r\nk\r\n```", 80, P))).toEqual(["a", "b", "", "  • c", "", "k"]);
  });

  it("draws a code block with no closing fence to the end of the text", () => {
    expect(markdownLines("```\ncode\n# not a heading", 80, P)).toEqual([
      { text: "code", band: true },
      { text: "# not a heading", band: true },
    ]);
  });

  it("pads a table's short rows and drops a row's extra cells", () => {
    expect(texts(markdownLines("| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |", 80, P))).toEqual([
      "╭───┬───╮",
      "│ a │ b │",
      "├───┼───┤",
      "│ 1 │   │",
      "│ 1 │ 2 │",
      "╰───┴───╯",
    ]);
  });

  it("draws an escaped pipe in a cell as a pipe", () => {
    expect(texts(markdownLines("| a \\| b | c |\n|---|---|\n| 1 | 2 |", 80, P))).toEqual([
      "╭───────┬───╮",
      "│ a | b │ c │",
      "├───────┼───┤",
      "│ 1     │ 2 │",
      "╰───────┴───╯",
    ]);
  });

  it("draws an empty list item as its bullet alone, no space after it", () => {
    expect(markdownLines("- a\n-\n- c", 80, P)).toEqual([
      { text: "  • a", indent: 4 },
      { text: "  •" },
      { text: "  • c", indent: 4 },
    ]);
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

  // With no colour, inline code keeps its backticks and a code block its fences (Task 17's captures, the user's choice,
  // 2026-11-16: "Keep backticks"); the rest is the same text.
  it("draws with no colour: the same text, bold, italic, underline and strikethrough kept, no colour anywhere", () => {
    const none = palette(NONE);
    const md = "# H\n\n**b** *i* `c` [l](u) ~~s~~\n\n> q\n\n---\n\n```\nk\n```\n\n| a |\n|---|\n| 1 |";
    const lines = markdownLines(md, 20, none);
    const coloured = texts(markdownLines(md, 20, P));
    const k = coloured.indexOf("k");
    expect(texts(lines)).toEqual([...coloured.slice(0, k), "```", "k", "```", ...coloured.slice(k + 1)].map((t) => (t === "b i c l (u) s" ? "b i `c` l (u) s" : t)));
    for (const l of lines) for (const s of l.styles ?? []) expect(s.color === undefined && s.bg === undefined).toBe(true);
    expect(lines[0]!.styles).toEqual([{ start: 0, end: 1, bold: true }]);
    expect(lines[2]!.styles).toEqual([
      { start: 0, end: 1, bold: true },
      { start: 2, end: 3, italic: true },
      { start: 8, end: 9, underline: true },
      { start: 8, end: 9, link: "" }, // `u` is no web address (clickable links plan, Task 4)
      { start: 11, end: 12, link: "" },
      { start: 14, end: 15, strike: true },
    ]);
    expect(lines.find((l) => l.text === "k")!.band).toBe(true); // the band is drawn as plain rows without colour (theme.ts)
  });

  // Task 17's captures, the user's choice (2026-11-16, "Keep backticks"): where there is no colour to draw inline code
  // in, it keeps its backticks as written; where there is no band to draw a code block on (below full colour), it is
  // drawn between fence lines, its opening line as written and its fence again to close it, or ``` for an indented
  // block, so two blocks cannot run together. With the band, as before.
  it("marks code with its backticks and fences where there is no colour or band to draw it with", () => {
    const none = palette(NONE);
    const named = palette({ light: false, color: true, full: false });
    expect(markdownLines("run `npm test` now, or ``a`b``", 80, none)).toEqual([{ text: "run `npm test` now, or ``a`b``" }]);
    expect(markdownLines("run `npm test` now", 80, named)).toEqual([{ text: "run npm test now", styles: [{ start: 4, end: 12, color: "blue" }] }]);
    for (const p of [none, named]) {
      expect(markdownLines("```go\nx := 1\n```\n```\ny\n```", 80, p)).toEqual([
        { text: "```go" },
        { text: "x := 1", band: true },
        { text: "```" },
        { text: "```" },
        { text: "y", band: true },
        { text: "```" },
      ]);
      // Its opening line as written.
      expect(texts(markdownLines("~~~~ sh\nls\n~~~~", 80, p))).toEqual(["~~~~ sh", "ls", "~~~~"]);
      expect(texts(markdownLines("    indented", 80, p))).toEqual(["```", "indented", "```"]);
      expect(markdownLines("- item\n\n  ```\n  code\n  ```", 80, p)).toEqual([
        { text: "  • item", indent: 4 },
        { text: "" },
        { text: "    ```", indent: 4 },
        { text: "    code", band: true, bandFrom: 4, indent: 4 },
        { text: "    ```", indent: 4 },
      ]);
    }
    expect(texts(markdownLines("```go\nx\n```", 80, P))).toEqual(["x"]); // with the band: no fences
  });
});
