import { describe, expect, it } from "vitest";
import type { ToolOutcome } from "../../src/core/bus.js";
import type { TodoItem } from "../../src/tools/todo.js";
import { todoRows } from "../../src/tui/TodoList.js";
import { toolParts } from "../../src/tui/ToolLine.js";
import { workingText } from "../../src/tui/WorkingLine.js";

describe("workingText", () => {
  const spend = { lead: "anthropic:claude-opus-5-5", output: 0, cost: 0, costUnknown: false };

  it("shows the label, the turn's time in seconds, its tokens and cost, and Esc, the spinner moving every 80 ms", () => {
    expect(workingText("Working", 0, spend)).toBe("⠋ Working · 0s · ↓ 0 tokens · $0.00 · Esc to stop");
    expect(workingText("Working", 80, spend)).toBe("⠙ Working · 0s · ↓ 0 tokens · $0.00 · Esc to stop");
    expect(workingText("Working", 72_400, { ...spend, output: 2_345, cost: 0.0412 })).toBe("⠴ Working · 1m 12s · ↓ 2.3k tokens · $0.04 · Esc to stop");
  });

  it("follows the status line's rules for the cost: the ChatGPT plan, and a model without a price", () => {
    expect(workingText("Working", 1_000, { ...spend, lead: "chatgpt:gpt-6.1-sol" })).toBe("⠹ Working · 1s · ↓ 0 tokens · ChatGPT plan · Esc to stop");
    expect(workingText("Working", 1_000, { ...spend, lead: "ollama:x", costUnknown: true })).toBe("⠹ Working · 1s · ↓ 0 tokens · $0.00 + ? · Esc to stop");
  });

  it("leaves out tokens and cost for what is not a turn", () => {
    expect(workingText("Waiting for the browser", 5_000, null)).toBe("⠹ Waiting for the browser · 5s · Esc to stop");
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
