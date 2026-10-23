import { Text, useInput, useStdout } from "ink";
import { useRef, useState } from "react";
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

// The rows shown for a filter, the models among them, and which of those is chosen.
function view(groups: ModelGroup[], filter: string, chosen: number) {
  const shown = rows(groups, filter);
  const models = shown.flatMap((r) => (r.kind === "model" ? [r.spec] : []));
  return { shown, models, at: Math.min(chosen, Math.max(0, models.length - 1)) };
}

export function ModelPicker({ groups, current, onPick, onClose }: { groups: ModelGroup[]; current: string; onPick: (spec: string) => void; onClose: () => void }) {
  // Each key reads and changes this at once: Ink can pass on several keys from one read of the
  // terminal before the screen is drawn again, and each must see what the one before it did.
  const state = useRef<{ filter: string; chosen: number } | null>(null);
  state.current ??= { filter: "", chosen: Math.max(0, view(groups, "", 0).models.indexOf(current)) };
  const [, redraw] = useState(0);
  const { filter } = state.current;
  const { shown, models, at } = view(groups, filter, state.current.chosen);
  // Fits the terminal: the help line, the status line and the line Ink ends with take three rows.
  const height = Math.max(1, (useStdout().stdout.rows || shown.length + 3) - 3);
  const focus = shown.findIndex((r) => r.kind === "model" && r.spec === models[at]);
  const top = Math.min(Math.max(0, focus - Math.floor(height / 2)), Math.max(0, shown.length - height));

  // Picks the chosen model, as the keys before it left the filter and the choice.
  const pick = () => {
    const { models, at } = view(groups, state.current!.filter, state.current!.chosen);
    const spec = models[at];
    if (spec) onPick(spec);
    else redraw((n) => n + 1);
  };

  useInput((ch, key) => {
    const s = state.current!;
    const { models, at } = view(groups, s.filter, s.chosen);
    if (key.escape || (key.ctrl && ch === "c")) return onClose();
    if (key.return) return pick();
    if (key.upArrow) s.chosen = Math.max(0, at - 1);
    else if (key.downArrow) s.chosen = Math.max(0, Math.min(models.length - 1, at + 1));
    else if (key.backspace || key.delete) Object.assign(s, { filter: s.filter.slice(0, -1), chosen: 0 });
    else if (!key.ctrl && !key.meta && ch) {
      // A paste, or a letter and Enter in one read of the terminal, comes as one piece of text: what is
      // before a line end filters, without its control characters, and the line end picks.
      const [typed = "", ...after] = ch.split(/[\r\n]/);
      const text = typed.replace(/\p{Cc}/gu, "");
      if (text) Object.assign(s, { filter: s.filter + text, chosen: 0 });
      if (after.length) return pick();
    } else return;
    redraw((n) => n + 1);
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
      {models.length === 0 && <Text color="gray">{filter ? "No models match." : "No models to pick from."}</Text>}
      <Text color="gray" wrap="truncate-end">
        Filter: {visible(filter) || "(type to filter)"} · ↑↓ move · Enter picks · Esc closes
      </Text>
    </>
  );
}
