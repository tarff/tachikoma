import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";

// A stand-in for OpenAI's sign-in service, following its docs: discovery, authorize (answered at once
// with a redirect, as if the user approved), token, revoke and signing keys. Each test changes the
// fields below to make it misbehave.
export class FakeOpenAI {
  issuer = "";
  sub = "user-1";
  email = "me@example.com";
  scope = "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke";
  issuedClientId = "oaiapp_1";
  callbackClientId: string | null | undefined; // undefined: the docs' default; null: left out
  deny = false; // the user says no in the browser
  idTokenIssuer: string | undefined; // set to sign ID tokens with another issuer
  revokeStatus = 200;
  revokeHangs = false; // the revocation is never answered
  tokenHangs = false; // token requests (exchange and renewal) are never answered
  earliestRefreshAt: unknown;
  readonly authorizeRequests: URLSearchParams[] = [];
  readonly tokenRequests: URLSearchParams[] = [];
  readonly revoked: URLSearchParams[] = [];
  readonly #keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  readonly #codes = new Map<string, { clientId: string; challenge: string; redirectUri: string; nonce: string }>();
  readonly #refresh = new Set<string>();
  #server = http.createServer((req, res) => void this.#handle(req, res));

  static async start(): Promise<FakeOpenAI> {
    const fake = new FakeOpenAI();
    await new Promise<void>((resolve) => fake.#server.listen(0, "127.0.0.1", resolve));
    fake.issuer = `http://127.0.0.1:${(fake.#server.address() as AddressInfo).port}`;
    onTestFinished(() => {
      fake.#server.close();
      fake.#server.closeAllConnections();
    });
    return fake;
  }

  // What a browser would do with the address Tachikoma prints: follow it to the callback.
  readonly browser = (url: string) => {
    void fetch(url).catch(() => {});
  };

  idToken(claims: Record<string, unknown>, kid = "k1"): string {
    const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = `${part({ alg: "RS256", kid })}.${part(claims)}`;
    return `${head}.${sign("sha256", Buffer.from(head), this.#keys.privateKey).toString("base64url")}`;
  }

  #tokens(clientId: string, nonce?: string) {
    const refresh = randomBytes(8).toString("hex");
    this.#refresh.add(refresh);
    const now = Math.floor(Date.now() / 1000);
    return {
      access_token: `access-${randomBytes(4).toString("hex")}`,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: 3600,
      scope: this.scope,
      ...(this.earliestRefreshAt === undefined ? {} : { earliest_refresh_at: this.earliestRefreshAt }),
      id_token: this.idToken({ iss: this.idTokenIssuer ?? this.issuer, aud: clientId, sub: this.sub, email: this.email, exp: now + 3600, iat: now, ...(nonce ? { nonce } : {}) }),
    };
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.issuer);
    const json = (status: number, body?: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(body === undefined ? "" : JSON.stringify(body));
    let form = new URLSearchParams();
    if (req.method === "POST") {
      let text = "";
      for await (const chunk of req) text += chunk;
      form = new URLSearchParams(text);
    }
    switch (url.pathname) {
      case "/.well-known/openid-configuration":
        return void json(200, {
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/authorize`,
          token_endpoint: `${this.issuer}/token`,
          jwks_uri: `${this.issuer}/jwks`,
          revocation_endpoint: `${this.issuer}/revoke`,
        });
      case "/jwks":
        return void json(200, { keys: [{ ...this.#keys.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] });
      case "/authorize": {
        const q = url.searchParams;
        this.authorizeRequests.push(q);
        const back = new URL(q.get("redirect_uri")!);
        back.searchParams.set("state", q.get("state")!);
        if (this.deny) back.searchParams.set("error", "access_denied");
        else {
          const first = q.get("client_id") === "dynamic_agent_client";
          const clientId = first ? this.issuedClientId : q.get("client_id")!;
          const code = randomBytes(8).toString("hex");
          this.#codes.set(code, { clientId, challenge: q.get("code_challenge")!, redirectUri: q.get("redirect_uri")!, nonce: q.get("nonce")! });
          back.searchParams.set("code", code);
          back.searchParams.set("scope", this.scope);
          const shown = this.callbackClientId === undefined ? (first ? clientId : undefined) : this.callbackClientId;
          if (shown) back.searchParams.set("client_id", shown);
        }
        return void res.writeHead(302, { location: back.href }).end();
      }
      case "/token": {
        this.tokenRequests.push(form);
        if (this.tokenHangs) return;
        if (form.get("resource") !== "https://api.openai.com/v1") return void json(400, { error: "invalid_request" });
        if (form.get("grant_type") === "authorization_code") {
          const pending = this.#codes.get(form.get("code") ?? "");
          this.#codes.delete(form.get("code") ?? ""); // each code works once
          const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
          if (!pending || pending.challenge !== challenge || pending.redirectUri !== form.get("redirect_uri") || pending.clientId !== form.get("client_id")) {
            return void json(400, { error: "invalid_grant" });
          }
          return void json(200, this.#tokens(pending.clientId, pending.nonce));
        }
        if (form.get("grant_type") === "refresh_token") {
          // Each refresh token works once and is replaced (token reference page).
          if (!this.#refresh.delete(form.get("refresh_token") ?? "")) return void json(400, { error: "refresh_token_reused" });
          return void json(200, this.#tokens(form.get("client_id")!));
        }
        return void json(400, { error: "unsupported_grant_type" });
      }
      case "/revoke":
        this.revoked.push(form);
        if (this.revokeHangs) return;
        return void json(this.revokeStatus);
      default:
        return void json(404);
    }
  }
}
