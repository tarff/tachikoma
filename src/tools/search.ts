import type { BigIntStats } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import ignore from "ignore";
import { z } from "zod";
import { dataDir } from "../core/datadir.js";
import { errorText } from "../core/types.js";
import { MAX_TOOL_OUTPUT } from "../exec/executor.js";
import { settingsDir } from "../settings.js";
import { programEnvironment, resolveIn, settingsName } from "./files.js";
import { defineTool, type ToolContext } from "./tool.js";

type Rules = { base: string; rules: ReturnType<typeof ignore> }[];

const posix = (p: string) => p.split(path.sep).join("/");

// The .gitignore in `folder`, read with the `ignore` library, which skips a line that does not parse
// as git does. No git is run: a repository's own settings can make git run programs. One that is a
// link is not followed, as git does not (gitignore(5), git 2.41), and one with more than one name is
// checked as read_file checks a path, since it may be a hard link to a file in the data folder.
async function rulesIn(folder: string): Promise<Rules> {
  const file = path.join(folder, ".gitignore");
  const kind = await lstat(file, { bigint: true }).catch(() => null);
  if (!kind?.isFile()) return [];
  if (kind.nlink > 1n) {
    try {
      resolveIn(folder, file);
    } catch {
      return [];
    }
  }
  const text = await readFile(file, "utf8").catch(() => null);
  return text === null ? [] : [{ base: folder, rules: ignore().add(text) }];
}

// A folder's own rules come after its parents', so its "!" can bring back what theirs left out.
function ignored(rules: Rules, abs: string, folder: boolean): boolean {
  let out = false;
  for (const r of rules) {
    const t = r.rules.test(posix(path.relative(r.base, abs)) + (folder ? "/" : ""));
    if (t.ignored) out = true;
    else if (t.unignored) out = false;
  }
  return out;
}

const same = (a: BigIntStats | null, b: BigIntStats | null) => a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
const id = (p: string) => stat(p, { bigint: true }).catch(() => null);

// Every file under `folder`, as git would list them: no `.git`, nothing the .gitignore files leave
// out (a folder they leave out is not looked inside, since git cannot bring back what is in it), and
// Tachikoma's data folder and settings files skipped. No link or junction is followed, so the walk
// cannot loop or be led out of the folder. A folder that cannot be read is skipped. `settings` is the
// settings folder, which is only looked up when a file has one of the settings files' names.
async function* walk(folder: string, rules: Rules, data: BigIntStats | null, settings: BigIntStats | null, signal?: AbortSignal): AsyncGenerator<string> {
  signal?.throwIfAborted();
  const here = [...rules, ...(await rulesIn(folder))];
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const abs = path.join(folder, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (e.name === ".git" || ignored(here, abs, true) || same(await id(abs), data)) continue;
      yield* walk(abs, here, data, settings, signal);
    } else if (e.isFile() && !ignored(here, abs, false) && !(settingsName(e.name) && same(await id(folder), settings))) yield abs;
  }
}

// The files under `start`, a folder or one file, with the project's .gitignore rules from the root
// down when it is inside the project. The start is checked as read_file checks a path: refused in the
// data folder, and outside the project only once the user allows it.
async function* files(start: string, ctx: ToolContext, verb: string): AsyncGenerator<string> {
  const { abs, outside, shown } = resolveIn(ctx.root, start);
  await ctx.gate.require({ kind: "read", outside, summary: `${verb} ${shown}` });
  const real = await realpath(abs);
  // The rules of each folder above the start, from the project root down; the walk reads the start's own.
  const rules: Rules = [];
  if (!outside) {
    let folder = await realpath(ctx.root);
    for (const part of path.relative(folder, real).split(path.sep).filter(Boolean)) {
      rules.push(...(await rulesIn(folder)));
      folder = path.join(folder, part);
    }
  }
  if ((await stat(real)).isFile()) {
    if (!ignored(rules, real, false)) yield real;
    return;
  }
  yield* walk(real, rules, await id(dataDir()), await id(settingsDir()), ctx.signal);
}

// Lines up to the size every tool's output is cut at, leaving room for the note of how many more;
// `beyond` counts more that were never collected.
function capped(lines: string[], noun: string, beyond = 0): string {
  const note = (n: number) => `(${n} more ${noun} not shown)`;
  const room = MAX_TOOL_OUTPUT - note(lines.length + beyond).length - 1;
  let size = 0;
  let n = 0;
  while (n < lines.length && size + lines[n]!.length + 1 <= room) size += lines[n++]!.length + 1;
  return n === lines.length && !beyond ? lines.join("\n") : [...lines.slice(0, n), note(lines.length - n + beyond)].join("\n");
}

// Paths inside the project are shown relative to it, with forward slashes, as the model gives them to
// read_file; others in full.
const shownPath = (base: string, real: string) => {
  const rel = path.relative(base, real);
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) ? real : posix(rel);
};

export const findFilesTool = defineTool(
  "find_files",
  "Find files by path, with a pattern such as src/**/*.ts (** for any depth of folders, * for any part of a name). Paths are relative to the project root. As in a shell, a name starting with a dot matches only a pattern that names the dot, such as .github/**. Skips .git and what the .gitignore files list. Sorted by path.",
  z.object({ pattern: z.string().min(1) }),
  async ({ pattern }, ctx) => {
    const glob = pattern.replaceAll("\\", "/"); // the model may write Windows paths
    const base = await realpath(ctx.root);
    const found: string[] = [];
    for await (const f of files(".", ctx, "list")) {
      const rel = shownPath(base, f);
      if (path.posix.matchesGlob(rel, glob)) found.push(rel);
    }
    if (!found.length) return `No files match ${pattern}`;
    return capped(found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), "files");
  },
);

// git's test for a binary file: a zero byte in the first 8,000 (`buffer_is_binary`, xdiff-interface.c).
const BINARY_TEST_BYTES = 8000;
// A matching line is cut at 1,000 characters, so one minified line cannot fill the output. Measured
// 2026-10-26: 0.13% of the lines in this project's installed packages and 0.015% of Python's library
// are longer, most of them source maps; this project's own longest is 404.
const LINE_CUT = 1000;

// The search itself, in a worker thread: a regular expression can take practically forever on some
// text, and only a thread can be stopped in the middle of one. Plain JavaScript, so it works the same
// from the built files and in the tests; it takes Node's modules with process.getBuiltinModule, which
// works whether Node runs it as a script or as a module. It collects lines, each cut at `lineCut`
// characters, up to the output cap, and counts the rest.
const GREP = String.raw`
const { parentPort, workerData } = process.getBuiltinModule("node:worker_threads");
const { readFileSync } = process.getBuiltinModule("node:fs");
const { pattern, files, cap, binaryBytes, lineCut } = workerData;
const regex = new RegExp(pattern);
const lines = [];
let size = 0;
let beyond = 0;
for (const f of files) {
  let buf;
  try {
    buf = readFileSync(f.abs);
  } catch {
    continue;
  }
  if (buf.subarray(0, binaryBytes).includes(0)) continue;
  buf.toString("utf8").split(/\r?\n/).forEach((text, i) => {
    if (!regex.test(text)) return;
    const shown = text.length > lineCut ? text.slice(0, lineCut) + " [cut: " + (text.length - lineCut) + " more characters]" : text;
    const line = f.shown + ":" + (i + 1) + ": " + shown;
    if (!beyond && size + line.length + 1 <= cap) {
      lines.push(line);
      size += line.length + 1;
    } else beyond++;
  });
}
parentPort.postMessage({ lines, beyond });
`;

function grep(pattern: string, files: { abs: string; shown: string }[], signal?: AbortSignal): Promise<{ lines: string[]; beyond: number }> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new Worker(GREP, { eval: true, workerData: { pattern, files, cap: MAX_TOOL_OUTPUT, binaryBytes: BINARY_TEST_BYTES, lineCut: LINE_CUT } });
    const stop = () => {
      void worker.terminate();
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", stop, { once: true });
    worker.once("message", (found) => {
      signal?.removeEventListener("abort", stop);
      resolve(found);
    });
    worker.once("error", (err) => {
      signal?.removeEventListener("abort", stop);
      reject(err);
    });
  });
}

export const searchFilesTool = defineTool(
  "search_files",
  "Search file contents with a regular expression (JavaScript syntax), giving path:line: text for each matching line. path narrows the search to a folder or one file (the project by default); glob narrows it by name, as in *.ts, or by path when it has a slash. Skips binary files, .git and what the .gitignore files list.",
  z.object({ pattern: z.string().min(1), path: z.string().optional(), glob: z.string().optional() }),
  async ({ pattern, path: start = ".", glob }, ctx) => {
    try {
      new RegExp(pattern);
    } catch (err) {
      // The models' commonest slip in the live run: a flag inside the pattern, as other engines allow.
      const flag = /^\(\?[a-z]+\)/i.exec(pattern);
      const hint = flag ? `. JavaScript has no flags inside a pattern, such as ${flag[0]}; search_files matches case exactly, so give both cases where it matters, as in [Mm]ax` : "";
      throw new Error(`${pattern} is not a regular expression: ${errorText(err)}${hint}`);
    }
    const name = glob?.replaceAll("\\", "/");
    const base = await realpath(ctx.root);
    const found: { abs: string; shown: string }[] = [];
    for await (const f of files(start, ctx, "search")) {
      const shown = shownPath(base, f);
      if (name && !path.posix.matchesGlob(name.includes("/") ? shown : path.basename(f), name)) continue;
      if (programEnvironment(f)) continue;
      // A hard link can be another name for a file in the data folder, which the walk, going by folders,
      // cannot see. So a file with more than one name is checked as read_file checks a path. Only those:
      // the check took about 1.5 ms a file on Windows (measured 2026-10-26).
      if (((await id(f))?.nlink ?? 0n) > 1n) {
        try {
          resolveIn(ctx.root, f);
        } catch {
          continue;
        }
      }
      found.push({ abs: f, shown });
    }
    const { lines, beyond } = await grep(pattern, found, ctx.signal);
    if (!lines.length) return `No lines match ${pattern}`;
    return capped(lines, "matching lines", beyond);
  },
);
