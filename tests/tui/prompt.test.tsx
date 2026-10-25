import { EventEmitter } from "node:events";
import { render, Text } from "ink";
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
    const at = (cursor: number) => <Prompt editor={{ ...load(empty, "abcd\nef"), cursor }} columns={terminal.columns} offset={0} />;
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
        <Prompt editor={{ ...load(empty, "abcd\nef"), cursor: 2 }} columns={terminal.columns} offset={2} />
      </>
    );
    const app = render(tree, { stdout: terminal as never, stdin: new Keyboard() as never, debug: false, patchConsole: false, exitOnCtrlC: false, interactive: true });
    unmounts.push(app.unmount);
    await tick();
    expect(terminal.out).toContain("\u001b[2A\u001b[5G\u001b[?25h"); // up from below the four rows to the third
  });
});
