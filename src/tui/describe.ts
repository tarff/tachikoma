import { visible } from "../core/permissions.js";
import type { Message } from "../core/types.js";
import { marker } from "./pictures.js";

export interface Line {
  text: string;
  color?: string;
  oneLine?: boolean; // shown on one line, cut to the screen's width (App.tsx)
}

const firstLine = (s: string) => s.split(/\r?\n/)[0] ?? "";

// A call's main detail (release 3 design, "On screen"): the path for the file tools, the command's
// first line for shell, the pattern for the search tools, the description for delegate; null for a
// tool without its own summary, which is shown with its whole input.
const DETAIL: Record<string, string> = { read_file: "path", write_file: "path", edit_file: "path", shell: "command", find_files: "pattern", search_files: "pattern", delegate: "description" };
export function brief(name: string, input: unknown): string | null {
  const items = name === "todo" && typeof input === "object" && input !== null ? (input as { items?: unknown }).items : undefined;
  if (Array.isArray(items)) return `${items.length} item${items.length === 1 ? "" : "s"}`; // the list itself is on screen
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
  let typed: Line | null = null; // the user's prompt so far, its text and pictures one line
  let picture = false; // the last part put in it was a picture
  for (const p of m.parts) {
    if (p.type === "text" && p.from === "tasks") continue; // shown when it arrived, as "t3 finished"
    // A picture is its marker in its place, in the line's colour (release 6 plan, choice 22). Two next to each other
    // get a space between, as the blanks between them were left out of the message (pictures.ts, messageParts).
    if (p.type === "text" || p.type === "image") {
      const text = p.type === "image" ? `${picture ? " " : ""}${marker(p.id)}` : p.text;
      picture = p.type === "image";
      if (m.role !== "user") lines.push({ text });
      else if (typed) typed.text += text;
      else lines.push((typed = { text: `> ${text}`, color: "cyan" }));
    } else if (p.type === "tool_call")
      lines.push({ text: `● ${p.name} ${brief(p.name, p.input) ?? JSON.stringify(p.input)}`, color: "yellow", oneLine: true });
    else if (p.type === "tool_result") lines.push({ text: `  ⎿ ${p.isError ? firstLine(p.output) : "ok"}`, color: p.isError ? "red" : "gray", oneLine: true });
    else {
      const _: never = p; // a new kind of part must be given its own line here
    }
  }
  return lines;
}

// Ctrl+O: every tool call of the latest turn, from its prompt on, with its full input and result,
// under a heading. A call of a turn still running may have no result yet. A turn starts with a user
// message that is not tool results: a prompt, or background answers alone.
export function lastTurn(messages: Message[]): Line[] {
  const start = messages.findLastIndex((m) => m.role === "user" && !m.parts.some((p) => p.type === "tool_result"));
  if (start === -1) return [{ text: "No turn yet, so no tool calls to show.", color: "gray" }];
  const calls = callLines(messages.slice(start));
  return [{ text: `Last turn: ${calls.length} tool call${calls.length === 1 ? "" : "s"}`, color: "gray" }, ...calls];
}

// Each tool call in `messages`, with its full input and result, grey: for Ctrl+O and `/tasks t3`.
export function callLines(messages: Message[]): Line[] {
  const parts = messages.flatMap((m) => m.parts);
  const results = new Map(parts.flatMap((p) => (p.type === "tool_result" ? [[p.callId, p.output] as const] : [])));
  return parts.flatMap((c) => (c.type === "tool_call" ? [{ text: `● ${c.name} ${JSON.stringify(c.input, null, 2)}\n  ⎿ ${results.get(c.id) ?? "(not finished)"}`, color: "gray" }] : []));
}
