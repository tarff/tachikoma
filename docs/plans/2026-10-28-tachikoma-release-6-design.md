# Tachikoma release 6: settings, keys and the key extras, design (2026-10-28)

Release 6 of Tachikoma. The overall design, the Decisions table and the release order are in
[2026-10-22-tachikoma-design.md](2026-10-22-tachikoma-design.md).

Release 6 lets a plain `tachi` start the way the user wants, lets every key be changed, and adds
Claude Code's vim mode, external editor, stash and picture pasting, and the context bar for OpenAI
API leads. It begins by tidying the screen code, which the extras build on.

Release 6 was to hold vim mode, image paste, an external editor, stash and rebinding keys in a file
(release 5 design, 2026-10-26), and the context window of OpenAI API models (user, 2026-10-27). The
settings file is new: asked how vim mode should be turned on, the user chose "A new settings file",
then said "I don't want to be launching with args" (2026-10-28). Each part below was chosen by the
user on 2026-10-28 from options offered, unless it says otherwise.

Sources:
- **Claude Code's keys:** code.claude.com/docs/en/keybindings.md and interactive-mode.md, read on
  2026-10-28. The file `~/.claude/keybindings.json` holds blocks by context, each mapping keys to
  `namespace:action` names, with `null` to unbind and `command:<name>` to run a slash command;
  chords are keys separated by spaces, each within 3 seconds of the one before; edits apply
  without a restart; Ctrl+C, Ctrl+D, Ctrl+M, Ctrl+[, Ctrl+I and Ctrl+H cannot be rebound; vim keys
  are not remappable, and "The Escape key in vim mode switches INSERT to NORMAL mode; it doesn't
  trigger `chat:cancel`". `chat:externalEditor` is Ctrl+G and Ctrl+X Ctrl+E, `chat:stash` Ctrl+S
  ("With text in the input, stashes it and clears the prompt. Pressed again on an empty prompt,
  restores the stashed text, cursor position, pasted content"), `chat:imagePaste` Ctrl+V, "Alt+V
  on Windows and WSL", which "Inserts an `[Image #N]` chip at the cursor".
- **Claude Code's vim mode:** interactive-mode.md, "Vim editor mode", read on 2026-10-28: the
  tables of modes, motions, operators, text objects and visual mode copied into this design's
  tests; `vimInsertModeRemaps` maps two printable characters typed "within one second" to Escape,
  and `"<Esc>"` is the only target.
- **Claude Code's auto mode:** code.claude.com/docs/en/permission-modes.md, read on 2026-10-28 (see
  "Not in this release").
- **Picture limits and OpenAI context windows:** each provider's own pages, read on 2026-10-28,
  listed with the tables below.
- **sharp** (the image library): version 0.35.5, published 2026-09-27, with a prebuilt Windows x64
  build (`@img/sharp-win32-x64@0.35.5`), from registry.npmjs.org, read on 2026-10-28.
- **Ink 7.1.1:** `suspendTerminal()` hands the terminal to another program and redraws after
  (release 5 design).

## The probe

Run by the user on 2026-10-28 in Windows Terminal (PowerShell, Node 24.22.1), with
`keyprobe.mjs` in the session's scratchpad:
- **Keys:** Alt+V arrives as `ESC v`, Ctrl+G as 0x07, Ctrl+S as 0x13, and Ctrl+X then Ctrl+E as
  0x18 and 0x05, each in its own read. **Ctrl+V never arrives:** Windows Terminal keeps it and
  pastes the clipboard's text itself. So pictures are Alt+V on Windows, as in Claude Code. The
  terminal did not answer the kitty keyboard protocol's query within 500 ms; none of these keys
  needs it.
- **Reading a picture from the clipboard** through Windows PowerShell 5.1 (Windows Forms, `-STA`):
  a 770×131 snip (7 KB as PNG) took 0.6 s; the whole screen over two monitors, 6560×3299 (1.5 MB),
  took 0.9 s.
- **Notepad:** Tachikoma's wait ended when the user closed Notepad (11.3 s, after saving), not
  before, so Windows 11's Notepad works as the default editor. Neither VISUAL nor EDITOR is set on
  the user's machine.

## Tidying the screen code first

The final review of release 5 advised it before the editor and vim mode (user: "Yes, as the first
tasks"). Nothing a user sees changes, and every test passes before and after each task.
- **One owner for the terminal.** Handing the terminal over (`suspendTerminal`), holding raw mode
  through a switch (`hold`) and sending keys to a reader instead of Ink (`divert`) go through one
  small module that knows who has the terminal. `/screen`, `[`, and now the external editor all use
  it. Two hand-overs in one batch of keys crashed release 5 before its fix, which drops a `[` read
  while a switch has Ink suspended; that stays, as nothing a user sees changes. The editor waits
  its turn behind a hand-over under way (changed at the build's Task 1: queueing `[` and `/screen`
  would have changed the orders release 5's tests check).
- **What is happening now, in one place.** App.tsx's ten or so flags (switching, suspended, printed
  out, working, a question waiting, and the rest) become one state with named cases, so "can this
  key act now?" is asked of one thing.
- **Listeners set up once read the latest state**, through refs, never a value captured when they
  were made.
- **Layout sums move out of drawing** into `layout.ts`, where they are tested as plain functions.
- **Comments that tell the build's history** are cut to what the code does and why.

## Keys become named actions

Every key Tachikoma reacts to gets a named action in a context, in one default table written in
Claude Code's format, with Claude Code's names wherever Claude Code has the same thing (user:
"Every key becomes a named action"). The screen code reacts to actions, never to raw keys.
- **Contexts:** Global, Chat (the prompt), Autocomplete (the `/` and `@` menus), Confirmation
  (permission questions), HistorySearch (Ctrl+R), Select (the model list), Transcript (the detail
  view) and Scroll (full screen).
- **Examples:** `app:interrupt` Ctrl+C, `app:toggleTodos` Ctrl+T, `app:toggleTranscript` Ctrl+O,
  `chat:submit` Enter, `chat:newline` Shift+Enter and Ctrl+J, `chat:cycleMode` Shift+Tab,
  `chat:modelPicker` Alt+P, `chat:undo` Ctrl+Z and Ctrl+_, `history:search` Ctrl+R, and the new
  `chat:externalEditor` Ctrl+G and Ctrl+X Ctrl+E, `chat:stash` Ctrl+S, `chat:imagePaste` Alt+V on
  Windows and Ctrl+V elsewhere.
- **Tachikoma's own keys** get names in the same style, such as `transcript:print` for `[` and
  `transcript:search` for `/` in the detail view.
- **Bindings come first, as in Claude Code:** at the prompt every key is matched against the
  bindings of the contexts in force, and the prompt's own editing keys (Ctrl+A, Ctrl+E, Ctrl+K,
  Ctrl+U, Ctrl+W, Alt+B, Alt+F and the rest) act only on a key no binding takes. So binding Ctrl+E
  to `chat:externalEditor`, as Claude Code's own example does, replaces end-of-line on Ctrl+E. The
  editing keys themselves are not actions and cannot be moved to other keys; nor can vim's keys.
- **Reserved, never bound:** Ctrl+C and Ctrl+D, and Ctrl+M, Ctrl+[, Ctrl+I and Ctrl+H, which arrive
  as Enter, Esc, Tab and Backspace. A binding of one is a problem the file reports.
- **Help follows the table.** `?` lists the keys from it, and every hint that names a key ("Esc to
  stop", "Ctrl+O to see more") names the key actually bound, so a rebind never leaves stale help.

## The settings file

`~/.tachikoma/settings.json` (on Windows `%USERPROFILE%\.tachikoma\settings.json`), like Claude
Code's `~/.claude/settings.json`, apart from the data folder and its login files (user:
"~\.tachikoma\settings.json"). Only this file is read: no project has its own (user: "No, your
file only"), so a repository the user clones can never change how Tachikoma behaves, such as
turning the questions off.

**What it holds:** every session option, plus vim mode and the editor (user: "All of them; flags
still win"). The names follow the flags; where Claude Code has the same setting, its name is used,
so release 13's import can carry it across.

```json
{
  "lead": "anthropic:claude-opus-5-5",
  "mode": "ask",
  "effort": "high",
  "fallback": "openai:gpt-5.5",
  "worker": "anthropic:claude-haiku-5-5",
  "maxTasks": 8,
  "status": ["lead", "context", "cost"],
  "screen": "full",
  "scrollSpeed": 3,
  "editorMode": "vim",
  "vimInsertModeRemaps": { "jj": "<Esc>" },
  "editor": "code --wait"
}
```

Every entry is optional; one that is absent keeps today's default.

- **Which wins:** a flag, then a `TACHI_` variable, then the file, then the default. `-p` runs read
  the file too.
- **With no lead anywhere,** `tachi` says how to set one in the file, instead of the bare usage
  error.
- **Checks:** each value gets the same check as its flag, and the same message, naming the file. An
  unknown name gets a one-line warning and the rest applies. A broken file at launch stops
  Tachikoma with the reason, as a bad flag does.
- **Saving** (user: "Save it, like Claude Code"): `/lead`, `/model`, `/screen` and `/vim` write
  their one entry and leave the rest of the file as it was, entries the user added included. The
  write goes through release 2's private-file writer under its lock, so two sessions saving at once
  lose nothing. If the file cannot be written, the change holds for the session and one line says
  so. Shift+Tab's mode changes are not saved, since they are often for one task (my call, told to
  the user).
  **Replaced by the plan's choice 26 (the user's answers, 2026-10-29): nothing is saved.**
- **Live edits** (user: "Yes, live, like Claude Code"): Tachikoma watches the file, and each
  changed entry applies as the table below says, with one line naming what changed. A setting given
  by a flag or variable at launch stays as given for that session, and the line saying so names
  it. Removing an entry is a change to what applies without it: the flag's or variable's value if
  one was given, otherwise the default. Removing the whole file is the same as `{}`. Tachikoma's own
  saves are not counted as changes. A file broken by an edit keeps the last good settings and says
  what is wrong in one line.
  **Removing the file, and Tachikoma's own saves: replaced by the plan's choice 26 (a missing
  settings or keys file is skipped, keeping what is in force; nothing is saved).**

| Entry | When a live change applies |
|---|---|
| `lead` | as `/lead`: at once when idle, otherwise when the turn ends. Removed with no flag or variable: the session keeps its lead, since a session cannot be without one |
| `mode` | at once, as Shift+Tab, between `ask` and `project`. `never` only at launch, like `--mode never` (user: "At launch only, like the flag"): a live change to `never` is refused with one line and the mode stays; a live change away from `never` applies |
| `effort` | from the lead's next request |
| `fallback` | from the next refusal; a rescue already under way finishes on the old one |
| `worker` | for subagents started after the change; running ones keep theirs |
| `maxTasks` | for subagents started after the change; lowering it stops none, it only holds back new ones |
| `status` | at once |
| `screen` | as `/screen`, waiting where `/screen` waits |
| `scrollSpeed` | from the next wheel notch |
| `editorMode` | at once, as `/vim`; turning vim off leaves the text and cursor as they are |
| `vimInsertModeRemaps` | from the next key |
| `editor` | from the next Ctrl+G, `/settings` or `/keybindings` |
- **Safety:** `~/.tachikoma` is outside every project, so a model's write there needs the user's
  yes in the `ask` and `project` modes. In `never` mode it does not, as for any file today; the
  README's known limits say so.

## The keys file

`~/.tachikoma/keybindings.json`, in Claude Code's format (user: "Claude Code's format"), so release
13's setup can copy a Claude Code file across as it is.

```json
{
  "bindings": [
    { "context": "Chat", "bindings": { "ctrl+e": "chat:externalEditor", "ctrl+s": null } }
  ]
}
```

- **Key syntax:** Claude Code's: `ctrl`, `shift`, `alt`/`meta`, case ignored, special keys by name,
  chords separated by spaces with 3 seconds between keys (Claude Code's figure). A chord under way
  shows in the hint row.
- **`null` unbinds; `command:<name>` runs** a slash command that takes nothing after it.
- **Problems,** each one line in the conversation, the rest of the file still applying: bad JSON
  (the last good keys stay), an unknown context or action, a misspelled modifier, a space beside
  `+`, a reserved key, and the same key twice in one context.
- **Actions only Claude Code has,** such as `chat:fastMode`, are counted in one line ("3 entries
  skipped: Tachikoma has no chat:fastMode, ...") so an imported Claude Code file is not noisy.
- **Live:** edits apply without a restart, as for the settings file.

## The external editor

Ctrl+G, or Ctrl+X Ctrl+E, opens the prompt in an editor and waits until it closes.
- **Which editor** (user: "VISUAL/EDITOR, else a setting, else Notepad"): VISUAL, then EDITOR, then
  the settings file's `"editor"`, then Notepad on Windows (from System32) and vi elsewhere. An
  entry may carry its own options, such as `code --wait`.
- **The file:** a new temporary file only the user can read, holding the prompt, deleted after.
- **The hand-over:** through the one owner of the terminal, so editors that run in the terminal
  (vim, nano) work. Full screen steps aside and comes back after, as for `[`.
- **Meanwhile:** a turn already running carries on, and its output is there on return. A permission
  question waits until the user is back.
- **On return:** the file's text becomes the prompt, without the trailing line break editors add,
  with the cursor at the end; Ctrl+Z brings back the text before. If the editor fails or is not
  found, the prompt stays as it was and one line says why, naming how to set an editor.
- **Pictures:** an `[Image #N]` marker is plain text in the file, and follows the rules under
  "Pictures" like any other edit.
- **`/settings` and `/keybindings`** open those files in the same editor, creating a missing one
  first (`{}`, and `{"bindings": []}`). Saving is enough: the live reload applies it.

## Stash

Ctrl+S, as in Claude Code: with text in the prompt, the text, the cursor and any pictures go aside
and the prompt clears, and the hint row shows "Stashed · Ctrl+S to bring back"; on an empty prompt,
they come back. One slot, for the session. Claude Code's docs do not say what happens when the
prompt has text and the slot is full: here the two swap, so nothing is lost (my call, told to the
user).

## Pictures

- **From the clipboard:** Alt+V on Windows, Ctrl+V elsewhere (user: "Clipboard, and pasted image
  paths"). Windows reads through Windows PowerShell as in the probe; macOS through `osascript`;
  Linux through `wl-paste` or `xclip`, chosen as release 5 chooses its copy tool. The hint row
  shows "Reading picture..." while it runs (0.6 to 0.9 s in the probe; my call, told to the user).
- **While a read runs** (found at the second design review): Alt+V takes the next number and puts
  its marker at the cursor at once, so pictures keep the order they were asked for. The picture
  fills in under that number when the read ends, wherever the marker is by then: the prompt, the
  stash or the queue. Enter, or the queue reaching that message, waits for the message's reads to
  end before sending. Deleting the marker while it reads does not stop the read: its picture is
  kept like any other, so undo bringing the marker back brings the picture too, never a second
  read of a clipboard that may have changed (found at the third design review). With no picture on
  the clipboard, the marker goes from wherever it is and one line says so; a copy of it that undo
  brings back later is only text.
- **From pasted paths:** a paste that is only paths to .png, .jpg, .jpeg, .gif or .webp files, with
  or without quotes, one or several, becomes those pictures, which covers dragging a file in. A
  typed path stays text. Paths outside the project are fine: the user added them. The model's tools
  never add pictures.
- **In the prompt:** each picture puts `[Image #N]` at the cursor. The numbers run through the
  session, so "Image #2" always means one picture (my call, told to the user).
- **Which pictures a message carries** (found at the design reviews): every picture pasted in the
  session is kept, by number, until the session ends. A marker that carries a picture is not just
  its text: the prompt keeps it as a span tied to that picture, and the span moves with edits
  around it and goes when any of its characters is deleted. Text that only looks like a marker,
  typed by hand or brought back from prompt history (where yesterday's `[Image #1]` would
  otherwise take today's picture #1), carries nothing. A message carries the pictures of its spans
  that have not been sent before, each where its first span is. So:
  - deleting a marker leaves the picture out, and undo, which brings the span back, brings it in;
  - vim's yank and put copy the span; the picture goes once, at the first copy, and the others are
    only text;
  - a queued message and a stash keep their spans;
  - the external editor's file is plain text, so on return a marker is a span again only if it
    names a picture the prompt held when the editor opened;
  - a span of a picture already sent is only text: the picture is in the conversation already, and
    the model can be pointed at it by its number.
- **What is sent, request by request** (found at the design review): the conversation keeps every
  original. Each request, to the lead or to the fallback, is built for the provider it goes to,
  from the originals of every picture in the conversation, old ones included, so a change of lead
  or a rescue gets pictures that fit its own provider. Shrunk copies are kept for the session,
  keyed by the picture and the exact limits it was shrunk to (bytes, pixels a side, format), not
  by provider alone: once an Anthropic request holds more than 20 pictures, each must fit 2000
  pixels a side, so a copy made to 8000 is made again (found at the second design review).
- **In the conversation:** a new picture part beside text and tool parts. The three adapters turn it
  into an Anthropic image block, an OpenAI `image_url` with the data inline (OpenAI, OpenRouter,
  Kimi and Ollama), and the ChatGPT plan's `input_image`. Pictures stay in the conversation and are
  sent again with each later turn, like everything in it. They go to the lead and the fallback,
  never to subagents.
- **Shrinking** (user: "Shrink to fit"), with sharp installed through sfw, to the table below. A
  provider that documents no limit gets the picture as it is. The providers that resize on their
  side (Anthropic, OpenAI) are shrunk only below the lines where they refuse. Sizes are measured as
  sent, base64 included (found at the design review: Anthropic's 10 MB is "base64-encoded", so an
  8 MB file is over it). A picture over its byte limit is scaled down by the square root of
  allowed size over its size, since the bytes follow the pixel area, and measured again until it
  fits.
- **The whole request** (found at the design review): with each picture within its own limits, the
  request as it will be sent is measured against the provider's request cap, and its pictures,
  earlier turns' included, are counted for Anthropic's more-than-20 rule. If it is still over the
  cap, the oldest pictures are left out of that request alone, each replaced by a short note
  (`[Image #2 left out: the request was over Anthropic's 32 MB]`), newest kept, until it fits; one
  line says how many (user: "Leave out the oldest"). The conversation keeps them all, so a provider
  with a larger cap still gets them.
- **When the provider refuses** (user: "Send it; show the refusal"): no list of which models read
  pictures is kept, and the refusal is shown as the provider wrote it. The conversation is never
  changed: the message stays, with the subagent answers it took in, and the queue goes on as after
  any failed turn (the design review found that taking the message back into the prompt could
  overwrite newer typing and lose those answers). An invalid-request answer (HTTP 400) does not
  say whether the pictures caused it: a bad tool list or a conversation too long gives the same
  code, and matching each provider's wording would break when it changes (found at the second
  design review). So when a request carrying pictures gets one, the error is shown and Tachikoma
  asks: "Send again without the pictures? [y/n]" (user: "Ask you"). y sends the request again
  with each picture as a short note (`[Image #2 left out: <lead> refused pictures]`), and that
  lead's later requests do the same for the session; other leads still get the pictures (user:
  "Leave pictures out for that lead"). n changes nothing. A network error, an overload or a rate
  limit asks nothing.
- **Limits said plainly:** prompt history (Up, Ctrl+R) keeps the words and markers, not the
  pictures. Stash keeps them.

**Picture limits, read on 2026-10-28:**

| Provider | Formats | Shrunk to | Source |
|---|---|---|---|
| Anthropic | JPEG, PNG, GIF, WebP | each under 10 MB base64-encoded and 8000×8000 pixels; with more than 20 pictures in a request, earlier turns' included, 2000 pixels a side; the request under 32 MB ("standard endpoints"). Larger pictures are resized by Anthropic | platform.claude.com/docs/en/build-with-claude/vision, "Request limits" |
| OpenAI | PNG, JPEG, WebP, non-animated GIF | no per-picture limit is documented, so none; the request under 512 MB ("total payload") and 1,500 pictures. OpenAI resizes by model, refusing only a picture over 30,000 patches after its own resizing | developers.openai.com/api/docs/guides/images-vision |
| Kimi | JPEG, PNG, GIF, WebP (also BMP, HEIC, HEIF) | 4096×2160, Kimi's recommendation, not a stated refusal (user: "Yes, follow the recommendation"); the request under 100 MB ("request body"); data inline only, no links | platform.kimi.ai/docs/guide/use-kimi-vision-model |
| OpenRouter | PNG, JPEG, WebP, GIF | not shrunk: limits "vary per provider and per model" | openrouter.ai/docs/guides/overview/multimodal/image-understanding.md |
| Ollama | not documented | not shrunk; its OpenAI-style endpoint takes inline data only | docs.ollama.com/api/openai-compatibility |
| ChatGPT plan | not documented | not shrunk | nothing public |

The OpenAI patch limit depends on the model's own resizing, which its guide documents for some
models and not others, so Tachikoma does not try to predict it; a refused picture follows the rule
above. Formats outside a provider's list are converted to PNG.

## Vim mode

All of Claude Code's table (user: "All of Claude Code's table"): the modes, motions,
`f`/`t`/`;`/`,`, `%`, operators with motions and text objects, visual and line-visual mode,
`p`/`P` from the yank register, `.` to repeat, `u` to undo, and counts (`3w`, `2dd`, `d3w`;
Claude Code's table does not list counts, but the option the user chose did).
- **Built as plain data:** `vim.ts` holds the mode, a half-typed command (count, operator, an `f`
  waiting for its character), the last f/t search, the last change and the yank register. One
  function takes the state and a key and returns the new state, so every row of Claude Code's
  table is a test fed key by key. `u` uses the editor's undo steps.
- **On:** `"editorMode": "vim"` in the settings file, or `/vim`, for this window only (the plan's
  choice 26). It starts in INSERT. The mode shows in the hint row (`-- NORMAL --`). The mode and
  cursor are kept across Ctrl+O, the detail view and the menus.
- **As Claude Code's docs say:** Esc in INSERT or VISUAL goes to NORMAL and does not stop the turn;
  Esc in NORMAL does what Esc does today; Ctrl+C always stops. Enter sends from NORMAL too.
  `j`/`k` and Up/Down at the first or last line move through prompt history. `/` in NORMAL opens
  Ctrl+R's search and `?` the key list. Ctrl keys keep their actions from the key table. No block
  visual mode (Ctrl+V).
- **`vimInsertModeRemaps`:** two printable characters within 1 second (Claude Code's figure) go to
  NORMAL and leave neither in the text; after the second, or another key, both stay. `<Esc>` is
  the only target.
- **My calls, told to the user:** yanks stay inside Tachikoma, never the system clipboard, as in
  Claude Code. Keys that arrive together, such as a fast `dw`, are split into single keys, which
  also mends the old "`yy` in one read answers nothing". A bracketed paste always inserts as text,
  in any mode.

## OpenAI API context windows

For `openai:` leads on OpenAI's own address only: not another OPENAI_BASE_URL, not OpenRouter, not
the ChatGPT plan, which keeps its own smaller window (user, 2026-10-27, option "2"). The table is in
the code with its date; a dated snapshot name (`gpt-5.5-2026-04-23`) finds its model's row; a model
not in it shows the tokens used, as today. The README says the table is as of its date.

Read on 2026-10-28 from developers.openai.com/api/docs/models/<model>:

| Context window | Models (dated snapshots listed on their pages) |
|---|---|
| 1,050,000 | gpt-6-astra, gpt-6.1-sol, gpt-6.1-terra, gpt-6-luna, gpt-6-sol, gpt-5.6-sol (and its alias gpt-5.6), gpt-5.6-terra, gpt-5.6-luna, gpt-5.5 (-2026-04-23), gpt-5.5-pro (-2026-04-23), gpt-5.4 (-2026-03-05), gpt-5.4-pro (-2026-03-05) |
| 1,047,576 | gpt-4.1, gpt-4.1-mini (-2025-04-14) |
| 400,000 | gpt-5.6-cyber, gpt-5.4-mini, gpt-5.4-nano (-2026-03-17), gpt-5.3-codex, gpt-5.2, gpt-5.2-pro (-2025-12-11), gpt-5.1 (-2025-11-13), gpt-5-pro (-2025-10-06), gpt-5, gpt-5-mini, gpt-5-nano (-2025-08-07), chat-latest |
| 200,000 | o3 (-2025-04-16), o3-pro (-2025-06-10) |
| 131,072 | gpt-oss-120b, gpt-oss-20b |
| 128,000 | gpt-4o (-2024-11-20, -2024-08-06), gpt-4o-mini (-2024-07-18) |

Each row is checked against its page again when the table is written into the code.

## When something goes wrong

- A broken settings or keys file: at launch, the reason and a stop for settings; one line and the
  rest applied for keys; during a session, the last good version and one line.
- A save that fails: the change holds for the session; one line says so.
  **Replaced by the plan's choice 26: nothing is saved.**
- An editor that is missing or fails: the prompt as it was; one line naming how to set one.
- No picture on the clipboard, or no clipboard reader on Linux: one line.
- A provider refusing a request with pictures as invalid: its words, then the question whether to
  send again without them.
- A request over its provider's cap: the oldest pictures left out of it, with notes, and one line.
- Every new message is triggered for real in a test, and its exact words checked.

## Building it

Test first, task by task, each with a builder, then a spec review, then a code review, with fixes
until both approve (as release 5). The order: the tidy-up; keys as actions; the settings file; the
keys file; the external editor with `/settings` and `/keybindings`; stash; pictures; vim mode; the
OpenAI table. sharp is installed through sfw, pinned to the version checked then.

## Testing

- **The tidy-up:** the whole suite passes unchanged before and after each task; the editor waits
  for a hand-over under way, and two hand-overs in one batch of keys never throw.
- **Keys:** the default table against today's keys, so no key changes meaning; a binding taking a
  key before the prompt's editing keys (Ctrl+E); each problem in a keys file with its exact
  message; chords and their 3 seconds under fake timers; `?` and the hints
  following a rebind.
- **Settings:** the order of precedence; each check's message naming the file; `/lead`, `/model`
  and `/screen` leaving the file as it was (the plan's choice 26); live edits with a real file, one
  test for each row of the live-change table, removals included; a live `never` refused; a broken
  edit keeping the last good settings.
- **The editor:** the hand-over with a stand-in editor program; trailing line break; a failing and a
  missing editor; a turn's output arriving meanwhile.
- **Pictures:** each adapter's shape against its provider's documented form; shrinking to each
  limit in the table, measured base64 included; a request over its cap leaving out the oldest; a
  pasted path list; which pictures a message carries after deleting, undo, a copied marker, a
  queue, a stash and the editor; a recalled or typed marker carrying nothing; the fallback and a
  changed lead getting pictures built for their own provider; a request crossing 20 pictures
  shrinking again copies made to 8000; a read still running when Enter, stash or another Alt+V
  comes; a marker deleted while its read runs, the read ending, then undo bringing back marker
  and picture; a read finding no picture, then undo bringing back only text; the question after a
  400 with pictures, y and n, and
  none after a network error; the queue and the subagent answers untouched by a refusal.
- **Vim:** every row of Claude Code's tables from a known text and cursor to the expected text,
  cursor and mode; counts; `.`; the remap's second under fake timers; history at the edges; keys
  arriving together.
- **In the user's terminal,** a checklist run once: Ctrl+G with Notepad, `/settings`, a live edit of
  each file, Ctrl+S both ways, Alt+V with a snip and with the whole screen, a dragged-in picture
  file, a picture sent to Anthropic, vim's main keys.

## Not in this release

- **Auto mode** (a second model judging each action, Claude Code's `auto`): release 7, with the
  Docker sandbox, so both are designed together (user: "Release 7, with the sandbox"). The user
  asked whether loops need it: release 12's loops already run unattended in the sandbox in `never`
  mode on a copy of the project; auto mode would let a loop run without Docker, or act outside the
  box. Release 12's design decides which loops may use it.
- A settings file in each project.
- Claude Code's `/config` dialog: `/settings` opens the file instead.
- "Show last response in external editor".
- Moving between pictures with the arrow keys (Claude Code's Attachments context).
- Ctrl+R's scope cycling.
- Ctrl+X Ctrl+K and Claude Code's other keys for features Tachikoma does not have.

## As built

Where the code differs from the design above, or settles what it left open, and why. The plan
(`2026-10-28-tachikoma-release-6.md`) lists the 31 choices it made, each marked in its task, and
each task's "found at" notes. Choice 26 (nothing is saved, and a missing settings or keys file is
skipped) is already written into "Saving", "Live edits", "When something goes wrong" and "Vim mode"
above, and Task 1's hand-overs into "Tidying the screen code first"; the rest follows, task by
task. "The user's choice" marks the user's answers; "the build's call" marks a call the plan or the
build made, for the user to review at the final review.

- **What is happening now (Task 2).** App's flags stay where they are, and one function reads them
  (`phase.ts`), so "who takes this key?" is still asked of one thing. A paste does not follow the
  keys' order, so it has its own rule beside it (`pasteTo`), and a `/screen` switch is no phase, as
  keys act in the mode it goes to (found at Task 2's build).
- **Keys as actions (Tasks 5 and 6):**
  - Under WSL both Alt+V and Ctrl+V paste a picture, Alt+V first, as Claude Code binds both there
    (found at Task 5's spec review).
  - A key set to `null` in a context does nothing there, even where an outer context binds it:
    `"ctrl+t": null` under Chat stops Ctrl+T at the prompt, and Global's Ctrl+T still works
    elsewhere (choice 18, the user's choice).
  - Global's actions act wherever Global is in force: at a question, in a Ctrl+R search, in the
    model list and in the detail view, Ctrl+T toggles the to-do list, Ctrl+O does
    `app:toggleTranscript` and Ctrl+D exits on its double press; Ctrl-C keeps each phase's own rule
    (choice 19, the user's choice).
  - Keys match the table exactly, so keys that acted only because release 4 ignored a held modifier
    do nothing: Ctrl+Up and Alt+Up, Alt+Enter, Shift+Up and Shift+Down in the model list in full
    screen, and a wheel notch with Shift, Ctrl or Alt held. Classic mode still reads Shift+Up and
    Shift+Down as Up and Down, and Ctrl+Home and Ctrl+End as Home and End. Esc with Alt is still
    Esc, as two fast Escs look like it, so `alt+escape` binds only under the kitty protocol (choice
    20, the user's choice).
  - While a Ctrl+R query, a detail-view search or the model list's filter is typed, a printable key
    goes into it before any binding, as Claude Code's text fields take it (Task 6).
  - A key held with Cmd or Super cannot be named, as Ink reports Super only under the kitty
    protocol. Under that protocol Ctrl+_ arrives as `ctrl+shift+-`, so `chat:undo`'s Ctrl+_ does
    not fire there, while its Ctrl+Z does (Task 5).
- **The settings file (Tasks 7, 9 and 10):**
  - `status` is a list of names, `["lead", "context"]`, and `screen` is `"full"` or `"classic"`
    (choice 7, the build's call). Each message names the file and the entry before the flag's own
    words: `settings.json: "mode" must be one of: ask, project (got "x")` (choice 8, the
    build's call). `$schema` is allowed and ignored.
  - An empty file, or one with a byte-order mark as Windows PowerShell 5.1 writes, reads as
    Windows editors save it: empty is `{}` at launch, and the mark is skipped (the build's call,
    2026-10-28). During a session an empty file changes nothing, as Notepad empties a file before
    writing it (choice 3, the build's call).
  - The launch's warnings, printed to stderr, also show as grey lines when full screen opens, which
    would otherwise hide them until the user quits (found at Task 7's code review).
  - `~/.tachikoma` is made at launch when missing, with a plain `mkdir`, so the watcher has a folder
    to watch from the first session (choice 16, the build's call). Once the folder is removed, the
    watch closes with one line; a watch that cannot start still reads both files once, and says so.
  - An empty `--fallback` or `--worker` still wins over the file, turning its model off. `-p`
    ignores the file's `scrollSpeed`, as it ignores `TACHI_SCROLL_SPEED`, but a bad one still stops
    it, as the file is checked whole.
  - A live `effort` reaches the fallback and the subagents' worker too, as the launch's does
    (found at Task 9's spec review). A live `editor` is left as `VISUAL` or `EDITOR` set it, as an
    entry a flag gave is, and the line names the variable.
  - **Safety:** the file tools refuse the settings and keys files, and files named after them
    (`settings.json.*`, `keybindings.json.*`), in every mode, `never` included, by real path and
    file identity, as they refuse the data folder, and the search tools skip them: when the project
    is the home folder, `project` mode would otherwise let the model rewrite them unasked (choice 1,
    the build's call). This replaces the "Safety" bullet's `never` case; a shell command is not
    stopped, and the README says so.
  - `vimInsertModeRemaps` pairs are two letters, digits, punctuation marks or symbols, with no
    space, that are also two characters on screen (choice 24, the user's choice; found at Task 7's
    and Task 20's code reviews).
- **The keys file (Task 11)** settles its words and rules in choice 21 (the build's call): each
  problem's words are in `src/keybindings.ts` and its tests; a broken file keeps the default keys at
  launch and the last good keys after; an action is unknown only when Tachikoma has it in no
  context; `command:` takes only `/exit`, `/errors`, `/model`, `/screen`, `/tasks`, `/vim`,
  `/settings` and `/keybindings`, and waits in the queue during a turn; of one key bound twice the
  first stays; a top-level name other than `bindings`, `$schema` and `$docs` gets a line. The keys
  are read by the watcher's first read, so `-p` never reads them, and their problems show in the
  conversation in both screen modes.
- **The external editor (Task 12):**
  - It runs through the system's shell, as Git runs `core.editor`: `cmd.exe /d /s /c` on Windows,
    `/bin/sh -c` elsewhere, with the file's path quoted after the entry, so `code --wait` (a `.cmd`
    on Windows) works. On Windows `& exit` follows, so cmd's exit is the editor's, and a missing
    command gives 9009 (choice 4, the build's call; found at Task 12's build, measured). Its
    environment is the shell commands', without the keys.
  - The file is `prompt.md` in a fresh folder in the system's temporary folder (the user's own on
    Windows), opened with mode 0o600, removed with its folder after (choice 5, the build's call).
    Its line breaks are read as a paste's, as Notepad and VS Code on Windows save `\r\n`.
  - While the editor is open, a queued `/screen`, `/settings` or `/keybindings` waits, as each
    would hand the terminal over again; messages and other commands go on (Task 12).
  - Ctrl-C typed in the terminal while the editor runs, which comes as SIGINT as raw mode is off
    then, is ignored, and SIGQUIT too, as Git's editor launch ignores both: the session and a
    running turn go on (found at Task 12's spec review; settled at the final review, choice 31, the
    build's call).
  - Found and not settled: through `cmd.exe`, a `%` in the path given to the editor can be expanded
    (found at Task 12's build; a known limit in the README); and Windows 11's tabbed Notepad may hand
    the file to a Notepad window already open and exit at once (found at Task 12's code review).
    The plan's terminal checklist tries the second, and Ctrl-C during the editor.
- **Stash (Task 13).** The slot keeps where Up had got to with the prompt it takes, the draft typed
  before Up included, so Ctrl+S after Up loses no draft: once Ctrl+S brings that prompt back, Down
  brings the draft back (found at the final review; choice 31, the build's call).
- **Pictures (Tasks 14 to 18):**
  - Pictures live in memory for the session, never on disk; quitting drops them (choice 9, the
    build's call).
  - A marker deletes as one character: Backspace at its end or Delete at its start removes all of
    `[Image #2]`, so no broken marker text is left behind, where the design has a span go when any
    of its characters is deleted (choice 14, the build's call). What a word or line delete takes
    keeps its markers' spans, as vim's register does, so Ctrl+Y puts a picture back with its marker
    (found at the final review).
  - A message waiting on a read that fails or finds nothing is sent without that picture, its marker
    removed and a line saying so, rather than held back or put back in the prompt; Esc or Ctrl-C
    while it waits ends the wait the same way (choice 17, the build's call).
  - A picture shows in the conversation as its marker inside the user's line, in the line's colour,
    not grey (choice 22, the build's call).
  - Each picture sent goes right after a text `[Image #N]`, in all three adapters, so the model sees
    the number the user can point it at later (found at Task 16's build).
  - Provider errors keep their HTTP status, on the thrown error and on the bus's error event, so the
    400 question never reads an error's words (choice 10, the build's call).
  - The clipboard readers: Windows as the probe read it; macOS through `osascript`, whose script
    catches the coercion's error -1700 alone as no picture; Linux `wl-paste --type image/png` with
    `WAYLAND_DISPLAY`, else `xclip` with `DISPLAY`, a tool's own words for no PNG counting as none
    (choice 11, the build's call; choice 29, the user's choice). The macOS script was not run on a
    Mac. With no reader on Linux, no marker goes in, and one line says to install one.
  - A pasted line splits into paths where Claude Code 2.1.312's paste handler splits one, so two
    dragged files at once are two pictures; on Windows only `"` quotes, so an apostrophe is part of
    a name. A shell's `'\''` inside single quotes stays in the path as written, a gap Claude Code
    has too (choice 29, the user's choice). A pasted file's type is read from its first bytes, not
    its name (Task 15).
  - Anthropic's limit of 600 pictures a request, 100 for models with a 200k-token window, is
    applied too (the plan's numbers, from the same page). A megabyte is read as 1,000,000 bytes, as
    the pages do not say which, and the smaller keeps a request within either.
  - A format a provider does not list goes as PNG (choice 12). An animated GIF becomes its first
    frame in PNG only for OpenAI and the ChatGPT plan, where animation is documented as refused;
    the other providers get it as it is, and one shrunk in its own format keeps its frames. Kimi's
    "4k (4096×2160)" is read as a size class, so an upright picture fits inside 2160×4096. A
    picture sharp cannot read, or one over the limit even at one pixel, is sent as it is, so the
    provider decides. The line saying how many pictures a request left out goes out as a `note` on
    the bus, shown as a grey line (choice 23, the build's call).
  - The 400 question can come when Task 17 already turned every picture into a note, as the
    conversation still has picture parts; y then sends once more, and a second 400 ends the turn.
    When the lead refuses and the fallback's own request then gets a 400, the fallback is the one
    asked about and marked. The question shows without "Allow " in front (choice 25, the build's
    call).
- **Vim mode (Tasks 19 to 21):**
  - `/vim` alone switches vim mode on or off, and `/vim on` and `/vim off` set it, this window only;
    other words get `Usage: /vim, /vim on, /vim off` (choices 6 and 26, the build's call and the
    user's).
  - One yank register, as Claude Code's table describes, with no named registers (choice 13, the
    build's call).
  - The mode shows in the hint row in every mode, INSERT included, so vim mode can always be seen
    to be on; another hint takes the row first (choice 15, the build's call).
  - VISUAL's selection is drawn in reverse colours, as Claude Code 2.1.312 draws it; a picture's
    marker inside it is reversed like the rest (choice 28, the user's choice).
  - In VISUAL any Ctrl or Alt key goes to NORMAL first, then a bound key does its action and an
    editing key does nothing more; Enter sends from VISUAL too; a half-typed operator then Enter
    drops the command, where Claude Code's Enter sends; a change App makes to the prompt's text in
    VISUAL leaves it for NORMAL; `j`, `k` and `/` at the edges act as Up, Down and Ctrl+R do; `/vim`
    and live edits say `editorMode is now vim` and the like (choice 27, the build's call).
  - A change App makes to the prompt's text drops a command or count half typed too, so `d`, then
    Ctrl+P, then `w` moves in the line recalled rather than deleting from it (found at the final
    review). Where vim takes Esc first, in INSERT, VISUAL or with something half typed, the working
    line says `Esc Esc to stop` and `?` names Esc twice to stop and three times to clear (choice
    31, the build's call).
  - Counts stop at 10,000, as Claude Code's own code caps them (found at Task 20's code review).
    Claude Code's code also takes `` ` ``, `b`, `B`, `<`, `>`, `)`, `]` and `}` as text objects;
    they are not built, as the plan lists the docs' set (found at Task 20's code review).
- **OpenAI API context windows (Task 22).** `OPENAI_BASE_URL` set to `https://api.openai.com/v1`,
  with or without the trailing slash, counts as OpenAI's own address. Each row was checked against
  its page again on 2026-10-28.
- **`never` is switched off until release 7** (choice 30, the user's choice, after the final
  security review): `--mode never` or `"mode": "never"` in the settings file stops `tachi` and
  `tachi -p` at launch with one line, naming `ask` and `project`; a live edit to it is refused as
  before. This replaces "`never` only at launch" in the table above. Release 7 brings the sandbox,
  auto mode and a check on dangerous commands of every kind before `never` returns (main design,
  "`never` mode switched off").
- **The final security review's other fixes** (choice 30): after a live edit of the keys file,
  every key answers a permission question as at launch, the rest of the edit applying, with a
  line (the user's choice); the settings file's problems print at launch with control characters
  escaped; a pasted path starting with two slashes stays text and is never looked at (the user's
  choice); and before `~/.tachikoma` is made its path matches ignoring case on macOS too.
- **Testing.** The user's terminal checklist is in the plan's Task 23, to be run after the build.
