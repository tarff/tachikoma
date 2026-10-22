# Tachikoma

Tachikoma is a coding-agent harness written from scratch in TypeScript. Any of several model
providers can lead a session. Later releases add handing work to other models and to the `claude`,
`codex` and `kimi` command-line tools, long-term memory, search of the codebase by meaning, a Docker
sandbox, and lessons learned from its own error log.

This is release 1 of 8: the core. The command is `tachi`.

## What release 1 does

- **Five providers, any of them can lead:** Anthropic, OpenAI, OpenRouter, Kimi (Moonshot) and a
  local Ollama. `/lead <provider:model>` switches the lead in the middle of a session, and the
  conversation carries over.
- **File and shell tools:** read, write and edit files, and run shell commands (PowerShell on
  Windows, `/bin/sh` elsewhere). The project is the folder you start `tachi` in. Each action goes
  through a permission mode, set with `--mode`:
  - `ask` (the default): asks before every write and shell command, and before anything outside the
    project.
  - `project`: writes inside the project without asking; asks before shell commands and anything
    outside the project.
  - `never`: never asks. It is meant for the Docker sandbox, which arrives in release 2. Without the
    sandbox it means no checks at all.
- **A terminal interface** with a status line showing the lead, context use, tokens, cost, mode and
  error count. `--status` picks which parts to show.
- **Headless runs:** `-p "<prompt>"` runs one prompt, prints the answer and exits. Add `--json` to
  get every event as one JSON line.
- **An error log:** every failure is written to `.tachikoma/errors.jsonl` in the project, and that
  folder is kept out of git. `/errors` summarises it.
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

Run it from the folder you want it to work in, for example
`node /path/to/tachikoma/dist/cli.js --lead ...`. You can set `TACHI_LEAD` instead of passing
`--lead`.

One example per provider:

```bash
node dist/cli.js --lead anthropic:claude-opus-5-5
node dist/cli.js --lead openai:<model>
node dist/cli.js --lead openrouter:<model>
node dist/cli.js --lead kimi:<model>
node dist/cli.js --lead ollama:qwen3:8b
```

Other options, from `node dist/cli.js --help`:

```
--lead <spec>     anthropic:<model> | openai:<model> | openrouter:<model> | kimi:<model> | ollama:<model>
                  (or set TACHI_LEAD)
--mode <mode>     when to ask before acting: ask | project | never (default: ask)
--effort <level>  Anthropic models only: low | medium | high | xhigh | max
--fallback <spec> retry a turn the lead refuses on this model, e.g. openai:<model> (off unless set)
--status <list>   status line parts, comma-separated: lead,context,tokens,cost,mode,errors
-p, --print <prompt>  run without the interface
--json            with -p, print every event as one JSON line
-h, --help        show this help
```

In a session, `/lead <provider:model>` switches the lead model, `/errors` summarises the error log
and `/exit` quits. Ctrl-C stops the current turn, or quits when idle.

## Providers

| Provider | `--lead` prefix | Environment variable |
|---|---|---|
| Anthropic | `anthropic:` | `ANTHROPIC_API_KEY` (the SDK also accepts `ANTHROPIC_AUTH_TOKEN`) |
| OpenAI | `openai:` | `OPENAI_API_KEY` |
| OpenRouter | `openrouter:` | `OPENROUTER_API_KEY` |
| Kimi (Moonshot) | `kimi:` | `MOONSHOT_API_KEY` |
| Ollama | `ollama:` | none; it talks to `http://localhost:11434` |

Costs are shown only for models with a known price. Others show `?`; Ollama counts as free.

## Known limits of release 1

Each is fixed in a later release.

- **The history is never shortened** (release 3). When the context window is full, the turn ends
  with an error. Switching `/lead` to a model with a smaller window can make the next request fail.
- **No budget limit** (release 6). An interactive session runs until you stop it.
- **Shell commands have no time limit** (release 6). A command that keeps its output open runs until
  you cancel it. Closing the terminal, SIGTERM, and Ctrl-C in headless mode stop running commands; a
  hard kill or a crash of Node does not, and on macOS and Linux the command then keeps going.
- **The file tools check a path, then use it.** Another program that swaps a folder for a link in
  between could redirect a write, and a hard link inside the project to a file outside it looks like
  an ordinary file. Both need something already running on your machine; the sandbox (release 2) is
  the answer.
- **On Windows, cancelling cannot stop a program whose shell has already exited.** Cancel still
  returns at once. On macOS and Linux it does stop it.
- **On Windows, shell exit codes are only 0 or 1.** PowerShell reports only whether the last command
  succeeded, so a program's own exit code is lost.

## What comes next

1. Core (this release): the agent loop, local file and shell tools, Anthropic and OpenAI-format
   providers with lead switching, the terminal interface with status line, the error log.
2. Docker sandbox, in two modes (a live link to your folder, or a copy you review before it is
   applied).
3. MCP tools and long-term memory (MemPalace); transcripts saved to disk; shortening the history.
4. Skills: the loader, the bundled superpowers skills, and Tachikoma's own.
5. Search of the codebase by meaning, with EmbeddingGemma 2.
6. A budget controller, then handing work to the `claude`, `codex` and `kimi` command-line tools.
7. Loops: on a timer, and until a task is done.
8. `tachi setup` and `tachi doctor`, and testing a fresh install in CI.

## Licence

MIT. A LICENSE file will be added.
