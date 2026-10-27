import { EventEmitter } from "node:events";
import { render, useInput } from "ink";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InputFilter, type Mouse, type Piece, readOut, split } from "../../src/tui/input.js";

const ESC = "\u001b";
const none = { shift: false, alt: false, ctrl: false };
const left = (kind: Mouse["kind"], x: number, y: number): Mouse => ({ kind, button: "left", x, y, ...none });

// Each read through split in turn, as the filter does, with every piece in order.
function run(...chunks: string[]) {
  let state = { held: "", pasting: false, tail: "" };
  const pieces: Piece[] = [];
  for (const chunk of chunks) {
    const out = split(state, chunk);
    pieces.push(...out.pieces);
    state = out.state;
  }
  return { pieces, state };
}

// A stand-in for process.stdin that records what reaches it.
class Source extends EventEmitter {
  calls: string[] = [];
  setRawMode(on: boolean) {
    this.calls.push(`setRawMode(${on})`);
    return this;
  }
  setEncoding(e: string) {
    this.calls.push(`setEncoding(${e})`);
    return this;
  }
  ref() {
    this.calls.push("ref");
    return this;
  }
  unref() {
    this.calls.push("unref");
    return this;
  }
}

// A filter on a stand-in, read as Ink reads it: every `readable` is read until null.
function filtered() {
  const source = new Source();
  const filter = new InputFilter(source as never);
  const reads: string[] = [];
  const mice: Mouse[] = [];
  filter.on("readable", () => {
    let s: string | null;
    while ((s = filter.read()) !== null) reads.push(s);
  });
  filter.on("mouse", (m: Mouse) => mice.push(m));
  return { source, filter, reads, mice, feed: (s: string) => source.emit("data", s) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("split", () => {
  it("takes out each report from the probe", () => {
    const one = (report: string) => run(report).pieces;
    expect(one(`${ESC}[<64;10;5M`)).toEqual([{ mouse: { kind: "wheel", button: "none", wheel: "up", x: 9, y: 4, ...none } }]);
    expect(one(`${ESC}[<65;10;5M`)).toEqual([{ mouse: { kind: "wheel", button: "none", wheel: "down", x: 9, y: 4, ...none } }]);
    expect(one(`${ESC}[<0;10;6M`)).toEqual([{ mouse: left("press", 9, 5) }]);
    expect(one(`${ESC}[<32;11;6M`)).toEqual([{ mouse: left("drag", 10, 5) }]);
    expect(one(`${ESC}[<0;40;9m`)).toEqual([{ mouse: left("release", 39, 8) }]);
    expect(one(`${ESC}[<2;5;5M`)).toEqual([{ mouse: { kind: "press", button: "right", x: 4, y: 4, ...none } }]);
    expect(one(`${ESC}[<20;1;1M`)).toEqual([{ mouse: { kind: "press", button: "left", x: 0, y: 0, shift: true, alt: false, ctrl: true } }]);
  });

  it("joins a report split over two reads into one press, with nothing for Ink", () => {
    const first = run(`${ESC}[<0;1`);
    expect(first.pieces).toEqual([]);
    expect(first.state.held).toBe(`${ESC}[<0;1`);
    expect(run(`${ESC}[<0;1`, "2;5M").pieces).toEqual([{ mouse: left("press", 11, 4) }]);
  });

  it("keeps keys and reports in order", () => {
    expect(run(`a${ESC}[<0;1;1Mb`).pieces).toEqual([{ keys: "a" }, { mouse: left("press", 0, 0) }, { keys: "b" }]);
  });

  it("takes nothing out of a paste, so a report's shape inside one reaches Ink whole", () => {
    const paste = `${ESC}[200~x${ESC}[<0;1;1My${ESC}[201~`;
    expect(run(paste)).toEqual({ pieces: [{ keys: paste }], state: { held: "", pasting: false, tail: "" } });
  });

  it("finds a paste's markers split across reads, and takes out a report after the end", () => {
    const { pieces, state } = run(`${ESC}[20`, `0~x${ESC}[<0;1;1My`, `${ESC}[2`, `01~${ESC}[<0;3;4M`);
    const keys = pieces.flatMap((p) => ("keys" in p ? [p.keys] : []));
    expect(keys.join("")).toBe(`${ESC}[200~x${ESC}[<0;1;1My${ESC}[201~`);
    expect(pieces.filter((p) => "mouse" in p)).toEqual([{ mouse: left("press", 2, 3) }]);
    expect(pieces.at(-1)).toEqual({ mouse: left("press", 2, 3) });
    expect(state).toEqual({ held: "", pasting: false, tail: "" });
  });

  it("holds nothing back while pasting", () => {
    const { pieces, state } = run(`${ESC}[200~x${ESC}`);
    expect(pieces).toEqual([{ keys: `${ESC}[200~x${ESC}` }]);
    expect([state.held, state.pasting]).toEqual(["", true]);
  });

  // Every whole report is taken out (design, "Reading it"); one the screen doesn't use is dropped, as Ink would type it.
  it("drops a whole report with a bit the format doesn't name, or a sideways wheel, keeping the keys around it", () => {
    for (const odd of [`${ESC}[<128;1;1M`, `${ESC}[<66;1;1M`]) expect(run(odd).pieces).toEqual([]);
    expect(run(`a${ESC}[<67;1;1Mb`).pieces).toEqual([{ keys: "a" }, { keys: "b" }]);
  });

  it("passes a malformed report, which can never become one, to Ink as it was", () => {
    expect(run(`${ESC}[<0;1x`).pieces).toEqual([{ keys: `${ESC}[<0;1x` }]);
  });
});

// The reads while the detail view is printed out (release 5 design, "The detail view"; plan, Task 13).
describe("readOut", () => {
  const START = `${ESC}[200~`;
  const END = `${ESC}[201~`;

  it("comes back on q, Esc or Ctrl-C anywhere in a read, and not on other keys", () => {
    for (const keys of ["q", ESC, "\u0003", "xq", "abcq"]) expect(readOut(undefined, keys)).toEqual({ back: true, paste: undefined });
    for (const keys of ["x", "Q", `${ESC}[A`, `${ESC}OP`]) expect(readOut(undefined, keys)).toEqual({ back: false, paste: undefined });
  });

  it("takes Escape with a letter after it as Alt and that letter, not Esc and q", () => {
    expect(readOut(undefined, `${ESC}q`).back).toBe(false);
  });

  it("takes two Escapes read together as Esc", () => {
    expect(readOut(undefined, `${ESC}${ESC}`).back).toBe(true);
  });

  it("drops a paste whole, keeping its last 5 characters, one short of its end marker, until the marker comes", () => {
    expect(readOut(undefined, `${START}q${ESC}`)).toEqual({ back: false, paste: `q${ESC}` });
    expect(readOut(undefined, `${START}abcdefgh`)).toEqual({ back: false, paste: "defgh" });
    expect(readOut("defgh", `q${END}`)).toEqual({ back: false, paste: undefined });
    expect(readOut("defgh", `q${END}q`)).toEqual({ back: true, paste: undefined });
  });

  it("finds an end marker split between two reads", () => {
    const first = readOut(undefined, `${START}ab${ESC}[20`);
    expect(first).toEqual({ back: false, paste: `b${ESC}[20` });
    expect(readOut(first.paste, "1~")).toEqual({ back: false, paste: undefined });
    expect(readOut(first.paste, "1~q")).toEqual({ back: true, paste: undefined });
  });

  it("keeps a paste that starts after the key coming back, so its rest is dropped too", () => {
    const first = readOut(undefined, `q${START}ab`);
    expect(first).toEqual({ back: true, paste: "ab" });
    expect(readOut(first.paste, `cq${END}`)).toEqual({ back: false, paste: undefined });
    expect(readOut(undefined, `q${START}ab${END}`)).toEqual({ back: true, paste: undefined });
  });
});

describe("InputFilter", () => {
  it("passes a lone Escape to Ink after 20 ms, not at 19", () => {
    vi.useFakeTimers();
    const { reads, feed } = filtered();
    feed(ESC);
    vi.advanceTimersByTime(19);
    expect(reads).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(reads).toEqual([ESC]);
  });

  it("passes the start of a report with nothing after to Ink, as it was, after 20 ms", () => {
    vi.useFakeTimers();
    const { reads, mice, feed } = filtered();
    feed(`${ESC}[<0;12`);
    vi.advanceTimersByTime(19);
    expect(reads).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(reads).toEqual([`${ESC}[<0;12`]);
    expect(mice).toEqual([]);
  });

  it("starts the 20 ms again with each read that still could be a report", () => {
    vi.useFakeTimers();
    const { reads, feed } = filtered();
    feed(ESC);
    vi.advanceTimersByTime(15);
    feed("[<");
    vi.advanceTimersByTime(19);
    expect(reads).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(reads).toEqual([`${ESC}[<`]);
  });

  it("gives Ink an Escape and the rest of Up that comes within 20 ms as one read", () => {
    vi.useFakeTimers();
    const { reads, feed } = filtered();
    feed(ESC);
    vi.advanceTimersByTime(10);
    feed("[A");
    expect(reads).toEqual([`${ESC}[A`]);
    vi.advanceTimersByTime(20);
    expect(reads).toEqual([`${ESC}[A`]);
  });

  it("gives what is waiting to read(), then null", () => {
    const source = new Source();
    const filter = new InputFilter(source as never);
    source.emit("data", `a${ESC}[<0;1;1Mb`);
    expect([filter.read(), filter.read(), filter.read()]).toEqual(["a", "b", null]);
  });

  it("sets the source to utf8, then passes the stream calls on", () => {
    const source = new Source();
    const filter = new InputFilter(source as never);
    expect(filter.isTTY).toBe(true);
    filter.setRawMode(true).setEncoding("utf8").ref().unref();
    filter.setRawMode(false);
    expect(source.calls).toEqual(["setEncoding(utf8)", "setRawMode(true)", "setEncoding(utf8)", "ref", "unref", "setRawMode(false)"]);
  });

  it("while held, keeps raw mode off and unref from the source, and passes everything after", () => {
    const source = new Source();
    const filter = new InputFilter(source as never);
    source.calls = [];
    filter.hold(true);
    filter.setRawMode(false).unref().setRawMode(true).ref();
    expect(source.calls).toEqual(["setRawMode(true)", "ref"]);
    filter.hold(false);
    filter.setRawMode(false).unref();
    expect(source.calls).toEqual(["setRawMode(true)", "ref", "setRawMode(false)", "unref"]);
  });

  it("passes on, when the hold ends, an off and an unref that were Ink's last word while held", () => {
    const source = new Source();
    const filter = new InputFilter(source as never);
    source.calls = [];
    filter.hold(true);
    filter.setRawMode(false).unref();
    filter.hold(false);
    expect(source.calls).toEqual(["setRawMode(false)", "unref"]);
  });

  it("passes no off when the hold ends if Ink turned raw mode back on while held", () => {
    const source = new Source();
    const filter = new InputFilter(source as never);
    source.calls = [];
    filter.hold(true);
    filter.setRawMode(false).setRawMode(true);
    filter.hold(false);
    expect(source.calls).toEqual(["setRawMode(true)"]);
  });

  it("emits each piece of keys as data, as a stream does, but not reports nor diverted keys", () => {
    const { filter, feed } = filtered();
    const data: string[] = [];
    filter.on("data", (d: string) => data.push(d));
    feed(`a${ESC}[<64;1;1Mb`);
    filter.divert(() => {});
    feed("c");
    expect(data).toEqual(["a", "b"]);
  });

  it("puts unshifted text, from bytes or a string, back in front of the waiting keys", () => {
    const source = new Source();
    const filter = new InputFilter(source as never);
    let readable = 0;
    filter.on("readable", () => readable++);
    source.emit("data", "z");
    filter.unshift(new TextEncoder().encode("é1"));
    filter.unshift("0");
    expect(readable).toBe(3);
    expect([filter.read(), filter.read(), filter.read(), filter.read()]).toEqual(["0", "é1", "z", null]);
  });

  it("tells a readable listener added later that keys are waiting, on the next tick", async () => {
    const source = new Source();
    const filter = new InputFilter(source as never);
    source.emit("data", "k");
    const reads: string[] = [];
    filter.on("readable", () => {
      let s: string | null;
      while ((s = filter.read()) !== null) reads.push(s);
    });
    expect(reads).toEqual([]);
    await new Promise((r) => process.nextTick(r));
    expect(reads).toEqual(["k"]);
  });

  it("sends keys elsewhere and drops reports while diverted, then returns to Ink", () => {
    const { filter, reads, mice, feed } = filtered();
    const elsewhere: string[] = [];
    filter.divert((keys) => elsewhere.push(keys));
    feed(`q${ESC}[<64;1;1Mw`);
    expect([elsewhere, reads, mice]).toEqual([["q", "w"], [], []]);
    filter.divert(null);
    feed(`e${ESC}[<64;1;1M`);
    expect(elsewhere).toEqual(["q", "w"]);
    expect(reads).toEqual(["e"]);
    expect(mice).toHaveLength(1);
  });
});

describe("InputFilter with Ink", () => {
  const tick = () => new Promise((r) => setTimeout(r, 50)); // prompt.test.tsx's wait for Ink to draw

  // A stand-in terminal, as in prompt.test.tsx, that records what Ink writes.
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

  // A component that records every key useInput sees, rendered through a filter on a stand-in source.
  function inked(kitty: boolean) {
    const source = new Source();
    const filter = new InputFilter(source as never);
    const terminal = new Terminal();
    const seen: string[] = [];
    function Keys() {
      useInput((input) => {
        seen.push(input);
      });
      return null;
    }
    const app = render(createElement(Keys), {
      stdout: terminal as never,
      stdin: filter as never,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
      interactive: true,
      ...(kitty ? { kittyKeyboard: { mode: "auto" as const } } : {}),
    });
    return { source, filter, terminal, seen, app };
  }

  it("lets useInput see the keys and nothing of a wheel report, which comes out as one mouse event", async () => {
    const { source, filter, seen, app } = inked(false);
    const mice: Mouse[] = [];
    filter.on("mouse", (m: Mouse) => mice.push(m));
    try {
      await tick();
      for (const s of ["x", `${ESC}[<64;10;5M`, "y"]) {
        source.emit("data", s);
        await tick();
      }
      expect(seen).toEqual(["x", "y"]);
      expect(mice).toEqual([{ kind: "wheel", button: "none", wheel: "up", x: 9, y: 4, ...none }]);
    } finally {
      app.unmount();
    }
  });

  // Ink's kitty check (confirmKittySupport in Ink's ink.js) listens for "data" after asking with ESC[?u, and turns the
  // protocol on with ESC[>...u when the terminal answers ESC[?<flags>u.
  it("lets Ink's kitty check hear the terminal's answer and turn the protocol on", async () => {
    const { source, terminal, app } = inked(true);
    try {
      expect(terminal.out).toContain(`${ESC}[?u`);
      source.emit("data", `${ESC}[?1u`);
      await tick();
      expect(terminal.out).toMatch(/\u001b\[>\d+u/);
    } finally {
      app.unmount();
    }
  });

  // A key typed during the check reaches useInput twice: Ink reads it, and the check also hears it as "data" and hands it
  // back with unshift. Ink 7.1.1 does the same with a plain stream; this records what Ink does today, not what it should.
  it("gets a key typed during Ink's unanswered kitty check through unshift, which Ink 7.1.1 delivers twice", async () => {
    const { source, seen, app } = inked(true);
    try {
      source.emit("data", "a"); // at once, so it is inside the check however slow the machine
      await new Promise((r) => setTimeout(r, 200)); // past the check's 200 ms (setTimeout(cleanup, 200) in Ink's ink.js)
      expect(seen).toEqual(["a", "a"]);
    } finally {
      app.unmount();
    }
  });

  it("loses no keys typed after Ink's kitty check goes unanswered, and gives each once", async () => {
    const { source, terminal, seen, app } = inked(true);
    try {
      await new Promise((r) => setTimeout(r, 250)); // past the check's 200 ms (setTimeout(cleanup, 200) in Ink's ink.js)
      for (const s of ["x", "y"]) {
        source.emit("data", s);
        await tick();
      }
      expect(seen).toEqual(["x", "y"]);
      expect(terminal.out).not.toMatch(/\u001b\[>\d+u/);
    } finally {
      app.unmount();
    }
  });
});
