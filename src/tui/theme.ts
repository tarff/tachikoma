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

// The hex colours for full colour. text is the terminal's own foreground. None is measured: band, addTint and delTint are
// placeholders, set by eye with the user at Task 14's check (choice P4); the others are placeholders checked there too.
const DARK: Palette = {
  accent: "#5f9cf5",
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
  accent: "#1f5fcc",
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
export function palette(l: Look): Palette {
  if (l.full) return l.light ? LIGHT : DARK;
  const named = l.color;
  return {
    accent: named ? "blue" : undefined,
    text: undefined,
    muted: named ? "gray" : undefined,
    success: named ? "green" : undefined,
    error: named ? "red" : undefined,
    warning: named ? "yellow" : undefined,
    band: undefined,
    addTint: undefined,
    delTint: undefined,
  };
}

// The App's palette, set in cli.tsx; tests that give none get the dark full one.
export const ThemeContext = createContext<Palette>(DARK);
