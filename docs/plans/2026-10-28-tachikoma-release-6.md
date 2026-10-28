# Tachikoma Release 6 (settings, keys and the key extras): Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to build this
> plan task by task: a fresh builder per task, then a spec review, then a code review.

**Goal:** a plain `tachi` starts from a settings file; every key is a named action that a keys
file can rebind; Ctrl+G opens the prompt in an editor, Ctrl+S stashes it, Alt+V and pasted paths
add pictures that every provider gets in a size it takes; all of Claude Code's vim mode; the
context bar for OpenAI API leads. The screen code is tidied first, with no change a user sees.

**Architecture:** App.tsx keeps drawing, but the terminal's hand-overs go through one owner
(`src/tui/owner.ts`), its state flags through one phase (`src/tui/phase.ts`), its sums through
`layout.ts`, and its keys through a table of actions (`src/tui/bindings.ts`) that the keys file
lays over. The settings file is read and checked in `src/settings.ts`, watched in
`src/settingsWatch.ts`, and merged with the flags in `cli.tsx`. Pictures are a new `image` part in
the stored conversation; the prompt keeps their markers as spans; each adapter converts them, and
`src/providers/pictures.ts` shrinks them per request with sharp. Vim mode is plain data in
`src/tui/vim.ts`, on top of `editor.ts`.
Design: `docs/plans/2026-10-28-tachikoma-release-6-design.md`.

**Tech stack:** as release 5 (TypeScript 7.0.2, Ink 7.1.1, React 19.3.0, Vitest 5.0.3,
ink-testing-library 4.0.0, string-width 8.3.0, zod 4.6.7, @anthropic-ai/sdk 0.132.0, openai
7.30.0), plus sharp 0.35.5 (Task 17, installed by the controller through sfw).

---

## Before you start

**How this plan is built.** As release 5: each task gives the files, the interfaces, the behaviour
and the tests, each test with what it must show. A builder writes the tests first and sees them
fail, then the code, then commits; a spec reviewer and a code reviewer check the commit before the
next task starts. Tasks 1 to 4 change no behaviour: the whole suite must pass unchanged after each.

**The branch.** Build on the local branch `release-6` (from main ade0572, holding the design as
312ab8c). Do not push: every push needs the user's fresh say-so, and main takes changes only by
pull request.

**Checks, from the repo's folder:**
- Types: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
- One file: `node node_modules/vitest/vitest.mjs run tests/tui/editor.test.ts`
- Everything: `node node_modules/vitest/vitest.mjs run` (1,012 tests at ade0572, 13 skipped)
- Build: `node node_modules/typescript/bin/tsc -p tsconfig.build.json`

Tests that start PowerShell (`tests/auth/keychain.test.ts`, `private.test.ts`, `access.test.ts`,
`chatgpt.test.ts`, `store.test.ts`, `tests/providers/registry.test.ts`, `tests/tui/history.test.ts`,
`statusline.test.tsx`, `tests/settings.test.ts`) sometimes run past Vitest's 5 s limit when the
machine is busy. A time-out there is not a failure of this release if the file passes run alone.

**Rules for every task:**
- Tests first, seen failing for the right reason, then the code. One commit per task, plus `fix:`
  commits for review findings.
- No test reads the user's own files (settings, keys, history, clipboard), contacts a provider, or
  writes the user's clipboard. A test's home folder is a fresh `mkdtemp` folder passed as `home`,
  or `USERPROFILE`/`HOME` in `tests/cli.test.ts`'s `tachi()` helper, which already does this.
- Never change permissions on any file or folder (no `icacls`, `chmod`, ACL calls) in a test or by
  hand. `privateDir`/`writePrivate` may run only on folders a test made.
- No package installs by a builder. Task 17's sharp is installed by the controller first.
- Match the code around you: plain-language comments that say why and cite the design's section
  ("release 6 design, \"The settings file\""), no comment restating the code, lines up to 160
  columns in code, prose in docs up to 100.
- Every number in the code has its source in a comment: the design, the probe, a provider's page,
  Claude Code's docs, or this plan's table.
- Every user-visible message is triggered for real in a test, and its exact words checked.
- Commit messages: `feat: ...`, `fix: ...`, `docs: ...`, `test: ...`, `refactor: ...`, ending with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_011HyFwTrMHgymaTPqy6wZCX
  ```

**Facts the tasks rely on** (read 2026-10-28 by four read-only surveys of the code):
- App.tsx's `useInput` (786-846) decides in this order: printed out ignores every key; the model
  list takes them; a question (Ctrl-C, Esc, scroll keys in full screen, y/n); the detail view;
  Ctrl+R search; a `/` or `@` menu's Tab and Esc; Esc, Ctrl-C and Ctrl-D with the 800 ms double press;
  then `commands(ch, key)` (keys.ts 36-66) into `run(c)` (1071-1117).
- keys.ts maps Ctrl+a,e,d,w,k,u,y,z,p,n,r,o,t and Alt+b,f,d,p (16-17), and turns typed text with no
  modifier into one `insert` after splitting at `\r` and `\n`: "yy" in one read is one insert.
  `KEY_LIST` (20-34) is written by hand.
- The terminal is handed over in three flows: `printOut`/`comeBack` (608-673), `switchScreen`
  (701-746) and the unmount cleanup (393-419), each calling `suspendTerminal`, `input.hold` and
  `input.divert` in its own order; `suspending` and `switchRunning` guard their overlap.
- The `useEffect([])` at 295-420 registers bus handlers, `bindAsk` and `mouse.on`, which call the
  first render's `say`, `closeDetail`, `comeBack`, `next`, `dragTo`, `pressAt`, `clickAt`, `copy`
  and `run`; they reach later state only through refs, and stale `columns` through `openDetail`,
  `vertical` in `run` and `printOut`'s `renderToString`.
- Layout sums in render: 1266-1282 (hint, room, menu, panel, prompt, todo, queue rows), 1298-1304
  (picker rows, live area), 1313-1325 (a question's fit, view height), 1333-1353 (question placing,
  prompt position, the frame snapshot); mouse-time sums at 954-1041.
- editor.ts is plain data: `{text, cursor, undo: {text, cursor}[], typing, killed}`, the cursor a
  UTF-16 index always on a grapheme boundary (`segmenter`), undo steps from `change()`, typing
  joining the step before. No redo. `load()` clears undo.
- history.ts saves trimmed text, one JSON string a line, in `<data>/history/<sha256>.jsonl`.
- Pastes reach App through Ink's `usePaste` (864-881); the InputFilter passes bracketed-paste
  markers through and only strips mouse reports.
- clipboard.ts `systemTool` picks PowerShell (System32 path, `commandEnv()`), pbcopy, wl-copy
  (`WAYLAND_DISPLAY`) or `xclip -selection clipboard` (`DISPLAY`), for writing only.
- cli.tsx parses with `node:util` `parseArgs` (131-152); `--lead ?? TACHI_LEAD`; `oneOf` errors
  `--${name} must be one of: ... (got "...")`; `--max-tasks` digits only; `statusSegments`,
  `scrollSpeed`, `screenMode` in clilib.ts; with no lead: `No lead model given. Pass --lead or set
  TACHI_LEAD.` Effort, fallback, worker and maxTasks are fixed today; segments and scrollSpeed are
  App props.
- `writePrivate` (auth/private.ts 145-163) writes a temp file and renames it, retrying on Windows
  for 1 s; `withLock` (auth/lock.ts 158-179) is a cross-process lock; `privateDir` makes a folder
  private (on Windows with icacls). The only `fs.watch` is the lock's wait.
- File tools refuse the data folder in every mode through `resolveIn` (tools/files.ts 31-63);
  the project's error log is `<root>/.tachikoma/errors.jsonl`, so `~/.tachikoma` is inside the
  project when the project is the home folder.
- Adapters: `toAnthropic` (anthropic.ts 17-41), `toOpenAI` (openai.ts 20-46; user content is one
  joined string), `toResponses` (chatgpt.ts 84-106). Anthropic and OpenAI errors arrive as the
  SDKs' `APIError` with `.status`; chatgpt.ts turns `APIError` into a plain `Error` (268) and
  session.ts keeps only `errorText(err)` in the error event (119-121): the status is lost.
- Only `AnthropicProvider` and `ChatGPTProvider` have `contextWindow()`; App asks
  `session.lead.contextWindow?.()` (287-293).
- Subagents start fresh sessions from their task text (tasks.ts 131-166): no pictures reach them.

## Numbers in this plan

| Number | Where | Source |
|---|---|---|
| 3 s | between a chord's keys | Claude Code's keybindings docs (design, "The keys file") |
| 1 s | a `vimInsertModeRemaps` pair | Claude Code's interactive-mode docs (design, "Vim mode") |
| 800 ms | double presses | release 3, unchanged |
| 10 MB base64, 8000×8000 | each Anthropic picture | Anthropic vision docs, "Request limits" (design table) |
| 2000 a side, over 20 pictures | Anthropic many-picture rule | same |
| 32 MB | an Anthropic request | same ("standard endpoints") |
| 600 (100 for 200k-window models) | Anthropic pictures a request | same |
| 512 MB, 1,500 pictures | an OpenAI request | OpenAI images-vision guide (design table) |
| 4096×2160 | Kimi pictures | Kimi vision guide's recommendation, the user's choice |
| 100 MB | a Kimi request body | Kimi vision guide |
| the OpenAI windows | Task 22's table | OpenAI's model pages, read 2026-10-28 (design table) |

## Choices this plan makes that the design leaves open

Each is marked in its task. None approved yet.
1. **The settings and keys files are out of the file tools' reach (Task 10)**, in every mode, as
   the data folder is. Found while planning: the design's "outside every project" is not true when
   the project is the home folder, where `project` mode would let the model rewrite them unasked.
   The user edits them by hand, `/settings` or `/keybindings`.
2. **Saving rewrites the file as two-space JSON (Task 8)**, keeping every entry and their order;
   the user's own spacing is not kept. JSON has no comments to lose.
3. **An empty settings or keys file during a session changes nothing (Task 9).** Editors such as
   Notepad empty a file before writing it; treating that moment as `{}` would reset every setting
   and then set it again. A file that is removed counts as `{}`, as the design says. A broken file
   is reported once for the same broken text.
4. **The editor runs through the system's shell (Task 12),** as Git runs `core.editor`: `cmd.exe
   /d /s /c` on Windows, `/bin/sh -c` elsewhere, with the file's path quoted after the entry, so
   `code --wait` (a `.cmd` on Windows) works. The environment is `commandEnv()`, keys removed. On
   Windows `& exit` is appended, so cmd's exit is the editor's, and a missing command gives 9009
   (`cmd /c` alone exits 1 for it; found at Task 12's build, measured).
5. **The editor's file** is `prompt.md` in a fresh `mkdtemp` folder in the system's temporary
   folder (the user's own on Windows), opened with mode 0o600, removed with its folder after.
6. **`/vim` alone switches vim mode on or off (Task 21)**, this window only (choice 26); `/vim on`
   and `/vim off` set it. Words other than those get the usage line.
7. **`status` in the settings file is a list of names (Task 7),** `["lead", "context"]`, as
   `--status` takes them comma-separated; `screen` is `"full"` or `"classic"`.
8. **Settings messages name the file and the entry (Task 7):** `settings.json: "mode" must be one
   of: ask, project, never (got "x")`, the flag's own words after the entry's name.
9. **Pictures live in memory for the session (Task 14)**, never on disk; quitting drops them.
10. **Provider errors keep their HTTP status (Task 16)** in a `status` field on the thrown error and
    on the bus's error event, so the 400 question (Task 18) never reads an error's words.
11. **Clipboard readers (Task 15):** Windows as the probe (Windows Forms under `-STA`, the PNG as
    base64 on stdout); macOS `osascript -e "get the clipboard as «class PNGf»"` (hex in its
    answer); Linux `wl-paste --type image/png` with `WAYLAND_DISPLAY`, else `xclip -selection
    clipboard -t image/png -o` with `DISPLAY`, else no reader.
12. **A format a provider does not list is sent as PNG (Task 17),** and an animated GIF as its
    first frame in PNG, since OpenAI takes only non-animated GIF.
13. **One yank register (Tasks 19-20),** as Claude Code's table describes (`p`/`P` "register
    contents"); no named registers.
14. **A picture's marker deletes as one character (Task 14):** Backspace at its end or Delete at
    its start removes all of `[Image #2]`, so no broken marker text is left behind (the design
    says a span goes when any of its characters is deleted; this deletes them all).
15. **The vim mode shows in the hint row in every mode (Task 21),** INSERT included, so the user
    can always see vim mode is on; another hint (a search, the exit warning, "Copied") takes the
    row first, as today.
16. **`~/.tachikoma` is made at launch when missing (Task 9),** with a plain `mkdir` (no
    permission change; `privateDir` runs only when a save writes there, and settings are never
    saved, choice 26), so the watcher has a folder to watch from the first session (found at the
    plan's second review). Watching the home folder itself instead would wake on every change
    there.
17. **A message waiting on a read that fails is sent without that picture (Task 14),** its marker
    removed and a line saying so, rather than held back or put back in the prompt, so the queue's
    order and newer typing are never disturbed (found at the plan's third review). Esc or Ctrl-C
    while it waits ends the wait the same way.
18. **A key set to `null` in a context does nothing there (Task 5),** even when an outer context
    binds it: `"ctrl+t": null` under Chat stops Ctrl+T at the prompt, and Global's Ctrl+T still
    works elsewhere (found at Task 5's spec review; Claude Code's docs leave it open; user: "Sure
    b").
19. **Global's actions act wherever Global is in force (Task 6),** as in Claude Code: at a
    question, in a Ctrl+R search, in the model list and in the detail view, Ctrl+T toggles the
    to-do list, Ctrl+O does `app:toggleTranscript` (it still closes the detail view) and Ctrl+D
    exits on its double press; Ctrl-C keeps each phase's own rule, as it is reserved (found at
    Task 6's build, where these keys did nothing outside the prompt; user: "All three everywhere").
20. **Keys match the table exactly (Task 6),** with no second try without a modifier, so keys that
    acted only because release 4 ignored a held modifier do nothing: Ctrl+Up and Alt+Up, Alt+Enter,
    Shift+Up and Shift+Down in the model list in full screen, and a wheel notch with Shift, Ctrl or
    Alt held. Classic mode still reads Shift+Up and Shift+Down as Up and Down, and Ctrl+Home and
    Ctrl+End as Home and End (found at Task 6's build; user: "Exact match"). Esc with Alt is still
    read as Esc, as in release 5, since it is what two fast Escs look like outside the kitty
    protocol, so `alt+escape` binds only where the terminal has the kitty protocol (found at Task 6's
    spec review).
21. **Task 11's keys-file words and rules (found at Task 11's build; the coordinator's call, for the
    user to review).** Each problem's words are in `src/keybindings.ts` and its tests; a broken file
    says the default keys apply at launch and the last good keys after. An action is unknown only
    when Tachikoma has it in no context; one bound where the screen does not use it does nothing.
    Every action and context on Claude Code's keybindings page that Tachikoma lacks is counted in
    the one skipped line, each key one entry, `cmd+ keys` for all four Super names. `command:` takes
    only Task 11's eight names, acts at the prompt, and waits in the queue during a turn, as Alt+P
    does. Of one key bound twice in a context the first stays, though one spelled the same twice in
    one block is not caught, as JSON keeps its last copy; a chord with a reserved key in it is
    refused, and `null` on a reserved key too; a top-level name other than `bindings`, `$schema` and
    `$docs` gets a line. `?` lists the keys bound to a command. The keys are read by the watcher's
    first read, not in cli.tsx, so `-p` never reads them; problems show in the conversation in both
    modes, each once while it stays; a good rebind says nothing. The watcher's lines name both
    files, and a watch that cannot start still reads both files once.
22. **A picture shows in the conversation as its marker inside the user's line (Task 14),** in the
    line's colour, not grey: grey inside a line needs coloured pieces through describe, Rows,
    Conversation and classic mode, about 50-80 lines (found at Task 14's build; the coordinator's
    call, for the user to review).
23. **Task 17's pictures, beyond its file list and choice 12.** The line saying how many pictures a
    request left out goes out as a `note` event on the bus, which App shows as a grey line; `-p`
    sends text only, so headless output never needs it. An animated GIF becomes its first frame in
    PNG only where a provider documents refusing animation: OpenAI ("non-animated GIF") and the
    ChatGPT plan, which reaches OpenAI's models through the same Responses API. Kimi takes animated
    GIF as it is, Anthropic uses only the first frame anyway, and Ollama and OpenRouter document
    nothing, so all four get it as it is (this refines choice 12); an animated GIF or WebP that is
    shrunk and keeps its format keeps its frames. Kimi's "4k (4096×2160)" is read as a size class,
    so an upright picture fits inside 2160×4096. A picture sharp cannot read, or one over the limit
    even at one pixel, is sent as it is, never cached as a failure, so the provider decides and a
    refusal there goes to Task 18's question (found at Task 17's build, spec review and code
    review; the coordinator's call, for the user to review).
24. **Remap pairs are two letters, digits, punctuation or symbols, with no space** (found at Task
    7's code review; the user's answer, 2026-10-29: no spaces).
25. **Task 18's question, beyond its text.** A request "carries pictures" when the conversation
    has picture parts and the provider is not yet marked, so the question can come even when
    Task 17 already turned every picture into a note; y then sends it once more and a second
    400 ends the turn. When the lead refuses and the fallback's own request then gets a 400, the
    fallback is the one asked about and marked; the lead keeps getting pictures. The question
    shows plainly, without "Allow " in front, though it uses the permission question's line
    (found at Task 18's build and spec review; the coordinator's call, for the user to review).
26. **A missing settings or keys file is skipped, and `/lead`, a `/model` pick and `/screen`
    change this window only (Tasks 8, 9 and 11; the user's answers, 2026-10-29).** A settings or
    keys file found missing while the session watches it is skipped, as an empty one is (choice
    3), so the settings and keys in force stay: an editor that saves by renaming a new file over
    the old one leaves none for a moment, which used to reset every setting, or every key, and set
    it again, saying the keys file's problems again each time. Deleting either file on purpose, or
    the whole folder, keeps them until a restart. Should `/settings` then make a new blank `{}`
    file after a file (not the folder) was removed, every setting goes back to its default at that
    moment, as a blank file sets nothing; the user expects this. After the folder is removed the
    watch is closed, so nothing resets. `/lead`, a `/model` pick and `/screen` change only the window they are typed
    in and save nothing, since every open window watches the file and would follow a save; to make
    a change last, the user edits the file (`/settings` opens it). A later edit of the file's
    `lead` or `screen` applies as any edit does. This replaces all of Task 8 (`saveSetting`, its
    lock and private write, the failed save's line, its tests and commit), and with it choice 2
    except for the blank file `/settings` makes, and the design's "Saving" bullet. In Task 9 and
    the design's "Live edits", the watcher no longer passes over Tachikoma's own save (Task 9's
    test 6 goes), and a removed file is no longer `{}`, nor is it in choice 3. `/vim` (choice 6,
    Task 21) changes this window only too.
27. **Task 21's vim keys and lines, beyond its text (found at Task 21's build; the coordinator's
    call, for the user to review).** Any Ctrl or Alt key in VISUAL or VISUAL LINE goes to NORMAL
    first, whatever is half typed, as Claude Code 2.1.312's vim hook does (`if(a.ctrl||a.meta)
    {if(l.mode==="VISUAL"){...}}`, read 2026-10-29); then a key the table binds does its action
    (Ctrl+T, Ctrl+O, Ctrl-C), and an editor key no binding takes (Ctrl+A, Ctrl+K, Alt+B) does
    nothing more, since Claude Code marks the key handled there and its text field skips it.
    Ctrl+D, which the table binds to `app:exit`, leaves VISUAL and then, with text, deletes the
    character after the cursor, as `app:exit` does on a prompt with text. In NORMAL and INSERT
    those editor keys keep working, as in Claude Code. Enter, bound to
    `chat:submit`, sends from VISUAL too, as bindings come first, and the mode is then NORMAL;
    Claude Code moves down a line there, which vim.ts does only after a count (`2` Enter). Any
    change App makes to the prompt's text in VISUAL (a message sent, a recall, a paste, a
    picture's marker taken out) leaves VISUAL for NORMAL, since VISUAL's anchor is a place in the
    old text; moving the cursor alone keeps VISUAL (found at Task 21's code review, where `o`
    after such a change crashed the screen). Every other key no binding takes,
    without Ctrl or Alt, goes to vim in NORMAL and VISUAL, so Home, End, Delete and Tab, which
    vim.ts does not use, do nothing there. A half-typed operator, find, `r` or `g` then Enter
    drops the command (Task 6's rule), where Claude Code's Enter sends whatever is half typed
    (2.1.312: `if(a.name==="return"&&l.mode!=="VISUAL"){f.handleKeyDown(a);return}`); a count
    alone then Enter sends, as Claude Code's does, the count dropped (vim.ts's Enter in NORMAL;
    found at Task 21's code review). `?` on an empty prompt in INSERT still lists the
    keys. j and k at the first or last line, and `/`, act as Up, Down and Ctrl+R do, so k on an
    empty prompt with messages queued takes them back, as Up does. Text read together is split
    into keys only at the prompt and its menus. Where App puts new text in the prompt, `.`
    forgets where INSERT's typing began: a message sent, a recall, the editor's text back, the
    queue brought back, a clear, a stash swap and a Ctrl+R search ending; and a remap pair's
    wait ends at any key `press` does not take, in every phase. The lines: `/vim` says
    `editorMode is now vim` or `normal` in grey, as `/screen` says `screen is now full`, naming the
    entry that makes it last; an edit of the file adds `(from settings.json)`, and one of the
    remaps says `vimInsertModeRemaps is now jj, jk`, or `none`; `/vim on` when on keeps the mode
    and says the line; other words get `Usage: /vim, /vim on, /vim off` in red, as `/tasks`'s
    mistakes do. `/vim` is in the `/` menu ("Switch vim mode on or off in this window") and the
    unknown command's list, after `/keybindings` (`src/tui/menus.ts`, beyond the task's files),
    as Task 12 put `/settings` and `/keybindings` there. The keys file's `command:vim` (Task 11)
    needed the `/vim` command itself and its place among the command names, as it runs through
    the same path as a typed `/vim`.
28. **VISUAL's selection is drawn in the prompt (Task 21; the user's answer, 2026-10-29, to a
    note from Task 21's spec review: build it in release 6).** As Claude Code 2.1.312 draws it
    (its cursor's `render`, read 2026-10-29): in reverse colours, its `invert`, the cursor's
    own style; from the anchor to the cursor's character, that character included; in VISUAL
    LINE from the first line's start to the last line's end; on each wrapped row the part of it
    there; an empty line in it as one reversed space; a selected line break at a line's end not
    drawn. The range is App's, from vim.ts's anchor, mode and the editor's cursor, as vim.ts's
    `visual()` takes it; vim.ts is unchanged. Leaving VISUAL by any key clears it. Two
    differences: Claude Code's picture markers are pills with a style of their own, which its
    selection leaves as they are, but Tachikoma's are plain text, so they are reversed like the
    rest, and a selection reaching into part of one draws all of it, as `d`, `y` and `c` there
    take all of it (vim.ts, `cover`). And the terminal's own cursor stays on the cursor's
    character over the reversed text, as Tachikoma always places it (release 3 design,
    "Multi-line").

---

## Task 1: One owner for the terminal

**Files:** create `src/tui/owner.ts`, `tests/tui/owner.test.ts`; modify `src/tui/App.tsx`,
`src/tui/input.ts`.

**What it is.** The one place that knows who has the terminal: it counts the hand-overs that hold
the keyboard, knows when Ink is suspended, and runs a program in the terminal (Task 12's editor)
only when no hand-over is under way.

**Rewritten at Task 1's build** (the builder stopped and asked): the first version made every
hand-over wait its turn and moved holding, suspending and diverting into the owner. Release 5's
tests check those steps in an exact order (the mouse off between the hold and the suspend, the
keys diverted after the printed page, a dropper kept past the resume), a `[` read while a resume
draws prints out at once, and a `[` read with the Enter that sends `/screen` is dropped. Queueing
would change all of that, against "nothing a user sees changes". So each flow keeps its own steps
in release 5's order and asks the owner only for what the flags answered; the queue is only
between a program and the rest.

```ts
export interface Hand {
  suspend(): Promise<{ resume(): Promise<void> }>;
  hold(on: boolean): void;
  divert(to: ((s: string) => void) | null): void;
  release(): void;   // InputFilter: let go of stdin, so a program reads every key itself
  retake(): void;    // InputFilter: read stdin again
}
export interface Handover {
  // Ink's suspend, as the flow called it; `suspended` is true from this call until the flow calls resume().
  suspend(): Promise<{ resume(): Promise<void> }>;
  done(): void;      // lets the keyboard go when no other hand-over still holds it
}
export class TerminalOwner {
  constructor(hand: Hand);
  take(): Handover;            // hold(true) now, at each start, as release 5 does; the flow's own steps follow
  get suspended(): boolean;    // a `[` then does nothing, as it would suspend Ink again, which throws (replaces `suspending`)
  get busy(): boolean;         // a hand-over is held, or a program runs or waits (Task 12's queue waits on it)
  // A program in the terminal: waits until nothing is held, suspends without the hold, so Ink's raw mode off goes
  // through, calls release() before the body, then retake() and resume after it, also when it throws. A take() can
  // come once its resume starts, Ink reading keys again (a `[`), never before: Ink reads none while suspended, and
  // what would hand the terminal over from the queue waits on `busy` (Task 12; found at Task 1's code review).
  program<T>(body: () => Promise<T>): Promise<T | undefined>;
  end(): void;                 // unmount: divert(null), hold(false); a program's ending then touches nothing
}
```

`InputFilter` gains `release()` and `retake()`: `release` removes its `"data"` listener from
stdin, pauses it and turns raw mode off on the source itself; `retake` turns raw mode on, adds the
listener back and resumes. Today the filter reads stdin for as long as Tachikoma runs (input.ts,
the constructor's `source.on("data")`), so a program in the terminal would lose keys to it (found
at the plan's second review).

`printOut` takes a hand-over and `comeBack` ends it; `switchScreen` takes one and ends it in its
`finally`. Each keeps release 5's steps and their order exactly (the `setTimeout(0)` waits,
`screen.enter`/`leave`, `setSecond`, `setMouse`, `PASTE_ON`/`PASTE_OFF`, the divert to the reader
and to the paste dropper), with `handover.suspend()` where `suspendTerminal()` was. `suspending`
goes (`owner.suspended`), and `switchRunning` with the `printed.current` checks before
`hold(false)` (the count: a print-out started while a switch or a coming back still holds keeps
the hold, as today). The unmount cleanup calls `owner.end()` where it called `divert(null)` and
`hold(false)`. A flow ending after `end()` still lets go again, as release 5's test of Ink ending
during a switch expects (harmless: input.ts, `hold`).

**Tests:**
1. Two hand-overs, the second taken before the first is done: `hold(true)` at each start,
   `hold(false)` once, after the second `done()`; in the other order of `done()` too.
2. `suspended` is true from `handover.suspend()` until the flow calls the `resume` it returned,
   and false before and after.
3. `end()` calls `divert(null)` and `hold(false)`; a hand-over done after it lets go again.
4. `program()` with nothing held: suspends without `hold(true)`, `release()` before the body,
   `retake()` and then resume after it, also when it throws (the throw passes on). With a
   hand-over held, it starts only after that `done()`. `busy` is true while it waits and runs.
5. `end()` while a program runs: when the body ends, neither `retake()` nor `resume()` is called,
   so stdin and raw mode stay let go with Ink gone; a program waiting behind a hand-over when
   `end()` comes resolves `undefined` without suspending, releasing or retaking.
6. `InputFilter.release()`: a fake source's `"data"` events while released reach no `"readable"`
   or `"data"` of the filter and are left to the source (its listener count is 0); `retake()` puts
   back raw mode, the listener and flowing, and the next key reaches Ink.
7. In App: every existing `[` and `/screen` test passes unchanged, the release 5 crash's among
   them (the `/screen` Enter, Ctrl+O and `[` in one read: the `[` dropped, nothing thrown).

Commit: `refactor: one owner knows who has the terminal, and a program in it waits its turn`.

## Task 2: One phase for what is happening now

**Files:** create `src/tui/phase.ts`, `tests/tui/phase.test.ts`; modify `src/tui/App.tsx`.

**What it is.** App's gating flags (`printed`, `switching`, `working`, `ended`, `listOpen`,
`picker`, the waiting question, `detail`, `search`, the open menu) read through one function,
so "who takes this key?" is asked of one thing.

```ts
// Who takes the keys: the order App's useInput decides in today (App.tsx 786-846), first match winning.
export type Phase =
  | { kind: "ended" } | { kind: "printed" } | { kind: "picker" } | { kind: "question" }
  | { kind: "detail"; searching: boolean } | { kind: "search" } | { kind: "menu" } | { kind: "prompt" };
// What is running, beside whoever has the keys: a turn can run under the detail view, a search, a menu or `[`, and
// next() and Ctrl-C need to know (found at the plan's second review).
export interface Now { phase: Phase; working: boolean; queued: number; waiting: boolean /* a question or the list holds the queue */ }
export function now(s: PhaseInputs): Now;
```

`PhaseInputs` holds the current values (from the refs). `useInput`, `usePaste`, `next()` and the
mouse handler call `now()` instead of reading the flags one by one. The refs stay where they are
(their writers do not change); only the reading is gathered.

**Changed at Task 2's build:** a `/screen` switch is no phase, since no key, paste, queue or mouse
check reads `switching` today (keys act in the mode it goes to); the inputs keep what is drawn
(`picker`, `question`) apart from what is open (`listOpen`, the questions waiting), as keys follow
the screen and the queue what is open; and the menu is found only when nothing before it takes
the key, as finding an `@` menu can list a folder. A paste does not follow the keys' order: a
search typed in the detail view takes it before a question, and the list is never asked, as
`usePaste` is off while it is drawn. So `pasteTo(inputs)`, beside `now()` over the same inputs,
gives release 5's paste rule, and later tasks keep the two apart (found at Task 2's build).

**Tests:**
1. `now()` gives each phase for its inputs, and the precedence: printed beats everything but
   ended; the picker beats a question; a question beats the detail view; and so on, one test per
   pair in the order above.
2. `working` is kept under every phase: a turn running with the detail view open, a Ctrl+R search,
   a menu and `[` printed out each give `working: true` with their own phase.
3. The whole suite passes unchanged.

Commit: `refactor: what is happening now is one phase, asked in one place`.

## Task 3: Layout sums out of drawing

**Files:** modify `src/tui/layout.ts`, `src/tui/App.tsx`; test `tests/tui/layout.test.ts`.

**What it is.** The sums at App.tsx 1266-1353 become one pure function, so they are tested as
numbers and render only reads its answer.

```ts
export interface FrameIn { rows: number; columns: number; full: boolean; promptText: string; cursor: number;
  promptTop: number;                       // the prompt window's first row last frame, which scroll() moves from
  working: boolean; toolLine: boolean; detail: boolean;   // the working line, a running tool's line, the detail view
  hint: string | null; menuRows: number; taskRows: number; todoRows: number; queued: number; pickerNeeded: number | null;
  askedText: string | null }
export interface FrameOut { promptRows: number; promptTop: number; todoShown: number; queuedShown: number;
  pickerRows: number; viewHeight: number; askedRows: number; questionFits: boolean; hinted: boolean }
export function frame(i: FrameIn): FrameOut;
```

The question's move into the conversation (`say` and the mutation at 1313-1323) stays in App,
acting on `questionFits`. The mouse-time sums (954-1041) read the last `FrameOut` from
`frame.current`, as they read the snapshot now.

**Tests:** `frame()` against the rows App draws today, one case per part: a tall prompt windowed,
a menu cutting the prompt, the task panel and to-do list sharing the room, "+N more" on the queue,
the picker taking its rows with one left for the conversation, a question that fits and one that
does not. Then the same frame with only the working line, only a tool line, only the detail
view, and a different last `promptTop`, each toggled on and off, every other input the same (found
at the plan's second review). The whole suite passes unchanged.

Commit: `refactor: the frame's sums are a function of their own`.

## Task 4: Listeners read the latest, and comments say what the code does

**Files:** modify `src/tui/App.tsx`; test `tests/tui/app.test.tsx`.

**What it is.** The handlers registered once (the `useEffect([])` at 295-420) call the latest
render's functions through one ref (`latest.current = { say, closeDetail, comeBack, next, dragTo,
pressAt, clickAt, copy, run }`, set every render), and read `columns` from `frame.current`, never
a captured value. Comments that tell the build's history ("found at Task 13's round 3", "the
user's choice at Task 9's review") are cut to what the code does and why, with the design's
section named; the user's choices keep a short "(the user's choice, release 5)".

**Tests:**
1. A detail view opened after a resize wraps at the new width when opened from a bus event (a
   subagent's record) and from the mouse.
2. `[` after a resize prints at the new width.
3. The whole suite passes unchanged.

Commit: `refactor: listeners made once call the latest functions, and comments drop the build's history`.

## Task 5: The table of actions

**Files:** create `src/tui/bindings.ts`, `tests/tui/bindings.test.ts`.

**What it is.** Claude Code's key syntax, a keystroke made from what Ink reports, the default
table, and the lookup, as plain data.

```ts
export type Context = "Global" | "Chat" | "Autocomplete" | "Confirmation" | "HistorySearch" | "Select" | "Transcript" | "Scroll";
export interface Stroke { key: string; ctrl: boolean; alt: boolean; shift: boolean }   // key: "a", "enter", "pageup", "wheelup"...
export function parseKeys(text: string): Stroke[] | { problem: string };              // "ctrl+x ctrl+e" is two strokes
export function strokeOf(input: string, key: InkKey): Stroke | null;                    // from Ink's useInput arguments
export const RESERVED: Stroke[];                                                       // ctrl+c, ctrl+d, ctrl+m, ctrl+[, ctrl+i, ctrl+h
export const DEFAULTS: Record<Context, Record<string, string>>;                        // Claude Code's file shape: keys -> action
export class Bindings {
  constructor(table: Record<Context, Map<string, string | null>>);                    // built from DEFAULTS and the keys file (Task 11)
  // The action for this stroke in the contexts in force (innermost first), a chord under way, or nothing.
  press(stroke: Stroke, contexts: Context[], now: number): { action: string } | { pending: Stroke[] } | null;
  keysFor(action: string, context: Context): string[];                                 // for help and hints
}
```

**The default table** is today's keys under Claude Code's names where Claude Code has the action
(design, "Keys become named actions"): `app:interrupt` Ctrl+C, `app:exit` Ctrl+D,
`app:toggleTodos` Ctrl+T, `app:toggleTranscript` Ctrl+O; `chat:submit` Enter, `chat:newline`
Shift+Enter and Ctrl+J, `chat:cycleMode` Shift+Tab, `chat:modelPicker` Alt+P, `chat:undo` Ctrl+Z
and Ctrl+_, `chat:cancel` Escape, `history:search` Ctrl+R, `history:previous` Up and Ctrl+P,
`history:next` Down and Ctrl+N, `chat:externalEditor` Ctrl+G and Ctrl+X Ctrl+E, `chat:stash` Ctrl+S,
`chat:imagePaste` Alt+V on Windows, both Alt+V and Ctrl+V on WSL (as Claude Code; found at Task 5's
spec review: Windows Terminal never passes Ctrl+V on), and Ctrl+V elsewhere; `autocomplete:accept` Tab,
`autocomplete:dismiss` Escape, `autocomplete:previous`/`next` Up/Down; `confirm:yes` y,
`confirm:no` n and Escape; `historySearch:next` Ctrl+R, `historySearch:accept` Escape and Tab,
`historySearch:cancel` Ctrl+C, `historySearch:execute` Enter; `select:next`/`previous`
Down/Up, `select:accept` Enter, `select:cancel` Escape; `transcript:exit` q, Ctrl+C and Escape;
Tachikoma's own `transcript:print` `[`, `transcript:search` `/`, `transcript:nextMatch` n,
`transcript:previousMatch` N, `transcript:lineDown` j and Down, `transcript:lineUp` k and Up,
`transcript:top` g and Home, `transcript:bottom` G and End; `scroll:pageUp` PageUp,
`scroll:pageDown` PageDown, `scroll:top` Ctrl+Home, `scroll:bottom` Ctrl+End, `scroll:lineUp`
Shift+Up and wheelup, `scroll:lineDown` Shift+Down and wheeldown. (Ctrl+P and Ctrl+N are
release 3's history keys; Claude Code puts them on Select.)

**Tests:**
1. `parseKeys`: modifiers by every alias (`control`, `opt`, `option`, `meta`), case ignored,
   special keys by name, a chord, and each problem with its words: a misspelled modifier
   (`ctl+k`: `unknown modifier "ctl"`), a space beside `+` (`ctrl+ k`: `a space beside "+"`).
2. `strokeOf` for what Ink reports for each default key (Ctrl+G's `\x07`, Alt+V's `ESC v`, the
   probe's codes; PageUp, Shift+Up, Shift+Tab), and null for a paste.
3. `press`: innermost context first; a chord's first stroke gives `pending`, the second within
   3 s the action, after 3 s nothing (fake clock); a stroke that starts no chord and has no
   binding gives null, so the editor keys act.
4. `keysFor("chat:externalEditor", "Chat")` is `["ctrl+g", "ctrl+x ctrl+e"]`.
5. Every action App handles today has a default binding (a list in the test).

Commit: `feat: keys as named actions in Claude Code's format, with chords`.

## Task 6: App reacts to actions

**Files:** modify `src/tui/App.tsx`, `src/tui/keys.ts`, `src/tui/DetailView.tsx`,
`src/tui/ModelPicker.tsx`, `src/tui/WorkingLine.tsx`, `src/tui/Conversation.tsx`; tests in
`tests/tui/app.test.tsx`, `tests/tui/keys.test.ts`.

**What it is.** Each phase (Task 2) maps to its contexts, innermost first:

| Phase | Contexts | In full screen also |
|---|---|---|
| prompt | Chat, Global | Scroll, after Chat |
| menu | Autocomplete, Chat, Global | Scroll, after Chat |
| question | Confirmation, Global | Scroll, after Confirmation |
| search (Ctrl+R) | HistorySearch, Global | Scroll, after HistorySearch |
| detail | Transcript, Global | Scroll, after Transcript |
| picker | Select, Global | none |
| printed, ended (a /screen switch is no phase: keys act in the mode it goes to, Task 2) | none (keys go where they go today) | none |

So PgUp, PgDn, Ctrl+Home and Ctrl+End keep scrolling in a search and in the detail view, as they
do today (found at the plan's second review); in classic mode Scroll is never in force, and the
keys keep release 4's meanings as today. A context's own binding beats Scroll's, so the detail
view's Home and End stay `transcript:top`/`bottom`. The wheel is the one exception under the model
list: it still scrolls the conversation there (release 5's choice 3), so in full screen the mouse
handler presses wheel strokes with Scroll after Select for the picker, while keys get none (found
at Task 2's code review).

**A chord under way comes first** (found at the plan's third review): while a chord's first key
waits, the next key goes to `bindings.press` before anything below, so a chord ending in a plain
letter completes in a search or the model list's filter too. A key that does not complete it drops
the chord and is then handled as if no chord had waited (typed into the field, or bound); after
3 s the chord is dropped and the next key is handled as usual. `press` returns null both for a
dropped chord and for a key with no binding, so App asks `bindings.waiting(now)` first, sends the
key to `press` only while a chord waits or once the text-field rule has passed it, and after a
dropped chord handles the key again from the top (Task 5 as built; found at its spec review).

**The wheel** never reaches `useInput` (the input filter takes mouse reports out), so the mouse
handler makes `wheelup` and `wheeldown` strokes from wheel events, with the modifiers the report
carries, and presses them in the contexts in force (found at Task 5's spec review).

**Before any other binding** (found at the plan's second review), two kinds of key go straight to
what is being typed, as Claude Code's "Text fields" rule says: while a Ctrl+R query, a detail-view
search or the model list's filter is being typed, a printable key without Ctrl or Alt goes into it
(so `q`, `n` and `/` are letters there), and Enter, Esc, Tab, the arrows and Ctrl or Alt keys still
match bindings; and in vim mode (Task 21) Esc in INSERT or VISUAL, and every key without Ctrl or
Alt while a vim command is half typed, go to vim. Then App asks `bindings.press` and runs the
action; a key no binding takes goes to `commands()` for the editor's own keys, which no longer
lists the keys now in the table (design: "Bindings come first"). The double press, the backslash
before Enter and `?` on an empty prompt keep their rules, now under their actions. `KEY_LIST` is built from the table with `keysFor`;
every hint that names a key ("Esc to stop", "· Ctrl+End", "Ctrl+R older", the detail view's key
row, the picker's help, "Esc to decline") names the first key bound to its action.

The ChatGPT login, model list and question code keep their own keys only where the table has no
action for them (the picker's filter typing; y/n stay `confirm:yes`/`no`).

**Tests:**
1. Every key in today's tests still does what it did (the suite passes; any test changed only
   because a hint's text is now built, with the same words).
2. A table with Ctrl+E bound to `chat:externalEditor` takes Ctrl+E from end-of-line (the action is
   recorded; the cursor does not move).
3. A table with `app:toggleTodos` unbound and on Ctrl+Y: Ctrl+T does nothing, Ctrl+Y toggles, and
   `?` lists Ctrl+Y.
4. "Esc to stop" reads "Ctrl+Q to stop" with `chat:cancel` on Ctrl+Q (the working line).
5. A chord's first key shows in the hint row (`ctrl+x ...`) until the second or 3 s.
6. In full screen, PgUp, PgDn, Ctrl+Home and Ctrl+End scroll at the prompt, with a menu open, at a
   question, in a Ctrl+R search and in the detail view; in classic they do what they do today.
7. Typing `q`, `n` and `/` into a detail-view search puts them in the query and does not close the
   view or step matches; `q` in a Ctrl+R query is a letter; Esc in both still does what it does.
8. With a bare letter bound in Chat (`"x": "app:toggleTodos"`), it is not typed at the prompt but is
   typed into a Ctrl+R query.
9. With `"ctrl+x t": "app:toggleTodos"` bound in Global, in a Ctrl+R query and in the model list's
   filter: Ctrl+X then `t` toggles the list and types nothing; Ctrl+X then `q` types `q`; Ctrl+X,
   3 s, then `t` types `t` (fake clock).

Commit: `feat: the screen reacts to actions, and help and hints follow the key table`.

## Task 7: Reading the settings file

**Files:** create `src/settings.ts`, `tests/settings.test.ts`; modify `src/cli.tsx`,
`src/clilib.ts`; tests in `tests/cli.test.ts`.

**What it is.**

```ts
export const SETTINGS = "settings.json";
export function settingsDir(home = os.homedir()): string;       // ~/.tachikoma
export interface Settings { lead?: string; mode?: Mode; effort?: Effort; fallback?: string; worker?: string; maxTasks?: number;
  status?: Segment[]; screen?: "full" | "classic"; scrollSpeed?: number; editorMode?: "normal" | "vim";
  vimInsertModeRemaps?: Record<string, "<Esc>">; editor?: string }
// Parses and checks; unknown names come back as warnings, a bad value as a problem naming the entry.
export function readSettings(text: string): { settings: Settings; warnings: string[] } | { problem: string };
export function loadSettings(home?: string): { settings: Settings; warnings: string[] } | { problem: string }; // missing file = {}
```

Each value is checked by the flag's own rule (`oneOf`, the digits rule for `maxTasks`,
`statusSegments`, `scrollSpeed`'s range), and `lead`, `fallback` and `worker` by `createProvider`
at use, as flags are. Messages (choice 8): `settings.json: "mode" must be one of: ask, project,
never (got "x")`; an unknown name `settings.json: "leed" is not a setting; it was left out`; bad
JSON `settings.json is not valid JSON: <parser's words>`. `vimInsertModeRemaps` keys must be two
printable characters and the value `"<Esc>"`; other entries are dropped with a warning (design,
"Vim mode"). `$schema` is allowed and ignored.

In cli.tsx each option becomes flag, then variable, then file, then default (design: "Which
wins"). A broken file at launch stops Tachikoma with its problem, exit 1. Warnings print to
stderr before the session starts. With no lead anywhere: `No lead model given. Pass --lead, set
TACHI_LEAD, or put "lead": "<provider:model>" in ~/.tachikoma/settings.json.` (the path as on
this machine, `~` for the home folder). `-p` reads the file too; `-p` still ignores
`TACHI_SCROLL_SPEED`, and so `scrollSpeed` (release 5's rule).

**Tests:**
1. `readSettings`: each entry's good and bad values with the exact messages; unknown names;
   `$schema`; bad JSON; every entry optional.
2. Precedence, per option with a value in each place (clilib-style pure function `resolve(flags,
   env, settings)`): flag beats variable beats file beats default.
3. `tachi` with `{"lead": "ollama:none"}` in the test home's settings and no flag starts (exits at
   the stand-in terminal as other cli tests do); with no lead anywhere, the new message.
4. A broken file: exit 1 with its message; an unknown entry: the warning on stderr, the session
   starts.
5. `-p` with the file's lead runs.

Commit: `feat: a settings file supplies every launch option, flags still winning`.

## Task 8: Saving to the settings file

**Replaced by choice 26 (the user's answers, 2026-10-29): nothing is saved.**

**Files:** modify `src/settings.ts`, `src/tui/App.tsx`, `src/cli.tsx`; tests in
`tests/settings.test.ts`, `tests/tui/app.test.tsx`.

```ts
// Sets one entry and keeps every other as it was; under withLock(`${file}.lock`), read again inside the lock.
export function saveSetting<K extends keyof Settings>(key: K, value: Required<Settings>[K], home?: string): Promise<void>;
```

The file is written with `writePrivate` after `privateDir(settingsDir)`, as JSON with two-space
indents (choice 2). `/lead` and a `/model` pick save `lead`; `/screen` saves `screen`. A failed
save leaves the change in force and says `The change holds for this session, but saving it to
~/.tachikoma/settings.json failed (<reason>).` Shift+Tab saves nothing.

**Tests:**
1. `saveSetting` into a file with other entries, an unknown one included, keeps them all and their
   order; into a missing file makes it.
2. Two saves at once (two `saveSetting` calls without awaiting the first, and a second process
   through `withLock` as history.test.ts does) lose neither entry.
3. In App: `/lead ollama:a` writes `"lead": "ollama:a"`; a `/model` pick writes its spec;
   `/screen` writes `"screen": "classic"`; Shift+Tab writes nothing.
4. A save into a folder the test made read-only by making `settings.json` a folder: the line above,
   and the lead changed anyway. (No permission changes: the "file" is a directory.)

Commit: `feat: /lead, /model and /screen save their choice to the settings file`.

## Task 9: Live settings

**Partly replaced by choice 26 (the user's answers, 2026-10-29): no own save, a removed file skipped.**

**Files:** create `src/settingsWatch.ts`, `tests/settingsWatch.test.ts`; modify `src/cli.tsx`,
`src/tui/App.tsx`, `src/core/session.ts`, `src/core/tasks.ts`, `src/providers/anthropic.ts`,
`src/tui/StatusLine.tsx`; tests in `tests/tui/app.test.tsx`.

```ts
// Watches the folder, made first if missing (choice 16), and calls back with each real change.
export function watchSettings(home: string, on: (next: { settings: Settings; warnings: string[] } | { problem: string }) => void): () => void;
```

The watcher reads the file on each folder event and calls back only when the text differs from
the last it read and is not Tachikoma's own last save. An empty file is skipped (choice 3); a
removed file is `{}`; a broken file is reported once per broken text, the last good settings
kept. App applies each changed entry by the design's table ("The settings file", "When a live
change applies"), saying one grey line per change (`lead is now ollama:b (from settings.json)`),
and for an entry given by a flag or variable at launch, `settings.json's "mode" was left as
--mode set it for this session`. A live change to `never` says `"mode": "never" applies only when
a session starts; the mode stays <mode>` (the user's choice, design).

**The launch's warnings show in the session too** (found at Task 7's code review): Task 7 prints
an unknown entry's warning to stderr before the session starts, but full screen then switches to
the second screen, so the line is not seen until the user quits. App shows the launch's warnings
as grey lines when it opens, as it shows the instruction files' line; classic mode and `-p` keep
stderr only, so nothing prints twice where stderr is already seen.

What becomes changeable: `Session.setFallback(p | undefined)`; `Tasks.setWorker(fn)` and
`Tasks.setMax(n)` (lowering holds back new starts, stops none); `AnthropicProvider.setEffort(e)`,
read by each `complete()`, so a change made while a turn runs its tools applies from the very next
request of that turn (the design's "from the lead's next request"; found at the plan's second
review), and by `makeProvider` for later leads; `segments` and `scrollSpeed` become App state.

**Tests** (a real temporary home; the watcher's events awaited with `vi.waitFor`):
1. One test per row of the design's table: change, then removal (back to the flag's value, or the
   default), each with its line.
2. `lead` removed with no flag: the session keeps its lead, and the line says so.
3. A live `never` refused; a session started in `never` going to `ask` applies.
4. An empty write, then the full text: one change, no reset line.
5. Broken text: one problem line, the last good settings in force; the same broken text again: no
   second line; then good text: applied.
6. Tachikoma's own save (Task 8) gives no line.
7. `effort` changed while a tool runs inside a turn: the request after the tool's result carries
   the new effort, the one before it the old.
8. First launch with neither `~/.tachikoma` nor the file (choice 16): the folder is made, the
   watcher started, and a file written there later applies.

Commit: `feat: edits to the settings file apply in the running session`.

## Task 10: The file tools never touch the settings and keys files (choice 1)

**Files:** modify `src/tools/files.ts`, `src/tools/search.ts`; tests in `tests/tools/files.test.ts`.

`resolveIn` refuses `~/.tachikoma/settings.json` and `~/.tachikoma/keybindings.json` (and their
lock and temporary files, `settings.json.*`) as it refuses the data folder: by real path and file
identity, in every mode: `<path> is one of Tachikoma's settings files, which the file tools never
touch; edit it with /settings or /keybindings`. The search tools skip them.

**Tests:** read, write and edit refused in `ask`, `project` and `never`, through a link too, with
the message; with the project root being the test's home folder; search leaving them out.

Commit: `feat: the file tools never touch the settings and keys files`.

## Task 11: The keys file

**Files:** create `src/keybindings.ts`, `tests/keybindings.test.ts`; modify `src/cli.tsx`,
`src/settingsWatch.ts`, `src/tui/App.tsx`.

```ts
export const KEYBINDINGS = "keybindings.json";
// Lays the file over DEFAULTS; every problem is one line, and the rest applies.
export function readKeybindings(text: string): { table: Bindings; problems: string[] } | { problem: string };
```

Claude Code's shape (design, "The keys file"): `{"bindings": [{"context", "bindings": {keys:
action | null}}]}`; `$schema` and `$docs` allowed. `null` unbinds; `command:<name>` runs a slash
command that takes nothing after it (`/exit`, `/errors`, `/model`, `/screen`, `/tasks`, `/vim`,
`/settings`, `/keybindings`). Problems, each with its words: an unknown context, an unknown action
in a context, a reserved key, the same key twice in one context, a key problem from `parseKeys`.
Actions only Claude Code has (a list from Claude Code's keybindings page, read 2026-10-28:
`chat:fastMode`, `chat:thinkingToggle`, `chat:killAgents`, `chat:queueSubmit`, `chat:sendNow`,
`chat:clearInput`, `chat:clearScreen`, `task:background`, and the contexts Tachikoma lacks) are
counted in one line: `keybindings.json: 3 entries skipped: Tachikoma has no chat:fastMode,
task:background, Footer`. A key with a modifier Tachikoma cannot read (`cmd`, `command`, `super`,
`win`; Task 5) is counted the same way, `Tachikoma has no cmd+ keys`, not one line an entry, so a
Claude Code file made on a Mac is not noisy (found at Task 5's spec review). Bad JSON at launch keeps the defaults and says so; during a session it
keeps the last good keys. Live, through the same watcher as Task 9 (one folder, two files).

**Tests:** each problem's line; the skipped count with Claude Code's own example file from its
docs; `null` freeing Ctrl+S; `command:screen` on a key running `/screen`; live: a rebinding
applying without restart, and `?` following it.

Commit: `feat: the keys file rebinds actions, live, in Claude Code's format`.

## Task 12: The external editor, /settings and /keybindings

**Files:** create `src/tui/external.ts`, `tests/tui/external.test.ts`; modify `src/tui/App.tsx`.

```ts
// VISUAL, then EDITOR, then the settings' editor, then Notepad (System32) on Windows or vi.
export function editorCommand(env: NodeJS.ProcessEnv, setting: string | undefined, platform: NodeJS.Platform): string;
// Writes `text` to a private temporary file, runs the editor through the shell (choice 4), and returns the file's text,
// or the reason it failed. The folder is removed after.
export function editText(text: string, command: string, run?: Runner): Promise<{ text: string } | { failed: string }>;
// Opens an existing file in place, so each save the editor makes reaches the settings watcher while it is still open.
export function editFile(file: string, command: string, run?: Runner): Promise<{ ok: true } | { failed: string }>;
```

Both start the editor with stdio inherited, inside `owner.program()` (Task 1), so an editor that
runs in the terminal reads the keys itself and Tachikoma reads none until it ends. Under the shell
(choice 4) a missing command is the shell's "not found" exit (9009 from `cmd.exe`, 127 from `sh`).

`chat:externalEditor` runs `owner.program(...)` (Task 1). While `owner.busy` is true the queue
starts no queued `/screen`, `/settings` or `/keybindings`, the commands that hand the terminal
over, so a turn ending while the editor is open runs none of them until it closes; messages and
other commands go on, as they do while the view is printed out (found at Task 1's build and code
review). Full screen leaves the second screen and
the mouse as `[` does, and comes back. While away, Ink's renders are dropped as for `[`, the turn goes on, and a
permission question waits (it is shown on return). On return: the prompt becomes the text,
without one trailing `\n` or `\r\n`, the cursor at the end, as one undo step. On failure the
prompt is unchanged and one line: `The editor failed (<reason>). Set VISUAL or EDITOR, or
"editor" in ~/.tachikoma/settings.json.`; not found: `<command> was not found. Set ...` (same
end). `/settings` and `/keybindings` open their real file with `editFile` (found at the plan's
second review: a temporary copy would reach the watcher only after the editor closed, if at all),
making a missing one first (`{}`, `{"bindings": []}` with two-space indents).
A live edit of `editor` says its line, as Task 9's entries do, since Task 9 holds the file's last
settings in `fileNow` (found at Task 9's spec review).

**Tests** (a stand-in editor: a small Node script given as the command that rewrites the file, or
exits 1, or sleeps until told):
1. `editorCommand`'s order, each source alone and together.
2. `editText` round trip; the trailing line break dropped (one only); exit 1 gives `failed`; a
   missing command; the temporary folder gone after each.
3. In App: Ctrl+G with the stand-in replaces the prompt; Ctrl+Z gives the text before; a bus
   message arriving while away is in the conversation on return; a permission question asked
   while away is shown on return; Ctrl+X Ctrl+E does the same as Ctrl+G.
4. `/settings` makes `{}` in a test home and opens the real file; a stand-in that saves, waits
   for a signal file, then exits shows the change applied by the watcher while it still runs.
5. An interactive stand-in that reads one line from its own stdin and writes it into the file:
   started through `editText` with stdio inherited and a fake terminal source, the filter has let
   go (no key reaches Ink meanwhile), and afterwards the next key reaches Ink again.
6. Each `Runner` call gets `stdio: "inherit"` and `commandEnv()`.

Commit: `feat: Ctrl+G opens the prompt in an editor, and /settings and /keybindings open their files`.

## Task 13: Stash

**Files:** modify `src/tui/App.tsx`; tests in `tests/tui/app.test.tsx`.

`chat:stash` with text: the editor (text, cursor, and from Task 14 its spans) goes into one slot
and the prompt clears; the hint row shows `Stashed · Ctrl+S to bring back` (the bound key) while
the slot is full and no other hint takes the row. On an empty prompt: the slot comes back and
empties. With text and a full slot: the two swap (the design's call). The slot lasts the session.

**Tests:** stash and back, cursor kept; swap; the hint; the hint naming a rebound key; undo after
bringing back works within the restored text.

Commit: `feat: Ctrl+S stashes the prompt and brings it back`.

## Task 14: Pictures in the prompt and the conversation

**Files:** create `src/tui/pictures.ts`, `tests/tui/pictures.test.ts`; modify `src/core/types.ts`,
`src/tui/editor.ts`, `src/tui/App.tsx`, `src/core/session.ts`; tests in `tests/tui/editor.test.ts`.

```ts
// types.ts
| { type: "image"; id: number; mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: Buffer }

// pictures.ts: the session's pictures, by number (choice 9)
export class Pictures {
  next(): number;                                     // takes the next number
  // A read's result, wherever its marker is. Every read ends in one of these, never left "reading".
  set(id: number, p: { mediaType: ...; data: Buffer } | "none" | { failed: string }): void;
  get(id: number): { mediaType; data } | "reading" | "none" | { failed: string } | undefined;
  settled(id: number): Promise<void>;                 // resolves when the read ends, however it ends
  sent(id: number): boolean; markSent(id: number): void;
}
export const marker = (id: number) => `[Image #${id}]`;

// editor.ts: spans move with edits, go when any of their characters is deleted, and are part of each undo step
export interface Span { id: number; from: number; to: number }
// Editor gains `spans: Span[]`; `undo` states become {text, cursor, spans}. insertPicture(e, id) puts the marker at
// the cursor as one step.
```

`send` builds the user message's parts from the editor: text split at each span whose picture has
not been sent, the picture part at its first span (design, "Which pictures a message carries");
later copies, sent pictures' spans and look-alike text stay text. The queue keeps
`{text, spans}` entries instead of strings; `restore()` and Ctrl-C's return to the prompt keep the
spans. Prompt history stores text only, so recalled markers carry nothing. A message whose spans
are still reading waits for `settled()` before it is sent; Enter during that wait does nothing
more. A read that ends `"none"` or failed (found at the plan's third review) removes its spans
from the prompt, the stash and every queue entry, the message waiting on it included, which is
then sent without it; the line says why and names the marker (choice 17). Esc or Ctrl-C while a
message waits on a read settles that read as failed (`stopped`), so a reader that never answers
cannot hold the prompt.

The conversation view shows a picture part as its marker in its place in the user's line, in the
line's colour (choice 22).

**Tests:**
1. Editor: inserting a picture; typing before it moves the span; Backspace at its end and Delete
   at its start remove the whole marker as one character would (choice 14); a selection or word
   delete reaching into it removes it whole too; undo brings it back with its span; `load()`
   (history) has no spans.
2. Message building: two pictures in order; a picture already sent stays text; a duplicate span
   (from Task 20's yank, simulated by two spans of one id) sends once, at the first; typed
   `[Image #1]` without a span is text.
3. In App: Enter with a picture whose read is still `reading` waits, then sends with it; the queue
   and stash keep spans; a recalled history entry with a marker sends no picture.
4. A read failing after Enter: the message goes without the picture, its marker gone from the
   sent text, with the line; the same for a queued message whose read fails while a turn runs, and
   for `"none"`; Esc during the wait settles the read and the message goes without it.

Commit: `feat: pictures as spans in the prompt and parts in the conversation`.

## Task 15: Reading pictures: the clipboard and pasted paths

**Files:** modify `src/tui/clipboard.ts`, `src/tui/App.tsx`; tests in `tests/tui/clipboard.test.ts`,
`tests/tui/app.test.tsx`.

```ts
export function imageReader(platform, env): Tool | null;   // choice 11; stdout piped
export function readImage(tool: Tool): Promise<{ mediaType; data: Buffer } | "none" | { failed: string }>;
export function imagePaths(paste: string): string[] | null; // every line a path to .png .jpg .jpeg .gif .webp, quotes stripped
```

`chat:imagePaste` takes `pictures.next()`, inserts its span at once, shows `Reading picture...` in
the hint row while any read runs, and calls `readImage`; the result goes to `pictures.set` (design,
"While a read runs"). A deleted span does not stop the read; undo brings back span and picture.
"none" removes the span from the prompt, stash or queue entry holding it, and says `No picture on
the clipboard.`; a failed read settles as `{failed}`, removes its spans the same way and says
`Could not read the clipboard: <reason>`; with a message waiting on it, both lines end `; [Image
#3] was sent without it.` (Task 14); no reader: `No
clipboard reader here: install wl-paste or xclip.` (Linux). A paste that `imagePaths` accepts and
whose files all exist becomes those pictures (read with `fs.readFile`, type from the file's first
bytes, not its name); otherwise it is text as today.

Task 14 already wires `chat:imagePaste` to `pictures.next()` and the span (App.tsx, `imagePaste`), and
already says the "none" and failed lines, with their ending, from its one settle handler (`settle`,
grey for "none", red for a failure, Esc's `stopped` included). This task adds the read, the hint and
the readers to that wiring. `settle`'s words name the clipboard, so a pasted file path's read passes
its source, or its own words, into `settle` (found at Task 14's spec review). A pasted path's picture
takes its number through `newPicture` (App.tsx), as Alt+V does, so its `settle` runs when its read
ends (found at Task 14's code review).

**Tests:** each reader's command line per platform and env (no real clipboard); `readImage` with a
stand-in tool that prints a small PNG's base64, prints nothing, or fails; `imagePaths` with
quotes, several lines, a Windows path with spaces, a non-image, a missing file; App: span first,
picture after, order of two reads kept, delete-then-undo during a read, "none" from a queued
entry, a failing tool after Enter and in a queued entry (the message sent, the picture left out,
nothing left waiting), the hint while reading and gone once every read has settled.

Commit: `feat: Alt+V reads a picture from the clipboard, and a pasted image path becomes one`.

## Task 16: Each adapter sends pictures, and errors keep their status

**Files:** modify `src/providers/anthropic.ts`, `src/providers/openai.ts`,
`src/providers/chatgpt.ts`, `src/core/types.ts`, `src/core/session.ts`, `src/core/bus.ts`; tests
in `tests/providers/*.test.ts`, `tests/core/session.test.ts`.

- `toAnthropic`: an image part becomes `{type: "image", source: {type: "base64", media_type, data}}`
  in place.
- `toOpenAI`: a user message with an image part sends `content` as a parts array: `{type: "text",
  text}` and `{type: "image_url", image_url: {url: "data:<type>;base64,<data>"}}` in order; without
  pictures it stays one string, as today.
- `toResponses`: `{role: "user", content: [{type: "input_text", text}, {type: "input_image",
  image_url: "data:..."}]}` for a message with pictures.
- Each picture sent goes right after a text `[Image #N]` (its marker), in all three, so the model
  sees the number the design says the user can "point it at" later; a note in a picture's place
  gets no label (found at Task 16's build).
- Each converter takes the pictures as Task 17 prepared them (a map from id to the data to send,
  or a note's text): `toX(messages, prepared)`.
- Errors (choice 10): a `ProviderError extends Error` with `status?: number`, thrown by chatgpt.ts
  where it builds `planError` (the message unchanged), and kept by the session: the error event
  gains `status?`. Anthropic's and OpenAI's `APIError` already carry it; session reads
  `err.status` when it is a number.

**Tests:** each converter's output for a message with text, two pictures and a tool result, against
the provider's documented shape (the design's sources); a note in place of a picture is text;
`ProviderError`'s status reaching the bus's error event for each adapter (Anthropic and OpenAI
through their SDK's error, ChatGPT through the local server the tests already run, answering 400).

Commit: `feat: the three adapters send pictures, and a provider error keeps its HTTP status`.

## Task 17: Shrinking pictures to each provider's limits

**Before the builder starts, the controller runs** `sfw npm install sharp@0.35.5 --save-exact`
(with a time limit and `--loglevel=http`, as the sfw note says), checks `npm ls sharp` and that
`node -e "require('sharp')"` loads, and commits `package.json` and the lock file:
`build: add sharp 0.35.5 for shrinking pictures`.

**Files:** create `src/providers/pictures.ts`, `tests/providers/pictures.test.ts`; modify the three
adapters' `complete()` and `src/core/session.ts`.

```ts
export interface Limits { maxBase64?: number; maxSide?: number; manySide?: { over: number; side: number }; fit?: [number, number];
  maxRequest?: number; maxCount?: number; formats: string[] }
export const LIMITS: Record<"anthropic" | "openai" | "kimi" | "openrouter" | "ollama" | "chatgpt", Limits>; // the design's table, each with its source
// For one request: every picture in `messages`, shrunk from its original to fit, the oldest left out as notes until the
// request fits, and how many were left out.
export function prepare(messages: Message[], limits: Limits, measure: (prepared) => number, cache: Cache): Promise<{ prepared; leftOut: number }>;
```

Rules (design, "Pictures"): sizes measured as base64; a picture over `maxBase64` scaled by the
square root of allowed over actual and measured again until it fits; `maxSide` and, when the
request holds more than `manySide.over` pictures (earlier turns included), `manySide.side`; Kimi's
`fit` keeps the shape inside 4096×2160; formats outside `formats` become PNG, animated GIF its
first frame (choice 12); the whole request measured by `measure` (the adapter's serialized body)
against `maxRequest`, and the picture count against `maxCount`; over either, the oldest pictures
become notes `[Image #2 left out: the request was over Anthropic's 32 MB]` until it fits, and the
session says `2 pictures were left out of this request to fit Anthropic's 32 MB.` The cache key is
the picture's id and the limits it was shrunk to. The fallback and every request build their own.

**Tests:** with generated pictures (sharp makes them in the test): a picture just over 10 MB as
base64 but under as bytes is shrunk; 8000 side; 21 pictures shrink all to 2000, and the cache makes
new copies at that crossing; Kimi's fit; a WebP for a provider without WebP becomes PNG; a request
over the cap leaves out the oldest first, with the notes and the line; OpenAI's no per-picture
limit; Ollama untouched; the lead and the fallback getting copies for their own limits.

Commit: `feat: pictures are shrunk to each provider's documented limits, request by request`.

## Task 18: A refused request with pictures

**Files:** modify `src/core/session.ts`, `src/tui/App.tsx`; tests in `tests/core/session.test.ts`,
`tests/tui/app.test.tsx`.

When a request carrying pictures fails with `status === 400`, the session emits the error as
today, then asks through the permission question's path (`ask`), with no owner: `Send again
without the pictures? [y/n]`. y: that lead's id is marked for the session, and the request is
sent again with every picture as `[Image #N left out: <lead> refused pictures]`; later requests to
a marked lead do the same; one line `Pictures are left out for <lead> from now on.` n: nothing
changes and the turn ends as it does after any failure. Other statuses, network errors and aborts
ask nothing. The conversation is never changed (design).

**Tests:** 400 with pictures asks; y resends with notes and marks; a later turn to that lead sends
notes, to another lead sends pictures; n ends the turn; 400 without pictures, 429, 500 and a
network error ask nothing; the queue and a subagent's waiting answer are untouched.

Commit: `feat: a request with pictures refused as invalid asks before sending again without them`.

## Task 19: Vim mode: NORMAL, motions and operators

**Files:** create `src/tui/vim.ts`, `tests/tui/vim.test.ts`.

```ts
export type VimMode = "INSERT" | "NORMAL" | "VISUAL" | "VISUAL LINE";
// As built through Task 20: the last change for `.` (its keys, its count apart, what its INSERT typed, a VISUAL change's
// size and put), the register with its pictures' spans (Task 14), VISUAL's anchor, and INSERT's capture and remap wait.
export type Change = { keys: string[]; count: string; typed?: string; selected?: { line: boolean; size: number }; put?: Register };
export interface Vim { mode: VimMode; pending: string; count: string; lastFind?: { op: "f" | "F" | "t" | "T"; ch: string };
  lastChange?: Change; register: { text: string; linewise: boolean; spans: readonly Span[] }; anchor?: number;
  entered?: { head: string; tail: string; plain?: true }; remap?: { ch: string; at: number; before: Editor; text: string; cursor: number };
  goal?: { column: number; cursor: number; text: string } }
export const start: Vim;   // INSERT
export type Remaps = { pairs: Readonly<Record<string, "<Esc>">>; now: number };   // vimInsertModeRemaps, the key's time in ms
// One key (a grapheme, or a named key: "escape", "enter", "backspace", "left"...). Returns the new state and editor, and an
// action for App when the key means one ("submit", "history:previous", "history:next", "history:search", "help").
export function press(v: Vim, e: Editor, key: string, remaps?: Remaps): { v: Vim; e: Editor; act?: string };
```

This task: mode switching (`i I a A o O`, Esc), navigation (`h j k l Space w e b 0 $ ^ gg G f F
t T ; , %`), editing (`x r dd D dw de db df dt dj dk dgg dG d0 c0 y0 d% c% y% cc C cw ce cb s S yy Y
yw ye yb p P >> << J u`), counts on motions and operators (`3w`, `2dd`, `d3w`), Enter giving
`submit`, `j`/`k` at the first or last line giving the history actions, `/` giving
`history:search` and `?` giving `help` in NORMAL. Every change is one undo step through
editor.ts's `change()`.

**Tests:** one per row of Claude Code's "Mode switching", "Navigation" and "Editing (NORMAL mode)"
tables (design's source, read 2026-10-28), each from a known text and cursor (the `at("te|xt")`
helper of editor.test.ts) to the expected text, cursor and mode; counts; history at the edges.

Commit: `feat: vim mode's NORMAL keys, motions, operators and counts`.

## Task 20: Vim mode: text objects, VISUAL, repeat and remaps

**Files:** modify `src/tui/vim.ts`; tests in `tests/tui/vim.test.ts`.

Text objects (`iw aw iW aW i" a" i' a' i( a( i[ a[ i{ a{`) with `d`, `c`, `y` and in VISUAL; `v`
and `V`, motions extending, `d x y c s p r ~ u U > < J o`, `v`/`V` switching or leaving; `.`
repeating the last change (with its count, in INSERT the typed text too); `vimInsertModeRemaps`: the first
character typed is inserted, the second within 1 s (`now` passed in) removes it and goes to NORMAL,
another key or a later second leaves both (design). Yank and put copy picture spans (Task 14).
Claude Code's own code also takes `` ` ``, `b`, `B`, `<`, `>`, `)`, `]` and `}` as text objects; they
are not built, as this plan lists the docs' set (found at Task 20's code review).

**Tests:** one per row of Claude Code's "Text objects" and "Visual mode" tables; `.` after `dw`,
`3x`, `ciwfoo<Esc>`; the remap with fake times on each side of 1 s; a yanked marker put twice
gives two spans of one id.

`press` puts the cursor on a character before every key outside INSERT, VISUAL included (Task 19);
if VISUAL's `$` selects up to the line's end, as in Vim, VISUAL skips that step (found at Task
19's code review).

**Before building, settle which pairs Task 7 accepts** (found at Task 7's code review): its
check (`settings.ts`, two code points outside Unicode's control group) keeps a letter with a
combining accent, which is one character on screen but two code points, a line separator, and
spaces. A remap pair is two keys typed in turn, so each code point must be a key a user can type
alone; the reviewer suggests letters, digits, punctuation and symbols only
(`^[\p{L}\p{N}\p{P}\p{S}]{2}$`, with the `u` flag). Whether a space may be one of the two is
a choice to put to the user.

Commit: `feat: vim mode's text objects, VISUAL modes, repeat and INSERT remaps`.

## Task 21: Vim mode in the session

**Files:** modify `src/tui/App.tsx`, `src/tui/keys.ts`; tests in `tests/tui/app.test.tsx`.

With `editorMode: "vim"`, keys a binding does not take go to `vim.press` instead of `commands()`,
after Task 6's exceptions (Esc in INSERT or VISUAL and a half-typed command's keys go to vim
first, so Esc there is never `chat:cancel`).
In INSERT only a typed character and Esc are vim's: `press` hands any other key back unchanged,
and App sends it to `commands()`. In NORMAL a lone Esc (no `v.pending`, no `v.count`) is App's
`chat:cancel` (`press`'s comment; found at Task 19's code review).
Typed text arriving in one read is split into graphemes, each one key, so a fast `dw` or `yy` is
two keys (design; mends "yy in one read"); a bracketed paste always inserts as text. Esc in INSERT
or VISUAL goes to NORMAL and is not `chat:cancel`; in NORMAL it is. The hint row shows `-- INSERT
--`, `-- NORMAL --`, `-- VISUAL --` or `-- VISUAL LINE --` whenever no other hint takes the row
(choice 15). The mode and cursor are kept when the detail view, a menu or the model list opens
and closes. `/vim` (choice 6) and the live
`editorMode` entry switch it; `/vim` changes this window only (choice 26).
A live edit of `vimInsertModeRemaps` applies from the next key and says its line, as `editorMode`
does (found at Task 9's spec review).
App passes `press` the remaps as `{ pairs, now }`: `pairs` the settings file's
`vimInsertModeRemaps`, `now` the key's time in ms. `press` hands INSERT's other keys back with the
editor unchanged but `v.remap` dropped, so App keeps the `v` it returns; a key App handles without
`press` drops `v.remap` too, as Claude Code clears it on every key (its `cancelPendingRemap`; found
at Task 20's spec review).
When App puts new text in the prompt (a message sent, a history recall, the editor's text back), it
drops `v.entered`, so `.` takes what is typed next from its first character (found at Task 20's
spec review).
Claude Code leaves VISUAL on any Ctrl or Meta key, which then does its own action; this task settles
what Tachikoma does (found at Task 20's spec review; settled in choice 27, with the task's other
calls: bound keys act; editing keys do not, as Claude Code's text field skips them). The prompt
draws VISUAL's selection in reverse colours (choice 28, the user's answer).

**Tests:** `/vim` on and off with the line, in this window only; `dw` written in one read deletes a
word; a paste in NORMAL inserts; Esc in INSERT during a turn goes to NORMAL and the turn goes on;
Esc in NORMAL during a turn stops it; Enter in NORMAL sends; `/` in NORMAL opens Ctrl+R's search;
the mode kept across Ctrl+O; the live setting switching it; `d` then Ctrl+T toggles the to-do
list and leaves `d` pending, `d` then `w` deletes a word even with `w` bound in Chat; Esc with
`chat:cancel` rebound to Ctrl+Q still goes to NORMAL; with `"jj": "<Esc>"` set, `jj` typed within
1 s on a fake clock goes to NORMAL leaving neither `j`.

Commit: `feat: vim mode at the prompt, switched by /vim and the settings file`.

## Task 22: OpenAI API context windows

**Files:** create `src/providers/windows.ts`, `tests/providers/windows.test.ts`; modify
`src/providers/openai.ts`.

```ts
// Read 2026-10-28 from developers.openai.com/api/docs/models/<model> (release 6 design, "OpenAI API context windows").
export const OPENAI_WINDOWS: Record<string, number>;
export function openaiWindow(model: string): number | null;   // a dated snapshot, -YYYY-MM-DD, finds its model's row
```

`OpenAIProvider.contextWindow()` answers from it only for the `openai` preset with no
`OPENAI_BASE_URL` set (or set to `https://api.openai.com/v1`, with or without the trailing slash);
`openrouter`, `kimi`, `ollama` and another address answer null, as today. **Before writing the
table, the builder checks each row against its model page again** and notes the date in the
comment; a page that differs from the design's table stops the task for the controller.

**Tests:** each row; a dated snapshot; an unknown model null; another base URL null; the status
line's bar for an `openai:gpt-5.5` lead after a usage event.

Commit: `feat: the context bar for OpenAI API leads, from a dated table of OpenAI's model pages`.

## Task 23: Documents and the terminal checklist

**Files:** modify `README.md`, `docs/plans/2026-10-28-tachikoma-release-6-design.md`.

README: a "Settings" section (the file, each entry, precedence, saving, live edits, `never` at
launch only, the files out of the tools' reach), "Keys" (the file, contexts, the default table as
`?` shows it, chords, problems), the editor, stash, pictures (keys, paths, limits, the 400
question, history keeping only words), vim mode (on, the hint, Esc), the OpenAI table's date;
known limits (pictures not in prompt history; Ctrl+V eaten by Windows Terminal; `never` from the
file means every plain `tachi` starts unchecked; a `%` in a Windows path given to the editor would
be expanded by cmd, found at Task 12's build); the release list's release 5 "(done)" and 6
"(this release)". The design gains "As built" for every change from it. cli.tsx's `--help` text
still names Esc, Ctrl-C and Ctrl+T as fixed keys: say they can be rebound in the keys file (found
at Task 6's spec review).

**The terminal checklist** (the user runs it once, in Windows Terminal, PowerShell):
1. `tachi` with only `"lead"` in `~/.tachikoma/settings.json` starts; `/settings`, change
   `"status"` in Notepad, save: the status line changes.
2. `/lead`, quit, `tachi`: the file's lead again, as `/lead` changes this window only (choice 26).
3. `/keybindings`, bind `ctrl+e` to `chat:externalEditor`: Ctrl+E opens Notepad; `?` shows it.
4. Ctrl+G on a two-line prompt, with another Notepad window already open (Windows 11's tabbed
   Notepad may hand the file to the open window and exit at once; found at Task 12's code review):
   Notepad opens, edit, close: the prompt has the edit. Then with
   `"editor": "\"C:\\Program Files\\Git\\usr\\bin\\vim.exe\""` (Git for Windows' vim,
   if installed): vim takes every key, `:wq` brings the edit back, and the keyboard works after.
5. Ctrl+S, type, Ctrl+S: swap; Ctrl+S on empty: back.
6. Win+Shift+S, Alt+V, "what is in this picture?" to an Anthropic lead: it answers about it.
7. PrtScn over both monitors, Alt+V, send: the answer comes (shrunk or not, no error).
8. Drag a .png from Explorer into the prompt: a marker.
9. `/vim`: `-- INSERT --`; Esc, `dw`, `u`, `ciw`, `.`; `jj` with the remap set.
10. An `openai:gpt-5.5` lead (if the user has an API key): the context bar shows.
11. During a turn, Ctrl+G with Notepad open: Ctrl-C typed in the terminal meanwhile, and what it
    does to the running turn (found at Task 12's spec review; Git behaves the same way).

Commit: `docs: release 6 in the README, the design's as built, and the terminal checklist`.
