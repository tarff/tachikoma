import { spawn } from "node:child_process";
import { constants } from "node:os";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import path from "node:path";
import {
  approvalQuestion,
  exitOn,
  exitSignals,
  fullPossible,
  givenBy,
  headlessAnswer,
  headlessDeclined,
  headlessExit,
  headlessLeftOut,
  instructionsLine,
  jsonLine,
  leadOf,
  prose,
  resolve,
  screenMode,
  scrollSpeed,
  statusSegments,
} from "../src/clilib.js";
import { SEGMENTS } from "../src/tui/StatusLine.js";

describe("the instruction files on screen", () => {
  const home = path.resolve("/home/me");
  const proj = path.resolve("/work/proj");
  const r = {
    text: "...",
    read: [
      { path: path.join(home, ".claude", "CLAUDE.md"), size: 1200 },
      { path: path.join(proj, "AGENTS.md"), size: 3100 },
    ],
    left: [{ path: path.resolve("/elsewhere/x.md"), why: "not allowed" }],
  };

  it("lists the files read, the user's folder as ~, their total size, and those left out", () => {
    expect(instructionsLine(r, home)).toBe(`Instructions: ${path.join("~", ".claude", "CLAUDE.md")}, ${path.join(proj, "AGENTS.md")} (4.3k bytes); left out: ${path.resolve("/elsewhere/x.md")} (not allowed)`);
    expect(instructionsLine({ text: "", read: [], left: [] }, home)).toBeNull();
    expect(instructionsLine({ ...r, read: [] }, home)).toBe(`Instructions: none read; left out: ${path.resolve("/elsewhere/x.md")} (not allowed)`);
  });

  it("asks once about the files outside the project, each with how it was reached, escaped", () => {
    const reached = [
      { path: path.resolve("/elsewhere/x.md"), how: `imported by ${path.join(proj, "CLAUDE.md")}` },
      { path: path.resolve("/elsewhere/a\u001b[2Jb.md"), how: `found as ${path.join(proj, "AGENTS.md")}` },
    ];
    expect(approvalQuestion(reached)).toBe(
      [
        "Read 2 files from outside the project, reached by the instruction files?",
        `  ${path.resolve("/elsewhere/x.md")}, imported by ${path.join(proj, "CLAUDE.md")}`,
        `  ${path.resolve("/elsewhere/a\\u001b[2Jb.md")}, found as ${path.join(proj, "AGENTS.md")}`,
        "[y/n]",
      ].join("\n"),
    );
    expect(approvalQuestion(reached.slice(0, 1))).toContain("Read 1 file from outside the project");
  });

  it("says with -p which were left out, since nobody can approve them", () => {
    expect(headlessLeftOut([{ path: path.resolve("/elsewhere/x.md"), how: "imported by CLAUDE.md" }])).toBe(
      `note: 1 instruction file from outside the project left out, since nobody can approve it in -p mode: ${path.resolve("/elsewhere/x.md")}, imported by CLAUDE.md`,
    );
  });
});

// The line a -p run prints for each action it declines, naming the subagent that asked, if one did (found at the
// combined review: its space after the colon was lost).
describe("headlessDeclined", () => {
  const why = "declined, nobody to ask in -p mode (--mode project allows writes inside the project, but shell commands and anything outside it are still refused)";
  it("says why, then the action, after a space, its subagent's name escaped before it", () => {
    expect(headlessDeclined("run: ls")).toBe(`${why}: run: ls`);
    expect(headlessDeclined("run: ls", "t2 (a\u001b[2Jb)")).toBe(`${why}: t2 (a\\u001b[2Jb): run: ls`);
  });
});

describe("headlessExit", () => {
  const run = { aborted: false, failed: false, declined: false };

  it("is 0 when the run finished cleanly", () => {
    expect(headlessExit(run)).toBe(0);
  });

  it("is 1 when a turn failed", () => {
    expect(headlessExit({ ...run, failed: true })).toBe(1);
  });

  it("is 1 when an action was declined, so a script does not take it for success", () => {
    expect(headlessExit({ ...run, declined: true })).toBe(1);
  });

  it("is 128 + SIGINT when stopped, whatever else happened", () => {
    expect(headlessExit({ aborted: true, failed: true, declined: true })).toBe(128 + constants.signals.SIGINT);
  });
});

describe("headless output", () => {
  it("shows escape codes and bidi overrides in an answer as text, keeping line breaks and tabs", () => {
    expect(prose("a\u001b]52;c;eA==\u0007\nb\tc\u202e")).toBe("a\\u001b]52;c;eA==\\u0007\nb\tc\\u202e");
  });

  it("escapes what JSON leaves raw, and the line still parses to the same value", () => {
    const data = { text: "x\u009b8m\u202e\u007f\n" };
    const line = jsonLine("message", data);
    expect(line).not.toMatch(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
    expect(JSON.parse(line)).toEqual({ event: "message", data });
  });
});

describe("headlessAnswer", () => {
  const piped = { raw: false, tty: false };

  it("leaves ordinary text exactly as written: Windows line endings, tabs and plain direction marks", () => {
    const text = "line one\r\nline two\tתודה\u200f عربي\u061c ok\u200e\n";
    expect(headlessAnswer(text, piped)).toEqual({ out: text });
  });

  it("escapes control codes, a lone carriage return and text-order overrides, and says so when piped", () => {
    expect(headlessAnswer("a\u001b[8mb\rc\u202ed\u2066e", piped)).toEqual({
      out: "a\\u001b[8mb␍c\\u202ed\\u2066e",
      note: "note: 4 control characters in the answer were printed as escapes; --raw prints the answer exactly",
    });
  });

  it("gives no note on a terminal, where the escapes are in plain sight", () => {
    expect(headlessAnswer("a\u001bb", { raw: false, tty: true })).toEqual({ out: "a\\u001bb" });
  });

  it("prints the answer exactly with --raw", () => {
    expect(headlessAnswer("a\u001b]52;c;eA==\u0007", { raw: true, tty: false })).toEqual({ out: "a\u001b]52;c;eA==\u0007" });
  });
});

describe("statusSegments", () => {
  it("shows every segment when none are given", () => {
    expect(statusSegments(undefined)).toEqual(SEGMENTS);
  });

  it("keeps the first of repeated segments", () => {
    expect(statusSegments("cost, lead,cost,lead")).toEqual(["cost", "lead"]);
  });

  it("names --status when a segment is unknown", () => {
    expect(() => statusSegments("lead,nope")).toThrow('--status must be one of: lead, context, tokens, cost, mode, errors, project, time, tasks, tools (got "nope")');
  });
});

describe("screenMode", () => {
  it("starts in full screen unless --classic is given or TACHI_CLASSIC is set to anything but empty or 0", () => {
    expect(screenMode(undefined, {}, true)).toBe("full");
    expect(screenMode(true, {}, true)).toBe("classic");
    expect(screenMode(undefined, { TACHI_CLASSIC: "1" }, true)).toBe("classic");
    expect(screenMode(undefined, { TACHI_CLASSIC: "yes" }, true)).toBe("classic");
    expect(screenMode(undefined, { TACHI_CLASSIC: "0" }, true)).toBe("full");
    expect(screenMode(undefined, { TACHI_CLASSIC: "" }, true)).toBe("full");
    expect(screenMode(true, { TACHI_CLASSIC: "0" }, true)).toBe("classic");
  });

  it("is classic when the output is not a terminal, or in CI, where Ink draws no live frames", () => {
    expect(screenMode(undefined, {}, false)).toBe("classic");
    for (const env of [{ CI: "true" }, { CI: "1" }, { CI: "" }, { CONTINUOUS_INTEGRATION: "yes" }]) expect(screenMode(undefined, env, true)).toBe("classic");
    for (const env of [{ CI: "0" }, { CI: "false" }, { CONTINUOUS_INTEGRATION: "false" }]) expect(screenMode(undefined, env, true)).toBe("full");
  });

  // Release 6 design, "Which wins": --classic, then TACHI_CLASSIC, then the settings file's "screen". Neither the flag nor
  // the variable can ask for full screen, so the file's "full" holds only where neither asks for classic.
  it("takes the settings file's screen after --classic and TACHI_CLASSIC", () => {
    expect(screenMode(undefined, {}, true, "classic")).toBe("classic");
    expect(screenMode(undefined, {}, true, "full")).toBe("full");
    expect(screenMode(true, {}, true, "full")).toBe("classic");
    expect(screenMode(undefined, { TACHI_CLASSIC: "1" }, true, "full")).toBe("classic");
    expect(screenMode(undefined, { TACHI_CLASSIC: "0" }, true, "classic")).toBe("classic"); // 0 is unset, so the file's applies
    expect(screenMode(undefined, {}, false, "full")).toBe("classic");
  });
});

describe("fullPossible", () => {
  // Found at the final review: /screen asks it, whatever --classic or TACHI_CLASSIC chose at the start.
  it("is false where the output is not a terminal, or in CI, as screenMode reads them, and true otherwise", () => {
    expect(fullPossible({}, true)).toBe(true);
    expect(fullPossible({ TACHI_CLASSIC: "1" }, true)).toBe(true);
    expect(fullPossible({}, false)).toBe(false);
    expect(fullPossible({ CI: "true" }, true)).toBe(false);
    expect(fullPossible({ CI: "0" }, true)).toBe(true);
  });
});

describe("scrollSpeed", () => {
  it("is 3 rows a notch unless given", () => {
    expect(scrollSpeed(undefined, {})).toBe(3);
  });

  it("takes digits with an optional decimal point, above 0 and up to 20", () => {
    expect(scrollSpeed("0.5", {})).toBe(0.5);
    expect(scrollSpeed(".5", {})).toBe(0.5);
    expect(scrollSpeed("20", {})).toBe(20);
    expect(scrollSpeed(undefined, { TACHI_SCROLL_SPEED: "1.5" })).toBe(1.5);
  });

  it("refuses anything else, naming where it came from", () => {
    for (const bad of ["0", "21", "-1", "1e1", "abc", " 3", "", "3.", "20.5"]) {
      expect(() => scrollSpeed(bad, {})).toThrow(`--scroll-speed must be a number above 0, up to 20 (got "${bad}")`);
      if (bad === "") continue; // an empty variable is unset (below)
      expect(() => scrollSpeed(undefined, { TACHI_SCROLL_SPEED: bad })).toThrow(`TACHI_SCROLL_SPEED must be a number above 0, up to 20 (got "${bad}")`);
    }
  });

  it("takes the option over the variable, and an empty variable as unset", () => {
    expect(scrollSpeed("2", { TACHI_SCROLL_SPEED: "abc" })).toBe(2);
    expect(scrollSpeed(undefined, { TACHI_SCROLL_SPEED: "" })).toBe(3);
  });
});

describe("exitSignals", () => {
  it("ends on Ctrl+Break on Windows and on SIGQUIT elsewhere, besides SIGTERM and SIGHUP", () => {
    expect(exitSignals("win32")).toEqual(["SIGTERM", "SIGHUP", "SIGBREAK"]);
    expect(exitSignals("linux")).toEqual(["SIGTERM", "SIGHUP", "SIGQUIT"]);
    expect(exitSignals("darwin")).toEqual(["SIGTERM", "SIGHUP", "SIGQUIT"]);
  });
});

// Final review: Ctrl-C in the terminal while the editor ran ended the whole session. As Git's launch_editor does, Ctrl-C
// and Ctrl-\ are ignored while a program has the terminal; every other signal still ends Tachikoma (choice 31).
describe("exitOn", () => {
  it("exits on each signal with 128 and its number, but on SIGINT and SIGQUIT only while no program runs", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as typeof process.exit);
    onTestFinished(() => exit.mockRestore());
    for (const sig of ["SIGINT", "SIGQUIT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
      exitOn(sig, () => false)();
      expect(exit).toHaveBeenLastCalledWith(128 + constants.signals[sig]);
    }
    exit.mockClear();
    exitOn("SIGINT", () => true)();
    exitOn("SIGQUIT", () => true)();
    expect(exit).not.toHaveBeenCalled();
    for (const sig of ["SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
      exitOn(sig, () => true)();
      expect(exit).toHaveBeenLastCalledWith(128 + constants.signals[sig]);
    }
  });
});

describe("endOnEpipe", () => {
  it("ends quietly when the reader of its output stops early", async () => {
    // A real pipe: a single large write fails with EPIPE once the reader has gone.
    const script = `import { endOnEpipe } from "./src/clilib.ts"; process.stdout.on("error", endOnEpipe); process.stdout.write("x\\n".repeat(1e6));`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.once("data", () => child.stdout.destroy());
    const code = await new Promise((resolve) => child.on("close", resolve));
    expect(stderr).toBe("");
    expect(code).toBe(0);
  });
});

// Release 6 design, "Which wins": a flag, then a TACHI_ variable, then the settings file, then the default.
describe("resolve", () => {
  it("takes the lead from --lead, then TACHI_LEAD, then the file, an empty variable being unset", () => {
    expect(leadOf({ lead: "a:1" }, { TACHI_LEAD: "a:2" }, { lead: "a:3" })).toBe("a:1");
    expect(leadOf({}, { TACHI_LEAD: "a:2" }, { lead: "a:3" })).toBe("a:2");
    expect(leadOf({}, { TACHI_LEAD: "" }, { lead: "a:3" })).toBe("a:3");
    expect(leadOf({}, {}, {})).toBeUndefined();
  });

  it("takes the worker from --worker, then TACHI_WORKER, then the file", () => {
    expect(resolve({ worker: "w:1" }, { TACHI_WORKER: "w:2" }, { worker: "w:3" }).worker).toBe("w:1");
    expect(resolve({}, { TACHI_WORKER: "w:2" }, { worker: "w:3" }).worker).toBe("w:2");
    expect(resolve({}, { TACHI_WORKER: "" }, { worker: "w:3" }).worker).toBe("w:3");
    expect(resolve({}, {}, {}).worker).toBeUndefined();
  });

  it("takes mode, effort and fallback from the flag, then the file, then the default", () => {
    expect(resolve({ mode: "project" }, {}, { mode: "never" }).mode).toBe("project");
    expect(resolve({}, {}, { mode: "never" }).mode).toBe("never");
    expect(resolve({}, {}, {}).mode).toBe("ask");
    expect(resolve({ effort: "low" }, {}, { effort: "max" }).effort).toBe("low");
    expect(resolve({}, {}, { effort: "max" }).effort).toBe("max");
    expect(resolve({}, {}, {}).effort).toBeUndefined();
    expect(resolve({ fallback: "f:1" }, {}, { fallback: "f:2" }).fallback).toBe("f:1");
    expect(resolve({ fallback: "" }, {}, { fallback: "f:2" }).fallback).toBe(""); // an empty --fallback turns the file's off
    expect(resolve({}, {}, { fallback: "f:2" }).fallback).toBe("f:2");
    expect(resolve({}, {}, {}).fallback).toBeUndefined();
  });

  it("takes max tasks and the status parts from the flag, then the file, then the default", () => {
    expect(resolve({ "max-tasks": "4" }, {}, { maxTasks: 6 }).maxTasks).toBe(4);
    expect(resolve({}, {}, { maxTasks: 6 }).maxTasks).toBe(6);
    expect(resolve({}, {}, {}).maxTasks).toBe(8);
    expect(resolve({ status: "cost" }, {}, { status: ["lead"] }).segments).toEqual(["cost"]);
    expect(resolve({}, {}, { status: ["lead"] }).segments).toEqual(["lead"]);
    expect(resolve({}, {}, {}).segments).toEqual(SEGMENTS);
  });

  it("takes the scroll speed from --scroll-speed, then TACHI_SCROLL_SPEED, then the file, then 3", () => {
    expect(resolve({ "scroll-speed": "2" }, { TACHI_SCROLL_SPEED: "4" }, { scrollSpeed: 5 }).speed).toBe(2);
    expect(resolve({}, { TACHI_SCROLL_SPEED: "4" }, { scrollSpeed: 5 }).speed).toBe(4);
    expect(resolve({}, { TACHI_SCROLL_SPEED: "" }, { scrollSpeed: 5 }).speed).toBe(5);
    expect(resolve({}, {}, {}).speed).toBe(3);
  });

  // Release 5's rule: -p has no screen to scroll, so it ignores TACHI_SCROLL_SPEED, and so the file's scrollSpeed too.
  it("with -p, ignores TACHI_SCROLL_SPEED and the file's scrollSpeed, but not --scroll-speed", () => {
    expect(resolve({ print: "hi" }, { TACHI_SCROLL_SPEED: "abc" }, { scrollSpeed: 5 }).speed).toBe(3);
    expect(resolve({ print: "hi", "scroll-speed": "2" }, {}, { scrollSpeed: 5 }).speed).toBe(2);
  });

  it("still checks a flag given over the file, in the flag's words", () => {
    expect(() => resolve({ mode: "x" }, {}, { mode: "ask" })).toThrow('--mode must be one of: ask, project (got "x")');
    // `never` is not offered, but still read, so the launch can say it is switched off (release 6 plan, choice 30).
    expect(resolve({ mode: "never" }, {}, {}).mode).toBe("never");
    expect(() => resolve({ effort: "x" }, {}, {})).toThrow('--effort must be one of: low, medium, high, xhigh, max (got "x")');
    expect(() => resolve({ "max-tasks": "1e1" }, {}, { maxTasks: 2 })).toThrow('--max-tasks must be a whole number from 1 (got "1e1")');
    expect(() => resolve({ status: "nope" }, {}, { status: ["lead"] })).toThrow(
      '--status must be one of: lead, context, tokens, cost, mode, errors, project, time, tasks, tools (got "nope")',
    );
    expect(() => resolve({ "scroll-speed": "21" }, {}, { scrollSpeed: 2 })).toThrow('--scroll-speed must be a number above 0, up to 20 (got "21")');
  });
});

// Release 6 design, "Live edits": an entry a flag or variable gave at launch stays as given, and the line names which.
describe("givenBy", () => {
  it("names the flag that gave each entry, or else its variable, an empty variable being unset", () => {
    const flags = {
      lead: "a:1",
      mode: "ask",
      effort: "low",
      fallback: "",
      worker: "w:1",
      "max-tasks": "2",
      status: "lead",
      classic: true,
      "scroll-speed": "2",
    };
    const env = { TACHI_LEAD: "a:2", TACHI_WORKER: "w:2", TACHI_CLASSIC: "1", TACHI_SCROLL_SPEED: "4" };
    expect(givenBy(flags, env)).toEqual({
      lead: "--lead",
      mode: "--mode",
      effort: "--effort",
      fallback: "--fallback", // an empty --fallback still wins over the file
      worker: "--worker",
      maxTasks: "--max-tasks",
      status: "--status",
      screen: "--classic",
      scrollSpeed: "--scroll-speed",
    });
    expect(givenBy({}, env)).toEqual({ lead: "TACHI_LEAD", worker: "TACHI_WORKER", screen: "TACHI_CLASSIC", scrollSpeed: "TACHI_SCROLL_SPEED" });
    expect(givenBy({}, { TACHI_LEAD: "", TACHI_WORKER: "", TACHI_CLASSIC: "0", TACHI_SCROLL_SPEED: "" })).toEqual({});
    expect(givenBy({}, {})).toEqual({});
  });
});
