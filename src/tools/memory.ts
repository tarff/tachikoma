import { z } from "zod";
import { localDate } from "../core/setup.js";
import type { Failure, Hit, Palace } from "../memory/client.js";
import type { MemoryState } from "../memory/memory.js";
import { LESSONS } from "../memory/paths.js";
import { LONGEST_ENTRY } from "../memory/saver.js";
import { defineTool, type TextTool } from "./tool.js";

// The three memory tools (8d plan, step 23; the design's section 4): memory_search, memory_save and record_lesson,
// built on step 21's memory. None asks for approval, as they only read or add to the palace. A tool that cannot do its
// work says why as its error (thrown here, as every tool's error is, and turned into the failed result by the session);
// nothing of the palace throws into a turn.

// The most matches a search gives: MemPalace's own default (`limit: int = 5`, tool_search in
// mempalace/mcp_server/tools_read.py:609-611 of the build's MemPalace 3.12.0), the user's choice before step 23. Each
// search asks for it, and "project" keeps it of the two rooms' matches merged.
const RESULTS = 5;

// The approved wording (plan step 23, the user's approval before the build, 2026-11-20).
const SEARCH =
  "Search long-term memory: earlier conversations with the user, saved notes and lessons from earlier failures. " +
  'Scope "project" (the default) searches this project and the lessons; "all" searches everything in the palace.';
const QUERY = "What to look for, in plain words; only the first 250 characters are used.";
const SCOPE = '"project" (the default) or "all".';
const SAVE =
  "Save a note to long-term memory, for something worth keeping beyond this conversation, such as a decision, a fact " +
  "about the project or a preference of the user's. It is filed under this project.";
const NOTE = "The note, written so it makes sense on its own later.";
const RECORD =
  "Record a lesson after fixing a failure, so it is found when a like failure comes back, in any project: what went " +
  "wrong, what fixed it, and how to spot it next time.";
const LESSON = "The lesson, in one or two sentences.";
const NO_MATCHES = "No matches.";
const SAVED = "Saved.";
const RECORDED = "Recorded.";
export const HELD = "Not recorded: memory already holds this lesson.";
const NOTE_TOO_LONG = "Not saved: a note can be at most 100,000 characters.";
export const LESSON_TOO_LONG = "Not recorded: a lesson can be at most 100,000 characters.";
export const NOT_READY = "Memory is not ready yet; try again shortly.";

// Approved with step 23's questions (the user, 2026-11-20): a request the palace did not answer, refused or failed
// while memory stays on; and memory with no reason and no palace (closed).
export const late = (ms: number) => `Memory did not answer within ${ms / 1000} s; try again shortly.`;
export const refused = (said: string) => `Memory refused it: ${said}.`;
export const failed = (said: string) => `Memory failed: ${said}.`;
export const OFF = "Memory is off.";

// A label the model sees in results: a note, by its number among this session's notes in this run; a lesson, by the
// project's room and the day it was recorded, which go in its label only, so that MemPalace's check for the very same
// text already in the room (`already_exists`, step 6 item 9) can see a repeat.
const noteLabel = (session: string, n: number) => `tachikoma session ${session}, note ${n}`;
export const lessonLabel = (room: string, date = localDate()) => `tachikoma lesson, ${room}, ${date}`;

// A match's date is the day MemPalace filed it, in local time as the lesson's label has it; one MemPalace does not
// give as a time (its "unknown") is shown as given (the user's choice at step 23, 2026-11-20).
const dayOf = (filed: string) => {
  const d = new Date(filed);
  return Number.isNaN(d.getTime()) ? filed : localDate(d);
};

// A match, in results and in the note (step 24): `<date> · <label> · <room>`, then the matched piece's text (at most
// 800 characters, step 6 item 8), the user's choice before step 23.
export const matchText = (hit: Hit) => `${dayOf(hit.date)} · ${hit.label} · ${hit.room}\n${hit.text}`;

// The request's answer, or Cancelled once the turn's signal comes, so Esc or Ctrl-C ends the call at once, as it ends
// a command's (commands.ts); the request runs on to its own time limit, as the note's searches do (session.ts,
// unlessStopped). The palace client never rejects (PR #26 review, finding 6).
const unlessStopped = <T>(p: Promise<T>, signal?: AbortSignal) =>
  new Promise<T>((resolve, reject) => {
    const stop = () => reject(new Error("Cancelled"));
    if (signal?.aborted) return stop();
    signal?.addEventListener("abort", stop, { once: true });
    void p.then((value) => {
      signal?.removeEventListener("abort", stop);
      resolve(value);
    });
  });

const codePoints = (s: string) => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

export interface MemoryToolsOptions {
  // Memory (step 21): its state, and its palace while connected.
  memory: { readonly state: MemoryState; readonly palace: Palace | undefined };
  // The project's room (step 16).
  room: string;
  // What "all" searches: Tachikoma's wing, or, with the user's own MemPalace, the whole palace (the design's
  // section 3).
  everything: "wing" | "palace";
  // The lead's session id now, for a note's label.
  session: () => string;
  // Each request's time limit, the caller's.
  timeouts: { search: number; add: number };
}

export function memoryTools(o: MemoryToolsOptions): { search: TextTool; save: TextTool; lesson: TextTool } {
  // The palace, or why memory cannot be used now: still connecting; the state's reason (off, failing, or not set up
  // with no uv); no palace. While memory winds down the palace is still there, as the saver uses it.
  const palace = (): Palace => {
    const s = o.memory.state;
    if (s.is === "setting up") throw new Error(NOT_READY);
    if ("reason" in s && s.reason !== undefined) throw new Error(s.reason);
    const p = o.memory.palace;
    if (!p) throw new Error(OFF);
    return p;
  };
  // A request that did not do its work: the state's reason when memory has changed meanwhile, else what happened.
  const fail = (f: Failure, ms: number): Error => {
    const s = o.memory.state;
    if (s.is === "setting up") return new Error(NOT_READY);
    if ("reason" in s && s.reason !== undefined) return new Error(s.reason);
    if (f.is === "timed out") return new Error(late(ms));
    if (f.is === "refused") return new Error(refused(f.reason));
    if (f.is === "failed") return new Error(failed(f.reason));
    return new Error(OFF);
  };
  const notes = new Map<string, number>();

  const search = defineTool(
    "memory_search",
    SEARCH,
    z.object({
      query: z.string().min(1).describe(QUERY),
      scope: z.enum(["project", "all"]).optional().describe(SCOPE),
    }),
    async ({ query, scope }, ctx) => {
      const p = palace();
      const ms = o.timeouts.search;
      const r = await unlessStopped(
        scope === "all" ? p.search(query, o.everything, RESULTS, ms)
        : p.searchTwo(query, [o.room, LESSONS], RESULTS, ms),
        ctx.signal,
      );
      if (r.is !== "found") throw fail(r, ms);
      const hits = r.hits.slice(0, RESULTS);
      return hits.length ? hits.map(matchText).join("\n\n") : NO_MATCHES;
    },
  );

  const save = defineTool(
    "memory_save",
    SAVE,
    z.object({ text: z.string().min(1).describe(NOTE) }),
    async ({ text }, ctx) => {
      if (codePoints(text) > LONGEST_ENTRY) throw new Error(NOTE_TOO_LONG);
      const p = palace();
      const session = o.session();
      const n = (notes.get(session) ?? 0) + 1;
      // Taken before the request: a stopped or late one may still be stored, so its number is never given again; a
      // refused one leaves a gap (PR #26 Codex review 3).
      notes.set(session, n);
      const r = await unlessStopped(p.add(o.room, noteLabel(session, n), text, o.timeouts.add), ctx.signal);
      if (r.is !== "added" && r.is !== "already there") throw fail(r as Failure, o.timeouts.add);
      return SAVED;
    },
  );

  const lesson = defineTool(
    "record_lesson",
    RECORD,
    z.object({ lesson: z.string().min(1).describe(LESSON) }),
    async ({ lesson }, ctx) => {
      if (codePoints(lesson) > LONGEST_ENTRY) throw new Error(LESSON_TOO_LONG);
      const r = await unlessStopped(palace().add(LESSONS, lessonLabel(o.room), lesson, o.timeouts.add), ctx.signal);
      if (r.is === "already there") return HELD;
      if (r.is !== "added") throw fail(r as Failure, o.timeouts.add);
      return RECORDED;
    },
  );

  return { search, save, lesson };
}
