import { renderToString } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { Field as FormField } from "../../src/mcp/forms.js";
import { Bindings, DEFAULTS, tableOf } from "../../src/tui/bindings.js";
import { Field } from "../../src/tui/Field.js";
import { type Listed, McpList } from "../../src/tui/McpList.js";
import { ModelPicker, type PickerKey } from "../../src/tui/ModelPicker.js";

const tick = () => new Promise((r) => setTimeout(r, 50));

// TUI design pass, Task 11 (audit 8): each list's hint names its keys, then a verb in its plain form, " · " between; the
// keys from the bindings, a part with no key left out. The rebound table moves Up and Down to Ctrl+P and Ctrl+N, Esc to
// q, and leaves Enter with no key.
const DEFAULT = new Bindings(tableOf(DEFAULTS));
const REBOUND = new Bindings(
  tableOf({ ...DEFAULTS, Select: { "ctrl+p": "select:previous", "ctrl+n": "select:next", q: "select:cancel" } }),
);
const last = (drawn: string) => drawn.split("\n").at(-1);
const keys = () => ({ current: null });

describe("the model list's hint", () => {
  const groups = [{ provider: "fake", models: ["a"] }];
  const drawn = (bindings: Bindings) =>
    renderToString(<ModelPicker groups={groups} current="fake:a" onPick={() => {}} onClose={() => {}} maxRows={5} keys={keys()} bindings={bindings} />);

  it("says move, pick and close", () => {
    expect(last(drawn(DEFAULT))).toBe("Filter: (type to filter) · ↑↓ move · Enter pick · Esc close");
    expect(last(drawn(REBOUND))).toBe("Filter: (type to filter) · Ctrl+P Ctrl+N move · q close");
  });
});

describe("/mcp's hint", () => {
  const server: Listed = { name: "s", where: "user", state: { is: "ready", tools: [] }, trusted: null, trustedTools: [], tools: 1 };
  const servers = { list: () => [server], answered: () => false, signedIn: () => false, watch: () => () => {} };
  const list = (bindings: Bindings, k: { current: ((key: PickerKey) => void) | null } = keys()) => (
    <McpList servers={servers} bindings={bindings} onAction={() => {}} onClose={() => {}} keys={k} maxRows={5} />
  );

  it("says move, open and close at the servers", () => {
    expect(last(renderToString(list(DEFAULT)))).toBe("↑↓ move · Enter open · Esc close");
    expect(last(renderToString(list(REBOUND)))).toBe("Ctrl+P Ctrl+N move · q close");
  });

  // The user's choice, 2026-11-15 ("Plain verbs"): one server's view says run and back.
  it("says move, run and back at one server's actions", async () => {
    // Only Up and Down move, so the hint still names run and back.
    const moved = new Bindings(
      tableOf({ ...DEFAULTS, Select: { ...DEFAULTS.Select, up: null, down: null, "ctrl+p": "select:previous", "ctrl+n": "select:next" } }),
    );
    for (const [bindings, hint] of [
      [DEFAULT, "↑↓ move · Enter run · Esc back"],
      [moved, "Ctrl+P Ctrl+N move · Enter run · Esc back"],
    ] as const) {
      const k: { current: ((key: PickerKey) => void) | null } = keys();
      const r = render(list(bindings, k));
      k.current!({ action: "select:accept" }); // Enter opens the server's actions
      await tick();
      expect(last(r.lastFrame()!)).toBe(hint);
      r.unmount();
    }
  });
});

describe("a form's pick's hint", () => {
  const pick = (multi: boolean): FormField => ({
    name: "size",
    question: "Size: ",
    required: true,
    kind: "pick",
    multi,
    options: [{ value: "s", label: "Small" }],
    start: [],
  });
  const drawn = (field: FormField, bindings: Bindings) =>
    renderToString(<Field asked={{ id: 1, field, done: () => {} }} bindings={bindings} keys={keys()} rows={6} full={false} />);

  it("says move, mark, answer and decline", () => {
    expect(last(drawn(pick(true), DEFAULT))).toBe("↑↓ move · Space mark · Enter answer · Esc decline");
    expect(last(drawn(pick(false), DEFAULT))).toBe("↑↓ move · Enter answer · Esc decline");
    expect(last(drawn(pick(true), REBOUND))).toBe("Ctrl+P Ctrl+N move · Space mark · q decline");
  });
});
