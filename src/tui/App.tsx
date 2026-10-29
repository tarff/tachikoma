import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Box, type Key, renderToString, Static, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
import { useEffect, useRef, useState } from "react";
import { type Given, resolve } from "../clilib.js";
import type { Bus, ErrorEvent, Events } from "../core/bus.js";
import { summarize } from "../core/errorlog.js";
import { type Ask, type Mode, type Owner, visible } from "../core/permissions.js";
import type { Session } from "../core/session.js";
import type { Stats } from "../core/stats.js";
import type { Task, Tasks } from "../core/tasks.js";
import { errorText, type Message, type Provider } from "../core/types.js";
import { KEYBINDINGS, type KeysLoaded } from "../keybindings.js";
import type { Effort } from "../providers/anthropic.js";
import type { ModelGroup } from "../providers/models.js";
import { type Loaded, SETTINGS, type Settings, settingsDir, shownFile } from "../settings.js";
import { watchSettings } from "../settingsWatch.js";
import type { TodoItem } from "../tools/todo.js";
import { Bindings, CHORD_MS, type Context, DEFAULTS, keyText, type Stroke, strokeOf, tableOf } from "./bindings.js";
import { type Clipboard, imagePaths, imageReader, pictureFile, readImage } from "./clipboard.js";
import { Conversation } from "./Conversation.js";
import { brief, callLines, describe, lastTurn, type Line, screen as escaped } from "./describe.js";
import { type Detail, DetailView, keyRow, opened, searchFor, step as stepMatch } from "./DetailView.js";
import {
  after, apply, change, cutPicture, type Editor, empty, insertPicture, lineEnd, lineStart, load, move, replace,
  segmenter,
} from "./editor.js";
import { editFile, editorCommand, editText, NOT_FOUND } from "./external.js";
import { History, matches } from "./history.js";
import { type Mouse, readOut } from "./input.js";
import { both, type Command, commands, isScroll, keyList, named, pieces, type Scroll, vimKey } from "./keys.js";
import { frame as frameOf, layout, placeOn, scroll as windowOf, vertical } from "./layout.js";
import { Menu } from "./Menu.js";
import { commandMenu, type Listing, listFolder, type Menu as MenuData, pathMenu } from "./menus.js";
import { ModelPicker, type PickerKey, rows as listRows } from "./ModelPicker.js";
import { type Hand, type Handover, TerminalOwner } from "./owner.js";
import { type Now, now as nowOf, pasteTo, type Phase, phaseInputs } from "./phase.js";
import { type Draft, joined, marker, messageParts, Pictures, type Read, spansIn, trimmed, without } from "./pictures.js";
import { Prompt, promptWidth } from "./Prompt.js";
import { clicks, placeAt, span, textOf, wordAt } from "./select.js";
import { type Segment, StatusLine } from "./StatusLine.js";
import { TaskPanel, taskRow, taskRows } from "./TaskPanel.js";
import { PASTE_OFF, PASTE_ON, type Screen } from "./terminal.js";
import { TodoList, todoRows, unfinished } from "./TodoList.js";
import { type Call, ToolLine } from "./ToolLine.js";
import { arrived, bar, barFirst, first as firstRow, FOLLOWING, notch, type Pos, Rows, scrollBy, scrollTo, unseenBelow, type View } from "./view.js";
import { type Vim, press as vimPress, start as vimStart } from "./vim.js";
import { SPIN_MS, WorkingLine } from "./WorkingLine.js";

// A question waiting in the line, and who asked it: a subagent, or with no owner the lead's turn. In full screen, `detail`:
// the first and last of the conversation's lines its detail went to, the heading's line first; `following`: whether the
// view was following when it was first drawn, undefined until then (release 5 plan, Task 11). `label`: who asks, a
// subagent by its id alone, and the action's first word ("t2 to run"); `short`, for a question too long to fit, what its
// line names in place of its text (the user's choices, release 5).
type Question = {
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
type Held = { press: [Pos, Pos]; copy: boolean; top: boolean };
type Printed = { handover?: Handover; resume?: () => Promise<void>; paste?: string };

export interface AppProps {
  session: Session;
  tasks: Tasks; // the lead's subagents
  bus: Bus;
  stats: Stats;
  mode: Mode; // the mode the session started in
  onMode: (mode: Mode) => void; // Shift+Tab: the mode the permission check uses from the next action
  project: string; // the project folder's name, for the status line
  root: string; // the project folder, where `@` paths start
  gitBranch: () => string | null; // read at the start and after each turn: the model may switch branches
  historyFile: string; // this project's past prompts
  intro: Line[]; // shown first: the instruction files read
  errorFile: string;
  segments: Segment[];
  makeProvider: (spec: string) => Provider;
  bindAsk: (ask: Ask) => void;
  // `/login …` and `/logout …`: the words after the command, where to show what it says, a signal
  // Ctrl-C aborts, and how a command is typed here ("/").
  login: (verb: "login" | "logout", words: string[], say: (line: string) => void, signal: AbortSignal, prefix: string) => Promise<void>;
  // `/model`: every provider's models, and where to show what reading the saved login says.
  listModels: (signal: AbortSignal, warn: (line: string) => void) => Promise<ModelGroup[]>;
  screen: Screen; // full screen or classic, as the terminal is when the App starts (release 5 design, "The two modes")
  // Whether full screen can draw here, for /screen: not where the output is not a terminal, or in CI (clilib.ts,
  // fullPossible).
  fullPossible: boolean;
  // The terminal's mouse reports, taken out of the keys by the InputFilter (release 5 design, "The mouse"), and the rows a
  // wheel notch scrolls (clilib.ts, scrollSpeed).
  mouse?: { on(e: "mouse", f: (m: Mouse) => void): unknown; off(e: "mouse", f: (m: Mouse) => void): unknown };
  scrollSpeed: number;
  // Copying (release 5 design, "Copying"): the App makes the clipboard with its own report, so a failure shows in the
  // hint row.
  clipboard: (report: (problem: string) => void) => Clipboard;
  // The InputFilter's hold on raw mode and its diverting of the keys, for `[` (release 5 design, "The detail view"); /screen
  // holds raw mode too. With none, `[` does nothing. Letting go of stdin and taking it back are for a program in the
  // terminal (owner.ts, program).
  input?: Pick<Hand, "divert" | "hold" | "release" | "retake">;
  // The table of keys (bindings.ts); the default table when not given. With `live`, the keys file replaces it
  // (release 6 plan, Task 11).
  bindings?: Bindings;
  home: string; // the user's folder, which holds the settings file (release 6 design, "The settings file")
  // The settings file as the launch read it, and the entries a flag or variable gave then (clilib.ts, givenBy): with
  // it the App watches the file and applies each edit (release 6 design, "Live edits"); without it, as in most tests,
  // it does not.
  live?: { loaded: { settings: Settings; warnings: string[] }; given: Given };
  // The session's pictures (pictures.ts; release 6 plan, choice 9); the App makes its own when not given. Tests give
  // one to end its reads.
  pictures?: Pictures;
  // chat:imagePaste's read of the clipboard's picture, null where there is no reader; the system's reader when not
  // given (clipboard.ts, imageReader). Tests give a stand-in, so none reads the user's clipboard.
  readPicture?: (() => Promise<Read>) | null;
}

// The system's clipboard reader as a read, or null where there is none (release 6 plan, choice 11).
const fromClipboard = () => {
  const tool = imageReader(process.platform, process.env);
  return tool && (() => readImage(tool));
};
// Whether a pasted path names a file, not a folder; one that cannot be looked at, as a name Windows does not allow, is
// not one. Synchronous, as the paste must be pictures or text before the next key is applied.
const isFile = (file: string) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

const COMMANDS =
  "/lead <provider:model>, /model, /login chatgpt, /logout chatgpt, /tasks, /errors, /screen, /settings, " +
  "/keybindings, /vim, /exit";
// "t3's answer", "t2 and t3's answers", "t2, t3 and t4's answers".
const names = (ids: string[]) => `${ids.length > 1 ? `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}` : ids[0]}'s answer${ids.length > 1 ? "s" : ""}`;
const DOUBLE_PRESS_MS = 800; // Claude Code's window for pressing Ctrl+D twice (interactive-mode.md)
const gray = (text: string): Line => ({ text, color: "gray" });
// Characters as a person sees them, as the prompt counts them (release 5 plan, choice 7).
const characters = (text: string) => [...segmenter.segment(text)].length;

// What submit takes as a command: a command's name first, or a slash and a bare word ("/tmp is full"
// is a message).
const NAMES = [
  "/exit", "/errors", "/lead", "/model", "/login", "/logout", "/tasks", "/screen", "/settings", "/keybindings", "/vim",
];
const isCommand = (text: string) => NAMES.includes(text.split(/\s+/)[0]!.toLowerCase()) || /^\/[a-z]+$/i.test(text);

// The settings file's entries a live edit applies here, in the design's table's order ("When a live change applies").
// vimInsertModeRemaps is read at each key (vimTakes), and the editor at each Ctrl+G, /settings and /keybindings; both
// are here for their lines (plan, Tasks 12 and 21).
const LIVE = [
  "lead", "mode", "effort", "fallback", "worker", "maxTasks",
  "status", "screen", "scrollSpeed", "editorMode", "vimInsertModeRemaps", "editor",
] as const;
const FROM = ` (from ${SETTINGS})`;

// The contexts in force in each phase (phase.ts), innermost first (release 6 plan, Task 6's table). Printed out and
// ended, keys go where they went before the table: to the reader of the printed view, or nowhere.
const PHASE_CONTEXTS: Record<Phase["kind"], Context[]> = {
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
const contextsOf = (kind: Phase["kind"], full: boolean, wheel = false): Context[] => {
  const c = PHASE_CONTEXTS[kind];
  return full && c.length && (kind !== "picker" || wheel) ? [...c.slice(0, -1), "Scroll", "Global"] : c;
};
// The actions the prompt runs as commands (keys.ts); Global's toggles and Scroll's actions run so everywhere.
const ACTIONS: Record<string, Command> = {
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
const MOVES: Record<string, Scroll> = {
  "transcript:lineDown": "lineDown",
  "transcript:lineUp": "lineUp",
  "transcript:top": "top",
  "transcript:bottom": "bottom",
};
// What a key does, found in the table (route, below): an action, a chord's first strokes waiting, or a key typed into a
// field; null for a key no binding takes.
type Got = { action: string } | { pending: Stroke[] } | { typed: string } | null;
// A key taken that does nothing: one only a live edit binds to chat:cycleMode (App, lookUp; release 6 plan, choice 32).
// No phase knows this action, so none acts on it, nor gives the key to the prompt's editor or a field, as it would a
// key no binding takes (null).
const NOTHING: Got = { action: "held" };
// A key typed into a field: printable, without Ctrl or Alt (release 6 plan, Task 6, Claude Code's "Text fields" rule).
const printable = (s: Stroke) => !s.ctrl && !s.alt && (s.key === "space" || [...s.key].length === 1);
// The line while the editor runs, and the codes that erase it (App, away; release 6 plan, choice 33).
const WAITING = "Waiting for your editor to close the file... (Tachikoma ignores Ctrl-C until then) ";
const ERASE_LINE = "\r\u001b[K";
// The wheel's reports carry no key, so no flag of one is set.
const NO_KEY = {} as Key;
// VISUAL's selection, as vim.ts's visual() takes it, to draw (release 6 plan, choice 28): from the anchor to the
// cursor's character, or in VISUAL LINE whole lines with the line break after the last, so an empty line in it shows.
// It is widened to the whole of any picture's marker it reaches into, as a delete or yank there takes all of it
// (vim.ts, cover). None outside VISUAL, so leaving it by any key clears the drawing.
function visualSelection(v: Vim | null, e: Editor): [number, number] | undefined {
  if (v?.anchor === undefined || !v.mode.startsWith("VISUAL")) return undefined;
  const [lo, hi] = [Math.min(v.anchor, e.cursor), Math.max(v.anchor, e.cursor)];
  const line = v.mode === "VISUAL LINE";
  let [from, to] = line ? [lineStart(e.text, lo), lineEnd(e.text, hi) + 1] : [lo, after(e.text, hi)];
  for (const s of e.spans) if (s.from < to && s.to > from) [from, to] = [Math.min(from, s.from), Math.max(to, s.to)];
  return [from, to];
}

export function App({
  session,
  tasks,
  bus,
  stats,
  mode,
  onMode,
  project,
  root,
  gitBranch,
  historyFile,
  intro,
  errorFile,
  segments,
  makeProvider,
  bindAsk,
  login,
  listModels,
  screen,
  fullPossible,
  mouse,
  scrollSpeed,
  clipboard,
  input,
  bindings,
  home,
  live,
  pictures: picturesGiven,
  readPicture,
}: AppProps) {
  const { exit, suspendTerminal } = useApp();
  const [lines, setLines] = useState<(Line & { id: number })[]>([]);
  // Each key reads and changes these at once, as in ModelPicker: several keys can arrive before the
  // screen is drawn again. `goal` is the column Up and Down keep to, until another key moves the cursor.
  const editor = useRef(empty);
  const goal = useRef<number | null>(null);
  // Vim mode's state (vim.ts), or null with vim mode off: on from the settings file's editorMode, /vim or a live edit,
  // starting in INSERT (release 6 design, "Vim mode"). Kept while the detail view, a menu or the model list is open.
  const vim = useRef<Vim | null>(live?.loaded.settings.editorMode === "vim" ? vimStart : null);
  const vimText = useRef<string | null>(null); // the prompt's text as vim's last key left it (staleVim)
  const first = useRef<{ name: string; timer: NodeJS.Timeout } | null>(null); // a key waiting for its second press
  // The table of keys (release 6 design, "Keys become named actions"), as the keys file last set it, and the timer that
  // draws the hint row again once a chord's 3 s are up (bindings.ts, CHORD_MS).
  const [table, setTable] = useState(() => bindings ?? new Bindings(tableOf(DEFAULTS)));
  const chordTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  // The keys a hint names for an action (keys.ts, named).
  const keyOf = (action: string, context: Context, usual: string) => named(table, action, context, [usual])[0];
  // The model list's keys (ModelPicker.tsx), set as it draws; called only in the picker phase, while it is drawn.
  const pickerKey = useRef<((k: PickerKey) => void) | null>(null);
  // Where Up has gone in the history, and what was typed before, its pictures' spans kept (release 6 plan, Task 14).
  const step = useRef<{ at: number; draft: Draft } | null>(null);
  // Ctrl+R: what is searched for, how many older matches Ctrl+R has passed, and the prompt to give back.
  const search = useRef<{ query: string; skip: number; before: Editor } | null>(null);
  // Ctrl+S's one slot, for the session (release 6 design, "Stash"): the prompt, and where Up had got to with it, the
  // draft typed before Up included, so a stash during Up's walk loses nothing (choice 31).
  const stash = useRef<{ prompt: Editor; step: { at: number; draft: Draft } | null } | null>(null);
  // The menus: the entry chosen, for the text it was chosen at; the text Esc closed one at, which
  // keeps it closed until the text changes; and the folder `@` listed last.
  const chosen = useRef({ text: "", at: 0 });
  const closed = useRef<string | null>(null);
  const listed = useRef<{ folder: string; listing: Listing } | null>(null);
  const { columns, rows: height } = useWindowSize();
  // Full screen (release 5 design, "The screen"): every line is kept, wrapped one column short, leaving the last column
  // for the scroll bar (release 5 plan, choice 1), and the view is where the user put it. Keys read and change the view
  // at once, as above.
  const [full, setFull] = useState(screen.full);
  // While /screen goes to classic, nothing is drawn, so Ink's redraw on resuming draws no full-screen frame on the normal
  // screen (the user's check, release 5 plan, "Before you start").
  const [switching, setSwitching] = useState(false);
  const [kept] = useState(() => new Rows(columns - 1));
  // The lines said in classic mode since `kept` last took them: going to full screen adds them (/screen, below), so `kept`
  // holds every line said, in order, from then on. `lines` cannot give them then: what is said is in it only once React
  // draws again.
  const unkept = useRef<Line[]>([]);
  const view = useRef<View>(FOLLOWING);
  // The detail view, while it is open (DetailView.tsx); it takes the conversation's place. The keys, the wheel, the bar,
  // selecting and copying act on whichever is drawn, the pane, with its own rows and view (release 5 plan, Task 12).
  const detail = useRef<Detail | null>(null);
  const pane = () => detail.current ?? { rows: kept, view };
  // While the detail view is printed out (`[`), from the key on, and once Ink is suspended, how to resume it; `paste`,
  // while a paste comes in, its last characters, which may hold the start of its end marker. Kept apart from the view,
  // which a question closes while it is out.
  const printed = useRef<Printed | null>(null);
  // Once back, a paste that was coming in when a question brought the view back, until its end; and the model list of a
  // /model that ended while printed out, until the view is back (comeBack, below).
  const dropping = useRef<Printed | null>(null);
  const waitingList = useRef<ModelGroup[] | null>(null);
  const ended = useRef(false); // Ink has unmounted the App (the cleanup below)
  // Who has the terminal (owner.ts): how many hand-overs hold the keyboard, and whether Ink is suspended.
  const [owner] = useState(
    () =>
      new TerminalOwner({
        suspend: () => suspendTerminal(),
        hold: (on) => input?.hold(on),
        divert: (to) => input?.divert(to),
        release: () => input?.release(),
        retake: () => input?.retake(),
      }),
  );
  // The mode as it is now, which `say`, `next` and the rest read from here, not from `full`: /screen sets it as the
  // switch starts, `full` following (switchScreen, below), and a drawing's functions can run after a later drawing:
  // History's warning is the first drawing's, and a turn or a command, once it ends, calls the next() of the drawing
  // that started it.
  const fullNow = useRef(full);
  // The live area's rows a click acts on (release 5 design, "Clicking"): the prompt's first row, how many it draws and
  // which of its rows they are (layout.ts, frame), and the menu's under it, no prompt rows while a question, the model
  // list, Ctrl+R's search, whose prompt shows a match, or the detail view takes their place; the prompt as typed and the
  // menu's choice when they were drawn, which keys replace, never change; the detail view drawn, if any; and whether the
  // model list and a question are drawn, which take the keys (phase.ts, PhaseInputs).
  const frame = useRef({
    columns,
    viewHeight: 1,
    promptFirst: 0,
    promptRows: 0,
    promptWindow: { top: 0, above: 0, below: 0 },
    menuRows: 0,
    editor: empty,
    chosen: chosen.current,
    detail: null as Detail | null,
    picker: false,
    question: false,
  });
  const promptTop = useRef(0); // the prompt's and the menu's windows (layout.ts, scroll), as last drawn
  const menuTop = useRef(0);
  const wheel = useRef(0); // the fraction of a row carried from earlier notches (view.ts, notch)
  const grab = useRef<number | null>(null); // while the thumb is dragged, the row of the thumb it was pressed on
  // Selecting (release 5 design, "Selecting"): places in the lines, not screen rows, so a selection stays on its text as
  // the view moves or rewraps. `press` is what the press took: the pressed cell's character (select.ts, span), or the word
  // or line of a double or triple click. `end` is the character under the pointer's cell, as span takes it.
  const selection = useRef<{ press: [Pos, Pos]; end: [Pos, Pos] } | null>(null);
  const held = useRef<Held | null>(null);
  const lastPress = useRef<{ at: number; x: number; y: number; count: number } | null>(null); // for select.ts, clicks
  // The hint row's line about the last copy, until the next key or click, whether it says the copy failed, and whether it
  // has been on screen.
  const copied = useRef<{ text: string; failed: boolean; shown?: boolean } | null>(null);
  // A resize wraps every line again: here, while drawing, so resize events that come together cost one wrapping.
  if (full && kept.width !== columns - 1) kept.setWidth(columns - 1);
  if (detail.current && detail.current.rows.width !== columns - 1) detail.current.rows.setWidth(columns - 1);
  const [busy, setBusy] = useState(false);
  const working = useRef(false); // busy, for keys read before the screen is drawn again
  const queue = useRef<Draft[]>([]); // what Enter added during a turn, in order, pictures' spans kept (release 6 plan, Task 14)
  const [pictures] = useState(() => picturesGiven ?? new Pictures());
  // The message waiting for its pictures' reads to end before it is sent, as the reads leave it (perform, below).
  const reading = useRef<Draft | null>(null);
  const reads = useRef(0); // the pictures' reads running, for the hint row's "Reading picture..." (newPicture, below)
  // What is running, since when, and for a turn the totals it started from; and the turn's tool calls,
  // kept after it until the next turn starts.
  const doing = useRef<{ label: string; at: number; from: { output: number; cost: number; unpriced: number } | null }>({ label: "", at: 0, from: null });
  const calls = useRef<Call[]>([]);
  // The lead's to-do list, and whether Ctrl+T has hidden it; a new list shows again.
  const todos = useRef<{ items: TodoItem[]; hidden: boolean }>({ items: [], hidden: false });
  // Shift+Tab's modes: `never` only for a session started in it, so no key turns off the checks a
  // session started with.
  const perm = useRef(mode);
  const cycle: Mode[] = mode === "never" ? ["ask", "project", "never"] : ["ask", "project"];
  // The lead's and every subagent's questions, shown one at a time, so none replaces the one on screen.
  const questions = useRef<Question[]>([]);
  const question = questions.current[0] ?? null;
  const [contextWindow, setContextWindow] = useState<number | null>(null);
  const [picker, setPicker] = useState<ModelGroup[] | null>(null);
  const listOpen = useRef(false); // the picker, for keys and answers read before the screen is drawn again
  const announced = useRef(new Set<string>()); // background subagents whose ending has been shown
  const [, rerender] = useState(0);
  // A failure of the system's tool comes after the copy, and replaces its line in the hint row (release 5 design,
  // "Copying").
  const board = useRef<Clipboard | null>(null);
  // Made once, while drawing: safe with Ink's non-concurrent root (ink.js, `concurrent` defaults to false), which never
  // throws a render away; a concurrent root could make one clipboard for a render it drops.
  board.current ??= clipboard((problem) => {
    copied.current = { text: `Copied with the terminal only; ${visible(problem)}`, failed: true }; // the tool's own output (clipboard.ts, runTool)
    rerender((n) => n + 1);
  });
  // The next key, paste or click takes away the line about the last copy (release 5 design, "Copying"), but a failure only
  // once it has been on screen: one that came while Ctrl+R's search or the exit warning held the row waits for it, as a
  // failed copy is always reported (the user's choice, release 5).
  const clearCopied = () => {
    const c = copied.current;
    if (c === null || (c.failed && !c.shown)) return;
    copied.current = null;
    rerender((n) => n + 1);
  };
  const started = useRef(Date.now());
  const [now, setNow] = useState(started.current);
  const [branch, setBranch] = useState(gitBranch);
  const abort = useRef<AbortController | null>(null);
  const nextId = useRef(0);
  const printUpTo = useRef<number | null>(null); // while an editor has the terminal in classic mode (away, below)
  const lookups = useRef(0);
  // Live edits of the settings file (release 6 design, "Live edits"): the status line's parts and the wheel's speed
  // as the file last set them; the file's settings and warnings as last applied, to tell which entries an edit
  // changed; a changed effort, which every model made after it takes too; the lead and the screen waiting for the
  // turn to end, as /lead and /screen wait; and whether the lead now set came from the file, for its line (onLead).
  const [shownSegments, setSegments] = useState(segments);
  const [speed, setSpeed] = useState(scrollSpeed);
  const fileNow = useRef(live?.loaded.settings ?? {});
  const warned = useRef(live?.loaded.warnings ?? []);
  const effortNow = useRef<{ effort: Effort | undefined } | null>(null);
  const waiting = useRef<{ lead?: string; screen?: "full" | "classic" }>({});
  const leadFromFile = useRef(false);
  // The keys file's problems as last said, and whether a good file has been read (onKeys).
  const keysWarned = useRef<string[]>([]);
  const keysRead = useRef(false);
  // The keys as the launch's read of the keys file left them, the table given if it read none, and whether that read
  // is done: after it, a permission question reads these keys, whole, whatever a live edit did (onKeys, lookUp;
  // release 6 plan, choice 32). `asked`: whether the last stroke was read at a question, so no chord runs on between
  // the launch's keys and the live ones (lookUp).
  const launchKeys = useRef(table);
  const launched = useRef(false);
  const asked = useRef(false);

  // In full screen the lines go to the view's rows too, and a view held away from the bottom counts them (release 5
  // design, "Scrolling"); setting `lines` draws them either way.
  const say = (...add: Line[]) => {
    const shown = add.map(escaped);
    if (fullNow.current) {
      const before = kept.lines.length;
      kept.add(shown);
      view.current = arrived(view.current, kept.lines.length - before);
    } else unkept.current.push(...shown);
    setLines((l) => [...l, ...shown.map((x) => ({ ...x, id: nextId.current++ }))]);
  };
  // What the user asks to see (the key list, the mode, `/model`) brings the view to the bottom, following, so it is seen;
  // output arriving on its own leaves a held view where it is (the user's choice, release 5). The last turn opens the
  // detail view instead (release 5 plan, Task 12).
  const show = (...add: Line[]) => {
    view.current = FOLLOWING;
    say(...add);
  };
  // A live edit's lines (onSettings, onKeys) show in the hint row too, until the next key (release 6 plan, choice 35,
  // the user's: "Hint row, until a key"): the last edit's lines, said in the conversation as ever, and whether the next
  // line starts a new edit's, which replaces them. One said later for the same edit, a lead or a screen that waited for
  // a turn to end, joins them.
  const notes = useRef<Line[]>([]);
  const newEdit = useRef(true);
  const note = (...add: Line[]) => {
    say(...add);
    notes.current = [...(newEdit.current ? [] : notes.current), ...add.map(escaped)];
    newEdit.current = false;
  };
  const noteAlone = (line: Line) => {
    newEdit.current = true;
    note(line);
  };
  const history = useRef<History | null>(null);
  history.current ??= new History(historyFile, (line) => say({ text: line, color: "magenta" }));
  // Every model made in the session takes a changed effort (release 6 plan, Task 9).
  const make = (spec: string) => {
    const provider = makeProvider(spec);
    if (effortNow.current) provider.setEffort?.(effortNow.current.effort);
    return provider;
  };

  // Only the latest lookup's answer is shown: a late one, for the previous lead or from before a
  // request, must not replace it. Asked again after each request, without clearing what is shown: a
  // ChatGPT plan's window is known only once a request has fetched the account's model list.
  const lookUpWindow = (fresh = true) => {
    const asked = ++lookups.current;
    if (fresh) setContextWindow(null);
    session.lead.contextWindow?.()
      .then((n) => asked === lookups.current && setContextWindow(n))
      .catch(() => {}); // stays unknown
  };

  useEffect(() => {
    bindAsk((text, detail, owner, plain) => {
      // A tool still finishing after Ctrl-C must not ask about a turn the user has stopped, nor a
      // stopped subagent about anything.
      const signal = owner ? owner.signal : abort.current?.signal;
      if (signal?.aborted) return Promise.resolve(false);
      // In the scrollback, not the prompt: a whole file would not fit in the part Ink redraws.
      // Grey, under a heading, so file text cannot pass for the conversation or the interface.
      let range: [number, number] | undefined;
      if (detail !== undefined) {
        const lines = detail ? detail.replace(/\r?\n$/, "").split("\n").length : 0; // as read_file counts them
        const from = kept.lines.length;
        latest.current.say({ text: `┌ ${text} (${lines} line${lines === 1 ? "" : "s"})`, color: "gray" }, { text: detail || "(empty)", color: "gray" });
        if (fullNow.current) range = [from, kept.lines.length - 1];
      }
      return new Promise((resolve) => {
        let open = true; // answered once: two keys arriving together would otherwise both be logged
        // When its owner stops (Esc or Ctrl-C for the lead's turn, /tasks stop, a failure), the
        // question goes from the line, on screen or not, answered as cancelled.
        const cancel = () => q.answer(false, "cancelled");
        const q: Question = {
          text: owner ? `${visible(owner.name)} to ${text}` : text,
          // A subagent's name is its id, then its description in brackets (tasks.ts); a summary starts with its action:
          // "run: …", "write …", "read …".
          label: `${owner ? `${visible(owner.name.split(" ", 1)[0]!)} to ` : ""}${text.split(/[\s:]/, 1)[0]}`,
          ...(owner ? { owner } : {}),
          ...(range ? { detail: range } : {}),
          ...(plain ? { plain } : {}),
          answer: (ok, how) => {
            if (!open) return;
            open = false;
            signal?.removeEventListener("abort", cancel);
            const typedAt = questions.current[0] === q && asked.current;
            questions.current = questions.current.filter((x) => x !== q);
            // As at the opening (below): a chord half typed at the question on screen, which one cancelled can leave,
            // never runs on into the next question's keys nor the live ones (choice 32 and its code review). A chord
            // waiting was typed there exactly when it is the first in the line and the last key was read at a
            // question (lookUp, `asked`), the model list open over it since or not. One waiting behind it, cancelled,
            // leaves the chord to the question on screen (the outside review's second round); one under the model
            // list, a chord typed in the list to the list's keys (the code re-checks).
            if (typedAt) latest.current.dropChord();
            if (q.detail && q.following) view.current = FOLLOWING; // otherwise the view stays (release 5 design, "Scrolling")
            latest.current.say({ text: `${q.short ?? q.text}: ${how}`, color: "gray" });
            resolve(ok);
            rerender((n) => n + 1);
            latest.current.next(); // an answer may have waited for this question to close
          },
        };
        signal?.addEventListener("abort", cancel, { once: true });
        // A question closes the detail view: y and n answer it, and n is "next match" there (release 5 design, "The detail
        // view"). Closed here, before it is drawn, so its first drawing places the conversation's view (release 5 plan,
        // Task 11).
        latest.current.closeDetail();
        // A chord half typed for the prompt is dropped as the question opens, so no stroke typed for the prompt joins the
        // question's keys, the launch's (release 6 plan, choices 30 and 32; found at the combined review).
        if (!questions.current.length) latest.current.dropChord();
        questions.current.push(q);
        rerender((n) => n + 1);
        // Printed out, the view comes back at once, as on q, and the question shows (release 5 plan, Task 13).
        void latest.current.comeBack();
      });
    });
    const onMessage = (m: Message) => latest.current.say(...describe(m));
    const onError = (e: ErrorEvent) => {
      if (e.kind === "tool") rerender((n) => n + 1);
      else if (e.kind === "fallback") latest.current.say({ text: `↪ ${e.message}`, color: "magenta" });
      else latest.current.say({ text: `✗ ${e.kind}: ${e.message}`, color: "red" });
    };
    const onUsage = () => {
      rerender((n) => n + 1);
      latest.current.lookUpWindow(false);
    };
    const onLead = (id: string) => {
      if (leadFromFile.current) latest.current.note(gray(`lead is now ${id}${FROM}`));
      else latest.current.say({ text: `lead is now ${id}`, color: "magenta" });
      latest.current.lookUpWindow();
    };
    const onToolStart = ({ id, name, input }: Events["tool-start"][0]) => {
      calls.current.push({ id, name, target: brief(name, input) });
      rerender((n) => n + 1);
    };
    const onToolEnd = ({ id, outcome }: Events["tool-end"][0]) => {
      const call = calls.current.find((c) => c.id === id);
      if (call) call.outcome = outcome;
      rerender((n) => n + 1);
    };
    // A background subagent's ending is shown when it comes; its answer is read at once when idle.
    const onTasks = () => {
      for (const t of tasks.all) {
        if (!t.background || t.state === "running" || t.state === "waiting" || announced.current.has(t.id)) continue;
        announced.current.add(t.id);
        latest.current.say({ text: `${t.id} ${t.state === "done" ? "finished" : t.state}`, color: "gray" });
      }
      rerender((n) => n + 1);
      latest.current.next();
    };
    const onTodo = (items: TodoItem[]) => {
      todos.current = { items, hidden: false };
      rerender((n) => n + 1);
    };
    const onNote = (text: string) => latest.current.say(gray(text));
    bus.on("message", onMessage);
    bus.on("error", onError);
    bus.on("usage", onUsage);
    bus.on("lead", onLead);
    bus.on("tool-start", onToolStart);
    bus.on("tool-end", onToolEnd);
    bus.on("todo", onTodo);
    bus.on("tasks", onTasks);
    bus.on("note", onNote);
    // The launch printed the settings file's warnings to stderr, which full screen hides until the user quits, so
    // they show here too (release 6 plan, Task 9, "The launch's warnings show in the session too"); in classic mode
    // stderr is seen, and they are not said twice.
    say(...(fullNow.current ? (live?.loaded.warnings ?? []).map(gray) : []), ...intro);
    // A watch that cannot start leaves the session as the launch set it, and says so.
    let unwatch: (() => void) | undefined;
    try {
      unwatch =
        live &&
        watchSettings(
          home,
          (read) => latest.current.onSettings(read),
          (read) => latest.current.onKeys(read),
          // A live file's line, as an edit's, of its own (note; choice 35).
          () => latest.current.noteAlone(gray(`${path.dirname(shownFile())} was removed, so ${SETTINGS} and ${KEYBINDINGS} are no longer watched this session`)),
        );
    } catch (err) {
      say(gray(`${SETTINGS} and ${KEYBINDINGS} are not watched this session (${errorText(err)})`));
    }
    launched.current = true; // the watcher's first read, done at once inside watchSettings, was the launch's (onKeys)
    history.current!.load();
    lookUpWindow();
    const minutes = setInterval(() => setNow(Date.now()), 60_000); // the status line counts the session in minutes
    const onReport = (m: Mouse) => latest.current.onMouse(m);
    mouse?.on("mouse", onReport);
    return () => {
      ended.current = true;
      // Ink ending (a crash, or a signal) lets the keyboard go, so raw mode goes off and the process can end (input.ts,
      // hold), whatever held it: the view printed out, the rest of a paste dropped after it, or a switch, whose own ending
      // a signal never lets come. Letting go again later, as a switch or comeBack does, is harmless. Bracketed paste
      // needs nothing here: Ink's own cleanups turn it off as they end, suspended or not (Ink's components/App.js).
      printed.current = null;
      dropping.current = null;
      owner.end();
      mouse?.off("mouse", onReport);
      unwatch?.();
      clearInterval(minutes);
      clearTimeout(first.current?.timer);
      clearTimeout(chordTimer.current);
      bus.off("message", onMessage);
      bus.off("error", onError);
      bus.off("usage", onUsage);
      bus.off("lead", onLead);
      bus.off("tool-start", onToolStart);
      bus.off("tool-end", onToolEnd);
      bus.off("todo", onTodo);
      bus.off("tasks", onTasks);
      bus.off("note", onNote);
      // However the screen closes, /exit or Ctrl-C or Ctrl-D twice, no subagent goes on spending; nor does a turn, which
      // Ink ending on a drawing error would leave with nothing on screen.
      tasks.stop();
      abort.current?.abort();
    };
  }, []);

  // The working line's spinner and time, while something runs; the panel's times, once a second, while
  // only subagents do.
  const running = tasks.running > 0;
  useEffect(() => {
    if (!busy && !running) return;
    const spin = setInterval(() => setNow(Date.now()), busy ? SPIN_MS : 1000);
    return () => clearInterval(spin);
  }, [busy, running]);

  // Called without await, so nothing may escape: an unhandled rejection ends the program. The queue
  // goes on after a turn, however it ended, and after `/model` once the list is closed. `answers`: a
  // turn with nothing typed, to read the background answers waiting.
  const submit = async (raw: Draft, answers = false) => {
    if (!(await perform(raw, answers))) next();
  };

  // What is happening now (phase.ts), from the refs only, the model list and the question as last drawn among them
  // (`frame`), so the mouse listener and the bus's handlers, set up once, read the screen as it is. Keys see the same as
  // this drawing's values: Ink's root is non-concurrent (above), so React draws and commits in one go, and useInput's and
  // usePaste's handler is the committed drawing's (useEffectEvent). Only the keys and the wheel ask for the menu, where
  // it was found before: finding an `@` menu can list a folder (menuFor). A paste asks pasteTo() of the same inputs.
  const phaseRefs = { ended, printed, drawn: frame, listOpen, questions, detail, search, working, queue };
  const happening = (findMenu?: () => boolean) => nowOf(phaseInputs(phaseRefs, findMenu));

  // Background answers waiting go first, in a turn of their own (release 4 design, "Background
  // subagents"). Then the queue's entries, taken from the front: a command alone, as if typed then;
  // prompts next to each other as one message, separated by blank lines. Not while something runs (a
  // command that finished after a turn started, both typed in one read of the terminal, leaves the
  // queue to that turn), nor while a question or the model list is open. While the detail view is printed out, a
  // subagent's record waits for it to come back, and what is queued after it, as it would take the printed view's place
  // unseen; the model list waits in perform, below (the user's choices, release 5). So does /screen, which would change
  // the screen under the printed view, and could not suspend Ink, suspended already. Messages and other commands go on.
  // Nothing starts once Ink has ended, a turn going on paying with no screen to show it. While the terminal is handed
  // over (owner.ts, busy), to an editor too, /screen, /settings and /keybindings wait, as each would hand it over
  // again; messages and other commands go on (release 6 plan, Task 12).
  // A lead or screen the settings file set waits here as `/lead` and `/screen` would in the queue, the screen also
  // while the terminal is handed over (release 6 design, "When a live change applies").
  const next = () => {
    const h = happening();
    if (h.phase.kind === "ended" || h.working || h.waiting) return;
    const w = waiting.current;
    if (w.lead !== undefined) fileLead(w.lead);
    w.lead = undefined;
    if (w.screen && !owner.busy) {
      const to = w.screen;
      w.screen = undefined;
      if (to === "full" && !fullNow.current && !fullPossible) note(gray("Full screen needs a terminal (the output is not one, or CI is set)"));
      else if ((to === "full") === fullNow.current) note(gray(`screen is now ${to}${FROM}`));
      else {
        // As perform runs /screen: what goes wrong is said, and the queue goes on after.
        void switchScreen(true)
          .catch((err) => say({ text: errorText(err), color: "red" }))
          .then(next);
        return;
      }
    }
    if (tasks.wakes()) return void submit({ text: "", spans: [] }, true);
    const q = queue.current;
    const command = q.findIndex((d) => isCommand(d.text));
    if (!h.queued) return;
    if (h.phase.kind === "printed" && command === 0 && (recordToOpen(q[0]!.text) || /^\/screen$/i.test(q[0]!.text))) return;
    if (owner.busy && command === 0 && /^\/(screen|settings|keybindings)$/i.test(q[0]!.text)) return;
    view.current = FOLLOWING; // sending a prompt goes to the bottom (release 5 design, "Scrolling")
    void submit(joined(q.splice(0, command === 0 ? 1 : command === -1 ? q.length : command), "\n\n"));
  };
  // The subagent whose record `text` opens in the detail view: in full screen, `/tasks t3` with a subagent of that id
  // (perform, below).
  const recordToOpen = (text: string) => {
    const [first = "", ...words] = text.split(/\s+/);
    return fullNow.current && first.toLowerCase() === "/tasks" && words.length === 1 ? tasks.all.find((t) => t.id === words[0]) : undefined;
  };

  // True when it opened the model list.
  const perform = async (raw: Draft, answers = false): Promise<boolean | void> => {
    const message = trimmed(raw);
    const { text } = message;
    if (!text && !answers) return;
    // Commands ignore case; a message is sent as typed.
    const [first = "", ...words] = text.split(/\s+/);
    const command = first.toLowerCase();
    const alone = (name: string) => command === name && !words.length;
    // `/lead` alone opens the model list, as `/model` does, in every respect (release 6 plan, choice 34, the user's:
    // "can we have lead list the models?"); `/lead <provider:model>` switches as before.
    const listing = alone("/model") || alone("/lead");
    try {
      if (alone("/exit")) {
        queue.current = [];
        return exit();
      }
      if (alone("/errors")) return say(...summarize(errorFile).map((row) => ({ text: row, oneLine: true })));
      // Not to full screen where it can't draw: classic, as at the start (clilib.ts, screenMode).
      if (alone("/screen") && !fullNow.current && !fullPossible)
        return say({ text: "Full screen needs a terminal (the output is not one, or CI is set)", color: "gray" });
      if (alone("/screen")) return await switchScreen();
      if (alone("/settings")) return await openFile(SETTINGS, {});
      if (alone("/keybindings")) return await openFile(KEYBINDINGS, { bindings: [] });
      // /vim switches vim mode, /vim on and /vim off set it (choice 6), this window only, saving nothing (choice 26).
      if (command === "/vim") {
        const [word = "", ...rest] = words.map((w) => w.toLowerCase());
        const on = word ? word === "on" : vim.current === null;
        if (!rest.length && ["", "on", "off"].includes(word)) return setVim(on);
        return say({ text: "Usage: /vim, /vim on, /vim off", color: "red" });
      }
      // In full screen a subagent's record opens in the detail view (release 5 plan, Task 12); the list, stopping and
      // mistakes print.
      if (command === "/tasks") {
        const t = recordToOpen(text);
        return t ? openDetail(recordOf(t)) : say(...tasksCommand(words));
      }
      if (command === "/lead" && !listing) {
        const spec = words.join(" ");
        session.setLead(make(spec)); // this window only, saving nothing (choice 26, the user's)
        return;
      }
      const account = command === "/login" ? "login" : command === "/logout" ? "logout" : undefined;
      // A mistyped command must not become a paid turn.
      // A slash and a bare word on its own is a command; "/tmp is full" is a message, "/exit now" is not.
      if (!account && !listing && /^\/[a-z]+$/i.test(text)) return say({ text: `Unknown command: ${text}. Commands: ${COMMANDS}`, color: "red" });
      if (words.length && ["/exit", "/errors", "/model", "/screen", "/settings", "/keybindings"].includes(command))
        return say({ text: `${command} takes nothing after it.`, color: "red" });
      abort.current = new AbortController();
      const turn = !account && !listing;
      const label = account === "login" ? "Waiting for the browser" : account ? "Signing out" : answers ? `Reading ${names(tasks.answering())}` : turn ? "Working" : "Reading the model lists";
      doing.current = { label, at: Date.now(), from: turn ? { output: stats.output, cost: stats.cost, unpriced: stats.unpriced } : null };
      if (turn) calls.current = [];
      setNow(doing.current.at);
      setBusy(true);
      working.current = true;
      // Finished subagents leave the panel at the user's next turn; after `working`, since the change
      // it reports would otherwise start the queue.
      if (turn && !answers) tasks.clearFinished();
      try {
        // Signing in waits on the browser; Ctrl-C stops it, as it stops a turn.
        if (account) await login(account, words, (line) => say({ text: line, color: "magenta" }), abort.current.signal, "/");
        else if (listing) {
          const { signal } = abort.current; // this command's own, read before the wait
          const groups = await listModels(signal, (line) => say({ text: line, color: "magenta" }));
          if (!signal.aborted) {
            listOpen.current = true;
            // A list read while the detail view is printed out, sent before `[` or from the queue, waits for it to come back
            // (the user's choice, release 5): opening, it would end the paste hook (usePaste, below), and Ink would
            // turn bracketed paste off at once, suspended or not, so a paste would come as keys. listOpen holds the
            // queue meanwhile.
            if (printed.current) waitingList.current = groups;
            else setPicker(groups);
            return true;
          }
        } else await session.send(await readsEnded(message, abort.current.signal), abort.current.signal);
      } finally {
        setBusy(false);
        working.current = false;
        setBranch(gitBranch());
      }
    } catch (err) {
      say({ text: errorText(err), color: "red" });
    }
  };

  // A message's parts, once the reads of its pictures have ended (release 6 plan, Task 14): the wait is part of its
  // turn, so Enter meanwhile queues as during a turn. A read that found nothing or failed takes its spans out of the
  // message (settle, below), which goes without it (choice 17). Any stop of the turn during the wait (Ctrl-C in the
  // detail view) ends the reads as stopped, and the turn then stops as usual; at the prompt, Esc and Ctrl-C end only
  // the reads (promptKey, below).
  const readsEnded = async (message: Draft, signal: AbortSignal) => {
    const ids = new Set(message.spans.filter((s) => pictures.get(s.id) === "reading").map((s) => s.id));
    if (!ids.size) return messageParts(message, pictures);
    reading.current = message;
    signal.addEventListener("abort", stopReads);
    try {
      // Each picture's own settle, set when its number was taken, runs first (newPicture, below).
      await Promise.all([...ids].map((id) => pictures.settled(id)));
      return messageParts(trimmed(reading.current), pictures); // trimmed again, as a marker taken out may leave a blank at an end
    } finally {
      reading.current = null;
      signal.removeEventListener("abort", stopReads);
    }
  };
  const stopReads = () => {
    for (const s of reading.current?.spans ?? []) pictures.set(s.id, { failed: "stopped" }); // a read that ended stays as it ended
  };
  // A read has ended (release 6 design, "While a read runs"). With no picture, its marker goes from wherever it is: the
  // prompt, the stash, the draft Up keeps, the prompt Ctrl+R gives back, the queue and the message waiting on it; and
  // one line says so, naming the marker when that message goes without it (plan, choice 17), in Task 15's words. A
  // failed read names where it read from: the clipboard, or a pasted path (`from`).
  const settle = (id: number, from = "the clipboard") => {
    const read = pictures.get(id);
    if (read !== "none" && !(typeof read === "object" && "failed" in read)) return;
    editor.current = cutPicture(editor.current, id); // what Ctrl+K and the rest took too (editor.ts)
    const v = vim.current; // and vim's register, so p puts none back (found at the combined review)
    const r = v && without(v.register, id);
    if (v && r) vim.current = { ...v, register: { ...v.register, text: r.text, spans: r.spans } };
    const s = stash.current;
    if (s) {
      const prompt = cutPicture(s.prompt, id);
      const walk = s.step && { ...s.step, draft: without(s.step.draft, id) };
      stash.current = prompt === s.prompt || prompt.text.trim() || walk?.draft.text.trim() ? { prompt, step: walk } : null;
    }
    if (step.current) step.current = { ...step.current, draft: without(step.current.draft, id) };
    if (search.current) search.current.before = cutPicture(search.current.before, id);
    queue.current = queue.current.map((d) => without(d, id)).filter((d) => d.text.trim());
    const waits = reading.current?.spans.some((x) => x.id === id);
    if (reading.current) reading.current = without(reading.current, id);
    // A message that was only pictures, left empty, sends nothing (session.ts, send).
    const ending = !waits ? "" : reading.current!.text.trim() ? `; ${marker(id)} was sent without it.` : "; nothing was sent.";
    const why = read === "none" ? "No picture on the clipboard" : `Could not read ${from}: ${read.failed}`;
    say({ text: ending ? why + ending : read === "none" ? `${why}.` : why, color: read === "none" ? "gray" : "red" });
  };
  // A new picture's number, its read running, with settle set to run when the read ends, and the hint row drawn again,
  // as "Reading picture..." shows while any read runs (release 6 design, "Pictures"). Every read starts here: Alt+V's
  // and a pasted path's, whose `from` names it.
  const newPicture = (from?: string) => {
    const id = pictures.next();
    reads.current++;
    void pictures.settled(id).then(() => {
      reads.current--;
      latest.current.settle(id, from);
      rerender((n) => n + 1);
    });
    return id;
  };
  // chat:imagePaste: the next picture's marker at the cursor at once, so pictures keep the order they were asked for,
  // and the picture filled in under its number when the read ends, wherever the marker is by then (design, "While a
  // read runs"). With no reader, as on Linux with no display (clipboard.ts, imageReader), no marker goes in (plan,
  // Task 15).
  const imagePaste = (e: Editor) => {
    const read = readPicture === undefined ? fromClipboard() : readPicture;
    if (!read) return say({ text: "No clipboard reader here: install wl-paste or xclip.", color: "red" });
    const id = newPicture();
    editor.current = insertPicture(e, id);
    goal.current = null;
    void read().then((r) => pictures.set(id, r));
  };
  // A paste of paths to picture files that are all there becomes those pictures, read as Alt+V's are, each failure
  // naming its path as pasted (release 6 design, "From pasted paths"). A path not absolute is taken in the project, as
  // the tools take one.
  const pastePictures = (files: string[]) => {
    for (const file of files) {
      const id = newPicture(file);
      editor.current = insertPicture(editor.current, id);
      void pictureFile(path.resolve(root, file)).then((r) => pictures.set(id, r));
    }
    goal.current = null;
  };

  // `/tasks` lists the session's subagents, `/tasks t3` prints one's tool calls and answer in full,
  // and `/tasks stop` stops all of them, or with a number one (release 4 design, "Background subagents").
  const tasksCommand = (words: string[]): Line[] => {
    const none = (id: string): Line => ({ text: `No subagent ${id}. /tasks lists them.`, color: "red" });
    const [verb, id, ...rest] = words;
    if (verb === undefined) {
      if (!tasks.all.length) return [gray("No subagents yet.")];
      const now = Date.now();
      return [gray(`Subagents: ${tasks.all.length}`), ...tasks.all.flatMap((t) => taskRow(t, now)).map((r) => ({ ...gray(`${r.mark} ${r.text}`), oneLine: true }))];
    }
    if (verb === "stop" && !rest.length) {
      if (id === undefined) return [gray(tasks.stop() ? "Stopped every subagent." : "No subagent is running.")];
      if (!tasks.all.some((t) => t.id === id)) return [none(id)];
      return [gray(tasks.stop(id) ? `Stopped ${id}.` : `${id} is not running.`)];
    }
    if (id !== undefined) return [{ text: "Usage: /tasks, /tasks <number>, /tasks stop [<number>]", color: "red" }];
    const t = tasks.all.find((x) => x.id === verb);
    return t ? recordOf(t) : [none(verb)];
  };
  // `/tasks t3`'s record: the subagent's tool calls and answer in full.
  const recordOf = (t: Task): Line[] => {
    const calls = callLines(t.messages);
    const end = t.state === "done" ? `Answer:\n${t.answer}` : t.state === "failed" ? `Failed: ${t.answer}` : t.answer ?? "(still running)";
    return [gray(`${t.id} (${t.description}), ${t.state}: ${calls.length} tool call${calls.length === 1 ? "" : "s"}`), ...calls, gray(end)];
  };

  // Picking does what `/lead <provider:model>` does. What it says ("lead is now ...", from the bus, or why not) is asked-for
  // output, shown at the bottom (release 5 design, "Scrolling"), as the wheel can scroll the view while the list is open.
  const pick = (spec: string) => {
    listOpen.current = false;
    setPicker(null);
    view.current = FOLLOWING;
    // The pick comes after any edit of the file's lead made while the list was open, so it wins, as a /lead typed
    // then would.
    waiting.current.lead = undefined;
    try {
      session.setLead(make(spec)); // this window only, as /lead (choice 26)
    } catch (err) {
      say({ text: errorText(err), color: "red" });
    }
    next();
  };
  const closePicker = () => {
    listOpen.current = false;
    setPicker(null);
    next();
  };

  // The detail view opens over the conversation, though not over a question, which closes it (bindAsk, above): what a key
  // read before a question is first drawn asks for is said in the conversation instead. Opening and closing clear the
  // selection, which belongs to the other pane's lines, and end a drag, a grab of the bar and a run of clicks.
  const unselect = () => {
    selection.current = null;
    held.current = null;
    grab.current = null;
    lastPress.current = null;
  };
  const openDetail = (lines: Line[]) => {
    if (questions.current.length) return say(...lines);
    detail.current = opened(lines, frame.current.columns - 1); // as last drawn, for a turn started before a resize
    unselect();
    rerender((n) => n + 1);
  };
  const closeDetail = () => {
    if (!detail.current) return;
    detail.current = null;
    unselect();
  };
  // `[` prints the view into the normal scrollback, for the terminal's own search, selecting and scrolling (release 5
  // design, "The detail view"; release 5 plan, Task 13). Raw mode is held on throughout, as Ink's suspend would turn it
  // off, which left the Windows console reading whole lines (design, "Switching during a session"). The mouse goes off
  // before Ink is suspended and the second screen after, as `leave` orders them; the view's lines are drawn by Ink's
  // own renderToString at the terminal's width, with their colours (release 5 plan, choice 13), without the search's or
  // the selection's reverse colours, and the selection is cleared, as opening and closing clear it. An empty line is
  // drawn as a space, as an empty Text takes no row, and without a colour, whose codes would keep the space at the
  // line's end. Then the keys go to a reader of the App's own: q, Esc or Ctrl-C come back, other keys do nothing. Ink's
  // suspend turns the kitty keyboard protocol off, so q comes as q, and bracketed paste, which is turned on again, so a
  // paste comes marked and does nothing (the user's choice, release 5). Meanwhile the work goes on, and nothing is
  // drawn, as Ink drops every render while suspended. A question that arrived while going out brings the view back at
  // once.
  const printOut = async (d: Detail) => {
    const p: Printed = {};
    printed.current = p;
    unselect();
    p.handover = owner.take();
    screen.setMouse(false);
    const { resume } = await p.handover.suspend();
    if (printed.current !== p) return; // Ink ended meanwhile, and the cleanup above let the keyboard go
    screen.setSecond(false);
    screen.suspended = true;
    const page = d.rows.lines.map((l, i) => (
      <Text key={i} color={l.text ? l.color : undefined} wrap={l.oneLine ? "truncate-end" : "wrap"}>
        {l.text || " "}
      </Text>
    ));
    screen.write(`${renderToString(<>{page}<Text color="gray">Printed. q, Esc or Ctrl-C to go back.</Text></>, { columns })}\n`);
    screen.write(PASTE_ON);
    p.resume = resume;
    input!.divert(reader);
    if (questions.current.length) await comeBack();
  };
  // What a read does is readOut's (input.ts). Keys after the one that comes back are dropped: Ink is not reading again
  // until it resumes.
  const reader = (keys: string) => {
    const p = printed.current;
    if (!p) return;
    const read = readOut(p.paste, keys);
    p.paste = read.paste;
    if (read.back) void comeBack();
  };
  // Coming back undoes going out in reverse; bracketed paste goes off as Ink's suspend left it, and Ink's resume turns it on
  // again. A paste still coming in, when a question or the key coming back brought the view back, is dropped up to its
  // end before keys reach Ink, so a y in it never answers a question, nor a pasted q closes the view (the user's choice,
  // release 5); what follows its end marker in the same read goes with it. A `[` read once Ink reads keys again, before
  // its drawing is done, prints the view out again, and that print-out keeps the hold and what waits. So does a switch
  // a /screen sent then started (Ctrl+O closing the view, then the prompt, in one read): its own ending lets go, as
  // letting go in its middle would let Ink's suspend turn raw mode off.
  const comeBack = async () => {
    const p = printed.current;
    if (!p?.resume) return;
    printed.current = null;
    if (p.paste === undefined) input!.divert(null);
    else {
      dropping.current = p;
      input!.divert((keys) => {
        p.paste = readOut(p.paste, keys).paste;
        if (p.paste !== undefined) return;
        dropping.current = null;
        input!.divert(null);
      });
    }
    screen.write(PASTE_OFF);
    screen.setSecond(true);
    screen.setMouse(true);
    screen.suspended = false;
    await p.resume();
    p.handover!.done(); // also when Ink ended meanwhile, after its cleanup let go: again is harmless (input.ts, hold)
    if (printed.current) return;
    // Ink ending during the resume (a crash in its redraw) starts nothing that waited: no screen would show it, and a
    // turn would go on paying with none.
    if (ended.current) return;
    const list = waitingList.current;
    waitingList.current = null;
    if (list) setPicker(list);
    next();
  };
  // /screen (release 5 design, "The two modes"; release 5 plan, Task 14), in the orders the user's check settled, with
  // raw mode held on throughout, as Ink's suspend and resume would turn it off and on (release 5 plan, "Before you
  // start"). Like a turn, it holds the queue while it runs, so what is sent meanwhile, another /screen too, waits for
  // it. What the mouse was doing (a selection, a held button, a grab of the bar, a run of clicks, the wheel's carried
  // fraction) belongs to the screen before, and goes.
  // To classic: the detail view closes, as a queued /screen can run while it is open; nothing is drawn, and once React
  // has drawn that, Ink is suspended, the screen left and Ink resumed, so its redraw draws nothing on the normal
  // screen; then <Static> mounts and prints the whole conversation (release 5 plan, choice 17). The mode is classic
  // from the start, nothing being drawn meanwhile, so a key read then (Ctrl+O, a scroll key) acts as in classic mode.
  // The wait matters for a /screen run from the queue: set outside any key, its state is drawn only later, by React's
  // scheduler, and without the wait Ink's resume would draw the full-screen frame again on the normal screen.
  // To full screen: the view is given the lines said in classic mode, wrapped at the width it is drawn at, so not
  // wrapped again at its first drawing, and the mode is full from then on, so a question asked while the switch runs
  // keeps its detail's place and is brought to it; Ink is suspended, the second screen entered, and once React has
  // drawn the full-screen frame, Ink resumes and draws it there, never the classic frame. Ink drops every render while
  // suspended, so nothing is drawn before. `full` follows only once the second screen is on, so React draws no
  // full-screen frame on the normal screen; `fullNow` is set just before the suspend, so the keys Ink read with the
  // Enter that sent /screen, which it handles next, act as in full screen: a Ctrl+O among them opens the detail view. A
  // `[` does nothing while `owner.suspended`, from the suspend to the resume, either way, as it would suspend Ink
  // again, which throws. The view follows the bottom: sending /screen, or the queue running it, put it there, and
  // nothing moves it in classic mode. What the switch says at the end is said, not shown, so a question asked meanwhile
  // keeps the view on its detail.
  // If Ink ends meanwhile (a render error), nothing more is switched, the terminal being put back as it is then
  // (terminal.ts, restoreWhenInkEnds), and the keyboard is let go, so raw mode goes off and the process can end. A `[`
  // read while Ink resumes, before its drawing is done, keeps the hold, as in comeBack. Should the suspend throw going
  // to full screen, the mode goes back to classic, as the screen is (perform says why); `switching` ends however the
  // switch does. A switch the settings file asked for (`file`) says so; /screen's own saves nothing (choice 26).
  const switchScreen = async (file = false) => {
    const toFull = !fullNow.current;
    working.current = true;
    const handover = owner.take();
    unselect();
    wheel.current = 0;
    try {
      if (toFull) {
        const width = frame.current.columns - 1; // one column short, as above
        if (kept.width !== width) kept.setWidth(width);
        kept.add(unkept.current);
        unkept.current = [];
        fullNow.current = true;
        const { resume } = await handover.suspend();
        if (ended.current) return;
        screen.enter();
        setFull(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (ended.current) return;
        await resume();
      } else {
        closeDetail();
        fullNow.current = false;
        setFull(false);
        setSwitching(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (ended.current) return;
        const { resume } = await handover.suspend();
        screen.leave();
        await resume();
      }
    } finally {
      if (toFull && !screen.full) fullNow.current = false; // the suspend threw, or Ink ended first
      setSwitching(false);
      working.current = false;
      handover.done(); // a print-out started during the switch keeps the hold (comeBack, above)
    }
    if (ended.current) return;
    (file ? note : say)({ text: `screen is now ${toFull ? "full" : "classic"}${file ? FROM : ""}`, color: "gray" });
  };

  // The editor in the terminal (release 6 design, "The external editor"; plan, Task 12), through the owner, which waits
  // for a hand-over under way, suspends Ink and lets go of the keyboard (owner.ts, program). Full screen steps aside as
  // for `[` (printOut, comeBack): the mouse and the second screen go, with the selection, and come back before Ink
  // resumes, unless Ink ended meanwhile and the terminal was put back. They go once the program's turn comes, as a
  // switch it waited for may have changed the screen. Meanwhile Ink drops every render, the turn goes on, and a
  // question waits; both show on return. The editor is read as it starts, so a live edit of "editor" applies from the
  // next one. In classic mode the lines said meanwhile reach <Static> only once Ink has resumed: it counts as printed
  // what a render Ink drops held, so they would never be printed.
  // While the editor runs, one line says what Tachikoma waits for (choice 33, the user's: "Say Ctrl-C too", then "Say
  // Tachikoma (Recommended)", as an editor such as `code --wait` may act on Ctrl-C itself), as an editor in its own
  // window leaves the terminal showing only the screen from before. Git's editor.c (launch_specified_editor, read
  // 2026-10-30) writes its hint once the editor starts, ending in a space with no line break, and erases it with
  // "\r\x1b[K" (pager.c, term_clear_line) once the editor has exited, succeeded or not; it does not when the editor
  // could not be started, nor when it died of Ctrl-C or Ctrl-\, which Git then raises itself. Tachikoma writes its line
  // once the terminal is handed over, cut to a row, and erases it in the same way every time the editor returns, so an
  // editor in the terminal leaves its screen and the frame Ink draws again as they were. A command the shell cannot
  // find still starts the shell, whose own error is printed after the line, on its row, and ends with a line break, so
  // the erase clears the row below it: the line and the shell's error stay on the normal screen, and Tachikoma says the
  // editor was not found once it is back. A resize while the editor is open can leave part of the line, as with Git.
  // Written straight to the terminal, never said, so it is in no printed output nor <Static>. Git's dumb-terminal case
  // (a line break, nothing erased) is not followed: Ink's frame needs the same codes.
  const away = async <T,>(edit: (command: string) => Promise<T>) => {
    try {
      return await owner.program(async () => {
        const full = screen.full;
        unselect();
        if (full) screen.leave();
        else printUpTo.current = nextId.current;
        screen.suspended = true;
        const command = editorCommand(process.env, fileNow.current.editor, process.platform);
        // Cut to the width the App draws at, a column short, so it never wraps onto a row the erase leaves.
        screen.write(WAITING.slice(0, Math.max(0, frame.current.columns - 1)));
        try {
          return { command, got: await edit(command) };
        } finally {
          screen.write(ERASE_LINE);
          if (full && !ended.current) screen.enter();
          screen.suspended = false;
        }
      });
    } finally {
      printUpTo.current = null;
      rerender((n) => n + 1);
    }
  };
  // The one line for an editor that failed or was not found, naming how to set one (design, "On return").
  const editorFailed = (command: string, failed: string) => {
    const why = failed === NOT_FOUND ? `${command} was not found` : `The editor failed (${failed})`;
    say({ text: `${why}. Set VISUAL or EDITOR, or "editor" in ${shownFile()}.`, color: "red" });
  };
  // Ctrl+G and Ctrl+X Ctrl+E: the prompt as it is when the editor starts goes to it, and what it saved becomes the
  // prompt, the cursor at the end, as one step Ctrl+Z takes back; on failure the prompt stays (design, "On return").
  // Then the queue goes on: a /screen, /settings or /keybindings may have waited for the editor (next, above).
  const externalEditor = async () => {
    const ids = editor.current.spans.map((s) => s.id); // the pictures the prompt holds as the editor opens
    const ran = await away((command) => editText(editor.current.text, command));
    if (!ran) return; // Ink ended meanwhile
    if ("failed" in ran.got) editorFailed(ran.command, ran.got.failed);
    else {
      const e = editor.current;
      // A marker is a span again when it names a picture the prompt held as the editor opened (release 6 design,
      // "Which pictures a message carries"): the editor's file is plain text.
      const d = change(e, 0, e.text.length, ran.got.text);
      editor.current = { ...d, spans: spansIn(d.text, ids) };
      goal.current = null;
      freshText();
      rerender((n) => n + 1);
    }
    next();
  };
  // /settings and /keybindings open the real file, so each save reaches the watcher while the editor is still open
  // (plan, Task 12). A missing one is made first, `blank` in two-space JSON (choice 2), with a private file's mode,
  // 0o600 (auth/private.ts, writePrivate), never over one made meanwhile.
  const openFile = async (name: string, blank: object) => {
    const file = path.join(settingsDir(home), name);
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      writeFileSync(file, `${JSON.stringify(blank, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const ran = await away((command) => editFile(file, command));
    if (ran && "failed" in ran.got) editorFailed(ran.command, ran.got.failed);
  };

  // A live edit of the settings file (release 6 design, "Live edits"): a broken file keeps the last good settings
  // and says what is wrong; a warning is said once, while its entry stays; each entry the edit changed applies by the
  // design's table, or, given by a flag or variable at launch, stays as given. Removing an entry is a change to what
  // applies without it, the default, as resolve gives it with no flag nor variable.
  const onSettings = (read: Loaded) => {
    newEdit.current = true;
    if ("problem" in read) return note({ text: `${read.problem}; the last good settings still apply`, color: "red" });
    for (const w of read.warnings) if (!warned.current.includes(w)) note(gray(w));
    warned.current = read.warnings;
    const before = fileNow.current;
    fileNow.current = read.settings;
    const now = resolve({}, {}, read.settings);
    for (const key of LIVE) {
      if (JSON.stringify(before[key]) === JSON.stringify(read.settings[key])) continue;
      // VISUAL and EDITOR come before the file's editor, as a flag comes before an entry (external.ts, editorCommand).
      const flag = key === "editor" ? (process.env.VISUAL ? "VISUAL" : process.env.EDITOR ? "EDITOR" : undefined) : live?.given[key];
      if (flag) note(gray(`${SETTINGS}'s "${key}" was left as ${flag} set it for this session`));
      else applyEntry(key, read.settings, now);
    }
    next();
  };
  // The keys file, at launch and at each edit (release 6 plan, Task 11): its keys apply at once, `?` and the hints
  // following them. A broken file keeps the keys before it, the default ones until a good file is read, and says so;
  // each problem in an entry is said once, while it stays, as a settings warning is (choice 21).
  const onKeys = (read: KeysLoaded) => {
    newEdit.current = true;
    if ("problem" in read) {
      return note({ text: `${read.problem}; ${keysRead.current ? "the last good keys still apply" : "the default keys apply"}`, color: "red" });
    }
    keysRead.current = true;
    // After the launch, a question reads the launch's keys, whole (lookUp), so a shell command that rewrites the file
    // cannot make a key answer it (choice 32, which replaced choice 30's keepAnswers); a line says so when the edit
    // differs from them where they still apply, said as a problem is.
    let problems = read.problems;
    if (!launched.current) launchKeys.current = read.table;
    else if (read.table.heldBack(launchKeys.current)) {
      problems = [...problems, `${KEYBINDINGS}: at a permission question the keys stay as at launch, and a key newly bound to switch the mode does nothing, until the next launch; the rest apply now`];
    }
    for (const p of problems) if (!keysWarned.current.includes(p)) note(gray(p));
    keysWarned.current = problems;
    setTable(read.table);
  };
  // One entry's new value, `s` the file's and `now` what applies (above), with its line. A lead or a screen waits for
  // next() (above). A model the file names that cannot be made is said, as at launch (cli.tsx), and the one before is
  // kept.
  const applyEntry = (key: (typeof LIVE)[number], s: Settings, now: ReturnType<typeof resolve>) => {
    const line = (value: string) => note(gray(`${key} is now ${value}${FROM}`));
    const model = (spec: string | undefined) => {
      if (!spec) return undefined; // an empty --fallback or --worker is none at launch too (cli.tsx)
      try {
        return make(spec);
      } catch (err) {
        note({ text: `${SETTINGS}: "${key}": ${errorText(err)}`, color: "red" });
        return null;
      }
    };
    if (key === "lead") {
      waiting.current.lead = s.lead;
      // A session cannot be without a lead, so removing the entry keeps the one it has (the design's table).
      if (s.lead === undefined) note(gray(`"lead" was removed from ${SETTINGS}; the lead stays ${session.lead.id}`));
    } else if (key === "mode") {
      // `never` is refused live (the user's choice, design's table), and at launch too until release 7 (plan, choice 30).
      if (now.mode === "never") return note(gray(`"mode": "never" is switched off until release 7; the mode stays ${perm.current}`));
      // A live edit never changes the mode, so a shell command the user allowed cannot rewrite the file to put the
      // session in project mode; Shift+Tab still does (plan, choice 32, the user's: "Pin at launch").
      note(gray(`"mode" changes in ${SETTINGS} take effect at the next launch; the mode stays ${perm.current}`));
    } else if (key === "effort") {
      effortNow.current = { effort: now.effort };
      session.lead.setEffort?.(now.effort);
      // As at launch (cli.tsx, makeProvider), the fallback and the subagents' worker take it too.
      session.fallback?.setEffort?.(now.effort);
      tasks.worker.setEffort?.(now.effort);
      line(now.effort ?? "the model's default");
    } else if (key === "fallback") {
      const p = model(now.fallback);
      if (p === null) return;
      session.setFallback(p);
      tasks.setFallback(p); // subagents get the lead's fallback, as at launch (cli.tsx)
      line(p?.id ?? "off");
    } else if (key === "worker") {
      const p = model(now.worker);
      if (p === null) return;
      tasks.setWorker(() => p ?? session.lead); // without one, a subagent uses the model leading when it starts (cli.tsx)
      line(p?.id ?? "the lead's model");
    } else if (key === "maxTasks") {
      tasks.setMax(now.maxTasks);
      line(String(now.maxTasks));
    } else if (key === "status") {
      setSegments(now.segments);
      line(now.segments.join(", "));
    } else if (key === "screen") waiting.current.screen = s.screen ?? "full"; // full unless asked for classic (clilib.ts, screenMode)
    else if (key === "editor") line(editorCommand(process.env, s.editor, process.platform)); // read again at each use (away)
    else if (key === "editorMode") setVim(s.editorMode === "vim", FROM); // at once, as /vim (design's table)
    else if (key === "vimInsertModeRemaps") line(Object.keys(s.vimInsertModeRemaps ?? {}).join(", ") || "none");
    else {
      // scrollSpeed
      setSpeed(now.speed);
      line(String(now.speed));
    }
  };
  // The lead the file names, as /lead sets it, its line saying where it came from (onLead, above).
  const fileLead = (spec: string) => {
    let provider: Provider;
    try {
      provider = make(spec);
    } catch (err) {
      return note({ text: `${SETTINGS}: "lead": ${errorText(err)}`, color: "red" });
    }
    leadFromFile.current = true; // read by onLead while setLead runs: the bus calls its handlers at once
    session.setLead(provider);
    leadFromFile.current = false;
  };
  // Vim mode on, from INSERT, or off, leaving the text and cursor as they are (release 6 design's table), with its
  // line; `from` says the settings file asked. Asked to be what it is, it stays as it is.
  const setVim = (on: boolean, from = "") => {
    if (on !== (vim.current !== null)) vim.current = on ? vimStart : null;
    (from ? note : say)(gray(`editorMode is now ${on ? "vim" : "normal"}${from}`));
  };
  // Who takes a key (release 6 plan, Task 6): while a field is typed (a Ctrl+R query, a detail-view search, the model
  // list's filter), a printable key goes into it, after a chord under way (lookUp). Keys match the table exactly
  // (choice 20, the user's: "Exact match"), but in classic mode Shift+Up and Shift+Down are Up and Down, as release 4
  // read them (release 5 plan, choice 16); Ctrl+Home and Ctrl+End reach the editor's Home and End there (keys.ts,
  // commands). Text read together is no keystroke, and drops a chord under way, as any other key would.
  const route = (kind: Phase["kind"], field: boolean, ch: string, key: Key): Got => {
    let stroke = strokeOf(ch, key);
    if (!stroke) {
      dropChords();
      return null;
    }
    // Two Escs read together reach Ink as one Esc with Alt (Ink's parse-keypress.js), which release 5 took as Esc; the
    // kitty protocol, which marks each key with its eventType, sends them apart (choice 20).
    if (stroke.key === "escape" && stroke.alt && key.eventType === undefined) stroke = { ...stroke, alt: false };
    if (!fullNow.current && stroke.shift && !stroke.ctrl && !stroke.alt && (stroke.key === "up" || stroke.key === "down")) stroke = { ...stroke, shift: false };
    // At the prompt in vim mode, Esc in INSERT or VISUAL, and a key without Ctrl or Alt while a vim command is half
    // typed, go to vim before any binding, as a field's text does (plan, Task 6), so Esc there is never chat:cancel.
    // What is half typed is asked once text App changed since has dropped it (staleVim).
    staleVim();
    const v = vim.current;
    const toVim =
      v !== null &&
      (kind === "prompt" || kind === "menu") &&
      !stroke.ctrl &&
      !stroke.alt &&
      (v.pending !== "" || v.count !== "" || (stroke.key === "escape" && v.mode !== "NORMAL"));
    return lookUp(stroke, contextsOf(kind, fullNow.current), (field && printable(stroke)) || toVim ? ch : null, kind === "question");
  };
  // A stroke in the table (release 6 plan, Task 6): a chord under way first, so one ending in a plain letter completes
  // in a field too; then `typed`, the text of a key that goes into a field; then the table, in the contexts in force. A
  // stroke that drops a chord is then looked up as if none had waited (bindings.ts, press). At a question the table is
  // the launch's, whole, so a live edit changes nothing a question reads: choice 30 kept the launch's answering keys
  // in the live table, where a live chord could still regroup strokes into a launch answer (choice 32, the outside
  // review of PR #5). The first stroke read at a question, or after one, drops any chord waiting in either table.
  // Elsewhere the launch's keys read every stroke too, keeping their own chords, and a stroke switches the mode only
  // where they switch it as well, so a live edit cannot bind chat:cycleMode to a key typed anyway; one taking it out
  // applies at once (choice 32, the user's: "Yes, close it"). A stroke only the live keys switch it on does nothing.
  const lookUp = (stroke: Stroke, contexts: Context[], typed: string | null, question: boolean): Got => {
    const at = Date.now();
    if (question !== asked.current) dropChords();
    asked.current = question;
    const read = (keys: Bindings): Got => {
      const chord = keys.waiting(at) && keys.press(stroke, contexts, at);
      if (chord) return chord;
      if (typed !== null) return { typed };
      return keys.press(stroke, contexts, at);
    };
    const launch = launchKeys.current;
    if (question) return pressed(read(launch));
    const got = read(table);
    const atLaunch = launch === table ? got : read(launch);
    const cycles = (g: Got) => g !== null && "action" in g && g.action === "chat:cycleMode";
    return cycles(got) && !cycles(atLaunch) ? NOTHING : pressed(got);
  };
  // The table a chord may be waiting in, for the hint row: the launch's after a stroke read at a question (lookUp).
  const chordKeys = () => (asked.current ? launchKeys.current : table);
  const dropChords = () => {
    table.drop();
    launchKeys.current.drop();
  };
  // A chord's first strokes show in the hint row until the next key or 3 s (release 6 design, "The keys file").
  const pressed = (got: Got) => {
    if (got && "pending" in got) {
      clearTimeout(chordTimer.current);
      chordTimer.current = setTimeout(() => rerender((n) => n + 1), CHORD_MS);
    }
    return got;
  };

  // Once Ink has ended no key comes here, nor a paste or a mouse report below: Ink's cleanup takes their listeners away
  // with the App's, which sets `ended` (above). It is checked all the same, as the first phase, which hides the others.
  const onInput = (ch: string, key: Key) => {
    const h = happening(() => menuFor(editor.current) !== null);
    if (h.phase.kind === "ended" || h.phase.kind === "printed") return; // printed out: a key read with the `[` that printed the view out
    clearCopied();
    notes.current = []; // a live edit's lines leave the hint row at the next key (note, above)
    const field = h.phase.kind === "search" || h.phase.kind === "picker" || (h.phase.kind === "detail" && h.phase.searching);
    onKey(h, route(h.phase.kind, field, ch, key), ch, key);
  };
  useInput(onInput);
  // What a key does in each phase. `ch` and `key` are for a key no binding takes (`got` null), which the prompt's
  // editor, a field or the model list may still take; and for Ctrl-C, which is reserved (bindings.ts, RESERVED), so
  // the detail view's rule for it stays its own.
  const onKey = (h: Now, got: Got, ch: string, key: Key) => {
    const action = got && "action" in got ? got.action : null;
    const kind = h.phase.kind;
    if (kind === "prompt" || kind === "menu") return promptKey(h, got, ch, key);
    dropRemap();
    // Any other key starts the press-twice count again, as at the prompt (below).
    if (action !== "app:exit") forget();
    if (kind === "picker") {
      const to = pickerKey.current;
      if (got && "typed" in got) to?.({ text: got.typed });
      else if (action === "app:interrupt") to?.({ action: "select:cancel" }); // Ctrl-C closes the list, as Esc does
      else if (action?.startsWith("select:")) to?.({ action });
      else if (action) everywhere(action, h);
      else if (!got && (key.backspace || key.delete)) to?.("backspace");
      else if (!got && !key.ctrl && !key.meta && ch) to?.({ text: ch }); // typed text read together, or a paste (usePaste, below)
    } else if (kind === "question") {
      // Ctrl-C declines the question and stops its owner only: the lead's turn, or that subagent. A plain question's
      // answer is logged as yes or no, a permission's as allowed or declined (Task 18's code review).
      const [yes, no] = question!.plain ? ["yes", "no"] : ["allowed", "declined"];
      if (action === "app:interrupt") {
        question!.answer(false, `${no} (cancelled)`);
        if (question!.owner) question!.owner.stop();
        else {
          abort.current?.abort();
          restore();
        }
      } else if (action === "confirm:yes" || action === "confirm:no") {
        // Esc, as n: that action only; the turn goes on
        question!.answer(action === "confirm:yes", action === "confirm:yes" ? yes : no);
      } else if (action) everywhere(action, h);
    } else if (kind === "detail") detailKey(detail.current!, h, got, ch, key);
    else if (kind === "search") searchKey(h, got, ch, key);
    rerender((n) => n + 1);
  };
  // Global's actions, and Scroll's in full screen, outside the prompt: wherever Global is in force (choice 19, the
  // user's: "All three everywhere"). The detail view closes on app:toggleTranscript itself (detailKey), and each phase
  // keeps its own rule for app:interrupt, Ctrl-C being reserved. Scroll is in force at a question too, where a long
  // detail can be read before answering.
  const everywhere = (action: string, h: Now) => {
    if (action === "app:exit") return twice("Ctrl-D", h);
    const c = ACTIONS[action];
    if (c === "todos" || c === "lastTurn" || (c && isScroll(c))) run(c);
  };
  // Ctrl-D (app:exit) twice on an empty prompt exits, never during a turn (release 3 design); outside the prompt too,
  // and only with nothing typed in it, hidden or not, so no draft is lost unseen.
  const twice = (name: string, h: Now) => {
    if (h.working || editor.current.text) return;
    const again = first.current?.name === name;
    forget();
    if (again) exit();
    else remember(name);
  };

  // The prompt's keys, a menu's among them. Esc (chat:cancel), Ctrl-C (app:interrupt) and Ctrl-D (app:exit) on an
  // empty prompt keep release 3's rules: during a turn the prompt still edits; Esc stops the turn and the queue goes
  // on, Ctrl-C stops it and the queue comes back. Ctrl-D does not exit while a turn is running; with text it deletes
  // the character after the cursor, as before. The rest run as commands (ACTIONS), and a key no binding takes goes to
  // the editor, or in vim mode to vim first (vimTakes).
  const promptKey = (h: Now, got: Got, ch: string, key: Key) => {
    const action = got && "action" in got ? got.action : null;
    const v = vim.current;
    const stroke = strokeOf(ch, key);
    // Claude Code's vim hook leaves VISUAL on any Ctrl or Meta key, and its text field then takes no editing key from
    // it (2.1.312's `if(a.ctrl||a.meta){if(l.mode==="VISUAL"){...;a.preventDefault();return}`), so here the table's
    // action still acts and the editor's own keys do nothing (plan, choice 27). Leaving is Esc with nothing half typed.
    if (v?.mode.startsWith("VISUAL") && stroke && (stroke.ctrl || stroke.alt) && stroke.key !== "escape") {
      const out = vimPress({ ...v, pending: "", count: "" }, editor.current, "escape");
      vim.current = out.v;
      editor.current = out.e;
      if (!got) return rerender((n) => n + 1);
    }
    if (vimTakes(got, ch, key)) {
      forget(); // any other key starts the press-twice count again (below)
      return rerender((n) => n + 1);
    }
    dropRemap();
    const e = editor.current;
    if (action === "autocomplete:accept" || action === "autocomplete:dismiss") {
      if (action === "autocomplete:dismiss") closed.current = e.text;
      else fill(menuFor(e)!, e); // the menu happening() found: the same text, its folder's listing kept (menuFor, list)
      forget();
      return rerender((n) => n + 1);
    }
    const name = action === "chat:cancel" ? "Esc" : action === "app:interrupt" ? "Ctrl-C" : action === "app:exit" && !e.text ? "Ctrl-D" : null;
    // While a message waits on its pictures' reads, Esc and Ctrl-C end those reads, and it goes without them (release 6
    // plan, choice 17), so a reader that never answers cannot hold the prompt.
    if (h.working && name && name !== "Ctrl-D" && reading.current) {
      stopReads();
      return rerender((n) => n + 1);
    }
    if (h.working && name) {
      if (name === "Ctrl-C") restore();
      if (name !== "Ctrl-D") abort.current?.abort();
      return rerender((n) => n + 1);
    }
    const again = name !== null && first.current?.name === name;
    forget();
    if (action === "app:exit" && e.text) run("delete");
    else if (!name) {
      if (action && ACTIONS[action]) run(ACTIONS[action]);
      // Called without await, so nothing may escape (submit, above): what goes wrong is said, as for a switch (next).
      else if (action === "chat:externalEditor") void externalEditor().catch((err) => say({ text: errorText(err), color: "red" }));
      else if (action === "chat:stash") swapStash(e);
      else if (action === "chat:imagePaste") imagePaste(e);
      else if (action?.startsWith("command:")) command(`/${action.slice("command:".length)}`);
      else if (!got) for (const c of commands(ch, key)) run(c);
    } else if (name === "Ctrl-C" && e.text) clear(e); // one press clears
    else if (!again) remember(name);
    else if (name !== "Esc") return exit();
    else if (e.text) clear(e); // Esc Esc; on an empty prompt it does nothing
    rerender((n) => n + 1);
  };
  // Vim mode at the prompt (release 6 plan, Task 21): a key route() sent to vim first (`typed`), or one no binding
  // takes and not held with Ctrl or Alt; in INSERT only a typed character and Esc, the rest being the editor's
  // (commands), and `?` on an empty prompt still lists the keys (run). Text read together is a key a character, each
  // from the top, so a fast `dw` is two keys, and a `/` among them opens the search the rest go into (design, "Vim
  // mode"). The remaps are the settings file's as now, so an edit applies from the next key. True when vim took it.
  const vimTakes = (got: Got, ch: string, key: Key): boolean => {
    const v = vim.current;
    if (!v || (got && !("typed" in got))) return false;
    const each = pieces(ch);
    if (!got && !key.ctrl && !key.meta && each.length > 1) {
      for (const p of each) {
        onInput(p, p === "\r" ? { ...key, return: true } : { ...key, shift: p !== p.toLowerCase() });
      }
      return true;
    }
    const k = vimKey(ch, key);
    const e = editor.current;
    // A character typed is one character on screen; a key's name ("left", "tab", "escape") is several letters.
    const typed = k !== null && pieces(k).length === 1;
    if (k === null || (v.mode === "INSERT" && k !== "escape" && (!typed || (k === "?" && !e.text)))) return false;
    const r = vimPress(v, e, k, { pairs: fileNow.current.vimInsertModeRemaps ?? {}, now: Date.now() });
    vim.current = r.v;
    editor.current = r.e;
    vimText.current = r.e.text;
    goal.current = null;
    if (r.act === "help") show(...keyList(table, contextsOf("prompt", fullNow.current), vimFirst(), launchKeys.current).map(gray));
    else if (r.act) run(r.act === "submit" ? "submit" : ACTIONS[r.act]!); // history:previous, :next or :search
    return true;
  };
  // VISUAL's anchor is a place in the text as vim's last key left it, and a command or count half typed was typed for
  // that text. Once App changes the text (a message sent, a recall, a paste, a picture's marker taken out...), VISUAL
  // goes to NORMAL and what was half typed is dropped, so no selection, nor `o`'s jump to the anchor, reaches into text
  // that is gone, and no `d` typed for one text deletes from another; moving the cursor alone keeps them (code review of
  // Task 21; choice 27; the final review).
  const staleVim = () => {
    const v = vim.current;
    if (!v || editor.current.text === vimText.current) return;
    if (v.mode.startsWith("VISUAL")) {
      const { anchor, ...rest } = v;
      vim.current = { ...rest, mode: "NORMAL", pending: "", count: "" };
    } else if (v.pending || v.count) vim.current = { ...v, pending: "", count: "" };
  };
  // Vim takes a plain Esc first in INSERT and VISUAL, and while a command or count is half typed (route), so the first
  // Esc only goes to NORMAL and the working line and `?` name the Esc that stops or clears after it (choice 31).
  const vimFirst = () => {
    const v = vim.current;
    return v !== null && (v.mode !== "NORMAL" || v.pending !== "" || v.count !== "");
  };
  // Claude Code ends a remap pair's wait at every key (its cancelPendingRemap): `press` ends it at the keys it takes,
  // and App at the rest (plan, Task 21).
  const dropRemap = () => {
    if (!vim.current?.remap) return;
    const { remap, ...rest } = vim.current;
    vim.current = rest;
  };
  // New text in the prompt (a message sent, a history recall, the editor's text back...) drops where vim's INSERT began
  // its typing, so `.` takes what is typed next from its first character (plan, Task 21).
  const freshText = () => {
    if (!vim.current?.entered) return;
    const { entered, ...rest } = vim.current;
    vim.current = rest;
  };

  // The detail view's keys (release 5 design, "The detail view"; release 5 plan, Task 12): the conversation's scroll
  // keys; j and k, or Down and Up, a row; g or Home the top, G or End the bottom; q, Esc and Ctrl+O close it; `/`
  // starts a search, and n and N go to the next and previous match of one kept; `[` prints it out (release 5 plan,
  // Task 13). While a search is typed, text goes into it, `[` too, Backspace edits it, Enter keeps it, or drops it when
  // nothing matches, and Esc drops it, the view going back to where it was; the other keys act as above. Backspace
  // takes away a whole character, as the prompt's does. Ctrl-C stops a turn, and its queue comes back into the
  // prompt, as at the prompt; with nothing running it only closes the view, never clearing the hidden prompt nor
  // counting toward exiting (the user's choice, release 5). Any other key does nothing: the prompt is hidden, and
  // Alt+P's model list, Ctrl+R's search and the like wait for the view to close. Several keys can come in one read,
  // each its own key here, so each checks the view is still open and not printed out.
  const detailKey = (d: Detail, h: Now, got: Got, ch: string, key: Key) => {
    if (detail.current !== d || printed.current) return;
    const s = d.search;
    if (!got) {
      // Enter is no action here, and keys.ts leaves it to chat:submit: it keeps a search being typed, as before.
      for (const c of key.return ? ["submit" as const] : commands(ch, key)) {
        if (detail.current !== d || printed.current) return;
        if (typeof c === "object")
          for (const letter of c.text) {
            const as = { ...key, shift: letter !== letter.toLowerCase() };
            const one = route("detail", d.search?.typing === true, letter, as);
            if (one) detailKey(d, h, one, letter, as);
          }
        else if (s?.typing && c === "backspace") searchFor(d, s.query.slice(0, [...segmenter.segment(s.query)].at(-1)?.index ?? 0), viewHeight);
        else if (s?.typing && c === "submit") {
          if (s.found.length) s.typing = false;
          else d.search = null;
        }
      }
      return;
    }
    if ("typed" in got) return searchFor(d, s!.query + got.typed, viewHeight);
    if ("pending" in got) return;
    const a = got.action;
    const move = MOVES[a];
    if ((a === "transcript:exit" || a === "app:interrupt") && key.ctrl && ch === "c") {
      if (!h.working) closeDetail();
      else {
        restore();
        abort.current?.abort();
      }
    } else if (a === "transcript:exit" && s?.typing) {
      d.view.current = s.before;
      d.search = null;
    } else if (a === "transcript:exit" || a === "app:toggleTranscript") closeDetail();
    else if (a === "transcript:print" && input && !owner.suspended) void printOut(d); // switchScreen says why
    else if (a === "transcript:search") d.search = { query: "", found: [], at: 0, typing: true, before: d.view.current };
    else if ((a === "transcript:nextMatch" || a === "transcript:previousMatch") && s) stepMatch(d, a === "transcript:nextMatch" ? 1 : -1, viewHeight);
    else if (move) scroll(move);
    else everywhere(a, h);
  };

  // Esc, Ctrl-C and Ctrl-D count twice when the second press comes within 800 ms of the first, the
  // window Claude Code's docs give for Ctrl+D. Any other key in between starts the count again.
  const remember = (name: string) => {
    const timer = setTimeout(() => {
      first.current = null;
      rerender((n) => n + 1);
    }, DOUBLE_PRESS_MS);
    first.current = { name, timer };
  };
  const forget = () => {
    clearTimeout(first.current?.timer);
    first.current = null;
  };

  // A pasted block goes in whole, its line breaks as new lines: it is never sent by them; one of only paths to picture
  // files becomes those pictures (pastePictures). While the picker is open, pastes reach it as typed text, as before.
  usePaste(
    (text) => {
      const given = phaseInputs(phaseRefs);
      if (given.printed) return; // as for keys, above; before clearCopied(), which pasteTo() cannot say
      clearCopied();
      dropChords(); // a paste is text, which drops a waiting chord as text read together does (route)
      const to = pasteTo(given);
      // In the detail view a paste goes into a search being typed, up to its first line break, without the control
      // characters typed text loses (keys.ts, commands); otherwise it does nothing there (the user's choice,
      // release 5).
      const d = detail.current;
      if (to === "search" && d?.search) {
        searchFor(d, d.search.query + text.split(/\r\n?|\n/, 1)[0]!.replace(/\p{Cc}/gu, ""), viewHeight);
        return rerender((n) => n + 1);
      }
      if (to === null) return;
      const files = imagePaths(text);
      if (files?.every((f) => isFile(path.resolve(root, f)))) pastePictures(files);
      else run({ type: "paste", text: text.replace(/\r\n?/g, "\n") });
      rerender((n) => n + 1);
    },
    { isActive: !picker },
  );

  // The scroll keys move the conversation (release 5 design, "Scrolling"): PgUp and PgDn by half its height, at least a
  // row; Ctrl+Home to the top; Ctrl+End to the bottom, following again; Shift+Up and Shift+Down by a row. They work
  // during a turn and while a question waits, and move the detail view while it is open (release 5 plan, Task 12).
  const scroll = (c: Scroll) => {
    const p = pane();
    const half = Math.max(1, Math.floor(viewHeight / 2));
    const by = { pageUp: -half, pageDown: half, lineUp: -1, lineDown: 1, top: 0, bottom: 0 }[c];
    p.view.current =
      c === "top" ? scrollTo(p.rows, p.view.current, viewHeight, 0) : c === "bottom" ? FOLLOWING : scrollBy(p.rows, p.view.current, viewHeight, by);
  };
  // The selection as two places, from the press to the pointer's cell, both cells' characters in (release 5 plan, choice
  // 6), as span takes them: backward, from the pointer's character to the end of what was pressed; otherwise from the
  // start of what was pressed to whichever ends later.
  const selected = (): [Pos, Pos] | null => {
    const s = selection.current;
    if (!s) return null;
    const [at, atEnd] = s.end;
    const [from, fromEnd] = s.press;
    const before = (a: Pos, b: Pos) => a.line < b.line || (a.line === b.line && a.offset < b.offset);
    return before(at, from) ? [at, fromEnd] : [from, before(fromEnd, atEnd) ? atEnd : fromEnd];
  };
  // On release: the selection's text to the clipboard (release 5 design, "Copying"), never an empty one, and the hint row
  // says how many characters, counted as a person sees them, as the prompt counts them (release 5 plan, choice 7).
  const copy = () => {
    const s = selected();
    const text = s ? textOf(pane().rows.lines, ...s) : "";
    if (!text) return;
    board.current!.copy(text);
    const n = characters(text);
    copied.current = { text: `Copied ${n} character${n === 1 ? "" : "s"}${board.current!.terminalOnly ? " with the terminal only" : ""}`, failed: false };
  };
  // The wheel and the scroll bar (release 5 design, "Scrolling"), in full screen only. The wheel scrolls the conversation
  // wherever the pointer is, and while a question or the model list is open (release 5 plan, choice 3). The bar is the
  // last column of the conversation's rows, which start at the frame's top, the terminal's top row: Ink writes the
  // frame, a row shorter than the terminal, with a line break after it (ink.js renderInteractiveFrame), so it fills the
  // terminal and scrolls up to its top wherever the cursor was; later frames go back up by the rows written
  // (log-update.js).
  // A left press on the thumb grabs it; on the track it centres the thumb on that row (release 5 plan, choice 4), as
  // far as the bar's ends let it, and grabs it where the pointer is on it, so a drag can go on from the click. While
  // grabbed, the thumb follows the pointer's row wherever the pointer is, until the button is let go; a move that would
  // leave the thumb where it is does nothing, as one thumb row stands for several first rows. Any press ends an earlier
  // grab or selecting, and a release ends either. A left press elsewhere in the conversation selects (release 5 design,
  // "Selecting"); one below it clicks the prompt or a menu entry (clickAt). All of it acts on the detail view in the
  // conversation's place while it is open (release 5 plan, Task 12). A report read with a key that opened or closed the
  // view, or come after a question closed it, belongs to a screen that is gone, and is dropped, as clickAt drops a
  // click read with a key that changed the prompt.
  const onMouse = (m: Mouse) => {
    // `ended` never comes here (useInput says why), and is checked as the first phase. Printed out: a report read with its
    // `[`, as for keys.
    // A wheel notch asks for the menu, as a key does (useInput), so Autocomplete comes first while one is open.
    const h = happening(m.kind === "wheel" ? () => menuFor(editor.current) !== null : undefined);
    const { phase } = h;
    if (!fullNow.current || phase.kind === "ended" || phase.kind === "printed") return;
    const { columns, viewHeight } = frame.current;
    if (frame.current.detail !== detail.current) return;
    const p = pane();
    const goTo = (to: number) => {
      p.view.current = scrollTo(p.rows, p.view.current, viewHeight, to);
      rerender((n) => n + 1);
    };
    // A wheel notch is a stroke of its own, pressed in the contexts in force (release 6 plan, Task 6), Scroll's among
    // them in the model list too. scroll:lineUp and scroll:lineDown move by the notch, as release 5's wheel did;
    // another action acts as its key would.
    if (m.kind === "wheel") {
      const stroke = { key: `wheel${m.wheel}`, ctrl: m.ctrl, alt: m.alt, shift: m.shift };
      // A notch that drops a waiting chord is then looked up as if none had waited, as a key is (lookUp), and the chord
      // leaves the hint row even when the notch has nowhere to scroll.
      const waited = chordKeys().waiting(Date.now()) !== null;
      const got = lookUp(stroke, contextsOf(phase.kind, true, true), null, phase.kind === "question");
      if (waited) rerender((n) => n + 1);
      if (!got) return;
      if (!("action" in got) || (got.action !== "scroll:lineUp" && got.action !== "scroll:lineDown")) return onKey(h, got, "", NO_KEY);
      const step = notch(wheel.current, speed, got.action === "scroll:lineUp" ? -1 : 1);
      wheel.current = step.carry;
      const from = firstRow(p.rows, p.view.current, viewHeight);
      if (step.rows && (step.rows < 0 ? from > 0 : p.view.current.at !== null)) goTo(from + step.rows); // not up at the top, nor down following
      return;
    }
    if (m.kind === "release") {
      grab.current = null;
      const h = held.current;
      held.current = null;
      if (h?.copy) {
        copy();
        rerender((n) => n + 1);
      }
      return;
    }
    const top = firstRow(p.rows, p.view.current, viewHeight);
    const thumb = bar(p.rows.total, viewHeight, top);
    const onBar = thumb !== null && m.x === columns - 1 && m.y < viewHeight;
    if (m.kind === "press") {
      grab.current = null;
      held.current = null;
      clearCopied();
      // A selection stays until a click: any press but one on the scroll bar, which scrolls as the wheel does (the user's
      // choice, release 5).
      if (!onBar && selection.current) {
        selection.current = null;
        rerender((n) => n + 1);
      }
    }
    if (m.button !== "left") return;
    if (m.kind === "drag" && held.current) return dragTo(held.current, m.x, m.y);
    if (m.kind === "press" && m.x !== columns - 1 && m.y < textRows(viewHeight)) return pressAt(top, m.x, m.y);
    if (m.kind === "press" && m.y >= viewHeight) return clickAt(m.x, m.y);
    if (!thumb) return;
    const clamp = (start: number) => Math.max(0, Math.min(viewHeight - thumb.size, start));
    const move = (start: number) => start !== thumb.start && goTo(barFirst(p.rows.total, viewHeight, thumb.size, start));
    if (m.kind === "drag" && grab.current !== null) return void move(clamp(m.y - grab.current));
    if (m.kind !== "press" || !onBar) return;
    const on = m.y >= thumb.start && m.y < thumb.start + thumb.size;
    const start = on ? thumb.start : clamp(m.y - Math.floor(thumb.size / 2)); // centred on its middle row, the lower of two
    grab.current = m.y - start;
    move(start);
  };

  // The cell at the pane's row `row` as select.ts takes it. A row below the last line, blank in a view held past the
  // bottom, stands for the last line's end.
  const cellAt = (rows: Rows, row: number, x: number) =>
    row < rows.total ? { row, x } : { row: rows.total - 1, x: rows.width }; // rows.width: past any row's text
  // The pane's rows that show text: all but the "↓ N new lines" row while it shows, which is not text (release 5 plan,
  // choice 10's rule for such rows): a press there starts nothing, and a drag onto it counts as the row above it.
  const textRows = (viewHeight: number) => viewHeight - (unseenBelow(pane().rows, pane().view.current, viewHeight) > 0 ? 1 : 0);
  // A left press in the conversation's text rows (release 5 design, "Selecting"; release 5 plan, choice 6), the
  // selection already cleared: a click takes the pressed character, which a drag grows from; a double-click selects the
  // word, a triple-click the line, both copied on release. A double-click past a row's text, or a double or triple
  // click below the last line, clicks nothing: placeAt gives the row's end there, which on a wrapped row is the next
  // row's start.
  const pressAt = (top: number, x: number, y: number) => {
    const { rows } = pane();
    if (!rows.total) return;
    const at = Date.now();
    const count = clicks(lastPress.current, at, x, y);
    lastPress.current = { at, x, y, count };
    const cell = cellAt(rows, top + y, x);
    rerender((n) => n + 1);
    if (count === 1) return void (held.current = { press: span(rows, cell, cell), copy: false, top: y === 0 });
    const { pos, past } = placeAt(rows, cell.row, cell.x);
    if (top + y >= rows.total || (count === 2 && past)) return;
    const text = rows.lines[pos.line]!.text;
    const { start, end } = count === 2 ? wordAt(text, pos.offset) : { start: 0, end: text.length };
    const press: [Pos, Pos] = [
      { line: pos.line, offset: start },
      { line: pos.line, offset: end },
    ];
    selection.current = { press, end: span(rows, cell, cell) };
    held.current = { press, copy: true, top: y === 0 };
  };
  // A left press below the conversation (release 5 design, "Clicking"): on a prompt row the cursor goes to the place under
  // it, after the two columns of "› ", or to the row's end past it; a menu entry is chosen and Enter's path runs it, so a
  // `/` command runs and an `@` path fills in. The prompt's "↑ N rows above" and "↓ N rows below" rows, the menu's
  // "↑ N more" and "↓ N more", and every other row do nothing (release 5 plan, choice 10). The prompt during Ctrl+R's
  // search shows a match, not what is typed, so the frame gives it no prompt rows then. A click read with a key that
  // replaced the prompt or the menu's choice is dropped: React draws nothing between them, so the screen is still the one
  // from before the key. A click that acts starts the press-twice count again, as a key between the presses does.
  const clickAt = (x: number, y: number) => {
    const f = frame.current;
    if (editor.current !== f.editor || chosen.current !== f.chosen) return;
    const { columns, promptFirst, promptRows, promptWindow, menuRows } = f;
    const row = y - promptFirst; // a row of the prompt, then of the menu
    const marked = (i: number, shown: number, w: { above: number; below: number }) => (i === 0 && w.above > 0) || (i === shown - 1 && w.below > 0);
    const e = editor.current;
    if (row >= 0 && row < promptRows) {
      const { places } = layout(e.text, promptWidth(columns));
      if (marked(row, promptRows, promptWindow)) return;
      editor.current = move(e, placeOn(places, promptWindow.top + row, x - 2)!);
      goal.current = null;
    } else {
      const i = row - promptRows;
      if (i < 0 || i >= menuRows) return;
      const menu = menuFor(e); // after the rows are checked: for an `@` path it can list a folder again
      if (!menu) return;
      const w = windowOf(menu.entries.length, menuRows, chosenIn(e, menu), menuTop.current);
      if (marked(i, menuRows, w)) return;
      chosen.current = { text: e.text, at: w.top + i };
      run("submit");
    }
    forget();
    rerender((n) => n + 1);
  };
  // A drag while selecting grows the selection to the pointer's cell. Below the conversation the view first scrolls a row
  // for each report, so a selection can be longer than the screen (release 5 design, "Selecting"). The frame starts at
  // the terminal's top, so the pointer cannot go above the conversation: its top row stands for above it, for a drag
  // started lower down; one started on the top row selects within it and never scrolls (the user's choice, release 5).
  const dragTo = (h: Held, x: number, y: number) => {
    const { viewHeight } = frame.current;
    const p = pane();
    const up = y <= 0 && !h.top;
    if (y >= viewHeight || up) p.view.current = scrollBy(p.rows, p.view.current, viewHeight, up ? -1 : 1);
    const cell = cellAt(p.rows, firstRow(p.rows, p.view.current, viewHeight) + Math.max(0, Math.min(textRows(viewHeight) - 1, y)), x);
    selection.current = { press: h.press, end: span(p.rows, cell, cell) };
    h.copy = true;
    rerender((n) => n + 1);
  };

  // Scroll's actions come only in full screen, where Scroll is in force (contextsOf, above).
  const run = (c: Command) => {
    if (isScroll(c)) return scroll(c);
    const e = editor.current;
    const menu = menuFor(e);
    if (menu && (c === "up" || c === "down")) {
      chosen.current = { text: e.text, at: Math.max(0, Math.min(menu.entries.length - 1, chosenIn(e, menu) + (c === "up" ? -1 : 1))) };
      return;
    }
    if (menu && c === "submit") return menu.kind === "command" ? send(load(e, menu.entries[chosenIn(e, menu)]!.run!)) : fill(menu, e);
    if (c === "mode") {
      perm.current = cycle[(cycle.indexOf(perm.current) + 1) % cycle.length]!;
      onMode(perm.current);
      return show({ text: `mode is now ${perm.current}`, color: "gray" });
    }
    // Alt+P is `/model` typed then: during a turn it waits in the queue, and like Enter it goes to the bottom.
    if (c === "models") return command("/model");
    if (c === "lastTurn") return fullNow.current ? openDetail(lastTurn(session.messages)) : show(...lastTurn(session.messages)); // release 5 plan, Task 12
    if (c === "todos") return void (todos.current.hidden = !todos.current.hidden);
    // A message starting with `?` needs a space typed first.
    if (typeof c === "object" && c.type === "insert" && c.text === "?" && !e.text)
      return show(...keyList(table, contextsOf("prompt", fullNow.current), vimFirst(), launchKeys.current).map((text) => ({ text, color: "gray" })));
    if (c === "up" && !e.text && queue.current.length) return restore();
    if (c === "up" || c === "down") {
      const to = vertical(e.text, promptWidth(columns), e.cursor, c === "up" ? -1 : 1, goal.current);
      if (to) {
        editor.current = move(e, to.cursor);
        goal.current = to.goal;
      } else recall(c === "up" ? -1 : 1);
      return;
    }
    goal.current = null;
    if (c === "search") {
      search.current = { query: "", skip: 0, before: e };
      step.current = null;
    } else if (c !== "submit") editor.current = apply(e, c);
    // A backslash before Enter makes a new line in every terminal, in place of the backslash.
    else if (e.text.slice(0, e.cursor).endsWith("\\")) editor.current = apply(apply(e, "backspace"), "newline");
    else send(e);
  };

  // A key bound to command:<name>, and Alt+P's /model, run the command as if typed then, the prompt's text left as it
  // is: during a turn it waits in the queue (choice 21).
  const command = (text: string) => {
    if (working.current) return void queue.current.push({ text, spans: [] });
    view.current = FOLLOWING;
    void submit({ text, spans: [] });
  };
  // The prompt goes with its pictures' spans; prompt history keeps its text only (release 6 plan, Task 14).
  const send = (e: Editor) => {
    view.current = FOLLOWING; // sending a prompt goes to the bottom (release 5 design, "Scrolling")
    keep(e.text);
    editor.current = load(e, "");
    freshText();
    if (!working.current) void submit(e);
    else if (e.text.trim()) queue.current.push(trimmed(e));
  };
  // Ctrl-C during a turn, or Up on an empty prompt: the queue comes back into the prompt, one entry a
  // line, after what is there, to edit or send, with its pictures' spans.
  const restore = () => {
    if (!queue.current.length) return;
    const back = joined([editor.current, ...queue.current].filter((d) => d.text), "\n");
    editor.current = { ...load(editor.current, back.text), spans: back.spans };
    queue.current = [];
    freshText();
  };
  const clear = (e: Editor) => {
    keep(e.text);
    editor.current = load(e, "");
    freshText();
  };
  // Ctrl+S (release 6 design, "Stash"): a prompt with text goes into the slot whole, cursor and undo steps with it, and
  // an empty prompt takes the slot back; with text and a full slot the two swap, so nothing is lost (the design's
  // call). What the last delete took stays with the prompt, as load() keeps it. `typing: false`, so what is typed after
  // a restore is an undo step of its own, not part of the stashed prompt's last one. Where Up had got to goes with the
  // prompt and comes back with it, so the draft Up keeps is never dropped: after the line Up showed comes back, Down
  // past the newest brings the draft back (choice 31).
  const swapStash = (e: Editor) => {
    const back = stash.current;
    if (!e.text && !back) return;
    stash.current = e.text || step.current ? { prompt: e, step: step.current } : null;
    editor.current = back ? { ...back.prompt, typing: false, killed: e.killed } : load(e, "");
    goal.current = null;
    step.current = back?.step ?? null;
    freshText();
  };
  // Saved for Up and Ctrl+R, in this session and later ones: each sent prompt, and one cleared with
  // Ctrl-C or Esc Esc. The same prompt twice in a row is kept once, as Claude Code keeps it.
  const keep = (raw: string) => {
    const text = raw.trim();
    if (text && history.current!.entries.at(-1) !== text) void history.current!.add(text);
    step.current = null;
  };

  // Up from the prompt's first row steps back through the history, Down from its last row forward,
  // and past the newest prompt back to what was being typed. A prompt comes back with the cursor at
  // its end.
  const recall = (dir: -1 | 1) => {
    const { entries } = history.current!;
    const e = editor.current;
    const at = (step.current?.at ?? entries.length) + dir;
    goal.current = null;
    if (at < 0 || (!step.current && dir === 1)) return;
    freshText();
    if (at < entries.length) {
      step.current = { at, draft: step.current?.draft ?? { text: e.text, spans: e.spans } };
      editor.current = load(e, entries[at]!);
    } else {
      editor.current = { ...load(e, step.current!.draft.text), spans: step.current!.draft.spans };
      step.current = null;
    }
  };

  // The `/` or `@` menu for the prompt as it is, unless Esc closed it at this text. A folder is listed
  // again when the menu opens again, so it shows what is there then.
  const menuFor = (e: Editor): MenuData | null => {
    if (closed.current !== e.text) closed.current = null;
    if (search.current || closed.current !== null) return null;
    return commandMenu(e.text, e.cursor) ?? pathMenu(e.text, e.cursor, list);
  };
  const list = (folder: string) => {
    if (listed.current?.folder !== folder) listed.current = { folder, listing: listFolder(root, folder) };
    return listed.current.listing;
  };
  const chosenIn = (e: Editor, m: MenuData) => Math.min(chosen.current.text === e.text ? chosen.current.at : 0, m.entries.length - 1);
  // Tab, and Enter on a path: the chosen entry in place of what it completes.
  const fill = (m: MenuData, e: Editor) => {
    const entry = m.entries[chosenIn(e, m)]!;
    if (!entry.error) editor.current = replace(e, m.from, entry.fill);
  };

  // What the search shows in the prompt: the match, with the cursor at its end, or, with no match,
  // the prompt as it was.
  const shown = (): Editor => {
    const s = search.current!;
    const match = matches(history.current!.entries, s.query)[s.skip];
    return match === undefined ? s.before : load(s.before, match);
  };
  const endSearch = (e: Editor) => {
    search.current = null;
    editor.current = e;
    freshText();
  };
  // Ctrl+R's keys, as Claude Code's search has them (interactive-mode.md): typing searches, Ctrl+R
  // finds an older match, Enter sends the match, Tab or Esc puts it in the prompt to edit, and Ctrl-C,
  // or Backspace with nothing searched for, gives back what was typed before. In full screen the conversation behind
  // the search scrolls (the user's choice, release 5); in classic mode Scroll is not in force, and the scroll keys do
  // nothing here, as in release 4.
  const searchKey = (h: Now, got: Got, ch: string, key: Key) => {
    const s = search.current!;
    if (got && "typed" in got) return void Object.assign(s, { query: s.query + got.typed, skip: 0 });
    if (got && "pending" in got) return;
    const a = got?.action;
    if (a === "historySearch:cancel") return endSearch(s.before);
    if (a === "historySearch:accept") return endSearch(shown());
    if (a === "historySearch:next") return void (s.skip = Math.max(0, Math.min(s.skip + 1, matches(history.current!.entries, s.query).length - 1)));
    if (a === "historySearch:execute") {
      const e = shown();
      endSearch(e);
      return send(e);
    }
    if (a) return everywhere(a, h);
    for (const c of commands(ch, key)) {
      if (typeof c === "object") Object.assign(s, { query: s.query + c.text, skip: 0 });
      else if (c === "backspace" && !s.query) return endSearch(s.before);
      else if (c === "backspace") Object.assign(s, { query: [...s.query].slice(0, -1).join(""), skip: 0 });
      else if (c === "submit") {
        const e = shown();
        endSearch(e);
        return send(e);
      }
    }
  };

  // What the listeners set up once, at mount (the bus's, bindAsk's and the mouse's), call: the latest drawing's
  // functions, set at each, so what they read is the screen as last drawn, never what it was when they were set up
  // (release 6 design, "Tidying the screen code first"). Set while drawing, safe with Ink's non-concurrent root
  // (above).
  const handlers = { say, note, noteAlone, closeDetail, comeBack, next, lookUpWindow, onMouse, onSettings, onKeys, settle, dropChord: dropChords };
  const latest = useRef(handlers);
  latest.current = handlers;

  // The detail view drawn, which hides the prompt, its menu and what goes with them (release 5 plan, Task 12).
  const d = detail.current;
  const prompt = search.current ? shown() : editor.current;
  staleVim(); // while drawing too, for a change no key made (a picture's read ending), safe as `copied` below says
  const highlight = search.current ? undefined : visualSelection(vim.current, prompt);
  const menu = picker || question || d ? null : menuFor(prompt);
  if (menu?.kind !== "path") listed.current = null;

  // The hint line, under the prompt (release 3 design, "On screen"): whichever applies. `left` is the
  // rows left for the queue.
  const exitKey = first.current?.name === "Esc" ? undefined : first.current?.name;
  // The detail view's row naming its keys, or its search, stands in the hint row's place (release 5 plan, Task 12), as
  // the row over the status line; Ctrl+R's search waits under the view, and a model list queued as `/model` during a
  // turn, which takes the keys, takes the row away while it is open.
  // Each hint names the key bound to its action (keys.ts, named), in the words release 5 wrote; Ctrl-C and Ctrl-D are
  // reserved (bindings.ts, RESERVED), and written as release 5 wrote them. A chord's first strokes take the row first,
  // in the table's spelling, until the next key or 3 s (release 6 design, "The keys file"); then the exit warning, as
  // Ctrl-D twice exits from the detail view and Ctrl+R's search too (choice 19).
  const searching = !d && search.current && `search: ${visible(search.current.query)}${shown() === search.current.before ? " (no match)" : ""}`;
  const said = (key: string | undefined, words: string) => key !== undefined && `${key} ${words}`;
  const hints = (...parts: (string | false | null)[]) => parts.filter(Boolean).join(" · ");
  // Only a chord the keys drawn would go on with: none read at the prompt's side once a question is drawn, as a click on
  // the model list can bring one there with no key between (lookUp drops it at the next key; choice 32's code review).
  const chord = asked.current === (!!question && !picker) ? chordKeys().waiting(Date.now()) : null;
  const fillKeys = [keyOf("autocomplete:accept", "Autocomplete", "tab"), keyOf("chat:submit", "Chat", "enter")];
  const previous = keyOf("history:previous", "Chat", "up");
  // The last line of a live edit, with how many more it said, which the conversation shows (note, above).
  const notice = notes.current.at(-1);
  // One row, as the frame gives it (layout.ts, frame): a line break in it, such as in the file Node's JSON error quotes,
  // is one space here, the conversation keeping the line as said (choice 35's code review).
  const noticeText = notice && `${notice.text.replace(/\s*[\r\n]+\s*/g, " ")}${notes.current.length > 1 ? ` (+${notes.current.length - 1} more above)` : ""}`;
  const usualHint = (left: number) =>
    chord
      ? `${keyText(chord)} ...`
      : exitKey
      ? `Press ${exitKey} again to exit`
      : d && !picker
      ? keyRow(d, table)
      : searching
      ? hints(
          searching,
          said(keyOf("historySearch:next", "HistorySearch", "ctrl+r"), "older"),
          said(keyOf("historySearch:execute", "HistorySearch", "enter"), "send"),
          said(keyOf("historySearch:accept", "HistorySearch", "tab"), "edit"),
          "Ctrl-C cancel",
        )
        : picker || question
          ? null
          : menu
            ? hints(
                said(both(keyOf("autocomplete:previous", "Autocomplete", "up"), keyOf("autocomplete:next", "Autocomplete", "down")), "choose"),
                ...(menu.kind === "command"
                  ? [said(fillKeys[0], "fill"), said(fillKeys[1], "run")]
                  : [said(fillKeys.filter(Boolean).join(" or ") || undefined, "fill")]),
                said(keyOf("autocomplete:dismiss", "Autocomplete", "escape"), "close"),
              )
            : reads.current
            ? "Reading picture..." // over the queue's and the stash's hints, for the moment it lasts (release 6 design, "Pictures")
            : queue.current.length
            ? left > 0 && previous
              ? `${previous} to edit queued messages`
              : `${queue.current.length} queued`
            : stash.current
              ? // during a turn too, no other hint taking the row (release 6 plan, Task 13)
                hints("Stashed", said(keyOf("chat:stash", "Chat", "ctrl+s"), "to bring back"))
              : noticeText
                ? noticeText // over vim's mode too, until a key (choice 35, the user's: "Notice wins")
                : vim.current
                  ? `-- ${vim.current.mode} --` // every mode, in a turn too, when no other hint takes the row (choice 15)
                  : busy
                    ? null
                    : "? for shortcuts";
  // The line about the last copy, until the next key or click (release 5 design, "Copying"), takes the hint row's place
  // only while one shows, so a copy never moves the conversation; a failed copy shows anyway, adding the row. Ctrl+R's
  // search and the exit warning keep the row (the user's choice, release 5), and so does the detail view's search while
  // it is typed, as Ctrl+R's does. A failure on a terminal too short for a hint row waits until one fits.
  const hintFor = (left: number) => {
    const usual = usualHint(left);
    const c = copied.current;
    return c === null || searching || d?.search?.typing || exitKey || (!c.failed && usual === null) ? usual : c.text;
  };

  // The frame's rows (layout.ts, frame), from what is drawn: the prompt as shown, Ctrl+R's match while it searches. The
  // model list has no tool line under it. In full screen it needs its rows unfiltered, the longest it gets, with its "No
  // models" line when it has no models, in a box that tall, so the status line stays put while typing filters the list.
  // A question's line is wrapped and drawn a row a Text in full screen, so its rows are known; the line it moves to when
  // too long to fit is its short one, below.
  // A question names the launch's keys, the ones that answer it (lookUp; choice 32).
  const allow = (what: string, plain?: boolean) => {
    const answer = (action: string, usual: string) => named(launchKeys.current, action, "Confirmation", [usual])[0];
    const yes = answer("confirm:yes", "y") ?? "";
    const no = answer("confirm:no", "n") ?? "";
    return hints(
      `${plain ? "" : "Allow "}${what}? [${yes}/${no}]`,
      said(answer("confirm:no", "escape"), "to decline"),
    );
  };
  const shortOf = (q: Question) => `${q.label} (shown above)`;
  const laid = layout(prompt.text, promptWidth(columns));
  const offered = full && picker ? listRows(picker, "") : [];
  const movable = full && question && !picker && !question.short; // a question that can still move into the conversation
  const f = frameOf({
    rows: height,
    columns,
    full,
    promptRows: laid.rows.length,
    cursorRow: laid.places.get(prompt.cursor)!.row,
    promptTop: promptTop.current,
    working: busy,
    toolLine: !picker && shownSegments.includes("tools") && calls.current.length > 0,
    detail: d !== null,
    hint: hintFor(1) !== null, // whether there is a hint does not depend on the rows left (usualHint)
    menu: menu ? menu.entries.length : null,
    taskRows: (rows) => taskRows(tasks.all, rows, now),
    todoRows: (rows) => (!todos.current.hidden && unfinished(todos.current.items) ? todoRows(todos.current.items, rows) : []),
    queued: queue.current.length,
    pickerNeeded: picker ? offered.length + (offered.some((r) => r.kind === "model") ? 0 : 1) : null,
    question: question !== null,
    askedText: full && question && !picker ? allow(question.short ?? question.text, question.plain) : null,
    askedShort: movable ? allow(shortOf(question), question.plain) : null,
  });
  const { tooled, menuRows, panel, promptSpace, promptShown, todoShown, pickerRows, viewHeight, promptFirst } = f;
  const q = queue.current.map((e) => visible(e.text));
  const shownQueued = f.queuedShown;
  const queued = q.length <= shownQueued ? q : shownQueued > 0 ? [...q.slice(0, shownQueued - 1), `+${q.length - shownQueued + 1} more`] : [];
  const hint = f.hinted ? hintFor(f.left) : null;
  // A successful copy's line that is not on screen is dropped, so it never turns up later, when a hint row comes back; only
  // a failure waits to be shown (the user's choice, release 5). Changed while drawing, which is safe as Ink renders
  // with React's non-concurrent root (ink.js, `concurrent` defaults to false); a concurrent root could drop or mark
  // shown a line it never drew.
  if (copied.current && !copied.current.failed && hint !== copied.current.text) copied.current = null;
  if (copied.current && hint === copied.current.text) copied.current.shown = true; // from now the next key or click takes it away

  // A question too long to fit, whose rows would leave the conversation less than its one row, has its line point above
  // instead (the user's choices, release 5): at a write's preview, whose heading holds the whole path, or else at all
  // of its text, put in the conversation under a heading as a preview is. Nothing of a command is ever cut
  // (permissions.ts, visible), and the placement below brings it into view, to scroll through before answering. Checked
  // on every draw, as a resize can leave a question too long; once moved it stays, and its heading counts characters, as
  // a copy's line does, which no resize makes wrong. A question that fits is drawn as before. Said while drawing, as
  // `copied` above: React draws the App again at once for the lines it adds. On a very small terminal (20 by 5, say) the
  // short line can itself wrap past the frame: the limit any live area has there.
  const moved = movable && !f.questionFits;
  if (moved) {
    if (!question.detail) {
      const n = characters(question.text);
      const from = kept.lines.length;
      say({ text: `┌ ${question.label} (${n} character${n === 1 ? "" : "s"})`, color: "gray" }, { text: question.text, color: "gray" });
      question.detail = [from, kept.lines.length - 1];
    }
    question.short = shortOf(question);
  }
  // A question brings its own detail into view when it is first drawn (release 5 design, "Scrolling"; release 5 plan,
  // Task 11), and when a draw moves it into the conversation, above; here, with the height the conversation has beside
  // it; changed while drawing, as `copied` above. Whether the view was following is kept from the first draw. Its
  // detail's last row goes on the view's second-last row, the last kept for "↓ N new lines", when its rows fit above
  // that; otherwise its heading goes on the top row. The view is held there, never moved to the bottom (view.ts,
  // first), so what arrives while the question waits does not move it, and the lines already below the detail (a reply,
  // an earlier answer) are counted as unseen. A question without a detail leaves the view (release 5 plan, choice 11).
  if (full && question && !picker && (question.following === undefined || moved)) {
    if (question.following === undefined) question.following = view.current.at === null;
    if (question.detail) {
      const [from, to] = question.detail;
      const head = kept.rowOf({ line: from, offset: 0 });
      const end = kept.rowOf({ line: to, offset: kept.lines[to]!.text.length });
      const r = kept.row(end - head + 1 <= viewHeight - 1 ? Math.max(0, end - (viewHeight - 2)) : head); // 2: the last two rows
      view.current = { at: { line: r.line, offset: r.start }, unseen: kept.lines.length - 1 - to };
    }
  }
  frame.current = {
    columns,
    viewHeight,
    promptFirst,
    promptRows: picker || question || search.current || d ? 0 : promptShown,
    promptWindow: f.promptWindow,
    menuRows,
    editor: editor.current,
    chosen: chosen.current,
    detail: d,
    picker: picker !== null,
    question: question !== null,
  };
  // Where vim takes Esc first (vimFirst) the line names it twice; a key chat:cancel has with Ctrl or Alt never goes to
  // vim (choice 31).
  const stop = keyOf("chat:cancel", "Chat", "escape");
  const escFirst = vimFirst() && table.keysFor("chat:cancel", "Chat").includes("escape");
  const workingLine = busy && (
    <WorkingLine
      label={doing.current.label}
      stop={escFirst ? `${stop} ${stop}` : stop}
      ms={Math.max(0, now - doing.current.at)}
      spend={
        doing.current.from && {
          lead: session.lead.id,
          output: stats.output - doing.current.from.output,
          cost: stats.cost - doing.current.from.cost,
          costUnknown: stats.unpriced > doing.current.from.unpriced,
        }
      }
    />
  );

  if (switching) return null; // going to classic: nothing is drawn until Ink has resumed on the normal screen (/screen)
  return (
    <>
      {full && d ? (
        <DetailView detail={d} height={viewHeight} selection={selected()} />
      ) : full ? (
        <Conversation
          rows={kept}
          first={firstRow(kept, view.current, viewHeight)}
          height={viewHeight}
          unseen={unseenBelow(kept, view.current, viewHeight)}
          following={view.current.at === null}
          selection={selected()}
          bottom={keyOf("scroll:bottom", "Scroll", "ctrl+end")}
        />
      ) : (
        <Static items={printUpTo.current === null ? lines : lines.slice(0, printUpTo.current)}>
          {(l) => (
            <Text key={l.id} color={l.color} wrap={l.oneLine ? "truncate-end" : "wrap"}>
              {l.text}
            </Text>
          )}
        </Static>
      )}
      {picker ? (
        full ? (
          <Box flexDirection="column" height={pickerRows + 1} justifyContent="flex-end">
            <ModelPicker
              groups={picker}
              current={session.lead.id}
              onPick={pick}
              onClose={closePicker}
              keys={pickerKey}
              bindings={table}
              maxRows={pickerRows}
              mouse={mouse}
              bottom={viewHeight + pickerRows} // the box's last row
            />
          </Box>
        ) : (
          <ModelPicker groups={picker} current={session.lead.id} onPick={pick} onClose={closePicker} keys={pickerKey} bindings={table} />
        )
      ) : question ? (
        full ? (
          f.asked.map((r, i) => (
            <Text key={i} color="yellow" wrap="truncate-end">
              {r}
            </Text>
          ))
        ) : (
          <Text color="yellow">{allow(question.text, question.plain)}</Text>
        )
      ) : d ? (
        workingLine // the working line stays under the detail view while a turn runs (release 5 plan, choice 12)
      ) : (
        <>
          {workingLine}
          <TodoList rows={todoShown} />
          {queued.map((row, i) => (
            <Text key={i} color="gray" wrap="truncate-end">
              {row}
            </Text>
          ))}
          <Prompt
            editor={prompt}
            columns={columns}
            offset={promptFirst}
            space={promptSpace}
            top={promptTop}
            selected={highlight}
          />
          {menu && <Menu entries={menu.entries} chosen={chosenIn(prompt, menu)} rows={menuRows} top={menuTop} />}
          <TaskPanel rows={panel} />
        </>
      )}
      {hint && (
        // A live edit's line keeps its own colour, and a long one gives up its middle, not its count (choice 35).
        <Text
          dimColor={!notice || hint !== noticeText}
          color={notice && hint === noticeText ? notice.color : undefined}
          wrap={notice && hint === noticeText ? "truncate-middle" : "truncate-end"}
        >
          {hint}
        </Text>
      )}
      <StatusLine
        segments={shownSegments}
        info={{
          lead: session.lead.id,
          context: stats.context,
          contextWindow,
          input: stats.input,
          output: stats.output,
          cost: stats.cost,
          costUnknown: stats.costUnknown,
          mode: perm.current,
          errors: stats.errors,
          project,
          branch,
          elapsed: now - started.current,
          running: tasks.running,
        }}
      />
      {tooled && <ToolLine calls={calls.current} />}
    </>
  );
}
