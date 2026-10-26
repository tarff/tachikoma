# Tachikoma Release 4 (subagents, the to-do list and instruction files): Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** The lead can hand searching and reading to subagents, which run beside it or in the
background and show in a panel under the prompt; two search tools, `find_files` and
`search_files`; a to-do list the lead keeps on screen; and the user's and the project's
instruction files (CLAUDE.md, AGENTS.md) read into each session.

**Architecture:** Each subagent is its own `Session`, the class the lead runs in, with three
read-only tools and a short prompt of its own. `src/core/tasks.ts` starts them, at most
`--max-tasks` at once, keeps each one's state and spend, and keeps finished background answers for
the lead, which the session takes into its next request (`inbox`). The lead's `delegate` tool asks
the task manager for one. The search tools (`src/tools/search.ts`) walk the folder themselves,
reading `.gitignore` with the `ignore` library, and run a search's regular expression in a worker
thread that Esc ends. `src/core/instructions.ts` finds and reads the instruction files once, at the
start, for the system prompt. Questions from the lead and every subagent wait in one line, each with
its owner. The screen gains `TodoList`, `TaskPanel` and a `tasks` part in the status line.
Design: `docs/plans/2026-10-25-tachikoma-release-4-design.md`.

**Tech stack:** as release 3 (TypeScript 7.0.2, Ink 7.1.1, React 19.3.0, zod 4.6.5, Vitest 5.0.3,
ink-testing-library, string-width 8.3.0), plus `ignore` 7.0.12 (Task 1). Node 22.20 or later,
up from 22 (Task 1; choice 1).

---

## Before you start

**This plan's code has already been run, one task at a time.** On 2026-10-26 every task below was
built in a scratch copy of the repo, in order, one commit per task, each task's tests written and
seen failing before its code. Every code block was then copied by script from those commits, not
retyped. Each task's counts below come from typechecking and running the whole suite at its commit,
one task at a time. After Task 14:
Test Files 1 failed | 38 passed | 2 skipped (41); Tests 1 failed | 660 passed | 10 skipped (671).
The tests left out are release 3's seven (the live checks, which run only with `TACHI_LIVE=1`, and
on Windows the macOS/Linux file-mode tests and, without Developer Mode, the link test), and three of
Task 5's: two that need file links, which Windows allows only with Developer Mode, and one that runs
only on Linux (a program's environment, `/proc/<process>/environ`).

**Bugs found while building, each fixed with a test that failed first:**
- `search_files`' worker thread could not start when Node ran with `--input-type=module`: its code
  used `require`, which that flag takes away. It now loads Node's modules with
  `process.getBuiltinModule` (Task 2).
- Clearing finished subagents from the panel at the start of a turn announced a change, which
  started the next queued prompt before the turn was marked as running. The clear now comes after
  (Task 11).

**Found by a code review (2026-10-26), each fixed in its task with a test that failed first:**
- `search_files` read a hard link to a file in the data folder, which `read_file` refuses: the walk
  goes by folders, and a hard link is another name for a file in an ordinary one. A file with more
  than one name is now checked as `read_file` checks a path (Task 2).
- A matching line too long for the output on its own was dropped, and the tool said "No lines
  match". Each matching line is now cut at 1,000 characters, saying how many more it had (Task 2).
- Declining a file outside the project could drop a project file it imported. With `CLAUDE.md`
  importing `x.md` from outside, and `x.md` importing the project's `AGENTS.md`, declining `x.md`
  left out `AGENTS.md` too: it counted as read already. Each file now goes in at its first place
  that is allowed (Task 5).
- Quitting with Ctrl-C or Ctrl-D twice left background subagents running, and spending, after the
  screen closed; only `/exit` stopped them. The screen now stops them however it closes (Task 11).

No other review has been run.

**The machine was busy** while these ran. Tests that start PowerShell (private files, the
keychain, signing in) then sometimes run past Vitest's 5 s limit, so each task was run alone. No
task had a full run with no time-out. Every task had release 2's "keeps each data folder's key
apart" (`tests/auth/keychain.test.ts`) run past it, at 5.0 to 6.2 s, which took 5.0 to 8.5 s in
release 3's runs too. Tasks 2, 4, 8 and 9 also had one to three more, at 5.0 to 5.2 s, in the same
file, `tests/auth/private.test.ts`, `tests/auth/access.test.ts`, `tests/auth/chatgpt.test.ts` and
`tests/tui/history.test.ts`.
The counts below are the full runs', and each file with a time-out passed when run again alone at
that task's commit. Release 4 changes no sign-in code or sign-in tests.

**Not run yet:** release 4 in your own terminal (the checklist after Task 14), and on macOS and
Linux.

**Choices this plan makes that the design leaves open.** Each is marked in its task. The user
approved them all on 2026-10-26.
1. **Task 1, `find_files`:**
   - Node 22.20 becomes the minimum: the matching uses Node's own `path.matchesGlob`, stable from
     22.20 and 24.8 (Node's path docs, read 2026-10-26).
   - A name starting with a dot matches only a pattern that names the dot, as in a shell:
     `**/*.yml` misses `.github/workflows/ci.yml`. The tool's description says so.
   - A backslash in a pattern is read as a slash, so `src\*.ts` works on Windows.
   - A folder that cannot be read is skipped.
   - Only `.gitignore` files are read, not `.git/info/exclude` or git's global ignore file (that
     needs `.git/config`, which the model can write in `project` mode).
2. **Task 2, `search_files`:**
   - The pattern is a JavaScript regular expression and matches case exactly.
   - Matches come in path order, then line order.
   - A file is binary when its first 8,000 bytes hold a zero byte, git's test.
   - `glob` matches the file's name, or its path when the glob has a slash in it.
   - A matching line is cut at 1,000 characters, ending "[cut: N more characters]", as the
     session's own cut ends.
3. **Task 3:** the `todo` tool answers "Saved 3 items, 2 not done".
4. **Task 4, the to-do list on screen:**
   - The item in progress is yellow, done ones grey.
   - Short of rows, the list centres on the item in progress; with one row, that item alone.
   - It gets rows after the prompt and before the queue, so it gives way before the prompt does.
5. **Task 5, instruction files:**
   - Each file goes in as `<file path="...">`, its text, then `</file>`, under a note saying they
     come from the user's and the project's files and that later, more specific ones win.
   - A found file's folder is the folder the walk found it in, so `CLAUDE.md` linked to the
     `AGENTS.md` beside it is not asked about.
   - A file with a zero byte in it is left out as "not text".
6. **Task 6, the start:**
   - The question about files outside the project takes one key before the screen starts: `y`
     reads them, any other key leaves them out, Ctrl-C quits.
   - The start line: "Instructions: ~/.claude/CLAUDE.md, ~/proj/AGENTS.md (4.3k bytes); left out:
     /elsewhere/x.md (not allowed)", with `~` for the home folder.
   - `TACHI_INSTRUCTIONS_TOP` moves where the walk starts, so the CLI's tests never read your
     files.
   - The CLI checks that it has a terminal before reading the files, so a run that will fail does
     not ask first.
7. **Task 7, questions:** a question taken away because its owner stopped is logged grey as
   "cancelled".
8. **Task 8, waiting answers** also go after a prompt the user typed, not only after tool results.
9. **Task 9, the task manager:**
   - An answer reaches the lead as "Background task t1 (find the login code) finished:" and the
     answer, cut at the size every tool's output is cut at.
   - A subagent stopped with the turn says "t1 was stopped."; a background one the user stopped
     says "… was stopped by the user before it finished." and does not wake the lead.
   - A subagent whose last reply has no text answers "it ended without an answer", as a failure.
10. **Task 10:** a failed subagent comes back to the lead as the plain answer "t1 failed: …", not
    as a tool error, so the error is logged once, as the subagent's.
11. **Task 11:** the grey "t1 finished" lines are shown for background subagents only; a waited-on
    one's answer is the `delegate` call's result.
12. **Task 12, the panel:**
    - It hides while a question or the model list is open.
    - It takes rows before the prompt's other rows.
    - A waiting row is grey and says "waiting".
    - A task is shown by its first line only.
    - The model is shown without its provider (`claude-haiku-5-5`, not
      `anthropic:claude-haiku-5-5`).
13. **Task 13:** `/tasks` typed during a turn waits in the queue, as `/model` does.

**Different from the design** (the release 4 design's "As built"):
- **The search tools read the disk directly,** as `resolveIn` already does, not through the
  executor, which has no way to list a folder. The sandbox (release 6) must give them one.
- **The question about files outside the project comes before the screen starts:** the files go
  into the system prompt, which is fixed before the first turn.

**Numbers in the code, and where each came from:**

| Value | Source |
|---|---|
| `--max-tasks` defaults to 8 | The user's probe, 2026-10-26: 8 subagents at once on `anthropic:claude-haiku-5-5`, none refused; the most tried, not a limit found (release 4 design, "Before the build") |
| Imports go 4 levels deep | Claude Code's docs: "a maximum depth of four hops" (memory.md, read 2026-10-25) |
| A file is binary with a zero byte in its first 8,000 | git's `buffer_is_binary` (xdiff-interface.c) |
| Node 22.20 or later | Node's path docs: `path.matchesGlob` stable from 22.20 and 24.8 (read 2026-10-26) |
| The panel's times redraw once a second while only subagents run | They are shown in whole seconds |
| A matching line is cut at 1,000 characters | Measured 2026-10-26 (`scratchpad/cutlen/measure.py`): 0.13% of the 1.5 million lines in the installed packages and 0.015% of the 17 million in Python's library are longer, 74-81% of the packages' ones in source maps; in files with no line over 1,000, 99.99% are under 902 and 574; this project's longest line is 404. At 1,000, at least 29 matches fit in the output |
| `search_files` checks only files with more than one name as `read_file` does | Measured 2026-10-26, a search of this repo's 108 files: 43 ms without the check, 206 ms with it on every file (about 1.5 ms a file), 62 ms with it on those files only |
| The endless-pattern test: `(a+)+$` on 40 letters and a `b`, stopped after 300 ms, done within 5 s | Measured 2026-10-26: 28 letters took 20 s, each letter more about doubling it; 5 s is Vitest's own limit |
| 15 s for the test that starts Node with `--input-type=module` | Each start took about a second; 15 s, as for the other tests that start processes (`tests/cli.test.ts`) |

**Sources:** Claude Code's and Codex's instruction files, Anthropic's guidance on text added in a
turn, and the `ignore` library, as listed in the release 4 design. Node's `path.matchesGlob` from
Node's path docs (read 2026-10-26). The probes' results from the user's terminal (2026-10-26).

**Known limits of release 4:**
- **Two instruction-file tests need file links,** which Windows allows only with Developer Mode,
  and one needs Linux: they have not run on this machine.
- **The search tools bypass the executor**, so the sandbox (release 6) must give them a way in.
- **Subagents only read;** ones that edit, and CLI workers, come in release 10 (the design's "Not in
  this release").

## Tasks

### Task 1: find_files lists the project's files by pattern, skipping what .gitignore lists

`src/tools/search.ts` (release 4 design, "The search tools"; choice 1). `find_files(pattern)` gives
the files whose path matches a pattern such as `src/**/*.ts`, sorted by path.
- **The walk** reads each folder's `.gitignore` with the `ignore` library, a folder's rules after
  its parents', and skips `.git`. It follows no links or junctions, so it cannot loop or be led out
  of the folder, and skips Tachikoma's data folder by its device and file number, so a link or a
  different spelling cannot reach it either.
- **Matching** is Node's `path.posix.matchesGlob` on the path relative to the project, with
  slashes.
- **The same guards as `read_file`:** a path outside the project asks; the data folder is refused.
- **Output** is cut at the size every tool's output is cut at, ending "(N more files not shown)".
  `capped(lines, noun, beyond)` does the cutting, for Task 2 as well.

The lead gets the tool, and the screen shows a call by its pattern.

**Files:**
- Modify: `package-lock.json`
- Modify: `package.json`
- Modify: `src/tools/index.ts`
- Create: `src/tools/search.ts`
- Modify: `src/tui/describe.ts`
- Create: `tests/tools/search.test.ts`

**Step 1: Add the `ignore` library and raise the Node version**

Every install goes through `sfw` (Socket Firewall). If `sfw` is not on your PATH, stop and get it
first; do not install without it.

```bash
sfw npm install --save-exact ignore@7.0.12
```

Then, in `package.json`, change `"engines": { "node": ">=22" }` to
`"engines": { "node": ">=22.20" }` (choice 1). `package-lock.json` changes with the install.

**Step 2: Write the failing tests**

**Create `tests/tools/search.test.ts`:**

```ts
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TOOL_OUTPUT } from "../../src/exec/executor.js";
import { TOOLS } from "../../src/tools/index.js";
import { findFilesTool } from "../../src/tools/search.js";
import { brief } from "../../src/tui/describe.js";
import { tempContext } from "../helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

// Writes each file, making its folders, under `root`.
async function files(root: string, tree: Record<string, string>) {
  for (const [p, text] of Object.entries(tree)) {
    await mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await writeFile(path.join(root, p), text);
  }
}

describe("find_files", () => {
  it("lists the files whose path matches, sorted, with forward slashes", async () => {
    const ctx = await tempContext();
    await files(ctx.root, { "src/b.ts": "", "src/a.ts": "", "src/core/c.ts": "", "src/d.js": "", "e.ts": "" });
    expect(await findFilesTool.run({ pattern: "src/**/*.ts" }, ctx)).toBe("src/a.ts\nsrc/b.ts\nsrc/core/c.ts");
    expect(await findFilesTool.run({ pattern: "*.ts" }, ctx)).toBe("e.ts");
    expect(await findFilesTool.run({ pattern: "**/*.ts" }, ctx)).toBe("e.ts\nsrc/a.ts\nsrc/b.ts\nsrc/core/c.ts");
  });

  it("takes a pattern written with backslashes", async () => {
    const ctx = await tempContext();
    await files(ctx.root, { "src/core/c.ts": "" });
    expect(await findFilesTool.run({ pattern: "src\\**\\*.ts" }, ctx)).toBe("src/core/c.ts");
  });

  it("matches a name starting with a dot only when the pattern names the dot, as a shell does", async () => {
    const ctx = await tempContext();
    await files(ctx.root, { ".github/workflows/ci.yml": "", "a.yml": "" });
    expect(await findFilesTool.run({ pattern: "**/*.yml" }, ctx)).toBe("a.yml");
    expect(await findFilesTool.run({ pattern: ".github/**/*.yml" }, ctx)).toBe(".github/workflows/ci.yml");
  });

  it("says when nothing matches", async () => {
    const ctx = await tempContext();
    await files(ctx.root, { "a.ts": "" });
    expect(await findFilesTool.run({ pattern: "**/*.py" }, ctx)).toBe("No files match **/*.py");
  });

  it("skips .git and what the .gitignore files list, a folder's own rules over its parents'", async () => {
    const ctx = await tempContext();
    await files(ctx.root, {
      ".git/config": "",
      ".gitignore": "*.log\nbuild/\n",
      "a.log": "",
      "a.txt": "",
      "build/out.txt": "",
      "sub/.gitignore": "!keep.log\nsecret.txt\n",
      "sub/keep.log": "",
      "sub/drop.log": "",
      "sub/secret.txt": "",
      "sub/fine.txt": "",
    });
    expect(await findFilesTool.run({ pattern: "**/*" }, ctx)).toBe(["a.txt", "sub/fine.txt", "sub/keep.log"].join("\n"));
  });

  it("does not look inside a folder the rules leave out, as git does not", async () => {
    // git cannot bring back a file whose folder is ignored, so neither does the walk.
    const ctx = await tempContext();
    await files(ctx.root, { ".gitignore": "node_modules/\n!node_modules/x/keep.ts\n", "node_modules/x/keep.ts": "", "a.ts": "" });
    expect(await findFilesTool.run({ pattern: "**/*.ts" }, ctx)).toBe("a.ts");
  });

  it("ignores a .gitignore line that does not parse, as git does", async () => {
    const ctx = await tempContext();
    await files(ctx.root, { ".gitignore": "[\n*.log\n", "a.log": "", "[": "", "b.txt": "" });
    expect(await findFilesTool.run({ pattern: "**/*" }, ctx)).toBe(["[", "b.txt"].join("\n"));
  });

  it("follows no links or junctions", async () => {
    const ctx = await tempContext();
    const elsewhere = await mkdtemp(path.join(tmpdir(), "tachi-outside-"));
    await files(elsewhere, { "far.ts": "" });
    await files(ctx.root, { "near.ts": "" });
    // A junction needs no special rights on Windows; on other systems this makes a directory symlink.
    await symlink(elsewhere, path.join(ctx.root, "linked"), "junction");
    await symlink(ctx.root, path.join(ctx.root, "loop"), "junction");
    expect(await findFilesTool.run({ pattern: "**/*.ts" }, ctx)).toBe("near.ts");
  });

  it("skips Tachikoma's data folder inside the project", async () => {
    const ctx = await tempContext();
    await files(ctx.root, { "data/chatgpt.json": "{}", "a.json": "" });
    vi.stubEnv("TACHI_DATA_DIR", path.join(ctx.root, "data"));
    expect(await findFilesTool.run({ pattern: "**/*.json" }, ctx)).toBe("a.json");
  });

  it("refuses a project inside the data folder", async () => {
    const ctx = await tempContext();
    vi.stubEnv("TACHI_DATA_DIR", ctx.root);
    await expect(findFilesTool.run({ pattern: "**/*" }, ctx)).rejects.toThrow("Tachikoma's data folder");
  });

  it("cuts a long list and says how many more there were", async () => {
    const ctx = await tempContext();
    const name = (n: number) => `${String(n).padStart(3, "0")}${"x".repeat(140)}.txt`;
    await files(ctx.root, Object.fromEntries(Array.from({ length: 250 }, (_, n) => [name(n), ""])));
    const out = await findFilesTool.run({ pattern: "*.txt" }, ctx);
    expect(out.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT);
    const shown = out.split("\n").slice(0, -1);
    expect(shown[0]).toBe(name(0));
    expect(out.split("\n").at(-1)).toBe(`(${250 - shown.length} more files not shown)`);
  });

  it("stops when the turn is stopped", async () => {
    const ctx = await tempContext();
    await files(ctx.root, { "a.ts": "" });
    const stop = new AbortController();
    stop.abort();
    await expect(findFilesTool.run({ pattern: "**/*" }, { ...ctx, signal: stop.signal })).rejects.toThrow();
  });
});

describe("the lead's tools", () => {
  it("include find_files, shown on screen by its pattern", () => {
    expect(TOOLS.map((t) => t.spec.name)).toContain("find_files");
    expect(brief("find_files", { pattern: "src/**/*.ts" })).toBe("src/**/*.ts");
  });
});
```


**Step 3: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/tools/search.test.ts`

Expected: FAIL. In the scratch build: Test Files 1 failed (1), before any test runs. `src/tools/search.ts` does not exist yet.

**Step 4: Write the code**

**Change `src/tools/index.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tools/index.ts b/src/tools/index.ts
index 80e1a39..bb5ed37 100644
--- a/src/tools/index.ts
+++ b/src/tools/index.ts
@@ -1,5 +1,6 @@
 import { editFileTool, readFileTool, writeFileTool } from "./files.js";
+import { findFilesTool } from "./search.js";
 import { shellTool } from "./shell.js";
 import type { Tool } from "./tool.js";
 
-export const TOOLS: Tool[] = [readFileTool, writeFileTool, editFileTool, shellTool];
+export const TOOLS: Tool[] = [readFileTool, writeFileTool, editFileTool, shellTool, findFilesTool];
```

**Create `src/tools/search.ts`:**

```ts
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
```

**Change `src/tui/describe.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/describe.ts b/src/tui/describe.ts
index ceaff85..5c2b3eb 100644
--- a/src/tui/describe.ts
+++ b/src/tui/describe.ts
@@ -10,8 +10,9 @@ export interface Line {
 const firstLine = (s: string) => s.split(/\r?\n/)[0] ?? "";
 
 // A call's main detail (release 3 design, "On screen"): the path for the file tools, the command's
-// first line for shell; null for a tool without its own summary, which is shown with its whole input.
-const DETAIL: Record<string, string> = { read_file: "path", write_file: "path", edit_file: "path", shell: "command" };
+// first line for shell, the pattern for the search tools; null for a tool without its own summary,
+// which is shown with its whole input.
+const DETAIL: Record<string, string> = { read_file: "path", write_file: "path", edit_file: "path", shell: "command", find_files: "pattern" };
 export function brief(name: string, input: unknown): string | null {
   const value = Object.hasOwn(DETAIL, name) && typeof input === "object" && input !== null ? (input as Record<string, unknown>)[DETAIL[name]!] : undefined;
   return typeof value === "string" ? firstLine(value) : null;
```


**Step 5: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 1 failed | 34 passed | 2 skipped (37); Tests 1 failed | 565 passed | 7 skipped (573).

**Step 6: Commit**

```bash
git add package-lock.json package.json src/tools/index.ts src/tools/search.ts src/tui/describe.ts tests/tools/search.test.ts
git commit -m "feat: find_files lists the project's files by pattern, skipping what .gitignore lists"
```

### Task 2: search_files searches file contents, in a worker thread Esc can stop

`search_files(pattern, path, glob)` in `src/tools/search.ts` (release 4 design, "The search
tools"; choice 2): a regular expression over file contents, giving `path:line: text` lines. `path`
narrows it to a folder or one file; `glob` by name, as in `*.ts`, or by path when it has a slash.
- **It walks as `find_files` does,** with the same skips and guards.
- **A file with more than one name is checked as `read_file` checks a path:** a hard link can be
  another name for a file in the data folder, which the walk, going by folders, cannot see. Only
  those files: the check took about 1.5 ms a file on Windows.
- **Binary files are skipped:** a zero byte in the first 8,000 bytes, git's test.
- **The search runs in a worker thread,** so a pattern that would take practically forever ends
  when the turn is stopped: Esc terminates the worker. The worker's code is a string run with
  `eval: true`, and loads Node's modules with `process.getBuiltinModule`, which works whether Node
  runs it as a module or not. A test starts Node with `--input-type=module` to check that; with
  `require` it failed.
- **A matching line is cut at 1,000 characters,** ending "[cut: N more characters]", so one
  minified line cannot fill the output.
- "No lines match X" when nothing does; "X is not a regular expression" for a bad pattern.

**Files:**
- Modify: `src/tools/index.ts`
- Modify: `src/tools/search.ts`
- Modify: `src/tui/describe.ts`
- Modify: `tests/tools/search.test.ts`

**Step 1: Write the failing tests**

**Change `tests/tools/search.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tools/search.test.ts b/tests/tools/search.test.ts
index b6e8caa..8a14670 100644
--- a/tests/tools/search.test.ts
+++ b/tests/tools/search.test.ts
@@ -1,10 +1,13 @@
-import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
+import { spawnSync } from "node:child_process";
+import { linkSync } from "node:fs";
+import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
 import { tmpdir } from "node:os";
 import path from "node:path";
+import { pathToFileURL } from "node:url";
 import { afterEach, describe, expect, it, vi } from "vitest";
 import { MAX_TOOL_OUTPUT } from "../../src/exec/executor.js";
 import { TOOLS } from "../../src/tools/index.js";
-import { findFilesTool } from "../../src/tools/search.js";
+import { findFilesTool, searchFilesTool } from "../../src/tools/search.js";
 import { brief } from "../../src/tui/describe.js";
 import { tempContext } from "../helpers.js";
 
@@ -122,9 +125,118 @@ describe("find_files", () => {
   });
 });
 
+describe("search_files", () => {
+  it("gives each matching line as path:line: text, in path order", async () => {
+    const ctx = await tempContext();
+    await files(ctx.root, { "src/b.ts": "one\nlogin()\n", "src/a.ts": "login\r\nother\r\nre-login\r\n", "c.md": "nothing" });
+    expect(await searchFilesTool.run({ pattern: "log+in" }, ctx)).toBe("src/a.ts:1: login\nsrc/a.ts:3: re-login\nsrc/b.ts:2: login()");
+  });
+
+  it("narrows to a folder or one file with path, and by name with glob", async () => {
+    const ctx = await tempContext();
+    await files(ctx.root, { "src/a.ts": "x", "src/a.js": "x", "lib/b.ts": "x", "src/deep/c.ts": "x" });
+    expect(await searchFilesTool.run({ pattern: "x", path: "src" }, ctx)).toBe("src/a.js:1: x\nsrc/a.ts:1: x\nsrc/deep/c.ts:1: x");
+    expect(await searchFilesTool.run({ pattern: "x", path: "src/a.ts" }, ctx)).toBe("src/a.ts:1: x");
+    expect(await searchFilesTool.run({ pattern: "x", glob: "*.ts" }, ctx)).toBe("lib/b.ts:1: x\nsrc/a.ts:1: x\nsrc/deep/c.ts:1: x");
+    // A glob with a slash in it is matched against the path.
+    expect(await searchFilesTool.run({ pattern: "x", glob: "src/*.ts" }, ctx)).toBe("src/a.ts:1: x");
+  });
+
+  it("keeps the project's .gitignore rules when narrowed to a folder or a file", async () => {
+    const ctx = await tempContext();
+    await files(ctx.root, { ".gitignore": "*.gen.ts\n", "src/a.ts": "x", "src/a.gen.ts": "x" });
+    expect(await searchFilesTool.run({ pattern: "x", path: "src" }, ctx)).toBe("src/a.ts:1: x");
+    expect(await searchFilesTool.run({ pattern: "x", path: "src/a.gen.ts" }, ctx)).toBe("No lines match x");
+  });
+
+  it("skips binary files", async () => {
+    const ctx = await tempContext();
+    await files(ctx.root, { "a.txt": "needle" });
+    await writeFile(path.join(ctx.root, "b.bin"), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]));
+    expect(await searchFilesTool.run({ pattern: "needle" }, ctx)).toBe("a.txt:1: needle");
+  });
+
+  it("asks before searching outside the project", async () => {
+    const ctx = await tempContext("project", [false, true]);
+    const elsewhere = await mkdtemp(path.join(tmpdir(), "tachi-outside-"));
+    await files(elsewhere, { "notes.txt": "secret" });
+    await expect(searchFilesTool.run({ pattern: "secret", path: elsewhere }, ctx)).rejects.toThrow("The user declined");
+    expect(await searchFilesTool.run({ pattern: "secret", path: elsewhere }, ctx)).toBe(`${path.join(await realpath(elsewhere), "notes.txt")}:1: secret`);
+    expect(ctx.asked).toEqual([`search ${path.resolve(elsewhere)}`, `search ${path.resolve(elsewhere)}`]);
+  });
+
+  it("refuses the data folder in every mode", async () => {
+    const ctx = await tempContext("never");
+    await files(ctx.root, { "data/chatgpt.json": "token" });
+    vi.stubEnv("TACHI_DATA_DIR", path.join(ctx.root, "data"));
+    await expect(searchFilesTool.run({ pattern: "token", path: "data" }, ctx)).rejects.toThrow("Tachikoma's data folder");
+    expect(await searchFilesTool.run({ pattern: "token" }, ctx)).toBe("No lines match token");
+  });
+
+  it("skips a hard link to one of the data folder's files, as read_file refuses it", async () => {
+    const ctx = await tempContext();
+    await files(ctx.root, { "data/chatgpt.json": "token", "a.txt": "token" });
+    vi.stubEnv("TACHI_DATA_DIR", path.join(ctx.root, "data"));
+    linkSync(path.join(ctx.root, "data", "chatgpt.json"), path.join(ctx.root, "innocent.json"));
+    expect(await searchFilesTool.run({ pattern: "token" }, ctx)).toBe("a.txt:1: token");
+  });
+
+  it("says when the pattern is not a regular expression", async () => {
+    const ctx = await tempContext();
+    await expect(searchFilesTool.run({ pattern: "a(" }, ctx)).rejects.toThrow("a( is not a regular expression");
+  });
+
+  it("cuts long output and says how many more lines there were", async () => {
+    const ctx = await tempContext();
+    await files(ctx.root, { "a.txt": Array.from({ length: 2000 }, (_, n) => `match ${n} ${"y".repeat(20)}`).join("\n") });
+    const out = await searchFilesTool.run({ pattern: "match" }, ctx);
+    expect(out.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT);
+    const shown = out.split("\n").slice(0, -1);
+    expect(shown[0]).toBe(`a.txt:1: match 0 ${"y".repeat(20)}`);
+    expect(out.split("\n").at(-1)).toBe(`(${2000 - shown.length} more matching lines not shown)`);
+  });
+
+  it("cuts a matching line at 1,000 characters, saying how many more it had", async () => {
+    const ctx = await tempContext();
+    const long = `match ${"y".repeat(MAX_TOOL_OUTPUT)}`;
+    const whole = `match ${"z".repeat(994)}`; // 1,000 characters
+    await files(ctx.root, { "a.txt": long, "b.txt": whole });
+    const cut = `${long.slice(0, 1000)} [cut: ${long.length - 1000} more characters]`;
+    expect(await searchFilesTool.run({ pattern: "match" }, ctx)).toBe(`a.txt:1: ${cut}\nb.txt:1: ${whole}`);
+  });
+
+  it("works when Node runs the worker's code as a module, as a flag such as --input-type=module makes it", { timeout: 15_000 }, async () => {
+    // The worker inherits the flags Node started with. Each start takes about a second; 15 s, as for
+    // the other tests that start processes (tests/cli.test.ts).
+    const ctx = await tempContext();
+    await files(ctx.root, { "a.txt": "needle" });
+    const url = (p: string) => JSON.stringify(pathToFileURL(path.resolve(p)).href);
+    const script = [
+      `import { searchFilesTool } from ${url("src/tools/search.ts")};`,
+      `import { PermissionGate } from ${url("src/core/permissions.ts")};`,
+      `console.log(await searchFilesTool.run({ pattern: "needle" }, { root: process.argv[1], gate: new PermissionGate("project", async () => false) }));`,
+    ].join("\n");
+    const r = spawnSync(process.execPath, ["--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href, "--input-type=module", "-e", script, ctx.root], { encoding: "utf8" });
+    expect(r.stderr).toBe("");
+    expect(r.stdout.trim()).toBe("a.txt:1: needle");
+  });
+
+  it("stops a pattern that would take practically forever when the turn is stopped", async () => {
+    // (a+)+$ on 28 letters and a b took 20 s on 2026-10-26; each letter more about doubles it.
+    const ctx = await tempContext();
+    await files(ctx.root, { "a.txt": `${"a".repeat(40)}b` });
+    const stop = new AbortController();
+    const started = Date.now();
+    setTimeout(() => stop.abort(), 300);
+    await expect(searchFilesTool.run({ pattern: "(a+)+$" }, { ...ctx, signal: stop.signal })).rejects.toThrow();
+    expect(Date.now() - started).toBeLessThan(5000);
+  });
+});
+
 describe("the lead's tools", () => {
-  it("include find_files, shown on screen by its pattern", () => {
-    expect(TOOLS.map((t) => t.spec.name)).toContain("find_files");
+  it("include the search tools, shown on screen by their pattern", () => {
+    expect(TOOLS.map((t) => t.spec.name)).toEqual(expect.arrayContaining(["find_files", "search_files"]));
     expect(brief("find_files", { pattern: "src/**/*.ts" })).toBe("src/**/*.ts");
+    expect(brief("search_files", { pattern: "log+in", path: "src" })).toBe("log+in");
   });
 });
```


**Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/tools/search.test.ts`

Expected: FAIL. In the scratch build: Test Files 1 failed (1); Tests 13 failed | 12 passed (25). `search_files` does not exist yet.

**Step 3: Write the code**

**Change `src/tools/index.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tools/index.ts b/src/tools/index.ts
index bb5ed37..3b84683 100644
--- a/src/tools/index.ts
+++ b/src/tools/index.ts
@@ -1,6 +1,6 @@
 import { editFileTool, readFileTool, writeFileTool } from "./files.js";
-import { findFilesTool } from "./search.js";
+import { findFilesTool, searchFilesTool } from "./search.js";
 import { shellTool } from "./shell.js";
 import type { Tool } from "./tool.js";
 
-export const TOOLS: Tool[] = [readFileTool, writeFileTool, editFileTool, shellTool, findFilesTool];
+export const TOOLS: Tool[] = [readFileTool, writeFileTool, editFileTool, shellTool, findFilesTool, searchFilesTool];
```

**Change `src/tools/search.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tools/search.ts b/src/tools/search.ts
index f95c837..ce5aece 100644
--- a/src/tools/search.ts
+++ b/src/tools/search.ts
@@ -1,11 +1,12 @@
 import type { BigIntStats } from "node:fs";
 import { readdir, readFile, realpath, stat } from "node:fs/promises";
 import path from "node:path";
+import { Worker } from "node:worker_threads";
 import ignore from "ignore";
 import { z } from "zod";
 import { dataDir } from "../core/datadir.js";
 import { MAX_TOOL_OUTPUT } from "../exec/executor.js";
-import { resolveIn } from "./files.js";
+import { programEnvironment, resolveIn } from "./files.js";
 import { defineTool, type ToolContext } from "./tool.js";
 
 type Rules = { base: string; rules: ReturnType<typeof ignore> }[];
@@ -74,14 +75,15 @@ async function* files(start: string, ctx: ToolContext, verb: string): AsyncGener
   yield* walk(real, rules, await id(dataDir()), ctx.signal);
 }
 
-// Lines up to the size every tool's output is cut at, leaving room for the note of how many more.
-function capped(lines: string[], noun: string): string {
+// Lines up to the size every tool's output is cut at, leaving room for the note of how many more;
+// `beyond` counts more that were never collected.
+function capped(lines: string[], noun: string, beyond = 0): string {
   const note = (n: number) => `(${n} more ${noun} not shown)`;
-  const room = MAX_TOOL_OUTPUT - note(lines.length).length - 1;
+  const room = MAX_TOOL_OUTPUT - note(lines.length + beyond).length - 1;
   let size = 0;
   let n = 0;
   while (n < lines.length && size + lines[n]!.length + 1 <= room) size += lines[n++]!.length + 1;
-  return n === lines.length ? lines.join("\n") : [...lines.slice(0, n), note(lines.length - n)].join("\n");
+  return n === lines.length && !beyond ? lines.join("\n") : [...lines.slice(0, n), note(lines.length - n + beyond)].join("\n");
 }
 
 // Paths inside the project are shown relative to it, with forward slashes, as the model gives them to
@@ -107,3 +109,99 @@ export const findFilesTool = defineTool(
     return capped(found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), "files");
   },
 );
+
+// git's test for a binary file: a zero byte in the first 8,000 (`buffer_is_binary`, xdiff-interface.c).
+const BINARY_TEST_BYTES = 8000;
+// A matching line is cut at 1,000 characters, so one minified line cannot fill the output. Measured
+// 2026-10-26: 0.13% of the lines in this project's installed packages and 0.015% of Python's library
+// are longer, most of them source maps; this project's own longest is 404.
+const LINE_CUT = 1000;
+
+// The search itself, in a worker thread: a regular expression can take practically forever on some
+// text, and only a thread can be stopped in the middle of one. Plain JavaScript, so it works the same
+// from the built files and in the tests; it takes Node's modules with process.getBuiltinModule, which
+// works whether Node runs it as a script or as a module. It collects lines, each cut at `lineCut`
+// characters, up to the output cap, and counts the rest.
+const GREP = String.raw`
+const { parentPort, workerData } = process.getBuiltinModule("node:worker_threads");
+const { readFileSync } = process.getBuiltinModule("node:fs");
+const { pattern, files, cap, binaryBytes, lineCut } = workerData;
+const regex = new RegExp(pattern);
+const lines = [];
+let size = 0;
+let beyond = 0;
+for (const f of files) {
+  let buf;
+  try {
+    buf = readFileSync(f.abs);
+  } catch {
+    continue;
+  }
+  if (buf.subarray(0, binaryBytes).includes(0)) continue;
+  buf.toString("utf8").split(/\r?\n/).forEach((text, i) => {
+    if (!regex.test(text)) return;
+    const shown = text.length > lineCut ? text.slice(0, lineCut) + " [cut: " + (text.length - lineCut) + " more characters]" : text;
+    const line = f.shown + ":" + (i + 1) + ": " + shown;
+    if (!beyond && size + line.length + 1 <= cap) {
+      lines.push(line);
+      size += line.length + 1;
+    } else beyond++;
+  });
+}
+parentPort.postMessage({ lines, beyond });
+`;
+
+function grep(pattern: string, files: { abs: string; shown: string }[], signal?: AbortSignal): Promise<{ lines: string[]; beyond: number }> {
+  return new Promise((resolve, reject) => {
+    signal?.throwIfAborted();
+    const worker = new Worker(GREP, { eval: true, workerData: { pattern, files, cap: MAX_TOOL_OUTPUT, binaryBytes: BINARY_TEST_BYTES, lineCut: LINE_CUT } });
+    const stop = () => {
+      void worker.terminate();
+      reject(signal!.reason);
+    };
+    signal?.addEventListener("abort", stop, { once: true });
+    worker.once("message", (found) => {
+      signal?.removeEventListener("abort", stop);
+      resolve(found);
+    });
+    worker.once("error", (err) => {
+      signal?.removeEventListener("abort", stop);
+      reject(err);
+    });
+  });
+}
+
+export const searchFilesTool = defineTool(
+  "search_files",
+  "Search file contents with a regular expression (JavaScript syntax), giving path:line: text for each matching line. path narrows the search to a folder or one file (the project by default); glob narrows it by name, as in *.ts, or by path when it has a slash. Skips binary files, .git and what the .gitignore files list.",
+  z.object({ pattern: z.string().min(1), path: z.string().optional(), glob: z.string().optional() }),
+  async ({ pattern, path: start = ".", glob }, ctx) => {
+    try {
+      new RegExp(pattern);
+    } catch {
+      throw new Error(`${pattern} is not a regular expression`);
+    }
+    const name = glob?.replaceAll("\\", "/");
+    const base = await realpath(ctx.root);
+    const found: { abs: string; shown: string }[] = [];
+    for await (const f of files(start, ctx, "search")) {
+      const shown = shownPath(base, f);
+      if (name && !path.posix.matchesGlob(name.includes("/") ? shown : path.basename(f), name)) continue;
+      if (programEnvironment(f)) continue;
+      // A hard link can be another name for a file in the data folder, which the walk, going by folders,
+      // cannot see. So a file with more than one name is checked as read_file checks a path. Only those:
+      // the check took about 1.5 ms a file on Windows (measured 2026-10-26).
+      if (((await id(f))?.nlink ?? 0n) > 1n) {
+        try {
+          resolveIn(ctx.root, f);
+        } catch {
+          continue;
+        }
+      }
+      found.push({ abs: f, shown });
+    }
+    const { lines, beyond } = await grep(pattern, found, ctx.signal);
+    if (!lines.length) return `No lines match ${pattern}`;
+    return capped(lines, "matching lines", beyond);
+  },
+);
```

**Change `src/tui/describe.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/describe.ts b/src/tui/describe.ts
index 5c2b3eb..9784c2f 100644
--- a/src/tui/describe.ts
+++ b/src/tui/describe.ts
@@ -12,7 +12,7 @@ const firstLine = (s: string) => s.split(/\r?\n/)[0] ?? "";
 // A call's main detail (release 3 design, "On screen"): the path for the file tools, the command's
 // first line for shell, the pattern for the search tools; null for a tool without its own summary,
 // which is shown with its whole input.
-const DETAIL: Record<string, string> = { read_file: "path", write_file: "path", edit_file: "path", shell: "command", find_files: "pattern" };
+const DETAIL: Record<string, string> = { read_file: "path", write_file: "path", edit_file: "path", shell: "command", find_files: "pattern", search_files: "pattern" };
 export function brief(name: string, input: unknown): string | null {
   const value = Object.hasOwn(DETAIL, name) && typeof input === "object" && input !== null ? (input as Record<string, unknown>)[DETAIL[name]!] : undefined;
   return typeof value === "string" ? firstLine(value) : null;
```


**Step 4: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 1 failed | 34 passed | 2 skipped (37); Tests 2 failed | 576 passed | 7 skipped (585).

**Step 5: Commit**

```bash
git add src/tools/index.ts src/tools/search.ts src/tui/describe.ts tests/tools/search.test.ts
git commit -m "feat: search_files searches file contents, in a worker thread Esc can stop"
```

### Task 3: The lead's todo tool keeps a to-do list for the screen

`src/tools/todo.ts` (release 4 design, "The to-do list"; choice 3). `todo(items)` takes the whole
list each time, as Claude Code's `TodoWrite` does, each item its text and one of `pending`,
`in_progress` and `done`. A new list replaces the old one. The description asks for one item in
progress at a time; nothing enforces it.

`todoTool(show)` hands each list to `show`; the CLI sends it on the bus as a `todo` event, for
Task 4's screen. Only the lead has the tool. A call shows on screen as "3 items", since the list
itself is on screen.

**Files:**
- Modify: `src/cli.tsx`
- Modify: `src/core/bus.ts`
- Create: `src/tools/todo.ts`
- Modify: `src/tui/describe.ts`
- Create: `tests/tools/todo.test.ts`

**Step 1: Write the failing tests**

**Create `tests/tools/todo.test.ts`:**

```ts
import { describe, expect, it } from "vitest";
import type { TodoItem } from "../../src/tools/todo.js";
import { todoTool } from "../../src/tools/todo.js";
import { brief } from "../../src/tui/describe.js";
import { tempContext } from "../helpers.js";

describe("todo", () => {
  it("hands the whole list on each time and says what it saved", async () => {
    const lists: TodoItem[][] = [];
    const tool = todoTool((items) => lists.push(items));
    const ctx = await tempContext();
    const items: TodoItem[] = [
      { text: "read the login code", status: "done" },
      { text: "find where the token is saved", status: "in_progress" },
      { text: "write the fix", status: "pending" },
    ];
    expect(await tool.run({ items }, ctx)).toBe("Saved 3 items, 2 not done");
    expect(await tool.run({ items: [] }, ctx)).toBe("Saved 0 items, 0 not done");
    expect(lists).toEqual([items, []]);
  });

  it("takes only pending, in_progress and done", async () => {
    const tool = todoTool(() => {});
    await expect(tool.run({ items: [{ text: "x", status: "started" }] }, await tempContext())).rejects.toThrow("Invalid input for todo");
  });

  it("is shown on screen by how many items it has", () => {
    expect(brief("todo", { items: [{ text: "a", status: "done" }, { text: "b", status: "pending" }] })).toBe("2 items");
    expect(brief("todo", { items: [{ text: "a", status: "done" }] })).toBe("1 item");
  });
});
```


**Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/tools/todo.test.ts`

Expected: FAIL. In the scratch build: Test Files 1 failed (1), before any test runs. `src/tools/todo.ts` does not exist yet.

**Step 3: Write the code**

**Change `src/cli.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/cli.tsx b/src/cli.tsx
index 1265db1..de48652 100644
--- a/src/cli.tsx
+++ b/src/cli.tsx
@@ -18,6 +18,7 @@ import { EFFORTS, type Effort } from "./providers/anthropic.js";
 import { listModels } from "./providers/models.js";
 import { createProvider } from "./providers/registry.js";
 import { TOOLS } from "./tools/index.js";
+import { todoTool } from "./tools/todo.js";
 import { App } from "./tui/App.js";
 import { gitBranch } from "./tui/git.js";
 import { historyFile } from "./tui/history.js";
@@ -144,7 +145,9 @@ let ask: (summary: string, detail?: string) => Promise<boolean> = async (summary
   return false;
 };
 const gate = new PermissionGate(mode, (summary, detail) => ask(summary, detail), parsed.print === undefined ? undefined : "Not allowed in -p mode, where nobody can approve it");
-const session = new Session({ lead, fallback, tools: TOOLS, system: systemPrompt(root), ctx: { root, executor: new LocalExecutor(), gate }, bus });
+// The to-do list is the lead's alone; the screen shows it from the bus.
+const tools = [...TOOLS, todoTool((items) => bus.emit("todo", items))];
+const session = new Session({ lead, fallback, tools, system: systemPrompt(root), ctx: { root, executor: new LocalExecutor(), gate }, bus });
 
 // The executor stops running commands from an "exit" handler, which dying by a signal skips.
 for (const sig of ["SIGTERM", "SIGHUP"] as const) process.on(sig, () => process.exit(128 + constants.signals[sig]));
```

**Change `src/core/bus.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/core/bus.ts b/src/core/bus.ts
index b621e2a..04d930d 100644
--- a/src/core/bus.ts
+++ b/src/core/bus.ts
@@ -1,4 +1,5 @@
 import { EventEmitter } from "node:events";
+import type { TodoItem } from "../tools/todo.js";
 import type { Message, Usage } from "./types.js";
 
 export interface ErrorEvent {
@@ -20,6 +21,7 @@ export interface Events {
   // Each call the session takes up, as it runs; its result reaches the conversation with the others.
   "tool-start": [{ id: string; name: string; input: unknown }];
   "tool-end": [{ id: string; outcome: ToolOutcome }];
+  todo: [TodoItem[]]; // the lead's new to-do list
 }
 
 // The session emits; the interface, status line, headless output and error log listen.
```

**Create `src/tools/todo.ts`:**

```ts
import { z } from "zod";
import { defineTool, type Tool } from "./tool.js";

const STATUSES = ["pending", "in_progress", "done"] as const;
export type TodoStatus = (typeof STATUSES)[number];
export interface TodoItem {
  text: string;
  status: TodoStatus;
}

// The lead's to-do list (release 4 design, "The to-do list"): the whole list each time, as Claude
// Code's TodoWrite takes it, so a new list replaces the old one. `show` puts it on screen. One item in
// progress at a time is asked for, not enforced.
export function todoTool(show: (items: TodoItem[]) => void): Tool {
  return defineTool(
    "todo",
    "Keep a to-do list the user sees, for work with several steps. Send the whole list each time; it replaces the last one. Keep one item in_progress at a time, and mark each done as soon as it is.",
    z.object({ items: z.array(z.object({ text: z.string().min(1), status: z.enum(STATUSES) })) }),
    async ({ items }) => {
      show(items);
      return `Saved ${items.length} items, ${items.filter((i) => i.status !== "done").length} not done`;
    },
  );
}
```

**Change `src/tui/describe.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/describe.ts b/src/tui/describe.ts
index 9784c2f..475ba83 100644
--- a/src/tui/describe.ts
+++ b/src/tui/describe.ts
@@ -14,6 +14,8 @@ const firstLine = (s: string) => s.split(/\r?\n/)[0] ?? "";
 // which is shown with its whole input.
 const DETAIL: Record<string, string> = { read_file: "path", write_file: "path", edit_file: "path", shell: "command", find_files: "pattern", search_files: "pattern" };
 export function brief(name: string, input: unknown): string | null {
+  const items = name === "todo" && typeof input === "object" && input !== null ? (input as { items?: unknown }).items : undefined;
+  if (Array.isArray(items)) return `${items.length} item${items.length === 1 ? "" : "s"}`; // the list itself is on screen
   const value = Object.hasOwn(DETAIL, name) && typeof input === "object" && input !== null ? (input as Record<string, unknown>)[DETAIL[name]!] : undefined;
   return typeof value === "string" ? firstLine(value) : null;
 }
```


**Step 4: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 1 failed | 35 passed | 2 skipped (38); Tests 1 failed | 580 passed | 7 skipped (588).

**Step 5: Commit**

```bash
git add src/cli.tsx src/core/bus.ts src/tools/todo.ts src/tui/describe.ts tests/tools/todo.test.ts
git commit -m "feat: the lead's todo tool keeps a to-do list for the screen"
```

### Task 4: The to-do list above the prompt, hidden and shown with Ctrl+T

`src/tui/TodoList.tsx` (release 4 design, "On screen"; choice 4). Under the working line and above
the queue and the prompt: `☐` to do, `◐` doing (yellow), `☑` done (grey).
- It shows while any item is unfinished and goes once all are done.
- **Ctrl+T** hides or shows it (it arrives as 0x14, which Ink reads as Ctrl+T: the user's probe,
  2026-10-26). Hidden lasts until Ctrl+T again or a new list.
- **Short of rows,** `todoRows(items, rows)` shows the item in progress and those next to it, then
  "+N more".
- The text is the model's, so it is cleaned with `visible()`.

The key list `?` prints gains "Ctrl+T  show or hide the to-do list".

**Files:**
- Modify: `src/tui/App.tsx`
- Create: `src/tui/TodoList.tsx`
- Modify: `src/tui/keys.ts`
- Modify: `tests/tui/app.test.tsx`
- Modify: `tests/tui/keys.test.ts`
- Modify: `tests/tui/lines.test.tsx`

**Step 1: Write the failing tests**

**Change `tests/tui/app.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/app.test.tsx b/tests/tui/app.test.tsx
index 28d3053..f629aa2 100644
--- a/tests/tui/app.test.tsx
+++ b/tests/tui/app.test.tsx
@@ -9,6 +9,7 @@ import { type Mode, PermissionGate } from "../../src/core/permissions.js";
 import { Session } from "../../src/core/session.js";
 import { Stats } from "../../src/core/stats.js";
 import type { Provider } from "../../src/core/types.js";
+import type { TodoItem } from "../../src/tools/todo.js";
 import { TOOLS } from "../../src/tools/index.js";
 import { History } from "../../src/tui/history.js";
 import type { ModelGroup } from "../../src/providers/models.js";
@@ -1043,6 +1044,57 @@ describe("App's space on screen", () => {
   });
 });
 
+describe("App's to-do list", () => {
+  const items: TodoItem[] = [
+    { text: "read the login code", status: "done" },
+    { text: "find where the token is saved", status: "in_progress" },
+    { text: "write the fix", status: "pending" },
+  ];
+
+  it("shows the lead's list above the prompt while any item is not done", async () => {
+    const { app, bus } = await mount([]);
+    bus.emit("todo", items);
+    await tick();
+    expect(app.lastFrame()).toContain("☑ read the login code\n◐ find where the token is saved\n☐ write the fix\n›");
+    bus.emit("todo", items.map((i) => ({ ...i, status: "done" as const })));
+    await tick();
+    expect(app.lastFrame()).not.toContain("☑");
+  });
+
+  it("hides and shows it on Ctrl+T, and shows a new list", async () => {
+    const { app, bus } = await mount([]);
+    bus.emit("todo", items);
+    await tick();
+    await press(app, "\u0014");
+    expect(app.lastFrame()).not.toContain("write the fix");
+    await press(app, "\u0014");
+    expect(app.lastFrame()).toContain("write the fix");
+    await press(app, "\u0014");
+    bus.emit("todo", [...items, { text: "test it", status: "pending" }]);
+    await tick();
+    expect(app.lastFrame()).toContain("☐ test it");
+  });
+
+  it("sits under the working line, above the queue, and gives way before the prompt", async () => {
+    const { app, bus } = await mount([], { lead: hanging(), rows: 10 });
+    await type(app, "one");
+    await until(app, "Esc to stop");
+    bus.emit("todo", [...items, { text: "test it", status: "pending" }]);
+    await press(app, "q1", "\r");
+    expect(app.lastFrame()).toMatch(/Esc to stop\n☑ read the login code\n◐ find where the token is saved\n☐ write the fix\n☐ test it\nq1\n›\n/);
+    await press(app, "a", "\n", "b", "\n", "c", "\n", "d"); // four rows for the prompt: two left for the list, none for the queue
+    expect(app.lastFrame()).toMatch(/Esc to stop\n◐ find where the token is saved\n\+3 more\n› a\n  b\n  c\n  d\n1 queued\n/);
+  });
+
+  it("escapes what the model wrote in it", async () => {
+    const { app, bus } = await mount([]);
+    bus.emit("todo", [{ text: `look ${OSC52}`, status: "pending" }]);
+    await tick();
+    expect(app.lastFrame()).toContain(`☐ look ${OSC52_SHOWN}`);
+    expectNoRawControls(app.lastFrame());
+  });
+});
+
 describe("App's menus", () => {
   it("lists the commands for / at the start of an empty prompt, narrowing as the command is typed", async () => {
     const { app } = await mount([]);
@@ -1125,6 +1177,7 @@ describe("App's keys for the modes, the model list and the last turn", () => {
     expect(app.lastFrame()).toContain("Keys:\n");
     expect(app.lastFrame()).toContain("Shift+Enter, \\ then Enter, or Ctrl+J  new line");
     expect(app.lastFrame()).toContain("Ctrl+O  the last turn's tool calls in full");
+    expect(app.lastFrame()).toContain("Ctrl+T  show or hide the to-do list");
     // Keys that work in Windows Terminal, where Ctrl+Backspace is Backspace and Ctrl+_ cannot be typed.
     expect(app.lastFrame()).toContain("Alt+Backspace  the word before");
     expect(app.lastFrame()).toContain("Ctrl+Z  undo");
```

**Change `tests/tui/keys.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/keys.test.ts b/tests/tui/keys.test.ts
index 2d00d2f..30f2ec9 100644
--- a/tests/tui/keys.test.ts
+++ b/tests/tui/keys.test.ts
@@ -54,6 +54,10 @@ describe("commands", () => {
     expect(commands("n", key({ ctrl: true }))).toEqual(["down"]);
   });
 
+  it("shows or hides the to-do list with Ctrl+T", () => {
+    expect(commands("t", key({ ctrl: true }))).toEqual(["todos"]);
+  });
+
   it("searches the history with Ctrl+R", () => {
     expect(commands("r", key({ ctrl: true }))).toEqual(["search"]);
   });
```

**Change `tests/tui/lines.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/lines.test.tsx b/tests/tui/lines.test.tsx
index ac66220..7f915d9 100644
--- a/tests/tui/lines.test.tsx
+++ b/tests/tui/lines.test.tsx
@@ -1,5 +1,7 @@
 import { describe, expect, it } from "vitest";
 import type { ToolOutcome } from "../../src/core/bus.js";
+import type { TodoItem } from "../../src/tools/todo.js";
+import { todoRows } from "../../src/tui/TodoList.js";
 import { toolParts } from "../../src/tui/ToolLine.js";
 import { workingText } from "../../src/tui/WorkingLine.js";
 
@@ -47,3 +49,33 @@ describe("toolParts", () => {
     expect(toolParts([])).toEqual([]);
   });
 });
+
+describe("todoRows", () => {
+  const list = (...statuses: TodoItem["status"][]): TodoItem[] => statuses.map((status, n) => ({ text: `item ${n}`, status }));
+  const shown = (items: TodoItem[], rows: number) => todoRows(items, rows).map((r) => `${r.mark} ${r.text}`.trim());
+
+  it("marks each item: to do, doing in yellow, done in grey", () => {
+    expect(todoRows(list("done", "in_progress", "pending"), 5)).toEqual([
+      { mark: "☑", text: "item 0", color: "gray" },
+      { mark: "◐", text: "item 1", color: "yellow" },
+      { mark: "☐", text: "item 2" },
+    ]);
+  });
+
+  it("when short of rows, shows the item in progress and those next to it, then how many more", () => {
+    const items = list("done", "done", "done", "in_progress", "pending", "pending", "pending");
+    expect(shown(items, 4)).toEqual(["☑ item 2", "◐ item 3", "☐ item 4", "+4 more"]);
+    expect(shown(items, 2)).toEqual(["◐ item 3", "+6 more"]);
+    expect(shown(items, 1)).toEqual(["◐ item 3"]);
+    expect(shown(items, 0)).toEqual([]);
+  });
+
+  it("with nothing in progress, centres on the first item not done; near an end, keeps the rows full", () => {
+    expect(shown(list("done", "pending", "pending", "pending", "pending"), 3)).toEqual(["☑ item 0", "☐ item 1", "+3 more"]);
+    expect(shown(list("done", "done", "done", "done", "in_progress"), 3)).toEqual(["☑ item 3", "◐ item 4", "+3 more"]);
+  });
+
+  it("escapes what the model wrote", () => {
+    expect(shown([{ text: "a\u001b[2Jb\rc", status: "pending" }], 1)).toEqual(["☐ a\\u001b[2Jb␍c"]);
+  });
+});
```


**Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/tui/app.test.tsx tests/tui/keys.test.ts tests/tui/lines.test.tsx`

Expected: FAIL. In the scratch build: Test Files 3 failed (3); Tests 6 failed | 104 passed (110). `src/tui/TodoList.tsx` does not exist yet, and Ctrl+T does nothing.

**Step 3: Write the code**

**Change `src/tui/App.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/App.tsx b/src/tui/App.tsx
index fc6ebeb..9c486b6 100644
--- a/src/tui/App.tsx
+++ b/src/tui/App.tsx
@@ -7,6 +7,7 @@ import type { Session } from "../core/session.js";
 import type { Stats } from "../core/stats.js";
 import { errorText, type Message, type Provider } from "../core/types.js";
 import type { ModelGroup } from "../providers/models.js";
+import type { TodoItem } from "../tools/todo.js";
 import { brief, describe, lastTurn, type Line, screen } from "./describe.js";
 import { apply, type Editor, empty, load, move, replace } from "./editor.js";
 import { History, matches } from "./history.js";
@@ -17,6 +18,7 @@ import { commandMenu, type Listing, listFolder, type Menu as MenuData, pathMenu
 import { ModelPicker } from "./ModelPicker.js";
 import { Prompt, promptWidth } from "./Prompt.js";
 import { type Segment, StatusLine } from "./StatusLine.js";
+import { TodoList, todoRows, unfinished } from "./TodoList.js";
 import { type Call, ToolLine } from "./ToolLine.js";
 import { SPIN_MS, WorkingLine } from "./WorkingLine.js";
 
@@ -75,6 +77,8 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
   // kept after it until the next turn starts.
   const doing = useRef<{ label: string; at: number; from: { output: number; cost: number; unpriced: number } | null }>({ label: "", at: 0, from: null });
   const calls = useRef<Call[]>([]);
+  // The lead's to-do list, and whether Ctrl+T has hidden it; a new list shows again.
+  const todos = useRef<{ items: TodoItem[]; hidden: boolean }>({ items: [], hidden: false });
   // Shift+Tab's modes: `never` only for a session started in it, so no key turns off the checks a
   // session started with.
   const perm = useRef(mode);
@@ -152,12 +156,17 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
       if (call) call.outcome = outcome;
       rerender((n) => n + 1);
     };
+    const onTodo = (items: TodoItem[]) => {
+      todos.current = { items, hidden: false };
+      rerender((n) => n + 1);
+    };
     bus.on("message", onMessage);
     bus.on("error", onError);
     bus.on("usage", onUsage);
     bus.on("lead", onLead);
     bus.on("tool-start", onToolStart);
     bus.on("tool-end", onToolEnd);
+    bus.on("todo", onTodo);
     history.current!.load();
     lookUpWindow();
     const minutes = setInterval(() => setNow(Date.now()), 60_000); // the status line counts the session in minutes
@@ -170,6 +179,7 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
       bus.off("lead", onLead);
       bus.off("tool-start", onToolStart);
       bus.off("tool-end", onToolEnd);
+      bus.off("todo", onTodo);
     };
   }, []);
 
@@ -343,6 +353,7 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
     // Alt+P is `/model` typed then: during a turn it waits in the queue.
     if (c === "models") return working.current ? void queue.current.push("/model") : void submit("/model");
     if (c === "lastTurn") return say(...lastTurn(session.messages));
+    if (c === "todos") return void (todos.current.hidden = !todos.current.hidden);
     // A message starting with `?` needs a space typed first.
     if (typeof c === "object" && c.type === "insert" && c.text === "?" && !e.text) return say(...KEY_LIST.map((text) => ({ text, color: "gray" })));
     if (c === "up" && !e.text && queue.current.length) return restore();
@@ -485,9 +496,10 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
   // at full height Ink draws the whole scrollback again each time. First the status line and the
   // working line; the tool line when there is room for it, the hint line and the cursor's row; the hint
   // line when there is room for it and the cursor's row; then an open menu, with the prompt cut to the
-  // cursor's row; then the prompt; then the queue, the last row saying how many more there are when
-  // they do not all fit. The model list fills the rows above the status line itself, so it has no
-  // tool line under it.
+  // cursor's row; then the prompt; then the to-do list, which gives way before the prompt does (release
+  // 4 design, "On screen"); then the queue, the last row saying how many more there are when they do
+  // not all fit. The model list fills the rows above the status line itself, so it has no tool line
+  // under it.
   const base = height - 1 - 1 - (busy ? 1 : 0);
   const tooled = !picker && segments.includes("tools") && calls.current.length > 0 && base >= 2 + (hintFor(1) !== null ? 1 : 0);
   const room = base - (tooled ? 1 : 0);
@@ -495,7 +507,9 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
   const space = Math.max(1, room - (hinted ? 1 : 0));
   const menuRows = menu ? Math.min(menu.entries.length, Math.max(1, space - 1)) : 0;
   const promptSpace = menu ? 1 : space;
-  const left = space - menuRows - Math.min(layout(prompt.text, promptWidth(columns)).rows.length, promptSpace);
+  const promptLeft = space - menuRows - Math.min(layout(prompt.text, promptWidth(columns)).rows.length, promptSpace);
+  const todoShown = !todos.current.hidden && unfinished(todos.current.items) ? todoRows(todos.current.items, promptLeft) : [];
+  const left = promptLeft - todoShown.length;
   const q = queue.current.map((e) => visible(e));
   const queued = q.length <= left ? q : left > 0 ? [...q.slice(0, left - 1), `+${q.length - left + 1} more`] : [];
   const hint = hinted ? hintFor(left) : null;
@@ -522,12 +536,13 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
               spend={doing.current.from && { lead: session.lead.id, output: stats.output - doing.current.from.output, cost: stats.cost - doing.current.from.cost, costUnknown: stats.unpriced > doing.current.from.unpriced }}
             />
           )}
+          <TodoList rows={todoShown} />
           {queued.map((row, i) => (
             <Text key={i} color="gray" wrap="truncate-end">
               {row}
             </Text>
           ))}
-          <Prompt editor={prompt} columns={columns} offset={(busy ? 1 : 0) + queued.length} space={promptSpace} />
+          <Prompt editor={prompt} columns={columns} offset={(busy ? 1 : 0) + todoShown.length + queued.length} space={promptSpace} />
           {menu && <Menu entries={menu.entries} chosen={chosenIn(prompt, menu)} rows={menuRows} />}
         </>
       )}
```

**Create `src/tui/TodoList.tsx`:**

```tsx
import { Text } from "ink";
import { visible } from "../core/permissions.js";
import type { TodoItem, TodoStatus } from "../tools/todo.js";

export interface TodoRow {
  mark: string;
  text: string;
  color?: "yellow" | "gray";
}

const MARKS: Record<TodoStatus, Omit<TodoRow, "text">> = {
  pending: { mark: "☐" },
  in_progress: { mark: "◐", color: "yellow" },
  done: { mark: "☑", color: "gray" },
};

// The list shows while any item is not done (release 4 design, "On screen").
export const unfinished = (items: TodoItem[]) => items.some((i) => i.status !== "done");

// The rows the list takes when it has `rows`: all of it when it fits. When not, the item in progress
// (or the first not done) and those next to it, then "+N more" in the last row. Items come from the
// model, so they are escaped.
export function todoRows(items: TodoItem[], rows: number): TodoRow[] {
  const row = (i: TodoItem): TodoRow => ({ ...MARKS[i.status], text: visible(i.text) });
  if (items.length <= rows) return items.map(row);
  if (rows <= 0) return [];
  const shown = Math.max(1, rows - 1);
  const doing = items.findIndex((i) => i.status === "in_progress");
  const at = Math.max(0, doing === -1 ? items.findIndex((i) => i.status !== "done") : doing);
  const start = Math.max(0, Math.min(at - Math.floor(shown / 2), items.length - shown));
  const more: TodoRow[] = rows > 1 ? [{ mark: "", text: `+${items.length - shown} more`, color: "gray" }] : [];
  return [...items.slice(start, start + shown).map(row), ...more];
}

export function TodoList({ rows }: { rows: TodoRow[] }) {
  return rows.map((r, i) => (
    <Text key={i} color={r.color} wrap="truncate-end">
      {r.mark ? `${r.mark} ${r.text}` : r.text}
    </Text>
  ));
}
```

**Change `src/tui/keys.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/keys.ts b/src/tui/keys.ts
index 14c4646..effaf40 100644
--- a/src/tui/keys.ts
+++ b/src/tui/keys.ts
@@ -4,12 +4,13 @@ import type { Action } from "./editor.js";
 // What a key means in the prompt (release 3 design, "Editing" and "Multi-line"), for the codes the
 // user's terminal was seen to send on 2026-10-25. Enter sends; Up and Down move by screen row, which
 // needs the screen's width, so App does them, and the rest of these App's own: Ctrl+R's search,
-// Shift+Tab's permission mode, Alt+P's model list and Ctrl+O's last turn ("Menus and modes").
-export type Command = Action | "submit" | "up" | "down" | "search" | "mode" | "models" | "lastTurn";
+// Shift+Tab's permission mode, Alt+P's model list and Ctrl+O's last turn ("Menus and modes"), and
+// Ctrl+T's to-do list (release 4 design, "On screen").
+export type Command = Action | "submit" | "up" | "down" | "search" | "mode" | "models" | "lastTurn" | "todos";
 
 // Ink names a key held with Ctrl or Alt by its letter.
 // Ctrl+P and Ctrl+N are Up and Down, as in Claude Code.
-const CTRL: Record<string, Command> = { a: "home", e: "end", d: "delete", w: "deleteToSpace", k: "deleteToEnd", u: "deleteToStart", y: "yank", z: "undo", p: "up", n: "down", r: "search", o: "lastTurn" };
+const CTRL: Record<string, Command> = { a: "home", e: "end", d: "delete", w: "deleteToSpace", k: "deleteToEnd", u: "deleteToStart", y: "yank", z: "undo", p: "up", n: "down", r: "search", o: "lastTurn", t: "todos" };
 const ALT: Record<string, Command> = { b: "wordLeft", f: "wordRight", d: "deleteWordAfter", p: "models" };
 
 // What `?` on an empty prompt prints, grey, in the scrollback.
@@ -25,6 +26,7 @@ export const KEY_LIST = [
   "  Ctrl+K  delete to the line's end · Ctrl+U  to its start · Ctrl+Y  put it back · Ctrl+Z  undo",
   "  /  commands · @  project paths · Shift+Tab  permission mode · Alt+P  pick the model",
   "  Ctrl+O  the last turn's tool calls in full · a space first starts a message with ?",
+  "  Ctrl+T  show or hide the to-do list",
 ];
 
 export function commands(input: string, key: Key): Command[] {
```


**Step 4: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 4 failed | 32 passed | 2 skipped (38); Tests 4 failed | 586 passed | 7 skipped (597).

**Step 5: Commit**

```bash
git add src/tui/App.tsx src/tui/TodoList.tsx src/tui/keys.ts tests/tui/app.test.tsx tests/tui/keys.test.ts tests/tui/lines.test.tsx
git commit -m "feat: the to-do list above the prompt, hidden and shown with Ctrl+T"
```

### Task 5: Read the user's and the project's CLAUDE.md and AGENTS.md, imports and all

`src/core/instructions.ts` (release 4 design, "Instruction files"; choice 5).
`readInstructions({ root, home, codexHome, top }, approve)` returns `{ text, read, left }`: the
text for the system prompt, the files read with their sizes, and the files left out with why.
- **Which, broadest first:** the user's `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` (or
  `CODEX_HOME`'s), then each folder from `top` (the top of the drive by default) down to the
  project: `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, then `AGENTS.md`. Empty files are
  skipped. Each file is read once, by its real path, and goes in once, at its first place that is
  allowed: a project file that a declined file imports still goes in where the walk found it.
- **`@path` imports** are expanded where they stand, up to four levels deep, relative to the file
  they are in; `~` and absolute paths work. Not inside code blocks or code spans. One that leads
  nowhere stays as text.
- **Asked first:** an import that leads outside the project, and a found file whose real path is
  outside the folder it was found in. All of them go to `approve` in one call, each with the file
  that found or imported it. The user's own files, and their imports, are trusted.
- **Never** Tachikoma's data folder or a program's environment, in any mode: the file tools'
  `resolveIn` refuses them. `files.ts` now exports `leaves`, which `resolveIn` uses, for this.

**Files:**
- Create: `src/core/instructions.ts`
- Modify: `src/tools/files.ts`
- Create: `tests/core/instructions.test.ts`

**Step 1: Write the failing tests**

**Create `tests/core/instructions.test.ts`:**

````ts
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTE, type Reached, readInstructions } from "../../src/core/instructions.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

// A pretend machine in a fresh temporary folder, so no test reads the user's own files: `top` stands
// for the top of the drive, `home` for the user's folder, and the project is top/work/proj.
async function machine(tree: Record<string, string> = {}) {
  const top = await mkdtemp(path.join(tmpdir(), "tachi-"));
  const at = (p: string) => path.join(top, ...p.split("/"));
  await mkdir(at("home"), { recursive: true });
  await mkdir(at("work/proj"), { recursive: true });
  for (const [p, body] of Object.entries(tree)) {
    await mkdir(path.dirname(at(p)), { recursive: true });
    await writeFile(at(p), body);
  }
  return { top, home: at("home"), root: at("work/proj"), at };
}
type Machine = Awaited<ReturnType<typeof machine>>;

// Asking fails the test unless the test gives its own answer.
const unasked = async (): Promise<boolean> => {
  throw new Error("asked");
};
const read = (m: Machine, approve: (r: Reached[]) => Promise<boolean> = unasked, codexHome?: string) =>
  readInstructions({ root: m.root, home: m.home, top: m.top, ...(codexHome ? { codexHome } : {}) }, approve);
const file = (p: string, body: string) => `<file path="${p}">\n${body}\n</file>`;

describe("readInstructions", () => {
  it("reads the user's files, then each folder's from the top down, both kinds, labelled with their paths", async () => {
    const m = await machine({
      "home/.claude/CLAUDE.md": "user claude",
      "codex/AGENTS.md": "user codex",
      "CLAUDE.md": "top",
      "work/AGENTS.md": "work agents",
      "work/proj/AGENTS.md": "proj agents",
      "work/proj/CLAUDE.local.md": "proj local",
      "work/proj/.claude/CLAUDE.md": "proj dot claude",
      "work/proj/CLAUDE.md": "proj claude",
    });
    const r = await read(m, unasked, m.at("codex"));
    const order = ["home/.claude/CLAUDE.md", "codex/AGENTS.md", "CLAUDE.md", "work/AGENTS.md", "work/proj/CLAUDE.md", "work/proj/.claude/CLAUDE.md", "work/proj/CLAUDE.local.md", "work/proj/AGENTS.md"];
    expect(r.read.map((f) => f.path)).toEqual(order.map(m.at));
    const bodies = ["user claude", "user codex", "top", "work agents", "proj claude", "proj dot claude", "proj local", "proj agents"];
    expect(r.text).toBe([NOTE, ...order.map((p, n) => file(m.at(p), bodies[n]!))].join("\n\n"));
    expect(r.read[0]!.size).toBe("user claude".length);
    expect(r.left).toEqual([]);
  });

  it("reads the user's Codex file from ~/.codex when CODEX_HOME is not set", async () => {
    const m = await machine({ "home/.codex/AGENTS.md": "codex" });
    expect((await read(m)).read.map((f) => f.path)).toEqual([m.at("home/.codex/AGENTS.md")]);
  });

  it("has nothing to add with no files, and skips empty ones", async () => {
    const m = await machine({ "work/proj/CLAUDE.md": "  \n" });
    expect(await read(m)).toEqual({ text: "", read: [], left: [] });
  });

  it("leaves out a file that is not text, and says why", async () => {
    const m = await machine({ "work/proj/AGENTS.md": "a\u0000b", "work/proj/CLAUDE.md": "fine" });
    const r = await read(m);
    expect(r.read.map((f) => f.path)).toEqual([m.at("work/proj/CLAUDE.md")]);
    expect(r.left).toEqual([{ path: m.at("work/proj/AGENTS.md"), why: "not text" }]);
  });

  it("expands @ imports where they stand: relative to the file, absolute, and ~; one that leads nowhere stays", async () => {
    const m = await machine({ "work/proj/docs/a.md": "A, then @b.md", "work/proj/docs/b.md": "B", "work/proj/c.md": "C", "home/.claude/CLAUDE.md": "see @~/d.md", "home/d.md": "D" });
    await writeFile(m.at("work/proj/CLAUDE.md"), `See @docs/a.md and @${m.at("work/proj/c.md")} but not @missing.md.`);
    const r = await read(m);
    expect(r.text).toBe(
      [
        NOTE,
        file(m.at("home/.claude/CLAUDE.md"), `see ${file(m.at("home/d.md"), "D")}`),
        file(m.at("work/proj/CLAUDE.md"), `See ${file(m.at("work/proj/docs/a.md"), `A, then ${file(m.at("work/proj/docs/b.md"), "B")}`)} and ${file(m.at("work/proj/c.md"), "C")} but not @missing.md.`),
      ].join("\n\n"),
    );
    expect(r.read.map((f) => f.path)).toEqual(["home/.claude/CLAUDE.md", "home/d.md", "work/proj/CLAUDE.md", "work/proj/docs/a.md", "work/proj/docs/b.md", "work/proj/c.md"].map(m.at));
  });

  it("follows imports four levels deep and no further", async () => {
    const m = await machine({ "work/proj/CLAUDE.md": "0 @1.md", "work/proj/1.md": "1 @2.md", "work/proj/2.md": "2 @3.md", "work/proj/3.md": "3 @4.md", "work/proj/4.md": "4 @5.md", "work/proj/5.md": "5" });
    const r = await read(m);
    expect(r.read.map((f) => path.basename(f.path))).toEqual(["CLAUDE.md", "1.md", "2.md", "3.md", "4.md"]);
    expect(r.text).toContain(file(m.at("work/proj/4.md"), "4 @5.md"));
  });

  it("reads each file once, so an import loop ends", async () => {
    const m = await machine({ "work/proj/CLAUDE.md": "@a.md", "work/proj/a.md": "a @b.md", "work/proj/b.md": "b @a.md @CLAUDE.md" });
    const r = await read(m);
    expect(r.read.map((f) => path.basename(f.path))).toEqual(["CLAUDE.md", "a.md", "b.md"]);
    expect(r.text).toContain(file(m.at("work/proj/b.md"), "b @a.md @CLAUDE.md"));
  });

  it("leaves imports in code blocks and code spans alone", async () => {
    const m = await machine({ "work/proj/x.md": "X", "work/proj/CLAUDE.md": ["```", "@x.md", "```", "`@x.md` and @x.md"].join("\n") });
    const r = await read(m);
    expect(r.text).toContain(file(m.at("work/proj/CLAUDE.md"), ["```", "@x.md", "```", `\`@x.md\` and ${file(m.at("work/proj/x.md"), "X")}`].join("\n")));
  });
});

describe("readInstructions, files that lead elsewhere", () => {
  it("asks once about imports leading out of the project, naming who imported each, and reads them when allowed", async () => {
    const m = await machine({ "elsewhere/one.md": "one", "elsewhere/two.md": "two", "work/notes.md": "notes" });
    await writeFile(m.at("work/proj/CLAUDE.md"), `@${m.at("elsewhere/one.md")} @../notes.md`);
    await writeFile(m.at("work/AGENTS.md"), `@${m.at("elsewhere/two.md")}`);
    const asked: Reached[][] = [];
    const r = await read(m, async (reached) => (asked.push(reached), true));
    expect(asked).toEqual([
      [
        { path: m.at("elsewhere/two.md"), how: `imported by ${m.at("work/AGENTS.md")}` },
        { path: m.at("elsewhere/one.md"), how: `imported by ${m.at("work/proj/CLAUDE.md")}` },
        { path: m.at("work/notes.md"), how: `imported by ${m.at("work/proj/CLAUDE.md")}` },
      ],
    ]);
    expect(r.text).toContain(file(m.at("elsewhere/one.md"), "one"));
  });

  it("leaves them out when declined, the import staying as text, and says so", async () => {
    const m = await machine({ "elsewhere/one.md": "one" });
    await writeFile(m.at("work/proj/CLAUDE.md"), `see @${m.at("elsewhere/one.md")}`);
    const r = await read(m, async () => false);
    expect(r.text).toBe([NOTE, file(m.at("work/proj/CLAUDE.md"), `see @${m.at("elsewhere/one.md")}`)].join("\n\n"));
    expect(r.left).toEqual([{ path: m.at("elsewhere/one.md"), why: "not allowed" }]);
  });

  it("still reads a project file that a declined file imports, in its own place, and once when allowed", async () => {
    const m = await machine({ "elsewhere/x.md": "x @../work/proj/AGENTS.md", "work/proj/AGENTS.md": "agents" });
    await writeFile(m.at("work/proj/CLAUDE.md"), `see @${m.at("elsewhere/x.md")}`);
    const declined = await read(m, async () => false);
    const agents = file(m.at("work/proj/AGENTS.md"), "agents");
    expect(declined.text).toBe([NOTE, file(m.at("work/proj/CLAUDE.md"), `see @${m.at("elsewhere/x.md")}`), agents].join("\n\n"));
    expect(declined.left).toEqual([{ path: m.at("elsewhere/x.md"), why: "not allowed" }]);
    const allowed = await read(m, async () => true);
    expect(allowed.text).toBe([NOTE, file(m.at("work/proj/CLAUDE.md"), `see ${file(m.at("elsewhere/x.md"), `x ${agents}`)}`)].join("\n\n"));
  });

  it("asks about a found file that a link takes to another folder", async () => {
    const m = await machine({ "elsewhere/CLAUDE.md": "far" });
    // A junction needs no special rights on Windows; elsewhere it is an ordinary symlink.
    await symlink(m.at("elsewhere"), m.at("work/proj/.claude"), "junction");
    const asked: Reached[][] = [];
    const r = await read(m, async (reached) => (asked.push(reached), false));
    expect(asked).toEqual([[{ path: realpathSync(m.at("elsewhere/CLAUDE.md")), how: `found as ${m.at("work/proj/.claude/CLAUDE.md")}` }]]);
    expect(r).toEqual({ text: "", read: [], left: [{ path: realpathSync(m.at("elsewhere/CLAUDE.md")), why: "not allowed" }] });
  });

  it("reads unasked a CLAUDE.md that is a link to the AGENTS.md beside it, once", async (ctx) => {
    const m = await machine({ "work/proj/AGENTS.md": "shared" });
    try {
      symlinkSync(m.at("work/proj/AGENTS.md"), m.at("work/proj/CLAUDE.md"), "file");
    } catch {
      return ctx.skip(); // Windows allows file symlinks only with Developer Mode or as an administrator
    }
    const r = await read(m);
    expect(r.text).toBe([NOTE, file(m.at("work/proj/CLAUDE.md"), "shared")].join("\n\n"));
  });

  it("asks about a found CLAUDE.md that is a link to a file in another folder", async (ctx) => {
    const m = await machine({ "elsewhere/x.md": "far" });
    try {
      symlinkSync(m.at("elsewhere/x.md"), m.at("work/proj/CLAUDE.md"), "file");
    } catch {
      return ctx.skip(); // Windows allows file symlinks only with Developer Mode or as an administrator
    }
    const asked: Reached[][] = [];
    await read(m, async (reached) => (asked.push(reached), false));
    expect(asked).toEqual([[{ path: realpathSync(m.at("elsewhere/x.md")), how: `found as ${m.at("work/proj/CLAUDE.md")}` }]]);
  });

  it("reads the user's own files and what they import unasked, wherever it is", async () => {
    const m = await machine({ "elsewhere/y.md": "Y", "codex/AGENTS.md": "codex @../elsewhere/y.md" });
    await mkdir(m.at("home/.claude"));
    await writeFile(m.at("home/.claude/CLAUDE.md"), `@${m.at("elsewhere/y.md")}`);
    const r = await read(m, unasked, m.at("codex"));
    expect(r.read.map((f) => f.path)).toEqual([m.at("home/.claude/CLAUDE.md"), m.at("elsewhere/y.md"), m.at("codex/AGENTS.md")]);
  });

  it("never reads Tachikoma's data folder, even when allowed, imported or found through a link", async () => {
    const m = await machine({ "data/chatgpt.json": "token", "data/CLAUDE.md": "data" });
    vi.stubEnv("TACHI_DATA_DIR", m.at("data"));
    await writeFile(m.at("work/proj/CLAUDE.md"), `@${m.at("data/chatgpt.json")}`);
    await mkdir(m.at("home/.claude"));
    await writeFile(m.at("home/.claude/CLAUDE.md"), `@${m.at("data/chatgpt.json")}`);
    await symlink(m.at("data"), m.at("work/proj/.claude"), "junction");
    const r = await read(m, async () => true);
    expect(r.text).not.toContain("token");
    expect(r.text).not.toContain(file(m.at("work/proj/.claude/CLAUDE.md"), "data"));
    expect(r.left.map((l) => l.path)).toEqual([m.at("data/chatgpt.json"), m.at("data/chatgpt.json"), m.at("work/proj/.claude/CLAUDE.md")]);
    for (const l of r.left) expect(l.why).toContain("Tachikoma's data folder");
  });

  it.runIf(process.platform === "linux")("never reads a program's environment", async () => {
    const m = await machine({ "home/.claude/CLAUDE.md": "@/proc/self/environ" });
    const r = await read(m, async () => true);
    expect(r.read.map((f) => f.path)).toEqual([m.at("home/.claude/CLAUDE.md")]);
    expect(r.left[0]!.why).toContain("a program's environment");
  });
});
````


**Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/core/instructions.test.ts`

Expected: FAIL. In the scratch build: Test Files 1 failed (1), before any test runs. `src/core/instructions.ts` does not exist yet.

**Step 3: Write the code**

**Create `src/core/instructions.ts`:**

````ts
import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { leaves, resolveIn } from "../tools/files.js";
import { errorText } from "./types.js";

// Put before the files in the system prompt (release 4 design, "Instruction files").
export const NOTE =
  "The user's and the project's instruction files (CLAUDE.md, AGENTS.md) follow, broadest first, each with its path. Where they disagree, the later, more specific file wins.";

export interface Where {
  root: string; // the project folder
  home?: string; // the user's folder; os.homedir() unless a test gives its own
  codexHome?: string; // CODEX_HOME, where the user's AGENTS.md is when set
  top?: string; // where the walk down to the project starts: the top of the drive unless a test gives its own
}

// A file outside the project the instruction files lead to, and how: "imported by <file>" or "found as <file>".
export interface Reached {
  path: string;
  how: string;
}

export interface Instructions {
  text: string; // for the system prompt; empty with no files
  read: { path: string; size: number }[]; // in the order they appear, imports included
  left: { path: string; why: string }[]; // files left out, and why
}

// Each folder's files, in Claude Code's order, then Codex's (Claude Code's memory.md and Codex's
// agents-md, read 2026-10-25); both kinds are read where both exist.
const NAMES = ["CLAUDE.md", path.join(".claude", "CLAUDE.md"), "CLAUDE.local.md", "AGENTS.md"];
// Imports are followed "a maximum depth of four hops", as in Claude Code (memory.md).
const HOPS = 4;

interface Loaded {
  path: string;
  size: number;
  pieces: (string | { token: string; file: Loaded })[]; // the text, with each import in its place
  ask?: Reached; // set when it needs the user's approval
}

// The folders from `top` down to `root`, both included.
function folders(top: string, root: string): string[] {
  const rel = path.relative(top, root);
  if (leaves(rel)) return [root];
  const out = [top];
  for (const part of rel.split(path.sep).filter(Boolean)) out.push(path.join(out.at(-1)!, part));
  return out;
}

// Reads the user's and the project's instruction files once, at the start of a session. The user's
// own two files, and what they import, are trusted. Any other file that leads out of the project, an
// import or a found file a link takes to another folder, is read only if `approve` allows the lot,
// asked once. Tachikoma's data folder and a program's environment are never read, whatever `approve`
// says: resolveIn refuses them after following links.
export async function readInstructions(where: Where, approve: (reached: Reached[]) => Promise<boolean>): Promise<Instructions> {
  const home = where.home ?? os.homedir();
  const left: Instructions["left"] = [];
  // By real path, so a file reached twice, by a link, an import or the walk, is read once. Null while
  // it is read, so an import loop back to it stays as text, and for one that is not read.
  const loaded = new Map<string, Loaded | null>();

  async function load(abs: string, opts: { trusted: boolean; hops: number; foundIn?: string; by?: string }): Promise<Loaded | null> {
    let outside: boolean;
    try {
      ({ outside } = resolveIn(where.root, abs));
    } catch (err) {
      left.push({ path: abs, why: errorText(err) });
      return null;
    }
    const real = await realpath(abs).catch(() => null);
    if (real === null) return null; // nothing there
    if (loaded.has(real)) return loaded.get(real)!;
    loaded.set(real, null);
    let buf: Buffer;
    try {
      buf = await readFile(real);
    } catch (err) {
      left.push({ path: abs, why: (err as NodeJS.ErrnoException).code ?? errorText(err) });
      return null;
    }
    if (buf.includes(0)) {
      left.push({ path: abs, why: "not text" });
      return null;
    }
    const text = buf.toString("utf8");
    if (!text.trim()) return null;
    let ask: Reached | undefined;
    if (opts.trusted) ask = undefined;
    else if (opts.foundIn !== undefined) ask = leaves(path.relative(await realpath(opts.foundIn), real)) ? { path: real, how: `found as ${abs}` } : undefined;
    else if (outside) ask = { path: abs, how: `imported by ${opts.by}` };
    const pieces = opts.hops < HOPS ? await imports(text, abs, opts.trusted, opts.hops + 1) : [text];
    const f: Loaded = { path: abs, size: buf.length, pieces, ...(ask ? { ask } : {}) };
    loaded.set(real, f);
    return f;
  }

  // `@path` imports, expanded where they stand: relative to the file they are in, or absolute, or from
  // `~`. Not inside code blocks or code spans. One that leads nowhere stays as text.
  async function imports(text: string, file: string, trusted: boolean, hops: number): Promise<Loaded["pieces"]> {
    const pieces: Loaded["pieces"] = [];
    let plain = "";
    let fenced = false;
    for (const line of text.split(/(?<=\n)/)) {
      const fence = /^\s*(```|~~~)/.test(line);
      if (fence) fenced = !fenced;
      if (fence || fenced) {
        plain += line;
        continue;
      }
      for (const [i, part] of line.split(/(`[^`]*`)/).entries()) {
        if (i % 2) {
          plain += part; // a code span
          continue;
        }
        let last = 0;
        for (const m of part.matchAll(/(?<=^|\s)@(\S+)/g)) {
          const name = m[1]!;
          const target = name === "~" || name.startsWith("~/") || name.startsWith("~\\") ? path.join(home, name.slice(1)) : path.resolve(path.dirname(file), name);
          const found = await load(target, { trusted, hops, by: file });
          if (!found) continue;
          pieces.push(plain + part.slice(last, m.index), { token: m[0], file: found });
          plain = "";
          last = m.index + m[0].length;
        }
        plain += part.slice(last);
      }
    }
    pieces.push(plain);
    return pieces;
  }

  const found: Loaded[] = [];
  const add = async (abs: string, opts: Parameters<typeof load>[1]) => {
    const f = await load(abs, opts);
    if (f) found.push(f);
  };
  await add(path.join(home, ".claude", "CLAUDE.md"), { trusted: true, hops: 0 });
  await add(path.join(where.codexHome ?? path.join(home, ".codex"), "AGENTS.md"), { trusted: true, hops: 0 });
  for (const folder of folders(where.top ?? path.parse(where.root).root, where.root)) {
    for (const name of NAMES) await add(path.join(folder, name), { trusted: false, hops: 0, foundIn: folder });
  }

  const asking = new Set<Loaded>(); // a file reached twice is asked about once
  const visit = (f: Loaded) => {
    if (f.ask) asking.add(f);
    for (const p of f.pieces) if (typeof p !== "string") visit(p.file);
  };
  found.forEach(visit);
  const allowed = asking.size === 0 || (await approve([...asking].map((f) => f.ask!)));
  if (!allowed) for (const f of asking) left.push({ path: f.ask!.path, why: "not allowed" });
  const out = (f: Loaded) => f.ask !== undefined && !allowed;

  // Each file goes in once, at its first place that is allowed: a project file that a declined file
  // imports still goes in where the walk found it.
  const read: Instructions["read"] = [];
  const done = new Set<Loaded>();
  const compose = (f: Loaded): string => {
    done.add(f);
    read.push({ path: f.path, size: f.size });
    const body = f.pieces.map((p) => (typeof p === "string" ? p : out(p.file) || done.has(p.file) ? p.token : compose(p.file))).join("");
    return `<file path="${f.path}">\n${body.trimEnd()}\n</file>`;
  };
  const files = found.flatMap((f) => (out(f) || done.has(f) ? [] : [compose(f)]));
  return { text: files.length ? [NOTE, ...files].join("\n\n") : "", read, left };
}
````

**Change `src/tools/files.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tools/files.ts b/src/tools/files.ts
index a3fe014..2675bc3 100644
--- a/src/tools/files.ts
+++ b/src/tools/files.ts
@@ -21,7 +21,7 @@ function realTarget(abs: string): string | null {
 
 // Whether `rel`, a path relative to some folder, leads out of it. On Windows a path on another drive
 // comes back absolute.
-const leaves = (rel: string) => rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
+export const leaves = (rel: string) => rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
 
 // Whether `real` is the data folder or in it. The path is compared first, which also covers a data
 // folder not made yet. Then each folder on the way up is compared by what it is (its volume and file
```


**Step 4: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 1 failed | 36 passed | 2 skipped (39); Tests 1 failed | 603 passed | 10 skipped (614).

**Step 5: Commit**

```bash
git add src/core/instructions.ts src/tools/files.ts tests/core/instructions.test.ts
git commit -m "feat: read the user's and the project's CLAUDE.md and AGENTS.md, imports and all"
```

### Task 6: Each session's system prompt carries the instruction files, asking first about files outside the project

The CLI reads the instruction files once, at the start, into the system prompt after Tachikoma's
own lines (release 4 design, "Instruction files"; choice 6).
- **The question** comes before the screen starts, since the system prompt is fixed before the
  first turn: "Read 2 files from outside the project, reached by the instruction files?", each
  file and what reached it, then `[y/n]`. One key answers it.
- **In `never` mode** they are read unasked. **With `-p`** nobody can approve, so they are left
  out and a line on stderr names them.
- **The start line,** grey, at the top of an interactive session: the files read and their total
  size, and any left out with why (App's new `intro` prop). With `-p`, nothing is printed.
- `clilib.ts` gains `instructionsLine`, `approvalQuestion` and `headlessLeftOut`.

The CLI's tests now run in a temporary folder with a pretend home folder and
`TACHI_INSTRUCTIONS_TOP` set to it, so they never read your files.

**Files:**
- Modify: `src/cli.tsx`
- Modify: `src/clilib.ts`
- Modify: `src/tui/App.tsx`
- Modify: `tests/cli.test.ts`
- Modify: `tests/clilib.test.ts`
- Modify: `tests/tui/app.test.tsx`

**Step 1: Write the failing tests**

**Change `tests/cli.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/cli.test.ts b/tests/cli.test.ts
index 14dd222..b18f514 100644
--- a/tests/cli.test.ts
+++ b/tests/cli.test.ts
@@ -1,17 +1,24 @@
 import { spawnSync } from "node:child_process";
-import { mkdtempSync } from "node:fs";
+import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
 import { tmpdir } from "node:os";
 import path from "node:path";
+import { pathToFileURL } from "node:url";
 import { describe, expect, it } from "vitest";
 
-// Runs the real command through tsx. Every case here stops before any model is called.
+// Runs the real command through tsx, in a fresh project folder with a pretend home folder, and with
+// the walk for instruction files starting at a fresh folder of its own, so no case reads the user's
+// files. Every case here stops before any model answers.
 function tachi(...args: (string | Record<string, string>)[]) {
   const env = args.find((a) => typeof a === "object") ?? {};
   const words = args.filter((a) => typeof a === "string");
-  const r = spawnSync(process.execPath, ["--import", "tsx", path.resolve("src/cli.tsx"), ...words], {
+  const top = mkdtempSync(path.join(tmpdir(), "tachi-cli-"));
+  const home = path.join(top, "home");
+  mkdirSync(home);
+  const r = spawnSync(process.execPath, ["--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href, path.resolve("src/cli.tsx"), ...words], {
+    cwd: env.cwd ?? top,
     input: "x\n",
     encoding: "utf8",
-    env: { ...process.env, TACHI_LEAD: "", ANTHROPIC_API_KEY: "", ...env },
+    env: { ...process.env, TACHI_LEAD: "", ANTHROPIC_API_KEY: "", TACHI_INSTRUCTIONS_TOP: top, USERPROFILE: home, HOME: home, CODEX_HOME: "", ...env },
   });
   return { code: r.status, stdout: r.stdout, stderr: r.stderr };
 }
@@ -66,6 +73,17 @@ describe("tachi", { timeout: 15_000 }, () => {
     expect(r.stderr).toContain("Usage: tachi login chatgpt [--new | --account <number>]");
   });
 
+  it("with -p, leaves out instruction files from outside the project and says which, printing nothing about the rest", () => {
+    const top = mkdtempSync(path.join(tmpdir(), "tachi-cli-"));
+    const proj = path.join(top, "proj");
+    mkdirSync(proj);
+    writeFileSync(path.join(top, "secret.md"), "secret");
+    writeFileSync(path.join(proj, "CLAUDE.md"), `@${path.join(top, "secret.md")}`);
+    const r = tachi("--lead", "ollama:none", "-p", "hi", { cwd: proj, TACHI_INSTRUCTIONS_TOP: top });
+    expect(r.stderr).toContain(`note: 1 instruction file from outside the project left out, since nobody can approve it in -p mode: ${path.join(top, "secret.md")}, imported by ${path.join(proj, "CLAUDE.md")}`);
+    expect(r.stderr).not.toContain("Instructions:");
+  });
+
   it("refuses interactive mode without a terminal, before starting the interface", () => {
     const r = tachi("--lead", "ollama:none");
     expect(r.code).toBe(1);
```

**Change `tests/clilib.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/clilib.test.ts b/tests/clilib.test.ts
index b691821..d1c142a 100644
--- a/tests/clilib.test.ts
+++ b/tests/clilib.test.ts
@@ -1,9 +1,51 @@
 import { spawn } from "node:child_process";
 import { constants } from "node:os";
 import { describe, expect, it } from "vitest";
-import { headlessAnswer, headlessExit, jsonLine, prose, statusSegments } from "../src/clilib.js";
+import path from "node:path";
+import { approvalQuestion, headlessAnswer, headlessExit, headlessLeftOut, instructionsLine, jsonLine, prose, statusSegments } from "../src/clilib.js";
 import { SEGMENTS } from "../src/tui/StatusLine.js";
 
+describe("the instruction files on screen", () => {
+  const home = path.resolve("/home/me");
+  const proj = path.resolve("/work/proj");
+  const r = {
+    text: "...",
+    read: [
+      { path: path.join(home, ".claude", "CLAUDE.md"), size: 1200 },
+      { path: path.join(proj, "AGENTS.md"), size: 3100 },
+    ],
+    left: [{ path: path.resolve("/elsewhere/x.md"), why: "not allowed" }],
+  };
+
+  it("lists the files read, the user's folder as ~, their total size, and those left out", () => {
+    expect(instructionsLine(r, home)).toBe(`Instructions: ${path.join("~", ".claude", "CLAUDE.md")}, ${path.join(proj, "AGENTS.md")} (4.3k bytes); left out: ${path.resolve("/elsewhere/x.md")} (not allowed)`);
+    expect(instructionsLine({ text: "", read: [], left: [] }, home)).toBeNull();
+    expect(instructionsLine({ ...r, read: [] }, home)).toBe(`Instructions: none read; left out: ${path.resolve("/elsewhere/x.md")} (not allowed)`);
+  });
+
+  it("asks once about the files outside the project, each with how it was reached, escaped", () => {
+    const reached = [
+      { path: path.resolve("/elsewhere/x.md"), how: `imported by ${path.join(proj, "CLAUDE.md")}` },
+      { path: path.resolve("/elsewhere/a\u001b[2Jb.md"), how: `found as ${path.join(proj, "AGENTS.md")}` },
+    ];
+    expect(approvalQuestion(reached)).toBe(
+      [
+        "Read 2 files from outside the project, reached by the instruction files?",
+        `  ${path.resolve("/elsewhere/x.md")}, imported by ${path.join(proj, "CLAUDE.md")}`,
+        `  ${path.resolve("/elsewhere/a\\u001b[2Jb.md")}, found as ${path.join(proj, "AGENTS.md")}`,
+        "[y/n]",
+      ].join("\n"),
+    );
+    expect(approvalQuestion(reached.slice(0, 1))).toContain("Read 1 file from outside the project");
+  });
+
+  it("says with -p which were left out, since nobody can approve them", () => {
+    expect(headlessLeftOut([{ path: path.resolve("/elsewhere/x.md"), how: "imported by CLAUDE.md" }])).toBe(
+      `note: 1 instruction file from outside the project left out, since nobody can approve it in -p mode: ${path.resolve("/elsewhere/x.md")}, imported by CLAUDE.md`,
+    );
+  });
+});
+
 describe("headlessExit", () => {
   const run = { aborted: false, failed: false, declined: false };
 
```

**Change `tests/tui/app.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/app.test.tsx b/tests/tui/app.test.tsx
index f629aa2..737c2d9 100644
--- a/tests/tui/app.test.tsx
+++ b/tests/tui/app.test.tsx
@@ -62,6 +62,7 @@ async function mount(
     past?: string[]; // the project's prompts from earlier sessions
     newLead?: Provider; // what /lead and the picker make
     rows?: number; // the terminal's height
+    intro?: AppProps["intro"]; // the start line
     mode?: Mode; // the mode the session starts in
   } = {},
 ) {
@@ -87,6 +88,7 @@ async function mount(
       root={ctx.root}
       gitBranch={() => opts.branches?.shift() ?? null}
       historyFile={historyFile}
+      intro={opts.intro ?? []}
       errorFile={opts.errorFile ?? path.join(ctx.root, "errors.jsonl")}
       segments={opts.segments ?? SEGMENTS}
       makeProvider={(spec) => {
@@ -155,6 +157,11 @@ describe("App", () => {
     }
   });
 
+  it("shows the start line, grey, first", async () => {
+    const { app } = await mount([], { intro: [{ text: "Instructions: CLAUDE.md (12 bytes)", color: "gray" }] });
+    expect(app.lastFrame()).toMatch(/^Instructions: CLAUDE.md \(12 bytes\)\n/);
+  });
+
   it("sends what the user types and shows the reply", async () => {
     const { app } = await mount([reply("hello there")]);
     await type(app, "hi");
```


**Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/cli.test.ts tests/clilib.test.ts tests/tui/app.test.tsx`

Expected: FAIL. In the scratch build: Test Files 3 failed (3); Tests 5 failed | 121 passed (126). The CLI reads no instruction files yet.

**Step 3: Write the code**

**Change `src/cli.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/cli.tsx b/src/cli.tsx
index de48652..4b25ee2 100644
--- a/src/cli.tsx
+++ b/src/cli.tsx
@@ -1,13 +1,14 @@
 #!/usr/bin/env node
 import { randomUUID } from "node:crypto";
-import { constants } from "node:os";
+import os, { constants } from "node:os";
 import path from "node:path";
 import { parseArgs } from "node:util";
 import { render } from "ink";
 import { accountCommand } from "./auth/chatgpt.js";
-import { endOnEpipe, headlessAnswer, headlessExit, jsonLine, prose, statusSegments } from "./clilib.js";
+import { approvalQuestion, endOnEpipe, headlessAnswer, headlessExit, headlessLeftOut, instructionsLine, jsonLine, prose, statusSegments } from "./clilib.js";
 import { Bus } from "./core/bus.js";
 import { attachErrorLog } from "./core/errorlog.js";
+import { readInstructions } from "./core/instructions.js";
 import { MODES, type Mode, PermissionGate } from "./core/permissions.js";
 import { systemPrompt } from "./core/prompt.js";
 import { Session } from "./core/session.js";
@@ -56,6 +57,24 @@ function fail(message: string): never {
   process.exit(1);
 }
 
+// The question at the start, before the screen is drawn (release 4 design, "Files that lead elsewhere
+// ask first"): y reads the files, any other key leaves them out, and Ctrl-C quits.
+function askAtStart(question: string): Promise<boolean> {
+  process.stdout.write(`${question} `);
+  process.stdin.setRawMode(true);
+  return new Promise((resolve) => {
+    process.stdin.once("data", (data) => {
+      process.stdin.setRawMode(false);
+      process.stdin.pause();
+      const key = String(data);
+      if (key === "\u0003") process.exit(128 + constants.signals.SIGINT);
+      const yes = key.toLowerCase() === "y";
+      process.stdout.write(`${yes ? "y" : "n"}\n`);
+      resolve(yes);
+    });
+  });
+}
+
 function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T | undefined {
   if (value === undefined) return undefined;
   if (!(allowed as readonly string[]).includes(value)) fail(`--${name} must be one of: ${allowed.join(", ")} (got "${value}")`);
@@ -136,6 +155,22 @@ try {
   fail(`--fallback: ${errorText(err)}`); // otherwise it reads like a bad lead
 }
 
+const interactive = parsed.print === undefined;
+// Before the instruction files are read, so nothing is asked with no terminal to answer.
+if (interactive && !process.stdin.isTTY) fail('Interactive mode needs a terminal; use -p "<prompt>" to run one prompt.');
+
+// Read once, at the start (release 4 design, "Instruction files"). TACHI_INSTRUCTIONS_TOP moves where
+// the walk down to the project starts, so tests never read the user's files.
+const instructions = await readInstructions({ root, codexHome: process.env.CODEX_HOME || undefined, top: process.env.TACHI_INSTRUCTIONS_TOP || undefined }, async (reached) => {
+  if (mode === "never") return true; // as read_file reads outside the project then
+  if (!interactive) {
+    console.error(headlessLeftOut(reached));
+    return false;
+  }
+  return askAtStart(approvalQuestion(reached));
+});
+const system = [systemPrompt(root), instructions.text].filter(Boolean).join("\n\n");
+
 let declined = false;
 let ask: (summary: string, detail?: string) => Promise<boolean> = async (summary) => {
   declined = true;
@@ -144,10 +179,10 @@ let ask: (summary: string, detail?: string) => Promise<boolean> = async (summary
   );
   return false;
 };
-const gate = new PermissionGate(mode, (summary, detail) => ask(summary, detail), parsed.print === undefined ? undefined : "Not allowed in -p mode, where nobody can approve it");
+const gate = new PermissionGate(mode, (summary, detail) => ask(summary, detail), interactive ? undefined : "Not allowed in -p mode, where nobody can approve it");
 // The to-do list is the lead's alone; the screen shows it from the bus.
 const tools = [...TOOLS, todoTool((items) => bus.emit("todo", items))];
-const session = new Session({ lead, fallback, tools, system: systemPrompt(root), ctx: { root, executor: new LocalExecutor(), gate }, bus });
+const session = new Session({ lead, fallback, tools, system, ctx: { root, executor: new LocalExecutor(), gate }, bus });
 
 // The executor stops running commands from an "exit" handler, which dying by a signal skips.
 for (const sig of ["SIGTERM", "SIGHUP"] as const) process.on(sig, () => process.exit(128 + constants.signals[sig]));
@@ -183,7 +218,6 @@ if (parsed.print !== undefined) {
   }
   process.exitCode = headlessExit({ aborted: stop.signal.aborted, failed, declined });
 } else {
-  if (!process.stdin.isTTY) fail('Interactive mode needs a terminal; use -p "<prompt>" to run one prompt.');
   // Ctrl-C reaches the interface as a key; a SIGINT here came from outside (`kill -INT`).
   process.on("SIGINT", () => process.exit(128 + constants.signals.SIGINT));
   render(
@@ -199,6 +233,7 @@ if (parsed.print !== undefined) {
       root={root}
       gitBranch={() => gitBranch(root)}
       historyFile={historyFile(root)}
+      intro={[instructionsLine(instructions, os.homedir())].flatMap((text) => (text === null ? [] : [{ text, color: "gray" }]))}
       errorFile={errorFile}
       segments={segments}
       makeProvider={makeProvider}
```

**Change `src/clilib.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/clilib.ts b/src/clilib.ts
index 5cf41f1..a81b001 100644
--- a/src/clilib.ts
+++ b/src/clilib.ts
@@ -1,7 +1,9 @@
 import { constants } from "node:os";
+import path from "node:path";
+import type { Instructions, Reached } from "./core/instructions.js";
 import { visible } from "./core/permissions.js";
 import { screen } from "./tui/describe.js";
-import { type Segment, SEGMENTS } from "./tui/StatusLine.js";
+import { k, type Segment, SEGMENTS } from "./tui/StatusLine.js";
 
 // Headless output reaches the terminal too, so model and provider text gets the scrollback's escaping.
 export const prose = (text: string) => screen({ text }).text;
@@ -48,3 +50,28 @@ export function endOnEpipe(err: NodeJS.ErrnoException): void {
   if (err.code !== "EPIPE") throw err;
   process.exit();
 }
+
+// The grey line at the start of a session (release 4 design, "Instruction files"): the files read,
+// the user's folder written as ~, their total size, and any left out and why. Paths come from the disk,
+// so they are escaped.
+export function instructionsLine(r: Instructions, home: string): string | null {
+  if (!r.read.length && !r.left.length) return null;
+  const short = (p: string) => visible(p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p);
+  const size = r.read.reduce((n, f) => n + f.size, 0);
+  const read = r.read.length ? `${r.read.map((f) => short(f.path)).join(", ")} (${k(size)} bytes)` : "none read";
+  const left = r.left.length ? `; left out: ${r.left.map((l) => `${short(l.path)} (${visible(l.why)})`).join(", ")}` : "";
+  return `Instructions: ${read}${left}`;
+}
+
+const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
+
+// The one question at the start about files the instruction files lead to outside the project.
+export function approvalQuestion(reached: Reached[]): string {
+  return [`Read ${files(reached.length)} from outside the project, reached by the instruction files?`, ...reached.map((r) => `  ${visible(r.path)}, ${visible(r.how)}`), "[y/n]"].join("\n");
+}
+
+// With -p nobody can approve them, so they are left out, and stderr names them.
+export function headlessLeftOut(reached: Reached[]): string {
+  const n = reached.length;
+  return `note: ${n} instruction file${n === 1 ? "" : "s"} from outside the project left out, since nobody can approve ${n === 1 ? "it" : "them"} in -p mode: ${reached.map((r) => `${visible(r.path)}, ${visible(r.how)}`).join("; ")}`;
+}
```

**Change `src/tui/App.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/App.tsx b/src/tui/App.tsx
index 9c486b6..e6e470c 100644
--- a/src/tui/App.tsx
+++ b/src/tui/App.tsx
@@ -34,6 +34,7 @@ export interface AppProps {
   root: string; // the project folder, where `@` paths start
   gitBranch: () => string | null; // read at the start and after each turn: the model may switch branches
   historyFile: string; // this project's past prompts
+  intro: Line[]; // shown first: the instruction files read
   errorFile: string;
   segments: Segment[];
   makeProvider: (spec: string) => Provider;
@@ -53,7 +54,7 @@ const DOUBLE_PRESS_MS = 800; // Claude Code's window for pressing Ctrl+D twice (
 const NAMES = ["/exit", "/errors", "/lead", "/model", "/login", "/logout"];
 const isCommand = (text: string) => NAMES.includes(text.split(/\s+/)[0]!.toLowerCase()) || /^\/[a-z]+$/i.test(text);
 
-export function App({ session, bus, stats, mode, onMode, project, root, gitBranch, historyFile, errorFile, segments, makeProvider, bindAsk, login, listModels }: AppProps) {
+export function App({ session, bus, stats, mode, onMode, project, root, gitBranch, historyFile, intro, errorFile, segments, makeProvider, bindAsk, login, listModels }: AppProps) {
   const { exit } = useApp();
   const [lines, setLines] = useState<(Line & { id: number })[]>([]);
   // Each key reads and changes these at once, as in ModelPicker: several keys can arrive before the
@@ -167,6 +168,7 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
     bus.on("tool-start", onToolStart);
     bus.on("tool-end", onToolEnd);
     bus.on("todo", onTodo);
+    say(...intro);
     history.current!.load();
     lookUpWindow();
     const minutes = setInterval(() => setNow(Date.now()), 60_000); // the status line counts the session in minutes
```


**Step 4: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 1 failed | 36 passed | 2 skipped (39); Tests 1 failed | 608 passed | 10 skipped (619).

**Step 5: Commit**

```bash
git add src/cli.tsx src/clilib.ts src/tui/App.tsx tests/cli.test.ts tests/clilib.test.ts tests/tui/app.test.tsx
git commit -m "feat: each session's system prompt carries the instruction files, asking first about files outside the project"
```

### Task 7: The lead's and the subagents' questions wait in one line, each stopping only its owner

Release 4 design, "One line of questions, each with its owner"; choice 7. Before this, the screen
held one question, so a second could replace the first.
- **`PermissionGate.for(owner)`** (`src/core/permissions.ts`) makes a subagent's gate: it reads the
  lead's mode, so Shift+Tab reaches subagents too, and its questions carry the owner (a name, a
  stop signal, and how to stop it). The question reads "Allow t2 (find the login code) to read
  C:\notes.txt?".
- **App keeps a line of questions** and shows the first. y, n or Esc answer it only.
- **Ctrl-C** declines it and stops its owner only: the lead's turn for the lead's question, that
  subagent for a subagent's.
- **When an owner stops,** its questions leave the line, the one on screen included, answered as
  cancelled, and the next one shows.

**Files:**
- Modify: `src/cli.tsx`
- Modify: `src/core/permissions.ts`
- Modify: `src/tui/App.tsx`
- Modify: `tests/core/permissions.test.ts`
- Modify: `tests/tui/app.test.tsx`

**Step 1: Write the failing tests**

**Change `tests/core/permissions.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/core/permissions.test.ts b/tests/core/permissions.test.ts
index 85d6369..60c9c4c 100644
--- a/tests/core/permissions.test.ts
+++ b/tests/core/permissions.test.ts
@@ -64,6 +64,20 @@ describe("PermissionGate", () => {
   });
 });
 
+describe("a subagent's gate", () => {
+  it("reads the lead's mode at each check, and names the subagent when it asks", async () => {
+    const asked: [string, string | undefined][] = [];
+    const gate = new PermissionGate("never", async (summary, _detail, owner) => (asked.push([summary, owner?.name]), false), "Not allowed");
+    const child = gate.for({ name: "t2 (find the login code)", signal: new AbortController().signal, stop: () => {} });
+    await child.require({ kind: "read", outside: true, summary: "read /x" });
+    expect(asked).toEqual([]);
+    gate.mode = "ask";
+    expect(child.mode).toBe("ask");
+    await expect(child.require({ kind: "read", outside: true, summary: "read /x" })).rejects.toThrow("Not allowed: read /x");
+    expect(asked).toEqual([["read /x", "t2 (find the login code)"]]);
+  });
+});
+
 describe("visible", () => {
   it.each([
     ["an escape code", "echo \u001b[8mhidden", "echo \\u001b[8mhidden"],
```

**Change `tests/tui/app.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/app.test.tsx b/tests/tui/app.test.tsx
index 737c2d9..c27ef9b 100644
--- a/tests/tui/app.test.tsx
+++ b/tests/tui/app.test.tsx
@@ -5,7 +5,7 @@ import path from "node:path";
 import { render } from "ink-testing-library";
 import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
 import { privateDir } from "../../src/auth/private.js";
-import { type Mode, PermissionGate } from "../../src/core/permissions.js";
+import { type Mode, type Owner, PermissionGate } from "../../src/core/permissions.js";
 import { Session } from "../../src/core/session.js";
 import { Stats } from "../../src/core/stats.js";
 import type { Provider } from "../../src/core/types.js";
@@ -69,8 +69,8 @@ async function mount(
   const bus = new Bus();
   const stats = new Stats(bus);
   const ctx = await tempContext();
-  let ask: (s: string, d?: string) => Promise<boolean> = async () => false;
-  const gate = new PermissionGate(opts.mode ?? "ask", (s, d) => ask(s, d));
+  let ask: (s: string, d?: string, o?: Owner) => Promise<boolean> = async () => false;
+  const gate = new PermissionGate(opts.mode ?? "ask", (s, d, o) => ask(s, d, o));
   const lead = opts.lead ?? new FakeProvider("a", turns);
   const session = new Session({ lead, tools: TOOLS, system: "t", ctx: { ...ctx, gate }, bus });
   const historyFile = opts.historyFile ?? path.join(histories, `${nextHistory++}.jsonl`);
@@ -111,7 +111,7 @@ async function mount(
   Object.assign(app.stdout, { rows: opts.rows ?? 24 });
   app.stdout.emit("resize");
   await tick();
-  return { app, session, ctx, bus, historyFile, ask: (s: string) => ask(s) };
+  return { app, session, ctx, bus, historyFile, ask: (s: string, d?: string, o?: Owner) => ask(s, d, o) };
 }
 
 async function type(app: ReturnType<typeof render>, text: string) {
@@ -1051,6 +1051,78 @@ describe("App's space on screen", () => {
   });
 });
 
+// A subagent that asks: its name, its stop signal, and whether it was stopped.
+function asker(name: string) {
+  const stop = new AbortController();
+  const a: { stopped: boolean; owner: Owner } = {
+    stopped: false,
+    owner: {
+      name,
+      signal: stop.signal,
+      stop: () => {
+        a.stopped = true;
+        stop.abort();
+      },
+    },
+  };
+  return a;
+}
+
+describe("App's questions", () => {
+  it("shows the lead's and the subagents' questions one at a time, in order, each naming who asks", async () => {
+    const { app, ask } = await mount([]);
+    const t2 = asker("t2 (find the login code)");
+    const t3 = asker("t3 (read\rthe tests)");
+    const answers = [ask("read /a"), ask("read /b", undefined, t2.owner), ask("read /c", undefined, t3.owner)];
+    await until(app, "Allow read /a? [y/n]");
+    await press(app, "y");
+    await until(app, "Allow t2 (find the login code) to read /b? [y/n]");
+    await press(app, "n");
+    await until(app, "Allow t3 (read␍the tests) to read /c? [y/n]");
+    await press(app, "\u001b");
+    expect(await Promise.all(answers)).toEqual([true, false, false]);
+    expect(app.lastFrame()).toContain("t2 (find the login code) to read /b: declined");
+  });
+
+  it("on Ctrl-C at a subagent's question, stops that subagent, not the lead's turn", async () => {
+    const { app, ask } = await mount([], { lead: hanging() });
+    await type(app, "one");
+    await until(app, "Esc to stop");
+    const t2 = asker("t2 (find the login code)");
+    const answer = ask("read /b", undefined, t2.owner);
+    await until(app, "Allow t2");
+    await press(app, "\u0003");
+    expect(await answer).toBe(false);
+    expect(t2.stopped).toBe(true);
+    await until(app, "Esc to stop");
+  });
+
+  it("takes away a stopped subagent's questions, the one on screen included, and shows the next", async () => {
+    const { app, ask } = await mount([]);
+    const t2 = asker("t2 (x)");
+    const t3 = asker("t3 (y)");
+    const answers = [ask("read /b", undefined, t2.owner), ask("read /b2", undefined, t2.owner), ask("read /c", undefined, t3.owner)];
+    await until(app, "Allow t2 (x) to read /b?");
+    t2.owner.stop();
+    await until(app, "Allow t3 (y) to read /c?");
+    expect(await Promise.all(answers.slice(0, 2))).toEqual([false, false]);
+    expect(app.lastFrame()).toContain("t2 (x) to read /b: cancelled");
+  });
+
+  it("on Ctrl-C at the lead's question, stops the turn and takes away its questions only", async () => {
+    const { app, ask } = await mount([callTool("c1", "write_file", { path: "a.txt", content: "x" }), reply("written")]);
+    await type(app, "make a file");
+    await until(app, "Allow write");
+    const t3 = asker("t3 (y)");
+    const answer = ask("read /c", undefined, t3.owner);
+    await press(app, "\u0003");
+    await until(app, "Allow t3 (y) to read /c?");
+    await press(app, "y");
+    expect(await answer).toBe(true);
+    expect(t3.stopped).toBe(false);
+  });
+});
+
 describe("App's to-do list", () => {
   const items: TodoItem[] = [
     { text: "read the login code", status: "done" },
```


**Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/core/permissions.test.ts tests/tui/app.test.tsx`

Expected: FAIL. In the scratch build: Test Files 2 failed (2); Tests 5 failed | 134 passed (139). Questions have no owner yet, and a second question replaces the first.

**Step 3: Write the code**

**Change `src/cli.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/cli.tsx b/src/cli.tsx
index 4b25ee2..85cd5ee 100644
--- a/src/cli.tsx
+++ b/src/cli.tsx
@@ -9,7 +9,7 @@ import { approvalQuestion, endOnEpipe, headlessAnswer, headlessExit, headlessLef
 import { Bus } from "./core/bus.js";
 import { attachErrorLog } from "./core/errorlog.js";
 import { readInstructions } from "./core/instructions.js";
-import { MODES, type Mode, PermissionGate } from "./core/permissions.js";
+import { type Ask, MODES, type Mode, PermissionGate } from "./core/permissions.js";
 import { systemPrompt } from "./core/prompt.js";
 import { Session } from "./core/session.js";
 import { Stats } from "./core/stats.js";
@@ -172,14 +172,14 @@ const instructions = await readInstructions({ root, codexHome: process.env.CODEX
 const system = [systemPrompt(root), instructions.text].filter(Boolean).join("\n\n");
 
 let declined = false;
-let ask: (summary: string, detail?: string) => Promise<boolean> = async (summary) => {
+let ask: Ask = async (summary, _detail, owner) => {
   declined = true;
   console.error(
-    `declined, nobody to ask in -p mode (--mode project allows writes inside the project, but shell commands and anything outside it are still refused; --mode never means no checks at all): ${summary}`,
+    `declined, nobody to ask in -p mode (--mode project allows writes inside the project, but shell commands and anything outside it are still refused; --mode never means no checks at all): ${owner ? `${prose(owner.name)}: ` : ""}${summary}`,
   );
   return false;
 };
-const gate = new PermissionGate(mode, (summary, detail) => ask(summary, detail), interactive ? undefined : "Not allowed in -p mode, where nobody can approve it");
+const gate = new PermissionGate(mode, (summary, detail, owner) => ask(summary, detail, owner), interactive ? undefined : "Not allowed in -p mode, where nobody can approve it");
 // The to-do list is the lead's alone; the screen shows it from the bus.
 const tools = [...TOOLS, todoTool((items) => bus.emit("todo", items))];
 const session = new Session({ lead, fallback, tools, system, ctx: { root, executor: new LocalExecutor(), gate }, bus });
```

**Change `src/core/permissions.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/core/permissions.ts b/src/core/permissions.ts
index 51c8f17..0a72f9a 100644
--- a/src/core/permissions.ts
+++ b/src/core/permissions.ts
@@ -35,12 +35,42 @@ export function visible(text: string, opts: { tabs?: boolean } = {}): string {
 // Thrown when the user says no. The model is told; it is not logged as an error.
 export class Declined extends Error {}
 
+// Who asks a question, when it is not the lead's turn: a subagent's name, its stop signal, and how to
+// stop it (release 4 design, "One line of questions, each with its owner").
+export interface Owner {
+  name: string;
+  signal: AbortSignal;
+  stop: () => void;
+}
+
+export type Ask = (summary: string, detail?: string, owner?: Owner) => Promise<boolean>;
+
 export class PermissionGate {
+  #mode: Mode;
+  #parent?: PermissionGate;
+
   constructor(
-    public mode: Mode, // read at each check: Shift+Tab changes it during a session
-    private readonly ask: (summary: string, detail?: string) => Promise<boolean>,
+    mode: Mode,
+    private readonly ask: Ask,
     private readonly refusal = "The user declined", // what the model is told; in -p mode nobody was asked
-  ) {}
+  ) {
+    this.#mode = mode;
+  }
+
+  // Read at each check: Shift+Tab changes it during a session. A subagent's gate reads the lead's.
+  get mode(): Mode {
+    return this.#parent?.mode ?? this.#mode;
+  }
+  set mode(mode: Mode) {
+    this.#mode = mode;
+  }
+
+  // A subagent's gate: the lead's mode, and questions that name the subagent.
+  for(owner: Owner): PermissionGate {
+    const gate = new PermissionGate(this.#mode, (summary, detail) => this.ask(summary, detail, owner), this.refusal);
+    gate.#parent = this;
+    return gate;
+  }
 
   async require(action: Action): Promise<void> {
     if (!needsApproval(this.mode, action)) return;
```

**Change `src/tui/App.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/App.tsx b/src/tui/App.tsx
index e6e470c..b27c1a2 100644
--- a/src/tui/App.tsx
+++ b/src/tui/App.tsx
@@ -2,7 +2,7 @@ import { type Key, Static, Text, useApp, useInput, usePaste, useWindowSize } fro
 import { useEffect, useRef, useState } from "react";
 import type { Bus, ErrorEvent, Events } from "../core/bus.js";
 import { summarize } from "../core/errorlog.js";
-import { type Mode, visible } from "../core/permissions.js";
+import { type Ask, type Mode, type Owner, visible } from "../core/permissions.js";
 import type { Session } from "../core/session.js";
 import type { Stats } from "../core/stats.js";
 import { errorText, type Message, type Provider } from "../core/types.js";
@@ -22,7 +22,8 @@ import { TodoList, todoRows, unfinished } from "./TodoList.js";
 import { type Call, ToolLine } from "./ToolLine.js";
 import { SPIN_MS, WorkingLine } from "./WorkingLine.js";
 
-type Question = { text: string; answer: (ok: boolean, how: string) => void };
+// A question waiting in the line, and who asked it: a subagent, or with no owner the lead's turn.
+type Question = { text: string; owner?: Owner; answer: (ok: boolean, how: string) => void };
 
 export interface AppProps {
   session: Session;
@@ -38,7 +39,7 @@ export interface AppProps {
   errorFile: string;
   segments: Segment[];
   makeProvider: (spec: string) => Provider;
-  bindAsk: (ask: (summary: string, detail?: string) => Promise<boolean>) => void;
+  bindAsk: (ask: Ask) => void;
   // `/login …` and `/logout …`: the words after the command, where to show what it says, a signal
   // Ctrl-C aborts, and how a command is typed here ("/").
   login: (verb: "login" | "logout", words: string[], say: (line: string) => void, signal: AbortSignal, prefix: string) => Promise<void>;
@@ -84,7 +85,9 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
   // session started with.
   const perm = useRef(mode);
   const cycle: Mode[] = mode === "never" ? ["ask", "project", "never"] : ["ask", "project"];
-  const [question, setQuestion] = useState<Question | null>(null);
+  // The lead's and every subagent's questions, shown one at a time, so none replaces the one on screen.
+  const questions = useRef<Question[]>([]);
+  const question = questions.current[0] ?? null;
   const [contextWindow, setContextWindow] = useState<number | null>(null);
   const [picker, setPicker] = useState<ModelGroup[] | null>(null);
   const [, rerender] = useState(0);
@@ -111,9 +114,11 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
   };
 
   useEffect(() => {
-    bindAsk((text, detail) => {
-      // A tool still finishing after Ctrl-C must not ask about a turn the user has stopped.
-      if (abort.current?.signal.aborted) return Promise.resolve(false);
+    bindAsk((text, detail, owner) => {
+      // A tool still finishing after Ctrl-C must not ask about a turn the user has stopped, nor a
+      // stopped subagent about anything.
+      const signal = owner ? owner.signal : abort.current?.signal;
+      if (signal?.aborted) return Promise.resolve(false);
       // In the scrollback, not the prompt: a whole file would not fit in the part Ink redraws.
       // Grey, under a heading, so file text cannot pass for the conversation or the interface.
       if (detail !== undefined) {
@@ -122,16 +127,25 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
       }
       return new Promise((resolve) => {
         let open = true; // answered once: two keys arriving together would otherwise both be logged
-        setQuestion({
-          text,
+        // When its owner stops (Esc or Ctrl-C for the lead's turn, /tasks stop, a failure), the
+        // question goes from the line, on screen or not, answered as cancelled.
+        const cancel = () => q.answer(false, "cancelled");
+        const q: Question = {
+          text: owner ? `${visible(owner.name)} to ${text}` : text,
+          ...(owner ? { owner } : {}),
           answer: (ok, how) => {
             if (!open) return;
             open = false;
-            say({ text: `${text}: ${how}`, color: "gray" });
+            signal?.removeEventListener("abort", cancel);
+            questions.current = questions.current.filter((x) => x !== q);
+            say({ text: `${q.text}: ${how}`, color: "gray" });
             resolve(ok);
-            setQuestion(null);
+            rerender((n) => n + 1);
           },
-        });
+        };
+        signal?.addEventListener("abort", cancel, { once: true });
+        questions.current.push(q);
+        rerender((n) => n + 1);
       });
     });
     const onMessage = (m: Message) => say(...describe(m));
@@ -276,10 +290,14 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
   useInput((ch, key) => {
     if (picker) return; // the picker reads the keys while it is open
     if (question) {
+      // Ctrl-C declines the question and stops its owner only: the lead's turn, or that subagent.
       if (key.ctrl && ch === "c") {
         question.answer(false, "declined (cancelled)");
-        abort.current?.abort();
-        restore();
+        if (question.owner) question.owner.stop();
+        else {
+          abort.current?.abort();
+          restore();
+        }
       } else if (key.escape) question.answer(false, "declined"); // that action only; the turn goes on
       else if (ch === "y" || ch === "n") question.answer(ch === "y", ch === "y" ? "allowed" : "declined");
       return;
```


**Step 4: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 1 failed | 36 passed | 2 skipped (39); Tests 1 failed | 613 passed | 10 skipped (624).

**Step 5: Commit**

```bash
git add src/cli.tsx src/core/permissions.ts src/tui/App.tsx tests/core/permissions.test.ts tests/tui/app.test.tsx
git commit -m "feat: the lead's and the subagents' questions wait in one line, each stopping only its owner"
```

### Task 8: The session runs a reply's delegate calls together and hands the lead waiting answers after its tool results

The session's two changes (release 4 design, "How it is built"; choice 8).
- **Side by side:** a tool marked `parallel` (Task 10's `delegate`) has all its calls in one reply
  start together. The reply's other calls still run one after another, and the results stay in
  the reply's order.
- **Waiting answers:** the new `inbox` option is read before each request the lead makes. Its text
  goes after that request's tool results, or after the prompt the user typed, as text parts marked
  `from: "tasks"`, as Anthropic advises (never inside a tool result). `send("")` with nothing
  waiting sends nothing.

The screen does not print those parts again, since each was shown when it arrived ("t3
finished"). Ctrl+O's last turn now starts at a user message that is not tool results, so a turn
started by background answers alone counts.

**Files:**
- Modify: `src/core/session.ts`
- Modify: `src/core/types.ts`
- Modify: `src/tools/tool.ts`
- Modify: `src/tui/describe.ts`
- Modify: `tests/core/session.test.ts`
- Modify: `tests/tui/statusline.test.tsx`

**Step 1: Write the failing tests**

**Change `tests/core/session.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/core/session.test.ts b/tests/core/session.test.ts
index ad4affd..c287271 100644
--- a/tests/core/session.test.ts
+++ b/tests/core/session.test.ts
@@ -319,3 +319,53 @@ describe("Session tool events", () => {
     expect(seen).toEqual([]);
   });
 });
+
+describe("Session, for subagents", () => {
+  const calls = (...c: [string, string, unknown][]) => ({ parts: c.map(([id, name, input]) => ({ type: "tool_call" as const, id, name, input })), usage });
+  const note = (text: string) => ({ type: "text" as const, text, from: "tasks" as const });
+
+  it("puts text waiting for the lead after the next request's tool results, each once", async () => {
+    const box: string[] = [];
+    const finish = defineTool("finish", "A background task finishes while this runs", z.object({}), async () => (box.push("t3 finished: found it"), "ok"));
+    const lead = new FakeProvider("a", [callTool("c1", "finish", {}), callTool("c2", "echo", { text: "x" }), reply("done")]);
+    const session = new Session({ lead, tools: [finish, echo], system: "t", ctx: await tempContext(), bus: new Bus(), inbox: () => box.splice(0) });
+    await session.send("go");
+    expect(session.messages[0]!.parts).toEqual([{ type: "text", text: "go" }]);
+    expect(session.messages[2]!.parts).toEqual([{ type: "tool_result", callId: "c1", output: "ok", isError: false }, note("t3 finished: found it")]);
+    expect(session.messages[4]!.parts).toEqual([{ type: "tool_result", callId: "c2", output: "x", isError: false }]);
+    expect(lead.seen[1]!.at(-1)!.parts.at(-1)).toEqual(note("t3 finished: found it"));
+  });
+
+  it("puts text already waiting after the user's prompt, and starts a turn with only waiting text", async () => {
+    const box = ["t3 was stopped by the user"];
+    const lead = new FakeProvider("a", [reply("ok"), reply("read it")]);
+    const session = new Session({ lead, tools: [], system: "t", ctx: await tempContext(), bus: new Bus(), inbox: () => box.splice(0) });
+    await session.send("go");
+    expect(session.messages[0]!.parts).toEqual([{ type: "text", text: "go" }, note("t3 was stopped by the user")]);
+    box.push("t4 finished: x");
+    await session.send("");
+    expect(session.messages[2]!.parts).toEqual([note("t4 finished: x")]);
+    await session.send(""); // nothing typed and nothing waiting: no request
+    expect(lead.seen).toHaveLength(2);
+  });
+
+  it("starts a reply's calls of a side-by-side tool together, the others one after another, results in order", async () => {
+    const started: string[] = [];
+    let release!: () => void;
+    const both = new Promise<void>((r) => (release = r));
+    // Each waits for the other to start, so run one after another they would never finish.
+    const together = {
+      ...defineTool("together", "Runs beside its kind", z.object({ n: z.number() }), async ({ n }) => {
+        started.push(`together ${n}`);
+        if (started.filter((s) => s.startsWith("together")).length === 2) release();
+        await both;
+        return `t${n}`;
+      }),
+      parallel: true,
+    };
+    const lead = new FakeProvider("a", [calls(["c1", "together", { n: 1 }], ["c2", "echo", { text: "e" }], ["c3", "together", { n: 2 }]), reply("done")]);
+    const session = new Session({ lead, tools: [together, echo], system: "t", ctx: await tempContext(), bus: new Bus() });
+    await session.send("go");
+    expect(session.messages[2]!.parts.map((p) => (p.type === "tool_result" ? p.output : ""))).toEqual(["t1", "e", "t2"]);
+  });
+});
```

**Change `tests/tui/statusline.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/statusline.test.tsx b/tests/tui/statusline.test.tsx
index cc3f0b3..c75c993 100644
--- a/tests/tui/statusline.test.tsx
+++ b/tests/tui/statusline.test.tsx
@@ -129,6 +129,10 @@ describe("describe", () => {
     expect(shown("shell", { command: 5 })).toBe('● shell {"command":5}'); // nothing it can summarise
   });
 
+  it("does not show text a background task added for the lead", () => {
+    expect(describeMessage({ role: "user", parts: [{ type: "text", text: "go" }, { type: "text", text: "t3 finished: x", from: "tasks" }] })).toEqual([{ text: "> go", color: "cyan" }]);
+  });
+
   it("does not show an unknown kind of part as a tool result", () => {
     expect(describeMessage({ role: "assistant", parts: [{ type: "thinking" } as never] })).toEqual([]);
   });
@@ -161,6 +165,17 @@ describe("lastTurn", () => {
     ]);
   });
 
+  it("counts a turn started by a background task's answer as a turn, but not its answers after tool results", () => {
+    const lines = lastTurn([
+      { role: "user", parts: [{ type: "text", text: "one" }] },
+      { role: "assistant", parts: [{ type: "tool_call", id: "c0", name: "shell", input: {} }] },
+      { role: "user", parts: [{ type: "tool_result", callId: "c0", output: "ok", isError: false }, { type: "text", text: "t2 finished", from: "tasks" }] },
+      { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "shell", input: {} }] },
+    ]);
+    expect(lines[0]).toEqual({ text: "Last turn: 2 tool calls", color: "gray" });
+    expect(lastTurn([{ role: "user", parts: [{ type: "text", text: "t3 finished", from: "tasks" }] }])[0]).toEqual({ text: "Last turn: 0 tool calls", color: "gray" });
+  });
+
   it("is cleaned of escape codes when shown, like every scrollback line", () => {
     const [, call] = lastTurn([
       { role: "user", parts: [{ type: "text", text: "go" }] },
```


**Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/core/session.test.ts tests/tui/statusline.test.tsx`

Expected: FAIL. In the scratch build: Test Files 2 failed (2); Tests 5 failed | 55 passed (60). The session has no `inbox`, and runs every call one after another.

**Step 3: Write the code**

**Change `src/core/session.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/core/session.ts b/src/core/session.ts
index 326ef3c..a3295cf 100644
--- a/src/core/session.ts
+++ b/src/core/session.ts
@@ -2,7 +2,7 @@ import { MAX_TOOL_OUTPUT } from "../exec/executor.js";
 import type { Tool, ToolContext } from "../tools/tool.js";
 import type { Bus, ToolOutcome } from "./bus.js";
 import { Declined } from "./permissions.js";
-import { errorText, type Message, type Provider, type ToolCall, type ToolResult, type Turn } from "./types.js";
+import { errorText, type Message, type Part, type Provider, type ToolCall, type ToolResult, type Turn } from "./types.js";
 
 function truncate(s: string): string {
   return s.length <= MAX_TOOL_OUTPUT ? s : `${s.slice(0, MAX_TOOL_OUTPUT)}\n[cut: ${s.length - MAX_TOOL_OUTPUT} more characters]`;
@@ -15,6 +15,9 @@ export interface SessionOptions {
   system: string; // fixed for the whole session: prompt caching and Anthropic thinking blocks need it unchanged
   ctx: Omit<ToolContext, "signal">;
   bus: Bus;
+  // Takes the text waiting for the lead, such as background subagents' answers, so each goes into
+  // exactly one request (release 4 design, "Background subagents").
+  inbox?: () => string[];
 }
 
 export class Session {
@@ -36,6 +39,7 @@ export class Session {
     this.opts.bus.emit("lead", provider.id);
   }
 
+  // An empty `text` starts a turn with only the waiting text, when there is any.
   async send(text: string, signal?: AbortSignal): Promise<void> {
     // Two turns at once would interleave their messages and tool results in the history.
     if (this.#running) throw new Error("A turn is already running");
@@ -49,7 +53,9 @@ export class Session {
 
   async #turn(text: string, signal?: AbortSignal): Promise<void> {
     const { bus } = this.opts;
-    this.#push({ role: "user", parts: [{ type: "text", text }] });
+    const parts: Part[] = [...(text ? [{ type: "text" as const, text }] : []), ...this.#waiting()];
+    if (!parts.length) return;
+    this.#push({ role: "user", parts });
 
     for (;;) {
       const lead = this.#lead;
@@ -90,9 +96,14 @@ export class Session {
       }
       if (calls.length === 0) return;
 
-      const results: ToolResult[] = [];
-      for (const call of calls) results.push(await this.#runTool(call, signal));
-      this.#push({ role: "user", parts: results });
+      // Calls of a side-by-side tool (delegate) all start first, together; the rest run one after
+      // another. The results go back in the reply's order, then whatever is waiting for the lead,
+      // after the last tool result, as the providers want it.
+      const results: ToolResult[] = new Array(calls.length);
+      const together = calls.map((c, i) => (this.opts.tools.find((t) => t.spec.name === c.name)?.parallel ? this.#runTool(c, signal).then((r) => (results[i] = r)) : null));
+      for (const [i, call] of calls.entries()) if (!together[i]) results[i] = await this.#runTool(call, signal);
+      await Promise.all(together);
+      this.#push({ role: "user", parts: [...results, ...this.#waiting()] });
       if (signal?.aborted) return;
     }
   }
@@ -138,6 +149,10 @@ export class Session {
     }
   }
 
+  #waiting(): Part[] {
+    return (this.opts.inbox?.() ?? []).map((text) => ({ type: "text", text, from: "tasks" }));
+  }
+
   #push(message: Message): void {
     this.messages.push(message);
     this.opts.bus.emit("message", message);
```

**Change `src/core/types.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/core/types.ts b/src/core/types.ts
index b400eee..7046830 100644
--- a/src/core/types.ts
+++ b/src/core/types.ts
@@ -1,7 +1,9 @@
 // The conversation format Tachikoma stores. No provider owns it; each adapter converts to and from it.
 
 export type Part =
-  | { type: "text"; text: string }
+  // `from: "tasks"`: text the session added for the lead, such as a background subagent's answer, not
+  // something the user typed.
+  | { type: "text"; text: string; from?: "tasks" }
   | { type: "tool_call"; id: string; name: string; input: unknown }
   | { type: "tool_result"; callId: string; output: string; isError: boolean };
 
```

**Change `src/tools/tool.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tools/tool.ts b/src/tools/tool.ts
index 2f8971d..51d6a60 100644
--- a/src/tools/tool.ts
+++ b/src/tools/tool.ts
@@ -13,6 +13,7 @@ export interface ToolContext {
 export interface Tool {
   spec: ToolSpec;
   run(input: unknown, ctx: ToolContext): Promise<string>;
+  parallel?: boolean; // a reply's calls of it start together (delegate); other calls run one after another
 }
 
 // A tool whose input is checked against its schema before it runs. Model output is untrusted.
```

**Change `src/tui/describe.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/describe.ts b/src/tui/describe.ts
index 475ba83..1f671c4 100644
--- a/src/tui/describe.ts
+++ b/src/tui/describe.ts
@@ -33,6 +33,7 @@ export function screen(l: Line): Line {
 export function describe(m: Message): Line[] {
   const lines: Line[] = [];
   for (const p of m.parts) {
+    if (p.type === "text" && p.from === "tasks") continue; // shown when it arrived, as "t3 finished"
     if (p.type === "text") lines.push(m.role === "user" ? { text: `> ${p.text}`, color: "cyan" } : { text: p.text });
     else if (p.type === "tool_call") lines.push({ text: `● ${p.name} ${brief(p.name, p.input) ?? JSON.stringify(p.input)}`, color: "yellow", oneLine: true });
     else if (p.type === "tool_result") lines.push({ text: `  ⎿ ${p.isError ? firstLine(p.output) : "ok"}`, color: p.isError ? "red" : "gray", oneLine: true });
@@ -44,9 +45,10 @@ export function describe(m: Message): Line[] {
 }
 
 // Ctrl+O: every tool call of the latest turn, from its prompt on, with its full input and result,
-// under a heading. A call of a turn still running may have no result yet.
+// under a heading. A call of a turn still running may have no result yet. A turn starts with a user
+// message that is not tool results: a prompt, or background answers alone.
 export function lastTurn(messages: Message[]): Line[] {
-  const start = messages.findLastIndex((m) => m.role === "user" && m.parts.some((p) => p.type === "text"));
+  const start = messages.findLastIndex((m) => m.role === "user" && !m.parts.some((p) => p.type === "tool_result"));
   if (start === -1) return [{ text: "No turn yet, so no tool calls to show.", color: "gray" }];
   const parts = messages.slice(start).flatMap((m) => m.parts);
   const calls = parts.filter((p) => p.type === "tool_call");
```


**Step 4: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 2 failed | 35 passed | 2 skipped (39); Tests 2 failed | 617 passed | 10 skipped (629).

**Step 5: Commit**

```bash
git add src/core/session.ts src/core/types.ts src/tools/tool.ts src/tui/describe.ts tests/core/session.test.ts tests/tui/statusline.test.tsx
git commit -m "feat: the session runs a reply's delegate calls together and hands the lead waiting answers after its tool results"
```

### Task 9: The task manager runs subagents, at most --max-tasks at once, and keeps background answers for the lead

`src/core/tasks.ts` (release 4 design, "Subagents and the delegate tool" and "Background
subagents"; choice 9).
- **`start(task, { background, signal })`** numbers the subagent (t1, t2 and so on through the
  session) and runs it as its own `Session`, with its own conversation, tools and model, so
  refusals, the fallback model and stopping work as they do for the lead.
- **At most `--max-tasks` at once;** past that, a subagent waits for a place, first come first
  served.
- **Each one's state, time, output tokens, cost and latest tool call,** for the panel and
  `/tasks`. Each subagent has its own bus: its spending reaches the lead's bus marked with its id,
  so the status line's totals include it, while the context figure stays the lead's alone. Its
  errors are logged with its id in front ("t1: ").
- **Waiting answers:** a finished background subagent's answer waits, and `take()` hands each one
  over once, for the session's `inbox`. `wakes()` says whether any should start a turn.
- **`stop(id?)`** stops one subagent, or all of them.

`tests/helpers.ts` gains `Held`, a fake provider that answers only when the test lets it.

**Files:**
- Modify: `src/core/bus.ts`
- Modify: `src/core/session.ts`
- Modify: `src/core/stats.ts`
- Create: `src/core/tasks.ts`
- Create: `tests/core/tasks.test.ts`

**Step 1: Write the failing tests**

**Create `tests/core/tasks.test.ts`:**

```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type Ask, type Owner, PermissionGate } from "../../src/core/permissions.js";
import { Stats } from "../../src/core/stats.js";
import { Tasks } from "../../src/core/tasks.js";
import type { CompletionRequest, Provider, Turn } from "../../src/core/types.js";
import { MAX_TOOL_OUTPUT } from "../../src/exec/executor.js";
import { readFileTool } from "../../src/tools/files.js";
import { Bus, FakeProvider, callTool, collectErrors, reply, tempContext } from "../helpers.js";

async function setup(worker: Provider | (() => Provider), opts: { max?: number; ask?: Ask } = {}) {
  const bus = new Bus();
  const ctx = await tempContext();
  const gate = new PermissionGate("project", opts.ask ?? (async () => false));
  const tasks = new Tasks({ bus, max: opts.max ?? 8, worker: typeof worker === "function" ? worker : () => worker, system: "sub", tools: [readFileTool], ctx: { ...ctx, gate } });
  return { bus, tasks, ctx, errors: collectErrors(bus) };
}

// A worker whose every reply waits until the test sends it, or until the subagent is stopped.
class Held implements Provider {
  readonly id = "fake:held";
  readonly asked: CompletionRequest[] = [];
  #replies: ((t: Turn) => void)[] = [];
  complete(req: CompletionRequest): Promise<Turn> {
    this.asked.push(req);
    return new Promise((resolve, reject) => {
      this.#replies.push(resolve);
      req.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  }
  answer(text: string) {
    this.#replies.shift()!(reply(text));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("Tasks", () => {
  it("runs a subagent in a conversation of its own, with its own prompt and tools, and returns its last reply", async () => {
    const worker = new Held();
    const { tasks } = await setup(worker);
    const t = tasks.start("find the login code", { background: false });
    await settle();
    expect(worker.asked[0]!.system).toBe("sub");
    expect(worker.asked[0]!.tools.map((s) => s.name)).toEqual(["read_file"]);
    expect(worker.asked[0]!.messages).toEqual([{ role: "user", parts: [{ type: "text", text: "find the login code" }] }]);
    expect(tasks.all.map((x) => [x.id, x.state, x.model])).toEqual([["t1", "running", "fake:held"]]);
    worker.answer("It is in src/auth.ts:12");
    expect(await t.done).toEqual({ state: "done", text: "It is in src/auth.ts:12" });
    expect(tasks.all[0]!.state).toBe("done");
    expect(tasks.take()).toEqual([]); // the waiting delegate call had it
  });

  it("numbers subagents through the session", async () => {
    const { tasks } = await setup(new FakeProvider("w", [reply("a"), reply("b"), reply("c")]));
    for (const task of ["a", "b", "c"]) await tasks.start(task, { background: false }).done;
    expect(tasks.all.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("keeps a background subagent's answer for the lead, handed over once, and says when anything changed", async () => {
    const { tasks, bus } = await setup(new FakeProvider("w", [reply("found it")]));
    let changes = 0;
    bus.on("tasks", () => changes++);
    await tasks.start("find x", { background: true }).done;
    expect(tasks.wakes()).toBe(true);
    expect(tasks.take()).toEqual(["Background task t1 (find x) finished:\nfound it"]);
    expect(tasks.take()).toEqual([]);
    expect(tasks.wakes()).toBe(false);
    expect(changes).toBeGreaterThan(0);
  });

  it("cuts a long answer at the size every tool's output is cut at", async () => {
    const { tasks } = await setup(new FakeProvider("w", [reply("x".repeat(MAX_TOOL_OUTPUT + 5))]));
    await tasks.start("find x", { background: true }).done;
    expect(tasks.take()[0]).toMatch(/\n\[cut: 5 more characters\]$/);
  });

  it("runs no more than the most at once; the next waits for a free place", async () => {
    const worker = new Held();
    const { tasks } = await setup(worker, { max: 2 });
    for (const n of [1, 2, 3]) tasks.start(`job ${n}`, { background: true });
    await settle();
    expect(tasks.all.map((t) => t.state)).toEqual(["running", "running", "waiting"]);
    expect(worker.asked).toHaveLength(2);
    worker.answer("one");
    await settle();
    expect(tasks.all.map((t) => t.state)).toEqual(["done", "running", "running"]);
  });

  it("gives a failure as the answer, with the reason, and logs it as the subagent's", async () => {
    const { tasks, errors } = await setup(new FakeProvider("w", [new Error("rate limited")]));
    expect(await tasks.start("find x", { background: true }).done).toEqual({ state: "failed", text: "rate limited" });
    expect(tasks.wakes()).toBe(true);
    expect(tasks.take()).toEqual(["Background task t1 (find x) failed: rate limited"]);
    expect(errors.map((e) => [e.kind, e.attempted, e.message])).toEqual([["provider", "t1: request to fake:w", "rate limited"]]);
  });

  it("does not wake the lead for a subagent the user stopped, but tells it with the next message", async () => {
    const worker = new Held();
    const { tasks } = await setup(worker);
    const bg = tasks.start("find x", { background: true });
    const fg = tasks.start("find y", { background: false });
    await settle();
    expect(tasks.stop("t1")).toBe(true);
    expect(await bg.done).toEqual({ state: "stopped", text: "t1 was stopped by the user before it finished." });
    expect(tasks.wakes()).toBe(false);
    expect(tasks.take()).toEqual(["Background task t1 (find x) was stopped by the user before it finished."]);
    expect(tasks.stop()).toBe(true); // all
    expect((await fg.done).state).toBe("stopped");
    expect(tasks.stop("t9")).toBe(false);
    expect(tasks.stop("t1")).toBe(false); // no longer running
  });

  it("stops the subagents a turn waits for when the turn stops, not background ones", async () => {
    const worker = new Held();
    const { tasks } = await setup(worker);
    const turn = new AbortController();
    const fg = tasks.start("a", { background: false, signal: turn.signal });
    tasks.start("b", { background: true });
    await settle();
    turn.abort();
    expect(await fg.done).toEqual({ state: "stopped", text: "t1 was stopped." });
    expect(tasks.all[1]!.state).toBe("running");
    expect(tasks.take()).toEqual([]);
  });

  it("never runs a subagent stopped while it waited for a place", async () => {
    const worker = new Held();
    const { tasks } = await setup(worker, { max: 1 });
    tasks.start("a", { background: true });
    const b = tasks.start("b", { background: true });
    await settle();
    tasks.stop("t2");
    expect((await b.done).state).toBe("stopped");
    worker.answer("x");
    await settle();
    expect(worker.asked).toHaveLength(1);
  });

  it("reports its spend on the lead's bus, marked, so the totals grow while the context stays the lead's", async () => {
    const { tasks, bus } = await setup(new FakeProvider("w", [reply("x")]));
    const stats = new Stats(bus);
    bus.emit("usage", { provider: "anthropic:claude-opus-5-5", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } });
    const marked: (string | undefined)[] = [];
    bus.on("usage", (u) => marked.push(u.task));
    await tasks.start("x", { background: false }).done;
    expect(marked).toEqual(["t1"]);
    expect([stats.input, stats.output, stats.context]).toEqual([110, 15, 110]);
    expect([tasks.all[0]!.output, tasks.all[0]!.costUnknown]).toEqual([5, true]); // a fake model has no price
  });

  it("keeps each subagent's latest tool call for the panel", async () => {
    const { tasks } = await setup(new FakeProvider("w", [callTool("c1", "read_file", { path: "a.txt" }), reply("none")]));
    await tasks.start("x", { background: false }).done;
    expect(tasks.all[0]!.lastTool).toEqual({ name: "read_file", input: { path: "a.txt" } });
  });

  it("asks before a read outside the project, naming the subagent, which Ctrl-C there stops", async () => {
    const owners: Owner[] = [];
    const elsewhere = path.resolve("/elsewhere/notes.txt");
    const { tasks } = await setup(new FakeProvider("w", [callTool("c1", "read_file", { path: elsewhere }), reply("x")]), {
      ask: async (_summary, _detail, owner) => {
        owners.push(owner!);
        owner!.stop();
        return false;
      },
    });
    expect((await tasks.start("find the notes", { background: false }).done).state).toBe("stopped");
    expect(owners.map((o) => o.name)).toEqual(["t1 (find the notes)"]);
  });

  it("fails to start when no worker model can be made", async () => {
    const { tasks } = await setup(() => {
      throw new Error("Set ANTHROPIC_API_KEY to use anthropic");
    });
    expect(() => tasks.start("x", { background: false })).toThrow("Set ANTHROPIC_API_KEY to use anthropic");
    expect(tasks.all).toEqual([]);
  });

  it("takes finished subagents off the panel at the next turn the user starts, keeping running ones", async () => {
    const worker = new Held();
    const { tasks } = await setup(worker);
    const a = tasks.start("a", { background: true });
    tasks.start("b", { background: true });
    await settle();
    worker.answer("x");
    await a.done;
    tasks.clearFinished();
    expect(tasks.all.map((t) => t.shown)).toEqual([false, true]);
    expect(tasks.running).toBe(1);
  });
});
```


**Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/core/tasks.test.ts`

Expected: FAIL. In the scratch build: Test Files 1 failed (1), before any test runs. `src/core/tasks.ts` does not exist yet.

**Step 3: Write the code**

**Change `src/core/bus.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/core/bus.ts b/src/core/bus.ts
index 04d930d..2ae356e 100644
--- a/src/core/bus.ts
+++ b/src/core/bus.ts
@@ -15,13 +15,14 @@ export type ToolOutcome = "ok" | "failed" | "declined" | "cancelled";
 
 export interface Events {
   message: [Message];
-  usage: [{ provider: string; usage: Usage; priceKnown?: boolean }];
+  usage: [{ provider: string; usage: Usage; priceKnown?: boolean; task?: string }]; // `task`: a subagent's, such as "t3"
   error: [ErrorEvent];
   lead: [string];
   // Each call the session takes up, as it runs; its result reaches the conversation with the others.
   "tool-start": [{ id: string; name: string; input: unknown }];
   "tool-end": [{ id: string; outcome: ToolOutcome }];
   todo: [TodoItem[]]; // the lead's new to-do list
+  tasks: []; // a subagent started, changed or finished
 }
 
 // The session emits; the interface, status line, headless output and error log listen.
```

**Change `src/core/session.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/core/session.ts b/src/core/session.ts
index a3295cf..41dea42 100644
--- a/src/core/session.ts
+++ b/src/core/session.ts
@@ -4,7 +4,7 @@ import type { Bus, ToolOutcome } from "./bus.js";
 import { Declined } from "./permissions.js";
 import { errorText, type Message, type Part, type Provider, type ToolCall, type ToolResult, type Turn } from "./types.js";
 
-function truncate(s: string): string {
+export function truncate(s: string): string {
   return s.length <= MAX_TOOL_OUTPUT ? s : `${s.slice(0, MAX_TOOL_OUTPUT)}\n[cut: ${s.length - MAX_TOOL_OUTPUT} more characters]`;
 }
 
```

**Change `src/core/stats.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/core/stats.ts b/src/core/stats.ts
index 82e4495..707914b 100644
--- a/src/core/stats.ts
+++ b/src/core/stats.ts
@@ -7,15 +7,16 @@ export class Stats {
   output = 0;
   cost = 0; // USD, for calls whose price is known
   unpriced = 0; // calls with no known price
-  context = 0; // size of the most recent request plus its reply
+  context = 0; // size of the lead's most recent request plus its reply
   errors = 0; // a refusal another model answered is not one
 
   constructor(bus: Bus) {
-    bus.on("usage", ({ provider, usage, priceKnown }) => {
+    // A subagent's spend counts toward the totals; its context is its own, not the lead's.
+    bus.on("usage", ({ provider, usage, priceKnown, task }) => {
       const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
       this.input += prompt;
       this.output += usage.output;
-      this.context = prompt + usage.output;
+      if (task === undefined) this.context = prompt + usage.output;
       const c = priceKnown === false ? null : cost(provider, usage);
       if (c === null) this.unpriced++;
       else this.cost += c;
```

**Create `src/core/tasks.ts`:**

```ts
import { cost } from "../providers/pricing.js";
import type { Tool, ToolContext } from "../tools/tool.js";
import { Bus, type ErrorEvent } from "./bus.js";
import type { Owner, PermissionGate } from "./permissions.js";
import { Session, truncate } from "./session.js";
import type { Message, Provider } from "./types.js";

export type TaskState = "waiting" | "running" | "done" | "failed" | "stopped";

// How a subagent ended: its answer, the reason it failed, or that it was stopped.
export interface Result {
  state: "done" | "failed" | "stopped";
  text: string;
}

// One subagent, as the panel and /tasks show it.
export interface Task {
  id: string; // t1, t2 and so on through the session
  task: string; // what it was asked to find out, as the model wrote it
  model: string;
  background: boolean;
  state: TaskState;
  started: number;
  ended?: number;
  output: number; // tokens written
  cost: number; // USD, for requests whose price is known
  costUnknown: boolean;
  lastTool: { name: string; input: unknown } | null;
  shown: boolean; // on the panel: finished ones leave it at the next turn the user starts
  messages: Message[]; // its conversation, for /tasks t3
  done: Promise<Result>;
}

export interface TasksOptions {
  bus: Bus; // the lead's: subagents' spend and errors are reported there, marked with the subagent
  max: number; // --max-tasks
  worker: () => Provider; // the model for a new subagent; throws when none can be made
  fallback?: Provider;
  system: string; // the subagents' system prompt, instructions included
  tools: Tool[];
  ctx: Omit<ToolContext, "signal" | "gate"> & { gate: PermissionGate }; // the lead's; each subagent asks through gate.for(itself)
}

// The task manager (release 4 design, "How it is built"): starts subagents, each its own Session,
// keeps their state and spend, stops one or all, and keeps finished background answers until the
// lead's next request takes them.
export class Tasks {
  readonly all: Task[] = [];
  #inbox: { text: string; wake: boolean }[] = [];
  #free: number;
  #line: (() => void)[] = []; // subagents waiting for a free place, in order
  #stops = new Map<string, { stop: AbortController; byUser: boolean }>();

  constructor(private readonly opts: TasksOptions) {
    this.#free = opts.max;
  }

  get running(): number {
    return this.all.filter((t) => t.state === "running" || t.state === "waiting").length;
  }

  // `signal` is the lead's turn, for a subagent it waits for: stopping the turn stops it too.
  start(task: string, opts: { background: boolean; signal?: AbortSignal }): Task {
    const provider = this.opts.worker();
    const id = `t${this.all.length + 1}`;
    const stop = new AbortController();
    opts.signal?.addEventListener("abort", () => stop.abort(), { once: true });
    this.#stops.set(id, { stop, byUser: false });
    // `done` is set just below, before anything reads it.
    const t = { id, task, model: provider.id, background: opts.background, state: "waiting", started: Date.now(), output: 0, cost: 0, costUnknown: false, lastTool: null, shown: true, messages: [] } as Omit<Task, "done"> as Task;
    this.all.push(t);
    t.done = this.#run(t, provider, stop.signal);
    this.#changed();
    return t;
  }

  // By the user: one subagent, or with no id all of them. False when none was running.
  stop(id?: string): boolean {
    let any = false;
    for (const t of this.all) {
      if ((id === undefined || t.id === id) && (t.state === "running" || t.state === "waiting")) {
        const s = this.#stops.get(t.id)!;
        s.byUser = true;
        s.stop.abort();
        any = true;
      }
    }
    return any;
  }

  // Whether a waiting answer should start a turn: a stopped subagent's note waits for the next one.
  wakes(): boolean {
    return this.#inbox.some((i) => i.wake);
  }

  // Everything waiting for the lead, removed, so each goes into exactly one request.
  take(): string[] {
    return this.#inbox.splice(0).map((i) => i.text);
  }

  clearFinished(): void {
    for (const t of this.all) if (t.state !== "running" && t.state !== "waiting") t.shown = false;
    this.#changed();
  }

  async #run(t: Task, provider: Provider, signal: AbortSignal): Promise<Result> {
    const result = (await this.#place(signal)) ? await this.#work(t, provider, signal) : null;
    const stopped = this.#stops.get(t.id)!;
    const r: Result = result ?? { state: "stopped", text: "" };
    if (r.state === "stopped") r.text = `${t.id} was stopped${stopped.byUser ? " by the user before it finished" : ""}.`;
    t.state = r.state;
    t.ended = Date.now();
    const name = `Background task ${t.id} (${t.task})`;
    if (t.background && r.state === "done") this.#inbox.push({ text: `${name} finished:\n${truncate(r.text)}`, wake: true });
    if (t.background && r.state === "failed") this.#inbox.push({ text: `${name} failed: ${r.text}`, wake: true });
    if (t.background && r.state === "stopped" && stopped.byUser) this.#inbox.push({ text: `${name} was stopped by the user before it finished.`, wake: false });
    this.#changed();
    return r;
  }

  // Null when it was stopped.
  async #work(t: Task, provider: Provider, signal: AbortSignal): Promise<Result | null> {
    const bus = new Bus();
    let failure: ErrorEvent | undefined;
    bus.on("usage", (u) => {
      t.output += u.usage.output;
      const c = u.priceKnown === false ? null : cost(u.provider, u.usage);
      if (c === null) t.costUnknown = true;
      else t.cost += c;
      this.opts.bus.emit("usage", { ...u, task: t.id });
      this.#changed();
    });
    bus.on("error", (e) => {
      if (e.kind !== "fallback" && e.kind !== "tool") failure = e;
      this.opts.bus.emit("error", { ...e, attempted: `${t.id}: ${e.attempted}` });
    });
    bus.on("tool-start", ({ name, input }) => {
      t.lastTool = { name, input };
      this.#changed();
    });
    const owner: Owner = { name: `${t.id} (${t.task})`, signal, stop: () => this.stop(t.id) };
    const { ctx } = this.opts;
    const session = new Session({ lead: provider, ...(this.opts.fallback ? { fallback: this.opts.fallback } : {}), tools: this.opts.tools, system: this.opts.system, ctx: { ...ctx, gate: ctx.gate.for(owner) }, bus });
    t.messages = session.messages;
    t.state = "running";
    this.#changed();
    try {
      await session.send(t.task, signal);
    } finally {
      this.#release();
    }
    if (signal.aborted) return null;
    const last = session.messages.at(-1);
    const text = last?.role === "assistant" ? last.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n") : "";
    if (text.trim() && !failure) return { state: "done", text };
    return { state: "failed", text: failure?.message ?? "it ended without an answer" };
  }

  // Resolves true once a place is free, taking it; false if the subagent is stopped first.
  #place(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.#free > 0) {
      this.#free--;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const go = () => {
        signal.removeEventListener("abort", leave);
        resolve(true);
      };
      const leave = () => {
        this.#line = this.#line.filter((g) => g !== go);
        resolve(false);
      };
      this.#line.push(go);
      signal.addEventListener("abort", leave, { once: true });
    });
  }

  #release(): void {
    const next = this.#line.shift();
    if (next) next();
    else this.#free++;
  }

  #changed(): void {
    this.opts.bus.emit("tasks");
  }
}
```


**Step 4: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 3 failed | 35 passed | 2 skipped (40); Tests 3 failed | 630 passed | 10 skipped (643).

**Step 5: Commit**

```bash
git add src/core/bus.ts src/core/session.ts src/core/stats.ts src/core/tasks.ts tests/core/tasks.test.ts
git commit -m "feat: the task manager runs subagents, at most --max-tasks at once, and keeps background answers for the lead"
```

### Task 10: The lead's delegate tool, --worker and --max-tasks

`src/tools/delegate.ts` (release 4 design, "Subagents and the delegate tool"; choice 10).
`delegate(task, background)` asks the task manager for a subagent:
- **Waiting** (the default): the call returns the subagent's answer. Esc stops the turn and the
  subagents it is waiting for.
- **`background: true`:** it returns at once, "Started t3 in the background; its answer will come
  in a later message." **With `-p`** it waits instead, and the result says so, since `-p` has no
  later turn.

A subagent gets `read_file`, `find_files` and `search_files` only (`SUBAGENT_TOOLS`), a prompt of
its own (`subagentPrompt` in `src/core/prompt.ts`), and the lead's instruction files. The CLI gains
`--worker <provider:model>` (or `TACHI_WORKER`), the model subagents use, which is the lead's
without it, and `--max-tasks <n>`, 8 by default (the user's probe, 2026-10-26).

**Files:**
- Modify: `src/cli.tsx`
- Modify: `src/core/prompt.ts`
- Create: `src/tools/delegate.ts`
- Modify: `src/tools/index.ts`
- Modify: `tests/cli.test.ts`
- Modify: `tests/core/prompt.test.ts`
- Create: `tests/tools/delegate.test.ts`

**Step 1: Write the failing tests**

**Change `tests/cli.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/cli.test.ts b/tests/cli.test.ts
index b18f514..0b5c29f 100644
--- a/tests/cli.test.ts
+++ b/tests/cli.test.ts
@@ -32,6 +32,19 @@ describe("tachi", { timeout: 15_000 }, () => {
     expect(r.stderr).toMatch(/^--fallback: /);
   });
 
+  it("names --worker when its value is bad, and takes TACHI_WORKER too", () => {
+    expect(tachi("--lead", "ollama:none", "--worker", "nope", "-p", "hi").stderr).toMatch(/^--worker: /);
+    expect(tachi("--lead", "ollama:none", "-p", "hi", { TACHI_WORKER: "nope" }).stderr).toMatch(/^--worker: /);
+  });
+
+  it("takes --max-tasks only as a whole number from 1", () => {
+    for (const bad of ["0", "x", "1.5"]) {
+      const r = tachi("--lead", "ollama:none", "--max-tasks", bad, "-p", "hi");
+      expect(r.code).toBe(1);
+      expect(r.stderr).toContain(`--max-tasks must be a whole number from 1 (got "${bad}")`);
+    }
+  });
+
   it("refuses a blank prompt instead of sending it", () => {
     for (const prompt of ["", "  "]) {
       const r = tachi("--lead", "ollama:none", "-p", prompt);
```

**Change `tests/core/prompt.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/core/prompt.test.ts b/tests/core/prompt.test.ts
index dd26319..285f180 100644
--- a/tests/core/prompt.test.ts
+++ b/tests/core/prompt.test.ts
@@ -1,5 +1,5 @@
 import { describe, expect, it } from "vitest";
-import { systemPrompt } from "../../src/core/prompt.js";
+import { subagentPrompt, systemPrompt } from "../../src/core/prompt.js";
 
 describe("systemPrompt", () => {
   it("gives PowerShell 5.1 a way to run a command only if the last one succeeded", () => {
@@ -14,3 +14,12 @@ describe("systemPrompt", () => {
     expect(systemPrompt("/proj", "linux")).not.toContain("asks the user before risky actions");
   });
 });
+
+describe("subagentPrompt", () => {
+  it("says the subagent only reads, and reports what it found with paths and line numbers", () => {
+    const prompt = subagentPrompt("/proj");
+    expect(prompt).toContain("The project root is /proj.");
+    expect(prompt).toContain("read_file, find_files and search_files");
+    expect(prompt).toContain("file paths and line numbers");
+  });
+});
```

**Create `tests/tools/delegate.test.ts`:**

```ts
import { describe, expect, it } from "vitest";
import { PermissionGate } from "../../src/core/permissions.js";
import { Tasks } from "../../src/core/tasks.js";
import type { Provider } from "../../src/core/types.js";
import { delegateTool } from "../../src/tools/delegate.js";
import { SUBAGENT_TOOLS } from "../../src/tools/index.js";
import { Bus, FakeProvider, reply, tempContext } from "../helpers.js";

async function setup(worker: Provider, headless = false) {
  const ctx = await tempContext();
  const tasks = new Tasks({ bus: new Bus(), max: 8, worker: () => worker, system: "sub", tools: SUBAGENT_TOOLS, ctx: { ...ctx, gate: new PermissionGate("project", async () => false) } });
  return { tasks, ctx, tool: delegateTool(tasks, { headless }) };
}

// A worker that answers only when stopped: it never finishes on its own.
const hanging = (): Provider => ({
  id: "fake:hang",
  complete: ({ signal }) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))),
});

describe("delegate", () => {
  it("waits for the subagent and returns its answer", async () => {
    const { tool, ctx } = await setup(new FakeProvider("w", [reply("It is in src/auth.ts:12")]));
    expect(await tool.run({ task: "find the login code" }, ctx)).toBe("It is in src/auth.ts:12");
  });

  it("with background, returns at once, the answer coming in a later message", async () => {
    const { tool, ctx, tasks } = await setup(new FakeProvider("w", [reply("found")]));
    expect(await tool.run({ task: "find x", background: true }, ctx)).toBe("Started t1 in the background; its answer will come in a later message.");
    await tasks.all[0]!.done;
    expect(tasks.take()).toEqual(["Background task t1 (find x) finished:\nfound"]);
  });

  it("with -p, runs a background task in the foreground and says why", async () => {
    const { tool, ctx, tasks } = await setup(new FakeProvider("w", [reply("found")]), true);
    expect(await tool.run({ task: "find x", background: true }, ctx)).toBe("t1 ran in the foreground, since -p has no later turn to read a background answer in.\n\nfound");
    expect(tasks.take()).toEqual([]);
  });

  it("gives a failure, with its reason, as the answer, so the lead knows", async () => {
    const { tool, ctx } = await setup(new FakeProvider("w", [new Error("rate limited")]));
    expect(await tool.run({ task: "find x" }, ctx)).toBe("t1 failed: rate limited");
  });

  it("says when the user stopped the subagent", async () => {
    const { tool, ctx, tasks } = await setup(hanging());
    const answer = tool.run({ task: "find x" }, ctx);
    await new Promise((r) => setTimeout(r, 20));
    tasks.stop("t1");
    expect(await answer).toBe("t1 was stopped by the user before it finished.");
  });

  it("stops the subagent when the turn waiting for it stops", async () => {
    const { tool, ctx, tasks } = await setup(hanging());
    const turn = new AbortController();
    const answer = tool.run({ task: "find x" }, { ...ctx, signal: turn.signal });
    await new Promise((r) => setTimeout(r, 20));
    turn.abort();
    await answer;
    expect(tasks.all[0]!.state).toBe("stopped");
  });

  it("runs beside the reply's other delegate calls, and gives subagents only the reading tools", async () => {
    const { tool } = await setup(hanging());
    expect(tool.parallel).toBe(true);
    expect(SUBAGENT_TOOLS.map((t) => t.spec.name)).toEqual(["read_file", "find_files", "search_files"]);
  });
});
```


**Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/cli.test.ts tests/core/prompt.test.ts tests/tools/delegate.test.ts`

Expected: FAIL. In the scratch build: Test Files 3 failed (3); Tests 3 failed | 11 passed (14). `src/tools/delegate.ts` does not exist yet, and the CLI knows neither option.

**Step 3: Write the code**

**Change `src/cli.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/cli.tsx b/src/cli.tsx
index 85cd5ee..47e6f4f 100644
--- a/src/cli.tsx
+++ b/src/cli.tsx
@@ -10,21 +10,27 @@ import { Bus } from "./core/bus.js";
 import { attachErrorLog } from "./core/errorlog.js";
 import { readInstructions } from "./core/instructions.js";
 import { type Ask, MODES, type Mode, PermissionGate } from "./core/permissions.js";
-import { systemPrompt } from "./core/prompt.js";
+import { subagentPrompt, systemPrompt } from "./core/prompt.js";
 import { Session } from "./core/session.js";
 import { Stats } from "./core/stats.js";
+import { Tasks } from "./core/tasks.js";
 import { errorText, type Provider } from "./core/types.js";
 import { LocalExecutor } from "./exec/local.js";
 import { EFFORTS, type Effort } from "./providers/anthropic.js";
 import { listModels } from "./providers/models.js";
 import { createProvider } from "./providers/registry.js";
-import { TOOLS } from "./tools/index.js";
+import { delegateTool } from "./tools/delegate.js";
+import { SUBAGENT_TOOLS, TOOLS } from "./tools/index.js";
 import { todoTool } from "./tools/todo.js";
 import { App } from "./tui/App.js";
 import { gitBranch } from "./tui/git.js";
 import { historyFile } from "./tui/history.js";
 import { SEGMENTS } from "./tui/StatusLine.js";
 
+// Eight Claude Haiku 5.5 subagents ran at once on the user's account with none refused; eight was the
+// most tried (release 4 design, "Before the build", 2026-10-26).
+const MAX_TASKS = 8;
+
 const HELP = `tachi: a coding agent for your terminal
 
 Usage:
@@ -41,6 +47,8 @@ Options:
   --mode <mode>     when to ask before acting: ${MODES.join(" | ")} (default: ask)
   --effort <level>  Anthropic models only: ${EFFORTS.join(" | ")}
   --fallback <spec> retry a turn the lead refuses on this model, e.g. openai:<model> (off unless set)
+  --worker <spec>   the model subagents run on (or set TACHI_WORKER); the lead's model unless set
+  --max-tasks <n>   how many subagents run at once (default: ${MAX_TASKS})
   --status <list>   status line parts, comma-separated: ${SEGMENTS.join(",")}
   -p, --print <prompt>  run without the interface
   --json            with -p, print every event as one JSON line
@@ -106,6 +114,8 @@ try {
       mode: { type: "string" },
       effort: { type: "string" },
       fallback: { type: "string" },
+      worker: { type: "string" },
+      "max-tasks": { type: "string" },
       status: { type: "string" },
       print: { type: "string", short: "p" },
       json: { type: "boolean" },
@@ -128,6 +138,8 @@ if (parsed.raw && (parsed.print === undefined || parsed.json)) fail("--raw works
 if (parsed.raw) console.error("warning: --raw prints the answer exactly as the model wrote it; control codes in it can act on a terminal that shows it");
 const mode: Mode = oneOf("mode", parsed.mode, MODES) ?? "ask"; // the safest mode is the default
 const effort = oneOf<Effort>("effort", parsed.effort, EFFORTS);
+const maxTasks = parsed["max-tasks"] === undefined ? MAX_TASKS : Number(parsed["max-tasks"]);
+if (!Number.isInteger(maxTasks) || maxTasks < 1) fail(`--max-tasks must be a whole number from 1 (got "${parsed["max-tasks"]}")`);
 let segments;
 try {
   segments = statusSegments(parsed.status);
@@ -154,6 +166,14 @@ try {
 } catch (err) {
   fail(`--fallback: ${errorText(err)}`); // otherwise it reads like a bad lead
 }
+// Without --worker, a subagent uses the model leading when it starts.
+const workerSpec = parsed.worker ?? process.env.TACHI_WORKER;
+let worker: Provider | undefined;
+try {
+  if (workerSpec) worker = makeProvider(workerSpec);
+} catch (err) {
+  fail(`--worker: ${errorText(err)}`);
+}
 
 const interactive = parsed.print === undefined;
 // Before the instruction files are read, so nothing is asked with no terminal to answer.
@@ -180,9 +200,19 @@ let ask: Ask = async (summary, _detail, owner) => {
   return false;
 };
 const gate = new PermissionGate(mode, (summary, detail, owner) => ask(summary, detail, owner), interactive ? undefined : "Not allowed in -p mode, where nobody can approve it");
-// The to-do list is the lead's alone; the screen shows it from the bus.
-const tools = [...TOOLS, todoTool((items) => bus.emit("todo", items))];
-const session = new Session({ lead, fallback, tools, system, ctx: { root, executor: new LocalExecutor(), gate }, bus });
+const executor = new LocalExecutor();
+const tasks = new Tasks({
+  bus,
+  max: maxTasks,
+  worker: () => worker ?? session.lead,
+  ...(fallback ? { fallback } : {}),
+  system: [subagentPrompt(root), instructions.text].filter(Boolean).join("\n\n"), // the same instructions as the lead
+  tools: SUBAGENT_TOOLS,
+  ctx: { root, executor, gate },
+});
+// The to-do list and delegate are the lead's alone; the screen shows the list from the bus.
+const tools = [...TOOLS, todoTool((items) => bus.emit("todo", items)), delegateTool(tasks, { headless: !interactive })];
+const session: Session = new Session({ lead, fallback, tools, system, ctx: { root, executor, gate }, bus, inbox: () => tasks.take() });
 
 // The executor stops running commands from an "exit" handler, which dying by a signal skips.
 for (const sig of ["SIGTERM", "SIGHUP"] as const) process.on(sig, () => process.exit(128 + constants.signals[sig]));
```

**Change `src/core/prompt.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/core/prompt.ts b/src/core/prompt.ts
index dfbb2c9..5fb15f0 100644
--- a/src/core/prompt.ts
+++ b/src/core/prompt.ts
@@ -14,3 +14,14 @@ export function systemPrompt(root: string, platform: NodeJS.Platform = process.p
     "Read files before changing them, prefer edit_file to rewriting whole files, and say plainly when something failed.",
   ].join("\n");
 }
+
+// A subagent's own prompt, also fixed for its whole conversation (release 4 design, "What a subagent
+// is given").
+export function subagentPrompt(root: string): string {
+  return [
+    "You are a Tachikoma subagent. The lead agent gave you one task: to find something out in the user's project.",
+    `The project root is ${root}. File paths are relative to it.`,
+    "You can only read, with read_file, find_files and search_files. Call them directly.",
+    "When you know the answer, reply with what you found, citing file paths and line numbers. Your last reply is all the lead sees, so put everything it needs there.",
+  ].join("\n");
+}
```

**Create `src/tools/delegate.ts`:**

```ts
import { z } from "zod";
import type { Tasks } from "../core/tasks.js";
import { defineTool, type Tool } from "./tool.js";

// The lead's delegate tool (release 4 design, "Subagents and the delegate tool"). Several calls in one
// reply start together. With -p there is no later turn, so a background task runs in the foreground.
export function delegateTool(tasks: Tasks, opts: { headless: boolean }): Tool {
  const tool = defineTool(
    "delegate",
    "Hand a search or reading task to a subagent, which has read_file, find_files and search_files and reports what it found with file paths and line numbers. Write the task for someone who has not seen this conversation. Several delegate calls in one reply run at the same time. With background: true the call returns at once and the answer comes in a later message; otherwise it waits for the answer.",
    z.object({ task: z.string().min(1), background: z.boolean().optional() }),
    async ({ task, background = false }, ctx) => {
      if (background && !opts.headless) return `Started ${tasks.start(task, { background: true }).id} in the background; its answer will come in a later message.`;
      const t = tasks.start(task, { background: false, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      const r = await t.done;
      // A failure is the answer too, so the lead knows; the error itself is logged as the subagent's.
      const answer = r.state === "failed" ? `${t.id} failed: ${r.text}` : r.text;
      return background ? `${t.id} ran in the foreground, since -p has no later turn to read a background answer in.\n\n${answer}` : answer;
    },
  );
  return { ...tool, parallel: true };
}
```

**Change `src/tools/index.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tools/index.ts b/src/tools/index.ts
index 3b84683..a117b76 100644
--- a/src/tools/index.ts
+++ b/src/tools/index.ts
@@ -4,3 +4,5 @@ import { shellTool } from "./shell.js";
 import type { Tool } from "./tool.js";
 
 export const TOOLS: Tool[] = [readFileTool, writeFileTool, editFileTool, shellTool, findFilesTool, searchFilesTool];
+// Subagents only read (release 4 design): no writing, no shell, no delegate, so none starts another.
+export const SUBAGENT_TOOLS: Tool[] = [readFileTool, findFilesTool, searchFilesTool];
```


**Step 4: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 1 failed | 38 passed | 2 skipped (41); Tests 1 failed | 642 passed | 10 skipped (653).

**Step 5: Commit**

```bash
git add src/cli.tsx src/core/prompt.ts src/tools/delegate.ts src/tools/index.ts tests/cli.test.ts tests/core/prompt.test.ts tests/tools/delegate.test.ts
git commit -m "feat: the lead's delegate tool, --worker and --max-tasks"
```

### Task 11: A background answer that finishes while the lead is idle starts a turn reading it

Release 4 design, "Background subagents"; choice 11.
- **Finishing while the lead is idle** starts a turn by itself: the working line says "Reading t3's
  answer", and a grey line says "t3 finished" (or "failed", or "stopped"). Several waiting together
  go in one turn.
- **When a turn ends with answers waiting,** going idle checks them first, so they go before any
  queued prompt.
- **While a question or the model list is open,** the answer waits until it closes.
- **Quitting stops every subagent,** however the screen closes: `/exit`, or Ctrl-C or Ctrl-D
  twice.

The task manager gains `answering()`, the ids of the answers waiting, for the label. Clearing
finished subagents at the start of a turn now comes after the turn is marked as running: before,
the change it announced started the next queued prompt early. A test for it failed first.

**Files:**
- Modify: `src/cli.tsx`
- Modify: `src/core/tasks.ts`
- Modify: `src/tui/App.tsx`
- Modify: `src/tui/describe.ts`
- Modify: `tests/core/tasks.test.ts`
- Modify: `tests/helpers.ts`
- Modify: `tests/tui/app.test.tsx`

**Step 1: Write the failing tests**

**Change `tests/core/tasks.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/core/tasks.test.ts b/tests/core/tasks.test.ts
index 81eee14..3afed55 100644
--- a/tests/core/tasks.test.ts
+++ b/tests/core/tasks.test.ts
@@ -3,10 +3,10 @@ import { describe, expect, it } from "vitest";
 import { type Ask, type Owner, PermissionGate } from "../../src/core/permissions.js";
 import { Stats } from "../../src/core/stats.js";
 import { Tasks } from "../../src/core/tasks.js";
-import type { CompletionRequest, Provider, Turn } from "../../src/core/types.js";
+import type { Provider } from "../../src/core/types.js";
 import { MAX_TOOL_OUTPUT } from "../../src/exec/executor.js";
 import { readFileTool } from "../../src/tools/files.js";
-import { Bus, FakeProvider, callTool, collectErrors, reply, tempContext } from "../helpers.js";
+import { Bus, FakeProvider, Held, callTool, collectErrors, reply, tempContext } from "../helpers.js";
 
 async function setup(worker: Provider | (() => Provider), opts: { max?: number; ask?: Ask } = {}) {
   const bus = new Bus();
@@ -16,22 +16,6 @@ async function setup(worker: Provider | (() => Provider), opts: { max?: number;
   return { bus, tasks, ctx, errors: collectErrors(bus) };
 }
 
-// A worker whose every reply waits until the test sends it, or until the subagent is stopped.
-class Held implements Provider {
-  readonly id = "fake:held";
-  readonly asked: CompletionRequest[] = [];
-  #replies: ((t: Turn) => void)[] = [];
-  complete(req: CompletionRequest): Promise<Turn> {
-    this.asked.push(req);
-    return new Promise((resolve, reject) => {
-      this.#replies.push(resolve);
-      req.signal?.addEventListener("abort", () => reject(new Error("aborted")));
-    });
-  }
-  answer(text: string) {
-    this.#replies.shift()!(reply(text));
-  }
-}
 const settle = () => new Promise((r) => setTimeout(r, 20));
 
 describe("Tasks", () => {
```

**Change `tests/helpers.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/helpers.ts b/tests/helpers.ts
index 91445df..66e7dae 100644
--- a/tests/helpers.ts
+++ b/tests/helpers.ts
@@ -30,6 +30,24 @@ export class FakeProvider implements Provider {
   }
 }
 
+// A provider whose every request waits until the test answers it, or until it is stopped.
+export class Held implements Provider {
+  readonly asked: CompletionRequest[] = [];
+  #pending: ((t: Turn) => void)[] = [];
+  constructor(readonly id = "fake:held") {}
+  complete(req: CompletionRequest): Promise<Turn> {
+    this.asked.push(structuredClone({ ...req, signal: undefined }));
+    return new Promise((resolve, reject) => {
+      this.#pending.push(resolve);
+      req.signal?.addEventListener("abort", () => reject(new Error("aborted")));
+    });
+  }
+  // Answers the oldest request still waiting.
+  answer(turn: Turn | string) {
+    this.#pending.shift()!(typeof turn === "string" ? reply(turn) : turn);
+  }
+}
+
 export function collectErrors(bus: Bus): ErrorEvent[] {
   const errors: ErrorEvent[] = [];
   bus.on("error", (e) => errors.push(e));
```

**Change `tests/tui/app.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/app.test.tsx b/tests/tui/app.test.tsx
index c27ef9b..70faa21 100644
--- a/tests/tui/app.test.tsx
+++ b/tests/tui/app.test.tsx
@@ -10,12 +10,14 @@ import { Session } from "../../src/core/session.js";
 import { Stats } from "../../src/core/stats.js";
 import type { Provider } from "../../src/core/types.js";
 import type { TodoItem } from "../../src/tools/todo.js";
-import { TOOLS } from "../../src/tools/index.js";
+import { Tasks } from "../../src/core/tasks.js";
+import { delegateTool } from "../../src/tools/delegate.js";
+import { SUBAGENT_TOOLS, TOOLS } from "../../src/tools/index.js";
 import { History } from "../../src/tui/history.js";
 import type { ModelGroup } from "../../src/providers/models.js";
 import { App, type AppProps } from "../../src/tui/App.js";
 import { type Segment, SEGMENTS } from "../../src/tui/StatusLine.js";
-import { Bus, FakeProvider, callTool, reply, tempContext } from "../helpers.js";
+import { Bus, FakeProvider, Held, callTool, reply, tempContext, usage } from "../helpers.js";
 
 const tick = () => new Promise((r) => setTimeout(r, 50));
 
@@ -25,6 +27,12 @@ async function until(app: ReturnType<typeof render>, text: string) {
   expect(app.lastFrame()).toContain(text);
 }
 
+// Wait until `check` holds.
+async function waitFor(check: () => boolean) {
+  for (let i = 0; i < 40 && !check(); i++) await tick();
+  expect(check()).toBe(true);
+}
+
 // Wait until the screen no longer shows `text`.
 async function gone(app: ReturnType<typeof render>, text: string) {
   for (let i = 0; i < 40 && app.lastFrame()?.includes(text); i++) await tick();
@@ -63,6 +71,7 @@ async function mount(
     newLead?: Provider; // what /lead and the picker make
     rows?: number; // the terminal's height
     intro?: AppProps["intro"]; // the start line
+    worker?: Provider; // the subagents' model
     mode?: Mode; // the mode the session starts in
   } = {},
 ) {
@@ -72,12 +81,14 @@ async function mount(
   let ask: (s: string, d?: string, o?: Owner) => Promise<boolean> = async () => false;
   const gate = new PermissionGate(opts.mode ?? "ask", (s, d, o) => ask(s, d, o));
   const lead = opts.lead ?? new FakeProvider("a", turns);
-  const session = new Session({ lead, tools: TOOLS, system: "t", ctx: { ...ctx, gate }, bus });
+  const tasks = new Tasks({ bus, max: 8, worker: () => opts.worker ?? new FakeProvider("w", []), system: "sub", tools: SUBAGENT_TOOLS, ctx: { ...ctx, gate } });
+  const session = new Session({ lead, tools: [...TOOLS, delegateTool(tasks, { headless: false })], system: "t", ctx: { ...ctx, gate }, bus, inbox: () => tasks.take() });
   const historyFile = opts.historyFile ?? path.join(histories, `${nextHistory++}.jsonl`);
   if (opts.past) writeFileSync(historyFile, opts.past.map((p) => `${JSON.stringify(p)}\n`).join(""));
   const app = render(
     <App
       session={session}
+      tasks={tasks}
       bus={bus}
       stats={stats}
       mode={opts.mode ?? "ask"}
@@ -111,7 +122,7 @@ async function mount(
   Object.assign(app.stdout, { rows: opts.rows ?? 24 });
   app.stdout.emit("resize");
   await tick();
-  return { app, session, ctx, bus, historyFile, ask: (s: string, d?: string, o?: Owner) => ask(s, d, o) };
+  return { app, session, ctx, bus, tasks, historyFile, ask: (s: string, d?: string, o?: Owner) => ask(s, d, o) };
 }
 
 async function type(app: ReturnType<typeof render>, text: string) {
@@ -1051,6 +1062,108 @@ describe("App's space on screen", () => {
   });
 });
 
+describe("App's background subagents", () => {
+  const bg = (id: string, task: string) => callTool(id, "delegate", { task, background: true });
+  const note = (text: string) => ({ type: "text", text, from: "tasks" });
+
+  it("reads an answer that finishes while the lead is idle in a turn of its own, saying it finished", async () => {
+    const worker = new Held("fake:w");
+    const lead = new FakeProvider("a", [bg("c1", "find x"), reply("started it"), reply("t1 says found")]);
+    const { app } = await mount([], { lead, worker });
+    await type(app, "go");
+    await until(app, "started it");
+    worker.answer("found");
+    await until(app, "t1 says found");
+    expect(app.lastFrame()).toContain("t1 finished");
+    expect(lead.seen[2]!.at(-1)!.parts).toEqual([note("Background task t1 (find x) finished:\nfound")]);
+  });
+
+  it("hands the lead a failure during its turn with the next request's tool results, with no turn of its own", async () => {
+    const lead = new FakeProvider("a", [bg("c1", "find x"), reply("t1 broke")]);
+    const { app } = await mount([], { lead, worker: new FakeProvider("w", [new Error("rate limited")]) });
+    await type(app, "go");
+    await until(app, "t1 broke");
+    expect(app.lastFrame()).toContain("t1 failed");
+    expect(lead.seen[1]!.at(-1)!.parts.at(-1)).toEqual(note("Background task t1 (find x) failed: rate limited"));
+    await tick();
+    expect(lead.seen).toHaveLength(2);
+  });
+
+  it("shows that turn as reading the answer, and Esc stops it like any other", async () => {
+    const worker = new Held("fake:w");
+    const lead = new Held("fake:a");
+    const { app } = await mount([], { lead, worker });
+    await type(app, "go");
+    lead.answer(bg("c1", "find x"));
+    await waitFor(() => lead.asked.length === 2);
+    lead.answer("started");
+    await until(app, "started");
+    worker.answer("found");
+    await until(app, "Reading t1's answer");
+    await press(app, "\u001b");
+    await gone(app, "Reading t1's answer");
+  });
+
+  it("reads an answer that came during the lead's last request when the turn ends, before a queued prompt", async () => {
+    const worker = new Held("fake:w");
+    const lead = new Held("fake:a");
+    const { app } = await mount([], { lead, worker });
+    await type(app, "go");
+    lead.answer(bg("c1", "find x"));
+    await waitFor(() => lead.asked.length === 2); // the lead's last request, already sent
+    worker.answer("found");
+    await press(app, "q1", "\r");
+    lead.answer("started");
+    await waitFor(() => lead.asked.length === 3);
+    expect(lead.asked[2]!.messages.at(-1)!.parts).toEqual([note("Background task t1 (find x) finished:\nfound")]);
+    lead.answer("read it");
+    await waitFor(() => lead.asked.length === 4);
+    expect(lead.asked[3]!.messages.at(-1)!.parts).toEqual([{ type: "text", text: "q1" }]);
+    expect(lead.asked.flatMap((r) => r.messages).filter((m) => m.parts.some((p) => p.type === "text" && p.from === "tasks"))).toHaveLength(2); // in one request only, then in the history
+  });
+
+  it("waits while the model list is open, and reads the answer once it closes", async () => {
+    const worker = new Held("fake:w");
+    const lead = new FakeProvider("a", [bg("c1", "find x"), reply("started it"), reply("t1 says found")]);
+    const { app } = await mount([], { lead, worker, models: [{ provider: "fake", models: ["a", "b"] }] });
+    await type(app, "go");
+    await until(app, "started it");
+    await press(app, "\u001bp");
+    await until(app, "fake:b");
+    await tick(); // the picker starts reading keys just after it first appears
+    worker.answer("found");
+    await tick();
+    expect(lead.seen).toHaveLength(2);
+    await press(app, "\u001b");
+    await until(app, "t1 says found");
+  });
+
+  it("on Esc, stops the turn and the subagents it waits for, not background ones", async () => {
+    const lead = new FakeProvider("a", [{ parts: [...bg("c1", "a").parts, ...callTool("c2", "delegate", { task: "b" }).parts], usage }]);
+    const { app, tasks } = await mount([], { lead, worker: new Held("fake:w") });
+    await type(app, "go");
+    await waitFor(() => tasks.all.length === 2 && tasks.all.every((t) => t.state === "running"));
+    await press(app, "\u001b");
+    await waitFor(() => tasks.all[1]!.state === "stopped");
+    expect(tasks.all[0]!.state).toBe("running");
+  });
+
+  for (const [way, keys] of [
+    ["/exit", ["/exit", "\r"]],
+    ["Ctrl-C twice", ["\u0003", "\u0003"]],
+    ["Ctrl-D twice", ["\u0004", "\u0004"]],
+  ] as const) {
+    it(`stops every subagent on ${way}`, async () => {
+      const lead = new FakeProvider("a", [bg("c1", "a"), reply("started")]);
+      const { app, tasks } = await mount([], { lead, worker: new Held("fake:w") });
+      await type(app, "go");
+      await until(app, "started");
+      for (const key of keys) await press(app, key);
+      await waitFor(() => tasks.all[0]!.state === "stopped");
+    });
+  }
+});
+
 // A subagent that asks: its name, its stop signal, and whether it was stopped.
 function asker(name: string) {
   const stop = new AbortController();
```


**Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/core/tasks.test.ts tests/tui/app.test.tsx`

Expected: FAIL. In the scratch build: Test Files 1 failed | 1 passed (2); Tests 8 failed | 119 passed (127). Nothing starts a turn when a background answer arrives.

**Step 3: Write the code**

**Change `src/cli.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/cli.tsx b/src/cli.tsx
index 47e6f4f..269c1f3 100644
--- a/src/cli.tsx
+++ b/src/cli.tsx
@@ -253,6 +253,7 @@ if (parsed.print !== undefined) {
   render(
     <App
       session={session}
+      tasks={tasks}
       bus={bus}
       stats={stats}
       mode={mode}
```

**Change `src/core/tasks.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/core/tasks.ts b/src/core/tasks.ts
index 57d3723..ee32374 100644
--- a/src/core/tasks.ts
+++ b/src/core/tasks.ts
@@ -46,7 +46,7 @@ export interface TasksOptions {
 // lead's next request takes them.
 export class Tasks {
   readonly all: Task[] = [];
-  #inbox: { text: string; wake: boolean }[] = [];
+  #inbox: { id: string; text: string; wake: boolean }[] = [];
   #free: number;
   #line: (() => void)[] = []; // subagents waiting for a free place, in order
   #stops = new Map<string, { stop: AbortController; byUser: boolean }>();
@@ -93,6 +93,11 @@ export class Tasks {
     return this.#inbox.some((i) => i.wake);
   }
 
+  // The subagents whose answers are waiting to start a turn, for its working line.
+  answering(): string[] {
+    return this.#inbox.filter((i) => i.wake).map((i) => i.id);
+  }
+
   // Everything waiting for the lead, removed, so each goes into exactly one request.
   take(): string[] {
     return this.#inbox.splice(0).map((i) => i.text);
@@ -111,9 +116,10 @@ export class Tasks {
     t.state = r.state;
     t.ended = Date.now();
     const name = `Background task ${t.id} (${t.task})`;
-    if (t.background && r.state === "done") this.#inbox.push({ text: `${name} finished:\n${truncate(r.text)}`, wake: true });
-    if (t.background && r.state === "failed") this.#inbox.push({ text: `${name} failed: ${r.text}`, wake: true });
-    if (t.background && r.state === "stopped" && stopped.byUser) this.#inbox.push({ text: `${name} was stopped by the user before it finished.`, wake: false });
+    const { id } = t;
+    if (t.background && r.state === "done") this.#inbox.push({ id, text: `${name} finished:\n${truncate(r.text)}`, wake: true });
+    if (t.background && r.state === "failed") this.#inbox.push({ id, text: `${name} failed: ${r.text}`, wake: true });
+    if (t.background && r.state === "stopped" && stopped.byUser) this.#inbox.push({ id, text: `${name} was stopped by the user before it finished.`, wake: false });
     this.#changed();
     return r;
   }
```

**Change `src/tui/App.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/App.tsx b/src/tui/App.tsx
index b27c1a2..feeb4e6 100644
--- a/src/tui/App.tsx
+++ b/src/tui/App.tsx
@@ -5,6 +5,7 @@ import { summarize } from "../core/errorlog.js";
 import { type Ask, type Mode, type Owner, visible } from "../core/permissions.js";
 import type { Session } from "../core/session.js";
 import type { Stats } from "../core/stats.js";
+import type { Tasks } from "../core/tasks.js";
 import { errorText, type Message, type Provider } from "../core/types.js";
 import type { ModelGroup } from "../providers/models.js";
 import type { TodoItem } from "../tools/todo.js";
@@ -27,6 +28,7 @@ type Question = { text: string; owner?: Owner; answer: (ok: boolean, how: string
 
 export interface AppProps {
   session: Session;
+  tasks: Tasks; // the lead's subagents
   bus: Bus;
   stats: Stats;
   mode: Mode; // the mode the session started in
@@ -48,6 +50,8 @@ export interface AppProps {
 }
 
 const COMMANDS = "/lead <provider:model>, /model, /login chatgpt, /logout chatgpt, /errors, /exit";
+// "t3's answer", "t2 and t3's answers", "t2, t3 and t4's answers".
+const names = (ids: string[]) => `${ids.length > 1 ? `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}` : ids[0]}'s answer${ids.length > 1 ? "s" : ""}`;
 const DOUBLE_PRESS_MS = 800; // Claude Code's window for pressing Ctrl+D twice (interactive-mode.md)
 
 // What submit takes as a command: a command's name first, or a slash and a bare word ("/tmp is full"
@@ -55,7 +59,7 @@ const DOUBLE_PRESS_MS = 800; // Claude Code's window for pressing Ctrl+D twice (
 const NAMES = ["/exit", "/errors", "/lead", "/model", "/login", "/logout"];
 const isCommand = (text: string) => NAMES.includes(text.split(/\s+/)[0]!.toLowerCase()) || /^\/[a-z]+$/i.test(text);
 
-export function App({ session, bus, stats, mode, onMode, project, root, gitBranch, historyFile, intro, errorFile, segments, makeProvider, bindAsk, login, listModels }: AppProps) {
+export function App({ session, tasks, bus, stats, mode, onMode, project, root, gitBranch, historyFile, intro, errorFile, segments, makeProvider, bindAsk, login, listModels }: AppProps) {
   const { exit } = useApp();
   const [lines, setLines] = useState<(Line & { id: number })[]>([]);
   // Each key reads and changes these at once, as in ModelPicker: several keys can arrive before the
@@ -90,6 +94,8 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
   const question = questions.current[0] ?? null;
   const [contextWindow, setContextWindow] = useState<number | null>(null);
   const [picker, setPicker] = useState<ModelGroup[] | null>(null);
+  const listOpen = useRef(false); // the picker, for keys and answers read before the screen is drawn again
+  const announced = useRef(new Set<string>()); // background subagents whose ending has been shown
   const [, rerender] = useState(0);
   const started = useRef(Date.now());
   const [now, setNow] = useState(started.current);
@@ -141,6 +147,7 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
             say({ text: `${q.text}: ${how}`, color: "gray" });
             resolve(ok);
             rerender((n) => n + 1);
+            next(); // an answer may have waited for this question to close
           },
         };
         signal?.addEventListener("abort", cancel, { once: true });
@@ -171,6 +178,16 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
       if (call) call.outcome = outcome;
       rerender((n) => n + 1);
     };
+    // A background subagent's ending is shown when it comes; its answer is read at once when idle.
+    const onTasks = () => {
+      for (const t of tasks.all) {
+        if (!t.background || t.state === "running" || t.state === "waiting" || announced.current.has(t.id)) continue;
+        announced.current.add(t.id);
+        say({ text: `${t.id} ${t.state === "done" ? "finished" : t.state}`, color: "gray" });
+      }
+      rerender((n) => n + 1);
+      next();
+    };
     const onTodo = (items: TodoItem[]) => {
       todos.current = { items, hidden: false };
       rerender((n) => n + 1);
@@ -182,6 +199,7 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
     bus.on("tool-start", onToolStart);
     bus.on("tool-end", onToolEnd);
     bus.on("todo", onTodo);
+    bus.on("tasks", onTasks);
     say(...intro);
     history.current!.load();
     lookUpWindow();
@@ -196,6 +214,9 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
       bus.off("tool-start", onToolStart);
       bus.off("tool-end", onToolEnd);
       bus.off("todo", onTodo);
+      bus.off("tasks", onTasks);
+      // However the screen closes, /exit or Ctrl-C or Ctrl-D twice, no subagent goes on spending.
+      tasks.stop();
     };
   }, []);
 
@@ -207,25 +228,29 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
   }, [busy]);
 
   // Called without await, so nothing may escape: an unhandled rejection ends the program. The queue
-  // goes on after a turn, however it ended, and after `/model` once the list is closed.
-  const submit = async (raw: string) => {
-    if (!(await perform(raw))) next();
+  // goes on after a turn, however it ended, and after `/model` once the list is closed. `answers`: a
+  // turn with nothing typed, to read the background answers waiting.
+  const submit = async (raw: string, answers = false) => {
+    if (!(await perform(raw, answers))) next();
   };
 
-  // Entries are taken from the front: a command alone, as if typed then; prompts next to each other
-  // as one message, separated by blank lines. Not while something runs: a command that finished
-  // after a turn started (both typed in one read of the terminal) leaves the queue to that turn.
+  // Background answers waiting go first, in a turn of their own (release 4 design, "Background
+  // subagents"). Then the queue's entries, taken from the front: a command alone, as if typed then;
+  // prompts next to each other as one message, separated by blank lines. Not while something runs (a
+  // command that finished after a turn started, both typed in one read of the terminal, leaves the
+  // queue to that turn), nor while a question or the model list is open.
   const next = () => {
-    if (working.current) return;
+    if (working.current || listOpen.current || questions.current.length) return;
+    if (tasks.wakes()) return void submit("", true);
     const q = queue.current;
     const command = q.findIndex(isCommand);
     if (q.length) void submit(q.splice(0, command === 0 ? 1 : command === -1 ? q.length : command).join("\n\n"));
   };
 
   // True when it opened the model list.
-  const perform = async (raw: string): Promise<boolean | void> => {
+  const perform = async (raw: string, answers = false): Promise<boolean | void> => {
     const text = raw.trim();
-    if (!text) return;
+    if (!text && !answers) return;
     // Commands ignore case; a message is sent as typed.
     const [first = "", ...words] = text.split(/\s+/);
     const command = first.toLowerCase();
@@ -245,12 +270,15 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
       if (words.length && ["/exit", "/errors", "/model"].includes(command)) return say({ text: `${command} takes nothing after it.`, color: "red" });
       abort.current = new AbortController();
       const turn = !account && !alone("/model");
-      const label = account === "login" ? "Waiting for the browser" : account ? "Signing out" : turn ? "Working" : "Reading the model lists";
+      const label = account === "login" ? "Waiting for the browser" : account ? "Signing out" : answers ? `Reading ${names(tasks.answering())}` : turn ? "Working" : "Reading the model lists";
       doing.current = { label, at: Date.now(), from: turn ? { output: stats.output, cost: stats.cost, unpriced: stats.unpriced } : null };
       if (turn) calls.current = [];
       setNow(doing.current.at);
       setBusy(true);
       working.current = true;
+      // Finished subagents leave the panel at the user's next turn; after `working`, since the change
+      // it reports would otherwise start the queue.
+      if (turn && !answers) tasks.clearFinished();
       try {
         // Signing in waits on the browser; Ctrl-C stops it, as it stops a turn.
         if (account) await login(account, words, (line) => say({ text: line, color: "magenta" }), abort.current.signal, "/");
@@ -258,6 +286,7 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
           const { signal } = abort.current; // this command's own, read before the wait
           const groups = await listModels(signal, (line) => say({ text: line, color: "magenta" }));
           if (!signal.aborted) {
+            listOpen.current = true;
             setPicker(groups);
             return true;
           }
@@ -274,6 +303,7 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
 
   // Picking does what `/lead <provider:model>` does.
   const pick = (spec: string) => {
+    listOpen.current = false;
     setPicker(null);
     try {
       session.setLead(makeProvider(spec));
@@ -283,6 +313,7 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
     next();
   };
   const closePicker = () => {
+    listOpen.current = false;
     setPicker(null);
     next();
   };
```

**Change `src/tui/describe.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/describe.ts b/src/tui/describe.ts
index 1f671c4..81ea09f 100644
--- a/src/tui/describe.ts
+++ b/src/tui/describe.ts
@@ -10,9 +10,9 @@ export interface Line {
 const firstLine = (s: string) => s.split(/\r?\n/)[0] ?? "";
 
 // A call's main detail (release 3 design, "On screen"): the path for the file tools, the command's
-// first line for shell, the pattern for the search tools; null for a tool without its own summary,
-// which is shown with its whole input.
-const DETAIL: Record<string, string> = { read_file: "path", write_file: "path", edit_file: "path", shell: "command", find_files: "pattern", search_files: "pattern" };
+// first line for shell, the pattern for the search tools, the task for delegate; null for a tool
+// without its own summary, which is shown with its whole input.
+const DETAIL: Record<string, string> = { read_file: "path", write_file: "path", edit_file: "path", shell: "command", find_files: "pattern", search_files: "pattern", delegate: "task" };
 export function brief(name: string, input: unknown): string | null {
   const items = name === "todo" && typeof input === "object" && input !== null ? (input as { items?: unknown }).items : undefined;
   if (Array.isArray(items)) return `${items.length} item${items.length === 1 ? "" : "s"}`; // the list itself is on screen
```


**Step 4: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 1 failed | 38 passed | 2 skipped (41); Tests 1 failed | 651 passed | 10 skipped (662).

**Step 5: Commit**

```bash
git add src/cli.tsx src/core/tasks.ts src/tui/App.tsx src/tui/describe.ts tests/core/tasks.test.ts tests/helpers.ts tests/tui/app.test.tsx
git commit -m "feat: a background answer that finishes while the lead is idle starts a turn reading it"
```

### Task 12: The task panel under the prompt, and the status line's tasks part

`src/tui/TaskPanel.tsx` (release 4 design, "On screen"; choice 12). Under the prompt and under an
open menu, one row a subagent:
`◐ t2 find the login code · claude-haiku-5-5 · 12s · ↓ 1.2k tokens · $0.01 · read_file src/auth/oauth.ts`.
- A running row ends with its latest tool call, as the tool line writes calls. A finished row's mark
  becomes ✓, ✗ red or ⊘ grey, the tool line's marks.
- Running rows first. When not all fit, the last row says "+3 more".
- Finished rows stay until the user's next turn.
- The model's text in a row is cleaned with `visible()`.

**The status line** gains a `tasks` part, "2 running", shown while any subagent runs; `--status`
takes `tasks`. While only subagents run, the screen redraws once a second so their times move.
`WorkingLine` now exports `elapsed`, which the panel uses for its times.

**Files:**
- Modify: `src/tui/App.tsx`
- Modify: `src/tui/StatusLine.tsx`
- Create: `src/tui/TaskPanel.tsx`
- Modify: `src/tui/WorkingLine.tsx`
- Modify: `tests/clilib.test.ts`
- Modify: `tests/tui/app.test.tsx`
- Modify: `tests/tui/lines.test.tsx`
- Modify: `tests/tui/statusline.test.tsx`

**Step 1: Write the failing tests**

**Change `tests/clilib.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/clilib.test.ts b/tests/clilib.test.ts
index d1c142a..a7d0560 100644
--- a/tests/clilib.test.ts
+++ b/tests/clilib.test.ts
@@ -113,7 +113,7 @@ describe("statusSegments", () => {
   });
 
   it("names --status when a segment is unknown", () => {
-    expect(() => statusSegments("lead,nope")).toThrow('--status must be one of: lead, context, tokens, cost, mode, errors, project, time, tools (got "nope")');
+    expect(() => statusSegments("lead,nope")).toThrow('--status must be one of: lead, context, tokens, cost, mode, errors, project, time, tasks, tools (got "nope")');
   });
 });
 
```

**Change `tests/tui/app.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/app.test.tsx b/tests/tui/app.test.tsx
index 70faa21..d4af5e8 100644
--- a/tests/tui/app.test.tsx
+++ b/tests/tui/app.test.tsx
@@ -1148,6 +1148,21 @@ describe("App's background subagents", () => {
     expect(tasks.all[0]!.state).toBe("running");
   });
 
+  it("shows each subagent in a panel under the prompt, a finished row staying until the user's next turn", async () => {
+    const worker = new Held("fake:w");
+    const lead = new FakeProvider("a", [bg("c1", "find x"), reply("started it"), reply("read it"), reply("next")]);
+    const { app } = await mount([], { lead, worker, segments: ["tasks"] });
+    await type(app, "go");
+    await until(app, "started it");
+    expect(app.lastFrame()).toMatch(/›\n◐ t1 find x · w · \d+s · ↓ 0 tokens · \$0\.00\n\? for shortcuts\n 1 running$/);
+    worker.answer("found");
+    await until(app, "read it");
+    expect(app.lastFrame()).toMatch(/›\n✓ t1 find x · w · /);
+    await type(app, "more");
+    await until(app, "next");
+    expect(app.lastFrame()).not.toContain("t1 find x ·");
+  });
+
   for (const [way, keys] of [
     ["/exit", ["/exit", "\r"]],
     ["Ctrl-C twice", ["\u0003", "\u0003"]],
```

**Change `tests/tui/lines.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/lines.test.tsx b/tests/tui/lines.test.tsx
index 7f915d9..2139b0a 100644
--- a/tests/tui/lines.test.tsx
+++ b/tests/tui/lines.test.tsx
@@ -1,6 +1,8 @@
 import { describe, expect, it } from "vitest";
 import type { ToolOutcome } from "../../src/core/bus.js";
 import type { TodoItem } from "../../src/tools/todo.js";
+import type { Task } from "../../src/core/tasks.js";
+import { taskRows } from "../../src/tui/TaskPanel.js";
 import { todoRows } from "../../src/tui/TodoList.js";
 import { toolParts } from "../../src/tui/ToolLine.js";
 import { workingText } from "../../src/tui/WorkingLine.js";
@@ -79,3 +81,36 @@ describe("todoRows", () => {
     expect(shown([{ text: "a\u001b[2Jb\rc", status: "pending" }], 1)).toEqual(["☐ a\\u001b[2Jb␍c"]);
   });
 });
+
+describe("taskRows", () => {
+  const now = 1_000_000;
+  const task = (over: Partial<Task>): Task =>
+    ({ id: "t2", task: "find the login code", model: "anthropic:claude-haiku-5-5", background: true, state: "running", started: now - 12_000, output: 1_234, cost: 0.0123, costUnknown: false, lastTool: { name: "read_file", input: { path: "src/auth/oauth.ts" } }, shown: true, messages: [], done: Promise.resolve({ state: "done", text: "" }), ...over }) as Task;
+  const shown = (tasks: Task[], rows = 10) => taskRows(tasks, rows, now).map((r) => `${r.mark} ${r.text}`);
+
+  it("shows a running subagent's number, task, model, time, tokens, cost and latest tool call", () => {
+    expect(shown([task({})])).toEqual(["◐ t2 find the login code · claude-haiku-5-5 · 12s · ↓ 1.2k tokens · $0.01 · read_file src/auth/oauth.ts"]);
+    expect(taskRows([task({})], 1, now)[0]!.color).toBe("yellow");
+  });
+
+  it("says when one waits for a place, and marks finished ones as the tool line does, without a tool", () => {
+    const rows = taskRows(
+      [task({ id: "t1", state: "waiting" }), task({ id: "t3", state: "done", ended: now - 2_000 }), task({ id: "t4", state: "failed", ended: now }), task({ id: "t5", state: "stopped", ended: now })],
+      10,
+      now,
+    );
+    expect(rows.map((r) => [r.mark, r.color])).toEqual([["◐", "gray"], ["✓", "green"], ["✗", "red"], ["⊘", "gray"]]);
+    expect(rows[0]!.text).toBe("t1 find the login code · claude-haiku-5-5 · waiting");
+    expect(rows[1]!.text).toBe("t3 find the login code · claude-haiku-5-5 · 10s · ↓ 1.2k tokens · $0.01");
+  });
+
+  it("puts running ones first, leaves out those taken off the panel, and says how many more do not fit", () => {
+    const tasks = [task({ id: "t1", state: "done", ended: now }), task({ id: "t2" }), task({ id: "t3" }), task({ id: "t4", shown: false, state: "done", ended: now })];
+    expect(shown(tasks).map((r) => r.split(" ")[1])).toEqual(["t2", "t3", "t1"]);
+    expect(shown(tasks, 2)).toEqual([shown(tasks)[0], "  +2 more"]);
+  });
+
+  it("escapes what the model wrote, and keeps a task to its first line", () => {
+    expect(shown([task({ task: "a\u001b[2Jb\nsecond line", lastTool: { name: "read_file", input: { path: "x\ry" } } })])[0]).toBe("◐ t2 a\\u001b[2Jb · claude-haiku-5-5 · 12s · ↓ 1.2k tokens · $0.01 · read_file x␍y");
+  });
+});
```

**Change `tests/tui/statusline.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/statusline.test.tsx b/tests/tui/statusline.test.tsx
index c75c993..2eb3eb7 100644
--- a/tests/tui/statusline.test.tsx
+++ b/tests/tui/statusline.test.tsx
@@ -16,6 +16,7 @@ const info: StatusInfo = {
   project: "Agent Harness",
   branch: "main",
   elapsed: 14 * 60_000,
+  running: 0,
 };
 
 // Renders once and unmounts, so Ink instances do not pile up.
@@ -26,9 +27,16 @@ function frame(i: StatusInfo, segments: Segment[]) {
   return shown;
 }
 
+describe("StatusLine's tasks part", () => {
+  it("says how many subagents run, only while any does", () => {
+    expect(frame({ ...info, running: 2 }, ["errors", "tasks"])).toBe(" 2 errors | 2 running");
+    expect(frame(info, ["errors", "tasks"])).toBe(" 2 errors");
+  });
+});
+
 describe("StatusLine", () => {
   it("shows every part by default", () => {
-    expect(SEGMENTS).toEqual(["lead", "context", "tokens", "cost", "mode", "errors", "project", "time", "tools"]);
+    expect(SEGMENTS).toEqual(["lead", "context", "tokens", "cost", "mode", "errors", "project", "time", "tasks", "tools"]);
     // In two parts: all of them are wider than the test terminal's 100 columns.
     const shown = frame(info, SEGMENTS.slice(0, 4));
     expect(shown).toContain("lead anthropic:claude-opus-5-5");
```


**Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/clilib.test.ts tests/tui/app.test.tsx tests/tui/lines.test.tsx tests/tui/statusline.test.tsx`

Expected: FAIL. In the scratch build: Test Files 4 failed (4); Tests 4 failed | 157 passed (161). `src/tui/TaskPanel.tsx` does not exist yet.

**Step 3: Write the code**

**Change `src/tui/App.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/App.tsx b/src/tui/App.tsx
index feeb4e6..99eb173 100644
--- a/src/tui/App.tsx
+++ b/src/tui/App.tsx
@@ -19,6 +19,7 @@ import { commandMenu, type Listing, listFolder, type Menu as MenuData, pathMenu
 import { ModelPicker } from "./ModelPicker.js";
 import { Prompt, promptWidth } from "./Prompt.js";
 import { type Segment, StatusLine } from "./StatusLine.js";
+import { TaskPanel, taskRows } from "./TaskPanel.js";
 import { TodoList, todoRows, unfinished } from "./TodoList.js";
 import { type Call, ToolLine } from "./ToolLine.js";
 import { SPIN_MS, WorkingLine } from "./WorkingLine.js";
@@ -220,12 +221,14 @@ export function App({ session, tasks, bus, stats, mode, onMode, project, root, g
     };
   }, []);
 
-  // The working line's spinner and time, while something runs.
+  // The working line's spinner and time, while something runs; the panel's times, once a second, while
+  // only subagents do.
+  const running = tasks.running > 0;
   useEffect(() => {
-    if (!busy) return;
-    const spin = setInterval(() => setNow(Date.now()), SPIN_MS);
+    if (!busy && !running) return;
+    const spin = setInterval(() => setNow(Date.now()), busy ? SPIN_MS : 1000);
     return () => clearInterval(spin);
-  }, [busy]);
+  }, [busy, running]);
 
   // Called without await, so nothing may escape: an unhandled rejection ends the program. The queue
   // goes on after a turn, however it ended, and after `/model` once the list is closed. `answers`: a
@@ -547,8 +550,8 @@ export function App({ session, tasks, bus, stats, mode, onMode, project, root, g
   // at full height Ink draws the whole scrollback again each time. First the status line and the
   // working line; the tool line when there is room for it, the hint line and the cursor's row; the hint
   // line when there is room for it and the cursor's row; then an open menu, with the prompt cut to the
-  // cursor's row; then the prompt; then the to-do list, which gives way before the prompt does (release
-  // 4 design, "On screen"); then the queue, the last row saying how many more there are when they do
+  // cursor's row; then the task panel (release 4 design, "On screen"); then the prompt; then the to-do
+  // list, which gives way before the prompt does; then the queue, the last row saying how many more there are when they do
   // not all fit. The model list fills the rows above the status line itself, so it has no tool line
   // under it.
   const base = height - 1 - 1 - (busy ? 1 : 0);
@@ -557,8 +560,9 @@ export function App({ session, tasks, bus, stats, mode, onMode, project, root, g
   const hinted = hintFor(1) !== null && room >= 2;
   const space = Math.max(1, room - (hinted ? 1 : 0));
   const menuRows = menu ? Math.min(menu.entries.length, Math.max(1, space - 1)) : 0;
-  const promptSpace = menu ? 1 : space;
-  const promptLeft = space - menuRows - Math.min(layout(prompt.text, promptWidth(columns)).rows.length, promptSpace);
+  const panel = taskRows(tasks.all, Math.max(0, space - 1 - menuRows), now);
+  const promptSpace = menu ? 1 : space - panel.length;
+  const promptLeft = space - menuRows - panel.length - Math.min(layout(prompt.text, promptWidth(columns)).rows.length, promptSpace);
   const todoShown = !todos.current.hidden && unfinished(todos.current.items) ? todoRows(todos.current.items, promptLeft) : [];
   const left = promptLeft - todoShown.length;
   const q = queue.current.map((e) => visible(e));
@@ -595,6 +599,7 @@ export function App({ session, tasks, bus, stats, mode, onMode, project, root, g
           ))}
           <Prompt editor={prompt} columns={columns} offset={(busy ? 1 : 0) + todoShown.length + queued.length} space={promptSpace} />
           {menu && <Menu entries={menu.entries} chosen={chosenIn(prompt, menu)} rows={menuRows} />}
+          <TaskPanel rows={panel} />
         </>
       )}
       {hint && (
@@ -617,6 +622,7 @@ export function App({ session, tasks, bus, stats, mode, onMode, project, root, g
           project,
           branch,
           elapsed: now - started.current,
+          running: tasks.running,
         }}
       />
       {tooled && <ToolLine calls={calls.current} />}
```

**Change `src/tui/StatusLine.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/StatusLine.tsx b/src/tui/StatusLine.tsx
index bc23329..225460d 100644
--- a/src/tui/StatusLine.tsx
+++ b/src/tui/StatusLine.tsx
@@ -1,9 +1,10 @@
 import { Text } from "ink";
 import { visible } from "../core/permissions.js";
 
-// The status line's parts, and `tools`, the line under it (release 3 design, "On screen").
-export type Segment = "lead" | "context" | "tokens" | "cost" | "mode" | "errors" | "project" | "time" | "tools";
-export const SEGMENTS: Segment[] = ["lead", "context", "tokens", "cost", "mode", "errors", "project", "time", "tools"];
+// The status line's parts, and `tools`, the line under it (release 3 design, "On screen"); `tasks`,
+// how many subagents run (release 4 design, "On screen").
+export type Segment = "lead" | "context" | "tokens" | "cost" | "mode" | "errors" | "project" | "time" | "tasks" | "tools";
+export const SEGMENTS: Segment[] = ["lead", "context", "tokens", "cost", "mode", "errors", "project", "time", "tasks", "tools"];
 type LineSegment = Exclude<Segment, "tools">;
 
 export interface StatusInfo {
@@ -19,6 +20,7 @@ export interface StatusInfo {
   project: string; // the project folder's name
   branch: string | null; // the git branch; null outside a repository (see git.ts)
   elapsed: number; // ms since the session started
+  running: number; // subagents running or waiting for a place
 }
 
 // The unit is picked after rounding, so 999,999 shows as 1.0M, not 1000.0k.
@@ -77,13 +79,16 @@ export function formatSegment(s: LineSegment, i: StatusInfo): string {
       return visible(i.branch === null ? i.project : `${i.project} git:(${i.branch})`);
     case "time":
       return `⏱ ${duration(i.elapsed)}`;
+    case "tasks":
+      return `${i.running} running`;
   }
 }
 
 // One line, cut at the end to the terminal's width (Ink measures it in columns) instead of wrapping.
 // The text is inverse; the context bar is not, so its filled cells show in their colour.
 export function StatusLine({ info, segments }: { info: StatusInfo; segments: Segment[] }) {
-  const shown = segments.filter((s): s is LineSegment => s !== "tools");
+  // `tasks` shows only while a subagent runs.
+  const shown = segments.filter((s): s is LineSegment => s !== "tools" && (s !== "tasks" || info.running > 0));
   return (
     <Text wrap="truncate-end">
       {shown.map((s, n) => {
```

**Create `src/tui/TaskPanel.tsx`:**

```tsx
import { Text } from "ink";
import { visible } from "../core/permissions.js";
import type { Task, TaskState } from "../core/tasks.js";
import { brief } from "./describe.js";
import { costText, k } from "./StatusLine.js";
import { elapsed } from "./WorkingLine.js";

export interface TaskRow {
  mark: string;
  text: string;
  color: "yellow" | "green" | "red" | "gray";
}

// The tool line's marks (ToolLine.tsx), and a grey one for a subagent waiting for a place.
const MARKS: Record<TaskState, Omit<TaskRow, "text">> = {
  waiting: { mark: "◐", color: "gray" },
  running: { mark: "◐", color: "yellow" },
  done: { mark: "✓", color: "green" },
  failed: { mark: "✗", color: "red" },
  stopped: { mark: "⊘", color: "gray" },
};

const live = (t: Task) => t.state === "running" || t.state === "waiting";

// The panel under the prompt (release 4 design, "On screen"): a row for each subagent still on it,
// running ones first, then "+N more" in the last row when not all fit. A running row ends with its
// latest tool call. What the model wrote is escaped, and a task is kept to its first line. `now` is
// the screen's clock, which may have last ticked just before a subagent started.
export function taskRows(tasks: Task[], rows: number, now: number): TaskRow[] {
  const on = tasks.filter((t) => t.shown);
  const ordered = [...on.filter(live), ...on.filter((t) => !live(t))];
  const row = (t: Task): TaskRow => {
    const head = `${t.id} ${visible(t.task.split(/\r?\n/)[0] ?? "")} · ${visible(t.model.slice(t.model.indexOf(":") + 1))}`;
    if (t.state === "waiting") return { ...MARKS.waiting, text: `${head} · waiting` };
    const tool = t.state === "running" && t.lastTool ? ` · ${visible([t.lastTool.name, brief(t.lastTool.name, t.lastTool.input)].filter(Boolean).join(" "))}` : "";
    return { ...MARKS[t.state], text: `${head} · ${elapsed(Math.max(0, (t.ended ?? now) - t.started))} · ↓ ${k(t.output)} tokens · ${costText(t.model, t.cost, t.costUnknown)}${tool}` };
  };
  if (ordered.length <= rows) return ordered.map(row);
  if (rows <= 0) return [];
  return [...ordered.slice(0, rows - 1).map(row), { mark: " ", text: `+${ordered.length - rows + 1} more`, color: "gray" }];
}

export function TaskPanel({ rows }: { rows: TaskRow[] }) {
  return rows.map((r, i) => (
    <Text key={i} wrap="truncate-end">
      <Text color={r.color}>{r.mark}</Text> {r.text}
    </Text>
  ));
}
```

**Change `src/tui/WorkingLine.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/WorkingLine.tsx b/src/tui/WorkingLine.tsx
index 6a2cad3..7903160 100644
--- a/src/tui/WorkingLine.tsx
+++ b/src/tui/WorkingLine.tsx
@@ -13,11 +13,16 @@ export interface Spend {
   costUnknown: boolean;
 }
 
+// How long something has run, in seconds, then minutes and seconds.
+export function elapsed(ms: number): string {
+  const s = Math.floor(ms / 1000);
+  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
+}
+
 // The line over the prompt while something runs (release 3 design, "On screen"): what it is, for how
 // long, and for a turn its tokens and cost so far, which change after each model reply.
 export function workingText(label: string, ms: number, spend: Spend | null): string {
-  const s = Math.floor(ms / 1000);
-  const time = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
+  const time = elapsed(ms);
   const turn = spend ? ` · ↓ ${k(spend.output)} tokens · ${costText(spend.lead, spend.cost, spend.costUnknown)}` : "";
   return `${FRAMES[Math.floor(ms / SPIN_MS) % FRAMES.length]} ${label} · ${time}${turn} · Esc to stop`;
 }
```


**Step 4: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 1 failed | 38 passed | 2 skipped (41); Tests 1 failed | 657 passed | 10 skipped (668).

**Step 5: Commit**

```bash
git add src/tui/App.tsx src/tui/StatusLine.tsx src/tui/TaskPanel.tsx src/tui/WorkingLine.tsx tests/clilib.test.ts tests/tui/app.test.tsx tests/tui/lines.test.tsx tests/tui/statusline.test.tsx
git commit -m "feat: the task panel under the prompt, and the status line's tasks part"
```

### Task 13: /tasks lists the subagents, shows one in full, and stops one or all

Release 4 design, "Background subagents"; choice 13.
- **`/tasks`** lists the session's subagents, one panel row each, under "Subagents: 3" (or "No
  subagents yet.").
- **`/tasks t3`** prints that subagent's tool calls and answer in full below the conversation, as
  Ctrl+O does for the lead's last turn.
- **`/tasks stop t3`** stops one ("Stopped t3." or "t3 is not running."); **`/tasks stop`** stops all
  ("Stopped every subagent." or "No subagent is running.").
- An unknown one: "No subagent t9. /tasks lists them."

The `/` menu and the list of commands gain `/tasks`.

**Files:**
- Modify: `src/core/tasks.ts`
- Modify: `src/tui/App.tsx`
- Modify: `src/tui/TaskPanel.tsx`
- Modify: `src/tui/describe.ts`
- Modify: `src/tui/menus.ts`
- Modify: `tests/tui/app.test.tsx`
- Modify: `tests/tui/menus.test.ts`

**Step 1: Write the failing tests**

**Change `tests/tui/app.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/app.test.tsx b/tests/tui/app.test.tsx
index d4af5e8..233d51e 100644
--- a/tests/tui/app.test.tsx
+++ b/tests/tui/app.test.tsx
@@ -1163,6 +1163,50 @@ describe("App's background subagents", () => {
     expect(app.lastFrame()).not.toContain("t1 find x ·");
   });
 
+  it("lists the session's subagents with /tasks, finished ones taken off the panel included", async () => {
+    const lead = new FakeProvider("a", [bg("c1", "find x"), reply("started it"), reply("next")]);
+    const { app } = await mount([], { lead, worker: new FakeProvider("w", [reply("found")]) });
+    await type(app, "/tasks");
+    await until(app, "No subagents yet.");
+    await type(app, "go");
+    await until(app, "started it");
+    await type(app, "more");
+    await until(app, "next");
+    await type(app, "/tasks");
+    await until(app, "Subagents: 1");
+    expect(app.lastFrame()).toMatch(/Subagents: 1\n✓ t1 find x · w · \d+s · ↓ 5 tokens · \$0\.00 \+ \?\n/);
+  });
+
+  it("prints a subagent's tool calls and answer in full with /tasks t1", async () => {
+    const worker = new FakeProvider("w", [callTool("w1", "find_files", { pattern: "*.ts" }), reply("It is in a.ts")]);
+    const { app } = await mount([callTool("c1", "delegate", { task: "find x" }), reply("done")], { worker });
+    await type(app, "go");
+    await until(app, "done");
+    await type(app, "/tasks t1");
+    await until(app, "t1 (find x), done: 1 tool call");
+    expect(app.lastFrame()).toContain('● find_files {\n  "pattern": "*.ts"\n}\n  ⎿ No files match *.ts');
+    expect(app.lastFrame()).toContain("Answer:\nIt is in a.ts");
+    await type(app, "/tasks t9");
+    await until(app, "No subagent t9. /tasks lists them.");
+  });
+
+  it("stops one subagent with /tasks stop t1, or all with /tasks stop", async () => {
+    const lead = new FakeProvider("a", [{ parts: [...bg("c1", "a").parts, ...bg("c2", "b").parts], usage }, reply("started")]);
+    const { app, tasks } = await mount([], { lead, worker: new Held("fake:w") });
+    await type(app, "go");
+    await until(app, "started");
+    await type(app, "/tasks stop t1");
+    await until(app, "Stopped t1.");
+    expect(tasks.all.map((t) => t.state)).toEqual(["stopped", "running"]);
+    await type(app, "/tasks stop t1");
+    await until(app, "t1 is not running.");
+    await type(app, "/tasks stop");
+    await until(app, "Stopped every subagent.");
+    expect(tasks.all[1]!.state).toBe("stopped");
+    await type(app, "/tasks stop");
+    await until(app, "No subagent is running.");
+  });
+
   for (const [way, keys] of [
     ["/exit", ["/exit", "\r"]],
     ["Ctrl-C twice", ["\u0003", "\u0003"]],
```

**Change `tests/tui/menus.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/menus.test.ts b/tests/tui/menus.test.ts
index bff8ed3..f027763 100644
--- a/tests/tui/menus.test.ts
+++ b/tests/tui/menus.test.ts
@@ -13,7 +13,7 @@ const labels = (m: ReturnType<typeof commandMenu>) => m?.entries.map((e) => e.la
 describe("commandMenu", () => {
   it("lists every command for a slash at the start of the prompt, each saying what it does", () => {
     const m = commandMenu("/", 1);
-    expect(labels(m)).toEqual(["/lead <provider:model>", "/model", "/login chatgpt", "/logout chatgpt", "/errors", "/exit"]);
+    expect(labels(m)).toEqual(["/lead <provider:model>", "/model", "/login chatgpt", "/logout chatgpt", "/tasks", "/errors", "/exit"]);
     expect(m!.entries[0]).toMatchObject({ note: "Switch the lead model", fill: "/lead ", run: "/lead" });
   });
 
```


**Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/tui/app.test.tsx tests/tui/menus.test.ts`

Expected: FAIL. In the scratch build: Test Files 2 failed (2); Tests 4 failed | 122 passed (126). `/tasks` is not a command yet.

**Step 3: Write the code**

**Change `src/core/tasks.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/core/tasks.ts b/src/core/tasks.ts
index ee32374..da6bd65 100644
--- a/src/core/tasks.ts
+++ b/src/core/tasks.ts
@@ -26,6 +26,7 @@ export interface Task {
   cost: number; // USD, for requests whose price is known
   costUnknown: boolean;
   lastTool: { name: string; input: unknown } | null;
+  answer?: string; // once it ended: its answer, why it failed, or that it was stopped
   shown: boolean; // on the panel: finished ones leave it at the next turn the user starts
   messages: Message[]; // its conversation, for /tasks t3
   done: Promise<Result>;
@@ -114,6 +115,7 @@ export class Tasks {
     const r: Result = result ?? { state: "stopped", text: "" };
     if (r.state === "stopped") r.text = `${t.id} was stopped${stopped.byUser ? " by the user before it finished" : ""}.`;
     t.state = r.state;
+    t.answer = r.text;
     t.ended = Date.now();
     const name = `Background task ${t.id} (${t.task})`;
     const { id } = t;
```

**Change `src/tui/App.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/App.tsx b/src/tui/App.tsx
index 99eb173..ea302d6 100644
--- a/src/tui/App.tsx
+++ b/src/tui/App.tsx
@@ -9,7 +9,7 @@ import type { Tasks } from "../core/tasks.js";
 import { errorText, type Message, type Provider } from "../core/types.js";
 import type { ModelGroup } from "../providers/models.js";
 import type { TodoItem } from "../tools/todo.js";
-import { brief, describe, lastTurn, type Line, screen } from "./describe.js";
+import { brief, callLines, describe, lastTurn, type Line, screen } from "./describe.js";
 import { apply, type Editor, empty, load, move, replace } from "./editor.js";
 import { History, matches } from "./history.js";
 import { type Command, commands, KEY_LIST } from "./keys.js";
@@ -19,7 +19,7 @@ import { commandMenu, type Listing, listFolder, type Menu as MenuData, pathMenu
 import { ModelPicker } from "./ModelPicker.js";
 import { Prompt, promptWidth } from "./Prompt.js";
 import { type Segment, StatusLine } from "./StatusLine.js";
-import { TaskPanel, taskRows } from "./TaskPanel.js";
+import { TaskPanel, taskRow, taskRows } from "./TaskPanel.js";
 import { TodoList, todoRows, unfinished } from "./TodoList.js";
 import { type Call, ToolLine } from "./ToolLine.js";
 import { SPIN_MS, WorkingLine } from "./WorkingLine.js";
@@ -50,14 +50,14 @@ export interface AppProps {
   listModels: (signal: AbortSignal, warn: (line: string) => void) => Promise<ModelGroup[]>;
 }
 
-const COMMANDS = "/lead <provider:model>, /model, /login chatgpt, /logout chatgpt, /errors, /exit";
+const COMMANDS = "/lead <provider:model>, /model, /login chatgpt, /logout chatgpt, /tasks, /errors, /exit";
 // "t3's answer", "t2 and t3's answers", "t2, t3 and t4's answers".
 const names = (ids: string[]) => `${ids.length > 1 ? `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}` : ids[0]}'s answer${ids.length > 1 ? "s" : ""}`;
 const DOUBLE_PRESS_MS = 800; // Claude Code's window for pressing Ctrl+D twice (interactive-mode.md)
 
 // What submit takes as a command: a command's name first, or a slash and a bare word ("/tmp is full"
 // is a message).
-const NAMES = ["/exit", "/errors", "/lead", "/model", "/login", "/logout"];
+const NAMES = ["/exit", "/errors", "/lead", "/model", "/login", "/logout", "/tasks"];
 const isCommand = (text: string) => NAMES.includes(text.split(/\s+/)[0]!.toLowerCase()) || /^\/[a-z]+$/i.test(text);
 
 export function App({ session, tasks, bus, stats, mode, onMode, project, root, gitBranch, historyFile, intro, errorFile, segments, makeProvider, bindAsk, login, listModels }: AppProps) {
@@ -264,6 +264,7 @@ export function App({ session, tasks, bus, stats, mode, onMode, project, root, g
         return exit();
       }
       if (alone("/errors")) return say(...summarize(errorFile).map((row) => ({ text: row, oneLine: true })));
+      if (command === "/tasks") return say(...tasksCommand(words));
       if (alone("/lead")) return say({ text: "Usage: /lead <provider:model>" });
       if (command === "/lead") return session.setLead(makeProvider(words.join(" ")));
       const account = command === "/login" ? "login" : command === "/logout" ? "logout" : undefined;
@@ -304,6 +305,30 @@ export function App({ session, tasks, bus, stats, mode, onMode, project, root, g
     }
   };
 
+  // `/tasks` lists the session's subagents, `/tasks t3` prints one's tool calls and answer in full,
+  // and `/tasks stop` stops all of them, or with a number one (release 4 design, "Background subagents").
+  const tasksCommand = (words: string[]): Line[] => {
+    const gray = (text: string): Line => ({ text, color: "gray" });
+    const none = (id: string): Line => ({ text: `No subagent ${id}. /tasks lists them.`, color: "red" });
+    const [verb, id, ...rest] = words;
+    if (verb === undefined) {
+      if (!tasks.all.length) return [gray("No subagents yet.")];
+      const now = Date.now();
+      return [gray(`Subagents: ${tasks.all.length}`), ...tasks.all.map((t) => taskRow(t, now)).map((r) => ({ ...gray(`${r.mark} ${r.text}`), oneLine: true }))];
+    }
+    if (verb === "stop" && !rest.length) {
+      if (id === undefined) return [gray(tasks.stop() ? "Stopped every subagent." : "No subagent is running.")];
+      if (!tasks.all.some((t) => t.id === id)) return [none(id)];
+      return [gray(tasks.stop(id) ? `Stopped ${id}.` : `${id} is not running.`)];
+    }
+    if (id !== undefined) return [{ text: "Usage: /tasks, /tasks <number>, /tasks stop [<number>]", color: "red" }];
+    const t = tasks.all.find((x) => x.id === verb);
+    if (!t) return [none(verb)];
+    const calls = callLines(t.messages);
+    const end = t.state === "done" ? `Answer:\n${t.answer}` : t.state === "failed" ? `Failed: ${t.answer}` : t.answer ?? "(still running)";
+    return [gray(`${t.id} (${t.task}), ${t.state}: ${calls.length} tool call${calls.length === 1 ? "" : "s"}`), ...calls, gray(end)];
+  };
+
   // Picking does what `/lead <provider:model>` does.
   const pick = (spec: string) => {
     listOpen.current = false;
```

**Change `src/tui/TaskPanel.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/TaskPanel.tsx b/src/tui/TaskPanel.tsx
index 030e3db..f4be37a 100644
--- a/src/tui/TaskPanel.tsx
+++ b/src/tui/TaskPanel.tsx
@@ -29,15 +29,17 @@ const live = (t: Task) => t.state === "running" || t.state === "waiting";
 export function taskRows(tasks: Task[], rows: number, now: number): TaskRow[] {
   const on = tasks.filter((t) => t.shown);
   const ordered = [...on.filter(live), ...on.filter((t) => !live(t))];
-  const row = (t: Task): TaskRow => {
-    const head = `${t.id} ${visible(t.task.split(/\r?\n/)[0] ?? "")} · ${visible(t.model.slice(t.model.indexOf(":") + 1))}`;
-    if (t.state === "waiting") return { ...MARKS.waiting, text: `${head} · waiting` };
-    const tool = t.state === "running" && t.lastTool ? ` · ${visible([t.lastTool.name, brief(t.lastTool.name, t.lastTool.input)].filter(Boolean).join(" "))}` : "";
-    return { ...MARKS[t.state], text: `${head} · ${elapsed(Math.max(0, (t.ended ?? now) - t.started))} · ↓ ${k(t.output)} tokens · ${costText(t.model, t.cost, t.costUnknown)}${tool}` };
-  };
-  if (ordered.length <= rows) return ordered.map(row);
+  if (ordered.length <= rows) return ordered.map((t) => taskRow(t, now));
   if (rows <= 0) return [];
-  return [...ordered.slice(0, rows - 1).map(row), { mark: " ", text: `+${ordered.length - rows + 1} more`, color: "gray" }];
+  return [...ordered.slice(0, rows - 1).map((t) => taskRow(t, now)), { mark: " ", text: `+${ordered.length - rows + 1} more`, color: "gray" }];
+}
+
+// One subagent's row, for the panel and for /tasks.
+export function taskRow(t: Task, now: number): TaskRow {
+  const head = `${t.id} ${visible(t.task.split(/\r?\n/)[0] ?? "")} · ${visible(t.model.slice(t.model.indexOf(":") + 1))}`;
+  if (t.state === "waiting") return { ...MARKS.waiting, text: `${head} · waiting` };
+  const tool = t.state === "running" && t.lastTool ? ` · ${visible([t.lastTool.name, brief(t.lastTool.name, t.lastTool.input)].filter(Boolean).join(" "))}` : "";
+  return { ...MARKS[t.state], text: `${head} · ${elapsed(Math.max(0, (t.ended ?? now) - t.started))} · ↓ ${k(t.output)} tokens · ${costText(t.model, t.cost, t.costUnknown)}${tool}` };
 }
 
 export function TaskPanel({ rows }: { rows: TaskRow[] }) {
```

**Change `src/tui/describe.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/describe.ts b/src/tui/describe.ts
index 81ea09f..831c087 100644
--- a/src/tui/describe.ts
+++ b/src/tui/describe.ts
@@ -50,11 +50,13 @@ export function describe(m: Message): Line[] {
 export function lastTurn(messages: Message[]): Line[] {
   const start = messages.findLastIndex((m) => m.role === "user" && !m.parts.some((p) => p.type === "tool_result"));
   if (start === -1) return [{ text: "No turn yet, so no tool calls to show.", color: "gray" }];
-  const parts = messages.slice(start).flatMap((m) => m.parts);
-  const calls = parts.filter((p) => p.type === "tool_call");
+  const calls = callLines(messages.slice(start));
+  return [{ text: `Last turn: ${calls.length} tool call${calls.length === 1 ? "" : "s"}`, color: "gray" }, ...calls];
+}
+
+// Each tool call in `messages`, with its full input and result, grey: for Ctrl+O and `/tasks t3`.
+export function callLines(messages: Message[]): Line[] {
+  const parts = messages.flatMap((m) => m.parts);
   const results = new Map(parts.flatMap((p) => (p.type === "tool_result" ? [[p.callId, p.output] as const] : [])));
-  return [
-    { text: `Last turn: ${calls.length} tool call${calls.length === 1 ? "" : "s"}`, color: "gray" },
-    ...calls.map((c) => ({ text: `● ${c.name} ${JSON.stringify(c.input, null, 2)}\n  ⎿ ${results.get(c.id) ?? "(not finished)"}`, color: "gray" })),
-  ];
+  return parts.flatMap((c) => (c.type === "tool_call" ? [{ text: `● ${c.name} ${JSON.stringify(c.input, null, 2)}\n  ⎿ ${results.get(c.id) ?? "(not finished)"}`, color: "gray" }] : []));
 }
```

**Change `src/tui/menus.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/menus.ts b/src/tui/menus.ts
index 1dd9e22..57eeb49 100644
--- a/src/tui/menus.ts
+++ b/src/tui/menus.ts
@@ -27,6 +27,7 @@ const COMMANDS: { label: string; run: string; note: string }[] = [
   { label: "/model", run: "/model", note: "Pick the lead model from a list" },
   { label: "/login chatgpt", run: "/login chatgpt", note: "Sign in to ChatGPT" },
   { label: "/logout chatgpt", run: "/logout chatgpt", note: "Sign out of ChatGPT" },
+  { label: "/tasks", run: "/tasks", note: "List the subagents; /tasks t1 shows one, /tasks stop stops them" },
   { label: "/errors", run: "/errors", note: "Summarise the error log" },
   { label: "/exit", run: "/exit", note: "Quit" },
 ];
```


**Step 4: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 1 failed | 38 passed | 2 skipped (41); Tests 1 failed | 660 passed | 10 skipped (671).

**Step 5: Commit**

```bash
git add src/core/tasks.ts src/tui/App.tsx src/tui/TaskPanel.tsx src/tui/describe.ts src/tui/menus.ts tests/tui/app.test.tsx tests/tui/menus.test.ts
git commit -m "feat: /tasks lists the subagents, shows one in full, and stops one or all"
```

### Task 14: README, help text and the designs

- **README:** release 4 of 13; subagents, the search tools, the to-do list and instruction files;
  Node 22.20; the help block; the session paragraph; what `-p` does with a background `delegate`
  and with files outside the project; three known limits; "What comes next".
- **The help text** (`src/cli.tsx`): `--worker`, `--max-tasks` and `/tasks`.
- **The main design:** a Decisions row, "Release 4, as built".
- **The release 4 design:** "As built", where the code differs and why.

**Files:**
- Modify: `README.md`
- Modify: `docs/plans/2026-10-22-tachikoma-design.md`
- Modify: `docs/plans/2026-10-25-tachikoma-release-4-design.md`
- Modify: `src/cli.tsx`

**Step 1: Update the docs and the help text**

**Change `README.md`** (apply with `git apply`, or by hand):

````diff
diff --git a/README.md b/README.md
index a443b65..f9b13c4 100644
--- a/README.md
+++ b/README.md
@@ -1,6 +1,6 @@
 # Tachikoma
 
-> **Work in progress.** Release 3 of 13 is done; the rest is being built. Expect missing
+> **Work in progress.** Release 4 of 13 is done; the rest is being built. Expect missing
 > features and changes that break things, and don't rely on it for real work yet.
 
 Tachikoma is a coding-agent harness written from scratch in TypeScript. Any of several model
@@ -8,8 +8,8 @@ providers can lead a session. Later releases add handing work to other models an
 `codex` and `kimi` command-line tools, long-term memory, search of the codebase by meaning, a Docker
 sandbox, and lessons learned from its own error log.
 
-This is release 3 of 13: the core, signing in with ChatGPT, and Claude Code's keys and screen. The
-command is `tachi`.
+This is release 4 of 13: the core, signing in with ChatGPT, Claude Code's keys and screen, and
+subagents that read, with a to-do list and your instruction files. The command is `tachi`.
 
 ## What it does
 
@@ -31,6 +31,24 @@ command is `tachi`.
   - `never`: never asks. It is meant for the Docker sandbox, which arrives in release 6. Without the
     sandbox it means no checks at all, apart from keeping the keys and the data folder from the
     tools.
+- **Search tools:** `find_files` lists files by a pattern such as `src/**/*.ts`, and `search_files`
+  searches their contents with a regular expression. Both skip `.git` and what the project's
+  `.gitignore` files list, follow no links, and run no program.
+- **Subagents that read:** the lead can hand searching and reading to subagents with its `delegate`
+  tool. Each has `read_file`, `find_files` and `search_files` and reports what it found with file
+  paths and line numbers. Several run side by side, or in the background while the lead goes on; a
+  background answer that arrives while the lead is idle starts a turn by itself. A panel under the
+  prompt shows each one's task, model, time, tokens, cost and latest tool call. `--worker
+  <provider:model>` (or `TACHI_WORKER`) picks their model, the lead's by default, and `--max-tasks`
+  how many run at once (8 by default). `/tasks` lists them, `/tasks t3` shows one in full and
+  `/tasks stop` stops them. A subagent's read outside the project asks first, naming the subagent.
+- **A to-do list** the lead keeps above the prompt while any item is unfinished. Ctrl+T hides or
+  shows it.
+- **Your instruction files:** each session reads `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` (or
+  `CODEX_HOME`'s), and the `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` and `AGENTS.md` of
+  every folder from the top of the drive down to the project, with their `@` imports. A grey line at
+  the start lists them. A file they lead to outside the project asks first, once, unless it is your
+  own; Tachikoma's data folder is never read.
 - **Your keys and login are kept from the model's tools, against accidents:** shell commands do not
   get the API keys, and the file tools refuse Tachikoma's own data folder, where the ChatGPT login
   is kept. A shell command can still read the login; see [Known limits](#known-limits).
@@ -39,9 +57,9 @@ command is `tachi`.
   type while it works waits its turn. `/` lists the commands, `@` the project's files, Shift+Tab
   switches the permission mode and `?` lists every key.
 - **A status line** showing the lead, how much of the context window is left (with a bar), tokens,
-  cost (or "ChatGPT plan"), mode, error count, the project folder and git branch, and how long the
-  session has run; a line under it counts the turn's tool calls. `--status` picks which parts to
-  show.
+  cost (or "ChatGPT plan"), mode, error count, the project folder and git branch, how long the
+  session has run, and how many subagents run; a line under it counts the turn's tool calls.
+  `--status` picks which parts to show. Subagents' tokens and cost count in the totals.
 - **Headless runs:** `-p "<prompt>"` runs one prompt, prints the answer and exits. Add `--json` to
   get every event as one JSON line. Details below.
 - **An error log:** every failure, and every refusal another model answered, is written to
@@ -53,7 +71,7 @@ command is `tachi`.
 
 ## Running from source
 
-You need Node 22 or later.
+You need Node 22.20 or later.
 
 ```bash
 npm install
@@ -92,7 +110,9 @@ tachi logout chatgpt                               sign out of ChatGPT
 --mode <mode>     when to ask before acting: ask | project | never (default: ask)
 --effort <level>  Anthropic models only: low | medium | high | xhigh | max
 --fallback <spec> retry a turn the lead refuses on this model, e.g. openai:<model> (off unless set)
---status <list>   status line parts, comma-separated: lead,context,tokens,cost,mode,errors,project,time,tools
+--worker <spec>   the model subagents run on (or set TACHI_WORKER); the lead's model unless set
+--max-tasks <n>   how many subagents run at once (default: 8)
+--status <list>   status line parts, comma-separated: lead,context,tokens,cost,mode,errors,project,time,tasks,tools
 -p, --print <prompt>  run without the interface
 --json            with -p, print every event as one JSON line
 --raw             with -p, print the answer exactly as written, control codes and all
@@ -100,9 +120,11 @@ tachi logout chatgpt                               sign out of ChatGPT
 ```
 
 In a session, `/lead <provider:model>` switches the lead model, `/model` picks it from a list,
-`/login chatgpt` and `/logout chatgpt` sign in and out, `/errors` summarises the error log and
-`/exit` quits; commands ignore case. Esc or Ctrl-C stops the current turn. When idle, Ctrl-C clears
-the prompt, and pressed twice on an empty prompt it quits. `?` on an empty prompt lists every key.
+`/login chatgpt` and `/logout chatgpt` sign in and out, `/tasks` lists the subagents, `/errors`
+summarises the error log and `/exit` quits; commands ignore case. Esc or Ctrl-C stops the current
+turn and the subagents it waits for; background subagents go on until `/tasks stop` or you quit.
+When idle, Ctrl-C clears the prompt, and pressed twice on an empty prompt it quits. Ctrl+T hides or
+shows the to-do list. `?` on an empty prompt lists every key.
 
 ## Using your ChatGPT plan
 
@@ -144,7 +166,9 @@ a session with an OpenAI model, billed to the plan instead of an API key.
 ## Headless runs
 
 `tachi -p "<prompt>"` prints the answer and exits. Nobody is there to approve an action, so anything
-the permission mode would ask about is refused, and the model is told so.
+the permission mode would ask about is refused, and the model is told so. For the same reason,
+instruction files outside the project are left out, and a line on stderr names them. A background
+subagent runs in the foreground, since there is no later turn to read its answer in.
 
 - **The output is made safe for a terminal**, wherever it goes: control characters, escape codes and
   marks that reorder text, in the answer and in error messages, are printed as text such as
@@ -229,7 +253,15 @@ Each is fixed in a later release, unless it says otherwise.
   the kitty keyboard protocol that tells them apart. A backslash then Enter, or Ctrl+J, makes a new
   line in every terminal (not planned to change).
 - **Ctrl+O prints the last turn's tool calls below the conversation** instead of opening them in
-  place, which needs the full screen (release 5).
+  place, which needs the full screen (release 5). So does `/tasks t3`.
+- **Subagents only read.** Ones that edit or run commands come with the budget controller (release
+  10), after the sandbox (release 6) gives each writer its own copy of the project.
+- **`find_files` patterns skip names that start with a dot** unless the pattern names the dot, as a
+  shell's do: `**/*.yml` misses `.github/workflows/ci.yml`, and `.github/**/*.yml` finds it (not
+  planned to change).
+- **Instruction files are read once, at the start.** A file edited during a session counts from the
+  next, and files in subfolders, which Claude Code reads as it works there, are not read: both need
+  the system prompt to change during a session, which prompt caching rules out (no release is set).
 
 ## What comes next
 
@@ -237,11 +269,11 @@ Each is fixed in a later release, unless it says otherwise.
    with lead switching, the terminal interface with status line, the error log.
 2. Sign in with ChatGPT (done), so an OpenAI model can lead on your ChatGPT plan instead of an API
    key; the `/model` picker.
-3. Claude Code's keys and screen (this release): stopping, editing, multi-line prompts, history,
-   typing while it works, the `/` menu, `@` paths, Shift+Tab modes, the working line and a fuller
-   status line.
+3. Claude Code's keys and screen (done): stopping, editing, multi-line prompts, history, typing
+   while it works, the `/` menu, `@` paths, Shift+Tab modes, the working line and a fuller status
+   line.
 4. Read-only subagents, with a panel under the prompt, and the to-do list; reading the project's and
-   your own instruction files (AGENTS.md, CLAUDE.md).
+   your own instruction files (AGENTS.md, CLAUDE.md) (this release).
 5. Key extras: vim mode, image paste, an external editor, stash, rebinding keys in a file, full
    screen.
 6. Docker sandbox, in two modes (a live link to your folder, or a copy you review before it is
````

**Change `docs/plans/2026-10-22-tachikoma-design.md`** (apply with `git apply`, or by hand):

```diff
diff --git a/docs/plans/2026-10-22-tachikoma-design.md b/docs/plans/2026-10-22-tachikoma-design.md
index 39318fc..4dfde29 100644
--- a/docs/plans/2026-10-22-tachikoma-design.md
+++ b/docs/plans/2026-10-22-tachikoma-design.md
@@ -40,6 +40,7 @@ learn from experience. The command is `tachi`.
 | Release 3, status line | Adds claude-hud's context bar and colours, the project folder and git branch, the session's length and a tool line | User, 2026-10-25 (asked what claude-hud shows; chose all four parts offered) |
 | Release 3, as built | Undo on Ctrl+Z as well as Ctrl+_; the word before the cursor on Alt+Backspace, with Ctrl+Backspace acting as Backspace; the git branch read from `.git/HEAD`, without the `*` for changes; the spinner moving every 80 ms | User, 2026-10-25 (after the key probes in their terminal, and at the build; [release 3 design](2026-10-25-tachikoma-release-3-design.md), "As built") |
 | Instruction files, and importing from other tools | Release 4 reads a project's AGENTS.md or CLAUDE.md, and the user's own, into each session. `tachi setup` (release 12) offers on its first run to import settings, skills, MCP servers and key bindings from Claude Code, Codex and other tools | User, 2026-10-25 ("a first boot import setup to bring over existing Claude and agents Md files and other setting and skills from other programs"; chose both places from options offered) |
+| Release 4, as built | Node 22.20 or later, for its glob matching; `find_files` patterns skip names starting with a dot unless they name the dot; only `.gitignore` files are read, not git's other ignore lists; `TACHI_INSTRUCTIONS_TOP` moves where the walk for instruction files starts, for tests; the search tools read the disk directly, so the sandbox (release 6) must give them a way in | User, at the review of the [release 4 plan](2026-10-26-tachikoma-release-4.md) ([release 4 design](2026-10-25-tachikoma-release-4-design.md), "As built") |
 | Release 4, choices | Subagents use `--worker`'s model, else the lead's; they may run in the background, and one finishing while the lead is idle starts a turn; Esc stops only the subagents a turn waits for; a subagent's read outside the project asks, naming it; no subagent starts another; the lead and subagents get `find_files` and `search_files`, which follow `.gitignore`; the to-do list shows while any item is open; instruction files from `~/.claude`, `~/.codex` and every folder down to the project, CLAUDE.md and AGENTS.md both, with `@` imports; an import leaving the project, or a found file linked to another folder, asks first unless it is the user's own; with `-p`, background subagents run in the foreground | User, 2026-10-25 (chose each from options offered; [release 4 design](2026-10-25-tachikoma-release-4-design.md)) |
 
 ## 1. Overall shape
```

**Change `docs/plans/2026-10-25-tachikoma-release-4-design.md`** (apply with `git apply`, or by hand):

```diff
diff --git a/docs/plans/2026-10-25-tachikoma-release-4-design.md b/docs/plans/2026-10-25-tachikoma-release-4-design.md
index 6827e55..8ec877d 100644
--- a/docs/plans/2026-10-25-tachikoma-release-4-design.md
+++ b/docs/plans/2026-10-25-tachikoma-release-4-design.md
@@ -278,6 +278,28 @@ user's own files.
   and Ctrl+T, the `tasks` part, and model text in all of them cleaned.
 - **Then the user's terminal checklist,** after the last task.
 
+## As built
+
+Where the code differs from the design above, or settles what it left open, and why. The plan
+(`2026-10-26-tachikoma-release-4.md`) lists every choice it makes, each marked in its task.
+
+- **Node 22.20 or later.** `find_files` and `search_files`' `glob` use Node's own glob matching
+  (`path.matchesGlob`), which Node marks stable from 22.20 and 24.8 and experimental before (Node's
+  path docs, read 2026-10-26).
+- **A name starting with a dot matches only a pattern that names the dot,** as in a shell and in
+  Node's matching: `**/*.yml` misses `.github/workflows/ci.yml`. The tool's description says so.
+- **Only `.gitignore` files are read,** not `.git/info/exclude` or git's global ignore file: the
+  design names `.gitignore`, and reading git's settings for the global one would mean reading
+  `.git/config`, which the model can write in `project` mode.
+- **`TACHI_INSTRUCTIONS_TOP`** moves where the walk for instruction files starts, as
+  `TACHI_DATA_DIR` moves the data folder, so the CLI's tests never read the user's files: every
+  temporary folder on Windows is inside the user's profile, whose `.claude/CLAUDE.md` the walk from
+  the top of the drive would find.
+- **The search tools read the disk directly,** as `resolveIn` already does, not through the
+  executor, which has no way to list a folder. The sandbox (release 6) must give them one.
+- **The question about instruction files outside the project comes before the screen starts:** the
+  files go into the system prompt, which is fixed before the first turn.
+
 ## Not in this release
 
 - Subagents that edit or run commands, and CLI workers (`claude -p`, `codex exec`): release 10,
```

**Change `src/cli.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/cli.tsx b/src/cli.tsx
index 269c1f3..2dc8d87 100644
--- a/src/cli.tsx
+++ b/src/cli.tsx
@@ -56,9 +56,10 @@ Options:
   -h, --help        show this help
 
 In a session: /lead <provider:model> switches the lead model, /model picks it from a list,
-/login chatgpt and /logout chatgpt sign in and out, /errors summarises the error log, /exit quits.
-Esc or Ctrl-C stops the current turn. When idle, Ctrl-C clears the prompt, and twice on an empty
-prompt quits. ? on an empty prompt lists every key.`;
+/login chatgpt and /logout chatgpt sign in and out, /tasks lists the subagents (/tasks t1 shows one,
+/tasks stop stops them), /errors summarises the error log, /exit quits. Esc or Ctrl-C stops the
+current turn. When idle, Ctrl-C clears the prompt, and twice on an empty prompt quits. Ctrl+T hides
+or shows the to-do list. ? on an empty prompt lists every key.`;
 
 function fail(message: string): never {
   console.error(message);
```


**Step 2: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 1 failed | 38 passed | 2 skipped (41); Tests 1 failed | 660 passed | 10 skipped (671).

**Step 3: Commit**

```bash
git add README.md docs/plans/2026-10-22-tachikoma-design.md docs/plans/2026-10-25-tachikoma-release-4-design.md src/cli.tsx
git commit -m "docs: release 4 in the README, the help text and the designs"
```

**Step 4: Your terminal checklist (you run it, once)**

In Windows Terminal with PowerShell 5.1, load your Anthropic key as usual, build (`npm run build`)
and start a session in this project with `node dist/cli.js --lead <your lead> --worker
anthropic:claude-haiku-5-5`, then check each of these:
1. The grey start line lists the instruction files read, with their total size. If any file
   reaches outside the project, the question about it comes first.
2. Ask: "Use delegate to find where the status line's parts are listed, and tell me." The panel
   shows a row for the subagent, with its model, time, tokens, cost and latest tool call, and the
   status line says "1 running" while it runs. Its answer comes back in the lead's reply.
3. Ask: "Use delegate with background: true to find where --max-tasks is read, and answer me at
   once." The lead finishes its reply first; when the subagent finishes, a grey line says "t2
   finished" and a turn starts by itself, "Reading t2's answer".
4. `/tasks` lists both subagents; `/tasks t1` prints t1's tool calls and answer.
5. Ask for a task with several steps, telling the lead to use `todo`. The list shows above the
   prompt; Ctrl+T hides it and shows it again.
6. Start one waited-on and one background subagent in one request, then press Esc: the waited-on
   one stops (⊘), the background one goes on.

Record the results in the release 4 design, under "Before the build", and say which failed.
