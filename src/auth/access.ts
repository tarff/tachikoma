import { errorText } from "../core/types.js";
import { discover, ISSUER, OAuthError, PLAN_SCOPE, refresh } from "./oauth.js";
import { LoginError, type LoginStore, type SavedLogin, type Tokens, tokensFrom } from "./store.js";

// Renewing the login before a request (release 2 design, "Renewing"). A login lasts an hour; each
// renewal gives a new one and replaces the renewal token (token reference page).

// Renewed when less than this is left, as OpenAI's example code does (release 2 design).
const RENEW_BEFORE_MS = 60_000;

// OpenAI's docs name `earliest_refresh_at` but not its units. Read as seconds since 1970, the unit the
// Responses API uses for its own times (`created_at`), until the first real sign-in shows otherwise
// (plan, Task 7). Anything else is not understood, so it never holds a renewal back.
function earliestMs(t: Tokens): number {
  return typeof t.earliestRefreshAt === "number" ? t.earliestRefreshAt * 1000 : 0;
}

const due = (t: Tokens, now: number) => t.expiresAt - now < RENEW_BEFORE_MS && now >= earliestMs(t);

// The refresh errors after which a login cannot be used again (errors and recovery page).
const DEAD = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);

export const SIGN_IN_AGAIN = "Sign in to ChatGPT with `tachi login chatgpt` (or /login chatgpt in a session), or switch with /lead.";

function usable(login: SavedLogin): { clientId: string; sub: string; tokens: Tokens } {
  const a = login.active;
  if (!a?.tokens) throw new LoginError(`Not signed in to ChatGPT. ${SIGN_IN_AGAIN}`);
  if (!a.planUse) throw new LoginError("Using your ChatGPT plan was not allowed when you signed in. Sign out and in again and allow it, or use openai:<model> with an API key.");
  return { clientId: a.clientId, sub: a.sub, tokens: a.tokens };
}

// A token, and which registration and account it is for.
export interface Access {
  token: string;
  account: string;
}

const access = (u: ReturnType<typeof usable>): Access => ({ token: u.tokens.access, account: `${u.clientId} ${u.sub}` });

export class ChatGPTAuth {
  constructor(
    readonly store: LoginStore,
    private readonly issuer = ISSUER,
  ) {}

  // Checked when a `chatgpt:` lead is chosen, so a signed-out lead fails at once.
  check(): void {
    usable(this.store.read());
  }

  // The access token for the next request. The saved login is read every time, so a logout or a
  // renewal by another process is seen at once. Ctrl-C (`signal`) stops a renewal.
  async token(signal?: AbortSignal): Promise<Access> {
    const now = usable(this.store.read());
    if (!due(now.tokens, Date.now())) return access(now);
    // Under the lock, and read again: another process may have renewed it already.
    return this.store.update(async (login, save) => {
      const current = usable(login);
      if (!due(current.tokens, Date.now())) return access(current);
      let t;
      try {
        t = await refresh(await discover(this.issuer, signal), { clientId: current.clientId, refreshToken: current.tokens.refresh }, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        if (err instanceof OAuthError && err.code && DEAD.has(err.code)) {
          save({ ...login, active: undefined });
          throw new LoginError(`Your ChatGPT sign-in has expired or was cancelled. ${SIGN_IN_AGAIN}`);
        }
        throw new LoginError(`Could not renew the ChatGPT sign-in. ${errorText(err)} You are still signed in, so you can try again.`);
      }
      // Access token, expiry, scopes and renewal token are replaced together (sign-in page). Plan use
      // can be taken away at a renewal, and then this request is refused too.
      const tokens = tokensFrom(t);
      return access(usable(save({ ...login, active: { ...login.active!, planUse: tokens.scopes.includes(PLAN_SCOPE), tokens } })));
    }, signal);
  }
}
