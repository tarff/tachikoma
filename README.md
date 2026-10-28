# Tachikoma

> **Work in progress.** Release 6 of 14 is done; the rest is being built. Expect missing
> features and changes that break things, and don't rely on it for real work yet.

Tachikoma is a coding-agent harness written from scratch in TypeScript. Any of several model
providers can lead a session. Later releases add handing work to other models and to the `claude`,
`codex` and `kimi` command-line tools, long-term memory, search of the codebase by meaning, a Docker
sandbox, and lessons learned from its own error log.

This is release 6 of 14: the core; signing in with ChatGPT; Claude Code's keys and screen;
subagents that read, with a to-do list and your instruction files; a full screen with its own
scrolling and mouse selection; and a settings file, keys you can move, and Claude Code's external
editor, stash, pictures and vim mode. The command is `tachi`.

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
  - `never`, which never asks, is switched off until release 7: `tachi` and `tachi -p` refuse to
    start in it, from `--mode` or the settings file. It comes back only once release 7 brings the
    Docker sandbox, auto mode (a second model judging each action) and a check on dangerous
    commands of every kind, not only ones that delete files.
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
  is kept, and the [settings](#settings) and [keys](#keys) files. A shell command can still read the
  login; see [Known limits](#known-limits).
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
- **An error log:** every failure, and every refusal another model answered, is written to
  `.tachikoma/errors.jsonl` in the project, and that folder is kept out of git. `/errors`
  summarises it.
- **Refusals:** for the Anthropic models that support it, Anthropic's own fallback re-runs a refused
  request on another model. `--fallback <provider:model>` adds a retry on a model of your choice,
  which can be from another provider. Off unless set. Every rescue is shown and logged.

## Running from source

You need Node 22.20 or later.

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

--lead <spec>     anthropic:<model> | chatgpt:<model> | openai:<model> | openrouter:<model>
                  | kimi:<model> | ollama:<model> (or set TACHI_LEAD)
                  chatgpt: uses your ChatGPT plan; openai: uses OPENAI_API_KEY
--mode <mode>     when to ask before acting: ask | project (default: ask);
                  never is switched off until release 7
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
```

In a session, `/lead <provider:model>` switches the lead model, `/model` picks it from a list,
`/login chatgpt` and `/logout chatgpt` sign in and out, `/tasks` lists the subagents, `/errors`
summarises the error log, `/screen` switches between full screen and classic, `/settings` and
`/keybindings` open the settings and keys files in your editor, `/vim` switches vim mode, and
`/exit` quits; commands ignore case. `/lead`, `/model`, `/screen` and `/vim` change only the window
you type them in. Esc or Ctrl-C stops the current turn and the subagents it waits for;
background subagents go on until `/tasks stop` or you quit.
When idle, Ctrl-C clears the prompt, and pressed twice on an empty prompt it quits. Ctrl+T hides or
shows the to-do list. Esc and Ctrl+T can be moved in the keys file; Ctrl-C and Ctrl-D cannot. `?`
on an empty prompt lists every key.

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
| `mode` | `"ask"` or `"project"`, as `--mode`; `"never"` is switched off until release 7 | `"ask"` | at once, as Shift+Tab, between `ask` and `project`; `never` is refused (below) |
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
  the entry: `settings.json: "mode" must be one of: ask, project, never (got "x")`. An entry
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
  start.
- **`"mode": "never"` is refused until release 7,** as `--mode never` is: at launch Tachikoma
  stops with one line, and an edit to it during a session gets a line, and the mode stays.
- **The file tools never touch the settings file or the keys file,** in any mode, even when the
  project is your home folder, so the model cannot change them with its file tools. A shell command
  is not stopped: it asks first in `ask` and `project` mode, as every command does, and in `never`
  mode it does not.

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
  in the model list, `Transcript` in the detail view, and `Scroll` in full screen. A context's own
  binding comes before Global's.
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
  until the next start.
- **Except the keys that answer a question,** which stay as they were at launch, so a command that
  rewrites the file cannot make `n` answer yes. The parts of an edit that would change which key
  answers yes or no, or stop one answering (all of `Confirmation`, and any `Global` or `Scroll`
  binding that uses an answering key, even in a chord), take effect at the next launch, and a grey
  line says so; the rest applies at once.

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

## The external editor

Ctrl+G, or Ctrl+X then Ctrl+E, opens the prompt in an editor. When the editor closes, what you saved
becomes the prompt, with the cursor at the end; Ctrl+Z brings back the text before.

- **Which editor:** `VISUAL`, then `EDITOR`, then the settings file's `"editor"`, then Notepad on
  Windows and `vi` elsewhere. It runs through the system's shell (`cmd.exe` on Windows, `/bin/sh`
  elsewhere), as Git runs its editor, so the entry can carry its own options: `"code --wait"`.
- **The file** is `prompt.md` in a new folder in the system's temporary folder (your own on
  Windows; on macOS and Linux only you can read it), deleted afterwards. An editor that runs in the
  terminal, such as vim or nano, gets the whole terminal; full screen steps aside and comes back
  after, as for `[`. The editor gets the environment shell commands get, without the API keys.
- **Meanwhile** a turn already running carries on, and its output is there when you come back; a
  permission question waits until you are back. A queued `/screen`, `/settings` or `/keybindings`
  waits for the editor to close.
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
nothing is lost. There is one slot, kept until you quit.

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
  does without vim mode. Ctrl-C always stops. Enter sends from NORMAL too. `j` and `k` at the first
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
  and the data folder from the file tools prevents accidents, not a determined command. The sandbox
  (release 7) keeps commands away from the login.
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
  an ordinary file. Both need something already running on your machine; the sandbox (release 7) is
  the answer.
- **On Windows, cancelling cannot stop a program whose shell has already exited.** Cancel still
  returns at once. On macOS and Linux it does stop it.
- **On Windows, shell exit codes are only 0 or 1.** PowerShell reports only whether the last command
  succeeded, so a program's own exit code is lost.
- **On Windows, PowerShell error messages repeat the whole command**, including the line Tachikoma
  puts first to make the output UTF-8. The ways around it that were tried either lost the exit code or
  turned error messages into XML.
- **Windows Terminal sends Shift+Enter as Enter,** as tested on 2026-10-25: it does not answer for
  the kitty keyboard protocol that tells them apart. A backslash then Enter, or Ctrl+J, makes a new
  line in every terminal (not planned to change).
- **A hard kill cannot put the terminal back.** Ending Tachikoma from Task Manager, or anything else
  that stops it without warning, can leave its tab on the alternate screen, still taking the mouse.
  Closing that tab clears it (not planned to change).
- **Windows Terminal and other terminals built on Windows' ConPTY can leave fragments of earlier
  output on screen** in full screen, as Claude Code's own documentation warns (no release is set).
- **Copying cannot check that it worked.** Tachikoma cannot tell whether the terminal took the copy,
  and it says "Copied" before the system's tool has finished; a tool that then fails is reported.
  Where only the terminal copies, a terminal that ignores the copy leaves the clipboard unchanged,
  and Tachikoma cannot tell (no release is set).
- **Subagents only read.** Ones that edit or run commands come with the budget controller (release
  11), after the sandbox (release 7) gives each writer its own copy of the project.
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
- **On Windows, a `%` in a path given to the editor can be changed on the way:** the editor runs
  through `cmd.exe`, which reads `%NAME%` as a variable, so a user folder with `%` signs in its name
  could give the editor the wrong file for Ctrl+G or `/settings` (no release is set).
- **Vim mode's text objects are the ones Claude Code's docs list** (`iw`, `aw`, `iW`, `aW`, and `i`
  or `a` with `"`, `'`, `(`, `[` or `{`). Claude Code's own code also takes `` ` ``, `b`, `B`, `<`,
  `>`, `)`, `]` and `}` after `i` or `a`; those are not built yet (no release is set).

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
   paste, an external editor, stash, rebinding keys in a file (this release).
7. Docker sandbox, in two modes (a live link to your folder, or a copy you review before it is
   applied); auto mode, where a second model judges each action instead of asking you; a check on
   dangerous commands of every kind. `never` mode comes back only with these.
8. MCP tools and long-term memory (MemPalace); transcripts saved to disk; shortening the history;
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
