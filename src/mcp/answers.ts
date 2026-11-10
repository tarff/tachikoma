import { appendFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { privateDir, readPrivate } from "../auth/private.js";
import { dataDir, projectFile } from "../core/datadir.js";

// The user's answers to whether a project's MCP server may start (release 8c plan, choice 24): yes, no, or none.
export interface Answers {
  get(name: string): boolean | undefined;
  set(name: string, yes: boolean): void;
  reset(name: string): void;
}

type Line = { name: string; yes: boolean } | { name: string; reset: true };

// A killed process or a full disk can leave a half-written line; it is skipped, so the rest still count.
function parse(line: string): Line | undefined {
  try {
    const l = JSON.parse(line);
    if (typeof l?.name === "string" && (typeof l.yes === "boolean" || l.reset === true)) return l;
  } catch {}
  return undefined;
}

// The project's answers, in a private file in the data folder named after the project's real path, one line per answer,
// the last line for a name winning. Read once here; each answer is one line appended, as the error log's rows are, so two
// windows in one project keep each other's. Nothing is written, nor its folder made (which starts PowerShell on Windows),
// until the user answers.
export function answersFor(root: string, dir: string = dataDir()): Answers {
  const file = projectFile("mcp-answers", root, dir);
  const answers = new Map<string, boolean>();
  // readPrivate's note that it made the file private has no place to go here; the file is made private all the same.
  const text = lstatSync(file, { throwIfNoEntry: false }) ? (readPrivate(file, () => {}) ?? "") : "";
  for (const l of text.split("\n").map(parse)) {
    if (!l) continue;
    if ("reset" in l) answers.delete(l.name);
    else answers.set(l.name, l.yes);
  }
  const append = (line: Line) => {
    privateDir(path.dirname(file));
    appendFileSync(file, `${JSON.stringify(line)}\n`, { encoding: "utf8", mode: 0o600 });
  };
  return {
    get: (name) => answers.get(name),
    set(name, yes) {
      append({ name, yes });
      answers.set(name, yes);
    },
    reset(name) {
      append({ name, reset: true });
      answers.delete(name);
    },
  };
}
