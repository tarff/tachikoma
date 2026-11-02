import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, type TestContext } from "vitest";
import { onPath } from "../../src/exec/env.js";
import { gitSettings } from "../../src/safety/gitconfig.js";
import { dockerState } from "../../src/sandbox/docker.js";
import { boxLimits, boxUser, DockerExecutor, dockerRoom } from "../../src/sandbox/executor.js";
import { imageFor } from "../../src/sandbox/image.js";
import { liveMounts } from "../../src/sandbox/mounts.js";
import { removeTree } from "../helpers.js";

const TEST_LABEL = { "tachikoma.test": "1" }; // the plan's rule for every container a test starts

// The variables a test sets itself, so the user's own never reach git: as in tests/safety/gitconfig.test.ts.
const OWN = /^(path|home|homedrive|homepath|userprofile|xdg_config_home|git_.*)$/i;

// A test's own folder: a home, the system's and the user's settings files (the user's names a sample user, so the host
// can commit), and a project. Every git run here, the test's own (`git`) and gitSettings's, gets `env`, whose home
// folders and settings files are all the test's. At the end the boxes started on it are removed, then the folder.
function world() {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "tachi-livelink-")));
  const boxes: DockerExecutor[] = [];
  onTestFinished(async () => {
    for (const box of boxes) await box.stop();
    await removeTree(dir);
  });
  const home = path.join(dir, "home");
  const root = path.join(dir, "project");
  mkdirSync(home);
  mkdirSync(root);
  const at = (rel: string) => path.join(root, rel);
  const write = (p: string, text: string) => {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text);
    return p;
  };
  const system = write(path.join(dir, "system.cfg"), "");
  const global = write(path.join(dir, "global.cfg"), "[user]\n\tname = Sample User\n\temail = sample@example.invalid\n[init]\n\tdefaultBranch = main\n");
  const drive = path.parse(home).root.replace(/[\\/]$/, ""); // "C:" on Windows, "" elsewhere
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !OWN.test(name))),
    PATH: process.env.PATH,
    HOME: home,
    HOMEDRIVE: drive,
    HOMEPATH: home.slice(drive.length),
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    GIT_CONFIG_SYSTEM: system,
    GIT_CONFIG_GLOBAL: global,
  };
  const git = (args: string[], cwd = root) => execFileSync(onPath("git", env)!, args, { cwd, env, encoding: "utf8", windowsHide: true });
  return { dir, root, at, write, system, env, git, boxes };
}
type World = ReturnType<typeof world>;

// Git's settings for the project, or a skip when git is not on PATH.
async function settings(ctx: TestContext, w: World) {
  const got = await gitSettings(w.root, w.env);
  if (!got) ctx.skip("no git on PATH");
  return got;
}

// A box from the sandbox's own image on the project with live link's mounts (choice 73: never pulled, network off,
// labelled, removed), or a skip with the reason on any Docker the box cannot use.
async function liveBox(ctx: TestContext, w: World, opts: { env?: Record<string, string> } = {}): Promise<DockerExecutor> {
  const state = await dockerState();
  if (state === "missing") ctx.skip("no docker program on PATH");
  if (state === "stopped") ctx.skip("Docker is not running");
  if (state !== "ready") ctx.skip(state === "denied" ? "this user is not allowed to use Docker" : "Docker is set to Windows containers");
  const info = await imageFor(w.root);
  if (!info.built) ctx.skip(`the sandbox's image (${info.tag}) is not built`);
  const space = await dockerRoom();
  const got = boxLimits(undefined, space);
  if (!("limits" in got)) ctx.skip(got.problem);
  const live = liveMounts(w.root, await settings(ctx, w));
  if ("refused" in live) throw new Error(live.refused);
  const box = await DockerExecutor.start({
    image: info.tag, folder: w.root, network: "off", limits: got.limits, user: boxUser(space),
    mounts: live.mounts, env: opts.env ?? live.env, session: `test-${randomUUID()}`, labels: TEST_LABEL,
  });
  w.boxes.push(box);
  return box;
}

// Every path in a folder, its folders' contents too, relative and sorted.
const listing = (folder: string): string[] =>
  (readdirSync(folder, { recursive: true }) as string[]).map((p) => p.split(path.sep).join("/")).sort();

// What a write to a read-only mount gives in the box: bash's own message for the file.
const READ_ONLY = /Read-only file system/;

// No time limit, as in executor.test.ts (choice 81).
describe("live link in real Docker", { timeout: 0 }, () => {
  it("fails a commit in the box, while git log, git status and git diff work", async (ctx) => {
    const w = world();
    w.write(w.at("a.txt"), "one\n");
    w.git(["init", "-q"]);
    w.git(["add", "a.txt"]);
    w.git(["commit", "-q", "-m", "first"]);
    const box = await liveBox(ctx, w);
    expect(await box.exec("git log --format=%s", "/work")).toEqual({ code: 0, signal: null, stdout: "first\n", stderr: "" });
    expect(await box.exec("echo two >> a.txt && git status --porcelain", "/work")).toMatchObject({ code: 0, stdout: " M a.txt\n" });
    expect(await box.exec("git diff --stat", "/work")).toMatchObject({ code: 0, stdout: expect.stringContaining("a.txt | 1 +") });
    const commit = await box.exec("git -c user.name=Box -c user.email=box@example.invalid commit -q -am second", "/work");
    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toMatch(READ_ONLY);
    expect(w.git(["log", "--format=%s"])).toBe("first\n");
  });

  it("shows a CRLF checkout clean in the box when the system's settings set core.autocrlf=true (choice 100)", async (ctx) => {
    const w = world();
    w.write(w.system, "[core]\n\tautocrlf = true\n");
    w.write(w.at("a.txt"), "one\r\ntwo\r\n");
    w.git(["init", "-q"]);
    w.git(["add", "a.txt"]);
    w.git(["commit", "-q", "-m", "first"]);
    const box = await liveBox(ctx, w);
    expect(await box.exec("git status --porcelain", "/work")).toMatchObject({ code: 0, stdout: "" });
    // With only the first variable, safe.directory, the box's git sees the file changed: the setting lives only in the
    // host's system file.
    expect(await box.exec("GIT_CONFIG_COUNT=1 git status --porcelain", "/work")).toMatchObject({ code: 0, stdout: " M a.txt\n" });
  });

  it("makes an included file, an includeIf file, .husky and all of .git read-only, and Docker makes no folder in the project", async (ctx) => {
    const w = world();
    w.git(["init", "-q"]);
    const config = w.at(".git/config");
    const extra = w.write(w.at("settings/extra.cfg"), "[user]\n\tname = Sample User\n");
    const cond = w.write(w.at("settings/cond.cfg"), "");
    const hook = w.write(w.at(".husky/pre-commit"), "echo sample\n");
    const more = '[include]\n\tpath = ../settings/extra.cfg\n[includeIf "onbranch:sample-no-such-branch"]\n\tpath = ../settings/cond.cfg\n';
    w.write(config, `${readFileSync(config, "utf8")}${more}[core]\n\thooksPath = .husky\n`);
    const before = listing(w.root);
    const box = await liveBox(ctx, w);
    // Tachikoma made .tachikoma (choice 31); Docker made nothing.
    expect(listing(w.root)).toEqual([...before, ".tachikoma"].sort());
    for (const file of ["settings/extra.cfg", "settings/cond.cfg", ".husky/pre-commit", ".git/config"]) {
      const got = await box.exec(`echo changed >> ${file}`, "/work");
      expect(got.code, file).not.toBe(0);
      expect(got.stderr, file).toMatch(READ_ONLY);
    }
    for (const made of [".husky/post-checkout", ".git/hooks/pre-commit"]) expect((await box.exec(`touch ${made}`, "/work")).stderr, made).toMatch(READ_ONLY);
    // The folders around them are the project's own, written as usual.
    expect((await box.exec("echo free > settings/free.txt", "/work")).code).toBe(0);
    expect(readFileSync(extra, "utf8")).toBe("[user]\n\tname = Sample User\n");
    expect(readFileSync(cond, "utf8")).toBe("");
    expect(readFileSync(hook, "utf8")).toBe("echo sample\n");
    expect(readFileSync(path.join(w.root, "settings/free.txt"), "utf8")).toBe("free\n");
  });

  it("makes a top-level HEAD and config read-only, and makes no objects or refs", async (ctx) => {
    const w = world();
    w.write(w.at("HEAD"), "ref: refs/heads/main\n");
    w.write(w.at("config"), "");
    const before = listing(w.root);
    const box = await liveBox(ctx, w);
    expect(listing(w.root)).toEqual([...before, ".tachikoma"].sort());
    for (const file of ["HEAD", "config"]) expect((await box.exec(`echo changed >> ${file}`, "/work")).stderr, file).toMatch(READ_ONLY);
    expect(readFileSync(w.at("HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
  });

  it("makes a .git file read-only", async (ctx) => {
    const w = world();
    // The project is a worktree of a repository beside it, as `git worktree add` makes one.
    const main = path.join(w.dir, "main");
    mkdirSync(main);
    w.git(["init", "-q"], main);
    w.git(["commit", "-q", "--allow-empty", "-m", "first"], main);
    w.git(["worktree", "add", "-q", w.at("tree")], main);
    const dotGit = readFileSync(path.join(w.at("tree"), ".git"), "utf8");
    const tree = { ...w, root: w.at("tree") };
    const box = await liveBox(ctx, tree);
    expect((await box.exec("echo gitdir: /tmp >> .git", "/work")).stderr).toMatch(READ_ONLY);
    expect(readFileSync(path.join(w.at("tree"), ".git"), "utf8")).toBe(dotGit);
  });

  it("hides .tachikoma under an empty folder, leaving the host's untouched", async (ctx) => {
    const w = world();
    w.write(w.at(".tachikoma/keep.txt"), "kept\n");
    const box = await liveBox(ctx, w);
    expect(await box.exec("ls -A .tachikoma", "/work")).toMatchObject({ code: 0, stdout: "" });
    expect((await box.exec("echo x > .tachikoma/x", "/work")).code).toBe(0);
    expect(listing(w.at(".tachikoma"))).toEqual(["keep.txt"]);
    expect(readFileSync(w.at(".tachikoma/keep.txt"), "utf8")).toBe("kept\n");
  });

  it("makes a missing .tachikoma on the host, empty, hidden in the box, so a file written there in the box stays there", async (ctx) => {
    const w = world();
    const box = await liveBox(ctx, w);
    expect(listing(w.at(".tachikoma"))).toEqual([]);
    expect((await box.exec("echo x > .tachikoma/x && cat .tachikoma/x", "/work")).stdout).toBe("x\n");
    expect(listing(w.at(".tachikoma"))).toEqual([]);
  });

  it("refuses an include that is a link", async (ctx) => {
    const w = world();
    w.git(["init", "-q"]);
    mkdirSync(w.at("real"));
    // A junction on Windows needs no special rights; elsewhere it is an ordinary symlink.
    symlinkSync(w.at("real"), w.at("joined"), "junction");
    w.write(w.at(".git/config"), `${readFileSync(w.at(".git/config"), "utf8")}[include]\n\tpath = ../joined\n`);
    expect(liveMounts(w.root, await settings(ctx, w))).toEqual({
      refused: `Live link is refused: git's settings include ${w.at("joined")}, which is a link. Launch with --sandbox copy instead.`,
    });
  });

  it("refuses an included settings file that does not exist", async (ctx) => {
    const w = world();
    w.git(["init", "-q"]);
    w.write(w.at(".git/config"), `${readFileSync(w.at(".git/config"), "utf8")}[include]\n\tpath = ../missing.cfg\n`);
    expect(liveMounts(w.root, await settings(ctx, w))).toEqual({
      refused: `Live link is refused: git's settings include ${w.at("missing.cfg")}, which cannot be read: no such file. Launch with --sandbox copy instead.`,
    });
  });

  it("refuses a core.hooksPath naming a missing folder in the project, making nothing; once it is made, mounts it read-only", async (ctx) => {
    const w = world();
    w.git(["init", "-q"]);
    w.write(w.at(".git/config"), `${readFileSync(w.at(".git/config"), "utf8")}[core]\n\thooksPath = .githooks\n`);
    const before = listing(w.root);
    expect(liveMounts(w.root, await settings(ctx, w))).toEqual({
      refused:
        `Live link is refused: git's hooks folder ${w.at(".githooks")} does not exist yet, so the box could make it. ` +
        "Create the folder, or launch with --sandbox copy instead.",
    });
    expect(listing(w.root)).toEqual(before);
    mkdirSync(w.at(".githooks"));
    const box = await liveBox(ctx, w);
    expect((await box.exec("touch .githooks/pre-commit", "/work")).stderr).toMatch(READ_ONLY);
  });
});
