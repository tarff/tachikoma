import { constants } from "node:os";
import path from "node:path";
import type { Instructions, Reached } from "./core/instructions.js";
import { visible } from "./core/permissions.js";
import { screen } from "./tui/describe.js";
import { k, type Segment, SEGMENTS } from "./tui/StatusLine.js";

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

// Full screen unless asked for classic (release 5 design, "The two modes"). An empty TACHI_CLASSIC or 0 reads as unset
// (the plan's choice 14), so `TACHI_CLASSIC=0` turns it off.
// Classic too where Ink would not use its own second screen (the user's choice, 2026-10-27, at Task 6's build): output
// that is not a terminal, or CI, which Ink counts as not interactive even on a terminal (ink.js, resolveInteractiveOption
// and resolveAlternateScreenOption, lines 706-713). CI as Ink's is-in-ci reads it: CI or CONTINUOUS_INTEGRATION set to
// anything but 0 or false (node_modules/is-in-ci/index.js).
export function screenMode(classic: boolean | undefined, env: NodeJS.ProcessEnv, tty: boolean): "full" | "classic" {
  const value = env.TACHI_CLASSIC ?? "";
  const ci = ["CI", "CONTINUOUS_INTEGRATION"].some((key) => key in env && env[key] !== "0" && env[key] !== "false");
  return classic || (value !== "" && value !== "0") || !tty || ci ? "classic" : "full";
}

// Rows a wheel notch scrolls (release 5 design, "Scrolling"): 3 unless given, the probe's Windows setting and Claude
// Code's note that 3 matches vim; up to 20, the range of Claude Code's CLAUDE_CODE_SCROLL_SPEED. Digits with an optional
// decimal point only (the plan's choice 15): Number() would also take "1e1", " 3" and "0x10". The option wins over the
// variable, and an empty variable is unset, as TACHI_LEAD and TACHI_WORKER are.
export function scrollSpeed(option: string | undefined, env: NodeJS.ProcessEnv): number {
  const [value, name] = option !== undefined ? [option, "--scroll-speed"] : [env.TACHI_SCROLL_SPEED || undefined, "TACHI_SCROLL_SPEED"];
  if (value === undefined) return 3;
  const speed = /^\d+(\.\d+)?$|^\.\d+$/.test(value) ? Number(value) : NaN;
  if (!(speed > 0 && speed <= 20)) throw new Error(`${name} must be a number above 0, up to 20 (got "${value}")`);
  return speed;
}

// The signals that end Tachikoma through process.exit, so `exit` handlers run: the executor's, which stops running
// commands, and the one that puts the terminal back (release 5 design, "When something goes wrong"). Ctrl+Break and
// SIGQUIT were added at Task 6's review (the user's choice, 2026-10-27): Windows sends SIGBREAK for Ctrl+Break even in
// raw mode ("CTRL+BREAK is always treated as a signal", Microsoft's "CTRL+C and CTRL+BREAK Signals", read 2026-10-27;
// raw mode turns off only Ctrl+C's). signal-exit (node_modules/signal-exit/signals.js) knows neither on Windows; elsewhere it catches SIGQUIT, but
// only to unmount Ink and send the signal again, so the process dies with no `exit` event, on the second screen.
export function exitSignals(platform: NodeJS.Platform): NodeJS.Signals[] {
  return ["SIGTERM", "SIGHUP", platform === "win32" ? "SIGBREAK" : "SIGQUIT"];
}

// A reader such as `head` that stops early is a normal end, not a crash.
export function endOnEpipe(err: NodeJS.ErrnoException): void {
  if (err.code !== "EPIPE") throw err;
  process.exit();
}

// The grey line at the start of a session (release 4 design, "Instruction files"): the files read,
// the user's folder written as ~, their total size, and any left out and why. Paths come from the disk,
// so they are escaped.
export function instructionsLine(r: Instructions, home: string): string | null {
  if (!r.read.length && !r.left.length) return null;
  const short = (p: string) => visible(p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p);
  const size = r.read.reduce((n, f) => n + f.size, 0);
  const read = r.read.length ? `${r.read.map((f) => short(f.path)).join(", ")} (${k(size)} bytes)` : "none read";
  const left = r.left.length ? `; left out: ${r.left.map((l) => `${short(l.path)} (${visible(l.why)})`).join(", ")}` : "";
  return `Instructions: ${read}${left}`;
}

const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

// The one question at the start about files the instruction files lead to outside the project.
export function approvalQuestion(reached: Reached[]): string {
  return [`Read ${files(reached.length)} from outside the project, reached by the instruction files?`, ...reached.map((r) => `  ${visible(r.path)}, ${visible(r.how)}`), "[y/n]"].join("\n");
}

// With -p nobody can approve them, so they are left out, and stderr names them.
export function headlessLeftOut(reached: Reached[]): string {
  const n = reached.length;
  return `note: ${n} instruction file${n === 1 ? "" : "s"} from outside the project left out, since nobody can approve ${n === 1 ? "it" : "them"} in -p mode: ${reached.map((r) => `${visible(r.path)}, ${visible(r.how)}`).join("; ")}`;
}
