import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { describe as describeMessage, screen } from "../../src/tui/describe.js";
import { formatSegment, type Segment, SEGMENTS, type StatusInfo, StatusLine } from "../../src/tui/StatusLine.js";

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

// Renders once and unmounts, so Ink instances do not pile up.
function frame(i: StatusInfo, segments: Segment[]) {
  const app = render(<StatusLine info={i} segments={segments} />);
  const shown = app.lastFrame();
  app.unmount();
  return shown;
}

describe("StatusLine", () => {
  it("shows every part by default", () => {
    const shown = frame(info, SEGMENTS);
    expect(shown).toContain("lead anthropic:claude-opus-5-5");
    expect(shown).toContain("ctx 50%");
    expect(shown).toContain("12.3k in / 678 out");
    expect(shown).toContain("$0.42");
    expect(shown).toContain("perm ask");
    expect(shown).toContain("2 errors");
  });

  it("shows only the chosen parts, and raw context size when the window is unknown", () => {
    const shown = frame({ ...info, contextWindow: null, costUnknown: true }, ["context", "cost"]);
    expect(shown).toContain("ctx 500.0k");
    expect(shown).toContain("$0.42 + ?");
    expect(shown).not.toContain("lead");
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
    const lines = describeMessage(
      { role: "user", parts: [{ type: "tool_result", callId: "c", output: "exit code: 1\r\nlots more", isError: true }] },
      80,
    );
    expect(lines.map(screen)).toEqual([{ text: "  ⎿ exit code: 1", color: "red" }]);
  });

  it("does not show an unknown kind of part as a tool result", () => {
    expect(describeMessage({ role: "assistant", parts: [{ type: "thinking" } as never] }, 80)).toEqual([]);
  });

  it("cuts a one-line entry to the width after escaping, so escapes count", () => {
    const [line] = describeMessage({ role: "assistant", parts: [{ type: "tool_call", id: "c", name: "\u001b\u001b", input: 1 }] }, 10);
    expect(screen(line!).text).toBe("● \\u001b\\…");
  });
});

describe("screen", () => {
  it("keeps line breaks and tabs in prose, and escapes everything else", () => {
    expect(screen({ text: "a\tb\r\nc\rd\n\u001b]52;c;eA==\u0007" }).text).toBe("a\tb\nc␍d\n\\u001b]52;c;eA==\\u0007");
  });
});
