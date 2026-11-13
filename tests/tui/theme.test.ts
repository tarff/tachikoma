import { describe, expect, it } from "vitest";
import { look, palette } from "../../src/tui/theme.js";

// TUI design pass, Task 1: the look from the theme setting, COLORFGBG, NO_COLOR and chalk's colour level, and the palette
// from the look.
describe("look", () => {
  it("is light or dark as the theme says, and in auto as COLORFGBG's background says", () => {
    const light = (theme: "auto" | "dark" | "light" | undefined, COLORFGBG?: string) =>
      look(theme ? { theme } : {}, COLORFGBG === undefined ? {} : { COLORFGBG }, 3).light;
    expect(light("light")).toBe(true);
    expect(light("light", "15;0")).toBe(true);
    expect(light("dark")).toBe(false);
    expect(light("dark", "0;15")).toBe(false);
    expect(light("auto", "0;15")).toBe(true);
    expect(light(undefined, "0;15")).toBe(true); // auto is the default
    expect(light("auto", "15;0")).toBe(false);
    expect(light("auto", "0;7")).toBe(true);
    expect(light("auto", "default;default")).toBe(false);
    expect(light("auto", "")).toBe(false);
    expect(light("auto")).toBe(false);
  });

  it("has colour from level 1, full colour at level 3 only, and none with NO_COLOR set", () => {
    expect(look({}, {}, 0)).toEqual({ light: false, color: false, full: false });
    expect(look({}, {}, 1)).toEqual({ light: false, color: true, full: false });
    expect(look({}, {}, 2)).toEqual({ light: false, color: true, full: false });
    expect(look({}, {}, 3)).toEqual({ light: false, color: true, full: true });
    for (const level of [0, 1, 2, 3]) expect(look({}, { NO_COLOR: "1" }, level)).toEqual({ light: false, color: false, full: false });
    expect(look({}, { NO_COLOR: "" }, 3).full).toBe(true); // set but empty is not set (no-color.org)
  });
});

describe("palette", () => {
  const KEYS = ["accent", "text", "muted", "success", "error", "warning", "band", "addTint", "delTint"];

  it("is hex colours in full colour, the band and tints among them, light and dark apart", () => {
    const dark = palette({ light: false, color: true, full: true });
    const light = palette({ light: true, color: true, full: true });
    for (const p of [dark, light]) {
      expect(Object.keys(p).sort()).toEqual([...KEYS].sort());
      for (const key of ["accent", "muted", "success", "error", "warning", "band", "addTint", "delTint"] as const) {
        expect(p[key]).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
    expect(dark.band).not.toBe(light.band);
  });

  it("is Ink's named colours without full colour, with no band or tints", () => {
    for (const lit of [false, true]) {
      expect(palette({ light: lit, color: true, full: false })).toEqual({
        accent: "blue",
        text: undefined,
        muted: "gray",
        success: "green",
        error: "red",
        warning: "yellow",
        band: undefined,
        addTint: undefined,
        delTint: undefined,
      });
    }
  });

  it("is no colour at all without colour", () => {
    const p = palette({ light: false, color: false, full: false });
    expect(Object.keys(p).sort()).toEqual([...KEYS].sort());
    for (const key of KEYS) expect(p[key as keyof typeof p]).toBeUndefined();
  });
});
