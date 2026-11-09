# Tachikoma release 8b: hooks, design (2026-11-09)

Release 8b is the second of release 8's parts. The overall design, the Decisions table and the
release order are in [2026-10-22-tachikoma-design.md](2026-10-22-tachikoma-design.md). Its row
"Hooks" already settles two things (user, 2026-11-06; options chosen: "Claude Code's format", "Your
settings file only"): hooks are written in Claude Code's format, with its event names, so a hook
script made for Claude Code works unchanged; and they are read from `~/.tachikoma/settings.json`
only, never from a project's files. Release 8a left an empty "before shortening" step
(`Session.onShorten`) for 8b's PreCompact hooks to join.

Every choice below was the user's, on 2026-11-09, from options offered; "option chosen" quotes it.

## Sources

- Claude Code's hooks reference, <https://code.claude.com/docs/en/hooks>, and hooks guide,
  <https://code.claude.com/docs/en/hooks-guide>, read 2026-11-09. Every number in this design
  (time limits, the 10,000-character cap, the 8 Stop blocks) is Claude Code's documented value;
  none has been measured for Tachikoma, and the README says so, as release 7 did for the judge's
  limits.
- Claude Code's tools reference, <https://code.claude.com/docs/en/tools-reference>, read
  2026-11-09: the subagent tool is `Agent`, and `TodoWrite` is the whole-list to-do tool.
- The user's own setup, read 2026-11-09. `~/.claude/settings.json` holds three hooks, all of the
  command kind: a PreToolUse protected-paths check on `Edit|Write|MultiEdit|NotebookEdit` (a Node
  script that reads `tool_input.file_path` and blocks with exit code 2); a PreToolUse `sfw` check on
  `Bash`, run by `bash` with `jq`, that reads `tool_input.command` and rewrites it through
  `updatedInput`; and a SessionStart MemPalace wake-up that hands the model text through
  `additionalContext`. The eight plugins installed use only command hooks too, at ten events:
  SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop,
  SubagentStop, PreCompact and Setup.

## What 8b covers

Command hooks only, at 11 events (option chosen: "Core 11, commands"). Any other event or hook
kind in the file gets a warning at the launch and is left out; the rest of the file applies.

| Event | When it fires in Tachikoma |
|---|---|
| SessionStart | At the launch (`startup`); `tachi -c`, `-r` and `/resume` (`resume`); `/clear` (`clear`); after a shortening (`compact`); `--fork-session` and `/branch` (`fork`) |
| SessionEnd | When the session ends: the user quits (`prompt_input_exit`), `/clear` (`clear`), `/resume` (`resume`), anything else (`other`). Claude Code's short time budget, so quitting is never held up |
| UserPromptSubmit | Each prompt the user sends, before it goes to the model. A subagent's brief is not one: the lead wrote it |
| PreToolUse | Before every tool call, the lead's and the subagents' |
| PostToolUse, PostToolUseFailure | After a call succeeds, or fails |
| Stop | When the lead's turn ends normally; not when the user stops it, or a provider error ends it |
| SubagentStart, SubagentStop | When a `delegate` subagent starts, and finishes |
| PreCompact, PostCompact | Around each shortening: `manual` for `/compact`, `auto` for every other. PreCompact runs in 8a's "before shortening" step |

## The settings entry

Claude Code's shape: `"hooks": { "<Event>": [ { "matcher": "...", "hooks": [ { "type":
"command", ... } ] } ] }`. A command hook's fields:

- `command`; `args`, which starts the program directly, with no shell; `shell`, `"bash"` or
  `"powershell"`; `timeout`, in seconds; `async`, which runs the hook in the background and ignores
  its answer; `onFailure`, `"continue"` or `"block"`; `statusMessage`.
- `if` uses Claude Code's permission-rule syntax, which Tachikoma does not have: a hook with one is
  left out, with a warning, since running it every time would be wrong (Claude Code runs it only
  when the condition matches).
- `asyncRewake` gets a warning, and the hook runs as plain `async`.
- `once` is ignored without a word, as Claude Code ignores it in settings files.

`"disableAllHooks": true` turns every hook off.

Matchers follow Claude Code's rules: empty or `*` matches everything; only letters, digits, `_`,
`-`, spaces, commas and `|` means exact names (`Edit|Write`, `Edit, Write`); anything else is an
unanchored JavaScript regular expression. Matching minds letter case. A matcher on an event that
takes none is ignored, as in Claude Code.

## Running a hook

- **Always on the user's machine, never in the box:** hooks are the user's own commands. It starts
  in the real project folder, with the environment Tachikoma's commands get (`commandEnv`) plus
  `CLAUDE_PROJECT_DIR`, the real project folder, under Claude Code's name so scripts find it.
- **The shell, as Claude Code's:** on Windows, Git Bash, found where Git for Windows installs it or
  at `CLAUDE_CODE_GIT_BASH_PATH`, and Windows PowerShell when there is none; elsewhere `sh -c`. A
  hook's `shell` overrides it; `args` skips the shell. On Windows without Git Bash, a PreToolUse
  hook's answer counts only from exit code 0 or 2, as in Claude Code ("What a hook's answer
  does"). The shell tool keeps PowerShell.
- **Several at once:** every hook that matches an event runs at the same time. A hook entry that is
  the same as another in every field (`command`, `args`, `shell`, `timeout`, `async`, `onFailure`,
  `statusMessage`), the same hook listed under two matchers say, runs once; two that differ in any
  field, such as `node` with `args: ["audit.js"]` and `node` with `args: ["protect-paths.js"]`, both
  run (review, 2026-11-09, finding 3: Claude Code's docs say only that "the same handler" runs
  once). Tachikoma waits for them all, then acts on their answers.
- **Time limits, Claude Code's:** 600 s by default; 30 s at UserPromptSubmit; at SessionEnd, 1.5 s
  shared by all its hooks. A hook still running at its limit, or when the user stops the turn, is
  killed with everything it started, as the shell tool's commands are (`killTree`).
- **In `-p` runs** hooks run too, as in Claude Code.

## What a hook is sent

One JSON object on its input, in Claude Code's field names.

On every event: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`, and
`prompt_id`, a new id for each prompt the user sends, on every event from then until the next
prompt (absent before the first). `effort`, `{"level": ...}`, when the lead has one: Tachikoma's
five levels are Claude Code's. In a subagent's session, `agent_id` (`t1`) and `agent_type`.

- `transcript_path` is Tachikoma's own session file, whose lines are not Claude Code's (a known
  limit).
- `permission_mode` is the mode under its nearest Claude Code name: `ask` as `default`, `project`
  as `acceptEdits`, `auto` as `auto`, `never` as `bypassPermissions`.
- `agent_type` is `Explore`, Claude Code's name for its read-only subagent, as Tachikoma's
  subagents only read.

| Event | Its own fields |
|---|---|
| SessionStart | `source`, `model` (the lead) |
| SessionEnd | `reason` |
| UserPromptSubmit | `prompt`, as typed, each picture as its marker |
| Stop | `stop_hook_active`, `last_assistant_message`, `background_tasks` (each running background subagent: `id`, `type`, `status`, `description`, `agent_type`), `session_crons` (always `[]`) |
| SubagentStart | `agent_id`, `agent_type` |
| SubagentStop | `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `stop_hook_active` |
| PreCompact | `trigger`, `custom_instructions` (the `/compact` words, or null) |
| PostCompact | `trigger`, `compact_summary` |

`scratchpad_dir` is left out: Tachikoma has no such folder, and Claude Code leaves it out when it
has none. `session_crons` is an empty list rather than missing, so a script that loops over it
works. The tool events' fields are under "Tool hooks".

## What a hook's answer does

Claude Code's table, from its hooks reference ("Exit code output"; review, 2026-11-09, finding 2).
A hook's output is JSON only when it is one object with nothing but white space around it, and
that object passes the event's checks (the right types, `hookSpecificOutput.hookEventName` naming
the event); anything else that starts as JSON is JSON that cannot be read.

| Output | Exit 0 | Exit 2 | Any other exit code |
|---|---|---|---|
| JSON that can be read | Success: the fields apply | A block: the fields are read but cannot undo it | Success: the exit code is ignored and the fields alone decide (a PreToolUse deny on exit 1 still refuses) |
| JSON that cannot be read | A failure, its line naming what is wrong | A block, the error output the reason | A failure, its line naming what is wrong |
| Plain text, or nothing | Success | A block, the error output the reason | A failure, its line the first line of the error output |

A failure blocks nothing and gets a red line; so does a hook that cannot start or runs out of
time. A block happens only on the events that can block. Two cases turn a failure into a block,
as exit 2, and there the exit code is not ignored, so any code but 0 or 2 is a failure even with
JSON that can be read:
- `"onFailure": "block"`;
- on Windows without Git Bash, a PreToolUse hook run by a shell with `onFailure` not set (Claude
  Code's rule; `"onFailure": "continue"` turns it off).

On the events with a turn to end, `"continue": false` ends it, its `stopReason` shown to the user:
- at PreToolUse, PostToolUse or PostToolUseFailure, the turn stops as a user's stop does, so the
  history stays one the providers take and a resume can load (review, 2026-11-09, finding 1).
  Every call of the reply gets exactly one result before the turn ends: the call whose
  PreToolUse said it is not run; one whose PostToolUse said it keeps its own result; calls not
  started get "Not run: a hook stopped the turn."; a `delegate` already running is stopped, as Esc
  stops it, with the result a stopped one gets now. All of them go into the one message of
  results, saved as now, then the turn ends. Claude Code's docs do not say what happens to the
  other calls of the reply;
- at UserPromptSubmit the prompt is not sent, as with a block; at Stop the turn ends, no block
  keeping it going;
- in a subagent's session it ends that subagent, as `/tasks` stopping it does, never the lead's
  turn; at SubagentStop likewise;
- at SessionStart, SessionEnd, SubagentStart, PreCompact and PostCompact it is ignored: the first
  three have no turn to end, and Claude Code discards it at the last two and at SessionEnd.

`systemMessage` is shown to the user as a line, on every event.

**Text for the model** (`additionalContext`, or plain output at SessionStart and UserPromptSubmit)
goes with the next request, marked as a hook's, as a background subagent's answer travels now. The
user does not see it in the conversation; Ctrl+O shows it. It is saved in the session's file, so a
resumed session has it without running the hook again, as Claude Code does. Each piece is capped at
Claude Code's 10,000 characters, the rest cut with "[cut: N more characters]" (Claude Code saves
the rest to a file instead).

| Event | A block, or its answer |
|---|---|
| UserPromptSubmit | A block: the prompt is not sent, the reason is shown to the user, not the model, and the words go back into the prompt box, so nothing is lost (Claude Code's docs do not say what it does with them) |
| Stop | A block keeps the turn going: the reason goes to the model as the next thing it reads. After 8 blocks in a row with no tool call between them, the turn ends anyway |
| SubagentStop | The same, for that subagent |
| PreCompact | A block: no shortening; one needed to fit the window ends the turn with 8a's line, "The conversation could not be shortened (a PreCompact hook blocked it: *reason*); it is unchanged." Plain output on exit 0 joins the summary request's instructions, as `/compact`'s words do |
| SessionStart, SessionEnd, SubagentStart, PostCompact | Cannot block; a failure's error output is shown to the user |

## Tool hooks

**Claude Code's names and inputs** (option chosen: "Claude Code's"):

| Tachikoma tool | Hooks see | Input |
|---|---|---|
| `shell` | `Bash` | `command` |
| `read_file` | `Read` | `file_path`, `offset`, `limit` |
| `write_file` | `Write` | `file_path`, `content` |
| `edit_file` | `Edit` | `file_path`, `old_string`, `new_string` |
| `find_files` | `Glob` | `pattern` |
| `search_files` | `Grep` | `pattern`, `path`, `glob` |
| `delegate` | `Agent` | `description`, `prompt`, `run_in_background` |
| `todo` | `TodoWrite` | `todos: [{content, status}]`, `done` sent as `completed` |

Paths are given whole. On the user's machine, and in live link, they are the real project's: the
box's `/work` is turned into the real folder. In copy mode they stay the box's (`/work/...`), so
checks on names (`.env`, `.git`) still work, but no hook can open or change the copy, or the real
file, by them (option chosen: "Real in live, box's in copy"). Tachikoma never opens the copy's
files on the host while the box runs, as the box can plant links in it (release 7 design).

**PreToolUse** is sent `tool_name`, `tool_input` and `tool_use_id`, and runs before Tachikoma's own
check. Answers combine as Claude Code's do, deny over ask over allow (option chosen: "Allow skips
only the ask"):
- **deny, or exit 2:** the call is refused in every mode, `-p` included; the reason goes to the
  model.
- **ask:** the user gets the usual question, with "A hook asks:" and its reason above it; in
  `never` and in `-p`, where nobody can answer, the call is refused.
- **allow:** skips the mode's question and auto mode's judge, never the dangerous-command check, a
  protected path, or never mode's refusals, which still ask or refuse as they do now.
- **defer:** no opinion, with a warning; Claude Code ignores it too, outside a narrow `-p` case.

**Rewriting** (`updatedInput`): the new input replaces the old whole, is turned back into
Tachikoma's fields, and Tachikoma's checks look at it as if the model had sent it; Ctrl+O shows the
model's call and the rewrite. When two hooks rewrite one call, the first in the file wins and a
line names the one ignored (Claude Code's docs say which wins is not guaranteed). A rewrite the
tool cannot take, a field missing or of the wrong type, refuses the call, with a line naming the
hook.

**What a rewrite leaves in the record** (review, 2026-11-09, finding 4). The model's reply is kept
as it sent it, as the history is never edited and the providers are sent it so. What the session
records as run is the input that ran: the list of calls the judge reads and shortening's recent
files come from (`Session.calls`) takes the rewritten input, in Tachikoma's fields, before the call
runs, so a hook that turns a read of A into B leaves B there. The rewrite is saved in the session's
file with the call's id, before the call runs, and a resume rebuilds the list from the reply with
each saved rewrite in its call's place, so the record survives a resume. PostToolUse and
PostToolUseFailure are sent the input that ran.

**PostToolUse and PostToolUseFailure** are sent the call and its result (`tool_response`) or its
error. Their answer can add to what the model reads (a block's reason, `additionalContext`, error
output on exit 2), or replace the result the model reads (`updatedToolOutput`). Claude Code's
`tool_response` has its own shape for each tool (Bash's `stdout` and `stderr` apart, say); the plan
reads each from Claude Code's docs and matches it where Tachikoma has the parts, leaving out what
it lacks.

A subagent's calls fire the same hooks, with `agent_id` and `agent_type`. Esc or Ctrl-C while a
PreToolUse hook runs kills it, and the call is cancelled.

## What the user sees

As Claude Code (option chosen: "As Claude Code"):
- A hook that succeeds says nothing.
- A line when a hook blocks something, naming the event and its reason; a red line when one fails,
  cannot start, or runs out of time, with the first line of its error output, which also goes in
  the error log; a hook's `systemMessage` as a grey line. The plan gives every line's words for
  the user to approve.
- While a hook runs, its `statusMessage` shows on the waiting line.
- Ctrl+O lists each hook that ran in the last turn: its event and command, its exit code and time,
  any text it handed the model, and any rewrite.
- `/hooks` lists the hooks in force, read-only, by event, with each one's matcher, command and time
  limit, and the hooks left out, each with why. They are changed in the settings file.
- At the launch, each event, kind or field left out gets a warning, as an unknown setting does.
- In `-p` runs the lines go to the error output, as other lines do there. A failed hook does not
  fail the run; a blocked prompt does, with exit code 1 and its reason, as it was never sent.

**Live edits** (option chosen: "Live, with a line"): a saved change to the hooks applies from the
next event, with a grey line such as "Hooks changed: 4 hooks at 3 events." A broken `hooks` entry
keeps the hooks in force and says why, as other live settings do. A hook already running finishes
as it started.

## Known limits

- Hooks run with the user's full permissions, outside the sandbox: the box does not hold them back.
- `transcript_path` is Tachikoma's session file, whose lines a script reading Claude Code's will
  not understand.
- The numbers are Claude Code's, not measured for Tachikoma.
- `if` hooks are left out; `asyncRewake` runs as plain `async`.
- In copy mode a hook that changes files, such as a formatter, cannot reach them.
- On Windows, a hook with `args` must start a real `.exe`; npm's `.cmd` wrappers cannot be started
  so (Claude Code's limit too).
- `CLAUDE_ENV_FILE`, where a session-start hook sets variables for later commands, is not given.

To confirm in the plan: a model's command cannot add a hook unseen in the sandbox, as the home
folder's `~/.tachikoma` is not in the box; on the host a shell command could edit the settings
file, which is no more than such a command can already do. The README says both plainly.

## Testing

- Unit tests for the rules: matchers, the exit-code and JSON table (a deny on exit 1 refuses; with
  `onFailure: "block"` it is a failure that blocks), the tool names and fields both ways, deny over
  ask over allow, the caps, and two entries alike but for `args` both running.
- Real hook programs: small Node scripts started directly (`args`, no shell), quick on any system;
  the Git Bash tests are skipped where it is not installed.
- Session tests with a stand-in model, no network: each event fires at its moment; PreToolUse
  against Tachikoma's check in all four modes and in `-p`; the sandbox's path rule; a live edit;
  `"continue": false` from the first of three calls while a `delegate` runs, leaving one result
  per call, the next request taken and the session resumed; a rewritten read whose new path is
  in the record of calls, and still there after a resume.
- The user's three real hooks in the terminal checklist: the `sfw` rewrite, the protected-paths
  block, the MemPalace text at session start.
- CI runs it all on Windows for the pull request.

## Not in this release, and when

Option chosen: "Yes that looks fine", for these homes:

| Left out of 8b | When |
|---|---|
| The `mcp_tool` hook kind; Elicitation and ElicitationResult; `mcp__...` tool names in matchers | 8c, with the MCP client |
| UserPromptExpansion | Release 10, with skills |
| Setup | Release 14, with `tachi setup` |
| Importing Claude Code's hooks, the user's and plugins', into Tachikoma's file | Release 14's first-run import |
| PermissionRequest, PermissionDenied (auto mode's judge refuses), StopFailure, Notification, PreModelSwitch and PostModelSwitch (`/lead`), PostToolBatch, InstructionsLoaded, ConfigChange, FileChanged, CwdChanged | 8e, a new small part after 8d: each has its place in Tachikoma already |
| The `http`, `prompt` and `agent` hook kinds; `if`; `asyncRewake`; `CLAUDE_ENV_FILE` | Not planned: nothing in the user's setup uses them |
| TaskCreated, TaskCompleted, TeammateIdle, WorktreeCreate, WorktreeRemove, MessageDisplay | Probably never: they belong to Claude Code features Tachikoma has not got |
| Hooks from a project's files, and the folder-trust question | Never (user, 2026-11-06: "Your settings file only"); with only the user's file read, no trust question is needed |

## As built

Where the build differs from the design above, or settles what it left open. The plan
(`2026-11-09-tachikoma-release-8b.md`) lists its 25 choices, each marked in its task, with every
line the build added in its table "Lines this plan adds"; every number here is from the plan's
table "Numbers in this plan" or from the code's comments, as cited there. "The user's choice"
marks the user's answers, given on 2026-11-09 and 2026-11-10 from options offered. The README's
known limits gather every rarer case the build left as a limit.

- **The settings entry (Task 1).** A hook's `timeout` is a number of seconds above 0 and no more
  than 2147483, the longest wait Node's `setTimeout` takes (the user's choice). A key in an entry
  other than `matcher` and `hooks` is left out with a warning, and the entry's hooks are still
  read; each warning about one hook ends with its command and args, so two alike can be told apart
  (the user's words at Task 1's review). With `disableAllHooks` the hooks are still read and warned
  about, so `/hooks` can say what is off.
- **Running a hook (Task 2; choices 1-5).** Git Bash is looked for, once per process, in this
  order: the file `CLAUDE_CODE_GIT_BASH_PATH` names, when it is an existing `bash.exe`, `sh.exe`,
  `bash` or `sh`; `bin\bash.exe` beside the folder of the first `git.exe` on PATH;
  `%ProgramFiles%\Git\bin\bash.exe`; then `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`. Never a bare
  `bash` from PATH, which on the user's PC is WSL's. Without it, a hook run by a shell runs in
  Windows PowerShell, and the launch says so once. A command, or a shell, named without a folder is
  found on PATH and started by its full path, so the project folder is never searched for it; one
  not there could not start, `not found on PATH` (the user's choice). As only `.exe` is looked for
  on Windows, a bare `npx` is not found (a known limit). A hook's output is read whole, so a long
  JSON answer can still be read, and each text it hands on is cut at 10,000 characters (the user's
  choice); its error output is cut at 30,000 characters, as a command's is.
- **Reading the answers (Task 3).** A field printed as `null` counts as left out (the user's
  choice). A failure's line names the signal that ended a hook with no exit code, and a timeout's
  line the limit in force (the user's choices). A block made from a failure (`onFailure: "block"`,
  or the Windows rule) has the failure's own words as its reason, unless the hook exited, or was
  ended by a signal, with error output, whose first line is then the reason, so a timeout's block
  says it ran out of time (the user's choice at Task 3's review). At SessionStart, SessionEnd,
  SubagentStart and PostCompact exit 2 is a failure, `exited with code 2`, and `onFailure:
  "block"` changes nothing there, following this design's row "Cannot block" (the user's choice).
  At PostToolUse and PostToolUseFailure a block's reason becomes text for the model, and the call's
  outcome is unchanged (plan review, finding 3).
- **`async` hooks (Task 4; choice 5).** Their answer is read to report a failure, and also when it
  asks to block or to stop, which an `async` hook cannot, each with its own red line, the stop's
  alone when it asks both (the user's choices). SessionEnd alone waits for its `async` hooks, within
  its shared limit, so none is left running and no line is lost as Tachikoma ends (Task 10's code
  review). A hook's failure fails no subagent and no `-p` run (plan review, finding 1).
- **Tools (Task 5; choices 10-14).** A field Tachikoma's tool cannot do, beside choice 14's (Grep's
  `head_limit`, `-A` and the like), is refused, not dropped, so a rewrite is taken whole or not at
  all (the user's choice). In the sandbox a rewritten whole path outside the project is refused, as
  the box would take it as one odd name in `/work`; in copy mode on Windows a host path inside the
  project becomes its place in the copy (the user's choices). Write's `filePath` is the path hooks
  are sent, as its `file_path` is. The rewrite's reasons are the user's approved wording.
- **PreToolUse (Task 6; choices 15-16).** A hook's allow, and a yes to its ask, never wave a write
  outside the project through, in any mode: ask and project modes still ask, auto still goes to
  the judge, and `never` still refuses (the user's choice). In `-p` a call a PreToolUse hook refused
  fails the run with exit code 1: a deny, a block, an ask `-p` cannot put, and a rewrite that cannot
  be used (the user's choice). An ask nobody can answer, in `-p` and in `never`, is also a grey
  line, in the words the model gets (the user's choice). The hooks' `effort` follows a live change
  of the lead's effort, not the launch's value (the user's choice).
- **After a call, and a stop (Task 7).** `write_file` reads the old file, to tell `create` from
  `update`, only when a PostToolUse or PostToolUseFailure hook matches the call. A stop from a tool
  event leaves every call of the reply one result: a call not started gets `Not run: a hook stopped
  the turn.`, a call whose tool throws at the stop gets `Stopped: a hook stopped the turn.` (the
  user's approved line), and a running `delegate` keeps its own stopped result.
- **UserPromptSubmit and text for the model (Task 8; choices 6, 17).** It fires only for a turn with
  the user's own words, not for one that reads background answers alone. A stop at UserPromptSubmit
  puts the words back, as a block does, and the prompts queued behind come back with them, with one
  `Your words are back in the prompt box.` (the user's choices). Esc while its hooks run sends and
  saves nothing, and the words stay in the prompt history only. In `-p --json` each grey hook line
  is a `hook-note` JSON line (the user's choice). The prompt's message holds, in order,
  SessionStart's waiting text, the prompt's own parts, UserPromptSubmit's text, then the subagents'
  waiting text.
- **Stop and the subagents' events (Task 9; choices 8, 21).** `stop_hook_active` stays true for the
  rest of the turn once a Stop hook has kept it going. The ninth block in a row is not followed: the
  turn ends on the model's reply with the 8-times line. A block with no reason sends the model `The
  hook gave no reason; carry on with the task.`, and its grey line, as `additionalContext` alone's,
  names no reason (the user's choices). A SubagentStop stop keeps the subagent's answer, with the
  stop's line after it; a background subagent a hook stopped tells the lead so, waking it as a
  failed one does (the user's choices). SubagentStop's lines that name the subagent drop the
  `<id>: ` in front (the user's choice). SubagentStart and SubagentStop are matched on `Explore`, as
  Claude Code matches both on the subagent's type.
- **SessionStart and SessionEnd (Task 10; choices 18-19).** SessionStart's `model` is the lead's
  full id, such as `anthropic:claude-opus-5-5` (the user's choice). It is not waited for where it
  fires; the next turn waits for its hooks, so their text reaches its request. SessionEnd's hooks
  share one limit, 1.5 s or the longest `timeout` among them, 60 s at most. A switch's SessionEnd
  (`/clear`, `/branch`, `/resume`'s pick) shows the working line, and Esc stops it (the user's
  choice: "Esc stops it"). Leaving the window turns the keys off while SessionEnd runs, with no new
  line, and its lines, in full screen and in copy mode, are also written to stderr once Ink has
  ended, so none is lost (the user's choices). A copy opened because another window holds the
  session is still `resume`. A crash that ends the window runs no SessionEnd, as a signal runs none
  (a known limit).
- **PreCompact and PostCompact (Task 11; choice 20).** `manual` is `/compact`'s alone. PreCompact's
  plain text joins the focus after `/compact`'s words, a paragraph each. A block with no reason, or
  one only blank, gives `a PreCompact hook blocked it`, with no colon (the user's choice: "Drop the
  colon"). A subagent's shortening fires PreCompact and PostCompact and no SessionStart `compact`
  (the user's choice: "Pre/Post only"). SessionStart `compact`'s text goes first in the shortened
  message, and is left out, with a grey line, when with it the message would not fit the window.
  `/lead`'s shortening sends SessionStart `compact` the new lead's id as `model`, as that lead reads
  its text once the switch is made; every other shortening sends the lead's (Task 11's code
  review). For 8d: `onShorten` runs before PreCompact, so 8d's memory save will run even for a
  shortening a PreCompact hook then blocks.
- **What the user sees (Task 12; choices 22-25),** in the user's words at Task 12's spec review: the
  `/` menu's note for `/hooks` is `List the hooks in force`, and HELP says `/hooks lists the hooks
  in force`; Ctrl+O names a tool event's tool by Tachikoma's name, `for <tool>`, and a run a signal
  ended as `ended by signal <SIGNAME>`; `Hooks changed` is singular for 1; `/hooks` names the file
  as the other lines do, `~\.tachikoma\settings.json` on Windows; the working line shows the
  `statusMessage` of the lead's sync hooks only (a known limit). Ctrl+O lists exactly the runs of
  the lead turn it shows, and `/branch` keeps them, then adds the branch's own SessionEnd and
  SessionStart runs (the user's choice). The Git Bash line is said only when a hook run by a shell
  is in force.
- **The documents (Task 13).** The README says plainly that a command in the sandbox cannot add a
  hook, as `~/.tachikoma` is not in the box, and that on the host a shell command you allowed could,
  the edit applying at once with its `Hooks changed` line. Release 8 now has five parts, 8e holding
  the events this design leaves to it.
- **The whole-release review (2026-11-10).** `async` hooks still running when a `-p` run or the
  window ends are killed, with all they started, so none keeps Tachikoma alive; SessionEnd's are
  still waited for (the user's choice). Ctrl+O shows a new session's SessionStart runs, after `No
  turn yet` and then first in the first turn's runs, and a prompt that starts no turn (blocked,
  left unsent by `continue: false`, or stopped with Esc) leaves its list as it was (the user's
  choices). A switch, `/branch` included, clears `prompt_id`, so SessionStart is sent none, as at a
  launch (the user's choice). A PreCompact block's reason is escaped as every other hook line is.
  The README's example hook names its script in full, as a path is read from the project folder
  (the user's choice); four rarer points, and two from the fixes' review, became known limits.
- **The terminal checklist (2026-11-10).** All ten items passed. `/hooks` was "a long wall of
  text", so it and Ctrl+O name each hook by its `statusMessage`, else its program and the script it
  runs, in place of the whole command; `/hooks` shows a matcher only when it does not match
  everything, a time limit only when the hook sets one, and `async`. The left-out rows use the
  same names; the warnings and the red failure lines keep the whole command (the user's choices).
