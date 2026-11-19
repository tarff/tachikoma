// Measurement 6, the note's count and cut-off, from the transcripts (8d plan, step 14). Not part of Tachikoma: run by
// hand, between two snapshots of the user's folders.
//
//   node scripts/8d/measure-note.mjs scan    the user's transcripts read and cut into turns; counts only, starts
//                                            nothing
//   node scripts/8d/measure-note.mjs check   the whole run on made-up sessions written in this script (never the
//                                            user's), its counts checked against the ones expected, before any text of
//                                            the user's goes into a palace
//   node scripts/8d/measure-note.mjs run     the whole run on the user's transcripts
//
// The user's Tachikoma transcripts (%LOCALAPPDATA%\tachikoma\sessions\<project folder>\<id>.jsonl) are read only.
// Subagents' own files (<id>\subagents\*.jsonl) are not read: their messages are never saved (design, section 3). They
// are cut into turns by scripts/8d/turns.mjs (step 10's rule), and each typed turn makes an entry as step 22 will make
// it, by the user's answers to Q4 and Q5: the typed words, then all of the model's text in order, joined as step 10's
// scan joins them; a turn over 100,000 characters goes in as parts (Q26), cut by turns.mjs's `cut`. Background turns,
// typed turns with no model text, and turns set apart make no entry, as live they make none, and are counted. A
// `/branch` copy's copied turns make no entry either (the user's rule after step 12: the copied turns are left out),
// found as scripts/8d/measure-lesson-ask.mjs finds them, and are counted.
//
// The palace is in the build folder: wing `tachikoma`, one room per project folder. The entries go in, and the first
// prompts are searched, in time order, so each search finds the palace as it stood when that prompt was sent: every
// entry of a turn that ended before it, in any session, and nothing of the prompt's own session (its first prompt
// comes before any of its turns end). Each session's first prompt (its first typed turn's words, cut to 250 characters
// as step 24 will cut them) searches its own project's room, and, for the comparison, each other project's room. A
// branch's copy has no first prompt of its own: its next prompt is a fork's (src/cli.tsx:814,
// src/tui/app/queue.ts:833), and the note is never made for a fork (step 24).
//
// Nothing of the user's text goes into any output or file of this script's: no text, no session id, no file or folder
// name. The palace's labels and rooms are stand-ins (`tachikoma session s<k>, turn <n>`, `project-<k>`); the real
// lengths of a label and a room name are kept as numbers only, for the note's length. Only counts, lengths and scores
// are printed and saved. While the user's text is handled, an error says its name alone. The palace is deleted by its
// exact name when its hub has stopped; MemPalace's own write log redacts content and queries (mempalace/wal.py:28-29,
// :92-93).
//
// Hubs are started and stopped exactly as step 8 proved (Q24, Q8, Q25). The functions from PYTHON down to `finish`,
// `removeTree`, and `sortNum`, `nearest` and `spread` are copied unchanged from scripts/8d/measure-lessons.mjs (its
// lines 59-712, 1151-1166 and 1007-1015), except for the names of the run folder and palaces and the result line. That
// script cannot be imported for them: they are not exported, and importing it runs its own commands. Each hub is the
// build folder's `env\Scripts\python.exe -I -m mempalace.mcp_server --transport http --port <p> --palace <palace>
// --backend sqlite_exact`, with MEMPALACE_EMBEDDING_MODEL=minilm, MEMPALACE_MCP_WRITER_WAIT_SECONDS=0 and
// MEMPALACE_MCP_IDLE_HOURS=0, step 1's `install` environment (TEMP and TMP inside the build folder) and step 5's
// offline settings with a dead-end proxy; it is stopped by its serving process's id after its start time is read
// again, and at the end every process this script started is looked up again. Nothing is fetched.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync,
  writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { BUILD, throwaway } from "./throwaway.mjs";
import { cut, turnsOf } from "./turns.mjs";
import { QUERY_MAX } from "./lesson-query.mjs";

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
const palaceDir = (x) => path.join(home, "palaces", `measure-note-${stamp}-${x}`);
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
  runDir = path.join(installDir, `measure-note-${kind}-${stamp}`);
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
  say(out.failures.length ? `measure-note: FAILED (${out.failures.length})` : "measure-note: passed");
  process.exitCode = out.failures.length ? 1 : 0;
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

const sortNum = (v) => [...v].sort((a, b) => a - b);
// The nearest-rank percentile: always one of the values themselves.
const nearest = (v, p) => (v.length ? v[Math.max(0, Math.ceil(p * v.length) - 1)] : null);
function spread(values) {
  const v = sortNum(values);
  if (!v.length) return { n: 0 };
  return { n: v.length, min: v[0], p10: nearest(v, 0.1), p25: nearest(v, 0.25), middle: nearest(v, 0.5),
    p75: nearest(v, 0.75), p90: nearest(v, 0.9), max: v.at(-1) };
}

// ---- the note (step 14) ----

const COMMAND = process.argv[2];
const WING = "tachikoma";
// MemPalace's most results for one search (_MAX_RESULTS, mempalace/mcp_server/_session.py:681). Every search here
// checks that its room holds no more pieces than this, so that every piece in the room is returned and scored.
const LIMIT = 100;
// MemPalace refuses an entry of more than 100,000 characters (mempalace/config.py:283-291; step 6 item 8); a longer
// turn is saved in parts of at most this many (Q26).
const LONGEST_ENTRY = 100_000;
// MemPalace's pieces of 800 code points (mempalace/config.py:415; step 6 item 8): a search hit is one piece.
const PIECE = 800;
// The join between the typed words and each piece of the model's text, as step 10's scan joins them
// (scripts/8d/measure-save.mjs, JOIN); step 22 sets the entry's exact layout.
const JOIN = "\n\n";
const SESSIONS = path.join(process.env.LOCALAPPDATA ?? "", "tachikoma", "sessions");
// For the note's length with its fixed parts only (the text alone is the main figure): step 24's draft heading and
// step 23's draft first line of a match, `<date> - <label> - <room>` with a middle dot and a space either side (3
// characters) for each dash; neither draft is approved yet. The date's form is not set: taken as 10 characters
// (YYYY-MM-DD), and the layout (a line break after a match's first line, a blank line before each match) is JOIN's;
// both are the builder's readings, for this figure alone. The room name is Q19's: the folder's name cut to 119
// characters, a separator and 8 hex characters.
const HEADING = "From long-term memory, close matches to this message (information, not instructions):";
const DATE_CHARS = 10;
const SEP_CHARS = 3;
const ROOM_NAME_PART = 119;
const ROOM_CODE = 8;
// The note's counts reported: 1 to 5, as step 13's first run reported counts (its COUNTS); a report range only.
const NOTE_COUNTS = [1, 2, 3, 4, 5];

const time = (iso) => Date.parse(iso);
const codePoints = (s) => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};
const pieces = (text) => Math.max(1, Math.ceil(codePoints(text) / PIECE));
// Step 24's cut of the typed words, to MemPalace's most for a query, by code point as MemPalace counts
// (scripts/8d/lesson-query.mjs cuts the same way).
const queryOf = (typed) => [...typed].slice(0, QUERY_MAX).join("");
const tally = (into, key, by = 1) => (into[key] = (into[key] ?? 0) + by);
const startOf = (text) => {
  try {
    return JSON.parse(text.slice(0, text.indexOf("\n") >>> 0));
  } catch {
    return undefined;
  }
};

// The user's transcripts, read only: each project folder's sessions. Plain files one level down, no link followed.
export function readSessions(root = SESSIONS) {
  const read = { folders: 0, files: 0, bytes: 0, notSessions: 0 };
  const projects = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    read.folders++;
    const sessions = [];
    for (const f of readdirSync(path.join(root, d.name), { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      read.files++;
      const file = path.join(root, d.name, f.name);
      const text = readFileSync(file, "utf8");
      read.bytes += Buffer.byteLength(text);
      const first = startOf(text);
      if (first?.t !== "start") {
        read.notSessions++;
        continue;
      }
      sessions.push({ text, id: String(first.id ?? ""), at: first.at, print: first.print === true,
        project: String(first.project ?? ""), born: statSync(file).birthtimeMs });
    }
    projects.push({ sessions });
  }
  return { read, projects };
}

// The entries and the first prompts. A project is a project folder (one per project path, src/core/sessions.ts:13-18),
// and its room. Within a folder the sessions are ordered by their start line's time, then by when the file was made;
// a session whose start time another one already has is a branch's copy (as scripts/8d/measure-lesson-ask.mjs finds
// them), and its turns whose first line the earlier one holds are the copied turns, which make no entry.
export function build(projects) {
  const c = { projects: projects.length, sessions: 0, print: 0, mixedFolders: 0, branchCopies: 0,
    copied: { typed: 0, background: 0 }, typed: 0, background: 0, apart: {}, damagedOutside: 0, marked: {},
    typedNoText: 0, turnsSaved: 0, inParts: 0, mostParts: 0, entries: 0, firstPrompts: 0, firstSetApart: 0,
    noTypedTurn: 0, cut: 0, withPicture: 0, noEarlierSession: 0 };
  const entries = [];
  const prompts = [];
  let k = 0;
  for (const [p, proj] of projects.entries()) {
    const room = `project-${String(p + 1).padStart(2, "0")}`;
    if (new Set(proj.sessions.map((s) => s.project)).size > 1) c.mixedFolders++;
    const sessions = [...proj.sessions].sort((a, b) => time(a.at) - time(b.at) || a.born - b.born);
    const groups = new Map();
    for (const s of sessions) {
      c.sessions++;
      k++;
      if (s.print) c.print++;
      const copied = groups.get(s.at);
      if (copied) c.branchCopies++;
      const r = turnsOf(s.text);
      c.damagedOutside += r.damagedOutside;
      for (const a of r.apart) tally(c.apart, `${a.kind}: ${a.reason}`);
      const starts = r.turns.map((t) => JSON.stringify(t.lines[0]));
      groups.set(s.at, new Set([...(copied ?? []), ...starts]));
      // The real lengths of a match's label and room name, as numbers only.
      const roomChars = Math.min(codePoints(path.basename(s.project)), ROOM_NAME_PART) + 1 + ROOM_CODE;
      const labelChars = (n) => `tachikoma session , turn ${n}`.length + s.id.length;
      for (const [i, t] of r.turns.entries()) {
        if (copied?.has(starts[i])) {
          c.copied[t.kind]++;
          continue;
        }
        c[t.kind]++;
        if (t.kind !== "typed") continue;
        if (t.mark) tally(c.marked, t.mark);
        if (!t.texts.length) {
          c.typedNoText++;
          continue;
        }
        const text = [t.typed, ...t.texts].join(JOIN);
        const parts = text.length > LONGEST_ENTRY ? cut(text, LONGEST_ENTRY) : [text];
        c.turnsSaved++;
        if (parts.length > 1) c.inParts++;
        c.mostParts = Math.max(c.mostParts, parts.length);
        for (const [j, content] of parts.entries()) {
          const suffix = parts.length > 1 ? `, part ${j + 1} of ${parts.length}` : "";
          entries.push({ room, turn: c.turnsSaved, label: `tachikoma session s${k}, turn ${t.n}${suffix}`, content,
            end: t.lines.at(-1).at, chars: content.length,
            headChars: DATE_CHARS + SEP_CHARS + labelChars(t.n) + suffix.length + SEP_CHARS + roomChars });
        }
      }
      if (copied) continue;
      const first = r.turns.find((t) => t.kind === "typed" && t.n === 1);
      if (!first) {
        if (r.apart.some((a) => a.kind === "typed" && a.n === 1)) c.firstSetApart++;
        else c.noTypedTurn++;
        continue;
      }
      c.firstPrompts++;
      if (codePoints(first.typed) > QUERY_MAX) c.cut++;
      if (/\[Image #\d+\]/.test(first.typed)) c.withPicture++;
      const at = first.lines[0].at;
      const earlier = sessions.filter((o) => o !== s && time(o.at) < time(at)).length;
      if (!earlier) c.noEarlierSession++;
      prompts.push({ room, at, query: queryOf(first.typed), chars: codePoints(first.typed), earlier });
    }
  }
  c.entries = entries.length;
  const byRoom = {};
  for (const e of entries) tally(byRoom, e.room, pieces(e.content));
  c.piecesByRoom = Object.values(byRoom).sort((a, b) => a - b);
  c.promptChars = spread(prompts.map((x) => x.chars));
  return { counts: c, entries, prompts };
}

// ---- made-up sessions for `check`: written for this script, never taken from the user's transcripts ----

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const stampAt = (min, s) => new Date(T0 + min * 60_000 + s * 1000).toISOString();
const startLine = (id, min, project) => ({ t: "start", at: stampAt(min, 0), v: 1, id, project, lead: "x",
  version: "0", print: false, system: "", tools: [] });
const say1 = (role, parts, min, s) => ({ t: "message", at: stampAt(min, s), message: { role, parts } });
const user = (text, min, s, more = []) => say1("user", [{ type: "text", text }, ...more], min, s);
const background = (text, min, s) => say1("user", [{ type: "text", text, from: "tasks" }], min, s);
const reply = (text, min, s, calls = []) => say1("assistant", [...(text ? [{ type: "text", text }] : []),
  ...calls.map((id) => ({ type: "tool_call", id, name: "shell", input: { command: `ls ${id}` } }))], min, s);
const results = (ids, min, s) => say1("user", ids.map((id) => ({ type: "tool_result", callId: id, output: "ok",
  isError: false })), min, s);
const fileOf = (lines) => `${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`;
const FILLER_WORDS = ["the", "report", "covers", "each", "step", "of", "checkout", "cart", "page", "order", "test",
  "build", "folder", "answer", "module", "price", "list", "item"];
function filler(n) {
  let s = "";
  let x = 12345;
  while (s.length < n) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    s += `${FILLER_WORDS[x % FILLER_WORDS.length]} `;
  }
  return s.slice(0, n);
}

function madeUp() {
  const s2 = [startLine("m2", 60, "/made-up/alpha"),
    user("How do I run the cart tests again?", 60, 1), reply("The same as before: npm test in the cart folder.", 60, 2),
    background("The background build finished.", 60, 3), reply("The build passed.", 60, 4),
    user("List the files in the cart folder.", 60, 5), reply("", 60, 6, ["c1"]), results(["c1"], 60, 7),
    reply("", 60, 8)];
  const s3 = [{ ...s2[0], id: "m3" }, ...s2.slice(1), user("Try the branch without the cache.", 90, 0),
    reply("Without the cache the tests take longer but pass.", 90, 1)];
  const longPrompt = `${"Look at the checkout page in this picture and say what is wrong with the layout. ".repeat(4)
    }`.slice(0, 300);
  const alpha = [
    { at: 0, born: 1, lines: [startLine("m1", 0, "/made-up/alpha"),
      user("How do I run the tests for the cart module?", 0, 1),
      reply("Run npm test from the cart folder; the tests live in cart/test.", 0, 2),
      user("And the linter?", 0, 3), reply("Use npm run lint.", 0, 4)] },
    { at: 60, born: 2, lines: s2 },
    { at: 60, born: 3, lines: s3 },
    { at: 120, born: 4, lines: [startLine("m4", 120, "/made-up/alpha"),
      user(longPrompt, 120, 1, [{ type: "image", id: 1 }]),
      reply("The picture shows the checkout page with the total cut off.", 120, 2),
      user("And the linter?", 120, 3), reply("Use npm run lint.", 120, 4),
      user("Write the long report.", 120, 5), reply(filler(100_500), 120, 6)] },
    { at: 180, born: 5, lines: [startLine("m5", 180, "/made-up/alpha"),
      user("This turn has a damaged line.", 180, 1), "this line is not JSON", reply("Damaged.", 180, 2),
      user("Second turn after the damage.", 180, 3), reply("Fine now.", 180, 4)] },
  ];
  const beta = [
    { at: 30, born: 6, lines: [startLine("m6", 30, "/made-up/beta"),
      user("Which variable holds the weather service key?", 30, 1), reply("WEATHER_KEY in the .env file.", 30, 2)] },
    { at: 240, born: 7, lines: [startLine("m7", 240, "/made-up/beta"),
      user("How do I run the tests for the cart module?", 240, 1),
      reply("This project has no cart module.", 240, 2)] },
  ];
  const gamma = [{ at: 200, born: 8, lines: [startLine("m8", 200, "/made-up/gamma")] }];
  const projects = [alpha, beta, gamma].map((list) => ({ sessions: list.map((x) => {
    const text = fileOf(x.lines);
    const first = startOf(text);
    return { text, id: first.id, at: first.at, print: false, project: first.project, born: x.born };
  }) }));
  return { read: { madeUp: true }, projects };
}

// What `check` must find, worked out by hand from the made-up sessions above.
const EXPECT_BUILD = { projects: 3, sessions: 8, print: 0, mixedFolders: 0, branchCopies: 1,
  copied: { typed: 2, background: 1 }, typed: 11, background: 1, apart: { "typed: damaged line": 1 },
  damagedOutside: 0, marked: {}, typedNoText: 1, turnsSaved: 10, inParts: 1, mostParts: 2, entries: 11,
  firstPrompts: 5, firstSetApart: 1, noTypedTurn: 1, cut: 1, withPicture: 1, noEarlierSession: 2 };
const EXPECT_RUN = { added: 10, alreadyExists: 1, addFailed: 0, piecesWrong: 0, searches: 7, overLimit: 1,
  failed: 0, notReturned: 0, otherRoom: 0, unknownHits: 0, ownNone: 2, withOwn: 3, sizeEntries: 10,
  sizePieces: 134 };
function expectAll(got, want, what) {
  for (const [key, value] of Object.entries(want)) {
    if (JSON.stringify(got[key]) !== JSON.stringify(value)) {
      fail(`check ${what}: ${key} is ${JSON.stringify(got[key])}, expected ${JSON.stringify(value)}`);
    }
  }
}

// ---- the run: entries added and first prompts searched in time order ----

const palaces = [];
async function measureNote(kind, entries, prompts) {
  const r = {};
  const palace = palaceDir(kind);
  if (existsSync(palace)) throw new Error("the palace folder is there already");
  palaces.push(palace);
  const h = startHub(kind, { palace, port: await freePort() });
  const up = await waitHealthy(h);
  if (!up.ok) throw new Error("the hub did not answer");
  r.startMs = up.ms;
  const { client, call, errors } = await mcpClient(h.port);
  // At one time, the search goes first: an entry is in the palace only once its turn has ended.
  const events = [...entries.map((e, i) => ({ t: time(e.end), search: false, i })),
    ...prompts.map((x, i) => ({ t: time(x.at), search: true, i }))]
    .sort((a, b) => a.t - b.t || Number(b.search) - Number(a.search) || a.i - b.i);
  const rooms = new Map();
  const byLabel = new Map();
  const add = { added: 0, alreadyExists: 0, failed: 0, piecesWrong: 0, pieces: {} };
  const q = { searches: 0, failed: 0, overLimit: 0, notReturned: 0, tooMany: 0, otherRoom: 0, unknownHits: 0,
    noDistance: 0, folded: 0, boosted: 0, sanitized: 0, changedBySanitizer: 0 };
  // One search of one room: each hit's distance, the length of its text (a piece) and its entry. The hit's text is
  // read for its length alone.
  const search = async (query, room) => {
    q.searches++;
    const want = rooms.get(room);
    if (want > LIMIT) q.overLimit++;
    const s = await call("mempalace_search", { query, wing: WING, room, limit: LIMIT });
    const hits = s.json?.results;
    if (s.isError || s.json?.error || !Array.isArray(hits)) {
      q.failed++;
      return [];
    }
    if (s.json.query_sanitized) q.sanitized++;
    if (s.json.query_sanitized && s.json.sanitizer?.clean_query !== query) q.changedBySanitizer++;
    const got = [];
    let seen = 0;
    for (const x of hits) {
      if (x.room !== room) q.otherRoom++;
      const e = byLabel.get(x.source_path);
      if (e === undefined) {
        q.unknownHits++;
        continue;
      }
      // MemPalace folds a piece whose text another entry also has into one hit (also_in,
      // mempalace/searcher/candidates.py:182-215).
      const also = Array.isArray(x.also_in) ? x.also_in.length : 0;
      q.folded += also;
      seen += 1 + also;
      if (typeof x.distance !== "number") {
        q.noDistance++;
        continue;
      }
      if (x.effective_distance !== x.distance) q.boosted++;
      got.push({ d: x.distance, chars: typeof x.text === "string" ? x.text.length : 0, entry: e,
        turn: entries[e].turn });
    }
    if (want <= LIMIT && seen < want) q.notReturned += want - seen;
    if (seen > want) q.tooMany++;
    return got;
  };
  const t0 = performance.now();
  for (const ev of events) {
    if (!ev.search) {
      const e = entries[ev.i];
      const a = await call("mempalace_add_drawer", { wing: WING, room: e.room, source_file: e.label,
        content: e.content });
      if (a.json?.success === true && a.json.reason === "already_exists") add.alreadyExists++;
      else if (a.json?.success === true && !a.json.reason && typeof a.json.chunks === "number") {
        add.added++;
        tally(add.pieces, a.json.chunks);
        if (a.json.chunks !== pieces(e.content)) add.piecesWrong++;
        rooms.set(e.room, (rooms.get(e.room) ?? 0) + a.json.chunks);
        byLabel.set(e.label, ev.i);
      } else add.failed++;
      continue;
    }
    const x = prompts[ev.i];
    x.own = rooms.get(x.room) ? await search(x.query, x.room) : null;
    x.others = [];
    x.otherRooms = 0;
    for (const room of rooms.keys()) {
      if (room === x.room) continue;
      x.otherRooms++;
      x.others.push(...(await search(x.query, room)));
    }
  }
  r.eventsMs = since(t0);
  r.add = add;
  r.queries = q;
  r.size = { entries: (await call("mempalace_list_drawers", { wing: WING, limit: 1 })).json?.total,
    pieces: (await call("mempalace_status", {})).json?.total_drawers };
  r.backend = (await call("mempalace_status", {})).json?.backend;
  r.statusz = await statusz(h.port);
  r.transportErrors = errors.length;
  await client.close();
  r.stopMs = (await stopHub(h, `${kind}: measured`)).goneMs;
  r.model = palaceModel(palace);
  if (r.backend !== "sqlite_exact" || r.statusz.backend !== "sqlite_exact" || r.model !== "minilm") {
    fail(`backend ${r.backend} / ${r.statusz.backend}, model ${r.model}`);
  }
  const stored = [...rooms.values()].reduce((a, b) => a + b, 0);
  if (r.size.entries !== add.added || r.size.pieces !== stored) {
    fail(`the palace holds ${r.size.entries} entries in ${r.size.pieces} pieces, not ${add.added} in ${stored}`);
  }
  if (add.failed || add.piecesWrong) fail(`adds ${JSON.stringify(add)}`);
  if (q.failed || q.notReturned || q.tooMany || q.otherRoom || q.unknownHits || q.noDistance) {
    fail(`searches ${JSON.stringify(q)}`);
  }
  if (kind === "real" && q.overLimit) fail(`${q.overLimit} searches of a room of more than ${LIMIT} pieces`);
  return r;
}

// ---- the figures: scores and lengths only ----

const byDistance = (a, b) => a.d - b.d || a.entry - b.entry;
function figures(entries, prompts) {
  for (const x of prompts) {
    x.own?.sort(byDistance);
    x.others?.sort(byDistance);
  }
  const withOwn = prompts.filter((x) => x.own);
  const withOthers = prompts.filter((x) => x.others?.length);
  const same = withOwn.flatMap((x) => x.own.map((h) => h.d));
  const sameNearest = withOwn.filter((x) => x.own.length).map((x) => x.own[0].d);
  const other = withOthers.flatMap((x) => x.others.map((h) => h.d));
  const otherNearest = withOthers.map((x) => x.others[0].d);
  // A note of the hits given, closest first: the hits' text alone; and with the heading and each match's first line.
  const note = (hits) => ({ text: hits.reduce((n, h) => n + h.chars, 0), whole: HEADING.length +
    hits.reduce((n, h) => n + JOIN.length + entries[h.entry].headChars + 1 + h.chars, 0) });
  // The other reading: each match shown as its whole entry (a part, for a turn in parts), each entry once.
  const asEntries = (hits) => [...new Set(hits.map((h) => h.entry))];
  const sv = sortNum(sameNearest);
  const ov = sortNum(other);
  const list = [["same, nearest: 25th", nearest(sv, 0.25)], ["same, nearest: middle", nearest(sv, 0.5)],
    ["same, nearest: 75th", nearest(sv, 0.75)], ["same, nearest: 90th", nearest(sv, 0.9)],
    ["same, nearest: largest", sv.at(-1)], ["other: smallest", ov[0]], ["other: 1st", nearest(ov, 0.01)],
    ["other: 5th", nearest(ov, 0.05)], ["other: 10th", nearest(ov, 0.1)], ["other: 25th", nearest(ov, 0.25)]]
    .filter(([, d]) => d !== null && d !== undefined);
  const cand = new Map();
  for (const [from, d] of list) cand.set(d, [...(cand.get(d) ?? []), from]);
  const cutoffs = [...cand].sort(([x], [y]) => x - y).map(([x, from]) => {
    const inside = (hits) => hits.filter((h) => h.d <= x);
    const own = withOwn.map((p) => inside(p.own));
    const others = withOthers.map((p) => inside(p.others));
    return { x, from,
      same: { inside: own.reduce((n, h) => n + h.length, 0), of: same.length, prompts: own.filter((h) => h.length)
        .length, perPrompt: spread(own.map((h) => h.length)), entriesMost: Math.max(0, ...own.map((h) =>
        asEntries(h).length)) },
      other: { inside: others.reduce((n, h) => n + h.length, 0), of: other.length, prompts: others
        .filter((h) => h.length).length, perPrompt: spread(others.map((h) => h.length)) },
      notes: [1, 2, 3].map((count) => {
        const lens = own.filter((h) => h.length).map((h) => note(h.slice(0, count)).text);
        return { count, prompts: lens.length, text: spread(lens) };
      }) };
  });
  const lengths = NOTE_COUNTS.map((count) => {
    const hit = withOwn.filter((p) => p.own.length >= count).map((p) => note(p.own.slice(0, count)));
    const whole = withOwn.map((p) => asEntries(p.own)).filter((e) => e.length >= count)
      .map((e) => e.slice(0, count).reduce((n, i) => n + entries[i].chars, 0));
    return { count, prompts: hit.length, text: spread(hit.map((n) => n.text)), whole: spread(hit.map((n) => n.whole)),
      entries: { prompts: whole.length, chars: spread(whole) } };
  });
  return {
    prompts: { all: prompts.length, withOwn: withOwn.length, ownNone: prompts.length - withOwn.length,
      ownNoneEarlierSession: prompts.filter((p) => !p.own && p.earlier).length, withOthers: withOthers.length,
      ownHitsPerPrompt: spread(withOwn.map((p) => p.own.length)),
      ownEntriesPerPrompt: spread(withOwn.map((p) => asEntries(p.own).length)) },
    spreads: { same: spread(same), sameNearest: spread(sameNearest), other: spread(other),
      otherNearest: spread(otherNearest) },
    cutoffs, lengths, headingChars: HEADING.length, headChars: spread(entries.map((e) => e.headChars)),
  };
}

// Per prompt, its scores and lengths only (no text), for the results file.
const scoresOf = (prompts) => prompts.map((p) => ({ chars: p.chars, earlier: p.earlier, otherRooms: p.otherRooms,
  own: p.own?.map((h) => ({ d: h.d, chars: h.chars, turn: h.turn })) ?? null, others: p.others?.map((h) => h.d) }));

// ---- output: counts, lengths and scores only ----

const sp = (s) => (s.n ? `${s.min} / ${s.p10} / ${s.p25} / ${s.middle} / ${s.p75} / ${s.p90} / ${s.max}` : "none");
const mm = (s) => (s.n ? `${s.middle} / ${s.p90} / ${s.max}` : "-");
function showCounts(read, c) {
  say(`read: ${JSON.stringify(read)}`);
  say(`sessions ${c.sessions} (-p runs ${c.print}) in ${c.projects} project folders; folders whose sessions name ` +
    `more than one project ${c.mixedFolders}; branch copies ${c.branchCopies}, their copied turns ` +
    `${JSON.stringify(c.copied)}`);
  say(`turns (copied ones apart): typed ${c.typed}, background ${c.background}; set apart ` +
    `${JSON.stringify(c.apart)}; damaged lines before a first turn ${c.damagedOutside}; marked typed turns ` +
    `${JSON.stringify(c.marked)}`);
  say(`typed turns with no model text ${c.typedNoText}; typed turns saved ${c.turnsSaved}, of them in parts ` +
    `${c.inParts} (most parts ${c.mostParts}); entries ${c.entries}; pieces by room ${JSON.stringify(c.piecesByRoom)}`);
  say(`first prompts ${c.firstPrompts}; first typed turn set apart ${c.firstSetApart}; sessions with no typed turn ` +
    `${c.noTypedTurn} (branch copies not counted here); cut to ${QUERY_MAX} ${c.cut}; with a picture ` +
    `${c.withPicture}; with no other session of the project started before ${c.noEarlierSession}`);
  say(`first prompt length (code points): ${sp(c.promptChars)} (${c.promptChars.n})`);
}

function report(r, f) {
  say(`adds ${JSON.stringify(r.add)}; palace ${JSON.stringify(r.size)}`);
  say(`searches ${JSON.stringify(r.queries)}; backend ${r.backend} / ${r.statusz.backend}, model ${r.model}; hub ` +
    `start ${r.startMs} ms, stop ${r.stopMs} ms; adds and searches ${r.eventsMs} ms`);
  say(`prompts ${JSON.stringify(f.prompts)}`);
  say("distance (lower = closer): smallest / 10th / 25th / middle / 75th / 90th / largest (n)");
  for (const [k, s] of Object.entries(f.spreads)) say(`  ${k}: ${sp(s)} (${s.n})`);
  say("cut-off (from): same-project hits inside / all, prompts with one / with earlier entries, per prompt " +
    "middle / 90th / most, entries most; other-project hits inside / all, prompts with one / with other entries, " +
    "per prompt middle / 90th / most; note text at count 1, 2, 3: prompts, middle / 90th / longest");
  for (const c of f.cutoffs) {
    say(`  ${c.x} (${c.from.join(", ")}): same ${c.same.inside}/${c.same.of}, ${c.same.prompts}/` +
      `${f.prompts.withOwn}, ${mm(c.same.perPrompt)}, ${c.same.entriesMost}; other ${c.other.inside}/${c.other.of}, ` +
      `${c.other.prompts}/${f.prompts.withOthers}, ${mm(c.other.perPrompt)}; notes ${c.notes.map((n) =>
        `${n.count}: ${n.prompts}, ${mm(n.text)}`).join(" | ")}`);
  }
  say(`a note of k matches, closest first, any distance: prompts; text middle / 90th / longest; with the heading ` +
    `(${f.headingChars}) and first lines (${mm(f.headChars)}) middle / 90th / longest; as whole entries: prompts, ` +
    "middle / 90th / longest");
  for (const n of f.lengths) {
    say(`  ${n.count}: ${n.prompts}; ${mm(n.text)}; ${mm(n.whole)}; ${n.entries.prompts}, ${mm(n.entries.chars)}`);
  }
}

// Deletes this run's palace by its exact name, after its hub has stopped (as scripts/8d/measure-lessons.mjs does).
function removePalaces() {
  const root = path.join(home, "palaces");
  const mine = new RegExp(`^measure-note-${stamp}-(check|real)$`);
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

async function mainRun(kind) {
  const t0 = performance.now();
  let phase = kind === "real" ? "real" : "made-up";
  try {
    const data = kind === "real" ? readSessions() : madeUp();
    const b = build(data.projects);
    out.read = data.read;
    out.counts = b.counts;
    showCounts(data.read, b.counts);
    if (kind === "check") expectAll(b.counts, EXPECT_BUILD, "the entries and prompts");
    init();
    await setUp(kind);
    const r = await measureNote(kind, b.entries, b.prompts);
    const f = figures(b.entries, b.prompts);
    out.run = r;
    out.figures = f;
    out.prompts = scoresOf(b.prompts);
    if (kind === "check") {
      expectAll({ added: r.add.added, alreadyExists: r.add.alreadyExists, addFailed: r.add.failed,
        piecesWrong: r.add.piecesWrong, ...r.queries, ownNone: f.prompts.ownNone, withOwn: f.prompts.withOwn,
        sizeEntries: r.size.entries, sizePieces: r.size.pieces }, EXPECT_RUN, "the run");
    }
    report(r, f);
    phase = "done";
  } catch (e) {
    // While the user's text is handled, an error says its name alone: its message could hold that text.
    fail(phase === "real" ? `real: ${e?.name ?? "error"} ${e?.code ?? ""}` : `${phase}: ${e?.stack ?? e?.message}`);
  } finally {
    if (lister) {
      await cleanup();
      out.palaces = removePalaces();
      for (const p of out.palaces) say(`palace ${p.name}: ${p.removed ? `deleted (${p.files} files, ${p.folders} ` +
        "folders)" : `NOT deleted${p.why ? ` (${p.why})` : ""}`}`);
      out.runMs = since(t0);
      say(`run took ${Math.round(out.runMs / 100) / 10} s`);
      await finish();
    } else {
      say(`measure-note: FAILED (${out.failures.length})`);
      process.exitCode = 1;
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (COMMAND === "scan") {
    try {
      const data = readSessions();
      showCounts(data.read, build(data.projects).counts);
    } catch (e) {
      console.error(`measure-note scan failed: ${e?.code ?? e?.name ?? "error"}`);
      process.exitCode = 1;
    }
  } else if (COMMAND === "check" || COMMAND === "run") await mainRun(COMMAND === "run" ? "real" : "check");
  else {
    console.error("usage: node scripts/8d/measure-note.mjs scan | check | run");
    process.exitCode = 2;
  }
}
