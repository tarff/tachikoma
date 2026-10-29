import { useApp, useWindowSize } from "ink";
import { useRef, useState } from "react";
import { type Mode, visible } from "../../core/permissions.js";
import type { Effort } from "../../providers/anthropic.js";
import type { ModelGroup } from "../../providers/models.js";
import type { TodoItem } from "../../tools/todo.js";
import type { AppProps, Fns } from "../App.js";
import { Bindings, type Context, DEFAULTS, tableOf } from "../bindings.js";
import type { Clipboard } from "../clipboard.js";
import type { Line } from "../describe.js";
import type { Detail } from "../DetailView.js";
import { type Editor, empty } from "../editor.js";
import type { History } from "../history.js";
import { named } from "../keys.js";
import type { Listing } from "../menus.js";
import type { PickerKey } from "../ModelPicker.js";
import { TerminalOwner } from "../owner.js";
import { now as nowOf, phaseInputs } from "../phase.js";
import { type Draft, Pictures } from "../pictures.js";
import type { Call } from "../ToolLine.js";
import { FOLLOWING, type Pos, Rows, type View } from "../view.js";
import { type Vim, start as vimStart } from "../vim.js";
import type { Held, Printed, Question } from "./constants.js";

export function useAppState({
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
  // The lines said in classic mode since `kept` last took them: going to full screen adds them (/screen, App.tsx), so `kept`
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
  // /model that ended while printed out, until the view is back (comeBack, App.tsx).
  const dropping = useRef<Printed | null>(null);
  const waitingList = useRef<ModelGroup[] | null>(null);
  const ended = useRef(false); // Ink has unmounted the App (the cleanup in App.tsx)
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
  // switch starts, `full` following (switchScreen, App.tsx), and a drawing's functions can run after a later drawing:
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
  // The message waiting for its pictures' reads to end before it is sent, as the reads leave it (perform, App.tsx).
  const reading = useRef<Draft | null>(null);
  const reads = useRef(0); // the pictures' reads running, for the hint row's "Reading picture..." (newPicture, pictureReads.ts)
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
  const printUpTo = useRef<number | null>(null); // while an editor has the terminal in classic mode (away, App.tsx)
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
  // A live edit's lines (onSettings, onKeys) show in the hint row too, until the next key (release 6 plan, choice 35,
  // the user's: "Hint row, until a key"): the last edit's lines, said in the conversation as ever, and whether the next
  // line starts a new edit's, which replaces them. One said later for the same edit, a lead or a screen that waited for
  // a turn to end, joins them.
  const notes = useRef<Line[]>([]);
  const newEdit = useRef(true);
  const history = useRef<History | null>(null);
  const running = tasks.running > 0;
  // What is happening now (phase.ts), from the refs only, the model list and the question as last drawn among them
  // (`frame`), so the mouse listener and the bus's handlers, set up once, read the screen as it is. Keys see the same as
  // this drawing's values: Ink's root is non-concurrent (above), so React draws and commits in one go, and useInput's and
  // usePaste's handler is the committed drawing's (useEffectEvent). Only the keys and the wheel ask for the menu, where
  // it was found before: finding an `@` menu can list a folder (menuFor). A paste asks pasteTo() of the same inputs.
  const phaseRefs = { ended, printed, drawn: frame, listOpen, questions, detail, search, working, queue };
  const happening = (findMenu?: () => boolean) => nowOf(phaseInputs(phaseRefs, findMenu));
  // What the functions read that the drawing works out after making them, filled in by it (App.tsx): the
  // conversation's height, and the latest drawing's functions for the one of them that calls through them.
  const drawn = {} as { viewHeight: number; latest: { readonly current: Pick<Fns, "settle"> } };
  // Each read-only, so a check stored in a const narrows it, as it narrowed App's own consts (the question, `movable`).
  return {
    session, tasks, bus, stats, mode, onMode, project, root, gitBranch, historyFile, intro, errorFile, segments,
    makeProvider, bindAsk, login, listModels, screen, fullPossible, mouse, scrollSpeed, clipboard, input, bindings,
    home, live, picturesGiven, readPicture, exit, suspendTerminal, lines, setLines, editor, goal, vim, vimText, first,
    table, setTable, chordTimer, keyOf, pickerKey, step, search, stash, chosen, closed, listed, columns, height, full,
    setFull, switching, setSwitching, kept, unkept, view, detail, pane, printed, dropping, waitingList, ended, owner,
    fullNow, frame, promptTop, menuTop, wheel, grab, selection, held, lastPress, copied, busy, setBusy, working, queue,
    pictures, reading, reads, doing, calls, todos, perm, cycle, questions, question, contextWindow, setContextWindow,
    picker, setPicker, listOpen, announced, rerender, board, clearCopied, started, now, setNow, branch, setBranch,
    abort, nextId, printUpTo, lookups, shownSegments, setSegments, speed, setSpeed, fileNow, warned, effortNow, waiting,
    leadFromFile, keysWarned, keysRead, launchKeys, launched, asked, notes, newEdit, history, running, phaseRefs,
    happening, drawn,
  } as const;
}

// What every area reads: the props and the state of one drawing (App.tsx, fns).
export type UI = ReturnType<typeof useAppState>;
