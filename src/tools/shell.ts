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
    const status = r.signal ? `killed by ${r.signal}` : `exit code: ${r.code}`;
    // stderr first: the session keeps only the start of a long result, and the errors matter most.
    const out = `${status}\n--- stderr ---\n${r.stderr}\n--- stdout ---\n${r.stdout}`;
    // A failing command is an error: the model sees it flagged, and it goes in the error log.
    if (r.code !== 0) throw new Error(out);
    return out;
  },
);
