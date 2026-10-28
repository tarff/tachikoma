import { describe, expect, it } from "vitest";
import { type PhaseInputs, type PhaseRefs, now, pasteTo, phaseInputs } from "../../src/tui/phase.js";

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
    { name: "a menu beats the prompt", given: { menu: () => true }, kind: "menu" },
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
    const menu = () => {
      asked++;
      return true;
    };
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

// Release 5's paste rule (phase.ts, pasteTo).
describe("pasteTo", () => {
  it.each([
    { name: "printed out", given: { printed: true }, to: null },
    { name: "printed out, with a search typed in the detail view", given: { printed: true, detail: searching }, to: null },
    { name: "a search typed in the detail view", given: { detail: searching }, to: "search" },
    { name: "a search typed in the detail view, with a question drawn", given: { detail: searching, question: true }, to: "search" },
    { name: "a search typed in the detail view, with the model list drawn", given: { detail: searching, picker: true }, to: "search" },
    { name: "a question", given: { question: true }, to: null },
    { name: "Ctrl+R's search", given: { search: true }, to: null },
    { name: "the detail view", given: { detail: open }, to: null },
    { name: "a search kept in the detail view", given: { detail: { search: { typing: false } } }, to: null },
    { name: "the model list drawn", given: { picker: true }, to: "prompt" },
    { name: "the model list drawn, with a question", given: { picker: true, question: true }, to: null },
    { name: "the model list drawn, with Ctrl+R's search", given: { picker: true, search: true }, to: null },
    { name: "the model list drawn, with the detail view", given: { picker: true, detail: open }, to: null },
    { name: "a menu", given: { menu: () => true }, to: "prompt" },
    { name: "the prompt, a turn running", given: { working: true }, to: "prompt" },
    { name: "the prompt", given: {}, to: "prompt" },
  ])("sends a paste to $to for $name", ({ given, to }) => {
    expect(pasteTo({ ...idle, ...given })).toBe(to);
  });

  it("never asks for the menu", () => {
    let asked = 0;
    pasteTo({
      ...idle,
      menu: () => {
        asked++;
        return true;
      },
    });
    expect(asked).toBe(0);
  });
});

// App's refs as App holds them, nothing happening.
function refs(): PhaseRefs {
  return {
    ended: { current: false },
    printed: { current: null },
    drawn: { current: { picker: false, question: false } },
    listOpen: { current: false },
    questions: { current: [] },
    detail: { current: null },
    search: { current: null },
    working: { current: false },
    queue: { current: [] },
  };
}

describe("phaseInputs", () => {
  // The mouse listener is set up at mount: what it reads must come from the refs when it reads, never from then.
  it("reads the model list and the question from `drawn` each time it is asked", () => {
    const r = refs();
    const mouse = () => now(phaseInputs(r)).phase.kind; // made once, as App's mouse listener is
    expect(mouse()).toBe("prompt");
    r.drawn.current = { picker: true, question: false }; // the model list drawn
    expect(mouse()).toBe("picker");
    r.drawn.current = { picker: false, question: true };
    expect(mouse()).toBe("question");
  });

  it("reads each ref as it is", () => {
    const r = refs();
    r.printed.current = {};
    r.listOpen.current = true;
    r.questions.current = [{}, {}];
    r.detail.current = { search: { typing: true } };
    r.search.current = {};
    r.working.current = true;
    r.queue.current = ["a", "b", "c"];
    expect(phaseInputs(r)).toEqual({
      ended: false,
      printed: true,
      picker: false,
      listOpen: true,
      question: false,
      questions: 2,
      detail: { search: { typing: true } },
      search: true,
      menu: expect.any(Function),
      working: true,
      queued: 3,
    });
    r.ended.current = true;
    expect(phaseInputs(r).ended).toBe(true);
  });

  it("counts a menu as the prompt unless asked to find it", () => {
    expect(now(phaseInputs(refs())).phase.kind).toBe("prompt");
    expect(now(phaseInputs(refs(), () => true)).phase.kind).toBe("menu");
  });
});
