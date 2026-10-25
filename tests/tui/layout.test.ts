import { describe, expect, it } from "vitest";
import { layout, scroll, vertical } from "../../src/tui/layout.js";

describe("layout", () => {
  it("wraps the prompt at the width, by columns", () => {
    const l = layout("abcdef", 3);
    expect(l.rows).toEqual(["abc", "def"]);
    expect(l.places.get(3)).toEqual({ row: 1, col: 0 }); // the cursor before "d" is where "d" is
    expect(l.places.get(6)).toEqual({ row: 1, col: 3 }); // after the last character, in the column left free
  });

  it("counts a wide character as two columns, and moves one that does not fit to the next row", () => {
    expect(layout("a中b", 3).rows).toEqual(["a中", "b"]);
    expect(layout("ab中", 3).rows).toEqual(["ab", "中"]);
    expect(layout("ab中", 3).places.get(2)).toEqual({ row: 1, col: 0 });
  });

  it("starts a row at each line break", () => {
    const l = layout("ab\ncd\n", 10);
    expect(l.rows).toEqual(["ab", "cd", ""]);
    expect(l.places.get(2)).toEqual({ row: 0, col: 2 });
    expect(l.places.get(3)).toEqual({ row: 1, col: 0 });
    expect(l.places.get(6)).toEqual({ row: 2, col: 0 });
    expect(layout("", 10).rows).toEqual([""]);
  });

  it("shows control characters as escapes, as wide as they are shown", () => {
    const l = layout("a\u001bb\tc", 20);
    expect(l.rows).toEqual(["a\\u001bb⇥c"]);
    expect(l.places.get(2)).toEqual({ row: 0, col: 7 });
  });
});

describe("vertical", () => {
  it("moves one row up or down as the screen shows it, keeping the column", () => {
    expect(vertical("abcdef", 3, 4, -1, null)).toEqual({ cursor: 1, goal: 1 });
    expect(vertical("abcdef", 3, 2, 1, null)).toEqual({ cursor: 5, goal: 2 });
  });

  it("goes to the end of a shorter row, and back to the column it came from on a longer one", () => {
    const text = "abcdef\nx\nabcdef";
    const down = vertical(text, 10, 5, 1, null)!;
    expect(down).toEqual({ cursor: 8, goal: 5 }); // after the "x"
    expect(vertical(text, 10, down.cursor, 1, down.goal)).toEqual({ cursor: 14, goal: 5 });
  });

  it("says there is no row above the first or below the last, where the history starts", () => {
    expect(vertical("ab\ncd", 10, 1, -1, null)).toBeNull();
    expect(vertical("ab\ncd", 10, 4, 1, null)).toBeNull();
  });
});

describe("scroll", () => {
  it("shows every row when they fit", () => {
    expect(scroll(3, 5, 2, 0)).toEqual({ top: 0, above: 0, below: 0 });
  });

  it("keeps the cursor's row in view, the first and last rows shown counting the rows cut off", () => {
    // Ten rows in four, the cursor on the last: rows 6 to 9 are shown, row 6 saying that 7 are above.
    expect(scroll(10, 4, 9, 0)).toEqual({ top: 6, above: 7, below: 0 });
    expect(scroll(10, 4, 7, 6)).toEqual({ top: 6, above: 7, below: 0 }); // still in view: the window stays
    expect(scroll(10, 4, 6, 6)).toEqual({ top: 5, above: 6, below: 2 }); // one row up, and a count below
    expect(scroll(10, 4, 1, 5)).toEqual({ top: 0, above: 0, below: 7 });
  });

  it("has no room for the counts in fewer than three rows", () => {
    expect(scroll(10, 2, 5, 0)).toEqual({ top: 4, above: 0, below: 0 });
    expect(scroll(10, 1, 5, 4)).toEqual({ top: 5, above: 0, below: 0 });
  });
});
