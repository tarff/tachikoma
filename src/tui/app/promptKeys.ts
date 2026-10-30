import type { Key } from "ink";
import type { Fns } from "../App.js";
import { lastTurn } from "../describe.js";
import { apply, type Editor, load, move, replace } from "../editor.js";
import { matches } from "../history.js";
import { type Command, commands, isScroll, keyList } from "../keys.js";
import { vertical } from "../layout.js";
import { commandMenu, listFolder, type Menu as MenuData, pathMenu } from "../menus.js";
import type { Now } from "../phase.js";
import { joined, trimmed } from "../pictures.js";
import { promptWidth } from "../Prompt.js";
import { FOLLOWING } from "../view.js";
import { contextsOf, type Got } from "./constants.js";
import type { UI } from "./state.js";

export const promptKeys = (ui: UI, fns: Fns) => {
  // Scroll's actions come only in full screen, where Scroll is in force (contextsOf, constants.ts).
  const run = (c: Command) => {
    if (isScroll(c)) return fns.scroll(c);
    const e = ui.editor.current;
    const menu = fns.menuFor(e);
    if (menu && (c === "up" || c === "down")) {
      ui.chosen.current = { text: e.text, at: Math.max(0, Math.min(menu.entries.length - 1, fns.chosenIn(e, menu) + (c === "up" ? -1 : 1))) };
      return;
    }
    if (menu && c === "submit") return menu.kind === "command" ? fns.send(load(e, menu.entries[fns.chosenIn(e, menu)]!.run!)) : fns.fill(menu, e);
    if (c === "mode") {
      ui.perm.current = ui.cycle[(ui.cycle.indexOf(ui.perm.current) + 1) % ui.cycle.length]!;
      ui.onMode(ui.perm.current);
      return fns.show({ text: `mode is now ${ui.perm.current}`, color: "gray" });
    }
    // Alt+P is `/model` typed then: during a turn it waits in the queue, and like Enter it goes to the bottom.
    if (c === "models") return fns.command("/model");
    if (c === "lastTurn") return ui.fullNow.current ? fns.openDetail(lastTurn(ui.session.messages)) : fns.show(...lastTurn(ui.session.messages)); // release 5 plan, Task 12
    if (c === "todos") return void (ui.todos.current.hidden = !ui.todos.current.hidden);
    // A message starting with `?` needs a space typed first.
    if (typeof c === "object" && c.type === "insert" && c.text === "?" && !e.text)
      return fns.show(...keyList(ui.table, contextsOf("prompt", ui.fullNow.current), fns.vimFirst(), ui.launchKeys.current).map((text) => ({ text, color: "gray" })));
    if (c === "up" && !e.text && ui.queue.current.length) return fns.restore();
    if (c === "up" || c === "down") {
      const to = vertical(e.text, promptWidth(ui.columns), e.cursor, c === "up" ? -1 : 1, ui.goal.current);
      if (to) {
        ui.editor.current = move(e, to.cursor);
        ui.goal.current = to.goal;
      } else fns.recall(c === "up" ? -1 : 1);
      return;
    }
    ui.goal.current = null;
    if (c === "search") {
      ui.search.current = { query: "", skip: 0, before: e };
      ui.step.current = null;
    } else if (c !== "submit") ui.editor.current = apply(e, c);
    // A backslash before Enter makes a new line in every terminal, in place of the backslash.
    else if (e.text.slice(0, e.cursor).endsWith("\\")) ui.editor.current = apply(apply(e, "backspace"), "newline");
    else fns.send(e);
  };

  // A key bound to command:<name>, and Alt+P's /model, run the command as if typed then, the prompt's text left as it
  // is: during a turn it waits in the queue (choice 21).
  const command = (text: string) => {
    if (ui.working.current) return void ui.queue.current.push({ text, spans: [] });
    ui.view.current = FOLLOWING;
    void fns.submit({ text, spans: [] });
  };
  // The prompt goes with its pictures' spans; prompt history keeps its text only (release 6 plan, Task 14).
  const send = (e: Editor) => {
    ui.view.current = FOLLOWING; // sending a prompt goes to the bottom (release 5 design, "Scrolling")
    fns.keep(e.text);
    ui.editor.current = load(e, "");
    fns.freshText();
    if (!ui.working.current) void fns.submit(e);
    else if (e.text.trim()) ui.queue.current.push(trimmed(e));
  };
  // Ctrl-C during a turn, or Up on an empty prompt: the queue comes back into the prompt, one entry a
  // line, after what is there, to edit or send, with its pictures' spans.
  const restore = () => {
    if (!ui.queue.current.length) return;
    const back = joined([ui.editor.current, ...ui.queue.current].filter((d) => d.text), "\n");
    ui.editor.current = { ...load(ui.editor.current, back.text), spans: back.spans };
    ui.queue.current = [];
    fns.freshText();
  };
  const clear = (e: Editor) => {
    fns.keep(e.text);
    ui.editor.current = load(e, "");
    fns.freshText();
  };
  // Ctrl+S (release 6 design, "Stash"): a prompt with text goes into the slot whole, cursor and undo steps with it, and
  // an empty prompt takes the slot back; with text and a full slot the two swap, so nothing is lost (the design's
  // call). What the last delete took stays with the prompt, as load() keeps it. `typing: false`, so what is typed after
  // a restore is an undo step of its own, not part of the stashed prompt's last one. Where Up had got to goes with the
  // prompt and comes back with it, so the draft Up keeps is never dropped: after the line Up showed comes back, Down
  // past the newest brings the draft back (choice 31).
  const swapStash = (e: Editor) => {
    const back = ui.stash.current;
    if (!e.text && !back) return;
    ui.stash.current = e.text || ui.step.current ? { prompt: e, step: ui.step.current } : null;
    ui.editor.current = back ? { ...back.prompt, typing: false, killed: e.killed } : load(e, "");
    ui.goal.current = null;
    ui.step.current = back?.step ?? null;
    fns.freshText();
  };
  // Saved for Up and Ctrl+R, in this session and later ones: each sent prompt, and one cleared with
  // Ctrl-C or Esc Esc. The same prompt twice in a row is kept once, as Claude Code keeps it.
  const keep = (raw: string) => {
    const text = raw.trim();
    if (text && ui.history.current!.entries.at(-1) !== text) void ui.history.current!.add(text);
    ui.step.current = null;
  };

  // Up from the prompt's first row steps back through the history, Down from its last row forward,
  // and past the newest prompt back to what was being typed. A prompt comes back with the cursor at
  // its end.
  const recall = (dir: -1 | 1) => {
    const { entries } = ui.history.current!;
    const e = ui.editor.current;
    const at = (ui.step.current?.at ?? entries.length) + dir;
    ui.goal.current = null;
    if (at < 0 || (!ui.step.current && dir === 1)) return;
    fns.freshText();
    if (at < entries.length) {
      ui.step.current = { at, draft: ui.step.current?.draft ?? { text: e.text, spans: e.spans } };
      ui.editor.current = load(e, entries[at]!);
    } else {
      ui.editor.current = { ...load(e, ui.step.current!.draft.text), spans: ui.step.current!.draft.spans };
      ui.step.current = null;
    }
  };

  // The `/` or `@` menu for the prompt as it is, unless Esc closed it at this text. A folder is listed
  // again when the menu opens again, so it shows what is there then.
  const menuFor = (e: Editor): MenuData | null => {
    if (ui.closed.current !== e.text) ui.closed.current = null;
    if (ui.search.current || ui.closed.current !== null) return null;
    return commandMenu(e.text, e.cursor) ?? pathMenu(e.text, e.cursor, fns.list);
  };
  const list = (folder: string) => {
    if (ui.listed.current?.folder !== folder) ui.listed.current = { folder, listing: listFolder(ui.root, folder) };
    return ui.listed.current.listing;
  };
  const chosenIn = (e: Editor, m: MenuData) => Math.min(ui.chosen.current.text === e.text ? ui.chosen.current.at : 0, m.entries.length - 1);
  // Tab, and Enter on a path: the chosen entry in place of what it completes.
  const fill = (m: MenuData, e: Editor) => {
    const entry = m.entries[fns.chosenIn(e, m)]!;
    if (!entry.error) ui.editor.current = replace(e, m.from, entry.fill);
  };

  // What the search shows in the prompt: the match, with the cursor at its end, or, with no match,
  // the prompt as it was.
  const shown = (): Editor => {
    const s = ui.search.current!;
    const match = matches(ui.history.current!.entries, s.query)[s.skip];
    return match === undefined ? s.before : load(s.before, match);
  };
  const endSearch = (e: Editor) => {
    ui.search.current = null;
    ui.editor.current = e;
    fns.freshText();
  };
  // Ctrl+R's keys, as Claude Code's search has them (interactive-mode.md): typing searches, Ctrl+R
  // finds an older match, Enter sends the match, Tab or Esc puts it in the prompt to edit, and Ctrl-C,
  // or Backspace with nothing searched for, gives back what was typed before. In full screen the conversation behind
  // the search scrolls (the user's choice, release 5); in classic mode Scroll is not in force, and the scroll keys do
  // nothing here, as in release 4.
  const searchKey = (h: Now, got: Got, ch: string, key: Key) => {
    const s = ui.search.current!;
    if (got && "typed" in got) return void Object.assign(s, { query: s.query + got.typed, skip: 0 });
    if (got && "pending" in got) return;
    const a = got?.action;
    if (a === "historySearch:cancel") return fns.endSearch(s.before);
    if (a === "historySearch:accept") return fns.endSearch(fns.shown());
    if (a === "historySearch:next") return void (s.skip = Math.max(0, Math.min(s.skip + 1, matches(ui.history.current!.entries, s.query).length - 1)));
    if (a === "historySearch:execute") {
      const e = fns.shown();
      fns.endSearch(e);
      return fns.send(e);
    }
    if (a) return fns.everywhere(a, h);
    for (const c of commands(ch, key)) {
      if (typeof c === "object") Object.assign(s, { query: s.query + c.text, skip: 0 });
      else if (c === "backspace" && !s.query) return fns.endSearch(s.before);
      else if (c === "backspace") Object.assign(s, { query: [...s.query].slice(0, -1).join(""), skip: 0 });
      else if (c === "submit") {
        const e = fns.shown();
        fns.endSearch(e);
        return fns.send(e);
      }
    }
  };
  return {
    run, command, send, restore, clear, swapStash, keep, recall, menuFor, list, chosenIn, fill, shown, endSearch,
    searchKey,
  };
};
