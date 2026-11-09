import { describe, expect, it } from "vitest";
import type { Message } from "../../src/core/types.js";
import { describe as lines } from "../../src/tui/describe.js";

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
