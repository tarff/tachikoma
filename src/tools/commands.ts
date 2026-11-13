import { z } from "zod";
import type { CommandTask, Tasks } from "../core/tasks.js";
import type { ExecResult, Running } from "../exec/executor.js";
import { deliver } from "../exec/log.js";
import { shellText } from "./shell.js";
import { defineTool, type Tool, type ToolContext } from "./tool.js";

// Claude Code's tools reference, "Timeout and output limits": two minutes when no timeout is given, ten at most, and a
// timeout is cut to that rather than refused (background commands plan, "Numbers in this plan").
const DEFAULT_TIMEOUT = 120_000;
const MOST_FOREGROUND = 600_000;
// The most a timeout can ask for at all, a -p background limit's most: "up to a maximum of 2 hours" (the same page).
export const MOST_TIMEOUT = 7_200_000;
// Under -p, a background start's limit when no timeout is given, and a moved command's from the move: for a -p run given
// its prompt as text "both defaults are 10 minutes" (the same page, "Time limit for background commands").
export const HEADLESS_LIMIT = 600_000;

// Choice 12: a model that sleeps is waiting on purpose, so its command stops at its timeout instead of moving. The first
// word is read after leading spaces, up to a space or `;`: `sleep` or PowerShell's Start-Sleep, in any letter case, as
// PowerShell takes `sleep` as Start-Sleep and ignores letter case in both.
const sleeps = (command: string) => {
  const first = /^\s*([^\s;]*)/.exec(command)![1]!.toLowerCase();
  return first === "sleep" || first === "start-sleep";
};

// How a foreground command's wait ended (firstOf).
type Way = { end: ExecResult } | "cancelled" | "timeout" | "moved";

// The shell tool for the shell its commands run in: the host's (shellFor), or bash in the box (release 7 plan, Task 16).
// A foreground command runs until its end, Esc, its timeout or Ctrl+B; a background one joins the task list at once
// (background commands design, "What the model gets", "A command that runs long"; plan, choices 10-13). shell_output
// and stop_task come with it (Task 6).
export function shellTools(tasks: Tasks, opts: { shell: string; headless: boolean }): Tool[] {
  const shell = defineTool(
    "shell",
    `Run a command with ${opts.shell} in the project root and return its output. ` +
      'A command still running after "timeout" milliseconds (120000 when not given, at most 600000) moves to the background, unless it starts with sleep. ' +
      'With "background": true it starts in the background at once, for a dev server, a watch build or a long test run; ' +
      "read its output with shell_output and stop it with stop_task. You are told when a background command ends.",
    z.object({ command: z.string().min(1), background: z.boolean().optional(), timeout: z.number().int().min(1).max(MOST_TIMEOUT).optional() }),
    async ({ command, background = false, timeout }, ctx) => {
      if (!background) return foreground(command, Math.min(timeout ?? DEFAULT_TIMEOUT, MOST_FOREGROUND), ctx);
      // Choice 13: the question says it, so the user, the judge and auto mode see it; the dangerous-command check reads
      // the command as for any other (release 7 plan, Task 8).
      await ctx.gate.require({ kind: "shell", outside: false, summary: `run in the background: ${command}`, command }, ctx.signal);
      if (ctx.signal?.aborted) throw new Error("Cancelled");
      // A window's background command has no time limit; under -p its timeout is its limit (design, "What the model gets").
      const t = tasks.adopt(ctx.executor.start(command, ctx.root), { command, ...(opts.headless && timeout !== undefined ? { limit: timeout } : {}) });
      return `Started ${t.id} in the background.`;
    },
  );

  async function foreground(command: string, ms: number, ctx: ToolContext): Promise<string> {
    // The command goes to the gate, whose dangerous-command check reads it (release 7 plan, Task 8).
    await ctx.gate.require({ kind: "shell", outside: false, summary: `run: ${command}`, command }, ctx.signal);
    if (ctx.signal?.aborted) throw new Error("Cancelled");
    const started = Date.now();
    const run = ctx.executor.start(command, ctx.root);
    const way = await firstOf(run, ms, ctx.signal);
    // A stop's end is awaited, as exec awaited it: the box's comes once its kill has run there, and an Esc that cannot
    // reach the box rejects with the sandbox's failure, not Cancelled (release 7 plan, choice 87).
    if (way === "cancelled") {
      run.stop();
      await run.done;
      throw new Error("Cancelled");
    }
    // The timeout that applied, in whole seconds.
    const s = Math.ceil(ms / 1000);
    if (way === "timeout" && sleeps(command)) {
      run.stop();
      await run.done;
      throw new Error(
        `Stopped: the command did not complete within its ${s}s timeout. ` +
          "A command that starts with sleep is stopped at its timeout, not moved to the background.",
      );
    }
    if (way === "timeout" || way === "moved") {
      // What it printed so far stays in its log, unread, so the first shell_output gives it (design, "A command that runs long").
      const { id } = tasks.adopt(run, { command, moved: true, started });
      if (way === "moved") return `Moved to the background as ${id} by the user.`;
      return `Command did not complete within its ${s}s timeout and was moved to the background as ${id}.`;
    }
    const r = way.end;
    ctx.report?.({ stdout: r.stdout, stderr: r.stderr, code: r.code });
    const out = shellText(r);
    // A failing command is an error: the model sees it flagged, and it goes in the error log.
    if (r.code !== 0) throw new Error(out);
    return out;
  }

  // The first of the command's end, Esc, the timeout and Ctrl+B (choice 9's hold, which tasks.moveForeground() calls).
  // A run that fails rejects with its error, as exec did. The timer, the listener and the hold go on every way out.
  function firstOf(run: Running, ms: number, signal: AbortSignal | undefined): Promise<Way> {
    let timer: NodeJS.Timeout | undefined;
    let onAbort = () => {};
    const hold = { move: () => {} };
    return new Promise<Way>((resolve, reject) => {
      run.done.then((end) => resolve({ end }), reject);
      onAbort = () => resolve("cancelled");
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) resolve("cancelled"); // stopped during start, before the listener was there (sandbox/executor.ts, exec)
      timer = setTimeout(() => resolve("timeout"), ms);
      hold.move = () => resolve("moved");
      tasks.holding = hold;
    }).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (tasks.holding === hold) tasks.holding = undefined;
    });
  }

  // No question: it only reads (design, "What the model gets"). An ended command's entry goes, as the model has its end
  // here, so it is not told twice (choice 7); a subagent's id and an unknown one get their own lines (choice 14).
  const shellOutput = defineTool(
    "shell_output",
    "Read what a background command has printed since you last read it, and whether it has ended. Give its id, such as t4.",
    z.object({ id: z.string().min(1) }),
    async ({ id }) => {
      const t = tasks.get(id);
      if (!t) return `No task ${id}.`;
      if (t.kind === "subagent") return `${id} is a subagent, not a command; its answer comes in a message.`;
      if (t.state !== "running") tasks.told(id);
      return deliver(firstLine(t), t.run.log, id);
    },
  );

  // No question (background commands plan, Task 6); a stop by the model is said so at the next turn (choices 7, 27).
  const stopTask = defineTool(
    "stop_task",
    "Stop a background command or a background subagent by its id, such as t4.",
    z.object({ id: z.string().min(1) }),
    async ({ id }) => {
      if (!tasks.get(id)) return `No task ${id}.`;
      return tasks.stop(id, "tool") ? `Stopped ${id}.` : `${id} is not running.`;
    },
  );

  return [shell, shellOutput, stopTask];
}

// shell_output's first line, by the command's state ("Lines this plan adds"). A failed run's line follows choice 23's
// ending line (background commands plan, Task 6); a stop names who stopped it (choice 28, the user's). /tasks t4's record
// says an ended command's end in it too (choice 31, the user's).
export function firstLine(t: CommandTask): string {
  if (t.state === "running") return `${t.id} is still running.`;
  if (t.stoppedBy === "limit") return `${t.id} was stopped after reaching its background time limit.`;
  if (t.stoppedBy) return `${t.id} was stopped by ${t.stoppedBy === "user" ? "the user" : "stop_task"}.`;
  if (t.error !== undefined) return `${t.id} failed: ${t.error}`;
  return t.code !== null ? `${t.id} ended with exit code ${t.code}.` : `${t.id} was killed by ${t.signal}.`;
}
