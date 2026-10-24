import { Text } from "ink";
import { visible } from "../core/permissions.js";

export type Segment = "lead" | "context" | "tokens" | "cost" | "mode" | "errors" | "project" | "time";
export const SEGMENTS: Segment[] = ["lead", "context", "tokens", "cost", "mode", "errors", "project", "time"];

export interface StatusInfo {
  lead: string;
  context: number;
  contextWindow: number | null;
  input: number;
  output: number;
  cost: number;
  costUnknown: boolean;
  mode: string;
  errors: number;
  project: string; // the project folder's name
  branch: string | null; // the git branch; null outside a repository (see git.ts)
  elapsed: number; // ms since the session started
}

// The unit is picked after rounding, so 999,999 shows as 1.0M, not 1000.0k.
const k = (n: number) => {
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

export function formatSegment(s: Segment, i: StatusInfo): string {
  switch (s) {
    case "lead":
      return `lead ${i.lead}`;
    case "context":
      // How much is left, as Codex shows it (main design, "Status line"); the tokens in use when the
      // window is not known.
      return i.contextWindow ? `ctx ${Math.max(0, 100 - used(i))}% left` : `ctx ${k(i.context)}`;
    case "tokens":
      return `${k(i.input)} in / ${k(i.output)} out`;
    case "cost": {
      const dollars = `$${i.cost.toFixed(2)}${i.costUnknown ? " + ?" : ""}`;
      // A plan has no per-token price; OpenAI's guidelines ask apps to show that the plan is in use.
      if (!i.lead.startsWith("chatgpt:")) return dollars;
      if (i.cost) return `ChatGPT plan + ${dollars}`;
      return i.costUnknown ? "ChatGPT plan + ?" : "ChatGPT plan";
    }
    case "mode":
      return `perm ${i.mode}`;
    case "errors":
      return `${i.errors} errors`;
    case "project":
      // Folder and branch names come from the disk, so they are escaped like everything else on screen.
      return visible(i.branch === null ? i.project : `${i.project} git:(${i.branch})`);
    case "time":
      return `⏱ ${duration(i.elapsed)}`;
  }
}

// One line, cut at the end to the terminal's width (Ink measures it in columns) instead of wrapping.
// The text is inverse; the context bar is not, so its filled cells show in their colour.
export function StatusLine({ info, segments }: { info: StatusInfo; segments: Segment[] }) {
  return (
    <Text wrap="truncate-end">
      {segments.map((s, n) => {
        const bar = s === "context" && info.contextWindow ? contextBar(used(info)) : null;
        return (
          <Text key={n}>
            <Text inverse>{n === 0 ? " " : " | "}</Text>
            {bar && (
              <>
                <Text color={bar.color}>{"█".repeat(bar.filled)}</Text>
                <Text dimColor>{"░".repeat(BAR_CELLS - bar.filled)}</Text>
                <Text inverse> </Text>
              </>
            )}
            <Text inverse color={s === "errors" && info.errors > 0 ? "red" : undefined}>
              {formatSegment(s, info)}
              {n === segments.length - 1 ? " " : ""}
            </Text>
          </Text>
        );
      })}
    </Text>
  );
}
