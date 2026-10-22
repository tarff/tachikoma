import { visible } from "../core/permissions.js";
import type { Message } from "../core/types.js";

export interface Line {
  text: string;
  color?: string;
  oneLine?: boolean; // shown on one line, cut to the screen's width (App.tsx)
}

const firstLine = (s: string) => s.split(/\r?\n/)[0] ?? "";

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
    else if (p.type === "tool_call") lines.push({ text: `● ${p.name} ${JSON.stringify(p.input)}`, color: "yellow", oneLine: true });
    else if (p.type === "tool_result") lines.push({ text: `  ⎿ ${p.isError ? firstLine(p.output) : "ok"}`, color: p.isError ? "red" : "gray", oneLine: true });
    else {
      const _: never = p; // a new kind of part must be given its own line here
    }
  }
  return lines;
}
