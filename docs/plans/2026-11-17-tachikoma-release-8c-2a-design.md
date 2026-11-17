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
4. **In `never` mode a box server's call runs without asking** ("Run without asking (Recommended)"), as the box's
   shell and file tools do: its effects stay in the copy, which the user reviews.

The user approved each of the four sections below on 2026-11-17.

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

- **Approval:** 8c's table, with one change: in `never` mode (copy mode only) a box server's call runs without asking.
  `host` and remote servers still ask, as 8c's row says ("a server on the user's machine is outside the box").

  | Mode | Box server | `host` or remote server |
  |---|---|---|
  | `ask`, `project` | asks | asks |
  | `auto` | the judge decides | the judge decides |
  | `never` (copy mode) | runs | asks |
  | `-p` | refused, except in `never` mode, where it runs | refused |

  A tool the user trusts runs without asking in every mode, and a PreToolUse hook's allow skips the question, as in
  8c. Neither widens the network rule above.
- **A box server's writes** land in the copy in copy mode, and show in the review like any other change; in live link
  they land in the real files, as the box's shell commands do.
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
  as in 8c. Values are handed to `docker exec` by name (`-e NAME`, the value in the `docker` program's own
  environment), so they never appear in the machine's list of running programs. `${VAR}` in an entry is still filled
  from the user's environment when the settings are read (8c). The server's roots (MCP `roots/list`) say `/work`.
- **Stop:** at `/mcp` Reconnect or a restart, the server's input is closed; if it still runs 300 ms later (8c's limit,
  `KILL_MS` in `src/mcp/server.ts`), its process group is killed inside the box. Killing the `docker exec` program on
  the machine is not enough: the process in the box keeps running (measured for the box's shell commands, release 7).
  At exit nothing waits: removing the box ends every server in it.
- **If the box stops or breaks,** its servers show `the box stopped`, and their tools say so, as a stopped server's
  tools do in 8c.

## `headersHelper`

Claude Code's field on a remote entry: a command that prints the server's headers, such as a fresh token. 8c leaves
such a server out with a "(planned)" line; part A runs it. What Claude Code does is from its documentation
(<https://code.claude.com/docs/en/mcp>, "Use dynamic headers for custom authentication", read 2026-11-17).

- **When:** at each connection, at launch and at `/mcp` Reconnect, never cached (Claude Code's rule). A call answered
  with 401 or 403 runs the helper again, reconnects and retries the call once (Claude Code's rule); if that fails too,
  the call fails with the server's answer.
- **How:** by the shell hooks use (8b design, "The shell, as Claude Code's": Git Bash on Windows, Windows PowerShell
  when there is none, `sh -c` elsewhere). In `~/.tachikoma` for an entry in the user's settings, and in the project
  folder for a project's entry (Claude Code's table, with `~/.claude` as Tachikoma's `~/.tachikoma`). Stopped after
  10 seconds (Claude Code's documented limit). It gets `CLAUDE_CODE_MCP_SERVER_NAME` and `CLAUDE_CODE_MCP_SERVER_URL`,
  so a helper written for Claude Code works unchanged. Provider keys are never passed.
- **Output:** a JSON object whose values are all strings (Claude Code's rule). Its headers beat a static header of the
  same name, whatever the letter case (Claude Code: "Dynamic headers override any static headers with the same name").
  An `Authorization` header from it means the server does not use sign-in (OAuth), as in Claude Code. Anything else (a
  non-zero exit, the time running out, output that is not such an object, a value with a line break or NUL) means the
  server does not connect, and its red line says why. Claude Code's documentation does not say what it does here, so
  this is Tachikoma's own rule.
- **A project's helper** runs only after the user's yes to that server, saved for the entry as written (8c), so a
  changed helper asks again. It runs without any variable whose name looks like a credential (with TOKEN, SECRET,
  PASSWORD, KEY or AUTH in it), as Claude Code does for a project's helper. With the sandbox on it does not run
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
  server runs for each sandbox and network setting; the approval table with its `never` row; the start command (no
  `-t`, values passed by name only, `/work`); what the server's environment holds; roots saying `/work`; the "not found
  in the box" line; the stop sequence.
- **A stand-in Docker** whose `exec -i` runs a small fake server on the machine and records how it was called: start,
  stop and failure tests without Docker.
- **Real Docker tests,** skipped where Docker is not running, as the sandbox's tests are: a fake server in the real box
  whose call writes a file that shows in copy mode's review; with the network off it still starts; a stop kills it
  inside the box.
- **Helper tests** with small fake helper scripts: good output; the merge with static headers, letter case included;
  `Authorization` turning off sign-in; a failing exit, the time running out, bad output; a 401, then a re-run and one
  retry; the two variables it gets; credential-looking names removed from a project's helper; a project's helper with
  the sandbox on, not run.
- **The user's terminal checklist:** TradingView and MemPalace with `"host": true`, the sandbox and its network on; a
  small `npx` server inside the box; a helper that prints a header from a file.
- CI runs it all on Windows for the pull request.

## Docs

- The README's MCP and sandbox sections.
- The 8c design's "Not in this release" table: each worker's own servers move to release 12.
