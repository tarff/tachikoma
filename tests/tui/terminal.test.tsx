import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { render, Static, Text, useApp } from "ink";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { FIRST_SCREEN, MOUSE_OFF, MOUSE_ON, SECOND_SCREEN, SHOW_CURSOR, Screen } from "../../src/tui/terminal.js";

// A stand-in terminal and keyboard, as in prompt.test.tsx: Ink draws to them as to real ones.
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

const options = (terminal: Terminal) => ({
  stdout: terminal as never,
  stdin: new Keyboard() as never,
  debug: false,
  patchConsole: false,
  exitOnCtrlC: false,
  interactive: true,
});
const tick = () => new Promise((r) => setTimeout(r, 50)); // prompt.test.tsx's wait for Ink to draw
const commit = () => new Promise((r) => setTimeout(r, 0)); // the one setTimeout(0) Task 14 waits for React to commit
const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const u of unmounts.splice(0)) u();
});

// Two writers that record what reached each, so a test can tell `write` from `writeNow`.
function recorded() {
  const out = { write: "", now: "" };
  const screen = new Screen(
    (s) => (out.write += s),
    (s) => (out.now += s),
  );
  return { out, screen };
}

describe("Screen", () => {
  it("writes the codes for each switch, keeps track of what is on, and writes nothing for a switch that changes nothing", () => {
    const { out, screen } = recorded();
    expect([screen.full, screen.mouse]).toEqual([false, false]);
    screen.enter();
    expect(out.write).toBe(SECOND_SCREEN + MOUSE_ON);
    expect([screen.full, screen.mouse]).toEqual([true, true]);
    out.write = "";
    screen.setMouse(true);
    screen.setSecond(true);
    expect(out.write).toBe("");
    screen.setMouse(false);
    expect(out.write).toBe(MOUSE_OFF);
    expect([screen.full, screen.mouse]).toEqual([true, false]);
    screen.setSecond(false);
    expect(out.write).toBe(MOUSE_OFF + FIRST_SCREEN);
    expect([screen.full, screen.mouse]).toEqual([false, false]);
    out.write = "";
    screen.setMouse(false);
    screen.setSecond(false);
    expect(out.write).toBe("");
    screen.setSecond(true);
    screen.setMouse(true);
    expect(out.write).toBe(SECOND_SCREEN + MOUSE_ON);
    expect([screen.full, screen.mouse]).toEqual([true, true]);
    out.write = "";
    screen.leave();
    expect(out.write).toBe(MOUSE_OFF + FIRST_SCREEN);
    expect([screen.full, screen.mouse]).toEqual([false, false]);
    out.write = "";
    screen.write("\u001b]52;c;aGk=\u0007");
    expect(out.write).toBe("\u001b]52;c;aGk=\u0007");
    expect(out.now).toBe("");
  });

  it("puts the terminal back once, through the synchronous writer, undoing only what is on", () => {
    const after = recorded();
    after.screen.enter();
    after.out.write = "";
    after.screen.restore();
    expect(after.out.now).toBe(MOUSE_OFF + FIRST_SCREEN + SHOW_CURSOR);
    expect(after.out.write).toBe("");
    expect([after.screen.full, after.screen.mouse]).toEqual([false, false]);
    after.screen.restore();
    expect(after.out.now).toBe(MOUSE_OFF + FIRST_SCREEN + SHOW_CURSOR);

    const left = recorded();
    left.screen.enter();
    left.screen.leave();
    left.screen.restore();
    expect(left.out.now).toBe(SHOW_CURSOR);
  });
});

// What the component draws: classic rows, full-screen rows, nothing (while a switch to classic runs), or printed lines.
type Drawn = "classic" | "full" | "none" | "printed";
const CLASSIC = ["classic one", "classic two", "classic three"];
const FULL = ["full one", "full two", "full three"];

function session() {
  const terminal = new Terminal();
  const screen = new Screen(terminal.write, terminal.write);
  const control: { draw?: (d: Drawn) => void; app?: ReturnType<typeof useApp> } = {};
  function Probe() {
    const [drawn, setDrawn] = useState<Drawn>("classic");
    control.draw = setDrawn;
    control.app = useApp();
    if (drawn === "printed") return <Static items={["a", "b", "c"]}>{(item) => <Text key={item}>{item}</Text>}</Static>;
    if (drawn === "none") return null;
    return (
      <>
        {(drawn === "classic" ? CLASSIC : FULL).map((row) => (
          <Text key={row}>{row}</Text>
        ))}
      </>
    );
  }
  const app = render(<Probe />, options(terminal));
  unmounts.push(app.unmount);
  return { terminal, screen, control };
}

// The lines a part of the output shows, escape codes taken out.
const shown = (s: string) => stripVTControlCharacters(s).split("\n");

describe("switching in the middle of a session", () => {
  it("to full screen: suspend, switch, let React commit the full rows, then resume", async () => {
    const { terminal, screen, control } = session();
    await tick();
    expect(terminal.out).toContain("classic one");
    const { resume } = await control.app!.suspendTerminal();
    screen.enter();
    control.draw!("full");
    await commit();
    await resume();
    await tick();
    const after = terminal.out.slice(terminal.out.indexOf(SECOND_SCREEN));
    expect(terminal.out.indexOf(SECOND_SCREEN)).toBeGreaterThanOrEqual(0);
    for (const row of FULL) expect(after).toContain(row);
    for (const row of CLASSIC) expect(after).not.toContain(row);
  });

  it("to classic: draw nothing, suspend, switch, resume, and only then print", async () => {
    const { terminal, screen, control } = session();
    await tick();
    let { resume } = await control.app!.suspendTerminal();
    screen.enter();
    control.draw!("full");
    await commit();
    await resume();
    await tick();
    control.draw!("none");
    await commit();
    ({ resume } = await control.app!.suspendTerminal());
    screen.leave();
    await resume();
    control.draw!("printed");
    await tick();
    const after = terminal.out.slice(terminal.out.indexOf(FIRST_SCREEN));
    expect(terminal.out.indexOf(FIRST_SCREEN)).toBeGreaterThanOrEqual(0);
    expect(shown(after)).toEqual(expect.arrayContaining(["a", "b", "c"]));
    for (const row of FULL) expect(after).not.toContain(row);
  });

  it("loses the printed lines if they are mounted before resume, as Ink drops renders while suspended", async () => {
    const { terminal, screen, control } = session();
    await tick();
    let { resume } = await control.app!.suspendTerminal();
    screen.enter();
    control.draw!("full");
    await commit();
    await resume();
    await tick();
    control.draw!("none");
    await commit();
    ({ resume } = await control.app!.suspendTerminal());
    screen.leave();
    control.draw!("printed");
    await commit();
    await resume();
    await tick();
    const after = terminal.out.slice(terminal.out.indexOf(FIRST_SCREEN));
    expect(terminal.out.indexOf(FIRST_SCREEN)).toBeGreaterThanOrEqual(0);
    for (const item of ["a", "b", "c"]) expect(shown(after)).not.toContain(item);
  });
});

describe("the full-screen frame's height", () => {
  // A frame `height` rows tall drawn ten times (the plan's Task 1), a counter in it so each frame differs. ESC[2J starts
  // Ink's clear (ansi-escapes `clearTerminal`, which `shouldClearTerminalForFrame` in ink.js calls for). On Windows Ink
  // clears for any frame as tall as the terminal; elsewhere only when a frame overflows, shrinks from full height, or
  // unmounts. So the control test, a frame as tall as the terminal, runs on Windows only.
  async function draw(height: number) {
    const terminal = new Terminal();
    const frame = (n: number) => (
      <>
        {[...Array(height).keys()].map((i) => (
          <Text key={i}>{`row ${i} at ${n}`}</Text>
        ))}
      </>
    );
    const app = render(frame(0), options(terminal));
    unmounts.push(app.unmount);
    for (let n = 1; n < 10; n++) {
      await tick();
      app.rerender(frame(n));
    }
    await tick();
    expect(terminal.out).toContain(`row 0 at 9`);
    return terminal.out;
  }

  it("one row short of the terminal never makes Ink clear it", async () => {
    expect(await draw(new Terminal().rows - 1)).not.toContain("\u001b[2J");
  });

  it.runIf(process.platform === "win32")("as tall as the terminal does on Windows, so the check above can catch a clear", async () => {
    expect(await draw(new Terminal().rows)).toContain("\u001b[2J");
  });
});
