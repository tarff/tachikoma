import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { dropOnExit } from "../../src/clilib.js";
import type { DockerRun } from "../../src/sandbox/docker.js";
import { toReview } from "../../src/sandbox/apply.js";
import { boxCheck, dropIfNothing, type ReviewIo, reviewCommand } from "../../src/sandbox/copies.js";
import type { Manifest } from "../../src/sandbox/snapshot.js";
import type { ReviewEnd } from "../../src/tui/Review.js";
import { removeTree } from "../helpers.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const ok = (out = "") => ({ code: 0, out, err: "" });
const BUSY = (name: string) => `The copy ${name} is still in use by a running Tachikoma session; review it after that session ends.`;
const ASKED = "Discard the copy and every change in it? [y/n]";

// A test's own data folder, with copies made by hand as the snapshot leaves them (base/, work/, manifest.json in
// copies/<name>/), as tests/tui/review.test.tsx makes one, so no folder is made private; and a project per copy.
function world() {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "tachi-copies-")));
  onTestFinished(() => removeTree(dir));
  const data = path.join(dir, "data");
  mkdirSync(path.join(data, "copies"), { recursive: true });
  // A copy named `name` of a project holding `tree`, made at `at`, by the session process `pid`; `changed` is what the
  // box wrote in work/ since.
  const copy = (name: string, tree: Record<string, string>, opts: { at?: string; pid?: number; changed?: Record<string, string> } = {}) => {
    const root = path.join(dir, `project-${name}`);
    const folder = path.join(data, "copies", name);
    const manifest: Manifest = { session: name, pid: opts.pid ?? 0, root, at: opts.at ?? new Date().toISOString(), entries: Object.create(null), leftOut: [] };
    for (const where of [root, path.join(folder, "base"), path.join(folder, "work")]) mkdirSync(where, { recursive: true });
    for (const [rel, text] of Object.entries(tree)) {
      for (const where of [root, path.join(folder, "base"), path.join(folder, "work")]) writeFileSync(path.join(where, rel), text);
      const st = lstatSync(path.join(folder, "work", rel));
      manifest.entries[rel] = { type: "file", sha256: sha(text), exec: false, size: st.size, mtimeMs: st.mtimeMs };
    }
    for (const [rel, text] of Object.entries(opts.changed ?? {})) writeFileSync(path.join(folder, "work", rel), text);
    writeFileSync(path.join(folder, "manifest.json"), JSON.stringify(manifest));
    return { root, folder, manifest };
  };
  return { dir, data, copy };
}

// What the command said, and the copies it opened; `answer` is the discard question's, undefined for no terminal.
// Docker is a stand-in that has no box unless the test gives one, and git's settings read as none.
function io(data: string, opts: { answer?: boolean; run?: DockerRun; terminal?: boolean; gitFails?: boolean } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const opened: string[] = [];
  const terminal = opts.terminal ?? opts.answer !== undefined;
  const given: ReviewIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    data,
    run: opts.run ?? (async () => ok()),
    gitSettings: async () => {
      if (opts.gitFails) throw new Error("git was ended by SIGKILL");
      return undefined;
    },
    ...(terminal
      ? {
          ask: async (q: string) => (asked.push(q), opts.answer === true),
          open: async (copy): Promise<ReviewEnd> => {
            opened.push(copy.session);
            return { how: "later", outcomes: [], removed: false, lines: [`The copy is kept; tachi review ${copy.session} opens it again.`] };
          },
        }
      : {}),
  };
  return { io: given, out, err, asked, opened };
}

// A pid no process has: a child that has exited.
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise((resolve) => child.on("exit", resolve));
  return pid;
}

// A stand-in for a running session's process: a sleeping node the test kills by its own pid at the end.
function liveSession(): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
  onTestFinished(() => void child.kill());
  return child.pid!;
}

// A stand-in Docker holding the boxes `boxes` (id: running?) of the session given, removed by `rm -f` unless `stuck`.
function dockerWith(boxes: Record<string, boolean>, stuck = false) {
  const calls: string[][] = [];
  const run: DockerRun = async (args) => {
    calls.push(args);
    const ids = Object.keys(boxes);
    if (args[0] === "ps") return ok(ids.filter((id) => args.includes("-a") || boxes[id]).map((id) => `${id}\n`).join(""));
    if (args[0] === "rm" && !stuck) for (const id of args.slice(2)) delete boxes[id];
    return ok();
  };
  return { run, calls };
}

const when = (iso: string) => {
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

describe("tachi review's list", () => {
  it("says when no copies are waiting, with no copies folder and with an empty one", async () => {
    const w = world();
    for (const data of [w.data, path.join(w.dir, "never-made")]) {
      const r = io(data);
      expect(await reviewCommand([], r.io)).toBe(0);
      expect(r.out).toEqual(["No copies are waiting."]);
    }
  });

  it("lists each copy, oldest first, with its project folder, when it was made and its changes, leaving out a half-made one and the locks", async () => {
    const w = world();
    const later = w.copy("s-later", { "a.txt": "made-up a\n", "b.txt": "made-up b\n" }, { at: "2026-11-05T03:04:00.000Z", changed: { "a.txt": "edited\n", "c.txt": "new\n" } });
    const earlier = w.copy("s-earlier", { "a.txt": "made-up a\n" }, { at: "2026-11-04T01:02:00.000Z" });
    mkdirSync(path.join(w.data, "copies", "s-half", "work"), { recursive: true }); // a snapshot stopped before its manifest
    mkdirSync(path.join(w.data, "copies", "s-bad"));
    writeFileSync(path.join(w.data, "copies", "s-bad", "manifest.json"), "{ not json");
    writeFileSync(path.join(w.data, "copies", "s-later.lock"), "1"); // a lock beside a copy (snapshot.ts, copyLock)
    const r = io(w.data);
    expect(await reviewCommand([], r.io)).toBe(0);
    expect(r.out).toEqual([
      "Copies waiting for review (tachi review <name> opens one):",
      `  s-earlier  ${earlier.root}  ${when(earlier.manifest.at)}  0 changes`,
      `  s-later  ${later.root}  ${when(later.manifest.at)}  2 changes`,
    ]);
  });

  it("lists a crash's copy, whose session process is gone, and counts one change as one", async () => {
    const w = world();
    const c = w.copy("s-crash", { "a.txt": "made-up a\n" }, { pid: await deadPid(), changed: { "a.txt": "edited\n" } });
    const r = io(w.data);
    expect(await reviewCommand([], r.io)).toBe(0);
    expect(r.out[1]).toBe(`  s-crash  ${c.root}  ${when(c.manifest.at)}  1 change`);
  });

  it("leaves out the changes an earlier apply applied, as the review does", async () => {
    const w = world();
    const c = w.copy("s1", { "a.txt": "made-up a\n" }, { changed: { "a.txt": "edited\n", "b.txt": "new\n" } });
    writeFileSync(path.join(c.folder, "applied.jsonl"), `${JSON.stringify({ path: "b.txt", state: "pending", before: "", after: sha("new\n") })}\n${JSON.stringify({ path: "b.txt", state: "done" })}\n`);
    const r = io(w.data);
    await reviewCommand([], r.io);
    expect(r.out[1]).toMatch(/ 1 change$/);
  });

  it("says when a copy's changes cannot be read, and lists the next copy", async () => {
    const w = world();
    const broken = w.copy("s-a", { "a.txt": "made-up a\n" }, { at: "2026-11-04T01:02:00.000Z" });
    const next = w.copy("s-b", { "a.txt": "made-up a\n" }, { at: "2026-11-05T01:02:00.000Z" });
    await removeTree(path.join(broken.folder, "work"));
    const r = io(w.data);
    expect(await reviewCommand([], r.io)).toBe(0);
    expect(r.out[1]).toMatch(new RegExp(`^  s-a  .+  changes unreadable \\(ENOENT: `));
    expect(r.out[2]).toBe(`  s-b  ${next.root}  ${when(next.manifest.at)}  0 changes`);
  });

  // Release 7 design: "Nothing on the host opens a path in the box's folder while the box runs". The busy copy's work/
  // is gone, so reading it would say its changes are unreadable.
  it("does not read the changes of a copy whose box runs, saying it is in use, nor of one whose box cannot be removed", async () => {
    const w = world();
    const busy = w.copy("s-busy", { "a.txt": "made-up a\n" }, { at: "2026-11-04T01:02:00.000Z", pid: liveSession() });
    const stuck = w.copy("s-stuck", { "a.txt": "made-up a\n" }, { at: "2026-11-04T02:02:00.000Z", pid: await deadPid() });
    const free = w.copy("s-free", { "a.txt": "made-up a\n" }, { at: "2026-11-05T01:02:00.000Z", changed: { "a.txt": "edited\n" } });
    for (const c of [busy, stuck]) await removeTree(path.join(c.folder, "work"));
    const run: DockerRun = async (args) => (args[0] === "ps" && !args.includes("label=tachikoma.session=s-free") ? ok("b0x\n") : ok());
    const r = io(w.data, { run });
    expect(await reviewCommand([], r.io)).toBe(0);
    expect(r.out.slice(1)).toEqual([
      `  s-busy  ${busy.root}  ${when(busy.manifest.at)}  ${BUSY("s-busy")}`,
      `  s-stuck  ${stuck.root}  ${when(stuck.manifest.at)}  The box could not be removed, so the copy was not reviewed.`,
      `  s-free  ${free.root}  ${when(free.manifest.at)}  1 change`,
    ]);
  });

  // One helper reads what a review lists, for the review (Review.tsx) and the count here alike.
  it("reads a copy's changes as the review lists them: less what git ignores and what an earlier apply applied", async () => {
    const w = world();
    const c = w.copy("s1", { "a.txt": "made-up a\n", ".gitignore": "*.log\n" }, { changed: { "a.txt": "edited\n", "b.txt": "new\n", "x.log": "log\n" } });
    writeFileSync(path.join(c.folder, "applied.jsonl"), `${JSON.stringify({ path: "b.txt", state: "pending", before: "", after: sha("new\n") })}\n${JSON.stringify({ path: "b.txt", state: "done" })}\n`);
    const got = await toReview(c.manifest, c.folder, "s1");
    expect(got.changes.map((ch) => ch.path)).toEqual(["a.txt"]);
    expect(got.ignored).toBe(1);
    expect(got.leftOut).toEqual([]);
  });

  it("says how to use it when given more than a name and --discard", async () => {
    const w = world();
    for (const args of [["a", "b"], ["a", "--discard", "x"], ["--discard"]]) {
      const r = io(w.data);
      expect(await reviewCommand(args, r.io)).toBe(1);
      expect(r.err).toEqual(["Usage: tachi review [<name> [--discard]]"]);
    }
  });
});

describe("tachi review <name>", () => {
  // Task 21's spec review: until the launch keeps the copy, once its box runs, the manifest has its holding name, so a
  // copy still launching is never listed, opened or discarded, and nothing of it is removed; then it is listed.
  it("leaves a copy still launching alone until the launch keeps it", async () => {
    const w = world();
    const c = w.copy("s1", { "a.txt": "made-up a\n" });
    renameSync(path.join(c.folder, "manifest.json"), path.join(c.folder, "manifest.pending.json"));
    const r = io(w.data);
    await reviewCommand([], r.io);
    expect(r.out).toEqual(["No copies are waiting."]);
    for (const args of [["s1"], ["s1", "--discard"]]) {
      const t = io(w.data, { answer: true });
      expect(await reviewCommand(args, t.io)).toBe(1);
      expect(t.err).toEqual(["No copy named s1 is waiting; tachi review lists them."]);
      expect(t.opened).toEqual([]);
    }
    expect(existsSync(path.join(c.folder, "manifest.pending.json"))).toBe(true);
    dropOnExit(c.folder, { on: () => {}, off: () => {} } as never)();
    const kept = io(w.data);
    await reviewCommand([], kept.io);
    expect(kept.out[1]).toMatch(/^  s1  /);
  });

  it("names a copy that is not waiting, and opens nothing, a path among them", async () => {
    const w = world();
    w.copy("s1", { "a.txt": "made-up a\n" });
    mkdirSync(path.join(w.data, "copies", "s-half"));
    for (const name of ["nope", "s-half", "..", "s1/../s1", "s1.lock"]) {
      const r = io(w.data, { answer: true });
      expect(await reviewCommand([name], r.io)).toBe(1);
      expect(r.err).toEqual([`No copy named ${name} is waiting; tachi review lists them.`]);
      expect(r.opened).toEqual([]);
    }
  });

  it("opens the copy, and prints the review's lines after", async () => {
    const w = world();
    w.copy("s1", { "a.txt": "made-up a\n" });
    const r = io(w.data, { terminal: true });
    expect(await reviewCommand(["s1"], r.io)).toBe(0);
    expect(r.opened).toEqual(["s1"]);
    expect(r.out).toEqual(["The copy is kept; tachi review s1 opens it again."]);
  });

  it("needs a terminal, opening nothing without one", async () => {
    const w = world();
    w.copy("s1", { "a.txt": "made-up a\n" });
    const r = io(w.data);
    expect(await reviewCommand(["s1"], r.io)).toBe(1);
    expect(r.err).toEqual(["tachi review s1 needs a terminal; with none, nothing is applied or discarded."]);
  });

  it("first says which files a half-done apply applied, and which it left changed in the folder since", async () => {
    const w = world();
    const c = w.copy("s1", { "a.txt": "made-up a\n", "b.txt": "made-up b\n", "c.txt": "made-up c\n" }, { changed: { "a.txt": "A\n", "b.txt": "B\n", "c.txt": "C\n" } });
    // a.txt applied and logged done; b.txt begun, swapped in, the crash before its done row; c.txt begun, then the user
    // edited it; and a half-written row, as a crash leaves.
    writeFileSync(path.join(c.root, "a.txt"), "A\n");
    writeFileSync(path.join(c.root, "b.txt"), "B\n");
    writeFileSync(path.join(c.root, "c.txt"), "the user's own\n");
    const row = (rel: string, before: string, after: string) => JSON.stringify({ path: rel, state: "pending", before: sha(before), after: sha(after) });
    const log = [row("a.txt", "made-up a\n", "A\n"), JSON.stringify({ path: "a.txt", state: "done" }), row("b.txt", "made-up b\n", "B\n"), row("c.txt", "made-up c\n", "C\n"), '{"path":"d'];
    writeFileSync(path.join(c.folder, "applied.jsonl"), log.join("\n"));
    const r = io(w.data, { terminal: true });
    let atOpen: string[] = [];
    r.io.open = async (copy) => {
      atOpen = [...r.out];
      return { how: "later", outcomes: [], removed: false, lines: [`The copy is kept; tachi review ${copy.session} opens it again.`] };
    };
    await reviewCommand(["s1"], r.io);
    expect(atOpen).toEqual([
      "An earlier apply of this copy applied: a.txt, b.txt",
      "Changed in your folder since an earlier apply began on it, so left as it is: c.txt",
    ]);
  });

  it("does not open without git's settings, and keeps the copy", async () => {
    const w = world();
    w.copy("s1", { "a.txt": "made-up a\n" });
    const r = io(w.data, { terminal: true, gitFails: true });
    expect(await reviewCommand(["s1"], r.io)).toBe(1);
    expect(r.opened).toEqual([]);
    expect(r.err).toEqual([
      "The review did not open: git's settings could not be read (git was ended by SIGKILL), so the hooks folders they name could not be protected.",
      "The copy is kept; tachi review s1 opens it again.",
    ]);
  });
});

describe("tachi review <name> --discard", () => {
  it("discards the copy after a yes", async () => {
    const w = world();
    const c = w.copy("s1", { "a.txt": "made-up a\n", "b.txt": "made-up b\n" });
    const r = io(w.data, { answer: true });
    expect(await reviewCommand(["s1", "--discard"], r.io)).toBe(0);
    expect(r.asked).toEqual([ASKED]);
    expect(r.out).toEqual(["Removing the copy (2 files)...", "The copy was discarded."]);
    expect(existsSync(c.folder)).toBe(false);
    expect(readdirSync(c.root).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("keeps the copy after a no", async () => {
    const w = world();
    const c = w.copy("s1", { "a.txt": "made-up a\n" });
    const r = io(w.data, { answer: false });
    expect(await reviewCommand(["s1", "--discard"], r.io)).toBe(0);
    expect(r.out).toEqual(["The copy is kept; tachi review s1 opens it again."]);
    expect(existsSync(path.join(c.folder, "manifest.json"))).toBe(true);
  });

  it("discards nothing without a terminal, and says why", async () => {
    const w = world();
    const c = w.copy("s1", { "a.txt": "made-up a\n" });
    const r = io(w.data);
    expect(await reviewCommand(["s1", "--discard"], r.io)).toBe(1);
    expect(r.err).toEqual(["tachi review s1 needs a terminal; with none, nothing is applied or discarded."]);
    expect(existsSync(path.join(c.folder, "manifest.json"))).toBe(true);
  });

  it("refuses while the copy's box runs and its session is alive, asking nothing", async () => {
    const w = world();
    const c = w.copy("s1", { "a.txt": "made-up a\n" }, { pid: liveSession() });
    const docker = dockerWith({ b0x: true });
    const r = io(w.data, { answer: true, run: docker.run });
    expect(await reviewCommand(["s1", "--discard"], r.io)).toBe(1);
    expect(r.err).toEqual([BUSY("s1")]);
    expect(r.asked).toEqual([]);
    expect(existsSync(path.join(c.folder, "manifest.json"))).toBe(true);
  });

  it("says, when the box cannot be removed, that the copy was not discarded, and that it is kept", async () => {
    const w = world();
    const c = w.copy("s1", { "a.txt": "made-up a\n" }, { pid: await deadPid() });
    const r = io(w.data, { answer: true, run: dockerWith({ b0x: true }, true).run });
    expect(await reviewCommand(["s1", "--discard"], r.io)).toBe(1);
    expect(r.err).toEqual(["The box could not be removed, so the copy was not discarded.", "The copy is kept; tachi review s1 opens it again."]);
    expect(r.asked).toEqual([]);
    expect(existsSync(path.join(c.folder, "manifest.json"))).toBe(true);
  });

  // The quality review: the files an earlier apply applied stay in the project when the copy is discarded, so they are
  // said before the question.
  it("first says which files an earlier apply applied", async () => {
    const w = world();
    const c = w.copy("s1", { "a.txt": "made-up a\n" }, { changed: { "a.txt": "A\n" } });
    writeFileSync(path.join(c.root, "a.txt"), "A\n");
    writeFileSync(path.join(c.folder, "applied.jsonl"), `${JSON.stringify({ path: "a.txt", state: "pending", before: sha("made-up a\n"), after: sha("A\n") })}\n`);
    const r = io(w.data, { answer: false });
    let atAsk: string[] = [];
    const ask = r.io.ask!;
    r.io.ask = async (q) => ((atAsk = [...r.out]), ask(q));
    await reviewCommand(["s1", "--discard"], r.io);
    expect(atAsk).toEqual(["An earlier apply of this copy applied: a.txt"]);
  });

  // The quality review: Ctrl-C while the copy is removed would leave it half removed, its manifest gone first, so never
  // listed again; the removal goes on, as the review's own does. Windows cannot send a process SIGINT, so the signal is
  // emitted in this process, to its listeners, as Node gives it; the test's own listener stands for cli.tsx's, which
  // exits.
  it("goes on removing through Ctrl-C, twice, and listens for it again after", async () => {
    const w = world();
    w.copy("s1", { "a.txt": "made-up a\n" });
    const exits: string[] = [];
    const exit = () => exits.push("SIGINT");
    process.on("SIGINT", exit);
    onTestFinished(() => void process.off("SIGINT", exit));
    const r = io(w.data, { answer: true });
    let during = 0;
    r.io.remove = async (folder) => {
      process.emit("SIGINT");
      process.emit("SIGINT");
      during = process.listenerCount("SIGINT");
      await removeTree(folder);
    };
    expect(await reviewCommand(["s1", "--discard"], r.io)).toBe(0);
    expect(r.out.at(-1)).toBe("The copy was discarded.");
    expect(exits).toEqual([]);
    expect(during).toBeGreaterThan(0); // a listener is there, so Node does not end the process
    expect(process.listeners("SIGINT")).toContain(exit);
  });
});

// Choice 121 (the user's): a copy session that ends with nothing to review removes the copy, with no review, at the
// session's end and with -p (tests/tui/app.test.tsx and tests/cli.test.ts).
describe("a copy with nothing to review", () => {
  const said = () => {
    const lines: string[] = [];
    return { lines, say: (line: string) => lines.push(line) };
  };

  it("is removed when nothing changed, the box's own repository not counting, saying so", async () => {
    const w = world();
    const c = w.copy("s1", { "a.txt": "made-up a\n" });
    mkdirSync(path.join(c.folder, "work", ".git")); // made in the box at launch (choice 24)
    const s = said();
    expect(await dropIfNothing({ session: "s1", ...c }, s.say)).toBe("Nothing changed in the copy, so it was removed.");
    expect(s.lines).toEqual(["Removing the copy (1 file)..."]);
    expect(existsSync(c.folder)).toBe(false);
  });

  // What the launch left out was said at launch (manifest.leftOut), so it is nothing to review.
  it("is removed when nothing changed, what the launch left out not counting", async () => {
    const w = world();
    const c = w.copy("s1", { "a.txt": "made-up a\n" });
    c.manifest.leftOut.push({ path: "out", why: "a link that leads outside the project" });
    writeFileSync(path.join(c.folder, "manifest.json"), JSON.stringify(c.manifest));
    const s = said();
    expect(await dropIfNothing({ session: "s1", ...c }, s.say)).toBe("Nothing changed in the copy, so it was removed.");
    expect(s.lines).toEqual(["Removing the copy (1 file)..."]);
    expect(existsSync(c.folder)).toBe(false);
  });

  it("is removed when its only changes are in paths git ignores, counting them", async () => {
    const w = world();
    const tree = { ".gitignore": "*.log\n", "a.txt": "made-up a\n" };
    for (const [name, changed, count] of [["s1", { "one.log": "x\n" }, "1 change"], ["s2", { "one.log": "x\n", "two.log": "y\n" }, "2 changes"]] as const) {
      const c = w.copy(name, tree, { changed });
      const s = said();
      expect(await dropIfNothing({ session: name, ...c }, s.say)).toBe(`Nothing to review (${count} only in paths git ignores, never applied), so the copy was removed.`);
      expect(s.lines).toEqual(["Removing the copy (2 files)..."]);
      expect(existsSync(c.folder)).toBe(false);
    }
  });

  it("is kept with a change to review, giving what toReview gave, so the review does not read it again", async () => {
    const w = world();
    const c = w.copy("s1", { "a.txt": "made-up a\n", ".gitignore": "*.log\n" }, { changed: { "a.txt": "A\n", "one.log": "x\n" } });
    const s = said();
    const got = await dropIfNothing({ session: "s1", ...c }, s.say);
    expect(got).toEqual(await toReview(c.manifest, c.folder, "s1"));
    expect(typeof got === "object" && got.changes.map((ch) => ch.path)).toEqual(["a.txt"]);
    expect(s.lines).toEqual([]);
    expect(existsSync(path.join(c.folder, "manifest.json"))).toBe(true);
  });

  // The coordinator's ruling on choice 121: what the box left that is never applied is listed in the review, for the
  // user to see before it is deleted.
  it("is kept for the review when the box left a deeper .git or a .tachikoma, never applied", async () => {
    const w = world();
    for (const [name, made] of [["s1", "sub/.git"], ["s2", ".tachikoma"]] as const) {
      const c = w.copy(name, { "a.txt": "made-up a\n" });
      mkdirSync(path.join(c.folder, "work", ...made.split("/")), { recursive: true });
      const s = said();
      const got = await dropIfNothing({ session: name, ...c }, s.say);
      expect(typeof got === "object" && got.leftOut.map((l) => l.path)).toEqual([made]);
      expect(typeof got === "object" && got.changes).toEqual([]);
      expect(s.lines).toEqual([]);
      expect(existsSync(path.join(c.folder, "manifest.json"))).toBe(true);
    }
  });

  it("is kept when its changes cannot be read, for the review to say why", async () => {
    const w = world();
    const c = w.copy("s1", { "a.txt": "made-up a\n" });
    renameSync(path.join(c.folder, "work"), path.join(c.folder, "elsewhere"));
    const s = said();
    expect(await dropIfNothing({ session: "s1", ...c }, s.say)).toBeUndefined();
    expect(s.lines).toEqual([]);
    expect(existsSync(path.join(c.folder, "manifest.json"))).toBe(true);
  });

  it("says, escaped, when it cannot be removed, as discard does", async () => {
    const w = world();
    const c = w.copy("s1", { "a.txt": "made-up a\n" });
    const s = said();
    const got = await dropIfNothing({ session: "s1", ...c }, s.say, async () => {
      throw new Error("made-up failure\u001b[8m");
    });
    expect(got).toBe(`The copy could not be removed (made-up failure\\u001b[8m); delete ${c.folder} by hand.`);
    expect(s.lines).toEqual(["Removing the copy (1 file)..."]);
    expect(existsSync(path.join(c.folder, "manifest.json"))).toBe(true);
  });
});

// The check before the review lists changes or applies anything (release 7 plan, Task 21), with a stand-in Docker; the
// real one is in tests/sandbox/copy.test.ts.
describe("the box check before a review", () => {
  it("refuses while the box runs and the session's process is alive, removing nothing and opening nothing", async () => {
    const w = world();
    w.copy("s1", { "a.txt": "made-up a\n" }, { pid: liveSession() });
    const docker = dockerWith({ b0x: true });
    const r = io(w.data, { terminal: true, run: docker.run });
    expect(await reviewCommand(["s1"], r.io)).toBe(1);
    expect(r.err).toEqual([BUSY("s1")]);
    expect(r.opened).toEqual([]);
    expect(docker.calls.some((a) => a[0] === "rm")).toBe(false);
    expect(docker.calls.every((a) => a.includes("label=tachikoma.session=s1"))).toBe(true);
  });

  it("removes a crash's box, running or not, then opens the copy", async () => {
    const w = world();
    w.copy("s1", { "a.txt": "made-up a\n" }, { pid: await deadPid() });
    const docker = dockerWith({ b0x: true, old: false });
    const r = io(w.data, { terminal: true, run: docker.run });
    expect(await reviewCommand(["s1"], r.io)).toBe(0);
    expect(docker.calls).toContainEqual(["rm", "-f", "b0x", "old"]);
    expect(r.opened).toEqual(["s1"]);
  });

  it("removes a stopped box of a live session, which cannot be running anything, then opens the copy", async () => {
    const w = world();
    w.copy("s1", { "a.txt": "made-up a\n" }, { pid: liveSession() });
    const docker = dockerWith({ b0x: false });
    const r = io(w.data, { terminal: true, run: docker.run });
    expect(await reviewCommand(["s1"], r.io)).toBe(0);
    expect(r.opened).toEqual(["s1"]);
  });

  it("does not open while Docker still lists the box after removing it", async () => {
    const w = world();
    w.copy("s1", { "a.txt": "made-up a\n" }, { pid: await deadPid() });
    const r = io(w.data, { terminal: true, run: dockerWith({ b0x: true }, true).run });
    expect(await reviewCommand(["s1"], r.io)).toBe(1);
    expect(r.err).toEqual(["The box could not be removed, so the copy was not reviewed."]);
    expect(r.opened).toEqual([]);
  });

  it("goes on when Docker is not running or not installed, as no box can be running", async () => {
    const w = world();
    w.copy("s1", { "a.txt": "made-up a\n" }, { pid: liveSession() });
    const answers: Awaited<ReturnType<DockerRun>>[] = [{ code: 1, out: "", err: "error during connect: made-up\n" }, "missing"];
    for (const answer of answers) {
      const r = io(w.data, { terminal: true, run: async () => answer });
      expect(await reviewCommand(["s1"], r.io)).toBe(0);
      expect(r.opened).toEqual(["s1"]);
    }
    const r = io(w.data, { terminal: true, run: async () => Promise.reject(new Error("spawn EACCES")) });
    expect(await reviewCommand(["s1"], r.io)).toBe(0);
  });

  // leave() (queue.ts, through cli.tsx) checks its own copy: the session is this process, ending, so its box is removed,
  // never refused.
  it("removes the box of this process's own session, never refusing it", async () => {
    const w = world();
    const c = w.copy("s1", { "a.txt": "made-up a\n" }, { pid: process.pid });
    const docker = dockerWith({ b0x: true });
    expect(await boxCheck(c.manifest, docker.run)).toBe("free");
    expect(docker.calls).toContainEqual(["rm", "-f", "b0x"]);
  });
});

// Two reviews of one copy take turns by the lock beside it (withLock, auth/lock.ts). Two terminals cannot be run here,
// so the first review is a lock file the test makes by hand, holding a live stand-in's pid, as withLock's own holds its
// owner's; the second is the command, which waits, saying so, until the test removes the file. 15 s, as for the tests
// that start processes (tests/cli.test.ts), which is past withLock's 5 s recheck should the folder's change be missed.
describe("two reviews of one copy at once", { timeout: 15_000 }, () => {
  // Settles at the command's first line on stdout.
  const said = (given: ReviewIo) =>
    new Promise<void>((resolve) => {
      const out = given.out;
      given.out = (line) => (out(line), resolve());
    });

  it("makes the second wait for the first, saying so, then open", async () => {
    const w = world();
    const c = w.copy("s1", { "a.txt": "made-up a\n" });
    const lock = `${c.folder}.lock`;
    writeFileSync(lock, String(liveSession()));
    const r = io(w.data, { terminal: true });
    const waiting = said(r.io);
    const done = reviewCommand(["s1"], r.io);
    await waiting;
    expect(r.out).toEqual(["Another review of this copy is open; waiting for it to end..."]);
    expect(r.opened).toEqual([]);
    unlinkSync(lock);
    expect(await done).toBe(0);
    expect(r.opened).toEqual(["s1"]);
  });

  it("finds the copy gone when the first review removed it", async () => {
    const w = world();
    const c = w.copy("s1", { "a.txt": "made-up a\n" });
    const lock = `${c.folder}.lock`;
    writeFileSync(lock, String(liveSession()));
    const r = io(w.data, { terminal: true });
    const waiting = said(r.io);
    const done = reviewCommand(["s1"], r.io);
    await waiting;
    await removeTree(c.folder);
    unlinkSync(lock);
    expect(await done).toBe(1);
    expect(r.err).toEqual(["No copy named s1 is waiting; tachi review lists them."]);
    expect(r.opened).toEqual([]);
  });
});
