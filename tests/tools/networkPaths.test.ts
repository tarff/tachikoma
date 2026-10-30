import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mode } from "../../src/core/permissions.js";
import { readInstructions } from "../../src/core/instructions.js";
import { readFileTool, writeFileTool } from "../../src/tools/files.js";
import { findFilesTool, searchFilesTool } from "../../src/tools/search.js";
import { listFolder, pathMenu } from "../../src/tui/menus.js";
import { tempContext } from "../helpers.js";

// Review fixes plan, fix 2. Every function of node:fs and node:fs/promises that takes a path is wrapped: a network or
// device path is recorded and refused at once, without calling the real function, so even a test that fails never
// reaches Windows' network or a pipe. `<root>\linked` is a fake link to a share: lstatSync says it is a link and
// readlinkSync gives its target; any other call on it or under it is recorded and refused, so following it is caught.
// The share's name ends in .invalid, which never resolves (RFC 2606), as a second guard only.
const fake = vi.hoisted(() => {
  const state = { reached: [] as string[], linked: undefined as string | undefined };
  const TARGET = String.raw`\\tachi-test.invalid\share`;
  // As the plan defines it: \\ or // once resolved, except \\?\ or \\.\ before a drive letter, a local long path.
  const network = (p: string) => /^[\\/]{2}/.test(p) && !/^[\\/]{2}[?.][\\/][a-z]:\\/i.test(p);
  const twoPaths = new Set(["rename", "renameSync", "copyFile", "copyFileSync", "link", "linkSync", "symlink", "symlinkSync", "cp", "cpSync"]);
  const sameAs = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  function wrapAll(real: Record<string, unknown>, promises: boolean, resolve: (p: string) => string, dirname: (p: string) => string) {
    const linkDirent = { name: "linked", isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };
    const wrap = (name: string, fn: (...a: unknown[]) => unknown) => {
      const wrapped = function (this: unknown, ...args: unknown[]) {
        const paths = args
          .slice(0, twoPaths.has(name) ? 2 : 1)
          .filter((a): a is string => typeof a === "string")
          .map((p) => resolve(p));
        const linked = state.linked;
        for (const p of paths) {
          if (linked && sameAs(p, linked) && name === "lstatSync") return { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };
          if (linked && sameAs(p, linked) && name === "readlinkSync") return TARGET;
          if (network(p) || (linked && (sameAs(p, linked) || p.toLowerCase().startsWith(`${linked.toLowerCase()}\\`)))) {
            state.reached.push(`${name} ${p}`);
            const err = Object.assign(new Error(`ENOENT: no such file or directory, ${name} '${p}'`), { code: "ENOENT" });
            if (promises) return Promise.reject(err);
            throw err;
          }
        }
        const out = fn.apply(this, args);
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
const direct = (abs: string) => `${abs} is a network or device path outside the project, ${OPEN}`;
const through = (abs: string, link: string) => `${abs} leads through ${link} to a network or device path outside the project (${fake.TARGET}\\), ${OPEN}`;
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
      expect(await failure(searchFilesTool.run({ pattern: "x", path: "linked" }, ctx))).toBe(through(link, link));
      expect(ctx.asked).toEqual([]);
    }
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
  it("reads a long path (\\\\?\\C:\\) in the project, and asks for one outside it, as local paths", async () => {
    const ctx = await project("never");
    expect(await readFileTool.run({ path: `\\\\?\\${path.join(ctx.root, "a.txt")}` }, ctx)).toBe("     1\tfine");
    const other = await mkdtemp(path.join(tmpdir(), "tachi-outside-"));
    await mkdir(path.join(other, "sub"));
    await writeFile(path.join(other, "sub", "b.txt"), "elsewhere");
    const asking = await tempContext("ask", [false]);
    const long = `\\\\?\\${path.join(other, "sub", "b.txt")}`;
    expect(await failure(readFileTool.run({ path: long }, asking))).toBe(`The user declined: read ${long}`);
    expect(asking.asked).toEqual([`read ${long}`]);
    expect(fake.state.reached).toEqual([]);
  });
});
