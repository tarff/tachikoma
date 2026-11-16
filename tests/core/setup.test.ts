import { describe, expect, it } from "vitest";
import { localDate } from "../../src/core/setup.js";

describe("localDate", () => {
  // The local date, not UTC's (design, "The date"): just after midnight here is still yesterday in UTC west of it.
  it("gives the local date as YYYY-MM-DD", () => {
    expect(localDate(new Date(2026, 10, 18, 0, 5))).toBe("2026-11-18");
    expect(localDate(new Date(2026, 0, 2, 23, 59))).toBe("2026-01-02");
  });
});
