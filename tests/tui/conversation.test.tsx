import chalk from "chalk";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { isValidElement, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Conversation } from "../../src/tui/Conversation.js";
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
    expect(draw({ rows: wide, first: 2, height: 10, unseen: 1, following: false }).at(-1)!.trimEnd().slice(0, 40).trimEnd()).toBe("↓ 1 new line · Ctrl+End");
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
