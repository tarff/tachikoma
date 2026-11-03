import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { snapshot } from "../../src/sandbox/snapshot.js";
import { removeTree, TREE } from "../helpers.js";

const windows = process.platform === "win32";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
// The size and modified time of work/'s copy of a file, which its entry records (choice 112).
const copyOf = (work: string, rel: string) => {
  const st = statSync(path.join(work, rel));
  return { size: st.size, mtimeMs: st.mtimeMs };
};

// A test's own folder, holding a project with `tree` in it, a data folder for the copies and a folder outside the
// project for links to reach. No git runs: the snapshot never asks git, so TREE's ignored files and its .git are
// files like any other here.
function world(tree: Record<string, string> = {}) {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "tachi-snapshot-")));
  onTestFinished(() => removeTree(dir));
  const root = path.join(dir, "project");
  const data = path.join(dir, "data");
  const outside = path.join(dir, "elsewhere");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(path.join(outside, "secret.txt"), "made-up outside text\n");
  const at = (rel: string) => path.join(root, rel);
  for (const [rel, text] of Object.entries(tree)) {
    mkdirSync(path.dirname(at(rel)), { recursive: true });
    writeFileSync(at(rel), text);
  }
  const copies = path.join(data, "copies", "s1");
  return { dir, root, data, outside, at, copies, base: path.join(copies, "base"), work: path.join(copies, "work") };
}

describe("snapshot", () => {
  it("copies untracked and ignored files into base and work, with each file's hash, and the manifest last", async () => {
    const w = world(TREE);
    const { manifest, base, work } = await snapshot(w.root, "s1", w.data);
    expect(base).toBe(w.base);
    expect(work).toBe(w.work);
    expect(manifest.session).toBe("s1");
    expect(manifest.root).toBe(w.root);
    expect(Number.isNaN(Date.parse(manifest.at))).toBe(false);
    expect(manifest.leftOut).toEqual([]);
    const files = Object.entries(TREE).filter(([rel]) => !rel.startsWith(".git/"));
    for (const [rel, text] of files) {
      expect(manifest.entries[rel]).toEqual({ type: "file", sha256: sha(text), exec: false, ...copyOf(work, rel) });
      expect(readFileSync(path.join(base, rel), "utf8")).toBe(text);
      expect(readFileSync(path.join(work, rel), "utf8")).toBe(text);
    }
    // build/ and the *.log files are ignored by .gitignore, and copied all the same (choice 24).
    expect(manifest.entries["build/out.js"]?.type).toBe("file");
    expect(manifest.entries["x.log"]?.type).toBe("file");
    for (const folder of ["src", "src/core", "build", "notes"]) expect(manifest.entries[folder]).toEqual({ type: "folder" });
    expect(Object.keys(manifest.entries).sort()).toEqual([...files.map(([rel]) => rel), "src", "src/core", "build", "notes"].sort());
    expect(JSON.parse(readFileSync(path.join(w.copies, "manifest.json"), "utf8"))).toEqual(manifest);
  });

  it("leaves out every .git and .tachikoma, folder or file, at any depth, compared as protected.ts compares names", async () => {
    const w = world({
      "a.txt": "kept\n",
      ".git/HEAD": "ref: refs/heads/main\n",
      ".tachikoma/sessions/x.jsonl": "{}\n",
      "vendor/lib/.git": "gitdir: ../../.git/modules/lib\n",
      "vendor/lib/b.txt": "kept too\n",
      "deep/.tachikoma": "a file of that name\n",
      // Another spelling: the same name on Windows and macOS, which ignore letter case (choice 104), a different one on
      // Linux.
      "other/.GIT/config": "spelt in capitals\n",
    });
    const { manifest, base, work } = await snapshot(w.root, "s1", w.data);
    const folded = windows || process.platform === "darwin";
    const kept = ["a.txt", "vendor", "vendor/lib", "vendor/lib/b.txt", "deep", "other", ...(folded ? [] : ["other/.GIT", "other/.GIT/config"])];
    expect(Object.keys(manifest.entries).sort()).toEqual(kept.sort());
    expect(manifest.leftOut).toEqual([]);
    for (const copy of [base, work]) {
      for (const rel of [".git", ".tachikoma", "vendor/lib/.git", "deep/.tachikoma"]) expect(existsSync(path.join(copy, rel))).toBe(false);
      expect(existsSync(path.join(copy, "other/.GIT"))).toBe(!folded);
      expect(readFileSync(path.join(copy, "vendor/lib/b.txt"), "utf8")).toBe("kept too\n");
    }
  });

  it("records the size and modified time of work/'s copy, not the project's file", async () => {
    const w = world({ "a.txt": "five\n" });
    // A day before the snapshot, so the copy's own time, taken as it is made, differs.
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(w.at("a.txt"), old, old);
    const { manifest, work } = await snapshot(w.root, "s1", w.data);
    expect(manifest.entries["a.txt"]).toMatchObject({ size: 5, mtimeMs: statSync(path.join(work, "a.txt")).mtimeMs });
    expect(statSync(path.join(work, "a.txt")).mtimeMs).not.toBe(statSync(w.at("a.txt")).mtimeMs);
  });

  it("records a file named __proto__ as an entry like any other", async () => {
    // A computed key, as a plain `__proto__:` in an object literal sets its prototype instead.
    const w = world({ ["__proto__"]: "made-up\n", "sub/__proto__": "made-up too\n" });
    expect(existsSync(w.at("__proto__"))).toBe(true);
    const { manifest } = await snapshot(w.root, "s1", w.data);
    expect(Object.keys(manifest.entries).sort()).toEqual(["__proto__", "sub", "sub/__proto__"]);
    expect(Object.hasOwn(manifest.entries, "__proto__")).toBe(true);
    // A path never recorded is not found, whatever the object holds.
    expect(manifest.entries["other.txt"]).toBeUndefined();
    expect(JSON.parse(readFileSync(path.join(w.copies, "manifest.json"), "utf8")).entries.__proto__.type).toBe("file");
  });

  it("copies files as new files, never hard links (nlink 1)", async () => {
    const w = world({ "a.txt": "one\n", "sub/b.txt": "two\n" });
    const { base, work } = await snapshot(w.root, "s1", w.data);
    for (const rel of ["a.txt", "sub/b.txt"]) {
      const real = statSync(w.at(rel), { bigint: true });
      expect(real.nlink).toBe(1n);
      for (const copy of [base, work]) {
        const st = statSync(path.join(copy, rel), { bigint: true });
        expect(st.nlink).toBe(1n);
        expect(st.ino).not.toBe(real.ino);
      }
    }
  });

  it("records the executable flag", async (ctx) => {
    if (windows) return ctx.skip("Windows has no executable flag: every file is recorded as not executable, checked above");
    const w = world({ "plain.sh": "echo made-up\n" });
    // Made with its mode at creation, never changed afterwards (the plan's rule: no permission changes).
    writeFileSync(w.at("run.sh"), "echo made-up\n", { mode: 0o755 });
    const { manifest, work } = await snapshot(w.root, "s1", w.data);
    expect(manifest.entries["run.sh"]).toEqual({ type: "file", sha256: sha("echo made-up\n"), exec: true, ...copyOf(work, "run.sh") });
    expect(manifest.entries["plain.sh"]).toEqual({ type: "file", sha256: sha("echo made-up\n"), exec: false, ...copyOf(work, "plain.sh") });
    expect(statSync(path.join(work, "run.sh")).mode & 0o100).toBe(0o100);
    expect(statSync(path.join(work, "plain.sh")).mode & 0o100).toBe(0);
  });

  it("remakes a junction inside the project in both copies, and leaves out one outside and one to nothing", async () => {
    const w = world({ "src/a.ts": "const a = 1;\n" });
    // A junction on Windows needs no special rights; elsewhere it is an ordinary symlink.
    symlinkSync(w.at("src"), w.at("joined"), "junction");
    symlinkSync(w.outside, w.at("out"), "junction");
    symlinkSync(w.at("missing"), w.at("gone"), "junction");
    const { manifest, base, work } = await snapshot(w.root, "s1", w.data);
    // The project's own target, to show, and the one work/ holds, which the changes compare against (Task 18).
    expect(manifest.entries.joined).toEqual({ type: "link", target: readlinkSync(w.at("joined")), inCopy: readlinkSync(path.join(work, "joined")) });
    for (const copy of [base, work]) {
      // Windows: the copy's absolute path; elsewhere the same place written relative, so it also holds in the box.
      expect(readlinkSync(path.join(copy, "joined"))).toBe(windows ? path.join(copy, "src") : "src");
      expect(realpathSync.native(path.join(copy, "joined"))).toBe(realpathSync.native(path.join(copy, "src")));
      expect(readFileSync(path.join(copy, "joined", "a.ts"), "utf8")).toBe("const a = 1;\n");
      expect(existsSync(path.join(copy, "out"))).toBe(false);
      expect(statSync(path.join(copy, "gone"), { throwIfNoEntry: false })).toBeUndefined();
    }
    expect(manifest.entries.out).toBeUndefined();
    expect(manifest.entries.gone).toBeUndefined();
    // Sorted: a folder's entries come in the file system's own order, which is not by name on every system.
    expect(manifest.leftOut.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "gone", why: "a link that leads nowhere" },
      { path: "out", why: "a link that leads outside the project" },
    ]);
  });

  it("rewrites an absolute link in a subfolder to the copy's same place", async () => {
    const w = world({ "src/a.ts": "const a = 1;\n", "sub/b.txt": "b\n" });
    // A junction on Windows needs no special rights; elsewhere it is an ordinary symlink, stored absolute.
    symlinkSync(w.at("src"), w.at("sub/j"), "junction");
    const { manifest, base, work } = await snapshot(w.root, "s1", w.data);
    for (const copy of [base, work]) {
      // Windows: a junction to the copy's absolute path; elsewhere relative to the link's own folder.
      expect(readlinkSync(path.join(copy, "sub/j"))).toBe(windows ? path.join(copy, "src") : path.join("..", "src"));
      expect(readFileSync(path.join(copy, "sub/j/a.ts"), "utf8")).toBe("const a = 1;\n");
    }
    expect(manifest.entries["sub/j"]).toEqual({ type: "link", target: w.at("src"), inCopy: windows ? path.join(work, "src") : path.join("..", "src") });
  });

  it("keeps a relative link's text, and leaves out one that climbs out of the project", async (ctx) => {
    const w = world({ "src/a.ts": "const a = 1;\n" });
    try {
      symlinkSync(path.join("src", "a.ts"), w.at("rel"), "file");
    } catch {
      return ctx.skip("Windows makes file symlinks only with Developer Mode or as an administrator");
    }
    symlinkSync(path.join("..", "elsewhere", "secret.txt"), w.at("up"), "file");
    const { manifest, base, work } = await snapshot(w.root, "s1", w.data);
    expect(manifest.entries.rel).toEqual({ type: "link", target: readlinkSync(w.at("rel")), inCopy: readlinkSync(w.at("rel")) });
    for (const copy of [base, work]) {
      expect(readlinkSync(path.join(copy, "rel"))).toBe(readlinkSync(w.at("rel")));
      expect(readFileSync(path.join(copy, "rel"), "utf8")).toBe("const a = 1;\n");
      expect(existsSync(path.join(copy, "up"))).toBe(false);
    }
    expect(manifest.leftOut).toEqual([{ path: "up", why: "a link that leads outside the project" }]);
  });

  it("leaves out and lists an entry that is not a file, folder or link", async (ctx) => {
    if (windows) return ctx.skip("Windows keeps no sockets or pipes among a folder's entries");
    const w = world({ "a.txt": "one\n" });
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(w.at("socket"), resolve));
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { manifest, work } = await snapshot(w.root, "s1", w.data);
    expect(manifest.leftOut).toEqual([{ path: "socket", why: "not a file, folder or link" }]);
    expect(manifest.entries.socket).toBeUndefined();
    expect(existsSync(path.join(work, "socket"))).toBe(false);
  });

  it("refuses the copy when a link in work/ leads outside it, writing no manifest", async () => {
    const w = world({ "d/f.txt": "in d\n" });
    symlinkSync(w.at("d"), w.at("j"), "junction");
    // Between the copy and the hash of d/f.txt, the copy's d is swapped for a junction outside the copy, so j, remade to
    // the copy's d, now leads out of it.
    const copied = (rel: string) => {
      if (rel !== "d/f.txt") return;
      renameSync(path.join(w.work, "d"), path.join(w.work, "d-moved"));
      symlinkSync(w.outside, path.join(w.work, "d"), "junction");
    };
    await expect(snapshot(w.root, "s1", w.data, { copied })).rejects.toThrow(
      "The copy was refused: the link j in it leads outside the copy.",
    );
    expect(existsSync(path.join(w.copies, "manifest.json"))).toBe(false);
  });

  it("copies and hashes again a file that changed while it was copied", async () => {
    const w = world({ "a.txt": "first\n", "b.txt": "steady\n" });
    let changes = 0;
    const copied = (rel: string) => {
      if (rel === "a.txt" && changes++ === 0) writeFileSync(w.at("a.txt"), "second, longer\n");
    };
    const { manifest, base, work } = await snapshot(w.root, "s1", w.data, { copied });
    expect(changes).toBe(2);
    expect(manifest.entries["a.txt"]).toEqual({ type: "file", sha256: sha("second, longer\n"), exec: false, ...copyOf(work, "a.txt") });
    expect(readFileSync(path.join(base, "a.txt"), "utf8")).toBe("second, longer\n");
    expect(readFileSync(path.join(work, "a.txt"), "utf8")).toBe("second, longer\n");
  });

  it("refuses the snapshot when a file changes again", async () => {
    const w = world({ "sub/a.txt": "0\n" });
    let changes = 0;
    const copied = (rel: string) => {
      if (rel === "sub/a.txt") writeFileSync(w.at("sub/a.txt"), `${++changes}\n`);
    };
    await expect(snapshot(w.root, "s1", w.data, { copied })).rejects.toThrow(
      "The project would not hold still while it was copied (sub/a.txt kept changing); try again when nothing is writing to it.",
    );
    expect(changes).toBe(2);
    expect(existsSync(path.join(w.copies, "manifest.json"))).toBe(false);
  });
});
