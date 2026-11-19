// Measurement 3, the hub's start limit and how often it is checked, and the first proof of the hub's start and stop
// (8d plan, step 8). Not part of Tachikoma: run by hand, each run between two snapshots of the user's folders.
//
//   node scripts/8d/measure-hub.mjs proof          the proof (Q24): run first; the timings rely on it
//   node scripts/8d/measure-hub.mjs first-starts   the first start after an install, from offline installs
//   node scripts/8d/measure-hub.mjs timings        the other timings
//
// Every hub is started the way the user decided after step 6 (Q24, Q8, Q25), never as `mempalace serve`: the
// environment's own Python by its full path, `-I -m mempalace.mcp_server --transport http --port <p> --palace <palace>
// --backend sqlite_exact`, with MEMPALACE_EMBEDDING_MODEL=minilm, MEMPALACE_MCP_WRITER_WAIT_SECONDS=0 and
// MEMPALACE_MCP_IDLE_HOURS=0 in its environment, hidden and detached as a window would start it. The host is
// MemPalace's default, 127.0.0.1 (mempalace/mcp_server/_guards.py:39-42), and every port is one this script took from
// the system on 127.0.0.1 and let go just before the start (never 8765). Every palace is new, under the build's
// `install` home, and always passed with --palace. The environment is step 1's `install` one (the home, the model of
// step 5, no MEMPALACE_* of the user's) with step 5's settings: HF_HUB_OFFLINE=1 and a dead-end proxy of this script's
// on 127.0.0.1 in HTTP_PROXY, HTTPS_PROXY and ALL_PROXY, which records and refuses every connection. The hubs that fill
// palaces with filler entries run the same server module through step 5's audit-hook wrapper
// (scripts/8d/mempalace-checks.mjs), so every add and search of the filler phase is also watched by the hook; the
// hubs started the decided way are watched by the proxy only. Nothing is fetched: `first-starts` unpacks step 4's kept
// Python archive with Windows' tar.exe and runs uv with UV_OFFLINE=1 from step 4's wheel cache, into new folders of the
// build folder.
//
// Processes: a helper of this script's, the build Python's own interpreter with -I and only its standard library
// (`LISTER`), lists processes by id and parent id with their start times (Toolhelp32 and GetProcessTimes) and stops
// one: it opens the process, reads its start time from that same handle, and only if it is the recorded one ends it
// through that handle, so a reused id is never hit; it then times how long each process of the hub takes to end. A
// process counts as this script's when this script started it, or when its parent is one of this script's and it
// started while that parent was known to hold its id (seen running, or held by a handle of this script's or of the
// helper's). A process under a recorded id that started after that parent was known to be gone is another program's
// and is left alone. Any other process under a recorded id cannot be settled by start times: the run fails. Every
// record is kept by id and start time together, so an id given to a new process of this script's gets a record of its
// own (the first known limit of mempalace-checks.mjs, fixed), and an unsettled process fails the run (the second,
// fixed). At the end every recorded process, and every process under one, is looked up again.
//
// GIVE_UP_MS and POLL_MS are this script's own cut-off, so that a run always ends, and its own polling step: not
// figures for Tachikoma. The counts and filler sizes are this script's choices, each with its reason below.
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { commandEnv } from "../../src/exec/env.ts";
import { BUILD, throwaway } from "./throwaway.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PYTHON = path.join(BUILD, "env", "Scripts", "python.exe");
const POWERSHELL = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0",
  "powershell.exe");
const TAR = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
const GIVE_UP_MS = 180_000;
// Between two health checks while this script waits for a hub. A refused check on loopback took about 1 ms here, so
// the measured start is at most about 11 ms later than the hub's first good answer.
const POLL_MS = 10;
// Starts of an installed environment, for each kind of palace: a hub took about 2.5 s to start in step 6, so ten of
// each kind take minutes, and ten give a middle and show the spread.
const WARM_STARTS = 10;
// First starts after an install: each needs a whole install of its own (a Python and an environment of about 320 MB,
// copied), so three, for a fastest, a middle and a slowest.
const FRESH_INSTALLS = 3;
// Second hubs for a held palace (each about 2.5 s in step 6), as many as the starts.
const SECOND_HUBS = 10;
// Health checks of each kind; each takes milliseconds, so fifty cost nothing and give a steady middle.
const HEALTH_CHECKS = 50;
// Reads of a process's start time by the environment's Python (about 125 ms each in step 6).
const START_TIME_READS = 20;
// Failed tries to take a held lock, of each kind; each takes milliseconds.
const LOCK_TRIES = 200;
// Filler: entries of 4,000 characters, five of MemPalace's 800-character pieces (mempalace/config.py:415), in palaces
// of 200 and 2,000 entries (1,000 and 10,000 pieces), a factor of ten apart, to show whether a hub's start depends on
// the palace's size. The source says it does not (mempalace/mcp_server/runtime.py:300-303: only "the cheap
// filesystem-only probe before binding", no embedder or index warm-up). Real turn lengths are step 10's.
const FILLER_CHARS = 4_000;
const FILLER_SIZES = [200, 2_000];
// The longest entry MemPalace accepts (mempalace/config.py:283-291), added while health checks run: the longest single
// write a saver sends.
const LONGEST_ENTRY = 100_000;
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

// Step 5's audit-hook wrapper, as in scripts/8d/mempalace-checks.mjs: argv is the log file, the module, then the
// module's own arguments.
const WRAPPER = String.raw`
import json, socket, sys
phase = 'control'
log = open(sys.argv[1], 'a', encoding='utf-8')
def host_of(event, args):
    if event in ('socket.connect', 'socket.sendto', 'socket.sendmsg'):
        a = args[1]
        return str(a[0]) if isinstance(a, tuple) else str(a)
    if event in ('socket.getaddrinfo', 'socket.gethostbyname', 'socket.gethostbyaddr', 'socket.gethostbyname_ex'):
        return str(args[0])
    if event == 'http.client.connect':
        return str(args[1])
    if event == 'urllib.Request':
        from urllib.parse import urlsplit
        return str(urlsplit(args[0]).hostname)
    return None
WATCHED = {'socket.connect', 'socket.sendto', 'socket.sendmsg', 'socket.getaddrinfo', 'socket.gethostbyname',
           'socket.gethostbyaddr', 'socket.gethostbyname_ex', 'http.client.connect', 'urllib.Request',
           'subprocess.Popen', 'os.system', 'os.exec', 'os.posix_spawn', 'os.spawn', 'os.startfile'}
def hook(event, args):
    if event in WATCHED:
        try:
            host = host_of(event, args)
        except Exception:
            host = 'unparsed'
        try:
            log.write(json.dumps({'phase': phase, 'event': event, 'host': host, 'args': repr(args)[:300]}) + '\n')
            log.flush()
        except Exception:
            pass
sys.addaudithook(hook)
s = socket.socket()
s.bind(('127.0.0.1', 0))
s.listen()
socket.create_connection(s.getsockname()).close()
s.close()
import urllib.request
from httpx._utils import get_environment_proxies
log.write(json.dumps({'phase': phase, 'urllib_proxies': urllib.request.getproxies(),
                      'httpx_proxies': {k: str(v) for k, v in get_environment_proxies().items()}}) + '\n')
log.flush()
phase = 'server'
import runpy
module = sys.argv[2]
sys.argv = [module] + sys.argv[3:]
runpy.run_module(module, run_name='__main__', alter_sys=True)
`;

// One read of a process's start time (GetProcessTimes), as 100 ns steps since 1601: step 6's START_TIME_PY, the way
// step 20 will read it, by the environment's own Python with -I.
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

// Started by this script, it starts a hub detached and hidden, as a window would, prints its id and exits (the proof:
// the hub outlives the process that started it). Step 6's STARTER.
const STARTER = `
const { spawn } = require("node:child_process");
const { openSync } = require("node:fs");
const [file, out, err, cwd, ...args] = process.argv.slice(1);
const c = spawn(file, args, { cwd, detached: true, windowsHide: true, stdio: ["ignore", openSync(out, "w"),
  openSync(err, "w")] });
c.unref();
process.stdout.write(String(c.pid));
`;

// Holds a node:sqlite lock (step 2's choice: an exclusive transaction on a lock file) until its stdin ends.
const HOLDER = `
const { DatabaseSync } = require("node:sqlite");
globalThis.kept = new DatabaseSync(process.argv[1], { timeout: 0 });
globalThis.kept.exec("BEGIN EXCLUSIVE");
process.stdout.write("held\\n");
process.stdin.on("end", () => { globalThis.kept.close(); process.exit(0); });
process.stdin.resume();
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

const { dir: installDir, env: base } = throwaway("install");
const home = base.USERPROFILE;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = { stamp, failures: [] };
const fail = (what) => {
  out.failures.push(what);
  say(`FAILED: ${what}`);
};

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
const palaceDir = (x) => path.join(home, "palaces", `measure-hub-${stamp}-${x}`);
const logs = (label) => ({ stdout: path.join(runDir, `${label}.stdout.log`), stderr: path.join(runDir,
  `${label}.stderr.log`), audit: path.join(runDir, `${label}.audit.jsonl`) });

function startHub(label, { python = PYTHON, palace, port, wrapped = false }) {
  const f = logs(label);
  const o = openSync(f.stdout, "w");
  const e = openSync(f.stderr, "w");
  const args = wrapped ? ["-I", "-c", WRAPPER, f.audit, ...hubArgs(port, palace).slice(2)] : hubArgs(port, palace);
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

// A second hub on a held palace, polled until it ends: its exit, how long it took, and whether it ever answered.
async function secondHub(label, palace) {
  const port = await freePort();
  const h = startHub(label, { palace, port });
  let answered = false;
  while (!h.exit && performance.now() - h.t0 < GIVE_UP_MS) {
    if (await healthy(port)) answered = true;
    await look();
    await sleep(POLL_MS);
  }
  if (!h.exit) {
    await look();
    for (const r of procs.filter((x) => x.label === label && x.goneBy == null)) await stopRec(r, [r], "cut-off");
    await h.exited;
  }
  await look();
  const seen = procs.filter((r) => r.label === label);
  return { exit: h.exit, answered, refusal: tail(h.stderr, 6).find((l) => l.includes("startup refused")) ?? null,
    processesSeen: seen.map((r) => `${r.pid} ${r.name}`), servingSeen: seen.length > 1 };
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
  const ps = spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], { env: commandEnv(process.env), encoding: "utf8",
    windowsHide: true });
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
  runDir = path.join(installDir, `measure-hub-${kind}-${stamp}`);
  mkdirSync(runDir);
  mkdirSync(path.join(home, "palaces"), { recursive: true });
  processEnv = await startProxy();
  hubEnv = { ...processEnv, ...HUB_SETTINGS };
  startLister(processEnv);
  // The helper's own check, before any hub starts: it must list itself, and list and stop a child of this script's.
  const before = nowUs();
  const dummy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
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
  say(out.failures.length ? `measure-hub: FAILED (${out.failures.length})` : "measure-hub: passed");
  process.exitCode = out.failures.length ? 1 : 0;
}

const readStart = (pid, python = PYTHON) => {
  const before = nowUs();
  const t0 = performance.now();
  const r = spawnSync(python, ["-I", "-c", START_TIME_PY, String(pid)], { env: hubEnv, encoding: "utf8",
    windowsHide: true, timeout: GIVE_UP_MS });
  const ms = since(t0);
  if (r.pid) recordDirect("start-time read", r.pid, before, path.basename(python));
  const text = r.stdout.trim();
  return { ms, start: /^\d+$/.test(text) ? Number(BigInt(text) / 10n - 11644473600000000n) : null, text };
};

// ---- the proof ----

async function proof() {
  const p = (out.proof = {});
  const ok = (name, value) => {
    p.checks ??= {};
    p.checks[name] = Boolean(value);
    if (!value) fail(`proof: ${name}`);
  };
  try {
    await setUp("proof");
    const palace = palaceDir("proof");
    const port = await freePort();
    // Started by a starter that exits at once, as a window would.
    const f = logs("proof");
    const before = nowUs();
    const r = spawnSync(process.execPath, ["-e", STARTER, PYTHON, f.stdout, f.stderr, home, ...hubArgs(port, palace)],
      { env: hubEnv, encoding: "utf8", windowsHide: true, timeout: GIVE_UP_MS });
    const t0 = performance.now();
    recordDirect("proof", r.pid, before, "node.exe (starter)");
    const launcher = Number(r.stdout);
    roots.add(launcher);
    p.start = { command: [PYTHON, ...hubArgs(port, palace)], settings: HUB_SETTINGS, port, palace,
      starter: { pid: r.pid, exit: r.status, launcherPid: launcher } };
    ok("the starter exited 0 and named the process it started", r.status === 0 && Number.isInteger(launcher));
    const h = { label: "proof", port, palace, t0, rec: {}, exit: null };
    const up = await waitHealthy(h, { looking: true });
    p.health = up;
    ok("the hub answered its health check after its starter had exited", up.ok);
    if (!up.ok) return;
    const { infos, info, rec } = await serving(h);
    p.tree = procs.filter((x) => x.label === "proof").map(show);
    p.serverinfo = { found: infos.map((x) => x.file), info };
    ok("one serverinfo.json for the palace, found by listing and a case-blind palace_path match", infos.length === 1);
    ok("it names this port and 127.0.0.1", info?.port === port && info?.host === "127.0.0.1");
    ok("it names a serving process of this run's, under the started one", rec && rec.ppid === launcher);
    const launcherRec = procs.find((x) => x.pid === launcher && x.label === "proof");
    ok("the started process is this run's (its parent is the starter, and it started while the starter ran)",
      launcherRec);
    ok("the starter has exited", procs.find((x) => x.pid === r.pid && x.label === "proof")?.goneBy != null);
    // Its start time, read as step 20 will, against the helper's.
    const first = readStart(info.pid);
    p.startTime = { read: iso(first.start), readMs: first.ms, helper: iso(rec?.start) };
    ok("the start time read by the environment's Python is the helper's", first.start != null &&
      first.start === rec?.start);

    // Serves: one add and one search through the MCP library; the backend and the model read back.
    const { client, call, errors } = await mcpClient(port);
    const label = "measure-hub proof, entry 1";
    const add = await call("mempalace_add_drawer", { wing: "tachikoma", room: "proof-room", source_file: label,
      content: "The proof's entry: the hub serves, is found, and is stopped by its serving process's id." });
    const search = await call("mempalace_search", { query: "is the hub stopped by its serving process's id",
      wing: "tachikoma", room: "proof-room" });
    const status = await call("mempalace_status", {});
    await client.close();
    p.serves = { add: add.json ?? add, searchFinds: (search.json?.results ?? []).some((x) => x.source_file === label),
      transportErrors: errors, backendTool: status.json?.backend, statusz: await statusz(port),
      model: palaceModel(palace) };
    ok("the add worked", add.json?.success === true);
    ok("the search found the entry", p.serves.searchFinds);
    ok("the backend read back is sqlite_exact", p.serves.backendTool === "sqlite_exact" &&
      p.serves.statusz.backend === "sqlite_exact");
    ok("the model read back is minilm (all-MiniLM-L6-v2)", p.serves.model === "minilm");

    // A second hub for the same palace while the first runs.
    p.second = await secondHub("proof-second", palace);
    ok("the second hub exited with code 2", p.second.exit?.code === 2);
    ok("the second hub never answered", !p.second.answered);
    ok("the second hub's serving process was seen", p.second.servingSeen);

    // Stopped by the serving process's id, after its start time is read again and still matches.
    const again = readStart(info.pid);
    p.stop = { startReadAgain: iso(again.start), matches: again.start === first.start };
    ok("the start time read again still matches", again.start != null && again.start === first.start);
    Object.assign(p.stop, await stopHub(h, "the proof: the serving process, by its id, after its start time"));
    ok("every process of the hub is gone, listed by id before and after", p.stop.ok);
    ok("the hub no longer answers", !p.stop.answersAfter);
    ok("the process stopped was the one serverinfo.json names", p.stop.servingPid === info.pid);

    // The palace can be opened by a new hub afterwards.
    const port2 = await freePort();
    const h2 = startHub("proof-reopen", { palace, port: port2 });
    const up2 = await waitHealthy(h2, { looking: true });
    p.reopen = { health: up2 };
    ok("a new hub on the palace answered", up2.ok);
    if (up2.ok) {
      const c2 = await mcpClient(port2);
      const s2 = await c2.call("mempalace_search", { query: "is the hub stopped by its serving process's id",
        wing: "tachikoma", room: "proof-room" });
      await c2.client.close();
      p.reopen.searchFinds = (s2.json?.results ?? []).some((x) => x.source_file === label);
      p.reopen.statusz = await statusz(port2);
      ok("the new hub found the first hub's entry", p.reopen.searchFinds);
      p.reopen.stop = await stopHub(h2, "the proof's second hub");
    }
  } catch (e) {
    fail(`proof: ${e.stack ?? e.message}`);
  } finally {
    await finish();
  }
  say(`proof: ${Object.entries(p.checks ?? {}).map(([k, v]) => `\n  ${v ? "yes" : "NO "} ${k}`).join("")}`);
}

// ---- the first start after an install ----

const inside = (folder, p) => {
  const r = path.relative(folder.toLowerCase(), path.resolve(p).toLowerCase());
  return r !== "" && !r.startsWith("..") && !path.isAbsolute(r);
};

async function firstStarts() {
  const fresh = path.join(BUILD, `hub-fresh-${stamp}`);
  out.firstStarts = { folder: fresh, installs: [] };
  try {
    await setUp("first-starts");
    mkdirSync(fresh);
    const v = spawnSync("uv", ["--version"], { env: processEnv, encoding: "utf8" });
    out.firstStarts.uv = v.stdout.trim();
    for (let i = 1; i <= FRESH_INSTALLS; i++) {
      const dir = path.join(fresh, `fresh-${i}`);
      const project = path.join(dir, "project");
      mkdirSync(project, { recursive: true });
      copyFileSync(path.join(REPO, "memory", "pyproject.toml"), path.join(project, "pyproject.toml"));
      copyFileSync(path.join(REPO, "memory", "uv.lock"), path.join(project, "uv.lock"));
      // Step 4's install, again, but offline: the same wheel and Python archive caches (step 4's), a new Python
      // folder and a new environment folder, every file copied (not linked), as a first install has new files.
      // TEMP and TMP point inside the install's folder too: the runs of this command before this was added left one
      // empty `uv-<16 hex>.lock` per `uv sync` in the user's Temp folder (removed by exact name).
      const uvEnv = Object.fromEntries(Object.entries(processEnv).filter(([k]) => !(/^UV_/i.test(k) &&
        k.toUpperCase() !== "UV_NO_CONFIG") && !/^(TEMP|TMP)$/i.test(k)));
      const tmp = path.join(dir, "tmp");
      mkdirSync(tmp, { recursive: true });
      Object.assign(uvEnv, {
        TEMP: tmp,
        TMP: tmp,
        UV_CACHE_DIR: path.join(installDir, "uv-cache"),
        UV_PYTHON_CACHE_DIR: path.join(installDir, "python-cache"),
        UV_PYTHON_INSTALL_DIR: path.join(dir, "python"),
        UV_PYTHON_BIN_DIR: path.join(dir, "python-bin"),
        UV_TOOL_DIR: path.join(dir, "uv-tools"),
        UV_PROJECT_ENVIRONMENT: path.join(dir, "env"),
        UV_PYTHON_PREFERENCE: "only-managed",
        UV_OFFLINE: "1",
        UV_LINK_MODE: "copy",
      });
      const run = { i, dir };
      // uv will not set up a Python from its archive cache while offline ("A managed Python download is available
      // for Python 3.13, but uv is set to offline mode"), so the script unpacks that same archive, step 4's, where uv
      // would put it, under the folder name step 4's uv gave it; uv then finds it as a Python it manages.
      const pyDir = path.join(dir, "python");
      const unpack = path.join(pyDir, ".unpack");
      mkdirSync(unpack, { recursive: true });
      const cache = path.join(installDir, "python-cache");
      const archive = path.join(cache, readdirSync(cache).find((n) => n.endsWith("-install_only_stripped.tar.gz")));
      const name = readdirSync(path.join(installDir, "python")).find((n) => /^cpython-3\.13\.\d+-windows-x86_64-none$/
        .test(n));
      const tb = nowUs();
      const t0 = performance.now();
      const tr = spawnSync(TAR, ["-xzf", archive, "-C", unpack], { env: processEnv, encoding: "utf8" });
      if (tr.pid) recordDirect(`tar ${i}`, tr.pid, tb, "tar.exe");
      if (tr.status !== 0) throw new Error(`tar: ${tr.stderr}`);
      renameSync(path.join(unpack, "python"), path.join(pyDir, name));
      rmdirSync(unpack);
      run.unpackMs = since(t0);
      run.python = { archive, folder: path.join(pyDir, name), bytecodeFiles: readdirSync(path.join(pyDir, name, "Lib",
        "__pycache__")).length };
      for (const args of [["cache", "dir"], ["python", "dir"], ["python", "dir", "--bin"]]) {
        const r = spawnSync("uv", args, { cwd: project, env: uvEnv, encoding: "utf8" });
        const where = r.stdout.trim();
        run[args.join(" ")] = where;
        if (r.status !== 0 || !inside(BUILD, where)) throw new Error(`uv ${args.join(" ")}: ${where} ${r.stderr}`);
      }
      for (const k of Object.keys(uvEnv)) {
        if (/^(UV_.*(DIR|ENVIRONMENT)|TEMP|TMP)$/i.test(k) && !inside(BUILD, uvEnv[k])) {
          throw new Error(`${k} outside the build`);
        }
      }
      const log = path.join(dir, "sync.log");
      const fd = openSync(log, "w");
      const before = nowUs();
      const t1 = performance.now();
      const r = spawnSync("uv", ["sync", "--locked", "--python", "3.13", "-vv"], { cwd: project, env: uvEnv,
        stdio: ["ignore", fd, fd] });
      closeSync(fd);
      run.syncMs = since(t1);
      run.installMs = round1(run.unpackMs + run.syncMs);
      if (r.pid) recordDirect(`uv ${i}`, r.pid, before, "uv.exe");
      const text = readFileSync(log, "utf8");
      run.exit = r.status;
      run.requests = text.split(/\r?\n/).filter((l) => /Sending (fresh|cached|revalidation) GET request|Downloading `/
        .test(l)).length;
      run.pythonFromCache = text.split(/\r?\n/).filter((l) => /python-cache/i.test(l)).length;
      const python = path.join(dir, "env", "Scripts", "python.exe");
      const site = path.join(dir, "env", "Lib", "site-packages", "mempalace");
      const caches = () => readdirSync(site, { recursive: true, withFileTypes: true }).filter((e) =>
        e.isDirectory() && e.name === "__pycache__").length;
      run.bytecodeFoldersBefore = existsSync(site) ? caches() : null;
      out.firstStarts.installs.push(run);
      if (r.status !== 0 || run.requests || !existsSync(python)) throw new Error(`install ${i}: exit ${r.status}, ` +
        `${run.requests} request lines; ${tail(log, 3).join(" | ")}`);
      // The first start of this install, then a second.
      for (const which of ["first", "second"]) {
        const h = startHub(`fresh-${i}-${which}`, { python, palace: palaceDir(`fresh-${i}-${which}`),
          port: await freePort() });
        const up = await waitHealthy(h);
        run[which] = { health: up, statusz: up.ok ? await statusz(h.port) : null };
        if (!up.ok) {
          fail(`fresh install ${i}: the ${which} start did not answer: ${tail(h.stderr).join(" | ")}`);
          await look();
          for (const x of procs.filter((y) => y.label === h.label && y.goneBy == null)) await stopRec(x, [x], "failed");
          continue;
        }
        const s = await stopHub(h, `fresh install ${i}, ${which} start`);
        run[which].goneMs = s.goneMs;
        run[which].ends = s.ends;
      }
      run.bytecodeFoldersAfter = caches();
      run.python.bytecodeFilesAfter = readdirSync(path.join(run.python.folder, "Lib", "__pycache__")).length;
      say(`install ${i}: ${run.installMs} ms; first start ${run.first?.health.ms} ms, ` +
        `second ${run.second?.health.ms} ms`);
    }
    const ins = out.firstStarts.installs;
    out.firstStarts.summary = {
      "unpack Python": stats(ins.map((x) => x.unpackMs)),
      "uv sync, offline": stats(ins.map((x) => x.syncMs)),
      install: stats(ins.map((x) => x.installMs)),
      first: stats(ins.map((x) => x.first?.health.ok && x.first.health.ms)),
      second: stats(ins.map((x) => x.second?.health.ok && x.second.health.ms)),
      gone: stats(ins.flatMap((x) => [x.first?.goneMs, x.second?.goneMs])),
    };
    for (const [k, s] of Object.entries(out.firstStarts.summary)) say(line(k, s));
  } catch (e) {
    fail(`first starts: ${e.stack ?? e.message}`);
  } finally {
    await finish();
  }
}

// ---- the other timings ----

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

async function healthDuring(port, promise) {
  const samples = [];
  let done = false;
  promise.then(() => (done = true), () => (done = true));
  while (!done) {
    const t0 = performance.now();
    const good = await healthy(port);
    samples.push({ ms: since(t0), good });
    await sleep(POLL_MS);
  }
  return { ...stats(samples.map((s) => s.ms)), allGood: samples.every((s) => s.good) };
}

function freshConnectionCheck(port) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const req = http.get({ host: "127.0.0.1", port, path: "/healthz", agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve({ ms: since(t0), good: res.statusCode === 200 }));
    });
    req.on("error", (e) => resolve({ ms: since(t0), good: false, error: e.code }));
  });
}

async function lockTimings() {
  const file = path.join(runDir, "held.lock");
  const before = nowUs();
  const holder = spawn(process.execPath, ["-e", HOLDER, file], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const rec = recordDirect("lock holder", holder.pid, before, "node.exe (lock holder)", holder);
  rec.child = holder;
  let err = "";
  holder.stderr.on("data", (d) => (err += d));
  await new Promise((resolve, reject) => {
    holder.stdout.once("data", resolve);
    holder.once("exit", (c) => reject(new Error(`the lock holder ended (${c}): ${err}`)));
  });
  const whole = [];
  const codes = new Set();
  let took = 0;
  for (let i = 0; i < LOCK_TRIES; i++) {
    const t0 = performance.now();
    const db = new DatabaseSync(file, { timeout: 0 });
    try {
      db.exec("BEGIN EXCLUSIVE");
      took++;
    } catch (e) {
      codes.add(`${e.code} ${e.errcode} ${e.errstr}`);
    } finally {
      db.close();
    }
    whole.push(performance.now() - t0);
  }
  const open = [];
  const db = new DatabaseSync(file, { timeout: 0 });
  for (let i = 0; i < LOCK_TRIES; i++) {
    const t0 = performance.now();
    try {
      db.exec("BEGIN EXCLUSIVE");
      took++;
    } catch (e) {
      codes.add(`${e.code} ${e.errcode} ${e.errstr}`);
    }
    open.push(performance.now() - t0);
  }
  db.close();
  holder.stdin.end();
  await new Promise((resolve) => (holder.exitCode != null ? resolve() : holder.once("exit", resolve)));
  if (took) fail(`the held lock was taken ${took} times`);
  return { file, refusedWith: [...codes], tookWhileHeld: took,
    openTryClose: stats(whole), tryOnOpenConnection: stats(open) };
}

async function timings() {
  const t = (out.timings = {});
  try {
    await setUp("timings");
    t.lock = await lockTimings();
    say(line("a failed lock try (open, try, close)", t.lock.openTryClose));
    say(line("a failed lock try on an open connection", t.lock.tryOnOpenConnection));

    // Filler palaces, filled through a hub that runs the server module under the audit hook.
    t.filler = {};
    const fillers = {};
    for (const size of FILLER_SIZES) {
      const palace = palaceDir(`filler-${size}`);
      const label = `filler-${size}`;
      const h = startHub(label, { palace, port: await freePort(), wrapped: true });
      const up = await waitHealthy(h);
      if (!up.ok) throw new Error(`${label} did not answer: ${tail(h.stderr).join(" | ")}`);
      const { client, call } = await mcpClient(h.port);
      const adds = [];
      for (let i = 0; i < size; i++) {
        const t0 = performance.now();
        const r = await call("mempalace_add_drawer", { wing: "tachikoma", room: "filler-room",
          source_file: `measure-hub filler ${size} ${i}`, content: filler(i, FILLER_CHARS) });
        adds.push(performance.now() - t0);
        if (r.json?.success !== true || r.json?.reason) throw new Error(`filler add ${i}: ${JSON.stringify(r)}`);
      }
      const f = { entries: size, chars: FILLER_CHARS, add: stats(adds) };
      if (size === FILLER_SIZES.at(-1)) {
        // Health checks while the hub is busy: one search, then the longest entry MemPalace accepts.
        const search = call("mempalace_search", { query: "the saver files each turn once in the palace room",
          wing: "tachikoma", room: "filler-room" });
        f.healthDuringSearch = await healthDuring(h.port, search);
        const big = call("mempalace_add_drawer", { wing: "tachikoma", room: "filler-room",
          source_file: "measure-hub longest entry", content: filler(-1, LONGEST_ENTRY) });
        f.healthDuringLongestAdd = await healthDuring(h.port, big);
        f.longestAdd = (await big).json;
      }
      const total = await call("mempalace_list_drawers", { wing: "tachikoma", room: "filler-room", limit: 1 });
      const status = await call("mempalace_status", {});
      await client.close();
      f.entriesInPalace = total.json?.total;
      f.piecesInPalace = status.json?.total_drawers;
      f.backend = status.json?.backend;
      f.statusz = await statusz(h.port);
      f.stop = (await stopHub(h, `${label}: filled`)).goneMs;
      f.model = palaceModel(palace);
      f.fileMB = round1(statSync(path.join(palace, "sqlite_exact.sqlite3")).size / 1e6);
      t.filler[size] = f;
      fillers[size] = palace;
      say(`filler ${size}: ${line("one add", f.add)}; entries ${f.entriesInPalace}, pieces ${f.piecesInPalace}, ` +
        `${f.fileMB} MB; backend ${f.backend}, model ${f.model}`);
      if (f.backend !== "sqlite_exact" || f.model !== "minilm") fail(`filler ${size}: backend or model`);
    }

    // Starts of the installed environment, the kinds in turn.
    const kinds = ["new", ...FILLER_SIZES.map(String)];
    t.starts = Object.fromEntries(kinds.map((k) => [k, []]));
    t.stops = [];
    for (let i = 0; i < WARM_STARTS; i++) {
      for (const kind of kinds) {
        const palace = kind === "new" ? palaceDir(`new-${i}`) : fillers[kind];
        const h = startHub(`start-${kind}-${i}`, { palace, port: await freePort() });
        const up = await waitHealthy(h);
        if (!up.ok) {
          fail(`start ${kind} ${i} did not answer: ${tail(h.stderr).join(" | ")}`);
          await look();
          for (const x of procs.filter((y) => y.label === h.label && y.goneBy == null)) await stopRec(x, [x], "failed");
          continue;
        }
        const sz = await statusz(h.port);
        if (sz.backend !== "sqlite_exact") fail(`start ${kind} ${i}: backend ${sz.backend}`);
        t.starts[kind].push(up.ms);
        if (i === 0 && kind === "new") {
          // On one live hub: health checks, start-time reads and second hubs.
          const warm = [];
          for (let j = 0; j < HEALTH_CHECKS; j++) {
            const t0 = performance.now();
            if (!(await healthy(h.port))) fail("a live health check failed");
            warm.push(performance.now() - t0);
          }
          const freshConn = [];
          for (let j = 0; j < HEALTH_CHECKS; j++) freshConn.push(await freshConnectionCheck(h.port));
          t.healthLive = { reusedConnection: stats(warm), newConnection: stats(freshConn.map((x) => x.ms)),
            allGood: freshConn.every((x) => x.good) };
          const { info } = await serving(h);
          const reads = [];
          for (let j = 0; j < START_TIME_READS; j++) reads.push(readStart(info.pid));
          const servingRec = procs.find((r) => r.pid === info.pid && r.label === h.label);
          t.startTimeRead = { ...stats(reads.map((x) => x.ms)), allMatch: reads.every((x) => x.start ===
            servingRec.start) };
          if (!t.startTimeRead.allMatch) fail("a start-time read differed");
          t.second = [];
          for (let j = 0; j < SECOND_HUBS; j++) t.second.push(await secondHub(`second-${j}`, palace));
          for (const s of t.second) {
            if (s.exit?.code !== 2 || s.answered || !s.servingSeen) fail(`a second hub: ${JSON.stringify(s)}`);
          }
        }
        const s = await stopHub(h, `start ${kind} ${i}`);
        t.stops.push({ label: h.label, serverinfoMs: s.serverinfoMs, goneMs: s.goneMs, ends: s.ends });
      }
      say(`round ${i + 1}: ${kinds.map((k) => `${k} ${t.starts[k].at(-1)} ms`).join(", ")}`);
    }

    const dead = await freePort();
    const deadChecks = [];
    for (let j = 0; j < HEALTH_CHECKS; j++) {
      const t0 = performance.now();
      if (await healthy(dead)) fail("a dead port answered");
      deadChecks.push(performance.now() - t0);
    }
    t.healthDead = stats(deadChecks);

    t.summary = {
      ...Object.fromEntries(kinds.map((k) => [`start, ${k === "new" ? "new empty palace" : `${k} entries`}`,
        stats(t.starts[k])])),
      "start, every installed start": stats(Object.values(t.starts).flat()),
      "health check, live hub, reused connection": t.healthLive.reusedConnection,
      "health check, live hub, new connection": t.healthLive.newConnection,
      "health check, during a search of the largest palace": t.filler[FILLER_SIZES.at(-1)].healthDuringSearch,
      "health check, during the longest add": t.filler[FILLER_SIZES.at(-1)].healthDuringLongestAdd,
      "health check, dead port": t.healthDead,
      "stopped hub wholly gone": stats(t.stops.map((x) => x.goneMs)),
      "serverinfo.json naming the port, after the first health answer": stats(t.stops.map((x) => x.serverinfoMs)),
      "second hub, exit with code 2": stats(t.second.map((x) => x.exit?.ms)),
      "start-time read": t.startTimeRead,
      "failed lock try (open, try, close)": t.lock.openTryClose,
      "failed lock try, open connection": t.lock.tryOnOpenConnection,
    };
    for (const [k, s] of Object.entries(t.summary)) say(line(k, s));
  } catch (e) {
    fail(`timings: ${e.stack ?? e.message}`);
  } finally {
    await finish();
  }
}

const command = process.argv[2];
if (command === "proof") await proof();
else if (command === "first-starts") await firstStarts();
else if (command === "timings") await timings();
else {
  console.error("usage: node scripts/8d/measure-hub.mjs proof | first-starts | timings");
  process.exitCode = 2;
}
