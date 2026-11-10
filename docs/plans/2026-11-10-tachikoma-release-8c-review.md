# Release 8c implementation plan review

Reviewed: 2026-11-10

Plan: [2026-11-10-tachikoma-release-8c.md](2026-11-10-tachikoma-release-8c.md)

## Re-review: 2026-11-10

All five findings from the initial review below are addressed in the revised plan. One additional P2 issue remains:

### [P2] Resolve bare commands that already include an executable extension

**Current plan lines: 569–572; also choice 4 at 282–286.**

The specified Windows lookup appends PATHEXT endings to every command without a folder. Valid entries such as `command: "node.exe"` or `command: "npx.cmd"` therefore search for `node.exe.COM`, `node.exe.EXE`, or `npx.cmd.CMD`, rather than the actual file. Such servers fail to start even when their executable is on PATH.

Specify exact filename lookup within absolute PATH folders when the command already carries an executable extension, preserving the protection against implicit lookup in the project folder. Add `node.exe` and `npx.cmd` to Task 3's lookup tests alongside the extensionless cases.

This re-review checked the revised plan, including its new choices and test requirements. No implementation changes, test suite runs, server launches or installs were performed.

## Initial review (historical; all five addressed)

## 1. [P1] Route MCP actions past the never-mode early return

**Plan lines: 685–687.**

Task 7 specifies that an MCP action needs approval in `never` by changing `needsApproval`. However, `PermissionGate.require` returns from its `never` branch before calling `needsApproval` (`src/core/permissions.ts:239–250`). Following the listed change alone therefore lets an untrusted host MCP call execute without asking in sandbox copy mode. The same path bypasses the headless refusal.

Explicitly change `require` to route MCP actions through their approval policy before that early return, while retaining the intended trusted-tool and hook-allow exceptions. Test the actual gate and tool invocation in `never`, including a declined question and headless refusal; testing `needsApproval` alone cannot establish the boundary.

## 2. [P1] Preserve the provenance of resource and prompt contents

**Plan lines: 833–839; also choices 30–31 at 365–370.**

Resources are appended as text parts, and server prompt messages are sent as the user's message, without a provenance requirement. Current `Session.#turn` counts every text part with no `from` field as the user's own words (`src/core/session.ts:383–400`). Transcript loading reconstructs the user's prompts by the same rule (`src/core/transcript.ts:182–183`). The auto-mode judge then receives that ledger under “The user's own messages,” deliberately excluding tool outputs (`src/safety/judge.ts:5–7, 58–64`).

A resource containing “I authorize publishing this project” would consequently be represented to the permission judge as user-authored authorization, even though it came from a server. A heading such as `Resource @...` does not preserve the structural distinction.

Add persisted provenance for server-supplied text and pictures. Keep the user's typed prompt or slash command in the authorization ledger, and send the expanded resource/prompt content to the lead without classifying it as the user's own instructions. Cover both the live session and resume, and ensure UserPromptSubmit receives the intended user text rather than the expansion.

## 3. [P2] Reconcile remote reconnect with the pre-call stopped check

**Plan lines: 655–657; conflicting requirement at 572–575.**

Task 4 promises that a dropped remote server reconnects once at its next call. Task 6 instead returns a failed result whenever `servers.current(offered)` is `stopped`, before invoking `callTool`. That path cannot reach the reconnect logic. Reconnecting also changes the connection generation, which the stale-call check must account for.

Specify how a stopped remote server remains discoverable or callable for recovery, and perform the permitted reconnect attempt before deciding whether the pending call is still valid. If the new generation requires a fresh model call, report that explicitly rather than silently bypassing the generation check. Test recovery through a complete Session call, not just a direct `Server.callTool` test.

## 4. [P2] Extend the shared hook answer contract for elicitation

**Plan lines: 803–811.**

Task 12 requires Elicitation hooks to return `action` and `content`, and exit 2 to decline. The shared `Combined` result currently has neither field (`src/hooks/answer.ts:14–25`); `combine` discards elicitation actions, and `outcomeOf` treats exit 2 as an ordinary failure for events outside its existing blocking/after lists (`:33–34, 96–99, 171–198`). Task 12 omits this module, while Task 8 lists it only for hook naming.

Explicitly extend answer validation, `Combined`, exit-2 interpretation and combination precedence for both new events. Test accept/content, decline, cancel and competing answers through the real `Hooks.fire` path. Otherwise a successful hook answer can be ignored and a hook intended to decline can still leave a form open.

## 5. [P2] Contain provider-incompatible MCP input schemas

**Plan lines: 652–654; related registration rules at 614–620.**

The plan validates names but sends the offered input schemas directly to providers. `src/providers/anthropic.ts:191` forwards `inputSchema` unchanged. A server tool with a root-level `anyOf`, `oneOf` or `allOf` can therefore reject the entire Anthropic request, even when the user never calls that tool. This is a documented MCP compatibility case, not just malformed server JSON.

Specify schema normalization or exclusion of incompatible tools with a diagnostic, keeping other tools and ordinary turns usable. Include a fake server with one incompatible schema and one ordinary tool, and check both initial loading and a live list update. See [Claude Code's root-level schema handling](https://code.claude.com/docs/en/mcp#tool-input-schemas-with-a-root-level-combinator).

## Scope

Reviewed the implementation plan against the revised 8c design, current session/gate/hook/provider code, and referenced official documentation. An independent reviewer checked integration and lifecycle issues. No implementation changes, tests, installs, experiments, real server launches or sign-in flows were performed.
