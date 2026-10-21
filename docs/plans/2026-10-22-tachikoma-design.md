# Tachikoma: design (2026-10-22)

Tachikoma is a coding-agent harness written from scratch in TypeScript. Any of several model
providers can lead a session, and the lead can hand work to other models and to the official
`claude`, `codex` and `kimi` command-line tools. It ships with long-term memory (MemPalace),
search of the codebase by meaning (EmbeddingGemma 2), a Docker sandbox, and a log of errors that it
turns into lessons for later sessions.

It is a portfolio project and is built as software for strangers to install on a clean machine:
nothing in it depends on the author's own setup.

The name comes from the AI tanks in *Ghost in the Shell* that share their memories each night and
learn from experience. The command is `tachi`.

## Decisions and where they came from

| Decision | Choice | Source |
|---|---|---|
| Build approach | From scratch, not on Claude Code or Pi | User, 2026-10-22 ("C. i want it for a portfolio of work") |
| Language | TypeScript on Node | User, 2026-10-22 |
| Provider modes | Switching the lead model **and** a lead that delegates to others | User, 2026-10-22 ("both") |
| Version 1 scope | A thin, complete core first, then features one release at a time | User, 2026-10-22 (option 1) |
| MemPalace | Installed automatically and on by default, run in a private Python environment through uv | User, 2026-10-22 (option 1) |
| Palace | A fresh palace in Tachikoma's own data folder; never `~/.mempalace` | User, 2026-10-22 ("separate palace for this project just to start") |
| Sandbox | Both modes: live link and copy-then-review, chosen per session | User, 2026-10-22 ("sure both") |
| Name | Tachikoma | User, 2026-10-22 |
| Skills | obra/superpowers built in, plus our own skills for features only Tachikoma has | User, 2026-10-22 ("go with that") |

## 1. Overall shape

One npm package. Its parts are folders, not separate packages; split it only if a real need comes up.

```
src/
  core/       agent loop, conversation store, events
  providers/  API providers and CLI workers behind one interface
  tools/      file, shell, search; each runs through an executor (local or Docker)
  mcp/        MCP client (MemPalace, code search, any server the user adds)
  skills/     SKILL.md loader
  tui/        terminal interface (Ink) and status line
  cli.ts      entry point: interactive, or headless for loops
sidecar/      Python, managed by uv: MemPalace and the code search, both run as MCP servers
skills/       built-in skills: vendored superpowers, plus Tachikoma's own
```

**One loop sends events, and several parts listen.** The loop emits events: message, tool call,
tool result, token use and error. The terminal interface, headless JSON output, status line and
error log all subscribe to that one stream. The loop never deals with display, so it can be tested
without a screen.

**Conversations are stored in a format no provider owns.** That is what lets the lead change in
the middle of a session: the history is converted into the new lead's format when sent.

**Providers share one interface:** a history and a list of tools go in, and a stream of events
comes out.
- Anthropic has its own adapter.
- OpenAI, OpenRouter, Kimi and Ollama share one OpenAI-format adapter.
- CLI workers (`claude -p`, `codex exec`, `kimi`) sit behind the same interface, marked as
  workers that cannot lead.

**Subscriptions.** Tachikoma never signs in with a Claude or ChatGPT subscription token itself.
Those subscriptions are meant for the companies' own tools. API providers use API keys, and a
subscription is used only by running that company's own CLI as a worker.

### Fitting the context window

Long sessions fill the context window. Switching to a lead with a smaller window can make the very
next request impossible.

**Checked before every request and every lead switch.** The size of the next request, plus room
for the reply, is compared with the lead's context window:
- **Anthropic:** an exact count from its token-counting endpoint.
- **Other providers:** the last reported prompt size plus an estimate for what has been added since.

If it will not fit, the history is shortened first.

**Shortening the history:**
1. **Full transcript on disk.** Every message is appended to `.tachikoma/sessions/<id>.jsonl` as the
   session goes, so shortening never loses anything for good.
2. **Memory save.** It is started before any shortening.
3. **Summary.** The current lead writes a summary of everything before a **cut point**.
   - The cut point is always at a message the user typed. A tool call and its result are never split
     up, and every tool call has its result on the same side of the cut.
   - If the earlier part is itself too big for the lead, it is summarised in pieces that fit, and
     the pieces are then combined.
4. **New history.** The summary, followed by everything from the cut point onward. Kept assistant
   messages lose their stored provider content (see `native` in the plan) and keep only their
   text and tool calls. Anthropic thinking blocks would be rejected after the earlier history
   changed.

**If the memory save fails,** shortening still goes ahead. The transcript on disk already holds
everything, and the alternative is a session that cannot continue. The failure is logged and shown.

**Shortening is the only exception to "the history only grows."** It resets the prompt cache.

**Still to measure:** how much recent history to keep after the cut point.

## 2. Orchestration and loops

**Delegation.** The lead hands out work with one tool, `delegate(task, worker, tools)`. Each worker
runs its own copy of the agent loop with a fresh context, and only its final answer comes back.
- **API workers** run inside Tachikoma, and their tokens and cost appear in the status line. Their
  tools go through Tachikoma's executor and permission gate like the lead's.
- **CLI workers** run as child processes using their JSON output modes. Each is bound by its own
  subscription's limits. They run their own tools, so Tachikoma's executor cannot police them
  directly. The rules below say where they run and what they may do.
- **Parallel work.** Several `delegate` calls made in one turn run at the same time. The cap on
  how many run at once is a setting. Its default comes from measuring rate limits (see
  "Still to measure").

### CLI workers: where they run and what they may do

**What each CLI can enforce** (each `--help`, checked 2026-10-22):

| CLI | Limit its tools | Sandbox | Spending cap | Machine-readable output |
|---|---|---|---|---|
| `claude -p` 2.1.307 | `--allowedTools` / `--disallowedTools`, `--permission-mode` | none | `--max-budget-usd` | `--output-format json` |
| `codex exec` 0.163.0 | none | `--sandbox read-only` or `workspace-write`, `--cd` | none | `--json` |
| `kimi -p` | none: approve everything (`--yolo`) or `--plan` | none | none | `--output-format stream-json` |

**Where they run.**
- With the sandbox on, a CLI worker runs **inside the session's container**. The default image
  includes the CLIs, and their login files are mounted read-only. Whether each CLI's login works
  that way is still to be checked.
- With the sandbox off, it runs on the host under that CLI's own restrictions, set as below.

**What they may do.** Tachikoma turns the `tools` list passed to `delegate` into each CLI's own
controls:
- `claude`: an allowed-tools list, a permission mode, and the budget left (see Budgets).
- `codex`: `read-only` for tasks that only read, `workspace-write` limited to the project folder for
  tasks that edit.
- `kimi`: plan mode for tasks that only read, if plan mode turns out to be read-only (still to be
  checked). Anything more needs the sandbox. Its `acp` mode may route its actions through
  Tachikoma's permission gate instead (still to be checked).

**Tachikoma refuses a delegation** and tells the lead why when:
- the CLI cannot enforce the requested tools where it would run. For example, `kimi` with write or
  shell access on the host.
- running it would need a flag that turns off the CLI's own safety (`--yolo`,
  `--dangerously-bypass-approvals-and-sandbox`) outside the container.
- the run has a cost-only budget and the CLI cannot report or cap its spending (see Budgets).

**Approval.** In `ask` mode a CLI worker running in the background cannot show prompts. So the
delegation itself needs one approval, which shows the worker, the task, the folder and exactly what
it will be allowed to do.

### Switching the lead

`/lead <provider:model>` swaps the lead mid-session. If the history does not fit the new lead's
context window, Tachikoma shortens it first (see "Fitting the context window"). If it still does
not fit, the switch is refused, with the numbers.

### Loops

Loops run in headless mode and come in two kinds:
- **On a timer:** run a prompt every N minutes.
- **Until done:** repeat until a check command passes, such as "the tests pass". The check is a
  real command, so the model cannot simply declare itself finished.

Every loop needs a limit set by the user. There is no default limit, because no data yet supports
one.

### Budgets

One budget controller covers each run: an interactive session or a loop.

**What the budget counts.** Every participant draws on the same budget: the lead, every worker at
any depth, every retry, and every check command.

**The three limits:**
- **Time.** Wall-clock time from the start of the run. Always enforceable.
- **Rounds.** Model requests across the whole run, counted before each one is sent. Always
  enforceable.
- **Cost.** USD. It can only be enforced when every participant reports its cost:
  - priced API models
  - `claude -p`, which also gets `--max-budget-usd` set to what is left

  A model with no known price, or a `codex` or `kimi` worker, cannot be measured. A run that might
  use one must also have a time or rounds limit, or it is refused at start.

**When a limit is hit:**
1. **Before any work starts** (a model request, a tool run, a worker or a check command), the
   controller is asked first. Once the budget is spent, nothing new starts.
2. **Work already running is cancelled**:
   - every in-flight request is aborted
   - every process tree is killed: shell commands and everything they started, and CLI workers
   - every worker container is stopped with `docker kill`
3. **A request already sent may still be billed.** So spending can go past a cost limit by up to
   the requests that were in flight at that moment. The run's report shows the real spend next to
   the limit.

**When a worker fails,** the lead gets a result marked as an error, not a crash. The lead decides
whether to retry, reroute or give up, and the failure is also written to the error log.

## 3. Sandbox

All tools that touch the machine (shell, file writes, running code) go through an executor. There
are two: `LocalExecutor` and `DockerExecutor`. Tools cannot tell which one they are using.

**The Docker executor:**
- Starts one container per session, removed when the session ends. Each worker can have its own.
- Is driven through the `docker` command, not a library, so its commands match what a user would
  type.
- Uses a default image with Node, Python, git and uv. A project can supply its own Dockerfile.
- Has network access set per session: on, off, or a list of allowed sites.

**How the container sees the project:**
- **Live link:** the project folder is mounted into the container, so edits land in the real
  folder at once. This is the default for interactive sessions.
- **Copy, then review:** the container works on a copy. When the session ends, Tachikoma shows the
  diff and the user picks what to keep. This is the default for loops. It also avoids Docker
  Desktop's slow reads of Windows folders on large repos.

**Applying a copy-then-review session without losing anyone's work:**
1. **Snapshot.** At the start, Tachikoma copies the project exactly as it is, including uncommitted
   and untracked files, so work in progress is the starting point and nothing is lost. It records
   the SHA-256 hash of every file. The real folder is not touched again until the user applies
   changes.
2. **The changes** are the container's copy compared with the snapshot: added, changed and deleted
   files.
3. **Each change the user accepts** is checked against the real folder before it is applied:
   - If the real file still matches its snapshot hash (or, for an added file, still does not
     exist), the change is applied. The file it replaces is first saved to
     `.tachikoma/backups/<session>/`, so it can be undone.
   - If the real file changed in the meantime (edited, created or deleted by the user), it is a
     **conflict**, and Tachikoma never overwrites it. It offers a three-way merge (`git merge-file`
     with the snapshot as the base), with any conflict markers written to a separate file for the
     user. The other choice is to skip that file.
   - A deletion is applied only if the real file still matches its snapshot.

**Permission modes** are the same for both executors: ask before every risky action, ask only for
actions outside the project, or never ask. "Never ask" is meant to be paired with the sandbox.

## 4. Memory, error log and lessons

### Memory (MemPalace)

- `tachi setup` installs `mempalace==3.11.0` (MIT; on PyPI) into Tachikoma's own uv environment.
  It is always called by full path and never found through PATH.
- The palace is created fresh on first run at `<data folder>/palace`, and the path is always
  passed explicitly. (MemPalace 3.10 and later default to `~/.config/mempalace`; Tachikoma never
  relies on that default.)
- **There is one MemPalace process, and it is the only writer**, shared by the lead and every
  worker. In 3.11.0, `MEMPALACE_MCP_ALLOW_PEER_WRITER` no longer lets several processes write
  with the `sqlite_exact` backend (`mcp_server/_guards.py:574-582`).
- Tachikoma starts this process, restarts it when it dies, turns off its idle shutdown
  (`MEMPALACE_MCP_IDLE_HOURS=0`), and sets a time limit on each call.
- **One writer across every session, not just within one.** Two `tachi` sessions started separately
  share one memory service:
  - **Owner.** The service is owned by a small background supervisor, not by any one session, so
    closing the session that started it does not cut off the others. The supervisor holds an OS file
    lock on `<data folder>/palace.lock` for as long as it runs. The OS frees that lock if the process
    crashes, so a lock is never left stale. Your MemPalace notes show why that matters: the PID
    written in its own lock files was often out of date.
  - **Connecting.** A session that needs memory tries to take the lock:
    - If it gets the lock, it starts the supervisor, which writes its local address (a named pipe
      on Windows, a Unix socket elsewhere) to `<data folder>/memory.endpoint`.
    - If it doesn't, it reads that file and connects.
  - **Startup race.** Taking the lock is atomic, so only one session can win. The others wait for
    the endpoint file.
  - **Crash recovery.** If a session cannot connect and the lock is free, the owner has crashed. The
    session takes the lock and starts a new supervisor.
  - **Shutdown.** The supervisor stops when its last session disconnects. There is no idle timer,
    so there is no number to guess.
  - **Check first:** MemPalace 3.9 and later add a "hub" mode. If it gives the same guarantees, use
    it instead of writing our own supervisor (see "Still to measure").
- Settings shipped with it: the `sqlite_exact` backend, `exclude_patterns` for bulk data files,
  an embedding thread count, and `PYTHONIOENCODING=utf-8`.

**When memory is involved:**

| Moment | What happens |
|---|---|
| Session start | Tell the model to search memory before answering about past work, and include lessons that match the task |
| End of each turn | Save in the background; the user never waits for it |
| Before the history is shortened | Start a save first. If it fails, shorten anyway: the transcript on disk keeps everything (see "Fitting the context window") |
| Session exit | A final save, allowed to finish within a time limit |

**Lessons from the author's MemPalace history** (an audit of their setup on 2026-10-22, checked
against the 3.11.0 source):
- **Never block the end of a turn on a save.** In 3.11.0 the Stop hook still waits up to 30 s
  for the diary write and resends it when it times out (`hooks_cli.py:1090-1091`).
- **Supervise and restart the background process.** It still dies without a known cause.
- **The session-start recall hook has to be ours.** MemPalace's own `hook_session_start` still
  returns nothing.
- **Big palaces are slow to update.** An FTS delete in `backends/sqlite_exact.py` (around lines
  696 and 1327) still scans the whole full-text table. It only matters for palaces with hundreds
  of thousands of entries. It is a candidate for a fix sent upstream.
- **Filing rules for the agent:**
  - Set `source_file` to a session label, never a path that also gets mined.
  - "No palace found" means reconnect, never run `init`.
  - Always pass `room`.

### Error log

Every failure is written as one line of JSON to `.tachikoma/errors.jsonl` in the project. Failures
include:
- tool errors and commands that exit with an error
- provider errors and rate limits
- workers that give up
- loop checks that fail

Each line records what was attempted, the error text, the lead model and the session. `/errors`
summarises the log.

### Lessons

1. **Capture.** When a failure is fixed later in the same session, Tachikoma asks the model for a
   short lesson: what went wrong, what fixed it, and how to spot it next time. A lesson can also
   come from the user (`/lesson`) or the model (`record_lesson` tool).
2. **Store.** Lessons go into the palace in the `lessons` room, tagged by project. Any model can
   find them later.
3. **Use.** When a tool fails, Tachikoma searches the lessons for that error and attaches the
   matches before the model sees the error. Lessons that match the task are also included at
   session start.

Version 1 has no separate critic model. The failed check and any matching lessons are the
correction.

## 5. Skills, status line, codebase search, install

### Skills

Skills are `SKILL.md` files in Claude Code's format. Tachikoma reads them from three places, and
later ones override earlier ones:
1. built in
2. `~/.tachikoma/skills`
3. `.tachikoma/skills` in the project

Only each skill's name and description go in the prompt; the model loads the rest when it needs
it.

**Built-in skills:**
- **obra/superpowers v7.0.1** (MIT, copyright Jesse Vincent), copied into the package with its
  licence and credited in the README. `scripts/update-superpowers` pulls a newer version when we
  choose to upgrade.
- **Superpowers names Claude Code tools:** `TodoWrite` (14 times), `Task tool` (4) and
  `Skill tool` (4), counted in v4.0.3. Tachikoma's `todo`, `delegate` and `skill` tools do the
  same jobs, and the system prompt maps the names. Check how v7 handles harnesses other than
  Claude Code before building our own mapping.
- **Tachikoma's own skills:**
  - delegating across providers
  - using memory and lessons
  - reviewing sandbox work
  - the author's engineering rules: no assumptions without data, simplicity first, surgical
    changes
- An opt-in `tachi skills import` copies a user's Claude Code skills after checking each licence.

### Status line

The bar along the bottom shows:
- the lead model
- how full the context window is
- tokens and cost this session
- running workers
- sandbox mode
- whether memory and search are up

The user chooses which parts appear. Cost comes from a pricing table copied from each provider's
published prices, with the date it was copied. Local models cost nothing.

### Codebase search

- Search runs as an MCP server in the uv environment. It uses `google/embeddinggemma-2` at
  revision `914f7f89142e33e77833254d9c9b90c3cef7303b`, text part only, in bfloat16, through
  `sentence-transformers>=6.1`.
- It copies Motoko's way of splitting files and its prompt formats
  (`Motoko/tools/code_search.py`; `MODELS["embeddinggemma-2"]`, 8,192-token limit). Those are what
  the 2026-10-17 search test measured, where EmbeddingGemma 2 beat jina-code 0.5b and Qwen3 0.6B
  (`Motoko/docs/checks/2026-10-17-embedding-test.md`).
- On the Jetson's GPU it indexed five repos in 29.5 min (6.7 pieces/s) and took 0.20 s per
  question (median).
- The index lives in `.tachikoma/index/`. Each build is a new version and is never edited, and
  pieces that have not changed keep their vectors (matched by SHA-256), as in Motoko.
- It uses the GPU when there is one. What CPU-only users get depends on a speed test.

### Install

```
npm install -g @<scope>/tachikoma
tachi setup
```

`tachi setup`:
- checks the Node version
- installs uv if it is missing, after asking
- builds the pinned Python environment
- downloads the model
- checks Docker
- asks for API keys, and also picks up keys already set as environment variables
  (`ANTHROPIC_API_KEY`, etc.)

Keys are stored in Tachikoma's config folder, readable only by the user. `tachi doctor` checks
everything again and says what is broken and how to fix it.

Data folder:
- Windows: `%LOCALAPPDATA%\tachikoma`
- macOS: `~/Library/Application Support/tachikoma`
- Linux: `~/.local/share/tachikoma`

## 6. Testing and error handling

**Tests:**
- **Core loop:** run against a fake provider that replays a scripted conversation. No network.
- **Providers:** run against real responses recorded once. Live tests run only when
  `TACHI_LIVE=1` is set.
- **Sandbox:** integration tests on real Docker, skipped with a message when Docker is missing.
- **Python services:** pytest for search, and an MCP handshake test for both servers.
- **Fresh install:** GitHub Actions on clean Windows, macOS and Linux machines installs the packed
  tarball, runs `tachi setup --yes`, then runs `tachi doctor`, which must pass.

**Errors:**
- Every failure says what broke and how to fix it, and nothing fails silently.
- What happens next depends on whether the part that failed is a safeguard.

**Safeguards.** An action that needs one never runs without it:
- the permission gate
- the chosen executor: if the sandbox was chosen and Docker fails, shell and file tools refuse to
  run; they never quietly fall back to running on the host
- the budget controller
- the copy-then-review snapshot

If one of these fails, every action that depends on it fails with an error, and a loop stops.

**Optional services** turn off by themselves while the rest keeps running, and the status line
shows them in red:
- memory
- code search
- lessons
- writing the error log

## Still to measure

None of these gets a value until it has been measured. Each one becomes a plan step, with a script
whose results are recorded.

1. EmbeddingGemma 2 speed on CPU and on an RTX 4070. Decides what CPU-only users get.
2. Whether `google/embeddinggemma-2` needs a Hugging Face login or licence acceptance, and how big
   the download is.
3. How many workers can run at once within each provider's rate limits. Sets the default cap.
4. Which transcript formats MemPalace 3.11's conversation miner reads. Decides whether Tachikoma
   writes transcripts it can read or files memories through MCP tools directly.
5. How superpowers v7 maps tool names for other harnesses.
6. How many lessons to include, and how close a match must be. Needs a real error log first.
7. Whether the slow FTS delete in MemPalace 3.11 matters at the palace sizes users reach.
8. Whether `claude`, `codex` and `kimi` logins work inside a container when their login files are
   mounted read-only.
9. Whether `kimi --plan` is truly read-only, and whether `kimi acp` can send its actions through
   Tachikoma's permission gate.
10. Whether `codex exec --json` reports token use or cost. If it does, `codex` can count towards
    cost limits.
11. Whether MemPalace's hub mode (3.9 and later) gives one writer across separate processes, with
    crash recovery. If not, Tachikoma uses its own lock-file supervisor.
12. How much recent history to keep after the cut point when shortening.

## Release order

Each release works on its own and can be shown.

1. **Core:**
   - the agent loop
   - file and shell tools (local)
   - Anthropic and OpenAI-format providers, with lead switching
   - the terminal interface with status line
   - the error log
2. Docker sandbox, both modes, including conflict-safe apply for copy-then-review
3. MCP client, and MemPalace in the uv environment behind the shared supervisor; transcripts on
   disk; shortening the history
4. Skills: the loader, vendored superpowers, Tachikoma's own skills
5. Codebase search with EmbeddingGemma 2
6. Budget controller, then CLI workers and delegation, with each CLI's permission mapping and the
   refusal rules. The controller comes first because workers have to be cancellable as a group.
7. Loops: on a timer, and until done
8. `tachi setup` / `tachi doctor`, and the fresh-install CI
