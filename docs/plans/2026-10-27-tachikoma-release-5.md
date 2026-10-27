# Tachikoma Release 5 (full screen): Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to build this
> plan task by task: a fresh builder per task, then a spec review, then a code review.

**Goal:** Tachikoma draws on the terminal's second screen, with its own scrolling, a scroll bar,
mouse selection and copying, clicks in the prompt and menus, and a detail view for Ctrl+O and
`/tasks t3`; `--classic` keeps release 4's screen, and `/screen` switches between the two. Last,
the status line takes claude-hud's colours (Task 16, the user's request of 2026-10-27).

**Architecture:** Ink gets a filtered copy of the keyboard (`src/tui/input.ts`), which takes the
mouse reports out and hands them to the App as events. `src/tui/terminal.ts` writes the screen and
mouse switches and puts the terminal back on every way out. The conversation's lines are kept in
`Rows` (`src/tui/view.ts`), wrapped to the screen's width, and only the rows on screen are drawn,
by `Conversation.tsx`, in place of release 4's `<Static>`. Selection (`select.ts`) works on places
in the lines, not on screen rows, and copying (`clipboard.ts`) sends OSC 52 and runs the system's
tool. Classic mode is release 4's screen, unchanged.
Design: `docs/plans/2026-10-27-tachikoma-release-5-design.md`.

**Tech stack:** as release 4 (TypeScript 7.0.2, Ink 7.1.1, React 19.3.0, Vitest 5.0.3,
ink-testing-library 4.0.0, string-width 8.3.0). No new packages.

---

## Before you start

**How this plan is built.** Unlike releases 3 and 4, the plan's code was not written in a scratch
copy first (the user asked on 2026-10-27 for a subagent-driven build). Each task below gives the
files, the interfaces, the behaviour and the tests, each test with what it must show. A builder
writes the tests first and sees them fail, then the code, then commits; a spec reviewer and a code
reviewer check the commit before the next task starts.

**The branch.** Build on the local branch `release-5` (from main 96c522b, holding the design). Do
not push: every push needs the user's fresh say-so, and main takes changes only by pull request.

**Checks, from the repo's folder:**
- Types: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
- One file: `node node_modules/vitest/vitest.mjs run tests/tui/view.test.ts`
- Everything: `node node_modules/vitest/vitest.mjs run` (667 tests at main 96c522b, 12 skipped)
- Build: `node node_modules/typescript/bin/tsc -p tsconfig.build.json`

Tests that start PowerShell (`tests/auth/keychain.test.ts`, `private.test.ts`, `access.test.ts`,
`chatgpt.test.ts`, `tests/tui/history.test.ts`) sometimes run past Vitest's 5 s limit when the
machine is busy. A time-out there is not a failure of this release if the file passes run alone.

**Rules for every task:**
- Tests first, seen failing for the right reason, then the code. One commit per task, plus `fix:`
  commits for review findings.
- No test reads the user's own files, contacts a provider, or writes the user's clipboard. Files a
  test makes go in a fresh `mkdtemp` folder.
- Never change permissions on any file or folder (no `icacls`, `chmod`, ACL calls).
- No package installs. If one seems needed, stop and ask.
- Match the code around you: plain-language comments that say why and cite the design's section
  ("release 5 design, \"Scrolling\""), no comment restating the code, lines up to 160 columns as
  in the existing files, prose in docs up to 100.
- Every number in the code has its source in a comment: the design, the probe, Ink's source, or a
  measurement in this plan.
- Commit messages: `feat: ...`, `fix: ...`, `docs: ...`, `test: ...`, ending with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01FvxxJZXtF5iaaV3ntbWe28
  ```

**Found by a review of this plan (2026-10-27), each written into its task:**
- With two questions waiting, the first one's detail could scroll away while it was still the one
  shown: a question now holds the view on its own detail, whatever arrives (Task 11).
- An older clipboard run ending after a newer copy put the older text back, and stayed there if the
  newer run then failed: the newest copy's OSC 52 is now sent again when an older run ends (Task 8).
- A place where one wrapped row ends is also where the next starts; rows are now half-open, so a
  view kept at a second row stays there (Task 3).
- `bar(20, 10, 5)` starts at 3, not 5 (Task 3).
- A Windows path could not be one word, `:` not being a word character: a drive's colon now is
  (Task 8, choice 6).

**What the user's runs of the screen check showed (2026-10-27;** `switchprobe.mjs`, its log and
`switchprobe-result.json` in the session's scratchpad; Windows Terminal, Node 24.22.1, 120 by 30):
- Each switch took about 30 ms; going to classic printed every line into the normal scrollback;
  Ink never cleared the terminal with the frame one row short; Ink wraps each frame in the
  terminal's synchronized-output codes (`ESC[?2026h` ... `ESC[?2026l`).
- **Two flashes** in the first run: going to full, Ink first drew the old classic frame on the
  second screen (React committed the new state only after `resume()`); going to classic, it drew
  the full-screen frame on the normal screen before printing. So the orders in Tasks 1 and 14 let
  React commit before `resume()`, and draw nothing before leaving full screen.
- **The keyboard stopped** after the third switch in two runs (the first run survived five): keys
  then came only after Enter, though Node said raw mode was on. Ink's suspend turns raw mode off and
  its resume back on within about 15 ms, and the console was left reading whole lines. With Ink's
  "off" (and its `unref`) not passed on while a switch runs, eleven switches 1.5 s apart all kept
  the keyboard, and PgUp and `q` worked at once after them. So the filter (Task 2) holds raw mode on
  through every switch and through `[` (Tasks 13 and 14).
- The user's answers after that run: full screen showed cleanly, no flicker, classic printed every
  line with the screen tidy, and quitting from full screen left the terminal as it was.

**Facts from Ink 7.1.1 the tasks rely on** (`node_modules/ink/build`, read 2026-10-27):
- Ink reads keys with `stdin.addListener("readable")` and `stdin.read()` until null
  (`components/App.js`), and calls `setEncoding("utf8")`, `setRawMode`, `ref` and `unref` on it.
  Any object with those can stand in for `process.stdin` (the `stdin` render option).
- A frame as tall as the terminal or taller makes Ink clear the whole terminal before drawing, on
  Windows every time (`ink.js`, `shouldClearTerminalForFrame`). So the full-screen frame is one row
  shorter than the terminal, as release 3's live area is.
- `useApp().suspendTerminal()` erases Ink's frame, turns raw mode and bracketed paste off, and
  returns `{ resume }`; `resume()` turns them back on and draws everything again. While suspended,
  Ink drops every render (`ink.js` `onRender`), `<Static>` output included.
- `parse-keypress.js` reads the probe's keys as: PgUp `pageUp`, PgDn `pageDown`, Ctrl+Home `home`
  with `ctrl`, Ctrl+End `end` with `ctrl`, Shift+Up `upArrow` with `shift`, Shift+Down `downArrow`
  with `shift` (checked by running it on `ESC[5~`, `ESC[6~`, `ESC[1;5H`, `ESC[1;5F`, `ESC[1;2A`,
  `ESC[1;2B`).
- ink-testing-library's terminal is 100 columns (a getter; a test can shadow it with
  `Object.defineProperty(app.stdout, "columns", { value: 60, configurable: true })` and emit
  `resize`), and `lastFrame()` is the whole last frame (debug mode).

**The user's check before the build** (design, "Building it", step 1): the user runs
`switchprobe.mjs` from the session's scratchpad (not in the repo), which switches screens in the
middle of an Ink session the way Task 14 does. Its result goes into the design before Task 1.

## Numbers in this plan

| Number | Where | Source |
|---|---|---|
| 20 ms | holding a partial mouse report | Ink's `pendingInputFlushDelayMilliseconds` (design, "The mouse") |
| 500 ms | double and triple clicks | Microsoft `SetDoubleClickTime` default (design) |
| 3 | lines a wheel notch, by default | probe's Windows setting; Claude Code's note that 3 matches vim |
| 20 | most lines a notch | Claude Code's `CLAUDE_CODE_SCROLL_SPEED` range |
| rows - 1 | full-screen frame height | Ink's clear on full-height frames (above) |
| `/-+\~_.` | word characters beside letters and digits | iTerm2 default (design) |

## Choices this plan makes that the design leaves open

Each is marked in its task. **Not yet approved.**
1. **Wrapping (Task 3):** rows break after a space, as Ink's own wrapping does in classic mode; a
   word longer than a row is cut at the row's end; a character never splits. Text always wraps one
   column short, whether or not the scroll bar shows, so a bar appearing never rewraps.
2. **One-line entries (Task 3),** such as tool calls, are cut to the row with "…" at the end, as
   now; selecting to that row's end takes the whole entry.
3. **The wheel (Task 7)** scrolls the conversation (or the detail view) wherever the pointer is.
   A fraction carried from earlier notches is dropped when the wheel turns the other way.
4. **The scroll bar (Task 7):** the thumb is at least one row; clicking the track centres the
   thumb on the row clicked.
5. **"↓ 12 new lines" (Task 5)** counts lines of output, not screen rows, and takes the view's last
   row.
6. **Selecting (Tasks 8, 9):** the characters under both the pressed cell and the current cell are
   included. A fourth click counts as one again. Double-click on a character that is not part of a
   word (a space, a bracket) selects that character alone. Beside iTerm2's word characters, a
   drive's colon (`C:\`, `C:/`) is part of a word, so a Windows path selects whole.
7. **"Copied 312 characters" (Task 9)** counts characters as a person sees them (`Intl.Segmenter`
   graphemes, as the prompt counts them).
8. **The clipboard tool (Task 8):** on Windows the text goes to `Set-Clipboard` through PowerShell's
   input, base64-encoded, so no command line limit applies (the probe put it in the command); on
   Linux `wl-copy` when `WAYLAND_DISPLAY` is set, otherwise `xclip -selection clipboard` when
   `DISPLAY` is, otherwise none (Task 9).
9. **Shift+Up/Down during a selection (Task 9)** moves the selection's end one row, scrolls one
   row, and copies the selection again. Dropped by the user at Task 9's review, 2026-10-27: an old
   selection would be copied again over newer clipboard contents. They only scroll.
10. **Clicks (Task 10)** on the prompt's "↑ N rows above" or "↓ N rows below" row or a menu's
    "↑ N more" or "↓ N more" row, anywhere while a question or the model list is open (except on
    the list's own entries), or during Ctrl+R's search, do nothing. A click that acts starts the
    press-twice count again, as a key between the presses does.
11. **A question without a detail (Task 11),** such as a shell command, whose text is all on the
    question line, leaves the view where it is.
12. **The detail view (Task 12):**
    - It shows what was there when it opened: Ctrl+O again shows newer calls.
    - The working line stays under it while a turn runs, so the user sees work going on.
    - Search matches show in reverse colours; n/N go round from the last match to the first; a
      match off screen is brought to the view's top row.
13. **`[` (Task 13)** prints the view with its colours, drawn by Ink's own `renderToString` at the
    terminal's width.
14. **`TACHI_CLASSIC` (Task 6):** any value but empty or `0` means classic.
15. **`--scroll-speed` and `TACHI_SCROLL_SPEED` (Task 7):** digits with an optional decimal point,
    above 0 and up to 20; anything else stops with an error. The option wins over the variable.
16. **Classic mode keeps release 4's keys (Task 5):** Shift+Up and Shift+Down act as Up and Down,
    Ctrl+Home and Ctrl+End as Home and End, and PgUp and PgDn do nothing.
17. **`/screen` to classic (Task 14)** prints the whole conversation, so lines printed in an
    earlier classic stretch of the same session appear twice in the scrollback.
18. **A crash (Task 6)** puts the screen back before Node prints the error, so the error shows on
    the normal screen (`process.on("uncaughtExceptionMonitor")` runs before Node's own report).
19. **The model list in full screen (Task 5)** takes the rows it needs, leaving the conversation at
    least one.

---

## Task 1: Switching screens

**Files:** create `src/tui/terminal.ts`, `tests/tui/terminal.test.tsx`.

**What it is.** The escape codes and one object that writes them and remembers whether the second
screen is on, so the exit handlers (Task 6) know what to undo.

```ts
export const SECOND_SCREEN = "\u001b[?1049h";
export const FIRST_SCREEN = "\u001b[?1049l";
// Presses and releases, moves with a button held, in the SGR format: what the probe asked for and got.
export const MOUSE_ON = "\u001b[?1000h\u001b[?1002h\u001b[?1006h";
export const MOUSE_OFF = "\u001b[?1006l\u001b[?1002l\u001b[?1000l";
export const SHOW_CURSOR = "\u001b[?25h";

export class Screen {
  constructor(write: (s: string) => void, writeNow: (s: string) => void); // writeNow: synchronous, for exit handlers
  get full(): boolean;   // false at first
  get mouse(): boolean;
  enter(): void;         // SECOND_SCREEN + MOUSE_ON; full and mouse true
  leave(): void;         // MOUSE_OFF + FIRST_SCREEN; both false
  setMouse(on: boolean): void;  // MOUSE_ON or MOUSE_OFF, only when it changes (for `[`, Task 13)
  setSecond(on: boolean): void; // SECOND_SCREEN or FIRST_SCREEN alone, only when it changes (for `[`)
  write(s: string): void;      // through `write`, for OSC 52 and printing (Tasks 8, 13)
  restore(): void;       // through writeNow: MOUSE_OFF if mouse, FIRST_SCREEN if full, then SHOW_CURSOR; once
}
```

**Tests** (a stand-in terminal and keyboard as in `tests/tui/prompt.test.tsx`, with `rows = 10`,
and Ink's real `render` with `debug: false`):
1. `enter`, `leave`, `setMouse`, `setSecond` write exactly the codes above, and `full`/`mouse`
   follow; a call that changes nothing writes nothing.
2. `restore` after `enter` writes `MOUSE_OFF + FIRST_SCREEN + SHOW_CURSOR` through `writeNow` only;
   a second `restore` writes nothing; `restore` after `leave` writes only `SHOW_CURSOR`.
3. Switching in the middle of a session, in the order Task 14 uses: a small component draws three
   rows in classic and three others in full; the test calls `suspendTerminal()` (taken from
   `useApp()` inside the component), `screen.enter()`, sets the component to full, waits one
   `setTimeout(0)` for React to commit, then `resume()`. The output after `SECOND_SCREEN` holds the
   full rows and none of the classic ones.
4. Back to classic in the order Task 14 uses: the component set to draw nothing, one
   `setTimeout(0)`, `suspendTerminal()`, `screen.leave()`, `resume()`, and only then the component
   mounts a `<Static items={["a", "b", "c"]}>`. The output after `FIRST_SCREEN` holds `a`, `b` and
   `c` and none of the full rows. (Mounting `<Static>` before `resume()` loses them: Ink drops
   renders while suspended. Add a test showing that too, so the order is kept on purpose.)
5. A frame of `rows - 1` rows drawn ten times (a counter in it) never writes `"\u001b[2J"`, Ink's
   clear.

Commit: `feat: the screen and mouse switches, and putting them back once`.

## Task 2: The filtered keyboard

**Files:** create `src/tui/input.ts`, `tests/tui/input.test.ts`.

**What it is** (design, "The mouse", "Reading it"):

```ts
export interface Mouse {
  kind: "press" | "release" | "drag" | "wheel";
  button: "left" | "middle" | "right" | "none"; // "none" for the wheel
  wheel?: "up" | "down";
  x: number; // 0-based column
  y: number; // 0-based row
  shift: boolean; alt: boolean; ctrl: boolean;
}
export type Piece = { keys: string } | { mouse: Mouse };

// One read's pieces, in order, and what is held back for the next read: pure, so it is tested alone.
export function split(state: { held: string; pasting: boolean; tail: string }, chunk: string): { pieces: Piece[]; state: { held: string; pasting: boolean; tail: string } };

export class InputFilter extends EventEmitter {
  constructor(source: Source, wait?: number); // wait: 20 ms, Ink's own (see Numbers)
  isTTY: true;
  setRawMode(on: boolean): this; setEncoding(e: BufferEncoding): this; ref(): this; unref(): this; // passed to source
  // While held, Ink's setRawMode(false) and unref() are not passed on: a switch's suspend and resume
  // would turn raw mode off and on within ~15 ms, which left the console reading whole lines (the
  // user's check, above). Held around every switch (Task 14) and through `[` (Task 13).
  hold(on: boolean): void;
  read(): string | null;           // Ink's: the next keys waiting, or null
  divert(to: ((keys: string) => void) | null): void; // `[` (Task 13): keys go to `to`, reports are dropped
  // emits "readable" for Ink, and "mouse" (Mouse) for the App
}
type Source = Pick<NodeJS.ReadStream, "on" | "off" | "setRawMode" | "setEncoding" | "ref" | "unref">;
```

The SGR report is `ESC [ < b ; x ; y M` (press, or a move with a button) or `m` (release). In `b`:
64 is the wheel (`b & 1`: down); 32 a move with a button held (`drag`); `b & 3` the button (0 left,
1 middle, 2 right, 3 none); 4 Shift, 8 Alt, 16 Ctrl. `x` and `y` are 1-based in the report.

The rules, from the design:
- A whole report is taken out.
- Between `ESC[200~` and `ESC[201~` nothing is taken out; the markers and the text go through as
  they are. A marker split across reads is still found (`tail` keeps the last characters, to find
  `ESC[201~` across reads; nothing is held back while pasting).
- Outside a paste, a read ending partway through what could be a report or a paste's start marker
  (`ESC`, `ESC[`, `ESC[<`, `ESC[<0;12`, `ESC[20`) holds that end back; the next read is joined to
  it. If no read comes within `wait`, it goes to Ink as it was.
- Everything else goes to Ink unchanged, in order with the reports.

The constructor calls `source.setEncoding("utf8")` and listens for `"data"`, so a character split
across reads arrives whole.

**Tests** (`vi.useFakeTimers()` for the wait):
1. Each report from the probe: `ESC[<64;10;5M` wheel up at x 9, y 4; `ESC[<65;10;5M` wheel down;
   `ESC[<0;10;6M` left press; `ESC[<32;11;6M` left drag; `ESC[<0;40;9m` left release;
   `ESC[<2;5;5M` right press; `ESC[<20;1;1M` left press with Shift and Ctrl.
2. A report split in two reads (`ESC[<0;1` then `2;5M`): one press, nothing for Ink.
3. `aESC[<0;1;1Mb`: keys `a`, the press, keys `b`, in that order.
4. A paste holding a report's shape (`ESC[200~xESC[<0;1;1MyESC[201~`) reaches Ink whole, no mouse
   event.
5. The same paste with its markers split (`ESC[20` | `0~xESC[<0;1;1My` | `ESC[2` | `01~`): Ink gets
   every character in order, no mouse event; a report after the end marker is taken out.
6. A lone `ESC` reaches Ink after 20 ms and not at 19 ms.
7. A lone `ESC[<0;12` with nothing after reaches Ink, as it was, after 20 ms.
8. `ESC` then, within 20 ms, `[A` (Up split): Ink gets `ESC[A` as one read.
9. The class: `read()` gives what is waiting then null; `setRawMode`, `setEncoding`, `ref`, `unref`
   reach the source; while held, `setRawMode(false)` and `unref()` do not, and `setRawMode(true)`,
   `ref()` and everything after `hold(false)` do; `divert(fn)` sends keys to `fn` and drops reports;
   `divert(null)` returns to Ink.
10. With Ink: a component using `useInput` and rendered with `stdin: filter`, fed `x`, a wheel
    report and `y` through a stand-in source, sees `x` and `y` and nothing else, and the filter
    emitted one `mouse`.

Commit: `feat: a filtered keyboard that takes the mouse reports out for the screen`.

## Task 3: The conversation's rows

**Files:** create `src/tui/view.ts`, `tests/tui/view.test.ts`.

**What it is** (design, "The screen", "Scrolling"): all the lines, wrapped, kept, and the place the
view shows, all pure.

```ts
import type { Line } from "./describe.js";
export interface Pos { line: number; offset: number }      // a place in the lines: before text[offset]
export interface Row { line: number; start: number; end: number; text: string; color?: string }

// One line's rows at `width` columns (choice 1): a break after the last space that fits; a word too
// long for a row cut at its end; never inside a character (segmenter from editor.ts, widths from
// string-width). `start`/`end` index the line's text and cover it without gaps. An empty line is one
// empty row. One-line entries (choice 2) are one row, cut with "…", with end = text.length.
export function wrap(text: string, width: number, oneLine: boolean): { start: number; end: number; text: string }[];

export class Rows {
  constructor(width: number);
  add(lines: Line[]): void;        // each Line split at "\n" into lines of its own, same colour
  get lines(): readonly { text: string; color?: string; oneLine?: boolean }[];
  get width(): number;
  setWidth(width: number): void;  // wraps everything again
  get total(): number;            // rows at this width
  row(i: number): Row;
  rowOf(p: Pos): number;          // the row with start <= offset < end; the line's own end: its last row
}

// Where the view is: the place on its first row, or null while it follows the bottom; and how
// many lines came in while it did not.
export interface View { at: Pos | null; unseen: number }
export const FOLLOWING: View;
export function first(rows: Rows, v: View, height: number): number;        // the first row shown
export function scrollBy(rows: Rows, v: View, height: number, n: number): View; // reaching the bottom follows
export function scrollTo(rows: Rows, v: View, height: number, row: number): View;
export function arrived(v: View, lines: number): View;                       // unseen grows while not following
// The wheel (Task 7): rows to move for one notch at `speed`, carrying fractions (choice 3).
export function notch(carry: number, speed: number, dir: -1 | 1): { rows: number; carry: number };
// The scroll bar: null when everything fits; otherwise the thumb's first row and size (choice 4).
export function bar(total: number, height: number, first: number): { start: number; size: number } | null;
export function barFirst(total: number, height: number, size: number, start: number): number; // thumb's start back to a first row
```

Keep `Rows` quick for long sessions: each line's rows kept, plus a running count of rows before each
line, so `row(i)` is a binary search. Task 4 measures it.

**Tests:**
1. `wrap("the quick brown fox", 10, false)` gives rows `"the quick "` (drawn trimmed),
   `"brown fox"`, with starts 0 and 10; `wrap("abcdefghijkl", 5, false)` cuts at 5 and 10.
2. `wrap("日本語テキスト", 5, false)`: two wide characters a row (4 columns), never three.
3. `wrap("", 10, false)` is one empty row; `wrap("x".repeat(30), 10, true)` is one row of 9 `x` and
   `…`, end 30.
4. `Rows`: two lines, the first with a line break, make three lines; `total`, `row(i)` and `rowOf`
   agree across 1,000 lines of mixed lengths: `rowOf(row(i).start) === i` for every row, and
   `row(rowOf(p))` holds `p` for every place in a sample. For `abcdef` at width 5, the place at
   offset 5 is the second row's, and the line's end (offset 6) too.
5. `setWidth` wraps again; `rowOf` of the same place gives the new row.
6. `View`: following, `first` is `total - height`; scrolled to a wrapped line's second row, the
   view stays on that row (not the line's first) as lines are added; `scrollBy(-5)` stops following
   and keeps its line when lines are added and when the width changes; `arrived` counts lines only
   while scrolled up; scrolling down to the bottom follows again with `unseen` 0; `scrollTo(0)` is
   the top.
7. `notch`: speed 3 gives 3 rows each notch; 0.5 gives 0, 1, 0, 1; 2.5 gives 2, 3, 2, 3; turning the
   other way drops the carry.
8. `bar(100, 10, 0)` starts at 0 with size 1; `bar(100, 10, 90)` ends on the last row;
   `bar(20, 10, 5)` has size 5 and starts at 3 (half its travel of 5, rounded up:
   `Math.round(2.5)`); `bar(10, 10, 0)` is null. `barFirst(20, 10, 5, s)` for `s` 0 to 5 gives 0, 2,
   4, 6, 8, 10, and `bar` of each gives `s` back: a thumb row stands for two first rows here, so
   going from a first row to the thumb and back may move by one.

Commit: `feat: the conversation's lines, wrapped and kept, and where the view is`.

## Task 4: Measuring (stop for the user)

**Files:** a script in the session's scratchpad, not in the repo. The figures go into the design's
"The screen" section, replacing "there are no figures yet".

Measure with `Rows` from Task 3, run as `node --expose-gc --import tsx <script>`:
- Lines shaped like a session's (from the repo's own tests' shapes: prose of 1 to 300 characters,
  tool lines, a few 2,000-line file details), at 1,000, 10,000, 100,000 and 1,000,000 lines.
- Memory after `add` (heap used after `gc()`, minus before), time to `add`, time to `setWidth`
  (a resize), and time to read one screen's rows (40 rows) and draw them with Ink's
  `renderToString` (as Task 5's `Conversation` will).

Report the table to the user. **Stop.** A cap on kept lines goes in only if the user chooses one
from these figures; otherwise the design records the figures and "no cap".

Commit (docs only): `docs: memory and drawing time for kept lines, in the release 5 design`.

## Task 5: The full-screen frame

**Files:** create `src/tui/Conversation.tsx`; modify `src/tui/App.tsx`, `src/tui/keys.ts`,
`src/tui/ModelPicker.tsx`; tests in `tests/tui/app.test.tsx`, `tests/tui/keys.test.ts`,
`tests/tui/conversation.test.tsx`.

**What it is** (design, "The screen", "Scrolling"):
- App gains the prop `screen: Screen` (Task 1); it reads `screen.full` into state `full` at mount
  (Task 14 changes it). In classic mode nothing changes.
- In full screen, `say` adds lines to a `Rows` (width `columns - 1`, choice 1) kept in a ref, as
  well as to `lines`, and `<Static>` is not drawn. `columns` changing calls `setWidth`.
- The frame is `height - 1` rows (Ink's clear, above). The live area is worked out as now, with one
  row fewer to give out (the conversation's least row); the conversation gets every row the live
  area does not draw, at least one. Count the live area's rows as drawn: working line, to-do rows,
  queue rows, prompt rows shown, menu rows, panel rows, hint, status line, tool line; while a
  question waits, the question's rows (its text wrapped with `wrap` at `columns`, drawn one row a
  `<Text>`) instead; while the model list is open, its rows (choice 19: `ModelPicker` takes a
  `maxRows` prop for this, defaulting to what it does now).
- `Conversation` (`{ rows: Rows; first: number; height: number; unseen: number; following: boolean }`)
  draws `height` rows from `first`, blank rows after the last line so the live area stays at the
  bottom, each row truncated (`wrap="truncate-end"`) in its line's colour, and the scroll bar in the
  last column (`bar`, the thumb `┃`, the track `│`, grey). When not following and `unseen > 0`, its
  last row is `↓ N new lines · Ctrl+End`, grey (choice 5).
- Keys (`keys.ts`): new commands `"pageUp" | "pageDown" | "top" | "bottom" | "lineUp" | "lineDown"`
  from `pageUp`, `pageDown`, Ctrl+Home, Ctrl+End, Shift+Up, Shift+Down, checked before the plain
  arrows and Home/End. In full screen: half the conversation's height (at least one row), the top,
  the bottom and following, one row. They work during a turn and while a question waits (in the
  question's branch of `useInput`, before y/n). In classic mode (choice 16): `lineUp`/`lineDown` act
  as `up`/`down`, `top`/`bottom` as `home`/`end`, page keys do nothing.
- Sending a prompt (Enter, and a queued one starting) brings the view to the bottom, following.
- `KEY_LIST` gains: `"  PgUp PgDn  half a screen · Ctrl+Home Ctrl+End  top, latest · Shift+↑ Shift+↓  a line (full screen)"`.
- The test helper `mount` gains `full?: boolean` (default false) and passes
  `screen={new Screen(() => {}, () => {})}`, calling `enter()` first when `full`.

**Tests:**
1. `conversation.test.tsx`: `Conversation` draws the rows from `first`, pads with blank rows, keeps
   colours, draws the bar only when the lines are longer than the view, and the new-lines row.
2. `keys.test.ts`: the six new commands from Ink's keys (as parsed: `{ pageUp: true }`,
   `{ home: true, ctrl: true }`, `{ upArrow: true, shift: true }` ...); plain Up and Home unchanged.
3. App, full screen, 24 rows: the intro and a reply show at the top, the status line at the bottom,
   and `lastFrame()` has 23 rows.
4. App, full screen, 60 lines said: only the last ones show; PgUp shows earlier ones; a new reply
   arriving while scrolled up does not move the view and shows `↓ 2 new lines · Ctrl+End`; Ctrl+End
   shows the newest and the row goes.
5. Shift+Up moves one row; PgDn at the bottom stays.
6. A resize to 60 columns wraps the lines again and keeps the view's top line at its top.
7. A tall prompt (20 lines typed) leaves the conversation at least one row; the frame stays 23 rows.
8. While a question waits, PgUp scrolls and `y` still answers.
9. Classic (the existing App tests, unchanged, all pass); Shift+Up in classic moves the prompt's
   cursor as Up does.

Commit: `feat: the full-screen frame, with the conversation above the live area and its own scrolling`.

## Task 6: Starting in full screen, and putting the terminal back

**Files:** modify `src/cli.tsx`, `src/clilib.ts`, `src/tui/terminal.ts`; tests in
`tests/clilib.test.ts`, `tests/tui/terminal.test.tsx`, `tests/cli.test.ts`.

**What it is** (design, "The two modes", "When something goes wrong"):
- `clilib.ts`: `screenMode(classic: boolean | undefined, env: NodeJS.ProcessEnv): "full" | "classic"`:
  `--classic`, or `TACHI_CLASSIC` set to anything but empty or `0` (choice 14), is classic.
- `cli.tsx`, interactive only, after the instruction files' question (which stays on the normal
  screen): `const screen = new Screen((s) => process.stdout.write(s), (s) => writeSync(1, s))`;
  `restoreOnExit(screen)`; if full, `screen.enter()` just before `render`. `render` gets
  `stdin: new InputFilter(process.stdin)` (Task 2) and the App gets `screen` and, from Task 7 on,
  the filter as `mouse`. `--classic` in `parseArgs` and the help text (Task 15 words the help).
- `terminal.ts`: `restoreOnExit(screen, proc = process)` adds `proc.on("exit", ...)` and
  `proc.on("uncaughtExceptionMonitor", ...)` (choice 18), each calling `screen.restore()`. The
  existing SIGTERM and SIGHUP handlers already call `process.exit`, so they pass through `exit`.
  Ctrl-C twice, Ctrl-D twice and `/exit` end through Ink's unmount and then `exit`.
- `-p` runs make no `Screen` and no filter.

**Tests:**
1. `screenMode`: default full; `--classic`; `TACHI_CLASSIC=1`, `=yes` classic; `=0`, `=` full.
2. `restoreOnExit` in a child process (a small script in the test's own temp folder, run with the
   repo's `tsx` loader, as `tests/cli.test.ts` runs the CLI): one script enters and calls
   `process.exit(0)`, another enters and throws. In both, stdout ends with
   `MOUSE_OFF + FIRST_SCREEN + SHOW_CURSOR` after the `SECOND_SCREEN`; the second's stderr holds
   the error.
3. `cli.test.ts`: `--help` lists `--classic`; `-p` output has no `SECOND_SCREEN`.

Commit: `feat: start in full screen unless --classic, and put the terminal back on every way out`.

## Task 7: The wheel and the scroll bar

**Files:** modify `src/tui/App.tsx`, `src/cli.tsx`, `src/clilib.ts`; tests in
`tests/tui/app.test.tsx`, `tests/clilib.test.ts`.

**What it is** (design, "Scrolling"):
- App props `mouse?: { on(e: "mouse", f: (m: Mouse) => void): unknown; off(...): unknown }` and
  `scrollSpeed: number`. In full screen the App listens for `mouse`.
- A wheel notch anywhere (choice 3) scrolls by `notch(...)` rows; reaching the bottom follows.
- The bar's column is `columns - 1`, its rows the conversation's. A left press on the track centres
  the thumb on that row (choice 4); a left press on the thumb and drags move the thumb with the
  pointer, keeping where on the thumb it was pressed; the release ends it.
- `clilib.ts`: `scrollSpeed(option: string | undefined, env: NodeJS.ProcessEnv): number`, default 3;
  `/^\d+(\.\d+)?$|^\.\d+$/`, above 0, up to 20 (choice 15), else an error naming where it came from:
  `--scroll-speed must be a number above 0, up to 20 (got "abc")`, or the same with
  `TACHI_SCROLL_SPEED`. `cli.tsx` adds `--scroll-speed` and passes it on.
- The mount helper gains a stand-in `mouse` (an `EventEmitter`) and `scrollSpeed` (default 3).
- Found at Task 5's review: handlers set up once at mount see `full` as it was then. The mouse
  listener reads `full` (and the view's height) through refs, not from the first render, so
  Task 14's `/screen` does not leave it acting on the old mode.
- The wheel scrolls while the model list is open, so picking a model ("lead is now ...", or its
  error) goes through Task 5's `show`, bringing the view to the bottom as other asked-for output.
- -p ignores `TACHI_SCROLL_SPEED`, not `--scroll-speed` (the user's choice at review, 2026-10-27).

**Tests:**
1. `scrollSpeed`: default 3; `"0.5"`, `".5"`, `"20"` ok; `"0"`, `"21"`, `"-1"`, `"1e1"`, `"abc"`,
   `" 3"` refused with the message; the option wins over the variable.
2. App, full screen, 80 lines: a wheel-up notch shows rows 3 higher; speed 0.5 moves one row every
   second notch; wheel down to the bottom follows again (a new reply then shows at once).
3. The bar: clicking its track near the top shows the first lines; dragging the thumb to the bottom
   shows the newest; the thumb's place in `lastFrame()` follows PgUp.
4. Classic: mouse events change nothing.

Commit: `feat: the wheel and the scroll bar`.

## Task 8: Selecting and copying: the parts

**Files:** create `src/tui/select.ts`, `src/tui/clipboard.ts`, `tests/tui/select.test.ts`,
`tests/tui/clipboard.test.ts`.

**What it is** (design, "Selecting", "Copying"):

```ts
// select.ts
export const CLICK_MS = 500; // Windows' default double-click time (SetDoubleClickTime)
export function ordered(a: Pos, b: Pos): [Pos, Pos];
// The text from a up to b (b's character not included: places are between characters), exactly
// the text selected, spaces and all (the user's choice, 2026-10-27), lines joined by "\n"; a
// wrapped line comes whole, as it is one line.
export function textOf(lines: readonly { text: string }[], a: Pos, b: Pos): string;
// A selection from the pressed cell to the current one, as places (choice 6: both cells' characters in):
// forward, from before the pressed cell's character to after the current cell's; backward, from before
// the current cell's to after the pressed cell's. A cell past a row's text stands for the row's end and
// adds nothing.
export function span(rows: Rows, press: { row: number; x: number }, now: { row: number; x: number }): [Pos, Pos];
// Double-click: letters, digits, marks and iTerm2's /-+\~_. ; a colon too where it follows a single
// letter starting the word and comes before \ or / (a drive, C:\ or C:/), so a Windows path is one word
// (choice 6); a URL from http:// or https:// to the next space whole, less its trailing .,;:!?, a
// closing )]} it has no opener for and an unmatched ' or ", each of which is taken alone (Task 9);
// any other character alone.
export function wordAt(text: string, offset: number): { start: number; end: number };
// Same cell within CLICK_MS of the last press: one more click; after three, one again (choice 6).
export function clicks(last: { at: number; x: number; y: number; count: number } | null, at: number, x: number, y: number): number;
// The place before the character under column x of the row, or the row's end past its text, with
// `past` saying which.
export function placeAt(rows: Rows, row: number, x: number): { pos: Pos; past: boolean };

// clipboard.ts
export const osc52: (text: string) => string; // ESC ] 52 ; c ; <base64 of UTF-8> BEL
export interface Tool { command: string; args: string[]; input: (text: string) => string; name: string }
export function systemTool(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Tool | null; // choice 8
export function runTool(tool: Tool): (text: string) => Promise<void>; // rejects with "<name> not found" or "<name> failed: <first line of stderr>"
export class Clipboard {
  constructor(write: (s: string) => void, run: ((text: string) => Promise<void>) | null, report: (problem: string) => void);
  copy(text: string): void;
  get terminalOnly(): boolean; // no tool: OSC 52 alone copies (Task 9)
}
```

`Clipboard.copy` writes `osc52(text)` at once, then the tool: one run at a time; a copy made while
one runs waits, and a newer one replaces it; when a run ends, the newest waiting copy runs. A run
that ends after a newer copy was made has just put older text on the clipboard, so the newest copy's
OSC 52 is written again at once, before the newest's own tool runs (design, "The newest copy
wins"). A failure is reported only when its copy is still the newest. With no tool (`run` null)
the copy goes by the terminal alone and nothing is reported (the user's choice, 2026-10-27, Task 9).

Windows' tool: `powershell.exe -NoProfile -NonInteractive -Command <DECODE> | Set-Clipboard`, where
`DECODE` reads base64 from the input and turns it into text
(`[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))`),
exported so a test can run it without touching the clipboard. Found at Task 8's review: the command
sets `[Console]::OutputEncoding` to UTF-8 and runs `Set-Clipboard -ErrorAction Stop` in a
`try`/`catch` that writes the error's message alone, as PowerShell's own report repeats the cmdlet's
name and is cut at the console's width.

**Tests:**
1. `textOf`: within a line; across three lines with end spaces kept; backwards (b before a); a
   line wrapped on screen comes as one line. `span`: forward and backward drags include both cells'
   characters; a drag ending past a row's text ends at that row's end, not at the next row's first
   character.
2. `wordAt`: in `see C:\src\a-b_c.ts now` the path whole, from a click on `C`, on `src` or on `ts`;
   `see c:/x now` whole; in `a: b` and `ab:\x` the colon is not part of a word; in
   `go to https://x.dev/a?b=1 now` the URL whole; on a space the space alone; `日本` as letters.
3. `clicks`: 1, 2, 3, then 1; a press 501 ms later or one cell away is 1.
4. `placeAt`: a cell inside text, on a wide character's second column (the character), past the
   end (the row's end), on a one-line entry's row past its end (the entry's end).
5. `osc52("tachikoma é 日本語 🦀")` is `ESC]52;c;` + its UTF-8 base64 + BEL.
6. `systemTool`: win32 is PowerShell with `Set-Clipboard`; darwin `pbcopy`; linux with
   `WAYLAND_DISPLAY` `wl-copy`, with only `DISPLAY` `xclip -selection clipboard`, with neither none.
7. On Windows only: running PowerShell with `DECODE` alone (no `Set-Clipboard`), with
   `[Console]::OutputEncoding` UTF-8, gives back `tachikoma é 日本語 🦀` from its base64.
8. `Clipboard` with a slow stand-in tool: copies A, B, C made while A runs: the tool runs A then C,
   never B; C is last. A failing A while C waits reports nothing; a failing C reports. OSC 52 was
   written for all three, in order.
9. The review's sequence (2026-10-27): A's tool runs; B is copied (B's OSC 52 written); A's tool
   ends (the stand-in clipboard now holds A); B's OSC 52 is written again before B's tool starts;
   B's tool fails and is reported. The writes end with B's OSC 52 after A's tool ended, so a
   terminal that takes OSC 52 holds B.
10. `runTool` with a command that does not exist rejects with `"<name> not found"`.

Commit: `feat: selection text, words, clicks and the clipboard`.

## Task 9: Selecting and copying on screen

**Files:** modify `src/tui/App.tsx`, `src/tui/Conversation.tsx`, `src/cli.tsx`; tests in
`tests/tui/app.test.tsx`.

**What it is** (design, "Selecting", "Copying"):
- App prop `clipboard: (report) => Clipboard`, a factory, so the App hands in the report that shows
  a problem in its hint row (cli:
  `(report) => new Clipboard((s) => screen.write(s), tool && runTool(tool), report)`; the App keeps
  the clipboard in a ref). The mount helper passes one with a stand-in `run` and records writes.
- A left press in the conversation (not the bar's column) starts a selection at `placeAt`; drags
  extend it; the selection shows in reverse colours (`Conversation` gets `selection: [Pos, Pos] |
  null`), the bar's column never.
- A drag above the conversation's top or below its last row scrolls one row a report (design,
  "Dragging past the top or bottom"), and the selection follows. The wheel scrolls during one.
- Double-click selects `wordAt`, triple-click the whole line (`clicks`).
- On release, a selection made by a drag or a double or triple click is copied: `textOf`, then
  `clipboard.copy`. The hint row says `Copied N characters` (choice 7) until the next key or click,
  or the report's words (`Copied with the terminal only; xclip not found`).
- A press and release on the same cell with no drag clears the selection, and copies nothing.
- Shift+Up/Down during a selection: choice 9, dropped by the user at Task 9's review, 2026-10-27
  (an old selection would be copied again over newer clipboard contents): they only scroll.
- Selection holds places, not rows, so it stays on its text when the view moves or rewraps.
- With no tool (Linux with neither `WAYLAND_DISPLAY` nor `DISPLAY`, as over SSH, or an unknown
  system) OSC 52 alone copies: the hint says `Copied N characters with the terminal only`, not a
  failure (the user's choice, 2026-10-27).
- A double-clicked link leaves off its trailing `.,;:!?`, a closing `)]}` it has no opener for, and
  an unmatched `'` or `"`, as most terminals do (the user's choice, 2026-10-27).
- At Task 9's review (the user's choices, 2026-10-27):
  - The pointer cannot go above the frame, so a drag on the conversation's top row scrolls up, but
    only for a drag started on a lower row; one started on the top row selects within it.
  - A selection stays until a click; keys never clear it. Any press clears it, on the prompt or the
    status line too, but one on the scroll bar, which scrolls as the wheel does.
  - The "↓ N new lines" row is not text: a press there starts no selection, and a drag onto it
    counts as the row above it, without scrolling (found at the code review).
  - `Copied N characters` goes on the next key, paste or click. It takes the hint row's place only
    while one shows, never adding a row, so a copy never moves the conversation, and a copy whose
    line cannot show when it is made drops it; Ctrl+R's search and the exit warning keep the row.
    A failed copy is always shown, even adding the row; one that comes while the search or the
    warning holds the row waits, shows when they go, and only then goes on the next key or click.
  - Double-clicking a character a link leaves off (the final `.` of `https://x.dev/a.`) selects
    that character alone.

**Tests** (each with a stand-in clipboard whose writes are recorded):
1. A drag over two rows of one wrapped line copies the line's text joined; over two lines, two lines
   joined by `\n`; the hint says `Copied N characters`; the next key clears the hint.
2. `lastFrame()` shows the selection in reverse colours (ANSI `\u001b[7m` in the frame) and not on
   the bar's column.
3. A drag below the conversation scrolls it and the copy reaches lines that were off screen.
4. Double-click copies a path whole; triple-click the line.
5. A click without a drag clears an earlier selection and copies nothing.
6. A failing stand-in tool shows `Copied with the terminal only; <reason>`.
7. New output arriving during a selection does not move the selection off its text.

Commit: `feat: selecting with the mouse and copying on release`.

## Task 10: Clicking in the prompt and on menus

**Files:** modify `src/tui/App.tsx`, `src/tui/Prompt.tsx`, `src/tui/Menu.tsx`,
`src/tui/ModelPicker.tsx`; tests in `tests/tui/app.test.tsx`.

**What it is** (design, "Clicking"):
- Screen rows: the conversation is rows `0..H-1`; the live area's parts follow in drawing order.
  The App knows each part's first row from the counts it already works out.
- `Prompt` and `Menu` keep their window's top in a ref; let the App pass the ref in (a `top` prop of
  type `{ current: number }`, defaulting to their own) so it can map a row to a prompt row or entry.
- A left press on a prompt row puts the cursor at the place under it (the layout's `places`, the row
  starting after the two columns of `› `); past the row's end, at its end, which on a row that wraps
  onto the next is before its last character, as `vertical` does (the user's choice at the code
  review, 2026-10-27).
- A left press on a menu entry: a `/` command runs, an `@` path fills in (as Enter does each).
- In the model list a left press on a model picks it (ModelPicker takes `mouse` and `bottom`, the
  frame row of its filter line, as the list sits at the foot of its box and its first row moves
  while filtering).
- Choice 10: clicks on the prompt's "↑ N rows above" / "↓ N rows below" rows and a menu's
  "↑ N more" / "↓ N more" rows, anywhere while a question or the model list is open (except on the
  list's own entries), or during Ctrl+R's search, do nothing; a click that acts restarts the
  press-twice count.

**Tests:**
1. Typed `hello world`, a click on the `w` puts the cursor before it (typing `X` gives
   `hello Xworld`); a click past the end puts it at the end; on a second wrapped row, that row.
2. `/` then a click on `/tasks` runs it (shows "No subagents yet.").
3. `@` with a folder of two files, a click on the second fills it.
4. `/model` open with two models, a click on the second picks it (`made` gets its spec).
5. A click on a menu's "↑ 2 more" row changes nothing (the counts start at 2: a count takes a
   row's place and counts it).

Commit: `feat: clicking in the prompt and on menu entries`.

## Task 11: A question brings its detail into view

**Files:** modify `src/tui/App.tsx`; tests in `tests/tui/app.test.tsx`.

**What it is** (design, "Scrolling", the review's first rule, and the plan's review): `bindAsk`
keeps, with each question, the lines its own detail went to (the heading's line to the detail's last
line). When that question becomes the one shown (first in line), the view goes to that range and
stops following, so lines arriving while it waits (another subagent's question and detail, a reply)
never move it:
- if the range's rows fit in the conversation's height less one row, its last row goes on the
  view's second-last row (the last is kept for "↓ N new lines");
- otherwise its heading goes on the view's top row.
When the question is answered, the view follows again if it was following when the question was
first shown (not when it arrived: the next question in line arrives while the first holds the view;
found at the spec review), even if the user scrolled while it waited, and otherwise stays; a resize
while it waits leaves the view where it is (the user's choices, 2026-10-27). The next question in
line then takes the view to its own detail. A question without a detail leaves the view (choice
11). The wheel, scroll keys and bar keep working while it waits (Tasks 5 and 7); y, n, Esc and
Ctrl-C answer it as in release 3.

Found at the spec review (2026-10-27):
- "↓ N new lines" counts only the new lines still below the view (`unseenBelow` in view.ts), so a
  reply drawn on screen under a held detail is not counted.
- A question too long to fit (the user's choices): when its wrapped rows would leave the
  conversation less than one row, checked at each drawing, its whole text goes into the
  conversation as a detail under a grey heading counting its characters, the question line becomes
  `Allow <task id> to <verb> (shown above)? [y/n] · Esc to decline`, and the answer line uses the
  short form. Once moved it stays, and the view is brought to it as on first show. A write whose
  preview holds the path gets no copy; the short line points at the preview. Classic mode is
  unchanged.

**Tests** (full screen, 24 rows, a write asked through `ask` with a detail):
1. Scrolled up, a 5-line detail: the heading and detail come on screen, the detail's last line on
   the second-last row.
2. Scrolled up or not, a 100-line detail: the heading is on the top row; PgDn and the wheel move
   through it; `y` allows; scrolled up, a later reply does not pull the view until Ctrl+End;
   following, the view follows again.
3. A shell question (no detail) while scrolled up: the view stays.
4. Two subagents ask at once, each a write with a 5-line detail: while the first question is shown,
   the second's detail arrives below and the first's heading and detail stay on screen; a reply
   arriving then does not move it either. After `y`, the second question is shown and the view goes
   to the second detail. After its answer, the view follows again (it was following before).

Commit: `feat: a permission question brings its detail into view`.

## Task 12: The detail view

**Files:** create `src/tui/DetailView.tsx`, `src/tui/find.ts`, `tests/tui/find.test.ts`; modify
`src/tui/App.tsx`; tests in `tests/tui/app.test.tsx`.

**What it is** (design, "The detail view"):
- In full screen, Ctrl+O opens `lastTurn(session.messages)` and `/tasks t3` the lines `tasksCommand`
  makes, in the view, instead of saying them. Its lines are fixed when it opens (choice 12). In
  classic mode both print as now.
- The view takes the conversation's place, with its own `Rows` and `View`; the prompt, queue, menu,
  to-do list and panel are hidden; the working line (choice 12), status line and tool line stay; a
  grey last row names the keys:
  `j k ↑ ↓ line · g G Home End top, bottom · / search · [ print · q Esc close`.
- Keys: everything the conversation has (wheel, bar, PgUp/PgDn, Ctrl+Home/End, Shift+Up/Down,
  selecting and copying); j/k and Up/Down a row; g/G and Home/End top and bottom; q, Esc, Ctrl+O
  close; Ctrl-C stops a running turn and leaves the view open, and with nothing running only closes
  the view, never clearing the hidden draft or counting toward quitting (the user's choice at the
  spec review, 2026-10-27); the working line keeps "Esc to stop" (the user's choice).
- `/` opens a search row (`/query`, in place of the key row): typing searches as it goes, the first
  match from the view's top on brought into view (choice 12: a match off screen goes to the top
  row), matches in reverse colours; Backspace edits; Enter keeps it (the row then says
  `"query": 3 of 7 · n next · N previous`); Esc drops it and the view goes back to where it was.
  n/N go to the next and previous match, round from the end (choice 12).
- Found at the reviews (2026-10-27): typing with no match shows `/query (no match)`, and a paste
  while typing goes into the query up to its first line break (the user's choices); outside a
  search pastes and other keys (Alt+P, Ctrl+R, Shift+Tab, Ctrl+T, `?`, text) do nothing. The key
  row stands in the hint row's place, in its dim style. Only the matches on the rows drawn are
  passed to the drawing, as walking every match per row cost 23 ms a redraw at 2,000 lines.
- `find.ts`: `find(lines, query): { line: number; start: number; end: number }[]`, any case, plain
  text, in order.
- A permission question closes the view (y and n are answers, and n is "next" here).

**Tests:**
1. `find`: any case, several matches in a line, none, empty query none.
2. Ctrl+O in full screen opens the view with "Last turn: N tool calls" and hides the prompt; q
   closes it and the prompt is back; in classic Ctrl+O prints as before.
3. `/tasks t1` opens t1's record in the view.
4. j, k, g, G, Home, End move as said, on a 100-line record.
5. Search: `/`, `LOGIN` finds `login` lines, shown in reverse colours; Enter keeps it; n and N move
   between matches and go round; Esc during typing brings the view back where it was.
6. A question arriving closes the view and shows the question line.
7. Selecting and copying work in the view.

Commit: `feat: the detail view for Ctrl+O and /tasks t3`.

## Task 13: Printing the detail view out (`[`)

**Files:** modify `src/tui/App.tsx`; tests in `tests/tui/app.test.tsx`.

**What it is** (design, "The detail view", the review's fourth rule):
- App prop `input?: { divert(to: ((keys: string) => void) | null): void; hold(on: boolean): void }`
  (cli passes the `InputFilter`; Task 14 uses `hold` too).
- `[` in the view: going out, in this order: `input.hold(true)`, so raw mode stays on throughout;
  `screen.setMouse(false)`; `suspendTerminal()`; `screen.setSecond(false)`; print the view's lines
  with `renderToString` at `columns` (choice 13) and a last grey line
  `Printed. q, Esc or Ctrl-C to go back.`; then `input.divert(reader)`.
- The reader takes q, Esc (a lone `ESC`) or Ctrl-C (`\u0003`) to come back; other keys are ignored.
- Coming back, in reverse: `input.divert(null)`; `screen.setSecond(true)`; `screen.setMouse(true)`;
  `resume()`, which draws everything again; `input.hold(false)`.
- Work goes on meanwhile; nothing is drawn (Ink drops renders while suspended).
- A permission question arriving while printed out comes back at once, as q would, and the
  question shows (Task 11's rules).
- Found at the reviews (2026-10-28):
  - Coming back lets go of the keyboard only if `[` has not printed the view out again meanwhile
    (q then `[` quickly let raw mode go off while out).
  - The user's choices: a paste does nothing while out (bracketed paste on while out, the reader
    drops `ESC[200~` ... `ESC[201~`); a paste still arriving when the view comes back is dropped
    to its end; a queued `/model` (the list waits through `perform`) or `/tasks t3`, and what is
    queued behind it, waits until the view comes back; a queued `/exit` still runs.
  - The reader's parsing is `readOut` in `src/tui/input.ts`; a paste start marker split across
    reads is recognised only within the filter's 20 ms hold, as in Ink.
  - A render error while out is said on stderr (`Screen.suspended`), and nothing queued starts
    once Ink has ended.

**Tests** (a stand-in `input` and a recording `screen` whose writes are kept with the steps):
1. `[` writes, in order: `MOUSE_OFF`, (suspend), `FIRST_SCREEN`, the view's lines, the last line;
   `hold(true)` came first and `divert` was given a reader.
2. Keys sent to the reader: `x` does nothing, `q` comes back: `divert(null)`, `SECOND_SCREEN`,
   `MOUSE_ON`, the view drawn again, then `hold(false)`.
3. A reply arriving while out is in the conversation after coming back.
4. A question arriving while out comes back and shows the question.

Commit: `feat: [ prints the detail view into the normal scrollback`.

## Task 14: `/screen`

**Files:** modify `src/tui/App.tsx`, `src/tui/menus.ts`; tests in `tests/tui/app.test.tsx`,
`tests/tui/menus.test.ts`.

**What it is** (design, "The two modes"):
- Found at Task 5's review: `say`, the bus listeners, `bindAsk` and History's warning are set up
  once at mount and keep the first render's `say`, which sees `full` as it was then. Keep `full`
  in a ref as well as in state, set at the same moment, and have `say` (and Task 7's mouse
  listener) read the ref, so lines go to `Rows` after a switch to full screen. A test: `/screen`
  to full, then a reply arriving shows in the conversation view.
- `/screen` (alone; words after it are refused as for `/exit`) switches, in Task 1's orders:
  - Both ways run between `input.hold(true)` and `input.hold(false)`, so raw mode is never turned
    off (the user's check, "Before you start").
  - To classic: close the detail view and any selection; draw nothing (a `switching` state), and
    wait one `setTimeout(0)` for React to commit it; `suspendTerminal()`; `screen.leave()`;
    `resume()`; then set `full` false, so `<Static>` mounts and prints the whole conversation
    (choice 17).
  - To full: `suspendTerminal()`; `screen.enter()`; set `full` true and fill `Rows` from `lines`;
    one `setTimeout(0)`; `resume()`; the view follows the bottom.
- Says `screen is now full` / `screen is now classic`, grey, as Shift+Tab's `mode is now`.
- The `/` menu, `NAMES`, `COMMANDS` and the Unknown command list gain `/screen`
  ("Switch between full screen and classic").
- Found at the reviews (2026-10-28):
  - The user's choice: going to classic, the mode is classic from the start of the switch, so a
    key read meanwhile (Ctrl+O, a scroll key) acts as in classic mode.
  - A switch holds the queue as a turn does; Esc and Ctrl-C act as during a turn. A queued
    `/screen` waits while the view is printed out, as `/model` and `/tasks t3` do.
  - Going back to full screen, the view takes only the lines said in classic mode (an `unkept`
    list); counting entries against `Rows`' split lines lost lines.
  - Going to full, the mode is set before the suspend, so a question asked as the switch starts
    keeps its detail's place.
  - Both `setTimeout(0)` waits matter: without the one going to full, Ink first draws the classic
    frame on the second screen; without the one going to classic, a `/screen` run from the queue
    draws the full-screen frame again on the normal screen.
  - Keeping the keyboard held: a `[` read while Ink resumes keeps the hold, as in Task 13; if Ink
    ends meanwhile, nothing more is switched.

**Tests:**
1. `/screen` from full: the recording screen got `MOUSE_OFF + FIRST_SCREEN`, the frame shows every
   earlier line (Static), `screen is now classic`.
2. `/screen` again: `SECOND_SCREEN + MOUSE_ON`, the conversation view with every line.
3. `/screen now` is refused; the menu lists `/screen`.
4. A stand-in `input` records `hold(true)` before the suspend and `hold(false)` after the resume,
   both ways.

Commit: `feat: /screen switches between full screen and classic`.

## Task 15: Documents and the terminal checklist

**Files:** `README.md`, `src/cli.tsx` (help), `docs/plans/2026-10-27-tachikoma-release-5-design.md`
("As built"), `docs/plans/2026-10-22-tachikoma-design.md` (Decisions row "Release 5, as built").

- README: "Release 5 of 14 is done"; a full-screen section (scrolling, the bar, selecting and
  copying, Shift+drag for the terminal's own selection, clicks, the detail view and `[`, `/screen`,
  `--classic`, `TACHI_CLASSIC`, `--scroll-speed`, `TACHI_SCROLL_SPEED`); Known limits: a hard kill
  (Task Manager, closing the tab) cannot put the terminal back, and closing that tab clears it;
  Windows Terminal and other ConPTY hosts can leave fragments of earlier output (Claude Code's own
  note); copying checks neither route's success with the terminal.
- Help: `--classic`, `--scroll-speed <n>`, `/screen`.
- Design "As built": the choices approved, anything changed while building, review fixes.

**The user's terminal checklist** (after Task 15; results into the design):
1. Launch and quit: the screen comes back as before.
2. The wheel, PgUp/PgDn, Ctrl+Home/End, Shift+Up/Down, the scroll bar (click and drag).
3. Following, and the "new lines" row during a turn.
4. Drag, double-click and triple-click copying, pasted into another program.
5. Clicking in the prompt and on `/` and `@` entries and in `/model`.
6. Ctrl+O, its search, and `[` out and back.
7. `/screen` both ways.
8. Resizing the window.
9. No fragments of old text left on screen.

Commit: `docs: release 5 in the README, the help and the designs`.

## Task 16: The status line's colours

Added on 2026-10-27 at the user's request, after Task 5 (design, "The status line's colours").

**Files:** modify `src/tui/StatusLine.tsx`, `README.md` (the status line bullet), the design's
"As built"; tests in `tests/tui/statusline.test.tsx`.

**What it is:**
- `StatusLine` draws nothing `inverse`. Each part is drawn from its pieces:
  `export interface Piece { text: string; color?: "cyan" | "green" | "yellow" | "red" | "magenta"; dim?: boolean }`
  and `export function pieces(s: LineSegment, i: StatusInfo): Piece[]` (`LineSegment` exported),
  whose texts joined are exactly `formatSegment(s, i)`, so the words cannot drift from it.
- `formatSegment("context", ...)` with a known window is `72% left`, without `ctx` (the user's
  choice, 2026-10-27); with no known window it stays `ctx 45.2k`.
- The colours, from the design's table:

| Part | Release 4 (all inverse) | Release 5 |
|---|---|---|
| Lead | `lead anthropic:claude-opus-5-5` | `lead` grey, the lead cyan |
| Context | the bar, `ctx 72% left` | the bar as now, then `72% left` in the bar's colour (green, yellow from 70% used, red from 85%), no `ctx`; with no known window, no bar, so `ctx` stays, grey, and the count plain |
| Tokens | `12.3k in / 4.1k out` | the numbers plain, `in` and `out` grey |
| Cost | `$0.42`, "ChatGPT plan" | green, the whole text |
| Mode | `perm ask` | `perm` grey; `ask` green, `project` yellow, `never` red |
| Errors | red only when above 0 | `0 errors` grey, red from 1 |
| Project | `Agent Harness git:(release-5)` | the folder yellow, `git:(` and `)` magenta, the branch cyan |
| Time | `⏱ 12m` | grey |
| Subagents | `2 running` | yellow |

- The separators ` | ` are grey; the line's first and last spaces stay, plain. The context bar is
  drawn as now, before the context part; `72% left` takes `contextBar(used).color`.
- Folder and branch are each escaped with `visible`, as the whole is now.
- README: the status line bullet says its parts are coloured as claude-hud's are.

**Tests:**
1. For every part (with and without a branch, with and without a known window, a `chatgpt:` lead
   with and without cost), the pieces' texts joined equal `formatSegment`.
2. Each part's colours from the table: context green at 69% used, yellow at 70%, red at 85%, the
   bar and the text alike; `0 errors` grey, `1 error` red; each mode's colour; no branch, the
   folder yellow alone.
3. The drawn `StatusLine` has no `inverse` element (checked on the elements it returns, as
   `conversation.test.tsx` does, the test terminal drawing no colour codes); the existing tests
   pass, those expecting `ctx N% left` changed to `N% left` and nothing else.

Commit: `feat: the status line in claude-hud's colours`.
