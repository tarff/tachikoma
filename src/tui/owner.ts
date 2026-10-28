// The one place that knows who has the terminal (release 6 design, "Tidying the screen code first"; plan, Task 1). The
// flows that hand it over, `[` and /screen, keep their own steps in release 5's order and ask the owner only what their
// flags answered: whether the keyboard can be let go, and whether Ink is suspended. A program in the terminal (Task 12's
// editor) waits its turn here.

export interface Hand {
  suspend(): Promise<{ resume(): Promise<void> }>; // Ink's suspendTerminal()
  hold(on: boolean): void; // InputFilter.hold
  divert(to: ((keys: string) => void) | null): void; // InputFilter.divert
  release(): void; // InputFilter: let go of stdin, so a program reads every key itself
  retake(): void; // InputFilter: read stdin again
}

export interface Handover {
  // Ink's suspend, as the flow calls it; `suspended` is true from this call until the flow calls resume().
  suspend(): Promise<{ resume(): Promise<void> }>;
  done(): void; // lets the keyboard go when no other hand-over still holds it
}

// How many programs have the terminal now, from before Ink's suspend to after its resume, which is when raw mode can be
// off and Ctrl-C comes as SIGINT: cli.tsx's signal handlers ask it, so Ctrl-C there is the program's (clilib.ts, exitOn;
// release 6 plan, choice 31). Counted for the process, as cli.tsx has no owner of its own: the App makes it.
let running = 0;
export const programRunning = () => running > 0;

export class TerminalOwner {
  readonly #hand: Hand;
  #held = 0;
  // Whose suspension it is, a hand-over's or a program call's own token, so one ending clears only its own: a `[` read
  // once a resume starts suspends Ink again before the first is over (found at Task 1's code review).
  #suspendedBy: object | null = null;
  #programs = 0; // running or waiting
  #running = false;
  #ended = false;
  #wake: (() => void)[] = [];

  constructor(hand: Hand) {
    this.#hand = hand;
  }

  // hold(true) at each start, as release 5 does. The count is there so that a print-out taken during a switch, or during
  // a coming back, keeps the hold when the other ends: letting go then would let Ink's suspend turn raw mode off, which
  // left the Windows console reading whole lines (release 5 design, "Switching during a session").
  take(): Handover {
    this.#hand.hold(true);
    this.#held++;
    const token = {};
    let done = false;
    return {
      suspend: async () => {
        this.#suspendedBy = token;
        try {
          const { resume } = await this.#hand.suspend();
          return {
            resume: () => {
              this.#clear(token); // resume() ends the suspension before its first await (Ink's ink.js, endSuspend)
              return resume();
            },
          };
        } catch (e) {
          this.#clear(token);
          throw e;
        }
      },
      done: () => {
        if (done) return;
        done = true;
        this.#clear(token); // a flow that ended without resuming: Ink ended first
        this.#held--;
        if (this.#held > 0) return;
        // Also after end(), as release 5's flows let go again then: harmless (input.ts, hold).
        this.#hand.hold(false);
        this.#next();
      },
    };
  }

  // A `[` then does nothing, as it would suspend Ink again, which throws.
  get suspended(): boolean {
    return this.#suspendedBy !== null;
  }

  // For Task 12's queue: only the queued commands that hand the terminal over (/screen, /settings, /keybindings) wait on
  // it. Messages and other commands go on, as they do while the view is printed out, which holds too.
  get busy(): boolean {
    return this.#held > 0 || this.#programs > 0;
  }

  // Waits until nothing is held, then suspends without the hold, so Ink's raw mode off goes through, and lets go of stdin,
  // so the program reads every key itself. After end(), nothing is taken back: Ink is gone, and stdin and raw mode stay
  // let go so the process can end.
  // A take() can come once its resume starts, Ink reading keys again (a `[`), never before: Ink reads none while
  // suspended, and what would hand the terminal over from the queue waits on `busy` (Task 12; found at Task 1's code
  // review).
  async program<T>(body: () => Promise<T>): Promise<T | undefined> {
    this.#programs++;
    try {
      while (!this.#ended && (this.#held > 0 || this.#running)) await new Promise<void>((resolve) => this.#wake.push(resolve));
      if (this.#ended) return undefined;
      const token = {};
      this.#running = true;
      running++;
      this.#suspendedBy = token;
      try {
        const { resume } = await this.#hand.suspend();
        if (this.#ended) return undefined;
        this.#hand.release();
        try {
          return await body();
        } finally {
          if (!this.#ended) {
            this.#hand.retake();
            this.#clear(token);
            await resume();
          }
        }
      } finally {
        this.#running = false;
        running--;
        this.#clear(token);
        this.#next();
      }
    } finally {
      this.#programs--;
    }
  }

  // Ink unmounting: the keyboard is let go, whatever held it, so raw mode goes off and the process can end.
  end(): void {
    this.#ended = true;
    this.#hand.divert(null);
    this.#hand.hold(false);
    this.#next();
  }

  #clear(token: object): void {
    if (this.#suspendedBy === token) this.#suspendedBy = null;
  }

  #next(): void {
    for (const wake of this.#wake.splice(0)) wake();
  }
}
