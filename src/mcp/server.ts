import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  type CallToolResult,
  Client,
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
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { visible } from "../core/permissions.js";
import { connectReason, errorText } from "../core/types.js";
import { commandEnv, mcpProgram } from "../exec/env.js";
import { MAX_TOOL_OUTPUT } from "../exec/executor.js";
import { killTree, running } from "../exec/local.js";
import { MAX_TIMER_MS } from "../hooks/config.js";
import { type AuthStore, McpAuth, NoSignIn, type SignInIO } from "./auth.js";
import { Checker } from "./checker.js";
import type { ServerConfig } from "./config.js";

// One MCP server's connection, local or remote, through the library's own transports (release 8c plan, Task 4; choice 2).
// `Tool` is the library's tool, as tools/list sends it, each description whole: the views cut their own copies.
export type State =
  | { is: "starting" } | { is: "ready"; tools: Tool[] } | { is: "failed"; reason: string }
  | { is: "stopped"; reason: string; retry: boolean } // retry: a remote one whose connection dropped, not yet tried again since this drop (choices 13, 33)
  | { is: "needs sign-in" } | { is: "waiting for your yes" } | { is: "you said no" } | { is: "off" };

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

  override async start(): Promise<void> {
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
  }
}

interface Conn {
  client: Client;
  transport: Transport;
  local?: Stdio;
  ready: boolean;
  closed?: Promise<void>; // set once closing has begun, by a stop, a failed start or a drop
}

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

  // `startMs` is the start's limit, 30 s unless a test gives a short one. `auth` keeps sign-ins: with it a remote server
  // has its own OAuth client (Task 11), unless its entry has headers of its own, which is never signed in, so its 401 says
  // to look at its key (choice 55); without it, as in most tests, a 401 is an answer like any other.
  constructor(config: ServerConfig, opts: { root: string; env: NodeJS.ProcessEnv; auth?: AuthStore; onChange(): void; startMs?: number }) {
    this.config = config;
    this.#root = opts.root;
    this.#env = opts.env;
    this.#onChange = opts.onChange;
    this.#startMs = opts.startMs ?? START_MS;
    const signs = opts.auth && config.entry.kind !== "stdio" && !Object.keys(config.entry.headers).length;
    this.#auth = signs ? new McpAuth(opts.auth!, config) : undefined;
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
  // place of these: an mcp_tool hook's, whose own time limit ends its call (hooks/run.ts).
  async callTool(name: string, args: object, opts: { signal?: AbortSignal; timeout?: number }): Promise<CallToolResult> {
    const conn = this.#conn;
    if (!conn?.ready || conn.closed || this.#state.is !== "ready") throw new Error("Not connected"); // stopped: not closed yet
    const entry = this.config.entry;
    const timeout = opts.timeout ?? (entry.kind === "stdio" ? (entry.timeout ?? MAX_TIMER_MS) : Math.max(entry.timeout ?? 0, REMOTE_MS));
    try {
      return await conn.client.callTool({ name, arguments: args as Record<string, unknown> }, { signal: opts.signal, timeout });
    } catch (err) {
      if (!conn.local && notReached(err)) throw new NotReached(remoteReason(this.#address(), err), { cause: err });
      // A sign-in lost mid-session: a refused refresh, a Sign out in another window (choice 59).
      if (this.#auth && UnauthorizedError.isInstance(err)) {
        this.#lostSignIn(conn);
        throw new Error(needsSignIn(this.config.name), { cause: err });
      }
      throw err;
    }
  }

  // At Tachikoma's exit, a restart or a removal (choice 3).
  async stop(): Promise<void> {
    if (this.#conn) await this.#close(this.#conn);
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
    this.#connection++;
    this.#state = { is: "starting" };
    const made = this.#transport();
    if (typeof made === "string") {
      this.#state = failed(made);
      return false;
    }
    const conn: Conn = { transport: made, client: undefined as unknown as Client, ready: false };
    if (made instanceof Stdio) conn.local = made;
    conn.client = this.#client(conn);
    // One still open, as when two Reconnects come close together, is closed first, so only one server runs; its own start
    // then finds it closed and leaves the state to this one (release 8c plan, Task 10's quality review).
    const prev = this.#conn;
    if (prev && !prev.closed) void this.#close(prev);
    this.#conn = conn;

    // The library's own limit on each request is passed too, so neither falls back to its 60 s.
    const work = (async () => {
      await conn.client.connect(made, { timeout: this.#startMs });
      return (await conn.client.listTools(undefined, { timeout: this.#startMs })).tools;
    })();
    work.catch(() => {}); // a late answer, or the close at the limit, comes after the race below is settled
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), this.#startMs)));
    let reason: string | undefined;
    let signIn = false;
    let tools: Tool[] = [];
    try {
      const got = await Promise.race([work, late]);
      if (got === "late") reason = this.#late();
      else tools = got;
    } catch (err) {
      // A start the server refused for want of a sign-in, which only /mcp starts (Task 11); one that publishes no sign-in
      // details keeps its 401 (choice 59).
      if (this.#auth && UnauthorizedError.isInstance(err)) signIn = true;
      else reason = err instanceof NoSignIn ? `${this.#address()} answered 401` : this.#startReason(conn, err);
    } finally {
      clearTimeout(timer);
    }
    if (conn.closed) return false; // stopped meanwhile: the stop's caller owns the state
    if (reason !== undefined || signIn) {
      this.#state = signIn ? { is: "needs sign-in" } : failed(reason!);
      await this.#close(conn);
      return false;
    }
    conn.ready = true;
    this.#instructions = conn.client.getInstructions();
    this.#state = { is: "ready", tools };
    return true;
  }

  // Local: the program by its full path (choice 4), with the commands' environment, which never holds Tachikoma's keys,
  // CLAUDE_PROJECT_DIR as Claude Code sets it, then the entry's env, in the project's folder (choice 2). Remote: the
  // entry's headers with each request, and its OAuth client (Task 11). A reason instead when the program is not on PATH.
  #transport(): Transport | string {
    const entry = this.config.entry;
    if (entry.kind === "stdio") {
      const program = mcpProgram(entry.command, this.#env);
      if (program === null) return `${visible(entry.command)} was not found on PATH`;
      const env = { ...commandEnv(this.#env), CLAUDE_PROJECT_DIR: this.#root, ...entry.env } as Record<string, string>;
      return new Stdio({ command: program, args: entry.args, env, cwd: this.#root, stderr: "pipe" });
    }
    const opts = { requestInit: { headers: entry.headers }, ...(this.#auth && { authProvider: this.#auth }) };
    const url = new URL(entry.url);
    return entry.kind === "http" ? new StreamableHTTPClientTransport(url, opts) : new SSEClientTransport(url, opts);
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
        },
      },
    );
    client.setRequestHandler("roots/list", () => ({ roots: [{ uri: pathToFileURL(this.#root).href }] }));
    client.setRequestHandler("elicitation/create", () => ({ action: "decline" as const })); // until Task 12's forms
    // A local server's end is its process's; a remote one's is a request that finds it gone (isDrop). Any other error
    // the library reports along the way is not fatal, and is passed over.
    client.onclose = () => {
      const local = conn.local;
      if (local) this.#dropped(conn, () => exitReason(local));
    };
    client.onerror = (err) => {
      if (this.#auth && UnauthorizedError.isInstance(err)) this.#lostSignIn(conn);
      else if (!conn.local && isDrop(err)) this.#dropped(conn, () => remoteReason(this.#address(), err));
    };
    return client;
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
  #close(conn: Conn): Promise<void> {
    conn.closed ??= Promise.resolve().then(async () => {
      const closing = conn.client.close().catch(() => {});
      const child = conn.local?.child;
      if (child && alive(child)) {
        await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(KILL_MS)]);
        if (alive(child)) killTree(child);
      }
      await closing;
    });
    return conn.closed;
  }

  // Why a start failed; whatever came from the server or the system is escaped (plan, "Rules for every task").
  #startReason(conn: Conn, err: unknown): string {
    const local = conn.local;
    if (local?.spawnError !== undefined) return `${visible(this.#command())} could not start (${visible(errorText(local.spawnError), { tabs: true })})`;
    if (local?.child && !alive(local.child)) return exitReason(local);
    if (err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout) return this.#late();
    if (!local) return remoteReason(this.#address(), err);
    return visible(errorText(err), { tabs: true });
  }

  // In seconds, as the limit is said; a test's limit that is not whole shows as a decimal, such as 0.5.
  #late = () => `it did not answer within ${this.#startMs / 1000} s`;
  #command = () => (this.config.entry.kind === "stdio" ? this.config.entry.command : "");
  // The address's scheme, host and port only: a ${VAR} filled into its path or query may be a key, and the reason is
  // shown on screen.
  #address = () => (this.config.entry.kind === "stdio" ? "" : new URL(this.config.entry.url).origin);
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
