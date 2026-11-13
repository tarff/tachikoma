import type { CommandLog } from "./log.js";

// Claude Code's Bash tool cuts output at 30,000 characters. We start from the same cap until our
// own error log and transcripts show whether it should move.
export const MAX_TOOL_OUTPUT = 30_000;

export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null; // set when the command was killed by a signal
  stdout: string;
  stderr: string;
}

// A command started without waiting for its end: its output as it arrives, its end, and a way to stop it, which settles
// `done` at once with `{ code: null, signal: "SIGKILL", ... }` (background commands plan, choice 1).
export interface Running {
  log: CommandLog;
  done: Promise<ExecResult>;
  stop(): void;
  // The box's: its stop settles `done` only once its kill has run there, or rejects it when the kill fails, so a stop of
  // a background command waits for that (user choice 36, PR #18 review).
  stopsLater?: true;
}

// The shell tool's commands go through here, so the Docker sandbox can replace it; the file tools go through the
// Workspace (workspace.ts).
export interface Executor {
  exec(command: string, cwd: string, signal?: AbortSignal): Promise<ExecResult>;
  start(command: string, cwd: string): Running;
}
