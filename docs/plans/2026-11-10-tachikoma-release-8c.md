# Tachikoma Release 8c (the MCP client): Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to build this
> plan task by task: a fresh builder per task, then a spec review, then a code review.

**Goal:** the user's MCP servers, written in Claude Code's shape under `"mcpServers"` in
`~/.tachikoma/settings.json` or in a project's `.mcp.json`, start with Tachikoma, and their tools,
resources, prompts and forms work as they do in Claude Code, under Tachikoma's approval rules.

**Architecture:**
- **A new folder, `src/mcp/`,** holds everything that knows MCP:
  - `config.ts` reads the settings entry and `.mcp.json`;
  - `answers.ts` keeps the user's yes or no for each project server;
  - `server.ts` is one server's connection, local or remote, through the library's `Client`;
  - `servers.ts` is the `Servers` object: every server, the table of tool names, and the changes;
  - `tools.ts` turns a server's tools into Tachikoma tools, and their answers into results;
  - `auth.ts` is sign-in for remote servers; `forms.ts` is elicitation.
- **One `Servers` object per window,** made in `cli.tsx` before the session, as the `Hooks`
  object is. A live edit changes the servers in place, so everything that holds it stays valid.
- **The session asks `Servers` for the current tools at each request,** and keeps the list that
  request carried, so a call runs only on the tool the model was shown (design, "Tools for the
  model", finding 4).
- **Tachikoma's own checks stay where they are.** An MCP call goes through the permission gate as
  a new kind of action, `mcp`, and through 8b's hooks under its `mcp__...` name.

Design: `docs/plans/2026-11-10-tachikoma-release-8c-design.md`, with its review's four fixes
(d3dccc2).

**Tech stack:** as release 8b (TypeScript 7.0.2, Ink 7.1.1, React 19.3.0, Vitest 5.0.3,
ink-testing-library 4.0.0, zod 4.6.7), plus `@modelcontextprotocol/client` 2.4.0, the one new
package, installed in Task 1 through `sfw` with the user's say-so.

---

## Before you start

**How this plan is built.** As release 8b, each task gives the files, the interfaces, the
behaviour and the tests, and each test says what it must show. A builder writes the tests first
and sees them fail, then writes the code, then commits. A spec reviewer and then a code reviewer
check the commit before the next task starts. The plan has four parts:
- **Part 1, groundwork (Tasks 1-4):** the library and the measurement, the settings entry, the
  project's answers and finding programs, and one server's connection.
- **Part 2, tools (Tasks 5, 6, 6b, 7, 8):** the `Servers` object and its names, tools in the
  session, tool search (added after Task 1's measurement), approval, and hooks.
- **Part 3, the window and `-p` (Tasks 9-13):** the launch, `/mcp` and live edits, sign-in,
  forms, and resources and prompts.
- **Part 4, the documents (Task 14).**

**Two stops for the user.** Task 1 needs the user twice: to say yes to the install, and to run the
measurement script in their own terminal, as it starts their servers and uses their keys. After
it, the user decides tool search with the numbers (design, "Tool search"), and this plan is
updated before Task 2 starts. Task 14's checklist is the user's too. **Done 2026-11-10:** the
library is in (a20dac6), the measurement is under "Numbers in this plan", and the user chose tool
search, always on, through Tachikoma's own lookup tool for every provider (Task 6b).

**The branch.** Build on the local branch `release-8c` (main 54a30f7 plus the design, head
d3dccc2 or later). Do not push: every push needs the user's fresh say-so, and main takes changes
only by pull request, which needs CI's `test` check to pass.

**Checks, from the repo's folder:**
- Types: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
- One file: `node node_modules/vitest/vitest.mjs run tests/mcp/config.test.ts`
- The App's tests, only with `-t`:
  `node node_modules/vitest/vitest.mjs run tests/tui/app.test.tsx -t "App's MCP"`. The file has
  over 500 cases; never run it whole for a task.
- Build: `npm run build`
- **The whole suite runs once at the end of each part, not after each task** (user, 2026-10-31).
  A builder runs the test files the task touches, plus any file that imports a module the task
  changed. Never run `tests/tui/external.test.ts`: it opens real programs.

Each test's limit is 15 s unless it sets its own (`vitest.config.ts`, PR #16, measured on CI).
A time-out on a busy machine is not a failure of this release if the file passes run alone.

**Rules for every task:**
- **Tests first,** seen failing for the right reason, then the code. One commit per task, plus
  `fix:` commits for review findings.
- **Tests never touch the user's own things.** No test reads or writes the user's own files
  (settings, keys, history, data folder, git settings, `~/.claude`, `~/.claude.json`), starts the
  user's own servers, runs the user's own hooks, contacts a provider, or uses the network beyond
  the machine's own address (`127.0.0.1`).
  - A server in a test is a small Node script the test writes into its own `mkdtemp` folder,
    speaking MCP's JSON-RPC by hand (Task 4's `tests/mcp/fake.ts` writes them), started with
    `command: process.execPath` and `args: [script]`. A remote one is a Node `http` server the
    test starts on `127.0.0.1`, port 0.
  - Every test that saves sessions or answers uses a data folder two levels inside a fresh
    `mkdtemp` folder, as release 8a's tests do.
- **Never change permissions** on any file or folder (no `icacls`, `chmod`, ACL calls), in a test
  or by hand. Private files go through `src/auth/private.ts`, as the ChatGPT sign-in's do.
- **Deletes:** code deletes only files Tachikoma named, never follows a link. A builder deletes
  only files they made, by exact name.
- **No package installs, and no fetch from any registry,** except Task 1's one install, through
  `sfw`, after the user's yes. If `sfw` is not on PATH, stop and tell the controller.
- **Windows tools whose switches start with `/`** run from PowerShell or Node, never Git Bash.
- **Match the code around you.** Use plain-language comments that say why, citing the design's
  section ("release 8c design, \"Approval\"") or this plan's choice ("release 8c plan, choice
  6"). No comment restates the code. Code lines go up to 160 columns; prose in docs up to 100.
- **Every number in the code has its source in a comment:** Claude Code's docs, the library, the
  design, or this plan's table "Numbers in this plan".
- **Every user-visible line is triggered for real in a test,** and its exact words checked. Its
  words are the ones in "Lines this plan adds", which the user approves with the plan.
- **Everything a server sends that reaches the screen** (names, descriptions, messages, form
  titles, error text) goes through `visible(text, { tabs: true })` first, as hook lines do, so it
  cannot pass for one of Tachikoma's lines (design, "Forms").
- **Commit messages:** `feat: ...`, `fix: ...`, `docs: ...`, `test: ...`, `refactor: ...`, ending
  with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_011HyFwQ2thF7f21RYDJiE97
  ```

**Facts the tasks rely on** (read 2026-11-10 by a read-only survey of the code at 864154c, which
54a30f7 changes only in `src/exec/local.ts`'s PowerShell line; from Claude Code's docs that day;
and from the library's package, read unpacked without installing):

**Settings** (`src/settings.ts`)
- `readSettings` (76-116) runs one if/else chain over the entries; each is named
  ``settings.json: "<name>"`` (82). A wrong JSON type throws through `wrongType` (151), and the
  whole file becomes `{ problem }` (112-114). An unknown name is a warning (110). `hooks` is read at
  106 by `readHooks(entry, value, warnings, leftOut)`.
- Live edits: `watchSettings` (`src/settingsWatch.ts:42-88`); `liveEdits().onSettings`
  (`src/tui/app/liveEdits.ts:24-41`) prints a problem red and each new warning grey, then diffs
  each LIVE name with `same()` and calls `applyEntry` (65-166); hooks apply at 139-158. LIVE is
  `src/tui/app/constants.ts:116-120`.

**Tools and the session**
- `Tool` = `{ spec; run(input, ctx): Promise<string>; parallel? }` (`src/tools/tool.ts:17-21`);
  `ToolContext` = `{ root, executor, workspace, gate, signal?, report?(parts) }` (7-15);
  `defineTool` (35-40) throws `InvalidInput` on bad input.
- The lead's tools are built at `cli.tsx:610-614` and passed as `SessionOptions.tools`
  (`session.ts:99`). Each request sends `this.opts.tools.map((t) => t.spec)` (`session.ts:659`,
  and 727 in the shortening request). The parallel check (579) and the run (840-841) look a call
  up by name in `this.opts.tools`; an unknown one fails `Unknown tool: <name>`.
- `#execute` (828-889): `#preToolUse` (984-1038) first; then `tool.run` with the call's own gate
  (865), its text cut by `truncate` to `MAX_TOOL_OUTPUT`; `Declined` → declined, an abort →
  cancelled, any other throw → `fail()` and PostToolUseFailure, but not for `InvalidInput`
  (867-880); then PostToolUse (884-888).
- A result is `{ type: "tool_result", callId, output: string, isError }` (1073-1075). All results
  go back as one user message with the hooks' text and the inbox (589).
- **No pictures in a tool result today:** `output` is a string (`types.ts:12`), and `run` returns a
  string. The OpenAI-format adapter already sends a user message's tool results first, then its
  other parts, pictures as `image_url` (`openai.ts:69-80`); Anthropic sends each part in order,
  a picture after its marker (`anthropic.ts:22-38`).

**Providers:** `ToolSpec = { name; description; inputSchema }` (`types.ts:63-67`). Anthropic sends
`{ name, description, input_schema }` (`anthropic.ts:191`); OpenAI format `{ type: "function",
function: { name, description, parameters } }` (`openai.ts:143`) for openai, openrouter, kimi and
ollama; ChatGPT puts every tool inside one namespace `tachikoma` (`chatgpt.ts:25, 132-142`).
Anthropic counts tokens with `countTokens` (`anthropic.ts:177-179`).

**The gate** (`src/core/permissions.ts`)
- `Action = { kind: "read" | "write" | "shell"; outside; summary; detail?; command?;
  protectedPart?; path? }` (18-28). `needsApproval` (41-46): `never` → false; outside → true;
  `ask` → anything but a read; `project` and `auto` → shell only.
- `require` (235-273): `never` refuses protected parts, outside writes and dangers; a hook's gate
  skips the ordinary question (250); `auto` goes to the judge (254-255); a no throws
  `Declined("<refusal>: <shown>")` (263).
- `-p`'s ask prints `headlessDeclined` and says no (`cli.tsx:563-569`): "Not allowed in -p mode,
  where nobody can approve it".
- The judge (`src/safety/judge.ts`) sees `{ kind, outside, summary, detail, command,
  protectedPart }` (58-68), never tool outputs.
- Subagents: `ctx.gate.for(owner, ...)` (`tasks.ts:253`); their tools are `SUBAGENT_TOOLS`
  (`cli.tsx:602`; read_file, find_files, search_files).

**Hooks** (`src/hooks/`)
- `EVENTS` (`config.ts:9-10`) has 11 events; `hookOf` (93-143) leaves out any `type` but
  `"command"` with ``has a "<type>" hook; only "command" hooks run, so it was left out`` (97-102).
  `matcherOf` (148-152) and `matches` (155-159) are Claude Code's rules.
- `Hooks.fire(event, fields, { match?, signal? })` (`hooks.ts:134-207`). `hookName`
  (`answer.ts:64-76`) names a hook for `/hooks` and Ctrl+O.
- `tools.ts`: an unknown tool goes to hooks under its own name with its input unchanged (151);
  `fromClaude` refuses a rewrite of one (169); `responseOf` gives its text (237-249); `outputFrom`
  gives null (266-277).

**The launch** (`src/cli.tsx`): settings at 349-351; the instructions question at 528-543
(`askAtStart`, a y/n before the window, 166-181); `sandboxStart` at 547-557; the gate at 562-577;
Hooks at 581-592; Tasks at 596-607; tools at 610-614; `-p` at 654-728 (`--json` lines through
`jsonLine`, clilib.ts:56; errors to stderr at 671-677, `hook-note` as `note: ...` at 680; exit
code at 728); the window at 729-846. `options.network` is `off` unless `--network on` or the
setting (`clilib.ts:160, 176`); nothing outside the sandbox reads it.

**The first prompt waits for SessionStart** (`session.ts:258-276, 382`): `session.start` keeps
`#starting`, and the first `#turn` waits on it through `settled` (73-83); Esc aborts the wait, and
the turn sends nothing.

**The TUI**
- `isCommand` (`constants.ts:108`) takes a name in `NAMES` or `/^\/[a-z]+$/i`, so `/x:y` goes to
  the model as a message today. `perform` (`queue.ts:90-212`); an unknown `/word` is red
  "Unknown command..." (160). `/hooks` prints its list (238-251).
- The `/` menu is a static list (`menus.ts:26-46`); the `@` menu reads folders (62-97), wired in
  `promptKeys.ts:173-187`; a picked `@path` stays plain text.
- Yes/no questions: `Ask` (`permissions.ts:85`), `Question` (`constants.ts:20-32`), rendered by
  `allow(what, plain)` (`App.tsx:577-582`). **There is no free-text question today.**
- Pickers: `ModelPicker` (`src/tui/ModelPicker.tsx:36-150`) and `SessionList`, under the phase
  `picker`, opened through `ui.setPicker` (`queue.ts:184-190, 464-470`); `Menu.tsx` draws a list.

**Sign-in** (`src/auth/`): `chatgpt.json` and its lock in the data folder (`store.ts:113-114`),
updated under `withLock` (200-217); `writePrivate`/`readPrivate` (`private.ts`); PKCE and a
callback server on `127.0.0.1`, port 0 (`oauth.ts:67-153`); the browser opened by `openBrowser`
(`chatgpt.ts:23-27`), the address printed too.

**Processes:** `onPath(name, env)` (`src/exec/env.ts:53-65`) looks only for `<name>.exe` on
Windows. `killTree` (`local.ts:26-39`); `running` and its kill at exit (43-44); `commandEnv`
drops Tachikoma's API keys (`env.ts:7-12, 36-43`); `MAX_TOOL_OUTPUT` = 30,000 (`executor.ts:3`).

**The bus** (`src/core/bus.ts`): events at 23-42, `hook-note` among them; error kinds at 10.

**The library, `@modelcontextprotocol/client` 2.4.0**
- `new Client(info, { capabilities, listChanged, ... })`; `connect(transport)`, `close()`,
  `listTools()`, `callTool(params, { signal, timeout, resetTimeoutOnProgress, onprogress })`,
  `listResources()`, `listResourceTemplates()`, `readResource()`, `listPrompts()`, `getPrompt()`,
  `setRequestHandler(method, fn)` for `elicitation/create` and `roots/list`,
  `sendRootsListChanged()`.
- **Every request's limit is 60 s unless the call gives its own** (`DEFAULT_REQUEST_TIMEOUT_MSEC`),
  `callTool` too, so Tachikoma always passes `timeout`.
- `listChanged: { tools: { onChanged(error, tools) }, prompts, resources }` re-reads a list when
  the server says it changed, waiting 300 ms by default for more (`debounceMs`).
- `StdioClientTransport` from `@modelcontextprotocol/client/stdio`: `{ command, args, env, stderr,
  cwd }`; started with `cross-spawn` (so a `.cmd` runs through `cmd.exe`), `windowsHide` on
  Windows; its `env` is laid over a short default list (PATH, HOME and the like, no keys); `pid`;
  `close()` ends its input, waits 2 s, then SIGTERM, 2 s, then SIGKILL, and never kills the
  server's children. Its input buffer holds 10 MB by default (`maxBufferSize`).
- `StreamableHTTPClientTransport(url, { requestInit, authProvider })` and `SSEClientTransport`;
  `OAuthClientProvider` (`redirectUrl`, `clientMetadata`, `clientInformation`,
  `saveClientInformation`, `tokens`, `saveTokens`, `redirectToAuthorization`, `saveCodeVerifier`,
  `codeVerifier`, `invalidateCredentials`); `auth()`; `UnauthorizedError`.
- Its README: with TypeScript 6 and later, `"types": ["node"]` is needed, which Tachikoma's
  `tsconfig.json` already has.

**Claude Code's docs** (MCP, hooks, env-vars and permissions pages, read raw 2026-11-10):
- `MCP_TIMEOUT` 30,000 ms for a server to start; `MCP_TOOL_TIMEOUT` 100,000,000 ms (about 28 h)
  for a call; a remote server's requests 60 s.
- Names `mcp__<server>__<tool>`, other characters made `_`; over 128 characters a tool is left out.
  Descriptions are cut at 4,096 characters.
- At exit on Windows, a local server's input is closed, and its tree killed 300 ms later.
- Claude Code sets `CLAUDE_PROJECT_DIR` in a local server's environment.
- Hooks: `mcp_tool` takes `server`, `tool`, `input` with `${path}` filled from the hook's input;
  600 s by default, 30 s at UserPromptSubmit; "the tool's text output is treated like
  command-hook stdout"; `isError: true` is a non-blocking error; on events that can block it waits
  for a server still starting, at most `MCP_TIMEOUT` and within its own limit, and on the others
  it does not; at the launch's SessionStart, `mcp_tool` hooks are skipped; it never starts a
  sign-in.
- Elicitation: input `mcp_server_name`, `message`, `mode`, `url`, `elicitation_id`,
  `requested_schema`; output `hookSpecificOutput.action` `accept` (with `content`), `decline` or
  `cancel`, none to leave it to the user. ElicitationResult: input adds `action` and `content`; its
  `action` replaces the user's; it does not run when an Elicitation hook answered. Both match on the
  server's name.
- PostToolUse takes `updatedMCPToolOutput` for MCP tools, beside `updatedToolOutput`.
- A matcher `mcp__memory__.*` picks one server; a bare `mcp__memory` matches nothing.

## Numbers in this plan

| Number | Where | Source |
|---|---|---|
| 30 s | a server's start: connecting and its first lists | Claude Code's `MCP_TIMEOUT`; the design's **To confirm**, settled by the user's approval of this plan |
| no limit | a local server's call, unless the entry sets `timeout`; passed to the library as 2,147,483,647 ms, the longest wait Node's `setTimeout` takes (as 8b's hook `timeout`) | the design, "Tools for the model"; Claude Code's `MCP_TOOL_TIMEOUT` is about 28 h |
| 60 s | a remote server's single request, unless the entry's `timeout` is longer | Claude Code's MCP page; also the library's own default |
| 300 ms | from closing a local server's input to killing its tree, at exit and at a restart | Claude Code's MCP page, Windows |
| 4,096 characters | a tool's description, as sent to the model upfront and to the judge; the server's own text is kept whole and each view cuts its own copy (the tool-search re-review) | Claude Code's MCP page; the design's **To confirm**, settled by the user's approval of this plan |
| 64 characters | the longest tool name, for every provider | OpenAI's Chat Completions reference (design, finding 1) |
| 30,000 characters | a tool's text answer, a resource's text, a server's kept error output | `MAX_TOOL_OUTPUT`, executor.ts:3 (option chosen: "As a command's") |
| 600 s, 30 s | an `mcp_tool` hook's limit; 30 s at UserPromptSubmit | Claude Code's hooks reference, "Common fields" |
| 300 ms | the wait for more list changes before reading a list again | the library's `debounceMs` default |
| 10 MB | a local server's longest single message | the library's `maxBufferSize` default |
| 16,384 characters | a tool's description when it is loaded through `tool_search` (Task 6b); 4,096 stays for a tool loaded upfront (`alwaysLoad`) and for server instructions | Claude Code's MCP page, "Tool search for MCP server authors" |
| 5 | how many tools a `tool_search` query returns unless it asks for another number | Claude Code's own ToolSearch tool, its `max_results` default |

**Task 1's measurement** (2026-11-10, the user's own servers, run by the user; script and results
in the session's scratchpad, `measure8c\`; tokens by Anthropic's `countTokens` on
`claude-opus-5-5`, the tool list alone):

| Server | Kind | Tools | Tokens | Characters | Longest name | Longest description |
|---|---|---|---|---|---|---|
| tradingview | local | 84 | 13,691 | 31,233 | 45 | 395 |
| mempalace | local | 35 | 7,686 | 18,146 | 45 | 465 |
| Sanity | remote, header | 61 | 36,703 | 90,816 | 51 | 1,561 |
| together | | 180 | 58,080 | 140,195 | | |

- No name is over 64 characters, no description over 4,096, and no schema has a root-level
  `anyOf`, `oneOf` or `allOf`: choice 36 and the 64 rule leave none of these tools out.
- Figma answered "Unauthorized": its plugin signs in, so it is measured with openmarket once
  Task 11's sign-in is built.
- Sent whole, the lists add about 58,000 tokens to every request, 29% of a 200,000-token window.
  The user chose tool search, always on, through Tachikoma's own tool for every provider
  (2026-11-10).
- **Found by the script's dry run:** the library refuses a server's whole `tools/list` answer if
  one tool's `inputSchema` lacks `"type": "object"` at its root ("Invalid result for tools/list ...
  expected \"object\""). Task 5's schema checks therefore see only lists that passed that rule;
  such a server fails to start with the library's words as its reason, a known limit (none of the
  user's servers does this).

No other number is set. Anywhere a builder feels a number is needed, they stop and ask the
controller, who asks the user.

## Choices this plan makes that the design leaves open

Each is marked in its task. The user approves them with the plan.

**Servers**
1. **The design's two "To confirm" points** stand as written (a 30 s start, a 4,096-character
   description cut), unless the user says otherwise when approving this plan.
2. **The library's own transports** are used for local and remote servers. Tachikoma hands the
   stdio one the program's full path (Task 3), `commandEnv()` plus `CLAUDE_PROJECT_DIR` (as Claude
   Code sets it) plus the entry's `env`, the project's root as its folder, and `stderr: "pipe"`.
3. **Stopping a local server** (at exit, a restart, a removal): Tachikoma calls the transport's
   `close()`, which ends the server's input, and 300 ms later, if the server is still running,
   kills it. On Windows that is `taskkill /T /F` by its `pid`, which takes its children too. Off
   Windows the library starts the server outside a process group, so only the server itself can
   be killed (`SIGKILL`); its children are a known limit. Each server's `pid` joins the kill at
   exit (`running`), so a crash of Tachikoma also stops it.
4. **A program is found** on Windows by looking, in each PATH folder, for the name with each of
   PATHEXT's `.com`, `.exe`, `.bat` and `.cmd` endings, in PATHEXT's order (`.COM;.EXE;.BAT;.CMD`
   when PATHEXT is unset, Windows' own start), so `npx` finds `npx.cmd`. A name that already ends
   in one of those endings, in any letter case (`node.exe`, `npx.cmd`), is looked for as written,
   in the same PATH folders, with nothing added (the plan's re-review). Elsewhere, as `onPath`
   does. A command with a folder in it is used as written. This lookup is MCP's own (`mcpProgram`
   in `src/exec/env.ts`); hooks keep `onPath`.
5. **A server's error output** is kept in memory, its newest 30,000 characters, and its last line
   that is not blank is the reason a failure line gives. It is not written to a file.
6. **A local server that exits** gets its exit code, or its signal, in its line.

**Names and tools**
7. **The table of names** is rebuilt whenever a server's tools change; a name keeps its owner as
   long as that tool is offered, so a late server or a changed list never takes a name already in
   force (design, finding 2).
8. **A tool's definition**, for finding 4's check, is the JSON text of its whole description, as
   the server sent it, and its input schema; never a cut view, so loading a tool through search
   (16,384) or upfront (4,096) never makes it look changed. A server that sends the same tool with its fields in a new order counts as a
   change; the call is refused once and the model looks again, which costs one round.
9. **The tools a request carried** are kept with that request: the session takes
   `servers.offer()` once per request, sends its specs after Tachikoma's own, and runs each call
   of the reply against that offer. A shortening request carries the same offer as the turn's.
10. **Pictures in an answer** go as `image` parts after the tool results, in the same user message,
    numbered on from the highest picture number in the conversation, so their markers read
    `[Image #N]` as the user's do; the result's text ends with a line naming them,
    `[The tool's answer has pictures: [Image #4], [Image #5]]`. They pass through the provider's
    picture limits as pasted ones do. The window's `Pictures` takes its next number from the
    conversation, so a picture pasted later never reuses one.
11. **Other kinds of content in an answer** (audio, a resource link, an embedded resource): a
    resource's text is taken as text; anything else is named in one line,
    `[The tool's answer has a <kind> part, which Tachikoma does not pass on]`.
12. **`structuredContent` with no text** is sent as its JSON text; with text, the text is sent and
    the JSON left out, as the text is the server's own rendering of it.
13. **A remote server whose connection drops** is tried once more at its next call: one new
    connection, then the call. If that fails, the server is `stopped` (design, "Starting and
    stopping servers").

**Approval**
14. **The question** is the gate's yes/no, `Allow <server>: <tool> <input as JSON>?`, the input
    cut and escaped as the gate shows any command, with the tool's description as the grey note's
    first line, cut to one line.
15. **The judge** is sent the tool's description, cut at 4,096 characters, in a new `Action`
    field, `description`, which the question never shows whole.
16. **Trust is read in `run`, right before the gate decides,** from the live settings, so a live
    edit takes effect for every call not yet decided. A trusted call skips the gate's question and
    the judge in every mode, but not a PreToolUse hook's `ask`, which is asked before `run`.
17. **A subagent's call to a tool no longer trusted** is refused, as subagents only read.

**Hooks**
18. **`tool_input`** is the call's arguments; **`tool_response`** is the text the model reads, as
    8b's choice 11 does for tools whose shape Claude Code does not give.
19. **A PreToolUse rewrite of an MCP call** is taken when `updatedInput` is an object: it becomes
    the call's arguments, the question shows it, and the definition check still runs.
20. **`updatedToolOutput` or `updatedMCPToolOutput`** that is a string replaces the text the model
    reads, and the answer's pictures are dropped with it; anything else is ignored, as 8b's
    choice 13 does.
21. **An `mcp_tool` hook's answer** is read as a command hook's: its text as the output with exit
    code 0. An `isError` answer is a failed hook, which never blocks (Claude Code's rule), its line
    below. On the events that can block, a hook whose server is still starting waits for it,
    within its own limit; on the others it fails at once with "is not running". At the launch's
    SessionStart, `mcp_tool` hooks are skipped without a line, as Claude Code's are.
22. **`${path}`** in an `mcp_tool` hook's `input` strings is a dotted path into the hook's input
    (`${tool_input.file_path}`); a path that is not there becomes empty text, a whole-value path
    that names an object or a list becomes its JSON text.

**The window and `-p`**
23. **A project's server is asked about at the launch,** after the instructions question, one
    `askAtStart` question per server not yet answered, before the window opens. A no is kept too,
    and the server is listed in `/mcp` as `you said no`.
24. **The answers** go in `<data>/mcp-answers/<hash>.jsonl` (`projectFile`), one line per answer,
    `{ "name", "yes": true | false }`, the last line for a name winning; Reset my answer writes
    `{ "name", "reset": true }`.
25. **The first prompt waits** for the servers through the same wait as SessionStart's, so one
    Esc stops both, and the waiting line names what it waits for.
26. **MCP lines** go out as a new bus event, `mcp-note`, grey in the window, `note: <line>` on
    `-p`'s error output and a `mcp-note` line with `--json`; failures are a new error kind, `mcp`,
    red, `mcp: <line>` in `-p`. An `mcp` error never fails a `-p` run, as `hook` errors do not.
27. **`/mcp`** opens a picker of the servers, one row each; Enter shows that server's actions as a
    second list; Esc goes back, then closes. Show tools prints the names into the conversation, as
    `/hooks` prints its list.
28. **Sign-in tokens** are kept in `<data>/mcp-auth.json`, private, under a lock, as
    `chatgpt.json` is without `--keychain`, keyed by the server's name and address, so tokens are
    never sent to a new address under an old name.
29. **A form** asks its fields one at a time with a new free-text question in the prompt's place;
    a list field is a `Menu` pick. A form asked inside a subagent's call is headed with its id, as
    its other lines are.
30. **A picked resource** stays `@<server>:<uri>` in the prompt; when the prompt is sent, its text
    is added after the prompt as a text part headed `Resource @<server>:<uri>:`, marked as the
    server's (choice 34). One that cannot
    be read stops the send, and the words go back into the prompt box.
31. **A prompt command's words** are split on spaces, each one filling the next argument, the last
    argument taking the rest. The prompt's messages are sent in the user's message, after the typed
    command: each text, and each picture; a message from the `assistant` side is headed
    `(assistant)`. Choice 34 marks them all as the server's.

**From the plan review** (`2026-11-10-tachikoma-release-8c-review.md`, five findings)
32. **`never` asks for an MCP call** (finding 1). `require` sends an `mcp` action past its `never`
    branch, which refuses or passes the box's own actions, to the question: in `never`, `ask` and
    `project` it asks, in `auto` the judge decides, and in `-p` the ask says no, as it does for
    every question there. A hook's allow skips the question in every mode; trust skips the gate
    (choice 16).
33. **A dropped remote server is connected again before the question** (finding 3). At the start
    of `run`, before the gate, a remote server whose connection dropped, and which has not been
    tried again since, gets one new connection. If it connects and offers the tool with the same
    definition, the call is bound to the new connection and goes on to its question, so the
    approval is for the version that runs; the check after the question (finding 4) is then made
    against the new connection, as for any call. If the tool is gone or changed, the call gets
    the "changed while this call waited" line; if the connection fails, the stopped line. A local
    server is never started again by a call.
34. **What a server supplies is marked as the server's** (finding 2). Text and `image` parts gain
    `from: "server"`, which the transcript keeps: a resource's text and pictures (Task 13), a
    prompt's messages (Task 13), and a tool answer's pictures (Task 6). The user's own words stay
    what was typed, `@<server>:<uri>` or `/<server>:<prompt> <words>`: that is what the judge's
    "The user's own messages", UserPromptSubmit's `prompt`, the Up history and a resumed window's
    prompt see. The session (`session.ts:384`) and the transcript (`own`, transcript.ts:182) skip
    a part with `from: "server"` as they skip `tasks` and `hooks` parts; the providers send it as
    any text or picture.
35. **Hook answers at Elicitation and ElicitationResult** (finding 4). `answer.ts` reads
    `hookSpecificOutput.action` (`accept`, `decline` or `cancel`) and `content` (an object) at
    these two events only, and `Combined` gains `elicitation?: { action; content? }`. Exit code 2
    at either event is a decline, whatever was printed. Among several hooks, a decline wins over a
    cancel, and a cancel over an accept, as `deny` wins over `ask` and `allow` at PreToolUse; an
    accept's `content` is the first accept's in the file. `continue: false` and
    `additionalContext` are not read at these events, as there is no model text to add and the
    form's call goes on.
36. **Input schemas the providers refuse** (finding 5), as Claude Code's MCP page says
    ("Tool input schemas with a root-level combinator", "Tools with invalid input schemas"):
    - A root-level `anyOf`, `oneOf` or `allOf` is flattened into one object schema: the branches'
      properties merged; for `allOf` every branch's `required` kept; for `anyOf` and `oneOf` none
      required, and a sentence before the description says which go together (its words below).
    - A tool is left out, with its line, when after that its schema is not an object schema, a
      top-level property name is not 1 to 64 letters, digits, `_`, `.` or `-` (Claude Code's
      rule), or the schema cannot be compiled by the library's own JSON Schema checker
      (`@modelcontextprotocol/client/validators/ajv`, which checks a schema against its
      meta-schema as it compiles it). The server's other tools stay.
    - The model is not told which tools were left out, which Claude Code does: a known limit.

**Tool search** (Task 6b; the user's choices, 2026-11-10, after Task 1's measurement: "Build tool
search, always on", "Own lookup tool, every provider")
37. **Every request carries** Tachikoma's own tools, a new tool `tool_search`, and the MCP tools
    loaded so far in this conversation. Every other MCP tool is named, not defined, in
    `tool_search`'s description (its words below): per server its name, its instructions (the
    library's `getInstructions()`, cut at 4,096 characters), and its tools' full names; then the
    servers still starting, failed, or needing sign-in, with their state. With no MCP server in
    force there is no `tool_search`.
38. **`tool_search`'s input** is `{ query: string, max_results?: number }`, as Claude Code's
    ToolSearch. A query `select:<name>,<name>` loads those full names exactly. Any other query is
    words: a tool is found when one of them is in its full name or its description (letter case
    ignored); tools are ranked by how many of the words they hold, names counting before
    descriptions, then in the order offered; at most `max_results`, 5 by default.
39. **Its answer** lists each tool found, `<full name>: <description, cut at 16,384>` and
    `Input: <its schema as JSON>`, and adds them to the loaded set, so the next request defines
    them, with the same 16,384 cut of the whole text, and the model can call them. Words are
    matched against that same 16,384 cut, so a match is always in the answer. A tool already loaded is listed again and changes nothing.
    No match lists the servers that are not ready, as Claude Code's does.
40. **A search while servers are still starting** waits for them, as Claude Code's does, within
    the 30 s start and stopped by Esc, then searches what is ready.
41. **The loaded set** belongs to the conversation: saved in the transcript as a new line
    `{ t: "loaded", names }` (in `valid()`), so a resume, a `/branch` and a shortening keep it;
    `/clear` empties it. A loaded name its server no longer offers is not sent, and is loaded
    again by a search once it is back. Finding 4's check is unchanged: a loaded tool's offer
    carries its connection and definition, as any offered tool's does.
42. **`alwaysLoad: true`** on a server's entry (Claude Code's field), or `_meta["anthropic/
    alwaysLoad"]: true` on one of its tools, loads those tools upfront, defined in every request
    with the 4,096-character cut. Task 2 reads the field.
43. **Subagents** get `tool_search` over their trusted read-only tools only, starting with none
    loaded; the lead's loaded set is not theirs.
44. **`tool_search` needs no approval** (it reads Tachikoma's own list, never a server), runs
    alongside other calls, and is `ToolSearch` to hooks, with `{ query, max_results }`; its
    `tool_response` is its text.
45. **The cost,** a known limit for the README: a newly loaded tool, and a server's tools ready
    late, change the request's tool list, so the conversation is written to the provider's cache
    once more at that request.

## Lines this plan adds

The user approves these words with the plan. Each is checked word for word in a test. Grey lines
are notes; red ones are failures. `<name>` is a server's name as the settings give it, escaped.

| Where | Line |
|---|---|
| **The settings entry** (launch warnings, the server left out) | `settings.json: "mcpServers": "<name>" <words>`, and the same with `.mcp.json: "<name>"` for a project's |
| `<words>` | `has "type" "ws", which Tachikoma does not support; it was left out`; `has "type" "<type>", which is not "stdio", "http" or "sse"; it was left out`; `has "headersHelper", which Tachikoma does not run yet (planned); it was left out`; `has a "url" but no "type", so it would be a local server; add "type": "http" or "sse"; it was left out`; `has no "command"; a local server needs one, such as {"command": "node", "args": ["server.js"]}; it was left out`; `has no "url"; an "http" or "sse" server needs one; it was left out`; `needs ${<VAR>}, which is not set; it was left out`; `has the address <url>, which must start with https:// (http:// is only for localhost, 127.0.0.1 or ::1); it was left out`; `has a name that holds "__" once its characters are made safe, which tool names cannot carry; it was left out`; `: "<field>" must be <what> (got <the value as JSON>); it was left out` |
| An unknown field (launch warning; the field only) | `settings.json: "mcpServers": "<name>" has "<field>", which is not a server field; it was ignored` |
| Trust in a project's file (launch warning) | `.mcp.json: "<name>" has "trusted"; trust counts only in ~/.tachikoma/settings.json, so it was ignored` (and `"trustedTools"`) |
| `mcpServers` of the wrong type (problem: the file is not applied) | `settings.json: "mcpServers" must be an object of servers (got <the value as JSON>)` |
| A broken `.mcp.json` (launch warning) | `.mcp.json could not be read (<reason>); its servers were left out` |
| **Names** (grey, at the launch or when a list changes) | `MCP server <name>: "<tool>" was left out: its name <full> is <n> characters, over the 64 every provider takes` |
| A schema left out (grey; choice 36) | `MCP server <name>: "<tool>" was left out: its input schema <reason>`, `<reason>` one of `is not an object schema`; `has the property name "<p>", which providers do not take (1 to 64 letters, digits, "_", "." or "-")`; `could not be read (<the checker's words>)` |
| A flattened `anyOf` or `oneOf` (before the description, to the model; choice 36) | `This tool takes one of these sets of parameters: <a, b>; or <c>.`, each set a branch's `required` names, a branch with none named `(none needed)` |
| A remote server connected again (grey; choice 33) | `MCP server <name> was connected again.` |
| Hook JSON reasons at Elicitation and ElicitationResult (choice 35), in 8b's `printed JSON that could not be read (<reason>)` | `"action" must be "accept", "decline" or "cancel"`; `"content" must be an object` |
| `tool_search`'s description (to the model; choice 37) | `Finds MCP tools and loads them, so they can be called from the next step on. Search with words from a tool's name or what it does, or load tools by name with "select:<name>,<name>". MCP tools not loaded yet:` then per server, on its own lines, `<name>: <its instructions>` (without instructions, `<name>:`) and `  <full name>, <full name>, ...`; then, if any, `Not ready:` and a line each `<name>: <starting / failed: <reason> / needs sign-in, which the user does from /mcp>` |
| `tool_search`'s answer (to the model; choice 39) | `Loaded <n> tools; call them from the next step on:` (singular for 1), then per tool `<full name>: <description>` and `Input: <schema as JSON>`, a blank line between; no match: `No MCP tool matched "<query>".`, then the `Not ready:` lines if any; a `select:` name unknown: `No MCP tool is named <name>.`, the found ones still loaded |
| A name in use (grey) | `MCP server <name>: "<tool>" was left out: its name <full> is already <other>'s "<tool2>"` (a clash with one of Tachikoma's own tools cannot happen, as none starts `mcp__`) |
| **Starting** (grey, the waiting line) | `Waiting for MCP servers: <names>...` (design) |
| A server failed to start (red) | `MCP server <name> failed to start: <reason>` |
| Its `<reason>` | `<command> was not found on PATH`; `<command> could not start (<the system's words>)`; `it did not answer within 30 s`; `it exited with code <n>: <last line of its error output>` (without one, ending at `<n>`); `it was ended by signal <SIGNAME>`; for a remote server, `<address> answered <status>` or the library's own words |
| A late server ready (grey) | `MCP server <name> is ready: <n> tools.` (singular for 1) |
| A server stopped (red) | `MCP server <name> stopped: <reason>; reconnect it from /mcp.` |
| A call to a stopped server (to the model) | `The MCP server <name> has stopped; the user can reconnect it from /mcp.` |
| The sandbox's network off (grey, at the launch) | `MCP servers are off: the sandbox's network is off, and servers run outside the box until a later release. Start with --network on to use them.` |
| **Calls** (to the model): the tool changed while the call waited | `Not run: <name>'s tool "<tool>" changed while this call waited; look at its definition in this request's tools, if it is still there, and call it again.` |
| The server restarted while the call ran (to the model) | `Stopped: the MCP server <name> restarted while the call ran.` |
| The tool answered an error (to the model; a failed call) | the server's own text, as it sent it |
| A subagent's call to a tool no longer trusted (to the model) | `Not run: <name>'s "<tool>" is no longer trusted as read-only, and subagents only read.` |
| The picture line, the other-kind line | choices 10 and 11 |
| **Approval**: the question | `Allow <name>: <tool> <input as JSON>?` (design) |
| **Hooks**: an `mcp_tool` hook failed (red) | `<Event> hook failed: <server> <tool> answered an error: <first line of its text>`; `<Event> hook failed: <server> <tool> could not be called: <server> is not running`; `<Event> hook failed: <server> <tool> ran out of time after <n> s` |
| A left-out kind (launch warning; replaces 8b's) | `settings.json: "hooks": "<Event>" has a "<type>" hook; only "command" and "mcp_tool" hooks run, so it was left out` |
| An `mcp_tool` hook without `server` or `tool` (problem) | `settings.json: "hooks": "<Event>": an "mcp_tool" hook must have "server", such as {"type": "mcp_tool", "server": "memory", "tool": "search"}`, and the same with `"tool"` |
| `/hooks` and Ctrl+O | the hook's name is `<server> <tool>`, such as `tradingview quote_get` (design) |
| **The project's question** (at the launch) | `Start the MCP server "<name>" from this project's .mcp.json: <command> <args>? [y/n]`, or for a remote one `Connect to the MCP server "<name>" from this project's .mcp.json at <url>? [y/n]` |
| A project's server in `-p` (note) | `MCP server <name> from .mcp.json was skipped: -p starts only the project's servers you said yes to in the window.` |
| **Live edits** (grey) | `MCP servers changed: <name> restarted, <name> added, <name> removed.`, only the parts that apply (design: `MCP servers changed: tradingview restarted`) |
| **`/mcp`** heading | `MCP servers, from ~/.tachikoma/settings.json and .mcp.json:` (the file named as `shownFile()` names it) |
| `/mcp` rows | `<name>`, then ` (project)` for a project's, then one of ` · <n> tools`, ` · starting`, ` · needs sign-in`, ` · waiting for your yes`, ` · you said no`, ` · failed: <reason>`, ` · stopped: <reason>`, ` · off: the sandbox's network is off`, then ` · trusted` or ` · <n> trusted tools` (design) |
| `/mcp` with none | `No MCP servers. They go in "mcpServers" in ~/.tachikoma/settings.json, or in a project's .mcp.json.` |
| `/mcp` actions | `Reconnect`, `Sign in`, `Sign out`, `Show tools`, `Reset my answer`, each only where it applies |
| Show tools | `<name>'s tools:` then a row each `  <full name>`, then `Left out:` and the name lines' words |
| Reset my answer (grey) | `Your answer for <name> was reset; Tachikoma asks again at the next launch.` |
| The `/` menu's note, HELP | `List the MCP servers`; HELP: `/mcp lists the MCP servers`, after the `/hooks` part |
| **Sign-in**: the question | `Open your browser to sign in to <name> at <host>?` |
| Waiting (grey) | `Waiting for the sign-in in your browser. If it did not open, go to: <url>` |
| Done, failed, signed out | grey `Signed in to <name>.`; red `Sign-in to <name> failed: <reason>`; grey `Signed out of <name>.` |
| `-p`, a server that needs sign-in (note) | `MCP server <name> needs sign-in, which -p cannot do; sign in from /mcp in the window.` |
| **Forms**: the heading | `<name> asks: <message>` |
| A field's question | `<title, or the field's name>` then ` (a number)`, ` (yes or no)`, ` (optional)` where they apply, then `: ` |
| A wrong answer (grey) | `That is not a number; type one, or Esc to decline the form.`, the same for `yes or no` (`y` or `n`), and `This field is needed; type an answer, or Esc to decline the form.` |
| A visit request | `<name> asks you to open <url> in your browser: <message>. Open it?` |
| A declined form (grey) | `You declined <name>'s form.`; by a hook, `An Elicitation hook declined <name>'s form.`; in `-p` (note), `MCP server <name> asked for a form; -p declines every form.` |
| **Resources**: one that cannot be read (red) | `Could not read @<name>:<uri>: <reason>. Your words are back in the prompt box.` |
| **Prompts**: a missing argument (red) | `/<name>:<prompt> needs <argument>: /<name>:<prompt> <argument> ...` |
| A prompt that cannot be fetched (red) | `Could not get the prompt /<name>:<prompt>: <reason>. Your words are back in the prompt box.` |

## Task 1: The library, and measuring the user's servers

**This task needs the user twice. Stop and ask the controller at each point.**

**Files:** modify `package.json`, `package-lock.json`. The measurement script and its results stay
in the session's scratchpad folder, never in the repository.

**Steps:**
1. **The install, after the user's yes:** `sfw npm install --save-exact
   @modelcontextprotocol/client@2.4.0`, with `--loglevel=http` and a time limit, as the
   `sfw` note in memory says it can stall. Then check `node_modules/@modelcontextprotocol/client`
   is there (sfw on some machines does nothing and says nothing), that `package.json` pins
   `2.4.0` with no `^`, and that types and the suite's imports still build (`tsc`).
2. **A check that it loads:** a test, `tests/mcp/library.test.ts`, imports `Client` and
   `StdioClientTransport` and connects to a fake server the test writes (Task 4's `fake.ts` is not
   there yet, so this one writes its own), listing one tool.
3. **The measurement script,** written by the builder to the scratchpad and run by the user in
   their own PowerShell, as it starts the user's servers and reads their headers:
   - It reads the user's servers from Claude Code's settings (`~/.claude.json` and the plugins'
     `.mcp.json`) itself and **never prints, logs or saves an `env` value or a header**.
   - It connects to `tradingview`, `mempalace`, `Sanity` and `figma` (openmarket needs sign-in,
     which Task 11 builds; it is measured then), lists each one's tools, and closes each.
   - For each server it writes: the number of tools; each tool's full name
     `mcp__<server>__<tool>`, made safe, and its length; how many are over 64 characters; each
     description's length and how many are over 4,096; and the tool list's size in tokens, counted
     by Anthropic's `countTokens` as Tachikoma would send it (the user loads their key first, with
     their own load line), and in characters.
   - The builder hands the user the one command to run, in PowerShell syntax.
4. **The results** go in a table in this plan, under "Numbers in this plan", with the date. The
   controller gives them to the user, who decides tool search, and the plan is updated before
   Task 2 starts.

Commit: `feat: the MCP client library, 2.4.0, pinned`.

## Task 2: The settings entry

**Files:** create `src/mcp/config.ts`, `tests/mcp/config.test.ts`; modify `src/settings.ts` (the
`mcpServers` name), `tests/settings.test.ts`, and the LIVE names (`constants.ts:116-120`).

```ts
export type ServerEntry =
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string>; timeout?: number }
  | { kind: "http" | "sse"; url: string; headers: Record<string, string>; timeout?: number; oauth?: OAuthEntry };
export interface OAuthEntry { clientId?: string; callbackPort?: number; scopes?: string; authServerMetadataUrl?: string }   // scopes: one string, split by spaces
export interface ServerConfig {
  name: string; safe: string;              // safe: the name with each character but [A-Za-z0-9_-] made "_"
  entry: ServerEntry; where: "user" | "project";
  trusted: "read-only" | null; trustedTools: string[];   // always none for a project's
}
export function readServers(file: "settings.json" | ".mcp.json", value: unknown, env: NodeJS.ProcessEnv, warnings: string[]): ServerConfig[];
export function mergeServers(user: ServerConfig[], project: ServerConfig[]): ServerConfig[];   // the user's wins whole
export function readProjectFile(root: string, env: NodeJS.ProcessEnv, warnings: string[]): ServerConfig[];
```

**Behaviour** (design, "The settings entry", "A project's servers"):
- **Claude Code's fields:** `type` (`stdio` by default; `http`, also `streamable-http`; `sse`),
  `command`, `args`, `env`, `url`, `headers`, `timeout`, `oauth`
  with `clientId`, `callbackPort`, `scopes`, `authServerMetadataUrl`, and `alwaysLoad` (true or
  false, choice 42; `ServerConfig` gains `alwaysLoad: boolean`). As Claude Code's MCP page says
  (read 2026-11-10, after Task 2's build): `timeout` is in ms, and a whole number below 1,000 is
  ignored, as if unset; one above 2,147,483,647 (Node's longest timer) is refused. `scopes` is one
  string, scopes split by spaces (RFC 6749 §3.3), not a list. `authServerMetadataUrl` must be an
  `https://` address. A `url` with no `type` is left
  out with its line.
- **`${VAR}` and `${VAR:-default}`** are filled from `env` in `command`, `args`, `env`, `url` and
  `headers`. An unset one with no default leaves the server out with its line, naming the
  variable. A warning never quotes a filled-in value.
- **Addresses:** `http://` only for `localhost`, `127.0.0.1` or `[::1]`, else `https://`; checked
  after `${VAR}` is filled.
- **Trust** (`trusted`, `trustedTools`) counts only in the user's file; in `.mcp.json` it gives its
  line and is dropped.
- **A bad entry is left out with a warning;** `mcpServers` itself of the wrong type is a problem,
  as every entry's is. `.mcp.json` at the project's root that is not JSON gives its line.
- **Names:** `safe` holding `__` leaves the server out (design, finding 2). Two servers in one
  file cannot share a name (JSON keys); a project's server with the user's name is dropped by
  `mergeServers`, whole, with no line, as the user's entry is the one meant.
- **`mcpServers` is LIVE** (Task 10 applies it). `.mcp.json` is read at the launch only, a known
  limit.

**Tests:** each line in the table, triggered; `${VAR}` and `${VAR:-x}` in each field; a key
header's value never in a warning; `streamable-http` read as `http`; `http://127.0.0.1:3000`
kept and `http://example.com` left out; trust in `.mcp.json` dropped with its line; the user's
`sanity` over a project's `sanity`, fields never mixed; `a.b` beside `a_b` both kept here (the
names table, Task 5, decides); a server named `a__b` left out.

Commit: `feat: MCP servers in the settings file and .mcp.json, in Claude Code's shape`.

## Task 3: Finding a server's program, and the project's answers

**Files:** modify `src/exec/env.ts` (`mcpProgram`, beside `onPath`), `tests/exec/env.test.ts`;
create `src/mcp/answers.ts`, `tests/mcp/answers.test.ts`.

```ts
export function mcpProgram(command: string, env: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string | null;   // choice 4
export interface Answers { get(name: string): boolean | undefined; set(name: string, yes: boolean): void; reset(name: string): void }
export function answersFor(root: string, dir?: string, warn?: (message: string) => void): Answers;   // choice 24; warn gets readPrivate's notices
```

**Behaviour:**
- `mcpProgram` (choice 4; the review fixes plan, fix 1): a command with a folder in it is returned
  as written; otherwise each PATH entry that is absolute, unquoted as `onPath` does, is tried with
  each ending in PATHEXT's order, the first file found winning; a name that already ends in one
  of those endings is tried as written instead (the plan's re-review). It never looks in the
  project folder unless PATH names it.
- `answersFor` reads `projectFile("mcp-answers", root)` line by line, the last line for a name
  winning, a damaged line skipped; `set` and `reset` append a line through `writePrivate`'s
  folder rules. The file is written only when the user answers. A file it cannot read or append to
  throws (`readPrivate`'s refusals among them); Task 5 catches that, says it on the bus as an `mcp`
  line, and asks again as if unanswered.

**Tests:** with a made-up PATH of folders the test made: `npx` finds `npx.cmd`; `.exe` before
`.cmd` in the default order; a PATHEXT of `.CMD;.EXE` finds `.cmd` first; `node.exe` finds
`node.exe` and `npx.cmd` finds `npx.cmd` (never `node.exe.EXE` or `npx.cmd.CMD`), and `NPX.CMD`
finds it too; a `npx.cmd` in the project folder is not found, by `npx` or by `npx.cmd`; a relative PATH entry is skipped; `node` with a folder is taken as
written. Answers: yes, then no, then reset, then read again by a new `answersFor`; a damaged line
in the middle.

Commit: `feat: MCP servers' programs found by full path, .cmd included, and the project's answers kept`.

## Task 4: One server's connection

**Files:** create `src/mcp/server.ts`, `tests/mcp/server.test.ts`, `tests/mcp/fake.ts` (writes the
tests' fake servers).

```ts
export type State =
  | { is: "starting" } | { is: "ready"; tools: Tool[] } | { is: "failed"; reason: string }
  | { is: "stopped"; reason: string; retry: boolean }   // retry: a remote one whose connection dropped, not yet tried again (choice 33)
  | { is: "needs sign-in" } | { is: "waiting for your yes" } | { is: "you said no" } | { is: "off" };
export class Server {
  constructor(config: ServerConfig, opts: { root: string; env: NodeJS.ProcessEnv; auth?: AuthStore; onChange(): void; onForm?: FormHandler });
  readonly config: ServerConfig;
  get state(): State;
  get connection(): number;                          // raised at each new connection (design, finding 4)
  start(): Promise<void>;                            // never throws; the state says how it went
  callTool(name: string, args: object, opts: { signal?: AbortSignal }): Promise<CallToolResult>;
  reconnect(): Promise<boolean>;                     // a dropped remote one, once (choice 33)
  stop(): Promise<void>;                             // choice 3
  // Task 13 adds the resource and prompt calls.
}
```

**Behaviour:**
- **Local:** `StdioClientTransport` with the program from `mcpProgram` (choice 2); one not found
  fails at once with its reason. **Remote:** `StreamableHTTPClientTransport` for `http`,
  `SSEClientTransport` for `sse`, the entry's `headers` sent with each request.
- **The client** says it is `tachikoma` with the package's version, and offers `roots` (the
  project's folder, design "The folder a server is told it works in") and `elicitation` (`form`
  and `url`), never `sampling`. Until Task 12, a form is declined.
- **Start:** `connect`, then `listTools`, within 30 s; past it the transport is closed and the
  state is `failed` with its reason. Each description is kept whole, as the server sent it; the
  views cut their own copies (choices 8, 15, 39, 42).
- **Calls:** `callTool` with `timeout` from the entry, or else 2,147,483,647 ms for a local server
  and 60 s for a remote one (an entry's `timeout` is used when longer). The limit is hard:
  progress never extends it, as Claude Code's MCP page says (the user's choice, 2026-11-10;
  `resetTimeoutOnProgress` is not passed). The `signal` stops it, and the library tells the server.
- **A list change** (the library's `listChanged.tools`) puts the new list in the state and calls
  `onChange`.
- **A server that exits or drops** (the transport's `onclose`, the client's `onerror`) is
  `stopped`, with choices 5 and 6's reason, and `onChange` is called; a remote one gets `retry:
  true`, and `reconnect()` (one new connection, `retry` then false whatever happens) is what
  Task 6's run calls (choices 13, 33). Nothing restarts on its own.
- **`stop`** is choice 3. `connection` goes up at each new connection.
- **`tests/mcp/fake.ts`** writes a Node script that answers `initialize`, `tools/list`,
  `tools/call` (echo, error, picture, structured-only, slow, progress), can send
  `notifications/tools/list_changed`, can exit with a code, and can print to its error output; and
  starts a `127.0.0.1` HTTP server answering the same in JSON. It uses no package.

**Tests:** start and list over stdio and over HTTP; `CLAUDE_PROJECT_DIR`, `env`, the folder and
`roots/list` as the server sees them; on Windows, a `.cmd` server (a fake `x.cmd` the test makes,
in a folder with a space in its name) started through `mcpProgram`'s full path, with an argument
holding a space, `&`, `^` and `%`, which arrives whole (Task 3's review: Node refuses a bare
`.cmd` without a shell, so this checks how the library's spawn handles it); a server that never answers fails at the test's own short
limit (the 30 s passed in as a parameter for the test, not changed in the code), its process gone;
an exit with code 3 and a last error line gives that reason; a description longer than 4,096
characters is in the state whole; a slow call that keeps sending progress still ends at its
entry's `timeout` (the test's own short one); a call stopped by its signal ends,
and the server got `notifications/cancelled`; a list change updates the tools and calls
`onChange`; `stop` kills a server that ignores its closed input, and on Windows its child too; a
remote server that drops is `stopped` with `retry: true`, `reconnect()` works once, and a second
drop's `reconnect()` is not tried.

Commit: `feat: one MCP server's connection: local or remote, started within 30 s, stopped with its tree`.

**End of Part 1:** the whole suite, once.

## Task 5: The Servers object and its names

**Files:** create `src/mcp/servers.ts`, `tests/mcp/servers.test.ts`.

```ts
export interface Offered { spec: ToolSpec; server: string; tool: string; connection: number; definition: string }
export class Servers {
  constructor(configs: ServerConfig[], opts: { root: string; env: NodeJS.ProcessEnv; bus: Bus; answers: Answers; network: "on" | "off" | "none"; ... });
  startAll(): void;                                 // every server at once, in the background
  ready(signal?: AbortSignal): Promise<boolean>;   // all started or failed; false when stopped first
  waitingFor(): string[];                           // the names still starting, for the waiting line
  offer(opts?: { trustedOnly?: boolean }): Offered[]; // choice 9
  current(o: Offered): "same" | "changed" | "stopped" | "restarted";
  trust(server: string, tool: string): boolean;     // read live (choice 16)
  set(configs: ServerConfig[]): void;               // a live edit: only changed entries restart
  list(): { name: string; where: "user" | "project"; state: State; trusted: ... }[];   // for /mcp
  stopAll(): Promise<void>;
}
```

**Behaviour** (design, "Tools for the model"; choices 7 and 8):
- **Names** are `mcp__<safe server>__<safe tool>`. A name over 64 characters is left out with its
  line; the server's other tools stay. A name already in force (another server's, or an earlier
  tool of the same server; none of Tachikoma's own starts `mcp__`) leaves the later one out with
  its line,
  "later" in the order the configs are given (the user's file, then the project's) and, for a
  server ready late or a changed list, any name already offered. The table maps each name to its
  server and its tool's own name; nothing splits a name.
- **Schemas** (choice 36; the plan review, finding 5): each tool's input schema is flattened or
  left out before its name is given, at the start and at each list change, so one tool's schema
  never makes a provider refuse the whole request.
- **Descriptions:** each offered spec carries the server's whole description cut at 4,096; the
  offer's `definition` (choice 8) is built from the whole text. Task 6b gives loaded tools 16,384.
- **Waiting and states:** a project's server without a yes is `waiting for your yes` (Task 9
  asks), one with a no `you said no`; with the sandbox's network off every server is `off`
  (`network: "off"`; `none` is the sandbox off).
- **`set`** compares each entry as JSON: a changed one is stopped and started again, a new one
  started, a removed one stopped; the others untouched. The live-edit line is said by Task 10.
- **The lines** for names, late servers and failures go out on the bus (`mcp-note`, error kind
  `mcp`, choice 26); the bus gains both.

**Tests:** the 64 and 65-character names, the server's other tool still offered; `foo.bar` beside
`foo_bar`; server `a__b` (left out in Task 2) and server `a` with tool `b__c` gives
`mcp__a__b__c` and nothing collides; a late server whose name is in use; a changed list
whose new tool takes a name in force; `set` restarts only the changed server; `ready` resolves
after one starts and one fails, and resolves false when its signal stops it. Schemas (finding
5): a fake server with a root-level `anyOf` tool and an ordinary one offers both, the first
flattened with its sentence; one with a bad property name and one whose schema cannot be compiled
are left out with their lines and the ordinary tool stays; the same three arriving by a list
change; and a session test with the stand-in Anthropic adapter whose request holds only object
schemas at the root.

Commit: `feat: the MCP servers together: one table of unique names, at most 64 characters`.

## Task 6: MCP tools in the session

**Files:** create `src/mcp/tools.ts`, `tests/mcp/tools.test.ts`; modify `src/core/session.ts`
(the offer per request, the lookup), `src/core/types.ts` (pictures after results),
`src/tools/tool.ts` (a result with pictures), `src/tui/pictures.ts` (choice 10's numbering),
`src/core/transcript.ts` (the `from: "server"` mark, choice 34), `tests/core/session.test.ts`,
`tests/core/transcript.test.ts`.

```ts
// session.ts: SessionOptions gains
mcp?: { offer(): Offered[]; tool(o: Offered): Tool };   // the lead: every tool; a subagent: trusted only (Task 7)
// tool.ts: run may return pictures with its text
run(input: unknown, ctx: ToolContext): Promise<string | { text: string; pictures: Picture[] }>;
```

**Behaviour** (design, "Tools for the model"; choices 8-12):
- **Each request** takes `offer()` once and sends Tachikoma's own specs then the offer's; the
  reply's calls are looked up in that request's list (Tachikoma's own first, then the offer), so
  a call runs on the tool the model was shown. The parallel check runs MCP calls one at a time.
- **The run, first** (choice 33; the plan review, finding 3): a server `stopped` with `retry` is
  connected again; on success the call is bound to the new connection if the tool's definition
  is unchanged, else it gets the "changed" line; on failure the stopped line. Then the gate
  (Task 7).
- **The run, after the question:** `servers.current(offered)`; `changed` or `restarted` gives the
  "changed while this call waited" line, as a failed call, without calling the server; `stopped`
  gives the stopped line. Then `callTool` with the turn's signal.
- **The answer:** text parts joined with blank lines and cut at 30,000 characters with the usual
  `[cut: N more characters]`; pictures per choice 10; other kinds per choice 11; structured data
  per choice 12; `isError` throws with the server's text, so it is a failed call and
  PostToolUseFailure runs. A call running when its server restarts ends with the restart line.
- **Esc** stops the call as any tool's, and the session's "Cancelled by the user." stays the
  model's text.
- **Pictures** are carried from `run` to the results' user message as `image` parts marked
  `from: "server"` (choice 34), numbered on from the conversation's highest number, and saved in
  the transcript with the mark; `valid()` in `transcript.ts` takes the new field, and `own` and
  the session's `words` skip such parts.

**Tests** (a stand-in model, a fake server): a call through to the server and back; the request's
tools hold the MCP specs after Tachikoma's own; a `/lead` switch to an OpenAI-format stand-in sends
the same names; the cut at 30,000; two pictures numbered on from a pasted `[Image #3]`, as `#4`
and `#5`, through both providers' adapters; structured-only as JSON; an `isError` answer fires
PostToolUseFailure; finding 4: a restart while the call waits for its question, and a changed
list while it waits, are each refused and never reach the server (the fake server counts calls);
a restart while a call runs ends it as stopped; Esc during a slow call, and the server told.
Finding 3, through a whole Session call: a fake HTTP server drops its connection, the model's next
call connects again, is asked, and reaches the server, with the grey line; the same with the
tool's definition changed on the new connection gives the "changed" line and never reaches the
server; with the reconnect failing, the stopped line. A tool's picture, after a resume, is not in
the resumed window's prompts nor the judge's messages.

Commit: `feat: MCP tools in the session: each call on the tool the model was shown, answers cut, pictures passed on`.

Task 6 sends every MCP tool defined; Task 6b changes that to tool search, so Task 6's tests that
look at a request's tools load them first, or use a server with `alwaysLoad`.

## Task 6b: Tool search

**Files:** create `src/mcp/search.ts`, `tests/mcp/search.test.ts`; modify `src/mcp/servers.ts`
(`offer()` splits loaded from named, and `getInstructions()`), `src/core/session.ts` (the loaded
set, `tool_search` in each request), `src/core/transcript.ts` (the `loaded` line),
`src/core/tasks.ts` (subagents' own set), `src/hooks/tools.ts` (`ToolSearch`), `src/mcp/server.ts`
(instructions, `_meta` alwaysLoad); tests in `tests/core/session.test.ts`,
`tests/core/transcript.test.ts`, `tests/hooks/tools.test.ts`.

```ts
// servers.ts
offer(opts: { loaded: ReadonlySet<string>; trustedOnly?: boolean }): { defined: Offered[]; named: { server: string; instructions?: string; names: string[] }[]; notReady: { server: string; state: State }[] };
// search.ts
export function searchTool(servers: Servers, loaded: Set<string>, opts?: { trustedOnly?: boolean }): Tool;   // choices 37-40
export function find(query: string, max: number, tools: { full: string; description: string }[]): string[];  // choice 38's ranking
```

**Behaviour** (choices 37-45): `tool_search` is built per session with its own loaded set; its
description is rebuilt from the offer at each request. `defined` holds the loaded tools and the
`alwaysLoad` ones; `named` the rest. Each cut is made from the server's whole description when
the offer is built: 16,384 for a tool loaded by search, 4,096 for an `alwaysLoad` one and for the
judge; `definition` is the same whichever way a tool is loaded. A search adds names to the set and returns its answer; the
next request defines them. The session saves the `loaded` line whenever the set grows, after the
result's line. `/clear` starts a new set; a resume and `/branch` read it back.

**Tests:**
- A request with two fake servers carries `tool_search` and no MCP definitions, the names in its
  description, and a server's instructions.
- A search by a word in a description loads the tool, the next request defines it, and the model's
  call to it reaches the server.
- `select:` with one known and one unknown name.
- Ranking, the 5 default, and `max_results: 1`.
- No match listing a failed server and one needing sign-in.
- A search while a server starts waits for it; Esc stops the wait.
- `alwaysLoad` on a server, and `_meta` on one tool, defined upfront with the 4,096 cut.
- A description longer than 4,096 characters with a marker word past character 4,096: upfront
  (`alwaysLoad`) its spec stops at 4,096 without the marker and the judge gets 4,096; a search for
  the marker finds it, the answer and the next request's spec hold the marker; a call made after
  loading gets `current()` "same", not "changed".
- The loaded set after a resume and after `/clear`.
- A subagent's search finds only trusted tools.
- A PreToolUse hook with matcher `ToolSearch` sees `{ query, max_results }`.
- The same request's tools after a `/lead` switch to an OpenAI-format stand-in.
- With no MCP server, no `tool_search`.

Commit: `feat: tool search: MCP tools named until the model loads them, on every provider`.

## Task 7: Approval

**Files:** modify `src/core/permissions.ts` (the `mcp` kind, `description`), `src/safety/judge.ts`,
`src/mcp/tools.ts` (trust before the gate), `src/core/tasks.ts` and `src/cli.tsx` (subagents'
trusted tools); tests in `tests/core/permissions.test.ts`, `tests/safety/judge.test.ts`,
`tests/mcp/tools.test.ts`, `tests/core/tasks.test.ts`.

**Behaviour** (design, "Approval"; choices 14-17):
- **`Action.kind`** gains `"mcp"`, and `Action` gains `description?`. **`require` itself
  changes,** not only `needsApproval` (choice 32; the plan review, finding 1): its `never` branch
  (permissions.ts:239-247) returns before any question, so an `mcp` action goes past it. An `mcp`
  action asks in `ask`, `project` and `never`; in `auto` the judge decides; in `-p` the ask says
  no, so the call is refused. A hook's allow skips the question, as for other actions.
- **Trust** is read right before `gate.require`; a trusted call does not call it.
- **The question** is choice 14's; the judge's request gains `description` (choice 15).
- **Subagents** get `offer({ trustedOnly: true })`; a call whose trust was removed meanwhile is
  refused with its line (choice 17).

**Tests:** through the real gate and the MCP tool's `run`, never `needsApproval` alone (finding
1): in `never` the question is asked, a no refuses the call and the fake server counts none, a yes
runs it; `never` with `-p`'s headless gate refuses without running; the table in `ask`, `project`
and `auto` the same way; `auto` with a stand-in judge sees the
description; a trusted tool runs without a question in `ask` and in `-p`; trust removed by a live
edit while a call waits for its PreToolUse hook, then asked (the lead) or refused (a subagent); a
PreToolUse `allow` skips the question; a subagent's request carries only trusted tools.

Commit: `feat: approving MCP calls: asked, judged, or trusted, and subagents get only trusted read-only tools`.

## Task 8: Hooks

**Files:** modify `src/hooks/config.ts` (the `mcp_tool` kind, Elicitation and ElicitationResult),
`src/hooks/tools.ts` (MCP names, inputs, rewrites, outputs), `src/hooks/hooks.ts` and
`src/hooks/run.ts` (running an `mcp_tool` hook), `src/hooks/answer.ts` (its name, and the
Elicitation answers, choice 35);
tests in `tests/hooks/`.

**Behaviour** (design, "Hooks"; choices 18-22):
- **Every event** sees an MCP call as `mcp__...` with its arguments as `tool_input`; matchers match
  that name. A rewrite (choice 19) and an output replacement (choice 20) work for MCP calls.
- **`mcp_tool` hooks:** `server`, `tool`, `input`; the hook calls `servers.callTool` directly, never
  through the session's tool path, so no tool hook sees it (design, finding 3), and no question is
  asked. Only a running server can be called. Its limit is 600 s by default, 30 s at
  UserPromptSubmit; its stop and time limit cancel the call and tell the server. Its answer is
  read by choice 21; its lines are in the table.
- **`EVENTS`** gains Elicitation and ElicitationResult, matched on the server's name (Task 12
  fires them).
- **Their answers** (choice 35; the plan review, finding 4): `answer.ts` checks `action` and
  `content` in `read`'s JSON checks, with the two new reasons; `outcomeOf` takes exit code 2 at
  these events as a decline, not a failure; `combine` fills `Combined.elicitation` by choice 35's
  order. Nothing else at these events changes 8b's rules.
- **Names:** `hookName` of an `mcp_tool` hook is `<server> <tool>`, or its `statusMessage`.

**Tests:** `mcp__fake__.*` matches the fake server's calls and `mcp__fake` matches none; a
PreToolUse rewrite reaches the server; a string `updatedMCPToolOutput` replaces the text; finding
3: a catch-all PreToolUse and PostToolUse `mcp_tool` hook on a fake server, each model call
causing exactly one call by each hook, the fake server counting; an `isError` answer's line and
the call going on; a stopped server's line; `${tool_input.file_path}` filled, a missing path
empty; the launch's SessionStart skipping it; the left-out-kind line's new words. Elicitation
answers through the real `Hooks.fire` (finding 4): an accept with `content`; a decline; a cancel;
exit code 2 as a decline; a decline in one hook beside an accept in another, the decline winning;
two accepts, the first's `content`; each new JSON reason's line; the same at ElicitationResult.

Commit: `feat: MCP calls in hooks, and mcp_tool hooks that call a server directly`.

**End of Part 2:** the whole suite, once.

## Task 9: The launch

**Files:** modify `src/cli.tsx`, `src/clilib.ts`, `src/core/session.ts` (the shared wait),
`src/tui/App.tsx` (the waiting line, `mcp-note`, `mcp` errors); tests in `tests/cli.test.ts`,
`tests/tui/app.test.tsx` ("App's MCP").

**Behaviour** (design, "Starting and stopping servers", "A project's servers"; choices 23, 25, 26):
- **Order:** the settings' and `.mcp.json`'s servers are read with the settings; each project
  server without an answer is asked after the instructions question (window only); `Servers` is
  made after the sandbox starts, and `startAll` runs before the window opens or `-p` sends.
- **The first prompt** waits for `servers.ready` through the SessionStart wait (choice 25); the
  waiting line is `Waiting for MCP servers: <names>...`. Esc sends the prompt without the late
  servers, whose tools join the next request.
- **The sandbox:** with it on and its network off, `network: "off"` and the line once.
- **`-p`:** a project server without a yes is skipped with its note; failures go to stderr as
  `mcp: <line>`, notes as `note: <line>`; `--json` adds `mcp-note`; an `mcp` error never fails
  the run.
- **At exit** (window, `-p`, a signal) `stopAll` runs, and `running` covers a crash.

**Tests** (fake servers, a pretend HOME, `tachiLater` for the window): the question's words, a yes
starting the server and a no skipping it, both kept for the next launch; `-p` skipping an
unanswered project server with its note and starting a yes'd one; a server that fails to start in
`-p` gives its line and exit code 0; `--json`'s `mcp-note`; the waiting line, then Esc sending
without the slow server; the sandbox's line; the server's process gone after the window exits.

Commit: `feat: MCP servers at the launch: project servers asked, the first prompt waits, -p's lines`.

## Task 10: `/mcp` and live edits

**Files:** create `src/tui/McpList.tsx`; modify `src/tui/app/queue.ts` (`/mcp`, Show tools),
`src/tui/app/constants.ts` (the name), `src/tui/app/menus.ts` (the menu), `src/cli.tsx` (HELP),
`src/tui/app/liveEdits.ts` (`mcpServers`), `src/tui/App.tsx` (the picker); tests in
`tests/tui/app.test.tsx` ("App's MCP").

**Behaviour** (design, "What the user sees"; choice 27):
- `/mcp` opens the picker of rows as the table gives them; Enter shows the actions that apply;
  Reconnect stops and starts the server (its connection number goes up); Show tools prints its
  list; Reset my answer writes the reset (choice 24) and says its line; Sign in and Sign out are
  Task 11's.
- **A live edit** of `mcpServers` calls `servers.set` and says the changed line; trust changes
  take effect at once and restart nothing; a broken file keeps the servers in force.

**Tests:** each row kind; Reconnect of a stopped server; Show tools with a left-out name; Reset
then the next launch asks again; a live edit restarting one server and adding one, with the line;
a trust removed by a live edit (asked next call).

Commit: `feat: /mcp lists the servers and their actions, and a live edit restarts only what changed`.

## Task 11: Sign-in

**Files:** create `src/mcp/auth.ts`, `tests/mcp/auth.test.ts`; modify `src/mcp/server.ts` (the
`authProvider`), `src/tui/McpList.tsx` (Sign in, Sign out).

**Behaviour** (design, "Remote servers and sign-in"; choice 28):
- An `OAuthClientProvider` per remote server: client information (dynamic registration, or the
  entry's `clientId`) and tokens kept in `mcp-auth.json` under its lock; `redirectUrl` on
  `127.0.0.1` at a free port, or the entry's `callbackPort`; the code verifier in memory.
- A server whose start ends in `UnauthorizedError` is `needs sign-in`; the launch never waits.
- Sign in asks its question, opens the browser with `openBrowser`, prints the waiting line, takes
  the code at the local address, finishes with the library's `auth`, and reconnects. Esc stops the
  wait. Refresh is the library's, saved through `saveTokens`. Sign out removes the server's tokens
  and client information, and reconnects (so it shows `needs sign-in`).
- `-p` never signs in: its note; a server signed in from the window works there.

**Tests:** a fake sign-in server on `127.0.0.1` (discovery, registration, authorize, token): the
whole sign-in with the browser replaced by a function the test gives; tokens saved private and
used at the next launch; a token refreshed; sign out; a new address under the same name not sent
the old tokens; `-p`'s note.

Commit: `feat: signing in to remote MCP servers from /mcp, tokens kept private`.

## Task 12: Forms

**Files:** create `src/mcp/forms.ts`, `src/tui/Field.tsx` (the free-text question), tests
`tests/mcp/forms.test.ts`, `tests/tui/app.test.tsx` ("App's MCP"); modify `src/mcp/server.ts`
(the `elicitation/create` handler), `src/tui/App.tsx`, `src/tui/app/keyRouting.ts`.

**Behaviour** (design, "Forms a server asks for"; choice 29):
- **Hooks first:** Elicitation hooks with Claude Code's input; `Combined.elicitation` (Task 8,
  choice 35) answers for the user, exit code 2 being a decline; then, if no hook answered, the
  form; then ElicitationResult hooks, whose `Combined.elicitation` replaces the user's answer.
  They do not run after an Elicitation hook answered.
- **A form:** the heading, then each field: text, a number (`number` and `integer`, its
  `minimum`/`maximum` checked), yes or no, or a pick (`enum`, `oneOf`, and the multi-pick kinds),
  the field's `default` filled in. Esc declines the form; an empty optional field is left out.
- **A visit request** (`mode: "url"`) asks its question and opens the browser on yes; a no
  declines.
- **`-p`** declines every form, with its note.

**Tests:** a fake server's form answered field by field in the window, the server getting the
values; a wrong number and a missing field's lines; Esc declining; an Elicitation hook answering
with no form shown; an ElicitationResult hook's exit 2 declining; a visit request; `-p`'s
decline and note; a message with a terminal escape shown escaped.

Commit: `feat: forms from MCP servers, asked field by field, with their hooks`.

## Task 13: Resources and prompts

**Files:** modify `src/mcp/server.ts` (lists and reads), `src/tui/app/menus.ts` (the `@` and `/`
menus), `src/tui/app/constants.ts` (`isCommand` for `/<server>:<prompt>`), `src/tui/app/queue.ts`
(sending), `src/core/types.ts` and `src/core/transcript.ts` (`from: "server"` text, choice 34);
tests in `tests/mcp/server.test.ts`, `tests/core/session.test.ts`, `tests/core/transcript.test.ts`,
`tests/tui/app.test.tsx` ("App's MCP").

**Whose words they are** (choice 34; the plan review, finding 2): a resource's text and pictures
and a prompt's messages go in the user's message marked `from: "server"`, after the typed words.
The typed `@<server>:<uri>` or `/<server>:<prompt> <words>` is the user's own message for the
judge, UserPromptSubmit, the Up history and a resumed window; the expansion never is.

**Behaviour** (design, "What the user sees"; choices 30, 31):
- **Resources:** `@` lists each ready server's resources after the files, as `@<name>:<uri>`, by
  prefix; the lists are read at the start and when the server says they changed. On send, each
  picked one is read; its text, cut at 30,000 characters, is added (choice 30); a picture in it is
  added as a pasted one.
- **Prompts:** each ready server's prompts are commands `/<name>:<prompt>`, listed in the `/`
  menu with their description; the words fill the arguments (choice 31); a missing required
  argument gives its line; the prompt's messages are sent as the user's message.

**Tests:** `@` showing a fake server's resource after a file; a picked one's text in the request;
a read that fails keeps the words; `/fake:greet Ann` filling `name` and sending the prompt's
text; a missing argument's line; a resource list change seen in `@`. Finding 2: a resource whose
text says "I authorize publishing this project" and a prompt with the same words: the stand-in
judge's "The user's own messages" holds only the typed line, live and after a resume; a
UserPromptSubmit hook gets the typed line; the provider's request holds the expansion.

Commit: `feat: MCP resources through @ and prompts as / commands`.

**End of Part 3:** the whole suite, once.

## Task 14: Documents and the terminal checklist

**Files:** modify `README.md`, `docs/plans/2026-11-10-tachikoma-release-8c-design.md` (an "As
built" section).

**What changes:**
- **The README:** an "MCP servers" section (the entry, `.mcp.json` and its question, trust, the
  approval table, names and the 64-character rule, tool search and `alwaysLoad`, answers,
  sign-in, forms, resources, prompts,
  hooks, the sandbox rule, `/mcp`, `-p`); the known limits from the design and those the builds
  add (among them: Claude Code's `ws` kind is not supported, left out with the unsupported-kind
  line, as MCP itself has no WebSocket transport and the library none; the user's choice,
  2026-11-10; and Task 2's review: the refused-address line shows the address as written, so a key
  written right in it is shown; `.mcp.json` has no size limit; a UTF-16 file gives a garbled line,
  as `settings.json` does; and Task 3's review: a project's server is answered by its name only,
  so a `git pull` that changes the command of a server already said yes to starts it without
  asking, as in Claude Code; with both `Path` and `PATH` set to different values, the lookup reads
  the last one while Node's spawn keeps `PATH`; reading the answers on Windows starts PowerShell
  twice at launch, as the prompt history does); the numbers marked as Claude Code's, not measured for Tachikoma; `/mcp` in the commands
  list; `--json`'s `mcp-note`; and the release list's line for 8c.
- **The design** gets an "As built" section.

**All README wording goes to the user before it is committed.**

**The terminal checklist,** for the user in Windows Terminal, in a practice project:
1. TradingView, local: the model reads a quote; the question shows `tradingview: quote_get ...`.
2. MemPalace, local: a search with `"trustedTools"` set runs without a question.
3. Sanity or Figma, by header: a read call works.
4. openmarket: `/mcp`, Sign in, the browser, then a call.
5. `/mcp` rows; Reconnect; Show tools.
6. A live edit of one server's `args`: only it restarts, with the line.
7. A practice `.mcp.json`: the question at the launch; no, then `/mcp` Reset my answer.
8. `tachi -p` with that project server unanswered: skipped, its note.
9. A `PreToolUse` hook with matcher `mcp__tradingview__.*` that logs the call.
10. Esc during the first prompt's wait.
11. Tool search: ask for something only Sanity can do; Ctrl+O shows a `tool_search` call, then
    the Sanity call.

The checklist's entries are copied by the user into `~/.tachikoma/settings.json`; the plan's
builder never writes the user's settings file.

Commit: `docs: release 8c in the README, and the design as built`.
