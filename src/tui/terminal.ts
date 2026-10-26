// The terminal's second screen and mouse reports (release 5 design, "The two modes" and "The mouse"). Ink's own
// alternate-screen option is set only at the start, so Tachikoma writes the switches itself, and remembers what is on so
// every way out can undo it (design, "When something goes wrong").
import { writeSync } from "node:fs";
import { errorText } from "../core/types.js";

export const SECOND_SCREEN = "\u001b[?1049h";
export const FIRST_SCREEN = "\u001b[?1049l";
// Presses and releases, moves with a button held, in the SGR format: what the probe asked for and got.
export const MOUSE_ON = "\u001b[?1000h\u001b[?1002h\u001b[?1006h";
export const MOUSE_OFF = "\u001b[?1006l\u001b[?1002l\u001b[?1000l";
export const SHOW_CURSOR = "\u001b[?25h";

export class Screen {
  #full = false;
  #mouse = false;
  #restored = false;
  #used = false; // anything ever turned on, so there is anything to undo
  readonly #write: (s: string) => void;
  readonly #writeNow: (s: string) => void;

  // `writeNow` must finish before it returns, and never throw (writeBestEffort below): the exit handlers use it, and the
  // process may end right after.
  constructor(write: (s: string) => void, writeNow: (s: string) => void) {
    this.#write = write;
    this.#writeNow = writeNow;
  }

  get full(): boolean {
    return this.#full;
  }

  get mouse(): boolean {
    return this.#mouse;
  }

  enter(): void {
    this.setSecond(true);
    this.setMouse(true);
  }

  // The mouse goes off first, so the normal screen never catches it.
  leave(): void {
    this.setMouse(false);
    this.setSecond(false);
  }

  // setMouse and setSecond each switch one thing alone, for `[`: it prints the view on the normal screen with the mouse off,
  // then comes back (release 5 design, "The detail view").
  setMouse(on: boolean): void {
    if (on === this.#mouse) return;
    this.#mouse = on;
    this.#used ||= on;
    this.#write(on ? MOUSE_ON : MOUSE_OFF);
  }

  setSecond(on: boolean): void {
    if (on === this.#full) return;
    this.#full = on;
    this.#used ||= on;
    this.#write(on ? SECOND_SCREEN : FIRST_SCREEN);
  }

  // Other codes and printing (OSC 52, `[`) go the same way as the switches, so they stay in order with them.
  write(s: string): void {
    this.#write(s);
  }

  // Every way out ends here, some more than once (a crash and then the exit it causes): only the first writes. The cursor
  // is always shown, as Ink hides it while drawing (release 5 design, "When something goes wrong"). A screen never switched
  // writes nothing, so classic mode, and output sent to a file, stay exactly as in release 4 (found at Task 6's review).
  restore(): void {
    if (this.#restored || !this.#used) return;
    this.#restored = true;
    this.#writeNow((this.#mouse ? MOUSE_OFF : "") + (this.#full ? FIRST_SCREEN : "") + SHOW_CURSOR);
    this.#mouse = false;
    this.#full = false;
  }
}

// Every way out (release 5 design, "When something goes wrong"): /exit and a double Ctrl-C or Ctrl-D unmount Ink and then
// end with `exit`; cli.tsx's SIGTERM, SIGHUP and SIGINT handlers call process.exit, so `exit` too. A crash runs
// `uncaughtExceptionMonitor` before Node prints the error, so the error shows on the normal screen (the plan's choice 18).
// Ink unmounts first: its own exit handler (signal-exit, in ink.js) runs after every `exit` listener and draws the frame
// its frame-rate limit held back, which after leaving would move up over the shell's lines and draw over them.
// An unmount that throws is caught: thrown from uncaughtExceptionMonitor, Node would take it for its own handler failing,
// exit with 7 and never report the crash (found at Task 6's review). It is told on stderr once the terminal is back, and
// only once: a crash's `exit` comes after its monitor.
export function restoreOnExit(screen: Screen, unmount: () => void, proc: Pick<NodeJS.EventEmitter, "on"> = process): void {
  let done = false;
  const out = () => {
    if (done) return;
    done = true;
    let failed = false;
    let error: unknown;
    try {
      unmount();
    } catch (err) {
      failed = true;
      error = err;
    }
    screen.restore();
    if (failed) writeBestEffort(2, `The interface failed while closing: ${errorText(error)}\n`);
  };
  proc.on("exit", out);
  proc.on("uncaughtExceptionMonitor", out);
}

// When Ink ends (found at Task 6's review). After /exit or a double Ctrl-C or Ctrl-D, the terminal goes back at once, not
// when the process ends, which can be a while later. A render error is drawn by Ink's ErrorBoundary on the second screen,
// which leaving would take away, and Ink swallows the rejected exit promise (ink.js:277): so in full screen it is said
// again on stderr once the terminal is back. Ink rejects before the event loop drains, so before `exit`. In classic Ink's
// report stays on screen, as in release 4. Either way the exit code is 1 (the user's choice, 2026-10-27, at Task 6's
// review; release 4 exited 0).
export function restoreWhenInkEnds(screen: Screen, exited: Promise<unknown>): void {
  exited.then(
    () => screen.restore(),
    (err: unknown) => {
      process.exitCode = 1;
      if (!screen.full) return;
      screen.restore();
      writeBestEffort(2, `The interface stopped on an error: ${errorText(err)}\n`);
    },
  );
}

// Writes before returning, and never throws, as Ink's own writeBestEffort: the exit handlers use it, and writeSync throws
// EPIPE when the reader of a pipe has gone, which would turn a quiet exit into a crash, or, from uncaughtExceptionMonitor,
// a crash into Node's exit 7 with its report lost (found at Task 6's review).
export function writeBestEffort(fd: number, s: string): void {
  try {
    writeSync(fd, s);
  } catch {}
}
