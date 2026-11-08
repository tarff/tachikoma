import { errorText } from "../core/types.js";

// The hooks entry of the settings file, in Claude Code's shape, so a hook made for Claude Code works unchanged (release 8b
// design, "The settings entry"). What Tachikoma cannot run is left out with a warning and the rest applies; a value of the
// wrong JSON type is a problem, as for every other entry (settings.ts), and the file is not applied.

// Claude Code's names for the events Tachikoma runs hooks at (release 8b design, "What 8b covers").
export const EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "Stop", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact"] as const;
export type Event = (typeof EVENTS)[number];

export interface Hook {
  event: Event;
  matcher: Matcher;
  command: string;
  args?: string[];
  shell?: "bash" | "powershell";
  timeout?: number;
  async: boolean;
  onFailure?: "continue" | "block";
  statusMessage?: string;
  where: string; // the warning's place, `"PreToolUse"`, for lines and /hooks
}
export type Matcher = { all: true } | { names: string[] } | { regex: RegExp };
export interface HooksConfig { hooks: Hook[]; off: boolean; leftOut: string[] } // leftOut: the warnings' words, for /hooks

// As settings.ts's, whose words every entry's problems use; that module imports this one.
const wrongType = (entry: string, what: string, value: unknown) => new Error(`${entry} must be ${what} (got ${JSON.stringify(value)})`);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");

const EXAMPLE = '{"type": "command", "command": "check.sh"}';
const GROUP = `{"matcher": "Bash", "hooks": [${EXAMPLE}]}`;
// Claude Code's events that take no matcher; one written there is ignored, as Claude Code ignores it.
const NO_MATCHER: readonly Event[] = ["UserPromptSubmit", "Stop"];

// `entry` is the file's and the entry's names, `settings.json: "hooks"`, which each warning starts with.
export function readHooks(entry: string, value: unknown, warnings: string[]): Hook[] {
  if (!isObject(value)) throw wrongType(entry, `an object of events, each a list, such as {"PreToolUse": [${GROUP}]}`, value);
  const hooks: Hook[] = [];
  for (const [name, groups] of Object.entries(value)) {
    const where = JSON.stringify(name);
    const place = `${entry}: ${where}`;
    if (!(EVENTS as readonly string[]).includes(name)) {
      warnings.push(`${place} is not an event Tachikoma runs hooks at; its hooks were left out`);
      continue;
    }
    const event = name as Event;
    if (!Array.isArray(groups)) throw wrongType(place, `a list, such as [${GROUP}]`, groups);
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) throw wrongType(`${place}: each entry`, `an object with a list of "hooks", such as ${GROUP}`, group);
      // A misspelled key is dropped and the rest of the entry applies (the user's words at Task 1's review).
      for (const key of Object.keys(group)) {
        if (key === "matcher" || key === "hooks") continue;
        warnings.push(`${place} has an entry with ${JSON.stringify(key)}, which is not "matcher" or "hooks"; it was left out`);
      }
      const matcher = NO_MATCHER.includes(event) ? { all: true as const } : groupMatcher(place, group.matcher);
      for (const h of group.hooks) {
        const hook = hookOf(place, h, warnings);
        if (hook) hooks.push({ event, matcher, ...hook, where });
      }
    }
  }
  return hooks;
}

function groupMatcher(place: string, text: unknown): Matcher {
  if (text !== undefined && typeof text !== "string") throw wrongType(`${place}: "matcher"`, "text in quotes", text);
  try {
    return matcherOf(text);
  } catch (err) {
    throw new Error(`${place}: "matcher" ${JSON.stringify(text)} is not a regular expression that can be read (${errorText(err)})`);
  }
}

// One hook's fields, or undefined for one left out. A hook of another kind is left out before its fields are read, as
// they are that kind's own.
function hookOf(place: string, h: unknown, warnings: string[]): Omit<Hook, "event" | "matcher" | "where"> | undefined {
  if (!isObject(h)) throw wrongType(`${place}: each hook`, `an object, such as ${EXAMPLE}`, h);
  const field = (name: string) => `${place}: a hook's ${JSON.stringify(name)}`;
  const missing = (name: string) => new Error(`${place}: a hook must have ${JSON.stringify(name)}, such as ${EXAMPLE}`);
  if (h.type === undefined) throw missing("type");
  if (typeof h.type !== "string") throw wrongType(field("type"), 'text in quotes, such as "command"', h.type);
  if (h.type !== "command") {
    warnings.push(`${place} has a ${JSON.stringify(h.type)} hook; only "command" hooks run, so it was left out`);
    return undefined;
  }
  // The command and its args come before the warnings below, which end with them so that two alike can be told apart
  // (the user's words at Task 1's review).
  if (h.command === undefined) throw missing("command");
  if (typeof h.command !== "string") throw wrongType(field("command"), "text in quotes", h.command);
  const args = h.args;
  if (args !== undefined && !texts(args)) throw wrongType(field("args"), "a list of text in quotes", args);
  const named = (words: string) => warnings.push(`${place} ${words}: ${[h.command, ...(args ?? [])].join(" ")}`);
  // Claude Code runs a hook with `if` only when its permission rule matches, which Tachikoma cannot check, and running it
  // every time would be wrong (release 8b design, "The settings entry").
  if ("if" in h) {
    named('has a hook with "if", which Tachikoma cannot check, so it was left out');
    return undefined;
  }
  const hook: Omit<Hook, "event" | "matcher" | "where"> = { command: h.command, async: false };
  if (args !== undefined) hook.args = args;
  for (const [name, v] of Object.entries(h)) {
    if (name === "type" || name === "command" || name === "args") continue;
    else if (name === "shell") {
      if (v !== "bash" && v !== "powershell") throw wrongType(field(name), '"bash" or "powershell"', v);
      hook.shell = v;
    } else if (name === "timeout") {
      if (typeof v !== "number" || !Number.isFinite(v) || !(v > 0)) throw wrongType(field(name), "a number of seconds above 0, such as 30", v);
      hook.timeout = v;
    } else if (name === "async" || name === "asyncRewake") {
      if (typeof v !== "boolean") throw wrongType(field(name), "true or false, without quotes", v);
      if (name === "asyncRewake" && v) named('has a hook with "asyncRewake"; it runs as plain "async"');
      hook.async ||= v;
    } else if (name === "onFailure") {
      if (v !== "continue" && v !== "block") throw wrongType(field(name), '"continue" or "block"', v);
      hook.onFailure = v;
    } else if (name === "statusMessage") {
      if (typeof v !== "string") throw wrongType(field(name), "text in quotes", v);
      hook.statusMessage = v;
    } else if (name === "once") continue; // Claude Code ignores it in settings files (release 8b design, "The settings entry")
    else named(`has a hook with ${JSON.stringify(name)}, which is not a hook field; it was left out`);
  }
  return hook;
}

// Claude Code's rules (release 8b design, "The settings entry"): empty, missing or * is every value; only letters,
// digits, _, -, spaces, commas and | is a list of exact names; anything else is a regular expression, unanchored.
// A regular expression that does not compile throws.
export function matcherOf(text: string | undefined): Matcher {
  if (!text || text === "*") return { all: true };
  if (/^[A-Za-z0-9_\- ,|]+$/.test(text)) return { names: text.split(/[|,]/).map((n) => n.trim()) };
  return { regex: new RegExp(text) };
}

// Minding letter case, as Claude Code does.
export function matches(m: Matcher, value: string): boolean {
  if ("all" in m) return true;
  if ("names" in m) return m.names.includes(value);
  return m.regex.test(value);
}
