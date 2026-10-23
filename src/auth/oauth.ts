import { createHash, createPublicKey, type JsonWebKey, randomBytes, verify } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";

// OpenAI's Sign in with ChatGPT for open-source tools, from its docs (developers.openai.com/siwc/
// token-sharing-open-source and its pages "sign-in", "accounts and sessions" and "token reference",
// read 2026-10-23). No code is copied from OpenAI's devkit, whose licence forbids commercial use.

export const ISSUER = "https://auth.openai.com";
export const RESOURCE = "https://api.openai.com/v1";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
// Identity scopes, then the plan-use scopes (sign-in page, `scope` row).
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
// The first-time registration entry point. Never saved and never used to exchange a code.
export const FIRST_CLIENT = "dynamic_agent_client";
const APP_NAME = "Tachikoma";

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const EndpointsSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  jwks_uri: z.string(),
  revocation_endpoint: z.string(),
});
export type Endpoints = z.infer<typeof EndpointsSchema>;

// The docs say to load the endpoints from OpenAI's discovery document.
export async function discover(issuer = ISSUER, signal?: AbortSignal): Promise<Endpoints> {
  const res = await fetch(`${issuer}/.well-known/openid-configuration`, { signal });
  if (!res.ok) throw new OAuthError(`Could not read OpenAI's sign-in settings (HTTP ${res.status})`, undefined, res.status);
  const ep = EndpointsSchema.parse(await res.json());
  if (ep.issuer !== issuer) throw new OAuthError(`OpenAI's sign-in settings name the wrong issuer (${ep.issuer})`);
  return ep;
}

// 32 random bytes, as RFC 7636 (section 4.1) recommends for the PKCE verifier; used for state and
// nonce too.
const random = () => randomBytes(32).toString("base64url");

export function newAttempt(): { verifier: string; challenge: string; state: string; nonce: string } {
  const verifier = random();
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url"), state: random(), nonce: random() };
}

export function authorizeUrl(
  ep: Endpoints,
  p: { clientId: string; hostId: string; redirectUri: string; state: string; nonce: string; challenge: string; idTokenHint?: string; loginHint?: string },
): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    response_type: "code",
    redirect_uri: p.redirectUri,
    scope: SCOPES,
    resource: RESOURCE,
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    ext_agent_host_id: p.hostId,
  });
  // The app's name goes only on the first registration; a returning sign-in sends the hints instead.
  if (p.clientId === FIRST_CLIENT) q.set("agent_name_hint", APP_NAME);
  if (p.idTokenHint) q.set("id_token_hint", p.idTokenHint);
  if (p.loginHint) q.set("login_hint", p.loginHint);
  return `${ep.authorization_endpoint}?${q}`;
}

// The page the browser lands on. It loads nothing from anywhere (`default-src 'none'`).
const PAGE = "<!doctype html><meta charset=utf-8><title>Tachikoma</title><p>You can close this tab. Tachikoma shows whether sign-in worked.</p>";

export interface Listener {
  redirectUri: string;
  // The address to open or print. It sends the browser on to the authorize address set by `begin`, so
  // the ID token sent as a hint never shows on screen or in the list of running programs.
  startUri: string;
  begin(authorizeUrl: string): void;
  reply: Promise<URLSearchParams>;
  close(): void;
}

// Waits on 127.0.0.1, on any free port, at /auth/callback: the docs require that address form and
// rule out `localhost`. A reply with another attempt's state is turned away and the wait goes on; the
// first matching reply ends it, and the listener closes.
export async function listen(state: string, signal?: AbortSignal): Promise<Listener> {
  let settle!: { resolve: (q: URLSearchParams) => void; reject: (e: Error) => void };
  const reply = new Promise<URLSearchParams>((resolve, reject) => (settle = { resolve, reject }));
  let target: string | undefined;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/auth/start" && target) return void res.writeHead(302, { location: target, "cache-control": "no-store" }).end();
    if (req.method !== "GET" || url.pathname !== "/auth/callback") return void res.writeHead(404).end();
    if (url.searchParams.get("state") !== state) return void res.writeHead(400, { "content-type": "text/plain" }).end("This reply is not for the sign-in Tachikoma is waiting for.");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'", "cache-control": "no-store" }).end(PAGE);
    settle.resolve(url.searchParams);
    close();
  });
  const close = () => {
    server.close();
    server.closeIdleConnections();
    signal?.removeEventListener("abort", onAbort);
  };
  const onAbort = () => {
    settle.reject(new OAuthError("Sign-in was cancelled"));
    close();
  };
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth`;
  return { redirectUri: `${base}/callback`, startUri: `${base}/start`, begin: (url) => (target = url), reply, close };
}

// The token reference page lists these fields. `earliest_refresh_at` is kept as sent (see store.ts).
const TokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  id_token: z.string().optional(),
  expires_in: z.number(),
  scope: z.string(),
  earliest_refresh_at: z.unknown().optional(),
});
export type TokenResponse = z.infer<typeof TokenSchema>;

// A form POST to an OpenAI sign-in endpoint. Errors carry OpenAI's code, never a token.
async function post(url: string, form: Record<string, string>, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form), signal });
  if (res.ok) return res;
  let code: string | undefined;
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") code = body.error;
  } catch {
    // not JSON
  }
  throw new OAuthError(`OpenAI refused the request (HTTP ${res.status}${code ? `, ${code}` : ""})`, code, res.status);
}

async function tokens(ep: Endpoints, form: Record<string, string>, signal?: AbortSignal): Promise<TokenResponse> {
  return TokenSchema.parse(await (await post(ep.token_endpoint, { ...form, resource: RESOURCE }, signal)).json());
}

export function exchange(ep: Endpoints, p: { clientId: string; code: string; verifier: string; redirectUri: string }, signal?: AbortSignal): Promise<TokenResponse> {
  return tokens(ep, { grant_type: "authorization_code", client_id: p.clientId, code: p.code, code_verifier: p.verifier, redirect_uri: p.redirectUri }, signal);
}

// No `scope`, which keeps the grant as it is (accounts and sessions page).
export function refresh(ep: Endpoints, p: { clientId: string; refreshToken: string }, signal?: AbortSignal): Promise<TokenResponse> {
  return tokens(ep, { grant_type: "refresh_token", client_id: p.clientId, refresh_token: p.refreshToken }, signal);
}

// An empty HTTP 200 means revoked, also for a token that was already invalid.
export async function revoke(ep: Endpoints, p: { clientId: string; refreshToken: string }, signal?: AbortSignal): Promise<void> {
  await post(ep.revocation_endpoint, { token: p.refreshToken, token_type_hint: "refresh_token", client_id: p.clientId }, signal);
}

const ClaimsSchema = z.object({ iss: z.string(), aud: z.union([z.string(), z.array(z.string())]), exp: z.number(), nonce: z.string().optional(), sub: z.string().min(1), email: z.string().optional() });
const JwksSchema = z.object({ keys: z.array(z.looseObject({ kid: z.string().optional() })) });

// The docs' checks, in order: the signature against OpenAI's published keys, then issuer, audience
// (the issued client ID), expiry and nonce. OpenAI signs with RS256 only (its discovery document,
// `id_token_signing_alg_values_supported`), so nothing else is accepted.
export async function verifyIdToken(ep: Endpoints, idToken: string, p: { clientId: string; nonce: string }, signal?: AbortSignal): Promise<{ sub: string; email?: string }> {
  const [head, body, sig] = idToken.split(".");
  if (!head || !body || !sig) throw new OAuthError("The ID token is malformed");
  const header = JSON.parse(Buffer.from(head, "base64url").toString("utf8")) as { alg?: unknown; kid?: unknown };
  if (header.alg !== "RS256") throw new OAuthError("The ID token is not signed with RS256");
  const res = await fetch(ep.jwks_uri, { signal });
  if (!res.ok) throw new OAuthError(`Could not read OpenAI's signing keys (HTTP ${res.status})`, undefined, res.status);
  const jwk = JwksSchema.parse(await res.json()).keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new OAuthError("The ID token was signed with a key OpenAI does not publish");
  const key = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
  if (!verify("sha256", Buffer.from(`${head}.${body}`), key, Buffer.from(sig, "base64url"))) throw new OAuthError("The ID token's signature is wrong");
  const claims = ClaimsSchema.parse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
  if (claims.iss !== ep.issuer) throw new OAuthError("The ID token names the wrong issuer");
  if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(p.clientId)) throw new OAuthError("The ID token is for another client");
  if (claims.exp * 1000 <= Date.now()) throw new OAuthError("The ID token has expired");
  if (claims.nonce !== p.nonce) throw new OAuthError("The ID token is not from this sign-in");
  return { sub: claims.sub, ...(claims.email ? { email: claims.email } : {}) };
}
