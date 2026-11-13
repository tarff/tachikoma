import { Text } from "ink";
import { visible } from "../core/permissions.js";
import type { CommandTask, Task, TaskState } from "../core/tasks.js";
import { brief, type McpNames, shownName } from "./describe.js";
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

// The panel under the prompt (release 4 design, "On screen"): two lines for each subagent or command still on it,
// running ones first, then "+N more" in the last line when not all fit. What the model wrote is
// escaped, and a description or command is kept to its first line. `now` is the screen's clock, which may have
// last ticked just before a subagent started. `names`: an MCP call's server and tool (describe.ts; choice 68).
export function taskRows(tasks: Task[], rows: number, now: number, names?: McpNames): TaskRow[] {
  const on = tasks.filter((t) => t.shown);
  const ordered = [...on.filter(live), ...on.filter((t) => !live(t))];
  if (ordered.length * 2 <= rows) return ordered.flatMap((t) => taskRow(t, now, names));
  if (rows <= 0) return [];
  const fit = Math.floor((rows - 1) / 2);
  return [...ordered.slice(0, fit).flatMap((t) => taskRow(t, now, names)), { mark: " ", text: `+${ordered.length - fit} more`, color: "gray" }];
}

// One subagent's or command's two lines, for the panel and for /tasks: its number and description, then under it
// its model, time, tokens and cost, and while it runs its latest tool call, an MCP call's by its server and tool as the
// server gives them (release 8c plan, Task 18; choice 68).
export function taskRow(t: Task, now: number, names?: McpNames): TaskRow[] {
  if (t.kind === "command") return commandRow(t, now);
  const head = { ...MARKS[t.state], text: `${t.id} ${visible(t.description.split(/\r?\n/)[0] ?? "")}` };
  const model = visible(t.model.slice(t.model.indexOf(":") + 1));
  if (t.state === "waiting") return [head, { mark: " ", text: `⎿ ${model} · waiting`, color: "gray" }];
  const tool = t.state === "running" && t.lastTool ? ` · ${visible([shownName(t.lastTool.name, names), brief(t.lastTool.name, t.lastTool.input)].filter(Boolean).join(" "))}` : "";
  return [head, { mark: " ", text: `⎿ ${model} · ${elapsed(Math.max(0, (t.ended ?? now) - t.started))} · ↓ ${k(t.output)} tokens · ${costText(t.model, t.cost, t.costUnknown)}${tool}`, color: "gray" }];
}

// A command's (background commands plan, choice 18): its number and first line, then `shell`, its exit code once it
// ended with one, and its time. One stopped, killed or whose run failed has no code, and its mark says how it ended.
function commandRow(t: CommandTask, now: number): TaskRow[] {
  const code = typeof t.code === "number" ? ` · exit code ${t.code}` : "";
  return [
    { ...MARKS[t.state], text: `${t.id} ${visible(t.command.split(/\r?\n/)[0] ?? "")}` },
    { mark: " ", text: `⎿ shell${code} · ${elapsed(Math.max(0, (t.ended ?? now) - t.started))}`, color: "gray" },
  ];
}

export function TaskPanel({ rows }: { rows: TaskRow[] }) {
  return rows.map((r, i) => (
    <Text key={i} wrap="truncate-end">
      <Text color={r.color}>{r.mark}</Text> {r.text}
    </Text>
  ));
}
