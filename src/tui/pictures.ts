// The session's pictures, by number (release 6 design, "Pictures"; plan, choice 9): kept in memory until the session
// ends, never on disk. A picture's number is taken when its read starts, so its marker goes into the prompt at once and
// pictures keep the order they were asked for; the picture fills in under that number when the read ends ("While a read
// runs").
import type { Part } from "../core/types.js";
import type { Span } from "./editor.js";

export type Picture = Pick<Extract<Part, { type: "image" }>, "mediaType" | "data">;
export type Read = Picture | "none" | { failed: string };

export { marker } from "../core/types.js";

export class Pictures {
  #last = 0;
  readonly #reads = new Map<number, { read: Read | "reading"; settled: Promise<void>; end: () => void }>();
  readonly #sent = new Set<number>();

  // Takes the next number, its read running from now.
  next(): number {
    const id = ++this.#last;
    let end = () => {};
    const settled = new Promise<void>((resolve) => (end = resolve));
    this.#reads.set(id, { read: "reading", settled, end });
    return id;
  }

  // A read's result, wherever its marker is. Every read ends in one of these, never left "reading". The first ending
  // stays: a reader that answers after Esc stopped its read (plan, Task 14) brings nothing back.
  set(id: number, read: Read): void {
    const r = this.#reads.get(id);
    if (r?.read !== "reading") return;
    r.read = read;
    r.end();
  }

  get(id: number): Read | "reading" | undefined {
    return this.#reads.get(id)?.read;
  }

  // Resolves when the read ends, however it ends.
  settled(id: number): Promise<void> {
    return this.#reads.get(id)?.settled ?? Promise.resolve();
  }

  sent(id: number): boolean {
    return this.#sent.has(id);
  }

  markSent(id: number): void {
    this.#sent.add(id);
  }
}

// A message before it is sent: its text and the spans of the pictures in it (editor.ts), as the queue keeps it.
export interface Draft {
  readonly text: string;
  readonly spans: readonly Span[];
}

// The user message's parts (design, "Which pictures a message carries"): the text split at each span whose picture has
// been read and not sent before, the picture at its first span. A later copy of it, a sent picture's span, a span whose
// read found nothing or failed, and text that only looks like a marker stay text. Text of only blanks between two
// pictures says nothing, and is left out. The pictures put in are marked sent.
export function messageParts(d: Draft, pictures: Pictures): Part[] {
  const parts: Part[] = [];
  let at = 0;
  const text = (to: number) => {
    const t = d.text.slice(at, to);
    if (t.trim()) parts.push({ type: "text", text: t });
  };
  for (const s of d.spans) {
    const p = pictures.get(s.id);
    if (typeof p !== "object" || "failed" in p || pictures.sent(s.id)) continue;
    text(s.from);
    parts.push({ type: "image", id: s.id, ...p });
    pictures.markSent(s.id);
    at = s.to;
  }
  text(d.text.length);
  return parts;
}

// The text without blanks at either end, the spans moved with it. A marker has no blanks, so none is cut.
export function trimmed(d: Draft): Draft {
  const lead = d.text.length - d.text.trimStart().length;
  return { text: d.text.trim(), spans: d.spans.map((s) => ({ ...s, from: s.from - lead, to: s.to - lead })) };
}

// Drafts one after another, `between` each two, each one's spans moved along.
export function joined(drafts: readonly Draft[], between: string): Draft {
  let text = "";
  const spans: Span[] = [];
  for (const [i, d] of drafts.entries()) {
    if (i) text += between;
    spans.push(...d.spans.map((s) => ({ ...s, from: s.from + text.length, to: s.to + text.length })));
    text += d.text;
  }
  return { text, spans };
}

// A span for each copy of the markers of pictures `ids` in `text`, in the text's order: the prompt back from the
// external editor, whose file is plain text (release 6 design, "Which pictures a message carries").
export function spansIn(text: string, ids: Iterable<number>): Span[] {
  const spans: Span[] = [];
  for (const id of new Set(ids)) {
    const m = marker(id);
    for (let i = text.indexOf(m); i >= 0; i = text.indexOf(m, i + m.length)) spans.push({ id, from: i, to: i + m.length });
  }
  return spans.sort((a, b) => a.from - b.from);
}

// Picture `id`'s spans taken out, text and all (plan, Task 14: a read that found nothing or failed); `at` says where
// a place in the old text is in the new, one inside a span taken out going to where it was.
export function without(d: Draft, id: number): Draft & { at: (i: number) => number } {
  const gone = d.spans.filter((s) => s.id === id);
  const at = (i: number) => i - gone.reduce((n, s) => n + Math.max(0, Math.min(i, s.to) - s.from), 0);
  let text = "";
  let from = 0;
  for (const s of gone) {
    text += d.text.slice(from, s.from);
    from = s.to;
  }
  text += d.text.slice(from);
  return { text, spans: d.spans.filter((s) => s.id !== id).map((s) => ({ ...s, from: at(s.from), to: at(s.to) })), at };
}
