// The box server's stand-in Docker (8c-2a plan, Task 4), given as McpBox.program, so no docker program is written or
// put on PATH: node runs it as [this script, recordFile, ...docker's args]. It records its arguments and its own
// environment, then reads the block of variables off its input NUL by NUL, as the box's inner script does, and starts
// the command after `_ INNER` on this machine with its own environment and the block's variables, passing it the rest
// of its input. It records the child's pid and exits with the child's code. A command that cannot start prints
// `tachikoma: not found` and exits 127, as the inner script does; an input that ends inside the block exits 2.
// Elsewhere than Windows the child leads a process group of its own, as setsid makes in the box, so the stand-in's
// kill (tests/mcp/fake.ts) ends it with everything it started.
// The child works in the system's temp folder, not in the folder this stand-in was started in, the test's own, so it
// does not hold that folder while the test's clean-up removes it: on Windows a process holds its working folder, and
// the child is killed by its process id (fake.ts, killGroup), with nothing to wait on until Windows lets go of it, so
// the removal could fail with EBUSY (release 8e plan, step 20). The stand-in itself is waited for (fake.ts, killAll).
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";

const [record, ...args] = process.argv.slice(2);
const note = (entry) => appendFileSync(record, `${JSON.stringify({ self: process.pid, ...entry })}\n`);
note({ args, env: process.env });
// The first "_" is the outer script's $0; INNER follows it, then the command and its arguments.
const [command, ...rest] = args.slice(args.indexOf("_") + 2);

const env = { ...process.env };
let held = Buffer.alloc(0);
let child;

// Takes each whole entry of the block; true once the empty entry that ends it is read, `held` then the bytes after it.
function take(chunk) {
  held = Buffer.concat([held, chunk]);
  for (let nul = held.indexOf(0); nul !== -1; nul = held.indexOf(0)) {
    const entry = held.subarray(0, nul).toString();
    held = held.subarray(nul + 1);
    if (!entry) return true;
    const eq = entry.indexOf("=");
    env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return false;
}

const notFound = () => process.stderr.write("tachikoma: not found\n", () => process.exit(127));

function start() {
  try {
    child = spawn(command, rest, { cwd: tmpdir(), env, stdio: "pipe", windowsHide: true, detached: process.platform !== "win32" });
  } catch {
    return notFound();
  }
  let spawned = false;
  child.on("error", () => spawned || notFound());
  child.on("spawn", () => {
    spawned = true;
    note({ child: child.pid });
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  // Its pieces of output written first, then the exit. A child that never started has its own close, passed over.
  const exit = (code) => process.stdout.write("", () => process.stderr.write("", () => process.exit(code ?? 1)));
  child.on("close", (code) => spawned && exit(code));
  child.stdin.on("error", () => {});
  if (held.length) child.stdin.write(held);
  process.stdin.pipe(child.stdin);
}

process.stdin.on("data", function first(chunk) {
  if (!take(chunk)) return;
  process.stdin.off("data", first);
  process.stdin.pause();
  start();
});
process.stdin.on("end", () => {
  if (!child) process.exit(2);
});
