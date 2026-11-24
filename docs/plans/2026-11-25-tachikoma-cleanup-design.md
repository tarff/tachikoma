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
  about 166 `tempContext()` calls. 15 files today make folders and remove none (errorlog,
  networkPaths, git, auto, paths, search, chatgpt, keychain, private, store, instructions, models,
  registry, settings, history). Removals done in a `finally` stay.
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
  kills stand-in programs as the tests do and records how long Windows holds their folders. The
  retry interval and limit are set from that. The numbers on record before it: about 170 ms for a
  killed program's folder (2026-10-31) and 2.4 to 10.1 ms for memory's folders (2026-11-22);
  nothing is timed on the user's PC.
- **Check:** after a run of the touched files no new `tachi-*` folders are left in Temp, and a test
  shows a link inside a test folder removed with nothing behind it touched.

## Clearing out the old folders and error rows

Options chosen: "Script you run" for about 223,000 old test folders in Temp (since 2026-10-22),
and "Same script, ask first" for the fake error rows tests wrote before cce56d5 (2026-11-06): at
least 126 rows whose `lead` is `ollama:none`, in `%LOCALAPPDATA%\tachikoma\errors`.

- `scripts/clear-old-test-leftovers.mjs`, a one-off kept out of the package (package.json's `files`
  ships `dist` only). The user runs it at their desk: `node scripts\clear-old-test-leftovers.mjs`.
  It changes nothing without a yes.
- **What it looks for:** entries directly in `%TEMP%` whose names start with `tachi-` or
  `tachi editor `, last changed before a cut-off, the date the cleanup build starts, written into
  the script; nothing else in Temp, never `tm-` or another program's folders. And rows in
  `%LOCALAPPDATA%\tachikoma\errors\*.jsonl` whose `lead` is `ollama:none`.
- **What it shows first:** the folders' count, total size, and oldest and newest dates; and for
  each errors file, its fake rows and the real rows it keeps. Then it asks, separately, "Delete
  these folders? (y/n)" and "Remove these rows? (y/n)".
- **How it deletes:** folders by section 1's link-safe remover, a link removed itself and never
  followed; a folder in use is skipped and counted, never forced. Rows by rewriting each file
  without them into a new file in the same folder, which then replaces the old one, so a crash
  cannot leave half a file; the file keeps its private permissions and no permissions are changed.
  A file whose rows were all fake is deleted. At the end it says what it removed and skipped.
- **Testing:** against a pretend Temp and a pretend errors folder the test makes, with matching and
  other names, folders newer than the cut-off, a link to outside, and a file mixing fake and real
  rows. Nothing touches the user's real folders in tests.

## Slow `-p` start-up and the CLI test time-outs

Option chosen: "Measure on CI, then choose". Every CLI test starts Tachikoma as a fresh process
under tsx, compiling TypeScript on the fly (tests/cli.test.ts `launch()`), and `src/cli.tsx` loads
the whole app statically, the screen code included. A test from cce56d5 noted 6.8 to 7.4 s alone
for making the data folder private, which goes through PowerShell.

- **Step 2, measured on CI**, on step 1's measuring branch, each push asked first. Several
  `tachi -p` starts, as the CLI tests make them, with each stage timed: compiling and loading (the
  screen code and the provider packages apart); reading the settings and the project file; the
  session sweep, git and sandbox checks, instruction files; making the data folder private;
  starting servers and memory; and up to the first request, to the `ollama:none` stand-in, so no
  provider is called. The same start from the build (dist) shows tsx's share.
- **Decision point.** The plan stops there: the user sees the times as a table and picks the fixes.
  Likely options, each only if the times bear it out: make the data folder private once rather
  than every run; load the screen code only for a run with a screen; run the CLI tests on the build.
- **The CLI tests, whatever is picked:** "takes --max-tasks only as a whole number from 1" starts
  Tachikoma 6 times in one test; it becomes one test per value. The CLI tests' time limits come
  from step 2's CI times, written down with their source, in place of today's 15 s.
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
- **Failed resource and prompt lists.** Today a failure listing a server's resources or prompts at
  start is thrown away and the list stays empty. The failure is kept, `/mcp` shows it on the
  server's row (suggested words, approved at the plan: "resources could not be listed:
  `<error>`"), and a Reconnect lists them again. The server stays usable and its tools are offered.
- **A hung Docker test.** Each real-Docker test names its container and removes it when the test
  ends, passed, failed or timed out, with `docker rm -f <name>`, after stopping a `docker run`
  that hung.
- **Tests:** a stand-in server cancelling its page request with the question up; a refusal during
  start and during refresh, with the existing refusal stand-in; a list failing at start, then
  working after a Reconnect; the Docker clean-up with a stand-in `docker` that records the `rm`,
  so the ordinary suite needs no Docker.

## Build order and checks

- **Branch:** local `cleanup`, from main at e5b8606; nothing pushed without the user's say-so. The
  measuring branch is separate, pushed only for steps 1 and 2, and deleted once the times are saved.
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
- Release 9's "skills from experience" comes next.
- The old `test-cleanup` branch and its worktree stay as they are; after this release is merged
  the user is asked whether to delete them.

## As built

(Filled in during the build.)
