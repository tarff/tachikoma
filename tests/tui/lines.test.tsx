import { describe, expect, it } from "vitest";
import type { ToolOutcome } from "../../src/core/bus.js";
import type { TodoItem } from "../../src/tools/todo.js";
import type { CommandTask, Task } from "../../src/core/tasks.js";
import { names } from "../../src/tui/app/constants.js";
import { taskRows } from "../../src/tui/TaskPanel.js";
import { todoRows } from "../../src/tui/TodoList.js";
import { toolParts } from "../../src/tui/ToolLine.js";
import { workingText } from "../../src/tui/WorkingLine.js";

describe("workingText", () => {
  const spend = { lead: "anthropic:claude-opus-5-5", output: 0, cost: 0, costUnknown: false };

  it("shows the label, the turn's time in seconds, its tokens and cost, and Esc, the spinner moving every 80 ms", () => {
    expect(workingText("Working", 0, spend, "Esc")).toBe("⠋ Working · 0s · ↓ 0 tokens · $0.00 · Esc to stop");
    expect(workingText("Working", 80, spend, "Esc")).toBe("⠙ Working · 0s · ↓ 0 tokens · $0.00 · Esc to stop");
    expect(workingText("Working", 72_400, { ...spend, output: 2_345, cost: 0.0412 }, "Esc")).toBe(
      "⠴ Working · 1m 12s · ↓ 2.3k tokens · $0.04 · Esc to stop",
    );
  });

  it("follows the status line's rules for the cost: the ChatGPT plan, and a model without a price", () => {
    expect(workingText("Working", 1_000, { ...spend, lead: "chatgpt:gpt-6.1-sol" }, "Esc")).toBe(
      "⠹ Working · 1s · ↓ 0 tokens · ChatGPT plan · Esc to stop",
    );
    expect(workingText("Working", 1_000, { ...spend, lead: "ollama:x", costUnknown: true }, "Esc")).toBe(
      "⠹ Working · 1s · ↓ 0 tokens · $0.00 + ? · Esc to stop",
    );
  });

  it("leaves out tokens and cost for what is not a turn", () => {
    expect(workingText("Waiting for the browser", 5_000, null, "Esc")).toBe("⠹ Waiting for the browser · 5s · Esc to stop");
  });

  it("leaves out the stop key when no key is bound to chat:cancel", () => {
    expect(workingText("Working", 1_000, null, undefined)).toBe("⠹ Working · 1s");
  });

  // Background commands plan, Task 10 (the user's choice 33): the key that moves a held foreground command, last.
  it("ends with the key that moves a running command to the background, after the stop key when there is one", () => {
    expect(workingText("Working", 1_000, spend, "Esc", "ctrl+b")).toBe("⠹ Working · 1s · ↓ 0 tokens · $0.00 · Esc to stop · ctrl+b to run in background");
    expect(workingText("Working", 1_000, null, undefined, "ctrl+g")).toBe("⠹ Working · 1s · ctrl+g to run in background");
  });
});

describe("toolParts", () => {
  let n = 0;
  const call = (name: string, outcome?: ToolOutcome, target: string | null = null) => ({ id: `c${n++}`, name, target, ...(outcome ? { outcome } : {}) });
  const shown = (calls: ReturnType<typeof call>[]) => toolParts(calls).map((p) => `${p.mark} ${p.rest}`);

  it("shows the running call with its target, then the finished ones counted by tool and how they ended, most first, four at most", () => {
    const calls = [
      call("edit_file", "ok"),
      call("read_file", "ok"),
      call("read_file", "ok"),
      call("shell", "failed"),
      call("read_file", "ok"),
      call("write_file", "declined"),
      call("shell", "cancelled"),
      call("shell", undefined, "npm test"),
    ];
    expect(shown(calls)).toEqual(["◐ shell npm test", "✓ read_file ×3", "✓ edit_file ×1", "✗ shell ×1", "⊘ write_file ×1"]);
    expect(toolParts(calls).map((p) => [p.color, p.whole])).toEqual([["yellow", false], ["green", false], ["green", false], ["red", true], ["gray", true]]);
  });

  // Release 8c plan, choice 68 (Task 18, the user's answer, 2026-11-12): an MCP call by its server and tool as the server
  // gives them, escaped; without the window's names, the safe server and the full name's tool part.
  it("names an MCP call by its server and tool as the server gives them", () => {
    const names = (full: string) => (full === "mcp__my_tv__foo_bar" ? { server: "my.tv", tool: "foo\u0007.bar" } : { server: "?", tool: "?" });
    const dotted = [call("mcp__my_tv__foo_bar", "ok"), call("mcp__my_tv__foo_bar", undefined, null)];
    expect(toolParts(dotted, names).map((p) => `${p.mark} ${p.rest}`)).toEqual(["◐ my.tv foo\\u0007.bar", "✓ my.tv foo\\u0007.bar ×1"]);
    expect(shown([call("mcp__tradingview__chart_set_symbol", "ok")])).toEqual(["✓ tradingview chart_set_symbol ×1"]);
    expect(shown([call("mcp__tradingview", "failed")])).toEqual(["✗ tradingview ×1"]); // no tool part: the server alone (the review)
  });

  it("escapes what the model named, and has nothing to show with no calls", () => {
    expect(shown([call("x\u001b[2J", undefined, "a\rb")])).toEqual(["◐ x\\u001b[2J a␍b"]);
    expect(toolParts([])).toEqual([]);
  });
});

describe("todoRows", () => {
  const list = (...statuses: TodoItem["status"][]): TodoItem[] => statuses.map((status, n) => ({ text: `item ${n}`, status }));
  const shown = (items: TodoItem[], rows: number) => todoRows(items, rows).map((r) => `${r.mark} ${r.text}`.trim());

  it("marks each item: to do, doing in yellow, done in grey", () => {
    expect(todoRows(list("done", "in_progress", "pending"), 5)).toEqual([
      { mark: "☑", text: "item 0", color: "gray" },
      { mark: "◐", text: "item 1", color: "yellow" },
      { mark: "☐", text: "item 2" },
    ]);
  });

  it("when short of rows, shows the item in progress and those next to it, then how many more", () => {
    const items = list("done", "done", "done", "in_progress", "pending", "pending", "pending");
    expect(shown(items, 4)).toEqual(["☑ item 2", "◐ item 3", "☐ item 4", "+4 more"]);
    expect(shown(items, 2)).toEqual(["◐ item 3", "+6 more"]);
    expect(shown(items, 1)).toEqual(["◐ item 3"]);
    expect(shown(items, 0)).toEqual([]);
  });

  it("with nothing in progress, centres on the first item not done; near an end, keeps the rows full", () => {
    expect(shown(list("done", "pending", "pending", "pending", "pending"), 3)).toEqual(["☑ item 0", "☐ item 1", "+3 more"]);
    expect(shown(list("done", "done", "done", "done", "in_progress"), 3)).toEqual(["☑ item 3", "◐ item 4", "+3 more"]);
  });

  it("escapes what the model wrote", () => {
    expect(shown([{ text: "a\u001b[2Jb\rc", status: "pending" }], 1)).toEqual(["☐ a\\u001b[2Jb␍c"]);
  });
});

describe("taskRows", () => {
  const now = 1_000_000;
  const task = (over: Partial<Task>): Task =>
    ({
      kind: "subagent",
      id: "t2",
      description: "find the login code",
      task: "In the project, find the login code.",
      model: "anthropic:claude-haiku-5-5",
      background: true,
      state: "running",
      started: now - 12_000,
      output: 1_234,
      cost: 0.0123,
      costUnknown: false,
      lastTool: { name: "read_file", input: { path: "src/auth/oauth.ts" } },
      shown: true,
      messages: [],
      done: Promise.resolve({ state: "done", text: "" }),
      ...over,
    }) as Task;
  const shown = (tasks: Task[], rows = 10) => taskRows(tasks, rows, now).map((r) => `${r.mark} ${r.text}`);

  it("shows a running subagent's number and description, then under it its model, time, tokens, cost and latest tool call", () => {
    expect(shown([task({})])).toEqual(["◐ t2 find the login code", "  ⎿ claude-haiku-5-5 · 12s · ↓ 1.2k tokens · $0.01 · read_file src/auth/oauth.ts"]);
    expect(taskRows([task({})], 2, now)[0]!.color).toBe("yellow");
  });

  it("says when one waits for a place, and marks finished ones as the tool line does, without a tool", () => {
    const rows = taskRows(
      [task({ id: "t1", state: "waiting" }), task({ id: "t3", state: "done", ended: now - 2_000 }), task({ id: "t4", state: "failed", ended: now }), task({ id: "t5", state: "stopped", ended: now })],
      10,
      now,
    );
    expect(rows.filter((_, i) => i % 2 === 0).map((r) => [r.mark, r.color])).toEqual([["◐", "gray"], ["✓", "green"], ["✗", "red"], ["⊘", "gray"]]);
    expect(rows[1]!.text).toBe("⎿ claude-haiku-5-5 · waiting");
    expect(rows[3]!.text).toBe("⎿ claude-haiku-5-5 · 10s · ↓ 1.2k tokens · $0.01");
  });

  it("puts running ones first, leaves out those taken off the panel, and says how many more do not fit", () => {
    const tasks = [task({ id: "t1", state: "done", ended: now }), task({ id: "t2" }), task({ id: "t3" }), task({ id: "t4", shown: false, state: "done", ended: now })];
    expect(shown(tasks).filter((r) => !r.startsWith(" ")).map((r) => r.split(" ")[1])).toEqual(["t2", "t3", "t1"]);
    expect(shown(tasks, 4)).toEqual([...shown(tasks).slice(0, 2), "  +2 more"]);
    expect(shown(tasks, 1)).toEqual(["  +3 more"]);
  });

  // Release 8c plan, choice 68 and Task 18: an MCP call names its server and its tool as the server gives them, escaped;
  // without the window's names, the safe server and the full name's tool part.
  it("names a latest MCP call by its server and tool as the server gives them", () => {
    const mcp = task({ lastTool: { name: "mcp__my_tv__foo_bar", input: { x: 1 } } });
    const names = (full: string) => (full === "mcp__my_tv__foo_bar" ? { server: "my.tv", tool: "foo\u0007.bar" } : { server: "?", tool: "?" });
    expect(taskRows([mcp], 10, now, names)[1]!.text).toBe("⎿ claude-haiku-5-5 · 12s · ↓ 1.2k tokens · $0.01 · my.tv foo\\u0007.bar");
    expect(taskRows([mcp], 10, now)[1]!.text).toBe("⎿ claude-haiku-5-5 · 12s · ↓ 1.2k tokens · $0.01 · my_tv foo_bar");
  });

  it("escapes what the model wrote, and keeps a description to its first line", () => {
    expect(shown([task({ description: "a\u001b[2Jb\nsecond line", lastTool: { name: "read_file", input: { path: "x\ry" } } })])).toEqual(["◐ t2 a\\u001b[2Jb", "  ⎿ claude-haiku-5-5 · 12s · ↓ 1.2k tokens · $0.01 · read_file x␍y"]);
  });

  // Background commands plan, choice 18: a command's rows; one that ended with no exit code shows the running row's
  // shape, its mark saying how it ended (Task 9).
  const command = (over: Partial<CommandTask>): Task =>
    ({ kind: "command", id: "t4", command: "npm run dev\nnext", background: true, state: "running", started: now - 12_000, shown: true, ...over }) as Task;

  it("shows a command by its first line, then shell, its exit code once it ended with one, and its time", () => {
    expect(shown([command({})])).toEqual(["◐ t4 npm run dev", "  ⎿ shell · 12s"]);
    expect(shown([command({ state: "done", code: 0, signal: null, ended: now - 2_000 })])).toEqual(["✓ t4 npm run dev", "  ⎿ shell · exit code 0 · 10s"]);
    expect(shown([command({ state: "stopped", stoppedBy: "user", ended: now - 2_000 })])).toEqual(["⊘ t4 npm run dev", "  ⎿ shell · 10s"]);
    expect(shown([command({ state: "failed", code: null, signal: "SIGKILL", ended: now - 2_000 })])).toEqual(["✗ t4 npm run dev", "  ⎿ shell · 10s"]);
  });

  it("counts a command in the +N more of a panel too short for every row", () => {
    const tasks = [task({ id: "t1" }), command({ id: "t2" }), command({ id: "t3" })];
    expect(shown(tasks, 4)).toEqual(["◐ t1 find the login code", expect.stringContaining("⎿ claude-haiku-5-5"), "  +2 more"]);
  });
});

// Background commands plan, choice 19: what a wake reads, subagents first, whatever the order they ended in.
describe("names", () => {
  it("names one or several answers, then one or several commands' output", () => {
    expect(names([{ id: "t3", kind: "subagent" }])).toBe("t3's answer");
    expect(names(["t2", "t3", "t4"].map((id) => ({ id, kind: "subagent" as const })))).toBe("t2, t3 and t4's answers");
    expect(names([{ id: "t4", kind: "command" }])).toBe("t4's output");
    const mixed = [
      { id: "t4", kind: "command" as const },
      { id: "t2", kind: "subagent" as const },
      { id: "t5", kind: "command" as const },
      { id: "t3", kind: "subagent" as const },
    ];
    expect(names(mixed)).toBe("t2 and t3's answers and t4 and t5's output");
  });
});
