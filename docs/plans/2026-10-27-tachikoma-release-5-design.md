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
writes the switch itself and has Ink draw everything again. The build tries this first (see
"Building it").

## The screen

The conversation fills the top of the screen, every row the rest does not need. Under it is release
4's live area, unchanged: the working line, the to-do list, the queue, the prompt, menus, the
subagent panel, the hint, the status line and the tool line. When the live area grows (a long
prompt, an open menu) the conversation gets shorter, not pushed off the screen.

**Every line is kept,** as the lines Tachikoma already makes (text, colour, one row or wrapped),
and only the rows on screen are drawn. A resize wraps every line again to the new width, which
classic mode cannot do for old scrollback; the line at the top of the view stays at the top, or the
view stays at the bottom if it was following.

**No limit on the lines kept,** for now. Claude Code caps its own; there are no figures yet for
where a cap would matter. The build measures memory and drawing time at growing session lengths
first, and a cap goes in only if the measurements call for one, with the figures recorded here.

## Scrolling

- **Wheel:** `--scroll-speed` lines a notch, or `TACHI_SCROLL_SPEED`; 3 by default (the probe's
  Windows setting, and Claude Code's note that 3 matches `vim`); any positive value up to 20,
  fractions included, as Claude Code allows. Fractions add up across notches: 0.5 scrolls one line
  every second notch.
- **PgUp / PgDn:** half a screen. **Ctrl+Home:** the top. **Ctrl+End:** the latest line, and the
  view follows new output again.
- **Shift+Up / Shift+Down:** one line; during a selection they also extend it, as in Claude Code.
- **Up and Down stay with the prompt** (history, menus), as in release 3.
- **The scroll bar:** one column at the right of the conversation, once it is longer than the view.
  The thumb's size and place show how much is seen and where. Clicking the track jumps there;
  dragging the thumb scrolls. Text wraps one column short so the bar covers nothing, and a selection
  leaves it out. (Claude Code puts bars on long lists, not on the conversation: the user asked for
  one here.)
- **Following:** at the bottom, the view follows new lines. Scrolled up, it stays where it was put,
  and a grey row at its foot says how many lines came in since ("↓ 12 new lines · Ctrl+End").
  Coming back to the bottom, by wheel or key, follows again. Sending a prompt goes to the bottom.

## The mouse

**On and off.** Entering full screen asks the terminal for mouse reports (presses, drags, releases
and the wheel, in the probe's format). They are turned off at quit, when `/screen` goes to classic,
and when Tachikoma exits on an error or a signal, so the terminal is not left catching the mouse.

**Reading it.** Ink would take a mouse report for an unknown key, so Ink gets a filtered copy of the
input: reports are taken out and handled by Tachikoma, everything else (pastes included) goes
through unchanged, and a report split across two reads waits until it is whole.

**Selecting:**
- Press the left button in the conversation and drag: the selection shows in reverse colours as it
  grows. Dragging past the top or bottom of the view scrolls it a line for each move, so a selection
  can be longer than the screen; the wheel scrolls during one too.
- The selection belongs to the lines, not the screen rows, so it stays on its text as the view
  moves.
- **Double-click** selects a word: letters, digits and iTerm2's `/-+\~_.`, so a path is one word; a
  URL (`http://` or `https://` to the next space) is selected whole. **Triple-click** selects the
  line. Clicks count as a double or triple when each lands on the same cell within 500 ms of the
  last (Windows' default).
- A click without a drag clears the selection. Only the conversation and the detail view can be
  selected, not the prompt or the status line.

**Copying,** when the button is let go:
- A line wrapped over several rows copies as one line; lines are joined by line breaks, and spaces
  at line ends are dropped.
- Tachikoma sends OSC 52 and also runs the system's tool in the background: `Set-Clipboard` on
  Windows, `pbcopy` on macOS, `wl-copy` or `xclip` on Linux. It cannot tell whether a terminal
  took the OSC 52, and the probe found both work here.
- The hint row says "Copied 312 characters" until the next key or click; the conversation does not
  get a line for it.
- **Shift+drag** still gives the terminal's own selection, as the probe found.

**Clicking:**
- **In the prompt:** the cursor moves to the character clicked; past the end of a row, to the row's
  end.
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
- **`[`** leaves full screen and prints the view into the normal scrollback, for the terminal's own
  search and selection; q or Esc comes back.
- **q, Esc or Ctrl+O** close the view. Ctrl-C does what it does everywhere.
- **During a turn** the work goes on, and new output goes into the conversation underneath. A
  permission question closes the view: it needs y and n, and n is "next match" here. Ctrl+O opens
  it again.

In classic mode, Ctrl+O and `/tasks t3` print below, as in releases 3 and 4.

## When something goes wrong

- **Putting the terminal back:** every way out (`/exit`, a double Ctrl-C or Ctrl-D, a crash, a
  signal from outside) turns the mouse reports off, leaves the second screen and shows the cursor.
  A hard kill (Task Manager, closing the tab) cannot be caught; if one leaves a terminal catching
  the mouse, closing that tab clears it. The README says so.
- **The system's clipboard tool is missing or fails:** the hint row says so ("Copied with the
  terminal only; xclip not found"); the OSC 52 was still sent.
- **The terminal is too small** for the live area: the conversation keeps at least one row, as the
  prompt does in release 3; what does not fit is dropped from the live area in release 3's order.

## Building it

1. **First, a check:** switching screens in the middle of a session, with Ink drawing everything
   again cleanly, on the stand-in terminal and in the user's. If it cannot be made to work, the user
   is asked before anything is built on it.
2. **Then a measurement:** memory and drawing time at growing session lengths, to settle whether
   the kept lines need a cap. The figures go into this design.
3. **Then the rest,** each task's tests seen failing before its code, as in releases 2 to 4.

## Testing

As before: Vitest, no test contacting a real provider, no test reading the user's own files.

- **Mouse reports:** each kind from the probe; a report split across two reads; reports taken out
  while keys and pastes reach Ink unchanged.
- **The view:** wrapping, rewrapping on a resize, drawing only the rows on screen, following and the
  "new lines" row, each scroll key, fractional scroll speeds, and the scroll bar's size, place,
  clicks and drags.
- **Selecting:** a drag to text (wrapped lines joined, line-end spaces dropped), a drag past the
  edge scrolling, word and line selection (paths and URLs whole), the click timing, and both copy
  routes with stand-ins for the terminal and the clipboard tool.
- **Clicking** in the prompt and on menu entries.
- **The detail view:** opening, keys, search (any case, n/N, Esc going back), `[`, and a permission
  question closing it.
- **Modes:** `--classic`, `TACHI_CLASSIC`, `/screen` both ways, and the terminal put back on each
  way out.
- **The App tests** use release 3's stand-in terminal with a height, with mouse reports fed through
  the filtered input.
- **Then the user's terminal checklist:** launch and quit putting the screen back; the wheel, the
  keys and the scroll bar; following and the "new lines" row; drag, double-click and triple-click
  copying, pasted elsewhere to check; clicking in the prompt and on menus; Ctrl+O's search and `[`;
  `/screen` both ways; resizing; and no fragments of old text left on screen.

## Not in this release

- Vim mode, image paste, an external editor, stash and rebinding keys in a file: release 6.
- The `--resume` line at quit: with transcripts on disk (release 8).
- Claude Code's `/scroll-speed` dialog, which saves to a settings file Tachikoma does not have, and
  its faster scrolling when the wheel spins quickly.
- Claude Code's `{`/`}` jumps between prompts, Space/b and Ctrl+E in the detail view.
- Going back to classic by itself after a failed start.
