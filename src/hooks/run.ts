import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { errorText } from "../core/types.js";
import { commandEnv, gitBash, onPath } from "../exec/env.js";
import { collect, killTree, running, shellFor } from "../exec/local.js";
import type { Servers } from "../mcp/servers.js";
import { answerText } from "../mcp/tools.js";
import { type Hook, isObject, MAX_TIMER_MS, type McpCall } from "./config.js";
import { own } from "./tools.js";

// What one hook did: its exit code and what it printed, its stdout whole and its stderr cut as a command's is. `failed`
// says it never started, or was killed at its time limit; Task 3 (answer.ts) reads the rest. `limit` is the limit in
// force, kept with "time", and `signal` what ended a hook that left no exit code, both for the failure's line. An
// mcp_tool hook's (callHook) has two more: "call", its server could not be called, and "error", an error answer, each
// with its `reason`, the words why or the answer's text.
export interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  failed?: "start" | "time" | "call" | "error";
  startError?: string;
  limit?: number;
  signal?: string;
  reason?: string;
}

// The exit code, or the signal when there is none (the user's choice at Task 3: a failure names its signal).
export function closeOf(code: number | null, signal: NodeJS.Signals | null): Pick<Ran, "code" | "signal"> {
  return code === null && signal ? { code, signal } : { code };
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
    // shellFor keeps a failed program's exit code, so a hook's 2 still blocks (PR #14's review).
    const [file, ...args] = shellFor("win32").argv(hook.command);
    return { file: file!, args };
  }
  return { file: hook.shell === "bash" ? "bash" : "/bin/sh", args: ["-c", hook.command] };
}

// An exec-form command, or a shell, without a folder in it, by its full path from the hook's PATH (onPath), or undefined
// when it is not there. Started by its bare name, Windows would look in the project folder, where the hook runs, first
// (the user's choice, 2026-11-09; review fixes plan, fix 1), and elsewhere a PATH entry that is empty or "." names that
// folder too, which matters for the shell `bash` (Task 2's review). As onPath does, only `<name>.exe` is looked for on
// Windows, so `node` and `node.exe` are the same. onPath serves every system, as it does for git and docker; a command
// with a folder in it is used as written.
export function program(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (process.platform !== "win32") return command.includes("/") ? command : onPath(command, env);
  return /[\\/]|^[a-z]:/i.test(command) ? command : onPath(command.replace(/\.exe$/i, ""), env);
}

// Runs one hook on the user's machine, never in the box, in `cwd`, the real project folder, which CLAUDE_PROJECT_DIR
// names under Claude Code's name, with the commands' environment (commandEnv), so it never sees the API keys (release
// 8b plan, choice 3). Its input is written whole to its stdin, which is then closed (choice 4). At `limit` seconds it is
// killed with all it started; a stop kills it the same way and rejects with Cancelled, as a command does (local.ts).
export function runHook(hook: Hook, input: object, opts: { cwd: string; env: NodeJS.ProcessEnv; limit: number; signal?: AbortSignal }): Promise<Ran> {
  if (opts.signal?.aborted) return Promise.reject(new Error("Cancelled"));
  const start = Date.now();
  const ms = () => Date.now() - start;
  const env = { ...commandEnv(opts.env), CLAUDE_PROJECT_DIR: opts.cwd };
  const how = shellOf(hook);
  const [command, args] = "exec" in how ? [hook.command, hook.args!] : [how.file, how.args];
  const file = program(command, env);
  if (file === undefined) return Promise.resolve({ code: null, stdout: "", stderr: "", ms: ms(), failed: "start", startError: "not found on PATH" });
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(file, args, { cwd: opts.cwd, env, windowsHide: true, detached: process.platform !== "win32", stdio: "pipe" });
    } catch (err) {
      // spawn throws at once for what it cannot take at all: a null byte in the command or its args, or on Windows a
      // .cmd or .bat given by its full path, which Node will not start without a shell (EINVAL, seen in its test).
      resolve({ code: null, stdout: "", stderr: "", ms: ms(), failed: "start", startError: errorText(err) });
      return;
    }
    running.add(child);
    // Its stdout is read whole, so a long JSON answer is never cut into one that cannot be read; answer.ts cuts each text
    // it hands on (the user's choice, 2026-11-09). A known limit: a runaway hook's output is held in memory until its
    // time limit. Its error output is cut as a command's is.
    const stdout = collect(child.stdout, Infinity);
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
      resolve(ran({ failed: "time", limit: opts.limit }));
    }, opts.limit * 1000);
    const onAbort = () => {
      kill();
      reject(new Error("Cancelled"));
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      done();
      resolve(ran(closeOf(code, signal)));
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

// Runs one mcp_tool hook (release 8c plan, Task 8; design, "Hooks"): `call.tool` on the server `call.server`, straight
// through `servers`, never the session's tool path, so no tool hook fires for it and nobody is asked (design, finding
// 3). Only a running server is called; one is never started, signed in to or connected again here. On an event that can
// block (`wait`) a server still starting is waited for within the hook's limit (choice 21); else it is not running. At
// `limit` seconds the wait or the call is stopped, and a stop ends it the same way and rejects with Cancelled, as a
// command does; the library tells the server of a call it stops (notifications/cancelled). Its text is read as a command
// hook's printed output, with exit code 0 (choice 21; Claude Code's hooks reference).
export function callHook(call: McpCall, input: object, opts: { servers?: Servers; limit: number; signal?: AbortSignal; wait: boolean }): Promise<Ran> {
  if (opts.signal?.aborted) return Promise.reject(new Error("Cancelled"));
  const start = Date.now();
  const ran = (more: Partial<Ran>): Ran => ({ code: null, stdout: "", stderr: "", ms: Date.now() - start, ...more });
  const notRunning = () => ran({ failed: "call", reason: `${call.server} is not running` });
  const stop = new AbortController();
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    stop.abort();
  }, opts.limit * 1000);
  const onAbort = () => stop.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  // A stop wins over the limit, as it is the user's.
  const ended = () => {
    if (opts.signal?.aborted) throw new Error("Cancelled");
    return late ? ran({ failed: "time", limit: opts.limit }) : undefined;
  };
  return (async () => {
    try {
      const { servers } = opts;
      if (opts.wait && servers?.server(call.server)?.state.is === "starting") await servers.started(call.server, stop.signal);
      const over = ended();
      if (over) return over;
      const server = servers?.server(call.server);
      if (server?.state.is !== "ready") return notRunning();
      let result: Awaited<ReturnType<typeof server.callTool>>;
      try {
        // The hook's own timer is its limit, so the library is given the longest wait, not the server entry's.
        result = await server.callTool(call.tool, fill(call.input, input) as object, { signal: stop.signal, timeout: MAX_TIMER_MS });
      } catch (err) {
        const over = ended();
        if (over) return over;
        // A server that stopped during the call, or a request that never reached it, is not running; anything else is the
        // server's answer, such as MCP's error for a tool it does not have.
        return server.state.is === "ready" ? ran({ failed: "error", reason: errorText(err) }) : notRunning();
      }
      // Its text as the model reads an answer's, without the pictures and the lines naming the other kinds (mcp/tools.ts).
      const text = answerText(result);
      return result.isError ? ran({ failed: "error", reason: text }) : ran({ code: 0, stdout: text });
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  })();
}

// Choice 22: each ${path} in the input's text is a dotted path into the hook's input, such as ${tool_input.file_path};
// a path that is not there, or is null, becomes empty text, an object or a list its JSON text, anything else its text.
// Keys and values that are not text are kept as written.
function fill(value: unknown, from: object): unknown {
  if (typeof value === "string") return value.replace(/\$\{([^}]*)\}/g, (_, p: string) => textOf(lookup(from, p)));
  if (Array.isArray(value)) return value.map((v) => fill(v, from));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, from)]));
  return value;
}

// Each step an own field, as tools.ts looks one up, so "constructor" or "__proto__" in a path finds nothing.
const lookup = (from: unknown, p: string): unknown =>
  p.split(".").reduce<unknown>((at, key) => (typeof at === "object" && at !== null ? own(at as Record<string, unknown>, key) : undefined), from);
const textOf = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
