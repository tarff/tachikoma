import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { commandEnv } from "./env.js";
import { type ExecResult, type Executor, MAX_TOOL_OUTPUT } from "./executor.js";

export function shellFor(platform: NodeJS.Platform = process.platform): { name: string; argv: (command: string) => string[] } {
  if (platform === "win32") {
    return {
      name: "PowerShell",
      // Without this PowerShell writes the console code page, which garbles anything outside ASCII.
      argv: (c) => ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${c}`],
    };
  }
  return { name: "sh", argv: (c) => ["/bin/sh", "-c", c] };
}

// Stops the shell and everything it started. Killing only the shell would leave its children running.
// Runs even after the shell has exited: what it started may still be going.
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    // taskkill cannot find a tree whose root has exited, and Windows may already have given that pid
    // to an unrelated program, so it is only run while the shell is alive.
    if (child.exitCode === null && child.signalCode === null) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL"); // the shell leads its own process group (detached below)
    } catch {
      // ESRCH: the group is gone. Throwing here would crash Node from inside an abort listener.
    }
  }
}

// Detached commands are cut off from the terminal and would outlive us, so we stop them on exit.
const running = new Set<ChildProcess>();
process.on("exit", () => running.forEach(killTree));

// Keeps the first MAX_TOOL_OUTPUT characters and reads (and drops) the rest, so the command never
// blocks on a full pipe and a flood of output cannot exhaust memory.
function collect(stream: Readable): () => string {
  let text = "";
  let dropped = 0;
  stream.setEncoding("utf8"); // decodes characters split across chunks
  stream.on("data", (d: string) => {
    const room = MAX_TOOL_OUTPUT - text.length;
    text += d.slice(0, room);
    dropped += Math.max(0, d.length - room);
  });
  return () => (dropped ? `${text}\n[cut: ${dropped} more characters]` : text);
}

export class LocalExecutor implements Executor {
  exec(command: string, cwd: string, signal?: AbortSignal): Promise<ExecResult> {
    if (signal?.aborted) return Promise.reject(new Error("Cancelled"));
    const [file, ...args] = shellFor().argv(command);
    return new Promise((resolve, reject) => {
      // No stdin: a command waiting for input would otherwise wait forever.
      const child = spawn(file!, args, { cwd, env: commandEnv(), windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      running.add(child);
      const stdout = collect(child.stdout);
      const stderr = collect(child.stderr);
      const done = () => {
        running.delete(child);
        signal?.removeEventListener("abort", onAbort);
        child.off("close", onClose);
      };
      // Settles at once: "close" waits for every holder of the pipes, and a program the shell
      // started may hold them for good.
      const onAbort = () => {
        killTree(child);
        done();
        child.stdout.destroy();
        child.stderr.destroy();
        reject(new Error("Cancelled"));
      };
      const onClose = (code: number | null, sig: NodeJS.Signals | null) => {
        done();
        resolve({ code, signal: sig, stdout: stdout(), stderr: stderr() });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (e) => {
        done();
        reject(e);
      });
      child.on("close", onClose);
    });
  }

  readFile(abs: string): Promise<string> {
    return readFile(abs, "utf8");
  }

  async writeFile(abs: string, content: string): Promise<void> {
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
}
