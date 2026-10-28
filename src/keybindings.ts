import { KEYBINDINGS } from "./core/datadir.js";
import { errorText } from "./core/types.js";
import { emptyText } from "./settings.js";
import { Bindings, CONTEXTS, type Context, DEFAULTS, keyText, parseKeys, RESERVED, SUPER, tableOf } from "./tui/bindings.js";

export { KEYBINDINGS };

export type KeysLoaded = { table: Bindings; problems: string[] } | { problem: string };

// What Claude Code's keybindings page (https://code.claude.com/docs/en/keybindings.md, read 2026-10-28) lists that
// Tachikoma has no use for: its contexts Tachikoma lacks, and its actions Tachikoma lacks, in every context. A file
// made for Claude Code names them, so they are counted in one line, not one line each (release 6 design, "The keys
// file").
const CLAUDE_CODE_CONTEXTS = new Set([
  "Settings",
  "Tabs",
  "Help",
  "Task",
  "ThemePicker",
  "Attachments",
  "Footer",
  "MessageSelector",
  "DiffDialog",
  "DiffPanel",
  "ModelPicker",
  "EffortSlider",
  "Plugin",
  "AbovePrompt",
  "AbovePromptInput",
  "AbovePromptSelect",
  "Pane",
  "PaneField",
  "Agents",
]);
const CLAUDE_CODE_ACTIONS = new Set([
  ...["redraw", "toggleReplTab", "cycleDiffBase", "diffFileListUp", "diffFileListDown", "toggleDiffNoiseFilter", "toggleDiffPreSession"].map((a) => `app:${a}`),
  ...["clearInput", "clearScreen", "killAgents", "fastMode", "thinkingToggle", "queueSubmit", "sendNow"].map((a) => `chat:${a}`),
  ...["previous", "next", "nextField", "previousField", "toggle", "cycleMode"].map((a) => `confirm:${a}`),
  "permission:toggleDebug",
  "transcript:toggleShowAll",
  "historySearch:cycleScope",
  "task:background",
  "theme:toggleSyntaxHighlighting",
  "help:dismiss",
  "tabs:next",
  "tabs:previous",
  ...["next", "previous", "remove", "exit"].map((a) => `attachments:${a}`),
  ...["next", "previous", "up", "down", "openSelected", "clearSelection", "close", "dismiss"].map((a) => `footer:${a}`),
  ...["dismiss", "previousSource", "nextSource", "previousFile", "nextFile", "back"].map((a) => `diff:${a}`),
  ...["decreaseEffort", "increaseEffort", "thisSessionOnly"].map((a) => `modelPicker:${a}`),
  ...["decreaseEffort", "increaseEffort", "toggleUltracode", "thisSessionOnly"].map((a) => `effortSlider:${a}`),
  ...["pageUp", "pageDown", "first", "last"].map((a) => `select:${a}`),
  ...["toggle", "install", "favorite"].map((a) => `plugin:${a}`),
  ...["search", "retry", "fixUsage"].map((a) => `settings:${a}`),
  ...["switchView", "togglePin", "find", "rename", "previousGroup", "nextGroup"].map((a) => `agents:${a}`),
  "voice:pushToTalk",
  ...["halfPageUp", "halfPageDown", "fullPageUp", "fullPageDown"].map((a) => `scroll:${a}`),
  ...["copy", "clear", "extendLeft", "extendRight", "extendUp", "extendDown", "extendLineStart", "extendLineEnd"].map((a) => `selection:${a}`),
  ...["toggle", "focus", "next", "previous", "press", "leave", "highlightNext", "highlightPrevious"].map((a) => `abovePrompt:${a}`),
  ...["scrollUp", "scrollDown", "pageUp", "pageDown", "top", "bottom", "grow", "shrink", "close", "next", "previous"].map((a) => `pane:${a}`),
  // Names from before Claude Code v2.1.283 that its page says keep working.
  ...["up", "down", "top", "bottom", "select"].map((a) => `messageSelector:${a}`),
  "diff:viewDetails",
]);
// The slash commands that take nothing after them, which `command:<name>` runs (release 6 plan, Task 11).
export const COMMANDS = ["exit", "errors", "model", "screen", "tasks", "vim", "settings", "keybindings"];
// Tachikoma's actions: every one the default table binds somewhere (bindings.ts, DEFAULTS). An action bound in a
// context where the screen does not use it does nothing there, as Claude Code checks only that an action exists
// (choice 21).
const ACTIONS = new Set(CONTEXTS.flatMap((c) => Object.values(DEFAULTS[c])));

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const reserved = (s: { key: string; ctrl: boolean; alt: boolean; shift: boolean }) => RESERVED.some((r) => keyText([r]) === keyText([s]));
// A key held with Claude Code's Command or Super key, by any of its names (bindings.ts, SUPER).
const withSuper = (keys: string) => keys.split(/\s+/).some((part) => part.split("+").slice(0, -1).some((m) => SUPER.has(m.toLowerCase())));

// Lays the file over DEFAULTS, in Claude Code's shape: {"bindings": [{"context", "bindings": {keys: action | null}}]},
// with $schema and $docs allowed (release 6 design, "The keys file"). Each problem in an entry is one line and the rest
// applies; what only Claude Code has is counted in one line; the words are choice 21's. A file that is not JSON, or not
// that shape, is a problem for the whole file, which the caller keeps the keys before it for.
export function readKeybindings(text: string): KeysLoaded {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // as the settings file (settings.ts, entriesOf)
  let data: unknown = {};
  try {
    if (!emptyText(text)) data = JSON.parse(text);
  } catch (err) {
    return { problem: `${KEYBINDINGS} is not valid JSON: ${errorText(err)}` };
  }
  if (!isObject(data) || (data.bindings !== undefined && !Array.isArray(data.bindings))) {
    return { problem: `${KEYBINDINGS} must be one object with a "bindings" list, such as {"bindings": []} (got ${JSON.stringify(data)})` };
  }
  const problems: string[] = [];
  // The file's own entries beside "bindings", which Claude Code's shape allows only $schema and $docs (choice 21).
  for (const name of Object.keys(data)) {
    if (!["bindings", "$schema", "$docs"].includes(name)) problems.push(`${KEYBINDINGS}: ${JSON.stringify(name)} is not an entry; it was left out`);
  }
  const table = tableOf(DEFAULTS);
  const bound = Object.fromEntries(CONTEXTS.map((c) => [c, new Set<string>()])) as Record<Context, Set<string>>; // the file's own keys
  const skipped = { count: 0, names: new Set<string>() };
  const skip = (name: string, count = 1) => {
    skipped.count += count;
    skipped.names.add(name);
  };
  for (const [i, block] of ((data.bindings ?? []) as unknown[]).entries()) {
    if (!isObject(block) || typeof block.context !== "string" || !isObject(block.bindings)) {
      problems.push(`${KEYBINDINGS}: block ${i + 1} needs a "context" and a "bindings" object; it was left out`);
      continue;
    }
    const { context } = block;
    const entries = Object.entries(block.bindings);
    if (CLAUDE_CODE_CONTEXTS.has(context)) {
      skip(context, entries.length);
      continue;
    }
    if (!(CONTEXTS as readonly string[]).includes(context)) {
      problems.push(`${KEYBINDINGS}: ${JSON.stringify(context)} is not a context; its block was left out`);
      continue;
    }
    const keysOf = bound[context as Context];
    for (const [keys, action] of entries) {
      const where = `${KEYBINDINGS}: ${context} ${JSON.stringify(keys)}`;
      if (withSuper(keys)) {
        skip("cmd+ keys");
        continue;
      }
      const strokes = parseKeys(keys);
      if (!Array.isArray(strokes)) problems.push(`${where}: ${strokes.problem}; it was left out`);
      else if (strokes.some(reserved)) problems.push(`${where} is a reserved key; it was left out`);
      else if (action !== null && typeof action !== "string") {
        problems.push(`${where} must be an action's name in quotes, or null (got ${JSON.stringify(action)}); it was left out`);
      } else if (action !== null && CLAUDE_CODE_ACTIONS.has(action)) skip(action);
      else if (action?.startsWith("command:") && !COMMANDS.includes(action.slice("command:".length))) {
        problems.push(`${where}: ${JSON.stringify(action)} is not a command a key can run (${COMMANDS.join(", ")}); it was left out`);
      } else if (action !== null && !action.startsWith("command:") && !ACTIONS.has(action)) {
        problems.push(`${where}: ${JSON.stringify(action)} is not an action; it was left out`);
      } else if (keysOf.has(keyText(strokes))) problems.push(`${where} is bound twice in ${context}; the first stays`);
      else {
        keysOf.add(keyText(strokes));
        table[context as Context].set(keyText(strokes), action);
      }
    }
  }
  if (skipped.count) {
    const entries = `${skipped.count} ${skipped.count === 1 ? "entry" : "entries"}`;
    problems.push(`${KEYBINDINGS}: ${entries} skipped: Tachikoma has no ${[...skipped.names].join(", ")}`);
  }
  return { table: new Bindings(table), problems };
}
