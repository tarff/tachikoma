import { describe, expect, it } from "vitest";
import { exportText } from "../../src/core/exportText.js";
import { truncate } from "../../src/core/session.js";
import type { Message } from "../../src/core/types.js";
import { MAX_TOOL_OUTPUT } from "../../src/exec/executor.js";
import type { Event, Hook } from "../../src/hooks/config.js";
import type { Run } from "../../src/hooks/hooks.js";
import type { Ran } from "../../src/hooks/run.js";
import { callLines, lastTurn, describe as lines, previewStyles, screen, withoutTrailingRows } from "../../src/tui/describe.js";
import { palette } from "../../src/tui/theme.js";

describe("describe", () => {
  const P = palette({ light: false, color: true, full: true }); // the marks' colours (TUI design pass, Task 3)

  // Release 8b design, "What a hook's answer does": the user does not see a hook's text for the model in the conversation.
  it("leaves a hook's text for the model out of the scrollback", () => {
    const results: Message = {
      role: "user",
      parts: [
        { type: "tool_result", callId: "c1", output: "ran", isError: false },
        { type: "text", text: "PostToolUse hook:\nmore", from: "hooks" },
      ],
    };
    expect(lines(results, P)).toEqual([{ text: "  ⎿ ok", color: "muted", oneLine: true }]);
  });

  // Release 8c plan, choice 34: a tool's pictures are the server's, so they are drawn under the results, never as a prompt.
  it("draws a tool's pictures as a grey row under the results, never as the user's prompt", () => {
    const png = { type: "image", mediaType: "image/png", data: Buffer.from("png"), from: "server" } as const;
    const results: Message = {
      role: "user",
      parts: [
        { type: "tool_result", callId: "c1", output: "two\n[The tool's answer has pictures: [Image #4], [Image #5]]", isError: false },
        { ...png, id: 4 },
        { ...png, id: 5 },
      ],
    };
    expect(lines(results, P)).toEqual([
      { text: "  ⎿ ok", color: "muted", oneLine: true },
      { text: "  ⎿ [Image #4] [Image #5]", color: "muted", oneLine: true },
    ]);
  });

  // Release 8c plan, Task 13 and choice 34: what a server supplied after the typed line is for the model, so the prompt
  // shows as typed, and a resource's picture as a tool's does.
  it("draws a prompt as typed, leaving out the text a server supplied after it", () => {
    const prompt: Message = {
      role: "user",
      parts: [
        { type: "text", text: "/fake:greet Ann" },
        { type: "text", text: "Say hello to Ann.", from: "server" },
        { type: "image", id: 2, mediaType: "image/png", data: Buffer.from("png"), from: "server" },
      ],
    };
    expect(lines(prompt, P)).toEqual([
      { text: "", band: true, block: true },
      { text: "› /fake:greet Ann", band: true, indent: 2 },
      { text: "", band: true },
      { text: "  ⎿ [Image #2]", color: "muted", oneLine: true },
    ]);
  });
});

// TUI design pass, Task 7 (audit 2): an edit's preview in colour, a write's never; the text unchanged.
// PR 20's review: a line's text ending in line breaks draws no empty rows of its own, so a block after it has one gap.
describe("withoutTrailingRows", () => {
  it("takes off the line breaks a text ends in, and the blanks among them, keeping its spans inside it", () => {
    for (const end of ["\n", "\n\n", "\r\n", "  \n \t\n"]) expect(withoutTrailingRows({ text: `● hi${end}`, indent: 2 })).toEqual({ text: "● hi", indent: 2 });
    const styled = withoutTrailingRows({ text: "● hi\n", styles: [{ start: 0, end: 5, color: "#4278de" }] });
    expect(styled).toEqual({ text: "● hi", styles: [{ start: 0, end: 4, color: "#4278de" }] });
  });

  it("leaves a text that ends in no line break, and a one-line line, whose breaks show escaped, as they are", () => {
    const plain = { text: "● hi  " };
    expect(withoutTrailingRows(plain)).toBe(plain);
    const one = { text: "  ⎿ ok\n", oneLine: true as const };
    expect(withoutTrailingRows(one)).toBe(one);
  });
});

describe("previewStyles", () => {
  const FULL = palette({ light: false, color: true, full: true });
  const NAMED = palette({ light: false, color: true, full: false });
  const NONE = palette({ light: false, color: false, full: false });
  const add = { color: FULL.success, bg: FULL.addTint };
  const del = { color: FULL.error, bg: FULL.delTint };

  // edit_file's detail (files.ts): old_text "a\nb", new_text "c". Each span runs to just past its line's line break.
  it("colours an edit's `-` and `+` lines, each span over its whole line", () => {
    expect(previewStyles("edit a.txt", "- a\n- b\n+ c", FULL)).toEqual([
      { start: 0, end: 4, ...del },
      { start: 4, end: 8, ...del },
      { start: 8, end: 11, ...add },
    ]);
  });

  it("leaves a write's preview without spans, its lines starting with `-` or `+` or not", () => {
    expect(previewStyles("write a.md", "- one\n+ two\n-three", FULL)).toEqual([]);
  });

  it("gives no spans without colour, and colours without tints below full colour", () => {
    expect(previewStyles("edit a.txt", "- a\n+ c", NONE)).toEqual([]);
    expect(previewStyles("edit a.txt", "- a\n+ c", NAMED)).toEqual([
      { start: 0, end: 4, color: "red" },
      { start: 4, end: 7, color: "green" },
    ]);
  });

  // Task 2's known limit: a span edge between \r and \n draws the \r. old_text "a\r\nb" and new_text "c\r\nd", as a model
  // may send a CRLF file's text, keep each \r before its line break; screened, the \r goes with the break and the spans
  // still meet, so the tint has no gap.
  it("draws no \\r in a CRLF edit's preview, the spans meeting at each line", () => {
    const detail = "- a\r\n- b\n+ c\r\n+ d";
    const shown = screen({ text: detail, color: "muted", styles: previewStyles("edit a.txt", detail, FULL) });
    expect(shown.text).toBe("- a\n- b\n+ c\n+ d");
    expect(shown.styles).toEqual([
      { start: 0, end: 4, ...del },
      { start: 4, end: 8, ...del },
      { start: 8, end: 12, ...add },
      { start: 12, end: 15, ...add },
    ]);
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
    expect(turn[0]).toEqual({ text: "Last turn: 1 tool call", color: "muted" });
  });

  // Release 8b plan, choice 24 ("Lines this plan adds", Ctrl+O): each hook run after the calls, one line each, what it
  // handed the model under it after ⎿, its command escaped as the question escapes one.
  it("lists the turn's hook runs after its calls: out of time, could not start, a Stop block's reason, and escaped", () => {
    const hook = (event: Event, command: string): Hook => ({ event, matcher: { all: true }, command, async: false, where: JSON.stringify(event) });
    const ran = (more: Partial<Ran>): Ran => ({ code: 0, stdout: "", stderr: "", ms: 12, ...more });
    const failed = { kind: "failed", line: "x" } as const;
    const runs: Run[] = [
      { event: "Stop", hook: hook("Stop", "slow.sh"), ran: ran({ code: null, failed: "time", limit: 600, ms: 600004 }), outcome: failed },
      { event: "Stop", hook: hook("Stop", "gone.sh"), ran: ran({ code: null, failed: "start", startError: "not found on PATH", ms: 1 }), outcome: failed },
      {
        event: "Stop",
        hook: hook("Stop", "again\u0007.sh"),
        ran: ran({ code: 2, stderr: "run the tests\n" }),
        outcome: { kind: "block", reason: "run the tests" },
      },
    ];
    const turn = lastTurn([{ role: "user", parts: [{ type: "text", text: "go" }] }, { role: "assistant", parts: [{ type: "text", text: "done" }] }], runs);
    expect(turn).toEqual([
      { text: "Last turn: 0 tool calls", color: "muted" },
      { text: "◆ Stop hook slow.sh · out of time · 600004 ms", color: "muted" },
      { text: "◆ Stop hook gone.sh · could not start · 1 ms", color: "muted" },
      { text: "◆ Stop hook again\\u0007.sh · exit 2 · 12 ms\n  ⎿ run the tests", color: "muted" },
    ]);
  });

  // Release 8c plan, Task 8: an mcp_tool hook by its server and tool, how its call ended in the words of its red lines.
  it("lists an mcp_tool hook's runs by its server and tool: answered, an error answer, not called, out of time", () => {
    const mcp = { server: "memory", tool: "search", input: {} };
    const hook: Hook = { event: "Stop", matcher: { all: true }, command: "", mcp, async: false, where: '"Stop"' };
    const ran = (more: Partial<Ran>): Ran => ({ code: null, stdout: "", stderr: "", ms: 12, ...more });
    const ok = { kind: "ok" } as const;
    const failed = { kind: "failed", line: "x" } as const;
    const runs: Run[] = [
      { event: "Stop", hook, ran: ran({ code: 0, stdout: "found" }), outcome: ok },
      { event: "Stop", hook, ran: ran({ failed: "error", reason: "boom" }), outcome: failed },
      { event: "Stop", hook, ran: ran({ failed: "call", reason: "memory is not running" }), outcome: failed },
      { event: "Stop", hook, ran: ran({ failed: "time", limit: 600 }), outcome: failed },
    ];
    expect(lastTurn([{ role: "user", parts: [{ type: "text", text: "go" }] }], runs).slice(1).map((l) => l.text)).toEqual([
      "◆ Stop hook memory search · exit 0 · 12 ms",
      "◆ Stop hook memory search · answered an error · 12 ms",
      "◆ Stop hook memory search · could not be called · 12 ms",
      "◆ Stop hook memory search · out of time · 12 ms",
    ]);
  });

  // Task 12's code review: combine drops a rewrite and an updatedToolOutput beside a continue: false, as the call never
  // runs, so Ctrl+O shows neither.
  it("shows no rewrite, nor an unused updatedToolOutput, for a run that also stopped the turn", () => {
    const hook = (event: Event): Hook => ({ event, matcher: { all: true }, command: "check.sh", async: false, where: JSON.stringify(event) });
    const ran: Ran = { code: 0, stdout: "", stderr: "", ms: 12 };
    const stop = (event: Event, more: object) => ({ continue: false, hookSpecificOutput: { hookEventName: event, ...more } });
    const ok = (json: Record<string, unknown>) => ({ kind: "ok" as const, json });
    const runs: Run[] = [
      { event: "PreToolUse", hook: hook("PreToolUse"), ran, outcome: ok(stop("PreToolUse", { updatedInput: { command: "ls" } })), match: "Bash" },
      { event: "PostToolUse", hook: hook("PostToolUse"), ran, outcome: ok(stop("PostToolUse", { updatedToolOutput: { not: "text" } })), match: "Read" },
    ];
    const turn = lastTurn([{ role: "user", parts: [{ type: "text", text: "go" }] }], runs);
    expect(turn.slice(1).map((l) => l.text)).toEqual([
      "◆ PreToolUse hook check.sh for shell · exit 0 · 12 ms",
      "◆ PostToolUse hook check.sh for read_file · exit 0 · 12 ms",
    ]);
  });

  // The final review (the user's choice, 2026-11-10): before the first prompt, SessionStart's runs follow the line
  // saying there is no turn yet.
  it("lists the runs after the line saying there is no turn yet", () => {
    const hook: Hook = { event: "SessionStart", matcher: { all: true }, command: "start.sh", async: false, where: '"SessionStart"' };
    const runs: Run[] = [{ event: "SessionStart", hook, ran: { code: 0, stdout: "", stderr: "", ms: 12 }, outcome: { kind: "ok" }, match: "startup" }];
    expect(lastTurn([], runs)).toEqual([
      { text: "No turn yet, so no tool calls to show.", color: "muted" },
      { text: "◆ SessionStart hook start.sh · exit 0 · 12 ms", color: "muted" },
    ]);
  });

  // The user's choice, 2026-11-10, terminal checklist: a run names its hook as /hooks does (hookName), not by its command.
  it("names each hook run by its statusMessage, or its program and script", () => {
    const base = { matcher: { all: true }, async: false } as const;
    const ok = { kind: "ok" } as const;
    const ran: Ran = { code: 0, stdout: "", stderr: "", ms: 12 };
    const runs: Run[] = [
      { event: "PreToolUse", hook: { ...base, event: "PreToolUse", command: "jq -r '.x | not'", statusMessage: "sfw guard", where: '"PreToolUse"' }, ran, outcome: ok, match: "Bash" },
      { event: "Stop", hook: { ...base, event: "Stop", command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\h\\check.js"], where: '"Stop"' }, ran, outcome: ok },
    ];
    expect(lastTurn([{ role: "user", parts: [{ type: "text", text: "go" }] }], runs).slice(1).map((l) => l.text)).toEqual([
      "◆ PreToolUse hook sfw guard for shell · exit 0 · 12 ms",
      "◆ Stop hook node check.js · exit 0 · 12 ms",
    ]);
  });

  // The user's words, 2026-11-10: a run a signal ended names it, or says none is known; a tool event's run names its tool
  // as the window does (choice 10).
  it("names a hook run's signal, or says none is known, and a tool hook's tool by Tachikoma's name", () => {
    const hook = (event: Event): Hook => ({ event, matcher: { all: true }, command: "check.sh", async: false, where: JSON.stringify(event) });
    const ran = (more: Partial<Ran>): Ran => ({ code: 0, stdout: "", stderr: "", ms: 12, ...more });
    const ok = { kind: "ok" } as const;
    const runs: Run[] = [
      { event: "Stop", hook: hook("Stop"), ran: ran({ code: null, signal: "SIGTERM" }), outcome: { kind: "failed", line: "x" } },
      { event: "Stop", hook: hook("Stop"), ran: ran({ code: null }), outcome: { kind: "failed", line: "x" } },
      { event: "PreToolUse", hook: hook("PreToolUse"), ran: ran({}), outcome: ok, match: "Bash" },
      { event: "PostToolUse", hook: hook("PostToolUse"), ran: ran({}), outcome: ok, match: "Read" },
      { event: "PostToolUseFailure", hook: hook("PostToolUseFailure"), ran: ran({ code: 1 }), outcome: ok, match: "Agent" },
      { event: "SessionStart", hook: hook("SessionStart"), ran: ran({}), outcome: ok, match: "startup" },
    ];
    const turn = lastTurn([{ role: "user", parts: [{ type: "text", text: "go" }] }], runs);
    expect(turn.slice(1).map((l) => l.text)).toEqual([
      "◆ Stop hook check.sh · ended by signal SIGTERM · 12 ms",
      "◆ Stop hook check.sh · ended by an unknown signal · 12 ms",
      "◆ PreToolUse hook check.sh for shell · exit 0 · 12 ms",
      "◆ PostToolUse hook check.sh for read_file · exit 0 · 12 ms",
      "◆ PostToolUseFailure hook check.sh for delegate · exit 1 · 12 ms",
      "◆ SessionStart hook check.sh · exit 0 · 12 ms",
    ]);
  });

  // Release 8c plan, choice 68 (Task 18, the user's answer, 2026-11-12): Ctrl+O's and /tasks <id>'s full record names an
  // MCP call by its server and tool as the server gives them, as its row does; /export keeps the full name (exportText).
  it("names an MCP call in the full record by its server and tool as the server gives them", () => {
    const messages: Message[] = [
      { role: "user", parts: [{ type: "text", text: "go" }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "mcp__my_tv__foo_bar", input: { x: 1 } }] },
      { role: "user", parts: [{ type: "tool_result", callId: "c1", output: "set", isError: false }] },
    ];
    const names = (full: string) => (full === "mcp__my_tv__foo_bar" ? { server: "my.tv", tool: "foo.bar" } : { server: "?", tool: "?" });
    const record = "● my.tv foo.bar\n  x: 1\n  ⎿ set"; // its input as name: value lines (Task 12)
    expect(lastTurn(messages, [], names)).toEqual([{ text: "Last turn: 1 tool call", color: "muted" }, { text: record, color: "muted" }]);
    expect(callLines(messages, names)).toEqual([{ text: record, color: "muted" }]);
    expect(callLines(messages)[0]!.text).toBe("● my_tv foo_bar\n  x: 1\n  ⎿ set"); // without the window's names
    expect(exportText(messages, "fake:a")).toContain('● mcp__my_tv__foo_bar {\n  "x": 1\n}\n  ⎿ set');
  });
});

// TUI design pass, Task 12 (audit 10; the user's layout, 2026-11-15, "As shown"): Ctrl+O's and /tasks t3's full record
// gives a call's input as name: value lines and a shell result without its empty sections; /export keeps the JSON and the
// result as the model read it.
describe("callLines", () => {
  // One call's record, with its result when given.
  const call = (name: string, input: unknown, output?: string, isError = false): Message[] => [
    { role: "assistant", parts: [{ type: "tool_call", id: "c", name, input }] },
    ...(output === undefined ? [] : [{ role: "user", parts: [{ type: "tool_result", callId: "c", output, isError }] } satisfies Message]),
  ];
  const record = (name: string, input: unknown, output?: string, isError = false) => callLines(call(name, input, output, isError))[0]!.text;
  const shellResult = (stderr: string, stdout: string, status = "exit code: 0") => `${status}\n--- stderr ---\n${stderr}\n--- stdout ---\n${stdout}`;

  it("shows the approved layout, grey, one line per call, and /export unchanged", () => {
    const messages = [
      ...call("shell", { command: "npm test", timeout: 60000 }, shellResult("", "12 passed")),
      { role: "assistant", parts: [{ type: "tool_call", id: "w", name: "write_file", input: { path: "src/a.ts", content: "export const a = 1;\nexport const b = 2;" } }] },
      { role: "user", parts: [{ type: "tool_result", callId: "w", output: "ok", isError: false }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "l", name: "list_tasks", input: {} }] },
      { role: "user", parts: [{ type: "tool_result", callId: "l", output: "(no tasks)", isError: false }] },
    ] satisfies Message[];
    expect(callLines(messages)).toEqual([
      { text: "● shell\n  command: npm test\n  timeout: 60000\n  ⎿ exit code: 0\n--- stdout ---\n12 passed", color: "muted" },
      { text: "● write_file\n  path: src/a.ts\n  content:\n    export const a = 1;\n    export const b = 2;\n  ⎿ ok", color: "muted" },
      { text: "● list_tasks\n  ⎿ (no tasks)", color: "muted" },
    ]);
    const exported = exportText(messages, "fake:a");
    expect(exported).toContain(`● shell {\n  "command": "npm test",\n  "timeout": 60000\n}\n  ⎿ ${shellResult("", "12 passed")}`);
    expect(exported).toContain('● list_tasks {}\n  ⎿ (no tasks)');
  });

  // An empty string is `""`, which would otherwise be nothing after the colon (the user's choice, 2026-11-15, "Show
  // \"\""); a string of spaces stays bare, as every other string.
  it("gives a string on its line, an empty one as \"\", numbers, booleans, null, arrays and objects as JSON on one line", () => {
    const input = { s: "a b", e: "", sp: " ", n: 1.5, t: true, f: false, z: null, list: [1, "two"], obj: { a: { b: "c\nd" } } };
    expect(record("x", input, "ok")).toBe(
      '● x\n  s: a b\n  e: ""\n  sp:  \n  n: 1.5\n  t: true\n  f: false\n  z: null\n  list: [1,"two"]\n  obj: {"a":{"b":"c\\nd"}}\n  ⎿ ok',
    );
  });

  // A CRLF value's \r goes with its line break, as screen() takes it in prose; a lone \r is no line break, and is escaped.
  it("puts a multi-line string's lines under its name, a CRLF one's without the \\r, an empty line with no indent", () => {
    expect(record("x", { content: "a\r\nb\r\n" }, "ok")).toBe("● x\n  content:\n    a\n    b\n\n  ⎿ ok"); // its ending line break kept
    expect(record("x", { content: "a\n\nb" }, "ok")).toBe("● x\n  content:\n    a\n\n    b\n  ⎿ ok");
    expect(record("x", { content: "a\rb" }, "ok")).toBe("● x\n  content: a␍b\n  ⎿ ok");
    expect(record("x", { content: "\ta\n\tb" }, "ok")).toBe("● x\n  content:\n    \ta\n    \tb\n  ⎿ ok"); // tabs kept, as in prose
  });

  // JSON.stringify escaped a value's control characters before; each value is escaped now as every scrollback line is.
  it("escapes control characters and escape codes in a value, on one line and on many, and screen() keeps it so", () => {
    const text = record("x", { a: "x\u001b]52;c;eA==\u0007", b: "one\n\u001b[31mred\u202e", c: ["\u202e"] }, "ok");
    expect(text).toBe("● x\n  a: x\\u001b]52;c;eA==\\u0007\n  b:\n    one\n    \\u001b[31mred\\u202e\n  c: [\"\\u202e\"]\n  ⎿ ok");
    expect(screen({ text }).text).toBe(text);
  });

  // A key a model or an MCP server could make odd is quoted as JSON, so each line reads one way: an empty key, one with a
  // colon, a line break, a quote, spaces or a control character, which could pass for another key or a value's line.
  it("quotes a key that is empty or holds anything but letters, marks after the first, digits, _, $, . and -", () => {
    expect(record("x", { file_path: 1, $ref: 2, "a.b-c": 3, 名前: 4 }, "ok")).toBe("● x\n  file_path: 1\n  $ref: 2\n  a.b-c: 3\n  名前: 4\n  ⎿ ok");
    // Combining marks after the first character leave a key bare, so a decomposed cafe and Hindi read as typed (Task 12's
    // code review); a key starting with one is quoted.
    const marked = { "caf\u00e9": 1, "cafe\u0301": 2, "\u0928\u093e\u092e": 3 }; // cafe precomposed, decomposed, Hindi
    expect(record("x", marked, "ok")).toBe("● x\n  caf\u00e9: 1\n  cafe\u0301: 2\n  \u0928\u093e\u092e: 3\n  ⎿ ok");
    const odd = { "": 1, "a: b": 2, "a\nb": 3, '"q"': 4, "  pad": 5, "e\u001b": 6, "r\u202e": 7, "\u0301a": 8 };
    expect(record("x", odd, "ok")).toBe(
      '● x\n  "": 1\n  "a: b": 2\n  "a\\nb": 3\n  "\\"q\\"": 4\n  "  pad": 5\n  "e\\u001b": 6\n  "r\\u202e": 7\n  "\u0301a": 8\n  ⎿ ok',
    );
  });

  it("says a call with no result yet is not finished", () => {
    expect(record("shell", { command: "npm test" })).toBe("● shell\n  command: npm test\n  ⎿ (not finished)");
  });

  // No provider gives one (openai.ts, parseArgs wraps it), but a record must still show it.
  it("gives an input that is not an object as its JSON on one line after the name", () => {
    expect(record("x", ["a"], "ok")).toBe('● x ["a"]\n  ⎿ ok');
    expect(record("x", undefined, "ok")).toBe("● x undefined\n  ⎿ ok");
  });

  it("leaves a shell result's empty stderr or stdout out, both for the status alone, neither when both have text", () => {
    expect(record("shell", {}, shellResult("", "out\n"))).toBe("● shell\n  ⎿ exit code: 0\n--- stdout ---\nout\n");
    expect(record("shell", {}, shellResult("bad\n", ""), true)).toBe("● shell\n  ⎿ exit code: 0\n--- stderr ---\nbad\n");
    expect(record("shell", {}, shellResult("", "", "exit code: 1"), true)).toBe("● shell\n  ⎿ exit code: 1");
    expect(record("shell", {}, shellResult("", "", "killed by SIGTERM"), true)).toBe("● shell\n  ⎿ killed by SIGTERM");
    expect(record("shell", {}, shellResult("warn", "out"))).toBe(`● shell\n  ⎿ ${shellResult("warn", "out")}`);
  });

  // A result the session cut (session.ts, truncate) is cleaned as any other, its cut note in its stdout: the common
  // long output with no errors loses its empty stderr heading (the user's choice, 2026-11-15, "Hide it, rare case a
  // limit").
  it("leaves a cut shell result's empty stderr out", () => {
    const plain = truncate(shellResult("", "o".repeat(MAX_TOOL_OUTPUT)));
    expect(record("shell", {}, plain)).toBe(`● shell\n  ⎿ ${plain.replace("--- stderr ---\n\n", "")}`);
    expect(plain).toMatch(/\n\[cut: \d+ more characters\]$/);
  });

  // The known limit (Task 12's code review; the user's choice, 2026-11-15): a stderr starting with the stdout marker,
  // long enough that the cut takes the real marker away, reads as empty, so its heading goes and its text shows as
  // stdout. No text is lost.
  it("shows, as its known limit, a cut stderr that starts with the stdout marker as stdout", () => {
    const fake = `\n--- stdout ---\n${"e".repeat(MAX_TOOL_OUTPUT)}`;
    const cut = truncate(shellResult(fake, "out"));
    expect(cut.split("\n--- stdout ---\n")).toHaveLength(2); // the stderr's marker only
    expect(record("shell", {}, cut, true)).toBe(`● shell\n  ⎿ ${cut.replace("--- stderr ---\n\n", "")}`);
  });

  // Which marker is the real one cannot be told when the stdout marker comes twice, so nothing is left out: either
  // stream's text can hold it.
  it("shows a shell result unchanged when its stderr or stdout holds the stdout marker, or it has another shape", () => {
    const marker = "\n--- stdout ---\n";
    for (const result of [
      shellResult(`${marker}x`, ""), // stderr starting with the marker, which would read as an empty stderr
      shellResult("", `a${marker}b`), // stdout holding the marker after an empty stderr
      shellResult("e\n--- stdout ---", "--- stdout ---\nb"), // the marker made across the real one
      shellResult("\n--- stdout ---", "b"), // the stderr's marker overlapping the real one, which starts at its last line break
      "exit code: 0\n--- stderr ---\nno stdout marker, as a cut in stderr leaves it",
      "Moved to the background as t3 by the user.",
      `before\n${shellResult("", "out")}`, // not a status line first
    ]) {
      expect(record("shell", {}, result)).toBe(`● shell\n  ⎿ ${result}`);
    }
  });

  it("leaves another tool's result alone though it holds the shell markers", () => {
    const result = shellResult("", "out");
    expect(record("read_file", { path: "log.txt" }, result)).toBe(`● read_file\n  path: log.txt\n  ⎿ ${result}`);
    expect(record("mcp__s__shell", {}, result)).toBe(`● s shell\n  ⎿ ${result}`);
  });
});
