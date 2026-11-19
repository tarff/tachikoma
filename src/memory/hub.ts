import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { collect, killTree, running } from "../exec/local.js";
import { connect, palaceFile } from "./client.js";
import { hubEnv } from "./env.js";
import { MEMPALACE, type Program, readyFile } from "./install.js";
import { type OsLock, tryLock } from "./oslock.js";
import { makeMemoryFolder, type MemoryPaths } from "./paths.js";

// The hub's supervisor (8d plan, step 20), for Tachikoma's own palace only: it starts the hub, finds it, joins it,
// watches it and stops it, as the design's "Joining and stopping" says, the way the user decided after step 6 (Q7, Q8,
// Q24, Q25) and proved in step 20's proof (scripts/8d/hub-proof.mjs). What it answers is for its caller (step 21),
// which words it; none of it is shown as it is.

// The figures, each from its record (the design's build record):
// - M3 (step 8; the user's choices, 2026-11-19): the start limit, from the start until the hub answers and its
//   serverinfo.json names its port; the check every 100 ms while a hub starts; the health check's limit (MemPalace's
//   own, hub_client.py:21); the wait between tries for the join lock;
// - M4 (step 9; the user's choices, 2026-11-19): the "in use" file's refresh, and the age at which one counts as gone;
// - step 20's run 3 (the user's choices, 2026-11-20), each 5 times the slowest measured: the whole stop run of the
//   environment's Python (5 x 257.5 ms, in place of M3's 1 s), the read-back (5 x 165.2 ms) and the start-time read
//   after a start (5 x 195.5 ms).
export interface Figures {
  startLimit: number;
  startCheck: number;
  health: number;
  lockRetry: number;
  refresh: number;
  stale: number;
  stop: number;
  readBack: number;
  startRead: number;
}
export const FIGURES: Figures = {
  startLimit: 40_000,
  startCheck: 100,
  health: 750,
  lockRetry: 500,
  refresh: 5_000,
  stale: 27_000,
  stop: 1_300,
  readBack: 900,
  startRead: 1_000,
};

// The storage and model Tachikoma's palace must be read back with (Q24; step 6 item 12).
const BACKEND = "sqlite_exact";
const MODEL = "minilm";

// Tachikoma's own hub record (Q7), written only under the join lock: the environment folder the hub runs from (null
// when it was another window's, found after an exit with code 2, whose folder is not known), its port, the serving
// process's id and start time, and the "stopping" mark.
export interface HubRecord {
  env: string | null;
  port: number;
  pid: number;
  start: string;
  stopping: boolean;
}
export const hubRecord = (paths: MemoryPaths) => path.join(paths.home, "hub.json");
// The palace's version record (the design's "Versions side by side"; the name the user approved after step 20's proof).
const versionFile = (paths: MemoryPaths) => path.join(paths.palace, "tachikoma-version.json");
const IN_USE = "in-use-";

// Why memory is off. Internal: step 21 words each.
export type Why =
  | { is: "folder"; detail: string } // memory's folders could not be made (privateDir's or Node's own words)
  | { is: "lock" } // the join lock could not be taken (oslock's own words are never passed on)
  | { is: "newer palace"; version: string } // the design's reason, with the version
  | { is: "no port"; detail: string } // no free port on loopback (Node's own words)
  | { is: "exited"; code: number | null } // the start exited, and no other hub answers
  | { is: "not started"; detail: string } // the program could not be started (Node's own words)
  | { is: "start limit" } // no answer, or no serverinfo.json naming the port, within the start limit
  | { is: "start time" } // the serving process's start time could not be read within its limit
  | { is: "read-back"; failed: "timed out" | "refused" | "failed" | "lost" | "not offered" }
  | { is: "not tachikoma's"; backend?: string; model?: string };
export type Joined = { is: "on"; url: string } | { is: "off"; why: Why } | { is: "closed" };
export type HubEvent = { is: "failing" } | { is: "on"; url: string } | { is: "off"; why: Why };
export type Left =
  | { is: "left" } // this window's file is gone; the hub is another window's, or there was none
  | { is: "stopped" } // the helper said the serving process ended
  // Not confirmed: the record stays, marked stopping, for the next window to handle.
  | { is: "not stopped"; why: "the id is another program's" | "the process could not be opened" |
    "the helper gave no answer" }
  // The join lock was not taken: the caller's signal ended the wait, or the take failed (then, as the last window,
  // the record is marked stopping for the next window).
  | { is: "gave up" };

export interface HubOptions {
  paths: MemoryPaths;
  // The environment the hub's is built from (step 16's hubEnv).
  env?: NodeJS.ProcessEnv;
  // How a program is started by its full path: as it is. A test starts the stand-in Python's script with Node (as
  // step 19's install does).
  launch?: (file: string) => Program;
  // The figures above; a test gives shorter ones.
  figures?: Partial<Figures>;
  // Each change found by the timer: the hub found gone or stopping, then the window on again or off.
  onEvent?: (e: HubEvent) => void;
}

// The supervisor's process helper, run by the environment's own Python with -I (step 6 item 2: Node cannot read
// another process's start time), word for word as step 20's proof has it (scripts/8d/hub-proof.mjs; its runs had the
// text before the review's split of "gone" from "unopened"). `start <pid>` prints the process's start time, or "gone"
// (no such process, or it has ended), or "unopened <error>" (it could not be opened, which is no proof that it ended).
// `stop <pid> <start> <ms> <environments' folder>` opens the process, reads its start time from that same handle,
// and only if it is the given one ends it and waits up to <ms> for every process of the hub: on Windows also the
// environment's launcher that started it (its parent, a Scripts\python.exe one folder below the folder given, started
// before it) and its console host (started after it). It prints "stopped" or "running", the milliseconds it waited
// and the ids waited for; or "differs" (the id now belongs to another program: nothing is stopped), "gone" or
// "unopened <error>" as above. On Windows the end is forced (TerminateProcess, the user's approval after step 20's
// proof; only idle hubs were stopped there); elsewhere it is SIGTERM, MemPalace's clean exit (runtime.py:332-358). Not
// run: Linux (/proc/<pid>/stat, the proc(5) manual; os.pidfd_open and select) and macOS (`ps -o lstart= -p <pid>`, to
// the second; kqueue), the README's known limits.
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
            err = ctypes.get_last_error()
            return None, 'gone' if err == 87 else 'unopened %d' % err
        c, e, kt, u, code = FT(), FT(), FT(), FT(), D()
        if not (k.GetProcessTimes(h, ctypes.byref(c), ctypes.byref(e), ctypes.byref(kt), ctypes.byref(u))
                and k.GetExitCodeProcess(h, ctypes.byref(code))):
            err = ctypes.get_last_error()
            k.CloseHandle(h)
            return None, 'unopened %d' % err
        if code.value != 259:
            k.CloseHandle(h)
            return None, 'gone'
        return h, (c.dwHighDateTime << 32) | c.dwLowDateTime
    def launcher(h, top):
        buf, n = ctypes.create_unicode_buffer(32768), D(32768)
        if not k.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n)):
            return False
        parts = os.path.normcase(buf.value).split('\\')
        return len(parts) > 3 and '\\'.join(parts[:-3]) == top and parts[-2:] == ['scripts', 'python.exe']
    if op == 'start':
        h, st = opened(pid, QUERY)
        print(st)
        if h:
            k.CloseHandle(h)
        sys.exit()
    want, ms, top = sys.argv[3], int(sys.argv[4]), os.path.normcase(os.path.abspath(sys.argv[5]))
    h, st = opened(pid, QUERY | SYNC | TERM)
    if not h:
        print(st)
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
except ProcessLookupError:
    print('gone')
    sys.exit()
except OSError as e:
    print('unopened %d' % e.errno)
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

// The server module's arguments (Q24, Q8, Q25), the list step 20's proof ran: HTTP on loopback, the picked port, the
// palace always passed, and the backend never left to MemPalace's default (chroma).
const moduleArgs = (port: number, palace: string) => ["--transport", "http", "--host", "127.0.0.1", "--port",
  String(port), "--palace", palace, "--backend", BACKEND];

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Waits `ms`, or less when the signal fires.
const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

// Settles when the signal fires; never, without one.
const fired = (signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (!signal) return;
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

// A port the system gives on loopback, never MemPalace's default 8765, so a hub of the user's own is never met.
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve, reject) => {
    s.once("error", reject);
    s.listen(0, "127.0.0.1", resolve);
  });
  const { port } = s.address() as { port: number };
  await new Promise((resolve) => s.close(resolve));
  return port === 8765 ? freePort() : port;
}

async function healthy(port: number, limit: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(limit) });
    await r.text();
    return r.status === 200;
  } catch {
    return false;
  }
}

// MemPalace's version numbers, compared part by part.
function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

const same = (a: string, b: string) =>
  process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() :
    path.resolve(a) === path.resolve(b);

export class Hub {
  private readonly paths: MemoryPaths;
  private readonly env: NodeJS.ProcessEnv;
  private readonly launch: (file: string) => Program;
  private readonly f: Figures;
  private readonly onEvent: (e: HubEvent) => void;
  // This window's "in use" file.
  private readonly inUse: string;
  private readonly closing = new AbortController();
  private busy: Promise<Joined> | undefined;
  private closed: Promise<Left> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private checking = false;
  private port: number | undefined;

  constructor(o: HubOptions) {
    this.paths = o.paths;
    this.env = o.env ?? process.env;
    this.launch = o.launch ?? ((file) => ({ command: file, args: [] }));
    this.f = { ...FIGURES, ...o.figures };
    this.onEvent = o.onEvent ?? (() => {});
    this.inUse = path.join(o.paths.home, `${IN_USE}${process.pid}-${randomBytes(4).toString("hex")}.json`);
  }

  // Joins the hub, starting one if none answers. One join at a time; once closing, none begins.
  join(): Promise<Joined> {
    if (this.closing.signal.aborted) return Promise.resolve({ is: "closed" });
    this.busy ??= this.joinOnce()
      .then((r) => this.after(r))
      .finally(() => {
        this.busy = undefined;
      });
    return this.busy;
  }

  // The closing state, entered once: the timer is cleared, a wait for the join lock gives up, no join begins, a join
  // already inside the lock finishes its one step, and then this window leaves. The caller's signal ends the leave's
  // own wait for the lock.
  close(signal?: AbortSignal): Promise<Left> {
    this.closed ??= this.leave(signal);
    return this.closed;
  }

  // A join's end: a start that completes after closing never makes this window on (the leave handles its hub).
  private after(r: Joined): Joined {
    if (this.closing.signal.aborted) return { is: "closed" };
    if (r.is === "on") {
      this.port = Number(new URL(r.url).port);
      if (!this.timer) {
        this.timer = setInterval(() => this.tick(), this.f.refresh);
        this.timer.unref?.();
      }
    } else if (r.is === "off") this.stopTimer();
    return r;
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  // The timer: the "in use" file is rewritten first, so a slow health check never makes it late (step 9's note); then
  // the hub is checked, and a hub found gone or stopping means joining again (Q25: with the idle exit off, this is
  // what brings back one that went away).
  private tick(): void {
    try {
      this.touch();
    } catch {
      // the next tick tries again; a file left unrefreshed counts as gone only after the stale age
    }
    if (this.checking || this.closing.signal.aborted) return;
    this.checking = true;
    void this.check().finally(() => {
      this.checking = false;
    });
  }

  private async check(): Promise<void> {
    const rec = this.record();
    if (rec && !rec.stopping && rec.port === this.port && (await healthy(rec.port, this.f.health))) return;
    if (this.closing.signal.aborted) return;
    this.onEvent({ is: "failing" });
    const r = await this.join();
    if (r.is !== "closed") this.onEvent(r);
  }

  // The design's join: take the join lock, write this window's "in use" file, check the hub (the record, then a health
  // check), start one if none answers, let go; then read back the backend and the model in force.
  private async joinOnce(): Promise<Joined> {
    try {
      makeMemoryFolder(this.paths); // memory/ made private, and the lock's folder made, before the take (step 17)
      mkdirSync(this.paths.home, { recursive: true });
    } catch (err) {
      return { is: "off", why: { is: "folder", detail: message(err) } };
    }
    let lock: OsLock | null;
    try {
      lock = await this.take(this.closing.signal);
    } catch {
      return { is: "off", why: { is: "lock" } };
    }
    if (!lock) return { is: "closed" };
    let port: number;
    try {
      this.touch();
      const rec = this.record();
      let hub = rec && !rec.stopping && (await healthy(rec.port, this.f.health)) ? rec : undefined;
      if (!hub) {
        const version = this.palaceVersion();
        if (version && newer(version, MEMPALACE)) return { is: "off", why: { is: "newer palace", version } };
        const started = await this.start();
        if ("why" in started) return { is: "off", why: started.why };
        hub = started.record;
        this.write(hubRecord(this.paths), hub);
        if (hub.env !== null && (!version || newer(MEMPALACE, version))) {
          mkdirSync(this.paths.palace, { recursive: true });
          this.write(versionFile(this.paths), { mempalace: MEMPALACE });
        }
      }
      this.removeOld(hub);
      port = hub.port;
    } catch (err) {
      return { is: "off", why: { is: "folder", detail: message(err) } };
    } finally {
      lock.release();
    }
    if (this.closing.signal.aborted) return { is: "closed" };
    const url = `http://127.0.0.1:${port}/mcp`;
    const why = await this.readBack(url);
    return why ? { is: "off", why } : { is: "on", url };
  }

  // The backend and the model in force, within the read-back's limit. A refused status with no palace file yet is a
  // palace not written yet, not a mismatch, as a model not yet recorded is not (the user's choices after steps 18 and
  // 20); a refused status with a palace file that cannot be opened, or any other failure, turns memory off.
  private async readBack(url: string): Promise<Why | undefined> {
    const began = performance.now();
    const left = () => this.f.readBack - (performance.now() - began);
    const c = await connect({ url }, "own", { timeout: this.f.readBack });
    if (c.is !== "connected") return { is: "read-back", failed: c.is === "timed out" ? "timed out" : "failed" };
    try {
      const r = left() > 0 ? await c.palace.inForce(this.paths.palace, left()) : ({ is: "timed out" } as const);
      if (r.is === "read") {
        if (r.backend !== BACKEND || (r.model !== undefined && r.model !== MODEL)) {
          return { is: "not tachikoma's", backend: r.backend, model: r.model };
        }
        return undefined;
      }
      // A palace with no file, or a file that opens with no model row, is new (the user's "Treat as new").
      if (r.is === "refused" && ["no file", "no model row"].includes(palaceFile(this.paths.palace).holds)) {
        return undefined;
      }
      return { is: "read-back", failed: r.is };
    } finally {
      await c.palace.close();
    }
  }

  // Starts a hub (Q24): the environment's own Python with -I and the server module, hidden, outliving the window (not
  // in `running`), with step 16's hub environment; then waits, within the start limit, for its health answer and for
  // its serverinfo.json naming the port (MemPalace writes it after the bind), and reads the serving process's start
  // time within its own limit. A start that exits with code 2 (Q8) means another window's hub holds the palace: that
  // hub is found the same way and used. A start that passes the limit is ended (only the child this window started,
  // whose exit it has not seen, as killTree requires).
  private async start(): Promise<{ record: HubRecord } | { why: Why }> {
    let port: number;
    try {
      port = await freePort();
    } catch (err) {
      return { why: { is: "no port", detail: message(err) } };
    }
    const p = this.launch(this.paths.envPython);
    const began = performance.now();
    const left = () => this.f.startLimit - (performance.now() - began);
    let child: ChildProcess;
    let exited: { code: number | null; error?: string } | undefined;
    try {
      child = spawn(p.command, [...p.args, "-I", "-m", "mempalace.mcp_server", ...moduleArgs(port, this.paths.palace)],
        { cwd: this.paths.home, env: hubEnv(this.paths, this.env), detached: true, windowsHide: true,
          stdio: "ignore" });
    } catch (err) {
      return { why: { is: "not started", detail: message(err) } };
    }
    child.once("exit", (code) => (exited ??= { code }));
    child.once("error", (err) => (exited ??= { code: null, error: message(err) }));
    child.unref();
    const end = () => {
      if (!exited) killTree(child);
    };

    let answered = false;
    while (!exited && !answered && left() > 0) {
      answered = await healthy(port, this.f.health);
      if (!answered && !exited) await wait(this.f.startCheck);
    }
    if (!answered) {
      if (exited?.error !== undefined) return { why: { is: "not started", detail: exited.error } };
      if (exited?.code === 2) {
        const other = await this.another(left);
        return other ? { record: other } : { why: { is: "exited", code: 2 } };
      }
      if (exited) return { why: { is: "exited", code: exited.code } };
      end();
      return { why: { is: "start limit" } };
    }
    let info = this.serverinfos().find((i) => i.port === port);
    while (!info && !exited && left() > 0) {
      await wait(this.f.startCheck);
      info = this.serverinfos().find((i) => i.port === port);
    }
    if (!info) {
      end();
      return { why: exited ? { is: "exited", code: exited.code } : { is: "start limit" } };
    }
    const start = await this.startTime(info.pid);
    if (!start) {
      end();
      return { why: { is: "start time" } };
    }
    return { record: { env: this.paths.env, port, pid: info.pid, start, stopping: false } };
  }

  // Another window's hub for this palace, after a start that exited with code 2: its serverinfo.json by the listing,
  // and its health check, within what is left of the start limit. A file a hard-stopped hub left behind is passed
  // over by its health check.
  private async another(left: () => number): Promise<HubRecord | undefined> {
    for (;;) {
      for (const info of this.serverinfos()) {
        if (!(await healthy(info.port, this.f.health))) continue;
        const start = await this.startTime(info.pid);
        if (start) return { env: null, port: info.port, pid: info.pid, start, stopping: false };
      }
      if (left() <= 0) return undefined;
      await wait(this.f.startCheck);
    }
  }

  // MemPalace's own records of hubs for this palace (Q7): every memory/home/.mempalace/server/*/serverinfo.json whose
  // palace_path is this palace's, compared without regard to letter case. The folder's name is never worked out here.
  private serverinfos(): { pid: number; port: number }[] {
    const root = path.join(this.paths.home, ".mempalace", "server");
    let keys: string[];
    try {
      keys = readdirSync(root);
    } catch {
      return [];
    }
    const want = path.resolve(this.paths.palace).toLowerCase();
    return keys.flatMap((key) => {
      try {
        const info = JSON.parse(readFileSync(path.join(root, key, "serverinfo.json"), "utf8"));
        const ours = path.resolve(String(info.palace_path)).toLowerCase() === want;
        return ours && typeof info.pid === "number" && typeof info.port === "number" ? [info] : [];
      } catch {
        return [];
      }
    });
  }

  private async startTime(pid: number): Promise<string | undefined> {
    const said = await this.helper(["start", String(pid)], this.f.startRead);
    return said && said !== "gone" && !said.startsWith("unopened") ? said : undefined;
  }

  // The helper, run by the environment's own Python with -I, in `running` so it dies with the window, ended when it
  // passes its limit (it then answers nothing).
  private helper(args: string[], limit: number): Promise<string | undefined> {
    const p = this.launch(this.paths.envPython);
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(p.command, [...p.args, "-I", "-c", HELPER, ...args], { cwd: this.paths.home,
          env: hubEnv(this.paths, this.env), windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        return resolve(undefined);
      }
      running.add(child);
      const out = collect(child.stdout!);
      let late = false;
      const timer = setTimeout(() => {
        late = true;
        killTree(child);
      }, limit);
      const done = (said: string | undefined) => {
        clearTimeout(timer);
        running.delete(child);
        resolve(said);
      };
      child.once("error", () => done(undefined));
      child.once("close", () => done(late ? undefined : out().trim()));
    });
  }

  // The design's leave: take the lock, remove this window's file, and if no other fresh file is left: mark the hub
  // stopping, stop it by the serving process's id once its start time is read again and is the recorded one, wait for
  // every process of it, clear the record, let go. Only the helper's word that the serving process ended clears the
  // record (the user's choice at step 20's review): "stopped", or "running", the wait after TerminateProcess past its
  // limit, which the user's late-stop rule counts as stopped (step 20's run 3), or "gone", no such process any more.
  // Anything else (another program's id, a process that could not be opened, no answer within the stop's limit)
  // keeps the record, marked stopping, so the next window starts or finds the hub again and stops it when it leaves.
  // The caller's signal ends the wait for a join under way, as it ends the wait for the lock. MemPalace's own files
  // are left as MemPalace leaves them.
  private async leave(signal?: AbortSignal): Promise<Left> {
    this.closing.abort();
    this.stopTimer();
    await Promise.race([this.busy, fired(signal)]);
    let lock: OsLock | null;
    let failed = false;
    try {
      lock = await this.take(signal);
    } catch {
      lock = null;
      failed = true;
    }
    try {
      rmSync(this.inUse, { force: true });
      if (!lock) {
        if (failed) this.markStopping();
        return { is: "gave up" };
      }
      if (this.others()) return { is: "left" };
      const rec = this.record();
      if (!rec) return { is: "left" };
      this.write(hubRecord(this.paths), { ...rec, stopping: true });
      const said = await this.helper(["stop", String(rec.pid), rec.start, String(this.f.stop),
        path.dirname(this.paths.env)], this.f.stop);
      const word = said?.split(" ")[0];
      if (word === "stopped" || word === "running" || word === "gone") {
        rmSync(hubRecord(this.paths), { force: true });
        return word === "gone" ? { is: "left" } : { is: "stopped" };
      }
      if (word === "differs") return { is: "not stopped", why: "the id is another program's" };
      if (word === "unopened") return { is: "not stopped", why: "the process could not be opened" };
      return { is: "not stopped", why: "the helper gave no answer" };
    } catch {
      return { is: "left" };
    } finally {
      lock?.release();
    }
  }

  // A leave whose take of the lock failed: as the last window, the record is marked stopping, so the next window
  // treats the hub as one to start or find again, and stops it when it leaves (the user's choice at step 20's
  // review). Done without the lock, as it could not be taken; a window still using the hub would only join it again.
  private markStopping(): void {
    try {
      if (this.others()) return;
      const rec = this.record();
      if (rec && !rec.stopping) this.write(hubRecord(this.paths), { ...rec, stopping: true });
    } catch {
      // the folder is gone or cannot be written: there is no record left to mark
    }
  }

  // The join lock, in memory/home (the design: one lock covers joining and stopping), tried every lockRetry; null once
  // the signal fires. Never taken while this window holds it: joins run one at a time, and the leave waits for them.
  private async take(signal?: AbortSignal): Promise<OsLock | null> {
    for (;;) {
      if (signal?.aborted) return null;
      const lock = tryLock(this.paths.home, "join");
      if (lock) return lock;
      await wait(this.f.lockRetry, signal);
    }
  }

  // This window's "in use" file, rewritten: its time is what counts.
  private touch(): void {
    writeFileSync(this.inUse, `${JSON.stringify({ pid: process.pid })}\n`);
  }

  // Whether another window's "in use" file is still fresh (younger than the stale age).
  private others(): boolean {
    const now = Date.now();
    return readdirSync(this.paths.home).some((name) => {
      const file = path.join(this.paths.home, name);
      if (!name.startsWith(IN_USE) || same(file, this.inUse)) return false;
      try {
        return now - statSync(file).mtimeMs < this.f.stale;
      } catch {
        return false;
      }
    });
  }

  private record(): HubRecord | undefined {
    try {
      const r = JSON.parse(readFileSync(hubRecord(this.paths), "utf8"));
      const fine = typeof r.port === "number" && typeof r.pid === "number" && typeof r.start === "string" &&
        typeof r.stopping === "boolean" && (r.env === null || typeof r.env === "string");
      return fine ? r : undefined;
    } catch {
      return undefined;
    }
  }

  private palaceVersion(): string | undefined {
    try {
      const v = JSON.parse(readFileSync(versionFile(this.paths), "utf8")).mempalace;
      return typeof v === "string" ? v : undefined;
    } catch {
      return undefined;
    }
  }

  // Written whole: to a file of this window's beside it, then moved into place, so no reader sees half of it.
  private write(file: string, value: unknown): void {
    const part = `${file}.${path.basename(this.inUse)}.part`;
    writeFileSync(part, `${JSON.stringify(value)}\n`);
    renameSync(part, file);
  }

  // An old environment folder goes only under the join lock, when no hub runs from it (not this window's, not the
  // hub's; none while the hub's own folder is not known) and its ready file's version is older than the palace's.
  private removeOld(hub: HubRecord): void {
    const version = this.palaceVersion();
    if (!version || hub.env === null) return;
    const top = path.dirname(this.paths.env);
    for (const name of readdirSync(top)) {
      const dir = path.join(top, name);
      if (same(dir, this.paths.env) || same(dir, hub.env)) continue;
      let ready: unknown;
      try {
        ready = JSON.parse(readFileSync(readyFile({ ...this.paths, env: dir }), "utf8")).mempalace;
      } catch {
        continue;
      }
      if (typeof ready === "string" && newer(version, ready)) rmSync(dir, { recursive: true, force: true });
    }
  }
}
