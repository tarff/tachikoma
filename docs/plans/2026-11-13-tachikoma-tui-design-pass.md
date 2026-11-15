# Tachikoma TUI design pass: Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to build this
> plan task by task: a fresh builder per task, then a spec review, then a code review.

**Goal:** the window looks finished: blocks set apart by blank lines, your messages on a grey band,
`●` before replies and tool calls, lines around the prompt, a start-up box with the Tachikoma and
what loaded, one palette with a light and a dark look, the audit's fixes, and (PR 2) replies drawn
as markdown.

**Architecture:**
- **Styled lines.** A `Line` (describe.ts) and a kept line (view.ts) gain `styles` (runs of colour,
  background, bold, italic, dim and underline, by character offset over the plain `text`), `band`
  (the whole row on the band colour), `indent` (later rows of a wrapped line start that many
  columns in) and `block` (the line starts a block). The text stays plain, so wrapping, selection,
  search and copying are untouched; only drawing reads the new fields.
- **One palette,** `src/tui/theme.ts`, from the `theme` setting, `COLORFGBG`, `NO_COLOR` and the
  colour depth. Components take colours from it, never by name.
- **Gaps** are real empty lines `say()` (app/output.ts) puts before a `block` line, so classic mode
  and full screen space alike, and selections and the held view keep working by line number.
- **The start-up box** is built in `src/tui/startup.ts` from what cli.tsx already gathers, and
  handed to the App as its first `intro` lines, every row `oneLine`.
- **Markdown (PR 2)** goes through `marked`'s lexer into styled lines in `src/tui/markdown.ts`,
  for reply text only.
- **Laid out for the width text really has (review).** The start-up box and markdown are laid out
  for their *budget*: the columns a line's text gets, not the terminal's. `textWidth(columns,
  full)` gives the columns a kept line wraps at: in full screen one fewer than the terminal, as
  `Rows` keeps the last column for the scroll bar (`new Rows(columns - 1)`, app/state.ts); in
  classic all of them. A block's budget is that less its own lead columns (a reply's `● ` and
  indent: 2). A block laid out in one mode and shown after `/screen` in the other follows the
  resize policy (cut, never laid out again).

Design: `docs/plans/2026-11-13-tachikoma-tui-design-pass-design.md` (002ed4a, review fixes 0cdea31
and 0f0b978, point 5 withdrawn after it).

**Tech stack:** as background commands (TypeScript 7.0.2, Ink 7.1.1, React 19.3.0, Vitest 5.0.3,
ink-testing-library 4.0.0). New: `chalk` as a direct dependency at Ink's own version (choice P1),
and in PR 2 `marked` (choice A in the design).

---

## Before you start

**How this plan is built.** As the earlier releases: each task gives the files, the behaviour and
the tests, and each test says what it must show. A builder writes the tests first and sees them
fail, then the code, then commits. A spec reviewer and then a code reviewer check the commit before
the next task starts.

- **PR 1, the look:**
  - Part 1, the groundwork (Tasks 1-4): palette and setting, styled lines, gaps, the prompt's lines.
  - Part 2, the start-up box (Tasks 5-6).
  - Part 3, the audit (Tasks 7-13).
  - Part 4, documents, captures and the terminal check (Task 14).
- **PR 2, markdown:** Tasks 15-17.

**Stops for the user:** Task 14's and Task 17's terminal checks, in the user's own terminal, where
the band and tint colours are picked by eye (choice P4). Anything user-visible not listed under
"Lines this plan adds" goes to the user before it is built.

**The branch.** Build on the local branch `tui-design` (main 527e056 plus the design, head
0f0b978 or later). PR 2 builds on PR 1's branch after PR 1 merges, as a new branch from main. Do
not push: every push needs the user's fresh say-so; main takes changes only by pull request with
CI's `test` check passing.

**Checks, from the repo's folder:**
- Types: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
- One file: `node node_modules/vitest/vitest.mjs run tests/tui/view.test.ts`
- The App's tests, only with `-t`:
  `node node_modules/vitest/vitest.mjs run tests/tui/app.test.tsx -t "<describe name>"`. The file has
  over 500 cases; never run it whole for a task.
- The full suite only at the end of each part, with
  `--exclude tests/tui/external.test.ts`, which must never run. Time-outs under load: rerun those
  files alone.

**Rules every builder follows:**
- No registry fetch (npm/npx install, curl of a package) except through `sfw`, and only in the two
  tasks that say so, after the user's go-ahead.
- Delete only files you made, by exact name. Never change permissions.
- No real model calls in tests; the tests' fake providers only.
- Edit with the Edit tool, not `sed -i` (the working copy is CRLF).
- Rewrap only lines you changed.
- Comments follow the file's style: they say what and why, with the plan's task or choice.

## Choices this plan makes that the design leaves open

The user approved all six on 2026-11-13 ("yes to those six").

- **P1. `chalk` as a direct dependency** (`"chalk": "5.6.2"`, the version Ink 7.1.1 installed,
  read from `node_modules/chalk/package.json`), for its colour depth (`chalk.level`) and so the
  check is Ink's own. It is already in the lockfile under Ink; `sfw npm install chalk@5.6.2
  --save-exact` adds the top-level entry. The other way, copying its checks, would drift from Ink's.
- **P2. A tool call's dot is coloured when its row is drawn, not afterwards.** The design says
  grey while running, green when done, red when failed. But a call's row is said into the
  conversation when the model asks for the call, before its result, and classic mode cannot change
  a printed line. So the dot is the accent colour on every call row, and the result row under it
  says how it went, as today: `⎿ ok` grey, a failure red. The running state stays where it is shown
  today, the live row and the tool line (`◐`). Changing a row after the fact, in full screen only,
  would make the two modes differ.
- **P3. Replies indent their later rows** under the first word (`indent: 2`): the wrapped rows of
  a long line and the lines after the first. In full screen, view.ts wraps such a line to the
  width less the indent; in classic, Ink draws it in a row box (`●` then a growing box), which
  wraps the same way.
- **P4. The band and tint greys start as placeholders** in theme.ts and are set by eye with the
  user at Task 14's check, on their dark terminal and a light one if they have it. The values
  chosen are recorded in the plan's "As built" with the user's words. No other number is set.
  (Task 1's review: the accent is the art's `B`, #4278de, from the appendix; the other full-colour
  hex values, muted, success, error and warning in both looks, are placeholders set by eye at the
  same check.)
- **P5. On a short terminal the prompt's two lines give way first**, before the tool line and the
  hint row, so nothing that says something is lost to a rule.
- **P6. `marked` at an exact version**, the newest on the registry at Task 15 that is at least two
  weeks old, read from `sfw npm view marked time` at the time; written into package.json exactly,
  as every dependency is.

## Lines this plan adds

The user approves these words with the plan; a builder changes none without asking.

- **The start-up box:** the top border `╭─ Tachikoma <version> ─…─╮`; the row labels `lead`,
  `folder`, `mode`, `read`, `mcp`, `hooks`; values:
  - `mode`: `<mode> · sandbox <off|live|copy>`;
  - `read`: the file names, `, ` between, cut with `and N more`;
  - `mcp`: `N server(s) starting`;
  - `hooks`: `N`.
  - Under the box: `? for shortcuts · / for commands` (shown once, in the box's last line's place
    when there is no room under it).
- **Today's `Instructions:` line** loses the files read (the box names them) and keeps only what
  was left out: `Instructions left out: <path> (<why>), ...`, grey, under the box.
- **Cost (choice D):** `$0.42+` in the status line and the working line where today they say
  `$0.42 + ?`; `ChatGPT plan+` where they say `ChatGPT plan + ?`. The README's status line section
  says: "A `+` after the cost means some calls had no known price, so the real cost is higher."
- **Key hints (audit 8):** every list's hint names keys then a verb in its plain form, ` · `
  between:
  - the `/` and `@` menu: `↑↓ choose · Tab fill · Enter run · Esc close` (unchanged);
  - the model list: `↑↓ move · Enter pick · Esc close`;
  - `/resume`'s list and `/mcp`'s: `↑↓ move · Enter open · Esc close`;
  - a form's pick: `↑↓ move · Space mark · Enter answer · Esc decline`;
  - the review list and diff: unchanged (`Space keep/skip`, `q Esc back`).
- **The permission question** keeps its words; only the box around it is new.

## Numbers in this plan

None is invented. The pixel art is 48 columns by 15 rows because that is the drawing's own size
(scratchpad `tachi_px.py`, its grid). The box's widths come from the drawing and the list's longest
row. The colours are P4's. The columns taken off a width are each the drawing's own: 1 for the
scroll bar's column in full screen (`new Rows(columns - 1)`, app/state.ts), 2 for a reply's `● `
and indent (the marker's two characters), 4 for the permission box (a border and a space of
padding each side, as Task 9 draws it).

A review of this plan on 2026-11-13 found three gaps, each checked against the code and fixed
where marked "(review)": widths for the box and markdown (the text's budget, not the terminal's),
the status line's own colours under `NO_COLOR` (Task 13), and the permission box's inner width
(Task 9).

---

## Part 1: the groundwork

## Task 1: The palette and the `theme` setting

**Files:** create `src/tui/theme.ts`; change `src/settings.ts`, `package.json`; tests
`tests/tui/theme.test.ts`, `tests/settings.test.ts`.

**Step 0 (user's go-ahead first, choice P1):** `sfw npm install chalk@5.6.2 --save-exact`. Check
that `package.json` gains `"chalk": "5.6.2"` and `package-lock.json` changes only by that entry. If
`sfw` is not on PATH, stop and tell the user.

**Behaviour:**
- `theme` setting: `"auto"` (default), `"dark"`, `"light"`; read as `editorMode` is (`oneOf`), a
  wrong value warned about as other wrong values are. Not a command-line flag. Read at launch only
  (a live edit says it takes effect at the next launch, as other launch-only settings do).
- `look(settings, env, level): Look` with `Look = { light: boolean; color: boolean; full: boolean }`:
  - `color`: false when `NO_COLOR` is set and non-empty, or `level` is 0;
  - `full`: `color && level === 3`;
  - `light`: `theme === "light"`, or `"auto"` with `COLORFGBG`'s last number 7 or 15. `COLORFGBG`
    unset, empty or not numbers: dark.
- `palette(look): Palette` with `accent`, `text`, `muted`, `success`, `error`, `warning`, `band`,
  `addTint`, `delTint`: hex strings when `full`, Ink's named colours otherwise (`blue`, `gray`,
  `green`, `red`, `yellow`), `undefined` throughout when not `color`; `band`, `addTint` and
  `delTint` are `undefined` unless `full` (choice P4: placeholder hex values, named as such in a
  comment).
- The App gets the palette through a React context (`ThemeContext`), set in cli.tsx from
  `look(loaded.settings, process.env, chalk.level)`; tests get the dark full palette unless they
  give one.

**Tests:** `look` for each `theme` value; `COLORFGBG` `"15;0"` (dark), `"0;15"` (light), `"0;7"`
(light), `"default;default"` and unset (dark); `NO_COLOR=1` gives no colour at any level; level 2
gives colour without `full`. `palette` gives no band or tints without `full`. The settings file's
`theme` read and a wrong value warned.

## Task 2: Styled lines

**Files:** `src/tui/describe.ts` (`Line`, `screen`), `src/tui/view.ts` (`KeptLine`, `Row`,
wrapping), `src/tui/Conversation.tsx`, `src/tui/App.tsx` (classic `<Static>`), `src/tui/select.ts`
(`drawn`); tests `tests/tui/view.test.ts`, `tests/tui/conversation.test.tsx`,
`tests/tui/lines.test.tsx`.

**Behaviour:**
- `Line` gains `styles?: Span[]` (`{ start; end; color?; bg?; bold?; italic?; dim?; underline? }`,
  offsets into `text`), `band?: true`, `indent?: number`, `block?: true`. `color` stays as the whole
  line's colour, under any span's.
- `screen()` escapes the text run by run, so spans keep covering the same characters after
  `visible()` lengthens a control character into its escape.
- view.ts: a line with `indent` wraps its first row at the full width and its later rows (wrapped
  or after a line break) at the width less the indent, drawn with that many leading spaces; the
  rows' `start`/`end` offsets stay offsets into the text, so `placeAt`, `drawn` and copying skip the
  indent columns. A `Row` carries the line's `styles`, `band` and `indent` (the row's offsets pick
  the spans that apply).
- Conversation.tsx draws a row as runs: for each drawn character (select.ts `drawn`, as the
  selection's `marked` does today) its span's style; a `band` row fills the rest of its width with
  spaces on the band colour. The selection's and search's reverse colours go over the styles.
- Classic: `<Static>` draws a line as runs too, with `indent` as a row box (`●` part, then a box
  that wraps, choice P3), `band` as a `Box` with `backgroundColor` the screen's width.
- Without colour (Task 1's `color: false`) the spans' colours and backgrounds are dropped and bold
  stays; a band row is drawn plain.

**Tests:** spans across a wrap point and a line break land on the right rows; a span over a
control character escaped by `screen()` still covers its escape; `indent` rows at 50 and 100
columns, and a click and a selection on an indented row give the right offsets (the copy has no
indent spaces); a band row is padded to the width in both modes; a selection over a styled row
shows reverse on the text only; no colour drops colours and keeps bold.

## Task 3: Blocks, gaps and markers

**Files:** `src/tui/app/output.ts` (`say`), `src/tui/describe.ts` (`describe`, `callRow`), `src/tui/
fold.ts` (`foldRow`, the live row), `src/tui/App.tsx` (the notices and errors said from the bus),
`src/cli.tsx` (`intro`); tests in `tests/tui/lines.test.tsx`, `tests/tui/fold.test.ts`, and the
App's under `-t`.

**Behaviour:**
- `say()` puts one empty line before a `block` line unless it is the first line said, or the line
  before it is already empty.
- Your message: three lines, the middle one `› <text>`, the ones above and below empty, all three
  `band` and `block` on the first only. Its later lines (a message with line breaks) stay in the
  middle line's text, as today, and get `indent: 2`. The cyan `> ` goes.
- A reply's text: `● ` (accent span) then the text, `indent: 2`, `block`.
- A call row: `● ` in the accent colour (choice P2), the name and detail in the text colour;
  `block`. Result rows (`  ⎿ …`) are not blocks.
- A folded summary (`foldRow`) and the live row's top: `● ` grey then the text (audit 7), `block`.
- Notices said from the bus (MCP lines, hook lines, `Conversation shortened`, the lines a live
  edit says, `t3 finished`): `● ` grey, `block`. Errors: `✗ …` red as today, `block`.
- A question's detail (`┌ edit …`, the preview, App.tsx `bindAsk` and the moved question) is one
  block, `block` on its heading.
- Resumed conversations (`conversationLines`) and `intro` get the same marks, as they are drawn
  by `describe` and `foldRow`.
- `/export` and `Ctrl+O` are unchanged (they do not use these lines' marks).

**Tests:** gaps: two replies, a reply then a call then its result then a reply, a notice between
two replies; never two empty lines running; no gap before the first line. A user message's three
band lines in full screen and classic. A copy of a selection across a gap gives an empty line
there. A resumed conversation draws as the live one did.

## Task 4: The prompt's lines

**Files:** `src/tui/layout.ts` (`FrameIn`, `frame`), `src/tui/Prompt.tsx`, `src/tui/App.tsx`,
`src/tui/app/mouse.ts`; tests `tests/tui/layout.test.ts`, `tests/tui/prompt.test.tsx`, the App's
under `-t`.

**Behaviour:**
- A full-width `─` line in the muted colour above the prompt and one below, when the prompt is
  drawn (not under a question, a list, the detail view or a form). The menu, the task panel, the
  hint row and the status line go under the lower line.
- `frame()` counts the two rows: they go first when rows are short (choice P5), then the tool line
  and the hint as today. `FrameOut` gains `rules: boolean`; `promptFirst` counts the upper line.
- mouse.ts maps a click on either line to nothing, and a click on the prompt's rows as before (its
  first row moved down one).

**Tests:** `frame()` on a terminal tall enough (both lines), one row short of that (no lines, the
rest as today), and the existing cases' numbers moved by the two rows where drawn. A click on the
upper line does nothing; a click on the prompt's first row places the cursor as before.

---

## Part 2: the start-up box

## Task 5: The drawings

**Files:** create `src/tui/art.ts`; delete `tachikoma.txt` from the project's top folder (the
user's file, choice E: move its drawing first, then delete it by that exact name); tests
`tests/tui/art.test.ts`.

**Behaviour:**
- `PIXELS`: the pixel art's grid, one string per pixel row, one letter per pixel (`.` empty, `B`
  blue, `S` shade, `L` light, `W` white, `P` pupil, `D` dark, `R` red, `G` grey), exactly as in
  the appendix "The pixel art" below. `PIXEL_COLORS`: each letter's hex colour, from the same
  appendix.
- `pixelRows(): Line[]`: two pixel rows a text row: `▀` with the top pixel as colour and the bottom
  as background, `▄` or `█` where one or both are set, a space where neither; `oneLine`.
- `ASCII`: the user's drawing, exactly as in `tachikoma.txt`, as a string array. `asciiRows()`:
  its rows in the accent colour, `oneLine`.

**Tests:** every `PIXELS` row has the same length; every letter has a colour; `pixelRows()` gives
half as many rows as `PIXELS` (rounded up), each the grid's width in columns; `ASCII` is the
user's file byte for byte (the test holds its own copy).

## Task 6: The box

**Files:** create `src/tui/startup.ts`; change `src/cli.tsx` (`intro`), `src/clilib.ts`
(`instructionsLine`); tests `tests/tui/startup.test.ts`, `tests/clilib.test.ts`, the App's under
`-t` for the resize.

**Behaviour:**
- `startBox(info, width, look): Line[]`, `info` = version, lead, folder (home shortened to `~`),
  branch, mode, sandbox, instruction file names, MCP server count, hook count. Rows with nothing
  (no files, no servers, no hooks) are left out.
- Layout, by measure: the pixel art when `look.full` and the art, a gap, the list and the borders
  fit `width`; else the ASCII drawing when it fits; else the list alone. The box is as wide as
  `width` allows up to what it holds. Every row `oneLine`, the first `block`.
- Under it: `? for shortcuts · / for commands`, muted.
- cli.tsx puts the box first in `intro`, laid out for `textWidth(columns, full)` (Architecture),
  `columns` being `process.stdout.columns` (80 when unknown, as Ink's `getWindowSize` falls back,
  `node_modules/ink/build/utils.js`) and `full` whether the window starts in full screen; then
  `Instructions left out: …` when any were, then the box's own lines (sandbox) as today. `-p`
  runs draw none.
- The resize policy (design, "Resizing"): nothing redraws the box.

**Tests:** the box at 120, 80 and 50 columns, with `full`, with colour but not full, and with no
colour; rows left out when empty; a long file list cut with `and N more`. Exact fit (review), in
both modes: at the narrowest terminal where the pixel art and list fit, the box is drawn with no
row cut (in full screen that terminal is one column wider than in classic); one column narrower
gives the ASCII layout, again uncut. `textWidth` in both modes. The App in full screen:
box drawn at 120, resized to 50 (each box row one screen row, cut with `…`), back to 120 (frame
as at first); a selection on a box row and a held view keep their text across all three.

---

## Part 3: the audit

## Task 7: Diffs in colour (audit 2)

**Files:** `src/tui/App.tsx` (`bindAsk`, where a question's `detail` is said under its `┌`
heading), and the edit's row as Ctrl+O and the moved question show it; tests the App's under `-t`.

**Behaviour:** only an edit's preview is a diff: `edit_file` builds its `detail` as the old text's
lines each marked `-` then the new text's marked `+` (`src/tools/files.ts`, `marked("-", …)`). In
it, a `+` line gets the success colour and, with `full`, the `addTint` background; a `-` line the
error colour and `delTint`. A write's preview is the file's own text, where a line may start with
`-` or `+` meaning nothing, so it stays muted. The question tells them apart by its summary's
first word (`edit ` against `write `, files.ts). The text is unchanged.

**Tests:** an edit's preview with spans over its `+` and `-` lines only; a write of a file whose
lines start with `-` gets none; no spans without colour.

## Task 8: One path per edit (audit 3)

**Files:** `src/tui/App.tsx` (`bindAsk`'s preview heading, the answer line), wherever the
question's label is made; tests the App's under `-t`.

**Behaviour:** the preview's heading and the answer line name the file relative to the project
when it is inside it, as the call row does. The answer goes under the call (`  ⎿ You allowed
this.`) when the call's preview is the last thing said, as when its tool line is. The question
line itself keeps the full path (it is what is being allowed).

**Tests:** an edit allowed: one row naming `src/save.ts`, the preview headed `src/save.ts`, the
answer under `⎿`; a file outside the project keeps its full path everywhere.

## Task 9: The permission question in a box (audit 4)

**Files:** `src/tui/App.tsx` (the question branch, both modes), `src/tui/layout.ts` (the
question's rows count the box's two border rows); tests `tests/tui/layout.test.ts`, the App's
under `-t`.

**Behaviour:** a rounded box in the muted colour around the grey note, the red danger lines and
the question's line; the keys line (`[y/n] · Esc to decline`) under the box. When the box does not
fit, the existing short line (`… (shown above)`) is used, as today, boxed the same way.

- **Inner width (review):** inside the box, text gets the terminal's columns less 4: a border
  column and a space of padding on each side. `frame()` measures the question's line, its short
  line and its note at that inner width (today `linesOf` wraps at `i.columns`), and cuts the red
  lines at it, so the rows it counts are the rows drawn and the "shown above" fallback is chosen
  on the true height. The box adds its two border rows to the question's rows.

**Tests:** the frame's rows with the box; a question that fits, one that moves above, one with
dangers; classic and full screen. Wrap boundaries (review): a question line exactly the inner
width (one row) and one column longer (two rows), at 80 and 40 columns; the same for a red line
(cut, one row). Short terminals: the tallest terminal where the boxed question no longer leaves
the conversation its row, which must choose the short line, and one row taller, which must not.

## Task 10: The status line (audit 6, choice D)

**Files:** `src/tui/StatusLine.tsx`; tests `tests/tui/statusline.test.tsx`.

**Behaviour:**
- Left out while zero: `errors` at 0, `tokens` while both are 0, `cost` while 0 and known.
- Labels muted, the model in the accent colour.
- Too long for the width: parts drop from the end of the list given in `--status`, one at a time,
  `lead` and `mode` last, instead of the line being cut with `…`.
- `costText`: `$0.42+` and `ChatGPT plan+` (choice D). The working line uses it as today.

**Tests:** each part at zero; the drop order at 100, 60 and 40 columns; the cost words.

## Task 11: Key hints and the `/` menu (audits 8 and 9)

**Files:** `src/tui/ModelPicker.tsx`, `src/tui/SessionList.tsx`, `src/tui/McpList.tsx`,
`src/tui/Field.tsx`, `src/tui/Menu.tsx`; their tests.

**Behaviour:** the hints in "Lines this plan adds". The `/` and `@` menus: each entry's note starts
in one column, two spaces after the longest label among the entries shown.

**Tests:** each list's hint, with default keys and with a rebound key; the menu's notes aligned at
100 and 50 columns, a label longer than the width still cut at the end.

## Task 12: Ctrl+O (audit 10)

**Files:** `src/tui/describe.ts` (`callLines`); tests `tests/tui/describe.test.ts`.

**Behaviour:** Ctrl+O and `/tasks t3` show a call's input as `name: value` lines (a string value
on its own lines when it has line breaks; other values as JSON on one line), and a shell result
without its empty `--- stderr ---` or `--- stdout ---` section. `/export` (`callText`) and what
the model reads are unchanged.

**Tests:** inputs of each kind; a shell result with empty stderr, empty stdout, both, neither.

## Task 13: Every colour from the palette (audit 12)

**Files:** every `src/tui/*.tsx` and `src/tui/app/*` that writes a colour by name (`grep -rn
'color=\|color: "' src/tui`); tests as each changes.

**Behaviour:** each named colour becomes its palette entry by meaning (grey → muted, red → error,
yellow → warning, green → success, cyan → accent), so `NO_COLOR` and the light look reach every
part. The status line's mode colours and context bar keep their own colours (they mean risk and
fullness), but only while `look.color` is true (review): chalk does not read `NO_COLOR` (its
check reads `--no-color` and `FORCE_COLOR` only), so a colour name handed to Ink would still be
drawn. With `look.color` false they get none, and the bar's cells show the fill by `█` and `░`
alone, as they do now without colour.

**Tests:** a grep in a test that no component writes a colour name outside theme.ts and the two
exceptions, and that both exceptions read `look.color`. The App under `-t` with `NO_COLOR=1` and
colour forced on (`FORCE_COLOR=3`, so chalk would draw colour) draws no colour codes anywhere,
the mode and context parts of the status line included (each mode, and the bar at green, yellow
and red levels).

---

## Part 4: documents, captures and the check

## Task 14: README, captures, terminal check

- **README:** the look (blocks, band, markers, prompt lines), the start-up box, the `theme`
  setting and `COLORFGBG`, `NO_COLOR`, the cost's `+`, the resize behaviour; `tachi --help`
  unchanged unless a line in it is now wrong. The user approves the README's new words before the
  commit.
- **Captures:** the 44 screen captures made again (the scratch test, run as before and deleted by
  exact name), put beside today's for the user.
- **Terminal check (scratchpad `checklist-tui.md`):** the user runs `tachi` in their terminal:
  start-up box and art; a conversation with tools, a failure and an edit; the band and tint greys
  and the muted, success, error and warning colours, set by eye (choice P4), on dark and, if they
  can, light (`theme: "light"`); `NO_COLOR=1`; a
  resize 120 → 50 → 120; a permission question. Fixes from it are built, reviewed and re-checked.
- Then: the whole-PR review, the full suite once, and a PR on the user's say-so.

---

## PR 2: markdown

## Task 15: `marked` and the renderer

**Step 0 (user's go-ahead first):** `sfw npm view marked time` to pick the version (choice P6),
then `sfw npm install marked@<that> --save-exact`. Check it has no dependencies of its own
(`npm view marked@<that> dependencies` prints nothing).

**Files:** create `src/tui/markdown.ts`; tests `tests/tui/markdown.test.ts`.

**Behaviour:** `markdownLines(text, width, palette): Line[]` from `marked.lexer(text)`, `width`
being the budget its caller passes (Architecture, "Laid out for the width text really has"):
headings bold in the accent colour; bold, italic, inline code (accent); bulleted and numbered
lists, indented, nested lists further; block quotes with a muted `│ `; links' text underlined, the
address after it muted when it differs from the text; code blocks on the band colour, one colour,
fences and language not drawn; rules as a muted `─` line. Tables: drawn with box lines when they
fit `width`, every row `oneLine`; otherwise their raw text. Raw HTML and anything else the lexer
gives: its raw text. All text through `visible()` as today.

**Tests:** each piece alone and mixed; nested lists; a code block with a markdown-looking line
inside drawn raw; a table that fits and one that does not; a link whose text is its address; no
colour.

## Task 16: Replies as markdown

**Files:** `src/tui/describe.ts` (`describe`, a reply's text), `src/tui/fold.ts`
(`conversationLines`, resumed replies alike); tests the App's under `-t`.

**Behaviour:** a reply's text part is drawn with `markdownLines` at its budget (review): the
text width at that moment, `textWidth(columns, full)`, less the reply's two lead columns (`● `
and the indent), so a table that passes the fit check is never cut before a resize. The first
line takes `● `. Your messages, tool output and notices are never drawn as markdown. Selection and
copying give what is drawn (design, "Copying"). `/export` unchanged.

**Tests:** a reply with a heading, list and code block drawn styled; a copy of it gives the drawn
text; `/export` gives the raw markdown; full screen at 120 with a table, 50, 120 (the table's rows
cut at 50, the frame at 120 as at first, a selection kept). Exact fit (review), in full screen and
classic: a table exactly the reply's budget wide is drawn with box lines and no row cut (full
screen's budget one column less than classic's at the same terminal width); one column wider is
left as its raw text.

## Task 17: README and terminal check

README's markdown section (what is drawn, copying gives what is drawn, `/export` the raw text);
captures again; the user's terminal check of real replies; then review, full suite, PR on say-so.

---

## Appendix: the pixel art

The drawing the user saw and accepted on 2026-11-13 (scratchpad `t2.ans`, made by `tachi_px.py`
from circles, lines and rounded boxes, then shrunk to this grid). 48 pixels wide, 30 tall: two
pixel rows to a text row, so 15 rows on screen.

Colours: `B` #4278de, `S` #284ea0, `L` #8cb4f5, `W` #ebf0f8, `P` #191e2d, `D` #373c4b,
`R` #dc3c32, `G` #bec3cd; `.` is empty (the terminal's own background).

```
................................................
..........................LLL.BBBBBBBB..........
................SS.......LLLLLBBBBBBBBB.........
................SS.......LLLLBRBBBBRBBBB........
.................S.......LLLBBRBBBBRBBBBB.......
.................S.......LLBBBBBBBBBBBBBBB......
.................S.......LLBBBBBBBBBBBBBBB......
.................S.......LLBBBBBBBBBBBBBBB......
..............BBBBBBBWWW.LLBBBBBBBSSSSBBBB......
...........WWWWLBBBBWWWWWLLBBBBBBSSBBSSBBWW.....
.........LWWWWWLLLBBWWWWWWBBBBBBBSBBBBSBBWWW....
........BWWWPWWWLLBWWPPPWWBBBBBBBSBBBBSBBWWW....
.......BBWWPPPWWLBBWWPPPWWBBBBBBBSSBBSSBBBW.....
......WWBBWPPPWSSSSSWWPWWBBBBBBBBBSSSSBBBB......
......WWWBWWWWWBBBBBBWWWSSBBBBBBBBBBBBBBBB......
......WWSSSBBBBBBBBBBBBBBSSSBBBBBBBBBBBBB.......
......SSSSSSSSSSSSSSSSSSSSSSSSBBBBBBBBBBB.......
.......SSBBBBBBBBBBBBBBBBBBSS.BBBBBBBBBSSSS.....
.....S.SSBBBBBBBBBBBBBBBBBBSS.BBBBBBBB.SSSSS....
....SS..SGGBBBBBBBBBBBBBBGGGS............SSS....
....SS.BBGGGBBBBGGBBBBBBBGGGBB............SSS...
...SSSBBBBGSSBBBGGGBBBBSSGGBBBB...........SSS...
...SSBBBB....SSSBGBSSSS....BBBBB...........SSS..
..SSBBBB........BBB..........BBBB..........SDD..
..DDBBB.........BBB...........BBB...........DDD.
..DDDB.........BBB............BBB...............
...BBB.........BBB.............BBB..............
..BBB.........BBB..............BBB..............
..DDB.........DDB..............BDD..............
.DDDD........DDDD..............DDDD.............
```

## As built

(Filled in as tasks finish.)

- **Task 1** (aca2fba, review fixes d3558e5): `theme` setting and palette. Departures, accepted
  by the controller: `text` has no colour in any look (the terminal's own foreground, since a fixed
  one would differ between light and dark and the design gives none); the context carries the
  `Look` with the palette (`{ look, palette }`), as Tasks 2, 6 and 13 need `look`; a live edit of
  `theme` uses the launch-only settings' existing sentence (src/tui/app/liveEdits.ts).
- **Task 2** (b99a543, review fixes 77eafe4): styled lines. An empty line prints as one row in
  classic (Ink gives an empty Text none), for the gaps and the band. Known limits: the lead must be
  `indent` plain characters (a line break, a tab or a wide character in it draws differently in
  the two modes); a span edge between `\r` and `\n` draws the `\r` (Task 7 ends spans after `\n`).
- **Task 3** (cf7863e, fixes d32e986 and 931538f): blocks, gaps and markers. The user chose
  (2026-11-13, "Gap; ● on warnings"): each slash command's output is one block with no dot, a
  list's pick included; the start-up warnings are notices. Controller's calls from the reviews: a
  red line (a live edit's problem, the launch's red line) is a block with no dot; an opened fold
  is spaced as its calls were live; your message's empty band rows are not a gap, so a reply
  after it gets its own; notices take `indent: 2` like replies; the live row has an empty row
  above it. All to be looked at in Task 14's terminal check. Known limits: a line said by
  something else while a command awaits can take the command's block mark; `/settings` and
  `/keybindings` do not hold `working` while the editor is open; a click on a gap row in an
  opened fold closes it.
- **Task 4** (1d763e8, fixes a659eac and e0c4f54): the prompt's lines. The user chose
  (2026-11-13, "Give way for all") the broad reading of P5: the lines are drawn only in rows left
  over once every other part has the rows it has without them, so on a short terminal they go
  before anything else does, and with them only the conversation is two rows shorter. They span
  all `columns`. Known limits: `─` is drawn two columns wide by a terminal set to draw such
  characters wide (some East Asian setups), so each line wraps and the rows below are off; a
  click on a menu row during Ctrl+R search maps to the wrong entry (the search's prompt has no
  clickable rows in the frame, which was so before this task).
- **Task 5** (be5bdf6, review fixes 66330f7): the drawings. `asciiRows` takes the palette
  (`asciiRows(palette)`), as a plain function cannot read the context. `tachikoma.txt` was moved
  in byte for byte (checked against the file before it was deleted) and deleted. The pixel art is
  for full colour only. Known limit: `▀ ▄ █` are drawn two columns wide by a terminal set to draw
  such characters wide, as `─` in Task 4.
- **Task 6** (406c129, fixes 39c7b9d and 64299b3): the start-up box. The user chose (2026-11-13):
  "Gap 2, right pad 2" (between the drawing and the list, and inside the right border; the
  picture gives 2 on the left and 2 after a label); "Grey border+labels" (values and, "Own
  colour", the title in the terminal's own); "Cut inside the box" (a too-wide value cut with `…`
  inside the border); the folder row `<folder>  git:(<branch>)`, top-aligned, no blank rows,
  the hint indented 2; "Never costs drawing" (the drawing is picked with the `read` and folder
  rows at their shortest); "Short paths when repeated" (files sharing a name show their path,
  home as `~`); "Cut the path's middle" (a long folder keeps its start, its own name and the
  branch). Controller's calls: the shortcuts line always goes under the box (the plan's "in the
  box's last line's place when there is no room under it" cannot happen, as there is always a
  next line); the MCP count is the servers in the "starting" state; `textWidth` is in view.ts.
  Under 7 columns the box is 7 wide (a border and padding around one column). For Task 14: the
  README's "A grey line at the start lists them" (README.md:94) is now wrong; on the user's
  machine the three CLAUDE.md files show as `~\.claude\CLAUDE.md and 2 more` beside the pixel
  art, which needs 95 columns there; look at both at the check. Left as they are: App.tsx keeps
  its own `columns - 1` beside `textWidth`; `Instructions.read[].size` is no longer shown;
  `tilde` matches the home folder's letter case exactly.
- **Task 7** (1b4b83c, fixes 42189a1, 72f4169 and e4066ae): diffs in colour. `previewStyles`
  (describe.ts) colours an edit's preview; each span runs to just past its line's `\n`, so a
  CRLF file's `\r` is never drawn. Ctrl+O and the moved question are unchanged: neither shows a
  diff (Ctrl+O shows the input unmarked; the moved question re-says only its own line). From the
  review: Task 2's span loops (`runs()`, `keptOf`) now step through spans in order (a 20,000-line
  edit drew in 32.5 s in classic before, 2.2 s after). The user chose (2026-11-13, "Expand
  first-row tabs"): in classic, a tab on a tinted line's first row is printed as spaces to its
  8-column stop, as full screen draws it. Known limits: a tab on a later row is expanded by Ink's
  wrap-ansi counting from the line's start, so it lands a column or two off full screen; a row
  mixing an untinted tab before a tinted one can break one character differently; the tint
  covers a line's characters only, not the rest of its row (look at it in Task 14's check).
- **Task 8** (4427ae5, fixes 28248ac and 403eb74): one path per edit. The preview's heading and
  the answer name the file through `fileShown` (describe.ts, over `shownPath`), against the
  workspace's folder; the answer goes under the call when the call's row came straight before
  its preview and nothing was said after it, so a declined write shows one row, not two. The
  question keeps the full path. The plan's "as the call row does" was wrong: the row showed the
  path as typed. The user chose (2026-11-13): "Edit/write rows too" (edit and write call rows
  name the file the same way, through `target`; other tools' rows stay as typed); "Match the 3
  notes exactly" (only the three notes files.ts adds keep a path in full, `noted()`; `notes (1)`
  is relative); "Fix it in Task 8" (in the box, `/work/src/save.ts` shows `src/save.ts`, read by
  POSIX rules on a Windows host; the question keeps `/work/…`); "Both" (the live tool line and
  the subagent panel's and `/tasks`' rows use `target` too). From the review: the project folder
  itself shows `.`; a path holding a `\uXXXX` escape (made by the question's `visible()`) keeps
  its full path, so a bidi character is never read as a folder split; `FoldOptions.root` is
  required. Known limits: a file really named like `draft (really final)`, or a folder named like
  `u0041x`, keeps its full path; a path through a link or a Windows short name is relative on its
  row but full, with its note, in the heading.
- **Task 9** (0ea7c1c, fixes 8e827a6): the question in a box. Ink's own rounded border
  (`borderStyle="round"`, `paddingX={1}`, the same `╭─╮` as the start-up box) in the muted colour,
  the terminal's own without colour; the question's contents keep their colours. The plan's "keys
  line under the box" assumed a line that does not exist: the keys end the question's own line.
  The user chose (2026-11-14, "Inside, as today"): the keys stay on the question's line, in the
  box. In full screen the note and red lines are cut inside the box (one row each); in classic the
  red lines wrap inside it, as they wrapped before. From the review: in classic the frame keeps 3
  rows for a question (the box and one line), so on a short terminal the tool line and hint give
  way before the live area fills it (a full live area makes Ink reprint the history on a Windows
  console). Known limits: classic does not count a question line that wraps, the note or the red
  lines, so a tall classic question on a short terminal can still fill it; at 4 columns or fewer
  the box has no room inside.
- **Task 10** (30c78d9, fixes 1f13366, a8a793b and 2bfeed3): the status line.
  `zero()` leaves out errors at 0, tokens at 0 in and 0 out, and a cost of 0 with every price known
  (a cost of 0 with an unknown price shows `$0.00+`); the line is measured with `string-width`
  (the copy Ink uses) and parts drop from the end of the `--status` list. App.tsx passes
  `columns` and the palette (outside the plan's Files, needed). The user chose (2026-11-14): "Keep
  showing it" (a ChatGPT-plan lead at a known 0 still shows `ChatGPT plan`); a lone part too wide
  is cut to the terminal's width with `…`, never dropped ("in relation to the terminal size");
  "Mode drops first" (of `lead` and `mode`, the one listed later drops first); "Same everywhere"
  (the task panel's rows use `costText`, so `$0.42+` there too); from the review, "Put back what
  fits" (after dropping, the dropped parts are tried in list order and each that fits comes
  back). Builder's call: nothing is put back while `lead` or `mode` is dropped, so a narrow line
  never shows the cost without the mode. With colour off the labels are plain (they were dim).
  For Task 14: the README's `+` sentence; at 60 columns the context bar drops before `perm ask`,
  as the plan's order says (look at it at the check). Known limits: a line whose listed parts are
  all zero draws nothing but keeps its row (user: "Known limit"; so before with `--status
  tasks`); a part's width steps (`<1m` to `1m`, `999` to `1.0k`) can bring a dropped part back
  once; `⏱` counts one column, as Ink counts it.
- **Task 11** (0efd407, fixes f850392 and da400ee): key hints and the menu's notes. The hints
  read as "Lines this plan adds" says; `SESSION_WORDS.closes` (app/constants.ts) is now `"close"`.
  The user chose (2026-11-15): "Plain verbs" for the two the plan did not list (`tachi -r`'s own
  list `Esc quit`; one MCP server's view `Enter run · Esc back`); the review's finished screen
  (`any other key closes`) left as it is ("Leave it"). The menu's notes start two spaces after the
  longest label shown, measured with `string-width`; the "↑/↓ N more" rows do not count. The user
  chose, from the reviews: "No room left" and "Count the …" (a label sets the column only when its
  note still shows one character before Ink's `…`: 2 + label + 2 + 1 < columns); "Leave it out" (a
  row with no note, an MCP prompt with no description, does not count). Such a row keeps its note
  two spaces after its own label, so it is ragged. Builder's call: Menu takes a `columns` prop
  (App.tsx passes `ui.columns`, Field passes it on; outside the plan's Files), as
  `renderToString` gives the hook no width; the reviewer checked it is the width the rows are cut
  at in both modes. For Task 14: README.md:668-669 quotes the old `/resume` hint.
- **Task 12** (afbd208, fixes b5416ac, 5c3be24 and 29c0a1b): Ctrl+O's `name: value`. `callLines`
  (describe.ts) no longer uses `callText`, whose unused `name` was removed; `/export` is unchanged.
  The user chose (2026-11-15): "As shown" (each input two spaces in under `● <name>`; a string
  with line breaks as `name:` then its lines four in, empty lines not indented; other values as
  one-line JSON; no input, the name line alone; the result under `⎿` as before); "No gap, as
  today" (no blank line between calls); "Keep the quotes" (a key that is not letters, marks after
  the first, digits, `_`, `$`, `.` and `-` is JSON-quoted, so it cannot pass for another key or a
  value's line); "Show \"\"" (an empty string shows `""`). A `shell` result drops an empty
  `--- stderr ---` or `--- stdout ---` section; only the first marker after a one-line `exit code:`
  or `killed by` status counts, and a result holding the stdout marker twice is shown unchanged, so
  no output is ever dropped. Keys and values go through `visible()`. Builder's calls: a CRLF
  value's `\r` goes with its line break, a lone `\r` shows as `␍`; non-object input is its JSON on
  one line. Known limits: a shortened result whose stderr starts with a blank line and the stdout
  marker, long enough that the cut removes the real marker, shows that stderr as stdout, no text
  lost (user: "Hide it, rare case a limit", so long output with no errors still loses its empty
  heading); Hangul fillers (U+3164 and kin) count as letters, so a key of them stays bare; the
  layout cannot tell the string `"60000"` from the number. For Task 14: README.md:692 says /export
  writes calls "as Ctrl+O shows it".
- **Task 13** (568406a, fixes bd70e25 and 5ded7dd): every colour from the palette. A line's or a
  row's colour is a role (`Role` in theme.ts: accent, muted, success, error, warning), looked up
  in the palette wherever it is drawn; a real colour is a `Colour` (a hex or one of chalk's
  names), so tsc refuses a role where a colour belongs. `app/output.ts` tells a live edit's
  problem by the `"error"` role. The user chose (2026-11-15): "Accent (blue)" (the magenta
  notices, the fallback `↪`, "lead is now", the `/login` and `/model` progress and the history's
  notes, are the accent); "Muted, branch accent" (the status line's `git:(` and `)` muted, the
  branch accent; the folder is the warning colour). Outside the plan's Files, as their lines
  reach the screen (coordinator's go-ahead): cli.tsx's start-up lines and src/sandbox/diff.ts's
  review diff (`@@` accent, `-` error, `+` success); `tachi review` and `tachi -r`, drawn alone
  before the session, are drawn in a ThemeContext from `themeOf(settings, env, level)`, as the
  App is; `tachi review` reads the settings itself, quietly (a broken file is the default look).
  From the review: `Palette.text` removed (always undefined, its one reader gone); the status
  line reads ThemeContext itself. The plan's `FORCE_COLOR=3` does nothing in a test (chalk reads
  it once, at import); the level comes from `inColour(3)` / `chalk.level = 3`. Dim is a style
  and is kept without colour, as Task 2 keeps it. Known limits: the cli.tsx wiring itself is not
  under test; a settings file with one bad entry draws `tachi review` dark even with `"theme":
  "light"` (a session would refuse that file). For Task 14: cyan is now the accent blue (the
  review's `@@`, the branch); at chalk levels 1-2 the accent is ANSI `blue`, hard to read on many
  dark palettes (the classic Windows console), where those lines were magenta or cyan; the mode
  colours and context bar stay named colours in the light look (look at them at the check).
- **Task 14** (cf38b6a, f6e83b5 and 8202f55; README with the PR's review): the check. The 44
  captures were made again (scratchpad `screens-pr1\`, with light and no-colour copies of five and
  COMPARE.md); every state was reached as before. From them the user chose (2026-11-15): "Hint row
  quiet at launch" and "After the first key" (the hint row's `? for shortcuts` is blank, the row
  kept, until the prompt first holds text; the box's line says it till then); "Add the empty line"
  (classic Ctrl+O's printed block, and its /compact summary, start a block); "Darker shades for
  light" (`LIGHT_PIXEL_COLORS`: light blue #7596cc, white #92959a, grey #91959d, each the lightest
  shade at WCAG 1.4.11's 3:1 against white; the other five already reach it). From the review:
  the flag reads what the prompt row shows, so a Ctrl+R match counts, and `command()` sets it;
  the user chose "Show the hint after -r/-c" (cli.tsx passes `restored` when the conversation
  brought back has messages). The README's new words, "How the screen looks" and the rest, were
  approved by the user (2026-11-15/16). At the terminal check (2026-11-16, dark Windows Terminal)
  the user found steps 1-5 and 7-9 fine, the band, tint and colours as they are; chose "Keep it,
  cut with …" for the box on a narrower window, "Fine as is" for the context bar dropping before
  the mode at 60 columns, and a smaller art: "40×24: 12 rows" (art.ts `PIXELS`, the same drawing
  scaled with a step that puts back the pixels the shrink drops; the appendix's 48 by 30 grid and
  this plan's "48 columns by 15 rows" and "95 columns" are the earlier size: the box is 8 columns
  narrower, 87 columns of text on the user's machine). Not checked: the light look (step 6; the
  user's terminal is dark), so its colours are the starting values. Known limits: keys piped in
  one read (Ctrl+R, its text and Enter) send the match undrawn, and the hint stays blank until
  the next key; in the light look the art's white and grey are nearly the same grey.
