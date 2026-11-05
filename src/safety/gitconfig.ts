// Git's settings files for a project and the hooks folders they name, read without running anything (release 7
// design, "Live link"; plan, Task 5 and choices 11, 12 and 57). A line added to any of these files, or a program put in
// a hooks folder, can make the user's next git command on the host run a program. So protected paths (Task 6) ask
// before a write to any file or folder listed here (choice 57), and live link makes those inside the project read-only
// in the box. A second `git config` per file gives the line-ending settings live link passes into the box's git (choice
// 100). What is guaranteed: the settings are read only by `git config`, which reads settings and runs nothing; it
// is started by its full path, from the system's temporary folder, with none of the user's git variables but the two
// naming the settings files. Git still looks for a `.git` in the temporary folder itself; GIT_CEILING_DIRECTORIES
// only stops it climbing above that folder, so a project that holds the temporary folder (the home folder, say) is
// never taken as git's repository. A project that is the temporary folder itself would be. Live link also lists the
// project's index once with `git ls-files` (hasSubmodules, choice 123).
import { execFile, spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { errorText } from "../core/types.js";
import { commandEnv, onPath } from "../exec/env.js";

// `files` are the settings files git reads for the project that exist, and every file an include names, missing or
// refused ones included; `hooksPaths` every `core.hooksPath` in any of them, absolute. Each path is given as written and,
// when it differs, as its real path (after links, junctions and short names; for a missing one, its deepest existing
// parent's, choice 62), so either form is protected.
// `gitDirs` are the git folders a `.git` file names inside the project, other than `<top>/.git`, and their shared folder
// (commondir) when that is inside too: protected whole and read-only in the box, as `.git` is (choice 59). One outside
// the project is not listed, as the box cannot reach it.
// `lineEndings` are the project's core.autocrlf and core.eol in force, by git's lower-case names, each as written: the
// last one set in the files as git reads them, the system's, the user's, then the repository's, each include read where it
// stands, whatever its condition (choice 100).
export interface GitSettings {
  files: string[];
  hooksPaths: string[];
  gitDirs: string[];
  problems: { file: string; why: string }[];
  lineEndings: Record<string, string>;
}

// Every include, whatever its condition, and every hooks folder, in one lookup: git gives each key in lower case, but
// for an includeIf's condition, in the file's order (checked with git 2.41.0 by the code review, 2026-10-31).
const SETTINGS = "^(include\\.path|includeif\\..*\\.path|core\\.hookspath)$";
// The line endings, and the includes again to place them by, in a lookup of their own without `--type=path`, which fails
// on an autocrlf with no value (measured with git 2.41.0, 2026-11-02), so the lookup above stays as it was.
const ENDINGS = "^(include\\.path|includeif\\..*\\.path|core\\.autocrlf|core\\.eol)$";
type Step = { set: [string, string] } | { include: string };
// Of git's own variables, only these two pass to it. Any other could change what it reads or prints: GIT_TRACE and its
// kin write to stderr, which `values` reads as a failure; GIT_CONFIG_NOSYSTEM would hide the system's file, which a git
// run elsewhere may read; GIT_DIR names a repository.
const KEPT = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"];

// Undefined when git is not installed (choice 11). Rejects only when a git run fails as `git` (below) says; anything
// else that cannot be read is a problem.
export async function gitSettings(root: string, env: NodeJS.ProcessEnv = process.env): Promise<GitSettings | undefined> {
  const exe = onPath("git", env);
  if (!exe) return undefined;
  // Git does not climb into a ceiling folder looking for a repository, though it looks in the one it starts in
  // (git's GIT_CEILING_DIRECTORIES; checked with git 2.41.0, 2026-10-31, on a repository the check made).
  const gitEnv = { ...ownEnv(env), GIT_CEILING_DIRECTORIES: path.dirname(os.tmpdir()) };
  const run = (args: string[]) => git(exe, args, gitEnv);
  const [system, global] = await Promise.all([scopeFiles(run, "--system"), scopeFiles(run, "--global")]);
  const repo = repository(root);
  const top = repo?.top ?? path.resolve(root);
  const found: GitSettings = { files: [], hooksPaths: [], gitDirs: [], problems: repo?.problem ? [repo.problem] : [], lineEndings: {} };
  for (const dir of repo?.gitDirs ?? []) {
    if (inProject(root, dir) && path.relative(path.join(top, ".git"), dir) !== "") list(found.gitDirs, dir, realPath(dir));
  }
  const seen = new Set<string>();
  // Each entry: a file, whether an include named it (only an include is checked for being a link or missing), and the key
  // it is known by.
  const queue: [string, boolean, string][] = [];
  // Each file read, by its key: its line-ending settings and includes in the file's order, so the line endings can be
  // worked out as git reads them (below). `tops` are the files git starts from, in its order.
  const steps = new Map<string, Step[]>();
  const tops: string[] = [];
  const add = (file: string, included: boolean): string => {
    const real = realPath(file);
    // An included link is known by its own path, so its target named directly is still read, or refused, in its turn.
    const same = included && isLink(file) ? file : (real ?? file);
    const key = process.platform === "win32" ? same.toLowerCase() : same;
    if (seen.has(key)) return key;
    seen.add(key);
    list(found.files, file, real);
    queue.push([file, included, key]);
    return key;
  };
  // Each once, in the order git reads them. `git config --global` names only ~/.gitconfig when both it and the XDG file
  // exist, though git reads the XDG file first (measured with git 2.41.0, 2026-11-02, on files the check made), so
  // scopeNames, in git's order, comes before it.
  const start = (file: string) => {
    const key = add(file, false);
    if (!tops.includes(key)) tops.push(key);
  };
  for (const file of [...system, ...scopeNames(env, "system"), ...scopeNames(env, "global"), ...global]) start(file);
  // A missing one is left out: live link would mount over it, and Docker makes a missing mount's path (choice 57).
  for (const file of repo?.files ?? []) if (existsSync(file)) start(file);
  // The files waiting are read side by side, then their results taken in the order the files were met, so `files`,
  // `hooksPaths` and `problems` keep that order; the includes they name are the next round.
  while (queue.length > 0) {
    const round = queue.splice(0);
    const read = await Promise.all(
      round.map(([file, included]) => {
        const why = included ? refusal(file) : undefined;
        return why ? { why } : Promise.all([values(run, file), endings(run, file)]);
      }),
    );
    round.forEach(([file, , key], i) => {
      const got = read[i]!;
      const [paths, lines] = Array.isArray(got) ? got : [got, []];
      if (!Array.isArray(paths)) {
        found.problems.push({ file, why: paths.why });
        return;
      }
      const includes: string[] = [];
      // Each entry is "<key>\n<value>"; a key with no value names nothing. Git has expanded the value already; an include
      // still relative is relative to the file it is in, and a hooks folder to the repository's top.
      for (const entry of paths) {
        const cut = entry.indexOf("\n");
        const value = cut < 0 ? "" : entry.slice(cut + 1);
        if (!value) continue;
        if (entry.slice(0, cut) === "core.hookspath") {
          const folder = path.resolve(top, value);
          list(found.hooksPaths, folder, realPath(folder));
        } else includes.push(add(path.resolve(path.dirname(file), value), true));
      }
      // The line endings, with each include in its place: the n-th include with a value in this lookup is the n-th
      // above, as both list the file's includes in its order. An autocrlf with no value is true, as git reads it, and an
      // empty one stays empty, which git reads as false; an eol with no value is left out, as git refuses it. Should this
      // lookup fail, the includes are still walked.
      const own: Step[] = [];
      let next = 0;
      for (const entry of lines) {
        const cut = entry.indexOf("\n");
        const name = cut < 0 ? entry : entry.slice(0, cut);
        const value = cut < 0 ? undefined : entry.slice(cut + 1);
        if (name === "core.autocrlf") own.push({ set: [name, value ?? "true"] });
        else if (name === "core.eol") {
          if (value !== undefined) own.push({ set: [name, value] });
        } else if (value && next < includes.length) own.push({ include: includes[next++]! });
      }
      for (const include of includes.slice(next)) own.push({ include });
      steps.set(key, own);
    });
  }
  // The line endings: each file's settings in order, an include's where it stands, the last one set winning. A file is not
  // read again inside itself, so a loop of includes ends (git itself refuses one).
  const open = new Set<string>();
  const walk = (key: string) => {
    if (open.has(key)) return;
    open.add(key);
    for (const step of steps.get(key) ?? []) {
      if ("include" in step) walk(step.include);
      else found.lineEndings[step.set[0]] = step.set[1];
    }
    open.delete(key);
  };
  for (const key of tops) walk(key);
  return found;
}

// The environment every git run here gets: none of the user's git variables but the two naming the settings files.
const ownEnv = (env: NodeJS.ProcessEnv) =>
  commandEnv(Object.fromEntries(Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith("GIT_") || KEPT.includes(name.toUpperCase()))));

// Whether the project holds a git submodule, which live link refuses (choice 123): a gitlink (mode 160000) in git's index
// in the project's folder, checked out or not, as `git status` on the host goes into each. `.gitmodules` alone does not
// make git go in. A project in no repository has none. Git runs in the project, as it reads the project's index, with
// gitSettings's variables, but no ceiling, so it finds the repository repository() finds; `core.fsmonitor` is off, as
// git runs that setting's program when it reads the index, and the list is read as it comes, so a large index is never
// held whole. Rejects, in git's words, when git fails, as live link is then refused.
export function hasSubmodules(root: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!repository(root)) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    // Empty, not "false": git before 2.36 reads the setting as a program's name, and would run one called false.
    const args = ["--no-pager", "-c", "core.fsmonitor=", "ls-files", "--stage", "-z"];
    const child = spawn(onPath("git", env)!, args, { cwd: root, env: ownEnv(env), windowsHide: true });
    let found = false;
    let rest = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      // Each entry is "<mode> <object> <stage>\t<path>".
      const entries = (rest + chunk).split("\0");
      rest = entries.pop()!;
      if (entries.some((entry) => entry.startsWith("160000 "))) found = true;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve(found);
      else reject(new Error(err.trim().split(/\r?\n/)[0]!.replace(/^(fatal|warning|error): /, "") || `exit code ${code ?? signal}`));
    });
  });
}

// The user's or the system's file, where it exists, as git would find it, since git names no file that lists nothing.
// The user's is GIT_CONFIG_GLOBAL, or else the XDG one ($XDG_CONFIG_HOME/git/config, or ~/.config/git/config) and
// ~/.gitconfig, in the order git reads them; the system's is GIT_CONFIG_SYSTEM, whose default git alone knows, as it
// depends on where git is installed (git-config, FILES). A relative one is relative to the folder git runs in.
function scopeNames(env: NodeJS.ProcessEnv, scope: "system" | "global"): string[] {
  const home = homeFolder(env);
  const given = scope === "system" ? env.GIT_CONFIG_SYSTEM : env.GIT_CONFIG_GLOBAL;
  const xdg = env.XDG_CONFIG_HOME || path.join(home, ".config");
  const names = given ? [given] : scope === "global" ? [path.join(xdg, "git", "config"), path.join(home, ".gitconfig")] : [];
  return names.map((name) => path.resolve(os.tmpdir(), name)).filter((name) => existsSync(name));
}

// The home folder git uses for `~/`. With HOME unset, Git for Windows takes HOMEDRIVE and HOMEPATH together when that
// folder exists, and USERPROFILE otherwise (measured with git 2.41.0.windows.1, 2026-10-31, on folders the check made:
// HOMEDRIVE+HOMEPATH was read over USERPROFILE, and USERPROFILE when HOMEDRIVE+HOMEPATH named no folder). Not followed:
// with neither HOMEDRIVE nor HOMEPATH set, that git read the Windows profile folder rather than USERPROFILE; Windows
// sets both for every user.
function homeFolder(env: NodeJS.ProcessEnv): string {
  if (env.HOME) return env.HOME;
  const share = process.platform === "win32" && env.HOMEDRIVE && env.HOMEPATH ? env.HOMEDRIVE + env.HOMEPATH : undefined;
  if (share && isFolder(share)) return share;
  return env.USERPROFILE || os.homedir();
}

const isFolder = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const isLink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

// A path's real place, or undefined when it does not exist. `native` gives the long name for a short (8.3) one.
function realPath(p: string): string | undefined {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
}

// Whether a git folder is inside the project, as written or at its real place: gitSettings lists only those, and live
// link mounts only those (choice 59).
function inProject(root: string, dir: string): boolean {
  const real = realPath(dir);
  return within(root, dir) || (real !== undefined && within(realPath(root) ?? root, real));
}

// Whether the project's own `.git` is a file naming a git folder (or its shared one) outside the project, which live
// link does not mount, so git does not work in the box (design, "Live link"; choice 107).
export function gitFolderOutside(root: string): boolean {
  if (!lstatSync(path.join(root, ".git"), { throwIfNoEntry: false })?.isFile()) return false;
  return repository(root)?.gitDirs?.some((dir) => !inProject(root, dir)) ?? false;
}

// Whether `p` is `root` or inside it (path.relative compares without case on Windows). A name that only starts with
// two dots, such as `..bare`, is inside. Live link's mounts use it too (sandbox/mounts.ts).
export function within(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root), p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// Adds a path as written and its real path, each once. A missing path's real place is its deepest existing parent's
// real path plus the rest, so a project reached through a link or a short name still matches it (choice 62).
function list(into: string[], written: string, real: string | undefined) {
  for (const p of [written, real ?? missingPlace(written)]) if (p && !into.includes(p)) into.push(p);
}

// Where a path that does not exist would be, as realTarget in tools/files.ts finds it: undefined for a link that leads
// nowhere, or a parent whose real path cannot be told.
function missingPlace(p: string): string | undefined {
  let existing = path.resolve(p);
  const rest: string[] = [];
  try {
    while (!existsSync(existing) && path.dirname(existing) !== existing) {
      if (lstatSync(existing, { throwIfNoEntry: false })) return undefined;
      rest.unshift(path.basename(existing));
      existing = path.dirname(existing);
    }
  } catch {
    return undefined;
  }
  const real = realPath(existing);
  return real === undefined ? undefined : path.join(real, ...rest);
}

type Run = (args: string[]) => Promise<{ code: number; out: string; err: string }>;

// The files git names for one scope. `--show-origin` with `-z` gives each origin unquoted ("file:<path>"); without
// -z, a path with a space or a letter outside ASCII comes back quoted, with octal escapes (measured with git 2.41.0,
// 2026-10-31). `--system` and `--global` follow no includes, so these are the scope's own files. A scope with no file
// fails, and an empty file is not named, as it lists nothing (scopeNames adds it).
async function scopeFiles(run: Run, scope: string): Promise<string[]> {
  const { code, out } = await run(["config", scope, "--list", "--show-origin", "-z"]);
  if (code !== 0) return [];
  const files = new Set<string>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i += 2) if (parts[i]!.startsWith("file:")) files.add(path.resolve(os.tmpdir(), parts[i]!.slice("file:".length)));
  return [...files];
}

// A file's includes and hooks folders, or why it could not be read. `--type=path` has git expand `~/`, `~user/` and
// `%(prefix)/` as it does when it reads the setting; one it cannot expand fails the lookup. Exit 1 with nothing on
// stderr is "nothing matched", as it is for a file that does not exist; a file git cannot open, such as a folder, also
// exits 1, with a warning (measured with git 2.41.0, 2026-10-31).
async function values(run: Run, file: string): Promise<string[] | { why: string }> {
  const { code, out, err } = await run(["config", "--file", file, "-z", "--type=path", "--get-regexp", SETTINGS]);
  const why = err.trim().split(/\r?\n/)[0]!.replace(/^(fatal|warning|error): /, "");
  if (code === 0) return out.split("\0").filter(Boolean);
  if (code === 1 && !why) return [];
  return { why: `it cannot be read: ${why || `exit code ${code}`}` };
}

// A file's line-ending settings and includes as written, in its order; none when the lookup fails, as `values` gives
// that file's problem.
async function endings(run: Run, file: string): Promise<string[]> {
  const { code, out } = await run(["config", "--file", file, "-z", "--get-regexp", ENDINGS]);
  return code === 0 ? out.split("\0").filter(Boolean) : [];
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
// `.git`, a `.git` file or a `commondir` that cannot be read. `gitDirs` are the repository's folder and the shared one,
// wherever they are; gitSettings keeps those inside the project.
function repository(root: string): { top: string; files: string[]; gitDirs?: string[]; problem?: { file: string; why: string } } | undefined {
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, ".git");
    const refused = (file: string, why: string) => ({ top: dir, files: [], problem: { file, why: `it cannot be read: ${why}` } });
    let st;
    try {
      st = statSync(dotGit, { throwIfNoEntry: false });
    } catch (err) {
      return refused(dotGit, errorText(err));
    }
    if (st) {
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
      return { top: dir, files: [path.join(common, "config"), path.join(gitDir, "config.worktree")], gitDirs: [gitDir, common] };
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

// One git run, by its full path (onPath), from the system's temporary folder. It gives git's exit code and output, and
// rejects when git cannot be started, is stopped by a signal, or writes more than execFile's maxBuffer (Node's
// default); the caller of gitSettings (Task 8) handles that rejection.
function git(exe: string, args: string[], env: NodeJS.ProcessEnv): ReturnType<Run> {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { cwd: os.tmpdir(), env, windowsHide: true, encoding: "utf8" }, (error, out, err) => {
      if (error && typeof error.code !== "number") reject(error);
      else resolve({ code: error ? (error.code as number) : 0, out, err });
    });
  });
}
