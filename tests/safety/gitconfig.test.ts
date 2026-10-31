import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { onPath } from "../../src/exec/env.js";
import { gitSettings } from "../../src/safety/gitconfig.js";

// Every git run is watched, to see where it ran and with what.
vi.mock("node:child_process", async (importOriginal) => {
  const cp = await importOriginal<typeof import("node:child_process")>();
  return { ...cp, execFile: vi.fn(cp.execFile) };
});

// The variables a test sets itself, so the user's own are never passed on: git then reads only the system and user
// files the test made (GIT_CONFIG_SYSTEM, GIT_CONFIG_GLOBAL), and `~/` and the XDG folder are inside the test's folder.
const OWN = /^(path|home|userprofile|xdg_config_home|git_.*)$/i;

// A test's own folder holding a home folder, a project folder, and empty system and user settings files.
function world() {
  const dir = mkdtempSync(path.join(tmpdir(), "tachi-gitconfig-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const at = (rel: string) => path.join(dir, rel);
  const home = at("home");
  const root = at("project");
  mkdirSync(home);
  mkdirSync(root);
  const write = (rel: string, text: string) => {
    mkdirSync(path.dirname(at(rel)), { recursive: true });
    writeFileSync(at(rel), text);
    return at(rel);
  };
  const system = write("system.cfg", "");
  const global = write("global.cfg", "");
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !OWN.test(name))),
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    GIT_CONFIG_SYSTEM: system,
    GIT_CONFIG_GLOBAL: global,
  };
  return { dir, at, home, root, system, global, env, write };
}

// A file symlink, or undefined where making one is not allowed: Windows allows file symlinks only with Developer Mode
// or as an administrator.
function fileLink(target: string, link: string): string | undefined {
  try {
    symlinkSync(target, link, "file");
    return link;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return undefined;
    throw err;
  }
}

describe("gitSettings", () => {
  it("names the system's and the user's files and the repository's config, leaving out a config.worktree that does not exist", async () => {
    const w = world();
    w.write("system.cfg", "[core]\n\tautocrlf = true\n");
    w.write("global.cfg", "[user]\n\tname = Sample User\n");
    w.write("project/.git/config", "[core]\n\tbare = false\n");
    const got = await gitSettings(w.root, w.env);
    expect(got).toEqual({
      files: [w.system, w.global, w.at("project/.git/config")],
      hooksPaths: [],
      gitDirs: [],
      problems: [],
    });
  });

  it("names an empty system or user file too, though git lists nothing from it, and not one git would not read", async () => {
    const w = world();
    // GIT_CONFIG_GLOBAL is set, so git reads neither of these.
    w.write("home/.gitconfig", "");
    w.write("home/.config/git/config", "");
    const got = await gitSettings(w.root, w.env);
    expect(got!.files).toEqual([w.system, w.global]);
  });

  it("finds no problem when the user's git traces its runs on stderr", async () => {
    const w = world();
    w.write("project/.git/config", "[include]\n\tpath = ../extra.cfg\n");
    const extra = w.write("project/extra.cfg", "");
    const got = await gitSettings(w.root, { ...w.env, GIT_TRACE: "1", GIT_TRACE2: "1", GIT_TRACE_SETUP: "1", git_trace_performance: "1" });
    expect(got).toEqual({ files: [w.system, w.global, w.at("project/.git/config"), extra], hooksPaths: [], gitDirs: [], problems: [] });
  });

  it("reads the system's file even when GIT_CONFIG_NOSYSTEM is set", async () => {
    const w = world();
    w.write("system.cfg", "[core]\n\tautocrlf = true\n");
    const got = await gitSettings(w.root, { ...w.env, GIT_CONFIG_NOSYSTEM: "1" });
    expect(got!.files).toContain(w.system);
  });

  it("follows a repository's include of a project file, relative to the file it is in", async () => {
    const w = world();
    w.write("project/.git/config", "[include]\n\tpath = ../settings/extra.cfg\n");
    const extra = w.write("project/settings/extra.cfg", "[user]\n\tname = Sample User\n");
    const got = await gitSettings(w.root, w.env);
    expect(got!.files).toContain(extra);
    expect(got!.problems).toEqual([]);
  });

  it("follows an includeIf whose condition is not met", async () => {
    const w = world();
    w.write("project/.git/config", '[includeIf "onbranch:x"]\n\tpath = ../branch.cfg\n[includeIf "gitdir:/nowhere/"]\n\tpath = ../dir.cfg\n');
    const branch = w.write("project/branch.cfg", "");
    const dir = w.write("project/dir.cfg", "");
    const got = await gitSettings(w.root, w.env);
    expect(got!.files).toEqual(expect.arrayContaining([branch, dir]));
  });

  it("follows a chain of two includes, each relative to its own file, and reads a file met twice once", async () => {
    const w = world();
    w.write("project/.git/config", "[include]\n\tpath = ../one/first.cfg\n");
    const first = w.write("project/one/first.cfg", "[include]\n\tpath = ../two/second.cfg\n");
    // second.cfg includes first.cfg back, which would loop if a file met twice were read again.
    const second = w.write("project/two/second.cfg", "[include]\n\tpath = ../one/first.cfg\n[core]\n\thooksPath = hooks\n");
    const got = await gitSettings(w.root, w.env);
    expect(got!.files.filter((f) => f === first)).toHaveLength(1);
    expect(got!.files.filter((f) => f === second)).toHaveLength(1);
    expect(got!.hooksPaths).toEqual([path.join(w.root, "hooks")]);
  });

  it("follows the user's file's includes, ~/ meaning the home folder", async () => {
    const w = world();
    w.write("global.cfg", "[include]\n\tpath = ~/more.cfg\n");
    const more = w.write("home/more.cfg", "[core]\n\thooksPath = ~/hooks\n");
    const got = await gitSettings(w.root, w.env);
    expect(got!.files).toContain(more);
    expect(got!.hooksPaths).toEqual([path.join(w.home, "hooks")]);
  });

  it("finds a file include that is a link a problem, and does not read it", async (ctx) => {
    const w = world();
    const target = w.write("project/target.cfg", "[core]\n\thooksPath = through-link\n");
    const link = fileLink(target, w.at("project/linked.cfg"));
    if (!link) return ctx.skip("this machine does not allow file symlinks (Windows needs Developer Mode or an administrator)");
    w.write("project/.git/config", "[include]\n\tpath = ../linked.cfg\n");
    const got = await gitSettings(w.root, w.env);
    expect(got!.problems).toEqual([{ file: link, why: "it is a link" }]);
    expect(got!.files).toContain(link);
    expect(got!.hooksPaths).toEqual([]);
  });

  it("finds an include that is a junction to a folder a problem, and still checks a direct include of its target", async () => {
    const w = world();
    mkdirSync(w.at("project/real"));
    // A junction on Windows needs no special rights; elsewhere it is an ordinary symlink.
    symlinkSync(w.at("project/real"), w.at("project/joined"), "junction");
    w.write("project/.git/config", "[include]\n\tpath = ../joined\n\tpath = ../real\n");
    const got = await gitSettings(w.root, w.env);
    expect(got!.problems).toEqual([
      { file: w.at("project/joined"), why: "it is a link" },
      { file: w.at("project/real"), why: "it cannot be read: it is a folder" },
    ]);
  });

  it("reads a file reached by two paths once, matching by its real path, and on Windows without case", async () => {
    const w = world();
    mkdirSync(w.at("project/real"));
    const real = w.write("project/real/extra.cfg", "");
    symlinkSync(w.at("project/real"), w.at("project/joined"), "junction");
    const paths = ["../joined/extra.cfg", "../real/extra.cfg", ...(process.platform === "win32" ? ["../REAL/EXTRA.cfg"] : [])];
    w.write("project/.git/config", `[include]\n${paths.map((p) => `\tpath = ${p}\n`).join("")}`);
    vi.mocked(execFile).mockClear();
    const got = await gitSettings(w.root, w.env);
    const runs = vi.mocked(execFile).mock.calls.map(([, args]) => args as string[]);
    const reads = runs.filter((args) => args.includes("--file") && /extra\.cfg$/i.test(args[args.indexOf("--file") + 1]!));
    expect(reads).toHaveLength(1);
    expect(got!.files).toEqual([w.system, w.global, w.at("project/.git/config"), w.at("project/joined/extra.cfg"), real]);
  });

  it("lets git expand %(prefix)/ in an include, as git gives it", async () => {
    const w = world();
    const config = w.write("project/.git/config", "[include]\n\tpath = %(prefix)/sample-prefix.cfg\n");
    const args = ["config", "--file", config, "--type=path", "--get", "include.path"];
    const given = execFileSync(onPath("git", w.env)!, args, { cwd: tmpdir(), env: w.env, encoding: "utf8" });
    const expanded = path.resolve(given.trim());
    expect(given.trim()).not.toContain("%(prefix)");
    const got = await gitSettings(w.root, w.env);
    expect(got!.files).toContain(expanded);
    // Nothing of that name is in git's folder, so it is a missing include.
    expect(got!.problems).toEqual([{ file: expanded, why: "it cannot be read: no such file" }]);
  });

  it("finds a file whose ~user/ include git cannot expand a problem", async () => {
    const w = world();
    // A made-up name: Linux and macOS have a real `nobody`.
    const config = w.write("project/.git/config", "[include]\n\tpath = ~tachi-sample-no-such-user/sample.cfg\n");
    const got = await gitSettings(w.root, w.env);
    expect(got!.problems).toEqual([{ file: config, why: "it cannot be read: failed to expand user dir in: '~tachi-sample-no-such-user/sample.cfg'" }]);
  });

  it("gives an include's and a hooks folder's real path as well as the written one, when a folder on the way is a link", async () => {
    const w = world();
    mkdirSync(w.at("project/real"));
    mkdirSync(w.at("project/real-hooks"));
    const real = w.write("project/real/extra.cfg", "[core]\n\thooksPath = joined-hooks\n");
    // Junctions on Windows need no special rights; elsewhere they are ordinary symlinks.
    symlinkSync(w.at("project/real"), w.at("project/joined"), "junction");
    symlinkSync(w.at("project/real-hooks"), w.at("project/joined-hooks"), "junction");
    w.write("project/.git/config", "[include]\n\tpath = ../joined/extra.cfg\n");
    const got = await gitSettings(w.root, w.env);
    expect(got!.problems).toEqual([]);
    expect(got!.files).toEqual(expect.arrayContaining([w.at("project/joined/extra.cfg"), real]));
    expect(got!.hooksPaths).toEqual([w.at("project/joined-hooks"), w.at("project/real-hooks")]);
  });

  it("finds a missing include, an include that is a folder and one git cannot read problems, and still names them", async () => {
    const w = world();
    mkdirSync(w.at("project/folder.cfg"));
    const bad = w.write("project/bad.cfg", "[core\n");
    w.write("project/.git/config", "[include]\n\tpath = ../missing.cfg\n\tpath = ../folder.cfg\n\tpath = ../bad.cfg\n");
    const got = await gitSettings(w.root, w.env);
    expect(got!.problems).toEqual([
      { file: w.at("project/missing.cfg"), why: "it cannot be read: no such file" },
      { file: w.at("project/folder.cfg"), why: "it cannot be read: it is a folder" },
      { file: bad, why: `it cannot be read: bad config line 1 in file ${bad}` },
    ]);
    expect(got!.files).toEqual(expect.arrayContaining([w.at("project/missing.cfg"), w.at("project/folder.cfg"), bad]));
  });

  it("makes core.hooksPath absolute: relative to the repository's top folder, ~/ the home folder, absolute as it is", async () => {
    const w = world();
    const elsewhere = path.join(w.dir, "elsewhere-hooks");
    w.write("project/.git/config", `[core]\n\thooksPath = .husky\n[core]\n\thooksPath = ${elsewhere.replaceAll("\\", "/")}\n`);
    w.write("global.cfg", "[core]\n\thooksPath = ~/hooks\n");
    const got = await gitSettings(w.root, w.env);
    expect(got!.hooksPaths).toEqual([path.join(w.home, "hooks"), path.join(w.root, ".husky"), elsewhere]);
  });

  it("finds the repository from a folder inside it, and hooks relative to its top", async () => {
    const w = world();
    w.write("project/.git/config", "[core]\n\thooksPath = .husky\n");
    mkdirSync(w.at("project/inner"));
    const got = await gitSettings(w.at("project/inner"), w.env);
    expect(got!.files).toContain(w.at("project/.git/config"));
    expect(got!.hooksPaths).toEqual([path.join(w.root, ".husky")]);
  });

  it("follows a .git file and its commondir, as a worktree has, with hooks relative to the worktree's own top", async () => {
    const w = world();
    // The main repository is beside the project; the project is a worktree of it.
    w.write("main/.git/config", "[include]\n\tpath = ../shared.cfg\n");
    const shared = w.write("main/shared.cfg", "");
    w.write("main/.git/worktrees/project/commondir", "../..\n");
    w.write("main/.git/worktrees/project/config.worktree", "[core]\n\thooksPath = .husky\n");
    w.write("project/.git", "gitdir: ../main/.git/worktrees/project\n");
    const got = await gitSettings(w.root, w.env);
    expect(got!.files).toEqual([w.system, w.global, w.at("main/.git/config"), w.at("main/.git/worktrees/project/config.worktree"), shared]);
    expect(got!.hooksPaths).toEqual([path.join(w.root, ".husky")]);
    // Both git folders are outside the project, out of the box's reach.
    expect(got!.gitDirs).toEqual([]);
  });

  it("lists a git folder a .git file names inside the project, as written and as its real path (choice 59)", async () => {
    const w = world();
    w.write("project/.bare/config", "[core]\n\tbare = true\n");
    w.write("project/.git", "gitdir: ./.bare\n");
    // The project's folder reached through a junction: the written form differs from the real one.
    symlinkSync(w.root, w.at("joined"), "junction");
    const got = await gitSettings(w.at("joined"), w.env);
    expect(got!.files).toEqual([w.system, w.global, w.at("joined/.bare/config"), w.at("project/.bare/config")]);
    expect(got!.gitDirs).toEqual([w.at("joined/.bare"), w.at("project/.bare")]);
  });

  it("counts a folder whose name starts with two dots as inside the project", async () => {
    const w = world();
    w.write("project/..bare/config", "");
    w.write("project/.git", "gitdir: ./..bare\n");
    const got = await gitSettings(w.root, w.env);
    expect(got!.gitDirs).toEqual([w.at("project/..bare")]);
  });

  it("lists a worktree's shared git folder when its commondir leads inside the project, and leaves it out when outside", async () => {
    const w = world();
    w.write("project/gitdata/wt/commondir", "../main\n");
    w.write("project/gitdata/main/config", "");
    w.write("project/.git", "gitdir: ./gitdata/wt\n");
    const inside = await gitSettings(w.root, w.env);
    expect(inside!.gitDirs).toEqual([w.at("project/gitdata/wt"), w.at("project/gitdata/main")]);
    w.write("project/gitdata/wt/commondir", "../../../main/.git\n");
    w.write("main/.git/config", "");
    const outside = await gitSettings(w.root, w.env);
    expect(outside!.gitDirs).toEqual([w.at("project/gitdata/wt")]);
    expect(outside!.files).toEqual([w.system, w.global, w.at("main/.git/config")]);
  });

  it("finds a commondir that cannot be read a problem", async () => {
    const w = world();
    mkdirSync(w.at("main/.git/worktrees/project/commondir"), { recursive: true });
    w.write("project/.git", "gitdir: ../main/.git/worktrees/project\n");
    const got = await gitSettings(w.root, w.env);
    expect(got!.problems).toEqual([
      { file: w.at("main/.git/worktrees/project/commondir"), why: expect.stringMatching(/^it cannot be read: EISDIR: illegal operation on a directory/) },
    ]);
    expect(got!.files).toEqual([w.system, w.global]);
  });

  it.each([
    ["one with no gitdir line", "not a gitdir line\n", "invalid gitfile format"],
    ["one naming no folder", "gitdir: \n", "no path in gitfile"],
  ])("finds a .git file that is %s a problem, in git's words", async (_, text, words) => {
    const w = world();
    const dotGit = w.write("project/.git", text);
    const got = await gitSettings(w.root, w.env);
    const problems = [{ file: dotGit, why: `it cannot be read: ${words}: ${dotGit}` }];
    expect(got).toEqual({ files: [w.system, w.global], hooksPaths: [], gitDirs: [], problems });
  });

  it("follows a .git file with no commondir, as a submodule has", async () => {
    const w = world();
    w.write("project/.git", `gitdir: ${w.at("modules/sub").replaceAll("\\", "/")}\n`);
    w.write("modules/sub/config", "[core]\n\thooksPath = hooks\n");
    const got = await gitSettings(w.root, w.env);
    expect(got!.files).toContain(w.at("modules/sub/config"));
    expect(got!.hooksPaths).toEqual([path.join(w.root, "hooks")]);
  });

  it("gives undefined when git is not installed, starting nothing", async () => {
    const w = world();
    const empty = w.at("no-git");
    mkdirSync(empty);
    vi.mocked(execFile).mockClear();
    expect(await gitSettings(w.root, { ...w.env, PATH: empty })).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("never runs git inside the project folder, nor lets it look for a repository above the temporary folder", async () => {
    const w = world();
    w.write("project/.git/config", "[include]\n\tpath = ../extra.cfg\n");
    w.write("project/extra.cfg", "[core]\n\thooksPath = .husky\n");
    vi.mocked(execFile).mockClear();
    await gitSettings(w.root, { ...w.env, ANTHROPIC_API_KEY: "sample-key", GIT_DIR: w.at("project/.git"), Git_Trace: "1" });
    const runs = vi.mocked(execFile).mock.calls as unknown as [string, string[], { cwd: string; env: NodeJS.ProcessEnv }][];
    // The two scopes, then one run for each file: the system's, the user's, the repository's and the include.
    expect(runs).toHaveLength(6);
    for (const [file, , options] of runs) {
      // Git's search for a repository stops before it would climb out of the temporary folder.
      expect(options.env.GIT_CEILING_DIRECTORIES).toBe(path.dirname(tmpdir()));
      // No other git variable reaches it but the two naming the settings files.
      const gitVariables = Object.keys(options.env).filter((name) => /^git_/i.test(name));
      expect(gitVariables.sort()).toEqual(["GIT_CEILING_DIRECTORIES", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"]);
      // By its full path: a bare name would be looked for in the working folder first on Windows.
      expect(file).toBe(onPath("git", w.env));
      expect(path.isAbsolute(file)).toBe(true);
      expect(options.cwd).toBe(tmpdir());
      expect(path.relative(w.root, options.cwd).startsWith("..")).toBe(true);
      expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
    }
  });
});
