import chalk from "chalk";
import { render } from "ink-testing-library";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { Row } from "../../src/core/sessions.js";
import { Bindings, DEFAULTS, tableOf } from "../../src/tui/bindings.js";
import { ago, SessionList } from "../../src/tui/SessionList.js";
import { look, palette, ThemeContext } from "../../src/tui/theme.js";

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
    expect(lines.at(-1)).toBe("↑↓ move · Enter open · Esc quit");
  });

  // TUI design pass, Task 11 (audit 8): the hint's verbs in their plain form, `tachi -r`'s Esc quitting (the user's choice,
  // 2026-11-15, "Plain verbs"), /resume's in the window closing; the keys named from the bindings, a part with none left out.
  it("names its keys, then plain verbs, alone and in the window", () => {
    const rebound = new Bindings(tableOf({ ...DEFAULTS, Select: { "ctrl+p": "select:previous", "ctrl+n": "select:next", q: "select:cancel" } }));
    const hint = (bindings: Bindings, inWindow: boolean) => {
      const given = inWindow ? { keys: { current: null }, maxRows: 10 } : {};
      const r = render(<SessionList rows={ROWS} now={now} bindings={bindings} onPick={() => {}} onClose={() => {}} {...given} />);
      const line = r.lastFrame()!.split("\n").at(-1);
      r.unmount();
      return line;
    };
    const usual = new Bindings(tableOf(DEFAULTS));
    expect([hint(usual, false), hint(usual, true)]).toEqual(["↑↓ move · Enter open · Esc quit", "↑↓ move · Enter open · Esc close"]);
    expect([hint(rebound, false), hint(rebound, true)]).toEqual(["Ctrl+P Ctrl+N move · q quit", "Ctrl+P Ctrl+N move · q close"]);
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

// TUI design pass, Task 13: `tachi -r` draws the list alone (cli.tsx, drawAlone) in the look from the settings and the
// environment, as the App is drawn. With NO_COLOR set nothing is in a colour, though chalk would draw one (FORCE_COLOR=3,
// chalk at level 3); with the light theme, the light palette's muted hint. Colour codes only: dim is kept (Task 2).
describe("SessionList's colours", () => {
  function drawn(env: NodeJS.ProcessEnv, theme?: "light") {
    const level = chalk.level;
    chalk.level = 3;
    try {
      const shown = look(theme ? { theme } : {}, env, 3);
      const r = render(
        <ThemeContext value={{ look: shown, palette: palette(shown) }}>
          <SessionList rows={ROWS} now={now} bindings={new Bindings(tableOf(DEFAULTS))} onPick={() => {}} onClose={() => {}} />
        </ThemeContext>,
      );
      onTestFinished(() => r.unmount());
      return { frame: r.lastFrame()!, muted: palette(shown).muted };
    } finally {
      chalk.level = level;
    }
  }

  it("draws no colour with NO_COLOR set", () => {
    vi.stubEnv("NO_COLOR", "1");
    vi.stubEnv("FORCE_COLOR", "3");
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const { frame } = drawn(process.env);
    const codes = [...frame.matchAll(new RegExp(`${ESC}\\[([\\d;]*)m`, "g"))].filter((m) => m[1]!.split(";").some((p) => (+p >= 30 && +p <= 49) || (+p >= 90 && +p <= 107)));
    expect(frame).toContain("↑↓ move · Enter open · Esc quit");
    expect(codes).toEqual([]);
  });

  it("draws its hint in the light palette's muted with the light theme", () => {
    const { frame, muted } = drawn({}, "light");
    expect(frame).toContain(`${ESC}[38;2;${[1, 3, 5].map((i) => parseInt(muted!.slice(i, i + 2), 16)).join(";")}m↑↓ move · Enter open · Esc quit`);
  });
});
