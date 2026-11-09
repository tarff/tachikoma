import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ErrorEvent } from "../../src/core/bus.js";
import type { Mode } from "../../src/core/permissions.js";
import { gitBash } from "../../src/exec/env.js";
import { combine } from "../../src/hooks/answer.js";
import type { Event, Hook, HooksConfig } from "../../src/hooks/config.js";
import { Hooks, MODE_NAMES, type Where } from "../../src/hooks/hooks.js";
import { runHook } from "../../src/hooks/run.js";
import type { Effort } from "../../src/providers/anthropic.js";
import { Bus, collectErrors, removeTree } from "../helpers.js";

// Both run as they are; a test reads the limits runHook was given, or has one answer stand in for a run or for Git Bash.
vi.mock("../../src/hooks/run.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/hooks/run.js")>();
  return { ...real, runHook: vi.fn(real.runHook) };
});
vi.mock("../../src/exec/env.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/exec/env.js")>();
  return { ...real, gitBash: vi.fn(real.gitBash) };
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A folder of the test's own, removed when the test finishes, tried every 50 ms up to 2 s, as tests/hooks/run.test.ts
// does: Windows keeps the folder a killed program worked in for about 170 ms (measured 2026-10-31).
async function folder(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "tachi-hooks-"));
  onTestFinished(async () => {
    for (let i = 0; ; i++) {
      try {
        return await removeTree(dir);
      } catch (err) {
        if (i === 40) throw err;
        await pause(50);
      }
    }
  });
  return dir;
}

// One script for every hook: it appends its input to the file named by its first argument, so a test sees each run, then
// waits for the file named by the second, when one is given, polling every 20 ms as helpers.ts's stand-in editor does,
// then prints the third to its stdout and the fourth to its stderr and exits with the fifth.
const SCRIPT = `const fs = require("fs");
const [out, go, stdout, stderr, code] = process.argv.slice(2);
let text = "";
process.stdin.setEncoding("utf8").on("data", (d) => (text += d)).on("end", () => {
  fs.appendFileSync(out, text + "\\n");
  const finish = () => {
    process.stdout.write(stdout ?? "");
    process.stderr.write(stderr ?? "");
    process.exit(Number(code || 0));
  };
  const poll = () => (!go || fs.existsSync(go) ? finish() : setTimeout(poll, 20));
  poll();
});`;

interface Place {
  root: string;
  hook: (name: string, fields?: Partial<Hook>, says?: { go?: string; stdout?: string; stderr?: string; code?: number }) => Hook;
  inputs: (name: string) => Record<string, unknown>[];
}

async function place(): Promise<Place> {
  const root = await folder();
  const script = path.join(root, "hook.cjs");
  writeFileSync(script, SCRIPT);
  const out = (name: string) => path.join(root, `${name}.jsonl`);
  return {
    root,
    // In exec form, Node running the script, so no shell is needed (release 8b plan, "Rules").
    hook: (name, fields = {}, says = {}) => ({
      event: "PreToolUse",
      matcher: { all: true },
      command: process.execPath,
      args: [script, out(name), says.go ?? "", says.stdout ?? "", says.stderr ?? "", String(says.code ?? 0)],
      async: false,
      where: `"${fields.event ?? "PreToolUse"}"`,
      ...fields,
    }),
    inputs: (name) =>
      existsSync(out(name))
        ? readFileSync(out(name), "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as Record<string, unknown>)
        : [],
  };
}

const config = (hooks: Hook[], off = false): HooksConfig => ({ hooks, off, leftOut: [] });

function setup(p: Place, hooks: Hook[], over: Partial<Where> = {}) {
  const bus = new Bus();
  const notes: string[] = [];
  bus.on("hook-note", (line) => notes.push(line));
  const where: Where = {
    sessionId: () => "session-1",
    transcript: () => path.join(p.root, "session-1.jsonl"),
    root: p.root,
    mode: () => "ask",
    effort: () => undefined,
    lead: () => "fake:lead",
    ...over,
  };
  return { hooks: new Hooks(config(hooks), where, bus), bus, errors: collectErrors(bus), notes };
}

const commandOf = (h: Hook) => [h.command, ...(h.args ?? [])].join(" ");
const empty = (event: Event) => combine(event, []);

// Each test starts a few Node processes, about 0.1 s each here; 15 s leaves room under load, as tests/hooks/run.test.ts.
describe("Hooks", { timeout: 15_000 }, () => {
  it("runs the event's hooks whose matcher matches, and with no value to match only those that match everything", async () => {
    const p = await place();
    const { hooks } = setup(p, [
      p.hook("all"),
      p.hook("bash", { matcher: { names: ["Bash"] } }),
      p.hook("edits", { matcher: { names: ["Edit", "Write"] } }),
      p.hook("regex", { matcher: { regex: /^B/ } }),
      p.hook("later", { event: "PostToolUse" }),
    ]);
    await hooks.fire("PreToolUse", {}, { match: "Bash" });
    expect(["all", "bash", "edits", "regex", "later"].map((n) => p.inputs(n).length)).toEqual([1, 1, 0, 1, 0]);
    await hooks.fire("PreToolUse", {});
    expect(["all", "bash", "edits", "regex", "later"].map((n) => p.inputs(n).length)).toEqual([2, 1, 0, 1, 0]);
  });

  // Release 8b design, "Running a hook" (review, 2026-11-09, finding 3).
  it("runs an entry the same as an earlier one in every field once, under another matcher too, and two alike but for args both", async () => {
    const p = await place();
    const audit = p.hook("audit");
    const { hooks } = setup(p, [audit, { ...audit, matcher: { names: ["Bash"] } }, p.hook("protect")]);
    await hooks.fire("PreToolUse", {}, { match: "Bash" });
    expect([p.inputs("audit").length, p.inputs("protect").length]).toEqual([1, 1]);
    expect(hooks.runs.map((r) => r.hook.args![1])).toEqual([path.join(p.root, "audit.jsonl"), path.join(p.root, "protect.jsonl")]);
  });

  it("sends the lead's hooks the common fields in Claude Code's names, then the event's own", async () => {
    const p = await place();
    const { hooks } = setup(p, [p.hook("h")], { mode: () => "project", effort: () => "high" });
    await hooks.fire("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }, { match: "Bash" });
    const [input] = p.inputs("h");
    expect(input).toEqual({
      session_id: "session-1",
      transcript_path: path.join(p.root, "session-1.jsonl"),
      cwd: p.root,
      hook_event_name: "PreToolUse",
      permission_mode: "acceptEdits",
      effort: { level: "high" },
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    expect(Object.keys(input!).slice(-2)).toEqual(["tool_name", "tool_input"]);
  });

  it("sends a subagent's hooks its id and Claude Code's name for a read-only subagent, the rest as the lead's, on its own bus", async () => {
    const p = await place();
    const { hooks, notes } = setup(p, [p.hook("h", {}, { stdout: JSON.stringify({ systemMessage: "hi" }) })]);
    hooks.newPrompt();
    const own = new Bus();
    const ownNotes: string[] = [];
    own.on("hook-note", (line) => ownNotes.push(line));
    const sub = hooks.for({ id: "t1", transcript: path.join(p.root, "t1.jsonl") }, own);
    await sub.fire("PreToolUse", { tool_name: "Read" }, { match: "Read" });
    const [input] = p.inputs("h");
    expect(input).toEqual({
      session_id: "session-1",
      transcript_path: path.join(p.root, "session-1.jsonl"),
      cwd: p.root,
      hook_event_name: "PreToolUse",
      permission_mode: "default",
      prompt_id: expect.any(String),
      agent_id: "t1",
      agent_type: "Explore",
      tool_name: "Read",
    });
    expect([ownNotes, notes]).toEqual([["PreToolUse hook: hi"], []]);
    // Its runs are its own, as Ctrl+O lists the lead's turn.
    expect([sub.runs.length, hooks.runs.length]).toEqual([1, 0]);
  });

  it("sends permission_mode as each mode's nearest Claude Code name", async () => {
    const p = await place();
    let mode: Mode = "ask";
    const { hooks } = setup(p, [p.hook("h")], { mode: () => mode });
    const modes: Mode[] = ["ask", "project", "auto", "never"];
    for (const m of modes) {
      mode = m;
      await hooks.fire("PreToolUse", {});
    }
    expect(p.inputs("h").map((i) => i.permission_mode)).toEqual(["default", "acceptEdits", "auto", "bypassPermissions"]);
    expect(MODE_NAMES).toEqual({ ask: "default", project: "acceptEdits", auto: "auto", never: "bypassPermissions" });
  });

  it("sends effort only when the lead has one", async () => {
    const p = await place();
    let effort: Effort | undefined;
    const { hooks } = setup(p, [p.hook("h")], { effort: () => effort });
    await hooks.fire("PreToolUse", {});
    effort = "max";
    await hooks.fire("PreToolUse", {});
    expect(p.inputs("h").map((i) => i.effort)).toEqual([undefined, { level: "max" }]);
  });

  it("sends no prompt_id before the first prompt, then a new one at each, which a subagent shares", async () => {
    const p = await place();
    const { hooks } = setup(p, (["SessionStart", "UserPromptSubmit", "PreToolUse"] as const).map((event) => p.hook("h", { event })));
    const sub = hooks.for({ id: "t1" }, new Bus());
    await hooks.fire("SessionStart", {});
    hooks.newPrompt();
    await hooks.fire("UserPromptSubmit", {});
    await sub.fire("PreToolUse", {});
    hooks.newPrompt();
    await hooks.fire("UserPromptSubmit", {});
    const ids = p.inputs("h").map((i) => i.prompt_id);
    expect(ids[0]).toBeUndefined();
    expect(ids[1]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(ids[2]).toBe(ids[1]);
    expect(ids[3]).not.toBe(ids[1]);
  });

  it("empties the turn's runs at each prompt", async () => {
    const p = await place();
    const { hooks } = setup(p, [p.hook("h")]);
    await hooks.fire("PreToolUse", {});
    expect(hooks.runs.map((r) => [r.event, r.ran.code, r.outcome.kind])).toEqual([["PreToolUse", 0, "ok"]]);
    hooks.newPrompt();
    expect(hooks.runs).toEqual([]);
  });

  it("says a failure as a hook error with the approved red line, and hands it on", async () => {
    const p = await place();
    const failing = p.hook("h", {}, { stderr: "bad thing\nmore", code: 1 });
    const { hooks, errors } = setup(p, [failing]);
    const c = await hooks.fire("PreToolUse", {});
    const line = `${commandOf(failing)} exited with code 1: bad thing`;
    expect(c.failures).toEqual([line]);
    expect(errors).toEqual<ErrorEvent[]>([{ kind: "hook", attempted: "PreToolUse hook", message: `PreToolUse hook failed: ${line}`, lead: "fake:lead" }]);
  });

  it("says each systemMessage as a hook note with the approved grey line", async () => {
    const p = await place();
    const { hooks, notes, errors } = setup(p, [
      p.hook("a", {}, { stdout: JSON.stringify({ systemMessage: "checked" }) }),
      p.hook("b", {}, { stdout: JSON.stringify({ systemMessage: "audited" }) }),
    ]);
    const c = await hooks.fire("PreToolUse", {});
    expect(c.messages).toEqual(["checked", "audited"]);
    expect(notes).toEqual(["PreToolUse hook: checked", "PreToolUse hook: audited"]); // in the file's order
    expect(errors).toEqual([]);
  });

  it("runs the hooks at once and waits for them all", async () => {
    const p = await place();
    const go = path.join(p.root, "go");
    // The first waits for the second's go file, so the fire ends only if both ran at the same time.
    const second = p.hook("second", { args: ["-e", `require("fs").writeFileSync(${JSON.stringify(go)}, "")`] });
    const { hooks } = setup(p, [p.hook("first", {}, { go }), second]);
    const c = await hooks.fire("PreToolUse", {});
    expect(c.failures).toEqual([]);
    expect(hooks.runs.map((r) => r.ran.code)).toEqual([0, 0]);
  });

  it("finishes a fire under way with the hooks it began with; a set applies from the next", async () => {
    const p = await place();
    const { hooks } = setup(p, [p.hook("before")]);
    const after = config([p.hook("after")]);
    const firing = hooks.fire("PreToolUse", {});
    hooks.set(after);
    await firing;
    expect([p.inputs("before").length, p.inputs("after").length]).toEqual([1, 0]);
    expect(hooks.config).toBe(after);
    await hooks.fire("PreToolUse", {});
    expect([p.inputs("before").length, p.inputs("after").length]).toEqual([1, 1]);
  });

  it("reaches a subagent's hooks with a set on the lead's", async () => {
    const p = await place();
    const { hooks } = setup(p, [p.hook("before")]);
    const sub = hooks.for({ id: "t1" }, new Bus());
    hooks.set(config([p.hook("after")]));
    await sub.fire("PreToolUse", {});
    expect([p.inputs("before").length, p.inputs("after").length]).toEqual([0, 1]);
  });

  it("runs nothing with hooks off, or none matching, and answers as combine does with no hooks", async () => {
    const p = await place();
    const { hooks } = setup(p, [p.hook("h", { matcher: { names: ["Bash"] } })]);
    expect(await hooks.fire("PreToolUse", {}, { match: "Edit" })).toEqual(empty("PreToolUse"));
    hooks.set(config([p.hook("h")], true));
    expect(await hooks.fire("PreToolUse", {}, { match: "Bash" })).toEqual(empty("PreToolUse"));
    expect(p.inputs("h")).toEqual([]);
    expect(hooks.runs).toEqual([]);
  });

  // Release 8b plan, choice 5.
  it("does not wait for an async hook, leaves it out of the answer, and still reports its failure and its block when they come", async () => {
    const p = await place();
    const go = path.join(p.root, "go");
    const late = p.hook("late", { async: true }, { go, stderr: "too late", code: 1 });
    const blocking = p.hook("blocking", { async: true }, { go, stdout: JSON.stringify({ systemMessage: "late", decision: "block" }) });
    const { hooks, errors, notes } = setup(p, [late, blocking]);
    const c = await hooks.fire("PreToolUse", {});
    expect(c).toEqual(empty("PreToolUse"));
    expect(errors).toEqual([]);
    writeFileSync(go, "");
    while (hooks.runs.length < 2) await pause(20);
    // Sorted, as the two may answer in either order.
    expect(errors.map((e) => e.message).sort()).toEqual([
      `PreToolUse hook failed: ${commandOf(blocking)} asked to block, but an "async" hook cannot block`,
      `PreToolUse hook failed: ${commandOf(late)} exited with code 1: too late`,
    ]);
    expect(errors.map((e) => [e.kind, e.attempted, e.lead])).toEqual([["hook", "PreToolUse hook", "fake:lead"], ["hook", "PreToolUse hook", "fake:lead"]]);
    expect(notes).toEqual([]); // its systemMessage is not said
    expect(hooks.runs.map((r) => [r.hook.async, r.ran.code]).sort()).toEqual([[true, 0], [true, 1]]);
  });

  // The user's choice, 2026-11-09: an async hook that asks to block, as combine would file a sync one's answer under block,
  // says it cannot.
  it("says an async hook that exits with code 2, or answers decision block, asked to block", async () => {
    const p = await place();
    const exit2 = p.hook("exit2", { async: true }, { stderr: "no", code: 2 });
    const json = p.hook("json", { event: "UserPromptSubmit", async: true }, { stdout: JSON.stringify({ decision: "block", reason: "no" }) });
    const { hooks, errors } = setup(p, [exit2, json]);
    await hooks.fire("PreToolUse", {});
    await hooks.fire("UserPromptSubmit", {});
    while (hooks.runs.length < 2) await pause(20);
    expect(errors.map((e) => e.message).sort()).toEqual([
      `PreToolUse hook failed: ${commandOf(exit2)} asked to block, but an "async" hook cannot block`,
      `UserPromptSubmit hook failed: ${commandOf(json)} asked to block, but an "async" hook cannot block`,
    ]);
  });

  // Task 4's code review: a /lead switch while an async hook runs does not change the model its failure names.
  it("names in a late async hook's failure the model that led when it started", async () => {
    const p = await place();
    const go = path.join(p.root, "go");
    let lead = "fake:first";
    const { hooks, errors } = setup(p, [p.hook("h", { async: true }, { go, code: 1 })], { lead: () => lead });
    await hooks.fire("PreToolUse", {});
    lead = "fake:second";
    writeFileSync(go, "");
    while (hooks.runs.length < 1) await pause(20);
    expect(errors.map((e) => e.lead)).toEqual(["fake:first"]);
  });

  // Task 4's spec review: a failure that onFailure "block" would make a block is still said for an async hook, which blocks
  // nothing.
  it("says an async hook's failure with onFailure block", async () => {
    const p = await place();
    const failing = p.hook("h", { async: true, onFailure: "block" }, { stderr: "bad thing", code: 1 });
    const { hooks, errors } = setup(p, [failing]);
    await hooks.fire("PreToolUse", {});
    while (hooks.runs.length < 1) await pause(20);
    expect(errors.map((e) => e.message)).toEqual([`PreToolUse hook failed: ${commandOf(failing)} exited with code 1: bad thing`]);
  });

  // The other way a failure becomes a block: a PreToolUse hook run by a shell on Windows without Git Bash (answer.ts). The
  // run stands in for one, as Windows PowerShell would run it here.
  it.skipIf(process.platform !== "win32")("says an async PreToolUse hook's failure run by a shell on Windows without Git Bash", async () => {
    const p = await place();
    const real = vi.mocked(gitBash).getMockImplementation()!;
    vi.mocked(gitBash).mockImplementation(() => null);
    onTestFinished(() => void vi.mocked(gitBash).mockImplementation(real));
    // mockReset drops the answer below if the test ends before runHook takes it, and with it the real runHook wrapped above,
    // which is put back.
    const realRun = vi.mocked(runHook).getMockImplementation()!;
    onTestFinished(() => void vi.mocked(runHook).mockReset().mockImplementation(realRun));
    vi.mocked(runHook).mockResolvedValueOnce({ code: 1, stdout: "", stderr: "bad thing", ms: 1 });
    const { hooks, errors } = setup(p, [{ ...p.hook("h", { async: true }), command: "check.sh", args: undefined }]);
    await hooks.fire("PreToolUse", {});
    while (hooks.runs.length < 1) await pause(20);
    expect(errors.map((e) => e.message)).toEqual(["PreToolUse hook failed: check.sh exited with code 1: bad thing"]);
  });

  // Claude Code's hooks reference, "Common fields".
  it("gives a hook without a timeout 30 s at UserPromptSubmit and 600 s elsewhere", async () => {
    const p = await place();
    const { hooks } = setup(p, [p.hook("prompt", { event: "UserPromptSubmit" }), p.hook("tool")]);
    vi.mocked(runHook).mockClear();
    await hooks.fire("UserPromptSubmit", {});
    await hooks.fire("PreToolUse", {});
    expect(vi.mocked(runHook).mock.calls.map((c) => c[2].limit)).toEqual([30, 600]);
  });

  it("stops every hook it started when the turn stops, and rejects with Cancelled", async () => {
    const p = await place();
    const stop = new AbortController();
    const { hooks, errors } = setup(p, [p.hook("a", {}, { go: path.join(p.root, "never") }), p.hook("b", {}, { go: path.join(p.root, "never") })]);
    const firing = hooks.fire("PreToolUse", {}, { signal: stop.signal });
    // Both have started once each has written its input.
    while (p.inputs("a").length + p.inputs("b").length < 2) await pause(20);
    stop.abort();
    await expect(firing).rejects.toThrow("Cancelled");
    expect(errors).toEqual([]);
  });

  it("gives a hook its own time limit, its failure in the approved words", async () => {
    const p = await place();
    // Half a second keeps the test quick; the hook never ends by itself, so the line is the same whether or not Node had
    // started by then.
    const slow = p.hook("slow", { timeout: 0.5 }, { go: path.join(p.root, "never") });
    const { hooks, errors } = setup(p, [slow]);
    await hooks.fire("PreToolUse", {});
    expect(errors.map((e) => e.message)).toEqual([`PreToolUse hook failed: ${commandOf(slow)} ran out of time after 0.5 s`]);
  });
});
