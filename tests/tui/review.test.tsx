import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { render } from "ink-testing-library";
import { describe, expect, it, onTestFinished, type TestContext } from "vitest";
import { onPath } from "../../src/exec/env.js";
import { readKeybindings } from "../../src/keybindings.js";
import { type ApplyOptions, applyChange } from "../../src/sandbox/apply.js";
import { changes } from "../../src/sandbox/changes.js";
import type { Manifest } from "../../src/sandbox/snapshot.js";
import { Bindings, DEFAULTS, tableOf } from "../../src/tui/bindings.js";
import { diffOf, Review, type ReviewEnd } from "../../src/tui/Review.js";
import { removeTree, ZERO } from "../helpers.js";

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const tick = () => new Promise((r) => setTimeout(r, 50));

const DOWN = "\u001b[B";
const UP = "\u001b[A";
const ESC = "\u001b";
const CTRL_C = "\u0003";
const TOP = "Review the copy's changes: ";
const KEYS = "Space keep/skip · Enter diff · a apply · l later · d discard";

// The variables a test sets itself, so the user's own never reach git: as in tests/sandbox/apply.test.ts.
const OWN = /^(path|home|homedrive|homepath|userprofile|xdg_config_home|git_.*)$/i;

// A test's own folder, holding a project with `tree` in it and a copy of it as the snapshot leaves one (base/, work/ and
// manifest.json in the data folder's copies/s1/), made by hand as tests/sandbox/apply.test.ts makes it, so no data folder
// is made private; a folder outside the project for links to reach; and a home with empty git settings files for every
// git run. The test then changes work/ as the box would, and the project as the user would.
function world(tree: Record<string, string | Buffer>) {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "tachi-rvw-")));
  onTestFinished(() => removeTree(dir));
  const root = path.join(dir, "project");
  const data = path.join(dir, "data");
  const folder = path.join(data, "copies", "s1");
  const base = path.join(folder, "base");
  const work = path.join(folder, "work");
  const outside = path.join(dir, "elsewhere");
  const home = path.join(dir, "home");
  for (const f of [root, base, work, outside, home]) mkdirSync(f, { recursive: true });
  writeFileSync(path.join(outside, "kept.txt"), "made-up outside text\n");
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
  return {
    dir,
    root,
    data,
    folder,
    work,
    outside,
    env,
    at,
    manifest,
    // The manifest as the snapshot writes it last, once the test has set its left-out entries.
    save: () => writeFileSync(path.join(folder, "manifest.json"), JSON.stringify(manifest)),
    read: (rel: string) => readFileSync(at(rel), "utf8"),
    box: (rel: string, text: string | Buffer) => write(path.join(work, rel), text),
    user: (rel: string, text: string | Buffer) => write(at(rel), text),
  };
}
type World = ReturnType<typeof world>;

// A merge needs a git that runs, as in tests/sandbox/apply.test.ts: a test is skipped, with the reason, where there is
// none.
let gitRuns: string | undefined;
function needGit(t: TestContext, w: World) {
  if (gitRuns === undefined) {
    const exe = onPath("git", w.env);
    gitRuns = "";
    if (!exe) gitRuns = "no git on PATH";
    else {
      try {
        execFileSync(exe, ["--version"], { cwd: w.dir, env: w.env, stdio: "pipe", windowsHide: true });
      } catch {
        gitRuns = `git on PATH (${exe}) does not run`;
      }
    }
  }
  if (gitRuns) t.skip(gitRuns);
}

// The review of the world's copy, drawn in `height` rows, and how it ended once it has.
function open(w: World, opts: { height?: number; bindings?: Bindings; step?: ApplyOptions["step"]; remove?: (folder: string) => Promise<void> } = {}) {
  w.save();
  const ended: ReviewEnd[] = [];
  const app = render(
    <Review
      copy={{ session: "s1", folder: w.folder, manifest: w.manifest }}
      bindings={opts.bindings ?? new Bindings(tableOf(DEFAULTS))}
      height={opts.height ?? 20}
      onEnd={(end) => ended.push(end)}
      options={{ env: w.env, ...(opts.step ? { step: opts.step } : {}) }}
      {...(opts.remove ? { remove: opts.remove } : {})}
    />,
  );
  onTestFinished(() => app.unmount());
  return { app, ended };
}

async function until(app: ReturnType<typeof render>, text: string) {
  for (let i = 0; i < 100 && !app.lastFrame()?.includes(text); i++) await tick();
  expect(app.lastFrame()).toContain(text);
}

async function press(app: ReturnType<typeof render>, ...keys: string[]) {
  for (const k of keys) {
    app.stdin.write(k);
    await tick();
  }
}

// The frame's rows, each without the spaces after it.
const rowsOf = (app: ReturnType<typeof render>) => (app.lastFrame() ?? "").split("\n").map((r) => r.trimEnd());
// The frame's text without its blanks, for a line wrapped across rows.
const squash = (text: string) => text.replace(/\s+/g, "");
// The row that holds `text`.
const rowWith = (app: ReturnType<typeof render>, text: string) => rowsOf(app).find((r) => r.includes(text)) ?? "";

describe("Review's list", () => {
  it("lists each change with its choice, what was left out, and git-ignored changes as one count", async () => {
    const w = world({ "a.txt": "a\n", "c.txt": "c\n", ".gitignore": "build/\n", "build/out.js": "x\n", t: "file\n" });
    w.box("a.txt", "a changed\n");
    w.box("new.txt", "new\n");
    unlinkSync(path.join(w.work, "c.txt"));
    w.box("build/out.js", "rebuilt, longer\n");
    unlinkSync(path.join(w.work, "t"));
    mkdirSync(path.join(w.work, "t"));
    // The box's own repository, made at launch (choice 24), and a link the snapshot left out.
    w.box(".git/HEAD", "ref: refs/heads/main\n");
    w.manifest.leftOut.push({ path: "out", why: "a link that leads outside the project" });
    const { app } = open(w);
    await until(app, TOP);
    const rows = rowsOf(app);
    expect(rows[0]).toBe(`${TOP}4 files. ${KEYS}`);
    expect(rows).toContain("Left out, never applied: .git (Tachikoma's own and git's folders are never applied)");
    expect(rows).toContain("Left out, never applied: out (a link that leads outside the project)");
    expect(rows).toContain("1 change in paths git ignores: counted, never applied");
    expect(rowWith(app, "a.txt")).toMatch(/^changed +a\.txt +keep$/);
    expect(rowWith(app, "c.txt")).toMatch(/^deleted +c\.txt +keep$/);
    expect(rowWith(app, ".gitignore")).toBe("");
    expect(rowWith(app, "new.txt")).toMatch(/^added +new\.txt +keep$/);
    expect(rowWith(app, " t ")).toMatch(/^type +t +shown only$/);
    expect(rowWith(app, "out.js")).toBe("");
  });

  it("moves with Up and Down, and Space switches keep and skip, never a row shown only", async () => {
    const w = world({ "a.txt": "a\n", "b.txt": "b\n", t: "file\n" });
    w.box("a.txt", "a2\n");
    w.box("b.txt", "b2\n");
    unlinkSync(path.join(w.work, "t"));
    mkdirSync(path.join(w.work, "t"));
    const { app } = open(w);
    await until(app, TOP);
    await press(app, " ");
    expect(rowWith(app, "a.txt")).toMatch(/skip$/);
    await press(app, DOWN, " ");
    expect(rowWith(app, "b.txt")).toMatch(/skip$/);
    await press(app, " ", DOWN, " ", DOWN, DOWN, " ");
    expect(rowWith(app, "b.txt")).toMatch(/keep$/);
    expect(rowWith(app, " t ")).toMatch(/shown only$/);
    await press(app, UP, UP, " ");
    expect(rowWith(app, "a.txt")).toMatch(/keep$/);
  });

  it("keeps the row it is on in view on a small terminal", async () => {
    const w = world(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}.txt`, `${i}\n`])));
    for (let i = 0; i < 8; i++) w.box(`f${i}.txt`, `${i} changed\n`);
    const { app } = open(w, { height: 5 });
    await until(app, TOP);
    // The top line, then four rows of the list.
    const files = () => rowsOf(app).filter((r) => r.includes(".txt"));
    expect(rowsOf(app)).toHaveLength(5);
    expect(files().map((r) => r.match(/f\d/)![0])).toEqual(["f0", "f1", "f2", "f3"]);
    await press(app, DOWN, DOWN, DOWN, DOWN, DOWN, " ");
    expect(rowWith(app, "f5.txt")).toMatch(/skip$/);
    expect(files().map((r) => r.match(/f\d/)![0])).toEqual(["f2", "f3", "f4", "f5"]);
    await press(app, UP, UP, UP, UP);
    expect(files().map((r) => r.match(/f\d/)![0])).toEqual(["f1", "f2", "f3", "f4"]);
  });

  it("shows the box's text escaped, never as the terminal's codes", async () => {
    const w = world({ "a.txt": "a\n" });
    w.box("a.txt", "a\u001b]52;c;bWFkZS11cA==\u0007\n");
    w.manifest.leftOut.push({ path: "made\u001b[2Jup", why: "a link that leads nowhere" });
    const { app } = open(w);
    await until(app, TOP);
    expect(app.lastFrame()).toContain("Left out, never applied: made\\u001b[2Jup (a link that leads nowhere)");
    await press(app, "\r");
    await until(app, "+a\\u001b]52;c;bWFkZS11cA==\\u0007");
    for (const c of ["\u001b", "\u0007"]) expect(app.lastFrame()).not.toContain(c);
  });

  it("says in one line when the changes cannot be read, and can still leave the copy for later", async () => {
    const w = world({ "a.txt": "a\n" });
    await removeTree(w.work);
    const { app, ended } = open(w);
    await until(app, "The copy's changes could not be read: ENOENT");
    // One line, wrapped to the screen's width, and the keys on the row under it; no stack trace.
    expect(squash(app.lastFrame()!)).toMatch(/^Thecopy'schangescouldnotberead:ENOENT.*work'\.llater·ddiscard$/);
    expect(app.lastFrame()).not.toMatch(/^\s+at /m);
    expect(rowsOf(app).filter((r) => r).at(-1)).toBe("l later · d discard");
    await press(app, "l");
    expect(ended).toEqual([{ how: "later", outcomes: [], removed: false, lines: ["The copy is kept; tachi review s1 opens it again."] }]);
  });

  it("leaves out the paths an earlier apply of the same copy applied", async () => {
    const w = world({ "a.txt": "a\n", "b.txt": "b\n" });
    w.box("a.txt", "a2\n");
    w.box("b.txt", "b2\n");
    w.save();
    const found = (await changes(w.manifest, w.work)).changes.find((c) => c.path === "a.txt")!;
    const ctx = { root: w.root, base: path.join(w.folder, "base"), work: w.work, manifest: w.manifest, session: "s1" };
    expect(await applyChange(found, ctx)).toEqual({ path: "a.txt", result: "applied" });
    const { app } = open(w);
    await until(app, TOP);
    expect(rowsOf(app)[0]).toBe(`${TOP}1 file. ${KEYS}`);
    expect(rowWith(app, "a.txt")).toBe("");
    expect(rowWith(app, "b.txt")).toMatch(/^changed +b\.txt +keep$/);
  });
});

describe("Review's diff", () => {
  it("opens a file's diff in the detail view, and Esc comes back", async () => {
    const w = world({ "a.txt": "one\ntwo\n" });
    w.box("a.txt", "one\nTWO\n");
    const { app } = open(w);
    await until(app, TOP);
    await press(app, "\r");
    await until(app, "@@ -1,2 +1,2 @@");
    const rows = rowsOf(app);
    expect(rows.slice(0, 5)).toEqual(["changed a.txt", "@@ -1,2 +1,2 @@", " one", "-two", "+TWO"]);
    expect(app.lastFrame()).not.toContain(TOP);
    await press(app, ESC);
    await until(app, TOP);
    expect(app.lastFrame()).not.toContain("@@");
  });

  it("shows a path whose type changed as what it was and is, since it is applied by hand", async () => {
    const w = world({ t: "file\n" });
    unlinkSync(path.join(w.work, "t"));
    mkdirSync(path.join(w.work, "t"));
    const { app } = open(w);
    await until(app, TOP);
    await press(app, "\r");
    await until(app, "before: file");
    expect(rowsOf(app).slice(0, 4)).toEqual(["type t", "before: file", "after: folder", "a path whose type changed is applied by hand"]);
  });

  it("checks each file's size against Node's longest string before reading it", async () => {
    const w = world({ "a.txt": "one\n" });
    w.box("a.txt", "one\ntwo\n");
    w.save();
    const c = (await changes(w.manifest, w.work)).changes[0]!;
    expect(await diffOf(c, w.folder, 4)).toEqual([{ text: "too large to show: 4 bytes before, 8 after" }]);
    expect(await diffOf(c, w.folder, 8)).toEqual([
      { text: "@@ -1 +1,2 @@", color: "cyan" },
      { text: " one" },
      { text: "+two", color: "green" },
    ]);
  });
});

describe("Review's apply", () => {
  it("applies what is kept, and shows an outcome of each kind, one file's failure not stopping the rest", async () => {
    const w = world({ "apply.txt": "1\n", "bin.dat": `b${ZERO}`, "fail.txt": "f\n", "skip.txt": "s\n", "sub/x.txt": "x\n", "zlast.txt": "z\n" });
    for (const rel of ["apply.txt", "fail.txt", "skip.txt", "sub/x.txt", "zlast.txt"]) w.box(rel, "from the box\n");
    w.box("bin.dat", `c${ZERO}`);
    w.user("bin.dat", `u${ZERO}`); // a binary file the user changed too: never merged, so never asked
    // The user's sub is now a junction to a folder outside: nothing is written through it.
    unlinkSync(w.at("sub/x.txt"));
    rmdirSync(w.at("sub"));
    symlinkSync(w.outside, w.at("sub"), "junction");
    // A disk error at fail.txt, the second file to reach its replacement (apply.txt is the first).
    let checked = 0;
    const step = (at: string) => {
      if (at === "checked" && ++checked === 2) throw new Error("made-up disk failure");
    };
    const { app, ended } = open(w, { step });
    await until(app, TOP);
    await press(app, DOWN, DOWN, DOWN, " ", "a");
    await until(app, "Any key closes.");
    expect(rowsOf(app)[0]).toBe("2 applied, 1 skipped, 3 left in the copy");
    expect(rowWith(app, "apply.txt")).toMatch(/^changed +apply\.txt +applied$/);
    expect(rowWith(app, "bin.dat")).toMatch(/^changed +bin\.dat +conflict: a binary file; resolve it by hand$/);
    expect(rowWith(app, "fail.txt")).toMatch(/^changed +fail\.txt +failed: made-up disk failure$/);
    expect(rowWith(app, "skip.txt")).toMatch(/^changed +skip\.txt +skipped$/);
    expect(rowWith(app, "sub/x.txt")).toMatch(/^changed +sub\/x\.txt +not applied: sub is a link, and apply never writes through one$/);
    expect(rowWith(app, "zlast.txt")).toMatch(/^changed +zlast\.txt +applied$/);
    expect(rowWith(app, "The copy is kept")).toBe("The copy is kept; tachi review s1 opens it again. Any key closes.");
    expect([w.read("apply.txt"), w.read("fail.txt"), w.read("skip.txt"), w.read("zlast.txt")]).toEqual(["from the box\n", "f\n", "s\n", "from the box\n"]);
    expect(readFileSync(path.join(w.outside, "kept.txt"), "utf8")).toBe("made-up outside text\n");
    expect(readdirSync(w.outside)).toEqual(["kept.txt"]);
    expect(ended).toEqual([]);
    await press(app, "x");
    expect(ended).toHaveLength(1);
    expect(ended[0]!.how).toBe("applied");
    expect(ended[0]!.removed).toBe(false);
    expect(ended[0]!.lines).toEqual(["2 applied, 1 skipped, 3 left in the copy", "The copy is kept; tachi review s1 opens it again."]);
    expect(ended[0]!.outcomes.map((o) => [o.path, o.result])).toEqual([
      ["apply.txt", "applied"],
      ["bin.dat", "conflict"],
      ["fail.txt", "failed"],
      ["skip.txt", "skipped"],
      ["sub/x.txt", "refused"],
      ["zlast.txt", "applied"],
    ]);
    expect(existsSync(w.folder)).toBe(true);
  });

  it("asks at each conflict: m merges, cleanly or with markers, and s skips; with nothing left the copy is removed", async (t) => {
    const w = world({ "c.txt": "same\n", "m.txt": "one\ntwo\nthree\n", "s.txt": "s\n" });
    needGit(t, w);
    w.box("c.txt", "the box's\n");
    w.user("c.txt", "the user's\n");
    w.box("m.txt", "ONE\ntwo\nthree\n");
    w.user("m.txt", "one\ntwo\nTHREE\n");
    w.box("s.txt", "s box\n");
    w.user("s.txt", "s user\n");
    const { app, ended } = open(w);
    await until(app, TOP);
    await press(app, "a");
    await until(app, "c.txt changed in your folder since the copy was made. m to merge, s to skip");
    expect(rowWith(app, "c.txt  ")).toMatch(/conflict$/);
    await press(app, "m");
    await until(app, "m.txt changed in your folder since the copy was made. m to merge, s to skip");
    await press(app, "m");
    await until(app, "s.txt changed in your folder since the copy was made. m to merge, s to skip");
    await press(app, "s");
    await until(app, "Any key closes.");
    expect(rowsOf(app)[0]).toBe("1 applied, 1 skipped, 1 merged with conflicts in c.txt.tachikoma-merge");
    expect(rowWith(app, "c.txt ")).toMatch(/merged with conflicts in c\.txt\.tachikoma-merge$/);
    expect(rowWith(app, "m.txt")).toMatch(/applied$/);
    expect(rowWith(app, "s.txt")).toMatch(/skipped$/);
    expect(rowWith(app, "The copy was removed.")).toBe("The copy was removed. Any key closes.");
    expect(w.read("m.txt")).toBe("ONE\ntwo\nTHREE\n");
    expect(w.read("s.txt")).toBe("s user\n");
    expect(w.read("c.txt")).toBe("the user's\n");
    expect(w.read("c.txt.tachikoma-merge")).toContain("the box's");
    expect(existsSync(w.folder)).toBe(false);
    await press(app, "\r");
    expect(ended.map((e) => [e.how, e.removed])).toEqual([["applied", true]]);
  });

  it("applies deletes first, so a case-only rename keeps the file under its new name", async () => {
    const w = world({ "Readme.md": "old\n" });
    unlinkSync(path.join(w.work, "Readme.md"));
    w.box("README.md", "new\n");
    const { app } = open(w);
    await until(app, TOP);
    expect(rowsOf(app)[0]).toBe(`${TOP}2 files. ${KEYS}`);
    await press(app, "a");
    await until(app, "Any key closes.");
    expect(rowsOf(app)[0]).toBe("2 applied, 0 skipped");
    expect(readdirSync(w.root).filter((n) => n !== ".tachikoma")).toEqual(["README.md"]);
    expect(w.read("README.md")).toBe("new\n");
    // The old file is in its backup.
    expect(readFileSync(path.join(w.root, ".tachikoma", "backups", "s1", "Readme.md"), "utf8")).toBe("old\n");
  });
});

describe("Review's later and discard", () => {
  it("leaves the copy for later on l, and on Ctrl-C", async () => {
    for (const key of ["l", CTRL_C]) {
      const w = world({ "a.txt": "a\n" });
      w.box("a.txt", "a2\n");
      const { app, ended } = open(w);
      await until(app, TOP);
      await press(app, key);
      expect(ended).toEqual([{ how: "later", outcomes: [], removed: false, lines: ["The copy is kept; tachi review s1 opens it again."] }]);
      expect(existsSync(path.join(w.folder, "manifest.json"))).toBe(true);
    }
  });

  it("asks before discarding, and removes the copy whole without following a link the box made", async () => {
    const w = world({ "a.txt": "a\n" });
    w.box("a.txt", "a2\n");
    symlinkSync(w.outside, path.join(w.work, "out"), "junction");
    const { app, ended } = open(w);
    await until(app, TOP);
    await press(app, "d");
    await until(app, "Discard the copy and every change in it? [y/n]");
    await press(app, "n");
    await until(app, TOP);
    expect(app.lastFrame()).not.toContain("Discard");
    await press(app, "d", "y");
    for (let i = 0; i < 40 && !ended.length; i++) await tick();
    expect(ended).toEqual([{ how: "discarded", outcomes: [], removed: true, lines: ["The copy was discarded."] }]);
    expect(existsSync(w.folder)).toBe(false);
    expect(readdirSync(w.outside)).toEqual(["kept.txt"]);
    expect(w.read("a.txt")).toBe("a\n");
  });

  it("keeps the copy and says so in one line when it cannot be removed", async () => {
    const w = world({ "a.txt": "a\n" });
    w.box("a.txt", "a2\n");
    const { app, ended } = open(w, {
      remove: async () => {
        throw new Error("made-up removal failure");
      },
    });
    await until(app, TOP);
    await press(app, "d", "y");
    const line = `The copy could not be removed (made-up removal failure); delete ${w.folder} by hand.`;
    await until(app, "Any key closes.");
    expect(squash(app.lastFrame()!)).toContain(squash(`${line} Any key closes.`));
    await press(app, "q");
    expect(ended).toEqual([{ how: "discarded", outcomes: [], removed: false, lines: [line] }]);
  });
});

describe("Review's keys", () => {
  it("are read from the keys file's Review context, and the top line names them", async () => {
    const read = readKeybindings(JSON.stringify({ bindings: [{ context: "Review", bindings: { x: "review:apply", a: null, j: "review:next" } }] }));
    if (!("table" in read)) throw new Error(read.problem);
    expect(read.problems).toEqual([]);
    const w = world({ "a.txt": "a\n", "b.txt": "b\n" });
    w.box("a.txt", "a2\n");
    w.box("b.txt", "b2\n");
    const { app } = open(w, { bindings: read.table });
    await until(app, TOP);
    expect(rowsOf(app)[0]).toBe(`${TOP}2 files. Space keep/skip · Enter diff · x apply · l later · d discard`);
    await press(app, "j", " ", "a");
    expect(rowWith(app, "b.txt")).toMatch(/skip$/);
    expect(app.lastFrame()).not.toContain("applied");
    await press(app, "x");
    await until(app, "Any key closes.");
    expect(w.read("a.txt")).toBe("a2\n");
    expect(w.read("b.txt")).toBe("b\n");
  });
});
