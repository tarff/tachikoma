import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { Mode } from "../../src/core/permissions.js";
import { type CommandTask, Tasks } from "../../src/core/tasks.js";
import type { Provider } from "../../src/core/types.js";
import type { ExecResult, Executor, Running } from "../../src/exec/executor.js";
import { LocalExecutor } from "../../src/exec/local.js";
import { CommandLog, deliver } from "../../src/exec/log.js";
import { shellTools } from "../../src/tools/commands.js";
import { shellText } from "../../src/tools/shell.js";
import { InvalidInput } from "../../src/tools/tool.js";
import { Bus, FakeProvider, Held, tempContext } from "../helpers.js";

// Background commands plan, Task 5: the shell tool starts a command in the background, or runs it in the foreground until
// its end, Esc, its timeout or Ctrl+B. The executor is a stand-in whose start gives a command the test drives, so no
// command runs here but the one real case at the end.

// A command the test drives: it prints into its log, ends, fails, and a stop ends it at once as killed, as the executors'
// stop does (choice 1).
function driven() {
  const log = new CommandLog();
  let s!: { end: (r: ExecResult) => void; fail: (err: Error) => void };
  const done = new Promise<ExecResult>((end, fail) => (s = { end, fail }));
  const stop = vi.fn(() => s.end({ code: null, signal: "SIGKILL", stdout: "", stderr: "" }));
  const run: Running = { log, done, stop };
  const end = (r: Partial<ExecResult> = {}) => s.end({ code: 0, signal: null, stdout: "", stderr: "", ...r });
  return { run, stop, end, fail: (err: Error) => s.fail(err) };
}

// A command in the box (user choice 36, PR #18 review): a stop only starts its kill there, which the test then lets run or
// fail.
function boxDriven() {
  const d = driven();
  const stop = vi.fn();
  return { ...d, stop, run: { ...d.run, stop, stopsLater: true } as Running };
}

type Limits = { started: number; moved: number; most: number };
async function setup(
  opts: { headless?: boolean; mode?: Mode; answers?: boolean[]; limits?: Limits; start?: () => Running; worker?: Provider; max?: number } = {},
) {
  const ctx = await tempContext(opts.mode ?? "never", opts.answers ?? []);
  const started: { command: string; cwd: string; run: ReturnType<typeof driven> }[] = [];
  const executor: Executor = {
    exec: () => Promise.reject(new Error("exec is not used here")),
    start: (command, cwd) => {
      if (opts.start) return opts.start();
      const run = driven();
      started.push({ command, cwd, run });
      return run.run;
    },
  };
  const tasks = new Tasks({
    bus: new Bus(),
    max: opts.max ?? 8,
    worker: () => opts.worker ?? new FakeProvider("w", []),
    system: "sub",
    tools: [],
    ctx: { ...ctx, executor },
    ...(opts.limits ? { limits: opts.limits } : {}),
  });
  const tools = shellTools(tasks, { shell: "PowerShell", headless: opts.headless ?? false });
  const reports: unknown[] = [];
  const call = (input: unknown, signal?: AbortSignal) =>
    tools[0]!.run(input, { ...ctx, executor, report: (p) => reports.push(p), ...(signal ? { signal } : {}) });
  // shell_output or stop_task.
  const use = (name: string, input: unknown) => tools.find((t) => t.spec.name === name)!.run(input, { ...ctx, executor });
  // The gate answers in promises and the stand-in at once, so a call reaches its wait within a few turns of the loop.
  // setImmediate, which the fake timers below leave real.
  const reached = async () => {
    for (let i = 0; i < 100 && !tasks.holding && !tasks.all.length; i++) await new Promise((r) => setImmediate(r));
  };
  return { ctx, tasks, tools, started, reports, call, use, reached };
}

// Only the timers: the gate's questions and setImmediate stay real.
const fakeTimers = () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  onTestFinished(() => void vi.useRealTimers());
};

// Until the worker has been asked `n` times, so a subagent is in the middle of its request. setImmediate, as `reached`.
const asked = async (worker: Held, n: number) => {
  for (let i = 0; i < 100 && worker.asked.length < n; i++) await new Promise((r) => setImmediate(r));
};

// Whether a promise has settled, without waiting for it.
const settled = async (p: Promise<unknown>) => {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  return done;
};

describe("the shell tool", () => {
  it("comes with shell_output and stop_task, each telling the model what it does in the plan's words", async () => {
    const { tasks } = await setup();
    const tools = shellTools(tasks, { shell: "bash", headless: false });
    expect(tools.map((t) => t.spec.name)).toEqual(["shell", "shell_output", "stop_task"]);
    expect(tools.map((t) => t.spec.description)).toEqual([
      "Run a command with bash in the project root and return its output. " +
        'A command still running after "timeout" milliseconds (120000 when not given, at most 600000) moves to the background, unless it starts with sleep. ' +
        'With "background": true it starts in the background at once, for a dev server, a watch build or a long test run; ' +
        "read its output with shell_output and stop it with stop_task. You are told when a background command ends.",
      "Read what a background command has printed since you last read it, and whether it has ended. Give its id, such as t4.",
      "Stop a background command or a background subagent by its id, such as t4.",
    ]);
    expect(tools.map((t) => t.parallel)).toEqual([undefined, undefined, undefined]); // one call after another
  });

  // Choice 11: from 1 ms to 2 hours, a whole number.
  it.each([0, 1.5, 7_200_001])("refuses a timeout of %s as invalid input and starts nothing", async (timeout) => {
    const { call, started } = await setup();
    await expect(call({ command: "npm test", timeout })).rejects.toBeInstanceOf(InvalidInput);
    expect(started).toEqual([]);
  });
});

describe("the shell tool, a background start", () => {
  // Choice 13: the question says it runs in the background, so the user, the judge and auto mode see it.
  it("asks with the background in its question, starts the command, and gives the model its id", async () => {
    const { call, ctx, started, tasks, reports } = await setup({ mode: "project", answers: [true] });
    expect(await call({ command: "npm run dev", background: true })).toBe("Started t1 in the background.");
    expect(ctx.asked).toEqual(["run in the background: npm run dev"]);
    expect(started.map((s) => [s.command, s.cwd])).toEqual([["npm run dev", ctx.root]]);
    const t = tasks.get("t1") as CommandTask;
    expect([t.kind, t.command, t.state, t.run]).toEqual(["command", "npm run dev", "running", started[0]!.run.run]);
    expect(tasks.holding).toBeUndefined();
    expect(reports).toEqual([]); // hooks get its text (Task 8)
    tasks.stop();
  });

  it("starts nothing when the user declines", async () => {
    const { call, started, tasks } = await setup({ mode: "project", answers: [false] });
    await expect(call({ command: "npm run dev", background: true })).rejects.toThrow("The user declined: run in the background: npm run dev");
    expect([started, tasks.all]).toEqual([[], []]);
  });

  // Release 7 plan, Task 8: the gate's dangerous-command check reads the command of a background start too.
  it("gives the dangerous-command check its command, which refuses it, and starts nothing", async () => {
    const push = "git push --force";
    const { call, started, tasks } = await setup({ mode: "never" });
    await expect(call({ command: push, background: true })).rejects.toThrow(
      `Not allowed: this command matches the dangerous-command check (rewriting or deleting git history: ${push}).`,
    );
    expect([started, tasks.all]).toEqual([[], []]);
  });

  // The design, "What the model gets": a window's background command has no time limit, as in Claude Code's terminal.
  it("gives a window's background start no time limit, whatever its timeout", async () => {
    const { call, started, tasks } = await setup({ headless: false });
    const adopt = vi.spyOn(tasks, "adopt");
    fakeTimers();
    expect(await call({ command: "npm run dev", background: true, timeout: 5_000 })).toBe("Started t1 in the background.");
    expect(adopt.mock.calls[0]![1]).toEqual({ command: "npm run dev" });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(7_200_000);
    expect([started[0]!.run.stop.mock.calls.length, tasks.get("t1")!.state]).toEqual([0, "running"]);
    tasks.stop();
  });

  it("gives a -p background start its timeout as its limit", async () => {
    const { call, started, tasks } = await setup({ headless: true, limits: { started: 600_000, moved: 600_000, most: 7_200_000 } });
    const adopt = vi.spyOn(tasks, "adopt");
    fakeTimers();
    expect(await call({ command: "npm run e2e", background: true, timeout: 5_000 })).toBe("Started t1 in the background.");
    expect(adopt.mock.calls[0]![1]).toEqual({ command: "npm run e2e", limit: 5_000 });
    vi.advanceTimersByTime(5_000);
    expect([started[0]!.run.stop.mock.calls.length, tasks.get("t1")!.state]).toEqual([1, "stopped"]);
  });

  // As Built, Task 2: a command that cannot be spawned makes start throw at once.
  it("ends with start's error when the command cannot start, and adopts nothing", async () => {
    const { call, tasks } = await setup({
      start: () => {
        throw new Error("spawn failed");
      },
    });
    await expect(call({ command: "npm run dev", background: true })).rejects.toThrow("spawn failed");
    expect(tasks.all).toEqual([]);
  });
});

describe("the shell tool, in the foreground", () => {
  it("returns a command's end as it always has, its report unchanged, and adopts nothing", async () => {
    const { call, started, tasks, reports, reached } = await setup({ mode: "project", answers: [true] });
    fakeTimers();
    const out = call({ command: "echo hi" });
    await reached();
    expect(tasks.holding).toBeDefined();
    started[0]!.run.end({ stdout: "hi\n", stderr: "warn\n" });
    expect(await out).toBe(shellText({ code: 0, signal: null, stdout: "hi\n", stderr: "warn\n" }));
    expect(reports).toEqual([{ stdout: "hi\n", stderr: "warn\n", code: 0 }]);
    expect([tasks.all, tasks.holding, vi.getTimerCount()]).toEqual([[], undefined, 0]);
  });

  it("throws a failing command's result, after reporting it", async () => {
    const { call, started, tasks, reports, reached } = await setup();
    const out = call({ command: "exit 3" });
    await reached();
    started[0]!.run.end({ code: 3, stderr: "bad\n" });
    await expect(out).rejects.toThrow(shellText({ code: 3, signal: null, stdout: "", stderr: "bad\n" }));
    expect(reports).toEqual([{ stdout: "", stderr: "bad\n", code: 3 }]);
    expect(tasks.holding).toBeUndefined();
  });

  // As Built, Task 2: a spawn error reported later rejects done, and the tool ends with it, as exec did.
  it("ends with the error when the command's run fails, and clears its hold and timer", async () => {
    const { call, started, tasks, reached } = await setup();
    fakeTimers();
    const out = call({ command: "npm test" });
    await reached();
    started[0]!.run.fail(new Error("spawn powershell.exe ENOENT"));
    await expect(out).rejects.toThrow("spawn powershell.exe ENOENT");
    expect([tasks.all, tasks.holding, vi.getTimerCount()]).toEqual([[], undefined, 0]);
  });

  it("ends with start's error when the command cannot start, and holds nothing", async () => {
    const { call, tasks } = await setup({
      start: () => {
        throw new Error("spawn failed");
      },
    });
    fakeTimers();
    await expect(call({ command: "npm test" })).rejects.toThrow("spawn failed");
    expect([tasks.all, tasks.holding, vi.getTimerCount()]).toEqual([[], undefined, 0]);
  });

  it("moves a command still running at the default 120 s to the background, saying so", async () => {
    const { call, started, tasks, reached } = await setup();
    fakeTimers();
    // The clock, so the task's start is the command's, not the move's (design: the panel shows how long it has run).
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    onTestFinished(() => void now.mockRestore());
    const out = call({ command: "npm test" });
    await reached();
    now.mockReturnValue(121_000);
    vi.advanceTimersByTime(120_000 - 1);
    expect(await settled(out)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(await out).toBe("Command did not complete within its 120s timeout and was moved to the background as t1.");
    const t = tasks.get("t1") as CommandTask;
    expect([t.command, t.state, t.run, started[0]!.run.stop.mock.calls.length, t.started]).toEqual(["npm test", "running", started[0]!.run.run, 0, 1_000]);
    expect([tasks.holding, vi.getTimerCount()]).toEqual([undefined, 0]);
    tasks.stop();
  });

  // The plan's numbers: a foreground timeout over ten minutes is cut to ten, as Claude Code caps it.
  it("cuts a 700,000 ms timeout to 600,000, and its line says 600s", async () => {
    const { call, started, tasks, reached } = await setup();
    fakeTimers();
    const out = call({ command: "npm run build", timeout: 700_000 });
    await reached();
    vi.advanceTimersByTime(600_000 - 1);
    expect(await settled(out)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(await out).toBe("Command did not complete within its 600s timeout and was moved to the background as t1.");
    expect(started[0]!.run.stop).not.toHaveBeenCalled();
    tasks.stop();
  });

  // The line names the timeout in whole seconds, rounded up, so a short one never reads 0s.
  it("rounds a timeout that is not a whole number of seconds up in its line", async () => {
    const { call, tasks, reached } = await setup();
    fakeTimers();
    const out = call({ command: "npm test", timeout: 1_500 });
    await reached();
    vi.advanceTimersByTime(1_500);
    expect(await out).toBe("Command did not complete within its 2s timeout and was moved to the background as t1.");
    tasks.stop();
  });

  it("tells -p's task list the command moved, so it gets the moved limit", async () => {
    const { call, tasks, reached } = await setup({ headless: true, limits: { started: 600_000, moved: 600_000, most: 7_200_000 } });
    const adopt = vi.spyOn(tasks, "adopt");
    fakeTimers();
    const out = call({ command: "npm test", timeout: 5_000 });
    await reached();
    vi.advanceTimersByTime(5_000);
    expect(await out).toBe("Command did not complete within its 5s timeout and was moved to the background as t1.");
    expect(adopt.mock.calls[0]![1]).toEqual({ command: "npm test", moved: true, started: expect.any(Number) });
    tasks.stop();
  });

  // Choice 12: a model that sleeps is waiting on purpose, so the command stops at its timeout instead of moving.
  // PowerShell's sleep is Start-Sleep, and it ignores letter case, so the rule does too.
  const stopped = ["sleep 5", "  sleep 5", "sleep\t5", "sleep;echo hi", "Sleep 5", "SLEEP 5", "Start-Sleep 5", "start-sleep -s 5"];
  it.each(stopped)("stops %j at its timeout with the sleep line", async (command) => {
    const { call, started, tasks, reached } = await setup();
    fakeTimers();
    const out = call({ command, timeout: 3_000 });
    await reached();
    vi.advanceTimersByTime(3_000);
    await expect(out).rejects.toThrow(
      "Stopped: the command did not complete within its 3s timeout. A command that starts with sleep is stopped at its timeout, not moved to the background.",
    );
    expect([started[0]!.run.stop.mock.calls.length, tasks.all, tasks.holding, vi.getTimerCount()]).toEqual([1, [], undefined, 0]);
  });

  it.each(["sleeper 5", "echo hi; sleep 5", "Start-Sleeper 5"])("moves %j at its timeout, as it does not start with sleep", async (command) => {
    const { call, tasks, reached } = await setup();
    fakeTimers();
    const out = call({ command, timeout: 3_000 });
    await reached();
    vi.advanceTimersByTime(3_000);
    expect(await out).toBe("Command did not complete within its 3s timeout and was moved to the background as t1.");
    tasks.stop();
  });

  // Choice 9: Ctrl+B calls tasks.moveForeground(), which the tool's hold answers.
  it("moves the command to the background on Ctrl+B, saying the user moved it", async () => {
    const { call, started, tasks, reached } = await setup();
    fakeTimers();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    onTestFinished(() => void now.mockRestore());
    const out = call({ command: "npm run dev" });
    await reached();
    now.mockReturnValue(9_000);
    expect(tasks.moveForeground()).toBe(true);
    expect(await out).toBe("Moved to the background as t1 by the user.");
    expect([tasks.get("t1")!.state, started[0]!.run.stop.mock.calls.length, tasks.get("t1")!.started]).toEqual(["running", 0, 1_000]);
    expect([tasks.holding, tasks.moveForeground(), vi.getTimerCount()]).toEqual([undefined, false, 0]);
    tasks.stop();
  });

  // The design, "Where they show and how they stop": Esc leaves a background command running, a moved one too. The tool's
  // Esc listener goes with the move, so it is checked as well as what Esc does.
  it("leaves a moved command running when Esc comes after the move", async () => {
    const { call, started, tasks, reached } = await setup();
    const stop = new AbortController();
    const added = vi.spyOn(stop.signal, "addEventListener");
    const removed = vi.spyOn(stop.signal, "removeEventListener");
    const out = call({ command: "npm run dev" }, stop.signal);
    await reached();
    tasks.moveForeground();
    expect(await out).toBe("Moved to the background as t1 by the user.");
    const listener = (calls: unknown[][]) => calls.filter(([type]) => type === "abort").map(([, f]) => f);
    expect(listener(removed.mock.calls)).toEqual(listener(added.mock.calls).slice(-1)); // the tool's own, added last
    stop.abort();
    await new Promise((r) => setImmediate(r));
    expect([started[0]!.run.stop.mock.calls.length, tasks.get("t1")!.state]).toEqual([0, "running"]);
    tasks.stop();
  });

  // The design, "A command that runs long": what was printed before a move is not lost; the first shell_output gives it.
  it("keeps what the command printed before the move for the first read", async () => {
    const { call, use, started, tasks, reached } = await setup();
    fakeTimers();
    const out = call({ command: "npm test" });
    await reached();
    started[0]!.run.run.log.add("compiling\n");
    vi.advanceTimersByTime(120_000);
    await out;
    started[0]!.run.run.log.add("12 passed\n");
    expect(await use("shell_output", { id: "t1" })).toBe("t1 is still running.\ncompiling\n12 passed\n");
    tasks.stop();
  });

  it("stops the command on Esc and throws Cancelled, adopting nothing", async () => {
    const { call, started, tasks, reached } = await setup();
    fakeTimers();
    const stop = new AbortController();
    const out = call({ command: "npm test" }, stop.signal);
    await reached();
    stop.abort();
    await expect(out).rejects.toThrow("Cancelled");
    expect([started[0]!.run.stop.mock.calls.length, tasks.all, tasks.holding, vi.getTimerCount()]).toEqual([1, [], undefined, 0]);
  });

  // Release 7 plan, choice 87: an Esc whose kill cannot reach the box ends with the sandbox's failure, as exec did.
  it("ends with the run's failure when its stop on Esc fails", async () => {
    const { call, started, tasks, reached } = await setup();
    const stop = new AbortController();
    const out = call({ command: "npm test" }, stop.signal);
    await reached();
    const failure = "The sandbox stopped working: Esc could not reach the box (made up).";
    started[0]!.run.stop.mockImplementation(() => started[0]!.run.fail(new Error(failure)));
    stop.abort();
    await expect(out).rejects.toThrow(failure);
    expect([tasks.all, tasks.holding]).toEqual([[], undefined]);
  });

  it("starts nothing when the turn was stopped before the call", async () => {
    const { call, started } = await setup();
    const stop = new AbortController();
    stop.abort();
    await expect(call({ command: "npm test" }, stop.signal)).rejects.toThrow("Cancelled");
    await expect(call({ command: "npm test", background: true }, stop.signal)).rejects.toThrow("Cancelled");
    expect(started).toEqual([]);
  });
});

// Background commands plan, Task 6 and choices 7, 14 and 27: shell_output reads a command's output since the last read,
// with a first line for its state, and stop_task stops a command or a background subagent. Neither asks a question.
describe("shell_output", () => {
  it("gives a running command's output once, what is new since the last read or that nothing is, without a question", async () => {
    const { call, use, ctx, started, tasks } = await setup({ mode: "project", answers: [true] });
    await call({ command: "npm run dev", background: true });
    const { log } = started[0]!.run.run;
    expect(await use("shell_output", { id: "t1" })).toBe("t1 is still running.\nNo new output.");
    log.add("ready\n");
    expect(await use("shell_output", { id: "t1" })).toBe("t1 is still running.\nready\n");
    log.add("GET /\n");
    expect(await use("shell_output", { id: "t1" })).toBe("t1 is still running.\nGET /\n");
    expect(await use("shell_output", { id: "t1" })).toBe("t1 is still running.\nNo new output.");
    expect(ctx.asked).toEqual(["run in the background: npm run dev"]); // the start's question alone
    tasks.stop();
  });

  // Choice 7: the model read the end here, so the ending's message is not given at the next turn too.
  it("gives an ended command's exit line and the rest of its output, and the next turn says nothing of its end", async () => {
    const { call, use, started, tasks } = await setup();
    await call({ command: "npm test", background: true });
    const { run, end } = started[0]!.run;
    run.log.add("compiling\n");
    expect(await use("shell_output", { id: "t1" })).toBe("t1 is still running.\ncompiling\n");
    run.log.add("2 failed\n");
    end({ code: 1 });
    await tasks.get("t1")!.done;
    expect(tasks.wakes()).toBe(true);
    expect(await use("shell_output", { id: "t1" })).toBe("t1 ended with exit code 1.\n2 failed\n");
    expect([tasks.wakes(), tasks.take()]).toEqual([false, []]);
    expect(await use("shell_output", { id: "t1" })).toBe("t1 ended with exit code 1.\nNo new output.");
  });

  it("says a command was killed by a signal", async () => {
    const { call, use, started, tasks } = await setup();
    await call({ command: "npm run dev", background: true });
    started[0]!.run.end({ code: null, signal: "SIGTERM" });
    await tasks.get("t1")!.done;
    expect(await use("shell_output", { id: "t1" })).toBe("t1 was killed by SIGTERM.\nNo new output.");
    expect(tasks.take()).toEqual([]);
  });

  // Choice 28, the user's: the line says who stopped it, so the model hears of the stop once, with who did it.
  it("says who stopped a command, with what it printed before, and the next turn says nothing of the stop", async () => {
    const { call, use, started, tasks } = await setup();
    await call({ command: "npm run dev", background: true });
    await call({ command: "npm run watch", background: true });
    started[0]!.run.run.log.add("ready\n");
    tasks.stop("t1");
    await use("stop_task", { id: "t2" });
    expect(await use("shell_output", { id: "t1" })).toBe("t1 was stopped by the user.\nready\n");
    expect(await use("shell_output", { id: "t2" })).toBe("t2 was stopped by stop_task.\nNo new output.");
    expect(tasks.take()).toEqual([]);
  });

  // Task 6's choice (a): the task records a stop at the -p limit, so the read can tell it from any other stop.
  it("says a command was stopped at its -p time limit", async () => {
    const { call, use, started, tasks } = await setup({ headless: true, limits: { started: 600_000, moved: 600_000, most: 7_200_000 } });
    fakeTimers();
    await call({ command: "npm run e2e", background: true, timeout: 5_000 });
    started[0]!.run.run.log.add("3 passed\n");
    vi.advanceTimersByTime(5_000);
    expect(await use("shell_output", { id: "t1" })).toBe("t1 was stopped after reaching its background time limit.\n3 passed\n");
    expect(tasks.take()).toEqual([]);
  });

  // Task 6's choice (b): a run that failed (choice 23) says its error, cut as a command is in a first line (choice 24).
  it("says a command's run failed, with its error", async () => {
    const { call, use, started, tasks } = await setup();
    await call({ command: "npm run dev", background: true });
    await call({ command: "npm run watch", background: true });
    started[0]!.run.fail(new Error("spawn powershell.exe ENOENT"));
    started[1]!.run.fail(new Error(`${"x".repeat(1_000)}12345`));
    await Promise.all([tasks.get("t1")!.done, tasks.get("t2")!.done]);
    expect(await use("shell_output", { id: "t1" })).toBe("t1 failed: spawn powershell.exe ENOENT\nNo new output.");
    expect(await use("shell_output", { id: "t2" })).toBe(`t2 failed: ${"x".repeat(1_000)}… [+5 chars]\nNo new output.`);
    expect(tasks.take()).toEqual([]);
  });

  // Choice 14.
  it("answers a subagent's id and an id not in the list with their lines", async () => {
    const worker = new Held();
    const { use, tasks } = await setup({ worker });
    tasks.start("find x", { background: true });
    expect(await use("shell_output", { id: "t1" })).toBe("t1 is a subagent, not a command; its answer comes in a message.");
    expect(await use("shell_output", { id: "t9" })).toBe("No task t9.");
    tasks.stop();
  });
});

describe("stop_task", () => {
  it("stops a background command without a question, and the next turn says stop_task stopped it", async () => {
    const { call, use, ctx, started, tasks } = await setup({ mode: "project", answers: [true] });
    await call({ command: "npm run dev", background: true });
    expect(await use("stop_task", { id: "t1" })).toBe("Stopped t1.");
    expect([started[0]!.run.stop.mock.calls.length, tasks.get("t1")!.state]).toEqual([1, "stopped"]);
    expect(ctx.asked).toEqual(["run in the background: npm run dev"]); // the start's question alone
    expect(tasks.wakes()).toBe(false);
    expect(tasks.take()).toEqual(["Background command t1 (npm run dev) was stopped by stop_task."]);
    expect(await use("stop_task", { id: "t1" })).toBe("t1 is not running.");
  });

  // Choice 27, the user's: a subagent stop_task stopped says so, and a stop by the user keeps its words (tasks.test.ts).
  it("stops a background subagent in the middle of its request, whose answer and next-turn line say stop_task stopped it", async () => {
    const worker = new Held();
    const { use, tasks } = await setup({ worker });
    const t = tasks.start("find x", { background: true });
    await asked(worker, 1);
    expect(t.state).toBe("running");
    expect(await use("stop_task", { id: "t1" })).toBe("Stopped t1.");
    expect(await t.done).toEqual({ state: "stopped", text: "t1 was stopped by stop_task before it finished." });
    expect(tasks.wakes()).toBe(false);
    expect(tasks.take()).toEqual(["Background task t1 (find x) was stopped by stop_task before it finished."]);
    expect(await use("stop_task", { id: "t1" })).toBe("t1 is not running.");
  });

  it("stops a background subagent waiting for a place, and the one running keeps on", async () => {
    const worker = new Held();
    const { use, tasks } = await setup({ worker, max: 1 });
    const first = tasks.start("find x", { background: true });
    const second = tasks.start("find y", { background: true });
    await asked(worker, 1);
    expect([first.state, second.state]).toEqual(["running", "waiting"]);
    expect(await use("stop_task", { id: "t2" })).toBe("Stopped t2.");
    expect(await second.done).toEqual({ state: "stopped", text: "t2 was stopped by stop_task before it finished." });
    expect(tasks.take()).toEqual(["Background task t2 (find y) was stopped by stop_task before it finished."]);
    expect([first.state, worker.asked.length]).toEqual(["running", 1]);
    tasks.stop();
  });

  // The first stop's words stand: a subagent still ending after a user's stop is not running for stop_task.
  it("leaves a subagent the user stopped to the user's words, answering stop_task that it is not running", async () => {
    const worker = new Held();
    const { use, tasks } = await setup({ worker });
    const t = tasks.start("find x", { background: true });
    await asked(worker, 1);
    expect(tasks.stop("t1")).toBe(true);
    expect(t.state).toBe("running"); // still ending
    expect(await use("stop_task", { id: "t1" })).toBe("t1 is not running.");
    expect(await t.done).toEqual({ state: "stopped", text: "t1 was stopped by the user before it finished." });
    expect(tasks.take()).toEqual(["Background task t1 (find x) was stopped by the user before it finished."]);
  });

  it("answers an id not in the list", async () => {
    const { use } = await setup();
    expect(await use("stop_task", { id: "t9" })).toBe("No task t9.");
  });

  // User choice 36, PR #18 review: in the box the reply waits for the kill there.
  it("replies once a box command's kill has run, which is still running until then", async () => {
    const box = boxDriven();
    const { call, use, tasks } = await setup({ start: () => box.run });
    await call({ command: "npm run dev", background: true });
    const replied = use("stop_task", { id: "t1" });
    expect(await settled(replied)).toBe(false);
    expect(tasks.get("t1")!.state).toBe("running");
    expect(await use("shell_output", { id: "t1" })).toBe("t1 is still running.\nNo new output.");
    box.end({ code: null, signal: "SIGKILL" });
    expect(await replied).toBe("Stopped t1.");
    expect([tasks.get("t1")!.state, tasks.wakes()]).toEqual(["stopped", false]);
    expect(tasks.take()).toEqual(["Background command t1 (npm run dev) was stopped by stop_task."]);
    expect(await use("shell_output", { id: "t1" })).toBe("t1 was stopped by stop_task.\nNo new output.");
  });

  it("says a box command's kill that failed in its reply alone, the command failed with that error", async () => {
    const box = boxDriven();
    const { call, use, tasks } = await setup({ start: () => box.run });
    await call({ command: "npm run dev", background: true });
    const replied = use("stop_task", { id: "t1" });
    box.fail(new Error(`Esc could not reach the box (${"x".repeat(1_000)})`)); // cut as #failed cuts it
    const error = `Esc could not reach the box (${"x".repeat(971)}… [+30 chars]`;
    expect(await replied).toBe(`Could not stop t1: ${error}`);
    expect([tasks.get("t1")!.state, tasks.wakes(), tasks.take()]).toEqual(["failed", false, []]);
    expect(await use("shell_output", { id: "t1" })).toBe(`t1 failed: ${error}\nNo new output.`);
  });
});

// As the shell tool's command, an empty id is refused as invalid input.
it.each(["shell_output", "stop_task"])("%s refuses an empty id as invalid input", async (name) => {
  const { use } = await setup();
  await expect(use(name, { id: "" })).rejects.toBeInstanceOf(InvalidInput);
});

// The one real case: a node script that prints, then waits, moved by Ctrl+B once its line is in the log. The script
// records its pid, so the test stops it whatever happened.
describe("the shell tool on the host", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("moves a running command with what it printed so far in its log", async () => {
    const ctx = await tempContext();
    const source = `require("fs").writeFileSync("pid", String(process.pid)); console.log("before"); setTimeout(() => {}, 60000);`;
    await writeFile(path.join(ctx.root, "script.js"), source);
    const pidFile = path.join(ctx.root, "pid");
    onTestFinished(() => {
      const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
      if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
    });
    const local = new LocalExecutor();
    let run: Running | undefined;
    const executor: Executor = { exec: (...args) => local.exec(...args), start: (...args) => (run = local.start(...args)) };
    const tasks = new Tasks({ bus: new Bus(), max: 8, worker: () => new FakeProvider("w", []), system: "sub", tools: [], ctx: { ...ctx, executor } });
    onTestFinished(() => void tasks.stop());
    const [shell] = shellTools(tasks, { shell: "PowerShell", headless: false });
    const node = process.platform === "win32" ? `& "${process.execPath}"` : `"${process.execPath}"`;
    const out = shell!.run({ command: `${node} script.js` }, { ...ctx, executor });
    for (let i = 0; i < 200 && !run?.log.kept().includes("before"); i++) await new Promise((r) => setTimeout(r, 50));
    expect(tasks.moveForeground()).toBe(true);
    expect(await out).toBe("Moved to the background as t1 by the user.");
    const t = tasks.get("t1") as CommandTask;
    expect(t.run).toBe(run);
    expect(deliver("t1 is still running.", t.run.log, "t1")).toMatch(/^t1 is still running\.\nbefore\r?\n$/);
    expect(t.state).toBe("running");
  }, 15_000);
});
