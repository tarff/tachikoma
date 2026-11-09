import { z } from "zod";
import { shellFor } from "../exec/local.js";
import type { ExecResult } from "../exec/executor.js";
import { defineTool } from "./tool.js";

// What the model reads of a command's run, also rebuilt from a hook's Bash output (hooks/tools.ts, outputFrom).
export function shellText(r: ExecResult): string {
  const status = r.signal ? `killed by ${r.signal}` : `exit code: ${r.code}`;
  // stderr first: the session keeps only the start of a long result, and the errors matter most.
  return `${status}\n--- stderr ---\n${r.stderr}\n--- stdout ---\n${r.stdout}`;
}

// The shell tool for the shell its commands run in: the host's (shellFor), or bash in the box (release 7 plan, Task 16).
export const shellToolOf = (shell: string) =>
  defineTool(
    "shell",
    `Run a command with ${shell} in the project root and return its output.`,
    z.object({ command: z.string().min(1) }),
    async ({ command }, ctx) => {
      // The command goes to the gate, whose dangerous-command check reads it (release 7 plan, Task 8).
      await ctx.gate.require({ kind: "shell", outside: false, summary: `run: ${command}`, command }, ctx.signal);
      const r = await ctx.executor.exec(command, ctx.root, ctx.signal);
      ctx.report?.({ stdout: r.stdout, stderr: r.stderr, code: r.code });
      const out = shellText(r);
      // A failing command is an error: the model sees it flagged, and it goes in the error log.
      if (r.code !== 0) throw new Error(out);
      return out;
    },
  );

export const shellTool = shellToolOf(shellFor().name);
