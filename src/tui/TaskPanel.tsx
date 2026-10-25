import { Text } from "ink";
import { visible } from "../core/permissions.js";
import type { Task, TaskState } from "../core/tasks.js";
import { brief } from "./describe.js";
import { costText, k } from "./StatusLine.js";
import { elapsed } from "./WorkingLine.js";

export interface TaskRow {
  mark: string;
  text: string;
  color: "yellow" | "green" | "red" | "gray";
}

// The tool line's marks (ToolLine.tsx), and a grey one for a subagent waiting for a place.
const MARKS: Record<TaskState, Omit<TaskRow, "text">> = {
  waiting: { mark: "◐", color: "gray" },
  running: { mark: "◐", color: "yellow" },
  done: { mark: "✓", color: "green" },
  failed: { mark: "✗", color: "red" },
  stopped: { mark: "⊘", color: "gray" },
};

const live = (t: Task) => t.state === "running" || t.state === "waiting";

// The panel under the prompt (release 4 design, "On screen"): a row for each subagent still on it,
// running ones first, then "+N more" in the last row when not all fit. A running row ends with its
// latest tool call. What the model wrote is escaped, and a task is kept to its first line. `now` is
// the screen's clock, which may have last ticked just before a subagent started.
export function taskRows(tasks: Task[], rows: number, now: number): TaskRow[] {
  const on = tasks.filter((t) => t.shown);
  const ordered = [...on.filter(live), ...on.filter((t) => !live(t))];
  const row = (t: Task): TaskRow => {
    const head = `${t.id} ${visible(t.task.split(/\r?\n/)[0] ?? "")} · ${visible(t.model.slice(t.model.indexOf(":") + 1))}`;
    if (t.state === "waiting") return { ...MARKS.waiting, text: `${head} · waiting` };
    const tool = t.state === "running" && t.lastTool ? ` · ${visible([t.lastTool.name, brief(t.lastTool.name, t.lastTool.input)].filter(Boolean).join(" "))}` : "";
    return { ...MARKS[t.state], text: `${head} · ${elapsed(Math.max(0, (t.ended ?? now) - t.started))} · ↓ ${k(t.output)} tokens · ${costText(t.model, t.cost, t.costUnknown)}${tool}` };
  };
  if (ordered.length <= rows) return ordered.map(row);
  if (rows <= 0) return [];
  return [...ordered.slice(0, rows - 1).map(row), { mark: " ", text: `+${ordered.length - rows + 1} more`, color: "gray" }];
}

export function TaskPanel({ rows }: { rows: TaskRow[] }) {
  return rows.map((r, i) => (
    <Text key={i} wrap="truncate-end">
      <Text color={r.color}>{r.mark}</Text> {r.text}
    </Text>
  ));
}
