import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { ASCII, pixelRows } from "../../src/tui/art.js";
import type { Line } from "../../src/tui/describe.js";
import { type StartInfo, startBox } from "../../src/tui/startup.js";
import { type Look, palette } from "../../src/tui/theme.js";
import { textWidth } from "../../src/tui/view.js";

// TUI design pass, Task 6: the start-up box (design, "2. Start-up box"), laid out for the width a kept line's text has.
const FULL: Look = { light: false, color: true, full: true };
const COLOUR: Look = { light: false, color: true, full: false };
const NONE: Look = { light: false, color: false, full: false };
const MUTED = palette(FULL).muted;

const INFO: StartInfo = {
  version: "0.1.0",
  lead: "anthropic:claude-opus-5-5",
  folder: "~/proj",
  branch: "main",
  mode: "ask",
  sandbox: "off",
  files: ["CLAUDE.md", "AGENTS.md"],
  servers: 3,
  hooks: 2,
};
const HINT = "  ? for shortcuts · / for commands";

// The box's widths, from the picture's spacing (the user's choices, 2026-11-13: "Gap 2, right pad 2"): a border and 2
// columns each side, 2 between the drawing and the list, the labels in a column as wide as "folder" and 2. INFO's longest
// row is "lead    anthropic:claude-opus-5-5", 33 columns.
const PIXEL_BOX = 1 + 2 + 48 + 2 + 33 + 2 + 1; // 89
const ASCII_BOX = 1 + 2 + 21 + 2 + 33 + 2 + 1; // 62
const LIST_BOX = 1 + 2 + 33 + 2 + 1; // 39

const box = (lines: Line[]) => lines.slice(0, -1); // the hint is last
const texts = (lines: Line[]) => lines.map((l) => l.text);
const drawing = (lines: Line[]) => (lines[1]!.text.includes(pixelRows()[0]!.text) ? "pixels" : lines[1]!.text.includes(ASCII[0]!) ? "ascii" : "none");
// The list's rows as drawn, the drawing's columns and the borders left out.
const list = (lines: Line[], from: number) => box(lines).slice(1, -1).map((l) => [...l.text].slice(from, -1).join("").trimEnd()).filter(Boolean);

describe("the start-up box", () => {
  it("draws the pixel art, the list and the borders at 120 columns in full colour, as wide as they need", () => {
    const lines = startBox(INFO, 120, FULL);
    expect(drawing(lines)).toBe("pixels");
    expect(box(lines)).toHaveLength(15 + 2); // the art's 15 rows and the borders
    for (const l of box(lines)) expect(stringWidth(l.text)).toBe(PIXEL_BOX);
    expect(lines[0]!.text).toBe(`╭─ Tachikoma 0.1.0 ${"─".repeat(PIXEL_BOX - 20)}╮`);
    expect(lines.at(-2)!.text).toBe(`╰${"─".repeat(PIXEL_BOX - 2)}╯`);
    expect(lines[1]!.text).toBe(`│  ${pixelRows()[0]!.text}  lead    anthropic:claude-opus-5-5  │`);
    expect(list(lines, 1 + 2 + 48 + 2)).toEqual([
      "lead    anthropic:claude-opus-5-5",
      "folder  ~/proj  git:(main)",
      "mode    ask · sandbox off",
      "read    CLAUDE.md, AGENTS.md",
      "mcp     3 servers starting",
      "hooks   2",
    ]);
    // Top-aligned: the rows under the list hold the art alone.
    expect(lines[7]!.text).toBe(`│  ${pixelRows()[6]!.text}${" ".repeat(2 + 33 + 2)}│`);
  });

  it("draws the ASCII drawing at 80 columns in full colour, where the pixel art does not fit, and the list alone at 50", () => {
    const at80 = startBox(INFO, 80, FULL);
    expect(drawing(at80)).toBe("ascii");
    expect(box(at80)).toHaveLength(ASCII.length + 2);
    for (const l of box(at80)) expect(stringWidth(l.text)).toBe(ASCII_BOX);
    expect(at80[1]!.text).toBe(`│  ${ASCII[0]!.padEnd(21)}  lead    anthropic:claude-opus-5-5  │`);
    const at50 = startBox(INFO, 50, FULL);
    expect(drawing(at50)).toBe("none");
    expect(box(at50)).toHaveLength(6 + 2);
    for (const l of box(at50)) expect(stringWidth(l.text)).toBe(LIST_BOX);
    expect(texts(box(at50)).slice(1, -1)).toEqual([
      "│  lead    anthropic:claude-opus-5-5  │",
      "│  folder  ~/proj  git:(main)         │",
      "│  mode    ask · sandbox off          │",
      "│  read    CLAUDE.md, AGENTS.md       │",
      "│  mcp     3 servers starting         │",
      "│  hooks   2                          │",
    ]);
  });

  // The pixel art is for full colour only (Task 5): with colour but not full, and with none, the ASCII drawing where it
  // fits, else the list alone.
  it.each([
    { look: "colour but not full", shown: COLOUR, columns: 120, want: "ascii", wide: ASCII_BOX },
    { look: "colour but not full", shown: COLOUR, columns: 80, want: "ascii", wide: ASCII_BOX },
    { look: "colour but not full", shown: COLOUR, columns: 50, want: "none", wide: LIST_BOX },
    { look: "no colour", shown: NONE, columns: 120, want: "ascii", wide: ASCII_BOX },
    { look: "no colour", shown: NONE, columns: 80, want: "ascii", wide: ASCII_BOX },
    { look: "no colour", shown: NONE, columns: 50, want: "none", wide: LIST_BOX },
  ])("draws the $want layout with $look at $columns columns", ({ shown, columns, want, wide }) => {
    const lines = startBox(INFO, columns, shown);
    expect(drawing(lines)).toBe(want);
    for (const l of box(lines)) expect(stringWidth(l.text)).toBe(wide);
  });

  it("puts each row on one line, a block at its top, and the hint under it, muted", () => {
    const lines = startBox(INFO, 120, FULL);
    for (const l of lines) expect(l.oneLine).toBe(true);
    expect(lines[0]!.block).toBe(true);
    expect(lines.slice(1).some((l) => l.block)).toBe(false);
    expect(lines.at(-1)).toEqual({ text: HINT, color: MUTED, oneLine: true });
  });

  // The user's choice, 2026-11-13 ("Grey border+labels"): the border and the labels muted, the values the terminal's own.
  it("draws the border and the labels muted, the values in no colour, and the drawing in its own", () => {
    const lines = startBox(INFO, 50, FULL);
    const colourAt = (l: Line, c: number) => l.styles?.find((s) => s.start <= c && c < s.end)?.color;
    const row = lines[1]!; // "│  lead    anthropic:…  │"
    expect(colourAt(row, 0)).toBe(MUTED);
    expect(colourAt(row, row.text.length - 1)).toBe(MUTED);
    expect(colourAt(row, 3)).toBe(MUTED); // "lead"
    expect(colourAt(row, 11)).toBeUndefined(); // "anthropic"
    expect(row.color).toBeUndefined();
    const top = lines[0]!;
    expect(colourAt(top, 0)).toBe(MUTED);
    // The name and version in the terminal's own colour (the user's choice, 2026-11-13: "Own colour"), the lines after
    // them muted.
    const title = top.text.indexOf("Tachikoma 0.1.0");
    for (let c = title; c < title + "Tachikoma 0.1.0".length; c++) expect(colourAt(top, c)).toBeUndefined();
    expect(colourAt(top, title + "Tachikoma 0.1.0".length + 1)).toBe(MUTED);
    expect(lines.at(-2)!.styles).toEqual([{ start: 0, end: lines.at(-2)!.text.length, color: MUTED }]);
    const ascii = startBox(INFO, 80, FULL)[1]!;
    expect(colourAt(ascii, 3)).toBe(palette(FULL).accent);
    const pixels = startBox(INFO, 120, FULL)[2]!;
    const art = pixelRows()[1]!;
    for (const s of art.styles!) expect(pixels.styles).toContainEqual({ ...s, start: s.start + 3, end: s.end + 3 });
  });

  it("draws no colour at all without colour", () => {
    for (const l of startBox(INFO, 120, NONE)) {
      expect(l.color).toBeUndefined();
      for (const s of l.styles ?? []) expect(s.color === undefined && s.bg === undefined).toBe(true);
    }
  });

  it("leaves out the rows with nothing to show, the branch when there is none, and says one server", () => {
    const bare = { ...INFO, branch: null, files: [], servers: 0, hooks: 0 };
    expect(list(startBox(bare, 50, FULL), 3)).toEqual(["lead    anthropic:claude-opus-5-5", "folder  ~/proj", "mode    ask · sandbox off"]);
    expect(list(startBox({ ...INFO, servers: 1 }, 50, FULL), 3)).toContain("mcp     1 server starting");
  });

  it("cuts a long file list with \"and N more\", keeping as many names as fit, and picks the drawing as if cut to one", () => {
    const files = Array.from({ length: 10 }, (_, i) => `NOTES${i}.md`);
    const lines = startBox({ ...INFO, files }, 80, FULL);
    expect(drawing(lines)).toBe("ascii"); // the full list would leave no room for it
    for (const l of box(lines)) expect(stringWidth(l.text)).toBe(80);
    // The list's room: 80 less 29 for the borders, padding, drawing and gap, less the labels' 8: 43 columns. Three names
    // and "and 7 more" are 42; four would be 53.
    expect(list(lines, 1 + 2 + 21 + 2)).toContain("read    NOTES0.md, NOTES1.md, NOTES2.md and 7 more");
    const pixels = startBox({ ...INFO, files }, 120, FULL);
    expect(drawing(pixels)).toBe("pixels");
    expect(list(pixels, 1 + 2 + 48 + 2)).toContain("read    NOTES0.md, NOTES1.md, NOTES2.md, NOTES3.md and 6 more"); // 120 - 56 - 8 = 56 columns
  });

  it("cuts a value too wide for the box with … inside it, so the right border stays", () => {
    const lines = startBox({ ...INFO, folder: `~/${"deep/".repeat(20)}proj` }, 50, FULL);
    expect(drawing(lines)).toBe("none");
    for (const l of box(lines)) {
      expect(stringWidth(l.text)).toBe(50);
      expect(l.text.at(-1)).toMatch(/[│╮╯]/);
    }
    expect(lines[2]!.text).toMatch(/^│ {2}folder {2}~\/deep\/.*…  │$/);
  });

  // The user's choice, 2026-11-13 ("Never costs drawing"): the folder row, as the read row, is counted at its shortest
  // (its value cut to "…") when the drawing is picked; the box then widens to `width` for it, and cuts it inside the border.
  it("keeps the pixel art for a folder too long to fit beside it, cutting the folder with … inside the border", () => {
    const folder = `~/${"deep/".repeat(15)}proj`; // 81 columns and "  git:(main)": counted whole, no drawing would fit
    const lines = startBox({ ...INFO, folder }, 120, FULL);
    expect(drawing(lines)).toBe("pixels");
    for (const l of box(lines)) {
      expect(stringWidth(l.text)).toBe(120);
      expect(l.text.at(-1)).toMatch(/[│╮╯]/);
    }
    // The value's room: 120 less 56 for the borders, padding, art and gap, less the labels' 8: 56 columns.
    expect(list(lines, 1 + 2 + 48 + 2)[1]).toBe(`folder  ${folder.slice(0, 55)}…`);
    expect(list(startBox({ ...INFO, folder }, 50, FULL), 3)[1]).toBe(`folder  ${folder.slice(0, 35)}…`); // the list alone: 36
  });

  it("escapes control characters in what it is given, before measuring", () => {
    const lines = startBox({ ...INFO, folder: "~/a\u001b[2Jb" }, 50, FULL);
    expect(lines[2]!.text).toContain("~/a\\u001b[2Jb");
    for (const l of box(lines)) expect(stringWidth(l.text)).toBe(LIST_BOX);
  });

  // The review's exact fit: the narrowest terminal where the pixel art fits draws it with nothing cut; one column narrower
  // draws the ASCII drawing, nothing cut. In full screen that terminal is one column wider than in classic, for the scroll
  // bar's column.
  it.each([
    { mode: "full screen", full: true, columns: PIXEL_BOX + 1 },
    { mode: "classic", full: false, columns: PIXEL_BOX },
  ])("fits exactly in $mode", ({ full, columns }) => {
    const fits = startBox(INFO, textWidth(columns, full), FULL);
    expect(drawing(fits)).toBe("pixels");
    for (const l of fits) expect(l.text).not.toContain("…");
    for (const l of box(fits)) expect(stringWidth(l.text)).toBe(PIXEL_BOX);
    const short = startBox(INFO, textWidth(columns - 1, full), FULL);
    expect(drawing(short)).toBe("ascii");
    for (const l of short) expect(l.text).not.toContain("…");
    for (const l of box(short)) expect(stringWidth(l.text)).toBe(ASCII_BOX);
  });
});

describe("textWidth", () => {
  it("gives a kept line's text the terminal's columns less the scroll bar's in full screen, and all of them in classic", () => {
    expect(textWidth(120, true)).toBe(119);
    expect(textWidth(120, false)).toBe(120);
  });
});
