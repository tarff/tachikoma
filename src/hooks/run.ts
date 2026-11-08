import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { errorText } from "../core/types.js";
import { commandEnv, gitBash } from "../exec/env.js";
import { collect, killTree, running, shellFor } from "../exec/local.js";
import type { Hook } from "./config.js";

// What one hook did: its exit code and what it printed, each stream cut as a command's is (collect, local.ts). `failed`
// says it never started, or was killed at its time limit; Task 3 (answer.ts) reads the rest.
export interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  failed?: "start" | "time";
  startError?: string;
}

// How a hook is started, as Claude Code starts it (release 8b design, "Running a hook"). With `args`, the command
// itself, without a shell, on every system; on Windows a .cmd or .bat cannot be started so (a known limit). Otherwise on
// Windows Git Bash, unless the hook asks for PowerShell or there is none (release 8b plan, choices 1 and 2), and then
// Windows PowerShell as the shell tool starts it; elsewhere sh, or bash when the hook asks for it.
export function shellOf(hook: Hook): { file: string; args: string[] } | { exec: true } {
  if (hook.args) return { exec: true };
  if (process.platform === "win32") {
    const bash = hook.shell === "powershell" ? null : gitBash();
    if (bash) return { file: bash, args: ["-c", hook.command] };
    const [file, ...args] = shellFor("win32").argv(hook.command);
    return { file: file!, args };
  }
  return { file: hook.shell === "bash" ? "bash" : "/bin/sh", args: ["-c", hook.command] };
}

// Runs one hook on the user's machine, never in the box, in `cwd`, the real project folder, which CLAUDE_PROJECT_DIR
// names under Claude Code's name, with the commands' environment (commandEnv), so it never sees the API keys (release
// 8b plan, choice 3). Its input is written whole to its stdin, which is then closed (choice 4). At `limit` seconds it is
// killed with all it started; a stop kills it the same way and rejects with Cancelled, as a command does (local.ts).
export function runHook(hook: Hook, input: object, opts: { cwd: string; env: NodeJS.ProcessEnv; limit: number; signal?: AbortSignal }): Promise<Ran> {
  if (opts.signal?.aborted) return Promise.reject(new Error("Cancelled"));
  const how = shellOf(hook);
  const [file, args] = "exec" in how ? [hook.command, hook.args!] : [how.file, how.args];
  const start = Date.now();
  const ms = () => Date.now() - start;
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      const env = { ...commandEnv(opts.env), CLAUDE_PROJECT_DIR: opts.cwd };
      child = spawn(file, args, { cwd: opts.cwd, env, windowsHide: true, detached: process.platform !== "win32", stdio: "pipe" });
    } catch (err) {
      // spawn throws at once for a command it cannot take at all, such as an empty one.
      resolve({ code: null, stdout: "", stderr: "", ms: ms(), failed: "start", startError: errorText(err) });
      return;
    }
    running.add(child);
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    const ran = (more: Partial<Ran>): Ran => ({ code: null, stdout: stdout(), stderr: stderr(), ms: ms(), ...more });
    const done = () => {
      clearTimeout(timer);
      running.delete(child);
      opts.signal?.removeEventListener("abort", onAbort);
      child.off("close", onClose);
    };
    // Settles at once, as a command does (local.ts): "close" waits for every holder of the pipes, and a program the hook
    // started may hold them for good.
    const kill = () => {
      killTree(child);
      done();
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => {
      kill();
      resolve(ran({ failed: "time" }));
    }, opts.limit * 1000);
    const onAbort = () => {
      kill();
      reject(new Error("Cancelled"));
    };
    const onClose = (code: number | null) => {
      done();
      resolve(ran({ code }));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      done();
      resolve(ran({ failed: "start", startError: errorText(err) }));
    });
    child.on("close", onClose);
    // A hook may exit without reading its input, which makes this write fail (EPIPE, or EOF on Windows, seen in its
    // test); that is the hook's choice, and unheard the error would end Tachikoma.
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  });
}
