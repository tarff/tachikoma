import { constants } from "node:os";
import { visible } from "./core/permissions.js";
import { screen } from "./tui/describe.js";
import { type Segment, SEGMENTS } from "./tui/StatusLine.js";

// Headless output reaches the terminal too, so model and provider text gets the scrollback's escaping.
export const prose = (text: string) => screen({ text }).text;

// The -p answer may be saved and read later, so it is escaped wherever it goes (gh and Gemini CLI do the
// same; see "Changed while building"). Unlike the scrollback, it keeps what is harmless and wanted in a
// saved file: \r\n (a \r just before \n cannot overwrite anything), tabs, and the plain direction marks
// U+200E, U+200F and U+061C of ordinary right-to-left text. Overrides and isolates, which can reorder
// text, are still escaped. Escaping is never silent off the terminal: the note says it happened.
const UNSAFE = /\r(?!\n)|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;

export function headlessAnswer(text: string, opts: { raw: boolean; tty: boolean }): { out: string; note?: string } {
  if (opts.raw) return { out: text };
  let n = 0;
  const out = text.replace(UNSAFE, (c) => (n++, visible(c)));
  if (!n || opts.tty) return { out };
  return { out, note: `note: ${n} control character${n === 1 ? " in the answer was" : "s in the answer were"} printed as escapes; --raw prints the answer exactly` };
}

// JSON.stringify has already escaped \n, \r, \t and the other C0 characters; visible() writes the rest
// (C1, DEL, bidi overrides) as the \uXXXX escapes JSON itself uses, so the line parses to the same value.
export const jsonLine = (event: string, data: unknown) => visible(JSON.stringify({ event, data }));

// Stopped wins: an aborted request reports no error, and the shell reads 128 + n as "stopped by signal n".
// A declined action fails the run, or a script would take a run that did nothing for success.
export function headlessExit(run: { aborted: boolean; failed: boolean; declined: boolean }): number {
  if (run.aborted) return 128 + constants.signals.SIGINT;
  return run.failed || run.declined ? 1 : 0;
}

// A segment named twice is shown once, where it first appears.
export function statusSegments(value: string | undefined): Segment[] {
  if (value === undefined) return SEGMENTS;
  const names = value.split(",").map((s) => {
    const name = s.trim();
    if (!(SEGMENTS as string[]).includes(name)) throw new Error(`--status must be one of: ${SEGMENTS.join(", ")} (got "${name}")`);
    return name as Segment;
  });
  return [...new Set(names)];
}

// A reader such as `head` that stops early is a normal end, not a crash.
export function endOnEpipe(err: NodeJS.ErrnoException): void {
  if (err.code !== "EPIPE") throw err;
  process.exit();
}
