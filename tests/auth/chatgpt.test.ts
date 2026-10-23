import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type LoginIO, loginArgs, signIn, signOut } from "../../src/auth/chatgpt.js";
import { LoginError, LoginStore } from "../../src/auth/store.js";
import { FakeOpenAI } from "./fake-openai.js";

async function setup() {
  const fake = await FakeOpenAI.start();
  const store = new LoginStore(path.join(mkdtempSync(path.join(tmpdir(), "tachi-login-")), "data"), () => {});
  const said: string[] = [];
  const io: LoginIO = { say: (l) => said.push(l), openBrowser: fake.browser };
  const opts = { issuer: fake.issuer };
  return { fake, store, said, io, opts };
}

const NOTICE = "You're using your ChatGPT plan. Eligible usage in this app uses your ChatGPT plan. Manage usage: https://chatgpt.com/settings/usage";

describe("loginArgs", () => {
  it("reads the provider and the account choice", () => {
    expect(loginArgs(["chatgpt"], "login")).toEqual({});
    expect(loginArgs(["chatgpt", "--new"], "login")).toEqual({ fresh: true });
    expect(loginArgs(["chatgpt", "--account", "2"], "login")).toEqual({ account: 2 });
    expect(loginArgs(["chatgpt"], "logout")).toEqual({});
  });

  it.each([[["openai"]], [[]], [["chatgpt", "--account", "0"]], [["chatgpt", "--new", "--account", "1"]], [["chatgpt", "x"]]])("refuses %j", (words) => {
    expect(() => loginArgs(words, "login")).toThrow(LoginError);
  });

  it("takes nothing after logout chatgpt", () => {
    expect(() => loginArgs(["chatgpt", "--new"], "logout")).toThrow("Usage: logout chatgpt");
  });
});

describe("signIn", () => {
  it("registers on first use, saves the login, and shows OpenAI's one-time notice", async () => {
    const { fake, store, said, io, opts } = await setup();
    await signIn(store, io, opts);
    const q = fake.authorizeRequests[0]!;
    const login = store.read();
    expect(q.get("client_id")).toBe("dynamic_agent_client");
    expect(q.get("agent_name_hint")).toBe("Tachikoma");
    expect(q.get("ext_agent_host_id")).toBe(login.hostId);
    expect(fake.tokenRequests[0]!.get("client_id")).toBe("oaiapp_1"); // the issued ID, never dynamic_agent_client
    expect(login.pending).toBeUndefined();
    expect(login.accounts).toEqual([{ clientId: "oaiapp_1", sub: "user-1", email: "me@example.com", idToken: expect.any(String) }]);
    expect(login.active).toMatchObject({ clientId: "oaiapp_1", sub: "user-1", planUse: true, tokens: { scopes: expect.arrayContaining(["chatgpt.tokens.use.direct"]) } });
    expect(said[0]).toBe("Continue with ChatGPT in your browser.");
    expect(said.slice(-2)).toEqual([NOTICE, "Signed in as me@example.com."]);
  });

  it("never shows a token: the address it prints is a local one", async () => {
    const { store, said, io, opts } = await setup();
    await signIn(store, io, opts);
    await signOut(store, io, opts);
    await signIn(store, io, opts); // sends the ID token as a hint
    const { accounts, active } = store.read();
    const secrets = [accounts[0]!.idToken!, active!.tokens!.access, active!.tokens!.refresh];
    for (const line of said) for (const s of secrets) expect(line).not.toContain(s);
    expect(said).toContainEqual(expect.stringMatching(/^If no browser opened, go to http:\/\/127\.0\.0\.1:\d+\/auth\/start$/));
  });

  it("signs in again with the saved client ID, without the name, and shows the notice only once", async () => {
    const { fake, store, said, io, opts } = await setup();
    await signIn(store, io, opts);
    const hostId = store.read().hostId;
    await signOut(store, io, opts);
    said.length = 0;
    await signIn(store, io, opts);
    const q = fake.authorizeRequests[1]!;
    expect(q.get("client_id")).toBe("oaiapp_1");
    expect(q.get("agent_name_hint")).toBeNull();
    expect(q.get("id_token_hint")).toBeNull(); // deleted at logout, so OpenAI shows its account picker
    expect(q.get("login_hint")).toBe("me@example.com");
    expect(q.get("ext_agent_host_id")).toBe(hostId);
    expect(said).not.toContain(NOTICE);
  });

  it("refuses to sign in twice", async () => {
    const { store, io, opts } = await setup();
    await signIn(store, io, opts);
    await expect(signIn(store, io, opts)).rejects.toThrow("Already signed in as me@example.com. Sign out first with `tachi logout chatgpt`.");
  });

  it("refuses a different client ID when signing in again, and keeps the old record", async () => {
    const { fake, store, io, opts } = await setup();
    await signIn(store, io, opts);
    await signOut(store, io, opts);
    fake.callbackClientId = "oaiapp_evil";
    await expect(signIn(store, io, opts)).rejects.toThrow("different client ID");
    expect(store.read().accounts).toMatchObject([{ clientId: "oaiapp_1" }]);
    expect(store.read().active).toBeUndefined();
  });

  it("treats a first registration with no issued client ID as unfinished", async () => {
    const { fake, store, io, opts } = await setup();
    fake.callbackClientId = null;
    await expect(signIn(store, io, opts)).rejects.toThrow("did not issue a client ID");
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it("stops when the user declines in the browser, without exchanging anything", async () => {
    const { fake, store, io, opts } = await setup();
    fake.deny = true;
    await expect(signIn(store, io, opts)).rejects.toThrow("Sign-in was declined in the browser.");
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it("keeps the account but not plan use when that scope was not granted", async () => {
    const { fake, store, said, io, opts } = await setup();
    fake.scope = "openid profile email offline_access";
    await signIn(store, io, opts);
    expect(store.read()).toMatchObject({ noticeShown: false, active: { planUse: false } });
    expect(said.at(-1)).toContain("but using your ChatGPT plan was not allowed");
    expect(said).not.toContain(NOTICE);
  });

  it("refuses a different account when signing in again to a saved one", async () => {
    const { fake, store, io, opts } = await setup();
    await signIn(store, io, opts);
    await signOut(store, io, opts);
    fake.sub = "user-2";
    await expect(signIn(store, io, opts)).rejects.toThrow("That was a different ChatGPT account from me@example.com");
    expect(store.read().active).toBeUndefined();
  });

  it("refuses a sign-in that finishes after the saved login changed, such as by a logout", async () => {
    const { fake, store, io, opts } = await setup();
    const meddling: LoginIO = {
      say: io.say,
      openBrowser: (url) => {
        void store.update(async (login, save) => void save(login)).then(() => fake.browser(url));
      },
    };
    await expect(signIn(store, meddling, opts)).rejects.toThrow("The saved login changed while you were signing in");
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it("stops at Ctrl-C during the code exchange, and saves no login", async () => {
    const { fake, store, io, opts } = await setup();
    fake.tokenHangs = true;
    const stop = new AbortController();
    const out = signIn(store, io, { ...opts, signal: stop.signal });
    while (fake.tokenRequests.length === 0) await new Promise((r) => setTimeout(r, 10));
    stop.abort();
    await expect(out).rejects.toThrow("aborted");
    expect(store.read().active).toBeUndefined();
  });

  it("saves the issued client ID before the exchange and uses it for the next try", async () => {
    const { fake, store, io, opts } = await setup();
    fake.idTokenIssuer = "https://evil.example"; // the exchange works, then the ID token check fails
    await expect(signIn(store, io, opts)).rejects.toThrow("wrong issuer");
    expect(store.read()).toMatchObject({ pending: { clientId: "oaiapp_1" }, accounts: [] });
    expect(store.read().active).toBeUndefined();
    fake.idTokenIssuer = undefined;
    await signIn(store, io, opts);
    expect(fake.authorizeRequests[1]!.get("client_id")).toBe("oaiapp_1");
    expect(store.read().pending).toBeUndefined();
  });

  it("asks which saved account to use when there are several", async () => {
    const { fake, store, io, opts } = await setup();
    await signIn(store, io, opts);
    await signOut(store, io, opts);
    fake.issuedClientId = "oaiapp_2";
    fake.sub = "user-2";
    fake.email = "other@example.com";
    await signIn(store, io, { ...opts, fresh: true });
    await signOut(store, io, opts);
    await expect(signIn(store, io, opts)).rejects.toThrow("1. other@example.com\n  2. me@example.com");
    fake.sub = "user-1";
    await signIn(store, io, { ...opts, account: 2 });
    expect(store.read().active).toMatchObject({ clientId: "oaiapp_1", sub: "user-1" });
  });
});

describe("signOut", () => {
  it("cancels the renewal token with OpenAI, then deletes the tokens and keeps the client ID", async () => {
    const { fake, store, said, io, opts } = await setup();
    await signIn(store, io, opts);
    const refresh = store.read().active!.tokens!.refresh;
    await signOut(store, io, opts);
    expect(fake.revoked[0]!.get("token")).toBe(refresh);
    expect(said.at(-1)).toBe("Signed out of ChatGPT.");
    const login = store.read();
    expect(login.active).toBeUndefined();
    expect(login.accounts).toEqual([{ clientId: "oaiapp_1", sub: "user-1", email: "me@example.com" }]);
    expect(readFileSync(store.file, "utf8")).not.toContain(refresh);
  });

  it("still deletes the tokens when OpenAI cannot confirm, and says so", async () => {
    const { fake, store, said, io, opts } = await setup();
    await signIn(store, io, opts);
    fake.revokeStatus = 503;
    await signOut(store, io, opts);
    expect(store.read().active).toBeUndefined();
    expect(said.at(-1)).toContain("OpenAI did not confirm that the sign-in was cancelled (OpenAI refused the request (HTTP 503))");
  });

  it("deletes the ID token even when the login was already dropped, so the next sign-in sends no hint", async () => {
    const { fake, store, io, opts } = await setup();
    await signIn(store, io, opts);
    await store.update(async (login, save) => void save({ ...login, active: undefined })); // as a dead renewal does
    await signOut(store, io, opts);
    expect(store.read().accounts[0]).not.toHaveProperty("idToken");
    await signIn(store, io, opts);
    expect(fake.authorizeRequests[1]!.get("id_token_hint")).toBeNull();
  });

  it("says when nobody is signed in", async () => {
    const { store, said, io, opts } = await setup();
    await signOut(store, io, opts);
    expect(said).toEqual(["Not signed in to ChatGPT."]);
  });

  it("deletes the tokens before asking OpenAI, so an answer that never comes keeps nothing and holds no lock", async () => {
    const { fake, store, said, io, opts } = await setup();
    await signIn(store, io, opts);
    const refresh = store.read().active!.tokens!.refresh;
    fake.revokeHangs = true;
    const stop = new AbortController();
    const out = signOut(store, io, { ...opts, signal: stop.signal });
    while (fake.revoked.length === 0) await new Promise((r) => setTimeout(r, 10));
    expect(store.read().active).toBeUndefined();
    expect(readFileSync(store.file, "utf8")).not.toContain(refresh);
    await store.update(async (login, save) => void save(login)); // the lock is free
    stop.abort(); // Ctrl-C
    await out;
    expect(said.at(-1)).toContain("OpenAI did not confirm that the sign-in was cancelled");
  });

  it("cancels a sign-in still waiting in the browser, even with nobody signed in", async () => {
    const { fake, store, said, io, opts } = await setup();
    const meddling: LoginIO = {
      say: io.say,
      openBrowser: (url) => void signOut(store, io, opts).then(() => fake.browser(url)),
    };
    await expect(signIn(store, meddling, opts)).rejects.toThrow("The saved login changed while you were signing in");
    expect(said).toContain("Not signed in to ChatGPT.");
    expect(fake.tokenRequests).toHaveLength(0);
  });
});
