import { Text } from "ink";
import { Fragment } from "react";
import type { ToolOutcome } from "../core/bus.js";
import { visible } from "../core/permissions.js";

// A call of the turn, from the session's tool-start and tool-end events; no outcome while it runs.
export interface Call {
  id: string;
  name: string;
  target: string | null; // its main detail (`brief` in describe.ts)
  outcome?: ToolOutcome;
}

export interface Part {
  mark: string;
  rest: string;
  color: "yellow" | "green" | "red" | "gray";
  whole: boolean; // the whole part in its colour, not only the mark
}

const ENDS: Record<ToolOutcome, Omit<Part, "rest">> = {
  ok: { mark: "✓", color: "green", whole: false },
  failed: { mark: "✗", color: "red", whole: true },
  declined: { mark: "⊘", color: "gray", whole: true },
  cancelled: { mark: "⊘", color: "gray", whole: true },
};
const SHOWN = 4; // claude-hud's tools line shows the four most used (`renderToolsLine`, src/render/tools-line.ts, 0.0.4)

// The line under the status line (release 3 design, "On screen", after claude-hud's tools line): the
// running call and its target, then the finished calls counted by tool and how they ended, most
// first. Names and targets come from the model, so they are escaped.
export function toolParts(calls: Call[]): Part[] {
  const running = calls.filter((c) => !c.outcome).map((c): Part => ({ mark: "◐", rest: visible(c.target === null ? c.name : `${c.name} ${c.target}`), color: "yellow", whole: false }));
  const counts = new Map<string, { end: Omit<Part, "rest">; name: string; n: number }>();
  for (const c of calls) {
    if (!c.outcome) continue;
    const end = ENDS[c.outcome];
    const group = counts.get(`${end.mark} ${c.name}`) ?? { end, name: c.name, n: 0 };
    group.n++;
    counts.set(`${end.mark} ${c.name}`, group);
  }
  const done = [...counts.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, SHOWN)
    .map((g): Part => ({ ...g.end, rest: `${visible(g.name)} ×${g.n}` }));
  return [...running, ...done];
}

export function ToolLine({ calls }: { calls: Call[] }) {
  return (
    <Text wrap="truncate-end">
      {toolParts(calls).map((p, n) => (
        <Fragment key={n}>
          {n ? " | " : ""}
          <Text color={p.whole ? p.color : undefined}>
            <Text color={p.color}>{p.mark}</Text> {p.rest}
          </Text>
        </Fragment>
      ))}
    </Text>
  );
}
