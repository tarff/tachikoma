// The lesson search's query (8d plan, step 13's re-run; step 25, "The query"; Q18 as the user decided after step 13).
// Not part of Tachikoma: used by scripts/8d/measure-lessons.mjs, and step 25's code is held to the same cases
// (tests/memory/lesson-query.test.ts).
//
// - A failed command: the tool is `shell` and the error has the status shape that shellText builds
//   (src/tools/shell.ts:4-8, thrown at src/tools/commands.ts:87): a status line (`exit code: N` or `killed by` and a
//   signal), then the fixed line `--- stderr ---`. The query is the tool's name, the command's first word (step 12's
//   own function, `firstWord` in scripts/8d/measure-lesson-ask.mjs) and the command's own message: reading on from the
//   status line, the first line that is not blank and is not one of the two fixed marker lines, with a Windows line
//   end taken off; with no such line, the status line itself.
// - Any other `shell` failure (a timeout, src/tools/commands.ts:72-75; a command that could not be started,
//   src/exec/local.ts:101-102) and every other tool: the tool's name and the error's first line, as Q18 had it.
// - The pieces are joined by single spaces and the whole is cut to its first 250 characters, MemPalace's most for a
//   query (step 6 item 7; `maxLength` 250, mempalace/mcp_server/schemas.py:309), counted as MemPalace counts them,
//   by code point, so no character is cut in half.
// `{ old: true }` gives Q18's rule as it was at step 13's first run, the tool's name and the error's first line for
// every tool, for the comparison the plan asks for.
import { firstWord } from "./measure-lesson-ask.mjs";

export const QUERY_MAX = 250;
export const MARKERS = ["--- stderr ---", "--- stdout ---"];
const STATUS = /^(exit code: -?\d+|killed by \S+)$/;

export const statusShaped = (error) => {
  const lines = error.split("\n");
  return STATUS.test(lines[0]) && lines[1] === MARKERS[0];
};

const cut = (s) => [...s].slice(0, QUERY_MAX).join("");

export function lessonQuery(tool, input, error, { old = false } = {}) {
  const first = error.split("\n")[0];
  if (old || tool !== "shell" || !statusShaped(error)) return cut(`${tool} ${first}`);
  const message = error.split("\n").slice(1).map((l) => l.replace(/\r$/, ""))
    .find((l) => l.trim() && !MARKERS.includes(l));
  const word = firstWord(input?.command);
  return cut([tool, word, message ?? first].filter((p) => p !== undefined).join(" "));
}
