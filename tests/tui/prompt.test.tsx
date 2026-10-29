import { EventEmitter } from "node:events";
import { render, Text } from "ink";
import { render as renderFrames } from "ink-testing-library";
import chalk from "chalk";
import { afterEach, describe, expect, it } from "vitest";
import { load, empty } from "../../src/tui/editor.js";
import { Prompt } from "../../src/tui/Prompt.js";

// A stand-in terminal, which Ink draws to as to a real one, cursor moves included:
// ink-testing-library's leaves the cursor out.
class Terminal extends EventEmitter {
  isTTY = true;
  columns = 20;
  rows = 10;
  out = "";
  write = (s: string) => {
    this.out += s;
    return true;
  };
}

class Keyboard extends EventEmitter {
  isTTY = true;
  setRawMode() {}
  setEncoding() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => null;
}

const tick = () => new Promise((r) => setTimeout(r, 50));
const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const u of unmounts.splice(0)) u();
});

describe("Prompt", () => {
  it("puts the terminal's cursor where typing goes, after the two columns each row starts with", async () => {
    const terminal = new Terminal();
    const at = (cursor: number) => <Prompt editor={{ ...load(empty, "abcd\nef"), cursor }} columns={terminal.columns} offset={0} space={terminal.rows} />;
    const app = render(at(2), { stdout: terminal as never, stdin: new Keyboard() as never, debug: false, patchConsole: false, exitOnCtrlC: false, interactive: true });
    unmounts.push(app.unmount);
    await tick();
    // Up from below the prompt's two rows to the first, then to column 5: after "› ab".
    expect(terminal.out).toContain("\u001b[2A\u001b[5G\u001b[?25h");
    terminal.out = "";
    app.rerender(at(7));
    await tick();
    expect(terminal.out).toContain("\u001b[1A\u001b[5G\u001b[?25h"); // the second row, after "  ef"
  });

  it("counts the rows above it, which the cursor is placed from", async () => {
    const terminal = new Terminal();
    const tree = (
      <>
        <Text>working</Text>
        <Text>queued</Text>
        <Prompt editor={{ ...load(empty, "abcd\nef"), cursor: 2 }} columns={terminal.columns} offset={2} space={terminal.rows} />
      </>
    );
    const app = render(tree, { stdout: terminal as never, stdin: new Keyboard() as never, debug: false, patchConsole: false, exitOnCtrlC: false, interactive: true });
    unmounts.push(app.unmount);
    await tick();
    expect(terminal.out).toContain("\u001b[2A\u001b[5G\u001b[?25h"); // up from below the four rows to the third
  });

  it("shows a prompt taller than its space as a window that follows the cursor, counting the rows cut off", () => {
    const text = [...Array(10).keys()].map((i) => `l${i}`).join("\n");
    const at = (cursor: number) => <Prompt editor={{ ...load(empty, text), cursor }} columns={20} offset={0} space={4} />;
    const app = renderFrames(at(text.length));
    unmounts.push(app.unmount);
    expect(app.lastFrame()).toBe("› ↑ 7 rows above\n  l7\n  l8\n  l9");
    app.rerender(at(text.indexOf("l6")));
    expect(app.lastFrame()).toBe("› ↑ 6 rows above\n  l6\n  l7\n  ↓ 2 rows below");
  });

  it("places the cursor in the window", async () => {
    const terminal = new Terminal();
    const text = [...Array(10).keys()].map((i) => `l${i}`).join("\n");
    const app = render(<Prompt editor={load(empty, text)} columns={terminal.columns} offset={0} space={4} />, { stdout: terminal as never, stdin: new Keyboard() as never, debug: false, patchConsole: false, exitOnCtrlC: false, interactive: true });
    unmounts.push(app.unmount);
    await tick();
    expect(terminal.out).toContain("\u001b[1A\u001b[5G\u001b[?25h"); // the window's last row, after "  l9"
  });

  it("keeps the cursor on the same character when the terminal is resized", async () => {
    const terminal = new Terminal();
    const at = () => <Prompt editor={{ ...load(empty, "a".repeat(30)), cursor: 25 }} columns={terminal.columns} offset={0} space={terminal.rows} />;
    const app = render(at(), { stdout: terminal as never, stdin: new Keyboard() as never, debug: false, patchConsole: false, exitOnCtrlC: false, interactive: true });
    unmounts.push(app.unmount);
    await tick();
    expect(terminal.out).toContain("\u001b[1A\u001b[11G\u001b[?25h"); // 17 columns a row: the second row, column 8
    terminal.out = "";
    terminal.columns = 12;
    terminal.emit("resize");
    app.rerender(at());
    await tick();
    expect(terminal.out).toContain("\u001b[2A\u001b[10G\u001b[?25h"); // 9 a row: the third of four rows, column 7
  });

  // The plan's choice 28: vim's VISUAL selection, from App, in reverse colours on each row it covers, as Claude Code
  // 2.1.312 draws it, an empty line in it as one reversed space.
  it("draws a selection in reverse colours across a wrapped row and an empty line", () => {
    const level = chalk.level;
    chalk.level = 1; // chalk's basic colours, enough for reverse
    try {
      const text = "abcdefghijklmnopqrstuvwxyz\n\nend"; // 17 columns a row: "abc...pq", "rst...z", "", "end"
      const app = renderFrames(<Prompt editor={load(empty, text)} columns={20} offset={0} space={10} selected={[15, 29]} />);
      unmounts.push(app.unmount);
      expect(app.lastFrame()!.split("\n")).toEqual([
        "› abcdefghijklmno\u{1b}[7mpq\u{1b}[27m",
        "  \u{1b}[7mrstuvwxyz\u{1b}[27m",
        "  \u{1b}[7m \u{1b}[27m",
        "  \u{1b}[7me\u{1b}[27mnd",
      ]);
    } finally {
      chalk.level = level;
    }
  });
});
