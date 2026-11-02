import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { GitSettings } from "../../src/safety/gitconfig.js";
import { liveMounts } from "../../src/sandbox/mounts.js";
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

const readOnly = (host: string, box: string) => ({ host, box, readOnly: true });
const HIDDEN = { box: "/work/.tachikoma", hidden: true };
// Git in the box takes /work as safe, whoever owns it there.
const SAFE = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "/work" };

describe("liveMounts", () => {
  it("refuses without git, in choice 11's line", () => {
    const w = world();
    expect(liveMounts(w.root, undefined)).toEqual({ refused: "Live link needs git on this PC to read git's settings; use --sandbox copy, or install git." });
    expect(existsSync(w.at(".tachikoma"))).toBe(false);
  });

  it("refuses on a problem in git's settings, naming the file and why", () => {
    const w = world();
    const file = w.at("linked.cfg");
    w.git.problems.push({ file, why: "it is a link" }, { file: w.at("other.cfg"), why: "it cannot be read: no such file" });
    expect(liveMounts(w.root, w.git)).toEqual({
      refused: `Live link is refused: git's settings include ${file}, which is a link. Launch with --sandbox copy instead.`,
    });
    w.git.problems.shift();
    expect(liveMounts(w.root, w.git)).toEqual({
      refused: `Live link is refused: git's settings include ${w.at("other.cfg")}, which cannot be read: no such file. Launch with --sandbox copy instead.`,
    });
    expect(existsSync(w.at(".tachikoma"))).toBe(false);
  });

  it("refuses a hooks folder in the project that does not exist yet, making nothing", () => {
    const w = world([".git/"]);
    w.git.hooksPaths.push(w.at(".githooks"));
    expect(liveMounts(w.root, w.git)).toEqual({
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
    expect(liveMounts(w.root, w.git)).toEqual({
      mounts: [
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
    expect(liveMounts(w.root, w.git)).toEqual({ mounts: [readOnly(w.at(".husky"), "/work/.husky"), HIDDEN], env: SAFE });
    // A `_` at the project's top: the folder around it is the project, which stays writable.
    w.git.hooksPaths.splice(0, 1, w.at("_"));
    expect(liveMounts(w.root, w.git)).toEqual({ mounts: [readOnly(w.at("_"), "/work/_"), HIDDEN], env: SAFE });
  });

  it("mounts a top-level config only when it is a file, leaving a config folder writable (choice 103)", () => {
    const folder = world(["config/app.yml"]);
    expect(liveMounts(folder.root, folder.git)).toEqual({ mounts: [HIDDEN], env: SAFE });
    const file = world(["config"]);
    expect(liveMounts(file.root, file.git)).toEqual({ mounts: [readOnly(file.at("config"), "/work/config"), HIDDEN], env: SAFE });
  });

  it("mounts a .git file read-only, as it is", () => {
    const w = world([".git"]);
    expect(liveMounts(w.root, w.git)).toEqual({ mounts: [readOnly(w.at(".git"), "/work/.git"), HIDDEN], env: SAFE });
  });

  it("mounts nothing over a path that does not exist, nor a hooks folder outside the project", () => {
    const w = world();
    w.git.hooksPaths.push(path.join(w.dir, "missing-hooks"));
    expect(liveMounts(w.root, w.git)).toEqual({ mounts: [HIDDEN], env: SAFE });
  });

  it("keeps an existing .tachikoma as it is, hidden", () => {
    const w = world([".tachikoma/sessions/one.jsonl"]);
    expect(liveMounts(w.root, w.git)).toEqual({ mounts: [HIDDEN], env: SAFE });
    expect(readdirSync(w.at(".tachikoma/sessions"))).toEqual(["one.jsonl"]);
  });

  it("mounts each place once, by its real path, when the project is reached through a link (choice 62)", () => {
    const w = world([".husky/"]);
    // A junction on Windows needs no special rights; elsewhere it is an ordinary symlink.
    const joined = path.join(w.dir, "joined");
    symlinkSync(w.root, joined, "junction");
    w.git.hooksPaths.push(path.join(joined, ".husky"), w.at(".husky"));
    expect(liveMounts(joined, w.git)).toEqual({ mounts: [readOnly(w.at(".husky"), "/work/.husky"), HIDDEN], env: SAFE });
  });

  it("refuses a missing hooks folder named by either spelling of the project's folder", () => {
    const w = world();
    const joined = path.join(w.dir, "joined");
    symlinkSync(w.root, joined, "junction");
    w.git.hooksPaths.push(w.at(".githooks"));
    expect(liveMounts(joined, w.git)).toHaveProperty("refused", expect.stringContaining(`git's hooks folder ${w.at(".githooks")} does not exist yet`));
  });

  it("leaves a file or folder inside a read-only folder to that folder's mount", () => {
    const w = world([".git/config", ".git/hooks/", "tools/hooks/", "tools/extra.cfg", ".github/git.cfg"]);
    w.git.files.push(w.at(".git/config"), w.at("tools/extra.cfg"));
    w.git.hooksPaths.push(w.at(".git/hooks"), w.at("tools/hooks"));
    w.git.gitDirs.push(w.at("tools"));
    // A name that only starts like a mounted folder's is not inside it.
    w.git.files.push(w.at(".github/git.cfg"));
    expect(liveMounts(w.root, w.git)).toEqual({
      mounts: [
        readOnly(w.at(".git"), "/work/.git"),
        readOnly(w.at("tools"), "/work/tools"),
        readOnly(w.at(".github/git.cfg"), "/work/.github/git.cfg"),
        HIDDEN,
      ],
      env: SAFE,
    });
  });

  it("gives the line-ending settings as git's session-only variables, after safe.directory (choice 100)", () => {
    const w = world();
    w.git.lineEndings = { "core.autocrlf": "true", "core.eol": "" };
    expect(liveMounts(w.root, w.git)).toEqual({
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
