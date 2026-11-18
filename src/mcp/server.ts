import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  type CallToolResult,
  Client,
  type FetchLike,
  type GetPromptResult,
  InsufficientScopeError,
  type Prompt,
  type ReadResourceResult,
  type Resource,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SSEClientTransport,
  SseError,
  StreamableHTTPClientTransport,
  type Tool,
  type Transport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/client/stdio";
import { type Owner, visible } from "../core/permissions.js";
import { connectReason, errorText } from "../core/types.js";
import { commandEnv, mcpProgram } from "../exec/env.js";
import { MAX_TOOL_OUTPUT } from "../exec/executor.js";
import { killTree, running } from "../exec/local.js";
import { MAX_TIMER_MS } from "../hooks/config.js";
import { killInBox, NO_DOCKER } from "../sandbox/executor.js";
import { type AuthStore, McpAuth, NoSignIn, type SignInIO } from "./auth.js";
import {
  badNameLine,
  BOX_ROOTS,
  BOX_STOPPED,
  BOX_WORK,
  dockerProgram,
  envBlock,
  execArgs,
  groupFile,
  type McpBox,
  NOT_FOUND,
  notFoundLine,
  type Unstopped,
  unstoppedLine,
} from "./box.js";
import { Checker } from "./checker.js";
import type { ServerConfig, ServerEntry } from "./config.js";
import type { FormHandler } from "./forms.js";
import { mergeHeaders, runHelper } from "./helper.js";
import type { SiteRefused } from "./sitesFetch.js";

// One MCP server's connection, local or remote, through the library's own transports (release 8c plan, Task 4; choice 2).
// `Tool` is the library's tool, as tools/list sends it, each description whole: the views cut their own copies.
export type State =
  | { is: "starting" } | { is: "ready"; tools: Tool[] } | { is: "failed"; reason: string }
  | { is: "stopped"; reason: string; retry: boolean } // retry: a remote one whose connection dropped, not yet tried again since this drop (choices 13, 33)
  | { is: "needs sign-in" } | { is: "waiting for your yes" } | { is: "you said no" }
  // Why, as /mcp says it after "off: "; none when the box's network is off (8c-2b plan, Step 9; place.ts, offReason).
  | { is: "off"; reason?: string };

// With the allowed sites in force (8c-2b plan, Step 9; decision 13a): makes the checked fetch of one connection or one
// sign-in attempt (sitesFetch.ts), `refused` hearing its first refusal.
export type CheckedFetch = (refused: (err: SiteRefused) => void) => FetchLike;

// How a refresh ended (8c-2a plan, Task 11; decision 20): its new connection ready; failed, the server with it, with
// the reason a waiting call is told and whether it was the helper that failed or the new connection (choice 6); or
// dropped by a stop, or overtaken.
export type Refresh = { is: "ready" } | { is: "failed"; reason: string; helper: boolean } | { is: "dropped" };

// Claude Code's MCP_TIMEOUT: a server has 30 s to connect and send its first list (choice 1; "Numbers in this plan").
const START_MS = 30_000;
// A remote server's single request, unless the entry's timeout is longer (Claude Code's MCP page; "Numbers in this plan").
const REMOTE_MS = 60_000;
// From closing a local server's input to killing it (Claude Code's MCP page, Windows; choice 3); a signal's exit waits
// this long for every server's stop (clilib.ts, stopSoon).
export const KILL_MS = 300;

// Tachikoma's version, read as cli.tsx reads it: package.json is two folders up from both src/mcp/ and dist/mcp/.
const VERSION: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
// The project's folder as the server's roots (design, "The folder a server is told it works in"), and forms of both kinds;
// never sampling, which would spend the user's provider credit for the server (design, "Tools for the model").
const CAPABILITIES = { roots: {}, elicitation: { form: {}, url: {} } };

// A call whose request never reached the server: its connection was refused, or the server answered 404 to the session.
// The server is then stopped with retry, and Task 6's run connects again and sends the same call once more, as the
// approved call never ran (release 8c plan, choice 13: "Reconnect, then retry"). Its message is the stopped reason.
export class NotReached extends Error {}

// What a call to a server that needs sign-in answers the model (release 8c plan, choice 59).
export const needsSignIn = (name: string) => `The MCP server ${visible(name)} needs sign-in, which the user does from /mcp.`;

const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

// The library's stdio transport keeps its process to itself and tells onclose nothing of how it ended. Its process is
// taken once started, from 2.4.0's private _process (a version without it fails every local start, which the tests
// see), for the exit code or signal in the reason (choice 6), the kill at Tachikoma's exit (`running`) and stop's kill
// (choice 3). Its error output is kept in memory, its newest MAX_TOOL_OUTPUT characters (choice 5), read from the
// process's own pipe, whose every chunk comes before the process's close; the library's copy is drained, so a server
// printing much never waits on a full pipe.
class Stdio extends StdioClientTransport {
  child: ChildProcess | undefined;
  spawnError: unknown;
  errors = "";
  started: Promise<void> | undefined; // start()'s end, either way, once it is called, for a close that comes first

  override start(): Promise<void> {
    const starting = this.#start();
    this.started = starting.catch(() => {});
    return starting;
  }

  async #start(): Promise<void> {
    try {
      await super.start();
    } catch (err) {
      this.spawnError = err;
      throw err;
    }
    const child = (this as unknown as { _process?: ChildProcess })._process;
    if (!child) throw new Error("the MCP library's stdio transport no longer keeps its process as _process");
    this.child = child;
    running.add(child);
    child.once("exit", () => running.delete(child));
    const decoder = new StringDecoder("utf8");
    child.stderr?.on("data", (chunk: Buffer) => (this.errors = (this.errors + decoder.write(chunk)).slice(-MAX_TOOL_OUTPUT)));
    (this.stderr as NodeJS.ReadableStream | null)?.resume();
    this.spawned();
  }

  // Run once its process has spawned, inside start(), so before `started` settles and the library sends (BoxStdio).
  protected spawned(): void {}
}

// A box server's transport (8c-2a plan, Task 4, decision 1): the `docker exec -i` that runs it, whose input carries the
// block of its variables first, written once the process has spawned. The library awaits start() before it sends its
// first message, and a pipe keeps the order of what is written, so the block comes before `initialize`. `group` is the
// file in the box naming the server's process group, for the stop's kill.
class BoxStdio extends Stdio {
  constructor(
    params: StdioServerParameters,
    readonly block: Buffer,
    readonly group: string,
  ) {
    super(params);
  }

  protected override spawned(): void {
    this.child!.stdin!.write(this.block);
  }
}

interface Conn {
  client: Client;
  transport: Transport;
  local?: Stdio;
  ready: boolean;
  closed?: Promise<void>; // set once closing has begun, by a stop, a failed start or a drop
  // Its resources and prompts (Task 13), empty until they answer, and `listed` once both have answered or failed.
  resources: Resource[];
  prompts: Prompt[];
  listed: Promise<void>;
  // A remote one's (8c-2a plan, Task 10): whether it signs in (decision 16), whether a helper gave its headers, and the
  // redirect its fetch refused, if one did (connectionFetch).
  signs: boolean;
  helped: boolean;
  redirected?: Redirected;
  // With the allowed sites, its checked fetch's first refusal, read as redirected is (8c-2b plan, decision 13a).
  refused?: SiteRefused;
  // Task 11: its calls and reads waiting for answers, and whether a refresh replaced it, so it closes when none is left
  // (#retire; decision 25).
  sent: number;
  retiring?: boolean;
}

type RemoteEntry = Extract<ServerEntry, { kind: "http" | "sse" }>;
// A connection's headers, the helper's merged in, and whether it signs in, which #prepare decides for each one.
type Prepared = { headers: Record<string, string>; signs: boolean; helped: boolean };
// A new connection's start (#open): its tools, why it failed, or that it needs sign-in.
type Opened = { tools: Tool[] } | { reason: string } | { signIn: true };
// A refresh running (Task 11): the connection it replaces, the new one once made, its helper's stop, whether a stop
// dropped it, and its end.
type Refreshing = { from: Conn; next?: Conn; stop: AbortController; dropped?: true; done: Promise<Refresh> };

export class Server {
  readonly config: ServerConfig;
  readonly #root: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #onChange: () => void;
  readonly #startMs: number;
  #state: State = { is: "starting" };
  #connection = 0;
  #conn: Conn | undefined;
  #reconnecting: Promise<boolean> | undefined;
  #instructions: string | undefined;
  readonly #auth: McpAuth | undefined;
  readonly #onForm: FormHandler | undefined;
  readonly #calls = new Set<{ owner?: Owner }>(); // the calls running, each with the subagent that made it, if one did
  readonly #box: McpBox | undefined;
  readonly #unstopped: Unstopped[];
  readonly #pendingStops: Set<Promise<void>>; // its name's stops in the box still running (#close)
  #stops = 0; // how many stops have come, so a start that waited can tell one came meanwhile (#connect)
  readonly #helper: { cwd: string; project: boolean } | undefined;
  readonly #checked: CheckedFetch | undefined;
  #helping: AbortController | undefined; // the latest start's helper, which a stop kills
  #refresh: Refreshing | undefined; // the latest refresh, until it ends (Task 11)
  readonly #retiring = new Set<Conn>(); // the connections refreshes replaced, until each has closed (decision 25)

  // `startMs` is the start's limit, 30 s unless a test gives a short one. `auth` keeps sign-ins: with it a remote server
  // has its own OAuth client (Task 11) when its headersHelper runs, or when its entry has no Authorization header of
  // its own, in any letter case; a connection signs in only when its headers, the helper's merged in, have none (8c-2a
  // plan, decision 16), as one with its own key is never signed in, so its 401 says to look at the key (choice 55);
  // without it, as in most tests, a 401 is an answer like any other. `onForm` answers the server's forms (Task 12);
  // without it, as in most tests, each is declined.
  // `box`: the session's box, in which a local server runs unless its entry says host (8c-2a plan, Tasks 4 and 6); any
  // server given it uses it to try its name's failed stops again. `unstopped`: its name's stops that failed in the box,
  // a list `Servers` owns and gives every copy of the name, or else this server's own (decision 24). `pendingStops`:
  // its name's stops in the box still running, a set given so too (decision 24, as built). `helper`: given when the
  // entry's headersHelper runs, the folder it runs in and whether it is the project's (Servers; Task 10).
  // `checked`: given a remote server with the allowed sites in force, the maker of each connection's checked fetch,
  // and of each sign-in attempt's (8c-2b plan, Step 9; decision 13a).
  constructor(
    config: ServerConfig,
    opts: {
      root: string; env: NodeJS.ProcessEnv; auth?: AuthStore; onChange(): void; onForm?: FormHandler; startMs?: number;
      box?: McpBox; unstopped?: Unstopped[]; pendingStops?: Set<Promise<void>>;
      helper?: { cwd: string; project: boolean }; checked?: CheckedFetch;
    },
  ) {
    this.config = config;
    this.#root = opts.root;
    this.#env = opts.env;
    this.#onChange = opts.onChange;
    this.#onForm = opts.onForm;
    this.#startMs = opts.startMs ?? START_MS;
    this.#box = opts.box;
    this.#unstopped = opts.unstopped ?? [];
    this.#pendingStops = opts.pendingStops ?? new Set();
    this.#helper = opts.helper;
    this.#checked = opts.checked;
    const entry = config.entry;
    const signs = opts.auth && entry.kind !== "stdio" && (opts.helper || !hasAuthorization(entry.headers));
    this.#auth = signs ? new McpAuth(opts.auth!, config, undefined, opts.checked) : undefined;
  }

  get state(): State {
    return this.#state;
  }

  // Raised at each new connection, so a call keeps the number of the one that offered its tool (design, finding 4).
  get connection(): number {
    return this.#connection;
  }

  // What the server said of itself when its last connection began (the library's getInstructions()), whole: tool_search's
  // description cuts its own copy (release 8c plan, choice 37).
  get instructions(): string | undefined {
    return this.#instructions;
  }

  // The resources `@` lists and the prompts the `/` menu lists (release 8c plan, Task 13), only while it is ready, each
  // empty until its list answers; `listed`, once both lists have answered or failed, so a prompt sent as the server
  // becomes ready finds what it picked.
  get resources(): Resource[] {
    return this.#state.is === "ready" ? (this.#conn?.resources ?? []) : [];
  }
  get prompts(): Prompt[] {
    return this.#state.is === "ready" ? (this.#conn?.prompts ?? []) : [];
  }
  get listed(): Promise<void> {
    return this.#conn?.listed ?? Promise.resolve();
  }

  // The refresh running, for a call to wait for (tools.ts; decision 20); a dropped one until it ends (decision 21).
  get refreshing(): Promise<Refresh> | undefined {
    return this.#refresh?.done;
  }

  // Never throws: the state says how it went.
  async start(): Promise<void> {
    await this.#connect((reason) => ({ is: "failed", reason }));
  }

  // A remote server whose connection dropped gets one new connection per drop (choices 13 and 33; the user's choice,
  // 2026-11-10, "Once per drop"): a caller while it tries waits for the same one and gets its answer; once connected, a
  // later drop gets its own; a failed one leaves it stopped without retry, until /mcp. Nothing restarts on its own;
  // Task 6's run calls this.
  reconnect(): Promise<boolean> {
    if (this.#reconnecting) return this.#reconnecting;
    if (this.#state.is !== "stopped" || !this.#state.retry) return Promise.resolve(false);
    this.#reconnecting = this.#connect((reason) => ({ is: "stopped", reason, retry: false })).finally(() => (this.#reconnecting = undefined));
    return this.#reconnecting;
  }

  // The entry's timeout, or else Node's longest wait for a local server and 60 s for a remote one, whose entry's timeout
  // counts only when longer ("Numbers in this plan"); always passed, as the library's own default is 60 s. The limit is
  // hard: no progress is asked for and none extends it, as Claude Code's MCP page says (the user's choice, 2026-11-10).
  // The signal stops the call, and the library tells the server. A remote call that never reached the server throws
  // NotReached; one that may have (a connection cut mid-answer) fails with the library's error. Either way the server is
  // stopped with retry by then (onerror), and the call is not sent again here. `timeout`, in ms, is a caller's own limit in
  // place of these: an mcp_tool hook's, whose own time limit ends its call (hooks/run.ts). `owner`: the subagent making the
  // call, if one is, so a form the server asks for meanwhile is headed with its id (choice 29). `noted`: rewrites the
  // error's words for a call whose own 401 or 403 began the refresh running for its connection, or came while it ran
  // (tools.ts, refused).
  async callTool(
    name: string,
    args: object,
    opts: { signal?: AbortSignal; timeout?: number; owner?: Owner; noted?(message: string, status: number): string },
  ): Promise<CallToolResult> {
    const conn = this.#conn;
    if (!conn?.ready || conn.closed || this.#state.is !== "ready") throw new Error("Not connected"); // stopped: not closed yet
    const timeout = opts.timeout ?? this.#limit();
    const call = opts.owner ? { owner: opts.owner } : {};
    this.#calls.add(call);
    conn.sent++;
    try {
      return await conn.client.callTool({ name, arguments: args as Record<string, unknown> }, { signal: opts.signal, timeout });
    } catch (err) {
      if (conn.refused) throw this.#refusedOn(conn, conn.refused);
      if (!conn.local && notReached(err)) throw new NotReached(remoteReason(this.#address(), err), { cause: err });
      // A sign-in lost mid-session: a refused refresh, a Sign out in another window (choice 59).
      if (conn.signs && UnauthorizedError.isInstance(err)) {
        this.#lostSignIn(conn);
        throw new Error(needsSignIn(this.config.name), { cause: err });
      }
      // On a connection that signs in, a 401 is sign-in's and begins no refresh (#answered).
      const status = refusedWith(err);
      const r = this.#refresh;
      if (opts.noted && status && (status === 403 || !conn.signs) && r?.from === conn && !r.dropped) {
        (err as Error).message = opts.noted((err as Error).message, status);
      }
      throw err;
    } finally {
      this.#calls.delete(call);
      if (--conn.sent === 0 && conn.retiring) void this.#close(conn);
    }
  }

  // A picked resource read, and a prompt fetched with its arguments, as a prompt is sent (Task 13; choices 30, 31): each
  // read afresh, never from the library's cache, under a call's limit. The lead's, as only the window's prompt sends them,
  // so a form the server asks for meanwhile is the lead's when no subagent's call runs beside it (choice 29). A sign-in
  // lost meanwhile is taken as a call's is (choice 59), its error the library's own. A remote request that never reached
  // the server throws NotReached, as a call does, for the caller to connect again and read once more, as a read changes
  // nothing; one that failed on the way says so as a start's reason does (remoteReason), never a bare "fetch failed".
  readResource(uri: string, opts: { signal?: AbortSignal }): Promise<ReadResourceResult> {
    return this.#request((client, timeout) => client.readResource({ uri }, { signal: opts.signal, timeout, cacheMode: "bypass" }));
  }
  getPrompt(name: string, args: Record<string, string>, opts: { signal?: AbortSignal }): Promise<GetPromptResult> {
    return this.#request((client, timeout) => client.getPrompt({ name, arguments: args }, { signal: opts.signal, timeout }));
  }

  async #request<T>(send: (client: Client, timeout: number) => Promise<T>): Promise<T> {
    const conn = this.#conn;
    if (!conn?.ready || conn.closed || this.#state.is !== "ready") throw new Error("Not connected");
    const call = {};
    this.#calls.add(call);
    conn.sent++;
    try {
      return await send(conn.client, this.#limit());
    } catch (err) {
      if (conn.refused) throw this.#refusedOn(conn, conn.refused);
      if (!conn.local && notReached(err)) throw new NotReached(remoteReason(this.#address(), err), { cause: err });
      if (conn.signs && UnauthorizedError.isInstance(err)) this.#lostSignIn(conn);
      else if (!conn.local && (err instanceof TypeError || err instanceof SdkHttpError || err instanceof SseError)) {
        throw new Error(remoteReason(this.#address(), err), { cause: err });
      }
      throw err;
    } finally {
      this.#calls.delete(call);
      if (--conn.sent === 0 && conn.retiring) void this.#close(conn);
    }
  }

  // At Tachikoma's exit, a restart or a removal (choice 3). `exit`: at Tachikoma's exit, when removing the box ends a
  // box server, so its `docker exec` is ended at once (8c-2a plan, decision 6). A refresh running is dropped, its
  // helper killed, and every connection is closed: the current one, the refresh's new one and those still draining
  // (8c-2a plan, decisions 21 and 25).
  async stop(opts: { exit?: boolean } = {}): Promise<void> {
    this.#stops++;
    this.#helping?.abort(); // a helper still running for a start is killed (decision 22)
    const r = this.#refresh;
    if (r) {
      r.dropped = true;
      r.stop.abort();
    }
    const conns = new Set([this.#conn, r?.next, ...this.#retiring]);
    await Promise.all([...conns].map((conn) => conn && this.#close(conn, opts.exit)));
  }

  // /mcp's Sign in and Sign out (Task 11), for a remote server that has its own OAuth client; the caller connects again.
  signIn(io: SignInIO): Promise<boolean> {
    return this.#auth ? this.#auth.signIn(io) : Promise.resolve(false);
  }
  async signOut(): Promise<void> {
    await this.#auth?.forget();
  }
  // Whether a sign-in is kept for it, so Sign out applies.
  get signedIn(): boolean {
    return this.#auth?.kept ?? false;
  }

  // A new connection: connected and its tools listed within the start's limit. `failed` gives the state for a reason.
  async #connect(failed: (reason: string) => State): Promise<boolean> {
    const connection = ++this.#connection;
    const stops = this.#stops;
    this.#state = { is: "starting" };
    // One still open, as when two Reconnects come close together, is closed first, so only one server runs; its own
    // start then finds it closed and leaves the state to this one (release 8c plan, Task 10's quality review). Its
    // close begins here, before the wait below, so a box copy's is waited for as any of its name's (decision 24, as
    // built; the review of the PR review's fix, 2026-11-18).
    const prev = this.#conn;
    if (prev && !prev.closed) void this.#close(prev);
    // Decision 24: the name's stops that failed in the box are tried again first; while one is not confirmed, nothing
    // starts, as its copy may still run there. Only then is there a wait, so a start with none connects as before. A
    // stop or a newer start during that wait leaves this start going no further, the state theirs, as there is no
    // connection yet for the stop to close (Task 4's spec review).
    // Before the retries, the name's stops in the box still running are waited for, as one may yet fail and be kept:
    // an entry removed by one live edit and added back by a later one would otherwise start beside its old copy
    // (decision 24, as built; the PR review, 2026-11-18). A stop or a newer start meanwhile holds here too.
    if (this.#pendingStops.size) {
      await Promise.allSettled(this.#pendingStops); // a stop that failed holds nothing more here
      if (this.#stops !== stops || this.#connection !== connection) return false;
    }
    if (this.#unstopped.length) {
      const left = await this.#retryStops();
      if (this.#stops !== stops || this.#connection !== connection) return false;
      if (left !== undefined) {
        this.#state = failed(unstoppedLine(visible(left, { tabs: true }))); // Docker's words, escaped as a reason's are
        return false;
      }
    }
    // A remote connection's headers, with its helper's when it runs (8c-2a plan, Task 10), whose 10 s come before the
    // start's limit, which is the server's (decision 14). Only a stop rejects it, as the stop kills the helper, and the
    // start then goes no further, as after the retries above (decision 22). An earlier start's helper still running, as
    // when two Reconnects come close together, is killed too, as that start would go no further.
    const entry = this.config.entry;
    let prepared: Prepared = { headers: {}, signs: false, helped: false };
    if (entry.kind !== "stdio") {
      this.#helping?.abort();
      const helping = (this.#helping = new AbortController());
      const got = await this.#prepare(entry, helping.signal).catch(() => undefined);
      if (got === undefined || this.#stops !== stops || this.#connection !== connection) return false;
      if ("reason" in got) {
        this.#state = failed(helperFailed(got.reason));
        return false;
      }
      prepared = got;
    }
    const conn = this.#newConn(prepared);
    if (typeof conn === "string") {
      this.#state = failed(conn);
      return false;
    }
    this.#conn = conn;
    const got = await this.#open(conn);
    if (conn.closed) return false; // stopped meanwhile: the stop's caller owns the state
    if (!("tools" in got)) {
      this.#state = "signIn" in got ? { is: "needs sign-in" } : failed(got.reason);
      await this.#close(conn);
      return false;
    }
    conn.ready = true;
    this.#instructions = conn.client.getInstructions();
    this.#state = { is: "ready", tools: got.tools };
    return true;
  }

  // A connection's transport and client, or the reason it cannot be made.
  #newConn(prepared: Prepared): Conn | string {
    const conn: Conn = {
      transport: undefined as unknown as Transport, client: undefined as unknown as Client, ready: false,
      resources: [], prompts: [], listed: Promise.resolve(), signs: prepared.signs, helped: prepared.helped, sent: 0,
    };
    const made = this.#transport(prepared, conn);
    if (typeof made === "string") return made;
    conn.transport = made;
    if (made instanceof Stdio) conn.local = made;
    conn.client = this.#client(conn);
    return conn;
  }

  // A new connection connected and its tools listed within the start's limit, for a start and a refresh alike.
  // The library's own limit on each request is passed too, so neither falls back to its 60 s. Its resources and
  // prompts (Task 13) are asked for beside its tools, only of a server that offers them, as the library would otherwise
  // print that it does not onto the window; the start never waits for them, and one that fails stays empty, as the
  // tools still work. Each fills in when it answers, under the library's own limit, and is taken by a refresh's new
  // connection before it is the server's (Task 11).
  async #open(conn: Conn): Promise<Opened> {
    const work = (async () => {
      await conn.client.connect(conn.transport, { timeout: this.#startMs });
      const offers = conn.client.getServerCapabilities();
      const list = <T>(asked: Promise<T[]>, take: (items: T[]) => void) =>
        asked.then((items) => {
          if (conn.closed) return;
          take(items);
          if (conn === this.#conn && conn.ready) this.#onChange();
        }, () => {});
      conn.listed = Promise.all([
        offers?.resources && list(conn.client.listResources().then((r) => r.resources), (r) => (conn.resources = r)),
        offers?.prompts && list(conn.client.listPrompts().then((r) => r.prompts), (p) => (conn.prompts = p)),
      ]).then(() => {});
      return (await conn.client.listTools(undefined, { timeout: this.#startMs })).tools;
    })();
    work.catch(() => {}); // a late answer, or the close at the limit, comes after the race below is settled
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), this.#startMs)));
    try {
      const got = await Promise.race([work, late]);
      return got === "late" ? { reason: this.#late() } : { tools: got };
    } catch (err) {
      // A refusal of its checked fetch comes first, whatever the library made of it, its 401 handling's included
      // (8c-2b plan, Step 9; decision 13a).
      if (conn.refused) return { reason: conn.refused.message };
      // A start the server refused for want of a sign-in, which only /mcp starts (Task 11); one that publishes no sign-in
      // details keeps its 401 (choice 59).
      if (conn.signs && UnauthorizedError.isInstance(err)) return { signIn: true };
      return { reason: err instanceof NoSignIn ? `${this.#address()} answered 401` : this.#startReason(conn, err) };
    } finally {
      clearTimeout(timer);
    }
  }

  // A status the server's own address answered to a tool call, a resource read or a prompt on this connection
  // (connectionFetch), never to a list the connection asks for itself (Task 11's re-check). A 401 or 403 on the ready
  // connection in force, whose headers a helper gave, starts a refresh, unless one is running; on a connection that
  // signs in a 401 stays sign-in's (8c-2a plan, Task 11; decision 18). A dropped refresh still ending blocks none.
  #answered(conn: Conn, status: number): void {
    if (status !== 403 && (status !== 401 || conn.signs)) return;
    if (!conn.helped || conn !== this.#conn || !conn.ready || conn.closed) return;
    if (this.#refresh && !this.#refresh.dropped) return;
    const r = { from: conn, stop: new AbortController() } as Refreshing;
    this.#refresh = r;
    r.done = this.#reopen(r);
  }

  // A refresh (decisions 19, 21 and 23): the helper run again and a new connection opened beside the old one, which
  // then is the server's, its connection number kept, and the old one closed once its calls have their answers. A
  // failure leaves the server failed, as at a start. After each step it goes on only while it is still the refresh in
  // force, not dropped, and its old connection still the server's; otherwise what it opened is closed.
  async #reopen(r: Refreshing): Promise<Refresh> {
    const current = () => this.#refresh === r && !r.dropped && this.#conn === r.from;
    try {
      const got = await this.#prepare(this.config.entry as RemoteEntry, r.stop.signal).catch(() => undefined);
      if (got === undefined || !current()) return { is: "dropped" };
      if ("reason" in got) return this.#refreshFailed(r, helperFailed(got.reason), got.reason, true);
      const conn = this.#newConn(got);
      if (typeof conn === "string") return this.#refreshFailed(r, conn, conn, false);
      r.next = conn;
      const opened = await this.#open(conn);
      if (!current()) {
        await this.#close(conn);
        return { is: "dropped" };
      }
      if (!("tools" in opened)) {
        await this.#close(conn);
        if ("reason" in opened) return this.#refreshFailed(r, opened.reason, opened.reason, false);
        // Its sign-in no longer holds: as at a start, and a call waiting is told so (tools.ts, notRunning).
        this.#state = { is: "needs sign-in" };
        this.#conn = undefined;
        this.#retire(r.from);
        this.#onChange();
        return { is: "dropped" };
      }
      conn.ready = true;
      this.#conn = conn;
      this.#instructions = conn.client.getInstructions();
      this.#state = { is: "ready", tools: opened.tools };
      this.#retire(r.from);
      this.#onChange();
      return { is: "ready" };
    } finally {
      if (this.#refresh === r) this.#refresh = undefined;
    }
  }

  // A refresh that failed: the server failed with `state`'s reason, said as at a start, and the old connection closed
  // once its calls have their answers; a call waiting gets `reason` (decision 23; choice 6).
  #refreshFailed(r: Refreshing, state: string, reason: string, helper: boolean): Refresh {
    this.#state = { is: "failed", reason: state };
    this.#conn = undefined;
    this.#retire(r.from);
    this.#onChange();
    return { is: "failed", reason, helper };
  }

  // A connection a refresh replaced: kept until it closes, once no call or read waits on it (decision 25).
  #retire(conn: Conn): void {
    conn.retiring = true;
    if (conn.closed) return;
    this.#retiring.add(conn);
    if (conn.sent === 0) void this.#close(conn);
  }

  // Each of the name's failed stops, tried again (decision 24): confirmed when the box is known to run nothing
  // (BoxState.stopped) or the kill now runs in the box, and then forgotten; otherwise kept with the new reason. Gives
  // the latest retry's reason while any is left. The box is the one every copy of the name is given (Servers). A copy
  // given no box cannot prove a stop, so its record stands, as it is, and nothing starts (8c-2a plan, Task 6).
  async #retryStops(): Promise<string | undefined> {
    const box = this.#box;
    if (!box) return this.#unstopped.at(-1)?.reason;
    const stopped = await box.state.stopped(); // one answer for the whole box
    for (const stop of [...this.#unstopped]) {
      const reason = stopped ? undefined : await killInBox(box.run, box.id, stop.group);
      const at = this.#unstopped.indexOf(stop);
      if (reason !== undefined) stop.reason = reason;
      else if (at !== -1) this.#unstopped.splice(at, 1); // not already confirmed by another start's retry
    }
    return this.#unstopped.at(-1)?.reason;
  }

  // A remote connection's headers (8c-2a plan, Task 10; decision 16): the entry's, with the helper's over them when it
  // runs, and whether the connection signs in, which it does with an OAuth client when those headers hold no
  // Authorization. A helper that fails gives choice 5's `<why>` instead, which a start puts after its prefix.
  async #prepare(entry: RemoteEntry, signal: AbortSignal): Promise<Prepared | { reason: string }> {
    const helper = this.#helper;
    let headers = entry.headers;
    if (helper && entry.headersHelper !== undefined) {
      const { name } = this.config;
      const opts = { name, url: entry.url, ...helper, root: this.#root, env: this.#env, signal };
      const got = await runHelper(entry.headersHelper, opts);
      if ("reason" in got) return got;
      headers = mergeHeaders(headers, got.headers);
    }
    return { headers, signs: this.#auth !== undefined && !hasAuthorization(headers), helped: helper !== undefined };
  }

  // A local server in the session's box (8c-2a plan, Task 4; decisions 3-5): refused when the box has broken, or when
  // the box cannot take a variable's name. The docker program is found on PATH at each start, unless a test gives its
  // stand-in, and gets the commands' environment, never the entry's, as Docker reads variables of its own (design,
  // "What the server gets"). The server's variables, CLAUDE_PROJECT_DIR=/work then the entry's, go in the block over
  // its input. Docker runs in the project's folder on this machine; the server, in /work.
  #inBox(box: McpBox, entry: Extract<ServerEntry, { kind: "stdio" }>): Transport | string {
    if (box.state.broken) return BOX_STOPPED;
    const made = envBlock({ CLAUDE_PROJECT_DIR: BOX_WORK, ...entry.env });
    if ("bad" in made) return badNameLine(made.bad);
    const program = box.program ?? dockerProgram(this.#env);
    if (!program) return NO_DOCKER;
    const group = groupFile();
    const args = [...program.args, ...execArgs(box.id, group, entry.command, entry.args)];
    const env = commandEnv(this.#env) as Record<string, string>;
    return new BoxStdio({ command: program.file, args, env, cwd: this.#root, stderr: "pipe" }, made.block, group);
  }

  // Local: the program by its full path (choice 4), with the commands' environment, which never holds Tachikoma's keys,
  // CLAUDE_PROJECT_DIR as Claude Code sets it, then the entry's env, in the project's folder (choice 2). Remote: the
  // connection's headers with each request, and its OAuth client when it signs in (Task 11; 8c-2a plan, decision 16);
  // then the headers go only to the server's own address (choice 54), as the library's sign-in requests would carry
  // requestInit's too. Its own fetch either way (connectionFetch; decision 17). A reason instead when the program is
  // not on PATH.
  #transport(prepared: Prepared, conn: Conn): Transport | string {
    const entry = this.config.entry;
    if (entry.kind === "stdio") {
      // A host entry is given the box too, for its name's retries only (8c-2a plan, Task 6; place.ts, placeOf).
      if (this.#box && !this.config.host) return this.#inBox(this.#box, entry);
      const program = mcpProgram(entry.command, this.#env);
      if (program === null) return `${visible(entry.command)} was not found on PATH`;
      const env = { ...commandEnv(this.#env), CLAUDE_PROJECT_DIR: this.#root, ...entry.env } as Record<string, string>;
      return new Stdio({ command: program, args: entry.args, env, cwd: this.#root, stderr: "pipe" });
    }
    const url = new URL(entry.url);
    let made: Transport | undefined;
    // An sse server's messages go to the address its event stream names, at the same host (the library checks it), so
    // that is its own address too; the library keeps it as _endpoint, read when each request is made.
    const endpoint = () => (made as { _endpoint?: URL } | undefined)?._endpoint;
    const { headers, signs } = prepared;
    const answered = (status: number) => this.#answered(conn, status);
    const redirected = (err: Redirected) => (conn.redirected = err);
    // With the allowed sites, this connection's own checked fetch (8c-2b plan, Step 9; decision 13a), which its sign-in
    // client's own requests use too (auth.ts, discoveryState).
    const checked = this.#checked?.((err) => (conn.refused ??= err));
    if (checked && this.#auth) this.#auth.fetch = checked;
    const own = checked ? { fetch: checked } : {};
    const send = connectionFetch({ url, endpoint, headers, signs, answered, redirected, ...own });
    const opts = signs ? { authProvider: this.#auth!, fetch: send } : { requestInit: { headers }, fetch: send };
    // With a helper, a 403 asking for more scope fails its request, which the library would otherwise send again after
    // signing in again, and the refresh follows (Task 11; decision 26). The SSE transport sends nothing again.
    const scope = prepared.helped ? { onInsufficientScope: "throw" as const } : {};
    made =
      entry.kind === "http"
        ? new StreamableHTTPClientTransport(url, { ...opts, ...scope })
        : new SSEClientTransport(url, opts);
    return made;
  }

  // One client per connection, so nothing of an old one's lists or handlers reaches the new one.
  #client(conn: Conn): Client {
    const client = new Client(
      { name: "tachikoma", version: VERSION },
      {
        capabilities: CAPABILITIES,
        jsonSchemaValidator: new Checker(), // a tool's outputSchema is checked without the library's console warnings
        listChanged: {
          tools: {
            onChanged: (err, tools) => {
              if (err || !tools || conn !== this.#conn || !conn.ready || conn.closed) return;
              this.#state = { is: "ready", tools };
              this.#onChange();
            },
          },
          // Read again when the server says they changed, so `@` and the `/` menu show them (Task 13).
          resources: {
            onChanged: (err, resources) => {
              if (err || !resources || conn !== this.#conn || !conn.ready || conn.closed) return;
              conn.resources = resources;
              this.#onChange();
            },
          },
          prompts: {
            onChanged: (err, prompts) => {
              if (err || !prompts || conn !== this.#conn || !conn.ready || conn.closed) return;
              conn.prompts = prompts;
              this.#onChange();
            },
          },
        },
      },
    );
    // A box server's root is /work, written out: pathToFileURL("/work") gives file:///C:/work on Windows (decision 8).
    const root = conn.local instanceof BoxStdio ? BOX_ROOTS : pathToFileURL(this.#root).href;
    client.setRequestHandler("roots/list", () => ({ roots: [{ uri: root }] }));
    // A form (Task 12). MCP's request names no call it belongs to, so it is a subagent's when every call running on this
    // server is that one subagent's, and otherwise the lead's (choice 29). The server's cancel of its request stops it.
    client.setRequestHandler("elicitation/create", (request, ctx) => {
      if (!this.#onForm) return { action: "decline" as const };
      const owners = new Set([...this.#calls].map((c) => c.owner));
      const [owner] = owners.size === 1 ? owners : [];
      return this.#onForm(request.params, { ...(owner && { owner }), signal: ctx.mcpReq.signal });
    });
    // A local server's end is its process's; a remote one's is a request that finds it gone (isDrop). Any other error
    // the library reports along the way is not fatal, and is passed over.
    // A ready box server's end asks Docker first whether the box still runs: if not, the box stopped (decision 7). A
    // stop's own close asks nothing.
    client.onclose = () => {
      const local = conn.local;
      if (!(local instanceof BoxStdio)) {
        if (local) this.#dropped(conn, () => exitReason(local));
        return;
      }
      if (conn !== this.#conn || !conn.ready || conn.closed) return;
      void this.#box!.state
        .gone()
        .catch(() => undefined)
        .then((gone) => this.#dropped(conn, () => (gone === undefined ? exitReason(local) : BOX_STOPPED)));
    };
    client.onerror = (err) => {
      if (conn.signs && UnauthorizedError.isInstance(err)) this.#lostSignIn(conn);
      else if (!conn.local && isDrop(err)) this.#dropped(conn, () => remoteReason(this.#address(), err));
    };
    return client;
  }

  // A ready connection whose checked fetch refused (8c-2b plan, Step 9; decision 13a; the step's code review): every
  // later request of it would be refused too, a sign-in's refresh among them, so the server fails with the refusal,
  // its connection closed, as a drop's is, and the call or read is told the same. Gives the refusal back to throw.
  #refusedOn(conn: Conn, refused: SiteRefused): SiteRefused {
    if (conn !== this.#conn || !conn.ready || conn.closed) return refused;
    this.#state = { is: "failed", reason: refused.message };
    setImmediate(() => void this.#close(conn));
    this.#onChange();
    return refused;
  }

  // A ready server's sign-in that no longer holds: `needs sign-in`, its connection closed, as a drop's is (#dropped).
  #lostSignIn(conn: Conn): void {
    if (conn !== this.#conn || !conn.ready || conn.closed) return;
    this.#state = { is: "needs sign-in" };
    setImmediate(() => void this.#close(conn));
    this.#onChange();
  }

  // A ready server that exits or drops is stopped, with its reason (choices 5, 6), its connection closed; a remote one
  // gets one new connection for this drop (choice 13). The reason is read only then: a process that never started has no
  // exit to tell. The connection is closed once the request that found the drop has its own error, as the client's close
  // would fail it with "Connection closed" first, and NotReached reads that error; any other call still waiting then
  // fails as closed, as it may have reached the server.
  #dropped(conn: Conn, reason: () => string): void {
    if (conn !== this.#conn || !conn.ready || conn.closed) return;
    this.#state = { is: "stopped", reason: reason(), retry: !conn.local };
    setImmediate(() => void this.#close(conn));
    this.#onChange();
  }

  // Choice 3: the client's close ends a local server's input, and 300 ms later one still running is killed, on Windows
  // with its tree (taskkill /T), elsewhere alone, as the library starts it outside a group of its own. The library's own
  // close would wait 2 s, then SIGTERM, 2 s, then SIGKILL, and never takes children. killTree kills only a process whose
  // exit Node has not seen, so a pid Windows has given to another program is never hit.
  // Begun a tick later, so `closed` is set before the client's close can report back through onclose.
  // A box server's process here is its `docker exec`, and killing that leaves the server running in the box, so one
  // still running after the 300 ms has its group killed in the box first (design, "Stop"); a kill that fails is kept in
  // the name's record (decision 24). With `exit`, its `docker exec` is ended at once, as removing the box ends the
  // server (decision 6). The `docker exec` is ended alone, never with killTree: it has no tree of its own to take, and
  // on Windows taskkill /T blocks for 2-4 s (src/sandbox/docker.ts, choice 125), which would hold every exit. It gets
  // SIGKILL, as killTree sends, since a client that catches SIGTERM would have the library's close wait 2 s twice.
  // A box server's whole close, the 300 ms included, is one of its name's pending stops until any failed kill is
  // recorded, so a start of the name waits for it (#connect; decision 24, as built). A process not yet spawned, as when
  // a second Reconnect closes the first's copy at once, is waited for before the client's close, which would forget
  // it: until then there is no child to read, and its group would go unkilled (the review of the PR review's fix).
  #close(conn: Conn, exit = false): Promise<void> {
    if (conn.closed) return conn.closed;
    conn.closed = Promise.resolve().then(async () => {
      await conn.local?.started;
      const closing = conn.client.close().catch(() => {});
      const child = conn.local?.child;
      const boxed = conn.local instanceof BoxStdio ? conn.local : undefined;
      if (child && alive(child)) {
        const exited = () => new Promise((resolve) => child.once("exit", resolve));
        if (!(boxed && exit)) await Promise.race([exited(), sleep(KILL_MS)]);
        if (boxed && !exit && alive(child)) {
          const box = this.#box!; // a BoxStdio is made only with a box
          const reason = await killInBox(box.run, box.id, boxed.group);
          if (reason !== undefined) this.#unstopped.push({ group: boxed.group, reason });
        }
        if (alive(child)) {
          if (boxed) child.kill("SIGKILL");
          else killTree(child);
        }
      }
      await closing;
      this.#retiring.delete(conn);
    });
    if (conn.local instanceof BoxStdio) {
      const closed = conn.closed;
      this.#pendingStops.add(closed);
      const done = () => this.#pendingStops.delete(closed);
      void closed.then(done, done); // gone either way, so a close that failed never holds a start
    }
    return conn.closed;
  }

  // Why a start failed; whatever came from the server or the system is escaped (plan, "Rules for every task").
  #startReason(conn: Conn, err: unknown): string {
    const local = conn.local;
    if (local?.spawnError !== undefined) return `${visible(this.#command())} could not start (${visible(errorText(local.spawnError), { tabs: true })})`;
    // The box's inner script says so when the command is not in the box (decision 3).
    if (local instanceof BoxStdio && local.child?.exitCode === 127 && lastLine(local.errors) === NOT_FOUND) {
      return notFoundLine(visible(this.#command()));
    }
    if (local?.child && !alive(local.child)) return exitReason(local);
    // Its fetch's words for a redirect it refused (8c-2a plan, decision 17), read from the connection: an sse server's
    // event stream keeps only the message of what its fetch threw (the eventsource package's flattenError).
    if (conn.redirected) return conn.redirected.message;
    if (err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout) return this.#late();
    if (!local) return remoteReason(this.#address(), err);
    return visible(errorText(err), { tabs: true });
  }

  // In seconds, as the limit is said; a test's limit that is not whole shows as a decimal, such as 0.5.
  #late = () => `it did not answer within ${this.#startMs / 1000} s`;
  // A request's limit, as callTool's comment says.
  #limit = () => {
    const entry = this.config.entry;
    return entry.kind === "stdio" ? (entry.timeout ?? MAX_TIMER_MS) : Math.max(entry.timeout ?? 0, REMOTE_MS);
  };
  #command = () => (this.config.entry.kind === "stdio" ? this.config.entry.command : "");
  // The address's scheme, host and port only: a ${VAR} filled into its path or query may be a key, and the reason is
  // shown on screen.
  #address = () => (this.config.entry.kind === "stdio" ? "" : new URL(this.config.entry.url).origin);
}

// A red line's reason for a helper that failed, choice 5's `<why>` after its prefix (8c-2a plan, Task 9).
const helperFailed = (why: string) => `its headersHelper failed: ${why}`;

// Whether headers hold an Authorization header, in any letter case (choice 55).
const hasAuthorization = (headers: Record<string, string>) =>
  Object.keys(headers).some((k) => k.toLowerCase() === "authorization");

// The statuses fetch follows as redirects (the Fetch standard, "redirect status").
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

// A redirect to another origin answering a request with the entry's headers (8c-2a plan, Task 10), its words naming the
// origin alone, as a path or a query can hold a key (decision 28).
export class Redirected extends Error {}

// Each remote connection's own fetch (8c-2a plan, Task 10; decisions 17 and 27).
// - The server's own address is its scheme, host, port and path, the query aside (a request there is the server's
//   whatever it asks; choice 54), or an sse server's endpoint, counted only at the entry's own origin, as the library
//   keeps a foreign one it refused.
// - With sign-in, the entry's headers go on requests for that address alone, so a sign-in service at the same host gets
//   none; a header the library set, the sign-in's Authorization among them, is kept. Without it, every request carries
//   them, in the transport's requestInit.
// - A request carrying them is sent with redirect "manual", and a redirect to another origin fails before anything is
//   sent there. One within the origin is left to the library, which follows it only when it keeps the method (choice 1
//   (b)), each hop a call of this fetch with the request's very headers object (its fetchWithinOrigin passes a shallow
//   copy of the init). Such a hop is that request: with sign-in it gets the headers too, and its status is heard. Only
//   that request's own chain counts, never a lasting list of places, so any other call to that path, a sign-in
//   request's among them, is not a hop.
// `answered` hears each status the server's own address or a hop answered to a POST of one request, a tools/call,
// resources/read or prompts/get (ASKED), whoever asks, a hop judged by the same body; never a list, an
// initialize, a notification, a GET for the event stream or a DELETE ending the session: a server may refuse those
// whatever the headers, and each new connection, asking again, would start another refresh (Task 11's review and
// re-check). `redirected` hears each redirect refused.
export function connectionFetch(opts: {
  url: URL;
  endpoint: () => URL | undefined;
  headers: Record<string, string>;
  signs: boolean;
  answered(status: number): void;
  redirected?(err: Redirected): void;
  // In place of Node's own: the connection's checked fetch with the allowed sites (8c-2b plan, Step 9).
  fetch?: FetchLike;
}): FetchLike {
  const { url, endpoint, headers, signs } = opts;
  // Node's own is read at each request, as before (the step's code review).
  const fetch: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const place = (u: URL) => `${u.origin}${u.pathname}`;
  const chains = new WeakMap<object, Set<string>>(); // by a request's headers object, the places it was sent on to
  const carried = Object.keys(headers).length > 0;
  const withEntry = (given: HeadersInit | undefined) => {
    const sent = new Headers(given);
    for (const [name, value] of Object.entries(headers)) if (!sent.has(name)) sent.set(name, value);
    return sent;
  };
  return async (input, init) => {
    const at = new URL(input);
    const own = endpoint();
    const key = init?.headers;
    const hop = key !== undefined && chains.get(key)?.has(place(at)) === true;
    const mine = place(at) === place(url) || (own?.origin === url.origin && place(at) === place(own)) || hop;
    const carries = carried && (mine || !signs);
    if (!mine && !carries) return fetch(input, init);
    const sent = carries ? { ...init, redirect: "manual" as const, ...(signs && { headers: withEntry(key) }) } : init;
    const answer = await fetch(input, sent);
    const location = REDIRECTS.has(answer.status) ? answer.headers.get("location") : null;
    const target = location === null ? null : URL.parse(location, at);
    if (target && target.origin !== at.origin && carries) {
      await answer.body?.cancel();
      const err = new Redirected(
        `the server answered with a redirect to ${target.origin}; ` +
          "Tachikoma does not follow a redirect with the entry's headers",
      );
      opts.redirected?.(err);
      throw err;
    }
    if (target && target.origin === at.origin && mine && key !== undefined) {
      let chain = chains.get(key);
      if (!chain) chains.set(key, (chain = new Set()));
      chain.add(place(target));
    }
    if (mine && init?.method?.toUpperCase() === "POST" && asked(init.body)) opts.answered(answer.status);
    return answer;
  };
}

const ASKED = new Set(["tools/call", "resources/read", "prompts/get"]);

// A body that is one JSON-RPC request of a method in ASKED (connectionFetch).
function asked(body: unknown): boolean {
  if (typeof body !== "string") return false;
  try {
    const m = JSON.parse(body);
    return typeof m === "object" && m !== null && !Array.isArray(m) && m.id !== undefined && ASKED.has(m.method);
  } catch {
    return false;
  }
}

// Choice 6: the exit code, with the last line of the error output that is not blank (choice 5), or the signal.
function exitReason(local: Stdio): string {
  const { exitCode, signalCode } = local.child!;
  if (exitCode === null) return `it was ended by signal ${signalCode}`;
  const line = lastLine(local.errors);
  return line ? `it exited with code ${exitCode}: ${visible(line, { tabs: true })}` : `it exited with code ${exitCode}`;
}

// A stack line as Node prints one: "at " and a place ending :line:col, perhaps in brackets, or a place without one; and
// the line standing for the stack lines an error shares with its cause.
const STACK = /^at .*(:\d+:\d+\)?|\((<anonymous>|native|index \d+)\))$/;
const SHARED = /^\.\.\. \d+ lines? matching cause stack trace \.\.\.$/;
const stackLine = (line: string) => STACK.test(line) || SHARED.test(line);

// The last line that is not blank, Node's own closing lines passed over, so a crashed Node server's reason is its error
// (choice 5; the user's choices, 2026-11-10, Task 4's review and its re-check): a last "Node.js v<version>"; the block of
// the error's fields (errno, code, cause, with the cause's own stack and block) that Node prints after the stack, from
// its closing "}" back to the last stack line, which ends " {"; then the stack. A block that does not open on a stack
// line is not Node's, and is kept.
function lastLine(errors: string): string | undefined {
  const lines = errors.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (/^Node\.js v\d/.test(lines.at(-1) ?? "")) lines.pop();
  if (lines.at(-1) === "}") {
    let depth = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (line.startsWith("}")) depth++;
      else if (line.endsWith("{")) depth--;
      if (depth > 0) continue;
      if (line.endsWith(" {") && stackLine(line.slice(0, -2))) lines.length = i;
      break;
    }
  }
  while (lines.length && stackLine(lines.at(-1)!)) lines.pop();
  return lines.at(-1);
}

// The status a remote server answered, or the library's words, with a refused connection's own reason (connectReason).
function remoteReason(address: string, err: unknown): string {
  if (err instanceof SdkHttpError && typeof err.status === "number") return `${address} answered ${err.status}`;
  return visible(err instanceof Error ? connectReason(err) : String(err), { tabs: true });
}

// The 401 or 403 a remote request's own answer was, from the streamable HTTP transport's error: its status, or its
// InsufficientScopeError, thrown only at a 403 (decision 26). The SSE transport's error has it only in its words
// (decision 18), so none is read from it.
function refusedWith(err: unknown): number | undefined {
  if (InsufficientScopeError.isInstance(err)) return 403;
  return err instanceof SdkHttpError && (err.status === 401 || err.status === 403) ? err.status : undefined;
}

// A remote server is gone when a request cannot reach it (fetch's TypeError, the Fetch standard's network error), when it
// no longer knows the session (404: MCP's Streamable HTTP transport, "Session Management", has the client start a new
// one; a 404 for the optional event stream is left out, as a server without one may answer so), or when an sse server's
// event stream fails (the library's SseError).
const lostSession = (err: unknown) => err instanceof SdkHttpError && err.status === 404 && err.code !== SdkErrorCode.ClientHttpFailedToOpenStream;
const isDrop = (err: Error) => err instanceof TypeError || err instanceof SseError || lostSession(err);

// Of those, the ones whose request never reached the server (choice 13): the session it no longer knows, and a refused
// connection, which fetch's TypeError says by its cause's code (an AggregateError of one try per address carries it
// too, for localhost; seen 2026-11-10). A connection cut after the request was sent says UND_ERR_SOCKET instead.
function notReached(err: unknown): boolean {
  if (lostSession(err)) return true;
  if (!(err instanceof TypeError)) return false;
  const seen = new Set<unknown>(); // a chain that loops back on itself would never end
  for (let e: unknown = err.cause; e instanceof Error && !seen.has(e); e = e.cause) {
    seen.add(e);
    if ((e as NodeJS.ErrnoException).code === "ECONNREFUSED") return true;
  }
  return false;
}
