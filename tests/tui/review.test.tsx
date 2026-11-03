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
import type { Protection } from "../../src/core/permissions.js";
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
// Each test's time: up to 2.7 s here alone, so room for a loaded machine, as tests/tui/terminal.test.tsx gives its own.
const SLOW = { timeout: 15_000 };

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
type Opts = { height?: number; bindings?: Bindings; step?: ApplyOptions["step"]; remove?: (folder: string) => Promise<void>; protection?: Protection };
function open(w: World, opts: Opts = {}) {
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
      protection={opts.protection ?? { hooks: [], files: [] }}
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
// Wait until the screen says `text`, perhaps wrapped across rows.
async function untilSaid(app: ReturnType<typeof render>, text: string) {
  for (let i = 0; i < 100 && !squash(app.lastFrame() ?? "").includes(squash(text)); i++) await tick();
  expect(squash(app.lastFrame() ?? "")).toContain(squash(text));
}
// The row that holds `text`.
const rowWith = (app: ReturnType<typeof render>, text: string) => rowsOf(app).find((r) => r.includes(text)) ?? "";

describe("Review's list", SLOW, () => {
  it("lists each change with its choice, what was left out, and git-ignored changes as one count", async () => {
    const w = world({ "a.txt": "a\n", "c.txt": "c\n", ".gitignore": "build/\n", "build/out.js": "x\n", t: "file\n" });
    w.box("a.txt", "a changed\n");
    w.box("new.txt", "new\n");
    unlinkSync(path.join(w.work, "c.txt"));
    w.box("build/out.js", "rebuilt, longer\n");
    unlinkSync(path.join(w.work, "t"));
    mkdirSync(path.join(w.work, "t"));
    // The box's own repository, made at launch (choice 24), which is not listed (choice 114); a nested one and a
    // .tachikoma the box made, which are; and a link the snapshot left out.
    w.box(".git/HEAD", "ref: refs/heads/main\n");
    w.box("sub/.git/HEAD", "ref: refs/heads/main\n");
    w.box(".tachikoma/made-up.txt", "x\n");
    w.manifest.leftOut.push({ path: "out", why: "a link that leads outside the project" });
    const { app } = open(w);
    await until(app, TOP);
    const rows = rowsOf(app);
    expect(rows[0]).toBe(`${TOP}4 files. ${KEYS}`);
    expect(rows.filter((r) => r.startsWith("Left out"))).toEqual([
      "Left out, never applied: out (a link that leads outside the project)",
      "Left out, never applied: .tachikoma (Tachikoma's own and git's folders are never applied)",
      "Left out, never applied: sub/.git (Tachikoma's own and git's folders are never applied)",
    ]);
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

describe("Review's diff", SLOW, () => {
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

  it("shows a link's target on one line, a line break in it escaped", async () => {
    const w = world({ "a.txt": "a\n" });
    // A link the snapshot kept, which the box removed: its target as the project stored it (made up here).
    w.manifest.entries["made\nup"] = { type: "link", target: "some\nwhere", inCopy: "some\nwhere" };
    const { app } = open(w);
    await until(app, TOP);
    expect(rowWith(app, "made⏎up")).toMatch(/^link +made⏎up +shown only$/);
    await press(app, "\r");
    await until(app, "before: some⏎where");
    expect(rowsOf(app).slice(0, 4)).toEqual(["link made⏎up", "before: some⏎where", "after: (none)", "links are applied by hand"]);
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

describe("Review's apply", SLOW, () => {
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
    await until(app, "Up/Down scroll · any other key closes");
    expect(rowsOf(app)[0]).toBe("2 applied, 1 skipped, 3 left in the copy");
    expect(rowWith(app, "apply.txt")).toMatch(/^changed +apply\.txt +applied$/);
    expect(rowWith(app, "bin.dat")).toMatch(/^changed +bin\.dat +conflict: a binary file; resolve it by hand$/);
    expect(rowWith(app, "fail.txt")).toMatch(/^changed +fail\.txt +failed: made-up disk failure$/);
    expect(rowWith(app, "skip.txt")).toMatch(/^changed +skip\.txt +skipped$/);
    expect(rowWith(app, "sub/x.txt")).toMatch(/^changed +sub\/x\.txt +not applied: sub is a link, and apply never writes through one$/);
    expect(rowWith(app, "zlast.txt")).toMatch(/^changed +zlast\.txt +applied$/);
    expect(rowWith(app, "The copy is kept")).toBe("The copy is kept; tachi review s1 opens it again. Up/Down scroll · any other key closes");
    expect([w.read("apply.txt"), w.read("fail.txt"), w.read("skip.txt"), w.read("zlast.txt")]).toEqual(["from the box\n", "f\n", "s\n", "from the box\n"]);
    expect(readFileSync(path.join(w.outside, "kept.txt"), "utf8")).toBe("made-up outside text\n");
    expect(readdirSync(w.outside)).toEqual(["kept.txt"]);
    expect(ended).toEqual([]);
    await press(app, "x");
    expect(ended).toHaveLength(1);
    expect(ended[0]!.how).toBe("applied");
    expect(ended[0]!.removed).toBe(false);
    // Each outcome neither applied nor skipped as its row says it, for the caller to say again.
    expect(ended[0]!.lines).toEqual([
      "2 applied, 1 skipped, 3 left in the copy",
      "changed bin.dat conflict: a binary file; resolve it by hand",
      "changed fail.txt failed: made-up disk failure",
      "changed sub/x.txt not applied: sub is a link, and apply never writes through one",
      "The copy is kept; tachi review s1 opens it again.",
    ]);
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
    await until(app, "Up/Down scroll · any other key closes");
    expect(rowsOf(app)[0]).toBe("1 applied, 1 skipped, 1 merged with conflicts in c.txt.tachikoma-merge");
    expect(rowWith(app, "c.txt ")).toMatch(/merged with conflicts in c\.txt\.tachikoma-merge$/);
    expect(rowWith(app, "m.txt")).toMatch(/applied$/);
    expect(rowWith(app, "s.txt")).toMatch(/skipped$/);
    expect(rowWith(app, "The copy was removed.")).toBe("The copy was removed. Up/Down scroll · any other key closes");
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
    await until(app, "Up/Down scroll · any other key closes");
    expect(rowsOf(app)[0]).toBe("2 applied, 0 skipped");
    expect(readdirSync(w.root).filter((n) => n !== ".tachikoma")).toEqual(["README.md"]);
    expect(w.read("README.md")).toBe("new\n");
    // The old file is in its backup.
    expect(readFileSync(path.join(w.root, ".tachikoma", "backups", "s1", "Readme.md"), "utf8")).toBe("old\n");
  });

  it("stops asking on Ctrl-C at a conflict, keeping that change and every one not yet applied in the copy", async () => {
    const w = world({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
    w.box("a.txt", "a box\n");
    w.box("b.txt", "b box\n");
    w.user("b.txt", "b user\n");
    w.box("c.txt", "c box\n");
    const { app, ended } = open(w);
    await until(app, TOP);
    await press(app, "a");
    await until(app, "b.txt changed in your folder since the copy was made. m to merge, s to skip");
    await press(app, CTRL_C);
    await until(app, "Up/Down scroll · any other key closes");
    expect(rowsOf(app)[0]).toBe("1 applied, 0 skipped, 2 left in the copy");
    expect(rowWith(app, "b.txt")).toMatch(/conflict: changed in your folder since the copy was made$/);
    expect(rowWith(app, "c.txt")).toMatch(/keep$/);
    expect(rowWith(app, "The copy is kept")).toBe("The copy is kept; tachi review s1 opens it again. Up/Down scroll · any other key closes");
    expect([w.read("a.txt"), w.read("b.txt"), w.read("c.txt")]).toEqual(["a box\n", "b user\n", "c\n"]);
    expect(existsSync(path.join(w.folder, "manifest.json"))).toBe(true);
    await press(app, "x");
    expect(ended[0]!.removed).toBe(false);
    expect(ended[0]!.outcomes.map((o) => [o.path, o.result])).toEqual([
      ["a.txt", "applied"],
      ["b.txt", "conflict"],
    ]);
  });

  it("never offers to merge a delete the user's file conflicts with", async () => {
    const w = world({ "d.txt": "d\n" });
    unlinkSync(path.join(w.work, "d.txt"));
    w.user("d.txt", "the user's own\n");
    const { app } = open(w);
    await until(app, TOP);
    await press(app, "a");
    await until(app, "Up/Down scroll · any other key closes");
    expect(app.lastFrame()).not.toContain("to merge");
    expect(rowWith(app, "d.txt")).toMatch(/^deleted +d\.txt +conflict: deleted on one side, or no longer a file; resolve it by hand$/);
    expect(rowsOf(app)[0]).toBe("0 applied, 0 skipped, 1 left in the copy");
    expect(w.read("d.txt")).toBe("the user's own\n");
  });

  it("applies once for two presses of its key read together", async () => {
    const w = world({ "a.txt": "a\n" });
    w.box("a.txt", "a2\n");
    const steps: string[] = [];
    const { app } = open(w, { step: (at) => void steps.push(at) });
    await until(app, TOP);
    app.stdin.write("aa");
    await until(app, "Up/Down scroll · any other key closes");
    expect(rowsOf(app)[0]).toBe("1 applied, 0 skipped");
    expect(steps).toEqual(["checked", "written", "rename", "done"]);
  });

  it("takes no key but a conflict's answer while it applies, and lets Up and Down scroll what came of it", async () => {
    const w = world({ "a.txt": "a\n", "b.txt": "b\n" });
    w.box("a.txt", "a2\n");
    w.box("b.txt", "b2\n");
    let let_go = () => {};
    const held = new Promise<void>((resolve) => (let_go = resolve));
    const { app, ended } = open(w, { height: 3, step: (at) => (at === "checked" ? held : undefined) });
    await until(app, TOP);
    await press(app, "a");
    await until(app, "Applying...");
    expect(rowsOf(app)[0]).toBe(`${TOP}2 files.`);
    await press(app, "\u001b[B", " ", "d", "l", CTRL_C, "\r");
    expect(app.lastFrame()).not.toContain("Discard");
    expect(ended).toEqual([]);
    let_go();
    await until(app, "Up/Down scroll · any other key closes");
    expect(rowsOf(app)[0]).toBe("2 applied, 0 skipped");
    // Three rows: the summary, one of the list, and the copy's line.
    expect(rowWith(app, "b.txt")).toMatch(/applied$/);
    await press(app, UP);
    expect(rowWith(app, "a.txt")).toMatch(/applied$/);
    expect(ended).toEqual([]);
    await press(app, "x");
    expect(ended).toHaveLength(1);
  });

  it("gives back its lines and outcomes escaped, for the caller to print as they are", async () => {
    const odd = "made‮up.txt"; // a direction override, which every system allows in a name
    const w = world({ [odd]: "a\n" });
    w.box(odd, "a box\n");
    const { app, ended } = open(w, {
      remove: async () => {
        throw new Error("made-up\u001b[2Jfailure");
      },
    });
    await until(app, TOP);
    await press(app, "a");
    await untilSaid(app, "Up/Down scroll · any other key closes");
    await press(app, "x");
    expect(ended).toEqual([
      {
        how: "applied",
        outcomes: [{ path: "made\\u202eup.txt", result: "applied" }],
        removed: false,
        lines: ["1 applied, 0 skipped", `The copy could not be removed (made-up\\u001b[2Jfailure); delete ${w.folder} by hand.`],
      },
    ]);
  });
});

describe("Review's protected files", SLOW, () => {
  it("starts a change to a protected file as skip, marked, and applies it once switched to keep", async () => {
    const w = world({ ".npmrc": "a\n", "web/.husky/pre-commit": "h\n", ".githooks/pre-push": "p\n", "plain.txt": "x\n" });
    for (const rel of [".npmrc", "web/.husky/pre-commit", ".githooks/pre-push", "plain.txt"]) w.box(rel, "from the box\n");
    // A hooks folder git's settings name (core.hooksPath=.githooks), a host path as protectionOf gives it (clilib.ts).
    const { app } = open(w, { protection: { hooks: [w.at(".githooks")], files: [] } });
    await until(app, TOP);
    expect(rowWith(app, ".npmrc")).toMatch(/^changed +\.npmrc +skip \(protected\)$/);
    expect(rowWith(app, "pre-commit")).toMatch(/^changed +web\/\.husky\/pre-commit +skip \(protected\)$/);
    expect(rowWith(app, "pre-push")).toMatch(/^changed +\.githooks\/pre-push +skip \(protected\)$/);
    expect(rowWith(app, "plain.txt")).toMatch(/^changed +plain\.txt +keep$/);
    // .githooks/pre-push, then .npmrc: switched to keep.
    await press(app, DOWN, " ");
    expect(rowWith(app, ".npmrc")).toMatch(/keep \(protected\)$/);
    await press(app, "a");
    await until(app, "Up/Down scroll · any other key closes");
    expect(rowsOf(app)[0]).toBe("2 applied, 2 skipped");
    expect([w.read(".npmrc"), w.read("plain.txt"), w.read("web/.husky/pre-commit"), w.read(".githooks/pre-push")]).toEqual([
      "from the box\n",
      "from the box\n",
      "h\n",
      "p\n",
    ]);
  });
});

describe("Review's later and discard", SLOW, () => {
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
    for (let i = 0; i < 100 && !ended.length; i++) await tick();
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
    await untilSaid(app, "Up/Down scroll · any other key closes");
    expect(squash(app.lastFrame()!)).toContain(squash(`${line} Up/Down scroll · any other key closes`));
    await press(app, "q");
    expect(ended).toEqual([{ how: "discarded", outcomes: [], removed: false, lines: [line] }]);
  });

  it("asks the discard question opened in one read without the rest of that read answering it", async () => {
    const w = world({ "a.txt": "a\n" });
    w.box("a.txt", "a2\n");
    const { app, ended } = open(w);
    await until(app, TOP);
    app.stdin.write("dy"); // as a paste of "dy" comes
    await until(app, "Discard the copy and every change in it? [y/n]");
    await tick();
    expect(ended).toEqual([]);
    expect(existsSync(path.join(w.folder, "manifest.json"))).toBe(true);
  });

  it("says it is removing the copy, with the manifest's count of files, while it does", async () => {
    const w = world({ "a.txt": "a\n", "b.txt": "b\n" });
    w.box("a.txt", "a2\n");
    let let_go = () => {};
    const { app, ended } = open(w, { remove: () => new Promise<void>((resolve) => (let_go = resolve)) });
    await until(app, TOP);
    await press(app, "d", "y");
    await until(app, "Removing the copy (2 files)...");
    // Only the count; the keys act at the list alone.
    expect(rowsOf(app)[0]).toBe(`${TOP}1 file.`);
    let_go();
    for (let i = 0; i < 100 && !ended.length; i++) await tick();
    expect(ended.map((e) => e.how)).toEqual(["discarded"]);
  });
});

describe("Review's keys", SLOW, () => {
  it("are read from the keys file's Review context, and the top line names them", async () => {
    const read = readKeybindings(JSON.stringify({ bindings: [{ context: "Review", bindings: { x: "review:apply", a: null, j: "review:next", down: null } }] }));
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
    await until(app, "Up/j scroll · any other key closes");
    expect(w.read("a.txt")).toBe("a2\n");
    expect(w.read("b.txt")).toBe("b\n");
  });
});
