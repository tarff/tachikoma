import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { fileTempDir, RETRY_LIMIT_MS, RETRY_PAUSE_MS, removeTree, tempContext, tempDir, warnLeft } from "./helpers.js";
import { type Moment, tryRemoveTree } from "./removeTree.mjs";

// The helpers' folders and the tests' remover (cleanup plan, step 4). Every link test puts a file in a folder outside
// the tree and ends by showing that file untouched. Only what the remover's first comment lists as held is tested.

const NO_RETRY = { pause: 0, limit: 0 };
const WINDOWS = process.platform === "win32";
const there = (folder: string) => (existsSync(folder) ? "still there" : "gone");
const listed = (dir: string) => readdirSync(dir, { withFileTypes: true });
const entry = (dir: string, name: string) => listed(dir).find((e) => e.name === name);
const sorted = (left: { path: string; reason: string }[]) => [...left].sort((a, b) => a.path.localeCompare(b.path));

// Every folder listed through node:fs/promises while the file runs, so that a test can show which listings the remover
// read; the listing itself is the real one.
const listings = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const readdir = (dir: string, ...rest: unknown[]) => (listings.push(String(dir)), (real.readdir as (...a: unknown[]) => unknown)(dir, ...rest));
  return { ...real, readdir };
});

// A folder outside the tree with one file in it, and the check that the file is as it was.
function outside() {
  const dir = realpathSync.native(tempDir("tachi-helpers-outside-"));
  const file = path.join(dir, "keep.txt");
  writeFileSync(file, "keep");
  return { dir, untouched: () => expect(readFileSync(file, "utf8")).toBe("keep") };
}

const KINDS = ["directory link", "junction", "junction naming its drive by ID"] as const;
type Kind = (typeof KINDS)[number];
// Windows makes a directory symlink only with Developer Mode or as an administrator, as tests/tools/search.test.ts says
// of file symlinks: where it may not, the cases with a directory link do not run. Tried once here, in a folder of the
// file's own, so that no case has to skip itself.
const DIR_LINKS = (() => {
  const probe = fileTempDir("tachi-helpers-probe-");
  try {
    symlinkSync(probe, path.join(probe, "link"), "dir");
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return false;
    throw err;
  }
})();
const runs = (kind: Kind) => (kind === "directory link" ? DIR_LINKS : kind === "junction" || WINDOWS);
// Makes `at` a link of that kind to `target`; the one naming its drive by ID is made as tests/tools/files.test.ts makes
// one.
function link(kind: Kind, target: string, at: string) {
  if (kind === "directory link") return symlinkSync(target, at, "dir");
  if (kind === "junction") return symlinkSync(target, at, "junction");
  const mountvol = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "mountvol.exe");
  const volume = execFileSync(mountvol, [target.slice(0, 2), "/L"], { encoding: "utf8" }).trim();
  execFileSync("cmd", ["/c", "mklink", "/J", at, volume + target.slice(3)]);
}

// A stand-in program working in `folder`, as a killed server works in a test's folder, and its stop, which waits until
// it has exited.
async function standIn(folder: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: folder, stdio: "ignore" });
  await once(child, "spawn");
  return child;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

// What the remover writes on stderr while `fn` runs.
async function stderrOf(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => (lines.push(String(chunk)), true));
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

describe("tempDir", () => {
  let made = "";
  it("makes a folder in Temp named by the prefix", () => {
    made = tempDir("tachi-helpers-");
    expect(path.dirname(made)).toBe(tmpdir());
    expect(path.basename(made)).toMatch(/^tachi-helpers-.{6}$/);
    expect(existsSync(made)).toBe(true);
  });
  it("has removed it once that test ended", () => {
    expect(made).not.toBe("");
    expect(existsSync(made)).toBe(false);
  });
});

describe("tempContext", () => {
  let root = "";
  it("makes its folder", async () => {
    root = (await tempContext()).root;
    expect(existsSync(root)).toBe(true);
  });
  it("has removed it once that test ended", () => {
    expect(root).not.toBe("");
    expect(existsSync(root)).toBe(false);
  });
});

// The order of the kinds of clean-up the test files mix, each written down by the clean-ups themselves.
describe("the order of clean-ups: an afterEach, two onTestFinished and a tempDir", () => {
  const order: string[] = [];
  let folder = "";
  afterEach(() => void (folder && order.push(`afterEach: folder ${there(folder)}`)));
  it("writes them down", () => {
    onTestFinished(() => void order.push(`onTestFinished registered before the folder was made: folder ${there(folder)}`));
    folder = tempDir("tachi-helpers-order-");
    onTestFinished(() => void order.push(`onTestFinished registered after the folder was made: folder ${there(folder)}`));
  });
  it("ran the afterEach first, then the onTestFinished newest first, the folder's removal in its place among them", () => {
    expect(order).toEqual([
      "afterEach: folder still there",
      "onTestFinished registered after the folder was made: folder still there",
      "onTestFinished registered before the folder was made: folder gone",
    ]);
    folder = "";
  });
});

describe("the order of clean-ups: an afterEach that waits for a process and a tempDir", () => {
  const order: string[] = [];
  let folder = "";
  let child: ChildProcess | undefined;
  afterEach(async () => {
    if (!child) return;
    await stop(child);
    order.push(`afterEach: process exited, folder ${there(folder)}`);
    child = undefined;
  });
  it("starts a process working in the folder", async () => {
    folder = tempDir("tachi-helpers-order-");
    child = await standIn(folder);
  });
  it("ran the afterEach's wait before the folder's removal, and the folder went", () => {
    expect(order).toEqual(["afterEach: process exited, folder still there"]);
    expect(existsSync(folder)).toBe(false);
  });
});

// fileTempDir's folder, seen from outside the file: each fixture is run as a child Vitest run, writes down the folders
// it made and what its own later test and afterAll saw, and this test looks once the child has exited.
describe("fileTempDir, seen from outside the file", () => {
  const run = promisify(execFile);
  async function fixture(name: string): Promise<Record<string, unknown>[]> {
    const notes = path.join(tempDir("tachi-helpers-fixture-"), "notes.jsonl");
    const vitest = path.resolve("node_modules/vitest/vitest.mjs");
    try {
      await run(process.execPath, [vitest, "run", "--config", "tests/fixtures/fixtures.config.ts", `tests/fixtures/${name}`], {
        env: { ...process.env, TACHI_FIXTURE_NOTES: notes },
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      throw new Error(`the fixture's run failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
    }
    return readFileSync(notes, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  for (const [where, name] of [
    ["at the top of the file", "top.fixture.ts"],
    ["in a describe's body", "describe.fixture.ts"],
    ["inside a beforeAll", "beforeAll.fixture.ts"],
  ] as const) {
    it(`keeps a folder made ${where} for the file's later tests, past its afterAll, and removes it after the file`, async () => {
      const notes = await fixture(name);
      const made = notes.flatMap((n) => (typeof n.made === "string" ? [n.made] : []));
      expect(made).toHaveLength(1);
      expect(notes).toEqual([{ made: made[0] }, { laterTest: "still there" }, { afterAll: "still there" }]);
      expect(existsSync(made[0]!)).toBe(false);
    });
  }
});

describe("the remover, at the root", () => {
  for (const kind of KINDS) {
    it.runIf(runs(kind))(`removes a root that is a ${kind} as a link only, leaving what is behind it`, async () => {
      const out = outside();
      const holder = tempDir("tachi-helpers-");
      const root = path.join(holder, "root");
      link(kind, out.dir, root);
      expect(await tryRemoveTree(root, NO_RETRY)).toEqual([]);
      expect(entry(holder, "root")).toBeUndefined();
      out.untouched();
    });
  }

  it("does nothing and says nothing for a root that is already gone", async () => {
    const root = path.join(tempDir("tachi-helpers-"), "never-made");
    expect(await tryRemoveTree(root, NO_RETRY)).toEqual([]);
    expect(await stderrOf(() => removeTree(root))).toEqual([]);
  });

  it("leaves a root that is a file untouched, given back as not a folder", async () => {
    const root = path.join(tempDir("tachi-helpers-"), "a-file");
    writeFileSync(root, "file");
    expect(await tryRemoveTree(root, NO_RETRY)).toEqual([{ path: root, reason: "not a folder" }]);
    expect(readFileSync(root, "utf8")).toBe("file");
  });

  it("lists the holder for neither look when told the root was listed as a folder, and reads inside it as before", async () => {
    const holder = tempDir("tachi-helpers-");
    const plain = path.join(holder, "plain");
    const given = path.join(holder, "given");
    for (const root of [plain, given]) {
      mkdirSync(path.join(root, "a"), { recursive: true });
      writeFileSync(path.join(root, "a", "f.txt"), "f");
    }
    listings.length = 0;
    expect(await tryRemoveTree(plain, NO_RETRY)).toEqual([]);
    expect(listings.filter((d) => d === holder)).toHaveLength(2);
    listings.length = 0;
    expect(await tryRemoveTree(given, { ...NO_RETRY, listedAsFolder: true })).toEqual([]);
    expect(listings.filter((d) => d === holder)).toEqual([]);
    expect(listings.filter((d) => d === given)).toHaveLength(2);
    expect(listings.filter((d) => d === path.join(given, "a"))).toHaveLength(1);
    expect(listed(holder)).toEqual([]);
  });
});

describe("the remover, a link inside", () => {
  for (const kind of KINDS) {
    it.runIf(runs(kind))(`removes a ${kind} at the top level and one folder down as links, never entering them`, async () => {
      const out = outside();
      const root = tempDir("tachi-helpers-");
      mkdirSync(path.join(root, "a"));
      writeFileSync(path.join(root, "a", "f.txt"), "f");
      writeFileSync(path.join(root, "g.txt"), "g");
      link(kind, out.dir, path.join(root, "top"));
      link(kind, out.dir, path.join(root, "a", "down"));
      expect(await tryRemoveTree(root, NO_RETRY)).toEqual([]);
      expect(existsSync(root)).toBe(false);
      out.untouched();
    });
  }
});

// A folder changed by another program while the remover works, through the remover's seam: root/a/b is changed at one
// of its two moments. root/c is where a stand-in program works when the retry is on, so that the first try is refused
// and later tries are made; the stand-in is stopped when the second try starts.
describe("the remover, a folder changed while it is being removed", () => {
  const MOMENTS: Moment[] = ["before its own listing", "before the second look"];
  function tree() {
    const root = tempDir("tachi-helpers-");
    const a = path.join(root, "a");
    const b = path.join(a, "b");
    const c = path.join(root, "c");
    mkdirSync(b, { recursive: true });
    mkdirSync(c);
    writeFileSync(path.join(b, "inner.txt"), "inner");
    writeFileSync(path.join(a, "side.txt"), "side");
    writeFileSync(path.join(root, "top.txt"), "top");
    const moved = tempDir("tachi-helpers-moved-");
    const kept = () => expect(readFileSync(path.join(moved, "b", "inner.txt"), "utf8")).toBe("inner");
    const left = [
      { path: b, reason: "changed while being removed" },
      { path: a, reason: "holds something that was left" },
      { path: root, reason: "holds something that was left" },
    ];
    return { root, a, b, c, moved, kept, left };
  }

  for (const moment of MOMENTS) {
    for (const retry of [false, true]) {
      // With the retry on, on Windows only: Mac and Linux let a folder be removed while a program works in it, so the
      // stand-in does not make the first try refused there.
      it.runIf(!retry || WINDOWS)(`leaves a folder replaced by a junction ${moment}, with the retry ${retry ? "on" : "off"}, and all above it`, async () => {
        const out = outside();
        const t = tree();
        const holder = retry ? await standIn(t.c) : undefined;
        if (holder) onTestFinished(() => stop(holder));
        let rootTries = 0;
        let swapped = false;
        const left = await tryRemoveTree(t.root, {
          ...(retry ? { pause: RETRY_PAUSE_MS, limit: RETRY_LIMIT_MS } : NO_RETRY),
          seam: async (at, folder) => {
            if (folder === t.root && at === "before its own listing" && ++rootTries === 2 && holder) await stop(holder);
            if (folder !== t.b || at !== moment || swapped) return;
            swapped = true;
            renameSync(t.b, path.join(t.moved, "b"));
            symlinkSync(out.dir, t.b, "junction");
          },
        });
        expect(sorted(left)).toEqual(sorted(t.left));
        expect(listed(t.root).map((e) => e.name)).toEqual(["a"]);
        expect(listed(t.a).map((e) => e.name)).toEqual(["b"]);
        expect(entry(t.a, "b")!.isSymbolicLink()).toBe(true);
        if (retry) expect(rootTries).toBeGreaterThan(1);
        out.untouched();
        t.kept();
      });
    }
  }

  for (const moment of MOMENTS) {
    for (const becomes of ["gone", "a file"] as const) {
      it(`gives back a folder that is ${becomes === "gone" ? "gone" : "a file"} ${moment} the same way, with no error`, async () => {
        const t = tree();
        let changed = false;
        const left = await tryRemoveTree(t.root, {
          ...NO_RETRY,
          seam: (at, folder) => {
            if (folder !== t.b || at !== moment || changed) return;
            changed = true;
            renameSync(t.b, path.join(t.moved, "b"));
            if (becomes === "a file") writeFileSync(t.b, "now a file");
          },
        });
        expect(sorted(left)).toEqual(sorted(t.left));
        expect(listed(t.root).map((e) => e.name)).toEqual(["a"]);
        expect(listed(t.a).map((e) => e.name)).toEqual(becomes === "gone" ? [] : ["b"]);
        if (becomes === "a file") expect(readFileSync(t.b, "utf8")).toBe("now a file");
        t.kept();
      });
    }
  }
});

describe("the remover and a program working in the folder", () => {
  it("removes the folder once the program has been killed, with no warning", async () => {
    const root = tempDir("tachi-helpers-");
    writeFileSync(path.join(root, "f.txt"), "f");
    const child = await standIn(root);
    child.kill();
    expect(await stderrOf(() => removeTree(root))).toEqual([]);
    expect(existsSync(root)).toBe(false);
  });

  it.runIf(WINDOWS)("does not throw for a folder that stays held, and writes exactly one line naming it", async () => {
    const root = tempDir("tachi-helpers-");
    const child = await standIn(root);
    onTestFinished(() => stop(child));
    const lines = await stderrOf(async () => warnLeft(await tryRemoveTree(root, NO_RETRY)));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(root);
    expect(lines[0]).toContain("EBUSY");
    expect(existsSync(root)).toBe(true);
  });
});
