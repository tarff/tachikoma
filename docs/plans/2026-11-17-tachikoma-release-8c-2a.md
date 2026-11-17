# Tachikoma release 8c-2, part A: servers inside the sandbox, and `headersHelper` (implementation plan)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to build this plan task by task: a
> fresh builder per task, then a spec review, then a code review.

**Goal:** the approved design (docs/plans/2026-11-17-tachikoma-release-8c-2a-design.md, with "After the design review")
is built. With the sandbox on, each local MCP server starts inside the session's box through `docker exec -i`, its
variables sent as one block before the first message, unless the user's own entry says `"host": true`; the box's
network decides what starts; in `never` mode a box server's call runs unasked while the network is off. A project
server's answer records where it runs, and its question says so. A remote entry's `headersHelper` runs at each
connection, its headers merged over the static ones, sign-in chosen per connection, no redirect followed with the
entry's headers, and a 401 or 403 refreshes the connection once, calls in flight finishing on the old one.

**Architecture:**
- **Where a server runs** is one small module, `src/mcp/place.ts`. From an entry and the sandbox (its kind and network,
  or none) it gives `placeOf` (`box`, `host` or `remote`), `starts`, `helperRuns` and `answerSetup`. `Servers`, the
  launch's questions (`askServers`, `serverQuestion`) and the approval read only these.
- **A box server** is 8c's `Server` given an `McpBox` (`src/mcp/box.ts`: the box's id, kind, `BoxState` and
  `DockerRun`). Its transport, `BoxStdio`, subclasses 8c's `Stdio`: the library's own stdio transport, starting
  `docker exec -i` with a wrapper that reads the variables block, then `exec`s the server. The block is written in
  `start()`, before the library's first message. Its stop closes the input, then after 300 ms kills its process group
  inside the box.
- **Approval** reads a new `Offered.boxNetwork` into the gate's `Action.boxed`; `needsApproval` lets a boxed call run
  in `never` mode.
- **The helper** runs through 8b's hook runner (`runHook`), with its shell, its kill at the time limit, the helper's
  folder and its two variables (`src/mcp/helper.ts`). Each remote connection is prepared first (helper, merge,
  sign-in or not) and gets a `fetch` of its own (`connectionFetch`, replacing 8c's `toServer`). That fetch puts the
  headers where 8c did, fails a redirect elsewhere, and reports each status the server's own address gives.
- **The refresh** is a second connection the server opens beside the first. There is one per connection, and it keeps
  the connection number, so a call bound to the old connection passes 8c's check when its tool is unchanged. Calls in
  flight finish on the old connection, which closes after the last one. A call between its approval and its send waits
  for the refresh (`Server.refreshing`) in `mcp/tools.ts`.

**Tech stack:** as main (TypeScript 5, Node 22.20, Ink 7.1.1, Vitest 5.0.3, `@modelcontextprotocol/client` 2.4.0). No
new dependency.

---

## Before you start

**How this plan is built.** As earlier plans: each task gives the files, the behaviour and the tests, and each test
says what it must show; the builder writes the code. A builder writes the tests first and sees them fail, then the code,
then commits. A spec reviewer and then a code reviewer check the commit before the next task starts. One PR, Tasks 1-12.

**Stop for the user:**
- Before Task 1, the "Choices for the user" below are answered. Tasks 1, 2, 4, 6, 7, 8, 9, 10 and 11 hold the
  recommended answers; a builder changes one to the user's answer before writing tests.
- In Task 12, the README's new words are approved before its commit, and the terminal check is the user's.

**The branch.** `release-8c-2a` (the design is commits d4382f3, 6cd925d, 938aedc and 14d9f1f). Do not push: every push
needs the user's say-so. Main takes changes only by pull request, with CI's `test` check passing.

**Checks, from the repo's folder:**
- Types: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
- One file: `node node_modules/vitest/vitest.mjs run tests/mcp/box.test.ts`
- The App's tests only with `-t`, as in
  `node node_modules/vitest/vitest.mjs run tests/tui/app.test.tsx -t "sandbox's network"`. Never the whole file for a
  task.
- `tests/tui/external.test.ts` never runs.
- Real Docker tests skip themselves where Docker is not running or the image is not built, as the sandbox's tests do
  (tests/sandbox/executor.test.ts, `ready`). A builder without Docker says so in the task's report, and Task 12's full
  suite runs where Docker is running.
- The full suite runs once, at the end of Task 12:
  `node node_modules/vitest/vitest.mjs run --exclude tests/tui/external.test.ts` (about 9 minutes, as the last plan
  measured it). If tests time out under load, rerun those files alone.
- Line endings, for every file a task touched: the working copy is CRLF, git stores LF, and core.autocrlf is true.
  Run the line-endings command in docs/plans/2026-11-17-tachikoma-system-prompt.md ("Before you start", line 59) from
  Git Bash with the files' names. An existing file must show `LF 0`. A new file may be all LF or all CRLF, never both.

**Rules every builder follows:**
- No registry fetch and no package install of any kind (none except via `sfw`, and only after asking the user). No
  network: the tests' stand-in servers on 127.0.0.1 are the only HTTP, as tests/mcp/server.test.ts already does.
- No real model calls in tests: use FakeProvider, session.test's `Lead` or tools.test's `Model`. The Anthropic and
  OpenAI SDKs capture `fetch` when a client is made, so never make a real client in a test.
- Never read `.anthropic-key` or `.openrouter-key`. Never change permissions or ACLs.
- Real Docker: every container a test starts is the sandbox's own image, never pulled, with the network off, labelled
  `tachikoma.test=1` and removed when the test ends, as tests/sandbox/executor.test.ts's are (release 7 plan, choice
  73).
- No fake `docker` program on PATH and no PATH change (src/sandbox/docker.ts's rule). The box server's stand-in
  (tests/standin/dockerExec.mjs, Task 4) is a script that node runs, given as `McpBox.program`.
- A test that starts a box server stops it with `server.stop()` before its folder is removed, as a running stand-in
  holds its folder on Windows. A stubborn fake's pids are killed in the test's cleanup, as POSIX kills the stand-in
  alone.
- Edit with the Edit tool, never `sed -i` (it turns CRLF into LF). Rewrap only lines you changed. Lines are at most 120
  columns; split a long string with `+`. Comments say what and why and cite this plan ("8c-2a plan, Task N") or the
  design and its choices, as the files around them do.
- User-visible and model-facing words are the approved ones, copied exactly from "Lines this plan adds". Change none.
- Delete only files you made, by exact name.
- Commits: write the message to a file in your scratchpad directory and run `git commit -F <that file>`. The message
  ends with two lines: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, then
  `Claude-Session: https://claude.ai/code/session_011HyFwUUVRarEnjhRmMcKdH`.

---

## Decisions this plan makes

Each is marked in its task. The user approves them with the plan.

1. **The box server's transport is the library's stdio transport.** 8c's `Stdio` is subclassed as `BoxStdio`, started
   as `docker exec -i -w /work <box> bash -c <outer> _ <inner> <command> <args...>`. The block is written in `start()`,
   once the process has spawned. That is safe because:
   - the library's `Protocol.connect` awaits `transport.start()` before it sends anything
     (node_modules/@modelcontextprotocol/client/dist/src-CeKsbNLO.mjs:5865);
   - its default version negotiation is "legacy" (public-CvV4ZHkX.mjs:2180), so the first message is `initialize`;
   - a subclass of the transport is probed in place, never on a sibling process (public-CvV4ZHkX.mjs:2493-2506);
   - a pipe keeps the order of what is written.

   Task 4.
2. **The wrapper is inGroup's, with the server's words passed as arguments.** inGroup (src/sandbox/executor.ts:344-382)
   runs through a `DockerRun`, which closes its input (docker.ts:61), and it passes one argument. The outer script keeps
   inGroup's process group, its group file in /tmp and its `.stop` file. The inner script reads the block with
   `IFS= read -r -d ''`, exports each entry and checks the command with `command -v`. It checks after the block, so an
   entry's own `PATH` counts. Then it `exec`s the command, with `exit 2` if the block is cut short. The stop's kill line
   is executor.ts's own, exported as `killLine(group)`. Task 3.
3. **"Not found in the box" is reported by the inner script.** When `command -v` finds nothing, it prints
   `tachikoma: not found` to its error output and exits 127. The server's red line is the approved one when the process
   ended with 127 and that is its last error line. A server can print the same words, which only gets it the same line.
   Task 4.
4. **A variable name the box cannot take is refused when the server starts,** not when the settings are read. On this
   computer a name such as `ProgramFiles(x86)` is fine, so only a box server refuses it, with its red line (choice 5).
   Task 4.
5. **The `docker` program** is found on PATH at each start (`onPath("docker", env)`). It is started with `commandEnv` of
   the session's environment, as src/sandbox/docker.ts starts it. The library adds its own short list of variables from
   Tachikoma's environment under these (stdio.mjs:74-80, `getDefaultEnvironment`), never the entry's. If none is found,
   the start fails with the sandbox's own words, `no docker program is on PATH any more` (executor.ts:121, `NO_DOCKER`).
   Task 4.
6. **At exit a box server's `docker exec` is ended at once,** with no 300 ms wait and no kill inside the box, because
   removing the box ends the server (design, "Stop"). `Servers.stopAll()`, which only the exit paths and signal
   handlers call, stops each server with `stop({ exit: true })`. `/mcp` Reconnect, a live edit and a restart use the
   full stop. Task 4.
7. **When a box server ends, Docker is asked whether the box still runs** (`BoxState.gone()`). If it does not, the
   reason is `the box stopped`. A box already broken (`BoxState.broken`) refuses a start with the same words. Task 4.
8. **Roots say `file:///work`, written out as such:** `pathToFileURL("/work")` gives `file:///C:/work` on Windows.
   Task 4.
9. **`host` and `headersHelper` in the entry.**
   - `host` is a local server's field (`ServerConfig.host?: true`), set only from the user's file. On a remote entry it
     is another kind's field and is passed over without a line, as `command` is today.
   - `headersHelper` is a remote field: text, kept in the entry and in `asWritten`. `${VAR}` in it is not filled,
     because it is a shell command, which reads its own variables, and Claude Code's MCP page lists the fields it
     expands as `command`, `args`, `env`, `url` and `headers`. That list comes from the design's source, its
     "Environment variable expansion" part. Task 1's builder checks it against that page and says so if it differs.

   Task 1.
10. **`Servers` keeps its `network` option and gains `box?: McpBox`,** which carries the sandbox's kind, so tests that
   pass `network: "none"` change nothing. A sandbox's network with no box given is a programming error, thrown in the
   constructor. Task 6.
11. **An answer's setup is text.** It is `host`; `box copy network off` or one of the other three box setups;
   `helper` or `no helper` for a remote entry with a helper; and none for a remote entry without one. A line saved by
   8c has none, and counts both for `host` and for none, since 8c's answers were all one or the other (design:
   "Answers saved by 8c count as `host`"). A newer `host` answer wins over an 8c line. Task 2.
12. **How the approval reads a box server.** `Offered.boxNetwork` is the box's network for a box server's tool.
   `approveOf` gives the gate `boxed: true` when it is `"off"`, and `outside: false` for any box server's call, since
   the server runs inside the box. 8c gave `outside: true`, which only the judge reads. Task 7.
13. **The helper runs through `runHook`** (src/hooks/run.ts).
   - `shellOf`'s and `runHook`'s parameters widen to `Pick<Hook, "command" | "args" | "shell">`, and the input becomes
     optional, so the helper's stdin is closed with nothing written to it.
   - Its folder is `~/.tachikoma` (`settingsDir()`) for the user's entry, and the project's folder for a project's.
   - `CLAUDE_PROJECT_DIR` is the project's folder for both, through a new `projectDir` option of `runHook`, as hooks
     get it.
   - A project's helper runs without any variable whose name holds TOKEN, SECRET, PASSWORD, KEY or AUTH, in any letter
     case.

   Task 9.
14. **The helper's 10 s come before the start's 30 s,** not inside them: the 30 s start limit belongs to the server.
   Task 10.
15. **A header from the helper** must have a name HTTP takes (a "token", RFC 9110, section 5.6.2), and a value without
   a line break or NUL. Anything else fails the connection, and its reason says which (choice 5). Task 9.
16. **Sign-in is chosen per connection.** `McpAuth` is made for every remote entry with a running helper, and, as in 8c,
   for an entry without one whose static headers have no `Authorization`. A connection signs in when `McpAuth` exists
   and its merged headers have no `Authorization`. 8c's checks of `this.#auth` in `callTool`, `#request`, `onerror` and
   the start (server.ts:205, 237, 314, 405) read the connection's own `signs` instead. Task 10.
17. **Each remote connection gets one `fetch` of its own** (`connectionFetch`).
   - With sign-in, it adds the headers to the server's own address only, as `toServer` did. Without sign-in, the
     headers stay `requestInit`'s, as in 8c.
   - A request carrying the headers is sent with `redirect: "manual"`.
   - The redirect line names only the new address's origin, as 8c's lines do (server.ts:467-469), because a path or a
     query can hold a token (the plan review's finding 5).
   - A hop the library follows within the origin is the same request (decision 27).
   - `#startReason` reads a `Redirected` error anywhere in the error's cause chain as its own words, because the SSE
     transport's event stream wraps what its fetch throws.

   Task 10.
18. **What starts a refresh** is a 401 or 403 from the server's own address, seen by the connection's `fetch`, on
   a ready connection whose headers a helper gave. On a connection that signs in, a 401 stays sign-in's, as in 8c
   (choice 59: `needs sign-in`), and only a 403 refreshes. The SDK's own errors are not used to decide: the SSE
   transport carries the status only in its words (index.mjs:1252). Task 11.
19. **A refresh keeps the server's connection number** (`Server.connection`). `Servers.current` therefore still binds a
   call offered before the refresh, and its check of the tool's definition (`#now`) refuses one that changed on the new
   connection, as the design asks. `/mcp` Reconnect and a restart raise the number, as in 8c. Task 11.
20. **Calls wait for a refresh in `mcp/tools.ts`,** after their approval and before 8c's last check.
   - The refresh's end is `Server.refreshing`: `ready`, `failed` (with its reason, and whether the helper failed) or
     `dropped`.
   - A dropped refresh gives 8c's changed line when the server was removed or replaced, and its stopped line otherwise
     (a restart, Reconnect or the exit).
   - An `mcp_tool` hook's call does not wait: it goes on the connection in force, under its own limit.

   Task 11.
21. **A stop during a refresh** marks the refresh dropped and aborts its helper (runHook's signal kills it). It also
   closes both connections. The dropped refresh stays readable through `refreshing` until it settles, so a call that
   finishes its approval just then still reads `dropped`. A refresh ending afterwards finds it is no longer current and
   closes what it opened. A new 401 or 403 is not blocked by a dropped refresh still settling. Task 11.
22. **A stop during a start's helper:** `#connect` counts stops (`#stops`). A stop that came while the helper ran leaves
   the start without connecting, as 8c's `conn.closed` check does after a connect. Task 10.
23. **A failed refresh** leaves the server `failed` with its reason, so its red line is said as at a start. Calls in
   flight on the old connection finish there, and the old connection then closes. Task 11.
24. **A stop that cannot kill a box server's group** (the plan review's finding 1). The kill's failure is read as the
   sandbox's executor reads it (executor.ts:360-366): no docker program gives `NO_DOCKER`; a non-zero exit gives
   Docker's error output, or `the box stopped` when it gave none; a thrown error gives its message. That mapping moves
   into one exported function that inGroup and the box server share (`killInBox`, Task 3).
   - **Kept by name, in `Servers`** (the second plan review's finding 1). A failed kill is recorded as an unresolved
     stop (the group's file, and the reason) in `Servers`, keyed by the server's name. It is not kept on the `Server`
     object, because a live edit or a removal replaces that. The record outlives any number of slot changes: a
     blocked copy replaced again, an entry removed, an entry added back under the same name. It is deleted only when
     the stop is confirmed.
   - **Every new copy for a name retries all of that name's unresolved stops first.** That covers a Reconnect, a
     restart, a live edit's restart and a re-add after removal. Each `Server` is given its name's record
     (`unstopped`, a list `Servers` owns), so its `#connect` runs the retries itself.
   - **If any stop is still unresolved after the retries,** nothing new starts, and the server is `failed` with the
     approved line `its earlier copy could not be stopped in the box (<reason>), so it was not started again`. The
     reason is the latest retry's. Once every stop is resolved, one copy starts.
   - **What confirms a stop** (the second plan review's finding 2). `BoxState.gone()` (executor.ts:182-187) gives a
     reason for a stopped box, but also for no docker program and for any failed `docker inspect`, an unreachable
     daemon included. So a record is cleared only on evidence the code reads directly, never by parsing Docker's error
     text:
     - (a) the kill exits 0 (`killLine` ends `exit 0` only once it ran in the box, the group killed or already gone);
     - (b) `docker inspect --format {{.State.Running}}` exits 0 and prints `false`: a stopped container runs no
       process;
     - (c) Tachikoma's own removal of the box succeeded: `DockerExecutor.stop`'s `rm -f` exits 0, which sets a new
       `BoxState.removed`.

     A new `BoxState.stopped(): Promise<boolean>` gives (b) or (c). No docker program, an inspect that fails, or a
     daemon that cannot be reached keeps the record, and the next retry runs the kill again before anything starts.
   - The exit is unchanged (decision 6): removing the box ends every copy.
   - A box removed outside Tachikoma is not confirmed by (c). Its servers stay blocked, but such a box is already
     `broken` for the shell tools and refuses a start with `the box stopped` (decision 7), so nothing more is lost.

   Task 4.
25. **Retiring connections are kept until they close** (the plan review's finding 2). Each connection a refresh
   replaced stays in a set (`#retiring`) until it closes, whether that is its last call finishing or a teardown.
   `stop()` closes every connection in it, as well as the current one and a refresh's new one. That covers `stopAll`,
   a live edit's removal, `/mcp` Reconnect and a restart. A call still running on a closed retiring connection ends
   as 8c ends a call in flight on a server stopped the same way. Task 11.
26. **The library's own 403 replay is turned off** (the plan review's finding 3).
   - The streamable HTTP transport, on a 403 with `WWW-Authenticate: Bearer error="insufficient_scope"`, runs step-up
     sign-in and sends the request again (index.mjs:1754-1764 for a message, 1515 for its event stream). That resend
     would run a call twice, which the design forbids.
   - Every streamable HTTP connection with a helper is made with the transport option `onInsufficientScope: "throw"`
     (index.d.mts:2371, read at index.mjs:1375 and 1393). The 403 then fails the call. The connection's `fetch` has
     already seen the 403, so Task 11's refresh starts.
   - The error thrown is an `InsufficientScopeError`, an `OAuthClientFlowError` (public-CvV4ZHkX.mjs:175) and not an
     `UnauthorizedError`, so the call is not taken as a lost sign-in.
   - The SSE transport has no such replay: its `_send` handles only 401 (index.mjs:1211-1259), so it needs no option.

   Task 11.
27. **A hop the library follows within the origin is the same request** (the plan review's finding 4). The library's
   `fetchWithinOrigin` calls the connection's `fetch` once per hop (src-CeKsbNLO.mjs:6854-6876), so `/mcp` to `/mcp/`
   arrives as a request for `/mcp/`.
   - **Only along that one request's own chain** (the second plan review's finding 3). There is no lasting allow-list
     of redirect targets. A hop is tied to its originating request by the identity of the request's `init.headers`
     object:
     - The library's `fetchWithinOrigin` passes `{ ...init, redirect: "manual" }` on every hop
       (src-CeKsbNLO.mjs:6862), a shallow copy, so every hop of one logical request carries the very same headers
       object.
     - Each transport builds a fresh `Headers` object for every request, through `_commonHeaders()`: the streamable
       HTTP transport per message (index.mjs:1700), per event-stream open (1476) and per session end (1826), and the
       SSE transport per message (1214) and per event-stream open (1100).
     - A sign-in request is built by the library's `auth()` with its own `init`, so it never shares one.
   - **How the connection's `fetch` tracks a chain.** It keeps a `WeakMap` from a request's headers object to the
     targets (origin and path) of the same-origin redirects that this one request was answered with. It records a
     target only when the request was for its own address, or was already a hop of such a request.
   - **What a hop gets.** A call whose headers object is in the map, for a path in that object's set, is a hop of the
     same MCP request. With sign-in, the entry's headers go on it, and its 401 or 403 counts for the refresh.
   - **What does not count.** Anything else to that path is not a hop: a sign-in request, a later request on its own.
     A later MCP request that redirects again builds its own chain. The map holds the headers object weakly, so a
     chain is dropped with its request.
   - A redirect to another origin still fails before anything is sent there.

   Task 10.
28. **Diagnostics carry no secrets** (the plan review's finding 5; the user approved the new forms).
   - A helper's exit reason is `it exited with code <n>`, never its error output.
   - A helper that cannot start gives `it could not start (<error code>)`. `runHook`'s `Ran` gains `startCode`: the
     Node error's `code`, or `ENOENT` for a program not found on PATH. Hooks' own lines keep `startError`.
   - The redirect line names only the origin (decision 17).
   - The helper's output is never quoted in any reason.

   Tasks 9 and 10.

---

## Choices for the user

The user chose 1-9 on 2026-11-17, each as recommended (1: "Only other sites fail"; 2: "One per setup"; 7:
"Refused"; 3-6, 8 and 9: "Approve all as written"). 10, the README's words, is approved before Task 12's commit.

1. **Redirects within the server's own address (Task 10).** The design's finding 2 assumed that `fetch` follows a
   redirect by itself. The MCP library Tachikoma uses (2.4.0) already applies its own rule to every transport request,
   sign-in's included: `redirectPolicy: "same-origin"` by default. Under it, a redirect is followed only when it stays
   at the same scheme, host and port and keeps the method, and any other fails with the library's words
   (index.d.mts:2099-2112; src-CeKsbNLO.mjs:6854-6876). So the entry's headers never reach another address today. What
   the design's rule adds is failing same-address redirects too, such as `/mcp` to `/mcp/`, which work in 8c with a
   static key.
   - (a) As the design says: every redirect of a request carrying the entry's headers fails with the approved line.
   - (b) A redirect to another origin fails with the approved line, before anything is sent there. A redirect within the
     server's origin is left to the library, which follows it only when it keeps the method.

   **Recommended: (b).** It keeps the design's safety (nothing sent elsewhere) without breaking servers that work today.
2. **One answer per server, or one per setup (Task 2).**
   - (a) One answer per server, the last given: switching the sandbox on and off asks again at each switch.
   - (b) One answer per server and setup: each setup is asked about once, and going back to one already answered asks
     nothing. `/mcp`'s Reset my answer resets all of a server's answers.

   **Recommended: (b).** Both keep the design's rule that only an exact match counts.
3. **The launch's line with the box's network off (Task 6),** said once when a `host` or remote server is off. It
   replaces 8c's `MCP servers are off: the sandbox's network is off, and servers run outside the box until a later
   release. Start with --network on to use them.` with: `MCP servers marked "host" and remote servers are off: the
   sandbox's network is off, and outside the box nothing keeps them off the web. Start with --network on to use them.`
   **Recommended: as written**, or the user's own words.
4. **The warning for `host` in a project's file (Task 1),** worded like `trusted`'s: `.mcp.json: "x" has "host"; a
   server runs on this computer only from ~/.tachikoma/settings.json, so it was ignored`. **Recommended: as written.**
5. **New reasons in a server's red line** (`MCP server x failed to start: <reason>`). The design gives none of these:
   - a box server's variable name (Task 4): `its env has the name "<name>", which the box cannot take: a name there is
     letters, digits and _, not starting with a digit`;
   - no docker program (Task 4): the sandbox's own `no docker program is on PATH any more`;
   - a helper that fails (Task 9): `its headersHelper failed: <why>`, where `<why>` is one of these:
     - `it could not start (<error code, such as ENOENT>)`
     - `it exited with code <n>`
     - `it was ended by signal <signal>`
     - `it did not finish within 10 s`
     - `it printed something other than a JSON object of text values`
     - `it gave "<name>", which is not a header name`
     - `it gave the header "<name>" a value with a line break or NUL`

     The first two were changed after the plan review's finding 5, the user approving: they used to carry the whole
     error and the last error line, either of which can hold a secret. A refresh's helper failure puts the same
     `<why>` after the approved `its headersHelper failed, so the call was not sent: `;
   - two settings lines in 8c's existing forms (Task 1): `"host" must be true or false, without quotes (got <value>);
     it was left out` and `"headersHelper" must be text in quotes (got <type>); it was left out`.

   **Recommended: as written.**
6. **A refresh whose helper worked but whose new connection failed (Task 11).** The design says waiting calls fail with
   `its headersHelper failed, so the call was not sent: <reason>` "(or the connection's own reason)".
   - (a) The connection's reason alone, such as `http://127.0.0.1:5000 answered 500`, which does not say the call was
     not sent.
   - (b) `its new connection failed, so the call was not sent: <reason>`.

   **Recommended: (b).**
7. **A PreToolUse hook's ask on a box server's call in `never` mode with the network off (Task 7).** 8c puts a hook's
   ask on an MCP call to the user in `never` (choice 47), because the gate asks about such a call there. The gate no
   longer asks about this one.
   - (a) Refused, with `never`'s existing line for a hook's ask (`Not allowed in never mode: a PreToolUse hook asked for
     this call to be approved (<reason>).`), as for the box's own actions.
   - (b) Asked, as in 8c.

   **Recommended: (a).**
8. **The `<url>` in the remote helper questions (Task 8).** 8c's question shows the address with the variables it sends,
   as in `at https://x/mcp (sends TOKEN)`. **Recommended:** the helper questions keep that `(sends ...)` after the
   address, then add `, running its headersHelper on this computer: <helper>` or `, without its headersHelper`.
9. **When `<name>: its headersHelper was not run, as it comes from the project and the sandbox is on.` is said
   (Task 10).** **Recommended:** once per launch, when the server first starts, and again only after a live edit
   restarts it; not at each Reconnect.
10. **The README's new words** (Task 12), approved before that commit.

---

## What was found

**Against the design:**
- The design says "fetch then follows a redirect by itself" ("No redirect with the entry's headers"), but the MCP
  library's own redirect rule already stops that for every transport request (choice 1).
- The design names three lines without giving their words: the network-off line ("one grey line says they can't be kept
  off the web"), the `host` warning ("ignored there with a warning, as `trusted` is") and the helper's failures ("its
  red line says why"). See choices 3, 4 and 5.
- "(or the connection's own reason)", for a refresh whose new connection fails, reads two ways (choice 6).
- "An answer records the setup it was given for" leaves open whether a server keeps one answer or one per setup
  (choice 2).
- The design does not cover a hook's ask on a box server's call in `never` mode (choice 7).
- The design says "Through the same wrapper the box's shell commands use", but that wrapper runs through a `DockerRun`,
  which closes its input after writing it (src/sandbox/docker.ts:61), and it takes only one argument
  (executor.ts:354-356). The plan builds a sibling with the same group and kill (decision 2).
- The design says "The server's roots (MCP `roots/list`) say `/work`", but 8c builds the root's URL with `pathToFileURL`
  (server.ts:389), which on Windows makes `/work` into `file:///C:/work` (decision 8).
- On a connection that signs in, a 401 is claimed by both the design's refresh rule and 8c's sign-in (decision 18).
- The approved line `its headersHelper failed, so the call was not sent: <reason>` does not name the server. The model
  reads it as that tool's result, so it is kept as written.
- The 8c design's "Not in this release" table says `headersHelper` is "Not planned", while 8c's settings line says
  "(planned)". Task 12 updates the table.

**The plan review (an outside review of a8bf7b5, five findings, each checked against the code and the pinned SDK; all
held, and the design was changed to match):**
1. **A failed group kill could leave a box server running in the box** while its `docker exec` on this computer died,
   and a Reconnect would then start a second copy (Task 4 had "failure ignored"). See decision 24.
2. **A connection a refresh replaced was no longer tracked once the refresh had finished,** so a teardown could leave it
   open with a call still draining. See decision 25.
3. **The library resends a request after a 403 with `insufficient_scope`,** running a call twice
   (index.mjs:1754-1764). See decision 26.
4. **Same-origin redirect hops reached the connection's `fetch` as other addresses,** so with sign-in on the entry's
   headers were dropped at `/mcp/`, and a 401 or 403 there started no refresh. See decision 27.
5. **Diagnostics could carry secrets:** a helper's last error line, a start error's whole text, and the redirect
   target's path. See decision 28.

For the builders:
- The kill's failure mapping is executor.ts:360-366.
- The step-up replay: index.mjs:1375 (the option), 1393 (`"throw"`), 1515 (the event stream) and 1754-1764 (a message).
  The SSE `_send` is 1211-1259.
- `InsufficientScopeError` is public-CvV4ZHkX.mjs:175.
- `fetchWithinOrigin` is src-CeKsbNLO.mjs:6854-6876.
- `runHook`'s start failures are hooks/run.ts:71, 79 and 118; answer.ts:109 reads `startError` for hooks' own lines.
- cli.test.ts already runs `-p --json` with MCP servers from a settings file (1412-1440, `homeWith`).

**The second plan review (an outside review of 72951f4, three findings, each checked; all held, and the design was
changed to match):**
1. **Failed-stop records were lost across later slot changes:** `before` reached back one `Server` only, and a removal
   dropped it. Unresolved stops are now kept in `Servers` by name (decision 24).
2. **`BoxState.gone()` is no proof that a box server stopped:** it gives a reason for no docker program and for any
   failed `docker inspect` too (executor.ts:182-187). Only a successful kill, an inspect that says not running, or
   Tachikoma's own successful removal now clears a record (decision 24).
3. **A connection-wide set of redirect targets would give the entry's headers to an unrelated sign-in request** to the
   same path. Headers now follow only one request's own chain, tied by its headers object (decision 27).

For the builders:
- `DockerExecutor.stop`'s `rm -f` result is thrown away today (executor.ts:329-332).
- `fetchWithinOrigin`'s hop call is src-CeKsbNLO.mjs:6862.
- The transports' per-request `_commonHeaders()` calls are index.mjs:1100, 1214, 1476, 1700 and 1826.

**In the code, for the builders:**
- **Local start:** `Server.#transport()` is at src/mcp/server.ts:336-343. It starts through `Stdio` (73-94), which uses
  the library's private `_process` (checked by tests/mcp/library.test.ts). The server's env is `commandEnv` +
  `CLAUDE_PROJECT_DIR` + the entry's. The stop is `#close` (436-447): `KILL_MS` 300 (line 49), then `killTree`. A new
  connection closes the one before it at once (279). The roots handler is at 389.
- **Remote:**
  - OAuth is chosen once, in the constructor, from the static headers (137-139).
  - `toServer` (475-486) puts the headers on the server's own address only when signing in; otherwise they go in
    `requestInit.headers` (349-351).
  - The library merges `requestInit.headers` into each request's headers and sets its own over them (index.mjs:1081,
    1700-1722).
  - A non-OAuth 401 or 403 on a streamable HTTP POST throws `SdkHttpError` with the status (index.mjs:1775-1780); on
    SSE it is a plain `Error` (1252).
- **The library's stdio transport** spawns with `{ ...getDefaultEnvironment(), ...env }` (stdio.mjs:74-80) and writes
  each message with `stdin.write` (stdio.mjs:213-218).
- **Placement today:**
  - `Servers.#slot` (src/mcp/servers.ts:430-444) gives every server `off` when the box's network is off. `Servers.set`'s
    key is at 274, `stopAll` at 420-425, `#begin` at 466-469, and `Offered` at 34-43. The server table is built in
    `#build` (511-574), and `answered` is at 366-369.
  - The launch's line, `mcpLines`, is src/clilib.ts:741-750; the question `serverQuestion` 699-711; `askServers`
    717-735.
  - cli.tsx asks only with the network on (609-618), before the box starts (624), and makes `Servers` after it
    (646-669). `mcpNetwork` is at 587, and a comment at 943 counts the servers starting.
- **Entries** (src/mcp/config.ts): `trusted` is ignored in a project's file at 162; unknown fields are warned about at
  177; `headersHelper` is left out "(planned)" at 147; each kind's own fields are `OWN` at 74; `${VAR}` is filled at
  read (179-191, 281-289).
- **Answers** (src/mcp/answers.ts) are kept by name, the last line winning (39-43), with the entry compared at `get`
  (53-56). `launchAnswers` is at 75-85.
- **Box:** `inGroup` and its kill line are src/sandbox/executor.ts:344-382; `BoxState` is at 162-219, with `gone()` at
  184-188 and `broken` at 163; `NO_DOCKER` is at 121; the sync removal at exit is at 144-148. `Started.box` is the
  `DockerExecutor` (clilib.ts:456-466). Its `DockerRun` is private, so cli.tsx gives `docker`
  (src/sandbox/docker.ts:26).
- **Approval:** `needsApproval` is src/core/permissions.ts:47-55 (MCP always asks); `require` is 276-318;
  `hookCannotAsk` is 252-256, called from src/core/session.ts:1270-1271. `approveOf` is src/mcp/tools.ts:42-49; the
  run's checks are 110-141; only a `NotReached` call is resent (136-138).
- **Hooks:** `shellOf` and `runHook` are src/hooks/run.ts:36-126. `CLAUDE_PROJECT_DIR` is set at 67, and the input is
  written at 124.
- **Tests that read today's network-off rule** and change in Task 6: tests/mcp/servers.test.ts:748-755,
  tests/mcp/search.test.ts:165-175, tests/clilib.test.ts:232-244 (and its `servers` helper at 132), and
  tests/tui/app.test.tsx:12726-12734 (only with `-t`). Task 1 changes tests/mcp/config.test.ts:69, which expects the
  "(planned)" line.
- **The fake servers** are tests/mcp/fake.ts: stdio and HTTP; `whoami`, `stubborn`, `pidFile`; the HTTP log records each
  request's headers and body; and `signInFake`.

---

## Lines this plan adds

These are approved in the design, word for word. `"x"` is the server's name, escaped.

- A local server's question with the sandbox on (`copy` or `live link`; `network off` or `network on`):
  `Start the MCP server "x" from this project's .mcp.json inside the sandbox (copy, network off): <command>? [y/n]`
- A local server's question with the sandbox off:
  `Start the MCP server "x" from this project's .mcp.json on this computer: <command>? [y/n]`
- A remote server's question when its helper runs:
  `Connect to the MCP server "x" from this project's .mcp.json at <url>, running its headersHelper on this
  computer: <helper>? [y/n]`
- A remote server's question with the sandbox on:
  `Connect to the MCP server "x" from this project's .mcp.json at <url>, without its headersHelper? [y/n]`
- A red line's reason: `<command> was not found in the box; if it needs this computer, add "host": true to its entry
  in ~/.tachikoma/settings.json`
- A red line's reason: `the box stopped`
- A call's error, to the model: `its headersHelper failed, so the call was not sent: <reason>`
- A grey line: `<name>: its headersHelper was not run, as it comes from the project and the sandbox is on.`
- A red line's reason, and a call's error: `the server answered with a redirect to <origin>; Tachikoma does not
  follow a redirect with the entry's headers` (the origin only, after the plan review's finding 5; the user approved)
- A red line's reason (the plan review's finding 1; the user approved): `its earlier copy could not be stopped in the
  box (<reason>), so it was not started again`

`<command>` and `<url>` are 8c's text after the colon (with `(sets ...)` and `(sends ...)`; see choice 8). A remote
entry without a helper keeps 8c's question. 8c's -p line is unchanged: `MCP server x from .mcp.json was skipped: -p
starts only the project's servers you said yes to in the window.`

Approved by the user with choices 3-6: the network-off line, the `host` warning, the red lines' new reasons (in the
forms the plan review changed), the two settings lines and the new-connection line. Still to approve: the README
(choice 10).

Gone: `has "headersHelper", which Tachikoma does not run yet (planned)`, and 8c's network-off line.

## The design's tests, and where each is

**Unit tests:**
- The `host` field, read from the user's file and ignored with a warning in a project's: Task 1,
  tests/mcp/config.test.ts.
- Where each server runs, for each sandbox and network setting: Task 6, tests/mcp/place.test.ts and
  tests/mcp/servers.test.ts.
- The approval table with its `never` rows, network off and on: Task 7, tests/core/permissions.test.ts and
  tests/mcp/tools.test.ts.
- The start command (no `-t`, no server value on it, `/work`): Task 3, tests/mcp/box.test.ts; Task 4, the stand-in's
  record.
- The `docker` program's own environment, unchanged by an entry's `DOCKER_HOST` and `DOCKER_CONFIG`: Task 4,
  tests/mcp/box.test.ts.
- The block on the server's input, and the server's environment, line breaks included: Tasks 3 and 4,
  tests/mcp/box.test.ts.
- Roots saying `/work`, the "not found in the box" line, and the stop sequence: Task 4, tests/mcp/box.test.ts.

**The block, in the real box:**
- Written in pieces with pauses between them; written in the same piece as `initialize`; values ending in spaces, tabs
  and line breaks, or with line breaks inside, reaching the server whole: Task 5, tests/sandbox/mcpBox.test.ts.
- A bad name refused before anything starts: Task 4, tests/mcp/box.test.ts; Task 5, tests/sandbox/mcpBox.test.ts.

**Answers:**
- A yes for the box asked again with the sandbox off, and the reverse: Task 2, tests/mcp/answers.test.ts; Task 8,
  tests/clilib.test.ts.
- A yes for a copy with the network off asked again in live link and with the network on, and each of these skipped in
  `-p`: Task 8, tests/clilib.test.ts; Task 6, tests/mcp/servers.test.ts and the `mcpLines` test.
- A remote answer without the helper asked again when the helper would run: Task 8, tests/clilib.test.ts.
- An 8c answer counting as `host`, and the questions' text: Task 2, tests/mcp/answers.test.ts; Task 8,
  tests/clilib.test.ts.

**A stand-in Docker:** start, stop and failure tests without Docker: Task 4, tests/standin/dockerExec.mjs and
tests/mcp/box.test.ts.

**Real Docker tests:**
- A call writing a file that shows in copy mode's review: Task 5, tests/sandbox/copy.test.ts.
- The server starting with the network off, and a stop killing it inside the box: Task 5,
  tests/sandbox/mcpBox.test.ts.

**Helper tests:**
- Good output; the merge with static headers, letter case included: Task 9, tests/mcp/helper.test.ts; Task 10,
  tests/mcp/server.test.ts.
- A failing exit, the time running out, bad output: Task 9, tests/mcp/helper.test.ts.
- `Authorization` turning off sign-in, sign-in chosen per connection, and the headers kept from the sign-in service:
  Task 10, tests/mcp/auth.test.ts.
- A redirect with the entry's headers, static and the helper's, with sign-in and without, failing with nothing sent to
  the new address: Task 10, tests/mcp/server.test.ts and tests/mcp/auth.test.ts.
- A 401 or 403 failing its call, sent once only, with the helper run again, the next call on the new connection, and a
  tool changed there refused: Task 11, tests/mcp/server.test.ts and tests/mcp/tools.test.ts.
- Two calls at once, one answered 403 and the other finishing on the old connection, with one refresh and a third call
  on the new connection: Task 11, tests/mcp/server.test.ts.
- A failed refresh failing the waiting calls at once while a call in flight finishes: Task 11, tests/mcp/tools.test.ts
  and tests/mcp/server.test.ts.
- A removal, a restart, a Reconnect and an exit mid-refresh, and a late refresh thrown away: Task 11,
  tests/mcp/servers.test.ts, tests/mcp/tools.test.ts and tests/mcp/server.test.ts.
- The helper's two variables, and credential-looking names removed from a project's helper: Task 9,
  tests/mcp/helper.test.ts.
- A project's helper with the sandbox on, not run: Task 10, tests/mcp/servers.test.ts.

**The plan review's tests** (in the design's "Testing" since the plan review):
- A failed in-box kill, then a Reconnect whose retried stop fails or succeeds, and the same for a live edit's restart:
  Task 4, tests/mcp/box.test.ts and tests/mcp/servers.test.ts.
- Teardown while a call drains on a retiring connection: Task 11, tests/mcp/server.test.ts and tests/mcp/tools.test.ts.
- A 403 `insufficient_scope` with sign-in on, failing its call, sent once, with one refresh: Task 11,
  tests/mcp/auth.test.ts.
- `/mcp` to `/mcp/` hops, with sign-in on and off: Task 10, tests/mcp/server.test.ts and tests/mcp/auth.test.ts.
- No secret in screen lines, `--json` events or a tool error: Task 9, tests/mcp/helper.test.ts; Task 10,
  tests/cli.test.ts; Task 11, tests/mcp/tools.test.ts.

**The second plan review's tests:**
- A fails, B blocked, an edit to C still blocked, starting once the retry works; A fails, the entry removed and added
  back, still blocked until the retry works: Task 4, tests/mcp/servers.test.ts.
- An inspection that fails keeping the record, the retry kill running before any new start once Docker recovers, and a
  confirmed stop clearing it: Task 4, tests/mcp/box.test.ts and tests/sandbox/executor.test.ts.
- A `/mcp` to `/mcp/` chain getting the headers, a later sign-in request to `/mcp/` getting none, and a later MCP
  request getting them on its own chain, with sign-in on and off: Task 10, tests/mcp/server.test.ts.

**The user's terminal checklist:** Task 12.

---

## Task 1: `host` and `headersHelper` in an entry

**Files:** src/mcp/config.ts, tests/mcp/config.test.ts. Holds choice 4 and choice 5's two settings lines. Decision 9.

**Tests first** (tests/mcp/config.test.ts; the test at line 69 loses its `headersHelper` expectation):
- `"host": true` in the user's file sets `host`; `false` leaves it unset; `"yes"` is left out with choice 5's line.
- `host` on a remote entry is passed over, with no line and no `host`.
- `headersHelper` is read into the entry and `asWritten` with `${VAR}` unfilled; a number is left out with choice 5's
  line; on a local entry it is passed over.
- In `.mcp.json`, `host` of any value is ignored with choice 4's line, and the server is kept without `host`.

**Implementation:**
- `ServerConfig` gains `host?: true`. The remote `ServerEntry` and the remote form of `asWritten` gain
  `headersHelper?: string`.
- `OWN` (config.ts:74): `host` joins the stdio fields, so a remote entry passes it over.
- Delete the "(planned)" line (147).
- In `serverOf`'s stdio branch:
  - in a project's file, `host` of any value is ignored with choice 4's line, given through `say`, as `trusted` is
    (162);
  - in the user's file, a value that is not true or false is left out with `badValue("host", ...)`;
  - `true` sets `host`.
- In the remote branch, `headersHelper` must be text (`bad("headersHelper", TEXT, ...)`) and is copied as written,
  unfilled, into `entry` and `asWritten`.

**Run:** `tests/mcp/config.test.ts`; types.

**Commit:** `feat: 8c-2a: "host" and "headersHelper" in a server's entry`

## Task 2: An answer records its setup

**Files:** src/mcp/answers.ts, tests/mcp/answers.test.ts. Holds choice 2 (b). Decision 11.

**Tests first:**
- An answer counts only for its own setup: a yes for `box copy network off` is no answer for `host`, for the other box
  setups or for none, here and for the next `answersFor`.
- Two setups keep their own answers (choice 2 (b)), and a reset forgets both.
- A line without a setup counts for `host` and for none, never for a box setup or `helper`; a newer `host` answer wins
  over it.
- `launchAnswers` keeps answers by setup in the same way.

**Implementation:**
- `Answers` becomes
  `get(name, entry, setup?: string)`, `set(name, entry, yes, setup?: string)`, `reset(name)`.
  Callers pass no setup until Task 6.
- A line gains `setup` when it is text (`parse`).
- One keeper, shared by `answersFor` and `launchAnswers`, holds each name's answers by setup, with "" for none, which is
  also what an 8c line has. `get` falls back to "" for a `host` lookup when there is no `host` answer. `reset` forgets
  every setup of a name.
- `set` appends `{ name, entry, yes, setup }` (setup left out when none).

**Run:** `tests/mcp/answers.test.ts`; types.

**Commit:** `feat: 8c-2a: a project server's answer holds the setup it was given for`

## Task 3: The box's start command and the variables block

**Files:** create src/mcp/box.ts and tests/mcp/box.test.ts; modify src/sandbox/executor.ts. Decisions 2 and 3.

**Tests first** (tests/mcp/box.test.ts):
- `envBlock` gives the exact bytes for values with trailing spaces, tabs, a line break inside and an empty value, and a
  single NUL for no variables.
- `envBlock` refuses `BAD-NAME`, `9LIVES` and `A=B`, naming the first bad name.
- `execArgs` starts with `exec -i -w /work <id> bash -c`, never has `-t`, and ends with
  `_ INNER <command> <args...>`, the arguments as given.
- The outer script writes and removes the group's file and its `.stop` file.
- `INNER` reads with `IFS= read -r -d ''`, looks the command up after its exports, and prints `NOT_FOUND`.
- `killLine` gives inGroup's exact line.
- `killInBox(run, "b0x", group)` (decision 24), with a stand-in `DockerRun`, gives:
  - `undefined` for exit 0;
  - `no docker program is on PATH any more` for `"missing"`;
  - `Error: boom` for exit 1 with that error output;
  - `the box stopped` for exit 1 with none;
  - the message for a rejection.
- inGroup's existing Esc tests in tests/sandbox/executor.test.ts pass unchanged.

**Implementation:**
- executor.ts: export `killLine(group: string): string`, the kill line inGroup builds today (executor.ts:361), and
  `killInBox(run: DockerRun, id: string, group: string): Promise<string | undefined>`, the mapping at 362-365. inGroup
  uses both.
- box.ts has these exports:
  - `McpBox`: `{ id: string; kind: "live" | "copy"; state: BoxState; run: DockerRun; program?: { file: string; args:
    string[] } }`. Tasks 4-8 share this shape.
  - Constants: `BOX_WORK` (`/work`), `BOX_ROOTS` (`file:///work`), `BOX_STOPPED` (`the box stopped`) and `NOT_FOUND`
    (`tachikoma: not found`).
  - `envBlock(env): { block: Buffer } | { bad: string }`: each entry as `NAME=VALUE` followed by a NUL, then one more
    NUL. Names must match `[A-Za-z_][A-Za-z0-9_]*`; the first that does not is returned as `bad`. NUL is built with
    `String.fromCharCode(0)`, as config.ts does.
  - `INNER`: the inner script (decision 2).
  - `execArgs(id, group, command, args)`: `["exec", "-i", "-w", "/work", id, "bash", "-c", <outer(group)>, "_", INNER,
    command, ...args]`. `outer` is inGroup's wrapper with `"$@"` in place of its one argument.
  - `groupFile()`: as inGroup's, `/tmp/tachikoma-<uuid>`.
  - `dockerProgram(env)`: `onPath("docker", env)` as `{ file, args: [] }`.
  - `notFoundLine(command)`: the design's line.
  - `badNameLine(name)`: choice 5's line.

**Run:** `tests/mcp/box.test.ts`, `tests/sandbox/executor.test.ts`; types.

**Commit:** `feat: 8c-2a: the box server's start command and its variables block`

## Task 4: A server started in the box, against a stand-in Docker

**Files:**
- src/mcp/server.ts, src/mcp/servers.ts (`stopAll`, `#unstopped`), and src/sandbox/executor.ts (`BoxState.removed`,
  `stopped()`; tests/sandbox/executor.test.ts gains their tests with its stand-in `DockerRun`);
- create tests/standin/dockerExec.mjs;
- tests/mcp/fake.ts (`show`, the `write` tool, `standinBox`), tests/mcp/box.test.ts, and tests/mcp/server.test.ts
  and tests/mcp/servers.test.ts (their tool lists gain `write`; servers.test.ts gains the live edit's failed-kill
  tests).

Holds choice 5's first two reasons and the plan review's line. Decisions 1, 3-8 and 24.

**Tests first** (tests/mcp/box.test.ts, through the stand-in):
- The start command has `exec -i -w /work b0x`, no `-t`, and no entry value anywhere in its arguments.
- The docker program gets the session's `DOCKER_HOST` and `DOCKER_CONFIG`, never the entry's, and no provider key.
- The server gets the entry's variables whole (a line break inside and a trailing tab), and `CLAUDE_PROJECT_DIR=/work`.
- `roots/list` answers `file:///work`.
- A command the box lacks fails with `notFoundLine`.
- A name such as `ProgramFiles(x86)` fails with `badNameLine`, and the stand-in records no start.
- Stopping a server that ends at its input's close runs nothing in the box.
- Stopping a stubborn one runs `killLine(<its group>)` through the box's `DockerRun`, and its process ends.
- `stop({ exit: true })` on a stubborn one runs nothing in the box, and its `docker exec` ends.
- A failed kill (decision 24): a stubborn server is stopped while the stand-in's kill answers exit 1 with
  `Error: boom`. Then `restart` is called (as `/mcp` Reconnect does):
  - the retried kill fails too: the server is `failed: its earlier copy could not be stopped in the box (Error:
    boom), so it was not started again`, and the stand-in records no second start;
  - the retried kill succeeds: the stand-in records exactly one second start, and the server is ready.
- In tests/mcp/servers.test.ts (decision 24, kept by name):
  - A's stop fails, so B (a live edit's restart) is blocked with the line. A second edit makes C: C is still blocked,
    with the stand-in's kill run again first. Once the stand-in's kill works, the next Reconnect starts exactly one
    copy.
  - A's stop fails; the entry is removed by a live edit, then added back. The new copy is blocked until the kill
    works, then exactly one starts.
- What confirms a stop (decision 24):
  - the kill fails and `inspect` fails as an unreachable daemon would (exit 1, `Cannot connect to the Docker daemon`):
    the record is kept;
  - Docker then recovers with the old copy still running (`inspect` prints `true`). On the next Reconnect, the
    recorded calls show the kill run before the stand-in records any new start;
  - `inspect` exiting 0 with `false` clears the record without a kill, and one copy starts;
  - after `DockerExecutor.stop`'s `rm -f` exits 0 (`BoxState.removed`), the record is cleared;
  - no docker program (`"missing"`) keeps the record.
- tests/sandbox/executor.test.ts: `BoxState.stopped()`, given a stand-in `DockerRun`:
  - true after a `DockerExecutor.stop` whose `rm -f` exited 0;
  - false after one whose `rm -f` exited 1;
  - true for `inspect` exit 0 with `false`;
  - false for `true`, for exit 1 and for `"missing"`.
- A box server ending while `gone` says the box is missing shows `stopped: the box stopped` (retry false); after
  `BoxState.fail`, a new start fails with `the box stopped`.

**Implementation:**
- `BoxStdio extends Stdio`, given the block and its group's file. `start()` awaits `super.start()`, then writes the
  block to the child's stdin.
- `Server` options gain `box?: McpBox`.
- `#transport` sends a stdio entry with a box to a new `#inBox(entry)`. It refuses a broken box (`BOX_STOPPED`) and a
  bad name (`badNameLine`), and fails with `NO_DOCKER` when there is no docker program. Otherwise it builds `BoxStdio`
  with:
  - `command` set to the program's file;
  - `args` set to the program's arguments plus `execArgs(...)`;
  - `env` set to `commandEnv(this.#env)`;
  - `cwd` set to the root;
  - stderr piped;
  - the block made from `CLAUDE_PROJECT_DIR=/work` and then the entry's env.
- The roots handler (server.ts:389) gives `BOX_ROOTS` for a box server.
- `client.onclose`, for a `BoxStdio`, asks `BoxState.gone()`, then calls `#dropped` with `BOX_STOPPED` or `exitReason`.
- `#startReason` gives `notFoundLine(command)` when a `BoxStdio`'s process exited 127 and its last error line is
  `NOT_FOUND`.
- `stop(opts: { exit?: boolean } = {})`, and `#close(conn, exit)`. For a box server:
  - without `exit`: race the process's exit against `KILL_MS`, then, if it is still alive, run `killInBox` through
    `McpBox.run`, then `killTree`. A kill that fails is pushed onto the name's `unstopped` record as
    `{ group: string; reason: string }` (decision 24);
  - with `exit`: `killTree` at once, with nothing run in the box.

  Host servers are unchanged.
- `Server` options gain `unstopped?: { group: string; reason: string }[]`, its name's record, which `Servers` owns.
  The first step of `#connect`, for every entry in it:
  - first asks `BoxState.stopped()`; a `true` deletes the entry;
  - otherwise runs `killInBox` again; exit 0 deletes the entry, and a failure updates its reason.

  Any entry left leaves the state `failed` with the approved line (the latest reason), and nothing starts.
- `Servers` keeps `#unstopped: Map<string, { group: string; reason: string }[]>` by name. Each new `Server` for a name
  gets that name's list, in `#slot` (430-444), so `set`'s restarts and re-adds and `restart` all share it. A list is
  dropped only when it is empty.
- src/sandbox/executor.ts (also in this task's files):
  - `BoxState` gains `removed` (set by `DockerExecutor.stop` when its `rm -f` exits 0) and `stopped()`. `stopped()` is
    `removed`, or `inspect` exiting 0 with `false`, as decision 24 says.
  - `gone()` is unchanged: it still only picks the reason a server's end shows (decision 7).
- `Servers.stopAll` calls `stop({ exit: true })`.
- Stand-in (`dockerExec.mjs`): node runs it as `[script, recordFile, ...docker's args]`.
  - It records its arguments and its own environment.
  - It reads the block NUL by NUL from stdin.
  - It spawns the command after `_ INNER` with its own environment plus the block's variables, piping the rest of stdin
    to it.
  - It records the child's pid, and exits with the child's code.
  - A spawn error prints `tachikoma: not found` and exits 127; stdin ending before the block's end exits 2.
- fake.ts:
  - `show?: string[]`: `whoami` also reports these variables under `env`.
  - A `write` tool writes `args.path` under the server's working folder.
  - `standinBox(dir, { kind?, gone? })` gives `{ box, calls, started(), kills }`. Its `DockerRun` records each call
    and answers `inspect` as running, unless `gone` gives Docker's words. The in-box kill kills the recorded child
    pid, unless the test has queued a failure in `kills` (an exit code and error output), which it answers instead.
    `inspects`, a queue like `kills`, sets `inspect`'s answers: running, stopped (exit 0, `false`), unreachable
    (exit 1) or `"missing"`.

**Run:** `tests/mcp/box.test.ts`, `tests/mcp/server.test.ts`, `tests/mcp/servers.test.ts`; types.

**Commit:** `feat: 8c-2a: a local server started inside the box, its variables over its input`

## Task 5: The box server in real Docker

**Files:** create tests/sandbox/mcpBox.test.ts; modify tests/sandbox/copy.test.ts (one test). There is no source
change unless a test shows the wrapper is wrong. In that case the builder fixes src/mcp/box.ts, adds a stand-in test of
the fix where Docker is not needed, and says in the commit what the box did.

**Tests first:**
- The block written in three pieces with pauses between them, then `initialize`: the server answers id 1.
- The block and `initialize` written in one piece: the server answers id 1.
- Through `Server`, values ending in a space, tab and line break, a value with a line break inside, a value with leading
  spaces and an empty value all reach `whoami` whole; `CLAUDE_PROJECT_DIR` and the working folder are `/work`.
- A bad name fails with `badNameLine`, and no process of the fake runs in the box.
- `tachi-no-such-server` and `C:\tools\server.exe` each fail with `notFoundLine`.
- With the box's network off, a fake starts (ready), and a stop of a stubborn fake leaves no fake process in the box.
- In copy.test.ts, with copy mode's `launch()`: a box server's `write` call makes `made.txt` in the copy. The box's
  `git status --porcelain` shows only `?? made.txt`, and the real project folder lacks it.

**Implementation:**
- In tests/sandbox/mcpBox.test.ts:
  - `realBox(ctx)`, as tests/sandbox/boxWorkspace.test.ts's: the test's own folder mounted at /work, the network off,
    the box labelled and removed. `processes(box)` as executor.test.ts's.
  - An `McpBox` of `{ id, kind: "live", state, run: docker }`.
  - The fakes are written into the mounted folder and run as `node /work/<file>`.
  - The describe has `{ timeout: 0 }`, as the other real Docker tests do.
- For the raw-stream tests, spawn the docker program on PATH with `execArgs(...)`, write the pieces and then
  `initialize` as one JSON line, and read the first answer. The pause between pieces is 200 ms: the test's own,
  long beside a pipe's delivery, not a product number.
- These tests are the measurement the design asks for ("checked by the tests below, not assumed").

**Run:** `tests/sandbox/mcpBox.test.ts`, `tests/sandbox/copy.test.ts`, with Docker running (they skip without it; say
so).

**Commit:** `test: 8c-2a: the box server's block, stop and writes in real Docker`

## Task 6: Where each server runs, and what starts

**Files:**
- create src/mcp/place.ts and tests/mcp/place.test.ts;
- modify src/mcp/servers.ts, src/clilib.ts (`mcpLines`), and src/cli.tsx (the box given to `Servers`, 646-669);
- update the tests that read the old rule: tests/mcp/servers.test.ts:748-755, tests/mcp/search.test.ts:165-175,
  tests/clilib.test.ts:132 and 232-244, and tests/tui/app.test.tsx:12726-12734.

Holds choice 3. Decision 10.

**Tests first:**
- place.test.ts:
  - with no sandbox, every server runs on this computer and starts;
  - with the sandbox on, a local server is a box server unless the user's entry says `host`;
  - with the network off, only box servers start; with it on, all start;
  - `helperRuns` for a user entry in every setup, and for a project's entry only with no sandbox;
  - `answerSetup` gives the five local setups, the helper's two and none.
- servers.test.ts:
  - with the network off, a box server is ready through the stand-in, and a `host` one and a remote one are `off`;
  - with the network on, all are ready;
  - `boxNetwork` is set on the box server's tools only;
  - a project's box server reads its answer for `box copy network off` and waits for a yes;
  - a live edit that adds `host` restarts the server on this computer, and the stand-in records no second start.
- search.test.ts: the user server gets `host: true`; the states become `off, waiting for your yes, you said no`, still
  with no `tool_search`.
- app.test.tsx (run with `-t`): the off row is unchanged, the server given `host: true`.
- clilib.test.ts:
  - with the network off, choice 3's line, then the -p skip line for the project's no and unanswered servers;
  - nothing in the window when nothing is off;
  - no line with no servers.

**Implementation:**
- place.ts (shared with Tasks 7-10):
  - `type McpSandbox = { kind: "live" | "copy"; network: "on" | "off" } | null`.
  - `placeOf(c, s): "box" | "host" | "remote"`: remote for a remote entry; box with a sandbox unless `c.host`;
    otherwise host.
  - `starts(c, s)`: false only with the box's network off for a host or remote server.
  - `helperRuns(c, s)`: a remote entry with a helper, from the user's file, or from a project's with no sandbox.
  - `answerSetup(c, s)`: as decision 11.
- `Servers`:
  - options gain `box?: McpBox`. The constructor throws when the network is not "none" and no box is given. It keeps
    `#sandbox`, built from the box's kind and the network.
  - `#slot` (430-444): `starts` decides `off`; a project's answer is read with `answerSetup`; a box server's `Server`
    gets `box`.
  - `set`'s key (274) gains `c.host === true`, and `answered` (366-369) passes the setup.
  - `Offered` gains `boxNetwork?: "on" | "off"`, set in `#build` for a box server's tools.
- `mcpLines`: choice 3's line once when any server is `off`, then, in -p, 8c's skip lines (which now follow it rather
  than being replaced by it).
- cli.tsx: an `mcpBox` made from `box.box.id`, `sandbox`, `box.box.state` and `docker` (imported from
  `./sandbox/docker.js`), given to `Servers` when the sandbox is on.

**Run:** the five test files (app.test with `-t "sandbox's network"`); types.

**Commit:** `feat: 8c-2a: local servers start in the box, and the box's network decides what starts`

## Task 7: Approval for a box server's call

**Files:** src/core/permissions.ts, src/mcp/tools.ts (`approveOf`), src/core/session.ts (1270-1271),
tests/core/permissions.test.ts, tests/mcp/tools.test.ts. Holds choice 7 (a). Decision 12.

**Tests first:**
- permissions.test.ts: the `needsApproval` table gains the boxed rows: `never` false; `ask`, `project` and `auto` true.
- A boxed `require` in `never`, in the window and headless, asks nothing.
- `hookCannotAsk` on a boxed MCP call in `never` gives `never`'s hook line.
- tools.test.ts, through the stand-in box:
  - network off, `never`: runs unasked, in the window and in -p;
  - network on, `never`: asks in the window (yes runs) and is refused in -p;
  - network off, `auto`: the judge sees `outside: false` and `boxed: true`;
  - network off, `ask` and `project`: each asks once;
  - a hook's ask on a boxed call in `never` is refused with `never`'s line, and the server never sees the call.

**Implementation:**
- `Action` gains `boxed?: boolean`.
- `needsApproval` (47-55): an MCP call needs approval unless the mode is `never` and the call is `boxed`. The `Mode`
  comment at the top gains the exception.
- `hookCannotAsk(reason, mcp = false, boxed = false)`: `never` refuses unless `mcp` is true and `boxed` is false.
- `approveOf` gives `outside: o.boxNetwork === undefined`, and `boxed: true` when `o.boxNetwork === "off"`.
- session.ts: find the offered MCP tool once, and pass `offered.boxNetwork === "off"` as `boxed`.
- tools.test.ts's `setup`: `make` and `ready` take extra `Servers` options (`network`, `box`, and later `settingsDir`).

**Run:** `tests/core/permissions.test.ts`, `tests/mcp/tools.test.ts`, `tests/core/session.test.ts`; types.

**Commit:** `feat: 8c-2a: in never mode a box server's call runs unasked while the box's network is off`

## Task 8: The project's questions, and the launch

**Files:** src/clilib.ts (`serverQuestion` 699-711, `askServers` 717-735), src/cli.tsx (587, 609-618, 943),
tests/clilib.test.ts (136-230). Holds choice 8.

**Tests first** (the existing `serverQuestion` calls get `null`; their local lines gain ` on this computer`):
- The local question names `copy, network off` and `live link, network on`.
- The remote question runs its helper on this computer with no sandbox, and goes without it with the sandbox on, both
  keeping `(sends TOKEN)`, with an escape code in the helper shown escaped.
- One project, `askServers` run in turn with no sandbox, the same again, copy with the network off, live link with it
  off, copy with it on, then no sandbox again:
  - each new setup is asked once;
  - the remote server is not asked while the network is off, and is asked again `without its headersHelper` with the
    network on;
  - the last run asks nothing (choice 2 (b)).
- An 8c answer line (no setup) counts on this computer and is asked again for live link with the network on.

**Implementation:**
- `serverQuestion(c, sandbox: McpSandbox)` gives the design's four questions.
  - A local server: ` on this computer`, or ` inside the sandbox (<copy | live link>, network <on | off>)`, before the
    colon.
  - A remote server with a helper: 8c's address text with its `(sends ...)`, then the helper part chosen by
    `helperRuns`, the helper escaped with `visible`.
  - A remote server without a helper: unchanged.
- `askServers(configs, sandbox, answers, ask, failed)` asks only project servers that `starts`, and gets and sets each
  answer with `answerSetup`.
- cli.tsx:
  - `mcpSandbox` is made after `mcpNetwork` (587);
  - the questions are asked whenever the window is interactive, whatever the network (609), with `mcpSandbox`;
  - the comments at 584-587, 603-608, 643-645 and 943 say the new rule.

**Run:** `tests/clilib.test.ts`, `tests/cli.test.ts -t "MCP"`; types.

**Commit:** `feat: 8c-2a: a project server's question says where it runs, and is asked again for another setup`

## Task 9: Running a headersHelper

**Files:** create src/mcp/helper.ts and tests/mcp/helper.test.ts; modify src/hooks/run.ts and tests/mcp/fake.ts
(`fakeHelper`). Holds choice 5's helper reasons. Decisions 13, 15 and 28.

**Tests first** (each test in a folder of its own, removed as tests/hooks/run.test.ts's `folder()` removes its own):
- It gives the headers it printed, run in the folder given, with both variables and `CLAUDE_PROJECT_DIR` set to the
  root.
- A project's helper gets none of `GH_TOKEN`, `my_secret`, `DB_PASSWORD`, `API_KEY_2` or `AUTH_URL`, only `PLAIN`; the
  user's gets them all.
- Exit 3 gives `it exited with code 3`, though the helper printed `no token today sk-fake-secret-1` on its error
  output: the reason holds no part of it (decision 28). A list gives the not-an-object reason, and so does a value that
  is not text.
- A helper whose folder does not exist (`cwd` a missing folder, so spawn fails) gives `it could not start (ENOENT)`.
- `Bad Name` gives the header-name reason; a value with a line break gives the line-break reason.
- A slow helper with `limitMs` 500 gives `it did not finish within 0.5 s`. The 500 ms is the test's own, so the test
  does not wait the real 10 s.
- An aborted signal rejects with `Cancelled`.
- `mergeHeaders` replaces `authorization` with the helper's `Authorization` and keeps the others.

**Implementation:**
- run.ts: `shellOf` and `runHook` take `Pick<Hook, "command" | "args" | "shell">`. `runHook`'s input becomes
  `object | undefined` (stdin ended with nothing), and its options gain `projectDir`, used for `CLAUDE_PROJECT_DIR`
  (67), and `Ran` gains `startCode` (decision 28): the error's `code` at 79 and 118, `ENOENT` at 71.
- helper.ts exports:
  - `HELPER_MS = 10_000`, Claude Code's documented limit, cited from the design.
  - `runHelper(command, { name, url, cwd, root, env, project, signal?, limitMs? })`, which gives
    `{ headers } | { reason }`.
    - It sets `CLAUDE_CODE_MCP_SERVER_NAME` and `CLAUDE_CODE_MCP_SERVER_URL`, and, for a project's helper, removes the
      credential-looking names.
    - It runs through `runHook({ command }, undefined, ...)`, its `limit` in seconds.
    - It turns each failure into choice 5's `<why>`, from the exit code or `startCode` only, never the helper's
      output or error text; and it checks the output: a JSON object of text values; names that are
      HTTP tokens; values with no line break or NUL.
  - `mergeHeaders(fixed, given)`: the helper's headers over the static ones, letter case aside.
- fake.ts: `fakeHelper(dir)` gives `{ command, runs(), give(headers), mode(m), hold(), go(), headersFile }`.
  - It is a node script. Its command line uses single quotes for Git Bash or sh, or `&` with single quotes for Windows
    PowerShell when `gitBash()` finds none.
  - Each run records its working folder, its two variables, `CLAUDE_PROJECT_DIR` and its variables' names.
  - It prints the headers file, unless its mode file says:
    - `fail`: exit 3, printing `no token today sk-fake-secret-1` on stderr;
    - `bad`: print a list;
    - `slow`: never end;
    - `wait <mode>`: wait until the `.go` file exists (looked for every 20 ms), then act as `<mode>`.

**Run:** `tests/mcp/helper.test.ts`, `tests/hooks/run.test.ts`; types.

**Commit:** `feat: 8c-2a: running a remote entry's headersHelper as Claude Code runs it`

## Task 10: The helper at each connection, sign-in per connection, and no redirect elsewhere

**Files:** src/mcp/server.ts, src/mcp/servers.ts (the `helper` option, `settingsDir`, the grey line in `#begin`),
tests/mcp/fake.ts (`redirect`, `slash`; `signInFake`'s `slash`), tests/mcp/server.test.ts, tests/mcp/auth.test.ts,
tests/mcp/servers.test.ts, tests/cli.test.ts (the secrets test). Holds choices 1 (b), 5 and 9. Decisions 14, 16, 17, 22,
27 and 28.

**Tests first:**
- server.test.ts:
  - the helper runs at each connection, and its `x-key` beats a static `X-Key`, the other static header kept; the second
    connection carries the helper's new value;
  - a failing helper leaves the server `failed: its headersHelper failed: it exited with code 3`;
  - an entry whose helper is not run connects with its static headers, and the helper records no run;
  - a redirect to another origin, with static headers and with the helper's, fails with the approved line, naming
    only the other server's origin, and the other server's log is empty;
  - a redirect within the origin is followed when the method is kept (choice 1 (b));
  - hops without sign-in (decision 27): `slash` answers `/mcp` with a 307 to `/mcp/`, and the fake's log at `/mcp/`
    shows the helper's and the static headers. A hop from `/mcp/` to another origin still fails with the redirect
    line, with nothing sent there. (That a 403 or 401 at `/mcp/` starts the refresh is tested in Task 11, which adds
    `denyTool` and `tokenFile`.)
  - `connectionFetch` alone, against a `slash` fake, with sign-in on and off (decision 27, one chain per request):
    - a call for `/mcp` with headers object H is answered 307; the library's hop, a call for `/mcp/` with H, carries
      the entry's headers when signing in, and `answered` hears its status, in both modes;
    - a later call for `/mcp/` with another `init` (as a sign-in request is) carries none of the entry's headers, and
      `answered` hears nothing;
    - a later call for `/mcp` with a new headers object H2 that redirects again gets the headers on its own hop,
      while a call with H2 for any path H's chain had and H2's did not is not a hop.
- auth.test.ts (using `signInFake`, with `settingsDir` given):
  - a helper that gives `Authorization` never signs in, and fails `answered 401` with no sign-in request;
  - after `restart`, the same helper with no `Authorization` signs in (`needs sign-in`);
  - the helper's `X-Region` went only to `/mcp`, never to the sign-in service;
  - a redirect elsewhere on a connection that signs in fails with the approved line, with nothing sent there;
  - hops with sign-in on (`signInFake`'s `slash`: `/mcp` answered with a 307 to `/mcp/`, its MCP endpoint at
    `/mcp/`): after sign-in, the requests at `/mcp/` carry the helper's and the static headers, and the sign-in
    service's requests carry none.
- cli.test.ts, `-p --json` with `homeWith` settings (decision 28), two remote servers:
  - one whose helper exits 3 after printing `sk-fake-secret-1` on stderr;
  - one whose fake redirects to another origin at `/sk-fake-secret-2/mcp?token=sk-fake-secret-3`.

  Neither secret is in stdout (every JSON event, `mcp-note` and the failures among them) or in stderr. Each failure
  line is there, with `it exited with code 3` and the other origin alone.
- servers.test.ts: with the sandbox on, the user's helper runs in its settings folder, a project's does not run, and
  choice 9's line is said exactly once.

**Implementation:**
- `Server` options gain `helper?: { cwd: string; project: boolean }`, present when the helper runs. `Servers` gives it
  from `helperRuns`, with the folder from its new `settingsDir` option (default `settingsDir()`) for the user's entry,
  or the root for a project's.
- The constructor makes `McpAuth` as decision 16 says. A `hasAuthorization(headers)` helper replaces the inline test at
  137.
- `Conn` gains `signs` and `helped`.
- `#prepare(signal)` gives `{ headers, signs, helped } | <reason>`: it runs the helper when given, prefixes a failure
  with `its headersHelper failed: `, merges the headers, then decides `signs`.
- `#connect`:
  - it closes the previous connection as today;
  - it counts `#stops`, and keeps an `AbortController` for the helper, which `stop()` aborts;
  - it awaits `#prepare`, and returns without connecting if a stop came meanwhile, or fails with the reason;
  - it then makes the transport from what `#prepare` gave.
- `#transport(prepared, conn)`: with sign-in, `{ authProvider, fetch }`; without it, `{ requestInit: { headers }, fetch
  }`. In both, `fetch` is `connectionFetch(...)`.
- `connectionFetch({ url, endpoint, headers, signs, answered })` replaces `toServer` (475-486):
  - the same own-address rule;
  - with sign-in, it adds the headers on the server's own address;
  - it sends `redirect: "manual"` on a request carrying headers;
  - a 301/302/303/307/308 with a `Location` at another origin throws `Redirected` with the approved line (the origin
    alone, decision 28), after cancelling the body;
  - a same-origin `Location` answering a request for its own address, or a hop of one, is added to that request's
    chain: a `WeakMap<object, Set<string>>` keyed by the request's own `init.headers` object, holding origin and path.
    A later call with the same headers object, for a path in its set, is a hop of that request: with sign-in the
    headers go on it, and its status is reported. Any other call to that path gets neither (decision 27). A call with
    no headers object is never a hop;
  - it calls `answered(status)` for its own address and its chains' hops. Task 11 fills that in; here it is an empty
    method;
  - `connectionFetch` is exported, for its unit tests.
- `#startReason` returns a `Redirected` found in the error's cause chain.
- The sign-in checks at 205, 237, 314 and 405 read `conn.signs`.
- `Servers.#begin` (466-469) says choice 9's grey line, once per slot, for a project's remote entry whose helper does
  not run.
- fake.ts:
  - `redirect?: string` answers every POST with a 307 to that address;
  - `slash?: true` answers a POST to `/mcp` with a 307 to `/mcp/`, and serves `/mcp/`;
  - `signInFake` gains the same `slash`, its MCP endpoint then at `/mcp/`.

**Run:** `tests/mcp/server.test.ts`, `tests/mcp/auth.test.ts`, `tests/mcp/servers.test.ts`, `tests/mcp/forms.test.ts`,
`tests/cli.test.ts -t "MCP"`; types.

**Commit:** `feat: 8c-2a: the headersHelper at each connection, sign-in per connection, no redirect elsewhere`

## Task 11: A 401 or 403 refreshes the connection

**Files:** src/mcp/server.ts, src/mcp/tools.ts, tests/mcp/fake.ts (HTTP options), tests/mcp/server.test.ts,
tests/mcp/tools.test.ts, tests/mcp/servers.test.ts, tests/mcp/auth.test.ts (and `signInFake`'s `scope403`). Holds
choice 6 (b). Decisions 18-21, 23, 25 and 26.

**Tests first** (the helper held with `hold()` and `wait`, so each refresh is caught while it runs):
- server.test.ts:
  - with the server's token turned, a call answered 401 fails, is sent once, and the helper runs again; the next call
    goes with the new token; `connection` stays 1;
  - two calls answered 403 at once start one refresh (two helper runs in all); a `wait` call in flight is answered on
    the old connection after the switch; a later call goes on the new one;
  - a refresh whose helper fails resolves `failed` (helper true), the server is `failed` with choice 5's line, and the
    call in flight still finishes;
  - a stop while the helper waits resolves `dropped`, and no new `initialize` comes;
  - a stop while the new connection's `initialize` is held resolves `dropped`, with no `tools/list` after it and the
    state as the stop left it;
  - teardown while a call drains (decision 25): the refresh ready, a `wait` call still running on the old connection,
    then `stop()`: the old connection closes (its log shows no request after it), and the `wait` call rejects rather
    than staying open;
  - hops (decision 27, with Task 10's `slash`): a `denyTool` 403 at `/mcp/` starts one refresh, and so does a 401
    there from a turned `tokenFile`.
- auth.test.ts:
  - on a connection that signs in, an expired token's 401 gives `needs sign-in`, and the helper is not run again;
  - decision 26: `signInFake`'s `scope403` answers one `tools/call` with 403 and `WWW-Authenticate: Bearer
    error="insufficient_scope", scope="more"`. With sign-in on and the helper giving `X-Region`, that call fails. The
    fake's log shows that call once only, no new `/authorize` or `/token` request follows, and the helper runs once
    more (one refresh); the next call succeeds on the new connection;
  - hops with sign-in (Task 10's `slash`): a 403 at `/mcp/` starts one refresh.
- tools.test.ts (the approval held by `q.then` until another call's 403 has begun the refresh):
  - the call waits, then runs once with the new token;
  - with the helper failing, the call fails with `its headersHelper failed, so the call was not sent: it exited with
    code 3`, and the server never sees it;
  - with the fake's list changed beforehand (the HTTP fake's `change`, which only the new connection sees), the call
    gets 8c's changed line and is not sent;
  - a live edit removing the server mid-refresh gives the changed line, and a restart gives the stopped line;
  - a call still draining on a retiring connection when the server is removed by a live edit, and when it is
    reconnected (`restart`), ends with the same tool result 8c's own tests give a call in flight on a server stopped
    that way (decision 25);
  - no secret in a tool error (decision 28): a refresh whose helper exits 3 after printing `sk-fake-secret-1` on
    stderr, and a fake whose `tools/call` is redirected to another origin at
    `/sk-fake-secret-2/x?token=sk-fake-secret-3`. Neither secret is in any tool result or in any `mcp-note` or `error`
    event on the bus, which is what the screen and `-p --json` both print.
- servers.test.ts:
  - a removal, a restart and `stopAll` each mid-refresh resolve `dropped`, and after `go()` only the restart's own
    connection sends an `initialize`;
  - the same three after the refresh is ready, with a call draining on the old connection: each closes the old
    connection (decision 25).

**Implementation:**
- `export type Refresh = { is: "ready" } | { is: "failed"; reason: string; helper: boolean } | { is: "dropped" }`. This
  is the interface tools.ts reads.
- `Conn` gains `sent` (calls and reads waiting for answers), raised and lowered in `callTool` and `#request`, and
  `retiring`. A retiring connection closes when `sent` reaches 0 (`#retire`). Every retiring connection is also in
  `#retiring: Set<Conn>` until its close, which removes it (decision 25).
- `#refresh: { from, next?, stop: AbortController, dropped?: true, done: Promise<Refresh> }`, and the getter
  `refreshing`.
- `#answered(conn, status)` starts a refresh as decision 18 says, only when the connection is current, ready, not closed
  and has no live refresh.
- `#connect` is split into `#newConn(prepared)` (transport, client, `Conn`) and `#open(conn)` (connect and `listTools`
  raced against the start's limit), which `#connect` and the new `#reopen(r)` share.
- `#reopen(r)` does the work of decisions 19, 21 and 23:
  - it prepares, opens, and checks it is still current after each step;
  - on success it switches `#conn`, sets the state ready with the new tools, retires the old connection and calls
    `onChange`, keeping the connection number;
  - on failure it calls `#refreshFailed`: state `failed`, the old connection retired;
  - in its `finally`, it clears `#refresh` if `#refresh` is still `r`.
- `stop()` marks a refresh dropped, aborts it, and closes `#conn`, `r.next` and every connection in `#retiring`, so
  `stopAll`, a removal, `/mcp` Reconnect and a restart close them all (decision 25).
- `#newConn` makes a streamable HTTP connection with a helper with `onInsufficientScope: "throw"` (decision 26). SSE
  takes no such option.
- tools.ts, after `approve` and before the last `current` check (125):
  - if `refreshing` is set, wait for it with `until`;
  - `failed` throws `helperFailed` or `connectionFailed` (choice 6), declared among the file's lines;
  - `dropped` throws `changed(o)` when `current(o)` is "changed", and `stopped(o)` otherwise.
- fake.ts HTTP options:
  - `tokenFile`: a POST whose `x-token` is not the file's text is answered `denyStatus`, or 401;
  - `denyTool`: a call to that tool is answered 403;
  - a `wait` tool answered once `gate` exists;
  - `holdSecond`: the second `initialize` is answered once that file exists;
  - `redirectCall`: a `tools/call` is answered with a 307 to that address;
  - `signInFake`'s `scope403`: the next `tools/call` is answered 403 with the insufficient-scope challenge, once.

**Run:** `tests/mcp/server.test.ts`, `tests/mcp/tools.test.ts`, `tests/mcp/servers.test.ts`, `tests/mcp/auth.test.ts`,
`tests/hooks/mcp.test.ts`; types.

**Commit:** `feat: 8c-2a: a 401 or 403 runs the headersHelper again on a new connection, calls in flight finishing`

## Task 12: README, the 8c design's table, the full suite and the terminal check

**Files:** README.md (CRLF: edit with the Edit tool, then run the line-endings check), and
docs/plans/2026-11-10-tachikoma-release-8c-design.md ("Not in this release", 321-329).

**The README's edits** (the user approves the words first; each is grepped against the code before it is shown):
1. The banner (3-6): 8c-2's first part is done; its second part, the box's list of allowed sites, comes next.
2. "The network" (545-555): with the network off, MCP servers in the box start, and `host` and remote ones are off,
   with choice 3's line.
3. "MCP servers" (1373-1379): with the sandbox on, local servers run in the box. `"host": true` in
   `~/.tachikoma/settings.json` runs one on this computer; a project's file cannot give it (choice 4's line).
4. "A project's servers" (1432) and "Answers" (1546): the design's four questions; an answer counts only for its setup
   (choice 2); 8c's answers count for this computer.
5. "Trust and approval" (1481): the design's approval table, with its `never` rows.
6. A new "headersHelper" section after "Signing in" (1563) covering:
   - when it runs, its shell and folder, its 10 s limit and its two variables;
   - its output and the merge, and sign-in per connection;
   - a 401 or 403's refresh, and the redirect rule (choice 1);
   - a project's helper with the sandbox on (choices 3 and 9).
7. "With the sandbox" (1666-1677), rewritten: the design's table; TradingView and MemPalace need `"host": true`; a
   program the box lacks, with the not-found line; the box stopping.
8. "Not yet, for MCP" (1712-1717) and "MCP servers' limits" (2573-2576, 2670-2671):
   - servers inside the sandbox and `headersHelper` are done;
   - each worker's own servers are planned for release 12, and the allowed sites for 8c-2 part B;
   - the design's "Known limits".
9. "What comes next" (2700-2701): 8c-2 part B is next.

**The 8c design's table:** the 8c-2 row splits into "Servers inside the sandbox" (8c-2 part A), "Each worker's own
servers" (release 12, the part A design's choice 2) and "The list of allowed sites and its proxy; the name-lookup
measurement" (8c-2 part B). `headersHelper` moves from "Not planned" to 8c-2 part A, and `ws`, client secrets and
sampling stay "Not planned".

**Steps:**
1. Make the edits. Run the line-endings check on both files (`LF 0`). Grep for each line the README quotes against the
   code (`git grep -n "was not found in the box" src`, `git grep -n "headersHelper was not run" src`, the network-off
   line and the questions in clilib.ts).
2. Types. Then the full suite once, with Docker running and the sandbox's image built, so the real Docker tests run.
3. Run the line-endings check on every file the PR touched (`git diff --name-only main...`).
4. **The user's terminal check** (Windows Terminal, PowerShell, a real lead):
   - With TradingView and MemPalace set to `"host": true` in `~/.tachikoma/settings.json`, run
     `tachi --sandbox live --network on`. Both start (`/mcp`), and a TradingView tool and a MemPalace search answer.
   - The same with `--network off`: the launch says choice 3's line, and `/mcp` shows both servers off.
   - A small `npx` server inside the box (the user picks one), with `--network on` so npx can download it: `/mcp` shows
     it ready and a tool answers. With `--sandbox copy --mode never --network off`, a server from a script in the
     project runs its tool unasked, and its write shows in the review.
   - A helper that prints a header from a file (the README's example): the server connects. Change the file and the
     server's key, then call a tool: the call fails once, and the next call works.
5. **Commit:** `docs: 8c-2a: README and the 8c design's table: servers in the box, and headersHelper`.

---

## As built

What changed from the plan while building, for the later tasks and the reviewers. (Filled in during the build.)
