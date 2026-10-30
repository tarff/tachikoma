# Fixing the whole-project review's six findings

**Goal:** fix the six findings of the user's whole-project review of `885f488` (pasted 2026-10-30),
three of them security issues, before release 7's plan goes on.

**Branch:** `review-fixes`, from main at 61a6967. Its own pull request (option chosen: "Own PR from
main"), as the App.tsx split was. Release 7's branch takes these fixes once they are merged.

**Each finding was checked against the code before this plan** (file and line as of 61a6967):

| # | Finding | Checked |
|---|---|---|
| 1 | The shell runs plain `powershell.exe`, which Windows can find in the project folder first | `src/exec/local.ts:13`; every other program Tachikoma starts uses its System32 path (`clipboard.ts:32`, `auth/private.ts:44`, `local.ts:26`, `external.ts:31` and `76`, `chatgpt.ts:25`) |
| 2 | A network path is touched on disk before the permission question | `resolveIn` (`src/tools/files.ts:111-129`) calls `realTarget`, which calls `existsSync`, `lstatSync` and `realpathSync`, before any tool's `gate.require` |
| 3 | The error log follows links in the project's `.tachikoma` and writes without asking | `src/core/errorlog.ts:13-18`: `mkdirSync`, `writeFileSync` and `appendFileSync` follow a junction or link there |
| 4 | Moving between matches when there are none crashes the screen | `step()` in `src/tui/DetailView.tsx:50-54` takes the remainder after dividing by `s.found.length`, which is 0, so `s.at` becomes "not a number" |
| 5 | Esc cannot cancel the model lookup for a request with over 100 pictures | `contextWindow()` in `src/providers/anthropic.ts:193-202` calls `models.retrieve` without the turn's signal |
| 6 | A live change of scroll speed reuses the old speed's left-over notch | `notch()` in `src/tui/view.ts:284-290` keeps the carry in units of the speed's decimals: 0.99 leaves 99 hundredths, which speed 3 reads as 99 rows, so the next notch moves 102 |

No new numbers: nothing below sets a threshold, a size or a time.

## The fixes

One commit per finding, in this order, each with its tests written first and seen failing for the
right reason.

### 1. The shell's own path

- **Code:** `shellFor("win32")` starts `system32("WindowsPowerShell/v1.0/powershell.exe")`, as the
  clipboard does. The `name` stays "PowerShell".
- **Tests** (`tests/exec/local.test.ts`):
  - `shellFor("win32").argv("x")[0]` is that full path.
  - On Windows only: a copy of `system32("whoami.exe")` named `powershell.exe` in the test's own
    root, and `exec("Write-Output tachi-shell", root)` printing `tachi-shell`, not a user name.
    Before the fix it runs the copy. (`whoami.exe` is small; the reviewer used a renamed Node.)

### 2. Network and device paths, refused before the disk

Option chosen: "Refuse unless in project". A path can name a network share in its text
(`\\server\share\a.txt`), or reach one through a link on the way (`C:\project\linked\a.txt`, where
`linked` leads to `\\server\share`). Both are refused before anything follows them (found at the
plan's review).

- **"Network or device path":** on Windows, a path that starts with `\\` or `//` once resolved. That
  covers `\\server\share`, `\\?\UNC\...`, `\\?\...` and `\\.\...` (named pipes and devices). Node
  reports a junction's or link's target as a plain path (`C:\...`), so ordinary local links never
  count (probed 2026-10-30 with a junction in the scratch folder).
- **The text check:** first in `resolveIn`, before any disk call: a resolved path that is a network
  or device path, and not inside the root by its text (`leaves(path.relative(root, abs))`), is
  refused.
- **The link check:** next, still before `realTarget` follows anything, a new `linkHops(abs)` in
  `src/tools/files.ts` walks the path one part at a time from its drive, as `realpath` would, but
  looks before it follows:
  - each part is examined with `lstatSync`, which does not follow that part; the parts above it are
    already known to be plain folders, or links whose targets were checked (the probe confirmed
    `lstatSync` follows every part above the last, which is why it goes one part at a time);
  - a part that is a link has its target read with `readlinkSync`, which does not open the target,
    and resolved against the link's folder;
  - a target that is a network or device path outside the root is refused; any other target takes
    the place of the parts walked so far, and the walk goes on from there;
  - a link met a second time ends the walk (a loop of links), and `realTarget` then reports it as it
    does today; the walk keeps a set of the links seen, so no count is needed;
  - the walk stops at the first part that does not exist.
- **The root itself** is walked the same way once, at the first `resolveIn` for that root. A network
  target there is allowed, since the user started Tachikoma in that folder. The root's real place,
  where that walk ends, counts as inside the root for every later check, by text.
- **Refused in every mode, `never` included,** with:
  `<abs> is a network or device path outside the project, which the file tools never open; a shell command can reach it, after asking`
  or, for a link on the way,
  `<abs> leads through <link> to a network or device path outside the project (<target>), which the file tools never open; a shell command can reach it, after asking`
- **What it covers:** every caller of `resolveIn`:
  - `read_file`, `write_file` and `edit_file`: their `path`;
  - `search_files`: its `path` input, where it starts;
  - `find_files`: it takes only a `pattern` and always walks the project root
    (`src/tools/search.ts`, `files(".", ...)`); its walk already skips every link
    (`e.isSymbolicLink()`), so a link in the project to a share is never followed, and its pattern
    is matched only against names, never opened;
  - the `@` menu's listing;
  - the instruction files' `@` imports, so an AGENTS.md in a downloaded project naming a network
    path, directly or through a link, no longer makes Windows try to sign in at launch.
- **What it leaves:**
  - A project that itself lives on a share still works.
  - A drive letter the user has mapped to a share (`Z:\`) reaches only the user's own server, which
    Windows has already signed in to; it is a local path to this check and is not changed.
  - Paths the user pastes or drags in as pictures are the user's own and do not go through
    `resolveIn`; they are not changed.
- **Tests:** a new file, `tests/tools/networkPaths.test.ts`, Windows only. Every network or device
  access is stopped, not just recorded (found at the plan's review), so a test that fails before the
  fix still never reaches Windows' network or a pipe:
  - `vi.mock("node:fs")` and `vi.mock("node:fs/promises")` wrap every function that takes a path.
    A call whose path is a network or device path is recorded and throws `ENOENT` at once, without
    calling the real function. Every other call goes to the real function.
  - **A fake link:** the same wrappers make `<root>\linked` a link to `\\tachi-test.invalid\share`
    (`lstatSync` reports a symbolic link, `readlinkSync` returns that target), and any other call on
    `<root>\linked` or a path under it is recorded and throws too, so following it is caught. A real
    link to a share would need a real server and the right to make symbolic links. The name's
    `.invalid` is reserved and never resolves (RFC 2606), as a second guard only.
  - **Direct paths:** `\\tachi-test.invalid\share\a.txt`, `//tachi-test.invalid/share/a.txt`,
    `\\?\UNC\tachi-test.invalid\share\a.txt` and `\\.\pipe\tachi`, each given to `read_file` and
    `write_file` in `ask` and `never`, and to `search_files` as its `path`.
  - **Through the link:** `linked\a.txt` given to the same tools, and `@linked\` in the `@` menu.
  - **Imports:** an instruction file with `@\\tachi-test.invalid\share\x.md` and one with
    `@linked/x.md`, each left out with its reason. (In this file, not `instructions.test.ts`, which
    uses the real disk.)
  - **`find_files`:** with `**/*` and with `//tachi-test.invalid/**` as its pattern, with the fake
    link in the root: no network or device access, and no access under `linked`.
  - Each refused case: the exact words above, the gate never asked, and nothing reached the real
    disk for it.
  - **Ordinary links still work:** a real junction in the project to a local folder outside it is
    still "outside" and asks, as today (`tests/tools/files.test.ts` already checks this, unchanged).

### 3. The error log, in Tachikoma's data folder

Option chosen: "Tachikoma's data folder".
- **Where:** `<data>/errors/<sha256>.jsonl`, named after the project's real path exactly as the
  prompt history is (`historyFile`, `src/tui/history.ts:12-20`). That naming moves into
  `src/core/datadir.ts` as `projectFile(folder, root, data = dataDir())`, and `historyFile` calls
  it, so the two cannot drift. `cli.tsx:184` passes `projectFile("errors", root)`;
  `attachErrorLog` and `/errors` keep their signatures.
- **How it writes:** `privateDir` on the errors folder, as history does, then `appendFileSync` with
  mode `0o600`. A file made in the private folder has the folder's permissions (`writePrivate`'s
  comment, `auth/private.ts:161`). One append per row, so two sessions in one project do not lose
  each other's rows. Nothing in a project can redirect it now. The `.gitignore` it wrote in
  `.tachikoma` goes, with its tests, as the log no longer lives in the project.
- **Reading:** `summarize` reads with `readPrivate`, as history loads.
- **Old logs:** an existing `.tachikoma/errors.jsonl` in a project is left alone. `/errors` shows
  only the new log.
- **Tests** (`tests/core/errorlog.test.ts`, with `TACHI_DATA_DIR` a folder the test made):
  - a row lands in `<data>/errors/<hash>.jsonl`, and the project gets no `.tachikoma` folder;
  - the reviewer's case: a `.tachikoma` junction in the project pointing at another temporary
    folder, and after a provider error that folder is still empty;
  - two spellings of one folder (its 8.3 short name, `shortName` in `tests/helpers.ts`) share one
    log;
  - an errors folder that cannot be made turns the log off with the existing line;
  - `summarize` of the new file, as today's first test checks it.
- **Docs:** the README's "An error log" bullet (line 84) and the main design's "Error log" section
  name the new place. Release 7's design says `.tachikoma` "holds the error log and backups"; that
  line is fixed on the release 7 branch after this merges, to say backups only.

### 4. No match, nothing to move to

- **Code:** `step()` returns at once when `s.found` is empty.
- **Tests:** `tests/tui/app.test.tsx`, in the detail view's block: a keys file binding `ctrl+n` to
  `transcript:nextMatch` and `ctrl+p` to `transcript:previousMatch` in Transcript; Ctrl+O, `/`, a
  search with no match, then Ctrl+N and Ctrl+P: the view is still drawn, with its "no match" row.
  The crash is seen first.

### 5. The model lookup stops with the turn

- **Code:** `contextWindow(signal?)` passes `{ signal }` as `models.retrieve`'s third argument (its
  `RequestOptions`, `@anthropic-ai/sdk` 0.132.0). `#maxPictures` passes the turn's signal through.
  A lookup stopped by the signal rejects, so the turn ends as cancelled, and nothing is cached. One
  that fails for any other reason still counts as no answer, as now. `Provider.contextWindow`'s type
  (`src/core/types.ts:83`) takes the optional signal. ChatGPT's needs no change: it reads a list
  already fetched.
- **Tests** (`tests/providers/anthropic.test.ts`, spying on `Models.prototype.retrieve` as its
  existing test does): a request with 101 pictures whose lookup waits until its signal stops it.
  Aborting the turn rejects `complete()` promptly, the lookup got the signal, and a later call looks
  the window up again.

### 6. A new speed starts with nothing left over

- **Code:** the live edit of `scrollSpeed` (`src/tui/app/liveEdits.ts:106`) sets `ui.wheel.current`
  to 0 when it sets the new speed. The fraction belongs to the old speed, and a notch of the new one
  starts clean.
- **Tests:** `tests/tui/app.test.tsx`, in the live settings block: speed 0.99 from the file, one
  wheel notch down, a live edit to 3, then one notch moves 3 rows, not 102.

## Checks

- After each commit: the type check, and that commit's test files.
- At the end: the type check, `npm run build`, and the full suite. The PowerShell and disk files
  that can pass Vitest's 5 s limit when the suite runs at once are run alone, as for release 6.
- A code review of the branch, fixing until it approves.
- A short check in your terminal (Windows): Ctrl+O, a search for text that is not there, `n`, then
  Esc; and `/errors` after a failed request.
- Then the pull request, held for your review. Nothing is pushed without your say-so.

**Before any of this,** the packages: they were emptied at 13:45 and restored at 14:48 from the
local cache during your review. The first full run shows whether they are complete.
