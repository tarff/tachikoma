import { describe, expect, it } from "vitest";
import { exportText } from "../../src/core/exportText.js";
import type { Message } from "../../src/core/types.js";

// Release 8a plan, Task 8 (choice 27).
describe("exportText", () => {
  const png = { type: "image", mediaType: "image/png", data: Buffer.from("png") } as const;

  it("writes a turn with a call, its result and a picture's marker: a heading per message, each call as Ctrl+O shows it", () => {
    const messages: Message[] = [
      { role: "user", parts: [{ type: "text", text: "what is in " }, { ...png, id: 1 }, { ...png, id: 2 }, { type: "text", text: "?" }] },
      { role: "assistant", parts: [{ type: "text", text: "Reading it." }, { type: "tool_call", id: "c1", name: "read_file", input: { path: "a.txt" } }] },
      { role: "user", parts: [{ type: "tool_result", callId: "c1", output: "line 1\nline 2", isError: false }] },
      { role: "assistant", parts: [{ type: "text", text: "Two lines." }] },
    ];
    expect(exportText(messages, "anthropic:claude-opus-5-5")).toBe(
      [
        "You:",
        "what is in [Image #1] [Image #2]?",
        "",
        "Tachikoma (anthropic:claude-opus-5-5):",
        "Reading it.",
        "● read_file {",
        '  "path": "a.txt"',
        "}",
        "  ⎿ line 1",
        "line 2",
        "",
        "Tachikoma (anthropic:claude-opus-5-5):",
        "Two lines.",
        "",
      ].join("\n"),
    );
  });

  // As the scrollback leaves it out (describe.ts): the text the session added for the lead, such as a background
  // subagent's answer, is not the user's; a message with nothing else has no heading.
  it("leaves out the text the session added for the lead, and a call not finished says so", () => {
    const messages: Message[] = [
      { role: "user", parts: [{ type: "text", text: "t1 finished: found it", from: "tasks" }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "shell", input: { command: "npm test" } }] },
    ];
    expect(exportText(messages, "fake:a")).toBe('Tachikoma (fake:a):\n● shell {\n  "command": "npm test"\n}\n  ⎿ (not finished)\n');
  });

  it("is empty for a conversation with nothing in it", () => {
    expect(exportText([], "fake:a")).toBe("");
  });
});
