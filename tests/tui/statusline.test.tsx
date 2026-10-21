import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { describe as describeMessage } from "../../src/tui/describe.js";
import { SEGMENTS, type StatusInfo, StatusLine } from "../../src/tui/StatusLine.js";

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
};

describe("StatusLine", () => {
  it("shows every part by default", () => {
    const frame = render(<StatusLine info={info} segments={SEGMENTS} />).lastFrame();
    expect(frame).toContain("lead anthropic:claude-opus-5-5");
    expect(frame).toContain("ctx 50%");
    expect(frame).toContain("12.3k in / 678 out");
    expect(frame).toContain("$0.42");
    expect(frame).toContain("perm ask");
    expect(frame).toContain("2 errors");
  });

  it("shows only the chosen parts, and raw context size when the window is unknown", () => {
    const frame = render(<StatusLine info={{ ...info, contextWindow: null, costUnknown: true }} segments={["context", "cost"]} />).lastFrame();
    expect(frame).toContain("ctx 500.0k");
    expect(frame).toContain("$0.42 + ?");
    expect(frame).not.toContain("lead");
  });
});

describe("describe", () => {
  it("shows tool calls and failed results on one line each", () => {
    const lines = describeMessage(
      { role: "user", parts: [{ type: "tool_result", callId: "c", output: "exit code: 1\nlots more", isError: true }] },
      80,
    );
    expect(lines).toEqual([{ text: "  ⎿ exit code: 1", color: "red" }]);
  });
});
