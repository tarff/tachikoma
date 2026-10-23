import { spawn } from "node:child_process";
import { dataDir } from "../core/datadir.js";
import { errorText } from "../core/types.js";
import { commandEnv, system32 } from "../exec/env.js";
import { authorizeUrl, discover, exchange, FIRST_CLIENT, ISSUER, listen, newAttempt, PLAN_SCOPE, revoke, verifyIdToken } from "./oauth.js";
import { type Account, LoginError, LoginStore, type SavedLogin, tokensFrom } from "./store.js";

// Signing in and out (release 2 design, "Signing in" and "Signing out"). The wording comes from
// OpenAI's interface guidelines (developers.openai.com/siwc/ui-ux-guidelines).

export const USAGE_URL = "https://chatgpt.com/settings/usage";
const NOTICE = `You're using your ChatGPT plan. Eligible usage in this app uses your ChatGPT plan. Manage usage: ${USAGE_URL}`;

export interface LoginIO {
  say(line: string): void;
  openBrowser(url: string): void;
}

// The system's own way to open an address, with no shell in between and no API keys passed on.
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32" ? [system32("rundll32.exe"), ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true, env: commandEnv() });
  child.on("error", () => {}); // no browser: the address is printed anyway
  child.unref();
}

// The words after `login` or `logout`, on the command line or after `/login` in a session.
export function loginArgs(words: string[], verb: "login" | "logout"): { account?: number; fresh?: boolean } {
  const [provider, ...rest] = words;
  if (provider !== "chatgpt") throw new LoginError(`Only ChatGPT has a ${verb}: \`${verb} chatgpt\`. Other providers use an API key.`);
  if (verb === "logout" && rest.length) throw new LoginError("Usage: logout chatgpt");
  if (rest.length === 1 && rest[0] === "--new") return { fresh: true };
  if (rest.length === 2 && rest[0] === "--account" && /^[1-9]\d*$/.test(rest[1]!)) return { account: Number(rest[1]) };
  if (rest.length) throw new LoginError("Usage: login chatgpt [--new | --account <number>]");
  return {};
}

const signedIn = (login: SavedLogin) => (login.active?.tokens ? login.active : undefined);
const who = (login: SavedLogin, a = signedIn(login)) => login.accounts.find((x) => x.clientId === a?.clientId && x.sub === a?.sub)?.email ?? "your ChatGPT account";

// Which saved account to sign in to: the only one, the one asked for, or a new one.
function choose(login: SavedLogin, opts: { account?: number; fresh?: boolean }): Account | undefined {
  if (opts.fresh) return undefined;
  if (opts.account !== undefined) {
    const a = login.accounts[opts.account - 1];
    if (!a) throw new LoginError(`There is no saved account ${opts.account}.`);
    return a;
  }
  if (login.accounts.length === 0) return undefined;
  if (login.accounts.length === 1) return login.accounts[0];
  // One person registered twice has one email twice; the client IDs tell those apart.
  const name = (a: Account) => a.email ?? a.sub;
  const twice = (a: Account) => login.accounts.filter((b) => name(b) === name(a)).length > 1;
  const list = login.accounts.map((a, i) => `  ${i + 1}. ${name(a)}${twice(a) ? ` (${a.clientId})` : ""}`).join("\n");
  throw new LoginError(`Saved ChatGPT accounts:\n${list}\nChoose one with \`tachi login chatgpt --account <number>\`, or add another with \`--new\`.`);
}

export async function signIn(store: LoginStore, io: LoginIO, opts: { account?: number; fresh?: boolean; issuer?: string; signal?: AbortSignal } = {}): Promise<void> {
  // Under the lock: check, choose the client ID, and save the machine ID before its first use.
  const start = await store.update(async (login, save) => {
    if (signedIn(login)) throw new LoginError(`Already signed in as ${who(login)}. Sign out first with \`tachi logout chatgpt\`.`);
    const account = choose(login, opts);
    const saved = save(login);
    // An unfinished registration's issued ID is used again, as the docs say after a failed exchange.
    return { account, hostId: saved.hostId, version: saved.version, clientId: account?.clientId ?? login.pending?.clientId ?? FIRST_CLIENT };
  }, opts.signal);

  // Asked for after that check, so a signed-in user who is offline is still told so.
  const ep = await discover(opts.issuer ?? ISSUER, opts.signal);

  // The browser part holds no lock: the user can take as long as they like, or press Ctrl-C.
  const attempt = newAttempt();
  const listener = await listen(attempt.state, opts.signal);
  let reply: URLSearchParams;
  try {
    const url = authorizeUrl(ep, {
      clientId: start.clientId,
      hostId: start.hostId,
      redirectUri: listener.redirectUri,
      ...attempt,
      ...(start.account?.idToken ? { idTokenHint: start.account.idToken } : {}),
      ...(start.account?.email ? { loginHint: start.account.email } : {}),
    });
    listener.begin(url);
    io.say("Continue with ChatGPT in your browser.");
    io.openBrowser(listener.startUri);
    io.say(`If no browser opened, go to ${listener.startUri}`);
    reply = await listener.reply;
  } finally {
    listener.close();
  }
  const error = reply.get("error");
  if (error) throw new LoginError(error === "access_denied" ? "Sign-in was declined in the browser." : `Sign-in failed (${error}).`);
  const code = reply.get("code");
  if (!code) throw new LoginError("OpenAI's reply had no sign-in code. Try again.");
  const returned = reply.get("client_id");
  let clientId = start.clientId;
  if (clientId === FIRST_CLIENT) {
    if (!returned) throw new LoginError("OpenAI did not issue a client ID, so registration did not finish. Try again.");
    clientId = returned;
  } else if (returned && returned !== clientId) {
    throw new LoginError("OpenAI answered with a different client ID than the one saved for this account, so the result was refused.");
  }

  // Under the lock again. A logout or another sign-in in the meantime wins.
  const done = await store.update(async (login, save) => {
    if (login.version !== start.version) throw new LoginError("The saved login changed while you were signing in, for example by a logout. Sign in again.");
    if (start.clientId === FIRST_CLIENT) login = save({ ...login, pending: { clientId } }); // saved before the exchange
    const t = await exchange(ep, { clientId, code, verifier: attempt.verifier, redirectUri: listener.redirectUri }, opts.signal);
    if (!t.id_token) throw new LoginError("OpenAI's reply had no ID token, so the account could not be checked.");
    const id = await verifyIdToken(ep, t.id_token, { clientId, nonce: attempt.nonce }, opts.signal);
    opts.signal?.throwIfAborted(); // Ctrl-C after the last answer: nothing is saved
    if (start.account && id.sub !== start.account.sub) {
      // OpenAI has signed that account in, so its sign-in is cancelled, as at a logout.
      const other = `That was a different ChatGPT account from ${start.account.email ?? "the saved one"}`;
      const again = "To add another account, run `tachi login chatgpt --new`.";
      try {
        await revoke(ep, { clientId, refreshToken: t.refresh_token }, opts.signal);
      } catch (err) {
        const why = opts.signal?.aborted ? "You stopped waiting for its answer." : errorText(err);
        const left = `${other}, and OpenAI did not confirm that its sign-in was cancelled. ${why} You can disconnect Tachikoma in that account's ChatGPT settings.`;
        if (!opts.signal?.aborted) throw new LoginError(`${left} ${again}`);
        io.say(left); // the command then says "Sign-in was cancelled."
        throw err;
      }
      throw new LoginError(`${other}, so its sign-in was cancelled. ${again}`);
    }
    const tokens = tokensFrom(t);
    const planUse = tokens.scopes.includes(PLAN_SCOPE);
    const account: Account = { clientId, sub: id.sub, ...(id.email ? { email: id.email } : {}), idToken: t.id_token };
    const others = login.accounts.filter((a) => a.clientId !== clientId || a.sub !== id.sub);
    // Another account's unfinished registration stays, for the next `--new`.
    save({ ...login, pending: login.pending?.clientId === clientId ? undefined : login.pending, accounts: [account, ...others], noticeShown: login.noticeShown || planUse, active: { clientId, sub: id.sub, planUse, tokens } });
    return { email: id.email ?? "your ChatGPT account", planUse, notice: planUse && !login.noticeShown };
  }, opts.signal);

  if (done.notice) io.say(NOTICE);
  if (done.planUse) io.say(`Signed in as ${done.email}.`);
  else io.say(`Signed in as ${done.email}, but using your ChatGPT plan was not allowed. To use it, sign out and in again and allow it; or use openai:<model> with an API key.`);
}

// `login chatgpt …` or `logout chatgpt`, typed on the command line or in a session.
export async function accountCommand(verb: "login" | "logout", words: string[], say: (line: string) => void, signal?: AbortSignal): Promise<void> {
  const opts = loginArgs(words, verb);
  const store = new LoginStore(dataDir(), say);
  const io = { say, openBrowser };
  try {
    if (verb === "login") await signIn(store, io, { ...opts, ...(signal ? { signal } : {}) });
    else await signOut(store, io, signal ? { signal } : {});
  } catch (err) {
    if (signal?.aborted) throw new LoginError(verb === "login" ? "Sign-in was cancelled." : "Sign-out was cancelled.");
    throw err;
  }
}

export async function signOut(store: LoginStore, io: LoginIO, opts: { issuer?: string; signal?: AbortSignal } = {}): Promise<void> {
  // First, under the lock, the tokens and every saved ID token go, so nothing can use them from here
  // on, even when the login could not be read. The client IDs and the machine ID stay, as the docs say.
  const ended = await store.update(async (login, save) => {
    const active = login.active;
    const accounts = login.accounts.map(({ idToken: _, ...kept }) => kept);
    // Saved even with nobody signed in: the new version refuses a sign-in still waiting in the browser.
    if (login.version > 0) save({ ...login, active: undefined, accounts });
    return active;
  }, opts.signal);
  if (!ended) return io.say("Not signed in to ChatGPT.");
  // Then OpenAI is asked to cancel the renewal token, with no lock held and nothing left on disk, so a
  // slow answer keeps nothing. Ctrl-C stops the wait.
  let problem: string | undefined;
  if (ended.tokens) {
    try {
      await revoke(await discover(opts.issuer ?? ISSUER, opts.signal), { clientId: ended.clientId, refreshToken: ended.tokens.refresh }, opts.signal);
    } catch (err) {
      problem = opts.signal?.aborted ? "You stopped waiting for its answer." : errorText(err);
    }
  }
  io.say(
    problem
      ? `Signed out on this computer, but OpenAI did not confirm that the sign-in was cancelled. ${problem} You can disconnect Tachikoma in ChatGPT's settings.`
      : "Signed out of ChatGPT.",
  );
}
