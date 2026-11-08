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
