import { describe, expect, it } from "vitest";
import type { Task } from "../../src/core/tasks.js";
import { type FrameIn, frame, layout, scroll, vertical } from "../../src/tui/layout.js";
import { taskRows } from "../../src/tui/TaskPanel.js";
import { todoRows } from "../../src/tui/TodoList.js";
import { wrap } from "../../src/tui/view.js";

describe("layout", () => {
  it("wraps the prompt at the width, by columns", () => {
    const l = layout("abcdef", 3);
    expect(l.rows).toEqual(["abc", "def"]);
    expect(l.places.get(3)).toEqual({ row: 1, col: 0 }); // the cursor before "d" is where "d" is
    expect(l.places.get(6)).toEqual({ row: 1, col: 3 }); // after the last character, in the column left free
  });

  it("counts a wide character as two columns, and moves one that does not fit to the next row", () => {
    expect(layout("a中b", 3).rows).toEqual(["a中", "b"]);
    expect(layout("ab中", 3).rows).toEqual(["ab", "中"]);
    expect(layout("ab中", 3).places.get(2)).toEqual({ row: 1, col: 0 });
  });

  it("starts a row at each line break", () => {
    const l = layout("ab\ncd\n", 10);
    expect(l.rows).toEqual(["ab", "cd", ""]);
    expect(l.places.get(2)).toEqual({ row: 0, col: 2 });
    expect(l.places.get(3)).toEqual({ row: 1, col: 0 });
    expect(l.places.get(6)).toEqual({ row: 2, col: 0 });
    expect(layout("", 10).rows).toEqual([""]);
  });

  it("shows control characters as escapes, as wide as they are shown", () => {
    const l = layout("a\u001bb\tc", 20);
    expect(l.rows).toEqual(["a\\u001bb⇥c"]);
    expect(l.places.get(2)).toEqual({ row: 0, col: 7 });
  });
});

describe("vertical", () => {
  it("moves one row up or down as the screen shows it, keeping the column", () => {
    expect(vertical("abcdef", 3, 4, -1, null)).toEqual({ cursor: 1, goal: 1 });
    expect(vertical("abcdef", 3, 2, 1, null)).toEqual({ cursor: 5, goal: 2 });
  });

  it("goes to the end of a shorter row, and back to the column it came from on a longer one", () => {
    const text = "abcdef\nx\nabcdef";
    const down = vertical(text, 10, 5, 1, null)!;
    expect(down).toEqual({ cursor: 8, goal: 5 }); // after the "x"
    expect(vertical(text, 10, down.cursor, 1, down.goal)).toEqual({ cursor: 14, goal: 5 });
  });

  it("says there is no row above the first or below the last, where the history starts", () => {
    expect(vertical("ab\ncd", 10, 1, -1, null)).toBeNull();
    expect(vertical("ab\ncd", 10, 4, 1, null)).toBeNull();
  });
});

describe("scroll", () => {
  it("shows every row when they fit", () => {
    expect(scroll(3, 5, 2, 0)).toEqual({ top: 0, above: 0, below: 0 });
  });

  it("keeps the cursor's row in view, the first and last rows shown counting the rows cut off", () => {
    // Ten rows in four, the cursor on the last: rows 6 to 9 are shown, row 6 saying that 7 are above.
    expect(scroll(10, 4, 9, 0)).toEqual({ top: 6, above: 7, below: 0 });
    expect(scroll(10, 4, 7, 6)).toEqual({ top: 6, above: 7, below: 0 }); // still in view: the window stays
    expect(scroll(10, 4, 6, 6)).toEqual({ top: 5, above: 6, below: 2 }); // one row up, and a count below
    expect(scroll(10, 4, 1, 5)).toEqual({ top: 0, above: 0, below: 7 });
  });

  it("has no room for the counts in fewer than three rows", () => {
    expect(scroll(10, 2, 5, 0)).toEqual({ top: 4, above: 0, below: 0 });
    expect(scroll(10, 1, 5, 4)).toEqual({ top: 5, above: 0, below: 0 });
  });
});

// A frame with nothing open: a one-row prompt and a hint, and no working line, tool line, menu, panel, to-dos or queue.
const base: FrameIn = {
  rows: 20,
  columns: 40,
  full: true,
  promptRows: 1,
  cursorRow: 0,
  promptTop: 0,
  working: false,
  liveRows: 0,
  toolLine: false,
  detail: false,
  hint: true,
  menu: null,
  taskRows: () => [],
  todoRows: () => [],
  queued: 0,
  pickerNeeded: null,
  question: false,
  askedText: null,
  askedShort: null,
  askedWarnings: [],
  askedNote: false,
};
const subagent = (id: string): Task => ({
  kind: "subagent",
  id,
  description: "look around",
  task: "look around",
  model: "anthropic:claude",
  background: false,
  state: "running",
  started: 0,
  output: 0,
  cost: 0,
  costUnknown: false,
  lastTool: null,
  shown: true,
  messages: [],
  done: new Promise(() => {}),
});
const items = Array.from({ length: 8 }, (_, k) => ({ text: `item ${k}`, status: k === 0 ? ("in_progress" as const) : ("pending" as const) }));

describe("frame", () => {
  it("gives the conversation every row the prompt, the hint and the status line leave, the frame a row short", () => {
    expect(frame(base)).toEqual({
      rules: true,
      tooled: false,
      hinted: true,
      menuRows: 0,
      panel: [],
      promptSpace: 10, // half the rows, in full screen (choice 120)
      promptShown: 1,
      promptWindow: { top: 0, above: 0, below: 0 },
      todoShown: [],
      left: 15,
      queuedShown: 0,
      pickerRows: 0,
      questionFits: true,
      asked: [],
      warned: [],
      noted: false,
      viewHeight: 14, // with the prompt, its two lines, the hint and the status line, 19 rows
      promptFirst: 15,
    });
  });

  it("windows a prompt taller than its space around the cursor, leaving the conversation its one row", () => {
    // Of ten rows, the frame's row short, the hint and the status line leave seven for twelve, in classic mode, where the
    // conversation is the terminal's own scrollback.
    const f = frame({ ...base, rows: 10, full: false, promptRows: 12, cursorRow: 11 });
    expect(f).toMatchObject({ rules: false, promptSpace: 7, promptShown: 7, left: 0, viewHeight: 1, promptFirst: 0 });
    expect(f.promptWindow).toEqual({ top: 5, above: 6, below: 0 });
  });

  // Release 7 plan, choice 120 (the user's hand check): in full screen a long prompt left the conversation one row.
  it("gives a prompt at most half the rows in full screen, the conversation keeping the rest", () => {
    // Ten rows: five for twelve, where six were left (the frame's row short, the hint and the status line), so the
    // conversation has two.
    const ten = frame({ ...base, rows: 10, promptRows: 12, cursorRow: 11 });
    // Two rows are too few for the prompt's lines and the conversation's one (TUI design pass, Task 4).
    expect(ten).toMatchObject({ rules: false, promptSpace: 5, promptShown: 5, left: 0, viewHeight: 2, promptFirst: 2 });
    expect(ten.promptWindow).toEqual({ top: 7, above: 8, below: 0 });
    // Twenty rows: ten for thirty, the conversation the other five of the nineteen drawn, the prompt's two lines taking
    // two; a prompt of ten keeps them all.
    const twenty = frame({ ...base, rows: 20, promptRows: 30, cursorRow: 0 });
    expect(twenty).toMatchObject({ rules: true, promptSpace: 10, promptShown: 10, left: 0, viewHeight: 5, promptFirst: 6 });
    expect(twenty.promptWindow).toEqual({ top: 0, above: 0, below: 21 });
    expect(frame({ ...base, rows: 20, promptRows: 10 })).toMatchObject({ promptShown: 10, viewHeight: 5, promptWindow: { top: 0, above: 0, below: 0 } });
    // A short prompt is drawn as before.
    expect(frame({ ...base, rows: 20, promptRows: 3 })).toMatchObject({ promptShown: 3, viewHeight: 12, promptFirst: 13 });
    // A to-do list still gives way to the whole prompt, so the rows the prompt frees are the conversation's.
    const listed = frame({ ...base, rows: 20, promptRows: 30, todoRows: (rows) => todoRows(items, rows) });
    expect(listed).toMatchObject({ todoShown: [], promptShown: 10, left: 0, viewHeight: 5, promptFirst: 6 });
    // An open menu still cuts it to the cursor's row.
    expect(frame({ ...base, rows: 20, promptRows: 30, cursorRow: 4, menu: 3 })).toMatchObject({ menuRows: 3, promptSpace: 1, promptShown: 1, viewHeight: 11 });
    // A small terminal: below nine rows the rules above give no more than half; at three rows and less, still one row.
    expect(frame({ ...base, rows: 8, promptRows: 12 })).toMatchObject({ promptSpace: 4, promptShown: 4, viewHeight: 1 });
    for (const rows of [1, 2, 3]) expect(frame({ ...base, rows, promptRows: 12 })).toMatchObject({ promptSpace: 1, promptShown: 1, viewHeight: 1 });
  });

  it("cuts the prompt to the cursor's row under an open menu, which takes the rest", () => {
    const long = frame({ ...base, rows: 12, promptRows: 3, cursorRow: 1, menu: 20 });
    expect(long).toMatchObject({ rules: false, menuRows: 7, promptSpace: 1, promptShown: 1, left: 0, viewHeight: 1, promptFirst: 1 });
    expect(long.promptWindow).toEqual({ top: 1, above: 0, below: 0 });
    // A short menu takes its entries' rows; the prompt is still cut, and the conversation has the rest, less the prompt's
    // two lines.
    const short = frame({ ...base, rows: 12, promptRows: 3, cursorRow: 1, menu: 2 });
    expect(short).toMatchObject({ rules: true, menuRows: 2, promptSpace: 1, promptShown: 1, left: 5, viewHeight: 4, promptFirst: 5 });
  });

  it("shares the room between the task panel and the to-do list, which gives way before the prompt does", () => {
    const tasks = [subagent("t1"), subagent("t2")];
    const shared: FrameIn = { ...base, rows: 14, taskRows: (rows) => taskRows(tasks, rows, 0), todoRows: (rows) => todoRows(items, rows) };
    const f = frame(shared);
    expect(f.panel).toHaveLength(4); // two subagents, two rows each
    expect(f.todoShown.map((r) => r.text)).toEqual(["item 0", "item 1", "item 2", "item 3", "+4 more"]);
    expect(f).toMatchObject({ rules: false, promptSpace: 6, promptShown: 1, left: 0, viewHeight: 1, promptFirst: 6 });
    // A four-row prompt keeps its rows; the list is cut to two.
    const tall = frame({ ...shared, promptRows: 4, cursorRow: 3 });
    expect(tall.todoShown.map((r) => r.text)).toEqual(["item 0", "+7 more"]);
    expect(tall).toMatchObject({ rules: false, promptShown: 4, left: 0, viewHeight: 1, promptFirst: 3 });
  });

  it("shows as many queued messages as fit, the last row saying how many more, and none with no row left", () => {
    // Five rows left for seven: four and "+3 more", with no row over for the prompt's lines.
    expect(frame({ ...base, rows: 10, queued: 7 })).toMatchObject({ rules: false, left: 5, queuedShown: 5, viewHeight: 1, promptFirst: 6 });
    // Fewer than the five: all of them, and the conversation the rest, less the prompt's two lines.
    expect(frame({ ...base, rows: 10, queued: 3 })).toMatchObject({ rules: true, left: 5, queuedShown: 3, viewHeight: 1, promptFirst: 5 });
    expect(frame({ ...base, rows: 10, queued: 2 })).toMatchObject({ rules: true, left: 5, queuedShown: 2, viewHeight: 2, promptFirst: 5 });
    expect(frame({ ...base, rows: 5, queued: 7 })).toMatchObject({ left: 0, queuedShown: 0, viewHeight: 1, promptFirst: 1 });
  });

  it("gives the model list the rows it needs, up to all but the conversation's one row, its filter line and the status line", () => {
    const list: FrameIn = { ...base, rows: 12, hint: false, pickerNeeded: 30 };
    expect(frame(list)).toMatchObject({ pickerRows: 8, hinted: false, viewHeight: 1 });
    expect(frame({ ...list, hint: true })).toMatchObject({ pickerRows: 7, hinted: true, viewHeight: 1 });
    expect(frame({ ...list, pickerNeeded: 3 })).toMatchObject({ pickerRows: 3, viewHeight: 6 });
  });

  // The question is drawn in a box (TUI design pass, Task 9): sixty columns inside one of 64, and two border rows, so
  // these terminals are two rows taller than they were before it.
  it("draws a question that fits in its rows, and gives one too long to fit its short line's rows", () => {
    const inner = 60;
    const fitting = "Allow run: ls? [y/n] · Esc to decline";
    const long = `Allow run: ${"echo hello ".repeat(60)}? [y/n] · Esc to decline`;
    const short = "Allow run (shown above)? [y/n] · Esc to decline";
    // Seven rows are the most that fit in twelve, the frame's row short, the box's two, the status line's and the
    // conversation's one taken.
    const seven = "x".repeat(7 * inner);
    const eight = "x".repeat(7 * inner + 1);
    expect([fitting, long, short, seven, eight].map((t) => wrap(t, inner, false).length)).toEqual([1, 12, 1, 7, 8]);
    const asked: FrameIn = { ...base, rows: 12, columns: inner + 4, hint: false, question: true };
    const fits = frame({ ...asked, askedText: fitting, askedShort: short });
    expect(fits).toMatchObject({ questionFits: true, viewHeight: 7 });
    expect(fits.asked).toEqual([fitting]);
    const moves = frame({ ...asked, askedText: long, askedShort: short });
    expect(moves).toMatchObject({ questionFits: false, viewHeight: 7 });
    expect(moves.asked).toEqual([short]);
    expect(frame({ ...asked, askedText: seven, askedShort: short })).toMatchObject({ questionFits: true, asked: { length: 7 }, viewHeight: 1 });
    expect(frame({ ...asked, askedText: eight, askedShort: short })).toMatchObject({ questionFits: false, asked: [short], viewHeight: 7 });
    // One that cannot move (it has moved already, or the list is open) keeps its rows, the conversation its one row.
    expect(frame({ ...asked, askedText: long })).toMatchObject({ questionFits: false, asked: { length: 12 }, viewHeight: 1 });
    // In classic mode a question is drawn as one Text, which counts no rows here.
    expect(frame({ ...asked, full: false })).toMatchObject({ questionFits: true, asked: [], viewHeight: 10 });
  });

  // Release 7 plan, Task 8 and choice 63: a dangerous command's red lines are drawn above the question in full screen, one
  // row each (cut at the terminal's width as it is drawn), in the rows the question leaves the conversation beyond its
  // one; when they do not all fit, the last row drawn says how many more there are. The frame never passes the terminal.
  it("draws a question's red lines a row each, as many as fit, the last saying how many more", () => {
    const inner = 60; // in the box, as above
    const fitting = "Allow run: git push --force? [y/n] · Esc to decline";
    const short = "Allow run (shown above)? [y/n] · Esc to decline";
    const red = (n: number) => `Danger: rewriting or deleting git history: git push --force origin b${n}`;
    const long = `Danger: rewriting or deleting git history: git push --force ${"origin ".repeat(5)}`;
    expect(wrap(long, inner, false).length).toBe(2); // two rows if wrapped; one row here
    const reds = (n: number) => Array.from({ length: n }, (_, i) => red(i + 1));
    // Twelve rows: the frame's row short, the conversation's one, the box's two, the question's and the status line's
    // leave six.
    const asked: FrameIn = { ...base, rows: 12, columns: inner + 4, hint: false, question: true, askedText: fitting, askedShort: short };
    expect(frame({ ...asked, askedWarnings: [red(1)] })).toMatchObject({ questionFits: true, warned: [red(1)], asked: [fitting], viewHeight: 6 });
    expect(frame({ ...asked, askedWarnings: [red(1), long] })).toMatchObject({ warned: [red(1), long], viewHeight: 5 });
    expect(frame({ ...asked, askedWarnings: reds(6) })).toMatchObject({ warned: reds(6), viewHeight: 1 });
    // Seven and more: five of them and the count of the rest, which is never one, as its row takes one red line's place.
    expect(frame({ ...asked, askedWarnings: reds(7) })).toMatchObject({ warned: [...reds(5), "…and 2 more dangers"], viewHeight: 1 });
    expect(frame({ ...asked, askedWarnings: reds(12) })).toMatchObject({ warned: [...reds(5), "…and 7 more dangers"], viewHeight: 1 });
    // A question of two rows keeps them, as one red row still fits beside it, and the red lines take what is left.
    const two = "x".repeat(inner + 1);
    expect(frame({ ...asked, askedText: two, askedWarnings: reds(6) })).toMatchObject({
      questionFits: true,
      asked: { length: 2 },
      warned: [...reds(4), "…and 2 more dangers"],
      viewHeight: 1,
    });
    // One that leaves no row for a red line moves, so they have room again.
    const eight = "x".repeat(7 * inner + 1);
    const seven = "x".repeat(7 * inner);
    expect(frame({ ...asked, askedText: seven, askedWarnings: [red(1)] })).toMatchObject({ questionFits: false, asked: [short], warned: [red(1)] });
    const moved = frame({ ...asked, askedText: eight, askedWarnings: reds(7) });
    expect(moved).toMatchObject({ asked: [short], warned: [...reds(5), "…and 2 more dangers"], viewHeight: 1 });
    // One that cannot move is one that has moved (App.tsx, movable), drawn as its short line; its red row is kept.
    expect(frame({ ...asked, askedText: short, askedShort: null, askedWarnings: [red(1)] })).toMatchObject({ asked: [short], warned: [red(1)] });
    // Forty inside the box by nine, a moved question, the hint and the tool line: the tool line and the hint count the
    // question's own two rows, the box's two and its red row, so the tool line gives way, and the question's rows, the
    // hint and the status line leave the red row its row, with a turn running or not, as the working line is not drawn
    // under a question. With room for one red row only, it says how many dangers there are.
    const small: FrameIn = {
      ...base,
      rows: 9,
      columns: 44,
      working: true,
      hint: true,
      toolLine: true,
      question: true,
      askedText: "x".repeat(400),
      askedShort: short,
    };
    expect(wrap(short, 40, false).length).toBe(2);
    expect(frame({ ...small, askedWarnings: [] })).toMatchObject({ tooled: true, hinted: true });
    expect(frame({ ...small, askedWarnings: [red(1)] })).toMatchObject({ tooled: false, hinted: true, asked: { length: 2 }, warned: [red(1)], viewHeight: 1 });
    expect(frame({ ...small, askedWarnings: reds(7) })).toMatchObject({ tooled: false, warned: ["7 dangers"], viewHeight: 1 });
    const idle = { ...small, working: false };
    expect(frame({ ...idle, askedWarnings: [] })).toMatchObject({ tooled: true, hinted: true, viewHeight: 1 });
    expect(frame({ ...idle, askedWarnings: [red(1)] })).toMatchObject({ tooled: false, hinted: true, asked: { length: 2 }, warned: [red(1)], viewHeight: 1 });
    expect(frame({ ...idle, askedWarnings: reds(7) })).toMatchObject({ tooled: false, warned: ["7 dangers"], viewHeight: 1 });
    // In classic mode the red lines are Texts of their own, drawn whole, which count no rows here, as the question's.
    expect(frame({ ...asked, full: false, askedText: null, askedShort: null, askedWarnings: [red(1)] })).toMatchObject({ warned: [], viewHeight: 10 });
  });

  // Release 7 plan, Task 10: auto mode's pause is a grey row of the question. It counts as one of the question's own rows,
  // as the first red row does, in whether the question fits and in what the tool line and the hint leave, and it is drawn
  // only when there is a row for it beyond the conversation's one and, as Task 8 always keeps one red row, beyond that red
  // row. The gate never sends a grey line with red lines today (a paused question has no dangers), but the frame takes
  // both, the grey row above.
  it("draws a question's grey line as a row of its own when there is a row for it, before any red lines", () => {
    const inner = 60; // in the box, as above
    const fitting = "Allow read /made/up/notes.txt? [y/n] · Esc to decline";
    const short = "Allow read (shown above)? [y/n] · Esc to decline";
    const red = (n: number) => `Danger: rewriting or deleting git history: git push --force origin b${n}`;
    const reds = (n: number) => Array.from({ length: n }, (_, i) => red(i + 1));
    // Twelve rows: the frame's row short, the conversation's one, the box's two, the grey row, the question's and the
    // status line's.
    const asked: FrameIn = { ...base, rows: 12, columns: inner + 4, hint: false, question: true, askedText: fitting, askedShort: short, askedNote: true };
    expect(frame(asked)).toMatchObject({ questionFits: true, noted: true, warned: [], asked: [fitting], viewHeight: 6 });
    expect(frame({ ...asked, askedWarnings: reds(7) })).toMatchObject({ noted: true, warned: [...reds(4), "…and 3 more dangers"], viewHeight: 1 });
    // Seven rows fit without the grey row (above) and not with it, so the question moves to its short line.
    const seven = "x".repeat(7 * inner);
    expect(frame({ ...asked, askedText: seven })).toMatchObject({ questionFits: false, noted: true, asked: [short] });
    expect(frame({ ...asked, askedText: seven, askedNote: false })).toMatchObject({ questionFits: true, noted: false });
    // Forty inside the box by nine, a moved question of two rows with a red line, the hint and the tool line: the grey row
    // is the question's own, so the tool line and the hint give way, and the red row keeps its row. The frame is a row
    // short.
    const small: FrameIn = { ...base, rows: 9, columns: 44, working: true, hint: true, toolLine: true, question: true, askedText: short, askedShort: null, askedNote: true };
    const f = frame({ ...small, askedWarnings: [red(1)] });
    expect(f).toMatchObject({ tooled: false, hinted: false, noted: true, asked: { length: 2 }, warned: [red(1)], viewHeight: 1 });
    // The conversation, the box's top, grey, red, question, the box's foot, status.
    expect(f.viewHeight + 1 + 1 + f.warned.length + f.asked.length + 1 + 1).toBe(8);
    // With no question drawn, as in classic mode or under the model list, there is no grey row.
    expect(frame({ ...asked, askedText: null })).toMatchObject({ noted: false });
    // Six rows and a one-line question that cannot move: the frame's row short, the conversation's, the box's two, the
    // question's and the status line's leave none, so the grey row is left out, as a red row would be, and the frame stays
    // a row short.
    const six = frame({ ...asked, rows: 6, askedShort: null });
    expect(six).toMatchObject({ noted: false, asked: [fitting], warned: [], viewHeight: 1 });
    expect(six.viewHeight + 2 + six.asked.length + 1).toBe(5);
    // Seven rows, a red line too, and the question moved to its one-row short line: one row is free, and the red row
    // takes it; the grey row gives way.
    const sevenRows = frame({ ...asked, rows: 7, askedWarnings: [red(1)] });
    expect(sevenRows).toMatchObject({ questionFits: false, asked: [short], noted: false, warned: [red(1)], viewHeight: 1 });
    expect(sevenRows.viewHeight + 2 + sevenRows.warned.length + sevenRows.asked.length + 1).toBe(6);
  });

  // TUI design pass, Task 9: the question in a rounded box. Inside it text has the terminal's columns less 4, a border and
  // a space of padding each side, so the question's line and its short line are wrapped there and the red lines cut
  // there; the box's two border rows are among the question's own.
  describe("the question's box", () => {
    const short = "Allow run (shown above)? [y/n] · Esc to decline";
    const fitting = "Allow run: ls? [y/n] · Esc to decline";
    const red = "Danger: rewriting or deleting git history: git push --force";
    const asked: FrameIn = { ...base, rows: 24, columns: 80, hint: false, question: true, askedText: fitting, askedShort: short };

    it("counts its two border rows: a question that fits, one with dangers, and one that moves above", () => {
      // Twenty-four rows: the frame's row short, the box's two, the question's one and the status line's leave the
      // conversation nineteen.
      const fits = frame(asked);
      expect(fits).toMatchObject({ questionFits: true, asked: [fitting], warned: [], viewHeight: 19 });
      expect(fits.viewHeight + 1 + fits.asked.length + 1 + 1).toBe(23); // the conversation, the box, the status line
      expect(frame({ ...asked, askedWarnings: [red, red] })).toMatchObject({ questionFits: true, warned: [red, red], asked: [fitting], viewHeight: 17 });
      // Nineteen rows at 76 columns fit; twenty move to the short line, the conversation keeping the rest.
      const nineteen = "x".repeat(19 * 76);
      expect(frame({ ...asked, askedText: nineteen })).toMatchObject({ questionFits: true, asked: { length: 19 }, viewHeight: 1 });
      expect(frame({ ...asked, askedText: `${nineteen}x` })).toMatchObject({ questionFits: false, asked: [short], viewHeight: 19 });
      // In classic mode the frame is given no question's line (App.tsx), so it counts no rows, nor the box's.
      expect(frame({ ...asked, full: false, askedText: null, askedShort: null })).toMatchObject({ asked: [], viewHeight: 22 });
    });

    it.each([80, 40])("wraps the question's line at %i columns less 4, and cuts a red line there to one row", (columns) => {
      const inner = columns - 4;
      const at = { ...asked, columns };
      const exactly = `Allow run: ${"x".repeat(inner - "Allow run: ".length)}`;
      expect(exactly).toHaveLength(inner);
      expect(frame({ ...at, askedText: exactly })).toMatchObject({ asked: [exactly], viewHeight: 19 });
      expect(frame({ ...at, askedText: `${exactly}x` })).toMatchObject({ asked: { length: 2 }, viewHeight: 18 });
      // A red line is one row however long, cut where it is drawn, inside the box (App.tsx).
      const redExactly = `Danger: ${"x".repeat(inner - "Danger: ".length)}`;
      expect(frame({ ...at, askedText: exactly, askedWarnings: [redExactly] })).toMatchObject({ warned: [redExactly], viewHeight: 18 });
      expect(frame({ ...at, askedText: exactly, askedWarnings: [`${redExactly}x`] })).toMatchObject({ warned: [`${redExactly}x`], viewHeight: 18 });
    });

    // Task 9's code review: in classic mode the frame has no question's line, but the box and the question's line take at
    // least three rows, which the tool line and the hint row give way to, so the live area stays a row short of the
    // terminal (Ink draws the whole scrollback again when it is not).
    it("keeps the box's rows and the question's in classic mode, the tool line and the hint giving way first", () => {
      const classic: FrameIn = { ...base, full: false, toolLine: true, hint: true, question: true };
      // Seven rows: the box's three, the tool line, the hint and the status line, a row short.
      expect(frame({ ...classic, rows: 7 })).toMatchObject({ tooled: true, hinted: true });
      // Six: the tool line goes; five: the hint too.
      expect(frame({ ...classic, rows: 6 })).toMatchObject({ tooled: false, hinted: true });
      expect(frame({ ...classic, rows: 5 })).toMatchObject({ tooled: false, hinted: false });
    });

    it("moves a question to its short line on the tallest terminal where the box leaves the conversation no row, and not one row taller", () => {
      // Three rows at 76 columns: with the box's two, the frame's row short and the status line's, eight rows leave the
      // conversation one and seven none, so at seven the short line's one row is drawn, the conversation having two.
      const three = "x".repeat(2 * 76 + 1);
      expect(wrap(three, 76, false)).toHaveLength(3);
      expect(frame({ ...asked, rows: 7, askedText: three })).toMatchObject({ questionFits: false, asked: [short], viewHeight: 2 });
      expect(frame({ ...asked, rows: 8, askedText: three })).toMatchObject({ questionFits: true, asked: { length: 3 }, viewHeight: 1 });
    });
  });

  // TUI design pass, Task 4 and choice P5, the user's reading ("Give way for all"): a line above the prompt and one below,
  // both or none, drawn only in rows the frame leaves over once every other part has what it has without them, the
  // conversation keeping its one row in full screen.
  it("draws the prompt's two lines only in rows nothing else would have", () => {
    // A tall terminal draws them, the conversation giving up their rows.
    expect(frame(base)).toMatchObject({ rules: true, viewHeight: 14 });
    // Seven queued in ten rows: five shown, as without the lines, which go.
    expect(frame({ ...base, rows: 10, queued: 7 })).toMatchObject({ rules: false, queuedShown: 5 });
    // A long menu in twelve rows: its seven entries, as without them.
    expect(frame({ ...base, rows: 12, promptRows: 3, cursorRow: 1, menu: 20 })).toMatchObject({ rules: false, menuRows: 7 });
    // A to-do list beside a four-row prompt: the list's two rows and the prompt's four, as without them.
    const tasks = [subagent("t1"), subagent("t2")];
    const listed = frame({ ...base, rows: 14, promptRows: 4, cursorRow: 3, taskRows: (rows) => taskRows(tasks, rows, 0), todoRows: (rows) => todoRows(items, rows) });
    expect(listed).toMatchObject({ rules: false, promptShown: 4, todoShown: { length: 2 }, panel: { length: 4 } });
    // Three rows over in full screen draw them, the conversation keeping one; two do not.
    expect(frame({ ...base, rows: 7 })).toMatchObject({ rules: true, promptSpace: 3, left: 2, viewHeight: 1, promptFirst: 2 });
    expect(frame({ ...base, rows: 6 })).toMatchObject({ rules: false, promptSpace: 2, left: 1, viewHeight: 2, promptFirst: 2 });
    expect(frame({ ...base, rows: 8, toolLine: true })).toMatchObject({ rules: true, tooled: true, hinted: true });
    expect(frame({ ...base, rows: 7, toolLine: true })).toMatchObject({ rules: false, tooled: true, hinted: true });
    // In classic mode, with no conversation in the frame, two rows over draw them.
    expect(frame({ ...base, rows: 6, full: false })).toMatchObject({ rules: true, promptFirst: 1 });
    expect(frame({ ...base, rows: 5, full: false })).toMatchObject({ rules: false, promptFirst: 0 });
    // No prompt drawn, no lines: under a question, the model list and the detail view.
    expect(frame({ ...base, question: true })).toMatchObject({ rules: false });
    expect(frame({ ...base, pickerNeeded: 3 })).toMatchObject({ rules: false });
    expect(frame({ ...base, detail: true })).toMatchObject({ rules: false });
  });

  it("draws the lines exactly when the rows on screen have room for them, over a grid of frames", () => {
    const tasks = [subagent("t1"), subagent("t2")];
    const wrong: string[] = [];
    let lined = 0;
    let total = 0;
    for (const rows of [4, 6, 7, 8, 10, 12, 24])
      for (const full of [true, false])
        for (const promptRows of [1, 12])
          for (const working of [false, true])
            for (const toolLine of [false, true])
              for (const hint of [false, true])
                for (const menu of [null, 2, 20])
                  for (const todos of [false, true])
                    for (const queued of [0, 2, 7])
                      for (const panel of [false, true]) {
                        const i: FrameIn = {
                          ...base,
                          ...{ rows, full, promptRows, cursorRow: promptRows - 1, working, toolLine, hint, menu, queued },
                          taskRows: panel ? (r) => taskRows(tasks, r, 0) : () => [],
                          todoRows: todos ? (r) => todoRows(items, r) : () => [],
                        };
                        const f = frame(i);
                        const name = JSON.stringify({ rows, full, promptRows, working, toolLine, hint, menu, todos, queued, panel });
                        total++;
                        // The live area's rows on screen, the lines left out: the working line, the to-do list, the queue,
                        // the prompt, the menu, the task panel, the hint row, the status line and the tool line.
                        const others = (working ? 1 : 0) + f.todoShown.length + f.queuedShown + f.promptShown + f.menuRows + f.panel.length + (f.hinted ? 1 : 0) + 1 + (f.tooled ? 1 : 0);
                        // The frame is a row short of the terminal; in full screen the conversation keeps at least one row.
                        const fits = (drawn: number) => (full ? rows - 1 - drawn >= 1 : drawn <= rows - 1);
                        if (f.rules) {
                          lined++;
                          if (!fits(others + 2)) wrong.push(`${name}: the lines drawn in ${others} + 2 rows`);
                          if (full && others + 2 + f.viewHeight !== rows - 1) wrong.push(`${name}: ${others} + 2 + ${f.viewHeight} rows`);
                        } else if (fits(others + 2)) wrong.push(`${name}: the lines left out with room for them`);
                      }
    expect(wrong).toEqual([]);
    expect(lined).toBeGreaterThan(0); // the grid has frames with the lines and without
    expect(lined).toBeLessThan(total);
  });

  describe("one input changed, every other the same", () => {
    // A twelve-row prompt, the cursor on its seventh row, in a frame of twelve rows: the prompt draws half of them (choice
    // 120), and the conversation has the three its eight rows leave.
    const tall: FrameIn = { ...base, rows: 12, promptRows: 12, cursorRow: 6 };
    const off = { tooled: false, hinted: true, promptSpace: 6, promptShown: 6, left: 0, viewHeight: 3, promptFirst: 3 };
    // Those three rows take the prompt's two lines, the conversation keeping its one (TUI design pass, Task 4).
    const lined = { ...off, rules: true, viewHeight: 1, promptFirst: 2 };

    it("the working line takes a row above the prompt", () => {
      expect(frame(tall)).toMatchObject(lined);
      expect(frame(tall).promptWindow).toEqual({ top: 2, above: 3, below: 5 });
      const on = frame({ ...tall, working: true });
      expect(on).toMatchObject({ ...off, rules: false, viewHeight: 2, promptFirst: 3 });
      expect(on.promptWindow).toEqual({ top: 2, above: 3, below: 5 });
      // In classic mode it takes one of the prompt's.
      expect(frame({ ...tall, full: false })).toMatchObject({ promptSpace: 9, promptShown: 9, promptFirst: 0 });
      expect(frame({ ...tall, full: false, working: true })).toMatchObject({ promptSpace: 8, promptShown: 8, promptFirst: 1 });
    });

    // Release 8c plan, choice 67 and Task 17: the open run's live row, two rows above the working line.
    it("the open run's live row takes its rows above the prompt, as the working line does", () => {
      expect(frame({ ...tall, working: true, liveRows: 2 })).toMatchObject({ promptSpace: 5, promptShown: 5, viewHeight: 1, promptFirst: 4 });
      expect(frame({ ...tall, full: false, working: true, liveRows: 2 })).toMatchObject({ promptSpace: 6, promptShown: 6, promptFirst: 3 });
    });

    it("a tool line takes a row under the status line, where there is room for it, the hint and the cursor's row", () => {
      const on = frame({ ...tall, toolLine: true });
      expect(on).toMatchObject({ ...off, rules: false, tooled: true, viewHeight: 2, promptFirst: 2 });
      expect(on.promptWindow).toEqual({ top: 2, above: 3, below: 5 });
      // Four rows leave one, which the cursor's row keeps; six leave three, one each.
      expect(frame({ ...tall, rows: 4, toolLine: true })).toMatchObject({ tooled: false, hinted: false });
      expect(frame({ ...tall, rows: 6, toolLine: true })).toMatchObject({ tooled: true, hinted: true });
    });

    it("the detail view draws no prompt: the conversation's place has every row but the hint's and the status line's", () => {
      const on = frame({ ...tall, detail: true });
      expect(on).toMatchObject({ ...off, rules: false, viewHeight: 9, promptFirst: 9 });
      // With no cursor's row to keep, a four-row terminal still has the hint row, for the detail view's keys.
      expect(frame({ ...tall, rows: 4 })).toMatchObject({ hinted: false });
      expect(frame({ ...tall, rows: 4, detail: true })).toMatchObject({ hinted: true });
    });

    it("the prompt's window moves from where it was last drawn only as far as the cursor needs", () => {
      const moved = frame({ ...tall, promptTop: 4 });
      expect(moved).toMatchObject(lined);
      expect(moved.promptWindow).toEqual({ top: 4, above: 5, below: 3 });
    });
  });
});
