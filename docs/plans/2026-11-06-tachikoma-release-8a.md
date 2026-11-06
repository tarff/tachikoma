# Tachikoma Release 8a (saved sessions, resuming and shortening): Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to build this
> plan task by task: a fresh builder per task, then a spec review, then a code review.

**Goal:** every session is saved as it goes, and can be reopened (`tachi -c`, `tachi -r`,
`/resume`), started afresh (`/clear`), named (`/rename`, `-n`), copied (`/branch`,
`--fork-session`) and exported (`/export`). A conversation that will not fit the model's window is
shortened into a summary instead of ending with an error, on its own, on `/compact`, or past an
`/autocompact` size.

**Architecture:**
- **Transcripts** live in `src/core/transcript.ts`: the line format, writing, reading back, and
  mending a torn last line.
- **The store** lives in `src/core/sessions.ts`: a project's sessions folder, the list, finding
  one by id or name, the open-session lock, copies, and the start-up sweep.
- **The `Session` object stays one per window.** It gains `load(conversation)`, which `/clear`,
  `/resume` and `/branch` use to swap the conversation inside it. The judge, the subagents and
  the screen all hold that one object (see the facts below), so it is never replaced.
- **Session writes its own transcript** in `#push`, before the `message` event, so every message
  is on disk before anything else sees it.
- **The size check** is `src/core/fit.ts`.
- **Shortening** is `src/core/shorten.ts`.
- **Each provider learns** to say whether an error means "too long", and Anthropic's provider
  learns to count a request exactly.

Design: `docs/plans/2026-11-06-tachikoma-release-8a-design.md`.

**Tech stack:** as release 7 (TypeScript 7.0.2, Ink 7.1.1, React 19.3.0, Vitest 5.0.3,
ink-testing-library 4.0.0, zod 4.6.7, `@anthropic-ai/sdk` 0.132.0, `openai` 7.30.0). No new npm
package.

---

## Before you start

**How this plan is built.** As release 7, each task gives the files, the interfaces, the
behaviour and the tests, and each test says what it must show. A builder writes the tests first
and sees them fail, then writes the code, then commits. A spec reviewer and then a code reviewer
check the commit before the next task starts. The plan has four parts:
- **Part 1, groundwork (Tasks 1-5):** the live tests, test isolation, transcripts, the store,
  and a session that saves and loads.
- **Part 2, resuming (Tasks 6-8):** the launch flags, the in-window commands, and `/export`.
- **Part 3, shortening (Tasks 9-13):** the providers, the size check, shortening itself, its
  triggers, `/compact` and `/autocompact`.
- **Part 4, the documents (Task 14).**

**The branch.** Build on the local branch `release-8a` (main dc088fd plus the design, head
e0bae94 or later). Do not push: every push needs the user's fresh say-so, and main takes changes
only by pull request.

**Checks, from the repo's folder:**
- Types: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
- One file: `node node_modules/vitest/vitest.mjs run tests/core/transcript.test.ts`
- The App's tests, only with `-t`:
  `node node_modules/vitest/vitest.mjs run tests/tui/app.test.tsx -t "App's sessions"`. The file
  has about 474 cases; never run it whole for a task.
- Build: `npm run build`
- **The whole suite runs once at the end of each part, not after each task** (user, 2026-10-31).
  A builder runs the test files the task touches, plus any file that imports a module the task
  changed. Never run `tests/tui/external.test.ts`: it opens real programs.

Tests that start PowerShell or other programs sometimes run past Vitest's 5 s limit when the
machine is busy. A time-out is not a failure of this release if the file passes run alone. The
files known to do this:
- the `tests/auth/` files;
- `tests/providers/registry.test.ts` and `models.test.ts`;
- `tests/tui/history.test.ts`, `statusline.test.tsx` and `conversation.test.tsx`;
- `tests/settings.test.ts`.

**Rules for every task:**
- **Tests first,** seen failing for the right reason, then the code. One commit per task, plus
  `fix:` commits for review findings.
- **Tests never touch the user's own things.** No test reads or writes the user's own files
  (settings, keys, history, data folder, git settings), contacts a provider, or uses the network.
  - Every test that saves sessions uses a data folder two levels inside a fresh `mkdtemp`
    folder: `TACHI_DATA_DIR`, or the store's `data` argument.
  - Task 2 makes this the default for `tests/cli.test.ts` and the App's tests.
  - Git in a test runs with HOME, HOMEDRIVE/HOMEPATH, USERPROFILE, XDG_CONFIG_HOME and
    GIT_CONFIG_GLOBAL/SYSTEM pointing at folders and files the test made.
- **Never change permissions** on any file or folder (no `icacls`, `chmod`, ACL calls), in a test
  or by hand. A read-only file in a test is made with `writeFileSync(f, data, { mode: 0o444 })`.
  Code that makes folders private goes through `privateDir` (`src/auth/private.ts`), as the
  error log does, and a test points it at a folder two levels inside a fresh `mkdtemp` folder.
- **Deletes:** code deletes only files Tachikoma named, never follows a link, and removes a folder
  by reading it with file types: a link is unlinked, never entered. A builder deletes only files
  they made, by exact name.
- **No package installs, and no fetch from any registry.** Task 1's live tests are run by the
  user.
- **Windows tools whose switches start with `/`** run from PowerShell or Node, never Git Bash.
- **Match the code around you.** Use plain-language comments that say why, citing the design's
  section ("release 8a design, \"Resuming\"") or this plan's choice ("release 8a plan, choice 6").
  No comment restates the code. Code lines go up to 160 columns; prose in docs up to 100.
- **Every number in the code has its source in a comment:** the design, Claude Code's docs, a
  provider's docs, Task 1's live test, or this plan's table.
- **Every user-visible line is triggered for real in a test,** and its exact words checked. Its
  words are the ones in "Lines this plan adds", which the user approves with the plan.
- **Commit messages:** `feat: ...`, `fix: ...`, `docs: ...`, `test: ...`, `refactor: ...`, ending
  with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_011HyFwTrMHgymaTPqy6wZCX
  ```

**Facts the tasks rely on** (read 2026-11-06 by three read-only surveys of the code at dc088fd):

**The session** (`src/core/session.ts`)
- `readonly messages: Message[] = []` (:32) is append-only; the comment is at :31. The system
  prompt is "fixed for the whole session" (:16).
- The judge's input is `prompts` and `calls` (:36-37). Prompts are kept unless `subagent` is set
  (:88-89), and calls are kept before they run (:133).
- **The turn** (:85-145):
  - The user message is pushed (:92), then the loop runs `#request` (:98).
  - A refusal is never stored (:110-115).
  - The reply is pushed (:120).
  - A `cutOff` emits an error. A reply with calls gets "Not run" results (:123-129), and the turn
    ends.
  - Tool results and the inbox go back as one user message (:142).
- **`#request`** (:148-191):
  - It passes `this.messages` itself (:157).
  - Usage is emitted last (:164-165).
  - Any 400 when the history holds pictures asks "Send again without the pictures" (:182-188).
    A too-long 400 would reach this question today.
- `#push` (:224-227) is the only place messages change. It emits `message`.

**Subagents** (`src/core/tasks.ts`)
- Each subagent builds its own `Session` with `subagent: true` and a private bus (:162, :184-192).
- It aliases `t.messages = session.messages` (:193).
- Ids `t1, t2…` come from `all.length + 1` (:97), so they restart in each process.
- `running` (:90-92) counts running and waiting subagents.
- The answer is the last assistant message's text (:202-205).

**Types** (`src/core/types.ts`)
- `Part` is at :6-14. An image is `{type:"image", id, mediaType, data: Buffer}`.
- `Message.native` is `{provider, content}` (:29-35).
- `Turn.cutOff.kind` is `"max_tokens" | "refusal"` (:51-63).
- `Provider` has `contextWindow?` and no token count (:83-88).
- `ProviderError(message, status?)` has no `code` (:92-99).

**Stats and the gauge**
- `context = input + cacheRead + cacheWrite + output` of the lead's latest request (stats.ts:16-20).
- The window comes from `ui.session.lead.contextWindow?.()` (tui/app/output.ts:45-51).
- The gauge is StatusLine.tsx:34, :79-85.

**Providers**
- **Anthropic:**
  - `MAX_TOKENS = 64_000` (anthropic.ts:13).
  - Native replay happens only when `native.provider === "anthropic"` (:47-48).
  - `model_context_window_exceeded` becomes `cutOff` max_tokens "The conversation filled the
    context window" (:114). It is stored and ends the turn.
  - Its errors are rethrown as the SDK's `APIError` (:155).
  - The SDK has `client.beta.messages.countTokens` (resources/beta/messages/messages.d.ts:77);
    nothing calls it.
- **OpenAI:** rethrows `OpenAI.APIError`, `.code` included (openai.ts:164), and has
  `finish_reason "length"` → max_tokens (:116).
- **ChatGPT:**
  - `response.failed` throws `planError({code, message})` without a status (chatgpt.ts:157-159).
  - The code survives only inside the message text (:58, :78-82).
  - `contextWindow` comes from the plan's model list (:303-305).

**Files and locks**
- **`withLock(file, fn, onWait?, signal?)`** (lock.ts:158) makes a lock file by `linkSync`.
  - A lock is stale when it holds no pid, its pid is not running, or it is older than the last
    boot (:81-86).
  - There is no renewal. It is released at process exit (:17).
- **`privateDir`** (private.ts:66-89) runs PowerShell once per folder per process, about 0.4 s
  (errorlog.ts:13-14).
- **`readPrivate`** (:93-119) refuses links and hard links.
- **`writePrivate`** (:126-163) rewrites a whole file.
- **The error log** appends one line per row with `appendFileSync` and no lock (errorlog.ts:15-27).
  Its `parse` skips bad lines (:30-36).
- **`projectFile(folder, root)`** gives `<data>/<folder>/<sha256(realpath)>.jsonl`
  (datadir.ts:18-26).

**Launch** (`src/cli.tsx`)
- `fail()` is at :124-127.
- `drawReview` (:150-166) is the pattern for a full-screen Ink screen before the session.
- Subcommands are switched on `argv[2]` (:190-243).
- **`parseArgs`** is at :245-269.
  - Short flags are only `-p` and `-h`.
  - A string option always needs a value.
  - A stray positional throws.
- `loadSettings` is at :278 and `resolve` at :288.
- The session id is made at :306 (`randomUUID()`), and `attachErrorLog` is at :307.
- The lead is made at :318-322.
- The system prompt is built at :434, the gate at :443-447 (judge `() => session`), Tasks at
  :452-460 (worker `() => worker ?? session.lead`), and `new Session` at :468-477.
- `-p` is at :479-525; `-p --json` prints `jsonLine` for `message` (:485-488).
- The App is rendered at :561-604.

**Settings**
- `Settings` is at settings.ts:22-40 and `readSettings` at :57-90.
- Validation errors read `` `${entry} must be …` ``.
- Validators are in clilib.ts: `taskCount` (:82-86) is the pattern for a whole number.
- `LIVE` keys are at tui/app/constants.ts:75-78; a live edit goes through liveEdits.ts:17-133.

**The screen**
- **Slash commands live in three lists:**
  - the `/` menu (tui/menus.ts:25-37);
  - `NAMES` (tui/app/constants.ts:66-69);
  - the `COMMANDS` help string (:54-56).
  - `tests/tui/menus.test.ts:13-24` expects the menu's exact labels.
- **`perform`** (tui/app/queue.ts:76-161) runs them.
  - `/lead` is at :112-116.
  - "Takes nothing after it" is at :121-122.
  - **`next()`** (:40-67) holds the queue only while a turn runs or a list or question waits.
    Subagents hold nothing.
- **`ui.session` is a plain prop** (App.tsx:53, state.ts:29). The judge and Tasks close over
  cli.tsx's `const session`.
- **Lines on screen:**
  - `describe()` (tui/describe.ts:36-61) turns a message into lines, and `say()`
    (tui/app/output.ts:9-18) adds them.
  - Full screen keeps them in `Rows`, which has no clear (view.ts:149-195).
  - Classic prints them through `<Static>`, which cannot un-print.
- **The picker pattern:**
  - `ModelPicker.tsx` (props :36-58, keys :103-123), `ui.picker` (state.ts:200), rendered at
    App.tsx:675-692.
  - Phases are in phase.ts:10-19 and :91-100; `PHASE_CONTEXTS.picker` is `["Select","Global"]`.
- **Ctrl+O:**
  - `"lastTurn"` → `fns.openDetail(lastTurn(...))` in full screen, `fns.show(...)` in classic
    (tui/app/promptKeys.ts:34).
  - `openDetail(lines)` takes any `Line[]` (handover.tsx:26-31).
- **The clipboard:** `Clipboard.copy(text)` (tui/clipboard.ts:246-293), made once as
  `ui.board.current` (state.ts:206-212).
- **Pictures:**
  - They are numbered from 1 per process by `Pictures.next()` (tui/pictures.ts:13-24).
  - The shrunk-picture cache is keyed by picture number (providers/pictures.ts:142-144;
    session.ts:43).
- **The App's tests:**
  - `mount(turns, opts)` (tests/tui/app.test.tsx:105-231) gives `historyFile` and `errorFile`
    their own temp paths.
  - `FakeProvider`, `reply` and `callTool` are in tests/helpers.ts.

**The CLI's tests** (`tests/cli.test.ts`)
- `launch()` (:46-69) spawns `src/cli.tsx` through tsx with a fresh home.
- It **does not set `TACHI_DATA_DIR`**, so today an error in a `-p` test writes to the user's real
  error log. Task 2 fixes this before anything saves sessions.

## Numbers in this plan

| Number | Where | Source |
|---|---|---|
| 30 days | sessions kept by default (`cleanupPeriodDays`) | Claude Code's sessions page, "Change the 30-day retention" (design, Sources) |
| 5 files, under 5,000 tokens each | read back into the history after shortening | Claude Code's context-window page (design, "How shortening works") |
| 1 | requests sent again after shortening for a "too long" error or a reply cut off at the window | the main design, "Recovery" |
| k = 1,000; m = 1,000,000 | `/autocompact 200k` | Claude Code's `/autocompact 500k` (its model-config page) |
| 64,000 | Anthropic's `max_tokens`, unchanged | release 1, the claude-api skill |

No other number is set. Anywhere a builder feels a number is needed (a time-out, a retry, a size
limit), they stop and ask the controller, who asks the user.

## Choices this plan makes that the design leaves open

Each is marked in its task. The user approves them with the plan.

**The session object**
1. **One `Session` per window, whose conversation is swapped.** `/clear`, `/resume` and `/branch`
   call `session.load(conversation)`. They never make a new `Session`, because the judge
   (cli.tsx:446), the subagents' worker (:455) and the App (App.tsx:53) hold the object. `load`
   replaces the messages, prompts, calls, system prompt, transcript and next picture number in
   place, and:
   - **empties the shrunk-picture cache** (`#shrunk`, session.ts:43). Its keys are a picture's
     number and the limits it was shrunk to (providers/pictures.ts:62-66), so a cache kept across
     conversations would send the last conversation's picture 1 for this one's picture 1;
   - **takes `prompts` and `calls` from the transcript's whole record** (choice 6), never from
     the loaded messages, which after a shortening hold only the summary;
   - **raises the subagents' next id** to follow the saved ones (choice 4).
2. **The message array is changed in place** (emptied and refilled) by `load` and by shortening,
   so the `readonly` field and a subagent's alias (tasks.ts:193) stay valid. The comment at
   session.ts:31 changes to say the history only grows except when shortened or loaded.
3. **The system prompt becomes the conversation's.** It is kept on the session, saved in the
   transcript, and rebuilt only at a shortening, `/clear`, or a new session (design, "Resuming").
   `SessionOptions.system` stays the starting value. A shortening rebuilds it through a
   `systemNow()` callback that cli.tsx passes in, which reads the instruction files again. Files
   outside the project go in only if the launch's question approved them; one not asked about at
   launch is left out without asking (user, 2026-11-06, option chosen: "Re-read, reuse launch's
   answer").

**The file**
4. **The format,** one JSON object per line, each with `"t"` and `"at"` (ISO time):
   - `start`, first, once: version 1, the session id, project path, lead, Tachikoma's version,
     `-p` or not, the system prompt, and the tool specs.
   - `message`: one `Message`.
   - `lead`: a new lead's id. A resume whose lead differs from the saved one writes one too, so the
     next resume opens with the lead last used (Task 6 spec review, 2026-11-06).
   - `tools`: this launch's tool specs, written by a resume whose tools differ from the ones the
     history was last saved under. A reply keeps its `native` on loading only when the tools it
     was saved under (the last `start` or `tools` line before it) equal this launch's, so a
     session resumed under other tools and then under the first ones again never sends thinking
     made under the wrong tool list (Task 6 spec review, 2026-11-06).
   - `name`: a name given.
   - `shortened`: the new system prompt and the new history's one message, in the same line.
   - `subagent`: a subagent's id, its description and its file's name, written before the
     subagent's first message. The description is what the "had not finished" line names
     (decided 2026-11-06 in Task 3: nothing else in the file holds it).
   - `ended`, in a subagent's own file only: `failed` or `stopped`, written when it ends so
     (user, 2026-11-06, option chosen: "Record how it ended"). A subagent is unfinished only when
     its file has neither this line nor a final answer, so one the lead already heard failed or
     was stopped is not reported as lost. A resume that reports one as lost writes `lost` into its
     file, so later resumes do not report it again (user, 2026-11-06, option chosen: "Report
     once").

   Reading takes the last whole `shortened` line as the start of the history, as Claude Code
   does. A shortening is one line, so it is one append: a crash or a failed write during it leaves
   a torn line, which is skipped as a bad line, and the history before it is read whole. No
   shortening is ever half saved.

   **Subagent ids continue from the transcript.** Today they restart at `t1` in each process
   (tasks.ts:97), so a resumed session's next subagent would add to the old `t1.jsonl`.
   `Tasks` gains `from(n)`, which raises its next number to at least `n` and never lowers it;
   ids come from that number, not `all.length`. On a load, `n` is one more than the highest id
   in the transcript's `subagent` lines or in its `subagents` folder's file names, so a line lost
   to a crash cannot hand out a used name.
5. **Pictures** are written once, as `<id>/pictures/<n>.<png|jpg|gif|webp>`, when the message
   holding them is saved. The line holds `{type:"image", id, mediaType, file}` in place of `data`.
   - On load, each picture is read back into a Buffer.
   - A picture file that cannot be read becomes the text `[Image #n: not found]`.
   - **The window's next picture number** is one more than the highest number in the whole
     transcript (every `message` and `shortened` line, before and after shortenings) or in the
     `pictures` folder's file names. A shortening leaves earlier pictures out of the loaded
     history, but their files stay, so the loaded history alone could hand out a used number. A
     file saved just before a crash, whose line never was, counts too.
   - `Pictures.from(n)` raises the window's next number to at least `n` and never lowers it, so
     no number is used twice in a window. A picture numbered before `/resume` or `/branch` loaded
     another conversation could still match a number that conversation saved, so it gets the next
     free number when it is sent, and the sent line shows that number (Task 7, user, 2026-11-06,
     option chosen: "Renumber on send").
   - **A picture already saved is not written again.** The transcript keeps the numbers it has
     saved or read; a `shortened` line holding the prompt in progress refers to that prompt's
     picture files as they are.
6. **Bad lines** are skipped and counted. After reading:
   - a call with no result gets the approved "Outcome unknown…" result;
   - a result whose call is missing is dropped;
   - a reply that is the last line, with calls and no results, is the crash case, handled the
     same way;
   - **the judge's records** are rebuilt from every `message` line in the file, before and after
     its shortenings: `prompts` from the user messages' own text (parts without `from`, pictures
     as markers), and
     `calls` from every reply's calls in order, as session.ts:88-89 and :133 keep them. A
     `shortened` line's message is never read as a prompt, so the summary never stands in for
     what the user typed.

**The store**
7. **The folder** is `<data>/sessions/<sha256 of the project's real path>/`, the hash
   `projectFile` uses, holding `<id>.jsonl` and `<id>/`. It is made private with `privateDir`.
8. **The open-session lock** is `<id>.lock`, taken by a new `tryLock(file)` in lock.ts. It uses
   the same link-made lock file as `withLock`, so a lock left by a crashed window is stale, as
   lock.ts:81-86 says. It returns a release function, or `null` when another window holds it,
   without waiting. The window releases it on `/clear`, `/resume`, `/branch` and exit.
9. **The list** reads each file's `start`, `name`, `lead` and first user prompt lines, its size
   and its last change time.
   - Newest first.
   - `-p` sessions are left out unless the list is for `-p --continue`.
   - A session with no messages is left out.
10. **The sweep** runs once per launch, after the settings load and before the lead is made. It
    covers every project's sessions in the data folder.
    - It deletes a session whose file has not changed for `cleanupPeriodDays` days and whose lock
      it can take, then releases the lock and removes the lock file.
    - A folder is removed link-safely: `readdir` with file types, links unlinked, never entered.
    - Failures are named in one grey line each, and the launch goes on.

**Launch**
11. **`-r` without a value.** `parseArgs` cannot take an optional value, so before parsing, a
    `-r` or `--resume` that is last, or followed by an argument starting with `-`, gets an empty
    value. An empty value means "show the list".
12. **The list at launch** is a full-screen Ink screen, `SessionList`, drawn as `drawReview` draws
    the review (cli.tsx:150-166), before the App. Without a terminal, `tachi -r` with no id fails
    with a line. `-p -r` needs an id or a name.
13. **The saved lead is "no longer set up"** when making its provider throws (`createProvider`),
    for example with its key gone. The launch's own lead is then used.

**In the window**
14. **The in-window list** (`/resume`) is the same `SessionList` component, opened as a picker
    phase (`ui.sessions`, beside `ui.picker`), with the `Select` keys.
15. **Switching** clears the per-turn state:
    - the shown calls and the to-do list;
    - `answered` and the tool line;
    - the gauge's context, which is 0 until the next request;
    - **the subagents' inbox,** emptied with `tasks.take()` (tasks.ts:134-136) and dropped. A
      waiting answer that wakes the lead is delivered to the old conversation before any queued
      command runs (queue.ts:59), so what is left is only a "stopped by the user" note
      (tasks.ts:155), which does not wake the lead and belongs to the old conversation. Kept, it
      would join the new conversation's next prompt.

    It then says one line. Earlier lines stay on screen, as `Rows` and `<Static>` cannot remove
    them.

**The size check**
16. **Characters** are counted as the length of `JSON.stringify` of what Tachikoma's own format
    sends: the system prompt, every part's text, every call's input, every result's output, and
    the tool specs. Pictures count 0 characters.
17. **The ratio** is the lead request's reported prompt (`input + cacheRead + cacheWrite`) divided
    by that request's characters. It is kept per provider id for this session, and only from a
    request that succeeded. A reply served by Anthropic's fallback model teaches the model that
    answered (`turn.servedBy`), not the lead, so no ratio is borrowed from another model; under a
    fallback that serves every request, the lead is counted exactly each time (Task 10, user,
    2026-11-06, option chosen: "The model that answered").
18. **Pictures added since the last request add nothing to the estimate.** Anthropic's exact
    count, when it runs, includes them; elsewhere the "too long" safety net covers them. No
    per-picture number is set, as none has a source for every provider.
19. **Anthropic's exact count** sends the same request to `beta.messages.countTokens`, without
    `max_tokens`, streaming, `betas` and `fallbacks`: Task 1's third live test found the count
    refuses `fallbacks` ("Extra inputs are not permitted") and takes a tool and a picture. The
    count is Anthropic's estimate; Task 1 measured it 49 tokens short of the real request at 1M.

**Recognising "too long"**
20. **Each provider gets `tooLong(err): boolean`:**
    - **Anthropic:** an `APIError` with status 400, type `invalid_request_error`, and a message
      starting `prompt is too long` (Task 1: "prompt is too long: 1000050 tokens > 1000000
      maximum").
    - **OpenRouter** (`OpenAIProvider` with kind `openrouter`): an `APIError` with status 400
      whose message starts `This endpoint's maximum context length is` (Task 1).
    - **ChatGPT:** `code === "context_length_exceeded"`, from Codex's source (user, 2026-11-06:
      "codex for chatgpt"). ChatGPT's `planError` keeps the code in a new `ProviderError.code`.
    - **The OpenAI API, Kimi and Ollama** (`OpenAIProvider`'s other kinds): none. No page names
      their "too long" answer and no live test has seen one, so it is not guessed. Their too-long
      error ends the turn as it does today, and the README lists it as a known limit; the size
      check still shortens before a request when its estimate says it will not fit.

    The session asks `tooLong` before the pictures question, so a too-long 400 never asks it.
21. **A reply cut off at Anthropic's window** gets a new `cutOff.kind`, `"window"`. It is never
    stored, as a refusal is not; the history is shortened and the request sent once more.

**Shortening**
22. **"The files read or edited in this session"** are the `path` inputs of `read_file`,
    `write_file` and `edit_file` calls in `session.calls`, most recent call first. Claude Code
    orders them by the file's modified time, but neither the Workspace nor the box helper can read
    a file's time today, so the last call on each file is used.
    - A path outside the project is skipped.
    - A file is read through `ctx.workspace.readText`. Its tokens are the lead's ratio times its
      characters.
    - With no ratio yet, or over 5,000 tokens, the file is named without its content.
    - A file that cannot be read is named "could not be read".
23. **Summaries in pieces, only when needed** (user, 2026-11-06, option chosen: "Split only when
    needed"). The whole part is sent first. If the lead answers "too long" (`tooLong`), or its
    summary is cut off at the window or its output limit, the part is split in two at the whole
    exchange nearest its middle by characters, and each half is summarised the same way, splitting
    again when needed. The summaries are then summarised together with the same instructions. No
    size number is needed: it follows the model's own answer. A part of one exchange that is still
    too long ends the shortening with its problem.
24. **The "before shortening" step** is an `onShorten` list of functions on the session, run
    before the summary request. In 8a it is empty. 8b's hooks and 8d's memory save join it.

**Commands**
25. **`/compact`, `/clear`, `/resume`, `/branch`, `/rename`, `/export` and `/autocompact`** join
    the `/` menu, `NAMES` and `COMMANDS`. They also join `KEY_COMMANDS` (bindings.ts:76), so a key
    can be bound to each, as with `/model`.
26. **`/autocompact` takes digits with an optional `k` or `m`.** `"autoCompactWindow"` is a whole
    number of tokens from 1, and is LIVE: an edit applies now.
27. **`/export` writes:**
    - a heading line per message, "You:" or "Tachikoma (<lead>):". The lead is the one that wrote
      that reply: each reply is saved with its lead's id (a `lead` field on the assistant
      `Message`), and a reply saved without one is headed with the lead leading now (Task 8,
      user, 2026-11-06, option chosen: "Record each reply's lead");
    - the notes the session adds for the lead (`from: "tasks"`: a background subagent's answer,
      failure or stop, and a crash's "answer was lost" line) where they arrived, under the heading
      line "Subagents:", as the lead got them (user, 2026-11-06, option chosen: "Include, headed
      Subagents:");
    - the text;
    - each call as `● name {json}` with its result indented under it, as Ctrl+O shows them;
    - pictures as their markers.

    A relative path is from the project folder. The file is made with flag `wx`, so an existing
    file is never overwritten. It is UTF-8 with LF line endings throughout, a message's own CRLF
    included.

## Lines this plan adds

The user approves these words with the plan. Each is checked word for word in a test. Grey lines
are notes; red ones are failures.

| Where | Line |
|---|---|
| Saving fails (red) | `Saving this session stopped: <file> could not be written (<reason>). It cannot be resumed, and a conversation too long for the model will end with an error.` |
| A subagent's saving fails (red; user, 2026-11-06) | `Saving subagent <id> stopped: <file> could not be written (<reason>). A resumed session will report its answer as lost, and its conversation will end with an error if it grows too long for the model.` |
| The sweep cannot delete (grey) | `An old session could not be deleted: <file> (<reason>).` |
| `tachi -c`, nothing saved | `No saved session to continue in this folder.` |
| `tachi -r`, nothing saved | `No saved sessions in this folder.` |
| `tachi -r <x>`, not found | `No session named or numbered <x> in this folder; tachi --resume lists them.` |
| `tachi -r` without a terminal | `tachi --resume needs a terminal to list sessions; give it a session's id or name.` |
| A transcript that cannot be read | `<file> could not be read as a session (<reason>).` With no readable first line, the reason is `its first line is missing or damaged` (user, 2026-11-06). |
| A copy that cannot be written (user, 2026-11-06) | `<file> could not be copied (<reason>).` When the copy's own lock is held, the reason is `its lock could not be taken` (user, 2026-11-06). |
| Damaged lines skipped (grey) | `<n> damaged lines of this session were skipped.` |
| The saved lead is gone (grey) | `The session's lead, <spec>, is not set up (<reason>); <spec> leads instead.` |
| Open elsewhere (grey; approved in the design) | `Opened a copy: that session is open in another window.` |
| Tools changed (grey) | `The tools have changed since this session was saved, so its earlier replies are sent without their thinking.` |
| A subagent unfinished at the crash (to the model) | `Subagent <id> (<description>) had not finished when the session ended; its answer was lost.` |
| A crash's unanswered call (to the model; approved) | `Outcome unknown: the session ended while this was running, or before its result was saved. It may have run in full or in part. Check what it would have changed before running it again.` |
| Resumed (grey) | `Resumed: <name or first prompt>.` With neither, `Resumed: <id>.` (user, 2026-11-06). |
| `tachi -r`'s list (user, 2026-11-06) | Headings `Saved sessions in this folder, newest first:` and `Saved sessions named <name>, newest first:`; hint `↑↓ move · Enter opens · Esc quits`; ages `<1m ago`, `<n>m ago`, `<n>h ago`, `<n>d ago`; sizes `<n> bytes`, `<n.n>k bytes`, `<n.n>M bytes`. |
| HELP (user, 2026-11-06) | `-c, --continue    reopen the newest session saved in this folder (with -p, the newest -p run)`; `-r, --resume [<id or name>]  reopen a saved session by its id or name, or pick one from a list`; `-n, --name <name>  name this session, to reopen it with --resume <name>`; `--fork-session    with -c or -r, open a copy of the session and leave the saved one as it was` |
| `/clear` (grey) | `Started a new session; the last one is kept (tachi --resume lists it).` |
| `/branch` (grey) | `Branched: this window is now <name>; the original is kept as <id>.` |
| `/resume`, `/clear` or `/branch` while a subagent runs (red) | `<command> waits until no subagent is running: <ids> still running. /tasks stop stops them.` |
| `/rename` alone (red) | `Usage: /rename <name>` |
| `/rename <name>` (grey) | `Session named <name>.` |
| Menu notes (user, 2026-11-06) | `/clear` "Start a new session in this window; the last one stays saved"; `/resume` "Pick a saved session and switch this window to it"; `/branch [name]` "Carry on in a copy of this session, named after its first prompt unless named"; `/rename <name>` "Name this session, as /resume and tachi --resume list it" |
| `/resume`, nothing else saved (grey; user, 2026-11-06) | `No other saved sessions in this folder.` |
| `/branch` before any prompt (grey; user, 2026-11-06) | `Nothing to branch yet: this session has no prompt.` |
| `/branch` or `/rename` after saving stopped (red; user, 2026-11-06) | `<command> needs this session saved, and saving it stopped.` |
| The in-window list's hint (user, 2026-11-06) | `↑↓ move · Enter opens · Esc closes` |
| `/export <file>` (grey) | `Exported to <file>.` |
| `/export` alone (grey) | `Copied the conversation (<n> characters).` |
| `/export` onto a file (red) | `<file> already exists; nothing was written.` |
| `/export` that cannot write (red; user, 2026-11-06) | `<file> could not be written (<reason>).` |
| `/export`'s menu note (user, 2026-11-06) | "Write the conversation to a file as text; alone, copy it" |
| `/export`'s heading for the session's notes (user, 2026-11-06) | `Subagents:` |
| `/autocompact <n>` (grey) | `Shortens once the conversation passes <n> tokens.` |
| `/autocompact off` (grey) | `Shortens only when a request would not fit.` |
| `/autocompact` wrong (red) | `Usage: /autocompact <tokens>, such as 200k, or /autocompact off` |
| `/compact` with nothing to shorten (grey) | `Nothing to shorten yet.` |
| Shortened (grey; approved in the design) | `Conversation shortened (Ctrl+O shows the summary)` |
| Shortening fails (red) | `The conversation could not be shortened (<reason>); it is unchanged.` |
| Too long after shortening (red) | `The request is too long for <model>: about <n> tokens, against a window of <w>.` |
| `/lead` refused (red) | `<spec> was not made the lead: the conversation does not fit its window and could not be shortened (<reason>).` |
| Settings: a bad number | `settings.json: "cleanupPeriodDays" must be a whole number from 1 (got "…")`, and the same for `"autoCompactWindow"` |

**The new history's message** (to the model; for approval):

```
This conversation was shortened. A summary of everything before this point:

<summary>

The request being worked on, word for word:
<prompt>

The latest round of tool calls, and their results:
● <name> <input as JSON>
  ⎿ <result>

The files read or edited in this session, as they are now:
--- <path> ---
<content>
--- <path> (over 5,000 tokens; read it again if needed) ---
--- <path> (size not known yet; read it again if needed) ---
--- <path> (could not be read) ---
```

Each part appears only when it has something in it. The last two file lines are for a file whose
size cannot be estimated, as the lead has no ratio yet, and a file that cannot be read (Task 11,
user, 2026-11-06, option chosen: "Two short notes"). Each result has the `⎿` mark, as Ctrl+O and
`/export` show it, from the same `callText` (Task 11, user, 2026-11-06, option chosen: "Keep the ⎿
mark").

**Why shortening failed** (the `<reason>` in the lines above; Task 11, user, 2026-11-06, option
chosen: "Approve all"): `cancelled by the user`, `the summary came back empty`, `one exchange is
too long to summarise`, `the summaries of its pieces are too long to combine`, `there is nothing
to summarise`, `the request being worked on does not fit the window on its own`, `even shortened,
it does not fit the window`. A provider's error and a refusal's own words are shown unchanged.
When saving has already stopped, the `/lead` refused line's reason is `saving this session
stopped` (Task 12, user, 2026-11-06, option chosen: "Approve").

---

## Task 1: The live tests (the user, at their terminal)

**Files:** create `scripts/live-8a.mjs`. It is written by the controller, not a builder, and is
committed.

The script is run by the user with their own keys. It loads keys from the environment only:
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and the saved ChatGPT sign-in through
`src/auth/` as `tachi` does. It prints each result as plain lines. The key is never printed.

1. **"Too long" errors.** For each provider set up, it sends one request just over the model's
   window, made of one repeated word, and prints the status, the error's type and code, and the
   first 200 characters of its message. 200 is a display cut, not a setting.
2. **Resuming Anthropic.** It builds a two-turn conversation with a tool call on the user's lead
   model. It then sends a third turn three ways and prints whether each was accepted:
   - same system prompt;
   - changed system prompt with the thinking blocks kept;
   - changed system prompt with `native` left out.
3. **Anthropic's count.** It counts a request holding tools, a picture and the fallback setting
   through `beta.messages.countTokens`, and prints the count or the error.

**Cost:** test 1 sends one window-sized request per provider (about 1M input tokens on a 1M-window
Anthropic model). **The controller tells the user the price before they run it**, from the
provider's pricing page, and the user may run tests 2 and 3 alone (`--only 2,3`).

**Results:** the controller records them under this task and fills in choices 19-21. Tasks 9 and
12 wait for them; Tasks 2-8 do not.

**Results** (run by the user 2026-11-06, `node scripts/live-8a.mjs anthropic:claude-opus-5-5`):

```
1 anthropic:claude-opus-5-5: window 1000000 tokens; sending 1000001 tokens (Anthropic's count).
1 anthropic:claude-opus-5-5: refused: status 400, type invalid_request_error, code none (BadRequestError): prompt is too long: 1000050 tokens > 1000000 maximum
2: two turns done, with 1 thinking block(s) in the replies.
2 same system prompt: accepted: usage {"input":4,"output":67,"cacheRead":518,"cacheWrite":108}
2 changed system prompt, thinking blocks kept: accepted: usage {"input":4,"output":67,"cacheRead":0,"cacheWrite":639}
2 changed system prompt, Tachikoma's own record (no thinking blocks): accepted: usage {"input":4,"output":67,"cacheRead":0,"cacheWrite":613}
3 with the fallback setting: refused: status 400, type invalid_request_error, code none (BadRequestError): fallbacks: Extra inputs are not permitted
3 without it: 428 tokens
```

What they settle:
- **Anthropic's "too long"** is a 400 `invalid_request_error` whose message starts `prompt is too
  long`, as the context-windows page says (choice 20).
- **Anthropic's count runs short of the real request.** The count said 1,000,001 tokens; the
  request, which also carried the fallback setting, was 1,000,050. Anthropic's token-counting page
  calls the count "an estimate" that "might differ by a small amount". So a request counted just
  under the window can still be refused. No margin is added, as no number for one has a source:
  the "too long" answer shortens and sends again (choice 21's rule, design "When to shorten").
- **The count refuses the fallback setting** (`fallbacks: Extra inputs are not permitted`), and
  takes a tool and a picture. So the count leaves out `betas` and `fallbacks` (choice 19).
- **A changed system prompt with the thinking blocks kept was accepted** on this account. The
  errors page's "Thinking block bound to a different conversation" did not happen here; the
  claude-api skill says the check is enforced for accounts created on or after 2026-08-31, which
  this one is not. Other people's accounts can be, so the design's choice stands: a resumed session
  reuses its saved system prompt. Tachikoma's own record, with no thinking blocks, was accepted
  too, so the fallback for a changed tool list works.
- **OpenRouter** (run by the user 2026-11-06, `node scripts/live-8a.mjs --only 1
  openrouter:openai/gpt-5.5`, the window and price from OpenRouter's model list):

  ```
  1 openrouter:openai/gpt-5.5: window 1050000 tokens; prompt price 0.000005 USD a token; sending 1050001 words.
  1 openrouter:openai/gpt-5.5: refused: status 400, type none, code 400 (BadRequestError): This endpoint's maximum context length is 1050000 tokens. However, you requested about 1050018 tokens (1050018 of text input). Please reduce the length of either one, or use the context-compression pl
  ```

  OpenRouter answers a 400 whose `code` is the status itself, so its message is what tells "too
  long" apart (choice 20).
- **Not run, by the user's choice (2026-11-06, "codex for chatgpt and lets test the api"):** the
  ChatGPT plan, which goes by Codex's source; and the OpenAI API itself, as the user's key is
  OpenRouter's (choice 20).

## Task 2: Tests never save sessions into the user's data folder

**Files:**
- Modify: `tests/cli.test.ts` (`launch()` at :46-69).
- Modify: `tests/tui/app.test.tsx` (`mount` at :105-231).
- Modify: `tests/helpers.ts`, if a shared helper fits.

**What changes:**
- **`launch()`** sets `TACHI_DATA_DIR` to `<top>/data/tachikoma`, two levels inside its own
  `mkdtemp` folder, unless the call passes one.
- **`mount`** gains a `sessions` option: a data folder two levels inside a fresh `mkdtemp` folder,
  made for every mount. It is used from Task 5 on.

**Tests:**
- A `-p` launch that fails with a provider error writes its error-log row under the test's data
  folder, and nothing under `%LOCALAPPDATA%\tachikoma`.
- The test checks the env passed to the child; it never lists the user's folder.

Commit: `test: the CLI's and the App's tests keep their data folder inside the test's own folder`.

## Task 3: The transcript file

**Files:** create `src/core/transcript.ts` and `tests/core/transcript.test.ts`.

```ts
export type Line =
  | { t: "start"; at: string; v: 1; id: string; project: string; lead: string; version: string; print: boolean; system: string; tools: ToolSpec[] }
  | { t: "message"; at: string; message: SavedMessage }
  | { t: "lead"; at: string; lead: string }
  | { t: "tools"; at: string; tools: ToolSpec[] }
  | { t: "name"; at: string; name: string }
  | { t: "shortened"; at: string; system: string; message: SavedMessage }   // one line: choice 4
  | { t: "subagent"; at: string; id: string; description: string; file: string }
  | { t: "ended"; at: string; state: "failed" | "stopped" | "lost" };         // in a subagent's file
export class Transcript {
  constructor(file: string, pictures: string);      // <id>.jsonl, <id>/pictures
  write(line: DistributiveOmit<Line, "at">): void;  // appendFileSync, one line; pictures saved first (choice 5)
  readonly failed: string | null;                   // the reason saving stopped, or null
  mend(): void;                                     // a file not ending in "\n" gets one (design, "When something goes wrong")
}
export interface Read { start: Extract<Line, { t: "start" }>; messages: Message[]; system: string; lead: string; name?: string;
  firstPrompt?: string; damaged: number; unfinished: { id: string; description: string }[];
  prompts: string[]; calls: { name: string; input: unknown }[];   // from the whole file (choice 6)
  nextPicture: number; nextTask: number }                         // choices 5 and 4
export function readTranscript(file: string, pictures: string): Read | { problem: string };
export function wholeLines(file: string): string;   // the text up to the last "\n", for copies (design)
// Omit on a union keeps only the shared fields, so each variant is omitted on its own, as boxWorkspace.ts:106 does.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
```

**Behaviour:**
- **`write`:**
  - It makes the folder private once (`privateDir`) and appends with mode `0o600`, as the error
    log does.
  - On the first failure it sets `failed` and writes nothing more (choice 4; design, "Saving
    sessions").
- **Pictures** are written to their own file before their message's line, as `wx` (once). The
  message's image parts are saved as `{type:"image", id, mediaType, file}` (choice 5).
- **`readTranscript`:**
  - Its history starts at the last whole `shortened` line's message (choice 4).
  - Its `prompts` and `calls` come from every `message` line in the file (choice 6).
  - `nextPicture` and `nextTask` are the high-water marks of choices 5 and 4.
  - It skips bad lines and counts them.
  - It reads pictures back, with "not found" in place of a missing one.
  - It pairs calls and results (choice 6), with the approved "Outcome unknown" text.
  - It lists subagents whose files show no final answer (choice 4's `subagent` line, and Task 5).
- **Pictures already saved** (read back, or written earlier by this transcript) are not written
  again (choice 5).
- **`mend`** only adds `\n`. It never truncates.

**Tests:**
- Writing then reading every line kind round-trips the messages, `native` included.
- A picture's bytes come back equal.
- A missing picture file gives the "not found" text.
- A torn last line, then `mend`, then a write, then a read: the new message is there, and one
  line is counted damaged.
- A damaged middle line leaves a call without its result; it gets the "Outcome unknown" result,
  and a result without its call is dropped.
- Reading starts at the last `shortened` line's message.
- **An interrupted shortening,** at each write boundary: a `shortened` line torn halfway (a file
  cut short by the test) reads back the history before it, whole, with one line damaged; a
  failed `shortened` write leaves the file reading back the same.
- `prompts` and `calls` include those before a shortening, and the summary is not among the
  prompts.
- `nextPicture` after a shortening that left picture 3 out of the history is 4; a picture file 5
  with no line makes it 6.
- `nextTask` follows the highest `subagent` line, and a `subagents` file with no line.
- A `shortened` line holding a kept prompt's picture writes no picture file again, and reads it
  back.
- A file standing where the sessions folder should be makes the write fail and sets `failed`; no
  permissions are changed.
- `wholeLines` leaves out a torn last line.

Commit: `feat: a session's transcript: lines written as they happen, read back, and mended after a crash`.

## Task 4: The session store and the sweep

**Files:**
- Create: `src/core/sessions.ts` and `tests/core/sessions.test.ts`.
- Modify: `src/auth/lock.ts` (add `tryLock`), `tests/auth/lock.test.ts`.
- Modify: `src/settings.ts` (`cleanupPeriodDays`), `tests/settings.test.ts`.

```ts
export function sessionsDir(root: string, data?: string): string;      // choice 7
export interface Row { id: string; name?: string; firstPrompt: string; lead: string; changed: Date; size: number; print: boolean }
export function listSessions(dir: string, opts: { print: boolean }): Row[];   // choice 9
export function findSession(dir: string, idOrName: string): Row | Row[] | null;   // an exact id, else every row with that name
export function openSession(dir: string, id: string): { release: () => void } | null;   // tryLock (choice 8)
export function copySession(dir: string, id: string): string;           // a new id; whole lines, pictures, subagents (design, "Names, branches")
export function sweep(data: string, days: number, now: Date): string[];   // the lines for files it could not delete (choice 10)
// lock.ts
export function tryLock(file: string): (() => void) | null;
```

**Behaviour:** as choices 7-10.
- `copySession` copies `wholeLines` of the transcript and the whole `<id>/` folder: the pictures,
  and each subagent's file as its `wholeLines`. It gives the copy's `start` line the new id. A
  copy without its subagents' files would read every finished subagent as unfinished, and tell the
  model its answer was lost. The folder is copied link-safely: `readdir` with file types, links
  left out, never followed.
- `cleanupPeriodDays` is a whole number from 1, read as `taskCount` reads `maxTasks`. Its message
  is the one in "Lines this plan adds". It is not LIVE: it is read once at launch.

**Tests:**
- The list:
  - It is newest first.
  - It leaves out `-p` sessions unless asked for.
  - It leaves out a session without messages.
  - It shows a name over the first prompt.
- `findSession`:
  - An exact id finds its session.
  - A name two sessions share gives both.
  - Neither gives `null`.
- **`tryLock`:**
  - It succeeds once.
  - A second call in another process (a child `node -e` holding it) gets `null`.
  - A lock file holding a dead pid is taken.
- `copySession` makes an independent copy whose pictures read back, and whose finished subagent
  reads as finished: no "answer was lost" line.
- **The sweep:**
  - It deletes a session older than the days, using a set time: `utimesSync` on a test file is a
    time change, not a permission change.
  - It keeps a newer one, and one whose lock is held.
  - It removes a link inside a session's folder without following it: a junction pointing at a
    second test folder, whose file survives.
  - It returns a line for a file it cannot delete. The case is made with a folder in the file's
    place, never with permissions.
- Settings: `cleanupPeriodDays` 30 is read. `0` is refused with the line; `"30"` is refused with
  release 6's existing `must be a number, without quotes` line, as `maxTasks` is (decided
  2026-11-06 in Task 4: `"30"` is a whole number from 1, just quoted).

Commit: `feat: the sessions folder: the list, finding by id or name, the open lock, copies, and the 30-day sweep`.

## Task 5: A session that saves and loads

**Files:**
- Modify: `src/core/session.ts`, `src/core/tasks.ts`, `src/tui/pictures.ts`.
- Modify: `tests/core/session.test.ts`, `tests/core/tasks.test.ts`, `tests/tui/pictures.test.ts`.

```ts
export interface Conversation { id: string; messages: Message[]; system: string; transcript?: Transcript;
  prompts: string[]; calls: { name: string; input: unknown }[]; nextPicture: number; nextTask: number }
// SessionOptions gains: transcript?: Transcript; systemNow?: () => string (choice 3)
class Session {
  id: string;
  system: string;                           // the conversation's (choice 3)
  load(c: Conversation): void;              // choice 1: empties and refills messages, prompts and calls in place (choice 2)
  readonly onShorten: (() => void)[];       // choice 24
}
```

**Behaviour:**
- `#push` writes the `message` line before it emits `message` (choice 4).
- `setLead` writes a `lead` line.
- **`load`** (choice 1):
  - It fills `prompts` and `calls` from the conversation's, which the reader took from the whole
    file (choice 6). A new conversation's are empty.
  - It empties `#shrunk` (`clear()`, as the field is `readonly`).
  - It calls `Pictures.from(nextPicture)` and `Tasks.from(nextTask)`.
- **A subagent's session** writes `<id>/subagents/<tN>.jsonl`, and the lead's transcript gets a
  `subagent` line naming it, with its description (tasks.ts:184-192; design, "Saving sessions").
  A subagent that ends failed or stopped writes an `ended` line to its own file (choice 4).
- **Pictures:** `Pictures` gains `from(n)`, which only raises the next number (choice 5).
- **Subagent ids:** `Tasks` gains `from(n)`, which only raises the next number; `start` takes
  ids from it, not from `all.length` (choice 4).
- `#request` uses `this.system`.
- **Saving fails, once per transcript** (added 2026-11-06 in Task 5's review: no task showed the
  line). When the transcript's `failed` first becomes set, the session emits an `error` event of
  a new kind, `saving`, holding the approved "Saving fails" line, so the error log keeps it. The
  window draws it as `✗ ` and the line, with no `saving:` label (user, 2026-11-06, option
  chosen: "✗ then the line"); `-p` prints the line alone. It fails no `-p` run and no subagent,
  as "nothing else stops" (design, "When something goes wrong"). When only a subagent's own file
  fails, the lead keeps saving and the line is "A subagent's saving fails" instead (user,
  2026-11-06, option chosen: "Its own line"), drawn and kept the same way.
- **`load` keeps the "no pictures to this provider" answer** for the window (user, 2026-11-06,
  option chosen: "Keep for the window").

**Tests:**
- Saving:
  - A turn with a tool call writes its user, reply and result lines in order, before each
    message event. The event handler reads the file and finds its line.
  - A refusal writes nothing.
- **`load`:**
  - It swaps the history in place: `tasks.ts`'s alias sees the new messages.
  - It sets `prompts` and `calls` from the conversation, as the judge needs them.
  - The next turn sends the loaded system prompt.
  - **Two conversations, one picture number:** conversation A sends picture 1; loading B, whose
    picture 1 has other bytes, makes the next request send B's bytes, not A's.
- **Resuming after a shortening in auto mode:** a session shortened, then read back and loaded,
  gives the judge the original prompts and calls; the summary is not among the prompts.
- **Subagents across a restart:** delegate once (`t1`), read the transcript back into a new
  `Tasks` and `Session` as a new process would, delegate again: the new one is `t2` with its
  own file, and `t1.jsonl` is unchanged.
- `Pictures.from` and `Tasks.from` never lower the next number.
- A subagent's turn writes its own file and a `subagent` line.
- A subagent that fails, and one that is stopped, each end their file with an `ended` line; read
  back, neither is listed as unfinished.
- A failed write leaves the turn running and `failed` set, and emits the "Saving fails" line
  once, word for word, of kind `saving`; a second failed write emits nothing more. The window
  shows `✗ ` and the line; a `-p` run with it still exits 0; a subagent whose own file fails is
  not reported failed.

Commit: `feat: the session saves each message as it is added, and can load a saved conversation`.

## Task 6: Launching with `-c`, `-r`, `-n` and `--fork-session`

**Files:**
- Modify: `src/cli.tsx`, `src/clilib.ts`.
- Create: `src/tui/SessionList.tsx`, `tests/tui/sessionlist.test.tsx`.
- Modify: `tests/cli.test.ts`, `tests/clilib.test.ts`.

**Behaviour:**
- **New options** in `parseArgs` and HELP:
  - `-c, --continue`;
  - `-r, --resume [<id or name>]` (choice 11);
  - `-n, --name <name>`;
  - `--fork-session`.
- **The sweep** runs after `loadSettings` (choice 10). Its lines go to stderr before the screen
  starts.
- **A new session:**
  - It uses the existing `randomUUID()` id (cli.tsx:306).
  - It writes its `start` line (choice 4) and takes its lock.
  - `-n` writes a `name` line.
  - With `-p` the `start` line has `print: true`.
- **`-c`** opens the newest session. With `-p`, it opens the newest `-p` session.
- **`-r <id or name>`:**
  - One match opens it.
  - Several matches open the list filtered to that name.
  - None fails with the line.
- **`-r` alone** opens `SessionList` before the App (choice 12).
- **Opening:**
  - `openSession` is tried. If another window holds the session, or `--fork-session` is given, it
    is copied and the copy opened. The "Opened a copy" line is said only when another window holds
    it, as it would be false for `--fork-session` (choice 8).
  - **It happens before anything starts:** the session is opened, mended and read before the
    instruction-files question and the sandbox, so a session that cannot be read starts nothing
    (design, "When something goes wrong"). A copy that then cannot be read is removed.
  - The opened session's `mend()` runs under its lock before anything is appended.
  - Damaged lines, unfinished subagents, the lead (choice 13), the saved system prompt and the
    tools comparison are as the design's "Resuming" says, each with its line.
  - When the tools differ, the loaded replies' `native` is left out, and a `tools` line is written.
    The "Tools changed" line is said only when some loaded reply had `native` to leave out.
  - A lead that differs from the saved one writes a `lead` line.
  - Each unfinished subagent reported lost gets `ended` `lost` in its own file.
  - **The conversation is drawn on screen** above the resume lines, as the App draws a live one
    (user, 2026-11-06, option chosen: "Show it").
  - The copy-mode box starts afresh, as the design says.
- **The lead's own error log** keeps using its own session id: a resumed session's error rows
  carry the resumed id.

**Tests** (`tests/cli.test.ts` spawns with its own data folder, from Task 2; `-p` runs with the
local fake OpenAI server already in that file, :468-506):
- `-p "hi"` saves a session, and `-p -c "again"` sends both prompts' history.
- `-c` with nothing saved fails with the line.
- `-r <id>` and `-r <name>` open the right one.
- `-r nope` fails with the line.
- A session whose lock a child process holds opens as a copy, with the line.
- `--fork-session` leaves the original's file unchanged.
- A saved lead whose key is gone falls back, with the line.
- A transcript with a torn last line resumes, and the next message is readable afterwards.
- Unfinished subagent and crash-call results reach the model's request (the fake server records
  it).
- `SessionList`: rows show name or first prompt, time, lead and size; Up/Down/Enter/Esc work;
  filtering by a name works.
- `-r` without a terminal fails with the line.
- A resume under other tools, then under the first ones again, sends no thinking made under the
  other tools.
- A resume with `--lead` makes the next `-c` open with that lead.
- A lost subagent is reported on the first resume and not on the second.
- `-r <a session with no readable first line>` with `--sandbox copy` starts no box.
- The window draws a resumed conversation's prompts, replies and tool rows.
- A `-p` run whose transcript cannot be written (a file where the sessions folder should be,
  inside the test's own data folder) prints the "Saving fails" line alone on stderr and exits 0
  (moved here from Task 5: no launch path wrote a transcript before this task).

Commit: `feat: tachi -c, -r, -n and --fork-session reopen, name and copy saved sessions`.

## Task 7: `/clear`, `/resume`, `/branch` and `/rename` in the window

**Files:**
- Modify: `src/tui/app/queue.ts`, `src/tui/menus.ts`, `src/tui/app/constants.ts`,
  `src/tui/bindings.ts`, `src/tui/App.tsx`, `src/tui/app/state.ts`, `src/tui/phase.ts`.
- Modify: `tests/tui/app.test.tsx` (a new describe, "App's sessions"), `tests/tui/menus.test.ts`,
  `tests/tui/phase.test.ts`.

**Behaviour:**
- The commands join the three lists and `KEY_COMMANDS` (choice 25).
- `/clear`, `/resume` and `/branch` wait in the queue while a turn runs, as `/lead` does. With
  `ui.tasks.running > 0` they are refused with the line (design, "Resuming").
- **`/clear`:**
  - It releases the lock and makes a new id, transcript and lock.
  - It loads an empty conversation with `systemNow()`, then says its line.
- **`/resume`:**
  - It opens `SessionList` as a picker phase (choice 14), leaving out this session.
  - A pick opens the session as Task 6 does, the copy rule included, then loads it and says its
    line. It switches to the session's saved lead, falling back to the window's lead with the
    "saved lead is gone" line, as `tachi -r` does without `--lead` (user, 2026-11-06, option
    chosen: "The session's saved lead").
  - The window's sandbox carries on: a copy-mode box is not started afresh in the window, so its
    review at exit covers both sessions' changes.
- **`/branch [name]`:**
  - It copies this session (`copySession`) and names the copy: the given name, or the first
    prompt.
  - It switches to the copy and says its line.
- **`/rename <name>`** writes a `name` line.
- **Switching** clears the per-turn state (choice 15).
- **The error log follows the open session:** after a switch its rows carry the new session's id
  (Task 6: a resumed session's error rows carry the resumed id).
- `/clear` says its line after the new conversation is loaded.

**Tests** (each case in "App's sessions", run with `-t`):
- Each command's line.
- `/clear` empties the next request's history.
- `/resume` picks a session saved by an earlier mount in the same data folder, and the next
  request holds its history.
- `/branch` leaves the original file unchanged while the next turn writes to the copy.
- `/rename` changes the list's row.
- Each of `/clear`, `/resume` and `/branch` is refused with a background subagent running, and
  queued while a turn runs.
- **A stopped subagent's note stays behind:** stop a background subagent, wait for it to end,
  then `/clear`; the next request holds no "stopped by the user" note.
- A background subagent that finishes while `/clear` waits in the queue: its answer goes into
  the old conversation's request first, and the new conversation's first request holds none of
  it.
- The `/` menu test lists the new labels.

Commit: `feat: /clear, /resume, /branch and /rename switch and name sessions in the window`.

## Task 8: `/export`

**Files:**
- Create: `src/core/exportText.ts`, `tests/core/exportText.test.ts`.
- Modify: `src/tui/app/queue.ts`, the three command lists, and `tests/tui/app.test.tsx`.

**Behaviour:**
- As choice 27. `/export <file>` writes with `wx`.
- `/export` copies through `ui.board.current.copy`.
- Both say their line.

**Tests:**
- The text of a turn with a call, its result and a picture marker.
- An existing file is refused with the line, and left unchanged.
- The copy goes through the stand-in clipboard.

Commit: `feat: /export writes the conversation as text to a file, or copies it`.

## Task 9: The providers: "too long", the window cut-off, and Anthropic's count

**Waits for Task 1's results.**

**Files:**
- Modify: `src/core/types.ts` (`ProviderError.code`, `Provider.tooLong`, `Provider.countTokens`,
  `cutOff.kind "window"`).
- Modify: `src/providers/anthropic.ts`, `openai.ts`, `chatgpt.ts`.
- Modify: `tests/providers/*.test.ts`.

```ts
interface Provider { tooLong?(err: unknown): boolean; countTokens?(req: CompletionRequest): Promise<number> }
```

**Behaviour:**
- `tooLong` as choice 20, with Task 1's recorded texts and codes, each cited in a comment.
  `OpenAIProvider.tooLong` answers only for kind `openrouter`.
- `model_context_window_exceeded` becomes `cutOff.kind = "window"` (choice 21).
- Anthropic's `countTokens` as choice 19.
- ChatGPT's `planError` keeps `code`.

**Tests:** each provider's recorded error, from Task 1's results, and one unlike it, against
`tooLong`. The window stop gives `"window"`. `countTokens` sends the request's system, messages
and tools, through a stand-in SDK client.

Commit: `feat: each provider says when a request was too long, and Anthropic can count one exactly`.

## Task 10: The size check

**Files:** create `src/core/fit.ts`, `tests/core/fit.test.ts`.

```ts
export function characters(system: string, messages: Message[], tools: ToolSpec[]): number;   // choice 16
export class Sizes {                                   // one per session
  learn(provider: string, chars: number, usage: Usage): void;      // choice 17
  estimate(provider: string, chars: number): number | null;        // null: no ratio yet
}
export async function fits(lead: Provider, req: CompletionRequest, sizes: Sizes, limit: number): Promise<boolean | null>;
// limit: the window, or the /autocompact size when smaller; null: no way to tell (design, "When to shorten")
```

**Behaviour:** as the design's "When to shorten" and choices 16-19.
- `fits` returns `false` only when the estimate says it will not fit. On Anthropic that needs
  `countTokens` to agree.
- After a lead switch, with no ratio, Anthropic counts exactly. Others return `null`.

**Tests:**
- `characters` counts text, inputs, outputs and specs, and pictures as 0.
- `learn`/`estimate` give the ratio from a known usage.
- `fits` on a fake provider is true under the limit and false over it.
- On a fake Anthropic-like provider, an estimate over the limit with an exact count under it is
  true.
- No ratio on a non-Anthropic provider gives `null`.

Commit: `feat: the size check estimates each request from this session's own ratio, counting exactly on Anthropic when it matters`.

## Task 11: Shortening

**Files:** create `src/core/shorten.ts`, `tests/core/shorten.test.ts`.

```ts
export type When = "between" | "start" | "during";   // design, "How shortening works", step 4
export async function shorten(s: {
  lead: Provider; system: string; messages: Message[]; tools: ToolSpec[]; calls: { name: string; input: unknown }[];
  workspace: Workspace; sizes: Sizes; window: number; focus?: string; signal?: AbortSignal;
  asked?: Message;   // "during": the message that started the turn (Task 11's quality review)
  onUsage: (u: { provider: string; usage: Usage; priceKnown?: boolean }) => void;   // each summary request's
}, when: When): Promise<{ messages: Message[]; summary: string } | { problem: string }>;
```

**Behaviour:** the design's steps 3-5 and choices 22-23.
- **The part sent for summarising always ends on a complete exchange.** When it ends with a user
  message, the instructions join that message.
- **The approved summary instructions,** with `/compact`'s words added as "Focus on: <words>".
- The new history is one user message in the approved layout.
- **What is kept:**
  - The prompt in progress is kept whole, pictures included.
  - The latest round is copied in as text.
  - If the prompt and the round do not fit, the round is summarised whole.
  - If the prompt alone does not fit, `shorten` returns the problem.
- **A part too long to summarise is cut in half** at the message nearest the middle, never between
  a call and its results, so a long task can be cut inside. A half after the first opens with
  `This is the later part of a conversation; the part before it is summarised separately.` (to the
  model), as Anthropic refuses a request that opens with a reply, and is sent without the stored
  replies' own form (`native`), as Anthropic refuses thinking moved from its place (Task 11, user,
  2026-11-06, option chosen: "Cut anywhere, add a line").
- **Summaries are requests:** `signal` stops them. Every request `shorten` makes reports what
  usage it has through `onUsage` as soon as it ends, as `#request` does (session.ts:147,
  :164-165): the declined attempts first, then the reply's, with the provider that served it.
  That covers a reply cut off and a summary then split again. A request that throws, a "too long"
  error among them, has no usage in `Provider.complete`'s contract, so it reports none: no token
  count or charge is made up for it.

**Tests** (each with a scripted fake lead that records what it was sent):
- **Between turns:**
  - A history with no tool calls is summarised whole.
  - A history whose latest round of calls is followed by plain exchanges is summarised whole, and
    nothing is left out.
- **At the start of a turn:** the new prompt is kept whole with its picture.
- **During a turn:**
  - The summary request ends before the round's reply, and holds no call without its result.
  - The round is kept as text.
  - The round is too big, so it is summarised.
  - The prompt alone is too big.
- The summary request for a history ending in a user message has the instructions in that
  message.
- Files: the most recent first, 5 at most; outside-project files skipped; over 5,000 tokens or
  no ratio named only; an unreadable one named.
- Pieces: a lead that answers "too long" for the whole part is sent two halves split at an
  exchange, then their summaries combined; a summary cut off at the window splits the same way;
  one exchange still too long returns the problem.
- A cancelled summary returns the problem and changes nothing.
- **Usage:** one summary reports one usage. A split after a "too long" error reports nothing for
  the refused whole, then one for each half and the combining request. A split after a summary cut
  off reports the cut-off one too. A cancel after the first half reports that half's.

Commit: `feat: shortening summarises everything before what must stay, and keeps the request in progress whole`.

## Task 12: Shortening in the session

**Waits for Task 1's results (through Task 9).**

**Files:** modify `src/core/session.ts`, `src/tui/app/queue.ts` (`/lead`), `src/core/bus.ts`,
`src/core/stats.ts`, and `tests/core/session.test.ts`, `tests/core/stats.test.ts`.

**Behaviour:**
- **Before every request,** `fits` is checked against the window and the `/autocompact` size.
  `false` shortens first, with `when` worked out from where the turn is.
  - A lead with no known window (`contextWindow()` gives `null`) and no `/autocompact` size has
    no advance check; the "too long" answer still shortens.
  - The characters given to `learn` are counted once, beside the request, from exactly what was
    sent, before the reply joins the history. `learn` takes the id of the model that answered
    (`turn.servedBy ?? lead.id`, choice 17).
  - `Session.load()` (a resume, `/clear`, `/branch`) starts a new `Sizes`, so a loaded
    conversation is counted exactly on Anthropic, as the design's "When to shorten" says.
- **A `"window"` cut-off or a `tooLong` error** shortens and sends once more. Both are checked
  before the pictures question. A second refusal ends the turn with the line.
- **Each shortening:**
  - It first checks the transcript has not `failed`. If it has, the turn ends with the line.
  - It runs `onShorten`.
  - It rebuilds the system prompt with `systemNow()`.
  - It writes one `shortened` line: the new system prompt and the new history's message
    (choice 4).
  - **It checks `failed` again.** `write` records a failure without throwing, so a failure in
    that append would otherwise pass as a shortening. If it failed, the history is not replaced,
    the old system prompt stays, no `shortened` event is emitted, and the turn ends as it does
    when `failed` was already set.
  - It replaces the history in place.
  - It emits a new bus event, `shortened: [string]`, with the summary.
- **`/lead` to a provider whose window is smaller** checks `fits`. If the conversation will not
  fit, it shortens with the current lead first, and refuses with the line if that fails.
- **A subagent's session and `-p`** shorten the same way.
- **The judge's `prompts` and `calls` are never shortened.**
- **Notes from Task 11's reviews:**
  - During a turn, `shorten` is given `asked`: the message that started the turn, as the session
    holds it. After a first shortening it is no longer in the history, so it cannot be found there.
  - On `/lead`, `window` is the new lead's, while `fits` estimates with the current lead's ratio.
  - After a between-turns shortening, the next prompt joins the new history's message when
    sent, so requests keep user and assistant alternating (the sources disagree on whether
    Anthropic refuses two user messages in a row; joining is harmless either way).
  - Summary requests pass the session's picture cache and its "send without pictures" setting
    through, or it becomes a known limit: after "Send again without the pictures", a summary of a
    history with pictures is refused again.
- **Summary usage** goes on the bus as `usage` with a new `summary: true`. `Stats` counts its
  spend, as it does the judge's, but does not set the gauge's context from it: a summary request
  is not the conversation's (stats.ts:14-20).

**Tests:**
- An estimate over the window shortens before the request, and the request holds the new
  history.
- A `"window"` cut-off shortens and retries once, and its partial reply is never stored.
- A `tooLong` 400 with pictures in the history shortens and does not ask about pictures.
- A second "too long" ends with the line.
- A failed transcript refuses to shorten and ends with the line.
- **Saving first fails at the `shortened` line** (a fake `Transcript` whose write of that line
  sets `failed`): the history and system prompt are unchanged, no `shortened` event comes, and
  the turn ends with the line.
- `/lead` to a smaller window shortens; a failed summary keeps the old lead.
- A subagent shortens.
- `prompts` survive a shortening.
- Summary usage adds to the cost and the totals but leaves the gauge's context alone.

Commit: `feat: the session shortens a conversation that will not fit, before the request or after a "too long" answer`.

## Task 13: `/compact`, `/autocompact`, and the shortened line

**Files:** modify `src/tui/app/queue.ts`, the three command lists, `src/settings.ts`,
`src/tui/app/constants.ts` (LIVE), `src/tui/app/liveEdits.ts`, `src/tui/App.tsx`, and their tests
(`settings.test.ts`, `app.test.tsx` with `-t`).

**Behaviour:**
- **`/compact [words]`** shortens between turns, with the words as the focus. With no messages,
  it says its line.
- **`/autocompact`** and **`autoCompactWindow`** work as choice 26.
- **The `shortened` event:**
  - It says the approved grey line.
  - It keeps the summary, so Ctrl+O opens it: `openDetail` in full screen, printed in classic.
    This replaces the last turn's calls until the next turn.
  - It sets the gauge's context to 0 until the next request reports.

**Tests:**
- `/compact` sends a summary request and shows the line.
- Ctrl+O then shows the summary.
- `/compact focus on tests` puts "Focus on: focus on tests" in the request.
- `/autocompact 200k` makes a turn over 200,000 estimated tokens shorten first.
- `/autocompact off` stops that.
- A wrong `/autocompact` gives the usage line.
- `autoCompactWindow` in settings applies live.

Commit: `feat: /compact and /autocompact shorten on demand, and Ctrl+O shows the summary`.

## Task 14: Documents and the terminal checklist

**Files:** modify `README.md` and `docs/plans/2026-11-06-tachikoma-release-8a-design.md` (an "As
built" section).

**What changes:**
- **The README:**
  - The release list follows the main design's new order: 8 in four parts, rewinding as 9, 15 in
    all.
  - The "release 11" and "release 13" mentions become 12 and 14.
  - Sessions, resuming, the new commands and settings, shortening, and their known limits get
    their own sections.
  - The known limit "The history is never shortened" is removed.
  - The "auto mode" paragraph's sentence about shortening dropping a stated limit is updated: the
    summary now quotes the user's instructions, and the `dangerousCommands` advice stays.
- **The design** gets an "As built" section listing this plan's choices as the user settled them.

**All README wording goes to the user before it is committed.**

**The terminal checklist,** for the user in Windows Terminal:
1. A session, then `tachi -c`.
2. `tachi -r`'s list.
3. Two windows on one session.
4. `/clear`, `/resume`, `/branch` and `/rename`.
5. `/export`, to a file and to the clipboard.
6. `/compact`, then Ctrl+O.
7. `/autocompact` with a small number.
8. A long session past the window on a small-window model.
9. Killing the window mid-turn, then resuming.

Commit: `docs: release 8a in the README, and the design as built`.
