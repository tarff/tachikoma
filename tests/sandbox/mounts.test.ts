import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { GitSettings } from "../../src/safety/gitconfig.js";
import { ignoresCase, liveMounts } from "../../src/sandbox/mounts.js";
import { removeTree } from "../helpers.js";

// A test's own folder, holding a project with `tree` in it (a name ending in / is a folder), and what gitSettings would
// give, filled in by the test. No git runs here: tests/sandbox/livelink.test.ts has the real ones.
function world(tree: string[] = []) {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "tachi-mounts-")));
  onTestFinished(() => removeTree(dir));
  const root = path.join(dir, "project");
  mkdirSync(root);
  const at = (rel: string) => path.join(root, rel);
  for (const p of tree) {
    mkdirSync(path.dirname(at(p)), { recursive: true });
    if (p.endsWith("/")) mkdirSync(at(p), { recursive: true });
    else writeFileSync(at(p), "");
  }
  const git: GitSettings = { files: [], hooksPaths: [], gitDirs: [], problems: [], lineEndings: {} };
  return { dir, root, at, git };
}

// Live link on a folder taken as minding letter case, as a Linux one does: the check itself has its own tests below. The
// project has no submodules (choice 123; livelink.test.ts finds them with git).
const live = (root: string, git: GitSettings | undefined) => liveMounts(root, git, { ignoresCase: () => false, submodules: false });
const readOnly = (host: string, box: string) => ({ host, box, readOnly: true });
const pinned = (host: string, box: string) => ({ host, box, readOnly: false });
const HIDDEN = { box: "/work/.tachikoma", hidden: true };
// Git in the box takes /work as safe, whoever owns it there.
const SAFE = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "/work" };

describe("liveMounts", () => {
  it("refuses a folder that ignores letter case before anything else, making nothing (choice 104)", () => {
    const w = world();
    const refused =
      "Live link is refused: this folder ignores letter case, as Windows and macOS do by default, so the box could reach " +
      "git's files by another spelling. Launch with --sandbox copy instead.";
    const asked: string[] = [];
    const ignores = (folder: string) => (asked.push(folder), true);
    expect(liveMounts(w.root, undefined, { ignoresCase: ignores, submodules: false })).toEqual({ refused });
    expect(liveMounts(w.root, w.git, { ignoresCase: ignores, submodules: true })).toEqual({ refused });
    expect(asked).toEqual([w.root, w.root]);
    expect(readdirSync(w.root)).toEqual([]);
  });

  it("refuses a project with git submodules, making nothing (choice 123)", () => {
    const w = world([".gitmodules"]);
    const refused =
      "Live link is refused: this project has git submodules, whose git settings the box could change for git on your " +
      "machine to run. Launch with --sandbox copy instead.";
    expect(liveMounts(w.root, w.git, { ignoresCase: () => false, submodules: true })).toEqual({ refused });
    expect(readdirSync(w.root)).toEqual([".gitmodules"]);
    // `.gitmodules` alone is not a submodule.
    expect(live(w.root, w.git)).toEqual({ mounts: [HIDDEN], env: SAFE });
  });

  it("pins each folder between /work and a read-only mount onto itself, writable, once (choice 105)", () => {
    const w = world(["web/app/.husky/_/h", "web/app/settings/extra.cfg", "web/other.cfg"]);
    w.git.hooksPaths.push(w.at("web/app/.husky/_"));
    w.git.files.push(w.at("web/app/settings/extra.cfg"), w.at("web/other.cfg"));
    expect(live(w.root, w.git)).toEqual({
      mounts: [
        pinned(w.at("web"), "/work/web"),
        pinned(w.at("web/app"), "/work/web/app"),
        pinned(w.at("web/app/settings"), "/work/web/app/settings"),
        readOnly(w.at("web/app/settings/extra.cfg"), "/work/web/app/settings/extra.cfg"),
        readOnly(w.at("web/other.cfg"), "/work/web/other.cfg"),
        readOnly(w.at("web/app/.husky"), "/work/web/app/.husky"),
        HIDDEN,
      ],
      env: SAFE,
    });
  });

  it("refuses without git, in choice 11's line", () => {
    const w = world();
    expect(live(w.root, undefined)).toEqual({ refused: "Live link needs git on this PC to read git's settings; use --sandbox copy, or install git." });
    expect(existsSync(w.at(".tachikoma"))).toBe(false);
  });

  it("refuses on a problem in git's settings, naming the file and why", () => {
    const w = world();
    const file = w.at("linked.cfg");
    w.git.problems.push({ file, why: "it is a link" }, { file: w.at("other.cfg"), why: "it cannot be read: no such file" });
    expect(live(w.root, w.git)).toEqual({
      refused: `Live link is refused: git's settings include ${file}, which is a link. Launch with --sandbox copy instead.`,
    });
    w.git.problems.shift();
    expect(live(w.root, w.git)).toEqual({
      refused: `Live link is refused: git's settings include ${w.at("other.cfg")}, which cannot be read: no such file. Launch with --sandbox copy instead.`,
    });
    expect(existsSync(w.at(".tachikoma"))).toBe(false);
  });

  it("refuses a hooks folder in the project that does not exist yet, making nothing", () => {
    const w = world([".git/"]);
    w.git.hooksPaths.push(w.at(".githooks"));
    expect(live(w.root, w.git)).toEqual({
      refused:
        `Live link is refused: git's hooks folder ${w.at(".githooks")} does not exist yet, so the box could make it. ` +
        "Create the folder, or launch with --sandbox copy instead.",
    });
    expect(readdirSync(w.root)).toEqual([".git"]);
  });

  it("mounts .git, the git folders, included files and hooks folders in the project and the top-level block read-only, then hides .tachikoma", () => {
    const w = world([".git/config", ".bare/", "settings/extra.cfg", ".husky/pre-commit", "HEAD", "refs/", "src/a.ts"]);
    w.git.files.push(path.join(w.dir, "system.cfg"), w.at(".git/config"), w.at("settings/extra.cfg"));
    w.git.hooksPaths.push(w.at(".husky"), path.join(w.dir, "elsewhere-hooks"));
    w.git.gitDirs.push(w.at(".bare"));
    expect(live(w.root, w.git)).toEqual({
      mounts: [
        pinned(w.at("settings"), "/work/settings"),
        readOnly(w.at(".git"), "/work/.git"),
        readOnly(w.at(".bare"), "/work/.bare"),
        readOnly(w.at("settings/extra.cfg"), "/work/settings/extra.cfg"),
        readOnly(w.at(".husky"), "/work/.husky"),
        readOnly(w.at("HEAD"), "/work/HEAD"),
        readOnly(w.at("refs"), "/work/refs"),
        HIDDEN,
      ],
      env: SAFE,
    });
    // Made by Tachikoma, empty, so it can be hidden (choice 31).
    expect(readdirSync(w.at(".tachikoma"))).toEqual([]);
  });

  it("mounts the folder around a hooks folder named _, husky 9's, as its hooks run the scripts there (choice 102)", () => {
    const w = world([".husky/_/h", ".husky/pre-commit", "_/pre-commit"]);
    w.git.hooksPaths.push(w.at(".husky/_"));
    expect(live(w.root, w.git)).toEqual({ mounts: [readOnly(w.at(".husky"), "/work/.husky"), HIDDEN], env: SAFE });
    // A `_` at the project's top: the folder around it is the project, which stays writable.
    w.git.hooksPaths.splice(0, 1, w.at("_"));
    expect(live(w.root, w.git)).toEqual({ mounts: [readOnly(w.at("_"), "/work/_"), HIDDEN], env: SAFE });
  });

  it("mounts a top-level config only when it is a file, leaving a config folder writable (choice 103)", () => {
    const folder = world(["config/app.yml"]);
    expect(live(folder.root, folder.git)).toEqual({ mounts: [HIDDEN], env: SAFE });
    const file = world(["config"]);
    expect(live(file.root, file.git)).toEqual({ mounts: [readOnly(file.at("config"), "/work/config"), HIDDEN], env: SAFE });
  });

  it("mounts a .git file read-only, as it is", () => {
    const w = world([".git"]);
    expect(live(w.root, w.git)).toEqual({ mounts: [readOnly(w.at(".git"), "/work/.git"), HIDDEN], env: SAFE });
  });

  it("mounts nothing over a path that does not exist, nor a hooks folder outside the project", () => {
    const w = world();
    w.git.hooksPaths.push(path.join(w.dir, "missing-hooks"));
    expect(live(w.root, w.git)).toEqual({ mounts: [HIDDEN], env: SAFE });
  });

  it("keeps an existing .tachikoma as it is, hidden", () => {
    const w = world([".tachikoma/sessions/one.jsonl"]);
    expect(live(w.root, w.git)).toEqual({ mounts: [HIDDEN], env: SAFE });
    expect(readdirSync(w.at(".tachikoma/sessions"))).toEqual(["one.jsonl"]);
  });

  it("mounts each place once, by its real path, when the project is reached through a link (choice 62)", () => {
    const w = world([".husky/"]);
    // A junction on Windows needs no special rights; elsewhere it is an ordinary symlink.
    const joined = path.join(w.dir, "joined");
    symlinkSync(w.root, joined, "junction");
    w.git.hooksPaths.push(path.join(joined, ".husky"), w.at(".husky"));
    expect(live(joined, w.git)).toEqual({ mounts: [readOnly(w.at(".husky"), "/work/.husky"), HIDDEN], env: SAFE });
  });

  it("refuses a missing hooks folder named by either spelling of the project's folder", () => {
    const w = world();
    const joined = path.join(w.dir, "joined");
    symlinkSync(w.root, joined, "junction");
    w.git.hooksPaths.push(w.at(".githooks"));
    expect(live(joined, w.git)).toHaveProperty("refused", expect.stringContaining(`git's hooks folder ${w.at(".githooks")} does not exist yet`));
  });

  it("leaves a file or folder inside a read-only folder to that folder's mount", () => {
    const w = world([".git/config", ".git/hooks/", "tools/hooks/", "tools/extra.cfg", ".github/git.cfg"]);
    w.git.files.push(w.at(".git/config"), w.at("tools/extra.cfg"));
    w.git.hooksPaths.push(w.at(".git/hooks"), w.at("tools/hooks"));
    w.git.gitDirs.push(w.at("tools"));
    // A name that only starts like a mounted folder's is not inside it.
    w.git.files.push(w.at(".github/git.cfg"));
    expect(live(w.root, w.git)).toEqual({
      mounts: [
        pinned(w.at(".github"), "/work/.github"),
        readOnly(w.at(".git"), "/work/.git"),
        readOnly(w.at("tools"), "/work/tools"),
        readOnly(w.at(".github/git.cfg"), "/work/.github/git.cfg"),
        HIDDEN,
      ],
      env: SAFE,
    });
  });

  // Choice 124 (PR #9 review): the box could write through another name of a read-only file.
  const linkRefused = (rel: string) =>
    `Live link is refused: ${rel} has another name in the project (a hard link), through which the box could ` +
    "change it. Launch with --sandbox copy instead.";

  it("refuses a .git/config with a hard link elsewhere in the project, naming it, making nothing (choice 124)", () => {
    const w = world([".git/config", ".git/HEAD"]);
    linkSync(w.at(".git/config"), w.at("notes.txt"));
    expect(live(w.root, w.git)).toEqual({ refused: linkRefused(".git/config") });
    expect(existsSync(w.at(".tachikoma"))).toBe(false);
  });

  it("refuses a file in a hooks folder with a hard link (choice 124)", () => {
    const w = world([".git/", "tools/hooks/pre-commit"]);
    w.git.hooksPaths.push(w.at("tools/hooks"));
    linkSync(w.at("tools/hooks/pre-commit"), w.at("run.sh"));
    expect(live(w.root, w.git)).toEqual({ refused: linkRefused("tools/hooks/pre-commit") });
  });

  it("takes hard-linked git objects, as a clone from a local path makes them (choice 124)", () => {
    const w = world([".git/objects/ab/cdef", ".git/lfs/objects/12/3456", ".git/index"]);
    linkSync(w.at(".git/objects/ab/cdef"), w.at("copy-1"));
    linkSync(w.at(".git/lfs/objects/12/3456"), w.at("copy-2"));
    expect(live(w.root, w.git)).toEqual({ mounts: [readOnly(w.at(".git"), "/work/.git"), HIDDEN], env: SAFE });
    // An index beside them is still checked.
    linkSync(w.at(".git/index"), w.at("copy-3"));
    expect(live(w.root, w.git)).toEqual({ refused: linkRefused(".git/index") });
  });

  it("refuses a file in .tachikoma with a hard link (choice 124)", () => {
    const w = world([".tachikoma/settings.json"]);
    linkSync(w.at(".tachikoma/settings.json"), w.at("settings.json"));
    expect(live(w.root, w.git)).toEqual({ refused: linkRefused(".tachikoma/settings.json") });
  });

  it("takes read-only places and .tachikoma with no hard links (choice 124)", () => {
    const w = world([".git/config", ".git/hooks/pre-commit", ".tachikoma/settings.json", "notes.txt"]);
    expect(live(w.root, w.git)).toEqual({ mounts: [readOnly(w.at(".git"), "/work/.git"), HIDDEN], env: SAFE });
  });

  it("gives the line-ending settings as git's session-only variables, after safe.directory (choice 100)", () => {
    const w = world();
    w.git.lineEndings = { "core.autocrlf": "true", "core.eol": "" };
    expect(live(w.root, w.git)).toEqual({
      mounts: [HIDDEN],
      env: {
        GIT_CONFIG_COUNT: "3",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: "/work",
        GIT_CONFIG_KEY_1: "core.autocrlf",
        GIT_CONFIG_VALUE_1: "true",
        GIT_CONFIG_KEY_2: "core.eol",
        GIT_CONFIG_VALUE_2: "",
      },
    });
  });
});

// A test-made folder, and whether it ignores letter case, told by two names in a folder of its own that differ only in
// case: whether they reach one file.
async function caseOf(): Promise<{ dir: string; ignores: boolean }> {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "tachi-case-")));
  onTestFinished(() => removeTree(dir));
  const probe = path.join(dir, "probe");
  mkdirSync(probe);
  writeFileSync(path.join(probe, "a"), "");
  const ignores = existsSync(path.join(probe, "A"));
  await removeTree(probe);
  return { dir, ignores };
}

describe("ignoresCase (choice 104)", () => {
  it("is true for a folder that ignores letter case, told by a name in it", async (ctx) => {
    const { dir, ignores } = await caseOf();
    if (!ignores) ctx.skip("this machine's temporary folder minds letter case, so it cannot show one that ignores it");
    mkdirSync(path.join(dir, ".git"));
    expect(ignoresCase(dir)).toBe(true);
  });

  it("is true for an empty folder that ignores letter case, told by its own name", async (ctx) => {
    const { dir, ignores } = await caseOf();
    if (!ignores) ctx.skip("this machine's temporary folder minds letter case, so it cannot show one that ignores it");
    expect(readdirSync(dir)).toEqual([]);
    expect(ignoresCase(dir)).toBe(true);
  });

  it("is false for a folder that minds letter case, even with a name in it spelled both ways", async (ctx) => {
    const { dir, ignores } = await caseOf();
    if (ignores) ctx.skip("this machine's temporary folder ignores letter case, so it cannot show one that minds it");
    mkdirSync(path.join(dir, ".git"));
    mkdirSync(path.join(dir, ".GIT"));
    expect(ignoresCase(dir)).toBe(false);
    expect(ignoresCase(path.join(dir, ".git"))).toBe(false);
  });
});
