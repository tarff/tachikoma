import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type AuthorizationServerMetadata,
  auth,
  isSpecType,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  OAuthError,
  RegistrationRejectedError,
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

// What is kept for one server: the client the service registered, and its tokens.
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

// A file in the user's home named from `~`, with the system's separators, as shownFile() names the settings file.
function shown(file: string, home = os.homedir()): string {
  const inside = path.relative(home, file);
  return inside && !inside.startsWith("..") && !path.isAbsolute(inside) ? path.join("~", inside) : file;
}

// `<data folder>/mcp-auth.json`, private, changed under its lock, as chatgpt.json is without --keychain (choice 28):
// `{ "servers": [{ "name", "url", "client", "tokens" }] }`, a row per server by its name and its whole address, so a
// server's tokens are never sent to a new address under an old name. A file that is not JSON in that shape counts as
// holding none, and `damaged` gets its line once, the file never quoted, as it holds tokens (choice 57); the next sign-in
// writes a new one. What it held is a sign-in again.
export class AuthStore {
  readonly file: string;
  readonly lockFile: string;
  #said = false;

  // `warn` gets readPrivate's notice that it made the file private.
  constructor(
    dir: string = dataDir(),
    private readonly warn: (message: string) => void = () => {},
    private readonly damaged: (line: string) => void = () => {},
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
      this.#said = false; // a file damaged again later is said again
    });
  }

  // No file, as before any sign-in, is read without readPrivate's folder check, which starts PowerShell on Windows, as the
  // project's answers are (answers.ts): every remote server's requests ask for their tokens.
  #rows(): unknown[] {
    if (!lstatSync(this.file, { throwIfNoEntry: false })) return [];
    const text = readPrivate(this.file, this.warn);
    if (text === null) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (isObject(parsed) && Array.isArray(parsed.servers)) return parsed.servers;
    if (!this.#said) {
      this.#said = true;
      this.damaged(`MCP sign-ins in ${visible(shown(this.file))} could not be read, so they were left out; signing in again replaces them.`);
    }
    return [];
  }
}

// A server that answered 401 but publishes no sign-in details, so it cannot be signed in to: its start fails with its
// 401, not `needs sign-in` (choice 59).
export class NoSignIn extends Error {}

// What a sign-in needs from the window: its yes or no to opening the browser, the browser, its grey line, and Esc.
export interface SignInIO {
  ask(question: string): Promise<boolean>;
  openBrowser(url: string): void;
  say(line: string): void;
  signal: AbortSignal;
}

// The redirect address outside a sign-in, which nothing then registers or opens: the library asks for one to tell an
// interactive client from one that signs in by itself.
const NOT_SIGNING_IN = "http://localhost/callback";
// Choice 59's reason for a service that registers no clients when the entry gives no id.
const NEEDS_CLIENT_ID = 'the sign-in service needs a client id; set "oauth": {"clientId": ...} in the server\'s entry';
// Choice 60's, for a service that registers only apps it approved (Figma's answers 403); Tachikoma registers under its
// own name only.
const REFUSED = 'the sign-in service refused to register Tachikoma (403), as it takes only apps it approved; a client id it gives you goes in "oauth": {"clientId": ...} in the server\'s entry';

// The library's warnings ("[mcp-sdk] ..."), on a refresh refused or failed, go to console.warn, which would draw over the
// window; they are dropped, as the server's state and the sign-in's lines say what happened (Task 11's review). The
// library has no logger to give, and the window's Ink puts its own console.warn in place as it starts, so the filter is
// put over whatever console.warn is at each sign-in step the library takes (discoveryState, its first call), once.
const QUIET = Symbol("tachikoma's filter of the MCP library's warnings");
function quiet(): void {
  const warn = console.warn as typeof console.warn & { [QUIET]?: true };
  if (warn[QUIET]) return;
  const filtered = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("[mcp-sdk] ")) return;
    warn.apply(console, args);
  };
  console.warn = Object.assign(filtered, { [QUIET]: true as const });
}

// One remote server's OAuth client, handed to its transport as `authProvider`; only an entry without an Authorization
// header has one, as an entry with its own is never signed in (choice 55); its other headers go only to the server's own
// address, never to a sign-in service (choice 54).
// At the launch and every request the library sends its saved access token, and on a 401 refreshes it (saved through
// saveTokens) or, with nothing to refresh, asks to open the browser: this one does nothing then, so the start ends in
// UnauthorizedError, `needs sign-in`, and the launch never waits (design, "Remote servers and sign-in"). Nor does it
// register a client, so registration is for the address a sign-in waits at. A sign-in has a client of its own
// (`attempt`), so a request's refresh meanwhile never changes its code verifier. The code verifier and the discovery state
// are kept in memory only, as one sign-in's.
export class McpAuth implements OAuthClientProvider {
  readonly #store: AuthStore;
  readonly #config: ServerConfig;
  readonly #name: string;
  readonly #url: string;
  readonly #oauth: OAuthEntry | undefined;
  readonly #attempt: { redirect: string; state: string; to?: URL } | undefined; // a sign-in's own, its address and state
  #verifier = "";
  #discovery: OAuthDiscoveryState | undefined;
  #refreshRead: string | undefined; // the refresh token last read, so a refused one drops only itself (invalidateCredentials)

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

  // The entry's clientId wins, for the sign-in service the library found (choice 59). Else the client registered before:
  // during a sign-in, not one registered for another address (an earlier sign-in's free port), so it registers again; at
  // the launch, not one of another sign-in service, as nothing registers in its place there (choice 59). Outside a
  // sign-in, none is UnauthorizedError: `needs sign-in`. A sign-in with none, at a service that registers no clients, says
  // the entry needs a clientId (choice 59).
  clientInformation(ctx?: OAuthClientInformationContext): StoredOAuthClientInformation | undefined {
    const id = this.#oauth?.clientId;
    if (id !== undefined) return { client_id: id, ...(ctx && { issuer: ctx.issuer }) };
    const client = this.#store.get(this.#name, this.#url)?.client;
    const given = client && "redirect_uris" in client && Array.isArray(client.redirect_uris) ? client.redirect_uris : undefined;
    if (this.#attempt) {
      if (client && !(given && !given.includes(this.#attempt.redirect))) return client;
      if (!this.#discovery?.authorizationServerMetadata?.registration_endpoint) throw new Error(NEEDS_CLIENT_ID);
      return undefined;
    }
    if (!client || (ctx && client.issuer !== undefined && client.issuer !== ctx.issuer)) throw new UnauthorizedError();
    return client;
  }

  saveClientInformation(client: StoredOAuthClientInformation): Promise<void> {
    return this.#store.change(this.#name, this.#url, (kept) => ({ ...kept, client }));
  }

  // Only the library's sign-in steps pass `ctx`, a refresh among them; a plain request's read leaves #refreshRead alone, so
  // it cannot move the guard onto another window's newer refresh token (Task 11's re-check).
  tokens(ctx?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
    const tokens = this.#store.get(this.#name, this.#url)?.tokens;
    if (ctx) this.#refreshRead = tokens?.refresh_token;
    return tokens;
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

  // The library found no sign-in service's metadata: nothing to sign in to (choice 59).
  saveDiscoveryState(state: OAuthDiscoveryState): void {
    if (!state.authorizationServerMetadata) throw new NoSignIn();
    this.#discovery = state;
  }

  // The library's first call of each sign-in step. The entry's authServerMetadataUrl gives the service's metadata in place
  // of discovery (choice 58), read without the entry's headers; one that cannot be read, or is not OAuth's metadata, is a
  // server with no sign-in details.
  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    quiet();
    const at = this.#oauth?.authServerMetadataUrl;
    if (this.#discovery || at === undefined) return this.#discovery;
    // One that cannot be reached (no such host, refused, a redirect) is the same: not the server's own failure.
    const res = await fetch(at, { headers: { accept: "application/json" }, redirect: "error" }).catch(() => undefined);
    const metadata: unknown = res?.ok ? await res.json().catch(() => undefined) : undefined;
    if (!isSpecType.OAuthMetadata(metadata) && !isSpecType.OpenIdProviderDiscoveryMetadata(metadata)) throw new NoSignIn();
    const found = metadata as AuthorizationServerMetadata;
    return (this.#discovery = { authorizationServerUrl: found.issuer, authorizationServerMetadata: found });
  }

  // What the library finds no longer valid: tokens a refresh was refused for, a client the service no longer knows.
  // Tokens are dropped only while they are the ones this client read, so a refresh another window won since is kept.
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "verifier" || scope === "all") this.#verifier = "";
    if (scope === "discovery" || scope === "all") this.#discovery = undefined;
    if (scope === "all") await this.forget();
    else if (scope === "client") await this.#store.change(this.#name, this.#url, ({ tokens }) => ({ tokens }));
    else if (scope === "tokens") {
      await this.#store.change(this.#name, this.#url, (kept) => (kept.tokens?.refresh_token === this.#refreshRead ? { client: kept.client } : kept));
    }
  }

  // Whether tokens are kept for this server: Sign out applies then; a client registered without them is not a sign-in
  // (choice 58).
  get kept(): boolean {
    try {
      return this.#store.get(this.#name, this.#url)?.tokens !== undefined;
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

  // Sign in (choice 28; "Lines this plan adds"): Tachikoma's address waits first, Claude Code's
  // http://localhost:<port>/callback on a free port or the entry's callbackPort (choice 53), so the client registers for
  // it; the library finds the sign-in page, which the question names by its host; on a yes the browser opens and the grey
  // line gives the address; the code that comes back is exchanged, its tokens saved. True when signed in; false on a no.
  // Esc stops every wait; a refresh that works needs no browser.
  async signIn(io: SignInIO): Promise<boolean> {
    const state = randomBytes(32).toString("base64url");
    const fixed = this.#oauth?.callbackPort;
    let listener: Awaited<ReturnType<typeof listen>>;
    try {
      listener = await listen(state, io.signal, { port: fixed ?? 0 });
    } catch (err) {
      if (fixed !== undefined && (err as NodeJS.ErrnoException).code === "EADDRINUSE") throw new Error(`port ${fixed}, the entry's callbackPort, is in use`);
      throw err;
    }
    const attempt: { redirect: string; state: string; to?: URL } = { redirect: listener.redirectUri, state };
    const client = new McpAuth(this.#store, this.#config, attempt);
    const scope = this.#oauth?.scopes ? { scope: this.#oauth.scopes } : {};
    try {
      const first = stoppable(auth(client, { serverUrl: this.#url, ...scope }), io.signal).catch((err: unknown) => {
        throw err instanceof RegistrationRejectedError && err.status === 403 ? new Error(REFUSED) : err;
      });
      if ((await first) === "AUTHORIZED") return true;
      const to = attempt.to!;
      if (!(await io.ask(`Open your browser to sign in to ${visible(this.#name)} at ${visible(to.host)}`))) return false;
      listener.begin(to.href);
      io.openBrowser(listener.startUri);
      io.say(`Waiting for the sign-in in your browser. If it did not open, go to: ${listener.startUri}`);
      const reply = await listener.reply;
      const error = reply.get("error");
      if (error) throw new OAuthError(error, reply.get("error_description") ?? error); // the service's own words
      const code = reply.get("code");
      if (!code) throw new Error("the sign-in page sent back no code");
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
