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

No new numbers: nothing below sets a threshold, a size or a time, apart from fix 7's 63 links,
which is Windows' own limit, with Microsoft's page named there.

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

- **"Network or device path":** on Windows, a path that starts with `\\` or `//` once resolved,
  except `\\?\` or `\\.\` followed by a drive letter (`\\?\C:\...`), which is Windows' long-path
  spelling of an ordinary local file and is checked as today (option chosen at the build, where the
  first rule would have refused the existing long-path test, `tests/tools/files.test.ts:102`: "Count
  as local"). So it covers `\\server\share`, `\\localhost\C$\...`, `\\?\UNC\...`, `\\?\` and `\\.\`
  with anything but a drive letter (named pipes, raw devices, volume names). Node reports a
  junction's or link's target as a plain path (`C:\...`), so ordinary local links never count
  (probed 2026-10-30 with a junction in the scratch folder).
- **The order:** the root is walked first (below), as that touches only the root's own parts, which
  the user chose by starting there; then the text check; then the link check (found at the build:
  the plan put the text check first but also counted the root's real place in it).
- **The text check:** before any disk call on the path itself: a resolved path that is a network
  or device path, and not inside the root by its text (`leaves(path.relative(root, abs))`), nor
  inside the root's real place, is refused.
- **The existing spelling tests** (`tests/tools/files.test.ts:79` and `:261`): the `\\localhost\C$`
  spelling of the data folder and of the settings folder is now refused with the network words, not
  the data or settings ones. Those two expectations change; the long-path spellings keep theirs.
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
    does today; the walk keeps a set of the links seen, so no count is needed (wrong, found at the
    code review: a link can rightly be passed twice; replaced by fix 7's count of 63 links);
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

## After the code review

The code review of `61a6967..087204d` approved fixes 1 and 3 to 6, and found three gaps in fix 2.
It confirmed the first two by running the real `resolveIn` through the tests' fake file system. It
found the third by reading Node's link code, since it could not make a symbolic link here. Each was
checked against the code before this section. Each fix below is one commit, with its tests written
first and seen failing for the right reason.

### 7. A link passed twice no longer ends the check

- **The gap:** `linkHops` (`src/tools/files.ts:128`) ends its walk at a link met a second time,
  taking that for a loop. A link can rightly be passed twice. With a junction `<root>\l` leading to
  `<root>`, `l\l\linked\a.txt` passes `l` twice, the walk ends there, and `realTarget` then follows
  `linked` to the share without anyone looking at it.
- **Option chosen: "Stop at 63 links".** The walk counts every link it passes and refuses a path
  past the 63rd. That is the most reparse points Windows allows on one path ([Reparse
  Points](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points): "There is a limit
  of 63 reparse points on any given path"; symbolic links are reparse points, [Symbolic Link
  Programming
  Considerations](https://learn.microsoft.com/en-us/windows/win32/fileio/symbolic-link-programming-considerations)).
  So no path Windows could open is refused, and a loop of links ends at the 64th link. The set of
  links seen goes.
- **Message:** `<abs> passes through more than 63 links, which the file tools never open; a shell
  command can reach it, after asking`.
- **Tests:** a real junction `<root>\l` leading to `<root>`, with the fake share link `linked`:
  `l\linked\a.txt` and `l\l\linked\a.txt` are both refused with the "leads through" words, and the
  fake records nothing under `linked`. A real junction loop (`a` to `b`, `b` to `a`) is refused with
  the new words.

### 8. A project reached through a link to a share works

- **The gap:** the root's own walk lets a link to a share through, but every later path is walked
  again from its drive (`files.ts:159-161`). At the root's link, `inRoot` is asked about that link's
  target, the share's folder above the project, which is not inside it. With `C:\work` a link to
  `\\srv\share` and the project at `C:\work\proj`, `a.txt` in the project is refused.
- **Code:** a path inside the root by its text is walked from the root's real place (`place`, joined
  with its path from the root), since the root's own parts were walked already. Any other path is
  walked from its drive, as now. This also stops the walk going over the root's parts on every call.
- **Tests:** the fake file system gains a fake share holding a project, so that the root walk can
  end on a share: a root on a share (`\\tachi-test.invalid\share\proj`), and a root reached through
  a fake link to that share. In each, `a.txt` in the project resolves, and nothing outside the
  project's share folder is touched.

### 9. A link's target in Windows' internal form is refused

- **The gap:** for a link stored as `\??\GLOBALROOT\Device\Mup\srv\share` or `\Device\Mup\srv\share`,
  `readlinkSync` gives that text unchanged. `path.resolve` turns it into `C:\??\...` or `C:\Device\...`,
  which `networkPath` counts as local, and `realTarget` then follows the link to the network.
- **Option chosen: "Any single-slash start".** On Windows, a link whose stored target begins with
  one `\` or `/` (not two, and not a drive letter) is refused, checked on the text `readlinkSync`
  gives before it is resolved. That covers every internal form, and also refuses the rare link
  written as `\folder`.
- **Message:** the "leads through" words, with the stored target as it is written.
- **On the way to the project's own folder** (asked at the build, since the root's walk lets network
  targets through and fix 8 starts later walks from where it ends): option chosen, "Refuse, own
  message". Tachikoma cannot tell where such a project really is, so every path given to the file
  tools in it is refused with
  `<abs> is in a project whose own folder leads through <link> to <target>, a link the file tools cannot check, so they never open it; a shell command can reach it, after asking`.
  A test gives the fake root such a link and checks a file in the project is refused with those
  words.
- **Tests:** the fake file system makes two links, one to `\??\GLOBALROOT\Device\Mup\tachi-test.invalid\share`
  and one to `\Device\Mup\tachi-test.invalid\share`. Both are refused, and nothing under either is
  touched.

### 10. Your own instruction files are not checked for shares

- **The gap:** the instruction loader calls `resolveIn` for every file (`src/core/instructions.ts:110`).
  On a Windows setup that keeps the home folder on a server, your own `~/.claude/CLAUDE.md`, your
  Codex `AGENTS.md` and what they import are refused, though they loaded before this branch.
- **Option chosen: "Allow your own files".** `resolveIn` takes a third, optional argument that lets
  network paths through. The loader passes it for trusted files (`opts.trusted`: your two files and
  what they import). With it, the whole link check is skipped (the text check, the 63-link count
  and the single-slash refusal), and so is the walk of the project's own folder, as these files
  were read before this branch (settled at the build). The data-folder, settings-file and program-environment checks still apply to
  them. A project's own files are checked as now.
- **Tests:** a trusted file at the fake share is read; an untrusted import of the same path is
  refused, as now.

### 11. Smaller points from the code review

- **The walk only on Windows** (`files.ts:161`): `networkPath` is always false elsewhere, so
  `linkHops` and the root walk are skipped when the platform is not Windows. It doubles the cost of
  each path check, about 0.26 ms a path at 8 parts deep (the reviewer's measurement). The `@` menu
  checks every entry of a folder on each keystroke.
- **The text check's words:** `\\localhost\C$\<project>\a.txt` is in the project, but its text is
  not, and the message says "outside the project". It becomes
  `<abs> is a network or device path not written as a path in the project, so the file tools do not open it; a shell command can reach it, after asking`.
  `networkPaths.test.ts:134` and the two spelling tests in `files.test.ts` change with it.
- **The target in the "leads through" words** loses the backslash Node adds at the end of a share's
  root (`\\tachi-test.invalid\share`, not `...\share\`).
- **privateDir's words** (`src/auth/private.ts:70`): "so the login cannot be kept there safely"
  becomes "so it cannot be kept private", since the error log and the history now show it too.
- **Comments, no change in behaviour:**
  - `errorlog.ts`: the first error of a session runs PowerShell to make the folder private, about
    0.4 s once (the reviewer measured 385 ms); `privateDir` remembers the folder after that.
  - `rootPlaces`: `rulesIn` (`src/tools/search.ts:27`) passes the folder of a `.gitignore` with
    more than one name as the root, so such folders get their own entry. The root's real place is
    taken once a session; a change to the links above the project during a session is not seen.
  - `networkPaths.test.ts`: its wrappers go by a path's text, and do not reach search's grep worker
    or the steps inside `realpathSync`. That is safe only because every refusal comes before those.
- **An `edit_file` case** joins the direct and link cases in `networkPaths.test.ts`.
- **Left as it is:** `files.test.ts:95` and `:271` call `existsSync` on the real `\\localhost\C$`
  spelling to choose which spellings to test. It was there before this branch and reaches only this
  machine's own share.

## After the second code review

The code review of `e2ae24e..6dc5f4c` approved fixes 7 to 11, apart from the points below. Each
was checked against the code before this section. One commit per fix, tests first, seen failing.

### 12. Where a path really leads, as Windows says

- **The gap** (since release 1, confirmed by running): a junction whose target names a drive by its
  ID (`\\?\Volume{...}\...`, or `\\?\GLOBALROOT\Device\HarddiskVolume3\...`), not by its letter, is
  not seen as a link by Node's `lstatSync`, which follows it instead. `realTarget`
  (`src/tools/files.ts:11-20`) uses the JavaScript `realpathSync`, which goes part by part with
  `lstat`, so such a junction to a folder outside the project comes back inside it, and reads and
  writes there are not asked about. `realpathSync.native` gives the real place. Such a junction is
  local only: Windows does not support junctions to remote shares (Sysinternals' Junction page,
  <https://learn.microsoft.com/sysinternals/downloads/junction>), and `mklink /J` refuses one. Git
  and zip cannot make one.
- **Option chosen: "Fix it now".** `realTarget` uses `realpathSync.native`, and the JavaScript
  `realpathSync` when that throws (it can on some virtual drives), so those drives behave as now.
  It runs after the network checks, as now. The root and the path go through the same function, so
  a mapped drive, which `native` gives as its `\\server\share` path, still compares the same way.
- **Tests:** in a folder the test made, a junction made with `mklink /J` to the volume ID spelling
  of another folder the test made outside the project (the ID from `mountvol <drive>: /L`): a
  read there is "outside" and asks. With `realpathSync.native` made to throw, a plain file in the
  project still resolves inside it.

### 13. A project on a share reads the files above it again

- **The gap** (a regression from this branch, confirmed by running): a project on a share, or
  reached through a link to one, gets four "left out" instruction files at every start, one for
  each name looked for in the share's folders above the project (`src/core/instructions.ts:192-193`),
  even when none exists. Before this branch a missing one was skipped and a present one loaded.
- **Option chosen: "Same share is fine".** A network path on the same share as the project's real
  place (the same `\\server\share`, case ignored, whether written `\\server\share` or
  `\\?\UNC\server\share`) is not refused by the text check or the link check: Windows has already
  signed in there for the project. It is still "outside" when it is outside the project, and asks
  as usual. A path on any other share, and every device path, is refused as now.
- **Tests:** in `networkPaths.test.ts`, with the root on the fake share and with the root through
  the fake link to it: the instruction loader lists nothing left out when the folders above have no
  instruction files, and loads a `CLAUDE.md` placed in the share's top folder. A file on another
  fake share is still refused.

### 14. Smaller points from the second code review and its spec review

- **Comment** on `rootPlaces`: the project's own folder, as well as the folders above it, is taken
  once a session; one replaced by a link during the session (only a shell command, which asks, can
  do that) is not seen.
- **The third argument of `resolveIn`** becomes `{ trusted: true }`, as it also skips the walk of
  the project's own folder and the 63-link count, not only network paths.
- **`linkHops`' own `process.platform` test** (`files.ts:148`) goes, since it runs only inside the
  Windows test.
- **A one-line comment** at the call that walks from the root's real place (`files.ts:190`), saying
  what its two starting arguments are.
- **The project-folder refusal's words** for a path outside the project: it says "is in a project"
  only for a path inside the project; for one outside it, `<abs> cannot be checked, as the project's
  own folder leads through <link> to <target>, a link the file tools cannot check, so they never
  open it; a shell command can reach it, after asking`.
- **A root walk past 63 links** names the path asked for, with the root's link count in the words:
  `<abs> is in a project whose own folder passes through more than 63 links, which the file tools
  never open; a shell command can reach it, after asking`.
- **Tests:**
  - every test root in `networkPaths.test.ts` is its own, since the root places are kept for the
    session;
  - a chain of 63 real junctions resolves, and 64 is refused with the 63-link words;
  - in a project on the fake share, a project link to another folder in the project's real place
    is allowed;
  - later walks do not go over the root's own parts again (the fake counts `lstatSync` on them);
  - `search_files` and the `@` menu in a project on the fake share.

## Checks

- After each commit: the type check, and that commit's test files.
- At the end: the type check, `npm run build`, and the full suite. The PowerShell and disk files
  that can pass Vitest's 5 s limit when the suite runs at once are run alone, as for release 6.
- A code review of the branch, fixing until it approves.
- A short check in your terminal (Windows): Ctrl+O, a search for text that is not there, Ctrl+N,
  then Esc; and `/errors` after a failed request. With the default keys `n` is typed into the
  search, so the step is bound to Ctrl+N in your keys file first, as the test does.
- Then the pull request, held for your review. Nothing is pushed without your say-so.

**Before any of this,** the packages: they were emptied at 13:45 and restored at 14:48 from the
local cache during your review. The first full run shows whether they are complete.
