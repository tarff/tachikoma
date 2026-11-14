import { createContext } from "react";
import type { Settings } from "../settings.js";

// The one palette every component takes its colours from (TUI design pass, design's "Colour and themes"; plan, Task 1).

// What the terminal can show: a light background or a dark one, any colour, and full (24-bit) colour.
export interface Look {
  light: boolean;
  color: boolean;
  full: boolean;
}

// Each one a colour Ink's `color` and `backgroundColor` take; undefined is the terminal's own.
export interface Palette {
  accent: string | undefined;
  text: string | undefined;
  muted: string | undefined;
  success: string | undefined;
  error: string | undefined;
  warning: string | undefined;
  band: string | undefined;
  addTint: string | undefined;
  delTint: string | undefined;
}

// A colour by its meaning, named as the palette's entry for it: what a line built outside React carries (describe.ts,
// Line), looked up in the palette where the line is drawn, so a line holds no colour of its own and NO_COLOR and the light
// look reach it (TUI design pass, Task 13; audit 12).
export type Role = "accent" | "muted" | "success" | "error" | "warning";

// `level` is chalk's (0 to 3), the check Ink itself uses. NO_COLOR set to anything non-empty is no colour (no-color.org),
// which Tachikoma checks itself, as chalk's check does not. In auto, COLORFGBG ("foreground;background", which some
// terminals set) with a background of 7 or 15 is light; unset, empty or not those numbers is dark, as on Windows Terminal.
export function look(settings: Settings, env: NodeJS.ProcessEnv, level: number): Look {
  const color = !env.NO_COLOR && level > 0;
  const theme = settings.theme ?? "auto";
  const background = env.COLORFGBG?.split(";").at(-1);
  const light = theme === "light" || (theme === "auto" && (background === "7" || background === "15"));
  return { light, color, full: color && level === 3 };
}

// The hex colours for full colour. text is the terminal's own foreground. accent is the pixel art's blue B (plan, appendix
// "The pixel art"), the design's Tachikoma blue; every other value is a placeholder, none measured, set by eye with the
// user at Task 14's terminal check (choice P4).
const DARK: Palette = {
  accent: "#4278de",
  text: undefined,
  muted: "#8a8a8a",
  success: "#5fbf6f",
  error: "#f0605f",
  warning: "#e0b84a",
  band: "#2a2a2a",
  addTint: "#1f3a26",
  delTint: "#432124",
};
const LIGHT: Palette = {
  accent: "#4278de",
  text: undefined,
  muted: "#6b6b6b",
  success: "#1f8a3c",
  error: "#c62828",
  warning: "#9a6700",
  band: "#ececec",
  addTint: "#dcf5e0",
  delTint: "#fbe0e0",
};

// Without full colour, Ink's named colours, which the terminal's own palette draws, and no band or tints (design's "Colour
// depth"); without colour, none at all.
export function palette(shown: Look): Palette {
  if (shown.full) return shown.light ? LIGHT : DARK;
  return {
    accent: shown.color ? "blue" : undefined,
    text: undefined,
    muted: shown.color ? "gray" : undefined,
    success: shown.color ? "green" : undefined,
    error: shown.color ? "red" : undefined,
    warning: shown.color ? "yellow" : undefined,
    band: undefined,
    addTint: undefined,
    delTint: undefined,
  };
}

// The look with its palette: drawing reads look.color and look.full too (plan, Tasks 2, 6 and 13).
export interface Theme {
  look: Look;
  palette: Palette;
}

// The App's theme, set in cli.tsx; tests that give none get the dark full one.
export const ThemeContext = createContext<Theme>({ look: { light: false, color: true, full: true }, palette: DARK });
