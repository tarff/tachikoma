import { constants } from "node:os";
import path from "node:path";
import type { Instructions, Reached } from "./core/instructions.js";
import { MODES, type Mode, OFFERED, visible } from "./core/permissions.js";
import { EFFORTS, type Effort } from "./providers/anthropic.js";
import type { Settings } from "./settings.js";
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

// The line for an action a -p run declines, as nobody can approve it: why, then the subagent that asked, if one did, and
// the action, already escaped by the gate (permissions.ts, require).
export function headlessDeclined(summary: string, owner?: string): string {
  return `declined, nobody to ask in -p mode (--mode project allows writes inside the project, but shell commands and anything outside it are still refused): ${owner ? `${prose(owner)}: ` : ""}${summary}`;
}

// Stopped wins: an aborted request reports no error, and the shell reads 128 + n as "stopped by signal n".
// A declined action fails the run, or a script would take a run that did nothing for success.
export function headlessExit(run: { aborted: boolean; failed: boolean; declined: boolean }): number {
  if (run.aborted) return 128 + constants.signals.SIGINT;
  return run.failed || run.declined ? 1 : 0;
}

// Eight Claude Haiku 5.5 subagents ran at once on the user's account with none refused; eight was the
// most tried (release 4 design, "Before the build", 2026-10-26).
export const MAX_TASKS = 8;

// The flags' own checks take the name to put before their words: `--mode`, or the settings file's `settings.json: "mode"`
// (release 6 plan, choice 8), so a flag and the file get the same rule and the same words. `shown` is the list the words
// name, where a value is read but not offered, as `never` is until release 7 (choice 30).
export function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[], shown: readonly T[] = allowed): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`${name} must be one of: ${shown.join(", ")} (got "${value}")`);
  return value as T;
}

// Digits only: Number() would also take "1e1", " 8 " and "0x10".
export function taskCount(value: string, name: string): number {
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number from 1 (got "${value}")`);
  return n;
}

// A segment named twice is shown once, where it first appears. --status gives them comma-separated, the settings file as a
// list (the plan's choice 7).
export function statusSegments(value: string | string[] | undefined, name = "--status"): Segment[] {
  if (value === undefined) return SEGMENTS;
  const names = (typeof value === "string" ? value.split(",") : value).map((s) => {
    const segment = s.trim();
    if (!(SEGMENTS as string[]).includes(segment)) throw new Error(`${name} must be one of: ${SEGMENTS.join(", ")} (got "${segment}")`);
    return segment as Segment;
  });
  return [...new Set(names)];
}

// Full screen unless asked for classic (release 5 design, "The two modes"). An empty TACHI_CLASSIC or 0 reads as unset
// (the plan's choice 14), so `TACHI_CLASSIC=0` turns it off. Then the settings file's "screen" (release 6 design, "Which
// wins"). Classic too where full screen can't draw (fullPossible).
export function screenMode(classic: boolean | undefined, env: NodeJS.ProcessEnv, tty: boolean, file?: "full" | "classic"): "full" | "classic" {
  const value = env.TACHI_CLASSIC ?? "";
  return classic || (value !== "" && value !== "0") || file === "classic" || !fullPossible(env, tty) ? "classic" : "full";
}

// Where Ink would not use its own second screen (the user's choice, 2026-10-27, at Task 6's build), full screen can't
// draw: output that is not a terminal, or CI, which Ink counts as not interactive even on a terminal (ink.js,
// resolveInteractiveOption and resolveAlternateScreenOption, lines 706-713). CI as Ink's is-in-ci reads it: CI or
// CONTINUOUS_INTEGRATION set to anything but 0 or false (node_modules/is-in-ci/index.js). /screen asks it too (found at
// the final review).
export function fullPossible(env: NodeJS.ProcessEnv, tty: boolean): boolean {
  const ci = ["CI", "CONTINUOUS_INTEGRATION"].some((key) => key in env && env[key] !== "0" && env[key] !== "false");
  return tty && !ci;
}

// Rows a wheel notch scrolls (release 5 design, "Scrolling"): 3 unless given, the probe's Windows setting and Claude
// Code's note that 3 matches vim; up to 20, the range of Claude Code's CLAUDE_CODE_SCROLL_SPEED. Digits with an optional
// decimal point only (the plan's choice 15): Number() would also take "1e1", " 3" and "0x10". The option wins over the
// variable, and an empty variable is unset, as TACHI_LEAD and TACHI_WORKER are; then the settings file's, already checked.
export function scrollSpeed(option: string | undefined, env: NodeJS.ProcessEnv, file?: number): number {
  const [value, name] = option !== undefined ? [option, "--scroll-speed"] : [env.TACHI_SCROLL_SPEED || undefined, "TACHI_SCROLL_SPEED"];
  if (value === undefined) return file ?? 3;
  return speedValue(value, name);
}

export function speedValue(value: string, name: string): number {
  const speed = /^\d+(\.\d+)?$|^\.\d+$/.test(value) ? Number(value) : NaN;
  if (!(speed > 0 && speed <= 20)) throw new Error(`${name} must be a number above 0, up to 20 (got "${value}")`);
  return speed;
}

export interface Flags {
  lead?: string;
  mode?: string;
  effort?: string;
  fallback?: string;
  worker?: string;
  "max-tasks"?: string;
  status?: string;
  classic?: boolean;
  "scroll-speed"?: string;
  print?: string;
}

// Each launch option from its flag, then its TACHI_ variable, then the settings file, then the default (release 6 design,
// "Which wins"). A bad flag throws in its own words; the file's values were checked when it was read. An empty variable is
// unset; an empty --fallback or --worker still wins, so it turns the file's off as it turned the variable's off before.
// The screen is screenMode's, which also asks the terminal; createProvider checks the lead, fallback and worker at use.
// The flags are checked in release 5's order. The lead is leadOf's.
export function resolve(flags: Flags, env: NodeJS.ProcessEnv, settings: Settings) {
  return {
    mode: oneOf<Mode>("--mode", flags.mode, MODES, OFFERED) ?? settings.mode ?? "ask", // the safest mode is the default
    effort: oneOf<Effort>("--effort", flags.effort, EFFORTS) ?? settings.effort,
    fallback: flags.fallback ?? settings.fallback,
    worker: flags.worker ?? (env.TACHI_WORKER || undefined) ?? settings.worker,
    maxTasks: flags["max-tasks"] === undefined ? (settings.maxTasks ?? MAX_TASKS) : taskCount(flags["max-tasks"], "--max-tasks"),
    segments: flags.status === undefined ? (settings.status ?? SEGMENTS) : statusSegments(flags.status),
    // -p has no screen to scroll, so it ignores TACHI_SCROLL_SPEED as it does TACHI_CLASSIC, and the file's scrollSpeed too,
    // though the file is still checked whole, so a bad one there stops -p. A bad --scroll-speed, typed for this run, still
    // stops it (the user's choice, 2026-10-27, at release 5's Task 7 review).
    speed: flags.print === undefined ? scrollSpeed(flags["scroll-speed"], env, settings.scrollSpeed) : scrollSpeed(flags["scroll-speed"], {}),
  };
}

// The entries a flag or TACHI_ variable gave at launch, each with that flag's or variable's name: a live edit of the
// settings file leaves them as given for the session, and its line names which (release 6 design, "Live edits"). As
// resolve and screenMode read them: an empty variable is unset, and TACHI_CLASSIC=0 too; an empty --fallback is given.
export type Given = Partial<Record<keyof Settings, string>>;
const GIVERS: [keyof Settings, keyof Flags, string?][] = [
  ["lead", "lead", "TACHI_LEAD"],
  ["mode", "mode"],
  ["effort", "effort"],
  ["fallback", "fallback"],
  ["worker", "worker", "TACHI_WORKER"],
  ["maxTasks", "max-tasks"],
  ["status", "status"],
  ["screen", "classic", "TACHI_CLASSIC"],
  ["scrollSpeed", "scroll-speed", "TACHI_SCROLL_SPEED"],
];
export function givenBy(flags: Flags, env: NodeJS.ProcessEnv): Given {
  const given: Given = {};
  for (const [entry, flag, variable] of GIVERS) {
    if (flags[flag] !== undefined) given[entry] = `--${flag}`;
    else if (variable && env[variable] && !(variable === "TACHI_CLASSIC" && env[variable] === "0")) given[entry] = variable;
  }
  return given;
}

// Apart from resolve, since a missing lead is told before any bad flag, as in release 5.
export function leadOf(flags: Flags, env: NodeJS.ProcessEnv, settings: Settings): string | undefined {
  return flags.lead ?? (env.TACHI_LEAD || undefined) ?? settings.lead;
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

// The handler cli.tsx gives a signal that ends Tachikoma: exit with 128 and its number. While a program has the terminal
// (owner.ts, programRunning: the editor), raw mode is off, so Ctrl-C and Ctrl-\ come as SIGINT and SIGQUIT; they are
// the program's keys then and are ignored here, as Git's launch_specified_editor ignores both while the editor runs
// (editor.c, its sigchain_push(SIGINT, SIG_IGN), read 2026-10-29). The turn goes on (release 6 plan, choice 31).
export function exitOn(sig: NodeJS.Signals, programRunning: () => boolean): () => void {
  return () => {
    if (!(programRunning() && (sig === "SIGINT" || sig === "SIGQUIT"))) process.exit(128 + constants.signals[sig]);
  };
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
