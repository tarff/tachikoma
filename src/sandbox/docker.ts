// Docker itself, for the sandbox (release 7 design, "The sandbox"; plan, Task 11). Every Docker command goes through a
// DockerRun, which tests replace with a stand-in that records its calls and gives set answers (choice 69), so no test
// writes or runs a fake docker program, or changes PATH.
import { spawn } from "node:child_process";
import { commandEnv, onPath } from "../exec/env.js";

// One docker run: its exit code and output, or "missing" when no docker program is on PATH. `line` gets each line of
// stdout and stderr as it comes, for a build's progress; `input` goes to its stdin.
export type DockerRun = (
  args: string[],
  opts?: { line?: (line: string) => void; input?: Buffer; signal?: AbortSignal },
) => Promise<{ code: number; out: string; err: string } | "missing">;

// The real docker, by its full path (onPath), never by its bare name, with the environment commands get, without the API
// keys. It rejects when docker cannot be started, is stopped by the signal, or is ended by a signal.
export const docker: DockerRun = (args, opts = {}) => {
  const exe = onPath("docker");
  if (!exe) return Promise.resolve("missing");
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env: commandEnv(), windowsHide: true, signal: opts.signal, stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const outLines = opts.line && lineSplitter(opts.line);
    const errLines = opts.line && lineSplitter(opts.line);
    child.stdout!.setEncoding("utf8").on("data", (d: string) => {
      out += d;
      outLines?.add(d);
    });
    child.stderr!.setEncoding("utf8").on("data", (d: string) => {
      err += d;
      errLines?.add(d);
    });
    // A docker that exits before reading all its stdin makes the write fail; its exit code says what went wrong.
    child.stdin?.on("error", () => {}).end(opts.input);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      outLines?.end();
      errLines?.end();
      if (code === null) reject(new Error(`docker was ended by ${signal}`));
      else resolve({ code, out, err });
    });
  });
};

// Whether Docker can be used (Task 16's launch order: Docker's state comes before the image). The client asks the server for
// its version, and fails when the server is not running.
export async function dockerState(run: DockerRun = docker): Promise<"ready" | "missing" | "stopped"> {
  const got = await run(["version", "--format", "{{.Server.Version}}"]);
  if (got === "missing") return "missing";
  return got.code === 0 ? "ready" : "stopped";
}

// Output cut into lines as it comes: each whole line is given without its line ending, and `end` gives what is left
// when the output did not end with one.
export function lineSplitter(line: (line: string) => void) {
  let held = "";
  return {
    add(text: string) {
      const parts = (held + text).split(/\r?\n/);
      held = parts.pop()!;
      for (const part of parts) line(part);
    },
    end() {
      if (held) line(held);
      held = "";
    },
  };
}
