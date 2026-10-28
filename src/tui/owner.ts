// The one place that knows who has the terminal (release 6 design, "Tidying the screen code first"; plan, Task 1). The
// flows that hand it over, `[` and /screen, keep their own steps in release 5's order and ask the owner only what their
// flags answered: whether the keyboard can be let go, and whether Ink is suspended. A program in the terminal (Task 12's
// editor) waits its turn here.

export interface Hand {
  suspend(): Promise<{ resume(): Promise<void> }>; // Ink's suspendTerminal()
  hold(on: boolean): void; // InputFilter.hold
  divert(to: ((s: string) => void) | null): void; // InputFilter.divert
  release(): void; // InputFilter: let go of stdin, so a program reads every key itself
  retake(): void; // InputFilter: read stdin again
}

export interface Handover {
  // Ink's suspend, as the flow calls it; `suspended` is true from this call until the flow calls resume().
  suspend(): Promise<{ resume(): Promise<void> }>;
  done(): void; // lets the keyboard go when no other hand-over still holds it
}

export class TerminalOwner {
  readonly #hand: Hand;
  #held = 0;
  #suspended = false;
  #programs = 0; // running or waiting
  #running = false;
  #ended = false;
  #wake: (() => void)[] = [];

  constructor(hand: Hand) {
    this.#hand = hand;
  }

  // hold(true) at each start, as release 5 does; a print-out started while a switch or a coming back still holds keeps the
  // hold, as the count is not yet down to none.
  take(): Handover {
    this.#hand.hold(true);
    this.#held++;
    let suspended = false;
    let done = false;
    return {
      suspend: async () => {
        suspended = this.#suspended = true;
        try {
          const { resume } = await this.#hand.suspend();
          return {
            resume: () => {
              if (suspended) suspended = this.#suspended = false; // resume() ends the suspension before its first await (Ink's ink.js, endSuspend)
              return resume();
            },
          };
        } catch (e) {
          suspended = this.#suspended = false;
          throw e;
        }
      },
      done: () => {
        if (done) return;
        done = true;
        if (suspended) suspended = this.#suspended = false; // a flow that ended without resuming: Ink ended first
        if (--this.#held > 0) return;
        // Also after end(), as release 5's flows let go again then: harmless (input.ts, hold).
        this.#hand.hold(false);
        this.#next();
      },
    };
  }

  // A `[` then does nothing, as it would suspend Ink again, which throws.
  get suspended(): boolean {
    return this.#suspended;
  }

  get busy(): boolean {
    return this.#held > 0 || this.#programs > 0;
  }

  // Waits until nothing is held, then suspends without the hold, so Ink's raw mode off goes through, and lets go of stdin,
  // so the program reads every key itself. After end(), nothing is taken back: Ink is gone, and stdin and raw mode stay
  // let go so the process can end.
  async program<T>(body: () => Promise<T>): Promise<T | undefined> {
    this.#programs++;
    try {
      while (!this.#ended && (this.#held > 0 || this.#running)) await new Promise<void>((resolve) => this.#wake.push(resolve));
      if (this.#ended) return undefined;
      this.#running = this.#suspended = true;
      try {
        const { resume } = await this.#hand.suspend();
        if (this.#ended) return undefined;
        this.#hand.release();
        try {
          return await body();
        } finally {
          if (!this.#ended) {
            this.#hand.retake();
            this.#suspended = false;
            await resume();
          }
        }
      } finally {
        this.#running = this.#suspended = false;
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

  #next(): void {
    for (const wake of this.#wake.splice(0)) wake();
  }
}
