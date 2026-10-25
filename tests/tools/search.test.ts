import { spawnSync } from "node:child_process";
import { linkSync } from "node:fs";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TOOL_OUTPUT } from "../../src/exec/executor.js";
import { TOOLS } from "../../src/tools/index.js";
import { findFilesTool, searchFilesTool } from "../../src/tools/search.js";
import { brief } from "../../src/tui/describe.js";
import { tempContext } from "../helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

// Writes each file, making its folders, under `root`.
async function files(root: string, tree: Record<string, string>) {
  for (const [p, text] of Object.entries(tree)) {
    await mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await writeFile(path.join(root, p), text);
  }
}

describe("find_files", () => {
  it("lists the files whose path matches, sorted, with forward slashes", async () => {
    const ctx = await tempContext();
    await files(ctx.root, { "src/b.ts": "", "src/a.ts": "", "src/core/c.ts": "", "src/d.js": "", "e.ts": "" });
    expect(await findFilesTool.run({ pattern: "src/**/*.ts" }, ctx)).toBe("src/a.ts\nsrc/b.ts\nsrc/core/c.ts");
    expect(await findFilesTool.run({ pattern: "*.ts" }, ctx)).toBe("e.ts");
    expect(await findFilesTool.run({ pattern: "**/*.ts" }, ctx)).toBe("e.ts\nsrc/a.ts\nsrc/b.ts\nsrc/core/c.ts");
  });

  it("takes a pattern written with backslashes", async () => {
    const ctx = await tempContext();
    await files(ctx.root, { "src/core/c.ts": "" });
    expect(await findFilesTool.run({ pattern: "src\\**\\*.ts" }, ctx)).toBe("src/core/c.ts");
  });

  it("matches a name starting with a dot only when the pattern names the dot, as a shell does", async () => {
    const ctx = await tempContext();
    await files(ctx.root, { ".github/workflows/ci.yml": "", "a.yml": "" });
    expect(await findFilesTool.run({ pattern: "**/*.yml" }, ctx)).toBe("a.yml");
    expect(await findFilesTool.run({ pattern: ".github/**/*.yml" }, ctx)).toBe(".github/workflows/ci.yml");
  });

  it("says when nothing matches", async () => {
    const ctx = await tempContext();
    await files(ctx.root, { "a.ts": "" });
    expect(await findFilesTool.run({ pattern: "**/*.py" }, ctx)).toBe("No files match **/*.py");
  });

  it("skips .git and what the .gitignore files list, a folder's own rules over its parents'", async () => {
    const ctx = await tempContext();
    await files(ctx.root, {
      ".git/config": "",
      ".gitignore": "*.log\nbuild/\n",
      "a.log": "",
      "a.txt": "",
      "build/out.txt": "",
      "sub/.gitignore": "!keep.log\nsecret.txt\n",
      "sub/keep.log": "",
      "sub/drop.log": "",
      "sub/secret.txt": "",
      "sub/fine.txt": "",
    });
    expect(await findFilesTool.run({ pattern: "**/*" }, ctx)).toBe(["a.txt", "sub/fine.txt", "sub/keep.log"].join("\n"));
  });

  it("does not look inside a folder the rules leave out, as git does not", async () => {
    // git cannot bring back a file whose folder is ignored, so neither does the walk.
    const ctx = await tempContext();
    await files(ctx.root, { ".gitignore": "node_modules/\n!node_modules/x/keep.ts\n", "node_modules/x/keep.ts": "", "a.ts": "" });
    expect(await findFilesTool.run({ pattern: "**/*.ts" }, ctx)).toBe("a.ts");
  });

  it("ignores a .gitignore line that does not parse, as git does", async () => {
    const ctx = await tempContext();
    await files(ctx.root, { ".gitignore": "[\n*.log\n", "a.log": "", "[": "", "b.txt": "" });
    expect(await findFilesTool.run({ pattern: "**/*" }, ctx)).toBe(["[", "b.txt"].join("\n"));
  });

  it("follows no links or junctions", async () => {
    const ctx = await tempContext();
    const elsewhere = await mkdtemp(path.join(tmpdir(), "tachi-outside-"));
    await files(elsewhere, { "far.ts": "" });
    await files(ctx.root, { "near.ts": "" });
    // A junction needs no special rights on Windows; on other systems this makes a directory symlink.
    await symlink(elsewhere, path.join(ctx.root, "linked"), "junction");
    await symlink(ctx.root, path.join(ctx.root, "loop"), "junction");
    expect(await findFilesTool.run({ pattern: "**/*.ts" }, ctx)).toBe("near.ts");
  });

  it("skips Tachikoma's data folder inside the project", async () => {
    const ctx = await tempContext();
    await files(ctx.root, { "data/chatgpt.json": "{}", "a.json": "" });
    vi.stubEnv("TACHI_DATA_DIR", path.join(ctx.root, "data"));
    expect(await findFilesTool.run({ pattern: "**/*.json" }, ctx)).toBe("a.json");
  });

  it("refuses a project inside the data folder", async () => {
    const ctx = await tempContext();
    vi.stubEnv("TACHI_DATA_DIR", ctx.root);
    await expect(findFilesTool.run({ pattern: "**/*" }, ctx)).rejects.toThrow("Tachikoma's data folder");
  });

  it("cuts a long list and says how many more there were", async () => {
    const ctx = await tempContext();
    const name = (n: number) => `${String(n).padStart(3, "0")}${"x".repeat(140)}.txt`;
    await files(ctx.root, Object.fromEntries(Array.from({ length: 250 }, (_, n) => [name(n), ""])));
    const out = await findFilesTool.run({ pattern: "*.txt" }, ctx);
    expect(out.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT);
    const shown = out.split("\n").slice(0, -1);
    expect(shown[0]).toBe(name(0));
    expect(out.split("\n").at(-1)).toBe(`(${250 - shown.length} more files not shown)`);
  });

  it("stops when the turn is stopped", async () => {
    const ctx = await tempContext();
    await files(ctx.root, { "a.ts": "" });
    const stop = new AbortController();
    stop.abort();
    await expect(findFilesTool.run({ pattern: "**/*" }, { ...ctx, signal: stop.signal })).rejects.toThrow();
  });
});

describe("search_files", () => {
  it("gives each matching line as path:line: text, in path order", async () => {
    const ctx = await tempContext();
    await files(ctx.root, { "src/b.ts": "one\nlogin()\n", "src/a.ts": "login\r\nother\r\nre-login\r\n", "c.md": "nothing" });
    expect(await searchFilesTool.run({ pattern: "log+in" }, ctx)).toBe("src/a.ts:1: login\nsrc/a.ts:3: re-login\nsrc/b.ts:2: login()");
  });

  it("narrows to a folder or one file with path, and by name with glob", async () => {
    const ctx = await tempContext();
    await files(ctx.root, { "src/a.ts": "x", "src/a.js": "x", "lib/b.ts": "x", "src/deep/c.ts": "x" });
    expect(await searchFilesTool.run({ pattern: "x", path: "src" }, ctx)).toBe("src/a.js:1: x\nsrc/a.ts:1: x\nsrc/deep/c.ts:1: x");
    expect(await searchFilesTool.run({ pattern: "x", path: "src/a.ts" }, ctx)).toBe("src/a.ts:1: x");
    expect(await searchFilesTool.run({ pattern: "x", glob: "*.ts" }, ctx)).toBe("lib/b.ts:1: x\nsrc/a.ts:1: x\nsrc/deep/c.ts:1: x");
    // A glob with a slash in it is matched against the path.
    expect(await searchFilesTool.run({ pattern: "x", glob: "src/*.ts" }, ctx)).toBe("src/a.ts:1: x");
  });

  it("keeps the project's .gitignore rules when narrowed to a folder or a file", async () => {
    const ctx = await tempContext();
    await files(ctx.root, { ".gitignore": "*.gen.ts\n", "src/a.ts": "x", "src/a.gen.ts": "x" });
    expect(await searchFilesTool.run({ pattern: "x", path: "src" }, ctx)).toBe("src/a.ts:1: x");
    expect(await searchFilesTool.run({ pattern: "x", path: "src/a.gen.ts" }, ctx)).toBe("No lines match x");
  });

  it("skips binary files", async () => {
    const ctx = await tempContext();
    await files(ctx.root, { "a.txt": "needle" });
    await writeFile(path.join(ctx.root, "b.bin"), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]));
    expect(await searchFilesTool.run({ pattern: "needle" }, ctx)).toBe("a.txt:1: needle");
  });

  it("asks before searching outside the project", async () => {
    const ctx = await tempContext("project", [false, true]);
    const elsewhere = await mkdtemp(path.join(tmpdir(), "tachi-outside-"));
    await files(elsewhere, { "notes.txt": "secret" });
    await expect(searchFilesTool.run({ pattern: "secret", path: elsewhere }, ctx)).rejects.toThrow("The user declined");
    expect(await searchFilesTool.run({ pattern: "secret", path: elsewhere }, ctx)).toBe(`${path.join(await realpath(elsewhere), "notes.txt")}:1: secret`);
    expect(ctx.asked).toEqual([`search ${path.resolve(elsewhere)}`, `search ${path.resolve(elsewhere)}`]);
  });

  it("refuses the data folder in every mode", async () => {
    const ctx = await tempContext("never");
    await files(ctx.root, { "data/chatgpt.json": "token" });
    vi.stubEnv("TACHI_DATA_DIR", path.join(ctx.root, "data"));
    await expect(searchFilesTool.run({ pattern: "token", path: "data" }, ctx)).rejects.toThrow("Tachikoma's data folder");
    expect(await searchFilesTool.run({ pattern: "token" }, ctx)).toBe("No lines match token");
  });

  it("skips a hard link to one of the data folder's files, as read_file refuses it", async () => {
    const ctx = await tempContext();
    await files(ctx.root, { "data/chatgpt.json": "token", "a.txt": "token" });
    vi.stubEnv("TACHI_DATA_DIR", path.join(ctx.root, "data"));
    linkSync(path.join(ctx.root, "data", "chatgpt.json"), path.join(ctx.root, "innocent.json"));
    expect(await searchFilesTool.run({ pattern: "token" }, ctx)).toBe("a.txt:1: token");
  });

  it("says when the pattern is not a regular expression", async () => {
    const ctx = await tempContext();
    await expect(searchFilesTool.run({ pattern: "a(" }, ctx)).rejects.toThrow("a( is not a regular expression");
  });

  it("cuts long output and says how many more lines there were", async () => {
    const ctx = await tempContext();
    await files(ctx.root, { "a.txt": Array.from({ length: 2000 }, (_, n) => `match ${n} ${"y".repeat(20)}`).join("\n") });
    const out = await searchFilesTool.run({ pattern: "match" }, ctx);
    expect(out.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT);
    const shown = out.split("\n").slice(0, -1);
    expect(shown[0]).toBe(`a.txt:1: match 0 ${"y".repeat(20)}`);
    expect(out.split("\n").at(-1)).toBe(`(${2000 - shown.length} more matching lines not shown)`);
  });

  it("cuts a matching line at 1,000 characters, saying how many more it had", async () => {
    const ctx = await tempContext();
    const long = `match ${"y".repeat(MAX_TOOL_OUTPUT)}`;
    const whole = `match ${"z".repeat(994)}`; // 1,000 characters
    await files(ctx.root, { "a.txt": long, "b.txt": whole });
    const cut = `${long.slice(0, 1000)} [cut: ${long.length - 1000} more characters]`;
    expect(await searchFilesTool.run({ pattern: "match" }, ctx)).toBe(`a.txt:1: ${cut}\nb.txt:1: ${whole}`);
  });

  it("works when Node runs the worker's code as a module, as a flag such as --input-type=module makes it", { timeout: 15_000 }, async () => {
    // The worker inherits the flags Node started with. Each start takes about a second; 15 s, as for
    // the other tests that start processes (tests/cli.test.ts).
    const ctx = await tempContext();
    await files(ctx.root, { "a.txt": "needle" });
    const url = (p: string) => JSON.stringify(pathToFileURL(path.resolve(p)).href);
    const script = [
      `import { searchFilesTool } from ${url("src/tools/search.ts")};`,
      `import { PermissionGate } from ${url("src/core/permissions.ts")};`,
      `console.log(await searchFilesTool.run({ pattern: "needle" }, { root: process.argv[1], gate: new PermissionGate("project", async () => false) }));`,
    ].join("\n");
    const r = spawnSync(process.execPath, ["--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href, "--input-type=module", "-e", script, ctx.root], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("a.txt:1: needle");
  });

  it("stops a pattern that would take practically forever when the turn is stopped", async () => {
    // (a+)+$ on 28 letters and a b took 20 s on 2026-10-26; each letter more about doubles it.
    const ctx = await tempContext();
    await files(ctx.root, { "a.txt": `${"a".repeat(40)}b` });
    const stop = new AbortController();
    const started = Date.now();
    setTimeout(() => stop.abort(), 300);
    await expect(searchFilesTool.run({ pattern: "(a+)+$" }, { ...ctx, signal: stop.signal })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("the lead's tools", () => {
  it("include the search tools, shown on screen by their pattern", () => {
    expect(TOOLS.map((t) => t.spec.name)).toEqual(expect.arrayContaining(["find_files", "search_files"]));
    expect(brief("find_files", { pattern: "src/**/*.ts" })).toBe("src/**/*.ts");
    expect(brief("search_files", { pattern: "log+in", path: "src" })).toBe("log+in");
  });
});
