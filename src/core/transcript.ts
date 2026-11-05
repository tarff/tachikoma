import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { privateDir } from "../auth/private.js";
import { errorText, type Image, type Message, marker, type Part, type ToolCall, type ToolResult, type ToolSpec } from "./types.js";

// A session's transcript (release 8a design, "Saving sessions"): one JSON line per event, appended as it happens, as the
// error log writes its rows, so two windows in one project never clash and a crash costs at most the line being written.

// A picture as its line holds it: its file's name in the session's pictures folder, not its data (release 8a plan,
// choice 5).
type SavedImage = Omit<Image, "data"> & { file: string };
export type SavedMessage = Omit<Message, "parts"> & { parts: (Exclude<Part, Image> | SavedImage)[] };

// The line kinds of release 8a plan, choice 4; `ended` is written only in a subagent's own file. `M` is the message as
// given to `write`, its pictures' data in it; the file holds SavedMessage. A shortening is one line, so it is saved whole
// or not at all.
export type Line<M = SavedMessage> =
  | { t: "start"; at: string; v: 1; id: string; project: string; lead: string; version: string; print: boolean; system: string; tools: ToolSpec[] }
  | { t: "message"; at: string; message: M }
  | { t: "lead"; at: string; lead: string }
  | { t: "name"; at: string; name: string }
  | { t: "shortened"; at: string; system: string; message: M }
  | { t: "subagent"; at: string; id: string; description: string; file: string }
  | { t: "ended"; at: string; state: "failed" | "stopped" };

// Omit on a union keeps only the shared fields, so each variant is omitted on its own, as boxWorkspace.ts:106 does.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// The file name a picture is saved under, by its format (release 8a plan, choice 5).
const EXT: Record<Image["mediaType"], string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

export class Transcript {
  #failed: string | null = null;

  // `file` is <id>.jsonl, `pictures` <id>/pictures.
  constructor(
    readonly file: string,
    readonly pictures: string,
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
      privateDir(path.dirname(this.file));
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
      return { type: "image", id: p.id, mediaType: p.mediaType, file };
    });
    return { ...m, parts };
  }

  // A file not ending in a line break gets one before anything is added, so a torn last line stays one skipped line,
  // never joined to the next. Nothing is ever cut (release 8a design, "When something goes wrong").
  mend(): void {
    if (this.#failed !== null) return;
    try {
      const text = readFileSync(this.file);
      if (text.length && text.at(-1) !== 0x0a) appendFileSync(this.file, "\n", { encoding: "utf8", mode: 0o600 });
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
}

// The result given to a call left without one (release 8a design, "Resuming"; approved as worded).
const UNKNOWN =
  "Outcome unknown: the session ended while this was running, or before its result was saved. It may have run in full or in part. " +
  "Check what it would have changed before running it again.";

// How session.ts's result for each call of a cut-off reply begins.
const CUT = "Not run: the response was cut off (";

// A part of a user message as the user typed it: its text, or a picture's marker; never a result or waiting text.
const own = (p: SavedMessage["parts"][number]) => (p.type === "image" ? [marker(p.id)] : p.type === "text" && p.from === undefined ? [p.text] : []);

export function readTranscript(file: string, pictures: string): Read | { problem: string } {
  try {
    const rows = parse(readFileSync(file, "utf8"));
    const lines = rows.filter((l) => l !== undefined);
    const damaged = rows.length - lines.length;
    // The start line is written first, once (choice 4); without it there is no system prompt or tool list to go on.
    const start = rows[0];
    if (start?.t !== "start") return { problem: `${file} could not be read as a session (its first line is missing or damaged).` };
    let { system, lead } = start;
    let name: string | undefined;
    let history: SavedMessage[] = [];
    const prompts: string[] = [];
    const calls: { name: string; input: unknown }[] = [];
    const subagents: Extract<Line, { t: "subagent" }>[] = [];
    const used = [0];
    const said = lines.flatMap((l) => (l.t === "message" ? [l.message] : []));
    for (const [i, m] of said.entries()) {
      // As session.ts keeps them for the judge: the user's own words, each picture as its marker, and the calls of each
      // reply that was run. A shortening's message is never one of them, so a summary never stands in for what the user
      // typed. A cut-off reply's calls are never run (session.ts's "Not run" results); a reply a crash left without
      // results cannot be told from one that ran, so its calls count.
      const words = m.parts.flatMap(own).join("");
      if (m.role === "user" && words) prompts.push(words);
      const cut = said[i + 1]?.parts.some((p) => p.type === "tool_result" && p.output.startsWith(CUT));
      if (!cut) for (const p of m.parts) if (p.type === "tool_call") calls.push({ name: p.name, input: p.input });
    }
    for (const l of lines) {
      if (l.t === "message") history.push(l.message);
      // The history starts at the last whole shortening, as Claude Code resumes "the last compaction's summary".
      if (l.t === "shortened") {
        system = l.system;
        history = [l.message];
      }
      if (l.t === "lead") lead = l.lead;
      if (l.t === "name") name = l.name;
      if (l.t === "subagent") subagents.push(l);
      if ("message" in l) for (const p of l.message.parts) if (p.type === "image") used.push(p.id);
    }
    // The session's folder, which holds the pictures and subagents folders (release 8a design, "Saving sessions").
    const subagentsDir = path.join(path.dirname(pictures), "subagents");
    // The numbers to hand out next follow every one used, in a line or by a file whose line a crash lost (choices 4, 5).
    const nextPicture = Math.max(...used, ...numbered(pictures, /^(\d+)\.(png|jpg|gif|webp)$/)) + 1;
    const nextTask = Math.max(0, ...subagents.map((s) => Number(/^t(\d+)$/.exec(s.id)?.[1] ?? 0)), ...numbered(subagentsDir, /^t(\d+)\.jsonl$/)) + 1;
    return {
      start,
      messages: pair(history.map((m) => restore(m, pictures))),
      system,
      lead,
      name,
      firstPrompt: prompts[0],
      damaged,
      unfinished: subagents.filter((s) => !finished(path.join(subagentsDir, s.file))).map(({ id, description }) => ({ id, description })),
      prompts,
      calls,
      nextPicture,
      nextTask,
    };
  } catch (err) {
    return { problem: `${file} could not be read as a session (${errorText(err)}).` };
  }
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
  if (r.t === "start") return r.v === 1 && strings("id", "project", "lead", "version", "system") && typeof r.print === "boolean" && Array.isArray(r.tools);
  if (r.t === "message") return isMessage(r.message);
  if (r.t === "lead") return strings("lead");
  if (r.t === "name") return strings("name");
  if (r.t === "shortened") return strings("system") && isMessage(r.message);
  if (r.t === "subagent") return strings("id", "description", "file");
  if (r.t === "ended") return r.state === "failed" || r.state === "stopped";
  return false;
}

// Each picture read back from its file; one that cannot be read becomes a note in its place (choice 5).
function restore(m: SavedMessage, pictures: string): Message {
  const parts = m.parts.map((p): Part => {
    if (p.type !== "image") return p;
    try {
      return { type: "image", id: p.id, mediaType: p.mediaType, data: readFileSync(path.join(pictures, p.file)) };
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
      if (others(m).length) out.push({ ...m, parts: others(m) });
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

// The numbers in a folder's file names, none when it is not there.
function numbered(dir: string, name: RegExp): number[] {
  try {
    return readdirSync(dir).map((n) => Number(name.exec(n)?.[1] ?? 0));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

// Whether a subagent's file shows it finished: an `ended` line, as the lead was told it failed or was stopped (choice 4),
// or its answer last, a reply with words and no calls, as tasks.ts takes the last reply's text for its answer. A file
// that is gone or cannot be read shows neither.
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
