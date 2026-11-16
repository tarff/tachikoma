# Tachikoma clickable links (OSC 8): Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to build this
> plan task by task: a fresh builder per task, then a spec review, then a code review.

**Goal:** every web address Tachikoma draws in the conversation can be opened with Ctrl+click in a
terminal that supports links. That covers replies (a markdown link's text and its address in
brackets, and bare addresses), your messages, tool output, notices, the detail view and the
permission question, in full screen and classic. With links on, an address is drawn in the palette's
blue. The text and the copy stay the same, and with links off nothing changes at all.

**Architecture:**
- **A link is a span.** `Span` (describe.ts) gains `link?: string`, the address to open. The text
  stays plain, so wrapping, selecting, searching and copying are untouched, as with every other
  style (TUI design pass, Architecture, "Styled lines"). Only drawing reads the new field.
- **Two places make link spans.** markdown.ts puts one on a link's text and one on its bracketed
  address. `screen()` (describe.ts), which every conversation line already passes through, adds one
  for each bare address it finds in the escaped text, using marked's own GFM address rule, and
  skips any address already inside a link span.
- **One place draws them.** `runs()` and `Run` (Conversation.tsx) wrap a linked run's text in the
  OSC 8 escape when the look says links are on, and draw it in the accent blue when the look has
  colour. Ink then measures, wraps and cuts the escaped text correctly (see "What Ink does with
  OSC 8" below). The permission question, drawn by App.tsx outside the conversation, uses the same
  helper (Task 5).
- **One check decides whether links are on:** `hyperlinks()` in a new `src/tui/links.ts`. It
  reads `FORCE_HYPERLINK` as Claude Code 2.1.323 reads it, then follows Claude Code's list. The
  result goes into `Look` as `links?: true`, set once at launch in cli.tsx.

**Tech stack:** as PR #21 (Ink 7.1.1, React 19, chalk 5.6.2, marked 18.1.2, Vitest 5.0.3,
ink-testing-library 4.0.0). No new dependency: Tachikoma writes the OSC 8 escape itself, as
`ansi-escapes` 7.3.0's `link()` has no `id=` parameter.

---

## Before you start

**How this plan is built.** As earlier plans: each task gives the files, the behaviour and the
tests, and each test says what it must show. A builder writes the tests first and sees them fail,
then the code, then commits. A spec reviewer and then a code reviewer check the commit before the
next task starts. One PR, Tasks 1-6.

**Stop for the user:** Task 6's terminal check, in the user's own Windows Terminal. The README's new
words are approved by the user before Task 6's commit.

**The branch.** A local branch `links` from main (3236440 or later). Do not push: every push needs
the user's say-so. Main takes changes only by pull request with CI's `test` check passing.

**Checks, from the repo's folder:**
- Types: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
- One file: `node node_modules/vitest/vitest.mjs run tests/tui/links.test.ts`
- The App's tests, only with `-t`:
  `node node_modules/vitest/vitest.mjs run tests/tui/app.test.tsx -t "<describe name>"`. Never run
  the file whole for a task.
- The full suite once, at the end of Task 6, with `--exclude tests/tui/external.test.ts`, which
  must never run. Time-outs under load: rerun those files alone.

**Rules every builder follows:**
- No registry fetch (npm/npx install, curl of a package) at all; this plan adds no dependency.
- Delete only files you made, by exact name. Never change permissions.
- No real model calls in tests; the tests' fake providers only.
- Edit with the Edit tool, not `sed -i` (the working copy is CRLF). Rewrap only lines you changed.
- Comments follow the file's style: they say what and why, with this plan's task.

---

## The user's decisions (final)

1. **Switch:** only the variable `FORCE_HYPERLINK`. No settings.json entry, no flag. The words mean
   what they say: `false`, `no`, `off` and `0` turn links off, matched to Claude Code 2.1.323 (the
   exact rule is under "Detection" below). Unset or empty means detect; anything else turns them on
   (the user's answer, 2026-11-16, to the plan's first open question).
2. **Detection:** Claude Code's list, verified against its bundle and supports-hyperlinks' source
   (below). Output that is not a terminal (not a TTY) gets no links unless forced.
3. **Schemes:** `http://`, `https://`, and bare `www.` (opened as `https://www.…`). Never `file:`,
   never `mailto:`, nothing else. Plain text finds addresses with marked's GFM address rule, so
   replies and plain text agree. Addresses inside inline code and code blocks are links too.
4. **Brackets stay:** a markdown link still shows `text (url)` (README "### Replies as markdown").
   With links on, the text and the address inside the brackets open the same address. The `(` and
   `)` are not part of the link.
5. **Blue, with links on:** a markdown link's text is blue and still underlined. The address inside
   the brackets is blue instead of grey, and the brackets stay grey. A bare address is blue, not
   underlined. An address in a line with its own colour, such as a red error, is blue too (the
   user, 2026-11-16). With links off, today's look is unchanged. Without colour (`look.color` false) there
   is no blue, but links still work (decision 8).
6. **Where:** the conversation, the detail view, and the permission question, including an MCP
   server's "open this address" question. The status line, the live row, menus, the `/resume` and
   `/mcp` lists, the review screen and `[`'s print-out stay plain.
7. **Different address in the text:** `[https://a.example](https://b.example)` opens `b.example` from
   its text too. The bracket always shows the real address.
8. **No colour:** in Windows Terminal, links stay on with `NO_COLOR` or `TERM=dumb`, as Claude Code's
   do (its `WT_SESSION` step does not look at colour).

---

## What was found

### Detection: the sources

**Claude Code 2.1.323** (`C:\Users\timel\.local\share\claude\versions\2.1.323`, the file
`claude.exe` runs; read as text with a scratch Node script, around byte 322,486,728):
- It bundles a copy of supports-hyperlinks whose checks, in order, are: `FORCE_HYPERLINK`; the
  `--no-hyperlink(s)` / `--hyperlink=…` command-line flags; `NETLIFY` → yes; no colour → no; not a
  TTY → no; `WT_SESSION` set → yes; then, in the Windows build, `return false`. The checks after
  that (iTerm, WezTerm, vscode, ghostty, `TERM=alacritty`) are still in the file but cannot be
  reached: the Windows check was folded into a plain `return!1`.
- Its own function after that (minified `cw`), which still runs on Windows:
  1. a settings value `hyperlinks`, then `FORCE_HYPERLINK` (empty → no decision; `false`, `no`,
     `off` or a number parsing to 0 → off; anything else → on);
  2. the supports-hyperlinks copy above, for stdout → yes if it says yes;
  3. `TERM_PROGRAM` in `["ghostty","Hyper","kitty","alacritty","iTerm.app","iTerm2","WarpTerminal"]`
     → yes;
  4. `TERMINAL_EMULATOR === "JetBrains-JediTerm"` → yes;
  5. `WT_SESSION` set, `TERM_PROGRAM` not `tmux` and `TMUX` unset → yes;
  6. `TERM_PROGRAM === "tmux"` with `TERM_PROGRAM_VERSION` major > 3, or 3 and minor ≥ 4 (each
     `parseInt` of the parts split at `.`) → yes;
  7. `LC_TERMINAL` in the same list as step 3 → yes;
  8. `TERM` containing `kitty` → yes;
  9. otherwise no.
- Its changelog in the same file (around byte 326,674,962): "Changed `FORCE_HYPERLINK=false` (also
  `no` and `off`) to turn hyperlinks off instead of on". So Claude Code no longer reads the variable
  as supports-hyperlinks does.
- **How it reads `FORCE_HYPERLINK`** (minified `t7e`, just before `cw`): `if(!s)return;` (unset or
  empty: no decision) then `return!(ps(s)||parseInt(s,10)===0)`. The chunk imports `ps` from
  `chunk-3931gpz1.js`. That chunk exports `aye,Pe,ps,vk,Ne,Plt`, and its one `ps` (around byte
  304,777,389) is `if(e===void 0)return!1; … let n=String(e).toLowerCase().trim();
  return["0","false","no","off"].includes(n)`. So:
  - unset or `""` → not forced, detect;
  - off when the value, lower-cased with spaces trimmed at both ends, is `0`, `false`, `no` or
    `off` (any letter case: `FALSE`, `Off`, ` no `), or when `parseInt(value, 10)` is 0 (`00`,
    `0abc`, ` 0`, `-0`);
  - on for anything else (`1`, `2`, `true`, `yes`, `on`, `nope`, and a value of spaces only, which
    is not empty, trims to no listed word and parses as `NaN`).
  - Before the variable, `t7e` reads a settings value `hyperlinks`; Tachikoma leaves that out
    (decision 1).
- **Compared with the earlier research:** steps 7 and 8 (`LC_TERMINAL`, `TERM` containing `kitty`)
  were missing from it. "On the Windows build everything else is an unconditional no" holds only for
  the supports-hyperlinks copy; Claude Code's own steps 3-8 still run on Windows. The old console
  window (conhost) sets none of those variables, so it still gets none.

**supports-hyperlinks**, read on GitHub:
- `v3.2.0/index.js` (CommonJS, export `supportsHyperlink`) matches the bundled copy check for check,
  in the same order. The bundle carries no version number, so "v3.2.0" means "the same code as". On
  other systems, past the Windows check, it says: `CI` or `TEAMCITY_VERSION` set → no;
  `TERM_PROGRAM` `iTerm.app` with version 3.1 or later; `WezTerm` with version ≥ 20200620;
  `vscode` with version 1.72 or later; `ghostty`; then `VTE_VERSION` 0.50 or later, but not exactly
  `0.50.0` ("throws a segfault"); then `TERM=alacritty`; otherwise no.
- `FORCE_HYPERLINK` in v3.2.0 and in main (5.0.0): `if (FORCE_HYPERLINK) return
  !(FORCE_HYPERLINK.length > 0 && parseInt(FORCE_HYPERLINK, 10) === 0)`. So: unset or empty → not
  forced, detect as usual. Any other value → off if `parseInt(value, 10)` is 0, otherwise on. `0`,
  `00`, `0abc` and ` 0` are off; `1`, `2`, `yes`, `true`, `false`, `no`, `off` are on (`parseInt`
  gives `NaN` for words). Main's comment says the partial parse is on purpose ("`FORCE_HYPERLINK=0abc`
  would go from disabled to enabled" with `Number()`). Claude Code keeps this partial parse and adds
  the four words (above). Tachikoma follows Claude Code (decision 1).
- Main (5.0.0) has added terminals since (zed, Orca, WarpTerminal, herdr, Cursor, `TERM=xterm-kitty`,
  Nix WezTerm versions). This plan copies what Claude Code bundles, not main.

### What Ink does with OSC 8

All files are under `node_modules/`.
- **Ink keeps the escape:** `ink/build/squash-text-nodes.js:33` passes a Text's string through
  `sanitize-ansi.js`, which keeps OSC sequences (`sanitize-ansi.js:4-5, 13`); `ansi-tokenizer.js:114-115`
  reads `ESC ]` as OSC with BEL allowed as its end.
- **Width:** Ink measures with `widest-line` (`measure-text.js:14`) and `string-width` 8.3.0
  (`output.js:19`), which strips with `strip-ansi` 7.2.0 / `ansi-regex` 6.4.0. Its OSC pattern
  (`ansi-regex/index.js:3,7`) ends at BEL, `ESC \` or 0x9C. Measured: a 47-character address
  wrapped in a link measures 47 with either ending.
- **Drawing cell by cell:** `output.js:147` tokenizes each row with `@alcalzone/ansi-tokenize`
  0.3.1, which keeps an OSC 8 open as a style on each cell (`tokenize.js:138-148`) and closes it by
  its matching end code (`ansiCodes.js:20-33`, `reduce.js` filters by end code).
  `styledCharsToString` (`styledChars.js:20-36`) reopens and closes per row (`output.js:199`).
  Each row of output therefore carries its own open and close.
- **Classic wrapping:** `wrap-text.js:12` calls `wrap-ansi` 10.0.2, which closes a link before each
  row break and reopens it after with the same parameters (`wrap-ansi/index.js:482-545`;
  `activeHyperlink` keeps `parameters`, line 513). It reopens with a **BEL** ending
  (`wrapAnsiHyperlink`, line 59).
- **Cutting:** truncate-end goes through `cli-truncate` 6.1.1 → `slice-ansi` 9.0.1, which closes a
  cut link (`slice-ansi/index.js:35-153`). Ink's clipping uses `sliceAnsi` too (`output.js:121`).

**Measured** (scratchpad `osc8probe.mjs` and `osc8probe2.mjs`, Ink's `renderToString`):
- **Surprise 1: the ending must be BEL, not ST (`ESC \`).** With ST, a link wrapped in classic ran
  on past its end to the end of its last row: `wrap-ansi` reopened it with BEL, and
  ansi-tokenize then paired our ST close with nothing (`reduce.js` drops only codes whose end code
  matches), so the words after the link were inside it. With BEL throughout, each of three wrapped
  rows had `ESC]8;id=t1;<url>BEL … ESC]8;;BEL`, the same `id`, and the text after the link was
  outside it.
- **Surprise 2: a line break inside one link's text loses the link after it.** `wrap-ansi` splits
  at line breaks before it reads escapes (its comment, line 36), so `open + "a\nb" + close` gave a
  link on `a` only. Classic's `Printed` puts its own line breaks into a line's text in two cases. At
  a space that ends a row unseen (`edgeBroken`, view.ts; Conversation.tsx `chars`), which a markdown
  link's text can hold. And between the rows of a band line with tabs (`rowsAt`). So each line of a
  linked run gets its own open and close (Task 3).
- Cut with `truncate-end`: the link closes before the `…`, which is outside it.
- Two links side by side, and a link on a Box's background, came out as expected.

### How Tachikoma draws today

- **Every conversation line passes through `screen()`** (describe.ts:67): `say()` (app/output.ts:22),
  notes (output.ts:41), folds opened (app/mouse.ts:222), the live row (App.tsx:609), the detail
  view (DetailView.tsx:28). It escapes control characters with `visible()` (core/permissions.ts:65)
  run by run and maps each span to the escaped text. `-p`'s answer (clilib.ts:53, `headlessAnswer`)
  and `prose()` (clilib.ts:44, `screen(...).text`) take text only, as do Review.tsx:68 and
  SessionList.tsx:33, so a new span there changes nothing they print.
- **Full screen:** `Rows` (view.ts:265) keeps lines split at line breaks (`keptOf`, view.ts:216),
  each with its spans by offset. `row()` (view.ts:321) gives a row's `line`, offsets and `styles`.
  `Conversation` (Conversation.tsx) draws a row through `marked()` (line 86), which returns null for
  a row with no span, and `runs()` (line 119), which joins characters of equal style. `STYLE` (line
  110) lists the fields compared. `Run` (line 158) is a `Text` with the style's props. The rows come
  wrapped already, so Ink only cuts (`truncate-end`). The detail view draws with the same
  `Conversation` and its own `Rows`.
- **Classic:** `<Static>` prints each said line once as `<Printed key={l.id} line={l} …/>`
  (App.tsx:867-868), `l.id` from `ui.nextId` (output.ts:29). `Printed` (Conversation.tsx:193) uses
  `runs()` when the line has styles (line 261), and Ink wraps the text (`wrap="wrap"`).
- **Markdown links** (markdown.ts:62-73): the text underlined; the address after it in muted
  brackets unless it is an autolink or equals the text. An autolink's text is the address as
  written; marked's `href` adds `http://` to a `www.` address (marked's `src/Tokenizer.ts`, `url()`,
  read from `marked.esm.js.map`).
- **marked's GFM address rule** is public: `Lexer.rules.inline.gfm.url` and `._backpedal`
  (`src/Lexer.ts:73`, `src/rules.ts:582-587`), checked at run time from `marked`'s export.
  `url()` (`src/Tokenizer.ts:1079-1112`) applies `_backpedal` until it stops changing, which drops
  trailing punctuation but keeps balanced brackets. Measured: `https://example.com/a_(b)).` gives
  `https://example.com/a_(b)`, and `www.foo.com,` gives `www.foo.com`. The rule also matches `ftp://`
  and e-mail addresses, which this plan drops (decision 3). Its alternatives start at `mailto:`,
  `xmpp:`, `http(s)://` or `ftp://` (any letter case), `www.`, or an e-mail's name before its `@`
  (`src/rules.ts:518-520, 582-585`). The whole token has to be taken before it is dropped (the
  review's finding 1, checked with scratchpad `urlprobe.mjs` against `marked.lexer`):
  `help@www.example.org` is one e-mail token, and `ftp://www.example.org` one ftp token. A scan
  that starts only at `http(s)://` or `www.` loses that and finds `www.example.org` in both, which
  would open `https://www.example.org`. The same goes for `mailto:a@www.b.com`, `xmpp:a@www.b.com/r`,
  `a!b@www.c.com` and `FTP://www.q.r`.
- **A scheme alone passes marked's link rule** (the review's finding 3, checked in the same probe):
  `[docs](https://)`, `[d](http://)` and `[d](https://:80)` are links with those `href`s. Node's
  `URL` rejects all three (`URL.canParse` false). It accepts `https://x.y`, `https://[::1]/` and
  `https://%C3%A9xample.com` (host `xn--xample-9ua.com`), and also `https:x.y`, which has no `//`.
- **Copying** takes the kept lines' plain text (`textOf(ui.pane().rows.lines, …)`, app/mouse.ts:42),
  never what was drawn, so a copy has no escapes in either mode.
- **Ctrl+click:** the TUI pass's check (its plan, "As built", Task 17, `link-test.mjs`) found
  Ctrl+click opens an OSC 8 link in the user's Windows Terminal with full screen's mouse capture on,
  so Tachikoma needs no click handling of its own.
- **Tests** draw with ink-testing-library and read `lastFrame()`. Escapes are compared raw
  (conversation.test.tsx:46-62; app.test.tsx:3329, "App's replies as markdown") or stripped with
  `stripVTControlCharacters`. Tests get the context's look unless they give one
  (`ThemeContext`, theme.ts:100; app.test.tsx `themed`, line 358).
- **The palette's blue** is `accent` (theme.ts:48-67, 72-83): `#4278de` in full colour in both the
  dark and the light look (the same value; theme.ts:50 and 60), `"blue"` with fewer colours, and
  none without colour. Headings (markdown.ts:206, bold), inline code (markdown.ts:57-58), the `● `
  of replies and calls (describe.ts:194, 215, 258) and the status line's lead and branch
  (StatusLine.tsx:86, 106) use it. No other blue is in the palette.
- **The permission question** is drawn by App.tsx in a rounded box (App.tsx:917-958), not by
  `Conversation` or `Printed`:
  - full screen: its rows come from the frame (layout.ts:194, `linesOf` = view.ts's `wrap(text,
    columns - 4, false)`, keeping only each row's `text`) as `f.asked` (layout.ts:226), each a
    `<Text color={warning} wrap="truncate-end">`; its grey note (`f.noted`) and red lines
    (`f.warned`) are a row each, cut by Ink;
  - classic: the note, each red line and the question line are each one `<Text>`, wrapped by Ink,
    the line as `edgeBroken(allow(ui.question.text, …), ui.columns - 4)` (App.tsx:951), whose line
    breaks fall only at spaces (view.ts, `edgeSpaces`), never inside an address;
  - its text is `allow(…)` (App.tsx:695-703) of `ui.question.short ?? ui.question.text`
    (App.tsx:737), escaped by whoever asked. An MCP server's sign-in question (mcp/forms.ts:189)
    holds the address as `shown(form.url)`, `visible(text, { tabs: true })` (forms.ts:41), so it
    can hold a tab.
  - The address an MCP sign-in prints while it waits (mcp/auth.ts:326, `io.say`) goes to the
    conversation as a line, so it is linked with the rest.

### The OSC 8 format

From the spec (gist egmontkob/eb114294efbcd5adb1944c9f3cb5feda):
- The form is `ESC ] 8 ; params ; URI ST`. "Often the BEL (`\a`) character is used instead" of ST.
- `params` is `key=value` pairs separated by `:`, so a value cannot hold `:` or `;`.
- "Character cells that have the same target URI and the same nonempty `id` are always underlined
  together on mouseover." Apps should give an `id` so a link stays one link across a line break.
- "The parameters and the URI must not contain any bytes outside of the 32–126 range. Bytes
  outside of this range in the URI must be URI-encoded."
- "Both VTE and iTerm2 limit the URI to 2083 bytes."

---

## The design

### `src/tui/links.ts` (new; Tasks 1-2)

- `hyperlinks(env, tty, level, platform = process.platform): boolean`. `level` is chalk's, which
  cli.tsx already passes to `themeOf` (cli.tsx:216, 890).
  1. `FORCE_HYPERLINK` non-empty: off when `value.toLowerCase().trim()` is `0`, `false`, `no` or
     `off`, or `parseInt(value, 10) === 0`; on otherwise (Claude Code 2.1.323's `t7e` and `ps`,
     above). Unset or empty: go on.
  2. Not a TTY: no (decision 2).
  3. The supports-hyperlinks copy, without its command-line flags (decision 1): `NETLIFY` → yes;
     `level === 0` → no (its colour check; chalk's level stands in for supports-color, as Tachikoma
     has no other); `WT_SESSION` in env → yes; `platform === "win32"` → go to step 4; `CI` or
     `TEAMCITY_VERSION` → go to step 4; `TERM_PROGRAM` `iTerm.app` (3.1+), `WezTerm` (≥ 20200620),
     `vscode` (1.72+), `ghostty` → yes; `VTE_VERSION` ≥ 0.50, not `0.50.0` → yes; `TERM=alacritty`
     → yes. A "no" in this step is not final: it goes on to step 4, as Claude Code's `cw` only
     returns early on a yes. `parseVersion` is copied as v3.2.0 has it (a 3-4 digit value such as
     `4601` reads as 0.46.1).
  4. Claude Code's own list, steps 3-8 above.
  5. Otherwise no.
- `target(shown: string): string | null`, the address a link opens, from the text as drawn:
  - null unless it starts with `http://` or `https://` (any letter case) or `www.`;
  - `www.…` becomes `https://www.…` (decision 3);
  - null for text that is not well formed (`isWellFormed()`: a lone surrogate, which
    `encodeURIComponent` throws on);
  - each character outside 32-126 is replaced by `encodeURIComponent` of it (the spec);
  - null unless the result is an absolute address with a host: `new URL(result)` parses (no
    throw; `URL.canParse`), its `protocol` is `http:` or `https:`, and its `hostname` is not empty.
    So `https://`, `http://` and `https://:80` get no link (finding 3). The text drawn is unchanged
    either way, and the link opens the encoded text itself, not `URL`'s rewrite of it. The `//`
    check above stays, since `URL` alone takes `https:x.y`;
  - null if the result is over 2083 bytes (the spec's VTE and iTerm2 limit).
  This one rule decides every link: bare addresses (`urls()`), markdown links, and the question's.
- `urls(text: string): { start: number; end: number; link: string }[]` takes each whole token as
  marked does, then filters (finding 1). A global search for the rule's own starts,
  `/mailto:|xmpp:|(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.|(?<![A-Za-z0-9._+-])[A-Za-z0-9._+-]+@/g`,
  finds the leftmost place one could begin. The lookbehind `(?<![A-Za-z0-9._+-])` lets an e-mail's
  name start only where a run of name characters starts, so each run is read once (second review,
  finding 1). Without it, a run with no `@` is read again from each of its characters. Measured
  (scratchpad `scanprobe.mjs`, Node 24.22.1 on this machine), one run of letters with no `@`:
  - without the lookbehind: 10,000 letters 47 ms, 20,000 145 ms, 40,000 585 ms, four times as long
    for each doubling;
  - with it: 40,000 letters 0 ms, 1,000,000 letters 3 ms;
  - about 1 MB of words with no address: 5 ms; 20,000 addresses in 348,889 characters: 6 ms.

  The lookbehind changes no answer: all 15 probe strings (the earlier 12, `xwww.a@b.com` and the
  two of finding 2) gave the same links with it and without. `Lexer.rules.inline.gfm.url` runs on
  the text from there:
  - no match: go on one character later;
  - a match: the whole token is taken, backpedalled as marked's `url()` does unless it is an e-mail
    (`cap[2] === "@"`), and the search goes on from its end. It becomes a link only when it is not
    an e-mail, has a `cap[1]` (so not `mailto:` or `xmpp:`), is not `ftp://`, and `target()` gives
    an address.

  So `help@www.example.org` and `ftp://www.example.org` make no link at all. In the probe this agreed
  with `marked.lexer` on all 12 test strings, keeping only its http, https and `www.` links. Like
  marked's text rule, it finds an address inside a word (`foohttps://a.b` gives `https://a.b`).

  **Scanned with links off too.** `screen()` stays pure, and none of its callers, in seven files
  (app/output.ts, app/mouse.ts, App.tsx, DetailView.tsx, clilib.ts, Review.tsx, SessionList.tsx),
  has to be handed the look. Unused spans draw nothing: with links off, a run whose only style is a link is the same
  plain `Text`. The scan costs about 3 ms a megabyte of text with no address (above), once per line
  said. Skipping it when links are off would save that, and cost a flag through every caller.
  **Known limit, marked's own:** an address followed by a long run of `!` (or other trailing
  punctuation) is slow to trim, as marked's `_backpedal` loop takes time growing with the square of
  the run. Measured (`scanprobe2.mjs`): 2,000 `!` 1 ms, 4,000 4 ms, 8,000 14 ms. marked takes the same
  time on a reply. A run of `(`, of `.x`, of `a@` or of `www.` took 0 ms at 8,000.
- `linked(url: string, id: string, text: string): string`. Each line of `text` is wrapped in
  `ESC]8;id=<id>;<url>BEL` … `ESC]8;;BEL` (BEL: Surprise 1; per line: Surprise 2). An empty line
  gets no wrapping.

### Where spans come from (Tasks 2-3)

- `screen()`: after escaping, `urls()` over the escaped text. Each address not overlapping a span
  that has a `link` field (any value, `""` included) becomes a span `{ start, end, link }`, added
  after the line's spans. So a line screened twice gets no second set, and a markdown link's own
  spans win. The address opened is the text drawn, so it never differs from what the user sees.
- markdown.ts, every `link` token: a `{ link }` span goes over the link's drawn text and another
  over the address inside the brackets, not the brackets themselves (decision 4). Its value is
  `target()` of the escaped text the bracket shows (`escape(link.href)`), or of the token's text for
  an autolink (so `www.x.y` opens `https://www.x.y`, not marked's `http://`). Where `target()`
  refuses it, the value is `""`, which means handled and not a link. It draws no escape and no blue,
  and `screen()`'s pass leaves the range alone (second review, finding 2). Without it,
  `[local](file:///www.example.org)`, drawn `local (file:///www.example.org)`, had its
  `www.example.org` found by the bare pass and linked to `https://www.example.org` (`scanprobe.mjs`:
  a link at offset 15). These spans are separate from the underline and muted ones, so the existing
  spans are unchanged. `mailto:`, `file:`, relative and other addresses get no link.
- Addresses inside inline code and code blocks get links from `screen()`, as everything on screen
  does (decision 3).
- The permission question is not a `Line`. Its links come from `urls()` over its text, where it is
  drawn (Task 5).

### Drawing (Task 3)

- `Look` gains `links?: true`. `look(settings, env, level, tty = false)` sets it where
  `hyperlinks(env, tty, level)` says yes. `themeOf` passes `tty` through. cli.tsx passes
  `process.stdout.isTTY === true` at both calls. The context's default look has none, so every
  existing test draws as today.
- `STYLE` gains `"link"`. `runs(chars, spans, key)` also keeps, for the span giving a run its
  `link`, that span's `start`. The run's id is `` `${key}-${start}` ``, digits and `-` only, so
  never `:` or `;`.
- **The `…` of a cut one-line entry is never linked** (the review's finding 2). In full screen,
  view.ts cuts the row itself before Ink sees it. `drawn()` (select.ts:38-41) gives its `…` the
  offset of the first character left out, marked `cut: true`, so the span lookup in `runs()` would
  put it inside a link that reaches past the cut. `marked()` (Conversation.tsx:86) already reads
  `c.cut` for the selection. It passes `cut` on to `runs()`, which gives a cut character no `link`,
  so no escape and no blue, its other styles kept. In classic, Ink cuts with `cli-truncate`, which
  puts the `…` after the link's close (measured, `osc8probe.mjs`). There the `…` keeps the run's
  other styles (the probe's underline ran on over it), as any styled run cut there does today,
  including the run's colour. With links on, that means a `…` after a cut address is blue but not a
  link (Task 3's tests say so).
  - **Full screen:** `key` is the row's `line` (its kept line). The kept line's spans are the same
    on each of its rows, so a wrapped address has the same id on every row, each row with its own
    open and close.
  - **Classic:** `Printed` takes a new `at` prop, the said line's `id` (App.tsx passes `l.id`;
    default 0 for tests), as `key`. Ink's `wrap-ansi` reopens the link on each wrapped row with the
    same `id`.
- `Run`: with `look.links` and `style.link`, its text is `linked(style.link, id, text)`. Otherwise
  nothing changes. With links off, a run whose only style is a link draws as the same plain `Text`.
- **The blue (decision 5):** with `look.links` and `look.color`, a run with `style.link` is drawn in
  `palette.accent`, over any colour its spans or its line give it; its other styles stay. So:
  - a markdown link's text: blue, and still underlined (its underline span);
  - the address in brackets: blue, its link span over the muted one; the `(` and `)` outside the
    link span stay muted;
  - a bare address: blue, with no underline, as it has no underline span;
  - an address inside inline code: the code is already `accent`, so it looks the same as the code
    around it, only clickable. It is not visibly different, which the user said is acceptable;
  - in a code block, on the band: blue on the band;
  - in a heading: the heading's bold blue, so no visible change;
  - in a line with its own colour, such as a red error, a green or red diff line, or the question's
    yellow line: the address is blue inside it.

  **Why `accent`:** it is the palette's only blue (theme.ts:48-67), the one headings and inline
  code already use. It has a light-look value (the same `#4278de`) and a named fallback
  (`"blue"`). It needs no new token and no new value to set by eye. With links off,
  or `look.color` false, the colour is left as today. Without colour the escapes are still written
  (decision 8).
- The helper for text that is not a `Line` (Task 5): `Linked({ text, links })` in
  Conversation.tsx. `links` is `{ start, end, link, id }[]`, each fragment carrying its own id. It
  draws the string with those ranges as `runs()` does (blue and escaped as above), and is plain text
  with links off.
- Ids are unique within a pane: line index and offset in full screen, line id and offset in
  classic, `q-<offset in the question's line>` (and `qn-`, `qw<line>-` for its note and red lines)
  in the permission question. They use letters, digits and `-` only, so never
  `:` or `;`. Two links sharing an id would also need the same address to be grouped (the spec), so
  a clash between panes never on screen together is harmless.

### Not changed

- `/export` (raw markdown), `-p`'s output (`headlessAnswer`, clilib.ts:53), `prose()`, saved
  sessions, the model's input.
- With links off: what is drawn. Markdown links keep their underline and grey address; bare
  addresses stay plain.
- Places outside the conversation, the detail view and the permission question (decision 6): the
  status line, tool line, hint row, prompt while typing, the live row (drawn as a plain `Text`,
  App.tsx:965-968), menus, `/resume` and `/mcp` lists, the review screen, `[`'s print-out
  (handover.tsx:61-66).
- Double-click's word rule for addresses (select.ts:77 `LINK`, `http(s)://` only, its own
  punctuation rule) is left as it is. It differs from marked's rule (`www.`, brackets), but the
  user chose it at release 5 (select.ts:94-96). Mentioned, not changed.

---

## Numbers in this plan

None is invented.
- Versions in detection (iTerm 3.1, WezTerm 20200620, vscode 1.72, VTE 0.50 / not 0.50.0): from
  supports-hyperlinks `v3.2.0/index.js`.
- tmux 3.4: from Claude Code 2.1.323's `cw`.
- 32-126 (the bytes allowed in the URI) and 2083 (the URI's byte limit in VTE and iTerm2): from the
  OSC 8 spec gist.
- The four off words (`0`, `false`, `no`, `off`): from Claude Code 2.1.323's `ps`.
- `#4278de`, the links' blue: the palette's `accent` in both looks (theme.ts:50, 60), not a new
  value.
- Byte offsets into Claude Code's file: where the scratch search found the code, for finding it
  again.

---

## Task 1: Whether links are on

**Files:** create `src/tui/links.ts` (`hyperlinks`); change `src/tui/theme.ts` (`Look`, `look`,
`themeOf`), `src/cli.tsx` (both `themeOf` calls); tests `tests/tui/links.test.ts`,
`tests/tui/theme.test.ts`.

**Tests first** (`hyperlinks` with an env object, `tty`, `level`, `platform` given):
- `FORCE_HYPERLINK` (decision 1, Claude Code's `t7e` and `ps`):
  - on, even with `tty: false` and on `win32` with nothing else set: `"1"`, `"2"`, `"true"`,
    `"yes"`, `"on"`, `"nope"`, `"   "` (spaces only);
  - off, even with `WT_SESSION` set: `"0"`, `"00"`, `"0abc"`, `" 0"`, `"-0"`, `"false"`, `"FALSE"`,
    `"no"`, `"No"`, `"off"`, `" Off "`;
  - `""`: as unset (Windows Terminal on, a bare win32 env off).
- Not a TTY, not forced → off, with `WT_SESSION` set.
- `win32`: `WT_SESSION` → on; none of the variables (the old console) → off; `TERM_PROGRAM=vscode`
  `TERM_PROGRAM_VERSION=1.90.0` → off (the Windows build returns before it);
  `TERM_PROGRAM=WezTerm` → off; `TERM_PROGRAM=ghostty` → on (step 4).
- `linux`: vscode `1.71.0` off, `1.72.0` on, `2.0.0` on; iTerm.app `3.0.0` → on (it is in step 4's
  list, whatever the version); WezTerm `20200619` off, `20200620-160318-e00b076c` on; `VTE_VERSION`
  `0.50.0` off, `5001` on (`5001` reads as 0.50.1), `0.49.0` off; `TERM=alacritty` on;
  `CI=1` with `TERM_PROGRAM=vscode` 1.90.0 → off, but `CI=1` with `TERM_PROGRAM=kitty` → on (step 4);
  `level: 0` with vscode 1.90.0 → off, `level: 0` with `WT_SESSION` → on.
- Step 4 items one by one: each `TERM_PROGRAM` in the list; `LC_TERMINAL=iTerm2`;
  `TERMINAL_EMULATOR=JetBrains-JediTerm`; `TERM=xterm-kitty`. `WT_SESSION` with `TMUX` set on
  `linux`: on at `level: 3` (step 3's `WT_SESSION` check does not look at tmux), off at `level: 0`
  (step 3 stops at the colour check, and step 4 skips `WT_SESSION` inside tmux). With no
  `WT_SESSION`, `TERM_PROGRAM=tmux` version `3.3a` → off, `3.4` → on, `4.0` → on.
- `look(…, tty)`: `links: true` where `hyperlinks` says yes; no `links` field where it says no, so
  the existing `toEqual`s in theme.test.ts still pass unchanged.

**Implementation:** as "The design". Comments cite Claude Code 2.1.323 (`t7e`, `ps`, `cw`) and
supports-hyperlinks v3.2.0 by step. cli.tsx passes `process.stdout.isTTY === true` to both `themeOf` calls (216, 890).

**Run:** `node node_modules/vitest/vitest.mjs run tests/tui/links.test.ts tests/tui/theme.test.ts`,
then types.

**Commit:** `feat: links: whether the terminal takes OSC 8 links (FORCE_HYPERLINK, Claude Code's list)`

## Task 2: Finding addresses, and the spans for them

**Files:** `src/tui/links.ts` (`target`, `urls`, `linked`), `src/tui/describe.ts` (`Span.link`,
`screen`); tests `tests/tui/links.test.ts`, `tests/tui/view.test.ts` (or wherever `screen` is tested
today: `grep -l "screen(" tests/tui`).

**Tests first:**
- `target`: `https://x.y` and `HTTP://x.y` as they are; `www.x.y/a` → `https://www.x.y/a`;
  `ftp://x`, `file:///c:/x`, `mailto:a@b.c`, `./a`, `javascript:x` → null; `https://de.wikipedia.org/
  wiki/Straße` → `…Stra%C3%9Fe`; a lone surrogate → null; 2083 bytes → kept, 2084 → null.
  No host (finding 3): `https://`, `http://`, `https://:80`, `HTTPS://` → null; `https:x.y` → null
  (no `//`); `https://[::1]/` → kept.
- `urls`, each with marked's own answer beside it (`marked.lexer` of the same text, its link
  tokens' text, kept where they are http, https or `www.`), so the two cannot drift:
  `see https://example.com/a_(b)). ok`; `www.foo.com, and http://x.y/z?.`; `foohttps://a.b`;
  `x.www.foo.com`; `http://user@www.x.com`; `(https://x.y)`; `"https://x.y/'a'"`; two addresses on
  one line; an address at the very end of the text. None for each of these (finding 1):
  `help@www.example.org`, `ftp://www.example.org`, `FTP://www.q.r`, `mailto:a@www.b.com`,
  `xmpp:a@www.b.com/r`, `a!b@www.c.com`, `a@b.c`, `www.@x.com`. `a.b@c www.d.e` → `www.d.e` only.
- `urls` on long lines with no address (second review, finding 1): 200,000 letters with no `@`, and
  five such runs with spaces between (1,000,004 characters), each give no link in under 500 ms. The
  fixed scan took 1 ms and 3 ms here. Without the lookbehind, 200,000 letters would take about
  15 s, from the four-times-per-doubling growth measured up to 40,000 (585 ms). So the bound fails
  a return of the slow scan many times over and leaves a slower CI machine room. Timed with
  `performance.now()` around the call.
- `linked`: one line → `ESC]8;id=7-0;https://x.yBEL` + text + `ESC]8;;BEL`; `"a\nb"` → each line
  wrapped on its own; `"a\n\nb"` → the empty line bare.
- `screen`: `{ text: "go to https://x.y now" }` gains `styles: [{ start: 6, end: 17, link:
  "https://x.y" }]`; a line with an existing span keeps it, the link span after; a line whose
  address is already in a `link` span gets no second one; `screen(screen(l))` equals `screen(l)`; an
  address after a control character escaped by `visible()` has offsets into the escaped text; a
  line with no address is returned exactly as today (no `styles` key added). A span with `link: ""`
  over `www.example.org` keeps `screen()` from adding one there.

**Implementation:** as "The design". `Span` gains `link?: string // the address a Ctrl+click opens
(links.ts, target); "" where markdown refused one, so screen() finds none inside it`.

**Run:** `node node_modules/vitest/vitest.mjs run tests/tui/links.test.ts`, the file with `screen`'s
tests, then `tests/tui/select.test.ts` and `tests/tui/detailview.test.ts`; then
`-t "App's replies as markdown"` and the describe names holding the five URL cases in app.test.tsx
(lines near 13049-13084: `grep -n "example.com/x" tests/tui/app.test.tsx`, and read the `describe`
above them). Then types.

**Commit:** `feat: links: find web addresses on screen as marked does, as spans`

## Task 3: Drawing links

**Files:** `src/tui/Conversation.tsx` (`STYLE`, `runs`, `Run`, `marked`, `Printed`'s `at`),
`src/tui/App.tsx` (`at={l.id}`); tests `tests/tui/conversation.test.tsx`, `tests/tui/lines.test.tsx`.

**Tests first** (the theme given as `{ look: { light: false, color: true, full: true, links: true },
palette }`; the open written out as `\u001b]8;id=…;…\u0007`):
- Full screen, chalk at level 3: a row `go to https://x.y now` draws `go to `, then the accent's
  24-bit code (`#4278de`), open(`0-6`), `https://x.y`, close, then ` now`. The address has no
  underline code. The same without `links` draws exactly today's frame (no blue, no escape). With
  `color: false` and `links`, the escapes are drawn and there is no colour code.
- The blue in each look (decision 5): the light full palette (`palette({ light: true, color: true,
  full: true })`) gives the same `#4278de`; the named palette at chalk level 1 gives Ink's `blue`
  code (`\u001b[34m`).
- The blue over a line's own colour: a line `{ text: "see https://x.y", color: "error" }` has the
  address in the accent, `see ` in the error colour.
- A 30-character address in `new Rows(9)`: each of its rows has its own open with the same id and
  its own close; the scroll bar's column is outside every link.
- A row with the selection over half the address: the reverse part and the plain part both inside
  links of the same id and address.
- A markdown link `[docs](https://x.y)` said through `screen`: `docs` underlined, blue and linked;
  `(` and `)` muted and not linked; the address inside blue (not muted) and linked; both to
  `https://x.y`. The same line with links off: `docs` underlined in the text's colour, `(https://x.y)`
  all muted, as today.
- Inline code holding an address (`` `https://x.y` `` in a reply): linked, in the accent, as the
  code around it is.
- A one-line entry cut with `…` inside an address (finding 2), tested in each mode on its own:
  - full screen (`Conversation`, `new Rows(9)`, a one-line `{ text: "x https://example.com/a",
    oneLine: true }`): the link closes before the `…`, and the `…` has no link and no accent code;
  - classic (`Printed`, a one-line line of the same text at 10 columns): the `…` comes after the
    link's close. It is drawn in the run's style, as Ink's cut leaves it today, so with links on it
    is blue but not linked.
- Classic `Printed` with `at={7}` at 20 columns: a 47-character address wraps to three rows, each
  with an open of id `7-<start>` and a close, and the text after it outside. A markdown link whose
  text has a space at a row's edge (an `edgeSpaces` break): both rows linked. A band line with a tab
  and an address cut across rows: each row linked.
- The copy: a selection over a linked row gives the plain text (`textOf`), no escape.

**Implementation:** as "The design". `marked()` passes `r.line` to `runs()`, and each character's
`cut` with it; `Printed` passes `at`. The `link` and its id are part of a run's style for joining,
so two runs join only when both match. `Run` reads `look.links` and `palette.accent` from
`ThemeContext` for the blue. `Linked` (for Task 5) goes in the same file, built on `runs()`.

**Run:** `node node_modules/vitest/vitest.mjs run tests/tui/conversation.test.tsx
tests/tui/lines.test.tsx tests/tui/detailview.test.ts`, then types.

**Commit:** `feat: links: draw link spans as OSC 8 links, one id across a wrapped address`

## Task 4: Markdown links, and the App end to end

**Files:** `src/tui/markdown.ts` (the `link` token); tests `tests/tui/markdown.test.ts`,
`tests/tui/app.test.tsx` (a new `describe("App's clickable links")`).

**Tests first:**
- markdown.test.ts's link cases (lines 117-143) gain the link spans:
  `see [docs](https://x.y/z)` → also `{ start: 4, end: 8, link: "https://x.y/z" }` and
  `{ start: 10, end: 23, link: "https://x.y/z" }`; `www.x.y` → `link: "https://www.x.y"`;
  `<a@b.c>`, `[x](mailto:a@b.c)`, `[x](./a.md)`, `[x](file:///c:/a)` → their spans carry
  `link: ""` (handled, not a link) and no address; a link definition's use (`[r][1]`) linked to its
  address; the existing underline and muted spans unchanged.
  Destinations with no host (finding 3): `[docs](https://)`, `[d](http://)`, `[d](https://:80)` →
  `link: ""` only, and the drawn text exactly as today (`docs (https://)`, its underline and muted
  spans unchanged).
- A refused destination is not linked again (second review, finding 2):
  `screen(markdownLines("[local](file:///www.example.org)", 80, P)[0]!)` draws
  `local (file:///www.example.org)` with no span whose `link` is an address: `www.example.org` is
  not linked to `https://www.example.org`. The same for a label holding a bare address,
  `[see www.a.com](file:///x)`.
- App, full screen and classic, with a theme whose look has `links: true` (`themed(tree, theme)`),
  chalk at level 3 (the review's finding 4: each address where it is really drawn):
  - **in the conversation:** a reply `see https://x.y and [docs](https://a.b)` and your message
    `try www.c.d` each draw their address inside a link, in the accent blue;
  - **Ctrl+O:** a successful tool call whose output holds `http://e.f/g`. The conversation shows
    only `⎿ ok` for it (describe.ts:198-202, `resultRow`). Ctrl+O shows the last turn's calls with
    their full results (describe.ts:282-288, `lastTurn`, and describe.ts:356-369, `callLines`),
    the address there in a link, blue over the lines' grey. Where it is drawn differs by mode
    (second review, finding 3; app/promptKeys.ts:38-42): in full screen it opens the detail pane
    (`fns.openDetail`), so the test reads the pane's frame; in classic it prints the lines into
    the conversation as one block (`fns.show`), so the test reads that printed block;
  - **a markdown answer:** `/tasks t3` for a finished subagent whose answer is `[docs](https://a.b)`.
    Its answer is drawn as markdown (app/queue.ts:528) with `docs` and the bracketed address
    linked. In full screen it opens in the detail pane (app/queue.ts:93-97 and 138-141 open the
    pane only with `ui.fullNow`); in classic it is said into the conversation (`fns.say`, line 140),
    and the test reads it there;
  - a drag selection's copy has no escape. `/export` writes the raw markdown, unchanged.
- The same App without `links`: frames exactly as today's.

**Implementation:** as "The design", "Where spans come from".

**Run:** `node node_modules/vitest/vitest.mjs run tests/tui/markdown.test.ts`, then
`node node_modules/vitest/vitest.mjs run tests/tui/app.test.tsx -t "App's clickable links"` and
`-t "App's replies as markdown"`, then types.

**Commit:** `feat: links: markdown links open from their text and their address`

## Task 5: Links in the permission question

**Files:** `src/tui/layout.ts` (`FrameOut.askedLinks`), `src/tui/App.tsx` (the question box,
App.tsx:917-958), `src/tui/Conversation.tsx` (`Linked`, if not already built in Task 3); tests
`tests/tui/layout.test.ts`, `tests/tui/conversation.test.tsx` (`Linked`), `tests/tui/app.test.tsx`
(the MCP sign-in question's describe, near line 13049: `grep -n "example.com/x"`).

**Behaviour (decision 6):**
- **Full screen:** the frame wraps the question's line already (layout.ts:194, 226). It also gives
  `askedLinks`, one list a row, of `{ start, end, link, id }`. `start` and `end` are offsets into
  that row's drawn text. `id` is `q-<the address's start in the whole line>`, made once for each
  address before it is cut into rows. A row's own `start` is 0 on every row after the first, so it
  cannot be the id (second review, finding 4). The links are found by `urls()` over the whole line
  it wrapped (`askedText` or `askedShort`, as layout.ts:226 picks) and cut to each row with view.ts's
  `wrap()` starts and ends, so an address wrapped over two rows is linked on both with the same
  `id`. On a row with a tab before an address (an MCP form's text keeps its tabs, forms.ts:41), the
  offsets count the tab as the spaces it is drawn as. The App draws each `f.asked` row through
  `Linked` with that row's fragments, each drawn with its own `id`. The grey note and each red line
  are a row each, cut by Ink: `Linked` with `urls()` of that row's own text, the ids
  `qn-<start>` and `qw<line>-<start>` (one red line's addresses apart from another's).
- **Classic:** the note, each red line and the question line go through `Linked` with `urls()` of
  the text handed to Ink, ids made as in full screen from each address's start in its text.
  `edgeBroken` puts line breaks only at spaces, never inside an address, and finds the same
  addresses as the unbroken text, since `urls()` stops at a line break as at a space. Ink's
  `wrap-ansi` reopens the link on each row.
- The question's yellow stays on its words; an address in it is blue (decision 5). With links off,
  the box draws exactly as today.

**Tests first:**
- layout: `askedLinks` for a question line with one address on one row; an address wrapped over two
  rows at a narrow width: the second row's fragment starts at 0, and both fragments have the same
  `link` and the same `id`, `q-<the address's start in the line>`, not `q-0`; a tab before
  the address on its row; a line with no address (each row's list empty); the short line when the
  long one does not fit.
- `Linked`: a string with two addresses draws each inside its own link, in the accent; with links
  off, the plain string.
- App, full screen and classic, links on, chalk at level 3: the MCP sign-in question (`t1: s asks
  you to open https://example.com/x in your browser: …`) has `https://example.com/x` inside a link
  with id `q-…`, in the accent, the rest of the line in the warning colour. At a width where the
  address wraps in full screen, both rows' frames hold an open with the same `id=q-<start>`, the
  start of `https` in the question's line (the test finds that start with `indexOf`). A dangerous command's red line
  holding an address: linked. Links off: the box's frame exactly as today's.

**Run:** `node node_modules/vitest/vitest.mjs run tests/tui/layout.test.ts
tests/tui/conversation.test.tsx`, then `node node_modules/vitest/vitest.mjs run tests/tui/app.test.tsx
-t "<the sign-in question's describe>"` and `-t "App's clickable links"`, then types.

**Commit:** `feat: links: addresses in the permission question open with Ctrl+click`

## Task 6: README and the terminal check

**Files:** `README.md`; scratchpad `checklist-links.md` (not committed).

**README (for the user's approval):** in "## How the screen looks", after the `NO_COLOR` bullet:

> - **Links:** in a terminal that supports them, every web address on screen opens with
>   Ctrl+click and is drawn in blue. That covers addresses starting `http://`, `https://` or `www.`
>   (opened as `https://www.…`), in replies, your messages, tool output, notices, the detail view
>   and the permission question, in full screen and classic. A markdown link opens from its text
>   and from its address in brackets. The address opened is the one drawn, and a copy gives the
>   text alone. `file:`, `mailto:` and other addresses are never links. Links are on in Windows
>   Terminal, iTerm2, Ghostty, kitty, Alacritty, Hyper, Warp, JetBrains' terminal and tmux 3.4 or
>   later, the list Claude Code uses; on Linux and macOS also in VS Code's terminal 1.72 or later,
>   WezTerm and terminals built on VTE 0.50 or later, such as GNOME Terminal. The old Windows
>   console window, and output that is not a terminal, get none. `FORCE_HYPERLINK` set before
>   launch overrides that: `0`, `false`, `no` or `off` (any letter case) turns links off, any other
>   value turns them on, and empty is as unset. With `NO_COLOR`, links still work, without the blue.
>   In a terminal without links, addresses look as they always have.

In "### Replies as markdown", the links item becomes:

> - links with their text underlined and, when it differs from the text, the address after it in
>   grey brackets. Where the terminal supports links (see
>   [How the screen looks](#how-the-screen-looks)), the text and the address are blue and open the
>   address with Ctrl+click, and the brackets stay grey;

In "### The look's limits", a new bullet:

> - **VS Code's terminal and WezTerm on Windows get no links,** as in Claude Code, whose check this
>   is; `FORCE_HYPERLINK=1` turns them on.
> - **An address inside inline code looks no different with links on,** as inline code is already
>   blue; it opens with Ctrl+click all the same.

**Terminal check (scratchpad `checklist-links.md`), the user in Windows Terminal:**
1. A reply with a bare address, a markdown link, a `www.` address and an address in inline code:
   Ctrl+click on each opens the browser at the address shown (`www.` as `https://`). The bare
   address is blue, not underlined; the link's text blue and underlined; its address blue between
   grey brackets. The user says whether the blue reads well on their dark background.
2. An address long enough to wrap: hovering one row underlines every row of it; Ctrl+click on its
   second row opens it.
3. Your message with an address; a `shell` call printing one (`echo https://example.com`), whose
   row in the conversation says only `⎿ ok`.
4. `/screen` to classic, then steps 1-2 again.
5. Ctrl+O (the detail view): the `shell` call's output shows the address; Ctrl+click on it. A
   subagent's answer with a markdown link in `/tasks t3`: Ctrl+click on its text. A permission question naming an
   address (`shell` with `curl https://example.com`): the address in the box is blue and opens.
   `$env:NO_COLOR=1;` then `tachi`: addresses open, no blue. Then `Remove-Item Env:NO_COLOR`.
6. A plain click and a drag over an address still select, and the copy has no stray characters.
   A Ctrl+click on a tool row's address: whether Tachikoma also takes the click (opens or closes
   the fold, or clears the selection). If it does, that goes to the user before any fix.
7. `$env:FORCE_HYPERLINK="off";` then `tachi`: no links, and today's look (no blue). In the old
   console window (`conhost.exe`):
   no links, then `$env:FORCE_HYPERLINK=1;` and `tachi`: note what it shows, as it has no OSC 8
   support (it may hide the escapes or show stray characters). Then `Remove-Item Env:FORCE_HYPERLINK`.

Fixes from the check are built, reviewed and re-checked. Then the whole-PR review, the full suite
once (`--exclude tests/tui/external.test.ts`), and a PR on the user's say-so.

**Commit:** `docs: README: clickable links`

---

## As built

- **Branch:** built on the local branch `clickable-links`, not `links` as "Before you start" says.
- **Task 1** (d77919a, review fixes fe9e6b1): whether links are on, as planned; the review added
  tests for NETLIFY, TEAMCITY_VERSION and short VTE versions.
- **Task 2** (dc9aebe, fixes 1adb252 and 38cb862): an address ends where it cannot run on as
  drawn, and the text up to the next stop character is read once, not again per address.
- **Task 3** (fb81f3a, fixes 3225258): as planned; the review added the links-off markdown frame,
  the line index in ids and the copy guard tests.
- **Task 4** (a6ae0f1, fixes dc70bcb): a refused picture's address is not linked, and a space in a
  markdown link's address (`[x](<https://a.b/c d>)`) is encoded as `%20`.
- **Task 5** (b7bb1f7, fix 3f1730f): the question line's addresses are found once over the whole
  line and cut into rows; ids `q-<start>`, `qn-<start>` for the grey note, `qw<line>-<start>` for
  the red lines. The fix added the grey note's test.
- **Task 6** (README 7e33465, then d591b70 and the `TERM=dumb` fix): the user approved the words.
  Departures from this plan's draft: "the terminal's link click (Ctrl+click in Windows Terminal)",
  as macOS terminals use Cmd+click; "The address opened is the one drawn" left out, as decision 7
  says otherwise; in a reply a bare address is underlined, as marked makes it a link (decision 5
  and the draft said not). Six limits were measured and added. The user's terminal check
  (2026-11-17, Windows Terminal and the old console window) passed all seven steps; it found that
  Windows Terminal opens a plain address itself with links off (d591b70). The whole-branch review
  found no code problems; it found that `TERM=dumb` turns links off in VS Code's terminal, WezTerm
  and VTE terminals (chalk's colour level is 0, so supports-hyperlinks says no), as in Claude Code,
  and the README's sentence now says so. Full suite once: 5,751 passed, 1 failed (`takes
  --max-tasks only as a whole number from 1`, timed out at 18 s of 15; passed alone in 9.9 s;
  this branch does not touch it).

---

## Open questions for the user

None left. The user answered the first round on 2026-11-16 (now decisions 1 and 3-8), and then
the one that came from the blue: an address in a line with its own colour (a red error, a green or
red line of an edit's preview, the permission question's yellow line) is blue too, "Yeah blue"
(decision 5).
