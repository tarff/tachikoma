// Measurement 8, the time limit on the lesson search when a tool fails (8d plan, step 11). Not part of Tachikoma: run
// by hand.
//
//   node scripts/8d/measure-search.mjs timings    the search timings, through hubs in the build folder; run between
//                                                 two snapshots of the user's folders
//   node scripts/8d/measure-search.mjs trial      the same, cut short (the first size, 3 runs of each, 1 start), to
//                                                 check the script before the long run; its figures are not used
//
// It times MemPalace searches as Tachikoma will send them: one search of one room (the lesson search when a tool
// fails, step 25: the room `lessons`), and two searches sent at once, one to the project's room and one to `lessons`,
// from the sending of both to the arrival of the later answer (the note and memory_search's "this project", Q27). Each
// is timed through a warm hub, just after a write (every write through the hub empties its search cache,
// mempalace/backends/sqlite_exact.py:520-521, so the next search reads every vector in the palace again), and as the
// first search after the hub starts, in one palace filled in stages to the sizes the script reports. Every query is
// made-up text of at most 250 characters (step 6 item 7); every entry is made-up filler, never the user's text. No
// transcript or log of the user's is read.
//
// Hubs are started and stopped exactly as step 8 proved (Q24, Q8, Q25): the functions from the helper LISTER down to
// `finish`, and `filler`, are copied unchanged from scripts/8d/measure-save.mjs (its lines 44-697 and 699-709, which
// it copied from scripts/8d/measure-hub.mjs), except for the names of the run folder and palaces, the result line, and
// the comment on `init`. Each hub is the build folder's `env\Scripts\python.exe -I -m mempalace.mcp_server --transport
// http --port <p> --palace <palace> --backend sqlite_exact`, with MEMPALACE_EMBEDDING_MODEL=minilm,
// MEMPALACE_MCP_WRITER_WAIT_SECONDS=0 and MEMPALACE_MCP_IDLE_HOURS=0, step 1's `install` environment (TEMP and TMP
// inside the build folder) and step 5's offline settings with a dead-end proxy; each is stopped by its serving
// process's id after its start time is read again, and at the end every process this script started is looked up
// again. Nothing is fetched.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync }
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
const palaceDir = (x) => path.join(home, "palaces", `measure-search-${stamp}-${x}`);
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
  runDir = path.join(installDir, `measure-search-${kind}-${stamp}`);
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
  say(out.failures.length ? `measure-search: FAILED (${out.failures.length})` : "measure-search: passed");
  process.exitCode = out.failures.length ? 1 : 0;
}

const WORDS = ["the", "saver", "files", "each", "turn", "once", "hub", "palace", "window", "lesson", "search", "entry",
  "room", "wing", "model", "lock", "start", "stop", "check", "note", "test", "build", "folder", "answer"];
function filler(i, n) {
  let s = `Filler entry ${i}:`;
  let x = (i * 2654435761) >>> 0;
  while (s.length < n) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    s += ` ${WORDS[x % WORDS.length]}`;
  }
  return s.slice(0, n);
}

// ---- the searches ----

// `trial` is the same run cut short, to check the script before the long run; its figures are not used.
const TRIAL = process.argv[2] === "trial";
const WING = "tachikoma";
// The design's room for lessons (section 3), and a project's room; one search covers one room (step 6 item 7).
const LESSONS = "lessons";
const PROJECT = "measure-search-project";
// MemPalace's longest query: mempalace_search refuses one of 251 characters (step 6 item 7).
const QUERY_MAX = 250;
// The two values of `limit` timed: MemPalace's default, 5 (mempalace/mcp_server/tools_read.py:611), and its most, 100
// (_MAX_RESULTS, mempalace/mcp_server/_session.py:681). The count Tachikoma will ask for is set later (M5 for lessons,
// step 13; M6 for the note, step 14), so both ends are timed: the search's pool of candidates grows with the limit
// (at least 4 times the limit, mempalace/searcher/candidates.py:26 and 30-54).
const LIMITS = [5, 100];
// Runs: 50 of each timing that needs no hub start, as M3's health checks (step 8): each is cheap, so more runs show
// the rare slow one; 10 of each that needs a hub start of its own, as M3's starts.
const RUNS = TRIAL ? 3 : 50;
const START_RUNS = TRIAL ? 1 : 10;
// The palace's entries, by M2's "today" palace (step 10: 83 entries, 72 of 1 piece, 9 of 2, 1 of 3 and 1 of 5; 98
// pieces), at M2's lengths for those pieces: 251 characters (the real middle), 870 (the real 90th) and 3,828 (the real
// longest); for the one entry of 3 pieces no real length is recorded, so the most 3 pieces hold, 2,400. So the palace
// is laid out in pieces as the user's would be. (A search folds hits that copy the same text and then searches again
// with a wider pool, mempalace/searcher/query.py:177-186 and 488-506; these texts are all different, so it never does.)
const PATTERN = [...Array(72).fill(251), ...Array(9).fill(870), 2_400, 3_828];
// The sizes: that pattern 1, 10 and 100 times over (98, 980 and 9,800 pieces): about the palace the user's transcripts
// make today (M2), M3's palace of 1,000 pieces, and M2's and M3's largest (about 10,000), so the figures line up with
// theirs. The entries alternate between the two rooms.
const STAGES = TRIAL ? [1] : [1, 10, 100];
// The entry written just before each "after a write" search: one turn of the real middle length (M2) in the project's
// room, as a turn's save; removed by its label after the search, so the palace keeps its size.
const WRITE_CHARS = 251;

// Each entry, write and query has a seed of its own, so no two texts are the same (MemPalace answers already_exists to
// a repeat in the same room, step 6 item 9) and no query is an entry's text.
let writeSeed = 20_000_000;
let querySeed = 30_000_000;
// A made-up query shaped like the lesson search's (a tool's name and the start of its error, step 25), cut to
// QUERY_MAX.
function query() {
  const n = ++querySeed;
  return (`run_command Error: ENOENT: no such file or directory, open 'C:\\work\\app\\src\\part-${n}\\index.ts' ` +
    filler(n, QUERY_MAX)).slice(0, QUERY_MAX);
}

// One search of one room, timed from the sending to the answer.
async function searchOne(call, room, limit) {
  const q = query();
  if (q.length > QUERY_MAX) throw new Error(`a query of ${q.length} characters`);
  const t0 = performance.now();
  const r = await call("mempalace_search", { query: q, wing: WING, room, limit });
  const ms = since(t0);
  const hits = r.json?.results;
  if (r.isError || r.json?.error || !Array.isArray(hits)) {
    fail(`a search's answer: ${JSON.stringify(r.json ?? r).slice(0, 200)}`);
  } else if (hits.some((x) => x.room !== room)) fail(`a search of ${room} gave a hit from another room`);
  return { ms, hits: Array.isArray(hits) ? hits.length : null };
}

// Two searches sent at once, one to each room, timed from the sending of both to the arrival of the later answer.
async function searchPair(call, limit) {
  const t0 = performance.now();
  const both = await Promise.all([searchOne(call, PROJECT, limit), searchOne(call, LESSONS, limit)]);
  return { ms: since(t0), each: both.map((x) => x.ms), hits: both.map((x) => x.hits) };
}

const searchAs = (call, kind, limit) => (kind === "one" ? searchOne(call, LESSONS, limit) : searchPair(call, limit));
function summary(runs, kind) {
  const s = { runs: runs.length, time: stats(runs.map((r) => r.ms)), hits: [...new Set(runs.map((r) =>
    JSON.stringify(r.hits)))] };
  if (kind === "pair") {
    s.earlier = stats(runs.map((r) => Math.min(...r.each)));
    s.later = stats(runs.map((r) => Math.max(...r.each)));
  }
  return s;
}

// The palace's size: entries in each room (mempalace_list_drawers' total), pieces in each room
// (mempalace_list_rooms) and in all (mempalace_status), and the palace file's bytes.
async function sizeOf(call, palace) {
  const entries = {};
  for (const room of [PROJECT, LESSONS]) {
    entries[room] = (await call("mempalace_list_drawers", { wing: WING, room, limit: 1 })).json?.total;
  }
  const rooms = (await call("mempalace_list_rooms", { wing: WING })).json;
  const pieces = (await call("mempalace_status", {})).json?.total_drawers;
  const file = path.join(palace, "sqlite_exact.sqlite3");
  const bytes = ["", "-wal"].reduce((n, x) => n + (existsSync(file + x) ? statSync(file + x).size : 0), 0);
  return { entries, rooms, pieces, bytes };
}

// Fills the palace on to `repeats` times the pattern, the entries alternating between the two rooms. Not timed as
// searches; the adds' times are kept.
async function fillTo(call, repeats, state) {
  const adds = [];
  while (state.repeats < repeats) {
    for (const length of PATTERN) {
      const i = state.entries++;
      const t0 = performance.now();
      const r = await call("mempalace_add_drawer", { wing: WING, room: i % 2 ? LESSONS : PROJECT,
        source_file: `measure-search fill ${i}`, content: filler(i + 1, length) });
      adds.push(performance.now() - t0);
      if (r.json?.success !== true || r.json?.reason) throw new Error(`fill ${i}: ${JSON.stringify(r.json ?? r)}`);
    }
    state.repeats++;
  }
  return { added: adds.length, add: stats(adds) };
}

// Through a warm hub: one search first, untimed, so the hub's search cache holds the palace; then RUNS timed.
async function warmSeries(call, limit, kind) {
  await searchAs(call, kind, limit);
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await searchAs(call, kind, limit));
  return summary(runs, kind);
}

// Just after a write: one entry added, then the search, then that entry removed by its label (not timed).
async function afterWriteSeries(call, limit, kind) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const label = `measure-search write ${++writeSeed}`;
    const add = await call("mempalace_add_drawer", { wing: WING, room: PROJECT, source_file: label,
      content: filler(writeSeed, WRITE_CHARS) });
    if (add.json?.success !== true || add.json?.reason) fail(`a write's answer: ${JSON.stringify(add.json ?? add)}`);
    runs.push(await searchAs(call, kind, limit));
    const rm = await call("mempalace_delete_by_source", { source_file: label, dry_run: false });
    if (rm.isError || rm.json?.error) fail(`a removal's answer: ${JSON.stringify(rm.json ?? rm).slice(0, 200)}`);
  }
  return summary(runs, kind);
}

// The first search after a hub starts: each run a new hub on the palace, connected, one search (or the pair) timed,
// then the hub stopped.
async function afterStartSeries(palace, limit, kind, tag) {
  const runs = [];
  for (let i = 0; i < START_RUNS; i++) {
    const h = startHub(`${tag}-${kind}-${limit}-${i}`, { palace, port: await freePort() });
    const up = await waitHealthy(h);
    if (!up.ok) {
      fail(`${h.label}: the hub did not answer: ${tail(h.stderr).join(" | ")}`);
      await look();
      for (const x of procs.filter((y) => y.label === h.label && y.goneBy == null)) await stopRec(x, [x], "failed");
      continue;
    }
    const t0 = performance.now();
    const { client, call } = await mcpClient(h.port);
    const connectMs = since(t0);
    const r = await searchAs(call, kind, limit);
    await client.close();
    const stop = await stopHub(h, `${h.label}: searched`);
    runs.push({ ...r, startMs: up.ms, connectMs, stopMs: stop.goneMs });
  }
  return { ...summary(runs, kind), start: stats(runs.map((r) => r.startMs)),
    connect: stats(runs.map((r) => r.connectMs)), stop: stats(runs.map((r) => r.stopMs)) };
}

const KINDS = ["one", "pair"];
async function timings() {
  const t = (out.timings = { trial: TRIAL, plan: { stages: STAGES, pattern: PATTERN.length, limits: LIMITS, runs: RUNS,
    startRuns: START_RUNS, queryMax: QUERY_MAX, writeChars: WRITE_CHARS }, stages: [] });
  try {
    init();
    await setUp(TRIAL ? "trial" : "timings");
    const palace = palaceDir("grow");
    const state = { repeats: 0, entries: 0 };
    for (const [k, repeats] of STAGES.entries()) {
      const s = { repeats, warm: {}, afterWrite: {}, afterStart: {} };
      t.stages.push(s);
      const name = `stage ${k + 1}`;
      const h = startHub(`stage-${k + 1}`, { palace, port: await freePort() });
      const up = await waitHealthy(h);
      if (!up.ok) throw new Error(`${name}: the hub did not answer: ${tail(h.stderr).join(" | ")}`);
      const { client, call, errors } = await mcpClient(h.port);
      s.fill = await fillTo(call, repeats, state);
      s.size = await sizeOf(call, palace);
      say(`${name}: ${JSON.stringify(s.size)}; fill ${JSON.stringify(s.fill)}`);
      for (const limit of LIMITS) {
        for (const kind of KINDS) {
          s.warm[`${kind}-${limit}`] = await warmSeries(call, limit, kind);
          say(line(`${name}, warm, ${kind}, limit ${limit}`, s.warm[`${kind}-${limit}`].time));
        }
      }
      for (const limit of LIMITS) {
        for (const kind of KINDS) {
          s.afterWrite[`${kind}-${limit}`] = await afterWriteSeries(call, limit, kind);
          say(line(`${name}, after a write, ${kind}, limit ${limit}`, s.afterWrite[`${kind}-${limit}`].time));
        }
      }
      s.sizeAfter = await sizeOf(call, palace);
      if (s.sizeAfter.pieces !== s.size.pieces) fail(`${name}: ${s.size.pieces} pieces, then ${s.sizeAfter.pieces}`);
      s.backend = (await call("mempalace_status", {})).json?.backend;
      s.statusz = await statusz(h.port);
      s.transportErrors = [...new Set(errors)];
      await client.close();
      s.stop = (await stopHub(h, `${name}: series done`)).goneMs;
      s.model = palaceModel(palace);
      say(`${name}: backend ${s.backend} / ${s.statusz.backend}, model ${s.model}`);
      if (s.backend !== "sqlite_exact" || s.statusz.backend !== "sqlite_exact" || s.model !== "minilm") {
        fail(`${name}: backend ${s.backend} / ${s.statusz.backend}, model ${s.model}`);
      }
      for (const limit of LIMITS) {
        for (const kind of KINDS) {
          const r = (s.afterStart[`${kind}-${limit}`] = await afterStartSeries(palace, limit, kind, `first-${k + 1}`));
          say(line(`${name}, first search after a start, ${kind}, limit ${limit}`, r.time));
        }
      }
    }
  } catch (e) {
    fail(`timings: ${e.stack ?? e.message}`);
  } finally {
    if (lister) await finish();
    else {
      say(`measure-search: FAILED (${out.failures.length})`);
      process.exitCode = 1;
    }
  }
}

const command = process.argv[2];
if (command === "timings" || command === "trial") await timings();
else {
  console.error("usage: node scripts/8d/measure-search.mjs timings | trial");
  process.exitCode = 2;
}
