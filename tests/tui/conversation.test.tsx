import chalk from "chalk";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { isValidElement, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Conversation } from "../../src/tui/Conversation.js";
import { type Look, palette, ThemeContext } from "../../src/tui/theme.js";
import { type Pos, Rows } from "../../src/tui/view.js";

const mounted: ReturnType<typeof render>[] = [];
afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
});

// Rows at 9 columns, so with the bar's column a row is 10 wide.
function kept(n: number, color?: string) {
  const rows = new Rows(9);
  rows.add(Array.from({ length: n }, (_, i) => ({ text: `line ${i}`, ...(color ? { color } : {}) })));
  return rows;
}

// The Text elements the component hands Ink, with their colours: the test terminal draws no colour codes.
function texts(node: ReactNode): { color?: string; text: string }[] {
  if (Array.isArray(node)) return node.flatMap(texts);
  if (!isValidElement(node)) return [];
  const { children, color } = node.props as { children?: ReactNode; color?: string };
  if (node.type === Text) return [{ ...(color === undefined ? {} : { color }), text: String(children) }];
  return texts(children);
}

function draw(props: Parameters<typeof Conversation>[0]) {
  const app = render(<Conversation {...props} />);
  mounted.push(app);
  return app.lastFrame()!.split("\n");
}

describe("Conversation", () => {
  it("draws `height` rows from `first`", () => {
    expect(draw({ rows: kept(10), first: 3, height: 4, unseen: 0, following: false }).map((r) => r.slice(0, 9).trimEnd())).toEqual([
      "line 3",
      "line 4",
      "line 5",
      "line 6",
    ]);
  });

  it("pads with blank rows after the last line, so what is under it stays at the bottom", () => {
    expect(draw({ rows: kept(2), first: 0, height: 4, unseen: 0, following: true })).toEqual(["line 0", "line 1", "", ""]);
    // A view held past the bottom (view.ts, first): only the rows that exist are drawn.
    const held = draw({ rows: kept(10), first: 8, height: 4, unseen: 0, following: false });
    expect(held.map((r) => r.slice(0, 9).trimEnd())).toEqual(["line 8", "line 9", "", ""]);
  });

  it("draws each row in its line's colour", () => {
    const rows = new Rows(9);
    rows.add([{ text: "red one", color: "red" }, { text: "plain" }]);
    expect(texts(Conversation({ rows, first: 0, height: 2, unseen: 0, following: true }))).toEqual([
      { color: "red", text: "red one" },
      { text: "plain" },
    ]);
    // A row, the bar beside it, the count of new lines, the bar beside that.
    const colors = texts(Conversation({ rows: kept(20), first: 0, height: 2, unseen: 3, following: false })).map((t) => t.color);
    expect(colors).toEqual([undefined, "gray", "gray", "gray"]);
  });

  it("draws the scroll bar in the last column only when the lines are longer than the view", () => {
    expect(draw({ rows: kept(4), first: 0, height: 4, unseen: 0, following: true }).every((r) => r.length <= 9)).toBe(true);
    // 20 rows in a view of 10, at the top: bar(20, 10, 0) is a thumb of 5 rows from the first.
    const shown = draw({ rows: kept(20), first: 0, height: 10, unseen: 0, following: false });
    expect(shown.map((r) => r[9])).toEqual(["┃", "┃", "┃", "┃", "┃", "│", "│", "│", "│", "│"]);
    // At the bottom the thumb is at the foot, and stays there for a view held past it.
    expect(draw({ rows: kept(20), first: 10, height: 10, unseen: 0, following: true }).map((r) => r[9]).join("")).toBe("│││││┃┃┃┃┃");
    expect(draw({ rows: kept(20), first: 15, height: 10, unseen: 0, following: false }).map((r) => r[9]).join("")).toBe("│││││┃┃┃┃┃");
  });

  it("gives its last row to the count of new lines while not following, and not while following or with none", () => {
    const rows = kept(20);
    expect(draw({ rows, first: 2, height: 10, unseen: 2, following: false }).at(-1)).toMatch(/^↓ 2 new/);
    const wide = new Rows(40);
    wide.add(Array.from({ length: 20 }, (_, i) => ({ text: `line ${i}` })));
    const note = draw({ rows: wide, first: 2, height: 10, unseen: 1, following: false, bottom: "Ctrl+End" }).at(-1)!;
    expect(note.trimEnd().slice(0, 40).trimEnd()).toBe("↓ 1 new line · Ctrl+End");
    const bare = draw({ rows: wide, first: 2, height: 10, unseen: 1, following: false }).at(-1)!; // no key bound to scroll:bottom
    expect(bare.trimEnd().slice(0, 40).trimEnd()).toBe("↓ 1 new line");
    expect(draw({ rows: wide, first: 2, height: 10, unseen: 0, following: false }).at(-1)!.slice(0, 40).trimEnd()).toBe("line 11");
    expect(draw({ rows: wide, first: 10, height: 10, unseen: 3, following: true }).at(-1)!.slice(0, 40).trimEnd()).toBe("line 19");
  });

  // Ink colours through chalk, which finds no colour in a test's output, so this test turns it on for itself. chalk is
  // Ink's dependency, not ours, reached through Ink's install: were it ever to move, the import fails loudly.
  it("draws the selection in reverse colours as the row is drawn: a tab as its spaces, and the … that cuts a one-line entry", () => {
    const level = chalk.level;
    chalk.level = 1; // 1: chalk's basic 16 colours, enough for reverse (\u001b[7m)
    try {
      const rows = new Rows(20);
      rows.add([{ text: "a\tbc" }, { text: "x".repeat(30), oneLine: true }]);
      const reverse = (row: string) => [...row.matchAll(/\u001b\[7m(.*?)\u001b\[27m/g)].map((m) => m[1]).join("");
      const reversed = (selection: [Pos, Pos]) => draw({ rows, first: 0, height: 2, unseen: 0, following: true, selection }).map(reverse);
      expect(reversed([{ line: 0, offset: 1 }, { line: 0, offset: 3 }])).toEqual(["       b", ""]); // the tab to column 8
      expect(reversed([{ line: 1, offset: 30 }, { line: 0, offset: 3 }])).toEqual(["c", "x".repeat(19) + "…"]);
      expect(reversed([{ line: 1, offset: 25 }, { line: 1, offset: 30 }])).toEqual(["", "…"]); // past the cut: the … stands for it
    } finally {
      chalk.level = level;
    }
  });
});

// TUI design pass, Task 2: styled lines in full screen. chalk at level 3 (24-bit colour), so the band's hex is drawn as it
// is; each test turns it on for itself, as the selection's test above does.
describe("Conversation's styled rows", () => {
  const plain = (s: string) => s.replace(/\u001b\[[\d;]*m/g, "");
  const within = (row: string, open: string, close: string) =>
    [...row.matchAll(new RegExp(`\\u001b\\[${open}m(.*?)\\u001b\\[${close}m`, "g"))].map((m) => plain(m[1]!)).join("");
  const BAND = "\u001b[48;2;42;42;42m"; // the dark look's band, #2a2a2a (theme.ts)
  const coloured = <T,>(run: () => T): T => {
    const level = chalk.level;
    chalk.level = 3;
    try {
      return run();
    } finally {
      chalk.level = level;
    }
  };
  const drawIn = (look: Look | null, props: Parameters<typeof Conversation>[0]) => {
    const app = render(look ? <ThemeContext value={{ look, palette: palette(look) }}><Conversation {...props} /></ThemeContext> : <Conversation {...props} />);
    mounted.push(app);
    return app.lastFrame()!.split("\n");
  };

  it("draws a span's style on the rows it reaches, across a wrap point and a line break", () =>
    coloured(() => {
      const rows = new Rows(9);
      rows.add([{ text: "the quick brown\nfox", styles: [{ start: 4, end: 17, bold: true }] }]);
      const shown = drawIn(null, { rows, first: 0, height: 3, unseen: 0, following: true });
      expect(shown.map(plain)).toEqual(["the quick", " brown", "fox"]);
      expect(shown.map((r) => within(r, "1", "22"))).toEqual(["quick", " brown", "f"]);
    }));

  it("fills a band row to its width with the band colour, its indent's spaces too", () =>
    coloured(() => {
      const rows = new Rows(9);
      rows.add([{ text: "hi", band: true }, { text: "› a bcdefgh", band: true, indent: 2 }]);
      const shown = drawIn(null, { rows, first: 0, height: 3, unseen: 0, following: true });
      expect(shown.map(plain)).toEqual(["hi       ", "› a      ", "  bcdefgh"]);
      for (const r of shown) expect(r.startsWith(BAND)).toBe(true);
    }));

  it("shows a selection over a styled row in reverse on the text only, not the indent or the band's padding", () =>
    coloured(() => {
      const rows = new Rows(20);
      rows.add([{ text: "● one two three four five", indent: 2, band: true, styles: [{ start: 0, end: 1, color: "blue" }] }]);
      const selection: [Pos, Pos] = [{ line: 0, offset: 0 }, { line: 0, offset: 25 }];
      const shown = drawIn(null, { rows, first: 0, height: 2, unseen: 0, following: true, selection });
      expect(shown.map(plain)).toEqual(["● one two three four", "   five             "]);
      expect(shown.map((r) => within(r, "7", "27"))).toEqual(["● one two three four", " five"]);
      expect(within(shown[0]!, "34", "39")).toBe("●"); // the span's colour, under the reverse
    }));

  // Task 2's review: a later span's field left undefined does not clear an earlier span's.
  it("lays a later span over an earlier one field by field, an undefined field leaving the earlier one's", () =>
    coloured(() => {
      const rows = new Rows(9);
      rows.add([{ text: "ab", styles: [{ start: 0, end: 2, color: "red" }, { start: 0, end: 1, color: undefined, bold: true }] }]);
      const row = drawIn(null, { rows, first: 0, height: 1, unseen: 0, following: true })[0]!;
      expect(within(row, "31", "39")).toBe("ab");
      expect(within(row, "1", "22")).toBe("a");
    }));

  it("drops a span's colour and background and the band without colour, and keeps bold (the theme's look)", () =>
    coloured(() => {
      const rows = new Rows(9);
      rows.add([{ text: "ab", band: true, styles: [{ start: 0, end: 1, color: "red", bg: "blue", bold: true }] }]);
      const props = { rows, first: 0, height: 1, unseen: 0, following: true };
      const full = drawIn(null, props)[0]!;
      expect(full).toContain(BAND);
      expect(within(full, "31", "39")).toBe("a");
      const none = drawIn({ light: false, color: false, full: false }, props)[0]!;
      expect(none).not.toMatch(/\u001b\[(3|4)\d/); // no colour or background code at all
      expect(within(none, "1", "22")).toBe("a");
      expect(plain(none)).toBe("ab");
    }));
});
