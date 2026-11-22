import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_KEYS } from "../../src/exec/env.js";
import { running } from "../../src/exec/local.js";
import { hubEnv, uvEnv } from "../../src/memory/env.js";
import {
  install,
  type Installed,
  type InstallOptions,
  type Program,
  readyFile,
  uvProgram,
} from "../../src/memory/install.js";
import { tryLock, type OsLock } from "../../src/memory/oslock.js";
import { makeMemoryFolder, type MemoryPaths, memoryPaths, SHIPPED_LOCK } from "../../src/memory/paths.js";
import { removeTree } from "../helpers.js";

// One test has the memory folder go missing after the installer made it: its making is skipped, as if the folder
// vanished between the making and the take.
const vanish = vi.hoisted(() => ({ on: false }));
vi.mock("../../src/memory/paths.js", async (real) => {
  const paths = await real<typeof import("../../src/memory/paths.js")>();
  return { ...paths, makeMemoryFolder: (p: MemoryPaths) => (vanish.on ? undefined : paths.makeMemoryFolder(p)) };
});

// The installer (8d plan, step 19) against the stand-in uv (tests/standin/uv.mjs) and a model served by a local HTTP
// server the test runs. Nothing is fetched from the network, no real uv, sfw or Python is run, and every folder,
// home and data folder is one the test made.

const UV = path.resolve("tests/standin/uv.mjs");
const STANDIN_UV: Program = { command: process.execPath, args: [UV] };
// The environment's Python is the stand-in's script at the Python's own path, started with Node.
const launch = (file: string): Program => ({ command: process.execPath, args: [file] });
// A made-up model archive: the installer checks the hash it is given, and the stand-in Python records the unpacking.
const MODEL_BYTES = Buffer.from("a made-up model archive, for the installer's tests\n".repeat(2_000));
const MODEL_HASH = createHash("sha256").update(MODEL_BYTES).digest("hex");
// The tests' own limit for something that should happen: long enough never to be reached by one that does.
const LIMIT = 10_000;

const folders: string[] = [];
const servers: Server[] = [];
const locks: OsLock[] = [];
const pids: number[] = [];

afterEach(async () => {
  vanish.on = false;
  for (const lock of locks.splice(0)) lock.release();
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone already, as it should be
    }
  }
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  for (const folder of folders.splice(0)) await removeTree(folder);
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > LIMIT) throw new Error(`waited too long for ${what}`);
    await sleep(20);
  }
}

// The model at a local address. `hold` sends the headers and half the archive, then nothing more.
async function modelServer(hold = false) {
  const seen = { requests: 0, closed: 0 };
  const server = createServer((req, res) => {
    seen.requests++;
    res.on("close", () => seen.closed++);
    res.writeHead(200, { "content-length": MODEL_BYTES.length });
    if (hold) res.write(MODEL_BYTES.subarray(0, MODEL_BYTES.length / 2));
    else res.end(MODEL_BYTES);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/all-MiniLM-L6-v2/onnx.tar.gz`, seen };
}

// A data folder, the user's home folders, an empty PATH folder and the stand-in's record, all in a folder the test
// made. The PATH variable is replaced in every spelling (Windows' is `Path`), so no test reaches the user's own.
async function setup(more: Record<string, string> = {}) {
  const top = await mkdtemp(path.join(tmpdir(), "tachi-install-"));
  folders.push(top);
  const record = path.join(top, "record.jsonl");
  const bin = path.join(top, "bin");
  mkdirSync(bin);
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PATH")),
    PATH: bin,
    USERPROFILE: path.join(top, "user"),
    HOME: path.join(top, "user"),
    APPDATA: path.join(top, "user", "AppData", "Roaming"),
    LOCALAPPDATA: path.join(top, "user", "AppData", "Local"),
    ANTHROPIC_API_KEY: "a made-up key",
    TACHI_TEST_UV_RECORD: record,
    ...more,
  };
  const data = path.join(top, "data");
  const paths = memoryPaths(data);
  const records = () =>
    existsSync(record)
      ? readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Started)
      : [];
  return { top, bin, data, paths, env, records };
}

interface Started {
  as: "uv" | "python" | "sfw";
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  pid: number;
  ppid: number;
}

const model = (url: string, sha256 = MODEL_HASH) => ({ url, sha256 });

type Setup = Awaited<ReturnType<typeof setup>>;
// The installer with the test's folders and environment, the stand-in uv and Python, and the model at `url`.
const installed = (s: Setup, url: string, more: Partial<InstallOptions> = {}) =>
  install({ paths: s.paths, env: s.env, uv: STANDIN_UV, launch, model: model(url), ...more });

describe("uvProgram", () => {
  // Programs on a PATH the test builds: empty files, which the lookup finds as it finds the real ones (with .exe on
  // Windows, and runnable elsewhere). They are never started.
  async function bin(...names: string[]) {
    const top = await mkdtemp(path.join(tmpdir(), "tachi-install-path-"));
    folders.push(top);
    for (const name of names) {
      const file = path.join(top, process.platform === "win32" ? `${name}.exe` : name);
      writeFileSync(file, "");
      chmodSync(file, 0o755);
    }
    return { dir: top, file: (name: string) => path.join(top, process.platform === "win32" ? `${name}.exe` : name) };
  }

  it("starts uv by its full path when sfw is not on PATH", async () => {
    const { dir, file } = await bin("uv");
    expect(uvProgram({ PATH: dir })).toEqual({ command: file("uv"), args: [] });
  });

  it("puts sfw in front of uv when sfw is on PATH", async () => {
    const { dir, file } = await bin("uv", "sfw");
    expect(uvProgram({ PATH: dir })).toEqual({ command: file("sfw"), args: [file("uv")] });
  });

  it("finds no uv when PATH has none, even with sfw", async () => {
    const { dir } = await bin("sfw");
    expect(uvProgram({ PATH: dir })).toBeNull();
  });

  // The user's choice at step 19's review, "Accept sfw.cmd too": npm installs sfw as sfw.cmd on Windows.
  it.runIf(process.platform === "win32")("puts an npm-installed sfw.cmd in front of uv without sfw.exe", async () => {
    const { dir, file } = await bin("uv");
    writeFileSync(path.join(dir, "sfw.cmd"), "");
    expect(uvProgram({ PATH: dir })).toEqual({ command: path.join(dir, "sfw.cmd"), args: [file("uv")] });
  });

  it.runIf(process.platform === "win32")("prefers sfw.exe to sfw.cmd, even one earlier on PATH", async () => {
    const { dir, file } = await bin("uv", "sfw");
    writeFileSync(path.join(dir, "sfw.cmd"), "");
    const earlier = await bin();
    writeFileSync(path.join(earlier.dir, "sfw.cmd"), "");
    expect(uvProgram({ PATH: `${earlier.dir};${dir}` })).toEqual({ command: file("sfw"), args: [file("uv")] });
  });
});

// A stand-in sfw.cmd in a folder on the test's own PATH: it starts the stand-in as sfw (`uv.mjs --sfw`), which records
// its arguments and runs the rest as a program, as sfw runs uv. The test's uv is the stand-in uv, started with Node.
describe.runIf(process.platform === "win32")("install through sfw.cmd", () => {
  async function throughSfw(s: Setup, folderName: string) {
    const dir = path.join(s.top, folderName);
    mkdirSync(dir);
    const sfw = path.join(dir, "sfw.cmd");
    writeFileSync(sfw, `@"${process.execPath}" "${UV}" --sfw %*\r\n`);
    return { command: sfw, args: [process.execPath, UV] };
  }
  const UV_ARGS = ["sync", "--locked", "--python", "3.13"];

  it("runs uv through sfw.cmd with the exact arguments", async () => {
    const s = await setup();
    const served = await modelServer();
    const uv = await throughSfw(s, "sfw-bin");
    expect(await installed(s, served.url, { uv })).toEqual({ is: "ready", version: "3.12.0" });
    const [sfw, ran] = s.records();
    expect(sfw!.as).toBe("sfw");
    expect(sfw!.args).toEqual([process.execPath, UV, ...UV_ARGS]);
    expect(ran!.as).toBe("uv");
    expect(ran!.args).toEqual(UV_ARGS);
  });

  it("keeps a path with spaces and cmd's own characters whole through the quoting", async () => {
    const s = await setup();
    const served = await modelServer();
    const uv = await throughSfw(s, "with space & caret^ (and) brackets");
    expect(await installed(s, served.url, { uv })).toEqual({ is: "ready", version: "3.12.0" });
    const [sfw] = s.records();
    expect(path.resolve(sfw!.file)).toBe(path.resolve(UV));
    expect(sfw!.args).toEqual([process.execPath, UV, ...UV_ARGS]);
  });

  it("stops while uv runs under sfw.cmd: cmd.exe, sfw and uv are all ended", async () => {
    const s = await setup();
    const served = await modelServer();
    const uv = await throughSfw(s, "sfw-bin");
    const env = { ...s.env, TACHI_TEST_UV_HOLD: path.join(s.top, "never-made") };
    const before = running.size;
    const stop = new AbortController();
    const done = installed(s, served.url, { uv, env, signal: stop.signal });
    await until(() => s.records().length === 2, "sfw and uv to start");
    const [sfw, held] = s.records();
    pids.push(sfw!.pid, held!.pid);
    stop.abort();
    expect(await done).toEqual({ is: "stopped" });
    expect(running.size).toBe(before);
    for (const pid of [sfw!.ppid, sfw!.pid, held!.pid]) await until(() => !alive(pid), `process ${pid} to be gone`);
    expect(existsSync(readyFile(s.paths))).toBe(false);
    const lock = tryLock(s.paths.root, "install");
    expect(lock).not.toBeNull();
    lock!.release();
  });
});

describe("install", () => {
  it("installs the lock with uv's exact arguments and environment, then the model, then the ready file", async () => {
    const s = await setup();
    const served = await modelServer();
    expect(await installed(s, served.url)).toEqual({ is: "ready", version: "3.12.0" });

    const [uv, ...rest] = s.records();
    expect(uv!.as).toBe("uv");
    expect(uv!.args).toEqual(["sync", "--locked", "--python", "3.13"]);
    // uv runs in a copy of the shipped project inside memory/, so whatever it writes there stays inside memory/.
    const project = path.join(s.paths.root, "project");
    expect(path.resolve(uv!.cwd)).toBe(path.resolve(project));
    for (const name of ["pyproject.toml", "uv.lock"]) {
      const shipped = path.join(path.dirname(SHIPPED_LOCK), name);
      expect(readFileSync(path.join(project, name))).toEqual(readFileSync(shipped));
    }
    const expected = {
      ...uvEnv(s.paths, s.env),
      UV_PROJECT_ENVIRONMENT: s.paths.env,
      UV_TOOL_DIR: path.join(s.paths.root, "uv-tools"),
      UV_LINK_MODE: "copy",
    };
    for (const [name, value] of Object.entries(expected)) expect(uv!.env[name], name).toBe(value);
    for (const key of API_KEYS) expect(Object.keys(uv!.env).map((k) => k.toUpperCase())).not.toContain(key);
    // TEMP and TMP are folders that exist, inside memory/.
    expect(existsSync(s.paths.tmp)).toBe(true);

    // The model: downloaded whole to where chromadb keeps it, then unpacked there by the environment's own Python.
    const folder = path.join(s.paths.home, ".cache", "chroma", "onnx_models", "all-MiniLM-L6-v2");
    const archive = path.join(folder, "onnx.tar.gz");
    expect(readFileSync(archive)).toEqual(MODEL_BYTES);
    expect(rest.map((r) => r.as)).toEqual(["python", "python"]);
    const [unpack, version] = rest;
    expect(unpack!.args.slice(0, 2)).toEqual(["-I", "-c"]);
    expect(unpack!.args.slice(3)).toEqual([archive, folder]);
    expect(version!.args).toEqual(["-I", "-m", "mempalace", "--version"]);

    expect(JSON.parse(readFileSync(readyFile(s.paths), "utf8"))).toEqual({ mempalace: "3.12.0" });
    // Nothing outside memory/ in the data folder.
    expect(readdirSync(s.data)).toEqual(["memory"]);
  });

  it("asks the version of the environment's own Python only, by its full path, with -I and the hub's env", async () => {
    const s = await setup();
    const served = await modelServer();
    const launched: string[] = [];
    const watch = (file: string) => {
      launched.push(file);
      return launch(file);
    };
    expect(await installed(s, served.url, { launch: watch })).toEqual({ is: "ready", version: "3.12.0" });
    expect(launched).toEqual([s.paths.envPython, s.paths.envPython]);
    const asked = s.records().filter((r) => r.args.includes("--version"));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.as).toBe("python");
    expect(path.resolve(asked[0]!.file)).toBe(path.resolve(s.paths.envPython));
    expect(asked[0]!.args[0]).toBe("-I");
    for (const [name, value] of Object.entries(hubEnv(s.paths, s.env))) expect(asked[0]!.env[name], name).toBe(value);
    expect(s.records().map((r) => r.as)).toEqual(["uv", "python", "python"]);
  });

  it("fails on a model that does not match its hash, and writes no ready file", async () => {
    const s = await setup();
    const served = await modelServer();
    const other = createHash("sha256").update("another archive").digest("hex");
    expect(await installed(s, served.url, { model: model(served.url, other) })).toEqual({ is: "model hash" });
    expect(existsSync(readyFile(s.paths))).toBe(false);
    const folder = path.join(s.paths.home, ".cache", "chroma", "onnx_models", "all-MiniLM-L6-v2");
    expect(readdirSync(folder)).toEqual([]);
    expect(s.records().map((r) => r.as)).toEqual(["uv"]);
  });

  it("fails when MemPalace reports another version, and writes no ready file", async () => {
    const s = await setup({ TACHI_TEST_MEMPALACE_VERSION: "3.11.0" });
    const served = await modelServer();
    const got = await installed(s, served.url);
    expect(got.is).toBe("failed");
    expect((got as { reason: string }).reason).toContain("3.11.0");
    expect(existsSync(readyFile(s.paths))).toBe(false);
  });

  it("fails with that as the reason when uv leaves no Python in the environment", async () => {
    const s = await setup({ TACHI_TEST_UV_NO_PYTHON: "1" });
    const served = await modelServer();
    const got = await installed(s, served.url);
    expect(got.is).toBe("failed");
    expect((got as { reason: string }).reason).toContain(s.paths.envPython);
    expect(existsSync(readyFile(s.paths))).toBe(false);
    expect(served.seen.requests).toBe(0);
  });

  it("fails with uv's own last line when uv fails", async () => {
    const s = await setup({ TACHI_TEST_UV_FAIL: "error: a made-up failure\n  Caused by: a made-up cause\n" });
    const served = await modelServer();
    expect(await installed(s, served.url)).toEqual({ is: "failed", reason: "Caused by: a made-up cause" });
    expect(existsSync(readyFile(s.paths))).toBe(false);
  });

  it("removes a folder left without a ready file and installs again; a ready one is used as it is", async () => {
    const s = await setup();
    const served = await modelServer();
    mkdirSync(s.paths.env, { recursive: true });
    const left = path.join(s.paths.env, "left-by-a-cut-off-install.txt");
    writeFileSync(left, "");
    expect(await installed(s, served.url)).toEqual({ is: "ready", version: "3.12.0" });
    expect(existsSync(left)).toBe(false);
    expect(s.records().filter((r) => r.as === "uv")).toHaveLength(1);

    expect(await installed(s, served.url)).toEqual({ is: "ready", version: "3.12.0" });
    expect(s.records().filter((r) => r.as === "uv")).toHaveLength(1);
  });

  it("starts no install while another window holds the install lock", async () => {
    const s = await setup();
    const served = await modelServer();
    makeMemoryFolder(s.paths);
    const held = tryLock(s.paths.root, "install");
    expect(held).not.toBeNull();
    locks.push(held!);
    expect(await installed(s, served.url)).toEqual({ is: "another window is installing" });
    expect(s.records()).toEqual([]);
    expect(served.seen.requests).toBe(0);
  });

  // The user's choice at step 19: the lock module's own words are never passed on.
  it("says only that the install lock could not be taken when its folder is missing", async () => {
    const s = await setup();
    const served = await modelServer();
    vanish.on = true;
    expect(await installed(s, served.url)).toEqual({ is: "failed", reason: "the install lock could not be taken" });
    expect(s.records()).toEqual([]);
    expect(existsSync(s.paths.root)).toBe(false);
  });

  it("says only that the install lock could not be taken when the lock file cannot be opened", async () => {
    const s = await setup();
    const served = await modelServer();
    mkdirSync(path.join(s.paths.root, "install.lock"), { recursive: true }); // a folder where the lock file goes
    expect(await installed(s, served.url)).toEqual({ is: "failed", reason: "the install lock could not be taken" });
    expect(s.records()).toEqual([]);
  });

  it("reports uv missing, and makes nothing", async () => {
    const s = await setup();
    const empty = path.join(s.top, "no-programs");
    mkdirSync(empty);
    const served = await modelServer();
    // No uv given: the installer looks for one on PATH, as Tachikoma does.
    const got = await install({ paths: s.paths, env: { ...s.env, PATH: empty }, launch, model: model(served.url) });
    expect(got).toEqual({ is: "no uv" });
    expect(existsSync(s.data)).toBe(false);
  });

  // After a stop: no ready file, the install lock is free, nothing the installer started runs, and the next run
  // installs again.
  async function afterStop(s: Setup, got: Installed, before: number) {
    expect(got).toEqual({ is: "stopped" });
    expect(existsSync(readyFile(s.paths))).toBe(false);
    const lock = tryLock(s.paths.root, "install");
    expect(lock).not.toBeNull();
    lock!.release();
    expect(running.size).toBe(before);
    for (const r of s.records()) await until(() => !alive(r.pid), `the stand-in ${r.as} to be gone`);
    const served = await modelServer();
    expect(await installed(s, served.url, { env: { ...s.env, TACHI_TEST_UV_HOLD: "" } })).toEqual({
      is: "ready",
      version: "3.12.0",
    });
  }

  it("stops while uv runs: the stand-in uv is ended and nothing is left", async () => {
    const s = await setup();
    const env = { ...s.env, TACHI_TEST_UV_HOLD: path.join(s.top, "never-made") };
    const served = await modelServer();
    const before = running.size;
    const stop = new AbortController();
    const done = installed(s, served.url, { env, signal: stop.signal });
    await until(() => s.records().length === 1, "uv to start");
    pids.push(s.records()[0]!.pid);
    expect(running.size).toBe(before + 1);
    stop.abort();
    await afterStop(s, await done, before);
    expect(served.seen.requests).toBe(0);
  });

  it("stops while the model downloads: the download is ended and nothing is left", async () => {
    const s = await setup();
    const served = await modelServer(true);
    const before = running.size;
    const stop = new AbortController();
    const done = installed(s, served.url, { signal: stop.signal });
    await until(() => served.seen.requests === 1, "the download to start");
    stop.abort();
    const got = await done;
    await until(() => served.seen.closed === 1, "the download's connection to close");
    const folder = path.join(s.paths.home, ".cache", "chroma", "onnx_models", "all-MiniLM-L6-v2");
    expect(readdirSync(folder)).toEqual([]);
    expect(s.records().map((r) => r.as)).toEqual(["uv"]);
    await afterStop(s, got, before);
  });
});
