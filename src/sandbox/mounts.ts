// Live link's mounts (release 7 design, "Live link"; plan, Task 15 and choices 11, 31, 57, 59, 62, 100 and 102-105).
// The box writes straight into the project, so what could make the user's next git command on the host run a program
// is mounted read-only over it: all of `.git` (a folder or a file), the git folders a `.git` file names inside the
// project, every settings file git's settings include from inside it, every hooks folder they name inside it (and
// husky's scripts), and Claude Code's top-level block (`HEAD`, `objects`, `refs`, a `config` file). Each folder
// between `/work` and such a mount is mounted onto itself, so the box cannot rename it away from the mount (choice 105).
// `.tachikoma`, Tachikoma's own folder, is hidden under an empty tmpfs. Nothing is mounted over a path that does not
// exist, as Docker would make it in the real folder (Docker's bind-mount docs). Each mount follows the project's own
// (DockerExecutor.start).
import { lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { type GitSettings, within } from "../safety/gitconfig.js";

// A host path read-only in the box, a host folder mounted onto itself, writable, so it cannot be renamed (choice 105),
// or a box path hidden under an empty tmpfs.
export type Mount = { host: string; box: string; readOnly: boolean } | { box: string; hidden: true };

const BOX = "/work";
// Claude Code's top-level block, mounted only where it exists (design, "What stays open"); `config` only as a file, as a
// `config/` folder is the project's own, which the box must be able to edit (choice 103).
const TOP = ["HEAD", "objects", "refs"];

// Choice 104's refusal. The launch says it right after choice 13's (choice 108; clilib.ts, sandboxReady).
export const CASE_REFUSED =
  "Live link is refused: this folder ignores letter case, as Windows and macOS do by default, so the box could reach " +
  "git's files by another spelling. Launch with --sandbox copy instead.";

// The mounts, and the variables the box's git needs, or why live link is refused. Only once nothing refuses is a missing
// `.tachikoma` made, an empty folder of Tachikoma's own (choice 31): left unmounted, the box could make one. First of
// all, a folder that ignores letter case is refused (choice 104): a mount covers one spelling, and on Docker Desktop for
// Windows the box reached `.git/hooks` as `.GIT/hooks`. `ignoresCase` is the check, which tests replace.
export function liveMounts(
  root: string,
  git: GitSettings | undefined,
  opts: { ignoresCase?: (folder: string) => boolean } = {},
): { mounts: Mount[]; env: Record<string, string> } | { refused: string } {
  if ((opts.ignoresCase ?? ignoresCase)(root)) return { refused: CASE_REFUSED };
  if (!git) return { refused: "Live link needs git on this PC to read git's settings; use --sandbox copy, or install git." }; // choice 11
  const problem = git.problems[0];
  // Task 5's whys start "it is" or "it cannot", which the line's "which" stands for.
  const why = problem?.why.replace(/^it /, "");
  if (problem) return { refused: `Live link is refused: git's settings include ${problem.file}, which ${why}. Launch with --sandbox copy instead.` };
  const real = realpathSync.native(root);
  // Task 5 lists each hooks folder as written and at its real place (choice 62), so either may be the project's.
  const missing = git.hooksPaths.find((p) => (within(root, p) || within(real, p)) && !lstatSync(p, { throwIfNoEntry: false }));
  if (missing) {
    return {
      refused:
        `Live link is refused: git's hooks folder ${missing} does not exist yet, so the box could make it. ` +
        "Create the folder, or launch with --sandbox copy instead.",
    };
  }
  // Each place once, by its real path, so the two spellings of one place give one mount (choice 62). One that does not
  // exist is left out: an included file that does not exist is already a problem, and the top-level block may be missing.
  // Husky 9's hooks folder is `<dir>/_`, whose hooks run the scripts in `<dir>` (choice 102), so that folder is read-only
  // too, unless it is the project itself.
  const husky = git.hooksPaths.filter((p) => path.basename(p) === "_").map((p) => path.dirname(p)).filter((p) => realPath(p) !== real);
  const config = path.join(root, "config");
  const top = [...TOP.map((name) => path.join(root, name)), ...(statSync(config, { throwIfNoEntry: false })?.isFile() ? [config] : [])];
  const found = new Map<string, string>();
  for (const p of [path.join(root, ".git"), ...git.gitDirs, ...git.files, ...git.hooksPaths, ...husky, ...top]) {
    const host = realPath(p);
    if (host === undefined || !within(real, host)) continue;
    const box = path.posix.join(BOX, ...path.relative(real, host).split(path.sep));
    if (!found.has(box)) found.set(box, host);
  }
  // One inside a folder mounted read-only is covered by it. A mount of its own would also keep the old file in the box
  // after git on the host replaces it, as git writes a settings file by renaming a new one over it.
  const boxes = [...found.keys()];
  const kept = [...found].filter(([box]) => !boxes.some((other) => box.startsWith(`${other}/`)));
  // The folders between /work and each one, once each: Linux lets a folder holding a mount be renamed, the mount going
  // with it, so `mv settings s2` and a new `settings/extra.cfg` got round an included file's mount, while a mount point
  // cannot be renamed (both measured on Docker Desktop for Windows, 2026-11-02; choice 105).
  const pins = new Map<string, string>();
  for (const [, host] of kept) {
    for (let dir = path.dirname(host); dir !== real && within(real, dir); dir = path.dirname(dir)) {
      pins.set(path.posix.join(BOX, ...path.relative(real, dir).split(path.sep)), dir);
    }
  }
  const mounts: Mount[] = [
    ...[...pins].sort(([a], [b]) => (a < b ? -1 : 1)).map(([box, host]) => ({ host, box, readOnly: false })),
    ...kept.map(([box, host]) => ({ host, box, readOnly: true })),
  ];
  const own = path.join(root, ".tachikoma");
  if (!lstatSync(own, { throwIfNoEntry: false })) mkdirSync(own);
  mounts.push({ box: `${BOX}/.tachikoma`, hidden: true });
  // safe.directory: git in the box refused /work as "detected dubious ownership" (measured on 2026-11-02, Docker Desktop on
  // Windows, Docker 29.9.2), as the folder's owner there is not the box's user. Git takes the setting only from protected
  // settings, which include the command line's, as these variables are (git-config, safe.directory and SCOPES).
  return { mounts, env: sessionSettings({ "safe.directory": BOX, ...git.lineEndings }) };
}

// Git's settings for every git run in the box, with nothing on disk changed (choice 100): git reads GIT_CONFIG_COUNT
// pairs of GIT_CONFIG_KEY_<n> and GIT_CONFIG_VALUE_<n> as settings given on its command line (git-config, ENVIRONMENT).
function sessionSettings(settings: Record<string, string>): Record<string, string> {
  const pairs = Object.entries(settings);
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

// Whether the folder ignores letter case: a name in it, spelled with its letters' case swapped, reaches the same file or
// folder. Its own entries are the names the box would look up; one with no letters among them is told by its own name
// in the folder above, then by the folders above that. Nothing is made in the folder. Windows sets case per folder, so
// a folder inside it that differs is not seen (a known limit).
export function ignoresCase(folder: string): boolean {
  const real = realpathSync.native(folder);
  const names = readdirSync(real).map((name) => path.join(real, name));
  for (let p = real; path.dirname(p) !== p; p = path.dirname(p)) names.push(p);
  const named = names.find((p) => /[a-z]/i.test(path.basename(p)));
  if (named === undefined) return false;
  const swapped = path.basename(named).replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  const other = lstatSync(path.join(path.dirname(named), swapped), { bigint: true, throwIfNoEntry: false });
  const same = lstatSync(named, { bigint: true });
  return other !== undefined && other.dev === same.dev && other.ino === same.ino;
}

// A path's real place, or undefined when it does not exist. `native` gives the long name for a short (8.3) one.
function realPath(p: string): string | undefined {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
}
