import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { onPath } from "../exec/env.js";
import { collect, killTree, running } from "../exec/local.js";
import { hubEnv, uvEnv } from "./env.js";
import { tryLock } from "./oslock.js";
import { makeMemoryFolder, type MemoryPaths, SHIPPED_LOCK } from "./paths.js";

// The installer (8d plan, step 19): under the install lock, it installs the shipped lock file into `env/<hash>/` with
// uv, downloads the embedding model and checks it against its hash, has the environment's own Python unpack it where
// MemPalace looks, asks that Python's MemPalace for its version, and only then writes the folder's ready file. What it
// answers is for its caller (step 21), which words it; none of it is shown as it is.

// The MemPalace version the lock holds and the ready file records (the design, section 1; the build record, step 3).
export const MEMPALACE = "3.12.0";
// The Python the environment is built with: the user's choice at step 3, managed by uv in memory/python.
const PYTHON = "3.13";
// The model's address and the SHA-256 of its archive, as MemPalace 3.12.0's chromadb uses them (the build record, step
// 5: onnx_mini_lm_l6_v2.py:42-45; the address has no fixed version, and the user accepted the hash check alone).
export const MODEL = {
  url: "https://chroma-onnx-models.s3.amazonaws.com/all-MiniLM-L6-v2/onnx.tar.gz",
  sha256: "913d7300ceae3b2dbc2c50d1de4baacab4be7b9380491c27fab7418616a16ec3",
};

// The ready file, in the environment's own folder: a folder without one is never used (the design, section 2).
export const readyFile = (paths: MemoryPaths) => path.join(paths.env, "tachikoma-ready.json");
// Where chromadb keeps the model, under the home MemPalace is given (step 5: onnx_mini_lm_l6_v2.py:39-41): its archive,
// and the `onnx/` folder the archive holds.
const modelFolder = (paths: MemoryPaths) =>
  path.join(paths.home, ".cache", "chroma", "onnx_models", "all-MiniLM-L6-v2");
// Unpacked as chromadb unpacks it (step 5: tarfile's "data" filter, which refuses a path leaving the folder).
const UNPACK =
  "import sys, tarfile; t = tarfile.open(sys.argv[1]); t.extractall(sys.argv[2], filter='data'); t.close()";

export interface Program {
  command: string;
  args: string[];
}

export type Installed =
  | { is: "ready"; version: string }
  | { is: "no uv" }
  | { is: "another window is installing" }
  | { is: "stopped" }
  | { is: "model hash" }
  | { is: "failed"; reason: string };

export interface InstallOptions {
  paths: MemoryPaths;
  // The environment the children's are built from, and whose PATH uv and sfw are looked for on.
  env?: NodeJS.ProcessEnv;
  // uv, with sfw in front when it is on PATH (uvProgram); null when there is none.
  uv?: Program | null;
  model?: { url: string; sha256: string };
  // How a program is started by its full path: as it is. A test starts the stand-in Python's script with Node.
  launch?: (file: string) => Program;
  // Stops the install: the child the installer started is ended, as is a download, and nothing more starts.
  signal?: AbortSignal;
}

// uv by its full path (onPath, `uv.exe` on Windows), with sfw in front when sfw is on PATH too; null without uv.
export function uvProgram(env: NodeJS.ProcessEnv = process.env): Program | null {
  const uv = onPath("uv", env);
  if (!uv) return null;
  const sfw = onPath("sfw", env);
  return sfw ? { command: sfw, args: [uv] } : { command: uv, args: [] };
}

class Stopped extends Error {}
class WrongModel extends Error {}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function install(o: InstallOptions): Promise<Installed> {
  const env = o.env ?? process.env;
  const uv = o.uv === undefined ? uvProgram(env) : o.uv;
  if (!uv) return { is: "no uv" };
  if (o.signal?.aborted) return { is: "stopped" };
  let lock;
  try {
    makeMemoryFolder(o.paths); // the lock's folder, made before it is taken (step 17)
  } catch (err) {
    return { is: "failed", reason: message(err) };
  }
  try {
    lock = tryLock(o.paths.root, "install");
  } catch {
    // The lock module's own words are never passed on (the user's choice at step 19).
    return { is: "failed", reason: "the install lock could not be taken" };
  }
  if (!lock) return { is: "another window is installing" };
  try {
    return await installLocked(o, env, uv);
  } catch (err) {
    if (err instanceof Stopped || o.signal?.aborted) return { is: "stopped" };
    if (err instanceof WrongModel) return { is: "model hash" };
    return { is: "failed", reason: message(err) };
  } finally {
    lock.release();
  }
}

async function installLocked(o: InstallOptions, env: NodeJS.ProcessEnv, uv: Program): Promise<Installed> {
  const { paths, signal } = o;
  const ready = readyFile(paths);
  if (existsSync(ready)) return { is: "ready", version: JSON.parse(readFileSync(ready, "utf8")).mempalace };
  // An install that was cut off left its folder without a ready file: it is removed, and done again.
  rmSync(paths.env, { recursive: true, force: true });
  // uv runs in a copy of the shipped project, as step 4 ran it, so anything it writes stays inside memory/.
  const project = path.join(paths.root, "project");
  const folder = modelFolder(paths);
  for (const dir of [paths.tmp, path.dirname(paths.env), folder, project]) mkdirSync(dir, { recursive: true });
  for (const name of ["pyproject.toml", "uv.lock"]) {
    copyFileSync(path.join(path.dirname(SHIPPED_LOCK), name), path.join(project, name));
  }

  // Step 4's install: the lock with its hashes, unchanged (--locked), into the environment's own folder. The tool
  // folder inside memory/ as in steps 3, 4 and 7, though a sync never uses it; new files in the environment, not links
  // into uv's cache, as in step 8's installs, whose first hub starts gave the start limit (M3).
  const synced = await run(
    { command: uv.command, args: [...uv.args, "sync", "--locked", "--python", PYTHON] },
    project,
    {
      ...uvEnv(paths, env),
      UV_PROJECT_ENVIRONMENT: paths.env,
      UV_TOOL_DIR: path.join(paths.root, "uv-tools"),
      UV_LINK_MODE: "copy",
    },
    signal,
  );
  if (synced.code !== 0) throw new Error(said(synced));
  if (!existsSync(paths.envPython)) throw new Error(`the environment's Python is missing: ${paths.envPython}`);

  const archive = await download(o.model ?? MODEL, folder, signal);
  // The environment's own Python with -I, as the hub is started (Q24), with the hub's environment.
  const launch = o.launch ?? ((file: string) => ({ command: file, args: [] }));
  const python = (args: string[]) => {
    const p = launch(paths.envPython);
    return run({ command: p.command, args: [...p.args, "-I", ...args] }, paths.home, hubEnv(paths, env), signal);
  };
  const unpacked = await python(["-c", UNPACK, archive, folder]);
  if (unpacked.code !== 0) throw new Error(`unpacking the model failed: ${said(unpacked)}`);
  const asked = await python(["-m", "mempalace", "--version"]);
  if (asked.code !== 0) throw new Error(said(asked));
  const reported = asked.stdout.trim();
  if (reported !== `MemPalace ${MEMPALACE}`) throw new Error(`MemPalace reported "${reported}", not ${MEMPALACE}`);
  if (signal?.aborted) throw new Stopped();
  writeFileSync(ready, `${JSON.stringify({ mempalace: MEMPALACE })}\n`);
  return { is: "ready", version: MEMPALACE };
}

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

// What a program said of its failure: its own last line, else its exit code (the user's choice at step 19).
function said(ran: Ran): string {
  return ran.stderr.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? `exit code: ${ran.code}`;
}

// Runs a program hidden, with no input, in `running` so it dies with Tachikoma. A stop ends it and everything it
// started (killTree, which runs only while its exit is not yet seen), and settles at once.
function run(p: Program, cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Ran> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Stopped());
    const child = spawn(p.command, p.args, {
      cwd,
      env,
      windowsHide: true,
      detached: process.platform !== "win32", // its own process group, so killTree reaches what it starts
      stdio: ["ignore", "pipe", "pipe"],
    });
    running.add(child);
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    const end = () => {
      running.delete(child);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      killTree(child);
      end();
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new Stopped());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      end();
      reject(err);
    });
    child.on("close", (code) => {
      end();
      resolve({ code, stdout: stdout(), stderr: stderr() });
    });
  });
}

// The model, hashed as it arrives (the user's choice after step 9: streamed, the timer is never held long), written to
// a part file and moved into chromadb's place only when its hash is the one given. A redirect is refused, as chromadb
// refuses one (step 5: httpx's stream does not follow them).
async function download(model: { url: string; sha256: string }, folder: string, signal?: AbortSignal): Promise<string> {
  const archive = path.join(folder, "onnx.tar.gz");
  const part = `${archive}.part`;
  try {
    const res = await fetch(model.url, { redirect: "error", ...(signal && { signal }) });
    if (!res.ok || !res.body) throw new Error(`the model's download answered HTTP ${res.status}`);
    const hash = createHash("sha256");
    const hashed = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        done(null, chunk);
      },
    });
    const body = Readable.fromWeb(res.body as ReadableStream<Uint8Array>);
    await pipeline(body, hashed, createWriteStream(part), ...(signal ? [{ signal }] : []));
    if (hash.digest("hex") !== model.sha256) throw new WrongModel();
    renameSync(part, archive);
    return archive;
  } catch (err) {
    rmSync(part, { force: true });
    if (signal?.aborted) throw new Stopped();
    if (err instanceof WrongModel || (err instanceof Error && err.message.startsWith("the model's"))) throw err;
    const cause = err instanceof Error && err.cause !== undefined ? message(err.cause) : message(err);
    throw new Error(`the model's download failed: ${cause}`);
  }
}
