import { Text, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import { visible } from "../core/permissions.js";
import type { ModelGroup } from "../providers/models.js";
import type { Bindings } from "./bindings.js";
import type { Mouse } from "./input.js";
import { named } from "./keys.js";

// `/model`: every model of every provider that is set up (release 2 design, "The model picker").
// Arrow keys move, Enter picks, Esc (or Ctrl-C) closes, and typing filters, since OpenRouter alone
// lists hundreds.
// Names come from the providers, so they are escaped like everything else on screen.
// The keys come from App (release 6 plan, Task 6), which finds them in the table: an action, Select's, or select:cancel
// for Ctrl-C; text typed into the filter, a key at a time, or read together, a paste among it; or Backspace or Delete.
export type PickerKey = { action: string } | { text: string } | "backspace";

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

export function ModelPicker({
  groups,
  current,
  onPick,
  onClose,
  maxRows,
  mouse,
  bottom,
  keys,
  bindings,
}: {
  groups: ModelGroup[];
  current: string;
  onPick: (spec: string) => void;
  onClose: () => void;
  maxRows?: number;
  // In full screen, the mouse reports, and the frame row of the list's last line, the filter line: the App draws the list
  // at the foot of its rows, so where its first row is depends on the filter.
  mouse?: { on(e: "mouse", f: (m: Mouse) => void): unknown; off(e: "mouse", f: (m: Mouse) => void): unknown };
  bottom?: number;
  keys: { current: ((k: PickerKey) => void) | null }; // set at each drawing, for App to hand the list its keys
  bindings: Bindings; // for the help line's keys
}) {
  // Each key reads and changes this at once: Ink can pass on several keys from one read of the
  // terminal before the screen is drawn again, and each must see what the one before it did.
  const state = useRef<{ filter: string; chosen: number } | null>(null);
  state.current ??= { filter: "", chosen: Math.max(0, view(groups, "", 0).models.indexOf(current)) };
  const [, redraw] = useState(0);
  // Set once the list has closed or picked: keys and clicks read with the one that did it come before the list is gone
  // from the screen, and must not pick (found at Task 10's review).
  const done = useRef(false);
  const { filter } = state.current;
  const { shown, models, at } = view(groups, filter, state.current.chosen);
  // Fits the terminal: the help line, the status line and the line Ink ends with take three rows. In full screen the App
  // gives the rows for the list and its "No models" line together (release 5 plan, choice 19).
  const { stdout } = useStdout();
  const height = maxRows === undefined ? Math.max(1, (stdout.rows || shown.length + 3) - 3) : models.length ? Math.max(1, maxRows) : Math.max(0, maxRows - 1);
  const focus = shown.findIndex((r) => r.kind === "model" && r.spec === models[at]);
  const top = Math.min(Math.max(0, focus - Math.floor(height / 2)), Math.max(0, shown.length - height));

  // Picks the chosen model, as the keys before it left the filter and the choice.
  const pick = () => {
    const { models, at } = view(groups, state.current!.filter, state.current!.chosen);
    const spec = models[at];
    if (spec) {
      done.current = true;
      onPick(spec);
    } else redraw((n) => n + 1);
  };

  // A left press on a model picks it, as Enter does (release 5 design, "Clicking"); a press anywhere else does nothing
  // (release 5 plan, choice 10). Set up again at each drawing, so a row is mapped as it is drawn, and the model pressed is
  // picked though a key read with the press changed the filter (found at Task 10's review). The models' rows end on
  // the row above the filter line: the "No models" line under them shows only when there are none to press.
  const list = shown.slice(top, top + height);
  useEffect(() => {
    if (!mouse || bottom === undefined) return;
    const onMouse = (m: Mouse) => {
      const r = list[m.y - (bottom - list.length)];
      if (done.current || m.kind !== "press" || m.button !== "left" || r?.kind !== "model") return;
      done.current = true;
      onPick(r.spec);
    };
    mouse.on("mouse", onMouse);
    return () => void mouse.off("mouse", onMouse);
  });

  keys.current = (k) => {
    if (done.current) return;
    const s = state.current!;
    const { models, at } = view(groups, s.filter, s.chosen);
    if (k === "backspace") Object.assign(s, { filter: s.filter.slice(0, -1), chosen: 0 });
    else if ("text" in k) {
      // A paste, or a letter and Enter in one read of the terminal, comes as one piece of text: what is
      // before a line end filters, without its control characters, and the line end picks.
      const [typed = "", ...after] = k.text.split(/[\r\n]/);
      const text = typed.replace(/\p{Cc}/gu, "");
      if (text) Object.assign(s, { filter: s.filter + text, chosen: 0 });
      if (after.length) return pick();
    } else if (k.action === "select:cancel") {
      done.current = true;
      return onClose();
    } else if (k.action === "select:accept") return pick();
    else if (k.action === "select:previous") s.chosen = Math.max(0, at - 1);
    else if (k.action === "select:next") s.chosen = Math.max(0, Math.min(models.length - 1, at + 1));
    else return;
    redraw((n) => n + 1);
  };
  // The help line names the keys bound to Select's actions, as release 5 named them (keys.ts, named).
  const key = (action: string, usual: string) => named(bindings, action, "Select", [usual])[0];
  const [up, down, enter, esc] = [key("select:previous", "up"), key("select:next", "down"), key("select:accept", "enter"), key("select:cancel", "escape")];
  const help = [(up || down) && `${up ?? ""}${down ?? ""} move`, enter && `${enter} picks`, esc && `${esc} closes`].filter(Boolean).join(" · ");

  return (
    <>
      {list.map((r, i) =>
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
        Filter: {visible(filter) || "(type to filter)"} · {help}
      </Text>
    </>
  );
}
