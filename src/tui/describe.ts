import path from "node:path";
import { visible } from "../core/permissions.js";
import { FEEDBACK } from "../core/session.js";
import type { Message, ToolCall, ToolResult } from "../core/types.js";
import { combine, hookName } from "../hooks/answer.js";
import type { Event } from "../hooks/config.js";
import type { Run } from "../hooks/hooks.js";
import type { Ran } from "../hooks/run.js";
import { isMcp, outputFrom, tachikomaName } from "../hooks/tools.js";
import { shownPath } from "../tools/search.js";
import type { Fold, OpenRun } from "./fold.js";
import { urls } from "./links.js";
import { led, markdownLines } from "./markdown.js";
import { marker } from "./pictures.js";
import type { Colour, Palette, Role } from "./theme.js";

// A run of style over text[start, end), drawn over the line's own colour; a later span over an earlier one (TUI design
// pass, Task 2).
export interface Span {
  start: number;
  end: number;
  color?: Colour; // a colour, never a role (theme.ts)
  bg?: Colour;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  underline?: boolean;
  strike?: boolean; // struck through: markdown's ~~x~~ (Task 15; the user's choice, 2026-11-16, "Struck through")
  // the address a Ctrl+click opens (links.ts, target); "" where markdown refused one, so screen() finds none inside it
  // (clickable links plan, Task 2)
  link?: string;
}

export interface Line {
  text: string;
  color?: Role; // looked up in the palette where the line is drawn (TUI design pass, Task 13)
  oneLine?: boolean; // shown on one line, cut to the screen's width (App.tsx)
  fold?: Fold; // a folded tool row, or a row of one opened, which a click opens or closes (release 8c plan, Task 15)
  // TUI design pass, Task 2: the spans' styles; the row on the band colour, from `bandFrom` on; later rows (wrapped, or
  // after a line break) starting `indent` columns in, under the rest of the first row, the first `indent` characters
  // its lead (choice P3); the line starts a block (Task 3).
  styles?: Span[];
  band?: true;
  // The band starting this many columns in, the columns before it plain: on the first row the line's lead, on the
  // others its indent, which a line with one equals; a reply's code block, under its text (Task 16's spec review, the
  // user's choice: "Band from the text").
  bandFrom?: number;
  indent?: number;
  block?: true;
  asIs?: true; // its ending line breaks kept, its rows a file's own (withoutTrailingRows; 3c04960's review)
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
// terminal columns, so the escapes and wide characters count toward the width. The text is escaped run by run between
// the spans' ends, so each span still covers its characters once an escape has lengthened one (TUI design pass, Task 2).
// Each web address in the escaped text gets a link span after the line's own, unless a span with a `link` (any value)
// already reaches it, so a markdown link's spans win and a line screened twice gets none again (clickable links plan,
// Task 2). The scan runs with links off too, so no caller needs the look; its spans then draw nothing.
export function screen(l: Line): Line {
  const escape = (s: string) => (l.oneLine ? visible(s) : s.split(/\r?\n/).map((p) => visible(p, { tabs: true })).join("\n"));
  const cuts = [...new Set([0, l.text.length, ...(l.styles ?? []).flatMap((s) => [s.start, s.end])])].sort((a, b) => a - b);
  const at = new Map<number, number>([[0, 0]]); // each cut's place in the escaped text
  let text = "";
  for (let k = 1; k < cuts.length; k++) {
    text += escape(l.text.slice(cuts[k - 1], cuts[k]));
    at.set(cuts[k]!, text.length);
  }
  const styles = l.styles?.map((s) => ({ ...s, start: at.get(s.start)!, end: at.get(s.end)! }));
  const linked = (styles ?? []).filter((s) => s.link !== undefined);
  const found = urls(text).filter((u) => !linked.some((s) => s.start < u.end && u.start < s.end));
  const all = found.length ? [...(styles ?? []), ...found] : styles;
  return {
    text,
    ...(l.color === undefined ? {} : { color: l.color }),
    ...(l.oneLine ? { oneLine: true } : {}),
    ...(l.fold ? { fold: l.fold } : {}),
    ...(all ? { styles: all } : {}),
    ...(l.band ? { band: true } : {}),
    ...(l.bandFrom ? { bandFrom: l.bandFrom } : {}),
    ...(l.indent === undefined ? {} : { indent: l.indent }),
    ...(l.block ? { block: true } : {}),
  };
}

// A question's preview in colour (TUI design pass, Task 7; audit 2): only an edit's is a diff, edit_file's old text's
// lines each marked `-` then the new text's `+` (files.ts), told from a write's, the file's own text, by its summary's
// first word. A `+` line takes the success colour, a `-` line the error colour, each on its tint in full colour; none
// without colour. Each span runs to just past its line's line break, so a CRLF line's \r is inside it and goes with the
// break when screen() escapes it, never at a span's edge, where it would be drawn (Task 2's known limit).
export function previewStyles(summary: string, detail: string, palette: Palette): Span[] {
  if (!summary.startsWith("edit ")) return [];
  const spans: Span[] = [];
  let start = 0;
  for (const l of detail.split("\n")) {
    const end = Math.min(start + l.length + 1, detail.length); // 1: the line break, which the last line has not
    const [color, bg] = l.startsWith("+") ? [palette.success, palette.addTint] : [palette.error, palette.delTint];
    if (color !== undefined || bg !== undefined) spans.push({ start, end, ...(color === undefined ? {} : { color }), ...(bg === undefined ? {} : { bg }) });
    start = end;
  }
  return spans;
}

// An MCP call's server and tool as the server gives them, by its full name (release 8c plan, Task 18; choice 68): the
// window's from the names Servers offered (fold.ts, mcpNames); without them, the safe server and the full name's tool part.
export type McpNames = (full: string) => { server: string; tool: string };
export const safeNames: McpNames = (full) => {
  const at = full.indexOf("__", 5); // the server part of mcp__<server>__<tool> holds no "__" (config.ts)
  // A name with no tool part, which a model can make up (mcp__tradingview), is all server (Task 18's review).
  return at === -1 ? { server: full.slice(5), tool: "" } : { server: full.slice(5, at), tool: full.slice(at + 2) };
};

// A call's name on screen: an MCP call's server and tool, a space between, or the server alone for a name with no tool
// part; any other tool's own name. Hooks, saved sessions, /export and the model keep the full name (choice 68).
export function shownName(name: string, names: McpNames = safeNames): string {
  if (!isMcp(name)) return name;
  const { server, tool } = names(name);
  return tool ? `${server} ${tool}` : server;
}

// A line's `● `, its first two characters, in a colour of the palette (TUI design pass, Task 3): the `● ` that an indented
// line's later rows line up after (choice P3).
const dot = (color: Colour | undefined): Span => ({ start: 0, end: 2, color });

// A notice (Task 3; audit 7): a grey `● ` before its text, which keeps its own colour and spans; a block, its later rows
// lined up after the dot, as a reply's are (Task 3's code review).
export const notice = (l: Line, palette: Palette): Line => ({
  ...l,
  text: `● ${l.text}`,
  styles: [dot(palette.muted), ...(l.styles ?? []).map((s) => ({ ...s, start: s.start + 2, end: s.end + 2 }))],
  indent: 2,
  block: true,
});

// Whether a block after `before` takes a gap: not first (null), and not after an empty line, an empty band line being
// your message's own row, not a gap (Task 3's code review).
export const gapAfter = (before: { text: string; band?: true } | null): boolean => before !== null && (before.text !== "" || before.band === true);

// The lines with one empty line before each block where gapAfter says (Task 3): as say() says them (output.ts), and as an
// opened folded row puts its calls' rows, so they look as they did live (mouse.ts, putFold).
export function gapped(lines: readonly Line[], before: { text: string; band?: true } | null): Line[] {
  const out: Line[] = [];
  let last = before;
  for (const l of lines) {
    if (l.block && gapAfter(last)) out.push({ text: "" });
    out.push(l);
    last = l;
  }
  return out;
}

// The line without the empty rows its text's last line breaks would draw under it ("\n", "\n\n", "\r\n"), so a block
// after it has the one gap gapped() gives, not two (PR 20's review): a reply's, a notice's or an error's text ending so.
// A one-line line shows its breaks escaped, a row of text, so it is kept as it is. trimEnd, so a long run of blanks
// costs no backtracking; the spaces it takes off the last row before them showed nothing. A line marked `asIs`, a write's
// preview, whose empty lines are the file's, is kept too.
export function withoutTrailingRows(l: Line): Line {
  const text = l.text.trimEnd();
  if (l.oneLine || l.asIs || !l.text.slice(text.length).includes("\n")) return l;
  const end = (n: number) => Math.min(n, text.length);
  return { ...l, text, ...(l.styles ? { styles: l.styles.map((s) => ({ ...s, start: end(s.start), end: end(s.end) })) } : {}) };
}

// The lines as one block, its first line marking it, so say() puts an empty line above them: what a key says, and the
// resume lines (the whole PR's review, the user's choice: "Give them a gap").
export const asBlock = (lines: readonly Line[]): Line[] => lines.map((l, i) => (i === 0 ? { ...l, block: true as const } : l));

// A file's path as the conversation names it (Task 8; audit 3): relative to the project's folder `root`, with forward
// slashes, when inside it, and in full otherwise; read against `root` by its kind's rules, as the sandbox's folder,
// /work, is a Linux path on any host. The folder itself is `.`, never left empty (Task 8's code review).
export const fileShown = (root: string, file: string): string => {
  const paths = root.startsWith("/") ? path.posix : path;
  return shownPath(root, paths.resolve(root, file), paths) || ".";
};

// A call's detail as the window shows it, on its row, the tool line and the subagent panel: brief's, and with the
// project's folder `root` an edit's or a write's file as its preview's heading names it (fileShown; the user's choices at
// Task 8's reviews, "Edit/write rows too" and "Both"); any other call's names what the model typed.
export const target = (name: string, input: unknown, root?: string): string | null => {
  const typed = brief(name, input);
  const isFile = root !== undefined && typed !== null && (name === "edit_file" || name === "write_file");
  return isFile ? fileShown(root, typed) : typed;
};

// A call's row and its result's, as the scrollback shows them unfolded (fold.ts opens a folded row into these). The call's
// row is a block, its `● ` the accent colour, as a printed row cannot change when the call ends, and its name and detail
// the text colour (Task 3; choice P2); its result row is no block, and says how it went. With the project's folder
// `root`, an edit's or a write's row names its file as its preview's heading does (target; Task 8).
export const callRow = (p: ToolCall, palette: Palette, names?: McpNames, root?: string): Line => ({
  text: `● ${shownName(p.name, names)} ${target(p.name, p.input, root) ?? JSON.stringify(p.input)}`,
  styles: [dot(palette.accent)],
  oneLine: true,
  block: true,
});
export const resultRow = (p: ToolResult): Line => ({
  text: `  ⎿ ${p.isError ? firstLine(p.output) : "ok"}`,
  color: p.isError ? "error" : "muted",
  oneLine: true,
});

// A reply's text drawn as markdown (TUI design pass, Task 16; design, "5. Markdown"), laid out for its budget: `width`,
// the columns a kept line's text has now (view.ts, textWidth), less its lead's 2, so a table that fits is never cut
// before a resize. The first line takes `● ` in the accent colour and is the block; each later line starts two spaces
// in, under the first's text, a list's or a quote's own lead after them and its indent added to theirs. An empty later
// line takes no spaces, so a copy has no trailing ones; a text that draws no line is `● ` alone, as before. A code
// block's band starts after the lead, under the text (Task 16's spec review: "Band from the text").
const LEAD = 2;
function replyLines(text: string, width: number, palette: Palette): Line[] {
  const drawn = markdownLines(text, width - LEAD, palette);
  return (drawn.length ? drawn : [{ text: "" }]).map((l, k) => {
    // As a list's lead goes before its item's lines (markdown.ts, led; Task 16's code review).
    const line = led(l, k === 0 ? "● " : "  ", k === 0 ? palette.accent : undefined);
    if (k > 0) return line;
    // led() takes an empty line's lead without its trailing space; an empty first line keeps `● `, as before.
    return { ...line, ...(l.text === "" ? { text: "● ", styles: [dot(palette.accent)], indent: LEAD } : {}), block: true as const };
  });
}

// How one message appears in the scrollback. `answered`: the calls a question was declined for, each with the short row
// that takes its result row's place, or null for none, as its answer line under the tool line says what came of it
// (release 7 plan, choices 66 and 67; App.tsx). `run`: the open run of quiet calls (fold.ts), which takes them, and which
// what is shown next ends, its row said first (release 8c plan, Task 15). `palette`: the colours of the marks (TUI design
// pass, Task 3). `width`: the columns a kept line's text has now, textWidth's, which a reply's markdown is laid out for
// (Task 16).
export function describe(m: Message, palette: Palette, width: number, answered?: ReadonlyMap<string, string | null>, run?: OpenRun): Line[] {
  const lines: Line[] = [];
  let typed: Line | null = null; // the user's prompt so far, its text and pictures one line
  let picture = false; // the last part put in it was a picture
  let served: Line | null = null; // the row of a tool's pictures so far
  for (const p of m.parts) {
    if (p.type === "text" && p.from === "tasks") continue; // shown when it arrived, as "t3 finished"
    if (p.type === "text" && p.from === "hooks") continue; // for the model, not the conversation (release 8b design, "What a hook's answer does")
    // A note of a changed date or setup: for the model, as a hook's text (system prompt plan, Task 4).
    if (p.type === "text" && p.from === "note") continue;
    // The note from long-term memory in front of a first message: for the model too (8d plan, step 24; Q10).
    if (p.type === "text" && p.from === "memory") continue;
    // A picked resource's text and a prompt command's messages, which follow the typed line: the server's, never the
    // user's prompt (release 8c plan, choice 34), and for the model, as a hook's text is.
    if (p.type === "text" && p.from === "server") continue;
    // Shown, text and pictures end the open run: its row comes first, so nothing it counts is said under them (Task 15).
    if (p.type === "text" || p.type === "image") lines.push(...(run?.end() ?? []));
    // A tool's pictures, which follow the results, are the server's, never the user's prompt (release 8c plan, choice 34):
    // their markers on one grey row, as a result's.
    if (p.type === "image" && p.from === "server") {
      if (served) served.text += ` ${marker(p.id)}`;
      else lines.push((served = { text: `  ⎿ ${marker(p.id)}`, color: "muted", oneLine: true }));
      continue;
    }
    // A picture is its marker in its place, in the line's colour (release 6 plan, choice 22). Two next to each other
    // get a space between, as the blanks between them were left out of the message (pictures.ts, messageParts).
    // A reply's text is a block, `● ` in the accent colour before it, its later rows under its first word, drawn as
    // markdown (Task 16), a picture its marker; the user's prompt is a block of three band lines, `› ` and the prompt
    // in the middle one, its later rows under the prompt's first word (TUI design pass, Task 3; choice P3), never read
    // as markdown.
    if (p.type === "text" || p.type === "image") {
      const text = p.type === "image" ? `${picture ? " " : ""}${marker(p.id)}` : p.text;
      picture = p.type === "image";
      if (m.role !== "user" && p.type === "text") lines.push(...replyLines(text, width, palette));
      else if (m.role !== "user") lines.push({ text: `● ${text}`, styles: [dot(palette.accent)], indent: 2, block: true });
      else if (typed) typed.text += text;
      else lines.push({ text: "", band: true, block: true }, (typed = { text: `› ${text}`, band: true, indent: 2 }), { text: "", band: true });
    } else if (p.type === "tool_call") lines.push(...(run ? run.call(p) : [callRow(p, palette)]));
    else if (p.type === "tool_result") {
      const folded = run?.result(p) ?? null;
      const short = answered?.get(p.callId);
      if (folded) lines.push(...folded);
      else if (short === undefined) lines.push(resultRow(p));
      else if (short !== null) lines.push({ text: `  ⎿ ${short}`, color: "muted", oneLine: true });
    } else {
      const _: never = p; // a new kind of part must be given its own line here
    }
  }
  return lines;
}

// Ctrl+O: every tool call of the latest turn, from its prompt on, with its full input and result,
// under a heading. A call of a turn still running may have no result yet. A turn starts with a user
// message that is not tool results: a prompt, or background answers alone; never a Stop hook's feedback, which keeps
// the turn going (release 8b plan, Task 9's code review).
// `runs`: the turn's hook runs (hooks.ts, Hooks.runs), listed after the calls (release 8b plan, choice 24); before the
// first turn, SessionStart's, after the line saying there is none (the user's choice, 2026-11-10; final review).
// `names`: an MCP call's server and tool, as its row names them (choice 68).
export function lastTurn(messages: Message[], runs: readonly Run[] = [], names?: McpNames): Line[] {
  const feedback = (m: Message) => m.parts[0]?.type === "text" && m.parts[0].from === "hooks" && m.parts[0].text.startsWith(`${FEEDBACK}\n`);
  const start = messages.findLastIndex((m) => m.role === "user" && !m.parts.some((p) => p.type === "tool_result") && !feedback(m));
  if (start === -1) return [{ text: "No turn yet, so no tool calls to show.", color: "muted" }, ...runs.map(runLine)];
  const calls = callLines(messages.slice(start), names);
  return [{ text: `Last turn: ${calls.length} tool call${calls.length === 1 ? "" : "s"}`, color: "muted" }, ...calls, ...runs.map(runLine)];
}

// The events a run of which names its tool on Ctrl+O, as each fires for one call.
const TOOL_EVENTS: readonly Event[] = ["PreToolUse", "PostToolUse", "PostToolUseFailure"];

// One hook run, in the approved words (release 8b plan, "Lines this plan adds", Ctrl+O): its event and the hook's name as
// /hooks gives it (answer.ts, hookName; the user's choice, 2026-11-10, terminal checklist), escaped as the question
// escapes a command, how it ended and its time; under it after ⎿ each text it handed the model (a Stop or
// SubagentStop block's reason among them, which the model reads as feedback), its rewrite as JSON, or that its
// updatedToolOutput was not used. A hook a signal ended names it, or says none is known, and a tool event's run names its
// tool as the window does (the user's words, 2026-11-10; choice 10). An mcp_tool hook's call that failed ends in its red
// line's words (release 8c plan, Task 8), and one that answered shows exit 0, as its answer is read (choice 21).
const ENDS: Record<NonNullable<Ran["failed"]>, string> = {
  time: "out of time", start: "could not start", call: "could not be called", error: "answered an error",
};
function runLine(r: Run): Line {
  const { ran } = r;
  const signal = ran.signal ? `ended by signal ${ran.signal}` : "ended by an unknown signal";
  const end = ran.failed ? ENDS[ran.failed] : ran.code === null ? signal : `exit ${ran.code}`;
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
  return { text: [head, ...under.map((u) => `  ⎿ ${u}`)].join("\n"), color: "muted" };
}

// One input of a call as Ctrl+O shows it (TUI design pass, Task 12; audit 10; the user's layout, 2026-11-15): `name:
// value`, two in; an empty string `""` (the user's choice, 2026-11-15, "Show \"\""); a string with line breaks
// under its `name:` four in, an empty line with no indent so a copy has no trailing spaces (Task 12's spec review), a
// CRLF one's \r going with its break as in prose; any other value its JSON on one line. Each is escaped, as
// JSON.stringify did before. A key of anything but letters, digits, _, $, . and -, with combining marks after the first
// (Task 12's code review), is quoted as JSON, so an empty one, or one with a colon, a line break or leading spaces,
// cannot pass for another key or a value's line.
const BARE_KEY = /^[\p{L}\p{N}_$.-][\p{L}\p{M}\p{N}_$.-]*$/u;
function inputLines([key, value]: [string, unknown]): string[] {
  const name = visible(BARE_KEY.test(key) ? key : JSON.stringify(key));
  if (typeof value !== "string" || value === "") return [`  ${name}: ${visible(String(JSON.stringify(value)))}`];
  if (!value.includes("\n")) return [`  ${name}: ${visible(value, { tabs: true })}`];
  return [`  ${name}:`, ...value.split(/\r?\n/).map((l) => (l ? `    ${visible(l, { tabs: true })}` : ""))];
}

// A shell result (shellText, tools/shell.ts) without its empty stderr or stdout section (Task 12): the status alone when
// both are. The stderr marker follows the one-line status; the stdout marker is the real one only when it comes once,
// as either stream's text can hold it, so a result with it twice, or of another shape, is shown as it is. A known limit
// (Task 12's code review; the user's choice, 2026-11-15, "Hide it, rare case a limit"): the session's cut (session.ts,
// truncate) can take the real stdout marker away from a stderr that starts with one, which then reads as empty, so its
// heading goes and its text shows as stdout; no text is lost.
const STDOUT = "\n--- stdout ---\n";
function shellShown(result: string): string {
  const m = /^((?:exit code: |killed by ).*)\n--- stderr ---\n([^]*)$/.exec(result);
  const at = m ? m[2]!.indexOf(STDOUT) : -1;
  if (!m || at === -1 || m[2]!.indexOf(STDOUT, at + 1) !== -1) return result;
  const [err, out] = [m[2]!.slice(0, at), m[2]!.slice(at + STDOUT.length)];
  return [m[1]!, ...(err ? ["--- stderr ---", err] : []), ...(out ? ["--- stdout ---", out] : [])].join("\n");
}

// Each tool call in `messages`, with its full input and result, grey: for Ctrl+O and `/tasks t3`, an MCP call named by
// its server and tool as its row is (release 8c plan, Task 18; choice 68). Its input as name: value lines, none for an
// empty input, and a shell call's result without its empty sections (Task 12); /export keeps the JSON (callText).
export function callLines(messages: Message[], names?: McpNames): Line[] {
  const parts = messages.flatMap((m) => m.parts);
  const results = new Map(parts.flatMap((p) => (p.type === "tool_result" ? [[p.callId, p.output] as const] : [])));
  return parts.flatMap((c) => {
    if (c.type !== "tool_call") return [];
    const name = shownName(c.name, names);
    // Every provider gives an object (openai.ts, parseArgs); anything else is its JSON on one line after the name.
    const { input } = c;
    const fields = typeof input === "object" && input !== null && !Array.isArray(input);
    const head = fields ? [`● ${name}`, ...Object.entries(input).flatMap(inputLines)] : [`● ${name} ${visible(String(JSON.stringify(input)))}`];
    const result = results.get(c.id);
    const shown = result === undefined ? "(not finished)" : c.name === "shell" ? shellShown(result) : result;
    return [{ text: [...head, `  ⎿ ${shown}`].join("\n"), color: "muted" }];
  });
}
