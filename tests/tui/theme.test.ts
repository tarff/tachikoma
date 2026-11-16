import { render } from "ink-testing-library";
import { createElement, useContext } from "react";
import { describe, expect, it } from "vitest";
import type { Span } from "../../src/tui/describe.js";
import type { Piece } from "../../src/tui/StatusLine.js";
import { type Colour, look, palette, type Theme, ThemeContext, themeOf } from "../../src/tui/theme.js";

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

  it("reads the theme apart from the colour depth", () => {
    expect(look({ theme: "light" }, {}, 0)).toEqual({ light: true, color: false, full: false });
  });

  // Clickable links plan, Task 1: links where hyperlinks() (links.ts) says the terminal takes them, no field otherwise.
  it("has links where the terminal takes them, and no links field where it does not", () => {
    expect(look({}, { WT_SESSION: "x" }, 3, true)).toEqual({ light: false, color: true, full: true, links: true });
    expect(look({}, { FORCE_HYPERLINK: "1" }, 3)).toEqual({ light: false, color: true, full: true, links: true });
    expect(look({}, { WT_SESSION: "x", NO_COLOR: "1" }, 3, true).links).toBe(true); // no colour, still links
    const none = [look({}, { WT_SESSION: "x" }, 3), look({}, { WT_SESSION: "x" }, 3, false), look({}, {}, 3, true)];
    for (const shown of none) expect("links" in shown).toBe(false);
  });
});

describe("themeOf", () => {
  // Task 13's code review: the look and its palette, as cli.tsx draws the App and the screens drawn alone in.
  it("is the look from the settings, the environment and the level, with its palette", () => {
    const shown = look({ theme: "light" }, { NO_COLOR: "" }, 3);
    expect(themeOf({ theme: "light" }, { NO_COLOR: "" }, 3)).toEqual({ look: shown, palette: palette(shown) });
    expect(themeOf({}, { NO_COLOR: "1" }, 3)).toEqual({ look: { light: false, color: false, full: false }, palette: palette({ light: false, color: false, full: false }) });
  });

  it("passes whether the output is a TTY on to the look (clickable links plan, Task 1)", () => {
    expect(themeOf({}, { WT_SESSION: "x" }, 3, true).look.links).toBe(true);
    expect("links" in themeOf({}, { WT_SESSION: "x" }, 3).look).toBe(false);
  });
});

// Task 13's code review: a role (theme.ts, Role) is not a colour, so tsc refuses one in a span, a status line piece or a
// palette; the checks are the @ts-expect-error lines, which fail tsc if the error goes.
describe("Colour", () => {
  it("takes hex colours and chalk's names, never a role", () => {
    const ok: Colour[] = ["#4278de", "gray", "redBright"];
    // @ts-expect-error a role in a span
    const span: Span = { start: 0, end: 1, color: "muted" };
    // @ts-expect-error a role in a status line piece
    const piece: Piece = { text: "x", color: "muted" };
    // @ts-expect-error a role as a colour
    const role: Colour = "error";
    expect([ok, span, piece, role]).toHaveLength(4);
  });
});

describe("ThemeContext", () => {
  it("gives the dark full look and its palette when none is given", () => {
    const dark = { light: false, color: true, full: true };
    let got: Theme | undefined;
    const Probe = () => {
      got = useContext(ThemeContext);
      return null;
    };
    render(createElement(Probe));
    expect(got).toEqual({ look: dark, palette: palette(dark) });
  });
});

describe("palette", () => {
  const KEYS = ["accent", "muted", "success", "error", "warning", "band", "addTint", "delTint"];

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
    expect([dark.accent, light.accent]).toEqual(["#4278de", "#4278de"]); // the pixel art's B (plan, appendix)
  });

  it("is Ink's named colours without full colour, with no band or tints", () => {
    for (const lit of [false, true]) {
      expect(palette({ light: lit, color: true, full: false })).toEqual({
        accent: "blue",
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
