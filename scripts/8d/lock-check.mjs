// The lock check for release 8d (8d plan, step 3). Not part of Tachikoma: run by hand. Reads a uv.lock and reports
//  - the package count, and every sdist and wheel line without a sha256 hash;
//  - the mempalace entry's wheel hash;
//  - for CPython 3.10 to 3.14 on Windows, Linux (glibc) and macOS, each on x86_64 and arm64, the packages that would
//    be installed (dependency markers and extras followed from the project) and which of them have no ready-built
//    file (wheel) for that system, with the newest glibc / macOS a system needs for every package to have one.
//   node scripts/8d/lock-check.mjs memory/uv.lock
import { readFileSync } from "node:fs";

const text = readFileSync(process.argv[2], "utf8").replace(/\r\n/g, "\n");
const blocks = text.split("\n[[package]]\n").slice(1);

const pkgs = blocks.map((b) => {
  const field = (k) => (b.match(new RegExp(`^${k} = "([^"]*)"`, "m")) || [])[1];
  const lines = b.split("\n");
  const artifacts = lines.filter((l) => /^sdist = \{|^\s+\{ url = /.test(l));
  const wheels = lines.filter((l) => /^\s+\{ url = .*\.whl"/.test(l)).map((l) => {
    const url = l.match(/url = "([^"]+)"/)[1];
    const hash = (l.match(/hash = "(sha256:[0-9a-f]{64})"/) || [])[1];
    return { file: decodeURIComponent(url.split("/").pop()), hash };
  });
  const sdist = lines.find((l) => l.startsWith("sdist = {"));
  const deps = (section) => {
    const m = b.match(new RegExp(`^${section} = \\[\\n([\\s\\S]*?)^\\]`, "m"));
    return m ? parseDeps(m[1]) : [];
  };
  const optional = {};
  const opt = b.split("\n[package.optional-dependencies]\n")[1];
  if (opt) for (const m of opt.matchAll(/^([\w-]+) = \[\n([\s\S]*?)^\]/gm)) optional[m[1]] = parseDeps(m[2]);
  return {
    name: field("name"), version: field("version"), source: (b.match(/^source = (.*)$/m) || [])[1],
    artifacts, wheels, sdist, deps: deps("dependencies"), optional,
  };
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

// PEP 508 markers, the subset this lock uses (and/or, parentheses, comparisons on strings and python_full_version).
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
    const ver = lt === "python_full_version" || lt === "python_version";
    if (ver) {
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

const systems = {
  "windows x86_64": { sys_platform: "win32", platform_machine: "AMD64", os_name: "nt", os: "win", arch: "x86_64" },
  "windows arm64": { sys_platform: "win32", platform_machine: "ARM64", os_name: "nt", os: "win", arch: "arm64" },
  "linux x86_64": { sys_platform: "linux", platform_machine: "x86_64", os_name: "posix", os: "linux", arch: "x86_64" },
  "linux arm64": { sys_platform: "linux", platform_machine: "aarch64", os_name: "posix", os: "linux", arch: "arm64" },
  "macos arm64": { sys_platform: "darwin", platform_machine: "arm64", os_name: "posix", os: "mac", arch: "arm64" },
  "macos x86_64": { sys_platform: "darwin", platform_machine: "x86_64", os_name: "posix", os: "mac", arch: "x86_64" },
};
// Patch numbers only matter for the lock's one "< '3.10.2'" marker; these are past it.
const pythons = ["3.10.11", "3.11.9", "3.12.10", "3.13.5", "3.14.0"];

// The lowest system version a wheel's platform tag needs on this system, or null if it does not fit.
function platNeed(tag, sys) {
  if (tag === "any") return { kind: "any" };
  if (sys.os === "win") return tag === (sys.arch === "x86_64" ? "win_amd64" : "win_arm64") ? { kind: "any" } : null;
  if (sys.os === "linux") {
    const arch = sys.arch === "x86_64" ? "x86_64" : "aarch64";
    const legacy = { manylinux1: "2.5", manylinux2010: "2.12", manylinux2014: "2.17" };
    let m = tag.match(/^manylinux_(\d+)_(\d+)_(\w+)$/);
    if (m && m[3] === arch) return { kind: "glibc", v: `${m[1]}.${m[2]}` };
    m = tag.match(/^(manylinux1|manylinux2010|manylinux2014)_(\w+)$/);
    if (m && m[2] === arch) return { kind: "glibc", v: legacy[m[1]] };
    return null;
  }
  const m = tag.match(/^macosx_(\d+)_(\d+)_(\w+)$/);
  if (!m) return null;
  const fits = sys.arch === "arm64" ? ["arm64", "universal2"] : ["x86_64", "universal2", "intel"];
  return fits.includes(m[3]) ? { kind: "macos", v: `${m[1]}.${m[2]}` } : null;
}
function pyFits(py, abi, minor) {
  if (abi === "none") return py === "py3" || py === `py3${minor}` || py === `cp3${minor}`;
  if (abi === "abi3") { const m = py.match(/^cp3(\d+)$/); return !!m && Number(m[1]) <= minor; }
  return abi === `cp3${minor}` && py === `cp3${minor}`;
}
// The lowest need among a package's wheels that fit, or null when none fits.
function wheelFor(pkg, sys, minor) {
  let best = null;
  for (const w of pkg.wheels) {
    const parts = w.file.slice(0, -4).split("-");
    const [py, abi, plat] = parts.slice(-3).map((p) => p.split("."));
    if (!py.some((p) => abi.some((a) => pyFits(p, a, minor)))) continue;
    for (const t of plat) {
      const need = platNeed(t, sys);
      if (!need) continue;
      if (need.kind === "any") return need;
      if (!best || cmpVersion(need.v, best.v) < 0) best = need;
    }
  }
  return best;
}

function installSet(sys, full) {
  const env = { ...sys, python_full_version: full, python_version: full.split(".").slice(0, 2).join("."),
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

console.log(`package entries: ${pkgs.length} (${pkgs.filter((p) => p.source?.includes("virtual")).length} virtual)`);
const names = new Set(pkgs.map((p) => p.name));
console.log(`distinct names: ${names.size}; names with more than one version: ${
  [...names].filter((n) => pkgs.filter((p) => p.name === n).length > 1).map((n) =>
    `${n} (${pkgs.filter((p) => p.name === n).map((p) => p.version).join(", ")})`).join("; ")}`);
let bad = 0, files = 0;
for (const p of pkgs) {
  if (p.source?.includes("virtual")) continue;
  if (!p.artifacts.length) { console.log(`NO FILES: ${p.name} ${p.version}`); bad++; }
  if (!p.source?.includes("registry = \"https://pypi.org/simple\"")) {
    console.log(`NOT PYPI: ${p.name} ${p.source}`);
    bad++;
  }
  for (const a of p.artifacts) {
    files++;
    if (!/hash = "sha256:[0-9a-f]{64}"/.test(a)) { console.log(`NO HASH: ${p.name} ${a.trim().slice(0, 100)}`); bad++; }
  }
}
console.log(`files listed: ${files}; without a sha256 hash, or packages without files or not from PyPI: ${bad}`);
const mp = pkgs.find((p) => p.name === "mempalace");
console.log(`mempalace ${mp.version}: ${mp.wheels.map((w) => `${w.file} ${w.hash}`).join("; ")}`);
console.log(`mempalace sdist: ${(mp.sdist.match(/hash = "([^"]+)"/) || [])[1]}`);
console.log(`packages with no wheel at all: ${pkgs.filter((p) => !p.source?.includes("virtual") && !p.wheels.length)
  .map((p) => `${p.name} ${p.version}`).join(", ") || "none"}`);
console.log(`packages with no sdist: ${pkgs.filter((p) => !p.source?.includes("virtual") && !p.sdist)
  .map((p) => `${p.name} ${p.version}`).join(", ") || "none"}`);

console.log("\nsystem | python | packages installed | without a wheel | newest glibc/macOS needed (by which package)");
for (const [sname, sys] of Object.entries(systems)) {
  for (const full of pythons) {
    const minor = Number(full.split(".")[1]);
    const set = installSet(sys, full);
    const missing = [];
    let need = null, by = "";
    for (const p of set) {
      const w = wheelFor(p, sys, minor);
      if (!w) { missing.push(`${p.name} ${p.version}${p.sdist ? "" : " (no sdist either)"}`); continue; }
      if (w.kind !== "any" && (!need || cmpVersion(w.v, need) > 0)) { need = w.v; by = p.name; }
    }
    const short = full.split(".").slice(0, 2).join(".");
    console.log(`${sname} | ${short} | ${set.length} | ${missing.join(", ") || "none"} | ${
      need ? `${sys.os === "mac" ? "macOS" : "glibc"} ${need} (${by})` : "-"}`);
  }
}
