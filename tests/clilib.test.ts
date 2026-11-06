import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import path from "node:path";
import { privateDir } from "../src/auth/private.js";
import { Bus } from "../src/core/bus.js";
import { readInstructions } from "../src/core/instructions.js";
import { PermissionGate } from "../src/core/permissions.js";
import { openSession, sessionsDir } from "../src/core/sessions.js";
import type { Message, ToolSpec } from "../src/core/types.js";
import {
  approvalQuestion,
  chooseSession,
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
  leadSession,
  newSaved,
  openSaved,
  prose,
  protectionOf,
  resolve,
  resumed,
  resumeArgs,
  screenMode,
  scrollSpeed,
  statusSegments,
  systemAgain,
} from "../src/clilib.js";
import { SEGMENTS } from "../src/tui/StatusLine.js";
import { FakeProvider, removeTree, tempContext } from "./helpers.js";

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
  const why =
    "declined, nobody to ask in -p mode (--mode project allows ordinary writes inside the project, " +
    "but protected files, shell commands and anything outside it are still refused)";
  it("says why, then the action, after a space, its subagent's name escaped before it", () => {
    expect(headlessDeclined("run: ls")).toBe(`${why}: run: ls`);
    expect(headlessDeclined("run: ls", "t2 (a\u001b[2Jb)")).toBe(`${why}: t2 (a\\u001b[2Jb): run: ls`);
  });

  // Release 7 plan, Task 8: a dangerous command's red lines, escaped by the gate as the action is, each on its own line
  // before the declined one. The gate is the one -p mode makes; the command is text it reads, never run.
  it("says each danger first, a line each, escaped as the gate escapes them", async () => {
    const line = "git push --force origin a\u001b[8m; git reset --hard HEAD~3";
    let printed = "";
    const ask = async (summary: string, _detail?: string, owner?: { name: string }, _plain?: boolean, warnings?: string[]) => {
      printed = headlessDeclined(summary, owner?.name, warnings);
      return false;
    };
    const gate = new PermissionGate("project", ask, "x", { headless: true });
    await expect(gate.require({ kind: "shell", outside: false, summary: `run: ${line}`, command: line })).rejects.toThrow("Not allowed: this command matches");
    expect(printed).toBe(
      [
        "Danger: rewriting or deleting git history: git push --force origin a\\u001b[8m",
        "Danger: rewriting or deleting git history: git reset --hard HEAD~3",
        `${why}: run: git push --force origin a\\u001b[8m; git reset --hard HEAD~3`,
      ].join("\n"),
    );
  });
});

// Release 7 plan, Task 8 (choices 57 and 59): what the launch hands the gate from git's settings, for the file tools.
describe("protectionOf", () => {
  it("protects the hooks folders and the git folders as folders, and the settings files as files", () => {
    const git = {
      files: ["/p/.git/config", "/home/me/.gitconfig"],
      hooksPaths: ["/p/githooks"],
      gitDirs: ["/p/.bare"],
      problems: [{ file: "/p/x", why: "it is a link" }],
      lineEndings: {},
    };
    expect(protectionOf(git)).toEqual({ hooks: ["/p/githooks", "/p/.bare"], files: ["/p/.git/config", "/home/me/.gitconfig"] });
  });

  it("is empty without git, so only the fixed list protects (choice 11)", () => {
    expect(protectionOf(undefined)).toEqual({ hooks: [], files: [] });
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

  // Release 7 design, "Launching" and "The modes": the sandbox and its network are off unless asked for, and the judge is
  // unset, the lead's model then judging (release 7 plan, Task 7). An empty --judge still wins, as --worker's does.
  it("takes the sandbox, the network and the judge from the flag, then the file, then the default", () => {
    expect(resolve({ sandbox: "live" }, {}, { sandbox: "copy" }).sandbox).toBe("live");
    expect(resolve({}, {}, { sandbox: "copy" }).sandbox).toBe("copy");
    expect(resolve({}, {}, {}).sandbox).toBe("off");
    expect(resolve({ network: "off" }, {}, { network: "on" }).network).toBe("off");
    expect(resolve({}, {}, { network: "on" }).network).toBe("on");
    expect(resolve({}, {}, {}).network).toBe("off");
    expect(resolve({ judge: "j:1" }, {}, { judge: "j:2" }).judge).toBe("j:1");
    expect(resolve({ judge: "" }, {}, { judge: "j:2" }).judge).toBe("");
    expect(resolve({}, {}, { judge: "j:2" }).judge).toBe("j:2");
    expect(resolve({}, {}, {}).judge).toBeUndefined();
  });

  it("takes auto mode from the flag or the file", () => {
    expect(resolve({ mode: "auto" }, {}, { mode: "ask" }).mode).toBe("auto");
    expect(resolve({}, {}, { mode: "auto" }).mode).toBe("auto");
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
    expect(() => resolve({ mode: "x" }, {}, { mode: "ask" })).toThrow('--mode must be one of: ask, project, auto, never (got "x")');
    // `never` is offered and read, as copy mode is built (release 7 plan, Task 21); the launch says it needs copy mode.
    expect(resolve({ mode: "never" }, {}, {}).mode).toBe("never");
    expect(() => resolve({ sandbox: "x" }, {}, { sandbox: "off" })).toThrow('--sandbox must be one of: off, live, copy (got "x")');
    expect(() => resolve({ network: "x" }, {}, { network: "off" })).toThrow('--network must be one of: off, on (got "x")');
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
      sandbox: "off",
      network: "on",
      judge: "j:1",
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
      sandbox: "--sandbox",
      network: "--network",
      judge: "--judge",
    });
    expect(givenBy({}, env)).toEqual({ lead: "TACHI_LEAD", worker: "TACHI_WORKER", screen: "TACHI_CLASSIC", scrollSpeed: "TACHI_SCROLL_SPEED" });
    expect(givenBy({}, { TACHI_LEAD: "", TACHI_WORKER: "", TACHI_CLASSIC: "0", TACHI_SCROLL_SPEED: "" })).toEqual({});
    expect(givenBy({}, {})).toEqual({});
  });
});

// Release 8a plan, Task 6 and choice 11: parseArgs cannot take an optional value, so a -r or --resume with none, last or
// before another option, is given an empty one, which means "show the list".
describe("resumeArgs", () => {
  it("gives -r and --resume an empty value when none follows, and leaves a given one alone", () => {
    expect(resumeArgs(["-r"])).toEqual(["-r", ""]);
    expect(resumeArgs(["--resume", "-p", "hi"])).toEqual(["--resume", "", "-p", "hi"]);
    expect(resumeArgs(["-r", "abc", "-c"])).toEqual(["-r", "abc", "-c"]);
    expect(resumeArgs(["--resume=abc", "-r", "my name"])).toEqual(["--resume=abc", "-r", "my name"]);
  });
});

// Release 8a plan, Task 6 (choices 4, 8, 9 and 11-13). One sessions folder for the cases that open or start a session,
// made private once, as privateDir starts PowerShell on Windows, each case's sessions with ids of their own; plain
// folders, never made private, for choosing, which only reads.
describe("saved sessions at launch", { timeout: 15_000 }, () => {
  let top: string;
  let dir: string;
  let plain = 0;
  beforeAll(() => {
    top = mkdtempSync(path.join(tmpdir(), "tachi-clilib-"));
    dir = sessionsDir(top, path.join(top, "data", "tachikoma"));
    privateDir(dir);
  });
  afterAll(() => removeTree(top));
  const folder = () => {
    const d = path.join(top, "plain", `p${++plain}`);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const at = "2026-11-06T00:00:00.000Z";
  const tools: ToolSpec[] = [{ name: "echo", description: "Says it back.", inputSchema: { type: "object" } }];
  const start = (id: string, o: { print?: boolean; tools?: ToolSpec[] } = {}) => ({
    t: "start",
    at,
    v: 1,
    id,
    project: top,
    lead: "fake:a",
    version: "0.8.0",
    print: o.print ?? false,
    system: "Saved prompt.",
    tools: o.tools ?? tools,
  });
  const prompt = (text: string): Message => ({ role: "user", parts: [{ type: "text", text }] });
  const said = (text: string, native?: Message["native"]): Message => ({ role: "assistant", parts: [{ type: "text", text }], ...(native ? { native } : {}) });
  const message = (m: Message) => ({ t: "message", at, message: m });
  // A session's file as a Transcript writes it, its lines as given, last changed `ago` days before now.
  const saved = (d: string, id: string, lines: object[], ago = 0) => {
    const file = path.join(d, `${id}.jsonl`);
    writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
    const when = new Date(Date.now() - ago * 24 * 60 * 60 * 1000);
    utimesSync(file, when, when);
    return file;
  };
  const talk = (id: string, words: string, o: { print?: boolean; name?: string } = {}) => [
    start(id, o),
    message(prompt(words)),
    message(said("Done.")),
    ...(o.name ? [{ t: "name", at, name: o.name }] : []),
  ];
  const read = (file: string) => readFileSync(file, "utf8");

  describe("chooseSession", () => {
    const NONE = { fail: "No saved session to continue in this folder." };
    const NEEDS = { fail: "tachi --resume needs a terminal to list sessions; give it a session's id or name." };

    it("continues the newest session, and with -p the newest -p session", () => {
      const d = folder();
      expect(chooseSession(d, { continue: true, print: false, terminal: true })).toEqual(NONE);
      saved(d, "older", talk("older", "one"), 3);
      saved(d, "newer", talk("newer", "two"), 2);
      saved(d, "printed", talk("printed", "three", { print: true }), 1);
      expect(chooseSession(d, { continue: true, print: false, terminal: true })).toEqual({ id: "newer" });
      expect(chooseSession(d, { continue: true, print: true, terminal: false })).toEqual({ id: "printed" });
      const other = folder();
      saved(other, "only", talk("only", "one"));
      expect(chooseSession(other, { continue: true, print: true, terminal: false })).toEqual(NONE);
    });

    it("opens a session by id or name, lists the sessions a name belongs to, and names what it cannot find", () => {
      const d = folder();
      saved(d, "s1", talk("s1", "one", { name: "fix" }), 3);
      saved(d, "s2", talk("s2", "two", { name: "twin" }), 2);
      saved(d, "s3", talk("s3", "three", { name: "twin" }), 1);
      saved(d, "p1", talk("p1", "four", { print: true }));
      expect(chooseSession(d, { resume: "s2", print: false, terminal: true })).toEqual({ id: "s2" });
      expect(chooseSession(d, { resume: "fix", print: true, terminal: false })).toEqual({ id: "s1" });
      expect(chooseSession(d, { resume: "p1", print: false, terminal: true })).toEqual({ id: "p1" }); // an id finds a -p run too
      expect(chooseSession(d, { resume: "twin", print: false, terminal: true })).toMatchObject({ list: [{ id: "s3" }, { id: "s2" }], name: "twin" });
      const missing = "No session named or numbered nope in this folder; tachi --resume lists them.";
      expect(chooseSession(d, { resume: "nope", print: false, terminal: true })).toEqual({ fail: missing });
      // A file the list leaves out, as it cannot be read, is opened by its id, so the launch can say why.
      writeFileSync(path.join(d, "broken.jsonl"), "not a start line\n");
      expect(chooseSession(d, { resume: "broken", print: false, terminal: true })).toEqual({ id: "broken" });
    });

    it("lists the sessions but -p runs for -r alone, which needs a terminal, as a name more than one session has does", () => {
      const d = folder();
      expect(chooseSession(d, { resume: "", print: false, terminal: false })).toEqual(NEEDS);
      expect(chooseSession(d, { resume: "", print: false, terminal: true })).toEqual({ fail: "No saved sessions in this folder." });
      saved(d, "s1", talk("s1", "one", { name: "twin" }), 2);
      saved(d, "s2", talk("s2", "two", { name: "twin" }), 1);
      saved(d, "p1", talk("p1", "three", { print: true }));
      const list = chooseSession(d, { resume: "", print: false, terminal: true });
      expect(list).toMatchObject({ list: [{ id: "s2" }, { id: "s1" }] });
      expect((list as { list: unknown[] }).list).toHaveLength(2);
      expect(chooseSession(d, { resume: "", print: true, terminal: false })).toEqual(NEEDS);
      expect(chooseSession(d, { resume: "twin", print: true, terminal: false })).toEqual(NEEDS);
    });
  });

  describe("openSaved and resumed", () => {
    const native = { provider: "anthropic", content: [{ type: "thinking", thinking: "hm", signature: "x" }] };
    const other: ToolSpec[] = [{ name: "write_file", description: "Writes a file.", inputSchema: { type: "object" } }];
    // Opened, and made this window's under `as` tools and lead `lead`; let go once the case ends, as the process's exit would.
    const open = (id: string, o: { fork?: boolean; as?: ToolSpec[]; lead?: string } = {}) => {
      const s = openSaved(dir, id, { fork: o.fork ?? false });
      if ("problem" in s) throw new Error(s.problem);
      const r = resumed(s, { tools: o.as ?? tools, lead: o.lead ?? "fake:a" });
      onTestFinished(r.release);
      return r;
    };
    const lines = (file: string) => read(file).trim().split("\n").map((l) => JSON.parse(l));

    it("opens a session under its lock, mends a torn last line, and says what it skipped", () => {
      const file = saved(dir, "torn", [...talk("torn", "first words"), { t: "message", at, message: "not a message" }]);
      appendFileSync(file, '{"t":"message","at":"2026-11-06T00:00:00.000Z","mess');
      const o = open("torn");
      expect(read(path.join(dir, "torn.lock"))).toBe(String(process.pid));
      expect(read(file).endsWith('"mess\n')).toBe(true);
      expect(o.conversation).toMatchObject({ id: "torn", system: "Saved prompt.", messages: [prompt("first words"), said("Done.")], prompts: ["first words"] });
      expect(o.conversation).toMatchObject({ nextPicture: 1, nextTask: 1 });
      expect(o.lines).toEqual(["Resumed: first words.", "2 damaged lines of this session were skipped."]);
      expect(o.lost).toEqual([]);
      o.conversation.transcript!.write({ t: "message", message: prompt("next") });
      expect(read(file).split("\n").at(-2)).toContain('"next"');
      o.release();
      expect(readdirSync(dir)).not.toContain("torn.lock");
    });

    it("names a session with neither name nor prompt by its id", () => {
      saved(dir, "bare", [start("bare"), { t: "shortened", at, system: "Short.", message: said("A summary.") }]);
      expect(open("bare").lines).toEqual(["Resumed: bare."]);
    });

    it("opens a copy of a session open in another window, saying so, and of any session with --fork-session, the originals unchanged", () => {
      saved(dir, "held", talk("held", "one", { name: "held one" }));
      saved(dir, "forked", talk("forked", "two"));
      const before = [read(path.join(dir, "held.jsonl")), read(path.join(dir, "forked.jsonl"))];
      const lock = openSession(dir, "held");
      onTestFinished(() => lock?.release());
      const copy = open("held");
      const fork = open("forked", { fork: true });
      expect(copy.conversation.id).not.toBe("held");
      expect(fork.conversation.id).not.toBe("forked");
      expect(copy.lines).toEqual(["Opened a copy: that session is open in another window.", "Resumed: held one."]);
      expect(fork.lines).toEqual(["Resumed: two."]);
      for (const o of [copy, fork]) {
        expect(read(path.join(dir, `${o.conversation.id}.lock`))).toBe(String(process.pid));
        expect(o.conversation.messages).toHaveLength(2);
        o.conversation.transcript!.write({ t: "message", message: prompt("more") });
      }
      expect([read(path.join(dir, "held.jsonl")), read(path.join(dir, "forked.jsonl"))]).toEqual(before);
    });

    // Release 8a plan, choice 4 (Task 6 spec review): the lead and the tools a resume brings are recorded.
    it("writes a lead line for another lead, and a tools line for other tools, and nothing for the same ones", () => {
      const file = saved(dir, "same", talk("same", "hi"));
      open("same").release();
      expect(lines(file).map((l) => l.t)).toEqual(["start", "message", "message"]);
      open("same", { lead: "fake:b", as: other }).release();
      expect(lines(file).slice(3)).toMatchObject([{ t: "lead", lead: "fake:b" }, { t: "tools", tools: other }]);
    });

    it("sends a reply's thinking only under the tools it was saved under, saying when any was left out", () => {
      saved(dir, "thought", [start("thought"), message(prompt("hi")), message(said("Done.", native))]);
      saved(dir, "plain", [start("plain"), message(prompt("hi")), message(said("Done."))]);
      const changed = "The tools have changed since this session was saved, so its earlier replies are sent without their thinking.";
      // Under other tools: the first reply's thinking is left out, and a reply made then keeps its own.
      const b = open("thought", { as: other });
      expect(b.conversation.messages).toEqual([prompt("hi"), said("Done.")]);
      expect(b.lines).toEqual(["Resumed: hi.", changed]);
      b.conversation.transcript!.write({ t: "message", message: prompt("again") });
      b.conversation.transcript!.write({ t: "message", message: said("Done again.", native) });
      b.release();
      // Back under the first tools: the first reply's thinking goes again, and the other tools' does not.
      const a = open("thought");
      expect(a.conversation.messages).toEqual([prompt("hi"), said("Done.", native), prompt("again"), said("Done again.")]);
      expect(a.lines).toEqual(["Resumed: hi.", changed]);
      expect(open("plain", { as: other }).lines).toEqual(["Resumed: hi."]);
    });

    it("tells the model once of each subagent that had not finished, and gives a crash's unanswered call its result", () => {
      const call: Message = { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "delegate", input: { task: "look" } }] };
      const subagent = { t: "subagent", at, id: "t1", description: "look around", file: "t1.jsonl" };
      saved(dir, "crashed", [start("crashed"), message(prompt("go")), message(call), subagent]);
      const o = open("crashed");
      expect(o.lost).toEqual(["Subagent t1 (look around) had not finished when the session ended; its answer was lost."]);
      const result = { type: "tool_result", callId: "c1", output: expect.stringMatching(/^Outcome unknown: /), isError: true };
      expect(o.conversation.messages.at(-1)!.parts[0]).toMatchObject(result);
      expect(o.conversation.nextTask).toBe(2);
      expect(lines(path.join(dir, "crashed", "subagents", "t1.jsonl"))).toMatchObject([{ t: "ended", state: "lost" }]);
      o.release();
      expect(open("crashed").lost).toEqual([]);
    });

    it("refuses a session it cannot read, in the approved line, leaving no lock or copy behind, a copy it made removed", () => {
      const names = () => readdirSync(dir).sort();
      for (const [id, text, why] of [
        ["broken", "not a start line\n", "its first line is missing or damaged"],
        ["odd", '{"t":"odd"}\n', "its first line is missing or damaged"],
      ] as const) {
        const file = path.join(dir, `${id}.jsonl`);
        writeFileSync(file, text);
        const problem = `${file} could not be read as a session (${why}).`;
        const before = names();
        expect(openSaved(dir, id, { fork: false })).toEqual({ problem });
        expect(openSaved(dir, id, { fork: true })).toEqual({ problem }); // "odd" is copied, then read, then removed
        expect(names()).toEqual(before);
      }
    });

    // The failure is a file standing where the copy's folder goes, under the copy's id the test gives.
    it("says a copy it cannot make could not be copied, leaving none of it behind", () => {
      const file = saved(dir, "pics", talk("pics", "hi"));
      mkdirSync(path.join(dir, "pics", "pictures"), { recursive: true });
      writeFileSync(path.join(dir, "pics-copy"), "in the copy's folder's place");
      const got = openSaved(dir, "pics", { fork: true, copy: "pics-copy" });
      expect(got).toEqual({ problem: expect.stringMatching(/ could not be copied \(EEXIST: .+\)\.$/) });
      expect((got as { problem: string }).problem.startsWith(`${file} could not be copied (`)).toBe(true);
      expect(names()).not.toContain("pics-copy.jsonl");
      function names() {
        return readdirSync(dir);
      }
    });
  });

  // Release 8a plan, choice 3 (user, 2026-11-06: "Re-read, reuse launch's answer"): a shortening's prompt reads the
  // instruction files again, a file outside the project going in only as the launch's question answered for it.
  it("reads the instruction files again, outside ones only as the launch's question answered for them", async () => {
    const own = mkdtempSync(path.join(tmpdir(), "tachi-clilib-instr-"));
    onTestFinished(() => removeTree(own));
    const [home, root, outside] = [path.join(own, "home"), path.join(own, "project"), path.join(own, "outside")];
    for (const d of [home, root, outside]) mkdirSync(d);
    writeFileSync(path.join(outside, "allowed.md"), "allowed words");
    writeFileSync(path.join(outside, "new.md"), "new words");
    writeFileSync(path.join(root, "CLAUDE.md"), "first words\n@../outside/allowed.md\n");
    const where = { root, home, top: root };
    const asked = new Map<string, boolean>();
    const launch = await readInstructions(where, async (reached) => {
      for (const r of reached) asked.set(r.path, true);
      return true;
    });
    expect(launch.text).toContain("allowed words");
    writeFileSync(path.join(root, "CLAUDE.md"), "second words\n@../outside/allowed.md\n");
    const again = systemAgain("The base.", where, asked);
    let text = await again();
    expect(text.startsWith("The base.\n\n")).toBe(true);
    expect(text).toContain("second words");
    expect(text).toContain("allowed words");
    writeFileSync(path.join(root, "CLAUDE.md"), "third words\n@../outside/new.md\n");
    text = await again();
    expect(text).toContain("third words");
    expect(text).not.toContain("new words");
    expect(await systemAgain("The base.", where, "all")()).toContain("new words"); // never mode reads them, as at launch
  });

  describe("newSaved", () => {
    const begin = { project: "p", lead: "fake:a", version: "0.8.0", system: "New prompt.", tools };

    it("writes the start line and the name, then takes the lock", () => {
      const o = newSaved(dir, { ...begin, id: "fresh", print: true }, "my name");
      expect(o.conversation).toMatchObject({ id: "fresh", system: "New prompt.", messages: [], prompts: [], calls: [], nextPicture: 1, nextTask: 1 });
      expect(o.conversation.transcript!.failed).toBeNull();
      const lines = read(path.join(dir, "fresh.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
      expect(lines).toMatchObject([
        { t: "start", v: 1, id: "fresh", lead: "fake:a", print: true, system: "New prompt.", tools },
        { t: "name", name: "my name" },
      ]);
      expect(read(path.join(dir, "fresh.lock"))).toBe(String(process.pid));
    });

    it("goes on unsaved, taking no lock, when a file stands where the sessions folder should be", () => {
      const blocked = path.join(folder(), "sessions");
      writeFileSync(blocked, "not a folder");
      const o = newSaved(blocked, { ...begin, id: "fresh", print: false });
      expect(o.conversation.transcript!.failed).not.toBeNull();
      expect(read(blocked)).toBe("not a folder");
    });
  });

  // Release 8a plan, Task 6: the window's picture numbers are one counter, the session's and the screen's, so a picture
  // made after a resume never takes a saved one's number.
  it("makes the lead's session with the Pictures the screen is given, which a loaded conversation raises", async () => {
    const { session, pictures } = leadSession({ lead: new FakeProvider("a", []), tools: [], system: "s", ctx: await tempContext(), bus: new Bus() });
    session.load({ id: "x", messages: [], system: "s", prompts: [], calls: [], nextPicture: 4, nextTask: 1 });
    expect(pictures.next()).toBe(4);
  });
});
