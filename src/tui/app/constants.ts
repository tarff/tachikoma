import { statSync } from "node:fs";
import type { Key } from "ink";
import type { Owner } from "../../core/permissions.js";
import type { Task } from "../../core/tasks.js";
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
  warnings: string[]; // the red lines drawn above it, one per danger, escaped (permissions.ts, Ask; release 7 plan, Task 8)
  note?: string; // a grey row, auto mode's pause, drawn above any red lines, which the gate never sends with it (permissions.ts, Ask; Task 10)
  oneRow?: true; // the note is cut to one screen row in every view, an MCP call's (permissions.ts, Ask; release 8c plan, choice 47)
  call?: string; // the lead's call that asks it, from its tool-start, so its answer can go under its tool line (choice 66)
  answer: (ok: boolean, how: string) => void;
};
// While the left button is held after a press in the conversation: what the press took (the pressed character, or a
// double or triple click's word or line); `copy`: a drag, or a double or triple click, made a selection to copy on release;
// `top`: the press was on the conversation's top row.
// `fold`: the line of a folded tool row a plain click pressed, which its release opens or closes (release 8c plan, Task 15).
export type Held = { press: [Pos, Pos]; copy: boolean; top: boolean; fold?: number };
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
  "/lead <provider:model>, /model, /login chatgpt, /logout chatgpt, /clear, /resume, /branch [name], /rename <name>, " +
  "/export [file], /compact [words], /autocompact <tokens>, /tasks, /hooks, /mcp, /errors, /screen, /settings, /keybindings, /vim, /exit";
// Release 8a plan, Task 7's words, approved by the user on 2026-11-06: the `/` menu's notes; /resume with no other
// session saved; /branch before any prompt, or once saving has stopped (session.ts, "Saving fails"), and /rename then, as
// nothing they wrote would be saved; and the in-window list's hint, whose Esc closes the list where `tachi -r`'s quits.
export const SESSION_WORDS = {
  clear: "Start a new session in this window; the last one stays saved",
  resume: "Pick a saved session and switch this window to it",
  branch: "Carry on in a copy of this session, named after its first prompt unless named",
  rename: "Name this session, as /resume and tachi --resume list it",
  noOther: "No other saved sessions in this folder.",
  nothingToBranch: "Nothing to branch yet: this session has no prompt.",
  unsaved: (command: string) => `${command} needs this session saved, and saving it stopped.`,
  closes: "closes",
};
// Release 8a plan, Task 8's words, approved by the user on 2026-11-06: the `/` menu's note, and a file that cannot be
// written for another reason than being there already.
export const EXPORT_WORDS = {
  note: "Write the conversation to a file as text; alone, copy it",
  unwritten: (file: string, why: string) => `${file} could not be written (${why}).`,
};
// Release 8a plan, Task 13's words, approved by the user on 2026-11-06: the `/` menu's notes, the lines of /compact and
// /autocompact ("Lines this plan adds"), and `summary`, the heading over Ctrl+O's summary.
export const SHORTEN_WORDS = {
  compact: "Shorten the conversation into a summary now; words after it say what to focus on",
  autocompact: "Shorten once the conversation passes a number of tokens, such as 200k; off, only when it would not fit",
  nothing: "Nothing to shorten yet.",
  shortened: "Conversation shortened (Ctrl+O shows the summary)",
  summary: "The summary the conversation was shortened to:",
  passes: (n: number) => `Shortens once the conversation passes ${tokens(n)} tokens.`,
  off: "Shortens only when a request would not fit.",
  usage: "Usage: /autocompact <tokens>, such as 200k, or /autocompact off",
};
// A number of tokens as the session's too-long line writes it, as providers/pictures.ts writes a number (session.ts).
export const tokens = (n: number) => n.toLocaleString("en-US");
// Ids as the lines list them: "t1", "t1 and t2", "t1, t2 and t3" (names, and /tasks stop's line, choice 40).
export const listed = (ids: string[]) => (ids.length > 1 ? `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}` : ids[0]);
// What a wake reads (background commands plan, choice 19), subagents first: "t3's answer", "t2, t3 and t4's answers",
// "t4's output", "t3's answer and t4's output".
export const names = (waiting: { id: string; kind: Task["kind"] }[]) => {
  const subagents = waiting.filter((w) => w.kind === "subagent").map((w) => w.id);
  const commands = waiting.filter((w) => w.kind === "command").map((w) => w.id);
  return [
    ...(subagents.length ? [`${listed(subagents)}'s answer${subagents.length > 1 ? "s" : ""}`] : []),
    ...(commands.length ? [`${listed(commands)}'s output`] : []),
  ].join(" and ");
};
export const DOUBLE_PRESS_MS = 800; // Claude Code's window for pressing Ctrl+D twice (interactive-mode.md)
export const gray = (text: string): Line => ({ text, color: "gray" });
// Characters as a person sees them, as the prompt counts them (release 5 plan, choice 7), counted without an array of
// them, as /export's copy is the whole conversation (release 8a plan, Task 8).
export const characters = (text: string) => {
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
};

// What submit takes as a command: a command's name first, or a slash and a bare word ("/tmp is full"
// is a message), or the shape of an MCP server's prompt, `/<name>:<prompt>`, first, which goes in a turn of its own, not
// joined to the prompts queued beside it, as its words fill the prompt's arguments (release 8c plan, Task 13).
export const NAMES = [
  "/exit", "/errors", "/lead", "/model", "/login", "/logout", "/tasks", "/hooks", "/mcp", "/screen", "/settings", "/keybindings", "/vim",
  "/clear", "/resume", "/branch", "/rename", "/export", "/compact", "/autocompact",
];
export const isCommand = (text: string) =>
  NAMES.includes(text.split(/\s+/)[0]!.toLowerCase()) || /^\/[a-z]+$/i.test(text) || /^\/[^\s/:]+:\S/.test(text);

// The settings file's entries a live edit applies here, in the design's table's order ("When a live change applies").
// vimInsertModeRemaps is read at each key (vimTakes), and the editor at each Ctrl+G, /settings and /keybindings; both
// are here for their lines (plan, Tasks 12 and 21). dangerousCommands is release 7's (release 7 plan, Task 4), and so are
// sandbox, network and judge, here for their lines too, as each waits for the next launch (Task 7). autoCompactWindow is
// release 8a's (release 8a plan, choice 26). hooks and disableAllHooks are release 8b's (release 8b design, "What the
// user sees"; its plan's Task 12 applies them). mcpServers is release 8c's (release 8c design, "The settings entry"; its
// plan's Task 10 applies it).
export const LIVE = [
  "lead", "mode", "sandbox", "network", "judge", "effort", "fallback", "worker", "maxTasks",
  "status", "screen", "scrollSpeed", "editorMode", "vimInsertModeRemaps", "editor", "dangerousCommands", "autoCompactWindow",
  "hooks", "disableAllHooks", "mcpServers",
] as const;
export const FROM = ` (from ${SETTINGS})`;

// The contexts in force in each phase (phase.ts), innermost first (release 6 plan, Task 6's table). Printed out and
// ended, keys go where they went before the table: to the reader of the printed view, or nowhere. In the review the
// review reads its own keys, in these contexts at its list (Review.tsx; release 7 plan, Task 21), and the App none.
export const PHASE_CONTEXTS: Record<Phase["kind"], Context[]> = {
  prompt: ["Chat", "Global"],
  menu: ["Autocomplete", "Chat", "Global"],
  question: ["Confirmation", "Global"],
  search: ["HistorySearch", "Global"],
  detail: ["Transcript", "Global"],
  picker: ["Select", "Global"],
  review: ["Review", "Global"],
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
// The line while the editor runs, and the codes that erase it (handover.tsx, away; release 6 plan, choice 33).
export const WAITING = "Waiting for your editor to close the file... (Tachikoma ignores Ctrl-C until then) ";
export const ERASE_LINE = "\r\u001b[K";
// Copy mode's leaving (queue.ts, leave): the line while the box stops, and the one when Docker still lists it after.
export const STOPPING = "Stopping the box...";
export const NOT_GONE = "The box could not be removed, so the copy was not reviewed.";
// When git's settings cannot be read on the host as the review would open (the user's words; Task 21's review).
export const reviewUnopened = (why: string) =>
  `The review did not open: git's settings could not be read (${why}), so the hooks folders they name could not be protected.`;
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
