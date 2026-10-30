import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Box, renderToString, Static, Text, useInput, usePaste } from "ink";
import { useEffect, useRef } from "react";
import type { Given } from "../clilib.js";
import type { Bus, ErrorEvent, Events } from "../core/bus.js";
import { summarize } from "../core/errorlog.js";
import { type Ask, type Mode, visible } from "../core/permissions.js";
import type { Session } from "../core/session.js";
import type { Stats } from "../core/stats.js";
import type { Task, Tasks } from "../core/tasks.js";
import { errorText, type Message, type Provider } from "../core/types.js";
import { KEYBINDINGS } from "../keybindings.js";
import type { ModelGroup } from "../providers/models.js";
import { SETTINGS, type Settings, settingsDir, shownFile } from "../settings.js";
import { watchSettings } from "../settingsWatch.js";
import type { TodoItem } from "../tools/todo.js";
import {
  characters, COMMANDS, ERASE_LINE, FROM, gray, isCommand, isFile, names, type Printed, type Question, visualSelection,
  WAITING,
} from "./app/constants.js";
import { keyRouting } from "./app/keyRouting.js";
import { liveEdits } from "./app/liveEdits.js";
import { mouse } from "./app/mouse.js";
import { output } from "./app/output.js";
import { pictureReads } from "./app/pictureReads.js";
import { promptKeys } from "./app/promptKeys.js";
import { type UI, useAppState } from "./app/state.js";
import { Bindings, keyText } from "./bindings.js";
import { type Clipboard, imagePaths } from "./clipboard.js";
import { Conversation } from "./Conversation.js";
import { brief, callLines, describe, type Line } from "./describe.js";
import { type Detail, DetailView, keyRow, opened, searchFor } from "./DetailView.js";
import { change } from "./editor.js";
import { editFile, editorCommand, editText, NOT_FOUND } from "./external.js";
import { History } from "./history.js";
import { type Mouse, readOut } from "./input.js";
import { both, named } from "./keys.js";
import { frame as frameOf, layout } from "./layout.js";
import { Menu } from "./Menu.js";
import { ModelPicker, rows as listRows } from "./ModelPicker.js";
import type { Hand } from "./owner.js";
import { pasteTo, phaseInputs } from "./phase.js";
import { type Draft, joined, Pictures, type Read, spansIn, trimmed } from "./pictures.js";
import { Prompt, promptWidth } from "./Prompt.js";
import { type Segment, StatusLine } from "./StatusLine.js";
import { TaskPanel, taskRow, taskRows } from "./TaskPanel.js";
import { PASTE_OFF, PASTE_ON, type Screen } from "./terminal.js";
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

const queue = (ui: UI, fns: Fns) => {
  // Called without await, so nothing may escape: an unhandled rejection ends the program. The queue
  // goes on after a turn, however it ended, and after `/model` once the list is closed. `answers`: a
  // turn with nothing typed, to read the background answers waiting.
  const submit = async (raw: Draft, answers = false) => {
    if (!(await fns.perform(raw, answers))) fns.next();
  };

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
    const h = ui.happening();
    if (h.phase.kind === "ended" || h.working || h.waiting) return;
    const w = ui.waiting.current;
    if (w.lead !== undefined) fns.fileLead(w.lead);
    w.lead = undefined;
    if (w.screen && !ui.owner.busy) {
      const to = w.screen;
      w.screen = undefined;
      if (to === "full" && !ui.fullNow.current && !ui.fullPossible) fns.note(gray("Full screen needs a terminal (the output is not one, or CI is set)"));
      else if ((to === "full") === ui.fullNow.current) fns.note(gray(`screen is now ${to}${FROM}`));
      else {
        // As perform runs /screen: what goes wrong is said, and the queue goes on after.
        void fns.switchScreen(true)
          .catch((err) => fns.say({ text: errorText(err), color: "red" }))
          .then(fns.next);
        return;
      }
    }
    if (ui.tasks.wakes()) return void fns.submit({ text: "", spans: [] }, true);
    const q = ui.queue.current;
    const command = q.findIndex((d) => isCommand(d.text));
    if (!h.queued) return;
    if (h.phase.kind === "printed" && command === 0 && (fns.recordToOpen(q[0]!.text) || /^\/screen$/i.test(q[0]!.text))) return;
    if (ui.owner.busy && command === 0 && /^\/(screen|settings|keybindings)$/i.test(q[0]!.text)) return;
    ui.view.current = FOLLOWING; // sending a prompt goes to the bottom (release 5 design, "Scrolling")
    void fns.submit(joined(q.splice(0, command === 0 ? 1 : command === -1 ? q.length : command), "\n\n"));
  };
  // The subagent whose record `text` opens in the detail view: in full screen, `/tasks t3` with a subagent of that id
  // (perform, below).
  const recordToOpen = (text: string) => {
    const [first = "", ...words] = text.split(/\s+/);
    return ui.fullNow.current && first.toLowerCase() === "/tasks" && words.length === 1 ? ui.tasks.all.find((t) => t.id === words[0]) : undefined;
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
        ui.queue.current = [];
        return ui.exit();
      }
      if (alone("/errors")) return fns.say(...summarize(ui.errorFile).map((row) => ({ text: row, oneLine: true })));
      // Not to full screen where it can't draw: classic, as at the start (clilib.ts, screenMode).
      if (alone("/screen") && !ui.fullNow.current && !ui.fullPossible)
        return fns.say({ text: "Full screen needs a terminal (the output is not one, or CI is set)", color: "gray" });
      if (alone("/screen")) return await fns.switchScreen();
      if (alone("/settings")) return await fns.openFile(SETTINGS, {});
      if (alone("/keybindings")) return await fns.openFile(KEYBINDINGS, { bindings: [] });
      // /vim switches vim mode, /vim on and /vim off set it (choice 6), this window only, saving nothing (choice 26).
      if (command === "/vim") {
        const [word = "", ...rest] = words.map((w) => w.toLowerCase());
        const on = word ? word === "on" : ui.vim.current === null;
        if (!rest.length && ["", "on", "off"].includes(word)) return fns.setVim(on);
        return fns.say({ text: "Usage: /vim, /vim on, /vim off", color: "red" });
      }
      // In full screen a subagent's record opens in the detail view (release 5 plan, Task 12); the list, stopping and
      // mistakes print.
      if (command === "/tasks") {
        const t = fns.recordToOpen(text);
        return t ? fns.openDetail(fns.recordOf(t)) : fns.say(...fns.tasksCommand(words));
      }
      if (command === "/lead" && !listing) {
        const spec = words.join(" ");
        ui.session.setLead(fns.make(spec)); // this window only, saving nothing (choice 26, the user's)
        return;
      }
      const account = command === "/login" ? "login" : command === "/logout" ? "logout" : undefined;
      // A mistyped command must not become a paid turn.
      // A slash and a bare word on its own is a command; "/tmp is full" is a message, "/exit now" is not.
      if (!account && !listing && /^\/[a-z]+$/i.test(text)) return fns.say({ text: `Unknown command: ${text}. Commands: ${COMMANDS}`, color: "red" });
      if (words.length && ["/exit", "/errors", "/model", "/screen", "/settings", "/keybindings"].includes(command))
        return fns.say({ text: `${command} takes nothing after it.`, color: "red" });
      ui.abort.current = new AbortController();
      const turn = !account && !listing;
      const label = account === "login" ? "Waiting for the browser" : account ? "Signing out" : answers ? `Reading ${names(ui.tasks.answering())}` : turn ? "Working" : "Reading the model lists";
      ui.doing.current = { label, at: Date.now(), from: turn ? { output: ui.stats.output, cost: ui.stats.cost, unpriced: ui.stats.unpriced } : null };
      if (turn) ui.calls.current = [];
      ui.setNow(ui.doing.current.at);
      ui.setBusy(true);
      ui.working.current = true;
      // Finished subagents leave the panel at the user's next turn; after `working`, since the change
      // it reports would otherwise start the queue.
      if (turn && !answers) ui.tasks.clearFinished();
      try {
        // Signing in waits on the browser; Ctrl-C stops it, as it stops a turn.
        if (account) await ui.login(account, words, (line) => fns.say({ text: line, color: "magenta" }), ui.abort.current.signal, "/");
        else if (listing) {
          const { signal } = ui.abort.current; // this command's own, read before the wait
          const groups = await ui.listModels(signal, (line) => fns.say({ text: line, color: "magenta" }));
          if (!signal.aborted) {
            ui.listOpen.current = true;
            // A list read while the detail view is printed out, sent before `[` or from the queue, waits for it to come back
            // (the user's choice, release 5): opening, it would end the paste hook (usePaste, below), and Ink would
            // turn bracketed paste off at once, suspended or not, so a paste would come as keys. listOpen holds the
            // queue meanwhile.
            if (ui.printed.current) ui.waitingList.current = groups;
            else ui.setPicker(groups);
            return true;
          }
        } else await ui.session.send(await fns.readsEnded(message, ui.abort.current.signal), ui.abort.current.signal);
      } finally {
        ui.setBusy(false);
        ui.working.current = false;
        ui.setBranch(ui.gitBranch());
      }
    } catch (err) {
      fns.say({ text: errorText(err), color: "red" });
    }
  };

  // `/tasks` lists the session's subagents, `/tasks t3` prints one's tool calls and answer in full,
  // and `/tasks stop` stops all of them, or with a number one (release 4 design, "Background subagents").
  const tasksCommand = (words: string[]): Line[] => {
    const none = (id: string): Line => ({ text: `No subagent ${id}. /tasks lists them.`, color: "red" });
    const [verb, id, ...rest] = words;
    if (verb === undefined) {
      if (!ui.tasks.all.length) return [gray("No subagents yet.")];
      const now = Date.now();
      return [gray(`Subagents: ${ui.tasks.all.length}`), ...ui.tasks.all.flatMap((t) => taskRow(t, now)).map((r) => ({ ...gray(`${r.mark} ${r.text}`), oneLine: true }))];
    }
    if (verb === "stop" && !rest.length) {
      if (id === undefined) return [gray(ui.tasks.stop() ? "Stopped every subagent." : "No subagent is running.")];
      if (!ui.tasks.all.some((t) => t.id === id)) return [none(id)];
      return [gray(ui.tasks.stop(id) ? `Stopped ${id}.` : `${id} is not running.`)];
    }
    if (id !== undefined) return [{ text: "Usage: /tasks, /tasks <number>, /tasks stop [<number>]", color: "red" }];
    const t = ui.tasks.all.find((x) => x.id === verb);
    return t ? fns.recordOf(t) : [none(verb)];
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
    ui.listOpen.current = false;
    ui.setPicker(null);
    ui.view.current = FOLLOWING;
    // The pick comes after any edit of the file's lead made while the list was open, so it wins, as a /lead typed
    // then would.
    ui.waiting.current.lead = undefined;
    try {
      ui.session.setLead(fns.make(spec)); // this window only, as /lead (choice 26)
    } catch (err) {
      fns.say({ text: errorText(err), color: "red" });
    }
    fns.next();
  };
  const closePicker = () => {
    ui.listOpen.current = false;
    ui.setPicker(null);
    fns.next();
  };
  return { submit, next, recordToOpen, perform, tasksCommand, recordOf, pick, closePicker };
};

const handover = (ui: UI, fns: Fns) => {
  // The detail view opens over the conversation, though not over a question, which closes it (bindAsk, below): what a key
  // read before a question is first drawn asks for is said in the conversation instead. Opening and closing clear the
  // selection, which belongs to the other pane's lines, and end a drag, a grab of the bar and a run of clicks.
  const unselect = () => {
    ui.selection.current = null;
    ui.held.current = null;
    ui.grab.current = null;
    ui.lastPress.current = null;
  };
  const openDetail = (lines: Line[]) => {
    if (ui.questions.current.length) return fns.say(...lines);
    ui.detail.current = opened(lines, ui.frame.current.columns - 1); // as last drawn, for a turn started before a resize
    fns.unselect();
    ui.rerender((n) => n + 1);
  };
  const closeDetail = () => {
    if (!ui.detail.current) return;
    ui.detail.current = null;
    fns.unselect();
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
    ui.printed.current = p;
    fns.unselect();
    p.handover = ui.owner.take();
    ui.screen.setMouse(false);
    const { resume } = await p.handover.suspend();
    if (ui.printed.current !== p) return; // Ink ended meanwhile, and the cleanup below let the keyboard go
    ui.screen.setSecond(false);
    ui.screen.suspended = true;
    const page = d.rows.lines.map((l, i) => (
      <Text key={i} color={l.text ? l.color : undefined} wrap={l.oneLine ? "truncate-end" : "wrap"}>
        {l.text || " "}
      </Text>
    ));
    ui.screen.write(`${renderToString(<>{page}<Text color="gray">Printed. q, Esc or Ctrl-C to go back.</Text></>, { columns: ui.columns })}\n`);
    ui.screen.write(PASTE_ON);
    p.resume = resume;
    ui.input!.divert(fns.reader);
    if (ui.questions.current.length) await fns.comeBack();
  };
  // What a read does is readOut's (input.ts). Keys after the one that comes back are dropped: Ink is not reading again
  // until it resumes.
  const reader = (keys: string) => {
    const p = ui.printed.current;
    if (!p) return;
    const read = readOut(p.paste, keys);
    p.paste = read.paste;
    if (read.back) void fns.comeBack();
  };
  // Coming back undoes going out in reverse; bracketed paste goes off as Ink's suspend left it, and Ink's resume turns it on
  // again. A paste still coming in, when a question or the key coming back brought the view back, is dropped up to its
  // end before keys reach Ink, so a y in it never answers a question, nor a pasted q closes the view (the user's choice,
  // release 5); what follows its end marker in the same read goes with it. A `[` read once Ink reads keys again, before
  // its drawing is done, prints the view out again, and that print-out keeps the hold and what waits. So does a switch
  // a /screen sent then started (Ctrl+O closing the view, then the prompt, in one read): its own ending lets go, as
  // letting go in its middle would let Ink's suspend turn raw mode off.
  const comeBack = async () => {
    const p = ui.printed.current;
    if (!p?.resume) return;
    ui.printed.current = null;
    if (p.paste === undefined) ui.input!.divert(null);
    else {
      ui.dropping.current = p;
      ui.input!.divert((keys) => {
        p.paste = readOut(p.paste, keys).paste;
        if (p.paste !== undefined) return;
        ui.dropping.current = null;
        ui.input!.divert(null);
      });
    }
    ui.screen.write(PASTE_OFF);
    ui.screen.setSecond(true);
    ui.screen.setMouse(true);
    ui.screen.suspended = false;
    await p.resume();
    p.handover!.done(); // also when Ink ended meanwhile, after its cleanup let go: again is harmless (input.ts, hold)
    if (ui.printed.current) return;
    // Ink ending during the resume (a crash in its redraw) starts nothing that waited: no screen would show it, and a
    // turn would go on paying with none.
    if (ui.ended.current) return;
    const list = ui.waitingList.current;
    ui.waitingList.current = null;
    if (list) ui.setPicker(list);
    fns.next();
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
    const toFull = !ui.fullNow.current;
    ui.working.current = true;
    const handover = ui.owner.take();
    fns.unselect();
    ui.wheel.current = 0;
    try {
      if (toFull) {
        const width = ui.frame.current.columns - 1; // one column short, as in state.ts
        if (ui.kept.width !== width) ui.kept.setWidth(width);
        ui.kept.add(ui.unkept.current);
        ui.unkept.current = [];
        ui.fullNow.current = true;
        const { resume } = await handover.suspend();
        if (ui.ended.current) return;
        ui.screen.enter();
        ui.setFull(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (ui.ended.current) return;
        await resume();
      } else {
        fns.closeDetail();
        ui.fullNow.current = false;
        ui.setFull(false);
        ui.setSwitching(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (ui.ended.current) return;
        const { resume } = await handover.suspend();
        ui.screen.leave();
        await resume();
      }
    } finally {
      if (toFull && !ui.screen.full) ui.fullNow.current = false; // the suspend threw, or Ink ended first
      ui.setSwitching(false);
      ui.working.current = false;
      handover.done(); // a print-out started during the switch keeps the hold (comeBack, above)
    }
    if (ui.ended.current) return;
    (file ? fns.note : fns.say)({ text: `screen is now ${toFull ? "full" : "classic"}${file ? FROM : ""}`, color: "gray" });
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
  // 2026-10-30) writes its hint just before it starts the editor, ending in a space with no line break, and erases it
  // with "\r\x1b[K" (pager.c, term_clear_line) once the editor has exited, succeeded or not; it does not when the
  // editor could not be started, nor when it died of Ctrl-C or Ctrl-\, which Git then raises itself. Tachikoma writes
  // its line once the terminal is handed over, cut to a row, and erases it in the same way every time the editor
  // returns, so an editor in the terminal leaves its screen and the frame Ink draws again as they were. A command the
  // shell cannot find still starts the shell, whose own error is printed after the line, on its row, and ends with a
  // line break, so the erase clears the row below it: the line and the shell's error stay on the normal screen, and
  // Tachikoma says the editor was not found once it is back. A resize while the editor is open can leave part of the
  // line, as with Git. Written straight to the terminal, never said, so it is in no printed output nor <Static>. Git's
  // dumb-terminal case (a line break, nothing erased) is not followed: Ink's frame needs the same codes.
  const away = async <T,>(edit: (command: string) => Promise<T>) => {
    try {
      return await ui.owner.program(async () => {
        const full = ui.screen.full;
        fns.unselect();
        if (full) ui.screen.leave();
        else ui.printUpTo.current = ui.nextId.current;
        ui.screen.suspended = true;
        const command = editorCommand(process.env, ui.fileNow.current.editor, process.platform);
        // Cut to the width the App draws at, a column short, so it never wraps onto a row the erase leaves.
        ui.screen.write(WAITING.slice(0, Math.max(0, ui.frame.current.columns - 1)));
        try {
          return { command, got: await edit(command) };
        } finally {
          ui.screen.write(ERASE_LINE);
          if (full && !ui.ended.current) ui.screen.enter();
          ui.screen.suspended = false;
        }
      });
    } finally {
      ui.printUpTo.current = null;
      ui.rerender((n) => n + 1);
    }
  };
  // The one line for an editor that failed or was not found, naming how to set one (design, "On return").
  const editorFailed = (command: string, failed: string) => {
    const why = failed === NOT_FOUND ? `${command} was not found` : `The editor failed (${failed})`;
    fns.say({ text: `${why}. Set VISUAL or EDITOR, or "editor" in ${shownFile()}.`, color: "red" });
  };
  // Ctrl+G and Ctrl+X Ctrl+E: the prompt as it is when the editor starts goes to it, and what it saved becomes the
  // prompt, the cursor at the end, as one step Ctrl+Z takes back; on failure the prompt stays (design, "On return").
  // Then the queue goes on: a /screen, /settings or /keybindings may have waited for the editor (next, above).
  const externalEditor = async () => {
    const ids = ui.editor.current.spans.map((s) => s.id); // the pictures the prompt holds as the editor opens
    const ran = await fns.away((command) => editText(ui.editor.current.text, command));
    if (!ran) return; // Ink ended meanwhile
    if ("failed" in ran.got) fns.editorFailed(ran.command, ran.got.failed);
    else {
      const e = ui.editor.current;
      // A marker is a span again when it names a picture the prompt held as the editor opened (release 6 design,
      // "Which pictures a message carries"): the editor's file is plain text.
      const d = change(e, 0, e.text.length, ran.got.text);
      ui.editor.current = { ...d, spans: spansIn(d.text, ids) };
      ui.goal.current = null;
      fns.freshText();
      ui.rerender((n) => n + 1);
    }
    fns.next();
  };
  // /settings and /keybindings open the real file, so each save reaches the watcher while the editor is still open
  // (plan, Task 12). A missing one is made first, `blank` in two-space JSON (choice 2), with a private file's mode,
  // 0o600 (auth/private.ts, writePrivate), never over one made meanwhile.
  const openFile = async (name: string, blank: object) => {
    const file = path.join(settingsDir(ui.home), name);
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      writeFileSync(file, `${JSON.stringify(blank, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const ran = await fns.away((command) => editFile(file, command));
    if (ran && "failed" in ran.got) fns.editorFailed(ran.command, ran.got.failed);
  };
  return {
    unselect, openDetail, closeDetail, printOut, reader, comeBack, switchScreen, away, editorFailed, externalEditor,
    openFile,
  };
};

type OutputArea = ReturnType<typeof output>;
type QueueArea = ReturnType<typeof queue>;
type PictureReadsArea = ReturnType<typeof pictureReads>;
type HandoverArea = ReturnType<typeof handover>;
type LiveEditsArea = ReturnType<typeof liveEdits>;
type KeyRoutingArea = ReturnType<typeof keyRouting>;
type MouseArea = ReturnType<typeof mouse>;
type PromptKeysArea = ReturnType<typeof promptKeys>;
// Every area's functions, as `fns` holds them (App, below). An interface, as an area's own `fns` names it, and the
// checker can then work out the areas' types without first working out this one (a type alias would be circular,
// TS2456).
export interface Fns {
  say: OutputArea["say"]; show: OutputArea["show"]; note: OutputArea["note"]; noteAlone: OutputArea["noteAlone"];
  make: OutputArea["make"]; lookUpWindow: OutputArea["lookUpWindow"];
  submit: QueueArea["submit"]; next: QueueArea["next"]; recordToOpen: QueueArea["recordToOpen"];
  perform: QueueArea["perform"]; tasksCommand: QueueArea["tasksCommand"]; recordOf: QueueArea["recordOf"];
  pick: QueueArea["pick"]; closePicker: QueueArea["closePicker"];
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
  scroll: MouseArea["scroll"]; selected: MouseArea["selected"]; copy: MouseArea["copy"]; onMouse: MouseArea["onMouse"];
  cellAt: MouseArea["cellAt"]; textRows: MouseArea["textRows"]; pressAt: MouseArea["pressAt"];
  clickAt: MouseArea["clickAt"]; dragTo: MouseArea["dragTo"];
  run: PromptKeysArea["run"]; command: PromptKeysArea["command"]; send: PromptKeysArea["send"];
  restore: PromptKeysArea["restore"]; clear: PromptKeysArea["clear"]; swapStash: PromptKeysArea["swapStash"];
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
    ui.bindAsk((text, detail, owner, plain) => {
      // A tool still finishing after Ctrl-C must not ask about a turn the user has stopped, nor a
      // stopped subagent about anything.
      const signal = owner ? owner.signal : ui.abort.current?.signal;
      if (signal?.aborted) return Promise.resolve(false);
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
            latest.current.say({ text: `${q.short ?? q.text}: ${how}`, color: "gray" });
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
    const onMessage = (m: Message) => latest.current.say(...describe(m));
    const onError = (e: ErrorEvent) => {
      if (e.kind === "tool") ui.rerender((n) => n + 1);
      else if (e.kind === "fallback") latest.current.say({ text: `↪ ${e.message}`, color: "magenta" });
      else latest.current.say({ text: `✗ ${e.kind}: ${e.message}`, color: "red" });
    };
    const onUsage = () => {
      ui.rerender((n) => n + 1);
      latest.current.lookUpWindow(false);
    };
    const onLead = (id: string) => {
      if (ui.leadFromFile.current) latest.current.note(gray(`lead is now ${id}${FROM}`));
      else latest.current.say({ text: `lead is now ${id}`, color: "magenta" });
      latest.current.lookUpWindow();
    };
    const onToolStart = ({ id, name, input }: Events["tool-start"][0]) => {
      ui.calls.current.push({ id, name, target: brief(name, input) });
      ui.rerender((n) => n + 1);
    };
    const onToolEnd = ({ id, outcome }: Events["tool-end"][0]) => {
      const call = ui.calls.current.find((c) => c.id === id);
      if (call) call.outcome = outcome;
      ui.rerender((n) => n + 1);
    };
    // A background subagent's ending is shown when it comes; its answer is read at once when idle.
    const onTasks = () => {
      for (const t of ui.tasks.all) {
        if (!t.background || t.state === "running" || t.state === "waiting" || ui.announced.current.has(t.id)) continue;
        ui.announced.current.add(t.id);
        latest.current.say({ text: `${t.id} ${t.state === "done" ? "finished" : t.state}`, color: "gray" });
      }
      ui.rerender((n) => n + 1);
      latest.current.next();
    };
    const onTodo = (items: TodoItem[]) => {
      ui.todos.current = { items, hidden: false };
      ui.rerender((n) => n + 1);
    };
    const onNote = (text: string) => latest.current.say(gray(text));
    ui.bus.on("message", onMessage);
    ui.bus.on("error", onError);
    ui.bus.on("usage", onUsage);
    ui.bus.on("lead", onLead);
    ui.bus.on("tool-start", onToolStart);
    ui.bus.on("tool-end", onToolEnd);
    ui.bus.on("todo", onTodo);
    ui.bus.on("tasks", onTasks);
    ui.bus.on("note", onNote);
    // The launch printed the settings file's warnings to stderr, which full screen hides until the user quits, so
    // they show here too (release 6 plan, Task 9, "The launch's warnings show in the session too"); in classic mode
    // stderr is seen, and they are not said twice.
    fns.say(...(ui.fullNow.current ? (ui.live?.loaded.warnings ?? []).map(gray) : []), ...ui.intro);
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
      // However the screen closes, /exit or Ctrl-C or Ctrl-D twice, no subagent goes on spending; nor does a turn, which
      // Ink ending on a drawing error would leave with nothing on screen.
      ui.tasks.stop();
      ui.abort.current?.abort();
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
    { isActive: !ui.picker },
  );

  // What the listeners set up once, at mount (the bus's, bindAsk's and the mouse's), call: the latest drawing's
  // functions, set at each, so what they read is the screen as last drawn, never what it was when they were set up
  // (release 6 design, "Tidying the screen code first"). Set while drawing, safe with Ink's non-concurrent root
  // (state.ts).
  const handlers = { say: fns.say, note: fns.note, noteAlone: fns.noteAlone, closeDetail: fns.closeDetail, comeBack: fns.comeBack, next: fns.next, lookUpWindow: fns.lookUpWindow, onMouse: fns.onMouse, onSettings: fns.onSettings, onKeys: fns.onKeys, settle: fns.settle, dropChord: fns.dropChords };
  const latest = useRef(handlers);
  latest.current = handlers;
  ui.drawn.latest = latest; // for newPicture's settle (pictureReads.ts)

  // The detail view drawn, which hides the prompt, its menu and what goes with them (release 5 plan, Task 12).
  const d = ui.detail.current;
  const prompt = ui.search.current ? fns.shown() : ui.editor.current;
  fns.staleVim(); // while drawing too, for a change no key made (a picture's read ending), safe as `copied` below says
  const highlight = ui.search.current ? undefined : visualSelection(ui.vim.current, prompt);
  const menu = ui.picker || ui.question || d ? null : fns.menuFor(prompt);
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
  const chord = ui.asked.current === (!!ui.question && !ui.picker) ? fns.chordKeys().waiting(Date.now()) : null;
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
      : d && !ui.picker
      ? keyRow(d, ui.table)
      : searching
      ? hints(
          searching,
          said(ui.keyOf("historySearch:next", "HistorySearch", "ctrl+r"), "older"),
          said(ui.keyOf("historySearch:execute", "HistorySearch", "enter"), "send"),
          said(ui.keyOf("historySearch:accept", "HistorySearch", "tab"), "edit"),
          "Ctrl-C cancel",
        )
        : ui.picker || ui.question
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
  const movable = ui.full && ui.question && !ui.picker && !ui.question.short; // a question that can still move into the conversation
  const f = frameOf({
    rows: ui.height,
    columns: ui.columns,
    full: ui.full,
    promptRows: laid.rows.length,
    cursorRow: laid.places.get(prompt.cursor)!.row,
    promptTop: ui.promptTop.current,
    working: ui.busy,
    toolLine: !ui.picker && ui.shownSegments.includes("tools") && ui.calls.current.length > 0,
    detail: d !== null,
    hint: hintFor(1) !== null, // whether there is a hint does not depend on the rows left (usualHint)
    menu: menu ? menu.entries.length : null,
    taskRows: (rows) => taskRows(ui.tasks.all, rows, ui.now),
    todoRows: (rows) => (!ui.todos.current.hidden && unfinished(ui.todos.current.items) ? todoRows(ui.todos.current.items, rows) : []),
    queued: ui.queue.current.length,
    pickerNeeded: ui.picker ? offered.length + (offered.some((r) => r.kind === "model") ? 0 : 1) : null,
    question: ui.question !== null,
    askedText: ui.full && ui.question && !ui.picker ? allow(ui.question.short ?? ui.question.text, ui.question.plain) : null,
    askedShort: movable ? allow(shortOf(ui.question), ui.question.plain) : null,
  });
  const { tooled, menuRows, panel, promptSpace, promptShown, todoShown, pickerRows, viewHeight, promptFirst } = f;
  ui.drawn.viewHeight = viewHeight; // for the functions that read it once the drawing is done (state.ts, drawn)
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
      fns.say({ text: `┌ ${ui.question.label} (${n} character${n === 1 ? "" : "s"})`, color: "gray" }, { text: ui.question.text, color: "gray" });
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
  if (ui.full && ui.question && !ui.picker && (ui.question.following === undefined || moved)) {
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
    promptRows: ui.picker || ui.question || ui.search.current || d ? 0 : promptShown,
    promptWindow: f.promptWindow,
    menuRows,
    editor: ui.editor.current,
    chosen: ui.chosen.current,
    detail: d,
    picker: ui.picker !== null,
    question: ui.question !== null,
  };
  // Where vim takes Esc first (vimFirst) the line names it twice; a key chat:cancel has with Ctrl or Alt never goes to
  // vim (choice 31).
  const stop = ui.keyOf("chat:cancel", "Chat", "escape");
  const escFirst = fns.vimFirst() && ui.table.keysFor("chat:cancel", "Chat").includes("escape");
  const workingLine = ui.busy && (
    <WorkingLine
      label={ui.doing.current.label}
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
      {ui.picker ? (
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
      ) : ui.question ? (
        ui.full ? (
          f.asked.map((r, i) => (
            <Text key={i} color="yellow" wrap="truncate-end">
              {r}
            </Text>
          ))
        ) : (
          <Text color="yellow">{allow(ui.question.text, ui.question.plain)}</Text>
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
