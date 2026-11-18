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
