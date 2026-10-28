import { describe, expect, it } from "vitest";
import { apply, empty, insertPicture, load } from "../../src/tui/editor.js";
import { joined, marker, messageParts, Pictures, trimmed, without } from "../../src/tui/pictures.js";

// Small stand-ins for pictures: no test reads a real file or the clipboard (release 6 plan, "Before you start").
const png = { mediaType: "image/png" as const, data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) };
const jpeg = { mediaType: "image/jpeg" as const, data: Buffer.from([0xff, 0xd8, 0xff]) };

describe("Pictures", () => {
  it("numbers pictures through the session, each reading until its read ends", async () => {
    const p = new Pictures();
    expect([p.next(), p.next()]).toEqual([1, 2]);
    expect(p.get(1)).toBe("reading");
    expect(p.get(3)).toBeUndefined();
    let ended = false;
    const waiting = p.settled(1).then(() => (ended = true));
    await Promise.resolve();
    expect(ended).toBe(false);
    p.set(1, png);
    await waiting;
    expect(p.get(1)).toEqual(png);
  });

  it("settles a read however it ends, and keeps the first ending", async () => {
    const p = new Pictures();
    const [a, b] = [p.next(), p.next()];
    p.set(a, "none");
    p.set(b, { failed: "stopped" });
    await Promise.all([p.settled(a), p.settled(b)]);
    p.set(b, png); // a reader answering after Esc stopped its read
    expect([p.get(a), p.get(b)]).toEqual(["none", { failed: "stopped" }]);
  });

  it("remembers which pictures were sent", () => {
    const p = new Pictures();
    const id = p.next();
    expect(p.sent(id)).toBe(false);
    p.markSent(id);
    expect(p.sent(id)).toBe(true);
  });
});

describe("messageParts", () => {
  // A prompt typed with pictures in it, a number being a picture's: as the editor holds it.
  const prompt = (...pieces: (string | number)[]) =>
    pieces.reduce((e, x) => (typeof x === "number" ? insertPicture(e, x) : apply(e, { type: "insert", text: x })), empty);

  it("puts each picture where its span is, in order, and marks it sent", () => {
    const p = new Pictures();
    const [one, two] = [p.next(), p.next()];
    p.set(one, png);
    p.set(two, jpeg);
    expect(messageParts(prompt("compare ", one, " with ", two, " please"), p)).toEqual([
      { type: "text", text: "compare " },
      { type: "image", id: one, ...png },
      { type: "text", text: " with " },
      { type: "image", id: two, ...jpeg },
      { type: "text", text: " please" },
    ]);
    expect([p.sent(one), p.sent(two)]).toEqual([true, true]);
  });

  it("keeps a picture already sent as its marker's text", () => {
    const p = new Pictures();
    const one = p.next();
    p.set(one, png);
    p.markSent(one);
    expect(messageParts(prompt("again ", one), p)).toEqual([{ type: "text", text: "again [Image #1]" }]);
  });

  it("sends a picture with two spans once, at the first; the second is text", () => {
    const p = new Pictures();
    const one = p.next();
    p.set(one, png);
    expect(messageParts(prompt(one, " and ", one), p)).toEqual([
      { type: "image", id: one, ...png },
      { type: "text", text: " and [Image #1]" },
    ]);
  });

  it("keeps typed marker text with no span as text", () => {
    const p = new Pictures();
    p.set(p.next(), png);
    expect(messageParts({ text: "see [Image #1]", spans: [] }, p)).toEqual([{ type: "text", text: "see [Image #1]" }]);
  });

  it("leaves out text of only blanks between two pictures", () => {
    const p = new Pictures();
    const [one, two] = [p.next(), p.next()];
    p.set(one, png);
    p.set(two, jpeg);
    expect(messageParts(prompt(one, " ", two), p).map((x) => x.type)).toEqual(["image", "image"]);
  });
});

describe("drafts", () => {
  const d = insertPicture(insertPicture(load(empty, "  a "), 1), 2); // "  a [Image #1][Image #2]"

  it("trims the text, the spans moving with it", () => {
    const t = trimmed({ text: `${d.text}\n`, spans: d.spans });
    expect(t.text).toBe("a [Image #1][Image #2]");
    expect(t.spans.map((s) => t.text.slice(s.from, s.to))).toEqual([marker(1), marker(2)]);
  });

  it("joins drafts, each one's spans moved along", () => {
    const j = joined([{ text: "x", spans: [] }, d], "\n\n");
    expect(j.text).toBe(`x\n\n${d.text}`);
    expect(j.spans.map((s) => [s.id, j.text.slice(s.from, s.to)])).toEqual([
      [1, marker(1)],
      [2, marker(2)],
    ]);
  });

  it("takes a picture's spans out, text and all", () => {
    const w = without(d, 1);
    expect(w.text).toBe("  a [Image #2]");
    expect(w.spans).toEqual([{ id: 2, from: 4, to: 14 }]);
  });
});
