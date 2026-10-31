// Git's settings files for a project and the hooks folders they name, read without running anything (release 7
// design, "Live link"; plan, Task 5 and choices 11, 12 and 57). A line added to any of these files, or a program put in
// a hooks folder, can make the user's next git command on the host run a program. So protected paths (Task 6) ask
// before a write to any file or folder listed here (choice 57), and live link makes those inside the project read-only
// in the box. `git config --file` only reads; git itself runs from the system's temporary folder, never the project,
// where `.git/config` could make it run programs.
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { errorText } from "../core/types.js";
import { commandEnv, onPath } from "../exec/env.js";

// `files` are the settings files git reads for the project that exist, and every file an include names, missing or
// refused ones included; `hooksPaths` every `core.hooksPath` in any of them, absolute. Each path is given as written and,
// when it exists and differs, as its real path (after links, junctions and short names), so either form is protected.
export interface GitSettings { files: string[]; hooksPaths: string[]; problems: { file: string; why: string }[] }

const INCLUDES = "^(include|includeif\\..*)\\.path$";

// Undefined when git is not installed (choice 11).
export async function gitSettings(root: string, env: NodeJS.ProcessEnv = process.env): Promise<GitSettings | undefined> {
  const exe = onPath("git", env);
  if (!exe) return undefined;
  // The system's file is read even if the user turned it off for their own git runs: a git run elsewhere may not.
  const gitEnv = commandEnv(Object.fromEntries(Object.entries(env).filter(([name]) => name.toUpperCase() !== "GIT_CONFIG_NOSYSTEM")));
  const run = (args: string[]) => git(exe, args, gitEnv);
  const named = [...(await scopeFiles(run, "--system")), ...(await scopeFiles(run, "--global"))];
  const repo = repository(root);
  const top = repo?.top ?? path.resolve(root);
  const found: GitSettings = { files: [], hooksPaths: [], problems: repo?.problem ? [repo.problem] : [] };
  const seen = new Set<string>();
  // Each entry: a file, and whether an include named it (only an include is checked for being a link or missing).
  const queue: [string, boolean][] = [];
  const add = (file: string, included: boolean) => {
    const real = realPath(file);
    const key = process.platform === "win32" ? (real ?? file).toLowerCase() : (real ?? file);
    if (seen.has(key)) return;
    seen.add(key);
    list(found.files, file, real);
    queue.push([file, included]);
  };
  for (const file of named) add(file, false);
  // A missing one is left out: live link would mount over it, and Docker makes a missing mount's path (choice 57).
  for (const file of repo?.files ?? []) if (existsSync(file)) add(file, false);
  for (let next = queue.shift(); next; next = queue.shift()) {
    const [file, included] = next;
    if (included) {
      const why = refusal(file);
      if (why) {
        found.problems.push({ file, why });
        continue;
      }
    }
    const includes = await values(run, file, ["--get-regexp", INCLUDES]);
    const hooks = await values(run, file, ["--get-all", "core.hooksPath"]);
    for (const failed of [includes, hooks]) {
      if (typeof failed === "string") {
        found.problems.push({ file, why: `it cannot be read: ${failed}` });
        break;
      }
    }
    if (typeof includes !== "string") {
      // Each entry is "<key>\n<value>"; a key with no value includes nothing. Git has expanded the value already; one
      // still relative is relative to the file it is in.
      for (const entry of includes) {
        const value = entry.includes("\n") ? entry.slice(entry.indexOf("\n") + 1) : "";
        if (value) add(path.resolve(path.dirname(file), value), true);
      }
    }
    if (typeof hooks !== "string") {
      for (const value of hooks) {
        const folder = path.resolve(top, value);
        list(found.hooksPaths, folder, realPath(folder));
      }
    }
  }
  return found;
}

// A path's real place, or undefined when it does not exist. `native` gives the long name for a short (8.3) one.
function realPath(p: string): string | undefined {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
}

// Adds a path as written and its real path, each once.
function list(into: string[], written: string, real: string | undefined) {
  for (const p of [written, real]) if (p && !into.includes(p)) into.push(p);
}

type Run = (args: string[]) => Promise<{ code: number; out: string; err: string }>;

// The files git names for one scope. `--show-origin` with `-z` gives each origin unquoted ("file:<path>"); without
// -z, a path with a space or a letter outside ASCII comes back quoted, with octal escapes (measured with git 2.41.0,
// 2026-10-31). `--system` and `--global` follow no includes, so these are the scope's own files. A scope with no file
// fails, and an empty file is not named, as it lists nothing; neither holds an include.
async function scopeFiles(run: Run, scope: string): Promise<string[]> {
  const { code, out } = await run(["config", scope, "--list", "--show-origin", "-z"]);
  if (code !== 0) return [];
  const files = new Set<string>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i += 2) if (parts[i]!.startsWith("file:")) files.add(path.resolve(os.tmpdir(), parts[i]!.slice("file:".length)));
  return [...files];
}

// The values one `git config --file` lookup gives, or why the file could not be read. `--type=path` has git expand
// `~/`, `~user/` and `%(prefix)/` as it does when it reads the setting; one it cannot expand fails the lookup. Exit 1
// with nothing on stderr is "nothing matched", as it is for a file that does not exist; a file git cannot open, such as
// a folder, also exits 1, with a warning (measured with git 2.41.0, 2026-10-31).
async function values(run: Run, file: string, lookup: string[]): Promise<string[] | string> {
  const { code, out, err } = await run(["config", "--file", file, "-z", "--type=path", ...lookup]);
  const why = err.trim().split(/\r?\n/)[0]!.replace(/^(fatal|warning|error): /, "");
  if (code === 0) return out.split("\0").filter(Boolean);
  if (code === 1 && !why) return [];
  return why || `exit code ${code}`;
}

// Why an included file is refused, before git reads it: a link could be changed to lead anywhere.
function refusal(file: string): string | undefined {
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink()) return "it is a link";
    if (st.isDirectory()) return "it cannot be read: it is a folder";
    return undefined;
  } catch (err) {
    return `it cannot be read: ${(err as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : errorText(err)}`;
  }
}

// The repository the project is in, found as gitBranch finds it (tui/git.ts): its top folder, and its config and
// config.worktree. A `.git` file names the repository's folder ("gitdir: <path>"), and a worktree's folder has a
// `commondir` file naming the shared one, which holds config (gitrepository-layout); config.worktree is the worktree's
// own. A `.git` file git would refuse is a problem, in git's own words (setup.c, read_gitfile_error_die), as is a
// `.git` file or `commondir` that cannot be read.
function repository(root: string): { top: string; files: string[]; problem?: { file: string; why: string } } | undefined {
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, ".git");
    const st = statSync(dotGit, { throwIfNoEntry: false });
    if (st) {
      const refused = (file: string, why: string) => ({ top: dir, files: [], problem: { file, why: `it cannot be read: ${why}` } });
      let gitDir = dotGit;
      if (!st.isDirectory()) {
        let text: string;
        try {
          text = readFileSync(dotGit, "utf8");
        } catch (err) {
          return refused(dotGit, errorText(err));
        }
        if (!text.startsWith("gitdir: ")) return refused(dotGit, `invalid gitfile format: ${dotGit}`);
        const named = text.slice("gitdir: ".length).trim();
        if (!named) return refused(dotGit, `no path in gitfile: ${dotGit}`);
        gitDir = path.resolve(dir, named);
      }
      let common = gitDir;
      try {
        common = path.resolve(gitDir, readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") return refused(path.join(gitDir, "commondir"), errorText(err));
      }
      return { top: dir, files: [path.join(common, "config"), path.join(gitDir, "config.worktree")] };
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

// One git run, by its full path (onPath), from the system's temporary folder. Rejects only when git could not be
// started.
function git(exe: string, args: string[], env: NodeJS.ProcessEnv): ReturnType<Run> {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { cwd: os.tmpdir(), env, windowsHide: true, encoding: "utf8" }, (error, out, err) => {
      if (error && typeof error.code !== "number") reject(error);
      else resolve({ code: error ? (error.code as number) : 0, out, err });
    });
  });
}
