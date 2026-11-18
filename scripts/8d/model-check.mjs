// The embedding model, all-MiniLM-L6-v2, put where MemPalace 3.12.0 looks for it, and one add and one search with
// connections watched and a dead-end proxy in place (8d plan, step 5). Not part of Tachikoma: run by hand.
//
//   node scripts/8d/model-check.mjs place          copy the downloaded archive into the build home, checked both sides
//   node scripts/8d/model-check.mjs run [module]   one add and one search over MCP stdio, connections watched; the
//                                                  module the wrapper runs is mempalace.mcp_server unless given (a
//                                                  missing one shows the run ending FAILED when the server dies)
//
// Where the figures come from (the build record, "Step 5 The embedding model"): chromadb 1.5.9 takes the model from
// ADDRESS (chromadb/utils/embedding_functions/onnx_mini_lm_l6_v2.py:42-44) and holds SHA256 for it (:45). It looks
// under Path.home()\.cache\chroma\onnx_models\all-MiniLM-L6-v2 (:39): an archive there with the right hash is
// unpacked and nothing is fetched (:300-322). The archive was downloaded once, by hand, with Windows' curl, into
// <build>\model-download; SIZE is its measured length. The user approved ADDRESS, SHA256 and SIZE on 2026-11-19.
// Both `place` and `run` check that the installed chromadb file still names ADDRESS and SHA256.
//
// The run starts the build's own MemPalace MCP server (`mempalace.mcp_server`; never the user's) by full path. That is
// the path `mempalace-mcp` (mempalace.mcp_proxy:main) takes when it finds no hub for the palace
// (mempalace/mcp_proxy.py:415-418); its proxy to a hub is not used. With step 1's `install` environment and:
//  - HF_HUB_OFFLINE=1 (huggingface_hub/constants.py:194) and MEMPALACE_EMBEDDING_MODEL=minilm (mempalace/config.py:
//    1184-1187);
//  - HTTP_PROXY, HTTPS_PROXY and ALL_PROXY pointing at a listener of this script's on 127.0.0.1, which records and
//    refuses every request; NO_PROXY for the loopback names. httpx and urllib read these (httpx/_utils.py:31-54);
//  - no ANONYMIZED_TELEMETRY, CHROMA_* or PYTHON* variable, and no other spelling of the proxy names;
//  - `python -I`, and a wrapper (WRAPPER, below) that installs an audit hook before MemPalace is imported and logs
//    every name lookup, connection, send, HTTP request and child process Python code makes. Before MemPalace runs,
//    it makes one loopback connection of its own, to show the hook is seen, and logs the proxies httpx and urllib
//    would use.
// Known limits: the proxy stops only code that honours the proxy variables, and the hook sees only what goes through
// Python's own socket, http and urllib code and its process calls. Connections opened by native code (onnxruntime,
// chromadb's Rust part, gRPC) bypass both; seeing those needs admin rights or a system change, which the build does
// not make.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { BUILD, throwaway } from "./throwaway.mjs";

const ADDRESS = "https://chroma-onnx-models.s3.amazonaws.com/all-MiniLM-L6-v2/onnx.tar.gz";
const SHA256 = "913d7300ceae3b2dbc2c50d1de4baacab4be7b9380491c27fab7418616a16ec3";
const SIZE = 83178821;
// The archive's members (`tar -tvzf` of the download), which chromadb also requires (onnx_mini_lm_l6_v2.py:285-292).
const MEMBERS = {
  "config.json": 650,
  "model.onnx": 90387606,
  "special_tokens_map.json": 125,
  "tokenizer_config.json": 518,
  "tokenizer.json": 711661,
  "vocab.txt": 231508,
};
const DOWNLOAD = path.join(BUILD, "model-download", "onnx.tar.gz");
const CHROMA_SOURCE = path.join(
  BUILD,
  "env",
  "Lib",
  "site-packages",
  "chromadb",
  "utils",
  "embedding_functions",
  "onnx_mini_lm_l6_v2.py",
);
const PYTHON = path.join(BUILD, "env", "Scripts", "python.exe");
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const PROCESS_EVENTS = new Set([
  "subprocess.Popen",
  "os.system",
  "os.exec",
  "os.posix_spawn",
  "os.spawn",
  "os.startfile",
]);

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function modelDir() {
  const { dir, env } = throwaway("install");
  return { dir, env, model: path.join(env.USERPROFILE, ".cache", "chroma", "onnx_models", "all-MiniLM-L6-v2") };
}

function check(label, file) {
  const size = statSync(file).size;
  const hash = sha256(file);
  const ok = size === SIZE && hash === SHA256;
  console.log(`${label}: ${file}\n  bytes ${size}, sha256 ${hash}: ${ok ? "as approved" : "NOT as approved"}`);
  return ok;
}

// The installed chromadb still takes the model from ADDRESS and checks it against SHA256.
function sourceCheck() {
  const text = readFileSync(CHROMA_SOURCE, "utf8");
  const ok = text.includes(`"${ADDRESS}"`) && text.includes(`"${SHA256}"`);
  console.log(`${CHROMA_SOURCE}\n  names the approved address and hash: ${ok}`);
  return ok;
}

function place() {
  if (!sourceCheck() || !check("download", DOWNLOAD)) process.exit(1);
  const { model } = modelDir();
  mkdirSync(model, { recursive: true });
  const target = path.join(model, "onnx.tar.gz");
  // A copy, never a move, and never over a file already there.
  copyFileSync(DOWNLOAD, target, constants.COPYFILE_EXCL);
  process.exitCode = check("copy", target) && existsSync(DOWNLOAD) ? 0 : 1;
}

// Runs in the server's Python, with -I, before MemPalace is imported. argv: the log file, the module to run, then the
// server's own. A target the hook cannot read is logged as "unparsed", which counts as leaving this computer.
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
            log.write(json.dumps({'phase': phase, 'event': event, 'host': host, 'args': repr(args)}) + '\\n')
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
sys.argv = ['mempalace-mcp'] + sys.argv[3:]
runpy.run_module(module, run_name='__main__', alter_sys=True)
`;

// Dropped in every spelling, so only the values set below reach the server.
const DROP =
  /^(HTTPS?_PROXY|ALL_PROXY|NO_PROXY|ANONYMIZED_TELEMETRY|CHROMA_.*|PYTHON.*|HF_HUB_OFFLINE|TRANSFORMERS_OFFLINE)$/i;

async function run(module = "mempalace.mcp_server") {
  const { dir, env: base, model } = modelDir();
  const home = base.USERPROFILE;
  const archive = path.join(model, "onnx.tar.gz");
  if (!sourceCheck()) throw new Error("the installed chromadb does not name the approved address and hash");
  if (!existsSync(archive) || !check("placed", archive)) throw new Error("run `place` first");
  if (existsSync(path.join(home, ".mempalace", "updates.json"))) throw new Error("updates.json is in the build home");
  // Each run has its own new palace and logs, named by the time it started.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const palace = path.join(home, "palaces", `model-check-${stamp}`);
  if (existsSync(palace)) throw new Error(`${palace} already exists; this run would not start from nothing`);
  mkdirSync(path.dirname(palace), { recursive: true });
  const audit = path.join(dir, `model-check-${stamp}.audit.jsonl`);
  const errLog = path.join(dir, `model-check-${stamp}.stderr.log`);

  // The dead-end proxy: records each connection's first line and closes it.
  const proxied = [];
  const listener = createServer((sock) => {
    proxied.push({ from: `${sock.remoteAddress}:${sock.remotePort}`, first: "" });
    const entry = proxied[proxied.length - 1];
    sock.once("data", (d) => {
      entry.first = d.toString("latin1").split("\r\n")[0];
    });
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
    if (/^(USERPROFILE|HOME|HF_|MEMPALACE_|.*PROXY|XDG_)/i.test(k)) console.log(`env ${k}=${env[k]}`);
  }
  const args = ["-I", "-c", WRAPPER, audit, module, "--palace", palace, "--backend", "sqlite_exact"];
  args.push("--transport", "stdio");
  console.log(`run ${PYTHON} -I -c <wrapper> ${args.slice(3).join(" ")}`);
  const child = spawn(PYTHON, args, { cwd: home, env, stdio: ["pipe", "pipe", openSync(errLog, "w")] });
  console.log(`server pid ${child.pid}`);
  // The run ends on the server's exit, or on its failing to start; there is no time limit. Once either has happened,
  // every call waiting for an answer, and every later call, gets an error in its place.
  const waiting = new Map();
  let gone = null;
  const exited = new Promise((resolve) => {
    const finish = (why) => {
      if (gone) return;
      gone = why;
      for (const answer of waiting.values()) answer({ error: { message: `the server is gone: ${why.text}` } });
      waiting.clear();
      resolve(why);
    };
    child.on("close", (code, signal) => finish({ code, signal, text: `exit ${code}${signal ? ` (${signal})` : ""}` }));
    child.on("error", (e) => finish({ code: null, signal: null, text: `failed to start: ${e.message}` }));
  });
  child.stdin.on("error", (e) => console.log(`server stdin: ${e.message}`));
  createInterface({ input: child.stdout }).on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log(`server stdout, not JSON: ${line}`);
      return;
    }
    const answer = waiting.get(msg.id);
    waiting.delete(msg.id);
    answer?.(msg);
  });
  let next = 1;
  const send = (msg) => {
    if (!gone && child.stdin.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  };
  const call = (method, params) =>
    new Promise((resolve) => {
      if (gone) return resolve({ error: { message: `the server is gone: ${gone.text}` } });
      const id = next++;
      waiting.set(id, resolve);
      send({ id, method, params });
    });
  const text = (msg) => (msg.result?.content ?? []).map((c) => c.text ?? "").join("\n");

  let init, add, search, found, end;
  try {
    const content = "Release 8d model check: the embedding model was loaded from the build home, connections watched.";
    init = await call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tachi-8d-model-check", version: "0" },
    });
    console.log(`initialize: ${init.error ? JSON.stringify(init.error) : `protocol ${init.result?.protocolVersion}`}`);
    send({ method: "notifications/initialized" });
    add = await call("tools/call", {
      name: "mempalace_add_drawer",
      arguments: { wing: "check", room: "model", content, source_file: "model-check" },
    });
    const addOut = add.error ? JSON.stringify(add.error) : text(add);
    console.log(`add: isError ${Boolean(add.result?.isError || add.error)}\n  ${addOut}`);
    search = await call("tools/call", {
      name: "mempalace_search",
      arguments: { query: "embedding model loaded from the build home", wing: "check", room: "model" },
    });
    found = text(search).includes(content);
    const searchOut = search.error ? `\n  ${JSON.stringify(search.error)}` : "";
    const searchError = Boolean(search.result?.isError || search.error);
    console.log(`search: isError ${searchError}, finds the entry: ${found}${searchOut}`);
    if (!gone) child.stdin.end();
    end = await exited;
    console.log(`server ${end.text}; stderr kept in ${errLog}`);
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }

  const records = existsSync(audit)
    ? readFileSync(audit, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const control = records.filter((r) => r.phase === "control" && r.event);
  const proxies = records.find((r) => r.urllib_proxies);
  const server = records.filter((r) => r.phase === "server");
  const outside = server.filter((r) => r.host !== null && !LOOPBACK.has(r.host));
  const children = server.filter((r) => PROCESS_EVENTS.has(r.event));
  console.log(`audit log ${audit}`);
  console.log(`  control: ${control.length} events (${control.map((r) => `${r.event} ${r.host}`).join(", ")})`);
  console.log(`  proxies Python sees: urllib ${JSON.stringify(proxies?.urllib_proxies)}`);
  console.log(`                        httpx ${JSON.stringify(proxies?.httpx_proxies)}`);
  console.log(`  server: ${server.length} events; to a place other than this computer: ${outside.length}`);
  for (const r of server) console.log(`    ${r.event} host=${r.host}`);
  console.log(`  child processes started: ${children.length}`);
  console.log(`listener: ${proxied.length} connections${proxied.map((p) => `\n  ${p.from} ${p.first}`).join("")}`);

  const onnx = path.join(model, "onnx");
  const files = existsSync(onnx)
    ? Object.fromEntries(readdirSync(onnx).sort().map((f) => [f, statSync(path.join(onnx, f)).size]))
    : {};
  const unpacked = JSON.stringify(files) === JSON.stringify(Object.fromEntries(Object.entries(MEMBERS).sort()));
  console.log(`unpacked by chromadb into ${onnx}: ${JSON.stringify(files)}; as the archive lists: ${unpacked}`);
  const still = check("placed, after", archive);
  console.log(`archive still as approved: ${still}`);
  const ok =
    !init.error && !add.error && !add.result?.isError && found && control.length > 0 && proxies?.httpx_proxies &&
    outside.length === 0 && children.length === 0 && proxied.length === 0 && unpacked && still && end.code === 0;
  console.log(ok ? "model check: passed" : "model check: FAILED");
  process.exitCode = ok ? 0 : 1;
}

const [command, module] = process.argv.slice(2);
if (command === "place") place();
else if (command === "run") await run(module);
else {
  console.error("usage: node scripts/8d/model-check.mjs place | run [module]");
  process.exitCode = 2;
}
