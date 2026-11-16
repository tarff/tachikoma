import chalk from "chalk";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { Conversation } from "../../src/tui/Conversation.js";
import { screen } from "../../src/tui/describe.js";
import { markdownLines } from "../../src/tui/markdown.js";
import { textOf } from "../../src/tui/select.js";
import { type Look, palette, type Role, ThemeContext } from "../../src/tui/theme.js";
import { type Pos, Rows } from "../../src/tui/view.js";

const mounted: ReturnType<typeof render>[] = [];
afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
});

// Rows at 9 columns, so with the bar's column a row is 10 wide.
function kept(n: number, color?: Role) {
  const rows = new Rows(9);
  rows.add(Array.from({ length: n }, (_, i) => ({ text: `line ${i}`, ...(color ? { color } : {}) })));
  return rows;
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

  // Each row's role looked up in the palette, here the dark full one a test gets (theme.ts, ThemeContext), drawn with chalk
  // at level 3 so its hex is drawn as it is (TUI design pass, Task 13).
  it("draws each row in its line's colour", () => {
    const level = chalk.level;
    chalk.level = 3;
    try {
      const P = palette({ light: false, color: true, full: true });
      const fg = (hex: string) => `\u001b[38;2;${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";")}m`;
      const rows = new Rows(9);
      rows.add([{ text: "red one", color: "error" }, { text: "plain" }]);
      const shown = draw({ rows, first: 0, height: 2, unseen: 0, following: true });
      expect(shown[0]).toContain(`${fg(P.error!)}red one`);
      expect(shown[1]).toBe("plain");
      // A row in no colour, the bar beside it muted; the count of new lines muted, and the bar beside it in the same run.
      const held = draw({ rows: kept(20), first: 0, height: 2, unseen: 3, following: false });
      expect(held[0]).not.toContain(`${fg(P.muted!)}line`);
      expect(held[0]).toContain(`${fg(P.muted!)}┃`);
      expect(held[1]).toContain(`${fg(P.muted!)}↓ 3 new …│`);
    } finally {
      chalk.level = level;
    }
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
      // The space at the edge ends the first row unseen (Task 17's captures, "Fix it").
      expect(shown.map(plain)).toEqual(["the quick", "brown", "fox"]);
      expect(shown.map((r) => within(r, "1", "22"))).toEqual(["quick", "brown", "f"]);
    }));

  // The user's choice (2026-11-16, "Struck through"): a strikethrough is a style, drawn as bold is, and kept without colour.
  it("draws a struck span across a wrap point and on a cut row, without colour too", () =>
    coloured(() => {
      const rows = new Rows(9);
      rows.add([
        { text: "the quick brown", styles: [{ start: 4, end: 15, strike: true }] },
        { text: "a struck row cut", oneLine: true, styles: [{ start: 2, end: 16, strike: true }] },
      ]);
      const shown = drawIn({ light: false, color: false, full: false }, { rows, first: 0, height: 3, unseen: 0, following: true });
      expect(shown.map(plain)).toEqual(["the quick", "brown", "a struck…"]);
      expect(shown.map((r) => within(r, "9", "29"))).toEqual(["quick", "brown", "struck…"]);
    }));

  it("fills a band row to its width with the band colour, its indent's spaces too", () =>
    coloured(() => {
      const rows = new Rows(9);
      rows.add([{ text: "hi", band: true }, { text: "› a bcdefgh", band: true, indent: 2 }]);
      const shown = drawIn(null, { rows, first: 0, height: 3, unseen: 0, following: true });
      expect(shown.map(plain)).toEqual(["hi       ", "› a      ", "  bcdefgh"]);
      for (const r of shown) expect(r.startsWith(BAND)).toBe(true);
    }));

  // Task 16's code review: a band from a column has its lead plain and its tabs on the band, their stops counted from
  // the indent, as Printed prints them in classic.
  it("draws a band from a column's tabs on the band, their stops counted from the indent", () =>
    coloured(() => {
      const rows = new Rows(40);
      rows.add([{ text: "  \tif x {", band: true, bandFrom: 2, indent: 2 }, { text: "  \t\tfmt.Println(1)", band: true, bandFrom: 2, indent: 2 }]);
      const shown = drawIn(null, { rows, first: 0, height: 2, unseen: 0, following: true });
      expect(shown.map(plain)).toEqual([`${" ".repeat(10)}if x {`.padEnd(40), `${" ".repeat(18)}fmt.Println(1)`.padEnd(40)]);
      for (const r of shown) expect(plain(r.slice(0, r.indexOf(BAND)))).toBe("  ");
    }));

  it("shows a selection over a styled row in reverse on the text only, not the indent or the band's padding", () =>
    coloured(() => {
      const rows = new Rows(20);
      rows.add([{ text: "● one two three four five", indent: 2, band: true, styles: [{ start: 0, end: 1, color: "blue" }] }]);
      const selection: [Pos, Pos] = [{ line: 0, offset: 0 }, { line: 0, offset: 25 }];
      const shown = drawIn(null, { rows, first: 0, height: 2, unseen: 0, following: true, selection });
      // The space after "four", at the edge, ends the first row unseen (Task 17's captures, "Fix it").
      expect(shown.map(plain)).toEqual(["● one two three four", "  five              "]);
      expect(shown.map((r) => within(r, "7", "27"))).toEqual(["● one two three four", "five"]);
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

  // Task 7's re-check: the spans are stepped through by their starts (view.ts, keptOf; runs), but laid in their own order,
  // a later over an earlier, so the red span given second lies over the green one inside it.
  it("lays a later span over an earlier one that starts after it", () =>
    coloured(() => {
      const rows = new Rows(20);
      rows.add([{ text: "abcdefghij", styles: [{ start: 2, end: 5, color: "green" }, { start: 0, end: 10, color: "red" }] }]);
      const row = drawIn(null, { rows, first: 0, height: 1, unseen: 0, following: true })[0]!;
      expect(within(row, "31", "39")).toBe("abcdefghij");
      expect(row).not.toContain("\u001b[32m");
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

// Clickable links plan, Task 3: a link span drawn as an OSC 8 link, ended by BEL, in the accent blue (decision 5), with
// links on; with them off, today's frame. chalk at level 3, so the accent's hex is drawn as it is.
describe("Conversation's links", () => {
  const OPEN = (id: string, url: string) => `\u001b]8;id=${id};${url}\u0007`;
  const CLOSE = "\u001b]8;;\u0007";
  const ACCENT = "\u001b[38;2;66;120;222m"; // #4278de, the accent in both looks (theme.ts)
  const plain = (s: string) => s.replace(/\u001b\[[\d;]*m/g, "").replace(/\u001b\]8;[^\u0007]*\u0007/g, "");
  const within = (row: string, open: string, close: string) =>
    [...row.matchAll(new RegExp(`\\u001b\\[${open}m(.*?)\\u001b\\[${close}m`, "g"))].map((m) => plain(m[1]!)).join("");
  const linksIn = (row: string) =>
    [...row.matchAll(/\u001b\]8;id=([^;]*);([^\u0007]*)\u0007(.*?)\u001b\]8;;\u0007/g)].map((m) => ({
      id: m[1],
      url: m[2],
      text: plain(m[3]!),
    }));
  const ON: Look = { light: false, color: true, full: true, links: true };
  const OFF: Look = { light: false, color: true, full: true };
  const BLUE = "38;2;66;120;222"; // ACCENT's code, for within()
  const coloured = <T,>(run: () => T, at = 3): T => {
    const level = chalk.level;
    chalk.level = at as typeof chalk.level;
    try {
      return run();
    } finally {
      chalk.level = level;
    }
  };
  const drawIn = (look: Look, props: Parameters<typeof Conversation>[0]) => {
    const app = render(
      <ThemeContext value={{ look, palette: palette(look) }}>
        <Conversation {...props} />
      </ThemeContext>,
    );
    mounted.push(app);
    return app.lastFrame()!.split("\n");
  };
  const top = (look: Look, rows: Rows) => drawIn(look, { rows, first: 0, height: 1, unseen: 0, following: true })[0]!;
  const one = (look: Look, text: string) => {
    const rows = new Rows(40);
    rows.add([screen({ text })]);
    return top(look, rows);
  };

  it("draws a bare address in the accent inside a link, its id its kept line's and its start, not underlined", () =>
    coloured(() => {
      const row = one(ON, "go to https://x.y now");
      expect(row).toContain(`go to ${ACCENT}${OPEN("0-6", "https://x.y")}https://x.y${CLOSE}`);
      expect(plain(row).trimEnd()).toBe("go to https://x.y now");
      expect(plain(row.slice(row.indexOf(CLOSE))).trimEnd()).toBe(" now");
      expect(row).not.toContain("\u001b[4m");
      // Links off: today's frame, as for the line with no span at all.
      const raw = new Rows(40);
      raw.add([{ text: "go to https://x.y now" }]);
      expect(one(OFF, "go to https://x.y now")).toBe(top(OFF, raw));
      // Without colour the link is drawn all the same, with no colour code (decision 8).
      const bare = one({ light: false, color: false, full: false, links: true }, "go to https://x.y now");
      expect(linksIn(bare)).toEqual([{ id: "0-6", url: "https://x.y", text: "https://x.y" }]);
      expect(bare).not.toMatch(/\u001b\[(3|4)\d/);
    }));

  it("draws the blue as the accent of each look: the light full one's #4278de, the named one's blue", () => {
    const light = { light: true, color: true, full: true, links: true } as const;
    coloured(() => expect(within(one(light, "see https://x.y"), BLUE, "39")).toBe("https://x.y"));
    const named = { light: false, color: true, full: false, links: true } as const;
    coloured(() => expect(within(one(named, "see https://x.y"), "34", "39")).toBe("https://x.y"), 1);
  });

  it("draws an address in a line with its own colour in the accent, the rest in the line's colour", () =>
    coloured(() => {
      const rows = new Rows(40);
      rows.add([screen({ text: "see https://x.y", color: "error" })]);
      const row = top(ON, rows);
      expect(row).toContain("\u001b[38;2;240;96;95msee "); // the dark look's error, #f0605f (theme.ts)
      expect(within(row, BLUE, "39")).toBe("https://x.y");
      expect(linksIn(row)).toEqual([{ id: "0-4", url: "https://x.y", text: "https://x.y" }]);
    }));

  it("gives each row of a wrapped address its own open, with one id, and its own close, the scroll bar outside", () =>
    coloured(() => {
      const address = "https://example.com/abcdefghij"; // 30 characters, 4 rows at 9 columns
      const rows = new Rows(9);
      rows.add([screen({ text: address }), { text: "x" }]);
      const shown = drawIn(ON, { rows, first: 0, height: 4, unseen: 0, following: false });
      for (const row of shown) {
        expect(linksIn(row).map(({ id, url }) => ({ id, url }))).toEqual([{ id: "0-0", url: address }]);
        expect(row.lastIndexOf(CLOSE)).toBeLessThan(Math.max(row.indexOf("┃"), row.indexOf("│")));
      }
      expect(shown.flatMap(linksIn).map((l) => l.text).join("")).toBe(address);
    }));

  it("keeps the selected part and the rest of an address in links of the same id and address", () =>
    coloured(() => {
      const rows = new Rows(40);
      rows.add([screen({ text: "go to https://x.y now" })]);
      const selection: [Pos, Pos] = [{ line: 0, offset: 6 }, { line: 0, offset: 11 }];
      const row = drawIn(ON, { rows, first: 0, height: 1, unseen: 0, following: true, selection })[0]!;
      expect(within(row, "7", "27")).toBe("https");
      // Ink draws the two runs' cells, of one id and address, inside one open and close.
      expect(linksIn(row)).toEqual([{ id: "0-6", url: "https://x.y", text: "https://x.y" }]);
      expect(row).toContain(`${OPEN("0-6", "https://x.y")}https\u001b[27m://x.y${CLOSE}`);
    }));

  // Task 4 gives a markdown link these link spans; here they are given by hand, as markdown.ts will.
  it("draws a markdown link's text underlined and blue and its address blue between muted brackets, both linked", () =>
    coloured(() => {
      const P = palette(ON);
      const line = screen({
        text: "docs (https://x.y)",
        styles: [
          { start: 0, end: 4, underline: true },
          { start: 5, end: 18, color: P.muted! },
          { start: 0, end: 4, link: "https://x.y" },
          { start: 6, end: 17, link: "https://x.y" },
        ],
      });
      const draw = (look: Look) => {
        const rows = new Rows(40);
        rows.add([line]);
        return top(look, rows);
      };
      const on = draw(ON);
      expect(linksIn(on)).toEqual([
        { id: "0-0", url: "https://x.y", text: "docs" },
        { id: "0-6", url: "https://x.y", text: "https://x.y" },
      ]);
      expect(within(on, "4", "24")).toBe("docs");
      expect(on).toContain(`${ACCENT}${OPEN("0-0", "https://x.y")}docs${CLOSE}`);
      const MUTED = "\u001b[38;2;138;138;138m"; // the dark look's muted, #8a8a8a (theme.ts)
      expect(on).toContain(`${MUTED}(${ACCENT}${OPEN("0-6", "https://x.y")}https://x.y${CLOSE}${MUTED})`);
      const off = draw(OFF);
      expect(off).not.toContain("\u001b]8;");
      expect(within(off, "4", "24")).toBe("docs");
      expect(within(off, "38;2;138;138;138", "39")).toBe("(https://x.y)");
      expect(off).not.toContain(ACCENT);
    }));

  it("links an address in inline code, in the accent as the code around it is", () =>
    coloured(() => {
      const rows = new Rows(40);
      rows.add([screen(markdownLines("run `curl https://x.y` now", 80, palette(ON))[0]!)]);
      const row = top(ON, rows);
      expect(linksIn(row)).toEqual([{ id: "0-9", url: "https://x.y", text: "https://x.y" }]);
      expect(within(row, BLUE, "39")).toBe("curl https://x.y");
    }));

  // The review's finding 2: the … of a cut one-line entry stands for what it cuts, an address's rest too, but is no
  // link.
  it("closes a cut one-line entry's link before its …, which has no link and no accent", () =>
    coloured(() => {
      const rows = new Rows(9);
      rows.add([screen({ text: "x https://example.com/a", oneLine: true })]);
      const row = top(ON, rows);
      expect(plain(row)).toBe("x https:…");
      expect(linksIn(row)).toEqual([{ id: "0-2", url: "https://example.com/a", text: "https:" }]);
      const after = row.slice(row.lastIndexOf(CLOSE));
      expect(after).toContain("…");
      expect(after.slice(0, after.indexOf("…"))).not.toContain(ACCENT);
      expect(within(row, BLUE, "39")).toBe("https:");
    }));

  it("copies a linked row's text alone", () => {
    const rows = new Rows(40);
    rows.add([screen({ text: "go to https://x.y now" })]);
    expect(textOf(rows.lines, { line: 0, offset: 0 }, { line: 0, offset: 21 })).toBe("go to https://x.y now");
  });
});
