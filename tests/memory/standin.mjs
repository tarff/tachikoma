// A stand-in MemPalace 3.12.0 for the tests (8d plan, step 18): one program that is the hub over HTTP
// (`--transport http`, as `mempalace.mcp_server --transport http` is started, Q24) and `mempalace-mcp` over stdio (the
// default), speaking MCP's JSON-RPC by hand as tests/mcp/fake.ts does. It behaves as step 6 found the real one does
// where Tachikoma depends on it (the build record, "Step 6 What MemPalace 3.12.0 really does", items 1 to 12):
// - the tools of item 7, with the same names and inputs;
// - entries kept in memory, each cut into pieces of 800 characters (code points), a search hit being one piece
//   (item 8; mempalace/searcher/query.py:412-426);
// - a look-up or removal by label (`source_file`) matches the exact label only (item 8);
// - an entry over 100,000 characters is refused, and a query over 250 (item 7; item 8);
// - the same text again in one wing and room is answered `already_exists`, whatever the label (item 9);
// - a search takes one room or the whole wing (or, with no wing, the whole palace), and refuses a list (item 7);
// - over HTTP it writes `serverinfo.json` as item 4 found it, with its own process id, and a second copy for the same
//   palace exits with code 2, as with MEMPALACE_MCP_WRITER_WAIT_SECONDS=0 (item 5);
// - over HTTP it answers the health check, GET /healthz, and the read-back of item 12: GET /statusz and
//   mempalace_status give the backend, and with `--backend sqlite_exact` the palace file `sqlite_exact.sqlite3` holds
//   the model in its `meta` table from the first add on, as a new palace records it at its first write;
// - over HTTP, started with MEMPALACE_MCP_HTTP_TOKEN, a POST to /mcp and GET /statusz without
//   `Authorization: Bearer <token>` are answered 401, and GET /healthz needs none (MemPalace 3.12.0's
//   mempalace/mcp_server/http.py:447-451, :737-756, :1341).
// Not modelled: meaning. A hit's distance is one minus the share of words its piece and the query have in common
// (lower is closer, as MemPalace's), so the tests can set the order. The backend is `--backend`'s, else MemPalace's
// default, chroma; the model is MEMPALACE_EMBEDDING_MODEL's, else minilm, written as given.
//
// What it was started with and every call it receives are added to `--record <file>`, one JSON line each:
// { start: { argv, env, pid } }, { call: { name, arguments } } and, over HTTP, { get: <path> } and
// { dropped: { name } } for a call whose connection closed before it was answered. Flags it does not
// know are passed over, as the real server's are (item 12, _guards.py:66-68). Told by its arguments:
// --lack <tool>              that tool is not offered (repeatable);
// --slow <ms>                every tool call is answered that much later;
// --hold-room <room>         a search of that room is never answered (repeatable);
// --refuse-writes            adding and removing are refused;
// --refuse-status            mempalace_status is refused as MemPalace refuses it on a palace with no entry yet, or
//                            with a palace file it cannot open (step 20's run 3, in the same words);
// --stop-after <tool>=<n>    once that tool's nth call is answered, it stops: later calls get no answer and change
//                            nothing, until the file `--gate <file>` exists (never, without --gate);
// --pause-after <tool>=<n>   once that tool's nth call is answered, later calls wait, and are answered in order once
//                            the file `--gate <file>` exists (never, without --gate), as a saver held between two parts
//                            (8d plan, step 22);
// --hang <ms>                over stdio, it answers `initialize` that much later and nothing after it, and keeps
//                            running when its input closes, as a program stuck in its start.
// Over HTTP it prints { "port": <p> } on a line of its own once it listens (port 0, or none given: any free one).
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const opt = {
  transport: "stdio",
  host: "127.0.0.1",
  port: 0,
  palace: undefined,
  backend: "chroma",
  record: undefined,
  lack: new Set(),
  slow: 0,
  holdRoom: new Set(),
  refuseWrites: false,
  stopAfter: undefined,
  gate: undefined,
};
for (let i = 0; i < argv.length; i++) {
  const next = () => argv[++i];
  switch (argv[i]) {
    case "--transport": opt.transport = next(); break;
    case "--host": opt.host = next(); break;
    case "--port": opt.port = Number(next()); break;
    case "--palace": opt.palace = path.resolve(next()); break;
    case "--backend": opt.backend = next(); break;
    case "--record": opt.record = next(); break;
    case "--lack": opt.lack.add(next()); break;
    case "--slow": opt.slow = Number(next()); break;
    case "--hold-room": opt.holdRoom.add(next()); break;
    case "--refuse-writes": opt.refuseWrites = true; break;
    case "--refuse-status": opt.refuseStatus = true; break;
    case "--stop-after": {
      const [tool, n] = next().split("=");
      opt.stopAfter = { tool, n: Number(n) };
      break;
    }
    case "--pause-after": {
      const [tool, n] = next().split("=");
      opt.pauseAfter = { tool, n: Number(n) };
      break;
    }
    case "--gate": opt.gate = next(); break;
    case "--hang": opt.hang = Number(next()); break;
  }
}

const record = (entry) => {
  if (opt.record) fs.appendFileSync(opt.record, JSON.stringify(entry) + "\n");
};
record({ start: { argv, env: process.env, pid: process.pid } });

const MODEL = process.env.MEMPALACE_EMBEDDING_MODEL || "minilm";
const PIECE = 800; // mempalace/config.py:415
const LONGEST_ENTRY = 100_000; // mempalace/config.py:283-291
const LONGEST_QUERY = 250; // mempalace/mcp_server/schemas.py:309
const MOST_RESULTS = 100; // _MAX_RESULTS, mempalace/mcp_server/_session.py:681
const chars = (s) => [...s];
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};

// ---- The palace ----
const entries = []; // { id, wing, room, label, pieces, filedAt }
let modelWritten = false;

// The model, recorded in the palace file at the first add, read by Tachikoma as item 12 read it. node:sqlite is loaded
// only then, with Node 22's warning about it dropped, so nothing reaches the error output.
function writeModel() {
  if (modelWritten || !opt.palace || opt.backend !== "sqlite_exact") return;
  modelWritten = true;
  fs.mkdirSync(opt.palace, { recursive: true });
  const emit = process.emitWarning;
  process.emitWarning = () => {};
  let sqlite;
  try {
    sqlite = process.getBuiltinModule("node:sqlite");
  } finally {
    process.emitWarning = emit;
  }
  const db = new sqlite.DatabaseSync(path.join(opt.palace, "sqlite_exact.sqlite3"));
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS collections (name TEXT PRIMARY KEY, dimension INTEGER)");
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("embedder_model:mempalace_drawers", MODEL);
  db.prepare("INSERT OR REPLACE INTO collections (name, dimension) VALUES (?, ?)").run("mempalace_drawers", 384);
  db.close();
}

const words = (s) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
function distance(query, text) {
  const a = words(query);
  const b = words(text);
  const union = new Set([...a, ...b]).size;
  const shared = [...a].filter((w) => b.has(w)).length;
  return union ? Math.round((1 - shared / union) * 10_000) / 10_000 : 1;
}

// Parameters refused as the call's own error, as MemPalace refuses them (item 7: -32602), not in its answer's text.
const invalid = (tool, what) => ({ rpcError: { code: -32602, message: `Invalid params for tool ${tool}: ${what}` } });
const inWing = (e, wing) => wing === undefined || e.wing === String(wing).toLowerCase();
const inRoom = (e, room) => room === undefined || e.room === room;
const piecesOf = (room) => entries.filter((e) => e.room === room).reduce((n, e) => n + e.pieces.length, 0);
const clamp = (n, fallback) => Math.max(1, Math.min(Number.isInteger(n) ? n : fallback, MOST_RESULTS));

const TOOLS = {
  mempalace_search(a) {
    if (typeof a.query !== "string") return invalid("mempalace_search", "'query' is a required property");
    if (chars(a.query).length > LONGEST_QUERY) {
      return invalid("mempalace_search", `'query' must be at most ${LONGEST_QUERY} characters`);
    }
    if (a.room !== undefined && typeof a.room !== "string") {
      return invalid("mempalace_search", "'room' must be a string");
    }
    const hits = [];
    for (const e of entries) {
      if (!inWing(e, a.wing) || !inRoom(e, a.room) || (a.source_file !== undefined && e.label !== a.source_file)) {
        continue;
      }
      e.pieces.forEach((text, i) => {
        const d = distance(a.query, text);
        hits.push({ drawer_id: `${e.id}_${i}`, text, wing: e.wing, room: e.room, source_file: path.basename(e.label),
          source_path: e.label, created_at: e.filedAt, filed_at: e.filedAt,
          similarity: Math.round((1 - d) * 1000) / 1000, distance: d, effective_distance: d, closet_boost: 0,
          matched_via: "drawer" });
      });
    }
    hits.sort((x, y) => x.distance - y.distance);
    // MemPalace's default limit is 5 (mempalace/mcp_server/tools_read.py:611).
    const results = hits.slice(0, clamp(a.limit, 5));
    return { query: a.query, filters: { wing: a.wing ?? null, room: a.room ?? null }, results };
  },
  mempalace_add_drawer(a) {
    for (const k of ["wing", "room", "content"]) {
      if (typeof a[k] !== "string") return invalid("mempalace_add_drawer", `'${k}' is a required property`);
    }
    if (opt.refuseWrites) return { success: false, error: "the stand-in refuses writes" };
    const text = chars(a.content);
    if (text.length > LONGEST_ENTRY) {
      return { success: false, error: `content exceeds maximum length of ${LONGEST_ENTRY} characters` };
    }
    const wing = a.wing.toLowerCase();
    // The entry's id from the wing, the room and the text only (mempalace/ids.py:71-80).
    const id = `drawer_${createHash("sha256").update(`${wing}\0${a.room}\0${a.content}`).digest("hex").slice(0, 24)}`;
    if (entries.some((e) => e.id === id)) return { success: true, reason: "already_exists", drawer_id: id };
    const pieces = [];
    for (let at = 0; at < Math.max(text.length, 1); at += PIECE) pieces.push(text.slice(at, at + PIECE).join(""));
    entries.push({ id, wing, room: a.room, label: a.source_file ?? "", pieces, filedAt: new Date().toISOString() });
    writeModel();
    const ids = pieces.length > 1 ? { chunk_ids: pieces.map((_, i) => `${id}_${i}`) } : {};
    return { success: true, drawer_id: id, wing, room: a.room, chunks: pieces.length, ...ids };
  },
  mempalace_delete_by_source(a) {
    if (typeof a.source_file !== "string") {
      return invalid("mempalace_delete_by_source", "'source_file' is a required property");
    }
    const matched = entries.filter((e) => e.label === a.source_file);
    const count = matched.reduce((n, e) => n + e.pieces.length, 0);
    if (a.dry_run !== false) return { success: true, dry_run: true, source_file: a.source_file, match_count: count };
    if (opt.refuseWrites) return { success: false, error: "the stand-in refuses writes" };
    for (const e of matched) entries.splice(entries.indexOf(e), 1);
    return { success: true, dry_run: false, source_file: a.source_file, deleted: count };
  },
  // Only identical text is found: the meaning check is not modelled.
  mempalace_check_duplicate(a) {
    const matches = entries.filter((e) => e.pieces.join("") === a.content)
      .map((e) => ({ id: e.id, wing: e.wing, room: e.room, similarity: 1 }));
    return { is_duplicate: matches.length > 0, matches };
  },
  mempalace_list_rooms(a) {
    const rooms = {};
    for (const e of entries.filter((x) => inWing(x, a.wing))) rooms[e.room] = (rooms[e.room] ?? 0) + e.pieces.length;
    return { wing: a.wing ?? null, rooms };
  },
  mempalace_list_drawers(a) {
    const all = entries.filter((e) => inWing(e, a.wing) && inRoom(e, a.room));
    const offset = Math.max(0, Number.isInteger(a.offset) ? a.offset : 0);
    const limit = clamp(a.limit, 20);
    const page = all.slice(offset, offset + limit)
      .map((e) => ({ drawer_id: e.id, wing: e.wing, room: e.room, source_file: e.label }));
    return { drawers: page, total: all.length, count: page.length, offset, limit };
  },
  mempalace_status() {
    if (opt.refuseStatus) {
      return { error: "Backend open failed", details: "Could not open the selected backend collection.",
        hint: "Run: mempalace status or mempalace repair-status for diagnostics.", backend: opt.backend };
    }
    const rooms = {};
    for (const e of entries) rooms[e.room] = piecesOf(e.room);
    const total = entries.reduce((n, e) => n + e.pieces.length, 0);
    return { total_drawers: total, rooms, backend: opt.backend, embedding_device: "cpu" };
  },
};

const S = (properties, required = []) => ({ type: "object", properties, required });
const str = { type: "string" };
const int = { type: "integer" };
const LIST = [
  { name: "mempalace_search", inputSchema: S({ query: { type: "string", maxLength: LONGEST_QUERY },
    limit: { type: "integer", minimum: 1, maximum: MOST_RESULTS }, wing: str, room: str, source_file: str, since: str,
    before: str, max_distance: { type: "number" } }, ["query"]) },
  { name: "mempalace_add_drawer",
    inputSchema: S({ wing: str, room: str, content: str, source_file: str, added_by: str },
      ["wing", "room", "content"]) },
  { name: "mempalace_delete_by_source",
    inputSchema: S({ source_file: str, dry_run: { type: "boolean" } }, ["source_file"]) },
  { name: "mempalace_check_duplicate", inputSchema: S({ content: str, threshold: { type: "number" } }, ["content"]) },
  { name: "mempalace_list_rooms", inputSchema: S({ wing: str }) },
  { name: "mempalace_list_drawers",
    inputSchema: S({ wing: str, room: str, since: str, before: str, limit: int, offset: int }) },
  { name: "mempalace_status", inputSchema: S({}) },
].filter((t) => !opt.lack.has(t.name)).map((t) => ({ ...t, description: t.name }));

// ---- MCP ----
const answered = {};
let stopped = false;
const gateOpen = () => opt.gate !== undefined && fs.existsSync(opt.gate);
// --pause-after's held calls, answered in order once the gate exists; looked for every 20 ms, a figure of the tests'.
let paused = false;
const held = [];
function pause() {
  paused = true;
  const timer = setInterval(() => {
    if (!gateOpen()) return;
    clearInterval(timer);
    paused = false;
    for (const go of held.splice(0)) go();
  }, 20);
}
function answer(m, reply) {
  if (m.method === "initialize") {
    return reply({ result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: "mempalace", version: "3.12.0" } } });
  }
  if (m.method === "ping") return reply({ result: {} });
  if (m.method === "tools/list") return reply({ result: { tools: LIST } });
  if (m.method !== "tools/call") return reply({ error: { code: -32601, message: `Method not found: ${m.method}` } });
  const { name } = m.params;
  const args = m.params.arguments ?? {};
  record({ call: { name, arguments: args } });
  if (paused) return void held.push(() => respond(name, args, reply));
  respond(name, args, reply);
}

function respond(name, args, reply) {
  if (stopped && !gateOpen()) return;
  stopped = false;
  if (name === "mempalace_search" && opt.holdRoom.has(args.room)) return;
  if (opt.lack.has(name) || !Object.hasOwn(TOOLS, name)) {
    return reply({ error: { code: -32602, message: `Unknown tool: ${name}` } });
  }
  const send = () => {
    const out = TOOLS[name](args);
    const text = JSON.stringify(out);
    reply(out.rpcError ? { error: out.rpcError } : { result: { content: [{ type: "text", text }] } });
    answered[name] = (answered[name] ?? 0) + 1;
    if (opt.stopAfter?.tool === name && answered[name] === opt.stopAfter.n) stopped = true;
    if (opt.pauseAfter?.tool === name && answered[name] === opt.pauseAfter.n) pause();
  };
  if (opt.slow) setTimeout(send, opt.slow);
  else send();
}

function serveStdio() {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const m = JSON.parse(line);
    if (m.id === undefined || m.method === undefined) return;
    const reply = (r) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...r }) + "\n");
    if (opt.hang === undefined) return answer(m, reply);
    if (m.method === "initialize") setTimeout(() => answer(m, reply), opt.hang);
  });
  if (opt.hang !== undefined) return setInterval(() => {}, 60_000);
  rl.on("close", () => process.exit(0));
}

// The palace's writer, held by the first copy; a second copy whose holder is running exits with code 2, as the real
// one does with MEMPALACE_MCP_WRITER_WAIT_SECONDS=0 (item 5; mempalace/mcp_server/runtime.py:232-254).
function takeWriter() {
  const file = path.join(opt.palace, "standin-writer.pid");
  for (let tries = 0; tries < 2; tries++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx" });
      process.on("exit", () => fs.rmSync(file, { force: true }));
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const pid = Number(fs.readFileSync(file, "utf8"));
      if (!pid || alive(pid)) return false;
      fs.rmSync(file, { force: true });
    }
  }
  return false;
}

// Item 4: <home>/.mempalace/server/<24 hex>/serverinfo.json, the key from the palace's full path, lower-cased as
// Windows compares paths (mempalace/paths.py:184-194). Never in the real home folder of the account running it.
function writeServerInfo(port) {
  const home = process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
  if (!home || path.resolve(home).toLowerCase() === path.resolve(os.userInfo().homedir).toLowerCase()) {
    process.stderr.write("stand-in: refusing to write serverinfo.json into the real home folder\n");
    process.exit(3);
  }
  const keyed = process.platform === "win32" ? opt.palace.toLowerCase() : opt.palace;
  const key = createHash("sha256").update(keyed).digest("hex").slice(0, 24);
  const dir = path.join(home, ".mempalace", "server", key);
  fs.mkdirSync(dir, { recursive: true });
  const info = { pid: process.pid, host: opt.host, port, scheme: "http", read_only: false,
    capabilities: ["mine_include_ignored", "mine_include_subagents", "search_cli_compatible"],
    search_config_fingerprint: createHash("sha256").update("stand-in").digest("hex"), palace_path: opt.palace };
  fs.writeFileSync(path.join(dir, "serverinfo.json"), JSON.stringify(info));
}

// Each POST to /mcp answered with one JSON message, with no session; a GET for the event stream is answered 404, as
// the hub answers it (item 6), and the hub's own checks are kept: 403 to a Via or X-Forwarded-For header, 415 to a body
// that is not JSON.
function serveHttp() {
  if (opt.palace) {
    fs.mkdirSync(opt.palace, { recursive: true });
    if (!takeWriter()) {
      process.stderr.write("Writable MCP HTTP startup refused: another mempalace writer already holds the palace lock" +
        ` for '${opt.palace}'\n`, () => process.exit(2));
      return;
    }
  }
  const token = process.env.MEMPALACE_MCP_HTTP_TOKEN ?? "";
  const server = http.createServer((req, res) => {
    const unauthorized = () => token !== "" && req.headers.authorization !== `Bearer ${token}`;
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("Connection", "close");
      const json = (status, value) => res.writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(value));
      if (req.method === "GET") {
        record({ get: req.url });
        if (req.url === "/healthz") return json(200, { status: "ok" });
        if (req.url === "/statusz") {
          if (unauthorized()) return res.writeHead(401).end();
          const palace = { backend: opt.backend, path: opt.palace ?? null };
          return json(200, { palace, server: { version: "3.12.0" } });
        }
        return res.writeHead(404).end();
      }
      if (req.method !== "POST" || req.url !== "/mcp") return res.writeHead(404).end();
      const proxied = req.headers.via !== undefined || req.headers["x-forwarded-for"] !== undefined;
      if (proxied) return res.writeHead(403).end();
      if (unauthorized()) return res.writeHead(401).end();
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return res.writeHead(415).end();
      const m = JSON.parse(body);
      if (m.id === undefined) return res.writeHead(202).end();
      // A call whose connection closes before it is answered, as when Tachikoma closes the palace with a request
      // still out, is recorded as dropped.
      let answered = false;
      res.on("close", () => {
        if (!answered && m.method === "tools/call") record({ dropped: { name: m.params.name } });
      });
      answer(m, (r) => {
        answered = true;
        json(200, { jsonrpc: "2.0", id: m.id, ...r });
      });
    });
  });
  server.listen(opt.port, opt.host, () => {
    const { port } = server.address();
    if (opt.palace) writeServerInfo(port);
    process.stdout.write(JSON.stringify({ port }) + "\n");
  });
}

if (opt.transport === "http") serveHttp();
else serveStdio();
