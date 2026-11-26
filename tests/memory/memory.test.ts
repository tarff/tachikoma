import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Bus, type ErrorEvent } from "../../src/core/bus.js";
import type { Palace } from "../../src/memory/client.js";
import { hubEnv } from "../../src/memory/env.js";
import { type Figures, hubRecord } from "../../src/memory/hub.js";
import { type Program, readyFile } from "../../src/memory/install.js";
import { askLesson, lessonRequest } from "../../src/memory/lessons.js";
import { Memory, type MemoryOptions, type MemoryState } from "../../src/memory/memory.js";
import { type OsLock, tryLock } from "../../src/memory/oslock.js";
import { LESSONS, makeMemoryFolder, memoryPaths } from "../../src/memory/paths.js";
import { Held, tempDir } from "../helpers.js";

// Memory's state, its reasons and its closing (8d plan, step 21), against the stand-ins only: the stand-in uv
// (tests/standin/uv.mjs), the stand-in MemPalace (tests/memory/standin.mjs) as the hub and as the user's own
// `mempalace-mcp`, and a model served by a local HTTP server. No real hub, uv, Python or MemPalace program is run.
// Every home, AppData, data folder and PATH, of this process and of every child, is in a folder the test made; no
// error log is attached, so no row is written anywhere: the rows are the bus's error events, one each.

const STANDIN = path.resolve("tests/memory/standin.mjs");
const UV = path.resolve("tests/standin/uv.mjs");
const STANDIN_UV: Program = { command: process.execPath, args: [UV] };
// The tests' own limit for something that should happen: long enough never to be reached by one that does.
const LIMIT = 10_000;
// The stand-ins' answers get the tests' limit; the start limit is shortened only where a test waits for it to pass.
const TEST: Partial<Figures> = { readBack: LIMIT, startRead: LIMIT, stop: LIMIT };
const lead = () => "fake:a";
// The hub's three settings (step 16), which the user's own program never gets.
const HUB_SETTINGS = ["MEMPALACE_EMBEDDING_MODEL", "MEMPALACE_MCP_WRITER_WAIT_SECONDS", "MEMPALACE_MCP_IDLE_HOURS"];
const MODEL_BYTES = Buffer.from("a made-up model archive, for memory's tests\n".repeat(1_000));
const MODEL_HASH = createHash("sha256").update(MODEL_BYTES).digest("hex");

// The environment's Python, for Tachikoma's own palace: a script the test writes, started with Node by `launch` with
// the Python's own path first. Asked as the hub (`-I -m mempalace.mcp_server ...`) or as the supervisor's helper
// (`-I -c <helper> start|stop ...`) it does what tests/memory/hub.test.ts's stand-in Python does, told by
// `control.json` in the folder TACHI_TEST_HUB names (it ends itself when that file is gone); asked anything else (the
// installer's unpacking and version check) it is step 19's stand-in Python, tests/standin/uv.mjs.
const PYTHON = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const [file, ...rest] = process.argv.slice(2);
process.argv = [process.argv[0], file, ...rest];
const helper = rest[1] === "-c" && (rest[3] === "start" || rest[3] === "stop");
if (!helper && !rest.includes("mempalace.mcp_server")) {
  import(pathToFileURL(process.env.TACHI_TEST_UV_SCRIPT).href);
} else {
  const dir = process.env.TACHI_TEST_HUB;
  const controlFile = path.join(dir, "control.json");
  const c = JSON.parse(fs.readFileSync(controlFile, "utf8"));
  const startOf = (pid) => path.join(dir, "start-" + pid);
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e.code === "EPERM";
    }
  };
  const startTime = (pid) => (!alive(pid) ? null : fs.existsSync(startOf(pid)) ? fs.readFileSync(startOf(pid), "utf8") :
    "another program's");
  if (helper) {
    const [op, p, want, ms] = rest.slice(3);
    const pid = Number(p);
    const say = (t) => process.stdout.write(t + "\n");
    const st = startTime(pid);
    if (op === "start") say(st ?? "gone");
    else if (st === null) say("gone");
    else if (st !== want) say("differs");
    else {
      process.kill(pid);
      const began = Date.now();
      const wait = () => {
        if (!alive(pid)) say("stopped " + (Date.now() - began) + " " + pid);
        else if (Date.now() - began > Number(ms)) say("running " + (Date.now() - began) + " " + pid);
        else setTimeout(wait, 10);
      };
      wait();
    }
  } else {
    fs.appendFileSync(c.record, JSON.stringify({ hub: { args: rest, env: process.env, pid: process.pid } }) + "\n");
    fs.writeFileSync(startOf(process.pid), String(Date.now()) + "-" + String(process.hrtime.bigint()));
    setInterval(() => {
      if (!fs.existsSync(controlFile)) process.exit(0);
    }, 100);
    (async () => {
      while (c.hold && !fs.existsSync(c.hold)) await new Promise((r) => setTimeout(r, 20));
      if (c.exit !== undefined) process.exit(c.exit);
      if (c.backend) process.argv[process.argv.indexOf("--backend") + 1] = c.backend;
      await import(pathToFileURL(c.standin).href);
    })();
  }
}
`;

interface Control {
  exit?: number;
  hold?: string;
  backend?: string;
}

const made: Memory[] = [];
const hubDirs: string[] = [];
const servers: Server[] = [];
const locks: OsLock[] = [];
const children: ChildProcess[] = [];
const programs: string[] = []; // the user's-program stand-ins' records

// One test has the hub's start ended by a signal at once: Node names the signal only for a child it ended itself, so
// the start is ended through its own ChildProcess. Every other spawn is passed through as it is.
const endStart = vi.hoisted(() => ({ on: false }));
vi.mock("node:child_process", async (real) => {
  const cp = await real<typeof import("node:child_process")>();
  const spawn = (...a: unknown[]) => {
    const child = (cp.spawn as (...x: unknown[]) => ChildProcess)(...a);
    if (endStart.on && Array.isArray(a[1]) && a[1].includes("mempalace.mcp_server")) child.kill("SIGKILL");
    return child;
  };
  return { ...cp, spawn };
});

beforeEach(() => {
  // The hub's own refresh timer runs only where a test moves it on.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

// Every part runs even when an earlier one fails, so a failing run leaves nothing behind.
afterEach(async () => {
  endStart.on = false;
  const closing = Promise.allSettled(made.splice(0).map((m) => m.close({ lessons: "cancel" })));
  for (const lock of locks.splice(0)) lock.release();
  await Promise.race([closing, sleep(LIMIT)]);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  const started = hubDirs.flatMap((dir) => launches(path.join(dir, "record.jsonl")).map((l) => l.pid));
  for (const dir of hubDirs.splice(0)) rmSync(path.join(dir, "control.json"), { force: true });
  for (const record of programs.splice(0)) {
    for (const pid of starts(record)) started.push(pid);
  }
  for (const child of children.splice(0)) {
    // Waited for with the stand-ins below: it works in the test's folder (cleanup plan, step 9).
    if (child.exitCode === null && child.signalCode === null && child.pid) started.push(child.pid);
    child.kill();
  }
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  // The folders are removed once this has run, even when it fails (tempDir; cleanup plan, step 9).
  await until(() => started.every((pid) => !alive(pid)), "the stand-ins to end");
  await Promise.race([closing, sleep(LIMIT)]);
}, 4 * LIMIT);

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

const lines = (record: string) =>
  existsSync(record) ? readFileSync(record, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
type Launch = { args: string[]; env: NodeJS.ProcessEnv; pid: number };
const launches = (record: string): Launch[] => lines(record).flatMap((l) => (l.hub ? [l.hub] : []));
const starts = (record: string): number[] => lines(record).flatMap((l) => (l.start ? [l.start.pid] : []));

// This process's own home, AppData folders, data folder and PATH, in the folder the test made, as the user's own
// program is started with this process's environment (step 16: commandEnv and nothing more); the hub's three settings
// are not set, so none can come from here.
function isolate(top: string) {
  const user = path.join(top, "user");
  const bin = path.join(top, "bin");
  mkdirSync(bin, { recursive: true });
  const env = {
    PATH: bin,
    USERPROFILE: user,
    HOME: user,
    APPDATA: path.join(user, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(user, "AppData", "Local"),
    TACHI_DATA_DIR: path.join(top, "tachi-data"),
  };
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  for (const name of HUB_SETTINGS) vi.stubEnv(name, undefined);
  return env;
}

function watch(bus: Bus, m: () => Memory | undefined) {
  const states: MemoryState[] = [];
  const ons: boolean[] = [];
  const errors: ErrorEvent[] = [];
  bus.on("memory", (s) => {
    states.push(s);
    ons.push(m()?.on() ?? false);
  });
  bus.on("error", (e) => errors.push(e));
  return { states, ons, errors };
}

// Tachikoma's own palace: a data folder, the stand-in Python and its control, the hub's record, and the uv stand-in's
// record, all in a folder the test made.
async function own(o: { ready?: boolean; control?: Control; env?: Record<string, string> } = {}) {
  const top = tempDir("tachi-memory-");
  const base = isolate(top);
  const hub = path.join(top, "hub");
  mkdirSync(hub);
  hubDirs.push(hub);
  const record = path.join(hub, "record.jsonl");
  const uvRecord = path.join(top, "uv.jsonl");
  const python = path.join(top, "python.cjs");
  writeFileSync(python, PYTHON);
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PATH")),
    ...base,
    TACHI_TEST_HUB: hub,
    TACHI_TEST_UV_SCRIPT: UV,
    TACHI_TEST_UV_RECORD: uvRecord,
    ...o.env,
  };
  const paths = memoryPaths(path.join(top, "data"), "test");
  const control = (c: Control = {}) =>
    writeFileSync(path.join(hub, "control.json"), JSON.stringify({ record, standin: STANDIN, ...c }));
  control(o.control);
  if (o.ready) {
    mkdirSync(paths.env, { recursive: true });
    writeFileSync(readyFile(paths), JSON.stringify({ mempalace: "3.12.0" }));
  }
  const launch = (file: string): Program => ({ command: process.execPath, args: [python, file] });
  const bus = new Bus();
  let last: Memory | undefined;
  const seen = watch(bus, () => last);
  const memory = (more: Partial<MemoryOptions> = {}) => {
    last = new Memory({ memory: "own", bus, lead, paths, env, launch, uv: STANDIN_UV, figures: TEST, ...more });
    made.push(last);
    return last;
  };
  const uvStarts = () => lines(uvRecord).filter((l) => l.as === "uv");
  return { top, paths, env, control, memory, ...seen, launched: () => launches(record), uvStarts, python };
}

// The user's own MemPalace: the stand-in over stdio, at its own path, started with Node by `launch`, which adds only
// the test's own `--record` and the arguments that make it lack a tool.
async function use(args: string[] = [], at = STANDIN) {
  const top = tempDir("tachi-memory-");
  const env = isolate(top);
  const record = path.join(top, "record.jsonl");
  programs.push(record);
  const bus = new Bus();
  let last: Memory | undefined;
  const seen = watch(bus, () => last);
  const memory = (more: Partial<MemoryOptions> = {}) => {
    last = new Memory({ memory: { use: at }, bus, lead,
      launch: (file) => ({ command: process.execPath, args: [file, "--record", record, ...args] }), ...more });
    made.push(last);
    return last;
  };
  const calls = () => lines(record).flatMap((l) => (l.call ? [l.call] : []));
  const added = () => calls().filter((c) => c.name === "mempalace_add_drawer").map((c) => c.arguments.content);
  const started = () => lines(record).flatMap((l) => (l.start ? [l.start] : []));
  return { top, env, record, memory, ...seen, calls, added, started };
}

async function modelServer() {
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-length": MODEL_BYTES.length });
    res.end(MODEL_BYTES);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/all-MiniLM-L6-v2/onnx.tar.gz`, sha256: MODEL_HASH };
}

// The ports MemPalace's serverinfo.json files name, under the home the hub was given.
function serverinfoPorts(home: string): number[] {
  const root = path.join(home, ".mempalace", "server");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((key) => {
    try {
      return [JSON.parse(readFileSync(path.join(root, key, "serverinfo.json"), "utf8")).port as number];
    } catch {
      return [];
    }
  });
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address() as { port: number };
  await new Promise((resolve) => s.close(resolve));
  return port;
}

const settled = async (p: Promise<unknown>) => {
  let done = false;
  void p.then(() => (done = true), () => (done = true));
  await sleep(50);
  return done;
};

const turnedOn = (s: { states: MemoryState[] }) => until(() => s.states.some((x) => x.is === "on"), "memory on");
const lastState = (s: { states: MemoryState[] }) => s.states.at(-1);

// A lesson request the test holds open: the request, its stop signal as the service gave it, and the hand that lets
// it answer; stored as a lesson would be, in the lessons room, by the palace the service gives.
function heldLesson(m: Memory) {
  let answer!: (text: string | undefined) => void;
  const asked = new Promise<string | undefined>((resolve) => (answer = resolve));
  const seen: { signal?: AbortSignal; stored: number } = { stored: 0 };
  m.lesson(
    (signal) => {
      seen.signal = signal;
      return asked;
    },
    async (palace: Palace, text: string) => {
      seen.stored++;
      await palace.add(LESSONS, "a made-up lesson's label", text, LIMIT);
    },
  );
  return { answer, seen };
}

describe("memory's state", () => {
  it("is switched off when the settings or the flag say so, and starts nothing", async () => {
    const s = await use();
    const m = s.memory({ memory: "off" });
    expect(m.state).toEqual({ is: "switched off" });
    expect(m.on()).toBe(false);
    m.start();
    m.setUp();
    await sleep(200);
    expect(s.states).toEqual([]);
    expect(s.started()).toEqual([]);
    expect(m.palace).toBeUndefined();
  });

  it("is not set up without a ready environment, then sets up in the background and joins: on", async () => {
    const model = await modelServer();
    const s = await own();
    const m = s.memory({ model });
    expect(m.state).toEqual({ is: "not set up" });
    m.start(); // nothing to join yet
    await sleep(200);
    expect(s.states).toEqual([]);
    m.setUp();
    await turnedOn(s);
    expect(s.states).toEqual([{ is: "setting up" }, { is: "on" }]);
    expect(s.ons).toEqual([false, true]);
    expect(existsSync(readyFile(s.paths))).toBe(true);
    expect(s.launched()).toHaveLength(1);
    expect(m.palace).toBeDefined();
    expect(s.errors).toEqual([]);
  });

  it("joins at the start when the environment is ready", async () => {
    const s = await own({ ready: true });
    const m = s.memory();
    expect(m.state).toEqual({ is: "setting up" });
    expect(m.on()).toBe(false);
    m.start();
    await turnedOn(s);
    expect(s.states).toEqual([{ is: "on" }]);
    expect(m.on()).toBe(true);
    expect(s.uvStarts()).toEqual([]);
    expect(m.offers).toEqual({ lookup: true, counts: true });
  });

  it("is on, with no error row, when its start exits with code 2 and another window's hub answers", async () => {
    const s = await own({ ready: true });
    mkdirSync(s.paths.home, { recursive: true });
    const port = await freePort();
    const other = spawn(process.execPath, [s.python, s.paths.envPython, "-I", "-m", "mempalace.mcp_server",
      "--transport", "http", "--host", "127.0.0.1", "--port", String(port), "--palace", s.paths.palace, "--backend",
      "sqlite_exact"], { cwd: s.paths.home, env: hubEnv(s.paths, s.env), stdio: "ignore", windowsHide: true });
    children.push(other);
    await until(() => s.launched().some((l) => l.pid === other.pid), "the other hub to start");
    await until(() => serverinfoPorts(s.paths.home).includes(port), "the other hub's serverinfo.json");
    const m = s.memory();
    m.start();
    await turnedOn(s);
    expect(s.launched()).toHaveLength(2); // the other window's, and this one's, which exited 2
    expect(JSON.parse(readFileSync(hubRecord(s.paths), "utf8")).pid).toBe(other.pid);
    expect(s.states).toEqual([{ is: "on" }]);
    expect(s.errors).toEqual([]);
  });

  it("goes failing, then on again, when the hub's timer finds it gone and restarts it", async () => {
    const s = await own({ ready: true });
    const m = s.memory();
    m.start();
    await turnedOn(s);
    const first = s.launched()[0]!.pid;
    process.kill(first);
    await until(() => !alive(first), "the hub to die");
    vi.advanceTimersByTime(5_000);
    await until(() => s.states.length === 3, "the restart");
    expect(s.states).toEqual([
      { is: "on" },
      { is: "failing", reason: "Memory is failing: the hub stopped answering; restarting it." },
      { is: "on" },
    ]);
    expect(s.ons).toEqual([true, false, true]);
    expect(s.launched()).toHaveLength(2);
    expect(s.errors.map((e) => e.message)).toEqual(["Memory is failing: the hub stopped answering; restarting it."]);
    expect(s.errors[0]).toMatchObject({ kind: "memory", attempted: "memory", lead: "fake:a" });
  });

  it("writes one error row per change of state, not one per failed call", async () => {
    const s = await own({ ready: true });
    const m = s.memory();
    m.start();
    await turnedOn(s);
    const palace = m.palace!;
    s.control({ exit: 1 });
    const first = s.launched()[0]!.pid;
    process.kill(first);
    await until(() => !alive(first), "the hub to die");
    for (let i = 0; i < 3; i++) await palace.search("anything", "wing", 5, LIMIT);
    await until(() => lastState(s)?.is === "off", "memory off");
    const off = "Memory is off: the hub stopped answering and could not be restarted (exit code: 1).";
    expect(s.states).toEqual([
      { is: "on" },
      { is: "failing", reason: "Memory is failing: the hub stopped answering; restarting it." },
      { is: "off", reason: off },
    ]);
    expect(s.errors.map((e) => e.message)).toEqual([
      "Memory is failing: the hub stopped answering; restarting it.",
      off,
    ]);
    expect(m.on()).toBe(false);
    expect(m.palace).toBeUndefined();
  });

  it.each([
    { name: "a start that exits", control: { exit: 1 }, figures: {},
      reason: "Memory is off: the hub did not start (exit code: 1)." },
    { name: "a start that passes its limit", control: { hold: "never" }, figures: { startLimit: 1_500 },
      reason: "Memory is off: the hub did not start (it did not answer within 1.5 s)." },
    { name: "a hub with another backend", control: { backend: "chroma" }, figures: {},
      reason: "Memory is off: the hub is not using Tachikoma's storage and model (backend: chroma)." },
  ])("turns off with the reason for $name, in one error row", async ({ control, figures, reason }) => {
    const s = await own({ ready: true });
    s.control(control.hold ? { hold: path.join(s.top, control.hold) } : control);
    const m = s.memory({ figures: { ...TEST, ...figures } });
    m.start();
    await until(() => lastState(s)?.is === "off", "memory off");
    expect(s.states).toEqual([{ is: "off", reason }]);
    expect(s.errors.map((e) => e.message)).toEqual([reason]);
    expect(m.on()).toBe(false);
  });

  it("says the signal that ended a hub's start", async () => {
    const s = await own({ ready: true });
    endStart.on = true;
    const m = s.memory();
    m.start();
    await until(() => lastState(s)?.is === "off", "memory off");
    const reason = "Memory is off: the hub did not start (ended by signal SIGKILL).";
    expect(s.states).toEqual([{ is: "off", reason }]);
    expect(s.errors.map((e) => e.message)).toEqual([reason]);
  });

  it("turns off with the approved line when the hub does not say in time which storage and model it uses",
    async () => {
      const s = await own({ ready: true });
      const m = s.memory({ figures: { ...TEST, readBack: 1 } });
      m.start();
      await until(() => lastState(s)?.is === "off", "memory off");
      expect(s.states).toEqual([{ is: "off", reason: "Memory is off: the hub did not say in time which storage and " +
        "model it uses. The next launch tries again." }]);
    });

  it("turns off with the design's line when a newer Tachikoma has moved the palace on", async () => {
    const s = await own({ ready: true });
    mkdirSync(s.paths.palace, { recursive: true });
    writeFileSync(path.join(s.paths.palace, "tachikoma-version.json"), JSON.stringify({ mempalace: "9.0.0" }));
    const m = s.memory();
    m.start();
    await until(() => lastState(s)?.is === "off", "memory off");
    const reason = "Memory is off: a newer Tachikoma has moved the palace to MemPalace 9.0.0. Update Tachikoma to " +
      "use memory again.";
    expect(s.states).toEqual([{ is: "off", reason }]);
    expect(s.errors.map((e) => e.message)).toEqual([reason]);
    expect(s.launched()).toEqual([]);
  });

  it("leaves a failed set-up off with the reason, and a second launch tries again", async () => {
    const model = await modelServer();
    const s = await own({ env: { TACHI_TEST_UV_FAIL: "a made-up uv failure" } });
    const m = s.memory({ model });
    m.setUp();
    await until(() => lastState(s)?.is === "off", "memory off");
    const reason = "Memory is off: setting it up failed (a made-up uv failure). The next launch tries again.";
    expect(s.states).toEqual([{ is: "setting up" }, { is: "off", reason }]);
    expect(s.errors.map((e) => e.message)).toEqual([reason]);
    expect(existsSync(readyFile(s.paths))).toBe(false);
    await m.close({ lessons: "cancel" });
    const again = s.memory({ model, env: { ...s.env, TACHI_TEST_UV_FAIL: "" } });
    expect(again.state).toEqual({ is: "not set up" });
    again.setUp();
    await until(() => lastState(s)?.is === "on", "memory on");
    expect(s.uvStarts()).toHaveLength(2);
    expect(existsSync(readyFile(s.paths))).toBe(true);
  });

  // 8d plan, step 28: /memory setup after an install that failed in this launch tries again (the user's choice,
  // 2026-11-20, "Try again now"). The failed try's lock is free and its folder without a ready file is made again.
  it("sets up again in the same launch after a failed install: setting up, then on", async () => {
    const model = await modelServer();
    const s = await own({ env: { TACHI_TEST_UV_FAIL: "a made-up uv failure" } });
    const m = s.memory({ model });
    m.setUp();
    await until(() => lastState(s)?.is === "off", "memory off");
    s.env.TACHI_TEST_UV_FAIL = ""; // the environment memory was given, read at each install
    m.setUp();
    await until(() => lastState(s)?.is === "on", "memory on");
    const reason = "Memory is off: setting it up failed (a made-up uv failure). The next launch tries again.";
    expect(s.states).toEqual([{ is: "setting up" }, { is: "off", reason }, { is: "setting up" }, { is: "on" }]);
    expect(s.errors.map((e) => e.message)).toEqual([reason]);
    expect(s.uvStarts()).toHaveLength(2);
    expect(existsSync(readyFile(s.paths))).toBe(true);
  });

  it("does not set up again when its environment is ready and its hub failed", async () => {
    const s = await own({ ready: true, control: { exit: 1 } });
    const m = s.memory();
    m.start();
    await until(() => lastState(s)?.is === "off", "memory off");
    const states = s.states.length;
    m.setUp();
    expect(s.states).toHaveLength(states);
    expect(s.uvStarts()).toEqual([]);
  });

  it("says the model's own line when the download does not match its hash", async () => {
    const model = await modelServer();
    const s = await own();
    const m = s.memory({ model: { ...model, sha256: "0".repeat(64) } });
    m.setUp();
    await until(() => lastState(s)?.is === "off", "memory off");
    const reason = "Memory is off: the downloaded model did not match its expected hash. The next launch tries again.";
    expect(s.states).toEqual([{ is: "setting up" }, { is: "off", reason }]);
    expect(s.errors.map((e) => e.message)).toEqual([reason]);
  });

  it("stays not set up without uv, with the design's line as its reason and no error row", async () => {
    const s = await own();
    const m = s.memory({ uv: null });
    m.setUp();
    await until(() => lastState(s)?.is === "not set up", "not set up");
    expect(s.states).toEqual([{ is: "setting up" }, { is: "not set up", reason: "Memory is off: it needs uv, which " +
      "was not found on PATH. Install uv (https://docs.astral.sh/uv/) and start Tachikoma again." }]);
    expect(s.errors).toEqual([]);
  });

  it("waits while another window installs, then joins once that install is done", async () => {
    const s = await own();
    makeMemoryFolder(s.paths);
    const held = tryLock(s.paths.root, "install")!;
    locks.push(held);
    const m = s.memory();
    m.setUp();
    await sleep(1_200); // more than two of the 500 ms tries
    expect(s.states).toEqual([{ is: "setting up" }]);
    expect(s.uvStarts()).toEqual([]);
    mkdirSync(s.paths.env, { recursive: true });
    writeFileSync(readyFile(s.paths), JSON.stringify({ mempalace: "3.12.0" }));
    held.release();
    await turnedOn(s);
    expect(s.uvStarts()).toEqual([]);
  });
});

describe("the user's own MemPalace", () => {
  it("is run as it is, and is on without exact-label look-up, removal or counts, which it says are absent",
    async () => {
      const s = await use(["--lack", "mempalace_delete_by_source", "--lack", "mempalace_list_drawers"]);
      const m = s.memory();
      expect(m.state).toEqual({ is: "setting up" });
      m.start();
      await turnedOn(s);
      expect(s.states).toEqual([{ is: "on" }]);
      expect(m.offers).toEqual({ lookup: false, counts: false });
      const [started] = s.started();
      // No palace, backend or model argument: only the test's own record and the tools it lacks.
      expect(started.argv).toEqual(["--record", s.record, "--lack", "mempalace_delete_by_source", "--lack",
        "mempalace_list_drawers"]);
      for (const name of HUB_SETTINGS) {
        expect(Object.keys(started.env).map((k) => k.toUpperCase())).not.toContain(name);
      }
      // Its home is the one it was given, never memory's.
      expect(started.env.USERPROFILE).toBe(s.env.USERPROFILE);
      expect(started.env.HOME).toBe(s.env.HOME);
      expect(started.env.APPDATA).toBe(s.env.APPDATA);
      expect(started.env.LOCALAPPDATA).toBe(s.env.LOCALAPPDATA);
      // No read-back: its backend and model are never asked.
      expect(s.calls().map((c) => c.name)).not.toContain("mempalace_status");
      expect(s.errors).toEqual([]);
    });

  it.each([
    { lack: ["mempalace_search"], names: "mempalace_search" },
    { lack: ["mempalace_add_drawer"], names: "mempalace_add_drawer" },
    { lack: ["mempalace_search", "mempalace_add_drawer"], names: "mempalace_search and mempalace_add_drawer" },
  ])("turns off, naming $names, when the program lacks it", async ({ lack, names }) => {
    const s = await use(lack.flatMap((t) => ["--lack", t]));
    const m = s.memory();
    m.start();
    await until(() => lastState(s)?.is === "off", "memory off");
    const reason = `Memory is off: your MemPalace at ${STANDIN} does not offer ${names}, which Tachikoma needs.`;
    expect(s.states).toEqual([{ is: "off", reason }]);
    expect(s.errors.map((e) => e.message)).toEqual([reason]);
    const { pid } = s.started()[0];
    await until(() => !alive(pid), "the program to be stopped");
  });

  it("turns off when the program cannot be started", async () => {
    const top = tempDir("tachi-memory-");
    const missing = path.join(top, "no-such-mempalace-mcp");
    const s = await use([], missing);
    const m = s.memory({ launch: (file) => ({ command: file, args: [] }) });
    m.start();
    await until(() => lastState(s)?.is === "off", "memory off");
    const reason = (lastState(s) as { reason: string }).reason;
    expect(reason).toBe(`Memory is off: ${missing} could not be started (spawn ${missing} ENOENT).`);
    expect(s.errors.map((e) => e.message)).toEqual([reason]);
  });

  it("turns off when the program stops answering", async () => {
    const s = await use();
    const m = s.memory();
    m.start();
    await turnedOn(s);
    process.kill(s.started()[0].pid);
    await until(() => lastState(s)?.is === "off", "memory off");
    const reason = `Memory is off: your MemPalace at ${STANDIN} stopped answering.`;
    expect(s.states).toEqual([{ is: "on" }, { is: "off", reason }]);
    expect(s.errors.map((e) => e.message)).toEqual([reason]);
  });
});

// The gate in memory itself (8d plan, step 26, after its review; the user, 2026-11-20): a lesson request made straight
// to memory starts only while memory is on, so the provider is sent nothing in any other state.
describe("lesson requests and memory's state", () => {
  // A lesson request made straight to memory, sent to a held provider only if memory lets it start.
  const asks = async (m: Memory) => {
    const held = new Held();
    m.lesson((signal) => askLesson(held, lessonRequest("a 1", "it broke", "a 2"), signal, new Bus()), async () => {});
    await sleep(50);
    return held.asked.length;
  };

  it("sends the provider no request while memory is setting up", async () => {
    const s = await use();
    const m = s.memory();
    expect(m.state).toEqual({ is: "setting up" });
    expect(await asks(m)).toBe(0);
  });

  it("sends the provider no request while memory is failing", async () => {
    const s = await own({ ready: true });
    const m = s.memory();
    m.start();
    await turnedOn(s);
    // The restart's hub start is held, so memory stays failing.
    s.control({ hold: path.join(s.top, "never") });
    const first = s.launched()[0]!.pid;
    process.kill(first);
    await until(() => !alive(first), "the hub to die");
    vi.advanceTimersByTime(5_000);
    await until(() => lastState(s)?.is === "failing", "memory failing");
    expect(await asks(m)).toBe(0);
  });

  it("sends the provider no request while memory is off", async () => {
    const s = await use(["--lack", "mempalace_search"]);
    const m = s.memory();
    m.start();
    await until(() => lastState(s)?.is === "off", "memory off");
    expect(await asks(m)).toBe(0);
  });

  it("sends the provider the request while memory is on", async () => {
    const s = await use();
    const m = s.memory();
    m.start();
    await turnedOn(s);
    expect(await asks(m)).toBe(1);
  });
});

describe("closing", () => {
  it("waits for a lesson request when asked: one released during the wait is stored once, then it returns",
    async () => {
      const s = await use();
      const m = s.memory();
      m.start();
      await turnedOn(s);
      const l = heldLesson(m);
      const closing = m.close({ lessons: "wait" });
      expect(await settled(closing)).toBe(false);
      expect(s.states.at(-1)).toEqual({ is: "winding down" });
      expect(m.on()).toBe(false);
      l.answer("A made-up lesson.");
      await closing;
      expect(s.added()).toEqual(["A made-up lesson."]);
      expect(l.seen.signal?.aborted).toBe(false);
      expect(s.states).toEqual([{ is: "on" }, { is: "winding down" }, { is: "closed" }]);
      await until(() => !alive(s.started()[0].pid), "the program to be stopped");
    });

  it("cancels a lesson request when asked: nothing is stored, and one that answers after closing is dropped",
    async () => {
      const s = await use();
      const m = s.memory();
      m.start();
      await turnedOn(s);
      const l = heldLesson(m);
      await m.close({ lessons: "cancel" });
      expect(l.seen.signal?.aborted).toBe(true);
      const events = s.states.length;
      l.answer("A made-up lesson that came too late.");
      await sleep(200);
      expect(l.seen.stored).toBe(0);
      expect(s.added()).toEqual([]);
      expect(s.states).toHaveLength(events);
      expect(m.palace).toBeUndefined();
    });

  it("starts no lesson request once closing has begun", async () => {
    const s = await use();
    const m = s.memory();
    m.start();
    await turnedOn(s);
    const closing = m.close({ lessons: "wait" });
    let asked = false;
    m.lesson(async () => {
      asked = true;
      return "A made-up lesson.";
    }, async () => {});
    await closing;
    expect(asked).toBe(false);
  });

  it("ends a wait at once when the caller's stop signal fires, and cancels what it waited for", async () => {
    const s = await use();
    const m = s.memory();
    m.start();
    await turnedOn(s);
    const l = heldLesson(m);
    const stop = new AbortController();
    const closing = m.close({ lessons: "wait", signal: stop.signal });
    expect(await settled(closing)).toBe(false);
    const began = Date.now();
    stop.abort();
    await closing;
    expect(Date.now() - began).toBeLessThan(LIMIT / 2);
    expect(l.seen.signal?.aborted).toBe(true);
    l.answer("A made-up lesson.");
    await sleep(200);
    expect(s.added()).toEqual([]);
  });

  it("gives the saver its last chance, and ends the request still out when the saver's limit passes", async () => {
    const s = await use(["--hold-room", "held-room"]);
    const m = s.memory();
    m.start();
    await turnedOn(s);
    let request: Promise<unknown> | undefined;
    let given: AbortSignal | undefined;
    const began = Date.now();
    await m.close({ lessons: "wait", save: { limit: 300, run: (signal) => {
      given = signal;
      request = m.palace!.search("a held request", { room: "held-room" }, 5, LIMIT);
      return request;
    } } });
    expect(Date.now() - began).toBeLessThan(LIMIT / 2);
    expect(given?.aborted).toBe(true);
    expect(await settled(request!)).toBe(true);
    expect(await request).not.toMatchObject({ is: "found" });
    await until(() => !alive(s.started()[0].pid), "the program to be stopped");
  });

  it("goes on to its second stage when the saver throws at once", async () => {
    const s = await use();
    const m = s.memory();
    m.start();
    await turnedOn(s);
    await m.close({ lessons: "wait", save: { limit: LIMIT, run: () => {
      throw new Error("a made-up saver that throws at once");
    } } });
    expect(s.states.at(-1)).toEqual({ is: "closed" });
    expect(m.palace).toBeUndefined();
    await until(() => !alive(s.started()[0].pid), "the program to be stopped");
  });

  it("stops an install that is held: no ready file, the stand-in uv gone, the lock free", async () => {
    const model = await modelServer();
    const s = await own();
    const gate = path.join(s.top, "never-made");
    const m = s.memory({ model, env: { ...s.env, TACHI_TEST_UV_HOLD: gate } });
    m.setUp();
    await until(() => s.uvStarts().length === 1, "uv to start");
    const { pid } = s.uvStarts()[0];
    await m.close({ lessons: "wait" });
    expect(alive(pid)).toBe(false);
    expect(existsSync(readyFile(s.paths))).toBe(false);
    const lock = tryLock(s.paths.root, "install");
    expect(lock).not.toBeNull();
    lock?.release();
    expect(s.states).toEqual([{ is: "setting up" }, { is: "winding down" }, { is: "closed" }]);
    expect(s.errors).toEqual([]);
    writeFileSync(gate, "");
    await sleep(300);
    expect(s.states).toHaveLength(3);
    expect(s.launched()).toEqual([]);
  });

  it("closed while a join is held: the join's hub is stopped as the only window's, and nothing changes after",
    async () => {
      const s = await own({ ready: true });
      const gate = path.join(s.top, "gate");
      s.control({ hold: gate });
      const m = s.memory();
      m.start();
      await until(() => s.launched().length === 1, "the start");
      const closing = m.close({ lessons: "wait" });
      writeFileSync(gate, "");
      await closing;
      expect(alive(s.launched()[0]!.pid)).toBe(false);
      expect(existsSync(hubRecord(s.paths))).toBe(false);
      expect(s.states).toEqual([{ is: "winding down" }, { is: "closed" }]);
      expect(m.on()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(s.errors).toEqual([]);
    });

  // The user's choice after step 27's review ("A: wait, then save"): a join and connect already under way finish inside
  // the last save's limit, and the saver is then given the palace; a start that fails meanwhile says so; the limit and
  // the caller's signal end the wait.
  it("lets a join under way finish within the last save's limit, then gives the saver the palace", async () => {
    const s = await own({ ready: true });
    const gate = path.join(s.top, "gate");
    s.control({ hold: gate });
    const m = s.memory();
    m.start();
    await until(() => s.launched().length === 1, "the start");
    let palace: Palace | undefined;
    const closing = m.close({ lessons: "wait", save: { limit: LIMIT, run: async () => void (palace = m.palace) } });
    await sleep(300);
    writeFileSync(gate, "");
    await closing;
    expect(palace).toBeDefined();
    expect(s.states).toEqual([{ is: "winding down" }, { is: "closed" }]);
    expect(s.errors).toEqual([]);
    expect(alive(s.launched()[0]!.pid)).toBe(false);
  });

  it("says a hub start that fails during the last save's wait, in one error row", async () => {
    const s = await own({ ready: true });
    const gate = path.join(s.top, "gate");
    s.control({ hold: gate, exit: 1 });
    const m = s.memory();
    m.start();
    await until(() => s.launched().length === 1, "the start");
    let ran = false;
    const closing = m.close({ lessons: "wait", save: { limit: LIMIT, run: async () => void (ran = true) } });
    await sleep(300);
    writeFileSync(gate, "");
    await closing;
    const reason = "Memory is off: the hub did not start (exit code: 1).";
    expect(s.errors.map((e) => e.message)).toEqual([reason]);
    expect(s.states).toEqual([{ is: "winding down" }, { is: "off", reason }, { is: "closed" }]);
    expect(ran).toBe(true);
  });

  it.each(["the limit", "the caller's signal"])("ends the wait for a join under way at %s", async (how) => {
    const s = await own({ ready: true });
    const gate = path.join(s.top, "gate");
    s.control({ hold: gate });
    const m = s.memory();
    m.start();
    await until(() => s.launched().length === 1, "the start");
    const stop = new AbortController();
    let ran = false;
    const began = Date.now();
    const limit = how === "the limit" ? 300 : LIMIT;
    const save = { limit, run: async () => void (ran = true) };
    const closing = m.close({ lessons: "wait", save, signal: stop.signal });
    if (how !== "the limit") {
      await sleep(300);
      stop.abort();
    }
    await until(() => s.states.some((x) => x.is === "closed"), "the second stage");
    expect(Date.now() - began).toBeLessThan(LIMIT / 2);
    expect(ran).toBe(false);
    writeFileSync(gate, "");
    await closing;
    expect(s.errors).toEqual([]);
  });

  it("leaves a hub another window still uses, and stops it as the last window", async () => {
    const s = await own({ ready: true });
    const a = s.memory();
    const b = s.memory();
    a.start();
    await turnedOn(s);
    b.start();
    await until(() => s.states.filter((x) => x.is === "on").length === 2, "both on");
    const { pid } = s.launched()[0]!;
    await a.close({ lessons: "wait" });
    expect(alive(pid)).toBe(true);
    await b.close({ lessons: "wait" });
    expect(alive(pid)).toBe(false);
  });

  it("is the same when closed twice", async () => {
    const s = await use();
    const m = s.memory();
    m.start();
    await turnedOn(s);
    const once = m.close({ lessons: "wait" });
    const twice = m.close({ lessons: "cancel" });
    expect(twice).toBe(once);
    await once;
    expect(s.states).toEqual([{ is: "on" }, { is: "winding down" }, { is: "closed" }]);
  });

  // A process of Node's own that runs memory and closes it must then end by itself: no timer, request or child of
  // memory holds it open.
  it.each([
    { name: "after a join", ready: true },
    { name: "while it waits on another window's install", ready: false },
  ])("holds nothing of the process open $name", async ({ ready }) => {
    const s = await own({ ready });
    makeMemoryFolder(s.paths);
    if (!ready) locks.push(tryLock(s.paths.root, "install")!);
    const tmp = path.join(s.top, "tmp");
    mkdirSync(tmp);
    const code = [
      `const { Memory } = await import(${JSON.stringify(pathToFileURL(path.resolve("src/memory/memory.ts")).href)});`,
      `const { Bus } = await import(${JSON.stringify(pathToFileURL(path.resolve("src/core/bus.ts")).href)});`,
      "const o = JSON.parse(process.env.TACHI_TEST_MEMORY);",
      "const bus = new Bus();",
      "const states = [];",
      "bus.on('memory', (s) => states.push(s.is));",
      "const m = new Memory({ memory: 'own', bus, lead: () => 'fake:a', paths: o.paths, env: process.env,",
      "  figures: o.figures, uv: o.uv, model: o.model,",
      "  launch: (file) => ({ command: process.execPath, args: [o.python, file] }) });",
      "m.start();",
      "m.setUp();",
      "const began = Date.now();",
      "while (!states.includes('on') && Date.now() - began < (o.ready ? 10000 : 1200)) {",
      "  await new Promise((r) => setTimeout(r, 20));",
      "}",
      "await m.close({ lessons: 'cancel' });",
      "process.stdout.write(JSON.stringify(states));",
    ].join("\n");
    // The model at the test's own address, so the child can never reach the real one.
    const model = await modelServer();
    const given = JSON.stringify({ paths: s.paths, figures: TEST, uv: STANDIN_UV, model, python: s.python, ready });
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      env: { ...s.env, TEMP: tmp, TMP: tmp, TACHI_TEST_MEMORY: given },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    children.push(child);
    let out = "";
    child.stdout!.on("data", (d) => (out += d));
    const ended = await Promise.race([
      new Promise<number | null>((resolve) => child.on("exit", resolve)),
      sleep(3 * LIMIT).then(() => "still running" as const),
    ]);
    expect(ended).toBe(0);
    expect(JSON.parse(out)).toEqual(ready ? ["on", "winding down", "closed"] :
      ["setting up", "winding down", "closed"]);
    expect(s.uvStarts()).toEqual([]);
    expect(existsSync(hubRecord(s.paths))).toBe(false);
  }, 4 * LIMIT);
});
