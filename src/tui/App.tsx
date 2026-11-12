import path from "node:path";
import { Box, Static, Text, useInput, usePaste } from "ink";
import { useEffect, useRef } from "react";
import { checkOffLine, type Given, type WindowSessions } from "../clilib.js";
import type { Bus, ErrorEvent, Events } from "../core/bus.js";
import { type Ask, type Mode, type Protection, visible } from "../core/permissions.js";
import type { Session } from "../core/session.js";
import type { Stats } from "../core/stats.js";
import type { Tasks } from "../core/tasks.js";
import { errorText, type Message, type Provider } from "../core/types.js";
import type { Workspace } from "../exec/workspace.js";
import type { Hooks } from "../hooks/hooks.js";
import { KEYBINDINGS } from "../keybindings.js";
import type { ServerConfig } from "../mcp/config.js";
import type { Servers } from "../mcp/servers.js";
import type { ModelGroup } from "../providers/models.js";
import type { UserRules } from "../safety/rules.js";
import type { Shell } from "../safety/split.js";
import { SETTINGS, type Settings, shownFile } from "../settings.js";
import { watchSettings } from "../settingsWatch.js";
import type { TodoItem } from "../tools/todo.js";
import { characters, FROM, gray, isFile, type Question, SHORTEN_WORDS, STOPPING, visualSelection } from "./app/constants.js";
import { handover } from "./app/handover.js";
import { keyRouting } from "./app/keyRouting.js";
import { liveEdits } from "./app/liveEdits.js";
import { mouse } from "./app/mouse.js";
import { output } from "./app/output.js";
import { pictureReads } from "./app/pictureReads.js";
import { promptKeys } from "./app/promptKeys.js";
import { queue } from "./app/queue.js";
import { useAppState } from "./app/state.js";
import { type Bindings, keyText } from "./bindings.js";
import { type Clipboard, imagePaths } from "./clipboard.js";
import { Conversation } from "./Conversation.js";
import { brief, describe, type Line, screen as escaped } from "./describe.js";
import { DetailView, keyRow, searchFor } from "./DetailView.js";
import { Field } from "./Field.js";
import { History } from "./history.js";
import type { Mouse } from "./input.js";
import { both, named } from "./keys.js";
import { frame as frameOf, layout } from "./layout.js";
import { ACTIONS, McpList } from "./McpList.js";
import { Menu } from "./Menu.js";
import { ModelPicker, rows as listRows } from "./ModelPicker.js";
import type { Hand } from "./owner.js";
import { pasteTo, phaseInputs } from "./phase.js";
import type { Pictures, Read } from "./pictures.js";
import { Prompt, promptWidth } from "./Prompt.js";
import { Review, type ReviewCopy } from "./Review.js";
import { SessionList } from "./SessionList.js";
import { type Segment, StatusLine } from "./StatusLine.js";
import { TaskPanel, taskRows } from "./TaskPanel.js";
import type { Screen } from "./terminal.js";
import { TodoList, todoRows, unfinished } from "./TodoList.js";
import { ToolLine } from "./ToolLine.js";
import { first as firstRow, FOLLOWING, unseenBelow } from "./view.js";
import { SPIN_MS, WorkingLine } from "./WorkingLine.js";

export interface AppProps {
  session: Session;
  tasks: Tasks; // the lead's subagents
  bus: Bus;
  stats: Stats;
  mode: Mode; // the mode the session started in
  onMode: (mode: Mode) => void; // Shift+Tab: the mode the permission check uses from the next action
  // A live edit of settings.json's "dangerousCommands" that tightens the check: the rules it uses from the next action
  // (release 7 plan, Task 4).
  onRules: (rules: UserRules) => void;
  project: string; // the project folder's name, for the status line
  root: string; // the project folder, where `@` paths start
  workspace: Workspace; // the project's files, for the branch (release 7 plan, Task 14)
  branch: string | null; // the git branch at the start, read before the first frame; read again after each turn
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
  // `networkLine`: the launch's line saying --network was ignored without the sandbox, if it said one (clilib.ts);
  // `gitLine`: the one saying git's settings could not be read, escaped (cli.tsx; release 7 plan, Task 8); `bashLine`: the
  // one saying Git Bash was not found for the hooks run by a shell (release 8b plan, choice 2).
  live?: { loaded: { settings: Settings; warnings: string[] }; given: Given; networkLine?: string; gitLine?: string; bashLine?: string };
  // The session's pictures (pictures.ts; release 6 plan, choice 9); the App makes its own when not given. Tests give
  // one to end its reads.
  pictures?: Pictures;
  // chat:imagePaste's read of the clipboard's picture, null where there is no reader; the system's reader when not
  // given (clipboard.ts, imageReader). Tests give a stand-in, so none reads the user's clipboard.
  readPicture?: (() => Promise<Read>) | null;
  // Copy mode (release 7 plan, Task 21; queue.ts, leave): the copy the session works on; `stop` removes its box, true
  // once Docker reports it gone; `protection` is worked out on the host when the review opens, never the gate's view of
  // the box, and when it throws the review does not open; `ended` takes the lines to print once Ink has ended. Without
  // it, leaving only exits.
  copy?: {
    copy: ReviewCopy;
    stop: () => Promise<boolean>;
    protection: () => Promise<Protection>;
    ended: (lines: string[]) => void;
    remove?: (folder: string) => Promise<void>; // a test's stand-in for removeCopy (choice 121; copies.ts, dropIfNothing)
  };
  // The window's saved sessions (clilib.ts, WindowSessions), which /clear, /resume and /branch switch between and /rename
  // names (release 8a plan, Task 7).
  saved: WindowSessions;
  // Takes the lines SessionEnd's hooks said as the user left where the window could not show them, in full screen or copy
  // mode, escaped, to print once Ink has ended (queue.ts, leave; release 8b plan, Task 10).
  leftLines?: (lines: string[]) => void;
  // The user's hooks, the session's and its subagents' (cli.tsx), for Ctrl+O's runs, /hooks and live edits (release 8b plan,
  // Task 12); without them, as in most tests, /hooks has none in force.
  hooks?: Hooks;
  // The MCP servers (cli.tsx), for /mcp and live edits of "mcpServers", with the project's from .mcp.json, which is read
  // at the launch only (release 8c plan, Tasks 2 and 10); without them, as in most tests, /mcp has none.
  mcp?: { servers: Servers; project: ServerConfig[] };
  // The shell the shell tool runs in (split.ts, shellOf), by which its commands' rows fold (release 8c plan, Task 15); the
  // host's when not given.
  shell?: Shell;
}

type OutputArea = ReturnType<typeof output>;
type QueueArea = ReturnType<typeof queue>;
type PictureReadsArea = ReturnType<typeof pictureReads>;
type HandoverArea = ReturnType<typeof handover>;
type LiveEditsArea = ReturnType<typeof liveEdits>;
type KeyRoutingArea = ReturnType<typeof keyRouting>;
type MouseArea = ReturnType<typeof mouse>;
type PromptKeysArea = ReturnType<typeof promptKeys>;
// The type of `fns` (App, below), made from each area's own functions. An interface, not a type alias: every area's
// `fns` names it, and with an alias the type checker would need the areas' types to work out this one, and this one
// to work out theirs (TS2456).
export interface Fns {
  say: OutputArea["say"]; show: OutputArea["show"]; note: OutputArea["note"]; noteAlone: OutputArea["noteAlone"];
  endRun: OutputArea["endRun"]; make: OutputArea["make"]; lookUpWindow: OutputArea["lookUpWindow"];
  submit: QueueArea["submit"]; next: QueueArea["next"]; recordToOpen: QueueArea["recordToOpen"]; leave: QueueArea["leave"];
  perform: QueueArea["perform"]; tasksCommand: QueueArea["tasksCommand"]; recordOf: QueueArea["recordOf"];
  pick: QueueArea["pick"]; closePicker: QueueArea["closePicker"]; subagentsRunning: QueueArea["subagentsRunning"];
  startFresh: QueueArea["startFresh"]; resume: QueueArea["resume"];
  pickSession: QueueArea["pickSession"]; closeSessions: QueueArea["closeSessions"]; branch: QueueArea["branch"];
  rename: QueueArea["rename"]; exportTo: QueueArea["exportTo"]; mcpAction: QueueArea["mcpAction"]; closeMcp: QueueArea["closeMcp"];
  readsEnded: PictureReadsArea["readsEnded"]; stopReads: PictureReadsArea["stopReads"];
  settle: PictureReadsArea["settle"]; newPicture: PictureReadsArea["newPicture"];
  imagePaste: PictureReadsArea["imagePaste"]; pastePictures: PictureReadsArea["pastePictures"];
  unselect: HandoverArea["unselect"]; openDetail: HandoverArea["openDetail"]; closeDetail: HandoverArea["closeDetail"];
  printOut: HandoverArea["printOut"]; reader: HandoverArea["reader"]; comeBack: HandoverArea["comeBack"];
  switchScreen: HandoverArea["switchScreen"]; away: HandoverArea["away"]; editorFailed: HandoverArea["editorFailed"];
  externalEditor: HandoverArea["externalEditor"]; openFile: HandoverArea["openFile"];
  onSettings: LiveEditsArea["onSettings"]; onKeys: LiveEditsArea["onKeys"]; applyEntry: LiveEditsArea["applyEntry"];
  fileLead: LiveEditsArea["fileLead"]; setVim: LiveEditsArea["setVim"];
  route: KeyRoutingArea["route"]; lookUp: KeyRoutingArea["lookUp"]; chordKeys: KeyRoutingArea["chordKeys"];
  dropChords: KeyRoutingArea["dropChords"]; pressed: KeyRoutingArea["pressed"]; onInput: KeyRoutingArea["onInput"];
  onKey: KeyRoutingArea["onKey"]; everywhere: KeyRoutingArea["everywhere"]; twice: KeyRoutingArea["twice"];
  promptKey: KeyRoutingArea["promptKey"]; vimTakes: KeyRoutingArea["vimTakes"]; staleVim: KeyRoutingArea["staleVim"];
  vimFirst: KeyRoutingArea["vimFirst"]; dropRemap: KeyRoutingArea["dropRemap"]; freshText: KeyRoutingArea["freshText"];
  detailKey: KeyRoutingArea["detailKey"]; remember: KeyRoutingArea["remember"]; forget: KeyRoutingArea["forget"];
  scroll: MouseArea["scroll"]; selected: MouseArea["selected"]; copy: MouseArea["copy"]; onMouse: MouseArea["onMouse"]; toggleFold: MouseArea["toggleFold"];
  cellAt: MouseArea["cellAt"]; textRows: MouseArea["textRows"]; pressAt: MouseArea["pressAt"];
  clickAt: MouseArea["clickAt"]; dragTo: MouseArea["dragTo"];
  run: PromptKeysArea["run"]; command: PromptKeysArea["command"]; send: PromptKeysArea["send"];
  restore: PromptKeysArea["restore"]; giveBack: PromptKeysArea["giveBack"]; putBack: PromptKeysArea["putBack"];
  clear: PromptKeysArea["clear"]; swapStash: PromptKeysArea["swapStash"];
  keep: PromptKeysArea["keep"]; recall: PromptKeysArea["recall"]; menuFor: PromptKeysArea["menuFor"];
  list: PromptKeysArea["list"]; chosenIn: PromptKeysArea["chosenIn"]; fill: PromptKeysArea["fill"];
  shown: PromptKeysArea["shown"]; endSearch: PromptKeysArea["endSearch"]; searchKey: PromptKeysArea["searchKey"];
}

export function App(props: AppProps) {
  const ui = useAppState(props);
  // Every area's functions, made again at each drawing, as App's own were: each reads this drawing's `ui` and calls
  // the others through this drawing's `fns`, so a function keeps the drawing it was made in (state.ts, fullNow).
  const fns = {} as Fns;
  Object.assign(
    fns,
    output(ui, fns),
    queue(ui, fns),
    pictureReads(ui, fns),
    handover(ui, fns),
    liveEdits(ui, fns),
    keyRouting(ui, fns),
    mouse(ui, fns),
    promptKeys(ui, fns),
  );
  ui.history.current ??= new History(ui.historyFile, (line) => fns.say({ text: line, color: "magenta" }));

  useEffect(() => {
    ui.bindAsk((text, detail, owner, plain, warnings, note, oneRow) => {
      // A tool still finishing after Ctrl-C must not ask about a turn the user has stopped, nor a
      // stopped subagent about anything.
      const signal = owner ? owner.signal : ui.abort.current?.signal;
      if (signal?.aborted) return Promise.resolve(false);
      // The lead's own question comes from its call running now, the last to start: delegate's calls, which ask only
      // through their subagents, start before the rest (session.ts; release 7 plan, choice 66).
      const asking = owner || plain ? undefined : ui.calls.current.at(-1);
      const call = asking && !asking.outcome ? asking.id : undefined;
      // A question ends the open run of quiet calls before anything of its own is said, the asked call taken out of it for
      // a row of its own (release 8c plan, choice 65).
      latest.current.endRun(call);
      // In the scrollback, not the prompt: a whole file would not fit in the part Ink redraws.
      // Grey, under a heading, so file text cannot pass for the conversation or the interface.
      let range: [number, number] | undefined;
      if (detail !== undefined) {
        const lines = detail ? detail.replace(/\r?\n$/, "").split("\n").length : 0; // as read_file counts them
        const from = ui.kept.lines.length;
        latest.current.say({ text: `┌ ${text} (${lines} line${lines === 1 ? "" : "s"})`, color: "gray" }, { text: detail || "(empty)", color: "gray" });
        if (ui.fullNow.current) range = [from, ui.kept.lines.length - 1];
      }
      return new Promise((resolve) => {
        let open = true; // answered once: two keys arriving together would otherwise both be logged
        // When its owner stops (Esc or Ctrl-C for the lead's turn, /tasks stop, a failure), the
        // question goes from the line, on screen or not, answered as cancelled.
        const cancel = () => q.answer(false, plain ? "cancelled" : "This was cancelled.");
        // A subagent's plain question, only an MCP server's visit request (release 8c plan, Task 12's re-check), names the
        // subagent itself, its id first, so it is not named again here; its owner still stops and cancels it.
        const named = owner && !plain;
        const q: Question = {
          text: named ? `${visible(owner.name)} to ${text}` : text,
          // A subagent's name is its id, then its description in brackets (tasks.ts); a summary starts with its action:
          // "run: …", "write …", "read …".
          label: `${named ? `${visible(owner.name.split(" ", 1)[0]!)} to ` : ""}${text.split(/[\s:]/, 1)[0]}`,
          ...(owner ? { owner } : {}),
          ...(range ? { detail: range } : {}),
          ...(plain ? { plain } : {}),
          warnings: warnings ?? [],
          ...(note !== undefined ? { note } : {}), // auto mode's pause, a row of the question's own (release 7 plan, Task 10)
          ...(note !== undefined && oneRow ? { oneRow: true as const } : {}),
          ...(call !== undefined ? { call } : {}),
          answer: (ok, how) => {
            if (!open) return;
            open = false;
            signal?.removeEventListener("abort", cancel);
            const typedAt = ui.questions.current[0] === q && ui.asked.current;
            ui.questions.current = ui.questions.current.filter((x) => x !== q);
            // As at the opening (below): a chord half typed at the question on screen, which one cancelled can leave,
            // never runs on into the next question's keys nor the live ones (choice 32 and its code review). A chord
            // waiting was typed there exactly when it is the first in the line and the last key was read at a
            // question (lookUp, `asked`), the model list open over it since or not. One waiting behind it, cancelled,
            // leaves the chord to the question on screen (the outside review's second round); one under the model
            // list, a chord typed in the list to the list's keys (the code re-checks).
            if (typedAt) latest.current.dropChord();
            if (q.detail && q.following) ui.view.current = FOLLOWING; // otherwise the view stays (release 5 design, "Scrolling")
            // A permission's answer is one line (release 7 plan, choice 66): under its call's tool line while that is still
            // the conversation's last line, and otherwise naming what it answers, as a subagent's does, a write's after its
            // preview and one that waited in the line. Each danger follows it, the whole line red then. A declined call's
            // result row is left out under its tool line, as this line says it, and is otherwise the answer alone, so the
            // results keep their places in call order (choice 67); the model is still told its full message. A plain
            // question keeps its own record.
            if (q.plain) latest.current.say({ text: `${q.short ?? q.text}: ${how}`, color: "gray" });
            else {
              const said = [how, ...q.warnings].join(" ");
              const under = q.call !== undefined && ui.toolLine.current === q.call;
              if (!ok && q.call !== undefined) ui.answered.current.set(q.call, under ? null : how);
              latest.current.say({ text: under ? `  ⎿ ${said}` : `${q.short ?? q.text}: ${said}`, color: q.warnings.length ? "red" : "gray" });
            }
            resolve(ok);
            ui.rerender((n) => n + 1);
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
        if (!ui.questions.current.length) latest.current.dropChord();
        ui.questions.current.push(q);
        ui.rerender((n) => n + 1);
        // Printed out, the view comes back at once, as on q, and the question shows (release 5 plan, Task 13).
        void latest.current.comeBack();
      });
    });
    // A message ending in its one tool call with a row of its own leaves that call's tool line the last said, for its
    // question's answer to go under (release 7 plan, choice 66). With more such calls than one, none does: an earlier call
    // that asks nothing prints nothing before the last one's question, and its result comes first, so each answer names its
    // call and each result keeps its place (choice 67). The quiet calls go to the open run, saying nothing and no result
    // row until their row is said (release 8c plan, Task 15), so they come between nothing. An answered call's id is let go
    // with its result, as a provider may use an id again.
    const onMessage = (m: Message) => {
      latest.current.say(...describe(m, ui.answered.current, ui.run));
      for (const p of m.parts) if (p.type === "tool_result") ui.answered.current.delete(p.callId);
      const last = m.parts.at(-1);
      const rows = m.parts.filter((p) => p.type === "tool_call" && ui.run.own(p));
      if (last?.type === "tool_call" && rows.length === 1 && rows[0] === last) ui.toolLine.current = last.id;
    };
    // Each line said here, outside describe, ends the open run of quiet calls first, so the calls before it are said above
    // it (release 8c plan, Task 15's quality review); a failed call's error event says nothing, its result row coming next.
    const onError = (e: ErrorEvent) => {
      if (e.kind !== "tool") latest.current.endRun();
      if (e.kind === "tool") ui.rerender((n) => n + 1);
      else if (e.kind === "fallback") latest.current.say({ text: `↪ ${e.message}`, color: "magenta" });
      // Its line names what failed, so it goes without a label (release 8a plan, Task 5; user, 2026-11-06), as a
      // shortening's does (Task 12), and a hook's (release 8b plan, choice 22), whose line is escaped whole, as its grey
      // lines are (onHookNote).
      // An MCP failure's line names its server too (release 8c plan, choice 26), and is escaped whole, as it carries what
      // the server or the system said.
      else if (e.kind === "hook" || e.kind === "mcp") latest.current.say({ text: `✗ ${visible(e.message, { tabs: true })}`, color: "red" });
      else if (e.kind === "saving" || e.kind === "shortening") latest.current.say({ text: `✗ ${e.message}`, color: "red" });
      else latest.current.say({ text: `✗ ${e.kind}: ${e.message}`, color: "red" });
    };
    const onUsage = () => {
      ui.rerender((n) => n + 1);
      latest.current.lookUpWindow(false);
    };
    const onLead = (id: string) => {
      latest.current.endRun();
      if (ui.leadFromFile.current) latest.current.note(gray(`lead is now ${id}${FROM}`));
      else latest.current.say({ text: `lead is now ${id}`, color: "magenta" });
      latest.current.lookUpWindow();
    };
    const onToolStart = ({ id, name, input }: Events["tool-start"][0]) => {
      ui.calls.current.push({ id, name, target: brief(name, input) });
      ui.run.start(id, Date.now()); // the open run's live row (release 8c plan, choice 67; Task 17)
      ui.rerender((n) => n + 1);
    };
    const onToolEnd = ({ id, outcome }: Events["tool-end"][0]) => {
      const call = ui.calls.current.find((c) => c.id === id);
      if (call) call.outcome = outcome;
      ui.run.finished(id, Date.now());
      ui.rerender((n) => n + 1);
    };
    // A background subagent's ending is shown when it comes; its answer is read at once when idle.
    const onTasks = () => {
      for (const t of ui.tasks.all) {
        if (!t.background || t.state === "running" || t.state === "waiting" || ui.announced.current.has(t.id)) continue;
        ui.announced.current.add(t.id);
        latest.current.endRun();
        latest.current.say({ text: `${t.id} ${t.state === "done" ? "finished" : t.state}`, color: "gray" });
      }
      ui.rerender((n) => n + 1);
      latest.current.next();
    };
    const onTodo = (items: TodoItem[]) => {
      ui.todos.current = { items, hidden: false };
      ui.rerender((n) => n + 1);
    };
    const onNote = (text: string) => {
      latest.current.endRun();
      latest.current.say(gray(text));
    };
    // A hook's grey line (release 8b plan, choice 23), escaped whole: it carries the hook's own words, raw, and its command,
    // so a line break in them cannot pass for a line of the window's own (Task 6's review).
    const onHookNote = (line: string) => {
      latest.current.endRun();
      latest.current.say(gray(visible(line, { tabs: true })));
    };
    // An MCP grey line (release 8c plan, choice 26), escaped whole as a hook's is: it carries a server's names and words.
    const onMcpNote = (line: string) => {
      latest.current.endRun();
      latest.current.say(gray(visible(line, { tabs: true })));
    };
    // The waiting line's label while a hook with a statusMessage runs (release 8b design, "What the user sees").
    const onHookStatus = (message: string, running: boolean) => {
      const s = ui.hookStatus.current;
      if (running) s.push(message);
      else if (s.includes(message)) s.splice(s.lastIndexOf(message), 1);
      ui.rerender((n) => n + 1);
    };
    // A shortening (release 8a plan, Task 13): its line; its summary, for Ctrl+O until the next turn; and the gauge's
    // context, 0 until the next request reports, as the summary request's usage leaves it alone (stats.ts).
    const onShortened = (summary: string) => {
      ui.summary.current = summary;
      ui.stats.context = 0;
      latest.current.endRun();
      latest.current.say(gray(SHORTEN_WORDS.shortened));
    };
    ui.bus.on("message", onMessage);
    ui.bus.on("error", onError);
    ui.bus.on("usage", onUsage);
    ui.bus.on("lead", onLead);
    ui.bus.on("tool-start", onToolStart);
    ui.bus.on("tool-end", onToolEnd);
    ui.bus.on("todo", onTodo);
    ui.bus.on("tasks", onTasks);
    ui.bus.on("note", onNote);
    ui.bus.on("shortened", onShortened);
    ui.bus.on("hook-note", onHookNote);
    ui.bus.on("hook-status", onHookStatus);
    ui.bus.on("mcp-note", onMcpNote);
    // A server's forms (release 8c plan, Task 12; choice 29): each field asked in the prompt's place, as the detail view
    // closes and a printed-out view comes back for a question; a stop of the form's signal takes it away. A visit request
    // is the window's own yes or no.
    let fieldId = 0;
    const unbindForms = ui.mcp?.servers.forms.bind({
      field: (field, given, signal) =>
        new Promise((resolve) => {
          if (signal.aborted) return resolve(null);
          const id = ++fieldId;
          let open = true;
          const done = (answer: string | string[] | null) => {
            if (!open) return;
            open = false;
            signal.removeEventListener("abort", stop);
            ui.setForm((f) => (f?.id === id ? null : f));
            resolve(answer);
          };
          const stop = () => done(null);
          signal.addEventListener("abort", stop, { once: true });
          latest.current.closeDetail();
          ui.setForm({ id, field, ...(given !== undefined && { given }), done });
          void latest.current.comeBack();
        }),
      visit: (question, owner) => ui.asking.current?.(question, undefined, owner, true) ?? Promise.resolve(false),
    });
    // The launch printed the settings file's warnings to stderr, which full screen hides until the user quits, so
    // they show here too (release 6 plan, Task 9, "The launch's warnings show in the session too"); in classic mode
    // stderr is seen, and they are not said twice. So does the line naming the kinds of the dangerous-command check that
    // are off, in red, as it says the check is weaker (release 7 plan, Task 4, the user's choice). The line saying
    // --network was ignored is a warning too, grey as the settings file's, in the launch's order (release 7 plan, choice 22),
    // and so is the one saying git's settings could not be read (Task 8), and the one saying Git Bash was not found
    // (release 8b plan, choice 2).
    const off = ui.fullNow.current && ui.live ? checkOffLine(ui.live.loaded.settings.dangerousCommands) : null;
    const said = ui.live ? [ui.live.networkLine, ui.live.bashLine, ui.live.gitLine].filter((l) => l !== undefined) : [];
    const warnings = ui.fullNow.current && ui.live ? [...ui.live.loaded.warnings, ...said] : [];
    const launchLines: Line[] = [...warnings.map(gray), ...(off ? [{ text: off, color: "red" }] : [])];
    fns.say(...launchLines, ...ui.intro);
    // A watch that cannot start leaves the session as the launch set it, and says so.
    let unwatch: (() => void) | undefined;
    try {
      unwatch =
        ui.live &&
        watchSettings(
          ui.home,
          (read) => latest.current.onSettings(read),
          (read) => latest.current.onKeys(read),
          // A live file's line, as an edit's, of its own (note; choice 35).
          () => latest.current.noteAlone(gray(`${path.dirname(shownFile())} was removed, so ${SETTINGS} and ${KEYBINDINGS} are no longer watched this session`)),
          // One read of the folder is one edit, whichever of the files it changed (note; choice 35's code review).
          () => void (ui.newEdit.current = true),
        );
    } catch (err) {
      fns.say(gray(`${SETTINGS} and ${KEYBINDINGS} are not watched this session (${errorText(err)})`));
    }
    ui.launched.current = true; // the watcher's first read, done at once inside watchSettings, was the launch's (onKeys)
    ui.history.current!.load();
    fns.lookUpWindow();
    const minutes = setInterval(() => ui.setNow(Date.now()), 60_000); // the status line counts the session in minutes
    const onReport = (m: Mouse) => latest.current.onMouse(m);
    ui.mouse?.on("mouse", onReport);
    return () => {
      ui.ended.current = true;
      // Ink ending (a crash, or a signal) lets the keyboard go, so raw mode goes off and the process can end (input.ts,
      // hold), whatever held it: the view printed out, the rest of a paste dropped after it, or a switch, whose own ending
      // a signal never lets come. Letting go again later, as a switch or comeBack does, is harmless. Bracketed paste
      // needs nothing here: Ink's own cleanups turn it off as they end, suspended or not (Ink's components/App.js).
      ui.printed.current = null;
      ui.dropping.current = null;
      ui.owner.end();
      ui.mouse?.off("mouse", onReport);
      unwatch?.();
      clearInterval(minutes);
      clearTimeout(ui.first.current?.timer);
      clearTimeout(ui.chordTimer.current);
      ui.bus.off("message", onMessage);
      ui.bus.off("error", onError);
      ui.bus.off("usage", onUsage);
      ui.bus.off("lead", onLead);
      ui.bus.off("tool-start", onToolStart);
      ui.bus.off("tool-end", onToolEnd);
      ui.bus.off("todo", onTodo);
      ui.bus.off("tasks", onTasks);
      ui.bus.off("note", onNote);
      ui.bus.off("shortened", onShortened);
      ui.bus.off("hook-note", onHookNote);
      ui.bus.off("hook-status", onHookStatus);
      ui.bus.off("mcp-note", onMcpNote);
      unbindForms?.();
      // However the screen closes, /exit or Ctrl-C or Ctrl-D twice, no subagent goes on spending; nor does a turn, which
      // Ink ending on a drawing error would leave with nothing on screen.
      ui.tasks.stop();
      ui.abort.current?.abort();
      ui.saved.release(); // the window leaves its session (release 8a plan, choice 8)
    };
  }, []);

  // The working line's spinner and time, while something runs; the panel's times, once a second, while
  // only subagents do.
  useEffect(() => {
    if (!ui.busy && !ui.running) return;
    const spin = setInterval(() => ui.setNow(Date.now()), ui.busy ? SPIN_MS : 1000);
    return () => clearInterval(spin);
  }, [ui.busy, ui.running]);
  useInput(fns.onInput);

  // A pasted block goes in whole, its line breaks as new lines: it is never sent by them; one of only paths to picture
  // files becomes those pictures (pastePictures). While the picker is open, pastes reach it as typed text, as before.
  usePaste(
    (text) => {
      const given = phaseInputs(ui.phaseRefs);
      if (given.printed) return; // as for keys, in keyRouting.ts; before clearCopied(), which pasteTo() cannot say
      ui.clearCopied();
      ui.notes.current = []; // a live edit's lines leave the hint row at a paste, keys pressed too (note, output.ts)
      fns.dropChords(); // a paste is text, which drops a waiting chord as text read together does (route)
      const to = pasteTo(given);
      // In the detail view a paste goes into a search being typed, up to its first line break, without the control
      // characters typed text loses (keys.ts, commands); otherwise it does nothing there (the user's choice,
      // release 5).
      const d = ui.detail.current;
      if (to === "search" && d?.search) {
        searchFor(d, d.search.query + text.split(/\r\n?|\n/, 1)[0]!.replace(/\p{Cc}/gu, ""), viewHeight);
        return ui.rerender((n) => n + 1);
      }
      if (to === null) return;
      const files = imagePaths(text);
      if (files?.every((f) => isFile(path.resolve(ui.root, f)))) fns.pastePictures(files);
      else fns.run({ type: "paste", text: text.replace(/\r\n?/g, "\n") });
      ui.rerender((n) => n + 1);
    },
    // The sessions' list and /mcp's drop a paste themselves (SessionList.tsx, McpList.tsx); a form's field takes it (Field.tsx).
    { isActive: !ui.picker && !ui.sessions && !ui.mcpList && !ui.form },
  );

  // What the listeners set up once, at mount (the bus's, bindAsk's and the mouse's), call: the latest drawing's
  // functions, set at each, so what they read is the screen as last drawn, never what it was when they were set up
  // (release 6 design, "Tidying the screen code first"). Set while drawing, safe with Ink's non-concurrent root
  // (state.ts).
  const handlers = {
    say: fns.say, note: fns.note, noteAlone: fns.noteAlone, endRun: fns.endRun, closeDetail: fns.closeDetail, comeBack: fns.comeBack,
    next: fns.next, lookUpWindow: fns.lookUpWindow, onMouse: fns.onMouse, onSettings: fns.onSettings,
    onKeys: fns.onKeys, settle: fns.settle, dropChord: fns.dropChords,
  };
  const latest = useRef(handlers);
  latest.current = handlers;
  ui.late.latest = latest; // for newPicture's settle (pictureReads.ts)

  // Copy mode's leaving (queue.ts, leave): its line while the box stops, or a copy with nothing to review is removed
  // (choice 121), then the review in place of everything else, with the live table of keys (release 7 plan, Task 21).
  if (ui.reviewing && ui.copy) {
    const { protection, onEnd, read } = ui.reviewing;
    return <Review copy={ui.copy.copy} bindings={ui.table} protection={protection} onEnd={onEnd} read={read} />;
  }
  // Only copy mode's leaving has a line of its own; any other leaves the screen as it is while SessionEnd's hooks run, its
  // keys off (queue.ts, leave).
  if (ui.leaving.current && ui.copy) return <Text color="gray">{ui.leavingLine.current ?? STOPPING}</Text>;

  // The detail view drawn, which hides the prompt, its menu and what goes with them (release 5 plan, Task 12).
  const d = ui.detail.current;
  const prompt = ui.search.current ? fns.shown() : ui.editor.current;
  fns.staleVim(); // while drawing too, for a change no key made (a picture's read ending), safe as `copied` below says
  const highlight = ui.search.current ? undefined : visualSelection(ui.vim.current, prompt);
  // The model list, /resume's list of sessions or /mcp's of the MCP servers, drawn in the prompt's place, or a server's
  // form's field over them: the picker phase (phase.ts).
  const picking = ui.picker !== null || ui.sessions !== null || ui.mcpList || ui.form !== null;
  const menu = picking || ui.question || d ? null : fns.menuFor(prompt);
  // The open run's live row, above the working line where the prompt is drawn (release 8c plan, choice 67; Task 17): it
  // takes no click, and its seconds grow with the working line's redraws, every SPIN_MS while a turn runs.
  const liveRow = picking || ui.question || d ? [] : ui.run.live(ui.now).map(escaped);
  if (menu?.kind !== "path") ui.listed.current = null;

  // The hint line, under the prompt (release 3 design, "On screen"): whichever applies. `left` is the
  // rows left for the queue.
  const exitKey = ui.first.current?.name === "Esc" ? undefined : ui.first.current?.name;
  // The detail view's row naming its keys, or its search, stands in the hint row's place (release 5 plan, Task 12), as
  // the row over the status line; Ctrl+R's search waits under the view, and a model list queued as `/model` during a
  // turn, which takes the keys, takes the row away while it is open.
  // Each hint names the key bound to its action (keys.ts, named), in the words release 5 wrote; Ctrl-C and Ctrl-D are
  // reserved (bindings.ts, RESERVED), and written as release 5 wrote them. A chord's first strokes take the row first,
  // in the table's spelling, until the next key or 3 s (release 6 design, "The keys file"); then the exit warning, as
  // Ctrl-D twice exits from the detail view and Ctrl+R's search too (choice 19).
  const searching = !d && ui.search.current && `search: ${visible(ui.search.current.query)}${fns.shown() === ui.search.current.before ? " (no match)" : ""}`;
  const said = (key: string | undefined, words: string) => key !== undefined && `${key} ${words}`;
  const hints = (...parts: (string | false | null)[]) => parts.filter(Boolean).join(" · ");
  // Only a chord the keys drawn would go on with: none read at the prompt's side once a question is drawn, as a click on
  // the model list can bring one there with no key between (lookUp drops it at the next key; choice 32's code review).
  const chord = ui.asked.current === (!!ui.question && !picking) ? fns.chordKeys().waiting(Date.now()) : null;
  const fillKeys = [ui.keyOf("autocomplete:accept", "Autocomplete", "tab"), ui.keyOf("chat:submit", "Chat", "enter")];
  const previous = ui.keyOf("history:previous", "Chat", "up");
  // The last line of a live edit, with how many more it said, which the conversation shows (note, output.ts).
  const notice = ui.notes.current.at(-1);
  // One row, as the frame gives it (layout.ts, frame): a line break in it, such as in the file Node's JSON error quotes,
  // is one space here, the conversation keeping the line as said (choice 35's code review).
  const noticeText = notice && `${notice.text.replace(/\s*[\r\n]+\s*/g, " ")}${ui.notes.current.length > 1 ? ` (+${ui.notes.current.length - 1} more above)` : ""}`;
  const usualHint = (left: number) =>
    chord
      ? `${keyText(chord)} ...`
      : exitKey
      ? `Press ${exitKey} again to exit`
      : d && !picking
      ? keyRow(d, ui.table)
      : searching
      ? hints(
          searching,
          said(ui.keyOf("historySearch:next", "HistorySearch", "ctrl+r"), "older"),
          said(ui.keyOf("historySearch:execute", "HistorySearch", "enter"), "send"),
          said(ui.keyOf("historySearch:accept", "HistorySearch", "tab"), "edit"),
          "Ctrl-C cancel",
        )
        : picking || ui.question
          ? null
          : menu
            ? hints(
                said(both(ui.keyOf("autocomplete:previous", "Autocomplete", "up"), ui.keyOf("autocomplete:next", "Autocomplete", "down")), "choose"),
                ...(menu.kind === "command"
                  ? [said(fillKeys[0], "fill"), said(fillKeys[1], "run")]
                  : [said(fillKeys.filter(Boolean).join(" or ") || undefined, "fill")]),
                said(ui.keyOf("autocomplete:dismiss", "Autocomplete", "escape"), "close"),
              )
            : ui.reads.current
            ? "Reading picture..." // over the queue's and the stash's hints, for the moment it lasts (release 6 design, "Pictures")
            : ui.queue.current.length
            ? left > 0 && previous
              ? `${previous} to edit queued messages`
              : `${ui.queue.current.length} queued`
            : ui.stash.current
              ? // during a turn too, no other hint taking the row (release 6 plan, Task 13)
                hints("Stashed", said(ui.keyOf("chat:stash", "Chat", "ctrl+s"), "to bring back"))
              : noticeText
                ? noticeText // over vim's mode too, until a key (choice 35, the user's: "Notice wins")
                : ui.vim.current
                  ? `-- ${ui.vim.current.mode} --` // every mode, in a turn too, when no other hint takes the row (choice 15)
                  : ui.busy
                    ? null
                    : "? for shortcuts";
  // The line about the last copy, until the next key or click (release 5 design, "Copying"), takes the hint row's place
  // only while one shows, so a copy never moves the conversation; a failed copy shows anyway, adding the row. Ctrl+R's
  // search and the exit warning keep the row (the user's choice, release 5), and so does the detail view's search while
  // it is typed, as Ctrl+R's does. A failure on a terminal too short for a hint row waits until one fits.
  const hintFor = (left: number) => {
    const usual = usualHint(left);
    const c = ui.copied.current;
    return c === null || searching || d?.search?.typing || exitKey || (!c.failed && usual === null) ? usual : c.text;
  };

  // The frame's rows (layout.ts, frame), from what is drawn: the prompt as shown, Ctrl+R's match while it searches. The
  // model list has no tool line under it. In full screen it needs its rows unfiltered, the longest it gets, with its "No
  // models" line when it has no models, in a box that tall, so the status line stays put while typing filters the list.
  // A question's line is wrapped and drawn a row a Text in full screen, so its rows are known; the line it moves to when
  // too long to fit is its short one, below.
  // A question names the launch's keys, the ones that answer it (lookUp; choice 32).
  const allow = (what: string, plain?: boolean) => {
    const answer = (action: string, usual: string) => named(ui.launchKeys.current, action, "Confirmation", [usual])[0];
    const yes = answer("confirm:yes", "y") ?? "";
    const no = answer("confirm:no", "n") ?? "";
    return hints(
      `${plain ? "" : "Allow "}${what}? [${yes}/${no}]`,
      said(answer("confirm:no", "escape"), "to decline"),
    );
  };
  const shortOf = (q: Question) => `${q.label} (shown above)`;
  const laid = layout(prompt.text, promptWidth(ui.columns));
  const offered = ui.full && ui.picker ? listRows(ui.picker, "") : [];
  const movable = ui.full && ui.question && !picking && !ui.question.short; // a question that can still move into the conversation
  const f = frameOf({
    rows: ui.height,
    columns: ui.columns,
    full: ui.full,
    promptRows: laid.rows.length,
    cursorRow: laid.places.get(prompt.cursor)!.row,
    promptTop: ui.promptTop.current,
    working: ui.busy,
    liveRows: liveRow.length,
    toolLine: !picking && ui.shownSegments.includes("tools") && ui.calls.current.length > 0,
    detail: d !== null,
    hint: hintFor(1) !== null, // whether there is a hint does not depend on the rows left (usualHint)
    menu: menu ? menu.entries.length : null,
    taskRows: (rows) => taskRows(ui.tasks.all, rows, ui.now, ui.run.options.names),
    todoRows: (rows) => (!ui.todos.current.hidden && unfinished(ui.todos.current.items) ? todoRows(ui.todos.current.items, rows) : []),
    queued: ui.queue.current.length,
    // The sessions' list: its heading and a row each; /mcp's, its heading and a row for each server, or for each action
    // when a server's are shown, whichever is more, so the frame stays put between the two. A form's field: its note, its
    // question, and a pick's options and hint row, the frame adding the question's row as it adds a list's hint (Field.tsx).
    pickerNeeded: ui.form
      ? (ui.form.field.note === undefined ? 0 : 1) + (ui.form.field.kind === "pick" ? ui.form.field.options.length + 1 : 0)
      : ui.picker
        ? offered.length + (offered.some((r) => r.kind === "model") ? 0 : 1)
        : ui.sessions
          ? ui.sessions.rows.length + 1
          : ui.mcpList
            ? Math.max(ui.mcp?.servers.list().length ?? 0, ACTIONS.length) + 1
            : null,
    question: ui.question !== null,
    askedText: ui.full && ui.question && !picking ? allow(ui.question.short ?? ui.question.text, ui.question.plain) : null,
    askedShort: movable ? allow(shortOf(ui.question), ui.question.plain) : null,
    askedWarnings: ui.question?.warnings ?? [],
    askedNote: ui.question?.note !== undefined,
  });
  const { tooled, menuRows, panel, promptSpace, promptShown, todoShown, pickerRows, viewHeight, promptFirst } = f;
  ui.late.viewHeight = viewHeight; // for the functions that read it once the drawing is done (state.ts, late)
  const q = ui.queue.current.map((e) => visible(e.text));
  const shownQueued = f.queuedShown;
  const queued = q.length <= shownQueued ? q : shownQueued > 0 ? [...q.slice(0, shownQueued - 1), `+${q.length - shownQueued + 1} more`] : [];
  const hint = f.hinted ? hintFor(f.left) : null;
  const noticeShown = notice !== undefined && hint === noticeText; // the hint row shows a live edit's line (choice 35)
  // A successful copy's line that is not on screen is dropped, so it never turns up later, when a hint row comes back; only
  // a failure waits to be shown (the user's choice, release 5). Changed while drawing, which is safe as Ink renders
  // with React's non-concurrent root (ink.js, `concurrent` defaults to false); a concurrent root could drop or mark
  // shown a line it never drew.
  if (ui.copied.current && !ui.copied.current.failed && hint !== ui.copied.current.text) ui.copied.current = null;
  if (ui.copied.current && hint === ui.copied.current.text) ui.copied.current.shown = true; // from now the next key or click takes it away

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
    if (!ui.question.detail) {
      const n = characters(ui.question.text);
      const from = ui.kept.lines.length;
      // Its red lines go with it, above its text, so "shown above" shows the dangers too (release 7 plan, Task 8), and so
      // does its grey line, auto mode's pause, above any red lines, which the gate never sends with it today (Task 10).
      fns.say(
        { text: `┌ ${ui.question.label} (${n} character${n === 1 ? "" : "s"})`, color: "gray" },
        ...(ui.question.note === undefined ? [] : [{ text: ui.question.note, color: "gray", ...(ui.question.oneRow ? { oneLine: true } : {}) }]),
        ...ui.question.warnings.map((text): Line => ({ text, color: "red" })),
        { text: ui.question.text, color: "gray" },
      );
      ui.question.detail = [from, ui.kept.lines.length - 1];
    }
    ui.question.short = shortOf(ui.question);
  }
  // A question brings its own detail into view when it is first drawn (release 5 design, "Scrolling"; release 5 plan,
  // Task 11), and when a draw moves it into the conversation, above; here, with the height the conversation has beside
  // it; changed while drawing, as `copied` above. Whether the view was following is kept from the first draw. Its
  // detail's last row goes on the view's second-last row, the last kept for "↓ N new lines", when its rows fit above
  // that; otherwise its heading goes on the top row. The view is held there, never moved to the bottom (view.ts,
  // first), so what arrives while the question waits does not move it, and the lines already below the detail (a reply,
  // an earlier answer) are counted as unseen. A question without a detail leaves the view (release 5 plan, choice 11).
  if (ui.full && ui.question && !picking && (ui.question.following === undefined || moved)) {
    if (ui.question.following === undefined) ui.question.following = ui.view.current.at === null;
    if (ui.question.detail) {
      const [from, to] = ui.question.detail;
      const head = ui.kept.rowOf({ line: from, offset: 0 });
      const end = ui.kept.rowOf({ line: to, offset: ui.kept.lines[to]!.text.length });
      const r = ui.kept.row(end - head + 1 <= viewHeight - 1 ? Math.max(0, end - (viewHeight - 2)) : head); // 2: the last two rows
      ui.view.current = { at: { line: r.line, offset: r.start }, unseen: ui.kept.lines.length - 1 - to };
    }
  }
  ui.frame.current = {
    columns: ui.columns,
    viewHeight,
    promptFirst,
    promptRows: picking || ui.question || ui.search.current || d ? 0 : promptShown,
    promptWindow: f.promptWindow,
    menuRows,
    editor: ui.editor.current,
    chosen: ui.chosen.current,
    detail: d,
    picker: picking,
    question: ui.question !== null,
  };
  // A pick from /resume's list, called without await, so nothing may escape, as the model list's pick (queue.ts, pick).
  const pickSession = (id: string) => void fns.pickSession(id).catch((err) => fns.say({ text: errorText(err), color: "red" }));
  // Where vim takes Esc first (vimFirst) the line names it twice; a key chat:cancel has with Ctrl or Alt never goes to
  // vim (choice 31).
  const stop = ui.keyOf("chat:cancel", "Chat", "escape");
  const escFirst = fns.vimFirst() && ui.table.keysFor("chat:cancel", "Chat").includes("escape");
  // While the first prompt waits for the MCP servers, the waiting line names them (release 8c plan, choice 25), already
  // escaped (Servers, waitingFor); a hook's statusMessage first, as SessionStart's hooks are waited for before them.
  const servers = ui.session.waitingFor();
  const workingLine = ui.busy && (
    <WorkingLine
      label={
        ui.hookStatus.current.length
          ? visible(ui.hookStatus.current.at(-1)!)
          : servers.length
            ? `Waiting for MCP servers: ${servers.join(", ")}...`
            : ui.doing.current.label
      }
      stop={escFirst ? `${stop} ${stop}` : stop}
      ms={Math.max(0, ui.now - ui.doing.current.at)}
      spend={
        ui.doing.current.from && {
          lead: ui.session.lead.id,
          output: ui.stats.output - ui.doing.current.from.output,
          cost: ui.stats.cost - ui.doing.current.from.cost,
          costUnknown: ui.stats.unpriced > ui.doing.current.from.unpriced,
        }
      }
    />
  );

  if (ui.switching) return null; // going to classic: nothing is drawn until Ink has resumed on the normal screen (/screen)
  return (
    <>
      {ui.full && d ? (
        <DetailView detail={d} height={viewHeight} selection={fns.selected()} />
      ) : ui.full ? (
        <Conversation
          rows={ui.kept}
          first={firstRow(ui.kept, ui.view.current, viewHeight)}
          height={viewHeight}
          unseen={unseenBelow(ui.kept, ui.view.current, viewHeight)}
          following={ui.view.current.at === null}
          selection={fns.selected()}
          bottom={ui.keyOf("scroll:bottom", "Scroll", "ctrl+end")}
        />
      ) : (
        <Static items={ui.printUpTo.current === null ? ui.lines : ui.lines.slice(0, ui.printUpTo.current)}>
          {(l) => (
            <Text key={l.id} color={l.color} wrap={l.oneLine ? "truncate-end" : "wrap"}>
              {l.text}
            </Text>
          )}
        </Static>
      )}
      {ui.form ? (
        // A server's form's field (release 8c plan, Task 12), in the lists' rows, over any of them that is open.
        ui.full ? (
          <Box flexDirection="column" height={pickerRows + 1} justifyContent="flex-end">
            <Field key={ui.form.id} asked={ui.form} bindings={ui.table} keys={ui.pickerKey} rows={pickerRows + 1} full />
          </Box>
        ) : (
          <Field key={ui.form.id} asked={ui.form} bindings={ui.table} keys={ui.pickerKey} rows={ui.height - 3} full={false} />
        )
      ) : ui.picker ? (
        ui.full ? (
          <Box flexDirection="column" height={pickerRows + 1} justifyContent="flex-end">
            <ModelPicker
              groups={ui.picker}
              current={ui.session.lead.id}
              onPick={fns.pick}
              onClose={fns.closePicker}
              keys={ui.pickerKey}
              bindings={ui.table}
              maxRows={pickerRows}
              mouse={ui.mouse}
              bottom={viewHeight + pickerRows} // the box's last row
            />
          </Box>
        ) : (
          <ModelPicker groups={ui.picker} current={ui.session.lead.id} onPick={fns.pick} onClose={fns.closePicker} keys={ui.pickerKey} bindings={ui.table} />
        )
      ) : ui.sessions ? (
        // /resume's list (release 8a plan, choice 14), where the model list goes. In classic mode it takes the rows above
        // the status line, less its hint's and the one Ink ends on.
        ui.full ? (
          <Box flexDirection="column" height={pickerRows + 1} justifyContent="flex-end">
            <SessionList {...ui.sessions} bindings={ui.table} onPick={pickSession} onClose={fns.closeSessions} keys={ui.pickerKey} maxRows={pickerRows} />
          </Box>
        ) : (
          <SessionList {...ui.sessions} bindings={ui.table} onPick={pickSession} onClose={fns.closeSessions} keys={ui.pickerKey} maxRows={ui.height - 3} />
        )
      ) : ui.mcpList && ui.mcp ? (
        // /mcp's list (release 8c plan, Task 10), where /resume's goes, in the same rows.
        ui.full ? (
          <Box flexDirection="column" height={pickerRows + 1} justifyContent="flex-end">
            <McpList servers={ui.mcp.servers} bindings={ui.table} onAction={fns.mcpAction} onClose={fns.closeMcp} keys={ui.pickerKey} maxRows={pickerRows} />
          </Box>
        ) : (
          <McpList servers={ui.mcp.servers} bindings={ui.table} onAction={fns.mcpAction} onClose={fns.closeMcp} keys={ui.pickerKey} maxRows={ui.height - 3} />
        )
      ) : ui.question ? (
        // A dangerous command's red lines above the question, one per danger (release 7 plan, Task 8); auto mode's pause, a
        // grey row, goes above any red lines, which the gate never sends with it today (Task 10).
        ui.full ? (
          <>
            {f.noted && (
              <Text color="gray" wrap="truncate-end">
                {ui.question.note}
              </Text>
            )}
            {f.warned.map((r, i) => (
              <Text key={`w${i}`} color="red" wrap="truncate-end">
                {r}
              </Text>
            ))}
            {f.asked.map((r, i) => (
              <Text key={i} color="yellow" wrap="truncate-end">
                {r}
              </Text>
            ))}
          </>
        ) : (
          <>
            {ui.question.note !== undefined && (
              <Text color="gray" wrap={ui.question.oneRow ? "truncate-end" : "wrap"}>
                {ui.question.note}
              </Text>
            )}
            {ui.question.warnings.map((w, i) => (
              <Text key={i} color="red">
                {w}
              </Text>
            ))}
            <Text color="yellow">{allow(ui.question.text, ui.question.plain)}</Text>
          </>
        )
      ) : d ? (
        workingLine // the working line stays under the detail view while a turn runs (release 5 plan, choice 12)
      ) : (
        <>
          {liveRow.map((l, i) => (
            <Text key={`r${i}`} color={l.color} wrap="truncate-end">
              {l.text}
            </Text>
          ))}
          {workingLine}
          <TodoList rows={todoShown} />
          {queued.map((row, i) => (
            <Text key={i} color="gray" wrap="truncate-end">
              {row}
            </Text>
          ))}
          <Prompt
            editor={prompt}
            columns={ui.columns}
            offset={promptFirst}
            space={promptSpace}
            top={ui.promptTop}
            selected={highlight}
          />
          {menu && <Menu entries={menu.entries} chosen={fns.chosenIn(prompt, menu)} rows={menuRows} top={ui.menuTop} />}
          <TaskPanel rows={panel} />
        </>
      )}
      {hint && (
        // A live edit's line keeps its own colour, and a long one gives up its middle, not its count (choice 35).
        <Text
          dimColor={!noticeShown}
          color={noticeShown ? notice.color : undefined}
          wrap={noticeShown ? "truncate-middle" : "truncate-end"}
        >
          {hint}
        </Text>
      )}
      <StatusLine
        segments={ui.shownSegments}
        info={{
          lead: ui.session.lead.id,
          context: ui.stats.context,
          contextWindow: ui.contextWindow,
          input: ui.stats.input,
          output: ui.stats.output,
          cost: ui.stats.cost,
          costUnknown: ui.stats.costUnknown,
          mode: ui.perm.current,
          errors: ui.stats.errors,
          project: ui.project,
          branch: ui.branch,
          elapsed: ui.now - ui.started.current,
          running: ui.tasks.running,
        }}
      />
      {tooled && <ToolLine calls={ui.calls.current} />}
    </>
  );
}
