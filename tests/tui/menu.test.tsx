import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { Menu } from "../../src/tui/Menu.js";
import type { Entry } from "../../src/tui/menus.js";

const entry = (label: string, note?: string): Entry => ({ label, fill: label, ...(note && { note }) });
const MODEL = entry("/model", "Pick the lead model from a list");
const LEAD = entry("/lead <provider:model>", "Switch the lead model; alone, pick it from a list");
const EXIT = entry("/exit", "Quit");
const drawn = (entries: Entry[], rows: number, columns: number, chosen = 0) =>
  renderToString(<Menu entries={entries} chosen={chosen} rows={rows} columns={columns} />, { columns }).split("\n");
// A row as the menu draws it, its label padded to `wide`, then two spaces and the note.
const row = (e: Entry, wide: number) => `  ${e.label.padEnd(wide)}  ${e.note}`;
// A row cut at its end, as Ink cuts one wider than `columns`.
const cut = (text: string, columns: number) => (text.length > columns ? `${text.slice(0, columns - 1)}…` : text);
const label = (width: number, note?: string) => entry(`/${"x".repeat(width - 1)}`, note);

// TUI design pass, Task 11 (audit 9): each entry's note starts in one column, two spaces after the longest label among
// the entries shown; a row too long for the width is cut at its end.
describe("Menu", () => {
  it("starts every note in one column at 100 columns", () => {
    expect(drawn([MODEL, LEAD, EXIT], 3, 100)).toEqual([row(MODEL, 22), row(LEAD, 22), row(EXIT, 22)]);
  });

  it("starts every note in one column at 50 columns, cutting a row too long at its end", () => {
    expect(drawn([MODEL, LEAD, EXIT], 3, 50)).toEqual([`${row(MODEL, 22).slice(0, 49)}…`, `${row(LEAD, 22).slice(0, 49)}…`, row(EXIT, 22)]);
  });

  it("lines the notes up by the labels shown, not those scrolled off", () => {
    // Three rows for five entries: the first two, then the row counting the rest in the long label's place.
    expect(drawn([MODEL, EXIT, LEAD, EXIT, EXIT], 3, 100)).toEqual([row(MODEL, 6), row(EXIT, 6), "  ↓ 3 more"]);
  });

  it("lines the notes up by the labels shown, not one the row counting those above stands in for", () => {
    // Three rows, the last of four entries chosen: the long label's row counts the one above it.
    expect(drawn([EXIT, LEAD, MODEL, EXIT], 3, 100, 3)).toEqual(["  ↑ 2 more", row(MODEL, 6), row(EXIT, 6)]);
  });

  it("still cuts a label longer than the width at its end", () => {
    const long = entry(`/${"x".repeat(60)}`, "A note");
    expect(drawn([long], 1, 50)).toEqual([`  /${"x".repeat(46)}…`]);
  });

  // The user's choice, 2026-11-15 ("No room left"): a label whose row has no room for a note does not set the column;
  // its own note follows it by two spaces, cut at the row's end.
  it("leaves a label with no room for a note out of the column", () => {
    const long = label(61, "A note");
    expect(drawn([long, MODEL, EXIT], 3, 50)).toEqual([cut(row(long, 61), 50), cut(row(MODEL, 6), 50), row(EXIT, 6)]);
  });

  // The user's choice, 2026-11-15 ("Count the …"): Ink's cut puts `…` in the row's last column, so a label sets the
  // column only when its note shows at least one character before it.
  it("lets a label whose note shows one character before the … set the column, and not one whose note shows none", () => {
    // At 34 columns, the row's first two spaces, a label 28 columns wide and its two spaces leave the note one character
    // and the …; a label 29 wide leaves it only the ….
    const short = label(28, "Note");
    const edge = label(29, "Note");
    expect(drawn([short, EXIT], 2, 34)).toEqual([cut(row(short, 28), 34), cut(row(EXIT, 28), 34)]);
    expect(drawn([short], 1, 34)).toEqual([`  ${short.label}  N…`]);
    expect(drawn([edge, EXIT], 2, 34)).toEqual([cut(row(edge, 29), 34), row(EXIT, 5)]);
  });

  // The user's choice, 2026-11-15 ("Leave it out"): a row with no note, as an MCP prompt with no description, shows its
  // label alone and does not set the column.
  it("leaves a label with no note out of the column", () => {
    const bare = label(40);
    expect(drawn([bare, MODEL, EXIT], 3, 100)).toEqual([`  ${bare.label}`, row(MODEL, 6), row(EXIT, 6)]);
  });

  it("counts a wide label by its columns, not its characters", () => {
    const wide = entry("/日本語", "Note"); // 4 characters, 7 columns
    expect(drawn([wide, EXIT], 2, 100)).toEqual(["  /日本語  Note", `  /exit${" ".repeat(4)}Quit`]);
  });

  it("draws every row when no label shown has room for a note", () => {
    const [a, b] = [label(48, "A note"), label(60, "B note")];
    expect(drawn([a, b], 2, 50)).toEqual([cut(row(a, 48), 50), cut(row(b, 60), 50)]);
  });
});
