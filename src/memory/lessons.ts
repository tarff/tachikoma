import path from "node:path";
import type { Bus, ToolOutcome } from "../core/bus.js";
import type { Message, Provider, Turn } from "../core/types.js";
import { firstWord } from "./lessonQuery.js";
import { LONGEST_ENTRY } from "./saver.js";

// The lesson ask (8d plan, step 26; the design's section 5): at a turn's end, when a tool call failed and a later call
// in that turn did the same job and worked, one request to the lead, apart from the conversation, made as the judge's
// is (src/safety/judge.ts): the approved text, then the failed call, its error and the call that worked. Its reply's
// first line is the lesson, stored as record_lesson stores one (step 23).

// The design's request (approved 2026-11-19), and the three lines after it (approved 2026-11-20, before the build);
// the request carries no system prompt of its own (approved 2026-11-20).
export const LESSON_REQUEST = "A tool call failed earlier in this turn, and a later call doing the same job worked. " +
  "If there is a lesson worth keeping for next time, write it in one line: what went wrong, what fixed it, and how " +
  "to spot it. If there is none, answer: none.";
export const lessonRequest = (failed: string, error: string, worked: string) =>
  `${LESSON_REQUEST}\n\nFailed call: ${failed}\nIts error: ${error}\nThe call that worked: ${worked}`;

// A call of the turn, as the session records it: the input that ran (after any hook's rewrite), how it ended, and for
// a failure the plain error, before any lessons are added to it.
export interface Ran {
  name: string;
  input: unknown;
  outcome: ToolOutcome;
  error?: string;
}

const FILE_EDITS = new Set(["write_file", "edit_file"]);
const pathOf = (input: unknown) => (input as { path?: unknown } | null | undefined)?.path;
const samePath = (a: unknown, b: unknown, root: string) => typeof a === "string" && typeof b === "string" &&
  path.resolve(root, a).toLowerCase() === path.resolve(root, b).toLowerCase();

// The design's rule for the same job (section 5), as step 12 measured it (scripts/8d/measure-lesson-ask.mjs): a
// command (`shell`), the same first word, by step 25's one rule; a file edit (`write_file` or `edit_file`), the same
// file, its path resolved against the project's folder and compared without regard to letter case; otherwise the
// same tool.
function sameJob(a: Ran, b: Ran, root: string): boolean {
  if (a.name === "shell" || b.name === "shell") {
    const w = firstWord((a.input as { command?: unknown } | null | undefined)?.command);
    return a.name === b.name && w !== undefined && w === firstWord((b.input as { command?: unknown } | null)?.command);
  }
  if (FILE_EDITS.has(a.name) && FILE_EDITS.has(b.name)) return samePath(pathOf(a.input), pathOf(b.input), root);
  return a.name === b.name;
}

// The turn's first failed call that a later call doing the same job worked after, with the first such call; declined
// and cancelled calls count as neither. None when there is no such pair: a turn asks once at most.
export function pairOf(calls: Ran[], root: string): { failed: Ran; worked: Ran } | undefined {
  for (const [i, failed] of calls.entries()) {
    if (failed.outcome !== "failed") continue;
    const worked = calls.slice(i + 1).find((c) => c.outcome === "ok" && sameJob(failed, c, root));
    if (worked) return { failed, worked };
  }
  return undefined;
}

// The lesson in the reply: its first line, or nothing for a reply cut off, a blank one, the answer "none" (in any
// letter case, a final full stop aside), or a line over MemPalace's 100,000 characters, counted by code point.
function lessonIn(turn: Turn): string | undefined {
  if (turn.cutOff) return undefined;
  const text = turn.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n").trim();
  const line = text.split("\n")[0]!.trim();
  if (!line || line.replace(/\.$/, "").toLowerCase() === "none") return undefined;
  return [...line].length > LONGEST_ENTRY ? undefined : line;
}

// One request to `lead` with the request's text alone. Its spend is reported as the judge's is, marked as the
// lesson ask's, so it adds to the cost and not to the conversation's context. A failed or stopped request gives
// nothing and says nothing.
export async function askLesson(lead: Provider, text: string, signal: AbortSignal, bus: Bus):
  Promise<string | undefined> {
  if (signal.aborted) return undefined;
  let turn: Turn;
  try {
    const messages: Message[] = [{ role: "user", parts: [{ type: "text", text }] }];
    turn = await lead.complete({ system: "", messages, tools: [], signal, cache: false });
  } catch {
    return undefined;
  }
  for (const d of turn.declined ?? []) bus.emit("usage", { ...d, lesson: true });
  bus.emit("usage", { provider: turn.servedBy ?? lead.id, usage: turn.usage, lesson: true });
  if (signal.aborted) return undefined;
  return lessonIn(turn);
}
