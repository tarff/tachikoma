import { mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { changes } from "../../src/sandbox/changes.js";
import { snapshot } from "../../src/sandbox/snapshot.js";
import { removeTree, ZERO } from "../helpers.js";

const windows = process.platform === "win32";

// A test's own folder, holding a project with `tree` in it, and what `more` makes there, and a data folder for its copy,
// which is taken at once. The test then changes work/ as the box would.
async function copied(tree: Record<string, string>, more: (at: (rel: string) => string) => void = () => {}) {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "tachi-changes-")));
  onTestFinished(() => removeTree(dir));
  const root = path.join(dir, "project");
  const at = (rel: string) => path.join(root, rel);
  mkdirSync(root);
  for (const [rel, text] of Object.entries(tree)) {
    mkdirSync(path.dirname(at(rel)), { recursive: true });
    writeFileSync(at(rel), text);
  }
  more(at);
  const { manifest, work } = await snapshot(root, "s1", path.join(dir, "data"));
  const inWork = (rel: string) => path.join(work, rel);
  const write = (rel: string, text: string) => {
    mkdirSync(path.dirname(inWork(rel)), { recursive: true });
    writeFileSync(inWork(rel), text);
  };
  return { manifest, work, inWork, write };
}

describe("changes", () => {
  it("finds nothing in an untouched copy, its links rewritten in the copy included", async () => {
    const w = await copied({ "a.txt": "a\n", "src/b.ts": "b\n", "sub/c.txt": "c\n" }, (at) => {
      // A junction on Windows needs no special rights, and is rewritten to the copy's absolute path; elsewhere an
      // ordinary absolute link, rewritten relative.
      symlinkSync(at("src"), at("sub/j"), "junction");
    });
    const j = w.manifest.entries["sub/j"];
    expect(j?.type === "link" && j.inCopy !== j.target).toBe(true);
    expect(await changes(w.manifest, w.work)).toEqual({ changes: [], leftOut: [] });
  });

  it("finds added, changed and deleted files, a deleted folder's files among them, sorted by path", async () => {
    const w = await copied({ "keep.txt": "same\n", "edit.txt": "old\n", "gone.txt": "bye\n", "old/x.txt": "x\n", "old/y.bin": `y${ZERO}` });
    w.write("edit.txt", "new\n");
    w.write("new/added.txt", "hello\n");
    w.write("pic.bin", `p${ZERO}ng`);
    unlinkSync(w.inWork("gone.txt"));
    rmSync(w.inWork("old"), { recursive: true });
    const file = (kind: string, p: string, binary: boolean, exec: { execBefore?: boolean; execAfter?: boolean }) => ({
      kind,
      path: p,
      binary,
      ...exec,
      ignored: false,
    });
    expect(await changes(w.manifest, w.work)).toEqual({
      changes: [
        file("changed", "edit.txt", false, { execBefore: false, execAfter: false }),
        file("deleted", "gone.txt", false, { execBefore: false }),
        file("added", "new/added.txt", false, { execAfter: false }),
        file("deleted", "old/x.txt", false, { execBefore: false }),
        file("deleted", "old/y.bin", true, { execBefore: false }),
        file("added", "pic.bin", true, { execAfter: false }),
      ],
      leftOut: [],
    });
  });

  it("finds a file added under a name objects have, as any other", async () => {
    const w = await copied({ "a.txt": "a\n" });
    w.write("constructor", "made-up\n");
    w.write("sub/toString", "made-up\n");
    expect((await changes(w.manifest, w.work)).changes.map((c) => [c.kind, c.path])).toEqual([
      ["added", "constructor"],
      ["added", "sub/toString"],
    ]);
  });

  it("marks a changed file binary when either side is", async () => {
    const w = await copied({ "was.bin": `a${ZERO}`, "now.bin": "text\n" });
    w.write("was.bin", "text now\n");
    w.write("now.bin", `b${ZERO}`);
    const found = (await changes(w.manifest, w.work)).changes;
    expect(found.map((c) => [c.path, c.kind, "binary" in c && c.binary])).toEqual([
      ["now.bin", "changed", true],
      ["was.bin", "changed", true],
    ]);
  });

  it("finds a file made executable, and one made not executable, with the same content", async (ctx) => {
    if (windows) return ctx.skip("Windows has no executable flag: every file is recorded as not executable");
    const w = await copied({ "plain.sh": "echo made-up\n" }, (at) => {
      // Made with its mode at creation, never changed afterwards (the plan's rule: no permission changes).
      writeFileSync(at("run.sh"), "echo made-up\n", { mode: 0o755 });
    });
    // Each replaced by a new file made with the other mode.
    for (const [name, mode] of [["run.sh", 0o644], ["plain.sh", 0o755]] as const) {
      unlinkSync(w.inWork(name));
      writeFileSync(w.inWork(name), "echo made-up\n", { mode });
    }
    expect((await changes(w.manifest, w.work)).changes).toEqual([
      { kind: "changed", path: "plain.sh", binary: false, execBefore: false, execAfter: true, ignored: false },
      { kind: "changed", path: "run.sh", binary: false, execBefore: true, execAfter: false, ignored: false },
    ]);
  });

  it("finds a link retargeted, added and deleted, each showing the project's own target", async () => {
    const w = await copied({ "src/a.ts": "a\n", "lib/b.ts": "b\n" }, (at) => {
      symlinkSync(at("src"), at("j"), "junction");
      symlinkSync(at("lib"), at("k"), "junction");
    });
    const target = (rel: string) => {
      const e = w.manifest.entries[rel];
      return e?.type === "link" ? e.target : undefined;
    };
    unlinkSync(w.inWork("j"));
    symlinkSync(w.inWork("lib"), w.inWork("j"), "junction");
    unlinkSync(w.inWork("k"));
    symlinkSync(w.inWork("src"), w.inWork("n"), "junction");
    expect(await changes(w.manifest, w.work)).toEqual({
      changes: [
        { kind: "link", path: "j", before: target("j"), after: readlinkSync(w.inWork("j")), ignored: false },
        { kind: "link", path: "k", before: target("k"), ignored: false },
        { kind: "link", path: "n", after: readlinkSync(w.inWork("n")), ignored: false },
      ],
      leftOut: [],
    });
  });

  it("finds a file made a folder, a folder made a file and a folder made a link, listing nothing under them", async () => {
    const w = await copied({ "f": "was a file\n", "d/x.txt": "x\n", "d/y.txt": "y\n", "e/z.txt": "z\n", "t/u.txt": "u\n" });
    unlinkSync(w.inWork("f"));
    w.write("f/inside.txt", "now a folder\n");
    rmSync(w.inWork("d"), { recursive: true });
    w.write("d", "now a file\n");
    rmSync(w.inWork("e"), { recursive: true });
    symlinkSync(w.inWork("t"), w.inWork("e"), "junction");
    expect(await changes(w.manifest, w.work)).toEqual({
      changes: [
        { kind: "type", path: "d", before: "folder", after: "file", ignored: false },
        { kind: "type", path: "e", before: "folder", after: "link", ignored: false },
        { kind: "type", path: "f", before: "file", after: "folder", ignored: false },
      ],
      leftOut: [],
    });
  });

  it("skips and lists every .git and .tachikoma made in work/ after the snapshot, the box's own repository included", async () => {
    const w = await copied({ "a.txt": "a\n", "sub/b.txt": "b\n" });
    w.write(".git/HEAD", "ref: refs/heads/main\n");
    w.write(".tachikoma/sessions/x.jsonl", "{}\n");
    w.write("sub/.git/config", "made-up\n");
    w.write("sub/deep/.tachikoma", "a file of that name\n");
    const why = "Tachikoma's own and git's folders are never applied";
    const { changes: found, leftOut } = await changes(w.manifest, w.work);
    expect(found).toEqual([]);
    expect(leftOut.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: ".git", why },
      { path: ".tachikoma", why },
      { path: "sub/.git", why },
      { path: "sub/deep/.tachikoma", why },
    ]);
  });

  it("skips another spelling of .git where the system folds letter case, as protected.ts compares names", async () => {
    const w = await copied({ "a.txt": "a\n" });
    w.write("sub/.GIT/config", "spelt in capitals\n");
    const folded = windows || process.platform === "darwin";
    const { changes: found, leftOut } = await changes(w.manifest, w.work);
    expect(found.map((c) => c.path)).toEqual(folded ? [] : ["sub/.GIT/config"]);
    expect(leftOut.map((l) => l.path)).toEqual(folded ? ["sub/.GIT"] : []);
  });

  it("lists an entry that is not a file, folder or link, and counts a file replaced by one as deleted", async (ctx) => {
    if (windows) return ctx.skip("Windows keeps no sockets or pipes among a folder's entries");
    const w = await copied({ "a.txt": "a\n" });
    unlinkSync(w.inWork("a.txt"));
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(w.inWork("a.txt"), resolve));
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    expect(await changes(w.manifest, w.work)).toEqual({
      changes: [{ kind: "deleted", path: "a.txt", binary: false, execBefore: false, ignored: false }],
      leftOut: [{ path: "a.txt", why: "not a file, folder or link" }],
    });
  });
});

// Choice 109: every change whose path git's ignore rules cover is marked, by the .gitignore files of base/, the
// snapshot, read as the search tools read them.
describe("changes in git-ignored paths", () => {
  const ignoredOf = async (w: Awaited<ReturnType<typeof copied>>) =>
    Object.fromEntries((await changes(w.manifest, w.work)).changes.map((c) => [c.path, c.ignored]));

  it("marks changes the snapshot's .gitignore files cover, at any depth, a folder's rule and a '!' included", async () => {
    const w = await copied({
      ".gitignore": "node_modules/\n*.log\n!keep.log\nbuild\n",
      "src/.gitignore": "secret.ts\n",
      "src/a.ts": "a\n",
      "node_modules/pkg/index.js": "old\n",
    });
    w.write("node_modules/pkg/index.js", "new\n");
    w.write("node_modules/fresh/x.js", "x\n");
    w.write("run.log", "log\n");
    w.write("keep.log", "kept\n");
    w.write("src/secret.ts", "s\n");
    w.write("src/a.ts", "a2\n");
    w.write("other/secret.ts", "not covered: the rule is src's\n");
    w.write("build/out.js", "o\n");
    expect(await ignoredOf(w)).toEqual({
      "node_modules/pkg/index.js": true,
      "node_modules/fresh/x.js": true,
      "run.log": true,
      "keep.log": false,
      "src/secret.ts": true,
      "src/a.ts": false,
      "other/secret.ts": false,
      "build/out.js": true,
    });
  });

  it("matches a folder-only rule against folders, not files of that name", async () => {
    const w = await copied({ ".gitignore": "out/\n" });
    w.write("out", "a file named out\n");
    w.write("sub/out/x.txt", "x\n");
    expect(await ignoredOf(w)).toEqual({ out: false, "sub/out/x.txt": true });
  });

  it("marks a deleted file, a link and a type change too", async () => {
    const w = await copied({ ".gitignore": "gen/\n", "gen/a.txt": "a\n", "gen/f": "f\n", "src/x.ts": "x\n" });
    unlinkSync(w.inWork("gen/a.txt"));
    unlinkSync(w.inWork("gen/f"));
    w.write("gen/f/inside.txt", "now a folder\n");
    symlinkSync(w.inWork("src"), w.inWork("gen/j"), "junction");
    expect(await ignoredOf(w)).toEqual({ "gen/a.txt": true, "gen/f": true, "gen/j": true });
  });

  it("reads the rules from base/, never work/, so editing work's .gitignore changes nothing but is itself an ordinary change", async () => {
    const w = await copied({ ".gitignore": "*.log\n", "src/.gitignore": "x.ts\n" });
    w.write(".gitignore", "*.ts\n");
    rmSync(w.inWork("src/.gitignore"));
    w.write("src/x.ts", "x\n");
    w.write("a.ts", "a\n");
    w.write("b.log", "b\n");
    expect(await ignoredOf(w)).toEqual({ ".gitignore": false, "src/.gitignore": false, "src/x.ts": true, "a.ts": false, "b.log": true });
  });

  it("marks nothing in a project with no .gitignore files", async () => {
    const w = await copied({ "a.log": "a\n" });
    w.write("a.log", "changed\n");
    w.write("node_modules/x.js", "x\n");
    expect(await ignoredOf(w)).toEqual({ "a.log": false, "node_modules/x.js": false });
  });

  it("does not follow a .gitignore that is a link, as git does not", async (ctx) => {
    const w = await copied({ "rules.txt": "*.log\n" }, (at) => {
      try {
        symlinkSync("rules.txt", at(".gitignore"), "file");
      } catch {
        // Skipped below.
      }
    });
    if (w.manifest.entries[".gitignore"]?.type !== "link") return ctx.skip("Windows makes file symlinks only with Developer Mode or as an administrator");
    w.write("a.log", "a\n");
    expect(await ignoredOf(w)).toEqual({ "a.log": false });
  });
});
