import { describe, expect, it } from "vitest";
import { find } from "../../src/tui/find.js";

// The detail view's search (release 5 design, "The detail view"; plan, Task 12).
describe("find", () => {
  it("finds the text in any case, in order, several in a line", () => {
    const lines = [{ text: "Login first" }, { text: "no match here" }, { text: "login, then LOGIN again" }];
    expect(find(lines, "LOGIN")).toEqual([
      { line: 0, start: 0, end: 5 },
      { line: 2, start: 0, end: 5 },
      { line: 2, start: 12, end: 17 },
    ]);
  });

  it("finds nothing where the text is not, nor for an empty query", () => {
    expect(find([{ text: "one" }, { text: "two" }], "three")).toEqual([]);
    expect(find([{ text: "one" }], "")).toEqual([]);
  });

  it("takes the query as plain text, not a pattern", () => {
    expect(find([{ text: "axb a.b (c) [d]" }], "a.b")).toEqual([{ line: 0, start: 4, end: 7 }]);
    expect(find([{ text: "axb a.b (c) [d]" }], "(c) [d]")).toEqual([{ line: 0, start: 8, end: 15 }]);
  });
});
