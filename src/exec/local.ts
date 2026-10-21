import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExecResult, Executor } from "./executor.js";

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
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  else process.kill(-child.pid, "SIGKILL"); // the shell leads its own process group (detached below)
}

export class LocalExecutor implements Executor {
  exec(command: string, cwd: string, signal?: AbortSignal): Promise<ExecResult> {
    if (signal?.aborted) return Promise.reject(new Error("Cancelled"));
    const [file, ...args] = shellFor().argv(command);
    return new Promise((resolve, reject) => {
      const child = spawn(file!, args, { cwd, windowsHide: true, detached: process.platform !== "win32" });
      let stdout = "";
      let stderr = "";
      const onAbort = () => killTree(child);
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) reject(new Error("Cancelled"));
        else resolve({ code, stdout, stderr });
      });
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
