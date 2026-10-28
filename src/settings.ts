import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { oneOf, speedValue, statusSegments, taskCount } from "./clilib.js";
import { MODES, type Mode } from "./core/permissions.js";
import { errorText } from "./core/types.js";
import { EFFORTS, type Effort } from "./providers/anthropic.js";
import type { Segment } from "./tui/StatusLine.js";

// The settings file (release 6 design, "The settings file"): ~/.tachikoma/settings.json, the only one read, so a
// repository the user clones can never change how Tachikoma behaves.
export const SETTINGS = "settings.json";
const DIR = ".tachikoma";

export function settingsDir(home = os.homedir()): string {
  return path.join(home, DIR);
}

// The file's place as a message shows it: ~ for the home folder, with the system's own separator.
export function shownFile(platform: NodeJS.Platform = process.platform): string {
  return (platform === "win32" ? path.win32 : path.posix).join("~", DIR, SETTINGS);
}

// Every entry is optional; one that is absent keeps the default. The names follow the flags, or Claude Code's where it
// has the same setting. editorMode, vimInsertModeRemaps and editor are read and checked now, and used by later tasks.
export interface Settings {
  lead?: string;
  mode?: Mode;
  effort?: Effort;
  fallback?: string;
  worker?: string;
  maxTasks?: number;
  status?: Segment[];
  screen?: "full" | "classic";
  scrollSpeed?: number;
  editorMode?: "normal" | "vim";
  vimInsertModeRemaps?: Record<string, "<Esc>">;
  editor?: string;
}

export type Loaded = { settings: Settings; warnings: string[] } | { problem: string };

// Each value gets its flag's check and words, after the file's and the entry's names (the plan's choice 8); a value of the
// wrong JSON type is a problem too. An unknown name is a warning and the rest applies. $schema, which editors use to check
// the file, is allowed and ignored. The lead, fallback and worker are checked by createProvider at use, as flags are.
export function readSettings(text: string): Loaded {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { problem: `${SETTINGS} is not valid JSON: ${errorText(err)}` };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { problem: `${SETTINGS} must be one object, such as {"lead": "ollama:qwen3:8b"} (got ${JSON.stringify(data)})` };
  }
  const settings: Settings = {};
  const warnings: string[] = [];
  try {
    for (const [name, value] of Object.entries(data)) {
      const entry = `${SETTINGS}: ${JSON.stringify(name)}`;
      if (name === "$schema") continue;
      else if (name === "lead" || name === "fallback" || name === "worker" || name === "editor") settings[name] = textOf(entry, value);
      else if (name === "mode") settings.mode = oneOf(entry, textOf(entry, value), MODES);
      else if (name === "effort") settings.effort = oneOf(entry, textOf(entry, value), EFFORTS);
      else if (name === "screen") settings.screen = oneOf(entry, textOf(entry, value), ["full", "classic"] as const);
      else if (name === "editorMode") settings.editorMode = oneOf(entry, textOf(entry, value), ["normal", "vim"] as const);
      // As written in JSON, the number reads as the flag's text would: 8 as "8", 1.5 as "1.5".
      else if (name === "maxTasks") settings.maxTasks = taskCount(String(numberOf(entry, value)), entry);
      else if (name === "scrollSpeed") settings.scrollSpeed = speedValue(String(numberOf(entry, value)), entry);
      else if (name === "status") {
        // A list of names, as --status takes them comma-separated (the plan's choice 7); an empty one, which --status
        // cannot give either, is refused.
        if (!Array.isArray(value) || !value.length || !value.every((v) => typeof v === "string")) {
          throw wrongType(entry, 'a list of names, such as ["lead", "context"]', value);
        }
        settings.status = statusSegments(value, entry);
      } else if (name === "vimInsertModeRemaps") settings.vimInsertModeRemaps = remaps(entry, value, warnings);
      else warnings.push(`${entry} is not a setting; it was left out`);
    }
  } catch (err) {
    return { problem: errorText(err) };
  }
  return { settings, warnings };
}

// A missing file, or a missing folder, is {}: every default.
export function loadSettings(home = os.homedir()): Loaded {
  let text: string;
  try {
    text = readFileSync(path.join(settingsDir(home), SETTINGS), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { settings: {}, warnings: [] };
    return { problem: `${SETTINGS} could not be read: ${errorText(err)}` };
  }
  return readSettings(text);
}

const wrongType = (entry: string, what: string, value: unknown) => new Error(`${entry} must be ${what} (got ${JSON.stringify(value)})`);

function textOf(entry: string, value: unknown): string {
  if (typeof value !== "string") throw wrongType(entry, "text in quotes", value);
  return value;
}

function numberOf(entry: string, value: unknown): number {
  if (typeof value !== "number") throw wrongType(entry, "a number, without quotes", value);
  return value;
}

// Release 6 design, "Vim mode": two printable characters typed together go to NORMAL, and <Esc> is the only target. Other
// entries are left out with a warning, and the rest kept. Printable: no control, format, private-use or unassigned
// character.
function remaps(entry: string, value: unknown, warnings: string[]): Record<string, "<Esc>"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw wrongType(entry, 'an object, such as {"jj": "<Esc>"}', value);
  const kept: Record<string, "<Esc>"> = {};
  for (const [keys, target] of Object.entries(value)) {
    if (/^\P{C}{2}$/u.test(keys) && target === "<Esc>") kept[keys] = target;
    else warnings.push(`${entry} entry ${JSON.stringify(keys)} is not two printable characters mapped to "<Esc>"; it was left out`);
  }
  return kept;
}
