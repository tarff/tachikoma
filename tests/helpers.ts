import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";
import { Bus, type ErrorEvent } from "../src/core/bus.js";
import { type Mode, PermissionGate } from "../src/core/permissions.js";
import type { CompletionRequest, Message, Part, Provider, Turn, Usage } from "../src/core/types.js";
import type { ExecResult, Running } from "../src/exec/executor.js";
import { LocalExecutor, LocalWorkspace } from "../src/exec/local.js";
import { CommandLog } from "../src/exec/log.js";
import type { Workspace } from "../src/exec/workspace.js";
import type { ToolContext } from "../src/tools/tool.js";

// An animated GIF of two frames, white then black, made in memory: two frames the same would be stored as one. sharp is
// loaded only here, so the test files that never make a picture do not pay for it.
export async function twoFrameGif(width = 4, height = 4): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  const frames = Buffer.alloc(width * height * 2 * 3);
  frames.fill(255, 0, width * height * 3);
  return sharp(frames, { raw: { width, height: height * 2, channels: 3, pageHeight: height } }).gif().toBuffer();
}

export const usage: Usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
export const reply = (text: string): Turn => ({ parts: [{ type: "text", text }], usage });
export const callTool = (id: string, name: string, input: unknown): Turn => ({ parts: [{ type: "tool_call", id, name, input }], usage });

// Replays scripted turns and records what it was sent.
export class FakeProvider implements Provider {
  readonly id: string;
  readonly seen: Message[][] = [];
  constructor(
    name: string,
    private readonly turns: (Turn | Error)[],
  ) {
    this.id = `fake:${name}`;
  }
  async complete(req: CompletionRequest): Promise<Turn> {
    this.seen.push(structuredClone(req.messages));
    const next = this.turns.shift();
    if (!next) throw new Error("FakeProvider ran out of turns");
    if (next instanceof Error) throw next;
    return next;
  }
}

// A provider whose every request waits until the test answers it, or until it is stopped.
export class Held implements Provider {
  readonly asked: CompletionRequest[] = [];
  #pending: ((t: Turn) => void)[] = [];
  constructor(readonly id = "fake:held") {}
  complete(req: CompletionRequest): Promise<Turn> {
    this.asked.push(structuredClone({ ...req, signal: undefined, shrunk: undefined, leftOut: undefined })); // neither can be cloned
    return new Promise((resolve, reject) => {
      this.#pending.push(resolve);
      req.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  }
  // Answers the oldest request still waiting.
  answer(turn: Turn | string) {
    this.#pending.shift()!(typeof turn === "string" ? reply(turn) : turn);
  }
}

export function collectErrors(bus: Bus): ErrorEvent[] {
  const errors: ErrorEvent[] = [];
  bus.on("error", (e) => errors.push(e));
  return errors;
}

export async function tempContext(mode: Mode = "never", answers: boolean[] = []): Promise<ToolContext & { asked: string[]; details: (string | undefined)[] }> {
  const root = await mkdtemp(path.join(tmpdir(), "tachi-"));
  const asked: string[] = [];
  const details: (string | undefined)[] = [];
  const gate = new PermissionGate(mode, async (summary, detail) => {
    asked.push(summary);
    details.push(detail);
    return answers.shift() ?? false;
  });
  return { root, executor: new LocalExecutor(), workspace: new LocalWorkspace(root), gate, asked, details };
}

// A Workspace that keeps each call, as its name and what it was given, and answers from `files`, a made-up project's
// files by absolute path, so a caller given it is seen reaching the Workspace and never the disk (release 7 plan, Task
// 14). A path leaving `root` is outside; find and search give one canned answer each.
export function fakeWorkspace(root: string, files: Record<string, string> = {}) {
  const calls: string[] = [];
  const file = (abs: string) => {
    const f = files[abs];
    if (f === undefined) throw new Error(`${abs} is not in the fake workspace`);
    return f;
  };
  const workspace: Workspace = {
    root,
    resolve: async (p) => {
      calls.push(`resolve ${p}`);
      const abs = path.resolve(root, p);
      return { abs, outside: path.relative(root, abs).startsWith(".."), shown: abs };
    },
    readText: async (abs) => (calls.push(`readText ${abs}`), file(abs)),
    writeText: async (abs, content) => void (calls.push(`writeText ${abs}`), (files[abs] = content)),
    find: async (start, pattern) => (calls.push(`find ${start} ${pattern}`), ["made/up.ts"]),
    search: async (start, pattern, glob) => {
      calls.push(`search ${start} ${pattern} ${glob}`);
      return { matches: [{ file: "made/up.ts", line: 1, text: "made up" }], beyond: 0 };
    },
    branch: async () => (calls.push("branch"), "made-up-branch"),
  };
  return { workspace, calls, files };
}

// What a stand-in executor's start gives, since the shell tool runs every command through start (background commands
// plan, Task 5): it ends as `done` does, and a stop ends it at once as killed, as the executors' stop does (choice 1).
export function standInRun(done: Promise<ExecResult>): Running {
  let stop = () => {};
  const killed = new Promise<ExecResult>((resolve) => (stop = () => resolve({ code: null, signal: "SIGKILL", stdout: "", stderr: "" })));
  return { log: new CommandLog(), done: Promise.race([done, killed]), stop };
}

export const texts = (m: Message) => m.parts.flatMap((p: Part) => (p.type === "text" ? [p.text] : []));
export { Bus };

// The short (8.3) name Windows gave `name` in `folder`, such as SETTIN~1.JSO, as `dir /x` lists it.
// Undefined on other systems, and on a volume that makes none.
export function shortName(folder: string, name: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  const listing = execFileSync("cmd", ["/c", "dir", "/x", "/a", folder], { encoding: "utf8" });
  return new RegExp(`(\\S+~\\d+\\S*) +${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im").exec(listing)?.[1];
}

// A stand-in editor (release 6 plan, Task 12): a small Node script, so no test ever opens a real editor. It is
// written in a fresh temporary folder whose name has a space, as the path to this repo has, so the shell's quoting is
// tried, and the folder is removed when the test finishes. `command(mode)` is the editor's command; the file comes
// after it. Each run records the file it was given and that file's text in given.json, then, by mode: `keep` writes
// next.txt into the file when there is one; `wait` does the same, marks `started`, and waits until `go` is written or
// its folder is gone; `fail` exits 1; `line` writes the first line it reads from its own stdin into the file.
export function standInEditor() {
  const dir = mkdtempSync(path.join(tmpdir(), "tachi editor "));
  const at = (name: string) => path.join(dir, name);
  writeFileSync(at("editor.cjs"), STAND_IN);
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    command: (mode: "keep" | "wait" | "fail" | "line") => `"${process.execPath}" "${at("editor.cjs")}" ${mode}`,
    next: (text: string) => writeFileSync(at("next.txt"), text),
    given: (): { file: string; text: string } | null => (existsSync(at("given.json")) ? JSON.parse(readFileSync(at("given.json"), "utf8")) : null),
    started: () => existsSync(at("started")),
    go: () => writeFileSync(at("go"), ""),
  };
}
const STAND_IN = String.raw`const fs = require("node:fs");
const path = require("node:path");
const [mode, file] = process.argv.slice(2);
const at = (name) => path.join(__dirname, name);
fs.writeFileSync(at("given.json"), JSON.stringify({ file, text: fs.readFileSync(file, "utf8") }));
if (mode === "fail") process.exit(1);
if (mode === "line") {
  let read = "";
  process.stdin.setEncoding("utf8").on("data", (d) => {
    read += d;
    if (!read.includes("\n")) return;
    fs.writeFileSync(file, read.slice(0, read.indexOf("\n")));
    process.exit(0);
  });
} else {
  if (fs.existsSync(at("next.txt"))) fs.writeFileSync(file, fs.readFileSync(at("next.txt"), "utf8"));
  if (mode === "wait") {
    fs.writeFileSync(at("started"), "");
    const poll = () => !fs.existsSync(at("go")) && fs.existsSync(__dirname) && setTimeout(poll, 20);
    poll();
  }
}
`;

// Removes a folder the test made: a link or junction is removed itself, never followed.
export async function removeTree(folder: string): Promise<void> {
  for (const e of await readdir(folder, { withFileTypes: true })) {
    const p = path.join(folder, e.name);
    if (e.isDirectory() && !e.isSymbolicLink()) await removeTree(p);
    else await unlink(p);
  }
  await rmdir(folder);
}

export const ZERO = String.fromCharCode(0);
// The sandbox's test project (tests/sandbox): .gitignore files at two levels (one bringing back with "!"), CRLF and
// non-ASCII text, a binary file and a repository's HEAD.
export const TREE: Record<string, string> = {
  ".gitignore": "build/\n*.log\n!keep.log\n",
  "src/a.ts": "const a = 1;\nexport { a };\n",
  "src/b.ts": "line one\r\nmatch here\r\n",
  "src/core/c.ts": "match again\n",
  "src/.gitignore": "secret.ts\n",
  "src/secret.ts": "match hidden\n",
  "build/out.js": "match built\n",
  "x.log": "match log\n",
  "keep.log": "match kept\n",
  "notes/caf\u00e9.txt": "caf\u00e9 match\n",
  "bin.dat": `match${ZERO}binary\n`,
  ".git/HEAD": "ref: refs/heads/feature/x\n",
  ".git/config": "match in git\n",
};
