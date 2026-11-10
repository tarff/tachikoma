import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { onTestFinished } from "vitest";

// Fake MCP servers for the tests (release 8c plan, Task 4): a Node script speaking MCP's JSON-RPC by hand, so no server
// package is needed and nothing of the user's is started. Over stdio it reads one message per line and writes one per
// line, as the library's stdio transport does; over HTTP it answers each POST with one JSON message, on 127.0.0.1 only.

export interface FakeOptions {
  log?: string; // a file each message received (and, as { sent }, each one sent) is added to, one JSON line each
  stderr?: string; // printed to its error output at the start
  exit?: number; // the code it exits with at the start, after `stderr`
  signal?: NodeJS.Signals; // the signal it ends itself with at the start
  crash?: string; // the message of an Error it throws at the start, uncaught, as a crashed Node server ends
  start?: string; // code it runs at the start, with `require`, such as a crash of another shape
  silent?: boolean; // answers nothing
  stubborn?: boolean; // keeps running when its input closes, with a child of its own
  pidFile?: string; // where it writes its process id
  childPidFile?: string; // where a stubborn one writes its child's process id
  description?: string; // echo's description
  port?: number; // over HTTP, the port to listen on; any free one without it
  status?: number; // over HTTP, the status every POST is answered with
  tools?: object[]; // its tools/list, in place of its own tools (Task 5's names and schemas)
  added?: object[]; // what change adds, before the others, in place of "added"
  results?: Record<string, object>; // a call to a tool named here is answered with this result (Task 6's answers)
}

// Its tools: echo says `text` back; error answers isError; picture answers a 1x1 PNG; structured answers structured
// content only; slow never answers; progress sends progress and never answers; whoami tells its arguments, folder and
// variables; ask sends the client a request (`method`, `params`) and answers with the client's answer; change adds a
// tool and says the list changed; exit prints `stderr` and exits with `code`. The tools are called by name whatever the
// list says, so a fake with its own `tools` still answers change and exit. Over HTTP, which answers in JSON only,
// nothing reaches the client between answers, so progress, ask and change's notice need stdio.
const SCRIPT = String.raw`
const fs = require("node:fs");
const log = (entry) => { if (O.log) fs.appendFileSync(O.log, JSON.stringify(entry) + "\n"); };
if (O.pidFile) fs.writeFileSync(O.pidFile, String(process.pid));
if (O.stubborn) {
  setInterval(() => {}, 1000);
  const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  fs.writeFileSync(O.childPidFile, String(child.pid));
}
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const tool = (name, description = name) => ({ name, description, inputSchema: { type: "object" } });
let tools = O.tools || [
  { ...tool("echo", O.description || "Says it back"), inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  ...["error", "picture", "structured", "slow", "progress", "whoami", "ask", "change", "exit"].map((name) => tool(name)),
];
let notify = () => {};
let request = () => {};

function answer(m, reply) {
  if (m.method === "initialize") {
    const capabilities = { tools: { listChanged: true } };
    return reply({ result: { protocolVersion: m.params.protocolVersion, capabilities, serverInfo: { name: "fake", version: "1.0.0" } } });
  }
  if (m.method === "tools/list") return reply({ result: { tools } });
  if (m.method !== "tools/call") return reply({ error: { code: -32601, message: "no such method" } });
  const args = m.params.arguments || {};
  const text = (t) => reply({ result: { content: [{ type: "text", text: t }] } });
  if (O.results && Object.hasOwn(O.results, m.params.name)) return reply({ result: O.results[m.params.name] });
  switch (m.params.name) {
    case "echo": return text(String(args.text));
    case "error": return reply({ result: { content: [{ type: "text", text: "it went wrong" }], isError: true } });
    case "picture": return reply({ result: { content: [{ type: "image", data: PNG, mimeType: "image/png" }] } });
    case "structured": return reply({ result: { content: [], structuredContent: { answer: 42 } } });
    case "slow": return;
    case "progress": {
      // The request's own token, or else its id, which is the token the library gives a request that asks for progress.
      const token = (m.params._meta && m.params._meta.progressToken) ?? m.id;
      let n = 0;
      setInterval(() => notify({ method: "notifications/progress", params: { progressToken: token, progress: ++n } }), 50);
      return;
    }
    case "whoami":
      return text(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), project: process.env.CLAUDE_PROJECT_DIR ?? null,
        mine: process.env.MINE ?? null, key: process.env.ANTHROPIC_API_KEY ?? null }));
    case "ask": return request(args.method, args.params, (r) => text(JSON.stringify(r.result ?? r.error)));
    case "change":
      tools = O.added ? [...O.added, ...tools] : [...tools, tool("added")];
      text("changed");
      return notify({ method: "notifications/tools/list_changed" });
    case "exit": return process.stderr.write(args.stderr || "", () => process.exit(args.code));
  }
  reply({ error: { code: -32602, message: "no such tool" } });
}

function begin() {
  if (O.signal) return process.kill(process.pid, O.signal);
  if (O.crash) throw new Error(O.crash);
  if (O.start) new Function("require", O.start)(require);
  if (O.exit !== undefined) return process.stderr.write(O.stderr || "", () => process.exit(O.exit));
  if (O.stderr) process.stderr.write(O.stderr);
  if (O.mode === "http") serveHttp();
  else serveStdio();
}

function serveStdio() {
  const send = (msg) => {
    log({ sent: msg });
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  };
  notify = send;
  const waiting = new Map();
  let asked = 0;
  request = (method, params, then) => {
    const id = "fake-" + ++asked;
    waiting.set(id, then);
    send({ id, method, params });
  };
  const rl = require("node:readline").createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const m = JSON.parse(line);
    log(m);
    if (O.silent) return;
    if (m.method === undefined) {
      const then = waiting.get(m.id);
      waiting.delete(m.id);
      return then && then(m);
    }
    if (m.id !== undefined) answer(m, (r) => send({ id: m.id, ...r }));
  });
  rl.on("close", () => { if (!O.stubborn) process.exit(0); });
}

// One session per initialize; a request with another session id is answered 404, as MCP's Streamable HTTP transport has
// a server that no longer knows the session answer. A GET for an event stream is answered 405: there is none. A call to
// the unlisted tool "cut" is read and its connection cut, with no answer: a drop after the request reached the server.
function serveHttp() {
  const sessions = new Set();
  let next = 0;
  const server = require("node:http").createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      log({ http: req.method, headers: req.headers, body: body ? JSON.parse(body) : null });
      // Each connection ends with its answer, so no call goes out on an open one after the fake has stopped.
      res.setHeader("Connection", "close");
      if (req.method !== "POST") return res.writeHead(405).end();
      if (O.status) return res.writeHead(O.status).end("refused");
      const m = JSON.parse(body);
      if (m.method !== "initialize" && !sessions.has(req.headers["mcp-session-id"])) return res.writeHead(404).end();
      if (m.id === undefined) return res.writeHead(202).end();
      if (O.silent) return;
      if (m.method === "tools/call" && m.params.name === "cut") return req.socket.destroy();
      const headers = { "content-type": "application/json" };
      if (m.method === "initialize") {
        const id = "session-" + ++next;
        sessions.add(id);
        headers["mcp-session-id"] = id;
      }
      answer(m, (r) => res.writeHead(200, headers).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...r })));
    });
  });
  server.listen(O.port || 0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ port: server.address().port }) + "\n"));
}

begin();
`;

let made = 0;
async function write(dir: string, opts: FakeOptions & { mode: "stdio" | "http" }): Promise<string> {
  const file = path.join(dir, `fake-${++made}.cjs`);
  await writeFile(file, `const O = ${JSON.stringify(opts)};\n${SCRIPT}`);
  return file;
}

// A stdio server's script, in `dir`, the test's own folder; the test starts it as a server with `command:
// process.execPath` and `args: [script]`.
export const fakeServer = (dir: string, opts: FakeOptions = {}) => write(dir, { ...opts, mode: "stdio" });

// An HTTP server, running until `stop` or the test's end, at http://127.0.0.1:<port>/mcp.
export async function httpFake(dir: string, opts: FakeOptions = {}): Promise<{ url: string; port: number; stop(): Promise<void> }> {
  const file = await write(dir, { ...opts, mode: "http" });
  const child = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  };
  onTestFinished(stop);
  const port = await new Promise<number>((resolve, reject) => {
    let text = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      text += d;
      if (text.includes("\n")) resolve(JSON.parse(text.slice(0, text.indexOf("\n"))).port);
    });
    child.once("exit", (code) => reject(new Error(`the fake HTTP server exited with code ${code}`)));
  });
  return { url: `http://127.0.0.1:${port}/mcp`, port, stop };
}

// The fake's log, one entry per line; none before its first message.
export function readLog(file: string): Record<string, any>[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
