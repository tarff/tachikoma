// What MemPalace 3.12.0 really does, checked in the build folder (8d plan, step 6; the design's "Checked in the
// build"). Not part of Tachikoma: run by hand.
//
//   node scripts/8d/mempalace-checks.mjs run
//
// One run starts several hubs of the build's own MemPalace (never the user's), each by the full path of the build's
// Python, `-I`, with step 1's `install` environment and step 5's settings: HF_HUB_OFFLINE=1,
// MEMPALACE_EMBEDDING_MODEL=minilm, a dead-end proxy of this script's on 127.0.0.1 in HTTP_PROXY, HTTPS_PROXY and
// ALL_PROXY, and the same audit-hook wrapper as scripts/8d/model-check.mjs, which logs every name lookup, connection,
// send, HTTP request and child process Python code makes. Every palace is new, passed with --palace, and every hub is
// given --backend sqlite_exact except where item 12 makes a chroma palace on purpose. Ports are ones this script took
// from the system on 127.0.0.1 and let go just before use. The tool calls (items 4, 6 to 10 and 12) go to a hub
// started directly, `mempalace.mcp_server --transport http`, so the hook is in the process that serves them. Items 1,
// 2, 3 and 5 also start `mempalace serve`, whose real server is a child MemPalace starts itself, without -I and out of
// the hook's reach (mempalace/cli/cmd_serve.py:186-192); only the dead-end proxy watches that child.
//
// Processes: every process this script starts, and every process below one (found by its parent's id and a start
// time after its parent's), is recorded with its start time as Windows gives it. One is stopped only by its id, and
// only after its start time is read again and found the same, so a reused id is never hit. The run ends by stopping
// what is left of them and listing them all. No other process is stopped, signalled or asked about.
//
// GIVE_UP_MS and POLL_MS are this script's own cut-off and polling step, so that a run always ends: not figures for
// Tachikoma. The cut-off is above MemPalace's own 120 s writer wait (mempalace/mcp_server/runtime.py:217), which
// item 5 watches.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { commandEnv } from "../../src/exec/env.ts";
import { BUILD, throwaway } from "./throwaway.mjs";

const PYTHON = path.join(BUILD, "env", "Scripts", "python.exe");
const POWERSHELL = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0",
  "powershell.exe");
const GIVE_UP_MS = 180_000;
const POLL_MS = 100;
// The six files chromadb needs in place (chromadb/utils/embedding_functions/onnx_mini_lm_l6_v2.py:285-292; step 5).
const MODEL_FILES = ["config.json", "model.onnx", "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json",
  "vocab.txt"];
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const PROCESS_EVENTS = new Set(["subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.spawn",
  "os.startfile"]);
// MemPalace's chunk size, DEFAULT_CHUNK_SIZE (mempalace/config.py:415), for the expected piece counts in item 8.
const CHUNK = 800;

// The same wrapper as scripts/8d/model-check.mjs, but argv[0] is the module's name: the log file, the module, then
// the module's own arguments.
const WRAPPER = `
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
            log.write(json.dumps({'phase': phase, 'event': event, 'host': host, 'args': repr(args)[:300]}) + '\\n')
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
                      'httpx_proxies': {k: str(v) for k, v in get_environment_proxies().items()}}) + '\\n')
log.flush()
phase = 'server'
import runpy
module = sys.argv[2]
sys.argv = [module] + sys.argv[3:]
runpy.run_module(module, run_name='__main__', alter_sys=True)
`;

// Reads one process's start time from Windows (GetProcessTimes), as 100 ns steps since 1601, for item 2.
const START_TIME_PY = `
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

// Started by this script, it starts a hub detached and hidden, as a window would, prints its id and exits (item 3).
const STARTER = `
const { spawn } = require("node:child_process");
const { openSync } = require("node:fs");
const [file, out, err, cwd, ...args] = process.argv.slice(1);
const c = spawn(file, args, { cwd, detached: true, windowsHide: true, stdio: ["ignore", openSync(out, "w"),
  openSync(err, "w")] });
c.unref();
process.stdout.write(String(c.pid));
`;

// Dropped in every spelling, so only the values set below reach MemPalace (as scripts/8d/model-check.mjs).
const DROP =
  /^(HTTPS?_PROXY|ALL_PROXY|NO_PROXY|ANONYMIZED_TELEMETRY|CHROMA_.*|PYTHON.*|HF_HUB_OFFLINE|TRANSFORMERS_OFFLINE)$/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const since = (t0) => Math.round(performance.now() - t0);
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const tail = (file, n = 6) =>
  existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-n) : [];
const out = {};
const say = (...a) => console.log(...a);

// PowerShell, for what Node cannot read itself: a process's parent, name and start time.
function powershell(script) {
  const t0 = performance.now();
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const r = spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    env: commandEnv(process.env),
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`powershell exit ${r.status}: ${r.stderr}`);
  return { text: r.stdout.trim(), ms: since(t0) };
}

function cim(filter) {
  const { text, ms } = powershell(`$ErrorActionPreference = 'Stop'
$r = @(Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { [pscustomobject]@{
  pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name;
  created = $_.CreationDate.ToUniversalTime().ToString('o'); cmd = $_.CommandLine } })
ConvertTo-Json -InputObject $r -Compress -Depth 3`);
  const list = text ? JSON.parse(text) : [];
  return { list: Array.isArray(list) ? list : [list], ms };
}

// Every process this script started or found below one: id -> { label, created, name, ppid }.
const mine = new Map();
const stops = [];
// When each recorded process was last seen running: the time just before the look that found it. Windows gives a
// gone process's id to later processes, so a process naming a recorded one as its parent is this script's only if it
// started after that parent and no later than that parent was last seen running (`isMine`). Any other is not proven
// to be this script's, and is left alone.
const seen = new Map();
const nowIso = () => new Date().toISOString().replace("Z", "0000Z");
const isMine = (k) => {
  const parent = mine.get(k.ppid);
  return Boolean(parent && seen.has(k.ppid) && k.created >= parent.created && k.created <= seen.get(k.ppid));
};

function own(label, pid) {
  const at = nowIso();
  const [p] = cim(`ProcessId=${pid}`).list;
  if (p && !mine.has(pid)) mine.set(pid, { label, created: p.created, name: p.name, ppid: p.ppid });
  if (p && mine.get(pid).created === p.created) seen.set(pid, at);
  return p;
}

// The processes below `root`, by parent id, each started after its parent; recorded as this script's own.
function tree(label, root) {
  if (!mine.has(root)) own(label, root);
  const rows = mine.has(root) ? [{ pid: root, ...mine.get(root) }] : [];
  let frontier = rows.map((r) => r.pid);
  while (frontier.length) {
    running(frontier);
    const at = nowIso();
    const { list } = cim(frontier.map((p) => `ParentProcessId=${p}`).join(" OR "));
    const kids = list.filter(isMine);
    for (const k of kids) {
      if (!mine.has(k.pid)) mine.set(k.pid, { label, created: k.created, name: k.name, ppid: k.ppid });
      seen.set(k.pid, at);
      rows.push({ pid: k.pid, ...mine.get(k.pid), cmd: (k.cmd ?? "").replace(/\s+/g, " ").slice(0, 160) });
    }
    frontier = kids.map((k) => k.pid);
  }
  return rows.map(({ pid, ppid, name, created, cmd }) => ({ pid, ppid, name, created, cmd }));
}

// Which of `pids` still run as the process this script recorded (same id, same start time).
function running(pids) {
  if (!pids.length) return [];
  const at = nowIso();
  const { list } = cim(pids.map((p) => `ProcessId=${p}`).join(" OR "));
  const alive = list.filter((p) => mine.get(p.pid)?.created === p.created).map((p) => p.pid);
  for (const pid of alive) seen.set(pid, at);
  return alive;
}

// Stops one recorded process by its id, after reading its start time again.
function stop(pid, why) {
  const rec = mine.get(pid);
  const { list } = cim(`ProcessId=${pid}`);
  let result;
  if (!rec) result = "not this script's: not stopped";
  else if (!list.length) result = "already gone";
  else if (list[0].created !== rec.created) result = "id now used by another process: not stopped";
  else {
    process.kill(pid);
    result = "stopped";
  }
  stops.push({ pid, name: rec?.name, label: rec?.label, why, result });
  return result;
}

async function waitGone(pids) {
  const t0 = performance.now();
  for (;;) {
    const left = running(pids);
    if (!left.length) return { ms: since(t0), left };
    if (performance.now() - t0 > GIVE_UP_MS) return { ms: since(t0), left };
    await sleep(POLL_MS);
  }
}

async function http(port, route, { method = "GET", body, headers = {} } = {}) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      body,
      headers,
      signal: AbortSignal.timeout(GIVE_UP_MS),
    });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    return { error: e.cause?.code ?? e.message };
  }
}

const healthy = async (port) => (await http(port, "/healthz")).status === 200;

// Polls until the hub on `port` answers /healthz, the start `s` ends, or the cut-off passes.
async function waitHealthy(port, s) {
  const t0 = performance.now();
  for (;;) {
    if (await healthy(port)) return { ms: since(t0), ok: true };
    if (s?.exit) return { ms: since(t0), ok: false, exit: s.exit };
    if (performance.now() - t0 > GIVE_UP_MS) return { ms: since(t0), ok: false, cutOff: true };
    await sleep(POLL_MS);
  }
}

async function waitFor(test) {
  const t0 = performance.now();
  for (;;) {
    if (await test()) return { ms: since(t0), ok: true };
    if (performance.now() - t0 > GIVE_UP_MS) return { ms: since(t0), ok: false };
    await sleep(POLL_MS);
  }
}

async function freePort() {
  const s = createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
}

// Names, kinds and sizes under a folder, links not followed.
function listing(root) {
  const entries = {};
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) entries[r] = "link";
      else if (e.isDirectory()) {
        entries[r] = "dir";
        walk(p, r);
      } else entries[r] = `file ${lstatSync(p).size}`;
    }
  };
  if (existsSync(root)) walk(root, "");
  return entries;
}

// ---- the run ----

async function run() {
  const { dir, env: base } = throwaway("install");
  const home = base.USERPROFILE;
  const model = path.join(home, ".cache", "chroma", "onnx_models", "all-MiniLM-L6-v2", "onnx");
  for (const f of MODEL_FILES) if (!existsSync(path.join(model, f))) throw new Error(`the model is not in place: ${f}`);
  if (existsSync(path.join(home, ".mempalace", "updates.json"))) throw new Error("updates.json is in the build home");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(dir, `checks-${stamp}`);
  mkdirSync(runDir);
  const palaces = path.join(home, "palaces");
  mkdirSync(palaces, { recursive: true });
  const palace = (x) => path.join(palaces, `checks-${stamp}-${x}`);
  const homeBefore = listing(home);

  // The dead-end proxy: records each connection's first line and refuses it.
  const proxied = [];
  const listener = createServer((sock) => {
    const entry = { from: `${sock.remoteAddress}:${sock.remotePort}`, first: "" };
    proxied.push(entry);
    sock.once("data", (d) => (entry.first = d.toString("latin1").split("\r\n")[0]));
    sock.on("error", () => {});
    sock.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const proxy = `http://127.0.0.1:${listener.address().port}`;
  const env = Object.fromEntries(Object.entries(base).filter(([k]) => !DROP.test(k)));
  Object.assign(env, {
    HF_HUB_OFFLINE: "1",
    MEMPALACE_EMBEDDING_MODEL: "minilm",
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    NO_PROXY: "127.0.0.1,localhost,::1",
  });
  for (const k of Object.keys(env).sort()) {
    if (/^(USERPROFILE|HOME|HF_|MEMPALACE_|.*PROXY|XDG_)/i.test(k)) say(`env ${k}=${env[k]}`);
  }
  say(`run folder ${runDir}`);

  const starts = [];
  const files = (label) => ({
    audit: path.join(runDir, `${label}.audit.jsonl`),
    stdout: path.join(runDir, `${label}.stdout.log`),
    stderr: path.join(runDir, `${label}.stderr.log`),
  });
  const argsFor = (kind, port, where, backend) => {
    const common = ["--host", "127.0.0.1", "--port", String(port), "--palace", where, "--backend", backend];
    return kind === "serve" ? ["mempalace", "serve", ...common] : ["mempalace.mcp_server", "--transport", "http",
      ...common];
  };
  // A hub as this script's own child.
  const start = (label, kind, port, where, { extra = {}, backend = "sqlite_exact" } = {}) => {
    const f = files(label);
    const o = openSync(f.stdout, "w");
    const e = openSync(f.stderr, "w");
    const args = ["-I", "-c", WRAPPER, f.audit, ...argsFor(kind, port, where, backend)];
    const t0 = performance.now();
    const child = spawn(PYTHON, args, { cwd: home, env: { ...env, ...extra }, stdio: ["ignore", o, e],
      windowsHide: true });
    closeSync(o);
    closeSync(e);
    const s = { label, kind, port, palace: where, ...f, pid: child.pid, exit: null, t0 };
    s.exited = new Promise((resolve) => {
      child.on("close", (code, signal) => resolve((s.exit = { code, signal, ms: since(t0) })));
      child.on("error", (err) => resolve((s.exit = { code: null, error: err.message, ms: since(t0) })));
    });
    own(label, child.pid);
    starts.push(s);
    say(`start ${label}: ${kind} port ${port} palace ${path.basename(where)} pid ${child.pid}`);
    return s;
  };
  // A hub started by a short-lived starter process, detached and hidden; the starter exits at once (item 3).
  const startDetached = (label, kind, port, where) => {
    const f = files(label);
    const args = [PYTHON, f.stdout, f.stderr, home, "-I", "-c", WRAPPER, f.audit,
      ...argsFor(kind, port, where, "sqlite_exact")];
    const t0 = performance.now();
    const r = spawnSync(process.execPath, ["-e", STARTER, ...args], { env, encoding: "utf8", windowsHide: true,
      timeout: GIVE_UP_MS });
    const pid = Number(r.stdout);
    const s = { label, kind, port, palace: where, ...f, pid, starter: { status: r.status, ms: since(t0) }, t0 };
    if (Number.isInteger(pid) && pid > 0) own(label, pid);
    starts.push(s);
    say(`start ${label} (detached, by a starter that exited ${r.status}): ${kind} port ${port} pid ${pid}`);
    return s;
  };
  const serverinfos = () => {
    const root = path.join(home, ".mempalace", "server");
    if (!existsSync(root)) return [];
    return readdirSync(root).flatMap((key) => {
      const file = path.join(root, key, "serverinfo.json");
      return existsSync(file) ? [{ key, file, info: JSON.parse(readFileSync(file, "utf8")) }] : [];
    });
  };
  const infoFor = (where) => serverinfos().find((s) => s.info.palace_path === path.resolve(where));
  // Stops a whole recorded tree, the deepest process first.
  const stopTree = async (rows, why) => {
    for (const r of [...rows].reverse()) stop(r.pid, why);
    return waitGone(rows.map((r) => r.pid));
  };
  // Waits for a start that is expected to end by itself; one still running at the cut-off is stopped.
  const ends = async (s) => {
    await Promise.race([s.exited, sleep(GIVE_UP_MS)]);
    if (!s.exit) {
      await stopTree(tree(s.label, s.pid), `${s.label}: still running at the cut-off`);
      await s.exited;
    }
    return s.exit;
  };

  let client;
  try {
    // Item 10, second part: a file MemPalace does not know, in the palace folder before the first open.
    const A = palace("a");
    mkdirSync(A);
    const unknown = path.join(A, "tachikoma-palace.json");
    writeFileSync(unknown, `${JSON.stringify({ check: "8d step 6", newest: "3.12.0" })}\n`);
    const unknownBefore = { sha256: sha256(unknown), mtimeMs: statSync(unknown).mtimeMs };

    // ---- Item 1: a port Tachikoma picks, and one already taken ----
    let blockerHits = 0;
    const blocker = createServer((sock) => {
      blockerHits++;
      sock.destroy();
    });
    await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const taken = blocker.address().port;
    const h0 = start("h0-port-taken", "serve", taken, A);
    await ends(h0);
    await http(taken, "/healthz");
    out.item1 = {
      takenPort: { port: taken, exit: h0.exit, stderr: tail(h0.stderr, 4), stdout: tail(h0.stdout, 8),
        stillMine: blockerHits === 1, serverinfo: Boolean(infoFor(A)) },
    };
    await new Promise((resolve) => blocker.close(resolve));

    // A hub started directly (`python -I -c <wrapper> mempalace.mcp_server --transport http`, the server `serve`
    // runs as its child), so the audit hook is in the very process that serves the tool calls of items 4, 6 to 10
    // and 12. A `serve` hub's server is a child MemPalace starts itself, which the hook does not reach.
    const PD = await freePort();
    const hD = start("hd-direct", "direct", PD, A);
    const upD = await waitHealthy(PD, hD);
    if (!upD.ok) throw new Error(`hd did not come up: ${JSON.stringify(upD)} ${tail(hD.stderr).join(" | ")}`);
    const treeD = tree("hd-direct", hD.pid);

    // ---- Item 4: serverinfo.json ----
    const infoD = infoFor(A);
    const canonical = realpathSync.native(A);
    const key = createHash("sha256").update(canonical.toLowerCase().replace(/\//g, "\\")).digest("hex").slice(0, 24);
    out.item4 = { path: infoD?.file, info: infoD?.info, keyRecomputed: key, keyMatches: infoD?.key === key,
      serverDir: infoD ? readdirSync(path.dirname(infoD.file)) : [], directTree: treeD, directUp: upD };

    // ---- Item 6: the MCP client's HTTP transport, with its plain fetch ----
    const transportErrors = [];
    client = new Client({ name: "tachi-8d-checks", version: "0" });
    client.onerror = (err) => transportErrors.push(String(err?.message ?? err));
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PD}/mcp`));
    const tc0 = performance.now();
    await client.connect(transport);
    const connectMs = since(tc0);
    const { tools } = await client.listTools();
    const plain = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    const json = { "Content-Type": "application/json" };
    const asText = await http(PD, "/mcp", { method: "POST", body: JSON.stringify(plain),
      headers: { "Content-Type": "text/plain" } });
    const viaProxy = await http(PD, "/mcp", { method: "POST", body: JSON.stringify(plain),
      headers: { ...json, Via: "1.1 proxy" } });
    const forwarded = await http(PD, "/mcp", { method: "POST", body: JSON.stringify(plain),
      headers: { ...json, "X-Forwarded-For": "10.0.0.1" } });
    const asJson = await http(PD, "/mcp", { method: "POST", body: JSON.stringify(plain), headers: json });
    out.item6 = { connectMs, tools: tools.length, transportErrors: [...transportErrors],
      textPlain: { status: asText.status, body: asText.body?.slice(0, 120) },
      via: { status: viaProxy.status, body: viaProxy.body?.slice(0, 160) },
      xForwardedFor: { status: forwarded.status },
      json: { status: asJson.status } };

    // ---- Item 7: the tools' exact names and inputs ----
    const wanted = ["mempalace_search", "mempalace_add_drawer", "mempalace_delete_by_source",
      "mempalace_check_duplicate", "mempalace_list_rooms", "mempalace_get_taxonomy", "mempalace_status",
      "mempalace_list_drawers", "mempalace_get_drawers", "mempalace_delete_drawers"];
    out.item7 = { allNames: tools.map((t) => t.name).sort(), schemas: {} };
    for (const name of wanted) {
      const t = tools.find((x) => x.name === name);
      out.item7.schemas[name] = t
        ? { required: t.inputSchema.required ?? [], properties: Object.fromEntries(Object.entries(
          t.inputSchema.properties ?? {}).map(([k, v]) => [k, [v.type, v.maxLength, v.enum].filter((x) => x)
          .join(" ")])) }
        : "not offered";
    }

    const call = async (name, args) => {
      try {
        const r = await client.callTool({ name, arguments: args });
        const text = (r.content ?? []).map((c) => c.text ?? "").join("\n");
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {}
        return { isError: Boolean(r.isError), json: parsed, text: parsed ? undefined : text.slice(0, 300) };
      } catch (e) {
        return { thrown: `${e.code ?? ""} ${e.message}`.trim().slice(0, 300) };
      }
    };
    const brief = (r) => (r.json ? Object.fromEntries(Object.entries(r.json).filter(([k]) =>
      ["success", "reason", "error", "drawer_id", "room", "wing", "chunks", "match_count", "deleted",
        "is_duplicate"].includes(k))) : r);
    const W = "tachikoma";
    const projectRoom = "agent-harness-3f9a1c2b";
    const hits = (r) => (r.json?.results ?? []).map((x) => ({ room: x.room, source: x.source_file ?? x.source_path,
      keys: Object.keys(x).join(",") }));

    // ---- Item 8: look up and remove by exact label; the number of pieces ----
    const shortTurn = "User: how do I run the tests?\nAssistant: Run node node_modules/vitest/vitest.mjs run <files>.";
    const longTurn = `User: explain the saver.\nAssistant: ${"The saver files each finished turn once, by its label. "
      .repeat(36)}`;
    const L1 = "tachikoma session check-1, turn 1";
    const L2 = "tachikoma session check-1, turn 2";
    const i8 = {};
    i8.addShort = brief(await call("mempalace_add_drawer", { wing: W, room: projectRoom, content: shortTurn,
      source_file: L1 }));
    i8.addLong = { length: longTurn.length, expected: Math.ceil(longTurn.length / CHUNK),
      ...brief(await call("mempalace_add_drawer", { wing: W, room: projectRoom, content: longTurn,
        source_file: L2 })) };
    i8.lookupLong = brief(await call("mempalace_delete_by_source", { source_file: L2 }));
    i8.lookupShort = brief(await call("mempalace_delete_by_source", { source_file: L1, dry_run: true }));
    i8.lookupNone = brief(await call("mempalace_delete_by_source", { source_file: "tachikoma session none, turn 1" }));
    i8.lookupPrefix = brief(await call("mempalace_delete_by_source", { source_file: "tachikoma session check-1" }));
    const bySearch = await call("mempalace_search", { query: "the saver files each turn", wing: W, room: projectRoom,
      source_file: L2, limit: 10 });
    i8.searchBySource = { keys: Object.keys(bySearch.json ?? {}), hits: hits(bySearch), error: bySearch.json?.error
      ?? bySearch.thrown };
    i8.removeLong = brief(await call("mempalace_delete_by_source", { source_file: L2, dry_run: false }));
    i8.lookupAfterRemove = brief(await call("mempalace_delete_by_source", { source_file: L2 }));
    i8.readdLong = brief(await call("mempalace_add_drawer", { wing: W, room: projectRoom, content: longTurn,
      source_file: L2 }));
    const astral = `${"x".repeat(CHUNK - 1)}\u{1F600}`;
    i8.astral = { jsLength: astral.length, codePoints: [...astral].length,
      ...brief(await call("mempalace_add_drawer", { wing: W, room: "pieces-check", content: astral,
        source_file: "tachikoma session check-1, turn 3" })) };
    const tooLong = "y".repeat(100_001);
    i8.tooLong = { length: tooLong.length, ...brief(await call("mempalace_add_drawer", { wing: W, room: "pieces-check",
      content: tooLong, source_file: "tachikoma session check-1, turn 4" })) };
    out.item8 = i8;

    // ---- Item 9: duplicates, for lessons ----
    const lesson = "Lesson (agent-harness, 2026-11-19): vitest failed on a missing --run; adding run fixed it.";
    const nearLesson = "Lesson (agent-harness, 2026-11-19): vitest failed on a missing run; adding run fixed it.";
    const i9 = {};
    i9.first = brief(await call("mempalace_add_drawer", { wing: W, room: "lessons", content: lesson,
      source_file: "tachikoma lesson check-1" }));
    i9.sameAgain = brief(await call("mempalace_add_drawer", { wing: W, room: "lessons", content: lesson,
      source_file: "tachikoma lesson check-1" }));
    i9.sameOtherLabel = brief(await call("mempalace_add_drawer", { wing: W, room: "lessons", content: lesson,
      source_file: "tachikoma lesson check-2" }));
    i9.sameOtherRoom = brief(await call("mempalace_add_drawer", { wing: W, room: projectRoom, content: lesson,
      source_file: "tachikoma lesson check-3" }));
    i9.near = brief(await call("mempalace_add_drawer", { wing: W, room: "lessons", content: nearLesson,
      source_file: "tachikoma lesson check-4" }));
    i9.longAgain = brief(await call("mempalace_add_drawer", { wing: W, room: projectRoom, content: longTurn,
      source_file: "tachikoma session check-1, turn 9" }));
    const dup = await call("mempalace_check_duplicate", { content: lesson });
    i9.checkDuplicate = { is_duplicate: dup.json?.is_duplicate, matches: (dup.json?.matches ?? []).map((m) => ({
      room: m.room, similarity: m.similarity })) };
    const other = await call("mempalace_check_duplicate", { content: "The window keeps an in use file in the home." });
    i9.checkUnrelated = { is_duplicate: other.json?.is_duplicate, matches: (other.json?.matches ?? []).length };
    out.item9 = i9;

    // ---- Item 7, the rest: counts by room, two rooms in one search ----
    const rooms = await call("mempalace_list_rooms", { wing: W });
    const twoRooms = await call("mempalace_search", { query: "saver", wing: W, room: [projectRoom, "lessons"] });
    const commaRooms = await call("mempalace_search", { query: "saver", wing: W, room: `${projectRoom},lessons` });
    const wingOnly = await call("mempalace_search", { query: "vitest run lesson saver", wing: W, limit: 10 });
    const longQuery = await call("mempalace_search", { query: "q".repeat(251), wing: W });
    out.item7.listRooms = rooms.json ?? rooms;
    out.item7.twoRoomsAsList = twoRooms.thrown ?? twoRooms.json?.error ?? "accepted";
    out.item7.twoRoomsWithComma = commaRooms.thrown ?? commaRooms.json?.error ?? hits(commaRooms);
    out.item7.wingOnlyRooms = [...new Set(hits(wingOnly).map((h) => h.room))];
    out.item7.searchResultKeys = { top: Object.keys(wingOnly.json ?? {}), hit: hits(wingOnly)[0]?.keys };
    out.item7.query251 = longQuery.thrown ?? longQuery.json?.error ?? "accepted";

    // ---- Item 10: room names ----
    const names = ["agent-harness-3f9a1c2b", "Agent Harness-3F9A1C2B", "caf\u00e9-3f9a1c2b",
      "\u65e5\u672c\u8a9e-3f9a1c2b",
      "app.v2-3f9a1c2b", "lessons", "app_", "_app", ".app", "app-", "app (1)-3f9a1c2b", "app+x-3f9a1c2b",
      "app#x-3f9a1c2b", "app@x-3f9a1c2b", "app&x-3f9a1c2b", "app,x-3f9a1c2b", "a..b-3f9a1c2b", "a/b-3f9a1c2b",
      "a\\b-3f9a1c2b", "a".repeat(128), "a".repeat(129), " padded-3f9a1c2b "];
    out.item10 = { rooms: {} };
    for (const n of names) {
      const r = await call("mempalace_add_drawer", { wing: W, room: n, content: `Room name check: ${JSON.stringify(n)}`,
        source_file: "tachikoma room check" });
      const key = n.length > 40 ? `${n.slice(0, 6)}... (${n.length} chars)` : n;
      out.item10.rooms[key] = r.json?.success ? `kept as ${JSON.stringify(r.json.room)}` : (r.json?.error ?? r.thrown);
    }
    await call("mempalace_add_drawer", { wing: W, room: "CaseRoom", content: "Case check: a room spelled CaseRoom.",
      source_file: "tachikoma case check" });
    const lower = await call("mempalace_search", { query: "case check room spelled", wing: W, room: "caseroom" });
    const exact = await call("mempalace_search", { query: "case check room spelled", wing: W, room: "CaseRoom" });
    out.item10.caseFold = { lowerFinds: hits(lower).length, exactFinds: hits(exact).length };
    const wingUpper = await call("mempalace_add_drawer", { wing: "Tachikoma", room: "case-check",
      content: "Wing case check.", source_file: "tachikoma case check" });
    out.item10.wingCase = brief(wingUpper);

    // ---- Item 12: the backend and the model, read back from the running hub ----
    const statusTool = await call("mempalace_status", {});
    const statusz = JSON.parse((await http(PD, "/statusz")).body ?? "{}");
    out.item12 = { statusTool: { backend: statusTool.json?.backend, embedding_device: statusTool.json?.embedding_device,
      total_drawers: statusTool.json?.total_drawers }, statusz: { backend: statusz.palace?.backend,
      version: statusz.server?.version, writer: statusz.writer }, fingerprint: infoFor(A)?.info
      .search_config_fingerprint };
    out.item7.counts = { rooms: statusTool.json?.rooms };
    // Whole entries by room: list_drawers lists "logical drawers" (mempalace/mcp_server/tools_write.py:1341-1355).
    const entries = async (room) => (await call("mempalace_list_drawers", { wing: W, room, limit: 1 })).json?.total;
    out.item7.entriesByRoom = { [projectRoom]: await entries(projectRoom), lessons: await entries("lessons") };

    // Item 12: the palace file read while its hub runs, then the hub asked again.
    const live = new DatabaseSync(path.join(A, "sqlite_exact.sqlite3"), { readOnly: true });
    const liveModel = live.prepare("SELECT value FROM meta WHERE key = 'embedder_model:mempalace_drawers'").get();
    live.close();
    const after = await call("mempalace_search", { query: "saver", wing: W, room: projectRoom });
    out.item12.palaceFileWhileRunning = { model: liveModel?.value, hubAnswersAfter: hits(after).length > 0 };
    await client.close();
    client = undefined;
    out.item6.transportErrorsAtEnd = [...transportErrors];

    // Item 2: a direct hub stopped by the id its starter holds (the launcher) only.
    const dPids = treeD.map((r) => r.pid);
    stop(hD.pid, "item 2: the direct hub's top process only");
    await hD.exited;
    out.item2 = { directStopTop: { exit: hD.exit, stillRunning: running(dPids).map((p) => `${p} ${mine.get(p).name}`),
      stillAnswers: await healthy(PD) } };
    out.item4.directStop = await stopTree(treeD.filter((r) => running(dPids).includes(r.pid)),
      "what was left of the direct hub");

    // ---- Item 1: a port Tachikoma picks, with `serve` ----
    const P1 = await freePort();
    const h1 = start("h1-serve", "serve", P1, A);
    const up1 = await waitHealthy(P1, h1);
    out.item1.picked = { port: P1, up: up1, stdout: tail(h1.stdout, 12) };
    if (!up1.ok) throw new Error(`h1 did not come up: ${JSON.stringify(up1)} ${tail(h1.stderr).join(" | ")}`);

    // ---- Item 2: the processes a `serve` hub is, and their start times ----
    const info1 = infoFor(A);
    const tree1 = tree("h1-serve", h1.pid);
    Object.assign(out.item2, { serveTree: tree1, serverinfoPid: info1?.info.pid, serverinfoIsDeepest: info1?.info.pid
      === tree1.at(-1)?.pid });
    const target = info1?.info.pid;
    const timings = { cim: [], getProcess: [], python: [] };
    for (let i = 0; i < 3; i++) {
      const c = cim(`ProcessId=${target}`);
      timings.cim.push({ ms: c.ms, value: c.list[0]?.created });
      const g = powershell(`(Get-Process -Id ${target}).StartTime.ToUniversalTime().ToString('o')`);
      timings.getProcess.push({ ms: g.ms, value: g.text });
      const t0 = performance.now();
      const py = spawnSync(PYTHON, ["-I", "-c", START_TIME_PY, String(target)], { env, encoding: "utf8",
        windowsHide: true });
      let value = `not read: ${py.stdout.trim()} ${py.stderr.trim()}`.slice(0, 200);
      if (/^\d+$/.test(py.stdout.trim())) {
        // FILETIME: 100 ns steps since 1601-01-01; 11644473600000 ms lie between that and 1970-01-01.
        const ticks = BigInt(py.stdout.trim());
        const ms = Number(ticks / 10000n) - 11644473600000;
        value = `${new Date(ms).toISOString().slice(0, 19)}.${String(ticks % 10000000n).padStart(7, "0")}Z`;
      }
      timings.python.push({ ms: since(t0), value });
    }
    const status1 = await http(P1, "/statusz");
    out.item2.startTimes = timings;
    out.item2.statuszStartedAt = JSON.parse(status1.body ?? "{}").server?.started_at;

    // ---- Item 5: a second writable hub on the same palace ----
    const P2 = await freePort();
    const h2 = start("h2-second-wait0", "serve", P2, A, { extra: { MEMPALACE_MCP_WRITER_WAIT_SECONDS: "0" } });
    const h2up = await waitHealthy(P2, h2);
    await ends(h2);
    out.item5 = { wait0: { exit: h2.exit, everAnswered: h2up.ok, stderr: tail(h2.stderr, 4) } };

    const P3 = await freePort();
    const h3 = start("h3-second-default", "serve", P3, A);
    const waiting = await waitFor(async () => tail(h3.stderr, 40).some((l) => l.includes("is waiting up to")) ||
      Boolean(h3.exit));
    const answeredWhileWaiting = await healthy(P3);
    out.item5.defaultWait = { waitingSeenAfterMs: waiting.ms, line: tail(h3.stderr, 40).find((l) =>
      l.includes("is waiting up to")), answeredWhileWaiting, exitedEarly: h3.exit };

    // ---- Item 2: stopping h1 by the id this script holds (the top process) only ----
    const h1Pids = tree1.map((r) => r.pid);
    const killedAt = performance.now();
    stop(h1.pid, "item 2: the top process only");
    await h1.exited;
    const afterTop = running(h1Pids);
    const stillAnswers = await healthy(P1);
    const afterTopAgain = running(h1Pids);
    const named = (pids) => pids.map((p) => `${p} ${mine.get(p).name}`);
    out.item2.stopTop = { exit: h1.exit, stillRunning: named(afterTop), stillAnswers,
      stillRunningAfterThat: named(afterTopAgain) };
    const rest = await stopTree(tree1.filter((r) => afterTopAgain.includes(r.pid)), "item 2: what was left of h1");
    const h3up = await waitHealthy(P3, h3);
    out.item5.defaultWait.tookOverMsAfterStop = since(killedAt);
    out.item5.defaultWait.up = h3up;
    out.item2.stopRest = rest;

    // ---- Item 2: stopping h3 by the server's own id (serverinfo) ----
    const tree3 = tree("h3-second-default", h3.pid);
    const server3 = infoFor(A)?.info.pid;
    out.item2.secondTree = tree3;
    stop(server3, "item 2: the server process (serverinfo pid) only");
    const parentsGone = await waitGone(tree3.map((r) => r.pid));
    await ends(h3);
    out.item2.stopServer = { serverinfoPid: server3, parentsEndedBy: parentsGone, topExit: h3.exit,
      serverinfoAfter: infoFor(A)?.info ?? null };

    // ---- Item 3: started detached and hidden, by a process that then exits ----
    out.item3 = {};
    for (const kind of ["serve", "direct"]) {
      const P = await freePort();
      const s = startDetached(`h4-detached-${kind}`, kind, P, A);
      const up = await waitHealthy(P);
      const t = tree(s.label, s.pid);
      const ids = t.map((r) => r.pid).join(",");
      const windows = ids ? powershell(`Get-Process -Id ${ids} | ForEach-Object { "$($_.Id) $($_.ProcessName) ` +
        `$($_.MainWindowHandle) $($_.MainWindowTitle)" }`).text.split(/\r?\n/) : [];
      out.item3[kind] = { starterExit: s.starter, up, tree: t, windows, alive: running(t.map((r) => r.pid)).length };
      out.item3[kind].stopped = await stopTree(t, `item 3: ${kind}`);
    }

    // ---- Item 12: a hub on a palace made with the other backend ----
    const C = palace("c-chroma");
    const P6 = await freePort();
    const h6 = start("h6-make-chroma", "direct", P6, C, { backend: "chroma" });
    const up6 = await waitHealthy(P6, h6);
    let made = null;
    if (up6.ok) {
      const add = await http(P6, "/mcp", { method: "POST", headers: json, body: JSON.stringify({ jsonrpc: "2.0", id: 1,
        method: "tools/call", params: { name: "mempalace_add_drawer", arguments: { wing: W, room: "backend-check",
          content: "A palace made with the chroma backend.", source_file: "tachikoma backend check" } } }) });
      made = add.body?.slice(0, 200);
    }
    if (!h6.exit) await stopTree(tree("h6-make-chroma", h6.pid), "item 12: the chroma palace made");
    await h6.exited;
    const P7 = await freePort();
    const h7 = start("h7-sqlite-on-chroma", "direct", P7, C);
    const up7 = await waitHealthy(P7, h7);
    let onMismatch = null;
    if (up7.ok) {
      const r = await http(P7, "/mcp", { method: "POST", headers: json, body: JSON.stringify({ jsonrpc: "2.0", id: 1,
        method: "tools/call", params: { name: "mempalace_search", arguments: { query: "palace", wing: W } } }) });
      onMismatch = r.body?.slice(0, 300);
    }
    if (!h7.exit) await stopTree(tree("h7-sqlite-on-chroma", h7.pid), "item 12: the mismatched hub");
    await h7.exited;
    out.item12.otherBackend = { made: { up: up6, add: made, files: readdirSync(C) }, sqliteExactHub: { up: up7,
      exit: h7.exit, stderr: tail(h7.stderr, 3), call: onMismatch } };

    // ---- Item 12: read back from the palace file, with no hub running ----
    const db = new DatabaseSync(path.join(A, "sqlite_exact.sqlite3"), { readOnly: true });
    out.item12.palaceFile = { meta: db.prepare("SELECT key, value FROM meta ORDER BY key").all(),
      collections: db.prepare("SELECT name, dimension FROM collections ORDER BY name").all() };
    db.close();

    // ---- Item 10, second part: the unknown file; Item 4: what appeared under the home folder ----
    out.item10.unknownFile = { before: unknownBefore, after: { sha256: sha256(unknown),
      mtimeMs: statSync(unknown).mtimeMs }, palaceFolder: listing(A) };
    const homeAfter = listing(home);
    out.item4.homeAdded = Object.keys(homeAfter).filter((k) => !(k in homeBefore) && !k.startsWith("palaces/"));
    out.item4.homeChanged = Object.keys(homeAfter).filter((k) => k in homeBefore && homeAfter[k] !== homeBefore[k] &&
      !k.startsWith("palaces/"));
    out.item4.homeRemoved = Object.keys(homeBefore).filter((k) => !(k in homeAfter));
    out.item4.serverDirsAtEnd = serverinfos().map((s) => ({ key: s.key, pid: s.info.pid, port: s.info.port,
      palace: path.basename(s.info.palace_path) }));
  } finally {
    if (client) await client.close().catch(() => {});
    // Whatever is left of this script's processes, stopped by id after their start time is read again.
    const left = running([...mine.keys()]);
    for (const pid of left.reverse()) stop(pid, "end of run");
    await waitGone([...mine.keys()]);
    await new Promise((resolve) => listener.close(resolve));
  }

  // The connection watch, over every audit log of the run.
  const audits = readdirSync(runDir).filter((f) => f.endsWith(".audit.jsonl"));
  out.watch = { listener: proxied, logs: {} };
  for (const f of audits) {
    const records = readFileSync(path.join(runDir, f), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    const server = records.filter((r) => r.phase === "server");
    out.watch.logs[f] = {
      control: records.filter((r) => r.phase === "control" && r.event).length,
      proxies: Boolean(records.find((r) => r.httpx_proxies)),
      server: server.length,
      outside: server.filter((r) => r.host !== null && !LOOPBACK.has(r.host)).map((r) => `${r.event} ${r.host}`),
      children: server.filter((r) => PROCESS_EVENTS.has(r.event)).map((r) => r.args.slice(0, 120)),
    };
  }
  out.stops = stops;
  const all = [...mine.entries()].map(([pid, r]) => ({ pid, ...r }));
  const stillRunning = running(all.map((r) => r.pid));
  const { list: kids } = cim(all.map((r) => `ParentProcessId=${r.pid}`).join(" OR "));
  const newKids = kids.filter(isMine);
  // Children of a recorded id not proven this script's (started after that process was last seen running): left alone.
  const reused = kids.filter((k) => mine.has(k.ppid) && !isMine(k)).map((k) => ({ pid: k.pid, name: k.name,
    created: k.created, parentId: k.ppid, parentLastSeenRunning: seen.get(k.ppid) }));
  out.processes = { started: all, stillRunning, childrenStillRunning: newKids, notMineUnderReusedIds: reused };
  writeFileSync(path.join(runDir, "results.json"), `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
  const watchOk = proxied.length === 0 && Object.values(out.watch.logs).every((l) => l.outside.length === 0 &&
    l.control > 0 && l.proxies);
  const clean = stillRunning.length === 0 && newKids.length === 0;
  say(`results ${path.join(runDir, "results.json")}`);
  // What the watch covers: the hooked processes, and HTTP sent through the proxy variables. `serve`'s server children
  // are not hooked.
  const watch = watchOk ? "hooked processes reached no outside address, the dead-end proxy got nothing" : "FAILED";
  say(`connection watch (serve's server children not hooked): ${watch}; processes left running: ` +
    `${stillRunning.length + newKids.length}`);
  process.exitCode = watchOk && clean ? 0 : 1;
}

if (process.argv[2] === "run") await run();
else {
  console.error("usage: node scripts/8d/mempalace-checks.mjs run");
  process.exitCode = 2;
}
