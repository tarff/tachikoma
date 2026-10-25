import { visible } from "../core/permissions.js";
import type { Message } from "../core/types.js";

export interface Line {
  text: string;
  color?: string;
  oneLine?: boolean; // shown on one line, cut to the screen's width (App.tsx)
}

const firstLine = (s: string) => s.split(/\r?\n/)[0] ?? "";

// A call's main detail (release 3 design, "On screen"): the path for the file tools, the command's
// first line for shell, the pattern for the search tools; null for a tool without its own summary,
// which is shown with its whole input.
const DETAIL: Record<string, string> = { read_file: "path", write_file: "path", edit_file: "path", shell: "command", find_files: "pattern" };
export function brief(name: string, input: unknown): string | null {
  const value = Object.hasOwn(DETAIL, name) && typeof input === "object" && input !== null ? (input as Record<string, unknown>)[DETAIL[name]!] : undefined;
  return typeof value === "string" ? firstLine(value) : null;
}

// Every scrollback line passes through here. Model and provider text can carry escape codes (OSC 52
// writes the clipboard), \r and bidi overrides, which the terminal would act on. Prose keeps its line
// breaks and tabs. A one-line entry has its line breaks escaped too; the screen cuts it after this, by
// terminal columns, so the escapes and wide characters count toward the width.
export function screen(l: Line): Line {
  const text = l.oneLine ? visible(l.text) : l.text.split(/\r?\n/).map((s) => visible(s, { tabs: true })).join("\n");
  return { text, ...(l.color === undefined ? {} : { color: l.color }), ...(l.oneLine ? { oneLine: true } : {}) };
}

// How one message appears in the scrollback.
export function describe(m: Message): Line[] {
  const lines: Line[] = [];
  for (const p of m.parts) {
    if (p.type === "text") lines.push(m.role === "user" ? { text: `> ${p.text}`, color: "cyan" } : { text: p.text });
    else if (p.type === "tool_call") lines.push({ text: `● ${p.name} ${brief(p.name, p.input) ?? JSON.stringify(p.input)}`, color: "yellow", oneLine: true });
    else if (p.type === "tool_result") lines.push({ text: `  ⎿ ${p.isError ? firstLine(p.output) : "ok"}`, color: p.isError ? "red" : "gray", oneLine: true });
    else {
      const _: never = p; // a new kind of part must be given its own line here
    }
  }
  return lines;
}

// Ctrl+O: every tool call of the latest turn, from its prompt on, with its full input and result,
// under a heading. A call of a turn still running may have no result yet.
export function lastTurn(messages: Message[]): Line[] {
  const start = messages.findLastIndex((m) => m.role === "user" && m.parts.some((p) => p.type === "text"));
  if (start === -1) return [{ text: "No turn yet, so no tool calls to show.", color: "gray" }];
  const parts = messages.slice(start).flatMap((m) => m.parts);
  const calls = parts.filter((p) => p.type === "tool_call");
  const results = new Map(parts.flatMap((p) => (p.type === "tool_result" ? [[p.callId, p.output] as const] : [])));
  return [
    { text: `Last turn: ${calls.length} tool call${calls.length === 1 ? "" : "s"}`, color: "gray" },
    ...calls.map((c) => ({ text: `● ${c.name} ${JSON.stringify(c.input, null, 2)}\n  ⎿ ${results.get(c.id) ?? "(not finished)"}`, color: "gray" })),
  ];
}
