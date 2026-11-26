import { Text } from "ink";
import { useContext } from "react";
import stringWidth from "string-width";
import { type Mode, visible } from "../core/permissions.js";
import { type Colour, type Look, type Palette, ThemeContext } from "./theme.js";

// The status line's parts, and `tools`, the line under it (release 3 design, "On screen"); `tasks`,
// how many subagents run (release 4 design, "On screen"); `memory`, long-term memory's marker (8d plan, Q14).
export type Segment =
  | "lead" | "context" | "tokens" | "cost" | "mode" | "errors" | "memory" | "project" | "time" | "tasks" | "tools";
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
  // Long-term memory, when it has something to say (8d plan, Q14): setting up, or off or failing for a reason of this
  // run; none when all is well, and none for the user's own choices or a missing uv.
  memory?: "setting up" | "off" | "failing";
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

// The cost so far; the working line shows a turn's the same way. A `+` after it: some calls had no known price, so the
// real cost is higher (TUI design pass, choice D).
export function costText(lead: string, cost: number, costUnknown: boolean): string {
  const dollars = `$${cost.toFixed(2)}${costUnknown ? "+" : ""}`;
  // A plan has no per-token price; OpenAI's guidelines ask apps to show that the plan is in use.
  if (!lead.startsWith("chatgpt:")) return dollars;
  if (cost) return `ChatGPT plan + ${dollars}`;
  return costUnknown ? "ChatGPT plan+" : "ChatGPT plan";
}

// A run of a part's text in one colour. Grey is `dim`, as claude-hud draws it (`dim` in its src/render/colors.ts, 0.0.4)
// and as the bar's empty cells are drawn below; the labels are the palette's muted (TUI design pass, Task 10).
export interface Piece {
  text: string;
  color?: Colour; // a colour, never a role (theme.ts)
  dim?: boolean;
}

// The mode by risk, as claude-hud has no such part (release 5 design, "The status line's colours"). Auto takes magenta,
// which no other mode uses, so it stands apart (release 7 plan, Task 7). These and the context bar's keep their own colours,
// as they mean risk and fullness, but only with colour (look.color): chalk does not read NO_COLOR, so a name handed to
// Ink would still be drawn (TUI design pass, Task 13).
const MODE_COLOR: Record<Mode, Piece["color"]> = { ask: "green", project: "yellow", auto: "magenta", never: "red" };

// The one place each part's words and colours are written (release 5 design, "The status line's colours"); the labels
// muted and the model in the accent colour from the palette (TUI design pass, Task 10), and every other colour from it but
// the mode's and the context's (Task 13).
export function pieces(s: LineSegment, i: StatusInfo, p: Palette, look: Look): Piece[] {
  switch (s) {
    case "lead":
      // Escaped as the folder and branch are below: the id comes from the command line or a provider's model list.
      return [{ text: "lead", color: p.muted }, { text: " " }, { text: visible(i.lead), color: p.accent }];
    case "context": {
      // How much is left, as Codex shows it (main design, "Status line"), in the bar's colour, the bar saying what
      // the part is (the user's choice, 2026-10-27); the tokens in use when the window is not known.
      if (!i.contextWindow) return [{ text: "ctx", color: p.muted }, { text: ` ${k(i.context)}` }];
      const u = used(i);
      return [{ text: `${Math.max(0, 100 - u)}% left`, color: look.color ? contextBar(u).color : undefined }];
    }
    case "tokens":
      return [{ text: `${k(i.input)} ` }, { text: "in", color: p.muted }, { text: ` / ${k(i.output)} ` }, { text: "out", color: p.muted }];
    case "cost":
      return [{ text: costText(i.lead, i.cost, i.costUnknown), color: p.success }];
    case "mode":
      return [{ text: "perm", color: p.muted }, { text: " " }, { text: i.mode, color: look.color ? MODE_COLOR[i.mode] : undefined }];
    case "errors": // shown only once there is one (zero, below)
      return [{ text: `${i.errors} error${i.errors === 1 ? "" : "s"}`, color: p.error }];
    case "memory": // the design's three texts (8d design, section 6), shown only with one (zero, below)
      return [
        i.memory === "setting up"
          ? { text: "memory: setting up", color: p.warning }
          : { text: `memory ${i.memory}`, color: p.error },
      ];
    case "project": {
      // Folder and branch names come from the disk, so they are escaped like everything else on screen.
      const folder: Piece = { text: visible(i.project), color: p.warning };
      if (i.branch === null) return [folder];
      return [folder, { text: " " }, { text: "git:(", color: p.muted }, { text: visible(i.branch), color: p.accent }, { text: ")", color: p.muted }];
    }
    case "time":
      return [{ text: `⏱ ${duration(i.elapsed)}`, dim: true }];
    case "tasks":
      return [{ text: `${i.running} running`, color: p.warning }];
  }
}

// A part with nothing to say yet (TUI design pass, Task 10): no errors, no tokens either way, a cost of 0 that is known.
// The ChatGPT plan's cost part still says the plan is in use (costText). `tasks` shows only while a subagent runs,
// `memory` only with a marker.
function zero(s: LineSegment, i: StatusInfo): boolean {
  if (s === "tasks") return i.running === 0;
  if (s === "memory") return i.memory === undefined;
  if (s === "errors") return i.errors === 0;
  if (s === "tokens") return i.input === 0 && i.output === 0;
  return s === "cost" && i.cost === 0 && !i.costUnknown && !i.lead.startsWith("chatgpt:");
}

// One line, `columns` wide at most, instead of wrapping: too long, parts drop from the end of the list one at a time,
// `lead` and `mode` last (TUI design pass, Task 10), and then each dropped part that fits again is put back, in the list's
// order (the user's "Put back what fits", 2026-11-14); a last part still too long alone is cut at the end (Ink measures
// it in columns). On the terminal's own background, its parts split by a grey ` | ` (release 5 design, "The status
// line's colours").
export function StatusLine({ info, segments, columns }: { info: StatusInfo; segments: Segment[]; columns: number }) {
  const { look, palette } = useContext(ThemeContext);
  const listed = segments.filter((s): s is LineSegment => s !== "tools" && !zero(s, info));
  const on = listed.map(() => true);
  // A part's columns: its bar's cells and the space after them, then its words; the line's, a space at each end and
  // ` | ` between parts.
  const width = (s: LineSegment) => (s === "context" && info.contextWindow ? BAR_CELLS + 1 : 0) + stringWidth(pieces(s, info, palette, look).map((p) => p.text).join(""));
  const lineWidth = () => {
    const parts = listed.filter((_, n) => on[n]);
    return 2 + parts.reduce((sum, s) => sum + width(s), 0) + 3 * (parts.length - 1);
  };
  const keptLongest = (s: LineSegment) => s === "lead" || s === "mode"; // dropped only once no other part is left
  while (on.filter(Boolean).length > 1 && lineWidth() > columns) {
    const n = on.findLastIndex((o, m) => o && !keptLongest(listed[m]!));
    on[n === -1 ? on.lastIndexOf(true) : n] = false;
  }
  // None put back while `lead` or `mode` is out, so they still go last.
  if (listed.every((s, n) => on[n] || !keptLongest(s)))
    for (let n = 0; n < listed.length; n++) {
      if (on[n]) continue;
      on[n] = true;
      if (lineWidth() > columns) on[n] = false;
    }
  const shown = listed.filter((_, n) => on[n]);
  return (
    <Text wrap="truncate-end">
      {shown.map((s, n) => {
        const bar = s === "context" && info.contextWindow ? contextBar(used(info)) : null;
        return (
          <Text key={n}>
            {n === 0 ? " " : <Text dimColor> | </Text>}
            {bar && (
              <>
                <Text color={look.color ? bar.color : undefined}>{"█".repeat(bar.filled)}</Text>
                <Text dimColor>{"░".repeat(BAR_CELLS - bar.filled)}</Text>{" "}
              </>
            )}
            {pieces(s, info, palette, look).map((p, j) => (
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
