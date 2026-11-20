import { existsSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearDontAsk, dontAsk, recordDontAsk } from "../../src/memory/asked.js";
import { memoryPaths } from "../../src/memory/paths.js";
import { removeTree } from "../helpers.js";

// "Don't ask again" (8d plan, step 27; Q12): one small private file in <data folder>/memory/, kept until /memory setup
// clears it. Every folder is one the test made.

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await removeTree(folder);
});

async function paths() {
  const top = await mkdtemp(path.join(tmpdir(), "tachi-asked-"));
  folders.push(top);
  return memoryPaths(path.join(top, "data"), "test");
}

// The first privateDir of a new folder takes about 3.2 s on Windows (step 9's measurement).
describe("the \"Don't ask again\" record", { timeout: 15_000 }, () => {
  it("is not there at first, and makes nothing by being asked", async () => {
    const p = await paths();
    expect(dontAsk(p)).toBe(false);
    expect(existsSync(p.root)).toBe(false);
  });

  it("is kept in one file in the memory folder once recorded, and read by a later launch", async () => {
    const p = await paths();
    recordDontAsk(p);
    expect(readdirSync(p.root)).toEqual(["dont-ask"]);
    expect(dontAsk(memoryPaths(path.dirname(p.root), "test"))).toBe(true);
  });

  it("is gone once cleared, and clearing none is no error", async () => {
    const p = await paths();
    clearDontAsk(p);
    recordDontAsk(p);
    clearDontAsk(p);
    expect(dontAsk(p)).toBe(false);
    expect(readdirSync(p.root)).toEqual([]);
  });

  it("is written again over one already there", async () => {
    const p = await paths();
    recordDontAsk(p);
    recordDontAsk(p);
    expect(dontAsk(p)).toBe(true);
    expect(readdirSync(p.root)).toEqual(["dont-ask"]);
  });
});
