import { describe, expect, it } from "vitest";
import { onScreen } from "../../src/tui/DetailView.js";
import { find } from "../../src/tui/find.js";
import { Rows } from "../../src/tui/view.js";

// Only the matches on the lines drawn go to the drawing, which looks at each one for every row (found at Task 12's
// review: 24,000 matches took 23 ms a frame).
describe("onScreen", () => {
  const rows = new Rows(10);
  rows.add([{ text: "a1" }, { text: "a2 a2 a2 a2" }, { text: "a3" }, { text: "a4" }]); // the second line is two rows
  const found = find(rows.lines, "a");

  it("keeps the matches on the lines of the rows shown, and none other", () => {
    expect(onScreen(rows, found, 1, 2)).toEqual(found.filter((m) => m.line === 1));
    expect(onScreen(rows, found, 2, 2)).toEqual(found.filter((m) => m.line === 1 || m.line === 2));
    expect(onScreen(rows, found, 0, 10)).toEqual(found);
  });
});
