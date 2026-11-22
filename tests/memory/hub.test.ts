import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hubEnv } from "../../src/memory/env.js";
import {
  FIGURES,
  type Figures,
  Hub,
  type HubEvent,
  hubRecord,
  type HubRecord,
  hubToken,
  stoppingFile,
} from "../../src/memory/hub.js";
import type { Program } from "../../src/memory/install.js";
import { load, tryLock } from "../../src/memory/oslock.js";
import { makeMemoryFolder, type MemoryPaths, memoryPaths } from "../../src/memory/paths.js";
import { removeTree } from "../helpers.js";

// The hub's supervisor (8d plan, step 20) against step 18's stand-in MemPalace (tests/memory/standin.mjs), never a real
// hub (the real one is step 20's proof, scripts/8d/hub-proof.mjs, and step 29). The environment's Python is a script
// at the Python's own path, started with Node through `launch` (as step 19's tests start theirs): started as the hub
// (`-I -m mempalace.mcp_server ...`) it records how it was started, notes its own start time in a file, and loads the
// stand-in; started as the supervisor's helper (`-I -c <helper> start|stop ...`) it reads that start time, and stops
// the process only when it is the given one, as the real helper does. What it does is told by `control.json` in the
// environment's folder; it ends itself when that file is gone, so no test stops a process by its id alone. Every home,
// data folder and PATH is in a folder the test made.

const STANDIN = path.resolve("tests/memory/standin.mjs");
const launch = (file: string): Program => ({ command: process.execPath, args: [file] });
// The tests' own limit for something that should happen: long enough never to be reached by one that does.
const LIMIT = 10_000;
// The tests' own figures: the stand-in's answers get the tests' limit; the start limit is shortened only where a test
// waits for it to pass.
const TEST: Partial<Figures> = { readBack: LIMIT, startRead: LIMIT, stop: LIMIT };
const SHORT_START = 1_500;

// The stand-in Python. Its control: `record` (a JSON line per start), `exit` (exit at once with that code), `hold` (a
// file whose existence lets the stand-in start), `backend` (passed to the stand-in in place of sqlite_exact),
// `upper` (the palace folder's own name in capitals, so serverinfo.json's palace_path differs in letter case only),
// `key` (serverinfo.json written under that folder name in place of MemPalace's own), `args` (more for the
// stand-in); and, as the helper, `startDelay` (answer that much later) and `stopSays` ("unopened": the process could
// not be opened; "nothing": no answer at all; "running": the process is ended but the wait after it
// passed its limit).
const PYTHON = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const dir = path.join(__dirname, "..");
const controlFile = path.join(dir, "control.json");
const c = JSON.parse(fs.readFileSync(controlFile, "utf8"));
const args = process.argv.slice(2);
const startOf = (pid) => path.join(dir, "start-" + pid);
const log = (x) => fs.appendFileSync(c.record, JSON.stringify(x) + "\n");
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
// The real helper reads the start time from the system, so any environment's Python gives the same answer: the file
// is looked for in every environment folder beside this one.
const noted = (pid) => fs.readdirSync(path.dirname(dir)).map((d) => path.join(path.dirname(dir), d, "start-" + pid))
  .find((f) => fs.existsSync(f));
const startTime = (pid) => (!alive(pid) ? null : noted(pid) ? fs.readFileSync(noted(pid), "utf8") :
  "another program's");
if (args[1] === "-c") {
  const [op, p, want, ms] = args.slice(3);
  const pid = Number(p);
  log({ helper: { op, pid } });
  const say = (t) => process.stdout.write(t + "\n");
  const act = () => {
    const st = startTime(pid);
    if (op === "start") return say(st ?? "gone");
    if (c.stopSays === "unopened") return say("unopened 5");
    if (c.stopSays === "nothing") return;
    if (st === null) return say("gone");
    if (st !== want) return say("differs");
    process.kill(pid);
    if (c.stopSays === "running") return say("running " + ms + " " + pid);
    const began = Date.now();
    const wait = () => {
      if (!alive(pid)) say("stopped " + (Date.now() - began) + " " + pid);
      else if (Date.now() - began > Number(ms)) say("running " + (Date.now() - began) + " " + pid);
      else return setTimeout(wait, 10);
    };
    wait();
  };
  const delay = op === "start" ? c.startDelay : 0;
  if (delay) setTimeout(act, delay);
  else act();
} else {
  log({ hub: { file: __filename, args, env: process.env, pid: process.pid } });
  fs.writeFileSync(startOf(process.pid), String(Date.now()) + "-" + String(process.hrtime.bigint()));
  setInterval(() => {
    if (!fs.existsSync(controlFile)) process.exit(0);
  }, 100);
  (async () => {
    if (c.exit !== undefined) process.exit(c.exit);
    while (c.hold && !fs.existsSync(c.hold)) await new Promise((r) => setTimeout(r, 20));
    const at = (flag) => process.argv.indexOf(flag) + 1;
    if (c.backend) process.argv[at("--backend")] = c.backend;
    if (c.upper) {
      const p = process.argv[at("--palace")];
      process.argv[at("--palace")] = path.join(path.dirname(p), path.basename(p).toUpperCase());
    }
    if (c.key) {
      const moved = (p) => String(p).replace(/([\\/]server[\\/])[0-9a-f]{24}/, "$1" + c.key);
      const { mkdirSync, writeFileSync } = fs;
      fs.mkdirSync = (p, ...rest) => mkdirSync(moved(p), ...rest);
      fs.writeFileSync = (p, ...rest) => writeFileSync(moved(p), ...rest);
    }
    process.argv.push(...(c.args ?? []));
    await import(pathToFileURL(c.standin).href);
  })();
}
`;

interface Control {
  exit?: number;
  hold?: string;
  backend?: string;
  upper?: boolean;
  key?: string;
  args?: string[];
  startDelay?: number;
  stopSays?: "unopened" | "nothing" | "running";
}

const folders: string[] = [];
const hubs: Hub[] = [];
const records: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

// Each stand-in ends itself once its control file is gone; then its folders can go. Every part runs even when an
// earlier one fails (a failed test may leave a close that cannot finish), so a failing run leaves nothing behind.
afterEach(async () => {
  const closing = Promise.allSettled(hubs.splice(0).map((h) => h.close()));
  await Promise.race([closing, sleep(LIMIT)]);
  vi.useRealTimers();
  const started = records.splice(0).flatMap((r) => launches(r).map((l) => l.pid));
  for (const folder of folders) {
    for (const f of found(folder, "control.json")) rmSync(f, { force: true });
  }
  try {
    await until(() => started.every((pid) => !alive(pid)), "the stand-ins to end");
    // A join a failed test left running sees its stand-in end, and lets the join lock go.
    await Promise.race([closing, sleep(LIMIT)]);
  } finally {
    for (const folder of folders.splice(0)) await removeTree(folder);
  }
}, 4 * LIMIT);

function found(folder: string, name: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name === name)
    .map((e) => path.join(e.parentPath, e.name));
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

async function until(check: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > LIMIT) throw new Error(`waited too long for ${what}`);
    await sleep(20);
  }
}

type Launch = { file: string; args: string[]; env: NodeJS.ProcessEnv; pid: number };
const lines = (record: string) =>
  existsSync(record) ? readFileSync(record, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const launches = (record: string): Launch[] => lines(record).flatMap((l) => (l.hub ? [l.hub] : []));

// A data folder, its memory folder made private as the installer makes it, the user's home folders and an empty PATH
// folder, all in a folder the test made; an environment folder holding the stand-in Python.
async function setup(hash = "test", top?: string) {
  if (!top) {
    top = await mkdtemp(path.join(tmpdir(), "tachi-hub-"));
    folders.push(top);
  }
  const record = path.join(top, `record-${hash}.jsonl`);
  records.push(record);
  const bin = path.join(top, "bin");
  mkdirSync(bin, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PATH")),
    PATH: bin,
    USERPROFILE: path.join(top, "user"),
    HOME: path.join(top, "user"),
    APPDATA: path.join(top, "user", "AppData", "Roaming"),
    LOCALAPPDATA: path.join(top, "user", "AppData", "Local"),
  };
  const paths = memoryPaths(path.join(top, "data"), hash);
  makeMemoryFolder(paths);
  mkdirSync(path.dirname(paths.envPython), { recursive: true });
  writeFileSync(paths.envPython, PYTHON);
  const control = (c: Control = {}) =>
    writeFileSync(path.join(paths.env, "control.json"), JSON.stringify({ record, standin: STANDIN, ...c }));
  control();
  const events: HubEvent[] = [];
  const hub = (figures: Partial<Figures> = {}) => {
    const h = new Hub({ paths, env, launch, figures: { ...TEST, ...figures }, onEvent: (e) => events.push(e) });
    hubs.push(h);
    return h;
  };
  const record_ = (): HubRecord | undefined =>
    existsSync(hubRecord(paths)) ? JSON.parse(readFileSync(hubRecord(paths), "utf8")) : undefined;
  const inUse = () => readdirSync(paths.home).filter((n) => n.startsWith("in-use-"));
  return { top, paths, env, control, hub, events, record: record_, launched: () => launches(record), inUse };
}

type Setup = Awaited<ReturnType<typeof setup>>;

// The stand-in hub started by the test itself, as another window's hub with no record: it answers, and serverinfo.json
// names it. `more` is added to its environment (a token, for a hub of this build's).
async function otherHub(s: Setup, more: NodeJS.ProcessEnv = {}): Promise<Launch> {
  mkdirSync(s.paths.home, { recursive: true });
  const port = await freePort();
  const child = spawn(process.execPath, [s.paths.envPython, "-I", "-m", "mempalace.mcp_server", "--transport", "http",
    "--host", "127.0.0.1", "--port", String(port), "--palace", s.paths.palace, "--backend", "sqlite_exact"],
  { cwd: s.paths.home, env: { ...hubEnv(s.paths, s.env), ...more }, stdio: "ignore", windowsHide: true });
  await until(() => s.launched().some((l) => l.pid === child.pid), "the other hub to start");
  await until(() => serverinfoPort(s) === port, "the other hub's serverinfo.json");
  return s.launched().find((l) => l.pid === child.pid)!;
}

function serverinfoPort(s: Setup): number | undefined {
  const root = path.join(s.paths.home, ".mempalace", "server");
  if (!existsSync(root)) return undefined;
  for (const key of readdirSync(root)) {
    const file = path.join(root, key, "serverinfo.json");
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).port;
  }
  return undefined;
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address() as { port: number };
  await new Promise((resolve) => s.close(resolve));
  return port;
}

// A serverinfo.json left behind, under a made-up folder name.
function staleInfo(s: Setup, key: string, info: Record<string, unknown>) {
  const dir = path.join(s.paths.home, ".mempalace", "server", key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "serverinfo.json"), JSON.stringify({ host: "127.0.0.1", scheme: "http", ...info }));
}

const portOf = (url: string) => Number(new URL(url).port);
const tokenOf = (joined: unknown) => (joined as { token: string }).token;

// MCP's first request to the hub at `url`, with the Authorization header given, if any: the status it is answered with.
async function initialize(url: string, authorization?: string): Promise<number> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
      ...(authorization !== undefined && { authorization }) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18",
      capabilities: {}, clientInfo: { name: "hub-test", version: "0" } } }),
    signal: AbortSignal.timeout(LIMIT),
  });
  await r.text();
  return r.status;
}

describe("the hub's supervisor", () => {
  it("uses the figures the build measured and the user chose", () => {
    expect(FIGURES).toEqual({
      startLimit: 40_000,
      startCheck: 100,
      health: 750,
      lockRetry: 500,
      refresh: 5_000,
      stale: 27_000,
      stop: 1_300,
      readBack: 900,
      startRead: 1_000,
    });
  });

  it("starts the environment's Python with -I and the server module, on loopback, a picked port and the palace",
    async () => {
      const s = await setup();
      const joined = await s.hub().join();
      expect(joined).toEqual({ is: "on", url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
        token: expect.any(String) });
      expect(s.launched()).toHaveLength(1);
      const l = s.launched()[0]!;
      expect(l.file).toBe(s.paths.envPython);
      const port = portOf((joined as { url: string }).url);
      expect(port).not.toBe(8765);
      expect(l.args).toEqual(["-I", "-m", "mempalace.mcp_server", "--transport", "http", "--host", "127.0.0.1",
        "--port", String(port), "--palace", s.paths.palace, "--backend", "sqlite_exact"]);
      expect(l.args).not.toContain("serve");
      expect(l.env).toMatchObject({ MEMPALACE_EMBEDDING_MODEL: "minilm", MEMPALACE_MCP_WRITER_WAIT_SECONDS: "0",
        MEMPALACE_MCP_IDLE_HOURS: "0" });
      // The record, under the join lock: the environment folder, the port, the serving process and its start time.
      const start = readFileSync(path.join(s.paths.env, `start-${l.pid}`), "utf8");
      expect(s.record()).toEqual({ env: s.paths.env, port, pid: l.pid, start, stopping: false, token: true });
      // The newest version that opened the palace.
      expect(JSON.parse(readFileSync(path.join(s.paths.palace, "tachikoma-version.json"), "utf8")))
        .toEqual({ mempalace: "3.12.0" });
      expect(s.inUse()).toHaveLength(1);
    });

  // PR #26 review 1: the hub needs a token only Tachikoma has, kept in memory's private folder and given to the hub in
  // its environment, never on its command line; a call without it, or with another, is refused.
  it("starts the hub with the install's own token, which every call must give", async () => {
    const s = await setup();
    const joined = await s.hub().join();
    expect(joined.is).toBe("on");
    const token = JSON.parse(readFileSync(hubToken(s.paths), "utf8")).token;
    // 32 random bytes in base64url, as MemPalace makes its own (mempalace/server_registry.py:99, token_urlsafe(32)).
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenOf(joined)).toBe(token);
    const l = s.launched()[0]!;
    expect(l.env.MEMPALACE_MCP_HTTP_TOKEN).toBe(token);
    expect(l.args.join(" ")).not.toContain(token);
    const { url } = joined as { url: string };
    expect(await initialize(url)).toBe(401);
    expect(await initialize(url, "Bearer another-token")).toBe(401);
    expect(await initialize(url, `Bearer ${token}`)).toBe(200);
  });

  it("keeps the install's token: a hub started later is given the same one", async () => {
    const s = await setup();
    const a = s.hub();
    const first = await a.join();
    expect(tokenOf(first)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await a.close()).toEqual({ is: "stopped" });
    const second = await s.hub().join();
    expect(second.is).toBe("on");
    expect(s.launched()).toHaveLength(2);
    expect(tokenOf(second)).toBe(tokenOf(first));
    expect(s.launched()[1]!.env.MEMPALACE_MCP_HTTP_TOKEN).toBe(tokenOf(first));
  });

  // PR #26 review of b83d076, point 5: owner-only on Linux and macOS too, beside memory/'s private folder. Windows
  // keeps only the read-only bit of a mode, so there the private folder alone guards it.
  it.runIf(process.platform !== "win32")("writes the token file for its owner only", async () => {
    const s = await setup();
    expect((await s.hub().join()).is).toBe("on");
    expect(statSync(hubToken(s.paths)).mode & 0o777).toBe(0o600);
  });

  // Point 2: a token file that exists is never replaced, so a running hub's token is not lost; one that cannot be
  // read turns memory off, with Node's own words, as a folder that cannot be made does.
  it("turns memory off, keeping the token file, when the file cannot be read", async () => {
    const s = await setup();
    mkdirSync(s.paths.home, { recursive: true });
    const kept = `${JSON.stringify({ token: "the-running-hub-s-token" })}\n`;
    writeFileSync(hubToken(s.paths), kept);
    vi.resetModules();
    vi.doMock("node:fs", async (original) => {
      const fs = await original<typeof import("node:fs")>();
      const readFileSync = ((file: string, ...rest: unknown[]) => {
        if (path.basename(String(file)) === "hub-token.json") {
          throw Object.assign(new Error("EACCES: permission denied, open 'hub-token.json'"), { code: "EACCES" });
        }
        return (fs.readFileSync as (...a: unknown[]) => unknown)(file, ...rest);
      }) as typeof fs.readFileSync;
      return { ...fs, readFileSync, default: { ...fs, readFileSync } };
    });
    try {
      const fresh = await import("../../src/memory/hub.js");
      const h = new fresh.Hub({ paths: s.paths, env: s.env, launch, figures: TEST });
      hubs.push(h);
      expect(await h.join()).toEqual({ is: "off", why: { is: "folder", detail: expect.stringContaining("EACCES") } });
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
    expect(readFileSync(hubToken(s.paths), "utf8")).toBe(kept);
    expect(s.launched()).toEqual([]);
  });

  // Point 1: a hub the record does not mark as started with the token (here one from before the token, with no such
  // mark) is not reused on its health alone: it is treated as stopping. This window's start exits with code 2 while it
  // holds the palace, the window joins it, and the last window to leave stops it; the next start has the token.
  it("treats a hub not started with the token as stopping, and replaces it once the last window leaves",
    async () => {
      const s = await setup();
      const old = await otherHub(s);
      expect(old.env.MEMPALACE_MCP_HTTP_TOKEN).toBeUndefined();
      const start = readFileSync(path.join(s.paths.env, `start-${old.pid}`), "utf8");
      writeFileSync(hubRecord(s.paths),
        JSON.stringify({ env: s.paths.env, port: serverinfoPort(s), pid: old.pid, start, stopping: false }));
      const a = s.hub();
      expect((await a.join()).is).toBe("on");
      expect(s.launched()).toHaveLength(2); // the old hub, and this window's start, which exited 2
      expect(s.record()).toMatchObject({ pid: old.pid, env: null, token: false });
      expect(await a.close()).toEqual({ is: "stopped" });
      expect(alive(old.pid)).toBe(false);
      const b = s.hub();
      const joined = await b.join();
      expect(joined.is).toBe("on");
      expect(s.launched()).toHaveLength(3);
      expect(s.launched()[2]!.env.MEMPALACE_MCP_HTTP_TOKEN).toBe(tokenOf(joined));
      expect(s.record()).toMatchObject({ pid: s.launched()[2]!.pid, token: true });
    });

  // PR #26 Codex review 1: a record is reused only while its process is alive with the recorded start time. A hub that
  // has gone may have left its port to another program, which answers the health check (it needs no token); that
  // program is never sent the token, and a hub is started.
  it.each([
    { name: "whose process is gone", pid: 2_147_000_000 },
    { name: "whose process id is another program's", pid: process.pid },
  ])("never reuses a record $name, and sends what holds its port no token", async ({ pid }) => {
    const s = await setup();
    const seen: (string | undefined)[] = [];
    const holder = createHttpServer((req, res) => {
      seen.push(req.headers.authorization);
      req.resume();
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = holder.address() as { port: number };
      mkdirSync(s.paths.home, { recursive: true });
      writeFileSync(hubRecord(s.paths),
        JSON.stringify({ env: s.paths.env, port, pid, start: "the recorded start", stopping: false, token: true }));
      const joined = await s.hub().join();
      expect(joined.is).toBe("on");
      expect(portOf((joined as { url: string }).url)).not.toBe(port);
      expect(s.launched()).toHaveLength(1);
      expect(s.record()).toMatchObject({ pid: s.launched()[0]!.pid, token: true });
      expect(seen.filter((a) => a !== undefined)).toEqual([]);
    } finally {
      holder.closeAllConnections();
      await new Promise((resolve) => holder.close(resolve));
    }
  });

  it("finds serverinfo.json by listing, when its palace_path differs only in letter case", async () => {
    const s = await setup();
    s.control({ upper: true });
    const joined = await s.hub().join();
    expect(joined.is).toBe("on");
    expect(s.record()?.pid).toBe(s.launched()[0]!.pid);
  });

  it("finds serverinfo.json under a folder name no code works out, passing over stale ones", async () => {
    const s = await setup();
    s.control({ key: "a-made-up-folder" });
    const dead = await freePort();
    staleInfo(s, "another-palace", { pid: process.pid, port: dead, palace_path: path.join(s.top, "elsewhere") });
    staleInfo(s, "this-palace-stale", { pid: 2_147_000_000, port: dead, palace_path: s.paths.palace });
    const joined = await s.hub().join();
    expect(joined.is).toBe("on");
    expect(existsSync(path.join(s.paths.home, ".mempalace", "server", "a-made-up-folder", "serverinfo.json")))
      .toBe(true);
    expect(s.record()).toMatchObject({ pid: s.launched()[0]!.pid, port: portOf((joined as { url: string }).url) });
    expect(s.record()?.port).not.toBe(dead);
  });

  it("lets a second window join the first one's hub; one leaving keeps it; the last out stops it", async () => {
    const s = await setup();
    const a = s.hub();
    const b = s.hub();
    const ja = await a.join();
    const jb = await b.join();
    expect(jb).toEqual(ja);
    expect(s.launched()).toHaveLength(1);
    const { pid } = s.launched()[0]!;
    expect(s.inUse()).toHaveLength(2);
    expect(await a.close()).toEqual({ is: "left" });
    expect(alive(pid)).toBe(true);
    expect(s.record()?.pid).toBe(pid);
    expect(await b.close()).toEqual({ is: "stopped" });
    expect(alive(pid)).toBe(false);
    expect(s.record()).toBeUndefined();
    expect(s.inUse()).toEqual([]);
    // It was stopped by the serving process's id, through the helper's start-time check.
    expect(lines(path.join(s.top, "record-test.jsonl")).filter((l) => l.helper?.op === "stop"))
      .toEqual([{ helper: { op: "stop", pid } }]);
  });

  it("never stops a process whose start time is not the recorded one, and says why", async () => {
    const s = await setup();
    const h = s.hub();
    expect((await h.join()).is).toBe("on");
    const { pid } = s.launched()[0]!;
    writeFileSync(hubRecord(s.paths), JSON.stringify({ ...s.record(), start: "another start" }));
    expect(await h.close()).toEqual({ is: "not stopped", why: "the id is another program's" });
    expect(alive(pid)).toBe(true);
    expect(s.record()).toMatchObject({ pid, stopping: true });
  });

  // Only an answer that the serving process ended is a stop (the user's choice at step 20's review); anything else
  // keeps the record, marked stopping, for the next window.
  it.each([
    { name: "the helper could not open the process", control: { stopSays: "unopened" as const }, figures: {},
      why: "the process could not be opened" },
    { name: "the helper gave no answer", control: { stopSays: "nothing" as const }, figures: {},
      why: "the helper gave no answer" },
  ])("is not stopped when $name, and keeps the record marked stopping", async ({ control, figures, why }) => {
    const s = await setup();
    const h = s.hub(figures);
    expect((await h.join()).is).toBe("on");
    const { pid } = s.launched()[0]!;
    s.control(control);
    expect(await h.close()).toEqual({ is: "not stopped", why });
    expect(alive(pid)).toBe(true);
    expect(s.record()).toMatchObject({ pid, stopping: true });
  });

  it("counts a stop whose wait passed its limit after the process was ended as stopped (the late-stop rule)",
    async () => {
      const s = await setup();
      const h = s.hub();
      expect((await h.join()).is).toBe("on");
      const { pid } = s.launched()[0]!;
      s.control({ stopSays: "running" });
      expect(await h.close()).toEqual({ is: "stopped" });
      await until(() => !alive(pid), "the hub to end");
      expect(s.record()).toBeUndefined();
    });

  it("clears the record of a hub the helper finds already gone", async () => {
    const s = await setup();
    const h = s.hub();
    expect((await h.join()).is).toBe("on");
    const { pid } = s.launched()[0]!;
    process.kill(pid);
    await until(() => !alive(pid), "the hub to die");
    expect(await h.close()).toEqual({ is: "left" });
    expect(s.record()).toBeUndefined();
  });

  // The marker, never a rewrite of the record without the lock (the user's choice at step 20's re-check).
  it("writes the stopping marker when the last window's leave cannot take the lock, so the next window handles it",
    async () => {
      const s = await setup();
      const a = s.hub();
      expect((await a.join()).is).toBe("on");
      const { pid } = s.launched()[0]!;
      const record = readFileSync(hubRecord(s.paths), "utf8");
      const lock = path.join(s.paths.home, "join.lock");
      rmSync(lock, { force: true });
      mkdirSync(lock); // a folder where the lock file goes: the take fails with an error, not as busy
      expect(await a.close()).toEqual({ is: "gave up" });
      expect(s.inUse()).toEqual([]);
      expect(readFileSync(hubRecord(s.paths), "utf8")).toBe(record);
      expect(JSON.parse(readFileSync(stoppingFile(s.paths), "utf8"))).toEqual({ pid, start: s.record()!.start });
      expect(alive(pid)).toBe(true);
      rmSync(lock, { recursive: true });
      const b = s.hub();
      expect((await b.join()).is).toBe("on");
      expect(s.launched()).toHaveLength(2); // it treated the hub as stopping: its own start exited 2, and it found it
      expect(s.record()).toMatchObject({ pid, stopping: false });
      expect(existsSync(stoppingFile(s.paths))).toBe(false);
      expect(await b.close()).toEqual({ is: "stopped" });
      expect(alive(pid)).toBe(false);
    });

  it("keeps a record another window wrote after the marker, and does not treat its hub as stopping", async () => {
    const s = await setup();
    const a = s.hub();
    expect((await a.join()).is).toBe("on");
    // A marker for an earlier hub, left before this record was written under the lock.
    writeFileSync(stoppingFile(s.paths), JSON.stringify({ pid: 2_147_000_000, start: "an earlier hub's start" }));
    const record = readFileSync(hubRecord(s.paths), "utf8");
    const b = s.hub();
    expect(await b.join()).toEqual(await a.join());
    expect(s.launched()).toHaveLength(1);
    expect(readFileSync(hubRecord(s.paths), "utf8")).toBe(record);
    expect(existsSync(stoppingFile(s.paths))).toBe(false);
  });

  it("removes a stale stopping marker when there is no record", async () => {
    const s = await setup();
    mkdirSync(s.paths.home, { recursive: true });
    writeFileSync(stoppingFile(s.paths), JSON.stringify({ pid: 2_147_000_000, start: "a hub long gone" }));
    expect((await s.hub().join()).is).toBe("on");
    expect(existsSync(stoppingFile(s.paths))).toBe(false);
  });

  // Review of 0b7cda2, point C: a hub found after an exit with code 2 is asked without the key; a refusal (401) means
  // it has one, and it is reused as it is; any other answer means it has none, and it is treated as stopping.
  it("marks a hub found after an exit with code 2 by whether it refuses a call without the key", async () => {
    const s = await setup();
    mkdirSync(s.paths.home, { recursive: true });
    writeFileSync(hubToken(s.paths), JSON.stringify({ token: "this-install-s-token" }));
    const other = await otherHub(s, { MEMPALACE_MCP_HTTP_TOKEN: "this-install-s-token" });
    expect((await s.hub().join()).is).toBe("on");
    expect(s.launched()).toHaveLength(2); // the other, and this window's start, which exited 2
    expect(s.record()).toMatchObject({ pid: other.pid, env: null, token: true });
    expect((await s.hub().join()).is).toBe("on");
    expect(s.launched()).toHaveLength(2); // reused: no start
  });

  it("treats a hub found after an exit with code 2 that takes a call without the key as stopping", async () => {
    const s = await setup();
    const other = await otherHub(s);
    expect((await s.hub().join()).is).toBe("on");
    expect(s.record()).toMatchObject({ pid: other.pid, env: null, token: false });
    expect((await s.hub().join()).is).toBe("on");
    expect(s.launched()).toHaveLength(3); // the next join's start exited 2 too
  });

  it("joins another window's hub when its own start exits with code 2, writing the record from it", async () => {
    const s = await setup();
    const other = await otherHub(s);
    expect(s.record()).toBeUndefined();
    const joined = await s.hub().join();
    expect(joined).toEqual({ is: "on", url: `http://127.0.0.1:${serverinfoPort(s)}/mcp`, token: expect.any(String) });
    expect(s.launched()).toHaveLength(2); // the other, and this window's start, which exited 2
    expect(s.record()).toMatchObject({ pid: other.pid, port: serverinfoPort(s), stopping: false });
  });

  it("reports a start that exits with code 2 when no hub answers as a failed start", async () => {
    const s = await setup();
    s.control({ exit: 2 });
    expect(await s.hub({ startLimit: SHORT_START }).join()).toEqual({ is: "off", why: { is: "exited", code: 2 } });
    expect(s.record()).toBeUndefined();
  });

  it("starts one hub for two windows joining at once", async () => {
    const s = await setup();
    const [a, b] = await Promise.all([s.hub().join(), s.hub().join()]);
    expect(a.is).toBe("on");
    expect(b).toEqual(a);
    expect(s.launched()).toHaveLength(1);
  });

  it("turns memory off for a hub that reads back another backend", async () => {
    const s = await setup();
    s.control({ backend: "chroma" });
    expect(await s.hub().join()).toEqual({ is: "off", why: { is: "not tachikoma's", backend: "chroma" } });
  });

  it("turns memory off for a palace that records another model", async () => {
    const s = await setup();
    mkdirSync(s.paths.palace, { recursive: true });
    const db = new (load().DatabaseSync)(path.join(s.paths.palace, "sqlite_exact.sqlite3"));
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("embedder_model:mempalace_drawers", "other");
    db.close();
    expect(await s.hub().join()).toEqual({
      is: "off",
      why: { is: "not tachikoma's", backend: "sqlite_exact", model: "other" },
    });
  });

  it("counts a refused status on a palace with no file yet as not read yet, and memory is on", async () => {
    const s = await setup();
    s.control({ args: ["--refuse-status"] });
    expect((await s.hub().join()).is).toBe("on");
  });

  it("counts a refused status on a palace file with no model row as new, and memory is on", async () => {
    const s = await setup();
    s.control({ args: ["--refuse-status"] });
    mkdirSync(s.paths.palace, { recursive: true });
    const db = new (load().DatabaseSync)(path.join(s.paths.palace, "sqlite_exact.sqlite3"));
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    db.close();
    expect((await s.hub().join()).is).toBe("on");
  });

  it("takes a status that answers as it is, with no model, when the palace file cannot be opened", async () => {
    const s = await setup();
    mkdirSync(s.paths.palace, { recursive: true });
    writeFileSync(path.join(s.paths.palace, "sqlite_exact.sqlite3"), "not a database: broken on purpose\n");
    expect((await s.hub().join()).is).toBe("on");
  });

  it("turns memory off when the read-back passes its limit", async () => {
    const s = await setup();
    s.control({ args: ["--slow", "3000"] });
    expect(await s.hub({ readBack: 500 }).join()).toEqual({ is: "off", why: { is: "read-back", failed: "timed out" } });
  });

  it("turns memory off, and ends the hub it started, when the start-time read passes its limit", async () => {
    const s = await setup();
    s.control({ startDelay: 3_000 });
    expect(await s.hub({ startRead: 500 }).join()).toEqual({ is: "off", why: { is: "start time" } });
    const { pid } = s.launched()[0]!;
    await until(() => !alive(pid), "the started hub to be ended");
    expect(s.record()).toBeUndefined();
  });

  it("turns memory off for a refused status on a palace file that cannot be opened", async () => {
    const s = await setup();
    s.control({ args: ["--refuse-status"] });
    mkdirSync(s.paths.palace, { recursive: true });
    writeFileSync(path.join(s.paths.palace, "sqlite_exact.sqlite3"), "not a database: broken on purpose\n");
    expect(await s.hub().join()).toEqual({ is: "off", why: { is: "read-back", failed: "refused" } });
  });

  it("does not let a stale in-use file keep the hub running", async () => {
    const s = await setup();
    const h = s.hub();
    expect((await h.join()).is).toBe("on");
    const stale = path.join(s.paths.home, "in-use-a-crashed-window.json");
    writeFileSync(stale, "{}");
    const long = (Date.now() - FIGURES.stale - 1_000) / 1000;
    utimesSync(stale, long, long);
    const { pid } = s.launched()[0]!;
    expect(await h.close()).toEqual({ is: "stopped" });
    expect(alive(pid)).toBe(false);
  });

  // PR #26 review 3: a first start longer than the stale age. The window's in-use file is refreshed on the timer while
  // its start holds the join lock, so another window's leave, waiting for that lock, does not count it as gone and
  // stop the new hub. The file is made older here, and the timer moved on by one refresh, in place of the wait.
  it("keeps its in-use file fresh while its start runs, so another window's leave does not stop the hub",
    async () => {
      const s = await setup();
      const gate = path.join(s.top, "gate");
      s.control({ hold: gate });
      const a = s.hub();
      const joining = a.join();
      await until(() => s.launched().length === 1, "the start");
      const { pid } = s.launched()[0]!;
      const mine = path.join(s.paths.home, s.inUse()[0]!);
      const long = (Date.now() - FIGURES.stale - 1_000) / 1000;
      utimesSync(mine, long, long);
      vi.advanceTimersByTime(FIGURES.refresh);
      expect(Date.now() - statSync(mine).mtimeMs).toBeLessThan(FIGURES.stale);
      const leaving = s.hub().close();
      await sleep(FIGURES.lockRetry);
      writeFileSync(gate, "");
      expect((await joining).is).toBe("on");
      expect(await leaving).toEqual({ is: "left" });
      expect(alive(pid)).toBe(true);
      expect(s.record()?.pid).toBe(pid);
      // While the join ran, the timer only refreshed the file: it did not check the hub, so it told of no change.
      expect(s.events).toEqual([]);
    });

  it("refreshes its in-use file on the timer, and restarts a hub killed mid-run", async () => {
    const s = await setup();
    const h = s.hub();
    const first = await h.join();
    const { pid } = s.launched()[0]!;
    const mine = path.join(s.paths.home, s.inUse()[0]!);
    const long = (Date.now() - 60_000) / 1000;
    utimesSync(mine, long, long);
    process.kill(pid);
    await until(() => !alive(pid), "the hub to die");
    vi.advanceTimersByTime(FIGURES.refresh);
    await until(() => s.events.length >= 2, "the restart");
    expect(Date.now() - statSync(mine).mtimeMs).toBeLessThan(FIGURES.stale);
    expect(s.events[0]).toEqual({ is: "failing" });
    expect(s.events[1]).toEqual({ is: "on", url: expect.any(String), token: tokenOf(first) });
    expect(s.events[1]).not.toEqual(first);
    expect(s.launched()).toHaveLength(2);
    expect(alive(s.launched()[1]!.pid)).toBe(true);
  });

  it("reports a start that fails", async () => {
    const s = await setup();
    s.control({ exit: 1 });
    expect(await s.hub().join()).toEqual({ is: "off", why: { is: "exited", code: 1 } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a start that passes the start limit, and ends what it started", async () => {
    const s = await setup();
    s.control({ hold: path.join(s.top, "never") });
    expect(await s.hub({ startLimit: SHORT_START }).join()).toEqual({ is: "off", why: { is: "start limit" } });
    const { pid } = s.launched()[0]!;
    await until(() => !alive(pid), "the held start to be ended");
  });

  it("never starts a hub in a window older than the palace's version record", async () => {
    const s = await setup();
    mkdirSync(s.paths.palace, { recursive: true });
    writeFileSync(path.join(s.paths.palace, "tachikoma-version.json"), JSON.stringify({ mempalace: "9.0.0" }));
    expect(await s.hub().join()).toEqual({ is: "off", why: { is: "newer palace", version: "9.0.0" } });
    expect(s.launched()).toEqual([]);
  });

  it("joins a running hub from another environment folder as it is, and removes only older idle folders",
    async () => {
      const s = await setup("aaaa");
      const t = await setup("bbbb", s.top);
      const older = path.join(path.dirname(s.paths.env), "older");
      mkdirSync(older);
      writeFileSync(path.join(older, "tachikoma-ready.json"), JSON.stringify({ mempalace: "3.11.0" }));
      const same = path.join(path.dirname(s.paths.env), "same");
      mkdirSync(same);
      writeFileSync(path.join(same, "tachikoma-ready.json"), JSON.stringify({ mempalace: "3.12.0" }));
      const a = await s.hub().join();
      const b = await t.hub().join();
      expect(b).toEqual(a);
      expect(s.launched()).toHaveLength(1);
      expect(t.launched()).toEqual([]);
      expect(s.record()?.env).toBe(s.paths.env);
      expect(existsSync(older)).toBe(false);
      expect(existsSync(same)).toBe(true);
      expect(existsSync(t.paths.env)).toBe(true);
    });

  // PR #26 review 4: the leave stops the hub with the Python of the environment the hub runs from, which a newer
  // window may have removed only once no hub runs from it; the window's own Python only when that one is gone.
  it("stops the hub with the Python of the hub's own environment, not the leaving window's", async () => {
    const s = await setup("aaaa");
    const t = await setup("bbbb", s.top);
    const a = s.hub();
    const b = t.hub();
    expect((await a.join()).is).toBe("on");
    expect((await b.join()).is).toBe("on");
    const { pid } = s.launched()[0]!;
    expect(s.record()?.env).toBe(s.paths.env);
    expect(await a.close()).toEqual({ is: "left" });
    expect(await b.close()).toEqual({ is: "stopped" });
    expect(alive(pid)).toBe(false);
    const stops = (hash: string) =>
      lines(path.join(s.top, `record-${hash}.jsonl`)).filter((l) => l.helper?.op === "stop");
    expect(stops("aaaa")).toEqual([{ helper: { op: "stop", pid } }]);
    expect(stops("bbbb")).toEqual([]);
  });

  it("stops the hub with the leaving window's own Python when the hub's environment folder is gone", async () => {
    const s = await setup();
    const h = s.hub();
    expect((await h.join()).is).toBe("on");
    const { pid } = s.launched()[0]!;
    writeFileSync(hubRecord(s.paths), JSON.stringify({ ...s.record(), env: path.join(s.top, "a-removed-env") }));
    expect(await h.close()).toEqual({ is: "stopped" });
    expect(alive(pid)).toBe(false);
    expect(lines(path.join(s.top, "record-test.jsonl")).filter((l) => l.helper?.op === "stop"))
      .toEqual([{ helper: { op: "stop", pid } }]);
  });

  describe("closing", () => {
    it("closed while a hub start is held, as the only window: no hub, no in-use file, a free lock, no timer",
      async () => {
        const s = await setup();
        const gate = path.join(s.top, "gate");
        s.control({ hold: gate });
        const h = s.hub();
        const joining = h.join();
        await until(() => s.launched().length === 1, "the start");
        const closing = h.close();
        writeFileSync(gate, "");
        expect(await joining).toEqual({ is: "closed" });
        expect(await closing).toEqual({ is: "stopped" });
        expect(alive(s.launched()[0]!.pid)).toBe(false);
        expect(s.inUse()).toEqual([]);
        const lock = tryLock(s.paths.home, "join");
        expect(lock).not.toBeNull();
        lock?.release();
        expect(vi.getTimerCount()).toBe(0);
        expect(s.events).toEqual([]);
        expect(await h.join()).toEqual({ is: "closed" });
      });

    it("closed while waiting for the join lock gives up at once", async () => {
      const s = await setup();
      mkdirSync(s.paths.home, { recursive: true });
      const held = tryLock(s.paths.home, "join")!;
      try {
        const h = s.hub();
        const joining = h.join();
        await sleep(FIGURES.lockRetry + 100);
        const began = Date.now();
        const closing = h.close();
        expect(await joining).toEqual({ is: "closed" });
        expect(Date.now() - began).toBeLessThan(FIGURES.lockRetry);
        held.release();
        expect(await closing).toEqual({ is: "left" });
        expect(s.launched()).toEqual([]);
      } finally {
        held.release();
      }
    });

    // The caller's signal cuts only the wait for the join lock (the plan's "Closing", the user's choice at step 20's
    // re-check): a join starting a hub finishes its step, and the leave then stops that hub as the last window.
    it("lets a join that is starting a hub finish when the caller's signal fires, then stops its hub", async () => {
      const s = await setup();
      const gate = path.join(s.top, "gate");
      s.control({ hold: gate });
      const h = s.hub();
      const joining = h.join();
      let joined = false;
      void joining.then(() => (joined = true));
      await until(() => s.launched().length === 1, "the start");
      const { pid } = s.launched()[0]!;
      const stop = new AbortController();
      stop.abort();
      let leftAfterJoin: boolean | undefined;
      const closing = h.close(stop.signal).then((r) => {
        leftAfterJoin = joined;
        return r;
      });
      await sleep(FIGURES.lockRetry);
      expect(leftAfterJoin).toBeUndefined();
      writeFileSync(gate, "");
      expect(await joining).toEqual({ is: "closed" });
      expect(await closing).toEqual({ is: "stopped" });
      expect(leftAfterJoin).toBe(true);
      expect(alive(pid)).toBe(false);
      expect(s.record()).toBeUndefined();
      expect(s.inUse()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    // A process of Node's own that joins and leaves must then end by itself, within the tests' limit: as it is, and
    // with the caller's signal fired while its join is starting a hub.
    it.each([
      { name: "once it has left", during: false, expected: ["on", "stopped"] },
      { name: "once it has left with its signal fired during a start", during: true, expected: ["closed", "stopped"] },
    ])("holds nothing of the process open $name", async ({ during, expected }) => {
      const s = await setup();
      const tmp = path.join(s.top, "tmp");
      mkdirSync(tmp);
      const gate = path.join(s.top, "gate");
      if (during) s.control({ hold: gate });
      const code = [
        `const { Hub } = await import(${JSON.stringify(pathToFileURL(path.resolve("src/memory/hub.ts")).href)});`,
        "const fs = await import('node:fs');",
        "const o = JSON.parse(process.env.TACHI_TEST_HUB);",
        "const h = new Hub({ paths: o.paths, env: process.env, figures: o.figures,",
        "  launch: (file) => ({ command: process.execPath, args: [file] }) });",
        "const joining = h.join();",
        "let left;",
        "if (o.during) {",
        "  while (!(fs.existsSync(o.record) && fs.readFileSync(o.record, 'utf8').includes('\"hub\"'))) {",
        "    await new Promise((r) => setTimeout(r, 20));",
        "  }",
        "  const stop = new AbortController();",
        "  stop.abort();",
        "  left = h.close(stop.signal);",
        "  fs.writeFileSync(o.gate, '');",
        "}",
        "const joined = await joining;",
        "left = await (left ?? h.close());",
        "process.stdout.write(JSON.stringify([joined.is, left.is]));",
      ].join("\n");
      const hub = JSON.stringify({ paths: s.paths, figures: TEST, during, gate,
        record: path.join(s.top, "record-test.jsonl") });
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
        env: { ...s.env, TEMP: tmp, TMP: tmp, TACHI_TEST_HUB: hub },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      const ended = await Promise.race([
        new Promise<number | null>((resolve) => child.on("exit", resolve)),
        sleep(LIMIT).then(() => "still running" as const),
      ]);
      if (ended === "still running") child.kill();
      expect(ended).toBe(0);
      expect(JSON.parse(out)).toEqual(expected);
      expect(s.record()).toBeUndefined();
    });

    it("is the same when closed twice", async () => {
      const s = await setup();
      const h = s.hub();
      expect((await h.join()).is).toBe("on");
      const once = h.close();
      const twice = h.close();
      expect(await once).toEqual({ is: "stopped" });
      expect(await twice).toEqual({ is: "stopped" });
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
