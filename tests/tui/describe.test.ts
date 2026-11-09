import { describe, expect, it } from "vitest";
import type { Message } from "../../src/core/types.js";
import { lastTurn, describe as lines } from "../../src/tui/describe.js";

describe("describe", () => {
  // Release 8b design, "What a hook's answer does": the user does not see a hook's text for the model in the conversation.
  it("leaves a hook's text for the model out of the scrollback", () => {
    const results: Message = {
      role: "user",
      parts: [
        { type: "tool_result", callId: "c1", output: "ran", isError: false },
        { type: "text", text: "PostToolUse hook:\nmore", from: "hooks" },
      ],
    };
    expect(lines(results)).toEqual([{ text: "  ⎿ ok", color: "gray", oneLine: true }]);
  });
});

describe("lastTurn", () => {
  // Task 9's code review: a Stop hook's feedback keeps the turn going, so it starts no turn of its own; background answers
  // alone still do (tests/tui/statusline.test.tsx).
  it("takes a Stop hook's feedback, with the waiting text after it, as part of the turn it kept going", () => {
    const feedback = { type: "text", text: "Stop hook feedback:\nrun the tests", from: "hooks" } as const;
    const turn = lastTurn([
      { role: "user", parts: [{ type: "text", text: "go" }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "shell", input: { command: "ls" } }] },
      { role: "user", parts: [{ type: "tool_result", callId: "c1", output: "a.txt", isError: false }] },
      { role: "assistant", parts: [{ type: "text", text: "done" }] },
      { role: "user", parts: [feedback, { type: "text", text: "t1 finished", from: "tasks" }] },
      { role: "assistant", parts: [{ type: "text", text: "tests pass" }] },
    ]);
    expect(turn[0]).toEqual({ text: "Last turn: 1 tool call", color: "gray" });
  });
});
