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
      tooled: false,
      hinted: true,
      menuRows: 0,
      panel: [],
      promptSpace: 16,
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
      viewHeight: 16, // with the prompt, the hint and the status line, 19 rows
      promptFirst: 16,
    });
  });

  it("windows a prompt taller than its space around the cursor, leaving the conversation its one row", () => {
    // Of ten rows, the frame's row short, the conversation's, the hint and the status line leave six for twelve.
    const f = frame({ ...base, rows: 10, promptRows: 12, cursorRow: 11 });
    expect(f).toMatchObject({ promptSpace: 6, promptShown: 6, left: 0, viewHeight: 1, promptFirst: 1 });
    expect(f.promptWindow).toEqual({ top: 6, above: 7, below: 0 });
  });

  it("cuts the prompt to the cursor's row under an open menu, which takes the rest", () => {
    const long = frame({ ...base, rows: 12, promptRows: 3, cursorRow: 1, menu: 20 });
    expect(long).toMatchObject({ menuRows: 7, promptSpace: 1, promptShown: 1, left: 0, viewHeight: 1, promptFirst: 1 });
    expect(long.promptWindow).toEqual({ top: 1, above: 0, below: 0 });
    // A short menu takes its entries' rows; the prompt is still cut, and the conversation has the rest.
    const short = frame({ ...base, rows: 12, promptRows: 3, cursorRow: 1, menu: 2 });
    expect(short).toMatchObject({ menuRows: 2, promptSpace: 1, promptShown: 1, left: 5, viewHeight: 6, promptFirst: 6 });
  });

  it("shares the room between the task panel and the to-do list, which gives way before the prompt does", () => {
    const tasks = [subagent("t1"), subagent("t2")];
    const shared: FrameIn = { ...base, rows: 14, taskRows: (rows) => taskRows(tasks, rows, 0), todoRows: (rows) => todoRows(items, rows) };
    const f = frame(shared);
    expect(f.panel).toHaveLength(4); // two subagents, two rows each
    expect(f.todoShown.map((r) => r.text)).toEqual(["item 0", "item 1", "item 2", "item 3", "+4 more"]);
    expect(f).toMatchObject({ promptSpace: 6, promptShown: 1, left: 0, viewHeight: 1, promptFirst: 6 });
    // A four-row prompt keeps its rows; the list is cut to two.
    const tall = frame({ ...shared, promptRows: 4, cursorRow: 3 });
    expect(tall.todoShown.map((r) => r.text)).toEqual(["item 0", "+7 more"]);
    expect(tall).toMatchObject({ promptShown: 4, left: 0, viewHeight: 1, promptFirst: 3 });
  });

  it("shows as many queued messages as fit, the last row saying how many more, and none with no row left", () => {
    // Five rows left for seven: four and "+3 more".
    expect(frame({ ...base, rows: 10, queued: 7 })).toMatchObject({ left: 5, queuedShown: 5, viewHeight: 1, promptFirst: 6 });
    expect(frame({ ...base, rows: 10, queued: 3 })).toMatchObject({ left: 5, queuedShown: 3, viewHeight: 3, promptFirst: 6 });
    expect(frame({ ...base, rows: 5, queued: 7 })).toMatchObject({ left: 0, queuedShown: 0, viewHeight: 1, promptFirst: 1 });
  });

  it("gives the model list the rows it needs, up to all but the conversation's one row, its filter line and the status line", () => {
    const list: FrameIn = { ...base, rows: 12, hint: false, pickerNeeded: 30 };
    expect(frame(list)).toMatchObject({ pickerRows: 8, hinted: false, viewHeight: 1 });
    expect(frame({ ...list, hint: true })).toMatchObject({ pickerRows: 7, hinted: true, viewHeight: 1 });
    expect(frame({ ...list, pickerNeeded: 3 })).toMatchObject({ pickerRows: 3, viewHeight: 6 });
  });

  it("draws a question that fits in its rows, and gives one too long to fit its short line's rows", () => {
    const columns = 60;
    const fitting = "Allow run: ls? [y/n] · Esc to decline";
    const long = `Allow run: ${"echo hello ".repeat(60)}? [y/n] · Esc to decline`;
    const short = "Allow run (shown above)? [y/n] · Esc to decline";
    // Seven rows are the most that fit in ten, the frame's row short, the status line's and the conversation's one taken.
    const seven = "x".repeat(7 * columns);
    const eight = "x".repeat(7 * columns + 1);
    expect([fitting, long, short, seven, eight].map((t) => wrap(t, columns, false).length)).toEqual([1, 12, 1, 7, 8]);
    const asked: FrameIn = { ...base, rows: 10, columns, hint: false, question: true };
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
    expect(frame({ ...asked, full: false })).toMatchObject({ questionFits: true, asked: [], viewHeight: 8 });
  });

  // Release 7 plan, Task 8 and choice 63: a dangerous command's red lines are drawn above the question in full screen, one
  // row each (cut at the terminal's width as it is drawn), in the rows the question leaves the conversation beyond its
  // one; when they do not all fit, the last row drawn says how many more there are. The frame never passes the terminal.
  it("draws a question's red lines a row each, as many as fit, the last saying how many more", () => {
    const columns = 60;
    const fitting = "Allow run: git push --force? [y/n] · Esc to decline";
    const short = "Allow run (shown above)? [y/n] · Esc to decline";
    const red = (n: number) => `Danger: rewriting or deleting git history: git push --force origin b${n}`;
    const long = `Danger: rewriting or deleting git history: git push --force ${"origin ".repeat(5)}`;
    expect(wrap(long, columns, false).length).toBe(2); // two rows if wrapped; one row here
    const reds = (n: number) => Array.from({ length: n }, (_, i) => red(i + 1));
    // Ten rows: the frame's row short, the conversation's one, the question's and the status line's leave six.
    const asked: FrameIn = { ...base, rows: 10, columns, hint: false, question: true, askedText: fitting, askedShort: short };
    expect(frame({ ...asked, askedWarnings: [red(1)] })).toMatchObject({ questionFits: true, warned: [red(1)], asked: [fitting], viewHeight: 6 });
    expect(frame({ ...asked, askedWarnings: [red(1), long] })).toMatchObject({ warned: [red(1), long], viewHeight: 5 });
    expect(frame({ ...asked, askedWarnings: reds(6) })).toMatchObject({ warned: reds(6), viewHeight: 1 });
    // Seven and more: five of them and the count of the rest, which is never one, as its row takes one red line's place.
    expect(frame({ ...asked, askedWarnings: reds(7) })).toMatchObject({ warned: [...reds(5), "…and 2 more dangers"], viewHeight: 1 });
    expect(frame({ ...asked, askedWarnings: reds(12) })).toMatchObject({ warned: [...reds(5), "…and 7 more dangers"], viewHeight: 1 });
    // A question of two rows keeps them, as one red row still fits beside it, and the red lines take what is left.
    const two = "x".repeat(columns + 1);
    expect(frame({ ...asked, askedText: two, askedWarnings: reds(6) })).toMatchObject({
      questionFits: true,
      asked: { length: 2 },
      warned: [...reds(4), "…and 2 more dangers"],
      viewHeight: 1,
    });
    // One that leaves no row for a red line moves, so they have room again.
    const eight = "x".repeat(7 * columns + 1);
    const seven = "x".repeat(7 * columns);
    expect(frame({ ...asked, askedText: seven, askedWarnings: [red(1)] })).toMatchObject({ questionFits: false, asked: [short], warned: [red(1)] });
    const moved = frame({ ...asked, askedText: eight, askedWarnings: reds(7) });
    expect(moved).toMatchObject({ asked: [short], warned: [...reds(5), "…and 2 more dangers"], viewHeight: 1 });
    // One that cannot move is one that has moved (App.tsx, movable), drawn as its short line; its red row is kept.
    expect(frame({ ...asked, askedText: short, askedShort: null, askedWarnings: [red(1)] })).toMatchObject({ asked: [short], warned: [red(1)] });
    // Forty by seven, a moved question, the hint and the tool line: the tool line and the hint count the question's own
    // two rows and its red row, so the tool line gives way, and the question's rows, the hint and the status line leave
    // the red row its row, with a turn running or not, as the working line is not drawn under a question. With room for
    // one red row only, it says how many dangers there are.
    const small: FrameIn = {
      ...base,
      rows: 7,
      columns: 40,
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
    expect(frame({ ...asked, full: false, askedText: null, askedShort: null, askedWarnings: [red(1)] })).toMatchObject({ warned: [], viewHeight: 8 });
  });

  // Release 7 plan, Task 10: auto mode's pause is a grey row of the question. It counts as one of the question's own rows,
  // as the first red row does, in whether the question fits and in what the tool line and the hint leave, and it is drawn
  // only when there is a row for it beyond the conversation's one and, as Task 8 always keeps one red row, beyond that red
  // row. The gate never sends a grey line with red lines today (a paused question has no dangers), but the frame takes
  // both, the grey row above.
  it("draws a question's grey line as a row of its own when there is a row for it, before any red lines", () => {
    const columns = 60;
    const fitting = "Allow read /made/up/notes.txt? [y/n] · Esc to decline";
    const short = "Allow read (shown above)? [y/n] · Esc to decline";
    const red = (n: number) => `Danger: rewriting or deleting git history: git push --force origin b${n}`;
    const reds = (n: number) => Array.from({ length: n }, (_, i) => red(i + 1));
    // Ten rows: the frame's row short, the conversation's one, the grey row, the question's and the status line's.
    const asked: FrameIn = { ...base, rows: 10, columns, hint: false, question: true, askedText: fitting, askedShort: short, askedNote: true };
    expect(frame(asked)).toMatchObject({ questionFits: true, noted: true, warned: [], asked: [fitting], viewHeight: 6 });
    expect(frame({ ...asked, askedWarnings: reds(7) })).toMatchObject({ noted: true, warned: [...reds(4), "…and 3 more dangers"], viewHeight: 1 });
    // Seven rows fit without the grey row (above) and not with it, so the question moves to its short line.
    const seven = "x".repeat(7 * columns);
    expect(frame({ ...asked, askedText: seven })).toMatchObject({ questionFits: false, noted: true, asked: [short] });
    expect(frame({ ...asked, askedText: seven, askedNote: false })).toMatchObject({ questionFits: true, noted: false });
    // Forty by seven, a moved question of two rows with a red line, the hint and the tool line: the grey row is the
    // question's own, so the tool line and the hint give way, and the red row keeps its row. The frame is a row short.
    const small: FrameIn = { ...base, rows: 7, columns: 40, working: true, hint: true, toolLine: true, question: true, askedText: short, askedShort: null, askedNote: true };
    const f = frame({ ...small, askedWarnings: [red(1)] });
    expect(f).toMatchObject({ tooled: false, hinted: false, noted: true, asked: { length: 2 }, warned: [red(1)], viewHeight: 1 });
    expect(f.viewHeight + 1 + f.warned.length + f.asked.length + 1).toBe(6); // the conversation, grey, red, question, status
    // With no question drawn, as in classic mode or under the model list, there is no grey row.
    expect(frame({ ...asked, askedText: null })).toMatchObject({ noted: false });
    // Four rows and a one-line question that cannot move: the frame's row short, the conversation's, the question's and
    // the status line's leave none, so the grey row is left out, as a red row would be, and the frame stays a row short.
    const four = frame({ ...asked, rows: 4, askedShort: null });
    expect(four).toMatchObject({ noted: false, asked: [fitting], warned: [], viewHeight: 1 });
    expect(four.viewHeight + four.asked.length + 1).toBe(3);
    // Five rows, a red line too, and the question moved to its one-row short line: one row is free, and the red row
    // takes it; the grey row gives way.
    const five = frame({ ...asked, rows: 5, askedWarnings: [red(1)] });
    expect(five).toMatchObject({ questionFits: false, asked: [short], noted: false, warned: [red(1)], viewHeight: 1 });
    expect(five.viewHeight + five.warned.length + five.asked.length + 1).toBe(4);
  });

  describe("one input changed, every other the same", () => {
    // A twelve-row prompt, the cursor on its seventh row, in a frame of twelve rows.
    const tall: FrameIn = { ...base, rows: 12, promptRows: 12, cursorRow: 6 };
    const off = { tooled: false, hinted: true, promptSpace: 8, promptShown: 8, left: 0, viewHeight: 1, promptFirst: 1 };

    it("the working line takes a row above the prompt", () => {
      expect(frame(tall)).toMatchObject(off);
      expect(frame(tall).promptWindow).toEqual({ top: 0, above: 0, below: 5 });
      const on = frame({ ...tall, working: true });
      expect(on).toMatchObject({ ...off, promptSpace: 7, promptShown: 7, promptFirst: 2 });
      expect(on.promptWindow).toEqual({ top: 1, above: 2, below: 5 });
    });

    it("a tool line takes a row under the status line, where there is room for it, the hint and the cursor's row", () => {
      const on = frame({ ...tall, toolLine: true });
      expect(on).toMatchObject({ ...off, tooled: true, promptSpace: 7, promptShown: 7 });
      expect(on.promptWindow).toEqual({ top: 1, above: 2, below: 5 });
      // Four rows leave one, which the cursor's row keeps; six leave three, one each.
      expect(frame({ ...tall, rows: 4, toolLine: true })).toMatchObject({ tooled: false, hinted: false });
      expect(frame({ ...tall, rows: 6, toolLine: true })).toMatchObject({ tooled: true, hinted: true });
    });

    it("the detail view draws no prompt: the conversation's place has every row but the hint's and the status line's", () => {
      const on = frame({ ...tall, detail: true });
      expect(on).toMatchObject({ ...off, viewHeight: 9, promptFirst: 9 });
      // With no cursor's row to keep, a four-row terminal still has the hint row, for the detail view's keys.
      expect(frame({ ...tall, rows: 4 })).toMatchObject({ hinted: false });
      expect(frame({ ...tall, rows: 4, detail: true })).toMatchObject({ hinted: true });
    });

    it("the prompt's window moves from where it was last drawn only as far as the cursor needs", () => {
      const moved = frame({ ...tall, promptTop: 4 });
      expect(moved).toMatchObject(off);
      expect(moved.promptWindow).toEqual({ top: 4, above: 5, below: 0 });
    });
  });
});
