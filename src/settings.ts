import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { withLock } from "./auth/lock.js";
import { privateDir, writePrivate } from "./auth/private.js";
import { oneOf, speedValue, statusSegments, taskCount } from "./clilib.js";
import { SETTINGS, SETTINGS_DIR, settingsDir } from "./core/datadir.js";
import { MODES, type Mode } from "./core/permissions.js";
import { errorText } from "./core/types.js";
import { EFFORTS, type Effort } from "./providers/anthropic.js";
import type { Segment } from "./tui/StatusLine.js";

// The names live beside the data folder's, so the file tools can refuse them without loading this module.
export { SETTINGS, settingsDir };

// The file's place as a message shows it: ~ for the home folder, with the system's own separator.
export function shownFile(platform: NodeJS.Platform = process.platform): string {
  return (platform === "win32" ? path.win32 : path.posix).join("~", SETTINGS_DIR, SETTINGS);
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
  const settings: Settings = {};
  const warnings: string[] = [];
  try {
    for (const [name, value] of Object.entries(entriesOf(text))) {
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

// Release 6 design, "The settings file", "Saving": one entry set, every other kept as it was, entries the user added
// included, in their order. The file is read again under the lock, so two sessions saving at once lose nothing, and
// written as JSON with two-space indents (the plan's choice 2). A file that is not one object is left as it is, and the
// promise rejects with why.
export async function saveSetting<K extends keyof Settings>(key: K, value: Settings[K], home = os.homedir()): Promise<void> {
  const dir = settingsDir(home);
  const file = path.join(dir, SETTINGS);
  privateDir(dir); // the lock file goes there too
  await withLock(`${file}.lock`, async () => {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const data = entriesOf(text);
    data[key] = value;
    writePrivate(file, `${JSON.stringify(data, null, 2)}\n`);
  });
}

// The file's entries, before any is checked. A byte-order mark at the start, which Windows PowerShell 5.1's Out-File
// and Set-Content -Encoding utf8 write, is skipped; an empty file, or one of only whitespace, means nothing set, not a
// broken file (the coordinator's decision, 2026-10-28, in the spirit of the plan's choice 3).
function entriesOf(text: string): Record<string, unknown> {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) return {};
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`${SETTINGS} is not valid JSON: ${errorText(err)}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`${SETTINGS} must be one object, such as {"lead": "ollama:qwen3:8b"} (got ${JSON.stringify(data)})`);
  }
  return data as Record<string, unknown>;
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
