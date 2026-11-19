// Measurement 2, the exit save's time limit (8d plan, step 10). Not part of Tachikoma: run by hand.
//
//   node scripts/8d/measure-save.mjs scan       the sizes of the user's real typed turns; starts nothing
//   node scripts/8d/measure-save.mjs timings    the save timings, through hubs in the build folder; run between two
//                                               snapshots of the user's folders
//   node scripts/8d/measure-save.mjs first-large  the first save after a start in a 2,000-entry palace (step 10's
//                                               review); run between two snapshots of the user's folders
//   (node scripts/8d/measure-save.mjs saver ... is one of the two savers `timings` starts at once; not run by hand)
//
// The scan reads the user's Tachikoma transcripts under %LOCALAPPDATA%\tachikoma\sessions, read only, and keeps
// lengths and counts alone: no text, no session id and no file name goes into any output or file. It cuts them into
// turns by scripts/8d/turns.mjs and builds each typed turn's entry as the user answered Q4 and Q5 (2026-11-19).
// Subagents' own files (<id>\subagents\*.jsonl) are not read: their messages are never saved (design, section 3).
//
// The timings save made-up filler of the real turns' lengths, never the user's text, the way step 22 will save a
// turn: take the save lock, and for each of the turn's entries (one, or one per part for a turn over 100,000
// characters, Q26) look up its exact label and add it when it is not there; then let go. The save lock is step 2's
// kind (an exclusive node:sqlite transaction on a lock file, here one the script makes in its run folder), tried again
// after the user's 500 ms (M3 decision 5) while another holds it. Every label is sent as `source_file`.
//
// Hubs are started and stopped exactly as step 8 proved (Q24, Q8, Q25): the functions from the helper LISTER down to
// `finish`, and `filler`, are copied unchanged from scripts/8d/measure-hub.mjs (its lines 100-107, 178-306, 330-350,
// 363-396, 398-591, 593-734, 757-798, 800-845 and 1093-1103), except for the names of the run folder and palaces, the
// result line, `startHub`'s audit-hook option, which no hub here uses, and, after step 10's review, the build's
// environment for the helper's self-test child, which inherited the user's TEMP and TMP. Each hub is the build folder's
// `env\Scripts\python.exe -I -m mempalace.mcp_server --transport http --port <p> --palace <palace> --backend
// sqlite_exact`, with MEMPALACE_EMBEDDING_MODEL=minilm, MEMPALACE_MCP_WRITER_WAIT_SECONDS=0 and
// MEMPALACE_MCP_IDLE_HOURS=0, step 1's `install` environment (TEMP and TMP inside the build folder) and step 5's
// offline settings with a dead-end proxy; each is stopped by its serving process's id after its start time is read
// again, and at the end every process this script started is looked up again. Nothing is fetched.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { BUILD, throwaway } from "./throwaway.mjs";
import { cut, turnsOf } from "./turns.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
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

// Set by `init`, at the start of `timings` only, so the scan and the savers make no folder.
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
const palaceDir = (x) => path.join(home, "palaces", `measure-save-${stamp}-${x}`);
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
  runDir = path.join(installDir, `measure-save-${kind}-${stamp}`);
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
  say(out.failures.length ? `measure-save: FAILED (${out.failures.length})` : "measure-save: passed");
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

// ---- the scan of the user's transcripts ----

const SESSIONS = path.join(process.env.LOCALAPPDATA ?? "", "tachikoma", "sessions");
// The longest entry MemPalace accepts (mempalace/config.py:283-291; step 6 item 8); a longer turn is saved in parts of
// at most this many characters (Q26).
const LONGEST_ENTRY = 100_000;
// MemPalace splits an entry into pieces of 800 code points, cut by position (mempalace/config.py:415,
// DEFAULT_CHUNK_SIZE; mempalace/mcp_server/tools_write.py:457-468; step 6 item 8).
const PIECE = 800;
// The join between the typed words and the model's text, and between two pieces of the model's text. Step 22 sets the
// entry's exact layout; this script counts each join as these two characters.
const JOIN = "\n\n";
// NEAR and BANDS only group this report; neither is a setting of Tachikoma's. NEAR: how many turns lie within this
// many characters below the 100,000-character limit, so that a layout a little longer than JOIN's (step 22's) cannot
// change the count over the limit unseen. Its value is the limit's 1 in 100 (100,000 / 100), more than a layout's
// joins would add to any real turn (each join is two characters here; the most pieces of model text in a real turn
// is printed by `scan`).
const NEAR = LONGEST_ENTRY / 100;
// BANDS: the size bands, by MemPalace's pieces of PIECE (800) characters: 1 piece, up to 5, up to 25, up to 125, then
// over the limit, saved in parts. A factor of 5 each, chosen so that four steps from 1 piece end exactly at the cut
// for parts: 125 pieces of 800 is the 100,000-character limit (5 x 5 x 5 = 125). The factor has no other source.
const BANDS = [PIECE, 5 * PIECE, 25 * PIECE, 125 * PIECE];

const codePoints = (s) => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};
const pct = (k, n) => (n ? `${Math.round((k / n) * 1000) / 10}%` : "-");
// The value at a share of the way along a sorted list (0.5 the middle one, rounded down to a place in the list).
const at = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

// The entry a typed turn makes (Q4, Q5): the typed words, then all of the model's text in order.
const entryOf = (turn) => [turn.typed, ...turn.texts].join(JOIN);

// The main transcripts: <sessions>\<project folder>\<id>.jsonl, one level down, plain files only (no link followed).
function transcripts() {
  const files = [];
  for (const d of readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of readdirSync(path.join(SESSIONS, d.name), { withFileTypes: true })) {
      if (f.isFile() && f.name.endsWith(".jsonl")) files.push(path.join(SESSIONS, d.name, f.name));
    }
  }
  return files;
}

// Counts and lengths only. `sessionLengths`: each session's saved entries' lengths, in the session's order, the
// sessions in no particular order and unnamed. `marked`: the typed turns turns.mjs marks (the file ends mid-turn, or
// a call has no result), by mark: how many, how many have model text, and their entries' lengths. They are in every
// save figure, as Q4 saves a turn however it ended (the user's choice, step 10's review); `sessionMarked` counts them
// in each session, beside `sessionLengths`.
function scan() {
  const s = { files: 0, bytes: 0, sessions: 0, notSessions: 0, print: 0, projects: 0, typed: 0, background: 0,
    apart: {}, damagedOutside: 0, typedNoText: 0, saved: 0, lengths: [], codePoints: [], sessionLengths: [],
    sessionMarked: [], typedPerSession: [], overLimit: [], nearLimit: 0, marked: {}, mostTexts: 0 };
  const projects = new Set();
  for (const file of transcripts()) {
    s.files++;
    const text = readFileSync(file, "utf8");
    s.bytes += Buffer.byteLength(text);
    let first;
    try {
      first = JSON.parse(text.slice(0, text.indexOf("\n") >>> 0));
    } catch {}
    if (first?.t !== "start") {
      s.notSessions++;
      continue;
    }
    s.sessions++;
    if (first.print === true) s.print++;
    projects.add(path.dirname(file));
    const r = turnsOf(text);
    s.damagedOutside += r.damagedOutside;
    for (const a of r.apart) {
      const key = `${a.kind}: ${a.reason}`;
      s.apart[key] = (s.apart[key] ?? 0) + 1;
    }
    let typed = r.apart.filter((a) => a.kind === "typed").length;
    const lengths = [];
    let marked = 0;
    for (const t of r.turns) {
      if (t.kind === "background") {
        s.background++;
        continue;
      }
      typed++;
      s.typed++;
      const m = t.mark && (s.marked[t.mark] ??= { turns: 0, withText: 0, lengths: [] });
      if (m) m.turns++;
      if (!t.texts.length) {
        s.typedNoText++;
        continue;
      }
      const entry = entryOf(t);
      if (m) {
        m.withText++;
        m.lengths.push(entry.length);
        marked++;
      }
      s.mostTexts = Math.max(s.mostTexts, t.texts.length);
      lengths.push(entry.length);
      s.codePoints.push(codePoints(entry));
      if (entry.length > LONGEST_ENTRY) {
        s.overLimit.push({ length: entry.length, parts: cut(entry, LONGEST_ENTRY).length });
      } else if (entry.length > LONGEST_ENTRY - NEAR) s.nearLimit++;
    }
    s.typedPerSession.push(typed);
    s.sessionLengths.push(lengths);
    s.sessionMarked.push(marked);
    s.saved += lengths.length;
  }
  s.projects = projects.size;
  s.lengths = s.sessionLengths.flat().sort((a, b) => a - b);
  s.codePoints.sort((a, b) => a - b);
  s.typedPerSession.sort((a, b) => a - b);
  // The sessions by their count of saved turns, each keeping its count of marked turns.
  const order = s.sessionLengths.map((_, i) => i).sort((a, b) => s.sessionLengths[a].length -
    s.sessionLengths[b].length);
  s.sessionLengths = order.map((i) => s.sessionLengths[i]);
  s.sessionMarked = order.map((i) => s.sessionMarked[i]);
  for (const m of Object.values(s.marked)) m.lengths.sort((a, b) => a - b);
  s.overLimit.sort((a, b) => a.length - b.length);
  let below = 0;
  s.bands = [...BANDS, Infinity].map((top) => {
    const k = s.lengths.filter((x) => x > below && x <= top).length;
    const band = { from: below + 1, to: top === Infinity ? null : top, turns: k, share: pct(k, s.saved) };
    below = top;
    return band;
  });
  s.piecesPerEntry = s.codePoints.map((x) => Math.max(1, Math.ceil(x / PIECE)));
  return s;
}

function showScan(s) {
  say(`transcripts read: ${s.files} files, ${s.bytes} bytes; sessions ${s.sessions} (of them -p runs ${s.print}); ` +
    `not sessions ${s.notSessions}; project folders ${s.projects}`);
  say(`turns: typed ${s.typed} rebuilt, background ${s.background}; set apart ${JSON.stringify(s.apart)}; damaged ` +
    `lines before a first turn ${s.damagedOutside}`);
  say(`typed turns with no model text (not saved): ${s.typedNoText}; typed turns that make an entry: ${s.saved}`);
  say(`marked typed turns (in every figure here): ${JSON.stringify(s.marked)}; the most pieces of model text in one ` +
    `entry: ${s.mostTexts}`);
  const L = s.lengths;
  if (L.length) {
    say(`entry length (characters): shortest ${L[0]}, middle ${at(L, 0.5)}, 90th ${at(L, 0.9)}, 99th ${at(L, 0.99)}, ` +
      `longest ${L.at(-1)}; total ${L.reduce((a, b) => a + b, 0)}`);
    say(`pieces per entry: ${JSON.stringify(Object.entries(s.piecesPerEntry.reduce((m, p) => ((m[p] = (m[p] ?? 0) + 1),
      m), {})))}`);
  }
  for (const b of s.bands) say(`  band ${b.from}-${b.to ?? "over"}: ${b.turns} turns (${b.share})`);
  say(`over ${LONGEST_ENTRY}: ${s.overLimit.length} turns ${JSON.stringify(s.overLimit)}; within ${NEAR} below it: ` +
    `${s.nearLimit}`);
  say(`typed turns per session: ${JSON.stringify(s.typedPerSession)}`);
  say(`saved turns per session: ${JSON.stringify(s.sessionLengths.map((x) => x.length))}`);
  say(`marked turns among them: ${JSON.stringify(s.sessionMarked)}`);
  say(`the session with the most saved turns: ${JSON.stringify(s.sessionLengths.at(-1))}`);
}

// ---- the save, as step 22 will do it ----

// Ten runs of each timing, as step 8's starts: ten give a middle and show the spread.
const RUNS = 10;
// The wait between two tries for a held lock: the user's choice at step 8 (M3 decision 5).
const LOCK_WAIT_MS = 500;
const WING = "tachikoma";
// The larger palace: step 8's largest (2,000 entries of 4,000 characters, about 10,000 pieces), where its adds were
// slower than in its 200-entry palace (middle 189.6 ms against 105.6 ms), so the save is timed there too.
const LARGE_ENTRIES = 2_000;
const LARGE_CHARS = 4_000;
// Parts timed when no real turn has more: the plan's 3 (step 10), beside 2.
const FEWEST_MOST_PARTS = 3;

const pieces = (text) => Math.max(1, Math.ceil(codePoints(text) / PIECE));

// A turn's entries: one under its label, or one per part, labelled with the part's number (the plan's draft, step 22).
function entriesOf(label, text) {
  if (text.length <= LONGEST_ENTRY) return [{ label, content: text }];
  const parts = cut(text, LONGEST_ENTRY);
  return parts.map((content, k) => ({ label: `${label}, part ${k + 1} of ${parts.length}`, content }));
}

// Each filler text has a seed of its own, so no two are the same text (MemPalace answers already_exists to a repeat
// in the same room, step 6 item 9). Seeds 1 to LARGE_ENTRIES are the larger palace's own entries.
let seed = LARGE_ENTRIES;
const turnOf = (run, n, length) => ({ label: `tachikoma session measure-save-${run}, turn ${n}`, seed: ++seed,
  length });
const withText = (x) => ({ ...x, text: filler(x.seed, x.length) });

// The save lock, step 2's kind: an exclusive transaction on a lock file, tried again after LOCK_WAIT_MS while held.
async function takeLock(file) {
  const t0 = performance.now();
  for (let tries = 1; ; tries++) {
    const db = new DatabaseSync(file, { timeout: 0 });
    try {
      db.exec("BEGIN EXCLUSIVE");
      return { db, tries, ms: since(t0) };
    } catch (e) {
      db.close();
      if (e.errcode !== 5 && e.errcode !== 6) throw e;
    }
    if (performance.now() - t0 > GIVE_UP_MS) throw new Error("the save lock was not got within the cut-off");
    await sleep(LOCK_WAIT_MS);
  }
}

// One turn saved as step 22 will: the lock; for each entry its exact label looked up (the dry run of removal by
// label, which gives the pieces there); the right number of pieces, nothing to do; another number, removed by that
// label and added again; none, added; then the lock let go.
async function saveTurn(call, lockFile, room, turn) {
  const t0 = performance.now();
  const held = await takeLock(lockFile);
  const r = { lockMs: held.ms, lockTries: held.tries, entries: [] };
  try {
    for (const e of entriesOf(turn.label, turn.text)) {
      const x = { chars: e.content.length, pieces: pieces(e.content) };
      let t = performance.now();
      const look = await call("mempalace_delete_by_source", { source_file: e.label, dry_run: true });
      x.lookupMs = since(t);
      x.found = look.json?.match_count;
      if (typeof x.found !== "number") fail(`a look-up's answer: ${JSON.stringify(look).slice(0, 200)}`);
      if (x.found !== x.pieces) {
        if (x.found > 0) {
          t = performance.now();
          const rm = await call("mempalace_delete_by_source", { source_file: e.label, dry_run: false });
          x.removeMs = since(t);
          if (rm.isError) fail(`a removal's answer: ${JSON.stringify(rm).slice(0, 200)}`);
        }
        t = performance.now();
        const add = await call("mempalace_add_drawer", { wing: WING, room, source_file: e.label,
          content: e.content });
        x.addMs = since(t);
        x.added = add.json?.success === true && !add.json?.reason;
        x.chunks = add.json?.chunks;
        if (!x.added) fail(`an add's answer: ${JSON.stringify(add.json ?? add).slice(0, 200)}`);
        if (x.chunks !== x.pieces) fail(`an add made ${x.chunks} pieces, not ${x.pieces}`);
      }
      r.entries.push(x);
    }
  } finally {
    held.db.close();
  }
  r.ms = since(t0);
  return r;
}

// After the timings, not timed: every entry saved is whole, its label giving exactly the pieces its text makes.
async function verify(call, turns) {
  let entries = 0;
  const wrong = [];
  for (const t of turns) {
    for (const e of entriesOf(t.label, filler(t.seed, t.length))) {
      entries++;
      const look = await call("mempalace_delete_by_source", { source_file: e.label, dry_run: true });
      if (look.json?.match_count !== pieces(e.content)) wrong.push(`${e.label}: ${look.json?.match_count}`);
    }
  }
  if (wrong.length) fail(`entries not whole: ${wrong.slice(0, 5)}`);
  return { entries, wrong: wrong.length };
}

// One of the two savers `twoSavers` starts: connects, builds its texts, says "ready", and on "go" saves the backlog.
async function saver(jobFile, outFile) {
  const job = JSON.parse(readFileSync(jobFile, "utf8"));
  const turns = job.turns.map(withText);
  const { client, call, errors } = await mcpClient(job.port);
  const lines = createInterface({ input: process.stdin });
  const go = new Promise((resolve) => lines.once("line", resolve));
  process.stdout.write("ready\n");
  await go;
  const t0 = performance.now();
  const saved = [];
  for (const t of turns) saved.push(await saveTurn(call, job.lockFile, job.room, t));
  const ms = since(t0);
  await client.close();
  lines.close();
  writeFileSync(outFile, JSON.stringify({ ms, saved, failures: out.failures, transportErrors: errors }));
}

// Two savers, as two windows, through the same backlog at once: two processes, started together, each with its own
// connection to the hub and the same save lock.
async function twoSavers(port, lockFile, room, job, run) {
  const file = path.join(runDir, `savers-${run}.json`);
  writeFileSync(file, JSON.stringify({ port, lockFile, room, turns: job }));
  const kids = [0, 1].map((k) => {
    const outFile = path.join(runDir, `savers-${run}-${k}.out.json`);
    const before = nowUs();
    const child = spawn(process.execPath, [SCRIPT, "saver", file, outFile], { cwd: home, env: processEnv,
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const rec = recordDirect(`saver-${run}-${k}`, child.pid, before, "node.exe (saver)", child);
    rec.child = child;
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const ready = new Promise((resolve, reject) => {
      createInterface({ input: child.stdout }).on("line", (l) => l === "ready" && resolve());
      child.once("exit", (c) => reject(new Error(`a saver ended before it was ready (${c}): ${err.slice(-300)}`)));
    });
    const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    return { child, outFile, ready, exited, err: () => err };
  });
  await Promise.all(kids.map((k) => k.ready));
  const t0 = performance.now();
  for (const k of kids) k.child.stdin.write("go\n");
  const codes = await Promise.all(kids.map((k) => k.exited));
  const wall = since(t0);
  const results = kids.map((k) => JSON.parse(readFileSync(k.outFile, "utf8")));
  codes.forEach((c, k) => c !== 0 && fail(`saver ${run}-${k} exited ${c}: ${kids[k].err().slice(-300)}`));
  for (const r of results) for (const f of r.failures) fail(`a saver: ${f}`);
  const adds = results.flatMap((r) => r.saved.flatMap((s) => s.entries.filter((e) => e.added))).length;
  const there = results.flatMap((r) => r.saved.flatMap((s) => s.entries.filter((e) => e.found === e.pieces))).length;
  return { wall, savers: results.map((r) => r.ms), adds, there, lockTries: results.map((r) =>
    r.saved.reduce((n, s) => n + s.lockTries, 0)) };
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const entryStats = (saves, key) => stats(saves.flatMap((s) => s.entries.map((e) => e[key])));

// One palace: filled with filler entries (not timed as saves), then each timing, on one warm hub.
async function palaceTimings(name, palace, fill, plan) {
  const p = { palace: path.basename(palace) };
  const lockFile = path.join(runDir, `save-${name}.lock`);
  const room = `measure-save-${name}`;
  const h = startHub(`${name}-series`, { palace, port: await freePort() });
  const up = await waitHealthy(h);
  if (!up.ok) throw new Error(`${name}: the hub did not answer: ${tail(h.stderr).join(" | ")}`);
  const { client, call, errors } = await mcpClient(h.port);
  const count = async () => ({
    entries: (await call("mempalace_list_drawers", { wing: WING, room, limit: 1 })).json?.total,
    pieces: (await call("mempalace_status", {})).json?.total_drawers,
  });
  const adds = [];
  for (const [i, x] of fill.entries()) {
    const t0 = performance.now();
    const r = await call("mempalace_add_drawer", { wing: WING, room, source_file: `measure-save ${name} fill ${i}`,
      content: filler(x.seed, x.length) });
    adds.push(performance.now() - t0);
    if (r.json?.success !== true || r.json?.reason) throw new Error(`fill ${i}: ${JSON.stringify(r.json ?? r)}`);
  }
  p.fill = { entries: fill.length, chars: sum(fill.map((x) => x.length)), add: stats(adds), after: await count() };
  say(`${name}: filled, ${JSON.stringify(p.fill)}`);
  const used = [];

  // One turn at a time, at each size.
  p.one = {};
  for (const [size, length] of Object.entries(plan.sizes)) {
    const saves = [];
    for (let i = 0; i < RUNS; i++) {
      const t = turnOf(`${name}-one-${size}-${i}`, 1, length);
      used.push(t);
      saves.push(await saveTurn(call, lockFile, room, withText(t)));
    }
    p.one[size] = { chars: length, total: stats(saves.map((s) => s.ms)), lock: stats(saves.map((s) => s.lockMs)),
      lookup: entryStats(saves, "lookupMs"), add: entryStats(saves, "addMs") };
    say(line(`${name}, one turn of ${length} characters`, p.one[size].total));
  }

  // A backlog: every saved turn of the real session with the most, one after another.
  const backlogs = [];
  for (let i = 0; i < RUNS; i++) {
    const turns = plan.backlog.map((len, k) => turnOf(`${name}-backlog-${i}`, k + 1, len)).map(withText);
    used.push(...turns);
    const t0 = performance.now();
    const saves = [];
    for (const t of turns) saves.push(await saveTurn(call, lockFile, room, t));
    backlogs.push({ ms: since(t0), saves });
  }
  p.backlog = { turns: plan.backlog.length, chars: sum(plan.backlog), total: stats(backlogs.map((b) => b.ms)),
    perTurn: stats(backlogs.flatMap((b) => b.saves.map((s) => s.ms))) };
  say(line(`${name}, a backlog of ${plan.backlog.length} turns`, p.backlog.total));

  // Two savers through the same backlog at once.
  const pairs = [];
  for (let i = 0; i < RUNS; i++) {
    const job = plan.backlog.map((len, k) => turnOf(`${name}-two-${i}`, k + 1, len));
    used.push(...job);
    pairs.push(await twoSavers(h.port, lockFile, room, job, `${name}-${i}`));
  }
  p.twoSavers = { turns: plan.backlog.length, bothDone: stats(pairs.map((x) => x.wall)),
    firstSaver: stats(pairs.map((x) => Math.min(...x.savers))),
    laterSaver: stats(pairs.map((x) => Math.max(...x.savers))),
    addsPerRun: [...new Set(pairs.map((x) => x.adds))], foundTherePerRun: [...new Set(pairs.map((x) => x.there))],
    lockTriesPerRun: pairs.map((x) => x.lockTries) };
  say(line(`${name}, two savers through one backlog, until both are done`, p.twoSavers.bothDone));

  // Turns in parts, each part looked up and added under one hold of the lock.
  p.parts = {};
  for (const n of plan.partCounts) {
    const saves = [];
    for (let i = 0; i < RUNS; i++) {
      const t = turnOf(`${name}-parts-${n}-${i}`, 1, n * LONGEST_ENTRY);
      used.push(t);
      saves.push(await saveTurn(call, lockFile, room, withText(t)));
    }
    p.parts[n] = { chars: n * LONGEST_ENTRY, total: stats(saves.map((s) => s.ms)),
      partLookup: entryStats(saves, "lookupMs"), partAdd: entryStats(saves, "addMs"),
      partsPerTurn: [...new Set(saves.map((s) => s.entries.length))] };
    say(line(`${name}, a turn in ${n} parts of ${LONGEST_ENTRY} characters`, p.parts[n].total));
  }

  p.verify = await verify(call, used);
  p.after = await count();
  p.backend = (await call("mempalace_status", {})).json?.backend;
  p.statusz = await statusz(h.port);
  p.transportErrors = [...new Set(errors)];
  await client.close();
  p.stop = (await stopHub(h, `${name}: timings done`)).goneMs;
  p.model = palaceModel(palace);
  if (p.backend !== "sqlite_exact" || p.statusz.backend !== "sqlite_exact" || p.model !== "minilm") {
    fail(`${name}: backend ${p.backend} / ${p.statusz.backend}, model ${p.model}`);
  }
  return p;
}

// The first save after a hub starts, as a -p run's only turn meets it: a new hub on the palace, connected, one turn
// of the longest real size saved, then the hub stopped; each run a start of its own. With `second`, one more turn of
// the same size is saved on the same hub just after the first, so each run also gives a warm save in the same palace
// at the same size (step 10's review: the first figures compared palaces of different sizes).
async function firstSaves(palace, length, room, { second = false } = {}) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const h = startHub(`first-${i}`, { palace, port: await freePort() });
    const up = await waitHealthy(h);
    if (!up.ok) {
      fail(`first save ${i}: the hub did not answer: ${tail(h.stderr).join(" | ")}`);
      await look();
      for (const x of procs.filter((y) => y.label === h.label && y.goneBy == null)) await stopRec(x, [x], "failed");
      continue;
    }
    let t0 = performance.now();
    const { client, call } = await mcpClient(h.port);
    const connectMs = since(t0);
    const t = withText(turnOf(`first-${i}`, 1, length));
    const lockFile = path.join(runDir, "save-first.lock");
    const s = await saveTurn(call, lockFile, room, t);
    const t2 = second ? withText(turnOf(`first-${i}`, 2, length)) : null;
    const s2 = t2 ? await saveTurn(call, lockFile, room, t2) : null;
    const v = await verify(call, t2 ? [t, t2] : [t]);
    await client.close();
    const stop = await stopHub(h, `first save ${i}`);
    runs.push({ startMs: up.ms, connectMs, saveMs: s.ms, lookupMs: s.entries[0].lookupMs, addMs: s.entries[0].addMs,
      secondSaveMs: s2?.ms, secondAddMs: s2?.entries[0].addMs, whole: v.wrong === 0, stopMs: stop.goneMs });
    say(`first save ${i + 1}: start ${up.ms} ms, connect ${connectMs} ms, save ${s.ms} ms` +
      (s2 ? `, then a second save ${s2.ms} ms` : ""));
  }
  return { chars: length, runs: runs.length, start: stats(runs.map((r) => r.startMs)),
    connect: stats(runs.map((r) => r.connectMs)), save: stats(runs.map((r) => r.saveMs)),
    lookup: stats(runs.map((r) => r.lookupMs)), add: stats(runs.map((r) => r.addMs)),
    connectAndSave: stats(runs.map((r) => r.connectMs + r.saveMs)), allWhole: runs.every((r) => r.whole),
    ...(second ? { secondSave: stats(runs.map((r) => r.secondSaveMs)), secondAdd: stats(runs.map((r) =>
      r.secondAddMs)) } : {}) };
}

// The first save after a start in a palace of LARGE_ENTRIES entries (step 10's review): a new palace filled as the
// "large" one of `timings` (the hub then stopped), then RUNS first saves after a start, each with a second save.
async function firstLarge() {
  const t = (out.firstLarge = {});
  try {
    const s = scan();
    const L = s.lengths;
    if (!L.length) throw new Error("no real typed turn to take sizes from");
    out.scan = { ...s, lengths: L };
    init();
    await setUp("first-large");
    const palace = palaceDir("large");
    const room = "measure-save-large";
    const h = startHub("large-fill", { palace, port: await freePort() });
    const up = await waitHealthy(h);
    if (!up.ok) throw new Error(`the filling hub did not answer: ${tail(h.stderr).join(" | ")}`);
    const { client, call } = await mcpClient(h.port);
    const adds = [];
    for (let i = 0; i < LARGE_ENTRIES; i++) {
      const t0 = performance.now();
      const r = await call("mempalace_add_drawer", { wing: WING, room, source_file: `measure-save large fill ${i}`,
        content: filler(i + 1, LARGE_CHARS) });
      adds.push(performance.now() - t0);
      if (r.json?.success !== true || r.json?.reason) throw new Error(`fill ${i}: ${JSON.stringify(r.json ?? r)}`);
    }
    t.fill = { entries: LARGE_ENTRIES, chars: LARGE_CHARS, add: stats(adds),
      entriesInPalace: (await call("mempalace_list_drawers", { wing: WING, room, limit: 1 })).json?.total,
      pieces: (await call("mempalace_status", {})).json?.total_drawers };
    await client.close();
    t.fillStop = (await stopHub(h, "large: filled")).goneMs;
    say(`large: filled, ${JSON.stringify(t.fill)}`);
    t.first = await firstSaves(palace, L.at(-1), room, { second: true });
    for (const [k, v] of Object.entries(t.first)) if (v?.n) say(line(`large, first save after a start, ${k}`, v));
    const h2 = startHub("large-check", { palace, port: await freePort() });
    if (!(await waitHealthy(h2)).ok) throw new Error("the checking hub did not answer");
    const c2 = await mcpClient(h2.port);
    t.after = { entries: (await c2.call("mempalace_list_drawers", { wing: WING, room, limit: 1 })).json?.total,
      backend: (await c2.call("mempalace_status", {})).json?.backend, statusz: await statusz(h2.port) };
    await c2.client.close();
    t.checkStop = (await stopHub(h2, "large: checked")).goneMs;
    t.model = palaceModel(palace);
    say(`large: after, ${JSON.stringify(t.after)}, model ${t.model}`);
    if (t.after.backend !== "sqlite_exact" || t.after.statusz.backend !== "sqlite_exact" || t.model !== "minilm") {
      fail(`large: backend ${t.after.backend} / ${t.after.statusz.backend}, model ${t.model}`);
    }
  } catch (e) {
    fail(`first-large: ${e.stack ?? e.message}`);
  } finally {
    if (lister) await finish();
    else {
      say(`measure-save: FAILED (${out.failures.length})`);
      process.exitCode = 1;
    }
  }
}

async function timings() {
  const t = (out.timings = {});
  try {
    const s = scan();
    const L = s.lengths;
    if (!L.length) throw new Error("no real typed turn to take sizes from");
    out.scan = { ...s, lengths: L };
    init();
    await setUp("timings");
    const plan = (t.plan = {
      sizes: { middle: at(L, 0.5), "90th": at(L, 0.9), longest: L.at(-1) },
      backlog: s.sessionLengths.at(-1),
      partCounts: [2, Math.max(FEWEST_MOST_PARTS, ...s.overLimit.map((x) => x.parts))],
      runs: RUNS,
    });
    say(`plan: ${JSON.stringify(plan)}`);
    // The palace as the user's transcripts would make it today: one filler entry per real saved typed turn, at its
    // length; then the timings, then the first saves after a start on it (so on the palace the timings had grown).
    const today = palaceDir("today");
    const fillToday = s.sessionLengths.flat().map((length, i) => ({ seed: LARGE_ENTRIES + 100_000 + i, length }));
    t.today = await palaceTimings("today", today, fillToday, plan);
    t.first = await firstSaves(today, plan.sizes.longest, "measure-save-today");
    for (const [k, v] of Object.entries(t.first)) if (v?.n) say(line(`first save after a start, ${k}`, v));
    const large = palaceDir("large");
    const fillLarge = Array.from({ length: LARGE_ENTRIES }, (_, i) => ({ seed: i + 1, length: LARGE_CHARS }));
    t.large = await palaceTimings("large", large, fillLarge, plan);
  } catch (e) {
    fail(`timings: ${e.stack ?? e.message}`);
  } finally {
    if (lister) await finish();
    else {
      say(`measure-save: FAILED (${out.failures.length})`);
      process.exitCode = 1;
    }
  }
}

const command = process.argv[2];
if (command === "scan") showScan(scan());
else if (command === "timings") await timings();
else if (command === "first-large") await firstLarge();
else if (command === "saver") await saver(process.argv[3], process.argv[4]);
else {
  console.error("usage: node scripts/8d/measure-save.mjs scan | timings | first-large");
  process.exitCode = 2;
}
