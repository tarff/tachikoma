# Tachikoma

> **Work in progress.** Release 7 of 14 is done; the rest is being built. Expect missing
> features and changes that break things, and don't rely on it for real work yet.

Tachikoma is a coding-agent harness written from scratch in TypeScript. Any of several model
providers can lead a session. Later releases add handing work to other models and to the `claude`,
`codex` and `kimi` command-line tools, long-term memory, search of the codebase by meaning, and
lessons learned from its own error log.

This is release 7 of 14: the core; signing in with ChatGPT; Claude Code's keys and screen;
subagents that read, with a to-do list and your instruction files; a full screen with its own
scrolling and mouse selection; a settings file, keys you can move, and Claude Code's external
editor, stash, pictures and vim mode; and a Docker sandbox, auto mode (a second model judging
actions) and a check on dangerous commands. The command is `tachi`. So far it has been tested on
Windows 11 only; release 13 adds testing on Linux and macOS.

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
  into the file first. There are four: `ask` (the default), `project`, `auto` and `never`. See
  [Permission modes](#permission-modes).
- **A Docker sandbox** (release 7): `--sandbox live` runs the model's commands and file tools in a
  container on your folder, and `--sandbox copy` on a copy whose changes you review, file by file,
  before any reaches your folder. See [The sandbox](#the-sandbox).
- **Auto mode** (release 7): reads and edits in the project run without asking, and a second model,
  the judge, decides the rest. See [Auto mode and its judge](#auto-mode-and-its-judge).
- **A check on dangerous commands** (release 7): every shell command is read before it runs, and
  one that wipes disks, deletes whole folders, rewrites git history, installs software and the like
  asks, with the danger named in red, or is refused where nobody is asked. See
  [The dangerous-command check](#the-dangerous-command-check).
- **Protected paths** (release 7): files other programs run or read as settings, such as git's
  hooks and `.npmrc`, are never written without a check, and `project` mode now asks for them. See
  [Protected paths](#protected-paths).
- **Search tools:** `find_files` lists files by a pattern such as `src/**/*.ts`, and `search_files`
  searches their contents with a regular expression. Both skip `.git` and what the project's
  `.gitignore` files list, follow no links, and run no program.
- **Subagents that read:** the lead can hand searching and reading to subagents with its `delegate`
  tool. Each has `read_file`, `find_files` and `search_files` and reports what it found with file
  paths and line numbers. Several run side by side, or in the background while the lead goes on; a
  background answer that arrives while the lead is idle starts a turn by itself. A panel under the
  prompt shows each one's short description, and under it its model, time, tokens, cost and latest
  tool call. `--worker <provider:model>` (or `TACHI_WORKER`) picks their model, the lead's by
  default, and `--max-tasks` how many run at once (8 by default). `/tasks` lists them, `/tasks t3`
  shows one in full and `/tasks stop` stops them. A subagent's read outside the project asks first,
  naming the subagent.
- **A to-do list** the lead keeps above the prompt while any item is unfinished. Ctrl+T hides or
  shows it.
- **Your instruction files:** each session reads `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` (or
  `CODEX_HOME`'s), and the `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` and `AGENTS.md` of
  every folder from the top of the drive down to the project, with their `@` imports. A grey line at
  the start lists them. A file they lead to outside the project asks first, before it is opened,
  unless it is your own; Tachikoma's data folder is never read.
- **Your keys and login are kept from the model's tools, against accidents:** shell commands do not
  get the API keys, and the file tools refuse Tachikoma's own data folder, where the ChatGPT login
  is kept, and the [settings](#settings) and [keys](#keys) files. Without the sandbox, a shell
  command can still read the login; see [Known limits](#known-limits).
- **A terminal interface with Claude Code's keys:** Esc stops a turn, the prompt edits as a shell
  line does, prompts can run over several lines, Up and Ctrl+R bring back past prompts, and what you
  type while it works waits its turn. `/` lists the commands, `@` the project's files, Shift+Tab
  switches the permission mode and `?` lists every key.
- **A full screen of its own:** the conversation scrolls with the wheel and the keys, with a scroll
  bar; the mouse selects and copies; Ctrl+O (the last turn's tool calls in full) and `/tasks t3`
  (a subagent's full record) open in place, with a search. Quitting leaves the terminal as it was.
  `--classic` keeps the terminal's own scrollback instead. See [Full screen](#full-screen).
- **A settings file,** `~/.tachikoma/settings.json`, for every option, so a plain `tachi` starts the
  way you want; edits apply while it runs. See [Settings](#settings).
- **Keys you can move:** every key is a named action, and a keys file in Claude Code's format
  rebinds them. See [Keys](#keys).
- **Claude Code's prompt extras:** Ctrl+G opens the prompt in your editor, Ctrl+S puts it aside,
  Alt+V (Ctrl+V on macOS and Linux) and dragged-in picture files add pictures, shrunk to what each
  provider takes, and there is a vim mode. See [The external editor](#the-external-editor),
  [Stash](#stash), [Pictures](#pictures) and [Vim mode](#vim-mode).
- **A status line** showing the lead, how much of the context window is left (with a bar), tokens,
  cost (or "ChatGPT plan"), mode, error count, the project folder and git branch, how long the
  session has run, and how many subagents run, its parts coloured as
  [claude-hud](https://github.com/jarrodwatts/claude-hud)'s are; a line under it counts the turn's
  tool calls. `--status` picks which parts to show. Subagents' tokens and cost count in the totals.
- **Headless runs:** `-p "<prompt>"` runs one prompt, prints the answer and exits. Add `--json` to
  get every event as one JSON line. Details below.
- **An error log:** every failure, and every refusal another model answered, is written to a
  private file of the project's own in Tachikoma's data folder, `errors/<hash>.jsonl`, so nothing
  in a project can lead it elsewhere. `/errors` summarises it.
- **Refusals:** for the Anthropic models that support it, Anthropic's own fallback re-runs a refused
  request on another model. `--fallback <provider:model>` adds a retry on a model of your choice,
  which can be from another provider. Off unless set. Every rescue is shown and logged.

## Running from source

You need Node 22.20 or later. The sandbox also needs Docker; see [The sandbox](#the-sandbox).

```bash
npm install
npm run build
node dist/cli.js --lead <provider:model>
```

`npm link` in this folder puts the `tachi` command on your PATH, so `tachi --lead ...` works from
any folder.

Run it from the folder you want it to work in, for example
`node /path/to/tachikoma/dist/cli.js --lead ...`. You can set `TACHI_LEAD`, or `"lead"` in the
[settings file](#settings), instead of passing `--lead`.

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
tachi sandbox build                                build the sandbox's image, after asking
tachi review [<name> [--discard]]                  list the copies kept for review, open one, or discard one

--lead <spec>     anthropic:<model> | chatgpt:<model> | openai:<model> | openrouter:<model>
                  | kimi:<model> | ollama:<model> (or set TACHI_LEAD)
                  chatgpt: uses your ChatGPT plan; openai: uses OPENAI_API_KEY
--mode <mode>     when to ask before acting (default: ask):
                  ask: before each write and shell command, and before anything outside the project
                  project: before shell commands and anything outside the project
                  auto: reads and edits in the project run, the judge model decides the rest,
                        and dangerous commands ask you
                  never: never ask; only with --sandbox copy, where you review changes at the end
--sandbox <how>   off | live | copy (default: off): commands run in Docker on this folder or a copy
--network <net>   off | on (default: off): whether commands in the sandbox can reach the internet
--judge <spec>    the model that judges in auto mode; the lead's model unless set
--effort <level>  Anthropic models only: low | medium | high | xhigh | max
--fallback <spec> retry a turn the lead refuses on this model, e.g. openai:<model> (off unless set)
--worker <spec>   the model subagents run on (or set TACHI_WORKER); the lead's model unless set
--max-tasks <n>   how many subagents run at once (default: 8)
--status <list>   status line parts, comma-separated: lead,context,tokens,cost,mode,errors,project,time,tasks,tools
--classic         use the terminal's own scrollback, not the full screen (or set TACHI_CLASSIC=1)
--scroll-speed <n>  lines a wheel notch scrolls in full screen, above 0 and up to 20
                    (default: 3; or set TACHI_SCROLL_SPEED)
-p, --print <prompt>  run without the interface
--json            with -p, print every event as one JSON line
--raw             with -p, print the answer exactly as written, control codes and all
-h, --help        show this help
Options --lead to --scroll-speed can also be set in ~/.tachikoma/settings.json; a flag or variable wins.
```

(The block leaves out the help's first line, its "Usage:" and "Options:" headings, its closing
"In a session:" paragraph, and its indent; on Windows the settings line reads
`~\.tachikoma\settings.json`.)

In a session, `/lead <provider:model>` switches the lead model, `/lead` or `/model` alone lists the
models to pick from, `/login chatgpt` and `/logout chatgpt` sign in and out, `/tasks` lists the
subagents, `/errors` summarises the error log, `/screen` switches between full screen and classic,
`/settings` and `/keybindings` open the settings and keys files in your editor, `/vim` switches vim
mode, and `/exit` quits; commands ignore case. `/lead`, `/model`, `/screen` and `/vim` change only
the window you type them in. Esc or Ctrl-C stops the current turn and the subagents it waits for;
background subagents go on until `/tasks stop` or you quit.
When idle, Ctrl-C clears the prompt, and pressed twice on an empty prompt it quits. Ctrl+T hides or
shows the to-do list. Esc and Ctrl+T can be moved in the keys file; Ctrl-C and Ctrl-D cannot. `?`
on an empty prompt lists every key.

## Permission modes

Every action the model takes, a file read or write or a shell command, goes through the permission
mode. `--mode` (or `"mode"` in the [settings file](#settings)) sets it at launch, and Shift+Tab
switches it during a session, through `ask`, `project` and `auto`, and `never` as well when the
session was started in `never`. The status line shows the mode in force.

| Mode | Runs without asking | Asks you |
|---|---|---|
| `ask` (the default) | reads inside the project | every write and shell command, and anything outside the project |
| `project` | reads, and writes inside the project | shell commands, anything outside the project, and writes to [protected paths](#protected-paths) |
| `auto` | reads, and writes inside the project that are not to protected paths | dangerous commands; a second model, the judge, decides everything else ([below](#auto-mode-and-its-judge)) |
| `never` | everything that is not refused | nothing: a dangerous command, a write to a protected path and a write outside the project are refused, and the model is told why |

- **A dangerous command asks in every mode that asks,** with one red line above the question for
  each danger found: `Danger: <kind>: <command>`. In `never`, and with `-p`, where nobody is there
  to answer, it is refused. See [The dangerous-command check](#the-dangerous-command-check).
- **`never` runs only with `--sandbox copy`,** where nothing the model writes reaches your folder
  before you have reviewed it. Asked for without it, from `--mode` or the settings file, the launch
  stops: `--mode never needs --sandbox copy, so nothing reaches your folder before you have reviewed
  it; launch with --sandbox copy --mode never.` Live link is not enough, as the box there writes
  your real folder.
- **Copy mode with `ask` still asks** before each change it makes in the copy, and the review at the
  end asks again, file by file. `never` is the mode that does not ask while the session runs.

### Auto mode and its judge

In `auto`, Tachikoma decides each action in this order, as Claude Code's auto mode does:

1. A read inside the project, or a write inside it that is not to a protected path, runs.
2. A shell command the dangerous-command check matches asks you, with its red lines. The judge is
   never asked about it.
3. Everything else goes to the judge: a second model, asked in a fresh request with no tools whether
   the action is a reasonable step toward what you asked for. A yes runs the action. A no goes back
   to the model with the judge's reason (`The judge refused: <reason>`), so it can try another way.

- **What the judge sees:** your own prompts in this session, as you typed them; the tool calls made
  so far, each tool's name and what it was given, but never what it returned (a file write shows
  only its path and how long its text is); the action to judge, in full; and the instruction files
  as read at launch. What tools returned is left out on purpose, as Claude Code leaves it out, so
  text planted in a file or a web page cannot talk to the judge. But the instruction files include
  the project's own (`AGENTS.md`, `CLAUDE.md` and the like), read without asking, so a project you
  do not trust can try to talk the judge into a yes. What holds whatever the judge says is the
  dangerous-command check and your own `dangerousCommands` rules, which ask you instead.
- **Which model:** `--judge <provider:model>`, or `"judge"` in the settings file. Unset, the lead's
  own model judges, through the same login. Its tokens and cost count in the session's totals, but
  not in the context bar, which is the lead's.
- **An answer that cannot be read counts as a no,** and so does a judge that cannot be reached; its
  error shows (`✗ judge: …` on screen, `judge: …` on stderr with `-p`).
- **The judge has no time limit of its own,** only its provider's request time limit and
  retries. So a judge slow to answer holds auto mode up, with no line saying why; Esc stops it.
- **After 3 refusals in a row, or 20 in a session, auto mode pauses.** The next action that would go
  to the judge asks you instead, with the grey line `Auto mode paused after <n> refusals; approving
  this resumes it.`, and a yes resumes it. Once a session has had 20, each later refusal pauses it
  again. Both numbers are Claude Code's, from its documentation; they have not been measured for
  Tachikoma. With `-p` it never pauses: each no is final, and the run goes on.
- **An answer counts only if nothing changed while it was on its way.** Esc throws it away and the
  action does not run. Switching the mode with Shift+Tab, or adding a rule of your own in the
  settings file, has the action decided again under what is in force now, so it may ask. A yes is
  never kept: the same action asked for again goes to the judge again.
- **The judge can be wrong.** In Claude Code's words about its own: "Auto mode reduces permission
  prompts but does not guarantee safety." A limit you state in the conversation, such as "don't
  push", counts, since the judge reads your prompts. But release 8 will shorten long conversations
  to fit the model's window, and that can drop the line. A rule that must hold belongs in
  `dangerousCommands` in the settings file instead: `{"dangerousCommands": {"add": ["git push"]}}`
  makes every `git push` ask, judge or no judge.

### Protected paths

Some files in a project are run, or read as settings, by other programs on your machine later,
outside any question: git's hooks, an editor's task files, a package manager's settings. Writing one
can plant a command that runs later. So a write to one by the file tools is never made without a
check, in every mode, with or without the sandbox:

- `ask` and `project` ask. In `project` this is new in release 7; before, it wrote any project file
  without asking, hooks included.
- `auto` sends it to the judge, never through unasked.
- `never` refuses it: `Not allowed: <path> is a protected path (<part>), which other programs run or
  read as settings.`

The list is Claude Code's, plus Tachikoma's own `.tachikoma`:

- **Folders:** `.git`, `.config/git`, `.vscode`, `.idea`, `.husky`, `.cargo`, `.devcontainer`,
  `.yarn`, `.mvn`, `.claude`, `.tachikoma`, and every folder git's settings name for hooks
  (`core.hooksPath`), and a git folder kept elsewhere in the project.
- **Files:** `.gitconfig`, `.gitmodules`; the shell start-up files (`.bashrc`, `.bash_profile`,
  `.bash_login`, `.bash_aliases`, `.bash_logout`, `.zshrc`, `.zprofile`, `.zshenv`, `.zlogin`,
  `.zlogout`, `.profile`, `.envrc`); `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `.pnp.cjs`,
  `.pnp.loader.mjs`, `.pnpmfile.cjs`, `bunfig.toml`, `.bunfig.toml`; `.bazelrc`, `.bazelversion`,
  `.bazeliskrc`; `.pre-commit-config.yaml` and lefthook's files (`lefthook.yml`, `.yaml`, `.json`
  and `.toml`, with or without a leading dot, and `lefthook-local.*`); `gradle-wrapper.properties`,
  `maven-wrapper.properties`; `.devcontainer.json`; `.ripgreprc`, `pyrightconfig.json`; `.mcp.json`,
  `.claude.json`; and every git settings file git reads for the project, the files they include
  among them.

A name counts at any depth (`web/.husky/pre-commit`, `tools/.npmrc`), ignoring letter case on
Windows and macOS and on a folder that ignores it elsewhere, such as WSL's `/mnt/c`; a path counts
by where it really leads, after links. A write to an existing
file that has another name (a hard link) counts too, as it could be a second name for a protected
file. Git's settings are read at launch with `git config --file`, which runs nothing; without git on
your machine, only the fixed list applies.

A shell command that writes such a file is a shell command: it asks in `ask` and `project`, and goes
to the check and the judge in `auto`. In live link the box sees git's files read-only, and in copy
mode the review starts each change to a protected file as skipped.

## The dangerous-command check

Every shell command is read before it runs, in every mode, by Tachikoma's own code, not a model. The
line is split into its separate commands (`a && b`, `a; b`, pipes, `$(...)`, and the text given to
`bash -c`, `cmd /c` or `powershell -Command`), read the way the shell that will run it reads it
(PowerShell on Windows, `/bin/sh` elsewhere, bash in the sandbox). Each command is matched against a
list of rules, in nine kinds:

| Kind | Examples |
|---|---|
| wiping or formatting disks | `format`, `diskpart`, `Clear-Disk`, `mkfs`, `dd of=/dev/…`, `wsl --unregister` |
| deleting whole folders | `rm -rf` or `Remove-Item -Recurse` on a drive root, your home folder, the project itself, `*`, or a path that is only a variable (`"$d"`) |
| permissions and system settings | `icacls`, `takeown`, `Set-Acl`, `chmod -R`, `reg add`, `bcdedit`, `Set-ExecutionPolicy`, `netsh`, `sudo`, `runas`, `setx` |
| stopping processes or the machine | `taskkill`, `Stop-Process`, `kill`, `pkill`, `shutdown`, `reboot`, `wsl --shutdown` |
| rewriting or deleting git history | `git push --force` or `--delete`, `git reset --hard`, `git clean -fd`, `git checkout -- .`, `git branch -D`, `git rebase`, `git filter-branch` |
| sending files out | `curl -T`, `-F` or `-d @file`, `scp`, `rsync` to another machine, `Invoke-WebRequest -InFile`, `nc` |
| installing software | `npm install <package>`, `pip install <package>`, `npx`, `uvx`, `cargo install`, `winget`, `choco`, `apt`, `brew` |
| downloading and running code | `curl … \| sh` and `iex (iwr …)`, which count as lines the check cannot read (below); a script run straight from a web address (`deno run https://…`) |
| acting outside the machine | `gh pr merge`, `gh repo delete`, `terraform apply` and `destroy`, `kubectl delete`, `docker push`, `npm publish` |

- **Installs from the project's own lock file pass,** as in Claude Code: `npm ci`, `npm install`
  with no package named, `pip install -r requirements.txt`, `uv sync`. So does `npx` of a program
  the project already has in `node_modules/.bin`, which npx runs without downloading.
- **A line the check cannot read counts as dangerous,** since hiding what a command does is treated
  like a match: `eval`, `Invoke-Expression`, `-EncodedCommand`, text piped into a shell (`curl … |
  sh`), a command whose name is made only when it runs (`$tool --version`), and other ways of
  running text the check cannot follow. Its red line says `the check cannot read it: <why>`.
- **What happens on a match** depends on the mode: `ask` and `project` ask as usual, with the red
  lines; `auto` always asks you, and the judge can never approve it; `never` and `-p` refuse it:
  `Not allowed: this command matches the dangerous-command check (<kind>: <command>).`
- **It is a list of known patterns, not a wall.** A script can do any of these things unseen
  (`python wipe.py`), and code given inline to an interpreter (`python -c`, `node -e`) is not read.
  The check catches the common cases; the sandbox is what holds. Some harmless lines ask too: see
  [Known limits](#the-dangerous-command-checks-limits).

**Your own rules,** in the settings file only, so a project you download can never loosen the check:

```json
{
  "dangerousCommands": {
    "add": ["terraform apply", "git push"],
    "off": ["installing software"]
  }
}
```

- **`add`** lists commands by their first words. A command matches when its first words are those,
  word by word, so `"git push"` matches `git push origin main`. Its red line names it as `your own
  rule: git push`. A rule cannot hold quotes.
- **`off`** switches a kind off by its name in the table above, in lower case. While any kind is
  off, each launch says so: `The dangerous-command check is off for: <kinds>; in auto and never,
  those commands run without it.` A line the check cannot read still counts, whatever is off.
- **Edits while Tachikoma runs:** a rule added, or a kind switched back on, applies at once, with a
  grey line. A kind switched off, or a rule removed, loosens the check, so it waits for the next
  launch, with a red warning: `settings.json: dangerous-command check: "installing software"
  switched off; in auto and never, those commands will run without the check. Takes effect at the
  next launch.`

## The sandbox

`--sandbox live` or `--sandbox copy` (or `"sandbox"` in the settings file) runs the model's shell
commands and file tools in a Docker container, "the box", one for each session, instead of on your
machine. It is off unless you ask for it.

- **What it needs:** Docker, installed, running, and set to Linux containers: Docker Desktop on
  Windows and macOS, or Docker on Linux. Live link also needs git on your machine, to read git's
  settings. Without Docker the launch stops with one line saying what to do, such as `The sandbox
  needs Docker, which is not running. Start Docker, then launch again.`; Tachikoma never falls back
  to running commands on your machine.
- **Everything in the box is Linux.** Commands run in bash, and Windows-only tools (Windows
  PowerShell, `.exe` programs, Windows builds) need the sandbox off.
- **What the box can reach:** only the project folder, or its copy, which it sees as `/work`; the
  model is told that name. Not your home folder, your keys, Tachikoma's logins or its settings, and
  none of your environment variables. It runs as an ordinary user, not root (with rootless Docker,
  as the box's root, which Docker maps to your own user), with every special power Linux can grant
  a process taken away and no way to gain more, and no access to Docker itself. Tachikoma refuses
  to start it in a folder that holds your home folder, Tachikoma's data folder or its settings
  folder: `The sandbox cannot run on <folder>: it holds <what>, which must never be in the box.
  Start Tachikoma in a project folder.`
- **The launch line** says what is in force, in grey: `Sandbox: live link on <folder>, network off,
  limits 4g, 4 CPUs, 1024 processes.`
- **Esc** stops the running command inside the box, as it does on your machine.
- **The box is removed** when the session ends. One left behind by a crash is removed at the next
  launch. If Docker fails during a session, the shell and file tools stop, and never move to your
  machine: `The sandbox stopped working: <Docker's words>. Shell and file tools are off until
  Tachikoma is launched again.`

### The image: what it builds and downloads

The box runs from an image built on your machine, once, from the Dockerfile shipped with Tachikoma
(`sandbox/Dockerfile`):

- Node 24 on Debian 12 (`node:24-bookworm-slim`, from Docker Hub) and uv, a Python package tool
  (from `ghcr.io/astral-sh/uv`), each pinned to one exact build;
- Debian's `git`, `python3`, `python3-venv`, `bash` and `ca-certificates`.

The first launch with the sandbox asks before downloading anything: `The sandbox needs its image,
built here once. It downloads: <images>, and Debian's packages. Build it now? [y/n]`. `tachi sandbox
build` does the same on its own, or says `The sandbox's image is up to date
(tachikoma-sandbox:<tag>).` With `-p`,
nothing is built, and nothing waits: `The sandbox's image is not built. Run tachi sandbox build
first.` The image's name, `tachikoma-sandbox:<tag>`, comes from the Dockerfile's contents, so a
changed Dockerfile is a new image, built again after asking.

A project can bring its own image: `.tachikoma/sandbox.Dockerfile`. It is built after a question
that names it as the project's, from an empty folder, so it cannot copy the project's files into the
image. It needs bash, util-linux's `setsid` and Node 22.5 or newer, which Tachikoma's file tools
use in the box. `.tachikoma` is a protected path, and hidden from the box, so the box cannot rewrite
it.

### Live link or copy mode

- **Live link, `--sandbox live`:** the box works on your real folder, and what it writes lands there
  at once. Parts are read-only in the box: all of `.git`, so git commands that only read work (`git
  log`, `git diff`, `git status`) and commits, checkouts and branch switches fail, and you commit on
  your own machine; every project file git's settings include; every hooks folder git's settings
  name, and the folder around one named `_`, as husky sets it; and a top-level `HEAD`, `objects` or
  `refs`, and a top-level `config` file. `.tachikoma` is hidden; Tachikoma makes an empty one first
  if there is none. A git include that is a link or cannot be read, or a hooks folder git names that
  does not exist yet, refuses live link, with one line naming it.
- **On Windows and macOS, live link is refused on ordinary folders,** which ignore letter case. The
  box's read-only parts cover one spelling only, and on Docker Desktop for Windows the box reached
  `.git` as `.GIT` (measured): `Live link is refused: this folder ignores letter case, as Windows
  and macOS do by default, so the box could reach git's files by another spelling. Launch with
  --sandbox copy instead.` So there copy mode is the sandbox. Live link works on Linux, and on a
  folder set to mind letter case.
- **Live link is refused on a project with git submodules:** a submodule's `.git` is a file the box
  could point at git settings of its own, which git on your machine would then run.
- **Live link is refused when a protected file has a hard link:** a file the box sees read-only,
  `.git/config` say, that has another name could be changed through that name. A protected place
  that cannot be read is refused too, as it cannot be checked.
- **Copy mode, `--sandbox copy`:** the box works on a copy, and your folder is not touched until you
  review the changes, when the session ends.

**Which to use:** copy mode when the work should be reviewed before it reaches your folder, and
always for unattended work (`never` runs only there). Live link when you want the changes in place
as they happen and will check them yourself.

**What stays open in live link, said plainly:**

- A command in the box can change any other project file you later run on your machine, such as a
  `package.json` script, a Makefile, or lefthook's and pre-commit's settings files. No read-only
  part can protect ordinary project files.
- It can make a folder inside the project look like a git repository of its own, with its own
  `HEAD`, `objects`, `refs` and `config`. Git run later in that folder on your machine would use the
  box's settings instead of the real `.git`. Git's own setting `safe.bareRepository = explicit`
  refuses such a repository unless it is named on purpose, and is recommended: `git config --global
  safe.bareRepository explicit`. Tachikoma never changes your git settings. The setting does not
  cover everything: where the project is a subfolder of a repository, or not a repository, the box
  can make an ordinary `.git` folder, which git on your machine would then use.

This is why `never` is refused in live link.

### Copy mode and the review

- **The copy:** at launch, `Copying <folder> for the sandbox...`, then everything in the project is
  copied into Tachikoma's data folder, files git ignores included, except every `.git` and
  `.tachikoma`, at any depth, in any letter case on Windows and macOS and on a folder that ignores
  it elsewhere. A large ignored folder such as `node_modules` makes this slow:
  Tachikoma's own folder, 14,681 files and 174 MB, took 33 seconds. Links inside the project are
  made again in the copy; links leading outside it are left out and listed. The launch line then
  says `Sandbox: copy of <folder> (<n> files, <s> s), network …, limits …. Your folder is not
  touched until you review the changes.`
- **Git in the box:** `/work` starts as a new git repository holding the copy as one commit, on your
  branch's name, so the model can use git freely there. **The box's own commits stay in the copy and
  are never applied to your folder;** only the files are.
- **The review:** `/exit`, Ctrl-D, or Ctrl-C twice stops the box and opens the review (in full
  screen, unless the session is in classic mode). Each row is one added, changed or deleted file,
  starting as `keep`. Changes to protected
  paths start as `skip (protected)`, as they can run code on your machine later; switch one to keep
  only on purpose. Links, and paths that changed type, are `shown only` and never applied: you apply
  those by hand. Changes inside paths git ignores are shown only as a count, and never applied, so
  packages reinstalled in the Linux box never overwrite yours.
- **Applying:** `a` applies the kept changes one file at a time, deletes first. Each file it
  replaces is backed up first, under `.tachikoma/backups/<session>/` in your project, and each step
  is logged, so an apply cut off by a crash can say what was done. A file changed in your folder
  since the copy was made is a conflict: `<path> changed in your folder since the copy was made. m
  to merge, s to skip`. `m` merges the three versions with `git merge-file`; where they clash, the
  file with the conflict markers goes beside it as `<path>.tachikoma-merge`, its parts labelled
  `your folder`, `the snapshot` and `the box's copy`. A binary file is never merged.
- **The end:** once every change is applied or skipped, the copy is removed. Otherwise, or after
  `l`, it is kept: `The copy is kept; tachi review <session> opens it again.` `d` discards it after
  `Discard the copy and every change in it? [y/n]`. A session that changed nothing, or only paths
  git ignores, skips the review and removes the copy, with `-p` too. When the box made something the
  review lists as never applied, such as a nested `.git` or a `.tachikoma`, the review still opens.
- **Kept for later:** a copy is also kept when the session is ended by a signal or a crash, and with
  `-p`, which prints `Changes kept for review: tachi review <name>` on stderr.

The review's keys, which the keys file can move (the `Review` context):

| Key | In the list |
|---|---|
| Up, Down | move |
| Space | switch the change between keep and skip |
| Enter | the file's diff, in the detail view's way: j and k or Up and Down a line, g and G or Home and End the top and bottom, PgUp and PgDn a page, q or Esc back |
| `a` | apply what is kept |
| `l` | leave the copy for later (Ctrl-C does the same) |
| `d` | discard the copy, after a y/n question |
| `m`, `s` | at a conflict: merge, or skip |

When the apply is done, Up and Down scroll what came of each change, and any other key closes.

**`tachi review`** lists the copies waiting, each with its name, its project folder, when it was
made and how many changes it holds. `tachi review <name>` opens one in the same review, and `tachi
review <name> --discard` discards one after a y/n question. A copy whose session is still running is
refused: `The copy <name> is still in use by a running Tachikoma session; review it after that
session ends.` A crashed session's box is removed first, and two reviews of one copy take turns.

### The network

`--network off` (the default) or `--network on`, or `"network"` in the settings file. Off, nothing
in the box can reach the internet, so an install, a `git push` or a download there fails, and every
failed command's result gets one more line: `(The box's network is off, so nothing in it can reach
the internet. To allow it, launch with --network on.)` On, the box has Docker's ordinary network.
Tachikoma's own requests to the model go from your machine either way. Without the sandbox,
`--network` does nothing and says so: `--network acts only with the sandbox on; it was ignored`. A
list of allowed sites is planned for release 8.

### The box's limits

The box gets limits on memory, CPUs and processes, so a runaway command cannot take your machine.
The defaults, 4 GB of memory, 4 CPUs and 1,024 processes, were chosen from Tachikoma's own test
suite run in the box, which peaked at 2.0 GB, 4.5 CPUs and 348 processes. They are the share of
Docker those numbers are on the PC they were measured on (4 GB of about 31 GB, and 4 of 24 CPUs), so
they scale with Docker's size:

- a bigger Docker gets the same share: one with 128 GB and 64 CPUs gets about 16 GB and 10.7 CPUs;
- a smaller one gets less, always leaving 1 GiB of memory for Docker itself, and 1 CPU when it has
  more than one: one with 2 GiB and 2 CPUs gets 1 GiB and 1 CPU. A Docker with little more than
  1 GiB of memory, or less, stops the launch, unless you set the memory yourself.

On Linux's Docker Engine, Docker's memory is the whole machine's, so a 4 GiB laptop's box may use up
to 3 GiB. A limit is a ceiling, never memory set aside. `"sandboxLimits"` in the settings file
changes them, each one optional:

```json
{ "sandboxLimits": { "memory": "8g", "cpus": 2, "pids": 2048 } }
```

- `memory` is a whole number of gigabytes or megabytes, `"8g"` or `"512m"`; `cpus` a number above 0,
  with at most 9 decimal places; `pids` a whole number of processes from 1. A value above what
  Docker has stops the launch, naming it.
- A command over the memory limit is stopped, and its result says so: `(Stopped: the command used
  more than the box's memory limit of 4g. "sandboxLimits" in settings.json changes it.)` Over the
  process limit, new processes fail with the command's own error.
- Where Docker cannot apply a limit (some Linux setups), a grey launch line says so, and the box
  runs without it.
- There is no disk limit: Docker Desktop accepted one but did not hold to it (measured).

## Full screen

Tachikoma starts on the terminal's alternate screen (a separate screen the terminal keeps, which
`vim` and Claude Code's full-screen mode also use) and draws the conversation there itself, above
the prompt and the status line. When you quit, the terminal shows what it showed before you
started.

- **Scrolling:** the mouse wheel scrolls the conversation wherever the pointer is, 3 lines a notch.
  `--scroll-speed <n>` (or `TACHI_SCROLL_SPEED`) sets any number above 0 and up to 20, fractions
  included: 0.5 scrolls a line every second notch. PgUp and PgDn scroll half a screen, Ctrl+Home
  goes to the top, Ctrl+End to the latest line, and Shift+Up and Shift+Down move one line. Up and
  Down stay with the prompt. The keys also work during a turn, while a question waits and during
  Ctrl+R's search.
- **Following:** at the bottom, the view follows new output. Scrolled up, it stays where you put it,
  and a grey row at its foot counts the lines that came in below (`↓ 12 new lines · Ctrl+End`).
  Ctrl+End or scrolling back to the bottom follows again, and so does sending a prompt.
- **The prompt** takes at most half the screen's rows, so the conversation stays in view; a longer
  prompt scrolls inside its own box, following the cursor.
- **The scroll bar** takes the right-hand column once the conversation is longer than the screen.
  Click its track to jump there, or drag the thumb.
- **Selecting and copying:** drag with the left button to select, shown in reverse colours; dragging
  past the top or bottom scrolls. A double-click selects a word, where a file path (a Windows one
  too) or a web link counts as one word; a triple-click selects the line. Letting go copies the
  text exactly as selected, a line wrapped on screen as one line, and the hint line, just above the
  status line (where `? for shortcuts` shows), says `Copied 312 characters` when it is showing.
  The selection stays until the next click. A copy goes to the terminal (as OSC 52) and also to the
  system's own tool: `Set-Clipboard` on Windows, `pbcopy` on macOS, `wl-copy` or `xclip` on Linux.
  With no tool to run (Linux with no display, as over SSH), the terminal alone copies, and the hint
  line says so.
- **Shift+drag** uses the terminal's own selection instead, where the terminal offers it, as
  Windows Terminal does.
- **Clicks:** a click in the prompt puts the cursor there. A click on a `/` menu entry runs it, on
  an `@` entry fills it in, and on a model in `/model` picks it.
- **The detail view:** Ctrl+O (the last turn's tool calls in full) and `/tasks t3` (a subagent's
  full record) open in the conversation's place. The prompt is hidden meanwhile; the status line
  stays, and a dim row names the keys. j and k or Up and Down move a line, g and G or Home and End
  go to the top and bottom, and the wheel, the scroll bar, the scroll keys and selecting work as in
  the conversation. q, Esc or Ctrl+O close the view. Ctrl-C stops a turn that is running and
  leaves the view open; with nothing running it closes the view. A permission question closes the
  view, so y and n go to the question.
- **Searching the detail view:** `/` searches as you type, ignoring case. Esc while typing drops the
  search, and Enter keeps it, or drops it when nothing matches; once it is kept, n and N go to the
  next and previous match. With a search kept, q, Esc and Ctrl+O still close the view.
- **`[`** in the detail view prints it into the terminal's normal scrollback, for the terminal's own
  search, selecting and scrolling. A running turn, and any subagents, go on meanwhile, out of
  sight. q, Esc or Ctrl-C bring the view back, and so does a permission question. A paste does
  nothing while the view is printed out.
- **`/screen`** switches between full screen and classic during a session, but not to full screen
  when the output is not a terminal or under CI. Going to classic prints the whole conversation
  into the terminal's scrollback, so anything already printed there in classic mode earlier in the
  session shows twice; going to full screen shows everything so far.
- **Classic mode** is the screen from before release 5: finished lines go into the terminal's own
  scrollback, as in most command-line programs. Start with `--classic`, or set `TACHI_CLASSIC` to
  anything but empty or `0`. It is also used when the output is not a terminal, and under CI. In
  classic, Ctrl+O and `/tasks t3` print below as before; Shift+Up and Shift+Down act as Up and
  Down, Ctrl+Home and Ctrl+End as Home and End, and PgUp and PgDn do nothing. `-p` runs have no
  screen at all.

## Settings

`~/.tachikoma/settings.json` (on Windows `%USERPROFILE%\.tachikoma\settings.json`) holds the
options you would otherwise type each time, so a plain `tachi` starts the way you want. It is the
only settings file Tachikoma reads: a project has none of its own, so a repository you clone cannot
change how Tachikoma behaves. `/settings` opens it in your editor, making it first if it is missing.

```json
{
  "lead": "anthropic:claude-opus-5-5",
  "mode": "ask",
  "status": ["lead", "context", "cost"],
  "editorMode": "vim",
  "vimInsertModeRemaps": { "jj": "<Esc>" },
  "editor": "code --wait"
}
```

Every entry is optional; one left out keeps its default.

| Entry | What it sets | Default | An edit while Tachikoma runs applies |
|---|---|---|---|
| `lead` | the lead model, as `--lead` | none | as `/lead`: at once when idle, otherwise when the turn ends. Taken out, the session keeps its lead |
| `mode` | `"ask"`, `"project"`, `"auto"` or `"never"`, as `--mode`; `"never"` only with `"sandbox": "copy"` | `"ask"` | at the next launch only (below); Shift+Tab still switches the mode |
| `sandbox` | `"off"`, `"live"` or `"copy"`, as `--sandbox`: see [The sandbox](#the-sandbox) | `"off"` | at the next launch only (below) |
| `network` | `"off"` or `"on"`, as `--network` | `"off"` | at the next launch only (below) |
| `judge` | auto mode's judge, as `--judge` | the lead's model | at the next launch only (below) |
| `sandboxLimits` | the box's memory, CPUs and processes: see [The box's limits](#the-boxs-limits) | scaled to Docker's size | at the next launch |
| `dangerousCommands` | your own rules for [the dangerous-command check](#the-dangerous-command-check) | none | a rule added, or a kind switched back on, at once; a kind switched off, or a rule removed, at the next launch, with a red warning |
| `effort` | as `--effort` | the model's own | from the next request, the fallback's and the subagents' too |
| `fallback` | as `--fallback` | off | from the next refusal; a rescue under way finishes on the old one |
| `worker` | as `--worker` | the lead's model | for subagents started after it; running ones keep theirs |
| `maxTasks` | as `--max-tasks`, a number | 8 | for subagents started after it; lowering it stops none |
| `status` | the status line's parts, as `--status`, as a list: `["lead", "context"]` | all of them | at once |
| `screen` | `"full"` or `"classic"`, as `--classic` | `"full"` | as `/screen`, waiting where `/screen` waits |
| `scrollSpeed` | lines a wheel notch scrolls, as `--scroll-speed` | 3 | from the next notch |
| `editorMode` | `"vim"` or `"normal"`: see [Vim mode](#vim-mode) | `"normal"` | at once, as `/vim` |
| `vimInsertModeRemaps` | two characters that leave vim's INSERT mode, mapped to `"<Esc>"` | none | from the next key |
| `editor` | the command for [the external editor](#the-external-editor) | Notepad on Windows, `vi` elsewhere | from the next Ctrl+G, `/settings` or `/keybindings` |

- **Which wins:** a flag, then its variable where it has one (`TACHI_LEAD`, `TACHI_WORKER`,
  `TACHI_CLASSIC`, `TACHI_SCROLL_SPEED`; an empty one counts as unset), then the file, then the
  default. `-p` runs read the file too. With no lead anywhere, `tachi` says how to put one in the
  file.
- **Mistakes:** a value its flag would refuse stops Tachikoma at launch, in the flag's words, naming
  the entry: `settings.json: "mode" must be one of: ask, project, auto, never (got "x")`. An entry
  Tachikoma does not know gets a grey line, and the rest applies.
- **Nothing is saved to the file.** `/lead`, a `/model` pick, `/screen`, `/vim` and Shift+Tab change
  only the window you use them in, since every open window follows the file. To make a change last,
  edit the file.
- **Edits apply while Tachikoma runs,** in every open window, each with a grey line such as
  `lead is now ollama:qwen3:8b (from settings.json)`. An entry a flag or variable gave at launch
  stays as given for that session, and the line says so: `settings.json's "mode" was left as --mode
  set it for this session`. Taking an entry out goes back to the flag's value, or the default. An
  edit that breaks the file keeps the last good settings, and a red line says what is wrong. An
  empty or missing file changes nothing, as editors such as Notepad empty the file, or put a new one
  in its place, while they save; so deleting the file keeps the settings in force until the next
  start. Each line an edit says also shows in the hint row (the row over the status line, where
  `? for shortcuts` shows) until your next key or paste, in its own colour: the edit's last line,
  with `(+2 more above)` or the like when it said more. It shows over vim's mode, which comes back
  after the key or paste; other hints, such as a question's or the queue's, keep the row. Warnings
  found as Tachikoma starts are printed then, not in the hint row.
- **Except `"mode"`, which applies at the next launch only,** so a shell command you allowed cannot
  rewrite the file to put the session in `project` mode. An edit to it gets a grey line, `"mode"
  changes in settings.json take effect at the next launch; the mode stays ask`, and the mode stays;
  Shift+Tab still switches it. `"sandbox"`, `"network"` and `"judge"` wait for the next launch too,
  with the same kind of line, so a command cannot change where commands run or who judges them.
- **`"mode": "never"` needs `"sandbox": "copy"`,** as `--mode never` needs `--sandbox copy`: without
  it, the launch stops with one line.
- **The file tools never touch the settings file or the keys file,** in any mode, even when the
  project is your home folder, so the model cannot change them with its file tools. A shell command
  is not stopped, but it asks first in `ask` and `project`, and the judge decides it in `auto`. In
  the sandbox, where `never` runs, the box cannot see either file.

## Keys

Every key Tachikoma reacts to is a named action, with Claude Code's names where Claude Code has the
same thing. `~/.tachikoma/keybindings.json` moves them, in Claude Code's own format, so a Claude
Code `keybindings.json` can be copied across as it is. `/keybindings` opens it in your editor,
making it first if it is missing.

```json
{
  "bindings": [
    { "context": "Chat", "bindings": { "ctrl+e": "chat:externalEditor", "ctrl+s": null } }
  ]
}
```

- **Contexts** say where a key acts: `Global` everywhere, `Chat` at the prompt, `Autocomplete` in
  the `/` and `@` menus, `Confirmation` at a question, `HistorySearch` in Ctrl+R's search, `Select`
  in the model list, `Transcript` in the detail view, `Scroll` in full screen, and `Review` in copy
  mode's review. A context's own binding comes before Global's.
- **Keys** are written as Claude Code writes them: `ctrl`, `alt` (or `meta`, `opt`, `option`) and
  `shift`, joined to a key by `+`, case ignored, with special keys by name (`escape`, `enter`,
  `tab`, `space`, `up`, `down`, `left`, `right`, `pageup`, `pagedown`, `home`, `end`, `backspace`,
  `delete`, and `wheelup` and `wheeldown` for the mouse wheel). A key matches only with exactly the
  modifiers written: `up` is not Ctrl+Up.
- **Chords** are keys separated by a space, such as `"ctrl+x ctrl+e"`, each within 3 seconds of the
  one before. The keys pressed so far show in the hint row (`ctrl+x ...`).
- **`null` unbinds** a key in its context, even where an outer context binds it: `"ctrl+t": null`
  under `Chat` stops Ctrl+T at the prompt, and Global's Ctrl+T still works elsewhere.
- **`command:<name>`** runs `/exit`, `/errors`, `/model`, `/screen`, `/tasks`, `/vim`, `/settings`
  or `/keybindings`; during a turn it waits its turn, as a typed command does.
- **Bindings come first.** The prompt's editing keys (Ctrl+A, Ctrl+E, Ctrl+K, Ctrl+U, Ctrl+W, Alt+B,
  Alt+F and the rest) act only on a key no binding takes, so binding Ctrl+E to
  `chat:externalEditor` replaces end-of-line. The editing keys themselves, and vim's, cannot be
  moved.
- **Reserved:** Ctrl+C and Ctrl+D, and Ctrl+M, Ctrl+[, Ctrl+I and Ctrl+H, which arrive as Enter,
  Esc, Tab and Backspace, cannot be bound or unbound.
- **Help follows the file:** `?`'s list and every hint that names a key, such as "Esc to stop", name
  the keys bound now.
- **Problems** each get one grey line in the conversation, and the rest of the file applies: a
  context or action Tachikoma does not have, a misspelled modifier, a space beside `+`, a reserved
  key, a command a key cannot run, or the same key twice in one context (the first stays). Actions
  and contexts only Claude Code has, such as `chat:fastMode`, are counted in one line instead
  (`3 entries skipped: Tachikoma has no chat:fastMode, ...`), as are keys held with Cmd or Super,
  which Tachikoma cannot read. A file that is not valid JSON keeps the default keys at launch, and
  the last good keys after.
- **Edits apply at once,** as for the settings file, and an empty or missing file changes nothing
  until the next start. As there, each line an edit says also shows in the hint row until your next
  key or paste, and so does a problem in the keys file found as Tachikoma starts.
- **Except at a permission question, where the keys stay as they were at launch, and for a key
  newly bound to switch the mode, which does nothing until the next launch,** so a command that
  rewrites the file cannot make a key answer yes, nor bind the mode switch to a key you type
  anyway. A question reads the keys you started with, all of them, and names them in its hint; a
  key switches the mode only where the keys you started with switch it too, so one an edit adds does
  nothing, while taking the mode key out works at once. A grey line says so when an edit changes
  what a question reads (`Confirmation`, `Scroll` or `Global`) or lets a key switch the mode that
  did not at launch: `keybindings.json: at a permission question the keys stay as at launch, and a
  key newly bound to switch the mode does nothing, until the next launch; the rest apply now`. The
  rest applies at once.

The default keys:

| Context | Keys and their actions |
|---|---|
| Global | `ctrl+c` app:interrupt, `ctrl+d` app:exit, `ctrl+t` app:toggleTodos, `ctrl+o` app:toggleTranscript |
| Chat | `enter` chat:submit, `shift+enter` chat:newline, `ctrl+j` chat:newline, `shift+tab` chat:cycleMode, `alt+p` chat:modelPicker, `ctrl+z` chat:undo, `ctrl+_` chat:undo, `escape` chat:cancel, `ctrl+r` history:search, `up` history:previous, `ctrl+p` history:previous, `down` history:next, `ctrl+n` history:next, `ctrl+g` chat:externalEditor, `ctrl+x ctrl+e` chat:externalEditor, `ctrl+s` chat:stash, `alt+v` chat:imagePaste (Windows; `ctrl+v` on macOS and Linux, and both under WSL) |
| Autocomplete | `tab` autocomplete:accept, `escape` autocomplete:dismiss, `up` autocomplete:previous, `down` autocomplete:next |
| Confirmation | `y` confirm:yes, `n` confirm:no, `escape` confirm:no |
| HistorySearch | `ctrl+r` historySearch:next, `escape` historySearch:accept, `tab` historySearch:accept, `ctrl+c` historySearch:cancel, `enter` historySearch:execute |
| Select | `down` select:next, `up` select:previous, `enter` select:accept, `escape` select:cancel |
| Transcript | `q` transcript:exit, `ctrl+c` transcript:exit, `escape` transcript:exit, `[` transcript:print, `/` transcript:search, `n` transcript:nextMatch, `shift+n` transcript:previousMatch, `j` transcript:lineDown, `down` transcript:lineDown, `k` transcript:lineUp, `up` transcript:lineUp, `g` transcript:top, `home` transcript:top, `shift+g` transcript:bottom, `end` transcript:bottom |
| Scroll | `pageup` scroll:pageUp, `pagedown` scroll:pageDown, `ctrl+home` scroll:top, `ctrl+end` scroll:bottom, `shift+up` scroll:lineUp, `wheelup` scroll:lineUp, `shift+down` scroll:lineDown, `wheeldown` scroll:lineDown |
| Review | `up` review:previous, `down` review:next, `space` review:toggle, `enter` review:diff, `a` review:apply, `l` review:later, `d` review:discard, `m` review:merge, `s` review:skip |

**Shift+Enter in Windows Terminal** makes a new line, as elsewhere. Windows Terminal sends it as
plain Enter, so while Tachikoma reads the keys it turns on Windows Terminal's own way of reporting
each key with its Shift, Ctrl and Alt (its "win32 input mode"), and turns it off when it hands the
terminal to your editor and when it quits. Ctrl+J, or a backslash then Enter, also make a new line
in every terminal.

## The external editor

Ctrl+G, or Ctrl+X then Ctrl+E, opens the prompt in an editor. When the editor closes, what you saved
becomes the prompt, with the cursor at the end; Ctrl+Z brings back the text before.

- **Which editor:** `VISUAL`, then `EDITOR`, then the settings file's `"editor"`, then Notepad on
  Windows and `vi` elsewhere. It runs through the system's shell (`cmd.exe` on Windows, `/bin/sh`
  elsewhere), as Git runs its editor, so the entry can carry its own options: `"code --wait"`.
- **On Windows the editor starts with `NoDefaultCurrentDirectoryInExePath=1`,** so `cmd.exe` looks
  for a bare name such as `code` on PATH only, not in the project first, where a planted `code.cmd`
  would run. A VS Code that `"code --wait"` starts passes it on to its own `cmd.exe` terminals: a
  bare `gradlew` or `build.bat` in the current folder does not run there until VS Code restarts,
  while `.\gradlew` still does. PowerShell terminals are not affected.
- **The file** is `prompt.md` in a new folder in the system's temporary folder (your own on
  Windows; on macOS and Linux only you can read it), deleted afterwards. An editor that runs in the
  terminal, such as vim or nano, gets the whole terminal; full screen steps aside and comes back
  after, as for `[`. The editor gets the environment shell commands get, without the API keys.
- **Meanwhile** a turn already running carries on, and its output is there when you come back; a
  permission question waits until you are back. A queued `/screen`, `/settings` or `/keybindings`
  waits for the editor to close. Ctrl-C typed in the terminal while the editor is open is the
  editor's: Tachikoma ignores it, as Git does, so the session and a running turn go on; some
  editors, such as `code --wait`, may act on Ctrl-C themselves. Until the editor closes, the
  terminal shows `Waiting for your editor to close the file... (Tachikoma ignores Ctrl-C until
  then)`, as Git does too; the line goes when you come back.
- **If the editor fails or is not found,** the prompt stays as it was and a line says why, either
  `The editor failed (<reason>). Set VISUAL or EDITOR, or "editor" in ~/.tachikoma/settings.json.`
  or `<command> was not found. Set VISUAL or EDITOR, or "editor" in ~/.tachikoma/settings.json.`
  (on Windows the path reads `~\.tachikoma\settings.json`).
- **Pictures:** a picture's `[Image #2]` marker is plain text in the file; back in the prompt it
  carries its picture again if the prompt held that picture when the editor opened.
- **`/settings` and `/keybindings`** open those files in the same editor, making a missing one first
  (`{}`, and `{"bindings": []}`). Saving is enough: the change applies while the editor is still
  open.

## Stash

Ctrl+S, as in Claude Code: with text in the prompt, the text, its cursor and any pictures go aside,
the prompt clears, and the hint row shows `Stashed · Ctrl+S to bring back`. Ctrl+S on an empty
prompt brings them back. With text in the prompt and something already stashed, the two swap, so
nothing is lost. There is one slot, kept until you quit. After Up has brought back a past prompt,
Ctrl+S puts that prompt aside with the draft you were typing before Up: once Ctrl+S brings the
prompt back, Down brings the draft back.

## Pictures

Pictures go to the model with your message.

- **From the clipboard:** Alt+V on Windows, Ctrl+V on macOS and Linux, and either under WSL. An
  `[Image #1]` marker goes in at the cursor at once, and the hint row shows `Reading picture...`
  until the picture is read. Windows reads it through Windows PowerShell, macOS through `osascript`,
  and Linux through `wl-paste` or `xclip`; with neither, the key says `No clipboard reader here:
  install wl-paste or xclip.` With no picture on the clipboard, the marker goes and a line says
  `No picture on the clipboard.`
- **From files:** pasting, or dragging into the terminal, paths to .png, .jpg, .jpeg, .gif or .webp
  files, one or several, with or without quotes, adds those pictures, when every file is there. A
  file's type is read from its contents, not its name. A typed path stays text.
- **A pasted path starting with two slashes stays text,** such as `\\server\share\cat.png` or
  `//server/share/cat.png`, and Tachikoma never looks at the file: on Windows looking would connect
  to that machine, which could capture a hashed copy of your Windows login, or freeze the screen
  while it fails to answer.
- **Which pictures a message carries:** each picture has a number for the session, and its marker in
  the prompt carries it: delete the marker and the picture is left out, and undo brings both back. A
  picture goes once, at its first marker; a later copy, a marker you type yourself, and one brought
  back from prompt history are only text. The stash and the queue keep their pictures. The model can
  be pointed at an earlier picture by its number.
- **What is sent:** pictures stay in the conversation and go again with each later turn, to the lead
  and the fallback, never to subagents. Each request shrinks them, from the originals, to what its
  provider takes, in the table below. A format the provider does not list goes as PNG, and an
  animated GIF goes to OpenAI and the ChatGPT plan as its first frame. A request still over its
  limit leaves out its oldest pictures, each replaced by a note (`[Image #2 left out: the request
  was over Anthropic's 32 MB]`), and a grey line says how many.
- **When a provider refuses:** a request with pictures that gets an invalid-request answer (HTTP
  400) shows the provider's words and asks `Send again without the pictures? [y/n]`, since that
  answer does not say whether the pictures caused it. y sends it again with a note in each picture's
  place, and that model gets notes instead of pictures for the rest of the session; n changes
  nothing.
- **Pictures are kept in memory** until you quit, never on disk. Prompt history keeps a message's
  words and markers, not its pictures.

| Provider | Each picture | Each request |
|---|---|---|
| Anthropic | under 10 MB as base64 and 8000×8000 pixels; 2000 a side once a request holds more than 20 pictures, earlier turns' included | under 32 MB; 600 pictures, or 100 for models with a 200k-token window |
| OpenAI | as it is: OpenAI resizes | under 512 MB; 1,500 pictures |
| Kimi | within 4096×2160, Kimi's recommendation | under 100 MB |
| OpenRouter, Ollama, the ChatGPT plan | as it is | no limit documented |

## Vim mode

Claude Code's vim mode, as its docs describe it: its modes, motions, `f`/`t`/`;`/`,`, `%`, operators
with motions and text objects, VISUAL and VISUAL LINE, `p`/`P`, `.` to repeat, `u` to undo, and
counts (`3w`, `2dd`, `d3w`). See [Known limits](#known-limits) for the text objects.

- **On:** `"editorMode": "vim"` in the settings file, or `/vim` for this window only (`/vim on` and
  `/vim off` set it). It starts in INSERT. The mode shows in the hint row (`-- NORMAL --`) whenever
  no other hint takes it.
- **Esc** in INSERT or VISUAL goes to NORMAL and does not stop a turn; in NORMAL it does what Esc
  does without vim mode. So in INSERT it takes Esc twice to stop a turn, and the working line says
  `Esc Esc to stop`. Ctrl-C always stops. Enter sends from NORMAL too. `j` and `k` at the first
  or last line go through prompt history, `/` in NORMAL opens Ctrl+R's search, and `?` lists the
  keys.
- **Keys bound in the keys file keep their actions,** Ctrl and Alt keys among them; vim's own keys
  cannot be moved. In VISUAL a Ctrl or Alt key goes back to NORMAL first, as in Claude Code.
- **`vimInsertModeRemaps`** in the settings file: two characters typed within a second, such as
  `"jj": "<Esc>"`, go to NORMAL and leave neither in the text. Each is a letter, digit, punctuation
  mark or symbol, not a space; `"<Esc>"` is the only target.
- **VISUAL's selection** shows in reverse colours.
- **Yanks stay inside Tachikoma,** never on the system clipboard, as in Claude Code. A paste always
  goes in as text, in any mode. Counts stop at 10,000, as Claude Code's do.

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
the permission mode would ask about is refused, and the model is told so. For the same reason,
instruction files outside the project are left out, and a line on stderr names them. A background
subagent runs in the foreground, since there is no later turn to read its answer in.

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
- **Modes and the sandbox:** in `auto` the judge still decides, and its no is final; a dangerous
  command is refused. With the sandbox, the launch lines go to stderr, the image must already be
  built (`tachi sandbox build`), and copy mode keeps its copy, saying on stderr after the answer
  `Changes kept for review: tachi review <name>`.
- **Exit codes:** 0 when the run finished; 1 when a request failed, the model refused or hit a limit,
  or an action that needed your answer was refused (a refusal by the judge, or in `never`, which
  nobody was asked about, leaves the code as it is); 130 when stopped with Ctrl-C; 143 on SIGTERM
  and 129 on SIGHUP. If
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

For `openai:` leads at OpenAI's own address (no `OPENAI_BASE_URL`, or `https://api.openai.com/v1`),
the status line shows how much of the context window is left from a table of OpenAI's model pages
as they stood on 2026-10-28; a dated name such as `gpt-5.5-2026-04-23` finds its model's row. A
model not in the table, or another address, shows the tokens in use.

Shell commands never see these API keys, so a command cannot print one back to the model. A command
that needs one of them does not get it either.

The Anthropic SDK still adds any headers you set in `ANTHROPIC_CUSTOM_HEADERS`, so do not put an
`Authorization` header there.

## Known limits

Each is fixed in a later release, unless it says otherwise.

- **An approved shell command can still read your login.** Commands on your own machine run with your
  own access, so one you approve can read files and the system keychain. Keeping keys from commands
  and the data folder from the file tools prevents accidents, not a determined command. In the
  sandbox, commands run in a box that cannot see the login.
- **On a ChatGPT plan, `--effort` does nothing yet.** Whether the plan accepts a reasoning setting is
  still to be measured, and no release is set for it yet.
- **The context left is shown only for models whose window is known:** Anthropic models,
  ChatGPT-plan models (from the account's model list, once the first reply arrives), and the OpenAI
  API models in a table as of 2026-10-28 (see [Providers](#providers)). Other models show the
  tokens in use; no release is set for them yet.
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
- **The history is never shortened** (release 8). When the context window is full, the turn ends
  with an error. Switching `/lead` to a model with a smaller window can make the next request fail.
- **No budget limit** (release 11). An interactive session runs until you stop it.
- **Shell commands have no time limit** (release 11). A command that keeps its output open runs
  until you cancel it. Closing the terminal, SIGTERM, and Ctrl-C in headless mode stop running
  commands; a hard kill or a crash of Node does not, and on macOS and Linux the command then keeps
  going.
- **The file tools check a path, then use it.** Another program that swaps a folder for a link in
  between could redirect a write, and a hard link inside the project to a file outside it looks like
  an ordinary file. Both need something already running on your machine. In the sandbox the file
  tools work inside the box, where a link can lead only to what the box can see.
- **On Windows, cancelling cannot stop a program whose shell has already exited.** Cancel still
  returns at once. On macOS and Linux it does stop it.
- **On Windows, shell exit codes are only 0 or 1.** PowerShell reports only whether the last command
  succeeded, so a program's own exit code is lost.
- **On Windows, PowerShell error messages repeat the whole command**, including the line Tachikoma
  puts first to make the output UTF-8. The ways around it that were tried either lost the exit code or
  turned error messages into XML.
- **A hard kill cannot put the terminal back.** Ending Tachikoma from Task Manager, or anything else
  that stops it without warning, can leave its tab on the alternate screen, still taking the mouse,
  and in Windows Terminal still in the key mode Tachikoma turns on for Shift+Enter. Closing that tab
  clears it (not planned to change).
- **Windows Terminal and other terminals built on Windows' ConPTY can leave fragments of earlier
  output on screen** in full screen, as Claude Code's own documentation warns (no release is set).
- **Copying cannot check that it worked.** Tachikoma cannot tell whether the terminal took the copy,
  and it says "Copied" before the system's tool has finished; a tool that then fails is reported.
  Where only the terminal copies, a terminal that ignores the copy leaves the clipboard unchanged,
  and Tachikoma cannot tell (no release is set).
- **Subagents only read.** Ones that edit or run commands come with the budget controller (release
  11), each with its own copy of the project.
- **`find_files` patterns skip names that start with a dot** unless the pattern names the dot, as a
  shell's do: `**/*.yml` misses `.github/workflows/ci.yml`, and `.github/**/*.yml` finds it (not
  planned to change).
- **Instruction files are read once, at the start.** A file edited during a session counts from the
  next, and files in subfolders, which Claude Code reads as it works there, are not read: both need
  the system prompt to change during a session, which prompt caching rules out (no release is set).
- **Prompt history keeps a message's words, not its pictures.** Up or Ctrl+R brings back
  `[Image #1]` as plain text, which carries no picture; add the picture again to send it (no release
  is set).
- **Windows Terminal keeps Ctrl+V** and pastes the clipboard's text itself, so Tachikoma never sees
  it: pictures are Alt+V there, under WSL too, and binding `ctrl+v` in the keys file does nothing in
  it (not planned to change).
- **A key meant for one question can answer the next one.** When the question on screen closes
  without your answer (cancelled, for example because its subagent stopped) while you are part way
  through a shortcut of two or more keys, the next question appears and your next key is read by it
  alone, so it can answer that question (for example `y`, as yes). The same holds for a key pressed
  just as one question replaces another. Carrying the half-typed shortcut into the next question
  instead was worse in a test of random keys. The test has far more shortcuts and cancels than real
  use, so these are its rates, not real use's: of 100,000 runs, 1,627 answered the next question
  with a shortcut begun at the one before (607 of them yes), against 191 where the next key, read
  alone, answered differently than the shortcut would have, 63 of them yes (no release is set).
- **On Windows, a `%` in a path given to the editor can be changed on the way:** the editor runs
  through `cmd.exe`, which reads `%NAME%` as a variable, so a user folder with `%` signs in its name
  could give the editor the wrong file for Ctrl+G or `/settings` (no release is set).
- **Vim mode's text objects are the ones Claude Code's docs list** (`iw`, `aw`, `iW`, `aW`, and `i`
  or `a` with `"`, `'`, `(`, `[` or `{`). Claude Code's own code also takes `` ` ``, `b`, `B`, `<`,
  `>`, `)`, `]` and `}` after `i` or `a`; those are not built yet (no release is set).
- **Tested on Windows 11 only.** Release 13's automatic tests will run the suite on Linux and macOS;
  until then, those are untried. The sandbox was tried on Docker Desktop for Windows only: Docker
  Desktop on macOS and Linux, and Podman, have not been tried, and live link's full session, refused
  on the test PC's folders, waits for those tests too. On Linux the box runs as your own user and
  group ids unless Docker is rootless, while Docker's documentation describes Docker Desktop for
  Linux as mapping your user to root (user 0) in containers, so there the box may be unable to
  write the project or the copy.

Release 7's limits follow, grouped by part. These are the rarer cases, left as limits rather than
more code; none has a release set to change it, unless it says so.

### The dangerous-command check's limits

- **Code that is not on the line is not read:** a script (`python wipe.py`); code given inline to an
  interpreter (`python -c`, `node -e`), or fed to one in a here-document or a piped string in the
  line; and code sent to a container or another machine (`docker exec -i c sh`, `ssh host sh`). Nor
  is code piped to R, or the command that `yarn exec` or `yarn dlx` runs (`yarn dlx` itself still
  counts as installing). In PowerShell, a relative path to the shell's input is not followed after a
  change of folder (`Set-Location`, or its `cd` and `sl` names).
- **Commands git runs for you are not read either,** for the same reason: `git submodule foreach
  '<cmd>'`, `git bisect run <cmd>`, an alias such as `git -c alias.x='!<cmd>' x`, a `-c
  core.pager=` or `-c core.sshCommand=`, and a `GIT_SSH_COMMAND=` before the command.
- **Values made while the line runs.** Bash runs a command hidden in a value it does arithmetic on
  (`a[$(cmd)]`). The check asks when it can see such code on the line, but not when the value comes
  from a command's output, a file, a pipe or a download (including `$(( $(cmd) ))`), nor from a file
  the line writes and then reads back. Also unseen: inside backticks, a copy of `$1` the outer line
  set; GNU sed's `e` command, which runs a command. `npx --shell` asks rather than naming the
  program it runs.
- **A delete of a whole folder can be missed** through links already in the project, or made by `cp
  -s` or `cp -l`; through a `CDPATH` set in your own environment; through `wsl ~` and `/mnt/c/...`
  paths; through cmd's `start /d`; with `rm -rf **` and `?*`; when `HOME` is changed on the line,
  which does not change what `~` means to the check, or a home path is built from variables; for
  registry keys, `find -delete` and aws's `batch-delete-*`; for `C:.` targets; and through
  PowerShell's `switch` and per-item blocks (`Sort-Object { }`), which run like loops. A line of
  thousands of `cd`s and climbing paths takes seconds to check.
- **A recursive delete that takes its list from a pipe** has no target on the line to check:
  `Get-ChildItem | Remove-Item -Recurse -Force`, `ls | xargs rm -rf`. In auto mode the judge
  decides.
- **A delete made by mirroring an empty folder** is not seen: `robocopy <empty> <dir> /MIR` or
  `/PURGE`, and `rsync -a --delete <empty>/ <dir>`.
- **On macOS, a home or project path written in another letter case** (`/users/ME` for
  `/Users/me`) is not seen as that folder by the delete check, though macOS's disks ignore case by
  default.
- **Some harmless lines ask:** `Start-Process notepad`, `$tool --version`, and `bash -c 'echo "hi"'`
  typed in PowerShell; rarer .NET calls such as `[System.Collections.Generic.List[string]]::new()`;
  two relative `cd`s on one line (`cd sub && make && cd .. && rm -rf dist`), `pushd` and `popd`, `cd
  build && rm -rf *`, `cd sub && npx vitest` when `sub` has no vitest of its own, and `pwsh -Command
  { cd .. } -args 1`. In the sandbox, every `npx` counts as installing software, even of a program
  the project has, since the check looks for it on your machine, not at `/work`.
- **Your own rules match word by word from the start,** so an option between the words hides the
  command: `make -C sub deploy` does not match a rule `make deploy`.

### Protected paths' limits

- **Git's settings given by `GIT_CONFIG_COUNT` variables are not read,** nor are those of a project
  that is itself a bare repository (a repository with no working files).
- **Git installed only as a `.cmd`** (old msysgit 1.x) counts as no git, so only the fixed list
  protects.
- **Reading git's settings at launch has no time limit,** so an include naming a pipe or a network
  share that has stopped answering hangs the launch.
- **Protected paths are worked out once, at launch.** A hooks folder or include named during the
  session, for example by `git config core.hooksPath scripts` run without the sandbox, is not
  protected until the next launch.
- **A project inside a Claude Code worktree** (`<repo>/.claude/worktrees/<name>`) is inside a
  protected folder, so every write in it asks.
- **On Linux and macOS, a `core.hooksPath` or include path with `..` after a link inside the
  project** is worked out as text, while the system follows the link first.
- **pnpm's `node_modules` files are hard links,** so writes there ask.

### The sandbox's limits

- **A folder whose name holds `:`** cannot be mounted into the box, as Docker reads `:` as a
  separator.
- **Docker's check at launch has no time limit,** so a Docker that has stopped answering hangs the
  launch; Ctrl-C stops it.
- **A Docker that stops answering during a session:** Esc may not stop a running command, as
  stopping it is another Docker call. Leaving can hang too: in live link while the box is removed,
  and in copy mode on `Stopping the box...`, with no key that works. Closing the terminal tab ends
  it, and in copy mode the copy is kept.
- **SELinux** (on in Fedora, RHEL and the like) denies the box the project folder: commands in it
  get "permission denied". Docker's `:z` mount option fixes it, but relabels your folder for good,
  so Tachikoma does not add it.
- **On Windows, a user outside the `docker-users` group** gets Docker's `Access is denied`, which
  Tachikoma reports as Docker not running.
- **A data folder Docker cannot share fails at box start:** a `TACHI_DATA_DIR` outside Docker
  Desktop's shared folders, and maybe Ubuntu's snap-installed Docker with a data folder under a
  hidden home folder (not measured). So does a project outside those shared folders in live link, on
  Docker Desktop for Linux or macOS (on Linux, by default, only your home folder is shared).
- **A project on a mapped network drive** resolves to a `\\server\share` path that Docker Desktop
  cannot mount.
- **A command can stop its own box:** `kill -9 -1` ends every process of the box's user, and the box
  with them: `The sandbox stopped working: the box stopped. Shell and file tools are off until
  Tachikoma is launched again.`
- **A command that fills the box's process limit** right after Esc can keep Esc's own stop from
  starting; `Cancelled` shows anyway. Where Esc cannot reach the box at all, the sandbox stops.
- **A box Docker made but could not start,** or one made just as you pressed Ctrl-C at the launch,
  stays until the next launch removes it. If Docker hangs while the box stops at the end, `Stopping
  the box...` stays up with every key off; the copy is kept, and the next launch removes the box.
- **The file tools' answers from the box have no size limit;** only a tampered `node` in the box
  could flood Tachikoma's memory, at worst closing it. A project image whose `NODE_OPTIONS` prints
  to standard output breaks those answers.
- **A process in the box can swap a link** between a file tool's check and its open, and so reach
  outside `/work`, but only where the box's user can already go.
- **Reading a pipe (FIFO) in the project waits,** in the box as on your machine.
- **Searches check their starting folder twice,** one more Docker call each, and a link swapped in
  between can change whether the start counts as outside.
- **With a slow Docker, the status line's branch** can show an older answer.
- **Small faults that show as raw errors:** Ctrl-C while Docker is asked about the image, on macOS
  and Linux, and a `docker` that cannot be started while old boxes are removed, each end with a
  stack trace; a file tool that stops in the box with an answer that cannot be read says `exit code
  0`; with two calls at once, a kill by the memory limit can be blamed on the wrong one.
- **A `/work` link or a `C:\work` junction on your machine** stops protected names matching in the
  box.

### Live link's limits

- **Lefthook's and pre-commit's settings files stay writable from the box,** as `package.json` is.
- **Git's own folder:** when the project is a subfolder of a repository, or not a repository, the
  box can make a `.git` there, which git on your machine then uses (`safe.bareRepository = explicit`
  does not stop it). With no top-level `config` file, the top-level read-only part protects nothing.
  A project's own top-level `objects` or `refs` folder is read-only in the box.
- **Submodules are looked for once, at launch:** one added during the session, by `git submodule
  add` or a checkout of a branch that has one, is open to the box as above. A project that is a
  submodule's folder not yet checked out in an outer repository is not refused, and the outer
  repository's `git status` would go into a `.git` the box makes there.
- **A repository nested in the project that is not a submodule** keeps its own `.git` writable from
  the box; git run inside it on your machine would use what the box wrote.
- **The submodule check comes after the image is built,** so on a first launch the build can come
  before the refusal. When the check cannot list git's index, the refusal names git's settings,
  with git's own reason, such as a repository owned by another user.
- **The letter-case check looks at the project folder only:** a subfolder set to mind letter case
  differently is not seen. On a Windows folder set to mind case, short names such as `GIT~1` may
  still reach `.git` (measured on an ordinary folder); folders made from WSL under `/mnt/c` mind
  case by default. A name that is another drive's mount point can fool the check. Docker Desktop on
  a case-sensitive Mac volume has not been tried.
- **A hooks folder, `.git`, or a top-level `HEAD`, `objects`, `refs` or `config` that is a link:**
  what it leads to is read-only in the box, but the link itself is not, so the box can replace it
  with its own, which git on your machine then uses.
- **Odd shapes:** a `.tachikoma` that is a file, or a git or hooks folder that is the
  project itself or `.tachikoma`, fails at start; an include inside `.tachikoma` gives Docker two
  mounts at one place, and the box does not start; a `.tachikoma` that cannot be made, or a hooks
  folder that cannot be checked, shows the raw error; a missing optional include outside the project
  refuses live link.
- **Git in the box trusts only `/work` itself** (`safe.directory`), not repositories nested in it.
- **Line endings:** `core.eol=native` means Linux's in the box; the system's git settings are read
  for them even under `GIT_CONFIG_NOSYSTEM`; a value set only inside a conditional include whose
  condition does not hold can still be used.
- **A `config.worktree` is read** without checking that git's `extensions.worktreeConfig` is on.
- **An included settings file outside `.git` replaced on your machine** during a session still shows
  its old version in the box.

### Copy mode's limits

- **In copy mode the `@` menu lists your folder, not the copy,** so it does not show files the model
  made there. Listing the box's folder took a median 360 ms, against about 33 ms on your machine.
- **Windows junctions (folder links) do not work in the box,** so pnpm's and npm workspaces'
  `node_modules` links are broken there; packages' native parts would not run in the Linux box
  anyway. The model can reinstall with the network on, and since changes in git-ignored paths are
  never applied, that reinstall never reaches your folder.
- **While the copy is made:** a file or folder deleted meanwhile refuses the copy or shows a raw
  error, so a running dev server can trip it; a folder swapped for a link is followed; a file
  swapped for a pipe could hang it. Admin-made links without Windows' Developer Mode, locked or
  unreadable files, and a read-only file that changes give raw errors. So do Windows names ending in
  a dot or space, and very long paths under the data folder.
- **Links in the copy:** relative links whose `..` steps climb above the project are left out, and
  one that climbs back in by the project's own name is kept and leads nowhere in the copy. Relative
  links whose letter case differs, on macOS, and names differing only by case on a case-sensitive
  Mac volume, are not handled.
- **The box's commit** leaves out git-ignored files, which are still in `/work`; its time over
  Docker Desktop's shared folder has not been measured and is not in the launch line's seconds.
- **What is counted as git-ignored:** a tracked file a `.gitignore` pattern covers (a committed
  `dist/`, a file added by force) counts as ignored, so it is never applied. Only `.gitignore` files
  are read, not `.git/info/exclude` or your own global excludes file, and letter case is matched
  loosely, so on Linux `build/` also covers `Build/`. A box can hide an ignored change from the
  count by keeping the file's size and time; never from what is applied.
- **What the review shows:** a path left out of the copy can come back as added (applying it is then
  a conflict); empty folders made or deleted are not shown; a rename that changes only letter case,
  on Windows or macOS, shows as an add and a delete; a file the box made unreadable (Linux, macOS)
  stops the list, so nothing is applied. A binary file of up to about 512 MB is read whole to show
  its sizes, and a file of over 10,000 lines shows its line counts instead of a diff.
- **The review itself:** skip choices are not remembered, so a reopened copy lists skipped changes
  as keep again; Ctrl-C cannot stop an apply between files, only at a merge question; a delete you
  also made shows as a conflict and keeps the copy; `m` is offered where git is missing, and then
  says so; note rows can be selected; a keys-file shortcut part-typed is not shown; on tiny
  terminals wrapped lines draw past the screen; removing a copy takes as long as its file count; a
  copy holding a link change is removed only by discarding it.
- **Applying:** a replaced file keeps its old permissions less your `umask` (664 becomes 644 under
  022, as git's checkout does), and its owner becomes you, on Linux and macOS; on Windows it takes
  its folder's permissions, losing its own and a hidden flag. A read-only file, or one another
  program holds, fails with a raw error. A change of folder name in letter case only keeps the old
  spelling. Empty folders are left after deletes. Long Windows paths give raw errors. Your binary
  file merged against the box's text file fails as `git merge-file failed`. A file the box adds
  named exactly `GIT~1`, where `.git` is a file, is a conflict, never written. A file another
  program changes in the instant between the last check and the replacement can be overwritten.
  After a crash or a refusal partway through a file, that file can be reported later as not
  applied or changed since, and after a crash during a change that only flips the executable flag,
  as applied; and a power cut can lose the log's last line or the last replacement.
- **Leaving:** `/exit` stops a running turn without waiting, so a write cut off midway shows in the
  review. In `never`, the file tools also refuse writes outside `/work` in the box, while shell
  commands can still write there. If `-p`'s request itself fails, the copy is kept without its
  `Changes kept for review` line. Closing the terminal, or a SIGTERM, while a copy is being removed
  at the end can leave half of it, without its record, for you to delete by hand.
- **A copy the host cannot remove** (a folder the box made unreadable, on Linux or macOS) is kept
  with one line, maybe without its record, for you to delete by hand.

### `tachi review`'s limits

- **Docker unreachable reads as no box** (Docker paused, or another `DOCKER_HOST` or Docker context
  in the other terminal), so a running session's copy could be opened or discarded.
- **A data folder shared across systems** (WSL beside Windows, a home folder on a network) can read
  a running session as gone, as there is no check of which machine a session runs on.
- **A crashed session's box still running, whose process number another program now has,** refuses
  the review until that program ends or the box is removed with `docker rm -f`.
- **Copies whose session still runs are listed** as waiting; opening one gives the busy line.
- **A launch killed outright** between the copy and the box starting leaves a copy `tachi review`
  never lists (its record still named `manifest.pending.json`), for you to delete by hand. A failed
  rename of that record ends the launch with a stack trace; the copy and the box are still removed.
- **The list counts one copy after another,** about 1.2 to 1.8 seconds each for a copy of
  Tachikoma's own folder.
- **It draws in full screen wherever it can,** ignoring classic mode, and the report of an earlier
  apply and any keys-file problems print just before full screen covers them.
- **Closing the terminal, or a SIGTERM, during a discard** can leave half the copy.

### Shift+Enter's limits, in Windows Terminal

- **tmux inside Windows Terminal gets no Shift+Enter;** Ctrl+J, or a backslash then Enter, still
  make a new line.
- **Over ssh from Windows Terminal, Shift+Enter sends the prompt:** ssh does not pass on
  `WT_SESSION`, so Tachikoma never turns on Windows Terminal's win32 input mode. Ctrl+J, or a
  backslash then Enter, make a new line.
- **Typing a character with Alt and its code on the number pad** is not supported there
  (untried).
- **Some keys do nothing while Tachikoma runs there:** Ctrl or Alt with a key Windows gives no
  character for, except Ctrl+Space; and F13 to F20. The arrows, Home, End, PgUp,
  PgDn, Insert, Delete, F1 to F12, Enter, Backspace and Tab do work with Ctrl and Alt.
- **AltGr is told apart only by the character it makes,** so Ctrl+Alt with a key that makes a
  character types that character.
- **A key's report that arrives in two pieces more than 20 ms apart,** Ink's own wait, is not read
  as one key.

## What comes next

1. Core (done): the agent loop, local file and shell tools, Anthropic and OpenAI-format providers
   with lead switching, the terminal interface with status line, the error log.
2. Sign in with ChatGPT (done), so an OpenAI model can lead on your ChatGPT plan instead of an API
   key; the `/model` picker.
3. Claude Code's keys and screen (done): stopping, editing, multi-line prompts, history, typing
   while it works, the `/` menu, `@` paths, Shift+Tab modes, the working line and a fuller status
   line.
4. Read-only subagents, with a panel under the prompt, and the to-do list; reading the project's and
   your own instruction files (AGENTS.md, CLAUDE.md) (done).
5. Full screen with its own scrolling: a scroll bar, selecting and copying with the mouse, and
   Ctrl+O and `/tasks t3` opening in place (done).
6. A settings file, so a plain `tachi` starts the way you want; key extras: vim mode, image
   paste, an external editor, stash, rebinding keys in a file (done).
7. Docker sandbox, in two modes (a live link to your folder, or a copy you review before it is
   applied); auto mode, where a second model judges each action instead of asking you; a check on
   dangerous commands of every kind, and protected paths; `never` mode back, in copy mode only;
   Shift+Enter in Windows Terminal (this release).
8. MCP tools and long-term memory (MemPalace); the sandbox's list of allowed sites; transcripts
   saved to disk; shortening the history;
   lessons learned from the error log, recalled when the same error comes back.
9. Skills: the loader, the bundled superpowers skills, and Tachikoma's own; Tachikoma offers to
   turn what it has learned into new skills, saved only on your yes.
10. Search of the codebase by meaning, with EmbeddingGemma 2.
11. A budget controller, then handing work to the `claude`, `codex` and `kimi` command-line tools.
12. Loops: on a timer, and until a task is done.
13. `tachi setup` and `tachi doctor`, with a first-run import of settings, skills, MCP servers and
    key bindings from the tools you already use; testing a fresh install in CI.
14. More providers, and bring-your-own keys.

## Licence

MIT: see [LICENSE](LICENSE).
