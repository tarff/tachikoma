import { createHash } from "node:crypto";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { describe, expect, it, onTestFinished } from "vitest";
import { authorizeUrl, discover, exchange, FIRST_CLIENT, listen, newAttempt, OAuthError, refresh, revoke, verifyIdToken } from "../../src/auth/oauth.js";
import { FakeOpenAI } from "./fake-openai.js";

const now = () => Math.floor(Date.now() / 1000);

// A server that answers every request with `answer`, or never answers without one. It is closed when
// the test ends, passed or not.
async function serve(answer?: (res: http.ServerResponse) => void): Promise<{ url: string }> {
  const server = http.createServer((_req, res) => answer?.(res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

// Connects to a listener's port without sending anything, as a browser's spare connection does.
async function connect(l: { redirectUri: string }): Promise<net.Socket> {
  const socket = net.connect(Number(new URL(l.redirectUri).port), "127.0.0.1");
  await new Promise((resolve) => socket.on("connect", resolve));
  return socket;
}

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
    expect(page.headers.get("connection")).toBe("close");
    expect((await l.reply).get("code")).toBe("y");
    await expect(fetch(`${l.redirectUri}?state=good&code=z`)).rejects.toThrow(); // closed
  });

  it("stops when cancelled, also before anyone waits for the reply", async () => {
    const stop = new AbortController();
    const l = await listen("s", stop.signal);
    stop.abort();
    await new Promise((r) => setTimeout(r, 20)); // an unhandled rejection would fail the run here
    await expect(l.reply).rejects.toThrow("Sign-in was cancelled");
  });

  it("is not reached at any address but 127.0.0.1", async () => {
    const l = await listen("s");
    const port = new URL(l.redirectUri).port;
    // Both refuse at once unless the listener is on every address; neither depends on the network here.
    for (const host of ["[::1]", "127.0.0.2"]) await expect(fetch(`http://${host}:${port}/auth/callback?state=s`)).rejects.toThrow();
    l.close();
  });

  it("sends the browser on from the start address once, and says so after", async () => {
    const l = await listen("s");
    onTestFinished(() => l.close());
    expect((await fetch(l.startUri, { redirect: "manual" })).status).toBe(404); // nothing to send it to yet
    l.begin("https://auth.example/authorize?id_token_hint=secret");
    const first = await fetch(l.startUri, { redirect: "manual" });
    expect(first.headers.get("location")).toBe("https://auth.example/authorize?id_token_hint=secret");
    const again = await fetch(l.startUri, { redirect: "manual" }); // nor to anyone who asks again
    expect(again.headers.get("location")).toBeNull();
    expect(await again.text()).toContain("already opened");
  });

  it("turns away a request that is not an address, and goes on waiting", async () => {
    const l = await listen("s");
    const socket = await connect(l);
    const answer = new Promise<string>((resolve) => {
      let text = "";
      socket.on("data", (d) => (text += d)).on("close", () => resolve(text));
    });
    socket.end("GET //[ HTTP/1.1\r\nHost: x\r\n\r\n");
    expect(await answer).toMatch(/^HTTP\/1\.1 400/);
    await fetch(`${l.redirectUri}?state=s&code=c`);
    expect((await l.reply).get("code")).toBe("c");
  });

  it("closes a browser's spare connection once the reply is in", async () => {
    const l = await listen("s");
    const spare = await connect(l);
    const closed = new Promise((resolve) => spare.on("close", resolve));
    await fetch(`${l.redirectUri}?state=s&code=c`);
    await closed; // left open, this test runs out of time
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

  it("keeps tokens out of its errors, even when OpenAI's reply repeats them", async () => {
    const ep = await discover((await FakeOpenAI.start()).issuer);
    const body = JSON.stringify({ error: "invalid_grant", error_description: "bad token secret-refresh" });
    const server = await serve((res) => res.writeHead(400, { "content-type": "application/json" }).end(body));
    const err = await refresh({ ...ep, token_endpoint: server.url }, { clientId: "c", refreshToken: "secret-refresh" }).catch((e: Error) => e);
    expect(err).toMatchObject({ code: "invalid_grant" });
    expect(String(err)).not.toContain("secret-refresh");
  });

  it("says a renewal was cancelled while OpenAI's reply was arriving", async () => {
    const ep = await discover((await FakeOpenAI.start()).issuer);
    const server = await serve((res) => res.writeHead(200, { "content-type": "application/json" }).write('{"access_token":'));
    const stop = new AbortController();
    const renewing = refresh({ ...ep, token_endpoint: server.url }, { clientId: "c", refreshToken: "r" }, stop.signal);
    setTimeout(() => stop.abort(), 20);
    await expect(renewing).rejects.toThrow("aborted");
  });

  it("does not follow a redirect, which would send the form, tokens and all, elsewhere", async () => {
    const ep = await discover((await FakeOpenAI.start()).issuer);
    let asked = false;
    const other = await serve((res) => {
      asked = true;
      res.writeHead(200).end("{}");
    });
    const server = await serve((res) => res.writeHead(307, { location: other.url }).end());
    await expect(refresh({ ...ep, token_endpoint: server.url }, { clientId: "c", refreshToken: "secret-r" })).rejects.toThrow();
    expect(asked).toBe(false);
  });

  it("keeps tokens out of the error for a reply it cannot read", async () => {
    const ep = await discover((await FakeOpenAI.start()).issuer);
    for (const body of ['{"access_token":"secret-access', '{"access_token":"secret-access"}']) {
      const server = await serve((res) => res.writeHead(200, { "content-type": "application/json" }).end(body));
      const err = await refresh({ ...ep, token_endpoint: server.url }, { clientId: "c", refreshToken: "r" }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(OAuthError);
      expect(String(err)).not.toContain("secret");
    }
  });

  it("refuses sign-in settings that name another issuer", async () => {
    const fake = await FakeOpenAI.start();
    await expect(discover(fake.issuer.replace("127.0.0.1", "localhost"))).rejects.toThrow("wrong issuer");
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
    for (const head of ["{not json", "null"]) await expect(check(`${Buffer.from(head).toString("base64url")}.${b}.x`)).rejects.toThrow(OAuthError);
  });

  // OpenID Connect Core 1.0, section 3.1.3.7: with several audiences, `azp` names the client the token
  // was issued to.
  it("refuses a token issued to another client that also names this one", async () => {
    const { fake, good, check } = await setup();
    await expect(check(fake.idToken({ ...good, aud: ["oaiapp_other", "oaiapp_1"], azp: "oaiapp_other" }))).rejects.toThrow("another client");
  });

  it("stops fetching OpenAI's keys when cancelled", async () => {
    const { fake, good } = await setup();
    const keys = await serve();
    const stop = new AbortController();
    const ep = { ...(await discover(fake.issuer)), jwks_uri: keys.url };
    const checking = verifyIdToken(ep, fake.idToken(good), { clientId: "oaiapp_1", nonce: "n" }, stop.signal);
    setTimeout(() => stop.abort(), 20);
    await expect(checking).rejects.toThrow();
  });
});
