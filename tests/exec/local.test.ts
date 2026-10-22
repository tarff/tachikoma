import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { MAX_TOOL_OUTPUT } from "../../src/exec/executor.js";
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

// Waits for a script to record its pid. An empty file reads as 0, which would mean our own process group.
async function readPid(file: string): Promise<number> {
  let pid = 0;
  for (let i = 0; i < 100 && !(pid > 0); i++) {
    await new Promise((r) => setTimeout(r, 50));
    pid = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
  }
  return pid;
}

// Scripts are written to files so the same command works in sh and PowerShell.
async function script(source: string): Promise<string> {
  const { root } = await tempContext();
  await writeFile(path.join(root, "script.js"), source);
  return root;
}

describe("LocalExecutor", () => {
  it("cancelling a command also stops the programs it started", async () => {
    const { root } = await tempContext();
    // A grandchild: the shell starts node, which records its pid and waits.
    await writeFile(path.join(root, "child.js"), `require("fs").writeFileSync("pid", String(process.pid)); setTimeout(() => {}, 60000);`);
    const abort = new AbortController();
    const run = new LocalExecutor().exec("node child.js", root, abort.signal);
    const pid = await readPid(path.join(root, "pid"));
    expect(alive(pid)).toBe(true);

    abort.abort();
    await expect(run).rejects.toThrow("Cancelled");
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
  }, 15_000);

  it("cancel returns even when a program the shell started still holds the output pipes", async () => {
    const { root } = await tempContext();
    await writeFile(path.join(root, "grandchild.js"), `require("fs").writeFileSync("pid", String(process.pid)); setTimeout(() => {}, 60000);`);
    // The launcher leaves the grandchild running on its inherited pipes and exits. On POSIX it is not
    // detached, so it stays in the shell's process group. On Windows it must be, or Node kills it when
    // the launcher exits.
    await writeFile(
      path.join(root, "launcher.js"),
      `require("child_process").spawn(process.execPath, ["grandchild.js"], { stdio: "inherit", detached: process.platform === "win32" }).unref();`,
    );
    const abort = new AbortController();
    const run = new LocalExecutor().exec("node launcher.js", root, abort.signal);
    const pid = await readPid(path.join(root, "pid"));
    onTestFinished(() => {
      if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
    });
    expect(pid).toBeGreaterThan(0);

    abort.abort();
    await expect(run).rejects.toThrow("Cancelled");
    // Windows cannot find a tree whose root has exited, so the grandchild survives there.
    if (process.platform !== "win32") {
      for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
      expect(alive(pid)).toBe(false);
    }
  }, 15_000);

  it("gives commands no input, so ones that read to the end of input finish", async () => {
    const root = await script(`process.stdin.resume(); process.stdin.on("end", () => console.log("eof"));`);
    const r = await new LocalExecutor().exec("node script.js", root);
    expect(r.stdout).toContain("eof");
  }, 15_000);

  it("keeps at most MAX_TOOL_OUTPUT characters of a stream and says how much it cut", async () => {
    const root = await script(`process.stdout.write("x".repeat(${MAX_TOOL_OUTPUT * 3}));`);
    const r = await new LocalExecutor().exec("node script.js", root);
    const [kept, marker] = r.stdout.split("\n[cut: ");
    expect(kept).toBe("x".repeat(MAX_TOOL_OUTPUT));
    expect(marker).toMatch(/^\d+ more characters\]$/);
  }, 15_000);

  it("does not pass the API keys to commands", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-secret");
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const root = await script(`console.log(process.env.OPENAI_API_KEY ?? "none", process.env.PATH ? "path" : "no path");`);
    const r = await new LocalExecutor().exec("node script.js", root);
    expect(r.stdout.trim()).toBe("none path");
  }, 15_000);

  it("decodes characters split across chunks", async () => {
    // 3 bytes each, so some are certain to straddle a chunk boundary.
    const root = await script(`process.stdout.write("€".repeat(300000));`);
    const r = await new LocalExecutor().exec("node script.js", root);
    const [kept] = r.stdout.split("\n[cut: ");
    expect(r.stdout).not.toContain("�");
    expect(kept).toBe("€".repeat(MAX_TOOL_OUTPUT));
  }, 15_000);
});
