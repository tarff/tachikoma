import type { Line, Span } from "./describe.js";
import type { Colour } from "./theme.js";

// The start-up box's two drawings (TUI design pass, Task 5): the pixel art for full colour, and the user's ASCII drawing
// where it does not fit or colour is short (Task 6).

// The pixel art, one letter a pixel (plan, appendix "The pixel art"): 48 wide, 30 tall. `.` is empty.
export const PIXELS: string[] = [
  "................................................",
  "..........................LLL.BBBBBBBB..........",
  "................SS.......LLLLLBBBBBBBBB.........",
  "................SS.......LLLLBRBBBBRBBBB........",
  ".................S.......LLLBBRBBBBRBBBBB.......",
  ".................S.......LLBBBBBBBBBBBBBBB......",
  ".................S.......LLBBBBBBBBBBBBBBB......",
  ".................S.......LLBBBBBBBBBBBBBBB......",
  "..............BBBBBBBWWW.LLBBBBBBBSSSSBBBB......",
  "...........WWWWLBBBBWWWWWLLBBBBBBSSBBSSBBWW.....",
  ".........LWWWWWLLLBBWWWWWWBBBBBBBSBBBBSBBWWW....",
  "........BWWWPWWWLLBWWPPPWWBBBBBBBSBBBBSBBWWW....",
  ".......BBWWPPPWWLBBWWPPPWWBBBBBBBSSBBSSBBBW.....",
  "......WWBBWPPPWSSSSSWWPWWBBBBBBBBBSSSSBBBB......",
  "......WWWBWWWWWBBBBBBWWWSSBBBBBBBBBBBBBBBB......",
  "......WWSSSBBBBBBBBBBBBBBSSSBBBBBBBBBBBBB.......",
  "......SSSSSSSSSSSSSSSSSSSSSSSSBBBBBBBBBBB.......",
  ".......SSBBBBBBBBBBBBBBBBBBSS.BBBBBBBBBSSSS.....",
  ".....S.SSBBBBBBBBBBBBBBBBBBSS.BBBBBBBB.SSSSS....",
  "....SS..SGGBBBBBBBBBBBBBBGGGS............SSS....",
  "....SS.BBGGGBBBBGGBBBBBBBGGGBB............SSS...",
  "...SSSBBBBGSSBBBGGGBBBBSSGGBBBB...........SSS...",
  "...SSBBBB....SSSBGBSSSS....BBBBB...........SSS..",
  "..SSBBBB........BBB..........BBBB..........SDD..",
  "..DDBBB.........BBB...........BBB...........DDD.",
  "..DDDB.........BBB............BBB...............",
  "...BBB.........BBB.............BBB..............",
  "..BBB.........BBB..............BBB..............",
  "..DDB.........DDB..............BDD..............",
  ".DDDD........DDDD..............DDDD.............",
];

// Each letter's colour, from the same appendix: blue, shade, light, white, pupil, dark, red, grey.
export const PIXEL_COLORS: Record<string, Colour> = {
  B: "#4278de",
  S: "#284ea0",
  L: "#8cb4f5",
  W: "#ebf0f8",
  P: "#191e2d",
  D: "#373c4b",
  R: "#dc3c32",
  G: "#bec3cd",
};

// Two pixel rows to a text row: `▀` in the top pixel's colour on the bottom's, `▄` or `▀` where only one is set, `█` where
// both are the same, a space where neither is. For full colour only, as Task 6 picks it: without colour a cell where two
// colours meet loses its bottom half, and in named colours the three blues blur together.
export function pixelRows(): Line[] {
  const rows: Line[] = [];
  for (let r = 0; r < PIXELS.length; r += 2) {
    const top = PIXELS[r]!;
    const bottom = PIXELS[r + 1]!; // PIXELS has an even number of rows, all the same length (tests)
    let text = "";
    const styles: Span[] = [];
    for (let c = 0; c < top.length; c++) {
      const up = PIXEL_COLORS[top[c]!];
      const down = PIXEL_COLORS[bottom[c]!];
      const span = { start: c, end: c + 1 };
      if (up && down && up !== down) styles.push({ ...span, color: up, bg: down });
      else if (up || down) styles.push({ ...span, color: (up ?? down)! });
      text += up && down ? (up === down ? "█" : "▀") : up ? "▀" : down ? "▄" : " ";
    }
    rows.push({ text, styles, oneLine: true });
  }
  return rows;
}

// The user's drawing, as it was in tachikoma.txt (choice E), one string a row.
export const ASCII: string[] = [
  "            _____",
  "           /_____\\",
  "          | [] []|",
  "        | |     (O)",
  "      __|_|__    |",
  "    .' O   O `.  |",
  "   (    o     )__|",
  "  / `-------' \\  \\",
  " /  /== /==\\   |  \\",
  "(O)/   /    \\  |  (O)",
  "             \\_|",
  "             (O)",
];

// The drawing's rows in the palette's accent, looked up where they are drawn (TUI design pass, Task 13).
export function asciiRows(): Line[] {
  return ASCII.map((text) => ({ text, color: "accent", oneLine: true }));
}
