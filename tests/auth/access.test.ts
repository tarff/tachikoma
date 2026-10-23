import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ChatGPTAuth } from "../../src/auth/access.js";
import { signIn, signOut } from "../../src/auth/chatgpt.js";
import { LoginStore, type Tokens } from "../../src/auth/store.js";
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
  return { fake, dir, store, io, auth, age, renewals };
}

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

  it("asks the user to sign in again when the renewal token is dead, and drops the tokens", async () => {
    const { store, auth, age } = await signedIn();
    await age({ expiresAt: Date.now(), refresh: "used-up" });
    await expect(auth.token()).rejects.toThrow("Your ChatGPT sign-in has expired or was cancelled. Sign in to ChatGPT with `tachi login chatgpt`");
    expect(store.read().active).toBeUndefined();
    expect(store.read().accounts).toHaveLength(1); // the account and its client ID stay
  });

  it("stops a renewal at Ctrl-C, and keeps the login", async () => {
    const { fake, store, auth, age, renewals } = await signedIn();
    await age({ expiresAt: Date.now() });
    fake.tokenHangs = true;
    const stop = new AbortController();
    const out = auth.token(stop.signal);
    while (renewals() === 0) await new Promise((r) => setTimeout(r, 10));
    stop.abort();
    await expect(out).rejects.toThrow("aborted");
    expect(store.read().active?.tokens).toBeDefined();
  });

  it("keeps the login when OpenAI cannot be reached", async () => {
    const { store, age, renewals } = await signedIn();
    await age({ expiresAt: Date.now() });
    const offline = new ChatGPTAuth(store, "http://127.0.0.1:9"); // nothing listens on the discard port
    await expect(offline.token()).rejects.toThrow(/^Could not renew the ChatGPT sign-in\. The request to OpenAI's sign-in service failed \([^()]+\)\. You are still signed in, so you can try again\.$/);
    expect(store.read().active?.tokens).toBeDefined();
    expect(renewals()).toBe(0);
  });

  it("refuses the request when a renewal takes plan use away", async () => {
    const { store, auth, age, fake, renewals } = await signedIn();
    await age({ expiresAt: Date.now() });
    fake.scope = "openid email offline_access";
    await expect(auth.token()).rejects.toThrow("Using your ChatGPT plan was not allowed");
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
    await expect(auth.token()).rejects.toThrow("Using your ChatGPT plan was not allowed");
  });
});
