import { appendFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { privateDir, readPrivate } from "../auth/private.js";
import { dataDir, projectFile } from "../core/datadir.js";

// The user's answers to whether a project's MCP server may start (release 8c plan, choice 24): yes, no, or none. Each
// answer holds the entry it was given for (ServerConfig.written), and counts only for that entry, so a git pull that
// changes a server's command cannot start it unasked: the changed entry is asked about again.
export interface Answers {
  get(name: string, entry: string): boolean | undefined;
  set(name: string, entry: string, yes: boolean): void;
  reset(name: string): void;
}

type Answer = { entry: string; yes: boolean };
type Line = ({ name: string } & Answer) | { name: string; reset: true };

// A killed process or a full disk can leave a half-written line; it is skipped, so the rest still count. Only a reset of
// true is a reset, so a line with a yes and a reset of false is that yes. An answer without its entry is damaged, as it
// cannot say which entry it was given for.
function parse(line: string): Line | undefined {
  try {
    const l = JSON.parse(line);
    if (typeof l?.name !== "string") return undefined;
    if (l.reset === true) return { name: l.name, reset: true };
    if (typeof l.entry === "string" && typeof l.yes === "boolean") return { name: l.name, entry: l.entry, yes: l.yes };
  } catch {}
  return undefined;
}

// The project's answers, in a private file in the data folder named after the project's real path, one line per answer,
// the last line for a name winning. Read once here; each answer is one line appended, as the error log's rows are, so two
// windows in one project keep each other's. Nothing is written, nor its folder made (which starts PowerShell on Windows),
// until the user answers. `warn` gets readPrivate's note that it made the file private, as the prompt history's does.
export function answersFor(root: string, dir: string = dataDir(), warn: (message: string) => void = () => {}): Answers {
  const file = projectFile("mcp-answers", root, dir);
  const answers = new Map<string, Answer>();
  const text = lstatSync(file, { throwIfNoEntry: false }) ? (readPrivate(file, warn) ?? "") : "";
  for (const l of text.split("\n").map(parse)) {
    if (!l) continue;
    if ("reset" in l) answers.delete(l.name);
    else answers.set(l.name, { entry: l.entry, yes: l.yes });
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
    get(name, entry) {
      const answer = answers.get(name);
      return answer?.entry === entry ? answer.yes : undefined;
    },
    // Kept here first, so an answer whose line cannot be written still holds for this launch; the write's failure is
    // thrown for the launch to say (release 8c plan, choice 50).
    set(name, entry, yes) {
      answers.set(name, { entry, yes });
      append({ name, entry, yes });
    },
    reset(name) {
      answers.delete(name);
      append({ name, reset: true });
    },
  };
}

// Answers kept for this launch only, written nowhere: the window's, when the project's file could not be read, so each
// server asked about again starts or not as the user says, and is asked about at the next launch too (release 8c plan,
// Task 9).
export function launchAnswers(): Answers {
  const answers = new Map<string, Answer>();
  return {
    get: (name, entry) => {
      const answer = answers.get(name);
      return answer?.entry === entry ? answer.yes : undefined;
    },
    set: (name, entry, yes) => void answers.set(name, { entry, yes }),
    reset: (name) => void answers.delete(name),
  };
}
