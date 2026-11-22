import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer as httpServer, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
// @ts-expect-error: a build script in plain JavaScript, with no type file.
import { FAMILIES } from "../../scripts/8d/lesson-families.mjs";
// @ts-expect-error: a build script in plain JavaScript, with no type file.
import { compare, snapshot, userFolders } from "../../scripts/8d/throwaway.mjs";
import { PermissionGate } from "../../src/core/permissions.js";
import { Session } from "../../src/core/session.js";
import { localDate } from "../../src/core/setup.js";
import { commandEnv } from "../../src/exec/env.js";
import { connect, Palace, palaceFile } from "../../src/memory/client.js";
import { FIGURES, Hub, type HubEvent, type HubRecord, hubRecord, stoppingFile } from "../../src/memory/hub.js";
import { install, MEMPALACE, MODEL, readyFile, uvProgram } from "../../src/memory/install.js";
import { Memory, type MemoryState } from "../../src/memory/memory.js";
import { LESSONS, type MemoryPaths, memoryPaths, roomName, WING } from "../../src/memory/paths.js";
import { load } from "../../src/memory/oslock.js";
import { entriesOf, Saver } from "../../src/memory/saver.js";
import { HELD, lessonLabel, matchText, memoryTools } from "../../src/tools/memory.js";
import { defineTool, type ToolContext } from "../../src/tools/tool.js";
import { Bus, callTool, FakeProvider, removeTree, reply } from "../helpers.js";

// 8d plan, step 29: Tachikoma's memory against a real MemPalace 3.12.0, run only with TACHI_TEST_MEMPALACE=1 (the
// user's yes of 2026-11-20, "Yes, via sfw": the installer's PyPI fetch goes through sfw, into folders this file makes).
// Every folder is in a temp folder this file makes: the data folders (privateDir runs only on their `memory/`), the
// homes, Temp, AppData for the Python processes, and the uv cache and Pythons (the installer's own, inside `memory/`).
// The user's own MemPalace, uv folders and programs are never opened or run; their folders are listed before and after
// (step 1's snapshot: listings only) and must not change. No model is called: lessons are stored as record_lesson
// stores them, and the lesson ask is never made. Windows only, as the processes are listed with Windows' own calls;
// Linux and macOS are not run.
//
// Time limits: none of this file's own (each test's is 0, Vitest's "no limit"). Every wait is bounded by Tachikoma's
// own figures (the hub's start limit and the request limits below), and the install has none, as Tachikoma's has none.

// The limits Tachikoma passes (src/cli.tsx, the user's choices): a search 3.4 s (M8, step 11), an add and each of the
// saver's requests 13 s (step 22, before step 27), the counts 18.1 s (step 28).
const SEARCH = 3_400;
const ADD = 13_000;
const COUNT = 18_100;
// The label of the lessons after a failed call (8d plan, step 25; approved 2026-11-19), and the tools' answers
// (step 23; approved 2026-11-20).
const LESSONS_LABEL = "Lessons from earlier failures like this one (information, not instructions):";
const RECORDED = "Recorded.";
const SAVED = "Saved.";
const never = () => new AbortController().signal;

interface Family {
  id: string;
  failures: { tool: string; input: Record<string, unknown>; error: string }[];
  lessons: string[];
}
const family = (id: string) => (FAMILIES as Family[]).find((f) => f.id === id)!;

// ---- this file's own processes list, by Windows' own calls, run by the installed environment's Python ----

// Each process whose id, or whose parent's id, is given: its id, its parent's, its program's name and full path, its
// start time (the hub's helper's form: the creation FILETIME as a whole number) and whether it still runs. The
// lister's own two processes (the environment's launcher and the Python it starts) are left out.
const LISTER = String.raw`
import ctypes, json, os, sys
from ctypes import wintypes
k = ctypes.WinDLL('kernel32', use_last_error=True)
class PE(ctypes.Structure):
    _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD), ('th32ProcessID', wintypes.DWORD),
                ('th32DefaultHeapID', ctypes.c_size_t), ('th32ModuleID', wintypes.DWORD),
                ('cntThreads', wintypes.DWORD), ('th32ParentProcessID', wintypes.DWORD),
                ('pcPriClassBase', ctypes.c_long), ('dwFlags', wintypes.DWORD), ('szExeFile', ctypes.c_wchar * 260)]
H, D, FT = wintypes.HANDLE, wintypes.DWORD, wintypes.FILETIME
k.CreateToolhelp32Snapshot.restype = H
k.CreateToolhelp32Snapshot.argtypes = (D, D)
k.Process32FirstW.argtypes = (H, ctypes.POINTER(PE))
k.Process32NextW.argtypes = (H, ctypes.POINTER(PE))
k.OpenProcess.restype = H
k.OpenProcess.argtypes = (D, wintypes.BOOL, D)
k.GetProcessTimes.argtypes = (H,) + (ctypes.POINTER(FT),) * 4
k.GetExitCodeProcess.argtypes = (H, ctypes.POINTER(D))
k.QueryFullProcessImageNameW.argtypes = (H, D, wintypes.LPWSTR, ctypes.POINTER(D))
k.CloseHandle.argtypes = (H,)
want = {int(a) for a in sys.argv[1:]}
me = {os.getpid(), os.getppid()}
snap = k.CreateToolhelp32Snapshot(2, 0)
e = PE()
e.dwSize = ctypes.sizeof(PE)
rows = []
ok = k.Process32FirstW(snap, ctypes.byref(e))
while ok:
    if (e.th32ProcessID in want or e.th32ParentProcessID in want) and e.th32ProcessID not in me:
        rows.append((e.th32ProcessID, e.th32ParentProcessID, e.szExeFile))
    ok = k.Process32NextW(snap, ctypes.byref(e))
k.CloseHandle(snap)
out = []
for pid, ppid, name in rows:
    row = {'pid': pid, 'ppid': ppid, 'name': name, 'image': None, 'start': None, 'running': False}
    h = k.OpenProcess(0x1000, False, pid)
    if h:
        c, x, kt, u, code = FT(), FT(), FT(), FT(), D()
        if k.GetProcessTimes(h, ctypes.byref(c), ctypes.byref(x), ctypes.byref(kt), ctypes.byref(u)):
            row['start'] = str((c.dwHighDateTime << 32) | c.dwLowDateTime)
        row['running'] = bool(k.GetExitCodeProcess(h, ctypes.byref(code))) and code.value == 259
        buf, n = ctypes.create_unicode_buffer(32768), D(32768)
        if k.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n)):
            row['image'] = buf.value
        k.CloseHandle(h)
    out.append(row)
print(json.dumps(out))
`;

interface Proc {
  pid: number;
  ppid: number;
  name: string;
  image: string | null;
  start: string | null;
  running: boolean;
}

const lower = (p: string | null) => (p ? path.resolve(p).toLowerCase() : "");
// Start times compared as numbers.
const time = (s: string | null) => BigInt(s ?? "0");

// ---- the user's own settings, never passed on ----

// What this file's processes never get from this one: the user's own MemPalace's settings (step 1's helper drops every
// MEMPALACE_ variable; the user's shell sets two), and the variables steps 3 to 5 kept out of uv, Python and chromadb.
const theirs = (name: string) => /^(MEMPALACE_|MEMPAL_|HF_|CHROMA_|PYTHON|UV_|XDG_|VIRTUAL_ENV$)/i.test(name);

// This process's environment without the API keys (commandEnv) and the user's settings above, with its home and Temp
// in `dir`, and `more`; names compared without regard to case, as Windows treats them.
function envOf(dir: string, more: Record<string, string> = {}): NodeJS.ProcessEnv {
  const home = path.join(dir, "home");
  const tmp = path.join(dir, "tmp");
  for (const d of [home, tmp]) mkdirSync(d, { recursive: true });
  const set: Record<string, string> = { USERPROFILE: home, HOME: home, TEMP: tmp, TMP: tmp, TMPDIR: tmp, ...more };
  const kept = Object.entries(commandEnv(process.env)).filter(([k]) => !(k.toUpperCase() in set) && !theirs(k));
  return { ...Object.fromEntries(kept), ...set };
}

// AppData inside `dir` too, for the Python processes, which need none of the user's.
const appData = (dir: string) => ({
  APPDATA: path.join(dir, "home", "AppData", "Roaming"),
  LOCALAPPDATA: path.join(dir, "home", "AppData", "Local"),
});

// The files under `dir`, by path within it (a missing folder has none).
function filesIn(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string, rel: string) => {
    let list;
    try {
      list = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && !e.isSymbolicLink()) walk(path.join(at, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, "");
  return out.sort();
}

// A snapshot line's times (milliseconds since 1970, as the snapshot records them) also in UTC, to trace a change.
const traced = (line: string) =>
  line.replace(/\b(1\d{12}(?:\.\d+)?)\b/g, (ms) => `${ms} (${new Date(Math.floor(Number(ms))).toISOString()})`);

// A made-up text of `n` characters, the same every time: words from a fixed list, picked by a simple generator.
function words(n: number, seed = 1): string {
  const list = ["amber", "basil", "cedar", "delta", "ember", "fable", "grove", "harbor", "iris", "juniper", "kelp",
    "lantern", "meadow", "nectar", "orchid", "pebble", "quartz", "river", "sable", "thistle", "umber", "violet",
    "willow", "yarrow", "zephyr"];
  let x = seed;
  let s = "";
  while (s.length < n) {
    x = (x * 1103515245 + 12345) % 2147483648;
    s += `${list[x % list.length]} `;
  }
  return s.slice(0, n);
}

describe.runIf(process.env.TACHI_TEST_MEMPALACE === "1")("a real MemPalace", { timeout: 0 }, () => {
  let before: unknown;
  // The user's folders, named once, before any test changes this process's environment (the user's-program test
  // replaces its home for a while).
  let folders: unknown;
  let root: string;
  let p1: MemoryPaths;
  let installEnv: NodeJS.ProcessEnv;
  let hubBase: NodeJS.ProcessEnv;
  let project: string;
  let ROOM: string;
  let cacheAfterInstall: string[];
  // The dead-end proxy: every child of the hub's and the user's program's environments is pointed at it, and it records
  // and refuses every connection (steps 5, 6 and 20's watch).
  const proxied: string[] = [];
  const proxy = createServer((sock) => {
    proxied.push(`${sock.remoteAddress}:${sock.remotePort}`);
    sock.on("error", () => {});
    sock.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  let modelServer: Server | undefined;
  // Every hub, Memory and process this file starts, so that whatever a failure leaves open is closed at the end.
  const hubs: Hub[] = [];
  const memories: Memory[] = [];
  const hubTrees: Proc[][] = [];
  let memory: Memory;
  let tools: ReturnType<typeof memoryTools>;
  const CTX = {} as ToolContext;

  // Within the stop's limit (step 20's run 3, 5 x 257.5 ms): the measured run of the environment's Python that walks
  // the same list of processes and opens them, as this lister does.
  const list = (pids: number[]): Proc[] => {
    if (process.platform !== "win32") throw new Error("this file lists processes on Windows only");
    const r = spawnSync(p1.envPython, ["-I", "-c", LISTER, ...pids.map(String)], { env: hubBase, encoding: "utf8",
      windowsHide: true, timeout: FIGURES.stop });
    if (r.status !== 0) throw new Error(`the process list failed: ${r.error ?? r.stderr}`);
    return JSON.parse(r.stdout) as Proc[];
  };
  // A hub's processes, from its record: the serving process (its id and start time as recorded), the environment's
  // launcher that started it (its parent, started before it) and what it started (its console host, started after it).
  const treeOf = (rec: HubRecord): Proc[] => {
    const serving = list([rec.pid]).filter((p) =>
      p.pid === rec.pid || (p.ppid === rec.pid && time(p.start) >= time(rec.start)));
    const self = serving.find((p) => p.pid === rec.pid && p.start === rec.start);
    if (!self?.running) throw new Error(`the hub's serving process ${rec.pid} is not running`);
    const launcher = list([self.ppid]).find((p) => p.pid === self.ppid && time(p.start) <= time(rec.start));
    const tree = [...(launcher ? [launcher] : []), ...serving];
    hubTrees.push(tree);
    return tree;
  };
  // Of the processes listed earlier, those still running with the same start time.
  const stillRunning = (procs: Proc[]) => {
    const now = list(procs.map((p) => p.pid));
    return procs.filter((p) => now.some((n) => n.pid === p.pid && n.start === p.start && n.running));
  };
  const recordOf = (p: MemoryPaths) => JSON.parse(readFileSync(hubRecord(p), "utf8")) as HubRecord;
  const writeRecord = (p: MemoryPaths, rec: HubRecord) => writeFileSync(hubRecord(p), `${JSON.stringify(rec)}\n`);
  const urlOf = (rec: HubRecord) => `http://127.0.0.1:${rec.port}/mcp`;
  // MemPalace's own records of hubs for a palace: every <home>/.mempalace/server/*/serverinfo.json whose palace_path is
  // the palace's, compared without regard to letter case (Q7), as the supervisor finds them.
  const serverinfos = (p: MemoryPaths) => {
    const top = path.join(p.home, ".mempalace", "server");
    return readdirSync(top).flatMap((key) => {
      const file = path.join(top, key, "serverinfo.json");
      if (!existsSync(file)) return [];
      const info = JSON.parse(readFileSync(file, "utf8")) as { pid: number; port: number; palace_path: string };
      return lower(info.palace_path) === lower(p.palace) ? [info] : [];
    });
  };
  const healthz = async (port: number) => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(FIGURES.health) });
      await r.text();
      return r.status === 200;
    } catch {
      return false;
    }
  };
  // Waits until `check` holds, looking every startCheck (M3), for at most `ms`.
  const eventually = async (check: () => boolean, ms: number, what: string) => {
    const began = performance.now();
    while (!check()) {
      if (performance.now() - began > ms) throw new Error(`not within ${ms} ms: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, FIGURES.startCheck));
    }
  };
  // `p`, or a failure once `ms` have passed.
  const within = <T>(p: Promise<T>, ms: number, what: string, onLate = () => {}) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        onLate();
        reject(new Error(`not within ${ms} ms: ${what}`));
      }, ms);
      p.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  // A join, as the supervisor bounds its steps: the start limit (M3; health checks and serverinfo.json inside it), the
  // start-time read after it (PR #26 Codex review, round 3), and the read-back's connect and status (step 20's run 3);
  // and Memory's own connect to the hub after it, within the read-back's limit too (step 21).
  const JOIN = FIGURES.startLimit + FIGURES.startRead + 2 * FIGURES.readBack;
  // The first state a Memory reaches after setting up: on, or why not, within a join's bound.
  const settled = (bus: Bus) =>
    within(new Promise<MemoryState>((resolve) => {
      bus.on("memory", (s) => {
        if (s.is !== "setting up") resolve(s);
      });
    }), JOIN, "memory settling");
  // The entries of a room as the palace file holds them: each one's label and whole text, its pieces joined in their
  // order, as MemPalace's own get tool joins them ("".join of the pieces sorted by chunk_index,
  // mempalace/mcp_server/tools_write.py, _chunk_group_record). Read from the file read-only, as palaceFile reads it
  // (step 6 item 12: this works while the hub runs), so nothing here waits: MemPalace's list and get tools were never
  // timed in the build.
  function stored(room: string): { label: string; content: string }[] {
    const db = new (load().DatabaseSync)(path.join(p1.palace, "sqlite_exact.sqlite3"), { readOnly: true });
    try {
      const rows = db.prepare("SELECT d.id, d.document, d.metadata_json FROM documents d JOIN collections c " +
        "ON c.id = d.collection_id WHERE c.name = 'mempalace_drawers'").all() as unknown as
        { id: string; document: string; metadata_json: string }[];
      const entries = new Map<string, { label: string; pieces: { at: number; id: string; text: string }[] }>();
      for (const r of rows) {
        const m = JSON.parse(r.metadata_json) as Record<string, unknown>;
        if (m.wing !== WING || m.room !== room) continue;
        const key = typeof m.parent_drawer_id === "string" ? m.parent_drawer_id : r.id;
        const e = entries.get(key) ?? { label: String(m.source_file), pieces: [] };
        e.pieces.push({ at: Number(m.chunk_index ?? 0), id: r.id, text: r.document });
        entries.set(key, e);
      }
      return [...entries.values()].map((e) => ({ label: e.label, content: e.pieces
        .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)).map((p) => p.text).join("") }));
    } finally {
      db.close();
    }
  }
  const palace = () => {
    const p = memory.palace;
    if (!p) throw new Error("memory is not connected");
    return p;
  };
  const hubUrl = () => urlOf(recordOf(p1));
  // A turn for the saver, counting its saved records.
  const turnOf = (n: number, typed: string, texts: string[]) => {
    const t = { session: "real-1", n, typed, texts, saved: 0, record: () => void t.saved++ };
    return t;
  };
  const saverOf = (palaceNow: () => Palace | undefined) =>
    new Saver({ memory: { get palace() { return palaceNow(); } }, room: ROOM, folder: p1.root, timeout: ADD });
  // The palace with each add seen as it ends.
  const watching = (p: Palace, seen: (label: string, is: string) => void) =>
    ({
      offers: p.offers,
      pieces: (label: string, ms: number) => p.pieces(label, ms),
      remove: (label: string, ms: number) => p.remove(label, ms),
      add: async (room: string, label: string, text: string, ms: number) => {
        const r = await p.add(room, label, text, ms);
        seen(label, r.is);
        return r;
      },
    }) as unknown as Palace;

  beforeAll(async () => {
    // First, before anything runs: the user's folders, listed (step 1's helper; about 50 s on this PC).
    folders = userFolders();
    before = snapshot(folders);
    root = await mkdtemp(path.join(tmpdir(), "tm-"));
    p1 = memoryPaths(path.join(root, "d1"));
    project = path.join(root, "project");
    mkdirSync(project);
    ROOM = roomName(project);
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const dead = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    // The installer's: this process's PATH, where uv and sfw are, and AppData in this file's folder too (uv's own
    // folders are all inside memory/, and UV_NO_CONFIG keeps it from the user's config).
    const installDir = path.join(root, "install-env");
    installEnv = envOf(installDir, appData(installDir));
    // The hub's: AppData in this file's folder, and the dead-end proxy.
    const hubDir = path.join(root, "hub-env");
    hubBase = envOf(hubDir, { ...appData(hubDir), HTTP_PROXY: dead, HTTPS_PROXY: dead, ALL_PROXY: dead,
      NO_PROXY: "127.0.0.1,localhost,::1" });
  }, 0);

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const m of memories) await m.close({ lessons: "cancel" });
    for (const h of hubs) await h.close();
    proxy.close();
    modelServer?.close();
    // A folder still in use (a process a failure left running) stays, and says so.
    if (root) await removeTree(root).catch((err) => console.log(`${root} was not removed: ${String(err)}`));
  }, 0);

  it("installs MemPalace from the shipped lock, through sfw, into its own folder", async () => {
    const uv = uvProgram(installEnv);
    if (!uv) throw new Error("uv is not on PATH");
    if (!/^sfw(\.exe|\.cmd)$/i.test(path.basename(uv.command))) {
      throw new Error("sfw is not on PATH: this test does not fetch without it");
    }
    const began = performance.now();
    expect(await install({ paths: p1, env: installEnv })).toEqual({ is: "ready", version: MEMPALACE });
    console.log(`install: ${Math.round(performance.now() - began)} ms`);
    expect(existsSync(readyFile(p1))).toBe(true);
    expect(existsSync(p1.envPython)).toBe(true);
    cacheAfterInstall = filesIn(path.join(p1.home, ".cache"));
  });

  let rec: HubRecord;
  let url: string;
  let token: string;
  let hubA: Hub;
  const eventsA: HubEvent[] = [];

  it("starts a hub by the supervisor, on a picked port, found by its serverinfo.json, with Tachikoma's storage " +
    "and model, and no `mempalace serve`", async () => {
    hubA = new Hub({ paths: p1, env: hubBase, onEvent: (e) => eventsA.push(e) });
    hubs.push(hubA);
    const a = await within(hubA.join(), JOIN, "hub A's join");
    if (a.is !== "on") throw new Error(`not on: ${JSON.stringify(a)}`);
    url = a.url;
    token = a.token;
    const port = Number(new URL(url).port);
    expect(port).not.toBe(8765);
    rec = recordOf(p1);
    expect(rec).toEqual({ env: p1.env, port, pid: rec.pid, start: rec.start, stopping: false, token: true });
    expect(serverinfos(p1)).toEqual([expect.objectContaining({ pid: rec.pid, port })]);
    expect(await healthz(port)).toBe(true);

    // It serves: an add and a search, through Tachikoma's own client.
    const c = await connect({ url, token }, "own", { timeout: FIGURES.readBack });
    if (c.is !== "connected") throw new Error(`not connected: ${JSON.stringify(c)}`);
    try {
      expect(c.palace.offers.missing).toEqual([]);
      expect(await c.palace.add("check", "tachikoma check, 1", "A first entry, to check the hub serves.", ADD))
        .toEqual({ is: "added" });
      const found = await c.palace.search("a first entry", { room: "check" }, 5, SEARCH);
      expect(found.is === "found" && found.hits.map((h) => h.label)).toEqual(["tachikoma check, 1"]);
      // The read-back (step 6 item 12): the hub's backend, and the model the palace file records once written.
      expect(await c.palace.inForce(p1.palace, FIGURES.readBack))
        .toEqual({ is: "read", backend: "sqlite_exact", model: "minilm" });
    } finally {
      await c.palace.close();
    }
    expect(palaceFile(p1.palace)).toEqual({ holds: "model", model: "minilm" });
    expect(existsSync(path.join(p1.palace, "sqlite_exact.sqlite3"))).toBe(true);
    expect(existsSync(path.join(p1.palace, "chroma.sqlite3"))).toBe(false);

    // Its processes: the environment's own Python, started by this process, and the one it started to serve; none is
    // MemPalace's own program, so `mempalace serve` was never run.
    const tree = treeOf(rec);
    const launcher = tree.find((p) => p.pid !== rec.pid && p.ppid !== rec.pid)!;
    expect(lower(launcher.image)).toBe(lower(p1.envPython));
    expect(launcher.ppid).toBe(process.pid);
    expect(tree.find((p) => p.pid === rec.pid)!.name.toLowerCase()).toBe("python.exe");
    expect(tree.filter((p) => /^mempalace/i.test(p.name))).toEqual([]);
  });

  it("joins again a hub the timer finds named by the stopping marker", async () => {
    writeFileSync(stoppingFile(p1), `${JSON.stringify({ pid: rec.pid, start: rec.start })}\n`);
    // The timer looks every refresh; the join then starts a hub, which exits with code 2 as this hub holds the
    // palace, and finds this hub, all within the start limit; then the read-back.
    await eventually(() => eventsA.some((e) => e.is === "on"), FIGURES.refresh + FIGURES.startLimit + FIGURES.readBack,
      "the timer's join");
    expect(eventsA).toEqual([{ is: "failing" }, { is: "on", url, token }]);
    expect(existsSync(stoppingFile(p1))).toBe(false);
    expect(recordOf(p1)).toEqual({ ...rec, env: null, token: true });
  });

  let hubB: Hub;

  it("gives a second window whose start exits with code 2 the first window's hub", async () => {
    // No record, so the second window starts a hub of its own, which finds the palace held.
    rmSync(hubRecord(p1));
    hubB = new Hub({ paths: p1, env: hubBase });
    hubs.push(hubB);
    expect(await within(hubB.join(), JOIN, "hub B's join")).toEqual({ is: "on", url, token });
    expect(recordOf(p1)).toEqual({ ...rec, env: null, token: true });
    // Only the first hub runs: this process's own Pythons are its launcher alone.
    const mine = list([process.pid]).filter((p) => p.ppid === process.pid && p.running && /^python/i.test(p.name));
    expect(mine.map((p) => p.pid)).toEqual([hubTrees[0]!.find((p) => p.ppid === process.pid)!.pid]);
  });

  it("stops the hub when the last of two windows leaves, by the serving process's id", async () => {
    const tree = hubTrees[0]!;
    expect(stillRunning(tree)).toEqual(tree);
    expect(await hubA.close()).toEqual({ is: "left" });
    expect(await healthz(rec.port)).toBe(true);
    expect(await hubB.close()).toEqual({ is: "stopped" });
    expect(stillRunning(tree)).toEqual([]);
    expect(existsSync(hubRecord(p1))).toBe(false);
    // A new hub can open the palace.
    const hubC = new Hub({ paths: p1, env: hubBase });
    hubs.push(hubC);
    expect((await within(hubC.join(), JOIN, "hub C's join")).is).toBe("on");
    const treeC = treeOf(recordOf(p1));
    expect(await hubC.close()).toEqual({ is: "stopped" });
    expect(stillRunning(treeC)).toEqual([]);
  });

  it("the stop's helper answers gone for a process that has ended, and unopened for one it may not open", async () => {
    const p3 = { ...memoryPaths(path.join(root, "d3"), "x"), env: p1.env, envPython: p1.envPython };
    mkdirSync(p3.home, { recursive: true });
    const ended = spawnSync(process.execPath, ["-e", ""], { env: hubBase, windowsHide: true });
    writeRecord(p3, { env: p1.env, port: 0, pid: ended.pid!, start: "1", stopping: false, token: true });
    const gone = new Hub({ paths: p3, env: hubBase });
    expect(await gone.close()).toEqual({ is: "left" });
    expect(existsSync(hubRecord(p3))).toBe(false);
    // Windows' System process (id 4), which no program of the user's may open to end. The helper only opens it, and
    // would end a process only if its start time were the one given, which "1" is not.
    writeRecord(p3, { env: p1.env, port: 0, pid: 4, start: "1", stopping: false, token: true });
    const unopened = new Hub({ paths: p3, env: hubBase });
    expect(await unopened.close()).toEqual({ is: "not stopped", why: "the process could not be opened" });
    expect(recordOf(p3)).toEqual({ env: p1.env, port: 0, pid: 4, start: "1", stopping: true, token: true });
  });

  it("turns memory on with Tachikoma's own palace", async () => {
    const bus = new Bus();
    memory = new Memory({ memory: "own", bus, lead: () => "fake:real", paths: p1, env: hubBase });
    memories.push(memory);
    expect(memory.state).toEqual({ is: "setting up" });
    const state = settled(bus);
    memory.start();
    expect(await state).toEqual({ is: "on" });
    treeOf(recordOf(p1));
    tools = memoryTools({ memory, room: ROOM, everything: "wing", session: () => "real-1",
      timeouts: { search: SEARCH, add: ADD } });
  });

  it("saves a turn once, and a search finds it", async () => {
    const turn = turnOf(1, "Why does npm test say that jest is not recognized?",
      ["jest was not installed in node_modules; running npm install first fixed it."]);
    const [entry] = entriesOf(turn);
    const first = saverOf(() => memory.palace);
    first.hand(turn);
    await first.run(never());
    expect([first.unsaved, turn.saved]).toEqual([0, 1]);
    // Handed again, as after a resume: found there, nothing added.
    const again = saverOf(() => memory.palace);
    again.hand(turn);
    await again.run(never());
    expect([again.unsaved, turn.saved]).toEqual([0, 2]);
    expect(await palace().pieces(entry!.label, ADD)).toEqual({ is: "counted", pieces: entry!.pieces });
    expect(stored(ROOM).filter((e) => e.label === entry!.label))
      .toEqual([{ label: entry!.label, content: entry!.text }]);
    const found = await palace().search("npm test says jest is not recognized", { room: ROOM }, 5, SEARCH);
    expect(found.is === "found" && found.hits.map((h) => h.label)).toContain(entry!.label);
  });

  it("repairs a turn whose save was cut off", async () => {
    const turn = turnOf(2, "Write out the steps.", [words(2_000)]);
    const [entry] = entriesOf(turn);
    expect(entry!.pieces).toBeGreaterThan(1);
    // A save cut off after its first piece's worth, under the turn's label.
    expect(await palace().add(ROOM, entry!.label, entry!.text.slice(0, 800), ADD)).toEqual({ is: "added" });
    expect(await palace().pieces(entry!.label, ADD)).toEqual({ is: "counted", pieces: 1 });
    const saver = saverOf(() => memory.palace);
    saver.hand(turn);
    await saver.run(never());
    expect([saver.unsaved, turn.saved]).toEqual([0, 1]);
    expect(await palace().pieces(entry!.label, ADD)).toEqual({ is: "counted", pieces: entry!.pieces });
    expect(stored(ROOM).filter((e) => e.label === entry!.label))
      .toEqual([{ label: entry!.label, content: entry!.text }]);
  });

  it("leaves one whole entry when two savers in two processes are given the same turn", async () => {
    const turn = turnOf(3, "Two windows, one turn.", [words(1_700, 3)]);
    const [entry] = entriesOf(turn);
    const dir = path.join(root, "children");
    mkdirSync(dir);
    const file = path.join(dir, "turn.json");
    const records = path.join(dir, "records.jsonl");
    writeFileSync(file, JSON.stringify({ session: turn.session, n: turn.n, typed: turn.typed, texts: turn.texts,
      room: ROOM }));
    const childDir = path.join(root, "child-env");
    const env = envOf(childDir, { ...appData(childDir), TSX_DISABLE_CACHE: "1", TACHI_TEST_HUB_TOKEN: token });
    // Each child within: its start, 5 times the slowest of 50 starts of this child as here, each to its exit when
    // refused at once (514.9 ms, so 2.6 s; scripts/8d/measure-close.mjs, step 29, 2026-11-20); its own requests, each
    // within the 13 s it is given (ADD), the connect, the look-up, a removal and the add; and, while the other child
    // holds the save lock, the other's look-up, removal and add.
    const CHILD = 2_600 + 7 * ADD;
    const run = () => {
      let child: ChildProcess | undefined;
      const ran = new Promise<{ code: number | null; out: string }>((resolve) => {
        child = spawn(process.execPath, ["--import", "tsx",
          path.resolve("tests/memory/saver-child.ts"), hubUrl(), p1.root, file, records],
        { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let out = "";
        child.stdout!.on("data", (d) => (out += d));
        child.stderr!.resume();
        child.on("close", (code) => resolve({ code, out: out.trim() }));
      });
      return within(ran, CHILD, "a child saver", () => child?.kill());
    };
    expect(await Promise.all([run(), run()])).toEqual([{ code: 0, out: "done 0" }, { code: 0, out: "done 0" }]);
    expect(readFileSync(records, "utf8").trim().split("\n")).toHaveLength(2);
    expect(await palace().pieces(entry!.label, ADD)).toEqual({ is: "counted", pieces: entry!.pieces });
    expect(stored(ROOM).filter((e) => e.label === entry!.label))
      .toEqual([{ label: entry!.label, content: entry!.text }]);
  });

  it("saves a turn of over 100,000 characters in parts, and finishes one stopped after its first part", async () => {
    const turn = turnOf(4, "Print the whole log.", [words(250_000, 4)]);
    const entries = entriesOf(turn);
    expect(entries.map((e) => e.label))
      .toEqual([1, 2, 3].map((k) => `tachikoma session real-1, turn 4, part ${k} of 3`));
    // The first save stops once its first part is in.
    const stop = new AbortController();
    const firstAdds: string[] = [];
    const first = saverOf(() => watching(palace(), (label) => {
      firstAdds.push(label);
      stop.abort();
    }));
    first.hand(turn);
    await first.run(stop.signal);
    expect([first.unsaved, turn.saved]).toEqual([1, 0]);
    // The next save finishes it, adding only the parts not in.
    const added: [string, string][] = [];
    const next = saverOf(() => watching(palace(), (label, is) => added.push([label, is])));
    next.hand(turn);
    await next.run(never());
    expect([next.unsaved, turn.saved]).toEqual([0, 1]);
    expect(firstAdds).toEqual([entries[0]!.label]);
    expect(added).toEqual([[entries[1]!.label, "added"], [entries[2]!.label, "added"]]);
    for (const e of entries) expect(await palace().pieces(e.label, ADD)).toEqual({ is: "counted", pieces: e.pieces });
    const all = stored(ROOM);
    const parts = entries.map((e) => all.filter((s) => s.label === e.label).map((s) => s.content));
    expect(parts).toEqual(entries.map((e) => [e.text]));
    expect(parts.flat().join("")).toBe([turn.typed, ...turn.texts].join("\n\n"));
  });

  it("stores a lesson once, and not the same lesson again", async () => {
    const lessons = (FAMILIES as Family[]).flatMap((f) => f.lessons);
    for (const lesson of lessons) expect(await tools.lesson.run({ lesson }, CTX)).toBe(RECORDED);
    expect(await tools.lesson.run({ lesson: lessons[0] }, CTX)).toBe(HELD);
    expect(await palace().entries(LESSONS, COUNT)).toEqual({ is: "counted", entries: lessons.length });
  });

  it("finds this project's entries and the lessons with one memory_search, closest first", async () => {
    const query = "npm test cannot find jest";
    const out = await tools.search.run({ query }, CTX);
    // Each room on its own, then merged closest first and cut to the search's 5, as "project" must give them.
    const hits = [];
    for (const room of [ROOM, LESSONS]) {
      const r = await palace().search(query, { room }, 5, SEARCH);
      if (r.is !== "found") throw new Error(`not found: ${JSON.stringify(r)}`);
      hits.push(...r.hits);
    }
    const closest = hits.sort((a, b) => a.distance - b.distance).slice(0, 5);
    expect(new Set(closest.map((h) => h.room))).toEqual(new Set([ROOM, LESSONS]));
    expect(out).toBe(closest.map(matchText).join("\n\n"));
  });

  // A lead's session whose model calls `tool` once, which fails with `error`, given lessons from this memory, as
  // step 27 passes them; the results its model was sent.
  async function failedOnce(tool: string, input: object, error: string): Promise<string[]> {
    const failing = defineTool(tool, "Always fails", z.object({ command: z.string().optional() }), async () => {
      throw new Error(error);
    });
    const ctx = { root: project, gate: new PermissionGate("never", async () => false) } as unknown as
      Omit<ToolContext, "signal">;
    const session = new Session({ lead: new FakeProvider("a", [callTool("c1", tool, input), reply("done")]),
      tools: [failing], system: "t", ctx, bus: new Bus(), lessons: { memory, timeout: SEARCH } });
    await session.send("go");
    return session.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "tool_result" ? [p.output] : [])));
  }
  const lessoned = (error: string, lesson: string) =>
    `${error}\n\n${LESSONS_LABEL}\n${localDate()} · ${lessonLabel(ROOM)} · ${LESSONS}\n${lesson}`;

  it("hands a failed call a lesson stored for a like failure", async () => {
    // Family N8 of the made-up set: its lesson is the closest to each of its failures, inside the cut-off, and every
    // other lesson is outside it (step 13's re-run).
    const n8 = family("N8");
    const f = n8.failures[1]!;
    expect(await failedOnce(f.tool, f.input, f.error)).toEqual([lessoned(f.error, n8.lessons[0]!)]);
  });

  it("hands a failed command the lesson written for that command's failure, searched by step 25's rule", async () => {
    // Family C1: a failed `npm test`; its two lessons are the closest to each of its failures, inside the cut-off,
    // and every other lesson is outside it (step 13's re-run). One lesson is handed (M5's count).
    const c1 = family("C1");
    const f = c1.failures[1]!;
    const out = await failedOnce(f.tool, f.input, f.error);
    expect(out).toHaveLength(1);
    expect(c1.lessons.map((l) => lessoned(f.error, l))).toContain(out[0]);
  });

  it("uses a MemPalace of the user's own as it is, with no backend, model or palace from Tachikoma", async () => {
    // A second install, apart from the first: its own data folder and environment, with the first's uv cache and
    // Python (nothing downloaded again) and the first's model, served on loopback to the installer, which checks it
    // against its hash as ever.
    const p2 = { ...memoryPaths(path.join(root, "d2")), uvCache: p1.uvCache, python: p1.python,
      pythonCache: p1.pythonCache, pythonBin: p1.pythonBin };
    const archive = path.join(p1.home, ".cache", "chroma", "onnx_models", "all-MiniLM-L6-v2", "onnx.tar.gz");
    modelServer = httpServer((_req, res) => {
      res.writeHead(200, { "Content-Length": statSync(archive).size });
      createReadStream(archive).pipe(res);
    });
    await new Promise<void>((resolve) => modelServer!.listen(0, "127.0.0.1", resolve));
    const model = { url: `http://127.0.0.1:${(modelServer.address() as { port: number }).port}/onnx.tar.gz`,
      sha256: MODEL.sha256 };
    expect(await install({ paths: p2, env: installEnv, model })).toEqual({ is: "ready", version: MEMPALACE });
    const program = path.join(p2.env, "Scripts", "mempalace-mcp.exe");
    expect(existsSync(program)).toBe(true);

    // The user's program gets this process's environment (commandEnv and nothing more): here its home is the second
    // install's, where the model is; Temp and AppData in this file's folders; PATH Windows' own folders only; the
    // dead-end proxy; and none of the user's MemPalace settings, so none of the hub's three can come from here.
    const dir = path.join(root, "use-env");
    const windows = process.env.SystemRoot ?? "C:\\Windows";
    const env = envOf(dir, { ...appData(dir), USERPROFILE: p2.home, HOME: p2.home, HTTP_PROXY: hubBase.HTTP_PROXY!,
      HTTPS_PROXY: hubBase.HTTPS_PROXY!, ALL_PROXY: hubBase.ALL_PROXY!, NO_PROXY: hubBase.NO_PROXY!,
      PATH: `${path.join(windows, "System32")};${windows}` });
    for (const name of Object.keys(process.env)) vi.stubEnv(name, undefined);
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    try {
      await useOwn(program, p2);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });

  // The rest of the user's-program test, with this process's environment replaced.
  async function useOwn(program: string, p2: MemoryPaths): Promise<void> {
    // What the program is started with, as the MCP library is given it; and no read-back is asked of it.
    const started: { command: string; args?: string[]; env?: Record<string, string>; child?: ChildProcess }[] = [];
    const start = StdioClientTransport.prototype.start;
    vi.spyOn(StdioClientTransport.prototype, "start").mockImplementation(async function (this: StdioClientTransport) {
      const params = (this as unknown as { _serverParams: { command: string; args?: string[];
        env?: Record<string, string> } })._serverParams;
      await start.call(this);
      started.push({ ...params, child: (this as unknown as { _process?: ChildProcess })._process });
    });
    const readBack = vi.spyOn(Palace.prototype, "inForce");

    const bus = new Bus();
    const m2 = new Memory({ memory: { use: program }, bus, lead: () => "fake:real" });
    memories.push(m2);
    const state = settled(bus);
    m2.start();
    expect(await state).toEqual({ is: "on" });
    expect(m2.palace!.offers.missing).toEqual([]);
    const own = memoryTools({ memory: m2, room: ROOM, everything: "palace", session: () => "real-2",
      timeouts: { search: SEARCH, add: ADD } });
    expect(await own.save.run({ text: "The user's own MemPalace keeps this note." }, CTX)).toBe(SAVED);
    expect(await own.search.run({ query: "the user's own MemPalace note", scope: "all" }, CTX))
      .toContain("The user's own MemPalace keeps this note.");

    expect(started.map((s) => [s.command, s.args])).toEqual([[program, []]]);
    const given = Object.keys(started[0]!.env ?? {}).map((k) => k.toUpperCase());
    for (const name of ["MEMPALACE_EMBEDDING_MODEL", "MEMPALACE_MCP_WRITER_WAIT_SECONDS", "MEMPALACE_MCP_IDLE_HOURS",
      "MEMPALACE_BACKEND", "MEMPALACE_PALACE_PATH"]) expect(given).not.toContain(name);
    expect(readBack).not.toHaveBeenCalled();
    // Its palace is MemPalace's own default, in the home it was given: a chroma one (MemPalace's default backend,
    // mempalace/palace/backend.py:47), not Tachikoma's sqlite_exact.
    const files = filesIn(p2.home);
    expect(files.filter((f) => f.endsWith("/chroma.sqlite3"))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith("sqlite_exact.sqlite3"))).toEqual([]);

    // The program and the Python it starts, then closed: the MCP library ends its input and waits for it to exit.
    // Each wait within 5 times the slowest of 50 clean closes of the same program, run as here
    // (scripts/8d/measure-close.mjs, step 29, 2026-11-20; the record is build-step-29.md, section 9): the close
    // 167.5 ms at most, so 0.9 s; the program had always exited when the close returned (code 0, 50 of 50), so the
    // wait after it gets 0.1 s, the rounding's least.
    const child = started[0]!.child!;
    const tree = list([child.pid!]);
    expect(tree.find((p) => p.pid === child.pid)?.name.toLowerCase()).toBe("mempalace-mcp.exe");
    await within(m2.close({ lessons: "cancel" }), 900, "the close of the user's program");
    if (child.exitCode === null && child.signalCode === null) {
      await within(new Promise((resolve) => child.once("exit", resolve)), 100, "the program's exit");
    }
    expect(child.exitCode).toBe(0);
    expect(stillRunning(tree)).toEqual([]);
  }

  it("downloads nothing at run time", () => {
    expect(proxied).toEqual([]);
    const now = filesIn(path.join(p1.home, ".cache"));
    expect(now.filter((f) => !cacheAfterInstall.includes(f))).toEqual([]);
  });

  it("leaves no process it started running", async () => {
    const last = recordOf(p1);
    await memory.close({ lessons: "cancel" });
    expect(existsSync(hubRecord(p1))).toBe(false);
    for (const tree of hubTrees) expect(stillRunning(tree)).toEqual([]);
    const mine = list([process.pid]).filter((p) => p.ppid === process.pid && p.running &&
      /^(python|pythonw|mempalace)/i.test(p.name));
    expect(mine).toEqual([]);
    expect(hubTrees.at(-1)!.some((p) => p.pid === last.pid && p.start === last.start)).toBe(true);
  });

  it("leaves the user's own MemPalace and uv folders as they were", () => {
    const { changes, apart } = compare(before, snapshot(folders)) as { changes: string[]; apart: string[] };
    for (const line of apart) console.log(`set apart, the user's own MemPalace at work: ${traced(line)}`);
    expect(changes.map(traced)).toEqual([]);
  });
});
