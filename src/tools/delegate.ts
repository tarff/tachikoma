import { z } from "zod";
import type { Tasks } from "../core/tasks.js";
import { defineTool, type Tool } from "./tool.js";

// The lead's delegate tool (release 4 design, "Subagents and the delegate tool"). Several calls in one
// reply start together. With -p there is no later turn, so a background task runs in the foreground.
export function delegateTool(tasks: Tasks, opts: { headless: boolean }): Tool {
  const tool = defineTool(
    "delegate",
    "Hand a search or reading task to a subagent, which has read_file, find_files and search_files and reports what it found with file paths and line numbers. Write the task for someone who has not seen this conversation. Several delegate calls in one reply run at the same time. With background: true the call returns at once and the answer comes in a later message; otherwise it waits for the answer.",
    z.object({ task: z.string().min(1), background: z.boolean().optional() }),
    async ({ task, background = false }, ctx) => {
      if (background && !opts.headless) return `Started ${tasks.start(task, { background: true }).id} in the background; its answer will come in a later message.`;
      const t = tasks.start(task, { background: false, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      const r = await t.done;
      // A failure is the answer too, so the lead knows; the error itself is logged as the subagent's.
      const answer = r.state === "failed" ? `${t.id} failed: ${r.text}` : r.text;
      return background ? `${t.id} ran in the foreground, since -p has no later turn to read a background answer in.\n\n${answer}` : answer;
    },
  );
  return { ...tool, parallel: true };
}
