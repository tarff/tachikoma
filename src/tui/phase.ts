// What is happening now, in one place (release 6 design, "Tidying the screen code first"; plan, Task 2): who takes the
// keys, and what runs beside them. App's flags stay where their writers set them; useInput, usePaste, next() and the mouse
// read them through now().
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
// and Ctrl-C need to know (found at the plan's second review).
export interface Now {
  phase: Phase;
  working: boolean;
  queued: number;
  waiting: boolean; // a question or the list holds the queue
}

// The keys go by what was last drawn, the queue by what is open: a model list read while the view is printed out is open
// before it is drawn, and a question asked since the last drawing waits already. Of two keys in one read, the first
// answering the question or picking from the list, the second is still kept from the prompt, as the screen still shows
// them: "yy" answers once (App.tsx, bindAsk).
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
