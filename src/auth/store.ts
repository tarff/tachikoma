import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
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
    })
    .optional(),
});

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
    return parsed.data;
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
          writePrivate(this.file, `${JSON.stringify(saved, null, 2)}\n`);
          return saved;
        };
        return fn(current, save);
      },
      (pid) => this.warn(`Waiting for Tachikoma (process ${pid}) to finish changing the ChatGPT login. Ctrl-C stops waiting. If no Tachikoma is running, delete ${this.lockFile}.`),
      signal,
    );
  }
}
