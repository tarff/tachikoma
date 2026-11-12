# Tachikoma background commands: Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to build this
> plan task by task: a fresh builder per task, then a spec review, then a code review.

**Goal:** a shell command can run in the background, as in Claude Code: the model starts one with
`background: true`, reads what is new with `shell_output`, stops it with `stop_task`, and is told
when it ends; a foreground command moves to the background at its timeout or when the user
presses Ctrl+B; `-p` waits for them after its answer.

**Architecture:**
- **The executors gain `start`,** beside today's `exec`: it starts a command and hands back a
  `Running` handle, whose output arrives as it is printed into a `CommandLog`, with `done` and
  `stop()`. `exec` becomes `start` plus the abort signal, so everything that calls `exec` today
  works as before.
- **A `CommandLog` (new, `src/exec/log.ts`)** keeps a command's newest 30,000 characters and the
  model's read position. Every delivery to the model, a `shell_output` read or an ending message,
  goes through one function that fits it under the session's cut and moves the position only over
  what it gave.
- **The task list (`src/core/tasks.ts`) takes a second kind, a command,** beside a subagent. Both
  share the ids (t1, t2, ...), the panel, `/tasks`, the inbox and the wake. A command's ending
  message is written when the inbox is taken, not when the command ends.
- **The shell tool is built with the task list,** as `delegate` is, together with the two new
  tools, `shell_output` and `stop_task`.
- **`-p`'s wait** after its answer is a function of its own in `src/clilib.ts`, so it can be
  tested in-process, with Ctrl-C, a hook's stop and a failed model call each ending it.

Design: `docs/plans/2026-11-13-tachikoma-background-commands-design.md`, with its two reviews'
fixes (e0b3c94).

**Tech stack:** as release 8c (TypeScript 7.0.2, Ink 7.1.1, React 19.3.0, Vitest 5.0.3,
ink-testing-library 4.0.0, zod 4.6.7, `@modelcontextprotocol/client` 2.4.0). No new package.

---

## Before you start

**How this plan is built.** As releases 8b and 8c, each task gives the files, the interfaces, the
behaviour and the tests, and each test says what it must show. A builder writes the tests first
and sees them fail, then writes the code, then commits. A spec reviewer and then a code reviewer
check the commit before the next task starts. The plan has four parts:
- **Part 1, running and reading (Tasks 1-3):** the command log, the local executor's `start`, the
  sandbox's `start`.
- **Part 2, the task list and the tools (Tasks 4-8):** commands in the task list, the shell tool,
  `shell_output` and `stop_task`, saved sessions, hooks.
- **Part 3, the window and `-p` (Tasks 9-11):** the panel and `/tasks`, Ctrl+B, `-p`'s wait.
- **Part 4, the documents and the terminal checklist (Task 12).**

**One stop for the user:** Task 12's checklist runs in the user's own terminal.

**The branch.** Build on the local branch `background-commands` (main b93441c plus the design,
head e0b3c94 or later). Do not push: every push needs the user's fresh say-so, and main takes
changes only by pull request, which needs CI's `test` check to pass.

**Checks, from the repo's folder:**
- Types: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
- One file: `node node_modules/vitest/vitest.mjs run tests/exec/log.test.ts`
- The App's tests, only with `-t`:
  `node node_modules/vitest/vitest.mjs run tests/tui/app.test.tsx -t "App's background commands"`.
  The file has over 500 cases; never run it whole for a task.
- Build: `npm run build`
- **The whole suite runs once at the end of each part, not after each task** (user, 2026-10-31).
  A builder runs the test files the task touches, plus any file that imports a module the task
  changed. Never run `tests/tui/external.test.ts`: it opens real programs.

Each test's limit is 15 s unless it sets its own (`vitest.config.ts`, PR #16, measured on CI).
A time-out on a busy machine is not a failure of this release if the file passes run alone. A
test that spawns Tachikoma pays the known `-p` start of about 7.5 s on this PC, so it sets its own
limit.

**Rules for every task:**
- **Tests first,** seen failing for the right reason, then the code. One commit per task, plus
  `fix:` commits for review findings.
- **Tests never touch the user's own things.** No test reads or writes the user's own files
  (settings, keys, history, data folder, git settings, `~/.claude`, `~/.claude.json`), runs the
  user's own hooks, contacts a provider, or uses the network beyond the machine's own address
  (`127.0.0.1`). A command a test runs is `node` (`process.execPath`) with a script the test
  writes into its own `mkdtemp` folder, never a program the user may not have.
  - Every test that saves sessions uses a data folder two levels inside a fresh `mkdtemp`
    folder, as release 8a's tests do.
  - **Every process a test starts, the test stops,** by its pid, in its own clean-up, even when
    it expects Tachikoma to have stopped it, so a failing test leaves nothing running.
- **Never change permissions** on any file or folder (no `icacls`, `chmod`, ACL calls), in a test
  or by hand.
- **Deletes:** code deletes only files Tachikoma named, never follows a link. A builder deletes
  only files they made, by exact name.
- **No package installs, and no fetch from any registry.** This plan needs none.
- **Windows tools whose switches start with `/`** run from PowerShell or Node, never Git Bash.
- **Match the code around you.** Use plain-language comments that say why, citing the design's
  section ("background commands design, \"With -p\"") or this plan's choice ("background
  commands plan, choice 6"). No comment restates the code. Code lines go up to 160 columns; prose
  in docs up to 100.
- **Every number in the code has its source in a comment:** Claude Code's docs, the design, or
  this plan's table "Numbers in this plan".
- **Every user-visible line is triggered for real in a test,** and its exact words checked. Its
  words are the ones in "Lines this plan adds", which the user approves with the plan.
- **A command's text reaching the screen** (the panel, `/tasks`, the arrival line, the waiting
  line) goes through `visible(...)` first, as every other command text on screen does.
- **Commit messages:** `feat: ...`, `fix: ...`, `docs: ...`, `test: ...`, `refactor: ...`, ending
  with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_011HyFwUUVRarEnjhRmMcKdH
  ```

**Facts the tasks rely on** (read 2026-11-13 by two read-only surveys of the code at b93441c;
from Claude Code's tools reference, interactive-mode, headless and hooks pages that day; and from
Claude Code's own `TaskStop` tool schema in a running session):

**The shell tool** (`src/tools/shell.ts`, 31 lines)
- `shellText(r)` (7-11): `exit code: <n>` or `killed by <signal>`, then `--- stderr ---`, then
  `--- stdout ---`; stderr first as "the session keeps only the start of a long result".
- `shellToolOf(shell)` (14-29): description `Run a command with ${shell} in the project root and
  return its output.`; schema `{ command: z.string().min(1) }` only (18).
- Gate (21): kind `shell`, `outside: false`, summary `run: <command>`, `command`; no `detail`.
  Then `ctx.executor.exec(command, ctx.root, ctx.signal)` (22), which waits for the end;
  `ctx.report?.({ stdout, stderr, code })` (23); a non-zero or null code throws `shellText(r)`.
- `shellTool = shellToolOf(shellFor().name)` (31) is in `TOOLS` (`src/tools/index.ts:6`); the
  sandbox makes `shellToolOf("bash")` (`src/clilib.ts:542`) and `cli.tsx:697` swaps it in.

**Tools** (`src/tools/tool.ts`): `ToolContext` (7-15) `{ root, executor, workspace, gate, signal?,
report? }`; `Tool` (17-23) `{ spec, run(input, ctx): Promise<string | {text, pictures}>,
parallel? }`; `InvalidInput` (32); `defineTool(name, description, schema, run)` (36-51) throws
`Invalid input for <name>: <zod's words>` on a bad input.

**The executors**
- `src/exec/executor.ts`: `MAX_TOOL_OUTPUT = 30_000` (3); `ExecResult { code: number | null;
  signal: NodeJS.Signals | null; stdout: string; stderr: string }` (5-10); `Executor { exec(command,
  cwd, signal?): Promise<ExecResult> }` (14-16), nothing else.
- `src/exec/local.ts`: `shellFor()` (12-32): PowerShell 5.1 with `-NoProfile -NonInteractive
  -Command` and its exit-code line on Windows, `/bin/sh -c` elsewhere. `killTree` (36-52):
  taskkill `/T /F` only while the shell is alive on Windows; `process.kill(-pid, "SIGKILL")`
  elsewhere. `running` (56) and its kill at `process.on("exit")` (57). `collect(stream, limit)`
  (62-72) keeps the head and adds `\n[cut: N more characters]`. `LocalExecutor.exec` (74-110):
  `spawn(..., { cwd, env: commandEnv(), windowsHide: true, detached: not win32, stdio: ["ignore",
  "pipe", "pipe"] })`; `running.add`; stdout and stderr collected apart, so their order is lost;
  an abort kills the tree, destroys the pipes and rejects `Cancelled` at once, without waiting
  for "close", as a grandchild may hold the pipes; the end is taken on `"close"`. Nothing is
  readable before the end.
- `src/sandbox/executor.ts`: `DockerExecutor.exec` (257-286) calls `inGroup(this.run, this.id,
  ["-w", cwd], "bash -c", command, { signal, cut: true })` (264), maps `cancelled` to `Cancelled`
  and `unreached` to `state.fail(...)`, and adds `(Stopped: the command used more than
  ${state.memoryLine()})` to stderr when the box's memory-kill count rose (281-284).
  `inGroup` (304-341): `setsid -w` makes the command's group in the box, its id written to
  `/tmp/tachikoma-<uuid>`; an abort runs `touch <group>.stop; kill -KILL -- -"$(cat <group>)"` in
  the box and returns `{ cancelled: true }`, or `{ unreached }` when Docker could not be reached;
  `opts` pass through to `DockerRun` (330). The kill depends on the aborting signal; nothing else
  holds the group's id.
- `src/sandbox/docker.ts`: `DockerRun` (16-19) `(args, opts?: { line?, input?, signal?, cut?,
  tree? })`; `cut` uses `collect` on each stream (46-47); `line` gives whole lines (only the image
  build uses it). Tests never write a fake `docker` program (docker.ts:1-3).

**The task list** (`src/core/tasks.ts`, 341 lines)
- `Task` (26-43): `id`, `description`, `task`, `model`, `background`, `state` (`waiting | running
  | done | failed | stopped`, 14), `started`, `ended?`, `output`, `cost`, `costUnknown`,
  `lastTool`, `answer?`, `shown`, `messages`, `done`.
- `Tasks` (71): `all` (72), `#inbox: { id; text; wake }[]` (73), `#stops` (79), `#next = 1` (80).
  `running` (111-113) counts running and waiting. `from(n)` (117-119). `start(task, { description?,
  background, signal? })` (122-134): id `t${this.#next++}` (124). `stop(id?)` (137-148) sets
  `byUser` and aborts, false when nothing ran. `wakes()` (151-153), `answering()` (156-158),
  `take()` (161-163) = `this.#inbox.splice(0).map((i) => i.text)`. `clearFinished` (165-168),
  `forgetFinished` (171-174). `#changed()` (338-340) emits the bus's `tasks`.
- `#run` (176-215) writes `{ t: "subagent", id, description, file }` to the lead's transcript
  first (185-186), inside `start`, so the line exists before delegate says "Started". Inbox texts
  (200-212), only for background tasks, `name = Background task ${id} (${description})`: finished
  (wake), failed (wake), stopped by a hook (wake), stopped by the user (no wake).
- `--max-tasks`: `#place` (306-324), `#release` (326-329); `start` never refuses, a task waits.

**Delegate** (`src/tools/delegate.ts`): built as `delegateTool(tasks, { headless })` (8); in a
window a background start returns `Started ${id} in the background; its answer will come in a
later message.` (14); under `-p` it runs in the foreground with the head `${id} ran in the
foreground, since -p has no later turn to read a background answer in.` (21).

**The session** (`src/core/session.ts`)
- `truncate` (38-40) cuts at `MAX_TOOL_OUTPUT` with `\n[cut: N more characters]`; every tool
  result goes through it (1063). `truncateLeaving(s, around)` (45-52) leaves room.
- `SessionOptions.tasks?: { from(n); all? }` (124), `inbox?: () => string[]` (129).
- The inbox is drained by `#waiting()` (1253-1255) into `{ type: "text", text, from: "tasks" }`
  parts: after the prompt (522), after a Stop hook's feedback (675), after a round's tool results
  (721). `send("")` with nothing waiting sends nothing (523).
- Stop's `background_tasks` (1169-1171): each background subagent running or waiting as `{ id,
  type: "agent", status: "running", description, agent_type: "Explore" }`.
- `load(c)` calls `tasks.from(c.nextTask)` (306).

**The saved session** (`src/core/transcript.ts`)
- `Line` (33-64): `subagent { id, description, file }` (54); `ended { state: failed | stopped |
  lost }` (55), written only in a subagent's own file. `valid()` (363-384) drops a line of an
  unknown kind as damaged, so a new kind is added there. `write` (101-111) appends one line.
- `readTranscript` (207-301): `nextTask` (267) counts subagent lines and subagent files only;
  `unfinished` (286) = subagents whose file is not `finished()` (440-451).
- `src/clilib.ts`: `resumed()` (796-855) reports each unfinished subagent once, `Subagent ${id}
  (${description}) had not finished when the session ended; its answer was lost.` (851), and
  `reported()` (809-814) writes `ended: lost` into its file. `headlessExit` (76-79): aborted 130,
  failed or declined 1, else 0. `exitOn` (240-247).

**The `-p` run** (`src/cli.tsx`)
- Tasks made at 681-693 with `ctx: { root, executor, workspace, gate }`; the lead's tools at
  696-700: `TOOLS` (shell swapped for the box's), `todoTool`, `delegateTool(tasks, { headless:
  !interactive })`.
- 744-824: `failed` is set by a bus `error` not in `harmless` (746-753); SIGINT is `process.once`
  aborting `stop` (783-784), so a second Ctrl-C gets Node's default; one `session.send` (791);
  `aborted` read at 794; the answer printed by `turnAnswer`/`headlessAnswer` (795-800); then
  `session.end`, `servers.stopAll`, copy mode, `hooks.stopAsync`, and `process.exitCode =
  headlessExit({ aborted, failed: failed || ended !== undefined, declined })` (824).
- **Node's default SIGINT ends the process without its `exit` handlers,** so `running`'s kill and
  the box's removal do not run on a second Ctrl-C today.

**The window**
- `/tasks` in `src/tui/app/queue.ts`: 131-134; `tasksCommand` (373-389) with `No subagent ${id}.
  /tasks lists them.`, `No subagents yet.`, `Subagents: ${n}`, `Stopped every subagent.`, `No
  subagent is running.`, `Stopped ${id}.`, `${id} is not running.`, and the usage line;
  `recordOf(t)` (479-483) is `/tasks t3`'s full-screen record.
- `/clear`, `/resume`, `/branch` refused while a subagent runs (152-154), `subagentsRunning`
  (623-626): `${command} waits until no subagent is running: ${ids} still running. /tasks stop
  stops them.`
- A wake: `next()` (78) submits an empty turn when `tasks.wakes()`; its label `Reading
  ${names(ui.tasks.answering())}` (173), `names` in `constants.ts:93` (`t3's answer`).
- The panel: `src/tui/TaskPanel.tsx` `taskRows` (29-36), two rows a task, `taskRow` (41-47):
  `<id> <description's first line>` then
  `⎿ <model> · <time> · ↓ <tokens> · <cost>[ · <tool>]`.
  Arrival line in App.tsx `onTasks` (348-357): `<id> finished` or `<id> <state>`.
- The live row: `src/tui/fold.ts` `OpenRun` (180); the shell branch of `start` (315-325): `●
  Running N shell command(s) · <time>` and `  ⎿  $ <command> (<time>)`.
- Keys: `src/tui/bindings.ts` `CONTEXTS` (7, no `Task`), `defaultsFor` (133-209), Global (136);
  Ctrl+B bound nowhere, not reserved (87). `src/keybindings.ts`: `task:background` is in
  `CLAUDE_CODE_ACTIONS` (42) and `Task` in `CLAUDE_CODE_CONTEXTS` (19), both skipped today
  (`tests/keybindings.test.ts:45, 63`). `constants.ts:150-169` maps actions to commands;
  `keyRouting.ts` `promptKey` (161-221) aborts a turn on Esc (199-203).

**Hooks** (`src/hooks/tools.ts`)
- Shell entry (64-72): `Bash`, `command` → `command`; extras `description: "label"`, `timeout:
  { never: "Tachikoma's shell has no time limit" }`, `run_in_background: { only: false, as:
  "Tachikoma's shell cannot run a command in the background" }`; their refusals pinned in
  `tests/hooks/tools.test.ts:214-216`. Kinds (54): `text | path | count | flag | todos`, no ranged
  number. No `TaskStop` mapping exists.
- `responseOf` (252-264): shell with string `stdout` and `stderr` parts gives `{ stdout, stderr,
  interrupted: false, isImage: false }`, else the text. `TEXT_RESULT` (276). `outputFrom`
  (282-293).

**Approval** (`src/core/permissions.ts`): the question shows `visible(action.summary)`; the judge
sees `{ kind, outside, summary, detail, command, protectedPart, description }`
(`src/safety/judge.ts:60, 64`), so "in the background" must be in `summary` for it to see it;
`dangers(action.command, ...)` (`src/safety/rules.ts:41`) checks the command.

**Tests and their helpers:** `tests/helpers.ts` (`FakeProvider`, `Held`, `reply`, `callTool`,
`tempContext` with a real `LocalExecutor`); no shared fake executor (inline ones at
`tests/tui/app.test.tsx:1922` `noShell` and `2336` `heldShell`); `fakeDocker` in
`tests/sandbox/executor.test.ts:27-38`; `tests/core/tasks.test.ts` `setup` (23);
`tests/core/transcript.test.ts` nextTask (115, 453-463), unfinished (465-497);
`tests/cli.test.ts` `tachiLater` (38-51) with an OpenAI-shaped stand-in server per test; the App's
`mount` (`tests/tui/app.test.tsx:130`), "App's background subagents" (1687).
**On Windows, Node's `process.kill(pid, "SIGINT")` ends a process unconditionally,** so no test can
send a spawned Tachikoma a Ctrl-C there; `-p`'s Ctrl-C is tested in-process (Task 11).

**Claude Code's docs and tools** (read 2026-11-13)
- Tools reference, "Timeout and output limits": `timeout` default two minutes, ceiling ten,
  "the ceiling that caps whatever Claude requests". "Time limit for background commands": only in
  unattended sessions such as `-p`; "A local session you work in from a terminal ... has no time
  limit"; a background start gets 30 minutes or its `timeout` up to 2 hours, a moved command 30
  minutes from the move; "In a run with the `-p` flag whose prompt you pass as text ... both
  defaults are 10 minutes instead of 30"; the stop notice `Background command "<description>" was
  stopped after reaching its background time limit`. "Foreground commands that move to the
  background": "unless the command starts with `sleep`"; `Command did not complete within its
  120s timeout and was moved to the background`.
- Interactive mode: background tasks stop at exit; the full clean-up of detached processes is
  promised "On macOS and Linux" only.
- Hooks reference, Stop input: a `background_tasks` entry is `{ id, type, status, description,
  command }` for a shell task, `type` `shell`, `description` "capped at 1000 characters with an
  in-string `… [+N chars]` marker when clipped", `command` "capped at 1000 characters". The page
  gives no `tool_response` for a background start and never names `backgroundTaskId`.
- `TaskStop`'s schema in a running Claude Code: `{ task_id?: string, shell_id?: string }`,
  `shell_id` "Deprecated: use task_id instead".

## Numbers in this plan

| Number | What | Source |
|---|---|---|
| 120,000 ms | a foreground command's `timeout` when none is given | Claude Code's tools reference, "two minutes out of the box" |
| 600,000 ms | the most a foreground `timeout` can be; more is cut to it | the same, "ten minutes out of the box" |
| 7,200,000 ms | the most `timeout` can be at all, and a `-p` background limit's most | the same, "up to a maximum of 2 hours" |
| 600,000 ms | under `-p`, a background start's limit with no `timeout`, and a moved command's limit from the move | the same, a `-p` run given its prompt as text: "both defaults are 10 minutes" |
| 30,000 characters | what a command's log keeps, and the session's cut | `MAX_TOOL_OUTPUT`, Claude Code's own (`executor.ts:3`) |
| 5 s | how long `-p` waits before its waiting line | Claude Code's headless page, "Background tasks at exit" (design, "With -p") |
| 1,000 characters | Stop's `background_tasks` `description` and `command` cut; also the command in a delivery's first line (choice 24) | Claude Code's hooks reference, Stop input |

## Choices this plan makes that the design leaves open

Each is marked in its task. The user approves them with the plan.

**Running and reading**
1. **`Running` and `start`** (Task 2): `Executor` gains `start(command, cwd): Running`, `Running
   = { log: CommandLog; done: Promise<ExecResult>; stop(): void }`. `stop()` kills the tree as an
   abort does today and settles `done` at once with `{ code: null, signal: "SIGKILL", ... }`,
   without waiting for the pipes. `exec` becomes `start` plus its signal, rejecting `Cancelled` as
   today, so `exec`'s callers and tests are unchanged.
2. **Two records of the output** (Task 2): the log gets both streams in the order they arrive,
   the newest 30,000 characters, for a background command; `done`'s `stdout` and `stderr` stay as
   today (each its first 30,000, apart), for a command that runs to its end in the foreground, so
   its result and its hooks' `stdout`/`stderr` do not change.
3. **The box streams through a new `DockerRun` option, `data(text)`** (Task 3), given every piece
   of both streams as it arrives, decoded as UTF-8 per stream. `DockerExecutor.start` holds its own
   abort controller, which `stop()` aborts, so `inGroup`'s kill in the box runs as for Esc. The
   memory-limit line goes into the log too, so an ending's message carries it.
4. **The read position and the fit** (Task 1): one function, `deliver(head, log, id)`, builds
   every delivery: its first line, the dropped note when output was dropped before the position, the
   oldest unread output that fits, and the more note when some is left. Its room is
   `MAX_TOOL_OUTPUT` less the head and both notes written with the largest numbers the log can
   give, so no delivery is ever longer than 30,000.

**The task list**
5. **A command is a task of its own kind** (Task 4): `Task` becomes a union, `SubagentTask`
   (today's fields, plus `kind: "subagent"`) and `CommandTask` (`kind: "command"`, `id`,
   `command`, `background: true`, `state`, `started`, `ended?`, `shown`, `code?`, `signal?`,
   `run: Running`, `done`). A command's state is `running`, then `done` for exit code 0, `failed`
   for any other end, `stopped` when stopped. Commands never take a place under `--max-tasks`.
6. **`tasks.adopt(run, { command, moved? })`** (Task 4) puts a started or moved command in the
   list: it takes the next id, writes the saved session's `command` line before returning, and
   watches `done`. Foreground commands get no id unless they move.
7. **An ending's inbox entry is written when `take()` runs** (Task 4): the entry holds a function,
   not a text. `shell_output` on an ended command calls `tasks.told(id)`, which removes that entry,
   so the exit code never reaches the model twice. A stop by the user or by `stop_task` adds a
   no-wake entry, said once at the next turn, as a stopped subagent's is.
8. **The `-p` time limit lives in the task list** (Task 4): `Tasks` takes `limits?: { started:
   number; moved: number; most: number }`, given only under `-p`. A timer per command stops it at
   its limit and adds a waking entry with the design's line, then its unread output.
9. **The foreground command Ctrl+B can move** is held by the task list (Task 4): the shell tool
   registers `tasks.holding = { move(): void }` while a foreground command runs, and clears it at
   the end; `tasks.moveForeground()` calls it. One at a time is enough: the shell tool is not
   `parallel`, so a turn runs one shell command at a time.

**The tools**
10. **The shell tool, `shell_output` and `stop_task` are built together** by `shellTools(tasks, {
    shell, headless })` in a new file, `src/tools/commands.ts` (Task 5), as `delegateTool(tasks,
    ...)` is. `shellTool` leaves `TOOLS`; the sandbox no longer makes its own (`clilib.ts:542`),
    as the shell's name is the only difference (`bash` in the box).
11. **`timeout` in the schema** is `z.number().int().min(1).max(7_200_000).optional()` (Task 5).
    How each mode reads it is the design's (review): cut to 600,000 in the foreground; nothing for
    a window's background start; the `-p` limit, at most 7,200,000.
12. **The `sleep` rule** (Task 5): a command whose first word is `sleep` (any shell) or
    `Start-Sleep` (any letter case, PowerShell's) is stopped at its timeout, not moved. The first
    word is read after leading spaces, up to a space or `;`.
13. **A background start's question** says it (Task 5): the action's `summary` is `run in the
    background: <command>`, so the user, the judge and auto mode see it; the dangerous-command
    check reads `command` as today.
14. **`shell_output` on a subagent's id** answers that it is a subagent's (Task 6); on an id that
    is not in the list, that there is no such task.

**Saved sessions**
15. **Two new line kinds** (Task 7): `{ t: "command", id, command }` when a command enters the list
    and `{ t: "command-ended", id, state: "done" | "failed" | "stopped" | "lost" }` when it ends.
    `nextTask` counts `command` lines; `unfinished` gains the commands with no `command-ended`
    line, and `reported()` writes `command-ended` with `lost` into the transcript the resumed
    session writes to, so it is reported once.

**Hooks**
16. **The shell's two extras become fields** (Task 8): `background` ↔ `run_in_background` (kind
    `flag`), `timeout` ↔ `timeout` (a new kind, `ms`: a whole number from 1 to 7,200,000).
    `stop_task` is `TaskStop` with `id` ↔ `task_id`; `shell_id`, deprecated, is not taken.
    `shell_output` goes to hooks under its own name. A background start and a moved command give
    hooks their text (design, "Approval and hooks"); both new tools join `TEXT_RESULT`.
17. **Stop's `background_tasks`** gains each running command as Claude Code's shell task (Task 8):
    `{ id, type: "shell", status: "running", description, command }`, `description` the command
    cut at 1,000 with `… [+N chars]`, `command` cut at 1,000; Tachikoma has no separate
    description for a command.

**The window and `-p`**
18. **`/tasks` lists both kinds** under one heading, `Tasks: <n>`, and its other lines name both
    (Task 9). A command's panel rows are `<id> <command's first line>` and `⎿ shell · <time>`,
    `⎿ shell · exit code <n> · <time>` once ended.
19. **The wake's label** names a command's output (Task 9): `Reading t4's output`; with both kinds,
    `Reading t3's answer and t4's output`.
20. **Ctrl+B is Claude Code's `task:background` in a new `Task` context** (Task 10), in force only
    while a foreground shell command runs, so Ctrl+B is free otherwise. `Task` and
    `task:background` leave the keys file's skipped lists.
21. **`-p`'s wait is `waitForBackground(...)` in `src/clilib.ts`** (Task 11), tested in-process.
22. **A second Ctrl-C under `-p` calls `process.exit(130)`** (Task 11) instead of Node's default,
    so the exit handlers run and stop every background command and the box (design, "How the
    wait ends": "the exit handler still stops the commands"). The code stays 130.

**After the plan's review (2026-11-13)**
23. **A command whose `done` rejects** (Docker unreachable, a spawn error) ends `failed` (Task 4):
    its timer is cleared, `command-ended` with `failed` is written, and a waking entry tells the
    model, `Background command <id> (<command>) failed: <error>`, then its unread output under the
    fit. The rejection is always handled, so none goes unhandled.
24. **The command in every delivery's first line is cut to 1,000 characters** with `… [+N chars]`
    (Tasks 1, 4, 6), the cut Claude Code gives a command it shows a hook (Stop's
    `background_tasks`), so the id and the state always fit and output always has room. The same
    cut serves choice 17.
25. **`waitForBackground` reads every turn's result** (Task 11): each `session.send` result is
    checked, and the first that ended the run (a hook's `continue: false`, a blocked prompt) stops
    the loop and is returned, so the CLI's exit code takes it as it takes the first turn's.

## Lines this plan adds

The user approves these words with the plan. Each is checked word for word in a test. `<id>` is a
task's id, `<command>` the command as given, escaped on screen.

| Where | Line |
|---|---|
| `shell`'s description (to the model) | `Run a command with <shell> in the project root and return its output. A command still running after "timeout" milliseconds (120000 when not given, at most 600000) moves to the background, unless it starts with sleep. With "background": true it starts in the background at once, for a dev server, a watch build or a long test run; read its output with shell_output and stop it with stop_task. You are told when a background command ends.` |
| A background start (to the model, design) | `Started <id> in the background.` |
| A move at the timeout (to the model, design) | `Command did not complete within its <n>s timeout and was moved to the background as <id>.` |
| A move by Ctrl+B (to the model, design) | `Moved to the background as <id> by the user.` |
| A `sleep` command at its timeout (to the model, an error) | `Stopped: the command did not complete within its <n>s timeout. A command that starts with sleep is stopped at its timeout, not moved to the background.` |
| The question for a background start | `run in the background: <command>` |
| `shell_output`'s description | `Read what a background command has printed since you last read it, and whether it has ended. Give its id, such as t4.` |
| `shell_output`'s first line | `<id> is still running.` / `<id> ended with exit code <n>.` / `<id> was killed by <signal>.` / `<id> was stopped by the user.` / `<id> was stopped by stop_task.` (choice 28) / `<id> failed: <error>` (As built, Task 6) / `<id> was stopped after reaching its background time limit.` |
| No new output (after the first line) | `No new output.` |
| The dropped note | `[<n> earlier characters were dropped]` (design) |
| The more note | `[<n> more characters: shell_output <id> gives them]` (design) |
| `shell_output` on a subagent | `<id> is a subagent, not a command; its answer comes in a message.` |
| No such task (`shell_output`, `stop_task`) | `No task <id>.` |
| `stop_task`'s description | `Stop a background command or a background subagent by its id, such as t4.` |
| `stop_task`'s answers | `Stopped <id>.` / `<id> is not running.` |
| An ending (to the model, design) | `Background command <id> (<command>) ended with exit code <n>:` then the unread output; with none, `Background command <id> (<command>) ended with exit code <n>, with no new output.`; killed: `... was killed by <signal>:` |
| A command's run failed (to the model, choice 23) | `Background command <id> (<command>) failed: <error>` then the unread output |
| A long command in a first line (choice 24) | its first 1,000 characters, then `… [+<n> chars]` |
| Stopped (to the model, at the next turn) | `Background command <id> (<command>) was stopped by the user.` / `Background command <id> (<command>) was stopped by stop_task.` |
| The `-p` limit (to the model, design) | `Background command "<command>" was stopped after reaching its background time limit` then the unread output |
| Resume (to the model, once, as a lost subagent's; As built, Task 7) | `Command <id> (<command>) had not ended when the session ended; it is not running in this session.` (design) |
| Hook rewrite of `timeout` | `"timeout" must be a whole number of milliseconds from 1 to 7200000` |
| `/tasks` heading | `Tasks: <n>` |
| `/tasks` with none | `No subagents or commands yet.` |
| `/tasks <id>` unknown | `No task <id>. /tasks lists them.` |
| `/tasks stop` | `Stopped every subagent and command.` / `No subagent or command is running.` |
| A command's panel rows | `<id> <command's first line>` and `⎿ shell · <time>`; ended `⎿ shell · exit code <n> · <time>` |
| `/tasks <id>`'s record for a command | `<id> (<command>), <state>: shell command`; once ended, `shell_output`'s first line; the dropped note when output was dropped; then the output kept, or `(no output yet)`, `(no output)` once ended (choice 31) |
| The wake's label (choice 19) | `Reading <id>'s output`; mixed `Reading <ids>'s answer(s) and <ids>'s output` |
| `/clear`, `/resume`, `/branch` refused | `<command> waits until no subagent or command is running: <ids> still running. /tasks stop stops them.` |
| The live shell row's hint | ` (<key> to run in background)` after the command, `<key>` the bound key, as `ctrl+b` (design) |
| `-p`'s waiting line (stderr, a terminal only, after 5 s, design) | `Waiting for background work to finish: <id> (<command>)`, several joined by `, ` |
| The `/tasks` menu note | `List subagents and background commands; /tasks t1 shows one, /tasks stop stops them` |
| `--help`'s `/tasks` line | `/tasks lists subagents and background commands (/tasks t1 shows one, /tasks stop stops them)` |

## Task 1: The command log and the fit

**Files:** create `src/exec/log.ts`, `tests/exec/log.test.ts`.

```ts
export class CommandLog {
  constructor(keep?: number);           // MAX_TOOL_OUTPUT when not given (choice 4)
  add(text: string): void;              // keeps the newest `keep` characters
  get total(): number;                  // characters ever added
  kept(): string;                       // the user's view (/tasks): what is kept, read or not
  unread(): number;                     // characters past the position, kept or dropped
}
// Every delivery to the model: `head`, then the dropped note if any, the oldest unread output
// that fits, the more note if any. Moves the position only over what it gave (choice 4).
export function deliver(head: string, log: CommandLog, id: string): string;
```

**Behaviour** (design, "What the model gets", both reviews):
- The position counts characters ever added. Output before the oldest kept character is dropped;
  a read past dropped output starts with `[<n> earlier characters were dropped]` and moves the
  position to the oldest kept character first.
- `deliver` takes room for `head`, a newline, both notes written with `log.total`'s number of
  digits, then gives what fits. When more is unread it ends `[<n> more characters: shell_output
  <id> gives them]`, and the next delivery starts there. With nothing unread it gives the head and
  `No new output.`
- `kept()` never moves the position.
- `headCommand(command)` (choice 24) gives the command as a first line carries it: its first 1,000
  characters, then `… [+<n> chars]`. Every head that names a command uses it.

**Tests:** a 40,000-character command in the head: the delivery is at most 30,000, keeps the id
and the state, and gives output; add and keep the newest 30,000; read since the last read; a
read after a drop gives the dropped note and the right count; a full log with a long head: the
delivery is at most 30,000, it ends with the more note, the next delivery starts where it stopped, and the last character added
arrives on one of them, never twice; `kept()` between two reads changes neither; with nothing new,
`No new output.`

Commit: `feat: a command's log: its newest 30,000 characters and the model's read position`.

## Task 2: The local executor starts a command and streams it

**Files:** modify `src/exec/executor.ts`, `src/exec/local.ts`; tests in `tests/exec/local.test.ts`.

```ts
export interface Running { log: CommandLog; done: Promise<ExecResult>; stop(): void }
export interface Executor {
  exec(command: string, cwd: string, signal?: AbortSignal): Promise<ExecResult>;
  start(command: string, cwd: string): Running;   // choice 1
}
```

**Behaviour** (choices 1, 2):
- `start` spawns as `exec` does today (same options, `running.add`). Each stream's data goes to
  the log as it arrives, decoded per stream, and also to its own head-kept collector, so `done`
  gives today's `stdout` and `stderr`.
- `stop()` kills the tree (`killTree`), destroys the pipes, takes the child out of `running`, and
  settles `done` at once with `{ code: null, signal: "SIGKILL", stdout, stderr }`. A second
  `stop()` does nothing.
- A spawn error (the child's `error` event) rejects `done`, as it rejects `exec` today; Task 4
  handles it (choice 23).
- `exec(command, cwd, signal)` is `start` plus the signal: an abort calls `stop()` and rejects
  `Cancelled`, as today.
- Every other `Executor` in `src/` and in the tests gets a `start` (a test's stand-in may throw
  `start is not used here`).

**Tests:** the existing `local.test.ts` cases pass unchanged; a script printing `a` to stdout,
then `b` to stderr, then `c` to stdout, with a pause between, gives `abc` in the log in that order
and today's `stdout`/`stderr` in `done`; the log has output before the end; `stop()` kills a
grandchild (as "cancel kills the grandchild", 37-50) and settles `done` while the grandchild holds
the pipes; **Windows only, the known limit** (design, "Exit"): a command that starts a node script
with `Start-Process` and returns, then `stop()`: the script is still alive (the test checks its
pid, then kills it itself).

Commit: `feat: the local executor starts a command and streams its output into a log`.

## Task 3: The sandbox starts a command and streams it

**Files:** modify `src/sandbox/docker.ts`, `src/sandbox/executor.ts`; tests in
`tests/sandbox/executor.test.ts` (and `tests/sandbox/docker.test.ts` for `data`).

**Behaviour** (choice 3; design, "The sandbox"):
- `DockerRun`'s options gain `data?: (text: string) => void`; the real run calls it with each
  piece of stdout and stderr as it arrives, decoded per stream, beside `cut`'s collectors.
- `inGroup`'s options gain `data`, passed through.
- `DockerExecutor.start(command, cwd)`: the same checks as `exec` (a broken box throws), then
  `inGroup(...)` with its own controller's signal, `cut: true` and `data` into the log. `stop()`
  aborts the controller, so the group is killed in the box; `done` then resolves `{ code: null,
  signal: "SIGKILL", ... }`. `unreached` rejects `done` with `state.fail(...)`'s error, as `exec`
  throws it. The memory-limit line is added to `stderr` as today and to the log.
- `exec` becomes `start` plus its signal, as in Task 2.

**Tests** (with `fakeDocker`, never real Docker): `data` pieces land in the log in order; the
exec arguments are today's (`["exec", "-w", cwd, "b0x", "bash", "-c", <wrapper>, "_", cmd]`);
`stop()` runs the group kill in the box and settles `done`; the memory line reaches the log; the
existing cases pass unchanged.

Commit: `feat: the sandbox starts a command and streams its output into a log`.

## Task 4: Commands in the task list

**Files:** modify `src/core/tasks.ts`, and every user of `Task` the type check names (the panel,
`/tasks`, the session's Stop hook, App's arrival line: each keeps its subagent behaviour here;
Tasks 8 and 9 add the command's); tests in `tests/core/tasks.test.ts`.

```ts
export type Task = SubagentTask | CommandTask;     // choice 5
export class Tasks {
  constructor(opts: TasksOptions & { limits?: { started: number; moved: number; most: number } }); // choice 8
  adopt(run: Running, opts: { command: string; moved?: boolean; limit?: number }): CommandTask;   // choice 6
  holding?: { move(): void };                       // choice 9
  moveForeground(): boolean;                        // false when no foreground command runs
  told(id: string): void;                           // choice 7
  get(id: string): Task | undefined;
  stop(id?: string, by?: "user" | "tool"): boolean; // commands too
}
```

**Behaviour:**
- `adopt` takes the next id from the shared counter, writes `{ t: "command", id, command }` to the
  lead's transcript before returning (Task 7 adds the kind), and watches `run.done`.
- At the end: state from the code (choice 5); `{ t: "command-ended", id, state }` written; a
  waking inbox entry whose text is made when `take()` runs: `deliver("Background command <id>
  (<command>) ended with exit code <n>:", ...)`, or `was killed by <signal>:`. If `told(id)` ran
  first, the entry is gone.
- **When `done` rejects** (choice 23): state `failed`, the timer cleared, `command-ended` with
  `failed` written, and a waking entry `Background command <id> (<command>) failed: <error>` with
  the unread output under the fit. The command in every head goes through `headCommand` (choice
  24).
- `stop(id)` on a command calls `run.stop()`, sets `stopped`, and adds a no-wake entry: `was
  stopped by the user.` (`by` `user`, the default: `/tasks stop`) or `was stopped by stop_task.`
  (`by` `tool`). `stop()` with no id stops every subagent and every command.
- **The `-p` limit** (choice 8): with `limits`, a started command's timer is its `limit` (from
  `timeout`, at most `most`) or `started`; a moved one's is `moved`. At the limit: `run.stop()`,
  state `stopped`, a waking entry `Background command "<command>" was stopped after reaching its
  background time limit` with its unread output under the fit. Without `limits`, no timer.
- `running` counts commands too; `#place` never sees them, so `--max-tasks` counts only
  subagents.
- `wakes()` and `answering()` include waking command entries; `take()` renders them.

**Tests:** ids shared with subagents (`t1` subagent, `t2` command, `t3` subagent); the `command`
line written before `adopt` returns; an ending's entry wakes and holds the output since the last
read; `told` removes it; a read after the end and before `take()` gives the output once in all;
`stop` by the user and by the tool: each line, no wake, once; a `done` that rejects: state
`failed`, its line and output, the `command-ended` line, its `-p` timer cleared (fake timers: no
later limit line), and no unhandled rejection; `stop()` stops both kinds; the limit
with fake timers: a start without `timeout` stops at 600,000 ms, one with 7,200,000 at that, a
moved one at 600,000 from the move, each with its line; no limit without `limits`; eight running
subagents and a command: the command is not held back.

Commit: `feat: background commands join the task list, with shared ids, the inbox and the -p limit`.

## Task 5: The shell tool runs in the background

**Files:** create `src/tools/commands.ts`; modify `src/tools/shell.ts` (keeps `shellText`),
`src/tools/index.ts`, `src/cli.tsx` (build the three tools after `tasks`), `src/clilib.ts` (the
box no longer makes a shell tool); tests in `tests/tools/commands.test.ts` and
`tests/tools/shell.test.ts`.

```ts
export function shellTools(tasks: Tasks, opts: { shell: string; headless: boolean }): Tool[]; // choice 10
```

**Behaviour** (design, "What the model gets", "A command that runs long"; choices 11-13):
- Schema `{ command, background?: boolean, timeout? }` (choice 11); the description from "Lines".
- **Background:** the gate with `summary: run in the background: <command>`; `ctx.executor.start`;
  `tasks.adopt(run, { command, limit: headless ? timeout : undefined })`; returns `Started <id> in
  the background.` A window's background start ignores `timeout`.
- **Foreground:** the gate as today; `start`; `tasks.holding` set to move it; then the first of:
  - the end: `ctx.report` and the result as today (`shellText`, a non-zero code throws);
  - Esc (`ctx.signal`): `run.stop()`, throw `Cancelled`;
  - the timeout, `min(timeout ?? 120_000, 600_000)`: a `sleep` command (choice 12) is stopped
    and throws its line; any other is adopted with `moved: true` and returns the move's line;
  - Ctrl+B (`tasks.moveForeground()`): adopted with `moved: true`, returns `Moved to the
    background as <id> by the user.`
  `tasks.holding` is cleared on every way out. The `<n>` in the timeout's line is the timeout
  that applied, in whole seconds.
- What was printed before a move is in the log, so the first `shell_output` gives it.

**Tests** (a stand-in executor whose `start` gives a `Running` the test drives, plus one real
`LocalExecutor` case): a background start's question, id and answer; a window's background start
with `timeout` gets no timer; a foreground end as today, its report unchanged; a 700,000 ms
`timeout` cut to 600,000 (fake timers), its line saying `600s`; a move at the default 120 s with
its line; `sleep 5` and `Start-Sleep 5` and `start-sleep -s 5` stopped at their timeout with the
`sleep` line, `sleeper` moved; Ctrl+B through `moveForeground()`; Esc stops it and nothing is
adopted; the first `shell_output` after a move gives what came before; `timeout: 0`, `1.5` and
`7200001` refused as invalid input; the danger check sees the command of a background start.

Commit: `feat: the shell tool starts commands in the background and moves long ones there`.

## Task 6: `shell_output` and `stop_task`

**Files:** modify `src/tools/commands.ts`; tests in `tests/tools/commands.test.ts`.

**Behaviour** (design, "What the model gets"; choices 7, 14):
- `shell_output {id}`: no question (design). For a command, `deliver(<first line>, log, id)`,
  the first lines from "Lines"; on an ended command it also calls `tasks.told(id)`. For a subagent,
  and for an id not in the list, their lines.
- `stop_task {id}`: no question. A running command or subagent is stopped with `by: "tool"`:
  `Stopped <id>.`; an ended one, `<id> is not running.`; no such id, `No task <id>.`
- Both are `parallel: false`.

**Tests:** each line triggered for real; two reads give each piece once; a read after the end
gives the exit line and the rest, then the inbox has no ending for it; `stop_task` on a command
and on a background subagent; the stopped command's next-turn line is `was stopped by stop_task.`

Commit: `feat: shell_output reads a background command, stop_task stops one`.

## Task 7: Saved sessions keep the commands' ids

**Files:** modify `src/core/transcript.ts`, `src/clilib.ts` (`resumed`, `reported`); tests in
`tests/core/transcript.test.ts`, `tests/clilib.test.ts`.

**Behaviour** (design, "Resume"; choice 15):
- `Line` gains `command { id, command }` and `command-ended { id, state }`; `valid()` checks both.
- `nextTask` counts `command` lines' ids beside subagents'.
- `unfinished` gains each command with no `command-ended` line, with `kind: "command"`.
- `resumed()` reports each once, with the resume line from "Lines", and `reported()` writes `{ t:
  "command-ended", id, state: "lost" }` to the resumed session's transcript. A builder first reads
  how `--fork-session` and `/branch` start their file (8a, `resumed`, `WindowSessions`) and tests
  that a command reported in a fork is reported once there too.

**Tests:** a transcript with subagent `t1` and command `t2`: the next id is `t3`; a resumed session
whose history holds `Started t2 in the background.`: `stop_task t2` answers `No task t2.`; an
unfinished command reported once, then not again on a second resume; a damaged `command` line
(no id) is dropped as other damaged lines are; a fork.

Commit: `feat: saved sessions keep background commands' ids and report one that had not ended`.

## Task 8: Hooks

**Files:** modify `src/hooks/tools.ts`, `src/core/session.ts` (Stop's `background_tasks`); tests
in `tests/hooks/tools.test.ts`, `tests/core/session.test.ts`.

**Behaviour** (design, "Approval and hooks"; choices 16, 17):
- The shell entry: `background` ↔ `run_in_background` (`flag`), `timeout` ↔ `timeout` (new kind
  `ms`, refused outside 1 to 7,200,000 with its line); `description` stays a label. The two
  pinned refusals (`tests/hooks/tools.test.ts:214-216`) go; a rewrite that sets either field is
  taken, and goes through Task 5's rules.
- `stop_task` ↔ `TaskStop`, `id` ↔ `task_id`. `shell_output` under its own name. Both in
  `TEXT_RESULT`.
- A background start and a move report no parts, so `responseOf` gives hooks their text; a
  command that ran to its end keeps today's shape.
- Stop's `background_tasks` adds each running command (choice 17).

**Tests:** `toClaude` of a background call gives `run_in_background: true` and `timeout`; a
rewrite adding `run_in_background: true` starts it in the background; `timeout: 0` and
`7200001` refused with the line; `TaskStop` with `task_id` maps to `stop_task`, `shell_id` is
refused as a field Tachikoma cannot take; PostToolUse for a background start gets the text;
Stop's entry for a command, and a 1,200-character command cut with `… [+200 chars]`.

Commit: `feat: hooks see background commands as Claude Code's Bash and TaskStop`.

## Task 9: The panel, `/tasks` and the waits

**Files:** modify `src/tui/TaskPanel.tsx`, `src/tui/app/queue.ts`, `src/tui/app/constants.ts`
(`names`), `src/tui/App.tsx` (arrival line), `src/tui/menus.ts`, `src/cli.tsx` (`--help`); tests
in `tests/tui/app.test.tsx` under a new `describe("App's background commands")`, and the
existing "App's background subagents" and sessions cases whose words change.

**Behaviour** (design, "Where they show and how they stop"; choices 18, 19):
- The panel's rows and `/tasks`' list for a command (choice 18); the arrival line as a
  subagent's (`t4 finished`, `t4 failed`, `t4 stopped`).
- `/tasks <id>` for a command: its record in full screen and in the normal view, from "Lines",
  with `log.kept()`, never moving the position.
- `/tasks stop <id>` and `/tasks stop` stop commands too, with the user's stop line next turn.
- `/clear`, `/resume`, `/branch` refused while a command runs (design, confirmed), with the new
  line.
- The wake's label (choice 19).
- Esc leaves background commands running (design); exit by `/exit`, Ctrl-C twice or Ctrl-D stops
  them (`leave()` and the unmount already call `tasks.stop()`).

**Tests:** each line triggered for real: the panel rows running and ended; `/tasks`, `/tasks t2`,
`/tasks t9`, `/tasks stop t2`, `/tasks stop`; the arrival line; an idle wake starts a turn with
`Reading t2's output` and the model gets the ending once; a wake with a subagent and a command;
Esc during a turn leaves a background command running; `/exit` stops it; `/clear` refused, then
taken once it is stopped.

Commit: `feat: background commands in the panel and /tasks; /clear waits for them`.

## Task 10: Ctrl+B and the live row's hint

**Files:** modify `src/tui/bindings.ts`, `src/keybindings.ts`, `src/tui/app/keyRouting.ts`,
`src/tui/app/constants.ts`, `src/tui/fold.ts`, `src/tui/keys.ts` (the `?` list); tests in
`tests/keybindings.test.ts`, `tests/tui/app.test.tsx`.

**Behaviour** (design, "A command that runs long"; choice 20):
- `CONTEXTS` gains `Task`, its default `{ "ctrl+b": "task:background" }`; `Task` and
  `task:background` leave `CLAUDE_CODE_CONTEXTS` and `CLAUDE_CODE_ACTIONS`; a keys-file `Task`
  block is read like any other.
- `Task` is in force only while `tasks.holding` is set; the action calls `tasks.moveForeground()`.
  Otherwise Ctrl+B does what it does today (nothing).
- The live shell row's second line ends with ` (<key> to run in background)` while the command
  runs and the action is bound; unbound (`null` in the keys file), no hint.

**Tests:** Ctrl+B during a held foreground command: the tool's answer is the user's move line and
the panel shows the command; Ctrl+B with nothing running does nothing; a keys file binding
`task:background` to `ctrl+g`: the hint shows `ctrl+g`, Ctrl+B does nothing; `null`: no hint; the
keys-file tests at 45 and 63 updated, no longer counting `Task` as skipped.

Commit: `feat: Ctrl+B moves the running command to the background`.

## Task 11: `-p` waits for background commands

**Files:** modify `src/clilib.ts` (`waitForBackground`), `src/cli.tsx` (the `-p` branch, SIGINT),
`src/tools/commands.ts` (nothing new: `headless` already gives the limit); tests in
`tests/clilib.test.ts` (in-process) and one spawn test in `tests/cli.test.ts`.

```ts
type Ended = Awaited<ReturnType<Session["send"]>>;  // undefined when the turn ran to its end
export async function waitForBackground(
  session: Session, tasks: Tasks, signal: AbortSignal,
  opts: { failed: () => boolean; answer: (before: Message | undefined) => void; waitingLine?: (line: string) => void },
): Promise<Ended>;   // the first later turn's result that ended the run, or undefined (choice 25)
```

**Behaviour** (design, "With -p", "How the wait ends"; choices 8, 21, 22):
- The CLI calls it only when the first turn's result did not end the run. Then, while the signal
  is not aborted, `failed()` is false, and a command runs or an ending waits: wait for the bus's
  `tasks` or the signal; when `tasks.wakes()`, `session.send("", signal)` and print that turn's
  answer as the first turn's is. **Every send's result is checked** (choice 25): one that ended
  the run stops the loop and is returned; the CLI then uses `ended = first ?? later` in
  `headlessExit`, as today.
- **Whenever the loop ends** (all ended, Ctrl-C, a hook's stop, a failed call, on the first turn
  too), `tasks.stop()` stops what is left and no more turns start. The exit code is
  `headlessExit` with `aborted` read before `session.end`, as today.
- The waiting line once, after 5 s of waiting, when stderr is a terminal.
- `Tasks` is made with `limits` from "Numbers" under `-p` only.
- SIGINT under `-p` (choice 22): the first aborts `stop`; the second calls `process.exit(130)`.
- Background subagents under `-p` still run in the foreground (design, confirmed).

**Tests** (in-process, `FakeProvider`, a stand-in executor): one background command ending
gives a second turn whose answer is printed; two commands give a turn per ending; Ctrl-C (abort)
during the wait stops the command and starts no turn, exit 130; a hook's `continue: false` and a
failed model call, on the first turn after a background start and on a later one, stop the
command, start no turn, exit 1 (the later hook stop shows only in that send's result, which the
function returns; choice 25); a time limit reached is a turn, not a failure; the waiting line
after 5 s with a terminal, never without; one spawn test (`tachiLater`, its own limit for the
7.5 s start, an OpenAI-shaped stand-in on `127.0.0.1`) whose model starts `node -e
"setTimeout(() => console.log('done'), 300)"` in the background and answers the ending: two
answers on stdout, exit 0.

Commit: `feat: -p waits for background commands; Ctrl-C, a hook's stop or a failure ends it`.

## Task 12: Documents and the terminal checklist

**Files:** modify `README.md`; this plan's "As built" if anything changed while building.

**The README** (sections from the survey):
- "File and shell tools" (30): background commands, `shell_output`, `stop_task`, the timeout and
  Ctrl+B.
- "Subagents that read" (66-74) and the commands and keys (192-200): `/tasks` lists both kinds;
  Esc leaves background commands running.
- "Saved sessions" (560-674): the resume line and the `/clear` line.
- "Keys" (1563-1627): the `Task` context and Ctrl+B.
- "Tools under Claude Code's names" (989-1003): Bash's two fields, `TaskStop`, `shell_output`.
- Hooks (1079): the refused `run_in_background` sentence goes.
- "Headless runs" (1793-1829): the wait, the limits, how it ends, the waiting line.
- "Known limits" (1856): **remove** "Shell commands have no time limit" (1892-1895); **add** the
  Windows leftover programs and the box's `setsid` case (design, "Exit"); the numbers are Claude
  Code's, not measured for Tachikoma.

**The checklist** (the user's terminal, Windows; design, "Testing"), each with what to see:
1. Ask for `ping -t localhost` in the background: `Started t1`, the panel's two rows, `/tasks`.
2. Ask the model to read it twice: new lines only, the second read not repeating the first.
3. Ask it to stop it: `Stopped t1.`, the panel shows it stopped.
4. A foreground `ping -n 300 localhost`, then Ctrl+B: the move line, the hint seen before.
5. A foreground `ping -n 200 localhost` with a 5,000 ms timeout: moved at 5 s.
6. `tachi -p "start ping -n 5 localhost in the background, then tell me when it ends"`: two
   answers, exit 0.
7. `/clear` while one runs: the refusal line.

Commit: `docs: background commands in the README`.

## As built

What changed from the plan while building, for the later tasks and the reviewers.

- **Task 1:** `CommandLog` also has `read(room)`, which only `deliver` calls. The caller keeps a
  head short: a head near 30,000 would leave no room, so Task 4 cuts choice 23's error text as
  `headCommand` cuts a command.
- **Task 2:** a command that cannot be spawned at all (a NUL character in it) makes `start` throw
  at once; a spawn error reported later rejects `done` (choice 23). Callers of `start` handle both.
- **Task 3, the network line (choice 26, added):** `networkNoted` (release 7 plan, choice 21) also
  wraps `start`. A command that ends with a non-zero code gets the network-off line in `done`'s
  `stderr` and in its log, so a background command's ending carries it, and a foreground one keeps
  it once Task 5 runs every command through `start`. A stopped command gets no line.
- **Task 3, a stopped command's output:** the box's `done` for a stopped command has empty
  `stdout` and `stderr` (Docker gives each stream only at its end); the host's keeps what it
  collected. **A stopped command's output is always read from its log, never from `done`.**
  The box's `stop()` settles `done` after the kill has run in the box (release 7 plan, choice 87).
- **Task 3, memory blame:** with commands running side by side, a long-running command that fails
  can be given the memory line for a kill by the limit in another command; a known limit.
- **The release checklist** gains a run of the real-Docker cases in
  `tests/sandbox/executor.test.ts` with Docker Desktop up, as CI (`windows-latest`) skips them.
- **Task 4:** `answering()` gives `{ id, kind }[]`, so choice 19's label can tell a command from a
  subagent. `told(id)` drops every waiting entry for the id, a stop's note too, so the model never
  hears of one end twice. A command killed by a signal with nothing unread says `Background
  command <id> (<command>) was killed by <signal>, with no new output.`, as the exit-code line
  does. A failed run or a limit stop with nothing unread ends with `No new output.` The `command`
  and `command-ended` kinds were added to `Line` and `valid()` here; Task 7 does the reading side.
- **A subagent stopped by `stop_task` (choice 27, the user's, 2026-11-13):** the next turn says
  `Background task <id> (<description>) was stopped by stop_task before it finished.`; a stop by
  the user keeps today's `... was stopped by the user before it finished.` Task 6 builds it.
- **Task 5:** `shellTools` gave only the shell tool until Task 6 added the other two; the first
  read after a move is tested through the moved task's log with `deliver`, and Task 6 tests it
  through `shell_output`. After a stop (Esc or the `sleep` rule) the tool waits for the run's
  `done` before it throws, as `exec` did, so in the box Esc answers only once the kill there has
  run, and a box that cannot be reached gives the sandbox's error, not `Cancelled` (release 7,
  choice 87). The seconds in a timeout's line are rounded up, so none says `0s`. The `sleep` rule
  reads any whitespace as a space and ignores letter case for `sleep` too, as PowerShell's `sleep`
  is `Start-Sleep`'s alias. The tests' stand-in executors answer through `start`
  (`standInRun`, `tests/helpers.ts`). `exec` now has one caller in `src`, the box's node check
  (`clilib.ts`); it stays, as `Executor` needs it and its tests show `start` plus a signal.
- **Task 6:** the three tools sit after `edit_file` as `shell, shell_output, stop_task`.
  `shell_output`'s first line for a stop needs to know who stopped it, so `CommandTask` gains
  `stoppedBy?: "user" | "tool" | "limit"`, set by `#stopCommand` and the limit (choice 28). A run whose `done` rejected (choice 23) has no first
  line in "Lines"; it is `<id> failed: <error>`, choice 23's pattern, the error cut as there and
  kept on the task (`error?`). The subagents' stop record holds who stopped one (`by`), for choice
  27. `No task <id>.`, `<id> is not running.` and the subagent line are answers, not errors.
  A second stop of a subagent still unwinding from the first changes nothing, so the first
  stopper's words stand (Task 6's code review).
- **`shell_output` says who stopped a command (choice 28, the user's, 2026-11-13):** its first
  line is `<id> was stopped by the user.` or `<id> was stopped by stop_task.`, in place of `<id>
  was stopped.`, as the read takes away the stop's next-turn note that would have said who.
- **Task 7:** the resume line goes to the model with the next request and is not shown on screen,
  as the design says ("reported once, as an unfinished subagent is") and as release 8a's lost
  subagent line is; the table's "grey" was wrong. Its command is cut by `headCommand`. The lost
  lines list the subagents, then the commands. Only a command's entry in `unfinished` carries
  `kind`. A fork's copy reports and marks it in the copy; the original still reports it once.
  A command's id needs no `^t\d+$` check, as it names no file; a subagent's still does.
- **A command stopped because the session ends is reported on resume (choice 29, the user's,
  2026-11-13):** the window's close stops each running command without writing its
  `command-ended` line, so a resume tells the model once, with the resume line, that it is not
  running; before, its stop note waited for a turn that never came. A stop by `/tasks stop` or
  `stop_task` is written as before. Task 11 uses the same stop when `-p` ends with commands
  running. Subagents keep release 8a's way.
- **Task 8:** `shell_output` has an entry of its own in the hooks' table, under its own name with
  `id`, so a hook's rewrite of it is taken; as an unknown tool a rewrite would be refused with
  "Tachikoma takes rewrites only for its own tools", which is untrue of it. Hooks are sent the
  same either way. `timeout`'s range comes from the shell tool's own constant. A hook's
  `updatedToolOutput` for a background start or a move is taken only in Bash's `{ stdout, stderr }`
  shape, not as the text it was sent, as Claude Code checks it against the tool's own shape and as
  a background `delegate`'s start does (choice 13); a known limit.
- **The system prompt's command line (choice 30, the user's, 2026-11-13):** "Commands get no
  input and have no time limit, so do not start servers, watchers or anything interactive: it
  would never return." becomes `Commands get no input, so do not start anything interactive.
  Start a server or a watcher with background: true.` A session saved before keeps its own system
  prompt when resumed, as every saved session does (release 8a).
- **Known limit, older than this plan:** `reported()` runs when the waiting text is taken, before
  the message carrying it is saved, so a crash between the two drops the line for good. The
  subagent path has had it since release 8a; the window is a moment.
- **Task 9:** an ended command with no exit code (stopped, killed by a signal, or a run that
  failed) has the running row's shape, `⎿ shell · <time>`; the panel's mark (⊘ grey, ✗ red) says
  how it ended, so no new words. The record's `<state>` is the raw state, as a subagent's is. The
  arrival words are the subagents': a command is `done` (`finished`) only at exit code 0; any
  other end of its own is `failed`. `No task <id>. /tasks lists them.` is also `/tasks stop t9`'s
  line. The refusal's helper is `stillRunning`, as it covers both kinds.
- **A command's record says how it ended (choice 31, the user's, 2026-11-13):** under its first
  line, an ended command's record has `shell_output`'s first line (`firstLine`, shared, not
  copied), then `[<n> earlier characters were dropped]` when the log took in more than it keeps,
  then the output kept; with none, `(no output yet)` while it runs and `(no output)` once ended.
  Before, a failed run, a kill and a non-zero exit read alike, and dropped output went unsaid.
