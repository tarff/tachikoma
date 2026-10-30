import { statSync } from "node:fs";
import type { Key } from "ink";
import type { Owner } from "../../core/permissions.js";
import { SETTINGS } from "../../settings.js";
import type { Context, Stroke } from "../bindings.js";
import { imageReader, readImage } from "../clipboard.js";
import type { Line } from "../describe.js";
import { after, type Editor, lineEnd, lineStart, segmenter } from "../editor.js";
import type { Command, Scroll } from "../keys.js";
import type { Handover } from "../owner.js";
import type { Phase } from "../phase.js";
import type { Pos } from "../view.js";
import type { Vim } from "../vim.js";

// A question waiting in the line, and who asked it: a subagent, or with no owner the lead's turn. In full screen, `detail`:
// the first and last of the conversation's lines its detail went to, the heading's line first; `following`: whether the
// view was following when it was first drawn, undefined until then (release 5 plan, Task 11). `label`: who asks, a
// subagent by its id alone, and the action's first word ("t2 to run"); `short`, for a question too long to fit, what its
// line names in place of its text (the user's choices, release 5).
export type Question = {
  text: string;
  label: string;
  short?: string;
  owner?: Owner;
  detail?: [number, number];
  following?: boolean;
  plain?: boolean; // a question of its own, asked without "Allow" (permissions.ts, Ask)
  answer: (ok: boolean, how: string) => void;
};
// While the left button is held after a press in the conversation: what the press took (the pressed character, or a
// double or triple click's word or line); `copy`: a drag, or a double or triple click, made a selection to copy on release;
// `top`: the press was on the conversation's top row.
export type Held = { press: [Pos, Pos]; copy: boolean; top: boolean };
export type Printed = { handover?: Handover; resume?: () => Promise<void>; paste?: string };

// The system's clipboard reader as a read, or null where there is none (release 6 plan, choice 11).
export const fromClipboard = () => {
  const tool = imageReader(process.platform, process.env);
  return tool && (() => readImage(tool));
};
// Whether a pasted path names a file, not a folder; one that cannot be looked at, as a name Windows does not allow, is
// not one. Synchronous, as the paste must be pictures or text before the next key is applied.
export const isFile = (file: string) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

export const COMMANDS =
  "/lead <provider:model>, /model, /login chatgpt, /logout chatgpt, /tasks, /errors, /screen, /settings, " +
  "/keybindings, /vim, /exit";
// "t3's answer", "t2 and t3's answers", "t2, t3 and t4's answers".
export const names = (ids: string[]) => `${ids.length > 1 ? `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}` : ids[0]}'s answer${ids.length > 1 ? "s" : ""}`;
export const DOUBLE_PRESS_MS = 800; // Claude Code's window for pressing Ctrl+D twice (interactive-mode.md)
export const gray = (text: string): Line => ({ text, color: "gray" });
// Characters as a person sees them, as the prompt counts them (release 5 plan, choice 7).
export const characters = (text: string) => [...segmenter.segment(text)].length;

// What submit takes as a command: a command's name first, or a slash and a bare word ("/tmp is full"
// is a message).
export const NAMES = [
  "/exit", "/errors", "/lead", "/model", "/login", "/logout", "/tasks", "/screen", "/settings", "/keybindings", "/vim",
];
export const isCommand = (text: string) => NAMES.includes(text.split(/\s+/)[0]!.toLowerCase()) || /^\/[a-z]+$/i.test(text);

// The settings file's entries a live edit applies here, in the design's table's order ("When a live change applies").
// vimInsertModeRemaps is read at each key (vimTakes), and the editor at each Ctrl+G, /settings and /keybindings; both
// are here for their lines (plan, Tasks 12 and 21).
export const LIVE = [
  "lead", "mode", "effort", "fallback", "worker", "maxTasks",
  "status", "screen", "scrollSpeed", "editorMode", "vimInsertModeRemaps", "editor",
] as const;
export const FROM = ` (from ${SETTINGS})`;

// The contexts in force in each phase (phase.ts), innermost first (release 6 plan, Task 6's table). Printed out and
// ended, keys go where they went before the table: to the reader of the printed view, or nowhere.
export const PHASE_CONTEXTS: Record<Phase["kind"], Context[]> = {
  prompt: ["Chat", "Global"],
  menu: ["Autocomplete", "Chat", "Global"],
  question: ["Confirmation", "Global"],
  search: ["HistorySearch", "Global"],
  detail: ["Transcript", "Global"],
  picker: ["Select", "Global"],
  printed: [],
  ended: [],
};
// In full screen Scroll comes after the phase's own context, so that context's bindings win (the detail view's Home and
// End stay transcript:top and transcript:bottom); in the model list only for the wheel, which scrolls the conversation
// there while keys do not (release 5 plan, choice 3). In classic mode Scroll is never in force.
export const contextsOf = (kind: Phase["kind"], full: boolean, wheel = false): Context[] => {
  const c = PHASE_CONTEXTS[kind];
  return full && c.length && (kind !== "picker" || wheel) ? [...c.slice(0, -1), "Scroll", "Global"] : c;
};
// The actions the prompt runs as commands (keys.ts); Global's toggles and Scroll's actions run so everywhere.
export const ACTIONS: Record<string, Command> = {
  "chat:submit": "submit",
  "chat:newline": "newline",
  "chat:cycleMode": "mode",
  "chat:modelPicker": "models",
  "chat:undo": "undo",
  "history:search": "search",
  "history:previous": "up",
  "history:next": "down",
  "autocomplete:previous": "up",
  "autocomplete:next": "down",
  "app:toggleTodos": "todos",
  "app:toggleTranscript": "lastTurn",
  "scroll:pageUp": "pageUp",
  "scroll:pageDown": "pageDown",
  "scroll:top": "top",
  "scroll:bottom": "bottom",
  "scroll:lineUp": "lineUp",
  "scroll:lineDown": "lineDown",
};
// The detail view's own moves (release 5 design, "The detail view"), beside Scroll's.
export const MOVES: Record<string, Scroll> = {
  "transcript:lineDown": "lineDown",
  "transcript:lineUp": "lineUp",
  "transcript:top": "top",
  "transcript:bottom": "bottom",
};
// What a key does, found in the table (route, keyRouting.ts): an action, a chord's first strokes waiting, or a key
// typed into a field; null for a key no binding takes.
export type Got = { action: string } | { pending: Stroke[] } | { typed: string } | null;
// A key taken that does nothing: one only a live edit binds to chat:cycleMode (keyRouting.ts, lookUp; release 6 plan,
// choice 32). No phase knows this action, so none acts on it, nor gives the key to the prompt's editor or a field, as
// it would a key no binding takes (null).
export const NOTHING: Got = { action: "held" };
// A key typed into a field: printable, without Ctrl or Alt (release 6 plan, Task 6, Claude Code's "Text fields" rule).
export const printable = (s: Stroke) => !s.ctrl && !s.alt && (s.key === "space" || [...s.key].length === 1);
// The line while the editor runs, and the codes that erase it (App, away; release 6 plan, choice 33).
export const WAITING = "Waiting for your editor to close the file... (Tachikoma ignores Ctrl-C until then) ";
export const ERASE_LINE = "\r\u001b[K";
// The wheel's reports carry no key, so no flag of one is set.
export const NO_KEY = {} as Key;
// VISUAL's selection, as vim.ts's visual() takes it, to draw (release 6 plan, choice 28): from the anchor to the
// cursor's character, or in VISUAL LINE whole lines with the line break after the last, so an empty line in it shows.
// It is widened to the whole of any picture's marker it reaches into, as a delete or yank there takes all of it
// (vim.ts, cover). None outside VISUAL, so leaving it by any key clears the drawing.
export function visualSelection(v: Vim | null, e: Editor): [number, number] | undefined {
  if (v?.anchor === undefined || !v.mode.startsWith("VISUAL")) return undefined;
  const [lo, hi] = [Math.min(v.anchor, e.cursor), Math.max(v.anchor, e.cursor)];
  const line = v.mode === "VISUAL LINE";
  let [from, to] = line ? [lineStart(e.text, lo), lineEnd(e.text, hi) + 1] : [lo, after(e.text, hi)];
  for (const s of e.spans) if (s.from < to && s.to > from) [from, to] = [Math.min(from, s.from), Math.max(to, s.to)];
  return [from, to];
}
