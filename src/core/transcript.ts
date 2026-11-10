import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";
import { privateDir } from "../auth/private.js";
import { errorText, type Image, type Message, marker, type Part, type ToolCall, type ToolResult, type ToolSpec } from "./types.js";

// A session's transcript (release 8a design, "Saving sessions"): one JSON line per event, appended as it happens, as the
// error log writes its rows, so two windows in one project never clash and a crash costs at most the line being written.

// A picture as its line holds it: its file's name in the session's pictures folder, not its data (release 8a plan,
// choice 5).
type SavedImage = Omit<Image, "data"> & { file: string };
export type SavedMessage = Omit<Message, "parts"> & { parts: (Exclude<Part, Image> | SavedImage)[] };

// The line kinds of release 8a plan, choice 4; `ended` is written only in a subagent's own file, `lost` by a resume that
// told the model its answer was lost (user, 2026-11-06: "Report once"). `tools`: the tool specs from that line on;
// `system`: the system prompt and sandbox setting from that line on, written by a resume under another setting; `box`,
// in it and the start line, whether the sandbox was on, absent in a line written before it was recorded (off);
// `interactive`: a -p run opened in the window, a session as any other from then on (release 8a final review, user,
// 2026-11-07).
// `M` is the message as given to `write`, its pictures' data in it; the file holds SavedMessage. A shortening is one
// line, so it is saved whole or not at all.
export type Line<M = SavedMessage> =
  | {
      t: "start";
      at: string;
      v: 1;
      id: string;
      project: string;
      lead: string;
      version: string;
      print: boolean;
      system: string;
      box?: boolean;
      tools: ToolSpec[];
    }
  | { t: "message"; at: string; message: M }
  | { t: "lead"; at: string; lead: string }
  | { t: "tools"; at: string; tools: ToolSpec[] }
  | { t: "system"; at: string; system: string; box: boolean }
  | { t: "interactive"; at: string }
  | { t: "name"; at: string; name: string }
  | { t: "shortened"; at: string; system: string; message: M }
  | { t: "subagent"; at: string; id: string; description: string; file: string }
  | { t: "ended"; at: string; state: "failed" | "stopped" | "lost" }
  // A PreToolUse hook's rewrite of the call `id` of the reply before it, in Tachikoma's fields, written before the call
  // runs (release 8b plan, choice 16).
  | { t: "rewritten"; at: string; id: string; input: unknown }
  // The MCP tools loaded through tool_search so far, all of them, written whenever a search adds to them (release 8c plan,
  // choice 41).
  | { t: "loaded"; at: string; names: string[] };

// Omit on a union keeps only the shared fields, so each variant is omitted on its own, as boxWorkspace.ts:106 does.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// A session's transcript, its pictures folder and its subagents folder: <id>.jsonl, <id>/pictures and <id>/subagents in
// the sessions folder (release 8a design, "Saving sessions"). The subagents folder inherits the sessions folder's
// permission only while this layout holds (tasks.ts).
export function sessionPaths(dir: string, id: string): { file: string; pictures: string; subagents: string } {
  return { file: path.join(dir, `${id}.jsonl`), pictures: path.join(dir, id, "pictures"), subagents: path.join(dir, id, "subagents") };
}

// The same paths, from the session's transcript.
export const pathsOf = (file: string) => sessionPaths(path.dirname(file), path.basename(file, ".jsonl"));

// The file name a picture is saved under, by its format (release 8a plan, choice 5).
const EXT: Record<Image["mediaType"], string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

export class Transcript {
  #failed: string | null = null;

  // `file` is <id>.jsonl, `pictures` <id>/pictures. `inherits`: the file's folder is made inside a folder already made
  // private, whose permission it inherits, as the pictures folder does, so it is made plainly: privateDir would start
  // PowerShell again on Windows, which holds the window still (a subagent's file, tasks.ts).
  constructor(
    readonly file: string,
    readonly pictures: string,
    private readonly opts: { inherits?: boolean } = {},
  ) {}

  // The reason saving stopped, or null while it goes on.
  get failed(): string | null {
    return this.#failed;
  }

  // One append per line. The first failure stops saving for the rest of the session, so no later line can follow a gap
  // (release 8a design, "Saving sessions"). privateDir remembers a folder once made private, as the error log relies on.
  write(line: DistributiveOmit<Line<Message>, "at">): void {
    if (this.#failed !== null) return;
    try {
      if (this.opts.inherits) mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      else privateDir(path.dirname(this.file));
      const { t, ...rest } = "message" in line ? { ...line, message: this.#save(line.message) } : line;
      appendFileSync(this.file, `${JSON.stringify({ t, at: new Date().toISOString(), ...rest })}\n`, { encoding: "utf8", mode: 0o600 });
    } catch (err) {
      this.#failed = errorText(err);
    }
  }

  // Each picture is written to its own file before the line naming it. A picture already saved, by this transcript or
  // by the one it was read back from (a kept prompt's picture in a shortening line), is never written again, as `wx`
  // refuses an existing file (release 8a plan, choice 5). A file half-written at a crash is never named by a line, and
  // its number is never handed out again (readTranscript's nextPicture). The pictures folder is inside the private
  // sessions folder, whose permission it inherits, as files made there do (auth/private.ts).
  #save(m: Message): SavedMessage {
    const parts = m.parts.map((p): SavedMessage["parts"][number] => {
      if (p.type !== "image") return p;
      const file = `${p.id}.${EXT[p.mediaType]}`;
      mkdirSync(this.pictures, { recursive: true, mode: 0o700 });
      try {
        writeFileSync(path.join(this.pictures, file), p.data, { flag: "wx", mode: 0o600 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      return { type: "image", id: p.id, mediaType: p.mediaType, file, ...(p.from && { from: p.from }) };
    });
    return { ...m, parts };
  }

  // A file not ending in a line break gets one before anything is added, so a torn last line stays one skipped line,
  // never joined to the next. Nothing is ever cut (release 8a design, "When something goes wrong").
  mend(): void {
    if (this.#failed !== null) return;
    try {
      const last = Buffer.alloc(1);
      const fd = openSync(this.file, "r");
      try {
        const { size } = fstatSync(fd);
        if (size) readSync(fd, last, 0, 1, size - 1);
        else last[0] = 0x0a; // an empty file has no line to mend
      } finally {
        closeSync(fd);
      }
      if (last[0] !== 0x0a) appendFileSync(this.file, "\n", { encoding: "utf8", mode: 0o600 });
    } catch (err) {
      this.#failed = errorText(err);
    }
  }
}

export interface Read {
  start: Extract<Line, { t: "start" }>;
  messages: Message[];
  system: string;
  lead: string;
  name?: string;
  firstPrompt?: string;
  damaged: number;
  unfinished: { id: string; description: string }[];
  // From the whole file, before and after its shortenings (release 8a plan, choice 6).
  prompts: string[];
  calls: { name: string; input: unknown }[];
  nextPicture: number; // choice 5
  nextTask: number; // choice 4
  tools: ToolSpec[]; // the tools the history was last saved under: the last start or tools line
  print: boolean; // a -p run not opened in the window since, as the session list reads it (readOutline)
  box: boolean; // whether the sandbox was on: the last start or system line's setting
  loaded: string[]; // the MCP tools loaded through tool_search: the last loaded line's, kept by a shortening (release 8c plan, choice 41)
  // The history for a launch with these tools and system prompt: a reply keeps its provider's own content only when the
  // tools and system prompt it was saved under are these, as Anthropic refuses a thinking block once either changed
  // before it (release 8a design, "Before the build", check 2; plan, choice 4). `dropped`: whether any reply's was left
  // out; `otherTools`: whether any of those was saved under other tools and this system prompt.
  withTools(tools: ToolSpec[], system: string): { messages: Message[]; dropped: boolean; otherTools: boolean };
}

// The result given to a call left without one (release 8a design, "Resuming"; approved as worded).
const UNKNOWN =
  "Outcome unknown: the session ended while this was running, or before its result was saved. It may have run in full or in part. " +
  "Check what it would have changed before running it again.";

// How session.ts begins the result of each call of a cut-off reply, so a saved session's reader knows those calls by it
// (release 8a plan, choice 6).
export const CUT_OFF = "Not run: the response was cut off (";

// Whether a reply was cut off, so its calls never ran: the message after it is exactly what session.ts writes for one,
// an error result for each call, in the reply's order, each starting CUT_OFF.
function cutOff(reply: SavedMessage, next: SavedMessage | undefined): boolean {
  const calls = reply.parts.filter((p) => p.type === "tool_call");
  return (
    calls.length > 0 &&
    next?.role === "user" &&
    next.parts.length === calls.length &&
    next.parts.every((p, i) => p.type === "tool_result" && p.isError && p.callId === calls[i]!.id && p.output.startsWith(CUT_OFF))
  );
}

// A part of a user message as the user typed it: its text, or a picture's marker; never a result, waiting text or what a
// server supplied, such as a tool answer's picture (release 8c plan, choice 34).
const own = (p: SavedMessage["parts"][number]) =>
  p.type === "image" && p.from === undefined ? [marker(p.id)] : p.type === "text" && p.from === undefined ? [p.text] : [];

export function readTranscript(file: string, pictures: string): Read | { problem: string } {
  try {
    const rows = parse(readFileSync(file, "utf8"));
    const lines = rows.filter((l) => l !== undefined);
    const damaged = rows.length - lines.length;
    // The start line is written first, once (choice 4); without it there is no system prompt or tool list to go on.
    const start = rows[0];
    if (start?.t !== "start") return { problem: `${file} could not be read as a session (its first line is missing or damaged).` };
    let { system, lead, tools, print } = start;
    let box = start.box === true;
    let name: string | undefined;
    let loaded: string[] = [];
    let history: { m: SavedMessage; tools: ToolSpec[]; system: string }[] = [];
    const prompts: string[] = [];
    const calls: { name: string; input: unknown }[] = [];
    const subagents: Extract<Line, { t: "subagent" }>[] = [];
    const used: number[] = [];
    const said = lines.flatMap((l) => (l.t === "message" ? [l.message] : []));
    // Each rewrite a PreToolUse hook made, by its call's id, under the message it follows, its call's reply, so the record
    // holds the input that ran (release 8b plan, choice 16; design, review finding 4).
    const rewrites: Map<string, unknown>[] = [];
    let at = -1;
    for (const l of lines) {
      if (l.t === "message") at++;
      else if (l.t === "rewritten" && at >= 0) (rewrites[at] ??= new Map()).set(l.id, l.input);
    }
    for (const [i, m] of said.entries()) {
      // As session.ts keeps them for the judge: the user's own words, each picture as its marker, and the calls of each
      // reply that was run. A shortening's message is never one of them, so a summary never stands in for what the user
      // typed. A cut-off reply's calls are never run (session.ts's "Not run" results); a reply a crash left without
      // results cannot be told from one that ran, so its calls count.
      const words = m.parts.flatMap(own).join("");
      if (m.role === "user" && words) prompts.push(words);
      if (!cutOff(m, said[i + 1])) {
        for (const p of m.parts) if (p.type === "tool_call") calls.push({ name: p.name, input: rewrites[i]?.has(p.id) ? rewrites[i].get(p.id) : p.input });
      }
    }
    for (const l of lines) {
      if (l.t === "tools") tools = l.tools;
      if (l.t === "system") ({ system, box } = l);
      if (l.t === "interactive") print = false;
      if (l.t === "message") history.push({ m: l.message, tools, system });
      // The history starts at the last whole shortening, as Claude Code resumes "the last compaction's summary".
      if (l.t === "shortened") {
        system = l.system;
        history = [{ m: l.message, tools, system }];
      }
      if (l.t === "lead") lead = l.lead;
      if (l.t === "name") name = l.name;
      if (l.t === "loaded") loaded = l.names;
      if (l.t === "subagent") subagents.push(l);
      if ("message" in l) for (const p of l.message.parts) if (p.type === "image") used.push(p.id);
    }
    const subagentsDir = pathsOf(file).subagents;
    // The numbers to hand out next follow every one used, in a line or by a file whose line a crash lost (choices 4, 5).
    const nextPicture = Math.max(0, ...used, ...numbered(pictures, /^(\d+)\.(png|jpg|gif|webp)$/)) + 1;
    const nextTask = Math.max(0, ...subagents.map((s) => Number(/^t(\d+)$/.exec(s.id)?.[1] ?? 0)), ...numbered(subagentsDir, /^t(\d+)\.jsonl$/)) + 1;
    // Each reply with the tools and system prompt it was saved under; pair() keeps a reply as the same object.
    const restored = history.map((h) => ({ m: restore(h.m, pictures), tools: JSON.stringify(h.tools), system: h.system }));
    const savedUnder = new Map(restored.map((h) => [h.m, h]));
    const messages = pair(restored.map((h) => h.m));
    const withTools = (now: ToolSpec[], nowSystem: string) => {
      let dropped = false;
      let otherTools = false;
      const kept = messages.map((m) => {
        const under = savedUnder.get(m);
        if (m.native === undefined || (under?.tools === JSON.stringify(now) && under.system === nowSystem)) return m;
        dropped = true;
        // Under an older system prompt, the resume that changed it said so; a sandbox switch changes the shell tool too.
        if (under?.system === nowSystem && under.tools !== JSON.stringify(now)) otherTools = true;
        const { native: _, ...rest } = m;
        return rest;
      });
      return { messages: kept, dropped, otherTools };
    };
    return {
      start,
      messages,
      system,
      lead,
      name,
      firstPrompt: prompts[0],
      damaged,
      // A subagent's file is named after its id (release 8a plan, Task 5: `<id>/subagents/<tN>.jsonl`).
      unfinished: subagents.filter((s) => !finished(path.join(subagentsDir, `${s.id}.jsonl`))).map(({ id, description }) => ({ id, description })),
      prompts,
      calls,
      nextPicture,
      nextTask,
      tools,
      print,
      box,
      loaded,
      withTools,
    };
  } catch (err) {
    return { problem: `${file} could not be read as a session (${errorText(err)}).` };
  }
}

// What the session list shows of a transcript (release 8a plan, choice 9): its start line, last name, last lead and first
// prompt, whether it holds any conversation, and whether it is a -p run not opened in the window since, read from its
// lines alone: no pictures, pairing or subagents' files.
export interface Outline {
  start: Extract<Line, { t: "start" }>;
  print: boolean;
  name?: string;
  lead: string;
  firstPrompt?: string;
  said: boolean;
}

// Null for a file that cannot be read, or whose first line is not a whole start line, as readTranscript refuses it.
export function readOutline(file: string): Outline | null {
  let rows: (Line | undefined)[];
  try {
    rows = parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const start = rows[0];
  if (start?.t !== "start") return null;
  const outline: Outline = { start, print: start.print, lead: start.lead, said: false };
  for (const l of rows) {
    if (l?.t === "interactive") outline.print = false;
    if (l?.t === "name") outline.name = l.name;
    if (l?.t === "lead") outline.lead = l.lead;
    if (l?.t === "message" || l?.t === "shortened") outline.said = true;
    // The first of readTranscript's prompts: a user message's own words, from a message line, never a shortening's.
    if (l?.t === "message" && l.message.role === "user") outline.firstPrompt ??= l.message.parts.flatMap(own).join("") || undefined;
  }
  return outline;
}

// The text up to its last line break: what a copy of a session takes (release 8a design, "When something goes wrong").
export function wholeLines(file: string): string {
  const text = readFileSync(file, "utf8");
  return text.slice(0, text.lastIndexOf("\n") + 1);
}

// Each line in the file's order, undefined for a bad one: a killed process or a full disk can leave a half-written line,
// which is skipped and counted, as the error log skips its own (choice 6).
function parse(text: string): (Line | undefined)[] {
  const rows = text.split("\n");
  if (rows.at(-1) === "") rows.pop();
  return rows.map((row) => {
    try {
      const l = JSON.parse(row);
      return valid(l) ? l : undefined;
    } catch {
      return undefined;
    }
  });
}

const isMessage = (m: unknown): m is SavedMessage => {
  const { role, parts } = (m ?? {}) as { role?: unknown; parts?: unknown };
  return (role === "user" || role === "assistant") && Array.isArray(parts) && parts.every((p) => typeof p?.type === "string");
};

function valid(l: unknown): l is Line {
  const r = (l ?? {}) as Record<string, unknown>;
  const strings = (...keys: string[]) => keys.every((k) => typeof r[k] === "string");
  if (!strings("at")) return false;
  if (r.t === "start") {
    const box = r.box === undefined || typeof r.box === "boolean";
    return r.v === 1 && strings("id", "project", "lead", "version", "system") && typeof r.print === "boolean" && box && Array.isArray(r.tools);
  }
  if (r.t === "message") return isMessage(r.message);
  if (r.t === "lead") return strings("lead");
  if (r.t === "tools") return Array.isArray(r.tools);
  if (r.t === "system") return strings("system") && typeof r.box === "boolean";
  if (r.t === "interactive") return true;
  if (r.t === "name") return strings("name");
  if (r.t === "shortened") return strings("system") && isMessage(r.message);
  if (r.t === "subagent") return strings("id", "description", "file");
  if (r.t === "ended") return r.state === "failed" || r.state === "stopped" || r.state === "lost";
  if (r.t === "rewritten") return strings("id") && typeof r.input === "object" && r.input !== null && !Array.isArray(r.input);
  if (r.t === "loaded") return Array.isArray(r.names) && r.names.every((n) => typeof n === "string");
  return false;
}

// Each picture read back from its file, named from its number and format as #save names it, so a line cannot lead the
// read elsewhere; one that cannot be read becomes a note in its place (choice 5).
function restore(m: SavedMessage, pictures: string): Message {
  const parts = m.parts.map((p): Part => {
    if (p.type !== "image") return p;
    const ext: string | undefined = EXT[p.mediaType];
    try {
      if (ext === undefined) throw new Error("not a format Tachikoma saves");
      const data = readFileSync(path.join(pictures, `${p.id}.${ext}`));
      return { type: "image", id: p.id, mediaType: p.mediaType, data, ...(p.from === "server" && { from: p.from }) };
    } catch {
      return { type: "text", text: `[Image #${p.id}: not found]` };
    }
  });
  return { ...m, parts };
}

// Every call has exactly one result, in the message right after its reply (choice 6): one left without, by a skipped
// line or a crash during the turn, gets UNKNOWN and is never run again; a result whose call is gone is dropped.
function pair(history: Message[]): Message[] {
  const others = (n: Message) => n.parts.filter((p) => p.type !== "tool_result");
  const unknown = (c: ToolCall): ToolResult => ({ type: "tool_result", callId: c.id, output: UNKNOWN, isError: true });
  const out: Message[] = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i]!;
    if (m.role === "user") {
      const parts = others(m);
      if (parts.length) out.push({ ...m, parts });
      continue;
    }
    out.push(m);
    const calls = m.parts.filter((p): p is ToolCall => p.type === "tool_call");
    if (!calls.length) continue;
    const next: Message = history[i + 1]?.role === "user" ? history[++i]! : { role: "user", parts: [] };
    const results = next.parts.filter((p): p is ToolResult => p.type === "tool_result");
    const paired = calls.map((c) => results.find((r) => r.callId === c.id) ?? unknown(c));
    out.push({ ...next, parts: [...paired, ...others(next)] });
  }
  return out;
}

// The numbers in a folder's file names, none when it is not there or is a file.
function numbered(dir: string, name: RegExp): number[] {
  try {
    return readdirSync(dir).map((n) => Number(name.exec(n)?.[1] ?? 0));
  } catch (err) {
    if (["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "")) return [];
    throw err;
  }
}

// Whether a subagent's file shows it finished: an `ended` line, as the lead was told it failed, was stopped or was lost
// (choice 4), or its answer last, a reply with words and no calls, as tasks.ts takes the last reply's text for its
// answer. A file that is gone or cannot be read shows neither.
function finished(file: string): boolean {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  const lines = parse(text);
  if (lines.some((l) => l?.t === "ended")) return true;
  const last = lines.flatMap((l) => (l?.t === "message" || l?.t === "shortened" ? [l.message] : [])).at(-1);
  return last?.role === "assistant" && !last.parts.some((p) => p.type === "tool_call") && last.parts.some((p) => p.type === "text" && p.text.trim() !== "");
}
