import type { Fns } from "../App.js";
import { gapped, type Line, notice, screen as escaped } from "../describe.js";
import { arrived, FOLLOWING } from "../view.js";
import type { UI } from "./state.js";

export const output = (ui: UI, fns: Fns) => {
  // In full screen the lines go to the view's rows too, and a view held away from the bottom counts them (release 5
  // design, "Scrolling"); setting `lines` draws them either way. One empty line goes before a block, unless it is the
  // first line said or the line before it is empty already (TUI design pass, Task 3). A slash command's first line said
  // starts its output's block (the user's choice at Task 3's review; queue.ts, perform); a line said meanwhile that is a
  // block of its own, as a reply arriving during /screen's switch, leaves that to the next.
  const say = (...add: Line[]) => {
    ui.toolLine.current = null; // a tool line's own message sets it again after (App.tsx, onMessage; release 7 plan, choice 66)
    const marked = add.map((l) => {
      if (!ui.command.current || l.block) return l;
      ui.command.current = false;
      return { ...l, block: true as const };
    });
    const spaced = gapped(marked, ui.lastSaid.current);
    if (marked.length) ui.lastSaid.current = marked.at(-1)!;
    const shown = spaced.map(escaped);
    if (ui.fullNow.current) {
      const before = ui.kept.lines.length;
      ui.kept.add(shown);
      ui.view.current = arrived(ui.view.current, ui.kept.lines.length - before);
    } else ui.unkept.current.push(...shown);
    ui.setLines((l) => [...l, ...shown.map((x) => ({ ...x, id: ui.nextId.current++ }))]);
  };
  // What the user asks to see (the key list, the mode, `/model`) brings the view to the bottom, following, so it is seen;
  // output arriving on its own leaves a held view where it is (the user's choice, release 5). The last turn opens the
  // detail view instead (release 5 plan, Task 12).
  const show = (...add: Line[]) => {
    ui.view.current = FOLLOWING;
    fns.say(...add);
  };
  // A live edit's lines go to the conversation as notices (TUI design pass, Task 3), and to the hint row as they are; a
  // red one, a problem with the edit, is an error, a block without the grey dot (Task 3's review).
  const note = (...add: Line[]) => {
    fns.say(...add.map((l) => (l.color === "red" ? { ...l, block: true as const } : notice(l, ui.palette))));
    ui.notes.current = [...(ui.newEdit.current ? [] : ui.notes.current), ...add.map(escaped)];
    ui.newEdit.current = false;
  };
  const noteAlone = (line: Line) => {
    ui.newEdit.current = true;
    fns.note(line);
  };
  // The open run of quiet calls said, at a question, the turn's end or Esc (release 8c plan, choice 65): its row, then the
  // asked call's own row, which the question's answer goes under (App.tsx, bindAsk).
  const endRun = (asked?: string) => {
    const { lines, under } = ui.run.question(asked);
    if (lines.length) fns.say(...lines);
    if (under) ui.toolLine.current = asked!;
  };
  // Every model made in the session takes a changed effort (release 6 plan, Task 9).
  const make = (spec: string) => {
    const provider = ui.makeProvider(spec);
    if (ui.effortNow.current) provider.setEffort?.(ui.effortNow.current.effort);
    return provider;
  };

  // Only the latest lookup's answer is shown: a late one, for the previous lead or from before a
  // request, must not replace it. Asked again after each request, without clearing what is shown: a
  // ChatGPT plan's window is known only once a request has fetched the account's model list.
  const lookUpWindow = (fresh = true) => {
    const asked = ++ui.lookups.current;
    if (fresh) ui.setContextWindow(null);
    ui.session.lead.contextWindow?.()
      .then((n) => asked === ui.lookups.current && ui.setContextWindow(n))
      .catch(() => {}); // stays unknown
  };
  return { say, show, note, noteAlone, endRun, make, lookUpWindow };
};
