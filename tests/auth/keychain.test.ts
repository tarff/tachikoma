import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { signIn, signOut } from "../../src/auth/chatgpt.js";
import { type Keychain, KeychainError, systemKeychain } from "../../src/auth/keychain.js";
import { LoginStore } from "../../src/auth/store.js";
import { FakeOpenAI } from "./fake-openai.js";

// A keychain in memory, for the store's own tests.
function memoryKeychain(): Keychain & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    read: (name) => entries.get(name) ?? null,
    write: (name, text) => void entries.set(name, text),
    clear: (name) => void entries.delete(name),
  };
}

describe("systemKeychain", () => {
  it("keeps, reads and clears an entry by name", (ctx) => {
    // A name of its own, removed afterwards, so the user's real login is never touched.
    const keychain = systemKeychain(`tachikoma-test-${randomBytes(4).toString("hex")}`);
    const name = "chatgpt.urn:uuid:00000000-0000-4000-8000-000000000000";
    try {
      keychain.write(name, "a key");
    } catch (err) {
      if (err instanceof KeychainError) return ctx.skip(); // no keychain here, such as Linux without a secret service
      throw err;
    }
    onTestFinished(() => keychain.clear(name));
    expect(keychain.read(name)).toBe("a key");
    expect(keychain.read("chatgpt.other")).toBeNull();
    keychain.clear(name);
    expect(keychain.read(name)).toBeNull();
  });
});

describe("the login with --keychain", () => {
  async function setup(keychain: Keychain = memoryKeychain()) {
    const fake = await FakeOpenAI.start();
    const warned: string[] = [];
    const store = new LoginStore(path.join(mkdtempSync(path.join(tmpdir(), "tachi-keychain-")), "data"), (m) => warned.push(m), keychain);
    const said: string[] = [];
    const io = { say: (l: string) => said.push(l), openBrowser: fake.browser };
    return { fake, keychain, store, warned, said, io, opts: { issuer: fake.issuer } };
  }
  const saved = (store: LoginStore) => JSON.parse(readFileSync(store.file, "utf8"));

  it("keeps only a key in the keychain, made once, and the tokens sealed in the file", async () => {
    const keychain = memoryKeychain();
    const { store, io, opts } = await setup(keychain);
    await signIn(store, io, { ...opts, keychain: true });
    const login = store.read();
    const key = keychain.entries.get(`chatgpt.${login.hostId}`)!;
    expect([...keychain.entries.keys()]).toEqual([`chatgpt.${login.hostId}`]);
    expect(Buffer.from(key, "base64")).toHaveLength(32);
    const tokens = login.active!.tokens!;
    const file = readFileSync(store.file, "utf8");
    expect(file).not.toContain(tokens.refresh);
    expect(file).not.toContain(tokens.access);
    expect(saved(store).active.sealed).toEqual(expect.any(String));
    await store.update(async (current, save) => void save(current)); // a later save, such as a renewal
    expect(keychain.entries.get(`chatgpt.${login.hostId}`)).toBe(key);
    expect(store.read().active!.tokens).toEqual(tokens);
  });

  it("keeps each data folder's key apart", async () => {
    const one = await setup();
    const two = await setup(one.keychain);
    two.fake.sub = "user-2";
    await signIn(one.store, one.io, { ...one.opts, keychain: true });
    await signIn(two.store, two.io, { ...two.opts, keychain: true });
    expect((one.keychain as ReturnType<typeof memoryKeychain>).entries.size).toBe(2);
    expect(one.store.read().active!.tokens!.access).not.toBe(two.store.read().active!.tokens!.access);
  });

  it("counts a missing key, another key or a changed file as signed out, and both logout and sign-in work", async () => {
    const keychain = memoryKeychain();
    const { store, warned, said, io, opts } = await setup(keychain);
    await signIn(store, io, { ...opts, keychain: true });
    const name = `chatgpt.${store.read().hostId}`;
    const key = keychain.entries.get(name)!;
    const good = readFileSync(store.file, "utf8");

    keychain.entries.delete(name);
    expect(store.read().active).toBeUndefined();
    keychain.entries.set(name, randomBytes(32).toString("base64"));
    expect(store.read().active).toBeUndefined();
    keychain.entries.set(name, key);
    const changed = saved(store);
    const sealed = Buffer.from(changed.active.sealed, "base64");
    sealed[sealed.length - 1]! ^= 1;
    changed.active.sealed = sealed.toString("base64");
    writeFileSync(store.file, JSON.stringify(changed));
    expect(store.read().active).toBeUndefined();
    expect(warned.at(-1)).toBe(
      "The key in the system keychain is missing or does not fit. The saved ChatGPT login is not used; sign in again with `tachi login chatgpt` (or /login chatgpt in a session).",
    );

    await signOut(store, io, opts);
    expect(said.at(-1)).toBe("Not signed in to ChatGPT.");
    await signIn(store, io, { ...opts, keychain: true });
    expect(store.read().active?.tokens).toBeDefined();
    expect(readFileSync(store.file, "utf8")).not.toBe(good);
  });

  it("counts a keychain that cannot be used as signed out, with the reason", async () => {
    const memory = memoryKeychain();
    let broken = false;
    const keychain: Keychain = {
      read: (name) => {
        if (broken) throw new KeychainError("The system keychain could not be used (locked).");
        return memory.read(name);
      },
      write: memory.write,
      clear: memory.clear,
    };
    const { store, warned, said, io, opts } = await setup(keychain);
    await signIn(store, io, { ...opts, keychain: true });
    broken = true;
    expect(store.read().active).toBeUndefined();
    expect(warned.at(-1)).toBe("The system keychain could not be used (locked). The saved ChatGPT login is not used; sign in again with `tachi login chatgpt` (or /login chatgpt in a session).");
    await signOut(store, io, opts);
    expect(said.at(-1)).toBe("Not signed in to ChatGPT.");
  });

  it("moves a login into the keychain when already signed in, and removes the key at logout", async () => {
    const keychain = memoryKeychain();
    const { store, said, io, opts } = await setup(keychain);
    await signIn(store, io, opts);
    expect(keychain.entries.size).toBe(0);
    const tokens = store.read().active!.tokens!;
    await signIn(store, io, { ...opts, keychain: true });
    expect(said.at(-1)).toBe("Your ChatGPT login is now kept in the system keychain.");
    expect(keychain.entries.size).toBe(1);
    expect(readFileSync(store.file, "utf8")).not.toContain(tokens.refresh);
    expect(store.read().active?.tokens).toEqual(tokens);
    await signOut(store, io, opts);
    expect(keychain.entries.size).toBe(0);
  });
});
