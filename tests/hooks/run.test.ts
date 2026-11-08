import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { gitBash } from "../../src/exec/env.js";
import type { Hook } from "../../src/hooks/config.js";
import { runHook } from "../../src/hooks/run.js";
import { removeTree } from "../helpers.js";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Waits for a script to record a pid. An empty file reads as 0, which would mean our own process group.
async function readPid(file: string): Promise<number> {
  let pid = 0;
  for (let i = 0; i < 100 && !(pid > 0); i++) {
    await pause(50);
    pid = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
  }
  return pid;
}

// A folder of the test's own, removed when the test finishes. Windows keeps the folder a killed program worked in for a
// moment after it is gone (about 170 ms, measured 2026-10-31 for the shell tool's test), so the removal is tried every
// 50 ms, up to 2 s.
async function folder(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "tachi-hook-"));
  onTestFinished(async () => {
    for (let i = 0; ; i++) {
      try {
        return await removeTree(dir);
      } catch (err) {
        if (i === 40) throw err;
        await pause(50);
      }
    }
  });
  return dir;
}

// A hook in exec form: Node runs the script the test wrote, so no shell is needed (release 8b plan, "Rules").
async function nodeHook(source: string): Promise<{ hook: Hook; root: string }> {
  const root = await folder();
  writeFileSync(path.join(root, "hook.cjs"), source);
  return { hook: hookOf({ command: process.execPath, args: [path.join(root, "hook.cjs")] }), root };
}
const hookOf = (fields: Partial<Hook>): Hook => ({ event: "PreToolUse", matcher: { all: true }, command: "", async: false, where: '"PreToolUse"', ...fields });

describe("runHook", () => {
  it("writes its input whole to the hook's stdin and collects what it printed and its exit code", async () => {
    const { hook, root } = await nodeHook(`let text = "";
process.stdin.setEncoding("utf8").on("data", (d) => (text += d)).on("end", () => {
  const input = JSON.parse(text);
  console.log(input.hook_event_name, input.tool_input.command.length);
  console.error("to stderr");
  process.exit(3);
});`);
    // More than a pipe holds at once, so a part write would show.
    const input = { hook_event_name: "PreToolUse", tool_input: { command: "x".repeat(200_000) } };
    const ran = await runHook(hook, input, { cwd: root, env: process.env, limit: 30 });
    expect(ran).toMatchObject({ code: 3, stdout: "PreToolUse 200000\n", stderr: "to stderr\n" });
    expect(ran.failed).toBeUndefined();
    expect(ran.ms).toBeGreaterThan(0);
  }, 15_000);

  it("does not fail when the hook exits without reading its input", async () => {
    const { hook, root } = await nodeHook(`process.exit(0);`);
    const ran = await runHook(hook, { big: "x".repeat(1_000_000) }, { cwd: root, env: process.env, limit: 30 });
    expect(ran).toMatchObject({ code: 0, stdout: "" });
  }, 15_000);

  // Release 8b plan, choice 3, and the commands' own environment (commandEnv): no API keys.
  it("runs in the root given, with CLAUDE_PROJECT_DIR set to it, and without the API keys", async () => {
    const { hook, root } = await nodeHook(
      `console.log(JSON.stringify({ dir: process.env.CLAUDE_PROJECT_DIR, cwd: process.cwd(), key: process.env.OPENAI_API_KEY ?? null }));`,
    );
    const ran = await runHook(hook, {}, { cwd: root, env: { ...process.env, OPENAI_API_KEY: "sk-made-up" }, limit: 30 });
    expect(JSON.parse(ran.stdout)).toEqual({ dir: root, cwd: root, key: null });
  }, 15_000);

  it("kills a hook still running at its limit and reports the time", async () => {
    const { hook, root } = await nodeHook(`require("fs").writeFileSync(__dirname + "/pid", String(process.pid)); setTimeout(() => {}, 60000);`);
    const ran = await runHook(hook, {}, { cwd: root, env: process.env, limit: 1 });
    expect(ran).toMatchObject({ code: null, failed: "time" });
    expect(ran.ms).toBeGreaterThanOrEqual(1000);
    const pid = await readPid(path.join(root, "pid"));
    for (let i = 0; i < 40 && alive(pid); i++) await pause(50);
    expect(alive(pid)).toBe(false);
  }, 15_000);

  it("rejects with Cancelled when stopped, and stops what the hook started", async () => {
    // The hook starts a second Node, which records its pid and waits, then waits itself.
    const { hook, root } = await nodeHook(`const { spawn } = require("child_process");
spawn(process.execPath, ["-e", 'require("fs").writeFileSync("pid", String(process.pid)); setTimeout(() => {}, 60000)'], { stdio: "inherit" });
setTimeout(() => {}, 60000);`);
    const stop = new AbortController();
    const run = runHook(hook, {}, { cwd: root, env: process.env, limit: 30, signal: stop.signal });
    const pid = await readPid(path.join(root, "pid"));
    onTestFinished(() => {
      if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
    });
    expect(alive(pid)).toBe(true);
    stop.abort();
    await expect(run).rejects.toThrow("Cancelled");
    for (let i = 0; i < 40 && alive(pid); i++) await pause(50);
    expect(alive(pid)).toBe(false);
  }, 15_000);

  it("reports a hook that cannot start, with the reason", async () => {
    const root = await folder();
    const ran = await runHook(hookOf({ command: path.join(root, "no-such-program"), args: [] }), {}, { cwd: root, env: process.env, limit: 30 });
    expect(ran).toMatchObject({ code: null, failed: "start" });
    expect(ran.startError).toMatch(/ENOENT/);
  }, 15_000);

  // The user's choice, 2026-11-09: a command without a folder is found on PATH and started by its full path, so the
  // project folder, where the hook runs, is never searched for it first (review fixes plan, fix 1).
  // NoDefaultCurrentDirectoryInExePath, which Claude Code's own shell sets, stops Windows searching the working folder;
  // a user's terminal does not set it, so it is cleared here, or the test could not fail (seen 2026-11-09).
  it("starts a bare command found on PATH, never a program of that name in the project folder", async () => {
    vi.stubEnv("NoDefaultCurrentDirectoryInExePath", undefined);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const root = await folder();
    writeFileSync(path.join(root, process.platform === "win32" ? "node.exe" : "node"), ""); // looked up, never run
    const env = { SystemRoot: process.env.SystemRoot, PATH: path.dirname(process.execPath) };
    for (const command of process.platform === "win32" ? ["node", "node.exe"] : ["node"]) {
      const ran = await runHook(hookOf({ command, args: ["-e", "console.log(process.execPath)"] }), {}, { cwd: root, env, limit: 30 });
      expect(ran).toMatchObject({ code: 0, stdout: `${process.execPath}\n` });
    }
  }, 15_000);

  it("reports a bare command that is not on PATH as not found there", async () => {
    const root = await folder();
    const env = { SystemRoot: process.env.SystemRoot, PATH: root };
    const ran = await runHook(hookOf({ command: "tachi-no-such-program", args: [] }), {}, { cwd: root, env, limit: 30 });
    expect(ran).toMatchObject({ code: null, failed: "start", startError: "not found on PATH" });
  }, 15_000);

  // The one test that uses the real Git Bash, found as Tachikoma finds it, never a bare `bash`, which on Windows can be
  // WSL's (release 8b plan, choice 1).
  const bash = process.platform === "win32" ? gitBash() : null;
  it.skipIf(!bash)("runs a hook without args in Git Bash on Windows, never WSL's bash", async () => {
    const root = await folder();
    const ran = await runHook(hookOf({ command: "echo $0; command -v bash" }), {}, { cwd: root, env: process.env, limit: 30 });
    const [zero, found] = ran.stdout.trim().split("\n");
    expect(ran.code).toBe(0);
    expect(zero).toMatch(/bash/i);
    expect(found).toMatch(/bash/);
    expect(found!.toLowerCase()).not.toBe("/c/windows/system32/bash");
  }, 15_000);
});

describe("gitBash", () => {
  // Folders of the test's own; the files are empty, only looked up, never run. ProgramFiles and LOCALAPPDATA name empty
  // folders unless a test fills them, so the real ones are never read.
  async function machine() {
    const dir = await folder();
    const at = (...parts: string[]) => path.join(dir, ...parts);
    const file = (...parts: string[]) => {
      mkdirSync(path.dirname(at(...parts)), { recursive: true });
      writeFileSync(at(...parts), "");
      return at(...parts);
    };
    mkdirSync(at("pf"));
    mkdirSync(at("local"));
    const env: NodeJS.ProcessEnv = { PATH: "", ProgramFiles: at("pf"), LOCALAPPDATA: at("local") };
    return { at, file, env };
  }
  const windowsOnly = it.skipIf(process.platform !== "win32");

  windowsOnly("takes CLAUDE_CODE_GIT_BASH_PATH when it names bash.exe, sh.exe, bash or sh", async () => {
    const { file, env } = await machine();
    for (const name of ["bash.exe", "sh.exe", "bash", "sh"]) {
      const named = file("custom", name);
      expect(gitBash({ ...env, CLAUDE_CODE_GIT_BASH_PATH: named }, "win32")).toBe(named);
    }
  });

  windowsOnly("passes over CLAUDE_CODE_GIT_BASH_PATH naming another program or no file", async () => {
    const { at, file, env } = await machine();
    expect(gitBash({ ...env, CLAUDE_CODE_GIT_BASH_PATH: file("custom", "zsh.exe") }, "win32")).toBeNull();
    expect(gitBash({ ...env, CLAUDE_CODE_GIT_BASH_PATH: at("missing", "bash.exe") }, "win32")).toBeNull();
  });

  windowsOnly("takes bin\\bash.exe beside the folder of the first git.exe on PATH", async () => {
    const { at, file, env } = await machine();
    file("Git", "cmd", "git.exe");
    const bash = file("Git", "bin", "bash.exe");
    expect(gitBash({ ...env, PATH: at("Git", "cmd") }, "win32")).toBe(bash);
  });

  windowsOnly("then looks in ProgramFiles, then LOCALAPPDATA", async () => {
    const { file, env } = await machine();
    const local = file("local", "Programs", "Git", "bin", "bash.exe");
    expect(gitBash(env, "win32")).toBe(local);
    const programFiles = file("pf", "Git", "bin", "bash.exe");
    expect(gitBash(env, "win32")).toBe(programFiles);
  });

  windowsOnly("gives null when none is found", async () => {
    const { env } = await machine();
    expect(gitBash(env, "win32")).toBeNull();
  });

  it("gives null on other systems", async () => {
    const { file, env } = await machine();
    expect(gitBash({ ...env, CLAUDE_CODE_GIT_BASH_PATH: file("custom", "bash") }, "linux")).toBeNull();
  });
});
