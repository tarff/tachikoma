# Tachikoma Release 8b (hooks): Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to build this
> plan task by task: a fresh builder per task, then a spec review, then a code review.

**Goal:** the user's own commands, written in Claude Code's hooks format in the `hooks` entry of
`~/.tachikoma/settings.json`, run at 11 moments of a session, so a hook script made for Claude
Code works unchanged in Tachikoma.

**Architecture:**
- **A new folder, `src/hooks/`,** holds everything that knows Claude Code's format:
  - `config.ts` reads the settings entry;
  - `run.ts` starts one hook and collects what it printed;
  - `answer.ts` reads one hook's answer and combines several;
  - `tools.ts` turns Tachikoma's tools into Claude Code's names, inputs and results, and back;
  - `hooks.ts` is the `Hooks` object the session fires events through.
- **One `Hooks` object per window,** made in `cli.tsx` and handed to the lead's `Session`, its
  subagents (`hooks.for(subagent)`), the App and `-p`. A live edit swaps its hooks in place, as
  8a's `Session.load` swaps a conversation, so everything that holds it stays valid.
- **The session fires the events that happen inside a turn:** UserPromptSubmit, PreToolUse,
  PostToolUse, PostToolUseFailure, Stop, SubagentStop, PreCompact and PostCompact. Tasks fires
  SubagentStart. The launch and the App fire SessionStart and SessionEnd.
- **Tachikoma's own checks stay where they are.** PreToolUse runs before the tool, and its answer
  reaches the gate through a gate made for that one call (`gate.withHook`), so no tool changes how
  it asks.

Design: `docs/plans/2026-11-09-tachikoma-release-8b-design.md`, with its review's four fixes
(f2bb126).

**Tech stack:** as release 8a (TypeScript 7.0.2, Ink 7.1.1, React 19.3.0, Vitest 5.0.3,
ink-testing-library 4.0.0, zod 4.6.7). No new npm package.

---

## Before you start

**How this plan is built.** As release 8a, each task gives the files, the interfaces, the
behaviour and the tests, and each test says what it must show. A builder writes the tests first
and sees them fail, then writes the code, then commits. A spec reviewer and then a code reviewer
check the commit before the next task starts. The plan has four parts:
- **Part 1, groundwork (Tasks 1-4):** the settings entry, running one hook, reading answers, and
  the `Hooks` object.
- **Part 2, tool hooks (Tasks 5-7):** names and shapes, PreToolUse with the gate, and the hooks
  after a call, with a hook stopping the turn.
- **Part 3, the other events (Tasks 8-11):** text for the model and UserPromptSubmit; Stop and
  the subagents' events; SessionStart and SessionEnd; PreCompact and PostCompact.
- **Part 4, what the user sees, and the documents (Tasks 12-13).**

**The branch.** Build on the local branch `release-8b` (main e6b34e8 plus the design, head
f2bb126 or later). Do not push: every push needs the user's fresh say-so, and main takes changes
only by pull request, which now needs CI's `test` check to pass.

**Checks, from the repo's folder:**
- Types: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
- One file: `node node_modules/vitest/vitest.mjs run tests/hooks/answer.test.ts`
- The App's tests, only with `-t`:
  `node node_modules/vitest/vitest.mjs run tests/tui/app.test.tsx -t "App's hooks"`. The file has
  about 500 cases; never run it whole for a task.
- Build: `npm run build`
- **The whole suite runs once at the end of each part, not after each task** (user, 2026-10-31).
  A builder runs the test files the task touches, plus any file that imports a module the task
  changed. Never run `tests/tui/external.test.ts`: it opens real programs.

Tests that start PowerShell or other programs sometimes run past Vitest's 5 s limit when the
machine is busy. A time-out is not a failure of this release if the file passes run alone. The
files known to do this: the `tests/auth/` files; `tests/providers/registry.test.ts` and
`models.test.ts`; `tests/tui/history.test.ts`, `statusline.test.tsx` and `conversation.test.tsx`;
`tests/settings.test.ts`.

**Rules for every task:**
- **Tests first,** seen failing for the right reason, then the code. One commit per task, plus
  `fix:` commits for review findings.
- **Tests never touch the user's own things.** No test reads or writes the user's own files
  (settings, keys, history, data folder, git settings, `~/.claude`), runs the user's own hooks,
  contacts a provider, or uses the network.
  - A hook in a test is a small Node script the test writes into its own `mkdtemp` folder, started
    with `command: process.execPath` and `args: [script]` (exec form), so it needs no shell.
  - A test of the shell form on Windows needs Git Bash, found as Task 2 finds it, and is skipped
    with `it.skipIf` where there is none. A test never runs a bare `bash`: on the user's PC it is
    WSL's (`C:\WINDOWS\system32\bash.exe`, found 2026-11-09).
  - Every test that saves sessions uses a data folder two levels inside a fresh `mkdtemp` folder,
    as release 8a's tests do.
- **Never change permissions** on any file or folder (no `icacls`, `chmod`, ACL calls), in a test
  or by hand.
- **Deletes:** code deletes only files Tachikoma named, never follows a link. A builder deletes
  only files they made, by exact name.
- **No package installs, and no fetch from any registry.**
- **Windows tools whose switches start with `/`** run from PowerShell or Node, never Git Bash.
- **Match the code around you.** Use plain-language comments that say why, citing the design's
  section ("release 8b design, \"Tool hooks\"") or this plan's choice ("release 8b plan, choice
  6"). No comment restates the code. Code lines go up to 160 columns; prose in docs up to 100.
- **Every number in the code has its source in a comment:** Claude Code's docs, the design, or
  this plan's table "Numbers in this plan".
- **Every user-visible line is triggered for real in a test,** and its exact words checked. Its
  words are the ones in "Lines this plan adds", which the user approves with the plan.
- **Commit messages:** `feat: ...`, `fix: ...`, `docs: ...`, `test: ...`, `refactor: ...`, ending
  with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_011HyFwQ2thF7f21RYDJiE97
  ```

**Facts the tasks rely on** (read 2026-11-09 by a read-only survey of the code at e6b34e8, and
from Claude Code's docs that day):

**The session** (`src/core/session.ts`)
- `send` (213-222) returns nothing; the TUI and `-p` learn a turn's end only from the stop signal
  and bus `error` events.
- `#turn` (224-364): the prompt's words with each picture as its marker are built at 227; the
  user message is pushed at 233; the reply at 337; a reply with no calls ends the turn at 348
  (the only normal end); calls are kept for the judge at 350, before any runs; `delegate` calls
  start together at 356 and the rest run one after another at 357; all results and the waiting
  text go back as one user message at 359.
- `#execute` (529-546): a stopped turn gives "Cancelled by the user."; a `Declined` gives outcome
  `declined`; any other throw is a `tool` error.
- `#shorten` (454-500) runs `onShorten` at 465, which nothing registers today. `/compact` reaches
  it through `compact(focus)` (185-199), `/lead` through `makeRoom` (161-180), and the turn at
  257 and 289. The summary is emitted as bus `shortened` at 498.
- `#waiting` (548-550) turns the inbox into text parts marked `from: "tasks"`, placed after the
  last tool result.

**Types** (`src/core/types.ts`): a text part is `{ type: "text"; text; from?: "tasks" }` (9).

**Transcript** (`src/core/transcript.ts`): the `Line` union is at 22-44; `write` at 81-91; a new
kind must also go in `valid()` (329-347), or it is read back as damaged. The record of calls is
rebuilt from the replies at 199-207.

**Subagents** (`src/core/tasks.ts`): `start` 107-119 (id `t${n}` at 109); `stop` 122-133; `#run`
161-190, its file `<sessions>/<id>/subagents/tN.jsonl` at 171, its end at 174-189 (stopped text
at 179); `#work` 193-241 makes the subagent's `Session` at 217-227, with
`gate.for(owner, ...)`, and takes the last reply's text as its answer at 237-240.

**The gate** (`src/core/permissions.ts`): `require` (178-213); `never` refuses protected parts,
outside writes and dangers (182-189); `needsApproval` (50-55); auto goes to the judge at 194; the
question gets `warnings` and a grey `note` (198-200); `-p` refuses a danger whatever it answers
(203).

**The launch and the App**
- `cli.tsx`: settings at 345-347; the transcript opened at 592-598; `leadSession` at 604-615; `-p`
  at 622-674 (error lines to stderr at 635-639; **no `note` listener**, so notes are lost there);
  `session.load` at 643 (`-p`) and 764 (the window); `ink.waitUntilExit()` at 765-774; signals
  through `exitOn` (clilib.ts:232), which calls `process.exit`.
- `queue.ts`: `perform` 87-200 dispatches every command; `/clear`, `/resume` and `/branch` all
  meet at `switchTo` (351-370); `leave` (300-333) ends the window; the prompt is sent at 189.
- The prompt box is `ui.editor` (state.ts:67); `restore` (promptKeys.ts:81-87) already puts text
  back into it.
- Ctrl+O: `lastTurn` (describe.ts:71-76) and `callLines` (79-83), shown at promptKeys.ts:35-38.
- The waiting line's label is `ui.doing.current.label` (queue.ts:161-162; App.tsx:658-672).
- Live settings: `watchSettings` (App.tsx:349-360), `onSettings` (liveEdits.ts:17-32), LIVE names
  in constants.ts:115-118.
- Command names: `NAMES` (constants.ts:104-108), `COMMANDS` (54-56), the `/` menu (menus.ts:26-45),
  HELP (cli.tsx:132-143).

**The sandbox:** the box gets `/work` and the mounts in `liveMounts`, never the home folder:
`sandboxHeld` (image.ts:196-212) refuses a project that is, or holds, the home folder, the data
folder or `~/.tachikoma`. In copy mode `/work` is `<data>/copies/<session>/work`. Only host-to-box
path conversion exists today (clilib.ts:530-541).

**Processes:** `killTree` and `collect` (local.ts:26-57; `collect` keeps `MAX_TOOL_OUTPUT` =
30,000 characters, executor.ts:3); `commandEnv` (env.ts:36-43). Nothing finds Git Bash. On the
user's PC: `C:\Program Files\Git\cmd\git.exe` on PATH, `C:\Program Files\Git\bin\bash.exe`
present, `bash` on PATH is WSL's, `jq` on PATH from winget, `CLAUDE_CODE_GIT_BASH_PATH` unset.

**Claude Code's docs** (hooks reference, read 2026-11-09):
- `file_path` for Write, Edit and Read is always whole, and on Windows has backslashes.
- `tool_input` per tool: Bash `command, description, timeout, run_in_background`; Write
  `file_path, content`; Edit `file_path, old_string, new_string, replace_all`; Read `file_path,
  offset, limit`; Glob `pattern, path`; Grep `pattern, path, glob, output_mode, -i, multiline`;
  Agent `prompt, description, subagent_type, model`. TodoWrite's is not given.
- `tool_response`: Bash `{stdout, stderr, interrupted, isImage}`; Write `{filePath, type:
  "create"}`; Agent `{status, agentId, content, ...}`. The others are not given.
- PostToolUseFailure gets `error` (Bash's starts `Exit code N`), `is_interrupt`, `duration_ms`,
  and does not fire for a refused call, an unknown tool or an input the tool's schema refuses.
  PostToolUse gets `duration_ms`.
- `updatedToolOutput` must match the tool's output shape; one that does not is ignored.
- `additionalContext` goes in "at the point where the hook fired": SessionStart and SubagentStart
  at the conversation's start, UserPromptSubmit with the prompt, the tool events next to the
  result, Stop and SubagentStop at the turn's end. Several hooks' values all go in.
- A hook runs in the folder the session started in.
- Where Claude Code looks for Git Bash is not given; `CLAUDE_CODE_GIT_BASH_PATH` is ignored unless
  it names a file called `bash.exe`, `sh.exe`, `bash` or `sh` that exists.

## Numbers in this plan

| Number | Where | Source |
|---|---|---|
| 600 s | a hook's time limit by default | Claude Code's hooks reference, "Common fields" |
| 30 s | the time limit at UserPromptSubmit | the same |
| 1.5 s, up to 60 s | SessionEnd's hooks share 1.5 s; a hook's own longer `timeout` raises it, to 60 s at most | the same |
| 10,000 characters | each piece of text a hook hands the model or the user | the hooks reference, "JSON output" |
| 8 | Stop or SubagentStop blocks in a row, with no tool call between, before the turn ends anyway | the hooks reference, "Stop input" |
| 30,000 characters | how much of a hook's error output is read (`MAX_TOOL_OUTPUT`); its output is read whole (the user's choice, 2026-11-09) | executor.ts:3, as every command's output is read |

No other number is set. Anywhere a builder feels a number is needed, they stop and ask the
controller, who asks the user.

## Choices this plan makes that the design leaves open

Each is marked in its task. The user approves them with the plan.

**Running hooks**
1. **Git Bash is found** (Claude Code's docs do not say how it looks), in this order, once per
   process: `CLAUDE_CODE_GIT_BASH_PATH`, when it names an existing file called `bash.exe`,
   `sh.exe`, `bash` or `sh` (Claude Code's rule); then `bin\bash.exe` beside the folder of the
   first `git.exe` on PATH (`...\Git\cmd\git.exe` gives `...\Git\bin\bash.exe`); then
   `%ProgramFiles%\Git\bin\bash.exe`; then `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`, where
   Git for Windows installs for one user. **Never a bare `bash` from PATH**, which on the user's
   PC is WSL's. A shell-form hook runs as `bash.exe -c <command>`.
2. **Without Git Bash,** the shell is Windows PowerShell by its full path, as the shell tool
   starts it (`-NoProfile -NonInteractive -Command`), and the launch says so once, when hooks run
   by a shell are in force (a line below).
3. **A hook's folder** is the project's root as the launch found it (the folder the session
   started in, as Claude Code's); `cwd` in its input is the same.
4. **Its input** is written to its standard input whole, then closed.
5. **`async` hooks** are started and not waited for; their answer is read only to report a
   failure, as Claude Code's are, or that the hook asked to stop or to block, which it cannot
   (their lines below, the stop's alone when it asks both; the user's choices, 2026-11-09); they
   are stopped when Tachikoma exits, as the shell tool's commands are.

**The answers**
6. **The text a hook hands the model** goes in as a text part marked `from: "hooks"`, headed
   `<Event> hook:` on its own line, one part per piece, in the order the hooks are listed in the
   file. It goes where Claude Code puts it: with the prompt (UserPromptSubmit), after the call's
   result (the tool events), at the start of the conversation's next request (SessionStart), in
   the subagent's first message (SubagentStart), and at the turn's end, which keeps the turn going
   (Stop, SubagentStop). The judge never reads it (prompts take only the user's own words today).
7. **Text over 10,000 characters is cut,** with `[cut: <n> more characters]`, as a tool's long
   output is (design, "What a hook's answer does"); Claude Code writes it to a file instead.
8. **A Stop hook's `additionalContext`** keeps the turn going, as a block does, as Claude Code's
   "Stop hook feedback" does, and counts towards the 8.
9. **`continue: false` in `-p`** ends the run with exit code 1 and its line, as the run's work
   was cut short.

**Tools**
10. **On the screen, tools keep Tachikoma's names** (`shell`, not `Bash`) in every line, as the
    rest of the window names them; only what hooks are sent uses Claude Code's.
11. **Results for the tools Claude Code's docs do not give a shape for** (Read, Edit, Glob, Grep,
    TodoWrite) are sent as the text the model reads. Bash's is `{stdout, stderr, interrupted:
    false, isImage: false}`; Write's `{filePath, type}`, with `"create"` or `"update"` by whether
    the file was there; Agent's `{status, agentId, content: [{type: "text", text}]}`, with
    `status` `"completed"`.
12. **The tools tell the session their result's parts** through a new optional
    `ToolContext.report(parts)`, which `shell`, `write_file` and `delegate` call; the others need
    none. A Bash failure's `error` is `Exit code <n>\n` then its error output, then its output.
13. **`updatedToolOutput`** is used where Tachikoma can turn it back into what the model reads: a
    string for the five tools above; Bash's shape, rebuilt into the shell tool's own layout; and
    Agent's `content` text. Anything else is ignored, as Claude Code ignores a shape that does not
    match, and Ctrl+O says so.
14. **Tool inputs Claude Code has and Tachikoma has not** are left out of what is sent (Bash's
    `description`, `timeout`; Grep's `output_mode`, `-i`, `multiline`; Agent's `model`); Agent's
    `subagent_type` is sent as `"Explore"` (design, "What a hook is sent"). A rewrite that sets
    any of them to a value other than Tachikoma's own way (Edit's `replace_all: true`, Bash's
    `run_in_background: true`) cannot be taken, and refuses the call.
15. **A hook's `ask`** puts one question, naming the call as Ctrl+O does, with `A hook asks:
    <reason>` as its grey note. A yes stands in for the mode's question and the judge for that
    call; the dangerous-command check and protected paths still ask or refuse after it.
16. **A rewrite the record keeps** is saved as a new transcript line, `{ t: "rewritten", id,
    input }`, after the reply's line and before the call runs; reading a transcript puts each in
    its call's place in the record of calls (design, review finding 4).

**The other events**
17. **`Session.send` returns how the turn ended,** `{ blocked: string }` for a prompt a
    UserPromptSubmit hook blocked, or `{ stopped: string }` for a hook's `continue: false`, and
    nothing otherwise, so the TUI puts the words back, `-p` sets its exit code, and Tasks ends a
    subagent.
18. **`/branch` ends the session it leaves** (SessionEnd `other`) before SessionStart `fork`, so
    every SessionStart in a window after the first follows a SessionEnd; `/clear` and `/resume`
    give `clear` and `resume`.
19. **A signal (Ctrl-C at the terminal outside the window, a kill) runs no SessionEnd,** as
    `exitOn` ends the process at once; this is a known limit.
20. **PreCompact and PostCompact are `manual` for `/compact` only;** `/lead`'s shortening, like
    the turn's, is `auto`. SessionStart `compact` fires once PostCompact's hooks have answered,
    before the shortening is saved, and its text is saved in the shortened message (Task 11).
21. **`background_tasks` entries** are `{ id, type: "agent", status: "running", description,
    agent_type: "Explore" }` for each background subagent running or waiting; Claude Code's docs
    show `type` only for a shell task.

**What the user sees**
22. **Failures** are a new error kind, `hook`, shown red with the line alone (as `saving` is),
    kept in the error log, and written to `-p`'s error output.
23. **The other lines** (blocks, a hook's `systemMessage`, a stop, the live-edit line) go out as a
    new bus event, `hook-note`, shown grey in the window and written as `note: <line>` to `-p`'s
    error output, as a fallback's note is; other notes in `-p` are left as they are.
24. **Ctrl+O** shows the last turn's hook runs after its calls, one line each, with what each
    handed the model or rewrote under it after `⎿`.
25. **`/hooks`** prints the list once, into the conversation, as `/tasks` prints its list.

## Lines this plan adds

The user approves these words with the plan. Each is checked word for word in a test. Grey lines
are notes; red ones are failures. `<Event>` is Claude Code's event name, `<command>` the hook's
command with its `args` after it, escaped as the question escapes a command.

| Where | Line |
|---|---|
| A hook failed: another exit code (red) | `<Event> hook failed: <command> exited with code <n>: <first line of its error output>` (without error output, it ends at `<n>`) |
| A hook could not start (red) | `<Event> hook failed: <command> could not start (<reason>)` |
| A hook ran out of time (red) | `<Event> hook failed: <command> ran out of time after <n> s` |
| A hook ended by a signal (red) | `<Event> hook failed: <command> was ended by signal <SIGNAME>: <first line of its error output>` (without error output, it ends at `<SIGNAME>`; with no signal known, `was ended by an unknown signal`) |
| A hook's JSON could not be read (red) | `<Event> hook failed: <command> printed JSON that could not be read (<reason>)` |
| The JSON's `<reason>` | `it is cut short`; `there is text after the object`; any other broken JSON, the parser's own words; `"<field>" must be text in quotes` (`systemMessage`, `stopReason`, `reason`, `additionalContext`, `permissionDecisionReason`, `hookEventName`); `"continue" must be true or false`; `"decision" must be "approve" or "block"`; `"permissionDecision" must be "allow", "deny", "ask" or "defer"`; `"hookSpecificOutput" must be an object`; `"updatedInput" must be an object`; `"hookSpecificOutput" has no "hookEventName"`; `"hookSpecificOutput" names <OtherEvent>` |
| An async hook asked to block (red) | `<Event> hook failed: <command> asked to block, but an "async" hook cannot block` (approved by the user, 2026-11-09) |
| An async hook asked to stop (red) | `<Event> hook failed: <command> asked to stop, but an "async" hook cannot stop`; one that asks to stop and to block gives this line alone (approved by the user, 2026-11-09) |
| What a hook failure attempted, which `/errors` shows | `<Event> hook`; a subagent's, `t1: <Event> hook` (approved by the user, 2026-11-09) |
| PreToolUse refused a call (grey) | `A PreToolUse hook refused <tool>: <reason>` |
| A rewrite that cannot be used (grey; the call refused) | `A PreToolUse hook's rewrite of <tool> could not be used (<reason>): <command>` |
| Two rewrites of one call (grey) | `Two PreToolUse hooks rewrote <tool>'s input; the first in the settings file was used, and <command> was ignored.` |
| `defer` (grey) | `A PreToolUse hook answered "defer", which Tachikoma takes as no opinion.` |
| A hook's ask, the question's note (grey) | `A hook asks: <reason>` (no reason: `A hook asks.`) |
| A hook's ask in `never` (to the model) | `Not allowed in never mode: a PreToolUse hook asked for this call to be approved (<reason>).` |
| A hook's ask in `-p` (to the model) | `Not allowed: a PreToolUse hook asked for this call to be approved (<reason>), and -p cannot ask.` |
| A hook stopped the turn (grey) | `A <Event> hook stopped the turn: <stopReason>` (no reason: `A <Event> hook stopped the turn.`) |
| A call not run after a stop (to the model) | `Not run: a hook stopped the turn.` |
| A subagent stopped by a hook (its result) | `<id> was stopped by a hook: <stopReason>` (no reason: `<id> was stopped by a hook.`) |
| UserPromptSubmit blocked (grey) | `A UserPromptSubmit hook blocked the prompt: <reason>` then, in the window, `Your words are back in the prompt box.` |
| Stop kept the turn going (grey) | `A Stop hook kept the turn going: <reason>` |
| SubagentStop kept a subagent going (grey) | `A SubagentStop hook kept <id> going: <reason>` |
| The 8 blocks reached (grey) | `Stop hooks kept the turn going 8 times in a row; it ends here.` (for a subagent: `SubagentStop hooks kept <id> going 8 times in a row; it ends here.`) |
| A Stop block's reason (to the model) | `Stop hook feedback:` then the reason on the next line |
| PreCompact blocked (the 8a line's reason) | `a PreCompact hook blocked it: <reason>`, in `The conversation could not be shortened (<reason>); it is unchanged.` |
| A hook's `systemMessage` (grey) | `<Event> hook: <message>` |
| Text for the model's heading | `<Event> hook:` |
| SessionStart text left out after a shortening (grey) | `SessionStart hook text was left out: with it, the shortened conversation would not fit the model's window.` |
| A subagent's hook lines | each of the lines above said in a subagent's session starts `<id>: `, as its errors do: `t1: A PreToolUse hook refused shell: <reason>` |
| Hooks changed (grey) | `Hooks changed: <n> hooks at <m> events.`; none left: `Hooks changed: none in force.`; turned off: `Hooks changed: all off (disableAllHooks).` |
| No Git Bash, at the launch (grey) | `Git Bash was not found, so hooks run by a shell use Windows PowerShell; set CLAUDE_CODE_GIT_BASH_PATH to its bash.exe to change that.` |
| A left-out event (launch warning) | `settings.json: "hooks": "<Event>" is not an event Tachikoma runs hooks at; its hooks were left out` |
| A left-out kind (launch warning) | `settings.json: "hooks": "<Event>" has a "<type>" hook; only "command" hooks run, so it was left out` |
| A hook with `if` (launch warning) | `settings.json: "hooks": "<Event>" has a hook with "if", which Tachikoma cannot check, so it was left out: <command>` |
| `asyncRewake` (launch warning) | `settings.json: "hooks": "<Event>" has a hook with "asyncRewake"; it runs as plain "async": <command>` |
| An unknown field (launch warning) | `settings.json: "hooks": "<Event>" has a hook with "<field>", which is not a hook field; it was left out: <command>` (the field, not the hook) |
| An unknown key in an entry (launch warning) | `settings.json: "hooks": "<Event>" has an entry with "<key>", which is not "matcher" or "hooks"; it was left out` (the key; the entry's hooks are read) |
| A hook without `command` or `type` (problem: the file is not applied) | `settings.json: "hooks": "<Event>": a hook must have "command", such as {"type": "command", "command": "check.sh"}`, and the same with `"type"` |
| A value of the wrong type in `hooks` or `disableAllHooks` (problem: the file is not applied) | `<place> must be <what> (got <the value as JSON>)`, as every entry's are, `<place>` one of `settings.json: "hooks"`, `settings.json: "hooks": "<Event>"`, then `: each entry`, `: each hook`, `: "matcher"` or `: a hook's "<field>"` after it, or `settings.json: "disableAllHooks"`; for example `settings.json: "hooks": "PreToolUse": a hook's "timeout" must be a number of seconds above 0 and no more than 2147483, such as 30 (got -1)`. A matcher that does not compile: `settings.json: "hooks": "<Event>": "matcher" "<text>" is not a regular expression that can be read (<the engine's words>)` |
| `/hooks` | Heading `Hooks in force, from ~/.tachikoma/settings.json:`; per event `<Event>`, then a row each `  <matcher, or *> · <command> · <n> s` (an `async` one adds ` · async`); then `Left out:` and a row each `  <the warning's words after "hooks": >`; with none, `No hooks in force. They go in "hooks" in ~/.tachikoma/settings.json.`; turned off, `Hooks are off: "disableAllHooks" is true in ~/.tachikoma/settings.json.` |
| Ctrl+O, a hook run (grey) | `◆ <Event> hook <command> · exit <n> · <ms> ms` (out of time: `· out of time`; could not start: `· could not start`), and under it after `⎿` what it handed the model, its rewrite as JSON, or `its updatedToolOutput was not used: it does not match <tool>'s result` |

## Task 1: The hooks entry in the settings file

**Files:** create `src/hooks/config.ts`, `tests/hooks/config.test.ts`; modify `src/settings.ts`
(the `hooks` and `disableAllHooks` names), `tests/settings.test.ts`, and the LIVE names
(`src/tui/app/constants.ts:115-118`).

```ts
export const EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "Stop", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact"] as const;
export type Event = (typeof EVENTS)[number];
export interface Hook {
  event: Event; matcher: Matcher; command: string; args?: string[]; shell?: "bash" | "powershell";
  timeout?: number; async: boolean; onFailure?: "continue" | "block"; statusMessage?: string;
  where: string;   // the warning's place, `"PreToolUse"`, for lines and /hooks
}
export type Matcher = { all: true } | { names: string[] } | { regex: RegExp };
export interface HooksConfig { hooks: Hook[]; off: boolean; leftOut: string[] }   // leftOut: the warnings' words, for /hooks
export function readHooks(entry: string, value: unknown, warnings: string[]): Hook[];
export function matcherOf(text: string | undefined): Matcher;
export function matches(m: Matcher, value: string): boolean;
```

**Behaviour:**
- **The shape is Claude Code's** (design, "The settings entry"). `hooks` must be an object of
  event names, each a list of `{ matcher?, hooks: [...] }`; anything else of the wrong JSON type
  is a problem, as for every other entry (settings.ts's `wrongType`), and the whole file is not
  applied.
- **Left out with a warning, the rest applied:** an event not in `EVENTS`; a hook whose `type` is
  not `"command"`; a hook with `if`; an unknown field (the field only). `asyncRewake` gives its
  warning and makes the hook `async`. `once` is dropped without a word. Each warning's words are
  in "Lines this plan adds".
- **`disableAllHooks`**, a boolean, turns them off; the hooks are still read and warned about, so
  `/hooks` can say what is off.
- **Matchers** (Claude Code's rules): empty, missing or `*` is all; text of only letters, digits,
  `_`, `-`, spaces, commas and `|` is a list of exact names, split on `|` and `,`, each trimmed;
  anything else is `new RegExp(text)`, unanchored. A regex that does not compile is a problem.
  Matching minds letter case. A matcher on UserPromptSubmit or Stop is ignored, as those take
  none.
- `timeout` must be a number of seconds above 0 and no more than 2147483 (`timeout * 1000` at most
  2,147,483,647 ms, the longest wait Node's `setTimeout` takes; the user's choice, 2026-11-09).
- **Both names are LIVE** (design, "What the user sees"; Task 12 applies them).

**Tests:** each warning's words, triggered; a file with only unknown events still applies its other
entries; `hooks` of the wrong type is a problem; `matcherOf` for `""`, `"*"`, `"Bash"`,
`"Edit|Write"`, `"Edit, Write"`, `"mcp__.*"`, `"^Bash$"`; `Bash` does not match `bash`; `once` gives
no warning; `asyncRewake` makes `async` true.

Commit: `feat: hooks in the settings file, in Claude Code's shape, with warnings for what Tachikoma leaves out`.

## Task 2: Running one hook

**Files:** create `src/hooks/run.ts`, `tests/hooks/run.test.ts`; modify `src/exec/env.ts` (a
`gitBash()` finder, beside `onPath`).

```ts
export interface Ran { code: number | null; stdout: string; stderr: string; ms: number;
  failed?: "start" | "time"; startError?: string }
export function runHook(hook: Hook, input: object, opts: { cwd: string; env: NodeJS.ProcessEnv; limit: number; signal?: AbortSignal }): Promise<Ran>;
export function gitBash(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string | null;   // choice 1, cached per process
export function shellOf(hook: Hook): { file: string; args: string[] } | { exec: true };
```

**Behaviour:**
- **Exec form** (`args` given): `spawn(command, args)` with no shell, on every system (Claude Code's
  rule). On Windows a `.cmd` or `.bat` cannot be started so (a known limit). A command without a
  folder in it is found on PATH with `onPath` and started by its full path, so the project folder
  is never searched for it; one not there gives `failed: "start"`, `not found on PATH` (the user's
  choice, 2026-11-09).
- **Shell form:** on Windows, `shell: "bash"`, or no `shell` with Git Bash found, runs
  `<git bash> -c <command>`; `shell: "powershell"`, or no Git Bash, runs Windows PowerShell as
  `shellFor` does. Elsewhere, `/bin/sh -c`, and `shell: "bash"` runs `bash -c` (choices 1, 2).
  A shell named without a folder (`bash` outside Windows) is found on PATH the same way, so an
  empty or `.` entry never leads to the project folder (Task 2's review).
- **The environment** is `commandEnv()` plus `CLAUDE_PROJECT_DIR`, the real project folder; the
  folder is the project's root (choice 3).
- **Its input** is the JSON written whole to its standard input, which is then closed (choice 4).
- **Output** is read with `collect` (local.ts): the output whole, so a long JSON answer can still
  be read, and answer.ts cuts each text it hands on (the user's choice, 2026-11-09); the first
  30,000 characters of the error output, the rest read and dropped.
- **Time limit:** at `limit` seconds the hook is killed with `killTree` and `failed: "time"`. A
  stop (`signal`) kills it the same way and rejects with `Cancelled`, as a command does.
- **A hook that cannot start** (`spawn`'s `error`) gives `failed: "start"` and its reason.
- Started hooks join the `running` set, so they are stopped when Tachikoma exits (choice 5).

**Tests:**
- An exec-form Node hook gets its input whole, prints, exits with a code; `ms` is set.
- `CLAUDE_PROJECT_DIR` and the folder are the root given.
- A hook that sleeps past a 1 s limit is killed and reports `time` (the test's own limit, set
  through `limit`, not a number in the code).
- Stopping it rejects with `Cancelled`, and its child is gone.
- A command that does not exist reports `start`.
- A bare command is found on PATH: a `node.exe` in the hook's folder is not the one started, the
  real Node on the test's PATH is; a bare name not on a made-up PATH reports `start` with
  `not found on PATH`; `program` passes over empty and `.` PATH entries and takes a name with a
  folder as written.
- On Windows, a `hook.cmd` given by its full path reports `start` (EINVAL) and does not crash.
- `timeout`: 2147483 s is taken; 2147484 s and 2147483.5 s are refused with the one wording.
- `gitBash`: a temp `bash.exe` named by `CLAUDE_CODE_GIT_BASH_PATH` is taken; one named `zsh.exe`
  is not; a temp `Git\cmd\git.exe` on a test PATH gives its `Git\bin\bash.exe`; with none it
  gives null. Each case uses a made-up `env` and folders the test made; none reads the real
  Program Files.
- On Windows with Git Bash found (skipped without): a shell-form hook `uname -s` prints a name
  starting `MINGW` or `MSYS`, which WSL's bash (`Linux`) would not.

Commit: `feat: running a hook as Claude Code does: Git Bash or PowerShell on Windows, sh elsewhere, its input on stdin, a time limit`.

## Task 3: Reading the answers

**Files:** create `src/hooks/answer.ts`, `tests/hooks/answer.test.ts`.

```ts
export type Outcome =
  | { kind: "ok"; json?: Record<string, unknown>; text?: string }
  | { kind: "block"; reason: string; json?: Record<string, unknown> }
  | { kind: "failed"; line: string };   // the red line's words after "<Event> hook failed: "
// Ran (run.ts) gains two fields for the failure lines: limit?: number, the limit in force, kept with failed: "time";
// signal?: string, what ended a hook that left no exit code (the user's choices at Task 3).
export function outcomeOf(event: Event, hook: Hook, ran: Ran, platform?: NodeJS.Platform, bash?: boolean): Outcome;
export interface Combined {
  stop?: string;              // continue:false, its stopReason ("" when none)
  block?: string;             // the strongest block's reason (exit 2, decision "block", or a deny)
  decision?: "allow" | "ask" | "deny"; reason?: string;       // PreToolUse, deny over ask over allow
  rewrite?: { input: unknown; from: Hook; ignored: Hook[] };  // the first in the file (design, "Tool hooks")
  context: { event: Event; text: string }[];                  // for the model, in file order, each cut (choice 7)
  messages: string[];          // systemMessage, each cut
  instructions: string[];      // PreCompact's plain output on exit 0, in file order, each cut (Task 11)
  output?: unknown;            // PostToolUse's updatedToolOutput
  deferred: boolean; failures: string[];
}
export function combine(event: Event, results: { hook: Hook; outcome: Outcome }[]): Combined;
```

**Behaviour:**
- **JSON** is one object with only white space around it (design, "What a hook's answer does"). It
  passes the event's checks when every field Tachikoma reads has the right JSON type, and
  `hookSpecificOutput`, if given, names this event; a field of the wrong type, or the wrong event
  name, makes it "JSON that could not be read". Output whose first character after white space is
  `{` is JSON, and an object cut short (`{"hookSpecificOutput":`) or with text after it is JSON
  that could not be read, a failure with its line, so `onFailure: "block"` still holds (design;
  plan review, 2026-11-09, finding 4). Any other output is plain text. A field printed as `null`
  is taken as left out, never as the wrong type, so `"reason": null` is no reason (the user's
  choice, 2026-11-09).
- **The table**, row by row, as the design gives it: exit 0, exit 2, any other code, against JSON
  that can be read, JSON that cannot, and plain text. With `onFailure: "block"`, or on Windows
  without Git Bash for a PreToolUse hook run by a shell with `onFailure` not set (`bash` false),
  every failure, any code but 0 and 2 included, is a block. Its reason is the failure's own
  words (the line after `hook failed: `) when the hook ran out of time, could not start, printed
  JSON that could not be read, or was ended by a signal with no error output; when it exited, or
  was ended by a signal, with error output, the reason is that output's first line, so a
  timeout's block says it ran out of time (the user's choice at Task 3's review).
- **The events that cannot block** (the user's choice at Task 3, following the design's table row
  "Cannot block; a failure's error output is shown to the user"): at SessionStart, SessionEnd,
  SubagentStart and PostCompact, exit 2 is a failure, `exited with code 2`, whatever was printed.
  `onFailure: "block"` and the Windows rule turn a failure into a block only at the five events
  that can block; elsewhere, PostToolUse and PostToolUseFailure included, it stays a red failure.
- **A hook ended by a signal** (no exit code) counts as any other exit code; its line names the
  signal (the user's choice at Task 3).
- **Which events can block:** UserPromptSubmit, PreToolUse, Stop, SubagentStop, PreCompact. A block
  on another is ignored, except at PostToolUse and PostToolUseFailure, where the call has already
  run: there a block's reason (`decision: "block"` and `reason`, or exit 2's error output) becomes
  text for the model, next to the result, and the call's outcome is unchanged (Claude Code's
  PostToolUse contract; plan review, 2026-11-09, finding 3).
- **Per event, the fields read:** `systemMessage` on every event (design, "What a hook's answer
  does"; plan review, finding 5); `continue` and `stopReason` on every event but SessionStart,
  SessionEnd, SubagentStart, PreCompact and PostCompact, where they are ignored (design);
  `decision: "block"` and
  `reason` on UserPromptSubmit, PostToolUse, PostToolUseFailure, Stop, SubagentStop, PreCompact;
  `hookSpecificOutput.additionalContext` on every event but SessionEnd, PreCompact and PostCompact;
  PreToolUse's `permissionDecision`, `permissionDecisionReason`, `updatedInput`, and the old
  `decision` values `approve` and `block` as `allow` and `deny`; PostToolUse's `updatedToolOutput`.
  Plain text on exit 0 is text for the model at SessionStart and UserPromptSubmit, and the summary's
  added instructions at PreCompact (Task 11 reads it); elsewhere it is ignored.
- **Combining:** a stop wins over everything; then deny, ask, allow; `defer` sets `deferred` and
  counts as no opinion; the first rewrite in the file wins and the rest are `ignored`; every
  context and message is kept.

**Tests:** every cell of the table, for PreToolUse; a deny on exit 1 refuses; with `onFailure:
"block"` the same is a failure that blocks; the Windows-without-Git-Bash rule; a top-level
`permissionDecision` is ignored, as Claude Code ignores it; `hookEventName` of another event makes
the JSON unreadable; deny over ask over allow in both orders; two rewrites; a 10,001-character
context is cut with `[cut: 1 more characters]`; `continue: false` with and without `stopReason`;
`{"hookSpecificOutput":` and `{"a": 1} trailing` on exit 0 are failures with their line, and with
`onFailure: "block"` they block (plan review, finding 4); PostToolUse's `{"decision": "block",
"reason": "Fix the lint errors"}` on exit 0 gives that reason as text for the model and no block
(finding 3); a SessionStart `systemMessage` is kept while its `continue: false` is ignored (finding
5).

Commit: `feat: a hook's answer read by Claude Code's table, and several hooks' answers combined`.

## Task 4: The Hooks object

**Files:** create `src/hooks/hooks.ts`, `tests/hooks/hooks.test.ts`; modify `src/core/bus.ts`
(error kind `hook`, event `hook-note`), `src/core/tasks.ts:207` (the kinds that do not fail a
subagent), `tests/core/tasks.test.ts`.

```ts
export interface Where { sessionId: () => string; transcript: () => string | undefined; root: string;
  mode: () => Mode; effort: () => Effort | undefined; agent?: { id: string; transcript?: string } }
export interface Run { event: Event; hook: Hook; ran: Ran; outcome: Outcome }   // for Ctrl+O (choice 24)
export class Hooks {
  constructor(config: HooksConfig, where: Where, bus: Bus);
  set(config: HooksConfig): void;            // a live edit (Task 12)
  get config(): HooksConfig;
  for(agent: { id: string; transcript?: string }, bus: Bus): Hooks;   // a subagent's: same hooks, its own fields and bus
  newPrompt(): void;                         // a new prompt_id (design, "What a hook is sent")
  fire(event: Event, fields: object, opts?: { match?: string; signal?: AbortSignal }): Promise<Combined>;
  readonly runs: Run[];                      // this turn's, emptied at each prompt
}
export const MODE_NAMES: Record<Mode, string> = { ask: "default", project: "acceptEdits", auto: "auto", never: "bypassPermissions" };
```

**Behaviour:**
- **`fire`** picks the hooks of the event whose matcher matches `match` (a tool's Claude Code name,
  SessionStart's source, and so on), drops a hook entry the same as an earlier one in every field
  (design, review finding 3), runs the rest at once with their time limits (600 s, 30 s at
  UserPromptSubmit), waits for them all, and combines them. With hooks off, or none matching, it
  runs nothing and returns an empty `Combined`.
- **The input** is the common fields, `session_id`, `transcript_path`, `cwd`, `hook_event_name`,
  `permission_mode` (by `MODE_NAMES`), `prompt_id` (absent before the first prompt), `effort`
  (`{ level }`, when the lead has one), and for a subagent `agent_id` and `agent_type: "Explore"`,
  then `fields`.
- **`async` hooks** are started and left: their failure is still reported when it comes, and so
  is an answer that asks to block (exit 2, or JSON that blocks or denies: what `combine` would file
  under `block` for a sync hook), with its own red line, and one that asks to stop the turn
  (`continue: false`, `combine`'s `stop`), with its own, which alone is said when it asks both,
  as a stop wins (the user's choices, 2026-11-09).
- **Lines:** each failure is a bus `error` of kind `hook` with the red line; each `systemMessage`
  a `hook-note` with its line. The other lines are said by the callers that act on the answer.
- **`set`** takes effect for the next `fire`; a `fire` under way finishes with the hooks it began
  with.
- **A hook's failure never fails a subagent.** `Tasks.#work` counts every error on the subagent's
  bus but `fallback`, `tool`, `judge` and `saving` as its failure (tasks.ts:207), which would turn
  a done subagent with a timed-out hook into a failed one; `hook` joins that list (plan review,
  2026-11-09, finding 1). A hook that stops a subagent does so through `continue: false` (Task 9),
  never through this event.
- **A subagent's hook lines reach the user** (second round, finding 3). A subagent's `Hooks` (from
  `for`) says its lines on the subagent's own bus, and `Tasks.#work` passes on only its usage and
  errors (tasks.ts:196-209). It now passes on each `hook-note` too, starting `<id>: `, as its
  errors' `attempted` does, so the window and `-p` show them through the lead's bus (Task 12).

**Tests:** matching, the same entry twice runs once, two alike but for `args` both run (finding 3);
the common fields for the lead and a subagent; `permission_mode` for each mode; a new prompt id
after `newPrompt` and none before; a failure's bus event and its words; `set` during a `fire`; hooks
off run nothing; an `async` hook is not waited for; a subagent whose hook times out still finishes
`done` with its answer (`tests/core/tasks.test.ts`; plan review, finding 1); a `hook-note` said on
a subagent's bus reaches the lead's bus starting `t1: ` (second round, finding 3).

Commit: `feat: the Hooks object: matching, running at once, the common fields, and a hook's lines`.

**End of Part 1:** run the whole suite once.

## Task 5: Tools in Claude Code's names, inputs and results

**Files:** create `src/hooks/tools.ts`, `tests/hooks/tools.test.ts`; modify `src/tools/tool.ts`
(`ToolContext.report`), `src/tools/shell.ts`, `src/tools/files.ts` (write_file),
`src/tools/delegate.ts`.

```ts
export function toClaude(call: { name: string; input: unknown }, paths: Paths): { tool_name: string; tool_input: Record<string, unknown> };
export function fromClaude(name: string, input: unknown, paths: Paths): { input: unknown } | { problem: string };
export function responseOf(name: string, text: string, parts?: unknown): unknown;   // choice 11
export function errorOf(name: string, text: string, parts?: unknown): string;       // choice 12
export function outputFrom(name: string, value: unknown): string | null;             // choice 13; null: not used
export interface Paths { toHost(p: string): string; fromHost(p: string): string }   // design, "Tool hooks"
export function pathsFor(root: string, box: { mode: "live" | "copy" } | null, platform?: NodeJS.Platform): Paths;
```

**Behaviour:**
- **Names and inputs** by the design's table; `todo`'s `done` is sent as `completed`; the inputs of
  choice 14 are left out. A path is made whole against the project's root.
- **Paths:** on the host they are the real ones, with the system's separators (backslashes on
  Windows, as Claude Code sends them). In live link `/work/x` becomes `<root>\x`. In copy mode they
  stay `/work/x`, and `fromHost` leaves them so.
- **`fromClaude`** turns a rewrite back: Claude Code's field names into Tachikoma's, a whole path
  back to the form the tool takes, `completed` back to `done`; an unknown tool, a missing field, a
  wrong type, or a field of choice 14 set otherwise is a `problem`, whose words name the field.
- **`report`:** `shell` reports `{ stdout, stderr, code }`, `write_file` `{ path, created }`,
  `delegate` `{ id, text }`; `responseOf` builds choice 11's shapes from them, and the text for the
  rest.

**Tests:** every tool both ways, round-tripping; `/work` paths in live link and copy mode;
backslashes on Windows (with `platform`); each `problem`; Bash's `error` starts `Exit code 1`;
Write's `type` is `create` for a new file and `update` for one there; `outputFrom` for a string,
Bash's shape, Agent's content, and a wrong shape (null).

Commit: `feat: Tachikoma's tools in Claude Code's names, inputs and results, for hooks`.

## Task 6: PreToolUse, the gate, and the record of a rewrite

**Files:** modify `src/core/session.ts` (`#execute`), `src/core/permissions.ts` (`withHook`),
`src/core/transcript.ts` (the `rewritten` line), `src/core/tasks.ts` (the subagent's session gets
`hooks.for(...)`), `src/cli.tsx` (making `Hooks` and handing it on); tests in
`tests/core/session.test.ts`, `tests/core/permissions.test.ts`, `tests/core/transcript.test.ts`.

```ts
// SessionOptions gains:
hooks?: Hooks;
// PermissionGate gains:
withHook(h: { allow: true } | { asked: true }): PermissionGate;   // for one call: the mode's question and the judge are skipped
```

**Behaviour** (design, "Tool hooks"; choices 10, 15, 16):
- **Before each call** `#execute` fires PreToolUse with `tool_name`, `tool_input` and `tool_use_id`,
  matched on the Claude Code name, under the turn's signal.
- **deny or a block:** the call is not run; the model gets the reason; outcome `declined`; the grey
  line `A PreToolUse hook refused <tool>: <reason>`.
- **ask:** in `never`, and in `-p` (the gate's `headless`), the call is refused with its line to the
  model. Otherwise one question is put, the call named as Ctrl+O names it, with the note; a no
  declines as any no does; a yes runs the tool with `gate.withHook({ asked: true })`.
- **allow:** the tool runs with `gate.withHook({ allow: true })`.
- **`withHook`'s gate:** `require` keeps every check of `never` (182-189), and asks for a protected
  part or a danger as now (a protected write in auto still goes to the judge, as now); only the
  path where nothing is protected and nothing dangerous skips `needsApproval` and the judge.
- **A rewrite:** `fromClaude` turns it back; a `problem` refuses the call with its line; otherwise
  the tool runs with the new input, the record of calls (`Session.calls`, filled at 350) has the
  call's entry replaced with it, and the transcript gets `{ t: "rewritten", id, input }` before the
  call runs. Two rewrites give their line. `readTranscript` puts each saved rewrite in its call's
  place, for every call before and after a shortening.
- **`defer`** gives its line and counts as no opinion.
- A stop while a PreToolUse hook runs kills it, and the call is cancelled as now.
- **Context** from the hooks is held for Task 7 to put after the results.

**Tests:**
- In each of the four modes and in `-p`: deny refuses; allow runs a shell command `ask` mode would
  ask about, with no question; allow on a dangerous command still asks (ask, project, auto) and
  still refuses (`never`, `-p`); allow on a protected write in `project` still asks; ask in
  `project` on a read asks once, and a yes runs it with no second question; ask in `never` and `-p`
  refuses with each line.
- The user's `sfw` hook's shape: a rewrite of `npm install x` to `sfw npm install x` is what runs,
  and the gate's dangerous-command check sees the rewritten command.
- A rewrite of a read from A to B: `Session.calls` holds B; after a resume (`readTranscript`), it
  still does (finding 4); the reply in the history still says A.
- A rewrite with `replace_all: true` refuses the call with its line.
- A subagent's call fires PreToolUse with `agent_id`.

Commit: `feat: PreToolUse: a hook's deny, ask and allow against Tachikoma's checks, and its rewrite kept in the record`.

## Task 7: After a call, and a hook that stops the turn

**Files:** modify `src/core/session.ts` (`#execute`, `#turn`); tests in
`tests/core/session.test.ts`.

**Behaviour:**
- **After a call that ran,** PostToolUse fires with `tool_input` (the input that ran),
  `tool_response` (`responseOf`), `tool_use_id` and `duration_ms`; after one that failed,
  PostToolUseFailure with `error` (`errorOf`), `is_interrupt: false` and `duration_ms`. Neither
  fires for a call that was refused, declined, cancelled, of an unknown tool, or with an input the
  tool's schema refused (Claude Code's rule).
- **Their answer:** a block's reason, exit 2's error output and `additionalContext` go after the
  results as hook text (choice 6); `updatedToolOutput` replaces what the model reads when
  `outputFrom` can use it (choice 13). The call's outcome is unchanged.
- **`continue: false`** from a PreToolUse, PostToolUse or PostToolUseFailure hook stops the turn as
  a user's stop does (design, review finding 1): a controller of the reply's own, joined to the
  turn's signal, is stopped, so a running `delegate` ends as a stopped one; every call gets exactly
  one result (the call whose PreToolUse said it: not run; a call whose Post hook said it: its own
  result; calls not started: `Not run: a hook stopped the turn.`); the one results message is
  pushed and saved as now; then the turn ends with the grey line, and `send` returns `{ stopped }`
  (choice 17).

**Tests:**
- PostToolUse gets Bash's shape for a shell call, and `Write`'s `type`; PostToolUseFailure's `error`
  starts `Exit code 1` for a failing command; neither fires for a declined call.
- `updatedToolOutput` as a string replaces a read's result; a wrong shape is ignored.
- `continue: false` from the first of three calls while a `delegate` runs: the delegate is stopped,
  each call has one result, the next request is taken by the stand-in model, and the session
  resumed from its transcript loads with every call answered (finding 1).

Commit: `feat: PostToolUse and PostToolUseFailure, and a hook that stops the turn leaving every call answered`.

**End of Part 2:** run the whole suite once.

## Task 8: Text for the model, and UserPromptSubmit

**Files:** modify `src/core/types.ts` (`from?: "tasks" | "hooks"`), `src/core/session.ts` (`send`,
`#turn`, a queue of hook text), `src/tui/app/queue.ts` (the send at 189),
`src/tui/app/promptKeys.ts` or `output.ts` (putting words back), `src/cli.tsx` (`-p`'s exit code and
lines); tests in `tests/core/session.test.ts`, `tests/cli.test.ts`, `tests/tui/app.test.tsx` ("App's
hooks").

**Behaviour** (choices 6, 17):
- **Hook text** is a text part `from: "hooks"`, headed `<Event> hook:`. It is saved with its
  message, so a resume has it without running the hook again. The export and Ctrl+O show it as
  they show the subagents' waiting text.
- **`Session` keeps text waiting for the next request** (SessionStart's, Task 10), sent at the
  start of the next user message.
- **UserPromptSubmit** fires in `send` for the lead only, after `hooks.newPrompt()`, with `prompt`
  (the words with each picture as its marker), under a 30 s limit, before the message is pushed.
  A block, or `continue: false`, sends nothing and saves nothing: `send` returns `{ blocked: reason
  }` or `{ stopped }`, with the grey line. Its context and plain text join the prompt's message.
- **The window** puts the words back into the prompt box (the pictures too, as `restore` does) and
  adds `Your words are back in the prompt box.`
- **`-p`** writes the line to its error output as a note and exits with code 1.

**Tests:** a block in the window leaves the words in the box and no message saved; a block in `-p`
exits 1 with the line (`tests/cli.test.ts`, with a hook script in the test's home); context reaches
the stand-in model's request with the prompt, headed; a subagent's brief fires no UserPromptSubmit;
the judge's prompts do not hold hook text; a resumed session has the hook text and does not run the
hook.

Commit: `feat: UserPromptSubmit, and hook text sent to the model where Claude Code puts it`.

## Task 9: Stop, SubagentStart and SubagentStop

**Files:** modify `src/core/session.ts` (the end at 348), `src/core/tasks.ts` (`#work`, `#run`);
tests in `tests/core/session.test.ts`, `tests/core/tasks.test.ts`.

**Behaviour** (choices 8, 21):
- **At a turn's normal end** (348) the lead's session fires Stop, a subagent's SubagentStop, with
  `stop_hook_active` (true when a Stop hook kept this turn going before), `last_assistant_message`,
  and, at Stop, `background_tasks` and `session_crons: []`; at SubagentStop `agent_id`,
  `agent_type`, `agent_transcript_path`.
- **A block, or context,** pushes a user message with `Stop hook feedback:` and the reason (or the
  hook text) and goes round the loop again; the grey line names the hook's reason. Eight in a row
  with no tool call between end the turn with its line; a reply with a call starts the count again.
- **`continue: false`** at Stop ends the turn with its line; in a subagent's session, at any of its
  events, it ends the subagent, whose state is `stopped` and whose result is `<id> was stopped by
  a hook: <stopReason>` (design).
- **SubagentStart** fires in `#work` before the subagent's first request, matched on `Explore`; its
  context goes into the subagent's first message.

**Tests:** a Stop block keeps the turn going once and the model sees the feedback; nine blocks give
eight more requests, then the line; a tool call between restarts the count;
`last_assistant_message`; `background_tasks` lists a running background subagent; SubagentStart's
context is in the subagent's first request; a SubagentStop block keeps it going; `continue: false`
in a subagent stops it with its result and leaves the lead's turn going.

Commit: `feat: Stop, SubagentStart and SubagentStop, with Claude Code's limit of eight blocks`.

## Task 10: SessionStart and SessionEnd

**Files:** modify `src/cli.tsx` (the launch, `-p`'s end, the window's end), `src/tui/app/queue.ts`
(`switchTo`, `leave`); tests in `tests/cli.test.ts`, `tests/tui/app.test.tsx`.

**Behaviour** (choices 18, 19):
- **SessionStart** fires once the conversation is loaded (cli.tsx:643 and 764): `startup` for a new
  session, `resume` for `-c` and `-r`, `fork` for `--fork-session`; and in `switchTo` after the
  load: `clear`, `resume`, `fork` for `/branch`; and after a shortening, `compact` (Task 11). Its
  fields are `source` and `model`. Its context and plain text wait for the next request (Task 8),
  except after a shortening, where they join the shortened message (Task 11).
- **SessionEnd** fires with `reason`: `prompt_input_exit` when the user leaves the window (after the
  copy-mode review, before Ink's exit), `other` at the end of a `-p` run and before `/branch`'s
  switch, `clear` and `resume` before those switches. Its hooks share 1.5 s, raised by a hook's own
  longer `timeout` to 60 s at most; a hook still running then is killed, and a failure is reported
  as any is.
- A signal runs no SessionEnd (choice 19).

**Tests:** each source and reason, from a hook script that writes its input to a file in the test's
folder; SessionStart's context reaches the first request; a SessionEnd hook that sleeps is killed at
1.5 s and the window still closes; `/branch` gives `other` then `fork`.

Commit: `feat: SessionStart and SessionEnd at the launch, the window's commands and the end`.

## Task 11: PreCompact and PostCompact

**Files:** modify `src/core/session.ts` (`#shorten`, `compact`); tests in
`tests/core/session.test.ts`.

**Behaviour** (choice 20):
- **PreCompact** fires in `#shorten` beside `onShorten`, before the summary request, with `trigger`
  (`manual` from `compact`, `auto` otherwise) and `custom_instructions` (the focus, or null). A
  block returns `{ problem: "a PreCompact hook blocked it: <reason>" }`, so 8a's line says it and
  nothing changes. Plain text on exit 0 joins the focus.
- **PostCompact, then SessionStart `compact`,** fire once the summary is made and before it is saved
  (plan review, 2026-11-09, finding 2): PostCompact with `trigger` and `compact_summary`, then
  SessionStart with `source: "compact"`. SessionStart's context and plain text join the shortened
  history's one message (`r.messages[0]`, the message the `shortened` line saves) as hook text, so
  they are saved with the shortening and go with the very next request, which inside a turn is
  sent at once. They never wait in Task 8's queue. If the `shortened` line then cannot be written,
  nothing changes, as in 8a, though those hooks have run: a known limit for the README.
- **The shortened message is checked again with the hook text in it** (second round, finding 2):
  `shorten()` checked the message against the window without it (shorten.ts:104-108, `fit`), and a
  turn has one shortening only, so text that pushed the request over would end the turn. `fit` is
  exported, and `#shorten` checks the message with the text added. If it no longer fits, the text
  is left out, the shortening is saved without it, and the grey line `SessionStart hook text was
  left out: with it, the shortened conversation would not fit the model's window.` says so; the
  text is never cut to fit, as no part of a hook's text is safe to drop.
- `onShorten` stays for 8d's memory save.

**Tests:** a block leaves the history unchanged with the 8a line and its reason, for `/compact` and
for a turn's shortening; plain text reaches the summary request; PostCompact gets the summary;
SessionStart `compact` follows it; in a turn that shortens before its request, the stand-in model's
very next request holds SessionStart's context, and a resume reads it back in the shortened
message (finding 2); with a stand-in model whose window fits the summary but not the summary and
the hook's text, the shortening is saved without the text, the line is said, and the turn's
request is sent (second round, finding 2).

Commit: `feat: PreCompact and PostCompact around each shortening`.

**End of Part 3:** run the whole suite once.

## Task 12: What the user sees

**Files:** modify `src/tui/App.tsx` (`onError` for `hook`, a `hook-note` listener), `src/cli.tsx`
(`-p`'s lines, the launch's warnings and Git Bash line), `src/tui/app/liveEdits.ts` (applying
`hooks` and `disableAllHooks`), `src/tui/app/describe.ts` and `promptKeys.ts` (Ctrl+O),
`src/tui/app/queue.ts` (`/hooks`, the waiting line), `src/tui/app/constants.ts`,
`src/tui/app/menus.ts` (the name, the menu); tests in `tests/tui/app.test.tsx` ("App's hooks"),
`tests/cli.test.ts`.

**Behaviour** (choices 22-25; design, "What the user sees"):
- A failure is red with the line alone; a `hook-note` grey; in `-p` a failure goes to the error
  output as `hook: <line>`, a note as `note: <line>`.
- **A hook's failure never fails a `-p` run** (plan review, 2026-11-09, second round, finding 1):
  `-p`'s error listener (cli.tsx:624-629) counts every kind but `tool`, `fallback`, `judge`,
  `saving` and a sent `shortening` as failing the run; `hook` joins that list, as it joins the
  subagents' (Task 4). What does end a run with code 1 is said where it happens: a blocked prompt
  (Task 8) and a hook's `continue: false` (choice 9).
- While a hook with a `statusMessage` runs, the waiting line's label is its message, then back.
- Ctrl+O lists `hooks.runs` after the calls.
- `/hooks` prints the list, its left-out rows, or its empty and off lines.
- **A live edit** of `hooks` or `disableAllHooks` calls `hooks.set` and says the changed line; a
  broken file keeps the hooks in force, as other entries do.
- At the launch, the warnings print as other settings warnings do, and the Git Bash line once when
  a hook run by a shell is in force and none is found.

**Tests:** each line in the window and in `-p`; a `-p` run whose PreToolUse hook fails, then
answers, exits 0 with the hook's line on its error output (second round, finding 1); a subagent's
`systemMessage`, its SubagentStop block and its `continue: false` line reach the window and `-p`'s
error output, each starting with its id (finding 3); Ctrl+O after a turn with a hook run and a
rewrite; `/hooks` with hooks, with left-out ones, with none, and off; a live edit adding a hook
makes the next call fire it, with the line; the waiting line shows a `statusMessage`.

Commit: `feat: hooks on the screen: their lines, Ctrl+O, /hooks, and live edits`.

## Task 13: Documents and the terminal checklist

**Files:** modify `README.md`, `docs/plans/2026-11-09-tachikoma-release-8b-design.md` (an "As built"
section).

**What changes:**
- **The README:** a "Hooks" section (the entry, the events, what a hook is sent, what its answer
  does, the tools' names, the sandbox, what you see, `/hooks`); the known limits from the design and
  choice 19, and two from Task 2's review: a bare `npx` (or any `.cmd`) is "not found on PATH", as
  only `.exe` is looked for; a hook that leaves a background program holding its output is
  reported as out of time, so redirect that program's output; and one from Task 3's review: a
  hook's output is read whole, so a runaway hook's output is held in memory until its time limit
  ends it; and two from Task 4's review: a turn stopped while hooks run shows no line for a hook
  that had already failed, and Ctrl+O lists none of that turn's runs; a subagent's runs are kept
  for its whole life, each hook's output held in memory; the release list with 8 in five
  parts, 8e added; `/hooks` in the commands list.
- **The design** gets an "As built" section listing this plan's choices as the user settled them.

**All README wording goes to the user before it is committed.**

**The terminal checklist,** for the user in Windows Terminal, in a practice project:
1. The user's own `sfw` hook: the model is asked to run `npm install left-pad`; the question shows
   `sfw npm install left-pad`. (Say no: no install is wanted.)
2. The user's protected-paths hook: the model is asked to edit a file the hook protects; the call is
   refused with the hook's reason.
3. The user's MemPalace SessionStart hook: the first reply shows the model has its text.
4. A Stop hook that blocks once, then Ctrl+O.
5. `/hooks`, then a live edit adding a hook, then `/hooks` again.
6. A hook that fails, and one that runs out of time.
7. A UserPromptSubmit hook that blocks: the words are back in the box.
8. `/compact` with a PreCompact hook that blocks.
9. Copy mode: a PreToolUse hook that logs `file_path` shows `/work/...`.
10. `tachi -p` with a blocking UserPromptSubmit hook: exit code 1.

The checklist's hooks are copied by the user into `~/.tachikoma/settings.json`; the plan's builder
never writes the user's settings file.

Commit: `docs: release 8b in the README, and the design as built`.
