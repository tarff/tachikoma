import { describe, expect, it } from "vitest";
import type { ToolOutcome } from "../../src/core/bus.js";
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
