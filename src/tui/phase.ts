// What is happening now, in one place (release 6 design, "Tidying the screen code first"; plan, Task 2): who takes the
// keys, and what runs beside them. App's flags stay where their writers set them; useInput, next() and the mouse read them
// through now(); usePaste through pasteTo().
//
// Not a phase: /screen switching to classic. Today's keys, pastes, queue and mouse never ask it: a key read while the
// switch runs acts as in classic mode (App.tsx, switchScreen), and a question asked meanwhile is answered as ever. The
// switch holds the queue through `working`, as a turn does.

// Who takes the keys: the order App's useInput decides in, first match winning.
export type Phase =
  | { kind: "ended" }
  | { kind: "printed" }
  | { kind: "picker" }
  | { kind: "question" }
  | { kind: "detail"; searching: boolean }
  | { kind: "search" }
  | { kind: "menu" }
  | { kind: "prompt" };

// What is running, beside whoever has the keys: a turn can run under the detail view, a search, a menu or `[`, and next()
// and Ctrl-C need to know (plan, Task 2).
export interface Now {
  phase: Phase;
  working: boolean;
  queued: number;
  waiting: boolean; // a question or the list holds the queue
}

// The keys go by what was last drawn, the queue by what is open: a model list read while the view is printed out is open
// before it is drawn, and a question asked since the last drawing waits already. When two keys arrive together, the first
// answers the question or picks from the list; the second still does not reach the prompt, because the question or list
// is still on screen until the next drawing: "yy" answers once (App.tsx, bindAsk).
export interface PhaseInputs {
  ended: boolean; // Ink has unmounted the App
  printed: boolean; // the detail view printed out (`[`)
  picker: boolean; // the model list drawn
  listOpen: boolean; // the model list open, drawn or waiting for the printed view to come back
  question: boolean; // a question drawn
  questions: number; // the questions waiting, drawn or not
  detail: { search: { typing: boolean } | null } | null;
  search: boolean; // Ctrl+R's
  // Asked last, only when nothing before it takes the keys: finding an `@` menu can list a folder (App.tsx, menuFor).
  menu: () => boolean;
  working: boolean;
  queued: number;
}

// App's refs, as phaseInputs() reads them. Only refs, so a listener set up once (the mouse's, the bus's) reads the screen
// as it is: the model list and the question as last drawn come from `drawn`, which App sets while drawing.
export interface PhaseRefs {
  ended: { current: boolean };
  printed: { current: unknown };
  drawn: { current: { picker: boolean; question: boolean } };
  listOpen: { current: boolean };
  questions: { current: unknown[] };
  detail: { current: PhaseInputs["detail"] };
  search: { current: unknown };
  working: { current: boolean };
  queue: { current: unknown[] };
}

// Without `findMenu`, a menu counts as the prompt: only the keys ask for it (App.tsx, useInput).
export function phaseInputs(r: PhaseRefs, findMenu: () => boolean = () => false): PhaseInputs {
  return {
    ended: r.ended.current,
    printed: r.printed.current !== null,
    picker: r.drawn.current.picker,
    listOpen: r.listOpen.current,
    question: r.drawn.current.question,
    questions: r.questions.current.length,
    detail: r.detail.current,
    search: r.search.current !== null,
    menu: findMenu,
    working: r.working.current,
    queued: r.queue.current.length,
  };
}

export function now(s: PhaseInputs): Now {
  return { phase: phaseOf(s), working: s.working, queued: s.queued, waiting: s.listOpen || s.questions > 0 };
}

function phaseOf(s: PhaseInputs): Phase {
  if (s.ended) return { kind: "ended" };
  if (s.printed) return { kind: "printed" };
  if (s.picker) return { kind: "picker" };
  if (s.question) return { kind: "question" };
  if (s.detail) return { kind: "detail", searching: s.detail.search?.typing === true };
  if (s.search) return { kind: "search" };
  return s.menu() ? { kind: "menu" } : { kind: "prompt" };
}

// Where a paste goes: into a search typed in the detail view, into the prompt, or nowhere (null). Release 5's path, kept
// apart from the keys' order: usePaste is off while the model list is drawn (App.tsx, isActive), so the list is not asked,
// and in the moment before Ink turns it off a paste went into the prompt; and a search typed in the detail view takes it
// even while a question is drawn (plan, Task 2). The menu is never asked: a paste goes into the prompt either way.
export function pasteTo(s: PhaseInputs): "search" | "prompt" | null {
  if (s.printed) return null;
  if (s.detail?.search?.typing) return "search";
  if (s.question || s.search || s.detail) return null;
  return "prompt";
}
