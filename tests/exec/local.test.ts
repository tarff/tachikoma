import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalExecutor } from "../../src/exec/local.js";
import { tempContext } from "../helpers.js";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("LocalExecutor", () => {
  it("cancelling a command also stops the programs it started", async () => {
    const { root } = await tempContext();
    // A grandchild: the shell starts node, which records its pid and waits.
    await writeFile(path.join(root, "child.js"), `require("fs").writeFileSync("pid", String(process.pid)); setTimeout(() => {}, 60000);`);
    const abort = new AbortController();
    const run = new LocalExecutor().exec("node child.js", root, abort.signal);
    const pidFile = path.join(root, "pid");
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(alive(pid)).toBe(true);

    abort.abort();
    await expect(run).rejects.toThrow("Cancelled");
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
  }, 15_000);
});
