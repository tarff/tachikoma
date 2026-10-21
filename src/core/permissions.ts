// ask:     ask before every write and shell command, and before anything outside the project
// project: ask before shell commands and anything outside the project
// never:   never ask (meant for the Docker sandbox)
export type Mode = "ask" | "project" | "never";
export const MODES: Mode[] = ["ask", "project", "never"];

export interface Action {
  kind: "read" | "write" | "shell";
  outside: boolean;
  summary: string;
}

export function needsApproval(mode: Mode, action: Action): boolean {
  if (mode === "never") return false;
  if (action.outside) return true;
  if (mode === "ask") return action.kind !== "read";
  return action.kind === "shell";
}

// Thrown when the user says no. The model is told; it is not logged as an error.
export class Declined extends Error {}

export class PermissionGate {
  constructor(
    readonly mode: Mode,
    private readonly ask: (summary: string) => Promise<boolean>,
  ) {}

  async require(action: Action): Promise<void> {
    if (needsApproval(this.mode, action) && !(await this.ask(action.summary))) {
      throw new Declined(`The user declined: ${action.summary}`);
    }
  }
}
