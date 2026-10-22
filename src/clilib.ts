import { constants } from "node:os";
import { type Segment, SEGMENTS } from "./tui/StatusLine.js";

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
