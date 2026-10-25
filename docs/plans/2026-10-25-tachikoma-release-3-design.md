# Tachikoma release 3: keys and screen, design (2026-10-25)

Release 3 of Tachikoma. The overall design, the Decisions table and the release order are in
[2026-10-22-tachikoma-design.md](2026-10-22-tachikoma-design.md).

Release 3 gives the session screen Claude Code's keys and feel: stopping and exiting, line editing,
multi-line prompts, history, typing while a turn runs, a `/` menu, `@` paths, permission modes on a
key, a live working line and a fuller status line. The user chose this on 2026-10-23 ("We need all
sorts of keyboard commands like Claude code"), each part from options offered; the rest was settled
on 2026-10-25.

Sources:
- **Claude Code's keys:** code.claude.com/docs/en/interactive-mode.md and keybindings.md, read on
  2026-10-23. Where this design follows Claude Code, the behaviour is from there.
- **Ink 7.1.1** (the screen library, already a dependency), read in `node_modules/ink` on
  2026-10-25: `useInput` reports Escape, Shift and Meta; `usePaste` turns on bracketed paste, so a
  pasted block arrives as one string and never as key presses; `kittyKeyboard: { mode: "auto" }`
  turns on the kitty keyboard protocol where the terminal has it, which reports Shift+Enter as its
  own key; `alternateScreen` can only be set when the app starts; `useCursor` places the
  terminal's own cursor; `useWindowSize` gives the terminal's size and redraws on a resize. When the
  live part of the screen is as tall as the terminal, Ink clears the terminal and prints the whole
  scrollback again on every redraw (`renderInteractiveFrame` in `ink.js`).
- **claude-hud 0.0.4** (the status line the user runs in Claude Code), read on 2026-10-25:
  `src/render/session-line.ts` and `src/render/colors.ts`.

## How it is built

Tachikoma's own prompt editor, on Ink's key handling. A ready-made Ink text input handles one line
and has no history, undo or queue, so most of the work would remain, plus a new dependency. Reading
raw key codes would repeat what Ink 7 already parses, paste and the kitty protocol included.

- **`src/tui/editor.ts`, the editor as plain data:** the text, the cursor, the undo steps and the
  history position. One function takes the editor and a key and returns the new editor. No Ink, so
  every key is tested by feeding it keys.
- **`src/tui/history.ts`, each project's past prompts:** one private file per project folder, in
  Tachikoma's data folder (the user's choice), one prompt per line, kept in full. It is written with
  release 2's private-file writer under its cross-process lock, so two sessions in one project never
  lose each other's prompts.
- **App.tsx wires them up:** `useInput` for keys, `usePaste` for pastes, and Ink started with the
  kitty protocol on "auto". App decides what a key means at that moment: an answer to a question, a
  menu choice or an edit. It keeps what it does now: the turn, the questions, `/model`.
- **New screen parts,** each a small component like `ModelPicker`: the working line, the `/` and `@`
  menus, the hint line and the tool line.
- **The session reports each tool call as it runs,** its only change. Today it runs a reply's calls
  one after another but reports their results together, once all have run (`session.ts`), so the
  screen cannot tell which call is running. Two new events on the bus:
  - `tool-start` (the call's id, name and input), just before a call runs;
  - `tool-end` (the call's id and how it ended), just after: `ok`, `failed`, `declined` (the user
    said no, or the mode refused it) or `cancelled` (Esc or Ctrl-C).

  Every call the session takes up gets both. One skipped because the turn was already stopped gets
  both at once, ending `cancelled`. Calls never taken up, because the reply was cut off, get
  neither and are not counted. The results still reach the conversation together, as now, so
  nothing else changes.
- **Unchanged:** the providers and the permission rules. The mode becomes a setting the permission
  check reads each time, instead of a value fixed at start.

## The keys

A second press counts within 800 ms, the window Claude Code's docs give for Ctrl+D; every double
press here uses it.

**Stopping and exiting**
- **Esc while working** stops the turn. What is done so far stays in the conversation, and the queue
  goes on (below).
- **Ctrl-C while working** stops the turn too, but sends nothing more: the queue comes back into the
  prompt (the user's choice).
- **Esc at a permission question** declines that one action, and the turn carries on. Ctrl-C at a
  question declines and stops the turn, as now.
- **Esc Esc** with text clears it, and the text goes into the history. On an empty prompt it does
  nothing (Claude Code's rewind menu is not in this release).
- **Ctrl-C when idle** clears the prompt; on an empty prompt it shows "Press Ctrl-C again to exit",
  and a second press exits.
- **Ctrl-D** on an empty prompt shows a hint, and a second press exits. With text, it deletes the
  character after the cursor.

**Editing**
- **Moving:** Left and Right; Home and End, or Ctrl+A and Ctrl+E, for the line's start and end;
  Alt+B and Alt+F, or Ctrl+Left and Ctrl+Right, by word.
- **Deleting:** Backspace and Delete; Ctrl+W and Ctrl+Backspace the word before the cursor; Alt+D
  the word after; Ctrl+K to the line's end; Ctrl+U to its start.
- **Ctrl+Y** puts back the last deleted text. Alt+Y, which cycles older deletions, is left out.
- **Ctrl+_** undoes, step by step, back to the start of the prompt.

**Multi-line**
- A new line: Shift+Enter where the terminal reports it, backslash+Enter, or Ctrl+J.
- A pasted block goes in whole and is never sent by its own line breaks.
- **Rows are screen rows.** The prompt wraps at the terminal's width. Up and Down move one row as it
  looks on screen, keeping the column where the row is long enough, and reach the history only from
  the first or last row.
- **The cursor** is the terminal's own, placed with Ink's `useCursor`, so it shows where typing goes
  and input methods work. It is hidden while a question or the model picker has the keys.
- **The prompt's space.** The live part of the screen always stays at least one row shorter than the
  terminal, since at full height Ink reprints the whole scrollback on every redraw. Its rows go, in
  this order:
  1. the status line, the hint line, the tool line and, during a turn, the working line;
  2. an open menu, with the prompt cut to the row the cursor is on;
  3. the prompt;
  4. the queue, one entry a row, the last row saying "+N more" if they do not all fit; with no row
     left, the hint line says "N queued".

  A prompt taller than its space shows a window of rows that follows the cursor, with the first or
  last row saying how many rows are above or below. If the terminal is too short even for the lines
  in step 1, the tool line goes first, then the hint line.
- **A resize** works out the wrapping and the window again from the new size, and the cursor stays
  on the same character.

**History**
- Up and Down, or Ctrl+P and Ctrl+N, step through this project's past prompts.
- **Ctrl+R** searches them as you type: Enter sends the match, Tab or Esc puts it in the prompt to
  edit, Ctrl-C cancels.
- Every sent prompt is saved, and so is one cleared with Ctrl-C or Esc Esc.

**Typing while it works**
- The prompt stays editable during a turn. Enter adds what is typed to the queue as one entry, shown
  grey under the working line, in order.
- **When a turn ends**, entries are taken from the front. Prompts next to each other go as one
  message, separated by blank lines. A `/command` is taken alone and run as if typed then, and the
  entries after it wait until it is done. So `/lead x` and then a prompt changes the lead, then
  sends the prompt to the new lead; a prompt, then `/lead x`, then a prompt sends the first prompt,
  changes the lead after that turn, then sends the second.
- The queue goes on after a turn that finishes, one stopped with Esc, or one that ends with an
  error. After Ctrl-C it does not: the entries come back into the prompt, in order, one per line,
  after any text already there, for you to edit or send.
- Up on an empty prompt takes the queue back the same way, when there is one; with no queue, Up
  steps into the history as usual.

## Menus and modes

**The `/` menu.** Typing `/` at the start of an empty prompt lists the commands, each with one line
saying what it does, narrowing as you type. Up and Down choose; Tab puts the command in the prompt
to add to it (as `/lead ` needs); Enter runs it; Esc closes. Only at the start of the prompt, where
commands count anyway ("/tmp is full" is a message). No new commands come with it.

**`@` paths** (the user's choices: one folder at a time, and only the path is sent).
- `@` at the start or after a space lists the folder typed so far: `@` alone is the project folder,
  `@src/` lists src. Folders come first, with a trailing `/`, narrowing as you type.
- Tab or Enter on a folder goes into it; on a file, it completes the path.
- Only the path is sent. The model reads the file with `read_file`, through the same guards and
  paging as any read, so files reach the model no other way.
- Tachikoma's data folder is never listed, the same rule as the file tools. A folder that cannot be
  listed shows why in the menu.
- The menu is as tall as the space left on screen, and scrolls past that.

**`?` on an empty prompt** prints the key list into the scrollback, grey. A message starting with
`?` needs a space typed first, as in Claude Code.

**Shift+Tab** (the user's choice).
- Switches between `ask` and `project`. `never` joins the cycle only when the session started with
  `--mode never`, so no key press can turn off the checks a session started with. Until the
  sandbox (release 6), `never` means no checks at all apart from the keys and the data folder.
- The status line changes, and a grey line in the scrollback says "mode is now project", as a lead
  change does now.
- It applies from the next action. A question already on screen keeps the mode it was asked under,
  and Shift+Tab does nothing while one is showing.

**Alt+P** opens the model list, as `/model` does.

**Ctrl+O** (the user's choice) prints every tool call of the latest turn, with its full input and
result, grey, under a heading such as "Last turn: 3 tool calls". The text is cleaned of escape codes
like everything in the scrollback. Before any turn, it says there is none. (A view that expands
lines in place needs the full screen, which comes in release 5: printed lines cannot be changed.)

## On screen

**The working line** replaces "… working (Ctrl-C to stop)":
`⠋ Working · 1m 12s · ↓ 2.3k tokens · $0.04 · Esc to stop`
- The time, tokens and cost are this turn's. The time counts in seconds, so the line is redrawn once
  a second, and the spinner moves on the same tick.
- Tokens and cost follow the status line's rules: "ChatGPT plan" in place of a cost on the plan, "?"
  for a model without a price.
- They change after each model reply, not word by word: the providers report counts only once a
  reply is finished.
- The label says what is running: "Working" for a turn, "Waiting for the browser" for `/login`,
  "Reading the model lists" for `/model`.

**Compact tool lines.** A call shows its main detail instead of its raw input: `● read_file
src/x.ts`, `● write_file src/x.ts`, `● edit_file src/x.ts`, `● shell npm test` (the command's first
line). A tool without its own summary keeps today's form. The result line stays: `⎿ ok`, or the
error's first line in red. Ctrl+O shows the rest.

**The hint line**, one dim line between the prompt and the status line, shows whichever applies:
`? for shortcuts` when idle; `↑ to edit queued messages` with something queued; `Press Ctrl-C again
to exit` for the 800 ms after a first Ctrl-C or Ctrl-D; `↑↓ choose · Tab fill · Enter run · Esc
close` with a menu open. The permission question gains "Esc to decline".

**The status line** gains three parts and a bar from claude-hud (the user's choice: all four
offered):
- **A context bar** before the text: `██░░░░░░░░ ctx 81% left`. Ten cells, claude-hud's default
  (`coloredBar`, `colors.ts`). Its colour follows the share used: green, yellow from 70%, red from
  85%, claude-hud's thresholds (`getContextColor`, `colors.ts`). The text stays "% left", as the
  user chose on 2026-10-22. With no known window there is no bar, only `ctx 45.2k`.
- **`project`:** the project folder's name, claude-hud's default of one level (`pathLevels`), and
  the git branch: `Agent Harness git:(main*)`, `*` when there are uncommitted changes. Git is asked
  at the start and after each turn, in the background, run as shell commands are (without the API
  keys, no window); the line shows the last answer until a new one arrives. With no git, or outside
  a repository, only the folder shows.
- **`time`:** how long the session has run, `⏱ 14m`, in minutes, then hours and minutes, redrawn
  once a minute.
- **`tools`,** a line under the status line, from the session's `tool-start` and `tool-end` events:
  during a turn, the running tool and its target, then the turn's finished calls counted by tool,
  `◐ shell npm test | ✓ read_file ×3 | ✓ edit_file ×1`. A failed call counts under `✗` in red, a
  declined or cancelled one under `⊘` in grey. After the turn it keeps the last turn's counts until
  the next turn starts.

`--status` picks these as it does the six parts today; all are on by default, and the README's list
says so. The bar is part of `context`.

From the top, the bottom of the screen reads: the prompt, the hint line, the status line, the tool
line.

## When something goes wrong

- **History:** a damaged line is skipped. A file that cannot be read or saved is said once per
  session in magenta, and the prompt is still sent.
- **`@`:** a folder that cannot be listed shows why in the menu.
- **Git:** missing or failing, the status line shows the folder without a branch.
- **A terminal without the kitty protocol** sends Shift+Enter as Enter. The hint line and `?` name
  backslash+Enter and Ctrl+J, which work in every terminal.

## Testing

- **`editor.ts`:** every key above, fed in, checking the text and the cursor.
- **`history.ts`:** the private file, two sessions saving at once, a damaged line.
- **The session's tool events:** `tool-start` and `tool-end` in order for each call, with each way a
  call can end: ok, failed, declined, cancelled mid-call, skipped after a stop; none for calls cut
  off with the reply.
- **The queue:** prompts next to each other joined; a `/lead` between prompts run alone and in
  order; Esc goes on with the queue, an error too; Ctrl-C and Up bring it back into the prompt.
- **The prompt's space,** on a stand-in terminal with a set height (ink-testing-library's has a
  width of 100 columns and no height): a paste taller than the terminal keeps the live part shorter
  than the terminal, keeps the cursor's row in view, and moves the window as the cursor goes up; a
  menu cuts the prompt to the cursor's row; a resize keeps the cursor on the same character.
- **App,** through ink-testing-library, writing the codes a terminal sends: `\x1b[Z` for Shift+Tab,
  bracketed-paste markers around a block with line breaks, Escape; the 800 ms double presses with
  fake timers; the queue; Esc while a tool runs and at a question.
- **Status line:** the bar's colour at exactly 69, 70, 84 and 85% used; with and without git.
- **In the user's terminal** (Windows Terminal, PowerShell 5.1), a short checklist the user runs
  once: Shift+Enter, Shift+Tab, Alt+P, Ctrl+Backspace, a multi-line paste. The results go in the
  main design's "Still to measure".

## Not in this release

- Subagents and the to-do list: release 4.
- Vim mode, image paste, external editor, stash, rebinding keys in a file, full screen: release 5.
- Claude Code's rewind menu, Alt+Y, the `/` menu in the middle of a prompt, and `@` searching the
  whole project.

**As built (2026-10-25).** Where the code differs from this design, the reason is below. Each was
the user's choice.
- **Undo is Ctrl+Z as well as Ctrl+_.** In the user's terminal Ctrl+Shift+- sends Esc and Ctrl+-
  zooms, so Ctrl+_ cannot be typed there (the key probes, main design item 18).
- **The word before the cursor goes with Alt+Backspace.** Ctrl+Backspace sends the same byte as
  Ctrl+H, which Ink reports as Backspace, so it acts as Backspace. Ctrl+W still deletes back to a
  space.
- **The git branch is read from `.git/HEAD`, without the `*` for changes.** Running `git status`
  would be a way round the approval checks: in `project` mode the model can write `.git/config`,
  whose settings can make git run programs.
- **The spinner moves every 80 ms,** the rate of the frames it uses (cli-spinners' "dots"); once a
  second looked too slow. The time still counts in seconds.
