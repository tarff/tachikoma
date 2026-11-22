// The lesson search's query for a failed tool call, and a command's first word (8d plan, step 25, "The query"; Q18 as
// the user decided after step 13). The same rule step 13's re-run measured with (scripts/8d/lesson-query.mjs), held to
// it by tests/memory/lessonQuery.test.ts; step 26 takes its "same job" first word from here.
//
// - A failed command: the tool is `shell` and the error has the status shape that shellText builds
//   (src/tools/shell.ts:4-8, thrown at src/tools/commands.ts:87): a status line (`exit code: N` or `killed by` and a
//   signal), then the fixed line `--- stderr ---`. The query is the tool's name, the command's first word and the
//   command's own message: reading on from the status line, the first line that is not blank and is not one of the
//   two fixed marker lines, with a Windows line end taken off; with no such line, the status line itself.
// - Any other `shell` failure (a timeout, src/tools/commands.ts:72-75; a command that could not be started,
//   src/exec/local.ts:101-102) and every other tool: the tool's name and the error's first line.
// - The pieces are joined by single spaces and the whole is cut to its first 250 characters, MemPalace's most for a
//   query (step 6 item 7; mempalace/mcp_server/schemas.py:309), counted by code point as MemPalace counts them, so no
//   character is cut in half.

const LONGEST_QUERY = 250;
const MARKERS = ["--- stderr ---", "--- stdout ---"];
// `exit code: null` too: shellText writes it for a result with no code and no signal (ExecResult's `code` may be
// null, src/exec/executor.ts:8; src/tools/shell.ts:5).
const STATUS = /^(exit code: (-?\d+|null)|killed by \S+)$/;

// A command's first word, the design's rule for "the same job" (section 5) as step 12 took it
// (scripts/8d/measure-lesson-ask.mjs); none for a command that is not a string or holds only white space.
export const firstWord = (command: unknown): string | undefined =>
  typeof command === "string" ? command.trim().split(/\s+/)[0] || undefined : undefined;

const statusShaped = (error: string) => {
  const lines = error.split("\n");
  return STATUS.test(lines[0]!) && lines[1] === MARKERS[0];
};

const cut = (s: string) => [...s].slice(0, LONGEST_QUERY).join("");

// `input`: the input that ran, after any hook's rewrite; `error`: the error's whole text, before it is cut for the
// model.
export function lessonQuery(tool: string, input: unknown, error: string): string {
  // A Windows line end is taken off the first line on every path, as off a command's message below.
  const first = error.split("\n")[0]!.replace(/\r$/, "");
  if (tool !== "shell" || !statusShaped(error)) return cut(`${tool} ${first}`);
  const message = error.split("\n").slice(1).map((l) => l.replace(/\r$/, ""))
    .find((l) => l.trim() && !MARKERS.includes(l));
  const word = firstWord((input as { command?: unknown } | null | undefined)?.command);
  return cut([tool, word, message ?? first].filter((p) => p !== undefined).join(" "));
}
