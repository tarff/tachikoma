// Measurement 1, the download's size for the first-use ask (8d plan, step 7). Not part of Tachikoma: run by hand.
//
//   node scripts/8d/measure-download.mjs
//
// Fetches nothing. It adds up what a first set-up downloads, by system, for Python 3.13 (the user's choice at step 3):
//  - the packages: for each system, the packages memory/uv.lock installs there (its dependency markers and extras
//    followed from the project, as in scripts/8d/lock-check.mjs), one wheel each, sized by the `size` the lock
//    records for that file. The wheel is the one uv picks: the first in the tag order of PEP 425 as `packaging.tags`
//    gives it for CPython 3.13 (cp313-cp313, then cp313-abi3, cp313-none, cp312-abi3 down to cp32-abi3, then
//    py313-none, py3-none, py312-none down to py30-none with a platform tag, then the same with `any`), and within
//    one of those, the newest platform tag (the newest glibc or macOS), as on a system new enough for every wheel.
//    The smallest and largest the packages could come to, over every wheel that fits the system at any glibc or
//    macOS version, are given too;
//  - the model: the archive approved at step 5, at tachi-8d-build\model-download\onnx.tar.gz (its SHA-256 checked);
//  - Python: this PC's archive as step 4's uv kept it in install\python-cache. For other systems, uv's own listing
//    (`uv python list --output-format json`), run with UV_OFFLINE=1, the build's environment (step 1's `throwaway`,
//    every uv folder inside the build folder) and a proxy of this script's that records and refuses every
//    connection; a system whose listing gives no size is "not measured".
// This PC's computed figure is checked against what step 4's install fetched (install\sync.log): the same files, one
// by one.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD, throwaway } from "./throwaway.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOCK = path.join(REPO, "memory", "uv.lock");
const PYTHON = "3.13.17"; // the CPython step 4's uv installed ("Using CPython 3.13.17", install\sync.log)
const MINOR = 13;
const MODEL = path.join(BUILD, "model-download", "onnx.tar.gz");
const MODEL_SHA256 = "913d7300ceae3b2dbc2c50d1de4baacab4be7b9380491c27fab7418616a16ec3"; // approved at step 5
const MB = 1e6;

// The lock: each package's name, version, wheels (file, size) and dependencies.
const text = readFileSync(LOCK, "utf8").replace(/\r\n/g, "\n");
const pkgs = text.split("\n[[package]]\n").slice(1).map((b) => {
  const field = (k) => (b.match(new RegExp(`^${k} = "([^"]*)"`, "m")) || [])[1];
  const wheels = [...b.matchAll(/\{ url = "([^"]+\.whl)", hash = "sha256:[0-9a-f]{64}", size = (\d+)/g)].map((m) => ({
    url: m[1], file: decodeURIComponent(m[1].split("/").pop()), size: Number(m[2]),
  }));
  const deps = (section) => {
    const m = b.match(new RegExp(`^${section} = \\[\\n([\\s\\S]*?)^\\]`, "m"));
    return m ? parseDeps(m[1]) : [];
  };
  const optional = {};
  const opt = b.split("\n[package.optional-dependencies]\n")[1];
  if (opt) for (const m of opt.matchAll(/^([\w-]+) = \[\n([\s\S]*?)^\]/gm)) optional[m[1]] = parseDeps(m[2]);
  return { name: field("name"), version: field("version"), source: (b.match(/^source = (.*)$/m) || [])[1],
    wheels, deps: deps("dependencies"), optional };
});

function parseDeps(s) {
  const re = new RegExp(
    String.raw`\{ name = "([^"]+)"(?:, version = "([^"]+)")?(?:, source = \{[^}]*\})?` +
      String.raw`(?:, extra = \[([^\]]*)\])?(?:, marker = "([^"]*)")? \}`,
    "g",
  );
  return [...s.matchAll(re)].map((m) => ({
    name: m[1], version: m[2], extras: m[3] ? [...m[3].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [], marker: m[4],
  }));
}

// PEP 508 markers, the subset this lock uses (as in lock-check.mjs).
function cmpVersion(a, b) {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}
function evalMarker(marker, env) {
  const toks = marker.match(/\(|\)|'[^']*'|==|!=|<=|>=|<|>|\bnot in\b|\bin\b|\band\b|\bor\b|[A-Za-z_]+/g);
  let i = 0;
  const value = (t) => (t.startsWith("'") ? t.slice(1, -1) : env[t] ?? (() => { throw new Error(`unknown ${t}`); })());
  const atom = () => {
    if (toks[i] === "(") { i++; const v = or(); i++; return v; }
    const lt = toks[i++], op = toks[i++], rt = toks[i++];
    const l = value(lt), r = value(rt);
    if (lt === "python_full_version" || lt === "python_version") {
      if (op === "==" && r.endsWith(".*")) return (l + ".").startsWith(r.slice(0, -1));
      if (op === "!=" && r.endsWith(".*")) return !(l + ".").startsWith(r.slice(0, -1));
      const c = cmpVersion(l, r);
      return { "==": c === 0, "!=": c !== 0, "<": c < 0, "<=": c <= 0, ">": c > 0, ">=": c >= 0 }[op];
    }
    if (op === "==") return l === r;
    if (op === "!=") return l !== r;
    if (op === "in") return r.includes(l);
    if (op === "not in") return !r.includes(l);
    throw new Error(`op ${op} on ${lt}`);
  };
  const and = () => { let v = atom(); while (toks[i] === "and") { i++; v = atom() && v; } return v; };
  const or = () => { let v = and(); while (toks[i] === "or") { i++; v = and() || v; } return v; };
  const v = or();
  if (i !== toks.length) throw new Error(`unparsed marker ${marker}`);
  return v;
}

// The systems. Intel Macs and Windows on ARM are known limits (step 3: no ready-built file for every package on
// Python 3.13), so they are not counted. Linux arm64 is covered by the lock (step 3) and counted too.
// uvKey is the system's part of the key in uv's listing (cpython-<version>-<uvKey>).
const systems = {
  "Windows x86-64": { sys_platform: "win32", platform_machine: "AMD64", os_name: "nt", os: "win",
    uvKey: "windows-x86_64-none" },
  "Linux x86-64": { sys_platform: "linux", platform_machine: "x86_64", os_name: "posix", os: "linux", arch: "x86_64",
    uvKey: "linux-x86_64-gnu" },
  "Linux arm64": { sys_platform: "linux", platform_machine: "aarch64", os_name: "posix", os: "linux", arch: "aarch64",
    uvKey: "linux-aarch64-gnu" },
  "macOS arm64": { sys_platform: "darwin", platform_machine: "arm64", os_name: "posix", os: "mac",
    uvKey: "macos-aarch64-none" },
};

function installSet(sys) {
  const env = { ...sys, python_full_version: PYTHON, python_version: `3.${MINOR}`,
    platform_python_implementation: "CPython", implementation_name: "cpython" };
  const seen = new Map();
  const root = pkgs.find((p) => p.source?.includes("virtual"));
  const visit = (deps) => {
    for (const d of deps) {
      if (d.marker && !evalMarker(d.marker, env)) continue;
      const cands = pkgs.filter((p) => p.name === d.name && (!d.version || p.version === d.version));
      if (cands.length !== 1) throw new Error(`${d.name} ${d.version}: ${cands.length} candidates`);
      const p = cands[0], key = `${p.name}==${p.version}`;
      const extras = d.extras.filter((x) => !seen.get(key)?.has(x));
      if (seen.has(key) && !extras.length) continue;
      const first = !seen.has(key);
      seen.set(key, new Set([...(seen.get(key) ?? []), ...d.extras]));
      if (first) visit(p.deps);
      for (const x of extras) visit(p.optional[x] ?? []);
    }
  };
  visit(root.deps);
  return [...seen.keys()].map((k) => pkgs.find((p) => `${p.name}==${p.version}` === k));
}

// Where a python tag and abi tag come in the tag order for CPython 3.13 (lower is picked first), or null. The groups
// with a platform tag come before those with `any`; `withPlatform` says which kind this is.
function interpreterRank(py, abi, withPlatform) {
  if (withPlatform) {
    if (py === `cp3${MINOR}` && abi === `cp3${MINOR}`) return 0;
    if (py === `cp3${MINOR}` && abi === "abi3") return 1;
    if (py === `cp3${MINOR}` && abi === "none") return 2;
    let m = py.match(/^cp3(\d+)$/);
    if (m && abi === "abi3" && Number(m[1]) < MINOR && Number(m[1]) >= 2) return 3 + (MINOR - 1 - Number(m[1]));
    if (abi !== "none") return null;
    if (py === `py3${MINOR}`) return 20;
    if (py === "py3") return 21;
    m = py.match(/^py3(\d+)$/);
    if (m && Number(m[1]) < MINOR) return 22 + (MINOR - 1 - Number(m[1]));
    return null;
  }
  if (abi !== "none") return null;
  if (py === `cp3${MINOR}`) return 40;
  if (py === `py3${MINOR}`) return 41;
  if (py === "py3") return 42;
  const m = py.match(/^py3(\d+)$/);
  return m && Number(m[1]) < MINOR ? 43 + (MINOR - 1 - Number(m[1])) : null;
}
// Where a platform tag comes among this system's platform tags, newest first (lower is picked first), or null.
function platformRank(tag, sys) {
  if (sys.os === "win") return tag === "win_amd64" ? 0 : null;
  if (sys.os === "linux") {
    const legacy = { manylinux1: 5, manylinux2010: 12, manylinux2014: 17 };
    let m = tag.match(/^manylinux_2_(\d+)_(\w+)$/);
    if (m && m[2] === sys.arch) return 1000 - Number(m[1]);
    m = tag.match(/^(manylinux1|manylinux2010|manylinux2014)_(\w+)$/);
    if (m && m[2] === sys.arch) return 1000 - legacy[m[1]];
    return null;
  }
  const m = tag.match(/^macosx_(\d+)_(\d+)_(arm64|universal2)$/);
  if (!m || (m[3] === "arm64" && Number(m[1]) < 11)) return null;
  return ((100 - Number(m[1])) * 100 + (100 - Number(m[2]))) * 2 + (m[3] === "universal2" ? 1 : 0);
}
// A wheel's place in the order for this system, or null when it does not fit.
function wheelRank(file, sys) {
  const [py, abi, plat] = file.slice(0, -4).split("-").slice(-3).map((p) => p.split("."));
  let best = null;
  for (const p of py) for (const a of abi) for (const t of plat) {
    const any = t === "any";
    const ir = interpreterRank(p, a, !any);
    const pr = any ? 0 : platformRank(t, sys);
    if (ir === null || pr === null) continue;
    const r = ir * 1e6 + pr;
    if (best === null || r < best) best = r;
  }
  return best;
}

function measureSystem(sys) {
  const rows = installSet(sys).map((p) => {
    const fits = p.wheels.map((w) => ({ ...w, rank: wheelRank(w.file, sys) })).filter((w) => w.rank !== null);
    if (!fits.length) throw new Error(`${p.name} ${p.version}: no wheel fits`);
    fits.sort((a, b) => a.rank - b.rank);
    const sizes = fits.map((w) => w.size);
    return { pkg: p, chosen: fits[0], min: Math.min(...sizes), max: Math.max(...sizes), choices: fits.length };
  });
  const sum = (f) => rows.reduce((t, r) => t + f(r), 0);
  return { rows, total: sum((r) => r.chosen.size), min: sum((r) => r.min), max: sum((r) => r.max) };
}

// What step 4's install fetched on this PC: the package files its log requested, and its kept Python archive.
function measuredHere() {
  const log = readFileSync(path.join(BUILD, "install", "sync.log"), "utf8");
  const gets = [...log.matchAll(/Sending (?:fresh|cached|revalidation) GET request for: (\S+)/g)].map((m) => m[1]);
  const urls = [...new Set(gets)];
  const sizes = new Map(pkgs.flatMap((p) => p.wheels.map((w) => [w.url, w.size])));
  const notInLock = urls.filter((u) => !sizes.has(u));
  const python = [...log.matchAll(/Downloading `(\S+)` to `([^`]+)`/g)].map(([, url, file]) => ({
    url, file, size: existsSync(file) ? statSync(file).size : null,
  }));
  return { gets: gets.length, urls, notInLock, packages: urls.reduce((t, u) => t + (sizes.get(u) ?? 0), 0), python };
}

function model() {
  const data = readFileSync(MODEL);
  return { size: data.length, sha256: createHash("sha256").update(data).digest("hex") };
}

// uv's own listing of Python downloads, offline, with a proxy that records and refuses every connection.
async function uvListing() {
  const { dir, env } = throwaway("download");
  const connections = [];
  const proxyServer = createServer((socket) => {
    connections.push(`${socket.remoteAddress}:${socket.remotePort}`);
    socket.destroy();
  });
  await new Promise((r) => proxyServer.listen(0, "127.0.0.1", r));
  const proxy = `http://127.0.0.1:${proxyServer.address().port}`;
  const set = {
    UV_OFFLINE: "1",
    UV_TOOL_DIR: path.join(dir, "uv-tools"),
    UV_PYTHON_BIN_DIR: path.join(dir, "python-bin"),
    UV_PYTHON_CACHE_DIR: path.join(dir, "python-cache"),
    UV_PYTHON_PREFERENCE: "only-managed",
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
  };
  const kept = Object.entries(env).filter(([k]) => !(k.toUpperCase() in set) && !/proxy$/i.test(k));
  const full = { ...Object.fromEntries(kept), ...set };
  for (const k of Object.keys(full).sort()) {
    if (/^(UV_|USERPROFILE$|HOME$|.*PROXY$)/i.test(k)) console.log(`env ${k}=${full[k]}`);
  }
  const run = (args) => new Promise((resolve) => {
    const child = spawn("uv", args, { cwd: path.join(dir, "home"), env: full });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (status) => resolve({ status, out, err }));
  });
  const inside = (p) => {
    const r = path.relative(BUILD.toLowerCase(), path.resolve(p).toLowerCase());
    return r !== "" && !r.startsWith("..") && !path.isAbsolute(r);
  };
  let ok = true;
  for (const args of [["cache", "dir"], ["python", "dir"], ["python", "dir", "--bin"]]) {
    const r = await run(args);
    console.log(`uv ${args.join(" ")} -> exit ${r.status}: ${r.out.trim()}`);
    if (r.status !== 0 || !inside(r.out.trim())) ok = false;
  }
  for (const k of ["UV_TOOL_DIR", "UV_PYTHON_CACHE_DIR"]) if (!inside(full[k])) ok = false;
  if (!ok) {
    proxyServer.close();
    throw new Error("a uv folder lies outside the build folder; the listing was not run");
  }
  const args = ["python", "list", PYTHON, "--all-platforms", "--all-arches", "--only-downloads", "--show-urls",
    "--output-format", "json", "-vv"];
  const r = await run(args);
  await new Promise((res) => setTimeout(res, 200));
  proxyServer.close();
  const logLines = r.err.split(/\r?\n/).filter(Boolean);
  const network = logLines.filter((l) => /https?:\/\/|GET request|Downloading|Fetching/i.test(l));
  console.log(`uv ${args.join(" ")} -> exit ${r.status}; log lines ${logLines.length}, naming a request: ${
    network.length}; connections to the proxy: ${connections.length}`);
  const list = JSON.parse(r.out);
  const fields = [...new Set(list.flatMap((x) => Object.keys(x)))];
  console.log(`uv's listing: ${list.length} downloads; fields: ${fields.join(", ")}`);
  const sizeFields = fields.filter((f) => /size|length|bytes/i.test(f));
  return { status: r.status, connections: connections.length, network: network.length, list, sizeFields };
}

const fmt = (n) => n.toLocaleString("en-US");
const mb = (n) => (n / MB).toFixed(1);

const results = Object.fromEntries(Object.entries(systems).map(([n, s]) => [n, measureSystem(s)]));
const here = measuredHere();
const m = model();
console.log(`lock: ${LOCK}; Python ${PYTHON}; MB = 1,000,000 bytes`);
console.log(`model: ${MODEL}, ${fmt(m.size)} bytes, sha256 ${m.sha256}: ${m.sha256 === MODEL_SHA256
  ? "as approved at step 5" : "NOT as approved"}`);
const listing = await uvListing();

console.log("\nPackages by system (one wheel per package, sized by the lock):");
for (const [n, r] of Object.entries(results)) {
  const several = r.rows.filter((x) => x.choices > 1).length;
  console.log(`${n}: ${r.rows.length} packages, ${fmt(r.total)} bytes (${mb(r.total)} MB); over every fitting wheel` +
    ` ${fmt(r.min)} to ${fmt(r.max)} bytes (${mb(r.min)} to ${mb(r.max)} MB); packages with more than one fitting` +
    ` wheel: ${several}`);
  for (const x of r.rows.filter((y) => y.min !== y.max)) {
    console.log(`  ${x.pkg.name} ${x.pkg.version}: chosen ${x.chosen.file} ${fmt(x.chosen.size)}; fitting wheels ` +
      `${x.choices}, ${fmt(x.min)} to ${fmt(x.max)}`);
  }
}

const win = results["Windows x86-64"];
const chosen = new Set(win.rows.map((r) => r.chosen.url));
const fetched = new Set(here.urls);
const onlyChosen = [...chosen].filter((u) => !fetched.has(u)).map((u) => decodeURIComponent(u.split("/").pop()));
const onlyFetched = [...fetched].filter((u) => !chosen.has(u)).map((u) => decodeURIComponent(u.split("/").pop()));
console.log(`\nThis PC (step 4, install\\sync.log): ${here.gets} package GET requests, ${here.urls.length} files, ` +
  `not in the lock: ${here.notInLock.length}, ${fmt(here.packages)} bytes`);
console.log(`Windows x86-64 computed against fetched: chosen and not fetched: ${onlyChosen.join(", ") || "none"}; ` +
  `fetched and not chosen: ${onlyFetched.join(", ") || "none"}`);
for (const p of here.python) {
  console.log(`Python archive here: ${decodeURIComponent(p.url.split("/").pop())}, ${p.size === null ? "not kept"
    : `${fmt(p.size)} bytes`} (${p.file})`);
}

console.log("\nPython downloads uv would make, from its listing:");
const python = {};
for (const [n, s] of Object.entries(systems)) {
  const entry = listing.list.find((x) => x.key === `cpython-${PYTHON}-${s.uvKey}`);
  const file = entry ? decodeURIComponent(entry.url.split("/").pop()) : "not listed";
  const sizeField = entry && listing.sizeFields.find((f) => typeof entry[f] === "number");
  let size = sizeField ? entry[sizeField] : null, source = sizeField ? `uv's listing, field ${sizeField}` : null;
  if (n === "Windows x86-64") {
    const p = here.python.find((x) => decodeURIComponent(x.url) === decodeURIComponent(entry?.url ?? ""));
    if (p?.size) { size = p.size; source = "measured here (step 4's kept archive)"; }
  }
  python[n] = size;
  console.log(`${n}: ${file}: ${size === null ? "not measured (uv's listing gives no size)" : `${fmt(size)} bytes, ${
    source}`}`);
}

console.log("\nTable, MB (1,000,000 bytes):");
console.log("system | packages | model | Python | without Python | with Python");
for (const [n, r] of Object.entries(results)) {
  const py = python[n];
  console.log(`${n} | ${mb(r.total)} | ${mb(m.size)} | ${py === null ? "not measured" : mb(py)} | ${
    mb(r.total + m.size)} | ${py === null ? "not measured" : mb(r.total + m.size + py)}`);
}
const pyHere = here.python[0]?.size ?? 0;
const measuredTotal = here.packages + m.size + pyHere;
const computedTotal = win.total + m.size + (python["Windows x86-64"] ?? 0);
console.log(`This PC: measured ${fmt(measuredTotal)} bytes (${mb(measuredTotal)} MB); computed ${fmt(computedTotal)} ` +
  `bytes (${mb(computedTotal)} MB); gap ${fmt(measuredTotal - computedTotal)} bytes`);
const fine = listing.status === 0 && listing.connections === 0 && listing.network === 0 && m.sha256 === MODEL_SHA256 &&
  !here.notInLock.length && !onlyChosen.length && !onlyFetched.length;
console.log(fine ? "measure-download: passed" : "measure-download: FAILED");
process.exitCode = fine ? 0 : 1;
