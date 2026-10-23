import { Text, useInput, useStdout } from "ink";
import { useState } from "react";
import { visible } from "../core/permissions.js";
import type { ModelGroup } from "../providers/models.js";

// `/model`: every model of every provider that is set up (release 2 design, "The model picker").
// Arrow keys move, Enter picks, Esc (or Ctrl-C) closes, and typing filters, since OpenRouter alone
// lists hundreds.
// Names come from the providers, so they are escaped like everything else on screen.

type Row = { kind: "heading"; text: string } | { kind: "model"; spec: string };

export function rows(groups: ModelGroup[], filter: string): Row[] {
  const f = filter.toLowerCase();
  return groups.flatMap((g): Row[] => {
    if ("error" in g) return f ? [] : [{ kind: "heading", text: `${g.provider} (${g.error})` }];
    if (!g.models.length) return f ? [] : [{ kind: "heading", text: `${g.provider} (no models)` }];
    const specs = g.models.map((m) => `${g.provider}:${m}`).filter((s) => s.toLowerCase().includes(f));
    return specs.length ? [{ kind: "heading", text: g.provider }, ...specs.map((spec): Row => ({ kind: "model", spec }))] : [];
  });
}

export function ModelPicker({ groups, current, onPick, onClose }: { groups: ModelGroup[]; current: string; onPick: (spec: string) => void; onClose: () => void }) {
  const [filter, setFilter] = useState("");
  const shown = rows(groups, filter);
  const models = shown.flatMap((r) => (r.kind === "model" ? [r.spec] : []));
  const [chosen, setChosen] = useState(() => Math.max(0, models.indexOf(current)));
  const at = Math.min(chosen, Math.max(0, models.length - 1));
  // Fits the terminal: the help line, the status line and the line Ink ends with take three rows.
  const height = Math.max(1, (useStdout().stdout.rows || shown.length + 3) - 3);
  const focus = shown.findIndex((r) => r.kind === "model" && r.spec === models[at]);
  const top = Math.min(Math.max(0, focus - Math.floor(height / 2)), Math.max(0, shown.length - height));

  useInput((ch, key) => {
    if (key.escape || (key.ctrl && ch === "c")) onClose();
    else if (key.return) {
      const spec = models[at];
      if (spec) onPick(spec);
    } else if (key.upArrow) setChosen(Math.max(0, at - 1));
    else if (key.downArrow) setChosen(Math.min(models.length - 1, at + 1));
    else if (key.backspace || key.delete) {
      setFilter((s) => s.slice(0, -1));
      setChosen(0);
    } else if (!key.ctrl && !key.meta && ch) {
      setFilter((s) => s + ch);
      setChosen(0);
    }
  });

  return (
    <>
      {shown.slice(top, top + height).map((r, i) =>
        r.kind === "heading" ? (
          <Text key={`h${top + i}`} bold wrap="truncate-end">
            {visible(r.text)}
          </Text>
        ) : (
          <Text key={`m${top + i}`} inverse={r.spec === models[at]} wrap="truncate-end">
            {r.spec === current ? "● " : "  "}
            {visible(r.spec)}
          </Text>
        ),
      )}
      {models.length === 0 && <Text color="gray">No models match.</Text>}
      <Text color="gray" wrap="truncate-end">
        Filter: {filter || "(type to filter)"} · ↑↓ move · Enter picks · Esc closes
      </Text>
    </>
  );
}
