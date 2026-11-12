# Release 8c design review

Reviewed: 2026-11-10

Design: [2026-11-10-tachikoma-release-8c-design.md](2026-11-10-tachikoma-release-8c-design.md)

Four findings: two P1 issues and two P2 issues. These are design requirements to resolve before implementation, rather than claims about an existing MCP implementation.

## 1. [P1] Apply provider-specific tool-name limits

**Design lines: 138–140.**

The proposed universal 128-character limit admits names that OpenAI Chat Completions rejects: its function names have a maximum length of 64 characters. Tachikoma's OpenAI-format adapter forwards `ToolSpec.name` unchanged (`src/providers/openai.ts:143`). Consequently, registering one MCP tool with a full name of 65–128 characters can fail every request carrying that tool list, including turns that do not call it. Switching from Anthropic to an OpenAI-format provider can introduce the same failure mid-session.

Specify provider-aware validation or stable provider-safe aliases, including how aliases map back to the original server and tool and how existing history is handled when switching providers. A rejected name must not make the remaining tools or ordinary conversation unusable. Add coverage for a name between 65 and 128 characters and for switching providers with that tool present.

Reference: [OpenAI Chat Completions tool-name requirements](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).

## 2. [P1] Reject or disambiguate generated tool-name collisions

**Design lines: 138–140.**

The sanitization rule is not one-to-one: server names `foo.bar` and `foo_bar` produce identical names for the same tool. The separator is ambiguous too: server `a__b` with tool `c`, and server `a` with tool `b__c`, both become `mcp__a__b__c` without any sanitization.

Current dispatch selects the first tool with a matching name (`src/core/session.ts:840`). Registering both can therefore expose duplicate provider definitions or dispatch a name to a different server than intended. This also makes hook matchers ambiguous and creates a risk if trust or subagent filtering is keyed by the generated name.

Require collision detection across the complete registered tool set, including live list changes. Either reject conflicting registrations with a clear diagnostic or assign stable unique aliases. Preserve the original server/tool identity separately for trust checks, approval text and dispatch; do not reconstruct it by splitting the exposed name. Test both collision examples and a collision introduced by a late-starting server.

## 3. [P2] Define a nonrecursive path for MCP-backed hooks

**Design lines: 213–218.**

The design says hook events see MCP calls, then introduces hooks that themselves call MCP tools, without distinguishing hook-originated calls. A `PreToolUse` hook matching `.*` and invoking an MCP tool would match its own invocation if it uses the ordinary execution path. A matching `PostToolUse` hook can likewise trigger itself repeatedly after completion.

The current session invokes pre-hooks before running the tool (`src/core/session.ts:848–865`), and `Hooks.fire` has no call-origin or recursion guard (`src/hooks/hooks.ts:134` onward). This is an unresolved routing requirement, not an assertion that every possible MCP-client implementation will recurse.

Specify that hook-originated MCP requests use a separate dispatch path that does not emit the same tool hooks, or define another explicitly bounded re-entry policy. State which approval rules apply to this path and preserve project-server authorization, network restrictions, cancellation and the hook timeout. Add a fake-server test with a catch-all MCP-backed pre-hook and post-hook to prove execution remains bounded.

## 4. [P2] Bind pending calls to the advertised server and schema generation

**Design lines: 88–89 and 152–153.**

Live edits restart servers, and list-change notifications replace schemas, but the design does not define what happens to a call the model has already generated or the user is still approving. For example, the model sees version A of a tool, then its server entry is edited or the same tool name receives schema B before approval completes. Dispatching by the current name can execute version B using an approval and arguments intended for A; retaining an old wrapper can instead try to use a closed connection.


Requests currently read specifications from `opts.tools` (`src/core/session.ts:659`), while execution later looks up a tool and waits for hooks and the tool's permission handling (`src/core/session.ts:840–865`). There is no existing MCP-generation contract to settle that interval.

Require a pending call to retain the server identity and schema generation advertised in its originating request. A server replacement, removed tool, or incompatible schema change must either leave that generation valid until the call settles or cancel/refuse the stale call; execution against a replacement requires fresh validation and approval. Trust removal must also invalidate an outstanding permission bypass. Test a restart and list change while a call is awaiting approval.

## Review scope

Reviewed against the current session, hook and provider execution paths, the overall MCP safety design, and the referenced official documentation. An independent reviewer also checked the design. No implementation changes, tests, experiments, real MCP-server launches or sign-in flows were performed.
