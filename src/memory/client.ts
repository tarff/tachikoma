import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  Client,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { commandEnv } from "../exec/env.js";
import { running } from "../exec/local.js";
import { load } from "./oslock.js";
import { WING } from "./paths.js";

// Tachikoma's palace client (8d plan, step 18): MemPalace's tools, called through the MCP library, either at the hub's
// address over HTTP or in a program started over stdio (the user's own `mempalace-mcp`, `"use"`). Each operation takes
// the caller's time limit and answers with what happened, never by throwing, so a turn never sees the palace fail.
// What it says is for the caller: none of it is shown to the user or the model as it is.

// The tools, by step 6's names (the build record, "Step 6 What MemPalace 3.12.0 really does", item 7).
const SEARCH = "mempalace_search";
const ADD = "mempalace_add_drawer";
const BY_LABEL = "mempalace_delete_by_source";
const ENTRIES = "mempalace_list_drawers";
const STATUS = "mempalace_status";

// What each palace must offer (the plan's table of that name): search and adding an entry from every palace; from
// Tachikoma's own also the look-up and removal by exact label, and the read-back of its backend (item 12), which is
// required of it.
const REQUIRED = { own: [SEARCH, ADD, BY_LABEL, STATUS], use: [SEARCH, ADD] };

// MemPalace's longest query (item 7: 251 characters are refused), counted by code point as MemPalace counts
// (mempalace/mcp_server/schemas.py:309; the build record, M5), so a character outside the basic plane is never split.
const LONGEST_QUERY = 250;

// The palace file of a sqlite_exact palace, and where it records the model (item 12).
const PALACE_FILE = "sqlite_exact.sqlite3";
const MODEL_KEY = "embedder_model:mempalace_drawers";

// Tachikoma's version, read as src/mcp/server.ts reads it: package.json is two folders up from both src/memory/ and
// dist/memory/.
const VERSION: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

export type Target = { url: string } | { command: string; args: string[] };
// Tachikoma's own palace, or the user's own MemPalace.
export type Kind = "own" | "use";
// One room of Tachikoma's wing, the whole wing, or the whole palace (with the user's own, its earlier memories too).
export type Scope = { room: string } | "wing" | "palace";

// What the palace offers: the required tools it lacks, by name, and whether it has the optional ones.
export interface Offers {
  missing: string[];
  lookup: boolean; // entries by exact label, and their removal (mempalace_delete_by_source)
  counts: boolean; // entries by room (mempalace_list_drawers)
}

// One search hit: one piece of an entry (item 8), with the entry's label and the date MemPalace filed it.
export interface Hit {
  text: string;
  wing: string;
  room: string;
  label: string;
  distance: number;
  date: string;
}

// What an operation says when it did not do its work: the palace does not offer it; MemPalace refused it, with its
// words; it passed the caller's limit; it failed another way, with the library's words; or the palace was lost.
export type Failure =
  | { is: "not offered" }
  | { is: "refused"; reason: string }
  | { is: "timed out" }
  | { is: "failed"; reason: string }
  | { is: "lost" };

export type Connected = { is: "connected"; palace: Palace } | { is: "timed out" } | { is: "failed"; reason: string };

type Answer = { is: "answer"; json: Record<string, unknown> } | Failure;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const timedOut = (err: unknown) => SdkError.isInstance(err) && err.code === SdkErrorCode.RequestTimeout;
// A hub is lost when a request cannot reach it (fetch's TypeError) or it no longer knows the session (404), as
// src/mcp/server.ts reads a remote server's drop; the 404 for the event stream the library tries to open is left
// out: the hub has none, and the library reports "Failed to open SSE stream: Not Found" on every connect (item 6).
const lostHub = (err: unknown) =>
  err instanceof TypeError ||
  (SdkHttpError.isInstance(err) && err.status === 404 && err.code !== SdkErrorCode.ClientHttpFailedToOpenStream);
// The query cut to MemPalace's longest, by code point.
const cut = (query: string) => [...query].slice(0, LONGEST_QUERY).join("");

// The program over stdio, added to `running` so it is killed when Tachikoma exits (src/exec/local.ts), taken from the
// library's private _process as src/mcp/server.ts takes it.
class Program extends StdioClientTransport {
  override async start(): Promise<void> {
    await super.start();
    const child = (this as unknown as { _process?: ChildProcess })._process;
    if (!child) throw new Error("the MCP library's stdio transport no longer keeps its process as _process");
    running.add(child);
    child.once("exit", () => running.delete(child));
  }
}

// Whether the palace was lost, and the caller told once: a hub that cannot be reached, a program that exited, once
// connected. A connect that fails says so itself, and a close of the client's own is not a loss.
class Link {
  connected = false;
  lost = false;
  closing = false;
  constructor(private readonly onLost?: () => void) {}
  lose(): void {
    if (!this.connected || this.lost || this.closing) return;
    this.lost = true;
    this.onLost?.();
  }
}

// Connects within the caller's time limit, and lists the palace's tools. A program is started with the commands'
// environment, which holds no API key (src/exec/env.ts), and with no argument but the caller's. The hub is reached
// with the library's own plain fetch, never through the MCP servers' fetch or the allowed sites' check.
export async function connect(
  target: Target,
  kind: Kind,
  opts: { timeout: number; onLost?: () => void },
): Promise<Connected> {
  const link = new Link(opts.onLost);
  const client = new Client({ name: "tachikoma", version: VERSION });
  client.onclose = () => link.lose();
  client.onerror = (err) => {
    if (lostHub(err)) link.lose();
  };
  const transport: Transport =
    "url" in target
      ? new StreamableHTTPClientTransport(new URL(target.url))
      : new Program({
          command: target.command,
          args: target.args,
          env: commandEnv() as Record<string, string>,
          stderr: "ignore",
        });
  try {
    await client.connect(transport, { timeout: opts.timeout });
    const { tools } = await client.listTools(undefined, { timeout: opts.timeout });
    const names = new Set(tools.map((t) => t.name));
    link.connected = true;
    return { is: "connected", palace: new Palace(client, link, names, kind) };
  } catch (err) {
    link.closing = true;
    await client.close().catch(() => {});
    return timedOut(err) ? { is: "timed out" } : { is: "failed", reason: message(err) };
  }
}

export class Palace {
  readonly offers: Offers;

  constructor(
    private readonly client: Client,
    private readonly link: Link,
    private readonly tools: Set<string>,
    kind: Kind,
  ) {
    this.offers = {
      missing: REQUIRED[kind].filter((name) => !tools.has(name)),
      lookup: tools.has(BY_LABEL),
      counts: tools.has(ENTRIES),
    };
  }

  get lost(): boolean {
    return this.link.lost;
  }

  // The hits, closest first as MemPalace gives them, at most `limit`, MemPalace's own count of results.
  async search(
    query: string,
    scope: Scope,
    limit: number,
    timeout: number,
  ): Promise<{ is: "found"; hits: Hit[] } | Failure> {
    const where = scope === "palace" ? {} : scope === "wing" ? { wing: WING } : { wing: WING, room: scope.room };
    const r = await this.call(SEARCH, { query: cut(query), limit, ...where }, timeout);
    if (r.is !== "answer") return r;
    const results = r.json.results;
    if (!Array.isArray(results)) return { is: "failed", reason: "the search's answer holds no results" };
    return { is: "found", hits: results.flatMap(hitOf) };
  }

  // Two rooms, as "this project" is the project's room and the lessons (Q27): two searches sent at once, one per room,
  // as one search covers one room (item 7), their hits merged by distance, closest first. When one fails or passes
  // the limit, the other's hits come alone; when both do, the first's failure.
  async searchTwo(
    query: string,
    rooms: [string, string],
    limit: number,
    timeout: number,
  ): Promise<{ is: "found"; hits: Hit[] } | Failure> {
    const both = await Promise.all(rooms.map((room) => this.search(query, { room }, limit, timeout)));
    const found = both.flatMap((r) => (r.is === "found" ? [r.hits] : []));
    if (!found.length) return both[0]!;
    return { is: "found", hits: found.flat().sort((a, b) => a.distance - b.distance) };
  }

  // An entry in Tachikoma's wing. The label is always sent as `source_file`, as the look-ups and removals go by it
  // (item 7). The same text already in the room is answered `already_exists`, whatever the label (item 9).
  async add(
    room: string,
    label: string,
    text: string,
    timeout: number,
  ): Promise<{ is: "added" | "already there" } | Failure> {
    const r = await this.call(ADD, { wing: WING, room, content: text, source_file: label }, timeout);
    if (r.is !== "answer") return r;
    return { is: r.json.reason === "already_exists" ? "already there" : "added" };
  }

  // How many pieces the entries with exactly this label have: the removal's dry run (item 8).
  async pieces(label: string, timeout: number): Promise<{ is: "counted"; pieces: number } | Failure> {
    const r = await this.call(BY_LABEL, { source_file: label, dry_run: true }, timeout);
    if (r.is !== "answer") return r;
    return typeof r.json.match_count === "number"
      ? { is: "counted", pieces: r.json.match_count }
      : { is: "failed", reason: "the look-up's answer holds no count" };
  }

  // Removes the entries with exactly this label, and says how many pieces went (item 8).
  async remove(label: string, timeout: number): Promise<{ is: "removed"; pieces: number } | Failure> {
    const r = await this.call(BY_LABEL, { source_file: label, dry_run: false }, timeout);
    if (r.is !== "answer") return r;
    return typeof r.json.deleted === "number"
      ? { is: "removed", pieces: r.json.deleted }
      : { is: "failed", reason: "the removal's answer holds no count" };
  }

  // How many entries a room of Tachikoma's wing holds: mempalace_list_drawers' total, which counts entries, where
  // mempalace_list_rooms counts pieces (item 7). One entry per page is asked for, MemPalace's smallest page; the
  // total does not depend on it (mempalace/mcp_server/tools_write.py:1359, :1387-1390).
  async entries(room: string, timeout: number): Promise<{ is: "counted"; entries: number } | Failure> {
    const r = await this.call(ENTRIES, { wing: WING, room, limit: 1 }, timeout);
    if (r.is !== "answer") return r;
    return typeof r.json.total === "number"
      ? { is: "counted", entries: r.json.total }
      : { is: "failed", reason: "the list's answer holds no total" };
  }

  // The backend in force, from mempalace_status, and the model, from the palace file's `meta` table in the folder
  // `palace`, read only, which works while the hub runs (item 12). The model is absent until the palace's first
  // write records it, or when the palace is not a sqlite_exact one.
  async inForce(palace: string, timeout: number): Promise<{ is: "read"; backend?: string; model?: string } | Failure> {
    const r = await this.call(STATUS, {}, timeout);
    if (r.is !== "answer") return r;
    const backend = typeof r.json.backend === "string" ? r.json.backend : undefined;
    return { is: "read", backend, model: modelIn(palace) };
  }

  async close(): Promise<void> {
    this.link.closing = true;
    await this.client.close().catch(() => {});
  }

  // One tool call, read as MemPalace answers: a JSON text, holding `error` (or `success: false` with it) when refused.
  private async call(tool: string, args: Record<string, unknown>, timeout: number): Promise<Answer> {
    if (!this.tools.has(tool)) return { is: "not offered" };
    if (this.link.lost) return { is: "lost" };
    try {
      const r = await this.client.callTool({ name: tool, arguments: args }, { timeout });
      const content = Array.isArray(r.content) ? r.content : [];
      const text = content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      if (r.isError) return { is: "refused", reason: text };
      const answer = objectIn(text);
      if (!answer) return { is: "failed", reason: "the answer is not a JSON object" };
      if (answer.error !== undefined || answer.success === false) {
        return { is: "refused", reason: String(answer.error) };
      }
      return { is: "answer", json: answer };
    } catch (err) {
      if (timedOut(err)) return { is: "timed out" };
      if (lostHub(err)) this.link.lose();
      if (this.link.lost) return { is: "lost" };
      return { is: "failed", reason: message(err) };
    }
  }
}

// A hit as MemPalace 3.12.0 and 3.6.0 both give it: the piece's text, its wing and room, the full label as
// `source_path` (`source_file` is only its last part), its distance and `created_at` (mempalace/searcher/query.py:412-
// 426). A hit without a distance cannot be put in order, and is left out.
function hitOf(x: unknown): Hit[] {
  const h = x as Record<string, unknown>;
  if (typeof h?.distance !== "number") return [];
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return [{ text: s(h.text), wing: s(h.wing), room: s(h.room), label: s(h.source_path), distance: h.distance,
    date: s(h.created_at) }];
}

function objectIn(text: string): Record<string, unknown> | undefined {
  try {
    const json: unknown = JSON.parse(text);
    return typeof json === "object" && json !== null ? (json as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function modelIn(palace: string): string | undefined {
  const { DatabaseSync } = load();
  let db: InstanceType<typeof DatabaseSync>;
  try {
    db = new DatabaseSync(path.join(palace, PALACE_FILE), { readOnly: true });
  } catch {
    return undefined;
  }
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(MODEL_KEY);
    return typeof row?.value === "string" ? row.value : undefined;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}
