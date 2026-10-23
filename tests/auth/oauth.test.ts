import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorizeUrl, discover, exchange, FIRST_CLIENT, listen, newAttempt, refresh, revoke, verifyIdToken } from "../../src/auth/oauth.js";
import { FakeOpenAI } from "./fake-openai.js";

const now = () => Math.floor(Date.now() / 1000);

describe("authorizeUrl", () => {
  const ep = { issuer: "https://auth.openai.com", authorization_endpoint: "https://auth.openai.com/api/accounts/authorize", token_endpoint: "", jwks_uri: "", revocation_endpoint: "" };
  const base = { hostId: "urn:uuid:h", redirectUri: "http://127.0.0.1:5000/auth/callback", state: "s", nonce: "n", challenge: "c" };

  it("registers with the app's name the first time", () => {
    const q = new URL(authorizeUrl(ep, { ...base, clientId: FIRST_CLIENT })).searchParams;
    expect(Object.fromEntries(q)).toEqual({
      client_id: "dynamic_agent_client",
      response_type: "code",
      redirect_uri: "http://127.0.0.1:5000/auth/callback",
      scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      resource: "https://api.openai.com/v1",
      state: "s",
      nonce: "n",
      code_challenge: "c",
      code_challenge_method: "S256",
      ext_agent_host_id: "urn:uuid:h",
      agent_name_hint: "Tachikoma",
    });
  });

  it("sends the hints, and not the name, when signing in again", () => {
    const q = new URL(authorizeUrl(ep, { ...base, clientId: "oaiapp_1", idTokenHint: "t", loginHint: "me@example.com" })).searchParams;
    expect(q.get("agent_name_hint")).toBeNull();
    expect(q.get("id_token_hint")).toBe("t");
    expect(q.get("login_hint")).toBe("me@example.com");
  });
});

describe("newAttempt", () => {
  it("makes fresh values each time, with the challenge from the verifier", () => {
    const a = newAttempt();
    const b = newAttempt();
    expect(a.state).not.toBe(b.state);
    expect(a.verifier).toHaveLength(43); // 32 bytes in base64url
    expect(a.challenge).toBe(createHash("sha256").update(a.verifier).digest("base64url"));
  });
});

describe("listen", () => {
  it("waits on 127.0.0.1 and takes the first reply with this attempt's state", async () => {
    const l = await listen("good");
    expect(l.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect((await fetch(`${l.redirectUri}?state=bad&code=x`)).status).toBe(400);
    const page = await fetch(`${l.redirectUri}?state=good&code=y`);
    expect(page.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect((await l.reply).get("code")).toBe("y");
    await expect(fetch(`${l.redirectUri}?state=good&code=z`)).rejects.toThrow(); // closed
  });

  it("stops when cancelled", async () => {
    const stop = new AbortController();
    const l = await listen("s", stop.signal);
    stop.abort();
    await expect(l.reply).rejects.toThrow("Sign-in was cancelled");
  });
});

describe("against OpenAI's flow", () => {
  async function codeFor(fake: FakeOpenAI) {
    const ep = await discover(fake.issuer);
    const a = newAttempt();
    const l = await listen(a.state);
    fake.browser(authorizeUrl(ep, { clientId: FIRST_CLIENT, hostId: "urn:uuid:h", redirectUri: l.redirectUri, ...a }));
    const reply = await l.reply;
    return { ep, a, redirectUri: l.redirectUri, code: reply.get("code")!, clientId: reply.get("client_id")! };
  }

  it("exchanges the code, checks the ID token, renews and revokes", async () => {
    const fake = await FakeOpenAI.start();
    const { ep, a, redirectUri, code, clientId } = await codeFor(fake);
    expect(clientId).toBe("oaiapp_1");
    const t = await exchange(ep, { clientId, code, verifier: a.verifier, redirectUri });
    expect(await verifyIdToken(ep, t.id_token!, { clientId, nonce: a.nonce })).toEqual({ sub: "user-1", email: "me@example.com" });
    const renewed = await refresh(ep, { clientId, refreshToken: t.refresh_token });
    expect(renewed.refresh_token).not.toBe(t.refresh_token);
    await expect(refresh(ep, { clientId, refreshToken: t.refresh_token })).rejects.toMatchObject({ code: "refresh_token_reused" });
    await revoke(ep, { clientId, refreshToken: renewed.refresh_token });
    expect(Object.fromEntries(fake.revoked[0]!)).toEqual({ token: renewed.refresh_token, token_type_hint: "refresh_token", client_id: "oaiapp_1" });
  });

  it("uses each code once, and only with its own verifier", async () => {
    const fake = await FakeOpenAI.start();
    const { ep, redirectUri, code, clientId } = await codeFor(fake);
    await expect(exchange(ep, { clientId, code, verifier: newAttempt().verifier, redirectUri })).rejects.toMatchObject({ code: "invalid_grant", status: 400 });
  });

  it("keeps tokens out of its errors", async () => {
    const fake = await FakeOpenAI.start();
    const ep = await discover(fake.issuer);
    const err = await refresh(ep, { clientId: "c", refreshToken: "secret-refresh" }).catch((e: Error) => e);
    expect(String(err)).not.toContain("secret-refresh");
  });
});

describe("verifyIdToken", () => {
  async function setup() {
    const fake = await FakeOpenAI.start();
    const ep = await discover(fake.issuer);
    const good = { iss: fake.issuer, aud: "oaiapp_1", sub: "u", exp: now() + 60, nonce: "n" };
    const check = (token: string) => verifyIdToken(ep, token, { clientId: "oaiapp_1", nonce: "n" });
    return { fake, good, check };
  }

  it("accepts a good token", async () => {
    const { fake, good, check } = await setup();
    expect(await check(fake.idToken(good))).toEqual({ sub: "u" });
  });

  it.each([
    ["issuer", { iss: "https://evil.example" }, "wrong issuer"],
    ["audience", { aud: "oaiapp_other" }, "another client"],
    ["expiry", { exp: now() - 1 }, "expired"],
    ["nonce", { nonce: "other" }, "not from this sign-in"],
    ["sub", { sub: "" }, ""],
  ])("refuses the wrong %s", async (_, change, message) => {
    const { fake, good, check } = await setup();
    await expect(check(fake.idToken({ ...good, ...change }))).rejects.toThrow(message);
  });

  it("refuses a bad signature, an unknown key and an algorithm other than RS256", async () => {
    const { fake, good, check } = await setup();
    const [h, b] = fake.idToken(good).split(".");
    const other = fake.idToken({ ...good, sub: "someone-else" }).split(".")[2];
    await expect(check(`${h}.${b}.${other}`)).rejects.toThrow("signature is wrong");
    await expect(check(fake.idToken(good, "k2"))).rejects.toThrow("key OpenAI does not publish");
    const none = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    await expect(check(`${none}.${b}.x`)).rejects.toThrow("not signed with RS256");
  });
});
