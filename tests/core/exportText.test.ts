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

  // User, 2026-11-06: "Include, headed Subagents:". The session's notes for the lead, as the lead got them, where they
  // arrived: after a prompt, after the results they came with, or alone.
  it("puts the session's notes for the lead where they arrived, under Subagents:, and a call not finished says so", () => {
    const messages: Message[] = [
      { role: "user", parts: [{ type: "text", text: "go" }, { type: "text", text: "Background task t1 (find x) finished:\nfound", from: "tasks" }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "echo", input: {} }] },
      { role: "user", parts: [{ type: "tool_result", callId: "c1", output: "ok", isError: false }, { type: "text", text: "t2 failed", from: "tasks" }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "c2", name: "shell", input: { command: "npm test" } }] },
      { role: "user", parts: [{ type: "text", text: "t3 stopped", from: "tasks" }, { type: "text", text: "t4 lost", from: "tasks" }] },
    ];
    expect(exportText(messages, "fake:a")).toBe(
      [
        "You:",
        "go",
        "",
        "Subagents:",
        "Background task t1 (find x) finished:",
        "found",
        "",
        "Tachikoma (fake:a):",
        "● echo {}",
        "  ⎿ ok",
        "",
        "Subagents:",
        "t2 failed",
        "",
        "Tachikoma (fake:a):",
        "● shell {",
        '  "command": "npm test"',
        "}",
        "  ⎿ (not finished)",
        "",
        "Subagents:",
        "t3 stopped",
        "t4 lost",
        "",
      ].join("\n"),
    );
  });

  // User, 2026-11-06: "Record each reply's lead". A reply saved before replies kept their lead is headed with the lead
  // leading now.
  it("heads each reply with the lead that wrote it, or without one the lead leading now", () => {
    const messages: Message[] = [
      { role: "user", parts: [{ type: "text", text: "one" }] },
      { role: "assistant", parts: [{ type: "text", text: "from a" }], lead: "fake:a" },
      { role: "user", parts: [{ type: "text", text: "two" }] },
      { role: "assistant", parts: [{ type: "text", text: "from whoever" }] },
    ];
    expect(exportText(messages, "fake:b")).toBe("You:\none\n\nTachikoma (fake:a):\nfrom a\n\nYou:\ntwo\n\nTachikoma (fake:b):\nfrom whoever\n");
  });

  // Choice 27: LF throughout, a message's own CRLF and lone CR included; a CR ending a result ends its line.
  it("ends every line with LF alone, whatever a message's own line breaks were", () => {
    const messages: Message[] = [
      { role: "user", parts: [{ type: "text", text: "a\r\nb" }] },
      { role: "assistant", parts: [{ type: "text", text: "c\rd" }, { type: "tool_call", id: "c1", name: "shell", input: { command: "x" } }] },
      { role: "user", parts: [{ type: "tool_result", callId: "c1", output: "e\r\nf\r", isError: false }] },
    ];
    expect(exportText(messages, "fake:a")).toBe('You:\na\nb\n\nTachikoma (fake:a):\nc\nd\n● shell {\n  "command": "x"\n}\n  ⎿ e\nf\n');
  });

  // Task 8's quality review: a provider may give a call an id an earlier turn's call had, so a call's result is the one
  // in the message right after its reply.
  it("gives each call the result in the message after its reply, though an earlier turn's call had its id", () => {
    const call = (command: string): Message => ({ role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "shell", input: { command } }] });
    const result = (output: string): Message => ({ role: "user", parts: [{ type: "tool_result", callId: "c1", output, isError: false }] });
    const text = exportText([call("one"), result("first"), call("two"), result("second"), call("three")], "fake:a");
    expect(text.match(/⎿ .*/g)).toEqual(["⎿ first", "⎿ second", "⎿ (not finished)"]);
  });

  it("is empty for a conversation with nothing in it", () => {
    expect(exportText([], "fake:a")).toBe("");
  });
});
