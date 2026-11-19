// The stand-in uv for tests/memory/install.test.ts (8d plan, step 19): run as `node uv.mjs <uv's arguments>`, it
// records its arguments and environment and makes the environment folder uv would make (UV_PROJECT_ENVIRONMENT), with
// a stand-in for the environment's own Python in it. That stand-in is a script at the Python's own path, which the test
// starts with Node (`node <that path> <arguments>`); it loads this file again, which then acts as that Python:
// `-m mempalace --version` prints MemPalace's version line, and `-c <code> <archive> <folder>` (the model's unpacking)
// is recorded and done nothing more. Run as `node uv.mjs --sfw <program> <arguments>` (from a stand-in sfw.cmd, step
// 19's review), it acts as sfw: it records the rest and runs it as a program, passing on its output and exit code.
// Nothing is fetched and nothing is installed.
//
// Told by the environment:
// - TACHI_TEST_UV_RECORD: a file that gets one JSON line per start, for uv, the Python and sfw alike;
// - TACHI_TEST_UV_HOLD: a file whose existence releases uv; until it exists uv holds, having recorded its start;
// - TACHI_TEST_UV_FAIL: uv writes this to its error stream and exits 1, making nothing;
// - TACHI_TEST_UV_NO_PYTHON: uv makes the folder but no Python in it;
// - TACHI_TEST_MEMPALACE_VERSION: the version the Python's MemPalace reports, 3.12.0 when not set.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const me = process.argv[1];
const python = path.basename(me).startsWith("python");
const sfw = !python && process.argv[2] === "--sfw";
const args = process.argv.slice(sfw ? 3 : 2);
const record = process.env.TACHI_TEST_UV_RECORD;
if (record) {
  const as = python ? "python" : sfw ? "sfw" : "uv";
  const line = { as, file: me, args, cwd: process.cwd(), env: process.env, pid: process.pid, ppid: process.ppid };
  appendFileSync(record, `${JSON.stringify(line)}\n`);
}

if (sfw) {
  const child = spawn(args[0], args.slice(1), { stdio: "inherit", windowsHide: true });
  child.on("close", (code) => {
    process.exitCode = code ?? 1;
  });
} else if (python) {
  if (args.includes("--version")) {
    process.stdout.write(`MemPalace ${process.env.TACHI_TEST_MEMPALACE_VERSION ?? "3.12.0"}\n`);
  } else if (!args.includes("-c")) {
    process.stderr.write(`the stand-in Python was given ${JSON.stringify(args)}\n`);
    process.exitCode = 2;
  }
} else {
  const hold = process.env.TACHI_TEST_UV_HOLD;
  while (hold && !existsSync(hold)) await sleep(20);
  const env = process.env.UV_PROJECT_ENVIRONMENT;
  const bin = path.join(env, process.platform === "win32" ? "Scripts" : "bin");
  if (process.env.TACHI_TEST_UV_FAIL) {
    process.stderr.write(`${process.env.TACHI_TEST_UV_FAIL}\n`);
    process.exitCode = 1;
  } else {
    mkdirSync(bin, { recursive: true });
  }
  if (!process.env.TACHI_TEST_UV_FAIL && !process.env.TACHI_TEST_UV_NO_PYTHON) {
    const file = path.join(bin, process.platform === "win32" ? "python.exe" : "python");
    // Node reads a file of any other ending as CommonJS; the import brings in this file as the Python.
    writeFileSync(file, `import(${JSON.stringify(pathToFileURL(import.meta.filename).href)});\n`);
  }
}
