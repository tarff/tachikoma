import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { type Keychain, KeychainError, systemKeychain } from "./keychain.js";
import { withLock } from "./lock.js";
import type { TokenResponse } from "./oauth.js";
import { privateDir, readPrivate, writePrivate } from "./private.js";

// The saved ChatGPT login, `<data folder>/chatgpt.json` (release 2 design, "The saved login").

const TokensSchema = z.object({
  access: z.string(),
  refresh: z.string(),
  expiresAt: z.number(), // milliseconds since 1970, from `expires_in`
  // Kept exactly as OpenAI sent it: its docs name the field but not its meaning or units. The first
  // real sign-in sent seconds since 1970 (main design, item 16).
  earliestRefreshAt: z.unknown().optional(),
  scopes: z.array(z.string()),
});

// One record per registration: OpenAI's issued client ID and the account's checked `sub`. The email is
// shown, never used as the key, because two records can share one (accounts and sessions page).
const AccountSchema = z.object({
  clientId: z.string(),
  sub: z.string(),
  email: z.string().optional(),
  // The last ID token, sent as `id_token_hint` so OpenAI skips its account picker. Deleted at logout.
  idToken: z.string().optional(),
});

const LoginSchema = z.object({
  version: z.number().int(), // raised by every change
  hostId: z.string(), // `urn:uuid:...`, made once per machine
  noticeShown: z.boolean(), // OpenAI's one-time "You're using your ChatGPT plan" notice
  accounts: z.array(AccountSchema), // most recently signed in first
  // A client ID OpenAI issued for a sign-in that has not finished. Saved before the code is exchanged,
  // as the docs advise, and used for the next attempt.
  pending: z.object({ clientId: z.string() }).optional(),
  active: z
    .object({
      clientId: z.string(),
      sub: z.string(),
      planUse: z.boolean(), // whether `chatgpt.tokens.use.direct` was granted
      tokens: TokensSchema.optional(), // gone once signed out
      sealed: z.string().optional(), // with `keychain`: the tokens, sealed with the keychain's key
    })
    .optional(),
  // The tokens are sealed with a key kept in the system keychain.
  keychain: z.boolean().optional(),
});

// The key's name in the keychain, by the data folder's machine ID, so data folders never share one.
const keyName = (login: SavedLogin) => `chatgpt.${login.hostId}`;

// AES-256-GCM: a 32-byte key (FIPS 197) and a new random 12-byte nonce for each seal, the size NIST
// SP 800-38D (section 8.2) recommends, with GCM's full 16-byte tag. Sealed: nonce, tag, then text.
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function seal(key: string, tokens: Tokens): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), nonce, { authTagLength: TAG_BYTES });
  const text = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), text]).toString("base64");
}

// The tokens, or undefined for another key or a changed file.
function unseal(key: string, sealed: string): Tokens | undefined {
  try {
    const raw = Buffer.from(sealed, "base64");
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "base64"), raw.subarray(0, NONCE_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAuthTag(raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
    const text = Buffer.concat([decipher.update(raw.subarray(NONCE_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
    return TokensSchema.parse(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export type Tokens = z.infer<typeof TokensSchema>;
export type Account = z.infer<typeof AccountSchema>;
export type SavedLogin = z.infer<typeof LoginSchema>;

export class LoginError extends Error {}

// What is saved from a token response, after a sign-in or a renewal.
export function tokensFrom(t: TokenResponse): Tokens {
  return {
    access: t.access_token,
    refresh: t.refresh_token,
    expiresAt: Date.now() + t.expires_in * 1000,
    ...(t.earliest_refresh_at === undefined ? {} : { earliestRefreshAt: t.earliest_refresh_at }),
    scopes: t.scope.split(" "),
  };
}

export class LoginStore {
  readonly file: string;
  readonly lockFile: string;

  constructor(
    dir: string,
    private readonly warn: (message: string) => void = (m) => console.error(m),
    private readonly keychain: Keychain = systemKeychain(),
  ) {
    this.file = path.join(dir, "chatgpt.json");
    this.lockFile = path.join(dir, "chatgpt.lock");
  }

  // The login as saved now. A damaged file is an error, never replaced: it holds the client IDs.
  read(): SavedLogin {
    const text = readPrivate(this.file, this.warn);
    if (text === null) return { version: 0, hostId: `urn:uuid:${randomUUID()}`, noticeShown: false, accounts: [] };
    let parsed;
    try {
      parsed = LoginSchema.safeParse(JSON.parse(text));
    } catch {
      parsed = undefined;
    }
    if (!parsed?.success) throw new LoginError(`The saved login in ${this.file} is damaged. Move it aside, then sign in again with \`tachi login chatgpt\` (or /login chatgpt in a session).`);
    const login = parsed.data;
    const active = login.active;
    if (!active?.sealed) return login;
    // Sealed with the keychain's key. No key, another key, a changed file or a keychain that cannot be
    // used: signed out, so that both logout and signing in again work.
    let why = "The key in the system keychain is missing or does not fit.";
    let tokens: Tokens | undefined;
    try {
      const key = this.keychain.read(keyName(login));
      tokens = key === null ? undefined : unseal(key, active.sealed);
    } catch (err) {
      if (!(err instanceof KeychainError)) throw err;
      why = err.message;
    }
    const { sealed: _, ...rest } = active;
    if (tokens) return { ...login, active: { ...rest, tokens } };
    this.warn(`${why} The saved ChatGPT login is not used; sign in again with \`tachi login chatgpt\` (or /login chatgpt in a session).`);
    return { ...login, active: undefined };
  }

  // Writes the whole login. With the keychain, the tokens are sealed with its key. The key is made
  // once and goes into the keychain before anything is sealed with it, so the file, written whole,
  // never refers to a key that is not there yet.
  #write(login: SavedLogin): void {
    let onDisk = login;
    const active = login.active;
    if (login.keychain && active?.tokens) {
      const name = keyName(login);
      let key = this.keychain.read(name);
      if (key === null || Buffer.from(key, "base64").length !== KEY_BYTES) {
        key = randomBytes(KEY_BYTES).toString("base64");
        this.keychain.write(name, key);
      }
      const { tokens, ...rest } = active;
      onDisk = { ...login, active: { ...rest, sealed: seal(key, tokens) } };
    }
    writePrivate(this.file, `${JSON.stringify(onDisk, null, 2)}\n`);
    if (login.keychain && !active) {
      // Signed out: the key goes too. A keychain that cannot be used keeps it, opening nothing.
      try {
        this.keychain.clear(keyName(login));
      } catch (err) {
        if (!(err instanceof KeychainError)) throw err;
      }
    }
  }

  // Runs `fn` holding the lock, with the login read after the lock was taken. Each `save` raises the
  // version and writes the whole file; it returns what was saved.
  // Ctrl-C (`signal`) stops a wait for the lock.
  update<T>(fn: (current: SavedLogin, save: (next: SavedLogin) => SavedLogin) => Promise<T>, signal?: AbortSignal): Promise<T> {
    privateDir(path.dirname(this.file)); // the lock lives there too
    return withLock(
      this.lockFile,
      async () => {
        const current = this.read();
        let version = current.version;
        const save = (next: SavedLogin) => {
          const saved = { ...next, version: ++version };
          this.#write(saved);
          return saved;
        };
        return fn(current, save);
      },
      (pid) => this.warn(`Waiting for Tachikoma (process ${pid}) to finish changing the ChatGPT login. Ctrl-C stops waiting. If no Tachikoma is running, delete ${this.lockFile}.`),
      signal,
    );
  }
}
