import { errorText } from "../core/types.js";
import { discover, ISSUER, OAuthError, PLAN_SCOPE, refresh } from "./oauth.js";
import { LoginError, type LoginStore, type SavedLogin, type Tokens, tokensFrom } from "./store.js";

// Renewing the login before a request (release 2 design, "Renewing"). A login lasts an hour; each
// renewal gives a new one and replaces the renewal token (token reference page).

// Renewed when less than this is left, as OpenAI's example code does (release 2 design).
const RENEW_BEFORE_MS = 60_000;

// OpenAI's docs name `earliest_refresh_at` but not its units. It is seconds since 1970: at the first
// real sign-in it was 361 s before the access token expired (main design, item 16). Anything else
// is not understood, so it never holds a renewal back.
function earliestMs(t: Tokens): number {
  return typeof t.earliestRefreshAt === "number" ? t.earliestRefreshAt * 1000 : 0;
}

const due = (t: Tokens, now: number) => t.expiresAt - now < RENEW_BEFORE_MS && now >= earliestMs(t);

// The refresh errors after which a login cannot be used again (errors and recovery page).
const DEAD = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);

const SIGN_IN_AGAIN = "Sign in with `tachi login chatgpt` (or /login chatgpt in a session), or choose another lead (--lead, or /lead in a session).";

function usable(login: SavedLogin): { clientId: string; sub: string; tokens: Tokens } {
  const a = login.active;
  // A sealed login that cannot be opened (store.ts) waits for a logout before a new sign-in.
  if (a?.sealed && !a.tokens) throw new LoginError("The saved ChatGPT login cannot be opened. Sign out with `tachi logout chatgpt` (or /logout chatgpt in a session), then sign in again, or choose another lead (--lead, or /lead in a session).");
  if (!a?.tokens) throw new LoginError(`Not signed in to ChatGPT. ${SIGN_IN_AGAIN}`);
  if (!a.planUse) throw new LoginError("This ChatGPT sign-in does not allow using your plan. Sign out with `tachi logout chatgpt` (or /logout chatgpt in a session), sign in again and allow it, or use openai:<model> with an API key.");
  return { clientId: a.clientId, sub: a.sub, tokens: a.tokens };
}

// A token, and which registration and account it is for.
export interface Access {
  token: string;
  account: string;
}

const access = (u: ReturnType<typeof usable>): Access => ({ token: u.tokens.access, account: `${u.clientId} ${u.sub}` });

// Rejects with the abort as soon as `signal` is aborted, and leaves `work` to finish on its own.
function unlessAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

export class ChatGPTAuth {
  constructor(
    private readonly store: LoginStore,
    private readonly issuer = ISSUER,
  ) {}

  // Checked when a `chatgpt:` lead is chosen, so a signed-out lead fails at once.
  check(): void {
    usable(this.store.read());
  }

  // The access token for the next request. The saved login is read every time, so a logout or a
  // renewal by another process is seen at once. Ctrl-C (`signal`) stops the wait at once, but a
  // renewal already sent carries on and is saved: OpenAI replaces the renewal token as it answers,
  // so losing the answer would sign the user out. An answer that never comes, Node gives up on
  // (after 300 s, undici's default).
  async token(signal?: AbortSignal): Promise<Access> {
    const now = usable(this.store.read());
    if (!due(now.tokens, Date.now())) return access(now);
    // Under the lock, and read again: another process may have renewed it already.
    const renewal = this.store.update(async (login, save) => {
      const current = usable(login);
      if (!due(current.tokens, Date.now())) return access(current);
      let t;
      try {
        const ep = await discover(this.issuer, signal);
        signal?.throwIfAborted(); // not sent yet, so Ctrl-C still stops it
        t = await refresh(ep, { clientId: current.clientId, refreshToken: current.tokens.refresh });
      } catch (err) {
        if (err instanceof OAuthError && err.code && DEAD.has(err.code)) {
          save({ ...login, active: undefined });
          throw new LoginError(`Your ChatGPT sign-in has expired or was cancelled. ${SIGN_IN_AGAIN}`);
        }
        // "Invalid client: `invalid_client`. Fix the client configuration." (errors and recovery page)
        if (err instanceof OAuthError && err.code === "invalid_client") {
          throw new LoginError(`Could not renew the ChatGPT sign-in. ${errorText(err)} OpenAI did not accept Tachikoma's registration, so trying again will not help. Sign out with \`tachi logout chatgpt\`, then register again with \`tachi login chatgpt --new\` (or /logout chatgpt and /login chatgpt --new in a session).`);
        }
        throw new LoginError(`Could not renew the ChatGPT sign-in. ${errorText(err)} You are still signed in, so you can try again.`);
      }
      // Access token, expiry, scopes and renewal token are replaced together (sign-in page). Plan use
      // can be taken away at a renewal, and then this request is refused too.
      const tokens = tokensFrom(t);
      let saved;
      try {
        saved = save({ ...login, active: { ...login.active!, planUse: tokens.scopes.includes(PLAN_SCOPE), tokens } });
      } catch (err) {
        // OpenAI has already replaced the saved renewal token, so the saved login will not renew again.
        throw new LoginError(`OpenAI renewed your ChatGPT sign-in, but saving it failed (${errorText(err)}). The saved sign-in cannot be renewed again, so sign out with \`tachi logout chatgpt\` (or /logout chatgpt in a session), then sign in again.`);
      }
      return access(usable(saved));
    }, signal);
    return unlessAborted(renewal, signal);
  }
}
