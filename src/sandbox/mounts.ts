// Live link's mounts (release 7 design, "Live link"; plan, Task 15 and choices 11, 31, 57, 59, 62 and 100). The box writes
// straight into the project, so what could make the user's next git command on the host run a program is mounted
// read-only over it: all of `.git` (a folder or a file), the git folders a `.git` file names inside the project, every
// settings file git's settings include from inside it, every hooks folder they name inside it (and husky's scripts), and
// Claude Code's top-level block (`HEAD`, `objects`, `refs`, a `config` file). `.tachikoma`, Tachikoma's own folder, is hidden under an empty tmpfs.
// Nothing is mounted over a path that does not exist, as Docker would make it in the real folder (Docker's bind-mount
// docs). Each mount follows the project's own (DockerExecutor.start).
import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { type GitSettings, within } from "../safety/gitconfig.js";

// A host path read-only in the box, or a box path hidden under an empty tmpfs.
export type Mount = { host: string; box: string; readOnly: true } | { box: string; hidden: true };

const BOX = "/work";
// Claude Code's top-level block, mounted only where it exists (design, "What stays open"); `config` only as a file, as a
// `config/` folder is the project's own, which the box must be able to edit (choice 103).
const TOP = ["HEAD", "objects", "refs"];

// The mounts, and the variables the box's git needs, or why live link is refused. Only once nothing refuses is a missing
// `.tachikoma` made, an empty folder of Tachikoma's own (choice 31): left unmounted, the box could make one.
export function liveMounts(root: string, git: GitSettings | undefined): { mounts: Mount[]; env: Record<string, string> } | { refused: string } {
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
  const mounts: Mount[] = [...found]
    .filter(([box]) => !boxes.some((other) => box.startsWith(`${other}/`)))
    .map(([box, host]) => ({ host, box, readOnly: true }));
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

// A path's real place, or undefined when it does not exist. `native` gives the long name for a short (8.3) one.
function realPath(p: string): string | undefined {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
}
