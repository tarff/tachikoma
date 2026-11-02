import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Release 7 plan, Task 14: the file tools, the @ menu and the App's areas reach the project's files through the
// Workspace (src/exec/workspace.ts), so in the sandbox nothing on the host opens a path in the box's folder. Each line
// there that names node:fs is listed here, with its reason: a new one fails, and so does a listed one that has gone.
const ALLOWED: Record<string, { lines: string[]; why: string }> = {
  "tools/files.ts": {
    lines: ['import { type BigIntStats, existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";'],
    why:
      "resolveIn and its checks on the host, for LocalWorkspace.resolve and the instruction files at launch; and protectedOf's look for another " +
      "name of a write's real place",
  },
  "tools/search.ts": {
    lines: [
      'import type { BigIntStats } from "node:fs";',
      'import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";',
      'const { readFileSync } = process.getBuiltinModule("node:fs");',
    ],
    why: "the walk and the search on the host, with the search's worker, which only LocalWorkspace calls (filesIn, findIn, searchIn)",
  },
  "tui/menus.ts": {
    lines: ['import { lstatSync, readdirSync, statSync } from "node:fs";'],
    why:
      "listEntries, LocalWorkspace's list; and listFolder, the @ menu's listing, synchronous until the user chooses how the menu waits for the " +
      "Workspace (Task 14's report)",
  },
  "tui/app/constants.ts": {
    lines: ['import { statSync } from "node:fs";'],
    why: "isFile, whether a pasted path is a file, synchronous so a paste is pictures or text before the next key (Task 14's report)",
  },
  "tui/app/handover.tsx": {
    lines: ['import { mkdirSync, writeFileSync } from "node:fs";'],
    why: "/settings and /keybindings make a missing file in the settings folder, not in the project",
  },
};

const src = fileURLToPath(new URL("../../src/", import.meta.url));
const NAMES_FS = /["'](?:node:)?fs(?:\/promises)?["']/;
// The modules in `folder` and the folders in it, by their paths from src with forward slashes.
const inFolder = (folder: string) =>
  readdirSync(path.join(src, folder), { recursive: true, encoding: "utf8" })
    .filter((f) => /[.]tsx?$/.test(f))
    .map((f) => `${folder}/${f.split(path.sep).join("/")}`);

describe("the Workspace's callers", () => {
  it("name node:fs only in the lines allowed, each for its reason", () => {
    const found: Record<string, string[]> = {};
    for (const m of [...inFolder("tools"), "tui/menus.ts", ...inFolder("tui/app")]) {
      const lines = readFileSync(path.join(src, m), "utf8").split(/\r?\n/).filter((l) => NAMES_FS.test(l)).map((l) => l.trim());
      if (lines.length) found[m] = lines;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(ALLOWED).map(([m, a]) => [m, a.lines])));
  });
});
