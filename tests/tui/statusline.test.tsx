import chalk from "chalk";
import { renderToString } from "ink";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { describe as describeMessage, lastTurn, screen } from "../../src/tui/describe.js";
import {
  contextBar,
  duration,
  type LineSegment,
  pieces,
  type Segment,
  SEGMENTS,
  type StatusInfo,
  StatusLine,
} from "../../src/tui/StatusLine.js";
import { type Look, palette, type Theme, ThemeContext } from "../../src/tui/theme.js";
import { textWidth } from "../../src/tui/view.js";

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

// The dark full look and its colours, as the App's tests get them (theme.ts).
const on: Look = { light: false, color: true, full: true };
const dark = palette(on);

// The line in a theme, the dark full one unless given, as the App's context gives it (Task 13's code review: the status
// line reads the theme itself).
const themed = (line: ReactElement, theme: Theme = { look: on, palette: dark }) => <ThemeContext value={theme}>{line}</ThemeContext>;

// Renders once and unmounts, so Ink instances do not pile up; at the test terminal's 100 columns unless given.
function frame(i: StatusInfo, segments: Segment[], columns = 100) {
  const app = render(themed(<StatusLine info={i} segments={segments} columns={columns} />));
  const shown = app.lastFrame();
  app.unmount();
  return shown;
}

// The line as a terminal `columns` wide draws it, where Ink would cut it at that width too.
const lineAt = (columns: number, i: StatusInfo, segments: Segment[]) => renderToString(themed(<StatusLine info={i} segments={segments} columns={columns} />), { columns });

// The line with its colours, chalk at level 3 so the palette's hex is drawn as it is, 1000 columns wide so no part is cut
// (Task 13's code review: drawn, as the line reads the theme from its context).
const ESC = String.fromCharCode(27);
function coloured(i: StatusInfo, segments: Segment[], theme?: Theme): string {
  const level = chalk.level;
  chalk.level = 3;
  try {
    return renderToString(themed(<StatusLine info={i} segments={segments} columns={Infinity} />, theme), { columns: 1000 });
  } finally {
    chalk.level = level;
  }
}
// A colour's code as chalk draws it at level 3: a hex one in 24-bit, a name (the mode's and the bar's) in the basic 16.
const NAMED: Record<string, number> = { red: 31, green: 32, yellow: 33, magenta: 35 };
const code = (colour: string) =>
  colour.startsWith("#") ? `${ESC}[38;2;${[1, 3, 5].map((k) => parseInt(colour.slice(k, k + 2), 16)).join(";")}m` : `${ESC}[${NAMED[colour]}m`;
const colourCodes = (shown: string) =>
  [...shown.matchAll(new RegExp(`${ESC}\\[([\\d;]*)m`, "g"))].filter((m) => m[1]!.split(";").some((p) => (+p >= 30 && +p <= 49) || (+p >= 90 && +p <= 107)));

// What a part says: its pieces' words, which are written nowhere else.
const formatSegment = (s: LineSegment, i: StatusInfo) => pieces(s, i, dark, on).map((p) => p.text).join("");

describe("StatusLine's pieces", () => {
  // The colours are claude-hud's, by risk where it has no such part (release 5 design, "The status line's colours").
  // The labels muted and the model in the accent colour (TUI design pass, Task 10).
  it("colour each part as the design's table says", () => {
    expect(pieces("lead", info, dark, on)).toEqual([{ text: "lead", color: dark.muted }, { text: " " }, { text: "anthropic:claude-opus-5-5", color: dark.accent }]);
    expect(pieces("context", { ...info, contextWindow: null }, dark, on)).toEqual([{ text: "ctx", color: dark.muted }, { text: " 500.0k" }]);
    expect(pieces("tokens", info, dark, on)).toEqual([{ text: "12.3k " }, { text: "in", color: dark.muted }, { text: " / 678 " }, { text: "out", color: dark.muted }]);
    expect(pieces("cost", info, dark, on)).toEqual([{ text: "$0.42", color: dark.success }]);
    expect(pieces("cost", { ...info, lead: "chatgpt:gpt-6.1-sol", cost: 0 }, dark, on)).toEqual([{ text: "ChatGPT plan", color: dark.success }]);
    for (const [mode, color] of [
      ["ask", "green"],
      ["project", "yellow"],
      ["auto", "magenta"],
      ["never", "red"],
    ] as const)
      expect(pieces("mode", { ...info, mode }, dark, on)).toEqual([{ text: "perm", color: dark.muted }, { text: " " }, { text: mode, color }]);
    expect(pieces("errors", { ...info, errors: 1 }, dark, on)).toEqual([{ text: "1 error", color: dark.error }]);
    expect(pieces("project", info, dark, on)).toEqual([
      { text: "Agent Harness", color: dark.warning },
      { text: " " },
      { text: "git:(", color: dark.muted },
      { text: "main", color: dark.accent },
      { text: ")", color: dark.muted },
    ]);
    expect(pieces("project", { ...info, branch: null }, dark, on)).toEqual([{ text: "Agent Harness", color: dark.warning }]);
    expect(pieces("time", info, dark, on)).toEqual([{ text: "⏱ 14m", dim: true }]);
    expect(pieces("tasks", { ...info, running: 2 }, dark, on)).toEqual([{ text: "2 running", color: dark.warning }]);
  });

  // TUI design pass, Task 13: without colour the mode's and the context's own colours are left out too, as chalk does not
  // read NO_COLOR, and every other piece has the palette's, none.
  it("colour no part without colour", () => {
    const off: Look = { light: false, color: false, full: false };
    const none = palette(off);
    const shown = SEGMENTS.filter((s): s is LineSegment => s !== "tools");
    for (const mode of ["ask", "project", "auto", "never"] as const)
      for (const context of [100_000, 750_000, 900_000]) {
        const i = { ...info, mode, context, contextWindow: 1_000_000, errors: 1, running: 1 };
        for (const s of shown) for (const p of pieces(s, i, none, off)) expect(p.color).toBeUndefined();
        const line = coloured(i, shown, { look: off, palette: none });
        expect(line).toContain("█");
        expect(colourCodes(line)).toEqual([]);
      }
  });

  it("escape the folder and the branch each, as the whole part was", () => {
    expect(pieces("project", { ...info, project: "a\u001b[2Jb", branch: "x\u0007" }, dark, on).map((p) => p.text)).toEqual([
      "a\\u001b[2Jb",
      " ",
      "git:(",
      "x\\u0007",
      ")",
    ]);
  });

  // Found at the final review: a lead's id can come from the command line or the model list.
  it("escape the lead's id", () => {
    expect(pieces("lead", { ...info, lead: "a\u001b[2Jb" }, dark, on).map((p) => p.text)).toEqual(["lead", " ", "a\\u001b[2Jb"]);
  });

  // contextBar's thresholds: yellow from 70% used, red from 85% (claude-hud's getContextColor).
  it.each([
    [690_000, "31% left", "green"],
    [700_000, "30% left", "yellow"],
    [850_000, "15% left", "red"],
  ])("colour the context part and its bar alike at %d of 1M tokens used", (context, left, color) => {
    const at = { ...info, context, contextWindow: 1_000_000 };
    expect(pieces("context", at, dark, on)).toEqual([{ text: left, color }]);
    const line = coloured(at, ["context"]);
    expect(line).toContain(`${code(color)}█`);
    expect(line).toContain(`${code(color)}${left}`);
  });

  it("are drawn with nothing inverse, the separators grey and the line's first space plain", () => {
    const line = coloured({ ...info, running: 1 }, SEGMENTS); // never too long
    expect(line).not.toContain(`${ESC}[7m`);
    // Nine parts on the line (every one but `tools`), so eight separators, each where dim is on: a dim part beside one
    // shares its run (the time's).
    const dims: boolean[] = [];
    let dim = false;
    for (const part of line.split(new RegExp(`(${ESC}\\[[\\d;]*m)`))) {
      if (part.startsWith(ESC)) {
        const codes = part.slice(2, -1).split(";");
        if (codes.includes("2")) dim = true;
        if (codes.includes("22") || codes.includes("0")) dim = false;
      } else dims.push(...Array<boolean>(part.split(" | ").length - 1).fill(dim));
    }
    expect(dims).toEqual(Array(8).fill(true));
    // The first space before any code. The last Ink trims from the end of what it draws, so it is not seen here.
    expect(line.startsWith(" ")).toBe(true);
  });

  it("are each drawn in their own colour, every piece of every part", () => {
    const shown = SEGMENTS.filter((s): s is LineSegment => s !== "tools");
    for (const i of [
      { ...info, running: 1 },
      { ...info, contextWindow: null, errors: 1, mode: "never", branch: null, running: 1 },
    ] satisfies StatusInfo[]) {
      const line = coloured(i, shown);
      for (const s of shown)
        for (const p of pieces(s, i, dark, on)) {
          if (p.color) expect(line).toContain(`${code(p.color)}${p.text}`);
          // A dim piece in a dim run, which the separator before it may have started.
          if (p.dim) expect(line).toMatch(new RegExp(`${ESC}\\[2m[^${ESC}]*${p.text}`));
        }
    }
  });
});

describe("StatusLine's tasks part", () => {
  it("says how many subagents run, only while any does", () => {
    expect(frame({ ...info, running: 2 }, ["errors", "tasks"])).toBe(" 2 errors | 2 running");
    expect(frame(info, ["errors", "tasks"])).toBe(" 2 errors");
    expect(frame({ ...info, errors: 1 }, ["errors"])).toBe(" 1 error");
  });
});

// TUI design pass, Task 10: `errors` at 0, `tokens` while both are 0, `cost` while 0 and known are left out.
describe("StatusLine's parts at zero", () => {
  it("leaves out the errors while there are none", () => {
    expect(frame({ ...info, errors: 0 }, ["mode", "errors"])).toBe(" perm ask");
    expect(frame({ ...info, errors: 1 }, ["mode", "errors"])).toBe(" perm ask | 1 error");
  });

  it("leaves out the tokens while both counts are 0, not while one is", () => {
    expect(frame({ ...info, input: 0, output: 0 }, ["tokens", "mode"])).toBe(" perm ask");
    expect(frame({ ...info, input: 0, output: 5 }, ["tokens", "mode"])).toBe(" 0 in / 5 out | perm ask");
    expect(frame({ ...info, input: 5, output: 0 }, ["tokens", "mode"])).toBe(" 5 in / 0 out | perm ask");
  });

  it("leaves out a cost of 0 that is known, not one with calls of no known price, nor the ChatGPT plan", () => {
    expect(frame({ ...info, cost: 0 }, ["cost", "mode"])).toBe(" perm ask");
    expect(frame({ ...info, cost: 0, costUnknown: true }, ["cost", "mode"])).toBe(" $0.00+ | perm ask");
    expect(frame({ ...info, lead: "chatgpt:gpt-6.1-sol", cost: 0 }, ["cost", "mode"])).toBe(" ChatGPT plan | perm ask");
  });

  it("keeps every other part at its start", () => {
    expect(frame({ ...info, input: 0, output: 0, cost: 0, errors: 0 }, SEGMENTS)).toBe(
      " lead anthropic:claude-opus-5-5 | █████░░░░░ 50% left | perm ask | Agent Harness git:(main) | ⏱ 14m",
    );
  });
});

// TUI design pass, Task 10: too long for the width, parts drop from the end of the list one at a time, `lead` and `mode`
// last, instead of the line being cut with `…`.
describe("StatusLine's fit", () => {
  const all = { ...info, running: 1 }; // every part shown: 152 columns
  const full = " lead anthropic:claude-opus-5-5 | █████░░░░░ 50% left | 12.3k in / 678 out | $0.42 | perm ask"; // 94 with its last space

  it.each([
    [100, full],
    [94, full],
    [93, " lead anthropic:claude-opus-5-5 | █████░░░░░ 50% left | 12.3k in / 678 out | perm ask"],
    [60, " lead anthropic:claude-opus-5-5 | $0.42 | perm ask | ⏱ 14m"], // the cost and the time put back
    [40, " lead anthropic:claude-opus-5-5"], // nothing put back while `mode` is out
  ])("drops parts from the end, putting back those that fit, at %d columns", (columns, shown) => {
    const line = lineAt(columns, all, SEGMENTS);
    expect(line).toBe(shown);
    expect(line).not.toContain("…");
  });

  it("drops the parts listed before `lead` and `mode` before them, then the later of the two", () => {
    const segments: Segment[] = ["time", "mode", "project", "lead", "errors"];
    expect(lineAt(43, info, segments)).toBe(" perm ask | lead anthropic:claude-opus-5-5");
    expect(lineAt(42, info, segments)).toBe(" perm ask");
  });

  // The user's "Put back what fits" (2026-11-14): a long part dropped does not take the short ones after it with it.
  const long = { ...info, errors: 0, project: "my-rather-long-project-folder-name", branch: "feature/status-line-fit" };
  const kept = " lead anthropic:claude-opus-5-5 | █████░░░░░ 50% left | 12.3k in / 678 out | $0.42 | perm ask"; // 94

  it("puts back a part listed after a dropped one when it fits", () => {
    expect(lineAt(120, long, SEGMENTS)).toBe(`${kept} | ⏱ 14m`); // the project dropped, the time back at 102
  });

  it("puts back, in the list's order, only the dropped parts that still fit after those put back before them", () => {
    const busy = { ...long, running: 1 };
    expect(lineAt(105, busy, SEGMENTS)).toBe(`${kept} | ⏱ 14m`); // the tasks part would make 114
    expect(lineAt(114, busy, SEGMENTS)).toBe(`${kept} | ⏱ 14m | 1 running`);
  });

  it("counts a two-column character as two when it decides what drops", () => {
    const wide = { ...info, project: "日本語のフォルダ" }; // 8 characters, 16 columns
    const segments: Segment[] = ["mode", "project", "time"];
    expect(lineAt(48, wide, segments)).toBe(" perm ask | 日本語のフォルダ git:(main) | ⏱ 14m");
    expect(lineAt(47, wide, segments)).toBe(" perm ask | 日本語のフォルダ git:(main)");
  });
});

describe("StatusLine", () => {
  it("shows every part by default", () => {
    expect(SEGMENTS).toEqual(["lead", "context", "tokens", "cost", "mode", "errors", "project", "time", "tasks", "tools"]);
    // In two parts: all of them are wider than the test terminal's 100 columns.
    const shown = frame(info, SEGMENTS.slice(0, 4));
    expect(shown).toContain("lead anthropic:claude-opus-5-5");
    expect(shown).toContain("█████░░░░░ 50% left");
    expect(shown).toContain("12.3k in / 678 out");
    expect(shown).toContain("$0.42");
    expect(frame(info, SEGMENTS.slice(4))).toBe(" perm ask | 2 errors | Agent Harness git:(main) | ⏱ 14m");
  });

  it("puts a bar of the context used before how much is left", () => {
    expect(frame({ ...info, context: 190_000, contextWindow: 1_000_000 }, ["context"])).toBe(" ██░░░░░░░░ 81% left");
    expect(frame({ ...info, context: 1_200_000, contextWindow: 1_000_000 }, ["context"])).toBe(" ██████████ 0% left");
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
    expect(shown).toContain("$0.42+");
    expect(shown).not.toContain("lead");
  });

  it("shows how much context is left, never below none", () => {
    expect(formatSegment("context", { ...info, context: 40_000, contextWindow: 1_000_000 })).toBe("96% left");
    expect(formatSegment("context", { ...info, context: 1_200_000, contextWindow: 1_000_000 })).toBe("0% left");
  });

  // Choice D (TUI design pass, Task 10): a `+` after the cost means some calls had no known price.
  it("shows the ChatGPT plan where the cost would be, plus any API cost so far", () => {
    const plan = { ...info, lead: "chatgpt:gpt-6.1-sol", cost: 0, costUnknown: false };
    expect(formatSegment("cost", plan)).toBe("ChatGPT plan");
    expect(formatSegment("cost", { ...plan, cost: 0.42 })).toBe("ChatGPT plan + $0.42");
    expect(formatSegment("cost", { ...plan, costUnknown: true })).toBe("ChatGPT plan+");
    expect(formatSegment("cost", { ...plan, cost: 0.42, costUnknown: true })).toBe("ChatGPT plan + $0.42+");
  });

  it("marks a cost with calls of no known price with a `+`", () => {
    expect(formatSegment("cost", info)).toBe("$0.42");
    expect(formatSegment("cost", { ...info, costUnknown: true })).toBe("$0.42+");
    expect(formatSegment("cost", { ...info, cost: 0, costUnknown: true })).toBe("$0.00+");
  });

  it("stays on one line of the terminal, cutting off the end of a part that is too long alone", () => {
    const shown = frame({ ...info, lead: `anthropic:${"x".repeat(200)}` }, SEGMENTS)!;
    expect(shown.split("\n")).toHaveLength(1);
    expect(shown).toMatch(/^ lead anthropic:x+…$/); // every other part dropped first
  });

  // Ink cuts the line by display width, colour codes and all, whatever pieces it is drawn from: now only a part too long
  // alone, as the others are dropped first (TUI design pass, Task 10). Colour is turned on, as chalk finds none in a
  // test's output (see conversation.test.tsx), so the cut is made across the codes as in a terminal.
  it.each([
    [20, "Agent Harness", " Agent Harness git:…"], // within a piece
    [15, "Agent Harness", " Agent Harness…"], // where the folder's piece ends
    [6, "日本語のフォルダ", " 日本…"], // where the 6th column is half a two-column character
  ])("cuts a lone part at %d columns", (columns, project, shown) => {
    const level = chalk.level;
    chalk.level = 1; // 1: chalk's basic 16 colours, enough for every colour the line uses
    try {
      const line = renderToString(themed(<StatusLine info={{ ...info, project }} segments={["project"]} columns={columns} />), { columns });
      expect(line).toMatch(/\u001b\[/);
      expect(line.replace(/\u001b\[\d+m/g, "")).toBe(shown);
    } finally {
      chalk.level = level;
    }
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
  // The dark full look's colours, and the user's prompt as its three band lines (TUI design pass, Task 3).
  const P = palette({ light: false, color: true, full: true });
  const W = textWidth(100, true); // the columns a reply's markdown is laid out for (Task 16)
  const typed =(text: string) => [{ text: "", band: true, block: true }, { text: `› ${text}`, band: true, indent: 2 }, { text: "", band: true }];

  it("shows tool calls and failed results on one line each", () => {
    const lines = describeMessage({ role: "user", parts: [{ type: "tool_result", callId: "c", output: "exit code: 1\r\nlots more", isError: true }] }, P, W);
    expect(lines.map(screen)).toEqual([{ text: "  ⎿ exit code: 1", color: "error", oneLine: true }]);
  });

  it("shows a call's main detail: the path for the file tools, the command's first line for shell", () => {
    const shown = (name: string, input: unknown) => describeMessage({ role: "assistant", parts: [{ type: "tool_call", id: "c", name, input }] }, P, W)[0]!.text;
    expect(shown("read_file", { path: "src/x.ts", offset: 5 })).toBe("● read_file src/x.ts");
    expect(shown("write_file", { path: "src/x.ts", content: "a" })).toBe("● write_file src/x.ts");
    expect(shown("edit_file", { path: "src/x.ts", old_text: "a", new_text: "b" })).toBe("● edit_file src/x.ts");
    expect(shown("shell", { command: "npm test\necho done" })).toBe("● shell npm test");
    expect(shown("x", { s: 1 })).toBe('● x {"s":1}'); // a tool without its own summary
    expect(shown("shell", { command: 5 })).toBe('● shell {"command":5}'); // nothing it can summarise
  });

  // Release 7 plan, choices 66 and 67: a declined question's answer line under the tool line stands for its call's result
  // row; one that names what it answers leaves a short row in its place.
  it("leaves out or shortens the result rows of the calls given as answered, and only theirs", () => {
    const result = (callId: string) => ({ type: "tool_result", callId, output: `The user declined: run: ${callId}`, isError: true }) as const;
    const answered = new Map([["c1", null], ["c2", "You declined this."]]);
    expect(describeMessage({ role: "user", parts: [result("c1"), result("c2"), result("c3")] }, P, W, answered)).toEqual([
      { text: "  ⎿ You declined this.", color: "muted", oneLine: true },
      { text: "  ⎿ The user declined: run: c3", color: "error", oneLine: true },
    ]);
  });

  it("does not show text a background task added for the lead", () => {
    expect(describeMessage({ role: "user", parts: [{ type: "text", text: "go" }, { type: "text", text: "t3 finished: x", from: "tasks" }] }, P, W)).toEqual(typed("go"));
  });

  // Release 6 plan, choice 22: one line, in the line's colour.
  it("shows a picture as its marker in its place in the user's line", () => {
    const data = Buffer.from([0x89, 0x50]); // a stand-in picture
    const parts = [
      { type: "text", text: "look at " },
      { type: "image", id: 1, mediaType: "image/png", data },
      { type: "text", text: " please" },
    ] as const;
    expect(describeMessage({ role: "user", parts: [...parts] }, P, W)).toEqual(typed("look at [Image #1] please"));
  });

  it("puts a space between two pictures next to each other, so their markers do not run together", () => {
    const picture = (id: number) => ({ type: "image", id, mediaType: "image/png", data: Buffer.from([0x89, 0x50]) }) as const;
    expect(describeMessage({ role: "user", parts: [picture(1), picture(2)] }, P, W)).toEqual(typed("[Image #1] [Image #2]"));
  });

  it("does not show an unknown kind of part as a tool result", () => {
    expect(describeMessage({ role: "assistant", parts: [{ type: "thinking" } as never] }, P, W)).toEqual([]);
  });

  it("escapes a one-line entry's line breaks too, so it stays one line", () => {
    const [line] = describeMessage({ role: "assistant", parts: [{ type: "tool_call", id: "c", name: "a\nb", input: 1 }] }, P, W);
    expect(screen(line!).text).toBe("● a⏎b 1");
  });
});

describe("lastTurn", () => {
  it("says there is none before any turn", () => {
    expect(lastTurn([])).toEqual([{ text: "No turn yet, so no tool calls to show.", color: "muted" }]);
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
      { text: "Last turn: 2 tool calls", color: "muted" },
      { text: "● read_file\n  path: a\n  ⎿ line 1\nline 2", color: "muted" }, // name: value lines (TUI design pass, Task 12)
      { text: "● shell\n  command: npm test\n  ⎿ (not finished)", color: "muted" }, // the turn is still running
    ]);
  });

  it("counts a turn started by a background task's answer as a turn, but not its answers after tool results", () => {
    const lines = lastTurn([
      { role: "user", parts: [{ type: "text", text: "one" }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "c0", name: "shell", input: {} }] },
      { role: "user", parts: [{ type: "tool_result", callId: "c0", output: "ok", isError: false }, { type: "text", text: "t2 finished", from: "tasks" }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "shell", input: {} }] },
    ]);
    expect(lines[0]).toEqual({ text: "Last turn: 2 tool calls", color: "muted" });
    expect(lastTurn([{ role: "user", parts: [{ type: "text", text: "t3 finished", from: "tasks" }] }])[0]).toEqual({ text: "Last turn: 0 tool calls", color: "muted" });
  });

  it("is cleaned of escape codes when shown, like every scrollback line", () => {
    const [, call] = lastTurn([
      { role: "user", parts: [{ type: "text", text: "go" }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "c", name: "shell", input: {} }] },
      { role: "user", parts: [{ type: "tool_result", callId: "c", output: "a\u001b]52;c;eA==\u0007", isError: true }] },
    ]);
    expect(screen(call!).text).toBe("● shell\n  ⎿ a\\u001b]52;c;eA==\\u0007");
  });
});

describe("screen", () => {
  it("keeps line breaks and tabs in prose, and escapes everything else", () => {
    expect(screen({ text: "a\tb\r\nc\rd\n\u001b]52;c;eA==\u0007" }).text).toBe("a\tb\nc␍d\n\\u001b]52;c;eA==\\u0007");
  });
});
