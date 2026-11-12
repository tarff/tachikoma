import type { ExecResult } from "../exec/executor.js";

// What the model reads of a command's run, also rebuilt from a hook's Bash output (hooks/tools.ts, outputFrom).
export function shellText(r: ExecResult): string {
  const status = r.signal ? `killed by ${r.signal}` : `exit code: ${r.code}`;
  // stderr first: the session keeps only the start of a long result, and the errors matter most.
  return `${status}\n--- stderr ---\n${r.stderr}\n--- stdout ---\n${r.stdout}`;
}
