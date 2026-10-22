# Tachikoma release 2: Sign in with ChatGPT, design (2026-10-22)

Release 2 of Tachikoma. The overall design, the Decisions table and the release order are in
[2026-10-22-tachikoma-design.md](2026-10-22-tachikoma-design.md).

OpenAI's Sign in with ChatGPT for open-source tools lets an OpenAI model lead on the user's ChatGPT
plan instead of an API key. Sources, all read on 2026-10-22:
- **The flow's docs:** developers.openai.com/siwc/token-sharing-open-source and its pages: sign-in,
  accounts and sessions, models and inference, token reference, errors and recovery, preview
  limitations.
- **OpenAI's interface guidelines:** developers.openai.com/siwc/ui-ux-guidelines.
- **The terms:** openai.com/policies/sign-in-with-chatgpt-terms, dated 2026-09-29.

OpenAI's example code (github.com/openai/sign-in-with-chatgpt-devkit) is under a non-commercial
licence. Tachikoma's version is written from the docs and copies none of it.

**Using it**
- **Choosing it.** `--lead chatgpt:<model>` or `/lead chatgpt:<model>` bills the plan, and
  `openai:<model>` always uses `OPENAI_API_KEY`. Tachikoma never picks between them by itself, so it
  is always clear which bill a request goes to.
- **Signing in and out.** `tachi login chatgpt` or `/login chatgpt` signs in; `tachi logout chatgpt`
  or `/logout chatgpt` signs out. Tachikoma never opens a browser by itself: a `chatgpt:` lead while
  signed out is an error that names the command.
- **What sign-in shows.** It prints "Continue with ChatGPT in your browser", the wording OpenAI's
  guidelines use. If no browser opens, it prints the address to open by hand. When it works, it says
  "Signed in as <email>."
- **The first sign-in ever** also shows OpenAI's one-time notice, as the guidelines ask: "You're using
  your ChatGPT plan. Eligible usage in this app uses your ChatGPT plan. Manage usage:
  https://chatgpt.com/settings/usage".
- **One account at a time.** Signing in while already signed in says so, and names the logout command.
  Each account's record is kept separately and is never overwritten by another's. Signing in again
  to a known account reuses the client ID OpenAI issued for it. OpenAI skips its account picker only
  when Tachikoma sends the account's saved ID token, and logout deletes that token, so after a logout
  the picker shows again (sign-in page).
- **A model name the account does not offer** is an error that lists the models it does, from the
  account's own model list.
- **The status line** shows `chatgpt:<model>` as the lead, and "ChatGPT plan" where the cost would
  be. The guidelines ask apps to show that the plan is in use, and per-token prices do not apply.
- **When the plan's limit runs out,** the turn stops with "ChatGPT usage limit reached. Review your
  plan or this app's limit: https://chatgpt.com/settings/usage", and the error is logged.
  - Tachikoma never moves the request to an API key. OpenAI's own route never switches billing either
    (errors and recovery page).
  - `--fallback` stays for refusals only.
- **Signing out while ChatGPT leads.** The next message says to sign in again or switch with `/lead`.
- **Headless runs.** `-p` works once signed in.
- **Unattended use.** The terms say: "Obtain express consent before background use." So release 8's
  loops must ask before they use the plan.

**Signing in**
1. **Machine ID.** On the first sign-in, Tachikoma makes a random ID for this machine (a `urn:uuid:`)
   and saves it. The docs require a fixed ID per machine that says nothing about the user. It is not
   a secret.
2. **The listener.** A listener starts on `127.0.0.1`, on any free port, at `/auth/callback`. The
   docs require exactly that address form; `localhost` is not allowed.
3. **The browser** opens OpenAI's authorize page with:
   - the name "Tachikoma", sent on the first registration only;
   - the scopes for plan use;
   - a PKCE check value (S256), a fresh `state` and a fresh `nonce`.
4. **Checking the reply.** The reply must carry this attempt's `state`. The client ID OpenAI issues
   is saved before the code is exchanged, as the docs advise, but only as a pending record; it
   becomes the active login when sign-in finishes. When signing in again to a known account, a reply
   with a different client ID is refused. The exchange uses this attempt's exact callback address
   and PKCE value, and each reply is used only once.
5. **Checking the ID token:** its signature against OpenAI's published keys, then the issuer, the
   audience (the issued client ID), the expiry and the nonce.
6. **Plan use.** If the granted scopes lack `chatgpt.tokens.use.direct`, Tachikoma says plan use was
   not allowed. The account's checked record is kept, but no request is sent on the plan. The docs
   say a valid ID token alone does not allow plan use.
7. **No time limit.** The listener waits until the user finishes in the browser or presses Ctrl-C.

The registration and returning-sign-in checks follow OpenAI's
[sign-in documentation](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).

**The saved login** is `<data folder>/chatgpt.json`.
- **Contents:**
  - the machine ID;
  - one record per account, keyed by the client ID OpenAI issued and the account's checked identity
    (the ID token's `sub`), with a name to show the user. The email is shown but never used as the
    key, because two records can have the same email (accounts and sessions page);
  - the tokens, granted scopes and expiry for the account that is signed in.
- **Written whole.** It is written to a new file in the same folder and then swapped in, so it is
  never left half-written.
- **Private from the start.** The file, its temporary copies and the folder are created private:
  mode 600 and 700 on macOS and Linux. On Windows, Tachikoma sets a permission that lets in only the
  user, and checks it, because by default the profile folder also lets in Administrators and the
  system account. A link in place of the file, or a file owned by someone else, is refused. A file
  found readable by others is made private before it is used, and the user is told. If that fails,
  Tachikoma stops rather than use the login.
- **Like Claude Code and Codex.** Claude Code keeps its login this way on Linux and Windows
  (code.claude.com/docs/en/authentication, "Credential management"). Codex keeps `~/.codex/auth.json`
  and says to "treat `~/.codex/auth.json` like a password" (learn.chatgpt.com/docs/auth). The
  explicit Windows permission goes further than either.
- **The keychain option.** `tachi login chatgpt --keychain` puts the tokens in the operating system's
  credential store: Windows Credential Manager, the macOS Keychain or the Linux secret service. The
  rest of the record stays in the file. The add-on package is chosen while planning, after checking
  that it is maintained and how old its release is, and it is installed through `sfw`.
- **Never shown.** Tokens never appear in the error log, in `--json` output or in any address.
  Nor do the sign-in reply's address, the sign-in code, the PKCE value or any header carrying a
  login: they are blanked before anything reaches events, transcripts, lessons or memory. The page
  the browser lands on after sign-in loads nothing from other sites, and the listener closes when
  sign-in finishes or is cancelled.

**Renewing**
- **Lifetimes.** A login lasts 1 hour, and each renewal is good for a further 30 days (token
  reference).
- **When.** Tachikoma renews before a request when less than 60 seconds are left, as OpenAI's example
  code does. It never renews before the `earliest_refresh_at` time OpenAI sends.
- **One change to the login at a time.** Signing in, renewing, signing out and moving between the
  file and the keychain all take one lock, shared by every Tachikoma process. The docs ask for
  renewals to be taken one at a time (accounts and sessions page).
  - After taking the lock, each reads the saved login again before changing anything.
  - The saved login carries a version number that goes up with every change.
  - The browser part of signing in does not hold the lock, since the user can take as long as they
    like. When it finishes, its result is refused if the version changed in the meantime, for
    example because of a logout.
  - Renewal holds the lock until the new login is saved. Each renewal replaces the renewal token, so
    no other process can be left using the old one.
  - The file and the keychain carry the same version number. If they disagree, that is a login
    error, and Tachikoma never falls back to the older login.
- **When renewal fails.** If the login is expired or cancelled, the user is told to sign in again. If
  the network failed, the login is kept and the error is reported.

**Signing out**
- Under the lock, Tachikoma marks the login signed out and raises its version number. Then it
  cancels the renewal token with OpenAI and deletes all the tokens from the file and the keychain.
- Every request and every renewal checks the version first, so nothing new starts after a logout.
  A request already sent before the logout still finishes, and its usage cannot be taken back.
- If OpenAI cannot be reached, the tokens are still deleted, and the user is told that the
  cancellation was not confirmed.
- The machine ID and the account's client ID are kept, as the docs say to.

Identity separation, renewal and revocation follow OpenAI's
[accounts and sessions documentation](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

**Requests** go to the Responses API at `https://api.openai.com/v1/responses`, through a new adapter,
`src/providers/chatgpt.ts`.
- **The client.** It uses the `openai` package Tachikoma already has; version 7.30.0 types every field
  needed. The login is passed as a function, so a renewed login is picked up without restarting
  anything.
- **Every request**:
  - is streamed and not stored (`stream: true`, `store: false`), as the route requires;
  - carries the whole conversation, since nothing is kept at OpenAI;
  - puts Tachikoma's instructions in `instructions`, because system messages are refused;
  - sends none of the fields the route refuses, such as `temperature` or `max_output_tokens`.
- **The conversation:**
  - Text, tool calls (`function_call` with its `call_id`) and tool results (`function_call_output`)
    are converted both ways.
  - OpenAI's encrypted reasoning items must go back with tool results. They are kept with the
    message, as Anthropic's thinking is, and are taken from each item's finished form in the stream.
    They are sent back only while ChatGPT leads.
  - Tools are sent grouped in a namespace or through `additional_tools`, as OpenAI's
    [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
    page requires, not in the Chat Completions form. Tool names in a reply are mapped back to
    Tachikoma's tools, and an unknown name is refused.
- **A reply counts as finished only on `response.completed`.** A failed reply, a cut-off reply or a
  dropped stream is an error, as with every other provider.
- **Token counts** are read from the completed reply.

**Context window.** The status line can show how much is left only if the window size is known.
- **First: the model list's own figure.** Codex reads `context_window` from each entry of OpenAI's
  model list (github.com/openai/codex, `codex-rs/protocol/src/openai_models.rs`, read 2026-10-22).
  The sign-in docs describe the same list, with the same field names for the ones they mention.
- **Otherwise: OpenAI's model pages.** These give the API's window: GPT-6.1 Sol, for example, has 1.05M
  tokens (developers.openai.com/api/docs/models/gpt-6.1-sol, 2026-10-22). The figures go in a small
  dated table with their sources, like the price table.
- **The plan's window may be smaller.** No page says the plan gets the same window as the API, and
  Codex assumes 272,000 tokens for a model it does not know. If OpenAI rejects a request as too long,
  Tachikoma says so plainly.

**Errors** follow the errors and recovery page.
- **No automatic retries.** The SDK's own retries are off, as in OpenAI's example code, because
  retrying a usage limit only hits it again.
- **The usage limit** (`subscription_sharing_usage_limit_exceeded`) gives the message above. It can
  arrive part way through a stream.
- **Not eligible, or plan use not allowed:** Tachikoma says why, and suggests `openai:` with an API key.
- **A login OpenAI rejects:** "Sign in again with `tachi login chatgpt`."
- **Service unavailable:** the error is reported and the login is kept. OpenAI asks for "bounded
  backoff" but gives no numbers, so Tachikoma does not retry by itself.

**Hardening for every provider**, added in release 2 because the saved login makes it matter more.
These steps prevent accidents, not a determined command: a shell command the user approves on the
host still runs with the user's own access. The sandbox (release 3) keeps workspace commands away
from the host's login files, as long as those files are not mounted into it.
- **The file tools refuse Tachikoma's data folder** in every permission mode, `never` included. Shell
  commands cannot be policed that way until the sandbox.
- **Shell commands do not get the API keys:** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `OPENROUTER_API_KEY` and `MOONSHOT_API_KEY`. In release 1, `src/exec/local.ts` passes its whole
  environment to every command, so a command could print a key back to the model. The cost: a command
  that genuinely needs one of these keys does not see it.
- **Every program Tachikoma starts is filtered the same way,** local MCP servers and workers
  included. A provider's CLI gets only the key it needs. Tachikoma's data folder and other tools'
  login folders are never mounted into a workspace container.
- **Links cannot get round the data-folder rule:** a path is resolved to its real location before
  the file tools check it.
- **What filtering cannot do:** an approved shell command on the host can still read files and the
  operating system's credential store.

**The model picker (`/model`).**
- **The list.** It opens a list moved through with the arrow keys: Enter picks, Esc closes, and typing
  filters, since OpenRouter alone lists hundreds of models. The current lead is marked.
- **What it shows,** grouped by provider: ChatGPT when signed in, each provider whose API key is set,
  and Ollama when it is running. All are asked at once, each at its own model-list address, which is
  checked against that provider's docs while planning.
- **A provider that fails** is shown with the reason, such as "not running" or "key rejected", rather
  than hidden.
- **Picking** a model does the same as `/lead <provider:model>`.
- **No new package.** It is built with Ink's own keyboard input.

**Order of building.** The first real sign-in comes straight after the sign-in code, before the
adapter. The docs do not say whether a new open-source app needs OpenAI's approval or listing before
its users can sign in. If it does, that shows up before anything else is built. Signing in and reading
the model list use none of the plan's limit.

**Still to measure for release 2.** These are checked on the user's own Plus account:
- whether a new, unlisted app can sign in;
- whether the model list includes `context_window`;
- a full tool round with the tools grouped as the docs require: the call, its result and the
  model's next reply;
- whether completed replies carry token counts;
- whether a reasoning-effort setting is accepted. Until then, `--effort` stays Anthropic-only.
