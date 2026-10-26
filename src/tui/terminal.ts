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
  readonly #write: (s: string) => void;
  readonly #writeNow: (s: string) => void;

  // `writeNow` must finish before it returns: the exit handlers use it, and the process may end right after.
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
    this.#write(on ? MOUSE_ON : MOUSE_OFF);
  }

  setSecond(on: boolean): void {
    if (on === this.#full) return;
    this.#full = on;
    this.#write(on ? SECOND_SCREEN : FIRST_SCREEN);
  }

  // Other codes and printing (OSC 52, `[`) go the same way as the switches, so they stay in order with them.
  write(s: string): void {
    this.#write(s);
  }

  // Every way out ends here, some more than once (a crash and then the exit it causes): only the first writes. The cursor
  // is always shown, as Ink hides it while drawing (release 5 design, "When something goes wrong").
  restore(): void {
    if (this.#restored) return;
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
    // writeSync, as the process may end right after.
    if (failed) writeSync(2, `The interface failed while closing: ${errorText(error)}\n`);
  };
  proc.on("exit", out);
  proc.on("uncaughtExceptionMonitor", out);
}
