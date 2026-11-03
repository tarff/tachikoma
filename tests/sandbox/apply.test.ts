import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, type TestContext } from "vitest";
import { onPath } from "../../src/exec/env.js";
import { appliedSoFar, applyChange } from "../../src/sandbox/apply.js";
import { type Change, changes } from "../../src/sandbox/changes.js";
import type { Manifest } from "../../src/sandbox/snapshot.js";
import { removeTree, shortName, ZERO } from "../helpers.js";

const windows = process.platform === "win32";
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

const CHANGED_SINCE = "changed in your folder since the copy was made";
const NEVER_APPLIED = "Tachikoma's own and git's folders are never applied";
const BY_HAND = "links are applied by hand";

// The variables a test sets itself, so the user's own never reach git: as in tests/safety/gitconfig.test.ts.
const OWN = /^(path|home|homedrive|homepath|userprofile|xdg_config_home|git_.*)$/i;

// A test's own folder, holding a project with `tree` in it, a copy of it as the snapshot leaves one (base/, work/ and
// manifest.json in a data folder), a folder outside the project for links to reach, and a home with empty git settings
// files for every git run. The copy is made here by hand, not by snapshot(), which would make the data folder private
// (icacls on Windows); its manifest is the one snapshot() writes for the same tree. The test then changes work/ as the
// box would, and the project as the user would.
function world(tree: Record<string, string | Buffer>) {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "tachi-apply-")));
  onTestFinished(() => removeTree(dir));
  const root = path.join(dir, "project");
  const data = path.join(dir, "data");
  const copies = path.join(data, "copies", "s1");
  const base = path.join(copies, "base");
  const work = path.join(copies, "work");
  const outside = path.join(dir, "elsewhere");
  const home = path.join(dir, "home");
  for (const folder of [root, base, work, outside, home]) mkdirSync(folder, { recursive: true });
  const manifest: Manifest = { session: "s1", root, at: new Date().toISOString(), entries: Object.create(null), leftOut: [] };
  const write = (file: string, text: string | Buffer) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  for (const [rel, text] of Object.entries(tree)) {
    for (const copy of [root, base, work]) write(path.join(copy, rel), text);
    const st = lstatSync(path.join(work, rel));
    manifest.entries[rel] = { type: "file", sha256: sha(text), exec: false, size: st.size, mtimeMs: st.mtimeMs };
    for (let i = rel.indexOf("/"); i !== -1; i = rel.indexOf("/", i + 1)) manifest.entries[rel.slice(0, i)] = { type: "folder" };
  }
  writeFileSync(path.join(copies, "manifest.json"), JSON.stringify(manifest));
  const system = path.join(dir, "system.cfg");
  const global = path.join(dir, "global.cfg");
  writeFileSync(system, "");
  writeFileSync(global, "");
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
  const at = (rel: string) => path.join(root, rel);
  const ctx = { root, base, work, manifest, session: "s1" };
  return {
    dir,
    root,
    data,
    copies,
    outside,
    env,
    at,
    ctx,
    read: (rel: string) => readFileSync(at(rel), "utf8"),
    // As the box would change its copy, and the user the project.
    box: (rel: string, text: string | Buffer) => write(path.join(work, rel), text),
    user: (rel: string, text: string | Buffer) => write(at(rel), text),
    // The change at `rel`, as Task 18 lists it.
    change: async (rel: string): Promise<Change> => {
      const found = (await changes(manifest, work)).changes.find((c) => c.path === rel);
      if (!found) throw new Error(`no change at ${rel}`);
      return found;
    },
    log: (): Record<string, string>[] => {
      const file = path.join(copies, "applied.jsonl");
      return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    },
    backup: (rel: string) => path.join(root, ".tachikoma", "backups", "s1", rel),
  };
}
type World = ReturnType<typeof world>;

// A merge needs git on PATH; a test is skipped, with the reason, where there is none.
function needGit(t: TestContext, w: World) {
  if (!onPath("git", w.env)) t.skip("no git on PATH");
}

// Everything in a folder, at any depth, without following links, so a test can tell nothing was written there.
function listing(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true, recursive: true }).map((d) => path.relative(folder, path.join(d.parentPath, d.name)));
}

describe("applyChange", () => {
  it("applies a changed file: the old one backed up, the change logged pending then done", async () => {
    const w = world({ "src/edit.txt": "old\n" });
    w.box("src/edit.txt", "new\n");
    expect(await applyChange(await w.change("src/edit.txt"), w.ctx)).toEqual({ path: "src/edit.txt", result: "applied" });
    expect(w.read("src/edit.txt")).toBe("new\n");
    expect(readFileSync(w.backup("src/edit.txt"), "utf8")).toBe("old\n");
    expect(w.log()).toEqual([
      { path: "src/edit.txt", state: "pending", before: sha("old\n"), after: sha("new\n") },
      { path: "src/edit.txt", state: "done" },
    ]);
    // No temporary file is left beside it.
    expect(readdirSync(w.at("src"))).toEqual(["edit.txt"]);
  });

  it("applies an added file, making its folders, with nothing to back up and `before` empty", async () => {
    const w = world({ "a.txt": "a\n" });
    w.box("new/deep/added.txt", "hello\n");
    expect(await applyChange(await w.change("new/deep/added.txt"), w.ctx)).toEqual({ path: "new/deep/added.txt", result: "applied" });
    expect(w.read("new/deep/added.txt")).toBe("hello\n");
    expect(existsSync(w.at(".tachikoma"))).toBe(false);
    expect(w.log()).toEqual([
      { path: "new/deep/added.txt", state: "pending", before: "", after: sha("hello\n") },
      { path: "new/deep/added.txt", state: "done" },
    ]);
  });

  it("applies a delete when the file still matches, backed up first, with `after` empty", async () => {
    const w = world({ "gone.txt": "bye\n", "keep.txt": "k\n" });
    unlinkSync(path.join(w.ctx.work, "gone.txt"));
    expect(await applyChange(await w.change("gone.txt"), w.ctx)).toEqual({ path: "gone.txt", result: "applied" });
    expect(existsSync(w.at("gone.txt"))).toBe(false);
    expect(readFileSync(w.backup("gone.txt"), "utf8")).toBe("bye\n");
    expect(w.log()).toEqual([
      { path: "gone.txt", state: "pending", before: sha("bye\n"), after: "" },
      { path: "gone.txt", state: "done" },
    ]);
  });

  it("gives a conflict, writing nothing, when the real file was edited since the copy", async () => {
    const w = world({ "edit.txt": "old\n" });
    w.box("edit.txt", "new\n");
    w.user("edit.txt", "the user's\n");
    expect(await applyChange(await w.change("edit.txt"), w.ctx)).toEqual({ path: "edit.txt", result: "conflict", why: CHANGED_SINCE });
    expect(w.read("edit.txt")).toBe("the user's\n");
    expect(existsSync(w.at(".tachikoma"))).toBe(false);
    expect(w.log()).toEqual([]);
  });

  it("gives a conflict when an added file's path was made in the real folder since", async () => {
    const w = world({ "a.txt": "a\n" });
    w.box("new.txt", "the box's\n");
    w.user("new.txt", "the user's\n");
    expect(await applyChange(await w.change("new.txt"), w.ctx)).toMatchObject({ result: "conflict", why: CHANGED_SINCE });
    expect(w.read("new.txt")).toBe("the user's\n");
  });

  it("gives a conflict, deleting nothing, when a file to delete was edited or deleted since", async () => {
    const w = world({ "edited.txt": "e\n", "deleted.txt": "d\n" });
    unlinkSync(path.join(w.ctx.work, "edited.txt"));
    unlinkSync(path.join(w.ctx.work, "deleted.txt"));
    w.user("edited.txt", "the user's\n");
    unlinkSync(w.at("deleted.txt"));
    expect(await applyChange(await w.change("edited.txt"), w.ctx)).toMatchObject({ result: "conflict", why: CHANGED_SINCE });
    expect(await applyChange(await w.change("deleted.txt"), w.ctx)).toMatchObject({ result: "conflict", why: CHANGED_SINCE });
    expect(w.read("edited.txt")).toBe("the user's\n");
  });

  it("gives a conflict when the real file is no longer a plain file, or its executable flag differs from the snapshot's", async () => {
    const w = world({ "was-file": "f\n", "flag.sh": "echo made-up\n" });
    w.box("was-file", "new\n");
    w.box("flag.sh", "echo changed\n");
    unlinkSync(w.at("was-file"));
    mkdirSync(w.at("was-file"));
    // As if the user had changed the flag: the snapshot says it was set, and the real file has none.
    const entry = w.ctx.manifest.entries["flag.sh"];
    if (entry?.type === "file") entry.exec = true;
    const flag = await w.change("flag.sh");
    expect(await applyChange(await w.change("was-file"), w.ctx)).toMatchObject({ result: "conflict", why: CHANGED_SINCE });
    expect(await applyChange(flag, w.ctx)).toMatchObject({ result: "conflict", why: CHANGED_SINCE });
    expect(w.read("flag.sh")).toBe("echo made-up\n");
  });

  it.skipIf(windows)("gives an applied file the box's executable flag (not on Windows, which has none)", async () => {
    const w = world({ "run.sh": "echo old\n", "plain.sh": "echo plain\n" });
    // Made anew with the flag set, as the box would; no file's permissions are changed.
    unlinkSync(path.join(w.ctx.work, "run.sh"));
    writeFileSync(path.join(w.ctx.work, "run.sh"), "echo new\n", { mode: 0o755 });
    writeFileSync(path.join(w.ctx.work, "added.sh"), "echo added\n", { mode: 0o755 });
    w.box("plain.sh", "echo still plain\n");
    for (const rel of ["run.sh", "added.sh", "plain.sh"]) expect(await applyChange(await w.change(rel), w.ctx)).toMatchObject({ result: "applied" });
    expect(lstatSync(w.at("run.sh")).mode & 0o100).toBe(0o100);
    expect(lstatSync(w.at("added.sh")).mode & 0o100).toBe(0o100);
    expect(lstatSync(w.at("plain.sh")).mode & 0o100).toBe(0);
  });

  it("gives a conflict when the real file changes after the first check, leaving no temporary file", async () => {
    const w = world({ "edit.txt": "old\n" });
    w.box("edit.txt", "new\n");
    const out = await applyChange(await w.change("edit.txt"), w.ctx, false, {
      step: (at) => {
        if (at === "written") w.user("edit.txt", "typed meanwhile\n");
      },
    });
    expect(out).toEqual({ path: "edit.txt", result: "conflict", why: CHANGED_SINCE });
    expect(w.read("edit.txt")).toBe("typed meanwhile\n");
    expect(readdirSync(w.root).sort()).toEqual([".tachikoma", "edit.txt"]);
  });

  it("gives a conflict, keeping no backup, when the real file changes as it is backed up", async () => {
    const w = world({ "edit.txt": "old\n" });
    w.box("edit.txt", "new\n");
    const out = await applyChange(await w.change("edit.txt"), w.ctx, false, {
      step: (at) => {
        if (at === "checked") w.user("edit.txt", "typed meanwhile\n");
      },
    });
    expect(out).toEqual({ path: "edit.txt", result: "conflict", why: CHANGED_SINCE });
    expect(w.read("edit.txt")).toBe("typed meanwhile\n");
    expect(existsSync(w.backup("edit.txt"))).toBe(false);
    expect(w.log()).toEqual([]);
  });

  it("refuses a path that reaches .git by its short name (Windows)", async (t) => {
    const w = world({ "a.txt": "a\n" });
    mkdirSync(w.at(".git"));
    const short = shortName(w.root, ".git");
    if (!short) t.skip("no short (8.3) names here: only Windows makes them, and not on every volume");
    const c: Change = { kind: "added", path: `${short}/config`, binary: false, execAfter: false, ignored: false };
    w.box(c.path, "made-up\n");
    expect(await applyChange(c, w.ctx)).toEqual({ path: c.path, result: "refused", why: NEVER_APPLIED });
    expect(listing(w.at(".git"))).toEqual([]);
  });

  it("refuses a .tachikoma path and a nested .git path, whatever their spelling reaches", async () => {
    const w = world({ "a.txt": "a\n" });
    const handed: Change[] = [
      { kind: "added", path: ".tachikoma/settings.json", binary: false, execAfter: false, ignored: false },
      { kind: "changed", path: "vendor/lib/.git/config", binary: false, execBefore: false, execAfter: false, ignored: false },
      // Another spelling, which reaches `.git` on Windows and macOS (choice 104); refused on Linux too, where it is
      // only a name.
      ...(windows || process.platform === "darwin"
        ? [{ kind: "added" as const, path: "sub/.GIT/hooks/pre-commit", binary: false, execAfter: false, ignored: false }]
        : []),
    ];
    for (const c of handed) expect(await applyChange(c, w.ctx)).toEqual({ path: c.path, result: "refused", why: NEVER_APPLIED });
    expect(listing(w.root)).toEqual(["a.txt"]);
  });

  it("refuses links and paths whose type changed: they are applied by hand", async () => {
    const w = world({ "a.txt": "a\n" });
    const handed: Change[] = [
      { kind: "link", path: "j", after: "a.txt", ignored: false },
      { kind: "type", path: "a.txt", before: "file", after: "folder", ignored: false },
    ];
    for (const c of handed) expect(await applyChange(c, w.ctx)).toEqual({ path: c.path, result: "refused", why: BY_HAND });
    expect(listing(w.root)).toEqual(["a.txt"]);
  });

  it("refuses a change in a path git ignores (choice 109)", async () => {
    const w = world({ "a.txt": "a\n" });
    const c: Change = { kind: "added", path: "build/out.js", binary: false, execAfter: false, ignored: true };
    w.box("build/out.js", "built\n");
    const why = "git ignores this path; its changes are counted, never applied";
    expect(await applyChange(c, w.ctx)).toEqual({ path: "build/out.js", result: "refused", why });
    expect(listing(w.root)).toEqual(["a.txt"]);
  });

  it("refuses a change whose parent folder was replaced by a junction, writing nothing through it", async () => {
    const w = world({ "src/a.ts": "old\n" });
    w.box("src/a.ts", "new\n");
    const c = await w.change("src/a.ts");
    // The same file outside, so through the junction it would match its snapshot.
    writeFileSync(path.join(w.outside, "a.ts"), "old\n");
    renameSync(w.at("src"), w.at("src-was"));
    // A junction on Windows needs no special rights; elsewhere it is an ordinary symlink.
    symlinkSync(w.outside, w.at("src"), "junction");
    expect(await applyChange(c, w.ctx)).toEqual({ path: "src/a.ts", result: "refused", why: "src is a link, and apply never writes through one" });
    expect(listing(w.outside)).toEqual(["a.ts"]);
    expect(readFileSync(path.join(w.outside, "a.ts"), "utf8")).toBe("old\n");
    expect(existsSync(w.at(".tachikoma"))).toBe(false);
  });

  it("refuses a change when .tachikoma, or .tachikoma/backups, is a junction to a folder outside", async () => {
    for (const link of [".tachikoma", ".tachikoma/backups"]) {
      const w = world({ "edit.txt": "old\n" });
      w.box("edit.txt", "new\n");
      mkdirSync(path.dirname(w.at(link)), { recursive: true });
      symlinkSync(w.outside, w.at(link), "junction");
      expect(await applyChange(await w.change("edit.txt"), w.ctx)).toEqual({
        path: "edit.txt",
        result: "refused",
        why: `${link} is a link, and apply never writes through one`,
      });
      expect(listing(w.outside)).toEqual([]);
      expect(w.read("edit.txt")).toBe("old\n");
      expect(w.log()).toEqual([]);
    }
  });

  it("refuses a delete whose parent folder is a junction, deleting nothing", async () => {
    const w = world({ "lib/gone.txt": "bye\n" });
    rmTree(path.join(w.ctx.work, "lib"));
    const c = await w.change("lib/gone.txt");
    writeFileSync(path.join(w.outside, "gone.txt"), "bye\n");
    renameSync(w.at("lib"), w.at("lib-was"));
    symlinkSync(w.outside, w.at("lib"), "junction");
    expect(await applyChange(c, w.ctx)).toMatchObject({ result: "refused", why: "lib is a link, and apply never writes through one" });
    expect(readFileSync(path.join(w.outside, "gone.txt"), "utf8")).toBe("bye\n");
  });

  it("refuses a file with another name (a hard link), changing neither", async () => {
    const w = world({ "edit.txt": "old\n" });
    w.box("edit.txt", "new\n");
    linkSync(w.at("edit.txt"), path.join(w.outside, "same-file.txt"));
    expect(await applyChange(await w.change("edit.txt"), w.ctx)).toEqual({
      path: "edit.txt",
      result: "refused",
      why: "edit.txt has other names (hard links), so it was not replaced",
    });
    expect(w.read("edit.txt")).toBe("old\n");
    expect(readFileSync(path.join(w.outside, "same-file.txt"), "utf8")).toBe("old\n");
  });

  it("writes the backup and the pending row before the swap", async () => {
    const w = world({ "edit.txt": "old\n" });
    w.box("edit.txt", "new\n");
    let seen = false;
    await applyChange(await w.change("edit.txt"), w.ctx, false, {
      step: (at) => {
        if (at !== "rename") return;
        seen = true;
        expect(readFileSync(w.backup("edit.txt"), "utf8")).toBe("old\n");
        expect(w.log()).toEqual([{ path: "edit.txt", state: "pending", before: sha("old\n"), after: sha("new\n") }]);
        expect(w.read("edit.txt")).toBe("old\n");
      },
    });
    expect(seen).toBe(true);
  });

  it("applies again after a crash before the rename, keeping the backup already made", async () => {
    const w = world({ "edit.txt": "old\n" });
    w.box("edit.txt", "new\n");
    const c = await w.change("edit.txt");
    await expect(applyChange(c, w.ctx, false, { step: crashAt("rename") })).rejects.toThrow("crash");
    expect(await applyChange(c, w.ctx)).toEqual({ path: "edit.txt", result: "applied" });
    expect(w.read("edit.txt")).toBe("new\n");
    expect(readFileSync(w.backup("edit.txt"), "utf8")).toBe("old\n");
  });

  it("refuses a change whose backup's name holds something else", async () => {
    const w = world({ "edit.txt": "old\n" });
    w.box("edit.txt", "new\n");
    mkdirSync(path.dirname(w.backup("edit.txt")), { recursive: true });
    writeFileSync(w.backup("edit.txt"), "not this file's\n");
    expect(await applyChange(await w.change("edit.txt"), w.ctx)).toEqual({
      path: "edit.txt",
      result: "refused",
      why: ".tachikoma/backups/s1/edit.txt is already there and is not this file's backup; move it, then apply again",
    });
    expect(w.read("edit.txt")).toBe("old\n");
    expect(readFileSync(w.backup("edit.txt"), "utf8")).toBe("not this file's\n");
  });
});

describe("applyChange's merge", () => {
  it("applies a clean merge of the box's change and the user's, backed up and logged", async (t) => {
    const w = world({ "x.txt": "one\ntwo\nthree\n" });
    needGit(t, w);
    w.box("x.txt", "ONE\ntwo\nthree\n");
    w.user("x.txt", "one\ntwo\nTHREE\n");
    const c = await w.change("x.txt");
    expect(await applyChange(c, w.ctx)).toMatchObject({ result: "conflict", why: CHANGED_SINCE });
    expect(await applyChange(c, w.ctx, true, { env: w.env })).toEqual({ path: "x.txt", result: "applied" });
    expect(w.read("x.txt")).toBe("ONE\ntwo\nTHREE\n");
    expect(readFileSync(w.backup("x.txt"), "utf8")).toBe("one\ntwo\nTHREE\n");
    expect(w.log()).toEqual([
      { path: "x.txt", state: "pending", before: sha("one\ntwo\nTHREE\n"), after: sha("ONE\ntwo\nTHREE\n") },
      { path: "x.txt", state: "done" },
    ]);
    // The merge's own folder, in the copy's folder, is gone.
    expect(readdirSync(w.copies).sort()).toEqual(["applied.jsonl", "base", "manifest.json", "work"]);
  });

  it("merges an added file the user also made, from an empty start", async (t) => {
    const w = world({ "a.txt": "a\n" });
    needGit(t, w);
    w.box("new.txt", "same\n");
    w.user("new.txt", "same\n");
    expect(await applyChange(await w.change("new.txt"), w.ctx, true, { env: w.env })).toEqual({ path: "new.txt", result: "applied" });
    expect(w.read("new.txt")).toBe("same\n");
  });

  it("writes a conflicting merge's markers beside the file, which is left as it was", async (t) => {
    const w = world({ "x.txt": "one\ntwo\n" });
    needGit(t, w);
    w.box("x.txt", "box\ntwo\n");
    w.user("x.txt", "user\ntwo\n");
    expect(await applyChange(await w.change("x.txt"), w.ctx, true, { env: w.env })).toEqual({
      path: "x.txt",
      result: "conflict",
      mergedTo: "x.txt.tachikoma-merge",
    });
    expect(w.read("x.txt")).toBe("user\ntwo\n");
    const markers = w.read("x.txt.tachikoma-merge");
    expect(markers).toMatch(/^<<<<<<< your folder\nuser\n=======\nbox\n>>>>>>> the box's copy\ntwo\n$/);
    expect(w.log()).toEqual([]);
  });

  it("writes nothing when the markers file's name is taken", async (t) => {
    const w = world({ "x.txt": "one\n" });
    needGit(t, w);
    w.box("x.txt", "box\n");
    w.user("x.txt", "user\n");
    w.user("x.txt.tachikoma-merge", "the user's own\n");
    expect(await applyChange(await w.change("x.txt"), w.ctx, true, { env: w.env })).toEqual({
      path: "x.txt",
      result: "conflict",
      why: "x.txt.tachikoma-merge already exists; move it, then merge again",
    });
    expect(w.read("x.txt.tachikoma-merge")).toBe("the user's own\n");
    expect(w.read("x.txt")).toBe("user\n");
    // A link under that name is taken too, and nothing is written through it.
    unlinkSync(w.at("x.txt.tachikoma-merge"));
    symlinkSync(w.outside, w.at("x.txt.tachikoma-merge"), "junction");
    const again = await applyChange(await w.change("x.txt"), w.ctx, true, { env: w.env });
    expect(again).toMatchObject({ result: "conflict", why: "x.txt.tachikoma-merge already exists; move it, then merge again" });
    expect(listing(w.outside)).toEqual([]);
  });

  it("never merges a binary file", async () => {
    const w = world({ "pic.bin": `p${ZERO}1` });
    w.box("pic.bin", `p${ZERO}2`);
    w.user("pic.bin", `p${ZERO}3`);
    const c = await w.change("pic.bin");
    for (const merge of [false, true]) {
      expect(await applyChange(c, w.ctx, merge, { env: w.env })).toEqual({ path: "pic.bin", result: "conflict", why: "a binary file; resolve it by hand" });
    }
    expect(readFileSync(w.at("pic.bin"))).toEqual(Buffer.from(`p${ZERO}3`));
  });

  it("cannot merge a file deleted on one side", async () => {
    const w = world({ "x.txt": "one\n", "y.txt": "y\n" });
    unlinkSync(path.join(w.ctx.work, "x.txt"));
    w.user("x.txt", "user\n");
    w.box("y.txt", "box\n");
    unlinkSync(w.at("y.txt"));
    for (const rel of ["x.txt", "y.txt"]) {
      expect(await applyChange(await w.change(rel), w.ctx, true, { env: w.env })).toEqual({
        path: rel,
        result: "conflict",
        why: "deleted on one side, or no longer a file; resolve it by hand",
      });
    }
    expect(w.read("x.txt")).toBe("user\n");
  });

  it("reads a git that fails without merging as failed, not as a conflict, and writes no markers", async () => {
    const w = world({ "x.txt": "one\n" });
    w.box("x.txt", "box\n");
    w.user("x.txt", "user\n");
    // As macOS's /usr/bin/git does without Apple's developer tools: it prints an error and exits 1, leaving the files.
    // A stand-in for the git run, as no fake program is planted.
    const run = async () => ({ code: 1, err: "xcrun: error: made-up missing developer tools\n" });
    expect(await applyChange(await w.change("x.txt"), w.ctx, true, { env: w.env, git: run })).toEqual({
      path: "x.txt",
      result: "conflict",
      why: "git merge-file failed: xcrun: error: made-up missing developer tools",
    });
    expect(existsSync(w.at("x.txt.tachikoma-merge"))).toBe(false);
    expect(w.read("x.txt")).toBe("user\n");
  });

  it("says so plainly when git is not installed", async () => {
    const w = world({ "x.txt": "one\n" });
    w.box("x.txt", "box\n");
    w.user("x.txt", "user\n");
    const empty = path.join(w.dir, "no-programs");
    mkdirSync(empty);
    expect(await applyChange(await w.change("x.txt"), w.ctx, true, { env: { ...w.env, PATH: empty } })).toEqual({
      path: "x.txt",
      result: "conflict",
      why: "git was not found, so it cannot be merged; resolve it by hand",
    });
  });
});

describe("appliedSoFar", () => {
  it("is empty before anything is applied", () => {
    const w = world({ "a.txt": "a\n" });
    return expect(appliedSoFar("s1", w.data)).resolves.toEqual([]);
  });

  it("reports a crash right before the rename as not applied", async () => {
    const w = world({ "edit.txt": "old\n" });
    w.box("edit.txt", "new\n");
    await expect(applyChange(await w.change("edit.txt"), w.ctx, false, { step: crashAt("rename") })).rejects.toThrow("crash");
    expect(await appliedSoFar("s1", w.data)).toEqual([{ path: "edit.txt", result: "skipped", why: "not applied" }]);
  });

  it("reports a crash right after the rename, before the done row, as applied", async () => {
    const w = world({ "edit.txt": "old\n" });
    w.box("edit.txt", "new\n");
    await expect(applyChange(await w.change("edit.txt"), w.ctx, false, { step: crashAt("done") })).rejects.toThrow("crash");
    expect(w.log().map((r) => r.state)).toEqual(["pending"]);
    expect(await appliedSoFar("s1", w.data)).toEqual([{ path: "edit.txt", result: "applied" }]);
  });

  it("reports a crash between two files: the first two applied, the third never started", async () => {
    const w = world({ "a.txt": "a\n", "b.txt": "b\n", "gone.txt": "g\n" });
    w.box("a.txt", "A\n");
    w.box("b.txt", "B\n");
    unlinkSync(path.join(w.ctx.work, "gone.txt"));
    await applyChange(await w.change("a.txt"), w.ctx);
    await expect(applyChange(await w.change("gone.txt"), w.ctx, false, { step: crashAt("done") })).rejects.toThrow("crash");
    expect(await appliedSoFar("s1", w.data)).toEqual([
      { path: "a.txt", result: "applied" },
      { path: "gone.txt", result: "applied" },
    ]);
  });

  it("reports a pending file the user edited since as changed since, and leaves it alone", async () => {
    const w = world({ "edit.txt": "old\n" });
    w.box("edit.txt", "new\n");
    await expect(applyChange(await w.change("edit.txt"), w.ctx, false, { step: crashAt("rename") })).rejects.toThrow("crash");
    w.user("edit.txt", "the user's\n");
    expect(await appliedSoFar("s1", w.data)).toEqual([{ path: "edit.txt", result: "conflict", why: "changed since" }]);
    expect(w.read("edit.txt")).toBe("the user's\n");
  });

  it("passes over a half-written last line", async () => {
    const w = world({ "a.txt": "a\n" });
    w.box("a.txt", "A\n");
    await applyChange(await w.change("a.txt"), w.ctx);
    writeFileSync(path.join(w.copies, "applied.jsonl"), `${readFileSync(path.join(w.copies, "applied.jsonl"), "utf8")}{"path":"b.t`);
    expect(await appliedSoFar("s1", w.data)).toEqual([{ path: "a.txt", result: "applied" }]);
  });
});

// A test hook that stops the apply at `step`, as a crash would.
function crashAt(step: string) {
  return (at: string) => {
    if (at === step) throw new Error("crash");
  };
}

// Removes a folder of work/ the test made, holding only files, as the box would delete it.
function rmTree(folder: string) {
  for (const name of readdirSync(folder)) unlinkSync(path.join(folder, name));
  rmdirSync(folder);
}
