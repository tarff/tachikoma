// Measurement 4, how often a window's "in use" file is refreshed and when one counts as stale (8d plan, step 9). Not
// part of Tachikoma: run by hand, between two snapshots of the user's folders, with tsx (so the repo's own code can be
// imported) and tsx's cache off (so tsx writes nothing to the user's Temp folder):
//
//   TSX_DISABLE_CACHE=1 node --import tsx scripts/8d/measure-inuse.mjs
//
// Everything happens in a run folder of its own, inside step 1's `inuse` throwaway in the build folder. The script's
// own environment is replaced by that throwaway's at the start, so every child, the repo's own included (privateDir's
// whoami, PowerShell and icacls, and killTree's taskkill, which take `commandEnv()`), gets it: TEMP and TMP, the home
// and the rest inside the build folder, no API keys.
//
// What it measures:
// - What one refresh costs: rewriting a small file in a folder this run made and made private itself with the repo's
//   `privateDir` (src/auth/private.ts:72-95), never any other folder. Before each call that can change permissions,
//   the folder is checked: inside the build folder, made by this run (not there before), a plain folder, and no link
//   or junction on its way. Two forms: the repo's private write, `writePrivate` (src/auth/private.ts:155-173: a new
//   file, written, flushed to disk, swapped in), and a plain overwrite (`writeFileSync`).
// - How late a timer can fire while the process is held up: a timer of TICK_MS runs beside each kind of work, and
//   the gap between its firings across each piece of work is recorded. The kinds: making a new folder private (the
//   first `privateDir` of a folder runs PowerShell and icacls synchronously); a synchronous taskkill exactly as
//   src/exec/local.ts:37-53 runs it (the repo's own `killTree`), on a PowerShell this script started the way
//   local.ts starts a command, with a Node program under it; a large file read the way read_file reads
//   (src/exec/local.ts:162-164, src/tools/files.ts:296-320); and a SHA-256 of a file the size of the model, whole and
//   streamed. Also the timer alone, for a baseline. The large file and the hashed file are step 5's model archive,
//   read only.
// - The taskkill only ever runs on a PowerShell this script started, by its id, after a start-time check: its start
//   time, read by the build's Python (`-I`, GetProcessTimes), must fall between just before and just after the spawn,
//   must be the same when read again just before the kill, and Node must not have seen it exit (killTree's own
//   check). Nothing else is ever stopped. Afterwards the Node program under it is looked up again by id and start
//   time, and every process whose parent is one of the shells is listed.
//
// The counts, steps and cut-offs below are this script's choices, each with its reason; none is a figure for
// Tachikoma. Nothing is fetched; no MemPalace runs.
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync,
  writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { privateDir, writePrivate } from "../../src/auth/private.ts";
import { killTree, shellFor } from "../../src/exec/local.ts";
import { BUILD, throwaway } from "./throwaway.mjs";

const PYTHON = path.join(BUILD, "env", "Scripts", "python.exe");
const POWERSHELL = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0",
  "powershell.exe");
// Step 5's model archive (83,178,821 bytes, SHA-256 below, step 5's record): the large file read and the hashed file.
const ARCHIVE = path.join(BUILD, "model-download", "onnx.tar.gz");
const ARCHIVE_SHA256 = "913d7300ceae3b2dbc2c50d1de4baacab4be7b9380491c27fab7418616a16ec3";

// The timer's step: shorter than any hold-up worth knowing about, so the gap across a piece of work shows its whole
// length; the same as step 8's polling step. Windows wakes timers in steps of about 15.6 ms by default, and the idle
// baseline shows what that adds.
const TICK_MS = 10;
// Between two pieces of work, so the gaps around one never run into the next one's: ten timer steps.
const PAUSE_MS = 100;
// The baseline: the timer alone for 30 s, about as long as the longest phase of work, so a rare pause of the idle
// process would show.
const IDLE_MS = 30_000;
// The self-check: a 200 ms busy wait must show as a gap of at least 200 ms, far above an idle gap, or the timer does
// not catch a hold-up and the run fails.
const SELF_CHECK_MS = 200;
// Refreshes of each form: each takes about a millisecond, so a thousand show the rare slow write; TICK_MS apart, so
// each meets a disk that has finished the one before, as a timer's refresh would.
const REFRESHES = 1_000;
// The file a refresh writes: about what a window's "in use" file would hold, its process id and a time.
const inUseText = () => JSON.stringify({ pid: process.pid, time: Date.now() });
// New folders made private: each starts PowerShell two or three times and icacls twice (src/auth/private.ts:76-89),
// about a second; five give a middle and a spread with few permission changes, all on folders this run made.
const PRIVATE_DIRS = 5;
// Taskkills: each needs a PowerShell and a Node program started first and four start-time reads; twenty, as step 8's
// start-time reads, give a middle and a spread.
const KILLS = 20;
// Reads of the large file and hashes of each form: each takes a fraction of a second; twenty, as above.
const READS = 20;
const HASHES = 20;
// The Node program under each PowerShell ends by itself after 120 s, so nothing of this run can outlive it by more,
// even if a kill missed it.
const INNER_LIFE_MS = 120_000;
// How long the script waits for that Node program to say it has started: its own cut-off, so a run always ends.
const MARKER_GIVE_UP_MS = 30_000;
// A process's start time (GetProcessTimes) comes from the system clock's coarse reading, which moves in Windows'
// 15.6 ms steps, so it can read up to one step earlier than Node's precise clock just before the spawn: 16 ms of
// leeway on each side.
const CLOCK_STEP_US = 16_000;

// The build Python reads a process's start time, as step 8's START_TIME_PY (scripts/8d/measure-hub.mjs): 100 ns
// steps since 1601, or "error <code>" when no process has that id.
const START_TIME_PY = String.raw`
import ctypes, sys
from ctypes import wintypes
k = ctypes.WinDLL('kernel32', use_last_error=True)
k.OpenProcess.restype = wintypes.HANDLE
k.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
k.CloseHandle.argtypes = (wintypes.HANDLE,)
h = k.OpenProcess(0x1000, False, int(sys.argv[1]))
if not h:
    print('error', ctypes.get_last_error())
    sys.exit(1)
c, e, kt, u = wintypes.FILETIME(), wintypes.FILETIME(), wintypes.FILETIME(), wintypes.FILETIME()
ok = k.GetProcessTimes(h, ctypes.byref(c), ctypes.byref(e), ctypes.byref(kt), ctypes.byref(u))
k.CloseHandle(h)
print((c.dwHighDateTime << 32) | c.dwLowDateTime if ok else 'error')
`;

// The Node program each PowerShell runs: it writes its id to the marker file named, then waits.
const INNER = `require("fs").writeFileSync(process.argv[2], String(process.pid));
setTimeout(() => {}, ${INNER_LIFE_MS});
`;

const round1 = (x) => Math.round(x * 10) / 10;
function stats(values) {
  const v = values.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const m = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  return { n: v.length, fastest: round1(v[0]), middle: round1(m), slowest: round1(v.at(-1)) };
}
const line = (name, s) =>
  `${name}: ${s.n ? `fastest ${s.fastest} ms, middle ${s.middle} ms, slowest ${s.slowest} ms` : "none"} (${s.n} runs)`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (text) => console.log(`[${new Date().toISOString()}] ${text}`);

// ---- the run's set-up ----

const { dir: inuseDir, env } = throwaway("inuse");
// The script's own environment becomes the throwaway's, so every child gets it (see the top).
for (const k of Object.keys(process.env)) delete process.env[k];
Object.assign(process.env, env);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = path.join(inuseDir, `measure-inuse-${stamp}`);
const out = { stamp, runDir, failures: [] };
const fail = (what) => {
  out.failures.push(what);
  say(`FAILED: ${what}`);
};

// Folders this run made itself, by exact path: the only ones privateDir is ever given.
const made = new Set();
function makeOwn(parent, name) {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`not a plain name: ${name}`);
  const dir = path.join(parent, name);
  mkdirSync(dir); // not recursive: throws if it is already there, so it is always this run's own
  made.add(dir);
  return dir;
}
// Checked before every call that can change permissions.
function checkOwn(dir) {
  const rel = path.relative(BUILD, dir);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`not inside the build folder: ${dir}`);
  if (!made.has(dir)) throw new Error(`not a folder this run made: ${dir}`);
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`not a plain folder: ${dir}`);
  if (realpathSync.native(dir).toLowerCase() !== dir.toLowerCase()) throw new Error(`a link on the way to ${dir}`);
}

function pcDescription() {
  const script = "$p = Get-CimInstance Win32_Processor | Select-Object -First 1; " +
    "$d = @(Get-PhysicalDisk | ForEach-Object { \"$($_.FriendlyName) $($_.MediaType) $($_.BusType)\" }); " +
    "$m = (Get-MpComputerStatus).RealTimeProtectionEnabled; " +
    "ConvertTo-Json -Compress @{ cpu = $p.Name; cores = $p.NumberOfCores; threads = $p.NumberOfLogicalProcessors; " +
    "disks = $d; defenderRealTime = $m }";
  const ps = spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], { env: process.env, encoding: "utf8", windowsHide: true });
  let hw = {};
  try {
    hw = JSON.parse(ps.stdout);
  } catch {
    hw = { error: ps.stderr.slice(0, 200) };
  }
  return { ...hw, memoryGB: round1(os.totalmem() / 1e9), windows: `${os.version()} ${os.release()}`,
    node: process.version };
}

// A process's start time in microseconds since 1970, or null when no process has that id. Asynchronous, so the
// reads never hold the timer up.
function startTime(pid) {
  return new Promise((resolve) => {
    execFile(PYTHON, ["-I", "-c", START_TIME_PY, String(pid)], { env: process.env, windowsHide: true },
      (err, stdout) => {
        const t = String(stdout).trim();
        resolve(!err && /^\d+$/.test(t) ? Number(BigInt(t) / 10n - 11_644_473_600_000_000n) : null);
      });
  });
}
const nowUs = () => (performance.timeOrigin + performance.now()) * 1000;

// ---- the timer and its gaps ----

let ticks = [];
let timer;
function startTicks() {
  ticks = [];
  timer = setInterval(() => ticks.push(performance.now()), TICK_MS);
}
function stopTicks() {
  clearInterval(timer);
  return ticks;
}
// The longest gap between two firings of the timer from the last one at or before `s` to the first one at or after
// `e`: for work that holds the process the whole time, the gap that spans it.
function gapOver(t, s, e) {
  let a = 0;
  while (a + 1 < t.length && t[a + 1] <= s) a++;
  let b = a;
  while (b + 1 < t.length && t[b] < e) b++;
  let g = 0;
  for (let i = a; i < b; i++) g = Math.max(g, t[i + 1] - t[i]);
  return g;
}
const gapsOf = (t) => t.slice(1).map((x, i) => x - t[i]);

// Runs `op` `runs` times with the timer going, PAUSE_MS apart. `op` returns the span of the work to judge, [start,
// end] in performance.now() milliseconds, and anything to keep.
async function phase(name, runs, op) {
  say(`${name}: ${runs} runs`);
  startTicks();
  await sleep(PAUSE_MS);
  const spans = [];
  for (let i = 0; i < runs; i++) {
    spans.push(await op(i));
    await sleep(PAUSE_MS);
  }
  const t = stopTicks();
  const took = spans.map(([s, e]) => e - s);
  const gaps = spans.map(([s, e]) => gapOver(t, s, e));
  const result = { took: stats(took), gap: stats(gaps), longestGapInPhase: round1(Math.max(...gapsOf(t))),
    ticks: t.length, raw: { took: took.map(round1), gap: gaps.map(round1) } };
  say(line(`${name}, the work`, result.took));
  say(line(`${name}, the timer's gap across it`, result.gap));
  return { result, spans };
}

// ---- the phases ----

async function idle() {
  say(`idle: the timer alone for ${IDLE_MS} ms`);
  startTicks();
  await sleep(IDLE_MS);
  const g = gapsOf(stopTicks());
  const s = stats(g);
  say(line("idle, gaps between firings", s));
  return { gap: s, over20: g.filter((x) => x > 20).length, over50: g.filter((x) => x > 50).length };
}

async function selfCheck() {
  startTicks();
  await sleep(PAUSE_MS);
  const s = performance.now();
  while (performance.now() - s < SELF_CHECK_MS) {
    // busy: holds the process
  }
  const e = performance.now();
  await sleep(PAUSE_MS);
  const g = gapOver(stopTicks(), s, e);
  say(`self-check: a ${SELF_CHECK_MS} ms busy wait showed as a gap of ${round1(g)} ms`);
  if (g < SELF_CHECK_MS) fail(`the timer missed a ${SELF_CHECK_MS} ms hold-up (gap ${g} ms)`);
  return round1(g);
}

async function privateDirs() {
  const dirs = [];
  const { result } = await phase("privateDir, new folder", PRIVATE_DIRS, async (i) => {
    const dir = makeOwn(runDir, `private-${i + 1}`);
    checkOwn(dir);
    dirs.push(dir);
    const s = performance.now();
    privateDir(dir);
    return [s, performance.now()];
  });
  return { result, dirs };
}

async function refreshes(dir) {
  const results = {};
  for (const [form, file, write] of [
    ["writePrivate", path.join(dir, "inuse-private.json"), (f) => writePrivate(f, inUseText())],
    ["plain overwrite", path.join(dir, "inuse-plain.json"), (f) => writeFileSync(f, inUseText())],
  ]) {
    say(`refresh, ${form}: ${REFRESHES} runs, ${TICK_MS} ms apart`);
    const took = [];
    for (let i = 0; i < REFRESHES; i++) {
      if (path.dirname(file) !== dir) throw new Error(`refresh outside ${dir}`);
      checkOwn(dir);
      const s = performance.now();
      write(file);
      took.push(performance.now() - s);
      await sleep(TICK_MS);
    }
    results[form] = { took: stats(took), first: round1(took[0]), over5: took.filter((x) => x > 5).length,
      over50: took.filter((x) => x > 50).length };
    say(line(`refresh, ${form}`, results[form].took));
  }
  return results;
}

// The PowerShells started, each with what is known of it, for the end's look-up.
const shells = [];

async function waitFor(file) {
  const s = performance.now();
  while (!existsSync(file)) {
    if (performance.now() - s > MARKER_GIVE_UP_MS) return null;
    await sleep(TICK_MS);
  }
  return Number(readFileSync(file, "utf8"));
}

async function kills() {
  const inner = path.join(runDir, "inner.cjs");
  writeFileSync(inner, INNER);
  const shell = shellFor("win32");
  return phase("taskkill (killTree)", KILLS, async (i) => {
    const marker = path.join(runDir, `inner-${i + 1}.pid`);
    const command = `& '${process.execPath}' '${inner}' '${marker}'`;
    const [file, ...args] = shell.argv(command);
    const before = nowUs() - CLOCK_STEP_US;
    // As local.ts starts a command (src/exec/local.ts:106).
    const child = spawn(file, args, { cwd: runDir, env: process.env, windowsHide: true, detached: false,
      stdio: ["ignore", "pipe", "pipe"] });
    const after = nowUs() + CLOCK_STEP_US;
    child.stdout.resume();
    child.stderr.resume();
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const rec = { pid: child.pid, innerPid: null, ok: false };
    shells.push(rec);
    rec.start = await startTime(child.pid);
    rec.innerPid = await waitFor(marker);
    rec.innerStart = rec.innerPid ? await startTime(rec.innerPid) : null;
    const again = await startTime(child.pid);
    const alive = child.exitCode === null && child.signalCode === null;
    if (rec.start == null || rec.start < before || rec.start > after || again !== rec.start || !alive ||
      rec.innerStart == null || rec.innerStart < rec.start) {
      fail(`kill ${i + 1}: the start-time check did not pass (${JSON.stringify({ ...rec, again, alive, before,
        after })}); nothing was stopped`);
      const t = performance.now();
      return [t, t];
    }
    const s = performance.now();
    killTree(child);
    const e = performance.now();
    await exited;
    // The Node program under it, looked up again by id: gone, or another program's (a different start time).
    const innerNow = await startTime(rec.innerPid);
    rec.innerGone = innerNow !== rec.innerStart;
    if (!rec.innerGone) fail(`kill ${i + 1}: the Node program ${rec.innerPid} still runs (it ends by itself)`);
    rec.ok = true;
    return [s, e];
  });
}

// Every process whose parent is one of the shells and which started after that shell: left by this run. Null, and the
// run fails, when the look itself fails, so a failed look never reads as "none".
function leftUnderShells() {
  const ids = shells.map((r) => r.pid).join(",");
  if (!ids) return [];
  const script = "$ErrorActionPreference = 'Stop'; " +
    `$ids = @(${ids}); @(Get-CimInstance Win32_Process | Where-Object { $ids -contains ` +
    "$_.ParentProcessId } | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; " +
    "name = $_.Name; start = $_.CreationDate.ToUniversalTime().ToString('o') } }) | ConvertTo-Json -Compress";
  const ps = spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], { env: process.env, encoding: "utf8", windowsHide: true });
  if (ps.error || ps.status !== 0 || ps.stderr.trim()) {
    fail(`the look for processes left under the shells failed (exit ${ps.status}${ps.error ? `, ${ps.error.message}` :
      ""}): ${String(ps.stderr).trim().slice(0, 200)}`);
    return null;
  }
  const rows = ps.stdout.trim() ? [JSON.parse(ps.stdout)].flat() : [];
  return rows.filter((row) => {
    const parent = shells.find((r) => r.pid === row.ppid);
    return parent?.start != null && Date.parse(row.start) * 1000 >= parent.start - CLOCK_STEP_US;
  });
}

async function reads() {
  return phase("large file read (read_file's way)", READS, async () => {
    const s = performance.now();
    // src/exec/local.ts:162-164, then src/tools/files.ts:296-320 with read_file's defaults (offset 1, 2,000 lines).
    const text = await readFile(ARCHIVE, "utf8");
    const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
    const room = 30_000 - 100;
    const rows = [];
    let size = 0;
    for (let n = 1; n < 1 + 2000 && n <= lines.length; n++) {
      const row = `${String(n).padStart(6)}\t${lines[n - 1]}`;
      if (rows.length && size + row.length + 1 > room) break;
      rows.push(row);
      size += row.length + 1;
    }
    out.readLines = lines.length;
    return [s, performance.now()];
  });
}

async function hashes() {
  const check = (hex) => {
    if (hex !== ARCHIVE_SHA256) fail(`the archive's SHA-256 was ${hex}`);
  };
  const whole = await phase("SHA-256, whole file at once", HASHES, async () => {
    const s = performance.now();
    check(createHash("sha256").update(readFileSync(ARCHIVE)).digest("hex"));
    return [s, performance.now()];
  });
  const streamed = await phase("SHA-256, streamed", HASHES, async () => {
    const s = performance.now();
    const h = createHash("sha256");
    await new Promise((resolve, reject) => createReadStream(ARCHIVE).on("data", (c) => h.update(c))
      .on("end", resolve).on("error", reject));
    check(h.digest("hex"));
    return [s, performance.now()];
  });
  return { whole: whole.result, streamed: streamed.result };
}

// ---- the run ----

async function main() {
  if (!existsSync(PYTHON)) throw new Error(`no ${PYTHON}`);
  if (!existsSync(ARCHIVE)) throw new Error(`no ${ARCHIVE}`);
  mkdirSync(runDir); // not recursive: a new folder, this run's own
  made.add(runDir);
  say(`run folder ${runDir}`);
  for (const k of ["TEMP", "TMP", "USERPROFILE", "HOME"]) say(`env ${k}=${process.env[k]}`);
  out.pc = pcDescription();
  say(`this PC: ${JSON.stringify(out.pc)}`);
  out.settings = { TICK_MS, PAUSE_MS, IDLE_MS, SELF_CHECK_MS, REFRESHES, PRIVATE_DIRS, KILLS, READS, HASHES,
    archiveBytes: statSync(ARCHIVE).size };
  out.selfCheck = await selfCheck();
  out.idle = await idle();
  const pd = await privateDirs();
  out.privateDir = pd.result;
  out.refresh = await refreshes(pd.dirs[0]);
  out.kill = (await kills()).result;
  out.shells = shells;
  out.leftUnderShells = leftUnderShells();
  if (out.leftUnderShells?.length) fail(`processes left under the shells: ${JSON.stringify(out.leftUnderShells)}`);
  else if (out.leftUnderShells) say(`left under the ${shells.length} shells: none`);
  out.read = (await reads()).result;
  say(`the archive read as text: ${out.readLines} lines`);
  Object.assign(out, await hashes());
  writeFileSync(path.join(runDir, "results.json"), JSON.stringify(out, null, 2));
  say(`results ${path.join(runDir, "results.json")}`);
  say(out.failures.length ? `measure-inuse: FAILED (${out.failures.length})` : "measure-inuse: passed");
  process.exitCode = out.failures.length ? 1 : 0;
}

await main();
