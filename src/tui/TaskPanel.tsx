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

// The panel under the prompt (release 4 design, "On screen"): two lines for each subagent still on it,
// running ones first, then "+N more" in the last line when not all fit. What the model wrote is
// escaped, and a description is kept to its first line. `now` is the screen's clock, which may have
// last ticked just before a subagent started.
export function taskRows(tasks: Task[], rows: number, now: number): TaskRow[] {
  const on = tasks.filter((t) => t.shown);
  const ordered = [...on.filter(live), ...on.filter((t) => !live(t))];
  if (ordered.length * 2 <= rows) return ordered.flatMap((t) => taskRow(t, now));
  if (rows <= 0) return [];
  const fit = Math.floor((rows - 1) / 2);
  return [...ordered.slice(0, fit).flatMap((t) => taskRow(t, now)), { mark: " ", text: `+${ordered.length - fit} more`, color: "gray" }];
}

// One subagent's two lines, for the panel and for /tasks: its number and description, then under it
// its model, time, tokens and cost, and while it runs its latest tool call.
export function taskRow(t: Task, now: number): TaskRow[] {
  const head = { ...MARKS[t.state], text: `${t.id} ${visible(t.description.split(/\r?\n/)[0] ?? "")}` };
  const model = visible(t.model.slice(t.model.indexOf(":") + 1));
  if (t.state === "waiting") return [head, { mark: " ", text: `⎿ ${model} · waiting`, color: "gray" }];
  const tool = t.state === "running" && t.lastTool ? ` · ${visible([t.lastTool.name, brief(t.lastTool.name, t.lastTool.input)].filter(Boolean).join(" "))}` : "";
  return [head, { mark: " ", text: `⎿ ${model} · ${elapsed(Math.max(0, (t.ended ?? now) - t.started))} · ↓ ${k(t.output)} tokens · ${costText(t.model, t.cost, t.costUnknown)}${tool}`, color: "gray" }];
}

export function TaskPanel({ rows }: { rows: TaskRow[] }) {
  return rows.map((r, i) => (
    <Text key={i} wrap="truncate-end">
      <Text color={r.color}>{r.mark}</Text> {r.text}
    </Text>
  ));
}
