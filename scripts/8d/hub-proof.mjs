// The proof of the hub's start and stop on step 20's own terms (8d plan, step 20; Q24), run before any of the
// supervisor is written, and the figures the user asked for after its review (2026-11-20, "Fix script, measure
// again"). Not part of Tachikoma: run by hand, between two snapshots of the user's folders, with this process's own
// TEMP and TMP in the build folder (it refuses to run otherwise), so neither Node nor tsx writes to the user's Temp:
//
//   TACHI_8D_BUILD=<build> TEMP=<build>\hub-proof\parent-tmp TMP=<same> TSX_DISABLE_CACHE=1 \
//     node --import tsx scripts/8d/hub-proof.mjs
//
// Every hub is started with the program, the arguments and the environment the supervisor will start it with: the
// environment's own Python with -I and MemPalace's server module with `--transport http --host 127.0.0.1 --port <p>
// --palace <palace> --backend sqlite_exact` (Q24, Q8, Q25), with step 16's hub environment (src/memory/env.ts,
// hubEnv) built on the build's own environment (step 1's helper, with step 5's settings: HF_HUB_OFFLINE=1 and a
// dead-end proxy of this script's that records and refuses every connection), hidden and detached, with no input or
// output, from a starter that then exits. One thing differs, for the watch (the user's choice after the review): the
// module is run through step 5's audit-hook wrapper (copied unchanged from scripts/8d/measure-hub.mjs, as step 14
// did), `-c <wrapper> <log> mempalace.mcp_server` in place of `-m mempalace.mcp_server`, with the same module
// arguments. The paths are step 16's (src/memory/paths.ts) in a new data folder of the build folder; the environment
// folder is the build's own (step 4); step 5's model is copied into the new home, where MemPalace looks.
//
// What it shows and measures:
// - the proof, on the first start: it serves (its health check, one add and one search through step 18's client); it
//   is found (serverinfo.json by listing <home>/.mempalace/server/*/serverinfo.json and matching palace_path without
//   regard to letter case, Q7, naming this port and the serving process's id); it is stopped by that id (HELPER, run
//   by the environment's Python as the supervisor will: the start time read, later read again from the same handle that
//   ends the process, and a wait for every process of the hub), with the starter, the process it started, the serving
//   process and any console host listed by id before and after (LISTER, step 8's);
// - 20 starts on that palace, which then holds entries, each with its read-back timed in three parts (the connect,
//   mempalace_status, the palace file's model read) and its stop timed in two (the whole run of the environment's
//   Python, and the wait inside it); before each stop, a stop given another start time must stop nothing;
// - EMPTY_PALACES new, empty palaces and one palace broken on purpose (a palace file that is not a database): for each,
//   the status call's answer (MemPalace's error, details and hint) and what the palace file holds.
//
// Processes: a process is stopped only when it was recorded with its start time when it was started (the process the
// starter started, its start no earlier than the starter's; the serving process and console host under it, started
// after it while it still had its recorded start), and only after the environment's Python reads that start time again.
// Clean-up runs only after a failure, on recorded processes alone; at the end every recorded process is looked up.
//
// The figures are M3's, as the supervisor will use them (the build record, step 8, the user's choices): the start
// limit 40 s, the health check every 100 ms while a hub starts, each with a 0.75 s limit, and the wait for a stopped
// hub, 1 s, given to the wait inside the Python as the proof's stop gave it. STARTS is M3's count of runs (the user's
// choice after the review). EMPTY_PALACES, ENTRIES and GIVE_UP_MS are this script's own: five empty palaces show
// whether the empty palace's answer is always the same; three entries make a palace that holds entries; GIVE_UP_MS is
// this script's cut-off for its own calls, so that a run always ends. Nothing is fetched.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { connect } from "../../src/memory/client.ts";
import { hubEnv } from "../../src/memory/env.ts";
import { memoryPaths } from "../../src/memory/paths.ts";
import { throwaway } from "./throwaway.mjs";

const T0 = performance.now();
// The build folder, named by the caller: throwaway.mjs finds it from the Temp folder, which is not the user's here.
const BUILD = path.resolve(process.env.TACHI_8D_BUILD ?? "");
if (!process.env.TACHI_8D_BUILD || !existsSync(path.join(BUILD, "env", "pyvenv.cfg"))) {
  throw new Error("TACHI_8D_BUILD must name the build folder");
}
const ENV = path.join(BUILD, "env");
const PYTHON = path.join(ENV, "Scripts", "python.exe");
const MODEL_FROM = path.join(BUILD, "install", "home", ".cache", "chroma", "onnx_models", "all-MiniLM-L6-v2", "onnx");
const MODEL_FILES = ["config.json", "model.onnx", "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json",
  "vocab.txt"];
const START_LIMIT = 40_000;
const START_CHECK = 100;
const HEALTH_LIMIT = 750;
const STOP_WAIT = 1_000;
const STARTS = 20;
const EMPTY_PALACES = 5;
const ENTRIES = 3;
const GIVE_UP_MS = 60_000;
const VERSION = "3.12.0";
const EPOCH_US = 11644473600000000n;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const PROCESS_EVENTS = new Set(["subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.spawn",
  "os.startfile"]);
const DROP =
  /^(HTTPS?_PROXY|ALL_PROXY|NO_PROXY|ANONYMIZED_TELEMETRY|CHROMA_.*|PYTHON.*|HF_HUB_OFFLINE|TRANSFORMERS_OFFLINE)$/i;

const inside = (folder, p) => {
  const r = path.relative(folder.toLowerCase(), path.resolve(String(p)).toLowerCase());
  return r !== "" && !r.startsWith("..") && !path.isAbsolute(r);
};
for (const name of ["TEMP", "TMP"]) {
  if (!inside(BUILD, process.env[name] ?? "")) throw new Error(`${name} is not inside the build folder`);
}

// The supervisor's process helper, run by the environment's own Python with -I (step 6 item 2: Node cannot read
// another process's start time; this way was the fastest on Windows). `start <pid>` prints the process's start time,
// or "gone". `stop <pid> <start> <ms> <environments' folder>` opens the process, reads its start time from that same
// handle, and only if it is the given one ends it and waits up to <ms> for every process of the hub to end: on Windows
// also the environment's launcher that started it (its parent, a Scripts\python.exe one folder below the folder given,
// started before it) and what it started (its console host, started after it). It prints "stopped" or "running", the
// milliseconds it waited, and the ids waited for; or "differs" (the id now belongs to another program: nothing is
// stopped), or "gone". On Windows the end is forced (TerminateProcess); elsewhere it is SIGTERM, MemPalace's clean
// exit (runtime.py:332-358). Not run: Linux (/proc/<pid>/stat's start time, the proc(5) manual; os.pidfd_open and
// select for the wait) and macOS (`ps -o lstart= -p <pid>`, to the second, the user's choice after the review; kqueue
// for the wait).
const HELPER = String.raw`
import os, sys, time
op, pid = sys.argv[1], int(sys.argv[2])
if sys.platform == 'win32':
    import ctypes
    from ctypes import wintypes
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    class PE(ctypes.Structure):
        _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD), ('th32ProcessID', wintypes.DWORD),
                    ('th32DefaultHeapID', ctypes.c_size_t), ('th32ModuleID', wintypes.DWORD),
                    ('cntThreads', wintypes.DWORD), ('th32ParentProcessID', wintypes.DWORD),
                    ('pcPriClassBase', ctypes.c_long), ('dwFlags', wintypes.DWORD), ('szExeFile', ctypes.c_wchar * 260)]
    FT, H, D = wintypes.FILETIME, wintypes.HANDLE, wintypes.DWORD
    k.OpenProcess.restype = H
    k.OpenProcess.argtypes = (D, wintypes.BOOL, D)
    k.GetProcessTimes.argtypes = (H,) + (ctypes.POINTER(FT),) * 4
    k.GetExitCodeProcess.argtypes = (H, ctypes.POINTER(D))
    k.QueryFullProcessImageNameW.argtypes = (H, D, wintypes.LPWSTR, ctypes.POINTER(D))
    k.TerminateProcess.argtypes = (H, wintypes.UINT)
    k.WaitForMultipleObjects.argtypes = (D, ctypes.POINTER(H), wintypes.BOOL, D)
    k.WaitForMultipleObjects.restype = D
    k.CreateToolhelp32Snapshot.restype = H
    k.CreateToolhelp32Snapshot.argtypes = (D, D)
    k.Process32FirstW.argtypes = (H, ctypes.POINTER(PE))
    k.Process32NextW.argtypes = (H, ctypes.POINTER(PE))
    k.CloseHandle.argtypes = (H,)
    QUERY, SYNC, TERM = 0x1000, 0x00100000, 0x0001
    def opened(p, access):
        h = k.OpenProcess(access, False, p)
        if not h:
            return None, None
        c, e, kt, u, code = FT(), FT(), FT(), FT(), D()
        if (k.GetProcessTimes(h, ctypes.byref(c), ctypes.byref(e), ctypes.byref(kt), ctypes.byref(u))
                and k.GetExitCodeProcess(h, ctypes.byref(code)) and code.value == 259):
            return h, (c.dwHighDateTime << 32) | c.dwLowDateTime
        k.CloseHandle(h)
        return None, None
    def launcher(h, top):
        buf, n = ctypes.create_unicode_buffer(32768), D(32768)
        if not k.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n)):
            return False
        parts = os.path.normcase(buf.value).split('\\')
        return len(parts) > 3 and '\\'.join(parts[:-3]) == top and parts[-2:] == ['scripts', 'python.exe']
    if op == 'start':
        h, st = opened(pid, QUERY)
        print(st if h else 'gone')
        if h:
            k.CloseHandle(h)
        sys.exit()
    want, ms, top = sys.argv[3], int(sys.argv[4]), os.path.normcase(os.path.abspath(sys.argv[5]))
    h, st = opened(pid, QUERY | SYNC | TERM)
    if not h:
        print('gone')
        sys.exit()
    if str(st) != want:
        k.CloseHandle(h)
        print('differs')
        sys.exit()
    parent, children = None, []
    snap = k.CreateToolhelp32Snapshot(2, 0)
    pe = PE()
    pe.dwSize = ctypes.sizeof(PE)
    ok = k.Process32FirstW(snap, ctypes.byref(pe))
    while ok:
        if pe.th32ProcessID == pid:
            parent = pe.th32ParentProcessID
        elif pe.th32ParentProcessID == pid:
            children.append(pe.th32ProcessID)
        ok = k.Process32NextW(snap, ctypes.byref(pe))
    k.CloseHandle(snap)
    held, ids = [h], [pid]
    for p in ([parent] if parent else []) + children:
        hh, s = opened(p, QUERY | SYNC)
        if hh and ((s <= st and launcher(hh, top)) if p == parent else s >= st):
            held.append(hh)
            ids.append(p)
        elif hh:
            k.CloseHandle(hh)
    k.TerminateProcess(h, 1)
    t = time.perf_counter()
    r = k.WaitForMultipleObjects(len(held), (H * len(held))(*held), True, ms)
    waited = (time.perf_counter() - t) * 1000
    for x in held:
        k.CloseHandle(x)
    print('stopped' if r < len(held) else 'running', '%.1f' % waited, ' '.join(map(str, ids)))
    sys.exit()
import select, signal
def started(p):
    if sys.platform == 'darwin':
        import subprocess
        r = subprocess.run(['/bin/ps', '-o', 'lstart=', '-p', str(p)], capture_output=True, text=True)
        return r.stdout.strip() or None
    try:
        with open('/proc/%d/stat' % p, 'rb') as f:
            fields = f.read().rsplit(b')', 1)[1].split()
    except OSError:
        return None
    return None if fields[0] == b'Z' else int(fields[19])
if op == 'start':
    st = started(pid)
    print('gone' if st is None else st)
    sys.exit()
want, ms = sys.argv[3], int(sys.argv[4])
try:
    if sys.platform == 'darwin':
        q = select.kqueue()
        q.control([select.kevent(pid, select.KQ_FILTER_PROC, select.KQ_EV_ADD, select.KQ_NOTE_EXIT)], 0, 0)
    else:
        fd = os.pidfd_open(pid)
except OSError:
    print('gone')
    sys.exit()
st = started(pid)
if st is None:
    print('gone')
    sys.exit()
if str(st) != want:
    print('differs')
    sys.exit()
t = time.perf_counter()
if sys.platform == 'darwin':
    os.kill(pid, signal.SIGTERM)
    done = q.control(None, 1, ms / 1000)
else:
    signal.pidfd_send_signal(fd, signal.SIGTERM)
    done = select.select([fd], [], [], ms / 1000)[0]
print('stopped' if done else 'running', '%.1f' % ((time.perf_counter() - t) * 1000), pid)
`;

// The starter: it starts the hub as the supervisor will, detached, hidden, with no input or output and let go
// (unref), prints the started process's id, and exits.
const STARTER = `
const { spawn } = require("node:child_process");
const [file, cwd, ...args] = process.argv.slice(1);
const c = spawn(file, args, { cwd, env: process.env, detached: true, windowsHide: true, stdio: "ignore" });
c.unref();
process.stdout.write(String(c.pid));
`;

// Step 5's audit-hook wrapper, copied unchanged from scripts/8d/measure-hub.mjs: argv is the log file, the module,
// then the module's own arguments.
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

// This script's own process helper, step 8's (scripts/8d/measure-hub.mjs, LISTER), list only: the processes with one
// of the given ids or parent ids, each with its start time (microseconds since 1970) and whether it still runs.
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
k.CloseHandle.argtypes = (wintypes.HANDLE,)
QUERY = 0x1000
EPOCH_US = 11644473600000000
def now():
    return time.time_ns() // 1000
def listing(pids, ppids):
    snap = k.CreateToolhelp32Snapshot(2, 0)
    t2 = now()
    rows = []
    e = PE()
    e.dwSize = ctypes.sizeof(PE)
    ok = k.Process32FirstW(snap, ctypes.byref(e))
    while ok:
        if e.th32ProcessID in pids or e.th32ParentProcessID in ppids:
            rows.append((e.th32ProcessID, e.th32ParentProcessID, e.szExeFile))
        ok = k.Process32NextW(snap, ctypes.byref(e))
    k.CloseHandle(snap)
    out = []
    for pid, ppid, name in rows:
        h = k.OpenProcess(QUERY, False, pid)
        if not h:
            continue
        c, x, kt, u, code = FT(), FT(), FT(), FT(), wintypes.DWORD()
        st = None
        if k.GetProcessTimes(h, ctypes.byref(c), ctypes.byref(x), ctypes.byref(kt), ctypes.byref(u)):
            st = ((c.dwHighDateTime << 32) | c.dwLowDateTime) // 10 - EPOCH_US
        alive = bool(k.GetExitCodeProcess(h, ctypes.byref(code))) and code.value == 259
        k.CloseHandle(h)
        if st is not None and st > t2:
            continue
        out.append({'pid': pid, 'ppid': ppid, 'name': name, 'start': st, 'running': alive})
    return {'rows': out}
for line in sys.stdin:
    req = json.loads(line)
    try:
        r = listing(set(req['pids']), set(req['ppids']))
        r['ok'] = True
    except Exception as exc:
        r = {'ok': False, 'error': repr(exc)}
    sys.stdout.write(json.dumps(r) + '\n')
    sys.stdout.flush()
`;

const say = (...a) => console.log(...a);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const since = (t) => Math.round((performance.now() - t) * 10) / 10;
const iso = (us) => (us == null ? null : new Date(Math.floor(us / 1000)).toISOString());
const stats = (values) => {
  const s = values.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!s.length) return { n: 0 };
  const m = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { n: s.length, fastest: s[0], middle: Math.round(m * 10) / 10, slowest: s.at(-1) };
};

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = { stamp, failures: [], checks: {} };
const fail = (what) => {
  out.failures.push(what);
  say(`FAILED: ${what}`);
};
const ok = (name, value) => {
  if (value) out.checks[name] = (out.checks[name] ?? 0) + 1;
  else fail(name);
  return Boolean(value);
};

// ---- the set-up: step 16's paths in a new data folder, the build's environment and Python, the model in place ----

const { dir, env: base } = throwaway("hub-proof", { root: BUILD });
const runDir = path.join(dir, `run-${stamp}`);
mkdirSync(runDir);
const paths = { ...memoryPaths(path.join(dir, `data-${stamp}`), "proof"), env: ENV, envPython: PYTHON };
for (const d of [paths.root, paths.home, paths.tmp]) mkdirSync(d, { recursive: true });
const model = path.join(paths.home, ".cache", "chroma", "onnx_models", "all-MiniLM-L6-v2", "onnx");
mkdirSync(model, { recursive: true });
for (const f of MODEL_FILES) copyFileSync(path.join(MODEL_FROM, f), path.join(model, f));
if (!existsSync(PYTHON)) throw new Error(`no ${PYTHON}`);

const proxied = [];
const proxy = createServer((sock) => {
  const entry = { from: `${sock.remoteAddress}:${sock.remotePort}`, first: "" };
  proxied.push(entry);
  sock.once("data", (d) => (entry.first = d.toString("latin1").split("\r\n")[0]));
  sock.on("error", () => {});
  sock.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
const buildEnv = Object.fromEntries(Object.entries(base).filter(([k]) => !DROP.test(k)));
Object.assign(buildEnv, { HF_HUB_OFFLINE: "1", HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl,
  NO_PROXY: "127.0.0.1,localhost,::1" });
// The hub's environment, exactly as the supervisor will build it.
const env = hubEnv(paths, buildEnv, "win32");
out.env = Object.fromEntries(Object.entries(env).filter(([k]) =>
  /^(USERPROFILE|HOME|TEMP|TMP|TMPDIR|HF_|MEMPALACE_|.*PROXY|UV_|PYTHON)/i.test(k)));
for (const [k, v] of Object.entries(out.env).sort()) say(`env ${k}=${v}`);

// ---- this script's process helper, and the processes recorded with their start times ----

const cfg = readFileSync(path.join(ENV, "pyvenv.cfg"), "utf8");
const pythonw = path.join(cfg.match(/^home\s*=\s*(.+)$/m)[1].trim(), "pythonw.exe");
const lister = spawn(pythonw, ["-I", "-c", LISTER], { env: buildEnv, stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true });
const answers = [];
createInterface({ input: lister.stdout }).on("line", (l) => answers.shift()?.(JSON.parse(l)));
const list = async (pids, ppids = pids) => {
  const res = await new Promise((resolve) => {
    answers.push(resolve);
    lister.stdin.write(`${JSON.stringify({ pids, ppids })}\n`);
  });
  if (!res.ok) throw new Error(`the helper: ${res.error}`);
  return res.rows;
};
// pid -> { start (us), label, name }: only processes recorded when they were started.
const recorded = new Map();
const passing = new Set(); // ids of this run's short-lived processes (starters, helpers), never stopped
const record = (row, label) => recorded.set(row.pid, { start: row.start, label, name: row.name, ppid: row.ppid });

// The processes of one hub as they are now: the recorded ones, with their current start (a different start is
// another program's, not the hub's), and below a recorded one still holding its start those that started after it,
// which are recorded.
async function tree(label) {
  const ids = [...recorded].filter(([, r]) => r.label === label).map(([pid]) => pid);
  for (let round = 0; round < 3; round++) {
    let added = false;
    const rows = await list(ids, ids);
    for (const row of rows) {
      const parent = recorded.get(row.ppid);
      const parentHere = rows.find((r) => r.pid === row.ppid);
      if (!recorded.has(row.pid) && parent?.label === label && parentHere?.start === parent.start &&
          parentHere.running && row.start != null && row.start >= parent.start) {
        record(row, label);
        ids.push(row.pid);
        added = true;
      }
    }
    if (!added) {
      return ids.map((pid) => {
        const r = recorded.get(pid);
        const now = rows.find((x) => x.pid === pid && x.start === r.start);
        return { pid, ppid: r.ppid, name: r.name, start: iso(r.start), running: Boolean(now?.running) };
      });
    }
  }
  throw new Error("the hub's processes kept growing");
}

// ---- the start, the finding, the read-back and the stop, as the supervisor will do them ----

async function freePort() {
  const s = createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port === 8765 ? freePort() : port;
}

async function healthy(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(HEALTH_LIMIT) });
    await r.text();
    return r.status === 200;
  } catch {
    return false;
  }
}

function serverinfos(palace) {
  const root = path.join(paths.home, ".mempalace", "server");
  if (!existsSync(root)) return [];
  const want = path.resolve(palace).toLowerCase();
  return readdirSync(root).flatMap((key) => {
    try {
      const info = JSON.parse(readFileSync(path.join(root, key, "serverinfo.json"), "utf8"));
      return path.resolve(String(info.palace_path)).toLowerCase() === want ? [info] : [];
    } catch {
      return [];
    }
  });
}

function helper(args) {
  const t = performance.now();
  const r = spawnSync(PYTHON, ["-I", "-c", HELPER, ...args.map(String)], { cwd: paths.home, env, encoding: "utf8",
    windowsHide: true, timeout: GIVE_UP_MS });
  if (r.pid) passing.add(r.pid);
  return { said: r.stdout.trim(), err: r.stderr.trim().split(/\r?\n/).at(-1) ?? "", code: r.status, ms: since(t) };
}
const usOf = (filetime) => (/^\d+$/.test(filetime) ? Number(BigInt(filetime) / 10n - EPOCH_US) : null);

// What the palace file holds, read as step 18's client reads the model (read only), but telling its states apart.
function palaceFile(palace) {
  const file = path.join(palace, "sqlite_exact.sqlite3");
  const t = performance.now();
  if (!existsSync(file)) return { holds: "no file", ms: since(t) };
  let db;
  try {
    db = new (process.getBuiltinModule("node:sqlite").DatabaseSync)(file, { readOnly: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get("embedder_model:mempalace_drawers");
    return typeof row?.value === "string" ? { holds: "model", model: row.value, ms: since(t) } :
      { holds: "file but no model row", ms: since(t) };
  } catch (e) {
    return { holds: "can't open", error: e.message, ms: since(t) };
  } finally {
    db?.close();
  }
}

// MemPalace's own words of a refusal, without the paths it also gives.
const words = (reason) => {
  try {
    const j = JSON.parse(reason);
    return { error: j.error, details: j.details, hint: j.hint, backend: j.backend };
  } catch {
    return { text: String(reason).slice(0, 300) };
  }
};

const moduleArgs = (port, palace) => ["--transport", "http", "--host", "127.0.0.1", "--port", String(port),
  "--palace", palace, "--backend", "sqlite_exact"];
const audits = [];

// Starts a hub on `palace` from a starter that exits, records the process it started (its start no earlier than the
// starter's), waits for its health answer and its serverinfo.json, records the serving process and its console host,
// and reads the serving process's start time as the supervisor will.
async function start(label, palace) {
  const h = { label, palace: path.basename(palace) };
  const port = await freePort();
  const audit = path.join(runDir, `${label}.audit.jsonl`);
  audits.push(audit);
  const argv = ["-I", "-c", WRAPPER, audit, "mempalace.mcp_server", ...moduleArgs(port, palace)];
  h.port = port;
  const before = Date.now() * 1000;
  const t0 = performance.now();
  const s = spawnSync(process.execPath, ["-e", STARTER, PYTHON, paths.home, ...argv], { env, encoding: "utf8",
    windowsHide: true, timeout: GIVE_UP_MS });
  if (s.pid) passing.add(s.pid);
  const launched = Number(s.stdout);
  h.starter = { exit: s.status, started: launched };
  if (!ok("the starter exited 0 and named the process it started", s.status === 0 && Number.isInteger(launched))) {
    return h;
  }
  const row = (await list([launched], [])).find((r) => r.pid === launched);
  if (!ok("the process the starter started is recorded with its start time", row?.start != null &&
    row.start >= before)) return h;
  record(row, label);

  let up = false;
  while (!up && performance.now() - t0 < START_LIMIT) {
    up = await healthy(port);
    if (!up) {
      if (!(await list([launched], [])).some((r) => r.pid === launched && r.start === row.start && r.running)) break;
      await sleep(START_CHECK);
    }
  }
  h.healthMs = since(t0);
  h.answered = up;
  if (!up) {
    h.tree = await tree(label);
    return h;
  }
  let info;
  while (!info && performance.now() - t0 < START_LIMIT) {
    const infos = serverinfos(palace);
    info = infos.find((x) => x.port === port);
    if (!info) await sleep(START_CHECK);
  }
  h.foundMs = since(t0);
  if (!ok("serverinfo.json for the palace, by listing and a case-blind palace_path match, names this port",
    info?.port === port && info?.host === "127.0.0.1")) return h;
  h.listBefore = await tree(label);
  const serving = h.listBefore.find((r) => r.pid === info.pid);
  if (!ok("the process it names is the serving one, under the process the starter started",
    serving?.running && serving.ppid === launched)) return h;
  ok("the starter has exited", !(await list([s.pid], [])).some((r) => r.running));
  const st = helper(["start", info.pid]);
  h.startRead = st.ms;
  if (!ok("the start time the environment's Python read is the one recorded, to the microsecond",
    usOf(st.said) === recorded.get(info.pid).start)) return h;
  h.serving = { pid: info.pid, start: st.said };
  mkdirSync(palace, { recursive: true });
  writeFileSync(path.join(palace, "tachikoma-version.json"), `${JSON.stringify({ mempalace: VERSION })}\n`);
  return h;
}

// The read-back, in three timed parts: the connect (step 18's, which also lists the tools), mempalace_status (step
// 18's own call, run through the client's call), and the palace file's model.
async function readBack(h, palace) {
  const t = performance.now();
  const c = await connect({ url: `http://127.0.0.1:${h.port}/mcp` }, "own", { timeout: GIVE_UP_MS });
  const r = { connectMs: since(t) };
  if (c.is !== "connected") return { ...r, connect: c };
  const t2 = performance.now();
  const status = await c.palace["call"]("mempalace_status", {}, GIVE_UP_MS);
  r.statusMs = since(t2);
  r.status = status.is === "answer" ? { backend: status.json.backend } : { is: status.is, ...words(status.reason) };
  const file = palaceFile(palace);
  r.fileMs = file.ms;
  r.file = file;
  r.allMs = since(t);
  r.palace = c.palace;
  return r;
}

// A stop given another start time first (it must stop nothing), then the stop, timed as a whole run of the
// environment's Python and as the wait inside it; then every process of the hub looked up again.
async function stop(h) {
  const wrong = helper(["stop", h.serving.pid, `${h.serving.start}1`, STOP_WAIT, path.dirname(paths.env)]);
  ok("a stop given another start time says it differs and stops nothing", wrong.said === "differs" &&
    (await healthy(h.port)));
  const s = helper(["stop", h.serving.pid, h.serving.start, STOP_WAIT, path.dirname(paths.env)]);
  const [result, waited, ...ids] = s.said.split(" ");
  h.stop = { result, wholeMs: s.ms, waitMs: Number(waited), ids: ids.map(Number) };
  ok("the stop found the recorded start time and the hub's processes ended", result === "stopped");
  const conhosts = h.listBefore.filter((r) => r.ppid === h.serving.pid && r.running).map((r) => r.pid);
  ok("it waited for the serving process, the launcher and the console host", h.stop.ids.includes(h.serving.pid) &&
    h.stop.ids.includes(h.starter.started) && conhosts.every((p) => h.stop.ids.includes(p)));
  h.listAfter = await tree(h.label);
  ok("every process of the hub is gone, listed by id before and after", h.listAfter.every((r) => !r.running));
  ok("it no longer answers", !(await healthy(h.port)));
}

const hubs = [];
try {
  // The proof's start, on step 16's palace: it serves, with ENTRIES entries and one search.
  const first = await start("proof", paths.palace);
  hubs.push(first);
  if (!first.serving) throw new Error("the first start did not complete");
  const c = await connect({ url: `http://127.0.0.1:${first.port}/mcp` }, "own", { timeout: GIVE_UP_MS });
  if (c.is !== "connected") throw new Error(`the first connect: ${JSON.stringify(c)}`);
  for (let i = 1; i <= ENTRIES; i++) {
    const add = await c.palace.add("hub-proof", `hub proof, entry ${i}`,
      `The hub proof's entry ${i}: started the supervisor's way, found by listing, stopped by its id.`, GIVE_UP_MS);
    ok("an add worked", add.is === "added");
  }
  const found = await c.palace.search("is the hub stopped by its id", { room: "hub-proof" }, 5, GIVE_UP_MS);
  ok("one search answered, and found the entries", found.is === "found" &&
    found.hits.filter((x) => x.label.startsWith("hub proof, entry")).length === ENTRIES);
  first.missing = c.palace.offers.missing;
  await c.palace.close();
  await stop(first);

  // STARTS starts on that palace, which now holds entries.
  out.starts = [];
  for (let i = 1; i <= STARTS; i++) {
    const h = await start(`start-${i}`, paths.palace);
    hubs.push(h);
    if (!h.serving) throw new Error(`start ${i} did not complete`);
    const r = await readBack(h, paths.palace);
    await r.palace?.close();
    delete r.palace;
    h.readBack = r;
    ok("the backend read back is sqlite_exact", r.status?.backend === "sqlite_exact");
    ok("the palace file holds the model minilm", r.file?.model === "minilm");
    await stop(h);
    out.starts.push({ healthMs: h.healthMs, foundMs: h.foundMs, startRead: h.startRead, ...r, stop: h.stop });
  }

  // New, empty palaces, and one broken on purpose: what the status call answers, and what the palace file holds.
  out.palaces = [];
  const kinds = [...Array.from({ length: EMPTY_PALACES }, (_, i) => `empty-${i + 1}`), "broken"];
  for (const kind of kinds) {
    const palace = path.join(paths.root, `palace-${kind}`);
    if (kind === "broken") {
      mkdirSync(palace);
      writeFileSync(path.join(palace, "sqlite_exact.sqlite3"), "not a database: this palace is broken on purpose\n");
    }
    const entry = { kind, fileBefore: palaceFile(palace).holds };
    const h = await start(`palace-${kind}`, palace);
    hubs.push(h);
    entry.answered = h.answered;
    entry.healthMs = h.healthMs;
    if (h.serving) {
      const r = await readBack(h, palace);
      entry.status = r.status;
      entry.file = { holds: r.file.holds, model: r.file.model, error: r.file.error };
      entry.connectMs = r.connectMs;
      entry.statusMs = r.statusMs;
      if (r.palace) {
        const s = await r.palace.search("anything at all", "wing", 5, GIVE_UP_MS);
        entry.search = s.is === "found" ? { hits: s.hits.length } : { is: s.is, ...words(s.reason ?? "") };
        await r.palace.close();
      }
      entry.fileAfterSearch = palaceFile(palace).holds;
      await stop(h);
    } else {
      entry.tree = h.tree;
      entry.file = palaceFile(palace);
    }
    out.palaces.push(entry);
  }
} catch (e) {
  fail(`run: ${e.stack ?? e.message}`);
}

// ---- the end: clean-up after a failure only, the watch, every recorded process looked up again, the results ----

if (out.failures.length) {
  out.cleanedUp = [];
  const servingFirst = [...recorded].sort(([, a], [, b]) => b.start - a.start);
  for (const [pid, r] of servingFirst) {
    const st = helper(["start", pid]);
    if (usOf(st.said) !== r.start) continue; // gone, or the id is another program's now
    const s = helper(["stop", pid, st.said, STOP_WAIT, path.dirname(paths.env)]);
    out.cleanedUp.push({ pid, name: r.name, label: r.label, said: s.said });
  }
}
const records = audits.filter(existsSync).flatMap((f) => readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean)
  .map((l) => ({ ...JSON.parse(l), file: path.basename(f) })));
const server = records.filter((r) => r.phase === "server");
out.watch = {
  proxied,
  hooked: new Set(records.map((r) => r.file)).size,
  withProxySettings: new Set(records.filter((r) => r.httpx_proxies).map((r) => r.file)).size,
  control: records.filter((r) => r.phase === "control" && r.event).length,
  serverEvents: server.length,
  outside: server.filter((r) => r.host !== null && !LOOPBACK.has(r.host)).map((r) => `${r.event} ${r.host}`),
  children: server.filter((r) => PROCESS_EVENTS.has(r.event)).length,
};
ok("the dead-end proxy got nothing", proxied.length === 0);
ok("every hub was hooked, saw the proxy settings, then no outside address and no child process",
  out.watch.hooked === audits.length && out.watch.withProxySettings === audits.length && !out.watch.outside.length &&
  !out.watch.children);
const ids = [...recorded.keys(), ...passing];
const end = await list(ids, [...recorded.keys()]);
const left = end.filter((r) => r.running && (recorded.get(r.pid)?.start === r.start || passing.has(r.pid)));
out.leftRunning = left;
ok("no recorded process of this run's is left running", left.length === 0);
out.recorded = recorded.size;
out.passing = passing.size;
lister.stdin.end();
await new Promise((resolve) => (lister.exitCode != null ? resolve() : lister.once("exit", resolve)));
await new Promise((resolve) => proxy.close(resolve));

const s = out.starts ?? [];
out.figures = {
  "health answer after the start": stats(s.map((x) => x.healthMs)),
  "serverinfo.json naming the port, after the start": stats(s.map((x) => x.foundMs)),
  "start-time read (spawned)": stats(s.map((x) => x.startRead)),
  "read-back: connect (with the tool list)": stats(s.map((x) => x.connectMs)),
  "read-back: mempalace_status": stats(s.map((x) => x.statusMs)),
  "read-back: the palace file's model": stats(s.map((x) => x.fileMs)),
  "read-back: all three": stats(s.map((x) => x.allMs)),
  "stop: the whole run of the environment's Python": stats(s.map((x) => x.stop?.wholeMs)),
  "stop: the wait inside it": stats(s.map((x) => x.stop?.waitMs)),
};
out.hubs = hubs.map((h) => ({ label: h.label, palace: h.palace, starter: h.starter, answered: h.answered,
  serving: h.serving?.pid, before: h.listBefore, after: h.listAfter, stop: h.stop }));
out.tookMs = since(T0);
writeFileSync(path.join(runDir, "results.json"), `${JSON.stringify(out, null, 2)}\n`);
say(JSON.stringify({ checks: out.checks, failures: out.failures, figures: out.figures, palaces: out.palaces,
  watch: { ...out.watch, proxied: out.watch.proxied.length }, recorded: out.recorded, passing: out.passing,
  leftRunning: out.leftRunning, cleanedUp: out.cleanedUp }, null, 2));
say(`results ${path.join(runDir, "results.json")}`);
say(`took ${out.tookMs} ms`);
say(out.failures.length ? `hub-proof: FAILED (${out.failures.length})` : "hub-proof: passed");
process.exitCode = out.failures.length ? 1 : 0;
