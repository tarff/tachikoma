# Tachikoma release 8e: more hook events, design (2026-11-23)

Release 8e is the fifth and last of release 8's parts. The overall design, the Decisions table and
the release order are in [2026-10-22-tachikoma-design.md](2026-10-22-tachikoma-design.md). Release
8b ([its design](2026-11-09-tachikoma-release-8b-design.md)) built hooks in Claude Code's format at 11
events and left the rest to later parts; its "Not in this release" table gave 8e the events that
"have a place in Tachikoma already". 8c added the `mcp_tool` hook kind and the two Elicitation
events.

Every choice below was the user's, on 2026-11-23, from options offered; "option chosen" quotes it.
Each section was approved as written here.

## Sources

- Claude Code's hooks reference, <https://code.claude.com/docs/en/hooks>, and hooks guide,
  <https://code.claude.com/docs/en/hooks-guide>, read 2026-11-23, with
  <https://code.claude.com/docs/en/terminal-config> for the notification kinds. Every time limit and
  wait in this design (30 s, 6 s, 60 s, 5 s) is Claude Code's documented value; none has been
  measured for Tachikoma, and the README says so, as 8b did.
- Tachikoma's code, read 2026-11-23, for where each event's moment is (the plan gives the places).
- Claude Code's page now documents 33 events. One is new since 8b: DirectoryAdded.

## What 8e covers

8b's list gave 8e eleven event names (the main design said ten) and said each had a place in
Tachikoma already. That was true for 8 of them. Of the other three, Tachikoma sends no
notifications at all, watches no files besides its own settings, and its working folder never
changes, as each shell command starts fresh in the project folder.

Hooks at nine events (option chosen: "9: the 8 + Notification"): PermissionRequest,
PermissionDenied, StopFailure, Notification, PreModelSwitch, PostModelSwitch, PostToolBatch,
InstructionsLoaded and ConfigChange. Notification gets new moments in Tachikoma, the ones where
Claude Code would send one.

Everything 8b and 8c set up carries over unchanged: the settings entry, the shell, the fields every
hook is sent, the exit-code and JSON table, `/hooks`, Ctrl+O, live edits, and the two hook kinds
(`command`, and `mcp_tool` from 8c).

- **Time limits** are Claude Code's: 30 s at PreModelSwitch and PostModelSwitch; the usual 600 s at
  the other seven.
- **`async: true`** hooks run without being waited for, as in 8b, and their answer decides nothing
  (re-review, 2026-11-23, finding 1). At PermissionRequest, PermissionDenied, PreModelSwitch,
  PostToolBatch and ConfigChange only hooks without `async` can decide (allow, deny, ask, block,
  retry); the question, the refusal, the switch, the next request and the settings change wait for
  those alone. An async hook that tries to decide gets 8b's line, "… asked to block, but an
  "async" hook cannot block". An async PostModelSwitch hook's text is ignored too, as 8b ignores
  every async hook's answer.
- **Matchers** (re-review, 2026-11-23, finding 3):

  | Event | The matcher is on |
  |---|---|
  | PermissionRequest, PermissionDenied | the tool name, under Claude Code's names, as PreToolUse |
  | StopFailure | `error` |
  | Notification | `notification_type` |
  | PreModelSwitch, PostModelSwitch | `to_model`'s canonical name; for another provider's model every hook runs |
  | PostToolBatch | none: a matcher is ignored, as on Stop |
  | InstructionsLoaded | `load_reason` |
  | ConfigChange | `source`, always `user_settings` |

  Each event hands the hook runner that value, so a hook with a matcher is picked by it, not only
  the hooks that match everything.
- **`if`** hooks are still left out with a warning: Claude Code checks `if` at PermissionRequest and
  PermissionDenied too, but Tachikoma does not have its permission-rule syntax. `asyncRewake` still
  runs as plain `async`.
- **Two events get their own warning**, at the launch and in `/hooks`, in place of the general "is
  not an event Tachikoma runs hooks at":
  - "FileChanged: Tachikoma doesn't watch files for hooks, so this event never happens; its hooks
    were left out."
  - "CwdChanged: Tachikoma's working folder never changes, as each command starts in the project
    folder, so this event never happens; its hooks were left out."
- **Notification kinds:** a matcher naming a kind Tachikoma never sends, such as `auth_success`,
  gets no warning. It never matches, as in Claude Code, where a matcher is a pattern.

## The permission events

**PermissionRequest** runs when Tachikoma is about to ask the user to approve a tool call:
- the usual question in ask and project modes;
- auto mode's question for a dangerous command, or after the judge's refusals have paused it;
- never mode's question for an MCP tool;
- the question a PreToolUse hook's "ask" brings up.

It also runs in `-p`, where today the call is refused, as Claude Code runs it in sessions with
nobody to ask. It does not run for questions that are not about a tool call ("send again without
the pictures", the launch's instruction-files question), or where nothing is asked (never mode's
refusals, auto mode's judge).

- **Sent:** `tool_name` and `tool_input` under Claude Code's names and fields, as PreToolUse is
  (8b's "Tool hooks", paths included), and `mcp_server` for an MCP tool. `permission_suggestions`
  is left out, as Tachikoma has no permission rules to suggest. The matcher is on the tool name.
- **allow** runs the call without the question, for every question, the dangerous-command and
  protected-path warnings included (option chosen: "Every question, as Claude Code").
- **allow with `updatedInput`** replaces the input, by 8b's rewrite rules. By the time the question
  is reached, a tool has already worked out its path and what it will do, so a rewrite throws that
  away: the call starts again with the new input, its path resolved, checked and asked about as if
  the model had sent it (review, 2026-11-23, finding 1). PermissionRequest is not run a second time;
  the PreToolUse hooks are, on the new input, so a rewrite cannot route around them (option chosen:
  "Yes, run PreToolUse again"; Claude Code checks a rewrite against its permission rules only). If
  the new input needs a question, the user is asked.
- **deny** refuses the call, its `message` going to the model. `interrupt: true` also ends the turn,
  as 8b's `"continue": false` does.
- **Several hooks:** deny over allow. If no hook decides, the question goes ahead as now; in `-p`
  that means the call is refused.
- **Exit code 2** does nothing here, as in Claude Code. `updatedPermissions` is ignored, with a grey
  line: "A PermissionRequest hook's updatedPermissions was ignored: Tachikoma has no permission
  rules."
- The question waits for the hook; Esc kills the hook and cancels the call. An allow is silent, as
  in Claude Code; Ctrl+O shows it.

**PermissionDenied** runs when auto mode's judge refuses a call, including when the judge cannot be
reached or its answer cannot be read, which Claude Code counts too (denials "without a classifier
verdict").

- **Sent:** `tool_name`, `tool_input`, `tool_use_id`, and `reason`: the judge's own reason, or
  Tachikoma's line for why there was no verdict. `mcp_server` for an MCP tool.
- It runs before the refusal goes back to the model. If its `retry` is true, the refusal gets one
  more sentence: "A hook says you may try this again." As in Claude Code, `retry` is ignored when the
  judge gave no verdict.
- The judge's result says which of three it was: a refusal, the judge unreachable, or its answer
  unreadable (a cut-off answer included). `retry` counts only for a refusal (review, 2026-11-23,
  finding 5).
- The refusal still counts toward auto mode's pause. Exit codes and error output are ignored.

## The turn ending, and tool batches

**StopFailure** runs in place of Stop when an error from the provider ends the lead's turn:

| How the turn ends | `error` |
|---|---|
| The request fails | By its HTTP status: 429 `rate_limit`; 401 and 403 `authentication_failed`; 402 `billing_error`; 400 `invalid_request`; 404 `model_not_found`; any 5xx, 529 included, `server_error`; no status (a network failure) `unknown` |
| The reply fills the output limit or the context window | `max_output_tokens` |
| The conversation is still too long after a shortening | `invalid_request` |
| The model refuses, and no fallback rescues it | `unknown` |

- **Sent:** `error`; `error_details`, the provider's message; `last_assistant_message`, the error
  line the user sees.
- The last two rows, and which status is which error, are Tachikoma's choices: Claude Code's docs
  do not say.
- The lead's turn only, as the docs speak only of the turn.
- No answer: as in Claude Code, its output and exit code are ignored.

**PostToolBatch** runs once when every tool call of a reply has its result, before the next request
goes to the model.

- For the lead and for subagents, which are sent `agent_id`. Not when the turn has already ended,
  by the user's stop or a tool hook's `"continue": false`.
- No matcher.
- **Sent:** `tool_calls`, each with `tool_name`, `tool_input`, `tool_use_id` and `tool_response`, the
  text the model will read, as in Claude Code.
- Exit code 2, `"decision": "block"` or `"continue": false` ends the turn before the next request;
  in a subagent, it ends that subagent. The reason is shown as a line. Claude Code keeps it in the
  conversation; Tachikoma sends it with the user's next request, marked as a hook's text, so the
  model knows why its turn ended.
- `additionalContext` joins the same message as the results, as 8b's hook text travels.

## Switching the lead model

**PreModelSwitch** runs before a switch the user asked for:
- `/lead <model>`, sent as `source: "command"`;
- a pick from the model list (`/lead` or `/model` with nothing after it), as `"picker"`;
- a `lead` edit in the settings file. Claude Code's docs count its `/config` Model setting but do
  not say which `source` it sends; Tachikoma sends `"command"`.

It runs first: when the new model's window is smaller, the shortening to fit comes after it, so a
block wastes no shortening. Not for `/resume` into a session with another lead, the `--fallback`
rescue (one reply, the lead unchanged), or Anthropic's own fallback.

- **Sent:**
  - `from_model` and `to_model`, the model's name without its provider (`claude-opus-5-5`);
  - the matcher is on `to_model`'s canonical name, as in Claude Code (review, 2026-11-23, finding 3;
    option chosen: "Claude Code's way"): for an Anthropic model, its name with any date on the end
    dropped (`claude-haiku-4-5-20251001` matches as `claude-haiku-4-5`), a reading of ours, as
    Claude Code's docs do not say how the name is made. Another provider's model has no Claude
    name, so every PreModelSwitch and PostModelSwitch hook runs for it, whatever its matcher, and
    reads `to_model`, as Claude Code does for a model without one;
  - `requested_model`: the words typed, the file's value, or null for a pick from the list;
  - `context_tokens`: the conversation's size now;
  - `prompt_cache_warm`: true when the last request to Anthropic was under 5 minutes ago;
  - `cache_ttl`: always `"5m"`, the only cache Tachikoma asks for;
  - `estimated_cache_write_usd`: the conversation's size times the new model's cache-write price;
    null, with `pricing` left out, when Tachikoma's price list has no price for it; otherwise
    `pricing` is `"catalog"`.
- **Cancelling:** exit code 2, `"decision": "block"`, a deny, or running out of time cancels the
  switch; the lead stays, with a line: "The switch to `<model>` was stopped by a hook: `<reason>`."
  For a settings-file switch the line adds "settings.json still names it.", and the next launch
  uses it.
- **ask** puts a question to the user for `/lead` and the model list: "A hook asks: `<reason>`.
  Switch to `<model>`?" For a settings-file switch, ask counts as a deny, as in Claude Code.
- **allow** adds nothing: Claude Code uses it to skip a cache-cost question Tachikoma does not ask.
- **Several hooks:** deny over ask over allow.

**PostModelSwitch** runs after the lead changes: after the three switches above, and after `/resume`
into a session with another lead, as `source: "resume"`.

- It cannot block.
- Plain output on exit 0, or `additionalContext`, goes to the model with the user's next request. As
  in Claude Code, that request waits for the hook up to 5 seconds from when the user sends the
  prompt: text that arrives in that time goes with it; if the hook has not finished by then, the
  request goes without it, and the text goes with the one after (review, 2026-11-23, finding 4).
  After several switches in a row, only the last one's text goes. Text belongs to the conversation
  the switch happened in (for `/resume`, the one resumed). If that conversation has changed by the
  time the hook finishes, through `/clear`, `/resume` or `/branch`, its text is dropped, as 8b drops
  the last conversation's waiting hook text (re-review, 2026-11-23, finding 2).
- Exit code 2 shows its error output as a red line.

## Notification, InstructionsLoaded, ConfigChange

**Notification**, four kinds (option chosen: "The 'waiting on you' four"), each sent `message`,
`title` (always "Tachikoma") and `notification_type`:

| Kind | When | `message` |
|---|---|---|
| `permission_prompt` | A tool-approval question has gone about 6 s unanswered; each key pressed starts the wait again | "Tachikoma needs your permission to use `<Tool>`" |
| `idle_prompt` | About 60 s after the lead's turn ends, with no typing since and no background subagent running; once for each wait | "Tachikoma is waiting for your input" |
| `elicitation_dialog` | An MCP server's form has gone about 6 s with no typing | "`<server>` asks you to fill in a form" |
| `elicitation_url_dialog` | An MCP server's request to open a page has gone about 6 s with no typing | "`<server>` asks you to open a page in your browser" |

- Subagents' questions count too. Nothing fires in `-p`, where nothing waits.
- The hooks run without holding anything up. Their answer is ignored, as in Claude Code,
  `systemMessage` and `continue` included.

**InstructionsLoaded** fires for each instruction file read into the model's context: every
CLAUDE.md, CLAUDE.local.md and AGENTS.md, and each file brought in by an `@` import (option chosen:
"Every file Tachikoma reads"; Claude Code does not fire it for an AGENTS.md it reads directly).

- **Sent:** `file_path`; `memory_type`, `User` for the files in the home folder, `Local` for
  CLAUDE.local.md, `Project` for the rest; `load_reason`, `session_start` at the launch and on
  `/clear`, `compact` when the files are read again after a shortening, `include` for an import,
  with `parent_file_path`.
- The hooks are not waited for, and their answer is ignored, as in Claude Code.
- Subagents do not fire it: they reuse the lead's text, not reading the files again.

**ConfigChange** fires when `~/.tachikoma/settings.json` changes while the window is open; `-p`
does not watch the file.

- **Sent:** `source: "user_settings"` and `file_path`. `keybindings.json` does not fire it: Claude
  Code has no such source.
- It runs after the new text is read, before any of it applies, hooks and MCP servers included. The
  hooks in force are the ones that run, not the ones the new text would bring. Exit code 2 or
  `"decision": "block"` keeps the whole change out: the settings in force stay as they were, the
  next change is compared with those, and the next launch reads the file as it is (review,
  2026-11-23, finding 2).
- **One change at a time:** while ConfigChange hooks decide on one save, a newer save waits; a still
  newer one replaces the waiting one, so only the newest waits. The save being decided applies, or
  is kept out, first; then the waiting one is decided against what is in force by then. An older
  save never lands after a newer one.
- A change that removes the ConfigChange hook itself is decided by that hook, as it is still in
  force; once the change applies, later changes have no hook to ask.
- One departure from Claude Code, which shows nothing when a change is blocked: a grey line, "A
  ConfigChange hook stopped this settings change: `<reason>`.", as every other live edit has a
  line and a silent block would leave the user wondering why an edit did nothing.

## What the user sees

As 8b, for the new events:
- `/hooks` lists them, and FileChanged and CwdChanged as left out, each with its reason.
- Ctrl+O lists the hooks that ran; those that run outside a turn (Notification, InstructionsLoaded,
  ConfigChange) are listed with the next turn.
- A hook that cannot start or runs out of time gets the red line at every event; an exit code that
  Claude Code ignores at an event does not.
- The README's hooks section gains the new events and their fields, each departure and limit said
  plainly; its "Planned for release 8e" lines become built.

The plan gives every new line's words for the user to approve; the ones above are approved.

## Known limits

- The timings (6 s, 60 s, 5 s, 30 s) are Claude Code's, not measured for Tachikoma.
- A PermissionRequest hook that answers allow to everything turns off the dangerous-command and
  protected-path warnings, and in `-p` runs calls that would otherwise be refused.
- `terminalSequence`, Claude Code's way for a hook to send text straight to the terminal (a bell, a
  desktop alert), is ignored: a hook makes its own sound or alert.
- `to_model` and `from_model` drop the provider, so one model reached through two providers looks
  the same to a hook. The canonical name used for matching (a dated Anthropic name without its
  date) is a reading of ours; Claude Code's docs do not say how it makes the name.
- StopFailure's error kinds are partly Tachikoma's choice.
- Notification has only four kinds; FileChanged and CwdChanged are not run.

## Testing

- **Rule tests:** the nine events accepted; the two special warnings; each row of the matcher table,
  a hook with a matcher picked by the value its event hands over; an async hook deciding nothing at
  each event that can decide; each
  event's answer rules, such as an exit code 2 ignored where Claude Code ignores it.
- **Session tests with a stand-in model, no network:**
  - each event fires at its moment;
  - PermissionRequest's allow, deny, rewrite and `interrupt` in all four modes and in `-p`, an
    allowed dangerous command included; a rewrite to another file running from the start, the
    PreToolUse hooks seeing the new input;
  - PermissionDenied's retry sentence after a refusal, and none when the judge was unreachable or
    its answer unreadable;
  - StopFailure's error kind for each status;
  - PostToolBatch ending a turn while a `delegate` runs;
  - a blocked and an asked `/lead`, and a blocked settings-file switch; a dated Anthropic name
    matching its undated matcher, and another provider's model running every switch hook;
  - PostModelSwitch's text just inside and just outside the 5-second wait, and a hook finishing
    after a `/clear`, its text never reaching the new conversation;
  - Notification's 6 s and 60 s waits, a keystroke starting the wait again;
  - InstructionsLoaded's three reasons;
  - a ConfigChange block keeping the old settings; two quick saves while a ConfigChange hook runs,
    the newer landing last; a change that removes its own ConfigChange hook.
- **No real waiting:** every 6 s, 60 s and 5 s wait runs on a fake clock. Nothing runs under load
  on the user's machine.
- **The user's terminal checklist:** a Notification hook that plays a sound at `idle_prompt`, a
  PermissionRequest allow, and a blocked `/lead`.
- CI runs it all on Windows for the pull request.

## Not in this release, and when

| Left out of 8e | When |
|---|---|
| FileChanged, CwdChanged | Not planned: Tachikoma watches no files for hooks, and its working folder never changes |
| Notification's other kinds (`auth_success`, `agent_completed`, `elicitation_complete`, `elicitation_response` and the rest) | Not planned: either no such moment in Tachikoma, or (the last two) not chosen |
| DirectoryAdded | Probably never, with 8b's TaskCreated, TeammateIdle and the rest: it belongs to a Claude Code feature Tachikoma has not got |
| `terminalSequence`; PermissionRequest's `updatedPermissions` and `permission_suggestions` | Not planned |

## As built

Where the build differs from this design, or settles what it left open. The build plan's questions
are cited by number (Q1 to Q32, with "Resume size" and "Early stop"), each with the user's answer
and its date: all were answered on 2026-11-23, at the plan's approval and after each of its three
outside reviews. D1 to D9 are the plan's checks against Claude Code's hooks reference, read the same
day. "The user's choice" marks an answer given at a step's review during the build: on 2026-11-23
for steps 1 to 15, on 2026-11-24 for steps 16 to 20. No figure here was measured for Tachikoma: the
30 s, 6 s, 60 s and 5 s are Claude Code's documented values, as "Sources" says; the 5 minutes is
the design's own figure (its `prompt_cache_warm` line); the 600 s is 8b's usual limit; and the test
clean-up's 5 s (under "Tests") is carried over from existing test code. Steps 1 to 20 are d17a4d0
to a1c0c3f on `release-8e`, with their review fixes.

**The settings side and warnings**
- **FileChanged and CwdChanged** (Q1, 2026-11-23; step 1): at the launch each warning is
  `settings.json: "hooks": ` followed by the design's whole line, and `/hooks` shows the design's
  whole line as the left-out row. Their values are not looked at. Any other unknown event name keeps
  8b's general warning.
- **A settings file written before 8e** (Q32, 2026-11-23; step 1): the nine new names are checked as
  strictly as the other 13. Before 8e a wrong-shaped value under one of them, such as
  `"Notification": "anything"`, was skipped with a warning; now it stops the launch with the usual
  "must be a list" error, and a live edit that holds it is refused with the settings in force kept.
  The README says so.
- **The limits** (step 1): PreModelSwitch and PostModelSwitch share UserPromptSubmit's 30 s, Claude
  Code's documented value, not measured; the other seven new events have 8b's 600 s. `/hooks` shows
  a limit only when a hook sets its own `timeout`, as before, so the 30 s is not shown there.
- **PostToolBatch's matcher** is ignored, as Stop's is (step 1).

**The answer rules** (steps 2 and 3)
- **Fields read only where the design names them** (Q2, 2026-11-23): `"continue": false` and
  `stopReason` at PostToolBatch alone; `additionalContext` at PostToolBatch and PostModelSwitch
  alone. Plain output on exit code 0 is text for the model only at PostModelSwitch; PostToolBatch
  drops it, as the design names only `additionalContext` there.
- **Notification, StopFailure and InstructionsLoaded** ignore every exit code and all output,
  `systemMessage` included. Only the runner's own failures have a red line there: a hook that cannot
  start or runs out of time, or an `mcp_tool` hook that cannot be called or answers an error. A hook
  ended by a signal gives no line there, nor at PermissionDenied, which does not look at the exit
  code and reads readable JSON at any code.
- **PermissionRequest's exit code 2** (Q3, 2026-11-23) decides nothing: its JSON is not read and no
  line is shown. Exit code 1 with plain text keeps 8b's red line.
- **ConfigChange** (D9) discards `systemMessage` and `continue` and reads only its block. The plan
  had first said `systemMessage` is shown there; Claude Code's page says it is discarded, and the
  build follows the page.
- **PreModelSwitch** cancels on exit code 2, a top-level `"decision": "block"` or a deny; deny wins
  over ask, ask over allow, and the first hook in the file gives the reason. The old top-level
  `"approve"` counts only at PreToolUse; at PreModelSwitch it decides nothing (the user's choice at
  step 3's review, 2026-11-23). `"permissionDecision": "defer"` is unreadable JSON there.
- **`"onFailure": "block"`** (Q28, 2026-11-23) makes a failure a block at PreModelSwitch,
  PostToolBatch and ConfigChange, a time-out included at the last two, as in 8b. At
  PermissionRequest a failure never refuses the call, and at the other five new events `onFailure`
  changes nothing.
- **Several PermissionRequest hooks:** deny over allow, the first deny in the file giving the
  message. Any deny with `interrupt: true` ends the turn, as any hook's `"continue": false` does in
  8b (the user's choice at step 2's review, 2026-11-23). The first allow's `updatedInput` is the
  rewrite; an `updatedInput` without `"behavior": "allow"` is none.
- **An `mcp_tool` hook at the new events** keeps 8c's rules: "could not be called" is a failure with
  its red line at every event, a block only where `onFailure: "block"` makes failures blocks;
  "answered an error" is a red line that never blocks. Such a hook waits for a server still starting
  only where hooks can decide: PermissionRequest, PreModelSwitch, PostToolBatch and ConfigChange. At
  the other five it is not called while its server starts, and gets 8c's "could not be called"
  line. That wait is now a list of its own in `src/hooks/answer.ts`, apart from the list that sets
  where blocks and `onFailure` apply.
- **Async hooks** (step 3): an async hook at the five deciding events that answers allow, deny, ask,
  a rewrite, a retry or a block decides nothing and gets 8b's line, "... asked to block, but an
  "async" hook cannot block". An async PostToolBatch hook's `"continue": false` gets 8b's "asked to
  stop" line instead, as at every event where `continue` is read.

**The permission events** (steps 5 to 9)
- **Where PermissionRequest runs** (Q4, 2026-11-23; step 7): just before Tachikoma would put any
  question about a tool call, a PreToolUse hook's "ask" included, and in `-p` just before the
  refusal that stands in for that question. In never mode that means the question an MCP tool's
  call brings, and a PreToolUse "ask" on an MCP tool, which never mode puts to the user; never
  mode's refusals (a call that is not an MCP tool's, or a box server's call with the box's network
  off) and auto mode's judge never reach it. The hooks are asked only when a PermissionRequest hook
  matches the tool, so without one every question is as before.
- **Once for a call** (Q5, 2026-11-23): an allow covers every later question of that call, except
  where the judge decides, which still decides; if the hooks decided nothing, later questions of
  that call go to the user, or are refused in `-p`.
- **Auto mode's pause** (Q6, 2026-11-23): a hook's allow runs that call and leaves the pause as it
  was; only the user's own yes lifts it.
- **`-p`'s exit code** (Q7, 2026-11-23): a deny makes the run end with exit code 1. A real `-p` run
  in `tests/cli.test.ts` checks it, on a read outside the project, since a read inside it asks
  nothing.
- **A stop while the hooks run** cancels the call with no question put, whatever they answered; only
  a deny is still a refusal, marked as cancelled (step 7's review fix, 4a3afc7). A failure that is
  not a stop, such as a line's listener throwing, gives a red line, "PermissionRequest hook failed:
  ...", and the question goes ahead.
- **A rewrite starts the call again from either way in** (step 9): from the gate's own question,
  asked inside the running tool, or from a PreToolUse hook's "ask", before the tool runs. The
  session turns the rewrite back into Tachikoma's fields; one it cannot use is refused with W3 and
  counts for `-p`'s exit code. A usable one ends the first pass with a start-again signal, which the
  session takes before any refusal or failure handling. The call then runs from the start with the
  new input: the PreToolUse hooks run on it, the tool works out and checks its path again, and a
  question the new input needs goes to the user (in `-p` it is refused). The second pass counts as
  already asked, so PermissionRequest does not run again and there is at most one restart. The
  first pass leaves no result, no error line, no lesson search and no PostToolUse or
  PostToolUseFailure run; the window sees one start and one end; the transcript keeps 8b's
  `rewritten` line.
- **The first pass's PreToolUse text for the model is dropped** on a restart: only that pass's own
  entries; other calls' text stays, and grey lines already shown stay (the user's choice at step 9's
  review, 2026-11-23).
- **Known limit, the tool row after a restart:** the row on screen still names the call's original
  target, as after 8b's PreToolUse rewrite (the user's choice at step 9's review, 2026-11-23).
- **Tool names** (step 8): W1's `<tool>` is Tachikoma's name (`shell`, `read_file`), as 8b's
  PreToolUse lines are; Notification's `permission_prompt` message uses Claude Code's (`Bash`, Q17).
- **`mcp_server`** at PermissionRequest and PermissionDenied is the server's name as written in the
  settings file, the name Elicitation's `mcp_server_name` sends (the user's choice at step 6's
  review, 2026-11-23). PreToolUse and PostToolUse do not send it.
- **The judge's refusal** (step 5) is marked as a verdict, the judge unreachable, or its answer
  unreadable. PermissionDenied's `reason` is the judge's own text, not escaped, inside the JSON
  input; the model's sentence is escaped as before.
- **The retry sentence** (step 6) follows the refusal after one space, and a long refusal is cut so
  that the sentence is never what is cut off. A subagent's refusal fires PermissionDenied too, with
  its `agent_id`. A failure that is not a stop gives a red line, "PermissionDenied hook failed:
  ...", and the refusal goes back unchanged.

**The turn's end, and tool batches** (steps 10 and 11)
- **StopFailure only for the table's four rows** (Q8, 2026-11-23). It fires nothing for a
  conversation that could not be shortened at all, a shortening that failed or that a PreCompact
  hook blocked, or an unsaved session that the provider answers "too long".
- **"Early stop"** (2026-11-23): a reply that stops early for a reason that is not an output limit,
  the window or a refusal fires nothing, and its error line is shown as today. For this the
  providers' cut-off replies gained a mark for a true output limit: Anthropic's `max_tokens`,
  OpenAI's and Ollama's `length`, ChatGPT's `max_output_tokens`. ChatGPT's other early stops keep
  their kind and words, unmarked. The one-line changes to `src/providers/anthropic.ts` and
  `src/providers/openai.ts` are outside the plan's list of files; its approach named them.
- **A stopped turn fires nothing** (step 10): the user's stop during the request, Ctrl-C at "send
  again without the pictures", and a stop during the fallback's request. A "yes" there whose second
  request fails fires once, with the second failure.
- **Statuses** (step 10): "any 5xx" is 500 to 599, and any status the table does not name, such as
  408, 409, 413 or 422, sends `"unknown"` (the user's choice at step 10, 2026-11-23).
- **A refusal no fallback rescues** (Q21, 2026-11-23): when the fallback also fails, is too long or
  refuses, one StopFailure (`unknown`) is sent the lead's refusal, its line and its detail.
- **A reply that fills the window** (Q22, 2026-11-23) sends `max_output_tokens`, in an unsaved
  session too, and so does a fallback's reply that fills it.
- **Still too long after a shortening** (step 10) sends `invalid_request`, with the provider's "too
  long" message as `error_details`, even where the line shown is Tachikoma's own.
- **`last_assistant_message`** (Q9, 2026-11-23) is the window's line without its `✗ ` mark,
  escaped as the window shows it and without an ending line break the window drops (the user's
  choices at step 10's review, 2026-11-23), so the hook gets the characters on screen;
  `error_details` stays the provider's message as sent. In `-p` the printed line keeps any ending
  line breaks of the provider's message (left as it is, the user's choice, 2026-11-23), so the two
  can differ by those breaks alone.
- **Order and waiting** (step 10): the red line is shown first, then StopFailure runs, waited for as
  Stop is.
- **Subagents fire none.** Since step 13's review a subagent skips the call itself at all seven
  places, which restored the end-of-turn timing a step 10 change had given subagents; an app test
  failing from step 10 on showed it (the user's choice at step 13's review, 2026-11-23; 0907480).
- **PostToolBatch fires only when a PostToolBatch hook is in force** (step 11), so without one the
  results are stored with no extra wait. It does not fire after a tool hook's `"continue": false` or
  a PermissionRequest `interrupt`, after the user's stop, or for a reply the provider cut off, whose
  calls did not run.
- **`tool_response`** (Q30, 2026-11-23) is the result text as stored, with nothing put in front for
  a failed call, the same whatever model leads; so a used PostToolUse `updatedToolOutput`, and the
  lessons memory adds to a failure, are part of it.
- **The reason for the model** goes with the next request, headed as hook text, whichever request
  that is, a turn of background answers included (Q29, 2026-11-23). An end with no reason sends the
  grey line the user sees, "A PostToolBatch hook stopped the turn." (the user's choice at step 11's
  review, 2026-11-23). A subagent keeps none, and `/clear`, `/resume` and `/branch` drop it.
- **A stop while PostToolBatch runs** (step 11) stores the results all the same and ends the turn
  with no line, keeping nothing of the hook. A failure that is not a stop gives a red line,
  "PostToolBatch hook failed: ...", and the turn goes on.
- **In `-p`** a turn a PostToolBatch hook ends gives exit code 1, as any turn ended so does. This is
  read from the code, not run in `-p` (step 19).

**The lead switch** (steps 12 to 14)
- **`context_tokens`** (Q10, 2026-11-23) is the status line's context number, 0 before the first
  reply, read when each event fires. `estimated_cache_write_usd` is that number times the new
  model's cache-write price per million tokens from `src/providers/pricing.ts`, not rounded; for a
  model not on that list, ChatGPT and Ollama models included, it is null and `pricing` is left out.
- **`prompt_cache_warm`** (Q11, 2026-11-23) is true only when the model left is an `anthropic`
  provider's, the last reply kept is that same lead's to its own conversation request (not a
  fallback rescue's, a summary's or the judge's), and it came under 5 minutes ago, the design's
  figure, not measured. Exactly 5 minutes is not warm, nor is a negative age after the clock was set
  back (the user's choice at step 12's review, 2026-11-23). As only the lead's own replies count, it
  can say cold while Anthropic's cache is warm (noted at that review, no change).
- **`/clear` and `/resume` forget that reply's time, and `/branch` keeps it** (the user's choice at
  step 12's review, 2026-11-23), so after a `/clear` the field is false until the new
  conversation's first reply.
- **PostModelSwitch's fields** (Q20, 2026-11-23; the design listed none): the same nine as
  PreModelSwitch's, worked out the same way when it fires; `requested_model` is null for `"resume"`
  and `"picker"`, and `prompt_cache_warm` describes the model left at both events.
- **The canonical name** (Q12, 2026-11-23) is made only for the `anthropic` provider's models, by
  dropping a final hyphen and eight digits, a reading of the design's example. Every other
  provider's model, an Anthropic model reached through OpenRouter included, runs every switch hook.
  `to_model` and `from_model` are sent whole, date included, and the name without its provider is
  the text after the id's first colon.
- **"The same model" is decided by the provider ids** (Q31, 2026-11-23), compared in the window:
  naming the model already leading, in the same spelling or another that comes to the same id,
  fires neither event, and the "lead is now" line stays. A dated and an undated Anthropic name are
  two ids, so a switch between them fires both events, though one matcher matches both.
- **A PreModelSwitch time-out** (Q13, 2026-11-23) of a hook that is not `async` gives the red
  time-out line and cancels the switch, with or without `onFailure`.
- **Anthropic's own fallback runs no switch hook** (design, "Switching the lead model", line 165).
  When Anthropic's server-side fallback (`src/providers/anthropic.ts`, `fallbacks: "default"`)
  answers a refused request on another model, the window shows a notice line and the lead stays as
  it is; the switch events fire only where the window changes the lead (`/lead`, the model list, the
  settings file, `/resume`). This is read from the code; no test drives it.
- **PreModelSwitch's lines** name the model by its provider id, as "lead is now" does. A full stop
  follows a reason only when the reason does not end in ".", "!" or "?" (the user's choice at step
  13's review, 2026-11-23). Esc while the hooks run cancels the switch and says nothing; at the
  hook's question Esc answers no and Ctrl-C cancels it. A blocked switch makes no shortening
  request.
- **The working line** (the user's choice at step 13's review, 2026-11-23): `/lead` and the model
  list show it only when some PreModelSwitch hook would run for the target, by its matcher, or any
  hook for a model with no canonical name.
- **A settings-file switch** is decided between turns, and the lead is set before that state ends,
  so no queued prompt goes to the old lead. Once its hook allows, the switch is made only if
  `settings.json` still names that lead (the user's choice at step 13's review, 2026-11-23);
  otherwise nothing switches and no PostModelSwitch fires.
- **The 5 seconds** (Q23, Q24, 2026-11-23) are Claude Code's figure, not measured. They count from
  when the window starts sending the prompt, for a queued prompt from when it leaves the queue. They
  decide which text counts, not only how long the request waits: text from a hook that finished
  after them is left out of that request and goes with the very next one, a tool round's results or
  a Stop hook's feedback in the same turn included, else the next turn's first message. A turn with
  no prompt of the user's, such as one of background answers, does not wait and takes only text
  already there. Esc during the wait sends nothing and records no prompt; the switch's text is kept
  for the next request (c2cd91d's message corrects 93d22d4's on this).
- **PostModelSwitch's runs** (step 14) are not waited for, are stopped at exit, and are listed in
  Ctrl+O with the list on screen, as PreModelSwitch's are, not with the next turn.
- **`context_tokens` after a `/lead` that shortened the conversation** (the user's choice at step
  14's review, 2026-11-23): PostModelSwitch is sent the estimate the fit check makes for the kept
  request, its characters times the tokens per character learned from the old lead's replies, with
  no extra request. When the old lead has no such rate yet it is null, with no cache-write cost and
  no `pricing`. PreModelSwitch is still sent the status line's number from before the switch.
- **Known limit, "Resume size"** (2026-11-23): a `"resume"` PostModelSwitch is sent
  `context_tokens: 0`, and a cache-write cost of 0 where the model has a price, because the status
  line's number is reset on a resume. It is also always sent `prompt_cache_warm: false`, since the
  load forgets the last reply's time (step 14).

**Notification, InstructionsLoaded, ConfigChange** (steps 4 and 15 to 18)
- **Hooks not waited for** (step 4): PostModelSwitch, InstructionsLoaded and Notification run with
  nothing waiting for them, and are stopped when Tachikoma exits, as 8b stops `async` hooks then, so
  none keeps a `-p` run or the window's exit waiting. Runs outside a turn (Notification,
  InstructionsLoaded, ConfigChange) are listed in Ctrl+O with the next turn, ahead of
  SessionStart's; a prompt a hook blocks puts them back for the turn after.
- **InstructionsLoaded** (step 15) fires when the text read becomes the conversation's system
  prompt: at the launch, in `-p` and in the window; at `/clear`, after its SessionStart; and after a
  shortening, once it is saved. A shortening that fails, is blocked, is stopped or cannot be written
  fires nothing. The paths sent are the host's, and an import's `memory_type` is its parent file's
  (Q15, 2026-11-23); a project file that a declined file imports has no parent.
- **No firing for a prompt not read afresh** (Q26, 2026-11-23): `tachi -c` or `-r` into a session
  that keeps its saved prompt fires nothing, decided by the opening code's own yes or no, never by
  comparing texts. `/resume` and `/branch` in the window reuse the launch's prompt and fire nothing.
- **The launch's `mcp_tool` hooks are skipped silently** (Q14, 2026-11-23). It needed one condition
  in `src/hooks/hooks.ts`, beyond step 15's files: an InstructionsLoaded before the first
  SessionStart counts as the launch's, as that SessionStart does. Two older tests in
  `tests/hooks/mcp.test.ts` fired InstructionsLoaded on a fresh hooks object and failed from then
  on; step 20 fixed the tests (55c7200).
- **Notification's 6 seconds** (Q25, 2026-11-23) are Claude Code's figure, not measured. The wait
  follows what is drawn in the prompt's place, in the window's own order: a form's field, else the
  model list, `/resume`'s list or `/mcp`'s list, which notify nothing, else the first question. A
  question hidden under a list, queued behind another, or under copy mode's leaving line or review
  gets a fresh 6 s when it comes up (copy mode's screens: step 17's review, 2026-11-24). A key or a
  paste starts the wait again; after a firing, only a key and another quiet 6 s fire again. "Send
  again without the pictures" and PreModelSwitch's question notify nothing; a subagent's question
  does, with no `agent_id`. The wait runs even with no Notification hook set, to no effect (the
  user's choice, 2026-11-24).
- **The forms report when a form opens and closes** (step 17), and a page request its server
  cancels is reported closed at once, so from then on it notifies nothing. For the cleanup list (the
  user's note, 2026-11-24): that page request's yes/no question stays up until the user answers it,
  as it did before 8e.
- **`permission_prompt` names Claude Code's tool name** (Q17, 2026-11-23), which each question about
  a call now carries. The window's question type for it is in `src/tui/app/constants.ts`, which
  joins step 17's files.
- **`idle_prompt`** (Q18, 2026-11-23): its 60 seconds are Claude Code's figure, not measured. The
  wait starts at every end of the lead's turn and fires once. A key or a paste, a new turn, leaving
  or closing the window ends it; a command that sends the lead nothing starts none. A background
  subagent running or waiting at 60 s means no firing and no new wait; its answers' turn starts one
  when it ends (kept as designed, 2026-11-24). A background command does not hold it back.
- **"No key since" is a cleared timer** (step 18): each key or paste clears the idle wait, so step
  18 did not need step 17's time of the last key, which the plan said it relied on; that unused
  record was removed (the user's choice at step 18's review, 2026-11-24). A guard also keeps the
  wait from starting once the window is leaving, which nothing reaches today (the same review). The
  timer is kept in `src/tui/app/state.ts`, which joins step 18's files, and the review fix reworded
  one comment in `src/tui/app/keyRouting.ts`.
- **ConfigChange fires only when a ConfigChange hook is in force**; with none, a change applies at
  once, as before. A save that leaves the file broken fires nothing; any changed text that reads as
  good settings fires it, even if no setting changed (Q16, 2026-11-23).
- **A broken read skips the one-at-a-time queue** (the user's choice at step 16's review,
  2026-11-24): its red line is said at once and the settings in force stay; it is never held behind
  a decision or replaced by a newer save.
- **The watcher's first read** (Q27, 2026-11-23, its reading confirmed the same day) fires only if
  a setting differs from the launch's: a live entry, a warning or a left-out row. A live entry
  counts only if it takes effect in this session: not one whose edit only says "at the next launch"
  (`mode`, `sandbox`, `network`, `judge`, `allowedSites`, `memory`, `theme`), nor one a flag or
  variable fixed for the session; and `dangerousCommands` counts only when it tightens, a rule added
  or a kind switched back on (the user's choice at step 16's review, 2026-11-24). Known limits: an
  edit made before that first read that changes only spacing, only such an entry, or only loosens
  `dangerousCommands` fires nothing.
- **The same text saved again** (step 16) fires nothing, as the watcher passes a text on only when
  it differs from the last it read. It is passed on again, and fires again, blocked or applied, only
  if the watcher happened to read the file while an editor had it empty; that is a matter of timing,
  so it is not promised either way. An empty file fires nothing and applies nothing.
- **A ConfigChange being decided is stopped at close and exit** (step 16): its hooks are waited for
  under the window's own stop, and closing the window, which the window's exit also does, stops a
  decision under way and drops the waiting save: neither applies and nothing is said. `-p` does not
  watch the file.
- **A save that changes both the hooks and the lead** (step 16) is decided by the hooks in force:
  blocked, it runs no PreModelSwitch and the lead stays; allowed, its own hooks are in force for the
  switch.

**What the user sees** (W1 to W9)
- **W1 to W8** (Q19, 2026-11-23) are used word for word. W8's rows with no reason drop the reason
  and its colon, as W1, W6 and W7 do (the user's choice at step 4's review, 2026-11-23). W7 follows
  W6's full-stop rule (the user's choice at step 16's review, 2026-11-24). A PreModelSwitch
  time-out's row shows `stopped the switch:` with the time-out's words.
- **Ctrl+O shows nothing under an async run at any of the nine new events**, its text included, as
  no such text reaches the model (kept at step 4's review, 2026-11-23).
- **W9, the README** (step 19): approved as drafted on 2026-11-24, with the roadmap's 8e line saying
  "(this release)", as earlier releases' lines did when they landed, "What it does" saying
  "(releases 8b and 8e)", and the status lines at the top brought up to 8e. The review fixes of
  2026-11-24 say that an async PreModelSwitch hook stops no switch, that a server's form hides a
  question, that the Elicitation events read neither `additionalContext` nor `continue` (a gap from
  before 8e), and, in one sentence, that at the five deciding events only a hook that is not `async`
  decides. Its commits are d58f9ee, 8cde83b, baf77d9, dfbf07d and 99a5c12.

**Tests**
- **Waits on a fake clock** (design, "Testing"; steps 13, 14, 17 and 18): Notification's 6 s and
  60 s, PostModelSwitch's 5 s wait for the prompt's request (`SWITCH_WAIT`, `src/core/session.ts`)
  and PreModelSwitch's 30 s time-out are tested on a fake clock. PostModelSwitch's 30 s is checked
  only as the limit handed to the hook runner, not run out. The exception is a real wait: the test
  clean-up's wait of up to 5 s for the stand-in to exit (below), which is not the switch's 5 s.
  Nothing ran under load.
- **Step 20's outcome:** typecheck and build passed, and the whole suite, run with CI's command,
  which leaves out `tests/tui/external.test.ts`, on 083aebb: "the full run had 1 file time out;
  each passed when run alone". The file is `tests/cli.test.ts`: its `--max-tasks` and `--raw` tests
  each ended with "Test timed out in 15000ms", the tests' own 15 s limit, as in the first full run,
  and the file alone passed, 143 of 143. They are the "slow -p spawns" item already on the cleanup
  list. This is not "all pass". The later commits 78469c2 and a1c0c3f changed tests only and had no
  full run, by the user's choice (2026-11-24); the files that use the stand-in box were each run
  alone and passed. CI runs the suite again at the pull request.
- **The first full run** (on 99a5c12) failed six tests in three files: two in
  `tests/hooks/mcp.test.ts`, two folder clean-ups in `tests/mcp/servers.test.ts`, and the same two
  `tests/cli.test.ts` 15 s time-outs, which passed when the file ran alone. The two tests in
  `tests/hooks/mcp.test.ts` (above) failed every time and were fixed in the tests, the code staying
  as step 15 built it (the user's choice, 2026-11-24; 55c7200). The two clean-ups failed with EBUSY
  and passed alone; for them the stand-in box's server now works in the temp folder
  (083aebb), the clean-up waits for the stand-in to exit (78469c2), and that wait also ends when
  PowerShell cannot start (a1c0c3f), all by the user's choices of 2026-11-24. The failure did not
  show on a quiet machine, so one passing run cannot prove it fixed.
- **Step 20's files:** `tests/hooks/mcp.test.ts`, `tests/standin/dockerExec.mjs`,
  `tests/mcp/fake.ts`, `tests/mcp/servers.test.ts`, `tests/mcp/box.test.ts` and
  `tests/mcp/tools.test.ts`; no source file.
- **The stand-in wait's 5 s** (`tests/mcp/fake.ts`) is carried over from the tests' existing wait
  on another process, "a few seconds for a busy machine, well inside the test's 15 s", and was not
  measured for this wait (the user's choice, 2026-11-24). Only the tests whose clean-up stops
  servers in the stand-in box use it (the servers, box and tools tests); `tests/clilib.test.ts`,
  `tests/mcp/search.test.ts` and `tests/tui/app.test.tsx` start no server in it and were left as
  they are (the user's choice, 2026-11-24).
- **Known limit, a PowerShell that stalls:** the wait has no timer of its own, so a PowerShell that
  starts and then stalls before its wait begins leaves the test to fail at the test framework's own
  time limit for the clean-up (the user's choice, 2026-11-24: a known limit, also for the cleanup
  list).
- **For the cleanup list,** from this build: the page request's question left up after its server
  cancels it (above); the two `tachi-mcp-servers-*` temp folders the first full run may have left,
  not looked at or deleted; the EBUSY clean-up failure, should the fixes above not hold; the two
  `tests/cli.test.ts` time-outs; and the PowerShell stall.
- **Not run by the build:** Linux and macOS; the user's terminal checklist (a Notification hook that
  plays a sound at `idle_prompt`, a PermissionRequest allow, a blocked `/lead`), which step 20's
  report gives for the user to run.
