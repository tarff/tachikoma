# Tachikoma release 8d: long-term memory and lessons (design)

The main design ([2026-10-22](2026-10-22-tachikoma-design.md), release list) gives 8d as "MemPalace in the uv
environment behind the shared supervisor, with a save before each shortening; lessons from the error log, stored in
the palace and recalled". Its "Memory" and "Lessons" sections sketched how; this design settles what is built, with
the user, section by section, on 2026-11-19. Where it differs from the main design, this design wins, and the
difference is named.

What exists already: the error log (`src/core/errorlog.ts`, one JSON line per failure, per project, in the data
folder; `/errors` summarises it), and an empty `onShorten` list in the shortening code (`src/core/session.ts:206-208`,
run at :911-912 after the transcript check and before 8b's PreCompact), left for this release by 8a (plan, choice
24). Nothing else of memory or lessons is built.

## The user's choices (2026-11-19)

1. **8d builds MemPalace's environment on first use, after one ask** ("8d builds it on first use (Recommended)").
   The main design gave this to `tachi setup` (release 14); release 14 will run the same step up front.
2. **No uv on PATH: memory is off, with one line saying how to get uv** ("Memory off, say how to get uv
   (Recommended)"). Installing uv itself stays in release 14.
3. **The install is locked with hashes, plus sfw when it is on PATH** ("Locked with hashes, plus sfw if present
   (Recommended)"), after the PyPI exploit of 2026-11-18. The embedding model is locked the same way (section 2,
   after the design review).
4. **Only messages are saved: the user's and the model's replies** ("Messages only (Recommended)"); never tool calls
   or their outputs.
5. **Recall is three tools plus a note** ("Tools, plus a start-of-session note (Recommended)").
6. **The tools are search, save a note and record a lesson** ("Search, save a note, record a lesson
   (Recommended)"). Never offered: deleting, mining folders, the knowledge graph, moving the palace, admin.
7. **Lessons are asked for automatically, and can be added by the model and the user** ("Automatic ask, plus the
   tool and /lesson (Recommended)").
8. **Lessons are shared across projects, each tagged with its project** ("Shared, tagged with the project
   (Recommended)").
9. **MemPalace's hub, with a small supervisor of Tachikoma's** ("Hub, with our small supervisor (Recommended)").
   This replaces the main design's own supervisor, lock file and endpoint file: the main design said to use hub mode
   if it gives the same guarantees (section "Memory"; still to measure, item 11), and it gives all but starting,
   watching and restarting (section 2).
10. **MemPalace 3.12.0** ("3.12.0, the latest (Recommended)"), not the main design's 3.11.0: 3.12 changes how part
    of a palace is stored, so starting on it avoids moving every user's palace later.
11. **The all-MiniLM-L6-v2 model** ("all-MiniLM-L6-v2, the default (Recommended)"), and the `sqlite_exact` backend
    the main design named.
12. **The lesson cut-off and count are measured on the user's error logs during the build** ("Measure on your error
    log during the build (Recommended)"): read only, on this computer, showing only counts and scores.
13. **Four controls** (all four picked): `"memory": false` in the settings file, `--no-memory`, `/memory`, and a
    status-line marker.
14. **The user's installed MemPalace and setup never change** (the user: "Ensure this testing doesn't touch my
    currently installed palace. I don't want me setup to change."), in tests and in use (section 2).
15. **A user who already has MemPalace can use theirs instead of Tachikoma's own** ("Use theirs instead of ours"),
    through their own program, opt-in (section 2).
16. **The hub stops when the last window exits** ("When the last window exits (Recommended)").
17. **Recall follows the SessionStart moments, built in, and never fetches before the user types** ("Search note on
    next message only (Recommended)").
18. **The build may download from PyPI through sfw, asking at each step** ("Allow, via sfw, asked at each step
    (Recommended)").
19. **No patches to MemPalace.** Four of the five fixes the user made to their own MemPalace 3.5.0 are in 3.12.0;
    the fifth is in the daemon, which Tachikoma does not use (research, below).

## What MemPalace 3.12.0 offers (research, 2026-11-19)

From MemPalace's GitHub source at v3.12.0 and its PyPI page; nothing was installed.

- **Released** 2026-11-12. Python 3.10 or newer. 47 MCP tools; none of 3.6.0's 36 removed or renamed. Since 3.11 a
  palace refuses to open with a model other than the one that built it. 3.12 moves hallways to a new file, so
  programs on older versions sharing that palace stop seeing each other's changes. PyPI shows SHA-256 hashes and
  signed build records for both 3.12.0 files.
- **Hub mode** (`mempalace serve`, built up over 3.6 to 3.9): an HTTP server for one palace on loopback, found
  through `serverinfo.json` under `~/.mempalace/server/<key>/`. One writer, by an operating-system lock freed when
  its holder dies; other servers keep reading and refuse writes. Several clients at once. It never kills a process.
  It does not start on demand, track its users, exit when idle, or restart after a crash: MemPalace leaves that to
  Docker or systemd. Its check for a dead hub asks only whether the process number exists.
- **Its home folder.** Locks, hub and daemon state, hook state and the default model cache all live under
  `Path.home() / ".mempalace"` or `~/.cache`. On Windows, Python takes the home from `USERPROFILE` (not `HOME`); on
  Linux and macOS from `HOME`. `MEMPALACE_CONFIG_DIR` moves the config folder; `--palace` or `MEMPALACE_PALACE_PATH`
  the palace. MemPalace's two defaults for the palace disagree, so the palace is always passed.
- **The user's fixes.** In 3.12.0: lookups by id use the primary key; the full-text delete goes by row; the metadata
  listing is forwarded and is one query; the mined-set read is one streamed read. The daemon's `diary_write`
  takes no writer lock of its own; Tachikoma does not use the daemon.

## 1. In short

When memory is first needed, Tachikoma asks once, then builds its own Python environment in its data folder: uv,
with sfw in front when it is on PATH, installs MemPalace 3.12.0 and every package it needs from a lock file Tachikoma
ships, with exact versions and hashes, and the embedding model, checked against its hash. The palace is new, in
Tachikoma's data folder, with the `sqlite_exact` backend and the all-MiniLM-L6-v2 model. Without uv, memory is off.
`-p` runs never ask.

Several windows share one palace through MemPalace's hub, which a small supervisor of Tachikoma's starts, checks and
restarts. The user's messages and the model's replies are saved word for word, filed under the project. The model
gets a note of close matches on its first request, three tools, and one line in the system prompt. Lessons are asked
for when a failure is fixed within a turn, kept for every project, and attached when a tool fails in a like way.

Not in 8d: mining folders, the knowledge graph or admin tools for the model; patches to MemPalace; skills drafted from
lessons (release 10).

## 2. The environment, the hub, and the user's own MemPalace

**Everything Tachikoma's memory keeps** is under `<data folder>/memory/`:

- `python/` and `uv-cache/`: uv's Python installs and its cache, given to uv by its own variables, so the user's uv
  Python installs and cache are never read or written.
- `env/<hash>/`: one folder per lock file: MemPalace 3.12.0 and its packages, installed from that lock file with
  hashes.
- `home/`: MemPalace's home folder. The child gets `USERPROFILE` (Windows) or `HOME` (elsewhere) set to it, with
  `MEMPALACE_CONFIG_DIR` and the model cache inside it, so nothing is written under the user's `~/.mempalace` or
  `~/.cache`.
- `palace/`: the palace, always passed with `--palace`.

The folder is private to the user, as the error log's is: messages can hold anything the user pasted.

**The install.** The first-use ask (section 6) names the download and its size, measured in the build. On "Yes" it
runs in the background while the user works, and memory switches on when it ends. A failed install leaves memory off,
with the reason in the error log and `/memory`; the next launch tries again. Tachikoma never runs a `uv tool`
command, and never installs anywhere but `memory/`.

**One installer at a time, and each version in its own folder.** Each environment has its own folder,
`memory/env/<the lock file's hash>/`, installed where it will stay: nothing is renamed, as a Python environment's
programs hold their own folder's path. An install lock of the same kind as the hub's lets one window install; the
others show `memory: setting up` and check again on a timer, never stopping work. When every package and the model
have been checked against their hashes, the installer starts MemPalace from that folder once to see that it runs and
reports 3.12.0, and only then writes the folder's ready file. A folder without a ready file is never used, and
whichever window next holds the install lock removes it and installs again, so an interrupted install is redone. A
window uses only the folder whose hash matches what it ships.

**Versions side by side.** The palace folder records the newest MemPalace version that has opened it. The hub notes
which folder it runs from. A window whose folder differs from the running hub's joins that hub as it is, since no tool
Tachikoma uses has been removed between versions; it starts a hub from its own folder only when none is running. A
window whose MemPalace is older than the palace's record never starts a hub, so a palace moved to a newer format is
never opened by an older version, and two Tachikomas cannot keep swapping. If no hub is running, that window turns
memory off with the reason:

> Memory is off: a newer Tachikoma has moved the palace to MemPalace `<version>`. Update Tachikoma to use memory
> again.

An old folder is removed only while holding the join lock, when no hub runs from it and its version is older than the
palace's record.

**The model is locked like the packages.** Tachikoma downloads all-MiniLM-L6-v2 itself during the install, from one
fixed address, an exact unchanging version, and checks it against a SHA-256 hash Tachikoma ships; then it puts it
where MemPalace looks for it, inside `memory/home`. MemPalace is started with downloads turned off (`HF_HUB_OFFLINE=1`
and whatever else the build finds MemPalace and its packages read), so it never fetches a model at run time. The
model's size is part of the first-use ask's figure. Its address, version and hash come from what MemPalace 3.12.0
itself uses, found in the build, and are shown to the user before they are fixed in the code.

**The hub.** A window that needs memory reads the hub's `serverinfo.json` in `memory/home`. If no hub answers there,
it starts `mempalace serve` for the palace, on loopback, on a free port the window picks, never MemPalace's default
8765, so it cannot meet a hub of the user's own. If two windows start one at once, MemPalace's lock lets one become
the writer; the other gives up its copy and uses the first. Each window checks the hub on a timer; one that stops
answering is restarted by the window that notices. No process is ever killed by a process number alone.

**In use.** Each window keeps an "in use" file in `memory/home`, refreshed on a timer; one not refreshed in time
counts as gone.

**Joining and stopping.** One lock in `memory/home`, an operating-system lock that frees itself if its holder dies,
covers both. A window joins by taking the lock, writing its "in use" file, checking the hub (starting one if none
answers), and letting go. A window that exits takes the lock, removes its own file, and looks for other windows' files
that are still fresh; if there are none, it records the hub as stopping, stops it (through the hub's own shutdown if
it has one, otherwise by its process number checked against the start time recorded when it was started), waits for
it to end, clears the record, and only then lets go. A window that finds the hub gone or stopping, at any time, waits
for the lock and joins again, which starts a new hub if needed. A crashed last window leaves the hub running until
the next window joins and finds no other fresh file. Which lock Node can hold this way on Windows, Linux and macOS is
checked in the build.

**The hub is Tachikoma's own server.** It runs on this computer in every sandbox kind, and the allowed sites (8c-2b)
do not apply to Tachikoma's requests to it, as the main design has for its own servers. The model reaches it only
through the three tools.

**The user's own MemPalace instead.** `"memory": { "use": "<full path to mempalace-mcp>" }` names the user's
MemPalace server program. Tachikoma then:
- builds no environment and asks nothing;
- runs that program per window, as Claude Code does, as it is: no `--palace` and no home folder change, so it opens
  the user's own palace with the user's own settings;
- never upgrades, reinstalls or patches it;
- checks at the start that it offers the tools Tachikoma needs (search, adding an entry), and turns memory off with
  the reason if it does not;
- files everything under its own wing (section 3).

An older version has no hub, so writes from several windows take turns, as MemPalace's lock decides. Tachikoma's own
3.12 never opens the user's palace: programs on different versions sharing one palace stop seeing each other's
changes.

## 3. What is saved, and when

**Where.** One layout for both palaces: the wing `tachikoma`; one room per project, named by its folder plus a short
code from its full path, so two folders called `app` never mix; and the room `lessons`. "This project" is its room;
"everything" is the wing, or, in the user's own palace, the whole palace (section 4).

**What.** Each finished turn is one entry: the user's message and the model's reply, word for word; MemPalace splits
long ones itself. Its label (`source_file`) is a session label, `tachikoma session <id>, turn <n>`, never a file path,
as a path-labelled entry is replaced when MemPalace mines that file (the user's notes). Not saved: tool calls and
their outputs, subagents' own messages, and shortening's summaries.

**When.**
- At the end of each turn: handed to a background saver, never waited on.
- Before each shortening: the turns not yet saved are sent, started and not waited on, from `onShorten`. The
  shortening goes ahead if the save fails (8a design, 179-181).
- At exit: the saver gets one last chance, up to a time limit measured in the build; what is left stays marked
  unsaved.

**Each turn is saved once.** A turn's label, `tachikoma session <id>, turn <n>`, is its fixed identity. Before adding
a turn, the saver looks up the entries with that exact label: all of its pieces there means it is already saved; some
means a save was cut off part way, and those pieces are removed by that label before the turn is added again; none
means it is added. Only then is the transcript's record of how far saving got moved on, so a crash at any point
repeats the check, never the entry. Turns still unsaved wait and are tried again when the hub is back, and a resumed
session picks them up. The build checks that 3.12.0 can look up and remove entries by exact label and tell how many
pieces a turn was split into. Where the user's own older MemPalace cannot, a turn cut off by a crash may be saved
twice (a known limit). The build also checks that an older Tachikoma skips the new transcript line.

`-p` runs save the same way when memory is set up.

## 4. How memory reaches the model

**The note.** At launch, after `/clear` and after a shortening, Tachikoma searches once with the user's next message,
in the project's room and the lessons, and puts the close matches in front of that request, marked as information,
not instructions. How many, and how close, are measured in the build on the Tachikoma transcripts on this computer,
read only. Nothing is fetched before the user types, so a launch never waits on the palace. A resumed or forked
session gets no new note: its history carries the old one.

**The tools.** Tachikoma's own, not MCP tools; in every mode and sandbox kind; no approval asked, as they only read or
add to the palace.
- `memory_search`: a query, and a scope of this project (the default) or everything. The matches, with labels and
  dates. With the user's own MemPalace, "everything" is the whole palace, so their earlier memories are found too.
- `memory_save`: text worth keeping, filed in the project's room, labelled as a note from this session.
- `record_lesson`: what went wrong, what fixed it, how to spot it next time; filed in `lessons` with the project.

Subagents get `memory_search` only.

**The system prompt line**, present only while memory is on (approved 2026-11-19):

> Long-term memory: memory_search finds earlier conversations and lessons (this project by default, or all
> projects). Save something worth keeping with memory_save, and record a lesson with record_lesson when you fix a
> failure.

It names no approval step and no screen, so it holds in `-p`, in every approval mode and in every sandbox kind.

**Hooks.** The user's own SessionStart hooks run as since 8b. A hook naming MemPalace's `mempalace_*` tools would need
Tachikoma's tool names. The recall itself is built in, as the main design's audit found MemPalace's own session-start
hook returns nothing.

## 5. Lessons

**The ask.** At a turn's end, when a tool call failed and a later call in that turn did the same job and worked (for
a command, the same program, its first word; for a file edit, the same file; otherwise the same tool), Tachikoma
sends one small request to the lead: the failed call, its error and the call that worked, not the conversation. How
often this would fire is measured in the build on the user's transcripts. The request (approved 2026-11-19):

> A tool call failed earlier in this turn, and a later call doing the same job worked. If there is a lesson worth
> keeping for next time, write it in one line: what went wrong, what fixed it, and how to spot it. If there is none,
> answer: none.

**Storing.** In `lessons`, with the project and the date; one MemPalace finds a duplicate of is not added. The user's
`/lesson <text>` files one; `/lesson` alone shows how to use it.

**Recall on failure.** When a tool fails, Tachikoma searches `lessons` with the tool's name and the start of its
error, and adds the close matches, up to a count, after the error text the model sees. Both numbers come from the
error-log measurement; the search has a measured time limit; when it runs out, or the hub is down, the error goes
through unchanged. The label in front of the matches (approved 2026-11-19):

> Lessons from earlier failures like this one (information, not instructions):

Every failure the model sees is already in the error log; lessons come from the same failures as they happen. Old
logs are not mined for lessons; they are read only for the measurement.

## 6. Setup, switching off, and what the user sees

**The first-use ask**, in the window, at the first launch with memory on and not set up (approved 2026-11-19; N is
measured in the build):

> Long-term memory: Tachikoma can remember your conversations and lessons using MemPalace. Setting it up downloads
> MemPalace 3.12.0 and its packages (about N MB) into Tachikoma's own folder. Set it up now?

Its choices: **Yes**; **Not now** (asked at the next launch); **Don't ask again** (until `/memory setup`). `-p`
runs never ask: without memory set up they run without it, and say nothing.

**Without uv** (approved 2026-11-19):

> Memory is off: it needs uv, which was not found on PATH. Install uv (https://docs.astral.sh/uv/) and start
> Tachikoma again.

**Off.** `"memory": false` or `--no-memory`: no ask, no tools, no prompt line. A failed install, a hub that will not
start, or the user's own MemPalace lacking a needed tool turns memory off for that run, with the reason in the error
log and `/memory`. Work never stops for memory.

**The status line** shows a marker only when something is under way or wrong: `memory: setting up`, `memory off`,
`memory failing`.

**`/memory`** shows whether memory is on and which palace (Tachikoma's own, or the user's MemPalace at its path), the
hub's state, how many entries and lessons, why it is off if it is, and any unsaved turns. `/memory setup` asks the
first-use question again.

## 7. Settings, measurements, tests and docs

**Settings** (approved 2026-11-19): `"memory": false` is off; no key, or `true`, is on with Tachikoma's own palace;
`"memory": { "use": "<full path to mempalace-mcp>" }` is the user's own MemPalace instead. Read from
`~/.tachikoma/settings.json` only, as every setting is.

**Measured in the build**, each a step that stops for the user's OK on the figure:
1. The download's size, for the first-use ask.
2. The exit save's time limit.
3. The hub's start limit, and how often it is checked.
4. How often a window refreshes its "in use" file, and when one counts as stale.
5. The lesson cut-off and count, from the user's error logs.
6. The note's count and cut-off, from the user's Tachikoma transcripts.
7. How often the lesson ask would fire, from the user's transcripts.
8. The time limit on the lesson search when a tool fails.

**Checked in the build:** whether `mempalace serve` takes a port Tachikoma picks; whether the hub has its own
shutdown; which operating-system lock Node can hold for joining, stopping and installing on Windows, Linux and macOS;
whether 3.12.0 can look up and remove entries by exact label and tell how many pieces a turn was split into; the
model's address, exact version and hash, as MemPalace 3.12.0 uses them, and every setting that keeps MemPalace from
downloading at run time; whether an older Tachikoma skips the new transcript line; whether 3.12.0's adding of an entry
skips duplicates.

**PyPI in the build:** making the lock file (uv resolving 3.12.0's packages and hashes) and installing it into a
throwaway folder, for the measurements and the opt-in tests; both through sfw, into folders the build makes and
removes, each step asking the user first.

**Tests.** Most run against a small stand-in MemPalace server, fast and touching nothing real. Tests against a real
MemPalace run only with `TACHI_TEST_MEMPALACE=1`, in throwaway data and home folders. One test checks that the
user's `~/.mempalace` and uv folders are unchanged afterwards. No test runs the user's own MemPalace program; the
"user's own MemPalace" tests use a throwaway copy in its place.

**README:** a Memory section (setup, the two palaces, the tools, the controls, what is saved, privacy); the setting,
`/memory`, `/lesson`, `--no-memory` and the status line in their places; known limits; "What comes next", where the
line on 8c-2's allowed sites still says "(this release)".

**Known limits, as candidates:**
- A crashed last window leaves the hub running until the next launch.
- Lessons come only from failures fixed within the same turn.
- The model is English-focused.
- With an older MemPalace of the user's own, there is no hub, and several windows' writes take turns.
- With an older MemPalace of the user's own that cannot look up or remove entries by exact label, a turn cut off by a
  crash may be saved twice.
- After a newer Tachikoma has used the palace, an older one has memory only while the newer one's hub is running.

## After the design review (2026-11-19)

The user passed on a review with four findings; all four were taken, in the user's words "Apply all four", with the
passages as shown to the user:
1. Joining and stopping the hub are now one lock's work, with a "stopping" record and joining again (section 2), so a
   window joining as the last one leaves cannot lose its hub. The main design required this.
2. Each turn is saved once by its label, including one cut off part way (section 3); the transcript's record alone
   could not promise it.
3. One window installs at a time, into a folder that becomes the environment only when every hash has been checked
   (section 2).
4. The embedding model is locked like the packages: a fixed address, an exact version and a hash, with downloads off
   at run time (section 2).

A second review, also passed on by the user, found two more; both taken ("Apply all"):
5. Each environment is installed in its own folder, named by its lock file's hash, where it stays, and is used only
   once a launch from that folder has worked and its ready file is written (section 2); renaming a Python environment
   breaks its programs.
6. Old and new Tachikomas side by side share the running hub, a palace remembers the newest MemPalace that opened it
   so an older one never reopens it, and an old folder is removed only when no hub runs from it (section 2).

## Found and measured in the build (8d plan)

### Q2 Which operating-system lock Node can hold (step 2, 2026-11-19)

The question: a lock for joining, stopping, installing and saving that frees itself when its holder dies.

Script: `scripts/8d/lock-probe.mjs`, run as `node scripts/8d/lock-probe.mjs run --runs 10 --child-runs 3`. For each
candidate it starts a holder process that takes the lock and keeps it, then a second process that tries to take it
over and over with no pause. It records whether the second process's first try is refused, then kills the holder
outright (Windows: `taskkill /F /PID <pid>` from Node; Linux: `SIGKILL`) and records how long after that the second
process took the lock. 10 runs per candidate, plus 3 runs in which the holder first starts a detached process of its
own that stays alive, as a window starts the hub while holding the join lock. A second process still refused 10 s
after the kill is cut off (the probe's own cut-off, so a run ends; not a figure for Tachikoma).

Where it ran:
- Windows: this PC, Windows 11 Pro 10.0.26200, Node v24.22.1 (libuv 1.52.1).
- Linux: the sandbox image already built here, `tachikoma-sandbox:5879e9863c31` (the shipped Dockerfile's tag, as
  `src/sandbox/image.ts:69` makes it; Debian 12, Node v24.22.2), in a container named `tachi-8d-lock-probe`, run with
  `--init --network none` and removed by that name. Nothing was pulled or built.
- macOS: not run. Its cells are from documentation.

The candidates:
- A. Named pipe: `net` listen on `\\?\pipe\<name>` (Windows; on Linux and macOS the same call makes B).
- B. Socket file: `net` listen on a file path (Linux and macOS; on Windows the same call makes A).
- C. Linux abstract socket: `net` listen on `\0<name>`.
- D. Loopback TCP port: `net` listen on `127.0.0.1` and one fixed port.
- E. `node:sqlite`: `BEGIN EXCLUSIVE` on a lock file, with SQLite's busy wait off (`timeout: 0`).
- F. `fs.openSync` with libuv's `UV_FS_O_EXLOCK` flag, which Node does not offer.
- G. The npm package `proper-lockfile` (named only; not fetched).
- H. The npm package `fs-ext`, its `flock` (named only; not fetched).

"Works" means: the second process was refused while the lock was held, and took it after the hard kill with no
clean-up of any kind. "None" means the system has no such thing.

| Candidate | Windows | Linux | macOS | New package |
|---|---|---|---|---|
| A. Named pipe | works: run here (1) | none, it is B: from docs (3) | none, it is B: from docs (3) | no |
| B. Socket file | none, it is A: from docs (1) | not freed: run here (2) | not freed: from docs (3) | no |
| C. Abstract socket | none: from docs (3) | works: run here (4) | none: from docs (3) | no |
| D. TCP port | works: run here (5) | works: run here (5) | not run: from docs (6) | no |
| E. `node:sqlite` | works: run here (7) | works: run here (7) | not run: from docs (8) | no (in Node) |
| F. `UV_FS_O_EXLOCK` | works: run here (9) | none: from docs (9) | not run: from docs (9) | no; not Node's API |
| G. `proper-lockfile` | not freed: from docs (10) | not freed: from docs (10) | not freed: from docs (10) | yes |
| H. `fs-ext` | unclear: from docs (11) | unclear: from docs (11) | unclear: from docs (11) | yes |

The existing `src/auth/lock.ts` is a pid file, not on the list: its own comment says a hard kill leaves the file
behind.

On Windows the kill call itself (`taskkill /F /PID`) took 0.78 s to 0.92 s in every run. The figures below are
counted from the moment the runner saw the holder's exit; a minus means the second process had already taken the lock
before the runner saw the exit.

Notes, with sources:
1. Named pipe, Windows, run here: first try refused with `EADDRINUSE`; after the kill, taken 10 of 10 by plain retry,
   from 3.2 ms before to 2.2 ms before the exit was seen (middle 2.6 ms before). With the holder's child alive (3 of
   3): taken 3 of 3, 3.5 ms to 3.0 ms before. Node: "Windows will close and remove the pipe when the owning process
   exits" (https://nodejs.org/docs/latest-v24.x/api/net.html, "Identifying paths for IPC connections").
2. Socket file, Linux, run here: first try refused with `EADDRINUSE`; after the kill, plain retry never took it (10 of
   10 still refused at the 10 s cut-off; 3 of 3 with the child). It was taken only by connecting first (refused with
   `ECONNREFUSED`), then deleting the file and listening again. Two waiters doing that at once could each delete the
   other's new socket; not tried.
3. Node, same section as (1): "a Unix domain socket will be visible in the file system and will persist until
   unlinked", including when "the program then crashes"; and "On Linux, You can use Unix abstract socket ... it will
   disappear automatically when all open references to the socket are closed." So macOS has the socket file only, and
   no abstract socket.
4. Abstract socket, Linux, run here: first try refused with `EADDRINUSE`; after the kill, taken 10 of 10 by plain
   retry, 0.2 ms to 0.7 ms after the exit was seen (middle 0.5 ms), 1.6 ms to 2.0 ms after the kill began. With the
   child alive: 3 of 3, 0.4 ms to 0.8 ms.
5. Loopback TCP port (`127.0.0.1`, a port the probe found free), run here. Windows: refused with `EADDRINUSE`; taken
   10 of 10, 2.7 ms to 1.9 ms before the exit was seen; with the child 3 of 3. Linux: refused with `EADDRINUSE`; taken
   10 of 10, 0.4 ms to 1.1 ms after (middle 0.7 ms); with the child 3 of 3, 0.2 ms to 0.7 ms. Each lock needs one
   fixed port number, which has no source, and any other program on that port would look like a held lock.
6. Not run. Node sets every socket to `SO_REUSEADDR`, and `reusePort` (several listeners on one port) is off by
   default (https://nodejs.org/docs/latest-v24.x/api/net.html, `server.listen()`). That a second listener is refused
   on macOS too is expected from this, not confirmed.
7. `node:sqlite` (`new DatabaseSync(file, { timeout: 0 })`, then `BEGIN EXCLUSIVE`), run here. Windows: refused with
   `database is locked` (SQLite code 5); taken 10 of 10, 0.3 ms to 10.6 ms after the exit was seen (middle 5.8 ms);
   with the child 3 of 3, 1.3 ms before to 2.7 ms after. On Windows each failed try took about 30 ms (28 tries during
   the 0.8 s kill), which bounds these figures. Linux: refused the same way; taken 10 of 10, 0.5 ms to 1.2 ms after
   (middle 0.7 ms); with the child 3 of 3, 0.5 ms to 0.8 ms.
   Also found here: the lock is let go when the `DatabaseSync` object is collected as garbage, so the holder must
   keep a reference to it. Script: `scripts/8d/lock-probe.mjs`, run as
   `node --expose-gc scripts/8d/lock-probe.mjs gc`, run here on Windows and on Linux (the same image and container
   name as above). A lock kept in a variable: a second process still refused after `gc()`. A lock nothing refers
   to: refused before `gc()`, taken after it. Both systems gave the same three results.
   Node: added in v22.5.0, no flag since v22.13.0; Stability 1.1 "Active development" in the v22 docs, 1.2 "Release
   candidate" since v24.15.0; the `timeout` option was added in v22.16.0, default 0
   (https://nodejs.org/docs/latest-v22.x/api/sqlite.html, https://nodejs.org/docs/latest-v24.x/api/sqlite.html).
   Tachikoma needs Node 22.20 or newer (`package.json`). No warning was printed on Node 24.22; Node 22 was not run.
8. Not run. SQLite: "The default locking mechanism used by SQLite on unix platforms is POSIX advisory locking", and
   "the close() system call will cancel all POSIX advisory locks on the same file for all threads and all file
   descriptors in the process" (https://www.sqlite.org/howtocorrupt.html, section 2.2). macOS is a unix platform here,
   as Linux was; the lock file must never be opened in the process other than through SQLite.
9. Run here on Windows: refused with `EBUSY`; taken 10 of 10, 2.4 ms to 1.3 ms before the exit was seen; with the
   child 3 of 3. But Node does not offer it: Node's list of flags available on Windows does not include it
   (https://nodejs.org/docs/latest-v24.x/api/fs.html, "File open constants"), so the probe passes libuv's raw value
   `0x10000000` (libuv `include/uv/win.h`), which makes libuv open the file with no sharing (`share = 0`,
   `src/win/fs.c`). libuv: "UV_FS_O_EXLOCK is only supported on macOS and Windows"
   (https://docs.libuv.org/en/v1.x/fs.html).
10. Its README: "This library utilizes the `mkdir` strategy"; `stale` "defaults to `10000`"; locks are removed on exit
    "except if the process is killed with SIGKILL or it crashes"
    (https://github.com/moxystudio/node-proper-lockfile). A killed holder's lock stands until it counts as stale.
11. Its README: "Asynchronous flock(2)". It does not say which systems it supports or whether it needs a native build
    (https://github.com/baudehlo/node-fs-ext).

With the holder's detached child still alive, every candidate that works was freed by the holder's death alone (3 of
3 each, both systems run): starting the hub while holding the join lock does not keep the lock held.

None of the candidates tells a waiting process when the lock frees: a waiter tries again after a wait (step 8's
figure). SQLite can do that waiting itself through its `timeout`.

The user's choice (Q2), 2026-11-19: option 1, `node:sqlite`: an exclusive SQLite transaction on one lock file per
lock, on Windows, Linux and macOS.

For step 17, which builds the lock:
- The `DatabaseSync` object must stay referenced for as long as the lock is held. A collected object closes and lets
  the lock go (note 7: with `--expose-gc`, refused before `gc()`, taken after).
- The lock file is never opened in the process except through SQLite (note 8).
- Open: Tachikoma supports Node 22.20 or newer (`package.json`, `engines`), but only Node 24 was run here. Step 17
  checks whether Node 22.20 prints an `ExperimentalWarning`, or any other line, when `node:sqlite` is loaded, without
  fetching anything: with a Node 22 already on this PC or in the sandbox image if there is one; otherwise it records
  that this could not be run. If any line would reach the user's screen, step 17 stops for the user, as that wording
  is not approved.

### Step 3 The lock file (2026-11-19)

In short: uv worked out MemPalace 3.12.0 and every package it needs, for Python 3.10 and newer on every system, and
wrote them into `memory/uv.lock` with a SHA-256 hash for every file. On Windows (x86_64), Linux (x86_64 and arm64) and
Macs with Apple chips, every package has a ready-built file for each Python from 3.10 to 3.14. Intel Macs have one only
on Python 3.10, and Windows on ARM on none.

Tools: uv 0.13.5 (`uv 0.13.5 (46776a95d 2026-10-21 x86_64-pc-windows-msvc)`, the user's own `~/.local/bin/uv.exe`,
run and not changed) and sfw (`Socket Firewall Free, version 1.15.4`). The user said yes to this PyPI fetch on
2026-11-19.

How it was run:
- In `C:\Users\<user>\AppData\Local\Temp\tachi-8d-build\lock\project`, holding only `pyproject.toml`, with step 1's
  `throwaway("lock")` environment. On the command only, four more variables: `UV_PYTHON_DOWNLOADS=never`, and
  `UV_TOOL_DIR`, `UV_PYTHON_BIN_DIR`, `UV_PYTHON_CACHE_DIR` set to `lock\uv-tools`, `lock\python-bin`,
  `lock\python-cache`. All four are in uv's list (https://docs.astral.sh/uv/reference/environment/: added in 0.3.2,
  0.2.16, 0.4.29 and 0.7.0).
- Before locking, through sfw with that environment: `uv cache dir` gave `...\tachi-8d-build\lock\uv-cache`,
  `uv python dir` gave `...\lock\python`, `uv python dir --bin` gave `...\lock\python-bin`. `uv tool dir` was not run,
  as task.md allows no `uv tool` command; locking does not use the tool folder.
- `sfw uv lock --python C:\Users\<user>\AppData\Local\Programs\Python\Python311\python.exe -v`: exit 0 in 19 s;
  "Using CPython 3.11.4 interpreter at: ...\Python311\python.exe", "Solved your requirements for 5 environments",
  "Resolved 112 packages in 18.69s". The Python was named so that uv would not look along PATH, where `~/.local/bin`
  holds links to the user's own uv-managed Pythons. It is the Python 3.11 already on PATH, used only for its version.
- No Python was downloaded, no `.venv` was made, and no source package was built (the verbose log has no build line).
  The log names no folder outside the build folder except that Python's own. Requests went to `pypi.org` and
  `files.pythonhosted.org` only (212 of them). sfw gives its child `HTTPS_PROXY=http://127.0.0.1:<port>` and
  `SSL_CERT_FILE=<its own certificate file>` (seen with `sfw node -e` printing those names), so uv went through it.
  sfw printed nothing and blocked nothing.
- One warning from uv, about one package's metadata: "Fixing invalid version specifier by removing stray quotes
  (before: `>= '2.7'`; after: `>= 2.7`)".
- The snapshot of the user's folders (`step3-before`, `step3-after`): "no change", apart from the set-apart lines of
  the user's own MemPalace daemon.

UV_NO_CONFIG and `[tool.uv]`: uv 0.13.5's own `uv lock --help` says "--no-config  Avoid discovering configuration
files (`pyproject.toml`, `uv.toml`) [env: UV_NO_CONFIG=1]", and the configuration page says it "disables the discovery
of any persistent configuration", where a project's configuration is the `[tool.uv]` table of its `pyproject.toml`
(https://docs.astral.sh/uv/concepts/configuration-files/). So with UV_NO_CONFIG=1 a `[tool.uv]` table is to be taken
as not read; the docs do not say whether project fields such as `environments` are skipped too. Not tried:
`memory/pyproject.toml` has no `[tool.uv]` table, and anything uv needs goes on its command line.

All systems: "uv's lockfile (`uv.lock`) is created with a universal resolution and is portable across platforms"
(https://docs.astral.sh/uv/concepts/resolution/). On the same page, `environments` only narrows the systems, and
`required-environments` makes uv require wheels for named systems. Neither is set. So the lock covers every system,
and a package with no ready-built file for a system is still locked; the install would fail there.

The files:
- `memory/pyproject.toml`: `requires-python = ">=3.10"` (MemPalace 3.12.0's own floor, "What MemPalace 3.12.0
  offers" above), one dependency `mempalace==3.12.0`, no build system (so uv installs only the dependencies). CRLF.
- `memory/uv.lock`: as uv wrote it, 991,468 bytes, SHA-256
  `50ab3261020767f5c95ead0389a5e83050a92f934c7c40d9bae89da519025d1d`, LF endings (4,207 lines, no CR). 3,014 lines
  are longer than 120 columns; that is uv's format and is not rewrapped. git here has `core.autocrlf=true`, so
  `.gitattributes` gains `memory/uv.lock text eol=lf` (the user's choice at step 3): the lock is kept and checked out
  with LF, byte for byte as uv wrote it. Step 16 hashes it read with LF.

What the lock holds (script: `scripts/8d/lock-check.mjs`, run as `node scripts/8d/lock-check.mjs memory/uv.lock`):
- 112 package entries: 111 from PyPI and the project itself. 99 names; 12 have one version per Python range
  (annotated-doc, filelock, httpcore2, httpx2, multidict, numpy, onnxruntime, pydantic-settings, python-dateutil,
  rpds-py, typer, websockets).
- 2,978 files (source packages and wheels). Every one has a SHA-256 hash, every package has at least one file, and
  every package comes from `https://pypi.org/simple`.
- mempalace 3.12.0: `mempalace-3.12.0-py3-none-any.whl`,
  `sha256:3832534f377f3a81a324f741f90bf3c1ec277d49404608257cde1b5b0d52626f`, the hash the research recorded. Its
  source package's hash, `f54cd31d050fc8c76ba822bc30be93580ecbb838a7a50a335d9a1192bd27d335`, matches too.
- No source package at all: flatbuffers 25.12.19, onnxruntime 1.23.2 and onnxruntime 1.32.0.

Ready-built files, by system and Python. For each, the script follows the lock's dependencies, markers and extras from
the project, and checks each package's wheel names against CPython's tags. "All" means every package has one; the
figure after it is the oldest system version on which every package has one.

| System | 3.10 | 3.11 | 3.12 | 3.13 | 3.14 |
|---|---|---|---|---|---|
| Windows x86_64 | all | all | all | all | all |
| Linux x86_64 | all, glibc 2.27 | all, glibc 2.28 | all, glibc 2.28 | all, glibc 2.28 | all, glibc 2.28 |
| Linux arm64 | all, glibc 2.28 | all, glibc 2.28 | all, glibc 2.28 | all, glibc 2.28 | all, glibc 2.28 |
| macOS arm64 | all, macOS 13 | all, macOS 14 | all, macOS 14 | all, macOS 14 | all, macOS 14 |
| macOS x86_64 | all, macOS 13 | not onnxruntime (1) | not onnxruntime (1) | not onnxruntime (1) | not onnxruntime (1) |
| Windows arm64 | 8 packages missing (2) | 3 missing (3) | 2 missing (4) | 2 missing (4) | 2 missing (4) |

1. onnxruntime 1.32.0, which uv chose for Python 3.11 and newer, has no Intel Mac file and no source package. Its
   files are for macOS arm64 (14.0), Linux x86_64 and aarch64 (glibc 2.28), and Windows x86_64 and arm64.
2. chromadb 1.5.9, grpcio 1.85.3, rpds-py 0.30.0, pydantic-core 2.50.4, pyyaml 6.0.3, numpy 2.2.6, orjson 3.13.0, and
   onnxruntime 1.23.2 (which has no source package either).
3. chromadb 1.5.9, grpcio 1.85.3, pyyaml 6.0.3.
4. chromadb 1.5.9, grpcio 1.85.3.

Not in the table: Linux with musl (Alpine; onnxruntime has no musllinux file), free-threaded Python builds, and other
processors.

Python versions with a ready-built file for every package on all three systems:
- Windows x86_64, Linux x86_64 and arm64 (glibc 2.28 or newer), and Macs with Apple chips (macOS 14 or newer; 13 for
  3.10): 3.10, 3.11, 3.12, 3.13 and 3.14.
- Counting Intel Macs too: 3.10 only, with this lock.
- Counting Windows on ARM: none.

The user's choice (step 3), 2026-11-19: Python 3.13. The reasons:
- With this lock, every package has a ready-built file for 3.13 on Windows x86_64, Linux x86_64 and arm64, and Macs
  with Apple chips.
- It is supported until October 2029 (https://devguide.python.org/versions/; a scheduled date). 3.10 has been past
  its end of life since 2026-10-01; 3.11 and 3.12 end in October 2027 and 2028. Packages are leaving older versions:
  this lock already takes numpy 2.5 only for 3.12 and newer.
- Over 3.14: the older onnxruntime in this lock (1.23.2) has Intel Mac files up to 3.13 and none for 3.14, so Intel
  Macs could still be added later on 3.13.

How it is pinned: `requires-python` in `memory/pyproject.toml` stays `">=3.10"`, and the lock stays as made: it already
covers 3.13, so pinning needs no new lock. The install (step 4 in the build, step 19 in Tachikoma) asks uv for 3.13, a
Python uv manages itself in its own folder (`memory/python`; in the build, the throwaway folder's `python`), never one
already on the computer.

Known limits for the README (step 30): on Intel Macs and on Windows on ARM, some packages have no ready-built file for
3.13 (onnxruntime on Intel Macs; chromadb and grpcio on Windows on ARM), so the install fails with its reason and
memory stays off.

For step 16: the user's own MemPalace settings must never reach Tachikoma's own MemPalace. The user's environment here
holds `MEMPALACE_MCP_ALLOW_PEER_WRITER=1` and `MEMPALACE_MCP_IDLE_HOURS=0`. Step 1's helper now drops every
`MEMPALACE_` variable of the environment it is given, in any spelling, except the ones it sets itself
(`MEMPALACE_CONFIG_DIR`), and step 16 applies the same rule to Tachikoma's own MemPalace environment.

### Step 4 The install, and the hashes enforced (2026-11-19)

In short: uv installed MemPalace 3.12.0 and the 84 other packages Windows needs from `memory/uv.lock` into the build
folder, with a Python 3.13 of its own that it downloaded there. The installed `mempalace --version` prints
`MemPalace 3.12.0`. A copy of the lock with only the MemPalace wheel's hash altered was refused: uv stopped on a hash
mismatch for that wheel and installed nothing. The snapshot of the user's folders showed no change apart from one
set-apart item: the user's own MemPalace's daemon folder `daemon/<palace key>`, whose time moved (from
about 07:50:49 to 07:55:49 local) during the step. The build never ran the user's programs; the user has another
Claude Code terminal running their MemPalace plugin.

Script: `scripts/8d/install-throwaway.mjs`, run as `node scripts/8d/install-throwaway.mjs <dirs install | install |
version | report install | tamper | report tamper>`. Tools: uv 0.13.5 (`uv 0.13.5 (46776a95d 2026-10-21
x86_64-pc-windows-msvc)`) and sfw 1.15.4, as in step 3. The user said yes on 2026-11-19 to these two PyPI fetches and
to uv downloading CPython 3.13 into the build folder for each.

How it was run:
- Each run has its own sub-folder of `C:\Users\<user>\AppData\Local\Temp\tachi-8d-build`, `install` and `tamper`, with
  step 1's `throwaway` environment and a copy of `memory/pyproject.toml` and `memory/uv.lock` in `<run>\project` (the
  install's copy is byte for byte the repo's), so no `.venv` was made in the repo.
- On the command only, five more variables, each in uv's list (https://docs.astral.sh/uv/reference/environment/):
  `UV_TOOL_DIR` (added in 0.2.16), `UV_PYTHON_BIN_DIR` (0.4.29) and `UV_PYTHON_CACHE_DIR` (0.7.0) in the run's folder;
  `UV_PYTHON_PREFERENCE=only-managed` (0.3.2), "Only use managed Python installations; never use system Python
  installations" (https://docs.astral.sh/uv/concepts/python-versions/); and `UV_PROJECT_ENVIRONMENT` (0.4.4), the
  environment folder, `tachi-8d-build\env` for the install and `tachi-8d-build\tamper\env` for the tamper run: "If an
  absolute path is provided, it will be used as-is" (https://docs.astral.sh/uv/concepts/projects/config/).
- Before each fetch, through sfw with that environment, `uv cache dir`, `uv python dir` and `uv python dir --bin`
  printed `<run>\uv-cache`, `<run>\python` and `<run>\python-bin`, all inside the run's folder.
- The install: `sfw uv sync --locked --python 3.13 -vv`, exit 0 in 11.5 s. "Using CPython 3.13.17", "Creating virtual
  environment at: C:\Users\<user>\AppData\Local\Temp\tachi-8d-build\env", "Resolved 112 packages in 1ms", "Prepared 85
  packages in 3.19s", "Installed 85 packages in 1.28s". `memory/pyproject.toml` was not changed.
- uv looked for a Python only among its own, in `install\python` ("Searching for managed installations at ..."), and
  queried one interpreter, the one it had just downloaded there.
- Requests went to `files.pythonhosted.org` (the packages) and `releases.astral.sh` (the Python) only. The one place
  outside the build folder the log names is an empty lock file uv makes for the project, in the user's Temp folder
  (`Temp\uv-<16 hex>.lock`, one per project folder). The two my runs made were deleted by exact name afterwards.
- sfw printed nothing and blocked nothing.

The Python uv downloaded, both runs alike:
- `cpython-3.13.17+20261021-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`, from the folder
  `https://releases.astral.sh/github/python-build-standalone/releases/download/20261021/` (Astral's address for the
  python-build-standalone release 20261021; the `+` is written `%2B` in the address). 21,986,637 bytes (the copy uv
  keeps in
  `UV_PYTHON_CACHE_DIR`), SHA-256 `56cde3b1a1dcc36576753cb408ee0c3568d211baafa0eee40423adc147c480f2` (computed here;
  uv names the kept copy with that hash's first 9 digits). Unpacked: 3,316 files, 62,727,698 bytes, in
  `install\python\cpython-3.13.17-windows-x86_64-none`, with a link `cpython-3.13-windows-x86_64-none` to it, which the
  environment's `pyvenv.cfg` names as its home.

The installed program: `C:\Users\<user>\AppData\Local\Temp\tachi-8d-build\env\Scripts\mempalace.exe --version`, run by
its full path with the install's environment (`HOME` and `USERPROFILE` in `install\home`): exit 0, `MemPalace 3.12.0`.
Its `--version` is argparse's version action (`mempalace/cli/parser.py`), so it opens no palace; `install\home` was
still empty afterwards. The environment also holds `mempalace-mcp.exe` and `mempalace-light-mcp.exe`.

Downloaded on this PC, file by file (`report install`): 85 package files, 86,095,655 bytes (82.1 MiB) together, plus
the Python archive above, 21,986,637 bytes. A file's size is the one the lock records for it: uv checks each file's
SHA-256 against the lock, so a file it took is byte for byte the one the lock describes. Every file the log fetched is
in the lock. The full list is printed by `report install` from the kept log `install\sync.log`. The ten largest, in
bytes:

| File | Bytes |
|---|---|
| chromadb-1.5.9-cp39-abi3-win_amd64.whl | 23,542,454 |
| onnxruntime-1.32.0-cp313-cp313-win_amd64.whl | 16,697,937 |
| numpy-2.5.5-cp313-cp313-win_amd64.whl | 12,573,354 |
| kubernetes-37.0.3-py2.py3-none-any.whl | 7,511,682 |
| grpcio-1.85.3-cp313-cp313-win_amd64.whl | 5,607,144 |
| hf_xet-1.8.0-cp38-abi3-win_amd64.whl | 3,911,559 |
| tokenizers-0.23.3-cp310-abi3-win_amd64.whl | 2,872,101 |
| pydantic_core-2.50.4-cp313-cp313-win_amd64.whl | 2,262,887 |
| pygments-2.21.0-py3-none-any.whl | 1,250,147 |
| mempalace-3.12.0-py3-none-any.whl | 1,140,726 |

The other 75 files come to 8,725,664 bytes.

The tamper run (`tamper`): its own folder `tachi-8d-build\tamper`, with its own empty uv cache, Python folder and
environment folder. Its copy of the lock differs from `memory/uv.lock` on one line only, the
`mempalace-3.12.0-py3-none-any.whl` line, whose hash is `sha256:4832534f...52626f` in place of
`sha256:3832534f...52626f` (the first digit changed). The same command, exit 1 in 7.5 s, after downloading its own
Python 3.13.17:

    error: Failed to download `mempalace==3.12.0`
      cause: Hash mismatch for `mempalace==3.12.0`
             Expected:
               sha256:4832534f377f3a81a324f741f90bf3c1ec277d49404608257cde1b5b0d52626f
             Computed:
               sha256:3832534f377f3a81a324f741f90bf3c1ec277d49404608257cde1b5b0d52626f
    hint: `mempalace` (v3.12.0) was included because `tachikoma-memory` (v0) depends on `mempalace`

- uv's refusal names the package and version, not the wheel's file name. Its text (`tamper\sync.log`, lines 1103 and
  1104) is "error: Failed to download `mempalace==3.12.0`" and "cause: Hash mismatch for `mempalace==3.12.0`". The
  wheel's file name, `mempalace-3.12.0-py3-none-any.whl`, is in the request lines for its address just before
  (`tamper\sync.log`, lines 354 to 359 and 665 to 666). The lock has one mempalace wheel (`memory/uv.lock` line
  1314; its only other mempalace file is the source package on line 1312, which neither run's log names), so the
  package and version identify that wheel, and "Computed" is its real hash. The user accepted this as
  meeting the check on 2026-11-19.
- Nothing was installed: `tamper\env\Lib\site-packages` is empty, and no name in `tamper\env` starts with
  `mempalace`. The only mempalace entry in the tamper cache is an empty lock file
  (`wheels-v7\pypi\mempalace\3.12.0-py3-none-any.lock`).
- uv had sent all 85 package requests before it stopped (56 answers had come in).

The snapshot of the user's folders (`step4-before`, `step4-after`): "no change", apart from the set-apart line of the
user's own MemPalace daemon folder.

Kept for later steps: `tachi-8d-build\env` (the environment) and `tachi-8d-build\install` (its uv cache, its Python,
which the environment needs, the Python archive and `sync.log`). Also left, for step 31 to remove with the build
folder: `tachi-8d-build\tamper` and the snapshots.

### Step 5 The embedding model (2026-11-19)

In short: MemPalace 3.12.0 takes all-MiniLM-L6-v2 through chromadb 1.5.9. chromadb downloads one archive from a fixed
Amazon S3 address, holds its SHA-256, and puts it under the home folder. The archive was downloaded once, by hand,
and matched that hash. Copied into the build home, it let MemPalace add one entry and find it again, with its
connections watched and a dead-end proxy in place. Python's own socket, HTTP and process calls reached nothing but
this computer, and the dead-end proxy received nothing. What that does not cover is under "Known limits" below. The
user approved the address, the hash and the size below on 2026-11-19, to be fixed in the code.

Script: `scripts/8d/model-check.mjs`, run as `node scripts/8d/model-check.mjs place` and then `run`. Source read in
the installed packages in `tachi-8d-build\env\Lib\site-packages` (not on the web).

**Address:** `https://chroma-onnx-models.s3.amazonaws.com/all-MiniLM-L6-v2/onnx.tar.gz`
(`chromadb/utils/embedding_functions/onnx_mini_lm_l6_v2.py:42-44`, `ONNXMiniLM_L6_V2.MODEL_DOWNLOAD_URL`). It is
fetched with `httpx.stream("GET", url)` (`:107`), which follows no redirect and honours the proxy variables
(`httpx/_api.py:124`, `:138`, `:140`). No other copy of the address or the hash is in site-packages (grep), and
chromadb's Rust module does not name it.

**Version: none fixed.** The address names no commit, version or S3 version id. The download's headers say
`x-amz-version-id: null` (S3 keeps no version id for the object), `ETag: "c319dd36af997be17ffb4669076b13a0-5"` (a
multipart upload, so not the file's MD5) and `Last-Modified: Thu, 30 Mar 2023 23:38:52 GMT`. So the address has no
exact unchanging version. On 2026-11-19 the user accepted the hash check alone in place of the design's "an exact
unchanging version" (section 2, "The model is locked like the packages") and "an exact version" (the summary's
item 4). The installer (plan step 19) downloads the archive from this address, checks it against this SHA-256, and
unpacks it into `memory/home`.

**SHA-256:** `913d7300ceae3b2dbc2c50d1de4baacab4be7b9380491c27fab7418616a16ec3`, the archive's hash
(`onnx_mini_lm_l6_v2.py:45`, `_MODEL_SHA256`). The download's hash (`Get-FileHash -Algorithm SHA256`) is the same.
- chromadb checks it after each download, deleting a file that does not match and trying up to 3 times on that error
  only (`:22-29`, `:92-97`, `:120-124`). It checks an archive already on disk the same way before downloading
  (`:302-307`).
- The unpacked files are never hashed: when all six are present, nothing is checked or fetched (`:285-299`).
- MemPalace holds no hash of its own for the model.

**Size:** 83,178,821 bytes, the downloaded file's length and its `Content-Length`. The packages hold no size.

**The archive's files** (`tar -tvzf`), all under `onnx/`, no links, 91,332,068 bytes unpacked: `config.json` 650,
`model.onnx` 90,387,606, `special_tokens_map.json` 125, `tokenizer_config.json` 518, `tokenizer.json` 711,661,
`vocab.txt` 231,508. These are the six files chromadb requires (`:285-292`).

**Folder:** `Path.home()\.cache\chroma\onnx_models\all-MiniLM-L6-v2` (`:39`), with the archive as `onnx.tar.gz` in it
and the files unpacked into `onnx\` (`:40-41`, `:293`, `:312-317`, `filter="data"` on Python 3.12 and later).
- It is fixed when chromadb is imported, so the variable must be set before the process starts.
- `Path.home()` is `expanduser("~")` (the build's Python, `Lib/pathlib/_abc.py:755-758`): `USERPROFILE` on Windows,
  else `HOMEDRIVE`+`HOMEPATH` (`Lib/ntpath.py:362-368`); `HOME` on Linux and macOS (`Lib/posixpath.py:244-251`).
- No chromadb or MemPalace setting moves it, and `HF_HOME`, `XDG_CACHE_HOME` and `MEMPALACE_CONFIG_DIR` do not.
- In the build: `tachi-8d-build\install\home\.cache\chroma\onnx_models\all-MiniLM-L6-v2\onnx.tar.gz`, copied (`place`,
  never over an existing file) from `tachi-8d-build\model-download`, which stays. Both copies were checked against
  the approved hash and size.

**Which embedding:** MemPalace's `_MempalaceONNX` is a subclass of chromadb's `ONNXMiniLM_L6_V2`
(`mempalace/embedding.py:316-384`), chosen for `minilm` and any unknown model name (`:1416-1419`). It uses the same
address, hash and folder (`:373`). `sqlite_exact` requires the vectors to be handed to it
(`mempalace/backends/sqlite_exact.py:648-649`, `:1025-1028`, `:1733`). MemPalace's wrapper makes them with that same
function (`mempalace/backends/embedding_wrapper.py:30-32`, `:83-87`; `mempalace/embedding.py:1026-1048`), so
`sqlite_exact` fetches the same one file.

**Settings for no download at run time**, each with what it does in the code:
- The model in place: the six files in `onnx\`, or the archive with the right hash, which chromadb unpacks without
  fetching (`onnx_mini_lm_l6_v2.py:285-311`). This is what stops the download; it is checked on every embedding call
  (`:270`).
- `USERPROFILE` (Windows) and `HOME` (elsewhere) pointing at the home that holds it (`:39`; `ntpath.py:362`;
  `posixpath.py:244`).
- `MEMPALACE_EMBEDDING_MODEL=minilm` (`mempalace/config.py:1184-1187`). The variable beats `embedding_model` in
  `config.json`, so a file naming `embeddinggemma`, whose model comes from Hugging Face (`mempalace/embedding.py:
  629-650`), cannot apply.
- `HF_HUB_OFFLINE=1` (`huggingface_hub/constants.py:194-213`, which also reads `TRANSFORMERS_OFFLINE`). It makes
  huggingface_hub refuse every request. It has no effect on MiniLM, which never uses huggingface_hub; it is set as a
  guard for the Hugging Face models.
- No `updates.json` in `<home>\.mempalace` (or one with `"enabled": false`). MemPalace's release check, the one other
  outside address in its add, search and server path (`https://pypi.org/pypi/mempalace/json`,
  `mempalace/update_awareness.py:84`), runs only when that file says enabled (`:139-143`, `:221-226`; folder
  `mempalace/paths.py:34-37`). It is started at server start (`mempalace/mcp_server/runtime.py:392-397`), on
  `mempalace_status` (`mempalace/mcp_server/protocol.py:694-698`) and in `mempalace/mcp_proxy.py:141-142`. It is off by
  default, and no variable turns it off.
- No `ANONYMIZED_TELEMETRY` set to true. MemPalace sets it to `False` unless it is already set
  (`mempalace/__init__.py:70`) and passes `anonymized_telemetry=False` to its clients (`mempalace/backends/chroma.py:
  113`). chromadb's telemetry client is an empty stub anyway (`chromadb/telemetry/product/posthog.py:8-10`).
- No `CHROMA_OTEL_COLLECTION_ENDPOINT` or `CHROMA_OTEL_GRANULARITY`: the defaults, an empty address and `"none"`, send
  no spans (`chromadb/config.py:229-232`; `chromadb/telemetry/opentelemetry/__init__.py:51-58`, `:83-84`). That
  chromadb's pydantic `Settings` (`chromadb/config.py:112`) would read these names from the environment is inferred,
  not traced.
- Not settings, but they bear on downloads. `MEMPALACE_EAGER_WARMUP` moves the model load, and any download, to start
  up (`mempalace/mcp_server/protocol.py:1176`). The proxy variables decide where a download would go
  (`httpx/_utils.py:31-54`; on Windows, with none set, `urllib.request.getproxies` falls back to the system's proxy
  setting, build Python `Lib/urllib/request.py:2764-2771`).

**The run, connections watched and a dead-end proxy in place** (`run`, 2026-11-19, after the review fixes; exit 0,
"model check: passed"):
- It used the build's own server: `tachi-8d-build\env\Scripts\python.exe -I -c <wrapper> <audit log>
  mempalace.mcp_server --palace tachi-8d-build\install\home\palaces\model-check-2026-11-18T21-31-28-961Z --backend
  sqlite_exact --transport stdio`. The wrapper runs `mempalace.mcp_server` directly. That is the path the
  `mempalace-mcp` front end (`mempalace.mcp_proxy:main`) takes when it finds no hub for the palace
  (`mempalace/mcp_proxy.py:415-418`); its proxy to a hub was not used. It ran in a new palace, with step 1's `install`
  environment (every `MEMPALACE_*` of the user's dropped).
- Before starting, the script checked that the installed chromadb file still names the approved address and hash.
- The settings above were in force: `HF_HUB_OFFLINE=1`, `MEMPALACE_EMBEDDING_MODEL=minilm`, no `updates.json`, and no
  `ANONYMIZED_TELEMETRY`, `CHROMA_*` or `PYTHON*`. `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` pointed at the script's
  dead-end listener on `127.0.0.1`, with `NO_PROXY=127.0.0.1,localhost,::1`.
- Over MCP:
  - `initialize` (protocol 2025-06-18);
  - `mempalace_add_drawer` with wing `check`, room `model`, a one-line entry and `source_file` gave
    `"success": true`, `"chunks": 1`;
  - `mempalace_search` on that wing and room found the entry.
  The server shut down on the end of input with exit 0.
- The model: the first run, before the review fixes, found only the placed archive. chromadb unpacked it into `onnx\`
  itself: the six files, each the size the archive lists, and that server's log says "Embedding function initialized
  (model=minilm device=cpu providers=['CPUExecutionProvider'])". The run after the fixes found those files already
  there. The archive was still as approved after both runs. Each palace is a `sqlite_exact.sqlite3`.
- The connection log, the same in both runs:
  - the wrapper's own loopback check was seen (`socket.getaddrinfo 127.0.0.1`, `socket.connect 127.0.0.1`), so the
    hook was working;
  - Python's urllib and httpx both reported the dead-end proxy, with the loopback names exempt;
  - from the server: **0 name lookups, connections, sends or HTTP requests through Python's own code, to any
    address**, and **0 child processes**.
- The dead-end listener: **0 connections** in both runs.
- What appeared under the build home: the model's folder, `.config\mempalace\wal\write_log.jsonl`,
  `.mempalace\locks\mine_palace_<16 hex>.lock`, a `.<palace>.mempalace.lock` beside each palace, and the palaces.
  Nothing new appeared at the top of the user's Temp folder during the first run.
- The server dying: `run tachi_8d_no_such_module` points the wrapper at a module that does not exist. Python stopped
  with "ImportError: No module named tachi_8d_no_such_module" and exit 1. Every call got "the server is gone:
  exit 1" in place of an answer. The listener closed, and the run ended "model check: FAILED" with exit 1, without
  hanging. The run ends on the server's exit, or on its failing to start; it has no time limit. A server that fails
  to start at all takes the same path in the code, but that was not run.
- **Known limits:**
  - The dead-end proxy stops only code that honours the proxy variables (httpx and urllib do).
  - The connection log sees only what goes through Python's own socket, HTTP and urllib code and its process calls.
  - Connections opened by native code (onnxruntime, chromadb's Rust part, gRPC) bypass both. Seeing those on Windows
    needs admin rights or a system change (`pktmon`, `netsh trace`, a firewall rule), which the build does not make.
    The source shows no such connection on this path.
- Seen for later steps: the environment from step 1's helper still holds the user's own `HOMEDRIVE` and `HOMEPATH`.
  Python uses them only when `USERPROFILE` is unset (`ntpath.py:362-368`), and the helper always sets it.

The snapshots of the user's folders:
- Around the first run (`step5-before` to `step5-after`): "no change", apart from the set-apart line of the user's own
  MemPalace daemon folder `daemon/<palace key>`.
- Around the run after the fixes (`step5-fix-before` to `step5-fix-after`): the same.
- Between the two (`step5-after` to `step5-fix-before`, about 11 minutes): not clean. The user's own `~/.mempalace`
  changed in these places outside the set-apart ones:
  - `palace/sqlite_exact.sqlite3` and its `-wal`;
  - `wal/write_log.jsonl`;
  - `locks` and `locks/mine_palace_<palace key>.lock`;
  - `hook_state/last_checkpoint`;
  - two `hook_state/<session>_last_save` files. One is
    `hook_state/<session>_last_save`. Its name matches the session folder in the build's
    scratchpad path (`...\Temp\claude\<id>\<session>\scratchpad`), so it is
    taken to be this build's Claude Code session. The commit trailers carry a different session ID
    (`<session>`).

  These set-apart items changed too (they do not fail):
  - `hook_state/hook.log` at 21:28:37 UTC;
  - `daemon/<palace key>/queue.sqlite3` at 21:29:10 UTC;
  - the folder `daemon/<palace key>` itself, at 21:30:58 UTC. Its time moves in every pair of listings in
    this build.

  The times come from `snapshots\step5-after.json` and `step5-fix-before.json`, converted with Node.

  Every change outside the set-apart places, and the two set-apart files, falls between 21:25:05 and 21:29:10 UTC.
  By their names and those times, they look like the user's own MemPalace plugin saving this and another Claude Code
  session after replies. This is an inference from the file names and times: it was not traced, and the user did not
  say it. Under the user's rule (step 1) these changes still count as a difference.
- The stand-in run that shows the run ending FAILED (`run tachi_8d_no_such_module`) had no pair of listings of its
  own: it lies inside this gap pair. It is not the cause:
  - it started at 21:30:51 UTC, after every change above except the set-apart daemon folder's own time;
  - its `USERPROFILE` and `HOME` pointed at the build home. The run uses step 1's `install` environment
    (`scripts/8d/model-check.mjs:77`, `:163`; `throwaway` sets `USERPROFILE` and `HOME` to `<build>\install\home`,
    `scripts/8d/throwaway.mjs:34-35`);
  - Python stopped on the import, before MemPalace was loaded.
- The user's choice, 2026-11-19: **check around each run.**
  - From now on, only the listings taken just before and just after each build run are compared. Those must show no
    change outside the set-apart places.
  - Changes in the gaps between runs are listed in the record and do not fail.
  - The palace files are not set apart: a change to them around a run still fails.
  - The snapshot script's rules are unchanged; the choice only decides which pairs of listings are compared.
  - Under this choice, step 5 passes. Both pairs taken around a run (`step5-before` to `step5-after`, and
    `step5-fix-before` to `step5-fix-after`) show no change. The gap pair (`step5-after` to `step5-fix-before`) is the
    one listed above.

Kept for later steps: the model in `tachi-8d-build\install\home\.cache\chroma\onnx_models\all-MiniLM-L6-v2` and the
download in `tachi-8d-build\model-download`. For step 31 to remove with the build folder: the palaces in
`install\home\palaces`, and each run's logs, `install\model-check-<time>.audit.jsonl` and `.stderr.log`.

### Step 6 What MemPalace 3.12.0 really does (2026-11-19)

In short: every check the plan lists came out "can" for MemPalace 3.12.0. A hub takes the port Tachikoma gives it and
exits at once when that port is taken. It has no shutdown of its own, so it is stopped by its process number. On
Windows, `mempalace serve` is four processes, and stopping the one Tachikoma started leaves the real server running.
A hub started detached and hidden outlives the process that started it. A second writable hub on the same palace exits
at once with `MEMPALACE_MCP_WRITER_WAIT_SECONDS=0`, and otherwise waits up to 120 s. Entries can be looked up and
removed by their exact label, and a long entry's pieces counted. Adding the same text twice to one room adds it once.
The backend and the model are chosen by a flag and a setting, and both can be read back. MemPalace 3.6.0, the user's
copy, offers every tool Tachikoma needs under the same names. Questions Q7, Q8 and Q19, and four new ones these
findings raised, were answered by the user on 2026-11-19 (at the end of this part).

Script: `scripts/8d/mempalace-checks.mjs`, run as `node scripts/8d/mempalace-checks.mjs run`. The figures below come
from its fifth run, saved with that run's logs as
`tachi-8d-build\install\checks-2026-11-18T22-22-27-935Z\results.json`. The script was run five times on 2026-11-19,
local time (22:00 to 22:24 UTC on 2026-11-18):
- Run 1: the same answers, but its tool calls went to a `serve` hub, out of the audit hook's reach.
- Run 2: the same answers, with the tool calls moved to a hub watched in full (see "The connection watch").
- Run 3: stopped after starting two hubs, on a fault in the script (it wrote to a result before making it). Its
  clean-up ran, and a look by id afterwards found none of its processes running.
- Run 4: the same answers, but its pair of listings was not clean (see "The user's folders"), and its last process
  check counted another program's process as the script's (see "Processes").
- Run 5: the same answers, with the pair of listings clean and nothing left running.

The script's exit code shows only two things: the connection watch found nothing, and no process of the script's was
left running. The 12 answers are what the run recorded in `results.json`, read from it for this record; the exit
code does not check them.

MemPalace's source was read in the installed packages, `tachi-8d-build\env\Lib\site-packages`. All `mempalace/...`
paths below are there.

How it was run:
- The build's own Python, `tachi-8d-build\env\Scripts\python.exe`, always by its full path and always with `-I`. Step
  1's `install` environment, with the model step 5 placed in `install\home`.
- Step 5's settings: `HF_HUB_OFFLINE=1`, `MEMPALACE_EMBEDDING_MODEL=minilm`, and a dead-end proxy of the script's on
  `127.0.0.1` in `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY`, with `NO_PROXY` for the loopback names. No `MEMPALACE_*`
  of the user's; the only `MEMPALACE_*` values were the build's own (`MEMPALACE_CONFIG_DIR`,
  `MEMPALACE_EMBEDDING_MODEL`, and `MEMPALACE_MCP_WRITER_WAIT_SECONDS=0` for one start in item 5).
- Every hub was given a new palace under `install\home\palaces` with `--palace`, and `--backend sqlite_exact`, except
  the one start in item 12 that makes a chroma palace on purpose.
- Every port was one the script took from the system on `127.0.0.1` and let go just before the start. None was 8765.
- Two kinds of start. "serve": `python -I -c <wrapper> mempalace serve --host 127.0.0.1 --port <p> --palace <palace>
  --backend sqlite_exact`. "direct": the same, but `mempalace.mcp_server --transport http ...`, which is the server
  `serve` runs as its child (`mempalace/cli/cmd_serve.py:144-153`). The wrapper is step 5's audit-hook wrapper.
- Processes: each process the script started, and each one below it (found by its parent's id, started after its
  parent), was recorded with the start time Windows gives it. Each was stopped only by its id, after its start time was
  read again and found the same. No other process was stopped, signalled or asked about.

**Item 1. A port Tachikoma picks, and one already taken.** `serve --port <p>` binds exactly that port: the hub
answered `GET /healthz` on it, and `serverinfo.json` records it. With the port already held by another listener on
`127.0.0.1`, the hub exits with code 1 after about 2.5 s (2,473 ms from the start, most of it Python starting),
saying `Failed to start MCP HTTP server on 127.0.0.1:<p>: [WinError 10048] Only one usage of each socket address
(protocol/network address/port) is normally permitted`. The other listener kept its port, and no `serverinfo.json` was
written. Source: on Windows the hub binds with `SO_EXCLUSIVEADDRUSE` (`mempalace/mcp_server/http.py:1391`), and a
failed bind exits 1 (`:1584`). It takes the writer lease before it binds (`mempalace/mcp_server/runtime.py:294-298`), so
a hub that fails on its port has held the palace lock for that moment and lets it go when it exits. Not run: port 0,
which would let MemPalace pick (`http.py` builds the server so "an ephemeral port=0 bind (tests) still matches").

**Item 2. No shutdown of its own; the processes a hub is; reading their start times.**
- No shutdown: the HTTP server has no route or tool that stops it (`http.py:733-764` and `:1464-1545`: GET `/healthz`,
  `/statusz`, `/logstream/stream`, `/sync/*`; POST `/mcp` only). It turns SIGTERM into a clean exit
  (`runtime.py:332-358`), but on Windows Node's `process.kill` always ends a process outright, so its clean-up
  (`atexit`) does not run.
- Its own idle exit: a hub with no MCP request for 8 hours exits by itself (`MEMPALACE_MCP_IDLE_HOURS`, default 8,
  `mempalace/mcp_server/_guards.py:141`, `:895-902`; started in HTTP mode at `runtime.py:306`; the watchdog,
  `mempalace/mcp_server/protocol.py:1393-1421`). `GET /healthz` does not count as a request: only MCP requests
  (`protocol.py:1021-1029`) and the event stream (`http.py:1295`) reset the clock. Not run (8 hours). `0` turns it off
  (`protocol.py:1401`).
- The processes. `env\Scripts\python.exe` is a small launcher (46,592 bytes; the real `python.exe` in
  `install\python\cpython-3.13.17-windows-x86_64-none` is 91,648 bytes) that starts the real interpreter as its child.
  So, found by parent id in the run:
  - a "serve" hub is four processes: the launcher Tachikoma's start returns, the interpreter running `serve`, a second
    launcher that `serve` starts with `subprocess.run` (`cmd_serve.py:186-192`), and the interpreter that serves;
  - a "direct" hub is two: the launcher and the interpreter that serves.
  - `serverinfo.json`'s `pid` is the interpreter that serves, the last of the chain (`os.getpid()` in
    `mempalace/server_registry.py:128`; matched in the run: `pid` 284728, the fourth of four).
- Stopping, as seen in the run:
  - "serve", stopping only the launcher Tachikoma started: that launcher and the interpreter under it ended, but the
    second launcher and the serving interpreter kept running, the hub still answered on its port, and the palace stayed
    locked. They were stopped by id afterwards.
  - "serve", stopping only the serving interpreter (`serverinfo.json`'s `pid`): the other three ended by themselves
    within 1,115 ms (the script's first look after the stop; each look takes about 1.1 s).
  - "direct", stopping only the launcher: the interpreter ended with it, and the hub stopped answering; nothing was
    left to stop.
  - After a hard stop `serverinfo.json` stays, naming a process that is gone. MemPalace's own readers skip such a file
    because the process is gone (`server_registry.py:223-240`); the next hub overwrites it.
- Start times. Node has no call for another process's start time. Three ways were timed, three reads each, on the same
  serving process; all three gave the same time:
  - the build's own Python with `ctypes` (`GetProcessTimes`, the script's `START_TIME_PY`): 123 to 126 ms;
  - PowerShell `(Get-Process -Id <pid>).StartTime`: 322 to 327 ms;
  - PowerShell `Get-CimInstance Win32_Process`: 1,139 to 1,181 ms (to the microsecond; the other two to 100 ns).
  - The hub's own `started_at` in `/statusz` (`http.py:393`) is when the server was built, about 1 s after the process
    started (22:22:42.400 UTC against 22:22:41.381), so it is not the process's start time.

**Item 3. A hub started detached and hidden outlives the process that started it.** A short-lived Node process started
each kind with `spawn(..., { detached: true, windowsHide: true, stdio: [ignore, file, file] })`, printed its id and
exited (exit 0 in about 0.12 s). Both hubs then answered `/healthz` on their ports, with every process of theirs still
running (serve: 5 processes, direct: 3). Windows gave each a hidden console: a `conhost.exe` appeared under the
interpreter that the detached launcher started, and no process of either hub had a main window (`MainWindowHandle` 0
for each, from `Get-Process`). Both were then stopped by id.

**Item 4. `serverinfo.json`.** It is at `<home>\.mempalace\server\<key>\serverinfo.json`, so for Tachikoma
`memory/home/.mempalace/server/<key>/serverinfo.json`. `<key>` is the first 24 hex digits of the SHA-256 of the
palace's full path, resolved and lower-cased as Windows compares paths (`mempalace/paths.py:184-194`;
`server_registry.py:51-65`); the script worked it out from the palace path and it matched the folder's name. Its
contents (written after the bind, `http.py:1594-1617`; `server_registry.py:127-136`):

    {"pid": <the serving interpreter>, "host": "127.0.0.1", "port": <p>, "scheme": "http", "read_only": false,
     "capabilities": ["mine_include_ignored", "mine_include_subagents", "search_cli_compatible"],
     "search_config_fingerprint": "<64 hex>", "palace_path": "<the palace's full path>"}

It records no start time. Also seen in the server folder: `mesh_state.json` (`{"pid", "written_at", "peers": {},
"profiles": {}}`, `server_registry.py:145-175`). No `token` file is written for a loopback hub
(`cmd_serve.py:107-126`). What else appeared under the home folder: `.mempalace\locks\mine_palace_<16 hex>.lock` for
each palace, `.mempalace\locks\.last_reap`, and `.config\mempalace\wal\write_log.jsonl` (each write logged). In the
palace folder: `sqlite_exact.sqlite3` (with `-wal` and `-shm`), `logstream.sqlite3` (with `-wal` and `-shm`) and
`replica.json` (`{"replica_id": "rep_<32 hex>", "minted_at_note": "RFC 004 step 0"}`), and beside the palace a
`.<palace>.mempalace.lock` (step 5). Nothing appeared outside the build home.

**Item 5. A second writable hub on the same palace.**
- With `MEMPALACE_MCP_WRITER_WAIT_SECONDS=0`: it exited with code 2, 2,436 ms after its start, without ever
  answering, saying `Writable MCP HTTP startup refused: another mempalace writer already holds the palace lock for
  '<palace>': palace <palace> is held by PID <the first hub's serving interpreter> (...); wait for it to finish or stop
  the holder before retrying`. Source: `runtime.py:232-254`, `:294-297` (`0` means "refuse at once").
- With MemPalace's default: it logged `Writable MCP HTTP startup is waiting up to 120 s for the writer lease: ...`
  (seen 1,187 ms after the script began watching its log, which began about 1.1 s after the start) and did not
  answer. When the first hub was stopped, it took the lease and answered (7,546 ms after the first stop call; that
  includes about 4 s of the script's own process looks). It tries again at growing gaps of 0.5, 1, 2, 4 and then
  5 s (`runtime.py:263-276`), and exits 2 when 120 s run out (`runtime.py:217`, `:265-267`).

**Item 6. Tachikoma's MCP client can call the hub.** `Client` and `StreamableHTTPClientTransport` from
`@modelcontextprotocol/client` 2.4.0, imported as `src/mcp/server.ts:6-24` does, with no fetch of their own (so Node's
plain `fetch`), connected to `http://127.0.0.1:<p>/mcp` (17 ms), listed the 47 tools and made every call in
items 7 to 12. The library also tried, twice, to open an event stream with `GET /mcp`, which the hub answers with 404;
it reported `Failed to open SSE stream: Not Found` to the client's `onerror` both times, and every call still worked.
The hub's own checks, sent by hand: `Content-Type: text/plain` gets 415 (`http.py:1476-1479`); a `Via` or an
`X-Forwarded-For` header gets 403 (`http.py:273-293`, `:427-433`); `application/json` gets 200. Node's `fetch` adds no
such header and does not use the proxy variables.

**Item 7. The tools, by the table "What each palace must offer".** From `tools/list` of the running hub (input names,
with type; `*` = required):
- Required of every palace:
  - search: `mempalace_search` (`query`* string, at most 250 characters; `limit` integer, 1 to 100; `wing`, `room`,
    `source_file`, `since`, `before` strings; `max_distance` number; and others). A query of 251 characters is
    refused: `-32602 Invalid params for tool mempalace_search: 'query' must be at most 250 characters`.
  - add an entry: `mempalace_add_drawer` (`wing`*, `room`*, `content`* strings; `source_file`, `added_by` strings).
    The plan took adding an entry to need `source_file`; the schema requires only `wing`, `room` and `content`.
    Tachikoma's saver must always send `source_file`, as step 22's look-ups and removals go by it.
- Used when a palace offers them:
  - entries by exact `source_file`: `mempalace_delete_by_source` with `dry_run` true (its default), which reports
    `match_count` (item 8); also `mempalace_search` with `source_file`.
  - remove them by it: `mempalace_delete_by_source` (`source_file`* string, `dry_run` boolean `false`).
  - report a duplicate: `mempalace_add_drawer` itself (item 9); also `mempalace_check_duplicate` (`content`* string,
    `threshold` number).
  - count entries by room: `mempalace_list_rooms` (`wing` string) gives `{"wing", "rooms": {<room>: <count>}}`, but it
    counts pieces, not entries: a room with one short entry, one entry of three pieces and one lesson showed 5.
    Whole entries come from `mempalace_list_drawers` (`wing`, `room`, `since`, `before` strings; `limit`, `offset`
    integers), whose `total` counts them. Later in the run, with one more entry in each room, `mempalace_status`
    counted 6 pieces in the project's room and 3 in `lessons`, and `total` counted 4 entries and 3.
    `mempalace_status` also gives `rooms` and `total_drawers`, in pieces.
- One search over two rooms: no. `room` must be one string (`-32602 Invalid params for tool mempalace_search: 'room'
  must be a string`), and a comma is not allowed in a room name. A search with the wing and no room covers every room
  in the wing (the run's hits came from three rooms).

**Item 8. Look up and remove by exact label, and the number of pieces.** Yes, for 3.12.0.
- Look up: `mempalace_delete_by_source` with `{"source_file": "<label>"}` and no `dry_run` (true by default) gives
  `{"success": true, "dry_run": true, "match_count": <pieces>, ...}` and removes nothing. In the run: 3 for the long
  entry, 1 for the short one, 0 for a label never used, and 0 for the start of a label (`tachikoma session check-1`):
  the match is exact (`mempalace/mcp_server/tools_write.py:1047-1080`, `where = {"source_file": source_file}`).
- Remove: the same with `"dry_run": false` gave `{"success": true, "dry_run": false, "deleted": 3}`; a look-up then gave
  0, and adding the entry again worked (3 pieces).
- Pieces: `mempalace_add_drawer` answers `"chunks": <n>` (and `chunk_ids` when more than 1). A long entry is cut every
  800 characters (`DEFAULT_CHUNK_SIZE = 800`, `mempalace/config.py:415`; `tools_write.py:603-616`), so `<n>` is the
  text's length divided by 800, rounded up: 2,016 characters gave 3. MemPalace counts characters as Python does, by
  code point: 799 `x` and one emoji, 801 in JavaScript's `length` but 800 code points, gave 1 piece.
- One add is all or nothing: all its pieces go in one `upsert`, in one SQLite transaction that is rolled back on any
  error (`tools_write.py:612-616`; `mempalace/backends/sqlite_exact.py:503-523`, `:690-698`). So a half-saved turn can
  only come from a crash between two of Tachikoma's own calls (for example between a removal and the add), not from
  inside one add.
- Limit: an entry may be at most 100,000 characters: 100,001 gave `{"success": false, "error": "content exceeds maximum
  length of 100000 characters"}` (`config.py:283-291`).

**Item 9. Adding skips a duplicate, and says so.** Yes, for exactly the same text in the same wing and room: the entry's
id is made from the wing, the room and the text only (`mempalace/ids.py:71-80`), and an id already there is answered
`{"success": true, "reason": "already_exists", "drawer_id": "<the existing id>"}` and nothing is added
(`tools_write.py:518`, `:553-567`). In the run: the same lesson again, with the same label or another label, was
`already_exists`; the same text in another room was added; a lesson differing by one word was added; a long entry
added again under another label was `already_exists`. So the label plays no part in it. `mempalace_check_duplicate` is
the other way: it compares meaning, over the whole palace (it takes no wing or room), with MemPalace's default
threshold of 0.9 (`mempalace/mcp_server/tools_read.py:777-833`). It found the lesson (similarity 1, in both rooms) and
the one-word variant (0.997), and nothing for an unrelated sentence.

**Item 10. Room names, and a file MemPalace does not know.**
- Rules (`config.py:36-37`, `:137-162`, `sanitize_name`; run on 22 names): at most 128 characters (129 refused); the
  first and the last character a letter or a digit of any script; between them letters, digits, `_`, space, `.`, `'`
  and `-`; no `..`, `/` or `\`; spaces around the name are trimmed. Kept as given: `agent-harness-3f9a1c2b`,
  `Agent Harness-3F9A1C2B`, `cafe` with an accent, three Japanese letters followed by `-3f9a1c2b`, `app.v2-3f9a1c2b`,
  `lessons`, 128 `a`. Refused with "room contains invalid characters": `app_`, `_app`, `.app`, `app-`, and names with
  `(`, `)`, `+`, `#`, `@`, `&` or `,`. Refused with "room contains invalid path characters": `a..b`, `a/b`, `a\b`.
- A room keeps its letter case and the room filter matches it exactly: a search for room `caseroom` found nothing filed
  under `CaseRoom`. The wing is lower-cased (`Tachikoma` was filed as `tachikoma`, `config.py:51-78`).
- A file MemPalace does not know: `tachikoma-palace.json`, put in the palace folder before the first hub opened it,
  had the same SHA-256 and change time after all the run's hubs had opened, written to and closed the palace. MemPalace
  finds a palace's backend only by its own file names (`mempalace/palace/backend.py:95-104`;
  `mempalace/backends/registry.py:153-169`).

**Item 11. The user's MemPalace 3.6.0, for `"use"`** (read in
`C:\Users\<user>\.claude\plugins\marketplaces\mempalace\mempalace\mcp_server.py`, `version.py:3` "3.6.0"; not run):

| Tool | Group | In 3.6.0 | Where |
|---|---|---|---|
| `mempalace_search` (`query`, `wing`, `room`, `source_file`, `limit`) | required | in 3.6.0 | `:4255-4294`, `:2028` |
| `mempalace_add_drawer` (`wing`, `room`, `content`, `source_file`) | required | in 3.6.0 | `:4310-4329`, `:2530` |
| `mempalace_delete_by_source`, dry run: look up by label | optional | in 3.6.0 | `:4446-4466`, `:2948-3020` |
| `mempalace_delete_by_source`, remove by label | optional | in 3.6.0 | the same |
| duplicate report: `mempalace_add_drawer`'s `already_exists` | optional | in 3.6.0 | `:2593-2601` |
| `mempalace_check_duplicate` | optional | in 3.6.0 | `:4295-4309`, `:2104` |
| `mempalace_list_rooms` (`wing`), counts by room | optional | in 3.6.0 | `:4004-4013`, `:1919-1933` |
| `mempalace_list_drawers` (`wing`, `room`, `limit`) | optional | in 3.6.0 | `:4493` |

Lines are in `mcp_server.py`. Differences that matter: 3.6.0's search drops results further than 1.5 by default (its
schema, `:4284`; `tool_search`, `:2034`), where 3.12.0 has no default cut-off; 3.6.0 does not lower-case the wing
(`:2547`); 3.6.0 has no `mempalace_get_drawers` or `mempalace_delete_drawers`. Room rules, the 100,000-character
limit and the 800-character pieces are the same (3.6.0's `config.py:27-28`, `:210-217`, `:274`). So the `"use"` path
does not need a newer MemPalace than 3.6.0.

**Item 12. The backend and the model, chosen and read back** (Tachikoma's own palace only).
- Chosen: the backend with `--backend sqlite_exact`, which sets `MEMPALACE_BACKEND_EXPLICIT` and `MEMPALACE_BACKEND`
  (`mempalace/mcp_server/_guards.py:91-97`; `serve` passes it on to its server, `cmd_serve.py:134-148`). The explicit
  value comes first, before a `config.json` value, the variable and what is found on disk (`palace/backend.py:26-48`).
  The model with the setting `MEMPALACE_EMBEDDING_MODEL=minilm`, which comes before `embedding_model` in `config.json`
  (`config.py:1178-1187`). There is no flag for the model; the server ignores flags it does not know
  (`_guards.py:66-68`).
- Read back from the running hub: `/statusz` gives `"palace": {"backend": "sqlite_exact"}` and `"server": {"version":
  "3.12.0"}` (`http.py:381-403`); `mempalace_status` gives `"backend": "sqlite_exact"` and `"embedding_device": "cpu"`.
  Neither names the model.
- Read back from the palace: the palace file's `meta` table holds `embedder_model:mempalace_drawers = minilm`, and its
  `collections` table `mempalace_drawers` with dimension 384, read with `node:sqlite` read-only. The same read, made
  while the hub was running, gave `minilm`, and the hub answered a search right after. `minilm` is all-MiniLM-L6-v2
  (`mempalace/embedding.py:11`; `mempalace/config.py:1151`). Any other value MemPalace does not know also becomes
  `minilm`, with only a warning in the hub's log; only near misses of the other models' names are refused
  (`embedding.py:1242-1292`, used at `:1417`). So a read-back of `minilm` cannot tell a misspelt setting from the
  choice. A collection whose model is recorded refuses another model; one that holds entries but has no recorded model
  only warns (`mempalace/palace/collection.py:101-116`, `_enforce_embedder_identity`). A new palace records its model
  at its first write, as seen here.
- A hub on a palace made with the other backend: a palace made with `--backend chroma` (files `chroma.sqlite3`,
  `mempalace_embedder.json` and a folder) was given a hub with `--backend sqlite_exact`. It exited with code 2 about
  1.4 s after its start, never answering: `Writable MCP HTTP startup refused: could not acquire MCP peer-writer lock
  for '<palace>': BackendMismatchError("palace at '<palace>' contains 'chroma' backend artifacts, but 'sqlite_exact'
  was selected"); ...` (`palace/backend.py:56-63`; `runtime.py:294-297`).
- Items 1 to 10 ran with `--backend sqlite_exact` and `MEMPALACE_EMBEDDING_MODEL=minilm`.

**The connection watch.** The dead-end proxy received no connection. Each Python process the script started logged its
own loopback check, so its hook was working, and saw the dead-end proxy in urllib's and httpx's settings. From the
servers: no name lookup, connection, send or HTTP request through Python's own code to any address, in any of the nine
logs. The hub that served every tool call (`hd-direct`) was started directly, so its hook was in the serving process.
The only child process any logged process started was `serve`'s own server (one each). That child, and every `serve`
hub's serving interpreter, is started by MemPalace without `-I` and without the hook (`cmd_serve.py:132-149`,
`mempalace/_proc.py:97-123`, which sets `PYTHONSAFEPATH=1` and drops the working folder from the import path). Those
children were not watched. The dead-end proxy sees only HTTP sent through the proxy variables; it received nothing,
which does not show that they made no other connection. The venv's `site.py` turns the user's own site-packages off
for that child (`install\python\...\Lib\site.py:636-639`). Known limits as in step 5: native code is not seen.

**The user's folders** (step 5's rule: only the listings just before and just after each run are compared):
- Around runs 1, 2, 3 and 5 (`step6-before` to `step6-after`, and `step6-runN-before` to `step6-runN-after`): "no
  change", apart from the set-apart daemon folder `daemon/<palace key>` of the user's own MemPalace.
- **Around run 4 (`step6-run4-before` to `step6-run4-after`): not clean.** The user's own `~/.mempalace` changed in
  these places outside the set-apart ones, between 22:16:59 and 22:17:35 UTC, while run 4 ran (from 22:16:21 until
  its `results.json` was written at 22:17:47.8 UTC, the file's change time):
  - `hook_state/<session>_last_save` and `hook_state/last_checkpoint` (22:17:00);
  - `wal/write_log.jsonl` (22:16:59) and `locks/mine_palace_<palace key>.lock` (22:17:00);
  - `palace/sqlite_exact.sqlite3` (22:17:31), its `-wal`, and the folder `locks` (22:17:35).
  The set-apart `hook_state/hook.log` (22:17:00) and `daemon/.../queue.sqlite3` (22:17:35) changed too. The times are
  from the snapshot files, converted with Node. These are the same files as in step 5's gap, and the first is named
  after this build's Claude Code session.
  - The cause, traced (the review of this step): the user's own MemPalace plugin saves on the main Claude Code
    session's Stop hook, when that session finishes a reply, not on tool calls (the plugin's
    `.claude-plugin/hooks/hooks.json:4-9`; its `hooks_cli.py:1122-1134`). The session log shows the main session
    finishing a reply at 22:16:57.8 UTC. The plugin's files changed at 22:17:00.1 to 22:17:00.3 (`_last_save`,
    `last_checkpoint`, `hook.log`, the `mine_palace` lock), the user's palace at 22:17:31.8 and the daemon queue at
    22:17:35.3. No main-session reply fell inside run 5, and its pair is clean.
  - No code path of the build writes the user's `~/.mempalace` (the review's finding). Every MemPalace process of the
    build ran with `USERPROFILE` and `HOME` at the build home (`scripts/8d/throwaway.mjs:34-35`), so its state
    folder is the build home's `.mempalace` (`mempalace/paths.py:34-37`) and its hook state is under that
    (`mempalace/hooks_cli.py:45`). Its write log is under `MEMPALACE_CONFIG_DIR` (`mempalace/wal.py:24`), which is
    in the build home. Every palace path in the run logs is under `install\home\palaces`. The builder made no
    MemPalace MCP call and ran no `mempalace` command outside the scripted runs.
  - Under the user's rule this pair fails. The user accepted it on 2026-11-19, with this cause. The figures above are
    run 5's.
- In the gaps, listed only: `step5-fix-after` to `step6-before`, the daemon folder and `hook_state/hook.log`; each
  later gap between two runs, the daemon folder only. Nothing outside the set-apart places changed in any gap.

**Processes.** Run 5 started 23 processes of its own (21 `python.exe`, launchers and interpreters, and two
`conhost.exe`), listed with their ids and start times in `results.json`. At its end none of them, and no process
started by one of them, was running. Runs 1 and 2 ended the same way, and run 3 was checked by id afterwards. Run 4's
last check reported one process left: a `conhost.exe` started at 22:17:46.6 UTC, whose parent id, 279188, had been
the launcher of a hub that ended about 2.5 s after its start at 22:16:45.3. Windows had given that id to a later
process, so the `conhost.exe` belonged to another program. It was not stopped, signalled or asked about further, and
a look by those two ids afterwards found neither running. Run 5 ran with a fix: a process under a recorded id counted
as the script's only if it started before that recorded process was seen gone. Run 5 listed none apart. After the
review the rule is stricter and has not been run: a process under a recorded id counts as the script's only if it
started after that recorded process and no later than the last look that found it running
(`scripts/8d/mempalace-checks.mjs`, `isMine`). Any other is listed apart and left alone.

**For later steps** (findings, not decisions):
- Step 18: the client should not treat the library's `Failed to open SSE stream: Not Found` as a failure; it comes
  twice on every connect to a hub. `src/mcp/server.ts:751-755` hands `onerror` errors to its own drop check.
- Step 22: two different turns with the same text in the same room share one entry. The second add answers
  `already_exists` with the first turn's id and label, and a look-up by the second turn's label finds 0. So the saver
  must count `already_exists` as saved.
- Steps 23 to 25: a search query is at most 250 characters, so the user's message and an error must be cut to 250
  before they are sent. JavaScript's `length` is never smaller than MemPalace's count, so cutting by it is safe.
- Step 23: `already_exists` is MemPalace's duplicate report for a lesson only when the text is exactly the same; a date
  or a project in the text makes every day's lesson new.
- Step 28: "how many entries" comes from `mempalace_list_drawers`' `total`, one call per room; `mempalace_list_rooms`
  counts pieces.

#### Questions for the user

Q7, Q8 and Q19, and four new questions these findings raised. The user answered all of them on 2026-11-19; the
answers are under "The user's answers" below.

**Q7. Where the window finds the hub.** Found: MemPalace's file is
`memory/home/.mempalace/server/<24 hex>/serverinfo.json` (item 4). The key worked out by the script matched, so either
way works. The file names the serving interpreter, records no start time, and stays after a hard stop.
- Option 1 (recommended): Tachikoma keeps its own hub record in `memory/home` (port, the serving process's id and start
  time, the environment folder, the "stopping" mark), written only under the join lock. MemPalace's file is found by
  listing `server/*/serverinfo.json` and matching `palace_path`, compared without regard to letter case on Windows,
  and used only to confirm that the hub on that port serves this palace and to learn the serving process's id.
- Option 2: work out MemPalace's key (first 24 hex of SHA-256 of the resolved, lower-cased path) and read that file.

**Q8. A second writable hub.** Found (item 5): with `MEMPALACE_MCP_WRITER_WAIT_SECONDS=0` it exits with code 2 about
2.5 s after its start (Python starting up takes most of that), naming the process that holds the palace. With
MemPalace's default it waits up to 120 s without answering, then takes over if the holder has gone.
- Option 1 (recommended): start every hub with `MEMPALACE_MCP_WRITER_WAIT_SECONDS=0`, MemPalace's own "refuse at once"
  switch, and treat exit 2 as a failed start. Nothing waits under the join lock.
- Option 2: keep MemPalace's 120 s and let the hub start limit (step 8) cut it short.

**Q19. The length of the room's code.** Found (item 10): a room name may be up to 128 characters, must start and end
with a letter or digit, and may hold only letters, digits, `_`, space, `.`, `'` and `-`. Two projects share a room only
when their folders have the same name and their codes match, so the chance of a mix-up depends on how many folders with
one name a user has. With a code of L hex digits there are N = 16^L codes, and for n folders with the same name the
chance that two share a code is 1 - (1 - 1/N)(1 - 2/N)...(1 - (n-1)/N), about n(n-1)/(2N):

| Code | N | 2 folders | 10 folders | 100 folders | Name part left (128 - 1 - L) |
|---|---|---|---|---|---|
| 4 hex | 65,536 | 1 in 65,536 | 1 in 1,457 | 1 in 14 | 123 |
| 6 hex | 16,777,216 | 1 in 16.8 million | 1 in 372,827 | 1 in 3,390 | 121 |
| 8 hex | 4,294,967,296 | 1 in 4.3 billion | 1 in 95 million | 1 in 867,671 | 119 |
| 10 hex | 1.1 x 10^12 | 1 in 1.1 x 10^12 | 1 in 24 billion | 1 in 222 million | 117 |
| 12 hex | 2.8 x 10^14 | 1 in 2.8 x 10^14 | 1 in 6.3 x 10^12 | 1 in 57 billion | 115 |

Worked out with `node -e` from that product (exact for every cell above 10^-12, and n(n-1)/(2N) below it). For example,
8 hex and 100 folders: 100 x 99 / (2 x 4,294,967,296) = 9,900 / 8,589,934,592 = 1.15 x 10^-6, 1 in 867,671.
- Recommended: 8 hex digits (the first 8 of a SHA-256 of the full path, as MemPalace keys its own folders by the first
  24, `paths.py:189-194`). Even 100 folders with one name give about 1 in 867,671, and the folder's name keeps up to 119
  characters.
- Other answers: 6 hex (shorter names; 1 in 3,390 at 100 folders), or 12 hex (1 in 57 billion at 100 folders).
- With any length, the folder part must be mapped to the allowed characters and cut to fit (step 16).

**Q24 (new). How the window starts the hub.** The design says "it starts `mempalace serve`". Found (items 2 and 3): on
Windows `serve` is four processes; the process Tachikoma starts is not the one that serves; stopping it leaves the
server running with the palace locked; and `serve` starts its server without `-I`. The server that `serve` runs,
started directly, is two processes and the same server code with the same arguments (`cmd_serve.py:144-153`).
- Option 1 (recommended): start `<env>\Scripts\python.exe -I -c <MemPalace's own safe launcher, _proc.py:97-102>
  mempalace.mcp_server --transport http --host 127.0.0.1 --port <p> --palace <palace> --backend sqlite_exact`, and stop
  it by the serving process's id from `serverinfo.json`, checked against its start time. (Stopping the launcher
  Tachikoma started also ended a direct hub whole, item 2.) Not run in this form in step 6: the direct hubs here were
  started through the audit-hook wrapper, not MemPalace's safe launcher, and run 5 stopped its direct hub by its
  launcher, not by the serving process's id.
- Option 2: keep `mempalace serve`; record the serving process's id from `serverinfo.json` once it answers, and stop
  that one, which ends the other three (item 2).

**Q25 (new). The hub's own 8-hour idle exit.** Found (item 2, from the source, not run): a hub with no MCP request for
8 hours exits by itself, and the health check does not count. A window left open overnight would then see its hub gone,
show `memory failing` and start a new one.
- Option 1 (recommended): start Tachikoma's hubs with `MEMPALACE_MCP_IDLE_HOURS=0`, MemPalace's documented switch to
  turn it off (`protocol.py:1401`), since the last window to leave stops the hub.
- Option 2: leave it on and let the window's check start a new hub.

**Q26 (new). A turn longer than 100,000 characters.** Found (item 8): MemPalace refuses an entry of more than 100,000
characters, so such a turn cannot be saved as one entry.
- Option 1 (recommended): do not save it; `/memory` counts it as unsaved, and README lists it as a known limit.
- Option 2: save it as several entries, `... turn <n>, part <k>`, which changes the label and the saver's look-up.
- Option 3: save its first 100,000 characters only.

**Q27 (new). "This project" is two rooms, and one search covers only one.** Found (item 7): a search takes one room,
or the whole wing.
- Option 1 (recommended): two searches at once, the project's room and `lessons`, their matches merged by distance, both
  inside the one time limit.
- Option 2: one search over the wing, keeping only matches from the two rooms (other projects' matches can push them
  out of the results).

#### The user's answers (2026-11-19)

- Q7: Tachikoma keeps its own hub record. It finds MemPalace's file by listing `server/*/serverinfo.json` and matching
  `palace_path`, ignoring letter case.
- Q8: every hub starts with `MEMPALACE_MCP_WRITER_WAIT_SECONDS=0`. Exit code 2 counts as a failed start: another window
  holds the palace.
- Q19: the room's code is 8 hex characters.
- Q24: the window starts `mempalace.mcp_server --transport http` directly with `python.exe -I`, not through
  MemPalace's launcher (`_proc.py:97-102`), and stops it by the serving process's id. This exact start and stop was
  not run in step 6 (see Q24 above), so step 20 must test it before relying on it.
- Q25: every hub starts with `MEMPALACE_MCP_IDLE_HOURS=0`.
- Q26: a turn over 100,000 characters is saved in parts. This is the user's choice, not the option recommended above;
  the plan's later steps will say how.
- Q27: two searches at once, the project's room and `lessons`, their matches merged by distance.
- Run 4's pair of listings: accepted as explained, with the cause traced under "The user's folders".

#### Known limits of scripts/8d/mempalace-checks.mjs

Found in the review of the fixes, 2026-11-19, and left as they are: neither can make the script stop a process that is
not its own, and the script's work is done.
- `tree()` (lines 207-208) keeps an old record when a recorded id has been reused by a new child of the script. The
  child's start time then differs from the record, so `stop()` refuses it ("id now used by another process: not
  stopped"), and the run fails with that confusing reason rather than a clear one.
- The `reused` list (line 813), children of a recorded id that the start-time rule does not prove to be the script's,
  does not count toward `clean` (line 820). Such a child is listed in `results.json` but does not fail the run.

### M1 The download's size, for the first-use ask (step 7, 2026-11-19)

In short: a first set-up downloads three things: the packages (86 to 111 MB, by system), the model (83.2 MB, the
same everywhere) and a Python of uv's own (22.0 to 35.4 MB, by system). With Python, the largest is Linux x86-64 at
229.2 to 229.6 MB (by which of its four builds uv takes) and the smallest Windows at 191.3 MB. On this PC the script
picks the same 85 files step 4's install really fetched. **N = 230**, printed by the script, and approved by the user
(the rule and the approval at the end of this part).

Script: `scripts/8d/measure-download.mjs`, run as `node scripts/8d/measure-download.mjs`, exit 0, "measure-download:
passed", printing "N = 230". Its output is kept as `tachi-8d-build\download\measure-download.txt` (the run after the
reviewer's fixes; the first run's output was replaced). Nothing was fetched by it: the script reads `memory/uv.lock`,
step 4's log `install\sync.log`, step 4's kept Python archive, step 5's model archive and the saved headers of the
size-only requests (below), and runs uv only for its offline listing. Unit: **MB = 1,000,000 bytes** (uv's own log
prints MiB, 1,048,576 bytes).

How the packages are counted, for Python 3.13.17 (the version step 4's uv installed, "Using CPython 3.13.17"):
- Which packages: for each system, the lock's dependencies are followed from the project with their markers and
  extras, as `scripts/8d/lock-check.mjs` does (step 3). Each package is counted once per system: 85 on each system
  below, but not the same 85. Windows gets colorama 0.4.6 (`memory/uv.lock` line 369, `os_name == 'nt'`), and Linux
  and macOS get uvloop 0.23.0 instead (`memory/uv.lock` line 3649, `sys_platform != 'win32'`); the script prints
  each system's difference from Windows, and there is no other.
- Which wheel: the one uv picks. That is the first in the tag order of PEP 425 as `packaging.tags` gives it for
  CPython 3.13: `cp313-cp313`, `cp313-abi3`, `cp313-none`, then `cp312-abi3` down to `cp32-abi3`, then `py313-none`,
  `py3-none`, `py312-none` down to `py30-none` with a platform tag, then the same with `any`. Within one of those, the
  newest platform tag (the newest glibc or macOS), as on a system new enough for every wheel; for "macOS arm64
  (macOS 14)", the newest tag macOS 14 allows. Free-threaded (`cp313t`) wheels never count.
- Its size: the `size` the lock records for that file (for example `memory/uv.lock` line 1314,
  `mempalace-3.12.0-py3-none-any.whl`, `size = 1140726`).
- The spread: the script also gives the smallest and largest the packages could come to over every wheel that fits the
  system at any glibc or macOS version, and lists each package with more than one fitting wheel of different sizes.

The rule checked on this PC: for Windows x86-64 the script picks exactly the 85 files step 4's install fetched
(`install\sync.log`: 85 "Sending fresh GET request" lines, 85 files, none outside the lock), with nothing picked and
not fetched and nothing fetched and not picked. Nine of those packages have two or three fitting Windows wheels, so
the order between `cp313-cp313`, `abi3` and `py3-none-any` was tested. The order between glibc or macOS versions was
not: it cannot be run here.

The table, in MB:

| System | Packages | Model | Python | Without Python | With Python |
|---|---|---|---|---|---|
| Windows x86-64 (this PC) | 86.1 | 83.2 | 22.0 | 169.3 | 191.3 |
| Linux x86-64 | 111.0 | 83.2 | 35.0 to 35.4 | 194.2 | 229.2 to 229.6 |
| Linux arm64 | 104.7 | 83.2 | 29.5 | 187.9 | 217.4 |
| macOS arm64, macOS 15 or newer | 92.0 | 83.2 | 25.3 | 175.2 | 200.5 |
| macOS arm64, macOS 14 | 92.1 | 83.2 | 25.3 | 175.3 | 200.6 |
| Intel Macs | known limit | | | | |
| Windows on ARM | known limit | | | | |

In bytes: packages 86,095,655 (Windows), 111,009,574 (Linux x86-64), 104,749,343 (Linux arm64), 92,011,082 (macOS
15 or newer), 92,110,655 (macOS 14); model 83,178,821; Python 21,986,637 (Windows), 35,027,577 to 35,413,505 (Linux
x86-64's four builds), 29,455,505 (Linux arm64), 25,286,365 (macOS arm64). With Python: 191,261,113 (Windows),
229,215,972 to 229,601,900 (Linux x86-64), 217,383,669 (Linux arm64), 200,476,268 (macOS 15 or newer), 200,575,841
(macOS 14).

The whole table is the script's output. Its Python sizes are this PC's archive's bytes on disk and, for every other
system, the Content-Length the script reads from the saved headers of the size-only requests under "Python on the
other systems"; a missing header file prints "not measured" and fails the run (checked: with the `x86_64_v3` file
renamed for one run, the script printed "not measured" for it, "N: not measured" and "measure-download: FAILED",
exit 1; the file was then renamed back). The script computes the totals and N.

Where each figure comes from:
- Packages: the script's output, above.
- Model: `tachi-8d-build\model-download\onnx.tar.gz`, 83,178,821 bytes, SHA-256 `913d7300...6a16ec3` as approved at
  step 5 (this file's step 5 part, "Size:"). The script read the file and checked its hash again. The model is one
  archive from one address for every system (step 5).
- Python on this PC: `cpython-3.13.17+20261021-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`, 21,986,637 bytes,
  the copy step 4's uv kept in `install\python-cache` (this file's step 4 part).
- Python on the other systems: the Content-Length of each size-only request (below), read by the script from the
  saved header files.
- Linux arm64 is not in the brief's three systems. It is in the table because the lock covers it (step 3), so it bears
  on "the largest".
- Intel Macs and Windows on ARM: known limits (step 3: some packages have no ready-built file for 3.13 there, so the
  install fails and memory stays off). Not counted.

How much the systems' own versions move the figures (from the script's per-package lines):
- Windows: the spread is 85.3 to 86.1 MB, but uv's pick is fixed (one platform tag), and it matched.
- Linux: the spread is 108.0 to 111.0 MB (x86-64) and 101.8 to 104.7 MB (arm64). It comes from packages whose
  `py3-none-any` file is smaller than their Linux one; uv picks the Linux one on any glibc 2.28 or newer (the floor
  from step 3). On glibc 2.28 to 2.33, bcrypt's pick differs by under 1 KB. So for supported Linux systems the figures
  above hold to 0.1 MB.
- macOS arm64: the spread is 91.0 to 97.8 MB. The top of it comes from numpy's `macosx_11_0_arm64` file (10,744,599
  bytes against 5,508,218 for `macosx_14_0_arm64`), which uv picks only below macOS 14, where the install fails anyway
  (step 3: macOS 14 or newer). On macOS 14, orjson's `macosx_15_0_arm64` file (123,319 bytes) is not allowed, and uv
  picks its combined file (222,892 bytes): 92,110,655 bytes, 92.1 MB of packages, 175.3 MB without Python. The
  table's "macOS 14" row is the script's run with macOS 14 as the newest tag allowed; the other macOS row is macOS 15
  or newer (orjson's newest file needs 15).

This PC's figure from step 4's install against its computed figure:
- From step 4: 191,261,113 bytes (191.3 MB): the lock-recorded sizes of the 85 files uv downloaded (86,095,655
  bytes), plus its kept Python archive (21,986,637) and step 5's model archive (83,178,821), both bytes on disk.
- Computed: 191,261,113 bytes (191.3 MB). The gap is 0 bytes.
- The 0-byte gap is true by construction for the packages: both sides take each file's size from the lock (script:
  `measuredHere`, and the computed side's `chosen.size`), because uv's log holds no sizes of its own. uv checks each
  file's SHA-256 against the lock, so a file it took is the one the lock describes. The Python and model figures are
  the same files on both sides. So the real test is that the script picks the same 85 files uv fetched; it does. The
  figures leave out the requests' own overhead (headers, TLS), and the tamper run's second download, which a first
  set-up does not make.

Python on the other systems, from uv's own listing:
- Command: `uv python list 3.13.17 --all-platforms --all-arches --only-downloads --show-urls --output-format json -vv`
  (uv 0.13.5), exit 0. It lists 20 downloads. Their fields are key, version, version_parts, path, symlink, url, os,
  variant, implementation, arch and libc. **No size**, so the other systems' sizes come from the size-only requests
  below. The script takes each build's address from this listing and reads that build's saved header file.
- The files uv would download (its `url` field): `cpython-3.13.17+20261021-<system>-install_only_stripped.tar.gz`,
  with `<system>` `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu` or `aarch64-apple-darwin`, all from
  `https://releases.astral.sh/github/python-build-standalone/releases/download/20261021/`. uv also lists x86-64 builds
  for newer processors (`x86_64_v2` to `v4`); which one uv picks is under "The x86-64 build" below.
- Why it could not fetch: it ran with step 1's `throwaway("download")` environment; `UV_OFFLINE=1` (uv's own "Disable
  network access", `uv python list --help`); `UV_TOOL_DIR`, `UV_PYTHON_BIN_DIR` and `UV_PYTHON_CACHE_DIR` in
  `tachi-8d-build\download`; and `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` pointing at a listener of the script's on
  127.0.0.1 that records and refuses every connection. Before it, `uv cache dir`, `uv python dir` and `uv python dir
  --bin` printed folders in `tachi-8d-build\download`. Its log (4 lines at `-vv`) names no request, and the listener
  saw 0 connections. uv wrote only its cache folder's own marker files, in `tachi-8d-build\download\uv-cache`, and no
  `Temp\uv-*.lock` file.
- uv was run directly, not through sfw, since nothing was to be fetched.

The size-only requests (2026-11-19, after the user's yes; no sfw, as the user said):
- Exactly 3 requests, from PowerShell, one per address, each the listing's `url` for that system (the same CPython
  3.13.17, build 20261021, `install_only_stripped`, and the same folder as step 4's Windows archive):
  `C:\Windows\System32\curl.exe --head --fail --silent --show-error --proto =https --max-redirs 0 --dump-header
  <file> --output NUL <address>`. Each exited 0. No file body was downloaded (`--head`). The headers are kept in
  `tachi-8d-build\python-sizes\<system>.headers.txt`, a folder made new for them.
- Each answered `HTTP/1.1 200 OK`, with no redirect and a `Content-Length`:

| System | Address's `<system>` | Content-Length (bytes) | Last-Modified |
|---|---|---|---|
| Linux x86-64 | `x86_64-unknown-linux-gnu` | 35,356,674 | Wed, 21 Oct 2026 19:31:11 GMT |
| Linux arm64 | `aarch64-unknown-linux-gnu` | 29,455,505 | Wed, 21 Oct 2026 19:30:03 GMT |
| macOS arm64 | `aarch64-apple-darwin` | 25,286,365 | Wed, 21 Oct 2026 19:29:55 GMT |

- A size given in a HEAD answer is the size the server says it would send; the files were not downloaded to compare.

The x86-64 build: uv's code was not read (its source is not on this PC; reading it would be another request). What uv
does show, offline as before: `uv python list 3.13.17 --all-platforms --only-downloads --show-urls --output-format
json -vv`, without `--all-arches`, lists for Linux on this PC only `cpython-3.13.17-linux-x86_64-gnu` (the plain
build) and `...-linux-x86_64-musl`, none of `x86_64_v2` to `v4`. This PC's processor is an Intel Core i9-12900K, and
Windows reports AVX2 present (`IsProcessorFeaturePresent(40)`: True), so it could run a newer-processor build; uv
still names the plain one for it. That is uv's output on a Windows PC, not its code, and not a run on Linux. So the
user asked for the sizes of all four Linux x86-64 builds, and N is taken over all four.

The second size-only requests (2026-11-19, after the user's second yes; no sfw): exactly 3 more, the same curl flags
and the same way, in one PowerShell command between two snapshots, one per address. Each address is the `url` uv's
offline listing with `--all-arches` gives for `cpython-3.13.17-linux-x86_64_v2-gnu`, `...-x86_64_v3-gnu` and
`...-x86_64_v4-gnu`: the same release folder, `cpython-3.13.17+20261021-<system>-install_only_stripped.tar.gz`. Each
exited 0 and answered `HTTP/1.1 200 OK`, with no redirect and a `Content-Length`; headers in
`tachi-8d-build\python-sizes\<system>.headers.txt`.

| Linux x86-64 build | Address's `<system>` | Content-Length (bytes) | Last-Modified | Total with Python |
|---|---|---|---|---|
| plain (first requests) | `x86_64-unknown-linux-gnu` | 35,356,674 | Wed, 21 Oct 2026 19:31:11 GMT | 229,545,069 |
| v2 | `x86_64_v2-unknown-linux-gnu` | 35,027,577 | Wed, 21 Oct 2026 19:31:22 GMT | 229,215,972 |
| v3 | `x86_64_v3-unknown-linux-gnu` | 35,393,614 | Wed, 21 Oct 2026 19:31:32 GMT | 229,582,009 |
| v4 | `x86_64_v4-unknown-linux-gnu` | 35,413,505 | Wed, 21 Oct 2026 19:31:54 GMT | 229,601,900 |

Each total is 111,009,574 (packages) + 83,178,821 (model) + the build's size.

The snapshot of the user's folders:
- `step7-run-before` and `step7-run-after`, around the script's run, "no change"; `step7-before` (before the first uv
  command of this step) against `step7-all` (after the last of the first part), "no change".
- `step7b-head-before` and `step7b-head-after`, around the first 3 requests (all in one PowerShell command), "no
  change".
- `step7c-head-before` and `step7c-head-after`, around the second 3 requests (likewise), "no change".
- `step7d-run-before` and `step7d-run-after`, around the script's runs after the reviewer's fixes (the run with one
  header file renamed, and the source run, in one PowerShell command), "no change".
- `step7b-list-before` and `step7b-list-after`, around the second offline listing above: **not clean, and counts as
  explained.** The user's own `~/.mempalace` changed outside the set-apart places: `palace/sqlite_exact.sqlite3` and
  its `-wal` (23:08:05.3 UTC) and the folder `locks` (23:08:05.6), with the set-apart daemon queue (23:08:05.6). The
  listing ran at about 23:08:04.6 UTC. uv ran with `USERPROFILE` and `HOME` in `tachi-8d-build\download\home` and ran
  no MemPalace.
  - The trace (the coordinator's, from the session log, and the snapshot files' times, converted with Node):
    1. the main Claude Code session's reply ended at 23:07:33.4 UTC (session log);
    2. in the gap before the pair, the plugin's files changed, as `step7b-list-before.json` shows:
       `hook_state/last_checkpoint` 23:07:34.998, `hook_state/hook.log` 23:07:35.070,
       `hook_state/<session>_last_save` 23:07:35.074 and
       `locks/mine_palace_<palace key>.lock` 23:07:35.092, about 2 s after the reply; none of them changed
       inside the pair;
    3. the user's palace, `palace/sqlite_exact.sqlite3`, changed at 23:08:05.300 inside the pair (its `-wal` at
       23:08:05.272), about 30 s later: the same pattern as step 6's run 4.
  - The folder `locks` changed at 23:08:05.628, with the palace write, as it did in run 4 (22:17:35). The user's rule
    names the lock file, not the folder's own time; it is recorded here as part of the same write.
  - Under the user's rule of 2026-11-19 (a pair that fails only because of the plugin's save counts as explained when
    this full chain shows in the times: a reply ends, the plugin's files change about 2 s later, the palace about 30 s
    later), this pair counts as explained.
- Each clean pair has only the set-apart line of the user's own MemPalace daemon folder.

The user's choice (step 7), 2026-11-19:
1. Yes to 3 size-only requests to releases.astral.sh, without sfw, for the CPython 3.13.17+20261021
   `install_only_stripped` builds for Linux x86-64, Linux arm64 and macOS arm64 (above).
2. N is one figure for all systems: the largest system's total, counting Python.
3. The approved line stays word for word: "MemPalace 3.12.0 and its packages (about N MB)".

4. Yes, the same day, to 3 more size-only requests, for the Linux x86-64 `x86_64_v2`, `v3` and `v4` builds; N is the
   largest Linux x86-64 total over the plain build and these three.
5. The failed pair `step7b-list-before` to `step7b-list-after` counts as explained, with the trace above.

**N = 230.** The rule: the largest with-Python total, in MB of 1,000,000 bytes, rounded up to a whole number. The
largest is Linux x86-64 with the `x86_64_v4` build: 111,009,574 (packages) + 83,178,821 (model) + 35,413,505 (Python)
= 229,601,900 bytes, 229.6 MB, rounded up to 230. Each of the four Linux x86-64 builds gives 230 too (229.2 to 229.6
MB), so N does not depend on which one uv takes. The script computes N by this rule and prints "N = 230: the largest
total with Python, Linux x86-64, 229,601,900 bytes (229.6 MB), rounded up to a whole MB".

The user approved N = 230 on 2026-11-19. The first-use ask reads "about 230 MB": "MemPalace 3.12.0 and its packages
(about 230 MB)", the approved line word for word with N filled in.

### M3 The hub's start limit and how often it is checked; the proof of its start and stop (step 8, 2026-11-19)

In short: the hub started the way the user decided (Q24) works. It serves, it is found, and stopping its serving
process by its id, after reading its start time, ends every process of it in about 20 ms with nothing left behind. A
second hub for the same palace exits with code 2 in about 1.4 s without answering. On this PC a hub answers its first
health check about 1.1 s after it is started, whatever the palace holds, but the very first start after an install
takes about 7.5 s (most likely Python compiling MemPalace's files on first use: an inference, see "What the figures
mean"). **The user approved the figures and made the six decisions on 2026-11-19 (at the end of this part).**

Script: `scripts/8d/measure-hub.mjs`, three commands, each run between a pair of snapshots of the user's folders:
`node scripts/8d/measure-hub.mjs proof`, `... first-starts` and `... timings`. Each run's results are in
`tachi-8d-build\install\measure-hub-<command>-<time>\results.json`, with the hubs' logs beside it. The proof's run 3
ran before the Python unpacking was added to `first-starts`; that change touches nothing else. Run 2 of
`first-starts` and the timings run used the script as first committed (01f4e71), but for its line endings: after the
timings run ended (about 23:58 UTC), the only change to the file before that commit was turning every LF into CRLF,
at 00:02:48 UTC, by a Node command that did nothing else (`replace(/\r?\n/g, "\r\n")`); no comment or code changed.
Since then, the review fixes changed what produced no recorded figure: TEMP and TMP for every child (step 1's
helper), the PC description's PowerShell, and `first-starts <n>` (see "TEMP and TMP inside the build folder").

This PC: Intel Core i9-12900K (16 cores, 24 threads), 68.4 GB of memory, solid-state disks (the build folder is on
C:), Windows 11 Pro 10.0.26200, Node v24.22.1. Microsoft Defender's real-time scanning is off on this PC
(`Get-MpComputerStatus`, `RealTimeProtectionEnabled: False`), so no figure here includes scanning of new files.

How it was run:
- Every hub the decided way (Part B's opening; Q24, Q8, Q25), never `mempalace serve`: the environment's own Python by
  its full path, `<env>\Scripts\python.exe -I -m mempalace.mcp_server --transport http --port <p> --palace <palace>
  --backend sqlite_exact`, with `MEMPALACE_EMBEDDING_MODEL=minilm`, `MEMPALACE_MCP_WRITER_WAIT_SECONDS=0` and
  `MEMPALACE_MCP_IDLE_HOURS=0`, started detached and hidden. The host is MemPalace's default, 127.0.0.1
  (`mempalace/mcp_server/_guards.py:39-42`); every serverinfo.json read back says 127.0.0.1. Every port was one the
  script took from the system on 127.0.0.1 just before the start, never 8765. Every palace was new, under
  `install\home\palaces`, always passed with `--palace`.
- Step 1's `install` environment (the home with step 5's model, no `MEMPALACE_*` of the user's), with step 5's
  settings: `HF_HUB_OFFLINE=1` and a dead-end proxy of the script's on 127.0.0.1 in `HTTP_PROXY`, `HTTPS_PROXY` and
  `ALL_PROXY` (`NO_PROXY` for the loopback names).
- The backend and model read back for every hub: `sqlite_exact` from `/statusz` after every start (all 38 starts made
  the decided way, and the 2 filler hubs), and from `mempalace_status` where tool calls were made; `minilm`
  (all-MiniLM-L6-v2) from the `meta` table of every palace that had an entry. A new empty palace records no model
  until its first write (step 6 item 12).
- Every search query was under 250 characters. Nothing was fetched (see "The connection watch").

#### The proof (Q24), first

Run 3 of `proof`, exit 0, "measure-hub: passed"
(`install\measure-hub-proof-2026-11-18T23-45-37-337Z\results.json`). All 21 of its checks passed:
- **It serves.** Started by a short-lived Node starter (step 6's), which started it detached and hidden, printed its
  id and exited 0, as a window will. `/healthz` answered 200 after 1,275.6 ms, after the starter had exited. Through
  `@modelcontextprotocol/client` 2.4.0: one `mempalace_add_drawer` (`"success": true`, 1 piece) and one
  `mempalace_search` that found it; the library reported "Failed to open SSE stream: Not Found" twice, harmlessly, as in
  step 6. Read back: `sqlite_exact` (`mempalace_status` and `/statusz`, version 3.12.0) and `minilm` (the palace's
  `meta` table).
- **It is found.** Listing `install\home\.mempalace\server\*\serverinfo.json` and matching `palace_path` without
  regard to letter case (Q7) gave exactly one file, `server\052464f8f0451a209e100c55\serverinfo.json`, naming port
  61687, host 127.0.0.1 and pid 280160. The script never works out the folder's name. Pid 280160's parent is 230156,
  the process the starter started, whose parent is the starter, 286108.
- **Its start time can be read.** The environment's own Python with `-I` (step 6's `START_TIME_PY`) read 23:45:40.316699
  UTC in 135.8 ms, the same as the script's helper read.
- **It outlives a starter that exits.** The starter had exited 0 before the hub's first answer, and the hub served on.
- **A second hub for the same palace** while the first ran (the same start, its own port) exited with code 2 after
  1,393.8 ms, never answering: "Writable MCP HTTP startup refused: another mempalace writer already holds the palace
  lock for '<palace>': palace <palace> is held by PID 280160 (...); wait for it to finish or stop the holder before
  retrying". Its three processes were seen and ended by themselves.
- **Stopped by that id.** Its start time was read again by the environment's Python: 23:45:40.316699, still the same.
  Then the script's helper opened pid 280160, read its start time from that same handle (it matched) and ended it
  through that handle with `TerminateProcess` (`scripts/8d/measure-hub.mjs`, the helper's `stop`): a forced stop, as
  MemPalace has no shutdown of its own (step 6 item 2), so the hub's own clean-up did not run. Every process of the
  hub was gone within 21.0 ms, and the port then refused:

  | Process | Id | Parent | Started (UTC) | Before the stop | After |
  |---|---|---|---|---|---|
  | node.exe, the starter | 286108 | the script | ended before the first look | ended | ended |
  | python.exe, the launcher the starter started | 230156 | 286108 | 23:45:40.294130 | running | gone, 21.0 ms |
  | python.exe, serving (serverinfo's pid) | 280160 | 230156 | 23:45:40.316699 | running | gone, 18.0 ms |
  | conhost.exe, the console host Windows made for it | 274384 | 280160 | 23:45:40.340574 | running | gone, 13.4 ms |

- **The palace opens again.** A new hub on it (its own port) answered after 1,318.6 ms; its search found the first
  hub's entry. It was stopped the same way, by serverinfo's pid 284092 with its start time matching: its three
  processes (286984, 284092, conhost 284812) were all running before and all gone within 20.8 ms after.
- At the end of the run, all 15 of its processes were looked up again: none running, none that the start times could
  not settle, none of another program's.

Runs 1 and 2 of `proof` passed all 21 checks too, but each failed on a fault in the script's own process handling,
fixed before run 3:
- Run 1: the script's helper (then `python.exe`) had a console host of its own, and the helper's last look found it
  still running just before the helper itself ended. It was gone a few seconds later (`tasklist` by its id found
  nothing). The helper is now `pythonw.exe`, which gets no console host, and the script sees the helper's own end.
- Run 2: a console host appeared in the same process snapshot as its hub's serving process, a few microseconds after
  the time the script counted as "last seen", so one look marked it unsettled; the next look recorded it as the
  script's, but the mark stayed and failed the run. Now a process seen running counts as holding its id at least up to
  the start of every process in the same snapshot (the snapshot is one instant, after all of them started), and a
  process marked unsettled is judged again at the end. Both runs' pairs of listings were clean.

#### How processes are handled (and the two known limits of step 6's script, fixed)

- The helper is the build Python's own `pythonw.exe` with `-I` and only its standard library. It lists processes by
  id and parent id with their start times (Toolhelp32 and `GetProcessTimes`), and it stops a process only after
  opening it and reading its start time from that same handle; if that is the recorded one, it ends the process
  through that handle. A reused id can therefore never be hit between the check and the stop. It then times, to the
  millisecond, when each process of the hub has ended. It checks itself before any hub starts: it lists itself and a
  Node child of the script's, and stops that child.
- A process counts as the script's when the script started it, or when its parent is one of the script's and it
  started while that parent was known to hold its id: seen running, or held by a handle of the script's (its own
  children) or of the helper's (during a stop). A process under a recorded id that started after that parent was known
  to be gone is another program's, listed apart and left alone. Any other process under a recorded id cannot be
  settled by start times, and the run fails.
- Records are kept by id and start time together, so an id given to a new process of the script's gets its own
  record (step 6's first known limit, fixed). An unsettled process fails the run (the second, fixed).
- At the end of each run, every recorded process and every process under one is looked up again. Runs used: proof 15
  processes, first-starts 27, timings 150; still running at the end: none in each; unsettled: none.
- Listed apart and left alone, once (timings run): a `sleep.exe` started at 23:58:22.95 UTC under parent id 287424.
  That id had been the launcher of a second hub (`second-1`, started 23:57:33.88; its serving process was 286384), which
  had ended by about 23:57:35, so the `sleep.exe` belonged to another program that later got the id. The script never
  stopped, signalled or asked about it beyond the listing.

#### The first start after an install

Run 2 of `first-starts`, exit 0, "measure-hub: passed"
(`install\measure-hub-first-starts-2026-11-18T23-48-18-515Z\results.json`). The environment step 4 installed had been
started many times since (steps 5 and 6), so its first start could no longer be measured there. Each of three new
installs was made offline in `tachi-8d-build\hub-fresh-2026-11-18T23-48-18-515Z\fresh-<n>`, as a first set-up makes
one, without the download:
- Python: step 4's kept archive (`install\python-cache\...-install_only_stripped.tar.gz`, the file uv unpacks)
  unpacked with Windows' `tar.exe` into `fresh-<n>\python\cpython-3.13.17-windows-x86_64-none`, the name step 4's uv
  gave it. uv would not do this itself offline: run 1 of `first-starts` stopped there ("A managed Python download is
  available for Python 3.13, but uv is set to offline mode"), having started no hub. The archive carries 78 compiled
  files in `Lib\__pycache__`; after the first start there were 83.
- The environment: `uv sync --locked --python 3.13 -vv` (uv 0.13.5) with `UV_OFFLINE=1`, `UV_LINK_MODE=copy` (new
  files, as a first install has), step 4's wheel cache, `UV_PYTHON_PREFERENCE=only-managed`, and every folder uv was
  given inside the build folder (checked with `uv cache dir`, `uv python dir` and `uv python dir --bin` first). But
  not every file uv wrote was inside it: TEMP and TMP were the user's, and each `uv sync` of `first-starts` (runs 1
  and 2) left one empty lock file in the user's Temp folder, `C:\Users\<user>\AppData\Local\Temp\uv-<16 hex>.lock`:
  `uv-c14cb40c2cfa3352.lock` (made 23:46:29.980 UTC, run 1), `uv-e0f10f62b91f88d1.lock` (23:48:35.775),
  `uv-5f10f9bdd209eb04.lock` (23:49:05.439) and `uv-e794db0079c48ab4.lock` (23:49:25.444, run 2). The snapshots do
  not watch Temp, so they did not show them; the reviewer found them. On the user's word each was checked again to be
  an empty file (0 bytes) and deleted by its exact name, on 2026-11-19; no other `uv-*.lock` was in Temp. uv logged
  "Found managed installation `cpython-3.13.17-windows-x86_64-none`" in the new folder. Its logs name no request
  ("Sending ... GET request" or "Downloading": 0 lines each), and the dead-end proxy got nothing. uv compiles no
  bytecode by default: the new `mempalace` package had 0 `__pycache__` folders before the first start and 6 after.
- Then the first start of that install, and a second start of it, each on a new palace, each stopped by its serving
  process's id.

#### TEMP and TMP inside the build folder (the user's choice after the review, 2026-11-19)

- Step 1's helper, `scripts/8d/throwaway.mjs`, now sets TEMP and TMP to a `tmp` folder in the throwaway (made if
  missing) for every child environment it builds, and drops every other spelling of the two, as it drops the user's
  `MEMPALACE_*`. That covers uv, the hubs, `tar.exe`, the helper and the start-time reads in this script and in every
  later step. The per-uv TEMP and TMP of the first review fix were removed from `measure-hub.mjs`, with their guard.
  `tests/memory/throwaway.test.ts` checks it (both point inside the folder it makes, the folder is made, a `Temp` and
  a `tmp` of the user's are dropped, and no value names the user's Temp): `node node_modules/vitest/vitest.mjs run
  tests/memory/throwaway.test.ts`, 14 passed (the new test was seen failing first: the user's `Temp` and `tmp` were
  kept).
- The PC description's PowerShell call had the user's own environment, TEMP included, and was not among the recorded
  processes. It now has the build's environment and is recorded.
- The proof: `node scripts/8d/measure-hub.mjs first-starts 1` (one offline install; `<n>` is new), twice, each between
  a listing of the user's Temp folder's top-level entries (names, kinds and last-written times; no file opened) and a
  pair of snapshots of the user's folders.
  - Run at 00:37:58 UTC (before the PowerShell fix): exit 0, "measure-hub: passed"; 0 `uv-*.lock` in the user's Temp
    before and after; uv's own lock was in the build's `install\tmp` (`uv-9944703f12e302d3.lock`, 00:38:16.824 UTC,
    the lock uv's log names for the project). New in Temp: a file (origin not traced; 647 bytes, made 00:38:13.056
    UTC, during the Python unpacking) and a file (origin not traced) gone before it could be looked at. Not opened,
    not traced; the run's processes then were this script, its helper and `tar.exe`, the last two with the build's
    TEMP.
  - Run at 00:41:15 UTC (after it): exit 0, passed; 0 `uv-*.lock` in the user's Temp before and after; uv's lock in
    `install\tmp` (`uv-491d2fa86e042654.lock`, 00:41:34.751). The 647-byte file not touched. Changed in Temp: files
    of origin not traced, one added, one removed and one rewritten, and the build folder itself.
  - With nothing of the build running (two listings at 00:42:33 and 00:43:25 UTC): a file of another program removed
    and the same one rewritten again, so that churn is another program's. Left alone.
  - Both runs' pairs of snapshots (`step8-temp-*`, `step8-temp2-*`): "no change", only the set-apart daemon line.
  - The 647-byte file is left in place, unopened, for the user.
- For step 19: the installer gives every process it starts, uv and the hub, a TEMP and TMP inside `memory/`.

#### The timings

Run 1 of `timings`, exit 0, "measure-hub: passed" (`install\measure-hub-timings-2026-11-18T23-50-17-464Z\results.json`),
plus the first-starts run above and the proof run. ms = milliseconds. "Middle" is the median (for an even count, the
mean of the two middle values).

| Timing | Fastest | Middle | Slowest | Runs |
|---|---|---|---|---|
| Start to first good health answer: the first start after an install | 7,435.2 | 7,511.5 | 7,806.5 | 3 |
| The same install's second start | 1,200.1 | 1,219.3 | 1,257.0 | 3 |
| Start of the installed environment, new empty palace | 1,092.7 | 1,115.5 | 1,143.5 | 10 |
| The same, palace of 200 entries (1,000 pieces, 5.8 MB) | 1,100.3 | 1,130.9 | 1,146.5 | 10 |
| The same, palace of 2,001 entries (10,125 pieces, 58 MB) | 1,105.0 | 1,121.5 | 1,169.6 | 10 |
| Every installed start together | 1,092.7 | 1,122.5 | 1,169.6 | 30 |
| serverinfo.json naming the port, at most this long after the first health answer (see below) | | | 121.0 | 30 |
| Health check, live idle hub, connection reused (Node `fetch`) | 0.9 | 1.2 | 2.2 | 50 |
| Health check, live idle hub, new connection each time | 0.7 | 1.1 | 3.5 | 50 |
| Health check during a search of the 10,125-piece palace (wrapped hub, see below) | 2.3 | 2.8 | 45.8 | 20 |
| Health check during an add of 100,000 characters, 125 pieces (wrapped hub) | 2.0 | 2.9 | 10.6 | 163 |
| Health check, dead port (refused) | 0.3 | 0.3 | 0.5 | 50 |
| Stopped hub wholly gone (all its processes), installed starts | 11.9 | 13.1 | 14.7 | 30 |
| The same, the first-start installs' hubs | 14.7 | 15.3 | 17.3 | 6 |
| The same, the proof's two hubs | 20.8 | 20.9 | 21.0 | 2 |
| The same, the two filler hubs (wrapped hub) | 24.3 | 24.9 | 25.6 | 2 |
| Second hub for a held palace, start to exit with code 2 | 1,337.0 | 1,362.1 | 1,403.6 | 10 |
| Reading a process's start time (environment's Python, `-I`, spawned) | 116.2 | 124.5 | 138.2 | 20 |
| A failed try to take a held lock: open, try, close | 17.9 | 30.9 | 32.7 | 200 |
| A failed try to take a held lock, connection kept open | 20.0 | 31.0 | 32.3 | 200 |
| The install, offline: Python unpacked plus `uv sync` (no download) | 11,228.8 | 20,341.7 | 20,723.2 | 3 |
| of which unpacking Python | 4,377.6 | 13,989.4 | 14,112.2 | 3 |
| of which `uv sync` | 6,352.3 | 6,611.0 | 6,851.2 | 3 |

Also measured, as the filler went in: one add of a 4,000-character entry took 82.7 / 105.6 / 585.9 ms (200 runs, the
200-entry palace) and 96.7 / 189.6 / 502.9 ms (2,000 runs, the 2,000-entry palace). In the 10 second-hub runs of the
timings run, every one exited with code 2, never answered, and showed its three processes. Every one of the 33 stops
of that run (30 hubs, the 2 filler hubs and the helper's self-test child) found the start time matching. All 200 +
200 lock tries were refused with "ERR_SQLITE_ERROR 5 database is locked"; none took the held lock.

Two kinds of row need a note:
- "Wrapped hub": the busy health checks and the filler hubs' stops come from the two hubs that filled the filler
  palaces, which were started through step 5's audit-hook wrapper (`startHub(..., { wrapped: true })` in
  `scripts/8d/measure-hub.mjs`), not the decided way. They run the same server module; the wrapper adds an audit hook
  that logs name look-ups, connections, sends, HTTP requests and new processes, and the hubs' logs show none of those
  while serving (0 events in the server phase). The busy figures were not measured on a hub started the decided way.
- serverinfo.json: the script starts looking for the file only after the first health answer and a `/statusz`
  request (for the first start of the run, after the live-hub health checks, the start-time reads and the second
  hubs as well), and each look includes a process listing; the fastest figure, 37.5 ms, is about what one look takes.
  So each figure is the time until the script had found the file, not when MemPalace wrote it, and the fastest and
  middle show the looking more than the lag. Only the slowest, 121.0 ms, is kept: the file is there within that time
  of the first health answer on this PC. That figure is from the 30 installed starts of the timings run; the
  first-start installs' stops did not store it. So decision 1's 7,806.5 + 121.0 adds an installed start's figure to a
  first start's (the safe way; the user's 40 s is not affected).

What the figures mean:
- A hub's start does not depend on what the palace holds: 1.1 s for an empty palace and for one of 10,125 pieces.
  This agrees with the source (`mempalace/mcp_server/runtime.py:300-303`: only "the cheap filesystem-only probe before
  binding", no warm-up of the model or the index).
- The first start after an install is about 6.3 s slower (7,511.5 against 1,219.3 ms, the middles). It happens once
  per install: the same install's second start took 1.2 s. The likely cause is Python compiling MemPalace's files on
  first use, but that is an inference, not traced: what was seen is that uv installs none compiled, that the new
  `mempalace` package went from 0 `__pycache__` folders to 6 across the first start, and that the start took about
  6.3 s longer.
- MemPalace writes serverinfo.json after it binds (`mempalace/mcp_server/http.py:1594-1617`), so the first health
  answer comes up to 121 ms before the file names the new port. A window that finds the hub by that file must keep
  looking for it after the first health answer, within the start limit (a note for step 20).
- A failed lock try takes about 31 ms on Windows, even with `timeout: 0` and with the connection kept open, and it is
  synchronous, so the Node thread is held for that time on each try. About 31 ms is two of Windows' default 15.6 ms
  timer steps; that SQLite sleeps inside its Windows lock call is my reading, not traced to SQLite's source (Node's
  own SQLite, 3.53.4). A note for step 17.
- Every stop here was forced: `TerminateProcess` on the serving process, as MemPalace has no shutdown of its own (step
  6 item 2), so the hub's own clean-up (`atexit`, which lets the palace's writer lease go) did not run; the next hub
  took the palace anyway, as the reopen showed. A note for step 20: its stop must say whether it is forced or
  graceful, and its stop and its wait were measured here only for the forced one.
- Not measured: other systems (Linux, macOS); a slower PC; a disk whose cache is cold (just after the PC starts); and
  real-time scanning of new files, which is off here. Each would make the first start slower.

Choices the script made, each with its reason (in the script's own comments too):
- Ten installed starts of each palace kind, in turn (30): each takes about 1.1 s, and ten give a middle and show the
  spread.
- Three first starts after an install: each needs a whole new install (a Python and an environment of about 320 MB,
  copied).
- Ten second hubs: as many as the starts. Fifty health checks of each kind, twenty start-time reads and 200 lock tries
  of each kind: each takes milliseconds.
- Filler entries of 4,000 characters (five of MemPalace's 800-character pieces, `mempalace/config.py:415`) in palaces
  of 200 and 2,000 entries, a factor of ten apart, to show whether the start depends on the palace's size. The
  2,000-entry palace then got one entry of 100,000 characters, the longest MemPalace accepts (`config.py:283-291`),
  added while health checks ran. Real turn lengths are step 10's.
- The script's own polling step: 10 ms between checks while it waits for a hub, so each measured start is at most
  about 11 ms later than the hub's first good answer. Its own cut-off: 180 s, so a run always ends. Neither is a figure
  for Tachikoma.

#### The connection watch

The dead-end proxy received no connection in any of the three runs. The two hubs that filled the filler palaces
(every add and search of the filler phase, and the busy health checks) ran the same server module through step 5's
audit-hook wrapper: each logged its own loopback check and the dead-end proxy in urllib's and httpx's settings, and
nothing to any address other than this computer, and started no process. The hubs started the decided way ran
without the wrapper, so only the proxy watched them; it sees only HTTP sent through the proxy variables. uv ran with
`UV_OFFLINE=1` and the proxy, and its logs name no request. Known limits as in step 5: native code is not seen.

#### The user's folders

Each run had its own pair of listings, taken in the same command as the run, just before and just after it:
`step8-proof-before/after`, `step8-proof2-before/after`, `step8-proof3-before/after`, `step8-first-before/after`,
`step8-first2-before/after` and `step8-timings-before/after`. Every pair printed "no change", with only the set-apart
line for the user's own MemPalace daemon folder (`daemon/<palace key>`). No pair failed.

#### The decisions for the user

The options and recommendations as shown to the user; the user's choices are under "The user's choices (step 8)"
below. Each recommendation is built from this PC's slowest figure with a margin for slower machines. **The margin
is not measured**: no slower PC was run. It is a judgment for the user. A margin of 5 times is used below because
this PC is a fast desktop with solid-state disks and no real-time scanning, and the margin has to cover all of those
at once.

**1. The start limit**: how long a window waits, from starting the hub, for it to answer and for serverinfo.json to
name its port, before reporting a failed start. (A start that exits by itself is seen at once; a start that exits
with code 2 goes on to the other window's hub, Q8, which already answers.)
- Slowest here: the first start after an install, 7,806.5 ms, plus up to 121.0 ms for serverinfo.json: 7,927.5 ms.
  Any later start: 1,169.6 + 121.0 = 1,290.6 ms. The exit-2 path: 1,403.6 ms, then a hub that already answers.
- Options:
  - A. One limit for every start, from the first start: 7,927.5 ms times 3 = 23.8 s (24 s); times 5 = 39.6 s
    (**40 s**); times 10 = 79.3 s (80 s).
  - B. Two limits: the first start after an install, as in A, and every other start from 1,290.6 ms: times 5 = 6.5 s
    (7 s); times 10 = 12.9 s (13 s).
- Recommended: A, with the margin of 5 times: 40 s. One figure is simpler, and a first start can also come later than
  straight after the install (a slow disk, a PC just started). The long limit only matters when a start hangs without
  exiting; a start that fails exits and is seen at once.

**2. The check interval**: how often the window checks, while it waits for a started hub to answer (and then for
serverinfo.json). The running hub's own timer is measurement 4's (step 9).
- A check costs at most 0.5 ms while the hub is not yet listening (refused), 3.5 ms once it answers. The interval adds
  at most one interval to every start.
- Options, with the most each adds to an installed start of 1.1 s, and the share of one core spent checking
  (0.5 ms per check): 50 ms (adds at most 4.5%; 1.0%); **100 ms** (9%; 0.5%); 250 ms (22%; 0.2%).
- Recommended: 100 ms. With the margin of 5 times a check costs 2.5 ms, 2.5% of one core; it adds at most 0.1 s to a
  1.1 s start.

**3. The health check's own time limit**: how long one health check may take before the hub counts as not answering.
- MemPalace's own client uses 0.75 s for the same check: `HUB_HEALTH_TIMEOUT_S = 0.75`
  (`mempalace/hub_client.py:21`), the default of `HubClient.healthy` (`mempalace/hub_client.py:225`), in the build's
  installed MemPalace 3.12.0 (`tachi-8d-build\env\Lib\site-packages`).
- Slowest here: 45.8 ms, during a search of a 10,125-piece palace; 10.6 ms during the longest add (both on a hub
  started through the audit-hook wrapper, see "Two kinds of row need a note"); 3.5 ms idle (started the decided way).
- Options: A. **MemPalace's 0.75 s**, 16 times this PC's slowest (750 / 45.8 = 16.4); B. from the figure with the
  margin: 45.8 x 5 = 229 ms (0.25 s); C. 2 s (44 times the slowest).
- Recommended: A, 0.75 s. It is MemPalace's own figure for this check, and it leaves more room than the margin of 5
  times over the slowest busy check. Larger palaces than 10,125 pieces were not tried.
- Why 0.75 s still holds although the busy figures come from a wrapped hub: the wrapper's hook logs only network and
  process events, which a hub serving a health check does not make (its logs show none), so it is not expected to
  slow the check; and even if a hub started the decided way were several times slower, 0.75 s is 16 times the
  slowest busy figure. Not re-run.

**4. The wait for a stopped hub to end**: how long the last window waits, after stopping the hub, for every process of
it to be gone.
- Slowest here: 25.6 ms (40 stops: 30 installed starts, 6 first-start installs, the proof's 2 and the 2 filler hubs;
  the slowest a filler hub, started through the wrapper; the slowest of a hub started the decided way, 21.0 ms, the
  proof's). All were forced stops. Tachikoma will see "gone" with its own check, a start-time read by the
  environment's Python, which costs up to 138.2 ms; one read is longer than the whole end.
- Options: 0.5 s; **1 s**; 2 s. Arithmetic for 1 s, with the margin of 5 times: the end, 25.6 x 5 = 128 ms, plus one
  confirming read, 138.2 x 5 = 691 ms: 819 ms, rounded up to 1 s.
- Recommended: 1 s.

**5. The wait between tries for a held lock** (the join lock, the install lock and step 22's save lock).
- A failed try costs up to 32.7 ms here, and holds the Node thread for that time. After the holder lets go, a waiter
  takes the lock at most one interval later. The join lock is held for about one hub start (1.3 s; 7.9 s the first
  time).
- Options, with the share of the waiting window's thread held by the tries (32.7 ms per try): 100 ms (33%); 250 ms
  (13%); **500 ms** (6.5%); 1 s (3.3%).
- Recommended: 500 ms. It adds at most 0.5 s after a release, against a join holder of at least 1.3 s, and holds the
  thread 6.5% of the time while waiting. The margin does not enter here: the try's cost looks like Windows' timer
  steps, not work, so a slower PC was not assumed to make it longer; that is not measured.

**6. Windows waiting on another window's install**: do they check again at the same interval as decision 5?
- An install here took 11.2 to 20.7 s without the download; the download (about 230 MB, M1) comes on top and was not
  timed.
- Options: A. **the same interval as decision 5** (500 ms if recommended: one figure; about 2 tries a second at 33 ms
  each, 6.5% of the thread); B. a longer one, 2 s (1.6% of the thread; at most 2 s added after an install of at least
  11.2 s, 18%).
- Recommended: A, the same interval. Each try costs the same 33 ms either way, and one figure is simpler.

#### The user's choices (step 8), 2026-11-19

The user approved the figures above and made the six decisions, as recommended:
1. The start limit: **40 s**, one limit for every start.
2. The check interval while a hub starts: **100 ms**.
3. The health check's own time limit: **0.75 s**, MemPalace's own (`mempalace/hub_client.py:21`).
4. The wait for a stopped hub to end: **1 s**.
5. The wait between tries for a held lock: **500 ms**.
6. Windows waiting on another window's install: **the same 500 ms**.

The margin of 5 times this PC's slowest figure behind 1, 2 and 4 was not measured (no slower PC was run); the user
chose it. The user also asked for all of the review's points on this record to be fixed; the corrections are in the
text above (the slowest stop, the wrapped hub's figures, the uv lock files in Temp, what changed in the script after
the runs, the serverinfo.json figure, the reused id, the first start's cause, and the forced stop).

### M4 How often the "in use" file is refreshed, and when one counts as stale (step 9, 2026-11-19)

In short: rewriting a window's "in use" file costs about 8 ms with the repo's private write (2 ms as a plain
overwrite). A timer in a busy Tachikoma process can fire more than 3 s late on this PC: the longest hold-up measured
was making a new folder private (`privateDir`, 3.2 s, three PowerShell starts), then a synchronous taskkill (0.9 s).
Reading a large file and hashing the model hold the timer up by 0.2 s at most. So a file must be allowed at least the
refresh interval plus about 3.2 s, before any margin for slower machines, before it counts as gone; and, as the review
found, a second interval and 1 s more for the repo's private write, whose rename can be retried for up to 1 s and
then give up (decision 2). **The user
approved the figures and made both decisions on 2026-11-19: refresh every 5 s; a file counts as gone at 27 s (at the
end of this part).**

Script: `scripts/8d/measure-inuse.mjs`, run once as `TSX_DISABLE_CACHE=1 node --import tsx
scripts/8d/measure-inuse.mjs` (tsx so the repo's own `privateDir`, `writePrivate`, `killTree` and `shellFor` are
imported and run as they are; its cache off, so tsx writes nothing to the user's Temp folder), between a pair of
snapshots of the user's folders. Exit 0, "measure-inuse: passed", no failures. Results:
`tachi-8d-build\inuse\measure-inuse-2026-11-19T00-55-36-718Z\results.json`, with every run's figure in `raw`. No
MemPalace ran; nothing was fetched. After the run, only two comments' line numbers (read_file's lines, 296-320) and the
line endings (LF to CRLF) changed in the script; no code changed until the review's fix to the leftover look (see
"Fixes and choices", not run).

The cache switch: `--import tsx` loads `node_modules/tsx/dist/loader.mjs` (tsx 4.23.15, its package's `exports`),
which loads `node_modules/tsx/dist/index-DE3OBZuV.mjs`; there, at line 13,
`var J=process.env.TSX_DISABLE_CACHE?new Map:new Er`, where `Er` is tsx's file cache (`class Er extends Map`), whose
folder is `tsx-<user name>` in the Temp folder (``q=m.join(n.tmpdir(),`tsx-${j}`)``,
`node_modules/tsx/dist/temporary-directory-Du7LpLp9.mjs:1`): here `Temp\tsx-<user>`. So with `TSX_DISABLE_CACHE=1`
tsx keeps its cache in memory, in a plain `Map`.

This PC, as in M3: Intel Core i9-12900K (16 cores, 24 threads), 68.4 GB of memory, solid-state disks (the build
folder is on C:), Windows 11 Pro 10.0.26200, Node v24.22.1. Microsoft Defender's real-time scanning is off
(`Get-MpComputerStatus`, `RealTimeProtectionEnabled: False`, read again in this run), so no figure includes scanning.
Other programs of the user's were running as usual; their load was not measured.

How it was run:
- The script's own environment was replaced at its start by step 1's `inuse` throwaway's (TEMP and TMP
  `tachi-8d-build\inuse\tmp`, the home `tachi-8d-build\inuse\home`, no API keys), so every child got it, the repo's
  own too: `privateDir`'s whoami, PowerShell and icacls and `killTree`'s taskkill take `commandEnv()`, which reads
  the process's environment.
- **The refresh** rewrote a small file (about what a window's file would hold: its process id and a time, 35 bytes)
  in `private-1`, a folder this run made and made private with the repo's `privateDir` (`src/auth/private.ts:72-95`).
  Two forms, 1,000 times each, 10 ms apart: the repo's private write, `writePrivate` (`src/auth/private.ts:155-173`:
  a new file, written, flushed to disk with `fsyncSync`, swapped in), and a plain `writeFileSync` overwrite.
- **Permissions** were changed only on the five folders `private-1` to `private-5`, each made by this run inside its
  own run folder with a non-recursive `mkdirSync` (which fails if the folder is already there). Before each
  `privateDir` call and each refresh the script checked the folder: inside the build folder, one this run made, a
  plain folder (not a link), and no link or junction on its way (`realpathSync.native` gives back the same path). No
  other folder's permissions were touched.
- **The timer**: a 10 ms `setInterval` ran beside each kind of work, and the script recorded the gap between its
  firings across each piece of work. 10 ms is shorter than any hold-up worth knowing about, so the gap shows the
  hold-up's whole length (step 8's polling step, too). A self-check came first: a 200 ms busy wait showed as a gap of
  200.2 ms. Pieces of work were 100 ms apart, so the gaps around one never ran into the next one's.
- **The taskkill** was the repo's own `killTree` (`src/exec/local.ts:37-53`), which runs `taskkill /pid <id> /T /F`
  synchronously with `spawnSync`. Its target each time was a Windows PowerShell this script had started the way local.ts
  starts a command (`shellFor`, `src/exec/local.ts:13-33`, and its spawn, `:106`), running a Node program of the
  script's (a tree of PowerShell and that Node program, with any console host Windows made; not listed). Before each
  kill, the start-time check: the shell's start time, read by the build Python (`-I`, `GetProcessTimes`, step 8's
  `START_TIME_PY`), fell between just before and just after the spawn (16 ms of leeway each side, one of Windows' clock
  steps), was the same when read again just before the kill, and Node had not seen the shell exit (killTree's own
  check). All 20 passed; nothing else was ever stopped. Afterwards: all 20 shells had exited; all 20 Node programs,
  looked up again by id and start time, were gone; and a listing of every process whose parent was one of the 20 shells
  found none left. (Each Node program would have ended by itself after 120 s had a kill missed it.) In the run, that
  listing's own failure was not checked: a PowerShell that failed would also have read as "none". The review's fix
  makes it fail the run (see "Fixes and choices"); it is not run. The checks per process, which do not rely on it,
  showed all 20 shells exited and all 20 Node programs gone.
- **The large file read** was read_file's way: `readFile(<file>, "utf8")` (`src/exec/local.ts:162-164`), then the
  line split and the first rows as `src/tools/files.ts:296-320` makes them with read_file's defaults. The file was
  step 5's model archive, `tachi-8d-build\model-download\onnx.tar.gz` (83,178,821 bytes), read only. It is not text:
  it read as 322,923 lines. A text file of the same size has more lines, so its split would take longer; not measured.
- **The hash** was a SHA-256 of that same archive, the size of the model download, in two forms: the whole file read
  at once and hashed (`readFileSync`, one `update`), and streamed (`createReadStream`, 64 KiB pieces). Every hash was
  step 5's `913d7300...16ec3`.

| Figure (ms) | Fastest | Middle | Slowest | Runs |
|---|---|---|---|---|
| Refresh, `writePrivate` (the repo's private write) | 6.5 | 7.9 | 13.5 | 1,000 |
| Refresh, plain overwrite | 1.4 | 2.0 | 34.7 | 1,000 |
| Timer gap, idle (the timer alone, 30 s) | 11.0 | 15.5 | 24.8 | 1,925 |
| `privateDir` of a new folder, the work | 3,061.2 | 3,073.1 | 3,161.9 | 5 |
| Timer gap across it | 3,077.2 | 3,088.8 | **3,178.2** | 5 |
| Synchronous taskkill (`killTree`), the work | 834.3 | 850.0 | 872.5 | 20 |
| Timer gap across it | 837.7 | 856.0 | 881.2 | 20 |
| Large file read, read_file's way, the work | 966.2 | 1,020.4 | 1,138.7 | 20 |
| Timer gap across it | 80.9 | 87.2 | 198.4 | 20 |
| SHA-256, whole file at once, the work | 59.4 | 60.9 | 63.6 | 20 |
| Timer gap across it | 60.1 | 76.2 | 79.0 | 20 |
| SHA-256, streamed, the work | 104.1 | 111.5 | 139.1 | 20 |
| Timer gap across it | 15.3 | 20.0 | 25.7 | 20 |

Also: every one of the 1,000 private writes took over 5 ms (the flush to disk), none over 50 ms; of the plain
overwrites 17 took over 5 ms, none over 50 ms. Of the 1,925 idle gaps, 10 were over 20 ms and none over 50 ms.

What the figures mean:
- A timer gap is the time from one firing to the next. A refresh timer set to R fires at most R plus the longest
  hold-up after the one before, so a live window's file can be R plus that, plus the write itself, old when another
  window looks at it.
- The longest hold-up here is the first `privateDir` of a folder on Windows: 3.2 s, synchronous. That is the code's
  worst case (the folder inherits other accounts' entries, so PowerShell reads the permissions three times and icacls
  runs twice, `src/auth/private.ts:76-89`). It can happen while a window is in a session, not only at its start: the
  error log makes its folder private on the first error a process writes (`src/core/errorlog.ts:19`), as do the MCP
  answers and login files when first used (`src/mcp/answers.ts:72`, `src/mcp/auth.ts:79`). A folder that is already
  private costs one permission read, one PowerShell start: the error log's own comment records 385 ms for that
  (`src/core/errorlog.ts:13-14`, the code review's figure). A private file read for the first time (`readPrivate`,
  `src/auth/private.ts:105-118`) costs one more; neither was timed here.
- A synchronous taskkill holds the process for 0.85 s on a PowerShell running one program here. Release 7's record,
  in its note on stopping a Docker image build, says taskkill "took 2.2 to 3.8 s even for one program (5 runs)" on
  this PC (2026-11-06, `docs/plans/2026-10-31-tachikoma-release-7.md:992`). That is 2.6 to 4.5 times this run's
  figure, and up to 1.2 times the `privateDir` figure; why the two runs differ was not looked into.
- The large file read and the streamed hash barely hold the timer (the reading happens off the main thread); the read's
  text work holds it up to 0.2 s for an 83 MB file. Hashing the whole file at once holds it for its whole 60 ms;
  streamed, the timer is never more than 26 ms late. A note for step 19: hash the model streamed.
- `writePrivate` swaps the new file in with a rename, which Windows refuses while another process has the file open;
  it is then retried, blocking, for up to 1 s (`RENAME_RETRY_MS`, `src/auth/private.ts:131-136`; measured on
  2026-10-23 with two processes reading nonstop: the slowest went through after 0.76 s). The 1 s is a cap in the code,
  not a measurement: the retry gives up once 1 s has passed (`src/auth/private.ts:147-148`), and `writePrivate` then
  throws (`:147`, `:167-169`), so that refresh is missed and the file waits for the next one. It was not measured
  here. It belongs in the worst case, which the decisions first offered left out (see "The user's choices (step 9)").
- Notes for step 20, hold-ups on the refresh path that are not in the worst case above:
  - `writePrivate` first calls `privateDir` on the file's folder (`src/auth/private.ts:156`), which returns at once
    only for a folder this process has already checked (`:73`). So the first refresh of a process runs it: about
    3.2 s for a new folder (this run) and about 0.4 s for one already private (`src/core/errorlog.ts:13-14`).
  - Reading a private file the first time, `readPrivate`, starts PowerShell to read its permissions
    (`src/auth/private.ts:107`), and icacls too when they need resetting (`:111`).
  - So: keep both off the refresh timer (make the folder private, and read the files a window needs, before the
    timer starts), and rewrite the file before awaiting the hub's health check (up to 0.75 s, M3 decision 3), so the
    check's time never adds to a refresh's lateness.
- Compared with the existing lock: `src/auth/lock.ts:12` rechecks a held lock every 5 s (`RECHECK_MS = 5_000`),
  proper-lockfile's refresh, half its 10,000 ms stale age (`src/auth/lock.ts:10-11`). This PC's longest hold-up, 3.2
  s, is 64% of that 5 s. Refreshing every 5 s with a stale age of 10 s, as proper-lockfile does, leaves 5 s for
  hold-ups: 1.6 times this PC's slowest gap, less than any of the margins below.
- Not measured: other systems (Linux, macOS); a slower PC; real-time scanning (off here); other Tachikoma work on the
  main thread (the screen redrawing a long answer, reading a long transcript when a session is resumed); two hold-ups
  back to back; the rename retry above; a PC that sleeps or hibernates (every window's file goes stale at once, and
  no age can tell that apart from a crash); the clock being set back or forward while windows run.

Choices the script made, each with its reason (in the script's comments too): a 10 ms timer step and 100 ms between
pieces of work (above); a 30 s idle baseline, about as long as the longest phase of work, so a rare pause of the idle
process would show; 1,000 refreshes of each form, as each takes about a millisecond, so the rare slow write shows; five
new folders made private, each about 3 s, enough for a middle and a spread with few permission changes; twenty
taskkills, reads and hashes of each form, as step 8's start-time reads. The script's own cut-off: 30 s for each Node
program to start. None of these is a figure for Tachikoma.

#### The user's folders

One pair of snapshots, taken in the same command as the run, just before and just after it: `step9-before` and
`step9-after`. It printed "no change", with only the set-apart line for the user's own MemPalace daemon folder
(`daemon/<palace key>`). No pair failed.

The same command also listed the top level of the user's Temp folder before and after, with step 8's scratch
`templist2.cjs`: names, kinds and last-written times only, read only, no file opened. That listing goes beyond the
snapshot the user approved (step 1), which does not cover Temp. It found nothing added, nothing removed, only
`tachi-8d-build` itself rewritten, and no `uv-*.lock`.

The from-step-8 Temp rule was broken once, before the run. A two-line probe that tsx could load
`src/auth/private.ts` (`scripts/8d/_probe9.mjs`, made and deleted by its exact name, never committed) ran with the
user's TEMP and tsx's cache on, so tsx used its cache folder in the user's Temp, `Temp\tsx-<user>` (the folder
`npm run dev` uses too). That was before the listings, so neither listing saw it. A listing of Temp taken after it
showed `tsx-<user>`'s own last-written time as 00:50:44 UTC, the probe's time; the coordinator checked `tsx-<user>` and
found no file in it written between 00:45 and 00:55 UTC. The orchestrator then listed `Temp\tsx-<user>` again (names
and times only, read only): of its 1,587 entries, counted recursively, none was created or last written after 00:30
UTC on 2026-11-19. A folder's last-written time also moves when an entry in it is removed or renamed, so the change
at 00:50:44 was a removal or a rename; which entry it was is not known. The run itself had the cache off (above).
Every PowerShell start, here as in Tachikoma, may also update PowerShell's own files under
`AppData\Local\Microsoft\Windows\PowerShell`, which no listing watches.

#### The decisions for the user

The options and recommendations as first shown to the user, with the stale age's rule corrected after the review
(the rename retry); the user's choices are under "The user's choices (step 9)" below. Each is built from this PC's
slowest figures. **The margin for slower
machines is not measured** (no slower PC was run): it is the user's choice, shown at 3, 5 and 10 times this PC's
slowest.

The figure behind both: the longest a live window's file can go without a refresh beyond the interval is the
longest hold-up plus the slowest refresh: 3,178.2 + 13.5 = 3,191.7 ms (with `writePrivate`; with the plain overwrite,
3,178.2 + 34.7 = 3,212.9 ms). With the margin: times 3, 9,575.1 ms; times 5, 15,958.5 ms; times 10, 31,917.0 ms.

**1. The refresh interval** (R): how often a window rewrites its file.
- What it costs: one refresh holds the window's thread for 7.9 ms (middle; 13.5 ms slowest) with `writePrivate`.
  Every 1 s that is 0.8% of the thread; every 5 s, 0.16%; every 10 s, 0.08%.
- What it adds: the stale age must be at least R plus the figure above (twice R by the corrected rule in decision 2),
  so a longer R makes the stale age longer.
- Options: A. 1 s; B. **5 s**, the same as `src/auth/lock.ts:12`'s recheck; C. 10 s.
- Recommended: B, 5 s. Its cost is negligible (0.16% of the thread), and it keeps the stale age within half a minute
  at every margin but 10 times.

**2. The stale age** (S): how old a file must be to count as gone. First offered as S = R + margin x 3,191.7 ms,
which left out `writePrivate`'s rename retry. Corrected (the user's rule, 2026-11-19): S = 2 x R + margin x 3,191.7
ms + 1,000 ms, rounded up to a whole second. The 1,000 ms is the retry's cap in the code
(`src/auth/private.ts:147-148`), not a measurement, so the margin does not multiply it. The second R covers one
refresh missed when the retry gives up and `writePrivate` throws (`:147`, `:167-169`).

| R | Margin 3 times | Margin 5 times | Margin 10 times |
|---|---|---|---|
| 1 s | 2 + 9.6 + 1 = 12.6, **13 s** | 2 + 16.0 + 1 = 19.0, **19 s** | 2 + 31.9 + 1 = 34.9, **35 s** |
| 5 s | 10 + 9.6 + 1 = 20.6, **21 s** | 10 + 16.0 + 1 = 27.0, **27 s** | 10 + 31.9 + 1 = 42.9, **43 s** |
| 10 s | 20 + 9.6 + 1 = 30.6, **31 s** | 20 + 16.0 + 1 = 37.0, **37 s** | 20 + 31.9 + 1 = 52.9, **53 s** |

- Too short: a live window that was held up is taken for gone. If the last other window leaves then, it stops the
  hub under the live one; the live one finds the hub gone at its next check and joins again, starting a new hub (about
  1.1 s here, M3), and a memory call in flight at that moment fails.
- Too long: after a window crashes, its file still counts as fresh for up to S, so a last window leaving within that
  time leaves the hub running, until a later window joins and leaves (the design's "A crashed last window leaves the
  hub running until the next window joins and finds no other fresh file").
- First recommended: with R = 5 s and the margin of 5 times, as the user chose for M3, 21 s (5,000 + 15,958.5 =
  20,958.5 ms), by the first rule. That figure left out the rename retry, and is replaced below. By the corrected
  rule the same choices give 27 s. Release 7's taskkill, 3.8 s at its slowest (above), is within 5 times this run's
  worst case (15,958.5 ms).

#### The user's choices (step 9), 2026-11-19

The user approved the figures above and made both decisions:
1. The refresh interval: **5 s**.
2. The stale age: **27 s**, by the rule 2 x R + 5 x the longest hold-up measured (3,191.7 ms) + `writePrivate`'s
   fixed 1 s rename retry: 10,000 + 15,958.5 + 1,000 = 26,958.5 ms, rounded up to 27 s. The 1 s is a cap in the code
   (`src/auth/private.ts:147-148`), not a measurement, so it is not multiplied by the margin. The second R covers one
   refresh missed when the retry gives up and `writePrivate` throws (`src/auth/private.ts:147`, `:167-169`). The
   margin of 5 times is the user's, from step 8; it was not measured (no slower PC was run).

The 21 s first offered left out the rename retry. Step 9 was committed (110d9b5) before the user's answer, as step 8
was; the answers, and the fixes to the review's points on this record, are in the commit after it.

#### Fixes and choices (2026-11-19)

The user asked for all of the review's points on this part to be fixed. No measurement changed and nothing was
re-run.
1. The worst case left out `writePrivate`'s rename retry: restated in "What the figures mean" and in decision 2's
   rule and table (above).
2. The probe's write to `Temp\tsx-<user>`, which broke the from-step-8 Temp rule; the Temp listing, beyond the
   approved snapshot; and the source of `TSX_DISABLE_CACHE`'s effect: recorded under "The user's folders" and below
   the script's command.
3. Release 7's taskkill figure: now described as its source says it, "even for one program (5 runs)"
   (`docs/plans/2026-10-31-tachikoma-release-7.md:992`).
4. Hold-ups on the refresh path outside the worst case (the first `privateDir` of a folder, a first `readPrivate`):
   notes for step 20 under "What the figures mean".
5. The citation of the lock's comment: `src/auth/lock.ts:10-11`.
6. `scripts/8d/measure-inuse.mjs`, the look for processes left under the shells: it ignored PowerShell's exit status
   and errors, so a failed look read as "none". It now stops on any error (`$ErrorActionPreference = 'Stop'`), and a
   non-zero exit, a spawn error or any error output fails the run. This change is not run. In the run, the checks per
   process showed all 20 shells exited and all 20 Node programs gone, looked up again by id and start time.
7. The order of commits: recorded above.

### M2 The exit save's time limit; and the rule for cutting old transcripts into turns (step 10, 2026-11-19)

In short: the user's real turns are short. Of the 83 typed turns that would be saved, the longest entry is 3,828
characters, and 86.7% fit in one of MemPalace's 800-character pieces; none is over 100,000 characters, so none would
be saved in parts. Saving one such turn the way step 22 will (lock, look-up, add, let go) takes about 0.25 to 0.3 s
on a warm hub in a palace the size the user's turns make today, about 0.5 s in a palace of 2,000 entries, and up to
1.15 s when it is the first save after the hub starts in that palace, as in a `-p` run (0.7 s in a smaller one).
Almost all of it is MemPalace's add; the lock and the look-up take a few milliseconds. The slowest real backlog (all
11 turns of the user's longest session) takes about 5 s in the large palace, and a window behind another window
saving it waits up to 5.4 s for the lock. A made-up turn in 3 parts of 100,000 characters takes about 6.3 s.
**The user approved the figures and chose the exit save's time limit, 14 s (option A1), on 2026-11-19 (at the end
of this part). Both pairs of snapshots failed: the user explained the first; the second is traced under the user's
rule ("The user's folders").**

**Correction (step 12's review, 2026-11-19):** the figures in this part count 7 typed turns twice: `/branch` copied
them into 3 new sessions (found in M7). With the copies left out, 76 typed turns would be saved, not 83, and 85.5% of
them, not 86.7%, fit in one 800-character piece. The longest entry (3,828), the largest backlog (11 turns) and the
count over 100,000 (0) do not change, so X, the backlog and the user's 14 s limit stand. The corrected figures are
under "The user's transcripts, read only".

Scripts: `scripts/8d/turns.mjs` (the rule for cutting a transcript into turns, for steps 10, 12 and 14) with its test
`tests/memory/turns.test.ts`, and `scripts/8d/measure-save.mjs`, three commands: `scan` (the transcripts only, starts
nothing), `timings` (the hubs) and, added after the review, `first-large` (run 2, below). The timings ran once,
`node scripts/8d/measure-save.mjs timings`, from 01:33:43 to 01:54:54 UTC, between a pair of snapshots: exit 0,
"measure-save: passed", no failures. Results:
`tachi-8d-build\install\measure-save-timings-2026-11-19T01-33-43-682Z\results.json`, with every hub's log beside it.
Nothing was fetched; the dead-end proxy got 0 connections. 80 processes were recorded; at the end none was still
running, none was unsettled and none of another program's was found under a reused id. All 12 hubs were stopped by
the serving process's id after its start time was read again (13 stops with the helper's self-test child); each hub
was wholly gone within 20.3 to 22.8 ms. The two savers of each pair were Node processes of the script's own,
recorded and seen to exit.

This PC, as in M3 and M4: Intel Core i9-12900K (16 cores, 24 threads), 68.4 GB of memory, solid-state disks (the
build folder is on C:), Windows 11 Pro 10.0.26200, Node v24.22.1, Defender's real-time scanning off (read again in
this run). Other programs of the user's were running as usual; their load was not measured.

#### The rule for cutting old transcripts into turns

Transcripts saved before this release have no turn boundary (Q22's line is new), so the measurements cut them into
turns themselves, by one rule in `scripts/8d/turns.mjs`: the code's own rule for where a turn starts, `lastTurn`
(`src/tui/describe.ts:288-297`). A turn starts at a user message that holds no tool result and is not a Stop hook's
feedback (`src/core/session.ts:68`, `:691-695`), and runs to the next such start; a shortening's line is not a message
and starts nothing, and its summary is in no turn. A turn whose starting message holds typed words is typed; one whose
starting message holds none is a background turn, a turn of its own (`src/clilib.ts:321`). A typed turn's entry is
built as the user answered Q4 and Q5: the typed words, each picture as its marker and none of the text hooks,
subagents, servers or notes added (as `src/core/session.ts:513-515` takes them), then all of the model's text in the
turn, in order; tool calls and outputs left out. A turn with typed words and no model text makes no entry (Q4). A turn
with a damaged line inside it cannot be rebuilt and is set apart. A turn the file ends in the middle of (the file's
last turn, unless its last message is a reply with no calls), or else one with a call left without a result, is
marked and kept, with its words and text, and counts in every save figure: Q4 saves a turn "however it ended". Here
the plan's "left out of every figure" (step 10) gave way to Q4, by the user's decision on step 10's review
(2026-11-19); a measurement that needs whole turns, such as step 12's, can leave the marked ones out by their mark.

`tests/memory/turns.test.ts`, on made-up transcripts only: a typed turn with tool rounds is one turn; a typed turn and
a background turn after it are two, with the background turn's calls and text not in the first; a Stop hook's
feedback does not start a turn; a shortening does not split a turn, and its summary is not in it; the typed words
leave out hook, server, task and note text and give each picture its marker; a turn with a damaged line is set apart,
and a turn with a call with no result and one the file ends in are marked and keep their words and text (changed
after step 10's review; seen to fail on the old rule first); on four made-up histories the script's last turn
holds the same number of tool calls as `lastTurn`'s header gives (so a wrong start would show); the heading and the
marker equal the code's (`FEEDBACK`, `marker`). Also, beyond the plan's list of tests, the cut of a long turn into
parts (step 22's rule): a text at the limit is one part, a longer one is cut with every part but the last as long as
allowed, and a cut never falls between the two halves of a character Node holds as a pair. Written first and seen to
fail (the script did not exist), then 10 of 10 passed; with the feedback rule taken out, 2 failed as they should.

Where step 22 differs, the counts here may differ a little: the entry's exact layout is step 22's; this script joins
the typed words and each piece of the model's text with two characters ("\n\n"). No turn lies within 1,000 characters
below the 100,000 limit, so a layout a few characters longer cannot change the count of turns over it. The 1,000 and
the size bands below only group this report; neither is a setting of Tachikoma's. The 1,000 is the limit's 1 in 100
(100,000 / 100), more than any layout's joins would add to a real turn (the most pieces of model text in one real
entry is 2, so 2 joins). The bands go by MemPalace's 800-character pieces, a factor of 5 each, chosen so that four
steps from 1 piece end exactly at the 100,000-character cut for parts (5 x 5 x 5 = 125 pieces of 800); the factor has
no other source.

#### The user's transcripts, read only

Read on this computer, read only, as lengths and counts alone. Nothing from the Tachikoma transcripts (no text, no
session id, no file name) is in any output, in the results files or here. The snapshot listings of the user's folders
are another matter: as approved at step 1, they hold the names of the files in those folders (among them the user's
MemPalace plugin's `hook_state` files, named by Claude Code session ids, and the other files in Temp), and they
stay in the build folder until step 31 deletes it; none of those names is printed here. Subagents' own files were not
read (their messages are never saved).

| What | Count |
|---|---|
| Transcripts (main sessions) read | 53 files, 1,621,473 bytes, in 10 project folders |
| Sessions with a start line | 53 (15 of them `-p` runs); none without |
| Sessions with no typed turn | 15 |
| Typed turns rebuilt | 89 |
| of them marked: the file ends mid-turn | 2 (none has model text) |
| of them marked: a call without a result | 1 (it has no model text) |
| Background turns rebuilt | 1 |
| Turns set apart (a damaged line) | 0 |
| Damaged lines before a session's first turn | 0 |
| Typed turns with no model text (make no entry), the 3 marked ones among them | 6 |
| Typed turns that make an entry | 83 |

The 3 marked turns were first set apart and left out of the figures. After the review they were measured as Q4 and
Q5 make them up (`scan`, run again, read only, lengths and counts only): each has typed words and no piece of model
text, so by Q4 none is saved, and no save figure changes. None is in the session with the most saved turns (the
backlog below).

Entry length, in characters as Node counts them: shortest 34, middle 251, 90th 870, longest 3,828; all 83
together 31,974. In MemPalace's pieces of 800 code points: 72 entries of 1 piece, 9 of 2, 1 of 3 and 1 of 5. Saved
turns per session: 17 sessions none; the most in one session 11.

| Size band (characters) | MemPalace pieces | Typed turns | Share |
|---|---|---|---|
| 1 to 800 | 1 | 72 | 86.7% |
| 801 to 4,000 | 2 to 5 | 11 | 13.3% |
| 4,001 to 20,000 | 6 to 25 | 0 | 0% |
| 20,001 to 100,000 | 26 to 125 | 0 | 0% |
| Over 100,000 (saved in parts) | | 0 | 0% |

The bands go by pieces, a factor of 5 each, since MemPalace's work on an add grows with its pieces; 125 pieces of 800
is exactly the 100,000-character limit. **Long turns (Q26): 0 real typed turns are over 100,000 characters, so none
would be saved in parts; the most parts a real turn makes is 1.** So the turns in parts were timed at 2 and at 3
parts, as the plan says when no real turn has more.

**Correction (step 12's review, 2026-11-19).** The figures above count, twice, 7 typed turns that `/branch` copied
whole into 3 new sessions (`src/core/sessions.ts:95-103`; found in M7, which leaves them out). All 7 have model text.
The figures above are kept as they were shown; with the copies left out they are:

| Figure | As shown above | With the copies left out |
|---|---|---|
| Typed turns rebuilt | 89 | 82 |
| Typed turns that make an entry | 83 | 76 |
| Entry length: middle | 251 | 278 |
| Entry length: 90th | 870 | 875 |
| Entry length: all together | 31,974 | 31,331 |
| Entries of 1 / 2 / 3 / 5 pieces | 72 / 9 / 1 / 1 | 65 / 9 / 1 / 1 |
| Sessions with no saved turn | 17 | 19 |
| Band 1 to 800 characters | 72 (86.7%) | 65 (85.5%) |
| Band 801 to 4,000 characters | 11 (13.3%) | 11 (14.5%) |

Unchanged: the shortest (34) and the longest (3,828) entry, the most saved turns in one session (11, the backlog),
and 0 turns over 100,000 characters. So X (the first save of the longest real turn), the backlog's figures and the
user's 14 s exit save limit stand. Counted after the review from `scripts/8d/turns.mjs`, read only and as counts
alone, by a scratch script (`m2-copies.mjs`, in the session's scratchpad; its output is in the build folder's
`scratch\step12\run-3.txt`). It finds the copies as M7 does and printed both columns; the first matches the figures
above. That run was inside the third pair of M7's snapshots, which printed "no change".

#### How the save was timed

Every hub was started and stopped as step 8 proved (Q24, Q8, Q25): the build folder's `env\Scripts\python.exe -I -m
mempalace.mcp_server --transport http --port <p> --palace <new palace> --backend sqlite_exact`, with
`MEMPALACE_EMBEDDING_MODEL=minilm`, `MEMPALACE_MCP_WRITER_WAIT_SECONDS=0` and `MEMPALACE_MCP_IDLE_HOURS=0`, in step 1's
`install` environment (TEMP and TMP inside the build folder) with step 5's offline settings and a dead-end proxy. The
script's code for starting, finding and stopping hubs and for keeping track of processes is copied unchanged from
`scripts/8d/measure-hub.mjs` (the lines are listed in the script's header), but for the run folder's and palaces'
names, the result line, and the audit-hook option, which no hub here used. Every palace read back `sqlite_exact` (from
`mempalace_status` and `/statusz`) and the model `minilm` (the palace file's `meta` table).

The text saved was made-up filler (step 8's word filler) at the real turns' lengths, never the user's text, each with
a seed of its own so no two were the same. Each turn was saved as step 22 will save it: take the save lock (step 2's
kind, an exclusive `node:sqlite` transaction on a lock file in the run folder, tried again after the user's 500 ms
while held, M3 decision 5); for each of the turn's entries, look up its exact label (`mempalace_delete_by_source` with
`dry_run: true`, which gives the pieces there) and add it (`mempalace_add_drawer`, the label as `source_file`) when it
is not there; let go. Not timed here: writing the transcript's saved record (an append to the transcript), which step
22 does after the last entry and before letting go. After the timings, not timed, every entry saved was looked up
again: all 600, and the 10 first saves after a start, were whole (the pieces there equal to the pieces their text
makes), and every add's reported pieces matched.

The sizes: one turn at the real middle (251 characters), the real 90th (870) and the real longest (3,828). The
backlog: all 11 saved turns of the real session with the most, at their real lengths, one after another (4,129
characters), as a window would face it if the hub had been down all session. Two savers: two Node processes of the
script's, as two windows, each with its own connection and the same lock, told to start at once on the same backlog.
Turns in parts: 200,000 and 300,000 characters, 2 and 3 full parts of 100,000, the slowest turns of those part
counts. Ten runs of each, as step 8's starts: ten give a middle and show the spread.

Two palaces, each new:
- **"Today"**: one filler entry for each of the 83 real entries, at its length (98 pieces), the palace the user's
  transcripts would make today. The timings ran in this order, and the palace grew with them: one turn, backlog, two
  savers, then parts (383 entries and 6,648 pieces by the end).
- **"Large"**: 2,000 entries of 4,000 characters (10,000 pieces), the shape of step 8's largest palace, where step 8's
  adds were slower than in its 200-entry palace (middle 189.6 ms against 105.6 ms). Same order (2,300 entries and
  16,550 pieces by the end).

The first save after a start: ten times, a new hub on the "today" palace (after its timings, so 383 to 392 entries),
connected, one turn of 3,828 characters saved, the hub stopped. After the review, a second run
(`node scripts/8d/measure-save.mjs first-large`, 02:16:51 to 02:38:20 UTC, exit 0, "measure-save: passed", no
failures; results in `tachi-8d-build\install\measure-save-first-large-2026-11-19T02-16-51-259Z\results.json`) timed
the same in a new palace filled as the "large" one (2,000 entries of 4,000 characters, 10,000 pieces; the filling hub
then stopped): ten times a new hub, connected, one turn of 3,828 characters saved, then a second turn of the same size
saved on the same hub (a warm save in the same palace at the same size, for a like-for-like comparison), the hub
stopped (2,000 to 2,020 entries over the ten). 40 processes recorded, none left running, none unsettled; the 12 hubs
were stopped by their serving process's id after the start-time check, each gone within 17.7 to 22.5 ms; the
dead-end proxy got 0 connections; backend `sqlite_exact` and model `minilm` read back; all 20 entries whole.

#### The figures

| Timing (ms) | Fastest | Middle | Slowest | Runs |
|---|---|---|---|---|
| "Today": one turn of 251 characters | 230.7 | 237.7 | 244.2 | 10 |
| "Today": one turn of 870 characters | 248.9 | 253.3 | 256.7 | 10 |
| "Today": one turn of 3,828 characters | 285.4 | 294.8 | 308.8 | 10 |
| "Today": a backlog of 11 turns | 2,654.0 | 2,705.1 | 2,733.3 | 10 |
| "Today": two savers on that backlog, until both are done | 2,868.4 | 3,346.9 | 3,390.3 | 10 |
| "Today": a turn in 2 parts | 3,671.8 | 3,731.2 | 4,200.3 | 10 |
| "Today": a turn in 3 parts | 5,649.8 | 5,711.6 | 5,862.8 | 10 |
| "Today" (383 to 392 entries): first save after a start, 3,828 characters | 623.9 | 649.0 | 704.5 | 10 |
| Large: one turn of 251 characters | 443.5 | 456.9 | 460.4 | 10 |
| Large: one turn of 870 characters | 455.1 | 468.1 | 477.2 | 10 |
| Large: one turn of 3,828 characters | 490.7 | 503.4 | 511.8 | 10 |
| Large: a backlog of 11 turns | 5,005.4 | 5,066.4 | 5,131.9 | 10 |
| Large: two savers on that backlog, until both are done | 5,509.6 | 5,534.0 | **5,589.7** | 10 |
| Large: a turn in 2 parts | 4,100.0 | 4,125.3 | 4,642.6 | 10 |
| Large: a turn in 3 parts | 6,235.1 | 6,300.7 | **6,367.2** | 10 |
| Large, run 2 (2,000 to 2,020 entries): first save after a start | 1,009.7 | 1,041.1 | **1,146.9** | 10 |
| Large, run 2: the second save on that hub, the same size | 701.0 | 708.2 | 714.3 | 10 |

The first saves after a start are each the connection and the save of one turn of 3,828 characters; the "today" row
comes from the first run, after that palace's other timings, and the two "run 2" rows from the second run.

What one save is made of (ms, fastest / middle / slowest):
- The lock, held by no one else: fastest 0.6, slowest 2.2, the six series' middles 1.1 to 1.3 (one-turn saves, 10 a
  series, both palaces; the results file keeps each series' figures, not each save's, so no middle over all 60).
- The look-up by label: one-turn saves fastest 6.1, slowest 15.5, middles 7.2 to 10.0 (six series of 10); a part
  fastest 5.9, slowest 14.5, middles 7.7 to 9.1 (four series, 100 parts).
- The add: "today" 220.4 to 293.6 by size; large 432.8 to 496.7. A 100,000-character part: "today" 1,800.4 / 1,851.6
  / 2,318.4 (the 20 parts of 2-part turns) and 1,853.0 / 1,891.3 / 1,998.8 (the 30 of 3-part turns); large 2,007.9 /
  2,055.1 / 2,565.4 (20) and 2,044.8 / 2,093.1 / 2,129.4 (30). The slowest part add of all: 2,565.4.
- The first save after a start, "today" (383 to 392 entries): the hub's start to its first health answer 1,093.6 /
  1,153.4 / 1,321.4 (as M3); connecting 3.1 / 3.6 / 6.7; the look-up 13.0 / 16.1 / 17.9; the add 603.9 / 625.0 /
  683.0.
- The same, large, run 2 (2,000 to 2,020 entries): the start 1,088.2 / 1,120.4 / 1,165.3; connecting 3.1 / 3.5 /
  6.7; the look-up 10.8 / 15.3 / 16.3; the add 988.1 / 1,018.8 / 1,126.3. The second save on the same hub: the add
  691.0 / 698.9 / 704.7. The first save less the second, run by run: 302.0 to **426.2**.
- Filling (plain adds, no lock or look-up): "today" 216.6 / 226.0 / 595.4 ms per add (83); large 311.8 / 414.9 / 678.6
  (2,000); large in run 2, 493.3 / 623.0 / 939.6 (2,000).

Two savers: in every run of both palaces one saver made all 11 adds and the other found all 11 entries there (11 adds
and 11 found in each run); no entry was added twice. The saver that got the lock first kept getting it, as it takes
it again at once after letting go, so it never waited (11 tries for 11 turns). The other, in the "today" palace, took
16 or 17 tries (5 or 6 waits of 500 ms); in the large palace, 21 tries in every run (10 waits). It then went through
the 11 look-ups. So "both done" is about the first saver's time, plus up to one 500 ms wait, plus 11 look-ups. How
long the waiting saver waited for its first lock (from each saver's own record, `savers-<palace>-<run>-<k>.out.json`
in the results folder): "today" 2,715.3 to 3,256.9 ms; large 5,384.3 to **5,411.6** ms (10 runs each). That is the
wait a window's exit save meets while another window saves the user's largest real backlog.

What the figures mean:
- Nearly all of a save is MemPalace's add, which grows with the entry's pieces and with the palace: about 0.23 s for a
  short turn in a small palace, 0.45 s in a palace of 10,000 pieces, about 1.9 to 2.1 s for a full 100,000-character
  part. The lock and the look-up add about 10 ms.
- The first save after a hub starts is slower than a warm one. Like for like (run 2: the same hub, the same palace,
  the same size, one save just after the other), the first add took 1,018.8 ms and the second 698.9 ms, the middles;
  the first save was 302.0 to 426.2 ms longer, run by run. Most likely MemPalace loads the embedding model on its
  first add; that is an inference, as the load was not timed on its own. The first run's "today" figures (625.0 ms
  for a first add at 383 to 392 entries, against 281.5 ms warm at about 83 entries) compare palaces of different
  sizes, so they do not show the cold cost alone.
- The two runs differ: run 2's adds and saves were slower (filling the same shape of palace, middle 623.0 ms
  against 414.9 ms in run 1; a warm save of 3,828 characters, 708.2 ms against 503.4 ms, both in the large palace);
  its starts, connections and look-ups were not (start slowest 1,165.3 against 1,321.4 ms). Other work on this PC at
  the time was not measured (the user had started Claude Code in another project during run 1, and its load at run 2
  is not known). In the options below, only S, X and K take the slowest of either run (X and K come from run 2, S's
  start from run 1). W, Bk and P3 were timed in run 1 only, so they leave out run 2's slower adds and saves.
- A `-p` run's turn is usually the first save after its hub started, if this window started it, so its exit save is
  the first-save figure. A hub still starting when the window exits adds the rest of its start: taken below from this
  step's starts (1,321.4 ms at the slowest, to the first health answer).
- A backlog is saved one turn after another, so its time is the sum of its turns.
- Not measured: other systems; a slower PC; real-time scanning (off here); palaces larger than 16,550 pieces; turns of
  sizes between 3,828 characters and a full part (only the real sizes and full parts were timed); a saver whose lock
  is held by a crashed window (the operating system frees it, step 2).

#### The user's folders

One pair of snapshots, taken in the same command just before and just after the run: `step10-before` (01:33:07 UTC)
and `step10-after` (taken after 01:54:54, finished 01:55:22). **It failed (exit 1)**, on two groups of changes, both
in places the build does not write. Every child of the run had the build's home, TEMP and TMP but one: the helper's
self-test child (a Node process that only waits, started and stopped by the set-up) inherited the user's TEMP and TMP,
since corrected (see "Fixes after the review"). The script itself reads the transcripts and writes only in the build
folder. What changed:
- **Claude Code's program, 01:35:58 to 01:36:02 UTC**: `~/.local/bin/claude.exe` rewritten (379,536,544 to
  379,651,744 bytes), `~/.local/bin/claude.exe.old.<number>` added, and the folder `~/.cache/claude/staging` changed.
- **The user's MemPalace, 01:38:31.954 to 01:38:32.270 UTC**: `wal/write_log.jsonl` (+261 bytes, 01:38:31.954),
  `palace/sqlite_exact.sqlite3-wal` (same size, 01:38:32.126), `hook_state/last_checkpoint` (01:38:32.172), one
  session's `hook_state/<session>_last_save` (01:38:32.250) and `locks/mine_palace_<key>.lock` (01:38:32.270). Set
  apart as usual: the daemon folder, `queue.sqlite3` (01:38:53.697) and `hook.log` (01:45:18.254). The palace file
  changed in the same 0.3 s as the plugin's files, not about 30 s later as in the user's rule for a traced pair.

**The user's explanation (2026-11-19):** they started Claude Code in another project at about 12:36 local time (01:36
UTC). That start updated `~/.local/bin/claude.exe`, and its MemPalace plugin changed the palace files at 01:38:31.95
to 01:38:32.27 UTC. So the pair failed, and the user explained it; it is not traced from this session's log. This
explains this pair only; the standing rule for pairs is unchanged.

Run 2 had its own pair, `step10-fix-before` (02:16:23 UTC) and `step10-fix-after` (taken after 02:38:20, finished
02:38:46). **It failed too (exit 1)**, on the user's MemPalace only, nothing else in any watched folder:
`wal/write_log.jsonl` (+264 bytes, 02:19:11.491), `hook_state/last_checkpoint` (02:19:11.709), one session's
`hook_state/<session>_last_save` (02:19:11.794), `locks/mine_palace_<key>.lock` (02:19:11.815), then 29 s later
`palace/sqlite_exact.sqlite3-wal` (02:19:40.692), `palace/sqlite_exact.sqlite3` (6,821,593,088 to 6,822,883,328
bytes, 02:19:40.720) and the folder `locks` (02:19:40.994). Set apart as usual: the daemon folder, `queue.sqlite3`
(02:19:41.013) and `hook.log` (02:19:11.790). **Traced under the user's rule, so explained:** the orchestrator found
in the main session's log that a reply ended at 02:19:09.431 UTC (`end_turn`); the plugin's files changed 2.1 s later
(02:19:11.49) and the palace about 29 s after them (02:19:40.69), the full chain the rule names. The pair failed, and
counts as explained. The run's Temp listing:
no `uv-*.lock`; added, a file (origin not traced, 02:17:16); rewritten, a file (origin not traced, 02:38:16);
neither opened.

The same command listed the top level of the user's Temp folder before and after (step 8's `templist2.cjs`: names,
kinds and last-written times only, no file opened): no `uv-*.lock`; added, two files (origin not traced; written
01:37:53 UTC and 01:54:36), neither opened; nothing removed or rewritten. No tsx ran.

#### The decision for the user: the exit save's time limit

What the limit does: at exit, the saver gets one last chance to save the turns not yet saved, for up to this long.
When the queue is empty or empties sooner, the window does not wait. What is left stays marked unsaved and is saved
when that session is next resumed (step 22); a session never resumed, as most `-p` runs are, keeps it unsaved. So:
- **Too short**: the last turns of a session that is not resumed are not saved. A turn in parts that the limit cuts
  short stays unsaved with its first parts in, and is finished at the next resume.
- **Too long**: a window whose hub has stopped answering is held at exit for up to the limit.

The options were redone after the review with two inputs the first table left out: the lock wait when another
window is saving, and a hub still starting at exit. The inputs, each this PC's slowest (ms):
- **S, the rest of a hub's start**: 1,445.9 measured, plus 100 fixed. The measured part is the slowest start to the
  first health answer, 1,321.4 (this step's run 1, the "today" palace's first saves; run 2's slowest was 1,165.3;
  M3's installed starts 1,169.6); plus serverinfo.json naming the port after that answer, at most 121.0 (M3); plus one
  health check, 3.5 (M3's slowest on an idle hub, a new connection). The 100 ms is the window's check interval while a
  hub starts (M3 decision 2), a setting, so the margin does not multiply it (as M4's 1 s cap).
- **Si, the rest of the first hub start after an install**: 7,931.0 measured, plus the same 100 fixed: the slowest
  first start after an install, 7,806.5 (M3, 3 runs), plus 121.0 and 3.5 as in S. When it can meet an exit, from the
  plan: the window that installs is the one that starts the first hub. The memory service runs the installer in the
  background and joins the hub as soon as the install is ready (step 21; step 19 writes the ready file only after the
  environment's own Python has answered), and an install that finishes during a session switches saving on at once,
  in the conversation already open (Q1; step 27). If the user then exits within those seconds, closing does not stop
  the start: step 20's closing lets a join already inside the join lock finish its one step, and step 21's first stage
  gives the saver its last chance after that while the palace is still connected (step 27 has the same order). So the
  exit save of the installing window can wait on the first start after its install. A `-p` run never installs
  (design, section 6; step 27: "`-p` never asks"), and a later launch starts its hub from an environment that has
  already started one (the first start's extra time, M3, is once per install), unless none ever did: the plan does
  not show that case, except where the installing window was killed between its ready file and its hub start (step
  27: on a kill signal only the window's "in use" file is removed). No run of this step measured a save on a hub
  started first after an install.
- **W, the lock wait behind another window**: 5,411.6, the waiting saver's wait for its first lock while the other
  saved the user's largest real backlog, large palace (two-saver runs, above). It counts this run's 500 ms waits
  between tries (M3 decision 5) as measured.
- **X, one real turn, the first save after a start, large palace**: 1,146.9 (run 2, connect and save, 3,828
  characters).
- **K, the first-save cost on top of a warm save**: 432.9, the largest run-by-run difference between the first and
  second save in run 2 (426.2) plus the slowest connection (6.7).
- **Bk, the user's largest real backlog, warm, large palace**: 5,131.9. **P3, a turn in 3 full parts, warm, large
  palace**: 6,367.2.

S and W are added together in A to C, the worst case: in practice another window cannot be saving through a hub that
is still starting, so both together may not happen. Each sum is margin x the measured inputs + the fixed 100 ms,
rounded up to a whole second. **The margin for slower machines is not measured** (no slower PC was run); 5 times is
the user's margin from M3 and M4.

| Option | What it covers | Inputs (ms) | 3 times | 5 times | 10 times |
|---|---|---|---|---|---|
| A0 | the last real turn, cold, hub up, no other window | X = 1,146.9 | 4 s | 6 s | 12 s |
| A1 | the same, the hub still starting | S + X = 2,592.8 + 100 | 8 s | 14 s | 27 s |
| A1i | the same, the first hub start after an install | Si + X = 9,077.9 + 100 | 28 s | 46 s | 91 s |
| A | A1, also behind another window | S + W + X = 8,004.4 + 100 | 25 s | 41 s | 81 s |
| B | the largest real backlog, cold, as in A (run 1 only) | S + W + K + Bk = 12,422.3 + 100 | 38 s | 63 s | 125 s |
| C | a turn in 3 full parts, cold, as in A (run 1 only) | S + W + K + P3 = 13,657.6 + 100 | 42 s | 69 s | 137 s |

For example A1 at 5 times: 5 x 2,592.8 + 100 = 13,064 ms, so 14 s; A1i at 5 times: 5 x 9,077.9 + 100 = 45,489.5 ms,
so 46 s. Whatever a limit leaves stays unsaved and is saved at the session's next resume; a hung hub holds an exit for
up to the limit. Not in any row: writing the transcript's "saved" record after a turn's last entry (step 22), which
was not timed.

B and C rest on run 1's backlog and parts timings (Bk, P3) and run 1's lock wait (W), and do not include run 2's
slowdown of adds and saves; if the user picks B or C, they can be timed again in a second run before they are final.

Recommended (not chosen): A1, 14 s. It covers a `-p` run's only turn, the turn most at risk, at every real size,
cold, in a palace of 10,000 pieces, even while the hub is still starting, with the user's margin. It does not cover a
window whose exit waits behind another window saving a backlog (A), nor the first hub start after an install (A1i),
and it leaves to the next resume a backlog and a turn in parts. Its weak point: the run-to-run spread above (run 2's
adds and saves were slower than run 1's).

#### Fixes after the review (step 10), 2026-11-19

The user asked for all nine of the review's points to be fixed, with one new timing run (run 2, above):
1. The 3 typed turns first set apart (2 where the file ends mid-turn, 1 with a call without a result) are now kept
   and marked by `turns.mjs`, and counted in the save figures, as Q4 saves a turn however it ended. The plan's "left
   out of every figure" gave way to Q4 here, by the user's decision; a turn with a damaged line is still set apart.
   Measured by `scan`, read only, counts and lengths only: none of the 3 has model text, so none makes an entry, and
   no save figure changed (83 entries, longest 3,828, none over 100,000, the same bands and the same 11-turn backlog,
   in which none of the 3 sits). The test was changed first and seen to fail on the old rule.
2. The privacy wording: nothing from the Tachikoma transcripts is in any file; the snapshot listings, as approved at
   step 1, hold the names of the user's folders' files and stay in the build folder until step 31. Wording only; the
   listings are left as they are.
3. The first save after a start in the 2,000-entry palace: run 2, with a second save on each hub for a like-for-like
   comparison; the table's rows now name their palace and run, and the mixed comparison is replaced.
4. The options: rebuilt with the lock wait behind another window and the rest of a hub's start, each sum with its
   inputs.
5. The two-saver tries: given per palace (16 or 17 in "today", 21 in large). Each figure is from `results.json`'s
   `lockTriesPerRun`; the review read the "today" palace's only.
6. `measure-save.mjs`'s set-up started its self-test child (a Node process that only waits) without the build's
   environment, so it inherited the user's TEMP and TMP in run 1. It now gets the build's environment, as every other
   child; run 2 ran with it.
7. The first pair of snapshots: recorded with the user's explanation, not as established from this session's log.
8. Wording: "90th" for "90th of 100"; the part adds given in full, with the slowest of all, 2,565.4 ms.
9. The 1,000-character margin and the size bands: their sources stated, in the script and above; both only group
   this report.

After the re-check of those fixes (2026-11-19), all fixed, with no new run:
- A new option row, A1i, for the first hub start after an install, with when the plan lets it meet an exit (above).
- "The slowest of either run" now said only of S, X and K; B and C are marked as resting on run 1 alone.
- "Run 2 was slower all through" corrected to its adds and saves.
- The recommendation says what A1 does not cover; the table says the "saved" record's write is not timed.
- Run 2's pair, traced under the user's rule (above).
- Private details masked through this file, by the user's decision: Claude Code's session id as `<session>`, its
  temp folder id as `<id>`, the user's own palace key as `<palace key>`, the Windows user name in paths as `<user>`.

#### The user's choice (step 10), 2026-11-19

The user approved the figures above and chose the exit save's time limit: **option A1, 14 s**, by the rule 5 x (S +
X) + the fixed check interval: 5 x (1,445.9 + 1,146.9) + 100 = 13,064 ms, rounded up to 14 s. S is the rest of a hub's
start (1,321.4 + 121.0 + 3.5 ms) and X one real turn as the first save after a start in the 2,000-entry palace (run
2); the 100 ms is M3's check interval, a setting, not multiplied. The margin of 5 times is the user's, from M3; it was
not measured (no slower PC was run).
- Covered: the last real turn, at every real size, as the first save after a hub start, while the hub is still
  starting.
- Left to the next resume: an exit waiting behind another window saving a backlog (option A, 41 s), and the first
  hub start just after an install (option A1i, 46 s); also a backlog and a turn in parts (B, C). README's known limits
  should say so, at step 30.

Step 10 was committed (8b71e01, with the fixes b0b4937 and 9a8bdbf) before the user's answer, as steps 8 and 9 were;
the answer is in the commit after them.

### M8 The time limit on the lesson search when a tool fails (step 11, 2026-11-19)

In short: a search of one room takes about 0.1 s on a hub that is up and has searched before, in a palace of 9,800
pieces (about the largest earlier steps used). It takes about 0.2 s when anything was saved since the last search,
because every save empties the hub's search cache. It takes about 0.45 s when it is the first search after the hub
started. Two searches sent at once, as the note and `memory_search` send them, take about 1.4 to 2.0 times one
search. In the smallest palace (98 pieces, about what the user's transcripts would make today) every search but the
first after a start is under 45 ms. **The user approved the figures and chose one limit of 3.4 s for the lesson
search and the note's pair of searches (L3 with Q9-A), on 2026-11-19 (at the end of this part). The pair of snapshots
failed, on the user's MemPalace plugin's files only, and is traced under the user's rule ("The user's folders").**

Script: `scripts/8d/measure-search.mjs`, two commands: `timings` (the run) and `trial` (the same run cut short, to
check the script first; its figures are not used). The timings ran once, `node scripts/8d/measure-search.mjs
timings`, from 03:09:15 to 05:30:51 UTC, between a pair of snapshots: exit 0, "measure-search: passed", no failures.
Results: `tachi-8d-build\install\measure-search-timings-2026-11-19T03-09-15-212Z\results.json`, with every hub's log
beside it. Nothing was fetched; the dead-end proxy got 0 connections. No transcript or error log of the user's was
read. 373 processes were recorded; at the end none was still running and none was unsettled. One process was listed
apart and left alone: a `sleep.exe` that started at 05:30:46.5 UTC under an id that had belonged to one of this run's
hub processes; whose it was is not traced (the builder ran wait loops in this session at the time, and they use
`sleep`). All 123 hubs were started the decided way and stopped by the serving process's
id after its start time was read again; each was wholly gone within 19.9 to 24.6 ms.

This PC, as in M2, M3 and M4: Intel Core i9-12900K (16 cores, 24 threads), 68.4 GB of memory, solid-state disks (the
build folder is on C:), Windows 11 Pro 10.0.26200, Node v24.22.1, Defender's real-time scanning off (read again in
this run). Other programs of the user's were running as usual; their load was not measured (a look before the run
showed the processors 3 to 29% busy).

#### What a search does, in MemPalace 3.12.0's source

Read in the build's installed copy (`tachi-8d-build\env\Lib\site-packages\mempalace`), read only. These shape what was
timed:
- **Every room's pieces are read for every search.** With the `sqlite_exact` backend a search ranks the vectors of
  the palace's one collection, all rooms together, and keeps the asked room's by checking each piece's room in Python
  (`backends/sqlite_exact.py:1108-1156`, the room check at `:1148`). So a search's cost follows the palace's size,
  whichever room it asks for.
- **A cache, emptied by every write.** The vectors are read from the palace file once and kept in the hub
  (`:1130-1136`). Every write through the hub empties that cache (`:520-521`), and so does a write by another
  connection (`PRAGMA data_version`, `:1130-1132`). Each turn's save is a write, so the search after it reads every
  vector again. That is why "just after a write" is timed as a case of its own.
- **Reads take one lock.** A read takes the handle's lock (`:505-506`; writes take a lock of their own), so two
  searches sent at once do not run side by side all the way.
- **The limit.** The pool of candidates is at least 4 times `limit` (`searcher/candidates.py:26`, `:30-54`). Both ends
  of `limit` were timed: MemPalace's default, 5 (`mcp_server/tools_read.py:611`), and its most, 100 (`_MAX_RESULTS`,
  `mcp_server/_session.py:681`). The count Tachikoma will ask for is set later (M5, step 13; M6, step 14). (Set
  since: M5's count is 1 lesson, at a cut-off of 0.4862, the user's choice at step 13; M6's, for the note, is up to 3
  matches at a cut-off of 0.4861, the user's choice at step 14, "The user's choice (step 14)" at the end of M6.)
- A search folds hits that copy the same text, and then searches again with a pool 4 times wider, up to 16 times and
  500 candidates (`searcher/query.py:163-164`, `:177-186`, `:488-506`). Every text here was different, so that never
  happened in this run.

#### How the searches were timed

Every hub was started and stopped as step 8 proved (Q24, Q8, Q25): the build folder's `env\Scripts\python.exe -I -m
mempalace.mcp_server --transport http --port <p> --palace <palace> --backend sqlite_exact`, with
`MEMPALACE_EMBEDDING_MODEL=minilm`, `MEMPALACE_MCP_WRITER_WAIT_SECONDS=0` and `MEMPALACE_MCP_IDLE_HOURS=0`, in step 1's
`install` environment (TEMP and TMP inside the build folder) with step 5's offline settings and a dead-end proxy. The
script's code for starting, finding and stopping hubs and for keeping track of processes is copied unchanged from
`scripts/8d/measure-save.mjs` (its lines 44-697 and 699-709, which it copied from `scripts/8d/measure-hub.mjs`), but
for the run folder's and palaces' names, the result line and one comment. Every stage's palace read back
`sqlite_exact` (from `mempalace_status` and `/statusz`) and the model `minilm` (the palace file's `meta` table).

One new palace, in the wing `tachikoma`, with two rooms, `lessons` and a project's room (`measure-search-project`),
the entries alternating between them. It was filled in three stages, each a number of times over one pattern of
made-up filler (step 8's word filler, each text with a seed of its own): M2's "today" palace, 83 entries in 98 pieces
(72 of 1 piece, 9 of 2, 1 of 3 and 1 of 5), at M2's lengths for those pieces, 251 characters (the real middle), 870
(the real 90th) and 3,828 (the real longest); the one 3-piece entry has no recorded real length, so it was given the
most 3 pieces hold, 2,400. So the palace is laid out in pieces as the user's would be. The stages:

| Stage | Pattern times | Entries (project's room, `lessons`) | Pieces (each room) | Palace file |
|---|---|---|---|---|
| 1 | 1 | 83 (42, 41) | 98 (51, 47) | 4.5 MB |
| 2 | 10 | 830 (415, 415) | 980 (490, 490) | 9.1 MB |
| 3 | 100 | 8,300 (4,150, 4,150) | 9,800 (4,900, 4,900) | 54.4 MB |

Stage 1 is about the palace the user's transcripts make today (M2), stage 2 the size of M3's 1,000-piece palace, and
stage 3 about M2's and M3's largest (10,000 pieces), so the figures line up with theirs. Entries are counted with
`mempalace_list_drawers`, pieces with `mempalace_list_rooms` and `mempalace_status`; the file is the palace file and
its write-ahead log. Each stage's entries and pieces were read again after its timings and had not changed; the
palace files did grow (4,513,368 to 4,783,944 bytes; 9,117,536 to 9,310,048; 54,431,920 to 54,538,416), as the
writes and removals of the "just after a write" case left their marks. The table gives the sizes before the timings;
the comparison with the user's own palace below uses stage 3's size after them, 54,538,416 bytes.

At each stage, for each `limit` (5 and 100), these were timed:
- **One search**: of `lessons`, as the lesson search when a tool fails sends it (step 25), from the sending to the
  answer.
- **Two at once**: one search of the project's room and one of `lessons`, sent together on one connection, as the note
  and `memory_search`'s "this project" send them (Q27; step 18's client), from the sending of both to the arrival of
  the later answer.

Each of the two in three cases:
- **Warm**: on the stage's hub, after one search that was not timed, with nothing written since. 50 runs.
- **Just after a write**: one entry of 251 characters (a real turn's middle length) added to the project's room, as a
  turn's save, then the search, then that entry removed by its label (not timed), so the palace kept its size.
  50 runs.
- **The first search after the hub starts**: a new hub on the palace, its first good health answer, connected, then
  the search, then the hub stopped. 10 runs, each a start of its own.

50 runs of each case that needs no start, as M3's health checks (each is cheap, so more runs show the rare slow one);
10 of each that needs a start, as M3's starts. Every query was made-up text of 250 characters (the most MemPalace
takes, step 6 item 7), each different, shaped like the lesson search's: a tool's name and the start of an error. No
`max_distance` was sent (none is set yet). Connecting is not in any search figure: a window is already connected when
it searches. Here connecting took 2.7 to 7.2 ms, and the starts took 1,093.6 to 1,234.3 ms to the first health answer
(120 starts). The hub's start is not in the limit either: the lesson search runs only while memory is on, and with
memory off, or a hub not up, the failed tool's result stays byte for byte as today (step 25: "no match, a slow search
or memory off leaves the result byte for byte as today", plan.md:1349; design, section 5: "when it runs out, or the
hub is down, the error goes through unchanged").

A trial run first (`node scripts/8d/measure-search.mjs trial`, 03:06:02 to 03:07:25 UTC, stage 1 only, 3 runs of
each case and 1 start): exit 0, "measure-search: passed", 19 processes recorded, none left running, its own pair of
snapshots "no change". Its figures are not used. After the run, only comments in the script changed (three source
citations corrected); no code.

#### The figures

| Search time (ms) | Fastest | Middle | Slowest | Runs |
|---|---|---|---|---|
| 98 pieces, one search, warm, limit 5 | 21.3 | 23.6 | 29.7 | 50 |
| 98 pieces, one search, warm, limit 100 | 22.4 | 25.3 | 29.6 | 50 |
| 98 pieces, one search, just after a write, limit 5 | 22.1 | 25.2 | 30.0 | 50 |
| 98 pieces, one search, just after a write, limit 100 | 23.3 | 26.5 | 36.2 | 50 |
| 98 pieces, one search, first after a start, limit 5 | 268.6 | 285.4 | 416.4 | 10 |
| 98 pieces, one search, first after a start, limit 100 | 271.3 | 281.5 | 337.7 | 10 |
| 98 pieces, two at once, warm, limit 5 | 31.0 | 33.6 | 36.0 | 50 |
| 98 pieces, two at once, warm, limit 100 | 34.4 | 37.7 | 40.3 | 50 |
| 98 pieces, two at once, just after a write, limit 5 | 32.9 | 36.0 | 43.0 | 50 |
| 98 pieces, two at once, just after a write, limit 100 | 35.0 | 39.0 | 43.6 | 50 |
| 98 pieces, two at once, first after a start, limit 5 | 363.1 | 405.0 | 433.9 | 10 |
| 98 pieces, two at once, first after a start, limit 100 | 369.0 | 423.9 | 465.1 | 10 |
| 980 pieces, one search, warm, limit 5 | 25.9 | 29.1 | 34.3 | 50 |
| 980 pieces, one search, warm, limit 100 | 39.4 | 42.6 | 50.5 | 50 |
| 980 pieces, one search, just after a write, limit 5 | 35.7 | 41.1 | 52.9 | 50 |
| 980 pieces, one search, just after a write, limit 100 | 46.8 | 55.1 | 66.3 | 50 |
| 980 pieces, one search, first after a start, limit 5 | 278.7 | 303.0 | 423.1 | 10 |
| 980 pieces, one search, first after a start, limit 100 | 294.3 | 307.0 | 328.0 | 10 |
| 980 pieces, two at once, warm, limit 5 | 39.6 | 44.7 | 50.6 | 50 |
| 980 pieces, two at once, warm, limit 100 | 68.9 | 78.2 | 110.1 | 50 |
| 980 pieces, two at once, just after a write, limit 5 | 50.4 | 56.7 | 67.8 | 50 |
| 980 pieces, two at once, just after a write, limit 100 | 84.1 | 90.2 | 104.0 | 50 |
| 980 pieces, two at once, first after a start, limit 5 | 407.2 | 450.0 | 482.4 | 10 |
| 980 pieces, two at once, first after a start, limit 100 | 424.4 | 462.6 | 533.8 | 10 |
| 9,800 pieces, one search, warm, limit 5 | 81.5 | 89.9 | 118.2 | 50 |
| 9,800 pieces, one search, warm, limit 100 | 97.3 | 105.5 | **125.1** | 50 |
| 9,800 pieces, one search, just after a write, limit 5 | 184.3 | 200.3 | 250.3 | 50 |
| 9,800 pieces, one search, just after a write, limit 100 | 189.9 | 219.9 | **257.0** | 50 |
| 9,800 pieces, one search, first after a start, limit 5 | 407.9 | 433.5 | **611.9** | 10 |
| 9,800 pieces, one search, first after a start, limit 100 | 428.8 | 450.0 | 465.6 | 10 |
| 9,800 pieces, two at once, warm, limit 5 | 150.4 | 164.9 | 206.2 | 50 |
| 9,800 pieces, two at once, warm, limit 100 | 190.2 | 207.9 | **252.5** | 50 |
| 9,800 pieces, two at once, just after a write, limit 5 | 255.3 | 277.4 | 315.7 | 50 |
| 9,800 pieces, two at once, just after a write, limit 100 | 278.2 | 315.7 | **349.2** | 50 |
| 9,800 pieces, two at once, first after a start, limit 5 | 557.3 | 609.3 | 641.8 | 10 |
| 9,800 pieces, two at once, first after a start, limit 100 | 599.7 | 624.1 | **678.3** | 10 |

The hits: every search at limit 5 gave 5. At limit 100, every search at 980 and 9,800 pieces gave 100; at 98 pieces
a search of `lessons` gave 47 (all its pieces) and of the project's room 51, or 52 with the entry just written.

Two at once, the earlier of the two answers against the later (middles, ms): at 9,800 pieces warm 163.1 / 164.9
(limit 5) and 192.0 / 207.8 (limit 100); just after a write 276.3 / 277.4 and 299.3 / 315.7; first after a start
608.3 / 609.3 and 613.3 / 624.1. The earlier answer comes only a little before the later one.

Filling, plain adds (no lock or look-up), ms per add: stage 1 639.1 / 672.2 / 992.7 (83 adds); stage 2 653.4 / 718.0
/ 978.7 (747); stage 3 712.8 / 971.1 / 3,920.7 (7,470).

What the figures mean:
- A warm search grows with the palace: one search at limit 5, middles 23.6, 29.1 and 89.9 ms at 98, 980 and 9,800
  pieces.
- A search just after a write is about twice a warm one at 9,800 pieces (middles 200.3 against 89.9 ms), as the
  source says: the hub reads every vector again. In the small palaces the difference is a few milliseconds.
- The first search after a start costs about 230 to 260 ms more than one just after a write (middles 285.4 against
  25.2 at 98 pieces, 433.5 against 200.3 at 9,800). Most likely the hub loads the embedding model on its first query,
  as M2 found for the first add; that is an inference, as the load was not timed on its own.
- Two at once take 1.4 to 2.0 times one search, warm or just after a write, and 1.4 to 1.5 times as the first search
  after a start. The earlier of the two answers is not much earlier than the later, so giving one room's results alone
  when the other is late (step 18) would rarely save much time.
- `limit` 100 adds up to about 20 ms to a search's middle: warm 1.7 to 15.6 ms (the most at 9,800 pieces, 105.5
  against 89.9 ms), just after a write 1.3 to 19.6 ms.
- **A note for M2 (step 10):** the fill adds here were slower than M2's fill adds, and the cause is not determined
  (this PC's load, the filler text, or something else; none was measured). It is not an effect of entry size. From
  the hubs' own logs (`stage-<n>.stderr.log`, each add's `run=` time): stage 1, with M2's own 72/9/1/1 profile, took
  636 to 985 ms (middle 668, 83 adds) against M2's first 83 adds, 212 to 589 ms (middle 222, `today-series.stderr.log`
  of M2's run 1). In stage 3's fill the middles by pieces were 966 (1 piece), 981 (2), 998 (3) and 1,023.5 ms (5), and
  the slowest add, 3,916 ms (3,920.7 as the script timed it), was a 2-piece entry. Like for like with M2's X, the gap
  closes: a 5-piece add at about 10,000 pieces took a middle of 1,023.5 ms here (90 adds, slowest 1,148), against M2
  run 2's first-save add of 1,018.8 ms in the 2,000-entry palace. So the gap is against M2's fill, not against X's add.
  The chosen 14 s is not shown to fail: even with this run's slowest add, S + 3,916 + 100 = 1,445.9 + 3,916 + 100 =
  5,461.9 ms, about 5.5 s.
- Not measured: other systems; a slower PC; real-time scanning (off here); palaces larger than 9,800 pieces; a search
  while another window is writing (reads and writes take different locks, but the cache is emptied); a search while
  the saver's own write is still running; a search of the whole wing ("everything"); a search with `max_distance` set.
  Also: the two rooms here were of almost the same size, while the real `lessons` room will be much smaller than a
  project's room; and the first-after-a-start figures rest on 10 runs per case, with limit 5 slower than limit 100 at
  9,800 pieces (611.9 against 465.6 ms), so that tail is noisy.
- **The user's own MemPalace** (the `"use"` setting): this table does not describe it. That path runs the user's own
  program, which opens the user's own palace with the user's own settings (design, section 2, "The user's own
  MemPalace instead"), and MemPalace's default backend is chroma (plan.md:57, item 9); every figure here is
  `sqlite_exact` with `minilm`. The user's palace file was 6,822,883,328 bytes at step 10's second pair (M2, "The
  user's folders"), about 125 times this run's largest after its timings (54,538,416 bytes); how many pieces it holds
  is not known (it was not opened), and no search of it, or of any palace that size, was timed.

#### The user's folders

One pair of snapshots, taken in the same command just before and just after the run: `step11-before` (03:08:47 UTC)
and `step11-after` (taken after 05:30:51, finished 05:31:21). **It failed (exit 1)**, on the user's MemPalace only;
nothing else in any watched folder changed. Every child of the run had the build's home, TEMP and TMP; the script
itself (run with the user's TEMP, as in M2 and M3, since the build folder is found from it) wrote only in the build
folder. What changed, in two groups:
- **04:59:31.575 to 04:59:31.923 UTC**: `wal/write_log.jsonl` (2,403,134 to 2,404,492 bytes, 04:59:31.575),
  `hook_state/last_checkpoint` (04:59:31.802), one session's `hook_state/<session>_last_save` (04:59:31.899) and
  `locks/mine_palace_<palace key>.lock` (04:59:31.923); then, 33 s later, `palace/sqlite_exact.sqlite3-wal` (same
  size, 05:00:04.962) and the folder `locks` (05:00:04.968). Set apart as usual: `hook.log` (04:59:49.819),
  `queue.sqlite3` (05:00:04.987) and the daemon folder (05:31:07.379).
- **04:29:38.687 UTC**: another session's `hook_state/<session>_last_save`, alone. (A later change hides any other file
  that changed then.)

Both have the shape of the plugin's save, and the first the full chain of the user's rule (the plugin's files, then
the palace about 30 s later). **Traced afterwards, so explained** (the orchestrator, 2026-11-19, under the user's rule
as widened during step 11 to a plugin save by any of the user's Claude Code sessions, traced in that session's own
log: the "Snapshot rule widened" entry of
`C:\Users\<user>\.claude\orch\Agent Harness\2026-11-19-memory-and-lessons\user-decisions-after-step-6.md`, the
run folder's record of the user's decisions; the times are its "Step 11's pair, traced" entry): (1) the main
session's reply ended at 04:59:29.670 UTC (`end_turn`); the plugin's files changed at 04:59:31.6, about 2 s later,
and the palace's write-ahead log at 05:00:04.96; (2) another of the user's Claude Code sessions
(`<session>`) ended a reply at 04:29:37.773; its own `_last_save` changed at 04:29:38.7, and nothing else. The pair
failed, and counts as explained.

The trial's pair, `step11-trial-before` (03:05:35 UTC) and `step11-trial-after` (finished 03:07:52): "no change", with
only the set-apart daemon folder.

The same commands listed the top level of the user's Temp folder before and after (step 8's `templist2.cjs`: names,
kinds and last-written times only, no file opened). Around the run: no `uv-*.lock`; added, five files (origin not
traced; written 03:17:16, 04:17:16, 05:17:16, 04:25:47 and 05:30:48.9, the last 2 s before the run ended, of a kind
step 8's idle listings saw come and go in Temp with nothing of the build running); removed, a file (origin not
traced); rewritten, two files (origin not traced; 05:14:16.9 and 04:29:43.6). None was opened. Around the trial: no
`uv-*.lock`; a file (origin not traced) removed. No tsx ran.

#### The decision for the user: the lesson search's time limit, and Q9

What the limit does: when a tool fails, Tachikoma searches `lessons` and waits up to this long; past it, the error
goes to the model as it is, without lessons (design, section 5). So:
- **Too short**: lessons are left off a failure when the search is slow, most likely the first search after a hub
  start or one just after a save.
- **Too long**: a failed tool's result is held for up to the limit when the hub is slow or hung.

When each case meets the lesson search: just after a write is the usual case, since every turn's save is a write;
warm, when a search ran since the last save; the first after a start, when the window's first failure comes before
any search on a hub that has just started.

The inputs, each this PC's slowest at 9,800 pieces, the slower of the two limits (5 and 100), since the count is not
set yet (ms):

| Input | What it is | One search | Two at once |
|---|---|---|---|
| W | warm | 125.1 (limit 100) | 252.5 (limit 100) |
| A | just after a write | 257.0 (limit 100) | 349.2 (limit 100) |
| F | the first search after a start | 611.9 (limit 5) | 678.3 (limit 100) |

Each figure is the margin times the input, rounded up to the next 0.1 s. **The margin for slower machines is not
measured** (no slower PC was run); 5 times is the user's margin from M3, M4 and M2.

| Option | What it covers | One search: input | 3 times | 5 times | 10 times |
|---|---|---|---|---|---|
| L1 | warm only | W = 125.1 | 0.4 s | 0.7 s | 1.3 s |
| L2 | also just after a write | A = 257.0 | 0.8 s | 1.3 s | 2.6 s |
| L3 | also the first search after a start | F = 611.9 | 1.9 s | 3.1 s | 6.2 s |

For example L2 at 5 times: 5 x 257.0 = 1,285.0 ms, so 1.3 s. Each row also covers the rows above it, as its input is
the largest.

**Q9: does the note's pair fit the same limit?** Not at the same margin, in any row. The same cases for two at once:

| Pair case | Two at once: input | 3 times | 5 times | 10 times | Lesson limit at 5 times: its margin over the pair |
|---|---|---|---|---|---|
| warm | 252.5 | 0.8 s | 1.3 s | 2.6 s | L1 0.7 s: 2.5 times |
| just after a write | 349.2 | 1.1 s | 1.8 s | 3.5 s | L2 1.3 s: 3.7 times |
| first after a start | 678.3 | 2.1 s | 3.4 s | 6.8 s | L3 3.1 s: 4.5 times |

(The last column: the lesson limit's figure before rounding, 625.5, 1,285.0 and 3,059.5 ms, over the pair's input.)
The note meets the first-after-a-start case more often than the lesson search does: at a launch, the note's search is
often the first search after the window's hub started (Q9).

So the options for Q9:
- **Q9-A. One limit for both, taken from the pair's figure** (the pair's row in place of the one-search row): it
  covers both with the full margin; the lesson search then gets a little more room than its own figure needs.
- **Q9-B. One limit for both, taken from the one search**: the note's pair then has a smaller margin (the last column).
- **Q9-C. Two limits**, one from each table.

Recommended (not chosen): the first-after-a-start case with the user's margin of 5 times, as one limit for both from
the pair's figure (L3 with Q9-A): 5 x 678.3 = 3,391.5 ms, so **3.4 s**. It covers the note at a launch and a window's
first failure on a hub it has just started, in a palace of 9,800 pieces, and one figure is simpler. Its weak points: a
hung hub holds every failed tool's result for up to 3.4 s, and the user's own MemPalace (a far larger palace) was not
timed. A shorter choice, L2 with Q9-A at 5 times (1.8 s), also covers the first search after a start on this PC,
but with a margin of only 2.6 times (1,746.0 over 678.3 ms).

#### The user's choice (step 11), 2026-11-19

The user approved the figures above and chose **L3** (cover the first search after a start) with **Q9-A** (one limit
for both, from the pair's figure), as recorded in the "Step 11 (M8) and Q9" entry of the run folder's
`user-decisions-after-step-6.md` (above): **one limit of 3.4 s**, 5 x 678.3 ms (the slowest of two searches at once,
as the first search after a start, 9,800 pieces, limit 100) = 3,391.5 ms, rounded up to 0.1 s. It serves both the
lesson search when a tool fails (step 25) and the note's two searches at once (step 24). For one search it is above
L3's own 3.1 s. The margin of 5 times is the user's, from M3; it was not
measured (no slower PC was run).
- Covered: on this PC's figures with the user's margin, a search of a 9,800-piece palace warm, just after a write, and
  as the first search after a hub start, one search or two at once, at any `limit` from 5 to 100.
- Not covered: the user's own MemPalace (another backend and palace, not timed), palaces larger than 9,800 pieces, and
  the cases under "Not measured" above. A search that passes the limit leaves the failure's result as today, or the
  message without a note.

Step 11 was committed (ac6f4a9) before the user's answer, as steps 8 to 10 were; the answer is in the commit after
it.

### M7 How often the lesson ask would fire (step 12, 2026-11-19)

In short: in the user's Tachikoma sessions so far, the lesson ask would never have fired. It would have sent 0
requests in 80 whole turns over 7 days of use, 0 a day, at both the low and the high figure. In all those turns only
3 tool calls were real failures that the error log confirms, and in none of their turns did a later call doing the
same job work. Counting every error result as a failure, declined and cancelled calls too, it is still 0. Zero in 80
turns does not prove the rate is zero: the data fit anything up to about 1 ask in 27 turns (95% bound), about 0.4 a
day of use at the user's pace ("What the zero means"). Live asks will be fewer still, as they are sent only while
memory is on (Q16). **The user chose option A, the ask as designed, on 2026-11-19** (at the end of this part). A
looser rule, any later success after a confirmed failure (option B), would have asked in 1 of the 80 turns.

Script: `scripts/8d/measure-lesson-ask.mjs`, with its tests in `tests/memory/turns.test.ts`. It needs no MemPalace
and starts nothing. It reads the user's transcripts (`%LOCALAPPDATA%\tachikoma\sessions\<project>\<id>.jsonl`) and
error logs (`%LOCALAPPDATA%\tachikoma\errors\<project>.jsonl`; `src/cli.tsx:415`, `projectFile` in
`src/core/datadir.ts:18-26`, named by the same sha256 as the project's sessions folder, `src/core/sessions.ts:13-18`),
read only, and prints counts alone: no text, no session id, no file or folder name. It ran twice, each time between
a pair of snapshots: run 1, `node scripts/8d/measure-lesson-ask.mjs`, at 06:09:41 UTC, exit 0, with the plan's
figures; run 2 at 06:12:16 UTC, exit 0, after two lines were added (the ceiling and where the error results with no
row are, below), with the same figures and those two. After the review, run 3 at 06:33:00 UTC, exit 0, added option
B's figure (below), with every earlier figure the same. The output is in the build folder's `scratch\step12\run-1.txt`
to `run-3.txt`, not committed (step 31 deletes the build folder).

#### How the turns and the failures were found

- **The turns**: step 10's rule (`scripts/8d/turns.mjs`, M2), so "in the same turn" means what it will mean live. A
  background turn is a turn of its own; a Stop hook's feedback does not split a turn. Typed and background turns are
  both counted, as the ask would fire in either. Whole turns only: a turn with a damaged line, one the file ends in
  and one with a call left without a result are left out and counted apart, by reason.
- **Branch copies** (found in this step; the plan does not name them): `/branch` copies a transcript whole under a
  new id, its lines' times kept (`src/core/sessions.ts:95-103`). Its copied turns would be counted twice, and their
  error results could find no row, as the rows carry the first session's id. A transcript whose start line has the
  same time as another's in the same project folder is taken as a copy. Its turns whose first line is one of the
  earlier transcript's (by the files' creation times) are left out as "copied by a branch".
- **The key**: for each error result, the text the log would hold for it (`src/core/session.ts:1064`): the tool's
  name, a space and the input that ran (a hook's rewrite from the transcript's `rewritten` line where there is one,
  `src/core/transcript.ts:249-256`), cut exactly as `truncate` cuts it (`src/core/session.ts:41-43`; the test checks
  the script's copy against the code's on a 40,000-character input).
- **One row, one result, in time order**, within one session. A row can belong to an error result with its key whose
  call was sent no later than the row's time and whose result was saved at or after it. "Sent" is the reply's line,
  written before its calls run (`src/core/session.ts:661`, `:1320-1324`), and the row is written while the call
  runs. Both are stamped by the same clock to the millisecond, so a tie counts as sent before. A row with one such
  result confirms it, and a confirmed result is no other row's. A row with more than one makes them all "unclear":
  counted apart, as failures only in the high figure.
- **Rows from subagents** reach the lead's log with the task's id in front (`src/core/tasks.ts:371`); their calls are
  in the subagent's own file, which is not read. They are counted apart.
- **The same job**, the design's rule (section 5), on the inputs that ran:
  - a command (the `shell` tool): the same first word of the command, split at white space;
  - a file edit (`write_file` or `edit_file`): the same file, its path resolved against the session's project folder
    and compared without regard to letter case, as on Windows;
  - otherwise: the same tool.

  A turn asks when a failed call is followed, later in the turn's order of calls, by a call doing the same job
  whose result is no error. A turn asks once at most. The low figure leaves unclear results out; the high figure
  counts them as failures.
- **The ceiling**, beyond the plan's figures, as a bound: every error result counted as a failure, matched or not,
  declined and cancelled calls among them.
- **Option B's looser rule**, added after the review: a confirmed failure followed, later in the same turn, by any
  call whose result is no error, whatever its job. Same turn rule as above.

`tests/memory/turns.test.ts`, the plan's four cases, on made-up transcripts and made-up log rows only:
- a failure in a typed turn and a matching success in the background turn after it are not a pair;
- a failure and a matching success on either side of a Stop hook's feedback are a pair;
- a declined call with the same text as a real failure is not confirmed by that failure's row;
- two close identical calls with one row are counted unclear.

Also, beyond the plan's list: the key is cut as the session's `truncate` cuts it; and the ceiling in two of the cases
above. The tests were written first and failed, as the script did not exist. Then all 15 in the file passed (10 from
step 10 and 5 new). Each break was then tried on its own and put back:
- with the time window taken out of the match, the declined-call test failed;
- with unclear matches made to confirm, the unclear test failed.

The ceiling's expectations were added before its code and failed first (2 tests). `tsc` exit 0.

After the review, 3 more tests (18 in all, all passing; `tsc` exit 0):
- the key is built from a hook's rewrite of the call, the input that ran. It passed at once, as that code was
  already there; with the rewrite's branch broken it failed, and the branch was put back;
- option B's rule: a confirmed failure, then a successful call of another tool. It failed first, as the field did not
  exist;
- a missing `sessions` or `errors` folder is taken as empty, not a crash. It failed first, as `run` was not exported.

#### The figures

Days are on this PC's clock (UTC+11). All counts are from run 2; runs 1 and 3 give the same, their per-session lines
too. Option B's figure is from run 3.

| What | Count |
|---|---|
| Transcripts (main sessions) read | 53, in 10 project folders |
| Sessions | 53 (15 of them `-p` runs); none without a start line |
| Of them, branch copies | 3, so 50 distinct sessions; the 15 `-p` runs stand (none is a copy) |
| Sessions with at least one whole turn | 34 |
| Days of use (a day with a whole turn) | 7, from 2026-11-07 to 2026-11-18 |
| Whole turns | 80: 79 typed, 1 background |
| Left out: copied by a branch | 7 (all typed) |
| Left out: the file ends mid-turn | 2 |
| Left out: a call without a result | 1 |
| Left out: a damaged line | 0 (and 0 damaged lines before a first turn) |
| Error results in the turns read | 8: 3 confirmed, 0 unclear, 5 with no row |
| Turns with a confirmed failure | 3, all typed, in 3 sessions (2 on 2026-11-12, 1 on 2026-11-16) |
| The same, counting unclear results | 3 |
| **Turns that would ask, low figure** | **0** |
| **Turns that would ask, high figure** | **0** |
| Turns that would ask, ceiling (every error result a failure) | 0 |
| Option B: a confirmed failure, then any later success in the turn | 1 (0.14 a day of use; at most 1 in a day) |

Per day of use:

| Day | Sessions with a whole turn | Typed turns | Background turns | Confirmed failures | Asks, low | Asks, high |
|---|---|---|---|---|---|---|
| 2026-11-07 | 7 | 11 | 0 | 0 | 0 | 0 |
| 2026-11-10 | 2 | 7 | 0 | 0 | 0 | 0 |
| 2026-11-12 | 7 | 15 | 0 | 2 | 0 | 0 |
| 2026-11-13 | 4 | 11 | 1 | 0 | 0 | 0 |
| 2026-11-16 | 2 | 13 | 0 | 1 | 0 | 0 |
| 2026-11-17 | 7 | 16 | 0 | 0 | 0 | 0 |
| 2026-11-18 | 5 | 6 | 0 | 0 | 0 | 0 |

Per session, in start order, the whole typed turns: 0 0 2 0 1 0 0 0 3 1 1 1 2 6 1 0 0 5 0 1 0 0 1 3 3 1 1 7 1 1 0 2
0 2 0 0 0 0 0 11 7 1 0 1 1 2 2 2 1 1 1 2 1. The one background turn is in session 29. The confirmed failures are one
each in sessions 18, 24 and 34. No session would ask, at any of the three figures. In requests: 0 a day of use, and 0
in the busiest day (16 typed turns).

#### The limits of the method

- **Turns that could not be rebuilt**: 3 (2 the file ends in, 1 with a call without a result). Another 7 were left
  out as branch copies. All are outside the low and high figures.
- **Error results with no row**: 5. By kind, as counted at the review (counts only): 3 declined, 1 cancelled and 1
  other refusal. None is from a cut-off reply, and none is a real failure with its row missing. All 5 are in
  sessions whose project folder has an error log. With all 5 counted as failures (the ceiling), the count is still 0.
- **Unclear results**: 0.
- **Rows that matched no result**: 0. All 3 `tool` rows of these sessions confirmed one result each. 0 rows came from
  subagents, and 0 had no session id. 1 row in the same logs names a session with no transcript in its folder; it was
  not matched, and why that session has none was not looked into. Across all of the user's error logs there are 6
  `tool` rows (counted at the review). The script reads only the logs of folders that hold transcripts, so 2 more
  rows are in other logs. None of these 3 rows (the 1 here and those 2) matches any transcript's key (the review).
- **Sessions with no error log to match against**: 23, in the 4 project folders that have no log. They hold no error
  result at all, so the missing logs hide no failure. Another 27 sessions are in a folder with a log, with no row of
  theirs.
- **Only the sessions still kept**: older sessions deleted by the sweep (`src/core/sessions.ts:147-151`) are not here.
- **A small sample**: 80 whole turns over 7 days, with 3 real failures in all.
- **A looser rule**: under the design's rule even the ceiling is 0. Any later success in the turn after a confirmed
  failure (option B) gives 1 turn of 80 (run 3). The same tool for a command, in place of the same first word, gave
  0 at the review; the script does not count it.

#### What the zero means

0 asks in 80 whole turns. A count of zero cannot rule out a small rate. The highest rate that 0 in 80 still fits,
with 95% confidence, is 1 - 0.05^(1/80) = 3.7% of turns (the exact one-sided bound for no events in 80 tries). At the
user's pace, 80 / 7 = 11.4 whole turns a day of use, that is below about 0.42 asks a day of use. Each ask is one small
paid request to the lead (Q16), its spend reported like the judge's. No price is given here, as no cost per request
has been measured or sourced. Live asks will be fewer still, as they are sent only while memory is on (Q16).

#### The user's folders

Three pairs of snapshots, each taken in the same command just before and just after its run:
- `step12-before` (06:09:14 UTC) and `step12-after` (06:09:41);
- `step12-2-before` (06:11:49) and `step12-2-after` (06:12:16);
- after the review, `step12-3-before` (06:32:33) and `step12-3-after` (06:33:00), around run 3 and the M2
  correction's count.

**All three printed "no change" (exit 0)**; only the set-apart daemon folder of the user's MemPalace changed, as
usual. The script reads only, writes nothing and starts nothing; the snapshot tools write only in the build folder.
No tsx ran.

The same commands listed the top level of the user's Temp folder (step 8's `templist2.cjs`; names and times only, no
file opened). No `uv-*.lock` was found. Around run 1, a file was added at 06:09:51.2, 10 s after the run ended, while
the after-snapshot was being taken (origin not traced). Around run 2, a file was added at 06:12:10.2, while the
before-snapshot was being taken and 6 s before the run started (origin not traced), and a file was removed (origin
not traced). Around run 3, a file was added at 06:32:52.5, while the before-snapshot was being taken (origin not
traced). None was opened. **Open:** these Temp changes, in each of the three pairs, are not traced, as at the
earlier steps; nothing of this step's ran at those times but the snapshot tools, which write only in the build
folder.

One file of this step's own did land in the user's Temp, between the second and third pairs:
`Temp\step12-added.txt`, at 06:14 UTC. A scan of the step's own added lines for private details sent its output to
`/tmp`, which Git Bash maps to the user's Temp folder. It held only the step's own added lines (code, tests and this
record; no user data). It was deleted by exact name at once, and checked gone.

#### The decision for the user: build the ask as designed at this rate, or change it

What the rate means: under the design's rule, the ask would have sent no request at all in the user's 7 days of use
so far. The data allow up to about 0.4 a day. It has, so far, found nothing to learn from. Lessons can still come
from `record_lesson` and `/lesson`, which do not depend on this ask.

The options:
- **A. Build the ask as designed** (steps 26 and 27). It sends a request only when a failure is followed by a fix
  in the same turn, and only while memory is on. At the rate seen, that is 0 requests a day.
- **B. Change the rule so it fires more often**, for example any later success in the turn. Counted after the
  review (run 3): 1 of the 80 whole turns, about 0.14 a day of use, at most 1 in a day.
- **C. Drop the ask**, and keep lessons only from `record_lesson` and `/lesson`.

Recommended, not chosen: **A**. It costs nothing at the rate seen, and costs only when there is a fix to learn
from. Its weak point: with no ask seen, nothing here shows that its lessons would be useful for this user's work.

**The user's choice: not yet given.** (Answered below.)

#### The user's choice (step 12), 2026-11-19

The user chose **option A: build the lesson ask as designed** (steps 26 and 27), as recorded in the "Step 12 (M7)"
entry of the run folder's `user-decisions-after-step-6.md`. The ask fires when a failure is followed, in the same
turn, by a call doing the same job. It was seen 0 times in 80 whole turns over 7 days, with a 95% bound of about 1 in
27 turns, about 0.4 a day. Not B (any later success: 1 in 80, about 0.14 a day), and not C (drop the ask). The user
also said to fix all of the review's points; this part and the correction note in M2 (above) are those fixes.

From the same answer, for later steps: step 22's saver must not save turns that `/branch` copied into a new session
as new entries again; its label and MemPalace's exact-duplicate answer (`already_exists`) must be checked to cover
it, or it is built so they do. Step 14 leaves `/branch` copies out of its counts.

Step 12 was committed (5021fce) before the user's answer, as steps 8 to 11 were; the answer and the fixes are in the
commit after it.

### M5 The lesson cut-off and count, from the error logs (step 13, 2026-11-19)

**This is the first run. The cut-off and the count are NOT chosen from its figures** (the user's answers after its
review, 2026-11-19): it compared error lines with error lines, and Q18 has since changed for the `shell` tool. The
figures the user chooses from are those of the re-run, "M5, the re-run", after this part. This part keeps its
figures as they were, with the review's corrections marked "(Corrected after the review.)".

In short: there are no lessons yet, so past tool failures stood in for them. Each failure's text (the tool's name and
the first line of its error, Q18) was put in a palace, and each failure in turn was searched for, scoring every other.
**Real lessons will be sentences written by the model or the user, not raw errors, so both sets here are
stand-ins:** the figures say how MemPalace scores one error line against another, not how it will score an error
against a lesson. What was found:
- **The user's error logs hold 6 tool failures**, too few to set a figure. Among them is one pair that is "the same"
  by the plan's rule (the two failed commands), at a distance of 0.2016; the closest pair that is not is at 0.4039.
  (Corrected after the review.) This set is possibly test-polluted: before commit cce56d5 (2026-11-06) Tachikoma's
  tests wrote rows into the user's real errors folder (at least 126 rows naming `ollama:none`), and one of the two
  `shell` rows, from 2026-11-04, may be a test's, so the set may hold no "same" pair at all.
- **A made-up set of 94 failures**, in the shapes of Tachikoma's own tool errors (the user's addition), shows the
  scores of "same" and "different" failures overlapping widely. Where a path is most of the line, two "same" failures
  score far apart (up to 0.68); where two different errors share most of their words, they score very close (down to
  0.038). No cut-off keeps most "same" matches in and the others out: at the cut-off that lets in 1% of the
  different pairs (0.2526), 46% of the same pairs are in.
- **Failed commands with an exit status look alike to this search.** A failed `shell` call that ran and ended with
  an exit code or a signal has its status alone as its first line (`exit code: <n>` or `killed by <signal>`,
  `src/tools/shell.ts:5-7`), so with Q18's rule as it then was the query carries no part of the command, and any two
  such failures are "the same" by the rule. A lesson about one such command would attach to every other within the
  cut-off. (Corrected after the review: not every `shell` failure has that shape; a timeout,
  `src/tools/commands.ts:72-75`, and a command that could not be started, `src/exec/local.ts:101-102`, have their
  own text.)
- The cut-off and the count wait on the user (the options are at the end of this part).

Script: `scripts/8d/measure-lessons.mjs`, two commands: `madeup` (the made-up failures alone, to check the script
before it read the user's logs) and `run` (the made-up failures, then the real ones). It ran three times, each between
a pair of snapshots: the check, `node scripts/8d/measure-lessons.mjs madeup`, 06:54:34 to 06:56:27 UTC; run 1, `node
scripts/8d/measure-lessons.mjs run`, 06:58:27 to 07:00:24; and run 2, the same command, 07:04:18 to 07:06:15, after
the tables were changed to show every source's candidate cut-offs on both sources. All three: exit 0,
"measure-lessons: passed", no failures. Every count and score that runs 1 and 2 both print is the same in both,
the made-up ones the same as in the check too; the figures below are run 2's. Results:
`tachi-8d-build\install\measure-lessons-run-2026-11-19T07-04-18-601Z\results.json` (counts and scores only). After
run 2, one comment in the script changed (a source line corrected); no code.

Each run started two hubs, one per source, the way step 8 proved (Q24, Q8, Q25), with code copied unchanged from
`scripts/8d/measure-search.mjs` (its lines 38-691) but for the run folder's and palaces' names and the result line.
Each was stopped by its serving process's id after its start time was read again, and was wholly gone within 24.4
to 27.2 ms. Run 2 recorded 10 processes; none was left running, none unsettled, none another program's. Each hub read
back `sqlite_exact` (`mempalace_status` and `/statusz`) and the model `minilm` (the palace's `meta` table). Nothing was
fetched; the dead-end proxy got 0 connections. Every child had the build's home, TEMP and TMP.

#### What was read, and how the user's text was kept out

The user's error logs, `%LOCALAPPDATA%\tachikoma\errors\*.jsonl`, read only, each row as `src/core/errorlog.ts` reads
one (`parse`: `kind`, `attempted` and `message` are text):

| What | Count |
|---|---|
| Log files | 634 |
| Rows | 640, 0 unreadable |
| Rows of other kinds | 634 (582 `provider`, 45 `judge`, 4 `mcp`, 2 `hook`, 1 `shortening`) |
| `tool` rows, the failures | 6: 2 of `shell`, 2 of `read_file`, 2 of MCP tools; 0 from subagents |
| Of them, first lines that are a command's exit status | 2 (the two `shell` rows) |

Noticed, not looked into: 631 of the 634 files hold one row, and 628 were last written between 2026-10-30 and
2026-11-05; of all 640 rows, 627 are `provider` or `judge` rows. They are not tool failures and play no part here.

No text of the user's left the script: no error, input, path or session id is in any output, file or commit; the
output and `results.json` hold counts and scores only, and a failure while the real rows were handled would have said
its error's name alone. The palace held the texts while it ran, as the plan says, and was then deleted by its exact
name (below). MemPalace's own write log keeps no text (it redacts content and queries, `mempalace/wal.py:28-29`,
`:92-93`), and the hub's log holds lengths and times only. After run 2 a scan, in one process, for each real text and
each first line alone (22 strings of 12 characters or more, plain and as JSON would write them) through every file in
the build folder's `install` folder and this step's outputs (11,927 files, 935 MB) found them in no file of MemPalace's
or of the runs. Its one hit was a scratch file of the builder's own, a check of the script on hand-made data; the
string it shares is one of Tachikoma's own fixed status lines, not text of the user's. A scan for the made-up texts
after the check run found none outside the palace either, and the same scan found filler text in an older palace
file, so it does find text where there is some.

#### How it was measured

- **The text** of a failure: the tool's name, a space and the error's first line, as `/errors` shows that line
  (`src/core/errorlog.ts:60`; Q18). The tool's name is the first word of the row's `attempted`, after a subagent's
  task id. The joining space is the script's reading; step 25 builds the live query.
- **The palace**: one per source, in the build folder, wing `tachikoma`, room `lessons`. Each failure was added in
  turn, the whole text as the entry. Identical texts are stored once: MemPalace answers `already_exists` for the rest
  (step 6 item 9), and the script counted the repeats itself to compare.
- **The cut** (corrected after the review): this run cut each text with Node's `slice`, which counts UTF-16 units,
  while MemPalace counts characters (code points; `maxLength` 250, `mempalace/mcp_server/schemas.py:309`). A text
  with characters outside the basic plane is therefore cut a little shorter than MemPalace allows, never longer. The
  re-run's rule (`scripts/8d/lesson-query.mjs`) cuts by code point, and step 25 must too.
- **The searches**: each failure in turn, its text cut to 250 characters (step 6 item 7, as step 25 will cut it), one
  search of `lessons` with `limit` 100, MemPalace's most (`_MAX_RESULTS`, `mempalace/mcp_server/_session.py:681`), so
  that every entry came back: each palace held 100 entries or fewer, and every search returned all of them.
- **The score**: MemPalace's `distance` for a hit (`mempalace/searcher/query.py:425`), the cosine distance of the two
  vectors: 0 is identical, lower is closer; MemPalace's `similarity` is 1 minus it (`mempalace/search_util.py:158`).
  For an entry in several pieces the closest piece counts (every entry here was one piece). No hit had a closet boost
  (its `effective_distance` equalled its `distance` every time).
- **MemPalace's query rewriting**: MemPalace rewrites a query of over 200 characters that it takes for a pasted prompt
  (`mempalace/query_sanitizer.py:77-189`). A one-line query of 250 characters or fewer comes through unchanged but for
  quotes around the whole; the script compared each answer's query with the one sent, without keeping it.
- **"The same"**, the plan's rule: the same tool, and the same first line once quoted text, paths and numbers are
  blanked, in that order. The script's exact reading (`blank`): quoted text is a span in `''`, `""` or backquotes that
  begins and ends at a word's edge, so the apostrophe in "Tachikoma's" opens none; a path is a URL, a run of
  characters holding a slash or a backslash, with or without a drive letter, or a file name with an extension
  (`package.json`); a number is a run of digits. So `ENOENT: no such file or directory, open 'C:\work\a.ts'` becomes
  `ENOENT: no such file or directory, open <q>`, and `old_text appears 12 times in src/a.ts; ...` becomes `old_text
  appears <n> times in <p>; ...`. A pattern given to `search_files` is not blanked (it is none of the three), so two of
  its errors for different patterns count as different.
- **The pairs**: for each failure, every entry but its own, "same" or "different" by the rule. A failure whose text
  another failure also has is given its own entry as an "identical" match, at its own score, standing in for the
  lesson of an identical earlier failure.
- **The candidate cut-offs**, taken from the scores: for each source, the middle, 75th and 90th percentile and the
  largest of its "same" scores, and the smallest and the 1st, 5th and 10th percentile of its "different" scores
  (nearest rank, so each is a score that occurred). Both sources' candidates are shown in both sources' tables; each
  table's figures are its own source's alone.
- **What a count attaches**: for each failure, the entries inside the cut-off, closest first, up to the count.
  "Like" is an identical or same match.

#### The made-up failures (written for this measurement; never taken from the user's logs)

Each is a tool's name and the first line of an error in the shape Tachikoma's own code gives it, from `src/tools/`,
`src/exec/` and `src/mcp/` (the source lines below; Node's and zod's own wording where Tachikoma passes it on, checked
by making those errors happen in the build folder). Every path, number, server and pattern in them is made up. They
are in the script, marked as made-up. A family's 5 members differ only in what the rule blanks, so any two are the
same; a single has no member like it, and its nearest neighbours differ in words or in the tool, the hard cases for a
cut-off. Before any hub started, the script checked every pair against the rule: two are the same exactly when they
are in one group.

How many, and why: one search returns at most 100 results, so the set was held to 100 entries or fewer, so that every
search scores every other entry. The shapes used are 16 with a part the rule blanks and 13 without; (100 - 13) / 16 =
5.4, so each family has 5 members: 16 x 5 + 13 = 93 entries. One single is given twice, the fewest that checks
MemPalace's `already_exists` against the script's own count: 94 failures. That makes 320 same pairs (16 families x 5 x
4, both ways), 2 identical and 8,328 different. The number of same matches a made-up failure has (4 in a family, 0
for a single) is set by this design; what the set measures is how the scores of same and different pairs lie.

In the table, G is the tool `mcp__github__create_issue` and D is `mcp__docs__search`.

| Group | Tool | Error's first line (what varies) | Source |
|---|---|---|---|
| F1 | `shell` | `exit code: <n>` (1, 2, 127, 128, 255) | `src/tools/shell.ts:5`, `commands.ts:87` |
| F2 | `shell` | `Stopped: the command did not complete within its <n>s timeout. ...` | `commands.ts:72-75` |
| F3 | `read_file` | `ENOENT: no such file or directory, open '<path>'` (5 paths) | `src/exec/local.ts:163` |
| F4 | `read_file` | `<path> is in Tachikoma's data folder, ...` | `src/tools/files.ts:253` |
| F5 | `read_file` | `<path> is a program's environment, ...` (5 `.env` files) | `files.ts:260` |
| F6 | `read_file` | `<path> is a network or device path not written as a path in the project, ...` | `files.ts:237` |
| F7 | `edit_file` | `old_text was not found in <path>` | `files.ts:373` |
| F8 | `edit_file` | `old_text was not found in <path> (the file uses CRLF line endings in places)` | `files.ts:373` |
| F9 | `edit_file` | `old_text appears <n> times in <path>; include more surrounding text ...` | `files.ts:374` |
| F10 | `edit_file` | `<path> is not UTF-8 text, so edit_file would damage it` | `files.ts:366` |
| F11 | `edit_file` | `ENOENT: no such file or directory, open '<path>'` (other paths than F3) | `local.ts:163` |
| F12 | `write_file` | `EPERM: operation not permitted, open '<path>'` | `local.ts:169` |
| F13 | `write_file` | `EBUSY: resource busy or locked, open '<path>'` (F12's paths) | `local.ts:169` |
| F14 | `write_file` | `<path> is one of Tachikoma's settings files, ...` | `files.ts:258` |
| F15 | `find_files` | `ENOENT: no such file or directory, realpath '<folder>'` | `src/tools/search.ts:81` |
| F16 | D | `https://docs.example.com/mcp answered <n>` (500, 502, 503, 504, 429) | `src/mcp/server.ts:1003` |
| S1, S2 | `shell` | `killed by SIGTERM`; `killed by SIGKILL` | `shell.ts:5` |
| S3 (twice) | `read_file` | `EISDIR: illegal operation on a directory, read` | `local.ts:163` |
| S4, S5 | `read_file` | zod's `Invalid input for read_file: ...`, for two problems | `src/tools/tool.ts:47` |
| S6, S7 | `search_files` | `(?i)error is not a regular expression: ...`; the same for `(?i)warning` | `search.ts:243` |
| S8, S9 | G; D | `The MCP server <name> has stopped; ...` | `src/mcp/tools.ts:30` |
| S10 | G | `Stopped: the MCP server github restarted while the call ran.` | `tools.ts:31` |
| S11 | G | `Not run: github's tool "create_issue" changed while this call waited; ...` | `tools.ts:27-29` |
| S12 | G | `The MCP server github needs sign-in, which the user does from /mcp.` | `server.ts:93` |
| S13 | G | `its new connection failed, so the call was not sent: connect ECONNREFUSED ...` | `tools.ts:36` |

#### The figures

| What | Made-up | Real |
|---|---|---|
| Failures | 94 | 6 |
| Distinct texts (entries) | 93 | 6 |
| `already_exists` answers / the script's own count of repeats | 1 / 1 | 0 / 0 |
| Entries by `mempalace_list_drawers`; pieces | 93; 93 | 6; 6 |
| Queries cut at 250 characters | 1 | 0 |
| Queries MemPalace rewrote | 0 (2 marked, unchanged) | 0 |
| Pairs, both ways: identical / same / different | 2 / 320 / 8,328 | 0 / 2 (1 pair) / 28 |
| Failures with an identical or same match | 82 of 94 | 2 of 6 |
| Same matches per failure: middle / most | 4 / 4 (set by the design) | 0 / 1 |

Distances, lower is closer (percentiles by nearest rank):

| Pairs | Source | Count | Smallest | 10th | 25th | Middle | 75th | 90th | Largest |
|---|---|---|---|---|---|---|---|---|---|
| A failure against its own entry | made-up | 94 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0087 |
| A failure against its own entry | real | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Identical | made-up | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Same | made-up | 320 | 0.0022 | 0.0173 | 0.1200 | 0.2715 | 0.3901 | 0.5267 | 0.6785 |
| Same | real | 2 | 0.2016 | 0.2016 | 0.2016 | 0.2016 | 0.2016 | 0.2016 | 0.2016 |
| Different | made-up | 8,328 | 0.0377 | 0.5825 | 0.6864 | 0.7851 | 0.8837 | 0.9401 | 1.1079 |
| Different | real | 28 | 0.4039 | 0.6905 | 0.7233 | 0.8141 | 0.8416 | 0.9004 | 0.9425 |

The one made-up failure scored 0.0087 against its own entry is the one whose query was cut at 250 characters.

**The made-up failures at each candidate cut-off.** Inside: of the 320 same and the 8,328 different pairs. Per
failure: how many entries fall inside, middle / 90th / most. Then what a count of 1 to 5 attaches over all 94
failures, like / different, and how many failures get any lesson (the same at every count). Where each cut-off
comes from: 0.0377 made-up different, smallest; 0.2016 real same (all four percentiles: there is one pair); 0.2526
made-up different, 1st; 0.2715 made-up same, middle; 0.3901 made-up same, 75th; 0.4039 real different, smallest,
1st and 5th; 0.5123 made-up different, 5th; 0.5267 made-up same, 90th; 0.5825 made-up different, 10th; 0.6785
made-up same, largest; 0.6905 real different, 10th.

| Cut-off | Same in | Different in | Per failure | 1 | 2 | 3 | 4 | 5 | Get any |
|---|---|---|---|---|---|---|---|---|---|
| 0.0377 | 46 (14.4%) | 1 (0.01%) | 0 / 4 / 4 | 17 / 1 | 28 / 1 | 38 / 1 | 48 / 1 | 48 / 1 | 18 |
| 0.2016 | 112 (35.0%) | 36 (0.4%) | 1 / 4 / 4 | 33 / 20 | 65 / 29 | 91 / 35 | 114 / 36 | 114 / 36 | 53 |
| 0.2526 | 146 (45.6%) | 84 (1.0%) | 2 / 5 / 9 | 36 / 30 | 73 / 42 | 107 / 53 | 140 / 58 | 147 / 66 | 66 |
| 0.2715 | 160 (50.0%) | 106 (1.3%) | 2 / 6 / 9 | 38 / 32 | 77 / 45 | 112 / 56 | 147 / 62 | 157 / 74 | 70 |
| 0.3901 | 240 (75.0%) | 202 (2.4%) | 4 / 11 / 12 | 46 / 38 | 99 / 56 | 149 / 74 | 203 / 85 | 221 / 105 | 84 |
| 0.4039 | 242 (75.6%) | 214 (2.6%) | 4 / 11 / 13 | 46 / 38 | 99 / 56 | 149 / 75 | 204 / 87 | 223 / 108 | 84 |
| 0.5123 | 284 (88.8%) | 418 (5.0%) | 5 / 17 / 19 | 49 / 43 | 108 / 70 | 168 / 93 | 231 / 111 | 257 / 147 | 92 |
| 0.5267 | 288 (90.0%) | 464 (5.6%) | 6 / 17 / 19 | 49 / 43 | 108 / 70 | 168 / 95 | 233 / 115 | 259 / 162 | 92 |
| 0.5825 | 298 (93.1%) | 836 (10.0%) | 11 / 20 / 27 | 50 / 44 | 110 / 76 | 171 / 105 | 236 / 129 | 262 / 191 | 94 |
| 0.6785 | 320 (100%) | 1,938 (23.3%) | 24 / 39 / 54 | 50 / 44 | 110 / 77 | 171 / 108 | 236 / 135 | 262 / 201 | 94 |
| 0.6905 | 320 (100%) | 2,163 (26.0%) | 27 / 45 / 58 | 50 / 44 | 110 / 78 | 171 / 111 | 236 / 138 | 262 / 204 | 94 |

At a count of 1, how many failures get a different lesson as their first, and how many of the 82 failures that have
a like match get none: 1 and 65 at 0.0377; 20 and 49 at 0.2016; 30 and 46 at 0.2526; 32 and 44 at 0.2715; 38 and 36
at 0.3901 and 0.4039; 43 and 33 at 0.5123 and 0.5267; 44 and 32 at 0.5825 and above.

**The real failures at the same cut-offs** (2 same pairs both ways, that is 1 pair; 28 different both ways;
possibly test-polluted, above). No failure has more than one entry inside
at any of them, so every count from 1 to 5 attaches the same:

| Cut-off | Same in | Different in | Attached: like / different | Get any |
|---|---|---|---|---|
| 0.0377 | 0 | 0 | 0 / 0 (the two failed commands get nothing) | 0 |
| 0.2016, 0.2526, 0.2715, 0.3901 | 2 (100%) | 0 | 2 / 0 (each failed command gets the other's) | 2 |
| 0.4039 up to 0.6785 | 2 (100%) | 2 (7.1%) | 2 / 2 | 4 |
| 0.6905 | 2 (100%) | 4 (14.3%) | 2 / 4 | 6 |

**Which made-up pairs score closest though different, and farthest though the same** (the groups are in the table of
made-up failures above). Closest different: S6 and S7 (`search_files`, two patterns), 0.0377; F7 and F8 (`old_text
was not found`, with and without the line-endings note), 0.0440; S10 and S11 (an MCP server restarted; a tool
changed), 0.0930; S8 and S12 (a server stopped; it needs sign-in), 0.1022; S8 and S10, 0.1147; S1 and S2 (`killed by
SIGTERM`; `SIGKILL`), 0.1421; S10 and S12, 0.1564; F7 and F9, 0.1715; S11 and S12, 0.1773; F8 and F9, 0.1925; S8 and
S11, 0.2042; S4 and S5 (two kinds of invalid input), 0.2166. Farthest same, each family's farthest pair: F11 0.6785,
F3 0.6459, F15 0.5031, F6 0.4909, F13 0.4180, F12 0.4151, F10 0.3841, F5 0.3765, F7 0.3206, F8 0.3201, F9 0.2764, F1
0.2060, F4 0.1620, F14 0.1059, F2 0.0303, F16 0.0143.

What the figures mean:
- **The score follows the words, not the rule.** Where the error's own words are few and a path is most of the line
  (the `ENOENT` families F3, F11 and F15, and network paths F6), the path decides the score, and two failures that
  are the same by the rule score as far apart as 0.4909 to 0.6785, about as far apart as the closest quarter of
  different pairs (corrected after the review: only 1,938 of the 8,328 different pairs, 23.3%, are at or under
  0.6785). Where the words are
  many and only a number changes (timeouts F2, HTTP statuses F16), same pairs score within 0.03. And two different
  errors that share most of their words score very close, from 0.038.
- **So no cut-off separates them.** Taking in half the same pairs (0.2715) lets in 106 different ones; taking them
  all (0.6785) lets in 1,938, about 1 in 4. At a count of 1, the first lesson is a different one for 1 failure at the
  tightest cut-off and for up to 44 of the 94 at the loosest.
- **The count matters only where many entries fall inside.** In the real set no failure had more than one; in the
  made-up set the likes per failure are capped at 4 by design, so a count above 1 mostly adds different ones at the
  looser cut-offs (at 0.3901: count 1 attaches 46 like and 38 different, count 3 149 and 74, count 5 221 and 105).
- **The real set is too small to set a figure**: 6 failures, one same pair (2 both ways). That pair is the two
  failed commands, whose texts differ only in the exit code; its 0.2016 says how close `exit code: <n>` lines are, not
  whether the two commands were alike. And the set is possibly test-polluted (above): one of the two may be a test's.
- **Failed commands with an exit status** (corrected after the review): a command that ran and ended with an exit
  code or a signal has the text `shell exit code: <n>` (or `shell killed by <signal>`) under the rule as it then was:
  the command and its error output are on later lines (`src/tools/shell.ts:5-7`), which that rule left out. So every
  such failure is the same as every other by the rule. In the made-up F1 family, five of them with different exit
  codes, the farthest pair is 0.2060, so a cut-off from 0.2060 up would attach a lesson filed from one of those five
  to all the others; that figure holds for F1 only. A timeout (F2) and a command that could not be started have
  their own text and are not caught by this.
- **Real lessons will score differently.** A lesson is a sentence ("what went wrong, what fixed it, and how to spot
  it", the ask's approved wording), not an error line, so its distance from a new error will most likely be larger
  than these error-to-error distances; that was not measured, as there are no lessons yet. A cut-off taken from these
  tables may then let fewer lessons through than the tables show.

Not measured: lessons written as sentences against errors; the user's own MemPalace (the `"use"` setting; another
backend and model); errors in other languages than English (the model is English-focused); first lines longer than
250 characters among real failures (none, 0 cut); a palace of more than 100 lessons, where a search would return only
the closest 100.

#### The user's folders

Three pairs of snapshots, each taken in the same command just before and just after its run:
- the check: `step13-madeup-before` (06:54:08 UTC) and `step13-madeup-after` (after 06:56:27): "no change" (exit 0),
  with only the set-apart daemon folder of the user's MemPalace;
- run 1: `step13-before` (06:58:00) and `step13-after` (after 07:00:24): "no change" (exit 0), the same;
- run 2: `step13-2-before` (07:03:51 to 07:04:18) and `step13-2-after` (after 07:06:15): **failed (exit 1)**, on the
  user's MemPalace only. Changed: `palace/sqlite_exact.sqlite3-wal` (same size, written 07:03:22.200 and again
  07:03:52.719 UTC) and the folder `locks` (07:03:45.914, then 07:03:52.722), with one lock file in it,
  `locks/<lock id>.lock`, removed; set apart as usual, the daemon folder and its `queue.sqlite3` (07:03:52.740). So a
  save of the user's palace was under way as run 2's before-snapshot was taken (its lock already there, the palace
  written 2.7 s later). Nothing of the build writes to `~/.mempalace`: every child had the build's home. **Traced
  afterwards, so explained** (the orchestrator, 2026-11-19, under the user's rule: the "After step 13's review" entry
  of the run folder's `user-decisions-after-step-6.md`): the main session's reply ended at 07:03:20.523 UTC, its Stop
  hook ran at 07:03:22.5, and the user's palace was written at 07:03:22.2 and 07:03:52.7. The pair failed, and counts
  as explained. Run 1, with the same figures, had a clean pair.

The same commands listed the top level of the user's Temp folder (step 8's `templist2.cjs`; names and times only, no
file opened). No `uv-*.lock` in any of the three. In each, one file was removed (origin not traced) and nothing was
added or rewritten. None was opened.

The palaces, each deleted by its exact name after its hub had stopped, file by file, following no link:
`measure-lessons-<stamp>-madeup` (7 files and its folder) and `measure-lessons-<stamp>-real` (3 files and its folder)
in each run, under `tachi-8d-build\install\home\palaces`. None is left: `palaces` holds no `measure-lessons-*`
folder. MemPalace's own server records and lock files for them stay in the build home, as at earlier steps, for step
31.

#### The decision for the user: the lesson cut-off and the count

**Not offered for the choice** (the user's answers after the review): these options are kept as they were put; the
user chose option M, a new measurement, and the choice is made from the re-run below. (Corrected after the review.)
Every option here also rests on how the made-up set was designed: its families, their sizes and their wording are
the builder's, and other made-up sets would give other figures.

What the two numbers do (design, section 5): when a tool fails, Tachikoma searches `lessons` and adds the matches at
or below the cut-off, closest first, up to the count, after the error the model sees (and only as many as fit the cap,
Q23). Too loose a cut-off or too high a count gives the model lessons from other failures; too tight gives none.

The options for the cut-off, from the tables, each with what it attaches on both sets (at a count of 1):
- **A. 0.0377** (the closest made-up different pair). Made-up: 18 of 94 failures get a lesson, 17 of them a like
  one; 65 of the 82 that have a like one get none. Real: nothing is attached at all. In practice: only near-copies
  of one error, where a number or a short path differs.
- **B. 0.2016** (the real same pair). Made-up: 53 get one, 33 like and 20 different. Real: each failed command gets
  the other's, nothing else. In practice: failed commands always match one another (above); errors that name a file
  mostly do not match the same error on another file (the farthest same pairs of F3, F5, F6, F10 to F13 and F15
  are 0.38 to 0.68).
- **C. 0.2715** (half the made-up same pairs). Made-up: 70 get one, 38 like and 32 different. Real: as B.
- **D. 0.3901** (three quarters of the made-up same pairs). Made-up: 84 get one, 46 like and 38 different. Real: as
  B.
- **E. 0.5267** (nine tenths of the made-up same pairs). Made-up: 92 get one, 49 like and 43 different. Real: 4 get
  one, 2 like and 2 different.

The options for the count, from the same tables: **1** (the closest only); **2** or **3**, which at B add 32 and 58
like ones and 9 and 15 different ones over a count of 1 in the made-up set, and nothing in the real one; or more,
which past 3 add few likes (a made-up failure has 4 at most by design) and more different ones.

Two further options, not measured, because the tables measure raw error lines against each other:
- **M. Measure again with made-up lessons written as sentences** (in the ask's one-line form), against the made-up
  failures, before fixing the figures. New work: a new set to write and a new run.
- **Q. Change what is searched** (Q18), for example blank numbers, paths and quoted text in the query and in the
  stored text, or add a failed command's first word to its text. New work too, and it changes step 25.

Recommended (not chosen): **M** before choosing, as every figure here is error against error while live it is error
against lesson. If figures are wanted now: **B with a count of 1**, the real data's one same pair: on the real set it
attaches only that, and on the made-up set 33 like against 20 different. Its weak points: failed commands match one
another whatever the command, and the made-up set gives a different lesson first for 20 of 94 failures.

**The user's choice: not yet given.** (Answered after the review: none of these options. The user chose to measure
again with made-up lessons written as sentences, option M, and to change the query for failed commands, a form of
option Q; the re-run follows.)

### M5, the re-run: made-up lessons searched by made-up failures (step 13 after the user's answers, 2026-11-19)

**The user's earlier choice at step 13, word for word** (2026-11-19, the answer to the builder's question before the
first run, as recorded in the run folder's `user-decisions-after-step-6.md`): "Measure, and add made-up failures
(Recommended)", offered as "Measure your 6 real failures as planned. Alongside them, measure a made-up set of tool
failures, written for the test and clearly marked: similar pairs and different pairs ... You choose the cut-off from
both, and the record says which figures come from which." The reason: the user's error logs hold only 6 `tool` rows
(of 640 rows in 634 files), too few to set a figure.

**What the user decided after the first run's review** (the "After step 13's review" entry of the same file, and the
approval of the plan's "Changed after step 13" with both of its readings):
- The lesson search for a failed command (the `shell` tool, with the status shape) uses the tool's name, the
  command's first word (step 12's "same job" rule) and the command's own message: the first line after the status
  that is not blank and not one of the two fixed marker lines (`--- stderr ---`, `--- stdout ---`), that is the
  command's first error-stream line, else its first ordinary-output line, else the status line itself. A `shell`
  failure without the status shape (a timeout, a command that could not be started) keeps Q18: the tool's name and
  the error's first line, with no first word. Every other tool keeps Q18. All of it is cut to 250 characters.
- Step 13 is measured again with that rule and with made-up lessons written as sentences, searched by made-up
  failures as step 25 will search. The cut-off and the count are chosen from these figures.

In short: with lessons written as sentences and the new rule, **failed commands find their own lesson well, and the
rest only partly**. Of the 36 made-up failed commands whose family has a lesson, at a cut-off of 0.4862 and a count
of 1, 26 are handed their own lesson and none of the 48 failed commands is handed a wrong one (at a count of 2 or 3,
2 are); under the old rule not one of them ever gets its own lesson first. Over all 88 made-up failures that have a
lesson, the same cut-off hands 57 their own lesson at a count of 1, but 10 get another family's lesson first, and 12
of the 28 failures with nothing to learn from are handed one anyway. Tighter cut-offs hand out fewer wrong lessons
and fewer right ones. **Everything here is
made up by the builder, failures and lessons both, so words they share are partly the builder's doing; real lessons
may sit closer or farther.** (Added after the review.) A count of those shared words says this leans one way: a
made-up lesson shares about a quarter of its words with its own family's failures and about a twenty-fifth with any
other family's ("Shared words", below). So the rates of right lessons are likely too good, and the rates of wrong
lessons may be too low; neither could be measured from these results. The user's 6 real failures, a side figure
only and possibly test-polluted, are handed none of the made-up lessons at or below 0.3480. **The user chose R3: a
cut-off of 0.4862 and 1 lesson per failure** (end of this part).

Script: `scripts/8d/measure-lessons.mjs`, two new commands, `lessons-check` (made-up only, to check the run first)
and `lessons` (the same, then the old rule's comparison and the real side figure; the old-rule comparison runs in
both). The first run's commands are unchanged. The rule is in `scripts/8d/lesson-query.mjs`, the families and lessons
in `scripts/8d/lesson-families.mjs`, the rule's tests in `tests/memory/lesson-query.test.ts`; step 12's
`scripts/8d/measure-lesson-ask.mjs` now exports its `firstWord`, which the rule uses (that word and a line break are
the only change there). Runs, each between a pair of snapshots: the check, `node scripts/8d/measure-lessons.mjs
lessons-check`, 07:47:04 to 07:47:44 UTC; the run, `node scripts/8d/measure-lessons.mjs lessons`, 07:49:04 to
07:49:43. Both exit 0, "measure-lessons: passed", no failures; every made-up figure is the same in both; the figures
below are the run's. Results: `tachi-8d-build\install\measure-lessons-lessons-2026-11-19T07-49-04-541Z\results.json`
(counts and scores only). One hub, started and stopped the decided way (Q24, Q8, Q25), gone 22.8 ms after its stop;
7 processes recorded, none left running; backend `sqlite_exact` and model `minilm` read back; nothing fetched (the
dead-end proxy got 0 connections). The script makes no model call: a search of the three scripts for the providers'
names finds none, and its only network requests are the copied health and status checks to the build's own hub on
127.0.0.1.

#### The rule and its tests

`tests/memory/lesson-query.test.ts`, on made-up text only, was written first and failed (the rule's module did not
exist). Then 13 of 13 passed. Two breaks were tried, each put back: with the marker lines not skipped, 6 tests
failed; with a family's error line pasted into one of its lessons, the lesson test failed. `tsc` exit 0. The tests:
- a failed command with a message on its error stream gives the name, the first word and that message, not the
  status line and not a marker line;
- an empty error stream gives the ordinary output's first line;
- no output at all gives the name, the first word and the status line;
- blank lines before the message, Windows line ends among them, are passed over (a line's `\r` is taken off);
- a command killed by a signal is handled as one that exited with a code;
- a timeout's text and a could-not-start text give the name and the first line, with no first word;
- another tool's failure gives its name and the error's first line;
- two commands with the same exit code and different messages give different queries, and with the old rule the
  same one;
- the first word is step 12's, on every command in step 12's own tests (and one with extra spaces);
- a longer query is cut to exactly 250 characters, counted by code point, so a character outside the basic plane is
  never cut in half;
- every made-up failed command's error has the real shape (built by Tachikoma's own `shellText`), every lesson is
  one or two sentences with no date, and no lesson holds a whole error line of its family.

Readings of the builder's, beyond the decided rule: the cut counts code points, as MemPalace's `maxLength` does
(`mempalace/mcp_server/schemas.py:309`), where the first run cut by Node's length; a missing command (an input with no
`command` text) drops the first word rather than failing; the pieces are joined by single spaces (the plan's text).

Two fixes to the rule after the review (2026-11-19), each with a test written first and seen failing (15 tests now,
all passing; with `turns.test.ts`, 33):
- **A Windows line end on the error's first line** is now taken off on every path, as it already was off a failed
  command's message; before, the tool's-name-and-first-line path kept a trailing `\r`.
- **`exit code: null`** now counts as a status line. `shellText` writes `exit code: ${r.code}` whenever there is no
  signal (`src/tools/shell.ts:5`), and a result's `code` may be null (`src/exec/executor.ts:8`), so a failure with no
  code and no signal is now searched by the failed-command rule.

No figure above changes: the rule as committed before the fix and as fixed, applied to the 116 made-up failures and
to the 6 real rows' messages in a pure script (`scratch\step13\query-diff.mjs`; counts only), give 0 different queries
under the new rule, 0 under the old rule for the 48 failed commands, and the same counts of status-shaped errors (48
made-up, 2 real). That the two versions do differ where the fixes apply is shown by the two new unit tests, which
failed against the rule before the fix and pass after it (corrected after the re-check: the script itself holds no
such control, and the one-off check run beside it was not saved).
**Duties for step 25** (`src/memory/lessonQuery.ts`): take a trailing `\r` off the error's first line on every path,
and count `exit code: null` as a status line, as `scripts/8d/lesson-query.mjs` now does; the shared test cases hold
both.

#### The made-up families and lessons (written by the builder; marked made-up in the file)

29 families of 4 failures each, 116 failures: enough members to vary each family's paths, numbers, arguments and
wording, few enough to read through by hand. 28 lessons, one or two for each of 22 families, none for 7 on purpose,
so that one search (at most 100 results) scores every lesson. Each lesson is written the way `record_lesson` and
`/lesson` will store one: what went wrong, what fixed it and how to spot it, naming the tool or the command and the
gist of the message, never the error line itself, with no date and no project. Nothing was asked of a model.

- **14 failed-command families**, each a `shell` failure built by Tachikoma's own `shellText` (or, for C7 and C8, the
  text Tachikoma gives instead): C1 `npm test` with jest missing (one command, one message, four times); C2 and C3
  `git push` rejected and `git push` with failed authentication (one command, two messages, two families); C4 a dev
  server's port taken, from `npm run dev` and from `vite` (two commands, one message, one family); C5 `grep` finding
  nothing (no output at all); C6 a long `node` script killed by a signal (no lesson); C7 a command starting with
  `sleep` stopped at its timeout (not the status shape); C8 a command with a NUL character that could not be started
  (not the status shape); C9 `tsc` with a type error on its ordinary output only; C10 `npm install` with a dependency
  conflict (two lessons); C11 `docker` with Docker Desktop not running, in two wordings; C12 `cargo build` with an
  unknown name (no lesson); C13 `git commit` with nothing to commit, on the ordinary output only (no lesson); C14
  `python` with a module missing (two lessons). 48 of the 56 failures (C1 to C6, C9 to C14) have the status shape.
- **15 other families**, the first run's groups that fit: N1 `read_file` no such file; N2 to N5 `edit_file` (text not
  found; text not found in a CRLF file; text found several times; not UTF-8, no lesson); N6 and N7 `write_file` (not
  permitted; busy, no lesson); N8 `read_file` in Tachikoma's data folder; N9 `find_files` with a missing folder; N10
  `search_files` with a flag inside the pattern; N11 `read_file` with invalid input (no lesson); N12 an MCP server
  answering with a server error; N13 an MCP server stopped; N14 an MCP server needing sign-in (no lesson); N15 an MCP
  server's local service not running.

Some queries this gives, to show the rule (all made-up): C1 `shell npm 'jest' is not recognized as an internal or
external command,`; C2 `shell git To github.com:acme/shop.git` (git writes the remote's name first, so the query
carries no part of the rejection); C5 `shell grep exit code: 1`; C9 `shell tsc src/cart.ts(12,7): error TS2322: ...`;
C14 `shell python Traceback (most recent call last):` (Python writes the traceback's head first).

#### How it was measured

One new palace in the build folder, wing `tachikoma`, room `lessons`. Each of the 28 lessons was added, its text
alone, as step 23 will add one (28 added, each one piece). Then each of the 116 failures was searched for as step 25
will: its query from the rule, one search of `lessons` with `limit` 100, every lesson returned, the hits put in order
by their own `distance` (closest first) and not in the hub's order. A lesson of the failure's own family is "right",
any other "wrong". Each of the 48 failed commands with the status shape was searched a second time with the old rule
(the tool's name and the status line), for the comparison. 170 searches in all (116, 48 and the 6 real ones); 2
queries reached 250 characters; MemPalace marked 4 queries but changed none.

What a cut-off and a count hand a failure: the lessons at or below the cut-off, closest first, up to the count. For
each, the tables count: failures handed a right lesson (of those whose family has one); failures handed any wrong
lesson; failures whose first lesson is wrong; failures whose family has a lesson but that are handed no right one;
and failures whose family has no lesson that are handed one all the same. The candidate cut-offs are taken from the
scores: the 25th, middle, 75th and 90th percentile and the largest of each failure's nearest right lesson, and the
smallest, 1st, 5th and 10th percentile of all wrong distances (nearest rank, so each is a score that occurred).

#### The figures

Distances, lower is closer (percentiles by nearest rank):

| What | Count | Smallest | 10th | 25th | Middle | 75th | 90th | Largest |
|---|---|---|---|---|---|---|---|---|
| All: right, every pair | 112 | 0.1222 | 0.2253 | 0.3162 | 0.3508 | 0.5029 | 0.6928 | 0.9245 |
| All: wrong, every pair | 3,136 | 0.2017 | 0.6759 | 0.7697 | 0.8478 | 0.9122 | 0.9661 | 1.1073 |
| All: each failure's nearest right | 88 | 0.1222 | 0.2173 | 0.2929 | 0.3480 | 0.4862 | 0.6312 | 0.7846 |
| All: each failure's nearest wrong | 116 | 0.2017 | 0.3027 | 0.4614 | 0.5849 | 0.6373 | 0.6739 | 0.7761 |
| Failed commands: nearest right | 36 | 0.2173 | 0.2173 | 0.2929 | 0.3480 | 0.5029 | 0.6921 | 0.7846 |
| Failed commands: nearest wrong | 48 | 0.4730 | 0.5057 | 0.5399 | 0.6376 | 0.6697 | 0.7446 | 0.7761 |
| Others: nearest right | 52 | 0.1222 | 0.2176 | 0.2923 | 0.3518 | 0.4573 | 0.5396 | 0.6928 |
| Others: nearest wrong | 68 | 0.2017 | 0.2594 | 0.3306 | 0.4988 | 0.5982 | 0.6222 | 0.6791 |
| Old rule, failed commands: nearest right | 36 | 0.5572 | 0.5572 | 0.7756 | 0.8507 | 0.9161 | 0.9878 | 0.9878 |
| Old rule, failed commands: nearest wrong | 48 | 0.5224 | 0.5224 | 0.5224 | 0.5224 | 0.5533 | 0.5581 | 0.6503 |

With no cut-off, the closest lesson is a wrong one for 15 of the 88 failures that have a lesson: 4 of the 36 failed
commands (all four of C2's) and 11 of the 52 others (C8's 2, N2's 1, and all four of N3's and of N4's). Under the old
rule it is a wrong one for all 36 failed commands.

**All 116 made-up failures** (88 whose family has a lesson, 28 whose family has none). Each cell: handed a right one
(of 88) / handed any wrong one (of 116) / a wrong one first (of 88) / none though it has one (of 88) / handed one
with nothing to learn from (of 28):

| Cut-off (from) | Count 1 | Count 2 | Count 3 |
|---|---|---|---|
| 0.2017 (wrong: smallest) | 4 / 1 / 0 / 84 / 1 | 4 / 1 / 0 / 84 / 1 | 4 / 1 / 0 / 84 / 1 |
| 0.2929 (nearest right: 25th) | 21 / 10 / 4 / 67 / 6 | 22 / 10 / 4 / 66 / 6 | 22 / 11 / 4 / 66 / 6 |
| 0.3392 (wrong: 1st) | 31 / 15 / 6 / 57 / 9 | 32 / 17 / 6 / 56 / 9 | 33 / 18 / 6 / 55 / 9 |
| 0.3480 (nearest right: middle) | 40 / 16 / 7 / 48 / 9 | 41 / 18 / 7 / 47 / 9 | 43 / 19 / 7 / 45 / 9 |
| 0.4862 (nearest right: 75th) | 57 / 22 / 10 / 31 / 12 | 58 / 34 / 10 / 30 / 12 | 62 / 35 / 10 / 26 / 12 |
| 0.5900 (wrong: 5th) | 67 / 27 / 11 / 21 / 16 | 68 / 55 / 11 / 20 / 16 | 72 / 65 / 11 / 16 / 16 |
| 0.6312 (nearest right: 90th) | 72 / 32 / 12 / 16 / 20 | 73 / 72 / 12 / 15 / 20 | 77 / 83 / 12 / 11 / 20 |
| 0.6759 (wrong: 10th) | 73 / 39 / 14 / 15 / 25 | 74 / 95 / 14 / 14 / 25 | 78 / 107 / 14 / 10 / 25 |
| 0.7846 (nearest right: largest) | 73 / 43 / 15 / 15 / 28 | 75 / 104 / 15 / 13 / 28 | 82 / 116 / 15 / 6 / 28 |

**The 48 failed commands with the status shape** (36 with a lesson, 12 without), the same cells (of 36 / of 48 /
of 36 / of 36 / of 12):

| Cut-off | Count 1 | Count 2 | Count 3 |
|---|---|---|---|
| 0.2017 | 0 / 0 / 0 / 36 / 0 | the same | the same |
| 0.2929 | 9 / 0 / 0 / 27 / 0 | the same | the same |
| 0.3392 | 15 / 0 / 0 / 21 / 0 | the same | the same |
| 0.3480 | 19 / 0 / 0 / 17 / 0 | the same | the same |
| 0.4862 | 26 / 0 / 0 / 10 / 0 | 26 / 2 / 0 / 10 / 0 | 26 / 2 / 0 / 10 / 0 |
| 0.5900 | 28 / 1 / 0 / 8 / 1 | 28 / 9 / 0 / 8 / 1 | 28 / 17 / 0 / 8 / 1 |
| 0.6312 | 32 / 5 / 1 / 4 / 4 | 32 / 13 / 1 / 4 / 4 | 32 / 21 / 1 / 4 / 4 |
| 0.6759 | 32 / 12 / 3 / 4 / 9 | 32 / 32 / 3 / 4 / 9 | 32 / 40 / 3 / 4 / 9 |
| 0.7846 | 32 / 16 / 4 / 4 / 12 | 33 / 40 / 4 / 3 / 12 | 36 / 48 / 4 / 0 / 12 |

**The same 48 under the old rule** (the tool's name and the status line): at or below 0.4862, nothing is handed to
any of them. From 0.5900 up, every one of the 36 gets a wrong lesson first at a count of 1 (36 / 36), and at most 4
are handed a right one at a count of 2 or 3; 8 to 12 of the 12 with nothing to learn from are handed one.

**The 68 others** (52 with a lesson, 16 without; of 52 / of 68 / of 52 / of 52 / of 16):

| Cut-off | Count 1 | Count 2 | Count 3 |
|---|---|---|---|
| 0.2017 | 4 / 1 / 0 / 48 / 1 | the same | the same |
| 0.2929 | 12 / 10 / 4 / 40 / 6 | 13 / 10 / 4 / 39 / 6 | 13 / 11 / 4 / 39 / 6 |
| 0.3392 | 16 / 15 / 6 / 36 / 9 | 17 / 17 / 6 / 35 / 9 | 18 / 18 / 6 / 34 / 9 |
| 0.3480 | 21 / 16 / 7 / 31 / 9 | 22 / 18 / 7 / 30 / 9 | 24 / 19 / 7 / 28 / 9 |
| 0.4862 | 31 / 22 / 10 / 21 / 12 | 32 / 32 / 10 / 20 / 12 | 36 / 33 / 10 / 16 / 12 |
| 0.5900 | 39 / 26 / 11 / 13 / 15 | 40 / 46 / 11 / 12 / 15 | 44 / 48 / 11 / 8 / 15 |
| 0.6312 | 40 / 27 / 11 / 12 / 16 | 41 / 59 / 11 / 11 / 16 | 45 / 62 / 11 / 7 / 16 |
| 0.6759 | 41 / 27 / 11 / 11 / 16 | 42 / 63 / 11 / 10 / 16 | 46 / 67 / 11 / 6 / 16 |
| 0.7846 | 41 / 27 / 11 / 11 / 16 | 42 / 64 / 11 / 10 / 16 | 46 / 68 / 11 / 6 / 16 |

**Each family** (made-up, so named): the farthest of its failures' nearest right lessons; the closest wrong lesson
to any of them; and how many of its 4 failures have a wrong lesson closest. C1 0.2173, 0.5900, 0; C2 0.7846, 0.6105,
4; C3 0.3973, 0.4730, 0; C4 0.5029, 0.5134, 0; C5 0.2929, 0.6544, 0; C6 (no lesson), 0.5957; C7 0.2255, 0.4584, 0;
C8 0.6928, 0.4373, 2; C9 0.3350, 0.6964, 0; C10 0.3480, 0.5057, 0; C11 0.3754, 0.6498, 0; C12 (no lesson), 0.5362;
C13 (no lesson), 0.6024; C14 0.6312, 0.6697, 0; N1 0.6093, 0.5803, 0; N2 0.3309, 0.2511, 1; N3 0.4400, 0.2252, 4;
N4 0.4120, 0.2745, 4; N5 (no lesson), 0.3306; N6 0.5428, 0.5849, 0; N7 (no lesson), 0.4801; N8 0.3408, 0.5484, 0;
N9 0.4277, 0.4988, 0; N10 0.4510, 0.6029, 0; N11 (no lesson), 0.2654; N12 0.5192, 0.6146, 0; N13 0.1222, 0.4176, 0;
N14 (no lesson), 0.2017; N15 0.3471, 0.5852, 0.

What the figures mean:
- **The new rule works for failed commands.** Their own lesson is the closest for 32 of 36, and no wrong lesson
  comes within 0.4730 of any of them; under the old rule every one of them was closest to another family's lesson,
  most of them at the same distance, 0.5224 (the same bare status line finds the same lesson; which lesson it is was
  not recorded).
- **It fails where the command's first line is not its message**: C2's `git push` writes the remote's name first, so
  its query is `shell git To <remote>` and its lessons sit at up to 0.7846, behind other lessons; Python's traceback
  head (C14) puts its lessons out to 0.6312. These are real shapes of those programs' output.
- **The other tools mix where their errors and lessons share words**: the three `edit_file` families N2 to N4 find
  one another's lessons (wrong lessons from 0.2252), and N14's failures ("needs sign-in", a family with no lesson)
  have a wrong lesson at 0.2017, the closest wrong pair of all. (Corrected after the review: which lesson that is was
  not recorded, as the results hold only each family's nearest wrong distance.)
- **Failures with nothing to learn from are handed a lesson** from 0.2017 up: 6 of 28 at 0.2929, 9 at 0.3480, 12 at
  0.4862, all 28 at 0.7846.
- **The count adds little.** A family has one or two lessons, so a count above 1 can add at most one more right one;
  at 0.4862 a count of 3 hands 5 more failures a right lesson than a count of 1 (62 against 57) and 13 more a wrong
  one (35 against 22). That bound is set by the made-up design (one or two lessons a family), not measured.
- **Made up, both sides.** The builder wrote the failures and the lessons, so the words they share are partly the
  builder's doing; real lessons, written by the model in the lesson ask or by the user, may sit closer or farther.

**Shared words** (added after the review). The review counted, and the builder counted again with a small script
(`scratch\step13\overlap.mjs` in the build folder, which reads `scripts/8d/lesson-families.mjs` only: no model, no
hub), how many of each made-up lesson's words also appear in failures' text. Words are runs of letters, lower-cased,
of 4 letters or more, with common English stopwords left out. The measure differs by row (named in the table):
pooled recall is the part of the lesson's distinct words found anywhere in the family's 4 failures; per-failure
recall and Jaccard take each failure on its own and average over the family's 4. "Other" is the mean over the other
families (or their 112 failures); the figures are means over the 28 lessons.

| Measure, and what the lesson is counted against | Own family | Other families |
|---|---|---|
| Pooled recall: share of the lesson's words found in the family's 4 failures together (whole text) | 0.273 | 0.040 |
| Pooled recall, against the 4 failures' queries (what the search is sent) | 0.223 | 0.032 |
| Per-failure recall: share of the lesson's words in one failure's whole text, averaged | 0.268 | 0.036 |
| Per-failure Jaccard: shared words over all words of the lesson and one failure, averaged | 0.171 | 0.020 |
| The review's first count: per-failure Jaccard, with its own word list | 0.142 | 0.013 |

(Corrected after the re-check.) The figures differ mainly by the measure, not by the text or the skipped words:
"recall" asks what part of the lesson's words the failures hold; "Jaccard" divides the shared words by every word of
the lesson and the failure together, so it is smaller. Pooling the 4 failures or taking them one at a time changes
little (0.273 against 0.268). The builder's four counts (the first four rows, `scratch\step13\overlap.mjs`; its last
two rows match the review's re-check of the same lessons) find a lesson sharing about 7 to 9 times as many of its
words with its own family as with another (6.8, 7.0, 7.4 and 8.6); the review's first count gives about 11.
Highest against the whole text: N10 0.545, N13 0.455, N8 0.400, C2 0.396, C7 0.375 (the review's highest: N13
0.417, N8 0.286, N10 0.273, C10 0.271, C7 0.248, C2 0.194).
Against the queries, C2 shares none (git writes the remote's name first, so its query holds none of the lesson's
words), and 2 lessons share no word with their own family's queries.

What it means, in plain words: the builder wrote each lesson with its own failures in view, so they share
words a real lesson might not. That likely makes the right-lesson rates here too good. In the other direction, the
families were written to be unlike one another, so they share few words, while real lessons will share common words
such as "command" and "failed" across kinds of failure; that may make the wrong-lesson rates here too low. Neither
direction, nor its size, could be measured from these results.

Not measured: real lessons; the user's own MemPalace; errors and lessons in other languages than English; a room of
more than 100 lessons (a search would then return only the closest 100); several lessons per family written by
different hands.

#### The user's real failures, a side figure only (possibly test-polluted)

The user's error logs, read only, as at the first run: 634 files, 640 rows, 0 unreadable, 634 of other kinds, 6
`tool` rows (0 from subagents); every row's input could be read back; 2 are failed commands with the status shape.
**Possibly test-polluted**: before commit cce56d5 (2026-11-06) Tachikoma's tests wrote rows into the user's real
errors folder (at least 126 rows naming `ollama:none`), and one of the two `shell` rows may be a test's. Each of the 6
was put through the new rule and searched against the made-up lessons, counts only; none of the made-up lessons is
about the user's work, so any lesson handed to one is a lesson that does not belong to it. The nearest made-up lesson
to each: 0.3529 at the closest and 0.6708 at the farthest (middle 0.4910). Handed a made-up lesson: none at or below
0.3480; 2 of the 6 at 0.4862; 4 at 0.5900; 5 at 0.6312; all 6 at 0.6759 and above. No figure is chosen from this set.

#### The user's folders

Two pairs of snapshots, each taken in the same command just before and just after its run:
- the check: `step13-r-check-before` (07:46:37 UTC) and `step13-r-check-after` (after 07:47:44): "no change" (exit
  0), with only the set-apart daemon folder of the user's MemPalace;
- the run: `step13-r-before` (07:48:29) and `step13-r-after` (after 07:49:43): "no change" (exit 0), the same.

The same commands listed the top level of the user's Temp folder (names and times only, no file opened): no
`uv-*.lock`; in each pair, one file rewritten (origin not traced), nothing added or removed. The palace
`measure-lessons-<stamp>-lessons` was deleted by its exact name after its hub had stopped, in each run (7 files and
its folder); `palaces` holds no `measure-lessons-*` folder. A scan afterwards, in one process, for each of the 6 real
texts and their first lines (22 strings, plain and as JSON would write them) through every file in the build folder's
`install` folder and this step's outputs (11,946 files, 936 MB) found them in no file of MemPalace's or of the runs.
(Corrected after the review.) It has 2 hits, both scratch files of the builder's own in `scratch\step13`:
`logic-check.cjs`, the check of the first run on hand-made data, and `added-rerun.txt`, this step's own added lines,
written for the private-details scan after the scan was first run (the review's run of the scan finds both). Both
match only Tachikoma's fixed `exit code: N` status form; nothing of the user's is in them.

#### The decision for the user: the lesson cut-off and the count

What the two numbers do (design, section 5): when a tool fails, the lessons at or below the cut-off, closest first, up
to the count, are added after the error the model sees (as many as fit the cap, Q23). Every figure below is on the
builder's made-up failures and lessons, and would differ with other made-up sets.

The options for the cut-off, each with what it hands out at a count of 1 (made-up: of the 88 failures with a lesson,
and of the 28 without; failed commands of 36; real: of 6):
- **R0. 0.2017** (the closest wrong pair): 4 handed their own lesson, 1 failure handed a wrong one, 1 of 28 with
  nothing to learn from handed one. Failed commands: none. Real: none. In practice almost nothing is attached.
- **R1. 0.2929** (a quarter of the failures' nearest right lessons): 21 right, 4 wrong first, 6 of 28 handed one.
  Failed commands: 9 right, 0 wrong. Real: none.
- **R2. 0.3480** (the middle of the nearest right lessons): 40 right, 7 wrong first, 9 of 28 handed one. Failed
  commands: 19 right, 0 wrong. Real: none.
- **R3. 0.4862** (three quarters of the nearest right lessons): 57 right, 10 wrong first, 12 of 28 handed one.
  Failed commands: 26 right, 0 wrong. Real: 2 of 6 handed a made-up lesson.
- **R4. 0.5900** (5% of the wrong pairs inside): 67 right, 11 wrong first, 16 of 28 handed one. Failed commands: 28
  right, 1 wrong. Real: 4 of 6.
- **R5. 0.6312** (nine tenths of the nearest right lessons): 72 right, 12 wrong first, 20 of 28 handed one. Failed
  commands: 32 right, 5 wrong. Real: 5 of 6.

The options for the count: **1**; **2**; or **3**. At R2 they hand a right lesson to 40, 41 and 43 failures and a
wrong one to 16, 18 and 19; at R3 to 57, 58 and 62 and 22, 34 and 35. A family here has at most two lessons, so the
gain from a higher count is bounded by the made-up design.

Recommended, and chosen by the user (below): **R3, 0.4862, with a count of 1.** It hands their own lesson to 57 of
the 88 made-up failures that have one (65%; 49% of all 116; corrected after the review), hands no made-up failed
command a wrong one (26 of the 36 get their own), and keeps the wrong-first count close to the tighter options' (10
against 7 at R2). Its
weak points: 12 of the 28 made-up failures with nothing to learn from are handed some other lesson; 2 of the user's 6
real failures would be handed a made-up lesson that is not theirs; and every figure rests on the builder's own
failures and lessons. A more careful choice is **R2, 0.3480, with a count of 1**: 17 fewer failures get their own
lesson, 3 fewer get a wrong one first, and none of the real failures is handed one.

Beside the recommendation (added after the review): the made-up lessons share far more words with their own family's
failures than with others ("Shared words", above), so at any cut-off the right-lesson figures are likely better here
than they will be live, and the wrong-lesson figures may be lower than live. Neither could be measured here. Whichever
cut-off is chosen, it rests on that.

**The user's choice: not yet given.** (Answered below.)

#### The user's choice (step 13), 2026-11-19

The user chose **R3: a cut-off of 0.4862 and 1 lesson per failure** (the answer "R3, 0.4862, 1 lesson", 2026-11-19).
These are the M5 figures, the cut-off and the count, for step 25: when a lead's tool call fails, the lessons in
`lessons` at a distance of 0.4862 or less are taken, closest first by their own distance, and at most 1 is attached
(and only if it fits the cap, Q23). The first run's figures play no part.

The user chose with three things before them:
- **The shared-words caveat**: the made-up lessons share far more words with their own family's failures than with
  others ("Shared words", above), so the right-lesson counts are likely too good and the wrong-lesson counts may be
  too low; neither could be measured.
- **The counts at R3**: a count of 1, 2 or 3 hands a right lesson to 57, 58 and 62 of the 88 made-up failures that
  have one, and a wrong one to 22, 34 and 35 of all 116.
- **The `git push` consequence**: git writes the remote's name first, so a failed push's search text is `shell git To
  <remote>`, which holds nothing of the error; its lessons sat at up to 0.7846, past this cut-off, behind other
  lessons (C2).

Not covered: real lessons, the user's own MemPalace, other languages, a room of more than 100 lessons. Step 13's
re-run was committed (0bc17c4, with eded6c9 and the review fixes 87b237a) before the user's answer; the answer is in
the commit after them.

### M6 The note's count and cut-off, from the transcripts (step 14, 2026-11-20)

In short: the note works on half of the first messages that have anything to find, and very few other projects'
entries come as close. Of the user's 35 first messages so far, 24 had earlier turns of the same project in the palace
when they were sent; 11 had none (most were a project's first session). For those 24, the closest earlier turn of the
same project sits at a distance of 0.4861 in the middle case, while entries of other projects come no closer than
0.3111, and only 6 of their 1,397 matches are within 0.4861. (Lower is closer. A distance of 0 would be the very same
text; an entry holds the model's reply as well as the typed words, so even a message that repeats an earlier one
word for word stays above 0: the closest seen was 0.028. Other projects' matches sit at 0.89 in the middle.) A match
is one piece of an entry, at most 800 characters, if a match is shown as its piece (step 23's reading, not yet
decided), so a note of 3 matches then holds at most 2,400 characters of text; here it held 1,099 at most at that
cut-off. **The counts are of notes on first messages only.** Each search was made with the hub already up, so for a
first message sent before memory is connected, which goes without a note, the count is an upper bound: a `-p` run's
one message is sent at launch, so "in `-p` that can mean no note" (Q9's recommended text in the plan), and 14 of the
35 first messages are `-p` runs; without them, 8 of the 13 window messages with something earlier get a note at
0.4861 (below). A note tried again with the next message, as that rule has it, is neither counted nor measured here.
The hub's start is not modelled here. **The figures are few** (35 first messages, 76 entries, 10 projects), most
sessions were the user's own tests of Tachikoma, and "same project" stands in for "relevant", which it is not always.
**The user chose N3: a cut-off of 0.4861 and up to 3 matches** (2026-11-20, end of this part). (Changed after the
review, 2026-11-20: the `-p` figures, the upper bound, the hooked hub, the check of the figures, the layout's effect,
the duties for steps 22 and 28, and the recommendation's reason; the measurement was run once more and gave the same
figures.)

Script: `scripts/8d/measure-note.mjs`, three commands: `scan` (the transcripts only, counts only, starts nothing),
`check` (the whole run on made-up sessions written in the script, with every count it must find worked out by hand
beforehand; never the user's text) and `run` (the user's transcripts). Its hub start and stop, process tracking,
palace removal and percentiles are copied unchanged from `scripts/8d/measure-lessons.mjs` (the lines are listed in its
header) by an assembler that allowed only the run folder's and palaces' names and the result line to change (and,
after the review, the hub's `wrapped` start and the watch, below); that script cannot be imported for them, as they
are not exported and importing it runs its commands. It uses step 10's
`scripts/8d/turns.mjs` for the turns and the cut into parts, and step 13's `QUERY_MAX` (250). After the first runs
one comment changed in the script (a cited line range, `candidates.py:182-214` to `:182-215`); no code changed.

After the review (2026-11-20) the script changed, and the check and the run were each run once more:
- **The hub runs under step 5's audit hook.** The first runs started the hub without it, and their connection watch
  passed with no hub watched, on the dead-end proxy alone. Now the hub runs the same server module through step 5's
  audit-hook wrapper (copied unchanged from `scripts/8d/measure-hub.mjs`, as its filler hubs ran, with its own
  `wrapped` start), which logs every network and process event of the serving process, and the watch fails when no
  hub was hooked. This differs from the decided start (Q24) only by the hook around the module.
- **`-p` runs are counted apart**, and every cut-off's figures are also worked out without them (below).
- **The check gained a `-p` session** (one more session, typed turn, entry, first message and two searches) and a
  check of the figures on made-up hits with given distances (no hub), worked out by hand and written before it was
  run: the cut-off list, the rows at two cut-offs, the note's length for 1 to 3 matches, and the `-p` counts. Run
  against the code as it was, it failed on the two new `-p` figures only (the `-p` counts and the count without
  `-p`); the rest passed at once, as it tests code that was already there. After the change, 0 failures.

Runs (2026-11-19 UTC; 2026-11-20 on this PC's clock), each between a pair of snapshots in the same command:
- the check, `node scripts/8d/measure-note.mjs check`, 17:38:09 to 17:38:35: exit 0, "measure-note: passed"; all 22
  counts of the entries and prompts and all 14 of the run were as expected (among them a branch copy, a background
  turn, a turn with no model text, a damaged line, a turn of 100,524 characters saved in 2 parts, a turn repeated word
  for word answered `already_exists`, a first message over 250 characters, a picture, and a search of a room of 132
  pieces, over the limit, counted as such);
- the scan, `node scripts/8d/measure-note.mjs scan`, read only, no hub: the counts below, the same as the run's;
- the run, `node scripts/8d/measure-note.mjs run`, 17:40:25 to 17:41:56: exit 0, "measure-note: passed", no
  failures. Results: `tachi-8d-build\install\measure-note-real-2026-11-19T17-40-25-712Z\results.json` (counts, lengths
  and scores only). The run itself took 90.9 s, of which the 72 adds and 162 searches took 85.6 s; with both
  snapshots and the leftover scan the command took about 2.5 minutes.
- after the review, the check again, 18:33:44 to 18:34:07: exit 0, "measure-note: passed"; all 23 counts of the
  entries and prompts, the figure check (0 failures) and all 15 counts of the run were as expected (the `-p` session
  among them; 2 searches of the 132-piece room now);
- after the review, the run again, `node scripts/8d/measure-note.mjs run`, 18:35:19 to 18:36:50: exit 0,
  "measure-note: passed", no failures. Results:
  `tachi-8d-build\install\measure-note-real-2026-11-19T18-35-19-981Z\results.json`. It took 90.6 s. **Every count,
  score and length in this part is the same as the first run's** (all four distance rows, every cut-off row, every
  note length; the derived counts, by `extra.mjs`, are the same too). Only the hub's own times differ.

Each run had one hub, started and stopped the decided way (Q24, Q8, Q25), the re-runs under the audit hook: it
answered in 1,163.5 ms (check 1,216.7; re-runs 1,131.2 and 1,269.3) and was gone 22.9 ms after its stop (check 25.3;
re-runs 21.2 and 18.9). 7 processes recorded in each, none left running; backend `sqlite_exact` and model `minilm`
read back; nothing fetched: the dead-end proxy got 0 connections in every run. In the first two runs that was the
only watch (0 hubs hooked). In the two re-runs 1 hub was hooked in each: the hook logged its own test connection to
127.0.0.1 and the proxy settings, and then, while the hub served, no network or process event at all, so no outside
address and no child process. The palace was deleted by its exact name after its hub stopped (7 files and its folder,
each run).

#### What was read, and how the user's text was kept out

The user's Tachikoma transcripts, read only, on this computer. Subagents' own files were not read (their messages are
never saved). The user's text went into one palace in the build folder, as the plan says, under stand-in labels
(`tachikoma session s<k>, turn <n>`) and stand-in rooms (`project-<k>`); the palace was deleted after the run. Nothing
of the text, no session id and no file or folder name is in any output, in the results file or here: the script
prints counts, lengths and scores only, and while the user's text is handled an error would say its name alone.
MemPalace's write log redacts content and queries (`mempalace/wal.py:28-29, :92-93`); its warning when it rewrites a
query gives two lengths and the method only (`mempalace/query_sanitizer.py:43-47`). A scan after each real run (in
the build folder's `scratch\step14\leftover-scan.mjs`) looked for the user's text: three 32-character slices of each
entry and of each first message's query, plain and as JSON writes them (308 strings). What it read, and what it left
out:
- every file under the build folder's `install` folder changed at or after the run's start, and every file of this
  step's scratch folder: 15 files (13 MB) after the first run, 24 (13 MB) after the re-run. None holds one of the
  strings;
- it left out the older files under `install` (11,935, then 11,950), as their last change came before the run began;
- it skipped 1 link without following it: `install\python\cpython-3.13-windows-x86_64-none`, uv's version alias for
  the build's own Python, pointing to `cpython-3.13.17-windows-x86_64-none` beside it, which the scan walked anyway.
The scan says nothing of other folders. Its control, a made-up string in a made-up file, was found each time, and
that file was deleted by its exact name.

| What | Count |
|---|---|
| Transcripts (main sessions) read | 53 files, 1,621,473 bytes, in 10 project folders; all with a start line |
| Sessions | 53 (15 of them `-p` runs) |
| `/branch` copies (left out, the user's rule after step 12) | 3 sessions, 7 copied typed turns, 0 copied background |
| Typed turns, copied ones left out | 82 |
| of them marked: the file ends mid-turn / a call without a result | 2 / 1 (none has model text) |
| Background turns (make no entry) | 1 |
| Turns set apart (a damaged line) | 0 (and 0 damaged lines before a first turn) |
| Typed turns with no model text (make no entry) | 6 |
| Typed turns saved, as entries | 76, in 10 rooms |
| of them over 100,000 characters, saved in parts (Q26) | 0 (so 76 entries, 1 part each) |
| Pieces by room (the 4 repeats below included) | 1, 1, 8, 8, 10, 10, 11, 11, 11 and 20 (91) |
| Sessions with no typed turn (no first message) | 15 (1 of them a `-p` run, 14 window sessions) |
| First messages searched (53 less 3 copies and 15 with no typed turn) | 35 |
| of them `-p` runs | 14 |
| of them cut to 250 characters / over 200 characters / with a picture | 1 / 3 / 0 |
| of them with no other session of their project started before them | 9 |
| of them with earlier entries in their own room when sent | 24 (11 of them `-p` runs) |

The two 15s are not the same sessions (counted after the review, read only, counts only, by the build folder's
`scratch\step14\pcount.mjs`, its output saved beside it as `pcount-1.txt`): of the 15 `-p` runs, 14 have typed
turns (21 in all) and 1 has none; of the 15 sessions with no typed turn, that 1 is a `-p` run and 14 are window
sessions. So 14 `-p` runs have a first message.

These counts match step 10's corrected figures (M2, "With the copies left out": 82 typed turns, 76 entries) and M7's
3 copies with 7 copied turns. The first messages' lengths, in code points: shortest 6, a quarter 40, middle 58, three
quarters 127, nine tenths 176, longest 445. Of the 76 entries, 72 were added and 4 were answered `already_exists`:
the very same text was already in the room from an earlier turn (step 6 item 9), which step 22 counts as saved. The
palace read back 72 entries in 87 pieces (61 of 1 piece, 9 of 2, 1 of 3, 1 of 5).

**Duties for steps 22 and 28, from the 4 repeats** (added after the review). The 4 are identical text in the same
room: MemPalace's entry id is a hash of the wing, the room and the content (`mempalace/ids.py:71-80`, used by the add
at `mcp_server/tools_write.py:518`), so it keeps one copy, under the first turn's label. For a repeated turn, step
22's look-up by its own exact label finds nothing, so the saver adds it, gets `already_exists`, and counts the turn
as saved; if that turn is ever saved again (a crash before its saved record), it does the same, one look-up and one
add answered `already_exists`, as no entry ever carries its label. Step 22 should test exactly that. And
`/memory`'s "Entries" (step 28) counts what the palace holds: here it would read 72 for 76 saved turns, so it must
not be read, or worded, as a count of saved turns.

**What depends on the entry's layout** (added after the review). An entry here is the typed words and each piece of
the model's text joined by a blank line (`JOIN`, two characters, as step 10's scan); step 22 sets the exact layout. So
these depend on it: the entries' lengths, the count of entries of one piece (61) and every piece count, the "as whole
entries" lengths, and, a little, every distance, as the embedded text would differ. The joins are 2 characters per
piece of model text, so a layout of similar size changes the lengths by a few characters an entry.

#### How it was measured, and the builder's choices

- **The same project** is the same project folder under `sessions` (one per project path, named after its sha256,
  `src/core/sessions.ts:13-18`), and so the same room; no folder's sessions name more than one project path (0).
- **The order.** Each entry goes in when its turn ended (the turn's last line's time), and each first message is
  searched at its own time (its first typed message's line); at the same millisecond the search goes first. So each
  search finds the palace as it stood when that message was sent: every turn that had ended by then, in any session
  of any project, those of sessions still open at the time included. Within a folder the sessions are ordered by their
  start line's time, then by when the file was made, only to find the branch copies, as M7 does.
- **The message's own session is left out** by that order: its first message comes before any of its turns end. No
  later turn is ever in a search.
- **Messages with nothing earlier.** 11 of the 35 had no entry in their own room when sent: 9 had no other session
  of their project started before them, and 2 had other sessions started before them, none of which had a saved
  turn by then. They would get no note. They are counted here and have no score; they were still searched against
  the other projects, for the comparison.
- **A branch's copy** has no first message of its own: its next message is a fork's (`src/cli.tsx:814`,
  `src/tui/app/queue.ts:833`), and the note is never made for a fork (step 24). Its copied turns make no entry; its
  own later turns do, as they would be saved live.
- **The query** is the first typed turn's words as Q4 makes them up (pictures as markers), cut to 250 code points as
  step 24 will cut them (by code point, as `scripts/8d/lesson-query.mjs` cuts).
- **`-p` runs and the hub's start** (corrected after the review). `-p` runs are searched like the rest, but every
  search here was made with the hub already up. Live, if memory is not connected when a message is sent, that message
  goes without a note, and the note is tried with the next message; "in `-p` that can mean no note". That is Q9's
  recommended text in the plan, which the steps are written on; the user's own answer at step 11 was the time limit
  (one limit, from the pair). A `-p` run's one message is sent at launch, while the hub may still be starting, and so
  is any first message typed while it starts. So every count below is of notes on first messages only: for `-p` runs
  and for any first message sent while the hub is still starting it is an upper bound, and a note tried again with
  the next message is neither counted nor measured. How often the hub is not yet connected is not measured here (the
  hub's start is not modelled); the figures are given without the `-p` runs too, to show how far they could drop.
- **The search**: one search of the message's own room (step 24's "project's room"; the `lessons` room is empty here,
  as there are no lessons yet, so the merged list of Q27 is the project's alone), and, for the comparison, one search
  of each other project's room that held an entry at the time, each with `limit` 100, MemPalace's most (`_MAX_RESULTS`,
  `mempalace/mcp_server/_session.py:681`). No room held more than 20 pieces, so every search returned every piece in
  its room; the script checked this at every search (0 short, 0 over the limit, 0 from another room, 0 unknown, 0
  folded). Each hit is ranked by its own `distance` (closest first), not the hub's order, as in M5; 0 had a closet
  boost.
- **A match is one hit, and a hit is one piece** of an entry, at most 800 characters: MemPalace returns the matched
  piece's text (`mempalace/searcher/query.py:412-426`; `searcher/candidates.py:123-129`, "`text` is the matched
  drawer, verbatim"). So several hits can come from one long entry. The length tables give the other reading too, a
  match shown as its whole entry, each entry once; steps 23 and 24 set what a match shows.
- **The candidate cut-offs** are taken from the scores, each a score that occurred (nearest rank): the 25th, middle,
  75th and 90th percentile and the largest of each message's closest same-project match, and the smallest, 1st, 5th,
  10th and 25th percentile of all other-project matches.

**Found: MemPalace rewrites a query of over 200 characters.** Its sanitizer (`mempalace/query_sanitizer.py:29-30`,
`:77-189`: `SAFE_QUERY_LENGTH = 200`, `MAX_QUERY_LENGTH = 250`) passes a query of 200 characters or fewer
through as it is, and replaces a longer one with its last sentence that ends in a question mark, else its last
meaningful sentence, else its last 250 characters; it is meant for agents that put a system prompt in front of a
query. 3 of the 35 first messages are over 200 code points, and all 22 of their searches were rewritten ("sanitized
22, changed 22"). So live, a first message over 200 characters is searched by the part MemPalace picks, not by the
first 250 characters step 24 sends. The figures here include that, as live. A note for step 24; nothing here depends
on a choice about it.

#### The figures

Distances (lower is closer): smallest / 10th / 25th / middle / 75th / 90th / largest.

| Matches | Count | Distances |
|---|---|---|
| Same project, every match | 156 | 0.028 / 0.2884 / 0.4396 / 0.7352 / 0.8748 / 0.9654 / 1.0566 |
| Same project, each message's closest | 24 | 0.028 / 0.1615 / 0.2323 / 0.4861 / 0.8076 / 0.9356 / 0.9368 |
| Other projects, every match | 1,397 | 0.3111 / 0.742 / 0.8157 / 0.8922 / 0.9573 / 1.0038 / 1.1217 |
| Other projects, each message's closest | 29 | 0.3111 / 0.3742 / 0.6234 / 0.6615 / 0.7076 / 0.752 / 0.7929 |

The same-project matches per message (of the 24): middle 7, most 19, from middle 5 and most 19 distinct entries.

What each candidate cut-off lets in. "Notes": the messages, of the 24 with earlier entries, with at least one
same-project match inside, which would get a note. "Per message": matches inside, over the 24 (middle / 90th / most),
and, among those with a note, the middle. "Other": other-project matches inside, of 1,397, and the messages, of the 29
with other projects' entries at the time, with at least one of them inside.

"Notes" also gives, in brackets, how many of them are `-p` runs (added after the review; 11 of the 24 are).

| Cut-off (from) | Notes (`-p`) | Same inside (of 156) | Per message (see above) | Other inside | Other: messages |
|---|---|---|---|---|---|
| 0.2323 (same closest, 25th) | 6 (3) | 6 (3.8%) | 0 / 1 / 1; 1 | 0 (0%) | 0 |
| 0.3111 (other, smallest) | 7 (3) | 19 (12.2%) | 0 / 3 / 5; 3 | 1 (0.1%) | 1 |
| 0.4861 (same closest, middle) | 12 (4) | 44 (28.2%) | 0 / 6 / 11; 2 | 6 (0.4%) | 4 |
| 0.615 (other, 1st) | 14 (5) | 55 (35.3%) | 1 / 8 / 11; 2 | 15 (1.1%) | 7 |
| 0.691 (other, 5th) | 16 (5) | 62 (39.7%) | 1 / 8 / 11; 2 | 70 (5.0%) | 20 |
| 0.742 (other, 10th) | 17 (6) | 80 (51.3%) | 2 / 9 / 11; 4 | 140 (10.0%) | 25 |
| 0.8076 (same closest, 75th) | 18 (6) | 92 (59.0%) | 4 / 9 / 12; 4 | 318 (22.8%) | 29 |
| 0.8157 (other, 25th) | 18 (6) | 92 (59.0%) | 4 / 9 / 12; 4 | 350 (25.1%) | 29 |
| 0.9356 (same closest, 90th) | 23 (10) | 128 (82.1%) | 5 / 11 / 17; 6 | 928 (66.4%) | 29 |
| 0.9368 (same closest, largest) | 24 (11) | 133 (85.3%) | 5 / 11 / 18; 5 | 940 (67.3%) | 29 |

**Without the `-p` runs** (added after the review), at the same cut-offs: the 21 window messages, of which 13 had
earlier entries in their room (114 same-project matches) and 18 had other projects' entries (683 matches). This is
how far the figures could drop if no `-p` run ever got a note. The derived middles are by the build folder's
`scratch\step14\extra2.mjs`, from the results file.

| Cut-off | Notes (of 13) | Same inside (of 114) | Per message | Other inside (of 683) | Other: messages (of 18) |
|---|---|---|---|---|---|
| 0.2323 | 3 | 3 | 0 / 1 / 1; 1 | 0 | 0 |
| 0.3111 | 4 | 13 | 0 / 4 / 5; 3 | 0 | 0 |
| 0.4861 | 8 | 32 | 1 / 9 / 11; 1 | 2 | 2 |
| 0.615 | 9 | 40 | 2 / 9 / 11; 2 | 4 | 2 |
| 0.691 | 11 | 47 | 2 / 9 / 11; 3 | 24 | 9 |
| 0.742 | 11 | 63 | 4 / 9 / 11; 6 | 48 | 14 |
| 0.8076 | 12 | 72 | 5 / 11 / 12; 5 | 117 | 18 |
| 0.8157 | 12 | 72 | 5 / 11 / 12; 5 | 121 | 18 |
| 0.9356 | 13 | 100 | 8 / 11 / 17; 8 | 377 | 18 |
| 0.9368 | 13 | 102 | 8 / 12 / 18; 8 | 386 | 18 |

The note's text without the `-p` runs (count 1; 2; 3, each middle / 90th / longest): at 0.3111, 237 / 332 / 332;
441 / 482 / 482; 773 / 788 / 788. At 0.4861, 245 / 800 / 800; 441 / 800 / 800; 610 / 800 / 800. At 0.615, 245 / 800 /
800; 441 / 1,400 / 1,400; 773 / 1,400 / 1,400.

Among the messages with a note, how many have 1, 2, or 3 or more matches inside: at 0.3111, 2 / 1 / 4; at 0.4861,
5 / 2 / 5; at 0.615, 4 / 4 / 6; at 0.691, 4 / 4 / 8.

The note's text at each cut-off, for a count of 1, 2 and 3 (the closest matches inside, up to the count), in
characters, over the messages with a note: middle / 90th / longest.

| Cut-off | Count 1 | Count 2 | Count 3 |
|---|---|---|---|
| 0.2323 | 291 / 347 / 347 | 291 / 347 / 347 | 291 / 347 / 347 |
| 0.3111 | 291 / 347 / 347 | 441 / 638 / 638 | 773 / 1,016 / 1,016 |
| 0.4861 | 291 / 365 / 800 | 441 / 800 / 1,099 | 773 / 1,016 / 1,099 |
| 0.615 | 245 / 365 / 800 | 441 / 1,099 / 1,400 | 773 / 1,099 / 1,400 |
| 0.691 | 245 / 800 / 800 | 441 / 1,099 / 1,400 | 788 / 1,400 / 1,825 |
| 0.742 | 291 / 800 / 800 | 482 / 1,099 / 1,400 | 829 / 1,400 / 1,825 |

A note of 1 to 5 matches at any distance (the closest ones), over the messages with at least that many: its text;
the whole note with step 24's draft heading (85 characters) and each match's first line (91 to 104 characters, middle
96, with the real lengths of the label and room name, a 10-character date and a line break and a blank line around
each match: the builder's reading, as neither the date's form nor the layout is set); and, for the other reading, the
matches shown as whole entries. Middle / 90th / longest, in characters.

| Matches | Messages | Text | Whole note | As whole entries (messages) |
|---|---|---|---|---|
| 1 | 24 | 237 / 365 / 800 | 421 / 549 / 988 | 245 / 828 / 1,400 (24) |
| 2 | 21 | 510 / 1,025 / 1,400 | 793 / 1,316 / 1,691 | 560 / 1,395 / 2,556 (21) |
| 3 | 19 | 875 / 1,825 / 2,200 | 1,257 / 2,219 / 2,594 | 829 / 2,606 / 2,618 (18) |
| 4 | 17 | 1,223 / 2,235 / 2,556 | 1,724 / 2,708 / 3,053 | 1,223 / 3,774 / 4,067 (16) |
| 5 | 15 | 1,619 / 2,269 / 2,618 | 2,239 / 2,843 / 3,218 | 1,416 / 4,176 / 4,195 (13) |

A note's text can never be longer than 800 characters a match when a match is a piece; as whole entries, it is
bounded only by the entries' 100,000.

The derived counts (messages with 1, 2 or 3 or more inside) were worked out from the results file by
`scratch\step14\extra.mjs` in the build folder, scores and lengths only.

What these figures cannot say:
- Whether a match helps. "Same project" stands in for "might be relevant" and "other project" for "unrelated";
  neither is always so (two projects can share a subject).
- How the user will work later. Most of these sessions were the user's own tests of Tachikoma: 15 of the 53 are `-p`
  runs (14 of the 35 first messages) and 4 turns repeat an earlier one word for word, so some very close matches are
  a test prompt meeting its own repeat.
- How many first messages are sent before memory is connected, and so get no note, and what the note then tried with
  the next message finds (Q9's recommended text in the plan): neither is counted or measured. The counts of notes are
  an upper bound for those first messages; the table without the `-p` runs shows how far they could drop.
- Lessons in the note: there are none yet, so the merged list (Q27) held the project's matches alone. The cut-off and
  the count apply to project matches and lessons together (step 24: "the cut-off and the count are then applied to
  the merged list").
- The user's own MemPalace (the `"use"` path, a palace of about 6.8 GB with its own settings), other embedding models,
  other languages, and larger palaces: not measured.

#### The user's folders

Four pairs of snapshots, each taken in the same command just before and just after its run:
- the check: `step14-check-before` (17:37:42 UTC) and `step14-check-after` (after 17:38:35): "no change" (exit 0),
  with only the set-apart daemon folder of the user's MemPalace;
- the run: `step14-before` (17:39:58) and `step14-after` (after 17:41:56): "no change" (exit 0), the same;
- after the review, the check: `step14-fix-check-before` (18:33:18) and `step14-fix-check-after` (after 18:34:07):
  "no change" (exit 0), the same;
- after the review, the run: `step14-fix-before` (18:34:53) and `step14-fix-after` (after 18:36:50): "no change"
  (exit 0), the same.

The same commands listed the top level of the user's Temp folder (names and times only, no file opened): no
`uv-*.lock` in any of the four. Around the first check, one file was added and one removed; around the first run,
nothing was added, removed or rewritten; around the second check, nothing; around the second run, one file was added
(origin not traced, in each case). Every child process had the build's home, TEMP and TMP. The script reads the
transcripts and writes only in the build folder; the palace `measure-note-<stamp>-real` (and the check's) is gone, and
`palaces` holds no `measure-note-*` folder.

#### The decision for the user: the note's cut-off and count

What the two numbers do (design, section 4; step 24): at the first message after a launch, `/clear` or a shortening,
if memory is connected by then, the matches from the project's room and the lessons at or below the cut-off, closest
first, up to the count, go in front of that message under the heading. With no match inside, the message goes as it
is. If memory is not connected yet, the message goes without a note and the note is tried with the next message, at
most once per launch, `/clear` or shortening (Q9's recommended text in the plan); in `-p`, whose one message is sent
at launch, that can mean no note. The counts below are of notes on first messages only, and a note tried again with
the next message is neither counted nor measured. So the counts of notes below are what the cut-off allows on first
messages, at most; fewer will be made there where a message comes before memory is connected, which was not
measured.

The options for the cut-off (of the 24 first messages with earlier entries; the other 11 get no note at any
cut-off). Each gives, in brackets, the same without the `-p` runs (of 13 window messages with earlier entries, and of
18 with other projects' entries):
- **N1. 0.2323**: 6 get a note (3 of them `-p`; without `-p`, 3 of 13), one match each; no other project's entry
  comes this close. Notes are rare (6 of 35 first messages).
- **N2. 0.3111**, as close as any other project's entry came: 7 get a note (3 `-p`; without, 4 of 13), with up to 5
  matches; 1 of 1,397 other-project matches is inside, the one at the edge (without `-p`, none).
- **N3. 0.4861**, the middle of the messages' closest matches: 12 get a note (4 `-p`; without, 8 of 13), with up to
  11 matches inside; 6 of 1,397 other-project matches (0.4%) are inside, for 4 of 29 messages (without `-p`, 2 of
  683, for 2 of 18).
- **N4. 0.615** (1% of other-project matches inside): 14 get a note (5 `-p`; without, 9 of 13); other projects'
  matches inside for 7 of 29 messages (without, 2 of 18).
- **N5. 0.691** (5% inside): 16 get a note (5 `-p`; without, 11 of 13); other projects' matches inside for 20 of 29
  (without, 9 of 18).

From 0.742 up, a tenth or more of all other-project matches are inside, for 25 to 29 of the 29 messages.

The options for the count: **1**, **2** or **3**. At N3 the note's text is, middle and longest, 291 and 800
characters for 1; 441 and 1,099 for 2; 773 and 1,099 for 3; add 85 for the heading and about 100 a match for its first
line. Since the lessons share the count (step 24: "the cut-off and the count are then applied to the merged list",
plan.md:1455-1457; Q27 only merges the two rooms by distance), a count of 1 lets a closer lesson push the project's
match out, and the other way round.

Recommended, and chosen by the user (below): **N3, 0.4861, with a count of 3** (reasons rewritten after the review).
Say first what N3
is: it is the middle of the messages' closest same-project scores, so about half the messages with something earlier
get a note by construction (12 of 24; 8 of the 13 window messages). That is not a finding about how useful notes
are: **nothing here measures whether a match helps**. The reason to take N3 and not a wider cut-off is the other
projects' entries, the only stand-in for unrelated text measured: up to N3 they stay rare (0.4% of them inside, for 4
of 29 messages; 2 of 18 window messages), and at the next candidates they rise (1.1% and 7 of 29 at 0.615; 5% and
20 of 29 at 0.691). Without the `-p` runs the step to N4 is smaller: 9 notes against 8, with other projects' matches
inside for the same 2 of 18 window messages (4 matches against 2), so on the window messages alone N4 is about as
safe; it rests on one more note. The reasons for a count of 3: the lessons share the count with the project's
matches (step 24, the merged list), so a count of 1 lets one push the other out; and the cost is small and bounded:
at most 1,099 characters of text here, and 2,400 at most if a match is shown as its piece (3 pieces of 800; step
23's reading, not yet decided). Shown as whole entries, 3 matches reached 2,618 characters here (the length table,
"As whole entries"), bounded only by the entries' 100,000 each. All before the heading and first lines. Its weak
points: whether a second or third match helps is not measured; at 0.4861, 4 of 29 messages have another project's
entry inside, so an unrelated entry of the same project may get in about as often, which this cannot tell; the
counts are of first messages' notes, an upper bound for those sent before memory is connected, and a note retried
on the next message is not counted (Q9's recommended text in the plan); and the figures rest on 35 messages, mostly
tests. A more careful choice: **N3 with a count of 1** (one piece, at most 800 characters), or **N2, 0.3111, with
a count of 1**.

**The user's choice: not yet given.** (Answered below.)

#### The user's choice (step 14), 2026-11-20

The user chose **N3: a note cut-off of 0.4861 and a count of up to 3** (the answer "N3 0.4861, up to 3",
2026-11-20). These are the M6 figures for step 24: at the first message after a launch, `/clear` or a shortening,
the matches from the project's room and from `lessons`, merged by distance (Q27), at a distance of 0.4861 or less are
taken, closest first by their own distance, and at most 3 go in the note (the cut-off and the count applied to the
merged list, step 24). They are recorded here for steps 23, 24 and 28 to take from.

The user chose with these before them:
- 12 of the 24 first messages with something earlier get a note at 0.4861; of the window messages alone, 8 of 13;
- 6 other-project matches (pieces of other projects' turns) come inside the cut-off (window messages alone: 2);
- a note's text is typically about 770 characters and at most about 1,100 (text only, before the heading and
  first lines);
- the counts are an upper bound (a first message sent before memory is connected gets no note);
- the count is shared with lessons in the merged list;
- nothing here measures whether a match helps.

Not covered: real lessons in the note, the user's own MemPalace, a note tried again on the next message, other
languages and larger palaces. Step 14 was committed (0668f98, with the review fixes aa1b266) before the user's
answer; the answer is in the commit after them.

### Q2's open item: Node 22 and node:sqlite's warning (step 17, 2026-11-20)

The question (Q2's "Open" item above): does Node 22 print anything when `node:sqlite` is loaded?

Where it ran: the Node 22 already on this PC, the user's fnm install
(`C:\Users\<user>\AppData\Roaming\fnm\node-versions\v22.22.2\installation\node.exe`, `v22.22.2`), run as it is,
nothing fetched or changed, in a folder of the build's own (`tachi-8d-build\step17`, removed afterwards). No Node 22.20
exactly is on this PC. Node v24.22.1 for comparison.

What was seen, each a one-off command (open a lock file, `BEGIN EXCLUSIVE`, close):
- Node 22.22.2, by `require`, by `import()` and by `process.getBuiltinModule("node:sqlite")`: exit 0, and on stderr
  each time:

      (node:287420) ExperimentalWarning: SQLite is an experimental feature and might change at any time
      (Use `node --trace-warnings ...` to show where the warning was created)

- Node v24.22.1: exit 0, nothing on stderr.
- Node 22.22.2, with `process.emitWarning` swapped, for the length of the load only, for a filter that drops an
  `ExperimentalWarning` whose text starts "SQLite is an experimental feature": nothing of SQLite's on stderr, and a
  warning sent afterwards still showed (`ExperimentalWarning: another warning, still shown`).

Before this step nothing in Tachikoma stopped Node's warnings (no `warning` listener, `emitWarning`, `--no-warnings` or
`NODE_NO_WARNINGS` in `src/`), so on Node 22 the two lines would reach the user's screen.

The user's choice (2026-11-20), word for word: "Drop just that warning". That is: drop only that one warning, as the
filter above does (for a warning given as text and a type, or as a warning object), and load `node:sqlite` only when
a lock is first taken, never at launch. Built in `src/memory/oslock.ts`.

For the steps that use the lock (19, 20 and 22), from step 17's review:
- make the lock's folder first; `tryLock` does not make it, and a missing folder fails with an error naming the lock;
- let the lock go in a `finally`;
- the save lock is one per palace (step 22), so each palace's save lock is given a folder of its own;
- never take a name this process already holds: the second take is refused, and a waiter that retries it waits
  forever.

Checked on the built lock: `tests/memory/oslock.test.ts` (Node 24; Node 22's warning stood in by the child script)
passes; and the test's child script, `tests/memory/oslock-child.ts hold`, run under Node 22.22.2 with `--import tsx`
(TEMP and TMP in the build's folder): it took the lock with nothing on stderr; a second process was refused ("busy",
nothing on stderr); after the holder was killed outright (`SIGKILL`), a third took it, then let it go on "release".
The suite does not need Node 22.

Since step 18 (2026-11-20, the user's choice "Share the loader" at its review): the palace client reads the
model from the palace file through the same loader (`load`, exported from `src/memory/oslock.ts`), so `node:sqlite`
may also load first at that read-back, after a hub start or a join (step 20), still never at launch and still with
only that one warning hidden. A load that fails gives no model, not an error (`src/memory/client.ts`, `modelIn`).

### uv's package-index settings and the locked install (step 19, 2026-11-20)

This replaces part of step 16's "Keep download ones" (the user's choice at step 16's review). Tachikoma's installer
no longer passes these settings of the user's to the uv it starts: `UV_INDEX`, `UV_DEFAULT_INDEX`, `UV_INDEX_URL`,
`UV_EXTRA_INDEX_URL`, `UV_INDEX_<name>_USERNAME` and `_PASSWORD`, and `UV_KEYRING_PROVIDER`. It still passes
`UV_NATIVE_TLS`, `UV_SYSTEM_CERTS`, `UV_PYTHON_INSTALL_MIRROR` and `UV_ASTRAL_MIRROR_URL` (`src/memory/env.ts`,
`uvEnv`). Nothing of the user's own settings is changed: the names are only left out of the child's environment.

Why: uv's documentation does not say how a set index meets a lock file (concepts/indexes, concepts/projects/sync and
concepts/resolution on docs.astral.sh, read 2026-11-20). uv's issue #6349 (read 2026-11-20, closed 2026-11-19) does:
a reporter with another index set got "error: The lockfile at `uv.lock` needs to be updated, but `--locked` was
provided.", which would stop Tachikoma's `uv sync --locked`; the same reporter says a locked install "downloads from
the URLs recorded in the lock", and a maintainer: "I consider it fairly critical that the lockfile includes the URLs
directly." Not tried here: no uv was run against an index. The user's choice, "Drop the mirror settings". A user who
can reach only a mirror, not PyPI, cannot set memory up; step 30's README lists it.

### The hub's supervisor: the proof, its figures and the user's choices (step 20, 2026-11-20)

**The proof** (`scripts/8d/hub-proof.mjs`), run before any of the supervisor was written. It started real hubs in the
build folder with the supervisor's program, arguments and environment:
- the environment's own Python, `-I -m mempalace.mcp_server --transport http --host 127.0.0.1 --port <p> --palace
  <palace> --backend sqlite_exact`;
- step 16's `hubEnv` on the build's own environment, with step 5's `HF_HUB_OFFLINE=1` and a dead-end proxy;
- step 16's paths in a new data folder of the build folder;
- hidden and detached, with no input or output, from a starter that then exits.

It showed the hub serves, is found and is stopped by its id with nothing left running.
- **Run 1** (2026-11-19 22:11 UTC): the exact form; one hooked copy for the connection watch.
  - Serves: a health answer about 1.3 s after the start; one add and one search worked.
  - Found: listing `<home>\.mempalace\server\*\serverinfo.json` and matching `palace_path` without regard to letter
    case gave the file naming the port, 0.6 ms after the health answer.
  - Stopped: the serving process's start time was read by the environment's Python and equalled the script's own
    reading to the microsecond. A stop given another start time said "differs" and stopped nothing.
  - The real stop ended the serving process, the launcher the starter had started and the console host, and all were
    gone afterwards, listed by id before and after.
  - The snapshot pair: "no change".
  - Finding: on a new, empty palace `mempalace_status` is refused, "Backend open failed: Could not open the selected
    backend collection.", until the first entry is saved.
- **The review** found faults in the script's clean-up and Temp folder, and in its macOS start time. The user chose
  "Fix script, measure again".
- **Run 3** (22:31:41 to 22:32:39 UTC, after the fixes): passed, 0 failures, 27 hubs, all through step 5's audit-hook
  wrapper (`-c <wrapper> <log> mempalace.mcp_server`, the user's choice for the watch). The supervisor runs the hub
  without it.
  - The run's own Node and tsx had their Temp in the build folder.
  - Every hub served, was found, refused a stop given a wrong start time, and was stopped with its three processes
    gone.
  - The proxy got 0 connections; the hooks saw no outside address and no child process.
  - 81 processes were recorded with their start times; none was left. The snapshot pair: "no change". No `uv-*.lock`
    in the user's Temp. Nothing was fetched.
  - Run 2 had stopped at once on the script's own Temp guard, before any set-up.

**Run 3's figures** (this PC, as in M3; 20 starts on a palace holding 3 entries; ms):

| Figure | Fastest | Middle | Slowest |
|---|---|---|---|
| Start-time read (the environment's Python, spawned) | 147.2 | 159.5 | 195.5 |
| Read-back: connect, with the tool list | 6.6 | 7.4 | 15.1 |
| Read-back: `mempalace_status`, first after the start | 107.9 | 116.5 | 155.1 |
| Read-back: the palace file's model | 1.3 | 1.5 | 2.1 |
| Read-back: all three | 117.6 | 126.5 | 165.2 |
| Stop: the whole run of the environment's Python (all 27 stops) | 188.3 | | 257.5 |
| Stop: the wait inside it (all 27 stops) | 11.8 | | 23.3 |

**Empty and broken palaces.** For 5 new, empty palaces and one broken on purpose (a palace file that is not a
database), the status call was refused with the same words: "Backend open failed", "Could not open the selected
backend collection.", the same hint. So the refusal cannot tell them apart. The palace file can:
- the empty palaces had no `sqlite_exact.sqlite3` at all, even after a start, the status call and a search;
- the broken one's could not be opened.

**The user's choices (2026-11-20).**
- The stop's limit: 1.3 s for the whole stop run (5 x 257.5 ms). It replaces M3's 1 s for the stop. A stop that passes
  it counts as stopped, and the record is cleared. Step 20's code review changed this: see "What counts as a stop" in
  As built.
- The read-back's limit: 0.9 s (5 x 165.2 ms). On a timeout memory is off for this launch; the next launch tries
  again.
- The start-time read after a start: its own limit, 1 s (5 x 195.5 ms). The 40 s start limit stays as M3 measured
  it, from the start until the hub answers and its serverinfo.json names its port.
- The empty-palace rule: a refused status with no palace file is "not read yet", and memory is on. A refused status
  with a palace file that cannot be opened turns memory off. Step 18's client now tells "no file", "can't open" and
  "no model row" apart (`palaceFile`).
- Approved:
  - the stop is forced on Windows (`TerminateProcess`; only idle hubs were stopped);
  - the hub's output is not kept, so a failed start reports its exit code (the wording waits for step 21);
  - the palace's version record is `tachikoma-version.json` in the palace folder, holding `{"mempalace":"3.12.0"}`.
- Known limits, for step 30's README:
  - a backend mismatch exits with code 2 like another window's hub, so it waits the 40 s start limit and then reports
    exit code 2;
  - an unwritable or missing palace folder, or a deleted palace file, also reads "no file" (memory on until the first
    save fails);
  - the Linux and macOS ways are not run (below).

**Built** (`src/memory/hub.ts`):
- the start, the finding and the stop as the proof ran them, with the proof's helper word for word;
- Tachikoma's hub record, written only under the join lock;
- an exit with code 2 leading to another window's hub;
- joining and leaving as "Joining and stopping" says, with "in use" files refreshed every 5 s and gone after 27 s
  (M4);
- the timer that rejoins a hub found gone or stopping;
- the version record, and an old environment folder removed only under the join lock;
- a closing state entered once.

**Not run here**, from the systems' own manuals:
- Linux: the start time from `/proc/<pid>/stat` (the `proc(5)` manual); the wait with `os.pidfd_open` and `select`.
- macOS: the start time from `ps -o lstart= -p <pid>`, to the second (the user's choice); the wait with `kqueue`.
- On both the stop is SIGTERM, MemPalace's clean exit.

**After the code review (2026-11-20).** The user said "Fix them". The changes:
- **A stop counts only when the helper says the serving process ended:**
  - "stopped";
  - "running", the wait after TerminateProcess past its limit, under the late-stop rule;
  - "gone", no such process.

  Anything else keeps the record, marked stopping, for the next window, and the leave answers "not stopped":
  another program's id, a process that could not be opened, or no answer within the stop's limit (a killed, crashed
  or unstartable helper).
- **The helper now tells "gone" apart from "unopened <error>".** On Windows, OpenProcess's error 87 means no such
  process, and any other error means it could not be opened; a process that has exited is "gone". Elsewhere,
  ProcessLookupError means gone, and any other OSError means unopened. Runs 1 to 3 had the text before this split.
  The split was not run against a real process.
- **The leave's signal** now also ends its wait for a join under way.
- **A last window's leave whose take of the lock fails** marks the record stopping (without the lock, which could not
  be taken), so the next window starts or finds the hub again and stops it when it leaves.
- **"Treat as new":** a refused status with a palace file that opens but has no model row means memory on, like "no
  file".
- **A free port that cannot be had** has its own reason.

Known limits, for step 30's README:
- **An exit-2 join records the hub's folder as not known (`env: null`), so old environment folders wait for a later
  clean-up.** The user chose "Accept, README note".
- **On Windows the record's rename can fail while another window holds the file open to read it.** Then that join,
  or that leave's stopping mark, fails once. The rename is Node's `renameSync` over the old file.

**After the re-check of the review fixes (2026-11-20).** The user said "Fix both".
- **Closing is back to the plan's rule.** The leave's signal cuts only the wait for the join lock. A free lock is
  still taken: the leave tries once before its signal counts. A join already under way finishes its one step, and
  the leave then treats whatever hub that step started like any other: it stops it if this was the last window.
- **The stopping marker.** A last window whose leave cannot take the join lock now writes
  `memory/home/hub-stopping.json`, holding `{"pid": <the hub's id>, "start": "<its start time>"}`. It is written
  whole, by a rename. The hub record is never rewritten without the lock.
  - A join under the lock treats a record that matches the marker (the same id and start time) as stopping.
  - A join removes the marker when it writes a new record, and a leave removes it when it clears the record.
  - Under the lock, a marker that matches no record is stale and is removed.
  - The timer's check, which takes no lock, reads the marker and joins again on a match.

### Step 31 The whole suite, the last snapshot and the clean-up (2026-11-20)

**The suite**, run once (`node node_modules/vitest/vitest.mjs run`), took 1,042.6 s, against about 6 minutes usually:
6,708 passed, 49 skipped, 6 failed. Five failures were limits passed under that load: three `tests/cli.test.ts`
tests (15 s each, `--max-tasks` among them), one `tests/memory/memory.test.ts` test (15 s), and
`tests/sandbox/sitesReal.test.ts`'s launch check (the sandbox's 30 s set-up). The sixth,
`tests/memory/hub.test.ts`'s "the whole stop run passed its limit", found the stand-in hub already ended, most likely
because the test's stand-in helper stops the hub 3 s after it starts and the loaded run was slow (that test took
9.6 s; not traced further). Each of the six passed when run alone, the hub test four times. The types check passed.

**No process of the build's was left:** every MemPalace process running was the user's own (`~/.local/bin` and the
user's uv tool folder), and none ran from the build folder.

**The last snapshot** of the user's folders (12:18:25 to 12:18:38 UTC), with step 1's helper, compared with step 1's
first kept snapshot (`step1-f`, taken at step 1): the helper reported differences, all of them files of the user's own
MemPalace plugin or of the Claude Code update the user explained at step 10. The helper keeps only each entry's last
change time, so the times below are last changes; earlier changes since step 1 are not recorded.
- `~/.mempalace`, the user's MemPalace plugin, saving from the user's Claude Code sessions (files of the kinds earlier
  pairs traced):
  - `palace/sqlite_exact.sqlite3` (6,809,341,952 to 6,854,701,056 bytes), last 11:53:42.5 UTC; its `-wal`
    (7,720,912 to 13,579,552 bytes), 11:53:46.5;
  - `wal/write_log.jsonl`, 32,111 bytes longer, 11:53:03.7;
  - `hook_state/last_checkpoint`, 11:53:04.0;
  - three `hook_state/<session>_last_save` files: 11:53:04.0 (this build's lead Claude Code session), 2026-11-20
    09:09:44.5 (the other session traced at step 28's third run), 2026-11-19 04:29:38.7 (the other project's
    session traced at step 11);
  - `locks/mine_palace_<palace key>.lock`, 11:53:04.1, and the `locks` folder, 11:53:46.5;
  - set apart, as always: the daemon folder (12:18:26.0, during the snapshot), its `queue.sqlite3` (11:53:46.5) and
    `hook_state/hook.log` (40,826 bytes longer, 11:58:43.1).
  - The latest of these follow the known chain: the lead session's reply ended at 11:53:02.133 UTC, its Stop hook
    finished at 11:53:04.086, the plugin's files changed at 11:53:03.7 to 11:53:04.1, and the palace at 11:53:42.5
    and 11:53:46.5.
- `~/.local/bin` (15 entries against 14) and `~/.cache`, the Claude Code update of 2026-11-19: `claude.exe` changed
  and `claude.exe.old.<number>` was added (01:36:02.2 UTC), and `~/.cache/claude/staging` changed (01:36:00.2).
- `AppData/Roaming/uv` and `AppData/Local/uv`: no change. `~/.config/mempalace`: missing both times. Nothing else in
  `~/.cache` changed; every folder's entry count is step 1's apart from `~/.local/bin`.

**The build folder**, `tachi-8d-build` in the user's Temp folder (6.6 GB of files: 85,743 files, 9,046 folders and
two junctions inside it, uv's Python links), was then removed by that name, the two junctions unlinked without being
followed, and it no longer exists. It held the snapshots, the throwaway installs, palaces and hubs, and the
measurement outputs whose figures are in this record. The snapshot was not run again after this.

**Other tests' leftovers in the user's Temp folder** are not this step's: 223,256 top-level `tachi-*` entries since
2026-10-22, 6,533 of them from 2026-11-20 (`tachi-`, 4,717, `tachi-app-data-`, 1,399, and 417 others). They are left for
the cleanup release, where the tests that leave them will be fixed (the user's choice, "Leave for cleanup",
2026-11-21). Nothing of them was deleted.

## As built

Where the build differs from this design, or settles what it left open. The build plan's open questions are cited by
number (Q1 to Q27), each with the user's answer and its date; "the user's choice" marks an answer given during the
build, on 2026-11-19 or 2026-11-20. Every figure is from the measured sections above or the build's step reports, and
each limit is 5 times this PC's slowest unless noted (the user's margin; no slower PC was run). The README's
"Long-term memory's limits" gathers the rarer cases left as limits. Steps 1 to 30 are c14dbe3 to 4510ebf on
`release-8d`, with their review fixes.

**The hub**
- **Not `mempalace serve`** (section 2, "The hub"; Q24, the user's answer 2026-11-19). Step 6 found that on Windows
  `serve` is four processes, the one Tachikoma would start is not the one that serves, and stopping it leaves the
  server running with the palace locked. The window starts the environment's own Python directly, `-I -m
  mempalace.mcp_server --transport http --host 127.0.0.1 --port <p> --palace <palace> --backend sqlite_exact`, with
  `MEMPALACE_EMBEDDING_MODEL=minilm`, and stops it by the serving process's id after a start-time check. Step 8 and
  step 20 proved that start and stop before it was relied on. The design's "through the hub's own shutdown if it has
  one" is not used: the stop is forced on Windows (`TerminateProcess`; only idle hubs were stopped, approved
  2026-11-20), SIGTERM on Linux and macOS (from their manuals, not run).
- **Two settings on every hub:** `MEMPALACE_MCP_WRITER_WAIT_SECONDS=0` (Q8, 2026-11-19), so a second hub for the same
  palace exits with code 2 at once and the window joins the other window's hub; and `MEMPALACE_MCP_IDLE_HOURS=0`
  (Q25, 2026-11-19), so a hub never quits on its own.
- **Where the window finds the hub** (Q7, 2026-11-19): Tachikoma's own hub record in `memory/home`, written only under
  the join lock, and MemPalace's `serverinfo.json` found by matching `palace_path`. A last window that cannot take the
  join lock writes `memory/home/hub-stopping.json` (approved 2026-11-20). The palace's version record is
  `tachikoma-version.json` in the palace folder, `{"mempalace":"3.12.0"}` (approved 2026-11-20).
- **The lock** (Q2, the user's choice 2026-11-19): an exclusive `node:sqlite` transaction on one lock file per lock,
  for joining, stopping, installing and saving. On Node 22 only its one `ExperimentalWarning` is dropped ("Drop just
  that warning", 2026-11-20).
- **Figures:** start limit 40 s, for every start; check interval while a hub starts 100 ms; health check 0.75 s
  (MemPalace's own); wait between lock tries 500 ms (M3, 2026-11-19). The stop: 1.3 s for the whole stop (5 x
  257.5 ms), replacing M3's 1 s. The read-back of the storage and model: 0.9 s (5 x 165.2 ms). The start-time read
  after a start: 1 s (5 x 195.5 ms). All the user's choices of 2026-11-20 (step 20).
- **What counts as a stop** (the user's choice at step 20's code review, 2026-11-20, which changed the first choice
  that a stop past its limit counts as stopped): only the helper's answer that the serving process ended. That is
  "stopped", "gone", or "running" when only the wait after `TerminateProcess` passed its limit. Any other answer, no
  answer within the 1.3 s among them, keeps the record marked stopping for the next window.
- **"In use"** (M4, 2026-11-19): refreshed every 5 s; one older than 27 s counts as gone.
- **"In use" while a hub starts** (PR #26 review, finding 3; the user's decision, 2026-11-22): the 5 s refresh runs
  from the join's first write of the file, under the join lock, so a first start longer than 27 s no longer lets a
  leaving window count this one as gone and stop the new hub. While a join is under way the timer only refreshes the
  file; the join checks the hub itself.
- **The hub's token** (PR #26 review, finding 1; the user's decision, 2026-11-22): the install's own random token, 32
  bytes in base64url as MemPalace makes its own (`server_registry.py:99`), made once under the join lock and kept in
  `memory/home/hub-token.json`. Every hub is started with it in `MEMPALACE_MCP_HTTP_TOKEN`, never on its command line,
  and Tachikoma's client sends `Authorization: Bearer <token>` on every request; the health check needs none
  (`mcp_server/http.py:737-756`). A real MemPalace 3.12.0 hub started this way (2026-11-22, a throwaway install
  through sfw) answered 401 to a request with no token and with a wrong one, and 200 with the right one. A token file
  removed while a hub runs leaves that hub refusing the windows until it stops (a known limit). The user's own
  program is unchanged.
- **The token, after the review of b83d076** (the user's decisions, 2026-11-22): the hub record marks whether the
  hub was started with the token (`"token"`; false for a hub found after an exit with code 2, and absent in a record
  from before the token). A hub not marked is treated as stopping, never reused on its health alone: the window's own
  start exits with code 2 while that hub holds the palace, the window joins it, and the last window to leave stops
  it, so the next start has the token. A new token is made only when the file does not exist; a file that cannot be
  read turns memory off for that join with Node's own words, as a folder that cannot be made does, so a running hub's
  token is never replaced. A file that reads but holds no token is replaced, even if outside damage hit it while a
  hub runs: no token can be read from it, so no window could reach that hub with it anyway. The file is written for
  its owner only (mode 0o600, which Windows does not keep; the private folder guards it there).
- **A hub found after an exit with code 2** (the review of 0b7cda2, point C; the user's decision, 2026-11-22): it is
  asked MCP's first request without the key, within the health check's 0.75 s. A refusal with 401, as the real
  MemPalace 3.12.0 check measured for no key, marks it as started with the token, and it is reused as it is; any
  other answer, or none, marks it as not, and it is treated as stopping. A known limit (point A): on a computer that
  still runs a hub from a build before the token, windows keep joining that hub, which any account on the computer
  can reach, until the last window leaves; a released install never has one.
  - Why a 401 means a key: MemPalace 3.12.0's `mempalace/mcp_server/http.py` (the file at tag v3.12.0 on GitHub,
    github.com/MemPalace/mempalace, read 2026-11-22) answers 401 in one place only, `_http_request_rejected` under
    `if require_auth and srv.auth_token:` (the Bearer compare); a hub without a key refuses only with 403 (the Host
    pin, a proxied request, Sec-Fetch-Site, Origin). So a 401 to MCP's first request sent without the key means the
    hub has one; the real check (PR #26 review 1) gave 401 for no key.
  - The 0.75 s is the health check's limit reused (MemPalace's own for `/healthz`), not measured for this request.
    It runs under the join lock, so a join whose start exits with code 2 can take up to 0.75 s more.
  - Tests: of the two, only "marks a hub found after an exit with code 2 by whether it refuses a call without the
    key" fails without this change; the one for a hub without a key guards what was already so.
- **The timer and a hub without the key** (the review of 0b7cda2, point B; the user's choice B2, 2026-11-22): the
  timer's check is left as it was, so it keeps a hub found without the key while that hub answers and does not
  restart it on every 5 s tick. The join still treats such a hub as stopping: a window that starts afresh starts a
  hub first, and the found hub is then joined as before (limit A above covers it).
- **The stop's Python** (PR #26 review, finding 4; the user's decision, 2026-11-22): the stop's helper runs with the
  Python of the environment the hub's record names, which a newer window never removes while the record names it;
  the window's own Python only when that one is gone or the hub's environment is not known.
- **An empty palace** (2026-11-20): MemPalace refuses `mempalace_status` on a new palace until its first entry. A
  refusal with no palace file, or with a file that opens and has no model row, means memory on; a file that cannot be
  opened turns memory off.

**The install**
- **The download** (M1, 2026-11-19): N = 230 MB, the largest total with Python (Linux x86-64, 229.6 MB), rounded up.
  Python 3.13 (the user's choice at step 3, 2026-11-19).
- **uv's settings** (2026-11-20): the user's `UV_NATIVE_TLS`, `UV_SYSTEM_CERTS`, `UV_PYTHON_INSTALL_MIRROR` and
  `UV_ASTRAL_MIRROR_URL` are passed to uv; every other `UV_` name is left out, the package-index ones too ("Drop the
  mirror settings", after uv issue #6349), and `UV_NO_CONFIG=1` is set. `sfw.exe` or `sfw.cmd` is used ("Accept
  sfw.cmd too", 2026-11-20).
- **The home's folders** (section 2, `home/`): uv and the hub get `HOME` set to `memory/home` on every system, and
  `USERPROFILE` too on Windows; on Windows also `APPDATA` and `LOCALAPPDATA` in `home/AppData/Roaming` and `Local`
  ("Redirect AppData too", 2026-11-21); and on every system `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` and
  `XDG_CONFIG_HOME` in `home/.local/share`, `.local/state`, `.cache` and `.config` ("Fix both", 2026-11-21). The
  user's own program keeps the user's.
- **The model** is downloaded by Node's own `fetch`, not through sfw, and is checked against its hash; that download
  ignores `HTTPS_PROXY` (a known limit, 2026-11-20).
- **Without uv** (section 6): memory is off with the design's line, as designed, with two exceptions the user chose
  on 2026-11-20 at step 27: an environment already set up starts without uv, since the hub start uses no uv ("Start
  memory anyway"); and after "Don't ask again" no line is said ("Stay silent").
- **A set-up that ends during a session** (Q1, 2026-11-20): saving, the note and lessons on failure start at once;
  the three tools and the prompt line are fixed per launch and join at the next one (`Long-term memory is set up. Its
  tools join at the next launch.`). `/memory setup` after an install that failed this launch starts a new one ("Try
  again now", 2026-11-20).
- **The first-use ask** (Q3, 2026-11-20): a launch question before the window, with ` [y] Yes  [n] Not now  [d] Don't
  ask again`; `/memory setup` uses the yes/no question. "Don't ask again" is an empty private file in
  `<data folder>/memory/` (Q12, 2026-11-20).

**What is saved** (section 3)
- **A turn** (Q4 and Q5, 2026-11-19): one typed prompt and all of the model's text in answer to it, in order; `<n>`
  is the prompt's place in the session, from 1. A turn without typed words is not saved.
- **Where a turn ends** (Q22, 2026-11-20): a line in the transcript at each typed turn's end; a turn without one is
  never saved. An older Tachikoma counts the new lines as damaged (Q17, 2026-11-20: kept, a known limit).
- **A damaged line** (PR #26 review, finding 2; the user's choice "Only that turn", 2026-11-22): as in the
  measurements' rule for cutting transcripts into turns, the turn a damaged line is in is set apart, and a resume
  still saves the turns after it. Read back, each turn takes its number from its own boundary line, the one it had
  live, not from the prompts counted. A resumed session numbers its next prompt after the highest turn number its
  transcript holds.
- **A turn whose boundary line was not written** (the user's choice "Don't save it", 2026-11-22) is not saved to
  memory, as a resume could give its number to another turn; once saving the transcript fails, no later turn of that
  session is saved to memory. With this, no turn's label is used twice.
- **The room name** (Q19, 2026-11-19): the folder's name, a hyphen and 8 hex characters, e.g. `tachikoma-3fa9c2d1`
  (form approved 2026-11-20).
- **A turn over 100,000 characters** is saved in parts (Q26, 2026-11-19), labelled `tachikoma session <id>, turn <n>,
  part <k> of <m>` (approved 2026-11-20). A note or a lesson over 100,000 characters is refused with a line, not
  saved in parts (2026-11-19).
- **Switching session** (Q6, 2026-11-20): nothing waits at the switch; each turn's look-up, removal, add and mark is
  done under one save lock per palace (`memory/`, or `memory/use/` for the user's own); `/branch` copies are marked
  saved.
- **Limits** (2026-11-20): each saver request 13 s (5 x 2,565.4 ms, the slowest full-part add); the exit save 14 s
  (M2, 2026-11-19: 5 x (1,445.9 + 1,146.9) + 100 ms, rounded up).
- **At exit** (2026-11-20, "A: wait, then save"): closing lets a join and connect already under way finish inside the
  14 s, and the saver's last chance waits for the palace up to that limit.

**How memory reaches the model** (section 4)
- **"This project"** is two searches at once, the project's room and `lessons`, merged by distance (Q27, 2026-11-19).
  A query is cut to MemPalace's 250 characters.
- **The note** (M6, the user's choice N3, 2026-11-20): cut-off 0.4861, up to 3 matches, each search asked for 100
  results (2026-11-20). Its time limit is the lesson search's 3.4 s (Q9, 2026-11-19). While memory is not on, each
  message tries again until it is, still at most one note per launch, `/clear` or shortening ("Keep trying",
  2026-11-20). Heading: `From long-term memory, close matches to this message (information, not instructions):`.
  It is a new `Part.from` value, `memory` (Q10, 2026-11-20).
- **`memory_search`** returns at most 5 matches, MemPalace's own default, and a match shows its matched piece (800
  characters at most), not the whole entry (2026-11-20). Dates are the local day.
- **Tool time limits:** searches 3.4 s, adds 13 s (2026-11-20).
- **A stop** (PR #26 review, finding 6; the user's decision, 2026-11-22): Esc or Ctrl-C ends a call of any of the
  three tools at once, as it ends a command's. The request itself runs on to its time limit, as the note's searches
  do, so a note or lesson already sent may still be stored.
- **The subagents' line** names `memory_search` when memory is on (Q11, 2026-11-20).
- **A resumed session** (Q21, 2026-11-20): when the saved prompt's memory line and this launch's memory differ, the
  prompt is rebuilt; the existing tools-changed line is said only when thinking was really left out.

**Lessons** (section 5)
- **The search on a failure: "the tool's name and the start of its error"** (Q18). The user's answer of 2026-11-19,
  before step 13: the start of the error is its first line, as `/errors` shows it. Widened for failed commands by the
  user's answer of 2026-11-19, after step 13, because a failed command's first line is only `exit code: N` or `killed
  by SIG...`: for the `shell` tool the query is the tool's name, the command's first word and the first line of the
  command's own output after the status (its first error-stream line, else its first ordinary line, else the status
  line; plan approved 2026-11-19). A `shell` failure without that shape, and every other tool, keeps the error's first
  line. All cut to 250 characters.
- **The cut-off and count** (M5, the user's choice R3, 2026-11-19): 0.4862, 1 lesson, from made-up lessons searched by
  made-up failures, as the user's error logs held only 6 tool failures. Only the closest lesson is considered; one that
  does not fit under the output cap is not added (Q23, 2026-11-20; "Add nothing", 2026-11-20). Time limit 3.4 s (M8,
  2026-11-19: 5 x 678.3 ms).
- **The ask** (M7, 2026-11-19: as designed; it would have fired 0 times in 80 turns). It is sent only while memory is
  on (Q16, 2026-11-20). The approved request is its system prompt, and the user message is `Failed call: <tool>
  <input>`, `Its error: <error>`, `The call that worked: <tool> <input>` ("Request as system", 2026-11-20), as some
  providers reportedly refuse an empty system prompt. The memory tools' own failures do not count. A failed request
  stays silent; the window cancels running requests at exit, `-p` waits for them.
- **The call that worked** (PR #26 review, finding 5; the user's decision, 2026-11-22): of the commands, only one
  that finished with exit code 0. One started in the background does not count, nor does a subagent started in the
  background (the user's choice "Yes, exclude it", 2026-11-22). One moved there by its timeout or Ctrl+B counts only
  if it has ended with exit code 0 when the turn ends and the pair is looked for ("Only if it passed", 2026-11-22).
  The shell and delegate tools tell the session so; the approved wording is unchanged. This can only
  make asks rarer than M7's 0 in 80 turns, so M7 was not measured again.
- **The duplicate check** is MemPalace's exact one (`already_exists`), not `mempalace_check_duplicate` (2026-11-19).

**What the user sees** (section 6)
- **Off** (Q13, Q15, 2026-11-20): `--no-memory` is one declared flag; a memory failure is error kind `memory`,
  harmless for `-p`, one row per change of state. `-p` prints a memory row as the message alone (2026-11-20).
  `"memory"` is read at launch only, with a "next launch" line on a live edit (Q20, 2026-11-20).
- **The status line** (Q14, 2026-11-20): a status part `memory`, shown only when it matters; `memory off` only for a
  failure in this run.
- **`/memory`**: its counts wait up to 18.1 s (5 x 3,612.6 ms, a count behind a launch catch-up save, 2026-11-20);
  `Unsaved turns: <n>` shows in every state when not zero (2026-11-20).

**Not run here:** Linux and macOS; the real lesson request to each provider (`scripts/8d/live-lesson-ask.mjs`, the
user's to run with their key). The tests against a real MemPalace (`TACHI_TEST_MEMPALACE=1`) passed, 19 of 19, on
2026-11-20.

**The real tests' own waits** (step 29, 2026-11-20, from 50 runs each of `scripts/8d/measure-close.mjs`; these bound
the tests in `tests/memory/real.test.ts`, not Tachikoma): closing the MCP connection to the throwaway copy that
stands in for the user's own program (it and the Python it starts) 0.9 s (5 x 167.5 ms), not the hub's 0.9 s
read-back above; the wait for that program to exit after the close 0.1 s, the rounding's least, as it had always
exited when the close returned (50 of 50; that wait never ran); and the start of each child saver 2.6 s (5 x
514.9 ms).
