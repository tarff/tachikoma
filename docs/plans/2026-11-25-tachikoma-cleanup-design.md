# Tachikoma cleanup between releases 8 and 9, design (2026-11-25)

Release 8's five parts are merged (8e as PR #27, e5b8606). Before release 9, the user's order
(2026-11-17) puts a cleanup: the slow and flaky tests, the test folders left in Temp, the slow
`tachi -p` start-up, and small behaviour items noted along the way. The overall design and the
release order are in [2026-10-22-tachikoma-design.md](2026-10-22-tachikoma-design.md).

Every choice below was the user's, on 2026-11-25, from options offered; "option chosen" quotes it.
Each section was approved as written here.

## What is in it

All four groups offered (option chosen: all four): flaky and slow tests; tests clean up after
themselves; slow `-p` start-up; small behaviour items. Three more items from the notes were offered
and all chosen: a refusal during a server's start, failed resource and prompt lists, and a hung
Docker test's container.

Two leads in the notes did not hold up when the code was read (2026-11-25), so they are not
items: commit 3f088bf, noted as "find_files 15 s time-out", changes docs only, and no find_files
test has a time-out of its own; and the hub.test.ts lines noted as kill-then-delete sites are not.
The kill-then-delete pattern is in the shared clean-ups of hub.test.ts, memory.test.ts and
lessons.test.ts (below).

## Tests clean up after themselves

Option chosen: "One shared helper". The idea is the `test-cleanup` branch's (2026-10-30), written
afresh on today's main; that branch is 968 commits behind and is not merged.

- **The helpers.** `tests/helpers.ts` gets `tempDir(prefix)`, a folder removed when its test ends,
  and `fileTempDir(prefix)`, one removed when the file's tests end. `tempContext()` and the
  stand-in editor use them; today `tempContext()` never removes its folder.
- **Every test moves to them:** about 214 `mkdtemp`/`mkdtempSync` calls in 75 files, plus the
  about 166 `tempContext()` calls. About 17 files today make folders with `mkdtemp` and remove
  none, and 13 more use only `tempContext()`, which removes none (the run's reader report lists
  them, 2026-11-25). Removals done in a `finally` stay.
- **One link-safe remover.** It reads each entry's type from its folder before entering it; a link,
  a junction naming its drive by ID included, is removed itself and never followed. A folder Windows
  still holds is tried again at an interval, up to a limit, both from step 1's measurement. A
  folder that still cannot be removed does not fail the test: one warning line on stderr names
  it. Today's `removeTree` (one try, throws) and the about 37 `rmSync(…recursive)` calls go over
  to it.
- **Processes before folders.** A test that kills a process waits until it has exited before its
  folder is removed. The MCP stand-in's `killAll` (tests/mcp/fake.ts) today waits only for the
  stand-in Docker processes; it will also wait for the server processes it killed, the cause of
  the EBUSY failure in "keeps the record when the entry is removed and added back"
  (tests/mcp/servers.test.ts). The hub, memory and lessons clean-ups already wait until the
  process reports gone; Windows can hold the folder a moment longer, which the retry covers.
- **Step 1, measured on CI** (option chosen: "Measure on CI"). A small measuring test runs on
  GitHub's Windows machine, on a temporary branch deleted afterwards, each push asked first. It
  kills stand-in programs as the tests do and records how long Windows holds their folders; it
  also records whether Windows refuses to rename a folder a program is working in, and one with a
  file held open inside, for the one-off script (next section). The
  retry interval and limit are set from that. The numbers on record before it: about 170 ms for a
  killed program's folder (2026-10-31, tests/hooks/run.test.ts) and a few milliseconds for
  memory's folders (2026-11-22: 2.4 to 10.1 ms in 4d30439's message, 2.8 to 8.1 ms in the comment
  in tests/cli.test.ts); nothing is timed on the user's PC.
- **Check:** after a run of the touched files no new `tachi-*` folders are left in Temp, and a test
  shows a link inside a test folder removed with nothing behind it touched.

## Clearing out the old folders and error rows

Options chosen: "Script you run" for the old test folders in Temp (a count on 2026-11-22 found
about 223,000 `tachi-*` names since 2026-10-22, but that counted every `tachi-` name, so it is
not what the script can remove: the script's own first screen gives the real count), and "Same
script, ask first" for the fake error rows tests wrote before cce56d5 (2026-11-06): at least 126
rows whose `lead` is `ollama:none`, in `%LOCALAPPDATA%\tachikoma\errors`.

- `scripts/clear-old-test-leftovers.mjs`, a one-off kept out of the package (package.json's `files`
  ships `dist`, `memory` and `sandbox`, not `scripts`). The user runs it at their desk:
  `node scripts\clear-old-test-leftovers.mjs`.
  It changes nothing without a yes.
- **Which folders count as a test's** (user's review of this design, 2026-11-25, P1). The `tachi-`
  prefix is not enough: Tachikoma itself makes `tachi-editor-` folders (src/tui/external.ts, the
  external editor, which may leave one on purpose holding the user's text) and `tachi-build-`
  folders (src/sandbox/image.ts, the image build). So:
  - A folder may be deleted only if its whole name matches a pattern on a fixed list in the
    script: a prefix the tests' own folder-making calls use, followed by exactly the six-character
    ending `mkdtemp` adds, and nothing else. So the plain `tachi-` folders `tempContext()` makes
    match `tachi-` plus six characters and never `tachi-editor-…` or `tachi-build-…`, which are
    longer. Each pattern is checked against every folder name src makes, and one that could match
    a folder of Tachikoma's own is left off the list. Tachikoma's own prefixes are never on it.
  - Folders whose name matches one of Tachikoma's own prefixes (`tachi-editor-`, `tachi-build-`),
    or that start with `tachi` and match no listed prefix, are listed apart as "not sure", with
    their count and dates, and never deleted by the script.
  - Only folders last changed before a cut-off, the date the cleanup build starts, written into
    the script. Nothing else in Temp is looked at; never `tm-` or another program's folders.
- **Which error rows count as a test's** (review P2). `ollama:none` is an ordinary lead Tachikoma
  accepts (src/providers/registry.ts), so a real failed launch can log it too. A row is a test's
  only if all of these hold: its `lead` is `ollama:none`; its `at` is before cce56d5 was made
  (2026-11-06 09:56 +11:00), when tests stopped writing there; and it carries the marks of the
  tests of that time (their message and fields, taken from those tests in git history, not from
  the user's file). A row that fails any of these is kept and counted as "not sure".
- **No writes during the rows clean-up** (review P2, twice). A row appended between the script's
  read and its replace would be lost, and so would one appended to a file it deletes. A check for
  open sessions cannot rule that out, as a new `tachi -p` can start just after it. So:
  - Before the rows part, the script asks the user to close every Tachikoma window and pause
    anything that can start `tachi` (a scheduled job, a script, a hook) until it is done: "Close
    Tachikoma and pause anything that starts it, then press y." Without a y it skips the rows.
  - It also checks itself: right before replacing or deleting a file, it compares the file's size
    and last-change time with what it read; if either changed, a writer came in, so that file is
    left exactly as it is and named as "changed while reading, not touched".
  - The folders part does not need this.
- **Folders in use are skipped before anything in them is deleted** (review P2). The remover
  deletes what is inside a folder before the folder itself, so a folder found busy only at that
  last step would be left half emptied. So, for each folder, the script first renames it, in
  place in Temp, to a name of its own (`tachi-clearing-` and the old name). Windows refuses to
  rename a folder a program is working in, so a refused rename means in use: the folder is
  skipped untouched and counted as "in use". Whether it also refuses for a file held open inside
  (and with which sharing) is not assumed: step 1's measuring run on CI tries both and the
  design's "As built" records it; a case it does not refuse ends, at worst, as "partly removed"
  below, never forced. Only a folder that was renamed
  is then emptied and removed. If something inside it still cannot be removed, it is left, the
  folder keeps its `tachi-clearing-` name, and it is counted apart as "partly removed", with what
  is left in it. A later run picks `tachi-clearing-` folders up again first.
- **What it shows first:** the test folders' count, total size, and oldest and newest dates; the
  "not sure" folders apart; and for each errors file, its test rows, its "not sure" rows and the
  rows it keeps. Then it asks, separately, "Delete these folders? (y/n)" and "Remove these rows?
  (y/n)".
- **How it deletes:** a renamed folder by section 1's link-safe remover, a link removed itself and
  never followed, nothing forced. Rows by rewriting each file without them into a new file in the
  same folder, which then replaces the old one, so a crash cannot leave half a file; the file
  keeps its private permissions and no permissions are changed. A file whose rows were all a
  test's is deleted. At the end it says what it removed, what was in use, what was partly removed
  and what changed while it read.
- **Testing:** against a pretend Temp and a pretend errors folder the test makes, with: each listed
  test pattern, plain `tachi-` plus six characters among them; Tachikoma's own `tachi-editor-`
  and `tachi-build-` folders, which must survive; an unlisted `tachi` name; folders newer than
  the cut-off; a link to outside; a folder a stand-in program is working in, which is skipped
  with nothing inside it deleted; a folder with one file that cannot be removed, reported as
  partly removed; a file mixing test rows with real rows, including a genuine `ollama:none` error
  after the cut-off and one without the tests' marks, both kept; no y to the "close Tachikoma"
  question, which skips the rows; and a stand-in writer that appends a row after the script has
  read the file, which leaves that file untouched with the new row in it. Nothing touches the
  user's real folders in tests.

## Slow `-p` start-up and the CLI test time-outs

Option chosen: "Measure on CI, then choose". Every CLI test starts Tachikoma as a fresh process
under tsx, compiling TypeScript on the fly (tests/cli.test.ts `launch()`), and `src/cli.tsx` loads
the whole app statically, the screen code included. Making the data folder private goes through
PowerShell, about 0.4 s once per folder per run (src/core/errorlog.ts: 385 ms measured); a CLI
test case that does it took 6.8 to 7.4 s alone (tests/cli.test.ts, 2026-11-06), so most of a
start's time is still unaccounted for.

- **Step 2, measured on CI**, on step 1's measuring branch, each push asked first. Several
  `tachi -p` starts, as the CLI tests make them, with each stage timed: compiling and loading (the
  screen code and the provider packages apart); reading the settings and the project file; the
  session sweep, git and sandbox checks, instruction files; making the data folder private;
  starting servers and memory; and up to the first request. The lead is `ollama:none`, the real
  Ollama adapter (src/providers/openai.ts), which reaches only localhost:11434; nothing listens
  there on CI, so no provider is called. The same start from the build (dist) shows tsx's share.
- **Decision point.** The plan stops there: the user sees the times as a table and picks the fixes.
  Likely options, each only if the times bear it out: make the data folder private once rather
  than every run; load the screen code only for a run with a screen; run the CLI tests on the build.
- **The CLI tests, whatever is picked:** "takes --max-tasks only as a whole number from 1" starts
  Tachikoma 6 times in one test; it becomes one test per value. The CLI tests' time limits come
  from step 2's CI times, written down with their source, in place of today's 15 s.
- **A deadline on the child itself** (review P2). `tachi()` in tests/cli.test.ts runs
  `spawnSync` with no `timeout`, so a hung start blocks the test worker and Vitest's own time
  limit and clean-up never run. Each start gets a deadline on the child process, from step 2's
  times; at the deadline the child and its own children are stopped, the test fails naming the
  start, and the clean-up waits for the child to exit before removing its folder.
- **Check:** step 2's table goes in this design's "As built"; after the picked fixes the same run is
  repeated on CI, before and after side by side.

## The page request, and the MCP server items

Options chosen: "Close with a grey line" for the page request; and for the server items, all
three ("Refusal during start", "Failed resource lists", "Hung docker test").

- **A cancelled page request.** When a server cancels an "open this page?" request while its
  question is on screen, the question closes at once, as a field form's does, the page is never
  opened, and a grey line says so. Suggested words, approved at the plan: "`<server>` withdrew its
  request to open a page." `visit` (src/mcp/forms.ts) is given the request's stop signal, as field
  forms are; the existing check after the answer stays as a second guard. With no cancel, nothing
  changes.
- **A refusal during start.** When the allowed-sites check refuses a server's connection while it
  starts or refreshes, the server is not marked ready: it is handled as a refusal at any other
  time, the same message, its tools not offered. Both places that mark it ready
  (src/mcp/server.ts, start and refresh) check first.
- **A refusal that comes after ready** (review P2). The resource and prompt lists run alongside
  the tool list and can settle after start or refresh has marked the server ready. A refusal by
  the allowed-sites check that arrives in one of them, at whatever moment, fails that connection
  the same way, even when it is already ready. Any other failure of those lists does not.
- **Failed resource and prompt lists.** Today a failure listing a server's resources or prompts at
  start is thrown away and the list stays empty. The failure is kept, `/mcp` shows it on the
  server's row (suggested words, approved at the plan: "resources could not be listed:
  `<error>`"), and a Reconnect lists them again. The server stays usable and its tools are offered.
- **A hung Docker test.** Each real-Docker test names its container and removes it when the test
  ends, passed, failed or timed out, with `docker rm -f <name>`, after stopping a `docker run`
  that hung.
- **Tests:** a stand-in server cancelling its page request with the question up; a refusal during
  start and during refresh, with the existing refusal stand-in; a refusal arriving in a list both
  before and after the server is marked ready, and an ordinary list failure in both orders, which
  leaves the tools offered; a list failing at start, then
  working after a Reconnect; the Docker clean-up with a stand-in `docker` that records the `rm`,
  so the ordinary suite needs no Docker.

## Build order and checks

- **Branch:** local `cleanup`, from main at e5b8606; nothing pushed without the user's say-so. The
  measuring branch is separate, pushed only for steps 1 and 2 and for the repeat in step 5, each
  push asked first, and deleted once the last times are saved.
- **How the measuring runs start** (review P3). CI's workflow (.github/workflows/ci.yml) runs only
  for pull requests and pushes to main, so a push to the measuring branch alone starts nothing.
  The measuring branch carries a workflow file of its own, on that branch only and never merged,
  that runs on a push to that branch (`on: push: branches: [<measuring branch>]`), on the same
  Windows machine and Node version as CI. It runs the measuring tests alone and saves their times
  as the run's output. For step 5's repeat the branch is moved onto the built `cleanup` and pushed
  again.
- **Order:**
  1. Measure on CI: Windows' hold on a killed program's folder (step 1) and `-p` start-up by stage
     (step 2), on one measuring branch; the times saved.
  2. Decision point: the user picks the start-up fixes from the table.
  3. The helper and the remover, the retry from step 1, with their own tests.
  4. Tests moved to the helper, a few files at a time, each batch its own commit and checks; the
     waits for a killed process to exit go in here.
  5. The picked start-up fixes; the CLI tests split up with limits from the measured times; the
     same timing run repeated on CI.
  6. The page request, the refusal during start, the failed lists, the Docker clean-up.
  7. The one-off script and its test.
  8. Docs: the README's known-limits lines for the items fixed here go, the new lines come in; this
     design's "As built" gets the measured times and any changes; the main design notes the
     cleanup done.
- **Checks:** each step runs its touched test files alone, and the type check. The full suite runs
  once near the end if the user agrees then; otherwise CI runs it at the PR. Nothing is timed or
  loaded on the user's PC.

## Known limits

Whatever the timings show that the user chooses not to fix is written down as a known limit, with
its measured cost.

## Not in this release

- No product features and no screen changes beyond the two new lines (the withdrawn page request,
  the failed list).
- Release 9 (rewinding) comes next; "skills from experience" is release 10.
- The old `test-cleanup` branch and its worktree stay as they are; after this release is merged
  the user is asked whether to delete them.

## As built

Built on local `cleanup`, 2026-11-25 to 2026-11-27. On 2026-11-27 the user chose to finish the
release small; what that dropped or moved is the last item below.

### The chosen numbers

- **The tests' remover tries a held folder again every 50 ms, for up to 2 s** (the user's choice
  at the decision point, 2026-11-25): what four test files already used; about 12 times the
  170 ms on record from the user's PC, and over 100 times CI's longest, 17.5 ms (table 1).
- **`STANDIN_WAIT_S` stays 5 s** (the same choice): a ceiling; on CI a killed stand-in's folder
  was free at most 12.8 ms after the kill (table 1).
- **The CLI tests' own build may take up to 30 s** (`BUILD_LIMIT_MS`, the user's choice,
  2026-11-27): about 12 times the slowest build step of the 55 CI runs that built, which took
  0.98 to 2.40 s; a margin chosen, not measured.

### Measured on CI

Both on GitHub's Windows machine with Node 24, 2026-11-24 (UTC), from a measuring branch of its
own. Nothing was timed on the user's PC, and CI's times do not cap it.

**Table 1. A killed program's folder** (step 1, 150 rounds of each case): from the kill's return
until the folder could first be removed.

| Case | Kill itself | Removable, from the kill's return: shortest / middle / longest | Rounds with a refusal | Refused tries (all EBUSY), most in one round |
|---|---|---|---|---|
| Plain child, `child.kill()` | 0.2 / 0.2 / 0.3 ms | 0.8 / 1.0 / 2.1 ms | 41 of 150 (41 of the first 100, 0 of the 50 more) | 42, at most 2 |
| Plain child, `taskkill /T /F` | 47.4 / 49.9 / 74.3 ms | 0.6 / 0.7 / 17.5 ms | 0 of 150 | 0 |
| Stand-in server, `killAll` (kill = its taskkill, up to its own wait) | 46.5 / 51.0 / 63.4 ms | 0.6 / 1.3 / 12.8 ms | 120 of 150 (79 of 100, 41 of 50) | 383, at most 7 |

Windows refused to rename a folder in use in each of the three ways tried, 150 rounds of 150: a
program working in it (`EBUSY`), a file inside held open as Node opens one (`EPERM`), and one
held open with no sharing (`EPERM`).

**Table 2. A `tachi -p` start** (`--lead ollama:none -p hi`), stage by stage (step 2, 20 starts
of each kind). "tsx" is from source, as the CLI tests started it then; "build" is
`node dist/cli.js`. Each column's figures come from each stage on its own, so its middles need not
add up to the whole start's.

| Stage | tsx shortest | tsx middle | tsx longest | build shortest | build middle | build longest |
|---|---|---|---|---|---|---|
| spawn to the process's start | 27.2 ms | 28.0 ms | 30.2 ms | 26.4 ms | 27.9 ms | 40.3 ms |
| compiling and loading, to cli.tsx's first line | 1.37 s | 1.39 s | 2.08 s | 913.5 ms | 922.0 ms | 954.2 ms |
| settings and project file read | 2.2 ms | 3.4 ms | 10.5 ms | 2.4 ms | 3.2 ms | 7.5 ms |
| options checked | 1.2 ms | 1.6 ms | 2.1 ms | 1.6 ms | 6.6 ms | 8.4 ms |
| sessions swept | 0.7 ms | 0.8 ms | 1.0 ms | 0.7 ms | 1.0 ms | 1.2 ms |
| models made | 2.9 ms | 3.1 ms | 9.7 ms | 2.9 ms | 3.0 ms | 8.1 ms |
| git and sandbox checked | 140.7 ms | 146.5 ms | 157.7 ms | 140.3 ms | 148.0 ms | 164.0 ms |
| instruction files read | 11.5 ms | 11.7 ms | 15.3 ms | 11.6 ms | 11.8 ms | 13.4 ms |
| memory made | 3.7 ms | 3.9 ms | 5.1 ms | 3.8 ms | 4.1 ms | 5.3 ms |
| prompt built, servers made | 1.6 ms | 1.7 ms | 2.1 ms | 1.6 ms | 1.7 ms | 2.5 ms |
| gate, hooks and tools made | 5.2 ms | 5.4 ms | 12.5 ms | 5.0 ms | 5.3 ms | 6.9 ms |
| session file made, its folder made private | 1.36 s | 1.38 s | 2.65 s | 1.35 s | 1.38 s | 1.44 s |
| lead's session made | 0.8 ms | 0.9 ms | 1.0 ms | 0.8 ms | 0.9 ms | 1.0 ms |
| servers and memory started | 0.4 ms | 0.4 ms | 0.5 ms | 0.4 ms | 0.4 ms | 0.5 ms |
| up to the first request | 1.1 ms | 1.2 ms | 1.3 ms | 1.2 ms | 1.2 ms | 1.6 ms |
| the first request (refused at localhost:11434) | 2.50 s | 2.65 s | 2.81 s | 2.53 s | 2.68 s | 2.89 s |
| from the last mark to the exit | 2.4 ms | 2.5 ms | 2.7 ms | 2.4 ms | 2.5 ms | 3.2 ms |
| exit to close, as the measuring process sees it | 15.5 ms | 16.7 ms | 23.5 ms | 14.2 ms | 15.6 ms | 20.6 ms |
| **spawn to just before the first request** | 2.94 s | 2.98 s | 4.96 s | 2.48 s | 2.51 s | 2.61 s |
| **whole start, spawn to close** | 5.49 s | 5.63 s | 7.80 s | 5.08 s | 5.21 s | 5.44 s |

There is no "after" table: the repeat run was dropped (last item below).

### Known limits: the parts of a start nobody chose to change

- **The refused request, 2.65 s on CI** (middle, table 2), though it is refused at once. Its parts
  are read from the code, not timed: the OpenAI SDK's 2 retry waits (0.5 s, then 1.0 s, each cut
  by up to 25% at random) and, likely, making the error log's folder private (Windows only).
- **The git check, 0.15 s on CI.**

### Where the build differs from the design

- **The EBUSY failure's cause is not known.** The design named `killAll`'s missing wait for the
  server processes. Step 1 did not confirm it: on CI the folder's holder was the stand-in Docker,
  which `killAll` already waited for, and every folder was free by the end of `killAll`. Step 8
  read the logged failures: all ran on code from before 2026-11-24's changes, none says which
  program held the folder or when, and the test the design names is in none of them. One
  candidate is ruled out outright (a record file held open); the rest stay open. The wait for the
  server processes was not built. The tests rest on the remover's retry, which then warns on
  stderr instead of failing, and `killAll` names any stand-in still running after its wait.
- **The remover's guarantee is narrower than "never followed"** (step 4). Held: a root that is a
  link when looked at, and a link in a listing when it is first read, are not followed; a folder
  replaced by a link that is still a link at the second look is not deleted from. Not held: it
  may read the listing of what a swapped-in link points at, deleting nothing from it; a folder
  above swapped for a junction; a folder that is a junction only between the two looks; anything
  swapped after the second look.
- **Fix (a) reached wider than `src/cli.tsx`.** Plain values moved out of `src/tui/Review.tsx` and
  `src/tui/StatusLine.tsx` into `src/tui/reviewWords.ts` and `src/tui/segments.ts`, and
  `src/cli.tsx`'s drawing code into `src/tui/draw.tsx`, loaded on demand. The boundary is the
  user's "full boundary" (2026-11-26): a `-p` start, and a start that ends early, load none of
  `ink`, `react`, `react/jsx-runtime` or a drawing module; `tests/cli.test.ts` records what a
  start loads.
- **Fix (b) was built as a cheaper check (2a + 2b), not as a check made once** (the user's choice,
  2026-11-26). The account comes from the PowerShell run that reads the permissions, so `whoami`
  is gone, and after a repair with nothing of another account's to remove the folder is not read
  again. On its own this changed no outcome: the same folders pass, and the same are refused in
  the same words. Not shown: the time saved (the repeat run was dropped); the account match for
  an elevated launch, for one under other credentials, and on CI's machine before the pull
  request; a folder the Administrators group really owns; the macOS and Linux branch, unchanged
  by the diff.
- **A folder's owner is checked on Windows** (the user's addition, 2026-11-26). A folder another
  account owns is refused, not taken over, before any permission is changed; one the
  Administrators group owns counts as the user's. The approved words (`src/auth/private.ts`):
  `<folder> belongs to another account, so it cannot be kept private; Tachikoma stopped before
  changing its permissions. To use it, either make your own account its owner, in PowerShell run
  as administrator while signed in as your own account: takeown /f '<folder>' /r /d Y; or rename
  it (for example to <name>.old), which sets aside what it holds and lets Tachikoma make a new,
  empty one. Then start Tachikoma again.` That `/d Y` is needed is inferred, not tried. All seven
  cases where a caller hides a refusal or acts on a refused folder were left as known limits (the
  README's "The private folders' limits").
- **The CLI tests start Tachikoma from a build of their own** (fix (c)): each run of
  `tests/cli.test.ts` compiles into `dist-test-<pid>-<time>` at the repo's top, one folder per
  run, removed when the file ends (`.gitignore` has `dist-test-*/`), and every start runs it with
  plain `node`; the stand-ins take the place of the build's Docker and memory modules. The user's
  `dist/` is not touched.
- **The one-off script** (`scripts/clear-old-test-leftovers.mjs`) does folders only: names that
  are a test's prefix followed by exactly the six characters `mkdtemp` adds, last changed before a
  cut-off written into it; each entry's type taken from its one listing of Temp, links and files
  not touched; a count and size first, then only `y` deletes. It deletes with the tests' remover,
  one try per folder: no staging rename, no record, no error rows. Its known limit: a folder
  swapped for a link between the script's listing and its delete, or a folder inside swapped
  during the delete, is not caught.
- **Tachikoma makes a third name in Temp,** `tachikoma-proxy-` (`src/sandbox/sitesNet.ts`), beside
  the two the design names. It is on no test list, so the script shows it as "not sure" and never
  deletes it.
- **The Docker clean-up is only in `tests/sandbox/sitesReal.test.ts`'s `container()`:** when its
  test ends, a `docker run` still going is stopped, then the container is removed by name. The
  other real-Docker test files, and `launch()` in that file, still wait for their run in their
  clean-up, so a start that hangs there can still leave a container. A container the engine makes
  after the stop could also outlive the `rm -f` (not measured). Tried against a stand-in `docker`
  only.
- **Dropped or moved on 2026-11-27:** the repeat measurement on CI, so the fixes' saving was not
  timed afterwards; the CLI tests' new limits, the split of the six-value `--max-tasks` test and
  the deadline on a start; and the page request and the three MCP server items (the refusal during
  a server's start or refresh, the late refusal from the lists, the failed resource and prompt
  lists), moved to a later release. The old tests' error rows stay; the script removes none.
