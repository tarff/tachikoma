import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { ChatGPTAuth } from "../../src/auth/access.js";
import { signIn, signOut } from "../../src/auth/chatgpt.js";
import { LoginStore, type SavedLogin, type Tokens } from "../../src/auth/store.js";
import { FakeOpenAI } from "./fake-openai.js";

async function signedIn() {
  const fake = await FakeOpenAI.start();
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "tachi-access-")), "data");
  const store = new LoginStore(dir, () => {});
  const io = { say: () => {}, openBrowser: fake.browser };
  await signIn(store, io, { issuer: fake.issuer });
  const auth = new ChatGPTAuth(store, fake.issuer);
  // Changes the saved tokens, as time passing would.
  const age = (change: Partial<Tokens>) => store.update(async (login, save) => void save({ ...login, active: { ...login.active!, tokens: { ...login.active!.tokens!, ...change } } }));
  const renewals = () => fake.tokenRequests.filter((q) => q.get("grant_type") === "refresh_token").length;
  // Another change to the login, holding the lock until `release()`; `then` is what it saves.
  const busy = (then?: (login: SavedLogin) => SavedLogin) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const done = store.update(async (login, save) => {
      await gate;
      if (then) save(then(login));
    });
    return { release, done };
  };
  // Waits for anything still holding the lock, such as a renewal carrying on after Ctrl-C.
  const settled = () => store.update(async () => {});
  return { fake, dir, store, io, auth, age, renewals, busy, settled };
}

// Requests to `path` get `answer`, which can `send` them on to the fake; the rest go straight there.
function intercept(path: string, answer: (send: () => Promise<Response>, init?: RequestInit) => Promise<Response>): void {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => (String(input).endsWith(path) ? answer(() => real(input, init), init) : real(input, init)));
  onTestFinished(() => void vi.restoreAllMocks());
}

// Ctrl-C while the request to `path` waits for an answer that never comes, so only Ctrl-C can end it.
const ctrlCWaiting = (path: string, stop: AbortController) =>
  intercept(path, (_, init) => {
    const out = new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    stop.abort();
    return out;
  });

const SETTINGS = "/.well-known/openid-configuration";

describe("ChatGPTAuth", () => {
  it("uses the saved token while it has more than a minute left, and says which account it is for", async () => {
    const { store, auth, renewals } = await signedIn();
    expect(await auth.token()).toEqual({ token: store.read().active!.tokens!.access, account: "oaiapp_1 user-1" });
    expect(renewals()).toBe(0);
  });

  it("renews with under a minute left, and saves the new tokens together", async () => {
    const { store, auth, age, renewals } = await signedIn();
    const old = store.read().active!.tokens!;
    await age({ expiresAt: Date.now() + 59_000 });
    const { token } = await auth.token();
    const now = store.read().active!.tokens!;
    expect(renewals()).toBe(1);
    expect(token).toBe(now.access);
    expect(now.access).not.toBe(old.access);
    expect(now.refresh).not.toBe(old.refresh);
    expect(now.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);
  });

  it("never renews before earliest_refresh_at", async () => {
    const { auth, age, renewals } = await signedIn();
    await age({ expiresAt: Date.now() + 30_000, earliestRefreshAt: Math.floor(Date.now() / 1000) + 600 });
    await auth.token();
    expect(renewals()).toBe(0);
  });

  // The real sign-in sends earliest_refresh_at (main design, item 16), so this is the usual renewal.
  it("renews once earliest_refresh_at has passed", async () => {
    const { auth, age, renewals } = await signedIn();
    await age({ expiresAt: Date.now() + 30_000, earliestRefreshAt: Math.floor(Date.now() / 1000) - 1 });
    await auth.token();
    expect(renewals()).toBe(1);
  });

  it("renews once when two requests in one process need it at the same moment", async () => {
    const { auth, age, renewals } = await signedIn();
    await age({ expiresAt: Date.now() });
    const [a, b] = await Promise.all([auth.token(), auth.token()]);
    expect(renewals()).toBe(1);
    expect(b.token).toBe(a.token);
  });

  it("renews once when two processes need it at the same moment", async () => {
    const { fake, dir, store, age, renewals } = await signedIn();
    await age({ expiresAt: Date.now() + 1_000 });
    const script = path.join(path.dirname(dir), "token.mts");
    const url = (f: string) => JSON.stringify(pathToFileURL(path.resolve(f)).href);
    writeFileSync(
      script,
      `import { ChatGPTAuth } from ${url("src/auth/access.ts")};
import { LoginStore } from ${url("src/auth/store.ts")};
console.log((await new ChatGPTAuth(new LoginStore(${JSON.stringify(dir)}, () => {}), ${JSON.stringify(fake.issuer)}).token()).token);`,
    );
    const run = () =>
      new Promise<string>((resolve) => {
        const child = spawn(process.execPath, ["--import", "tsx", script], { stdio: ["ignore", "pipe", "inherit"] });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.on("close", () => resolve(out.trim()));
      });
    const [a, b] = await Promise.all([run(), run()]);
    expect(renewals()).toBe(1);
    expect(a).toBe(store.read().active!.tokens!.access);
    expect(b).toBe(a);
  }, 60_000);

  // The errors page's list of renewal errors after which a login cannot be used again.
  it.each(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"])(
    "asks the user to sign in again after %s, and drops the tokens",
    async (code) => {
      const { fake, store, auth, age } = await signedIn();
      await age({ expiresAt: Date.now() });
      fake.renewalError = code;
      await expect(auth.token()).rejects.toThrow("Your ChatGPT sign-in has expired or was cancelled. Sign in with `tachi login chatgpt`");
      expect(store.read().active).toBeUndefined();
      expect(store.read().accounts).toHaveLength(1); // the account and its client ID stay
    },
  );

  it("keeps the login when OpenAI refuses a renewal for another reason", async () => {
    const { fake, store, auth, age } = await signedIn();
    await age({ expiresAt: Date.now() });
    fake.renewalError = "invalid_request";
    await expect(auth.token()).rejects.toThrow(/^Could not renew the ChatGPT sign-in\. OpenAI refused the request \(HTTP 400, invalid_request\)\. You are still signed in, so you can try again\.$/);
    expect(store.read().active?.tokens).toBeDefined();
  });

  // The errors page: "Invalid client: `invalid_client`. Fix the client configuration."
  it("says to register again when OpenAI does not accept the registration", async () => {
    const { fake, store, auth, age } = await signedIn();
    await age({ expiresAt: Date.now() });
    fake.renewalError = "invalid_client";
    await expect(auth.token()).rejects.toThrow(
      /^Could not renew the ChatGPT sign-in\. OpenAI refused the request \(HTTP 400, invalid_client\)\. OpenAI did not accept Tachikoma's registration, so trying again will not help\. Sign out with `tachi logout chatgpt`, then register again with `tachi login chatgpt --new` \(or \/logout chatgpt and \/login chatgpt --new in a session\)\.$/,
    );
    expect(store.read().active?.tokens).toBeDefined();
  });

  // Ctrl-C ends the wait as it ends anything else, with the abort itself, and the login stays.
  it("stops at Ctrl-C while asking for OpenAI's sign-in settings, and sends no renewal", async () => {
    const { store, auth, age, renewals, settled } = await signedIn();
    await age({ expiresAt: Date.now() });
    const stop = new AbortController();
    ctrlCWaiting(SETTINGS, stop);
    await expect(auth.token(stop.signal)).rejects.toMatchObject({ name: "AbortError" });
    await settled();
    expect(renewals()).toBe(0);
    expect(store.read().active?.tokens).toBeDefined();
  });

  it("sends no renewal after a Ctrl-C pressed just as OpenAI's sign-in settings arrive", async () => {
    const { auth, age, renewals, settled } = await signedIn();
    await age({ expiresAt: Date.now() });
    const stop = new AbortController();
    intercept(SETTINGS, async (send) => {
      const body = await (await send()).text();
      stop.abort();
      return new Response(body, { headers: { "content-type": "application/json" } });
    });
    await expect(auth.token(stop.signal)).rejects.toMatchObject({ name: "AbortError" });
    await settled();
    expect(renewals()).toBe(0);
  });

  it("stops waiting at Ctrl-C while OpenAI renews, and keeps the login", async () => {
    const { store, auth, age } = await signedIn();
    const old = store.read().active!.tokens!;
    await age({ expiresAt: Date.now() });
    const stop = new AbortController();
    ctrlCWaiting("/token", stop); // never answered, so the renewal is still waiting when the test ends
    await expect(auth.token(stop.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(store.read().active?.tokens?.refresh).toBe(old.refresh);
  });

  // OpenAI replaces the renewal token as it answers, so dropping its answer would sign the user out.
  it("saves a renewal whose answer is arriving at Ctrl-C, for the next request to use", async () => {
    const { store, auth, age, renewals } = await signedIn();
    await age({ expiresAt: Date.now() });
    const stop = new AbortController();
    intercept("/token", async (send) => {
      const res = await send();
      stop.abort();
      return res;
    });
    await expect(auth.token(stop.signal)).rejects.toMatchObject({ name: "AbortError" });
    const next = await auth.token();
    expect(renewals()).toBe(1);
    expect(next.token).toBe(store.read().active!.tokens!.access);
    expect(store.read().active!.tokens!.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);
  });

  it("stops at Ctrl-C while waiting for the lock, and sends no renewal", async () => {
    const { store, auth, age, renewals, busy, settled } = await signedIn();
    await age({ expiresAt: Date.now() });
    const other = busy();
    const fetches = vi.spyOn(globalThis, "fetch");
    onTestFinished(() => void vi.restoreAllMocks());
    const stop = new AbortController();
    const out = auth.token(stop.signal);
    stop.abort();
    await expect(out).rejects.toMatchObject({ name: "AbortError" });
    other.release();
    await settled();
    expect(fetches).not.toHaveBeenCalled(); // it gave up waiting, rather than going on to ask OpenAI
    expect(renewals()).toBe(0);
    expect(store.read().active?.tokens).toBeDefined();
  });

  it("says to sign out and in again when a renewal cannot be saved, since the saved one will not renew", async () => {
    const { store, auth, age } = await signedIn();
    await age({ expiresAt: Date.now() + 59_000 });
    // Once OpenAI has answered, a folder takes the login file's name, so the new tokens cannot be saved.
    intercept("/token", async (send) => {
      const answer = await send();
      rmSync(store.file);
      mkdirSync(store.file);
      return answer;
    });
    await expect(auth.token()).rejects.toThrow(
      /^OpenAI renewed your ChatGPT sign-in, but saving it failed \(.+\)\. The saved sign-in cannot be renewed again, so sign out with `tachi logout chatgpt` \(or \/logout chatgpt in a session\), then sign in again\.$/,
    );
  });

  it("keeps the login when OpenAI cannot be reached", async () => {
    const { store, age } = await signedIn();
    await age({ expiresAt: Date.now() });
    const offline = new ChatGPTAuth(store, "http://127.0.0.1:9"); // nothing listens on the discard port
    await expect(offline.token()).rejects.toThrow(/^Could not renew the ChatGPT sign-in\. The request to OpenAI's sign-in service failed \([^()]+\)\. You are still signed in, so you can try again\.$/);
    expect(store.read().active?.tokens).toBeDefined();
  });

  it("refuses the request when a renewal takes plan use away", async () => {
    const { store, auth, age, fake, renewals } = await signedIn();
    await age({ expiresAt: Date.now() });
    fake.scope = "openid email offline_access";
    await expect(auth.token()).rejects.toThrow("This ChatGPT sign-in does not allow using your plan. Sign out with `tachi logout chatgpt` (or /logout chatgpt in a session), sign in again and allow it, or use openai:<model> with an API key.");
    expect(renewals()).toBe(1);
    expect(store.read().active?.planUse).toBe(false);
  });

  it("refuses after a logout, and when plan use was not allowed", async () => {
    const { store, io, auth, fake } = await signedIn();
    await signOut(store, io, { issuer: fake.issuer });
    await expect(auth.token()).rejects.toThrow("Not signed in to ChatGPT.");
    expect(() => auth.check()).toThrow("Not signed in to ChatGPT.");
    fake.scope = "openid email";
    await signIn(store, io, { issuer: fake.issuer });
    await expect(auth.token()).rejects.toThrow("This ChatGPT sign-in does not allow using your plan.");
  });

  it("refuses when a logout lands while the renewal waits for the lock", async () => {
    const { store, auth, age, renewals, busy } = await signedIn();
    await age({ expiresAt: Date.now() });
    const logout = busy((login) => ({ ...login, active: undefined }));
    const out = auth.token();
    logout.release();
    await logout.done;
    await expect(out).rejects.toThrow("Not signed in to ChatGPT.");
    expect(renewals()).toBe(0);
  });
});
