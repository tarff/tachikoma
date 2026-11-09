import { describe, expect, it } from "vitest";
import type { Message } from "../../src/core/types.js";
import type { Event, Hook } from "../../src/hooks/config.js";
import type { Run } from "../../src/hooks/hooks.js";
import type { Ran } from "../../src/hooks/run.js";
import { lastTurn, describe as lines } from "../../src/tui/describe.js";

describe("describe", () => {
  // Release 8b design, "What a hook's answer does": the user does not see a hook's text for the model in the conversation.
  it("leaves a hook's text for the model out of the scrollback", () => {
    const results: Message = {
      role: "user",
      parts: [
        { type: "tool_result", callId: "c1", output: "ran", isError: false },
        { type: "text", text: "PostToolUse hook:\nmore", from: "hooks" },
      ],
    };
    expect(lines(results)).toEqual([{ text: "  ⎿ ok", color: "gray", oneLine: true }]);
  });
});

describe("lastTurn", () => {
  // Task 9's code review: a Stop hook's feedback keeps the turn going, so it starts no turn of its own; background answers
  // alone still do (tests/tui/statusline.test.tsx).
  it("takes a Stop hook's feedback, with the waiting text after it, as part of the turn it kept going", () => {
    const feedback = { type: "text", text: "Stop hook feedback:\nrun the tests", from: "hooks" } as const;
    const turn = lastTurn([
      { role: "user", parts: [{ type: "text", text: "go" }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "shell", input: { command: "ls" } }] },
      { role: "user", parts: [{ type: "tool_result", callId: "c1", output: "a.txt", isError: false }] },
      { role: "assistant", parts: [{ type: "text", text: "done" }] },
      { role: "user", parts: [feedback, { type: "text", text: "t1 finished", from: "tasks" }] },
      { role: "assistant", parts: [{ type: "text", text: "tests pass" }] },
    ]);
    expect(turn[0]).toEqual({ text: "Last turn: 1 tool call", color: "gray" });
  });

  // Release 8b plan, choice 24 ("Lines this plan adds", Ctrl+O): each hook run after the calls, one line each, what it
  // handed the model under it after ⎿, its command escaped as the question escapes one.
  it("lists the turn's hook runs after its calls: out of time, could not start, a Stop block's reason, and escaped", () => {
    const hook = (event: Event, command: string): Hook => ({ event, matcher: { all: true }, command, async: false, where: JSON.stringify(event) });
    const ran = (more: Partial<Ran>): Ran => ({ code: 0, stdout: "", stderr: "", ms: 12, ...more });
    const failed = { kind: "failed", line: "x" } as const;
    const runs: Run[] = [
      { event: "Stop", hook: hook("Stop", "slow.sh"), ran: ran({ code: null, failed: "time", limit: 600, ms: 600004 }), outcome: failed },
      { event: "Stop", hook: hook("Stop", "gone.sh"), ran: ran({ code: null, failed: "start", startError: "not found on PATH", ms: 1 }), outcome: failed },
      {
        event: "Stop",
        hook: hook("Stop", "again\u0007.sh"),
        ran: ran({ code: 2, stderr: "run the tests\n" }),
        outcome: { kind: "block", reason: "run the tests" },
      },
    ];
    const turn = lastTurn([{ role: "user", parts: [{ type: "text", text: "go" }] }, { role: "assistant", parts: [{ type: "text", text: "done" }] }], runs);
    expect(turn).toEqual([
      { text: "Last turn: 0 tool calls", color: "gray" },
      { text: "◆ Stop hook slow.sh · out of time · 600004 ms", color: "gray" },
      { text: "◆ Stop hook gone.sh · could not start · 1 ms", color: "gray" },
      { text: "◆ Stop hook again\\u0007.sh · exit 2 · 12 ms\n  ⎿ run the tests", color: "gray" },
    ]);
  });

  // The user's words, 2026-11-10: a run a signal ended names it, or says none is known; a tool event's run names its tool
  // as the window does (choice 10).
  it("names a hook run's signal, or says none is known, and a tool hook's tool by Tachikoma's name", () => {
    const hook = (event: Event): Hook => ({ event, matcher: { all: true }, command: "check.sh", async: false, where: JSON.stringify(event) });
    const ran = (more: Partial<Ran>): Ran => ({ code: 0, stdout: "", stderr: "", ms: 12, ...more });
    const ok = { kind: "ok" } as const;
    const runs: Run[] = [
      { event: "Stop", hook: hook("Stop"), ran: ran({ code: null, signal: "SIGTERM" }), outcome: { kind: "failed", line: "x" } },
      { event: "Stop", hook: hook("Stop"), ran: ran({ code: null }), outcome: { kind: "failed", line: "x" } },
      { event: "PreToolUse", hook: hook("PreToolUse"), ran: ran({}), outcome: ok, match: "Bash" },
      { event: "PostToolUse", hook: hook("PostToolUse"), ran: ran({}), outcome: ok, match: "Read" },
      { event: "PostToolUseFailure", hook: hook("PostToolUseFailure"), ran: ran({ code: 1 }), outcome: ok, match: "Agent" },
      { event: "SessionStart", hook: hook("SessionStart"), ran: ran({}), outcome: ok, match: "startup" },
    ];
    const turn = lastTurn([{ role: "user", parts: [{ type: "text", text: "go" }] }], runs);
    expect(turn.slice(1).map((l) => l.text)).toEqual([
      "◆ Stop hook check.sh · ended by signal SIGTERM · 12 ms",
      "◆ Stop hook check.sh · ended by an unknown signal · 12 ms",
      "◆ PreToolUse hook check.sh for shell · exit 0 · 12 ms",
      "◆ PostToolUse hook check.sh for read_file · exit 0 · 12 ms",
      "◆ PostToolUseFailure hook check.sh for delegate · exit 1 · 12 ms",
      "◆ SessionStart hook check.sh · exit 0 · 12 ms",
    ]);
  });
});
