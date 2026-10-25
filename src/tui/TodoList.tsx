import { Text } from "ink";
import { visible } from "../core/permissions.js";
import type { TodoItem, TodoStatus } from "../tools/todo.js";

export interface TodoRow {
  mark: string;
  text: string;
  color?: "yellow" | "gray";
}

const MARKS: Record<TodoStatus, Omit<TodoRow, "text">> = {
  pending: { mark: "☐" },
  in_progress: { mark: "◐", color: "yellow" },
  done: { mark: "☑", color: "gray" },
};

// The list shows while any item is not done (release 4 design, "On screen").
export const unfinished = (items: TodoItem[]) => items.some((i) => i.status !== "done");

// The rows the list takes when it has `rows`: all of it when it fits. When not, the item in progress
// (or the first not done) and those next to it, then "+N more" in the last row. Items come from the
// model, so they are escaped.
export function todoRows(items: TodoItem[], rows: number): TodoRow[] {
  const row = (i: TodoItem): TodoRow => ({ ...MARKS[i.status], text: visible(i.text) });
  if (items.length <= rows) return items.map(row);
  if (rows <= 0) return [];
  const shown = Math.max(1, rows - 1);
  const doing = items.findIndex((i) => i.status === "in_progress");
  const at = Math.max(0, doing === -1 ? items.findIndex((i) => i.status !== "done") : doing);
  const start = Math.max(0, Math.min(at - Math.floor(shown / 2), items.length - shown));
  const more: TodoRow[] = rows > 1 ? [{ mark: "", text: `+${items.length - shown} more`, color: "gray" }] : [];
  return [...items.slice(start, start + shown).map(row), ...more];
}

export function TodoList({ rows }: { rows: TodoRow[] }) {
  return rows.map((r, i) => (
    <Text key={i} color={r.color} wrap="truncate-end">
      {r.mark ? `${r.mark} ${r.text}` : r.text}
    </Text>
  ));
}
