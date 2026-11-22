// Two figures for step 29's real tests (tests/memory/real.test.ts; the user's choice after its re-check, 2026-11-20,
// "Fix all"): how long a clean close of the user's own MemPalace takes, and how long a child saver takes to start. Not
// part of Tachikoma: run by hand, between two snapshots of the user's folders, with tsx (so the repo's own code can be
// imported) and tsx's cache off, and this process's TEMP and TMP in the build folder:
//
//   TACHI_8D_BUILD=<build> TEMP=<build>\step29-close\parent-tmp TMP=<same> TSX_DISABLE_CACHE=1 \
//     node --import tsx scripts/8d/measure-close.mjs
//
// Everything happens inside step 1's `step29-close` throwaway in the build folder. RUNS is the user's count (50).
//
// 1. The close. The build's own MemPalace 3.12.0 (step 4's `env`; the test's second install is from the same lock)
//    runs as the user's own program, `env\Scripts\mempalace-mcp.exe`, as the test runs it: Memory with `{ use }`, this
//    process's environment replaced first as the test replaces it (a home of the throwaway's holding step 5's model,
//    Temp and AppData in the throwaway, PATH Windows' own folders, a dead-end proxy that records every connection, no
//    MEMPALACE_ variable), then on, one memory_save and one memory_search, then `close`. Timed: the close itself
//    (Memory's close, which closes the MCP connection, so the MCP library ends the program's input and waits for it),
//    and after it the wait for the program's exit. Also how it ended: by itself (an exit code), or by the library's
//    force (a signal).
// 2. The start. `tests/memory/saver-child.ts` started as the test starts it (`node --import tsx`, the throwaway's
//    environment with AppData in it and TSX_DISABLE_CACHE=1), given a hub address where nothing listens, so it starts,
//    loads its modules, is refused at once and exits. Timed: from the spawn to its close.
//
// Each limit is 5 times the slowest of its RUNS, rounded up to 0.1 s (the user's rule).
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { Bus } from "../../src/core/bus.ts";
import { running } from "../../src/exec/local.ts";
import { Memory } from "../../src/memory/memory.ts";
import { memoryTools } from "../../src/tools/memory.ts";
import { throwaway } from "./throwaway.mjs";

const RUNS = 50;
const BUILD = path.resolve(process.env.TACHI_8D_BUILD ?? "");
if (!process.env.TACHI_8D_BUILD || !existsSync(path.join(BUILD, "env", "pyvenv.cfg"))) {
  throw new Error("TACHI_8D_BUILD must name the build folder");
}
const PROGRAM = path.join(BUILD, "env", "Scripts", "mempalace-mcp.exe");
const MODEL_FROM = path.join(BUILD, "install", "home", ".cache", "chroma", "onnx_models", "all-MiniLM-L6-v2");
const MODEL_FILES = ["config.json", "model.onnx", "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json",
  "vocab.txt"];
const CHILD = path.resolve("tests/memory/saver-child.ts");
const say = (...a) => console.log(...a);
const limit = (ms) => Math.ceil((5 * ms) / 100) * 100;
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, fastest: s[0], middle: s[Math.floor(s.length / 2)], slowest: s.at(-1) };
};
const round = (ms) => Math.round(ms * 10) / 10;

const { dir, env: base } = throwaway("step29-close", { root: BUILD });
const home = path.join(dir, "home");
const appData = { APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local") };
const model = path.join(home, ".cache", "chroma", "onnx_models", "all-MiniLM-L6-v2");
mkdirSync(path.join(model, "onnx"), { recursive: true });
copyFileSync(path.join(MODEL_FROM, "onnx.tar.gz"), path.join(model, "onnx.tar.gz"));
for (const f of MODEL_FILES) copyFileSync(path.join(MODEL_FROM, "onnx", f), path.join(model, "onnx", f));

const proxied = [];
const proxy = createServer((sock) => {
  proxied.push(`${sock.remoteAddress}:${sock.remotePort}`);
  sock.on("error", () => {});
  sock.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const dead = `http://127.0.0.1:${proxy.address().port}`;
const windows = process.env.SystemRoot ?? "C:\\Windows";

// ---- 1. the close ----
// This process's environment replaced, as the test's stubEnv replaces it.
const useEnv = { ...base, ...appData, HTTP_PROXY: dead, HTTPS_PROXY: dead, ALL_PROXY: dead,
  NO_PROXY: "127.0.0.1,localhost,::1", PATH: `${path.join(windows, "System32")};${windows}` };
const saved = { ...process.env };
for (const k of Object.keys(process.env)) delete process.env[k];
Object.assign(process.env, useEnv);
for (const v of ["HF_", "CHROMA_", "PYTHON", "UV_", "XDG_"]) {
  for (const k of Object.keys(process.env)) if (k.toUpperCase().startsWith(v)) delete process.env[k];
}
const closes = [];
const exits = [];
const ends = [];
for (let i = 0; i < RUNS; i++) {
  const bus = new Bus();
  const states = [];
  bus.on("memory", (s) => states.push(s));
  const m = new Memory({ memory: { use: PROGRAM }, bus, lead: () => "fake:measure" });
  m.start();
  while (!states.some((s) => s.is !== "setting up")) await new Promise((r) => setTimeout(r, 20));
  if (!m.on()) throw new Error(`run ${i + 1}: not on: ${JSON.stringify(states)}`);
  const tools = memoryTools({ memory: m, room: "measure-close", everything: "palace", session: () => `m-${i}`,
    timeouts: { search: 3_400, add: 13_000 } });
  await tools.save.run({ text: `A note of run ${i + 1}, to be found.` }, {});
  await tools.search.run({ query: "a note to be found", scope: "all" }, {});
  // The program's process, as the MCP library holds it.
  const child = [...running].find((c) => path.resolve(c.spawnfile ?? "").toLowerCase() === PROGRAM.toLowerCase());
  if (!child) throw new Error(`run ${i + 1}: the program's process was not found`);
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", resolve);
  });
  const t0 = performance.now();
  await m.close({ lessons: "cancel" });
  const t1 = performance.now();
  await exited;
  const t2 = performance.now();
  closes.push(t1 - t0);
  exits.push(t2 - t1);
  ends.push(child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`);
}
for (const k of Object.keys(process.env)) delete process.env[k];
Object.assign(process.env, saved);
const endings = ends.reduce((a, e) => ({ ...a, [e]: (a[e] ?? 0) + 1 }), {});
say(`close: ${JSON.stringify({ ...stats(closes.map(round)), limit: limit(Math.max(...closes)) })}`);
say(`exit after close: ${JSON.stringify({ ...stats(exits.map(round)), limit: limit(Math.max(...exits)) })}`);
say(`how the program ended: ${JSON.stringify(endings)}`);

// ---- 2. the start ----
const childEnv = { ...base, ...appData, TSX_DISABLE_CACHE: "1" };
const nowhere = await new Promise((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const starts = [];
const said = new Set();
for (let i = 0; i < RUNS; i++) {
  const t0 = performance.now();
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["--import", "tsx", CHILD, `http://127.0.0.1:${nowhere}/mcp`, dir,
      path.join(dir, "no-turn.json"), path.join(dir, "no-record.jsonl")],
    { env: childEnv, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code, out: out.trim() }));
  });
  starts.push(performance.now() - t0);
  said.add(`${r.code} ${r.out.split(":")[0]}`);
}
say(`child start (spawn to close, refused at once): ${JSON.stringify({ ...stats(starts.map(round)),
  limit: limit(Math.max(...starts)) })}`);
say(`how the children ended: ${JSON.stringify([...said])}`);
say(`dead-end proxy connections: ${proxied.length}`);
proxy.close();
