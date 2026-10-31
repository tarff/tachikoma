// Git's settings files for a project and the hooks folders they name, read without running anything (release 7
// design, "Live link"; plan, Task 5 and choices 11 and 12). Live link makes every included file inside the project and
// every hooks folder read-only in the box, and protected paths (Task 6) ask before a write to any of them, since a
// change there makes the user's next git command on the host run a program. `git config --file` only reads; git itself
// runs from the system's temporary folder, never the project, where `.git/config` could make it run programs.
import { execFile } from "node:child_process";
import { lstatSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { errorText } from "../core/types.js";
import { commandEnv } from "../exec/env.js";

// `files` are every settings file git reads for the project, includes named but missing or refused among them;
// `hooksPaths` every `core.hooksPath` in any of them, absolute.
export interface GitSettings { files: string[]; hooksPaths: string[]; problems: { file: string; why: string }[] }

const INCLUDES = "^(include|includeif\\..*)\\.path$";

// Undefined when git is not installed (choice 11).
export async function gitSettings(root: string, env: NodeJS.ProcessEnv = process.env): Promise<GitSettings | undefined> {
  // The system's file is read even if the user turned it off for their own git runs: a git run elsewhere may not.
  const gitEnv = commandEnv(Object.fromEntries(Object.entries(env).filter(([name]) => name.toUpperCase() !== "GIT_CONFIG_NOSYSTEM")));
  const home = env.HOME || env.USERPROFILE || os.homedir();
  let named: string[];
  try {
    named = [...(await scopeFiles("--system", gitEnv)), ...(await scopeFiles("--global", gitEnv))];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const repo = repository(root);
  const top = repo?.top ?? path.resolve(root);
  const found: GitSettings = { files: [], hooksPaths: [], problems: [] };
  const seen = new Set<string>();
  // Each entry: a file, and whether an include named it (only an include is checked for being a link or missing).
  const queue: [string, boolean][] = [];
  const add = (file: string, included: boolean, into: string[]) => {
    const key = process.platform === "win32" ? file.toLowerCase() : file;
    if (seen.has(key)) return;
    seen.add(key);
    into.push(file);
    queue.push([file, included]);
  };
  for (const file of [...named, ...(repo?.files ?? [])]) add(file, false, found.files);
  for (let next = queue.shift(); next; next = queue.shift()) {
    const [file, included] = next;
    if (included) {
      const why = refusal(file);
      if (why) {
        found.problems.push({ file, why });
        continue;
      }
    }
    const includes = await values(file, ["--get-regexp", INCLUDES], gitEnv);
    const hooks = await values(file, ["--get-all", "core.hooksPath"], gitEnv);
    for (const failed of [includes, hooks]) {
      if (typeof failed === "string") {
        found.problems.push({ file, why: `it cannot be read: ${failed}` });
        break;
      }
    }
    if (typeof includes !== "string") {
      // Each line is "<key>\n<value>"; a key with no value includes nothing.
      for (const entry of includes) {
        const value = entry.includes("\n") ? entry.slice(entry.indexOf("\n") + 1) : "";
        if (value) add(path.resolve(path.dirname(file), expand(value, home)), true, found.files);
      }
    }
    if (typeof hooks !== "string") {
      for (const value of hooks) {
        const folder = path.resolve(top, expand(value, home));
        if (!found.hooksPaths.includes(folder)) found.hooksPaths.push(folder);
      }
    }
  }
  return found;
}

// The files git names for one scope. `--show-origin` with `-z` gives each origin unquoted ("file:<path>"); without
// -z, a path with a space or a letter outside ASCII comes back quoted, with octal escapes (measured with git 2.41.0,
// 2026-10-31). `--system` and `--global` follow no includes, so these are the scope's own files. A scope with no file
// fails, and an empty file is not named, as it lists nothing; neither holds an include.
async function scopeFiles(scope: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const { code, out } = await git(["config", scope, "--list", "--show-origin", "-z"], env);
  if (code !== 0) return [];
  const files = new Set<string>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i += 2) if (parts[i]!.startsWith("file:")) files.add(path.resolve(os.tmpdir(), parts[i]!.slice("file:".length)));
  return [...files];
}

// The values one `git config --file` lookup gives, or why the file could not be read. Exit 1 with nothing on stderr is
// "nothing matched", as it is for a file that does not exist; a file git cannot open, such as a folder, also exits 1,
// with a warning (measured with git 2.41.0, 2026-10-31).
async function values(file: string, lookup: string[], env: NodeJS.ProcessEnv): Promise<string[] | string> {
  const { code, out, err } = await git(["config", "--file", file, "-z", ...lookup], env);
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

// `~/` is the home folder, as git expands a path setting.
const expand = (value: string, home: string) => (value.startsWith("~/") ? path.join(home, value.slice(2)) : value);

// The repository the project is in, found as gitBranch finds it (tui/git.ts): its top folder, and its config and
// config.worktree. A `.git` file names the repository's folder ("gitdir: <path>"), and a worktree's folder has a
// `commondir` file naming the shared one, which holds config (gitrepository-layout); config.worktree is the worktree's
// own.
function repository(root: string): { top: string; files: string[] } | undefined {
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, ".git");
    const st = statSync(dotGit, { throwIfNoEntry: false });
    if (st) {
      const gitDir = st.isDirectory() ? dotGit : path.resolve(dir, readFileSync(dotGit, "utf8").replace(/^gitdir: /, "").trim());
      let common = gitDir;
      try {
        common = path.resolve(gitDir, readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      return { top: dir, files: [path.join(common, "config"), path.join(gitDir, "config.worktree")] };
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

// One git run, from the system's temporary folder. Rejects only when git could not be started (ENOENT: not installed).
function git(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: os.tmpdir(), env, windowsHide: true, encoding: "utf8" }, (error, out, err) => {
      if (error && typeof error.code !== "number") reject(error);
      else resolve({ code: error ? (error.code as number) : 0, out, err });
    });
  });
}
