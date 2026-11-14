import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { Menu } from "../../src/tui/Menu.js";
import type { Entry } from "../../src/tui/menus.js";

const entry = (label: string, note?: string): Entry => ({ label, fill: label, ...(note && { note }) });
const MODEL = entry("/model", "Pick the lead model from a list");
const LEAD = entry("/lead <provider:model>", "Switch the lead model; alone, pick it from a list");
const EXIT = entry("/exit", "Quit");
const drawn = (entries: Entry[], rows: number, columns: number) => renderToString(<Menu entries={entries} chosen={0} rows={rows} />, { columns }).split("\n");
// A row as the menu draws it, its label padded to `wide`, then two spaces and the note.
const row = (e: Entry, wide: number) => `  ${e.label.padEnd(wide)}  ${e.note}`;

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

  it("still cuts a label longer than the width at its end", () => {
    const long = entry(`/${"x".repeat(60)}`, "A note");
    expect(drawn([long], 1, 50)).toEqual([`  /${"x".repeat(46)}…`]);
  });
});
