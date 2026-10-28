import { describe, expect, it } from "vitest";
import { type Hand, TerminalOwner } from "../../src/tui/owner.js";

// A stand-in hand that records each call in order; Ink's suspend and resume each take a turn of the event loop.
// `onResume` runs as Ink's resume starts, when Ink reads keys again.
function hand(onResume?: () => void) {
  const calls: string[] = [];
  const turn = () => new Promise((r) => setImmediate(r));
  const h: Hand = {
    suspend: async () => {
      calls.push("suspend");
      await turn();
      return {
        resume: async () => {
          calls.push("resume");
          onResume?.();
          await turn();
        },
      };
    },
    hold: (on) => calls.push(`hold(${on})`),
    divert: (keys) => calls.push(keys ? "divert(reader)" : "divert(null)"),
    release: () => calls.push("release"),
    retake: () => calls.push("retake"),
  };
  return { h, calls };
}

// A program body that records that it started, and ends only when told.
function blocked(calls: string[], name: string) {
  let started!: () => void;
  let finish!: () => void;
  const begun = new Promise<void>((r) => (started = r));
  const body = () => {
    calls.push(name);
    started();
    return new Promise<void>((r) => (finish = r));
  };
  return { body, begun, finish: () => finish() };
}

describe("TerminalOwner's hand-overs", () => {
  it.each([
    { name: "first", order: [0, 1] },
    { name: "second", order: [1, 0] },
  ])("holds at each start and lets go once, after the last done(), the $name done first", ({ order }) => {
    const { h, calls } = hand();
    const owner = new TerminalOwner(h);
    const both = [owner.take(), owner.take()];
    expect(calls).toEqual(["hold(true)", "hold(true)"]);
    expect(owner.busy).toBe(true);
    both[order[0]!]!.done();
    expect(calls).toEqual(["hold(true)", "hold(true)"]);
    both[order[1]!]!.done();
    expect(calls).toEqual(["hold(true)", "hold(true)", "hold(false)"]);
    expect(owner.busy).toBe(false);
  });

  it("lets go once for a hand-over done twice", () => {
    const { h, calls } = hand();
    const owner = new TerminalOwner(h);
    const over = owner.take();
    over.done();
    over.done();
    expect(calls).toEqual(["hold(true)", "hold(false)"]);
    expect(owner.busy).toBe(false);
  });

  it("is suspended from the hand-over's suspend() until the flow calls the resume it returned", async () => {
    const { h, calls } = hand();
    const owner = new TerminalOwner(h);
    const over = owner.take();
    expect(owner.suspended).toBe(false);
    const going = over.suspend();
    expect(calls.at(-1)).toBe("suspend"); // Ink's suspend is called at once, in the flow's own step
    expect(owner.suspended).toBe(true);
    const { resume } = await going;
    expect(owner.suspended).toBe(true);
    const back = resume();
    expect(owner.suspended).toBe(false);
    await back;
    over.done();
    expect(owner.suspended).toBe(false);
  });

  it("is no longer suspended once a suspend throws", async () => {
    const { h } = hand();
    h.suspend = async () => {
      throw new Error("no terminal");
    };
    const owner = new TerminalOwner(h);
    const over = owner.take();
    await expect(over.suspend()).rejects.toThrow("no terminal");
    expect(owner.suspended).toBe(false);
  });

  it("is no longer suspended once a hand-over that never resumed is done", async () => {
    const { h } = hand();
    const owner = new TerminalOwner(h);
    const over = owner.take();
    await over.suspend();
    over.done();
    expect(owner.suspended).toBe(false);
  });

  it("stays suspended for a second hand-over when the first, already resumed, is done", async () => {
    const { h } = hand();
    const owner = new TerminalOwner(h);
    const a = owner.take();
    const { resume } = await a.suspend();
    await resume();
    const b = owner.take();
    void b.suspend();
    a.done();
    expect(owner.suspended).toBe(true);
  });

  it("lets go on end(), and again for a hand-over done after it", () => {
    const { h, calls } = hand();
    const owner = new TerminalOwner(h);
    const over = owner.take();
    owner.end();
    expect(calls).toEqual(["hold(true)", "divert(null)", "hold(false)"]);
    over.done();
    expect(calls).toEqual(["hold(true)", "divert(null)", "hold(false)", "hold(false)"]);
  });
});

describe("TerminalOwner's program", () => {
  it("suspends without the hold, releases before the body, then retakes and resumes after it", async () => {
    const { h, calls } = hand();
    const owner = new TerminalOwner(h);
    const ran = owner.program(async () => {
      calls.push("body");
      expect(owner.busy).toBe(true);
      return 7;
    });
    expect(await ran).toBe(7);
    expect(calls).toEqual(["suspend", "release", "body", "retake", "resume"]);
    expect(owner.busy).toBe(false);
  });

  it("retakes and resumes after a body that throws, and the throw passes on", async () => {
    const { h, calls } = hand();
    const owner = new TerminalOwner(h);
    await expect(
      owner.program(async () => {
        throw new Error("editor failed");
      }),
    ).rejects.toThrow("editor failed");
    expect(calls).toEqual(["suspend", "release", "retake", "resume"]);
    expect(owner.busy).toBe(false);
  });

  it("passes on a suspend that throws, suspended and busy no longer, and runs the next program", async () => {
    const { h, calls } = hand();
    const suspend = h.suspend;
    h.suspend = async () => {
      h.suspend = suspend;
      throw new Error("no terminal");
    };
    const owner = new TerminalOwner(h);
    await expect(owner.program(async () => void calls.push("first"))).rejects.toThrow("no terminal");
    expect(owner.suspended).toBe(false);
    expect(owner.busy).toBe(false);
    await owner.program(async () => void calls.push("second"));
    expect(calls).toEqual(["suspend", "release", "second", "retake", "resume"]);
  });

  it("starts only after a hand-over held is done, busy while it waits", async () => {
    const { h, calls } = hand();
    const owner = new TerminalOwner(h);
    const over = owner.take();
    const ran = owner.program(async () => void calls.push("body"));
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual(["hold(true)"]);
    expect(owner.busy).toBe(true);
    over.done();
    expect(owner.busy).toBe(true);
    await ran;
    expect(calls).toEqual(["hold(true)", "hold(false)", "suspend", "release", "body", "retake", "resume"]);
    expect(owner.busy).toBe(false);
  });

  it("starts a second program only after the first's resume", async () => {
    const { h, calls } = hand();
    const owner = new TerminalOwner(h);
    const a = blocked(calls, "a");
    const ranA = owner.program(a.body);
    await a.begun;
    const ranB = owner.program(async () => void calls.push("b"));
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual(["suspend", "release", "a"]);
    a.finish();
    await Promise.all([ranA, ranB]);
    expect(calls).toEqual(["suspend", "release", "a", "retake", "resume", "suspend", "release", "b", "retake", "resume"]);
  });

  // Suspended from the start, so a `[` read with the key that started the program does nothing.
  it("is suspended from program()'s start until its resume", async () => {
    let atResume: boolean | undefined;
    const { h } = hand(() => (atResume = owner.suspended));
    const owner = new TerminalOwner(h);
    let during = false;
    const ran = owner.program(async () => {
      during = owner.suspended;
    });
    expect(owner.suspended).toBe(true);
    await ran;
    expect(during).toBe(true);
    expect(atResume).toBe(false);
    expect(owner.suspended).toBe(false);
  });

  // Found at Task 1's code review: Ink reads keys again once the program's resume starts, and a `[` then takes the
  // terminal and suspends Ink; the program's ending must leave that suspension standing.
  it("leaves a hand-over taken during its resume suspended", async () => {
    const { h } = hand(() => void owner.take().suspend());
    const owner = new TerminalOwner(h);
    await owner.program(async () => {});
    expect(owner.suspended).toBe(true);
  });

  it("neither retakes nor resumes when the body ends after end(), leaving stdin and raw mode let go", async () => {
    const { h, calls } = hand();
    const owner = new TerminalOwner(h);
    const p = blocked(calls, "body");
    const ran = owner.program(p.body);
    await p.begun;
    expect(calls).toEqual(["suspend", "release", "body"]);
    owner.end();
    p.finish();
    await ran;
    expect(calls).toEqual(["suspend", "release", "body", "divert(null)", "hold(false)"]);
  });

  it("resolves undefined without suspending, releasing or retaking when end() comes while it waits behind a hand-over", async () => {
    const { h, calls } = hand();
    const owner = new TerminalOwner(h);
    owner.take();
    const ran = owner.program(async () => void calls.push("body"));
    owner.end();
    expect(await ran).toBeUndefined();
    expect(calls).toEqual(["hold(true)", "divert(null)", "hold(false)"]);
    expect(owner.busy).toBe(true); // the hand-over is still held: its flow's ending lets go
  });
});
