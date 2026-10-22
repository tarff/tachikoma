// ask:     ask before every write and shell command, and before anything outside the project
// project: ask before shell commands and anything outside the project
// never:   never ask (meant for the Docker sandbox)
export type Mode = "ask" | "project" | "never";
export const MODES: Mode[] = ["ask", "project", "never"];

export interface Action {
  kind: "read" | "write" | "shell";
  outside: boolean;
  summary: string;
  detail?: string; // what a write puts in the file, shown above the question; not escaped here
}

export function needsApproval(mode: Mode, action: Action): boolean {
  if (mode === "never") return false;
  if (action.outside) return true;
  if (mode === "ask") return action.kind !== "read";
  return action.kind === "shell";
}

// Symbols, not \n-style escapes: a typed backslash-n must not look like a real line break, or two
// commands could pass for one.
const NAMED: Record<string, string> = { "\n": "⏎", "\r": "␍", "\t": "⇥" };

// Shows control characters as escapes, so the approval prompt shows what will run: escape codes can
// hide or recolour text, \r and many \n can push part of a command out of sight, and bidi overrides
// can reorder it, as can invisible direction marks. `tabs` keeps tabs as they are, for prose in the
// scrollback.
export function visible(text: string, opts: { tabs?: boolean } = {}): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, (c) =>
    opts.tabs && c === "\t" ? c : (NAMED[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`),
  );
}

// Thrown when the user says no. The model is told; it is not logged as an error.
export class Declined extends Error {}

export class PermissionGate {
  constructor(
    readonly mode: Mode,
    private readonly ask: (summary: string, detail?: string) => Promise<boolean>,
    private readonly refusal = "The user declined", // what the model is told; in -p mode nobody was asked
  ) {}

  async require(action: Action): Promise<void> {
    if (!needsApproval(this.mode, action)) return;
    const shown = visible(action.summary);
    if (!(await this.ask(shown, action.detail))) throw new Declined(`${this.refusal}: ${shown}`);
  }
}
