import { z } from "zod";
import { shellFor } from "../exec/local.js";
import { defineTool } from "./tool.js";

export const shellTool = defineTool(
  "shell",
  `Run a command with ${shellFor().name} in the project root and return its output.`,
  z.object({ command: z.string().min(1) }),
  async ({ command }, ctx) => {
    await ctx.gate.require({ kind: "shell", outside: false, summary: `run: ${command}` });
    const r = await ctx.executor.exec(command, ctx.root, ctx.signal);
    const out = `exit code: ${r.code}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
    // A failing command is an error: the model sees it flagged, and it goes in the error log.
    if (r.code !== 0) throw new Error(out);
    return out;
  },
);
