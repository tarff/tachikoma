import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mode } from "../../src/core/permissions.js";
import { readInstructions } from "../../src/core/instructions.js";
import { editFileTool, leaves, readFileTool, writeFileTool } from "../../src/tools/files.js";
import { findFilesTool, searchFilesTool } from "../../src/tools/search.js";
import { listFolder, pathMenu } from "../../src/tui/menus.js";
import { tempContext } from "../helpers.js";

// Review fixes plan, fix 2. Every function of node:fs and node:fs/promises that takes a path is wrapped: a network or
// device path is recorded and refused at once, without calling the real function, so even a test that fails never
// reaches Windows' network or a pipe. `<root>\linked` is a fake link to a share: lstatSync says it is a link and
// readlinkSync gives its target; any other call on it or under it is recorded and refused, so following it is caught.
// The share's name ends in .invalid, which never resolves (RFC 2606), as a second guard only. The wrappers go by a
// path's text, and do not reach search's grep worker or the steps inside realpathSync: that is safe only because every
// refusal comes before those (fix 11). So search_files is not tried in a project on the share: its worker would really
// try the share's name (fix 14, the user's choice, "Leave search out").
// Fix 8: when `share` is set, the share is a folder the test made, which stands in for it, so a project can live there;
// each of `follow` is a fake link that is followed to its target, as a real one would be. realpath names the share
// again. Fix 14: `lstats` records every lstatSync, and each test's project root is its own, as resolveIn keeps each
// root's real place for the session.
// Fix 9: each of `internal` is a fake link whose stored target is in Windows' internal form, refused as `linked` is,
// and so is the made-up local folder that target resolves into (C:\??, C:\Device), so a walk that resolves it never
// reaches the real disk.
const fake = vi.hoisted(() => {
  const state = { reached: [] as string[], linked: undefined as string | undefined, share: undefined as string | undefined, follow: [] as [string, string][], internal: [] as [string, string][], lstats: [] as string[] };
  const TARGET = String.raw`\\tachi-test.invalid\share`;
  // As the plan defines it: \\ or // once resolved, except \\?\ or \\.\ before a drive letter, a local long path.
  const network = (p: string) => /^[\\/]{2}/.test(p) && !/^[\\/]{2}[?.][\\/][a-z]:\\/i.test(p);
  const twoPaths = new Set(["rename", "renameSync", "copyFile", "copyFileSync", "link", "linkSync", "symlink", "symlinkSync", "cp", "cpSync"]);
  const sameAs = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const under = (p: string, folder: string) => sameAs(p, folder) || p.toLowerCase().startsWith(`${folder.toLowerCase().replace(/\\$/, "")}\\`);
  // Where a path really goes: from the share's \\?\UNC\ spelling to its plain one, through each followed link in turn,
  // and from the share to the folder standing in for it.
  const UNC = String.raw`\\?\UNC\tachi-test.invalid\share`;
  const moved = (p: string) => {
    let through = state.share && under(p, UNC) ? TARGET + p.slice(UNC.length) : p;
    for (const [link, target] of state.follow) if (under(through, link)) through = target + through.slice(link.length);
    return state.share && under(through, TARGET) ? state.share + through.slice(TARGET.length) : through;
  };
  const named = (out: unknown) => (typeof out === "string" && state.share && under(out, state.share) ? TARGET + out.slice(state.share.length) : out);
  function wrapAll(real: Record<string, unknown>, promises: boolean, resolve: (...p: string[]) => string, dirname: (p: string) => string) {
    const linkDirent = { name: "linked", isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };
    const wrap = (name: string, fn: (...a: unknown[]) => unknown) => {
      const wrapped = function (this: unknown, ...args: unknown[]) {
        const given = args.map((a, i) => (i < (twoPaths.has(name) ? 2 : 1) && typeof a === "string" ? resolve(a) : undefined));
        const linked = state.linked;
        if (name === "lstatSync" && given[0] !== undefined) state.lstats.push(given[0]);
        for (const p of given) {
          if (p === undefined) continue;
          for (const [link, stored] of [...(linked ? [[linked, TARGET] as [string, string]] : []), ...state.follow, ...state.internal]) {
            if (sameAs(p, link) && name === "lstatSync") return { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };
            if (sameAs(p, link) && name === "readlinkSync") return stored;
          }
          const q = moved(p);
          const internal = state.internal.some(([link, stored]) => under(q, link) || under(q, resolve(dirname(link), stored).split("\\").slice(0, 2).join("\\")));
          if (network(q) || (linked && under(q, linked)) || internal) {
            state.reached.push(`${name} ${q}`);
            const err = Object.assign(new Error(`ENOENT: no such file or directory, ${name} '${q}'`), { code: "ENOENT" });
            if (promises) return Promise.reject(err);
            throw err;
          }
        }
        const out = fn.apply(
          this,
          args.map((a, i) => (given[i] === undefined || moved(given[i]) === given[i] ? a : moved(given[i]))),
        );
        if (/^realpath/.test(name)) return out instanceof Promise ? out.then(named) : named(out);
        const paths = given.filter((p) => p !== undefined);
        if (!linked || !/^readdir(Sync)?$/.test(name) || !paths[0] || !sameAs(paths[0], dirname(linked))) return out;
        // The fake link is listed in its folder, as a real one would be.
        const entry = (args[1] as { withFileTypes?: boolean } | undefined)?.withFileTypes ? linkDirent : "linked";
        return out instanceof Promise ? out.then((list: unknown[]) => [...list, entry]) : [...(out as unknown[]), entry];
      };
      Object.assign(wrapped, fn);
      const native = (fn as { native?: (...a: unknown[]) => unknown }).native;
      if (native) Object.assign(wrapped, { native: wrap(name, native) });
      return wrapped;
    };
    const all = Object.fromEntries(
      Object.entries(real).map(([name, v]) => [name, typeof v === "function" && /^[a-z]/.test(name) ? wrap(name, v as (...a: unknown[]) => unknown) : v]),
    );
    return { ...all, default: all };
  }
  return { state, wrapAll, TARGET };
});

vi.mock("node:fs", async (original) => {
  const path = await import("node:path");
  return fake.wrapAll(await original(), false, path.resolve, path.dirname);
});
vi.mock("node:fs/promises", async (original) => {
  const path = await import("node:path");
  return fake.wrapAll(await original(), true, path.resolve, path.dirname);
});

const OPEN = "which the file tools never open; a shell command can reach it, after asking";
const direct = (abs: string) =>
  `${abs} is a network or device path not written as a path in the project, so the file tools do not open it; a shell command can reach it, after asking`;
const through = (abs: string, link: string, target = fake.TARGET) => `${abs} leads through ${link} to a network or device path outside the project (${target}), ${OPEN}`;
const failure = (p: Promise<unknown>) =>
  p.then(
    () => "no error",
    (err: Error) => err.message,
  );

describe.runIf(process.platform === "win32")("network and device paths", () => {
  // The data folder and the home folder are the test's own, so no check looks at the user's.
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "tachi-home-"));
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("TACHI_DATA_DIR", path.join(home, "data"));
    fake.state.reached = [];
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fake.state.linked = undefined;
    fake.state.share = undefined;
    fake.state.follow = [];
    fake.state.internal = [];
    fake.state.lstats = [];
  });

  async function project(mode: Mode) {
    const ctx = await tempContext(mode);
    fake.state.linked = path.join(ctx.root, "linked");
    await writeFile(path.join(ctx.root, "a.txt"), "fine");
    return ctx;
  }

  // Each refused: the exact words, the gate never asked, and nothing reached for it.
  async function refusedEverywhere(p: string, words: string) {
    for (const mode of ["ask", "never"] as const) {
      const ctx = await project(mode);
      expect(await failure(readFileTool.run({ path: p }, ctx))).toBe(words);
      expect(await failure(writeFileTool.run({ path: p, content: "x" }, ctx))).toBe(words);
      expect(await failure(editFileTool.run({ path: p, old_text: "x", new_text: "y" }, ctx))).toBe(words);
      expect(await failure(searchFilesTool.run({ pattern: "x", path: p }, ctx))).toBe(words);
      expect(ctx.asked).toEqual([]);
    }
    expect(fake.state.reached).toEqual([]);
  }

  it.each([
    [String.raw`\\tachi-test.invalid\share\a.txt`, String.raw`\\tachi-test.invalid\share\a.txt`],
    ["//tachi-test.invalid/share/a.txt", String.raw`\\tachi-test.invalid\share\a.txt`],
    [String.raw`\\?\UNC\tachi-test.invalid\share\a.txt`, String.raw`\\?\UNC\tachi-test.invalid\share\a.txt`],
  ])("refuses %s before the disk, in every mode", async (p, abs) => {
    await refusedEverywhere(p, direct(abs));
  });

  it("refuses a named pipe before the disk, in every mode", async () => {
    const pipe = String.raw`\\.\pipe\tachi`;
    for (const mode of ["ask", "never"] as const) {
      const ctx = await project(mode);
      expect(await failure(readFileTool.run({ path: pipe }, ctx))).toBe(direct(pipe));
      expect(await failure(writeFileTool.run({ path: pipe, content: "x" }, ctx))).toBe(direct(pipe));
      expect(await failure(editFileTool.run({ path: pipe, old_text: "x", new_text: "y" }, ctx))).toBe(direct(pipe));
      expect(await failure(searchFilesTool.run({ pattern: "x", path: pipe }, ctx))).toBe(direct(pipe));
      expect(ctx.asked).toEqual([]);
    }
    expect(fake.state.reached).toEqual([]);
  });

  it("refuses the loopback share's spelling of a local file", async () => {
    const ctx = await project("never");
    const file = path.join(ctx.root, "a.txt");
    const share = `\\\\localhost\\${file[0]}$${file.slice(2)}`;
    expect(await failure(readFileTool.run({ path: share }, ctx))).toBe(direct(share));
    expect(await failure(writeFileTool.run({ path: share, content: "x" }, ctx))).toBe(direct(share));
    expect(fake.state.reached).toEqual([]);
  });

  it("refuses a path through a link on the way to a share, in every mode", async () => {
    for (const mode of ["ask", "never"] as const) {
      const ctx = await project(mode);
      const link = path.join(ctx.root, "linked");
      const abs = path.join(link, "a.txt");
      expect(await failure(readFileTool.run({ path: "linked\\a.txt" }, ctx))).toBe(through(abs, link));
      expect(await failure(writeFileTool.run({ path: "linked\\a.txt", content: "x" }, ctx))).toBe(through(abs, link));
      expect(await failure(editFileTool.run({ path: "linked\\a.txt", old_text: "x", new_text: "y" }, ctx))).toBe(through(abs, link));
      expect(await failure(searchFilesTool.run({ pattern: "x", path: "linked" }, ctx))).toBe(through(link, link));
      expect(ctx.asked).toEqual([]);
    }
    expect(fake.state.reached).toEqual([]);
  });

  // Review fixes plan, fix 7: a link can rightly be passed twice, so the walk counts the links it passes and stops past
  // 63, Windows' own limit, instead of ending at a link seen before. `l` and the `a`, `b` loop are real local junctions.
  it("refuses a link to a share reached by passing a junction twice, and a loop of junctions past 63 links", async () => {
    const ctx = await project("never");
    const [l, a, b] = ["l", "a", "b"].map((name) => path.join(ctx.root, name)) as [string, string, string];
    await symlink(ctx.root, l, "junction");
    await symlink(b, a, "junction");
    await symlink(a, b, "junction");
    try {
      for (const p of [path.join("l", "linked", "a.txt"), path.join("l", "l", "linked", "a.txt")]) {
        expect(await failure(readFileTool.run({ path: p }, ctx))).toBe(through(path.join(ctx.root, p), path.join(ctx.root, "linked")));
      }
      const loop = path.join(a, "x.txt");
      expect(await failure(readFileTool.run({ path: path.join("a", "x.txt") }, ctx))).toBe(`${loop} passes through more than 63 links, ${OPEN}`);
      expect(ctx.asked).toEqual([]);
      expect(fake.state.reached).toEqual([]);
    } finally {
      for (const link of [l, a, b]) await unlink(link);
    }
  });

  // Review fixes plan, fix 14: Windows opens a path through 63 junctions and no more (probed 2026-10-30: 64 gave
  // ELOOP), so a chain of 63 resolves and one of 64 is refused; a project whose own folder passes 64 refuses every
  // path, with words for one in it and for one outside it. The junctions are real and local.
  it("reads through 63 junctions, and refuses 64, in the project and on the way to it", async () => {
    const ctx = await project("never");
    await mkdir(path.join(ctx.root, "end"));
    await writeFile(path.join(ctx.root, "end", "a.txt"), "end");
    const chains = [63, 64].map((n) => Array.from({ length: n }, (_, i) => path.join(ctx.root, `n${n}j${i + 1}`)));
    for (const links of chains) for (const [i, link] of links.entries()) await symlink(links[i + 1] ?? path.join(ctx.root, "end"), link, "junction");
    try {
      const [first63, first64] = chains.map((links) => links[0]!) as [string, string];
      expect(await readFileTool.run({ path: path.join(first63, "a.txt") }, ctx)).toBe("     1\tend");
      const abs = path.join(first64, "a.txt");
      expect(await failure(readFileTool.run({ path: abs }, ctx))).toBe(`${abs} passes through more than 63 links, ${OPEN}`);
      const outside = path.join(ctx.root, "a.txt");
      const root = { ...ctx, root: first64 };
      expect(await failure(readFileTool.run({ path: "a.txt" }, root))).toBe(`${abs} is in a project whose own folder passes through more than 63 links, ${OPEN}`);
      expect(await failure(readFileTool.run({ path: outside }, root))).toBe(`${outside} cannot be checked, as the project's own folder passes through more than 63 links, ${OPEN}`);
      expect(ctx.asked).toEqual([]);
      expect(fake.state.reached).toEqual([]);
    } finally {
      for (const link of chains.flat()) await unlink(link);
    }
  });

  // Review fixes plan, fix 14: in a project reached through a link to the share, a later path is walked from the
  // project's real place, not over its own folders again; a link in the project to another folder of that place is
  // followed; and the @ menu lists the project. search_files is left out (see the top of this file).
  // Review fixes plan, fix 13: the project's own share written as \\?\UNC\server\share is walked from that share's
  // root, as \\server\share is, not from \\?\UNC\ with the server on its own as its first part.
  it("reads a file in a project on the share written as \\\\?\\UNC\\, and asks for one elsewhere on that share", async () => {
    const share = await realpath(await mkdtemp(path.join(tmpdir(), "tachi-share-")));
    const ctx = await tempContext("ask", [false]);
    const name = path.basename(ctx.root);
    await mkdir(path.join(share, name));
    await mkdir(path.join(share, "other"));
    await writeFile(path.join(share, name, "a.txt"), "fine");
    await writeFile(path.join(share, "other", "b.txt"), "elsewhere");
    fake.state.share = share;
    const root = { ...ctx, root: path.join(fake.TARGET, name) };
    const unc = String.raw`\\?\UNC\tachi-test.invalid\share`;
    expect(await readFileTool.run({ path: path.join(unc, name, "a.txt") }, root)).toBe("     1\tfine");
    expect(ctx.asked).toEqual([]);
    const elsewhere = path.join(unc, "other", "b.txt");
    expect(await failure(readFileTool.run({ path: elsewhere }, root))).toBe(`The user declined: read ${elsewhere} (really ${path.join(fake.TARGET, "other", "b.txt")})`);
    expect(ctx.asked).toHaveLength(1);
    // Fix 17: the project's own folder written that way too.
    const asking = await tempContext("ask", [false]);
    const uncRoot = { ...asking, root: path.join(unc, name) };
    expect(await readFileTool.run({ path: "a.txt" }, uncRoot)).toBe("     1\tfine");
    expect(await failure(readFileTool.run({ path: elsewhere }, uncRoot))).toBe(`The user declined: read ${elsewhere}`);
    expect(asking.asked).toHaveLength(1);
    expect(fake.state.reached).toEqual([]);
  });

  // Review fixes plan, fix 17: in a project on the share, a link to another share is still refused by the link check.
  it("refuses a link in a project on the share that leads to another share", async () => {
    const share = await realpath(await mkdtemp(path.join(tmpdir(), "tachi-share-")));
    const ctx = await tempContext("ask");
    const name = path.basename(ctx.root);
    await mkdir(path.join(share, name));
    fake.state.share = share;
    const root = path.join(fake.TARGET, name);
    const link = path.join(root, "out");
    const other = String.raw`\\tachi-test.invalid\other`;
    fake.state.follow = [[link, other]];
    const abs = path.join(link, "a.txt");
    expect(await failure(readFileTool.run({ path: path.join("out", "a.txt") }, { ...ctx, root }))).toBe(through(abs, link, other));
    expect(ctx.asked).toEqual([]);
    expect(fake.state.reached).toEqual([]);
  });

  it("works in a project reached through a link to the share: its own folders walked once, a link in it, the @ menu", async () => {
    const share = await realpath(await mkdtemp(path.join(tmpdir(), "tachi-share-")));
    const ctx = await tempContext("never");
    const name = path.basename(ctx.root);
    await mkdir(path.join(share, name, "sub"), { recursive: true });
    await writeFile(path.join(share, name, "a.txt"), "fine");
    await writeFile(path.join(share, name, "sub", "b.txt"), "sub");
    const work = path.join(ctx.root, "work");
    const place = path.join(fake.TARGET, name);
    fake.state.share = share;
    fake.state.follow = [
      [work, fake.TARGET],
      [path.join(place, "inner"), path.join(place, "sub")],
    ];
    const root = { ...ctx, root: path.join(work, name) };
    expect(await readFileTool.run({ path: "a.txt" }, root)).toBe("     1\tfine");
    fake.state.lstats = [];
    expect(await readFileTool.run({ path: path.join("sub", "b.txt") }, root)).toBe("     1\tsub");
    // None of the folders on the way to the project, nor the project itself, is looked at again.
    const own = (p: string) => [root.root, place].some((r) => !leaves(path.relative(p, r)));
    expect(fake.state.lstats.filter(own)).toEqual([]);
    expect(await readFileTool.run({ path: path.join("inner", "b.txt") }, root)).toBe("     1\tsub");
    const list = (folder: string) => listFolder(root.root, folder);
    expect(pathMenu("@", 1, list)?.entries.map((e) => e.label)).toEqual(["sub/", "a.txt"]);
    expect(ctx.asked).toEqual([]);
    expect(fake.state.reached).toEqual([]);
  });

  // Review fixes plan, fix 8: a path in the project is walked from the root's real place, so a project on a share, or
  // reached through a link to one, works.
  it("reads a file in a project on a share, and in one reached through a link to that share", async () => {
    const share = await realpath(await mkdtemp(path.join(tmpdir(), "tachi-share-")));
    const ctx = await tempContext("never");
    const name = path.basename(ctx.root);
    await mkdir(path.join(share, name));
    await writeFile(path.join(share, name, "a.txt"), "fine");
    fake.state.share = share;
    fake.state.follow = [[path.join(ctx.root, "work"), fake.TARGET]];
    for (const root of [path.join(fake.TARGET, name), path.join(ctx.root, "work", name)]) {
      expect(await readFileTool.run({ path: "a.txt" }, { ...ctx, root })).toBe("     1\tfine");
    }
    expect(ctx.asked).toEqual([]);
    expect(fake.state.reached).toEqual([]);
  });

  // Review fixes plan, fix 9: a link stored in Windows' internal form, which path.resolve would make a local path, is
  // refused by its stored text: in the project, and, with words of its own, on the way to the project's own folder.
  const INTERNAL = [String.raw`\??\GLOBALROOT\Device\Mup\tachi-test.invalid\share`, String.raw`\Device\Mup\tachi-test.invalid\share`];
  it("refuses a link whose target is in Windows' internal form, in the project and on the way to it", async () => {
    const ctx = await project("never");
    fake.state.internal = INTERNAL.map((stored, i) => [path.join(ctx.root, `internal${i}`), stored]);
    for (const [link, stored] of fake.state.internal) {
      const abs = path.join(link, "a.txt");
      expect(await failure(readFileTool.run({ path: abs }, ctx))).toBe(through(abs, link, stored));
      expect(await failure(writeFileTool.run({ path: abs, content: "x" }, ctx))).toBe(through(abs, link, stored));
      const root = path.join(link, "proj");
      const inside = path.join(root, "a.txt");
      const words = `${inside} is in a project whose own folder leads through ${link} to ${stored}, a link the file tools cannot check, so they never open it; a shell command can reach it, after asking`;
      expect(await failure(readFileTool.run({ path: "a.txt" }, { ...ctx, root }))).toBe(words);
      // Fix 14: a path outside such a project is not "in" it.
      const outside = path.join(ctx.root, "a.txt");
      const unchecked = `${outside} cannot be checked, as the project's own folder leads through ${link} to ${stored}, a link the file tools cannot check, so they never open it; a shell command can reach it, after asking`;
      expect(await failure(readFileTool.run({ path: outside }, { ...ctx, root }))).toBe(unchecked);
    }
    expect(ctx.asked).toEqual([]);
    expect(fake.state.reached).toEqual([]);
  });

  // Review fixes plan, fix 10: your own instruction files, and what they import, may live on a share, as they do with a
  // home folder kept on a server; a project's import of the same path is still refused.
  it("reads your own instruction file on a share, and refuses a project's import of it", async () => {
    const share = await realpath(await mkdtemp(path.join(tmpdir(), "tachi-share-")));
    await mkdir(path.join(share, "home", ".claude"), { recursive: true });
    await writeFile(path.join(share, "home", ".claude", "CLAUDE.md"), "mine\n");
    fake.state.share = share;
    const { root } = await project("ask");
    const mine = path.join(fake.TARGET, "home", ".claude", "CLAUDE.md");
    await writeFile(path.join(root, "AGENTS.md"), `See @${mine}\n`);
    const got = await readInstructions({ root, home: path.join(fake.TARGET, "home"), top: root }, async () => false);
    expect(got.read.map((r) => r.path)).toEqual([mine, path.join(root, "AGENTS.md")]);
    expect(got.left).toEqual([{ path: mine, why: direct(mine) }]);
    expect(fake.state.reached).toEqual([]);
  });

  // Review fixes plan, fix 13: a path on the share the project really lives on is not refused, as Windows has already
  // signed in there for the project (the user's choice, "Same share is fine"); a path on another share still is.
  it.each(["on the share", "through a link to the share"])("looks for instruction files above a project %s, and refuses another share", async (how) => {
    const share = await realpath(await mkdtemp(path.join(tmpdir(), "tachi-share-")));
    const ctx = await tempContext("never");
    const name = path.basename(ctx.root);
    await mkdir(path.join(share, name));
    fake.state.share = share;
    fake.state.follow = [[path.join(ctx.root, "work"), fake.TARGET]];
    const [root, top] = how === "on the share" ? [path.join(fake.TARGET, name), fake.TARGET] : [path.join(ctx.root, "work", name), ctx.root];
    expect(await readInstructions({ root, home, top }, async () => false)).toEqual({ text: "", read: [], left: [] });
    const other = String.raw`\\tachi-test.invalid\other\x.md`;
    await writeFile(path.join(share, "CLAUDE.md"), `Above. See @${other}\n`);
    const got = await readInstructions({ root, home, top }, async () => false);
    expect(got.read.map((r) => r.path)).toEqual([path.join(path.dirname(root), "CLAUDE.md")]);
    expect(got.left).toEqual([{ path: other, why: direct(other) }]);
    expect(fake.state.reached).toEqual([]);
  });

  it("lists nothing through the link in the @ menu, and leaves it out of its folder's listing", async () => {
    const { root } = await project("ask");
    const link = path.join(root, "linked");
    const list = (folder: string) => listFolder(root, folder);
    const entries = [{ label: `Cannot list linked\\: ${through(link, link)}`, fill: "", error: true }];
    expect(pathMenu("@linked\\", 8, list)).toEqual({ kind: "path", from: 0, entries });
    expect(pathMenu("@", 1, list)?.entries.map((e) => e.label)).toEqual(["a.txt"]);
    expect(fake.state.reached).toEqual([]);
  });

  it("leaves out an instruction file's import of a share, directly or through the link, saying why", async () => {
    const { root } = await project("ask");
    await writeFile(path.join(root, "AGENTS.md"), "See @\\\\tachi-test.invalid\\share\\x.md and @linked/x.md\n");
    const asked: unknown[] = [];
    const got = await readInstructions({ root, home, top: root }, async (reached) => {
      asked.push(reached);
      return false;
    });
    const share = String.raw`\\tachi-test.invalid\share\x.md`;
    const linked = path.join(root, "linked", "x.md");
    expect(got.left).toEqual([
      { path: share, why: direct(share) },
      { path: linked, why: through(linked, path.join(root, "linked")) },
    ]);
    expect(asked).toEqual([]);
    expect(fake.state.reached).toEqual([]);
  });

  it("finds files without touching the link or a share, whatever the pattern", async () => {
    const ctx = await project("never");
    expect(await findFilesTool.run({ pattern: "**/*" }, ctx)).toBe("a.txt");
    expect(await findFilesTool.run({ pattern: "//tachi-test.invalid/**" }, ctx)).toBe("No files match //tachi-test.invalid/**");
    expect(fake.state.reached).toEqual([]);
  });

  // The user's choice at the build ("Count as local"): \\?\ before a drive letter is a local long path, checked as before.
  // The prompt shows the real place in Windows' own spelling (fix 12, the user's choice, "Show the real place").
  it("reads a long path (\\\\?\\C:\\) in the project, and asks for one outside it, as local paths", async () => {
    const ctx = await project("never");
    expect(await readFileTool.run({ path: `\\\\?\\${path.join(ctx.root, "a.txt")}` }, ctx)).toBe("     1\tfine");
    const other = await mkdtemp(path.join(tmpdir(), "tachi-outside-"));
    await mkdir(path.join(other, "sub"));
    await writeFile(path.join(other, "sub", "b.txt"), "elsewhere");
    const asking = await tempContext("ask", [false]);
    const long = `\\\\?\\${path.join(other, "sub", "b.txt")}`;
    const shown = `read ${long} (really ${realpathSync.native(path.join(other, "sub", "b.txt"))})`;
    expect(await failure(readFileTool.run({ path: long }, asking))).toBe(`The user declined: ${shown}`);
    expect(asking.asked).toEqual([shown]);
    expect(fake.state.reached).toEqual([]);
  });
});
