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

// A killed process or a full disk can leave a half-written line; it is skipped, so the rest still count. Only a reset of
// true is a reset, so a line with a yes and a reset of false is that yes.
function parse(line: string): Line | undefined {
  try {
    const l = JSON.parse(line);
    if (typeof l?.name !== "string") return undefined;
    if (l.reset === true) return { name: l.name, reset: true };
    if (typeof l.yes === "boolean") return { name: l.name, yes: l.yes };
  } catch {}
  return undefined;
}

// The project's answers, in a private file in the data folder named after the project's real path, one line per answer,
// the last line for a name winning. Read once here; each answer is one line appended, as the error log's rows are, so two
// windows in one project keep each other's. Nothing is written, nor its folder made (which starts PowerShell on Windows),
// until the user answers. `warn` gets readPrivate's note that it made the file private, as the prompt history's does.
export function answersFor(root: string, dir: string = dataDir(), warn: (message: string) => void = () => {}): Answers {
  const file = projectFile("mcp-answers", root, dir);
  const answers = new Map<string, boolean>();
  const text = lstatSync(file, { throwIfNoEntry: false }) ? (readPrivate(file, warn) ?? "") : "";
  for (const l of text.split("\n").map(parse)) {
    if (!l) continue;
    if ("reset" in l) answers.delete(l.name);
    else answers.set(l.name, l.yes);
  }
  // A half-written last line is ended first, as the transcript's mend does, so the next answer is not joined to it and
  // lost: a lost reset would leave the old yes in force.
  let ended = text === "" || text.endsWith("\n");
  const append = (line: Line) => {
    privateDir(path.dirname(file));
    appendFileSync(file, `${ended ? "" : "\n"}${JSON.stringify(line)}\n`, { encoding: "utf8", mode: 0o600 });
    ended = true;
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
