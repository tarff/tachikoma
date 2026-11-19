// Measurement 5, the lesson cut-off and count (8d plan, step 13). Not part of Tachikoma: run by hand, between two
// snapshots of the user's folders.
//
//   node scripts/8d/measure-lessons.mjs madeup    the made-up failures only, to check the script before it reads the
//                                                 user's error logs
//   node scripts/8d/measure-lessons.mjs run       the made-up failures, then the user's real ones
//
// There are no lessons yet, so failures stand in for them, as the plan says. Each failure's text is the tool's name, a
// space and the first line of its error, as /errors shows that line (src/core/errorlog.ts:60; Q18, the user's answer).
// Each source's texts go into a palace of its own in the build folder, in the room `lessons`; then each failure in
// turn is the query, cut to 250 characters (MemPalace's most, step 6 item 7, as step 25 will cut it), and the scores of
// every other entry are recorded. Identical texts are stored once: MemPalace answers `already_exists` for the rest
// (step 6 item 9), and the script keeps its own count to compare. Two failures are "the same" when the tool is the
// same and the first line is the same once quoted text, paths and numbers are blanked (`blank`, below). The two
// sources, kept apart in every figure:
// - MADE-UP failures, written for this measurement (the user's addition to step 13), in the shapes of Tachikoma's own
//   tool errors in src/tools/, src/exec/ and src/mcp/; never taken from the user's logs;
// - the user's REAL failures: every `tool` row of the error logs under %LOCALAPPDATA%\tachikoma\errors\, read only.
//   Nothing of their text (errors, inputs, paths, session ids) goes into any output, file or record: only counts and
//   scores. A failure while they are handled says its error's name alone.
// Both are stand-ins: real lessons will be sentences, not raw errors.
//
// Each palace is deleted by its exact name when its hub has stopped. MemPalace's own write log keeps no text: it
// redacts content and queries (mempalace/wal.py:28-29, :92-93), and the hub's log holds lengths and times only.
//
// Hubs are started and stopped exactly as step 8 proved (Q24, Q8, Q25): the functions from PYTHON down to `finish` are
// copied unchanged from scripts/8d/measure-search.mjs (its lines 38-691, which it copied from
// scripts/8d/measure-save.mjs and scripts/8d/measure-hub.mjs), except for the names of the run folder and palaces and
// the result line. Each hub is the build folder's `env\Scripts\python.exe -I -m mempalace.mcp_server --transport http
// --port <p> --palace <palace> --backend sqlite_exact`, with MEMPALACE_EMBEDDING_MODEL=minilm,
// MEMPALACE_MCP_WRITER_WAIT_SECONDS=0 and MEMPALACE_MCP_IDLE_HOURS=0, step 1's `install` environment (TEMP and TMP
// inside the build folder) and step 5's offline settings with a dead-end proxy; each is stopped by its serving
// process's id after its start time is read again, and at the end every process this script started is looked up
// again. Nothing is fetched.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync }
  from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { BUILD, throwaway } from "./throwaway.mjs";

const PYTHON = path.join(BUILD, "env", "Scripts", "python.exe");
const POWERSHELL = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0",
  "powershell.exe");
// This script's own cut-off, so that a run always ends, and its polling step while it waits for a hub: step 8's, not
// figures for Tachikoma.
const GIVE_UP_MS = 180_000;
const POLL_MS = 10;
// The six files chromadb needs in place (chromadb/utils/embedding_functions/onnx_mini_lm_l6_v2.py:285-292; step 5).
const MODEL_FILES = ["config.json", "model.onnx", "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json",
  "vocab.txt"];
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const PROCESS_EVENTS = new Set(["subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.spawn",
  "os.startfile"]);
const HUB_SETTINGS = {
  MEMPALACE_EMBEDDING_MODEL: "minilm",
  MEMPALACE_MCP_WRITER_WAIT_SECONDS: "0",
  MEMPALACE_MCP_IDLE_HOURS: "0",
};
// Dropped in every spelling, so only the values set here reach MemPalace (as scripts/8d/model-check.mjs).
const DROP =
  /^(HTTPS?_PROXY|ALL_PROXY|NO_PROXY|ANONYMIZED_TELEMETRY|CHROMA_.*|PYTHON.*|HF_HUB_OFFLINE|TRANSFORMERS_OFFLINE)$/i;

// This script's process helper. One JSON request per line on stdin, one answer per line on stdout. Times are
// microseconds since 1970 (start times from GetProcessTimes, to 0.1 us, cut to whole microseconds).
//   {"op": "list", "pids": [...], "ppids": [...]}: the processes with one of those ids or parent ids, each with its
//     start time and whether it still runs; t1 and t2 are the clock just before and just after the snapshot.
//   {"op": "stop", "target": [pid, start], "watch": [[pid, start], ...], "cutoffMs": n}: opens each watched process
//     and keeps the handle only if its start time is the one given; ends the target through its handle only if it
//     matched; then times, to the millisecond, when each kept process has ended.
const LISTER = String.raw`
import ctypes, json, sys, time
from ctypes import wintypes
k = ctypes.WinDLL('kernel32', use_last_error=True)
class PE(ctypes.Structure):
    _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD), ('th32ProcessID', wintypes.DWORD),
                ('th32DefaultHeapID', ctypes.c_size_t), ('th32ModuleID', wintypes.DWORD),
                ('cntThreads', wintypes.DWORD), ('th32ParentProcessID', wintypes.DWORD),
                ('pcPriClassBase', ctypes.c_long), ('dwFlags', wintypes.DWORD), ('szExeFile', ctypes.c_wchar * 260)]
FT = wintypes.FILETIME
k.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
k.CreateToolhelp32Snapshot.argtypes = (wintypes.DWORD, wintypes.DWORD)
k.Process32FirstW.argtypes = (wintypes.HANDLE, ctypes.POINTER(PE))
k.Process32NextW.argtypes = (wintypes.HANDLE, ctypes.POINTER(PE))
k.OpenProcess.restype = wintypes.HANDLE
k.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
k.GetProcessTimes.argtypes = (wintypes.HANDLE,) + (ctypes.POINTER(FT),) * 4
k.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
k.TerminateProcess.argtypes = (wintypes.HANDLE, wintypes.UINT)
k.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
k.WaitForSingleObject.restype = wintypes.DWORD
k.CloseHandle.argtypes = (wintypes.HANDLE,)
QUERY, SYNC, TERM = 0x1000, 0x00100000, 0x0001
EPOCH_US = 11644473600000000
INVALID = ctypes.c_void_p(-1).value
def now():
    return time.time_ns() // 1000
def started(h):
    c, e, kt, u = FT(), FT(), FT(), FT()
    if not k.GetProcessTimes(h, ctypes.byref(c), ctypes.byref(e), ctypes.byref(kt), ctypes.byref(u)):
        return None
    return ((c.dwHighDateTime << 32) | c.dwLowDateTime) // 10 - EPOCH_US
def running(h):
    code = wintypes.DWORD()
    return bool(k.GetExitCodeProcess(h, ctypes.byref(code))) and code.value == 259
def listing(pids, ppids):
    t1 = now()
    snap = k.CreateToolhelp32Snapshot(2, 0)
    if not snap or snap == INVALID:
        raise OSError(ctypes.get_last_error())
    rows = []
    e = PE()
    e.dwSize = ctypes.sizeof(PE)
    ok = k.Process32FirstW(snap, ctypes.byref(e))
    while ok:
        if e.th32ProcessID in pids or e.th32ParentProcessID in ppids:
            rows.append((e.th32ProcessID, e.th32ParentProcessID, e.szExeFile))
        ok = k.Process32NextW(snap, ctypes.byref(e))
    k.CloseHandle(snap)
    t2 = now()
    out = []
    for pid, ppid, name in rows:
        h = k.OpenProcess(QUERY, False, pid)
        if not h:
            err = ctypes.get_last_error()
            if err != 87:
                out.append({'pid': pid, 'ppid': ppid, 'name': name, 'start': None, 'running': None, 'error': err})
            continue
        st = started(h)
        alive = running(h)
        k.CloseHandle(h)
        if st is not None and st > t2:
            continue
        out.append({'pid': pid, 'ppid': ppid, 'name': name, 'start': st, 'running': alive})
    return {'t1': t1, 't2': t2, 'after': now(), 'rows': out}
def stop(target, watch, cutoff_ms):
    res = {'checked': {}, 'ends': {}}
    kept = []
    th = None
    for pid, want in watch:
        h = k.OpenProcess(QUERY | SYNC | (TERM if pid == target[0] else 0), False, pid)
        if not h:
            res['checked'][pid] = 'gone (error %d)' % ctypes.get_last_error()
            continue
        st = started(h)
        if st != want:
            k.CloseHandle(h)
            res['checked'][pid] = 'another process (start %s, not %s): not touched' % (st, want)
            continue
        if not running(h):
            k.CloseHandle(h)
            res['checked'][pid] = 'already ended'
            continue
        res['checked'][pid] = 'start time matches'
        kept.append((pid, h))
        if pid == target[0] and want == target[1]:
            th = h
    if th is None:
        for pid, h in kept:
            k.CloseHandle(h)
        res['stopped'] = False
        res['reservedUntil'] = now()
        return res
    res['at'] = now()
    t0 = time.perf_counter()
    res['stopped'] = bool(k.TerminateProcess(th, 1))
    left = dict(kept)
    while left and (time.perf_counter() - t0) * 1000 < cutoff_ms:
        for pid, h in list(left.items()):
            if k.WaitForSingleObject(h, 0) == 0:
                res['ends'][pid] = {'ms': round((time.perf_counter() - t0) * 1000, 2), 'at': now()}
                del left[pid]
        if left:
            time.sleep(0.001)
    res['left'] = list(left)
    res['reservedUntil'] = now()
    for pid, h in kept:
        k.CloseHandle(h)
    return res
for line in sys.stdin:
    req = json.loads(line)
    try:
        if req['op'] == 'list':
            r = listing(set(req['pids']), set(req['ppids']))
        else:
            r = stop(req['target'], req['watch'], req['cutoffMs'])
        r['ok'] = True
    except Exception as exc:
        r = {'ok': False, 'error': repr(exc)}
    sys.stdout.write(json.dumps(r) + '\n')
    sys.stdout.flush()
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const since = (t0) => Math.round((performance.now() - t0) * 10) / 10;
const nowUs = () => Date.now() * 1000;
const afterUs = () => (Date.now() + 1) * 1000;
const say = (...a) => console.log(...a);
const tail = (file, n = 4) =>
  existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-n) : [];
const iso = (us) => (us == null ? null : `${new Date(Math.floor(us / 1000)).toISOString().slice(0, 23)}${
  String(us % 1000).padStart(3, "0")}Z`);
const round1 = (x) => Math.round(x * 10) / 10;

// The fastest, the middle (the median; for an even count, the mean of the two middle values) and the slowest.
function stats(values) {
  const v = values.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const m = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  return { n: v.length, fastest: round1(v[0]), middle: round1(m), slowest: round1(v.at(-1)) };
}
const line = (name, s, unit = "ms") =>
  `${name}: ${s.n ? `fastest ${s.fastest} ${unit}, middle ${s.middle} ${unit}, slowest ${s.slowest} ${unit}` :
    "none"} (${s.n} runs)`;
// ---- the run's set-up ----

// Set by `init`, at the start of the run.
let installDir;
let base;
let home;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = { stamp, failures: [] };
const fail = (what) => {
  out.failures.push(what);
  say(`FAILED: ${what}`);
};
function init() {
  ({ dir: installDir, env: base } = throwaway("install"));
  home = base.USERPROFILE;
}

function preflight() {
  const model = path.join(home, ".cache", "chroma", "onnx_models", "all-MiniLM-L6-v2", "onnx");
  for (const f of MODEL_FILES) if (!existsSync(path.join(model, f))) throw new Error(`the model is not in place: ${f}`);
  if (existsSync(path.join(home, ".mempalace", "updates.json"))) throw new Error("updates.json is in the build home");
  if (!existsSync(PYTHON)) throw new Error(`no ${PYTHON}`);
}

// The dead-end proxy: records each connection's first line and refuses it.
const proxied = [];
let proxyServer;
async function startProxy() {
  proxyServer = createServer((sock) => {
    const entry = { from: `${sock.remoteAddress}:${sock.remotePort}`, first: "" };
    proxied.push(entry);
    sock.once("data", (d) => (entry.first = d.toString("latin1").split("\r\n")[0]));
    sock.on("error", () => {});
    sock.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
  const proxy = `http://127.0.0.1:${proxyServer.address().port}`;
  const env = Object.fromEntries(Object.entries(base).filter(([k]) => !DROP.test(k)));
  Object.assign(env, { HF_HUB_OFFLINE: "1", HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy,
    NO_PROXY: "127.0.0.1,localhost,::1" });
  return env;
}

async function freePort() {
  const s = createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  if (port === 8765) return freePort();
  return port;
}

// ---- processes ----

// Every process this script started or found below one, each kept by id and start time together. `low` is the
// earliest it can have started (its start time once known); `until` is the latest time its id is known to have been
// its own (seen running, or held by a handle of this script's or the helper's); `goneBy` a time by which it had ended.
const procs = [];
const roots = new Set();
const unsettled = new Map();
const apart = new Map();
const stops = [];
let lister;

function recordDirect(label, pid, before, name, child) {
  const r = { pid, ppid: process.pid, label, name, start: null, low: before, until: null, goneBy: null, direct: true,
    open: Boolean(child) };
  procs.push(r);
  if (child) {
    child.once("exit", () => {
      r.open = false;
      r.until = r.goneBy = afterUs();
    });
  } else r.until = r.goneBy = afterUs();
  return r;
}
const low = (r) => r.start ?? r.low;
const heldUntil = (r) => (r.direct && r.open ? Infinity : (r.until ?? -Infinity));
const recordOf = (row) => procs.find((r) => r.pid === row.pid && (r.start != null ? r.start === row.start :
  row.start != null && r.low <= row.start && row.start <= heldUntil(r)));

// Whose a process under a recorded id is: "mine", "not mine" or "unsettled"; "unrelated" when no recorded process has
// its parent's id.
function classify(row) {
  const related = procs.filter((r) => r.pid === row.ppid);
  if (!related.length) return { kind: "unrelated" };
  if (row.start == null) return { kind: "unsettled" };
  const parent = related.find((r) => low(r) <= row.start && row.start <= heldUntil(r));
  if (parent) return { kind: "mine", parent };
  if (related.every((r) => row.start < low(r) || (r.goneBy != null && row.start > r.goneBy))) {
    return { kind: "not mine" };
  }
  return { kind: "unsettled" };
}

// The helper is the build Python's pythonw.exe, which has no console, so Windows starts no console host for it: the
// helper's own end is then the only one it cannot see, and this script sees that one (its own child's exit).
function startLister(env) {
  const cfg = readFileSync(path.join(BUILD, "env", "pyvenv.cfg"), "utf8");
  const exe = path.join(cfg.match(/^home\s*=\s*(.+)$/m)[1].trim(), "pythonw.exe");
  const before = nowUs();
  const child = spawn(exe, ["-I", "-c", LISTER], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  recordDirect("lister", child.pid, before, "pythonw.exe (helper)", child);
  const waiting = [];
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  createInterface({ input: child.stdout }).on("line", (l) => waiting.shift()?.resolve(JSON.parse(l)));
  child.on("exit", (code) => {
    for (const w of waiting.splice(0)) w.reject(new Error(`the helper ended (${code}): ${err.slice(-300)}`));
  });
  lister = {
    child,
    ask: (req) => new Promise((resolve, reject) => {
      if (child.exitCode != null) return reject(new Error(`the helper has ended: ${err.slice(-300)}`));
      waiting.push({ resolve, reject });
      child.stdin.write(`${JSON.stringify(req)}\n`);
    }),
    close: () => new Promise((resolve) => {
      if (child.exitCode != null) return resolve();
      child.once("exit", resolve);
      child.stdin.end();
    }),
  };
}

// Looks up the recorded processes (all, or those not known to have ended) and everything under them, records new
// processes of this script's, and keeps the ones it cannot settle.
async function look({ all = false } = {}) {
  let rows = [];
  for (let round = 0; round < 50; round++) {
    const set = procs.filter((r) => all || r.goneBy == null);
    const ids = set.map((r) => r.pid);
    const res = await lister.ask({ op: "list", pids: [...new Set([...ids, ...roots])], ppids: [...new Set(ids)] });
    if (!res.ok) throw new Error(`the helper: ${res.error}`);
    rows = res.rows;
    // The snapshot is one instant, after t1 and after the start of every process in it: a process in it that runs
    // held its id at least until then.
    const at = Math.max(res.t1, ...res.rows.map((r) => r.start ?? -Infinity));
    for (const row of res.rows) {
      const rec = recordOf(row);
      if (rec && row.running) rec.until = Math.max(rec.until ?? -Infinity, at);
    }
    let added = false;
    const found = new Set();
    for (const row of res.rows) {
      let rec = recordOf(row);
      if (!rec) {
        const c = classify(row);
        const key = `${row.pid}@${row.start}`;
        if (c.kind === "mine") {
          rec = { pid: row.pid, ppid: row.ppid, label: c.parent.label, name: row.name, start: row.start, low: row.start,
            until: null, goneBy: null, direct: false };
          procs.push(rec);
          roots.delete(row.pid);
          added = true;
        } else if (c.kind === "unsettled") unsettled.set(key, row);
        else if (c.kind === "not mine") apart.set(key, { ...row, start: iso(row.start) });
      }
      if (!rec) continue;
      if (rec.start == null) rec.start = row.start;
      found.add(rec);
      if (row.running) rec.until = Math.max(rec.until ?? -Infinity, at);
      else rec.goneBy = Math.min(rec.goneBy ?? Infinity, res.after);
    }
    for (const r of set) if (!found.has(r)) r.goneBy = Math.min(r.goneBy ?? Infinity, res.after);
    if (!added) break;
  }
  return rows;
}

const show = (r) => ({ pid: r.pid, ppid: r.ppid, name: r.name, label: r.label, start: iso(r.start),
  running: r.goneBy == null });

// Stops `target` through the helper, after its start time is read again from the handle; times every watched process.
async function stopRec(target, watchRecs, why) {
  const watch = watchRecs.filter((r) => r.start != null && r.goneBy == null).map((r) => [r.pid, r.start]);
  if (!watch.some(([p]) => p === target.pid)) watch.push([target.pid, target.start]);
  const res = await lister.ask({ op: "stop", target: [target.pid, target.start], watch, cutoffMs: GIVE_UP_MS });
  if (!res.ok) throw new Error(`the helper: ${res.error}`);
  const ends = {};
  for (const [pid, start] of watch) {
    const rec = procs.find((r) => r.pid === pid && r.start === start);
    const e = res.ends[pid];
    const checked = res.checked[pid] ?? "";
    if (/^start time matches/.test(checked)) rec.until = Math.max(rec.until ?? -Infinity, res.reservedUntil);
    else rec.goneBy = Math.min(rec.goneBy ?? Infinity, res.reservedUntil);
    if (e) {
      rec.goneBy = Math.min(rec.goneBy ?? Infinity, e.at + 1);
      ends[`${pid} ${rec.name}`] = e.ms;
    }
  }
  const entry = { pid: target.pid, name: target.name, label: target.label, why, checked: res.checked[target.pid],
    stopped: res.stopped, ends, left: res.left ?? [] };
  stops.push(entry);
  return { ...entry, goneMs: Object.values(ends).length ? Math.max(...Object.values(ends)) : null,
    allEnded: res.stopped && (res.left ?? []).length === 0 };
}

// Stops what is left of this script's processes, the newest first, after reading each start time again.
async function cleanup() {
  if (!lister || lister.child.exitCode != null) {
    for (const r of procs) if (r.direct && r.open && r.child) r.child.kill();
    return;
  }
  try {
    await look();
    const left = procs.filter((r) => r.goneBy == null && r.label !== "lister" && r.start != null)
      .sort((a, b) => b.start - a.start);
    for (const r of left) if (r.goneBy == null) await stopRec(r, [r], "end of run: still running");
  } catch (e) {
    fail(`clean-up: ${e.message}`);
  }
}

// At the end: every recorded process and every process under one, looked up again; then the helper itself is ended
// and its end seen by this script (it is this script's own child and starts nothing).
async function finalCheck() {
  await look({ all: true });
  const still = procs.filter((r) => r.goneBy == null && r.label !== "lister");
  await lister.close();
  const helperLeft = procs.filter((r) => r.label === "lister" && r.goneBy == null);
  // A process a look could not settle is judged again with all that is known now: recorded since as this script's,
  // or shown to be another program's, or still unsettled (the run fails).
  const settledLater = [];
  for (const [key, row] of [...unsettled]) {
    const c = recordOf(row) ? { kind: "mine" } : classify(row);
    if (c.kind === "unsettled") continue;
    unsettled.delete(key);
    settledLater.push({ ...row, start: iso(row.start), now: c.kind });
    if (c.kind === "not mine") apart.set(key, { ...row, start: iso(row.start) });
  }
  const result = {
    recorded: procs.length,
    listed: procs.map(show),
    stillRunning: [...still, ...helperLeft].map(show),
    unsettled: [...unsettled.values()].map((row) => ({ ...row, start: iso(row.start) })),
    settledLater,
    notMineUnderReusedIds: [...apart.values()],
  };
  if (result.stillRunning.length) {
    fail(`processes of this script's still running: ${result.stillRunning.map((r) => `${r.pid} ${r.name}`)}`);
  }
  if (unsettled.size) fail(`processes the start times cannot settle: ${[...unsettled.keys()]}`);
  return result;
}
let processEnv;

// ---- hubs ----

const hubArgs = (port, palace) => ["-I", "-m", "mempalace.mcp_server", "--transport", "http", "--port", String(port),
  "--palace", palace, "--backend", "sqlite_exact"];
let hubEnv;
let runDir;
const palaceDir = (x) => path.join(home, "palaces", `measure-lessons-${stamp}-${x}`);
const logs = (label) => ({ stdout: path.join(runDir, `${label}.stdout.log`), stderr: path.join(runDir,
  `${label}.stderr.log`), audit: path.join(runDir, `${label}.audit.jsonl`) });

function startHub(label, { python = PYTHON, palace, port }) {
  const f = logs(label);
  const o = openSync(f.stdout, "w");
  const e = openSync(f.stderr, "w");
  const args = hubArgs(port, palace);
  const before = nowUs();
  const t0 = performance.now();
  // Detached and hidden as a window starts it; not unref'd, so this script sees its end.
  const child = spawn(python, args, { cwd: home, env: hubEnv, detached: true, windowsHide: true,
    stdio: ["ignore", o, e] });
  closeSync(o);
  closeSync(e);
  const rec = recordDirect(label, child.pid, before, path.basename(python), child);
  rec.child = child;
  const h = { label, port, palace, python, rec, t0, exit: null, ...f };
  h.exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve((h.exit = { code, signal, ms: since(t0) })));
    child.on("error", (err) => resolve((h.exit = { code: null, error: err.message, ms: since(t0) })));
  });
  return h;
}

async function healthy(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(GIVE_UP_MS) });
    await r.text();
    return r.status === 200;
  } catch {
    return false;
  }
}

// Polls until the hub answers /healthz, the start ends, or the cut-off passes. `looking` also looks up the processes
// at each turn, so short-lived ones are seen.
async function waitHealthy(h, { looking = false } = {}) {
  for (;;) {
    if (await healthy(h.port)) return { ok: true, ms: since(h.t0) };
    if (h.exit) return { ok: false, exit: h.exit, ms: since(h.t0) };
    if (performance.now() - h.t0 > GIVE_UP_MS) return { ok: false, cutOff: true, ms: since(h.t0) };
    if (looking) await look();
    await sleep(POLL_MS);
  }
}

// MemPalace's own record of a hub: found by listing server/*/serverinfo.json and matching palace_path without regard
// to letter case (Q7). This script never works out the folder's name.
function serverinfos(palace) {
  const root = path.join(home, ".mempalace", "server");
  if (!existsSync(root)) return [];
  const want = path.resolve(palace).toLowerCase();
  return readdirSync(root).flatMap((key) => {
    const file = path.join(root, key, "serverinfo.json");
    if (!existsSync(file)) return [];
    const info = JSON.parse(readFileSync(file, "utf8"));
    return String(info.palace_path ?? "").toLowerCase() === want ? [{ key, file, info }] : [];
  });
}

async function statusz(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/statusz`, { signal: AbortSignal.timeout(GIVE_UP_MS) });
    const j = JSON.parse(await r.text());
    return { backend: j.palace?.backend, version: j.server?.version };
  } catch (e) {
    return { error: e.message };
  }
}

function palaceModel(palace) {
  const file = path.join(palace, "sqlite_exact.sqlite3");
  if (!existsSync(file)) return "no palace file";
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT value FROM meta WHERE key = 'embedder_model:mempalace_drawers'").get()?.value ??
      "none recorded (no entry written yet)";
  } finally {
    db.close();
  }
}

// The serving process of a hub that answers: its MemPalace record naming this hub's port, and that process among this
// script's own. MemPalace writes the record after the bind (mempalace/mcp_server/http.py:1594-1617), so a health
// answer can come first, and a stopped hub's record stays behind: this waits for the record naming this port.
async function serving(h) {
  const t0 = performance.now();
  for (;;) {
    await look();
    const infos = serverinfos(h.palace);
    const info = infos[0]?.info;
    const rec = info?.port === h.port &&
      procs.find((r) => r.label === h.label && r.pid === info.pid && r.goneBy == null);
    if (rec || performance.now() - t0 > GIVE_UP_MS) return { infos, info, rec, ms: since(t0) };
    await sleep(POLL_MS);
  }
}

// Stops a hub by its serving process's id, after the helper reads that process's start time again; times how long
// every process of the hub takes to end, then looks them all up again.
async function stopHub(h, why) {
  const { infos, info, rec, ms } = await serving(h);
  if (!rec) {
    fail(`${h.label}: no serving process of this script's for it (records: ${infos.length})`);
    return { ok: false };
  }
  const tree = procs.filter((r) => r.label === h.label && r.goneBy == null);
  const listBefore = tree.map(show);
  const s = await stopRec(rec, tree, why);
  await look();
  const listAfter = procs.filter((r) => r.label === h.label).map(show);
  const left = procs.filter((r) => r.label === h.label && r.goneBy == null);
  if (h.rec.child) await h.exited;
  if (!s.allEnded || left.length) fail(`${h.label}: not wholly gone after the stop`);
  return { ok: s.allEnded && !left.length, servingPid: info.pid, port: info.port, serverinfoMs: ms, goneMs: s.goneMs,
    ends: s.ends, checked: s.checked, listBefore, listAfter, answersAfter: await healthy(h.port) };
}

async function mcpClient(port) {
  const errors = [];
  const client = new Client({ name: "tachi-8d-measure-hub", version: "0" });
  client.onerror = (err) => errors.push(String(err?.message ?? err));
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content ?? []).map((c) => c.text ?? "").join("\n");
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return { isError: Boolean(r.isError), json, text: json ? undefined : text.slice(0, 300) };
  };
  return { client, call, errors };
}

function connectionWatch() {
  const audits = readdirSync(runDir).filter((f) => f.endsWith(".audit.jsonl"));
  const w = { listener: proxied, logs: {} };
  for (const f of audits) {
    const records = readFileSync(path.join(runDir, f), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    const server = records.filter((r) => r.phase === "server");
    w.logs[f] = {
      control: records.filter((r) => r.phase === "control" && r.event).length,
      proxies: Boolean(records.find((r) => r.httpx_proxies)),
      server: server.length,
      outside: server.filter((r) => r.host !== null && !LOOPBACK.has(r.host)).map((r) => `${r.event} ${r.host}`),
      children: server.filter((r) => PROCESS_EVENTS.has(r.event)).map((r) => r.args.slice(0, 120)),
    };
  }
  w.ok = proxied.length === 0 && Object.values(w.logs).every((l) => l.outside.length === 0 && l.control > 0 &&
    l.proxies && l.children.length === 0);
  if (!w.ok) fail("the connection watch");
  return w;
}

// This PC, read only: the processor, the disks, the memory, Windows, and whether Defender scans files as they are
// opened (it bears on a first start's new files).
function pcDescription() {
  const script = "$p = Get-CimInstance Win32_Processor | Select-Object -First 1; " +
    "$d = @(Get-PhysicalDisk | ForEach-Object { \"$($_.FriendlyName) $($_.MediaType) $($_.BusType)\" }); " +
    "$m = (Get-MpComputerStatus).RealTimeProtectionEnabled; " +
    "ConvertTo-Json -Compress @{ cpu = $p.Name; cores = $p.NumberOfCores; threads = $p.NumberOfLogicalProcessors; " +
    "disks = $d; defenderRealTime = $m }";
  // With the build's environment (TEMP and TMP inside the build folder), and recorded as this script's.
  const before = nowUs();
  const ps = spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], { env: processEnv, encoding: "utf8", windowsHide: true });
  if (ps.pid) recordDirect("pc description", ps.pid, before, "powershell.exe");
  let hw = {};
  try {
    hw = JSON.parse(ps.stdout);
  } catch {
    hw = { error: ps.stderr.slice(0, 200) };
  }
  return { ...hw, memoryGB: round1(os.totalmem() / 1e9), windows: `${os.version()} ${os.release()}`,
    node: process.version };
}

async function setUp(kind) {
  preflight();
  runDir = path.join(installDir, `measure-lessons-${kind}-${stamp}`);
  mkdirSync(runDir);
  mkdirSync(path.join(home, "palaces"), { recursive: true });
  processEnv = await startProxy();
  hubEnv = { ...processEnv, ...HUB_SETTINGS };
  startLister(processEnv);
  // The helper's own check, before any hub starts: it must list itself, and list and stop a child of this script's.
  const before = nowUs();
  // With the build's environment (TEMP and TMP inside the build folder), as every other child (step 10's review).
  const dummy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: processEnv, stdio: "ignore",
    windowsHide: true });
  const dummyRec = recordDirect("self-test", dummy.pid, before, "node.exe (self-test)", dummy);
  dummyRec.child = dummy;
  await look();
  const self = procs.find((r) => r.label === "lister");
  if (self.start == null || dummyRec.start == null) throw new Error("the helper did not list its own processes");
  const s = await stopRec(dummyRec, [dummyRec], "the helper's self-test");
  await new Promise((resolve) => (dummy.exitCode != null || dummy.signalCode ? resolve() :
    dummy.once("exit", resolve)));
  if (!s.allEnded) throw new Error(`the helper's self-test stop: ${JSON.stringify(s)}`);
  say(`helper self-test: listed itself and a child, stopped the child after its start time (${s.goneMs} ms)`);
  for (const k of Object.keys(hubEnv).sort()) {
    if (/^(USERPROFILE|HOME|HF_|MEMPALACE_|.*PROXY|UV_)/i.test(k)) say(`env ${k}=${hubEnv[k]}`);
  }
  say(`run folder ${runDir}`);
  out.pc = pcDescription();
  say(`this PC: ${JSON.stringify(out.pc)}`);
}

async function finish() {
  if (!lister) throw new Error(`the run did not set up: ${out.failures.join("; ")}`);
  await cleanup();
  out.processes = await finalCheck();
  await new Promise((resolve) => proxyServer.close(resolve));
  out.watch = connectionWatch();
  out.stops = stops;
  writeFileSync(path.join(runDir, "results.json"), `${JSON.stringify(out, null, 2)}\n`);
  say(`results ${path.join(runDir, "results.json")}`);
  say(`processes recorded: ${out.processes.recorded}; still running: ${out.processes.stillRunning.length}; ` +
    `unsettled: ${out.processes.unsettled.length}; another program's under a reused id (left alone): ` +
    `${out.processes.notMineUnderReusedIds.length}`);
  say(`connection watch: ${out.watch.ok ? "the dead-end proxy got nothing; hooked hubs reached no outside address" :
    "FAILED"} (${Object.keys(out.watch.logs).length} hooked hubs)`);
  say(out.failures.length ? `measure-lessons: FAILED (${out.failures.length})` : "measure-lessons: passed");
  process.exitCode = out.failures.length ? 1 : 0;
}

// ---- the lessons ----

const COMMAND = process.argv[2];
const WING = "tachikoma";
// The design's room for lessons (section 3); the lesson search is one search of that room (step 25).
const ROOM = "lessons";
// MemPalace's longest query: mempalace_search refuses one of 251 characters (step 6 item 7); step 25 cuts to it.
const QUERY_MAX = 250;
// MemPalace's most results for one search (_MAX_RESULTS, mempalace/mcp_server/_session.py:681): with no more entries
// than this in a palace, every search returns every entry, so every other entry's score is recorded.
const LIMIT = 100;
const ERRORS = path.join(process.env.LOCALAPPDATA ?? "", "tachikoma", "errors");
// A subagent's failure reaches the lead's log with its task id in front (src/core/tasks.ts:371).
const SUBAGENT = /^t\d+: /;

// A failure's text: the tool's name, a space and the error's first line.
const textOf = (f) => `${f.tool} ${f.line}`;

// The plan's rule for "the same" failure: the same tool, and the same first line once quoted text, paths and numbers
// are blanked, in that order. Quoted: a span in '', "" or `` that begins and ends at a word's edge, so an apostrophe
// inside a word ("Tachikoma's") opens none. Paths: a URL; a run holding a slash or a backslash, with or without a
// drive letter (C:\work\a.ts, src/a.ts, \\server\share, /work/a.js); a file name with an extension (package.json).
// Numbers: each run of digits.
const QUOTED = /(?<!\w)(['"`])(?:(?!\1).)*\1(?!\w)/g;
const PATHS = /\b[a-z][\w+.-]*:\/\/\S*|(?:\b[A-Za-z]:)?[\w.~$-]*[\\/][^\s,;()]*|\b[\w-]+(?:\.[\w-]+)*\.[A-Za-z]\w*\b/g;
const blank = (line) => line.replace(QUOTED, "<q>").replace(PATHS, "<p>").replace(/\d+/g, "<n>");
const same = (a, b) => a.tool === b.tool && blank(a.line) === blank(b.line);

// ---- MADE-UP failures: written for this measurement, never taken from the user's logs ----
//
// Each is a tool's name and the first line of an error in the shape Tachikoma's own code gives it (the source line is
// beside each); every path, number, server and pattern in them is made up. The members of a family (F) differ only in
// what the rule blanks, so any two of them are "the same". A single (S) has no member like it: its nearest neighbours
// differ in words or in the tool, the hard cases for a cut-off. How many: MemPalace returns at most 100 results for
// one search (LIMIT), so the set is held to 100 entries or fewer, so that every search scores every other entry. The
// shapes used are 16 with a part the rule blanks and 13 without; (100 - 13) / 16 = 5.4, so each family has 5 members:
// 16 x 5 + 13 = 93 entries. One single is given twice, the fewest that checks MemPalace's `already_exists` answer
// against the script's own count: 94 failures. The per-failure counts of "same" matches are therefore set by this
// design (4 in a family, 0 for a single); what this set measures is how the scores of same and different pairs lie.
const ABS = ["C:\\work\\shop\\src\\cart.ts", "C:\\work\\blog\\posts\\2026\\intro.md", "/work/src/server/index.js",
  "D:\\repos\\api\\config\\routes.yaml", "C:\\Users\\dev\\notes\\todo.txt"];
const ABS2 = ["C:\\work\\shop\\src\\checkout.tsx", "/work/lib/db/pool.go", "C:\\work\\blog\\layouts\\base.html",
  "D:\\repos\\api\\tests\\auth_test.py", "C:\\Users\\dev\\scripts\\deploy.ps1"];
const REL = ["src/cart.ts", "posts/2026/intro.md", "lib/util/strings.js", "docs/guide/setup.md", "app/models/user.rb"];
const DIRS = ["C:\\work\\shop\\src\\widgets", "/work/tests/e2e", "D:\\repos\\api\\handlers", "C:\\work\\blog\\drafts",
  "C:\\Users\\dev\\scratch\\old"];
const DATA = ["C:\\Users\\dev\\AppData\\Local\\tachikoma\\sessions\\a1\\run.jsonl",
  "C:\\Users\\dev\\AppData\\Local\\tachikoma\\errors\\a1.jsonl",
  "C:\\Users\\ana\\AppData\\Local\\tachikoma\\prompts.jsonl", "/home/dev/.local/share/tachikoma/sessions/b2/c3.jsonl",
  "C:\\Users\\dev\\AppData\\Local\\tachikoma\\memory\\hub.json"];
const ENVS = ["C:\\work\\shop\\.env", "C:\\work\\blog\\.env.local", "/work/.env",
  "D:\\repos\\api\\.env.production", "C:\\work\\site\\.env"];
const NET = ["\\\\fileserver\\share\\plans.docx", "\\\\nas\\projects\\app\\main.c",
  "\\\\backup01\\home\\dev\\notes.txt", "\\\\10.0.0.5\\drop\\build.zip", "\\\\printhost\\queue\\job.pdf"];
const WRITES = ["C:\\work\\shop\\dist\\bundle.js", "C:\\work\\blog\\public\\feed.xml", "/work/out/report.html",
  "D:\\repos\\api\\logs\\server.log", "C:\\Users\\dev\\Desktop\\summary.md"];
const SETTINGS = ["C:\\Users\\dev\\.tachikoma\\settings.json", "C:\\Users\\dev\\.tachikoma\\keybindings.json",
  "C:\\Users\\ana\\.tachikoma\\settings.json", "/home/dev/.tachikoma/settings.json",
  "C:\\Users\\sam\\.tachikoma\\keybindings.json"];
const BINARY = ["assets/logo.png", "data/export.xlsx", "bin/tool.exe", "docs/old.doc", "fonts/sans.woff"];
const FLAGS = (p) => `${p} is not a regular expression: Invalid regular expression: /${p}/: Invalid group. ` +
  "JavaScript has no flags inside a pattern, such as (?i); search_files matches case exactly, so give both cases " +
  "where it matters, as in [Mm]ax";
// \u2716 is the mark zod puts before each problem (z.prettifyError, as src/tools/tool.ts:47 uses it).
const FAMILIES = [
  ["shell", "src/tools/shell.ts:5, src/tools/commands.ts:87", [1, 2, 127, 128, 255].map((n) => `exit code: ${n}`)],
  ["shell", "src/tools/commands.ts:72-75", [120, 30, 600, 5, 45].map((s) => "Stopped: the command did not " +
    `complete within its ${s}s timeout. A command that starts with sleep is stopped at its timeout, not moved to ` +
    "the background.")],
  ["read_file", "src/exec/local.ts:163 (Node's readFile)",
    ABS.map((p) => `ENOENT: no such file or directory, open '${p}'`)],
  ["read_file", "src/tools/files.ts:253",
    DATA.map((p) => `${p} is in Tachikoma's data folder, which the file tools never touch`)],
  ["read_file", "src/tools/files.ts:260",
    ENVS.map((p) => `${p} is a program's environment, which can hold API keys, so the file tools never read it`)],
  ["read_file", "src/tools/files.ts:237", NET.map((p) => `${p} is a network or device path not written as a path in ` +
    "the project, so the file tools do not open it; a shell command can reach it, after asking")],
  ["edit_file", "src/tools/files.ts:373", REL.map((p) => `old_text was not found in ${p}`)],
  ["edit_file", "src/tools/files.ts:373",
    REL.map((p) => `old_text was not found in ${p} (the file uses CRLF line endings in places)`)],
  ["edit_file", "src/tools/files.ts:374", [2, 3, 5, 12, 4].map((n, i) =>
    `old_text appears ${n} times in ${REL[i]}; include more surrounding text so it is unique`)],
  ["edit_file", "src/tools/files.ts:366", BINARY.map((p) => `${p} is not UTF-8 text, so edit_file would damage it`)],
  ["edit_file", "src/exec/local.ts:163 (Node's readFile)",
    ABS2.map((p) => `ENOENT: no such file or directory, open '${p}'`)],
  ["write_file", "src/exec/local.ts:169 (Node's writeFile)",
    WRITES.map((p) => `EPERM: operation not permitted, open '${p}'`)],
  ["write_file", "src/exec/local.ts:169 (Node's writeFile)",
    WRITES.map((p) => `EBUSY: resource busy or locked, open '${p}'`)],
  ["write_file", "src/tools/files.ts:258", SETTINGS.map((p) => `${p} is one of Tachikoma's settings files, which the ` +
    "file tools never touch; edit it with /settings or /keybindings")],
  ["find_files", "src/tools/search.ts:81 (Node's realpath)",
    DIRS.map((p) => `ENOENT: no such file or directory, realpath '${p}'`)],
  ["mcp__docs__search", "src/mcp/server.ts:1003, :367",
    [500, 502, 503, 504, 429].map((n) => `https://docs.example.com/mcp answered ${n}`)],
];
const SINGLES = [
  ["shell", "src/tools/shell.ts:5", "killed by SIGTERM"],
  ["shell", "src/tools/shell.ts:5", "killed by SIGKILL"],
  ["read_file", "src/exec/local.ts:163 (Node's readFile)", "EISDIR: illegal operation on a directory, read"],
  ["read_file", "src/tools/tool.ts:47",
    "Invalid input for read_file: \u2716 Invalid input: expected string, received undefined"],
  ["read_file", "src/tools/tool.ts:47", "Invalid input for read_file: \u2716 Too small: expected number to be >=1"],
  ["search_files", "src/tools/search.ts:243", FLAGS("(?i)error")],
  ["search_files", "src/tools/search.ts:243", FLAGS("(?i)warning")],
  ["mcp__github__create_issue", "src/mcp/tools.ts:30",
    "The MCP server github has stopped; the user can reconnect it from /mcp."],
  ["mcp__docs__search", "src/mcp/tools.ts:30", "The MCP server docs has stopped; the user can reconnect it from /mcp."],
  ["mcp__github__create_issue", "src/mcp/tools.ts:31", "Stopped: the MCP server github restarted while the call ran."],
  ["mcp__github__create_issue", "src/mcp/tools.ts:27-29", "Not run: github's tool \"create_issue\" changed while " +
    "this call waited; look at its definition in this request's tools, if it is still there, and call it again."],
  ["mcp__github__create_issue", "src/mcp/server.ts:93",
    "The MCP server github needs sign-in, which the user does from /mcp."],
  ["mcp__github__create_issue", "src/mcp/tools.ts:36",
    "its new connection failed, so the call was not sent: connect ECONNREFUSED 127.0.0.1:3000"],
];
// The single given twice (EISDIR).
const REPEAT = 2;
const MADE_UP = [
  ...FAMILIES.flatMap(([tool, from, lines], k) => lines.map((line) => ({ group: `F${k + 1}`, tool, from, line }))),
  ...SINGLES.map(([tool, from, line], k) => ({ group: `S${k + 1}`, tool, from, line })),
];
MADE_UP.push({ ...MADE_UP[FAMILIES.length * 5 + REPEAT] });

// The made-up set against the rule, before any hub starts: two failures are "the same" by the rule exactly when they
// are in one group; the set's sizes are as stated above.
function checkMadeUp() {
  const bad = [];
  for (let i = 0; i < MADE_UP.length; i++) {
    for (let j = i + 1; j < MADE_UP.length; j++) {
      const a = MADE_UP[i];
      const b = MADE_UP[j];
      if (same(a, b) !== (a.group === b.group)) bad.push(`${a.group}~${b.group}`);
    }
  }
  const texts = new Set(MADE_UP.map(textOf)).size;
  const r = { failures: MADE_UP.length, texts, families: FAMILIES.length, singles: SINGLES.length, bad };
  if (bad.length || texts !== 93 || MADE_UP.length !== 94 || texts > LIMIT) {
    throw new Error(`the made-up set does not match the rule or its sizes: ${JSON.stringify(r)}`);
  }
  say(`made-up set: ${MADE_UP.length} failures, ${texts} distinct texts (${FAMILIES.length} families of 5, ` +
    `${SINGLES.length} singles, one given twice); every pair is "the same" by the rule exactly when in one group`);
  return r;
}

// ---- the user's REAL failures, read only. Only counts and scores leave here, by the callers' rule. ----

// Every `tool` row of every error log, read as src/core/errorlog.ts reads a row (`parse`: kind, attempted and message
// are strings); the tool's name is `attempted`'s first word, after a subagent's task id.
function readReal() {
  const c = { files: 0, lines: 0, unreadable: 0, otherKinds: 0, toolRows: 0, subagentRows: 0, noToolName: 0 };
  const failures = [];
  let names = [];
  try {
    names = readdirSync(ERRORS, { withFileTypes: true });
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  for (const e of names) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    c.files++;
    for (const l of readFileSync(path.join(ERRORS, e.name), "utf8").split("\n")) {
      if (!l.trim()) continue;
      c.lines++;
      let row;
      try {
        row = JSON.parse(l);
      } catch {}
      if (typeof row?.kind !== "string" || typeof row.attempted !== "string" || typeof row.message !== "string") {
        c.unreadable++;
        continue;
      }
      if (row.kind !== "tool") {
        c.otherKinds++;
        continue;
      }
      c.toolRows++;
      if (SUBAGENT.test(row.attempted)) c.subagentRows++;
      const rest = row.attempted.replace(SUBAGENT, "");
      const tool = rest.includes(" ") ? rest.slice(0, rest.indexOf(" ")) : rest;
      if (!tool) {
        c.noToolName++;
        continue;
      }
      failures.push({ tool, line: row.message.split("\n")[0] });
    }
  }
  return { counts: c, failures };
}

// ---- one source's palace: add, search, read back, stop ----

const palaces = [];
async function measure(source, failures) {
  const r = { failures: failures.length };
  const palace = palaceDir(source);
  if (existsSync(palace)) throw new Error(`the palace folder for ${source} is there already`);
  palaces.push(palace);
  const h = startHub(source, { palace, port: await freePort() });
  const up = await waitHealthy(h);
  if (!up.ok) throw new Error(`${source}: the hub did not answer`);
  r.startMs = up.ms;
  const { client, call, errors } = await mcpClient(h.port);
  // Each failure added in turn; each distinct text becomes one entry, known by its drawer's id and labelled by the
  // first failure that has it. `own[i]`: the entry failure i's text is.
  const byDrawer = new Map();
  const labels = [];
  const own = [];
  const add = { added: 0, alreadyExists: 0, failed: 0, pieces: {} };
  for (const [i, f] of failures.entries()) {
    const label = `measure-lessons ${source} ${i}`;
    const a = await call("mempalace_add_drawer", { wing: WING, room: ROOM, source_file: label, content: textOf(f) });
    const id = a.json?.drawer_id;
    if (a.json?.success === true && a.json.reason === "already_exists" && byDrawer.has(id)) {
      add.alreadyExists++;
      own.push(byDrawer.get(id));
    } else if (a.json?.success === true && !a.json.reason && typeof id === "string" && !byDrawer.has(id)) {
      add.added++;
      add.pieces[a.json.chunks] = (add.pieces[a.json.chunks] ?? 0) + 1;
      byDrawer.set(id, labels.length);
      own.push(labels.length);
      labels.push(label);
    } else {
      add.failed++;
      own.push(null);
    }
  }
  r.add = add;
  r.entries = labels.length;
  r.distinctTexts = new Set(failures.map(textOf)).size;
  r.ownRepeats = failures.length - r.distinctTexts;
  if (add.failed) fail(`${source}: ${add.failed} adds not answered as an add or as already_exists`);
  if (add.alreadyExists !== r.ownRepeats) {
    fail(`${source}: already_exists ${add.alreadyExists}, own count ${r.ownRepeats}`);
  }
  if (labels.length > LIMIT) fail(`${source}: ${labels.length} entries, more than one search returns`);
  // Each failure in turn as the query, cut to QUERY_MAX. `scores[i][e]`: entry e's distance in failure i's search (the
  // closest of its pieces), or null when the search did not return it.
  const q = { cut: 0, sanitized: 0, changedBySanitizer: 0, failed: 0, notReturned: 0, otherRoom: 0, unknownHits: 0,
    boosted: 0, pieces: {} };
  const scores = [];
  for (const f of failures) {
    const text = textOf(f);
    const query = text.slice(0, QUERY_MAX);
    if (query.length < text.length) q.cut++;
    const s = await call("mempalace_search", { query, wing: WING, room: ROOM, limit: LIMIT });
    const hits = s.json?.results;
    if (s.isError || s.json?.error || !Array.isArray(hits)) {
      q.failed++;
      scores.push(labels.map(() => null));
      continue;
    }
    // MemPalace rewrites a query of over 200 characters it takes for a pasted prompt
    // (mempalace/query_sanitizer.py:77-189); compared here, never kept.
    if (s.json.query_sanitized) q.sanitized++;
    if (s.json.query_sanitized && s.json.sanitizer?.clean_query !== query) q.changedBySanitizer++;
    const best = new Map();
    for (const x of hits) {
      if (x.room !== ROOM) q.otherRoom++;
      const e = labels.indexOf(x.source_path);
      if (e < 0) {
        q.unknownHits++;
        continue;
      }
      if (x.effective_distance !== x.distance) q.boosted++;
      best.set(e, Math.min(best.get(e) ?? Infinity, x.distance));
    }
    const row = labels.map((_, e) => best.get(e) ?? null);
    q.notReturned += row.filter((d) => d === null).length;
    scores.push(row);
  }
  r.queries = q;
  if (q.failed || q.notReturned || q.otherRoom || q.unknownHits) fail(`${source}: searches ${JSON.stringify(q)}`);
  r.size = { entries: (await call("mempalace_list_drawers", { wing: WING, room: ROOM, limit: 1 })).json?.total,
    pieces: (await call("mempalace_status", {})).json?.total_drawers };
  r.backend = (await call("mempalace_status", {})).json?.backend;
  r.statusz = await statusz(h.port);
  r.transportErrors = errors.length;
  await client.close();
  r.stopMs = (await stopHub(h, `${source}: measured`)).goneMs;
  r.model = palaceModel(palace);
  if (r.backend !== "sqlite_exact" || r.statusz.backend !== "sqlite_exact" || r.model !== "minilm") {
    fail(`${source}: backend ${r.backend} / ${r.statusz.backend}, model ${r.model}`);
  }
  r.analysis = analyse(failures, own, scores, labels.length);
  // For the made-up set only (its groups are this script's own): which groups make the closest "different" pairs, and
  // each family's farthest "same" pair.
  if (source === "madeup") r.groups = groupsOf(failures, own, scores);
  return r;
}

// ---- the figures ----

const sortNum = (v) => [...v].sort((a, b) => a - b);
// The nearest-rank percentile: always one of the values themselves.
const nearest = (v, p) => (v.length ? v[Math.max(0, Math.ceil(p * v.length) - 1)] : null);
function spread(values) {
  const v = sortNum(values);
  if (!v.length) return { n: 0 };
  return { n: v.length, min: v[0], p10: nearest(v, 0.1), p25: nearest(v, 0.25), middle: nearest(v, 0.5),
    p75: nearest(v, 0.75), p90: nearest(v, 0.9), max: v.at(-1) };
}
const COUNTS = [1, 2, 3, 4, 5];

// The pairs: for each failure, every entry but its own, "same" or "different" by the rule; and, for a failure whose
// text another failure also has, its own entry as an "identical" match at its own score (the lesson of an identical
// failure). Then the source's candidate cut-offs, taken from its scores.
function analyse(failures, own, scores, entries) {
  const firstOf = [];
  own.forEach((e, i) => {
    if (e !== null && firstOf[e] === undefined) firstOf[e] = i;
  });
  const pairs = [];
  const self = [];
  const sharing = own.map((e) => (e === null ? 0 : own.filter((x) => x === e).length - 1));
  for (let i = 0; i < failures.length; i++) {
    if (own[i] === null) continue;
    for (let e = 0; e < entries; e++) {
      const d = scores[i][e];
      if (e === own[i]) {
        if (d !== null) self.push(d);
        if (sharing[i] && d !== null) pairs.push({ i, e, cls: "identical", d });
        continue;
      }
      if (d !== null) pairs.push({ i, e, cls: same(failures[i], failures[firstOf[e]]) ? "same" : "different", d });
    }
  }
  const of = (cls) => pairs.filter((p) => p.cls === cls).map((p) => p.d);
  const sv = sortNum(of("same"));
  const dv = sortNum(of("different"));
  const a = {
    pairs: { identical: of("identical").length, same: sv.length, different: dv.length },
    scores: { self: spread(self), identical: spread(of("identical")), same: spread(sv), different: spread(dv) },
    sharingAText: sharing.filter((n) => n > 0).length,
    samePerFailure: spread(failures.map((_, i) => pairs.filter((p) => p.i === i && p.cls === "same").length)),
  };
  a.candidates = [["same: middle", nearest(sv, 0.5)], ["same: 75th", nearest(sv, 0.75)],
    ["same: 90th", nearest(sv, 0.9)], ["same: largest", sv.at(-1)], ["different: smallest", dv[0]],
    ["different: 1st", nearest(dv, 0.01)], ["different: 5th", nearest(dv, 0.05)], ["different: 10th", nearest(dv, 0.1)]]
    .filter(([, d]) => d !== null && d !== undefined);
  const counted = failures.map((_, i) => i).filter((i) => own[i] !== null);
  a.failuresCounted = counted.length;
  a.failuresWithALike = counted.filter((i) => pairs.some((p) => p.i === i && p.cls !== "different")).length;
  // Kept for `cutoffsFor`, and out of the results file.
  Object.defineProperty(a, "data", { value: { pairs, counted }, enumerable: false });
  return a;
}

// One source's table, over a row of candidate cut-offs ([label, distance], from either source's scores; each source's
// figures are its own): for each, what falls inside, and what a count of 1 to 5 would attach, closest first.
function cutoffsFor(a, list) {
  const { pairs, counted } = a.data;
  const cand = new Map();
  for (const [from, d] of list) cand.set(d, [...(cand.get(d) ?? []), from]);
  return [...cand].sort(([x], [y]) => x - y).map(([d, from]) => {
    const inside = pairs.filter((p) => p.d <= d);
    const n = (cls) => inside.filter((p) => p.cls === cls).length;
    const per = (pick) => spread(counted.map((i) => inside.filter((p) => p.i === i && pick(p)).length));
    const attach = COUNTS.map((count) => {
      const t = { count, identical: 0, same: 0, different: 0, withAny: 0, withDifferent: 0, withoutLike: 0 };
      for (const i of counted) {
        const got = inside.filter((p) => p.i === i).sort((x, y) => x.d - y.d || x.e - y.e).slice(0, count);
        for (const p of got) t[p.cls]++;
        if (got.length) t.withAny++;
        if (got.some((p) => p.cls === "different")) t.withDifferent++;
        const like = pairs.some((p) => p.i === i && p.cls !== "different");
        if (like && !got.some((p) => p.cls !== "different")) t.withoutLike++;
      }
      return t;
    });
    return { d, from, identical: n("identical"), same: n("same"), different: n("different"),
      perFailure: { all: per(() => true), like: per((p) => p.cls !== "different"),
        different: per((p) => p.cls === "different") }, attach };
  });
}

// Made-up failures only: the 12 closest "different" pairs of groups (each pair of groups once, at its closest), and the
// farthest "same" pair in each family.
function groupsOf(failures, own, scores) {
  const closest = new Map();
  const farthest = new Map();
  for (let i = 0; i < failures.length; i++) {
    for (let k = 0; k < failures.length; k++) {
      if (k === i || own[k] === own[i]) continue;
      const d = scores[i][own[k]];
      const [g, h] = [failures[i].group, failures[k].group];
      if (g === h) farthest.set(g, Math.max(farthest.get(g) ?? -Infinity, d));
      else {
        const key = [g, h].sort().join("~");
        closest.set(key, Math.min(closest.get(key) ?? Infinity, d));
      }
    }
  }
  return { closestDifferent: [...closest].sort(([, x], [, y]) => x - y).slice(0, 12),
    farthestSame: [...farthest].sort(([, x], [, y]) => y - x) };
}

const sp = (s) => (s.n ? `${s.min} / ${s.p10} / ${s.p25} / ${s.middle} / ${s.p75} / ${s.p90} / ${s.max}` : "none");
const pc = (k, n) => (n ? `${k} (${Math.round((k / n) * 1000) / 10}%)` : `${k}`);
// Counts and scores only.
function report(title, r) {
  say(`---- ${title} ----`);
  if (r.read) say(`read: ${JSON.stringify(r.read)}`);
  if (!r.analysis) {
    say(`${title}: no failures to measure`);
    return;
  }
  const a = r.analysis;
  say(`failures ${r.failures}; distinct texts ${r.distinctTexts}; entries ${r.entries} (list_drawers ` +
    `${r.size.entries}, pieces ${r.size.pieces}); adds ${JSON.stringify(r.add)}; own count of repeats ${r.ownRepeats}`);
  say(`queries: ${JSON.stringify(r.queries)}; backend ${r.backend} / ${r.statusz.backend}, model ${r.model}; hub ` +
    `start ${r.startMs} ms, stop ${r.stopMs} ms`);
  say(`pairs: ${JSON.stringify(a.pairs)}; failures sharing a text ${a.sharingAText}; failures with an identical or ` +
    `same match ${a.failuresWithALike} of ${a.failuresCounted}`);
  say("distance (lower = closer): smallest / 10th / 25th / middle / 75th / 90th / largest (n)");
  for (const k of ["self", "identical", "same", "different"]) say(`  ${k}: ${sp(a.scores[k])} (${a.scores[k].n})`);
  say(`same matches per failure: ${sp(a.samePerFailure)}`);
  say("cut-off: identical, same and different inside; per failure, inside (all; identical or same; different): " +
    "middle / 90th / most");
  for (const c of a.cutoffs) {
    const p = c.perFailure;
    say(`  ${c.d} (${c.from.join(", ")}): identical ${pc(c.identical, a.pairs.identical)}, same ` +
      `${pc(c.same, a.pairs.same)}, different ${pc(c.different, a.pairs.different)}; per failure ` +
      `${p.all.middle}/${p.all.p90}/${p.all.max}; ${p.like.middle}/${p.like.p90}/${p.like.max}; ` +
      `${p.different.middle}/${p.different.p90}/${p.different.max}`);
    for (const t of c.attach) {
      say(`      count ${t.count}: attached identical ${t.identical}, same ${t.same}, different ${t.different}; ` +
        `failures with any ${t.withAny}, with a different one ${t.withDifferent}, with a like one left out ` +
        `${t.withoutLike}`);
    }
  }
  if (r.groups) {
    say(`closest different pairs of groups: ${r.groups.closestDifferent.map(([k, d]) => `${k} ${d}`).join(", ")}`);
    say(`farthest same pair in each family: ${r.groups.farthestSame.map(([k, d]) => `${k} ${d}`).join(", ")}`);
  }
}

// Deletes each palace folder this run made, by its exact name, after its hub has stopped: its files and folders one
// by one, never following a link (none is expected; one found stops the deletion).
function removeTree(dir, n) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw Object.assign(new Error("a link in a palace folder"), { code: "LINK" });
    if (e.isDirectory()) removeTree(p, n);
    else {
      unlinkSync(p);
      n.files++;
    }
  }
  rmdirSync(dir);
  n.folders++;
  return n;
}
function removePalaces() {
  const root = path.join(home, "palaces");
  const mine = new RegExp(`^measure-lessons-${stamp}-(madeup|real)$`);
  return palaces.map((dir) => {
    const name = path.basename(dir);
    if (path.dirname(dir) !== root || !mine.test(name)) {
      fail(`not this run's palace: ${name}`);
      return { name, removed: false };
    }
    if (!existsSync(dir)) return { name, removed: false, why: "not there" };
    try {
      const n = removeTree(dir, { files: 0, folders: 0 });
      const gone = !existsSync(dir);
      if (!gone) fail(`${name} is still there`);
      return { name, removed: gone, ...n };
    } catch (e) {
      fail(`removing ${name}: ${e?.code ?? e?.name}`);
      return { name, removed: false };
    }
  });
}

async function main() {
  let phase = "made-up";
  try {
    out.madeupCheck = checkMadeUp();
    init();
    await setUp(COMMAND);
    out.madeup = await measure("madeup", MADE_UP);
    if (COMMAND === "run") {
      phase = "real";
      const { counts, failures } = readReal();
      out.real = { read: counts, ...(failures.length ? await measure("real", failures) : { failures: 0 }) };
    }
    // One row of candidate cut-offs, from both sources' scores, each labelled with its source; each table's figures
    // are its own source's alone.
    const list = [["made-up", out.madeup], ["real", out.real]].flatMap(([name, r]) =>
      (r?.analysis?.candidates ?? []).map(([from, d]) => [`${name}: ${from}`, d]));
    for (const r of [out.madeup, out.real]) if (r?.analysis) r.analysis.cutoffs = cutoffsFor(r.analysis, list);
    report("MADE-UP failures", out.madeup);
    if (out.real) report("REAL failures", out.real);
    phase = "done";
  } catch (e) {
    // While the user's failures are handled, an error says its name alone: its message could hold their text.
    fail(phase === "real" ? `real: ${e?.name ?? "error"} ${e?.code ?? ""}` : `${phase}: ${e?.stack ?? e?.message}`);
  } finally {
    if (lister) {
      await cleanup();
      out.palaces = removePalaces();
      for (const p of out.palaces) say(`palace ${p.name}: ${p.removed ? `deleted (${p.files} files, ${p.folders} ` +
        "folders)" : `NOT deleted${p.why ? ` (${p.why})` : ""}`}`);
      await finish();
    } else {
      say(`measure-lessons: FAILED (${out.failures.length})`);
      process.exitCode = 1;
    }
  }
}

if (COMMAND === "madeup" || COMMAND === "run") await main();
else {
  console.error("usage: node scripts/8d/measure-lessons.mjs madeup | run");
  process.exitCode = 2;
}
