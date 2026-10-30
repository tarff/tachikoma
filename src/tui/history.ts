import path from "node:path";
import { withLock } from "../auth/lock.js";
import { privateDir, readPrivate, writePrivate } from "../auth/private.js";
import { dataDir, projectFile } from "../core/datadir.js";
import { errorText } from "../core/types.js";

// Each project folder's past prompts (release 3 design, "How it is built"): a private file in the data
// folder, named after the folder's real path, so two ways of writing one folder share it. One prompt a
// line, as a JSON string, so a prompt's own line breaks stay inside it; kept in full.
export function historyFile(root: string, data = dataDir()): string {
  return projectFile("history", root, data);
}

// A damaged line is skipped, so the rest can still be used.
function parse(text: string): string[] {
  return text.split("\n").flatMap((line) => {
    try {
      const entry: unknown = JSON.parse(line);
      return typeof entry === "string" ? [entry] : [];
    } catch {
      return [];
    }
  });
}

// Ctrl+R's matches: the past prompts holding `query`, in any case as the model picker's filter, newest
// first, each prompt once, at its newest (as Claude Code's search, interactive-mode.md).
export function matches(entries: readonly string[], query: string): string[] {
  const q = query.toLowerCase();
  return [...new Set(entries.toReversed())].filter((e) => e.toLowerCase().includes(q));
}

export class History {
  // Oldest first: what was saved before this session, then this session's prompts.
  readonly entries: string[] = [];
  #warned = false;

  constructor(
    readonly file: string,
    private readonly warn: (line: string) => void,
  ) {}

  load(): string[] {
    try {
      this.entries.splice(0, this.entries.length, ...parse(readPrivate(this.file, this.warn) ?? ""));
    } catch (err) {
      this.#fail(err);
    }
    return this.entries;
  }

  // In this session's list at once; saved under the lock, which every Tachikoma process shares, after
  // reading the file again, so two sessions in one project never lose each other's prompts. Never
  // rejects: a prompt is still sent when it cannot be saved.
  add(text: string): Promise<void> {
    this.entries.push(text);
    return (async () => {
      privateDir(path.dirname(this.file)); // the lock file goes there too
      await withLock(`${this.file}.lock`, async () => {
        const saved = readPrivate(this.file, this.warn) ?? "";
        writePrivate(this.file, `${saved}${saved && !saved.endsWith("\n") ? "\n" : ""}${JSON.stringify(text)}\n`);
      });
    })().catch((err) => this.#fail(err));
  }

  // Said once a session, so a history that cannot be used does not fill the screen.
  #fail(err: unknown): void {
    if (this.#warned) return;
    this.#warned = true;
    this.warn(`The prompt history could not be read or saved: ${errorText(err)}`);
  }
}
