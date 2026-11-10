import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";
import {
  auth,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  OAuthError,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { withLock } from "../auth/lock.js";
import { listen } from "../auth/oauth.js";
import { privateDir, readPrivate, writePrivate } from "../auth/private.js";
import { dataDir } from "../core/datadir.js";
import { visible } from "../core/permissions.js";
import type { OAuthEntry, ServerConfig } from "./config.js";

// Signing in to remote MCP servers (release 8c plan, Task 11; design, "Remote servers and sign-in"): one OAuth client per
// server, through the library's own `auth`, which discovers the server's sign-in service, registers, refreshes and
// exchanges the code; Tachikoma keeps what it saves, asks before the browser opens, and takes the code at its own address.

// What is kept for one server: the client the service registered (or the entry's clientId stands for), and its tokens.
interface Kept { client?: StoredOAuthClientInformation; tokens?: StoredOAuthTokens }
interface Row extends Kept { name: string; url: string }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// A row of the file as this code writes it; anything else in the file is passed over and written back as it was.
const isRow = (v: unknown): v is Row =>
  isObject(v) &&
  typeof v.name === "string" &&
  typeof v.url === "string" &&
  (v.client === undefined || (isObject(v.client) && typeof v.client.client_id === "string")) &&
  (v.tokens === undefined || (isObject(v.tokens) && typeof v.tokens.access_token === "string" && typeof v.tokens.token_type === "string"));

// `<data folder>/mcp-auth.json`, private, changed under its lock, as chatgpt.json is without --keychain (choice 28):
// `{ "servers": [{ "name", "url", "client", "tokens" }] }`, a row per server by its name and its whole address, so a
// server's tokens are never sent to a new address under an old name. A file that is not JSON in that shape counts as
// holding none, and is never quoted, as it holds tokens; the next sign-in writes a new one. What it held is a sign-in
// again, as registration is dynamic, or the entry's clientId.
export class AuthStore {
  readonly file: string;
  readonly lockFile: string;

  // `warn` gets readPrivate's notice that it made the file private.
  constructor(
    dir: string = dataDir(),
    private readonly warn: (message: string) => void = () => {},
  ) {
    this.file = path.join(dir, "mcp-auth.json");
    this.lockFile = path.join(dir, "mcp-auth.lock");
  }

  // What is kept for the server `name` at `url`; throws readPrivate's refusals.
  get(name: string, url: string): Kept | undefined {
    return this.#rows().find((r) => isRow(r) && r.name === name && r.url === url) as Row | undefined;
  }

  // Under the lock, the server's row as `fn` gives it from the one read then, or none.
  change(name: string, url: string, fn: (kept: Kept) => Kept): Promise<void> {
    privateDir(path.dirname(this.file)); // the lock lives there too
    return withLock(this.lockFile, async () => {
      const rows = this.#rows();
      const at = rows.findIndex((r) => isRow(r) && r.name === name && r.url === url);
      const { client, tokens } = fn(at < 0 ? {} : (rows[at] as Row));
      const others = rows.filter((_, i) => i !== at);
      const servers = client || tokens ? [...others, { name, url, ...(client && { client }), ...(tokens && { tokens }) }] : others;
      writePrivate(this.file, `${JSON.stringify({ servers }, null, 2)}\n`);
    });
  }

  // No file, as before any sign-in, is read without readPrivate's folder check, which starts PowerShell on Windows, as the
  // project's answers are (answers.ts): every remote server's requests ask for their tokens.
  #rows(): unknown[] {
    if (!lstatSync(this.file, { throwIfNoEntry: false })) return [];
    const text = readPrivate(this.file, this.warn);
    if (text === null) return [];
    try {
      const parsed: unknown = JSON.parse(text);
      return isObject(parsed) && Array.isArray(parsed.servers) ? parsed.servers : [];
    } catch {
      return [];
    }
  }
}

// What a sign-in needs from the window: its yes or no to opening the browser, the browser, its grey line, and Esc.
export interface SignInIO {
  ask(question: string): Promise<boolean>;
  openBrowser(url: string): void;
  say(line: string): void;
  signal: AbortSignal;
}

// The redirect address outside a sign-in, which nothing then registers or opens: the library asks for one to tell an
// interactive client from one that signs in by itself.
const NOT_SIGNING_IN = "http://127.0.0.1/auth/callback";

// One remote server's OAuth client, handed to its transport as `authProvider`. At the launch and every request the
// library sends its saved access token, and on a 401 refreshes it (saved through saveTokens) or, with nothing to refresh,
// asks to open the browser: this one does nothing then, so the start ends in UnauthorizedError, `needs sign-in`, and the
// launch never waits (design, "Remote servers and sign-in"). Nor does it register a client, so registration is for the
// address a sign-in waits at. A sign-in has a client of its own (`attempt`), so a request's refresh meanwhile never
// changes its code verifier. The code verifier and the discovery state are kept in memory only, as one sign-in's.
export class McpAuth implements OAuthClientProvider {
  readonly #store: AuthStore;
  readonly #config: ServerConfig;
  readonly #name: string;
  readonly #url: string;
  readonly #oauth: OAuthEntry | undefined;
  readonly #attempt: { redirect: string; state: string; to?: URL } | undefined; // a sign-in's own, its address and state
  #verifier = "";
  #discovery: OAuthDiscoveryState | undefined;

  constructor(store: AuthStore, config: ServerConfig, attempt?: { redirect: string; state: string }) {
    if (config.entry.kind === "stdio") throw new Error("only a remote server signs in");
    this.#store = store;
    this.#config = config;
    this.#name = config.name;
    this.#url = config.entry.url;
    this.#oauth = config.entry.oauth;
    this.#attempt = attempt;
  }

  get redirectUrl(): string {
    return this.#attempt?.redirect ?? NOT_SIGNING_IN;
  }

  // A public client (no secret), asking for refresh tokens, and the entry's scopes when it gives them.
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Tachikoma",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.#oauth?.scopes && { scope: this.#oauth.scopes }),
    };
  }

  state(): string {
    return this.#attempt?.state ?? randomBytes(32).toString("base64url");
  }

  // The client registered before, or the entry's clientId. During a sign-in, one registered for another address (an
  // earlier sign-in's free port) is not used, so the service is not sent an address it was never given, and the client
  // registers again. Outside a sign-in, none is UnauthorizedError: `needs sign-in`, with nothing registered.
  clientInformation(): StoredOAuthClientInformation | undefined {
    const client = this.#store.get(this.#name, this.#url)?.client;
    const given = client && "redirect_uris" in client && Array.isArray(client.redirect_uris) ? client.redirect_uris : undefined;
    const usable = client && !(this.#attempt && given && !given.includes(this.#attempt.redirect));
    const info = usable ? client : this.#oauth?.clientId ? { client_id: this.#oauth.clientId } : undefined;
    if (!info && !this.#attempt) throw new UnauthorizedError();
    return info;
  }

  saveClientInformation(client: StoredOAuthClientInformation): Promise<void> {
    return this.#store.change(this.#name, this.#url, (kept) => ({ ...kept, client }));
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.#store.get(this.#name, this.#url)?.tokens;
  }

  saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    return this.#store.change(this.#name, this.#url, (kept) => ({ ...kept, tokens }));
  }

  // Kept for the sign-in, which asks before it opens the browser; outside one, nothing happens.
  redirectToAuthorization(to: URL): void {
    if (this.#attempt) this.#attempt.to = to;
  }

  saveCodeVerifier(verifier: string): void {
    this.#verifier = verifier;
  }

  codeVerifier(): string {
    return this.#verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.#discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.#discovery;
  }

  // What the library finds no longer valid: tokens a refresh was refused for, a client the service no longer knows.
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "verifier" || scope === "all") this.#verifier = "";
    if (scope === "discovery" || scope === "all") this.#discovery = undefined;
    if (scope === "all") await this.forget();
    else if (scope === "client") await this.#store.change(this.#name, this.#url, ({ tokens }) => ({ tokens }));
    else if (scope === "tokens") await this.#store.change(this.#name, this.#url, ({ client }) => ({ client }));
  }

  // Whether anything is kept for this server: Sign out applies then.
  get kept(): boolean {
    try {
      const k = this.#store.get(this.#name, this.#url);
      return k?.client !== undefined || k?.tokens !== undefined;
    } catch {
      return false;
    }
  }

  // Sign out: the server's tokens and client go, so the next start needs sign-in.
  async forget(): Promise<void> {
    this.#verifier = "";
    this.#discovery = undefined;
    await this.#store.change(this.#name, this.#url, () => ({}));
  }

  // Sign in (choice 28; "Lines this plan adds"): Tachikoma's address waits first, on a free port of 127.0.0.1 or the entry's
  // callbackPort, so the client registers for it; the library finds the sign-in page, which the question names by its
  // host; on a yes the browser opens and the grey line gives the address; the code that comes back is exchanged, its
  // tokens saved. True when signed in; false on a no. Esc stops every wait; a refresh that works needs no browser.
  async signIn(io: SignInIO): Promise<boolean> {
    const state = randomBytes(32).toString("base64url");
    const listener = await listen(state, io.signal, this.#oauth?.callbackPort ?? 0);
    const attempt: { redirect: string; state: string; to?: URL } = { redirect: listener.redirectUri, state };
    const client = new McpAuth(this.#store, this.#config, attempt);
    const scope = this.#oauth?.scopes ? { scope: this.#oauth.scopes } : {};
    try {
      if ((await stoppable(auth(client, { serverUrl: this.#url, ...scope }), io.signal)) === "AUTHORIZED") return true;
      const to = attempt.to!;
      if (!(await io.ask(`Open your browser to sign in to ${visible(this.#name)} at ${visible(to.host)}`))) return false;
      listener.begin(to.href);
      io.openBrowser(listener.startUri);
      io.say(`Waiting for the sign-in in your browser. If it did not open, go to: ${listener.startUri}`);
      const reply = await listener.reply;
      const error = reply.get("error");
      if (error) throw new OAuthError(error, reply.get("error_description") ?? error); // the service's own words
      const code = reply.get("code");
      if (!code) throw new UnauthorizedError();
      await stoppable(auth(client, { serverUrl: this.#url, authorizationCode: code, iss: reply.get("iss") ?? undefined, ...scope }), io.signal);
      return true;
    } finally {
      listener.close();
    }
  }
}

// The library's requests take no signal, so Esc stops the wait for them; one still going finishes with nothing waiting.
function stoppable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}
