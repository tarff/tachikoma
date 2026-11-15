import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { ASCII, asciiRows, LIGHT_PIXEL_COLORS, PIXEL_COLORS, PIXELS, pixelRows } from "../../src/tui/art.js";

// TUI design pass, Task 5: the start-up box's two drawings, the pixel art (plan, appendix "The pixel art") and the user's
// ASCII drawing, moved from tachikoma.txt (choice E).
describe("pixel art", () => {
  it("has rows all the same width, and a colour for every letter in them", () => {
    expect(PIXELS).toHaveLength(24); // even, so pixelRows always has a bottom row
    for (const row of PIXELS) expect(row).toHaveLength(40);
    for (const letter of new Set(PIXELS.join(""))) if (letter !== ".") expect(PIXEL_COLORS[letter]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("draws two pixel rows to a text row, each the grid's width, on one line", () => {
    const rows = pixelRows();
    expect(rows).toHaveLength(Math.ceil(PIXELS.length / 2));
    for (const row of rows) {
      expect(stringWidth(row.text)).toBe(40);
      expect(row.oneLine).toBe(true);
    }
  });

  // Cells checked against the 40×24 grid by hand: text row r is pixel rows 2r (top) and 2r + 1 (bottom).
  it("draws each cell with the half block its two pixels call for", () => {
    const rows = pixelRows();
    const cell = (r: number, c: number) => ({ char: rows[r]!.text[c], span: rows[r]!.styles?.find((s) => s.start === c) });
    // Pixel rows 2 and 3, column 25: blue over red.
    expect(cell(1, 25)).toEqual({ char: "▀", span: { start: 25, end: 26, color: "#4278de", bg: "#dc3c32" } });
    // Pixel rows 2 and 3, column 14: shade over shade.
    expect(cell(1, 14)).toEqual({ char: "█", span: { start: 14, end: 15, color: "#284ea0" } });
    // Pixel rows 0 and 1, column 21: empty over light.
    expect(cell(0, 21)).toEqual({ char: "▄", span: { start: 21, end: 22, color: "#8cb4f5" } });
    // Pixel rows 20 and 21, column 1: dark over empty.
    expect(cell(10, 1)).toEqual({ char: "▀", span: { start: 1, end: 2, color: "#373c4b" } });
    // Pixel rows 0 and 1, column 0: both empty.
    expect(cell(0, 0)).toEqual({ char: " ", span: undefined });
  });

  // TUI design pass, Task 14: the light look's colours. WCAG 2.1's contrast ratio (relative luminance), against white:
  // the dark table's light (2.11), white (1.14) and grey (1.77) are under WCAG 1.4.11's 3:1 for graphics, so each is
  // darkened, its channels scaled together, to the first shade at 3:1 or more; the rest are kept.
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const onWhite = (hex: string) => 1.05 / (luminance(hex) + 0.05);
  it("has a light table with every colour at 3:1 or more on white, changing only those under it", () => {
    for (const [letter, dark] of Object.entries(PIXEL_COLORS)) {
      const light = LIGHT_PIXEL_COLORS[letter]!;
      expect(onWhite(light)).toBeGreaterThanOrEqual(3);
      if (onWhite(dark) >= 3) expect(light).toBe(dark);
    }
    expect(Object.keys(LIGHT_PIXEL_COLORS).sort()).toEqual(Object.keys(PIXEL_COLORS).sort());
    expect({ L: LIGHT_PIXEL_COLORS.L, W: LIGHT_PIXEL_COLORS.W, G: LIGHT_PIXEL_COLORS.G }).toEqual({ L: "#7596cc", W: "#92959a", G: "#91959d" });
  });

  it("draws the light table's colours in the light look, the dark table's otherwise", () => {
    // Pixel rows 0 and 1, column 21: empty over light.
    expect(pixelRows(true)[0]!.styles?.find((s) => s.start === 21)).toEqual({ start: 21, end: 22, color: LIGHT_PIXEL_COLORS.L });
    expect(pixelRows(false)).toEqual(pixelRows());
    expect(pixelRows(true).map((r) => r.text)).toEqual(pixelRows().map((r) => r.text));
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

  // The accent by its role, looked up where the rows are drawn, so without colour they have none (TUI design pass, Task 13;
  // startup.test.ts, "draws no colour at all without colour").
  it("draws each row in the accent colour, on one line", () => {
    expect(asciiRows()).toEqual(ASCII.map((text) => ({ text, color: "accent", oneLine: true })));
  });
});
