import { visible } from "../core/permissions.js";
import type { Message } from "../core/types.js";

export interface Line {
  text: string;
  color?: string;
  width?: number; // set for one-line entries: cut to this width once escaped
}

const firstLine = (s: string) => s.split(/\r?\n/)[0] ?? "";
const fit = (s: string, width: number) => (s.length <= width ? s : `${s.slice(0, Math.max(0, width - 1))}…`);

// Every scrollback line passes through here. Model and provider text can carry escape codes (OSC 52
// writes the clipboard), \r and bidi overrides, which the terminal would act on. Prose keeps its line
// breaks and tabs; one-line entries are cut after escaping, so the escapes count toward the width.
export function screen(l: Line): Line {
  const text = l.width === undefined ? l.text.split(/\r?\n/).map((s) => visible(s, { tabs: true })).join("\n") : fit(visible(l.text), l.width);
  return l.color === undefined ? { text } : { text, color: l.color };
}

// How one message appears in the scrollback.
export function describe(m: Message, width = process.stdout.columns ?? 80): Line[] {
  const lines: Line[] = [];
  for (const p of m.parts) {
    if (p.type === "text") lines.push(m.role === "user" ? { text: `> ${p.text}`, color: "cyan" } : { text: p.text });
    else if (p.type === "tool_call") lines.push({ text: `● ${p.name} ${JSON.stringify(p.input)}`, color: "yellow", width });
    else if (p.type === "tool_result") lines.push({ text: `  ⎿ ${p.isError ? firstLine(p.output) : "ok"}`, color: p.isError ? "red" : "gray", width });
    else {
      const _: never = p; // a new kind of part must be given its own line here
    }
  }
  return lines;
}
