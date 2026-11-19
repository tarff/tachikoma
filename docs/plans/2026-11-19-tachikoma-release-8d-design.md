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
set-apart item: the user's own MemPalace's daemon folder `daemon/<palace key>8ab5b11d`, whose time moved (from
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
  MemPalace daemon folder `daemon/<palace key>8ab5b11d`.
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
    (`session_011HyFwUUVRarEnjhRmMcKdH`).

  These set-apart items changed too (they do not fail):
  - `hook_state/hook.log` at 21:28:37 UTC;
  - `daemon/<palace key>8ab5b11d/queue.sqlite3` at 21:29:10 UTC;
  - the folder `daemon/<palace key>8ab5b11d` itself, at 21:30:58 UTC. Its time moves in every pair of listings in
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
  change", apart from the set-apart daemon folder `daemon/<palace key>8ab5b11d` of the user's own MemPalace.
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
    the lock uv's log names for the project). New in Temp: `psi.json` (647 bytes, made 00:38:13.056 UTC, during the
    Python unpacking) and a GUID-named `.tmp` gone before it could be looked at. Not opened, not traced; the run's
    processes then were this script, its helper and `tar.exe`, the last two with the build's TEMP.
  - Run at 00:41:15 UTC (after it): exit 0, passed; 0 `uv-*.lock` in the user's Temp before and after; uv's lock in
    `install\tmp` (`uv-491d2fa86e042654.lock`, 00:41:34.751). `psi.json` not touched. Changed in Temp: one GUID-named
    `.tmp` added, one removed, one rewritten, and the build folder itself.
  - With nothing of the build running (two listings at 00:42:33 and 00:43:25 UTC): one GUID-named `.tmp` removed and
    the same one rewritten again, so that churn is another program's. Left alone.
  - Both runs' pairs of snapshots (`step8-temp-*`, `step8-temp2-*`): "no change", only the set-apart daemon line.
  - `psi.json` is left in place, unopened, for the user.
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
line for the user's own MemPalace daemon folder (`daemon/<palace key>8ab5b11d`). No pair failed.

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
