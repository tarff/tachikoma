# Tachikoma Release 2 (Sign in with ChatGPT): Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** An OpenAI model can lead on the user's ChatGPT plan: `tachi login chatgpt` signs in through
OpenAI's flow for open-source tools, and `--lead chatgpt:<model>` sends the requests. Also in this
release: the hardening that keeps keys and the login away from the model's tools, a `/model` picker
for every provider, and a status line that shows how much context is left.

**Architecture:** Signing in lives in `src/auth/`. A private file (`chatgpt.json` in Tachikoma's data
folder) holds the login. Every change to it goes through one lock shared by all Tachikoma processes,
and raises a version number. A new provider, `src/providers/chatgpt.ts`, reads the login before each
request, renews it when needed, and talks to OpenAI's Responses API with streaming on and storage
off. Everything else (the session, the bus, the interface) is release 1's, with small additions.
Design: `docs/plans/2026-10-22-tachikoma-release-2-design.md`.

**Tech stack:** as release 1 (Node 22+, TypeScript 7.0.2, Ink 7.1.1, `openai` 7.30.0, zod 4.6.5,
Vitest 5.0.3), plus `@napi-rs/keyring` 2.1.0 for the optional keychain (Task 13). The ID token is
checked with Node's own `crypto`, so no JWT package is needed.

---

## Before you start

**This plan's code has already been run, one task at a time.** On 2026-10-23 every task below was
built in a scratch copy of the repo, in order. After each task: typecheck, then the whole test suite.
Every code block was copied by script from those commits, not retyped. After Task 14: Test Files 26 passed | 2 skipped (28); Tests 412 passed | 6 skipped (418).
The tests left out are:
- the two live checks (Tasks 7 and 14), and release 1's, which run only with `TACHI_LIVE=1`;
- on Windows, the macOS/Linux file-mode test (Task 3);
- the link test (Task 3) on a Windows machine without Developer Mode, which cannot make file links.

**Not run yet:** anything against the real OpenAI, and the macOS and Linux branches of Tasks 3 and 13
(file modes, the macOS Keychain, the Linux secret service). Each test says which systems it runs on.

**Stop after Task 7.** The design puts the first real sign-in before the adapter
(release 2 design, "Order of building"). Task 7 says what to record and what each result changes.

**Choices this plan makes that the design leaves open.** Each is marked in its task. All eight were
approved by the user on 2026-10-23 (choices 3 and 5 after the reviews, the other six as written).
1. **Choosing an account.** One saved account is signed in to again. With several saved, sign-in lists
   them and asks for `--account <number>`, showing the client ID where two share an email. `--new`
   registers another account. (The design says one
   account at a time and a separate record per account, but not how to choose one.)
2. **A local start address.** Sign-in prints and opens `http://127.0.0.1:<port>/auth/start`. That
   address forwards the browser to OpenAI, once. The full address carries the ID token sent as a hint, and
   printing it, or putting it on the browser's command line where other programs can read it, would
   break the design's "Tokens never appear in ... any address".
3. **Waiting for the lock** wakes when the lock file changes, and also every 5 s, because a process
   killed outright changes nothing in the folder. You chose 5 s, proper-lockfile's default, on
   2026-10-23. A lock left by a killed process is taken over, and so is one made before the computer
   last started (your choice after Task 2's review); a waiting process says which process it is
   waiting for, and names the lock file.
4. **The model is checked against the account's model list** on the first request. A model not
   offered is an error that lists the models that are.
5. **`--keychain` keeps an encryption key in the keychain, and the tokens stay in the private file,
   sealed with it** (AES-256-GCM). You chose this on 2026-10-23, after the second review (see
   "Different from the design"). Moving back from the keychain is: sign out, then sign in without
   `--keychain`.
6. **`TACHI_DATA_DIR` moves the data folder.** The tests need it, since some run Tachikoma as a
   separate process; users can use it too.
7. **The status line shows "ChatGPT plan + $0.42"** when API models were also paid for in the same
   session, so a cost already spent is not hidden.
8. **The login file is refused if it has another name (a hard link)**, as a link in its place is.

**Different from the design:**
- **The adapter reads the login itself before each request** and gives the SDK a plain key. The design
  says the login is passed to the SDK as a function; `openai` 7.30.0 does take one
  (`ApiKeySetter`), but wraps its errors ("Failed to get token from 'apiKey' function: ...") and ties
  it to its realtime cache. The effect the design wants is the same: a renewed login is used at once.
- **`earliest_refresh_at` is read as seconds since 1970** until the first real sign-in shows its form.
  OpenAI's docs name the field but not its meaning or units; the Responses API's own times
  (`created_at`) are in seconds. Task 7 checks it, and Task 8 says what to change if it differs.
- **Signing out deletes the tokens first, then asks OpenAI to revoke.** The design marks the login
  signed out, revokes, then deletes. Deleting first leaves nothing on disk, and holds no lock, while
  OpenAI answers, so a stalled answer needs no deadline. The design's aim, that nothing starts after a
  logout, holds.
- **`--keychain` keeps a key, not the tokens.** The design keeps the tokens in the keychain. Windows
  holds at most 2,560 bytes in one entry (1,281 characters were refused on this machine), so the
  tokens had to be split across entries, and a request reading them without the lock could join
  pieces from two saves (second review). The key is written once, and the file is always written
  whole, so a read is always of one save. The tokens are still unreadable without the keychain. A
  missing key, another key or a changed file counts as signed out, where the design refuses a
  mismatch; the login is still never used, and the user can sign out or in again.
- **No blanking step is needed.** The design says the sign-in reply's address, the code, the PKCE
  value and login headers are blanked before they reach events or logs. In this code none of them is
  ever passed to an event, an error or the log, and the tests check the errors and printed lines.
- **No fallback table for the context window** (the user's choice, 2026-10-23, at Task 9's review). The
  design falls back on the API's model pages, but their 1,050,000 tokens for `gpt-6.1-sol` is twice
  the 500,000 the plan's own list gave at the first real sign-in (main design, item 16), and the list
  has always had the field. With no figure, the tokens in use are shown. The status line reads the
  window from the list the last request fetched, so it never reads or renews the login itself: a
  renewal there that found the login dead would clear it with nothing shown.
- **Two permission codes say to sign in again, not to use an API key** (the user's choice,
  2026-10-23). For `chatpass_v2_scope_not_authorized` and `chatpass_v2_invalid_authorization_context`,
  OpenAI's errors page says "Check the client and grant configuration rather than retrying or
  changing billing." The design groups them with "not eligible".

**Numbers in the code, and where each came from:**

| Value | Source |
|---|---|
| Renew when under 60 s are left | Release 2 design, "Renewing" (OpenAI's example code) |
| A lock waiter rechecks the owner every 5 s | The user's choice, 2026-10-23: proper-lockfile's default `update` (half its 10,000 ms `stale`; its README). It sets only how long a waiter can sit behind a killed owner |
| 32 random bytes for the PKCE verifier, `state` and `nonce` | RFC 7636 section 4.1 recommends 32 octets for the verifier |
| A 32-byte key, a 12-byte nonce and a 16-byte tag for `--keychain` | AES-256's key size (FIPS 197); NIST SP 800-38D section 8.2 recommends 96-bit nonces for GCM; 16 bytes is GCM's full tag |
| 15 s for the command-line tests | Measured: each start takes about 1.1 s; with the whole suite running, two starts took up to 5.03 s, past Vitest's 5 s default. 15 s matches release 1's other process-starting tests |
| A login lasts 1 hour, a renewal 30 days | OpenAI's token reference; not used as a setting, only `expires_in` is |
| On Windows, a save waits up to 1 s for a reader to let go | Measured 2026-10-23 with two processes reading the file nonstop: of 3,000 saves, 27% were refused at first, and the slowest went through after 0.76 s. The user chose 1 s |

**Sources** (OpenAI's pages read 2026-10-23, under developers.openai.com/siwc/): the overview
`token-sharing-open-source` and its pages `sign-in`, `profiles-and-sessions` (accounts and sessions),
`models-and-inference`, `token-reference`, `errors-and-recovery` and `preview-limitations`; and
`ui-ux-guidelines`. OpenAI's discovery document at `https://auth.openai.com/.well-known/openid-configuration`
names the endpoints, including revocation (`/api/accounts/oauth/revoke`), and RS256 as the only
signing method. No code is taken from OpenAI's devkit, whose licence forbids commercial use.

**Known limits of release 2:**
- **An approved shell command on the host can still read the login file and the keychain** (release 2
  design, "What filtering cannot do"). The sandbox (release 3) is the answer.
- **Two processes taking over a dead process's lock at the same moment** can both go ahead. The lock
  file is read again just before it is removed, which narrows that moment but does not close it. The
  cost is one lost renewal, after which the user signs in again. Each removes the lock at the end only
  while it still holds its own pid, so neither lets a third process in.
- **An owner killed outright whose pid another program then gets, without a restart,** is waited for
  until that program ends. The waiting message names the lock file to delete. On Windows with Fast
  Startup (on by default), "Shut down" and switching on again is not a restart; Restart, a crash and
  a power cut are.
- **A clock that jumps forward while a lock is held,** by more than the time between start-up and
  taking the lock, makes a live owner's lock look older than the start, and it is taken over. A
  clock set by hand can do this, and so can WSL2 catching up after the host sleeps. Locks are held
  for seconds, so this needs the jump to land in that time.
- **`--effort` stays Anthropic-only** until a reasoning setting is shown to work on the plan
  (Task 14's live check).
- **No retries on the plan.** OpenAI asks for "bounded backoff" on some errors but gives no numbers,
  so Tachikoma reports the error and keeps the login (release 2 design, "Errors").
- **The context window is known only for Anthropic models, and for ChatGPT-plan models from the
  first reply on** (from the account's model list). Other models show the tokens in use.
- **A renewal in flight when Tachikoma is killed** (SIGTERM, SIGHUP, or a second Ctrl-C in `-p`)
  is lost, so the next request signs the user out. Only Ctrl-C lets it finish.
- **A clock more than about 5 minutes slow** sends an expired token for part of each hour:
  `earliest_refresh_at` comes from OpenAI's clock, 361 s before expiry at the first real sign-in
  (main design, item 16), and Tachikoma renews only when under 60 s are left and that time has
  passed on its own clock. OpenAI does not say what an earlier renewal does, so there is no data to
  change it. A clock set back after a renewal makes an expired token look fresh.
- **What `invalid_client` means for an app OpenAI registered on the fly** is not documented. The
  advice to register again with `--new` has not been tried against OpenAI.
- **A link to a data-folder file that does not exist yet** is treated as release 1 treats any link
  that leads nowhere: as outside the project, so `ask` and `project` ask first, but `never` does not.
  Making such a link takes macOS, Linux, or Windows with Developer Mode, and a login file that is
  not there (before the first sign-in or after a sign-out).
- **Before the first sign-in the data folder does not exist,** so there is no folder to compare by
  volume and file number. A write in `never` mode through another spelling of its path (`\\?\`,
  `\\localhost\C$`, or other case on macOS) can then make it. Signing in makes the folder private
  first (Task 3), but a file left in it is read.
- **A login saved from an administrator terminal** may be owned by the Administrators group, which
  Windows makes the owner of files an administrator creates. Later runs from a normal terminal
  would then refuse it as "belongs to another account". Not tried: this machine's session is not
  elevated.
- **A reply already streaming when the user signs out finishes.** Stopping it would mean holding the
  lock for every reply, which would block logout for as long as the reply runs. The next request is
  refused.
- **A leftover lock that another program holds open** (a backup or antivirus tool) is waited for
  without a message until that program lets go; the recheck tries again every 5 s.
- **Two login stores in one process that spell the data folder differently** (another case, or a
  short name) each think they hold the lock. Tachikoma makes every store from one path, `dataDir()`.
- **An older Tachikoma saving a login written by a newer one** drops the fields it does not know.

**Changed after review (2026-10-23).** Three reviews of this plan found fourteen problems; each is
fixed here, with a test that failed before the fix. The first review:
1. Two data folders shared one keychain login (Task 13): the key is now named by each folder's
   machine ID.
2. A keychain mismatch blocked logout as well as sign-in (Task 13): it now counts as signed out.
3. Logout with nobody signed in did not cancel a sign-in waiting in the browser (Task 6).
4. A waiter could wait for ever behind an owner killed outright, or a lock left empty (Task 2): the
   5 s recheck, and a lock that always holds its pid.
5. The first request could go out with a token read before a logout (Task 9).
6. Logout kept the tokens and the lock while OpenAI was slow, and ignored Ctrl-C (Task 6).
7. A renewal that took plan use away still let its request go out (Task 8).

The second review:
1. The keychain's pieces could be read half from one save and half from another (Task 13).
2. A missing piece still blocked logout and sign-in (Task 13).
3. A newer login from the keychain kept the file's older plan permission (Task 13).
4. Ctrl-C reached neither the lock wait nor the requests of sign-in and renewal, and a sign-in
   stopped during the code exchange could still be saved (Tasks 2, 4, 6 and 8).
5. The adapter kept one account's model list after a switch to another account (Tasks 8 and 9).

Problems 1 to 3 are gone with the key design in choice 5; 4 and 5 are fixed where they were.

The third review:
1. Logout kept the ID token when the login had already been dropped, such as when it could not be
   read, so the next sign-in sent its hint (Task 6): logout now deletes every saved ID token.
2. A switch to another account while the model list was fetched let the request go out with the new
   account's token, checked against the old account's list (Task 9): the model is checked again.

**Changed while building (2026-10-23).** The review after Task 1 found that in `never` mode the file
tools read and overwrote the login file through other spellings of its path: the short name
`TACHIK~1`, `\\?\C:\...` and `\\localhost\C$\...` (each tried on this machine). The data-folder rule
now also compares each folder by its volume and file number, which all six spellings tried share;
the user chose this on 2026-10-23. It covers macOS's ignored case too. The check of the fix found a
hard link in the project to the login file also got through; a file with more than one name is now
compared with the files in the data folder.

The review after Task 2 found:
1. A lock left by a process killed outright, or by a crash, blocked every later run once another
   program got its pid (shown with a live, unrelated process). A lock made before the computer last
   started is now taken over (the user's choice), and the waiting message names the lock file.
2. When two processes took over a dead lock at once, the first to finish removed the other's lock.
   Release now leaves a lock that does not hold its own pid.
3. No test failed if a cancelled call let the next one in early, or if the watcher never woke a
   waiter (only the 5 s recheck did). Both are tested now; each test was checked against the broken
   code.
4. The code-quality review found that a leftover lock another program held open (a backup or
   antivirus tool; `EBUSY`) was retried in a tight loop, freezing the process, Ctrl-C included, until
   the program let go (a 100 ms timer fired after 2 s). It now counts as busy, and the recheck tries
   again.

The review after Task 3 found, each shown on this machine:
1. A grant to an account whose name PowerShell cannot turn back into a SID (ALL APPLICATION
   PACKAGES) was left out of the check, so the file was read, and kept the grant. Permissions are
   now read as SIDs, and any PowerShell error fails the check.
2. A folder that let in only the user, but did not pass that to new files, was accepted; a file
   made in it let in Administrators and the system account. A folder's entry must now pass to its
   files, and other accounts' own entries on it are removed (before, every run failed with "Could
   not make ... private to you").
3. An entry on the folder for an account that no longer exists (a deleted user) cannot be removed by
   icacls, and the run stopped with icacls's own error. It now stops with "Could not make <folder>
   private to you", as other permissions that cannot be fixed do.
4. The code-quality review found that a write failing part way (a full disk) left its temporary copy
   of the login in the folder, where signing out would not remove it. It is now removed. Errors
   from PowerShell and `whoami` are caught, where before they were printed over the screen.

The review after Task 4 found no broken promise, but:
1. No test failed if the listener took connections at every address, if the discovery issuer was
   not checked, or if Ctrl-C did not reach the fetch of OpenAI's keys. Each is tested now, and each
   test was checked against the broken code.
2. `/auth/start` answered every request, so any program on the computer could ask it for the address
   that holds the ID token. It now answers once.
3. A token naming several audiences was accepted for any of them; `azp` is now checked. A reply that
   could not be read gave Node's own error, which quotes part of it; it now gives a sign-in error
   that quotes nothing. Ctrl-C before anyone waited for the browser's reply was an unhandled
   rejection, and the browser's connection stayed open after the reply.
4. The check of those fixes found that the start address, opened a second time (Tachikoma prints it
   in case no browser opened), gave a blank error page. It now says the sign-in was already opened.
5. The code-quality review found that one request line that is not an address (`GET //[`), which any
   program on the computer could send while sign-in waits, crashed Tachikoma: it is now turned away.
   Also: a browser's spare connection stayed open after the reply; Ctrl-C while a reply was arriving
   was reported as an unreadable reply; a token request followed redirects, form and all; an ID
   token header of `null` gave a plain TypeError. Each is fixed and tested.

The review after Task 5 found:
1. On Windows, a save failed (`EPERM`) whenever another Tachikoma had the login file open to read
   it; Windows will not replace an open file. Measured with two processes reading nonstop, 27% of
   3,000 saves were refused at first and the slowest went through after 0.76 s. The save now tries
   again for up to 1 s (the user's choice). A test holds the file open for 300 ms; it failed before.
2. No test checked the waiting message, and the two-process test could pass without the two ever
   overlapping. The message is tested now, and each process pauses between reading and saving.
3. Three limits, now listed above: a leftover lock held open by another program, two stores that
   spell the folder differently, and fields from a newer version dropped on save.
4. The code-quality review found that no test failed with the 1 s limit removed, which would freeze
   Tachikoma, Ctrl-C included, while another program held the file open. A test now holds it for
   2 s; the save gives up saying another program may have the file open, where before it gave Node's
   own error, and leaves the old file. The wait now keeps time if the clock is set. The 1 ms pause
   is about 16 ms on Windows (measured), and the comment says so. The open-file test now starts
   PowerShell by its full path, stops on any error, and gets the path through the environment.
   A save that gives up says another program may have the file open: the retry also covers a plain
   refusal.

The review after Task 6 found:
1. Removing Ctrl-C from most steps of sign-in and sign-out failed no test: the settings and key
   requests, the browser wait, the three lock waits, the "Sign-in was cancelled." wording, and the
   check just after OpenAI's last answer, without which a sign-in cancelled at that moment was
   saved (shown). Each step has a test now, and each was checked with its Ctrl-C removed.
2. A sign-in that could not reach OpenAI said only "fetch failed", for a refused redirect as for no
   network. Requests to the sign-in service now give Node's reason, such as "unexpected redirect"
   (Task 4).
3. Also fixed: a signed-in user who was offline got "fetch failed" rather than "Already signed in";
   signing in to a saved account dropped another account's unfinished registration, so the next
   `--new` registered again; Ctrl-C while OpenAI was asked to cancel the sign-in was reported in
   Node's words.
4. Left as it is: a `tachi login` killed outright while it holds the lock leaves the lock file,
   which the next run takes over (Task 2).
5. A script that set off each failure of sign-in, renewal and sign-out showed six where the user
   got Node's JSON error or a 9- to 33-line validator report: OpenAI's settings or keys replaced by
   a web page, such as a Wi-Fi login, or missing their fields, and an ID token missing its `sub`. A
   failure inside another message nested its brackets ("Could not renew the ChatGPT sign-in (The
   request to OpenAI's sign-in service failed (...)). It is kept; try again."). Every message is a
   full sentence now, one carried by another stands as its own sentence, and a reply that cannot
   be read says so (Tasks 4, 6, 8 and 13).
6. The code-quality review found: `--account 2` with no saved accounts registered a new one
   without a word; two registrations of one email looked the same in the list; Ctrl-C while
   OpenAI was asked to cancel the sign-in exited 0, where every other Ctrl-C exits 130; four
   messages had no test. All fixed, and the help now says `--account <number>`, as the errors do.
   The 130 is not tested: on Windows, Node cannot send a child process Ctrl-C, and ends it instead
   (Node's `subprocess.kill()` docs), so release 1's `-p` Ctrl-C is untested there too.
7. A sign-in refused for being a different account dropped the tokens OpenAI had just issued to
   it, leaving that account connected at OpenAI. They are cancelled now, as at a logout. If OpenAI
   does not confirm it, the user is told why, as at a logout, even when Ctrl-C stopped the wait
   (the re-check of this fix found that Ctrl-C hid it).

The review after Task 8 found:
1. Removing Ctrl-C from any step of a renewal failed no test: the wait for the lock, the settings
   request, and passing the abort on unwrapped (without it, Ctrl-C read "Could not renew the
   ChatGPT sign-in. This operation was aborted You are still signed in"). Each step has a test now,
   and each was checked with its Ctrl-C removed. The plan had also promised a message after Ctrl-C;
   like every Ctrl-C in a session, it says nothing more.
2. Only one of the six dead-login codes was tested, and none that is not dead; a logout landing
   while a renewal waited for the lock had no test. All have tests now, each checked by removing
   what it guards.
3. A renewal that took plan use away was reported as "not allowed when you signed in". The message
   now says what the sign-in allows, not when. Comments on `earliest_refresh_at` cite the first real
   sign-in (Tasks 5 and 8), and a check that could never fail is gone.
4. The code-quality review showed that Ctrl-C while OpenAI's renewal answer was arriving lost the
   new tokens: the saved renewal token was already spent, so the next request signed the user out,
   and the lost token stayed live at OpenAI for up to its 30 days (token reference page). A
   renewal already sent now carries on after Ctrl-C and is saved (the user's choice, over waiting
   for the answer, which a stalled answer would hold for up to 300 s, undici's default).
5. Also from that review: the usual renewal, with `earliest_refresh_at` present and passed, had no
   test, and a reading 1,000 times too late passed every test; the re-read under the lock was
   guarded only by the two-process test, which passed without it in 1 run of 6. Both have tests
   now, and a same-process test catches the re-read every time. `invalid_client` no longer says
   "try again" (the user's choice: point to `--new`). `SIGN_IN_AGAIN` and `store` are private.

## Tasks

### Task 1: Keys and the data folder out of the tools' reach

The design's hardening, done first because the saved login makes it matter (release 2 design,
"Hardening for every provider"):
- **Shell commands do not get the API keys** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `OPENROUTER_API_KEY`, `MOONSHOT_API_KEY`). Release 1's `LocalExecutor` passed its whole environment
  to every command. Windows ignores case in variable names, so the filter does too.
- **The file tools refuse Tachikoma's data folder** in every permission mode, `never` included, and
  after following links, so a link cannot get round it. Another spelling of the same path cannot
  either: each folder is also compared by what it is (its volume and file number), since Windows
  reaches one folder by its short name (`TACHIK~1`), by `\\?\` and by `\\localhost\C$`, and macOS
  ignores case. Nor can a hard link: a file with more than one name is compared with the files in
  the data folder.

`dataDir()` gives the folder the main design names for each system. `TACHI_DATA_DIR` moves it
(choice 6 in "Before you start").

**Files:**
- Create: `src/core/datadir.ts`
- Create: `src/exec/env.ts`
- Modify: `src/exec/local.ts`
- Modify: `src/tools/files.ts`
- Create: `tests/core/datadir.test.ts`
- Create: `tests/exec/env.test.ts`
- Modify: `tests/exec/local.test.ts`
- Modify: `tests/tools/files.test.ts`

**Step 1: Write the failing tests**

**Create `tests/core/datadir.test.ts`:**

```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dataDir } from "../../src/core/datadir.js";

describe("dataDir", () => {
  it("is the folder the design names on each system", () => {
    expect(dataDir({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32", "C:\\Users\\u")).toBe(path.join("C:\\Users\\u\\AppData\\Local", "tachikoma"));
    expect(dataDir({}, "darwin", "/Users/u")).toBe(path.join("/Users/u", "Library", "Application Support", "tachikoma"));
    expect(dataDir({}, "linux", "/home/u")).toBe(path.join("/home/u", ".local", "share", "tachikoma"));
  });

  it("can be moved with TACHI_DATA_DIR", () => {
    expect(dataDir({ TACHI_DATA_DIR: "/tmp/t" }, "linux", "/home/u")).toBe("/tmp/t");
  });
});
```

**Create `tests/exec/env.test.ts`:**

```ts
import { describe, expect, it } from "vitest";
import { API_KEYS, commandEnv } from "../../src/exec/env.js";
import { PRESETS } from "../../src/providers/openai.js";

describe("commandEnv", () => {
  it("covers every key a provider reads", () => {
    const read = ["ANTHROPIC_API_KEY", ...Object.values(PRESETS).flatMap((p) => (p.keyEnv ? [p.keyEnv] : []))];
    expect(API_KEYS.toSorted()).toEqual(read.toSorted());
  });

  it("drops the API keys, in any case, and keeps everything else", () => {
    const env = commandEnv({ PATH: "/bin", OPENAI_API_KEY: "sk-1", openrouter_api_key: "sk-2", MY_API_KEY: "mine" });
    expect(env).toEqual({ PATH: "/bin", MY_API_KEY: "mine" });
  });
});
```

**Change `tests/exec/local.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/exec/local.test.ts b/tests/exec/local.test.ts
index 06ff433..072bc69 100644
--- a/tests/exec/local.test.ts
+++ b/tests/exec/local.test.ts
@@ -1,7 +1,7 @@
 import { existsSync, readFileSync } from "node:fs";
 import { writeFile } from "node:fs/promises";
 import path from "node:path";
-import { describe, expect, it, onTestFinished } from "vitest";
+import { describe, expect, it, onTestFinished, vi } from "vitest";
 import { MAX_TOOL_OUTPUT } from "../../src/exec/executor.js";
 import { LocalExecutor } from "../../src/exec/local.js";
 import { tempContext } from "../helpers.js";
@@ -89,6 +89,16 @@ describe("LocalExecutor", () => {
     expect(marker).toMatch(/^\d+ more characters\]$/);
   }, 15_000);
 
+  it("does not pass the API keys to commands", async () => {
+    vi.stubEnv("OPENAI_API_KEY", "sk-secret");
+    onTestFinished(() => {
+      vi.unstubAllEnvs();
+    });
+    const root = await script(`console.log(process.env.OPENAI_API_KEY ?? "none", process.env.PATH ? "path" : "no path");`);
+    const r = await new LocalExecutor().exec("node script.js", root);
+    expect(r.stdout.trim()).toBe("none path");
+  }, 15_000);
+
   it("decodes characters split across chunks", async () => {
     // 3 bytes each, so some are certain to straddle a chunk boundary.
     const root = await script(`process.stdout.write("€".repeat(300000));`);
```

**Change `tests/tools/files.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tools/files.test.ts b/tests/tools/files.test.ts
index a3694f8..14c6f92 100644
--- a/tests/tools/files.test.ts
+++ b/tests/tools/files.test.ts
@@ -1,10 +1,11 @@
 import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
-import { realpathSync } from "node:fs";
+import { execFileSync } from "node:child_process";
+import { existsSync, linkSync, realpathSync } from "node:fs";
 import { tmpdir } from "node:os";
 import path from "node:path";
-import { describe, expect, it } from "vitest";
+import { afterEach, describe, expect, it, vi } from "vitest";
 import { MAX_TOOL_OUTPUT } from "../../src/exec/executor.js";
-import { editFileTool, readFileTool, resolveIn, writeFileTool } from "../../src/tools/files.js";
+import { editFileTool, programEnvironment, readFileTool, resolveIn, writeFileTool } from "../../src/tools/files.js";
 import { tempContext } from "../helpers.js";
 
 describe("resolveIn", () => {
@@ -17,6 +18,92 @@ describe("resolveIn", () => {
   });
 });
 
+describe("a program's environment, on Linux", () => {
+  it("is found by its real path, a thread's included", () => {
+    expect(programEnvironment("/proc/1234/environ")).toBe(true);
+    expect(programEnvironment("/proc/1234/task/1235/environ")).toBe(true);
+    expect(programEnvironment("/proc/1234/cmdline")).toBe(false);
+    expect(programEnvironment("/home/me/proc/1234/environ")).toBe(false);
+  });
+
+  it.runIf(process.platform === "linux")("is refused after following /proc/self", () => {
+    expect(() => resolveIn("/tmp", "/proc/self/environ")).toThrow("/proc/self/environ is a program's environment, which can hold API keys, so the file tools never read it");
+  });
+});
+
+describe("the data folder", () => {
+  afterEach(() => vi.unstubAllEnvs());
+
+  // The project itself holds the data folder here, so `never` mode would otherwise allow everything.
+  async function setup() {
+    const ctx = await tempContext("never");
+    const data = path.join(ctx.root, "data");
+    await mkdir(data);
+    await writeFile(path.join(data, "chatgpt.json"), "{}");
+    vi.stubEnv("TACHI_DATA_DIR", data);
+    return ctx;
+  }
+
+  it("is refused to every file tool, even in never mode", async () => {
+    const ctx = await setup();
+    const refused = "is in Tachikoma's data folder, which the file tools never touch";
+    await expect(readFileTool.run({ path: "data/chatgpt.json" }, ctx)).rejects.toThrow(refused);
+    await expect(writeFileTool.run({ path: "data/new.json", content: "x" }, ctx)).rejects.toThrow(refused);
+    await expect(editFileTool.run({ path: "data/chatgpt.json", old_text: "{}", new_text: "[]" }, ctx)).rejects.toThrow(refused);
+    await expect(readFileTool.run({ path: "data" }, ctx)).rejects.toThrow(refused);
+    expect(await readFile(path.join(ctx.root, "data", "chatgpt.json"), "utf8")).toBe("{}");
+  });
+
+  it("is refused through a link too", async () => {
+    const ctx = await setup();
+    // A junction on Windows needs no special rights; elsewhere it is an ordinary symlink.
+    await symlink(path.join(ctx.root, "data"), path.join(ctx.root, "innocent"), "junction");
+    await expect(readFileTool.run({ path: "innocent/chatgpt.json" }, ctx)).rejects.toThrow("Tachikoma's data folder");
+  });
+
+  it("is refused through a hard link to one of its files", async () => {
+    const ctx = await setup();
+    linkSync(path.join(ctx.root, "data", "chatgpt.json"), path.join(ctx.root, "innocent.json"));
+    await expect(readFileTool.run({ path: "innocent.json" }, ctx)).rejects.toThrow("Tachikoma's data folder");
+    await expect(writeFileTool.run({ path: "innocent.json", content: "x" }, ctx)).rejects.toThrow("Tachikoma's data folder");
+    expect(await readFile(path.join(ctx.root, "data", "chatgpt.json"), "utf8")).toBe("{}");
+    // Other hard-linked files, as a pnpm project is full of, are still read.
+    await writeFile(path.join(ctx.root, "a.txt"), "fine");
+    linkSync(path.join(ctx.root, "a.txt"), path.join(ctx.root, "b.txt"));
+    expect(await readFileTool.run({ path: "b.txt" }, ctx)).toBe("     1\tfine");
+  });
+
+  // Windows reaches one folder by its short name (TACHIK~1), by \\?\ and by the loopback share
+  // \\localhost\C$, and macOS ignores case. Each spelling that reaches the file on this machine is tried.
+  it.runIf(process.platform === "win32" || process.platform === "darwin")("is refused by every spelling that reaches it", async () => {
+    const ctx = await tempContext("never");
+    const data = path.join(ctx.root, "tachikoma");
+    await mkdir(data);
+    await writeFile(path.join(data, "chatgpt.json"), "{}");
+    vi.stubEnv("TACHI_DATA_DIR", data);
+    const file = path.join(data, "chatgpt.json");
+    const spellings = [path.join(ctx.root, "TACHIKOMA", "chatgpt.json")];
+    if (process.platform === "win32") {
+      const short = /(\S+~\d+)\s+tachikoma\s*$/im.exec(execFileSync("cmd", ["/c", "dir", "/x", ctx.root], { encoding: "utf8" }))?.[1];
+      if (short) spellings.push(path.join(ctx.root, short, "chatgpt.json"));
+      spellings.push(`\\\\?\\${file}`, `\\\\localhost\\${file[0]}$${file.slice(2)}`);
+    }
+    const reaching = spellings.filter((p) => existsSync(p));
+    expect(reaching.length).toBeGreaterThan(0);
+    for (const p of reaching) {
+      await expect(readFileTool.run({ path: p }, ctx)).rejects.toThrow("Tachikoma's data folder");
+      await expect(writeFileTool.run({ path: p, content: "x" }, ctx)).rejects.toThrow("Tachikoma's data folder");
+    }
+    expect(await readFile(file, "utf8")).toBe("{}");
+  });
+
+  it("leaves a folder whose name only starts the same alone", async () => {
+    const ctx = await setup();
+    await writeFile(path.join(ctx.root, "data2.txt"), "fine");
+    expect(await readFileTool.run({ path: "data2.txt" }, ctx)).toBe("     1\tfine");
+  });
+});
+
 describe("file tools", () => {
   it("writes, then reads back", async () => {
     const ctx = await tempContext();
```


**Step 2: Run them and see them fail**

Run: `npm test -- tests/core/datadir.test.ts tests/exec/env.test.ts tests/exec/local.test.ts tests/tools/files.test.ts`

Expected: FAIL. In the scratch build: Test Files 4 failed (4); Tests 6 failed | 28 passed | 1 skipped (35). The new modules do not exist yet, and the data folder and the API key get through.

**Step 3: Write the code**

**Create `src/core/datadir.ts`:**

```ts
import os from "node:os";
import path from "node:path";

// Where Tachikoma keeps its own data, such as the saved ChatGPT login (design, "Install").
// TACHI_DATA_DIR moves it, so tests never touch the real one.
export function dataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
  if (env.TACHI_DATA_DIR) return env.TACHI_DATA_DIR;
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "tachikoma");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "tachikoma");
  return path.join(home, ".local", "share", "tachikoma");
}
```

**Create `src/exec/env.ts`:**

```ts
// The API keys Tachikoma reads. Commands never see them, so one cannot print a key back to the model
// (release 2 design, "Hardening for every provider"). A command that needs one of these keys does not
// get it either.
export const API_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "MOONSHOT_API_KEY"];

// Windows treats variable names without regard to case, so `openai_api_key` is the same variable.
export function commandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !API_KEYS.includes(name.toUpperCase())));
}
```

**Change `src/exec/local.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/exec/local.ts b/src/exec/local.ts
index 14ae628..a6f6b77 100644
--- a/src/exec/local.ts
+++ b/src/exec/local.ts
@@ -2,6 +2,7 @@ import { type ChildProcess, spawn, spawnSync } from "node:child_process";
 import { mkdir, readFile, writeFile } from "node:fs/promises";
 import path from "node:path";
 import type { Readable } from "node:stream";
+import { commandEnv } from "./env.js";
 import { type ExecResult, type Executor, MAX_TOOL_OUTPUT } from "./executor.js";
 
 export function shellFor(platform: NodeJS.Platform = process.platform): { name: string; argv: (command: string) => string[] } {
@@ -56,7 +57,7 @@ export class LocalExecutor implements Executor {
     const [file, ...args] = shellFor().argv(command);
     return new Promise((resolve, reject) => {
       // No stdin: a command waiting for input would otherwise wait forever.
-      const child = spawn(file!, args, { cwd, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
+      const child = spawn(file!, args, { cwd, env: commandEnv(), windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
       running.add(child);
       const stdout = collect(child.stdout);
       const stderr = collect(child.stderr);
```

**Change `src/tools/files.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tools/files.ts b/src/tools/files.ts
index 2d7642a..a3fe014 100644
--- a/src/tools/files.ts
+++ b/src/tools/files.ts
@@ -1,6 +1,7 @@
-import { existsSync, lstatSync, realpathSync } from "node:fs";
+import { type BigIntStats, existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
 import path from "node:path";
 import { z } from "zod";
+import { dataDir } from "../core/datadir.js";
 import { MAX_TOOL_OUTPUT } from "../exec/executor.js";
 import { defineTool } from "./tool.js";
 
@@ -18,6 +19,33 @@ function realTarget(abs: string): string | null {
   return path.join(realpathSync(existing), ...rest);
 }
 
+// Whether `rel`, a path relative to some folder, leads out of it. On Windows a path on another drive
+// comes back absolute.
+const leaves = (rel: string) => rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
+
+// Whether `real` is the data folder or in it. The path is compared first, which also covers a data
+// folder not made yet. Then each folder on the way up is compared by what it is (its volume and file
+// number), since Windows reaches one folder by its short name, by \\?\ and by \\localhost\C$, and
+// macOS ignores case. A hard link is another name for a file in an ordinary folder, so a file with
+// more than one name is compared with each file directly in the data folder.
+function inData(data: string, real: string): boolean {
+  if (!leaves(path.relative(data, real))) return true;
+  const id = statSync(data, { bigint: true, throwIfNoEntry: false });
+  if (!id) return false;
+  const same = (a: BigIntStats | undefined, b: BigIntStats) => a !== undefined && a.dev === b.dev && a.ino === b.ino;
+  for (let p = real; ; p = path.dirname(p)) {
+    if (same(statSync(p, { bigint: true, throwIfNoEntry: false }), id)) return true;
+    if (path.dirname(p) === p) break;
+  }
+  const file = statSync(real, { bigint: true, throwIfNoEntry: false });
+  if (!file || !file.isFile() || file.nlink < 2n) return false;
+  return readdirSync(data).some((name) => same(statSync(path.join(data, name), { bigint: true, throwIfNoEntry: false }), file));
+}
+
+// On Linux, /proc/<process>/environ is a program's starting environment, API keys included, and
+// /proc/self leads to Tachikoma's own.
+export const programEnvironment = (real: string) => /^\/proc\/[^/]+\/(task\/[^/]+\/)?environ$/.test(real);
+
 // `shown` is what the approval prompt names: the path, plus where it really leads when a link takes
 // it somewhere else.
 export function resolveIn(root: string, p: string): { abs: string; outside: boolean; shown: string } {
@@ -25,10 +53,13 @@ export function resolveIn(root: string, p: string): { abs: string; outside: bool
   const base = realTarget(root);
   const real = realTarget(abs);
   if (base === null || real === null) return { abs, outside: true, shown: `${abs} (through a link that leads nowhere)` };
+  // The saved login lives there. Refused in every mode, `never` included, and after following links,
+  // so a link cannot get round it.
+  const data = realTarget(path.resolve(dataDir()));
+  if (data === null || inData(data, real)) throw new Error(`${abs} is in Tachikoma's data folder, which the file tools never touch`);
+  if (programEnvironment(real)) throw new Error(`${abs} is a program's environment, which can hold API keys, so the file tools never read it`);
   const rel = path.relative(base, real);
-  // On Windows a path on another drive comes back absolute.
-  const outside = rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
-  return { abs, outside, shown: rel === path.relative(root, abs) ? abs : `${abs} (really ${real})` };
+  return { abs, outside: leaves(rel), shown: rel === path.relative(root, abs) ? abs : `${abs} (really ${real})` };
 }
 
 // Read the way Claude Code's own Read tool does (its tool description, 2026-10-22): up to 2,000 lines
```


**Step 4: Run everything**

Run: `npm run typecheck`, then `npm test`

Expected: no type errors; Test Files 17 passed | 1 skipped (18); Tests 212 passed | 2 skipped (214).

**Step 5: Commit**

```bash
git add src/core/datadir.ts src/exec/env.ts src/exec/local.ts src/tools/files.ts tests/core/datadir.test.ts tests/exec/env.test.ts tests/exec/local.test.ts tests/tools/files.test.ts
git commit -m "feat: commands never get the API keys; the file tools refuse the data folder"
```

### Task 2: One change to the login at a time

Signing in, renewing, signing out and moving the login into the keychain must take turns, across
every Tachikoma process (release 2 design, "One change to the login at a time"; OpenAI's accounts
and sessions page: "serialize refreshes").

How it works:
- **The lock is a file only one process can create**, holding that process's pid. The pid is written
  to a file of the process's own first, which is then linked in as the lock; linking fails if the
  lock exists, so the lock is never seen without its pid. It is removed when the work ends, and on
  any exit Node sees, but only while it still holds this process's pid.
- **A waiter wakes when the lock file changes** (`fs.watch`), and also every 5 s (choice 3), because
  an owner killed outright changes nothing in the folder. The watcher listens before each try, so a
  release in between is not missed.
- **A lock whose owner is no longer running is taken over,** and so is one with no pid in it, which
  this code never makes. One holding our own pid but not held by us was left by an earlier process
  that had the same pid. One made before the computer last started (its file time is earlier than
  the start time from `os.uptime()`) was left by a crash or a power cut, whatever program has its pid
  now; the user chose this check on 2026-10-23. A waiter's message names the lock file, for the case
  this misses: an owner killed outright and its pid taken by another program without a restart.
- **On Windows a file being deleted** while another process still has it open cannot be made again
  until that process lets go (`EPERM`). That counts as busy, and the folder's next change ends the
  wait. So does a leftover lock another program holds open (`EBUSY`, from a backup or antivirus
  tool): the 5 s recheck finds out when it lets go, where retrying at once would freeze the process.
- **Calls within one process queue** in memory, since the file cannot tell them apart.
- **Ctrl-C stops a wait,** in the queue or behind another process. The next call still waits its
  turn.

The tests start real separate Node processes through `tsx`. Their scripts end in `.mts`, because
outside the project `tsx` would otherwise read a `.ts` file as CommonJS, where top-level `await` fails.

**Files:**
- Create: `src/auth/lock.ts`
- Create: `tests/auth/lock.test.ts`

**Step 1: Write the failing tests**

**Create `tests/auth/lock.test.ts`:**

```ts
import { spawn } from "node:child_process";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir, uptime } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { withLock } from "../../src/auth/lock.js";

const lockUrl = pathToFileURL(path.resolve("src/auth/lock.ts")).href;

// Runs TypeScript in a separate Node process, as a second Tachikoma would be.
function run(dir: string, name: string, source: string): { done: Promise<number | null>; output: () => string; kill: () => void } {
  const file = path.join(dir, `${name}.mts`);
  writeFileSync(file, `import { withLock } from ${JSON.stringify(lockUrl)};\n${source}`);
  const child = spawn(process.execPath, ["--import", "tsx", file], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  return { done: new Promise((resolve) => child.on("close", resolve)), output: () => out, kill: () => child.kill("SIGKILL") };
}

const tempDir = () => mkdtemp(path.join(tmpdir(), "tachi-lock-"));

describe("withLock", () => {
  it("lets one process at a time in", async () => {
    const dir = await tempDir();
    const lock = JSON.stringify(path.join(dir, "login.lock"));
    const log = JSON.stringify(path.join(dir, "log"));
    const workers = ["a", "b", "c"].map((tag) =>
      run(
        dir,
        tag,
        `import { appendFileSync } from "node:fs";
await withLock(${lock}, async () => {
  appendFileSync(${log}, "${tag} in\\n");
  await new Promise((r) => setTimeout(r, 300));
  appendFileSync(${log}, "${tag} out\\n");
});`,
      ),
    );
    expect(await Promise.all(workers.map((w) => w.done))).toEqual([0, 0, 0]);
    const lines = readFileSync(path.join(dir, "log"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(6);
    for (let i = 0; i < 6; i += 2) expect(lines[i + 1]).toBe(lines[i]!.replace(" in", " out"));
    expect(existsSync(path.join(dir, "login.lock"))).toBe(false);
  }, 30_000);

  it("queues calls within one process", async () => {
    const file = path.join(await tempDir(), "login.lock");
    const order: string[] = [];
    const step = (tag: string) =>
      withLock(file, async () => {
        order.push(`${tag} in`);
        await new Promise((r) => setTimeout(r, 20));
        order.push(`${tag} out`);
      });
    await Promise.all([step("a"), step("b")]);
    expect(order).toEqual(["a in", "a out", "b in", "b out"]);
  });

  it("is released when the work fails", async () => {
    const file = path.join(await tempDir(), "login.lock");
    await expect(withLock(file, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await withLock(file, async () => "next")).toBe("next");
  });

  it("takes over a lock whose owner is no longer running", async () => {
    const file = path.join(await tempDir(), "login.lock");
    const gone = spawn(process.execPath, ["-e", ""]);
    await new Promise((r) => gone.on("close", r));
    writeFileSync(file, String(gone.pid));
    expect(await withLock(file, async () => "taken")).toBe("taken");
  });

  it("takes over a lock made before the computer last started, whatever process has its pid now", async () => {
    const file = path.join(await tempDir(), "login.lock");
    writeFileSync(file, String(process.ppid)); // running, and not this process
    const boot = Date.now() / 1000 - uptime();
    utimesSync(file, boot - 1, boot - 1);
    let waited = false;
    expect(await withLock(file, async () => "taken", () => (waited = true))).toBe("taken");
    expect(waited).toBe(false);
  });

  // A backup or antivirus program can hold a leftover lock open, so that it cannot be removed yet.
  it.runIf(process.platform === "win32")("waits without blocking while another program holds a leftover lock open", async () => {
    const file = path.join(await tempDir(), "login.lock");
    const gone = spawn(process.execPath, ["-e", ""]);
    await new Promise((r) => gone.on("close", r));
    writeFileSync(file, String(gone.pid));
    const holder = spawn("powershell.exe", ["-NoProfile", "-Command", `$f = [IO.File]::Open('${file}', 'Open', 'Read', 'Read'); 'open'; Start-Sleep -Seconds 2; $f.Close()`]);
    let out = "";
    holder.stdout.on("data", (d) => (out += d));
    while (!out.includes("open")) await new Promise((r) => setTimeout(r, 20));
    const mine = withLock(file, async () => "taken");
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 100));
    expect(Date.now() - start).toBeLessThan(1_000); // not held up for the program's 2 s
    expect(await mine).toBe("taken");
  }, 30_000);

  it("leaves a lock that another process took over in the meantime", async () => {
    const file = path.join(await tempDir(), "login.lock");
    await withLock(file, async () => writeFileSync(file, String(process.ppid)));
    expect(readFileSync(file, "utf8")).toBe(String(process.ppid));
  });

  it("takes over a lock with no pid in it", async () => {
    const file = path.join(await tempDir(), "login.lock");
    writeFileSync(file, "");
    expect(await withLock(file, async () => "taken")).toBe("taken");
  });

  it("goes on when the owner it waits for is killed outright, which changes nothing in the folder", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "login.lock");
    const owner = run(dir, "owner", `await withLock(${JSON.stringify(file)}, async () => {
  console.log("held");
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});`);
    while (!owner.output().includes("held")) await new Promise((r) => setTimeout(r, 20));
    let waiting = false;
    const mine = withLock(file, async () => "in", () => (waiting = true));
    while (!waiting) await new Promise((r) => setTimeout(r, 20));
    owner.kill(); // no exit handler runs, so the lock file stays
    await owner.done;
    expect(existsSync(file)).toBe(true);
    expect(await mine).toBe("in");
  }, 30_000);

  it("stops waiting when cancelled, in this process's queue and behind another process", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "login.lock");
    let release!: () => void;
    let firstDone = false;
    const first = withLock(file, () => new Promise<void>((r) => (release = r)).then(() => void (firstDone = true)));
    const queued = new AbortController();
    const second = withLock(file, async () => "second", undefined, queued.signal);
    // The cancelled call's place in the queue still waits for the first.
    const third = withLock(file, async () => (firstDone ? "third" : "third, while the first held the lock"));
    queued.abort();
    await expect(second).rejects.toThrow("aborted");
    release();
    await first;
    expect(await third).toBe("third");

    const owner = run(dir, "owner", `await withLock(${JSON.stringify(file)}, async () => {
  console.log("held");
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});`);
    while (!owner.output().includes("held")) await new Promise((r) => setTimeout(r, 20));
    const behind = new AbortController();
    let waiting = false;
    const mine = withLock(file, async () => "in", () => (waiting = true), behind.signal);
    while (!waiting) await new Promise((r) => setTimeout(r, 20));
    behind.abort();
    await expect(mine).rejects.toThrow("aborted");
    owner.kill();
    await owner.done;
  }, 30_000);

  it("waits for a running owner, says which, and goes on when it is released", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "login.lock");
    let release!: () => void;
    const first = withLock(file, () => new Promise<void>((r) => (release = r)));
    while (!existsSync(file)) await new Promise((r) => setTimeout(r, 10));
    const other = run(dir, "other", `await withLock(${JSON.stringify(file)}, async () => console.log("got it"), (pid) => console.log("waiting for " + pid));`);
    while (!other.output().includes("waiting")) await new Promise((r) => setTimeout(r, 20));
    expect(other.output().trim()).toBe(`waiting for ${process.pid}`);
    const released = Date.now();
    release();
    await first;
    while (!other.output().includes("got it")) await new Promise((r) => setTimeout(r, 20));
    // Woken by the release itself: the 5 s recheck alone would take most of 5 s here.
    expect(Date.now() - released).toBeLessThan(2_500);
    expect(await other.done).toBe(0);
  }, 30_000);
});
```


**Step 2: Run them and see them fail**

Run: `npm test -- tests/auth/lock.test.ts`

Expected: FAIL. In the scratch build: Test Files 1 failed (1), before any test runs. `src/auth/lock.ts` does not exist yet.

**Step 3: Write the code**

**Create `src/auth/lock.ts`:**

```ts
import { linkSync, readFileSync, statSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import path from "node:path";

// One change to the saved login at a time, across every Tachikoma process (release 2 design, "One
// change to the login at a time"). The lock is a file only one process can create, holding that
// process's pid. A waiter wakes when the folder changes, and also every RECHECK_MS, because an owner
// killed outright changes nothing in the folder.

// proper-lockfile's default for refreshing its locks (`update`: half its 10,000 ms `stale`), chosen by
// the user on 2026-10-23. It sets only how long a waiter can sit behind a killed owner.
const RECHECK_MS = 5_000;

const held = new Set<string>();
// Released on every exit Node sees: normal ends, errors, and SIGTERM/SIGHUP, which cli.tsx turns into
// exits. A hard kill leaves the file behind, and the next process takes it over (below).
process.on("exit", () => held.forEach(release));

function unlinkSafe(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // already gone
  }
}

// Removes the lock only while it still holds this process's pid: another process may have taken it
// over in the meantime (see "Known limits").
function release(file: string): void {
  held.delete(file);
  try {
    if (readFileSync(file, "utf8") === String(process.pid)) unlinkSync(file);
  } catch {
    // already gone
  }
}

function running(pid: number): boolean {
  if (pid === process.pid) return false; // ours but not held here: left by an earlier process with our pid
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // running, as another user
  }
}

// On Windows a file that is being deleted while another process still has it open cannot be opened
// or made again until that process lets go; the folder changes when it does. A file another program
// holds open (a backup or antivirus tool) cannot be removed until it lets go (`EBUSY`); the recheck
// finds out when.
const busy = (err: unknown) => process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes((err as NodeJS.ErrnoException).code ?? "");

// Takes the lock and returns null, or returns the pid holding it (0 while Windows is removing it, or
// will not let it be removed yet).
function tryTake(file: string): number | null {
  // The pid is written to a file of this process's own first, then linked in as the lock. Linking
  // fails if the lock exists, and the lock is never seen without its pid.
  const mine = `${file}.${process.pid}`;
  writeFileSync(mine, String(process.pid), { mode: 0o600 });
  try {
    for (;;) {
      try {
        linkSync(mine, file);
        held.add(file);
        return null;
      } catch (err) {
        if (busy(err)) return 0;
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      let text: string;
      let made: number;
      try {
        text = readFileSync(file, "utf8");
        made = statSync(file).mtimeMs;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // released in between
        if (busy(err)) return 0;
        throw err;
      }
      const pid = Number(text);
      // A lock without a pid was not made by this code, which never leaves one half made: abandoned. So
      // is one made before the computer last started, whatever process has its pid now: it was left by
      // a crash or a power cut.
      const beforeBoot = made < Date.now() - uptime() * 1000;
      if (Number.isInteger(pid) && pid > 0 && running(pid) && !beforeBoot) return pid;
      // Its owner is gone. It is read again just before removal, which narrows, but does not close, the
      // moment in which two waiters could both take it over (see "Known limits").
      try {
        if (readFileSync(file, "utf8") === text) unlinkSync(file);
      } catch (err) {
        if (busy(err)) return 0;
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; // ENOENT: gone already, try again
      }
    }
  } finally {
    unlinkSafe(mine);
  }
}

async function acquire(file: string, onWait: (pid: number) => void, signal?: AbortSignal): Promise<void> {
  const watcher = watch(path.dirname(file));
  try {
    let told = false;
    for (;;) {
      signal?.throwIfAborted();
      // Listening before trying, so a release between the try and the wait is not missed. Only the
      // lock's own changes count: each try makes and removes this process's pid file there too.
      let timer!: NodeJS.Timeout;
      let wake!: (event?: string, name?: string | Buffer | null) => void;
      let stop!: () => void;
      const woken = new Promise<void>((resolve) => {
        wake = (_event, name) => {
          if (!name || name.toString() === path.basename(file)) resolve();
        };
        watcher.on("change", wake);
        timer = setTimeout(resolve, RECHECK_MS);
        stop = () => resolve();
        signal?.addEventListener("abort", stop, { once: true });
      });
      try {
        const holder = tryTake(file);
        if (holder === null) return;
        if (!told && holder > 0) {
          onWait(holder);
          told = true;
        }
        await woken;
      } finally {
        clearTimeout(timer);
        watcher.removeListener("change", wake);
        signal?.removeEventListener("abort", stop);
      }
    }
  } finally {
    watcher.close();
  }
}

// Waits for `before`, or rejects as soon as `signal` is aborted.
function abortable(before: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return before;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    void before.then(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    });
  });
}

// Calls within one process queue here; the lock file is for other processes. Each call's turn ends
// when it does, so a call cancelled while waiting lets the next one go when its own turn comes.
const queues = new Map<string, Promise<void>>();

export function withLock<T>(file: string, fn: () => Promise<T>, onWait: (pid: number) => void = () => {}, signal?: AbortSignal): Promise<T> {
  const before = queues.get(file) ?? Promise.resolve();
  let finished!: () => void;
  const turn = new Promise<void>((resolve) => (finished = resolve));
  queues.set(
    file,
    before.then(() => turn),
  );
  return (async () => {
    try {
      await abortable(before, signal);
      await acquire(file, onWait, signal);
      try {
        return await fn();
      } finally {
        release(file);
      }
    } finally {
      finished();
    }
  })();
}
```


**Step 4: Run everything**

Run: `npm run typecheck`, then `npm test`

Expected: no type errors; Test Files 18 passed | 1 skipped (19); Tests 223 passed | 2 skipped (225).

**Step 5: Commit**

```bash
git add src/auth/lock.ts tests/auth/lock.test.ts
git commit -m "feat: one change to the saved login at a time, across processes"
```

### Task 3: Private files for the login

The saved login is readable only by the user, from the moment it exists (release 2 design, "Private
from the start"):
- **macOS and Linux:** the folder is mode 700, files are created 600. A file found readable by others
  is made 600 and the user is told; if that fails, it is not used.
- **Windows:** the profile folder also lets in Administrators and the system account, so the folder
  gets a permission for the user alone, which files made in it inherit:
  `icacls <folder> /inheritance:r /grant:r *<SID>:(OI)(CI)F`. The user's SID comes from
  `whoami /user /fo csv /nh`. Permissions are read back through PowerShell's `Get-Acl`, as SIDs
  (`GetAccessRules` with `SecurityIdentifier`), so the check does not depend on the language Windows
  is set to, and no entry is left out: turning names back into SIDs fails for some accounts, such as
  ALL APPLICATION PACKAGES. Private means every entry allows the user and no one else; a folder's
  must also pass to the files made in it. Other accounts' own entries on the folder are removed
  (`icacls <folder> /remove *<SID>`). A file that lets others in is reset to inherit from the
  private folder (`icacls <file> /reset`).
- **Refused:** a link in place of the file, a file with another name (a hard link, choice 8), and a
  file owned by someone else.
- **Written whole:** a new file in the same folder, written and flushed, then renamed over the old.
  If any step fails, the new file is removed, so no copy of the login is left behind. On Windows
  a file another process has open (another Tachikoma reading the login) cannot be replaced, so the
  rename is tried again, after the shortest pause (about 16 ms), for up to 1 s (measured; see the
  numbers table). After that the save fails, saying another program may have the file open.

Windows programs are started by their full path in System32 (`system32()` in `env.ts`). On this
machine Git Bash's own `whoami` came first on PATH and failed. Every program started here gets
`commandEnv()`, as the design asks of every program Tachikoma starts.

One Windows check takes a moment (it starts PowerShell), so each path is checked once per process.

**Files:**
- Create: `src/auth/private.ts`
- Modify: `src/exec/env.ts`
- Modify: `src/exec/local.ts`
- Create: `tests/auth/private.test.ts`

**Step 1: Write the failing tests**

**Create `tests/auth/private.test.ts`:**

```ts
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, fsyncSync, linkSync, mkdirSync, mkdtempSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PrivateFileError, privateDir, readPrivate, writePrivate } from "../../src/auth/private.js";
import { system32 } from "../../src/exec/env.js";

// A write that fails part way (a full disk) is made to fail by flushing.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) };
});

const windows = process.platform === "win32";
const temp = () => path.join(mkdtempSync(path.join(tmpdir(), "tachi-private-")), "data");

// Every SID in a path's permissions, read as SIDs, so none is left out.
function sids(p: string): string[] {
  const script = "$ErrorActionPreference = 'Stop'; (Get-Acl -LiteralPath $env:P).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }";
  return execFileSync(system32("WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", env: { ...process.env, P: p } })
    .trim()
    .split(/\r?\n/);
}
const icacls = (...args: string[]) => execFileSync(system32("icacls.exe"), args, { stdio: "ignore" });
const me = () => execFileSync(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }).trim().split(",")[1]!.replaceAll('"', "");

describe("private files", () => {
  it("writes the whole file, leaving no temporary copy, and reads it back", () => {
    const dir = temp();
    const file = path.join(dir, "chatgpt.json");
    writePrivate(file, "one");
    writePrivate(file, "two");
    expect(readPrivate(file, () => {})).toBe("two");
    expect(readdirSync(dir)).toEqual(["chatgpt.json"]);
  });

  it("leaves the old file, and no copy, when a write fails", () => {
    const dir = temp();
    const file = path.join(dir, "chatgpt.json");
    writePrivate(file, "one");
    vi.mocked(fsyncSync).mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() => writePrivate(file, "two")).toThrow("disk full");
    expect(readdirSync(dir)).toEqual(["chatgpt.json"]);
    expect(readPrivate(file, () => {})).toBe("one");
  });

  it("reads a missing file as null", () => {
    expect(readPrivate(path.join(temp(), "none.json"), () => {})).toBeNull();
  });

  it("refuses a file with another name (a hard link)", () => {
    const dir = temp();
    const file = path.join(dir, "chatgpt.json");
    writePrivate(file, "x");
    linkSync(file, path.join(dir, "copy"));
    expect(() => readPrivate(file, () => {})).toThrow(PrivateFileError);
  });

  it("refuses a link in place of the file", (ctx) => {
    const dir = temp();
    privateDir(dir);
    writeFileSync(path.join(dir, "real"), "{}");
    try {
      symlinkSync(path.join(dir, "real"), path.join(dir, "chatgpt.json"), "file");
    } catch {
      return ctx.skip(); // Windows allows file symlinks only with Developer Mode or as an administrator
    }
    expect(() => readPrivate(path.join(dir, "chatgpt.json"), () => {})).toThrow("is not a plain file");
  });

  it("refuses a link in place of the folder, and a folder in place of the file", () => {
    const dir = temp();
    privateDir(dir);
    // A junction on Windows needs no special rights; elsewhere it is an ordinary symlink.
    symlinkSync(dir, `${dir}-link`, "junction");
    expect(() => privateDir(`${dir}-link`)).toThrow("is not a plain folder");
    mkdirSync(path.join(dir, "chatgpt.json"));
    expect(() => readPrivate(path.join(dir, "chatgpt.json"), () => {})).toThrow("is not a plain file");
  });

  // Another Tachikoma reading the login has it open for a moment, and Windows will not replace a file
  // that is open. The save waits for it, for up to 1 s. Resolves once the file is open.
  async function holdOpen(file: string, ms: number): Promise<void> {
    const script = `$ErrorActionPreference = 'Stop'; $f = [IO.File]::Open($env:P, 'Open', 'Read', 'ReadWrite'); 'open'; Start-Sleep -Milliseconds ${ms}; $f.Close()`;
    const holder = spawn(system32("WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, P: file } });
    let out = "";
    holder.stdout.on("data", (d) => (out += d));
    while (!out.includes("open")) await new Promise((r) => setTimeout(r, 20));
  }

  it.runIf(windows)("on Windows, saves while another program has the file open for a moment", async () => {
    const dir = temp();
    const file = path.join(dir, "chatgpt.json");
    writePrivate(file, "one");
    await holdOpen(file, 300); // well under the 1 s the save waits
    writePrivate(file, "two");
    expect(readPrivate(file, () => {})).toBe("two");
  });

  // 15 s, as for the other tests that start a program: PowerShell's start and the 1 s wait.
  it.runIf(windows)("on Windows, gives up after 1 s, keeping the old file and no copy", async () => {
    const dir = temp();
    const file = path.join(dir, "chatgpt.json");
    writePrivate(file, "one");
    await holdOpen(file, 2_000); // twice the 1 s the save waits
    expect(() => writePrivate(file, "two")).toThrow(`${file} could not be replaced, perhaps because another program has it open, so it was not saved`);
    expect(readPrivate(file, () => {})).toBe("one");
    expect(readdirSync(dir)).toEqual(["chatgpt.json"]);
  }, 15_000);

  it.runIf(windows)("on Windows, lets in only the user, from the start", () => {
    const dir = temp();
    const file = path.join(dir, "chatgpt.json");
    writePrivate(file, "x");
    expect(sids(dir)).toEqual([me()]);
    expect(sids(file)).toEqual([me()]);
  });

  it.runIf(windows)("on Windows, makes a file others can read private, and says so", () => {
    const dir = temp();
    const file = path.join(dir, "chatgpt.json");
    privateDir(dir);
    writeFileSync(file, "x");
    execFileSync(system32("icacls.exe"), [file, "/grant", "*S-1-1-0:R"], { stdio: "ignore" }); // Everyone
    const warnings: string[] = [];
    expect(readPrivate(file, (w) => warnings.push(w))).toBe("x");
    expect(warnings).toEqual([`${file} could be read by others; it is now private to you.`]);
    expect(sids(file)).toEqual([me()]);
  });

  // ALL APPLICATION PACKAGES (S-1-15-2-1) is one whose name PowerShell cannot turn back into a SID.
  it.runIf(windows)("on Windows, sees every grant, even one whose name cannot be looked up", () => {
    const dir = temp();
    const file = path.join(dir, "chatgpt.json");
    privateDir(dir);
    writeFileSync(file, "x");
    icacls(file, "/grant", "*S-1-15-2-1:R");
    const warnings: string[] = [];
    expect(readPrivate(file, (w) => warnings.push(w))).toBe("x");
    expect(warnings).toHaveLength(1);
    expect(sids(file)).toEqual([me()]);
  });

  it.runIf(windows)("on Windows, makes a folder private that lets another account in", () => {
    const dir = temp();
    mkdirSync(dir);
    icacls(dir, "/grant", "*S-1-15-2-1:(OI)(CI)R");
    writePrivate(path.join(dir, "chatgpt.json"), "x");
    expect(sids(dir)).toEqual([me()]);
    expect(sids(path.join(dir, "chatgpt.json"))).toEqual([me()]);
  });

  it.runIf(windows)("on Windows, makes a folder private whose files would not inherit its permission", () => {
    const dir = temp();
    mkdirSync(dir);
    icacls(dir, "/inheritance:r", "/grant:r", `*${me()}:F`); // the user alone, but not passed on to files
    writePrivate(path.join(dir, "chatgpt.json"), "x");
    expect(sids(path.join(dir, "chatgpt.json"))).toEqual([me()]);
  });

  it.runIf(windows)("on Windows, refuses a folder that lets in an account that no longer exists", () => {
    const dir = temp();
    mkdirSync(dir);
    // icacls cannot name such an account, so the entry is added through .NET.
    const script = "$a = Get-Acl -LiteralPath $env:P; $a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-5-21-1-2-3-1000'), 'Read', 'Allow')); Set-Acl -LiteralPath $env:P -AclObject $a";
    execFileSync(system32("WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, P: dir } });
    expect(() => privateDir(dir)).toThrow(new PrivateFileError(`Could not make ${dir} private to you`));
  });

  it.skipIf(windows)("elsewhere, uses mode 700 and 600, and fixes a file others can read", () => {
    const dir = temp();
    const file = path.join(dir, "chatgpt.json");
    writePrivate(file, "x");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    chmodSync(file, 0o644);
    const warnings: string[] = [];
    readPrivate(file, (w) => warnings.push(w));
    expect(warnings).toHaveLength(1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
```


**Step 2: Run them and see them fail**

Run: `npm test -- tests/auth/private.test.ts`

Expected: FAIL. In the scratch build: Test Files 1 failed (1), before any test runs. `src/auth/private.ts` does not exist yet.

**Step 3: Write the code**

**Create `src/auth/private.ts`:**

```ts
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { commandEnv, system32 } from "../exec/env.js";

// Files only the user can read: the saved login and its lock (release 2 design, "Private from the
// start"). On macOS and Linux that is mode 700 for the folder and 600 for files. On Windows the
// profile folder also lets in Administrators and the system account, so the folder gets a permission
// that lets in only the user, which files made in it inherit (icacls docs: "(OI) Object inherit",
// "(CI) Container inherit"). Permissions are read back by SID, so the check does not depend on the
// language Windows is set to.

export class PrivateFileError extends Error {}

const windows = process.platform === "win32";
let userSid: string | undefined;

function sid(): string {
  // `whoami /user /fo csv /nh` prints "domain\user","S-1-5-...".
  userSid ??= execFileSync(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, stdio: "pipe", env: commandEnv() }).trim().split(",")[1]!.replaceAll('"', "");
  return userSid;
}

// The owner and every entry in the permissions of each path: its SID, whether it allows, and its
// inheritance flags. The entries are read as SIDs: turning names back into SIDs fails for some
// accounts, such as ALL APPLICATION PACKAGES, and would leave them out. Any error stops the script.
// The paths go in through the environment, so no quoting is needed.
const ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$sid = [System.Security.Principal.SecurityIdentifier]",
  "$out = foreach ($p in ($env:TACHI_ACL_PATHS -split [char]10)) {",
  "  $a = Get-Acl -LiteralPath $p",
  "  [pscustomobject]@{ owner = $a.GetOwner($sid).Value;",
  "    access = @($a.GetAccessRules($true, $true, $sid) | ForEach-Object {",
  "      [pscustomobject]@{ sid = $_.IdentityReference.Value; allow = $_.AccessControlType -eq 'Allow'; inherit = [int]$_.InheritanceFlags } }) }",
  "}",
  "ConvertTo-Json -Compress -Depth 3 -InputObject @($out)",
].join("\n");

type Acl = { owner: string; access: { sid: string; allow: boolean; inherit: number }[] };

function windowsAcl(paths: string[]): Acl[] {
  const out = execFileSync(system32("WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", ACL_SCRIPT], {
    encoding: "utf8",
    windowsHide: true,
    stdio: "pipe", // errors come back in the thrown error, not printed over the screen
    env: { ...commandEnv(), TACHI_ACL_PATHS: paths.join("\n") },
  });
  return JSON.parse(out);
}

// Every entry lets in the user, and no one else. A folder's must also pass to what is made in it:
// inheritance flags 3 are ContainerInherit and ObjectInherit (.NET's InheritanceFlags).
const onlyUser = (a: Acl, folder = false) =>
  a.access.length > 0 && a.access.every((e) => e.allow && e.sid === sid()) && (!folder || a.access.some((e) => e.inherit === 3));

function icacls(...args: string[]): void {
  execFileSync(system32("icacls.exe"), args, { windowsHide: true, stdio: "ignore", env: commandEnv() });
}

// Paths already checked by this process; each Windows check starts PowerShell, which takes a moment.
const checked = new Set<string>();

// Creates the folder if needed and makes it private.
export function privateDir(dir: string): void {
  if (checked.has(dir)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new PrivateFileError(`${dir} is not a plain folder, so the login cannot be kept there safely`);
  if (windows) {
    if (!onlyUser(windowsAcl([dir])[0]!, true)) {
      // Removes inherited entries and leaves the user alone; files already inside inherit that. Other
      // accounts' own entries, which that keeps, are removed next.
      icacls(dir, "/inheritance:r", "/grant:r", `*${sid()}:(OI)(CI)F`);
      const others = [...new Set(windowsAcl([dir])[0]!.access.filter((e) => e.sid !== sid()).map((e) => `*${e.sid}`))];
      try {
        if (others.length) icacls(dir, "/remove", ...others);
      } catch {
        // icacls cannot remove an entry for an account Windows cannot look up; the check below says so
      }
      if (!onlyUser(windowsAcl([dir])[0]!, true)) throw new PrivateFileError(`Could not make ${dir} private to you`);
    }
  } else {
    if (st.uid !== process.getuid!()) throw new PrivateFileError(`${dir} belongs to another user`);
    if (st.mode & 0o077) chmodSync(dir, 0o700);
  }
  checked.add(dir);
}

// Reads a private file, or returns null if there is none. A link or another user's file is refused; a
// file others can read is made private first, and `warn` says so. If that fails, nothing is read.
export function readPrivate(file: string, warn: (message: string) => void): string | null {
  privateDir(path.dirname(file));
  const st = lstatSync(file, { throwIfNoEntry: false });
  if (!st) return null;
  if (st.isSymbolicLink() || !st.isFile()) throw new PrivateFileError(`${file} is not a plain file, so it was not used`);
  if (st.nlink > 1) throw new PrivateFileError(`${file} has other names (hard links), so it was not used`);
  if (windows) {
    if (!checked.has(file)) {
      const acl = windowsAcl([file])[0]!;
      if (acl.owner !== sid()) throw new PrivateFileError(`${file} belongs to another account, so it was not used`);
      if (!onlyUser(acl)) {
        icacls(file, "/reset"); // back to what it inherits from the private folder
        if (!onlyUser(windowsAcl([file])[0]!)) throw new PrivateFileError(`${file} could be read by others and could not be made private, so it was not used`);
        warn(`${file} could be read by others; it is now private to you.`);
      }
      checked.add(file);
    }
  } else {
    if (st.uid !== process.getuid!()) throw new PrivateFileError(`${file} belongs to another user, so it was not used`);
    if (st.mode & 0o077) {
      chmodSync(file, 0o600);
      if (lstatSync(file).mode & 0o077) throw new PrivateFileError(`${file} could be read by others and could not be made private, so it was not used`);
      warn(`${file} could be read by others; it is now private to you.`);
    }
  }
  return readFileSync(file, "utf8");
}

// On Windows a file another process has open, such as another Tachikoma reading the login, cannot be
// replaced (EPERM). The swap is tried again, after the shortest pause asked for (1 ms; Windows's timer
// makes it about 16 ms), for up to RENAME_RETRY_MS. Measured on 2026-10-23 with the same pause, with
// two processes reading the file nonstop: of 3,000 saves, 27% were refused at first, and the slowest
// went through after 0.76 s. The user chose 1 s. performance.now() keeps counting if the clock is set.
const RENAME_RETRY_MS = 1_000;
const pause = new Int32Array(new SharedArrayBuffer(4));

function swapIn(temp: string, file: string): void {
  const start = performance.now();
  for (;;) {
    try {
      return renameSync(temp, file);
    } catch (err) {
      const refused = windows && ["EPERM", "EACCES", "EBUSY"].includes((err as NodeJS.ErrnoException).code ?? "");
      if (!refused) throw err;
      if (performance.now() - start >= RENAME_RETRY_MS) throw new PrivateFileError(`${file} could not be replaced, perhaps because another program has it open, so it was not saved`);
      Atomics.wait(pause, 0, 0, 1);
    }
  }
}

// Writes the whole file to a new private file in the same folder, then swaps it in, so it is never
// left half-written.
export function writePrivate(file: string, text: string): void {
  privateDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    swapIn(temp, file);
  } catch (err) {
    rmSync(temp, { force: true }); // no copy of the login is left behind
    throw err;
  }
  // Made in the private folder, so it has the folder's permission; nothing more to check.
  checked.add(file);
}
```

**Change `src/exec/env.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/exec/env.ts b/src/exec/env.ts
index c8c20a5..fc8020d 100644
--- a/src/exec/env.ts
+++ b/src/exec/env.ts
@@ -1,3 +1,5 @@
+import path from "node:path";
+
 // The API keys Tachikoma reads. Commands never see them, so one cannot print a key back to the model
 // (release 2 design, "Hardening for every provider"). A command that needs one of these keys does not
 // get it either.
@@ -7,3 +9,7 @@ export const API_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_
 export function commandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
   return Object.fromEntries(Object.entries(env).filter(([name]) => !API_KEYS.includes(name.toUpperCase())));
 }
+
+// A Windows program by its full path, so a program of the same name earlier on PATH (Git Bash has its
+// own whoami) is not run instead.
+export const system32 = (exe: string) => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);
```

**Change `src/exec/local.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/exec/local.ts b/src/exec/local.ts
index a6f6b77..44870e2 100644
--- a/src/exec/local.ts
+++ b/src/exec/local.ts
@@ -2,7 +2,7 @@ import { type ChildProcess, spawn, spawnSync } from "node:child_process";
 import { mkdir, readFile, writeFile } from "node:fs/promises";
 import path from "node:path";
 import type { Readable } from "node:stream";
-import { commandEnv } from "./env.js";
+import { commandEnv, system32 } from "./env.js";
 import { type ExecResult, type Executor, MAX_TOOL_OUTPUT } from "./executor.js";
 
 export function shellFor(platform: NodeJS.Platform = process.platform): { name: string; argv: (command: string) => string[] } {
@@ -23,7 +23,7 @@ export function killTree(child: ChildProcess): void {
   if (process.platform === "win32") {
     // taskkill cannot find a tree whose root has exited, and Windows may already have given that pid
     // to an unrelated program, so it is only run while the shell is alive.
-    if (child.exitCode === null && child.signalCode === null) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
+    if (child.exitCode === null && child.signalCode === null) spawnSync(system32("taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, env: commandEnv() });
   } else {
     try {
       process.kill(-child.pid, "SIGKILL"); // the shell leads its own process group (detached below)
```


**Step 4: Run everything**

Run: `npm run typecheck`, then `npm test`

Expected: no type errors; Test Files 19 passed | 1 skipped (20); Tests 236 passed | 4 skipped (240).

**Step 5: Commit**

```bash
git add src/auth/private.ts src/exec/env.ts src/exec/local.ts tests/auth/private.test.ts
git commit -m "feat: private files for the saved login, with a user-only permission on Windows"
```

### Task 4: OpenAI's sign-in protocol

The pieces of OpenAI's flow for open-source tools, each as its docs describe it (sources in "Before
you start"):
- **Endpoints** come from OpenAI's discovery document, and its issuer must be `https://auth.openai.com`.
- **The authorize address** carries the parameters in the sign-in page's table: `client_id`
  (`dynamic_agent_client` the first time, the issued ID after that), `response_type=code`,
  `redirect_uri`, the identity and plan scopes, `resource=https://api.openai.com/v1`, `state`,
  `nonce`, the S256 PKCE challenge and the machine's `ext_agent_host_id`. `agent_name_hint=Tachikoma`
  goes only on the first registration; a returning sign-in sends `id_token_hint` and `login_hint`.
- **The listener** waits on `127.0.0.1`, any free port, at `/auth/callback`. A reply with another
  attempt's `state` is turned away, and so is a request line that is not an address (any program
  on the computer can send one). The first matching reply ends the wait and closes the listener and
  every connection to it. The page it shows loads nothing from anywhere (`default-src 'none'`).
- **`/auth/start`** sends the browser on to the authorize address (choice 2), so the ID token sent as a
  hint is never printed and never on a command line. It answers once: any program on the computer
  could ask it, and a second answer would hand that program the ID token. Opened again, it shows a
  page saying the sign-in was already opened in another tab.
- **Exchange, renewal and revocation** are form POSTs. Errors carry OpenAI's code (`invalid_grant`
  and so on), never a token. A reply that cannot be read is an error that quotes none of it. They
  never follow a redirect, which would send the form, tokens and all, to another address. Every
  request here takes a signal, so Ctrl-C can stop it, and says so even when a reply was arriving.
  A request that fails says why: Node's fetch says only "fetch failed" and keeps the reason (a
  refused redirect, a host it cannot find) further down, where `connectReason()` finds it.
- **Every error is a full sentence,** so another message can carry it as a sentence of its own.
  Settings, keys or an ID token in an unexpected form, such as a Wi-Fi login page in place of the
  settings, say they could not be read, rather than giving Node's or the validator's own words.
- **The ID token** is checked in the docs' order: signature against OpenAI's published keys (RS256
  only, as the discovery document says), then issuer, audience (the issued client ID), expiry and
  nonce. With several audiences, `azp` must be the client ID too (OpenID Connect Core 1.0, section
  3.1.3.7). Node's `crypto` does the signature check, so no package is needed.

`tests/auth/fake-openai.ts` stands in for OpenAI: it answers the authorize address at once, as if the
user approved, issues one-use codes and rotating renewal tokens, and signs ID tokens with a key made
for each test. Fields on it make it misbehave.

**Files:**
- Create: `src/auth/oauth.ts`
- Create: `tests/auth/fake-openai.ts`
- Create: `tests/auth/oauth.test.ts`

**Step 1: Write the failing tests**

**Create `tests/auth/fake-openai.ts`:**

```ts
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";

// A stand-in for OpenAI's sign-in service, following its docs: discovery, authorize (answered at once
// with a redirect, as if the user approved), token, revoke and signing keys. Each test changes the
// fields below to make it misbehave.
export class FakeOpenAI {
  issuer = "";
  sub = "user-1";
  email = "me@example.com";
  scope = "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke";
  issuedClientId = "oaiapp_1";
  callbackClientId: string | null | undefined; // undefined: the docs' default; null: left out
  deny = false; // the user says no in the browser
  idTokenIssuer: string | undefined; // set to sign ID tokens with another issuer
  revokeStatus = 200;
  revokeHangs = false; // the revocation is never answered
  tokenHangs = false; // token requests (exchange and renewal) are never answered
  renewalError: string | undefined; // renewals are refused with this error code
  earliestRefreshAt: unknown;
  readonly authorizeRequests: URLSearchParams[] = [];
  readonly tokenRequests: URLSearchParams[] = [];
  readonly revoked: URLSearchParams[] = [];
  readonly #keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  readonly #codes = new Map<string, { clientId: string; challenge: string; redirectUri: string; nonce: string }>();
  readonly #refresh = new Set<string>();
  #server = http.createServer((req, res) => void this.#handle(req, res));

  static async start(): Promise<FakeOpenAI> {
    const fake = new FakeOpenAI();
    await new Promise<void>((resolve) => fake.#server.listen(0, "127.0.0.1", resolve));
    fake.issuer = `http://127.0.0.1:${(fake.#server.address() as AddressInfo).port}`;
    onTestFinished(() => {
      fake.#server.close();
      fake.#server.closeAllConnections();
    });
    return fake;
  }

  // What a browser would do with the address Tachikoma prints: follow it to the callback.
  readonly browser = (url: string) => {
    void fetch(url).catch(() => {});
  };

  idToken(claims: Record<string, unknown>, kid = "k1"): string {
    const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = `${part({ alg: "RS256", kid })}.${part(claims)}`;
    return `${head}.${sign("sha256", Buffer.from(head), this.#keys.privateKey).toString("base64url")}`;
  }

  #tokens(clientId: string, nonce?: string) {
    const refresh = randomBytes(8).toString("hex");
    this.#refresh.add(refresh);
    const now = Math.floor(Date.now() / 1000);
    return {
      access_token: `access-${randomBytes(4).toString("hex")}`,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: 3600,
      scope: this.scope,
      ...(this.earliestRefreshAt === undefined ? {} : { earliest_refresh_at: this.earliestRefreshAt }),
      id_token: this.idToken({ iss: this.idTokenIssuer ?? this.issuer, aud: clientId, sub: this.sub, email: this.email, exp: now + 3600, iat: now, ...(nonce ? { nonce } : {}) }),
    };
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.issuer);
    const json = (status: number, body?: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(body === undefined ? "" : JSON.stringify(body));
    let form = new URLSearchParams();
    if (req.method === "POST") {
      let text = "";
      for await (const chunk of req) text += chunk;
      form = new URLSearchParams(text);
    }
    switch (url.pathname) {
      case "/.well-known/openid-configuration":
        return void json(200, {
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/authorize`,
          token_endpoint: `${this.issuer}/token`,
          jwks_uri: `${this.issuer}/jwks`,
          revocation_endpoint: `${this.issuer}/revoke`,
        });
      case "/jwks":
        return void json(200, { keys: [{ ...this.#keys.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] });
      case "/authorize": {
        const q = url.searchParams;
        this.authorizeRequests.push(q);
        const back = new URL(q.get("redirect_uri")!);
        back.searchParams.set("state", q.get("state")!);
        if (this.deny) back.searchParams.set("error", "access_denied");
        else {
          const first = q.get("client_id") === "dynamic_agent_client";
          const clientId = first ? this.issuedClientId : q.get("client_id")!;
          const code = randomBytes(8).toString("hex");
          this.#codes.set(code, { clientId, challenge: q.get("code_challenge")!, redirectUri: q.get("redirect_uri")!, nonce: q.get("nonce")! });
          back.searchParams.set("code", code);
          back.searchParams.set("scope", this.scope);
          const shown = this.callbackClientId === undefined ? (first ? clientId : undefined) : this.callbackClientId;
          if (shown) back.searchParams.set("client_id", shown);
        }
        return void res.writeHead(302, { location: back.href }).end();
      }
      case "/token": {
        this.tokenRequests.push(form);
        if (this.tokenHangs) return;
        if (form.get("resource") !== "https://api.openai.com/v1") return void json(400, { error: "invalid_request" });
        if (form.get("grant_type") === "authorization_code") {
          const pending = this.#codes.get(form.get("code") ?? "");
          this.#codes.delete(form.get("code") ?? ""); // each code works once
          const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
          if (!pending || pending.challenge !== challenge || pending.redirectUri !== form.get("redirect_uri") || pending.clientId !== form.get("client_id")) {
            return void json(400, { error: "invalid_grant" });
          }
          return void json(200, this.#tokens(pending.clientId, pending.nonce));
        }
        if (form.get("grant_type") === "refresh_token") {
          if (this.renewalError) return void json(400, { error: this.renewalError });
          // Each refresh token works once and is replaced (token reference page).
          if (!this.#refresh.delete(form.get("refresh_token") ?? "")) return void json(400, { error: "refresh_token_reused" });
          return void json(200, this.#tokens(form.get("client_id")!));
        }
        return void json(400, { error: "unsupported_grant_type" });
      }
      case "/revoke":
        this.revoked.push(form);
        if (this.revokeHangs) return;
        return void json(this.revokeStatus);
      default:
        return void json(404);
    }
  }
}
```

**Create `tests/auth/oauth.test.ts`:**

```ts
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
    await expect(refresh({ ...ep, token_endpoint: server.url }, { clientId: "c", refreshToken: "secret-r" })).rejects.toThrow(
      new OAuthError("The request to OpenAI's sign-in service failed (unexpected redirect)."),
    );
    expect(asked).toBe(false);
  });

  it("says why OpenAI could not be reached, where Node's fetch says only \"fetch failed\"", async () => {
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await new Promise((resolve) => server.close(resolve)); // nothing listens there now
    await expect(discover(issuer)).rejects.toThrow("The request to OpenAI's sign-in service failed (connect ECONNREFUSED");
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

  it("says plainly when the sign-in settings cannot be read, such as a Wi-Fi login page in their place", async () => {
    for (const answer of [webPage, shapeless]) {
      await expect(discover((await serve(answer)).url)).rejects.toThrow(new OAuthError("OpenAI's sign-in settings could not be read."));
    }
  });

  it("passes on a Ctrl-C while the settings are arriving, rather than calling them unreadable", async () => {
    const stop = new AbortController();
    const server = await serve((res) => {
      res.writeHead(200, { "content-type": "application/json" }).write('{"issuer":');
      setTimeout(() => stop.abort(), 20); // once the answer has begun
    });
    await expect(discover(server.url, stop.signal)).rejects.toThrow("aborted");
  });
});

// Answers in place of OpenAI's: a web page, and JSON without the fields asked for.
const webPage = (res: http.ServerResponse) => res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><p>Sign in to the Wi-Fi</p>");
const shapeless = (res: http.ServerResponse) => res.writeHead(200, { "content-type": "application/json" }).end('{"keys":"none"}');

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
    ["sub", { sub: "" }, "The ID token is malformed."],
  ])("refuses the wrong %s", async (_, change, message) => {
    const { fake, good, check } = await setup();
    await expect(check(fake.idToken({ ...good, ...change }))).rejects.toThrow(message);
  });

  it("says plainly when OpenAI's signing keys cannot be read", async () => {
    const { fake, good } = await setup();
    const ep = await discover(fake.issuer);
    for (const answer of [webPage, shapeless]) {
      const keys = { ...ep, jwks_uri: (await serve(answer)).url };
      await expect(verifyIdToken(keys, fake.idToken(good), { clientId: "oaiapp_1", nonce: "n" })).rejects.toThrow(new OAuthError("OpenAI's signing keys could not be read."));
    }
  });

  it("refuses a bad signature, an unknown key and an algorithm other than RS256", async () => {
    const { fake, good, check } = await setup();
    const [h, b] = fake.idToken(good).split(".");
    const other = fake.idToken({ ...good, sub: "someone-else" }).split(".")[2];
    await expect(check(`${h}.${b}.${other}`)).rejects.toThrow("signature is wrong");
    await expect(check(fake.idToken(good, "k2"))).rejects.toThrow("key OpenAI does not publish");
    const none = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    await expect(check(`${none}.${b}.x`)).rejects.toThrow("not signed with RS256");
    for (const head of ["{not json", "null"]) await expect(check(`${Buffer.from(head).toString("base64url")}.${b}.x`)).rejects.toThrow(new OAuthError("The ID token is malformed."));
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

  it("passes on a Ctrl-C while the keys are arriving, rather than calling them unreadable", async () => {
    const { fake, good } = await setup();
    const stop = new AbortController();
    const keys = await serve((res) => {
      res.writeHead(200, { "content-type": "application/json" }).write('{"keys":');
      setTimeout(() => stop.abort(), 20); // once the answer has begun
    });
    const ep = { ...(await discover(fake.issuer)), jwks_uri: keys.url };
    await expect(verifyIdToken(ep, fake.idToken(good), { clientId: "oaiapp_1", nonce: "n" }, stop.signal)).rejects.toThrow("aborted");
  });
});
```


**Step 2: Run them and see them fail**

Run: `npm test -- tests/auth/oauth.test.ts`

Expected: FAIL. In the scratch build: Test Files 1 failed (1), before any test runs. `src/auth/oauth.ts` does not exist yet.

**Step 3: Write the code**

**Create `src/auth/oauth.ts`:**

```ts
import { createHash, createPublicKey, type JsonWebKey, randomBytes, verify } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { connectReason } from "../core/types.js";

// OpenAI's Sign in with ChatGPT for open-source tools, from its docs (developers.openai.com/siwc/
// token-sharing-open-source and its pages "sign-in", "accounts and sessions" and "token reference",
// read 2026-10-23). No code is copied from OpenAI's devkit, whose licence forbids commercial use.

export const ISSUER = "https://auth.openai.com";
export const RESOURCE = "https://api.openai.com/v1";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
// Identity scopes, then the plan-use scopes (sign-in page, `scope` row).
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
// The first-time registration entry point. Never saved and never used to exchange a code.
export const FIRST_CLIENT = "dynamic_agent_client";
const APP_NAME = "Tachikoma";

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

// Node's fetch fails with only "fetch failed"; the reason, such as a refused redirect or a host that
// cannot be found, is further down (connectReason). Ctrl-C's error is passed on as it is.
async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (init.signal?.aborted || !(err instanceof Error)) throw err;
    throw new OAuthError(`The request to OpenAI's sign-in service failed (${connectReason(err)}).`);
  }
}

const EndpointsSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  jwks_uri: z.string(),
  revocation_endpoint: z.string(),
});
export type Endpoints = z.infer<typeof EndpointsSchema>;

// The docs say to load the endpoints from OpenAI's discovery document.
export async function discover(issuer = ISSUER, signal?: AbortSignal): Promise<Endpoints> {
  const res = await request(`${issuer}/.well-known/openid-configuration`, { signal });
  if (!res.ok) throw new OAuthError(`Could not read OpenAI's sign-in settings (HTTP ${res.status}).`, undefined, res.status);
  // Not JSON, such as a Wi-Fi login page in its place, or without these fields.
  const parsed = EndpointsSchema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) {
    signal?.throwIfAborted(); // cut off by Ctrl-C, rather than unreadable
    throw new OAuthError("OpenAI's sign-in settings could not be read.");
  }
  const ep = parsed.data;
  if (ep.issuer !== issuer) throw new OAuthError(`OpenAI's sign-in settings name the wrong issuer (${ep.issuer}).`);
  return ep;
}

// 32 random bytes, as RFC 7636 (section 4.1) recommends for the PKCE verifier; used for state and
// nonce too.
const random = () => randomBytes(32).toString("base64url");

export function newAttempt(): { verifier: string; challenge: string; state: string; nonce: string } {
  const verifier = random();
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url"), state: random(), nonce: random() };
}

export function authorizeUrl(
  ep: Endpoints,
  p: { clientId: string; hostId: string; redirectUri: string; state: string; nonce: string; challenge: string; idTokenHint?: string; loginHint?: string },
): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    response_type: "code",
    redirect_uri: p.redirectUri,
    scope: SCOPES,
    resource: RESOURCE,
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    ext_agent_host_id: p.hostId,
  });
  // The app's name goes only on the first registration; a returning sign-in sends the hints instead.
  if (p.clientId === FIRST_CLIENT) q.set("agent_name_hint", APP_NAME);
  if (p.idTokenHint) q.set("id_token_hint", p.idTokenHint);
  if (p.loginHint) q.set("login_hint", p.loginHint);
  return `${ep.authorization_endpoint}?${q}`;
}

// The page the browser lands on, and the one for the start address opened again. They load nothing
// from anywhere (`default-src 'none'`).
const PAGE = "<!doctype html><meta charset=utf-8><title>Tachikoma</title><p>You can close this tab. Tachikoma shows whether sign-in worked.</p>";
const USED = "<!doctype html><meta charset=utf-8><title>Tachikoma</title><p>This sign-in was already opened in another tab. Finish it there, or stop it in Tachikoma and sign in again.</p>";
const HTML = { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'", "cache-control": "no-store" };

export interface Listener {
  redirectUri: string;
  // The address to open or print. It sends the browser on to the authorize address set by `begin`, so
  // the ID token sent as a hint never shows on screen or in the list of running programs.
  startUri: string;
  begin(authorizeUrl: string): void;
  reply: Promise<URLSearchParams>;
  close(): void;
}

// Waits on 127.0.0.1, on any free port, at /auth/callback: the docs require that address form and
// rule out `localhost`. A reply with another attempt's state is turned away and the wait goes on; the
// first matching reply ends it, and the listener closes.
export async function listen(state: string, signal?: AbortSignal): Promise<Listener> {
  let settle!: { resolve: (q: URLSearchParams) => void; reject: (e: Error) => void };
  const reply = new Promise<URLSearchParams>((resolve, reject) => (settle = { resolve, reject }));
  reply.catch(() => {}); // Ctrl-C may come before anyone waits for it
  let target: string | undefined;
  let started = false;
  const server = http.createServer((req, res) => {
    // Any program here can send a request line that is not an address; it is turned away, not thrown.
    const url = URL.parse(req.url ?? "/", "http://127.0.0.1");
    if (!url) return void res.writeHead(400).end();
    // Once only: the address holds the ID token sent as a hint, and any program here could ask for it.
    if (req.method === "GET" && url.pathname === "/auth/start" && target) {
      if (started) return void res.writeHead(410, HTML).end(USED);
      started = true;
      return void res.writeHead(302, { location: target, "cache-control": "no-store" }).end();
    }
    if (req.method !== "GET" || url.pathname !== "/auth/callback") return void res.writeHead(404).end();
    if (url.searchParams.get("state") !== state) return void res.writeHead(400, { "content-type": "text/plain" }).end("This reply is not for the sign-in Tachikoma is waiting for.");
    // Once the page is sent, a browser's spare connection is closed too.
    res.writeHead(200, { ...HTML, connection: "close" }).end(PAGE, () => server.closeAllConnections());
    settle.resolve(url.searchParams);
    close();
  });
  const close = () => {
    server.close();
    server.closeIdleConnections();
    signal?.removeEventListener("abort", onAbort);
  };
  const onAbort = () => {
    settle.reject(new OAuthError("Sign-in was cancelled."));
    close();
  };
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth`;
  return { redirectUri: `${base}/callback`, startUri: `${base}/start`, begin: (url) => (target = url), reply, close };
}

// The token reference page lists these fields. `earliest_refresh_at` is kept as sent (see store.ts).
const TokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  id_token: z.string().optional(),
  expires_in: z.number(),
  scope: z.string(),
  earliest_refresh_at: z.unknown().optional(),
});
export type TokenResponse = z.infer<typeof TokenSchema>;

// A form POST to an OpenAI sign-in endpoint. Errors carry OpenAI's code, never a token.
async function post(url: string, form: Record<string, string>, signal?: AbortSignal): Promise<Response> {
  // A redirect would send the form, tokens and all, to another address.
  const res = await request(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form), redirect: "error", signal });
  if (res.ok) return res;
  let code: string | undefined;
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") code = body.error;
  } catch {
    signal?.throwIfAborted(); // otherwise not JSON
  }
  throw new OAuthError(`OpenAI refused the request (HTTP ${res.status}${code ? `, ${code}` : ""}).`, code, res.status);
}

// A reply that cannot be read is an error that quotes none of it: it holds tokens.
async function tokens(ep: Endpoints, form: Record<string, string>, signal?: AbortSignal): Promise<TokenResponse> {
  const res = await post(ep.token_endpoint, { ...form, resource: RESOURCE }, signal);
  const parsed = TokenSchema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) {
    signal?.throwIfAborted(); // cut off by Ctrl-C, rather than unreadable
    throw new OAuthError("OpenAI's sign-in reply could not be read.");
  }
  return parsed.data;
}

export function exchange(ep: Endpoints, p: { clientId: string; code: string; verifier: string; redirectUri: string }, signal?: AbortSignal): Promise<TokenResponse> {
  return tokens(ep, { grant_type: "authorization_code", client_id: p.clientId, code: p.code, code_verifier: p.verifier, redirect_uri: p.redirectUri }, signal);
}

// No `scope`, which keeps the grant as it is (accounts and sessions page).
export function refresh(ep: Endpoints, p: { clientId: string; refreshToken: string }, signal?: AbortSignal): Promise<TokenResponse> {
  return tokens(ep, { grant_type: "refresh_token", client_id: p.clientId, refresh_token: p.refreshToken }, signal);
}

// An empty HTTP 200 means revoked, also for a token that was already invalid.
export async function revoke(ep: Endpoints, p: { clientId: string; refreshToken: string }, signal?: AbortSignal): Promise<void> {
  await post(ep.revocation_endpoint, { token: p.refreshToken, token_type_hint: "refresh_token", client_id: p.clientId }, signal);
}

const ClaimsSchema = z.object({ iss: z.string(), aud: z.union([z.string(), z.array(z.string())]), azp: z.string().optional(), exp: z.number(), nonce: z.string().optional(), sub: z.string().min(1), email: z.string().optional() });
const JwksSchema = z.object({ keys: z.array(z.looseObject({ kid: z.string().optional() })) });

// The docs' checks, in order: the signature against OpenAI's published keys, then issuer, audience
// (the issued client ID), expiry and nonce. OpenAI signs with RS256 only (its discovery document,
// `id_token_signing_alg_values_supported`), so nothing else is accepted.
export async function verifyIdToken(ep: Endpoints, idToken: string, p: { clientId: string; nonce: string }, signal?: AbortSignal): Promise<{ sub: string; email?: string }> {
  const [head, body, sig] = idToken.split(".");
  if (!head || !body || !sig) throw new OAuthError("The ID token is malformed.");
  let header: { alg?: unknown; kid?: unknown } | null;
  try {
    header = JSON.parse(Buffer.from(head, "base64url").toString("utf8"));
  } catch {
    header = null;
  }
  if (!header || typeof header !== "object") throw new OAuthError("The ID token is malformed.");
  if (header.alg !== "RS256") throw new OAuthError("The ID token is not signed with RS256.");
  const res = await request(ep.jwks_uri, { signal });
  if (!res.ok) throw new OAuthError(`Could not read OpenAI's signing keys (HTTP ${res.status}).`, undefined, res.status);
  const keys = JwksSchema.safeParse(await res.json().catch(() => undefined));
  if (!keys.success) {
    signal?.throwIfAborted();
    throw new OAuthError("OpenAI's signing keys could not be read.");
  }
  const jwk = keys.data.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new OAuthError("The ID token was signed with a key OpenAI does not publish.");
  const key = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
  if (!verify("sha256", Buffer.from(`${head}.${body}`), key, Buffer.from(sig, "base64url"))) throw new OAuthError("The ID token's signature is wrong.");
  let claims: z.infer<typeof ClaimsSchema>;
  try {
    claims = ClaimsSchema.parse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
  } catch {
    throw new OAuthError("The ID token is malformed.");
  }
  if (claims.iss !== ep.issuer) throw new OAuthError("The ID token names the wrong issuer.");
  // With several audiences, `azp` names the one it was issued to (OpenID Connect Core 1.0, 3.1.3.7).
  if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(p.clientId) || (claims.azp !== undefined && claims.azp !== p.clientId))
    throw new OAuthError("The ID token is for another client.");
  if (claims.exp * 1000 <= Date.now()) throw new OAuthError("The ID token has expired.");
  if (claims.nonce !== p.nonce) throw new OAuthError("The ID token is not from this sign-in.");
  return { sub: claims.sub, ...(claims.email ? { email: claims.email } : {}) };
}
```


**Step 4: Run everything**

Run: `npm run typecheck`, then `npm test`

Expected: no type errors; Test Files 20 passed | 1 skipped (21); Tests 266 passed | 4 skipped (270).

**Step 5: Commit**

```bash
git add src/auth/oauth.ts tests/auth/fake-openai.ts tests/auth/oauth.test.ts
git commit -m "feat: OpenAI's sign-in protocol for open-source tools"
```

### Task 5: The saved login

`<data folder>/chatgpt.json` (release 2 design, "The saved login"):
- **The machine ID** (`urn:uuid:...`), made once and saved before its first use.
- **One record per registration,** keyed by OpenAI's issued client ID and the ID token's `sub`. The
  email is shown but never used as the key; the record also keeps the last ID token, for the hint.
- **The pending client ID** of a sign-in that has not finished.
- **The signed-in account:** its tokens, and whether plan use was granted.
- **A version number,** raised by every save.

`update()` takes the lock, reads the file again, and gives the work a `save` that raises the version
and writes the whole file. A damaged file is an error and is never replaced, since it holds the
client IDs. `tokensFrom()` turns a token response into what is saved; sign-in and renewal both use it.

**Files:**
- Create: `src/auth/store.ts`
- Create: `tests/auth/store.test.ts`

**Step 1: Write the failing tests**

**Create `tests/auth/store.test.ts`:**

```ts
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { LoginError, LoginStore } from "../../src/auth/store.js";

const temp = () => path.join(mkdtempSync(path.join(tmpdir(), "tachi-store-")), "data");

describe("LoginStore", () => {
  it("starts empty, with a new machine ID that says nothing about the user", () => {
    const login = new LoginStore(temp()).read();
    expect(login).toMatchObject({ version: 0, noticeShown: false, accounts: [] });
    expect(login.hostId).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
  });

  it("raises the version with each save and keeps what was saved", async () => {
    const store = new LoginStore(temp());
    await store.update(async (login, save) => {
      const first = save(login);
      save({ ...first, noticeShown: true });
    });
    expect(store.read()).toMatchObject({ version: 2, noticeShown: true });
  });

  it("refuses a damaged file and leaves it as it is", () => {
    const dir = temp();
    const store = new LoginStore(dir);
    store.read(); // makes the folder
    writeFileSync(store.file, "{ not json");
    expect(() => store.read()).toThrow(LoginError);
    expect(() => store.read()).toThrow("Move it aside, then sign in again with `tachi login chatgpt` (or /login chatgpt in a session).");
    expect(readFileSync(store.file, "utf8")).toBe("{ not json");
  });

  it("says which process it waits for, and which file to delete if none is running", async () => {
    const warnings: string[] = [];
    const store = new LoginStore(temp(), (w) => warnings.push(w));
    store.read(); // makes the folder
    writeFileSync(store.lockFile, String(process.ppid)); // running, and not this process
    const stop = new AbortController();
    const changing = store.update(async () => {}, stop.signal);
    while (!warnings.length) await new Promise((r) => setTimeout(r, 20));
    stop.abort();
    await expect(changing).rejects.toThrow();
    expect(warnings[0]).toContain(`process ${process.ppid}`);
    expect(warnings[0]).toContain(store.lockFile);
  });

  it("loses no change when two processes change the login at once", async () => {
    const dir = temp();
    const url = pathToFileURL(path.resolve("src/auth/store.ts")).href;
    const script = path.join(path.dirname(dir), "add.mts");
    // Each process adds five accounts, one change at a time, pausing between reading and saving so
    // that the two overlap.
    writeFileSync(
      script,
      `import { LoginStore } from ${JSON.stringify(url)};
const store = new LoginStore(${JSON.stringify(dir)}, () => {});
for (let i = 0; i < 5; i++) {
  await store.update(async (login, save) => {
    await new Promise((r) => setTimeout(r, 20));
    save({ ...login, accounts: [...login.accounts, { clientId: process.argv[2] + i, sub: "s" }] });
  });
}`,
    );
    const runs = ["a", "b"].map((tag) => new Promise((resolve) => spawn(process.execPath, ["--import", "tsx", script, tag], { stdio: "inherit" }).on("close", resolve)));
    expect(await Promise.all(runs)).toEqual([0, 0]);
    const login = new LoginStore(dir).read();
    expect(login.version).toBe(10);
    expect(login.accounts.map((a) => a.clientId).toSorted()).toEqual(["a0", "a1", "a2", "a3", "a4", "b0", "b1", "b2", "b3", "b4"]);
  }, 60_000);
});
```


**Step 2: Run them and see them fail**

Run: `npm test -- tests/auth/store.test.ts`

Expected: FAIL. In the scratch build: Test Files 1 failed (1), before any test runs. `src/auth/store.ts` does not exist yet.

**Step 3: Write the code**

**Create `src/auth/store.ts`:**

```ts
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
```


**Step 4: Run everything**

Run: `npm run typecheck`, then `npm test`

Expected: no type errors; Test Files 21 passed | 1 skipped (22); Tests 271 passed | 4 skipped (275).

**Step 5: Commit**

```bash
git add src/auth/store.ts tests/auth/store.test.ts
git commit -m "feat: the saved ChatGPT login"
```

### Task 6: `tachi login chatgpt` and `tachi logout chatgpt`

Signing in and out, from the command line (release 2 design, "Signing in" and "Signing out").

**Signing in:**
1. Under the lock: refuse if already signed in, choose the account (choice 1), save the machine ID,
   and note the version. OpenAI's settings are asked for only after this, so a signed-in user who
   is offline is told so.
2. Without the lock, since the user can take as long as they like: start the listener, say "Continue
   with ChatGPT in your browser.", open the local start address, and print it in case no browser
   opened. Ctrl-C stops the wait.
3. Check the reply:
   - `access_denied` means the user declined.
   - A first registration must come back with an issued client ID.
   - A returning sign-in must not come back with a different one.
4. Under the lock again:
   - Refuse if the version changed in the meantime (a logout, say).
   - Save the issued client ID as pending, then exchange the code and check the ID token.
   - Refuse a different account from the saved one, and ask OpenAI to cancel what it issued to it.
   - Save the account, the tokens and whether plan use (`chatgpt.tokens.use.direct`) was granted.
     Another account's unfinished registration stays pending, for the next `--new`.
5. The first time plan use is granted, show OpenAI's one-time notice. Then "Signed in as <email>.",
   or say that plan use was not allowed.

Ctrl-C stops every step: a wait for the lock, each request to OpenAI and the browser wait. Pressed
after OpenAI's last answer, it still stops the sign-in before anything is saved. The command then
says "Sign-in was cancelled." (or "Sign-out was cancelled."). Each step has a test, checked by
removing that step's Ctrl-C.

**Signing out:**
1. Under the lock, delete the tokens and every saved ID token, and save a new version, even with
   nobody signed in, so a sign-in still waiting in the browser is refused. Every ID token goes
   because the login may already have been dropped (a dead renewal, or a login that could not be
   read), and the next sign-in must not send its hint. The client IDs and machine ID stay.
2. Then, holding no lock, ask OpenAI to revoke the renewal token, kept in memory for this. A slow
   answer leaves nothing on disk and blocks no other process; Ctrl-C stops the wait. If OpenAI cannot
   confirm, the user is told why (after Ctrl-C: "You stopped waiting for its answer."), and a
   Ctrl-C there makes the command exit 130, as every other Ctrl-C does.

`accountCommand()` is shared by the command line and, from Task 11, the session.

The command-line tests get 15 s each, as release 1's other process-starting tests do: with the whole
suite running, two starts of the command took up to 5.03 s here, past Vitest's 5 s default.

**Files:**
- Create: `src/auth/chatgpt.ts`
- Modify: `src/cli.tsx`
- Create: `tests/auth/chatgpt.test.ts`
- Modify: `tests/cli.test.ts`

**Step 1: Write the failing tests**

**Create `tests/auth/chatgpt.test.ts`:**

```ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { accountCommand, type LoginIO, loginArgs, signIn, signOut } from "../../src/auth/chatgpt.js";
import { LoginError, LoginStore } from "../../src/auth/store.js";
import { FakeOpenAI } from "./fake-openai.js";

async function setup(warn: (line: string) => void = () => {}) {
  const fake = await FakeOpenAI.start();
  const store = new LoginStore(path.join(mkdtempSync(path.join(tmpdir(), "tachi-login-")), "data"), warn);
  const said: string[] = [];
  const io: LoginIO = { say: (l) => said.push(l), openBrowser: fake.browser };
  const opts = { issuer: fake.issuer };
  return { fake, store, said, io, opts };
}

// Ctrl-C while the request to `path` waits for an answer that never comes, so only Ctrl-C can end
// it; or, with `answered`, just after the answer has arrived.
function ctrlCAt(path: string, stop: AbortController, answered = false): void {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (!String(input).endsWith(path)) return real(input, init);
    if (answered) {
      const body = await (await real(input, init)).text();
      stop.abort();
      return new Response(body, { headers: { "content-type": "application/json" } });
    }
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      stop.abort();
    });
  });
  onTestFinished(() => void vi.restoreAllMocks());
}

// A browser that takes `reply` back to the sign-in's callback, in place of OpenAI's answer.
function browserReplying(reply: Record<string, string>): (url: string) => void {
  return (url) =>
    void (async () => {
      const authorize = new URL((await fetch(url, { redirect: "manual" })).headers.get("location")!);
      const back = new URL(authorize.searchParams.get("redirect_uri")!);
      back.search = new URLSearchParams({ state: authorize.searchParams.get("state")!, ...reply }).toString();
      await fetch(back);
    })().catch(() => {});
}

// Another process holds the lock: a running process that is not this one, as in the store's tests.
function lockHeld(store: LoginStore): void {
  store.read(); // makes the folder
  writeFileSync(store.lockFile, String(process.ppid));
}

const NOTICE = "You're using your ChatGPT plan. Eligible usage in this app uses your ChatGPT plan. Manage usage: https://chatgpt.com/settings/usage";

describe("loginArgs", () => {
  it("reads the provider and the account choice", () => {
    expect(loginArgs(["chatgpt"], "login")).toEqual({});
    expect(loginArgs(["ChatGPT"], "login")).toEqual({}); // the provider's name in any case
    expect(loginArgs(["ChatGPT"], "logout")).toEqual({});
    expect(loginArgs(["chatgpt", "--new"], "login")).toEqual({ fresh: true });
    expect(loginArgs(["chatgpt", "--account", "2"], "login")).toEqual({ account: 2 });
    expect(loginArgs(["chatgpt"], "logout")).toEqual({});
  });

  it.each([[["openai"]], [[]], [["chatgpt", "--account", "0"]], [["chatgpt", "--new", "--account", "1"]], [["chatgpt", "x"]]])("refuses %j", (words) => {
    expect(() => loginArgs(words, "login")).toThrow(LoginError);
  });

  it("takes nothing after logout chatgpt", () => {
    expect(() => loginArgs(["chatgpt", "--new"], "logout")).toThrow("Usage: tachi logout chatgpt");
  });

  it("names the command as it is typed: with tachi on the command line, with a slash in a session", () => {
    expect(() => loginArgs(["openai"], "login")).toThrow(new LoginError("Only ChatGPT has a login: `tachi login chatgpt`. Other providers use an API key."));
    expect(() => loginArgs(["openai"], "logout", "/")).toThrow(new LoginError("Only ChatGPT has a logout: `/logout chatgpt`. Other providers use an API key."));
    expect(() => loginArgs([], "login", "/")).toThrow(new LoginError("Usage: /login chatgpt [--new | --account <number>]"));
    expect(() => loginArgs(["chatgpt", "now"], "logout", "/")).toThrow(new LoginError("Usage: /logout chatgpt"));
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

  it("lists the saved accounts when there are several, naming the command as it is typed", async () => {
    const { fake, store, io, opts } = await setup();
    await signIn(store, io, opts);
    await signOut(store, io, opts);
    Object.assign(fake, { sub: "user-2", email: "you@example.com" });
    await signIn(store, io, { ...opts, fresh: true });
    await signOut(store, io, opts);
    await expect(signIn(store, { ...io, prefix: "/" }, opts)).rejects.toThrow(
      new LoginError("Saved ChatGPT accounts:\n  1. you@example.com\n  2. me@example.com\nChoose one with `/login chatgpt --account <number>`, or add another with `--new`."),
    );
  });

  it("refuses to sign in twice", async () => {
    const { store, io, opts } = await setup();
    await signIn(store, io, opts);
    await expect(signIn(store, io, opts)).rejects.toThrow("Already signed in as me@example.com. Sign out first with `tachi logout chatgpt`.");
    await expect(signIn(store, { ...io, prefix: "/" }, opts)).rejects.toThrow("Already signed in as me@example.com. Sign out first with `/logout chatgpt`.");
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

  it.each([
    [{ error: "server_error" }, "Sign-in failed (server_error)."],
    [{}, "OpenAI's reply had no sign-in code. Try again."],
  ])("stops at a reply of %j, without exchanging anything", async (reply, message) => {
    const { fake, store, io, opts } = await setup();
    await expect(signIn(store, { ...io, openBrowser: browserReplying(reply) }, opts)).rejects.toThrow(new LoginError(message));
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it("refuses OpenAI's tokens when they come without an ID token, and saves no login", async () => {
    const { store, io, opts } = await setup();
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const res = await real(input, init);
      if (!String(input).endsWith("/token")) return res;
      const body = (await res.json()) as Record<string, unknown>;
      delete body.id_token;
      return Response.json(body);
    });
    onTestFinished(() => void vi.restoreAllMocks());
    await expect(signIn(store, io, opts)).rejects.toThrow(new LoginError("OpenAI's reply had no ID token, so the account could not be checked."));
    expect(store.read().active).toBeUndefined();
  });

  it("says when the saved account asked for does not exist, also with none saved", async () => {
    const { fake, store, io, opts } = await setup();
    await expect(signIn(store, io, { ...opts, account: 1 })).rejects.toThrow(new LoginError("There is no saved account 1."));
    expect(fake.authorizeRequests).toHaveLength(0); // nothing registered
    await signIn(store, io, opts);
    await signOut(store, io, opts);
    await expect(signIn(store, io, { ...opts, account: 2 })).rejects.toThrow(new LoginError("There is no saved account 2."));
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
    await expect(signIn(store, { ...io, prefix: "/" }, opts)).rejects.toThrow(
      new LoginError("That was a different ChatGPT account from me@example.com, so its sign-in was cancelled. To add another account, run `/login chatgpt --new`."),
    );
    expect(store.read().active).toBeUndefined();
    expect(fake.revoked.map((q) => q.get("client_id"))).toEqual(["oaiapp_1", "oaiapp_1"]); // the logout's, then the other account's
    fake.revokeStatus = 503;
    await expect(signIn(store, io, opts)).rejects.toThrow(
      new LoginError(
        "That was a different ChatGPT account from me@example.com, and OpenAI did not confirm that its sign-in was cancelled. OpenAI refused the request (HTTP 503). You can disconnect Tachikoma in that account's ChatGPT settings. To add another account, run `tachi login chatgpt --new`.",
      ),
    );
  });

  it("says the other account may still be connected when Ctrl-C stops that cancel", async () => {
    const { fake, store, said, io, opts } = await setup();
    await signIn(store, io, opts);
    await signOut(store, io, opts);
    fake.sub = "user-2";
    const stop = new AbortController();
    ctrlCAt("/revoke", stop);
    await expect(signIn(store, io, { ...opts, signal: stop.signal })).rejects.toThrow("aborted");
    expect(said.at(-1)).toBe(
      "That was a different ChatGPT account from me@example.com, and OpenAI did not confirm that its sign-in was cancelled. You stopped waiting for its answer. You can disconnect Tachikoma in that account's ChatGPT settings.",
    );
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

  it.each([
    ["asking for OpenAI's sign-in settings", "/.well-known/openid-configuration"],
    ["fetching OpenAI's signing keys", "/jwks"],
  ])("stops at Ctrl-C while %s, and saves no login", async (_, at) => {
    const { store, io, opts } = await setup();
    const stop = new AbortController();
    ctrlCAt(at, stop);
    await expect(signIn(store, io, { ...opts, signal: stop.signal })).rejects.toThrow("aborted");
    expect(store.read().active).toBeUndefined();
  });

  it("stops at Ctrl-C pressed just after OpenAI's last answer, and saves no login", async () => {
    const { store, io, opts } = await setup();
    const stop = new AbortController();
    ctrlCAt("/jwks", stop, true);
    await expect(signIn(store, io, { ...opts, signal: stop.signal })).rejects.toThrow("aborted");
    expect(store.read()).toMatchObject({ accounts: [] });
    expect(store.read().active).toBeUndefined();
  });

  it("stops at Ctrl-C while waiting for the browser", async () => {
    const { store, said, opts } = await setup();
    const stop = new AbortController();
    const io: LoginIO = { say: (l) => said.push(l), openBrowser: () => stop.abort() };
    await expect(signIn(store, io, { ...opts, signal: stop.signal })).rejects.toThrow("Sign-in was cancelled");
  });

  it.each(["before", "after"])("stops at Ctrl-C while waiting for the lock %s the browser, and saves nothing", async (when) => {
    const warnings: string[] = [];
    const { fake, store, said, opts } = await setup((w) => warnings.push(w));
    const io: LoginIO = {
      say: (l) => said.push(l),
      openBrowser: (url) => {
        lockHeld(store);
        fake.browser(url);
      },
    };
    if (when === "before") lockHeld(store);
    const stop = new AbortController();
    const out = signIn(store, io, { ...opts, signal: stop.signal });
    while (!warnings.length) await new Promise((r) => setTimeout(r, 10));
    stop.abort();
    await expect(out).rejects.toThrow("aborted");
    expect(store.read().pending).toBeUndefined(); // not even the issued client ID
    expect(store.read().active).toBeUndefined();
  });

  it("keeps another account's unfinished registration while signing in to a saved one", async () => {
    const { fake, store, io, opts } = await setup();
    await signIn(store, io, opts);
    await signOut(store, io, opts);
    fake.issuedClientId = "oaiapp_2";
    fake.idTokenIssuer = "https://evil.example"; // the new registration's exchange works, then its check fails
    await expect(signIn(store, io, { ...opts, fresh: true })).rejects.toThrow("wrong issuer");
    fake.idTokenIssuer = undefined;
    await signIn(store, io, opts); // the saved account
    expect(store.read().pending).toEqual({ clientId: "oaiapp_2" });
  });

  it("says it is already signed in, even when OpenAI cannot be reached", async () => {
    const { store, io, opts } = await setup();
    await signIn(store, io, opts);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    onTestFinished(() => void vi.restoreAllMocks());
    await expect(signIn(store, io, opts)).rejects.toThrow("Already signed in as me@example.com.");
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

  it("tells apart saved accounts with the same email by their client ID", async () => {
    const { fake, store, io, opts } = await setup();
    await signIn(store, io, opts);
    await signOut(store, io, opts);
    fake.issuedClientId = "oaiapp_2"; // the same person, registered again with --new
    await signIn(store, io, { ...opts, fresh: true });
    await signOut(store, io, opts);
    await expect(signIn(store, io, opts)).rejects.toThrow("1. me@example.com (oaiapp_2)\n  2. me@example.com (oaiapp_1)\n");
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
    expect(said.at(-1)).toBe(
      "Signed out on this computer, but OpenAI did not confirm that the sign-in was cancelled. OpenAI refused the request (HTTP 503). You can disconnect Tachikoma in ChatGPT's settings.",
    );
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
    expect(said.at(-1)).toBe(
      "Signed out on this computer, but OpenAI did not confirm that the sign-in was cancelled. You stopped waiting for its answer. You can disconnect Tachikoma in ChatGPT's settings.",
    );
  });

  it("stops at Ctrl-C while waiting for the lock, and changes nothing", async () => {
    const warnings: string[] = [];
    const { store, io, opts } = await setup((w) => warnings.push(w));
    await signIn(store, io, opts);
    lockHeld(store);
    const stop = new AbortController();
    const out = signOut(store, io, { ...opts, signal: stop.signal });
    while (!warnings.length) await new Promise((r) => setTimeout(r, 10));
    stop.abort();
    await expect(out).rejects.toThrow("aborted");
    expect(store.read().active?.tokens).toBeDefined();
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

describe("accountCommand", () => {
  it.each([
    ["login", "Sign-in was cancelled."],
    ["logout", "Sign-out was cancelled."],
  ] as const)("says the %s was cancelled at Ctrl-C", async (verb, message) => {
    vi.stubEnv("TACHI_DATA_DIR", path.join(mkdtempSync(path.join(tmpdir(), "tachi-login-")), "data"));
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed")); // never reaches OpenAI
    onTestFinished(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });
    await expect(accountCommand(verb, ["chatgpt"], () => {}, AbortSignal.abort())).rejects.toThrow(message);
  });

  it("names the commands with a slash when typed in a session", async () => {
    const { store, io, opts } = await setup();
    await signIn(store, io, opts);
    vi.stubEnv("TACHI_DATA_DIR", path.dirname(store.file));
    onTestFinished(() => void vi.unstubAllEnvs());
    await expect(accountCommand("login", ["chatgpt"], () => {}, undefined, "/")).rejects.toThrow(
      new LoginError("Already signed in as me@example.com. Sign out first with `/logout chatgpt`."),
    );
    await expect(accountCommand("login", ["openai"], () => {}, undefined, "/")).rejects.toThrow(
      new LoginError("Only ChatGPT has a login: `/login chatgpt`. Other providers use an API key."),
    );
  });
});
```

**Change `tests/cli.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/cli.test.ts b/tests/cli.test.ts
index 59eba18..14dd222 100644
--- a/tests/cli.test.ts
+++ b/tests/cli.test.ts
@@ -1,18 +1,24 @@
 import { spawnSync } from "node:child_process";
+import { mkdtempSync } from "node:fs";
+import { tmpdir } from "node:os";
 import path from "node:path";
 import { describe, expect, it } from "vitest";
 
 // Runs the real command through tsx. Every case here stops before any model is called.
-function tachi(...args: string[]) {
-  const r = spawnSync(process.execPath, ["--import", "tsx", path.resolve("src/cli.tsx"), ...args], {
+function tachi(...args: (string | Record<string, string>)[]) {
+  const env = args.find((a) => typeof a === "object") ?? {};
+  const words = args.filter((a) => typeof a === "string");
+  const r = spawnSync(process.execPath, ["--import", "tsx", path.resolve("src/cli.tsx"), ...words], {
     input: "x\n",
     encoding: "utf8",
-    env: { ...process.env, TACHI_LEAD: "", ANTHROPIC_API_KEY: "" },
+    env: { ...process.env, TACHI_LEAD: "", ANTHROPIC_API_KEY: "", ...env },
   });
   return { code: r.status, stdout: r.stdout, stderr: r.stderr };
 }
 
-describe("tachi", () => {
+// Each start takes about a second; with the whole suite running, two starts took up to 5 s (2026-10-23),
+// past Vitest's default. 15 s, as for the other tests that start processes (tests/exec/local.test.ts).
+describe("tachi", { timeout: 15_000 }, () => {
   it("names --fallback when its value is bad", () => {
     const r = tachi("--lead", "ollama:none", "--fallback", "nope", "-p", "hi");
     expect(r.code).toBe(1);
@@ -46,6 +52,20 @@ describe("tachi", () => {
     expect(r.stderr).toContain("Set ANTHROPIC_API_KEY to use anthropic");
   });
 
+  it("signs out of ChatGPT on its own, and says when nobody was signed in", () => {
+    const data = path.join(mkdtempSync(path.join(tmpdir(), "tachi-cli-")), "data");
+    const r = tachi("logout", "chatgpt", { TACHI_DATA_DIR: data });
+    expect(r.code).toBe(0);
+    expect(r.stdout.trim()).toBe("Not signed in to ChatGPT.");
+  });
+
+  it("explains login's usage instead of starting a sign-in", () => {
+    expect(tachi("login", "openai").stderr).toContain("Only ChatGPT has a login: `tachi login chatgpt`. Other providers use an API key.");
+    const r = tachi("login", "chatgpt", "--account", "x");
+    expect(r.code).toBe(1);
+    expect(r.stderr).toContain("Usage: tachi login chatgpt [--new | --account <number>]");
+  });
+
   it("refuses interactive mode without a terminal, before starting the interface", () => {
     const r = tachi("--lead", "ollama:none");
     expect(r.code).toBe(1);
```


**Step 2: Run them and see them fail**

Run: `npm test -- tests/auth/chatgpt.test.ts tests/cli.test.ts`

Expected: FAIL. In the scratch build: Test Files 2 failed (2); Tests 2 failed | 6 passed (8). `src/auth/chatgpt.ts` does not exist yet, and the command treats `login` as a lead-less run.

**Step 3: Write the code**

**Create `src/auth/chatgpt.ts`:**

```ts
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
  prefix?: string; // how a command is typed, for the messages: CLI (the default) or "/" in a session
}

const CLI = "tachi "; // how a command is typed on the command line

// The system's own way to open an address, with no shell in between and no API keys passed on.
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32" ? [system32("rundll32.exe"), ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true, env: commandEnv() });
  child.on("error", () => {}); // no browser: the address is printed anyway
  child.unref();
}

// The words after `login` or `logout`, on the command line or after `/login` in a session; `prefix` is
// how a command is typed there, for the messages.
export function loginArgs(words: string[], verb: "login" | "logout", prefix = CLI): { account?: number; fresh?: boolean } {
  const [provider, ...rest] = words;
  const usage = new LoginError(verb === "login" ? `Usage: ${prefix}login chatgpt [--new | --account <number>]` : `Usage: ${prefix}logout chatgpt`);
  if (provider === undefined) throw usage;
  if (provider.toLowerCase() !== "chatgpt") throw new LoginError(`Only ChatGPT has a ${verb}: \`${prefix}${verb} chatgpt\`. Other providers use an API key.`);
  if (verb === "logout" && rest.length) throw usage;
  if (rest.length === 1 && rest[0] === "--new") return { fresh: true };
  if (rest.length === 2 && rest[0] === "--account" && /^[1-9]\d*$/.test(rest[1]!)) return { account: Number(rest[1]) };
  if (rest.length) throw usage;
  return {};
}

const signedIn = (login: SavedLogin) => (login.active?.tokens ? login.active : undefined);
const who = (login: SavedLogin, a = signedIn(login)) => login.accounts.find((x) => x.clientId === a?.clientId && x.sub === a?.sub)?.email ?? "your ChatGPT account";

// Which saved account to sign in to: the only one, the one asked for, or a new one.
function choose(login: SavedLogin, opts: { account?: number; fresh?: boolean }, typed: string): Account | undefined {
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
  throw new LoginError(`Saved ChatGPT accounts:\n${list}\nChoose one with \`${typed}login chatgpt --account <number>\`, or add another with \`--new\`.`);
}

export async function signIn(store: LoginStore, io: LoginIO, opts: { account?: number; fresh?: boolean; issuer?: string; signal?: AbortSignal } = {}): Promise<void> {
  const typed = io.prefix ?? CLI;
  // Under the lock: check, choose the client ID, and save the machine ID before its first use.
  const start = await store.update(async (login, save) => {
    if (signedIn(login)) throw new LoginError(`Already signed in as ${who(login)}. Sign out first with \`${typed}logout chatgpt\`.`);
    const account = choose(login, opts, typed);
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
      const again = `To add another account, run \`${typed}login chatgpt --new\`.`;
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

// `login chatgpt …` or `logout chatgpt`, typed on the command line, or in a session with `prefix` "/".
export async function accountCommand(verb: "login" | "logout", words: string[], say: (line: string) => void, signal?: AbortSignal, prefix = CLI): Promise<void> {
  const opts = loginArgs(words, verb, prefix);
  const store = new LoginStore(dataDir(), say);
  const io = { say, openBrowser, prefix };
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
```

**Change `src/cli.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/cli.tsx b/src/cli.tsx
index de9950f..c8090fa 100644
--- a/src/cli.tsx
+++ b/src/cli.tsx
@@ -4,6 +4,7 @@ import { constants } from "node:os";
 import path from "node:path";
 import { parseArgs } from "node:util";
 import { render } from "ink";
+import { accountCommand } from "./auth/chatgpt.js";
 import { endOnEpipe, headlessAnswer, headlessExit, jsonLine, prose, statusSegments } from "./clilib.js";
 import { Bus } from "./core/bus.js";
 import { attachErrorLog } from "./core/errorlog.js";
@@ -22,8 +23,10 @@ import { SEGMENTS } from "./tui/StatusLine.js";
 const HELP = `tachi: a coding agent for your terminal
 
 Usage:
-  tachi --lead <provider:model> [options]          interactive session
-  tachi --lead <provider:model> -p "<prompt>"      run one prompt, print the answer, exit
+  tachi --lead <provider:model> [options]            interactive session
+  tachi --lead <provider:model> -p "<prompt>"        run one prompt, print the answer, exit
+  tachi login chatgpt [--new | --account <number>]   sign in to use your ChatGPT plan
+  tachi logout chatgpt                               sign out of ChatGPT
 
 Options:
   --lead <spec>     anthropic:<model> | openai:<model> | openrouter:<model> | kimi:<model> | ollama:<model>
@@ -54,6 +57,20 @@ function oneOf<T extends string>(name: string, value: string | undefined, allowe
 process.stdout.on("error", endOnEpipe);
 process.stderr.on("error", endOnEpipe); // `tachi -p … 2>&1 | head -1`
 
+// `tachi login chatgpt` and `tachi logout chatgpt` do only that, then exit.
+const verb = process.argv[2];
+if (verb === "login" || verb === "logout") {
+  const stop = new AbortController();
+  process.once("SIGINT", () => stop.abort()); // Ctrl-C while the browser part waits
+  try {
+    await accountCommand(verb, process.argv.slice(3), (line) => console.log(prose(line)), stop.signal);
+    process.exit(stop.signal.aborted ? 128 + constants.signals.SIGINT : 0); // Ctrl-C can end the wait for OpenAI to cancel the sign-in, after signing out here
+  } catch (err) {
+    console.error(prose(errorText(err)));
+    process.exit(stop.signal.aborted ? 128 + constants.signals.SIGINT : 1);
+  }
+}
+
 let parsed;
 try {
   parsed = parseArgs({
```


**Step 4: Run everything**

Run: `npm run typecheck`, then `npm test`

Expected: no type errors; Test Files 22 passed | 1 skipped (23); Tests 319 passed | 4 skipped (323).

**Step 5: Commit**

```bash
git add src/auth/chatgpt.ts src/cli.tsx tests/auth/chatgpt.test.ts tests/cli.test.ts
git commit -m "feat: tachi login chatgpt and tachi logout chatgpt"
```

### Task 7: The first real sign-in (stop here)

**Stop after this task and do the first real sign-in.** The design puts it before the adapter. The
docs do not say whether a new, unlisted app needs OpenAI's approval, and that should show up before
anything else is built (release 2 design, "Order of building"). Signing in and reading the model list
use none of the plan's limit.

The check below prints what later tasks depend on. It prints no token: only sizes, types and model
names. It runs only with `TACHI_LIVE=1`.

**Files:**
- Create: `tests/live/chatgpt.live.test.ts`

**Step 1: Write the checks**

**Create `tests/live/chatgpt.live.test.ts`:**

```ts
import { describe, expect, it } from "vitest";
import { LoginStore } from "../../src/auth/store.js";
import { dataDir } from "../../src/core/datadir.js";

// The first real sign-in's checks (release 2 design, "Still to measure"). Run within an hour of
// `tachi login chatgpt`, before the login needs renewing:
//   TACHI_LIVE=1 npm test -- tests/live/chatgpt
// It prints what the plan's later tasks depend on: never a token, only sizes, types and model names.
// Reading the model list uses none of the plan's limit (models and inference page).
describe.skipIf(!process.env.TACHI_LIVE)("first real ChatGPT sign-in", () => {
  it("reports the saved login's shape and the account's model list", async () => {
    const active = new LoginStore(dataDir()).read().active;
    expect(active?.tokens, "Sign in first with `tachi login chatgpt`").toBeDefined();
    const t = active!.tokens!;
    const bytes = (s: string) => Buffer.byteLength(s, "utf8");
    const e = t.earliestRefreshAt;
    console.log(
      [
        `plan use granted: ${active!.planUse}`,
        `scopes: ${t.scopes.join(" ")}`,
        `token sizes in bytes: access ${bytes(t.access)}, refresh ${bytes(t.refresh)}`,
        `earliest_refresh_at: ${e === undefined ? "absent" : `${typeof e} ${JSON.stringify(e)}`}`,
        `seconds now: ${Math.floor(Date.now() / 1000)}; access token expires at second ${Math.floor(t.expiresAt / 1000)}`,
      ].join("\n"),
    );

    const res = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${t.access}` } });
    console.log(`model list: HTTP ${res.status}`);
    const body = (await res.json()) as { models?: Record<string, unknown>[] };
    console.log(`top-level fields: ${Object.keys(body).join(", ")}`);
    expect(Array.isArray(body.models)).toBe(true);
    for (const m of body.models!) {
      console.log(`${m.slug} | ${m.display_name} | visibility ${m.visibility} | context_window ${m.context_window ?? "absent"} | max_context_window ${m.max_context_window ?? "absent"}`);
    }
  }, 60_000);
});
```


**Step 2: Run everything**

Run: `npm run typecheck`, then `npm test`

Expected: no type errors; Test Files 22 passed | 2 skipped (24); Tests 319 passed | 5 skipped (324).

**Step 3: Commit**

```bash
git add tests/live/chatgpt.live.test.ts
git commit -m "test: live check for the first real ChatGPT sign-in"
```

**Step 4: Sign in for real (the user, in their own terminal)**

```bash
npm run build
node dist/cli.js login chatgpt
TACHI_LIVE=1 npm test -- tests/live/chatgpt
```

Run the check within an hour of signing in, before the login needs renewing (renewal comes in
Task 8).

**Step 5: Record the results, and decide what changes**

Write the results into the main design's "Still to measure" (item 16), with the date:

| Result | What it changes |
|---|---|
| Sign-in refused (the app is not allowed) | Stop. Nothing after this task is built until OpenAI's position is known. |
| `earliest_refresh_at` absent, or a number of seconds since 1970 near the access token's expiry | Nothing. |
| `earliest_refresh_at` in another form (milliseconds, a date string) | Task 8: change `earliestMs()` in `src/auth/access.ts` and its test to read that form. |
| The model list has `context_window` | Nothing; Task 9 reads it first. |
| No `context_window` | Nothing in code; the status line shows the tokens in use. |

### Task 8: Renewing the login

Before each request the login is read again, so a logout or another process's renewal is seen at once
(release 2 design, "Renewing" and "Signing out"):
- **Renewed when under 60 s are left**, and never before `earliest_refresh_at` (seconds since 1970,
  as the first real sign-in showed in Task 7).
- **Renewal takes the lock and reads the login again,** so when two processes need it at once, one
  renews and the other uses the new token. The renewal token changes with each renewal, so a second
  renewal with the old one would fail.
- **A dead renewal token** (`invalid_grant`, `refresh_token_reused` and the others the errors page
  lists): the tokens are dropped and the user is asked to sign in again. The account and its client
  ID stay.
- **A network failure, or a refusal for another reason:** the login is kept, and the user is told
  why and that they are still signed in. `invalid_client` ("Fix the client configuration", errors
  page) says that trying again will not help, and to sign out and register again with `--new`.
- **Ctrl-C stops the wait at once** and keeps the login; as with any Ctrl-C in a session, nothing
  more is said. Before the renewal is sent (the wait for the lock, the settings request), Ctrl-C
  stops it. A renewal already sent carries on and is saved: OpenAI replaces the renewal token as it
  answers, so losing the answer would sign the user out (the code review showed this). `tachi -p`
  stays until it is saved, as Node does while a request is open. Each step has a test that fails
  with that step's Ctrl-C handling removed.
- **The token comes with which account it is for** (client ID and `sub`), so the adapter can tell
  when the account changes.
- **Signed out, or plan use not allowed:** an error that says what to do. A renewal that takes plan
  use away refuses the request it was renewing for, too.

**Files:**
- Create: `src/auth/access.ts`
- Create: `tests/auth/access.test.ts`

**Step 1: Write the failing tests**

**Create `tests/auth/access.test.ts`:**

```ts
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
```


**Step 2: Run them and see them fail**

Run: `npm test -- tests/auth/access.test.ts`

Expected: FAIL. In the scratch build: Test Files 1 failed (1), before any test runs. `src/auth/access.ts` does not exist yet.

**Step 3: Write the code**

**Create `src/auth/access.ts`:**

```ts
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
```


**Step 4: Run everything**

Run: `npm run typecheck`, then `npm test`

Expected: no type errors; Test Files 23 passed | 2 skipped (25); Tests 343 passed | 5 skipped (348).

**Step 5: Commit**

```bash
git add src/auth/access.ts tests/auth/access.test.ts
git commit -m "feat: renew the ChatGPT login before a request, one process at a time"
```

### Task 9: The Responses API adapter

`chatgpt:` requests (release 2 design, "Requests"; OpenAI's models and inference and preview
limitations pages):
- **Every request** is streamed and not stored (`stream: true`, `store: false`). It carries the whole
  conversation, puts the system prompt in `instructions`, and sends none of the refused fields. The
  SDK's retries are off.
- **The client is made for each request** with the token just read (see "Different from the design").
  The login is read again after the model check, so a logout while the list was fetched stops the
  request, and a switch to another account in that time is checked against that account's list.
- **Tools go in one namespace,** `tachikoma`, in the `openai` package's `NamespaceTool` shape. A tool
  name in a reply that is not Tachikoma's keeps its full name, so the session refuses it as unknown.
- **The reply is read from each item's finished form** (`response.output_item.done`). The `openai`
  package says to use that form of a reasoning item's `encrypted_content`. It counts only on
  `response.completed`. The items are kept as the turn's `native` content and sent back exactly while
  ChatGPT leads, as Anthropic's thinking is.
- **The plan's errors,** by OpenAI's codes. The usage limit gives "ChatGPT usage limit reached.
  Review your plan or this app's limit: https://chatgpt.com/settings/usage", from a refused request
  or part way through a stream. None is retried, and billing never moves to an API key. Each message
  quotes OpenAI's own words and keeps the HTTP status, the code, `error.param` and the request ID, as
  the errors and recovery page asks.
- **The model is checked against the account's model list** on the first request (choice 4), and
  again after a switch to another account. The same list gives the context window, read from the
  list the last request fetched, so the status line never touches the login (see "Different from the
  design").

`parseArgs` in `openai.ts` is exported for the adapter's tool arguments, so both adapters handle broken
JSON the same way.

**Files:**
- Create: `src/providers/chatgpt.ts`
- Modify: `src/providers/openai.ts`
- Create: `tests/providers/chatgpt.test.ts`

**Step 1: Write the failing tests**

**Create `tests/providers/chatgpt.test.ts`:**

```ts
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import { describe, expect, it, onTestFinished } from "vitest";
import type { ChatGPTAuth } from "../../src/auth/access.js";
import type { Message, ToolSpec } from "../../src/core/types.js";
import { ChatGPTProvider, fromStream, toolsFor, toResponses, USAGE_LIMIT } from "../../src/providers/chatgpt.js";

const tools: ToolSpec[] = [{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 120 };
const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque" };
const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", namespace: "tachikoma", arguments: '{"path":"a.txt"}', status: "completed" };
const text = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done.", annotations: [] }] };

const done = (item: unknown) => ({ type: "response.output_item.done", item }) as unknown as ResponseStreamEvent;
const completed = { type: "response.completed", response: { usage } } as unknown as ResponseStreamEvent;
async function* events(...list: ResponseStreamEvent[]) {
  yield* list;
}

describe("toResponses", () => {
  it("converts the conversation, tool calls and results included", () => {
    const history: Message[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      { role: "assistant", parts: [{ type: "text", text: "looking" }, { type: "tool_call", id: "toolu_1", name: "read_file", input: { path: "a" } }], native: { provider: "anthropic", content: [] } },
      { role: "user", parts: [{ type: "tool_result", callId: "toolu_1", output: "nope", isError: true }] },
    ];
    expect(toResponses(history)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "looking" },
      { type: "function_call", call_id: "toolu_1", name: "read_file", namespace: "tachikoma", arguments: '{"path":"a"}' },
      { type: "function_call_output", call_id: "toolu_1", output: "Error: nope" },
    ]);
  });

  it("sends a ChatGPT turn back exactly as it came, encrypted reasoning included", () => {
    const history: Message[] = [{ role: "assistant", parts: [], native: { provider: "chatgpt", content: [reasoning, call] } }];
    expect(toResponses(history)).toEqual([reasoning, call]);
  });
});

describe("toolsFor", () => {
  it("groups the tools in one namespace, as the plan's route requires", () => {
    expect(toolsFor(tools)).toEqual([
      {
        type: "namespace",
        name: "tachikoma",
        description: "Tachikoma's tools, which act on the user's project.",
        tools: [{ type: "function", name: "read_file", description: "Read a file", parameters: tools[0]!.inputSchema }],
      },
    ]);
    expect(toolsFor([])).toEqual([]);
  });
});

describe("fromStream", () => {
  it("reads the finished items, keeps them in order to send back, and splits the cached tokens", async () => {
    const turn = await fromStream(events(done(reasoning), done(text), done(call), completed), tools);
    expect(turn.parts).toEqual([
      { type: "text", text: "Done." },
      { type: "tool_call", id: "call_1", name: "read_file", input: { path: "a.txt" } },
    ]);
    expect(turn.native).toEqual({ provider: "chatgpt", content: [reasoning, text, call] });
    expect(turn.usage).toEqual({ input: 60, output: 20, cacheRead: 30, cacheWrite: 10 });
    expect(turn.cutOff).toBeUndefined();
  });

  it("gives a tool name that is not Tachikoma's its full name, so the session refuses it", async () => {
    const other = { ...call, namespace: "web", name: "search" };
    const turn = await fromStream(events(done(other), completed), tools);
    expect(turn.parts[0]).toMatchObject({ name: "web__search" });
  });

  it("maps a call with no namespace back to Tachikoma's tool, and leaves an unknown one as it is", async () => {
    const { namespace: _, ...bare } = call;
    const turn = await fromStream(events(done(bare), done({ ...bare, call_id: "call_2", name: "nope" }), done({ ...call, call_id: "call_3", name: "nope" }), completed), tools);
    expect(turn.parts.map((p) => p.type === "tool_call" && p.name)).toEqual(["read_file", "nope", "tachikoma__nope"]);
  });

  it("treats a stream that ends without response.completed as an error", async () => {
    await expect(fromStream(events(done(text)), tools)).rejects.toThrow(new Error("OpenAI's reply stopped before it finished. Try again."));
    await expect(fromStream(events(done(text)), tools, "req_1")).rejects.toThrow(new Error("OpenAI's reply stopped before it finished. Try again. OpenAI's request ID: req_1."));
  });

  it("stops on the usage limit, even part way through a stream", async () => {
    const failed = { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } } as unknown as ResponseStreamEvent;
    await expect(fromStream(events(done(text), failed), tools)).rejects.toThrow(new Error(USAGE_LIMIT));
    const error = { type: "error", code: "subscription_sharing_usage_unavailable", message: "busy", param: null } as unknown as ResponseStreamEvent;
    await expect(fromStream(events(error), tools)).rejects.toThrow(new Error("ChatGPT plan use is unavailable right now (subscription_sharing_usage_unavailable). busy. Your sign-in is kept; try again later."));
  });

  it("says what each of the plan's errors means, in OpenAI's words, with the request ID", async () => {
    const error = (code: string, message: string, param: string | null = null) => ({ type: "error", code, message, param }) as unknown as ResponseStreamEvent;
    const cases: [ResponseStreamEvent, string][] = [
      [error("subscription_sharing_user_not_eligible", "Not for this workspace."), "This ChatGPT account cannot use its plan here (subscription_sharing_user_not_eligible). Not for this workspace. Use openai:<model> with an API key instead."],
      ...["chatpass_v2_scope_not_authorized", "chatpass_v2_invalid_authorization_context"].map((code): [ResponseStreamEvent, string] => [
        error(code, "Not granted"),
        `OpenAI says this ChatGPT sign-in's permissions do not cover the request (${code}). Not granted. Sign out with \`tachi logout chatgpt\`, then sign in again with \`tachi login chatgpt\` (or /logout chatgpt and /login chatgpt in a session) and allow plan use.`,
      ]),
      [error("subscription_sharing_invalid_user", "Unknown user"), "OpenAI did not accept the ChatGPT sign-in (subscription_sharing_invalid_user). Unknown user. Sign out with `tachi logout chatgpt`, then sign in again with `tachi login chatgpt` (or /logout chatgpt and /login chatgpt in a session)."],
      [error("subscription_sharing_user_unavailable", "Try later!"), "ChatGPT plan use is unavailable right now (subscription_sharing_user_unavailable). Try later! Your sign-in is kept; try again later."],
      [error("subscription_sharing_unsupported_capability", "Not on this route", "tools"), "OpenAI could not complete the request (subscription_sharing_unsupported_capability, about tools). Not on this route."],
      [{ type: "response.failed", response: { error: { code: "server_error", message: "" } } } as unknown as ResponseStreamEvent, "OpenAI could not complete the request (server_error). The reply failed."],
    ];
    for (const [event, message] of cases) await expect(fromStream(events(event), tools, "req_1")).rejects.toThrow(new Error(`${message} OpenAI's request ID: req_1.`));
  });

  it("marks a reply cut short, by the length limit or OpenAI's content filter, and a refusal", async () => {
    const short = (reason: string) => ({ type: "response.incomplete", response: { usage, incomplete_details: { reason } } }) as unknown as ResponseStreamEvent;
    expect((await fromStream(events(done(text), short("max_output_tokens")), tools)).cutOff).toEqual({ kind: "max_tokens", detail: "The response reached its length limit" });
    expect((await fromStream(events(short("max_messages")), tools)).cutOff).toEqual({ kind: "max_tokens", detail: 'The response stopped early, for a reason OpenAI gives as "max_messages"' });
    expect((await fromStream(events(short("content_filter")), tools)).cutOff).toEqual({ kind: "refusal", detail: "OpenAI's content filter stopped the response" });
    const refused = { ...text, content: [{ type: "refusal", refusal: "No." }] };
    expect((await fromStream(events(done(refused), completed), tools)).cutOff).toEqual({ kind: "refusal", detail: "No." });
  });
});

// A stand-in for api.openai.com: the account's model list and a streamed Responses reply.
const planList = [{ slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" }, { slug: "hidden", display_name: "Hidden", visibility: "hide", context_window: 9 }];
const json = (res: http.ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { "content-type": "application/json", "x-request-id": "req_9" }).end(JSON.stringify(body));

async function fakeApi(respond: (body: Record<string, unknown>, res: http.ServerResponse) => void, list: (res: http.ServerResponse) => void = (res) => json(res, 200, { models: planList })) {
  const seen: { auth?: string; body: Record<string, unknown> }[] = [];
  let lists = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      lists++;
      return list(res);
    }
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text) as Record<string, unknown>;
    seen.push({ auth: req.headers.authorization, body });
    respond(body, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  onTestFinished(() => {
    server.close();
    server.closeAllConnections();
  });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, lists: () => lists };
}

const sse = (res: http.ServerResponse, list: unknown[]) => {
  res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req_9" });
  for (const e of list) res.write(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
};
const auth = { check: () => {}, token: async () => ({ token: "tok-1", account: "app user-1" }) } as unknown as ChatGPTAuth;
const request = { system: "be brief", messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "hi" }] }], tools };

describe("ChatGPTProvider", () => {
  it("streams an unstored request with the login, the instructions and the grouped tools, and nothing the route refuses", async () => {
    const api = await fakeApi((_, res) => sse(res, [done(text), completed]));
    const turn = await new ChatGPTProvider("gpt-6.1-sol", auth, api.base).complete(request);
    expect(turn.parts).toEqual([{ type: "text", text: "Done." }]);
    const { auth: header, body } = api.seen[0]!;
    expect(header).toBe("Bearer tok-1");
    expect(body).toMatchObject({ model: "gpt-6.1-sol", instructions: "be brief", stream: true, store: false, input: [{ role: "user", content: "hi" }], tools: [{ type: "namespace" }] });
    for (const refused of ["temperature", "max_output_tokens", "previous_response_id", "metadata", "user", "prompt"]) expect(body).not.toHaveProperty(refused);
  });

  it("reads the login again after fetching the model list, so a logout in the meantime stops the request", async () => {
    const api = await fakeApi((_, res) => sse(res, [done(text), completed]));
    const left = ["tok-1"]; // one token, then signed out
    const once = {
      check: () => {},
      token: async () => {
        const token = left.shift();
        if (!token) throw new Error("Not signed in to ChatGPT.");
        return { token, account: "app user-1" };
      },
    } as unknown as ChatGPTAuth;
    await expect(new ChatGPTProvider("gpt-6.1-sol", once, api.base).complete(request)).rejects.toThrow("Not signed in to ChatGPT.");
    expect(api.seen).toHaveLength(0);
  });

  it("fetches the model list again after a switch to another account", async () => {
    const api = await fakeApi((_, res) => sse(res, [done(text), completed]));
    let account = "app user-1";
    const switching = { check: () => {}, token: async () => ({ token: "tok-1", account }) } as unknown as ChatGPTAuth;
    const provider = new ChatGPTProvider("gpt-6.1-sol", switching, api.base);
    await provider.complete(request);
    await provider.complete(request);
    expect(api.lists()).toBe(1);
    account = "app user-2";
    await provider.complete(request);
    expect(api.lists()).toBe(2);
  });

  it("checks the model again when the account changes while its list is fetched", async () => {
    const api = await fakeApi((_, res) => sse(res, [done(text), completed]));
    const first = [{ token: "tok-1", account: "app user-1" }];
    const switching = { check: () => {}, token: async () => first.shift() ?? { token: "tok-2", account: "app user-2" } } as unknown as ChatGPTAuth;
    await new ChatGPTProvider("gpt-6.1-sol", switching, api.base).complete(request);
    expect(api.lists()).toBe(2);
    expect(api.seen[0]!.auth).toBe("Bearer tok-2");
  });

  it("stops on the usage limit at once, with no retry", async () => {
    const api = await fakeApi((_, res) => json(res, 429, { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit", type: "x", param: null } }));
    // A full stop goes after the address, before the request ID.
    await expect(new ChatGPTProvider("gpt-6.1-sol", auth, api.base).complete(request)).rejects.toThrow(new Error(`${USAGE_LIMIT}. OpenAI's request ID: req_9.`));
    expect(api.seen).toHaveLength(1);
  });

  it("says what a refused request means, in OpenAI's words, with the request ID", async () => {
    const cases: [(res: http.ServerResponse) => void, string][] = [
      [(res) => json(res, 401, { error: { code: "invalid_token", message: "Bad token", type: "x", param: null } }), "OpenAI did not accept the ChatGPT sign-in (HTTP 401, invalid_token). Bad token. Sign out with `tachi logout chatgpt`, then sign in again with `tachi login chatgpt` (or /logout chatgpt and /login chatgpt in a session). OpenAI's request ID: req_9."],
      [(res) => json(res, 503, { detail: "Direct routing is off" }), "ChatGPT plan use is unavailable right now (HTTP 503). Direct routing is off. Your sign-in is kept; try again later. OpenAI's request ID: req_9."],
      [(res) => json(res, 503, { error: { code: "server_overloaded", message: "Busy", type: "x", param: null } }), "ChatGPT plan use is unavailable right now (HTTP 503, server_overloaded). Busy. Your sign-in is kept; try again later. OpenAI's request ID: req_9."],
      [(res) => json(res, 429, { error: { code: "rate_limit_exceeded", message: "Slow down", type: "x", param: null } }), "OpenAI refused the request (HTTP 429, rate_limit_exceeded). Slow down. Try again later. OpenAI's request ID: req_9."],
      [(res) => json(res, 403, { detail: "Region not supported" }), "OpenAI refused the request (HTTP 403). Region not supported. OpenAI's request ID: req_9."],
      [(res) => json(res, 400, { error: { code: "too_long", message: "Your input is too long.", type: "x", param: "input" } }), "OpenAI refused the request (HTTP 400, too_long, about input). Your input is too long. OpenAI's request ID: req_9."],
      [(res) => res.writeHead(502, { "content-type": "text/html" }).end("<html>Bad gateway</html>"), "OpenAI could not complete the request (HTTP 502)."],
    ];
    for (const [answer, message] of cases) {
      const api = await fakeApi((_, res) => answer(res));
      await expect(new ChatGPTProvider("gpt-6.1-sol", auth, api.base).complete(request)).rejects.toThrow(new Error(message));
    }
  });

  it("keeps the request ID of a reply that fails part way through", async () => {
    const failed = { type: "response.failed", response: { error: { code: "server_error", message: "Something broke" } } };
    const api = await fakeApi((_, res) => sse(res, [done(text), failed]));
    await expect(new ChatGPTProvider("gpt-6.1-sol", auth, api.base).complete(request)).rejects.toThrow(new Error("OpenAI could not complete the request (server_error). Something broke. OpenAI's request ID: req_9."));
    // A named `event: error`, which the SDK throws itself.
    const limit = { type: "error", code: "subscription_sharing_usage_limit_exceeded", message: "limit", param: null };
    const limited = await fakeApi((_, res) => sse(res, [done(text), limit]));
    await expect(new ChatGPTProvider("gpt-6.1-sol", auth, limited.base).complete(request)).rejects.toThrow(new Error(`${USAGE_LIMIT}. OpenAI's request ID: req_9.`));
  });

  it("says a connection that drops part way through a reply dropped", async () => {
    const api = await fakeApi((_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req_9" });
      res.write(`event: response.output_item.done\ndata: ${JSON.stringify(done(text))}\n\n`, () => res.socket?.destroy());
    });
    const err = (await new ChatGPTProvider("gpt-6.1-sol", auth, api.base).complete(request).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/^The connection to OpenAI dropped before the reply finished \(.+\)\. Check your network and try again\. OpenAI's request ID: req_9\.$/);
  });

  it("says a reply that could not be fetched could not reach OpenAI", async () => {
    const api = await fakeApi((_, res) => res.socket?.destroy());
    await expect(new ChatGPTProvider("gpt-6.1-sol", auth, api.base).complete(request)).rejects.toThrow(`Could not reach ${api.base} (`);
  });

  it("says why the account's model list could not be fetched", async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    await expect(new ChatGPTProvider("gpt-6.1-sol", auth, `http://127.0.0.1:${port}/v1`).complete(request)).rejects.toThrow(`Could not reach http://127.0.0.1:${port}/v1 (connect ECONNREFUSED`);

    const cases: [(res: http.ServerResponse) => void, string][] = [
      [(res) => res.writeHead(200, { "content-type": "text/html" }).end("<html>wifi</html>"), "OpenAI's model list could not be read. Check your network and try again."],
      [(res) => json(res, 200, { data: [] }), "OpenAI's model list could not be read. Check your network and try again. OpenAI's request ID: req_9."],
      [
        (res) => json(res, 403, { error: { code: "subscription_sharing_user_not_eligible", message: "Not for this workspace", type: "x", param: null } }),
        "This ChatGPT account cannot use its plan here (subscription_sharing_user_not_eligible). Not for this workspace. Use openai:<model> with an API key instead. OpenAI's request ID: req_9.",
      ],
      [(res) => json(res, 403, { detail: "Region not supported" }), "OpenAI refused the request (HTTP 403). Region not supported. OpenAI's request ID: req_9."],
      [(res) => res.writeHead(500).end(), "OpenAI could not complete the request (HTTP 500)."],
    ];
    for (const [list, message] of cases) {
      const api = await fakeApi(() => {}, list);
      await expect(new ChatGPTProvider("gpt-6.1-sol", auth, api.base).complete(request)).rejects.toThrow(new Error(message));
    }
  });

  it("stops at once on Ctrl-C while the model list is fetched or the reply is awaited, and every login read can be stopped", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const watched = { check: () => {}, token: async (signal?: AbortSignal) => (signals.push(signal), { token: "tok-1", account: "app user-1" }) } as unknown as ChatGPTAuth;
    for (const wait of ["list", "reply"]) {
      signals.length = 0;
      let arrived!: () => void;
      const asked = new Promise<void>((r) => (arrived = r));
      const api = await fakeApi(() => arrived(), wait === "list" ? () => arrived() : undefined); // never answered
      const stop = new AbortController();
      const turn = new ChatGPTProvider("gpt-6.1-sol", watched, api.base).complete({ ...request, signal: stop.signal });
      await asked;
      stop.abort();
      const err = await turn.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toMatch(/Could not reach|OpenAI refused|could not complete/); // passed on, not explained
      expect(signals.length).toBeGreaterThan(0);
      for (const signal of signals) expect(signal).toBe(stop.signal);
    }
  });

  it("refuses a model the account does not offer, listing the ones it does", async () => {
    const api = await fakeApi(() => {});
    await expect(new ChatGPTProvider("gpt-9", auth, api.base).complete(request)).rejects.toThrow(new Error("Your ChatGPT account does not offer gpt-9. It offers: chatgpt:gpt-6.1-sol."));
    expect(api.seen).toHaveLength(0);
    const none = await fakeApi(() => {}, (res) => json(res, 200, { models: [planList[1]] }));
    await expect(new ChatGPTProvider("gpt-9", auth, none.base).complete(request)).rejects.toThrow(new Error("Your ChatGPT account does not offer gpt-9. It offers no models."));
  });

  it("takes the context window from the model list a reply fetched, without reading the login", async () => {
    const api = await fakeApi((_, res) => sse(res, [done(text), completed]));
    let reads = 0;
    const counted = { check: () => {}, token: async () => (reads++, { token: "tok-1", account: "app user-1" }) } as unknown as ChatGPTAuth;
    const hidden = new ChatGPTProvider("hidden", counted, api.base);
    expect(await hidden.contextWindow()).toBeNull(); // no reply yet
    expect(reads).toBe(0);
    await hidden.complete(request);
    reads = 0;
    expect(await hidden.contextWindow()).toBe(9);
    expect(reads).toBe(0);
    const unlisted = new ChatGPTProvider("gpt-6.1-sol", counted, api.base);
    await unlisted.complete(request);
    expect(await unlisted.contextWindow()).toBeNull(); // the list gives none, so the tokens in use are shown
  });

  it("is refused at once when signed out", () => {
    const out = { check: () => { throw new Error("Not signed in to ChatGPT."); } } as unknown as ChatGPTAuth;
    expect(() => new ChatGPTProvider("gpt-6.1-sol", out)).toThrow("Not signed in to ChatGPT.");
  });
});
```


**Step 2: Run them and see them fail**

Run: `npm test -- tests/providers/chatgpt.test.ts`

Expected: FAIL. In the scratch build: Test Files 1 failed (1), before any test runs. `src/providers/chatgpt.ts` does not exist yet.

**Step 3: Write the code**

**Create `src/providers/chatgpt.ts`:**

```ts
import OpenAI from "openai";
import type { ResponseInputItem, ResponseOutputItem, ResponseStreamEvent, ResponseUsage, Tool } from "openai/resources/responses/responses";
import type { Access, ChatGPTAuth } from "../auth/access.js";
import { USAGE_URL } from "../auth/chatgpt.js";
import { type CompletionRequest, connectReason, type Message, type Part, type Provider, type ToolSpec, type Turn } from "../core/types.js";
import { parseArgs } from "./openai.js";

// A ChatGPT plan leading, through OpenAI's Responses API (release 2 design, "Requests"; OpenAI's
// "models and inference" and "preview limitations" pages, read 2026-10-23).

export const API_BASE = "https://api.openai.com/v1";
// Tools are grouped in one namespace, as the preview limitations page requires. The shape is the
// openai package's `NamespaceTool` type (7.30.0).
const NAMESPACE = "tachikoma";

export const USAGE_LIMIT = `ChatGPT usage limit reached. Review your plan or this app's limit: ${USAGE_URL}`;

const SIGN_IN_AGAIN = "Sign out with `tachi logout chatgpt`, then sign in again with `tachi login chatgpt` (or /logout chatgpt and /login chatgpt in a session).";

const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

// What OpenAI said: an error object's `message`, or the `{"detail": "..."}` that can come back before a
// stream opens (errors and recovery page). Anything else, such as a web page, is not quoted.
function said(error: unknown): string | undefined {
  const e = error as { message?: unknown; detail?: unknown } | null | undefined;
  if (typeof e?.message === "string" && e.message.trim()) return e.message;
  if (typeof e?.detail === "string" && e.detail.trim()) return e.detail;
}

// A failure as OpenAI reports it. The errors and recovery page asks apps to keep the HTTP status, the
// code, `error.param` and the request ID.
interface Failure {
  code?: string | null;
  param?: string | null;
  status?: number;
  message?: string;
  requestId?: string | null;
}

// `text`, with OpenAI's request ID when there is one. The usage limit ends on an address, so a full
// stop goes after it before the next sentence.
const withId = (text: string, requestId?: string | null) => (requestId ? `${sentence(text)} OpenAI's request ID: ${requestId}.` : text);

// The plan's errors, by OpenAI's code (errors and recovery page). Each stops the turn; none is retried.
function planText({ code, param, status, message }: Failure): string {
  const why = message ? ` ${sentence(message)}` : "";
  const about = [status && `HTTP ${status}`, code, param && `about ${param}`].filter(Boolean).join(", ");
  switch (code) {
    case "subscription_sharing_usage_limit_exceeded":
      return USAGE_LIMIT;
    case "subscription_sharing_user_not_eligible":
      return `This ChatGPT account cannot use its plan here (${code}).${why} Use openai:<model> with an API key instead.`;
    // "Check the client and grant configuration rather than retrying or changing billing."
    case "chatpass_v2_scope_not_authorized":
    case "chatpass_v2_invalid_authorization_context":
      return `OpenAI says this ChatGPT sign-in's permissions do not cover the request (${code}).${why} Sign out with \`tachi logout chatgpt\`, then sign in again with \`tachi login chatgpt\` (or /logout chatgpt and /login chatgpt in a session) and allow plan use.`;
    case "subscription_sharing_invalid_user":
      return `OpenAI did not accept the ChatGPT sign-in (${code}).${why} ${SIGN_IN_AGAIN}`;
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return `ChatGPT plan use is unavailable right now (${code}).${why} Your sign-in is kept; try again later.`;
  }
  if (status === 401) return `OpenAI did not accept the ChatGPT sign-in (${about}).${why} ${SIGN_IN_AGAIN}`;
  if (status === 503) return `ChatGPT plan use is unavailable right now (${about}).${why} Your sign-in is kept; try again later.`;
  // A server error, or a reply that failed part way, is OpenAI failing rather than refusing. HTTP 429
  // is "too many requests" (RFC 6585).
  const what = status !== undefined && status < 500 ? "refused" : "could not complete";
  return `OpenAI ${what} the request${about ? ` (${about})` : ""}.${why}${status === 429 ? " Try again later." : ""}`;
}

const planError = (failure: Failure) => new Error(withId(planText(failure), failure.requestId));

// A connection that drops part way through a reply ends the stream with Node's bare "terminated", a
// TypeError from undici (the fetch under the SDK).
async function* dropped<T>(events: AsyncIterable<T>, requestId: string | null): AsyncGenerator<T> {
  try {
    yield* events;
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    throw new Error(withId(`The connection to OpenAI dropped before the reply finished (${connectReason(err)}). Check your network and try again.`, requestId), { cause: err });
  }
}

export function toResponses(messages: Message[]): ResponseInputItem[] {
  const out: ResponseInputItem[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      // A ChatGPT turn goes back exactly as it came, encrypted reasoning included. The openai package
      // says to send the completed items from `response.output_item.done` (ResponseReasoningItem).
      if (m.native?.provider === "chatgpt") {
        out.push(...(m.native.content as ResponseInputItem[]));
        continue;
      }
      for (const p of m.parts) {
        if (p.type === "text") out.push({ role: "assistant", content: p.text });
        else if (p.type === "tool_call") out.push({ type: "function_call", call_id: p.id, name: p.name, namespace: NAMESPACE, arguments: JSON.stringify(p.input) });
      }
      continue;
    }
    for (const p of m.parts) {
      if (p.type === "tool_result") out.push({ type: "function_call_output", call_id: p.callId, output: p.isError ? `Error: ${p.output}` : p.output });
      else if (p.type === "text") out.push({ role: "user", content: p.text });
    }
  }
  return out;
}

export function toolsFor(specs: ToolSpec[]): Tool[] {
  if (!specs.length) return [];
  return [
    {
      type: "namespace",
      name: NAMESPACE,
      description: "Tachikoma's tools, which act on the user's project.",
      tools: specs.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.inputSchema })),
    },
  ];
}

// The reply, from the stream's finished items. It counts as finished only on `response.completed`.
export async function fromStream(events: AsyncIterable<ResponseStreamEvent>, tools: ToolSpec[], requestId?: string | null): Promise<Turn> {
  const items: ResponseOutputItem[] = [];
  let usage: ResponseUsage | null | undefined;
  let incomplete: string | undefined;
  for await (const e of events) {
    if (e.type === "response.output_item.done") items.push(e.item);
    else if (e.type === "response.completed") {
      usage = e.response.usage;
      break;
    } else if (e.type === "response.incomplete") {
      usage = e.response.usage;
      incomplete = e.response.incomplete_details?.reason ?? "unknown";
      break;
    } else if (e.type === "response.failed") {
      const err = e.response.error;
      throw planError({ code: err?.code, message: said(err) ?? "The reply failed.", requestId });
    } else if (e.type === "error") {
      // Only an error event with no event name reaches here: the SDK throws a named `event: error`
      // itself (core/streaming.js), and complete() reads that one.
      throw planError({ code: e.code, param: e.param, message: said(e), requestId });
    }
  }
  if (usage === undefined && incomplete === undefined) throw new Error(withId("OpenAI's reply stopped before it finished. Try again.", requestId));

  const parts: Part[] = [];
  let refusal: string | undefined;
  const known = new Set(tools.map((t) => t.name));
  for (const item of items) {
    if (item.type === "message") {
      for (const c of item.content) {
        if (c.type === "output_text" && c.text.trim()) parts.push({ type: "text", text: c.text });
        else if (c.type === "refusal") refusal = c.refusal;
      }
    } else if (item.type === "function_call") {
      // Mapped back to Tachikoma's tools, which may come with no namespace. Anything else keeps its full
      // name, which no tool has, so the session refuses it as an unknown tool. It is joined with `__`,
      // since tool names allow only letters, digits, `_` and `-`, and it stays in the history when the
      // lead moves to another provider.
      const ours = !item.namespace || (item.namespace === NAMESPACE && known.has(item.name));
      parts.push({ type: "tool_call", id: item.call_id, name: ours ? item.name : `${item.namespace}__${item.name}`, input: parseArgs(item.arguments) });
    }
  }
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
  const written = usage?.input_tokens_details?.cache_write_tokens ?? 0;
  const turn: Turn = {
    parts,
    native: { provider: "chatgpt", content: items },
    usage: { input: (usage?.input_tokens ?? 0) - cached - written, output: usage?.output_tokens ?? 0, cacheRead: cached, cacheWrite: written },
  };
  if (incomplete === "content_filter") turn.cutOff = { kind: "refusal", detail: "OpenAI's content filter stopped the response" };
  else if (incomplete === "max_output_tokens") turn.cutOff = { kind: "max_tokens", detail: "The response reached its length limit" };
  else if (incomplete) turn.cutOff = { kind: "max_tokens", detail: `The response stopped early, for a reason OpenAI gives as "${incomplete}"` };
  if (refusal) turn.cutOff = { kind: "refusal", detail: refusal };
  return turn;
}

// The account's own model list (models and inference page): `models`, each with `slug` and
// `visibility`. Codex also reads `context_window` from it.
export interface PlanModel {
  slug: string;
  listed: boolean; // `visibility: "list"`, the ones meant to be shown
  contextWindow: number | null;
}

// The first request of a session's first `chatgpt:` turn, so its failures read like the turn's own.
export async function planModels(token: string, base = API_BASE, signal?: AbortSignal): Promise<PlanModel[]> {
  let res: Response;
  try {
    res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${token}` }, signal });
  } catch (err) {
    if (signal?.aborted || !(err instanceof Error)) throw err;
    throw new Error(`Could not reach ${base} (${connectReason(err)}). Check your network.`, { cause: err });
  }
  const body = (await res.json().catch(() => undefined)) as { error?: Record<string, unknown>; models?: Record<string, unknown>[] } | undefined;
  signal?.throwIfAborted();
  if (!res.ok) {
    const error: Record<string, unknown> | undefined = body?.error ?? body; // the `{"detail": "..."}` form has no `error`
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    throw planError({ code: str(error?.code), param: str(error?.param), status: res.status, message: said(error), requestId: res.headers.get("x-request-id") });
  }
  if (!Array.isArray(body?.models)) throw new Error(withId("OpenAI's model list could not be read. Check your network and try again.", res.headers.get("x-request-id")));
  return body.models.flatMap((m) =>
    typeof m.slug === "string"
      ? [
          {
            slug: m.slug,
            listed: m.visibility === "list",
            contextWindow: typeof m.context_window === "number" ? m.context_window : null,
          },
        ]
      : [],
  );
}

export class ChatGPTProvider implements Provider {
  readonly id: string;
  #models?: { account: string; list: PlanModel[] }; // for one account: fetched again after a switch

  constructor(
    readonly model: string,
    private readonly auth: ChatGPTAuth,
    private readonly base = API_BASE,
  ) {
    auth.check(); // signed out: an error that names the command, before any request
    this.id = `chatgpt:${model}`;
  }

  // Looked up once per account. A model the account does not offer is an error that lists the ones it does.
  async #model(login: Access, signal?: AbortSignal): Promise<PlanModel> {
    if (this.#models?.account !== login.account) this.#models = { account: login.account, list: await planModels(login.token, this.base, signal) };
    const found = this.#models.list.find((m) => m.slug === this.model);
    if (!found) {
      const offered = this.#models.list.filter((m) => m.listed).map((m) => `chatgpt:${m.slug}`);
      throw new Error(`Your ChatGPT account does not offer ${this.model}. ${offered.length ? `It offers: ${offered.join(", ")}.` : "It offers no models."}`);
    }
    return found;
  }

  async complete({ system, messages, tools, signal }: CompletionRequest): Promise<Turn> {
    // Read again after the model check, so a logout while the model list was fetched is seen, and a
    // switch to another account is checked against that account's list.
    let login = await this.auth.token(signal);
    let checked: Access;
    do {
      checked = login;
      await this.#model(checked, signal);
      login = await this.auth.token(signal);
    } while (login.account !== checked.account);
    const { token } = login;
    // Made for each request with the token just read, so a renewed login is used at once. No retries:
    // retrying a usage limit only hits it again (errors and recovery page).
    const client = new OpenAI({ apiKey: token, baseURL: this.base, maxRetries: 0 });
    const toolList = toolsFor(tools);
    try {
      const { data: stream, request_id } = await client.responses
        .create(
          // Only fields the route accepts: no temperature, max_output_tokens or the like.
          { model: this.model, instructions: system, input: toResponses(messages), ...(toolList.length ? { tools: toolList } : {}), stream: true, store: false },
          { signal },
        )
        .withResponse();
      return await fromStream(dropped(stream, request_id), tools, request_id);
    } catch (err) {
      if (signal?.aborted) throw err; // Ctrl-C, passed on as it is (the SDK's abort error is an APIError)
      if (err instanceof OpenAI.APIConnectionTimeoutError) throw new Error(`${this.base} did not answer in time. Check your network.`, { cause: err });
      if (err instanceof OpenAI.APIConnectionError) throw new Error(`Could not reach ${this.base} (${connectReason(err)}). Check your network.`, { cause: err });
      // The SDK's own message repeats the status and quotes any body, so OpenAI's text is taken from the body.
      if (err instanceof OpenAI.APIError) throw planError({ code: err.code, param: err.param, status: err.status, message: said(err.error), requestId: err.requestID });
      throw err;
    }
  }

  // From the model list the last request fetched, so the status line never reads or renews the login:
  // a renewal there that found the login dead would clear it unseen. Unknown until the first reply.
  async contextWindow(): Promise<number | null> {
    return this.#models?.list.find((m) => m.slug === this.model)?.contextWindow ?? null;
  }
}
```

**Change `src/providers/openai.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/providers/openai.ts b/src/providers/openai.ts
index a460593..bbb7d02 100644
--- a/src/providers/openai.ts
+++ b/src/providers/openai.ts
@@ -47,7 +47,7 @@ export function toOpenAI(system: string, messages: Message[], kind: string): Cha
 
 // Anything but a JSON object is wrapped: it fails the tool's schema check, so the model is told, and
 // Anthropic rejects tool input that is not an object if the history is later sent there.
-function parseArgs(raw: string): unknown {
+export function parseArgs(raw: string): unknown {
   try {
     const v: unknown = JSON.parse(raw || "{}");
     if (typeof v === "object" && v !== null && !Array.isArray(v)) return v;
```


**Step 4: Run everything**

Run: `npm run typecheck`, then `npm test`

Expected: no type errors; Test Files 24 passed | 2 skipped (26); Tests 367 passed | 5 skipped (372).

**Step 5: Commit**

```bash
git add src/providers/chatgpt.ts src/providers/openai.ts tests/providers/chatgpt.test.ts
git commit -m "feat: Responses API adapter for a ChatGPT plan"
```

### Task 10: `chatgpt:` leads, and the status line

- **`--lead chatgpt:<model>`** makes the adapter. Signed out, it fails at once with the command to run.
  `openai:` still always means `OPENAI_API_KEY`.
- **Cost:** a plan has no per-token price, so it counts as nothing in dollars, and the status line
  says "ChatGPT plan" where the cost would be (choice 7 when API models were also used).
- **Context:** the status line now shows how much is left (`ctx 96% left`), as Codex does (main design,
  "Status line"). Release 1 showed how much was used.
- **The window is asked for again after each request to the model,** without clearing what is
  shown: a ChatGPT plan's window is known only once a request has fetched the account's model list.
  Only the latest lookup's answer is shown, so a slow earlier one cannot undo it.

**Files:**
- Modify: `src/cli.tsx`
- Modify: `src/providers/pricing.ts`
- Modify: `src/providers/registry.ts`
- Modify: `src/tui/App.tsx`
- Modify: `src/tui/StatusLine.tsx`
- Modify: `tests/providers/registry.test.ts`
- Modify: `tests/tui/app.test.tsx`
- Modify: `tests/tui/statusline.test.tsx`

**Step 1: Write the failing tests**

**Change `tests/providers/registry.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/providers/registry.test.ts b/tests/providers/registry.test.ts
index f138db8..a5a759a 100644
--- a/tests/providers/registry.test.ts
+++ b/tests/providers/registry.test.ts
@@ -1,3 +1,6 @@
+import { mkdtempSync } from "node:fs";
+import { tmpdir } from "node:os";
+import path from "node:path";
 import { afterEach, describe, expect, it, vi } from "vitest";
 import { cost } from "../../src/providers/pricing.js";
 import { createProvider, parseLead } from "../../src/providers/registry.js";
@@ -17,7 +20,14 @@ describe("parseLead", () => {
 
 describe("createProvider", () => {
   it("names unknown providers and lists the known ones", () => {
-    expect(() => createProvider("acme:x")).toThrow('Unknown provider "acme". Known: anthropic, openai, openrouter, kimi, ollama');
+    expect(() => createProvider("acme:x")).toThrow('Unknown provider "acme". Known: anthropic, chatgpt, openai, openrouter, kimi, ollama');
+  });
+
+  it("refuses a ChatGPT lead while signed out, naming the command", () => {
+    vi.stubEnv("TACHI_DATA_DIR", path.join(mkdtempSync(path.join(tmpdir(), "tachi-reg-")), "data"));
+    expect(() => createProvider("chatgpt:gpt-6.1-sol")).toThrow(
+      new Error("Not signed in to ChatGPT. Sign in with `tachi login chatgpt` (or /login chatgpt in a session), or choose another lead (--lead, or /lead in a session)."),
+    );
   });
 
   it("does not mistake names every object has for providers", () => {
@@ -41,6 +51,7 @@ describe("cost", () => {
   });
   it("counts local models as free and unknown ones as unknown", () => {
     expect(cost("ollama:qwen3:8b", u)).toBe(0);
+    expect(cost("chatgpt:gpt-6.1-sol", u)).toBe(0); // billed to the plan
     expect(cost("openai:some-model", u)).toBeNull();
   });
 });
```

**Change `tests/tui/app.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/app.test.tsx b/tests/tui/app.test.tsx
index 543b982..62fd9ff 100644
--- a/tests/tui/app.test.tsx
+++ b/tests/tui/app.test.tsx
@@ -176,7 +176,48 @@ describe("App", () => {
     await tick();
     expect(app.lastFrame()).toContain("lead fake:b");
     expect(app.lastFrame()).toContain("ctx 0 ");
-    expect(app.lastFrame()).not.toContain("ctx 0%");
+    expect(app.lastFrame()).not.toMatch(/ctx \d+% left/);
+  });
+
+  it("asks for the context window again after a reply, when only a reply makes it known", async () => {
+    let answered = false;
+    const later = Object.assign(new FakeProvider("a", [reply("there")]), { contextWindow: async () => (answered ? 1000 : null) });
+    const complete = later.complete.bind(later);
+    later.complete = async (req) => ((answered = true), complete(req));
+    const { app } = await mount([], { lead: later });
+    expect(app.lastFrame()).not.toMatch(/ctx \d+%/);
+    await type(app, "hi");
+    await until(app, "there");
+    await until(app, "% left");
+    expect(app.lastFrame()).toMatch(/ctx \d+% left/);
+  });
+
+  it("keeps the window it knows when asking again after a reply fails", async () => {
+    let asked = 0;
+    const flaky = Object.assign(new FakeProvider("a", [reply("there")]), {
+      contextWindow: () => (asked++ ? Promise.reject(new Error("offline")) : Promise.resolve(1000)),
+    });
+    const { app } = await mount([], { lead: flaky });
+    await until(app, "% left");
+    await type(app, "hi");
+    await until(app, "there");
+    await tick();
+    expect(asked).toBe(2);
+    expect(app.lastFrame()).toContain("% left");
+  });
+
+  it("shows only the latest lookup's answer, so a slow earlier one cannot undo it", async () => {
+    let first: (n: number | null) => void = () => {};
+    let asked = 0;
+    const slow = Object.assign(new FakeProvider("a", [reply("there")]), {
+      contextWindow: () => (asked++ ? Promise.resolve(1000) : new Promise<number | null>((r) => (first = r))),
+    });
+    const { app } = await mount([], { lead: slow });
+    await type(app, "hi");
+    await until(app, "% left");
+    first(null); // as Anthropic's lookup answers when it gives up
+    await tick();
+    expect(app.lastFrame()).toContain("% left");
   });
 
   it("keeps going when the context-window lookup fails", async () => {
```

**Change `tests/tui/statusline.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/statusline.test.tsx b/tests/tui/statusline.test.tsx
index cfb063b..863b17e 100644
--- a/tests/tui/statusline.test.tsx
+++ b/tests/tui/statusline.test.tsx
@@ -27,7 +27,7 @@ describe("StatusLine", () => {
   it("shows every part by default", () => {
     const shown = frame(info, SEGMENTS);
     expect(shown).toContain("lead anthropic:claude-opus-5-5");
-    expect(shown).toContain("ctx 50%");
+    expect(shown).toContain("ctx 50% left");
     expect(shown).toContain("12.3k in / 678 out");
     expect(shown).toContain("$0.42");
     expect(shown).toContain("perm ask");
@@ -41,6 +41,19 @@ describe("StatusLine", () => {
     expect(shown).not.toContain("lead");
   });
 
+  it("shows how much context is left, never below none", () => {
+    expect(formatSegment("context", { ...info, context: 40_000, contextWindow: 1_000_000 })).toBe("ctx 96% left");
+    expect(formatSegment("context", { ...info, context: 1_200_000, contextWindow: 1_000_000 })).toBe("ctx 0% left");
+  });
+
+  it("shows the ChatGPT plan where the cost would be, plus any API cost so far", () => {
+    const plan = { ...info, lead: "chatgpt:gpt-6.1-sol", cost: 0, costUnknown: false };
+    expect(formatSegment("cost", plan)).toBe("ChatGPT plan");
+    expect(formatSegment("cost", { ...plan, cost: 0.42 })).toBe("ChatGPT plan + $0.42");
+    expect(formatSegment("cost", { ...plan, costUnknown: true })).toBe("ChatGPT plan + ?");
+    expect(formatSegment("cost", { ...plan, cost: 0.42, costUnknown: true })).toBe("ChatGPT plan + $0.42 + ?");
+  });
+
   it("stays on one line of the terminal, cutting off the end", () => {
     const shown = frame({ ...info, lead: `anthropic:${"x".repeat(200)}` }, SEGMENTS)!;
     expect(shown.split("\n")).toHaveLength(1);
```


**Step 2: Run them and see them fail**

Run: `npm test -- tests/providers/registry.test.ts tests/tui/app.test.tsx tests/tui/statusline.test.tsx`

Expected: FAIL. In the scratch build: Test Files 3 failed (3); Tests 9 failed | 40 passed (49). The new expectations fail: `chatgpt` is not yet a known provider, and the status line shows context used.

**Step 3: Write the code**

**Change `src/cli.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/cli.tsx b/src/cli.tsx
index c8090fa..f1f590f 100644
--- a/src/cli.tsx
+++ b/src/cli.tsx
@@ -29,8 +29,9 @@ Usage:
   tachi logout chatgpt                               sign out of ChatGPT
 
 Options:
-  --lead <spec>     anthropic:<model> | openai:<model> | openrouter:<model> | kimi:<model> | ollama:<model>
-                    (or set TACHI_LEAD)
+  --lead <spec>     anthropic:<model> | chatgpt:<model> | openai:<model> | openrouter:<model>
+                    | kimi:<model> | ollama:<model> (or set TACHI_LEAD)
+                    chatgpt: uses your ChatGPT plan; openai: uses OPENAI_API_KEY
   --mode <mode>     when to ask before acting: ${MODES.join(" | ")} (default: ask)
   --effort <level>  Anthropic models only: ${EFFORTS.join(" | ")}
   --fallback <spec> retry a turn the lead refuses on this model, e.g. openai:<model> (off unless set)
```

**Change `src/providers/pricing.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/providers/pricing.ts b/src/providers/pricing.ts
index 806479f..7c94194 100644
--- a/src/providers/pricing.ts
+++ b/src/providers/pricing.ts
@@ -20,6 +20,7 @@ export const PRICES: Record<string, Rates> = {
 
 export function cost(provider: string, u: Usage): number | null {
   if (provider.startsWith("ollama:")) return 0; // runs locally
+  if (provider.startsWith("chatgpt:")) return 0; // billed to the ChatGPT plan, not per token
   const r = PRICES[provider];
   if (!r) return null;
   return (u.input * r.input + u.output * r.output + u.cacheRead * r.cacheRead + u.cacheWrite * r.cacheWrite) / 1_000_000;
```

**Change `src/providers/registry.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/providers/registry.ts b/src/providers/registry.ts
index 61fe3ed..26a268e 100644
--- a/src/providers/registry.ts
+++ b/src/providers/registry.ts
@@ -1,5 +1,9 @@
+import { ChatGPTAuth } from "../auth/access.js";
+import { LoginStore } from "../auth/store.js";
+import { dataDir } from "../core/datadir.js";
 import type { Provider } from "../core/types.js";
 import { AnthropicProvider, type Effort } from "./anthropic.js";
+import { ChatGPTProvider } from "./chatgpt.js";
 import { OpenAIProvider, PRESETS } from "./openai.js";
 
 export function parseLead(spec: string): { kind: string; model: string } {
@@ -11,6 +15,8 @@ export function parseLead(spec: string): { kind: string; model: string } {
 export function createProvider(spec: string, opts: { effort?: Effort } = {}): Provider {
   const { kind, model } = parseLead(spec);
   if (kind === "anthropic") return new AnthropicProvider(model, opts.effort);
+  // The plan, never an API key: `openai:` is the API key (release 2 design, "Choosing it").
+  if (kind === "chatgpt") return new ChatGPTProvider(model, new ChatGPTAuth(new LoginStore(dataDir())));
   if (Object.hasOwn(PRESETS, kind)) return new OpenAIProvider(kind, model); // `in` would accept "constructor"
-  throw new Error(`Unknown provider "${kind}". Known: anthropic, ${Object.keys(PRESETS).join(", ")}`);
+  throw new Error(`Unknown provider "${kind}". Known: anthropic, chatgpt, ${Object.keys(PRESETS).join(", ")}`);
 }
```

**Change `src/tui/App.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/App.tsx b/src/tui/App.tsx
index c54c4e2..5870b04 100644
--- a/src/tui/App.tsx
+++ b/src/tui/App.tsx
@@ -32,15 +32,18 @@ export function App({ session, bus, stats, mode, errorFile, segments, makeProvid
   const [, rerender] = useState(0);
   const abort = useRef<AbortController | null>(null);
   const nextId = useRef(0);
+  const lookups = useRef(0);
 
   const say = (...add: Line[]) => setLines((l) => [...l, ...add.map((x) => ({ ...screen(x), id: nextId.current++ }))]);
 
-  // A late answer for the previous lead must not show as the new lead's window.
-  const lookUpWindow = () => {
-    const lead = session.lead;
-    setContextWindow(null);
-    lead.contextWindow?.()
-      .then((n) => session.lead === lead && setContextWindow(n))
+  // Only the latest lookup's answer is shown: a late one, for the previous lead or from before a
+  // request, must not replace it. Asked again after each request, without clearing what is shown: a
+  // ChatGPT plan's window is known only once a request has fetched the account's model list.
+  const lookUpWindow = (fresh = true) => {
+    const asked = ++lookups.current;
+    if (fresh) setContextWindow(null);
+    session.lead.contextWindow?.()
+      .then((n) => asked === lookups.current && setContextWindow(n))
       .catch(() => {}); // stays unknown
   };
 
@@ -74,7 +77,10 @@ export function App({ session, bus, stats, mode, errorFile, segments, makeProvid
       else if (e.kind === "fallback") say({ text: `↪ ${e.message}`, color: "magenta" });
       else say({ text: `✗ ${e.kind}: ${e.message}`, color: "red" });
     };
-    const onUsage = () => rerender((n) => n + 1);
+    const onUsage = () => {
+      rerender((n) => n + 1);
+      lookUpWindow(false);
+    };
     const onLead = (id: string) => {
       say({ text: `lead is now ${id}`, color: "magenta" });
       lookUpWindow();
```

**Change `src/tui/StatusLine.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/StatusLine.tsx b/src/tui/StatusLine.tsx
index 665fb02..cfd4f7f 100644
--- a/src/tui/StatusLine.tsx
+++ b/src/tui/StatusLine.tsx
@@ -27,11 +27,18 @@ export function formatSegment(s: Segment, i: StatusInfo): string {
     case "lead":
       return `lead ${i.lead}`;
     case "context":
-      return i.contextWindow ? `ctx ${Math.round((100 * i.context) / i.contextWindow)}%` : `ctx ${k(i.context)}`;
+      // How much is left, as Codex shows it (main design, "Status line"); the tokens in use when the
+      // window is not known.
+      return i.contextWindow ? `ctx ${Math.max(0, 100 - Math.round((100 * i.context) / i.contextWindow))}% left` : `ctx ${k(i.context)}`;
     case "tokens":
       return `${k(i.input)} in / ${k(i.output)} out`;
-    case "cost":
-      return `$${i.cost.toFixed(2)}${i.costUnknown ? " + ?" : ""}`;
+    case "cost": {
+      const dollars = `$${i.cost.toFixed(2)}${i.costUnknown ? " + ?" : ""}`;
+      // A plan has no per-token price; OpenAI's guidelines ask apps to show that the plan is in use.
+      if (!i.lead.startsWith("chatgpt:")) return dollars;
+      if (i.cost) return `ChatGPT plan + ${dollars}`;
+      return i.costUnknown ? "ChatGPT plan + ?" : "ChatGPT plan";
+    }
     case "mode":
       return `perm ${i.mode}`;
     case "errors":
```


**Step 4: Run everything**

Run: `npm run typecheck`, then `npm test`

Expected: no type errors; Test Files 24 passed | 2 skipped (26); Tests 373 passed | 5 skipped (378).

**Step 5: Commit**

```bash
git add src/cli.tsx src/providers/pricing.ts src/providers/registry.ts src/tui/App.tsx src/tui/StatusLine.tsx tests/providers/registry.test.ts tests/tui/app.test.tsx tests/tui/statusline.test.tsx
git commit -m "feat: chatgpt: leads, and the status line shows the plan and the context left"
```

### Task 11: `/login` and `/logout` in a session

`/login chatgpt [...]` and `/logout chatgpt` run the same `accountCommand()` as the command line,
with what it says shown in the scrollback. Ctrl-C stops a sign-in waiting on the browser, as it stops a
turn. Neither is ever sent to the model. The messages name each command as it is typed in a session
(`/logout chatgpt`, where the command line says `tachi logout chatgpt`), and a bare `/login` shows
how to use it. Every command now ignores case (`/LOGIN chatgpt` is `/login chatgpt`); a message is
still sent as typed. A command that takes nothing after it refuses any words (`/exit now`) instead of
sending them to the model as a paid turn.

After `/logout chatgpt` while ChatGPT leads, the next message fails with the renewal code's "Not
signed in to ChatGPT. Sign in with `tachi login chatgpt` (or /login chatgpt in a session), or
choose another lead (--lead, or /lead in a session)." (release 2 design, "Signing out while ChatGPT
leads").

**Files:**
- Modify: `src/cli.tsx`
- Modify: `src/tui/App.tsx`
- Modify: `tests/tui/app.test.tsx`

**Step 1: Write the failing tests**

**Change `tests/tui/app.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/app.test.tsx b/tests/tui/app.test.tsx
index 62fd9ff..9a16c10 100644
--- a/tests/tui/app.test.tsx
+++ b/tests/tui/app.test.tsx
@@ -9,7 +9,7 @@ import { Session } from "../../src/core/session.js";
 import { Stats } from "../../src/core/stats.js";
 import type { Provider } from "../../src/core/types.js";
 import { TOOLS } from "../../src/tools/index.js";
-import { App } from "../../src/tui/App.js";
+import { App, type AppProps } from "../../src/tui/App.js";
 import { SEGMENTS } from "../../src/tui/StatusLine.js";
 import { Bus, FakeProvider, callTool, reply, tempContext } from "../helpers.js";
 
@@ -26,7 +26,12 @@ afterEach(() => {
   for (const app of mounted.splice(0)) app.unmount();
 });
 
-async function mount(turns: ConstructorParameters<typeof FakeProvider>[1], opts: { lead?: Provider; errorFile?: string } = {}) {
+type Login = AppProps["login"];
+
+async function mount(
+  turns: ConstructorParameters<typeof FakeProvider>[1],
+  opts: { lead?: Provider; errorFile?: string; login?: Login; made?: string[] } = {},
+) {
   const bus = new Bus();
   const stats = new Stats(bus);
   const ctx = await tempContext();
@@ -42,7 +47,11 @@ async function mount(turns: ConstructorParameters<typeof FakeProvider>[1], opts:
       mode="ask"
       errorFile={opts.errorFile ?? path.join(ctx.root, "errors.jsonl")}
       segments={SEGMENTS}
-      makeProvider={() => new FakeProvider("b", [])}
+      makeProvider={(spec) => {
+        opts.made?.push(spec);
+        return new FakeProvider("b", []);
+      }}
+      login={opts.login ?? (async () => {})}
       bindAsk={(fn) => {
         ask = fn;
       }}
@@ -150,9 +159,71 @@ describe("App", () => {
     await type(app, "/eror");
     expect(app.lastFrame()).toContain("Unknown command: /eror");
     expect(app.lastFrame()).toContain("/errors");
+    expect(app.lastFrame()).toContain("/login chatgpt");
+    expect(session.messages).toEqual([]);
+  });
+
+  it("refuses words after a command that takes none, instead of sending them to the model", async () => {
+    const { app, session } = await mount([]);
+    await type(app, "/exit now");
+    await until(app, "/exit takes nothing after it.");
+    await type(app, "/Errors please");
+    await until(app, "/errors takes nothing after it.");
     expect(session.messages).toEqual([]);
   });
 
+  it("signs in and out with /login and /logout, showing what they say, and never sends them to the model", async () => {
+    const calls: string[] = [];
+    const login: Login = async (verb, words, say, _signal, prefix) => {
+      calls.push([prefix + verb, ...words].join(" "));
+      say(`${verb} done ${calls.length}`);
+    };
+    const lead = new FakeProvider("a", []);
+    const { app } = await mount([], { lead, login });
+    await type(app, "/login chatgpt --new");
+    await until(app, "login done 1");
+    await type(app, "/logout chatgpt");
+    await until(app, "logout done 2");
+    await type(app, "/login"); // shown how to use it, not called an unknown command
+    await until(app, "login done 3");
+    expect(calls).toEqual(["/login chatgpt --new", "/logout chatgpt", "/login"]);
+    expect(lead.seen).toEqual([]);
+  });
+
+  it("takes commands in any case, and sends a message as typed", async () => {
+    const calls: string[] = [];
+    const login: Login = async (verb, words, say) => {
+      calls.push([verb, ...words].join(" "));
+      say("signed in");
+    };
+    const lead = new FakeProvider("a", [reply("ok")]);
+    const made: string[] = [];
+    const { app, session } = await mount([], { lead, login, made });
+    await type(app, "/LOGIN chatgpt");
+    await until(app, "signed in");
+    await type(app, "/Lead");
+    await until(app, "Usage: /lead");
+    await type(app, "/Errors");
+    await until(app, "No errors logged yet.");
+    await type(app, "/Tmp is full");
+    await until(app, "ok");
+    await type(app, "/LEAD fake:B"); // the words after a command keep their case
+    await until(app, "lead is now fake:b");
+    expect(calls).toEqual(["login chatgpt"]);
+    expect(made).toEqual(["fake:B"]);
+    expect(session.messages[0]).toMatchObject({ role: "user", parts: [{ type: "text", text: "/Tmp is full" }] });
+  });
+
+  it("stops a sign-in on Ctrl-C, and shows why it failed", async () => {
+    const login: Login = (_verb, _words, _say, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("Sign-in was cancelled"))));
+    const { app } = await mount([], { login });
+    await type(app, "/login chatgpt");
+    await until(app, "working");
+    app.stdin.write("\u0003");
+    await until(app, "Sign-in was cancelled");
+    await until(app, "›");
+  });
+
   it("sends a message that starts with a one-word path", async () => {
     const { app, session } = await mount([reply("ok")]);
     await type(app, "/tmp is full");
```


**Step 2: Run them and see them fail**

Run: `npm test -- tests/tui/app.test.tsx`

Expected: FAIL. In the scratch build: Test Files 1 failed (1); Tests 5 failed | 24 passed (29). The two new tests fail: `/login` is not a command yet.

**Step 3: Write the code**

**Change `src/cli.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/cli.tsx b/src/cli.tsx
index f1f590f..0be8858 100644
--- a/src/cli.tsx
+++ b/src/cli.tsx
@@ -41,8 +41,9 @@ Options:
   --raw             with -p, print the answer exactly as written, control codes and all
   -h, --help        show this help
 
-In a session: /lead <provider:model> switches the lead model, /errors summarises the error log,
-/exit quits. Ctrl-C stops the current turn, or quits when idle.`;
+In a session: /lead <provider:model> switches the lead model, /login chatgpt and /logout chatgpt
+sign in and out, /errors summarises the error log, /exit quits. Ctrl-C stops the current turn, or
+quits when idle.`;
 
 function fail(message: string): never {
   console.error(message);
@@ -186,6 +187,7 @@ if (parsed.print !== undefined) {
       errorFile={errorFile}
       segments={segments}
       makeProvider={makeProvider}
+      login={accountCommand}
       bindAsk={(fn) => {
         ask = fn;
       }}
```

**Change `src/tui/App.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/App.tsx b/src/tui/App.tsx
index 5870b04..8e02331 100644
--- a/src/tui/App.tsx
+++ b/src/tui/App.tsx
@@ -20,9 +20,14 @@ export interface AppProps {
   segments: Segment[];
   makeProvider: (spec: string) => Provider;
   bindAsk: (ask: (summary: string, detail?: string) => Promise<boolean>) => void;
+  // `/login …` and `/logout …`: the words after the command, where to show what it says, a signal
+  // Ctrl-C aborts, and how a command is typed here ("/").
+  login: (verb: "login" | "logout", words: string[], say: (line: string) => void, signal: AbortSignal, prefix: string) => Promise<void>;
 }
 
-export function App({ session, bus, stats, mode, errorFile, segments, makeProvider, bindAsk }: AppProps) {
+const COMMANDS = "/lead <provider:model>, /login chatgpt, /logout chatgpt, /errors, /exit";
+
+export function App({ session, bus, stats, mode, errorFile, segments, makeProvider, bindAsk, login }: AppProps) {
   const { exit } = useApp();
   const [lines, setLines] = useState<(Line & { id: number })[]>([]);
   const [input, setInput] = useState("");
@@ -102,18 +107,26 @@ export function App({ session, bus, stats, mode, errorFile, segments, makeProvid
   const submit = async (raw: string) => {
     const text = raw.trim();
     if (!text) return;
+    // Commands ignore case; a message is sent as typed.
+    const [first = "", ...words] = text.split(/\s+/);
+    const command = first.toLowerCase();
+    const alone = (name: string) => command === name && !words.length;
     try {
-      if (text === "/exit") return exit();
-      if (text === "/errors") return say(...summarize(errorFile).map((row) => ({ text: row, oneLine: true })));
-      if (text === "/lead") return say({ text: "Usage: /lead <provider:model>" });
-      if (text.startsWith("/lead ")) return session.setLead(makeProvider(text.slice("/lead ".length).trim()));
+      if (alone("/exit")) return exit();
+      if (alone("/errors")) return say(...summarize(errorFile).map((row) => ({ text: row, oneLine: true })));
+      if (alone("/lead")) return say({ text: "Usage: /lead <provider:model>" });
+      if (command === "/lead") return session.setLead(makeProvider(words.join(" ")));
+      const account = command === "/login" ? "login" : command === "/logout" ? "logout" : undefined;
       // A mistyped command must not become a paid turn.
-      // A slash and a bare word on its own is a command; "/tmp is full" is a message.
-      if (/^\/[a-z]+$/i.test(text)) return say({ text: `Unknown command: ${text}. Commands: /lead <provider:model>, /errors, /exit`, color: "red" });
+      // A slash and a bare word on its own is a command; "/tmp is full" is a message, "/exit now" is not.
+      if (!account && /^\/[a-z]+$/i.test(text)) return say({ text: `Unknown command: ${text}. Commands: ${COMMANDS}`, color: "red" });
+      if (words.length && ["/exit", "/errors"].includes(command)) return say({ text: `${command} takes nothing after it.`, color: "red" });
       abort.current = new AbortController();
       setBusy(true);
       try {
-        await session.send(text, abort.current.signal);
+        // Signing in waits on the browser; Ctrl-C stops it, as it stops a turn.
+        if (account) await login(account, words, (line) => say({ text: line, color: "magenta" }), abort.current.signal, "/");
+        else await session.send(text, abort.current.signal);
       } finally {
         setBusy(false);
       }
```


**Step 4: Run everything**

Run: `npm run typecheck`, then `npm test`

Expected: no type errors; Test Files 24 passed | 2 skipped (26); Tests 377 passed | 5 skipped (382).

**Step 5: Commit**

```bash
git add src/cli.tsx src/tui/App.tsx tests/tui/app.test.tsx
git commit -m "feat: /login and /logout in a session"
```

### Task 12: The `/model` picker

`/model` lists the models of every provider that is set up (release 2 design, "The model picker"):
- **Who is asked:**
  - ChatGPT when signed in, showing the models with `visibility: "list"` in OpenAI's order;
  - each provider whose API key is set;
  - Ollama, which needs no key, listed only when it is running.
- **All at once,** each at its own model-list address, checked against each provider's docs (in
  `models.ts`). OpenRouter's list comes in pages linked by `links.next`; a next page is followed
  only on the same site, since it is sent the key, and only once. OpenAI's list follows
  `OPENAI_BASE_URL` when it is set, as `openai:` leads do (the OpenAI SDK reads it).
- **A provider that fails** is shown with the reason ("key rejected", "could not connect: …")
  rather than hidden, and so are a ChatGPT sign-in that cannot be used and a provider with no
  models. What reading the saved login says, such as a wait for another process, is shown too.
- **The list:** arrow keys move, Enter picks (the same as `/lead`), Esc or Ctrl-C closes, typing
  filters. The current lead is marked `●`. It fits the terminal's height, and model names are
  escaped like everything else on screen. It uses Ink's own keyboard input, so no new package.

The tests wait one tick after the list appears before typing, because the picker starts reading keys
just after it first draws. A person cannot type that fast; in the test, the keys were lost. Keys
that arrive together (a held arrow key, a paste) are each read after the one before, so the picker
keeps what it knows in a ref rather than in React state, which is updated only when the screen is
drawn again. Ink passes a paste, or a letter and Enter typed together, as one piece of text: what is
before a line end filters, without its control characters, and the line end picks.

**Files:**
- Modify: `src/cli.tsx`
- Create: `src/providers/models.ts`
- Modify: `src/tui/App.tsx`
- Create: `src/tui/ModelPicker.tsx`
- Create: `tests/providers/models.test.ts`
- Modify: `tests/tui/app.test.tsx`

**Step 1: Write the failing tests**

**Create `tests/providers/models.test.ts`:**

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginStore } from "../../src/auth/store.js";
import { listModels } from "../../src/providers/models.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Stands in for every provider's model list, by address.
function providers(routes: Record<string, (auth: string | null) => Response | Promise<Response>>) {
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    seen.push(url);
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!route) throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    return route[1](headers.get("authorization") ?? headers.get("x-api-key"));
  });
  return seen;
}

function emptyData() {
  vi.stubEnv("TACHI_DATA_DIR", path.join(mkdtempSync(path.join(tmpdir(), "tachi-models-")), "data"));
}

describe("listModels", () => {
  it("asks only the providers that are set up, and Ollama, which needs no key", async () => {
    emptyData();
    const seen = providers({ "http://localhost:11434/v1/models": () => json({ data: [{ id: "qwen3:8b" }] }) });
    expect(await listModels(undefined, {})).toEqual([{ provider: "ollama", models: ["qwen3:8b"] }]);
    expect(seen).toEqual(["http://localhost:11434/v1/models"]);
  });

  it("shows a provider that fails, with the reason", async () => {
    emptyData();
    providers({ "https://api.openai.com/v1/models": () => json({ error: {} }, 401) });
    expect(await listModels(undefined, { OPENAI_API_KEY: "bad" })).toEqual([{ provider: "openai", error: "key rejected" }]);
  });

  it("leaves Ollama out when it is not running", async () => {
    emptyData();
    const seen = providers({});
    expect(await listModels(undefined, {})).toEqual([]);
    expect(seen).toEqual(["http://localhost:11434/v1/models"]);
  });

  it("says in a few words why a list could not be read, sending each provider its key", async () => {
    emptyData();
    providers({
      "https://api.anthropic.com/v1/models": () => json({ type: "error", error: { type: "invalid_request_error", message: "bad" } }, 400),
      "https://api.openai.com/v1/models": (key) => (key === "Bearer sk-oa" ? json({}, 500) : json({}, 401)),
      "https://openrouter.ai/api/v1/models": () => new Response("<html>wifi</html>", { status: 200, headers: { "content-type": "text/html" } }),
    });
    expect(await listModels(undefined, { ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oa", OPENROUTER_API_KEY: "sk-or", MOONSHOT_API_KEY: "sk-k" })).toEqual([
      { provider: "anthropic", error: "HTTP 400" },
      { provider: "openai", error: "HTTP 500" },
      { provider: "openrouter", error: "the answer was not a model list" },
      { provider: "kimi", error: "could not connect: connect ECONNREFUSED" },
    ]);
    providers({ "https://api.anthropic.com/v1/models": () => json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401) });
    expect(await listModels(undefined, { ANTHROPIC_API_KEY: "bad" })).toEqual([{ provider: "anthropic", error: "key rejected" }]);
  });

  it("says when Anthropic cannot be reached, as for the others", async () => {
    emptyData();
    providers({});
    expect(await listModels(undefined, { ANTHROPIC_API_KEY: "sk-ant" })).toEqual([{ provider: "anthropic", error: "could not connect: connect ECONNREFUSED" }]);
  });

  it("follows a next page only on the same site, and only once", async () => {
    emptyData();
    const seen = providers({
      "https://elsewhere.example/": () => json({ data: [{ id: "stolen" }] }),
      "https://openrouter.ai/api/v1/models?page=2": () => json({ data: [{ id: "b/2" }], links: { next: "/api/v1/models?page=2" } }),
      "https://openrouter.ai/api/v1/models": () => json({ data: [{ id: "a/1" }], links: { next: "/api/v1/models?page=2" } }),
      "https://api.openai.com/v1/models": () => json({ data: [{ id: "gpt" }], links: { next: "https://elsewhere.example/steal" } }),
    });
    expect(await listModels(undefined, { OPENAI_API_KEY: "sk-oa", OPENROUTER_API_KEY: "sk-or" })).toEqual([
      { provider: "openai", error: "its next page is on another site" },
      { provider: "openrouter", models: ["a/1", "b/2"] },
    ]);
    expect(seen.filter((url) => url.startsWith("https://elsewhere"))).toEqual([]);
  });

  it("asks every provider at once", async () => {
    emptyData();
    let release!: () => void;
    const both = new Promise<void>((resolve) => (release = resolve));
    providers({
      "https://api.openai.com/v1/models": async () => {
        await both; // answers only once OpenRouter has been asked too
        return json({ data: [{ id: "gpt" }] });
      },
      "https://openrouter.ai/api/v1/models": () => {
        release();
        return json({ data: [{ id: "a/1" }] });
      },
    });
    expect(await listModels(undefined, { OPENAI_API_KEY: "sk-oa", OPENROUTER_API_KEY: "sk-or" })).toEqual([
      { provider: "openai", models: ["gpt"] },
      { provider: "openrouter", models: ["a/1"] },
    ]);
  });

  it("says so when an answer is not a model list", async () => {
    emptyData();
    providers({
      "https://api.openai.com/v1/models": () => json(null),
      "https://openrouter.ai/api/v1/models": () => json({ data: {} }),
      "https://api.moonshot.ai/v1/models": () => json({ data: [null, { id: "kimi-k3" }] }),
    });
    expect(await listModels(undefined, { OPENAI_API_KEY: "sk-oa", OPENROUTER_API_KEY: "sk-or", MOONSHOT_API_KEY: "sk-k" })).toEqual([
      { provider: "openai", error: "the answer was not a model list" },
      { provider: "openrouter", error: "the answer was not a model list" },
      { provider: "kimi", models: ["kimi-k3"] },
    ]);
  });

  it("asks OpenAI at OPENAI_BASE_URL when it is set, as the OpenAI SDK does for openai: leads", async () => {
    emptyData();
    const seen = providers({ "https://proxy.example/v1/models": () => json({ data: [{ id: "via-proxy" }] }) });
    expect(await listModels(undefined, { OPENAI_API_KEY: "sk-oa", OPENAI_BASE_URL: "https://proxy.example/v1" })).toEqual([
      { provider: "openai", models: ["via-proxy"] },
    ]);
    expect(seen).not.toContain("https://api.openai.com/v1/models");
    expect(await listModels(undefined, { OPENAI_API_KEY: "sk-oa", OPENAI_BASE_URL: "https://proxy.example/v1/" })).toEqual([
      { provider: "openai", models: ["via-proxy"] },
    ]);
  });

  it("shows a ChatGPT sign-in that cannot be used, with why", async () => {
    emptyData();
    const store = new LoginStore(process.env.TACHI_DATA_DIR!, () => {});
    await store.update(async (login, save) => {
      save({ ...login, active: { clientId: "c", sub: "s", planUse: false, tokens: { access: "t", refresh: "r", expiresAt: Date.now() + 3_600_000, scopes: [] } } });
    });
    providers({});
    expect(await listModels(undefined, {})).toEqual([
      { provider: "chatgpt", error: "This ChatGPT sign-in does not allow using your plan. Sign out with `tachi logout chatgpt` (or /logout chatgpt in a session), sign in again and allow it, or use openai:<model> with an API key." },
    ]);
    writeFileSync(store.file, "{ not json");
    expect(await listModels(undefined, {})).toEqual([{ provider: "chatgpt", error: expect.stringContaining("is damaged") }]);
  });

  it("reads Anthropic's list with the key, and follows OpenRouter's pages", async () => {
    emptyData();
    providers({
      "https://api.anthropic.com/v1/models": (key) => (key === "sk-ant" ? json({ data: [{ id: "claude-opus-5-5", type: "model" }], has_more: false }) : json({}, 401)),
      "https://openrouter.ai/api/v1/models?page=2": () => json({ data: [{ id: "b/2" }] }),
      "https://openrouter.ai/api/v1/models": () => json({ data: [{ id: "a/1" }], links: { next: "/api/v1/models?page=2" } }),
    });
    const groups = await listModels(undefined, { ANTHROPIC_API_KEY: "sk-ant", OPENROUTER_API_KEY: "sk-or" });
    expect(groups).toContainEqual({ provider: "anthropic", models: ["claude-opus-5-5"] });
    expect(groups).toContainEqual({ provider: "openrouter", models: ["a/1", "b/2"] });
  });

  it("lists the ChatGPT models meant to be shown, in OpenAI's order, when signed in", async () => {
    emptyData();
    const store = new LoginStore(process.env.TACHI_DATA_DIR!, () => {});
    await store.update(async (login, save) => {
      save({ ...login, active: { clientId: "c", sub: "s", planUse: true, tokens: { access: "plan-token", refresh: "r", expiresAt: Date.now() + 3_600_000, scopes: [] } } });
    });
    providers({
      "https://api.openai.com/v1/models": (auth) =>
        auth === "Bearer plan-token"
          ? json({ models: [{ slug: "z-model", visibility: "list" }, { slug: "hidden", visibility: "hide" }, { slug: "a-model", visibility: "list" }] })
          : json({}, 401),
    });
    expect(await listModels(undefined, {})).toContainEqual({ provider: "chatgpt", models: ["z-model", "a-model"] });
  });
});
```

**Change `tests/tui/app.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/app.test.tsx b/tests/tui/app.test.tsx
index 9a16c10..75349d1 100644
--- a/tests/tui/app.test.tsx
+++ b/tests/tui/app.test.tsx
@@ -9,6 +9,7 @@ import { Session } from "../../src/core/session.js";
 import { Stats } from "../../src/core/stats.js";
 import type { Provider } from "../../src/core/types.js";
 import { TOOLS } from "../../src/tools/index.js";
+import type { ModelGroup } from "../../src/providers/models.js";
 import { App, type AppProps } from "../../src/tui/App.js";
 import { SEGMENTS } from "../../src/tui/StatusLine.js";
 import { Bus, FakeProvider, callTool, reply, tempContext } from "../helpers.js";
@@ -30,7 +31,7 @@ type Login = AppProps["login"];
 
 async function mount(
   turns: ConstructorParameters<typeof FakeProvider>[1],
-  opts: { lead?: Provider; errorFile?: string; login?: Login; made?: string[] } = {},
+  opts: { lead?: Provider; errorFile?: string; login?: Login; models?: ModelGroup[]; note?: string; slow?: boolean; made?: string[] } = {},
 ) {
   const bus = new Bus();
   const stats = new Stats(bus);
@@ -52,6 +53,11 @@ async function mount(
         return new FakeProvider("b", []);
       }}
       login={opts.login ?? (async () => {})}
+      listModels={async (signal, warn) => {
+        if (opts.note) warn(opts.note);
+        if (opts.slow) await new Promise((resolve) => signal.addEventListener("abort", resolve)); // until Ctrl-C
+        return opts.models ?? [];
+      }}
       bindAsk={(fn) => {
         ask = fn;
       }}
@@ -224,6 +230,140 @@ describe("App", () => {
     await until(app, "›");
   });
 
+  const models: ModelGroup[] = [
+    { provider: "fake", models: ["a", "b", "c"] },
+    { provider: "ollama", error: "not running" },
+    { provider: "evil", models: [`x${OSC52}`] },
+  ];
+
+  it("lists every provider's models with /model, marks the lead, and picks with the arrow keys and Enter", async () => {
+    const made: string[] = [];
+    const { app } = await mount([], { models, made });
+    await type(app, "/model");
+    await until(app, "ollama (not running)");
+    expect(app.lastFrame()).toContain("● fake:a");
+    expect(app.lastFrame()).toContain(`evil:x${OSC52_SHOWN}`);
+    expectNoRawControls(app.lastFrame());
+    await tick(); // the picker starts reading keys just after it first appears
+    app.stdin.write("\u001b[B"); // down
+    await tick();
+    app.stdin.write("\r");
+    await until(app, "lead is now fake:b");
+    expect(made).toEqual(["fake:b"]);
+  });
+
+  it("filters as the user types, and closes on Esc without changing the lead", async () => {
+    const made: string[] = [];
+    const { app } = await mount([], { models, made });
+    await type(app, "/Model"); // commands ignore case
+    await until(app, "fake:c");
+    await tick();
+    app.stdin.write("c");
+    await tick();
+    expect(app.lastFrame()).toContain("fake:c");
+    expect(app.lastFrame()).not.toContain("● fake:a"); // the status line still names the lead
+    expect(app.lastFrame()).not.toContain("not running");
+    app.stdin.write("\u001b");
+    await until(app, "›");
+    expect(app.lastFrame()).not.toContain("fake:c");
+    expect(made).toEqual([]);
+  });
+
+  it("refuses words after /model instead of sending them to the model", async () => {
+    const { app, session } = await mount([], { models });
+    await type(app, "/model gpt");
+    await until(app, "/model takes nothing after it.");
+    expect(session.messages).toEqual([]);
+  });
+
+  it("moves both ways, unfilters on Backspace, says when nothing matches, and closes on Ctrl-C", async () => {
+    const made: string[] = [];
+    const { app } = await mount([], { models, made });
+    await type(app, "/model");
+    await until(app, "fake:c");
+    await tick();
+    app.stdin.write("zz");
+    await until(app, "No models match.");
+    app.stdin.write("\u007f");
+    await tick();
+    app.stdin.write("\u007f");
+    await until(app, "fake:c");
+    for (const key of ["\u001b[B", "\u001b[B", "\u001b[A"]) {
+      app.stdin.write(key); // down, down, up
+      await tick();
+    }
+    app.stdin.write("\r");
+    await until(app, "lead is now fake:b");
+    expect(made).toEqual(["fake:b"]);
+    await type(app, "/model");
+    await until(app, "fake:c");
+    await tick();
+    app.stdin.write("\u0003");
+    await until(app, "›");
+    expect(app.lastFrame()).not.toContain("fake:c");
+    await type(app, "/lead"); // still running
+    await until(app, "Usage: /lead");
+  });
+
+  it("shows a provider with no models, and what signing in says while the lists are read", async () => {
+    const { app } = await mount([], { models: [{ provider: "fake", models: ["a"] }, { provider: "empty", models: [] }], note: "Waiting for Tachikoma (process 7)…" });
+    await type(app, "/model");
+    await until(app, "empty (no models)");
+    expect(app.lastFrame()).toContain("Waiting for Tachikoma (process 7)…");
+    await tick();
+    app.stdin.write("a");
+    await tick();
+    expect(app.lastFrame()).toContain("fake:a");
+    expect(app.lastFrame()).not.toContain("empty");
+  });
+
+  it("reads keys that arrive together in order, each after the one before", async () => {
+    const made: string[] = [];
+    const { app } = await mount([], { models, made });
+    await type(app, "/model");
+    await until(app, "fake:c");
+    await tick();
+    app.stdin.write("\u001b[B\u001b[B"); // two downs in one read of the terminal
+    app.stdin.write("\r");
+    await until(app, "›");
+    await type(app, "/model");
+    await until(app, "fake:c");
+    await tick();
+    app.stdin.write("b\r"); // a letter and Enter in one read of the terminal, as a paste ends
+    await until(app, "›");
+    expect(made).toEqual(["fake:c", "fake:b"]);
+  });
+
+  it("keeps control characters out of the filter, and shows the rest escaped", async () => {
+    const { app } = await mount([], { models });
+    await type(app, "/model");
+    await until(app, "fake:c");
+    await tick();
+    app.stdin.write("b\t\u202e");
+    await until(app, "Filter: b\\u202e ·");
+    app.stdin.write("x\r"); // nothing matches, so the line end picks nothing
+    await until(app, "Filter: b\\u202ex ·");
+  });
+
+  it("says when there is nothing to pick from", async () => {
+    const { app } = await mount([], { models: [{ provider: "openai", error: "key rejected" }] });
+    await type(app, "/model");
+    await until(app, "openai (key rejected)");
+    expect(app.lastFrame()).toContain("No models to pick from.");
+    expect(app.lastFrame()).not.toContain("No models match.");
+  });
+
+  it("stops reading the lists on Ctrl-C, without opening the picker", async () => {
+    const { app } = await mount([], { models, slow: true });
+    await type(app, "/model");
+    await until(app, "Ctrl-C to stop");
+    app.stdin.write("\u0003");
+    await until(app, "›");
+    await tick();
+    expect(app.lastFrame()).not.toContain("fake:c");
+    expect(app.lastFrame()).not.toContain("Filter:");
+  });
+
   it("sends a message that starts with a one-word path", async () => {
     const { app, session } = await mount([reply("ok")]);
     await type(app, "/tmp is full");
```


**Step 2: Run them and see them fail**

Run: `npm test -- tests/providers/models.test.ts tests/tui/app.test.tsx`

Expected: FAIL. In the scratch build: Test Files 2 failed (2); Tests 9 failed | 29 passed (38). The model-list module and the picker do not exist yet.

**Step 3: Write the code**

**Change `src/cli.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/cli.tsx b/src/cli.tsx
index 0be8858..8e6a2aa 100644
--- a/src/cli.tsx
+++ b/src/cli.tsx
@@ -15,6 +15,7 @@ import { Stats } from "./core/stats.js";
 import { errorText, type Provider } from "./core/types.js";
 import { LocalExecutor } from "./exec/local.js";
 import { EFFORTS, type Effort } from "./providers/anthropic.js";
+import { listModels } from "./providers/models.js";
 import { createProvider } from "./providers/registry.js";
 import { TOOLS } from "./tools/index.js";
 import { App } from "./tui/App.js";
@@ -41,9 +42,9 @@ Options:
   --raw             with -p, print the answer exactly as written, control codes and all
   -h, --help        show this help
 
-In a session: /lead <provider:model> switches the lead model, /login chatgpt and /logout chatgpt
-sign in and out, /errors summarises the error log, /exit quits. Ctrl-C stops the current turn, or
-quits when idle.`;
+In a session: /lead <provider:model> switches the lead model, /model picks it from a list,
+/login chatgpt and /logout chatgpt sign in and out, /errors summarises the error log, /exit quits.
+Ctrl-C stops the current turn, or quits when idle.`;
 
 function fail(message: string): never {
   console.error(message);
@@ -188,6 +189,7 @@ if (parsed.print !== undefined) {
       segments={segments}
       makeProvider={makeProvider}
       login={accountCommand}
+      listModels={(signal, warn) => listModels(signal, process.env, warn)}
       bindAsk={(fn) => {
         ask = fn;
       }}
```

**Create `src/providers/models.ts`:**

```ts
import Anthropic from "@anthropic-ai/sdk";
import { ChatGPTAuth } from "../auth/access.js";
import { LoginStore } from "../auth/store.js";
import { dataDir } from "../core/datadir.js";
import { connectReason, errorText } from "../core/types.js";
import { API_BASE, planModels } from "./chatgpt.js";
import { PRESETS } from "./openai.js";

// The models of every provider that is set up, for `/model` (release 2 design, "The model picker").
// Each is asked at once, at its own model-list address, checked 2026-10-23 against its docs:
// Anthropic GET /v1/models (platform.claude.com/docs/en/api/models/list), OpenAI GET /v1/models
// (developers.openai.com/api/reference/resources/models/methods/list), OpenRouter GET /api/v1/models
// (openrouter.ai/docs/api-reference/models/get-models), Kimi GET /v1/models
// (platform.kimi.ai/docs/api/list-models.md), Ollama's OpenAI-compatible GET /v1/models
// (docs.ollama.com/api/openai-compatibility).

export type ModelGroup = { provider: string; models: string[] } | { provider: string; error: string };

// OpenAI's own address, unless OPENAI_BASE_URL is set: the OpenAI SDK reads it for openai: leads, so
// the list comes from where they go. One slash at the end is dropped, as the SDK does.
const OPENAI_BASE = "https://api.openai.com/v1";

const fetchFailed = (err: unknown) => err instanceof Error && err.message === "fetch failed"; // Node's fetch

// Why a list could not be read, in a few words.
function reason(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return "key rejected";
  if (err instanceof Anthropic.APIConnectionError || fetchFailed(err)) return `could not connect: ${connectReason(err as Error)}`;
  if (err instanceof Anthropic.APIError) return `HTTP ${err.status}`;
  return errorText(err);
}

// An OpenAI-format list: `data`, each with an `id`. OpenRouter splits its list into pages linked by
// `links.next`. A next page is followed only on the same site, since it is sent the key, and only once.
async function openaiFormat(base: string, key: string | undefined, signal?: AbortSignal): Promise<string[]> {
  const ids: string[] = [];
  const asked = new Set<string>();
  for (let url: string | undefined = `${base.replace(/\/$/, "")}/models`; url && !asked.has(url); ) {
    asked.add(url);
    const res = await fetch(url, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal });
    if (res.status === 401 || res.status === 403) throw new Error("key rejected");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json().catch(() => {
      throw new Error("the answer was not a model list"); // a Wi-Fi sign-in page, say
    })) as { data?: unknown; links?: { next?: unknown } } | null;
    const data = body?.data;
    if (!Array.isArray(data)) throw new Error("the answer was not a model list");
    for (const m of data as ({ id?: unknown } | null)[]) if (typeof m?.id === "string") ids.push(m.id);
    const link = body?.links?.next;
    const next: URL | undefined = typeof link === "string" && link ? new URL(link, url) : undefined;
    if (next && next.origin !== new URL(url).origin) throw new Error("its next page is on another site");
    url = next?.href;
  }
  return ids;
}

// `warn` shows what reading the saved login says, such as a wait for another process.
export async function listModels(signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env, warn: (line: string) => void = () => {}): Promise<ModelGroup[]> {
  const asks: { provider: string; list: () => Promise<string[]> }[] = [];
  // The login is read twice below, so a line it says twice is shown once.
  const shown = new Set<string>();
  const store = new LoginStore(dataDir(), (line) => {
    if (!shown.has(line)) warn(line);
    shown.add(line);
  });
  // ChatGPT is asked when a sign-in is saved; one that cannot be used is shown, with why.
  let signedIn = true;
  try {
    signedIn = Boolean(store.read().active);
  } catch {} // a damaged file: asking says so
  const auth = new ChatGPTAuth(store);
  if (signedIn) asks.push({ provider: "chatgpt", list: async () => (await planModels((await auth.token(signal)).token, API_BASE, signal)).filter((m) => m.listed).map((m) => m.slug) });
  const anthropicKey = env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    asks.push({
      provider: "anthropic",
      list: async () => {
        const ids: string[] = [];
        // An API key only, as in anthropic.ts.
        for await (const m of new Anthropic({ apiKey: anthropicKey, authToken: null }).models.list({}, { signal })) ids.push(m.id);
        return ids;
      },
    });
  }
  for (const [kind, preset] of Object.entries(PRESETS)) {
    const key = preset.keyEnv ? env[preset.keyEnv] : undefined;
    if (preset.keyEnv && !key) continue; // not set up
    asks.push({ provider: kind, list: () => openaiFormat(preset.baseURL ?? (env.OPENAI_BASE_URL || OPENAI_BASE), key, signal) });
  }
  const groups = await Promise.all(
    asks.map(async ({ provider, list }): Promise<ModelGroup[]> => {
      try {
        return [{ provider, models: await list() }]; // in the provider's own order, as OpenAI's docs ask for ChatGPT's
      } catch (err) {
        // Ollama needs no key, so it is always asked; it is listed only when it is running.
        if (provider === "ollama" && fetchFailed(err)) return [];
        return [{ provider, error: reason(err) }];
      }
    }),
  );
  return groups.flat();
}
```

**Change `src/tui/App.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/App.tsx b/src/tui/App.tsx
index 8e02331..18623e8 100644
--- a/src/tui/App.tsx
+++ b/src/tui/App.tsx
@@ -6,7 +6,9 @@ import type { Mode } from "../core/permissions.js";
 import type { Session } from "../core/session.js";
 import type { Stats } from "../core/stats.js";
 import { errorText, type Message, type Provider } from "../core/types.js";
+import type { ModelGroup } from "../providers/models.js";
 import { describe, type Line, screen } from "./describe.js";
+import { ModelPicker } from "./ModelPicker.js";
 import { type Segment, StatusLine } from "./StatusLine.js";
 
 type Question = { text: string; answer: (ok: boolean, how: string) => void };
@@ -23,17 +25,20 @@ export interface AppProps {
   // `/login …` and `/logout …`: the words after the command, where to show what it says, a signal
   // Ctrl-C aborts, and how a command is typed here ("/").
   login: (verb: "login" | "logout", words: string[], say: (line: string) => void, signal: AbortSignal, prefix: string) => Promise<void>;
+  // `/model`: every provider's models, and where to show what reading the saved login says.
+  listModels: (signal: AbortSignal, warn: (line: string) => void) => Promise<ModelGroup[]>;
 }
 
-const COMMANDS = "/lead <provider:model>, /login chatgpt, /logout chatgpt, /errors, /exit";
+const COMMANDS = "/lead <provider:model>, /model, /login chatgpt, /logout chatgpt, /errors, /exit";
 
-export function App({ session, bus, stats, mode, errorFile, segments, makeProvider, bindAsk, login }: AppProps) {
+export function App({ session, bus, stats, mode, errorFile, segments, makeProvider, bindAsk, login, listModels }: AppProps) {
   const { exit } = useApp();
   const [lines, setLines] = useState<(Line & { id: number })[]>([]);
   const [input, setInput] = useState("");
   const [busy, setBusy] = useState(false);
   const [question, setQuestion] = useState<Question | null>(null);
   const [contextWindow, setContextWindow] = useState<number | null>(null);
+  const [picker, setPicker] = useState<ModelGroup[] | null>(null);
   const [, rerender] = useState(0);
   const abort = useRef<AbortController | null>(null);
   const nextId = useRef(0);
@@ -119,14 +124,18 @@ export function App({ session, bus, stats, mode, errorFile, segments, makeProvid
       const account = command === "/login" ? "login" : command === "/logout" ? "logout" : undefined;
       // A mistyped command must not become a paid turn.
       // A slash and a bare word on its own is a command; "/tmp is full" is a message, "/exit now" is not.
-      if (!account && /^\/[a-z]+$/i.test(text)) return say({ text: `Unknown command: ${text}. Commands: ${COMMANDS}`, color: "red" });
-      if (words.length && ["/exit", "/errors"].includes(command)) return say({ text: `${command} takes nothing after it.`, color: "red" });
+      if (!account && !alone("/model") && /^\/[a-z]+$/i.test(text)) return say({ text: `Unknown command: ${text}. Commands: ${COMMANDS}`, color: "red" });
+      if (words.length && ["/exit", "/errors", "/model"].includes(command)) return say({ text: `${command} takes nothing after it.`, color: "red" });
       abort.current = new AbortController();
       setBusy(true);
       try {
         // Signing in waits on the browser; Ctrl-C stops it, as it stops a turn.
         if (account) await login(account, words, (line) => say({ text: line, color: "magenta" }), abort.current.signal, "/");
-        else await session.send(text, abort.current.signal);
+        else if (alone("/model")) {
+          const { signal } = abort.current; // this command's own, read before the wait
+          const groups = await listModels(signal, (line) => say({ text: line, color: "magenta" }));
+          if (!signal.aborted) setPicker(groups);
+        } else await session.send(text, abort.current.signal);
       } finally {
         setBusy(false);
       }
@@ -135,7 +144,18 @@ export function App({ session, bus, stats, mode, errorFile, segments, makeProvid
     }
   };
 
+  // Picking does what `/lead <provider:model>` does.
+  const pick = (spec: string) => {
+    setPicker(null);
+    try {
+      session.setLead(makeProvider(spec));
+    } catch (err) {
+      say({ text: errorText(err), color: "red" });
+    }
+  };
+
   useInput((ch, key) => {
+    if (picker) return; // the picker reads the keys while it is open
     if (question) {
       if (key.ctrl && ch === "c") {
         question.answer(false, "declined (cancelled)");
@@ -161,7 +181,9 @@ export function App({ session, bus, stats, mode, errorFile, segments, makeProvid
           </Text>
         )}
       </Static>
-      {question ? (
+      {picker ? (
+        <ModelPicker groups={picker} current={session.lead.id} onPick={pick} onClose={() => setPicker(null)} />
+      ) : question ? (
         <Text color="yellow">Allow {question.text}? [y/n]</Text>
       ) : (
         <Text>{busy ? "… working (Ctrl-C to stop)" : `› ${input}`}</Text>
```

**Create `src/tui/ModelPicker.tsx`:**

```tsx
import { Text, useInput, useStdout } from "ink";
import { useRef, useState } from "react";
import { visible } from "../core/permissions.js";
import type { ModelGroup } from "../providers/models.js";

// `/model`: every model of every provider that is set up (release 2 design, "The model picker").
// Arrow keys move, Enter picks, Esc (or Ctrl-C) closes, and typing filters, since OpenRouter alone
// lists hundreds.
// Names come from the providers, so they are escaped like everything else on screen.

type Row = { kind: "heading"; text: string } | { kind: "model"; spec: string };

export function rows(groups: ModelGroup[], filter: string): Row[] {
  const f = filter.toLowerCase();
  return groups.flatMap((g): Row[] => {
    if ("error" in g) return f ? [] : [{ kind: "heading", text: `${g.provider} (${g.error})` }];
    if (!g.models.length) return f ? [] : [{ kind: "heading", text: `${g.provider} (no models)` }];
    const specs = g.models.map((m) => `${g.provider}:${m}`).filter((s) => s.toLowerCase().includes(f));
    return specs.length ? [{ kind: "heading", text: g.provider }, ...specs.map((spec): Row => ({ kind: "model", spec }))] : [];
  });
}

// The rows shown for a filter, the models among them, and which of those is chosen.
function view(groups: ModelGroup[], filter: string, chosen: number) {
  const shown = rows(groups, filter);
  const models = shown.flatMap((r) => (r.kind === "model" ? [r.spec] : []));
  return { shown, models, at: Math.min(chosen, Math.max(0, models.length - 1)) };
}

export function ModelPicker({ groups, current, onPick, onClose }: { groups: ModelGroup[]; current: string; onPick: (spec: string) => void; onClose: () => void }) {
  // Each key reads and changes this at once: Ink can pass on several keys from one read of the
  // terminal before the screen is drawn again, and each must see what the one before it did.
  const state = useRef<{ filter: string; chosen: number } | null>(null);
  state.current ??= { filter: "", chosen: Math.max(0, view(groups, "", 0).models.indexOf(current)) };
  const [, redraw] = useState(0);
  const { filter } = state.current;
  const { shown, models, at } = view(groups, filter, state.current.chosen);
  // Fits the terminal: the help line, the status line and the line Ink ends with take three rows.
  const height = Math.max(1, (useStdout().stdout.rows || shown.length + 3) - 3);
  const focus = shown.findIndex((r) => r.kind === "model" && r.spec === models[at]);
  const top = Math.min(Math.max(0, focus - Math.floor(height / 2)), Math.max(0, shown.length - height));

  // Picks the chosen model, as the keys before it left the filter and the choice.
  const pick = () => {
    const { models, at } = view(groups, state.current!.filter, state.current!.chosen);
    const spec = models[at];
    if (spec) onPick(spec);
    else redraw((n) => n + 1);
  };

  useInput((ch, key) => {
    const s = state.current!;
    const { models, at } = view(groups, s.filter, s.chosen);
    if (key.escape || (key.ctrl && ch === "c")) return onClose();
    if (key.return) return pick();
    if (key.upArrow) s.chosen = Math.max(0, at - 1);
    else if (key.downArrow) s.chosen = Math.max(0, Math.min(models.length - 1, at + 1));
    else if (key.backspace || key.delete) Object.assign(s, { filter: s.filter.slice(0, -1), chosen: 0 });
    else if (!key.ctrl && !key.meta && ch) {
      // A paste, or a letter and Enter in one read of the terminal, comes as one piece of text: what is
      // before a line end filters, without its control characters, and the line end picks.
      const [typed = "", ...after] = ch.split(/[\r\n]/);
      const text = typed.replace(/\p{Cc}/gu, "");
      if (text) Object.assign(s, { filter: s.filter + text, chosen: 0 });
      if (after.length) return pick();
    } else return;
    redraw((n) => n + 1);
  });

  return (
    <>
      {shown.slice(top, top + height).map((r, i) =>
        r.kind === "heading" ? (
          <Text key={`h${top + i}`} bold wrap="truncate-end">
            {visible(r.text)}
          </Text>
        ) : (
          <Text key={`m${top + i}`} inverse={r.spec === models[at]} wrap="truncate-end">
            {r.spec === current ? "● " : "  "}
            {visible(r.spec)}
          </Text>
        ),
      )}
      {models.length === 0 && <Text color="gray">{filter ? "No models match." : "No models to pick from."}</Text>}
      <Text color="gray" wrap="truncate-end">
        Filter: {visible(filter) || "(type to filter)"} · ↑↓ move · Enter picks · Esc closes
      </Text>
    </>
  );
}
```


**Step 4: Run everything**

Run: `npm run typecheck`, then `npm test`

Expected: no type errors; Test Files 25 passed | 2 skipped (27); Tests 398 passed | 5 skipped (403).

**Step 5: Commit**

```bash
git add src/cli.tsx src/providers/models.ts src/tui/App.tsx src/tui/ModelPicker.tsx tests/providers/models.test.ts tests/tui/app.test.tsx
git commit -m "feat: the /model picker"
```

### Task 13: The keychain option

`tachi login chatgpt --keychain` keeps a key in the system's credential store (Windows Credential
Manager, the macOS Keychain or the Linux secret service), and the tokens in the private file are
sealed with it (choice 5; release 2 design, "The keychain option", and "Different from the design"):
- **One key per data folder,** named by the folder's machine ID (`chatgpt.<urn:uuid:...>`), made at
  the first `--keychain` sign-in, before the browser opens, and written to the keychain before
  anything is sealed with it. It is never rewritten after that, so readers without the lock always
  see a whole key, and the file is always written whole. The store keeps the key once read, so a
  keychain locked after OpenAI has issued tokens (a renewal, or the end of a sign-in) loses none.
- **AES-256-GCM:** a 32-byte key, a new 12-byte nonce for each save, and GCM's full 16-byte tag, so a
  changed file is detected.
- **A missing key, another key, a changed file, or a keychain that cannot be used** counts as signed
  out, and the user is told why. Logout cannot ask OpenAI to cancel tokens it cannot open, so it says
  so and points to ChatGPT's settings. Signing in waits for that logout (the user's choice,
  2026-10-23), so the user always hears it, and a login in a keychain that is only locked is not
  replaced.
- **A keychain that cannot be used is found before the browser opens,** when signing in with
  `--keychain` or moving a login there, so a sign-in is not finished only to be dropped.
- **At logout the key goes too.** If the keychain cannot be reached then, it stays, opening nothing.
- **Linux uses the secret service only.** Otherwise the package falls back to the kernel keyring,
  which "will not persist across reboots" (its README).
- **Loaded only when used,** so a system the package has no build for runs everything else.
- **Already signed in,** `--keychain` on its own seals the tokens with the folder's key. Moving back:
  sign out, and sign in without it.

The real-keychain test uses a name of its own and removes it afterwards, so the user's login is never
touched. It skips where there is no keychain (Linux without a secret service).

**Files:**
- Modify: `package-lock.json`
- Modify: `package.json`
- Modify: `src/auth/access.ts`
- Modify: `src/auth/chatgpt.ts`
- Create: `src/auth/keychain.ts`
- Modify: `src/auth/store.ts`
- Modify: `src/cli.tsx`
- Modify: `tests/auth/chatgpt.test.ts`
- Create: `tests/auth/keychain.test.ts`
- Modify: `tests/providers/models.test.ts`

**Step 1: Install the package**

`@napi-rs/keyring` 2.1.0, chosen on 2026-10-23:
- It is maintained (last change 2026-10-21) and MIT-licensed.
- It has no install scripts and no dependencies beyond one ready-built binary per system (Windows,
  macOS, Linux glibc and musl, x64 and arm64).
- It is the newest release at least 14 days old (2026-09-13), by release 1's rule.
- keytar is archived, and cross-keychain is pinned to keyring 1.x, which hides store errors as
  "not found".

```bash
timeout 280 sfw npm install @napi-rs/keyring@2.1.0 --save-exact --loglevel=http
```

This adds `"@napi-rs/keyring": "2.1.0"` to `package.json` and its entries to `package-lock.json`. If
`sfw` is not on PATH, stop and say so: never install without it.

**Step 2: Write the failing tests**

**Change `tests/auth/chatgpt.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/auth/chatgpt.test.ts b/tests/auth/chatgpt.test.ts
index da7380f..9bfae5a 100644
--- a/tests/auth/chatgpt.test.ts
+++ b/tests/auth/chatgpt.test.ts
@@ -60,10 +60,18 @@ describe("loginArgs", () => {
     expect(loginArgs(["ChatGPT"], "logout")).toEqual({});
     expect(loginArgs(["chatgpt", "--new"], "login")).toEqual({ fresh: true });
     expect(loginArgs(["chatgpt", "--account", "2"], "login")).toEqual({ account: 2 });
+    expect(loginArgs(["chatgpt", "--keychain", "--new"], "login")).toEqual({ keychain: true, fresh: true });
     expect(loginArgs(["chatgpt"], "logout")).toEqual({});
   });
 
-  it.each([[["openai"]], [[]], [["chatgpt", "--account", "0"]], [["chatgpt", "--new", "--account", "1"]], [["chatgpt", "x"]]])("refuses %j", (words) => {
+  it.each([
+    [["openai"]],
+    [[]],
+    [["chatgpt", "--account", "0"]],
+    [["chatgpt", "--new", "--account", "1"]],
+    [["chatgpt", "--keychain", "--keychain"]],
+    [["chatgpt", "x"]],
+  ])("refuses %j", (words) => {
     expect(() => loginArgs(words, "login")).toThrow(LoginError);
   });
 
@@ -74,7 +82,7 @@ describe("loginArgs", () => {
   it("names the command as it is typed: with tachi on the command line, with a slash in a session", () => {
     expect(() => loginArgs(["openai"], "login")).toThrow(new LoginError("Only ChatGPT has a login: `tachi login chatgpt`. Other providers use an API key."));
     expect(() => loginArgs(["openai"], "logout", "/")).toThrow(new LoginError("Only ChatGPT has a logout: `/logout chatgpt`. Other providers use an API key."));
-    expect(() => loginArgs([], "login", "/")).toThrow(new LoginError("Usage: /login chatgpt [--new | --account <number>]"));
+    expect(() => loginArgs([], "login", "/")).toThrow(new LoginError("Usage: /login chatgpt [--new | --account <number>] [--keychain]"));
     expect(() => loginArgs(["chatgpt", "now"], "logout", "/")).toThrow(new LoginError("Usage: /logout chatgpt"));
   });
 });
@@ -204,7 +212,7 @@ describe("signIn", () => {
     fake.scope = "openid profile email offline_access";
     await signIn(store, io, opts);
     expect(store.read()).toMatchObject({ noticeShown: false, active: { planUse: false } });
-    expect(said.at(-1)).toContain("but using your ChatGPT plan was not allowed");
+    expect(said.at(-1)).toContain("but using your ChatGPT plan was not allowed. To use it, sign out with `tachi logout chatgpt`, sign in again");
     expect(said).not.toContain(NOTICE);
   });
 
```

**Create `tests/auth/keychain.test.ts`:**

```ts
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { ChatGPTAuth } from "../../src/auth/access.js";
import { signIn, signOut } from "../../src/auth/chatgpt.js";
import { type Keychain, KeychainError, systemKeychain } from "../../src/auth/keychain.js";
import { LoginError, LoginStore } from "../../src/auth/store.js";
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
  const NOT_CANCELLED =
    "Signed out on this computer, but OpenAI did not confirm that the sign-in was cancelled. The saved login could not be opened, so OpenAI was not asked. You can disconnect Tachikoma in ChatGPT's settings.";

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

  it("counts a missing key, another key or a changed file as not usable; sign-in waits for logout, which says OpenAI was not asked", async () => {
    const keychain = memoryKeychain();
    const { fake, store, warned, said, io, opts } = await setup(keychain);
    await signIn(store, io, { ...opts, keychain: true });
    const name = `chatgpt.${store.read().hostId}`;
    const key = keychain.entries.get(name)!;
    const good = readFileSync(store.file, "utf8");

    keychain.entries.delete(name);
    expect(store.read().active?.tokens).toBeUndefined();
    expect(() => new ChatGPTAuth(store, fake.issuer).check()).toThrow(new LoginError("The saved ChatGPT login cannot be opened. Sign out with `tachi logout chatgpt` (or /logout chatgpt in a session), then sign in again, or choose another lead (--lead, or /lead in a session)."));
    keychain.entries.set(name, randomBytes(32).toString("base64"));
    expect(store.read().active?.tokens).toBeUndefined();
    keychain.entries.set(name, key);
    const changed = saved(store);
    const sealed = Buffer.from(changed.active.sealed, "base64");
    sealed[sealed.length - 1]! ^= 1;
    changed.active.sealed = sealed.toString("base64");
    writeFileSync(store.file, JSON.stringify(changed));
    expect(store.read().active?.tokens).toBeUndefined();
    expect(warned.at(-1)).toBe("The key in the system keychain is missing or does not fit.");
    // Refused before the browser, so the user hears at logout that OpenAI was not asked, and a login
    // that is only locked is not replaced.
    await expect(signIn(store, io, { ...opts, keychain: true })).rejects.toThrow(
      new LoginError("The saved ChatGPT login cannot be opened. Sign out first with `tachi logout chatgpt`."),
    );
    expect(saved(store).active.sealed).toEqual(changed.active.sealed);

    await signOut(store, io, opts);
    expect(said.at(-1)).toBe(NOT_CANCELLED);
    expect(store.read().active).toBeUndefined();
    const warnings = warned.length;
    await signIn(store, io, { ...opts, keychain: true });
    expect(store.read().active?.tokens).toBeDefined();
    expect(warned).toHaveLength(warnings);
    expect(readFileSync(store.file, "utf8")).not.toBe(good);
  });

  it("counts a keychain that cannot be used as not usable, with the reason, and logout says OpenAI was not asked", async () => {
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
    expect(store.read().active?.tokens).toBeUndefined();
    expect(warned.at(-1)).toBe("The system keychain could not be used (locked).");
    await signOut(store, io, opts);
    expect(said.at(-1)).toBe(NOT_CANCELLED);
  });

  it("finds a keychain that cannot be used before the browser opens, when signing in or moving a login", async () => {
    const locked = () => {
      throw new KeychainError("The system keychain could not be used (locked).");
    };
    const { fake, store, io, opts } = await setup({ read: locked, write: locked, clear: locked });
    let opened = false;
    const watched = { ...io, openBrowser: (url: string) => ((opened = true), fake.browser(url)) };
    const refused = new LoginError("The system keychain could not be used (locked). Sign in without --keychain to keep the login in its private file.");
    await expect(signIn(store, watched, { ...opts, keychain: true })).rejects.toThrow(refused);
    expect(opened).toBe(false);
    await signIn(store, watched, opts);
    await expect(signIn(store, watched, { ...opts, keychain: true })).rejects.toThrow(
      new LoginError("The system keychain could not be used (locked). The login stays in its private file."),
    );
    expect(store.read().keychain).toBe(false);
    expect(store.read().active?.tokens).toBeDefined();
  });

  it("asks the keychain nothing once OpenAI has issued tokens, so a keychain locked by then loses none", async () => {
    const memory = memoryKeychain();
    let locked = false;
    const keychain: Keychain = {
      read: (name) => {
        if (locked) throw new KeychainError("The system keychain could not be used (locked).");
        return memory.read(name);
      },
      write: (name, text) => {
        if (locked) throw new KeychainError("The system keychain could not be used (locked).");
        memory.write(name, text);
      },
      clear: memory.clear,
    };
    const { fake, store, io, opts } = await setup(keychain);
    // Locked once the browser opens: the sign-in is still saved, with the key made before it.
    await signIn(store, { ...io, openBrowser: (url: string) => ((locked = true), fake.browser(url)) }, { ...opts, keychain: true });
    locked = false;
    const tokens = store.read().active!.tokens!;
    // Locked as a renewal's new tokens arrive, in a process started later: they are still saved.
    await new LoginStore(path.dirname(store.file), () => {}, keychain).update(async (current, save) => {
      locked = true;
      save({ ...current, active: { ...current.active!, tokens: { ...tokens, access: "renewed" } } });
    });
    locked = false;
    expect(store.read().active?.tokens?.access).toBe("renewed");
  });

  it("renews a sealed login with the same key, and removes the key when a renewal finds the login dead", async () => {
    const keychain = memoryKeychain();
    const { fake, store, io, opts } = await setup(keychain);
    await signIn(store, io, { ...opts, keychain: true });
    const name = `chatgpt.${store.read().hostId}`;
    const key = keychain.entries.get(name);
    const auth = new ChatGPTAuth(store, fake.issuer);
    // Under a minute left, as time passing would leave it.
    const age = () => store.update(async (login, save) => void save({ ...login, active: { ...login.active!, tokens: { ...login.active!.tokens!, expiresAt: Date.now() + 59_000 } } }));
    await age();
    const old = store.read().active!.tokens!;
    const { token } = await auth.token();
    expect(token).not.toBe(old.access);
    expect(keychain.entries.get(name)).toBe(key);
    expect(readFileSync(store.file, "utf8")).not.toContain(token);
    expect(store.read().active!.tokens!.access).toBe(token);
    await age();
    fake.renewalError = "invalid_grant";
    await expect(auth.token()).rejects.toThrow(/^Your ChatGPT sign-in has expired or was cancelled\./);
    expect(keychain.entries.has(name)).toBe(false);
    expect(store.read().active).toBeUndefined();
  });

  it("replaces a key of the wrong length before sealing with it", async () => {
    const keychain = memoryKeychain();
    const { store, io, opts } = await setup(keychain);
    await signIn(store, io, { ...opts, keychain: true });
    await signOut(store, io, opts);
    const name = `chatgpt.${store.read().hostId}`;
    keychain.entries.set(name, Buffer.from("short").toString("base64"));
    await signIn(store, io, { ...opts, keychain: true });
    expect(Buffer.from(keychain.entries.get(name)!, "base64")).toHaveLength(32);
    expect(store.read().active?.tokens).toBeDefined();
  });

  it("reads the keychain again once another process has changed the login", async () => {
    const keychain = memoryKeychain();
    const { store, io, opts } = await setup(keychain);
    const other = new LoginStore(path.dirname(store.file), () => {}, keychain);
    await signIn(store, io, { ...opts, keychain: true });
    // Elsewhere: signed out, which removes the key, and signed in without the keychain.
    await signOut(other, io, opts);
    await signIn(other, io, opts);
    await signIn(store, io, { ...opts, keychain: true });
    expect(new LoginStore(path.dirname(store.file), () => {}, keychain).read().active?.tokens).toBeDefined();
  });

  it("keeps the key when the keychain cannot be reached at logout, and still signs out", async () => {
    const memory = memoryKeychain();
    const keychain: Keychain = {
      ...memory,
      clear: () => {
        throw new KeychainError("The system keychain could not be used (locked).");
      },
    };
    const { store, said, io, opts } = await setup(keychain);
    await signIn(store, io, { ...opts, keychain: true });
    await signOut(store, io, opts);
    expect(said.at(-1)).toBe("Signed out of ChatGPT.");
    expect(store.read().active).toBeUndefined();
    expect(memory.entries.size).toBe(1);
  });

  it("moves a login into the keychain when already signed in, and removes the key at logout", async () => {
    const keychain = memoryKeychain();
    const { store, said, io, opts } = await setup(keychain);
    await signIn(store, io, opts);
    expect(keychain.entries.size).toBe(0);
    const tokens = store.read().active!.tokens!;
    await expect(signIn(store, io, { ...opts, keychain: true, fresh: true })).rejects.toThrow(/^Already signed in as /);
    await signIn(store, io, { ...opts, keychain: true });
    expect(said.at(-1)).toBe("Your ChatGPT login is now sealed with a key kept in the system keychain.");
    await signIn(store, io, { ...opts, keychain: true });
    expect(said.at(-1)).toBe("Your ChatGPT login is already sealed with a key kept in the system keychain.");
    expect(keychain.entries.size).toBe(1);
    expect(readFileSync(store.file, "utf8")).not.toContain(tokens.refresh);
    expect(store.read().active?.tokens).toEqual(tokens);
    await signOut(store, io, opts);
    expect(keychain.entries.size).toBe(0);
  });
});
```

**Change `tests/providers/models.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/providers/models.test.ts b/tests/providers/models.test.ts
index 5d0b88d..099baf6 100644
--- a/tests/providers/models.test.ts
+++ b/tests/providers/models.test.ts
@@ -5,6 +5,13 @@ import { afterEach, describe, expect, it, vi } from "vitest";
 import { LoginStore } from "../../src/auth/store.js";
 import { listModels } from "../../src/providers/models.js";
 
+// The system keychain is never asked here: keys are kept in this map instead.
+const keys = vi.hoisted(() => new Map<string, string>());
+vi.mock("../../src/auth/keychain.js", async (original) => ({
+  ...(await original<typeof import("../../src/auth/keychain.js")>()),
+  systemKeychain: () => ({ read: (name: string) => keys.get(name) ?? null, write: (name: string, text: string) => void keys.set(name, text), clear: (name: string) => void keys.delete(name) }),
+}));
+
 afterEach(() => {
   vi.unstubAllGlobals();
   vi.unstubAllEnvs();
@@ -135,6 +142,21 @@ describe("listModels", () => {
     ]);
   });
 
+  it("shows a sealed ChatGPT login that cannot be opened, with why", async () => {
+    emptyData();
+    const store = new LoginStore(process.env.TACHI_DATA_DIR!, () => {});
+    await store.update(async (login, save) => {
+      save({ ...login, keychain: true, active: { clientId: "c", sub: "s", planUse: true, tokens: { access: "t", refresh: "r", expiresAt: Date.now() + 3_600_000, scopes: [] } } });
+    });
+    keys.clear(); // the key is gone
+    providers({});
+    const warned: string[] = [];
+    expect(await listModels(undefined, {}, (line) => warned.push(line))).toEqual([
+      { provider: "chatgpt", error: "The saved ChatGPT login cannot be opened. Sign out with `tachi logout chatgpt` (or /logout chatgpt in a session), then sign in again, or choose another lead (--lead, or /lead in a session)." },
+    ]);
+    expect(warned).toEqual(["The key in the system keychain is missing or does not fit."]);
+  });
+
   it("shows a ChatGPT sign-in that cannot be used, with why", async () => {
     emptyData();
     const store = new LoginStore(process.env.TACHI_DATA_DIR!, () => {});
```


**Step 3: Run them and see them fail**

Run: `npm test -- tests/auth/chatgpt.test.ts tests/auth/keychain.test.ts tests/providers/models.test.ts`

Expected: FAIL. In the scratch build: Test Files 3 failed (3); Tests 4 failed | 56 passed (60). The keychain module does not exist yet, and `--keychain` is refused.

**Step 4: Write the code**

**Change `src/auth/access.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/auth/access.ts b/src/auth/access.ts
index 1fa46db..d38a9bd 100644
--- a/src/auth/access.ts
+++ b/src/auth/access.ts
@@ -24,6 +24,8 @@ const SIGN_IN_AGAIN = "Sign in with `tachi login chatgpt` (or /login chatgpt in
 
 function usable(login: SavedLogin): { clientId: string; sub: string; tokens: Tokens } {
   const a = login.active;
+  // A sealed login that cannot be opened (store.ts) waits for a logout before a new sign-in.
+  if (a?.sealed && !a.tokens) throw new LoginError("The saved ChatGPT login cannot be opened. Sign out with `tachi logout chatgpt` (or /logout chatgpt in a session), then sign in again, or choose another lead (--lead, or /lead in a session).");
   if (!a?.tokens) throw new LoginError(`Not signed in to ChatGPT. ${SIGN_IN_AGAIN}`);
   if (!a.planUse) throw new LoginError("This ChatGPT sign-in does not allow using your plan. Sign out with `tachi logout chatgpt` (or /logout chatgpt in a session), sign in again and allow it, or use openai:<model> with an API key.");
   return { clientId: a.clientId, sub: a.sub, tokens: a.tokens };
```

**Change `src/auth/chatgpt.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/auth/chatgpt.ts b/src/auth/chatgpt.ts
index 609d3e3..7a36136 100644
--- a/src/auth/chatgpt.ts
+++ b/src/auth/chatgpt.ts
@@ -28,25 +28,40 @@ export function openBrowser(url: string): void {
   child.unref();
 }
 
-// The words after `login` or `logout`, on the command line or after `/login` in a session; `prefix` is
-// how a command is typed there, for the messages.
-export function loginArgs(words: string[], verb: "login" | "logout", prefix = CLI): { account?: number; fresh?: boolean } {
+// The words after `login` or `logout`, on the command line or after `/login` in a session.
+export interface LoginOptions {
+  account?: number; // which saved account, counted from 1
+  fresh?: boolean; // a new account
+  keychain?: boolean; // seal the tokens with a key kept in the system keychain
+}
+
+// `prefix` is how a command is typed, for the messages.
+export function loginArgs(words: string[], verb: "login" | "logout", prefix = CLI): LoginOptions {
   const [provider, ...rest] = words;
-  const usage = new LoginError(verb === "login" ? `Usage: ${prefix}login chatgpt [--new | --account <number>]` : `Usage: ${prefix}logout chatgpt`);
+  const usage = new LoginError(verb === "login" ? `Usage: ${prefix}login chatgpt [--new | --account <number>] [--keychain]` : `Usage: ${prefix}logout chatgpt`);
   if (provider === undefined) throw usage;
   if (provider.toLowerCase() !== "chatgpt") throw new LoginError(`Only ChatGPT has a ${verb}: \`${prefix}${verb} chatgpt\`. Other providers use an API key.`);
-  if (verb === "logout" && rest.length) throw usage;
-  if (rest.length === 1 && rest[0] === "--new") return { fresh: true };
-  if (rest.length === 2 && rest[0] === "--account" && /^[1-9]\d*$/.test(rest[1]!)) return { account: Number(rest[1]) };
-  if (rest.length) throw usage;
-  return {};
+  if (verb === "logout") {
+    if (rest.length) throw usage;
+    return {};
+  }
+  const opts: LoginOptions = {};
+  for (let i = 0; i < rest.length; i++) {
+    const word = rest[i];
+    const chosen = opts.fresh || opts.account !== undefined;
+    if (word === "--keychain" && !opts.keychain) opts.keychain = true;
+    else if (word === "--new" && !chosen) opts.fresh = true;
+    else if (word === "--account" && !chosen && /^[1-9]\d*$/.test(rest[i + 1] ?? "")) opts.account = Number(rest[++i]);
+    else throw usage;
+  }
+  return opts;
 }
 
 const signedIn = (login: SavedLogin) => (login.active?.tokens ? login.active : undefined);
 const who = (login: SavedLogin, a = signedIn(login)) => login.accounts.find((x) => x.clientId === a?.clientId && x.sub === a?.sub)?.email ?? "your ChatGPT account";
 
 // Which saved account to sign in to: the only one, the one asked for, or a new one.
-function choose(login: SavedLogin, opts: { account?: number; fresh?: boolean }, typed: string): Account | undefined {
+function choose(login: SavedLogin, opts: LoginOptions, typed: string): Account | undefined {
   if (opts.fresh) return undefined;
   if (opts.account !== undefined) {
     const a = login.accounts[opts.account - 1];
@@ -62,16 +77,30 @@ function choose(login: SavedLogin, opts: { account?: number; fresh?: boolean },
   throw new LoginError(`Saved ChatGPT accounts:\n${list}\nChoose one with \`${typed}login chatgpt --account <number>\`, or add another with \`--new\`.`);
 }
 
-export async function signIn(store: LoginStore, io: LoginIO, opts: { account?: number; fresh?: boolean; issuer?: string; signal?: AbortSignal } = {}): Promise<void> {
+export async function signIn(store: LoginStore, io: LoginIO, opts: LoginOptions & { issuer?: string; signal?: AbortSignal } = {}): Promise<void> {
   const typed = io.prefix ?? CLI;
   // Under the lock: check, choose the client ID, and save the machine ID before its first use.
   const start = await store.update(async (login, save) => {
-    if (signedIn(login)) throw new LoginError(`Already signed in as ${who(login)}. Sign out first with \`${typed}logout chatgpt\`.`);
+    if (signedIn(login)) {
+      // Already signed in, `--keychain` on its own seals the tokens with the keychain's key.
+      if (opts.keychain && !opts.fresh && opts.account === undefined) {
+        if (login.keychain) return "already";
+        store.checkKeychain(login, "The login stays in its private file.");
+        save({ ...login, keychain: true });
+        return "now";
+      }
+      throw new LoginError(`Already signed in as ${who(login)}. Sign out first with \`${typed}logout chatgpt\`.`);
+    }
+    // A login that cannot be opened (store.ts) waits for logout, which says that OpenAI was not asked to
+    // cancel it; and one in a keychain that is only locked is not replaced.
+    if (login.active) throw new LoginError(`The saved ChatGPT login cannot be opened. Sign out first with \`${typed}logout chatgpt\`.`);
     const account = choose(login, opts, typed);
     const saved = save(login);
+    if (opts.keychain) store.checkKeychain(saved, "Sign in without --keychain to keep the login in its private file.");
     // An unfinished registration's issued ID is used again, as the docs say after a failed exchange.
     return { account, hostId: saved.hostId, version: saved.version, clientId: account?.clientId ?? login.pending?.clientId ?? FIRST_CLIENT };
   }, opts.signal);
+  if (typeof start === "string") return io.say(`Your ChatGPT login is ${start} sealed with a key kept in the system keychain.`);
 
   // Asked for after that check, so a signed-in user who is offline is still told so.
   const ep = await discover(opts.issuer ?? ISSUER, opts.signal);
@@ -137,14 +166,20 @@ export async function signIn(store: LoginStore, io: LoginIO, opts: { account?: n
     const planUse = tokens.scopes.includes(PLAN_SCOPE);
     const account: Account = { clientId, sub: id.sub, ...(id.email ? { email: id.email } : {}), idToken: t.id_token };
     const others = login.accounts.filter((a) => a.clientId !== clientId || a.sub !== id.sub);
-    // Another account's unfinished registration stays, for the next `--new`.
-    save({ ...login, pending: login.pending?.clientId === clientId ? undefined : login.pending, accounts: [account, ...others], noticeShown: login.noticeShown || planUse, active: { clientId, sub: id.sub, planUse, tokens } });
+    save({
+      ...login,
+      pending: login.pending?.clientId === clientId ? undefined : login.pending, // another account's unfinished registration stays, for the next `--new`
+      accounts: [account, ...others],
+      noticeShown: login.noticeShown || planUse,
+      active: { clientId, sub: id.sub, planUse, tokens },
+      keychain: opts.keychain === true, // chosen at each sign-in
+    });
     return { email: id.email ?? "your ChatGPT account", planUse, notice: planUse && !login.noticeShown };
   }, opts.signal);
 
   if (done.notice) io.say(NOTICE);
   if (done.planUse) io.say(`Signed in as ${done.email}.`);
-  else io.say(`Signed in as ${done.email}, but using your ChatGPT plan was not allowed. To use it, sign out and in again and allow it; or use openai:<model> with an API key.`);
+  else io.say(`Signed in as ${done.email}, but using your ChatGPT plan was not allowed. To use it, sign out with \`${typed}logout chatgpt\`, sign in again and allow it; or use openai:<model> with an API key.`);
 }
 
 // `login chatgpt …` or `logout chatgpt`, typed on the command line, or in a session with `prefix` "/".
@@ -181,7 +216,7 @@ export async function signOut(store: LoginStore, io: LoginIO, opts: { issuer?: s
     } catch (err) {
       problem = opts.signal?.aborted ? "You stopped waiting for its answer." : errorText(err);
     }
-  }
+  } else if (ended.sealed) problem = "The saved login could not be opened, so OpenAI was not asked.";
   io.say(
     problem
       ? `Signed out on this computer, but OpenAI did not confirm that the sign-in was cancelled. ${problem} You can disconnect Tachikoma in ChatGPT's settings.`
```

**Create `src/auth/keychain.ts`:**

```ts
import { createRequire } from "node:module";
import { errorText } from "../core/types.js";

// Loaded only when the keychain is used, so a machine the package has no build for runs everything else.
type Keyring = typeof import("@napi-rs/keyring");
let keyring: Keyring | undefined;

// The operating system's credential store, for `tachi login chatgpt --keychain` (release 2 design,
// "The keychain option"): Windows Credential Manager, the macOS Keychain or the Linux secret service,
// through @napi-rs/keyring 2.1.0. It holds only the key the saved login is sealed with (store.ts),
// which is short enough for one entry everywhere.

// On Linux only the secret service: without this the package falls back to the kernel keyring, which
// "will not persist across reboots" (its README).
const OPTIONS = { linux: { store: "secret-service" as const } };

export class KeychainError extends Error {}

export interface Keychain {
  read(name: string): string | null;
  write(name: string, text: string): void;
  clear(name: string): void;
}

// Each call reports a store that cannot be used as a KeychainError, with the package's reason.
function use<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new KeychainError(`The system keychain could not be used (${errorText(err)}).`);
  }
}

export function systemKeychain(service = "tachikoma"): Keychain {
  // Loading the package can fail too, so it happens inside use().
  const entry = (name: string) => {
    keyring ??= createRequire(import.meta.url)("@napi-rs/keyring") as Keyring;
    return new keyring.Entry(service, name, OPTIONS);
  };
  return {
    read: (name) => use(() => entry(name).getPassword()),
    write: (name, text) => use(() => entry(name).setPassword(text)),
    clear: (name) => void use(() => entry(name).deletePassword()),
  };
}
```

**Change `src/auth/store.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/auth/store.ts b/src/auth/store.ts
index dfcaca3..b5cbe44 100644
--- a/src/auth/store.ts
+++ b/src/auth/store.ts
@@ -1,6 +1,7 @@
-import { randomUUID } from "node:crypto";
+import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
 import path from "node:path";
 import { z } from "zod";
+import { type Keychain, KeychainError, systemKeychain } from "./keychain.js";
 import { withLock } from "./lock.js";
 import type { TokenResponse } from "./oauth.js";
 import { privateDir, readPrivate, writePrivate } from "./private.js";
@@ -40,11 +41,44 @@ const LoginSchema = z.object({
       clientId: z.string(),
       sub: z.string(),
       planUse: z.boolean(), // whether `chatgpt.tokens.use.direct` was granted
-      tokens: TokensSchema.optional(), // gone once signed out
+      tokens: TokensSchema.optional(), // missing on disk when sealed; after a read, missing only when the seal could not be opened
+      sealed: z.string().optional(), // with `keychain`: the tokens, sealed with the keychain's key
     })
     .optional(),
+  // The tokens are sealed with a key kept in the system keychain.
+  keychain: z.boolean().optional(),
 });
 
+// The key's name in the keychain, by the data folder's machine ID, so data folders made apart never
+// share one (a copied folder shares its original's).
+const keyName = (login: SavedLogin) => `chatgpt.${login.hostId}`;
+
+// AES-256-GCM: a 32-byte key (FIPS 197) and a new random 12-byte nonce for each seal, the size NIST
+// SP 800-38D (section 8.2) recommends, with GCM's full 16-byte tag. Sealed: nonce, tag, then text.
+const KEY_BYTES = 32;
+const NONCE_BYTES = 12;
+const TAG_BYTES = 16;
+
+function seal(key: string, tokens: Tokens): string {
+  const nonce = randomBytes(NONCE_BYTES);
+  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), nonce, { authTagLength: TAG_BYTES });
+  const text = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
+  return Buffer.concat([nonce, cipher.getAuthTag(), text]).toString("base64");
+}
+
+// The tokens, or undefined for another key or a changed file.
+function unseal(key: string, sealed: string): Tokens | undefined {
+  try {
+    const raw = Buffer.from(sealed, "base64");
+    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "base64"), raw.subarray(0, NONCE_BYTES), { authTagLength: TAG_BYTES });
+    decipher.setAuthTag(raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
+    const text = Buffer.concat([decipher.update(raw.subarray(NONCE_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
+    return TokensSchema.parse(JSON.parse(text));
+  } catch {
+    return undefined;
+  }
+}
+
 export type Tokens = z.infer<typeof TokensSchema>;
 export type Account = z.infer<typeof AccountSchema>;
 export type SavedLogin = z.infer<typeof LoginSchema>;
@@ -65,10 +99,16 @@ export function tokensFrom(t: TokenResponse): Tokens {
 export class LoginStore {
   readonly file: string;
   readonly lockFile: string;
+  // The key last read or made, and the version of the login it went with. It lasts from that read (or
+  // the check before a sign-in's browser opens) to the save that follows, so the keychain is not asked
+  // again once OpenAI has issued tokens, and one locked by then loses none. Any read of another
+  // version, such as one saved since, drops it.
+  #key: { name: string; key: string; version: number } | undefined;
 
   constructor(
     dir: string,
     private readonly warn: (message: string) => void = (m) => console.error(m),
+    private readonly keychain: Keychain = systemKeychain(),
   ) {
     this.file = path.join(dir, "chatgpt.json");
     this.lockFile = path.join(dir, "chatgpt.lock");
@@ -85,7 +125,73 @@ export class LoginStore {
       parsed = undefined;
     }
     if (!parsed?.success) throw new LoginError(`The saved login in ${this.file} is damaged. Move it aside, then sign in again with \`tachi login chatgpt\` (or /login chatgpt in a session).`);
-    return parsed.data;
+    const login = parsed.data;
+    if (this.#key?.version !== login.version) this.#key = undefined;
+    const active = login.active;
+    if (!active?.sealed) return login;
+    // Sealed with the keychain's key. No key, another key, a changed file or a keychain that cannot be
+    // used: kept without tokens, so it is not used. Sign-in waits for logout, which says that OpenAI was
+    // not asked to cancel it.
+    let why = "The key in the system keychain is missing or does not fit.";
+    let tokens: Tokens | undefined;
+    try {
+      const name = keyName(login);
+      const key = this.keychain.read(name);
+      tokens = key === null ? undefined : unseal(key, active.sealed);
+      if (key !== null && tokens) this.#key = { name, key, version: login.version };
+    } catch (err) {
+      if (!(err instanceof KeychainError)) throw err;
+      why = err.message;
+    }
+    const { sealed: _, ...rest } = active;
+    if (tokens) return { ...login, active: { ...rest, tokens } };
+    this.warn(why); // each caller says what to do
+    return login;
+  }
+
+  // For `--keychain`, before the browser opens: the key is read or made now, so a keychain that cannot
+  // be used is found first. `instead` says what the user can do then. A key made for a sign-in that is
+  // then cancelled stays, opening nothing, for the next one.
+  checkKeychain(login: SavedLogin, instead: string): void {
+    try {
+      this.#keyFor(login);
+    } catch (err) {
+      if (err instanceof KeychainError) throw new LoginError(`${err.message} ${instead}`);
+      throw err;
+    }
+  }
+
+  // The data folder's key. It is made once and goes into the keychain before anything is sealed with
+  // it, so the file, written whole, never refers to a key that is not there yet.
+  #keyFor(login: SavedLogin): string {
+    const name = keyName(login);
+    if (this.#key?.name === name) return this.#key.key;
+    let key = this.keychain.read(name);
+    if (key === null || Buffer.from(key, "base64").length !== KEY_BYTES) {
+      key = randomBytes(KEY_BYTES).toString("base64");
+      this.keychain.write(name, key);
+    }
+    this.#key = { name, key, version: login.version };
+    return key;
+  }
+
+  // Writes the whole login. With the keychain, the tokens are sealed with its key.
+  #write(login: SavedLogin): void {
+    let onDisk = login;
+    const active = login.active;
+    if (login.keychain && active?.tokens) {
+      const { tokens, ...rest } = active;
+      onDisk = { ...login, active: { ...rest, sealed: seal(this.#keyFor(login), tokens) } };
+    }
+    writePrivate(this.file, `${JSON.stringify(onDisk, null, 2)}\n`);
+    if (login.keychain && !active) {
+      // Signed out: the key goes too. A keychain that cannot be used keeps it, opening nothing.
+      try {
+        this.keychain.clear(keyName(login));
+      } catch (err) {
+        if (!(err instanceof KeychainError)) throw err;
+      }
+    }
   }
 
   // Runs `fn` holding the lock, with the login read after the lock was taken. Each `save` raises the
@@ -100,7 +206,7 @@ export class LoginStore {
         let version = current.version;
         const save = (next: SavedLogin) => {
           const saved = { ...next, version: ++version };
-          writePrivate(this.file, `${JSON.stringify(saved, null, 2)}\n`);
+          this.#write(saved);
           return saved;
         };
         return fn(current, save);
```

**Change `src/cli.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/cli.tsx b/src/cli.tsx
index 8e6a2aa..9dc0dc3 100644
--- a/src/cli.tsx
+++ b/src/cli.tsx
@@ -26,7 +26,8 @@ const HELP = `tachi: a coding agent for your terminal
 Usage:
   tachi --lead <provider:model> [options]            interactive session
   tachi --lead <provider:model> -p "<prompt>"        run one prompt, print the answer, exit
-  tachi login chatgpt [--new | --account <number>]   sign in to use your ChatGPT plan
+  tachi login chatgpt [--new | --account <number>]   sign in to use your ChatGPT plan;
+                      [--keychain]                   --keychain seals the tokens with a key in the keychain
   tachi logout chatgpt                               sign out of ChatGPT
 
 Options:
```


**Step 5: Run everything**

Run: `npm run typecheck`, then `npm test`

Expected: no type errors; Test Files 26 passed | 2 skipped (28); Tests 412 passed | 5 skipped (417).

**Step 6: Commit**

```bash
git add package-lock.json package.json src/auth/access.ts src/auth/chatgpt.ts src/auth/keychain.ts src/auth/store.ts src/cli.tsx tests/auth/chatgpt.test.ts tests/auth/keychain.test.ts tests/providers/models.test.ts
git commit -m "feat: tachi login chatgpt --keychain keeps the login in the system keychain"
```

### Task 14: README, and a live tool round on the plan

The README gets release 2: the ChatGPT plan, the hardening, `/model`, the status line, and the new
known limits. The live check adds a full tool round on the plan: the call, its result and the model's
next reply, with the tools grouped as the docs require. It also prints the token counts the plan
reports. This uses the plan's limit, so it runs only when given a model.

**Files:**
- Modify: `README.md`
- Modify: `tests/live/chatgpt.live.test.ts`

**Step 1: Write the checks**

**Change `tests/live/chatgpt.live.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/live/chatgpt.live.test.ts b/tests/live/chatgpt.live.test.ts
index 7d1662b..5d16541 100644
--- a/tests/live/chatgpt.live.test.ts
+++ b/tests/live/chatgpt.live.test.ts
@@ -1,6 +1,12 @@
+import { writeFile } from "node:fs/promises";
+import path from "node:path";
 import { describe, expect, it } from "vitest";
 import { LoginStore } from "../../src/auth/store.js";
 import { dataDir } from "../../src/core/datadir.js";
+import { Session } from "../../src/core/session.js";
+import { createProvider } from "../../src/providers/registry.js";
+import { TOOLS } from "../../src/tools/index.js";
+import { Bus, collectErrors, tempContext, texts } from "../helpers.js";
 
 // The first real sign-in's checks (release 2 design, "Still to measure"). Run within an hour of
 // `tachi login chatgpt`, before the login needs renewing:
@@ -34,3 +40,23 @@ describe.skipIf(!process.env.TACHI_LIVE)("first real ChatGPT sign-in", () => {
     }
   }, 60_000);
 });
+
+// A full tool round on the plan: the call, its result and the model's next reply, with the tools
+// grouped as the docs require. This uses the plan's limit. For example (-t leaves out the check
+// above, which needs a sign-in less than an hour old):
+//   TACHI_LIVE=1 TACHI_LIVE_CHATGPT=gpt-6.1-sol npm test -- tests/live/chatgpt -t "plan leading"
+const model = process.env.TACHI_LIVE_CHATGPT;
+describe.skipIf(!process.env.TACHI_LIVE || !model)("a ChatGPT plan leading", () => {
+  it("reads a file with a tool, and reports the token counts it was given", async () => {
+    const ctx = await tempContext("never");
+    await writeFile(path.join(ctx.root, "secret.txt"), "the word is pelican", "utf8");
+    const bus = new Bus();
+    const errors = collectErrors(bus);
+    bus.on("usage", (u) => console.log(`usage: ${JSON.stringify(u.usage)}`));
+    const session = new Session({ lead: createProvider(`chatgpt:${model}`), tools: TOOLS, system: "You are a test assistant.", ctx, bus });
+    await session.send("Read secret.txt and tell me the word in it.");
+    expect(errors).toEqual([]);
+    expect(session.messages.some((m) => m.parts.some((p) => p.type === "tool_result" && !p.isError))).toBe(true);
+    expect(texts(session.messages.at(-1)!).join(" ").toLowerCase()).toContain("pelican");
+  }, 120_000);
+});
```


**Step 2: Update the README**

**Change `README.md`** (apply with `git apply`, or by hand):

````diff
diff --git a/README.md b/README.md
index 23b7ecc..8791597 100644
--- a/README.md
+++ b/README.md
@@ -5,13 +5,16 @@ providers can lead a session. Later releases add handing work to other models an
 `codex` and `kimi` command-line tools, long-term memory, search of the codebase by meaning, a Docker
 sandbox, and lessons learned from its own error log.
 
-This is release 1 of 9: the core. The command is `tachi`.
+This is release 2 of 9: the core, and signing in with ChatGPT. The command is `tachi`.
 
-## What release 1 does
+## What it does
 
-- **Five providers, any of them can lead:** Anthropic, OpenAI, OpenRouter, Kimi (Moonshot) and a
-  local Ollama. `/lead <provider:model>` switches the lead in the middle of a session, and the
-  conversation carries over.
+- **Six ways to lead, any of them can take over:** Anthropic, your ChatGPT plan, OpenAI, OpenRouter,
+  Kimi (Moonshot) and a local Ollama. `/lead <provider:model>` switches the lead in the middle of a
+  session, and the conversation carries over. `/model` lists the models of every provider that is
+  set up, to pick one with the arrow keys.
+- **Sign in with ChatGPT** (release 2): an OpenAI model can lead on your ChatGPT plan instead of an
+  API key. See [Using your ChatGPT plan](#using-your-chatgpt-plan).
 - **File and shell tools:** read, write and edit files, and run shell commands (PowerShell on
   Windows, `/bin/sh` elsewhere). Files are read with numbered lines, 2,000 lines at a time, as
   Claude Code does. The project is the folder you start `tachi` in. Each action goes through a
@@ -22,9 +25,13 @@ This is release 1 of 9: the core. The command is `tachi`.
   - `project`: writes inside the project without asking; asks before shell commands and anything
     outside the project.
   - `never`: never asks. It is meant for the Docker sandbox, which arrives in release 3. Without the
-    sandbox it means no checks at all.
-- **A terminal interface** with a status line showing the lead, context use, tokens, cost, mode and
-  error count. `--status` picks which parts to show.
+    sandbox it means no checks at all, apart from keeping the keys and the data folder from the
+    tools.
+- **Your keys and login are kept from the model's tools, against accidents:** shell commands do not
+  get the API keys, and the file tools refuse Tachikoma's own data folder, where the ChatGPT login
+  is kept. A shell command can still read the login; see [Known limits](#known-limits).
+- **A terminal interface** with a status line showing the lead, how much of the context window is
+  left, tokens, cost (or "ChatGPT plan"), mode and error count. `--status` picks which parts to show.
 - **Headless runs:** `-p "<prompt>"` runs one prompt, prints the answer and exits. Add `--json` to
   get every event as one JSON line. Details below.
 - **An error log:** every failure, and every refusal another model answered, is written to
@@ -55,17 +62,23 @@ One example per provider:
 
 ```bash
 node dist/cli.js --lead anthropic:claude-opus-5-5
+node dist/cli.js --lead chatgpt:<model>
 node dist/cli.js --lead openai:<model>
 node dist/cli.js --lead openrouter:<model>
 node dist/cli.js --lead kimi:<model>
 node dist/cli.js --lead ollama:qwen3:8b
 ```
 
-Other options, from `node dist/cli.js --help`:
+Other commands and options, from `node dist/cli.js --help`:
 
 ```
---lead <spec>     anthropic:<model> | openai:<model> | openrouter:<model> | kimi:<model> | ollama:<model>
-                  (or set TACHI_LEAD)
+tachi login chatgpt [--new | --account <number>]   sign in to use your ChatGPT plan;
+                    [--keychain]                   --keychain seals the tokens with a key in the keychain
+tachi logout chatgpt                               sign out of ChatGPT
+
+--lead <spec>     anthropic:<model> | chatgpt:<model> | openai:<model> | openrouter:<model>
+                  | kimi:<model> | ollama:<model> (or set TACHI_LEAD)
+                  chatgpt: uses your ChatGPT plan; openai: uses OPENAI_API_KEY
 --mode <mode>     when to ask before acting: ask | project | never (default: ask)
 --effort <level>  Anthropic models only: low | medium | high | xhigh | max
 --fallback <spec> retry a turn the lead refuses on this model, e.g. openai:<model> (off unless set)
@@ -76,8 +89,46 @@ Other options, from `node dist/cli.js --help`:
 -h, --help        show this help
 ```
 
-In a session, `/lead <provider:model>` switches the lead model, `/errors` summarises the error log
-and `/exit` quits. Ctrl-C stops the current turn, or quits when idle.
+In a session, `/lead <provider:model>` switches the lead model, `/model` picks it from a list,
+`/login chatgpt` and `/logout chatgpt` sign in and out, `/errors` summarises the error log and
+`/exit` quits; commands ignore case. Ctrl-C stops the current turn, or quits when idle.
+
+## Using your ChatGPT plan
+
+Tachikoma uses OpenAI's Sign in with ChatGPT for open-source tools. Eligible ChatGPT plans can lead
+a session with an OpenAI model, billed to the plan instead of an API key.
+
+1. `tachi login chatgpt` prints "Continue with ChatGPT in your browser" and opens your browser. If
+   no browser opens, it prints a local address to open by hand. Approve Tachikoma there. The first
+   time, it shows OpenAI's notice that the app now uses your ChatGPT plan.
+2. `tachi --lead chatgpt:<model>` (or `/lead chatgpt:<model>`) leads with that model. A model your
+   account does not offer is refused at the first message, with a list of the ones it does; `/model`
+   shows them too.
+3. `tachi logout chatgpt` signs out. It deletes the tokens from your computer, keeping the list of
+   saved accounts (without their ID tokens), then asks OpenAI to cancel the sign-in, and says so if
+   OpenAI cannot confirm. It also cancels a sign-in still waiting in the browser.
+
+- **`chatgpt:` always bills the plan and `openai:` always uses `OPENAI_API_KEY`.** Tachikoma never
+  switches between them. When the plan's limit runs out, the turn stops with a link to
+  https://chatgpt.com/settings/usage; it does not move to the API key.
+- **The status line** shows "ChatGPT plan" where the cost would be, plus anything other leads in the
+  session cost.
+- **One account at a time.** After `tachi logout chatgpt`, `tachi login chatgpt --new` adds another
+  account. With several saved, `tachi login chatgpt` lists them, and `--account <number>` picks one.
+- **The login is a private file** in Tachikoma's data folder (`%LOCALAPPDATA%\tachikoma` on Windows,
+  `~/Library/Application Support/tachikoma` on macOS, `~/.local/share/tachikoma` on Linux). Only you
+  can read it: on Windows Tachikoma sets a permission for you alone, since the profile folder also
+  lets in administrators. With `--keychain`, the tokens in it are also encrypted, with a key kept in
+  the system keychain (Windows Credential Manager, the macOS Keychain or the Linux secret service).
+  The list of saved accounts is not: each one's email, and the ID token Tachikoma sends back to
+  OpenAI to skip its account picker. An ID token does not let anyone use your plan.
+  If you are already signed in, `tachi login chatgpt --keychain` seals the current login without
+  signing in again. If the key is missing or does not fit, or the keychain cannot be used, the login
+  is not used: sign out with `tachi logout chatgpt` (OpenAI is then not asked to cancel it; you can
+  disconnect Tachikoma in ChatGPT's settings), then sign in again. To stop using the keychain, sign
+  out and in again without it.
+- **Several Tachikomas at once** take turns to change the login, so one does not undo another's
+  renewal, apart from the cases under [Known limits](#known-limits).
 
 ## Headless runs
 
@@ -103,21 +154,48 @@ the permission mode would ask about is refused, and the model is told so.
 
 | Provider | `--lead` prefix | Environment variable |
 |---|---|---|
-| Anthropic | `anthropic:` | `ANTHROPIC_API_KEY` (an API key only; Tachikoma never signs in with a subscription) |
+| Anthropic | `anthropic:` | `ANTHROPIC_API_KEY` (an API key only; Tachikoma never signs in with a Claude subscription) |
+| ChatGPT plan | `chatgpt:` | none; `tachi login chatgpt` |
 | OpenAI | `openai:` | `OPENAI_API_KEY` |
 | OpenRouter | `openrouter:` | `OPENROUTER_API_KEY` |
 | Kimi (Moonshot) | `kimi:` | `MOONSHOT_API_KEY` |
 | Ollama | `ollama:` | none; it talks to `http://localhost:11434` |
 
-Costs are shown only for models with a known price. Others show `?`; Ollama counts as free.
+Costs are shown only for models with a known price. Others show `?`; Ollama counts as free, and a
+ChatGPT plan shows as "ChatGPT plan".
+
+Shell commands never see these API keys, so a command cannot print one back to the model. A command
+that needs one of them does not get it either.
 
 The Anthropic SDK still adds any headers you set in `ANTHROPIC_CUSTOM_HEADERS`, so do not put an
 `Authorization` header there.
 
-## Known limits of release 1
-
-Each is fixed in a later release.
-
+## Known limits
+
+Each is fixed in a later release, unless it says otherwise.
+
+- **An approved shell command can still read your login.** Commands on your own machine run with your
+  own access, so one you approve can read files and the system keychain. Keeping keys from commands
+  and the data folder from the file tools prevents accidents, not a determined command. The sandbox
+  (release 3) keeps commands away from the login.
+- **On a ChatGPT plan, `--effort` does nothing yet.** Whether the plan accepts a reasoning setting is
+  still to be measured, and no release is set for it yet.
+- **The context left is shown only for models whose window is known:** Anthropic models, and
+  ChatGPT-plan models (from the account's model list, once the first reply arrives). Other models
+  show the tokens in use; no release is set for them yet.
+- **If a Tachikoma is killed while changing the login,** a renewal it had already sent can be lost,
+  and you sign in again. So is a renewal that cannot be saved, such as when another program holds
+  the login file for over a second or the disk is full; Tachikoma then says to sign out and in again.
+  The next Tachikoma takes over a killed one's lock, within 5 seconds if it was already waiting. If
+  another program now has the killed one's process number, the next one waits until the computer
+  restarts, and names the lock file to delete. If two take the lock over at the same moment, or the
+  clock jumps forward while one holds it, a renewal can also be lost (none of this is planned to
+  change).
+- **On a ChatGPT plan, a failed request is not tried again.** OpenAI asks for "bounded backoff" but
+  gives no numbers, so Tachikoma reports the error and keeps your sign-in; no release is set for it
+  yet.
+- **A reply already streaming when you sign out** finishes. The next request is refused (not planned
+  to change).
 - **The history is never shortened** (release 4). When the context window is full, the turn ends
   with an error. Switching `/lead` to a model with a smaller window can make the next request fail.
 - **No budget limit** (release 7). An interactive session runs until you stop it.
@@ -138,9 +216,10 @@ Each is fixed in a later release.
 
 ## What comes next
 
-1. Core (this release): the agent loop, local file and shell tools, Anthropic and OpenAI-format
-   providers with lead switching, the terminal interface with status line, the error log.
-2. Sign in with ChatGPT, so an OpenAI model can lead on your ChatGPT plan instead of an API key.
+1. Core (done): the agent loop, local file and shell tools, Anthropic and OpenAI-format providers
+   with lead switching, the terminal interface with status line, the error log.
+2. Sign in with ChatGPT (this release), so an OpenAI model can lead on your ChatGPT plan instead of
+   an API key; the `/model` picker.
 3. Docker sandbox, in two modes (a live link to your folder, or a copy you review before it is
    applied).
 4. MCP tools and long-term memory (MemPalace); transcripts saved to disk; shortening the history.
````


**Step 3: Run everything**

Run: `npm run typecheck`, then `npm test`

Expected: no type errors; Test Files 26 passed | 2 skipped (28); Tests 412 passed | 6 skipped (418).

**Step 4: Commit**

```bash
git add README.md tests/live/chatgpt.live.test.ts
git commit -m "docs: README for release 2; test: live tool round on a ChatGPT plan"
```

**Step 5: The second live check (the user, in their own terminal)**

```bash
TACHI_LIVE=1 TACHI_LIVE_CHATGPT=<a model from the list> npm test -- tests/live/chatgpt -t "plan leading"
TACHI_LIVE=1 TACHI_LIVE_LEADS=anthropic:claude-opus-5-5,chatgpt:<model> npm test -- tests/live/providers
```

The second command repeats release 1's checks with ChatGPT in the mix, including switching the lead
mid-conversation. Record in the main design's "Still to measure" (item 16): whether the tool round
worked, whether the replies carried token counts, and the date. A reasoning-effort setting stays
untried until someone asks for it on ChatGPT; until then `--effort` stays Anthropic-only.
