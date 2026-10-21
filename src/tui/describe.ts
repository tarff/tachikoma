import type { Message } from "../core/types.js";

export interface Line {
  text: string;
  color?: string;
}

const firstLine = (s: string) => s.split("\n")[0] ?? "";
const fit = (s: string, width: number) => (s.length <= width ? s : `${s.slice(0, Math.max(0, width - 1))}…`);

// How one message appears in the scrollback.
export function describe(m: Message, width = process.stdout.columns ?? 80): Line[] {
  const lines: Line[] = [];
  for (const p of m.parts) {
    if (p.type === "text") lines.push(m.role === "user" ? { text: `> ${p.text}`, color: "cyan" } : { text: p.text });
    else if (p.type === "tool_call") lines.push({ text: fit(`● ${p.name} ${JSON.stringify(p.input)}`, width), color: "yellow" });
    else lines.push({ text: fit(`  ⎿ ${p.isError ? firstLine(p.output) : "ok"}`, width), color: p.isError ? "red" : "gray" });
  }
  return lines;
}
