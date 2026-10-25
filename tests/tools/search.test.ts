import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TOOL_OUTPUT } from "../../src/exec/executor.js";
import { TOOLS } from "../../src/tools/index.js";
import { findFilesTool } from "../../src/tools/search.js";
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

describe("the lead's tools", () => {
  it("include find_files, shown on screen by its pattern", () => {
    expect(TOOLS.map((t) => t.spec.name)).toContain("find_files");
    expect(brief("find_files", { pattern: "src/**/*.ts" })).toBe("src/**/*.ts");
  });
});
