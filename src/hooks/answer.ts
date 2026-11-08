import { errorText } from "../core/types.js";
import { gitBash } from "../exec/env.js";
import type { Event, Hook } from "./config.js";
import type { Ran } from "./run.js";

// A hook's answer read by Claude Code's table (release 8b design, "What a hook's answer does"), and several hooks'
// answers combined into what the session acts on. No process runs here: Task 4 (hooks.ts) runs the hooks and calls these.

export type Outcome =
  | { kind: "ok"; json?: Record<string, unknown>; text?: string }
  | { kind: "block"; reason: string; json?: Record<string, unknown> }
  | { kind: "failed"; line: string }; // the red line's words after "<Event> hook failed: "

export interface Combined {
  stop?: string; // continue:false, its stopReason ("" when none)
  block?: string; // the strongest block's reason (exit 2, decision "block", or a deny)
  decision?: "allow" | "ask" | "deny";
  reason?: string; // PreToolUse, deny over ask over allow
  rewrite?: { input: unknown; from: Hook; ignored: Hook[] }; // the first in the file (design, "Tool hooks")
  context: { event: Event; text: string }[]; // for the model, in file order, each cut (release 8b plan, choice 7)
  messages: string[]; // systemMessage, each cut
  instructions: string[]; // PreCompact's plain output, for the summary request (Task 11), each cut
  output?: unknown; // PostToolUse's updatedToolOutput
  deferred: boolean;
  failures: string[];
}

// The events whose hooks can block (design, "What a hook's answer does"). At PostToolUse and PostToolUseFailure the call
// has run, so a block's reason is text for the model instead, the call's outcome unchanged (Claude Code's PostToolUse
// contract; plan review, 2026-11-09, finding 3). At the other four events exit 2 is a failure, whatever was printed, and
// onFailure "block" changes nothing, following the design's table row "Cannot block; a failure's error output is shown
// to the user" (the user's choice at Task 3).
const BLOCKING: readonly Event[] = ["UserPromptSubmit", "PreToolUse", "Stop", "SubagentStop", "PreCompact"];
const AFTER: readonly Event[] = ["PostToolUse", "PostToolUseFailure"];
// Where continue and stopReason are ignored: no turn to end, or Claude Code discards them (design).
const NO_CONTINUE: readonly Event[] = ["SessionStart", "SessionEnd", "SubagentStart", "PreCompact", "PostCompact"];
// Where decision "block" and reason are read; PreToolUse reads decision's old values too.
const DECISION: readonly Event[] = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SubagentStop", "PreCompact"];
const NO_CONTEXT: readonly Event[] = ["SessionEnd", "PreCompact", "PostCompact"];
// Where plain output on exit 0 is kept: text for the model, or at PreCompact the summary's added instructions.
const PLAIN: readonly Event[] = ["SessionStart", "UserPromptSubmit", "PreCompact"];
const PERMISSIONS = ["allow", "deny", "ask", "defer"] as const;

// Claude Code's hooks reference, "JSON output": text a hook hands over is capped at 10,000 characters. The marker is a
// long tool output's (truncate, session.ts); Claude Code saves the rest to a file instead (release 8b plan, choice 7).
const MAX_TEXT = 10_000;
const cut = (s: string) => (s.length <= MAX_TEXT ? s : `${s.slice(0, MAX_TEXT)}\n[cut: ${s.length - MAX_TEXT} more characters]`);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const firstLine = (s: string) => s.trim().split(/\r?\n/)[0] ?? "";

// One hook's answer. `bash` says Git Bash was found; it is read only when the Windows rule below could apply.
export function outcomeOf(event: Event, hook: Hook, ran: Ran, platform: NodeJS.Platform = process.platform, bash?: boolean): Outcome {
  const command = [hook.command, ...(hook.args ?? [])].join(" ");
  // Two cases turn a failure into a block, as exit 2, and there the exit code is not ignored: onFailure "block", and on
  // Windows without Git Bash a PreToolUse hook run by a shell with onFailure not set (Claude Code's rule; design).
  const strict = BLOCKING.includes(event) && (hook.onFailure === "block"
    || (event === "PreToolUse" && hook.onFailure === undefined && !hook.args && platform === "win32" && !(bash ?? gitBash() !== null)));
  // A block's reason is the failure's own words, so a timeout's block says it ran out of time; only a hook that exited
  // (or was ended by a signal) with error output gives that output's first line (the user's choice at Task 3's review).
  const failure = (words: string, error = ""): Outcome => {
    const line = `${command} ${words}${error ? `: ${error}` : ""}`;
    return strict ? { kind: "block", reason: error || line } : { kind: "failed", line };
  };
  const exited = (words: string) => failure(words, firstLine(ran.stderr));
  if (ran.failed === "start") return failure(`could not start (${ran.startError})`);
  if (ran.failed === "time") return failure(`ran out of time after ${ran.limit} s`);
  const answer = read(event, ran.stdout);
  const json = "json" in answer ? { json: answer.json } : {};
  if (ran.code === 2) {
    if (BLOCKING.includes(event) || AFTER.includes(event)) return { kind: "block", reason: ran.stderr.trim(), ...json };
    return exited("exited with code 2");
  }
  if ("error" in answer) return failure(`printed JSON that could not be read (${answer.error})`);
  if (ran.code !== 0 && (strict || "text" in answer)) {
    if (ran.code !== null) return exited(`exited with code ${ran.code}`);
    return exited(ran.signal ? `was ended by signal ${ran.signal}` : "was ended by an unknown signal");
  }
  if ("text" in answer) return answer.text && PLAIN.includes(event) ? { kind: "ok", text: answer.text } : { kind: "ok" };
  return { kind: "ok", ...json };
}

// JSON is one object with only white space around it that passes the event's checks; output starting with { that is not
// is JSON that could not be read (design; plan review, 2026-11-09, finding 4). Anything else is plain text.
function read(event: Event, stdout: string): { json: Record<string, unknown> } | { error: string } | { text: string } {
  const text = stdout.trim();
  if (!text.startsWith("{")) return { text };
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    // The two common cases in plain words, the same on every Node; the parser's own words for the rest.
    const words = errorText(err);
    if (words.startsWith("Unexpected end of JSON input")) return { error: "it is cut short" };
    if (words.startsWith("Unexpected non-whitespace character after JSON")) return { error: "there is text after the object" };
    return { error: words };
  }
  const wrong = check(event, json);
  return wrong ? { error: wrong } : { json };
}

// What is wrong with the fields this event reads, in plain words, or undefined. A field the event does not read is not
// looked at. A field printed as null is taken as left out, here and in combine (the user's choice, 2026-11-09).
function check(event: Event, json: Record<string, unknown>): string | undefined {
  const TEXT = "text in quotes";
  const field = (o: Record<string, unknown>, name: string, ok: (v: unknown) => boolean, what: string) =>
    o[name] != null && !ok(o[name]) ? `${JSON.stringify(name)} must be ${what}` : undefined;
  const text = (v: unknown) => typeof v === "string";
  const wrong = [
    field(json, "systemMessage", text, TEXT),
    ...(NO_CONTINUE.includes(event) ? [] : [field(json, "continue", (v) => typeof v === "boolean", "true or false"), field(json, "stopReason", text, TEXT)]),
    ...(DECISION.includes(event)
      ? [field(json, "decision", (v) => v === "approve" || v === "block", '"approve" or "block"'), field(json, "reason", text, TEXT)]
      : []),
    field(json, "hookSpecificOutput", isObject, "an object"),
  ].find(Boolean);
  if (wrong || !isObject(json.hookSpecificOutput)) return wrong;
  const specific = json.hookSpecificOutput;
  if (specific.hookEventName == null) return '"hookSpecificOutput" has no "hookEventName"';
  if (typeof specific.hookEventName !== "string") return '"hookEventName" must be text in quotes';
  if (specific.hookEventName !== event) return `"hookSpecificOutput" names ${specific.hookEventName}`;
  return [
    NO_CONTEXT.includes(event) ? undefined : field(specific, "additionalContext", text, TEXT),
    ...(event === "PreToolUse" ? [
      field(specific, "permissionDecision", (v) => (PERMISSIONS as readonly unknown[]).includes(v), '"allow", "deny", "ask" or "defer"'),
      field(specific, "permissionDecisionReason", text, TEXT),
      field(specific, "updatedInput", isObject, "an object"),
    ] : []),
  ].find(Boolean);
}

// Several hooks' answers, given in the order the settings file lists them. A stop wins over everything; then deny over
// ask over allow (design, "Tool hooks"); the first rewrite and the first updatedToolOutput in the file win; every text
// and failure is kept, each cut.
export function combine(event: Event, results: { hook: Hook; outcome: Outcome }[]): Combined {
  const c: Combined = { context: [], messages: [], instructions: [], deferred: false, failures: [] };
  const decided: Partial<Record<"allow" | "ask" | "deny", string>> = {};
  const toModel = (text: string) => text && c.context.push({ event, text: cut(text) });
  for (const { hook, outcome } of results) {
    if (outcome.kind === "failed") {
      c.failures.push(cut(outcome.line));
      continue;
    }
    const json = outcome.json ?? {};
    const specific = isObject(json.hookSpecificOutput) ? json.hookSpecificOutput : {};
    if (typeof json.systemMessage === "string") c.messages.push(cut(json.systemMessage));
    if (!NO_CONTINUE.includes(event) && json.continue === false && c.stop === undefined) c.stop = cut((json.stopReason as string | undefined) ?? "");
    const reason = (json.reason as string | undefined) ?? "";
    if (event === "PreToolUse") {
      // Claude Code reads permissionDecision only inside hookSpecificOutput; decision's old values approve and block stand
      // for allow and deny. An exit 2 is a deny the fields cannot undo.
      const said = outcome.kind === "block" ? "deny" : (specific.permissionDecision as (typeof PERMISSIONS)[number] | undefined);
      const old = json.decision === "approve" ? "allow" : json.decision === "block" ? "deny" : undefined;
      const decision = said ?? old;
      const why = outcome.kind === "block" ? outcome.reason : said ? ((specific.permissionDecisionReason as string | undefined) ?? "") : reason;
      if (decision === "defer") c.deferred = true;
      else if (decision && decided[decision] === undefined) decided[decision] = cut(why);
      if (specific.updatedInput != null) {
        if (c.rewrite) c.rewrite.ignored.push(hook);
        else c.rewrite = { input: specific.updatedInput, from: hook, ignored: [] };
      }
    } else {
      const blocked = outcome.kind === "block" ? outcome.reason : DECISION.includes(event) && json.decision === "block" ? reason : undefined;
      if (blocked !== undefined && AFTER.includes(event)) toModel(blocked);
      else if (blocked !== undefined && BLOCKING.includes(event) && c.block === undefined) c.block = cut(blocked);
    }
    if (!NO_CONTEXT.includes(event) && typeof specific.additionalContext === "string") toModel(specific.additionalContext);
    if (event === "PostToolUse" && specific.updatedToolOutput != null &&!("output" in c)) c.output = specific.updatedToolOutput;
    if (outcome.kind === "ok" && outcome.text) {
      if (event === "PreCompact") c.instructions.push(cut(outcome.text));
      else toModel(outcome.text);
    }
  }
  const decision = (["deny", "ask", "allow"] as const).find((d) => decided[d] !== undefined);
  if (decision) {
    c.decision = decision;
    c.reason = decided[decision];
    if (decision === "deny") c.block = c.reason;
  }
  if (c.stop !== undefined) {
    delete c.block;
    delete c.decision;
    delete c.reason;
    delete c.rewrite;
    delete c.output;
  }
  return c;
}
