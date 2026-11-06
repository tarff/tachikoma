import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { Row } from "../../src/core/sessions.js";
import { Bindings, DEFAULTS, tableOf } from "../../src/tui/bindings.js";
import { ago, SessionList } from "../../src/tui/SessionList.js";

const tick = () => new Promise((r) => setTimeout(r, 50));
const DOWN = "\u001b[B";
const UP = "\u001b[A";
const ESC = "\u001b";
const CTRL_C = "\u0003";

const MINUTE = 60_000;
const now = Date.UTC(2026, 10, 6, 12);
const row = (id: string, o: Partial<Row> & { minutes: number }): Row => ({
  id,
  firstPrompt: `prompt of ${id}`,
  lead: "openai:lead",
  size: 2048,
  print: false,
  ...o,
  changed: new Date(now - o.minutes * MINUTE),
});
const ROWS = [
  row("s1", { minutes: 5, name: "the fix" }),
  row("s2", { minutes: 3 * 60, firstPrompt: "why is\nthe build red?", lead: "anthropic:claude-opus-5-5", size: 512 }),
  row("s3", { minutes: 2 * 24 * 60, name: "the fix" }),
];

// Release 8a plan, Task 6 (design, "Resuming"): the list at `tachi -r`, newest first, each row the session's name or first
// prompt, how long ago it was used, its lead and its size; Up and Down move, Enter opens, Esc quits.
describe("SessionList", () => {
  function draw(name?: string, rows = ROWS) {
    const picked: (string | null)[] = [];
    const bindings = new Bindings(tableOf(DEFAULTS));
    const given = name === undefined ? {} : { name };
    const r = render(<SessionList rows={rows} {...given} now={now} bindings={bindings} onPick={(id) => picked.push(id)} onClose={() => picked.push(null)} />);
    return { ...r, picked };
  }

  it("shows each session's name or first prompt, how long ago it was used, its lead and its size", () => {
    const { lastFrame } = draw();
    const lines = lastFrame()!.split("\n");
    expect(lines[0]).toBe("Saved sessions in this folder, newest first:");
    expect(lines[1]).toMatch(/^the fix +5m ago +openai:lead +2\.0k bytes$/);
    expect(lines[2]).toMatch(/^why is⏎the build red\? +3h ago +anthropic:claude-opus-5-5 +512 bytes$/);
    expect(lines[3]).toMatch(/^the fix +2d ago +openai:lead +2\.0k bytes$/);
    expect(lines.at(-1)).toBe("↑↓ move · Enter opens · Esc quits");
  });

  it("moves with Up and Down, opens with Enter, and quits with Esc or Ctrl-C", async () => {
    const r = draw();
    r.stdin.write(DOWN);
    await tick();
    r.stdin.write(DOWN);
    await tick();
    r.stdin.write(DOWN); // already the last
    await tick();
    r.stdin.write(UP);
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(r.picked).toEqual(["s2"]);
    for (const key of [ESC, CTRL_C]) {
      const q = draw();
      q.stdin.write(key);
      await tick();
      expect(q.picked).toEqual([null]);
    }
  });

  it("lists only the sessions a name belongs to, saying so", async () => {
    const r = draw("the fix");
    const lines = r.lastFrame()!.split("\n");
    expect(lines[0]).toBe("Saved sessions named the fix, newest first:");
    expect(lines).toHaveLength(4);
    r.stdin.write(DOWN);
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(r.picked).toEqual(["s3"]);
  });

  it("writes how long ago in minutes, hours or days", () => {
    const minutes = [0.5, 59, 60, 23 * 60 + 59, 24 * 60, 40 * 24 * 60];
    expect(minutes.map((m) => ago(m * MINUTE))).toEqual(["<1m ago", "59m ago", "1h ago", "23h ago", "1d ago", "40d ago"]);
  });
});
