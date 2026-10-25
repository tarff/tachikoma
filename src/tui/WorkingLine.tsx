import { Text } from "ink";
import { costText, k } from "./StatusLine.js";

// cli-spinners' "dots", at its own 80 ms a frame (sindresorhus/cli-spinners, spinners.json, read
// 2026-10-25). Once a second looked stuck (the user, 2026-10-25).
const FRAMES = [..."⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"];
export const SPIN_MS = 80;

export interface Spend {
  lead: string;
  output: number;
  cost: number;
  costUnknown: boolean;
}

// How long something has run, in seconds, then minutes and seconds.
export function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// The line over the prompt while something runs (release 3 design, "On screen"): what it is, for how
// long, and for a turn its tokens and cost so far, which change after each model reply.
export function workingText(label: string, ms: number, spend: Spend | null): string {
  const time = elapsed(ms);
  const turn = spend ? ` · ↓ ${k(spend.output)} tokens · ${costText(spend.lead, spend.cost, spend.costUnknown)}` : "";
  return `${FRAMES[Math.floor(ms / SPIN_MS) % FRAMES.length]} ${label} · ${time}${turn} · Esc to stop`;
}

export function WorkingLine({ label, ms, spend }: { label: string; ms: number; spend: Spend | null }) {
  return <Text wrap="truncate-end">{workingText(label, ms, spend)}</Text>;
}
