# Tachikoma release 8c-2, part A: servers inside the sandbox, and `headersHelper` (design)

Release 8c built the MCP client with every server on the user's machine, and left the rest to 8c-2
([release 8c design](2026-11-10-tachikoma-release-8c-design.md), "Not in this release"). 8c-2 is two pull requests
(the user's choice, 2026-11-17: "Two PRs, A first"):

- **Part A, this design:** with the sandbox on, local (stdio) servers start inside the session's box unless the user
  marks them `host`; Claude Code's `headersHelper` for remote servers.
- **Part B, its own design later:** the box's list of allowed sites with its filtering proxy, starting with the main
  design's "Still to measure" 15 (whether Docker's name lookup answers for outside sites on an `--internal` network).

The rules come from the main design ([2026-10-22](2026-10-22-tachikoma-design.md), "MCP tools"): local servers run in
the session's container, a server that cannot must be marked `host` in the user's config, and a `host` server's tools
follow the approval rule even in `never` mode.

## The user's choices (2026-11-17)

1. **Two pull requests, part A first** ("Two PRs, A first (Recommended)").
2. **Each worker's own servers move to release 12** ("Move to release 12 (Recommended)"). Today's subagents only read
   (release 4 design): they share the lead's box and copy and get only the tools the user trusts as read-only. A
   server copy per worker protects nothing until subagents write, which comes with delegation.
3. **A project's `headersHelper` is not run with the sandbox on** ("Not run in the sandbox (Recommended)"), so nothing
   from the project runs on the user's machine while the sandbox is on.
4. **In `never` mode a box server's call runs without asking only while the box's network is off** (first "Run
   without asking (Recommended)", then, after the design review's finding 3, "Only with the network off
   (Recommended)"). With the network off everything it does lands in the copy, which the user reviews. With the
   network on it can also change outside services, which the review never shows, and the dangerous-command check does
   not look at server calls, so it asks.
5. **A project server's question says where it runs, and a remote one's whether its helper runs** ("Approve as
   written (Recommended)"; the design review's finding 1). The wording is in "A project's servers: the answer and
   where it counts".

The user approved each of the four sections below on 2026-11-17, and the changes from the design review the same day
(see "After the design review").

## Where a local server runs

- **Sandbox off:** unchanged. Every server runs on the user's machine.
- **Sandbox on:** each local server starts inside the session's box, with the project at `/work`, unless the user's
  own settings (`~/.tachikoma/settings.json`) mark its entry `"host": true`. Then it runs on the user's machine.
  - A project's `.mcp.json` cannot mark a server `host`: the field is ignored there with a warning, as `trusted` is.
  - To run a project's server on the user's machine, the user copies its entry into their settings with `host`; the
    user's entry already wins the name whole (8c).
- **The box's network decides what starts:**

  | Box network | Box servers | `host` servers | Remote servers |
  |---|---|---|---|
  | off | start, with no web | don't start; one grey line says they can't be kept off the web | not reached (as in 8c) |
  | on | start | start | reached |

- **Approval:** 8c's table, with one change: in `never` mode (copy mode only) a box server's call runs without asking
  while the box's network is off (choice 4). With the network on it asks, as `host` and remote servers do, as 8c's row
  says ("a server on the user's machine is outside the box").

  | Mode | Box server, network off | Box server, network on | `host` or remote server |
  |---|---|---|---|
  | `ask`, `project` | asks | asks | asks |
  | `auto` | the judge decides | the judge decides | the judge decides |
  | `never` (copy mode) | runs | asks | asks |
  | `-p` | refused, except in `never` mode, where it runs | refused | refused |

  A tool the user trusts runs without asking in every mode, and a PreToolUse hook's allow skips the question, as in
  8c. Neither widens the network rule above.
- **A box server's writes** land in the copy in copy mode, and show in the review like any other change; in live link
  they land in the real files, as the box's shell commands do. With the box's network on, what it changes outside
  (a post, a deletion, a purchase) is in no review, which is why `never` mode asks then.

## A project's servers: the answer and where it counts

8c keeps the user's answer for a project's server by its name and its entry as written (`src/mcp/answers.ts`). Part A
adds where the server runs, so a yes given for the box never starts the server on the user's machine (the design
review's finding 1):

- **A local server's answer** records the setup it was given for: `host` while the sandbox is off, and while it is
  on, `box` with the sandbox's kind (copy or live link) and the box's network (off or on), so five setups in all.
  Starting a server runs its code before any call is approved, and live link (the real files) or the network (the
  web) widens what that code can reach, so a yes for a copy with the network off never starts it in live link or with
  the network on (the second design review's finding 1).
- **A remote server's answer** records whether its `headersHelper` runs: it does with the sandbox off, and not with
  it on (choice 3). An entry without a helper records nothing more.
- **Only an exact match counts,** a yes and a no alike: a change asks again in the window, and in `-p` the server is
  skipped with 8c's line ("-p starts only the project's servers you said yes to in the window").
- **Answers saved by 8c** count as `host`, as every server ran on the user's machine then. A remote entry with a
  helper was left out in 8c, so it has no answer and is asked about.
- **The question says which** (choice 5); the text after the colon is 8c's:
  - `Start the MCP server "x" from this project's .mcp.json inside the sandbox (copy, network off): <command>? [y/n]`,
    with `copy` or `live link` and `network off` or `network on` as the launch's setup is
  - `Start the MCP server "x" from this project's .mcp.json on this computer: <command>? [y/n]`
  - `Connect to the MCP server "x" from this project's .mcp.json at <url>, running its headersHelper on this
    computer: <helper>? [y/n]`
  - with the sandbox on: `Connect to the MCP server "x" from this project's .mcp.json at <url>, without its
    headersHelper? [y/n]`
  - a remote entry without a helper keeps 8c's question unchanged.
- **The user's own setup:** TradingView (it talks to the desktop app) and MemPalace (its palace is in the home folder)
  both need `"host": true`. With the sandbox on and the box's network off neither starts, as no server starts in 8c
  with the network off.

## Starting and stopping a server in the box

- **Start:** `docker exec -i` in the session's box, never `-t`, which would mangle the message stream. It runs as the
  box's own user, in `/work`, through the same wrapper the box's shell commands use (its own process group), so the
  server and everything it started can be stopped together.
- **The command is looked up inside the box.** The image has Node with `npx`, Python, `uv` with `uvx`, and git
  (`sandbox/Dockerfile`). A program the box lacks, or a Windows path, ends the start with the server's red line:
  `<command> was not found in the box; if it needs this computer, add "host": true to its entry in
  ~/.tachikoma/settings.json`. A server started through `npx -y` or `uvx` downloads its package first; with the box's
  network off that fails, and the red line carries the server's own error.
- **What the server gets:** its entry's `env`, `CLAUDE_PROJECT_DIR=/work`, and the box's own settings (such as
  `HOME=/tmp`). Not the user's whole environment, whose paths mean nothing in the box. Provider keys are never passed,
  as in 8c. The `docker` program itself gets the same environment as Tachikoma's other Docker calls, never the
  entry's: Docker reads variables such as `DOCKER_HOST` and `DOCKER_CONFIG` itself
  (<https://docs.docker.com/reference/cli/docker/#environment-variables>), so an entry's values there could point it
  at another machine or settings (the design review's finding 2). The server's variables go over the server's own
  input instead, as one block before the first message, which a small wrapper in the box reads and sets before it
  starts the server; so they are neither on a command line (which the machine's list of running programs shows) nor
  in a file on disk (`docker exec --env-file` would write one, and cannot carry a line break). `${VAR}` in an entry is
  still filled
  from the user's environment when the settings are read (8c). The server's roots (MCP `roots/list`) say `/work`.
- **The block's framing** (the second design review's finding 2): each variable is `NAME=VALUE` followed by one NUL
  byte, and the block ends with one more NUL (an empty entry). A name is letters, digits and `_`, not starting with a
  digit; a value may hold a line break but never a NUL (no environment value can). The wrapper reads the entries with
  bash's `IFS= read -r -d ''`, which takes a pipe one byte at a time, so it never takes a byte past the block's end, and
  then replaces itself with the server (`exec`), which reads its input from the next byte on: the first MCP message.
  The `IFS=` matters: without it `read` strips spaces, tabs and line breaks from a value's end (the third design
  review's finding 1; seen in Git Bash 2026-11-17, `A=x <tab><line break>` read back as `A=x`, and kept whole with
  `IFS=`). Whether `read` holds to all this in the box's bash is checked by the tests below, not assumed.
- **The stream:** a box server's input stays open for the whole connection, written by the MCP library's own stdio
  transport (8c's `Stdio`) through a `docker exec -i` it starts. The block is the first thing written, before the
  library's first message. The sandbox's Docker runner (`src/sandbox/docker.ts`), which writes its input once and
  closes it, is not used for servers.
- **Stop:** at `/mcp` Reconnect or a restart, the server's input is closed; if it still runs 300 ms later (8c's limit,
  `KILL_MS` in `src/mcp/server.ts`), its process group is killed inside the box. Killing the `docker exec` program on
  the machine is not enough: the process in the box keeps running (measured for the box's shell commands, release 7).
  At exit nothing waits: removing the box ends every server in it.
- **A stop that fails in the box** (the plan review's finding 1). If the kill cannot be run, the server may still run
  in the box while its `docker exec` on the machine has ended. Its reason is read as the sandbox's commands read a
  failed kill (`src/sandbox/executor.ts`): no docker program, Docker's own error output (or `the box stopped` when it
  gave none), or the error's message. No second copy starts while the first may be running:
  - a Reconnect, a restart or a live edit's restart first tries the stop again;
  - if it still fails, nothing new starts, and the red line says `its earlier copy could not be stopped in the box
    (<reason>), so it was not started again` (the user approved the wording);
  - a box that Docker says has gone needs no second try, as its removal ended the server.
- **If the box stops or breaks,** its servers show `the box stopped`, and their tools say so, as a stopped server's
  tools do in 8c.

## `headersHelper`

Claude Code's field on a remote entry: a command that prints the server's headers, such as a fresh token. 8c leaves
such a server out with a "(planned)" line; part A runs it. What Claude Code does is from its documentation
(<https://code.claude.com/docs/en/mcp>, "Use dynamic headers for custom authentication", read 2026-11-17).

- **When:** at each connection, at launch and at `/mcp` Reconnect, never cached (Claude Code's rule). A call answered
  with 401 or 403 fails with the server's answer, and the helper runs again and the server reconnects, for the calls
  after it. The call itself is not sent again (the design review's finding 4): a 401 or 403 is the server's own
  answer, so the request reached it, and Tachikoma resends only a call that never reached its server (8c, choice 13;
  `src/mcp/tools.ts`). Claude Code retries it once; this one rule differs on purpose. 8c's check still refuses a tool
  that changed on the new connection. The MCP library would itself resend a request answered 403 with
  `WWW-Authenticate: Bearer error="insufficient_scope"`, after its own step-up sign-in. A connection with a helper turns
  that off (the transport's `onInsufficientScope: 'throw'`), so the call fails once and the refresh above follows (the
  plan review's finding 3). The library's SSE transport has no such resend.
- **One refresh per connection, and calls in flight finish** (the second design review's finding 3). The first 401 or
  403 on a connection starts its refresh; another on the same connection joins it rather than starting a second. The
  new connection opens beside the old one, which 8c's Reconnect would close at once (`src/mcp/server.ts`): calls
  already sent on the old connection get their answers there, each within its own time limit, and the old connection
  closes when the last has finished. Calls not yet sent go to the new connection, provided their tool is unchanged
  there (8c's check). `/mcp` Reconnect and a restart still close the old connection first, as in 8c. An old connection
  still finishing its calls stays the server's own until it closes (the plan review's finding 2), so a teardown closes
  it too: a stop, the exit, a live edit's removal, a Reconnect or a restart. A call still running on it ends as 8c ends
  a call in flight on a server stopped the same way.
- **A refresh that fails, or is overtaken** (the third design review's finding 3):
  - **The helper fails or the new connection fails:** calls waiting for the new connection fail at once with `its
    headersHelper failed, so the call was not sent: <reason>` (or the connection's own reason), the server shows its
    red line as at a start, and calls already sent on the old connection still finish there before it closes.
  - **The server is removed by a live edit, restarted, reconnected from `/mcp`, or Tachikoma exits mid-refresh:** the
    refresh is dropped, both connections are closed, and waiting calls fail with 8c's line for that case (changed or
    stopped). A refresh that finishes afterwards is thrown away, checked against the server's current connection as
    8c's late answers are, so it can never bring back a server that was removed or restarted.
- **How:** by the shell hooks use (8b design, "The shell, as Claude Code's": Git Bash on Windows, Windows PowerShell
  when there is none, `sh -c` elsewhere). In `~/.tachikoma` for an entry in the user's settings, and in the project
  folder for a project's entry (Claude Code's table, with `~/.claude` as Tachikoma's `~/.tachikoma`). Stopped after
  10 seconds (Claude Code's documented limit). It gets `CLAUDE_CODE_MCP_SERVER_NAME` and `CLAUDE_CODE_MCP_SERVER_URL`,
  so a helper written for Claude Code works unchanged. Provider keys are never passed.
- **Output:** a JSON object whose values are all strings (Claude Code's rule). Its headers beat a static header of the
  same name, whatever the letter case (Claude Code: "Dynamic headers override any static headers with the same name").
  An `Authorization` header from it means the server does not use sign-in (OAuth) on that connection, as in Claude
  Code. So the choice is made for each connection, after the helper has run and its headers have been merged (the
  second design review's finding 4); 8c makes it once, from the static headers, when the server is set up
  (`src/mcp/server.ts`). A helper that gives `Authorization` on one connection and not on the next leaves sign-in to
  the next. While sign-in is used, the headers, the helper's included, go only to the server's own address, never to
  the sign-in service (8c, choice 54). Anything else (a non-zero exit, the time running out, output that is not such
  an object, a value with a line break or NUL) means the server does not connect, and its red line says why. Claude
  Code's documentation does not say what it does here, so this is Tachikoma's own rule. The red line never quotes what
  the helper printed, as a helper prints secrets (the plan review's finding 5; the user approved the forms). An exit
  is `it exited with code <n>`, with nothing from its error output, and a failed start is `it could not start (<error
  code, such as ENOENT>)`, not the whole error.
- **No redirect to another site with the entry's headers** (the third design review's finding 2). `fetch` alone would
  follow a redirect anywhere: it drops `Authorization` when the redirect leaves the server's origin
  (<https://fetch.spec.whatwg.org/#http-redirect-fetch>), but keeps any other header, such as an `X-API-Key`. The MCP
  library Tachikoma uses (2.4.0) already handles every transport request's redirects itself, sign-in's included: its
  `redirectPolicy` defaults to `'same-origin'`, following a redirect only within the request's origin with its method
  kept and failing any other (`node_modules/@modelcontextprotocol/client/dist/index.d.mts`, found while planning). So
  a request that carries the entry's headers, static or the helper's, with sign-in used or not, fails on a redirect to
  another origin, with nothing sent there, and the red line or the call's error says `the server answered with a
  redirect to <origin>; Tachikoma does not follow a redirect with the entry's headers` (the user approved the
  wording). Only the origin is named, as 8c's lines name only an origin, since a path or a query can hold a token (the
  plan review's finding 5). A redirect within the server's own origin, such as `/mcp` to `/mcp/`, is left to the
  library, so servers that work in 8c keep working (the user's choice while planning, 2026-11-17: "Only other sites
  fail"). Such a hop is the same request as the one redirected (the plan review's finding 4): the entry's headers go
  on it, with sign-in used or not, and its 401 or 403 starts the refresh as the server's own answer would. Part B's
  site check applies to redirects without the entry's headers.
- **A project's helper** runs only after the user's yes to that server, saved for the entry as written (8c) and for
  whether the helper runs (above), so a changed helper, or a first launch with the sandbox off, asks again. It runs
  without any variable whose name looks like a credential (with TOKEN, SECRET, PASSWORD, KEY or AUTH in it), as
  Claude Code does for a project's helper. With the sandbox on it does not run
  (choice 3): the server connects with its static headers, and one line says `<name>: its headersHelper was not run,
  as it comes from the project and the sandbox is on.`
- **The user's own helper** runs on the user's machine in every mode. With the box's network off no remote server is
  reached, so it does not run then.
- **In `-p`** its lines go to stderr, and `--json` gets `mcp-note` lines, as 8c's server lines do.

## Not in this part

| Left out of part A | When |
|---|---|
| Each worker's own servers | Release 12, with the subagents that write (choice 2) |
| The allowed-sites list, its proxy, the name-lookup measurement | 8c-2 part B |
| `ws` servers, client secrets, sampling | Not planned: the user's servers do not use them (8c) |

## Known limits

- `host` servers run with the user's full permissions on the user's machine.
- With the box's network on, a box server can reach the whole web, until part B's allowed sites.
- In live link a box server writes the real files, as the box's shell commands do.
- A program missing from the box shows only when the server starts.

## Testing

- **Unit tests:** the `host` field, read from the user's file and ignored with a warning in a project's; where each
  server runs for each sandbox and network setting; the approval table with its `never` rows, network off and on; the
  start command (no `-t`, no server value on it, `/work`); the `docker` program's own environment, with an entry that
  sets `DOCKER_HOST` and `DOCKER_CONFIG` changing nothing there; the block on the server's input, and what the server's
  environment holds, line breaks included; roots saying `/work`; the "not found in the box" line; the stop sequence.
- **The block, in the real box:** written in several pieces with pauses between them; written in the same piece as
  `initialize`, the server still answering it; values ending in spaces, tabs and line breaks, and values with line
  breaks inside, reaching the server whole; a bad name refused before anything starts.
- **Answers:** a yes for the box asked again with the sandbox off, and the reverse; a yes for a copy with the network
  off asked again in live link and with the network on, and each of these skipped in `-p`; a remote answer without the
  helper asked again when the helper would run; an 8c answer counting as `host`; the questions' text.
- **A stand-in Docker** whose `exec -i` runs a small fake server on the machine and records how it was called: start,
  stop and failure tests without Docker.
- **Real Docker tests,** skipped where Docker is not running, as the sandbox's tests are: a fake server in the real box
  whose call writes a file that shows in copy mode's review; with the network off it still starts; a stop kills it
  inside the box.
- **Helper tests** with small fake helper scripts: good output; the merge with static headers, letter case included;
  `Authorization` turning off sign-in; a failing exit, the time running out, bad output; a 401 or 403 failing its
  call, sent once only, with the helper run again and the next call on the new connection, and a tool changed there
  refused; two calls at once, one answered 403 and the other succeeding on the old connection, with one refresh only
  and a third call on the new one; sign-in chosen per connection, a helper's `Authorization` on one connection and
  none on the next; the headers kept from the sign-in service; a redirect answer to a request with the entry's
  headers, static and the helper's, with sign-in used and not, failing with nothing sent to the new address; a failed
  refresh failing the waiting calls at once while a call in flight finishes; a live edit's removal, a restart, a
  Reconnect and an exit mid-refresh closing both connections, and a late refresh thrown away; the two variables it
  gets; credential-looking names
  removed from a project's helper; a project's helper with the sandbox on, not run.
- **The plan review's tests:**
  - a failed kill in the box, then a Reconnect whose second try fails (nothing new starts, the line) and one whose
    second try works (one copy starts), and the same for a live edit's restart;
  - a teardown after a refresh while a call still runs on the old connection, which closes it;
  - with sign-in on, a 403 `insufficient_scope` answer failing its call, sent once only, with one refresh;
  - with sign-in on and off, `/mcp` to `/mcp/`: the helper's and the static headers at `/mcp/`; a 403 (and, without
    sign-in, a 401) there starting the refresh; a hop to another origin still failing before anything is sent there;
  - a secret printed by a helper on its error output, and one in a redirect's path and query, never in the screen's
    lines, `--json` events or a tool's error.
- **The user's terminal checklist:** TradingView and MemPalace with `"host": true`, the sandbox and its network on; a
  small `npx` server inside the box; a helper that prints a header from a file.
- CI runs it all on Windows for the pull request.

## Docs

- The README's MCP and sandbox sections.
- The 8c design's "Not in this release" table: each worker's own servers move to release 12.

## After the design review

An outside review of this design on 2026-11-17 made four findings. Each was checked against the code, held, and
changed the design above:

1. **A saved yes could move a project's server from the box to the user's machine** (`src/mcp/answers.ts` keys an
   answer by name and entry only). Answers now record where the server runs, and whether a helper runs; the question
   says which (choice 5).
2. **Passing the server's variables through the `docker` program's environment** would let a project's entry steer
   Docker itself. They now go over the server's input.
3. **`never` mode's reason was wrong with the network on:** a box server can then change outside services that no
   review shows. It now asks then (choice 4).
4. **Retrying a call after a 401 or 403 could run it twice,** as the answer shows the request reached the server.
   The helper's fresh headers serve the calls after it; the call is not sent again.

A second review the same day made four more findings, each checked against the code and fixed above:

1. **A yes for the box was too broad:** starting a server runs its code, and live link or the network widens what it
   reaches. An answer now records the sandbox's kind and network too, and the question names them (the user approved
   the wording).
2. **The variables block needed exact framing,** as one read can hold its end and the first message, and the sandbox's
   Docker runner closes its input. The framing and the stream are now set out, and tested in the real box.
3. **A refresh would close calls still waiting on the old connection.** One refresh per connection now; calls in
   flight finish on the old one, new ones go to the new one.
4. **Sign-in was chosen once, from the static headers.** It is now chosen per connection, after the helper's headers
   are merged.

A third review the same day made three more, each checked (the first in Git Bash, the others in the code) and fixed
above:

1. **`read -r -d ''` strips a value's trailing spaces, tabs and line breaks.** The wrapper uses `IFS=`, and the tests
   send such values.
2. **`fetch` follows redirects with headers other than `Authorization`.** A request with the entry's headers no longer
   follows a redirect to another site (the user approved the line). While planning, the MCP library was found to do
   this already by default; the user chose to leave redirects within the server's own address to it.
3. **A refresh that fails or is overtaken was left open.** Waiting calls now fail at once (the user approved the line),
   and a removal, restart, Reconnect or exit closes both connections and throws away a late refresh.

An outside review of the implementation plan the same day (the plan review) made five findings. Each was checked
against the code and the pinned MCP library, held, and changed the design above:

1. **A failed stop in the box could leave two copies running.** If the kill failed, the server could still run in the
   box while its `docker exec` had ended, and a Reconnect would start a second copy. The stop is now tried again first,
   and a copy that still cannot be stopped keeps a new one from starting, with its line (the user approved it).
2. **An old connection a refresh replaced was not closed by a teardown.** It now stays the server's own until it
   closes, so a stop, the exit, a removal or a Reconnect closes it.
3. **The library resends a request answered 403 `insufficient_scope`.** That would run a call twice. It is turned off
   for connections with a helper.
4. **A hop the library follows within the server's origin lost the entry's headers with sign-in on, and its 401 or
   403 started no refresh.** Such a hop is now the same request.
5. **Lines could carry secrets:** a helper's last error line, a failed start's whole error, and a redirect target's
   path and query. A helper's reasons now give only its exit code or its error's code, and the redirect line names
   only the origin (the user approved the forms).
