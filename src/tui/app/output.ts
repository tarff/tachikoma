import type { Fns } from "../App.js";
import { type Line, screen as escaped } from "../describe.js";
import { arrived, FOLLOWING } from "../view.js";
import type { UI } from "./state.js";

export const output = (ui: UI, fns: Fns) => {
  // In full screen the lines go to the view's rows too, and a view held away from the bottom counts them (release 5
  // design, "Scrolling"); setting `lines` draws them either way.
  const say = (...add: Line[]) => {
    const shown = add.map(escaped);
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
  const note = (...add: Line[]) => {
    fns.say(...add);
    ui.notes.current = [...(ui.newEdit.current ? [] : ui.notes.current), ...add.map(escaped)];
    ui.newEdit.current = false;
  };
  const noteAlone = (line: Line) => {
    ui.newEdit.current = true;
    fns.note(line);
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
  return { say, show, note, noteAlone, make, lookUpWindow };
};
