import { callText } from "../core/exportText.js";
import { visible } from "../core/permissions.js";
import { FEEDBACK } from "../core/session.js";
import type { Message } from "../core/types.js";
import { combine, hookName } from "../hooks/answer.js";
import type { Event } from "../hooks/config.js";
import type { Run } from "../hooks/hooks.js";
import { outputFrom, tachikomaName } from "../hooks/tools.js";
import { marker } from "./pictures.js";

export interface Line {
  text: string;
  color?: string;
  oneLine?: boolean; // shown on one line, cut to the screen's width (App.tsx)
}

const firstLine = (s: string) => s.split(/\r?\n/)[0] ?? "";

// A call's main detail (release 3 design, "On screen"): the path for the file tools, the command's
// first line for shell, the pattern for the search tools, the description for delegate; null for a
// tool without its own summary, which is shown with its whole input.
const DETAIL: Record<string, string> = { read_file: "path", write_file: "path", edit_file: "path", shell: "command", find_files: "pattern", search_files: "pattern", delegate: "description" };
export function brief(name: string, input: unknown): string | null {
  const items = name === "todo" && typeof input === "object" && input !== null ? (input as { items?: unknown }).items : undefined;
  if (Array.isArray(items)) return `${items.length} item${items.length === 1 ? "" : "s"}`; // the list itself is on screen
  const value = Object.hasOwn(DETAIL, name) && typeof input === "object" && input !== null ? (input as Record<string, unknown>)[DETAIL[name]!] : undefined;
  return typeof value === "string" ? firstLine(value) : null;
}

// Every scrollback line passes through here. Model and provider text can carry escape codes (OSC 52
// writes the clipboard), \r and bidi overrides, which the terminal would act on. Prose keeps its line
// breaks and tabs. A one-line entry has its line breaks escaped too; the screen cuts it after this, by
// terminal columns, so the escapes and wide characters count toward the width.
export function screen(l: Line): Line {
  const text = l.oneLine ? visible(l.text) : l.text.split(/\r?\n/).map((s) => visible(s, { tabs: true })).join("\n");
  return { text, ...(l.color === undefined ? {} : { color: l.color }), ...(l.oneLine ? { oneLine: true } : {}) };
}

// How one message appears in the scrollback. `answered`: the calls a question was declined for, each with the short row
// that takes its result row's place, or null for none, as its answer line under the tool line says what came of it
// (release 7 plan, choices 66 and 67; App.tsx).
export function describe(m: Message, answered?: ReadonlyMap<string, string | null>): Line[] {
  const lines: Line[] = [];
  let typed: Line | null = null; // the user's prompt so far, its text and pictures one line
  let picture = false; // the last part put in it was a picture
  let served: Line | null = null; // the row of a tool's pictures so far
  for (const p of m.parts) {
    if (p.type === "text" && p.from === "tasks") continue; // shown when it arrived, as "t3 finished"
    if (p.type === "text" && p.from === "hooks") continue; // for the model, not the conversation (release 8b design, "What a hook's answer does")
    // A tool's pictures, which follow the results, are the server's, never the user's prompt (release 8c plan, choice 34):
    // their markers on one grey row, as a result's.
    if (p.type === "image" && p.from === "server") {
      if (served) served.text += ` ${marker(p.id)}`;
      else lines.push((served = { text: `  ⎿ ${marker(p.id)}`, color: "gray", oneLine: true }));
      continue;
    }
    // A picture is its marker in its place, in the line's colour (release 6 plan, choice 22). Two next to each other
    // get a space between, as the blanks between them were left out of the message (pictures.ts, messageParts).
    if (p.type === "text" || p.type === "image") {
      const text = p.type === "image" ? `${picture ? " " : ""}${marker(p.id)}` : p.text;
      picture = p.type === "image";
      if (m.role !== "user") lines.push({ text });
      else if (typed) typed.text += text;
      else lines.push((typed = { text: `> ${text}`, color: "cyan" }));
    } else if (p.type === "tool_call")
      lines.push({ text: `● ${p.name} ${brief(p.name, p.input) ?? JSON.stringify(p.input)}`, color: "yellow", oneLine: true });
    else if (p.type === "tool_result") {
      const short = answered?.get(p.callId);
      if (short === undefined) lines.push({ text: `  ⎿ ${p.isError ? firstLine(p.output) : "ok"}`, color: p.isError ? "red" : "gray", oneLine: true });
      else if (short !== null) lines.push({ text: `  ⎿ ${short}`, color: "gray", oneLine: true });
    } else {
      const _: never = p; // a new kind of part must be given its own line here
    }
  }
  return lines;
}

// A resumed conversation as the scrollback shows a live one, message by message (release 8a plan, Task 6; user,
// 2026-11-06: "Show it").
export const conversationLines = (messages: Message[]): Line[] => messages.flatMap((m) => describe(m));

// Ctrl+O: every tool call of the latest turn, from its prompt on, with its full input and result,
// under a heading. A call of a turn still running may have no result yet. A turn starts with a user
// message that is not tool results: a prompt, or background answers alone; never a Stop hook's feedback, which keeps
// the turn going (release 8b plan, Task 9's code review).
// `runs`: the turn's hook runs (hooks.ts, Hooks.runs), listed after the calls (release 8b plan, choice 24); before the
// first turn, SessionStart's, after the line saying there is none (the user's choice, 2026-11-10; final review).
export function lastTurn(messages: Message[], runs: readonly Run[] = []): Line[] {
  const feedback = (m: Message) => m.parts[0]?.type === "text" && m.parts[0].from === "hooks" && m.parts[0].text.startsWith(`${FEEDBACK}\n`);
  const start = messages.findLastIndex((m) => m.role === "user" && !m.parts.some((p) => p.type === "tool_result") && !feedback(m));
  if (start === -1) return [{ text: "No turn yet, so no tool calls to show.", color: "gray" }, ...runs.map(runLine)];
  const calls = callLines(messages.slice(start));
  return [{ text: `Last turn: ${calls.length} tool call${calls.length === 1 ? "" : "s"}`, color: "gray" }, ...calls, ...runs.map(runLine)];
}

// The events a run of which names its tool on Ctrl+O, as each fires for one call.
const TOOL_EVENTS: readonly Event[] = ["PreToolUse", "PostToolUse", "PostToolUseFailure"];

// One hook run, in the approved words (release 8b plan, "Lines this plan adds", Ctrl+O): its event and the hook's name as
// /hooks gives it (answer.ts, hookName; the user's choice, 2026-11-10, terminal checklist), escaped as the question
// escapes a command, how it ended and its time; under it after ⎿ each text it handed the model (a Stop or
// SubagentStop block's reason among them, which the model reads as feedback), its rewrite as JSON, or that its
// updatedToolOutput was not used. A hook a signal ended names it, or says none is known, and a tool event's run names its
// tool as the window does (the user's words, 2026-11-10; choice 10).
function runLine(r: Run): Line {
  const { ran } = r;
  const signal = ran.signal ? `ended by signal ${ran.signal}` : "ended by an unknown signal";
  const end = ran.failed === "time" ? "out of time" : ran.failed === "start" ? "could not start" : ran.code === null ? signal : `exit ${ran.code}`;
  const c = combine(r.event, [r]);
  const tool = tachikomaName(r.match ?? "");
  const forTool = TOOL_EVENTS.includes(r.event) && r.match !== undefined ? ` for ${visible(tool)}` : "";
  const under = [
    ...(c.block && (r.event === "Stop" || r.event === "SubagentStop") ? [c.block] : []),
    ...c.context.map((x) => x.text),
    // As combine reads them, which drops both beside a continue: false, as a stop ends the turn (Task 12's code review).
    ...(c.rewrite ? [JSON.stringify(c.rewrite.input, null, 2)] : []),
    ...("output" in c && outputFrom(tool, c.output) === null
      ? [`its updatedToolOutput was not used: it does not match ${visible(tool)}'s result`]
      : []),
  ];
  const head = [`◆ ${r.event} hook ${visible(hookName(r.hook))}${forTool}`, end, `${ran.ms} ms`].join(" · ");
  return { text: [head, ...under.map((u) => `  ⎿ ${u}`)].join("\n"), color: "gray" };
}

// Each tool call in `messages`, with its full input and result, grey: for Ctrl+O and `/tasks t3`.
export function callLines(messages: Message[]): Line[] {
  const parts = messages.flatMap((m) => m.parts);
  const results = new Map(parts.flatMap((p) => (p.type === "tool_result" ? [[p.callId, p.output] as const] : [])));
  return parts.flatMap((c) => (c.type === "tool_call" ? [{ text: callText(c, results.get(c.id)), color: "gray" }] : []));
}
