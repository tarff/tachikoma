import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Network, NETWORKS, oneOf, SANDBOXES, type Sandbox, speedValue, statusSegments, taskCount } from "./clilib.js";
import { SETTINGS, SETTINGS_DIR, settingsDir } from "./core/datadir.js";
import { MODES, type Mode, OFFERED } from "./core/permissions.js";
import { errorText } from "./core/types.js";
import { type Hook, type HooksConfig, readHooks } from "./hooks/config.js";
import { readServers, type ServerConfig } from "./mcp/config.js";
import { EFFORTS, type Effort } from "./providers/anthropic.js";
import { type Kind, KINDS, type UserRules } from "./safety/rules.js";
import type { Segment } from "./tui/StatusLine.js";

// The names live beside the data folder's, so the file tools can refuse them without loading this module.
export { SETTINGS, settingsDir };

// What the file gives the Hooks object (release 8b plan, Tasks 4 and 12), the launch and a live edit alike: the hooks,
// whether disableAllHooks turns them off, and /hooks's left-out rows, as readSettings gives them (Loaded, hooksLeftOut).
export function hooksOf(settings: Settings, leftOut: string[] = []): HooksConfig {
  return { hooks: settings.hooks ?? [], off: settings.disableAllHooks === true, leftOut };
}

// The file's place as a message shows it: ~ for the home folder, with the system's own separator.
export function shownFile(platform: NodeJS.Platform = process.platform): string {
  return (platform === "win32" ? path.win32 : path.posix).join("~", SETTINGS_DIR, SETTINGS);
}

// Every entry is optional; one that is absent keeps the default. The names follow the flags, or Claude Code's where it
// has the same setting.
export interface Settings {
  lead?: string;
  mode?: Mode;
  effort?: Effort;
  fallback?: string;
  worker?: string;
  maxTasks?: number;
  // Days a session may go unchanged before the launch's sweep deletes it (release 8a design, "Saving sessions"). It is
  // read once, at the launch, so it is not LIVE (release 8a plan, Task 4).
  cleanupPeriodDays?: number;
  // The /autocompact size in tokens for every session, off unless set (release 8a design, "When to shorten"); LIVE (plan,
  // choice 26).
  autoCompactWindow?: number;
  status?: Segment[];
  screen?: "full" | "classic";
  scrollSpeed?: number;
  editorMode?: "normal" | "vim";
  vimInsertModeRemaps?: Record<string, "<Esc>">;
  editor?: string;
  dangerousCommands?: UserRules;
  sandbox?: Sandbox;
  network?: Network;
  judge?: string;
  sandboxLimits?: SandboxLimits;
  // The user's hooks, in Claude Code's shape (release 8b design, "The settings entry"); disableAllHooks turns them off,
  // and they are still read, so /hooks can say what is off (release 8b plan, Task 1). Both are LIVE.
  hooks?: Hook[];
  disableAllHooks?: boolean;
  // The user's MCP servers, in Claude Code's shape, ${VAR} filled in (release 8c design, "The settings entry"); LIVE, applied
  // by the /mcp task (release 8c plan, Tasks 2 and 10).
  mcpServers?: ServerConfig[];
}

// The box's limits as the user wrote them (release 7 plan, Task 12): memory in Docker's own units, g or m. Each one
// left out is the default for the Docker in use, and each one given is checked against it at the launch (choice 75,
// src/sandbox/executor.ts, boxLimits).
export interface SandboxLimits {
  memory?: string;
  cpus?: number;
  pids?: number;
}

// `hooksLeftOut`, with a "hooks" entry: /hooks's left-out rows, one for each of its warnings, in their order, each hook in
// them by its name (hooks/config.ts, readHooks).
export type Loaded = { settings: Settings; warnings: string[]; hooksLeftOut?: string[] } | { problem: string };

// Each value gets its flag's check and words, after the file's and the entry's names (the plan's choice 8); a value of the
// wrong JSON type is a problem too. An unknown name is a warning and the rest applies. $schema, which editors use to check
// the file, is allowed and ignored. The lead, fallback, worker and judge are checked by createProvider at use, as flags
// are. `env` fills the servers' ${VAR} (mcp/config.ts).
export function readSettings(text: string, env: NodeJS.ProcessEnv = process.env): Loaded {
  const settings: Settings = {};
  const warnings: string[] = [];
  let hooksLeftOut: string[] | undefined;
  try {
    for (const [name, value] of Object.entries(entriesOf(text))) {
      const entry = `${SETTINGS}: ${JSON.stringify(name)}`;
      if (name === "$schema") continue;
      else if (name === "lead" || name === "fallback" || name === "worker" || name === "editor" || name === "judge") settings[name] = textOf(entry, value);
      else if (name === "mode") settings.mode = oneOf(entry, textOf(entry, value), MODES, OFFERED);
      else if (name === "sandbox") settings.sandbox = oneOf(entry, textOf(entry, value), SANDBOXES);
      else if (name === "network") settings.network = oneOf(entry, textOf(entry, value), NETWORKS);
      else if (name === "effort") settings.effort = oneOf(entry, textOf(entry, value), EFFORTS);
      else if (name === "screen") settings.screen = oneOf(entry, textOf(entry, value), ["full", "classic"] as const);
      else if (name === "editorMode") settings.editorMode = oneOf(entry, textOf(entry, value), ["normal", "vim"] as const);
      // As written in JSON, the number reads as the flag's text would: 8 as "8", 1.5 as "1.5".
      else if (name === "maxTasks") settings.maxTasks = taskCount(String(numberOf(entry, value)), entry);
      else if (name === "cleanupPeriodDays") settings.cleanupPeriodDays = taskCount(String(numberOf(entry, value)), entry);
      else if (name === "autoCompactWindow") settings.autoCompactWindow = taskCount(String(numberOf(entry, value)), entry);
      else if (name === "scrollSpeed") settings.scrollSpeed = speedValue(String(numberOf(entry, value)), entry);
      else if (name === "status") {
        // A list of names, as --status takes them comma-separated (the plan's choice 7); an empty one, which --status
        // cannot give either, is refused.
        if (!Array.isArray(value) || !value.length || !value.every((v) => typeof v === "string")) {
          throw wrongType(entry, 'a list of names, such as ["lead", "context"]', value);
        }
        settings.status = statusSegments(value, entry);
      } else if (name === "vimInsertModeRemaps") settings.vimInsertModeRemaps = remaps(entry, value, warnings);
      else if (name === "dangerousCommands") settings.dangerousCommands = userRules(entry, value, warnings);
      else if (name === "sandboxLimits") settings.sandboxLimits = sandboxLimits(entry, value, warnings);
      else if (name === "hooks") settings.hooks = readHooks(entry, value, warnings, (hooksLeftOut = []));
      else if (name === "disableAllHooks") {
        if (typeof value !== "boolean") throw wrongType(entry, "true or false, without quotes", value);
        settings.disableAllHooks = value;
      } else if (name === "mcpServers") settings.mcpServers = readServers(SETTINGS, value, env, warnings);
      else warnings.push(`${entry} is not a setting; it was left out`);
    }
  } catch (err) {
    return { problem: errorText(err) };
  }
  return { settings, warnings, ...(hooksLeftOut && { hooksLeftOut }) };
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

// An empty file, or one of only whitespace after a byte-order mark: nothing set, not a broken file (the coordinator's
// decision, 2026-10-28, in the spirit of the plan's choice 3). The settings watcher skips the same texts.
export const emptyText = (text: string) => !text.trim(); // trim takes a byte-order mark (U+FEFF) as white space too (ECMA-262, WhiteSpace)

// The file's entries, before any is checked. A byte-order mark at the start, which Windows PowerShell 5.1's Out-File
// and Set-Content -Encoding utf8 write, is skipped; an empty file is {} (emptyText).
function entriesOf(text: string): Record<string, unknown> {
  if (emptyText(text)) return {};
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
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
// entries are left out with a warning, and the rest kept. The two are keys typed in turn, so each must be one a
// user can type alone: a letter, digit, punctuation mark or symbol, and no space (release 6 plan, choice 24).
// Two such code points can still be one character on screen, as a flag or a thumb with a skin tone is, so the two
// must also be two characters as the screen shows them.
function remaps(entry: string, value: unknown, warnings: string[]): Record<string, "<Esc>"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw wrongType(entry, 'an object, such as {"jj": "<Esc>"}', value);
  const kept: Record<string, "<Esc>"> = {};
  for (const [keys, target] of Object.entries(value)) {
    const two = /^[\p{L}\p{N}\p{P}\p{S}]{2}$/u.test(keys) && [...graphemes.segment(keys)].length === 2;
    if (two && target === "<Esc>") kept[keys] = target;
    else {
      warnings.push(`${entry} entry ${JSON.stringify(keys)} is not two letters, digits, punctuation marks or symbols mapped to "<Esc>"; it was left out`);
    }
  }
  return kept;
}
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// The user's own dangerous-command rules (release 7 plan, Task 4 and choice 5): "add", commands' first words, none blank,
// as a blank one would be the start of every command, and none with quotes, kept with single spaces; "off", kinds by
// their table names. Either may be left out, and a repeat is kept once. Other names in it are left out with a
// warning, as the file's own are.
function userRules(entry: string, value: unknown, warnings: string[]): UserRules {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw wrongType(entry, 'an object, such as {"add": ["terraform apply"], "off": ["installing software"]}', value);
  }
  const rules: UserRules = { add: [], off: [] };
  for (const [name, list] of Object.entries(value)) {
    const part = `${SETTINGS}: ${JSON.stringify(`dangerousCommands.${name}`)}`;
    if (name === "add") {
      if (!Array.isArray(list) || !list.every((v) => typeof v === "string" && v.trim())) {
        throw new Error(`${part} must be a list of commands in quotes, such as ["terraform apply"]`);
      }
      // A command's words have their quotes taken off (split.ts), so a rule holding one could never match.
      const quoted = list.find((v: string) => /["']/.test(v));
      if (quoted !== undefined) throw new Error(`${part} rules are matched word by word and cannot hold quotes (got ${JSON.stringify(quoted)})`);
      rules.add = [...new Set(list.map((v: string) => v.trim().split(/\s+/).join(" ")))]; // " make  deploy " is "make deploy"
    } else if (name === "off") {
      const bad = Array.isArray(list) ? list.find((v) => !(KINDS as readonly unknown[]).includes(v)) : list;
      if (bad !== undefined) throw new Error(`${part} must be a list of: ${KINDS.join(", ")} (got ${JSON.stringify(bad)})`);
      rules.off = [...new Set(list as Kind[])];
    } else warnings.push(`${part} is not a setting; it was left out`);
  }
  return rules;
}

// The box's limits (release 7 plan, Task 12): memory as a whole number of Docker's g or m, which Docker reads as
// gibibytes and mebibytes; CPUs above 0, with decimals, as Docker's --cpus takes them; processes a whole number from 1,
// as Docker's --pids-limit takes 0 and below as no limit. Other names in it are left out with a warning, as the file's
// own are.
function sandboxLimits(entry: string, value: unknown, warnings: string[]): SandboxLimits {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw wrongType(entry, 'an object, such as {"memory": "8g", "cpus": 4, "pids": 1024}', value);
  }
  const limits: SandboxLimits = {};
  for (const [name, v] of Object.entries(value)) {
    const part = `${SETTINGS}: ${JSON.stringify(`sandboxLimits.${name}`)}`;
    if (name === "memory") {
      if (typeof v !== "string" || !/^[1-9]\d*[gm]$/.test(v)) {
        throw wrongType(part, 'a whole number of gigabytes or megabytes in quotes, such as "8g" or "512m"', v);
      }
      limits.memory = v;
    } else if (name === "cpus") {
      if (typeof v !== "number" || !Number.isFinite(v) || !(v > 0)) throw wrongType(part, "a number of CPUs above 0, such as 2 or 1.5", v);
      // Docker refuses more ("value is too precise"; release 7 plan, choices 82 and 91).
      if (Number(v.toFixed(9)) !== v) throw new Error(`${part} can have at most 9 decimal places (got ${v})`);
      limits.cpus = v;
    } else if (name === "pids") {
      if (!Number.isInteger(v) || (v as number) < 1) throw wrongType(part, "a whole number of processes from 1, such as 1024", v);
      limits.pids = v as number;
    } else warnings.push(`${part} is not a setting; it was left out`);
  }
  return limits;
}
