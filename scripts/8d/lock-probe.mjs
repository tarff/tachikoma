// Which operating-system lock Node can hold (8d plan, step 2). Not part of Tachikoma: run by hand, on this PC and in
// the sandbox image already built here, and its output goes into the build record.
//
//   node scripts/8d/lock-probe.mjs run [--runs N] [--child-runs N] [--dir <folder>]
//
// For each candidate this platform has, `run` starts a holder process that takes the lock and keeps it, then a waiter
// process that tries to take it over and over with no pause. It records whether the waiter's first try is refused,
// kills the holder outright (taskkill /F /PID on Windows, SIGKILL elsewhere), and records how long after that the
// waiter took the lock. In the child runs, the holder first starts a detached process of its own, as a window starts
// the hub while holding the join lock, and the waiter's result is recorded while that child still lives. Every process
// it starts is stopped by its own process id before it ends. Its files and pipe names live in --dir, which it makes;
// it deletes only its own files there, by exact name. CUT_MS is the probe's own cut-off for a waiter that never takes
// the lock, so a run always ends; it is not a figure for Tachikoma.
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, constants as fsc, rmdirSync, unlinkSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const CUT_MS = 10_000;
// libuv's own value (include/uv/win.h: `#define UV_FS_O_EXLOCK 0x10000000 /* EXCLUSIVE SHARING MODE */`); Node does
// not export it, and its fs page lists the flags it supports on Windows without it.
const UV_FS_O_EXLOCK = 0x10000000;
const FILES = ["probe.sqlite", "probe.sqlite-journal", "probe.exlock"];

const now = () => performance.timeOrigin + performance.now();
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

// Each candidate: `take` resolves { ok: true, release } or { ok: false, code }.
const KINDS = {
  // Windows named pipe; elsewhere the same call makes a Unix socket file.
  pipe: { on: ["win32"], target: (dir) => path.join("\\\\?\\pipe", dir, "probe-pipe"), take: listen },
  sock: { on: ["linux", "darwin"], target: (dir) => path.join(dir, "probe.sock"), take: listen },
  // The leading \0 is added in `take`: a process argument cannot hold one.
  abstract: { on: ["linux"], target: () => "tachi-8d-lock-probe", take: (name) => listen(`\0${name}`) },
  tcp: {
    on: ["win32", "linux", "darwin"],
    target: null,
    take: (port) => listen({ host: "127.0.0.1", port: Number(port), exclusive: true }),
  },
  sqlite: { on: ["win32", "linux", "darwin"], target: (dir) => path.join(dir, "probe.sqlite"), take: sqlite },
  exlock: { on: ["win32"], target: (dir) => path.join(dir, "probe.exlock"), take: exlock },
};

function listen(where) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (e) => resolve({ ok: false, code: e.code }));
    server.listen(where, () => resolve({ ok: true, release: () => server.close() }));
  });
}

async function sqlite(file) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { timeout: 0 });
  try {
    db.exec("BEGIN EXCLUSIVE");
    return { ok: true, release: () => db.close() };
  } catch (e) {
    db.close();
    return { ok: false, code: `${e.code} ${e.errcode} ${e.errstr}` };
  }
}

function exlock(file) {
  try {
    const fd = openSync(file, fsc.O_RDWR | fsc.O_CREAT | UV_FS_O_EXLOCK);
    return { ok: true, release: () => closeSync(fd) };
  } catch (e) {
    return { ok: false, code: e.code };
  }
}

// The holder: takes the lock once and keeps it; with "child", first starts a detached process that lives on. What it
// took is kept in `kept`, so a closed-on-collection handle (node:sqlite's) is not let go when `hold` returns.
const kept = [];
async function hold(kind, target, child) {
  const got = await KINDS[kind].take(target);
  kept.push(got);
  if (!got.ok) {
    say({ held: false, code: got.code });
    process.exit(3);
  }
  let pid = null;
  if (child) {
    const c = spawn(process.execPath, [SCRIPT, "sleeper"], { detached: true, stdio: "ignore", windowsHide: true });
    c.unref();
    pid = c.pid;
  }
  say({ held: true, pid: process.pid, child: pid });
  setInterval(() => {}, 1 << 30);
}

// The waiter: tries with no pause until it takes the lock, or until CUT_MS after the parent says the holder was killed.
// A Unix socket file that never frees is then tried the way a program would have to: connect, and on a refusal remove
// the file and listen again.
async function wait(kind, target) {
  let killedAt = null;
  process.on("message", (m) => (killedAt = m.killed));
  let attempts = 0;
  let first = null;
  for (;;) {
    const got = await KINDS[kind].take(target);
    attempts++;
    if (first === null) {
      first = got.ok ? "took" : got.code;
      say({ first });
    }
    if (got.ok) {
      say({ took: true, at: now(), attempts, how: "retry" });
      got.release();
      break;
    }
    if (killedAt !== null && now() - killedAt > CUT_MS) {
      const how = kind === "sock" ? await recover(target) : null;
      say({ took: how !== null, at: now(), attempts, how: how ?? `still ${got.code} after ${CUT_MS} ms` });
      break;
    }
    await new Promise((r) => setImmediate(r));
  }
  process.disconnect?.();
}

async function recover(file) {
  const refused = await new Promise((resolve) => {
    const s = net.connect(file);
    s.once("connect", () => (s.destroy(), resolve(null)));
    s.once("error", (e) => resolve(e.code));
  });
  if (refused === null) return null;
  unlinkSync(file);
  const got = await listen(file);
  if (!got.ok) return null;
  got.release();
  return `connect gave ${refused}, then unlink and listen took it`;
}

// ---- the runner ----

const started = new Set();
// A crash of the runner itself skips `run`'s finally; this still stops what it started.
process.on("exit", () => {
  for (const pid of started) if (alive(pid)) killHard(pid);
});

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killHard(pid) {
  if (process.platform === "win32") execFileSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" });
  else process.kill(pid, "SIGKILL");
}

function lines(child, onLine) {
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      onLine(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
}

function start(args, ipc) {
  const stdio = ["ignore", "pipe", "inherit", ...(ipc ? ["ipc"] : [])];
  const c = spawn(process.execPath, [SCRIPT, ...args], { stdio, windowsHide: true });
  started.add(c.pid);
  c.once("exit", () => started.delete(c.pid));
  return c;
}

function next(child, test) {
  return new Promise((resolve, reject) => {
    const seen = [];
    lines(child, (o) => {
      seen.push(o);
      if (test(o)) resolve(o);
    });
    // "close", not "exit": "exit" can come before the child's last lines are read.
    child.once("close", (code) => reject(new Error(`exited ${code} after ${JSON.stringify(seen)}`)));
  });
}

async function once(kind, target, child) {
  const holder = start(["hold", kind, target, ...(child ? ["child"] : [])]);
  const h = await next(holder, (o) => "held" in o);
  if (!h.held) throw new Error(`holder could not take ${kind}: ${h.code}`);
  if (h.child) started.add(h.child);
  const waiter = start(["wait", kind, target], true);
  const result = next(waiter, (o) => "took" in o);
  result.catch(() => {}); // awaited below; this only stops an early failure from ending the process unhandled
  const first = await new Promise((resolve) => lines(waiter, (o) => "first" in o && resolve(o.first)));
  const exited = new Promise((r) => holder.once("exit", () => r(now())));
  const killAt = now();
  killHard(h.pid);
  const killTook = now() - killAt;
  const goneAt = await exited;
  // The waiter may already have taken the lock and gone; a send to it then fails, which is fine.
  if (waiter.connected) waiter.send({ killed: goneAt }, () => {});
  const r = await result;
  await new Promise((res) => (waiter.exitCode !== null ? res() : waiter.once("exit", res)));
  const childAlive = h.child ? alive(h.child) : null;
  if (h.child) {
    killHard(h.child);
    started.delete(h.child);
  }
  return {
    first, took: r.took, how: r.how, attempts: r.attempts, childAlive, killTook,
    sinceKill: r.at - killAt, sinceExit: r.at - goneAt,
  };
}

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const f = (x) => `${x.toFixed(1)} ms`;
  if (!s.length) return "none";
  return `fastest ${f(s[0])}, middle ${f(s[Math.floor(s.length / 2)])}, slowest ${f(s[s.length - 1])}`;
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen({ host: "127.0.0.1", port: 0 }, () => {
      const { port } = s.address();
      s.close(() => resolve(String(port)));
    });
  });
}

async function run(argv) {
  const opt = (name, d) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : d);
  const runs = Number(opt("--runs", "10"));
  const childRuns = Number(opt("--child-runs", "3"));
  const dir = path.resolve(opt("--dir", path.join(tmpdir(), "tachi-8d-build", "lock-probe")));
  const made = !existsSync(dir);
  mkdirSync(dir, { recursive: true });
  console.log(`platform ${process.platform} ${process.arch}, node ${process.version}, uv ${process.versions.uv}`);
  console.log(`folder ${dir}; runs ${runs} plain and ${childRuns} with a child per candidate; cut-off ${CUT_MS} ms`);
  try {
    for (const [kind, k] of Object.entries(KINDS)) {
      if (!k.on.includes(process.platform)) continue;
      const target = k.target ? k.target(dir) : await freePort();
      const plain = [];
      for (let i = 0; i < runs; i++) plain.push(await once(kind, target, false));
      const kids = [];
      for (let i = 0; i < childRuns; i++) kids.push(await once(kind, target, true));
      const firsts = [...new Set(plain.concat(kids).map((r) => r.first))].join(", ");
      const took = plain.filter((r) => r.took);
      console.log(`\n${kind} (${JSON.stringify(target)})`);
      console.log(`  second process's first try: ${firsts}`);
      const hows = (rs) => [...new Set(rs.map((r) => r.how))].join("; ");
      console.log(`  after a hard kill, took it: ${took.length} of ${runs}; how: ${hows(plain)}`);
      console.log(`  wait after the holder's exit was seen: ${stats(took.map((r) => r.sinceExit))}`);
      console.log(`  wait after the kill began: ${stats(took.map((r) => r.sinceKill))}`);
      console.log(`  the kill call itself took: ${stats(plain.map((r) => r.killTook))}`);
      console.log(`  tries before taking it: ${stats(took.map((r) => r.attempts)).replaceAll(" ms", "")}`);
      const kt = kids.filter((r) => r.took);
      console.log(`  with the holder's detached child still alive (${kids.filter((r) => r.childAlive).length} of ` +
        `${childRuns}): took it ${kt.length} of ${childRuns}; how: ${hows(kids)}`);
      console.log(`    wait after the holder's exit was seen: ${stats(kt.map((r) => r.sinceExit))}`);
    }
  } finally {
    for (const pid of started) if (alive(pid)) killHard(pid);
    for (const name of FILES) if (existsSync(path.join(dir, name))) unlinkSync(path.join(dir, name));
    const sock = path.join(dir, "probe.sock");
    if (existsSync(sock)) unlinkSync(sock);
    if (made) rmdirSync(dir);
    console.log(`\nleft running: ${[...started].filter(alive).length}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "run") await run(rest);
else if (cmd === "hold") await hold(rest[0], rest[1], rest[2] === "child");
else if (cmd === "wait") await wait(rest[0], rest[1]);
else if (cmd === "sleeper") setInterval(() => {}, 1 << 30);
else console.error("usage: node scripts/8d/lock-probe.mjs run [--runs N] [--child-runs N] [--dir <folder>]");
