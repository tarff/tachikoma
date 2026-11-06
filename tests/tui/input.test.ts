import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render, useInput, usePaste } from "ink";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Bindings, DEFAULTS, strokeOf, tableOf } from "../../src/tui/bindings.js";
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
  resume() {
    this.calls.push("resume");
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

  // Windows Terminal's records come inside pastes too (release 7 plan, Task 22): what could still be one, or the end
  // marker, is held while pasting as well.
  it("holds back, while pasting, only what could still be a record or the end marker", () => {
    const { pieces, state } = run(`${ESC}[200~x${ESC}`);
    expect(pieces).toEqual([{ keys: `${ESC}[200~x` }]);
    expect([state.held, state.pasting]).toEqual([ESC, true]);
    expect(run(`${ESC}[200~x${ESC}y`).pieces).toEqual([{ keys: `${ESC}[200~x${ESC}y` }]);
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

// Windows Terminal's win32 input mode (release 7 plan, Task 22). The records first are the probe's, from the user's
// Windows Terminal (2026-11-05), each key's down and up as they came, one read each; the bytes each becomes are what the
// same terminal sent outside the mode, except Shift+Enter's LF.
describe("split, with win32 records", () => {
  const keysOf = (...reads: string[]) => run(...reads).pieces.flatMap((p) => ("keys" in p ? [p.keys] : [])).join("");
  const shiftDown = `${ESC}[16;42;0;1;48;1_`;

  it("translates the probe's keys: Enter, Shift+Enter, a, Up, Esc and Ctrl+C", () => {
    expect(keysOf(`${ESC}[13;28;13;1;32;1_`, `${ESC}[13;28;13;0;32;1_`)).toBe("\r");
    // Shift down and repeating while held, Enter with Shift, Shift up: one LF, the ctrl+j stroke's byte.
    expect(keysOf(shiftDown, shiftDown, shiftDown, `${ESC}[13;28;13;1;48;1_`, `${ESC}[13;28;13;0;48;1_`, `${ESC}[16;42;0;0;32;1_`)).toBe("\n");
    expect(keysOf(`${ESC}[65;30;97;1;32;1_`, `${ESC}[65;30;97;0;32;1_`)).toBe("a");
    expect(keysOf(`${ESC}[38;72;0;1;288;1_`, `${ESC}[38;72;0;0;288;1_`)).toBe(`${ESC}[A`);
    expect(keysOf(`${ESC}[27;1;27;1;32;1_`, `${ESC}[27;1;27;0;32;1_`)).toBe(ESC);
    expect(keysOf(`${ESC}[17;29;0;1;40;1_`, `${ESC}[67;46;3;1;40;1_`)).toBe("\u0003");
  });

  it("passes the probe's paste through as plain text, dropping the V key-up that follows it", () => {
    const paste = `${ESC}[200~hi there${ESC}[201~`;
    const { pieces, state } = run(
      `${ESC}[17;29;0;1;40;1_`,
      paste,
      `${ESC}[86;47;22;0;40;1_`,
      `${ESC}[17;29;0;0;32;1_`,
      `${ESC}[17;29;0;1;40;1_`,
      `${ESC}[67;46;3;1;40;1_`,
    );
    expect(pieces).toEqual([{ keys: paste }, { keys: "\u0003" }]);
    expect(state).toEqual({ held: "", pasting: false, tail: "" });
  });

  it("holds a record split across two reads until its rest comes", () => {
    const first = run(`${ESC}[13;28;13;1;4`);
    expect(first.pieces).toEqual([]);
    expect(first.state.held).toBe(`${ESC}[13;28;13;1;4`);
    expect(keysOf(`${ESC}[13;28;13;1;4`, "8;1_")).toBe("\n");
    expect(keysOf(ESC, "[65;30;97;1;32;1_")).toBe("a");
  });

  it("keeps records and plain bytes in order in one read", () => {
    expect(keysOf(`x${ESC}[65;30;97;1;32;1_${ESC}[65;30;97;0;32;1_y`)).toBe("xay");
  });

  // Holding what could still be a record holds any CSI with only numbers and semicolons so far, in every terminal.
  it("gives an ordinary sequence split in its numbers whole and unchanged", () => {
    expect(run(`${ESC}[1;5`, "A").pieces).toEqual([{ keys: `${ESC}[1;5A` }]);
  });

  // The user's check (2026-11-05): a pasted line break comes as Enter's records, down and up, Cs 0; a blank line as two
  // pairs. Outside the mode Windows Terminal sends a pasted line break as CR.
  const enter = `${ESC}[13;28;13;1;0;1_${ESC}[13;28;13;0;0;1_`;
  const multi = `${ESC}[200~AGENTS.md (6.3k bytes)${enter}> yes${enter}${enter}I couldn't${ESC}[201~`;
  const multiKeys = `${ESC}[200~AGENTS.md (6.3k bytes)\r> yes\r\rI couldn't${ESC}[201~`;

  it("makes each line break of the user's multi-line paste a CR", () => {
    expect(run(multi)).toEqual({ pieces: [{ keys: multiKeys }], state: { held: "", pasting: false, tail: "" } });
  });

  it("makes the same paste split across reads anywhere, in its records and its markers, the same keys", () => {
    for (let a = 1; a < multi.length; a++) {
      expect(keysOf(multi.slice(0, a), multi.slice(a))).toBe(multiKeys);
      for (let b = a + 1; b < multi.length; b++) expect(keysOf(multi.slice(0, a), multi.slice(a, b), multi.slice(b))).toBe(multiKeys);
    }
  });

  // A record's start and the end marker's are alike (ESC[2), so either is held; `tail` takes it too, so the marker is
  // still found if the 20 ms wait gives the held part to Ink first.
  it("holds a record split inside a paste, and the start of the end marker, with `tail` taking both", () => {
    expect(run(`${ESC}[200~a${ESC}[13;28;1`)).toEqual({
      pieces: [{ keys: `${ESC}[200~a` }],
      state: { held: `${ESC}[13;28;1`, pasting: true, tail: ";28;1" },
    });
    const marker = run(`${ESC}[200~a${ESC}[20`);
    expect(marker.state).toEqual({ held: `${ESC}[20`, pasting: true, tail: `a${ESC}[20` });
    expect(split({ ...marker.state, held: "" }, "1~b")).toEqual({
      pieces: [{ keys: "1~b" }],
      state: { held: "", pasting: false, tail: "" },
    });
  });

  // Windows Terminal takes ESC out of every paste (FilterStringForPaste), so no pasted key makes one: nothing a record
  // inside a paste becomes can end it early.
  // Found at Task 22's review: a key-up types nothing, and would join the ESC before it to the text after it.
  it("drops plain ESCs just before a record inside a paste, so no early end marker forms, in one read or several", () => {
    for (const odd of [
      `${ESC}[200~a${ESC}${ESC}[13;28;13;0;0;1_[201~\rafter`,
      `${ESC}[200~a${ESC}${ESC}${ESC}[13;28;13;0;0;1_[201~\rafter`,
    ]) {
      expect(run(odd)).toEqual({ pieces: [{ keys: `${ESC}[200~a[201~\rafter` }], state: { held: "", pasting: true, tail: "after" } });
      for (let a = 1; a < odd.length; a++) {
        const { pieces, state } = run(odd.slice(0, a), odd.slice(a));
        expect(pieces.flatMap((p) => ("keys" in p ? [p.keys] : [])).join("")).toBe(`${ESC}[200~a[201~\rafter`);
        expect(state.pasting).toBe(true);
      }
    }
  });

  it("drops a record inside a paste whose keys would hold ESC, so the paste goes on to its own end", () => {
    const altBracket = `${ESC}[219;26;91;1;2;1_`; // Alt+[, which outside a paste is ESC [
    const { pieces, state } = run(`${ESC}[200~x${altBracket}201~y${ESC}[38;72;0;1;288;1_z`);
    expect(pieces).toEqual([{ keys: `${ESC}[200~x201~yz` }]);
    expect(state.pasting).toBe(true);
  });

  // Not recorded: the records are built as the spec gives them (microsoft/terminal, doc/specs/#4999), and the bytes are
  // terminalInput.cpp's for each key outside the mode (input.ts says which parts). Cs 32 is NumLock on, as in the probe.
  it("gives the cursor and function keys their usual sequences, with xterm's modifier number", () => {
    const down = (vk: number, cs: number, uc = 0) => `${ESC}[${vk};0;${uc};1;${cs};1_`;
    expect(keysOf(down(38, 32 | 0x100 | 0x10))).toBe(`${ESC}[1;2A`); // Shift+Up
    expect(keysOf(down(36, 32 | 0x100 | 0x8))).toBe(`${ESC}[1;5H`); // Ctrl+Home
    expect(keysOf(down(35, 32 | 0x100 | 0x8))).toBe(`${ESC}[1;5F`); // Ctrl+End
    expect(keysOf(down(37, 32 | 0x100 | 0x2))).toBe(`${ESC}[1;3D`); // Alt+Left
    expect(keysOf(down(46, 32 | 0x100))).toBe(`${ESC}[3~`); // Delete
    expect(keysOf(down(33, 32 | 0x100 | 0x10))).toBe(`${ESC}[5;2~`); // Shift+PgUp
    expect(keysOf(down(112, 32))).toBe(`${ESC}OP`); // F1
    expect(keysOf(down(112, 32 | 0x8))).toBe(`${ESC}[1;5P`); // Ctrl+F1
    expect(keysOf(down(116, 32))).toBe(`${ESC}[15~`); // F5
    expect(keysOf(down(123, 32))).toBe(`${ESC}[24~`); // F12
    expect(keysOf(down(9, 32 | 0x10, 9))).toBe(`${ESC}[Z`); // Shift+Tab
    expect(keysOf(down(9, 32, 9))).toBe("\t");
    expect(keysOf(down(8, 32, 8))).toBe("\u007f"); // Backspace
    expect(keysOf(down(8, 32 | 0x8, 127))).toBe("\b"); // Ctrl+Backspace
    expect(keysOf(down(13, 32 | 0x8, 10))).toBe("\n"); // Ctrl+Enter
  });

  it("puts ESC before a key with Alt, but not with AltGr, which is Ctrl and Alt typing a character", () => {
    expect(keysOf(`${ESC}[86;47;118;1;34;1_`)).toBe(`${ESC}v`); // Alt+V, left Alt
    expect(keysOf(`${ESC}[81;16;64;1;41;1_`)).toBe("@"); // AltGr+Q on a German keyboard: right Alt and left Ctrl
    expect(keysOf(`${ESC}[32;57;32;1;40;1_`)).toBe("\u0000"); // Ctrl+Space
    expect(keysOf(`${ESC}[32;57;0;1;40;1_`)).toBe("\u0000"); // Ctrl+Space with no character
  });

  it("types a key once whatever its Rc, takes left-out numbers as their defaults, and drops a key with no character", () => {
    expect(keysOf(`${ESC}[65;30;97;1;32;3_`)).toBe("a");
    expect(keysOf(`${ESC}[65;30;97;1;32;99999999999_`)).toBe("a"); // a count that would throw in String.repeat
    expect(keysOf(`${ESC}[65;30;97;1_`)).toBe("a"); // the spec's own shortened example
    expect(keysOf(`${ESC}[20;58;0;1;32;1_`)).toBe(""); // CapsLock
  });

  it("joins a character's two halves from two records, across reads and key-ups", () => {
    // 😀 is U+1F600, D83D DE00 in UTF-16, typed as VK_PACKET (231) records.
    expect(keysOf(`${ESC}[231;0;55357;1;32;1_${ESC}[231;0;55357;0;32;1_`, `${ESC}[231;0;56832;1;32;1_`)).toBe("😀");
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

  it("gives Ink a win32 record split across reads as its key once whole, and a lone Escape still after 20 ms", () => {
    vi.useFakeTimers();
    const { reads, feed } = filtered();
    feed(`${ESC}[13;28;13;1;4`);
    vi.advanceTimersByTime(10);
    expect(reads).toEqual([]);
    feed("8;1_");
    expect(reads).toEqual(["\n"]);
    feed(ESC);
    vi.advanceTimersByTime(19);
    expect(reads).toEqual(["\n"]);
    vi.advanceTimersByTime(1);
    expect(reads).toEqual(["\n", ESC]);
  });

  it("passes an ordinary sequence's start with nothing after to Ink, as it was, after 20 ms", () => {
    vi.useFakeTimers();
    const { reads, feed } = filtered();
    feed(`${ESC}[1;5`);
    vi.advanceTimersByTime(19);
    expect(reads).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(reads).toEqual([`${ESC}[1;5`]);
  });

  // Win32 input mode goes with raw mode on the source (cli.tsx; release 7 plan, Task 22), so wherever raw mode goes off,
  // the mode does: Ink's unmount, the end of a hold, a program in the terminal.
  it("tells win32 each time raw mode really goes on or off on the source, and not while held", () => {
    const source = new Source();
    const told: boolean[] = [];
    const filter = new InputFilter(Object.assign(source, { pause() {}, resume() {} }) as never, 20, (on) => told.push(on));
    filter.setRawMode(true);
    filter.hold(true);
    filter.setRawMode(false);
    expect(told).toEqual([true]);
    filter.hold(false);
    filter.release();
    filter.retake();
    filter.setRawMode(false);
    expect(told).toEqual([true, false, false, true, false]);
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

  it("sets the source to utf8 and resumes it, then passes the stream calls on", () => {
    const source = new Source();
    const filter = new InputFilter(source as never);
    expect(filter.isTTY).toBe(true);
    filter.setRawMode(true).setEncoding("utf8").ref().unref();
    filter.setRawMode(false);
    expect(source.calls).toEqual(["setEncoding(utf8)", "resume", "setRawMode(true)", "setEncoding(utf8)", "ref", "unref", "setRawMode(false)"]);
  });

  // The question at the start pauses stdin after its key (cli.tsx, askAtStart), and a data listener alone leaves a stream
  // paused that way: the window then heard no key, Ctrl-C included.
  it("reads a source that was paused before it, with the keys typed meanwhile", async () => {
    const source = Object.assign(new PassThrough(), { setRawMode: () => source, ref: () => source, unref: () => source });
    source.pause();
    source.write("hi");
    const filter = new InputFilter(source as never);
    const reads: string[] = [];
    filter.on("readable", () => {
      let s: string | null;
      while ((s = filter.read()) !== null) reads.push(s);
    });
    await new Promise((r) => setImmediate(r));
    expect(reads).toEqual(["hi"]);
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

  // For a program in the terminal (release 6 plan, Task 1): while released, the keys are the program's, read from the
  // source, and none reaches Ink or the App.
  it("leaves the source's keys to it while released, and reads them again once retaken", () => {
    class Flowing extends Source {
      pause() {
        this.calls.push("pause");
        return this;
      }
    }
    const source = new Flowing();
    const filter = new InputFilter(source as never);
    const reads: string[] = [];
    const data: string[] = [];
    let readable = 0;
    filter.on("readable", () => {
      readable++;
      let s: string | null;
      while ((s = filter.read()) !== null) reads.push(s);
    });
    filter.on("data", (d: string) => data.push(d));
    source.calls = [];
    filter.release();
    expect(source.calls).toEqual(["pause", "setRawMode(false)"]);
    expect(source.listenerCount("data")).toBe(0);
    source.emit("data", "vim keys");
    expect([reads, data, readable]).toEqual([[], [], 0]);
    filter.retake();
    expect(source.calls).toEqual(["pause", "setRawMode(false)", "setRawMode(true)", "resume"]);
    expect(source.listenerCount("data")).toBe(1);
    source.emit("data", "k");
    expect([reads, data]).toEqual([["k"], ["k"]]);
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

  // Through Ink's useInput and the default bindings, as the App reads keys (app/keyRouting.ts): the probe's records for
  // Shift+Enter make a new line and Enter's send.
  it("makes the probe's Shift+Enter chat:newline and its Enter chat:submit, through Ink and the default bindings", async () => {
    const source = new Source();
    const filter = new InputFilter(source as never);
    const bindings = new Bindings(tableOf(DEFAULTS));
    const actions: (string | null)[] = [];
    function Keys() {
      useInput((input, key) => {
        const stroke = strokeOf(input, key);
        const got = stroke && bindings.press(stroke, ["Chat", "Global"], Date.now());
        actions.push(got && "action" in got ? got.action : null);
      });
      return null;
    }
    const app = render(createElement(Keys), {
      stdout: new Terminal() as never,
      stdin: filter as never,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
      interactive: true,
    });
    try {
      await tick();
      const reads = [`${ESC}[16;42;0;1;48;1_`, `${ESC}[13;28;13;1;48;1_`, `${ESC}[13;28;13;0;48;1_`, `${ESC}[16;42;0;0;32;1_`];
      for (const s of [...reads, `${ESC}[13;28;13;1;32;1_`, `${ESC}[13;28;13;0;32;1_`]) {
        source.emit("data", s);
        await tick();
      }
      expect(actions).toEqual(["chat:newline", "chat:submit"]);
    } finally {
      app.unmount();
    }
  });

  // Through Ink's usePaste, as App.tsx takes a paste: it gets the lines with CR between, which App.tsx makes new lines
  // (`text.replace(/\r\n?/g, "\n")`; app.test.tsx has a pasted CR becoming a second line).
  it("gives usePaste the user's multi-line paste with its line breaks, over several reads", async () => {
    const source = new Source();
    const filter = new InputFilter(source as never);
    const pastes: string[] = [];
    function Paste() {
      usePaste((text) => void pastes.push(text));
      return null;
    }
    const app = render(createElement(Paste), {
      stdout: new Terminal() as never,
      stdin: filter as never,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
      interactive: true,
    });
    try {
      await tick();
      const enter = `${ESC}[13;28;13;1;0;1_${ESC}[13;28;13;0;0;1_`;
      const multi = `${ESC}[200~first line${enter}second${enter}${enter}fourth${ESC}[201~`;
      for (const s of [multi.slice(0, 25), multi.slice(25, 60), multi.slice(60)]) source.emit("data", s);
      await tick();
      expect(pastes).toEqual(["first line\rsecond\r\rfourth"]);
    } finally {
      app.unmount();
    }
  });

  // Found at Task 22's review: ESC, a key-up, then `[201~` once ended the paste for Ink, and the CR after it sent.
  it("ends a paste for Ink only at its real end marker, after ESCs just before a key-up", async () => {
    const source = new Source();
    const filter = new InputFilter(source as never);
    const pastes: string[] = [];
    const keys: string[] = [];
    function Paste() {
      usePaste((text) => void pastes.push(text));
      useInput((input) => void keys.push(input));
      return null;
    }
    const app = render(createElement(Paste), {
      stdout: new Terminal() as never,
      stdin: filter as never,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
      interactive: true,
    });
    try {
      await tick();
      source.emit("data", `${ESC}[200~a${ESC}${ESC}[13;28;13;0;0;1_[201~\rafter`);
      await tick();
      expect([pastes, keys]).toEqual([[], []]);
      source.emit("data", `${ESC}[201~`);
      await tick();
      expect([pastes, keys]).toEqual([["a[201~\rafter"], []]);
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
