import type { BigIntStats } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";
import { z } from "zod";
import { dataDir } from "../core/datadir.js";
import { MAX_TOOL_OUTPUT } from "../exec/executor.js";
import { resolveIn } from "./files.js";
import { defineTool, type ToolContext } from "./tool.js";

type Rules = { base: string; rules: ReturnType<typeof ignore> }[];

const posix = (p: string) => p.split(path.sep).join("/");

// The .gitignore in `folder`, read with the `ignore` library, which skips a line that does not parse
// as git does. No git is run: a repository's own settings can make git run programs.
async function rulesIn(folder: string): Promise<Rules> {
  const text = await readFile(path.join(folder, ".gitignore"), "utf8").catch(() => null);
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
// Tachikoma's data folder skipped. No link or junction is followed, so the walk cannot loop or be led
// out of the folder. A folder that cannot be read is skipped.
async function* walk(folder: string, rules: Rules, data: BigIntStats | null, signal?: AbortSignal): AsyncGenerator<string> {
  signal?.throwIfAborted();
  const here = [...rules, ...(await rulesIn(folder))];
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const abs = path.join(folder, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (e.name === ".git" || ignored(here, abs, true) || same(await id(abs), data)) continue;
      yield* walk(abs, here, data, signal);
    } else if (e.isFile() && !ignored(here, abs, false)) yield abs;
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
  yield* walk(real, rules, await id(dataDir()), ctx.signal);
}

// Lines up to the size every tool's output is cut at, leaving room for the note of how many more.
function capped(lines: string[], noun: string): string {
  const note = (n: number) => `(${n} more ${noun} not shown)`;
  const room = MAX_TOOL_OUTPUT - note(lines.length).length - 1;
  let size = 0;
  let n = 0;
  while (n < lines.length && size + lines[n]!.length + 1 <= room) size += lines[n++]!.length + 1;
  return n === lines.length ? lines.join("\n") : [...lines.slice(0, n), note(lines.length - n)].join("\n");
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
