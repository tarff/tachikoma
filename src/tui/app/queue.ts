import { writeFileSync } from "node:fs";
import path from "node:path";
import { withLock } from "../../auth/lock.js";
import { leadGone, type Opened } from "../../clilib.js";
import { summarize } from "../../core/errorlog.js";
import { exportText } from "../../core/exportText.js";
import { type Protection, visible } from "../../core/permissions.js";
import { listSessions } from "../../core/sessions.js";
import type { Task } from "../../core/tasks.js";
import { errorText, type Provider } from "../../core/types.js";
import { KEYBINDINGS } from "../../keybindings.js";
import { dropIfNothing } from "../../sandbox/copies.js";
import { copyLock } from "../../sandbox/snapshot.js";
import { SETTINGS } from "../../settings.js";
import type { Fns } from "../App.js";
import { callLines, conversationLines, type Line } from "../describe.js";
import { type Draft, joined, trimmed } from "../pictures.js";
import { kept, type ReviewEnd } from "../Review.js";
import { taskRow } from "../TaskPanel.js";
import { FOLLOWING } from "../view.js";
import { characters, COMMANDS, EXPORT_WORDS, FROM, gray, isCommand, names, NOT_GONE, reviewUnopened, SESSION_WORDS } from "./constants.js";
import type { UI } from "./state.js";

export const queue = (ui: UI, fns: Fns) => {
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
    if (h.phase.kind === "ended" || h.phase.kind === "review" || h.working || h.waiting) return;
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
    // /resume's list too, which would open under the printed view (release 8a plan, Task 7).
    if (h.phase.kind === "printed" && command === 0 && (fns.recordToOpen(q[0]!.text) || /^\/(screen|resume)$/i.test(q[0]!.text))) return;
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
        return fns.leave();
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
      // The window's saved sessions (release 8a plan, Task 7). A name is the rest of the first line as typed, so none
      // holds a line break.
      const rest = text.slice(first.length).trim().split(/\r?\n/)[0]!.trim();
      if (command === "/rename") return fns.rename(rest);
      if (command === "/export") return fns.exportTo(rest);
      if (alone("/clear") || alone("/resume") || command === "/branch") {
        const refused = fns.subagentsRunning(command);
        if (refused) return fns.say(refused);
        if (command === "/resume") return fns.resume();
        if (command === "/branch") return fns.branch(rest);
        // The instruction files are read again meanwhile: what is typed waits in the queue, as during a turn.
        ui.working.current = true;
        try {
          return await fns.startFresh();
        } finally {
          ui.working.current = false;
        }
      }
      const account = command === "/login" ? "login" : command === "/logout" ? "logout" : undefined;
      // A mistyped command must not become a paid turn.
      // A slash and a bare word on its own is a command; "/tmp is full" is a message, "/exit now" is not.
      if (!account && !listing && /^\/[a-z]+$/i.test(text)) return fns.say({ text: `Unknown command: ${text}. Commands: ${COMMANDS}`, color: "red" });
      if (words.length && ["/exit", "/errors", "/model", "/screen", "/settings", "/keybindings", "/clear", "/resume"].includes(command))
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
            // (the user's choice, release 5): opening, it would end the paste hook (usePaste, App.tsx), and Ink would
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
        // The model may have switched branches. Through the Workspace, so it lands just after the turn ends (release 7
        // plan, Task 14).
        void ui.workspace.branch().then(ui.setBranch, (err) => fns.say({ text: errorText(err), color: "red" }));
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
  // Leaving the session (/exit, and Ctrl-C or Ctrl-D twice): Ink ends, as ever. In copy mode the box is stopped first,
  // with the turn and the subagents, and once Docker reports it gone the review (Review.tsx) opens in the App's place,
  // Ink still mounted, under the lock beside the copy's folder, so two reviews of one copy take turns; its lines are
  // handed back, to print once Ink has ended (release 7 plan, Task 21). From the first step the App's own keys, pastes
  // and mouse are off (phase.ts, review), and nothing more starts. A view printed out comes back first, so the review
  // can draw. A copy with nothing to review is removed instead, its line printed (choice 121; copies.ts, dropIfNothing).
  const leave = () => {
    const c = ui.copy;
    if (!c) return ui.exit();
    if (ui.leaving.current) return;
    ui.leaving.current = true;
    ui.tasks.stop();
    ui.abort.current?.abort();
    ui.rerender((n) => n + 1);
    void (async () => {
      await fns.comeBack();
      if (!(await c.stop())) return c.ended([NOT_GONE, kept(c.copy.session)]);
      await withLock(copyLock(c.copy.folder), async () => {
        // Nothing to review: no review, and the copy is removed (choice 121), before git's settings are read, as they
        // only matter to a review.
        const read = await dropIfNothing(c.copy, (line) => {
          ui.leavingLine.current = line;
          ui.rerender((n) => n + 1);
        }, c.remove);
        if (typeof read === "string") return c.ended([read]);
        // Without git's settings a hooks folder they name is not marked protected, so a file in it could be applied
        // unseen: no review, and the copy is kept (Task 21's review).
        let protection: Protection;
        try {
          protection = await c.protection();
        } catch (err) {
          return c.ended([visible(reviewUnopened(errorText(err))), kept(c.copy.session)]);
        }
        const end = await new Promise<ReviewEnd>((onEnd) => ui.setReviewing({ protection, onEnd, read }));
        c.ended(end.lines);
      });
    })()
      .catch((err) => c.ended([visible(errorText(err)), kept(c.copy.session)]))
      .finally(() => ui.exit());
  };
  // /clear, /resume and /branch are refused while a subagent runs, so no answer can arrive in the wrong session (release 8a
  // design, "Resuming"); during a turn they wait in the queue, as every command does. Null when none runs.
  const subagentsRunning = (command: string): Line | null => {
    const ids = ui.tasks.all.filter((t) => t.state === "running" || t.state === "waiting").map((t) => t.id).join(", ");
    return ids ? { text: `${command} waits until no subagent is running: ${ids} still running. /tasks stop stops them.`, color: "red" } : null;
  };
  // The window takes another session (release 8a plan, choice 15): the last one's shown calls, to-do list, answers and
  // tool line go, and the gauge's context, 0 until the next request. The subagents' waiting text is dropped: an answer
  // that wakes the lead was read in a turn of its own before this command ran (next), so what is left is a stopped
  // subagent's note, which belongs to the last conversation. The conversation is loaded first: a load refused, as one is
  // while a turn runs (a prompt read with /resume in one read of the terminal starts its turn under the list), lets the
  // next session go and leaves the turn's state as it was. Then the last session is let go, and the conversation drawn
  // as the launch draws a resumed one, and its lines said, so a saving failure the load reports comes first (Task 7). The
  // window's sandbox carries on: a copy-mode box is not started afresh, so its review at exit covers both sessions'
  // changes (Task 7).
  const switchTo = (next: Opened, lines: Line[]) => {
    try {
      ui.session.load(next.conversation);
    } catch (err) {
      next.release();
      throw err;
    }
    ui.saved.switched(next);
    ui.tasks.take();
    ui.calls.current = [];
    ui.todos.current = { items: [], hidden: false };
    ui.answered.current.clear();
    ui.stats.context = 0;
    fns.say(...conversationLines(next.conversation.messages), ...lines);
    ui.rerender((n) => n + 1);
  };
  // /clear: a new session, with the same lead and mode, its system prompt built afresh (design, "Resuming").
  const startFresh = async () => {
    const system = await ui.session.freshSystem();
    switchTo(ui.saved.fresh(ui.session.lead.id, system), [gray("Started a new session; the last one is kept (tachi --resume lists it).")]);
  };
  // /resume: the folder's other saved sessions, in the list `tachi -r` shows (choice 14). True when it opened, holding the
  // queue until a pick or Esc, as the model list does.
  const resume = (): boolean | void => {
    const rows = listSessions(ui.saved.dir, { print: false }).filter((r) => r.id !== ui.session.id);
    if (!rows.length) return fns.say(gray(SESSION_WORDS.noOther));
    ui.listOpen.current = true;
    ui.setSessions({ rows, now: Date.now() });
    return true;
  };
  // A pick opens the session as the launch opens it, a copy when another window holds it (Task 6); one that cannot be
  // read or copied is said in red, and the window stays in its session (design, "When something goes wrong"). It leads
  // with its saved lead, switched to as /lead switches, once its conversation is loaded; one that cannot be made leaves
  // the window's leading, with the launch's line (user, 2026-11-06: "The session's saved lead").
  const pickSession = (id: string) => {
    ui.listOpen.current = false;
    ui.setSessions(null);
    ui.view.current = FOLLOWING; // what it says is asked for, as the model list's pick says (pick, above)
    try {
      const now = ui.session.lead.id;
      let made: Provider | undefined;
      let gone: string | undefined;
      const next = ui.saved.resume(id, (saved) => {
        if (saved === now) return now;
        try {
          made = fns.make(saved);
          return saved;
        } catch (err) {
          gone = leadGone(saved, err, now);
          return now;
        }
      });
      if ("problem" in next) fns.say({ text: next.problem, color: "red" });
      else {
        switchTo(next, [...next.lines, ...(gone ? [{ text: gone }] : [])].map((l) => ({ ...l, color: "gray" })));
        if (made) {
          ui.waiting.current.lead = undefined; // it wins over a lead the settings file set meanwhile, as a /lead typed then would
          ui.session.setLead(made);
        }
      }
    } catch (err) {
      fns.say({ text: errorText(err), color: "red" });
    }
    fns.next();
  };
  const closeSessions = () => {
    ui.listOpen.current = false;
    ui.setSessions(null);
    fns.next();
  };
  // /branch [name]: a copy of this session, named, which the window carries on in (design, "Names, branches and export").
  // Without a name it takes the first prompt's first line, as the resume line names a session. A session with no
  // prompt has nothing to copy, and one whose saving stopped would leave out what came after.
  const branch = (name: string) => {
    const first = ui.session.prompts[0]?.split(/\r?\n/)[0];
    if (!first) return fns.say(gray(SESSION_WORDS.nothingToBranch));
    if (!ui.session.transcript || ui.session.transcript.failed !== null) return fns.say({ text: SESSION_WORDS.unsaved("/branch"), color: "red" });
    const original = ui.session.id;
    const named = name || first;
    const next = ui.saved.branch(original, ui.session.lead.id, named);
    if ("problem" in next) return fns.say({ text: next.problem, color: "red" });
    switchTo(next, [gray(`Branched: this window is now ${named}; the original is kept as ${original}.`)]);
  };
  // /rename <name> names this session in its transcript, as the lists then show it (design, "Names, branches and export").
  const rename = (name: string) => {
    if (!name) return fns.say({ text: "Usage: /rename <name>", color: "red" });
    const t = ui.session.transcript;
    t?.write({ t: "name", name });
    fns.say(!t || t.failed !== null ? { text: SESSION_WORDS.unsaved("/rename"), color: "red" } : gray(`Session named ${name}.`));
  };
  // /export [file]: the conversation as text (core/exportText.ts), a reply saved without its lead headed by the one leading
  // now. To a file, from the project folder, made with `wx` so one already there is never written over (release 8a plan,
  // choice 27); alone, to the clipboard, whose own failure line follows in the hint row as a selection's copy's does
  // (clipboard.ts).
  const exportTo = (file: string) => {
    const text = exportText(ui.session.messages, ui.session.lead.id);
    if (!file) {
      ui.board.current!.copy(text);
      return fns.say(gray(`Copied the conversation (${characters(text)} characters).`));
    }
    const to = path.resolve(ui.root, file);
    try {
      writeFileSync(to, text, { flag: "wx" });
    } catch (err) {
      const there = (err as NodeJS.ErrnoException).code === "EEXIST";
      return fns.say({ text: there ? `${to} already exists; nothing was written.` : EXPORT_WORDS.unwritten(to, errorText(err)), color: "red" });
    }
    fns.say(gray(`Exported to ${to}.`));
  };
  return {
    submit, next, recordToOpen, perform, tasksCommand, recordOf, pick, closePicker, leave, subagentsRunning, startFresh, resume,
    pickSession, closeSessions, branch, rename, exportTo,
  };
};
