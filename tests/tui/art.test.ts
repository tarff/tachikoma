import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { ASCII, asciiRows, PIXEL_COLORS, PIXELS, pixelRows } from "../../src/tui/art.js";
import { palette } from "../../src/tui/theme.js";

// TUI design pass, Task 5: the start-up box's two drawings, the pixel art (plan, appendix "The pixel art") and the user's
// ASCII drawing, moved from tachikoma.txt (choice E).
describe("pixel art", () => {
  it("has rows all the same width, and a colour for every letter in them", () => {
    expect(PIXELS).toHaveLength(30);
    for (const row of PIXELS) expect(row).toHaveLength(48);
    for (const letter of new Set(PIXELS.join(""))) if (letter !== ".") expect(PIXEL_COLORS[letter]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("draws two pixel rows to a text row, each the grid's width, on one line", () => {
    const rows = pixelRows();
    expect(rows).toHaveLength(Math.ceil(PIXELS.length / 2));
    for (const row of rows) {
      expect(stringWidth(row.text)).toBe(48);
      expect(row.oneLine).toBe(true);
    }
  });

  // Cells checked against the appendix's grid by hand: text row r is pixel rows 2r (top) and 2r + 1 (bottom).
  it("draws each cell with the half block its two pixels call for", () => {
    const rows = pixelRows();
    const cell = (r: number, c: number) => ({ char: rows[r]!.text[c], span: rows[r]!.styles?.find((s) => s.start === c) });
    // Pixel rows 2 and 3, column 30: blue over red.
    expect(cell(1, 30)).toEqual({ char: "▀", span: { start: 30, end: 31, color: "#4278de", bg: "#dc3c32" } });
    // Pixel rows 2 and 3, column 16: shade over shade.
    expect(cell(1, 16)).toEqual({ char: "█", span: { start: 16, end: 17, color: "#284ea0" } });
    // Pixel rows 0 and 1, column 26: empty over light.
    expect(cell(0, 26)).toEqual({ char: "▄", span: { start: 26, end: 27, color: "#8cb4f5" } });
    // Pixel rows 26 and 27, column 5: blue over empty.
    expect(cell(13, 5)).toEqual({ char: "▀", span: { start: 5, end: 6, color: "#4278de" } });
    // Pixel rows 0 and 1, column 0: both empty.
    expect(cell(0, 0)).toEqual({ char: " ", span: undefined });
  });
});

describe("ASCII drawing", () => {
  // The test's own copy of the user's tachikoma.txt: 12 lines, LF, a final newline, 228 bytes.
  const FILE =
    "            _____\n" +
    "           /_____\\\n" +
    "          | [] []|\n" +
    "        | |     (O)\n" +
    "      __|_|__    |\n" +
    "    .' O   O `.  |\n" +
    "   (    o     )__|\n" +
    "  / `-------' \\  \\\n" +
    " /  /== /==\\   |  \\\n" +
    "(O)/   /    \\  |  (O)\n" +
    "             \\_|\n" +
    "             (O)\n";

  it("is the user's file byte for byte", () => {
    expect(Buffer.byteLength(FILE)).toBe(228);
    expect(ASCII.join("\n") + "\n").toBe(FILE);
  });

  it("draws each row in the accent colour, on one line", () => {
    const P = palette({ light: false, color: true, full: true });
    expect(asciiRows(P)).toEqual(ASCII.map((text) => ({ text, color: "#4278de", oneLine: true })));
    expect(asciiRows(palette({ light: false, color: true, full: false }))[0]!.color).toBe("blue");
  });
});
