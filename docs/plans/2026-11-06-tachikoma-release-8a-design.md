# Tachikoma release 8a: saved sessions, resuming and shortening, design (2026-11-06)

Release 8a is the first of release 8's four parts. The overall design, the Decisions table and the
release order are in [2026-10-22-tachikoma-design.md](2026-10-22-tachikoma-design.md). Its section
"Fitting the context window" already settles most of how shortening works; this design says what
8a builds of it, and what it adds.

Release 8 is built in four parts, each with its own design and pull request, keeping the release's
number (user, 2026-11-06, option chosen: "Three parts"; hooks then made a part of their own, option
chosen: "Own part, after 8a"):
- **8a:** sessions saved to disk, resuming them, and shortening a conversation that fills the
  model's window. It ends today's known limit, "The history is never shortened".
- **8b:** hooks, in Claude Code's format.
- **8c:** the MCP client, and the sandbox's list of allowed sites, which shares its address check.
- **8d:** long-term memory (MemPalace) and lessons from the error log.

Each part below was chosen by the user on 2026-11-06 from options offered, and each section was
approved as presented, unless it says otherwise.

Sources, read on 2026-11-06:
- **Claude Code's sessions page** (code.claude.com/docs/en/sessions.md): `--continue` reopens
  "the most recent session in the current directory"; `--resume` opens a picker, or a session by
  ID or name; `/resume`, `/rename`, `/branch`, `--fork-session`, `/clear`, `/export`. Transcripts
  are kept as JSONL per project, with "the 30-day retention" set by `cleanupPeriodDays`. A
  compacted session resumes from "the last compaction's summary". "Interrupted tool calls: a tool
  that was still running when the previous process ended ... doesn't get rerun when you resume."
  Sessions made with `claude -p` are left out of the picker and of `--continue`, but
  `claude -p --continue` includes them. "If you resume the same session in two terminals without
  forking, messages from both interleave into one transcript."
- **Claude Code's context-window page** (code.claude.com/docs/en/context-window.md): `/compact`
  "replaces the conversation with a structured summary". After compaction, "Claude Code re-reads
  up to five of the files Claude has read or edited in the session, choosing the ones modified
  most recently. A file over 5,000 tokens comes back as a path reference without its content."
  `/autocompact` sets "how full the context window gets before the automatic pass runs".
- **Claude Code's CLI reference** (code.claude.com/docs/en/cli-reference.md): `-c`, `-r`, `-n`,
  `--fork-session`.

## Saving sessions

- **Where.** Each session is written to `<data folder>/sessions/<project>/<id>.jsonl` as it goes,
  `<project>` being the folder's real path hashed, as the error log's file is named, and `<id>` a
  random one. The folder is made private as the error log's is. Transcripts hold everything the
  model read, so they stay out of the project, where they could be committed (option chosen:
  "Private data folder"; the main design had put them in the project's `.tachikoma/sessions`).
- **What.** One line per message, saved whole, the provider's own content for a reply included
  (Anthropic's thinking blocks), so a resumed session can carry on with the same provider. Other
  lines record the session's start (project path, lead, Tachikoma's version, whether it is a `-p`
  run, and the system prompt and tool list its requests send), a lead switch, a name, and a
  shortening: one line holding the system prompt the requests after it send and the new history,
  so a shortening is saved whole or not at all.
- **Pictures** are saved once each, as a file in `<id>/pictures/`; the transcript's line holds the
  picture's number and file name, not its data (option chosen: "Save them privately").
- **Subagents** each have their own transcript, `<id>/subagents/t3.jsonl`.
- **When.** Each line is appended as its message joins the history, one append per line, as the
  error log and the prompt history write theirs, so two windows in one project never clash.
- **A write that fails** says so in one line and turns saving off for the rest of the session. The
  session carries on, but it cannot be resumed, and shortening is refused, since shortening must
  never drop what is not on disk (main design); a request too long then ends with an error, as
  today.
- **Kept for 30 days.** At start-up, sessions not written to for 30 days are deleted, each with its
  own folder; `"cleanupPeriodDays"` in `~/.tachikoma/settings.json` changes the number (option
  chosen: "30 days, settable"; Claude Code's default and its setting's name, so release 14's import
  can copy it). The sweep deletes only files Tachikoma named, never follows a link, and never
  touches a session open in another window.
- **`-p` runs** are saved and marked so. `--continue` and the `--resume` list leave them out;
  `tachi -p --continue` carries on the newest one (option chosen: "Saved, hidden from lists").

## Resuming

Added on the user's choice (option chosen: "Add resume in 8a"; the ways in, option chosen: "Like
Claude Code").

- **`tachi --continue`** (`-c`) reopens this folder's newest session.
- **`tachi --resume`** (`-r`) lists this folder's sessions, newest first. Each row shows the
  session's name or its first prompt, how long ago it was last used, its lead, and the file's
  size. Up and Down move, Enter opens, Esc quits.
- **`tachi --resume <id or name>`** opens one directly. A name that more than one session has opens
  the list filtered to it.
- **`/resume`** inside a session shows the same list and switches this window to the session
  chosen; the one left stays saved.
- **`/clear`** starts a new, empty session in this window, with the same lead and mode; the old
  one stays in the list (option chosen: "Add /clear").
- `/resume`, `/clear` and `/branch` (below) wait their turn in the queue, as `/lead` does, while a
  turn runs, and are refused while a subagent is still running, with a line naming it, so a
  subagent's answer can never arrive in the wrong session.

**What comes back:**
- The conversation, from the last shortening on when it was shortened, as Claude Code does it.
  Pictures are read back from their files.
- Auto mode's judge's view: every prompt typed and every tool call, rebuilt from the transcript.
- The lead it last used, unless `--lead` is given. If that provider is no longer set up, the
  launch's own lead is used, with one line saying so (option chosen: "Lead only").
- The mode, the sandbox and the network come from this launch's flags and settings, as for a new
  session, so resuming never brings back `auto` or `never` unasked.
- The system prompt the session last sent, read from the transcript, as Claude Code does (user,
  2026-11-06, option chosen: "Reuse the saved prompt"). Anthropic's newer models refuse a past
  thinking block when anything before it changed, the system prompt or the tool list included
  (see "Before the build", check 2), so a prompt built afresh would refuse a resumed Anthropic
  session whenever an instruction file had changed. Edits to instruction files apply from the next
  shortening, `/clear`, or a new session: a shortening leaves no past replies, so it builds the
  prompt afresh and saves it. If this launch's tool list differs from the saved one, the old
  replies go from Tachikoma's own record, without their thinking blocks, calls and results kept
  together, and one line says so.
- Not brought back: the to-do list, and subagents that had not finished, each of which gets one
  line in the conversation saying so.
- A tool call the old session never answered (a crash during a turn) is never run again. It may
  have run, in full or in part, before its result could be saved, so its result is (approved as
  worded): "Outcome unknown: the session ended while this was running, or before its result was
  saved. It may have run in full or in part. Check what it would have changed before running it
  again." The same result goes to any call left without one after a bad line is skipped (see "When
  something goes wrong"), and a result whose call is missing is dropped, so every call still has
  exactly one result.

**A session open in another window.** A small lock file marks a session open, the lock the saved
ChatGPT login uses, which frees itself when its window ends. Resuming a session open elsewhere opens
a copy: a new id and file, holding everything saved so far, and one line, "Opened a copy: that
session is open in another window." Neither window's file is ever mixed (option chosen: "Open a
copy").

**In copy mode,** a resumed session gets a fresh copy of the project as it is now. The earlier
copy's changes were reviewed then, or are kept for `tachi review`.

## Names, branches and export

Added after the user asked when the features first left out would come (option chosen: "Small ones
in 8a"). Each follows Claude Code's name for it.

- **`/rename <name>`**, or `tachi -n <name>` at launch, names the session. The name shows in the
  `--resume` list and opens it with `tachi --resume <name>`.
- **`/branch [name]`** copies the conversation so far under a new id and switches this window to
  the copy; the original stays in the list unchanged. Without a name, the copy is named after the
  first prompt.
- **`--fork-session`** with `-c` or `-r` opens a copy instead of the session itself, the copy that
  opening a session twice makes.
- **`/autocompact <tokens>`** (such as `/autocompact 200k`) shortens once the conversation passes
  that size, even when the window has room; `/autocompact off` goes back to shortening only when a
  request would not fit. `"autoCompactWindow"` in the settings file sets it for every session.
  It is off unless set, as a default number would need a source. Like the other `/` commands, it
  changes this window only and saves nothing (release 6 plan, choice 26).
- **`/export <file>`** writes the conversation as text to read: the prompts, the replies, and each
  tool call with its result, pictures as their markers. A file that already exists is never
  overwritten; one line says so. `/export` alone copies the text to the clipboard, through release
  6's clipboard code.

## When to shorten

- **Before each request,** its size in tokens is estimated:
  - **Same provider as the last request:** the size that provider reported for it, plus what has
    been added since, turned into tokens with the ratio of tokens to characters that provider has
    reported in this session (main design; no fixed number).
  - **After a lead switch, a resume or `/clear`:** Anthropic counts the whole request exactly with
    its token-counting call. Other providers have no ratio yet, so no advance check; the safety
    net below covers them.
- **If it will not fit** the lead's window, or passes the `/autocompact` size when one is set, the
  history is shortened first. On Anthropic, an estimate that says it will not fit is confirmed
  with an exact count before anything is shortened, so a rough estimate never costs a needless
  summary. This changes the main design, which counted every Anthropic request exactly: that adds
  a round trip to each request, and here the count runs only when it decides something.
- **No room is set aside for the reply,** so no number is needed. An Anthropic reply that runs
  into the window stops with `model_context_window_exceeded`, which Tachikoma already reads. That
  half-written reply is now thrown away, never stored, as a refusal is; the history is shortened
  and the request sent again, once. OpenAI and ChatGPT report a reply that ran out of room as one
  that hit its output limit, so that turn ends as today, and the next request, now over the
  window, shortens first.
- **The safety net.** A request a provider rejects as too long shortens the history and is sent
  once more. Rejected again, the turn ends with an error giving the request's size and the model's
  window.
- **`/lead` to a smaller window** checks whether the conversation fits the new lead, and if not,
  shortens with the current lead first. If that summary fails, the switch is refused and the old
  lead stays.

## How shortening works

It runs by itself, on `/compact` (option chosen: "Add /compact"), on the `/autocompact` size, or
before a `/lead` switch.

1. **The transcript must be on disk** up to this point. If it is not, shortening stops with an
   error and nothing changes.
2. **The "before shortening" step.** 8b's PreCompact hooks run here, and 8d's built-in memory save
   is started here, never waited on (user, 2026-11-06: "do a built in save but also we need hooks in
   general"). In 8a the step is empty, built as the place they join.
3. **The summary request.** The current lead is sent the part to be summarised (step 4), then the
   summary instructions below as the user's; when that part already ends with a user message, the
   instructions join it, so the roles still take turns. That part always ends on a complete
   exchange: every tool call in it has its result in it, so the request never holds a call without
   its result. `/compact <words>` adds the words as what to focus on.
4. **Nothing is left out:** every message either goes into the summary or is kept. A tool call and
   its result are never split. What is kept depends on when shortening runs:
   - **Between turns** (`/compact`, a `/lead` switch): the whole history goes into the summary,
     whether or not it holds any tool calls.
   - **At the start of a turn,** the check before its first request: everything before the prompt
     just typed goes into the summary, and that prompt is kept whole, its pictures included.
   - **During a turn,** the check before a request that follows a round of tool calls: everything
     before the reply that made the latest round goes into the summary, the turn's earlier rounds
     among it, with what is done and what is left. The turn's prompt is kept whole, and so is the
     latest round: that reply's words and calls, and the calls' results, copied in as text, as the
     main design's cut inside a turn does it. If the prompt and that round still do not fit, the
     round goes into the summary too, the reply with its results after it, as a complete exchange;
     if the prompt alone does not fit, the turn ends with the error in "When to shorten".

   If the part to be summarised is too big for the lead, it is summarised in pieces that fit, and
   the pieces combined (main design).
5. **The new history** is one message: the summary; what step 4 keeps; and up to 5 of the files
   read or edited in this session, most recently changed first, each only if under 5,000 tokens,
   a larger one named without its content (Claude Code's figures; option chosen: "Like Claude
   Code", over keeping recent exchanges word for word, which had no way to be measured). A file's
   tokens are estimated with the lead's ratio, as above.
6. **The transcript** gets a line marking the shortening, so a resume starts from it.

**The summary instructions** (approved as worded):

> Summarise this conversation so work can carry on from the summary alone. First, under "Your
> instructions", copy word for word every instruction, limit or preference the user gave, such as
> "don't push". Then cover: what the user asked for; what has been done, with file paths;
> decisions made and why; errors met and how they were fixed; what is still to do; and what was
> being worked on at the end.

The user's limits are quoted word for word (option chosen: "Quote them word for word"). The README
still says a rule that must hold belongs in `dangerousCommands`, since a model can miss one.

**Carried over from the main design:** a failed or cancelled summary changes nothing; Ctrl-C stops
it and its cost counts as any request's; the summary must fit the space the next request has, and
is checked before it is used. Pictures in the summarised part are not carried into the new history:
the summary mentions them, and the transcript keeps them.

**On screen,** nothing leaves the scrollback. One line says "Conversation shortened (Ctrl+O shows
the summary)", and the status line's context gauge drops.

**`-p` runs and subagents** shorten the same way, each subagent from its own transcript (option
chosen: "Shorten them too").

**Auto mode's judge is untouched:** it keeps every prompt typed and every tool call, whole.

## When something goes wrong

- **Saving transcripts is a safeguard for shortening only.** A failure turns it off with one line,
  and shortening and resuming that session are refused; nothing else stops.
- **The start-up sweep** skips a file it cannot delete and names it in one line; start-up never
  fails over it.
- **A transcript that cannot be read whole,** such as a half-written last line after a crash: the
  bad line is skipped, as the error log does, and calls and results are then paired as in
  "Resuming". If no conversation can be rebuilt, resuming says so and starts nothing.
- **A torn last line is mended before anything is added.** Under the session's lock, before the
  first append of a resumed session, a file that does not end in a line break gets one, so the next
  line starts on its own and the torn one stays a single skipped line, never joined to a new
  message. Nothing in the file is deleted. A copy of a session open elsewhere takes only its whole
  lines.
- Every failure says what broke and what to do, and goes into the error log.

## Before the build

Each result is recorded in the plan.

1. **Each provider's exact "too long" error,** from its documentation, then confirmed by a live
   test the user runs with their own key. "Too long" is never guessed from loose wording.
   **Read 2026-11-06:**
   - **Anthropic** (platform.claude.com/docs/en/build-with-claude/context-windows, "Context window
     overflow behavior"): "If the input alone already exceeds the model's context window, the API
     returns a 400 `invalid_request_error` ("prompt is too long") on every model." And "On Claude
     4.5 models and newer, if input tokens plus `max_tokens` exceeds the context window size, the
     API accepts the request. If generation then reaches the context window limit, it stops with
     `stop_reason: "model_context_window_exceeded"`."
   - **ChatGPT plans** (OpenAI's own Codex, read on GitHub, `codex-rs/codex-api/src/sse/
     responses_error.rs` and its tests): the stream ends with a `response.failed` event whose
     `error.code` is `context_length_exceeded`, message "Your input exceeds the context window of
     this model. Please adjust your input and try again."
   - **OpenAI API:** its error-codes and conversation-state pages name no code for it; the live
     test decides.
2. **Whether Anthropic accepts a resumed conversation's thinking blocks.** **Read 2026-11-06**
   (platform.claude.com/docs/en/api/errors, "Thinking block bound to a different conversation"):
   on Claude 5.1 and later models, a thinking block sent back fails "if something before the block
   changed after the block was produced, such as the `system` prompt, `tools`, or an earlier
   message". So a resumed session reuses its saved system prompt (see "Resuming"), and when the
   tool list differs, sends its old replies from Tachikoma's own record of them, without Anthropic's
   thinking blocks, as a session that switched to Anthropic from another provider already does: the
   words, and each tool call with its result, stay as calls and results, so none is left without
   the other. A live test confirms both forms are accepted.
3. **Whether Anthropic's token count takes the full request:** tools, pictures, and the fallback
   setting.

## Testing

- Everything runs against the fake provider, with no network. Each test's data folder is two
  levels inside a fresh temporary folder, as the test rules require.
- **The main design's edge cases:** a finished tool round kept across a shortening and a lead
  switch; one turn too big on its own; a failed transcript write; a failed or cancelled summary; a
  reply cut off at the window never runs its tools.
- **Added here:** shortening a conversation with no tool calls, and one whose latest round of tool
  calls is followed by exchanges without any; shortening at the start of a turn and during one;
  resuming after a crash during a turn; a torn last line, then a resume, an append and a second
  resume; a bad line in the middle leaving a call without its result; a session open twice;
  pictures brought back; the 30-day sweep against links and open sessions; `/clear`, `/resume` and
  `/branch` while a subagent runs, and queued while a turn runs; a name more than one session has;
  `/export` to a file that exists.

## Not in this release

- Hooks: 8b. The memory save before shortening, and lessons: 8d.
- Rewinding, with the files put back as they were: release 9 (user, 2026-11-06, option chosen:
  "Right after release 8"; every later release moves down one, to 15).
- The README's release list and its later release numbers are brought up to date in 8a's docs task.

## As built

Where the build differs from the design above, or settles what it left open, and what was measured
on the way. The plan (`2026-11-06-tachikoma-release-8a.md`) lists its 27 choices, each marked in its
task, with every line the build added in its table "Lines this plan adds"; every number here is
from the plan, from the code's comments, or from Task 1's live tests, as cited. "The user's choice"
marks the user's answers, all given on 2026-11-06 from options offered. The README's known limits
gather every rarer case the build left as a limit.

- **The live tests (plan, Task 1, run by the user).** Anthropic's "too long" is a 400
  `invalid_request_error` whose message starts `prompt is too long` ("prompt is too long: 1000050
  tokens > 1000000 maximum"). Anthropic's count said 1,000,001 tokens for that request, 49 short
  of the 1,000,050 the request was refused at, so no margin is added and the "too long" answer is
  the safety net. The count refuses the fallback setting (`fallbacks: Extra inputs are not
  permitted`) and takes a tool and a picture, so it is sent without `betas` and `fallbacks`
  (choice 19, changed so). A changed system prompt with the thinking blocks kept was accepted on
  the user's account, which predates the check's enforcement; the design's reuse of the saved
  system prompt stands, for other accounts. OpenRouter's "too long" is a 400 whose `code` is the
  status again and whose message starts `This endpoint's maximum context length is`. The ChatGPT
  plan goes by Codex's source and the OpenAI API was not tested, by the user's choice ("codex for
  chatgpt and lets test the api"), so "too long" is read from Anthropic, OpenRouter and the
  ChatGPT plan only, and the OpenAI API's, Kimi's and Ollama's answer ends the turn as before
  (choice 20, changed so: it had expected an OpenAI code).
- **The system prompt at a shortening and at `/clear`** reads the instruction files again; a file
  outside the project goes in only if the launch's question allowed it, and one the launch did not
  ask about is left out without asking (choice 3; the user's choice, "Re-read, reuse launch's
  answer").
- **The transcript's lines (choice 4), as built:** a `subagent` line holds the subagent's
  description, which the "had not finished" line names (Task 3). A subagent's own file ends with an
  `ended` line when it fails or is stopped, so one the lead already heard about is not reported
  lost (the user's choice, "Record how it ended"), and a resume that reports one lost writes `lost`
  there, so it is reported once (the user's choice, "Report once"). A resume whose lead differs
  writes a `lead` line, so the next resume opens with the lead last used; one whose tools differ
  writes a `tools` line, and a reply keeps its thinking only under the tools it was saved under, so
  a session resumed under other tools and then the first ones again never sends thinking made under
  the wrong list (Task 6's spec review).
- **Pictures (choice 5):** a picture numbered before `/resume` or `/branch` loaded another
  conversation takes the next free number when it is sent, and the sent line shows it (Task 7; the
  user's choice, "Renumber on send").
- **Saving that fails (Task 5):** the line is a new error kind, `saving`, so the error log keeps
  it, drawn as `✗ ` and the line (the user's choice, "✗ then the line"). It fails no `-p` run and
  no subagent. A subagent's own file failing has its own line, the lead saving on (the user's
  choice, "Its own line"). A load keeps the window's answer to "Send again without the pictures"
  (the user's choice, "Keep for the window").
- **Resuming (Task 6):** the conversation is drawn on screen above the resume lines (the user's
  choice, "Show it"). The session is opened, mended and read before the instruction files' question
  and the sandbox, so one that cannot be read starts nothing. "Opened a copy" is said only when
  another window holds the session, not for `--fork-session`, where it would be false. The help
  lines, the list's headings, hint, ages and sizes, `Resumed: <id>.`, the "could not be read as a
  session" line's reason `its first line is missing or damaged`, and the "could not be copied" line
  with its reason `its lock could not be taken` are the user's approved wording.
- **In the window (Task 7):** `/resume` switches to the picked session's saved lead, falling back
  to the window's with the "not set up" line (the user's choice, "The session's saved lead"). The
  window's sandbox carries on across a switch, so copy mode's review at the end covers every
  session the window had. The error log's rows carry the open session's id. The menu notes and the
  lines for `/resume` with nothing else saved, `/branch` before any prompt, `/branch` and
  `/rename` once saving has stopped, and the in-window list's hint are the user's approved wording.
- **`/export` (Task 8, choice 27):** each reply is saved with the lead that wrote it, never sent to
  a provider, and headed with it (the user's choice, "Record each reply's lead"); the notes the
  session added for the lead, a background subagent's answer, failure or stop and a crash's "answer
  was lost" line, are written where they arrived, under `Subagents:` (the user's choice, "Include,
  headed Subagents:"). The file has LF line endings throughout, a message's own CRLF included.
- **The size check (Task 10, choice 17):** a reply served by Anthropic's fallback model teaches the
  model that answered, not the lead, so no ratio is borrowed from another model; while the fallback
  serves every request, the lead is counted exactly each time (the user's choice, "The model that
  answered"). A lead with no known window and no `/autocompact` size has no check ahead of a
  request.
- **Shortening (Task 11, choices 22-23):** a file in the new history whose size cannot be estimated
  yet, or that cannot be read, is named with a short note (the user's choice, "Two short notes");
  the kept round's results keep Ctrl+O's `⎿` mark (the user's choice, "Keep the ⎿ mark"). A part
  too long to summarise is cut at the message nearest its middle, never between a call and its
  results, rather than only between whole exchanges, so one long task can be cut inside; a later
  half opens with "This is the later part of a conversation; the part before it is summarised
  separately." and is sent without the replies' thinking, as Anthropic refuses a request that
  opens with a reply and thinking moved from its place (choice 23, changed so; the user's choice,
  "Cut anywhere, add a line"). The seven reasons a shortening fails are the user's approved wording
  ("Approve all").
- **Shortening in the session (Task 12):** when saving has stopped, `/lead`'s refusal gives the
  reason `saving this session stopped` (the user's choice, "Approve"). A failed lookup of an
  Anthropic model's window is kept as not known for the provider's life, as the session asks before
  every request (Task 12's review; `src/providers/anthropic.ts`). Esc or Ctrl-C during `/lead`'s
  shortening stops it quietly, the lead staying as it was (`src/tui/app/queue.ts`).
- **`/compact` and `/autocompact` (Task 13):** a shortening for the `/autocompact` size that fails
  while the request still fits the window shows the red line and sends the request as it is (the
  user's choice, "Show the line, send anyway"), and the size is not tried again until the next
  prompt (the user's choice, "Retry next turn"). Their menu notes, the heading over the summary on
  Ctrl+O and the settings-edit lines are the user's approved wording ("Approve all"). `/lead`
  switches at once when there is nothing to shorten or no window to look up, so a prompt typed
  straight after it waits for the switch (Task 13's spec review).
