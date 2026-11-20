// The install of memory/uv.lock into the build folder, and the proof that its hashes are enforced (8d plan, step 4).
// Not part of Tachikoma: run by hand.
//
//   node scripts/8d/install-throwaway.mjs dirs <install|tamper>   the folder check only; fetches nothing
//   node scripts/8d/install-throwaway.mjs install                 the folder check, then `sfw uv sync --locked`
//   node scripts/8d/install-throwaway.mjs tamper                  the same, with the mempalace wheel's hash altered
//   node scripts/8d/install-throwaway.mjs version                 <build>\env\Scripts\mempalace.exe --version
//   node scripts/8d/install-throwaway.mjs report <install|tamper>  the files a run's log says were downloaded
//
// Each run has its own sub-folder of the build folder from step 1's `throwaway` (home, uv cache, Pythons), with a copy
// of memory/ in <run>\project, so uv never makes a .venv in the repo. On top of step 1's environment, on the command
// only, these uv variables (each in https://docs.astral.sh/uv/reference/environment/):
//  - UV_TOOL_DIR (added in 0.2.16), UV_PYTHON_BIN_DIR (0.4.29) and UV_PYTHON_CACHE_DIR (0.7.0) in the run's folder;
//  - UV_PYTHON_PREFERENCE=only-managed (0.3.2): "Only use managed Python installations; never use system Python
//    installations." (https://docs.astral.sh/uv/concepts/python-versions/), so no Python already on the computer;
//  - UV_PROJECT_ENVIRONMENT (0.4.4), the environment folder: <build>\env for the install, <build>\tamper\env for the
//    tamper run. "If an absolute path is provided, it will be used as-is" (https://docs.astral.sh/uv/concepts/projects/
//    config/).
// Before any fetch, `uv cache dir`, `uv python dir` and `uv python dir --bin` (which fetch nothing) must each print a
// folder inside the run's folder, and the variables no uv command prints must lie inside the build folder; if not,
// the run stops. Python 3.13 (the user's choice at step 3) is asked for with `--python 3.13`. The whole verbose log
// is kept as <run>\sync.log.
import { spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD, throwaway } from "./throwaway.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WHEEL = "mempalace-3.12.0-py3-none-any.whl";
const HASH = "sha256:3832534f377f3a81a324f741f90bf3c1ec277d49404608257cde1b5b0d52626f";
// The tamper run's hash: the real one with its first hex digit changed, so only that one hash differs.
const TAMPERED = "sha256:4832534f377f3a81a324f741f90bf3c1ec277d49404608257cde1b5b0d52626f";

const inside = (folder, p) => {
  const r = path.relative(folder.toLowerCase(), path.resolve(p).toLowerCase());
  return r !== "" && !r.startsWith("..") && !path.isAbsolute(r);
};

function setup(run) {
  const { dir, env } = throwaway(run);
  const extra = {
    UV_TOOL_DIR: path.join(dir, "uv-tools"),
    UV_PYTHON_BIN_DIR: path.join(dir, "python-bin"),
    UV_PYTHON_CACHE_DIR: path.join(dir, "python-cache"),
    UV_PYTHON_PREFERENCE: "only-managed",
    UV_PROJECT_ENVIRONMENT: run === "install" ? path.join(BUILD, "env") : path.join(dir, "env"),
  };
  const kept = Object.entries(env).filter(([k]) => !(k.toUpperCase() in extra));
  const full = { ...Object.fromEntries(kept), ...extra };
  const project = path.join(dir, "project");
  mkdirSync(project, { recursive: true });
  copyFileSync(path.join(REPO, "memory", "pyproject.toml"), path.join(project, "pyproject.toml"));
  const lock = readFileSync(path.join(REPO, "memory", "uv.lock"), "utf8");
  if (run === "tamper") {
    const lines = lock.split("\n");
    const hit = lines.filter((l) => l.includes(`/${WHEEL}"`) && l.includes(`hash = "${HASH}"`));
    if (hit.length !== 1 || lock.split(HASH).length !== 2) throw new Error(`expected one ${WHEEL} line with ${HASH}`);
    const altered = lock.replace(HASH, TAMPERED);
    const differ = altered.split("\n").filter((l, i) => l !== lines[i]);
    if (differ.length !== 1) throw new Error("the altered lock differs on more than one line");
    writeFileSync(path.join(project, "uv.lock"), altered);
    console.log(`altered line: ${differ[0].trim()}`);
  } else writeFileSync(path.join(project, "uv.lock"), lock);
  return { dir, env: full, project, venv: extra.UV_PROJECT_ENVIRONMENT };
}

const uv = (args, cwd, env, stdio = "pipe") =>
  spawnSync("sfw", ["uv", ...args], { cwd, env, encoding: "utf8", stdio, maxBuffer: 1 << 26 });

// The folder check. Returns true when every folder uv will use is inside the build folder.
function dirs(run) {
  const s = setup(run);
  let ok = true;
  for (const k of Object.keys(s.env).sort()) {
    if (/^(UV_|USERPROFILE$|HOME$|HF_HOME$|MEMPALACE_|APPDATA$|LOCALAPPDATA$|XDG_)/i.test(k)) {
      console.log(`env ${k}=${s.env[k]}`);
    }
  }
  console.log(`cwd ${s.project}`);
  for (const k of ["UV_TOOL_DIR", "UV_PYTHON_CACHE_DIR", "UV_PROJECT_ENVIRONMENT"]) {
    if (!inside(BUILD, s.env[k])) {
      ok = false;
      console.log(`STOP: ${k} is outside the build folder`);
    }
  }
  for (const args of [["--version"], ["cache", "dir"], ["python", "dir"], ["python", "dir", "--bin"]]) {
    const r = uv(args, s.project, s.env);
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    console.log(`sfw uv ${args.join(" ")} -> exit ${r.status}: ${out}`);
    if (r.status !== 0) ok = false;
    if (args[0] !== "--version" && !inside(s.dir, r.stdout.trim())) {
      ok = false;
      console.log("STOP: outside the run's folder");
    }
  }
  console.log(ok ? "folders: all inside the build folder" : "folders: STOP");
  return { ok, s };
}

function sync(run) {
  const { ok, s } = dirs(run);
  if (!ok) process.exit(1);
  if (existsSync(s.venv)) throw new Error(`${s.venv} already exists; this run would not start from nothing`);
  const log = path.join(s.dir, "sync.log");
  const fd = openSync(log, "w");
  const args = ["sync", "--locked", "--python", "3.13", "-vv"];
  console.log(`run sfw uv ${args.join(" ")} > ${log}`);
  const start = Date.now();
  const r = spawnSync("sfw", ["uv", ...args], { cwd: s.project, env: s.env, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  const took = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`exit ${r.status} in ${took} s${r.error ? `, ${r.error.message}` : ""}`);
  const lines = readFileSync(log, "utf8").split(/\r?\n/);
  const plainLines = lines.filter(
    (l) => l.trim() && !/^\s*(\S+\s+)?(TRACE|DEBUG)\s/.test(l) && !/^\s*[│├└]/.test(l),
  );
  console.log(`log: ${lines.length} lines; lines other than DEBUG and TRACE:\n${plainLines.slice(-60).join("\n")}`);
  if (run === "tamper") {
    const text = lines.join("\n");
    const found = [];
    const walk = (d) => {
      if (!existsSync(d)) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (/^mempalace/i.test(e.name)) found.push(path.join(d, e.name));
        if (e.isDirectory() && !e.isSymbolicLink()) walk(path.join(d, e.name));
      }
    };
    walk(s.venv);
    console.log(`tamper: exit ${r.status} (must not be 0)`);
    console.log(`tamper: log names ${WHEEL}: ${text.includes(WHEEL)}`);
    console.log(`tamper: log names "mempalace==3.12.0": ${text.includes("mempalace==3.12.0")}`);
    console.log(`tamper: log says hash mismatch: ${/hash mismatch/i.test(text)}`);
    console.log(`tamper: log holds the altered hash: ${text.includes(TAMPERED)}; the real one: ${text.includes(HASH)}`);
    console.log(`tamper: names starting "mempalace" in ${s.venv}: ${found.length ? found.join(", ") : "none"}`);
  }
  // The install passes when uv exits 0. The tamper run passes only when uv refuses: a non-zero exit, not a failed
  // start.
  const ok = run === "tamper" ? Number.isInteger(r.status) && r.status !== 0 : r.status === 0;
  process.exitCode = ok ? 0 : 1;
}

function version() {
  const { dir, env } = throwaway("install");
  const exe = path.join(BUILD, "env", "Scripts", "mempalace.exe");
  if (!existsSync(exe)) throw new Error(`${exe} is missing`);
  console.log(`run ${exe} --version (HOME=${env.HOME})`);
  const r = spawnSync(exe, ["--version"], { cwd: path.join(dir, "home"), env, encoding: "utf8" });
  console.log(`exit ${r.status}\nstdout: ${r.stdout.trim()}\nstderr: ${r.stderr.trim()}`);
  process.exitCode = r.status ?? 1;
}

// What a run's log says was downloaded, file by file, and every folder it names outside the build folder. A package's
// size is the one the lock records for that file: uv checks each file's SHA-256 against the lock, so a file it took
// is byte for byte the file the lock describes. The Python archive's size is that of the copy uv keeps in
// UV_PYTHON_CACHE_DIR.
function report(run) {
  const dir = path.join(BUILD, run);
  const text = readFileSync(path.join(dir, "sync.log"), "utf8");
  const lock = readFileSync(path.join(dir, "project", "uv.lock"), "utf8");
  const sizes = new Map();
  for (const m of lock.matchAll(/url = "([^"]+)", hash = "[^"]+", size = (\d+)/g)) sizes.set(m[1], Number(m[2]));
  const urls = [...new Set([...text.matchAll(/Sending fresh GET request for: (\S+)/g)].map((m) => m[1]))];
  let total = 0;
  const rows = urls.map((u) => {
    const size = sizes.get(u);
    if (size === undefined) return `${decodeURIComponent(u.split("/").pop())}\tnot in the lock`;
    total += size;
    return `${decodeURIComponent(u.split("/").pop())}\t${size}`;
  });
  console.log(`package files fetched: ${urls.length}\n${rows.sort().join("\n")}`);
  console.log(`package files, total bytes: ${total} (${(total / 2 ** 20).toFixed(1)} MiB)`);
  const python = [...text.matchAll(/Downloading `(\S+)` to `([^`]+)`/g)];
  for (const [, url, file] of python) {
    const size = existsSync(file) ? statSync(file).size : "not kept";
    console.log(`python archive: ${url}\n  kept as ${file}, bytes: ${size}`);
  }
  const outside = new Set();
  for (const m of text.matchAll(/[A-Za-z]:\\[^\s`"']+/g)) if (!inside(BUILD, m[0])) outside.add(m[0]);
  console.log(`folders and files named outside the build folder: ${outside.size ? [...outside].join(", ") : "none"}`);
  const hosts = new Set([...text.matchAll(/https?:\/\/([^/\s`"]+)/g)].map((m) => m[1]));
  console.log(`hosts named: ${[...hosts].sort().join(", ")}`);
}

const [command, run] = process.argv.slice(2);
if (command === "dirs" && (run === "install" || run === "tamper")) process.exitCode = dirs(run).ok ? 0 : 1;
else if (command === "report" && (run === "install" || run === "tamper")) report(run);
else if (command === "install" || command === "tamper") sync(command);
else if (command === "version") version();
else {
  console.error(
    "usage: node scripts/8d/install-throwaway.mjs dirs <install|tamper> | install | tamper | version | " +
      "report <install|tamper>",
  );
  process.exit(2);
}
