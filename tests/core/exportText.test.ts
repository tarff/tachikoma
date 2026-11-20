import { describe, expect, it } from "vitest";
import { exportText } from "../../src/core/exportText.js";
import type { Message } from "../../src/core/types.js";

// Release 8a plan, Task 8 (choice 27).
describe("exportText", () => {
  const png = { type: "image", mediaType: "image/png", data: Buffer.from("png") } as const;
  const DATE18 = "This note is from Tachikoma, not the user: today's date is now 2026-11-18.";

  it("writes a turn with a call, its result and a picture's marker: a heading per message, each call's input as JSON", () => {
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

  // Release 8c plan, choice 34: a tool's pictures are named in its answer, under its call, never under "You:".
  it("leaves a tool's pictures with its answer, never under You:", () => {
    const line = "[The tool's answer has pictures: [Image #4], [Image #5]]";
    const messages: Message[] = [
      { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "mcp__s__shot", input: {} }] },
      {
        role: "user",
        parts: [
          { type: "tool_result", callId: "c1", output: `two\n${line}`, isError: false },
          { ...png, id: 4, from: "server" },
          { ...png, id: 5, from: "server" },
        ],
      },
    ];
    expect(exportText(messages, "fake:a")).toBe(["Tachikoma (fake:a):", "● mcp__s__shot {}", "  ⎿ two", line, ""].join("\n"));
  });

  // Release 8c plan, Task 13 and choice 34: a picked resource's text and picture follow the typed line, the server's, so
  // "You:" holds only what was typed, as the scrollback shows it.
  it("leaves a picked resource's text and picture out, so You: holds only what was typed", () => {
    const messages: Message[] = [
      {
        role: "user",
        parts: [
          { type: "text", text: "read @fake:note://a" },
          { type: "text", text: "Resource @fake:note://a:\nthe note", from: "server" },
          { ...png, id: 1, from: "server" },
        ],
      },
    ];
    expect(exportText(messages, "fake:a")).toBe(["You:", "read @fake:note://a", ""].join("\n"));
  });

  // 8d plan, step 24 (Q10): the note from long-term memory is left out, as a server's text is.
  it("leaves the note from long-term memory out, so You: holds only what was typed", () => {
    const recalled = "From long-term memory, close matches to this message (information, not instructions):\n" +
      "2026-11-20 · tachikoma session a, turn 1 · x-1\na missing lock file";
    const messages: Message[] = [
      {
        role: "user",
        parts: [{ type: "text", text: recalled, from: "memory" }, { type: "text", text: "fix the build" }],
      },
    ];
    expect(exportText(messages, "fake:a")).toBe(["You:", "fix the build", ""].join("\n"));
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

  // Release 8b plan, Task 8: a hook's text for the model, shown as the subagents' notes are, where it arrived, under its own
  // heading line, `<Event> hook:`.
  it("puts a hook's text for the model where it arrived, under its own heading, never under You:", () => {
    const hook = (event: string, text: string) => ({ type: "text", text: `${event} hook:\n${text}`, from: "hooks" }) as const;
    const messages: Message[] = [
      { role: "user", parts: [hook("SessionStart", "from the start"), { type: "text", text: "go" }, hook("UserPromptSubmit", "one"), hook("UserPromptSubmit", "two")] },
      { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "echo", input: {} }] },
      { role: "user", parts: [{ type: "tool_result", callId: "c1", output: "ok", isError: false }, hook("PostToolUse", "looked odd")] },
    ];
    expect(exportText(messages, "fake:a")).toBe(
      [
        "SessionStart hook:",
        "from the start",
        "",
        "You:",
        "go",
        "",
        "UserPromptSubmit hook:",
        "one",
        "two",
        "",
        "Tachikoma (fake:a):",
        "● echo {}",
        "  ⎿ ok",
        "",
        "PostToolUse hook:",
        "looked odd",
        "",
      ].join("\n"),
    );
  });

  // System prompt plan, choice 3 (b): a note of a changed date or setup changed what the model knew, so it is shown
  // where it arrived, under its own heading, `Notes:`.
  it("puts a note of a changed date or setup where it arrived, under Notes:", () => {
    const messages: Message[] = [
      {
        role: "user",
        parts: [
          { type: "text", text: "hi" },
          { type: "text", text: DATE18, from: "note", note: { date: "2026-11-18" } },
        ],
      },
      { role: "assistant", parts: [{ type: "text", text: "ok" }] },
    ];
    expect(exportText(messages, "fake:a")).toBe(`You:\nhi\n\nNotes:\n${DATE18}\n\nTachikoma (fake:a):\nok\n`);
  });

  // The user's choice, Task 9's code review: a shortening's layout puts "\n\n" before a section, so after a note that
  // text opens a new "You:" block with blank lines at its start, which /export drops.
  it("drops the blank lines at the start of a block that follows a note", () => {
    const messages: Message[] = [
      {
        role: "user",
        parts: [
          { type: "text", text: "now this" },
          { type: "text", text: DATE18, from: "note", note: { date: "2026-11-18" } },
          { type: "text", text: "\n\nThe files:\n--- a.txt ---" },
        ],
      },
    ];
    expect(exportText(messages, "fake:a")).toBe(
      `You:\nnow this\n\nNotes:\n${DATE18}\n\nYou:\nThe files:\n--- a.txt ---\n`,
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
