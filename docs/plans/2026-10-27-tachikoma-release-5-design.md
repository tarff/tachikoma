# Tachikoma release 5: full screen, design (2026-10-27)

Release 5 of Tachikoma. The overall design, the Decisions table and the release order are in
[2026-10-22-tachikoma-design.md](2026-10-22-tachikoma-design.md).

Release 5 draws Tachikoma on the terminal's second screen, as `vim` and Claude Code do, with its
own scrolling, a scroll bar, mouse selection and copying, and a view that Ctrl+O and `/tasks t3`
open in place. Quitting puts the terminal back as it was. The user asked on 2026-10-26 for launch
and quit to "repaint the whole terminal like Claude Code and Codex", and then: "No I want to be
able to scroll back through the session history. Find out how Claude code does it."

Release 5 was to hold the key extras too. On 2026-10-26 the user chose to split it (option chosen:
"Split: full screen first"): full screen is release 5, and vim mode, image paste, an external
editor, stash and rebinding keys in a file are release 6. Every later release moves down one, to
14 in all. Each part below was chosen by the user on 2026-10-26 or 2026-10-27, from options offered.
An outside review of this design (2026-10-27) added four rules: a question brings its detail into
view, the newest copy wins, the input filter's rules for pastes and Escape, and who owns the
terminal while `[` has printed the view out. A review of the build plan the same day sharpened two
of them (a question keeps to its own detail; an older clipboard run is followed by the newest OSC 52
again) and added the drive's colon to words.

Sources:
- **Claude Code's full screen:** code.claude.com/docs/en/fullscreen.md, read on 2026-10-26 and
  2026-10-27, for Claude Code 2.1.310. It switches with `/tui fullscreen` and `/tui default`;
  PgUp/PgDn scroll half a screen, Ctrl+Home goes to the top, Ctrl+End to the latest message and
  turns following back on; `CLAUDE_CODE_SCROLL_SPEED` multiplies the wheel's distance ("a value of
  `3` matches the default in `vim`", any positive value up to 20, fractions included); a drag
  selects and copies on release; double-click selects a word, "matching iTerm2's word boundaries so
  a file path selects as one unit", a URL whole, and triple-click the line; Ctrl+O's transcript
  view has `/` search, n/N, j/k, g/G and `[`, which "writes the full conversation into your
  terminal's native scrollback". Locally it copies with the system's tool (`Set-Clipboard` on
  Windows, `pbcopy`, `wl-copy`, `xclip` or `xsel`) and over SSH with OSC 52. It warns that
  "Windows Terminal and other ConPTY-backed hosts" can leave fragments of earlier output on screen.
- **What Claude Code leaves at quit:** the user, 2026-10-26: it "just give you a resume command and
  returns to the terminal with whatever was in it before you opened it".
- **Double-click time:** Microsoft's `SetDoubleClickTime` reference, read on 2026-10-27: "the
  system uses the default double-click time of 500 milliseconds".
- **Word characters:** iTerm2's `sources/Settings/iTermPreferences.m`, line 743 at commit ad80b19
  (read on 2026-10-27): the default for "WordCharacters" is `/-+\~_.`, beside letters and digits.
- **Ink 7.1.1** (`node_modules/ink/build`): the second screen is a render option, set only at the
  start (`alternateScreen`); its input parser reads a mouse report as one unknown key, so Ink has
  no mouse support; `suspendTerminal()` hands the terminal to something else and redraws after.

## The probe

Run by the user on 2026-10-27 in Windows Terminal (opened as CMD.exe, which ran in a Windows
Terminal tab; `WT_SESSION` was not set, so Tachikoma cannot rely on it to know the terminal), Node
24.22.1, 120 by 30. The script (`fsprobe.mjs`) and its results were kept outside the repository,
as earlier probes were.

- **Wheel:** one report a notch, `ESC[<64;x;yM` up and `ESC[<65;x;yM` down.
- **Drag:** a press (`ESC[<0;x;yM`), a report for each cell moved with the button held
  (`ESC[<32;x;yM`), and a release (`ESC[<0;x;ym`), with 1-based columns and rows that matched the
  screen. All four drags tried arrived whole. The terminal drew nothing while the program had the
  mouse ("dragging a to b didnt look like it did anything"), so Tachikoma must draw its own.
- **Right-click** reached the program (`ESC[<2;x;yM`, then `m`); the terminal did not paste.
- **Shift+drag** sent nothing and Windows Terminal highlighted the text itself.
- **Keys:** PgUp, PgDn, Ctrl+Home, Ctrl+End, Shift+PgUp/PgDn, Ctrl+PgUp/PgDn and Shift+Up/Down all
  arrived (`ESC[5~`, `ESC[6~`, `ESC[1;5H`, `ESC[1;5F`, ...). Ctrl+Shift+Home and Ctrl+Shift+End
  did not: Windows Terminal keeps them.
- **Copying:** OSC 52 put plain and non-English text (`tachikoma é 日本語 🦀 probe`) on the
  clipboard; so did PowerShell's `Set-Clipboard`, in 455 and 460 ms.
- **Wheel setting:** Windows' "lines to scroll per notch" is 3 on this machine.

## The two modes

**Full screen is the default.** At launch Tachikoma moves to the terminal's second screen; the
shell's content waits underneath. At quit it moves back and prints nothing, so the terminal looks as
it did before. Claude Code's `--resume` line comes with transcripts on disk (release 8).

**Classic mode** is release 4's screen: finished lines go into the terminal's own scrollback. It is
chosen with `--classic` or `TACHI_CLASSIC=1`.

**`/screen` switches mode during a session.** From full screen to classic it prints the whole
conversation into the normal scrollback, so nothing is lost; from classic to full screen it opens
the view with everything so far. Both modes keep every line.

**No automatic fallback** to classic after a failed start, as Claude Code has: what counts as a
failure is not well defined, and `--classic` covers it. `-p` runs have no screen and do not change.

**Switching during a session** cannot use Ink's option, which is set only at the start: Tachikoma
writes the switch itself and has Ink draw everything again. The build tried this first (see
"Building it"). Ink's suspend and resume turn raw mode off and on again within about 15 ms, which
left the console reading whole lines after a few switches; so raw mode is held on through every
switch and through `[`, and Ink's "off" is not passed on then.

**While a switch runs** (Task 14's reviews): going to classic, the mode is classic from the start,
so a key read meanwhile acts as in classic mode. A switch holds the queue as a turn does, and Esc
and Ctrl-C act as during a turn; a queued `/screen` waits while the detail view is printed out.

## The screen

The conversation fills the top of the screen, every row the rest does not need. Under it is release
4's live area, unchanged: the working line, the to-do list, the queue, the prompt, menus, the
subagent panel, the hint, the status line and the tool line. When the live area grows (a long
prompt, an open menu) the conversation gets shorter, not pushed off the screen.

**Every line is kept,** as the lines Tachikoma already makes (text, colour, one row or wrapped),
and only the rows on screen are drawn. A resize wraps every line again to the new width, which
classic mode cannot do for old scrollback; the line at the top of the view stays at the top, or the
view stays at the bottom if it was following.

**No limit on the lines kept** (the user's choice, 2026-10-27, from the figures below). Claude Code
caps its own. Measured with release 5's `Rows` (build Task 4, 2026-10-27: i9-12900K, Node 24.22.1,
default heap limit 4,288 MB; medians of 3 to 7 runs; lines added at width 119, resized to 79, one
screen of 40 rows drawn with Ink's `renderToString`; the script `measure5.mts` in the session's
scratchpad). Plain prose is 1 to 300 ASCII characters a line; "em dash" is the same with one `—` in
every line, the slow path for text outside ASCII; the two bound real prose.

| Kept lines | Memory | A resize | Drawing one screen |
|---|---|---|---|
| 10,000 plain prose | 3.5 MB | 0.02 s | 4.6 ms |
| 10,000 with an em dash | 5.6 MB | 0.17 s | 5.0 ms |
| 100,000 plain prose | 35 MB | 0.24 s | 4.5 ms |
| 100,000 with an em dash | 50 MB | 1.6 s | 4.4 ms |
| 1,000,000 plain prose | 353 MB | 2.5 s | 7.1 ms |
| 1,000,000 with an em dash | 495 MB | 16 s | 5.2 ms |
| 1,000,000 tool lines | 110 MB | 0.02 s | 4.6 ms |
| 1,000,000 lines of 2,000-line file details | 204 MB | 1.8 s | 3.9 ms |

Memory stays far inside Node's limit, and drawing does not grow with the session. What grows is a
resize, which wraps every line again at once; the screen does not answer while it runs, past a
second from about 100,000 lines of prose outside ASCII. Each line costs about 80 to 220 bytes
beside its text.

**Tabs** are drawn as spaces to the next multiple of 8 columns, counted from the start of each
row (Ink's wrapping counts from the line's start, so a wrapped line's later rows can differ from
classic mode); copying keeps the tabs (the user's choice, 2026-10-27).

## Scrolling

- **Wheel:** `--scroll-speed` lines a notch, or `TACHI_SCROLL_SPEED`; 3 by default (the probe's
  Windows setting, and Claude Code's note that 3 matches `vim`); any positive value up to 20,
  fractions included, as Claude Code allows. Fractions add up across notches: 0.5 scrolls one line
  every second notch.
- **PgUp / PgDn:** half a screen. **Ctrl+Home:** the top. **Ctrl+End:** the latest line, and the
  view follows new output again.
- **Shift+Up / Shift+Down:** one line, a selection or not. (They were to extend a selection too, as
  in Claude Code; the user dropped that at Task 9's review, 2026-10-27, as an old selection would
  be copied again over newer clipboard contents.)
- **Up and Down stay with the prompt** (history, menus), as in release 3.
- **The scroll bar:** one column at the right of the conversation, once it is longer than the view.
  The thumb's size and place show how much is seen and where. Clicking the track jumps there;
  dragging the thumb scrolls. Text wraps one column short so the bar covers nothing, and a selection
  leaves it out. (Claude Code puts bars on long lists, not on the conversation: the user asked for
  one here.)
- **Following:** at the bottom, the view follows new lines. Scrolled up, it stays where it was put,
  and a grey row at its foot says how many lines came in since ("↓ 12 new lines · Ctrl+End"),
  counting only those still below the view (found at Task 11's review, where a reply shown on
  screen was counted as new).
  Coming back to the bottom, by wheel or key, follows again. Sending a prompt goes to the bottom,
  and so does anything the user asks to be shown (`?`, Shift+Tab's "mode is now", Ctrl+O until
  the detail view): the user's choice, 2026-10-27, at Task 5's review, where a key list printed
  out of sight looked like a broken key.
- **The scroll keys work during Ctrl+R's search** too, scrolling the conversation behind it and
  leaving the search as it was (the user's choice, 2026-10-27, at Task 5's review).
  A view that is put somewhere stays there even when the conversation grows taller or wider (a
  turn ending, a resize): blank rows show below the last line rather than the view moving (the
  user's choice, 2026-10-27; a question's detail needs it, below).
- **A permission question brings its detail into view.** A write's detail (the file's proposed
  text) goes into the conversation under a heading, as in release 1. When the question comes, the
  view moves to that question's own detail and stops following, so lines arriving while it waits
  (another subagent's question and its detail, a reply) do not move it: a detail that fits goes at
  the foot of the view, above the row kept for "new lines"; a taller one has its heading at the
  top. Once answered, the view follows again if it was following before, even when the user
  scrolled while it waited, as reading a long file means scrolling it; a resize while it waits
  leaves the view where it is (the user's choices at Task 11's review). While the question waits,
  the wheel, the scroll keys and the scroll bar still scroll, so a long file can be read before
  answering; y, n, Esc and Ctrl-C answer it as in release 3.
- **A question too long to fit** (a shell command of thousands of characters, which would push the
  frame past the screen and lose its first rows) puts its whole text into the conversation under a
  grey heading that counts its characters, which the rule above brings into view, and asks in one
  short line naming its asker by task id: `Allow t2 to run (shown above)? [y/n] · Esc to decline`.
  A write whose preview already shows its path gets no second copy: the short line points at the
  preview. It is too long when its rows would leave the conversation less than one row, checked at
  each drawing, so a resize that stops it fitting moves it then; once moved it stays. One that fits
  is asked as before, and nothing of it is ever cut (the user's choices at Task 11's review).

## The mouse

**On and off.** Entering full screen asks the terminal for mouse reports (presses, drags, releases
and the wheel, in the probe's format). They are turned off at quit, when `/screen` goes to classic,
and when Tachikoma exits on an error or a signal, so the terminal is not left catching the mouse.

**Reading it.** Ink would take a mouse report for an unknown key, so Ink gets a filtered copy of the
input, with these rules:
- **A mouse report** (`ESC[<`, three numbers, then `M` or `m`) is taken out and handled by
  Tachikoma.
- **Inside a paste** (between `ESC[200~` and `ESC[201~`, the markers Ink reads pastes by) nothing is
  taken out, so pasted text that looks like a mouse report arrives as text. A marker split across
  two reads is still found.
- **A read that stops partway** through what could be a mouse report (`ESC`, `ESC[`, `ESC[<0;12`)
  is held until the rest comes, for at most 20 ms, Ink's own wait for the rest of a key
  (`pendingInputFlushDelayMilliseconds` in Ink's `components/App.js`); then it goes to Ink as it
  was. So a lone Escape reaches Ink at most 20 ms later than now, and Ink then waits its own 20 ms:
  40 ms at worst, against 20 ms now.
- **Everything else** goes to Ink unchanged and in order.

**Selecting:**
- Press the left button in the conversation and drag: the selection shows in reverse colours as it
  grows. Dragging past the top or bottom of the view scrolls it a line for each move, so a selection
  can be longer than the screen; the wheel scrolls during one too. The pointer cannot go above the
  frame, so the view's top row stands for past the top, for a drag started lower down; a drag
  started on the top row selects within it and never scrolls (the user's choice, 2026-10-27).
- The selection belongs to the lines, not the screen rows, so it stays on its text as the view
  moves.
- **Double-click** selects a word: letters, digits and iTerm2's `/-+\~_.`, so a path is one word,
  and a drive's colon (`C:\`, `C:/`), so a Windows path is too; a URL (`http://` or `https://` to
  the next space, less the punctuation after it, as most terminals leave it off: the user's choice,
  2026-10-27) is selected whole, and a character it leaves off alone (the user's choice,
  2026-10-27). **Triple-click** selects the line. Clicks count as a double or
  triple when each lands on the same cell within 500 ms of the last (Windows' default).
- A click without a drag clears the selection; it stays until a click, and keys never clear it (the
  user's choice, 2026-10-27): any press clears it, on the prompt or the status line too, but one on
  the scroll bar, which scrolls as the wheel does. Only the conversation and the detail view can be
  selected, not the prompt or the status line.
- The "↓ N new lines" row is not text while it shows (found at Task 9's review, where a drag along
  it copied a line hidden under it): a press there starts no selection, and a drag onto it counts
  as the row above it, without scrolling.

**Copying,** when the button is let go:
- A line wrapped over several rows copies as one line; lines are joined by line breaks, and the
  copy is exactly the text selected, spaces and all (the user's choice, 2026-10-27).
- Tachikoma sends OSC 52 and also runs the system's tool in the background: `Set-Clipboard` on
  Windows, `pbcopy` on macOS, `wl-copy` or `xclip` on Linux. It cannot tell whether a terminal
  took the OSC 52, and the probe found both work here. Linux with no display (over SSH), or a
  system with no tool at all, has no tool to run: OSC 52 alone copies, and the hint row says
  "Copied 312 characters with the terminal only" (the user's choice, 2026-10-27).
- **The newest copy wins.** OSC 52 is written at once, so the terminal gets copies in order. The
  system's tool runs one copy at a time: a copy made while one is running waits, and when it
  finishes only the newest waiting copy runs. An older run that ends after a newer copy was made
  has just put the older text on the clipboard, so the newest copy's OSC 52 is sent again at once,
  before its own run. A failure is reported only for the newest copy.
- The hint row says "Copied 312 characters" until the next key, paste or click; the conversation
  does not get a line for it. It takes the hint row's place only while one shows, never adding a
  row, so a copy never moves the conversation, and a copy whose line cannot show when it is made
  drops it; Ctrl+R's search and the exit warning keep the row. A failed
  copy is always shown, even adding the row; one that comes while the search or the warning holds
  the row waits, shows when they go, and only then goes on the next key or click (the user's
  choices, 2026-10-27).
- **Shift+drag** still gives the terminal's own selection, as the probe found.

**Clicking:**
- **In the prompt:** the cursor moves to the character clicked; past the end of a row, to the row's
  end. On a row that wraps onto the next, that is before its last character, as Up and Down put it,
  since the place after it is the next row's start (the user's choice at Task 10's review).
- **On a menu entry:** as choosing it and pressing Enter: a `/` command runs, an `@` path fills in,
  a model in `/model` is picked.

## The detail view

**Ctrl+O** shows the last turn's tool calls in full (the text it prints in release 3), and
**`/tasks t3`** that subagent's full record. The view takes the conversation's place and the prompt
is hidden while it is open; the status line stays, and a grey row at the bottom names the keys.

- Everything from the conversation works: the wheel, the scroll bar, PgUp/PgDn, Ctrl+Home/End,
  Shift+Up/Down, selecting and copying.
- **j/k or Up/Down:** one line. **g/G or Home/End:** the top or the bottom.
- **`/` searches:** typing finds and highlights matches, Enter keeps the search, Esc drops it and
  goes back to where the view was; **n/N** go to the next or previous match. Any case, as Ctrl+R's
  history search; plain text, not a pattern.
- **`[`** prints the view into the normal scrollback, for the terminal's own search, selection and
  scrolling. While the view is printed out:
  - **Going out:** Tachikoma turns mouse reports off, suspends Ink (`suspendTerminal()`: Ink stops
    drawing and stops reading keys, and asks for raw mode off, which is not passed on: see
    "Switching during a session"), leaves the second screen itself, since it entered it itself,
    and prints the view.
  - **Keys:** a small reader of Tachikoma's own takes them, still in raw mode: q, Esc or Ctrl-C
    come back, and other keys are ignored. Nothing reaches Ink.
  - **Coming back** undoes each step in reverse: the second screen, mouse reports, then Ink
    resumed, drawing everything again.
  - **Work goes on:** turns and subagents keep running and their lines are kept, but nothing is
    drawn until the view comes back.
  - **A permission question** brings it back at once, as q would, and the question shows as under
    "Scrolling".
  - **A paste does nothing** while the view is printed out, and a paste still arriving when the
    view comes back (for a question, or in the same read as the q) is dropped to its end, so a
    pasted y can never answer a question (the user's choices at Task 13's reviews, 2026-10-28).
  - **The queue:** messages and other commands queued during a turn still run while the view is
    printed out, `/exit` included; a queued `/model` or `/tasks t3`, and everything queued behind
    it, waits until the view comes back, since either would open over it unseen (the user's
    choice at Task 13's review).
- **q, Esc or Ctrl+O** close the view. Ctrl-C stops a turn that is running, leaving the view open;
  with nothing running it only closes the view, so the prompt's hidden draft is never cleared
  unseen (the user's choice at Task 12's review). The working line still says "Esc to stop".
- **While a search is typed,** a row with no match says so (`/zzz (no match)`, as Ctrl+R's does),
  and a paste goes into the query up to its first line break; outside a search a paste does
  nothing in the view (the user's choices at Task 12's review).
- **During a turn** the work goes on, and new output goes into the conversation underneath. A
  permission question closes the view: it needs y and n, and n is "next match" here. Ctrl+O opens
  it again.

In classic mode, Ctrl+O and `/tasks t3` print below, as in releases 3 and 4.

## The status line's colours

Added on 2026-10-27 at the user's request ("can we add some colour and stuff to the status line
like claude-hud so it isnt so boring?"), from a preview of two versions run in the user's own
terminal (`statuspreview.mjs` in the session's scratchpad; option chosen: "A", claude-hud's style,
over coloured blocks). The user put it in release 5 as the build's last task (Task 16), over
release 6; it does not touch full screen.

The inverse band goes: the line is drawn on the terminal's own background, its parts split by a
grey ` | `. What each part says, their order, `--status` and the cut at the screen's edge stay as in
release 4, but for one change of words: `ctx` goes where the bar shows, the bar saying what the
part is, as in claude-hud (the user, 2026-10-27: "it looks better without it"). The colours are
claude-hud 0.0.4's (`src/render/session-line.ts`, `agents-line.ts` and `colors.ts`) where it has
the part, and by risk where it does not (cost, mode, errors):

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

## When something goes wrong

- **Putting the terminal back:** every way out (`/exit`, a double Ctrl-C or Ctrl-D, a crash, a
  signal from outside) turns the mouse reports off, leaves the second screen and shows the cursor.
  A hard kill (Task Manager, closing the tab) cannot be caught; if one leaves a terminal catching
  the mouse, closing that tab clears it. The README says so.
- **The system's clipboard tool is missing or fails:** the hint row says so ("Copied with the
  terminal only; xclip not found"); the OSC 52 was still sent. Where there is no tool to run at all
  (Linux with no display, or another system), nothing is reported as a failure: the hint says
  "with the terminal only".
- **The terminal is too small** for the live area: the conversation keeps at least one row, as the
  prompt does in release 3; what does not fit is dropped from the live area in release 3's order.
  Found at Task 5's review: at 6 rows or fewer the frame can still reach the terminal's height
  (busy, with the `/` menu open: the menu's and the prompt's least rows and the conversation's
  row come to more than there is). Classic mode does the same one row lower, from release 3.

## Building it

1. **First, a check:** switching screens in the middle of a session, with Ink drawing everything
   again cleanly, on the stand-in terminal and in the user's. If it cannot be made to work, the user
   is asked before anything is built on it. **Done 2026-10-27** in the user's Windows Terminal (Node
   24.22.1, 120 by 30), with a probe kept outside the repository: each switch took about 30 ms,
   going to classic printed every line, and no frame cleared the terminal. Two flashes went once
   React committed before Ink resumed and nothing was drawn before leaving full screen. The
   keyboard stopped after the third switch until raw mode was held on through switches; then eleven
   switches kept it. The user's answers: full screen clean, no flicker, classic printed and tidy,
   the terminal as before after quitting.
2. **Then a measurement:** memory and drawing time at growing session lengths, to settle whether
   the kept lines need a cap. The figures go into this design.
3. **Then the rest,** each task's tests seen failing before its code, as in releases 2 to 4.

## Testing

As before: Vitest, no test contacting a real provider, no test reading the user's own files.

- **Mouse reports:** each kind from the probe; a report split across two reads; reports taken out
  while keys and pastes reach Ink unchanged; a paste holding text shaped like a mouse report
  arriving whole, with its markers split across reads; a lone Escape reaching Ink within 20 ms; a
  held partial report going to Ink as it was after 20 ms.
- **The view:** wrapping, rewrapping on a resize, drawing only the rows on screen, following and the
  "new lines" row, each scroll key, fractional scroll speeds, and the scroll bar's size, place,
  clicks and drags.
- **Selecting:** a drag to text (wrapped lines joined, spaces kept), a drag past the
  edge scrolling, word and line selection (paths and URLs whole), the click timing, and both copy
  routes with stand-ins for the terminal and the clipboard tool; overlapping copies with a slow
  stand-in tool, the newest always ending on the clipboard and only its failure reported.
- **Questions:** a write's detail brought into view when scrolled up (taller and shorter than the
  view), and the wheel, the keys and the scroll bar scrolling while the question waits.
- **Clicking** in the prompt and on menu entries.
- **The detail view:** opening, keys, search (any case, n/N, Esc going back), and a permission
  question closing it; `[` going out and coming back in order, keys during it reaching only its
  reader, work going on, and a question bringing it back.
- **Modes:** `--classic`, `TACHI_CLASSIC`, `/screen` both ways, and the terminal put back on each
  way out.
- **The App tests** use release 3's stand-in terminal with a height, with mouse reports fed through
  the filtered input.
- **Then the user's terminal checklist:** launch and quit putting the screen back; the wheel, the
  keys and the scroll bar; following and the "new lines" row; drag, double-click and triple-click
  copying, pasted elsewhere to check; clicking in the prompt and on menus; Ctrl+O's search and `[`;
  `/screen` both ways; resizing; and no fragments of old text left on screen.

## As built

Where the code differs from the design above, or settles what it left open, and why. The plan
(`2026-10-27-tachikoma-release-5.md`) lists the 19 choices it made, each marked in its task; the
user approved them when the build started (2026-10-27) and dropped one at Task 9's review. Most of
what the reviews found, the user's choices at Tasks 5, 9 and 11 among them, is already written into
the sections above, each marked with its review; the rest follows, task by task. "The user's
choice" marks what the user chose; "the build's call" marks what the build decided and told the
user. Unmarked items are fixes from the reviews that keep to the design.

- **The filtered keyboard (Task 2).** A mouse report the screen does not use (one with a bit the
  format does not name, or a wheel report with other bits set) is still taken out and dropped,
  never typed into the prompt. The filter behaves as a stream for Ink, so Ink's check for the kitty
  keyboard protocol, and keys typed before Ink starts reading, both reach it. If Ink turns raw mode
  off while the filter holds it on (Ink ending meanwhile), that is passed on when the hold ends, so
  the terminal is not left in raw mode and Tachikoma can exit.
- **The conversation's rows (Tasks 3 and 4).** A view held past the bottom keeps the scroll bar's
  thumb on the bar. Kept lines have no cap (the user's choice, from the figures under "The
  screen").
- **The key list (Task 5).** `?` lists the scroll keys in a row of their own.
- **Starting and putting the terminal back (Tasks 1 and 6):**
  - Classic mode is also used when the output is not a terminal, or under CI (`CI` or
    `CONTINUOUS_INTEGRATION` set to anything but `0` or `false`), where Ink skips its own second
    screen (the user's choice at Task 6's build).
  - The terminal goes back as soon as Ink ends, not at Node's exit. When Ink ends on an error in
    its drawing, the error is said again on stderr in full screen, where leaving the second screen
    took it away. Tachikoma then exits with 1, where release 4 exited with 0 (the user's choice at
    Task 6's review).
  - Ctrl+Break on Windows and SIGQUIT elsewhere put the terminal back too (the user's choice at
    Task 6's review): Windows sends Ctrl+Break as a signal even in raw mode, and the library Ink
    uses to catch exits does not put the terminal back for either.
  - Closing the terminal's window or tab reaches Node as SIGHUP, which is caught and puts the
    terminal back, so of the hard kills under "When something goes wrong" only ones such as Task
    Manager's remain (found at Task 15's review).
  - A crash is still reported when Ink's own unmount fails as well, and the writes that put the
    terminal back never throw, so a closed pipe cannot turn an exit into a crash.
- **The wheel and the scroll bar (Task 7).** `-p` ignores `TACHI_SCROLL_SPEED`, as it ignores
  `TACHI_CLASSIC`, but a bad `--scroll-speed`, typed on the command line, still stops it (the
  user's choice at the review). A click on the track near either end grabs the thumb where the
  pointer is, so a drag can go on from it.
- **Selecting and copying (Tasks 8 and 9):**
  - On Windows the text reaches `Set-Clipboard` through PowerShell's input, base64-encoded
    (choice 8). PowerShell is named by its full path, and a failure comes back as one readable
    line, its message alone, where PowerShell's own report is cut at the console's width.
  - Tachikoma does not wait for the process `xclip` and `wl-copy` leave holding the clipboard, or
    it would keep running until another program took the clipboard.
  - A selection that stops partway along a line keeps the spaces up to that point.
  - Shift+Up and Shift+Down only scroll: choice 9, moving a selection's end and copying it again,
    was dropped by the user at Task 9's review.
- **Clicking (Task 10).** A click that comes in the same read as a key that changed the screen (a
  key that changed the prompt or the menu's choice, or Alt+P) is dropped, as the screen it was
  aimed at is gone. A click during Ctrl+R's search does nothing (choice 10), including one read
  with the key that ends it. The model list picks the model clicked, and nothing once it has
  closed or picked.
- **The detail view (Task 12):**
  - The user's choices at the review: Ctrl-C with nothing running only closes the view, keeping the
    hidden prompt's text and starting no count toward quitting; while a turn runs it stops the
    turn and leaves the view open. A search with no match says `/zzz (no match)`. A paste while a
    search is typed goes into the query up to its first line break; outside a search a paste does
    nothing.
  - The build's calls: n and N go on from the last match shown; the key row stands in the hint
    row's place, in its dim style; Ctrl+R's search still ignores pastes, as before.
  - Enter on a search with no match drops the search, where the design says Enter keeps it (the
    build's call, told to the user): a kept search with no match would leave n and N nothing to go
    to.
  - The drawing is given only the matches on the rows it draws, as passing every match slowed
    each redraw on a long record. The key row fits a short terminal.
- **`[` (Task 13):**
  - The user's choices at the reviews (2026-10-28): a paste does nothing while the view is printed
    out, and one still arriving when the view comes back is dropped to its end. A queued `/model`
    or `/tasks t3`, and everything queued behind it, waits until the view comes back; a queued
    `/exit` still runs.
  - The build's call: an error that ends Ink while the view is printed out is said on stderr, as
    Ink draws nothing then.
  - Nothing queued starts once Ink has ended.
  - A paste's start marker split across two reads is recognised only within the filter's 20 ms
    wait, as in Ink; terminals send the marker with the text (a limit accepted at the review).
- **`/screen` (Task 14):**
  - The user's choice: going to classic, the mode is classic from the switch's start, so a key read
    meanwhile (Ctrl+O, a scroll key) acts as in classic mode.
  - The build's calls: a switch holds the queue as a turn does, and Esc and Ctrl-C during one act
    as during a turn; a queued `/screen` waits while the view is printed out, as `/model` and
    `/tasks t3` do.
  - Going back to full screen takes only the lines said in classic mode since the last switch. A
    question asked as a switch to full screen starts keeps its detail's place.
  - If Ink ends during a switch, nothing more is switched; if a step throws, the mode is put back
    to match the screen.
- **The status line's colours (Task 16).** The user's choices (2026-10-27): claude-hud's style,
  option "A" of the preview, and `72% left` without `ctx` where the bar shows. The build's calls:
  grey is drawn dim, as claude-hud draws it and as the bar's empty cells already were, not in the
  grey (`gray`) the conversation's own grey rows use; the spaces between words and the `/` between
  the token counts stay plain, as in the preview the user chose from. The plan's check that the
  pieces' words joined equal `formatSegment` was dropped: `pieces` is the only source of the words.
- **The user's terminal check (2026-10-28,** Windows Terminal, after Task 16): launching and
  quitting, every scroll key, the wheel and the scroll bar, following and the new-lines row,
  selecting and copying, Shift+drag, clicks, Ctrl+O's search and `[`, `/screen` both ways,
  resizing, the status line's colours, and no fragments left: all as designed. The one finding:
  the wheel felt jumpy beside Claude Code. A probe build tried Ink's frame cap and its drawing of
  only the lines that changed (`incrementalRendering`); at 60 frames a second the wheel felt as
  smooth as Claude Code's, with or without the second, so Ink now draws up to 60 frames a second,
  not its default 30 (the user's choice), and the whole frame as before.
- **The final review (2026-10-28).**
  - A `[` read with the Enter that sends `/screen` from classic, after a Ctrl+O, ended the
    session: Ink was already suspended for the switch. `[` now does nothing while a switch has Ink
    suspended.
  - Ink ending lets the keyboard go whatever held it, a switch too: a signal ends the process
    before the switch's own ending can. It also stops a running turn, which would otherwise go on
    paying with nothing on screen.
  - `/screen` stays in classic where full screen can't draw (the output is not a terminal, or CI),
    saying so in grey (the build's call on the message's words, told to the user).
  - The lead's id in the status line, and the clipboard tool's reason for failing in the hint row,
    are escaped, as everything else from outside is.

## Not in this release

- Vim mode, image paste, an external editor, stash and rebinding keys in a file: release 6.
- The context bar for OpenAI API leads, whose window OpenAI's API does not report: release 6, from
  a dated table of OpenAI's model pages (the user, 2026-10-27).
- The `--resume` line at quit: with transcripts on disk (release 8).
- Claude Code's `/scroll-speed` dialog, which saves to a settings file Tachikoma does not have, and
  its faster scrolling when the wheel spins quickly.
- Claude Code's `{`/`}` jumps between prompts, Space/b and Ctrl+E in the detail view.
- Going back to classic by itself after a failed start.
