import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { render, Static, Text, useApp } from "ink";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  FIRST_SCREEN,
  MOUSE_OFF,
  MOUSE_ON,
  restoreOnExit,
  restoreWhenInkEnds,
  SECOND_SCREEN,
  SHOW_CURSOR,
  Screen,
  writeBestEffort,
} from "../../src/tui/terminal.js";

const ESC = String.fromCharCode(27);

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

  it("writes nothing when put back if it never turned anything on, so classic mode stays as release 4 left it", () => {
    const { out, screen } = recorded();
    screen.restore();
    expect(out).toEqual({ write: "", now: "" });
  });
});

describe("writeBestEffort", () => {
  it("writes at once, and does not throw when the write fails", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tachi-terminal-"));
    try {
      const file = path.join(dir, "out.txt");
      const fd = openSync(file, "w");
      writeBestEffort(fd, "written");
      closeSync(fd);
      expect(readFileSync(file, "utf8")).toBe("written");
      // A descriptor nothing has open: writeSync throws for it, as it does for a pipe whose reader has gone (EPIPE).
      expect(() => writeSync(2 ** 30, "lost")).toThrow();
      expect(() => writeBestEffort(2 ** 30, "lost")).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("restoreWhenInkEnds", () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("puts the terminal back as soon as Ink ends, not when the process does", async () => {
    const { out, screen } = recorded();
    screen.enter();
    restoreWhenInkEnds(screen, Promise.resolve());
    await settle();
    expect(out.now).toBe(MOUSE_OFF + FIRST_SCREEN + SHOW_CURSOR);
  });

  it("in classic, leaves a render error to Ink's own report on screen and exits with 1", async () => {
    const { out, screen } = recorded();
    const code = process.exitCode;
    try {
      restoreWhenInkEnds(screen, Promise.reject(new Error("render broke")));
      await settle();
      expect(out).toEqual({ write: "", now: "" });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = code; // the test runner's own process
    }
  });
});

describe("restoreOnExit", () => {
  it("on exit and on a crash, lets Ink draw its last frame and then puts the terminal back", () => {
    for (const event of ["exit", "uncaughtExceptionMonitor"]) {
      const proc = new EventEmitter();
      let out = "";
      const screen = new Screen((s) => (out += s), (s) => (out += s));
      restoreOnExit(screen, () => (out += "last frame"), proc);
      screen.enter();
      proc.emit(event, new Error("boom"));
      expect(out).toBe(SECOND_SCREEN + MOUSE_ON + "last frame" + MOUSE_OFF + FIRST_SCREEN + SHOW_CURSOR);
    }
  });

  // A real process, set up in cli.tsx's order: the screen entered, then Ink drawing a frame and a second one it holds back
  // for its frame-rate limit, then the way out. Ink's own exit handler (signal-exit, which ink.js registers) would draw
  // that held frame after every `exit` listener, so on the normal screen, if restoreOnExit didn't unmount Ink first. The
  // output and the errors go to one file, to keep their order. SIGTERM and SIGHUP end through process.exit in cli.tsx.
  const TWO = 'ink.rerender(React.createElement(Text, null, "frame two"));';
  const url = (p: string) => JSON.stringify(pathToFileURL(path.resolve(p)).href);
  function run(end: string, { unmount = "() => ink?.unmount()", app = 'React.createElement(Text, null, "frame one")' } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), "tachi-terminal-"));
    try {
      const script = path.join(dir, "script.mjs");
      writeFileSync(
        script,
        `import React from ${url("node_modules/react/index.js")};
import { render, Text, useApp } from ${url("node_modules/ink/build/index.js")};
import { restoreOnExit, restoreWhenInkEnds, Screen, writeBestEffort } from ${url("src/tui/terminal.ts")};
const screen = new Screen((s) => process.stdout.write(s), (s) => writeBestEffort(1, s));
let ink;
restoreOnExit(screen, ${unmount});
screen.enter();
ink = render(${app}, { interactive: true, patchConsole: false, exitOnCtrlC: false });
restoreWhenInkEnds(screen, ink.waitUntilExit());
${end}
`,
      );
      const file = path.join(dir, "out.txt");
      const fd = openSync(file, "w");
      // 10 s, under the 15 s each of these tests allows, so a child that hangs fails its test instead of holding up the run.
      const r = spawnSync(process.execPath, ["--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href, script], {
        stdio: ["ignore", fd, fd],
        timeout: 10_000,
      });
      closeSync(fd);
      const out = readFileSync(file, "utf8");
      const back = out.lastIndexOf(MOUSE_OFF + FIRST_SCREEN + SHOW_CURSOR);
      return { code: r.status, out, before: out.slice(0, back), after: out.slice(back) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Each run starts Node with tsx, about a second, longer with the whole suite running: as tests/cli.test.ts allows.
  it("puts the terminal back when the process exits, after Ink's last frame", { timeout: 15_000 }, () => {
    const r = run(`${TWO} process.exit(0);`);
    expect(r.code).toBe(0);
    expect(r.out.startsWith(SECOND_SCREEN + MOUSE_ON)).toBe(true);
    expect(r.before).toContain("frame two");
    expect(r.after).toBe(MOUSE_OFF + FIRST_SCREEN + SHOW_CURSOR);
  });

  it("puts the terminal back on a crash, after Ink's last frame and before the error", { timeout: 15_000 }, () => {
    const r = run(`${TWO} throw new Error("boom at the end");`);
    expect(r.code).toBe(1);
    expect(r.out.startsWith(SECOND_SCREEN + MOUSE_ON)).toBe(true);
    expect(r.before).toContain("frame two");
    expect(r.after.startsWith(MOUSE_OFF + FIRST_SCREEN + SHOW_CURSOR)).toBe(true);
    expect(r.after).toContain("Error: boom at the end");
    // Node's report has no colour codes off a terminal, so any escape code here would be one written after the restore.
    expect(r.after.slice((MOUSE_OFF + FIRST_SCREEN + SHOW_CURSOR).length)).not.toContain(ESC);
  });

  // A throw inside uncaughtExceptionMonitor would count as Node's own handler failing: exit code 7, and the crash's report
  // lost (found at Task 6's review).
  it("still reports a crash when Ink's unmount fails too, and says so once after putting the terminal back", { timeout: 15_000 }, () => {
    const r = run(`${TWO} throw new Error("original boom");`, { unmount: '() => { throw new Error("unmount broke"); }' });
    expect(r.code).toBe(1);
    expect(r.after.startsWith(MOUSE_OFF + FIRST_SCREEN + SHOW_CURSOR)).toBe(true);
    expect(r.after).toContain("Error: original boom");
    expect(r.after.split("The interface failed while closing: unmount broke")).toHaveLength(2);
  });

  // Ink's ErrorBoundary draws a render error on the second screen and ends with it, and nothing else reports it: Ink
  // swallows its own rejected exit promise (ink.js:277). Found at Task 6's review.
  it("in full screen, says what broke the interface once the terminal is back, and exits with 1", { timeout: 15_000 }, () => {
    const r = run("", { app: 'React.createElement(() => { throw new Error("render broke"); })' });
    expect(r.code).toBe(1);
    expect(r.out.startsWith(SECOND_SCREEN + MOUSE_ON)).toBe(true);
    expect(r.after).toBe(MOUSE_OFF + FIRST_SCREEN + SHOW_CURSOR + "The interface stopped on an error: render broke\n");
  });

  // While the detail view is printed out (`[`, plan Task 13) the normal screen shows, but Ink is suspended and drops its
  // error report with every other drawing, so the error is said on stderr as in full screen.
  it("says what broke the interface when it breaks while the detail view is printed out", { timeout: 15_000 }, () => {
    const app = `React.createElement(() => {
  const { suspendTerminal } = useApp();
  const [broken, setBroken] = React.useState(false);
  React.useEffect(() => {
    screen.setMouse(false);
    void suspendTerminal().then(() => {
      screen.setSecond(false);
      screen.suspended = true;
      setBroken(true);
    });
  }, []);
  if (broken) throw new Error("render broke");
  return React.createElement(Text, null, "frame one");
})`;
    const r = run("", { app });
    expect(r.code).toBe(1);
    expect(r.out.endsWith(FIRST_SCREEN + SHOW_CURSOR + "The interface stopped on an error: render broke\n")).toBe(true);
  });

  // cli.tsx's signal handlers, from exitSignals. Windows cannot send a process SIGBREAK from Node (process.kill gives
  // ENOSYS), so this runs elsewhere only; the timer keeps the child alive until the signal comes.
  it.skipIf(process.platform === "win32")("puts the terminal back on SIGQUIT, and exits with 128 + its number", { timeout: 15_000 }, () => {
    const r = run(`import { constants } from "node:os";
import { exitSignals } from ${url("src/clilib.ts")};
for (const sig of exitSignals(process.platform)) process.on(sig, () => process.exit(128 + constants.signals[sig]));
setTimeout(() => {}, 5000);
process.kill(process.pid, "SIGQUIT");`);
    expect(r.code).toBe(128 + constants.signals.SIGQUIT);
    expect(r.out.startsWith(SECOND_SCREEN + MOUSE_ON)).toBe(true);
    expect(r.after).toBe(MOUSE_OFF + FIRST_SCREEN + SHOW_CURSOR);
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
