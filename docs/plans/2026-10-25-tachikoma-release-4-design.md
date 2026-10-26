# Tachikoma release 4: subagents, the to-do list and instruction files, design (2026-10-25)

Release 4 of Tachikoma. The overall design, the Decisions table and the release order are in
[2026-10-22-tachikoma-design.md](2026-10-22-tachikoma-design.md).

Release 4 lets the lead hand searching and reading to subagents, which run beside it or in the
background and show in a panel under the prompt. It adds two search tools, a to-do list the lead
keeps on screen, and reads the user's and the project's instruction files (AGENTS.md, CLAUDE.md)
into each session. Subagents only read: ones that edit, and CLI workers, come with delegation in
release 10, after the sandbox gives each writer its own copy of the project. The user chose the
scope on 2026-10-23 ("It should have subagents. It was in the initial brief.") and 2026-10-25, and
each part below on 2026-10-25, from options offered.

Sources:
- **Claude Code's instruction files:** code.claude.com/docs/en/memory.md, read on 2026-10-25:
  `~/.claude/CLAUDE.md`; `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` in the working
  folder and every folder above it, broadest first, all joined; `@path` imports relative to the
  file, "a maximum depth of four hops"; `AGENTS.md` only where there is no `CLAUDE.md`, by default;
  no size limit, with the advice to "target under 200 lines per CLAUDE.md file".
- **Codex's instruction files:** learn.chatgpt.com/docs/agent-configuration/agents-md, read on
  2026-10-25: `AGENTS.md` in `~/.codex` (or `CODEX_HOME`); then one file per folder from the git
  root down to the working folder, joined root first; it stops adding files at 32 KiB.
- **Text added in the middle of a turn:** Anthropic's guidance (the Claude API skill's model
  migration notes, read on 2026-10-25) is to put it in the user message after the last
  `tool_result`, never inside one. Tachikoma's three adapters already send that shape correctly
  (`src/providers/anthropic.ts`, `openai.ts`, `chatgpt.ts`).
- **The `ignore` library** (reads `.gitignore` rules): MIT, no dependencies. 7.0.12, of
  2026-10-02, is the newest version at least two weeks old on 2026-10-25 (`npm view ignore time`).

## How it is built

Each subagent is its own `Session`, the class the lead already runs in, with its own conversation,
tools and model (the user's choice over a separate, smaller loop). So refusals, the fallback model,
replies cut off, costs and stopping work for subagents as they do for the lead, written once.

- **`src/core/tasks.ts`, the task manager:** starts subagents, numbers them t1, t2 and so on
  through the session, keeps each one's state, transcript, time and spend, stops one or all, and
  hands finished background answers to whoever delivers them.
- **`src/tools/delegate.ts`:** the lead's `delegate` tool, which asks the task manager for a
  subagent and waits for it, or not.
- **`src/tools/search.ts`:** `find_files` and `search_files`.
- **`src/tools/todo.ts`:** the lead's `todo` tool, and the list it keeps.
- **`src/core/instructions.ts`:** finds and reads the instruction files, imports and all, for the
  system prompt.
- **The screen:** a `TaskPanel` under the prompt, a `TodoList` above it, and a `tasks` part in the
  status line, in the manner of release 3's `ToolLine` and `WorkingLine`.
- **The session** gains two things: several `delegate` calls in one reply run at the same time,
  and text waiting for the lead (a background answer) goes into its next request.
- **Questions** from the lead and every subagent go through one line, each carrying its owner and
  that owner's stop signal, in place of the screen's single question and the lead's stop signal.

## Subagents and the `delegate` tool

- **`delegate(task, background)`.** `task` says what to find out, written for someone who has not
  seen the conversation. `background` is false unless set: the call waits for the subagent and
  returns its answer. The main design's `delegate(task, worker, tools)` comes in release 10; until
  then the model and the tools are fixed.
- **The model (the user's choice):** `--worker <provider:model>`, or `TACHI_WORKER`. Without
  either, a subagent uses the model leading when it starts. Claude Code's own search subagent runs
  on Haiku by default; `--worker` lets searching go to a cheaper model the same way.
- **What a subagent is given:** a fresh conversation, a short system prompt of its own (it only
  reads, and reports what it found with file paths and line numbers), the same instruction files as
  the lead, and three tools: `read_file`, `find_files`, `search_files`. No `write_file`,
  `edit_file`, `shell`, `delegate` or `todo`, so subagents never start subagents (the user's
  choice).
- **What comes back:** its last reply, cut at the size every tool's output is cut at.
- **Questions (the user's choice):** a read inside the project never asks. A read outside it asks
  in `ask` and `project` modes, as the lead's does, and the question names the subagent: "Allow t2
  (find the login code) to read C:\notes.txt?". In `never` mode nothing asks.
- **One line of questions, each with its owner.** The lead's questions and every subagent's wait in
  one line and are shown one at a time, so a second question can never replace the one on screen.
  Each question carries the lead's turn or the subagent that asked it, and that owner's stop signal:
  - **y, n or Esc** answer that question only.
  - **Ctrl-C** declines it and stops its owner only: the lead's turn for the lead's question, that
    subagent for a subagent's. Ctrl-C at a background subagent's question leaves the lead's turn
    running.
  - **When an owner stops** (Esc during a turn, `/tasks stop`, a failure), its questions are taken
    out of the line, the one on screen included, and answered as cancelled, and the next question
    shows.
- **Side by side:** several `delegate` calls in one reply start together. The reply's other tool
  calls still run one after another, as now.
- **How many at once:** a setting, `--max-tasks`, whose default, 8, comes from measuring (see
  "Before the build"). Past the limit, a subagent waits for a free place, and its row says
  "waiting".

## Background subagents

- **Starting one:** with `background: true`, `delegate` returns at once ("Started t3 in the
  background; its answer will come in a later message") and the lead goes on (the user's choice
  over always waiting).
- **Waiting answers, each delivered once.** A finished subagent's answer goes into a list of
  waiting answers. Each request the lead makes takes every answer then waiting, removing it from
  the list, and puts them after that request's tool results, as text: "Background task t3 (find
  the login code) finished:" and the answer. An answer is in exactly one request.
- **When the turn ends with answers waiting** (one finished during the lead's last request, whose
  reply had no tool calls and so no next request): going idle checks the list first, and a waiting
  answer starts a turn before any queued prompt.
- **Finishing while the lead is idle (the user's choice):** it starts a turn by itself, as Claude
  Code does with background tasks. The working line says "Reading t3's answer · 3s · … · Esc to
  stop" and a grey line says "t3 finished". Several waiting together go in one turn. Answers go
  before any queued prompts. This turn is a paid request the user did not type; Esc stops it like
  any other.
- **Finishing while a question or the model list is open:** the answer waits until it closes.
- **With `-p` (the user's choice):** `background: true` is taken as false. The `delegate` call waits
  for its answer, and the result says it ran in the foreground because `-p` has no later turn. So
  `-p` prints one answer and exits as now, with nothing left running and no answer lost.
- **A subagent that fails** reports that as its answer ("t3 failed: …"), so the lead knows. **One
  the user stops** does not wake the lead: a note that it was stopped goes with the next message.
- **Stopping (the user's choice):** Esc or Ctrl-C stops the turn and the subagents it is waiting
  for. Background subagents go on. `/exit` stops everything.
- **`/tasks`** lists the session's subagents: number, task, model, state, time, tokens, cost.
  `/tasks t3` prints that subagent's tool calls and answer in full below the conversation, as Ctrl+O
  does for the lead's last turn. `/tasks stop t3` stops one; `/tasks stop` stops all.
- **Costs:** a subagent's tokens and cost add to the status line's totals as they are spent,
  background ones included. The context figure stays the lead's alone.

## On screen

- **The task panel,** under the prompt (and under an open `/` or `@` menu), above the hint line. One
  row a subagent:
  `◐ t2 find the login code · claude-haiku-5-5 · 12s · ↓ 1.2k tokens · $0.01 · read_file src/auth/oauth.ts`.
  A running row ends with the subagent's latest tool call, written as release 3's compact tool lines
  are. A finished row's mark becomes ✓ (done), ✗ red (failed) or ⊘ grey (stopped), the tool line's
  marks.
- **Finished rows stay until the next turn the user starts,** as the tool line keeps its counts:
  no time limit with nothing to base it on. Running background rows stay while they run.
- **Space:** the panel gets rows after the prompt's cursor row and the hint line, before the queue.
  Running rows first; when not all fit, the last row says "+3 more" and `/tasks` lists the rest.
  Each row is one line, cut at the width.
- **The to-do list,** under the working line and above the queue and the prompt: `☐` to do, `◐`
  doing (yellow), `☑` done (grey). It shows while any item is unfinished and goes once all are done
  (the user's choice over hidden until asked). **Ctrl+T** hides or shows it; hidden lasts until
  Ctrl+T again or a new list. When short of space it shows the item in progress and those next to
  it, then "+N more". It gives way before the prompt does.
- **The status line** gains a `tasks` part, "2 running", shown while any subagent runs, and
  `--status` takes `tasks`.
- **Model text is made safe:** a task's text, an item's text and the paths in a row are cleaned as
  the rest of the model's text is (`visible()`), so none can move the cursor or rewrite the screen.
- **The key list** (`?`) gains Ctrl+T, and the help text `/tasks` and `--worker`.

## The to-do list

- **`todo(items)`, for the lead only:** the whole list each time, as Claude Code's `TodoWrite`
  takes it. Each item is its text and one of `pending`, `in_progress`, `done`. The tool's
  description asks for one item in progress at a time; nothing enforces it.
- The list belongs to the session. A new list replaces the old one.

## The search tools

For the lead and the subagents (the user's choice). Neither runs a program.

- **`find_files(pattern)`:** the files whose path matches a pattern such as `src/**/*.ts`, sorted by
  path.
- **`search_files(pattern, path, glob)`:** a regular expression over file contents, giving
  `path:line: text` lines. `path` narrows it to a folder or one file (the project by default),
  `glob` by name, as in `*.ts`. Binary files are skipped.
- **Skipped (the user's choice):** `.git`, and what the project's `.gitignore` files list, read with
  the `ignore` library. Not by running `git ls-files`: a repository's own settings can make git run
  programs, which is why release 3 reads the branch from `.git/HEAD`.
- **The same guards as `read_file`:** inside the project they never ask; a path outside asks, as a
  read outside does; Tachikoma's data folder and, on Linux, a program's environment are refused in
  every mode. The walk follows no links or junctions, so it cannot loop or be led out of the folder
  it was given.
- **Output** is cut at the size every tool's output is cut at, with a note of how many more there
  were.
- **A pattern that never finishes** (some regular expressions take practically forever on some
  text) runs in a worker thread, which Esc ends as it stops the turn.

## Instruction files

- **Read once, at the start of a session,** into the system prompt after Tachikoma's own lines,
  under a note that they come from the user's and the project's files and that later, more specific
  files win. A file edited during a session counts from the next: the system prompt never changes
  within one, since prompt caching and Anthropic's thinking blocks need it unchanged.
- **Which, broadest first:**
  1. The user's `~/.claude/CLAUDE.md`.
  2. The user's `~/.codex/AGENTS.md`, or `CODEX_HOME`'s.
  3. Each folder from the top of the drive down to the project folder (the user's choice, as
     Claude Code does): `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, then `AGENTS.md`. Both
     kinds are read where both exist (the user's choice: Tachikoma is neither tool, so neither file
     is favoured).
- Each file is labelled with its path. Empty files are skipped. A file reached twice, by a link or
  an import, is read once (by its real path).
- **`@path` imports (the user's choice):** expanded where they stand, up to four levels deep, as in
  Claude Code. Relative to the file they are in; `~` and absolute paths work. Not inside code blocks
  or code spans. One that leads nowhere stays as text.
- **Files that lead elsewhere ask first (the user's choice).** Everything read goes to the lead's
  provider, so a cloned project must not send `~/.aws/credentials` unasked, whether its
  `CLAUDE.md` imports that file or is itself a link to it.
  - **Trusted, never asked:** the user's own `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`, links
    or not, and the files they import, as Claude Code trusts user files.
  - **Asked, for every other file:**
    - **A found file** (in the project folder or a folder above it) whose real path, after
      following links, is outside the folder it was found in. `CLAUDE.md` linked to `AGENTS.md`
      beside it is not asked about; `CLAUDE.md` linked to a file in another folder is.
    - **An import** that leads outside the project folder, after following links.
  - In `ask` and `project` modes, one question at the start lists them all, each with the file that
    found or imported it: "Read 2 files from outside the project, reached by the instruction files?
    [y/n]". Declined ones are left out and the start line says so. In `never` mode they are read,
    as `read_file` reads outside then. With `-p` nobody can approve, so they are left out and a
    line on stderr names them.
- **Never Tachikoma's data folder or a program's environment,** for any instruction file, found or
  imported, after following links, in every mode: the same two refusals as the file tools
  (`resolveIn`). The data folder holds the saved ChatGPT login; on Linux, `/proc/<process>/environ`
  holds a program's API keys. Either would otherwise go to the provider with one line.
- **Shown:** at the start of an interactive session, a grey line lists the files read and their
  total size. With `-p`, nothing is printed.
- **Subagents** get the same instructions.
- **No size limit,** as in Claude Code; the start line's total shows a large one.
- **Instructions, not permissions:** a project's file can ask the model anything, and every approval
  still applies.

## When something goes wrong

- **A provider refuses a subagent's requests** (a rate limit, a sign-in that has run out): the
  subagent fails with the reason, the lead is told, and it goes in the error log like the lead's
  errors.
- **An instruction file cannot be read** (no permission, not text): it is left out, the start line
  says which and why, and the session starts.
- **`.gitignore` rules that do not parse:** the line is ignored, as git ignores it.
- **The lead asks for a subagent with no worker model it can use** (the lead was switched to a
  provider whose sign-in has gone): the `delegate` call fails with the reason, and the lead goes on.

## Before the build

Both are run by the user, in their terminal, as release 3's key probes were.
1. **How many subagents at once.** A short script starts 2, then 4, then 8 subagents on the worker
   model at the same moment and records, for each, whether the provider answered or refused and how
   long it took. `--max-tasks`'s default is the largest number with no refusals, and the design
   records the result and the account it was measured on. It spends a few cents.
2. **Ctrl+T:** whether it arrives as a key of its own in Windows Terminal with PowerShell 5.1. If it
   does not, another key is chosen then.

Results, 2026-10-26, in the user's terminal (Windows Terminal, PowerShell 5.1, Node 24.22.1):
1. **Eight at once, none refused,** on `anthropic:claude-haiku-5-5` and the user's API account.
   Each subagent read two of the project's files with read_file and answered: 2 at once took 3.4 s,
   4 took 10.8 s and 8 took 3.9 s, with no refusals in any round and $0.0069 in all. The account's
   limits, from Anthropic's headers, are 10,000 requests, 10M input tokens and 2M output tokens a
   minute; the round of eight used 16 requests and about 38,000 input tokens. **`--max-tasks`
   defaults to 8,** the largest number tried. It is the most tried, not a limit found: this account
   had room for far more, and an account with lower limits may see refusals sooner. The script
   (`tasksprobe.mjs`) and its results were kept outside the repository, as release 3's key probes
   were.
2. **Ctrl+T arrives** as the byte 0x14, which Ink reads as Ctrl+T. It stays the key.

## Testing

As in releases 2 and 3: Vitest, with no test contacting a real provider and no test reading the
user's own files.

- **Subagents** run on scripted fake models: waiting and background; answers mid-turn and while
  idle; several finishing together; answers before the queue; Esc stopping only the waited-on ones;
  `/tasks` and `/tasks stop`; questions naming the subagent and waiting in line; `--max-tasks`
  making the next one wait; costs adding to the totals while the context stays the lead's; a failed
  subagent's reason reaching the lead.
- **Each answer delivered once:** one finishing during the lead's final request (a reply with no
  tool calls) starts a turn when the lead goes idle, ahead of a queued prompt; one finishing at the
  moment the turn ends is in exactly one request; none is lost or sent twice.
- **Questions and their owners:** the lead's and two subagents' questions shown one at a time in
  order; Ctrl-C at a background subagent's question stops that subagent and not the lead's turn;
  `/tasks stop` on a subagent whose question is on screen, or waiting, takes it away and shows the
  next; Esc during a turn takes away the turn's questions only.
- **`-p`:** a background `delegate` waits for its answer, the result says so, one answer is
  printed, and the process exits with nothing still running.
- **The search tools,** in fresh temporary folders: `.gitignore` rules, links not followed, the data
  folder refused, a path outside asking, output cut with a note, binary files skipped, and a pattern
  that never finishes stopped by Esc.
- **Instruction files,** with a pretend home folder: the order, both kinds in one folder, each file
  once, imports to four levels and no further, an import loop, code blocks left alone, an import into
  the data folder refused, and an unreadable file left out with a note. A project file's import of a
  file outside the project, and a found `CLAUDE.md` or `AGENTS.md` that is a link to a file in
  another folder, each asked about once at the start: read when approved, left out when declined
  and with `-p`, read unasked in `never` mode; a found `CLAUDE.md` linked to the `AGENTS.md` beside
  it read unasked; the user's own files, and their imports, read unasked; an import or a found file
  reaching the data folder or (on Linux) a program's environment through a link refused in every
  mode, `never` included.
- **The screen,** on a fixed-size terminal: the panel's rows and marks, "+N more", the to-do list
  and Ctrl+T, the `tasks` part, and model text in all of them cleaned.
- **Then the user's terminal checklist,** after the last task.

## As built

Where the code differs from the design above, or settles what it left open, and why. The plan
(`2026-10-26-tachikoma-release-4.md`) lists every choice it makes, each marked in its task.

- **Node 22.20 or later.** `find_files` and `search_files`' `glob` use Node's own glob matching
  (`path.matchesGlob`), which Node marks stable from 22.20 and 24.8 and experimental before (Node's
  path docs, read 2026-10-26).
- **A name starting with a dot matches only a pattern that names the dot,** as in a shell and in
  Node's matching: `**/*.yml` misses `.github/workflows/ci.yml`. The tool's description says so.
- **Only `.gitignore` files are read,** not `.git/info/exclude` or git's global ignore file: the
  design names `.gitignore`, and reading git's settings for the global one would mean reading
  `.git/config`, which the model can write in `project` mode.
- **`TACHI_INSTRUCTIONS_TOP`** moves where the walk for instruction files starts, as
  `TACHI_DATA_DIR` moves the data folder, so the CLI's tests never read the user's files: every
  temporary folder on Windows is inside the user's profile, whose `.claude/CLAUDE.md` the walk from
  the top of the drive would find.
- **The search tools read the disk directly,** as `resolveIn` already does, not through the
  executor, which has no way to list a folder. The sandbox (release 6) must give them one.
- **The question about instruction files outside the project comes before the screen starts:** the
  files go into the system prompt, which is fixed before the first turn.
- **Two lines a subagent, under a short description,** after the user's first terminal run, where
  the long task the lead wrote filled the row. `delegate` takes a required `description` of a few
  words, shown in the panel, in `/tasks` and in the call's own line; the subagent is still sent the
  task. Under it come `⎿` and the model, time, tokens, cost and latest tool call, as Claude Code
  shows its agents. When not all fit, as many whole subagents are shown as leave a line for
  "+N more".
- **A pattern that is not a regular expression says why,** with JavaScript's own message, and for a
  flag inside it such as `(?i)`, which JavaScript does not have, how to match both cases. In the
  first run a subagent's `(?i)` was the session's one error.
- **"1 error",** not "1 errors", in the status line.
- **`--max-tasks` takes digits only:** `Number()` alone took `1e1`, ` 8 ` and `0x10`.

## The user's checklist

Run 2026-10-26 in the user's terminal (Windows Terminal, PowerShell 5.1), with
`anthropic:claude-haiku-5-5` as lead and worker, in two rounds: the last four changes under "As
built" came from the first, and the second ran on the changed build.
- **Passed:** the start line naming the instruction files read; a waited-on answer; two background
  subagents, each ending with "t1 finished" or "t2 finished" and a turn started by itself; the
  panel's two lines and "2 running"; finished rows turning to ✓; `/tasks` and `/tasks t1`; the
  to-do list and Ctrl+T; Esc stopping a turn; Ctrl-C twice quitting.
- **Not seen live:** "Reading t1's answer" on the working line, shown only while the lead reads the
  answer. A test shows it (`tests/tui/app.test.tsx`, "shows that turn as reading the answer").
- **`$0.00 + ?`** is right: Haiku 5.5 is left out of the price table, since its price changes above
  100K-token prompts, so its cost shows as unknown.

## Not in this release

- Subagents that edit or run commands, and CLI workers (`claude -p`, `codex exec`): release 10,
  with the budget controller, after the sandbox (release 6) gives each writer its own copy.
- Subagents starting subagents, and choosing the model for each task.
- Instruction files in subfolders, which Claude Code loads as it works there, and `.claude/rules/`:
  both need the system prompt to change during a session.
- A Tachikoma-only instruction file: with `tachi setup` and its first-run import (release 12).
