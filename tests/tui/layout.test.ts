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
      askedRows: 0,
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
    expect(frame({ ...base, rows: 10, queued: 5 })).toMatchObject({ left: 5, queuedShown: 5 });
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
    expect([fitting, long, short].map((t) => wrap(t, columns, false).length)).toEqual([1, 12, 1]);
    const asked: FrameIn = { ...base, rows: 10, columns, hint: false, question: true };
    expect(frame({ ...asked, askedText: fitting, askedShort: short })).toMatchObject({ questionFits: true, askedRows: 1, viewHeight: 7 });
    expect(frame({ ...asked, askedText: long, askedShort: short })).toMatchObject({ questionFits: false, askedRows: 1, viewHeight: 7 });
    // One that cannot move (it has moved already, or the list is open) keeps its rows, the conversation its one row.
    expect(frame({ ...asked, askedText: long })).toMatchObject({ questionFits: false, askedRows: 12, viewHeight: 1 });
    // In classic mode a question is drawn as one Text, which counts no rows here.
    expect(frame({ ...asked, full: false })).toMatchObject({ questionFits: true, askedRows: 0, viewHeight: 8 });
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
      expect(frame(tall).promptWindow).toEqual({ top: 0, above: 0, below: 5 });
    });
  });
});
