# Tachikoma TUI design pass, design (2026-11-13)

A piece of work of its own, after background commands (PR #18) and before the fuller system prompt
and 8c-2 (the user's order, 2026-11-13). The screen today: every line sits against the next, your
messages are a cyan `> ` line, replies have no marker, markdown shows raw, the start-up screen is an
empty prompt, and colour is a few named colours written into each component (grey for most
secondary text; yellow, red, green, cyan and magenta in a few places).

The user chose the scope on 2026-11-13: their own list, an audit of every screen, a side-by-side with
Claude Code, and colour and themes ("use them all" for the 13 audit points). Choices quoted below
are theirs; the rest is mine for them to review.

A review of this design on 2026-11-13 found three gaps, each checked against the code and marked
"(review)" where it lands: copying drawn markdown (the user chose "what you see"), streaming (there
is none today, so the section is dropped), and asking the terminal for its background (the user
chose a setting instead, nothing sent to the terminal).

## Sources

- **Today's screens:** 44 captures of every screen state at 100 and 50 columns, made from the
  App and components with the tests' fake providers (scratchpad `screens\`, INDEX.md lists them).
- **Claude Code's look:** the user's own use of it, and the earlier release 5 notes on how Claude
  Code 2.1.310 draws full screen. Nothing here copies its code or art.
- **Codex's grey band:** the user's description ("a greyer box like codex").
- **The Tachikoma:** a reference picture the user gave, and the user's own ASCII drawing
  (`tachikoma.txt`). The pixel art below is drawn fresh, not converted from the picture.
- **Code as of 527e056:** `src/tui/describe.ts` (`Line`), `src/tui/view.ts` (`Row`, `KeptLine`),
  `src/tui/Conversation.tsx`, `src/tui/App.tsx` (`<Static>` in classic), `src/tui/StatusLine.tsx`,
  `src/tui/Menu.tsx`, `src/tui/Field.tsx`, `src/tui/DetailView.tsx`, `src/tui/fold.ts`.

## Two PRs

1. **The look:** spacing, markers, the grey band, the prompt's lines, the start-up box, colours and
   themes, and audit points 2 to 13.
2. **Markdown:** audit point 1, the biggest single piece.

## 1. Spacing and markers (option chosen: "Both")

- **Blocks:** a block is your message, a reply, a tool call with its result lines, a folded summary,
  a notice, or an error. One blank line goes before each block except the first on screen.
- **Your messages** sit on a grey band the full width of the screen, one blank band row above and
  below the text, starting `› `. The band replaces today's cyan `> `.
- **Replies** start with `● ` in the accent colour; their later lines are indented two columns, so
  the text lines up under the first word.
- **Tool calls** keep `● name detail` (today yellow) with results under `⎿`. The dot shows the state:
  grey while running, green when done, red when failed. The name and detail are in the normal text
  colour.
- **Folded summaries and notices** ("Read 1 file", "MCP server tradingview is ready: 78 tools.")
  start with a grey `● ` (audit point 7). Errors keep `✗` in red.
- **The prompt** has a full-width line above and below it, in grey; the hint row and the status line
  sit under the lower line.
- **Copying and /export** are unchanged: the band, the markers' colours and the blank lines are
  drawing only. A selection copies the text as today, markers included (they are text, as `●` is
  now).

### What changes underneath

Today a line has one colour (`Line.color`, `Row.color`). Markers, the band, coloured diffs and
markdown all need more than one style on one line. So a line gets:

- `styles`: style runs by character offset over its `text` (colour, background, bold, italic, dim,
  underline). The text itself stays plain, so selection, search, copying and wrapping work on text
  exactly as now; a wrapped row takes the runs that fall inside it.
- `band`: the whole row, padding included, drawn on the band colour.

Conversation.tsx draws a row as runs; classic mode's `<Static>` draws the same lines the same way.

## 2. Start-up box (option chosen: "Box, two columns")

At launch (and after `-c`/`-r`, above the history it redraws), a rounded box:

```
╭─ Tachikoma 0.1.0 ───────────────────────────────────────────────────╮
│  [the Tachikoma]      lead    anthropic:claude-opus-5-5            │
│                       folder  ~\Agent Harness  git:(main)           │
│                       mode    ask · sandbox off                     │
│                       read    CLAUDE.md, AGENTS.md                  │
│                       mcp     3 servers starting                    │
│                       hooks   2                                     │
╰─────────────────────────────────────────────────────────────────────╯
  ? for shortcuts · / for commands
```

- **What it lists:** the version, lead model, folder and git branch, permission mode and sandbox,
  the instruction files read (names only; a long list is cut with "and N more"), MCP servers (how
  many, and that they are starting; their ready and failed lines follow as today), and how many
  hooks are in force. A row with nothing to show (no hooks, no MCP servers, no instruction files) is
  left out.
- **The drawing:**
  - **Pixel art** (option chosen, with an ASCII fallback): a blue Tachikoma in half-block characters,
    each character two pixels of colour, 48 columns by 15 rows. It is kept in `src/tui/art.ts` as a
    grid of letters, one per pixel (`B` blue, `S` shade, `W` white, `R` red, `.` empty), so it can be
    edited by hand.
  - **ASCII:** the user's `tachikoma.txt`, as drawn, where the terminal cannot show full colour or
    `NO_COLOR` is set.
  - **None:** where even the ASCII and the list do not fit side by side; the list alone shows.
  - The widths come from the drawings and the list's longest row, not a set number.
- **Where it lives:** in full screen, the first lines of the conversation (it scrolls away like any
  line); in classic, printed into the scrollback once. `-p` runs show none.

## 3. The rest of the audit (user: "use them all")

2. **Diffs in colour:** added lines green, removed lines red, each on a faint tint of its colour
   where the terminal has full colour.
3. **One path per edit:** the edit's row, its diff header and its "You allowed this." line name the
   file once, relative to the project; the full path stays in Ctrl+O.
4. **The permission question in a box:** a rounded box holding the question's title, the command or
   file, and any danger lines in red; the keys line under it is today's (`y` / `n` / Esc).
5. **Forms:** the answer field goes on its own line under the question (today
   `watch?BTCUSDT`).
6. **Status line:** parts that are zero or empty are left out (`0 errors`, `0 in / 0 out` before the
   first reply); labels dim, the model in the accent colour. When it is still too long, parts drop
   from the end in a set order instead of the line being cut with `…`.
8. **Key hints:** one wording everywhere: `↑↓ move · Enter open · Esc close` (verbs plain, no
   "-s"; each list keeps its own keys).
9. **The `/` menu:** descriptions start in one column, after the longest name shown.
10. **Ctrl+O:** tool inputs as `name: value` lines instead of JSON; empty `--- stderr ---` and
    `--- stdout ---` sections left out.
11. **`$0.00 + ?`:** see choice D below.

## 4. Colour and themes (points 12, 13)

- **One palette** in `src/tui/theme.ts`, used by every component instead of colour names written in
  each: accent (Tachikoma blue), text, muted (grey), success (green), error (red), warning (yellow),
  band, and the diff tints.
- **Light and dark (review; option chosen: "Setting, no asking"):** the band and the tints need
  different greys on a light background. A `theme` setting in the settings file picks them:
  `"auto"` (default), `"dark"` or `"light"`. `"auto"` reads `COLORFGBG`, which some terminals set
  to "foreground;background" colour numbers (a background of 7 or 15 means light, any other number
  dark), and is dark where it is not set, as on Windows Terminal. Nothing is sent to the terminal,
  so no answer can arrive in the prompt. The greys themselves are picked by eye with the user at
  the terminal check, on a dark and a light background.
- **Colour depth:** the pixel art and the tints need full colour; with 256 or 16 colours the art is
  the ASCII one and the tints are left out. The check is the one Ink itself uses, through chalk's
  own copy of supports-color (chalk 5.6, which Ink 7.1.1 depends on): full colour on Windows 10
  build 14931 or later, or with `COLORTERM=truecolor`, among other signs.
- **`NO_COLOR`:** set to anything non-empty, no colour at all (the band becomes plain rows, the art
  ASCII). Tachikoma checks it itself, as chalk's check reads only `--no-color` and `FORCE_COLOR`.

## 5. Markdown (PR 2)

- **Drawn:** headings (bold, accent), bold, italic, inline code (accent), bulleted and numbered
  lists (indented), block quotes (a grey bar), links (underlined text, the address after it in grey
  when it differs), code blocks (on the band colour, one colour, no highlighting; see choice B), and
  rules. Tables: drawn with box lines when they fit the width, else left as the raw text.
- **Only replies:** your messages, tool output and notices are never read as markdown.
- **Whole replies only (review):** a provider hands back a reply whole (`Provider.complete` returns
  the finished `Turn`), and nothing on screen arrives piece by piece today, so each reply is drawn
  as markdown once, when it arrives. Streaming is not part of this work.
- **Copying (review; option chosen: "What you see"):** a selection copies the text as drawn, as
  selecting in the terminal itself would: `**hello**` copies as `hello`, a table with its drawn
  borders. So the drawn lines are the lines kept, with their styles, and selection, search and
  copying work on them unchanged. `/export` keeps the raw markdown, from the saved messages.

## 6. Choices

The user chose the recommended option for all five on 2026-11-13 ("yes to all a to e").

A. **Markdown parser:** (recommended) the `marked` library's lexer, which only splits the text into
   pieces (headings, lists, code) and draws nothing; it has no dependencies of its own. Installed
   through sfw. Or: a small parser of our own, covering only the pieces listed above.
B. **Code blocks:** (recommended) one colour on the band, no syntax highlighting, for now. Or:
   highlighting, which needs a further library.
C. **When the start-up box shows:** (recommended) at launch only. Or: also after `/clear` and
   `/resume`, as a new session starts.
D. **`$0.00 + ?`:** (recommended) `$0.00+` in the status line, with the working line and the
   README saying "+ means some calls had no known price". Or: `$0.00 + unpriced`.
E. **`tachikoma.txt`:** (recommended) its drawing moves into `src/tui/art.ts` and the file at the
   project's top is deleted. Or: kept where it is.

## Testing

- Every component's own tests change their expected frames (spacing, markers); app.test.tsx runs
  only with `-t`, file by file.
- New tests: style runs across wrapped rows, selection and copying over a styled line, the band in
  both modes, the start-up box at 120, 80 and 50 columns and with `NO_COLOR`, the status line's drop
  order, the theme setting and `COLORFGBG` (light, dark, unset, malformed), and for PR 2 each
  markdown piece, and a selection over drawn markdown copying what is drawn.
- The 44 captures are made again after each PR and put side by side with today's.
- A terminal check with you for each PR: the band, the art and the colours on your dark terminal
  and, if you have one, a light one.

## Known limits

- **A light terminal that does not set `COLORFGBG`** (Windows Terminal among them) gets the dark
  look until `theme` is set to `"light"`.
- **Fonts without half-block or box-drawing characters** show the art and the box as gaps or
  boxes. No setting is added for that: the ASCII drawing is chosen by colour depth only, and
  `NO_COLOR` gives it on any terminal.
