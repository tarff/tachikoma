import { summarize } from "../../core/errorlog.js";
import type { Task } from "../../core/tasks.js";
import { errorText } from "../../core/types.js";
import { KEYBINDINGS } from "../../keybindings.js";
import { SETTINGS } from "../../settings.js";
import type { Fns } from "../App.js";
import { callLines, type Line } from "../describe.js";
import { type Draft, joined, trimmed } from "../pictures.js";
import { taskRow } from "../TaskPanel.js";
import { FOLLOWING } from "../view.js";
import { COMMANDS, FROM, gray, isCommand, names } from "./constants.js";
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
