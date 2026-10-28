import { Text } from "ink";
import { type Mode, visible } from "../core/permissions.js";

// The status line's parts, and `tools`, the line under it (release 3 design, "On screen"); `tasks`,
// how many subagents run (release 4 design, "On screen").
export type Segment = "lead" | "context" | "tokens" | "cost" | "mode" | "errors" | "project" | "time" | "tasks" | "tools";
export const SEGMENTS: Segment[] = ["lead", "context", "tokens", "cost", "mode", "errors", "project", "time", "tasks", "tools"];
export type LineSegment = Exclude<Segment, "tools">;

export interface StatusInfo {
  lead: string;
  context: number;
  contextWindow: number | null;
  input: number;
  output: number;
  cost: number;
  costUnknown: boolean;
  mode: Mode;
  errors: number;
  project: string; // the project folder's name
  branch: string | null; // the git branch; null outside a repository (see git.ts)
  elapsed: number; // ms since the session started
  running: number; // subagents running or waiting for a place
}

// The unit is picked after rounding, so 999,999 shows as 1.0M, not 1000.0k.
export const k = (n: number) => {
  if (n < 1000) return String(n);
  const thousands = (n / 1000).toFixed(1);
  return Number(thousands) < 1000 ? `${thousands}k` : `${(n / 1_000_000).toFixed(1)}M`;
};

// The share of the context window in use, rounded as "% left" is.
const used = (i: StatusInfo) => Math.round((100 * i.context) / i.contextWindow!);

// claude-hud's bar (`coloredBar` and `getContextColor` in its src/render/colors.ts, 0.0.4): ten cells,
// filled in proportion to the share used, green, then yellow from 70% used and red from 85%.
const BAR_CELLS = 10;
export function contextBar(usedPercent: number): { filled: number; color: "green" | "yellow" | "red" } {
  const filled = Math.min(BAR_CELLS, Math.max(0, Math.round((usedPercent / 100) * BAR_CELLS)));
  return { filled, color: usedPercent >= 85 ? "red" : usedPercent >= 70 ? "yellow" : "green" };
}

// How long the session has run, as claude-hud writes it (`formatSessionDuration`, its src/index.ts).
export function duration(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// The cost so far; the working line shows a turn's the same way.
export function costText(lead: string, cost: number, costUnknown: boolean): string {
  const dollars = `$${cost.toFixed(2)}${costUnknown ? " + ?" : ""}`;
  // A plan has no per-token price; OpenAI's guidelines ask apps to show that the plan is in use.
  if (!lead.startsWith("chatgpt:")) return dollars;
  if (cost) return `ChatGPT plan + ${dollars}`;
  return costUnknown ? "ChatGPT plan + ?" : "ChatGPT plan";
}

// A run of a part's text in one colour. Grey is `dim`, as claude-hud draws it (`dim` in its src/render/colors.ts, 0.0.4)
// and as the bar's empty cells are drawn below.
export interface Piece {
  text: string;
  color?: "cyan" | "green" | "yellow" | "red" | "magenta";
  dim?: boolean;
}

// The mode by risk, as claude-hud has no such part (release 5 design, "The status line's colours").
const MODE_COLOR: Record<Mode, Piece["color"]> = { ask: "green", project: "yellow", never: "red" };

// The one place each part's words and colours are written (release 5 design, "The status line's colours").
export function pieces(s: LineSegment, i: StatusInfo): Piece[] {
  switch (s) {
    case "lead":
      // Escaped as the folder and branch are below: the id comes from the command line or a provider's model list.
      return [{ text: "lead", dim: true }, { text: " " }, { text: visible(i.lead), color: "cyan" }];
    case "context": {
      // How much is left, as Codex shows it (main design, "Status line"), in the bar's colour, the bar saying what
      // the part is (the user's choice, 2026-10-27); the tokens in use when the window is not known.
      if (!i.contextWindow) return [{ text: "ctx", dim: true }, { text: ` ${k(i.context)}` }];
      const u = used(i);
      return [{ text: `${Math.max(0, 100 - u)}% left`, color: contextBar(u).color }];
    }
    case "tokens":
      return [{ text: `${k(i.input)} ` }, { text: "in", dim: true }, { text: ` / ${k(i.output)} ` }, { text: "out", dim: true }];
    case "cost":
      return [{ text: costText(i.lead, i.cost, i.costUnknown), color: "green" }];
    case "mode":
      return [{ text: "perm", dim: true }, { text: " " }, { text: i.mode, color: MODE_COLOR[i.mode] }];
    case "errors": {
      const text = `${i.errors} error${i.errors === 1 ? "" : "s"}`;
      return [i.errors > 0 ? { text, color: "red" } : { text, dim: true }];
    }
    case "project": {
      // Folder and branch names come from the disk, so they are escaped like everything else on screen.
      const folder: Piece = { text: visible(i.project), color: "yellow" };
      if (i.branch === null) return [folder];
      return [folder, { text: " " }, { text: "git:(", color: "magenta" }, { text: visible(i.branch), color: "cyan" }, { text: ")", color: "magenta" }];
    }
    case "time":
      return [{ text: `⏱ ${duration(i.elapsed)}`, dim: true }];
    case "tasks":
      return [{ text: `${i.running} running`, color: "yellow" }];
  }
}

// One line, cut at the end to the terminal's width (Ink measures it in columns) instead of wrapping.
// On the terminal's own background, its parts split by a grey ` | ` (release 5 design, "The status line's colours").
export function StatusLine({ info, segments }: { info: StatusInfo; segments: Segment[] }) {
  // `tasks` shows only while a subagent runs.
  const shown = segments.filter((s): s is LineSegment => s !== "tools" && (s !== "tasks" || info.running > 0));
  return (
    <Text wrap="truncate-end">
      {shown.map((s, n) => {
        const bar = s === "context" && info.contextWindow ? contextBar(used(info)) : null;
        return (
          <Text key={n}>
            {n === 0 ? " " : <Text dimColor> | </Text>}
            {bar && (
              <>
                <Text color={bar.color}>{"█".repeat(bar.filled)}</Text>
                <Text dimColor>{"░".repeat(BAR_CELLS - bar.filled)}</Text>{" "}
              </>
            )}
            {pieces(s, info).map((p, j) => (
              <Text key={j} color={p.color} dimColor={p.dim}>
                {p.text}
              </Text>
            ))}
            {n === shown.length - 1 ? " " : ""}
          </Text>
        );
      })}
    </Text>
  );
}
