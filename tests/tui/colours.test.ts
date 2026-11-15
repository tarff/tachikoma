import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// TUI design pass, Task 13 (audit 12): every colour on screen comes from the palette (theme.ts), so NO_COLOR and the light
// look reach every part. This reads the source: src/tui, and the two files outside it whose lines reach the screen
// (cli.tsx's start-up lines, sandbox/diff.ts's /review diff). It cannot catch a colour name built at runtime, one in a
// file it does not read, one handed in from settings or a library, or one passed to a component this source does not
// write; nor dim, bold or inverse, which are styles, not colours, and are kept without colour on purpose (Task 2).
const ROOT = path.join(import.meta.dirname, "..", "..", "src");
const FILES = [
  ...readdirSync(path.join(ROOT, "tui"), { recursive: true, encoding: "utf8" })
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => path.join("tui", f)),
  "cli.tsx",
  path.join("sandbox", "diff.ts"),
].map((f) => f.split(path.sep).join("/"));
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8").split(/\r?\n/);

// A colour by name as Ink takes it (chalk's names, `Bright` ones too), a hex or rgb()/hex()/ansi256() colour, a chalk
// style (chalk.level, which cli.tsx reads for the look, is not one), or an SGR escape written out.
const NAMED = /(["'`])(black|red|green|yellow|blue|magenta|cyan|white|gray|grey)(Bright)?\1/;
const HEX = /(["'`])#[0-9a-f]{3,8}\1/i;
const FUNCTION = /(["'`])(rgb|hsl|hsv|hex|ansi256)\(/;
const CHALK = /\bchalk\.(?!level\b)/;
const SGR = /\\(u001b|x1b|u\{1b\}|033)\[[\d;]*m/;

// The two exceptions (plan, Task 13): the status line's mode colours and its context bar's, which mean risk and fullness.
const EXCEPTION = /^const MODE_COLOR\b|^export function contextBar\b|^ {2}return \{ filled, color: usedPercent/;

describe("colours in the source", () => {
  it("reads the files it should", () => {
    expect(FILES).toEqual(expect.arrayContaining(["tui/App.tsx", "tui/app/queue.ts", "tui/describe.ts", "cli.tsx", "sandbox/diff.ts"]));
  });

  it("names no colour outside theme.ts and the status line's two exceptions", () => {
    const found: string[] = [];
    for (const f of FILES) {
      if (f === "tui/theme.ts") continue; // the palette itself
      read(f).forEach((line, n) => {
        if (f === "tui/StatusLine.tsx" && EXCEPTION.test(line)) return;
        // cli.tsx's grey lines on stderr, before or without the App: Node's styleText, which reads NO_COLOR itself.
        if (f === "cli.tsx" && line.includes("styleText(\"gray\"")) return;
        // The pixel art's own colours (art.ts), drawn only as spans, which Run drops without colour (Conversation.tsx).
        const hex = f !== "tui/art.ts" && HEX.test(line);
        if (NAMED.test(line) || hex || FUNCTION.test(line) || CHALK.test(line) || SGR.test(line)) found.push(`${f}:${n + 1}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });

  // A line's or a row's colour is a role (theme.ts, Role), a string Ink would take, so the types do not catch one handed
  // to Ink as it is: every colour prop reads the palette or look.color (a span's colour is a value, dropped without
  // colour). The status line's pieces carry the palette's values (StatusLine.tsx, pieces).
  it("hands Ink no colour that is not looked up in the palette", () => {
    const found: string[] = [];
    for (const f of FILES)
      read(f).forEach((line, n) => {
        if (f === "tui/StatusLine.tsx" && line.includes("color={p.color}")) return;
        if (/\b(color|backgroundColor|borderColor)=\{/.test(line) && !/palette|look\.color/.test(line)) found.push(`${f}:${n + 1}: ${line.trim()}`);
      });
    expect(found).toEqual([]);
  });

  it("draws the two exceptions only while look.color is true", () => {
    const lines = read("tui/StatusLine.tsx");
    const mode = lines.filter((l) => l.includes("MODE_COLOR["));
    const bar = lines.filter((l) => /contextBar\([^)]*\)\.color|\bbar\.color\b/.test(l));
    expect(mode.length).toBeGreaterThan(0);
    expect(bar.length).toBeGreaterThan(0);
    for (const l of [...mode, ...bar]) expect(l).toMatch(/look\.color \?/);
  });
});
