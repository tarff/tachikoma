import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { describe as describeMessage, lastTurn, screen } from "../../src/tui/describe.js";
import { contextBar, duration, formatSegment, type Segment, SEGMENTS, type StatusInfo, StatusLine } from "../../src/tui/StatusLine.js";

const info: StatusInfo = {
  lead: "anthropic:claude-opus-5-5",
  context: 500_000,
  contextWindow: 1_000_000,
  input: 12_345,
  output: 678,
  cost: 0.4213,
  costUnknown: false,
  mode: "ask",
  errors: 2,
  project: "Agent Harness",
  branch: "main",
  elapsed: 14 * 60_000,
  running: 0,
};

// Renders once and unmounts, so Ink instances do not pile up.
function frame(i: StatusInfo, segments: Segment[]) {
  const app = render(<StatusLine info={i} segments={segments} />);
  const shown = app.lastFrame();
  app.unmount();
  return shown;
}

describe("StatusLine's tasks part", () => {
  it("says how many subagents run, only while any does", () => {
    expect(frame({ ...info, running: 2 }, ["errors", "tasks"])).toBe(" 2 errors | 2 running");
    expect(frame(info, ["errors", "tasks"])).toBe(" 2 errors");
    expect(frame({ ...info, errors: 1 }, ["errors"])).toBe(" 1 error");
  });
});

describe("StatusLine", () => {
  it("shows every part by default", () => {
    expect(SEGMENTS).toEqual(["lead", "context", "tokens", "cost", "mode", "errors", "project", "time", "tasks", "tools"]);
    // In two parts: all of them are wider than the test terminal's 100 columns.
    const shown = frame(info, SEGMENTS.slice(0, 4));
    expect(shown).toContain("lead anthropic:claude-opus-5-5");
    expect(shown).toContain("ctx 50% left");
    expect(shown).toContain("12.3k in / 678 out");
    expect(shown).toContain("$0.42");
    expect(frame(info, SEGMENTS.slice(4))).toBe(" perm ask | 2 errors | Agent Harness git:(main) | ⏱ 14m");
  });

  it("puts a bar of the context used before how much is left", () => {
    expect(frame({ ...info, context: 190_000, contextWindow: 1_000_000 }, ["context"])).toBe(" ██░░░░░░░░ ctx 81% left");
    expect(frame({ ...info, context: 1_200_000, contextWindow: 1_000_000 }, ["context"])).toBe(" ██████████ ctx 0% left");
    expect(frame({ ...info, context: 45_200, contextWindow: null }, ["context"])).toBe(" ctx 45.2k"); // no window, no bar
  });

  it.each([
    [69, "green"],
    [70, "yellow"],
    [84, "yellow"],
    [85, "red"],
  ])("colours the bar at %d%% used %s", (percent, color) => {
    expect(contextBar(percent).color).toBe(color);
  });

  it("shows the project folder and its git branch", () => {
    expect(formatSegment("project", info)).toBe("Agent Harness git:(main)");
    expect(formatSegment("project", { ...info, branch: null })).toBe("Agent Harness");
    expect(formatSegment("project", { ...info, project: "a\u001b[2Jb", branch: "x\u0007" })).toBe("a\\u001b[2Jb git:(x\\u0007)");
  });

  it.each([
    [59_999, "<1m"],
    [60_000, "1m"],
    [59 * 60_000, "59m"],
    [65 * 60_000, "1h 5m"],
  ])("writes %d ms of session as %s", (ms, shown) => {
    expect(duration(ms)).toBe(shown);
  });

  it("shows only the chosen parts, and raw context size when the window is unknown", () => {
    const shown = frame({ ...info, contextWindow: null, costUnknown: true }, ["context", "cost"]);
    expect(shown).toContain("ctx 500.0k");
    expect(shown).toContain("$0.42 + ?");
    expect(shown).not.toContain("lead");
  });

  it("shows how much context is left, never below none", () => {
    expect(formatSegment("context", { ...info, context: 40_000, contextWindow: 1_000_000 })).toBe("ctx 96% left");
    expect(formatSegment("context", { ...info, context: 1_200_000, contextWindow: 1_000_000 })).toBe("ctx 0% left");
  });

  it("shows the ChatGPT plan where the cost would be, plus any API cost so far", () => {
    const plan = { ...info, lead: "chatgpt:gpt-6.1-sol", cost: 0, costUnknown: false };
    expect(formatSegment("cost", plan)).toBe("ChatGPT plan");
    expect(formatSegment("cost", { ...plan, cost: 0.42 })).toBe("ChatGPT plan + $0.42");
    expect(formatSegment("cost", { ...plan, costUnknown: true })).toBe("ChatGPT plan + ?");
    expect(formatSegment("cost", { ...plan, cost: 0.42, costUnknown: true })).toBe("ChatGPT plan + $0.42 + ?");
  });

  it("stays on one line of the terminal, cutting off the end", () => {
    const shown = frame({ ...info, lead: `anthropic:${"x".repeat(200)}` }, SEGMENTS)!;
    expect(shown.split("\n")).toHaveLength(1);
    expect(shown).toContain("…");
  });

  it.each([
    [999, 1000, "999 in / 1.0k out"],
    [999_999, 1_000_000, "1.0M in / 1.0M out"], // rounds to 1000.0k, so it is shown in millions
    [999_949, 1_000_000, "999.9k in / 1.0M out"],
  ])("counts %d and %d tokens as thousands or millions", (input, output, shown) => {
    expect(formatSegment("tokens", { ...info, input, output })).toBe(shown);
  });

  it("shows a part listed twice without a duplicate-key warning", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(frame(info, ["cost", "cost"])).toContain("$0.42 | $0.42");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("describe", () => {
  it("shows tool calls and failed results on one line each", () => {
    const lines = describeMessage({ role: "user", parts: [{ type: "tool_result", callId: "c", output: "exit code: 1\r\nlots more", isError: true }] });
    expect(lines.map(screen)).toEqual([{ text: "  ⎿ exit code: 1", color: "red", oneLine: true }]);
  });

  it("shows a call's main detail: the path for the file tools, the command's first line for shell", () => {
    const shown = (name: string, input: unknown) => describeMessage({ role: "assistant", parts: [{ type: "tool_call", id: "c", name, input }] })[0]!.text;
    expect(shown("read_file", { path: "src/x.ts", offset: 5 })).toBe("● read_file src/x.ts");
    expect(shown("write_file", { path: "src/x.ts", content: "a" })).toBe("● write_file src/x.ts");
    expect(shown("edit_file", { path: "src/x.ts", old_text: "a", new_text: "b" })).toBe("● edit_file src/x.ts");
    expect(shown("shell", { command: "npm test\necho done" })).toBe("● shell npm test");
    expect(shown("x", { s: 1 })).toBe('● x {"s":1}'); // a tool without its own summary
    expect(shown("shell", { command: 5 })).toBe('● shell {"command":5}'); // nothing it can summarise
  });

  it("does not show text a background task added for the lead", () => {
    expect(describeMessage({ role: "user", parts: [{ type: "text", text: "go" }, { type: "text", text: "t3 finished: x", from: "tasks" }] })).toEqual([{ text: "> go", color: "cyan" }]);
  });

  it("does not show an unknown kind of part as a tool result", () => {
    expect(describeMessage({ role: "assistant", parts: [{ type: "thinking" } as never] })).toEqual([]);
  });

  it("escapes a one-line entry's line breaks too, so it stays one line", () => {
    const [line] = describeMessage({ role: "assistant", parts: [{ type: "tool_call", id: "c", name: "a\nb", input: 1 }] });
    expect(screen(line!).text).toBe("● a⏎b 1");
  });
});

describe("lastTurn", () => {
  it("says there is none before any turn", () => {
    expect(lastTurn([])).toEqual([{ text: "No turn yet, so no tool calls to show.", color: "gray" }]);
  });

  it("shows the latest turn's tool calls only, each with its full input and result, grey", () => {
    const lines = lastTurn([
      { role: "user", parts: [{ type: "text", text: "one" }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "c0", name: "shell", input: { command: "old" } }] },
      { role: "user", parts: [{ type: "tool_result", callId: "c0", output: "old", isError: false }] },
      { role: "user", parts: [{ type: "text", text: "two" }] },
      { role: "assistant", parts: [{ type: "text", text: "reading" }, { type: "tool_call", id: "c1", name: "read_file", input: { path: "a" } }] },
      { role: "user", parts: [{ type: "tool_result", callId: "c1", output: "line 1\nline 2", isError: false }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "c2", name: "shell", input: { command: "npm test" } }] },
    ]);
    expect(lines).toEqual([
      { text: "Last turn: 2 tool calls", color: "gray" },
      { text: '● read_file {\n  "path": "a"\n}\n  ⎿ line 1\nline 2', color: "gray" },
      { text: '● shell {\n  "command": "npm test"\n}\n  ⎿ (not finished)', color: "gray" }, // the turn is still running
    ]);
  });

  it("counts a turn started by a background task's answer as a turn, but not its answers after tool results", () => {
    const lines = lastTurn([
      { role: "user", parts: [{ type: "text", text: "one" }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "c0", name: "shell", input: {} }] },
      { role: "user", parts: [{ type: "tool_result", callId: "c0", output: "ok", isError: false }, { type: "text", text: "t2 finished", from: "tasks" }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "shell", input: {} }] },
    ]);
    expect(lines[0]).toEqual({ text: "Last turn: 2 tool calls", color: "gray" });
    expect(lastTurn([{ role: "user", parts: [{ type: "text", text: "t3 finished", from: "tasks" }] }])[0]).toEqual({ text: "Last turn: 0 tool calls", color: "gray" });
  });

  it("is cleaned of escape codes when shown, like every scrollback line", () => {
    const [, call] = lastTurn([
      { role: "user", parts: [{ type: "text", text: "go" }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "c", name: "shell", input: {} }] },
      { role: "user", parts: [{ type: "tool_result", callId: "c", output: "a\u001b]52;c;eA==\u0007", isError: true }] },
    ]);
    expect(screen(call!).text).toBe("● shell {}\n  ⎿ a\\u001b]52;c;eA==\\u0007");
  });
});

describe("screen", () => {
  it("keeps line breaks and tabs in prose, and escapes everything else", () => {
    expect(screen({ text: "a\tb\r\nc\rd\n\u001b]52;c;eA==\u0007" }).text).toBe("a\tb\nc␍d\n\\u001b]52;c;eA==\\u0007");
  });
});
