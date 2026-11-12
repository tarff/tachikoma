import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
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
  instructions?: string; // what its initialize answer says of it (Task 6b's tool search)
  // Its resources (Task 13): each listed by uri, name and mimeType, and read as its `text`, or as its `blob` (base64)
  // with its mimeType, or answered an error with `fails` as its message, or with `hangs` never answered.
  resources?: { uri: string; name: string; text?: string; blob?: string; mimeType?: string; fails?: string; hangs?: true }[];
  lists?: "never" | "error"; // its resources/list and prompts/list never answered, or answered with an error
  // Its prompts (Task 13): each listed without its messages, which prompts/get sends with each {argument} in a text
  // filled in, or answered an error with `fails` as its message.
  prompts?: { name: string; description?: string; arguments?: object[]; messages?: object[]; fails?: string }[];
}

// Its tools: echo says `text` back; error answers isError; picture answers a 1x1 PNG; structured answers structured
// content only; slow never answers; progress sends progress and never answers; whoami tells its arguments, folder and
// variables; ask sends the client a request (`method`, `params`) and answers with the client's answer, or with `cancel`
// cancels that request at once and answers "cancelled" (Task 12: a server that gives up on its form); change adds a
// tool and says the list changed; exit prints `stderr` and exits with `code`. The tools are called by name whatever the
// list says, so a fake with its own `tools` still answers change and exit, and the unlisted add-resource, which adds its
// `resource` to the resources and says their list changed (Task 13). Over HTTP, which answers in JSON only, nothing
// reaches the client between answers, so progress, ask and the changes' notices need stdio.
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
let resources = O.resources || [];
let notify = () => {};
let request = () => {};

function answer(m, reply) {
  if (m.method === "initialize") {
    const capabilities = { tools: { listChanged: true } };
    if (O.resources) capabilities.resources = { listChanged: true };
    if (O.prompts) capabilities.prompts = { listChanged: true };
    const info = { protocolVersion: m.params.protocolVersion, capabilities, serverInfo: { name: "fake", version: "1.0.0" } };
    return reply({ result: O.instructions === undefined ? info : { ...info, instructions: O.instructions } });
  }
  if (m.method === "tools/list") return reply({ result: { tools } });
  if (O.lists && /^(resources|prompts)\/list$/.test(m.method)) return O.lists === "error" ? reply({ error: { code: -32603, message: "no list" } }) : undefined;
  if (m.method === "resources/list") return reply({ result: { resources: resources.map((r) => ({ uri: r.uri, name: r.name, mimeType: r.mimeType })) } });
  if (m.method === "resources/read") {
    const r = resources.find((x) => x.uri === m.params.uri);
    if (r && r.hangs) return;
    if (!r || r.fails) return reply({ error: { code: -32002, message: r ? r.fails : "no such resource" } });
    return reply({ result: { contents: [r.blob === undefined ? { uri: r.uri, text: r.text } : { uri: r.uri, mimeType: r.mimeType, blob: r.blob }] } });
  }
  if (m.method === "prompts/list") return reply({ result: { prompts: (O.prompts || []).map(({ messages, fails, ...p }) => p) } });
  if (m.method === "prompts/get") {
    const p = (O.prompts || []).find((x) => x.name === m.params.name);
    if (!p || p.fails) return reply({ error: { code: -32602, message: p ? p.fails : "no such prompt" } });
    const given = m.params.arguments || {};
    const fill = (c) => (c.type === "text" ? { ...c, text: c.text.replace(/\{(\w+)\}/g, (_, k) => given[k] ?? "") } : c);
    return reply({ result: { messages: p.messages.map((msg) => ({ ...msg, content: fill(msg.content) })) } });
  }
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
    case "ask": {
      const id = request(args.method, args.params, args.cancel ? () => {} : (r) => text(JSON.stringify(r.result ?? r.error)));
      if (!args.cancel) return;
      notify({ method: "notifications/cancelled", params: { requestId: id, reason: "no longer needed" } });
      return text("cancelled");
    }
    case "change":
      tools = O.added ? [...O.added, ...tools] : [...tools, tool("added")];
      text("changed");
      return notify({ method: "notifications/tools/list_changed" });
    case "add-resource":
      resources = [...resources, args.resource];
      text("added");
      return notify({ method: "notifications/resources/list_changed" });
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
    return id;
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

// A remote MCP server that needs sign-in, and its own sign-in service, in the test's process on 127.0.0.1 (release 8c
// plan, Task 11): the resource's and the service's discovery documents, registration, authorize (which sends the browser
// straight back to the redirect address, with a code, as a user who said yes would be), and tokens, by code with PKCE's
// S256 check, or by refresh token. Its MCP endpoint, at any path ending /mcp, answers only a live access token, and
// otherwise 401 with the address of its discovery document; it offers one tool, echo. `browser` stands for the user's
// browser: it follows the address it is given, redirects and all. `expire` makes every access token given so far stale,
// so the next request needs a refresh. `seen.requests` holds each request's path and headers. Its options: `refresh:
// false` gives no refresh tokens; `registration: false` publishes no registration, and "refused" publishes one that
// answers 403, as Figma's does for an app it has not approved (choice 60); `metadata` "none" publishes no
// sign-in details at all, and "elsewhere" publishes the service's metadata only at /elsewhere/metadata, for an entry's
// authServerMetadataUrl; "challenge" names its discovery document only in the 401, at /challenge/resource, and the
// service there is at /issuer, so nothing is found at the server's own well-known addresses (choice 70). `slow` holds
// each code's tokens until `answer()`.
export async function signInFake(opts: { refresh?: false; registration?: false | "refused"; metadata?: "none" | "elsewhere" | "challenge"; slow?: true } = {}) {
  const clients = new Map<string, { redirect_uris: string[] }>();
  const codes = new Map<string, { client: string; challenge: string; redirect: string }>();
  const live = new Set<string>();
  const refresh = new Set<string>();
  const held: (() => void)[] = [];
  const seen = {
    registered: 0, grants: [] as string[], bearer: [] as (string | null)[], authorized: [] as URLSearchParams[],
    requests: [] as { path: string; headers: http.IncomingHttpHeaders }[],
  };
  let issued = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", base);
      const json = (status: number, value: object, headers: Record<string, string> = {}) =>
        res.writeHead(status, { "content-type": "application/json", connection: "close", ...headers }).end(JSON.stringify(value));
      seen.requests.push({ path: url.pathname, headers: req.headers });
      const metadata = {
        issuer: opts.metadata === "challenge" ? `${base}/issuer` : base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
        ...(opts.registration !== false && { registration_endpoint: `${base}/register` }),
        response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
      };
      if (opts.metadata === "none" && url.pathname.startsWith("/.well-known/")) return res.writeHead(404, { connection: "close" }).end();
      if (opts.metadata === "elsewhere" && url.pathname === "/elsewhere/metadata") return json(200, metadata);
      if (opts.metadata === "challenge") {
        if (url.pathname === "/challenge/resource") return json(200, { resource: `${base}/mcp`, authorization_servers: [`${base}/issuer`] });
        if (url.pathname === "/.well-known/oauth-authorization-server/issuer") return json(200, metadata);
        if (url.pathname.startsWith("/.well-known/")) return res.writeHead(404, { connection: "close" }).end();
      }
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return json(200, { resource: `${base}${url.pathname.slice("/.well-known/oauth-protected-resource".length) || "/mcp"}`, authorization_servers: [base] });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server" && opts.metadata === undefined) return json(200, metadata);
      if (url.pathname === "/register" && req.method === "POST" && opts.registration !== false) {
        if (opts.registration === "refused") return res.writeHead(403, { connection: "close" }).end("Forbidden");
        const metadata = JSON.parse(body);
        const id = `client-${++seen.registered}`;
        clients.set(id, metadata);
        return json(201, { ...metadata, client_id: id });
      }
      if (url.pathname === "/authorize") {
        const q = url.searchParams;
        seen.authorized.push(q);
        const client = clients.get(q.get("client_id") ?? "") ?? (q.get("client_id") === "given-id" ? { redirect_uris: [q.get("redirect_uri")!] } : undefined);
        if (!client || !client.redirect_uris.includes(q.get("redirect_uri") ?? "")) return res.writeHead(400, { connection: "close" }).end("bad client");
        const code = `code-${++issued}`;
        codes.set(code, { client: q.get("client_id")!, challenge: q.get("code_challenge")!, redirect: q.get("redirect_uri")! });
        const back = new URL(q.get("redirect_uri")!);
        back.searchParams.set("code", code);
        back.searchParams.set("state", q.get("state") ?? "");
        return res.writeHead(302, { location: back.href, connection: "close" }).end();
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const form = new URLSearchParams(body);
        const grant = form.get("grant_type") ?? "";
        seen.grants.push(grant);
        const give = () => {
          const n = ++issued;
          live.add(`access-${n}`);
          refresh.add(`refresh-${n}`);
          const again = opts.refresh === false ? {} : { refresh_token: `refresh-${n}` };
          return json(200, { access_token: `access-${n}`, ...again, token_type: "Bearer", expires_in: 3600 });
        };
        if (grant === "authorization_code") {
          const c = codes.get(form.get("code") ?? "");
          codes.delete(form.get("code") ?? "");
          const verified = c && createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === c.challenge;
          if (!c || !verified || c.redirect !== form.get("redirect_uri") || c.client !== form.get("client_id")) return json(400, { error: "invalid_grant" });
          if (opts.slow) return void held.push(give);
          return give();
        }
        if (grant === "refresh_token" && refresh.delete(form.get("refresh_token") ?? "")) return give();
        return json(400, { error: "invalid_grant" });
      }
      if (url.pathname.endsWith("/mcp")) {
        const bearer = req.headers.authorization ?? null;
        seen.bearer.push(bearer);
        if (!bearer || !live.has(bearer.replace(/^Bearer /, ""))) {
          const resource = opts.metadata === "challenge" ? `${base}/challenge/resource` : `${base}/.well-known/oauth-protected-resource${url.pathname}`;
          return json(401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${resource}"` });
        }
        if (req.method !== "POST") return res.writeHead(405, { connection: "close" }).end();
        const m = JSON.parse(body);
        if (m.id === undefined) return res.writeHead(202, { connection: "close" }).end();
        const result =
          m.method === "initialize"
            ? { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.0.0" } }
            : m.method === "tools/list"
              ? { tools: [{ name: "echo", description: "Says it back", inputSchema: { type: "object" } }] }
              : { content: [{ type: "text", text: "echoed" }] };
        return json(200, { jsonrpc: "2.0", id: m.id, result }, { "mcp-session-id": "session" });
      }
      res.writeHead(404, { connection: "close" }).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  onTestFinished(() => {
    server.close();
    server.closeAllConnections();
  });
  return {
    url: `${base}/mcp`,
    base,
    seen,
    expire: () => live.clear(),
    revoke: () => refresh.clear(), // every refresh token given so far refused
    answer: () => held.splice(0).forEach((give) => give()),
    // The user's browser: each redirect followed, to the sign-in's own address on this machine at the end. Nothing waits for
    // it, so a failure is dropped, as a browser's is.
    browser: (address: string): void => void fetch(address).then((r) => r.text()).catch(() => {}),
    // A browser that brings the sign-in's own address `params` in place of a code, with the attempt's state: a user who
    // turned it down, the service's error; or a page that sends back nothing.
    sendsBack:
      (params: Record<string, string>) =>
      (address: string): void =>
        void (async () => {
          const authorize = new URL((await fetch(address, { redirect: "manual" })).headers.get("location")!);
          const back = new URL(authorize.searchParams.get("redirect_uri")!);
          back.search = new URLSearchParams({ ...params, state: authorize.searchParams.get("state")! }).toString();
          await fetch(back);
        })().catch(() => {}),
  };
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
