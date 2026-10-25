import { z } from "zod";
import { defineTool, type Tool } from "./tool.js";

const STATUSES = ["pending", "in_progress", "done"] as const;
export type TodoStatus = (typeof STATUSES)[number];
export interface TodoItem {
  text: string;
  status: TodoStatus;
}

// The lead's to-do list (release 4 design, "The to-do list"): the whole list each time, as Claude
// Code's TodoWrite takes it, so a new list replaces the old one. `show` puts it on screen. One item in
// progress at a time is asked for, not enforced.
export function todoTool(show: (items: TodoItem[]) => void): Tool {
  return defineTool(
    "todo",
    "Keep a to-do list the user sees, for work with several steps. Send the whole list each time; it replaces the last one. Keep one item in_progress at a time, and mark each done as soon as it is.",
    z.object({ items: z.array(z.object({ text: z.string().min(1), status: z.enum(STATUSES) })) }),
    async ({ items }) => {
      show(items);
      return `Saved ${items.length} items, ${items.filter((i) => i.status !== "done").length} not done`;
    },
  );
}
