// Claude Code's Bash tool cuts output at 30,000 characters. We start from the same cap until our
// own error log and transcripts show whether it should move.
export const MAX_TOOL_OUTPUT = 30_000;

export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null; // set when the command was killed by a signal
  stdout: string;
  stderr: string;
}

// The shell tool's commands go through here, so the Docker sandbox can replace it; the file tools go through the
// Workspace (workspace.ts).
export interface Executor {
  exec(command: string, cwd: string, signal?: AbortSignal): Promise<ExecResult>;
}
