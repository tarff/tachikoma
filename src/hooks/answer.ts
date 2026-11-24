import { errorText } from "../core/types.js";
import { gitBash } from "../exec/env.js";
import type { Event, Hook } from "./config.js";
import type { Ran } from "./run.js";

// A hook's answer read by Claude Code's table (release 8b design, "What a hook's answer does"), and several hooks'
// answers combined into what the session acts on. No process runs here: Task 4 (hooks.ts) runs the hooks and calls these.

export type Outcome =
  | { kind: "ok"; json?: Record<string, unknown>; text?: string }
  | { kind: "block"; reason: string; json?: Record<string, unknown> }
  | { kind: "failed"; line: string; cancels?: true }; // the red line's words after "<Event> hook failed: "; `cancels`,
  // a PreModelSwitch time-out, which also cancels the switch in the line's words (release 8e plan, step 3, Q13)

export interface Combined {
  stop?: string; // continue:false, its stopReason ("" when none)
  block?: string; // the first block's reason in the file (exit 2 or decision "block"); at PreToolUse, the deny's
  decision?: "allow" | "ask" | "deny";
  reason?: string; // PreToolUse, deny over ask over allow
  rewrite?: { input: unknown; from: Hook; ignored: Hook[] }; // the first in the file (design, "Tool hooks")
  context: { event: Event; text: string }[]; // for the model, in file order, each cut (release 8b plan, choice 7)
  messages: string[]; // systemMessage, each cut
  instructions: string[]; // PreCompact's plain output, for the summary request (Task 11), each cut
  interrupt?: boolean; // PermissionRequest: the deny that decides said interrupt: true (release 8e plan, step 2)
  updatedPermissions?: boolean; // PermissionRequest: a hook gave updatedPermissions, which is ignored with a line
  retry?: boolean; // PermissionDenied: a hook said retry: true
  output?: unknown; // PostToolUse's updatedToolOutput
  mcpOutput?: unknown; // PostToolUse's updatedMCPToolOutput, for an MCP call alone (release 8c plan, choice 20)
  elicitation?: { action: Elicited; content?: Record<string, unknown> }; // Elicitation's and ElicitationResult's (choice 35)
  deferred: boolean;
  failures: string[];
}
type Elicited = (typeof ACTIONS)[number];

// The events whose hooks can block (design, "What a hook's answer does"). At PostToolUse and PostToolUseFailure the call
// has run, so a block's reason is text for the model instead, the call's outcome unchanged (Claude Code's PostToolUse
// contract; plan review, 2026-11-09, finding 3). At the other four events exit 2 is a failure, whatever was printed, and
// onFailure "block" changes nothing, following the design's table row "Cannot block; a failure's error output is shown
// to the user" (the user's choice at Task 3).
const BLOCKING: readonly Event[] = ["UserPromptSubmit", "PreToolUse", "Stop", "SubagentStop", "PreCompact"];
const AFTER: readonly Event[] = ["PostToolUse", "PostToolUseFailure"];
// A server's forms' events (release 8c plan, choice 35): a hook answers the form with `action` and `content`, and exit 2
// is a decline. There is no model text to add and the form's call goes on, so continue and additionalContext are not read.
const FORMS: readonly Event[] = ["Elicitation", "ElicitationResult"];
// Release 8e design: at these the whole answer is ignored, as in Claude Code; only the runner's own failures are lines.
const IGNORED: readonly Event[] = ["Notification", "StopFailure", "InstructionsLoaded"];
const PERMISSION_EVENTS: readonly Event[] = ["PermissionRequest", "PermissionDenied"];
// Release 8e plan, step 3: where exit 2 and decision "block" block, and onFailure "block" makes a failure a block, as
// at BLOCKING's; PreModelSwitch's block is a deny, as PreToolUse's is. Its own list, apart from the wait below (Q28).
const NEW_BLOCKING: readonly Event[] = ["PreModelSwitch", "PostToolBatch", "ConfigChange"];
// Where continue and stopReason are ignored: no turn to end, or Claude Code discards them (design). At the new events
// only where the design names them, PostToolBatch alone (release 8e plan, Q2; ConfigChange, D9).
const NO_CONTINUE: readonly Event[] = ["SessionStart", "SessionEnd", "SubagentStart", "PreCompact", "PostCompact", ...FORMS, ...PERMISSION_EVENTS,
  "PreModelSwitch", "PostModelSwitch", "ConfigChange"];
// Where decision "block" and reason are read; PreToolUse reads decision's old values too.
const DECISION: readonly Event[] = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SubagentStop", "PreCompact",
  ...NEW_BLOCKING];
const NO_CONTEXT: readonly Event[] = ["SessionEnd", "PreCompact", "PostCompact", ...FORMS, ...PERMISSION_EVENTS, "PreModelSwitch", "ConfigChange"];
// Where systemMessage is not read: ConfigChange discards it (release 8e plan, D9).
const NO_MESSAGE: readonly Event[] = ["ConfigChange"];
// Where plain output on exit 0 is kept: text for the model, or at PreCompact the summary's added instructions.
const PLAIN: readonly Event[] = ["SessionStart", "UserPromptSubmit", "PreCompact", "PostModelSwitch"];
const PERMISSIONS = ["allow", "deny", "ask", "defer"] as const;
// A form's answers, in the order the first wins among several hooks, as deny wins over ask and allow (choice 35).
const ACTIONS = ["decline", "cancel", "accept"] as const;
// Release 8e design: where an async hook's allow, deny, ask, rewrite or retry is a try to decide, as a block is
// everywhere.
const DECIDING: readonly Event[] = [...PERMISSION_EVENTS, ...NEW_BLOCKING];

// The events at which an mcp_tool hook waits for its server while it starts (choice 21): those whose hooks can block,
// the forms', where exit 2 declines, and the new events whose hooks decide (release 8e plan, step 3), its own rule.
const WAITS: readonly Event[] = [...BLOCKING, ...FORMS, "PermissionRequest", ...NEW_BLOCKING];
export const canBlock = (event: Event) => WAITS.includes(event);

// Whether an answer tries to decide what a hook without async would: a block, or at the new deciding events an allow,
// deny, ask, rewrite or retry, which an async hook cannot (release 8e design; hooks.ts says so).
export const decides = (event: Event, c: Combined) =>
  c.block !== undefined || (DECIDING.includes(event) && (c.decision !== undefined || c.rewrite !== undefined || c.retry === true));

// Claude Code's hooks reference, "JSON output": text a hook hands over is capped at 10,000 characters. The marker is a
// long tool output's (truncate, session.ts); Claude Code saves the rest to a file instead (release 8b plan, choice 7).
const MAX_TEXT = 10_000;
const cut = (s: string) => (s.length <= MAX_TEXT ? s : `${s.slice(0, MAX_TEXT)}\n[cut: ${s.length - MAX_TEXT} more characters]`);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const firstLine = (s: string) => s.trim().split(/\r?\n/)[0] ?? "";

// A hook as its lines show it: its command with its args after it, or an mcp_tool hook's server and tool (release 8c
// plan, "Lines this plan adds").
export const commandOf = (hook: Pick<Hook, "command" | "args" | "mcp">) =>
  hook.mcp ? `${hook.mcp.server} ${hook.mcp.tool}` : [hook.command, ...(hook.args ?? [])].join(" ");

// A hook as /hooks and Ctrl+O name it (the user's choice, 2026-11-10, terminal checklist): its statusMessage when it has
// one that is not blank, spaces around it taken off; otherwise its program's file name, a trailing .exe dropped, then the
// file name of the first later word that reads as a file, such as `node block-prompt.js` for
// `node "C:/x y/block-prompt.js"`, or the program's alone. The words are the command and its args, or, for a command a
// shell runs, its text split at spaces outside quotes, pieces that touch with no space between one word
// (`"$CLAUDE_PROJECT_DIR"/.claude/hooks/check.sh`, Claude Code's documented form), the quotes taken off. PowerShell's
// call operator `&` and variables set before the program (`FOO=1`) are not the program, so they are skipped. A word reads
// as a file when it is not an option (`-x`) and its last part, after any / or \, is a name, a dot and an extension.
// With no program left, the name is the whole command, or that in quotes when it is blank too, so no row is blank. An
// mcp_tool hook's is its server and tool, such as `tradingview quote_get` (release 8c design, "Hooks").
export const hookName = (h: Pick<Hook, "command" | "args" | "statusMessage" | "mcp">): string => {
  const status = h.statusMessage?.trim();
  if (status) return status;
  if (h.mcp) return commandOf(h);
  const words = h.args
    ? [h.command, ...h.args]
    : [...h.command.matchAll(/(?:"[^"]*"|'[^']*'|[^\s"']+)+/g)].map((m) => m[0].replace(/"([^"]*)"|'([^']*)'/g, "$1$2"));
  while (words[0] === "&" || /^[A-Za-z_]\w*=/.test(words[0] ?? "")) words.shift();
  const last = (w: string) => w.split(/[\\/]/).at(-1)!;
  const program = last(words[0] ?? "").replace(/\.exe$/i, "").trim();
  if (!program) return commandOf(h).trim() || JSON.stringify(commandOf(h));
  const file = words.slice(1).find((w) => !w.startsWith("-") && /^\w[\w.-]*\.[A-Za-z0-9]+$/.test(last(w)));
  return file ? `${program} ${last(file)}` : program;
};

// One hook's answer. `bash` says Git Bash was found; it is read only when the Windows rule below could apply.
export function outcomeOf(event: Event, hook: Hook, ran: Ran, platform: NodeJS.Platform = process.platform, bash?: boolean): Outcome {
  const command = commandOf(hook);
  // Two cases turn a failure into a block, as exit 2, and there the exit code is not ignored: onFailure "block", and on
  // Windows without Git Bash a PreToolUse hook run by a shell with onFailure not set (Claude Code's rule; design), which
  // an mcp_tool hook is not.
  const shelled = !hook.args && !hook.mcp && platform === "win32" && !(bash ?? gitBash() !== null);
  const strict = (BLOCKING.includes(event) || NEW_BLOCKING.includes(event))
    && (hook.onFailure === "block" || (event === "PreToolUse" && hook.onFailure === undefined && shelled));
  // A block's reason is the failure's own words, so a timeout's block says it ran out of time; only a hook that exited
  // (or was ended by a signal) with error output gives that output's first line (the user's choice at Task 3's review).
  const failure = (words: string, error = ""): Outcome => {
    const line = `${command} ${words}${error ? `: ${error}` : ""}`;
    return strict ? { kind: "block", reason: error || line } : { kind: "failed", line };
  };
  const exited = (words: string) => failure(words, firstLine(ran.stderr));
  if (ran.failed === "start") return failure(`could not start (${ran.startError})`);
  // Release 8e plan, step 3 (Q13): a PreModelSwitch hook out of time is its red line and a cancel, onFailure or not; an
  // async one decides nothing, so its time-out is a failure alone.
  if (ran.failed === "time" && event === "PreModelSwitch" && !hook.async) return { kind: "failed", line: `${command} ran out of time after ${ran.limit} s`, cancels: true };
  if (ran.failed === "time") return failure(`ran out of time after ${ran.limit} s`);
  // An mcp_tool hook's (release 8c plan, choice 21): a server it could not call fails as a hook that could not start does;
  // an isError answer is a failed hook that never blocks, Claude Code's rule, its line ending with the text's first line.
  if (ran.failed === "call") return failure("could not be called", ran.reason);
  if (ran.failed === "error") {
    const first = firstLine(ran.reason ?? "");
    return { kind: "failed", line: `${command} answered an error${first ? `: ${first}` : ""}` };
  }
  // Release 8e plan, step 2: at Notification, StopFailure and InstructionsLoaded nothing else is read; at PermissionRequest
  // exit 2 does nothing and its JSON is not read (Q3); at PermissionDenied exit codes and error output give no line, and
  // only its JSON is read.
  if (IGNORED.includes(event) || (event === "PermissionRequest" && ran.code === 2)) return { kind: "ok" };
  const coded = event !== "PermissionDenied";
  const answer = read(event, ran.stdout);
  const json = "json" in answer ? { json: answer.json } : {};
  // At a form's events exit 2 is a decline, whatever was printed (choice 35), which combine reads from the block.
  if (ran.code === 2 && coded) {
    if (BLOCKING.includes(event) || AFTER.includes(event) || FORMS.includes(event) || NEW_BLOCKING.includes(event)) {
      return { kind: "block", reason: ran.stderr.trim().replace(/\r\n/g, "\n"), ...json };
    }
    return exited("exited with code 2");
  }
  if ("error" in answer) return failure(`printed JSON that could not be read (${answer.error})`);
  if (coded && ran.code !== 0 && (strict || "text" in answer)) {
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
    // The two common cases in plain words, matched by how the parser's message starts. Seen on Node 24.22.1 only; Node 22
    // (package.json allows >=22.20) was not checked, and a message worded otherwise falls back to the parser's own words.
    const words = errorText(err);
    if (words.startsWith("Unexpected end of JSON input") || words.startsWith("Unterminated string")) return { error: "it is cut short" };
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
    NO_MESSAGE.includes(event) ? undefined : field(json, "systemMessage", text, TEXT),
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
    // Claude Code's hooks reference: allow, deny and ask as PreToolUse writes them (release 8e plan, D3).
    ...(event === "PreModelSwitch" ? [
      field(specific, "permissionDecision", (v) => v === "allow" || v === "deny" || v === "ask", '"allow", "deny" or "ask"'),
      field(specific, "permissionDecisionReason", text, TEXT),
    ] : []),
    ...(FORMS.includes(event) ? [
      field(specific, "action", (v) => (ACTIONS as readonly unknown[]).includes(v), '"accept", "decline" or "cancel"'),
      field(specific, "content", isObject, "an object"),
    ] : []),
    // Claude Code's hooks reference: PermissionRequest's decision is an object with behavior and the fields beside it;
    // updatedPermissions is only noted as given, so its shape is not looked at (release 8e plan, step 2, D1 and D2).
    ...(event === "PermissionRequest" ? [field(specific, "decision", isObject, "an object")] : []),
    ...(event === "PermissionRequest" && isObject(specific.decision) ? [
      field(specific.decision, "behavior", (v) => v === "allow" || v === "deny", '"allow" or "deny"'),
      field(specific.decision, "message", text, TEXT),
      field(specific.decision, "interrupt", (v) => typeof v === "boolean", "true or false"),
      field(specific.decision, "updatedInput", isObject, "an object"),
    ] : []),
    ...(event === "PermissionDenied" ? [field(specific, "retry", (v) => typeof v === "boolean", "true or false")] : []),
  ].find(Boolean);
}

// Several hooks' answers, given in the order the settings file lists them. A stop wins over everything; then deny over
// ask over allow (design, "Tool hooks"); the first rewrite and the first updatedToolOutput in the file win; every text
// and failure is kept, each cut. At a form's events, a decline over a cancel over an accept, the accept's content the
// first accept's in the file (release 8c plan, choice 35).
export function combine(event: Event, results: { hook: Hook; outcome: Outcome }[]): Combined {
  const c: Combined = { context: [], messages: [], instructions: [], deferred: false, failures: [] };
  const decided: Partial<Record<"allow" | "ask" | "deny", string>> = {};
  const elicited: Partial<Record<Elicited, { content?: Record<string, unknown> }>> = {};
  const toModel = (text: string) => text && c.context.push({ event, text: cut(text) });
  for (const { hook, outcome } of results) {
    if (outcome.kind === "failed") {
      c.failures.push(cut(outcome.line));
      if (outcome.cancels && decided.deny === undefined) decided.deny = cut(outcome.line);
      continue;
    }
    const json = outcome.json ?? {};
    const specific = isObject(json.hookSpecificOutput) ? json.hookSpecificOutput : {};
    if (FORMS.includes(event)) {
      const action = outcome.kind === "block" ? "decline" : (specific.action as Elicited | undefined);
      if (action && elicited[action] === undefined) elicited[action] = action === "accept" && isObject(specific.content) ? { content: specific.content } : {};
    }
    if (!NO_MESSAGE.includes(event) && typeof json.systemMessage === "string") c.messages.push(cut(json.systemMessage));
    if (!NO_CONTINUE.includes(event) && json.continue === false && c.stop === undefined) c.stop = cut((json.stopReason as string | undefined) ?? "");
    const reason = (json.reason as string | undefined) ?? "";
    if (event === "PreToolUse" || event === "PreModelSwitch") {
      // Claude Code reads permissionDecision only inside hookSpecificOutput; decision's old values approve and block stand
      // for allow and deny. An exit 2 is a deny the fields cannot undo. PreModelSwitch reads permissionDecision as
      // PreToolUse writes it, with no defer and no rewrite, and of the top-level decision only "block" (release 8e plan,
      // step 3, D3; an "approve" there is ignored, the user's choice at the step's review).
      const said = outcome.kind === "block" ? "deny" : (specific.permissionDecision as (typeof PERMISSIONS)[number] | undefined);
      const old = json.decision === "approve" && event === "PreToolUse" ? "allow" : json.decision === "block" ? "deny" : undefined;
      // At PreModelSwitch a top-level block cancels whatever permissionDecision says beside it, as a deny wins over ask
      // and allow (design, "PreModelSwitch cancels on ..."; Codex review 2 of 8e, point 2); PreToolUse is as before.
      const blocks = event === "PreModelSwitch" && old === "deny" && said !== "deny";
      const decision = blocks ? old : said ?? old;
      const why = outcome.kind === "block" ? outcome.reason : said && !blocks ? ((specific.permissionDecisionReason as string | undefined) ?? "") : reason;
      if (decision === "defer") c.deferred = true;
      else if (decision && decided[decision] === undefined) decided[decision] = cut(why);
      if (event === "PreToolUse" && specific.updatedInput != null) {
        if (c.rewrite) c.rewrite.ignored.push(hook);
        else c.rewrite = { input: specific.updatedInput, from: hook, ignored: [] };
      }
    } else if (event === "PermissionRequest") {
      // Release 8e plan, step 2: deny over allow, the first in the file giving the message; any deny's interrupt: true ends
      // the turn, as any hook's continue: false does (the user's choice at the step's review). The first allow's
      // updatedInput is the rewrite, the others named as ignored, as at PreToolUse.
      const d = isObject(specific.decision) ? specific.decision : {};
      const behavior = d.behavior as "allow" | "deny" | undefined;
      if (behavior && decided[behavior] === undefined) decided[behavior] = cut((d.message as string | undefined) ?? "");
      if (behavior === "deny" && d.interrupt === true) c.interrupt = true;
      if (behavior === "allow" && d.updatedInput != null) {
        if (c.rewrite) c.rewrite.ignored.push(hook);
        else c.rewrite = { input: d.updatedInput, from: hook, ignored: [] };
      }
      if (d.updatedPermissions != null) c.updatedPermissions = true;
    } else if (event === "PermissionDenied") {
      if (specific.retry === true) c.retry = true;
    } else {
      const blocked = outcome.kind === "block" ? outcome.reason : DECISION.includes(event) && json.decision === "block" ? reason : undefined;
      if (blocked !== undefined && AFTER.includes(event)) toModel(blocked);
      else if (blocked !== undefined && (BLOCKING.includes(event) || NEW_BLOCKING.includes(event)) && c.block === undefined) c.block = cut(blocked);
    }
    if (!NO_CONTEXT.includes(event) && typeof specific.additionalContext === "string") toModel(specific.additionalContext);
    if (event === "PostToolUse" && specific.updatedToolOutput != null && !("output" in c)) c.output = specific.updatedToolOutput;
    if (event === "PostToolUse" && specific.updatedMCPToolOutput != null && !("mcpOutput" in c)) c.mcpOutput = specific.updatedMCPToolOutput;
    if (outcome.kind === "ok" && outcome.text) {
      if (event === "PreCompact") c.instructions.push(cut(outcome.text));
      else toModel(outcome.text);
    }
  }
  const decision = (["deny", "ask", "allow"] as const).find((d) => decided[d] !== undefined);
  if (decision) {
    c.decision = decision;
    c.reason = decided[decision];
    if (decision === "deny" && (event === "PreToolUse" || event === "PreModelSwitch")) c.block = c.reason;
    // A rewrite beside a deny is dropped: the call is refused (release 8e plan, step 2).
    if (decision === "deny" && event === "PermissionRequest") delete c.rewrite;
  }
  const action = ACTIONS.find((a) => elicited[a] !== undefined);
  if (action) c.elicitation = { action, ...elicited[action] };
  if (c.stop !== undefined) {
    delete c.block;
    delete c.decision;
    delete c.reason;
    delete c.rewrite;
    delete c.output;
    delete c.mcpOutput;
  }
  return c;
}
