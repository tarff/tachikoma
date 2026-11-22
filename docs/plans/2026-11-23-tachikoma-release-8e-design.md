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
  After several switches in a row, only the last one's text goes.
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

- **Rule tests:** the nine events accepted; the two special warnings; each event's matcher; each
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
  - PostModelSwitch's text just inside and just outside the 5-second wait;
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
