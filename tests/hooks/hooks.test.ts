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
import { Hooks, MODE_NAMES, type Run, type Where } from "../../src/hooks/hooks.js";
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

  // Release 8b plan, Task 7: the session gives a tool ctx.report only when a hook after the call would run for it.
  it("says whether any hook at an event matches a value, none with hooks off, and runs none to say it", async () => {
    const p = await place();
    const bash = p.hook("bash", { event: "PostToolUse", matcher: { names: ["Bash"] } });
    const { hooks } = setup(p, [bash, p.hook("pre")]);
    const asked = () =>
      [hooks.has("PostToolUse", "Bash"), hooks.has("PostToolUse", "Read"), hooks.has("PostToolUseFailure", "Bash"), hooks.has("PreToolUse", "Read")];
    expect(asked()).toEqual([true, false, false, true]);
    hooks.set(config([bash, p.hook("pre")], true));
    expect(asked()).toEqual([false, false, false, false]);
    expect([p.inputs("bash"), p.inputs("pre")]).toEqual([[], []]);
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

  // Task 12's code review: the runs are emptied at each lead turn, a prompt's or one reading background answers alone, and
  // at a load (session.ts), never by a new prompt id.
  it("empties the turn's runs at each turn, and keeps them at a new prompt id", async () => {
    const p = await place();
    const { hooks } = setup(p, [p.hook("h")]);
    await hooks.fire("PreToolUse", {});
    expect(hooks.runs.map((r) => [r.event, r.ran.code, r.outcome.kind])).toEqual([["PreToolUse", 0, "ok"]]);
    hooks.newPrompt();
    expect(hooks.runs).toHaveLength(1);
    hooks.newTurn();
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
    const denied = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
    const deny = p.hook("deny", { async: true }, { stdout: denied });
    const { hooks, errors } = setup(p, [exit2, json, deny]);
    await hooks.fire("PreToolUse", {});
    await hooks.fire("UserPromptSubmit", {});
    while (hooks.runs.length < 3) await pause(20);
    expect(errors.map((e) => e.message).sort()).toEqual([
      `PreToolUse hook failed: ${commandOf(deny)} asked to block, but an "async" hook cannot block`,
      `PreToolUse hook failed: ${commandOf(exit2)} asked to block, but an "async" hook cannot block`,
      `UserPromptSubmit hook failed: ${commandOf(json)} asked to block, but an "async" hook cannot block`,
    ].sort());
  });

  // The user's choice, 2026-11-09: an async hook that asks to stop the turn says it cannot; one that asks to stop and to
  // block says only the stop, as a stop wins in combine.
  it("says an async hook that answers continue false asked to stop, and only that when it also blocks", async () => {
    const p = await place();
    const stop = p.hook("stop", { async: true }, { stdout: JSON.stringify({ continue: false, stopReason: "done" }) });
    const both = p.hook("both", { async: true }, { stdout: JSON.stringify({ continue: false, decision: "block" }) });
    const { hooks, errors } = setup(p, [stop, both]);
    await hooks.fire("PreToolUse", {});
    while (hooks.runs.length < 2) await pause(20);
    expect(errors.map((e) => e.message).sort()).toEqual([
      `PreToolUse hook failed: ${commandOf(both)} asked to stop, but an "async" hook cannot stop`,
      `PreToolUse hook failed: ${commandOf(stop)} asked to stop, but an "async" hook cannot stop`,
    ].sort());
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

  // Release 8e design: at the five events whose hooks decide, an async hook's allow, deny, ask, rewrite, retry or block
  // decides nothing and gets 8b's line.
  it("says an async hook that tries to decide at PermissionRequest, PermissionDenied, PreModelSwitch, PostToolBatch and ConfigChange asked to block, and it decides nothing (release 8e plan, step 3)", async () => {
    const p = await place();
    const said = (event: Event, fields: object, top: object = {}) => JSON.stringify({ ...top, hookSpecificOutput: { hookEventName: event, ...fields } });
    const tries: [Event, Hook][] = [
      ["PermissionRequest", p.hook("allow", { event: "PermissionRequest", async: true }, { stdout: said("PermissionRequest", { decision: { behavior: "allow" } }) })],
      ["PermissionRequest", p.hook("rewrite", { event: "PermissionRequest", async: true }, {
        stdout: said("PermissionRequest", { decision: { behavior: "allow", updatedInput: { command: "ls" } } }) })],
      ["PermissionRequest", p.hook("deny", { event: "PermissionRequest", async: true }, {
        stdout: said("PermissionRequest", { decision: { behavior: "deny", message: "No", interrupt: true } }) })],
      ["PermissionDenied", p.hook("retry", { event: "PermissionDenied", async: true }, { stdout: said("PermissionDenied", { retry: true }) })],
      ["PreModelSwitch", p.hook("switch-allow", { event: "PreModelSwitch", async: true }, { stdout: said("PreModelSwitch", { permissionDecision: "allow" }) })],
      ["PreModelSwitch", p.hook("switch-ask", { event: "PreModelSwitch", async: true }, { stdout: said("PreModelSwitch", { permissionDecision: "ask" }) })],
      ["PreModelSwitch", p.hook("switch-exit2", { event: "PreModelSwitch", async: true }, { stderr: "no", code: 2 })],
      ["PostToolBatch", p.hook("batch", { event: "PostToolBatch", async: true }, { stdout: JSON.stringify({ decision: "block", reason: "no" }) })],
      ["ConfigChange", p.hook("config", { event: "ConfigChange", async: true }, { stderr: "no", code: 2 })],
    ];
    const { hooks, errors } = setup(p, tries.map(([, h]) => h));
    for (const event of [...new Set(tries.map(([e]) => e))]) expect(await hooks.fire(event, {}), event).toEqual(empty(event));
    while (hooks.runs.length < tries.length) await pause(20);
    expect(errors.map((e) => e.message).sort()).toEqual(
      tries.map(([event, h]) => `${event} hook failed: ${commandOf(h)} asked to block, but an "async" hook cannot block`).sort());
  });

  it("blocks nothing for an async hook with onFailure block that cannot start at the five events whose hooks decide, saying its failure alone (release 8e plan, step 3)", async () => {
    const p = await place();
    const events: Event[] = ["PermissionRequest", "PermissionDenied", "PreModelSwitch", "PostToolBatch", "ConfigChange"];
    const missing = path.join(p.root, "no-such-program");
    const { hooks, errors } = setup(p, events.map((event) => ({ ...p.hook(event, { event, async: true, onFailure: "block" }), command: missing, args: [] })));
    for (const event of events) expect(await hooks.fire(event, {}), event).toEqual(empty(event));
    while (hooks.runs.length < events.length) await pause(20);
    expect(errors.map((e) => e.message.replace(/ \(.*\)$/, "")).sort()).toEqual(events.map((e) => `${e} hook failed: ${missing} could not start`).sort());
  });

  // Q13's cancel is a sync hook's: an async PreModelSwitch hook that runs out of time is a failure alone. The run stands in
  // for the time-out, so nothing waits 30 s.
  it("says an async PreModelSwitch hook's time-out as a failure alone, with no line that it asked to block (release 8e plan, step 3)", async () => {
    const p = await place();
    const realRun = vi.mocked(runHook).getMockImplementation()!;
    onTestFinished(() => void vi.mocked(runHook).mockReset().mockImplementation(realRun));
    vi.mocked(runHook).mockResolvedValueOnce({ code: null, stdout: "", stderr: "", ms: 30_000, failed: "time", limit: 30 });
    const hook = p.hook("slow", { event: "PreModelSwitch", async: true });
    const { hooks, errors } = setup(p, [hook]);
    expect(await hooks.fire("PreModelSwitch", {})).toEqual(empty("PreModelSwitch"));
    while (hooks.runs.length < 1) await pause(20);
    expect(errors.map((e) => e.message)).toEqual([`PreModelSwitch hook failed: ${commandOf(hook)} ran out of time after 30 s`]);
  });

  // The user's choice at step 3's review: the old "approve" is PreToolUse's alone, so at PreModelSwitch it is no try to
  // decide.
  it("says nothing for an async PreModelSwitch hook that answers the old decision approve (release 8e plan, step 3)", async () => {
    const p = await place();
    const { hooks, errors } = setup(p, [p.hook("approve", { event: "PreModelSwitch", async: true }, { stdout: JSON.stringify({ decision: "approve" }) })]);
    expect(await hooks.fire("PreModelSwitch", {})).toEqual(empty("PreModelSwitch"));
    while (hooks.runs.length < 1) await pause(20);
    expect(errors).toEqual([]);
  });

  it("hands back no text from an async PostModelSwitch hook, plain or additionalContext, and says nothing for it (release 8e plan, step 3)", async () => {
    const p = await place();
    const context = JSON.stringify({ hookSpecificOutput: { hookEventName: "PostModelSwitch", additionalContext: "ctx" } });
    const { hooks, errors } = setup(p, [
      p.hook("plain", { event: "PostModelSwitch", async: true }, { stdout: "Now on haiku" }),
      p.hook("context", { event: "PostModelSwitch", async: true }, { stdout: context }),
    ]);
    expect(await hooks.fire("PostModelSwitch", {})).toEqual(empty("PostModelSwitch"));
    while (hooks.runs.length < 2) await pause(20);
    expect(errors).toEqual([]);
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

  // Release 8e design, "Time limits": Claude Code's 30 s at the two switch events, its usual 600 s at the other seven.
  it("gives a hook without a timeout 30 s at PreModelSwitch and PostModelSwitch and 600 s at the other events release 8e adds (release 8e plan, step 1)", async () => {
    const p = await place();
    const events: Event[] = ["PermissionRequest", "PermissionDenied", "StopFailure", "Notification", "PreModelSwitch", "PostModelSwitch",
      "PostToolBatch", "InstructionsLoaded", "ConfigChange"];
    const { hooks } = setup(p, events.map((event) => p.hook(event, { event })));
    vi.mocked(runHook).mockClear();
    for (const event of events) await hooks.fire(event, {});
    expect(vi.mocked(runHook).mock.calls.map((c) => c[2].limit)).toEqual([600, 600, 600, 600, 30, 30, 600, 600, 600]);
  });

  // Release 8e design, "Matchers": for another provider's model every PreModelSwitch and PostModelSwitch hook runs,
  // whatever its matcher (steps 13 and 14 use this).
  it("runs every hook of an event, whatever its matcher, when the caller asks for all of them (release 8e plan, step 1)", async () => {
    const p = await place();
    const { hooks } = setup(p, [p.hook("haiku", { event: "PreModelSwitch", matcher: { names: ["claude-haiku-4-5"] } }), p.hook("other")]);
    await hooks.fire("PreModelSwitch", {}, { match: "llama3" });
    expect(p.inputs("haiku")).toHaveLength(0);
    await hooks.fire("PreModelSwitch", {}, { match: "llama3", every: true });
    expect([p.inputs("haiku").length, p.inputs("other").length]).toEqual([1, 0]);
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

  // Claude Code's hooks reference, "Common fields" (release 8b plan, "Numbers in this plan"; Task 10).
  // A hook's own shorter timeout still ends it sooner (Task 10's code review).
  it("shares 1.5 s between SessionEnd's hooks, raised by a hook's own longer timeout, to 60 s at most", async () => {
    const p = await place();
    const end = (name: string, timeout?: number) => p.hook(name, { event: "SessionEnd", ...(timeout === undefined ? {} : { timeout }) });
    for (const [given, limits] of [
      [[end("a"), end("b", 0.5)], [1.5, 0.5]],
      [[end("a"), end("b", 10)], [10, 10]],
      [[end("a", 100)], [60]],
    ] as const) {
      vi.mocked(runHook).mockClear();
      await setup(p, [...given]).hooks.fire("SessionEnd", {});
      expect(vi.mocked(runHook).mock.calls.map((c) => c[2].limit)).toEqual(limits);
    }
  });

  // Task 10's code review: at SessionEnd nothing is left running, and no failure line is lost, as Tachikoma is ending.
  it("waits for SessionEnd's async hooks too, within their limits, saying their failures before it returns", async () => {
    const p = await place();
    const never = path.join(p.root, "never");
    const slow = p.hook("slow", { event: "SessionEnd", async: true, timeout: 0.5 }, { go: never });
    const failing = p.hook("failing", { event: "SessionEnd", async: true }, { stderr: "it broke", code: 1 });
    const { hooks, errors } = setup(p, [slow, failing]);
    await hooks.fire("SessionEnd", {});
    expect(errors.map((e) => e.message).sort()).toEqual([
      `SessionEnd hook failed: ${commandOf(failing)} exited with code 1: it broke`,
      `SessionEnd hook failed: ${commandOf(slow)} ran out of time after 0.5 s`,
    ]);
    expect(hooks.runs).toHaveLength(2);
  });

  // The user's choice, 2026-11-09 ("Esc stops it"): a switch's stop ends SessionEnd's async hooks too, as it waits for them.
  it("stops SessionEnd's async hooks with the rest, and rejects with Cancelled", async () => {
    const p = await place();
    const stop = new AbortController();
    const never = path.join(p.root, "never");
    const { hooks, errors } = setup(p, [p.hook("a", { event: "SessionEnd", async: true }, { go: never })]);
    const firing = hooks.fire("SessionEnd", {}, { signal: stop.signal });
    while (p.inputs("a").length < 1) await pause(20);
    stop.abort();
    await expect(firing).rejects.toThrow("Cancelled");
    expect(errors).toEqual([]);
  });

  // The final review (the user's choice, 2026-11-10): an async hook still running when Tachikoma exits is killed with
  // all it started, the lead's and a subagent's alike, saying nothing, as the user has left; one fired after is never
  // started. Each hook writes its process id to a file in the test's folder, then never ends; up to 10 s for Windows to
  // end it, as a tree kill there (taskkill /T) takes 2-4 s.
  it("kills every async hook still running at stopAsync, a subagent's too, saying nothing, and starts none after", async () => {
    const p = await place();
    const forever = (name: string): Hook => {
      const pidFile = path.join(p.root, `${name}.pid`);
      return p.hook(name, { async: true, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`] });
    };
    const { hooks, errors, notes } = setup(p, [forever("lead")]);
    const sub = hooks.for({ id: "t1" }, new Bus());
    await hooks.fire("PreToolUse", {});
    sub.set(config([forever("sub")]));
    await sub.fire("PreToolUse", {});
    const pids: number[] = [];
    for (const name of ["lead", "sub"]) {
      const pidFile = path.join(p.root, `${name}.pid`);
      for (let i = 0; !existsSync(pidFile) || !readFileSync(pidFile, "utf8"); i++) {
        if (i === 500) throw new Error("the hook never started");
        await pause(20);
      }
      pids.push(Number(readFileSync(pidFile, "utf8")));
    }
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    onTestFinished(() => pids.forEach((pid) => alive(pid) && process.kill(pid)));
    hooks.stopAsync();
    for (let i = 0; pids.some(alive) && i < 500; i++) await pause(20);
    expect(pids.map(alive)).toEqual([false, false]);
    vi.mocked(runHook).mockClear();
    hooks.set(config([forever("late")]));
    await hooks.fire("PreToolUse", {});
    await pause(100);
    expect([errors, notes, hooks.runs, sub.runs, existsSync(path.join(p.root, "late.pid"))]).toEqual([[], [], [], [], false]);
    expect(await Promise.allSettled(vi.mocked(runHook).mock.results.map((r) => r.value))).toEqual([
      { status: "rejected", reason: new Error("Cancelled") },
    ]);
  });

  // Release 8e plan, step 4 (Codex round 1, point 7): a fire the caller does not wait for, its hooks under the stop that
  // ends async hooks as Tachikoma exits, so none keeps a -p run or the window's exit waiting.
  it("fires an event without the caller waiting, its handle answering with the combined answer once its hook ends", async () => {
    const p = await place();
    const go = path.join(p.root, "go");
    const said = JSON.stringify({ hookSpecificOutput: { hookEventName: "PostModelSwitch", additionalContext: "now on haiku" } });
    const { hooks, errors } = setup(p, [p.hook("h", { event: "PostModelSwitch" }, { go, stdout: said })]);
    let done = false;
    const handle = hooks.fireAndLeave("PostModelSwitch", {});
    void handle.then(() => (done = true));
    while (p.inputs("h").length < 1) await pause(20);
    await pause(50);
    expect([done, hooks.runs]).toEqual([false, []]);
    writeFileSync(go, "");
    expect((await handle).context).toEqual([{ event: "PostModelSwitch", text: "now on haiku" }]);
    expect([hooks.runs.length, errors]).toEqual([1, []]);
  });

  it("ends a fire not waited for at stopAsync, saying nothing, its handle answering with no answer, no rejection unhandled", async () => {
    const p = await place();
    const never = path.join(p.root, "never");
    const { hooks, errors, notes } = setup(p, [p.hook("h", { event: "PostModelSwitch" }, { go: never })]);
    const unhandled: unknown[] = [];
    const listen = (err: unknown) => void unhandled.push(err);
    process.on("unhandledRejection", listen);
    onTestFinished(() => void process.off("unhandledRejection", listen));
    vi.mocked(runHook).mockClear();
    const handle = hooks.fireAndLeave("PostModelSwitch", {});
    while (p.inputs("h").length < 1) await pause(20);
    hooks.stopAsync();
    expect(await handle).toEqual(empty("PostModelSwitch"));
    // One fired after the exit is never started.
    expect(await hooks.fireAndLeave("PostModelSwitch", {})).toEqual(empty("PostModelSwitch"));
    await pause(50);
    expect([errors, notes, hooks.runs, unhandled, p.inputs("h").length]).toEqual([[], [], [], [], 1]);
    expect(await Promise.allSettled(vi.mocked(runHook).mock.results.map((r) => r.value))).toEqual([
      { status: "rejected", reason: new Error("Cancelled") },
    ]);
  });

  it("says a failure in a fire not waited for as its red line, and catches a listener that throws", async () => {
    const p = await place();
    const failing = p.hook("h", { event: "PostModelSwitch" }, { stderr: "it broke", code: 1 });
    const { hooks, bus, errors } = setup(p, [failing]);
    const unhandled: unknown[] = [];
    const listen = (err: unknown) => void unhandled.push(err);
    process.on("unhandledRejection", listen);
    onTestFinished(() => void process.off("unhandledRejection", listen));
    await hooks.fireAndLeave("PostModelSwitch", {});
    expect(errors.map((e) => e.message)).toEqual([`PostModelSwitch hook failed: ${commandOf(failing)} exited with code 1: it broke`]);
    bus.on("error", () => {
      throw new Error("a listener broke");
    });
    expect(await hooks.fireAndLeave("PostModelSwitch", {})).toEqual(empty("PostModelSwitch"));
    await pause(50);
    expect([errors.length, unhandled]).toEqual([2, []]);
  });

  // Release 8e plan, step 4 (design: runs outside a turn "are listed with the next turn"): a fire marked outside a turn
  // keeps its runs apart, and the next lead turn's list begins with them; a load in between drops none of them.
  it("lists a run fired outside a turn with the next turn, not the one before, through a load too, and a run inside with its own", async () => {
    const p = await place();
    const { hooks } = setup(p, [p.hook("note", { event: "Notification" }), p.hook("pre")]);
    const events = () => hooks.runs.map((r) => r.event);
    hooks.beginTurn();
    await hooks.fire("PreToolUse", {});
    await hooks.fire("Notification", {}, { outside: true });
    await hooks.fireAndLeave("Notification", {}, { outside: true });
    expect(events()).toEqual(["PreToolUse"]);
    hooks.newTurn(); // a load
    expect(events()).toEqual([]);
    hooks.beginTurn();
    expect(events()).toEqual(["Notification", "Notification"]);
    await hooks.fire("PreToolUse", {});
    expect(events()).toEqual(["Notification", "Notification", "PreToolUse"]);
    const start: Run = { ...hooks.runs[2]!, event: "SessionStart" };
    hooks.beginTurn();
    expect(events()).toEqual([]);
    // A fresh conversation's first turn: the runs fired outside it first, then SessionStart's it carries.
    await hooks.fire("Notification", {}, { outside: true });
    hooks.beginTurn([start]);
    expect(events()).toEqual(["Notification", "SessionStart"]);
  });

  // A prompt that starts no turn puts the earlier list back (session.ts), and the runs the new list began with go back
  // apart, a run fired outside a turn that answers after that too; one that answers during the next turn joins its list.
  it("puts a turn's runs from outside it back apart when its prompt starts no turn, and lists a later answer with the next turn", async () => {
    const p = await place();
    const [go1, go2] = [path.join(p.root, "go1"), path.join(p.root, "go2")];
    const note = (name: string, type: string, go?: string) => p.hook(name, { event: "Notification", matcher: { names: [type] } }, go ? { go } : {});
    const { hooks } = setup(p, [note("idle", "idle_prompt"), note("slow", "auth_success", go1), note("slower", "permission_prompt", go2), p.hook("pre")]);
    const events = () => hooks.runs.map((r) => [r.event, ...(r.match ? [r.match] : [])]);
    hooks.beginTurn();
    await hooks.fire("PreToolUse", {});
    const before = hooks.runs;
    await hooks.fire("Notification", {}, { match: "idle_prompt", outside: true });
    const slow = hooks.fireAndLeave("Notification", {}, { match: "auth_success", outside: true });
    const slower = hooks.fireAndLeave("Notification", {}, { match: "permission_prompt", outside: true });
    while (p.inputs("slow").length < 1 || p.inputs("slower").length < 1) await pause(20);
    hooks.beginTurn(); // a prompt a UserPromptSubmit hook then blocks
    expect(events()).toEqual([["Notification", "idle_prompt"]]);
    hooks.restoreRuns(before);
    expect(hooks.runs).toBe(before);
    writeFileSync(go1, "");
    await slow;
    expect(events()).toEqual([["PreToolUse"]]);
    hooks.beginTurn(); // the next real turn
    expect(events()).toEqual([["Notification", "idle_prompt"], ["Notification", "auth_success"]]);
    writeFileSync(go2, "");
    await slower;
    await hooks.fire("PreToolUse", {});
    expect(events()).toEqual([["Notification", "idle_prompt"], ["Notification", "auth_success"], ["Notification", "permission_prompt"], ["PreToolUse"]]);
    expect(before.map((r) => r.event)).toEqual(["PreToolUse"]);
  });

  // Step 4's review: a run fired outside a turn that is still answering when a second turn begins lands in the turn it
  // answers in, never the earlier turn's list, which Ctrl+O no longer shows.
  it("lists a run fired outside a turn that answers two turns later with the turn it answers in, not the earlier one", async () => {
    const p = await place();
    const go = path.join(p.root, "go");
    const { hooks } = setup(p, [p.hook("slow", { event: "Notification" }, { go })]);
    const late = hooks.fireAndLeave("Notification", {}, { outside: true });
    while (p.inputs("slow").length < 1) await pause(20);
    hooks.beginTurn();
    const first = hooks.runs;
    hooks.beginTurn();
    writeFileSync(go, "");
    await late;
    expect([first, hooks.runs.map((r) => r.event)]).toEqual([[], ["Notification"]]);
    // A prompt that then starts no turn puts it back apart, for the next real turn.
    hooks.restoreRuns(first);
    expect(hooks.runs).toBe(first);
    hooks.beginTurn();
    expect([first, hooks.runs.map((r) => r.event)]).toEqual([[], ["Notification"]]);
  });

  // Release 8b plan, Task 12 (design, "What the user sees"): the waiting line shows a running hook's statusMessage, so the
  // bus says when one starts and ends; an async hook is not waited for, so it says nothing (the builder's choice, Task 12).
  it("says a hook's statusMessage on the bus as it starts and as it ends, a stopped one too, and nothing for an async one", async () => {
    const p = await place();
    const go = path.join(p.root, "go");
    const never = path.join(p.root, "never");
    const { hooks, bus } = setup(p, [
      p.hook("held", { statusMessage: "Checking" }, { go }),
      p.hook("plain"),
      p.hook("left", { statusMessage: "Logging", async: true }),
    ]);
    const said: [string, boolean][] = [];
    bus.on("hook-status", (message, running) => void said.push([message, running]));
    const firing = hooks.fire("PreToolUse", {});
    while (p.inputs("held").length < 1) await pause(20);
    expect(said).toEqual([["Checking", true]]);
    writeFileSync(go, "");
    await firing;
    expect(said).toEqual([["Checking", true], ["Checking", false]]);
    hooks.set(config([p.hook("stopped", { statusMessage: "Waiting" }, { go: never })]));
    const stop = new AbortController();
    const stopped = hooks.fire("PreToolUse", {}, { signal: stop.signal });
    while (p.inputs("stopped").length < 1) await pause(20);
    stop.abort();
    await expect(stopped).rejects.toThrow("Cancelled");
    expect(said.slice(2)).toEqual([["Waiting", true], ["Waiting", false]]);
  });
});

// Release 8c plan, choice 35 (the plan review, finding 4): the answers a form's hooks give, through the real fire. Task 12
// fires these events; here they are fired as it will, matched on the server's name.
describe.each(["Elicitation", "ElicitationResult"] as const)("Hooks at %s", { timeout: 15_000 }, (event) => {
  const said = (fields: object) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, ...fields } });
  const answering = (p: Place, name: string, fields: object, more: { code?: number; stderr?: string } = {}) =>
    p.hook(name, { event, matcher: { names: ["memory"] } }, { stdout: said(fields), ...more });
  const fire = async (p: Place, hooks: Hook[]) => {
    const s = setup(p, hooks);
    return { c: await s.hooks.fire(event, { mcp_server_name: "memory", message: "Your name?" }, { match: "memory" }), ...s };
  };

  it("takes an accept with its content, a decline and a cancel, and leaves it to the user with none", async () => {
    const p = await place();
    expect((await fire(p, [answering(p, "a", { action: "accept", content: { name: "Ada" } })])).c.elicitation).toEqual({
      action: "accept", content: { name: "Ada" } });
    expect((await fire(p, [answering(p, "d", { action: "decline" })])).c.elicitation).toEqual({ action: "decline" });
    expect((await fire(p, [answering(p, "c", { action: "cancel" })])).c.elicitation).toEqual({ action: "cancel" });
    const none = await fire(p, [answering(p, "n", {})]);
    expect([none.c.elicitation, none.errors]).toEqual([undefined, []]);
    // Matched on the server's name: another server's form runs none.
    const other = setup(p, [answering(p, "x", { action: "accept" })]);
    expect((await other.hooks.fire(event, {}, { match: "sanity" })).elicitation).toBeUndefined();
    expect(p.inputs("x")).toEqual([]);
  });

  it("takes exit code 2 as a decline, whatever was printed, and says no failure", async () => {
    const p = await place();
    const { c, errors } = await fire(p, [answering(p, "two", { action: "accept", content: { name: "Ada" } }, { code: 2, stderr: "no forms" })]);
    expect([c.elicitation, c.failures, errors]).toEqual([{ action: "decline" }, [], []]);
  });

  it("lets a decline win over a cancel and an accept, and a cancel over an accept, in any order", async () => {
    const p = await place();
    const accept = answering(p, "accept", { action: "accept", content: { name: "Ada" } });
    const cancel = answering(p, "cancel", { action: "cancel" });
    const decline = answering(p, "decline", { action: "decline" });
    expect((await fire(p, [accept, decline])).c.elicitation).toEqual({ action: "decline" });
    expect((await fire(p, [decline, cancel, accept])).c.elicitation).toEqual({ action: "decline" });
    expect((await fire(p, [accept, cancel])).c.elicitation).toEqual({ action: "cancel" });
  });

  it("takes the first accept's content in the file when two accept", async () => {
    const p = await place();
    const first = answering(p, "first", { action: "accept", content: { name: "Ada" } });
    const second = answering(p, "second", { action: "accept", content: { name: "Bob" } });
    expect((await fire(p, [first, second])).c.elicitation).toEqual({ action: "accept", content: { name: "Ada" } });
    expect((await fire(p, [second, first])).c.elicitation).toEqual({ action: "accept", content: { name: "Bob" } });
  });

  it("says JSON whose action or content cannot be taken in the approved words, and answers nothing for it", async () => {
    const p = await place();
    const action = answering(p, "action", { action: "maybe" });
    const content = answering(p, "content", { action: "accept", content: ["Ada"] });
    const { c, errors } = await fire(p, [action, content]);
    const lines = [
      `${commandOf(action)} printed JSON that could not be read ("action" must be "accept", "decline" or "cancel")`,
      `${commandOf(content)} printed JSON that could not be read ("content" must be an object)`,
    ];
    expect([c.elicitation, c.failures]).toEqual([undefined, lines]);
    expect(errors.map((e) => e.message)).toEqual(lines.map((l) => `${event} hook failed: ${l}`));
  });

  // Choice 35: nothing else at these events changes 8b's rules; continue and additionalContext are not read.
  it("reads no continue or additionalContext, and still says a systemMessage", async () => {
    const p = await place();
    const specific = { hookEventName: event, action: "cancel", additionalContext: "x" };
    const stdout = JSON.stringify({ continue: false, systemMessage: "asked", hookSpecificOutput: specific });
    const { c, notes } = await fire(p, [p.hook("h", { event }, { stdout })]);
    expect([c.stop, c.context, c.elicitation, notes]).toEqual([undefined, [], { action: "cancel" }, [`${event} hook: asked`]]);
  });
});
