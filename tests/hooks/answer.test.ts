import { describe, expect, it } from "vitest";
import { combine, hookName, type Outcome, outcomeOf } from "../../src/hooks/answer.js";
import type { Event, Hook } from "../../src/hooks/config.js";
import type { Ran } from "../../src/hooks/run.js";

// Every Ran here is built by hand: no hook runs (release 8b plan, Task 3, "Tests").
const hookOf = (fields: Partial<Hook> = {}): Hook => ({
  event: "PreToolUse", matcher: { all: true }, command: "node", args: ["check.js"], async: false, where: '"PreToolUse"', ...fields,
});
const ranOf = (fields: Partial<Ran> = {}): Ran => ({ code: 0, stdout: "", stderr: "", ms: 5, ...fields });
// Off Windows, so the Windows-without-Git-Bash rule never applies unless a test asks for it.
const answer = (event: Event, ran: Ran, hook = hookOf()) => outcomeOf(event, hook, ran, "linux", true);
const one = (event: Event, ran: Ran, hook = hookOf()) => combine(event, [{ hook, outcome: answer(event, ran, hook) }]);
const pre = (fields: object) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...fields } });

const READABLE = pre({ permissionDecision: "allow" });
const UNREADABLE = pre({ permissionDecision: "maybe" });
const BAD = `node check.js printed JSON that could not be read ("permissionDecision" must be "allow", "deny", "ask" or "defer")`;

describe("outcomeOf: Claude Code's table, at PreToolUse", () => {
  const json = JSON.parse(READABLE);
  it.each<[string, Partial<Ran>, Outcome]>([
    ["readable JSON, exit 0: the fields apply", { code: 0, stdout: READABLE }, { kind: "ok", json }],
    ["readable JSON, exit 2: a block, the fields still read", { code: 2, stdout: READABLE, stderr: "No.\n" }, { kind: "block", reason: "No.", json }],
    ["readable JSON, exit 1: the code ignored", { code: 1, stdout: READABLE, stderr: "warn\n" }, { kind: "ok", json }],
    ["unreadable JSON, exit 0: a failure", { code: 0, stdout: UNREADABLE }, { kind: "failed", line: BAD }],
    ["unreadable JSON, exit 2: a block, the error output the reason", { code: 2, stdout: UNREADABLE, stderr: "Not that.\n" }, {
      kind: "block", reason: "Not that." }],
    ["unreadable JSON, exit 1: a failure", { code: 1, stdout: UNREADABLE, stderr: "warn\n" }, { kind: "failed", line: BAD }],
    ["plain text, exit 0: success", { code: 0, stdout: "hello\n" }, { kind: "ok" }],
    ["nothing, exit 0: success", { code: 0 }, { kind: "ok" }],
    ["plain text, exit 2: a block", { code: 2, stdout: "hello", stderr: "Blocked: .env\nsecond line\n" }, {
      kind: "block", reason: "Blocked: .env\nsecond line" }],
    ["exit 2, Windows line endings: the reason's lines end in \\n", { code: 2, stderr: "a\r\nb\r\n" }, { kind: "block", reason: "a\nb" }],
    ["plain text, exit 1: a failure, the first line of the error output", { code: 1, stdout: "hello", stderr: "\nboom\nmore\n" }, {
      kind: "failed", line: "node check.js exited with code 1: boom" }],
  ])("%s", (_, ran, outcome) => {
    expect(answer("PreToolUse", ranOf(ran))).toEqual(outcome);
  });

  it("refuses on a deny with exit 1, as the fields alone decide", () => {
    const c = one("PreToolUse", ranOf({ code: 1, stdout: pre({ permissionDecision: "deny", permissionDecisionReason: "Not in src" }) }));
    expect(c).toMatchObject({ decision: "deny", reason: "Not in src", block: "Not in src" });
  });

  it('with onFailure "block", the same deny on exit 1 is a failure that blocks, its reason the error output\'s first line', () => {
    const hook = hookOf({ onFailure: "block" });
    const stdout = pre({ permissionDecision: "deny", permissionDecisionReason: "Not in src" });
    expect(answer("PreToolUse", ranOf({ code: 1, stdout, stderr: "oops\nmore\n" }), hook)).toEqual({ kind: "block", reason: "oops" });
    // Without error output, the failure's words.
    expect(answer("PreToolUse", ranOf({ code: 1, stdout }), hook)).toEqual({ kind: "block", reason: "node check.js exited with code 1" });
    // Out of time, could not start, unreadable JSON, or a signal without error output: the failure's own words, whatever
    // the error output says (the user's choice at Task 3's review).
    expect(answer("PreToolUse", ranOf({ code: 0, stdout: UNREADABLE, stderr: "note\n" }), hook)).toEqual({ kind: "block", reason: BAD });
    expect(answer("PreToolUse", ranOf({ code: null, failed: "time", limit: 600, stderr: "still working\n" }), hook)).toEqual({
      kind: "block", reason: "node check.js ran out of time after 600 s" });
    expect(answer("PreToolUse", ranOf({ code: null, failed: "start", startError: "spawn x ENOENT" }), hook)).toEqual({
      kind: "block", reason: "node check.js could not start (spawn x ENOENT)" });
    expect(answer("PreToolUse", ranOf({ code: null, signal: "SIGKILL" }), hook)).toEqual({
      kind: "block", reason: "node check.js was ended by signal SIGKILL" });
    // A signal with error output, as an exit code with it: the first line.
    expect(answer("PreToolUse", ranOf({ code: null, signal: "SIGTERM", stderr: "dying\n" }), hook)).toEqual({ kind: "block", reason: "dying" });
    // A success stays one.
    expect(answer("PreToolUse", ranOf({ code: 0, stdout: READABLE }), hook)).toEqual({ kind: "ok", json: JSON.parse(READABLE) });
    expect(combine("PreToolUse", [{ hook, outcome: answer("PreToolUse", ranOf({ code: 1, stdout, stderr: "oops" }), hook) }])).toMatchObject({
      decision: "deny", block: "oops", failures: [] });
    // Exit 2 wins over unreadable JSON: a block, its reason the error output.
    expect(answer("PreToolUse", ranOf({ code: 2, stdout: UNREADABLE, stderr: "Not that.\nat line 2\n" }), hook)).toEqual({
      kind: "block", reason: "Not that.\nat line 2" });
  });

  it("on Windows without Git Bash, a PreToolUse hook run by a shell counts only from exit 0 or 2", () => {
    const shell = hookOf({ command: "check.sh", args: undefined });
    const ran = ranOf({ code: 1, stdout: pre({ permissionDecision: "allow" }), stderr: "bad\n" });
    expect(outcomeOf("PreToolUse", shell, ran, "win32", false)).toEqual({ kind: "block", reason: "bad" });
    // Not with Git Bash, nor off Windows, nor for an exec-form hook, nor with onFailure "continue".
    expect(outcomeOf("PreToolUse", shell, ran, "win32", true).kind).toBe("ok");
    expect(outcomeOf("PreToolUse", shell, ran, "linux", false).kind).toBe("ok");
    expect(outcomeOf("PreToolUse", hookOf(), ran, "win32", false).kind).toBe("ok");
    expect(outcomeOf("PreToolUse", { ...shell, onFailure: "continue" }, ran, "win32", false).kind).toBe("ok");
    // Only PreToolUse: at Stop the failure stays one.
    expect(outcomeOf("Stop", { ...shell, event: "Stop" }, ranOf({ code: 1, stderr: "bad" }), "win32", false)).toEqual({
      kind: "failed", line: "check.sh exited with code 1: bad" });
  });

  it("ignores a top-level permissionDecision, as Claude Code does", () => {
    const c = one("PreToolUse", ranOf({ stdout: JSON.stringify({ permissionDecision: "deny", permissionDecisionReason: "x" }) }));
    expect(c.decision).toBeUndefined();
    expect(c.block).toBeUndefined();
  });

  it("takes the old decision values approve and block as allow and deny", () => {
    expect(one("PreToolUse", ranOf({ stdout: JSON.stringify({ decision: "approve", reason: "fine" }) }))).toMatchObject({ decision: "allow", reason: "fine" });
    expect(one("PreToolUse", ranOf({ stdout: JSON.stringify({ decision: "block", reason: "no" }) }))).toMatchObject({
      decision: "deny", reason: "no", block: "no" });
  });

  it("takes hookSpecificOutput's permissionDecision over the old decision, with its own reason", () => {
    const stdout = JSON.stringify({ decision: "block", reason: "old", hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "new" } });
    const c = one("PreToolUse", ranOf({ stdout }));
    expect(c).toMatchObject({ decision: "allow", reason: "new" });
    expect(c.block).toBeUndefined();
  });

  it("an exit 2 is a deny that the fields cannot undo", () => {
    expect(one("PreToolUse", ranOf({ code: 2, stdout: READABLE, stderr: "No." }))).toMatchObject({ decision: "deny", reason: "No.", block: "No." });
  });
});

describe("outcomeOf: what makes JSON unreadable", () => {
  const line = (event: Event, stdout: string) => answer(event, ranOf({ stdout }));
  const failed = (reason: string) => ({ kind: "failed", line: `node check.js printed JSON that could not be read (${reason})` });

  it("a hookEventName of another event", () => {
    expect(line("PreToolUse", JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "x" } }))).toEqual(
      failed('"hookSpecificOutput" names PostToolUse'));
  });

  it("an object cut short, or text after it, on exit 0, and with onFailure \"block\" they block", () => {
    expect(line("PreToolUse", '{"hookSpecificOutput":')).toEqual(failed("it is cut short"));
    expect(line("PreToolUse", '{"a": 1} trailing')).toEqual(failed("there is text after the object"));
    // A string cut short is the object cut short too.
    expect(line("PreToolUse", '{"systemMessage": "Hel')).toEqual(failed("it is cut short"));
    const hook = hookOf({ onFailure: "block" });
    expect(answer("PreToolUse", ranOf({ stdout: '{"hookSpecificOutput":' }), hook)).toEqual({
      kind: "block", reason: "node check.js printed JSON that could not be read (it is cut short)" });
    expect(answer("PreToolUse", ranOf({ stdout: '{"a": 1} trailing' }), hook)).toEqual({
      kind: "block", reason: "node check.js printed JSON that could not be read (there is text after the object)" });
  });

  it("takes a JSON array as plain text, as only an object is JSON", () => {
    expect(line("SessionStart", "[1, 2]")).toEqual({ kind: "ok", text: "[1, 2]" });
    expect(line("PreToolUse", '[{"hookSpecificOutput": 1}]')).toEqual({ kind: "ok" });
  });

  it("other broken JSON gives the parser's own words", () => {
    let words = "";
    try {
      JSON.parse("{abc}");
    } catch (err) {
      words = (err as Error).message;
    }
    expect(line("PreToolUse", "  {abc}  ")).toEqual(failed(words));
  });

  it("a field of the wrong type, each with its words", () => {
    const cases: [Event, object, string][] = [
      ["Stop", { continue: "no" }, '"continue" must be true or false'],
      ["Stop", { stopReason: 3 }, '"stopReason" must be text in quotes'],
      ["SessionEnd", { systemMessage: 1 }, '"systemMessage" must be text in quotes'],
      ["Stop", { decision: "stop" }, '"decision" must be "approve" or "block"'],
      ["Stop", { reason: ["a"] }, '"reason" must be text in quotes'],
      ["Stop", { hookSpecificOutput: "Stop" }, '"hookSpecificOutput" must be an object'],
      ["Stop", { hookSpecificOutput: { additionalContext: "x" } }, '"hookSpecificOutput" has no "hookEventName"'],
      ["Stop", { hookSpecificOutput: { hookEventName: 1 } }, '"hookEventName" must be text in quotes'],
      ["SessionStart", { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: 1 } }, '"additionalContext" must be text in quotes'],
      ["PreToolUse", { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecisionReason: false } },
        '"permissionDecisionReason" must be text in quotes'],
      ["PreToolUse", { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: "ls" } }, '"updatedInput" must be an object'],
    ];
    for (const [event, json, reason] of cases) expect(line(event, JSON.stringify(json)), reason).toEqual(failed(reason));
  });

  // The user's choice, 2026-11-09: null means left out.
  it("takes a field printed as null as left out", () => {
    const nulls = { systemMessage: null, continue: null, stopReason: null, decision: null, reason: null };
    const specific = { hookEventName: "PreToolUse", additionalContext: null, permissionDecision: null, permissionDecisionReason: null, updatedInput: null };
    const outcome = answer("PreToolUse", ranOf({ stdout: JSON.stringify({ ...nulls, hookSpecificOutput: specific }) }));
    expect(outcome.kind).toBe("ok");
    expect(combine("PreToolUse", [{ hook: hookOf(), outcome }])).toEqual({ context: [], messages: [], instructions: [], deferred: false, failures: [] });
    // "reason": null is no reason.
    expect(one("Stop", ranOf({ stdout: JSON.stringify({ decision: "block", reason: null }) })).block).toBe("");
    expect(one("PostToolUse", ranOf({ stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: null } }) })).output)
      .toBeUndefined();
    expect(one("Stop", ranOf({ stdout: JSON.stringify({ hookSpecificOutput: null }) })).failures).toEqual([]);
    expect(line("Stop", JSON.stringify({ hookSpecificOutput: { hookEventName: null } }))).toEqual(failed('"hookSpecificOutput" has no "hookEventName"'));
  });

  it("does not check a field the event does not read", () => {
    expect(line("SessionStart", JSON.stringify({ continue: "no", decision: "stop" })).kind).toBe("ok");
    expect(line("PreCompact", JSON.stringify({ hookSpecificOutput: { hookEventName: "PreCompact", additionalContext: 1 } })).kind).toBe("ok");
  });
});

describe("outcomeOf: the failure lines", () => {
  it.each<[string, Partial<Ran>, string]>([
    ["another exit code", { code: 3, stderr: "Error: no config\n  at x\n" }, "node check.js exited with code 3: Error: no config"],
    ["another exit code, no error output", { code: 3 }, "node check.js exited with code 3"],
    ["could not start", { code: null, failed: "start", startError: "not found on PATH" }, "node check.js could not start (not found on PATH)"],
    ["out of time", { code: null, failed: "time", limit: 30 }, "node check.js ran out of time after 30 s"],
    ["a signal", { code: null, signal: "SIGKILL", stderr: "dying\n" }, "node check.js was ended by signal SIGKILL: dying"],
    ["a signal, no error output", { code: null, signal: "SIGTERM" }, "node check.js was ended by signal SIGTERM"],
    ["neither code nor signal", { code: null }, "node check.js was ended by an unknown signal"],
  ])("%s", (_, ran, line) => {
    expect(answer("Stop", ranOf(ran))).toEqual({ kind: "failed", line });
  });

  it("a shell-form hook is named by its command alone", () => {
    expect(answer("Stop", ranOf({ code: 1 }), hookOf({ command: "./check.sh --all", args: undefined }))).toEqual({
      kind: "failed", line: "./check.sh --all exited with code 1" });
  });
});

// The short name /hooks and Ctrl+O give a hook (the user's choice, 2026-11-10, terminal checklist).
describe("hookName", () => {
  it.each<[string, Partial<Hook>, string]>([
    ["its statusMessage", { statusMessage: "protected paths guard" }, "protected paths guard"],
    ["the program and the script, from args", { command: "node", args: ["--no-warnings", "C:\\t\\check.js"] }, "node check.js"],
    ["a trailing .exe dropped, any case", { command: "C:\\Program Files\\nodejs\\NODE.Exe", args: ["C:\\t\\fail.js"] }, "NODE fail.js"],
    ["an empty statusMessage, as none", { command: "/usr/bin/node", args: ["x.test.mjs"], statusMessage: "" }, "node x.test.mjs"],
    ["a shell command's quoted path", { command: 'bash "C:/a b/recall.sh" --quiet', args: undefined }, "bash recall.sh"],
    ["a shell command with no file after it", { command: `jq -r '.tool_input.file_path | test("\\\\.git/")' || exit 2`, args: undefined }, "jq"],
    ["the program alone", { command: "check", args: undefined }, "check"],
    // Claude Code's documented form: pieces that touch, with no space between, are one word.
    ["a quoted piece joined to the rest", { command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/check-style.sh', args: undefined }, "check-style.sh"],
    ["PowerShell's call operator skipped", { command: '& "C:\\Program Files\\nodejs\\node.exe" C:\\h\\x.js', args: undefined }, "node x.js"],
    ["leading variables skipped", { command: "FOO=1 BAR_2=a/b.js node x.js", args: undefined }, "node x.js"],
    ["a statusMessage of spaces, as none", { command: "node", args: ["a.js"], statusMessage: "   " }, "node a.js"],
    ["a statusMessage's spaces around it taken off", { statusMessage: " guard " }, "guard"],
    // A blank name falls back to the whole command, or with that blank too, the command in quotes.
    ["no program, the whole command", { command: "", args: ["x.js"] }, "x.js"],
    ["variables alone, the whole command", { command: "FOO=1", args: undefined }, "FOO=1"],
    ["an empty command, in quotes", { command: "", args: undefined }, '""'],
    ["a command of spaces, in quotes", { command: "   ", args: undefined }, '"   "'],
  ])("%s", (_, fields, name) => {
    expect(hookName(hookOf(fields))).toBe(name);
  });

  // Release 8c design, "Hooks": an mcp_tool hook by its server and tool, or its statusMessage.
  it("names an mcp_tool hook by its server and tool, or its statusMessage", () => {
    const mcp = { command: "", args: undefined, mcp: { server: "tradingview", tool: "quote_get", input: {} } };
    expect(hookName(hookOf(mcp))).toBe("tradingview quote_get");
    expect(hookName(hookOf({ ...mcp, statusMessage: "Quoting" }))).toBe("Quoting");
  });
});

// Release 8c plan, choice 21 and "Lines this plan adds": an mcp_tool hook's answer is read as a command hook's, and its
// failures have lines of their own.
describe("outcomeOf: an mcp_tool hook", () => {
  const mcp = (fields: Partial<Hook> = {}) => hookOf({ command: "", args: undefined, mcp: { server: "memory", tool: "search", input: {} }, ...fields });
  it.each<[string, Partial<Ran>, string]>([
    ["an error answer, its first line", { failed: "error", reason: "\nboom\nmore\n" }, "memory search answered an error: boom"],
    ["an error answer with no text", { failed: "error", reason: "" }, "memory search answered an error"],
    ["a server not running", { failed: "call", reason: "memory is not running" }, "memory search could not be called: memory is not running"],
    ["out of time", { failed: "time", limit: 600 }, "memory search ran out of time after 600 s"],
  ])("%s", (_, ran, line) => {
    expect(answer("Stop", ranOf({ code: null, ...ran }), mcp())).toEqual({ kind: "failed", line });
  });

  it("reads its text as a command hook's printed output", () => {
    expect(answer("UserPromptSubmit", ranOf({ stdout: "remember this" }), mcp())).toEqual({ kind: "ok", text: "remember this" });
    expect(answer("PreToolUse", ranOf({ stdout: READABLE }), mcp())).toEqual({ kind: "ok", json: JSON.parse(READABLE) });
  });

  // Claude Code's rule: an isError answer is a non-blocking error, whatever onFailure says; the server not running blocks
  // with onFailure "block", as a command that could not start does.
  it("never blocks for an error answer, and blocks for a server not running only with onFailure block", () => {
    const hook = mcp({ onFailure: "block" });
    expect(answer("PreToolUse", ranOf({ code: null, failed: "error", reason: "boom" }), hook)).toEqual({
      kind: "failed", line: "memory search answered an error: boom" });
    expect(answer("PreToolUse", ranOf({ code: null, failed: "call", reason: "memory is not running" }), hook)).toEqual({
      kind: "block", reason: "memory is not running" });
  });

  it("is not a shell's hook, so Windows without Git Bash makes none of its failures a block", () => {
    const ran = ranOf({ code: null, failed: "call", reason: "memory is not running" });
    expect(outcomeOf("PreToolUse", mcp(), ran, "win32", false)).toEqual({ kind: "failed", line: "memory search could not be called: memory is not running" });
  });
});

describe("outcomeOf: the events that cannot block (the design's table row)", () => {
  it("at SessionStart, SessionEnd, SubagentStart and PostCompact, exit 2 is a failure", () => {
    for (const event of ["SessionStart", "SessionEnd", "SubagentStart", "PostCompact"] as const) {
      expect(answer(event, ranOf({ code: 2, stderr: "no\n" }))).toEqual({ kind: "failed", line: "node check.js exited with code 2: no" });
      // Whatever it printed.
      expect(answer(event, ranOf({ code: 2, stdout: JSON.stringify({ systemMessage: "hi" }) }))).toEqual({
        kind: "failed", line: "node check.js exited with code 2" });
    }
  });

  it('onFailure "block" makes a block only at the events that can block', () => {
    const hook = hookOf({ onFailure: "block" });
    for (const event of ["UserPromptSubmit", "PreToolUse", "Stop", "SubagentStop", "PreCompact"] as const) {
      expect(answer(event, ranOf({ code: 1, stderr: "x" }), hook), event).toEqual({ kind: "block", reason: "x" });
    }
    for (const event of ["SessionStart", "SessionEnd", "SubagentStart", "PostCompact", "PostToolUse", "PostToolUseFailure"] as const) {
      expect(answer(event, ranOf({ code: 1, stderr: "x" }), hook), event).toEqual({ kind: "failed", line: "node check.js exited with code 1: x" });
    }
  });
});

// Release 8e plan, step 2: the three events whose whole answer is ignored, and the two permission events.
describe("outcomeOf and combine: Notification, StopFailure, InstructionsLoaded, PermissionDenied and PermissionRequest", () => {
  const IGNORED = ["Notification", "StopFailure", "InstructionsLoaded"] as const;
  const FIVE = [...IGNORED, "PermissionDenied", "PermissionRequest"] as const;
  const specific = (event: Event, fields: object, top: object = {}) => JSON.stringify({ ...top, hookSpecificOutput: { hookEventName: event, ...fields } });
  const allow = specific("PermissionRequest", { decision: { behavior: "allow" } });
  const retry = specific("PermissionDenied", { retry: true });
  const unreadable = (event: Event) =>
    event === "PermissionRequest" ? specific(event, { decision: { behavior: "maybe" } })
      : event === "PermissionDenied" ? specific(event, { retry: "yes" }) : '{"hookSpecificOutput":';
  const badLine = (event: Event) =>
    `node check.js printed JSON that could not be read (${event === "PermissionRequest" ? '"behavior" must be "allow" or "deny"' : '"retry" must be true or false'})`;
  const readable = (event: Event) =>
    event === "PermissionRequest" ? allow : event === "PermissionDenied" ? retry
      : specific(event, { additionalContext: "ctx" }, { systemMessage: "hi", continue: false });

  // For each event, each exit code with plain text, readable JSON and unreadable JSON: what it gives.
  const expected = (event: Event, code: number, kind: "plain" | "readable" | "unreadable"): Outcome => {
    if ((IGNORED as readonly Event[]).includes(event)) return { kind: "ok" };
    if (event === "PermissionRequest" && code === 2) return { kind: "ok" };
    if (kind === "unreadable") return { kind: "failed", line: badLine(event) };
    if (kind === "readable") return { kind: "ok", json: JSON.parse(readable(event)) };
    if (event === "PermissionRequest" && code === 1) return { kind: "failed", line: "node check.js exited with code 1: warn" };
    return { kind: "ok" };
  };
  const cells = FIVE.flatMap((event) => [0, 1, 2].flatMap((code) => (["plain", "readable", "unreadable"] as const).map((kind) => [event, code, kind] as const)));
  it.each(cells)("at %s, exit code %i with %s output gives what release 8e plan, step 2 says, and no line where the code is ignored", (event, code, kind) => {
    const stdout = kind === "plain" ? "hello\n" : kind === "readable" ? readable(event) : unreadable(event);
    const outcome = answer(event, ranOf({ code, stdout, stderr: "warn\n" }));
    expect(outcome).toEqual(expected(event, code, kind));
    // onFailure "block" changes nothing at these five.
    expect(answer(event, ranOf({ code, stdout, stderr: "warn\n" }), hookOf({ onFailure: "block" }))).toEqual(outcome);
  });

  it("gives no line at Notification, StopFailure, InstructionsLoaded and PermissionDenied for a hook ended by a signal, nor for any other exit code (release 8e plan, step 2)", () => {
    for (const event of [...IGNORED, "PermissionDenied"] as const) {
      expect(answer(event, ranOf({ code: null, signal: "SIGKILL", stderr: "dying\n" })), event).toEqual({ kind: "ok" });
      expect(answer(event, ranOf({ code: 3, stderr: "x\n" })), event).toEqual({ kind: "ok" });
    }
  });

  it("keeps the runner's own failures as failures with their lines at all five, deciding nothing, onFailure \"block\" or not (release 8e plan, step 2)", () => {
    const mcp = (fields: Partial<Hook> = {}) => hookOf({ command: "", args: undefined, mcp: { server: "memory", tool: "search", input: {} }, ...fields });
    const cases: [Hook, Partial<Ran>, string][] = [
      [hookOf(), { failed: "start", startError: "spawn x ENOENT" }, "node check.js could not start (spawn x ENOENT)"],
      [hookOf(), { failed: "time", limit: 600 }, "node check.js ran out of time after 600 s"],
      [mcp(), { failed: "call", reason: "memory is not running" }, "memory search could not be called: memory is not running"],
      [mcp(), { failed: "error", reason: "boom\nmore" }, "memory search answered an error: boom"],
      [mcp(), { failed: "time", limit: 600 }, "memory search ran out of time after 600 s"],
    ];
    for (const event of FIVE) {
      for (const [hook, ran, line] of cases) {
        for (const h of [hook, { ...hook, onFailure: "block" as const }]) {
          const outcome = answer(event, ranOf({ code: null, ...ran }), h);
          expect(outcome, `${event} ${line}`).toEqual({ kind: "failed", line });
          expect(combine(event, [{ hook: h, outcome }]), `${event} ${line}`).toEqual({
            context: [], messages: [], instructions: [], deferred: false, failures: [line] });
        }
      }
    }
  });

  it("reads an mcp_tool hook's text as a command hook's printed output on exit 0: an allow, a deny, a retry (release 8e plan, step 2)", () => {
    const mcp = hookOf({ command: "", args: undefined, mcp: { server: "memory", tool: "search", input: {} } });
    const deny = specific("PermissionRequest", { decision: { behavior: "deny", message: "Not here" } });
    expect(one("PermissionRequest", ranOf({ stdout: allow }), mcp)).toMatchObject({ decision: "allow" });
    expect(one("PermissionRequest", ranOf({ stdout: deny }), mcp)).toMatchObject({ decision: "deny", reason: "Not here" });
    expect(one("PermissionDenied", ranOf({ stdout: retry }), mcp)).toMatchObject({ retry: true });
  });

  it("takes PermissionRequest's allow, and a deny with its message or none, with interrupt, and sets no block (release 8e plan, step 2)", () => {
    const decide = (decision: object, code = 0) => one("PermissionRequest", ranOf({ code, stdout: specific("PermissionRequest", { decision }) }));
    expect(decide({ behavior: "allow" })).toEqual({ decision: "allow", reason: "", context: [], messages: [], instructions: [], deferred: false, failures: [] });
    const denied = decide({ behavior: "deny", message: "Not in src" });
    expect(denied).toMatchObject({ decision: "deny", reason: "Not in src" });
    expect([denied.block, denied.interrupt, denied.stop]).toEqual([undefined, undefined, undefined]);
    expect(decide({ behavior: "deny" })).toMatchObject({ decision: "deny", reason: "" });
    expect(decide({ behavior: "deny", message: "Stop now", interrupt: true })).toMatchObject({ decision: "deny", reason: "Stop now", interrupt: true });
    expect(decide({ behavior: "deny", interrupt: false }).interrupt).toBeUndefined();
    // Readable JSON on exit 1 counts, as 8b reads it; on exit 2 it decides nothing.
    expect(decide({ behavior: "deny", message: "x" }, 1)).toMatchObject({ decision: "deny", reason: "x" });
    expect(decide({ behavior: "allow" }, 2)).toEqual({ context: [], messages: [], instructions: [], deferred: false, failures: [] });
    // No behavior decides nothing.
    expect(decide({ message: "x" }).decision).toBeUndefined();
  });

  it("takes an allow's updatedInput as the rewrite, notes updatedPermissions, and drops a rewrite beside a deny (release 8e plan, step 2)", () => {
    const decide = (decision: object) => one("PermissionRequest", ranOf({ stdout: specific("PermissionRequest", { decision }) }));
    const hook = hookOf();
    const rewritten = combine("PermissionRequest", [{
      hook, outcome: answer("PermissionRequest", ranOf({ stdout: specific("PermissionRequest", { decision: { behavior: "allow", updatedInput: { command: "ls" } } }) })),
    }]);
    expect(rewritten).toMatchObject({ decision: "allow", rewrite: { input: { command: "ls" }, from: hook, ignored: [] } });
    expect(decide({ behavior: "allow", updatedPermissions: [{ type: "addRules" }] })).toMatchObject({ decision: "allow", updatedPermissions: true });
    expect(decide({ behavior: "deny", updatedPermissions: [] }).updatedPermissions).toBe(true);
    expect(decide({ behavior: "allow" }).updatedPermissions).toBeUndefined();
    expect(decide({ behavior: "deny", updatedInput: { command: "ls" } }).rewrite).toBeUndefined();
  });

  describe("several PermissionRequest hooks", () => {
    const hookAt = (decision: object, name: string) => {
      const hook = hookOf({ args: [name] });
      return { hook, outcome: answer("PermissionRequest", ranOf({ stdout: specific("PermissionRequest", { decision }) }), hook) };
    };

    it("deny over allow, in both orders, the deny's message and interrupt kept (release 8e plan, step 2)", () => {
      const two = [hookAt({ behavior: "allow" }, "a"), hookAt({ behavior: "deny", message: "No", interrupt: true }, "b")];
      expect(combine("PermissionRequest", two)).toMatchObject({ decision: "deny", reason: "No", interrupt: true });
      expect(combine("PermissionRequest", [...two].reverse())).toMatchObject({ decision: "deny", reason: "No", interrupt: true });
    });

    it("of two rewrites, takes the first in the file and names the other, and drops both beside a deny (release 8e plan, step 2)", () => {
      const first = hookAt({ behavior: "allow", updatedInput: { command: "sfw npm i" } }, "first");
      const second = hookAt({ behavior: "allow", updatedInput: { command: "npm i --dry-run" } }, "second");
      expect(combine("PermissionRequest", [first, second]).rewrite).toEqual({ input: { command: "sfw npm i" }, from: first.hook, ignored: [second.hook] });
      const denied = combine("PermissionRequest", [first, second, hookAt({ behavior: "deny" }, "deny")]);
      expect(denied).toMatchObject({ decision: "deny", reason: "" });
      expect(denied.rewrite).toBeUndefined();
    });
  });

  it("takes PermissionDenied's retry: true, at any exit code, and nothing else as a retry (release 8e plan, step 2)", () => {
    for (const code of [0, 1, 2]) expect(one("PermissionDenied", ranOf({ code, stdout: retry })).retry, `exit ${code}`).toBe(true);
    expect(one("PermissionDenied", ranOf({ stdout: specific("PermissionDenied", { retry: false }) })).retry).toBeUndefined();
    expect(one("PermissionDenied", ranOf({ stdout: JSON.stringify({ retry: true }) })).retry).toBeUndefined();
    expect(one("PermissionDenied", ranOf({ stdout: "retry" })).retry).toBeUndefined();
  });

  it("reads neither continue: false nor additionalContext at the two permission events (release 8e plan, step 2)", () => {
    for (const event of ["PermissionRequest", "PermissionDenied"] as const) {
      const c = one(event, ranOf({ stdout: specific(event, { additionalContext: "ctx" }, { continue: false, stopReason: "Halt" }) }));
      expect(c, event).toEqual({ context: [], messages: [], instructions: [], deferred: false, failures: [] });
    }
    // continue: false does not undo a deny there.
    const denied = one("PermissionRequest", ranOf({ stdout: specific("PermissionRequest", { decision: { behavior: "deny", message: "No" } }, { continue: false }) }));
    expect(denied).toMatchObject({ decision: "deny", reason: "No" });
    expect(denied.stop).toBeUndefined();
  });

  it("keeps a systemMessage at the two permission events and drops it at Notification, StopFailure and InstructionsLoaded (release 8e plan, step 2)", () => {
    for (const event of ["PermissionRequest", "PermissionDenied"] as const) {
      expect(one(event, ranOf({ stdout: JSON.stringify({ systemMessage: "Checked" }) })).messages, event).toEqual(["Checked"]);
    }
    for (const event of IGNORED) expect(one(event, ranOf({ stdout: JSON.stringify({ systemMessage: "Checked" }) })).messages, event).toEqual([]);
  });

  it("does not turn a PermissionRequest hook that cannot start into a refusal with onFailure \"block\" (release 8e plan, step 2, Q28)", () => {
    const hook = hookOf({ onFailure: "block" });
    const outcome = answer("PermissionRequest", ranOf({ code: null, failed: "start", startError: "spawn x ENOENT" }), hook);
    const c = combine("PermissionRequest", [{ hook, outcome }]);
    expect(c).toEqual({ context: [], messages: [], instructions: [], deferred: false, failures: ["node check.js could not start (spawn x ENOENT)"] });
  });

  it("takes a hookSpecificOutput naming another event, or a field of the wrong type, as JSON that could not be read at the two permission events (release 8e plan, step 2)", () => {
    const failed = (reason: string) => ({ kind: "failed", line: `node check.js printed JSON that could not be read (${reason})` });
    expect(answer("PermissionRequest", ranOf({ stdout: specific("PreToolUse", { permissionDecision: "allow" }) }))).toEqual(
      failed('"hookSpecificOutput" names PreToolUse'));
    expect(answer("PermissionDenied", ranOf({ stdout: specific("PermissionRequest", { decision: { behavior: "allow" } }) }))).toEqual(
      failed('"hookSpecificOutput" names PermissionRequest'));
    const cases: [Event, object, string][] = [
      ["PermissionRequest", { decision: "allow" }, '"decision" must be an object'],
      ["PermissionRequest", { decision: { behavior: "ask" } }, '"behavior" must be "allow" or "deny"'],
      ["PermissionRequest", { decision: { behavior: "deny", message: 1 } }, '"message" must be text in quotes'],
      ["PermissionRequest", { decision: { behavior: "deny", interrupt: "yes" } }, '"interrupt" must be true or false'],
      ["PermissionRequest", { decision: { behavior: "allow", updatedInput: "ls" } }, '"updatedInput" must be an object'],
      ["PermissionDenied", { retry: 1 }, '"retry" must be true or false'],
    ];
    for (const [event, fields, reason] of cases) expect(answer(event, ranOf({ stdout: specific(event, fields) })), reason).toEqual(failed(reason));
    // A field these events do not read is not looked at.
    expect(answer("PermissionRequest", ranOf({ stdout: JSON.stringify({ continue: "no", decision: "stop" }) })).kind).toBe("ok");
  });
});

describe("combine", () => {
  const decide = (permissionDecision: string, reason: string) => ({
    hook: hookOf({ args: [reason] }),
    outcome: answer("PreToolUse", ranOf({ stdout: pre({ permissionDecision, permissionDecisionReason: reason }) })),
  });

  it("deny over ask over allow, in both orders", () => {
    const three = [decide("allow", "a"), decide("ask", "b"), decide("deny", "c")];
    expect(combine("PreToolUse", three)).toMatchObject({ decision: "deny", reason: "c", block: "c" });
    expect(combine("PreToolUse", [...three].reverse())).toMatchObject({ decision: "deny", reason: "c", block: "c" });
    expect(combine("PreToolUse", [decide("allow", "a"), decide("ask", "b")])).toMatchObject({ decision: "ask", reason: "b" });
    expect(combine("PreToolUse", [decide("ask", "b"), decide("allow", "a")])).toMatchObject({ decision: "ask", reason: "b" });
    expect(combine("PreToolUse", [decide("ask", "b"), decide("allow", "a")]).block).toBeUndefined();
  });

  it("takes defer as no opinion, and says it was given", () => {
    const c = combine("PreToolUse", [decide("defer", "d")]);
    expect(c.deferred).toBe(true);
    expect(c.decision).toBeUndefined();
    expect(combine("PreToolUse", [decide("defer", "d"), decide("allow", "a")])).toMatchObject({ deferred: true, decision: "allow" });
  });

  it("of two rewrites, takes the first in the file and names the other", () => {
    const rewrite = (command: string) => {
      const hook = hookOf({ args: [command] });
      return { hook, outcome: answer("PreToolUse", ranOf({ stdout: pre({ updatedInput: { command } }) }), hook) };
    };
    const [first, second] = [rewrite("sfw npm i"), rewrite("npm i --dry-run")];
    expect(combine("PreToolUse", [first, second]).rewrite).toEqual({ input: { command: "sfw npm i" }, from: first.hook, ignored: [second.hook] });
  });

  it("cuts a context over 10,000 characters", () => {
    const context = (text: string) =>
      one("SessionStart", ranOf({ stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }) }));
    expect(context("x".repeat(10_001)).context).toEqual([{ event: "SessionStart", text: `${"x".repeat(10_000)}\n[cut: 1 more characters]` }]);
    expect(context("x".repeat(10_000)).context).toEqual([{ event: "SessionStart", text: "x".repeat(10_000) }]);
  });

  it("continue: false stops, with its stopReason or none, and wins over everything else", () => {
    expect(one("PreToolUse", ranOf({ stdout: JSON.stringify({ continue: false, stopReason: "Build broken" }) })).stop).toBe("Build broken");
    expect(one("PreToolUse", ranOf({ stdout: JSON.stringify({ continue: false }) })).stop).toBe("");
    const c = combine("PreToolUse", [
      decide("deny", "c"),
      { hook: hookOf(), outcome: answer("PreToolUse", ranOf({ stdout: JSON.stringify({ continue: false, systemMessage: "Stopping" }) })) },
    ]);
    expect(c).toMatchObject({ stop: "", messages: ["Stopping"] });
    expect(c.decision).toBeUndefined();
    expect(c.block).toBeUndefined();
    // It clears a rewrite, and PostToolUse's new output: the call keeps its own result (design).
    const rewritten = one("PreToolUse", ranOf({
      stdout: JSON.stringify({ continue: false, hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "ls" } } }),
    }));
    expect(rewritten.stop).toBe("");
    expect(rewritten.rewrite).toBeUndefined();
    const output = one("PostToolUse", ranOf({
      stdout: JSON.stringify({ continue: false, hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: "x" } }),
    }));
    expect(output.stop).toBe("");
    expect(output.output).toBeUndefined();
  });

  it("gives PostToolUse's block as text for the model, next to the result, and no block", () => {
    const c = one("PostToolUse", ranOf({ stdout: JSON.stringify({ decision: "block", reason: "Fix the lint errors" }) }));
    expect(c.context).toEqual([{ event: "PostToolUse", text: "Fix the lint errors" }]);
    expect(c.block).toBeUndefined();
    const failure = one("PostToolUseFailure", ranOf({ code: 2, stderr: "Try again\n" }));
    expect(failure.context).toEqual([{ event: "PostToolUseFailure", text: "Try again" }]);
    expect(failure.block).toBeUndefined();
  });

  it("keeps a SessionStart systemMessage while ignoring its continue: false", () => {
    const c = one("SessionStart", ranOf({ stdout: JSON.stringify({ continue: false, stopReason: "x", systemMessage: "Memory loaded" }) }));
    expect(c.messages).toEqual(["Memory loaded"]);
    expect(c.stop).toBeUndefined();
  });

  it("ignores continue at PreCompact and PostCompact, and a block at an event that cannot block", () => {
    expect(one("PreCompact", ranOf({ stdout: JSON.stringify({ continue: false }) })).stop).toBeUndefined();
    expect(one("PostCompact", ranOf({ stdout: JSON.stringify({ continue: false }) })).stop).toBeUndefined();
    expect(one("SubagentStart", ranOf({ stdout: JSON.stringify({ decision: "block", reason: "no" }) })).block).toBeUndefined();
  });

  it("blocks at Stop, UserPromptSubmit and PreCompact by decision or exit 2", () => {
    expect(one("Stop", ranOf({ stdout: JSON.stringify({ decision: "block", reason: "Run the tests" }) })).block).toBe("Run the tests");
    expect(one("UserPromptSubmit", ranOf({ code: 2, stderr: "No secrets\n" })).block).toBe("No secrets");
    expect(one("PreCompact", ranOf({ code: 2 })).block).toBe("");
  });

  it("gives plain output on exit 0 to the model at SessionStart and UserPromptSubmit, as instructions at PreCompact, and drops it elsewhere", () => {
    expect(one("SessionStart", ranOf({ stdout: "Wake-up text\n" })).context).toEqual([{ event: "SessionStart", text: "Wake-up text" }]);
    expect(one("UserPromptSubmit", ranOf({ stdout: "Today is Monday" })).context).toEqual([{ event: "UserPromptSubmit", text: "Today is Monday" }]);
    expect(one("PreCompact", ranOf({ stdout: "Keep the test names" }))).toMatchObject({ context: [], instructions: ["Keep the test names"] });
    expect(one("Stop", ranOf({ stdout: "hello" }))).toMatchObject({ context: [], instructions: [] });
    expect(one("PreToolUse", ranOf({ stdout: "hello" })).context).toEqual([]);
  });

  it("reads additionalContext except at SessionEnd, PreCompact and PostCompact", () => {
    const contextAt = (event: Event) =>
      one(event, ranOf({ stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: "ctx" } }) })).context;
    expect(contextAt("PostToolUse")).toEqual([{ event: "PostToolUse", text: "ctx" }]);
    expect(contextAt("SubagentStart")).toEqual([{ event: "SubagentStart", text: "ctx" }]);
    for (const event of ["SessionEnd", "PreCompact", "PostCompact"] as const) expect(contextAt(event), event).toEqual([]);
  });

  it("takes PostToolUse's updatedToolOutput", () => {
    const stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: "short" } });
    expect(one("PostToolUse", ranOf({ stdout })).output).toBe("short");
  });

  it("of two updatedToolOutputs, takes the first in the file", () => {
    const replace = (text: string) => ({
      hook: hookOf({ args: [text] }),
      outcome: answer("PostToolUse", ranOf({ stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: text } }) })),
    });
    expect(combine("PostToolUse", [replace("first"), replace("second")]).output).toBe("first");
  });

  it("keeps every context, message and failure, in the order given", () => {
    const ctx = (text: string) => ({
      hook: hookOf(),
      outcome: answer("UserPromptSubmit", ranOf({
        stdout: JSON.stringify({ systemMessage: `m-${text}`, hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } }),
      })),
    });
    const failure = { hook: hookOf(), outcome: answer("UserPromptSubmit", ranOf({ code: 1, stderr: "boom" })) };
    const c = combine("UserPromptSubmit", [ctx("a"), failure, ctx("b")]);
    expect(c.context).toEqual([{ event: "UserPromptSubmit", text: "a" }, { event: "UserPromptSubmit", text: "b" }]);
    expect(c.messages).toEqual(["m-a", "m-b"]);
    expect(c.failures).toEqual(["node check.js exited with code 1: boom"]);
  });

  it("cuts a failure's line, a block's reason and a message too", () => {
    const long = "y".repeat(10_001);
    const cutText = `${"y".repeat(10_000)}\n[cut: 1 more characters]`;
    expect(one("Stop", ranOf({ code: 2, stderr: long })).block).toBe(cutText);
    expect(one("Stop", ranOf({ stdout: JSON.stringify({ systemMessage: long }) })).messages).toEqual([cutText]);
    expect(one("Stop", ranOf({ code: 1, stderr: "z".repeat(10_000) })).failures[0]).toMatch(/\n\[cut: \d+ more characters\]$/);
  });

  it("gives an empty answer for no hooks", () => {
    expect(combine("Stop", [])).toEqual({ context: [], messages: [], instructions: [], deferred: false, failures: [] });
  });
});
