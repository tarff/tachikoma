import type { Key } from "ink";
import { errorText } from "../../core/types.js";
import type { Fns } from "../App.js";
import { Bindings, CHORD_MS, type Context, type Stroke, strokeOf } from "../bindings.js";
import { type Detail, searchFor, step as stepMatch } from "../DetailView.js";
import { segmenter } from "../editor.js";
import { commands, isScroll, keyList, pieces, vimKey } from "../keys.js";
import type { Now, Phase } from "../phase.js";
import { press as vimPress } from "../vim.js";
import { ACTIONS, contextsOf, DOUBLE_PRESS_MS, type Got, gray, MOVES, NOTHING, printable } from "./constants.js";
import type { UI } from "./state.js";

export const keyRouting = (ui: UI, fns: Fns) => {
  // Who takes a key (release 6 plan, Task 6): while a field is typed (a Ctrl+R query, a detail-view search, the model
  // list's filter), a printable key goes into it, after a chord under way (lookUp). Keys match the table exactly
  // (choice 20, the user's: "Exact match"), but in classic mode Shift+Up and Shift+Down are Up and Down, as release 4
  // read them (release 5 plan, choice 16); Ctrl+Home and Ctrl+End reach the editor's Home and End there (keys.ts,
  // commands). Text read together is no keystroke, and drops a chord under way, as any other key would.
  const route = (kind: Phase["kind"], field: boolean, ch: string, key: Key): Got => {
    let stroke = strokeOf(ch, key);
    if (!stroke) {
      fns.dropChords();
      return null;
    }
    // Two Escs read together reach Ink as one Esc with Alt (Ink's parse-keypress.js), which release 5 took as Esc; the
    // kitty protocol, which marks each key with its eventType, sends them apart (choice 20).
    if (stroke.key === "escape" && stroke.alt && key.eventType === undefined) stroke = { ...stroke, alt: false };
    if (!ui.fullNow.current && stroke.shift && !stroke.ctrl && !stroke.alt && (stroke.key === "up" || stroke.key === "down")) stroke = { ...stroke, shift: false };
    // At the prompt in vim mode, Esc in INSERT or VISUAL, and a key without Ctrl or Alt while a vim command is half
    // typed, go to vim before any binding, as a field's text does (plan, Task 6), so Esc there is never chat:cancel.
    // What is half typed is asked once text App changed since has dropped it (staleVim).
    fns.staleVim();
    const v = ui.vim.current;
    const toVim =
      v !== null &&
      (kind === "prompt" || kind === "menu") &&
      !stroke.ctrl &&
      !stroke.alt &&
      (v.pending !== "" || v.count !== "" || (stroke.key === "escape" && v.mode !== "NORMAL"));
    return fns.lookUp(stroke, contextsOf(kind, ui.fullNow.current), (field && printable(stroke)) || toVim ? ch : null, kind === "question");
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
    if (question !== ui.asked.current) fns.dropChords();
    ui.asked.current = question;
    const read = (keys: Bindings): Got => {
      const chord = keys.waiting(at) && keys.press(stroke, contexts, at);
      if (chord) return chord;
      if (typed !== null) return { typed };
      return keys.press(stroke, contexts, at);
    };
    const launch = ui.launchKeys.current;
    if (question) return fns.pressed(read(launch));
    const got = read(ui.table);
    const atLaunch = launch === ui.table ? got : read(launch);
    const cycles = (g: Got) => g !== null && "action" in g && g.action === "chat:cycleMode";
    return cycles(got) && !cycles(atLaunch) ? NOTHING : fns.pressed(got);
  };
  // The table a chord may be waiting in, for the hint row: the launch's after a stroke read at a question (lookUp).
  const chordKeys = () => (ui.asked.current ? ui.launchKeys.current : ui.table);
  const dropChords = () => {
    ui.table.drop();
    ui.launchKeys.current.drop();
  };
  // A chord's first strokes show in the hint row until the next key or 3 s (release 6 design, "The keys file").
  const pressed = (got: Got) => {
    if (got && "pending" in got) {
      clearTimeout(ui.chordTimer.current);
      ui.chordTimer.current = setTimeout(() => ui.rerender((n) => n + 1), CHORD_MS);
    }
    return got;
  };

  // Once Ink has ended no key comes here, nor a paste or a mouse report (App.tsx, mouse.ts): Ink's cleanup takes their
  // listeners away with the App's, which sets `ended` (App.tsx). It is checked all the same, as the first phase, which
  // hides the others.
  const onInput = (ch: string, key: Key) => {
    const h = ui.happening(() => fns.menuFor(ui.editor.current) !== null);
    if (h.phase.kind === "ended" || h.phase.kind === "printed") return; // printed out: a key read with the `[` that printed the view out
    ui.clearCopied();
    ui.notes.current = []; // a live edit's lines leave the hint row at the next key (note, output.ts)
    const field = h.phase.kind === "search" || h.phase.kind === "picker" || (h.phase.kind === "detail" && h.phase.searching);
    fns.onKey(h, fns.route(h.phase.kind, field, ch, key), ch, key);
  };
  // What a key does in each phase. `ch` and `key` are for a key no binding takes (`got` null), which the prompt's
  // editor, a field or the model list may still take; and for Ctrl-C, which is reserved (bindings.ts, RESERVED), so
  // the detail view's rule for it stays its own.
  const onKey = (h: Now, got: Got, ch: string, key: Key) => {
    const action = got && "action" in got ? got.action : null;
    const kind = h.phase.kind;
    if (kind === "prompt" || kind === "menu") return fns.promptKey(h, got, ch, key);
    fns.dropRemap();
    // Any other key starts the press-twice count again, as at the prompt (below).
    if (action !== "app:exit") fns.forget();
    if (kind === "picker") {
      const to = ui.pickerKey.current;
      if (got && "typed" in got) to?.({ text: got.typed });
      else if (action === "app:interrupt") to?.({ action: "select:cancel" }); // Ctrl-C closes the list, as Esc does
      else if (action?.startsWith("select:")) to?.({ action });
      else if (action) fns.everywhere(action, h);
      else if (!got && (key.backspace || key.delete)) to?.("backspace");
      else if (!got && !key.ctrl && !key.meta && ch) to?.({ text: ch }); // typed text read together, or a paste (usePaste, App.tsx)
    } else if (kind === "question") {
      // Ctrl-C declines the question and stops its owner only: the lead's turn, or that subagent. A plain question's
      // answer is logged as yes or no, a permission's as allowed or declined (Task 18's code review).
      const [yes, no] = ui.question!.plain ? ["yes", "no"] : ["allowed", "declined"];
      if (action === "app:interrupt") {
        ui.question!.answer(false, `${no} (cancelled)`);
        if (ui.question!.owner) ui.question!.owner.stop();
        else {
          ui.abort.current?.abort();
          fns.restore();
        }
      } else if (action === "confirm:yes" || action === "confirm:no") {
        // Esc, as n: that action only; the turn goes on
        ui.question!.answer(action === "confirm:yes", action === "confirm:yes" ? yes : no);
      } else if (action) fns.everywhere(action, h);
    } else if (kind === "detail") fns.detailKey(ui.detail.current!, h, got, ch, key);
    else if (kind === "search") fns.searchKey(h, got, ch, key);
    ui.rerender((n) => n + 1);
  };
  // Global's actions, and Scroll's in full screen, outside the prompt: wherever Global is in force (choice 19, the
  // user's: "All three everywhere"). The detail view closes on app:toggleTranscript itself (detailKey), and each phase
  // keeps its own rule for app:interrupt, Ctrl-C being reserved. Scroll is in force at a question too, where a long
  // detail can be read before answering.
  const everywhere = (action: string, h: Now) => {
    if (action === "app:exit") return fns.twice("Ctrl-D", h);
    const c = ACTIONS[action];
    if (c === "todos" || c === "lastTurn" || (c && isScroll(c))) fns.run(c);
  };
  // Ctrl-D (app:exit) twice on an empty prompt exits, never during a turn (release 3 design); outside the prompt too,
  // and only with nothing typed in it, hidden or not, so no draft is lost unseen.
  const twice = (name: string, h: Now) => {
    if (h.working || ui.editor.current.text) return;
    const again = ui.first.current?.name === name;
    fns.forget();
    if (again) ui.exit();
    else fns.remember(name);
  };

  // The prompt's keys, a menu's among them. Esc (chat:cancel), Ctrl-C (app:interrupt) and Ctrl-D (app:exit) on an
  // empty prompt keep release 3's rules: during a turn the prompt still edits; Esc stops the turn and the queue goes
  // on, Ctrl-C stops it and the queue comes back. Ctrl-D does not exit while a turn is running; with text it deletes
  // the character after the cursor, as before. The rest run as commands (ACTIONS), and a key no binding takes goes to
  // the editor, or in vim mode to vim first (vimTakes).
  const promptKey = (h: Now, got: Got, ch: string, key: Key) => {
    const action = got && "action" in got ? got.action : null;
    const v = ui.vim.current;
    const stroke = strokeOf(ch, key);
    // Claude Code's vim hook leaves VISUAL on any Ctrl or Meta key, and its text field then takes no editing key from
    // it (2.1.312's `if(a.ctrl||a.meta){if(l.mode==="VISUAL"){...;a.preventDefault();return}`), so here the table's
    // action still acts and the editor's own keys do nothing (plan, choice 27). Leaving is Esc with nothing half typed.
    if (v?.mode.startsWith("VISUAL") && stroke && (stroke.ctrl || stroke.alt) && stroke.key !== "escape") {
      const out = vimPress({ ...v, pending: "", count: "" }, ui.editor.current, "escape");
      ui.vim.current = out.v;
      ui.editor.current = out.e;
      if (!got) return ui.rerender((n) => n + 1);
    }
    if (fns.vimTakes(got, ch, key)) {
      fns.forget(); // any other key starts the press-twice count again (below)
      return ui.rerender((n) => n + 1);
    }
    fns.dropRemap();
    const e = ui.editor.current;
    if (action === "autocomplete:accept" || action === "autocomplete:dismiss") {
      if (action === "autocomplete:dismiss") ui.closed.current = e.text;
      else fns.fill(fns.menuFor(e)!, e); // the menu happening() found: the same text, its folder's listing kept (menuFor, list)
      fns.forget();
      return ui.rerender((n) => n + 1);
    }
    const name = action === "chat:cancel" ? "Esc" : action === "app:interrupt" ? "Ctrl-C" : action === "app:exit" && !e.text ? "Ctrl-D" : null;
    // While a message waits on its pictures' reads, Esc and Ctrl-C end those reads, and it goes without them (release 6
    // plan, choice 17), so a reader that never answers cannot hold the prompt.
    if (h.working && name && name !== "Ctrl-D" && ui.reading.current) {
      fns.stopReads();
      return ui.rerender((n) => n + 1);
    }
    if (h.working && name) {
      if (name === "Ctrl-C") fns.restore();
      if (name !== "Ctrl-D") ui.abort.current?.abort();
      return ui.rerender((n) => n + 1);
    }
    const again = name !== null && ui.first.current?.name === name;
    fns.forget();
    if (action === "app:exit" && e.text) fns.run("delete");
    else if (!name) {
      if (action && ACTIONS[action]) fns.run(ACTIONS[action]);
      // Called without await, so nothing may escape (submit, App.tsx): what goes wrong is said, as for a switch (next).
      else if (action === "chat:externalEditor") void fns.externalEditor().catch((err) => fns.say({ text: errorText(err), color: "red" }));
      else if (action === "chat:stash") fns.swapStash(e);
      else if (action === "chat:imagePaste") fns.imagePaste(e);
      else if (action?.startsWith("command:")) fns.command(`/${action.slice("command:".length)}`);
      else if (!got) for (const c of commands(ch, key)) fns.run(c);
    } else if (name === "Ctrl-C" && e.text) fns.clear(e); // one press clears
    else if (!again) fns.remember(name);
    else if (name !== "Esc") return ui.exit();
    else if (e.text) fns.clear(e); // Esc Esc; on an empty prompt it does nothing
    ui.rerender((n) => n + 1);
  };
  // Vim mode at the prompt (release 6 plan, Task 21): a key route() sent to vim first (`typed`), or one no binding
  // takes and not held with Ctrl or Alt; in INSERT only a typed character and Esc, the rest being the editor's
  // (commands), and `?` on an empty prompt still lists the keys (run). Text read together is a key a character, each
  // from the top, so a fast `dw` is two keys, and a `/` among them opens the search the rest go into (design, "Vim
  // mode"). The remaps are the settings file's as now, so an edit applies from the next key. True when vim took it.
  const vimTakes = (got: Got, ch: string, key: Key): boolean => {
    const v = ui.vim.current;
    if (!v || (got && !("typed" in got))) return false;
    const each = pieces(ch);
    if (!got && !key.ctrl && !key.meta && each.length > 1) {
      for (const p of each) {
        fns.onInput(p, p === "\r" ? { ...key, return: true } : { ...key, shift: p !== p.toLowerCase() });
      }
      return true;
    }
    const k = vimKey(ch, key);
    const e = ui.editor.current;
    // A character typed is one character on screen; a key's name ("left", "tab", "escape") is several letters.
    const typed = k !== null && pieces(k).length === 1;
    if (k === null || (v.mode === "INSERT" && k !== "escape" && (!typed || (k === "?" && !e.text)))) return false;
    const r = vimPress(v, e, k, { pairs: ui.fileNow.current.vimInsertModeRemaps ?? {}, now: Date.now() });
    ui.vim.current = r.v;
    ui.editor.current = r.e;
    ui.vimText.current = r.e.text;
    ui.goal.current = null;
    if (r.act === "help") fns.show(...keyList(ui.table, contextsOf("prompt", ui.fullNow.current), fns.vimFirst(), ui.launchKeys.current).map(gray));
    else if (r.act) fns.run(r.act === "submit" ? "submit" : ACTIONS[r.act]!); // history:previous, :next or :search
    return true;
  };
  // VISUAL's anchor is a place in the text as vim's last key left it, and a command or count half typed was typed for
  // that text. Once App changes the text (a message sent, a recall, a paste, a picture's marker taken out...), VISUAL
  // goes to NORMAL and what was half typed is dropped, so no selection, nor `o`'s jump to the anchor, reaches into text
  // that is gone, and no `d` typed for one text deletes from another; moving the cursor alone keeps them (code review of
  // Task 21; choice 27; the final review).
  const staleVim = () => {
    const v = ui.vim.current;
    if (!v || ui.editor.current.text === ui.vimText.current) return;
    if (v.mode.startsWith("VISUAL")) {
      const { anchor, ...rest } = v;
      ui.vim.current = { ...rest, mode: "NORMAL", pending: "", count: "" };
    } else if (v.pending || v.count) ui.vim.current = { ...v, pending: "", count: "" };
  };
  // Vim takes a plain Esc first in INSERT and VISUAL, and while a command or count is half typed (route), so the first
  // Esc only goes to NORMAL and the working line and `?` name the Esc that stops or clears after it (choice 31).
  const vimFirst = () => {
    const v = ui.vim.current;
    return v !== null && (v.mode !== "NORMAL" || v.pending !== "" || v.count !== "");
  };
  // Claude Code ends a remap pair's wait at every key (its cancelPendingRemap): `press` ends it at the keys it takes,
  // and App at the rest (plan, Task 21).
  const dropRemap = () => {
    if (!ui.vim.current?.remap) return;
    const { remap, ...rest } = ui.vim.current;
    ui.vim.current = rest;
  };
  // New text in the prompt (a message sent, a history recall, the editor's text back...) drops where vim's INSERT began
  // its typing, so `.` takes what is typed next from its first character (plan, Task 21).
  const freshText = () => {
    if (!ui.vim.current?.entered) return;
    const { entered, ...rest } = ui.vim.current;
    ui.vim.current = rest;
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
    if (ui.detail.current !== d || ui.printed.current) return;
    const s = d.search;
    if (!got) {
      // Enter is no action here, and keys.ts leaves it to chat:submit: it keeps a search being typed, as before.
      for (const c of key.return ? ["submit" as const] : commands(ch, key)) {
        if (ui.detail.current !== d || ui.printed.current) return;
        if (typeof c === "object")
          for (const letter of c.text) {
            const as = { ...key, shift: letter !== letter.toLowerCase() };
            const one = fns.route("detail", d.search?.typing === true, letter, as);
            if (one) fns.detailKey(d, h, one, letter, as);
          }
        else if (s?.typing && c === "backspace") searchFor(d, s.query.slice(0, [...segmenter.segment(s.query)].at(-1)?.index ?? 0), ui.drawn.viewHeight);
        else if (s?.typing && c === "submit") {
          if (s.found.length) s.typing = false;
          else d.search = null;
        }
      }
      return;
    }
    if ("typed" in got) return searchFor(d, s!.query + got.typed, ui.drawn.viewHeight);
    if ("pending" in got) return;
    const a = got.action;
    const move = MOVES[a];
    if ((a === "transcript:exit" || a === "app:interrupt") && key.ctrl && ch === "c") {
      if (!h.working) fns.closeDetail();
      else {
        fns.restore();
        ui.abort.current?.abort();
      }
    } else if (a === "transcript:exit" && s?.typing) {
      d.view.current = s.before;
      d.search = null;
    } else if (a === "transcript:exit" || a === "app:toggleTranscript") fns.closeDetail();
    else if (a === "transcript:print" && ui.input && !ui.owner.suspended) void fns.printOut(d); // switchScreen says why
    else if (a === "transcript:search") d.search = { query: "", found: [], at: 0, typing: true, before: d.view.current };
    else if ((a === "transcript:nextMatch" || a === "transcript:previousMatch") && s) stepMatch(d, a === "transcript:nextMatch" ? 1 : -1, ui.drawn.viewHeight);
    else if (move) fns.scroll(move);
    else fns.everywhere(a, h);
  };

  // Esc, Ctrl-C and Ctrl-D count twice when the second press comes within 800 ms of the first, the
  // window Claude Code's docs give for Ctrl+D. Any other key in between starts the count again.
  const remember = (name: string) => {
    const timer = setTimeout(() => {
      ui.first.current = null;
      ui.rerender((n) => n + 1);
    }, DOUBLE_PRESS_MS);
    ui.first.current = { name, timer };
  };
  const forget = () => {
    clearTimeout(ui.first.current?.timer);
    ui.first.current = null;
  };
  return {
    route, lookUp, chordKeys, dropChords, pressed, onInput, onKey, everywhere, twice, promptKey, vimTakes, staleVim,
    vimFirst, dropRemap, freshText, detailKey, remember, forget,
  };
};
