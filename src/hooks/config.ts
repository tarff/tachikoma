import { errorText } from "../core/types.js";
import { commandOf, hookName } from "./answer.js";

// The hooks entry of the settings file, in Claude Code's shape, so a hook made for Claude Code works unchanged (release 8b
// design, "The settings entry"). What Tachikoma cannot run is left out with a warning and the rest applies; a value of the
// wrong JSON type is a problem, as for every other entry (settings.ts), and the file is not applied.

// Claude Code's names for the events Tachikoma runs hooks at (release 8b design, "What 8b covers"), and a server's forms'
// two, matched on the server's name (release 8c plan, Task 8; Task 12 fires them).
export const EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "Stop", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact", "Elicitation", "ElicitationResult"] as const;
export type Event = (typeof EVENTS)[number];

// An mcp_tool hook calls `tool` on the running server `server` with `input`, its ${path} parts filled in from the hook's
// own input (release 8c design, "Hooks"; plan, choice 22). Such a hook's `command` is empty and never run.
export interface McpCall { server: string; tool: string; input: Record<string, unknown> }

export interface Hook {
  event: Event;
  matcher: Matcher;
  command: string;
  mcp?: McpCall;
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

// Node's setTimeout waits at most 2,147,483,647 ms, and past that fires after 1 ms (Node's docs for setTimeout), so a
// longer timeout would kill its hook at once (the user's choice at Task 2). An MCP call's limit uses it too (mcp/server.ts).
export const MAX_TIMER_MS = 2_147_483_647;
const MAX_SECONDS = Math.floor(MAX_TIMER_MS / 1000);
const TIMEOUT = `a number of seconds above 0 and no more than ${MAX_SECONDS}, such as 30`;

const EXAMPLE = '{"type": "command", "command": "check.sh"}';
const GROUP = `{"matcher": "Bash", "hooks": [${EXAMPLE}]}`;
// Claude Code's events that take no matcher; one written there is ignored, as Claude Code ignores it.
const NO_MATCHER: readonly Event[] = ["UserPromptSubmit", "Stop"];

// `entry` is the file's and the entry's names, `settings.json: "hooks"`, which each warning starts with. `leftOut` gets
// /hooks's left-out row for each warning, in the same order: its words after `"hooks": `, a hook named in them as /hooks
// names it (answer.ts, hookName) where the warning ends with its whole command, which the warnings said at launch and at a
// live edit keep (the user's choice, 2026-11-10, terminal checklist).
export function readHooks(entry: string, value: unknown, warnings: string[], leftOut: string[] = []): Hook[] {
  if (!isObject(value)) throw wrongType(entry, `an object of events, each a list, such as {"PreToolUse": [${GROUP}]}`, value);
  const hooks: Hook[] = [];
  for (const [name, groups] of Object.entries(value)) {
    const where = JSON.stringify(name);
    const place = `${entry}: ${where}`;
    const leave = (words: string, short = words) => {
      warnings.push(`${place} ${words}`);
      leftOut.push(`${where} ${short}`);
    };
    if (!(EVENTS as readonly string[]).includes(name)) {
      leave("is not an event Tachikoma runs hooks at; its hooks were left out");
      continue;
    }
    const event = name as Event;
    if (!Array.isArray(groups)) throw wrongType(place, `a list, such as [${GROUP}]`, groups);
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) throw wrongType(`${place}: each entry`, `an object with a list of "hooks", such as ${GROUP}`, group);
      // A misspelled key is dropped and the rest of the entry applies (the user's words at Task 1's review).
      for (const key of Object.keys(group)) {
        if (key === "matcher" || key === "hooks") continue;
        leave(`has an entry with ${JSON.stringify(key)}, which is not "matcher" or "hooks"; it was left out`);
      }
      const matcher = NO_MATCHER.includes(event) ? { all: true as const } : groupMatcher(place, group.matcher);
      for (const h of group.hooks) {
        const hook = hookOf(place, h, leave);
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
// they are that kind's own. `leave` says a warning's words after the place, and /hooks's row's when they differ.
type Leave = (words: string, short?: string) => void;
function hookOf(place: string, h: unknown, leave: Leave): Omit<Hook, "event" | "matcher" | "where"> | undefined {
  if (!isObject(h)) throw wrongType(`${place}: each hook`, `an object, such as ${EXAMPLE}`, h);
  const field = (name: string) => `${place}: a hook's ${JSON.stringify(name)}`;
  const missing = (name: string) => new Error(`${place}: a hook must have ${JSON.stringify(name)}, such as ${EXAMPLE}`);
  if (h.type === undefined) throw missing("type");
  if (typeof h.type !== "string") throw wrongType(field("type"), 'text in quotes, such as "command"', h.type);
  if (h.type !== "command" && h.type !== "mcp_tool") {
    leave(`has a ${JSON.stringify(h.type)} hook; only "command" and "mcp_tool" hooks run, so it was left out`);
    return undefined;
  }
  // The command and its args, or the server and tool, come before the warnings below, which end with them so that two
  // alike can be told apart (the user's words at Task 1's review).
  const mcp = h.type === "mcp_tool" ? mcpOf(place, h, field) : undefined;
  if (!mcp && h.command === undefined) throw missing("command");
  if (!mcp && typeof h.command !== "string") throw wrongType(field("command"), "text in quotes", h.command);
  const args = mcp ? undefined : h.args;
  if (args !== undefined && !texts(args)) throw wrongType(field("args"), "a list of text in quotes", args);
  const command = mcp ? "" : (h.command as string);
  const statusMessage = typeof h.statusMessage === "string" ? h.statusMessage : undefined;
  const named = (words: string) => leave(`${words}: ${commandOf({ command, args, mcp })}`, `${words}: ${hookName({ command, args, statusMessage, mcp })}`);
  // Claude Code runs a hook with `if` only when its permission rule matches, which Tachikoma cannot check, and running it
  // every time would be wrong (release 8b design, "The settings entry").
  if ("if" in h) {
    named('has a hook with "if", which Tachikoma cannot check, so it was left out');
    return undefined;
  }
  const hook: Omit<Hook, "event" | "matcher" | "where"> = mcp ? { command, mcp, async: false } : { command, async: false };
  if (args !== undefined) hook.args = args;
  // A command hook's own fields are not an mcp_tool hook's, so there they are fields it does not have.
  const own = mcp ? ["server", "tool", "input"] : ["command", "args"];
  for (const [name, v] of Object.entries(h)) {
    if (name === "type" || own.includes(name)) continue;
    else if (name === "shell" && !mcp) {
      if (v !== "bash" && v !== "powershell") throw wrongType(field(name), '"bash" or "powershell"', v);
      hook.shell = v;
    } else if (name === "timeout") {
      if (typeof v !== "number" || !Number.isFinite(v) || !(v > 0) || v > MAX_SECONDS) throw wrongType(field(name), TIMEOUT, v);
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

// An mcp_tool hook's server, tool and input (release 8c plan, Task 8): both names are needed, and its input, an object
// when given, is none when left out.
const MCP_EXAMPLE = '{"type": "mcp_tool", "server": "memory", "tool": "search"}';
function mcpOf(place: string, h: Record<string, unknown>, field: (name: string) => string): McpCall {
  for (const name of ["server", "tool"]) {
    if (h[name] === undefined) throw new Error(`${place}: an "mcp_tool" hook must have ${JSON.stringify(name)}, such as ${MCP_EXAMPLE}`);
    if (typeof h[name] !== "string") throw wrongType(field(name), "text in quotes", h[name]);
  }
  if (h.input !== undefined && !isObject(h.input)) throw wrongType(field("input"), "an object", h.input);
  return { server: h.server as string, tool: h.tool as string, input: (h.input as Record<string, unknown> | undefined) ?? {} };
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
