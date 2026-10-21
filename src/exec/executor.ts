export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Everything a tool does to the machine goes through here, so the Docker sandbox can replace it.
export interface Executor {
  exec(command: string, cwd: string, signal?: AbortSignal): Promise<ExecResult>;
  readFile(abs: string): Promise<string>;
  writeFile(abs: string, content: string): Promise<void>;
}
