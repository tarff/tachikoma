# Tachikoma background commands, design (2026-11-13)

A small release of its own, after 8c and before 8c-2 (the user's order, 2026-11-12). Today the
shell tool runs each command to its end with no time limit, and only Esc stops one; only subagents
can work in the background (`delegate`, `/tasks`). This release lets a shell command run in the
background: a dev server, a watch build, a long test run.

Every choice below was the user's, on 2026-11-13, from options offered; "option chosen" quotes it.
Points marked **Confirmed** were mine, from reading the code and Claude Code's docs; the user
approved all five put to them on 2026-11-13 ("yes to all"). The sixth, on hooks, was mine to check
and is answered from Claude Code's hooks reference.

A review of this design on 2026-11-13 found five gaps, each checked against the code. The user
chose a known limit for one (Windows clean-up) and approved my fixes for the other four; each is
marked "(review)" where it lands.

## Sources

- Claude Code's interactive-mode page (<https://code.claude.com/docs/en/interactive-mode>,
  "Background Bash commands"), its tools reference (<https://code.claude.com/docs/en/tools-reference>,
  "Timeout and output limits", "Background commands", "Time limit for background commands") and its
  headless page (<https://code.claude.com/docs/en/headless>, "Background tasks at exit"), read
  2026-11-13. Every number below is Claude Code's documented value; none has been measured for
  Tachikoma, and the README will say so.
- Tachikoma's code as of b93441c: `src/tools/shell.ts`, `src/exec/local.ts`,
  `src/sandbox/executor.ts` (`inGroup`), `src/core/tasks.ts`, `src/tools/delegate.ts`,
  `src/hooks/tools.ts`, `src/core/transcript.ts` (`nextTask`, `unfinished`), `src/cli.tsx` (the
  `-p` run) and `src/clilib.ts` (`headlessExit`).
- For the Windows limit: Claude Code's issue tracker, which has many reports of a stopped
  background command's programs left running on Windows, among them
  <https://claudeissues.com/issue/8865-bug-background-tasks-are-not-properly-killed-and-cleared-up-natively-on-windows>,
  found 2026-11-13.

## What the model gets

- **`shell` gains two fields.** `background: true` starts the command and returns at once with its
  id: `Started t4 in the background.` `timeout` is in milliseconds, from 1 to 7,200,000 (2 hours);
  anything else is refused as any bad field is. What it means depends on the mode (review):
  - **A foreground command:** how long it may run. 120,000 (2 minutes) when not given; anything
    over 600,000 (10 minutes) is cut to 600,000, as Claude Code caps a request rather than
    refusing it. The move's message names the timeout that applied.
  - **A background start in a window:** nothing. A background command there has no time limit, as
    in Claude Code's terminal sessions.
  - **A background start under `-p`:** its time limit (see "With -p").
  - **A hook's rewrite** of `timeout` or `background` goes through the same rules.
- **`shell_output {id}`, a new tool** (option chosen: "A shell_output tool"). It returns what the
  command has printed since the model last asked, and once it has ended, its exit code. Output and
  errors come together in the order they were printed, as a log reads. Claude Code dropped its own
  tool like this (TaskOutput, v2.1.277) for a file the model reads. Here a file would need a read
  outside the project, which asks every time, or a file in the project, which clutters it, so
  Tachikoma keeps the tool.
- **`stop_task {id}`, a new tool**, as Claude Code's TaskStop: it stops a background command, or a
  background subagent. Neither new tool asks first: each touches only what this session started.
- **When a command ends, the model is told at once** (option chosen: "Tell the model now"). It gets
  a message, as a background subagent's answer is: `Background command t4 (npm test) ended with exit
  code 1:` and the output it has not read yet. If the model is idle, this starts a turn on its own.
  A command stopped by the user or by `stop_task` is said once, at the next turn, without starting
  one, as a stopped subagent is.
- **One read position per command, so nothing reaches the model twice** (review). Today a
  subagent's ending message is written when it ends (`tasks.ts`); a command's is not:
  - `shell_output` gives what lies past the position, and moves the position to the end.
  - The ending message is written when it is handed to the model, not when the command ends, and it
    moves the position the same way. If `shell_output` has already shown the exit code, no ending
    message is sent.
  - `/tasks t4` is the user's view. It shows the output kept, read or not, and never moves the
    position.
  - **A delivery never goes past the session's cut** (second review). The session cuts every tool
    result at 30,000 characters (`session.ts`), and a full buffer plus its notes is longer than
    that, so the cut would lose the end, where a final error usually is. So each delivery, a
    `shell_output` read or an ending message, first takes room for its own lines (the dropped
    note, the exit code, the ending message's first line), as `read_file` leaves room for its note
    (`files.ts`). It then gives the oldest unread output that fits, and moves the position over
    only that. If more is unread, it ends `[N more characters: shell_output t4 gives them]`, and
    the next read starts there.

**Confirmed:** how much output is kept. Each background command keeps the last 30,000 characters
it printed, read or not, the cap a tool's output has today (Claude Code's). Unread output older
than that is dropped, and the next read starts `[N earlier characters were dropped]`. So a dev
server running all day holds 30,000 characters, not its whole log.

## A command that runs long

Option chosen: "Claude Code's limit". A foreground command still running at its `timeout` moves to
the background instead of stopping: `Command did not complete within its 120s timeout and was moved
to the background as t4.` A command that starts with `sleep` stops at its timeout instead, as in
Claude Code, since a model that sleeps is waiting on purpose.

**Confirmed:** on Windows the shell is PowerShell, whose sleep is `Start-Sleep`. Claude Code's docs
name only `sleep`. `Start-Sleep` is treated the same.

**Ctrl+B** moves the running foreground command to the background at once, with the same kind of
result: `Moved to the background as t4 by the user.` The live shell row shows
`(ctrl+b to run in background)` while a command runs, as Claude Code's does. tmux users press it
twice, since tmux takes the first. It can be rebound as Claude Code's `task:background`.

For both kinds of move, what the command printed before the move is not lost: the first
`shell_output` read gives it.

## Where they show and how they stop

- **Same list as subagents.** Background commands join the task list, numbered with subagents (t1,
  t2, ...). They show in the panel and in `/tasks` with their command and how long they have run.
  `/tasks t4` shows one's output so far. `/tasks stop t4` stops one, and `/tasks stop` stops every
  subagent and command. Claude Code's `/tasks` lists both kinds too. `--max-tasks` still counts only
  subagents: Claude Code puts no cap on background commands.
- **Esc** stops the turn, and a foreground command with it, as today. Background commands keep
  running, as in Claude Code.
- **Exit**, by `/exit`, Ctrl-C twice or Ctrl-D, stops every background command, as foreground
  commands are stopped today (`killTree`): on macOS and Linux its whole process group, on Windows
  its shell and every program under that shell.
  **Known limit (the user's choice, 2026-11-13, after review):** on Windows a program that outlives
  the command's shell keeps running, as with `Start-Process npm run dev`. taskkill finds a
  command's programs only while its shell is alive (`src/exec/local.ts`). On macOS and Linux a
  program that left the process group, as under `setsid`, keeps running too. The same goes for
  `stop_task`, `/tasks stop` and the `-p` time limit, and it is already so for foreground commands.
  Claude Code has the Windows gap too: its docs promise this clean-up only on macOS and Linux, and
  its issue tracker has reports of it on Windows. Stopping it would take a Windows job object, which
  Node cannot make without a native add-on or a helper program. In the sandbox a stop kills the
  command's process group in the box (`inGroup`), so a program that left that group, by `setsid`
  or a server that detaches itself, keeps running in the box after `stop_task` or `/tasks stop`
  (second review). Only the box's removal, when the session ends, stops everything in it. That is
  a known limit too, under the standing rule for rare cases (2026-11-02). The README says so.
- **Resume** (review). Each command gets a line in the session's record when it starts, with its
  id and command, written before the model is told the id, and another when it ends. A resumed
  conversation's next number then follows every command's as well as every subagent's (today
  `nextTask` counts only subagents), so an old `Started t1` in the history never names new work,
  and `stop_task t1` answers that there is no task t1. A command that had not ended is reported
  once, as an unfinished subagent is: `Command t4 (npm run dev) had not ended when the session
  ended; it is not running in this session.`
- **`/clear`, `/resume` and `/branch` wait** while a background command runs, as they already do
  for subagents, so an ending's message never lands in another conversation.
  **Confirmed:** this means a dev server must be stopped before `/clear`. The other way, to let it
  run and drop its ending's message, was not taken.

## With -p

Option chosen: "Claude Code's: wait at exit". A background start returns at once, as in a window.
After the answer, Tachikoma stays open until every background command has ended. Each ending gives
the model one more turn with the outcome, and each turn's answer is printed. When stderr is a
terminal and the wait has lasted 5 seconds, a line goes to stderr:
`Waiting for background work to finish: t4 (npm run dev)`.

In `-p` a background command has a time limit, as in Claude Code: 10 minutes, or the `timeout` the
model gives with `background: true`, at most 2 hours. A command moved by its timeout gets 10 minutes
from the move. Ten minutes is Claude Code's default for a `-p` run given its prompt as text, which
is how every Tachikoma `-p` run is given one; its other unattended runs get 30. At the limit it is
stopped and the model is told:
`Background command "npm run dev" was stopped after reaching its background time limit`.
That is not a failure in itself: the model gets its turn to deal with it.

**How the wait ends** (review). Today the first Ctrl-C only stops the turn (`cli.tsx`), and
background commands outlive a stopped turn, so the run must say when it stops waiting:
- **Every command has ended:** the run ends with the exit code today's rules give (`headlessExit`).
- **Ctrl-C**, during a turn or during the wait: the wait stops, every background command is stopped,
  no more turns start, and the run exits 130, Ctrl-C's usual code, as a stopped run does today. A
  second Ctrl-C still ends at once, and the exit handler still stops the commands.
- **A hook's `continue: false`, or a model call that fails, on any turn, the first one included**
  (second review): every background command is stopped, no more turns start, and the run exits 1,
  as a run cut short does today.

A background subagent under `-p` still runs in the foreground, as today. **Confirmed:** Claude
Code waits for those at exit too; that could follow later.

## The sandbox

In the sandbox a background command runs in the box, in its own process group (`inGroup`), as every
command there does. Stopping one kills its group in the box, and the box's removal at exit ends
anything still running, a program that left the group among them (see "Exit"). The memory-limit
line is added to an ending's message as to a foreground failure.

**Confirmed:** a server started in the box cannot be reached from the host's browser. The box
publishes no ports, and its network is off by default. This release does not change that; port
publishing would go with 8c-2's network work.

## Approval and hooks

- **Approval:** a background start asks the same question as any command, saying it will run in
  the background. The dangerous-command check, never mode and auto mode's judge treat it the same.
  Subagents have no shell tool, so nothing changes for them.
- **Hooks** see `shell` as Bash with its `run_in_background` and `timeout`. Today a hook's rewrite
  is refused if it sets either field; from now on both are taken. `stop_task` is Claude Code's
  TaskStop with `task_id`. `shell_output` has no Claude Code name any more, so hooks see it by its
  own name, as an unknown tool.
  **Checked** (<https://code.claude.com/docs/en/hooks>, read 2026-11-13): the hooks reference gives
  Bash's `run_in_background` and `timeout` as input, but no `tool_response` shape for a background
  start, and never names `backgroundTaskId`. By release 8c's rule for `tool_response` (choice 11:
  Claude Code's shape where its docs give one, else the text the model reads), a background start
  and a moved command give hooks their text, as `Started t4 in the background.`; a command that
  ran to its end keeps today's `stdout`/`stderr` shape.

## How it is built

- **The executors** (`LocalExecutor`, `DockerExecutor`) get a way to start a command and stream
  its output as it comes, alongside today's `exec`, which waits for the end. A foreground command
  streams from the start, so a move to the background keeps what came before it.
- **The task list** (`core/tasks.ts`) takes a second kind, a command, beside a subagent: its id,
  state, the read position, the ending message written when it is handed over, `stop`, and the
  panel's rows.
- **The session's record** (`core/transcript.ts`): a command's start and end lines, counted in
  `nextTask`, and unfinished commands reported on resume.
- **The window:** Ctrl+B, the live row's hint, and `/tasks` rows and detail for a command.
- **`-p`** (`cli.tsx`): the wait after the answer, how it ends, the time limit and the waiting line.

## Not in this release

- Ctrl+B for a subagent the turn waits on. Claude Code moves those too.
- Claude Code's switches for this: `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, `BASH_DEFAULT_TIMEOUT_MS`,
  `BASH_MAX_TIMEOUT_MS`.
- Background commands that outlive a closed window or carry over into a resumed session. A resumed
  conversation's background commands are gone, as in Claude Code; their numbers stay taken (see
  "Resume").
- Stopping, on Windows, a program that outlives its command's shell (see "Exit").

## Testing

- Unit tests with a stand-in executor that prints on cue:
  - reads since the last read, and the 30,000-character cap;
  - the ending's message, and the wake;
  - a command that ends and is read by `shell_output` before its message is handed over: the
    output and exit code reach the model once; `/tasks t4` moves nothing;
  - a full buffer, read and as an ending message: each delivery fits the session's cut with its
    notes, the last line printed still arrives, on that delivery or the next read, and nothing is
    given twice;
  - `stop_task`;
  - a move at the timeout, the `sleep` exception and Ctrl+B, each keeping what came before the move;
  - `timeout` by mode: over 10 minutes cut in the foreground, no effect on a window's background
    start, the limit under `-p`, out of range refused, and a hook's rewrite under the same rules;
  - `/tasks` rows, and `/clear` waiting;
  - resume: a command's number is not handed out again, `stop_task` on it says there is no such
    task, and an unfinished one is reported once;
  - hooks' fields.
- The box through the existing Docker stand-in: a background start, a read, and a stop that kills
  the group.
- `-p`: the wait, the extra turn, the time limit, and each way the wait ends (Ctrl-C exits 130
  with the commands stopped; a hook's `continue: false` and a failed model call exit 1 with no
  more turns, each on the first turn after a background start as well as on a later one). These
  tests start Tachikoma, and a `-p` start takes about 7.5 s on this PC. That is the known
  slowness, so they need room in their time limit.
- Windows only: a command that starts a program and returns, then is stopped. The test records
  that the program survives (the known limit), and stops it itself.
- The user's terminal checklist on Windows:
  - a background `ping -t localhost`, read twice, then stopped;
  - a foreground command moved by Ctrl+B;
  - one moved by its timeout;
  - a `-p` run that waits for one.
