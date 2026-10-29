import type { Fns } from "../App.js";
import { move } from "../editor.js";
import type { Mouse } from "../input.js";
import type { Scroll } from "../keys.js";
import { layout, placeOn, scroll as windowOf } from "../layout.js";
import { promptWidth } from "../Prompt.js";
import { clicks, placeAt, span, textOf, wordAt } from "../select.js";
import {
  bar, barFirst, first as firstRow, FOLLOWING, notch, type Pos, Rows, scrollBy, scrollTo, unseenBelow,
} from "../view.js";
import { characters, contextsOf, type Held, NO_KEY } from "./constants.js";
import type { UI } from "./state.js";

export const mouse = (ui: UI, fns: Fns) => {
  // The scroll keys move the conversation (release 5 design, "Scrolling"): PgUp and PgDn by half its height, at least a
  // row; Ctrl+Home to the top; Ctrl+End to the bottom, following again; Shift+Up and Shift+Down by a row. They work
  // during a turn and while a question waits, and move the detail view while it is open (release 5 plan, Task 12).
  const scroll = (c: Scroll) => {
    const p = ui.pane();
    const half = Math.max(1, Math.floor(ui.drawn.viewHeight / 2));
    const by = { pageUp: -half, pageDown: half, lineUp: -1, lineDown: 1, top: 0, bottom: 0 }[c];
    p.view.current =
      c === "top" ? scrollTo(p.rows, p.view.current, ui.drawn.viewHeight, 0) : c === "bottom" ? FOLLOWING : scrollBy(p.rows, p.view.current, ui.drawn.viewHeight, by);
  };
  // The selection as two places, from the press to the pointer's cell, both cells' characters in (release 5 plan, choice
  // 6), as span takes them: backward, from the pointer's character to the end of what was pressed; otherwise from the
  // start of what was pressed to whichever ends later.
  const selected = (): [Pos, Pos] | null => {
    const s = ui.selection.current;
    if (!s) return null;
    const [at, atEnd] = s.end;
    const [from, fromEnd] = s.press;
    const before = (a: Pos, b: Pos) => a.line < b.line || (a.line === b.line && a.offset < b.offset);
    return before(at, from) ? [at, fromEnd] : [from, before(fromEnd, atEnd) ? atEnd : fromEnd];
  };
  // On release: the selection's text to the clipboard (release 5 design, "Copying"), never an empty one, and the hint row
  // says how many characters, counted as a person sees them, as the prompt counts them (release 5 plan, choice 7).
  const copy = () => {
    const s = fns.selected();
    const text = s ? textOf(ui.pane().rows.lines, ...s) : "";
    if (!text) return;
    ui.board.current!.copy(text);
    const n = characters(text);
    ui.copied.current = { text: `Copied ${n} character${n === 1 ? "" : "s"}${ui.board.current!.terminalOnly ? " with the terminal only" : ""}`, failed: false };
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
    // `ended` never comes here (onInput, App.tsx, says why), and is checked as the first phase. Printed out: a report
    // read with its `[`, as for keys.
    // A wheel notch asks for the menu, as a key does (useInput), so Autocomplete comes first while one is open.
    const h = ui.happening(m.kind === "wheel" ? () => fns.menuFor(ui.editor.current) !== null : undefined);
    const { phase } = h;
    if (!ui.fullNow.current || phase.kind === "ended" || phase.kind === "printed") return;
    const { columns, viewHeight } = ui.frame.current;
    if (ui.frame.current.detail !== ui.detail.current) return;
    const p = ui.pane();
    const goTo = (to: number) => {
      p.view.current = scrollTo(p.rows, p.view.current, viewHeight, to);
      ui.rerender((n) => n + 1);
    };
    // A wheel notch is a stroke of its own, pressed in the contexts in force (release 6 plan, Task 6), Scroll's among
    // them in the model list too. scroll:lineUp and scroll:lineDown move by the notch, as release 5's wheel did;
    // another action acts as its key would.
    if (m.kind === "wheel") {
      const stroke = { key: `wheel${m.wheel}`, ctrl: m.ctrl, alt: m.alt, shift: m.shift };
      // A notch that drops a waiting chord is then looked up as if none had waited, as a key is (lookUp), and the chord
      // leaves the hint row even when the notch has nowhere to scroll.
      const waited = fns.chordKeys().waiting(Date.now()) !== null;
      const got = fns.lookUp(stroke, contextsOf(phase.kind, true, true), null, phase.kind === "question");
      if (waited) ui.rerender((n) => n + 1);
      if (!got) return;
      if (!("action" in got) || (got.action !== "scroll:lineUp" && got.action !== "scroll:lineDown")) return fns.onKey(h, got, "", NO_KEY);
      const step = notch(ui.wheel.current, ui.speed, got.action === "scroll:lineUp" ? -1 : 1);
      ui.wheel.current = step.carry;
      const from = firstRow(p.rows, p.view.current, viewHeight);
      if (step.rows && (step.rows < 0 ? from > 0 : p.view.current.at !== null)) goTo(from + step.rows); // not up at the top, nor down following
      return;
    }
    if (m.kind === "release") {
      ui.grab.current = null;
      const h = ui.held.current;
      ui.held.current = null;
      if (h?.copy) {
        fns.copy();
        ui.rerender((n) => n + 1);
      }
      return;
    }
    const top = firstRow(p.rows, p.view.current, viewHeight);
    const thumb = bar(p.rows.total, viewHeight, top);
    const onBar = thumb !== null && m.x === columns - 1 && m.y < viewHeight;
    if (m.kind === "press") {
      ui.grab.current = null;
      ui.held.current = null;
      ui.clearCopied();
      // A selection stays until a click: any press but one on the scroll bar, which scrolls as the wheel does (the user's
      // choice, release 5).
      if (!onBar && ui.selection.current) {
        ui.selection.current = null;
        ui.rerender((n) => n + 1);
      }
    }
    if (m.button !== "left") return;
    if (m.kind === "drag" && ui.held.current) return fns.dragTo(ui.held.current, m.x, m.y);
    if (m.kind === "press" && m.x !== columns - 1 && m.y < fns.textRows(viewHeight)) return fns.pressAt(top, m.x, m.y);
    if (m.kind === "press" && m.y >= viewHeight) return fns.clickAt(m.x, m.y);
    if (!thumb) return;
    const clamp = (start: number) => Math.max(0, Math.min(viewHeight - thumb.size, start));
    const move = (start: number) => start !== thumb.start && goTo(barFirst(p.rows.total, viewHeight, thumb.size, start));
    if (m.kind === "drag" && ui.grab.current !== null) return void move(clamp(m.y - ui.grab.current));
    if (m.kind !== "press" || !onBar) return;
    const on = m.y >= thumb.start && m.y < thumb.start + thumb.size;
    const start = on ? thumb.start : clamp(m.y - Math.floor(thumb.size / 2)); // centred on its middle row, the lower of two
    ui.grab.current = m.y - start;
    move(start);
  };

  // The cell at the pane's row `row` as select.ts takes it. A row below the last line, blank in a view held past the
  // bottom, stands for the last line's end.
  const cellAt = (rows: Rows, row: number, x: number) =>
    row < rows.total ? { row, x } : { row: rows.total - 1, x: rows.width }; // rows.width: past any row's text
  // The pane's rows that show text: all but the "↓ N new lines" row while it shows, which is not text (release 5 plan,
  // choice 10's rule for such rows): a press there starts nothing, and a drag onto it counts as the row above it.
  const textRows = (viewHeight: number) => viewHeight - (unseenBelow(ui.pane().rows, ui.pane().view.current, viewHeight) > 0 ? 1 : 0);
  // A left press in the conversation's text rows (release 5 design, "Selecting"; release 5 plan, choice 6), the
  // selection already cleared: a click takes the pressed character, which a drag grows from; a double-click selects the
  // word, a triple-click the line, both copied on release. A double-click past a row's text, or a double or triple
  // click below the last line, clicks nothing: placeAt gives the row's end there, which on a wrapped row is the next
  // row's start.
  const pressAt = (top: number, x: number, y: number) => {
    const { rows } = ui.pane();
    if (!rows.total) return;
    const at = Date.now();
    const count = clicks(ui.lastPress.current, at, x, y);
    ui.lastPress.current = { at, x, y, count };
    const cell = fns.cellAt(rows, top + y, x);
    ui.rerender((n) => n + 1);
    if (count === 1) return void (ui.held.current = { press: span(rows, cell, cell), copy: false, top: y === 0 });
    const { pos, past } = placeAt(rows, cell.row, cell.x);
    if (top + y >= rows.total || (count === 2 && past)) return;
    const text = rows.lines[pos.line]!.text;
    const { start, end } = count === 2 ? wordAt(text, pos.offset) : { start: 0, end: text.length };
    const press: [Pos, Pos] = [
      { line: pos.line, offset: start },
      { line: pos.line, offset: end },
    ];
    ui.selection.current = { press, end: span(rows, cell, cell) };
    ui.held.current = { press, copy: true, top: y === 0 };
  };
  // A left press below the conversation (release 5 design, "Clicking"): on a prompt row the cursor goes to the place under
  // it, after the two columns of "› ", or to the row's end past it; a menu entry is chosen and Enter's path runs it, so a
  // `/` command runs and an `@` path fills in. The prompt's "↑ N rows above" and "↓ N rows below" rows, the menu's
  // "↑ N more" and "↓ N more", and every other row do nothing (release 5 plan, choice 10). The prompt during Ctrl+R's
  // search shows a match, not what is typed, so the frame gives it no prompt rows then. A click read with a key that
  // replaced the prompt or the menu's choice is dropped: React draws nothing between them, so the screen is still the one
  // from before the key. A click that acts starts the press-twice count again, as a key between the presses does.
  const clickAt = (x: number, y: number) => {
    const f = ui.frame.current;
    if (ui.editor.current !== f.editor || ui.chosen.current !== f.chosen) return;
    const { columns, promptFirst, promptRows, promptWindow, menuRows } = f;
    const row = y - promptFirst; // a row of the prompt, then of the menu
    const marked = (i: number, shown: number, w: { above: number; below: number }) => (i === 0 && w.above > 0) || (i === shown - 1 && w.below > 0);
    const e = ui.editor.current;
    if (row >= 0 && row < promptRows) {
      const { places } = layout(e.text, promptWidth(columns));
      if (marked(row, promptRows, promptWindow)) return;
      ui.editor.current = move(e, placeOn(places, promptWindow.top + row, x - 2)!);
      ui.goal.current = null;
    } else {
      const i = row - promptRows;
      if (i < 0 || i >= menuRows) return;
      const menu = fns.menuFor(e); // after the rows are checked: for an `@` path it can list a folder again
      if (!menu) return;
      const w = windowOf(menu.entries.length, menuRows, fns.chosenIn(e, menu), ui.menuTop.current);
      if (marked(i, menuRows, w)) return;
      ui.chosen.current = { text: e.text, at: w.top + i };
      fns.run("submit");
    }
    fns.forget();
    ui.rerender((n) => n + 1);
  };
  // A drag while selecting grows the selection to the pointer's cell. Below the conversation the view first scrolls a row
  // for each report, so a selection can be longer than the screen (release 5 design, "Selecting"). The frame starts at
  // the terminal's top, so the pointer cannot go above the conversation: its top row stands for above it, for a drag
  // started lower down; one started on the top row selects within it and never scrolls (the user's choice, release 5).
  const dragTo = (h: Held, x: number, y: number) => {
    const { viewHeight } = ui.frame.current;
    const p = ui.pane();
    const up = y <= 0 && !h.top;
    if (y >= viewHeight || up) p.view.current = scrollBy(p.rows, p.view.current, viewHeight, up ? -1 : 1);
    const cell = fns.cellAt(p.rows, firstRow(p.rows, p.view.current, viewHeight) + Math.max(0, Math.min(fns.textRows(viewHeight) - 1, y)), x);
    ui.selection.current = { press: h.press, end: span(p.rows, cell, cell) };
    h.copy = true;
    ui.rerender((n) => n + 1);
  };
  return { scroll, selected, copy, onMouse, cellAt, textRows, pressAt, clickAt, dragTo };
};
