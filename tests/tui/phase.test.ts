import { describe, expect, it } from "vitest";
import { type PhaseInputs, now } from "../../src/tui/phase.js";

// Nothing happening: the prompt takes the keys, nothing runs and nothing waits.
const idle: PhaseInputs = {
  ended: false,
  printed: false,
  picker: false,
  listOpen: false,
  question: false,
  questions: 0,
  detail: null,
  search: false,
  menu: () => false,
  working: false,
  queued: 0,
};
const open = { search: null }; // the detail view, no search typed in it
const searching = { search: { typing: true } };

describe("now", () => {
  it.each([
    { name: "ended", given: { ended: true }, kind: "ended" },
    { name: "printed out", given: { printed: true }, kind: "printed" },
    { name: "the model list", given: { picker: true }, kind: "picker" },
    { name: "a question", given: { question: true }, kind: "question" },
    { name: "the detail view", given: { detail: open }, kind: "detail" },
    { name: "Ctrl+R's search", given: { search: true }, kind: "search" },
    { name: "a menu", given: { menu: () => true }, kind: "menu" },
    { name: "nothing else", given: {}, kind: "prompt" },
  ])("gives $kind for $name", ({ given, kind }) => {
    expect(now({ ...idle, ...given }).phase.kind).toBe(kind);
  });

  it("says whether a search is typed in the detail view", () => {
    expect(now({ ...idle, detail: open }).phase).toEqual({ kind: "detail", searching: false });
    expect(now({ ...idle, detail: searching }).phase).toEqual({ kind: "detail", searching: true });
    expect(now({ ...idle, detail: { search: { typing: false } } }).phase).toEqual({ kind: "detail", searching: false }); // a search kept
  });

  // One test a pair, in useInput's order: the first named wins over the next.
  it.each([
    { name: "ended beats printed out", given: { ended: true, printed: true }, kind: "ended" },
    { name: "printed out beats the model list", given: { printed: true, picker: true }, kind: "printed" },
    { name: "the model list beats a question", given: { picker: true, question: true }, kind: "picker" },
    { name: "a question beats the detail view", given: { question: true, detail: searching }, kind: "question" },
    { name: "the detail view beats Ctrl+R's search", given: { detail: open, search: true }, kind: "detail" },
    { name: "Ctrl+R's search beats a menu", given: { search: true, menu: () => true }, kind: "search" },
  ])("$name", ({ given, kind }) => {
    expect(now({ ...idle, ...given }).phase.kind).toBe(kind);
  });

  it("gives printed out over everything but ended", () => {
    const all: PhaseInputs = { ...idle, printed: true, picker: true, question: true, detail: searching, search: true, menu: () => true };
    expect(now(all).phase.kind).toBe("printed");
    expect(now({ ...all, ended: true }).phase.kind).toBe("ended");
  });

  // Finding an `@` menu can list a folder (App.tsx, menuFor), so it is asked only where the keys would reach it.
  it("asks for the menu only when nothing before it takes the keys", () => {
    let asked = 0;
    const menu = () => ++asked > 0;
    const before: Partial<PhaseInputs>[] = [{ ended: true }, { printed: true }, { picker: true }, { question: true }, { detail: open }, { search: true }];
    for (const given of before) now({ ...idle, ...given, menu });
    expect(asked).toBe(0);
    expect(now({ ...idle, menu }).phase.kind).toBe("menu");
    expect(asked).toBe(1);
  });

  it.each([
    { name: "the detail view", given: { detail: open }, kind: "detail" },
    { name: "Ctrl+R's search", given: { search: true }, kind: "search" },
    { name: "a menu", given: { menu: () => true }, kind: "menu" },
    { name: "the view printed out", given: { printed: true }, kind: "printed" },
    { name: "a question", given: { question: true }, kind: "question" },
    { name: "the model list", given: { picker: true }, kind: "picker" },
    { name: "the prompt", given: {}, kind: "prompt" },
  ])("keeps a turn running under $name", ({ given, kind }) => {
    const n = now({ ...idle, ...given, working: true });
    expect(n.phase.kind).toBe(kind);
    expect(n.working).toBe(true);
  });

  it("counts what is queued", () => {
    expect(now({ ...idle, queued: 2 }).queued).toBe(2);
    expect(now({ ...idle, printed: true, queued: 3 }).queued).toBe(3);
  });

  // The queue waits on the list and the questions as they are, drawn or not: a list read while printed out is open
  // before it is drawn, and a question asked since the last drawing waits already.
  it.each([
    { name: "a question waiting", given: { questions: 1 }, waiting: true },
    { name: "the list open, not yet drawn", given: { listOpen: true }, waiting: true },
    { name: "only a question drawn, since answered", given: { question: true }, waiting: false },
    { name: "only the list drawn, since closed", given: { picker: true }, waiting: false },
    { name: "nothing", given: {}, waiting: false },
  ])("says the queue waits for $name: $waiting", ({ given, waiting }) => {
    expect(now({ ...idle, ...given }).waiting).toBe(waiting);
  });
});
