# Tachikoma

Tachikoma is a coding-agent harness written from scratch in TypeScript. Any of several model
providers can lead a session. Later releases add handing work to other models and to the `claude`,
`codex` and `kimi` command-line tools, long-term memory, search of the codebase by meaning, a Docker
sandbox, and lessons learned from its own error log.

This is release 2 of 13: the core, and signing in with ChatGPT. The command is `tachi`.

## What it does

- **Six ways to lead, any of them can take over:** Anthropic, your ChatGPT plan, OpenAI, OpenRouter,
  Kimi (Moonshot) and a local Ollama. `/lead <provider:model>` switches the lead in the middle of a
  session, and the conversation carries over. `/model` lists the models of every provider that is
  set up, to pick one with the arrow keys.
- **Sign in with ChatGPT** (release 2): an OpenAI model can lead on your ChatGPT plan instead of an
  API key. See [Using your ChatGPT plan](#using-your-chatgpt-plan).
- **File and shell tools:** read, write and edit files, and run shell commands (PowerShell on
  Windows, `/bin/sh` elsewhere). Files are read with numbered lines, 2,000 lines at a time, as
  Claude Code does. The project is the folder you start `tachi` in. Each action goes through a
  permission mode, set with `--mode`; when it asks about a write or an edit, it shows what will go
  into the file first:
  - `ask` (the default): asks before every write and shell command, and before anything outside the
    project.
  - `project`: writes inside the project without asking; asks before shell commands and anything
    outside the project.
  - `never`: never asks. It is meant for the Docker sandbox, which arrives in release 6. Without the
    sandbox it means no checks at all, apart from keeping the keys and the data folder from the
    tools.
- **Your keys and login are kept from the model's tools, against accidents:** shell commands do not
  get the API keys, and the file tools refuse Tachikoma's own data folder, where the ChatGPT login
  is kept. A shell command can still read the login; see [Known limits](#known-limits).
- **A terminal interface** with a status line showing the lead, how much of the context window is
  left, tokens, cost (or "ChatGPT plan"), mode and error count. `--status` picks which parts to show.
- **Headless runs:** `-p "<prompt>"` runs one prompt, prints the answer and exits. Add `--json` to
  get every event as one JSON line. Details below.
- **An error log:** every failure, and every refusal another model answered, is written to
  `.tachikoma/errors.jsonl` in the project, and that folder is kept out of git. `/errors`
  summarises it.
- **Refusals:** for the Anthropic models that support it, Anthropic's own fallback re-runs a refused
  request on another model. `--fallback <provider:model>` adds a retry on a model of your choice,
  which can be from another provider. Off unless set. Every rescue is shown and logged.

## Running from source

You need Node 22 or later.

```bash
npm install
npm run build
node dist/cli.js --lead <provider:model>
```

`npm link` in this folder puts the `tachi` command on your PATH, so `tachi --lead ...` works from
any folder.

Run it from the folder you want it to work in, for example
`node /path/to/tachikoma/dist/cli.js --lead ...`. You can set `TACHI_LEAD` instead of passing
`--lead`.

One example per provider:

```bash
node dist/cli.js --lead anthropic:claude-opus-5-5
node dist/cli.js --lead chatgpt:<model>
node dist/cli.js --lead openai:<model>
node dist/cli.js --lead openrouter:<model>
node dist/cli.js --lead kimi:<model>
node dist/cli.js --lead ollama:qwen3:8b
```

Other commands and options, from `node dist/cli.js --help`:

```
tachi login chatgpt [--new | --account <number>]   sign in to use your ChatGPT plan;
                    [--keychain]                   --keychain seals the tokens with a key in the keychain
tachi logout chatgpt                               sign out of ChatGPT

--lead <spec>     anthropic:<model> | chatgpt:<model> | openai:<model> | openrouter:<model>
                  | kimi:<model> | ollama:<model> (or set TACHI_LEAD)
                  chatgpt: uses your ChatGPT plan; openai: uses OPENAI_API_KEY
--mode <mode>     when to ask before acting: ask | project | never (default: ask)
--effort <level>  Anthropic models only: low | medium | high | xhigh | max
--fallback <spec> retry a turn the lead refuses on this model, e.g. openai:<model> (off unless set)
--status <list>   status line parts, comma-separated: lead,context,tokens,cost,mode,errors
-p, --print <prompt>  run without the interface
--json            with -p, print every event as one JSON line
--raw             with -p, print the answer exactly as written, control codes and all
-h, --help        show this help
```

In a session, `/lead <provider:model>` switches the lead model, `/model` picks it from a list,
`/login chatgpt` and `/logout chatgpt` sign in and out, `/errors` summarises the error log and
`/exit` quits; commands ignore case. Ctrl-C stops the current turn, or quits when idle.

## Using your ChatGPT plan

Tachikoma uses OpenAI's Sign in with ChatGPT for open-source tools. Eligible ChatGPT plans can lead
a session with an OpenAI model, billed to the plan instead of an API key.

1. `tachi login chatgpt` prints "Continue with ChatGPT in your browser" and opens your browser. If
   no browser opens, it prints a local address to open by hand. Approve Tachikoma there. The first
   time, it shows OpenAI's notice that the app now uses your ChatGPT plan.
2. `tachi --lead chatgpt:<model>` (or `/lead chatgpt:<model>`) leads with that model. A model your
   account does not offer is refused at the first message, with a list of the ones it does; `/model`
   shows them too.
3. `tachi logout chatgpt` signs out. It deletes the tokens from your computer, keeping the list of
   saved accounts (without their ID tokens), then asks OpenAI to cancel the sign-in, and says so if
   OpenAI cannot confirm. It also cancels a sign-in still waiting in the browser.

- **`chatgpt:` always bills the plan and `openai:` always uses `OPENAI_API_KEY`.** Tachikoma never
  switches between them. When the plan's limit runs out, the turn stops with a link to
  https://chatgpt.com/settings/usage; it does not move to the API key.
- **The status line** shows "ChatGPT plan" where the cost would be, plus anything other leads in the
  session cost.
- **One account at a time.** After `tachi logout chatgpt`, `tachi login chatgpt --new` adds another
  account. With several saved, `tachi login chatgpt` lists them, and `--account <number>` picks one.
- **The login is a private file** in Tachikoma's data folder (`%LOCALAPPDATA%\tachikoma` on Windows,
  `~/Library/Application Support/tachikoma` on macOS, `~/.local/share/tachikoma` on Linux). Only you
  can read it: on Windows Tachikoma sets a permission for you alone, since the profile folder also
  lets in administrators. With `--keychain`, the tokens in it are also encrypted, with a key kept in
  the system keychain (Windows Credential Manager, the macOS Keychain or the Linux secret service).
  The list of saved accounts is not: each one's email, and the ID token Tachikoma sends back to
  OpenAI to skip its account picker. An ID token does not let anyone use your plan.
  If you are already signed in, `tachi login chatgpt --keychain` seals the current login without
  signing in again. If the key is missing or does not fit, or the keychain cannot be used, the login
  is not used: sign out with `tachi logout chatgpt` (OpenAI is then not asked to cancel it; you can
  disconnect Tachikoma in ChatGPT's settings), then sign in again. To stop using the keychain, sign
  out and in again without it.
- **Several Tachikomas at once** take turns to change the login, so one does not undo another's
  renewal, apart from the cases under [Known limits](#known-limits).

## Headless runs

`tachi -p "<prompt>"` prints the answer and exits. Nobody is there to approve an action, so anything
the permission mode would ask about is refused, and the model is told so.

- **The output is made safe for a terminal**, wherever it goes: control characters, escape codes and
  marks that reorder text, in the answer and in error messages, are printed as text such as
  `\u001b`. Saved output is often shown on a terminal later, so a pipe or file gets the same
  treatment (as in `gh` and Gemini CLI). Line breaks, Windows line endings, tabs and the ordinary
  direction marks of right-to-left text stay as they are. When the answer goes to a pipe or a file
  and something was escaped, a note on stderr says so. `--raw` prints the answer exactly as the model
  wrote it, with a warning.
- **`--json`** prints one line per event: `message`, `usage`, `error` and `lead`. A request that
  Anthropic's fallback rescued gives one `usage` line for each model that declined (marked
  `priceKnown`), then one for the reply.
- **Exit codes:** 0 when the run finished; 1 when a request failed, the model refused or hit a limit,
  or an action was refused; 130 when stopped with Ctrl-C; 143 on SIGTERM and 129 on SIGHUP. If
  whatever reads the output closes it early (`| head -1`), Tachikoma stops quietly instead of
  crashing; the exit code is then 0, or the run's own code if it had already finished.

## Providers

| Provider | `--lead` prefix | Environment variable |
|---|---|---|
| Anthropic | `anthropic:` | `ANTHROPIC_API_KEY` (an API key only; Tachikoma never signs in with a Claude subscription) |
| ChatGPT plan | `chatgpt:` | none; `tachi login chatgpt` |
| OpenAI | `openai:` | `OPENAI_API_KEY` |
| OpenRouter | `openrouter:` | `OPENROUTER_API_KEY` |
| Kimi (Moonshot) | `kimi:` | `MOONSHOT_API_KEY` |
| Ollama | `ollama:` | none; it talks to `http://localhost:11434` |

Costs are shown only for models with a known price. Others show `?`; Ollama counts as free, and a
ChatGPT plan shows as "ChatGPT plan".

Shell commands never see these API keys, so a command cannot print one back to the model. A command
that needs one of them does not get it either.

The Anthropic SDK still adds any headers you set in `ANTHROPIC_CUSTOM_HEADERS`, so do not put an
`Authorization` header there.

## Known limits

Each is fixed in a later release, unless it says otherwise.

- **An approved shell command can still read your login.** Commands on your own machine run with your
  own access, so one you approve can read files and the system keychain. Keeping keys from commands
  and the data folder from the file tools prevents accidents, not a determined command. The sandbox
  (release 6) keeps commands away from the login.
- **On a ChatGPT plan, `--effort` does nothing yet.** Whether the plan accepts a reasoning setting is
  still to be measured, and no release is set for it yet.
- **The context left is shown only for models whose window is known:** Anthropic models, and
  ChatGPT-plan models (from the account's model list, once the first reply arrives). Other models
  show the tokens in use; no release is set for them yet.
- **If a Tachikoma is killed while changing the login,** a renewal it had already sent can be lost,
  and you sign in again. So is a renewal that cannot be saved, such as when another program holds
  the login file for over a second or the disk is full; Tachikoma then says to sign out and in again.
  The next Tachikoma takes over a killed one's lock, within 5 seconds if it was already waiting. If
  another program now has the killed one's process number, the next one waits until the computer
  restarts, and names the lock file to delete. If two take the lock over at the same moment, or the
  clock jumps forward while one holds it, a renewal can also be lost (none of this is planned to
  change).
- **On a ChatGPT plan, a failed request is not tried again.** OpenAI asks for "bounded backoff" but
  gives no numbers, so Tachikoma reports the error and keeps your sign-in; no release is set for it
  yet.
- **A reply already streaming when you sign out** finishes. The next request is refused (not planned
  to change).
- **The history is never shortened** (release 7). When the context window is full, the turn ends
  with an error. Switching `/lead` to a model with a smaller window can make the next request fail.
- **No budget limit** (release 10). An interactive session runs until you stop it.
- **Shell commands have no time limit** (release 10). A command that keeps its output open runs
  until you cancel it. Closing the terminal, SIGTERM, and Ctrl-C in headless mode stop running
  commands; a hard kill or a crash of Node does not, and on macOS and Linux the command then keeps
  going.
- **The file tools check a path, then use it.** Another program that swaps a folder for a link in
  between could redirect a write, and a hard link inside the project to a file outside it looks like
  an ordinary file. Both need something already running on your machine; the sandbox (release 6) is
  the answer.
- **On Windows, cancelling cannot stop a program whose shell has already exited.** Cancel still
  returns at once. On macOS and Linux it does stop it.
- **On Windows, shell exit codes are only 0 or 1.** PowerShell reports only whether the last command
  succeeded, so a program's own exit code is lost.
- **On Windows, PowerShell error messages repeat the whole command**, including the line Tachikoma
  puts first to make the output UTF-8. The ways around it that were tried either lost the exit code or
  turned error messages into XML.

## What comes next

1. Core (done): the agent loop, local file and shell tools, Anthropic and OpenAI-format providers
   with lead switching, the terminal interface with status line, the error log.
2. Sign in with ChatGPT (this release), so an OpenAI model can lead on your ChatGPT plan instead of
   an API key; the `/model` picker.
3. Docker sandbox, in two modes (a live link to your folder, or a copy you review before it is
   applied).
4. MCP tools and long-term memory (MemPalace); transcripts saved to disk; shortening the history.
5. Skills: the loader, the bundled superpowers skills, and Tachikoma's own.
6. Search of the codebase by meaning, with EmbeddingGemma 2.
7. A budget controller, then handing work to the `claude`, `codex` and `kimi` command-line tools.
8. Loops: on a timer, and until a task is done.
9. `tachi setup` and `tachi doctor`, and testing a fresh install in CI.

## Licence

MIT. A LICENSE file will be added.
