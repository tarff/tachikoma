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

Option chosen: "Refuse unless in project".
- **Code:** first in `resolveIn`, before anything touches the disk, on Windows only: a path that,
  once resolved, starts with `\\` (which covers `\\server\share`, `//server/share`, `\\?\UNC\...`,
  `\\?\...` and `\\.\...`) and is not inside the root by its text alone (`leaves(path.relative(root,
  abs))`) is refused in every mode, `never` included:
  `<abs> is a network or device path outside the project, which the file tools never open; a shell command can reach it, after asking`
- **What it covers:** every caller of `resolveIn`, so `read_file`, `write_file`, `edit_file`,
  `find_files`, `search_files`, the `@` menu's listing, and the instruction files' `@` imports (an
  AGENTS.md in a downloaded project naming a network path no longer makes Windows try to sign in at
  launch).
- **What it leaves:** a project that itself lives on a share still works, as its own paths are
  inside the root. Paths the user pastes or drags in as pictures are the user's own and do not go
  through `resolveIn`; they are not changed.
- **Tests** (a new file, `tests/tools/networkPaths.test.ts`, Windows only, since it wraps
  `node:fs`): `vi.mock("node:fs")` keeps every function but records the paths given to
  `existsSync`, `lstatSync`, `realpathSync`, `statSync` and `readdirSync`. The server's name is
  `tachi-test.invalid` (`.invalid` is reserved and never resolves, RFC 2606), so no test could
  reach a machine even if the check failed. For `\\tachi-test.invalid\share\a.txt`,
  `//tachi-test.invalid/share/a.txt`, `\\?\UNC\tachi-test.invalid\share\a.txt` and `\\.\pipe\tachi`:
  `read_file` and `write_file` in `ask` and `never`, and `find_files` and `search_files` with the
  path as their start, each refused with the words above, the gate never asked, and no recorded path
  starting with `\\`. In `tests/core/instructions.test.ts`: an `@\\tachi-test.invalid\share\x.md`
  import is left out with the same reason.

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
