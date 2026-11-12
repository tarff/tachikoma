import { z } from "zod";
import type { Tasks } from "../core/tasks.js";
import type { ExecResult, Running } from "../exec/executor.js";
import { shellText } from "./shell.js";
import { defineTool, type Tool, type ToolContext } from "./tool.js";

// Claude Code's tools reference, "Timeout and output limits": two minutes when no timeout is given, ten at most, and a
// timeout is cut to that rather than refused (background commands plan, "Numbers in this plan").
const DEFAULT_TIMEOUT = 120_000;
const MOST_FOREGROUND = 600_000;
// The most a timeout can ask for at all, a -p background limit's most: "up to a maximum of 2 hours" (the same page).
const MOST_TIMEOUT = 7_200_000;

// Choice 12: a model that sleeps is waiting on purpose, so its command stops at its timeout instead of moving. The first
// word is read after leading spaces, up to a space or `;`: `sleep` in any shell, or PowerShell's Start-Sleep, whose
// names take any letter case.
const sleeps = (command: string) => {
  const first = /^\s*([^\s;]*)/.exec(command)![1]!;
  return first === "sleep" || first.toLowerCase() === "start-sleep";
};

// The shell tool for the shell its commands run in: the host's (shellFor), or bash in the box (release 7 plan, Task 16).
// A foreground command runs until its end, Esc, its timeout or Ctrl+B; a background one joins the task list at once
// (background commands design, "What the model gets", "A command that runs long"; plan, choices 10-13). Task 6 adds
// shell_output and stop_task here.
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
      const { id } = tasks.adopt(run, { command, moved: true });
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
  function firstOf(run: Running, ms: number, signal: AbortSignal | undefined): Promise<{ end: ExecResult } | "cancelled" | "timeout" | "moved"> {
    let timer: NodeJS.Timeout | undefined;
    let onAbort = () => {};
    const hold = { move: () => {} };
    return new Promise<{ end: ExecResult } | "cancelled" | "timeout" | "moved">((resolve, reject) => {
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

  return [shell];
}
