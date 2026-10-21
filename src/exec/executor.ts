// Claude Code's Bash tool cuts output at 30,000 characters. We start from the same cap until our
// own error log and transcripts show whether it should move.
export const MAX_TOOL_OUTPUT = 30_000;

export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null; // set when the command was killed by a signal
  stdout: string;
  stderr: string;
}

// Everything a tool does to the machine goes through here, so the Docker sandbox can replace it.
export interface Executor {
  exec(command: string, cwd: string, signal?: AbortSignal): Promise<ExecResult>;
  readFile(abs: string): Promise<string>;
  writeFile(abs: string, content: string): Promise<void>;
}
