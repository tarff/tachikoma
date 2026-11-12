# Tachikoma release 8c: the MCP client, design (2026-11-10)

Release 8c is the third of release 8's parts. The overall design, the Decisions table and the
release order are in [2026-10-22-tachikoma-design.md](2026-10-22-tachikoma-design.md); its section
"MCP tools" already sets the safety rules this design builds on. Release 8b left three hook pieces
for 8c: the `mcp_tool` hook kind, the Elicitation and ElicitationResult events, and `mcp__...` tool
names in matchers ([8b design](2026-11-09-tachikoma-release-8b-design.md), "Not in this release").

Every choice below was the user's, on 2026-11-10, from options offered; "option chosen" quotes it.
Points marked **To confirm** came to light after the user's choices, when the sources were read in
full, and wait for the user's review of this design.

## Sources

- Claude Code's MCP page, <https://code.claude.com/docs/en/mcp>, with its environment variables
  (<https://code.claude.com/docs/en/env-vars>), hooks (<https://code.claude.com/docs/en/hooks>) and
  permissions (<https://code.claude.com/docs/en/permissions>) pages, read raw 2026-11-10. Every
  number in this design but the 64-character name limit (300 ms at exit, the 600 s `mcp_tool`
  limit, the 30 s start-up and 60 s request limits, the 4,096-character description cut) is Claude
  Code's documented value; none has been measured for Tachikoma, and the README will say so.
- OpenAI's Chat Completions reference,
  <https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create>:
  a function's name is at most 64 characters, of letters, digits, `_` and `-`. Tachikoma's
  OpenAI-format adapter sends each tool's name unchanged (`src/providers/openai.ts`).
- The design review, [2026-11-10-tachikoma-release-8c-design-review.md](2026-11-10-tachikoma-release-8c-design-review.md):
  four findings, each fixed below where it is marked "the design review, finding N".
- The library, `@modelcontextprotocol/client` 2.4.0 (Apache-2.0, released 2026-10-23), read from
  its package 2026-11-10 without installing it: it implements the 2026-07-28 MCP specification and
  exports `Client`, `StdioClientTransport` (started through `cross-spawn`),
  `StreamableHTTPClientTransport`, `SSEClientTransport`, an `OAuthClientProvider` interface with
  `auth` and `withOAuth`, and the elicitation, roots, list-changed, resource and prompt types. Its
  dependencies are its own `core` package, `zod` 4 (already Tachikoma's), `jose`, `pkce-challenge`,
  `cross-spawn` and two event-stream readers. The other form, `@modelcontextprotocol/sdk` 1.32.2
  (MIT), carries the express and hono web servers, which a client never runs.
- The user's own setup, read 2026-11-10, names, kinds and programs only (never `env` values or
  headers, which can hold keys):

  | Server | Kind | Started as / address | Where it is set |
  |---|---|---|---|
  | tradingview | local | `node server.js` | Claude Code's user settings |
  | mempalace | local | `mempalace-mcp` | the MemPalace plugin |
  | Sanity | remote | `mcp.sanity.io`, one header | Claude Code's user settings |
  | figma | remote | `mcp.figma.com`, one header | the Figma plugin |
  | openmarket | remote | `mcp.openmarket.xyz`, no header, so it signs in | Claude Code's user settings |

  Also `ga4-analytics` (local, one project's settings) and the context7 (remote) and claude-mem
  (local) plugins. Claude in Chrome is in no server list: Claude Code builds it in.

## What 8c covers

The MCP client, with every server running on the user's machine or reached from it (option chosen:
"Two PRs"). 8c-2 follows with servers inside the sandbox, a worker's own servers, and the
sandbox's list of allowed sites with its filtering proxy, which share the Docker network work.

- Local (stdio) and remote (`http`, and `sse` for older servers) servers.
- Their tools for the lead, and for subagents the tools the user trusts as read-only.
- Sign-in (OAuth) for remote servers.
- Tool lists that change while a server runs, pictures in answers, resources through `@`, and
  prompts as `/` commands (all four chosen).
- Forms a server asks the user to fill in (elicitation).
- The three hook pieces 8b left.
- `/mcp`.

## The settings entry

Servers go under `"mcpServers"` in `~/.tachikoma/settings.json`, in Claude Code's shape, so an
entry copies over unchanged (option chosen: "Settings + project, asked"):

```json
"mcpServers": {
  "tradingview": { "command": "node", "args": ["C:/tools/tradingview/server.js"] },
  "sanity": {
    "type": "http",
    "url": "https://mcp.sanity.io",
    "headers": { "Authorization": "Bearer ${SANITY_TOKEN}" },
    "trusted": "read-only"
  }
}
```

- **Fields**, Claude Code's: `type` (`stdio`, the default; `http`, also spelled
  `streamable-http`; `sse`), `command`, `args`, `env`, `url`, `headers`, `timeout` (ms), and
  `oauth` with `clientId`, `callbackPort`, `scopes` and `authServerMetadataUrl`. As in Claude Code,
  an entry with a `url` but no `type` is an error, since no `type` means a local server.
- **`${VAR}` and `${VAR:-default}`** are filled in from the user's environment in `command`,
  `args`, `env`, `url` and `headers`, as Claude Code does. One difference: Claude Code passes an
  unset `${VAR}` through as literal text and warns; Tachikoma leaves that server out with a warning
  naming the variable, so a key header cannot go out as the text `${SANITY_TOKEN}`.
- **Trust, Tachikoma's own fields:** `"trusted": "read-only"` for the whole server, or
  `"trustedTools": ["quote_get", ...]` for single tools. They are the user's statement that the
  tools only read, which Tachikoma cannot check; the README says so. They count only in the user's
  own settings file.
- **A bad entry** is left out with a warning, never a crash, as a bad hook is.
- **Live edits** apply while Tachikoma runs: a changed entry restarts only that server, with one
  line naming it (`MCP servers changed: tradingview restarted`).
- **A local server's environment** is the commands' own (`commandEnv`: the user's, without
  Tachikoma's API keys), plus the entry's `env`.

## A project's servers

A project's `.mcp.json`, at its root, is read too (option chosen: "Settings + project, asked").

- **In the window,** Claude Code's way (option chosen: "Claude Code's way"): the user is asked once
  per server name, the question showing its command and arguments, or its address. The answer is
  kept for that project until the user resets it in `/mcp`, or until the entry changes: an answer
  holds the entry as written, so a pulled change to its command, arguments, environment or address
  is asked about again (the user's choice, 2026-11-10, Task 3's review; Claude Code asks once per
  name).
- **In `-p`,** only servers the user has already said yes to in the window start; each other one is
  skipped, with a note on stderr (option chosen: "Window: Claude's way; -p: only yes'd"). Claude
  Code starts them all without asking; the user kept the window's way but not that, as a cloned
  repository's `.mcp.json` would otherwise start its programs unasked, which 8b's hooks never allow.
- **Trust marks in `.mcp.json` never count.**
- **The same name in both files:** the user's entry wins whole, fields never mixed. Claude Code
  ranks a project's entry above the user's; Tachikoma does not, so a repository cannot replace a
  server the user trusts with its own program under the same name (approved with section 1).
- Answers are kept in Tachikoma's data folder, per project, as the project's other files are.

## Starting and stopping servers

- **At the launch** every server starts, all at once, in the background.
- **The first prompt waits** until each has started or failed, as it waits for SessionStart hooks
  in 8b: `Waiting for MCP servers: tradingview, sanity...`, and Esc sends it without the late ones,
  whose tools join when they are ready.
  **To confirm:** section 2 was approved as "no time limit, since Claude Code's is not documented",
  but Claude Code's `MCP_TIMEOUT` is documented: 30 s for a server to start. This design proposes
  that limit, so a server that hangs fails on its own and the first prompt never waits for good.
- **Local servers** are started by their full path, never by a bare name that Windows would look for
  in the project folder first (the review fixes plan, fix 1). The library's own start-up looks
  programs up through `cross-spawn`, so Tachikoma finds the path itself and hands that over. On
  Windows npm's `.cmd` wrappers, such as `npx`, are common for servers; they are looked for too,
  and `cross-spawn` starts them through `cmd.exe` as Claude Code's own start-up does.
- **At exit** a local server's input is closed, and if it is still running 300 ms later it is
  killed with everything it started (Claude Code's documented behaviour on Windows, used on every
  system).
- **A server that stops** gets one red line, and its tools answer "the server stopped" until the
  user reconnects it from `/mcp`. A remote server whose connection drops is tried once more at its
  next call. Nothing restarts in a loop.
- **With the sandbox on** (the main design's rules, option chosen: "Main design's rules"): with the
  box's network off, no local server starts, as it would run on the user's machine with the web
  open, and no remote server is reached; one grey line says so. With the box's network on, both
  work, with the approvals below. 8c-2 moves local servers into the box.

## Tools for the model

- **Names:** `mcp__<server>__<tool>`, with every character but letters, digits, `_` and `-` made
  `_`, as Claude Code does.
- **One length limit for every provider: 64 characters** (the design review, finding 1). OpenAI's
  Chat Completions takes a tool name of at most 64 characters, and Tachikoma's OpenAI-format
  providers send each name unchanged; Claude Code's 128 is Anthropic's. As `/lead` can switch to
  an OpenAI-format provider in the middle of a session, a tool's name must fit them all from the
  start, so the name a request carries never depends on the provider and the conversation's earlier
  calls stay valid after a switch. A tool whose name is longer is left out, with a warning naming
  it; the server's other tools and the conversation are untouched. The first task's measurement
  (under "Tool search") also counts how many of the user's tools this leaves out, for the user to
  see before the rule is built.
- **Every name is unique, or the tool is left out** (the design review, finding 2). The
  character rule is not one-to-one (`foo.bar` and `foo_bar` both become `foo_bar`), and `__` would
  make the split unclear (server `a__b` with tool `c`, and server `a` with tool `b__c`). So:
  - a server name that holds `__` once its characters are made safe is left out with a warning;
  - a name already in use, by another server's tool, by Tachikoma's own tools or by an earlier tool
    of the same server, leaves the later one out, with a warning naming both. "Later" is the order
    the servers are read (the user's file, then the project's, each in its file's order), and for a
    server that starts late or whose list changes, any name already in force;
  - each name is kept in a table with its server and its tool's own name, which the call, the
    question, trust, subagents' tools and hooks all read. A name is never split back into its parts.
- **Descriptions** are the server's, cut at 4,096 characters, Claude Code's limit for a tool loaded
  with the others. **To confirm:** this cut came from the sources, not from the user's choices.
- **A call** has no time limit unless the entry sets `timeout`, as in Claude Code, whose default is
  about 28 hours; a remote server's single request stops after 60 s unless `timeout` is longer
  (Claude Code's). Esc stops a call and tells the server it was cancelled.
- **The answer:**
  - Text is cut at 30,000 characters with the usual `[cut: N more characters]` line, as a
    command's output is (option chosen: "As a command's").
  - Pictures go to the model as pasted pictures do.
  - An answer with only structured data is sent as its JSON text.
  - A tool that reports an error reaches the model as a failed call, so PostToolUseFailure hooks run.
- **Changing tool lists:** when a server says its tools changed, they are read again, and the next
  request carries the new list.
- **A call runs only on the tool the model was shown** (the design review, finding 4). Each server
  connection has a number, raised when it restarts; each tool keeps the number of the connection
  that offered it and its definition. A call the model makes keeps both from the request that
  offered the tool. Right before it is sent, after its hooks and its question, both are compared
  with the server's now: if the server restarted, or the tool is gone or its definition changed,
  the call is not run, and the model is told the tool changed while the call waited, so it can
  look again. An approval given for one version therefore never runs another. A call already
  running when its server restarts ends as stopped. Trust is read when the gate decides, so a live
  edit that removes it takes effect for every call not yet decided.
- **The folder a server is told it works in** (MCP's "roots") is the project folder.
- **Not offered:** sampling, a server asking Tachikoma's model to write text for it, which would
  spend the user's provider credit for the server.
- **Tool search** (option chosen: "Measure first"). Claude Code by default sends only tool names
  and looks a tool up when the model needs it. Whether Tachikoma needs that depends on how big the
  user's tool lists are, so the plan's first task starts the user's four servers, with the user's
  yes at the time, and measures their tool lists in tokens, and their tools' full names in
  characters; the user then decides with the numbers.

## Approval

An MCP call is a new kind of action, `mcp`, for the permission gate (main design, "MCP tools";
option chosen: "As the main design says").

| Mode | An MCP call |
|---|---|
| `ask`, `project` | asks |
| `auto` | the judge decides, seeing the tool's description too |
| `never` (copy mode) | asks: a server on the user's machine is outside the box |
| `-p` | refused, as nobody can answer |

- The question names the server, the tool and its input, escaped as every question is:
  `Allow tradingview: draw_shape {"shape": "trend_line", ...}?`
- A tool the user trusts runs without asking, in every mode.
- A PreToolUse hook's allow skips the question, as for any tool. Neither trust nor a hook's allow
  widens the sandbox's network rule above.
- **Subagents** only read (release 4 design), so they get only the tools the user trusts as
  read-only, under the same names (option chosen: "Only trusted read-only").

## Remote servers and sign-in

- **Kinds:** `http` is built; `sse` too, through the library's own transport. `ws` is left out with
  a warning: Claude Code has it, the user's servers do not use it.
- **Header keys** in `headers`, with `${VAR}`, serve the Sanity and Figma entries. `headersHelper`,
  a program that prints the headers, is left out with a warning, "planned": no server of the user's
  uses it, and it is one more program to run.
- **Sign-in (OAuth),** for servers such as openmarket:
  - A server that needs it shows `needs sign-in` in `/mcp`; the launch never waits for it.
  - In `/mcp` the user picks Sign in. Tachikoma asks before opening the browser, which shows the
    server's own page.
  - The answer comes back to a local address on a free port, or the entry's `oauth.callbackPort`.
  - Tokens are kept as the ChatGPT sign-in is, private to the user, and refreshed on their own.
    Sign out removes them.
  - `-p` cannot sign in, as in Claude Code; a server signed in from the window works there.
- **Addresses:** `http://` only for the user's own machine (`localhost`, `127.0.0.1`, `::1`);
  anything else must be `https://`, so a key or token never travels in plain text. Claude Code's
  page does not say whether it allows `http://` elsewhere.

## Forms a server asks for (elicitation)

- Elicitation hooks run first, and can answer, decline or cancel; exit code 2 declines with no form.
- A form shows the server's message, then asks each field at the prompt: text, a number, yes or
  no, or a pick from a list, the kinds of field MCP allows. Esc declines the form.
- A request to visit an address asks before opening the browser.
- ElicitationResult hooks see the answer; exit code 2 turns it into a decline.
- In `-p` every form is declined.
- Everything a server writes is escaped, so it cannot pass for one of Tachikoma's lines.

## Hooks

- Every hook event sees an MCP call under its `mcp__...` name.
- A matcher such as `mcp__tradingview__.*` picks one server's tools. As in Claude Code, a bare
  `mcp__tradingview` matches nothing; the `.*` is needed.
- **The `mcp_tool` hook kind** calls a server's tool instead of running a command: `server`, `tool`,
  and an `input` whose `${path}` parts are filled in from the event's input, with Claude Code's
  600 s default limit. Its answer is read as a command hook's printed output is.
- **A hook's own call never fires hooks** (the design review, finding 3). An `mcp_tool` hook calls
  the server directly, not through the model's tool path, so no PreToolUse, PostToolUse or
  PostToolUseFailure hook sees it, and a catch-all hook that calls a tool cannot call itself. As
  for a command hook, which comes only from the user's own settings file, no question is asked.
  What still holds: only a server that is running can be called, so a project's server the user
  has not said yes to, and a server the sandbox's network rule stopped, cannot be; Esc and the
  hook's time limit stop the call and tell the server it was cancelled; the answer is cut as any
  hook's is.
- **Elicitation and ElicitationResult**, with Claude Code's input, matched on the server's name.
- `/hooks` and Ctrl+O name an `mcp_tool` hook by its server and tool, such as
  `tradingview quote_get`, as 8b's short names do.

## What the user sees

- **`/mcp`** lists each server on one line, by its name, with only what is worth saying (the
  user's rule since 8b's `/hooks`):

  ```
  tradingview · 78 tools · trusted
  sanity · 31 tools
  openmarket · needs sign-in
  build-tools (project) · waiting for your yes
  figma · failed: <reason>
  ```

  (The counts here are made up for the example.) Picking a server offers Reconnect, Sign in or
  Sign out, Show tools, and for a project's server Reset my answer.
- **Resources:** `@` lists the servers' resources after the files, as `@sanity:doc://...`; a picked
  resource's text joins the prompt, cut at 30,000 characters.
- **Prompts:** `/tradingview:analyze AAPL 1D`, the words filling the prompt's arguments in order,
  as in Claude Code; listed in `/` completion.
- **Ctrl+O** shows MCP calls as it shows other tools.
- **In `-p`,** failures and skipped servers go to stderr, and `--json` gets `mcp-note` lines, as
  hooks have `hook-note`.

## Known limits

- Servers run with the user's full permissions, on the user's machine, until 8c-2.
- `trusted` is the user's word; Tachikoma cannot see what a tool does.
- The numbers are Claude Code's, not measured for Tachikoma.
- Servers that need a client secret, `ws` servers and `headersHelper` are not supported.
- Claude in Chrome cannot be used: it is part of Claude Code, not a server Tachikoma can start.

## Testing

- Unit tests: reading entries and `${VAR}`, the user's entry over a project's, the approval table
  in all four modes and `-p`, subagents' trusted-only tools, the answer's cut, pictures and
  structured data, `mcp__...` matchers.
- Names (the design review, findings 1 and 2): a name of 64 characters kept and one of 65 left
  out, with the server's other tools still sent, and the same tool list after `/lead` switches to
  an OpenAI-format provider; `foo.bar` beside `foo_bar`; server `a__b` beside server `a` with tool
  `b__c`; a late-starting server, and a changed list, whose name is already in use.
- Calls that wait (finding 4): a restart, and a changed list, while a call waits for its question;
  each is refused, never run on the new version; trust removed while a call waits for its hooks.
- Hooks that call tools (finding 3): a catch-all PreToolUse and PostToolUse `mcp_tool` hook on a
  fake server, each model call causing exactly one call by each hook.
- Small fake servers the tests write and start themselves, over stdio and over HTTP on the
  machine's own address, and a fake sign-in server; the tests never start the user's servers or
  touch the user's files.
- Session tests with a stand-in model, no network: a call through the gate, Esc stopping a call, a
  changed tool list, a server that dies, a form, a live edit, a project server asked in the window
  and skipped in `-p`.
- The user's terminal checklist: TradingView and MemPalace locally, Sanity or Figma by header,
  openmarket by sign-in.
- CI runs it all on Windows for the pull request.

## Not in this release, and when

| Left out of 8c | When |
|---|---|
| Servers inside the sandbox; each worker's own servers; the list of allowed sites and its proxy; the name-lookup measurement (main design, "Still to measure" 15) | 8c-2 |
| Tool search | Decided from the first task's measurement |
| MemPalace as Tachikoma's own server | 8d |
| `headersHelper`, `ws`, client secrets, sampling | Not planned: the user's servers do not use them |
| Claude in Chrome | Not planned: it is built into Claude Code |

## As built

Where the build differs from the design above, or settles what it left open. The plan
(`2026-11-10-tachikoma-release-8c.md`) lists its 62 choices, each marked in its task, with every
line the build added in its table "Lines this plan adds"; every number here is from the plan's
table "Numbers in this plan" or from the code's comments, as cited there. "The user's choice"
marks the user's answers, given on 2026-11-10 and 2026-11-11 from options offered. The README's
known limits gather every rarer case the build left as a limit.

- **The two "To confirm" points** stand as proposed: a server has 30 s to start, Claude Code's
  `MCP_TIMEOUT`, and a description sent upfront is cut at 4,096 characters (choice 1, approved
  with the plan).
- **The settings entry (Task 2).** As Claude Code's MCP page says: `timeout` is a whole number of
  ms, one below 1,000 is ignored as unset, and one above 2,147,483,647, Node's longest timer, is
  refused; `scopes` is one string split by spaces, not a list; `authServerMetadataUrl` must be
  `https://`. A wrong value is named by its type, not shown, as it may hold a key; only the short
  fields that carry none (`type`, `timeout`, `trusted`, `trustedTools`, `alwaysLoad`,
  `callbackPort`) show their value. A header with a line break, and an `env` value or argument with
  NUL, leave the server out by the field's name, as Node's own error would quote the value. `ws`
  is left out with its line, as MCP itself has no WebSocket transport (the user's choice).
- **A project's servers (Tasks 3 and 9; choices 23, 24, 48-50).** An answer holds the entry as
  written, by its SHA-256 before `${VAR}` is filled, so a pulled change to the entry asks again and
  a variable's new value does not (the user's choice; the design said once per name, as Claude
  Code). The question shows the entry as written, `${VAR}` unfilled, and for a local server the
  names of the variables it sets, never their values, as `NODE_OPTIONS` can make a known program
  run the project's code (the user's choices). An answer that cannot be saved holds for the launch,
  with one red line; before, it crashed every launch in that project. With the sandbox's network
  off, no question is asked, as no server could start.
- **Finding programs (Task 3; choice 4).** On Windows each PATH folder is tried with PATHEXT's
  endings in its order, so `npx` finds `npx.cmd`; a name that already ends in one is taken as
  written. The lookup is MCP's own (`mcpProgram`); hooks keep `.exe` only.
- **Connections (Task 4; choices 3, 5, 13, 33).** A call's limit is hard: progress never extends
  it (the user's choice). A failed server's reason is its last error line, with Node's own closing
  lines (its version, the error's fields block, stack lines) passed over (the user's choice). A
  dropped remote server gets one new connection per drop, not one in all (the user's choice, "Once
  per drop"): at the start of the next call, before its question, so a yes is for the version that
  runs (plan review, finding 3); and when a call never reached the server, it is sent again once
  without a new question, as the approved call never ran (the user's choice, "Reconnect, then
  retry"). Its stopped line is said only when that new connection fails. Off Windows the library
  starts a server outside a process group, so only the server itself is killed at exit.
- **Names and schemas (Task 5; choice 36).** The design's names rules are built as written. Added
  from the plan review: a root-level `anyOf`, `oneOf` or `allOf` is merged into one object schema,
  with a sentence for the model, and a tool whose schema is still not an object, has a property
  name providers refuse, or cannot be compiled is left out with its line. Task 1's measurement of
  the user's servers (180 tools, about 58,000 tokens) found no name over 64 characters.
- **Tool search (Task 6b; choices 37-46).** The design left it to the measurement; at 29% of a
  200,000-token window the user chose it always on, through Tachikoma's own `tool_search` tool for
  every provider. A request names every MCP tool in that tool's description and defines only the
  ones loaded; a search returns 5 by default, Claude Code's, and loads at most what fits its
  30,000-character answer. A tool loaded by search is cut at 16,384 characters, Claude Code's
  figure, and one with `alwaysLoad` at 4,096. The loaded set is saved in the transcript, kept by a
  resume, `/branch` and a shortening, and emptied by `/clear`. Because Anthropic's 5.x models
  refuse thinking made under another tool set, the replies before the latest change of tools go
  without their thinking (the user's choice, "Drop older thinking"; the user's live test,
  2026-11-11, saw the refusal and the fix).
- **Answers (Task 6; choices 10-12, 34).** A tool's pictures are numbered on from the
  conversation's highest picture, and named in a line at the end of its text; other kinds of
  content get one line each; structured data alone goes as its JSON text. A resource's text and
  pictures, a prompt's messages and a tool's pictures are marked as the server's, so the judge,
  UserPromptSubmit, the Up history and a resumed window see only what the user typed (plan review,
  finding 2).
- **Approval (Task 7; choices 14-17, 32, 47).** `never` asks, as the design says, which needed
  the gate's `never` branch itself changed (plan review, finding 1). The question's grey note is
  the tool's own description, cut to one screen row; the input is shown whole, escaped, as a shell
  command is. In `-p` with `auto` the judge decides an MCP call, as for any action; the design's
  table said refused. In `never`, a PreToolUse hook's ask on an MCP call becomes the user's
  question (the user's choices).
- **Hooks (Task 8; choices 18-22, 35).** An `mcp_tool` hook's answer is read as a command hook's
  printed output; one whose server is still starting is waited for at the events that can block,
  and fails with "is not running" at the others. At Elicitation and ElicitationResult a decline
  wins over a cancel, and a cancel over an accept; exit 2 declines (plan review, finding 4). A
  string `updatedMCPToolOutput` drops the answer's pictures with the text it replaces.
- **The launch (Task 9; choices 25, 26).** The first prompt waits for the servers through the
  SessionStart wait, so one Esc stops both. MCP's lines are a new bus event, `mcp-note`, and a new
  error kind, `mcp`, which never fails a `-p` run. Servers start once the window's first frame is
  drawn, so their lines are heard; SessionEnd runs before they stop, so its `mcp_tool` hooks can
  still call them. A resume compares only Tachikoma's own tools with the saved set, so MCP tools
  do not strip a resumed session's thinking.
- **`/mcp` (Task 10; choices 27, 51, 52).** Hint rows name the keys, as `/resume`'s do (the user's
  choice). A row's count is the tools offered; the left-out ones are under Show tools. Reconnect
  is offered for a ready, failed or stopped server and keeps the list open, which redraws as states
  change. A reset that cannot be written keeps the answer, with one red line (the user's choice).
- **Sign-in (Task 11; choices 28, 53-60).** The return address is Claude Code's,
  `http://localhost:<port>/callback`, on both `127.0.0.1` and `::1`, so a fixed `callbackPort`
  copied from Claude Code signs in unchanged. An entry's headers go only to its server's own
  address, never to the sign-in service. An entry with its own `Authorization` header is never
  signed in: its 401 stays a failure that points at its key; other headers do not stop a sign-in.
  `authServerMetadataUrl` replaces discovery, as in Claude Code. A damaged `mcp-auth.json` counts
  as empty, with one red line that never quotes it (all the user's choices). Figma's remote server
  registers only apps on its own list and answered 403, so the reason says so; Tachikoma never
  registers under another app's name, and Figma is reached through its desktop app's server,
  `http://127.0.0.1:3845/mcp`, which needs no sign-in (the user's choices, 2026-11-11).
- **Forms (Task 12; choices 29, 61).** A whole number, a minimum and a maximum each have their own
  wrong-answer line, and a pick has a hint row (the user's choices). A visit to an address that is
  not `http` or `https` is declined unasked, with a red line, as Windows' opener starts a program
  from a `file://` address and the library lets it through.
- **Resources and prompts (Task 13; choices 30, 31, 62).** A missing argument's line ends with the
  command's usage. The screen and `/export` show only what was typed, and a resource's picture is
  a grey `⎿ [Image #N]` row. A resource or prompt of a server that is not ready stops the send with
  `<name> is not ready (<state>)`, and is fetched after the first-prompt wait and UserPromptSubmit
  (the user's choices).
- **Not built, as the design says:** servers in the sandbox and the allowed sites (8c-2); `ws`,
  client secrets and sampling. `headersHelper` is left out with its line, which says "(planned)";
  where the table above says not planned, the user put it in 8c-2 (2026-11-11: "If it's planned
  then say planned").
