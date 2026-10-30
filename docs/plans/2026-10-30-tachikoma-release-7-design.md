# Tachikoma release 7: the sandbox, auto mode and the dangerous-command check, design (2026-10-30)

Release 7 of Tachikoma. The overall design, the Decisions table and the release order are in
[2026-10-22-tachikoma-design.md](2026-10-22-tachikoma-design.md). Section 3 of that design,
"Sandbox", already settles most of how the sandbox works; this design says what release 7
builds of it, and what it adds.

Release 7 makes it safe to let Tachikoma act without asking. It brings the three things release 6
made `never` mode wait for (user, 2026-10-29: "we can't have never mode deleting a filesystem"):
the Docker sandbox, auto mode, and a check on dangerous commands of every kind. It also brings
Shift+Enter in Windows Terminal. Each part below was chosen by the user on 2026-10-30 from options
offered, unless it says otherwise.

Sources:
- **Claude Code's auto mode:** code.claude.com/docs/en/permission-modes.md, read on 2026-10-30.
  Reads and edits in the working directory are approved without asking; everything else goes to a
  classifier model (Claude Sonnet 5 by default). It sees the user's messages, the tool calls and
  CLAUDE.md; tool results are stripped, "so hostile content in a file or web page can't manipulate
  the classifier directly". A blocked action's reason goes back to the model; "if the classifier
  blocks an action 3 times in a row or 20 times total, auto mode pauses and Claude Code resumes
  prompting", and the thresholds are not configurable. A classifier answer that does not parse
  denies the action. In `-p` a block is final and the run carries on. Its default block list
  includes downloading and running code, sending sensitive data out, force push, `git reset
  --hard`, `git clean -fd`, production deploys, mass deletion on cloud storage, granting
  permissions, and merging a pull request no human approved; it allows installing what lock files
  or manifests declare. Boundaries stated in the conversation ("don't push") count, but
  compaction can drop them. The page warns: "Auto mode reduces permission prompts but does not
  guarantee safety."
- **Other tools' sandboxes,** looked at when the user asked whether Docker is the best way:
  Claude Code's sandbox uses Seatbelt on macOS and bubblewrap on Linux and WSL2, and its docs say
  native Windows is not supported (code.claude.com/docs/en/sandboxing.md, read on 2026-10-30).
  Codex's Windows sandbox runs commands under a restricted token and works by changing folder
  permissions (ACLs), adding sandbox user accounts and, in its stronger setting, firewall rules
  (openai.com/index/building-codex-windows-sandbox/, and third-party write-ups that report gaps in
  folders anyone can write to, such as Temp).

## Why Docker

Asked "Is docker the best way?", the user chose Docker (2026-10-30: "Yes docker"), over each
operating system's own sandbox:
- It works the same on Windows, macOS and Linux, so one mechanism is built and tested once. The
  built-in route is three different systems, and the Windows one is the weakest.
- It never changes the user's permissions. Codex's Windows sandbox works by changing folder
  permissions and adding accounts, which the user's standing rule forbids.
- A container sees only what is mounted into it: the firmest boundary, which `never` now relies on.
- **The cost, said plainly:** on Windows the container runs Linux, so inside the sandbox only Linux
  commands run. Windows-only tools (Windows PowerShell 5.1, `.exe` programs, Windows builds) need
  the sandbox off and the asking modes. Docker Desktop must be running, and live link reads large
  Windows folders slowly.

The built-in sandboxes for macOS and Linux stay a possible later addition, as a second executor;
the tools already cannot tell which executor runs them. Windows would stay on Docker.

## Launching

**The sandbox is off unless asked for** (option chosen: "Off unless asked").
- `--sandbox off | live | copy`, or `"sandbox"` in settings.json. Off is the default.
  - `live`: commands run in a container that works on the real project folder.
  - `copy`: they run on a copy, and the user reviews the changes at the end.
- Asking for the sandbox when Docker is missing or not running stops the launch, with one line
  saying what to start. Tachikoma never falls back to running on the host (the main design's
  safeguards).

**The network in the box is off unless asked for** (option chosen: "Off").
- `--network off | on`, or `"network"` in settings.json. Off is the default, and the setting acts
  only with the sandbox on. It covers commands in the box; Tachikoma's own requests to the model
  are made from the host, as the main design says.
- With the network off, an install, `git push` or download in the box fails, and the error says
  the network is off and how to turn it on.
- **The list of allowed sites moves to release 8** (option chosen: "Later, off and on only now").
  Release 8's MCP client needs the same address check (main design, "MCP tools"), so the two are
  built together, with the name-lookup measurement (main design, "Still to measure", item 15).

**The image is built on the user's PC, after asking** (option chosen: "Built here, after asking").
Tachikoma ships a Dockerfile with Node, Python, git and uv, its base image pinned by digest. The
first time the sandbox is used, Tachikoma says what it will download (the base image from Docker
Hub, and the Linux packages) and asks; on yes it builds the image, and reuses it after that. `sfw`
covers npm- and pip-style installs, not Docker, which is why this asks. A project can supply its
own Dockerfile, under the main design's no-special-powers rules.
- **`tachi sandbox build`** (new) does the same on its own: it shows what it will download, asks,
  and builds.
- **Headless, nothing is built.** `tachi -p` with the sandbox, when the image is not built yet or
  its Dockerfile (Tachikoma's or the project's) has changed since, stops at once with one line
  saying to run `tachi sandbox build` first. It never waits for an answer and never builds without
  one. There is no switch to approve the download in advance.

**The modes:** `ask`, `project`, `auto` (new) and `never` (back).
- **`never` is allowed only with `--sandbox copy`** (options chosen: "Only in the sandbox", then,
  after the design review, "Copy mode only"). Asked for without it, the launch stops with one line
  saying how to turn copy mode on. On the host it stays refused, as in release 6. Live link is
  refused too: there the box writes the real folder, and any project file the user later runs on
  the host (a `package.json` script, a Makefile, a hook) could be changed unattended. In copy mode
  nothing written reaches the real folder until the user has seen it in the review.
- **`auto`** works on the host or in the sandbox, as Claude Code's does (option chosen: "Copy
  Claude Code"). See "Auto mode" below.
- `--judge <provider:model>`, or `"judge"` in settings.json: the model that judges for auto mode.
  Unset, the lead's own model judges, through the login already in use (option chosen: "Setting;
  lead's model if unset").
- Shift+Tab cycles `ask`, `project`, `auto`. `never` joins the cycle only when the session was
  launched in `never`, as now.
- A live edit of `"mode"`, `"sandbox"` or `"network"` in settings.json waits for the next launch,
  as `"mode"` already does (release 6, choice 32), with the same kind of grey line.

## The sandbox

**One container for each session,** started with `docker run`, set up as the main design's section
3 says: not root, no special powers, no access to Docker itself, nothing from the host mounted but
the project folder (or its copy), none of Tachikoma's keys or logins, and the network off or on.
Shell commands run in it in bash, through `DockerExecutor`. Esc stops a running command in the box
as it does now.

**Nothing on the host opens a path in the box's folder while the box runs.** Today `read_file`,
`write_file`, `edit_file`, `find_files` and `search_files` read the disk directly on the host
(`src/tools/search.ts`) and work out paths there (`src/tools/files.ts`), and so do the `@` menu's
listing (`src/tui/menus.ts`) and the status line's branch (`src/tui/git.ts`). A command in the box
can swap any part of a path for a link between a check and the open that follows it; refusing a
link on the last part of the path (`O_NOFOLLOW`) does not cover the folders above it, and Windows
has no simple equal. So in the sandbox:
- **All of these go through the box.** A small helper, sent into the container with each call so
  the image need not change with each Tachikoma version, does the reading, writing, listing and
  searching there. Inside the container a link can lead only to what the container can see, so
  there is no race to win: the confinement is the mount itself.
- **The session's root is the box's folder,** `/work` in the box: the real folder in live link, the
  copy in copy mode. A path outside it is refused; in the sandbox there is no question to approve
  it.
- **Copy mode's review and apply run on the host only after the box has stopped,** so no command in
  it can race them. They follow the main design's rules for links.
- **Read on the host before the box starts:** the instruction files (AGENTS.md, CLAUDE.md) and git's
  settings (below). Nothing in the box is running yet to race them.

**Live link: the holes closed, and what stays open.** The container writes straight into the real
folder, so before the box starts:
- **All of `.git` is read-only in the box** (option chosen: "Whole .git read-only", over Claude
  Code's way, which leaves the box `.git` to write except `hooks` and `config`, and whose docs do
  not cover git's includes). Git commands that only read work in the box (`log`, `diff`,
  `status`); commits, checkouts and branch switches fail, and the user commits on the host. Copy
  mode keeps full git, on the copy's own repository (main design, "Git").
- **So are the project files git's settings include.** Git's settings can include other files
  (`include.path`), and some only under a condition such as the branch (`includeIf`), which the box
  could change. Starting from every settings file git reads for the project (the system's, the
  user's, and the repository's), Tachikoma follows every include and includeIf, whatever the
  condition, reading each file with `git config --file` (which runs nothing). Every included file
  inside the project is read-only in the box, as is every folder those settings name for hooks
  (`core.hooksPath`, so a `.husky` folder is covered). An included path that is a link, or cannot be
  read, refuses live link with one line saying which, and offers copy mode.
- **Claude Code's top-level block, as far as mounts allow:** a `HEAD`, `objects`, `refs` or
  `config` already at the top of the project is read-only in the box, as Claude Code denies writes
  to them, so the project folder itself cannot be turned into a git repository with the box's
  settings. A mount cannot cover one that does not exist yet; that case is the next item's.
- **When `.git` is a file** (a linked worktree or a submodule), it is read-only in the box, so it
  cannot be pointed at a git folder the box controls. The real git folder is outside the project,
  so it is not mounted, and git does not work in the box there; the line at launch says so.
- **`.tachikoma/` is hidden from the box.** It holds the error log and backups.
- **What stays open, said plainly:**
  - A command in the box can change any other project file the user later runs on the host, such
    as a `package.json` script or a Makefile. No mount rule can protect ordinary project files.
  - It can also make a folder inside the project, the top one included, look like a git
    repository of its own (its own `HEAD`, `objects`, `refs` and `config`). Git run later in that
    folder on the host would use the box's settings instead of the real `.git`. Git's own setting `safe.bareRepository = explicit`
    refuses such a repository unless it is named on purpose; Tachikoma never changes the user's git
    settings, so the README recommends it.
  - This is why `never` is refused in live link, and why the README says copy mode is the one to
    use when a session's work should be reviewed first.

**Resource limits.** Docker sets none by default ("a container has no resource constraints",
docs.docker.com/engine/containers/resource_constraints/, read on 2026-10-30), so a runaway command
could use all the memory, processes or disk Docker Desktop has. Each container gets a memory limit
(`--memory`, with `--memory-swap` the same, so no swap), a CPU limit (`--cpus`) and a process limit
(`--pids-limit`).
- **No number is set until it is measured** (see "Before the build"). The defaults come from that
  measurement, chosen with the user and recorded; `"sandboxLimits"` in settings.json changes them.
- **When a limit is hit:** over the memory limit, the kernel kills processes in the box; Tachikoma
  reads Docker's out-of-memory flag and says the command was stopped for using more than the limit,
  naming the setting. Over the process limit, new processes fail, and the command's own error
  shows.
- **Disk:** whether Docker Desktop can limit a container's disk is measured too. If it cannot, the
  design says so and there is no disk limit; a copy lives on the host's disk like any folder.

**Copy, then review:**
- The snapshot is taken outside the project at the start, as the main design describes.
- When the session ends (`/exit` or Ctrl-D), Tachikoma opens a review in full screen: every added,
  changed and deleted file, each one's diff, and a choice to keep or skip it. A conflict offers the
  three-way merge or a skip. Links, and paths that changed type, are shown but never applied. The
  apply follows the main design's rules (backups, the applied-changes log, one step per file).
- `tachi review` (new) lists the copies still waiting and reopens the review for one. A copy is kept
  whenever a session is stopped, crashes or runs headless: `tachi -p` prints the session's name and
  how to review it. Nothing is thrown away until the user has reviewed it or chosen to discard it.

## Protected paths

Some project files are run or read as settings by other programs on the host, so writing one can
plant a command that runs later, outside any question. Writes to them are never approved without a
check, in every mode, with or without the sandbox. The list is Claude Code's
(code.claude.com/docs/en/permission-modes.md, "Protected paths", read on 2026-10-30), plus
Tachikoma's own:
- **Folders:** `.git`, `.config/git`, `.vscode`, `.idea`, `.husky`, `.cargo`, `.devcontainer`,
  `.yarn`, `.mvn`, `.claude`, `.tachikoma`, and the folder git runs hooks from when
  `core.hooksPath` names another.
- **Files:** `.gitconfig`, `.gitmodules`; the shell start-up files (`.bashrc`, `.bash_profile`,
  `.bash_login`, `.bash_aliases`, `.bash_logout`, `.zshrc`, `.zprofile`, `.zshenv`, `.zlogin`,
  `.zlogout`, `.profile`, `.envrc`); `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `.pnp.cjs`,
  `.pnp.loader.mjs`, `.pnpmfile.cjs`, `bunfig.toml`, `.bunfig.toml`; `.bazelrc`, `.bazelversion`,
  `.bazeliskrc`; `.pre-commit-config.yaml` and lefthook's files; `gradle-wrapper.properties`,
  `maven-wrapper.properties`; `.devcontainer.json`; `.ripgreprc`, `pyrightconfig.json`;
  `.mcp.json`, `.claude.json`.
- **A path counts by where it really leads,** after links, as release 1's rule for "outside the
  project" already does.

**What each mode does with a write to one:**
- `ask`: asks, as for any write.
- `project`: **asks** (option chosen: "Yes, ask there too"). This changes release 6, where
  `project` wrote any project file without asking, hooks included.
- `auto`: goes to the judge, never the fast path below.
- `never`: refused, and the reason goes back to the model.

This covers the file tools. A shell command that writes such a file is a shell command: it asks in
`ask` and `project`, goes to the check and the judge in `auto`, and in the sandbox meets the
read-only mounts above.

## Auto mode

Each action in `auto` is decided in this order:
1. Reads, and edits inside the project, run without asking, except writes to a protected path
   (above), which go to the judge.
2. The dangerous-command check (below). A match skips the judge and asks the user.
3. Everything else goes to the judge, as a fresh request with no tools. It gets the user's
   messages, the actions asked for, and the user's AGENTS.md or CLAUDE.md; never what tools
   returned.
4. The judge answers yes, or no with a reason. An answer that cannot be read, or a judge that
   cannot be reached, counts as a no, as in Claude Code.
   - A no goes back to the model with the reason, so it can try another way.
   - After 3 refusals in a row, or 20 in the session, the user is asked instead, and approving one
     action resumes auto mode. Both numbers are Claude Code's, from its docs (Sources above); they
     have not been measured for Tachikoma.
   - Headless (`tachi -p`), a no is final, and the run carries on.

**An answer counts only for the rules it was given under.** A judge request takes time, and things
can change while it is out:
- **Stopping cancels it.** Esc, a stopped turn, or the end of the session cancels the request; a
  late answer is thrown away, and the action does not run.
- **Everything is checked again just before the action runs:** the mode is still `auto`, and the
  dangerous-command check and the protected paths, with the rules as they are at that moment, still
  let it through to the judge. If the mode changed (Shift+Tab to `ask`, say), the judge's answer is
  thrown away and the action is decided again under the new mode, so it asks. If a rule the user
  added since now matches, the action is decided again, so it asks.
- A judge's yes is never kept for later: the same action asked for again goes to the judge again.

What the user says in the conversation, such as "don't push", counts, since the judge sees the
user's messages. Release 8's shortening of long conversations could drop such a line, so the README
says so, and points to the check's own settings for a hard rule.

The judge's tokens and cost count in the status line, as part of the session's totals.

## The dangerous-command check

Code, not a model. Every shell command is split into its separate commands (`a && b`, `a; b`,
pipes, `$(...)`), and each is matched against a fixed list of rules. Shell commands run in
PowerShell on the host and in bash in the sandbox, so the rules cover both, `cmd /c` from
PowerShell included. The kinds, from the main design's examples, the user's words and Claude Code's
default block list:

| Kind | Examples |
|---|---|
| Wiping or formatting disks | `format`, `diskpart`, `Clear-Disk`, `mkfs`, `dd of=/dev/...` |
| Deleting whole folders | `rm -rf` or `Remove-Item -Recurse` on a drive root, the home folder or the project itself |
| Permissions and system settings | `icacls`, `takeown`, `Set-Acl`, `chmod -R`, `reg`, `bcdedit`, `Set-ExecutionPolicy`, `netsh`, `sudo`, `runas` |
| Stopping processes or the machine | `taskkill`, `Stop-Process`, `kill`, `pkill`, `shutdown` |
| Rewriting or deleting git history | `push --force`, `reset --hard`, `clean -fd`, `checkout -- .`, `branch -D`, `filter-branch`, `push --delete` |
| Sending files out | `curl -T`, `-F` or `-d @file`, `scp`, `rsync` to another machine, `Invoke-WebRequest -InFile` |
| Installing software | `npm install <package>`, `pip install`, `winget`, `choco`, `apt`, `npx` |
| Downloading and running code | `curl ... \| sh`, `iex (iwr ...)` |
| Acting outside the machine | `gh pr merge`, `gh repo delete`, `terraform destroy`, `kubectl delete` |

- **Installs from the lock file pass,** as in Claude Code: `npm ci`, or `npm install` with no
  package named. An install that names a new package matches.
- **A command the check cannot read counts as dangerous:** `eval`, `Invoke-Expression`,
  `-EncodedCommand`, and text piped into a shell. Hiding what a command does is treated like a
  match.
- **What happens on a match** (option chosen: "Warn, or ask, or refuse"):
  - `ask` and `project`: the usual question, with a red line naming each danger.
  - `auto`: always asks the user; the judge can never approve it.
  - `never`, and headless: refused, and the reason goes back to the model.
- **What it cannot do, said plainly:** a script can do any of these things unseen (`python
  wipe.py`). The check catches the common cases; the sandbox is the real boundary.

**Configurable in release 7, from the user's own settings file only** (option chosen: "In release
7"). In `~/.tachikoma/settings.json` the user can add rules of their own (a command and its first
words, such as `terraform apply`) and switch off a kind by name. There is no settings file in a
project, so a downloaded repo can never loosen the check.
- **A change that loosens the check gets a warning, not a question** (user: "Just a warning before
  changing it"). Saving it shows the live-edit notice as a warning that names what is loosened, for
  example `settings.json: dangerous-command check: "installing software" switched off; in auto and
  never, those commands will run without the check. Takes effect at the next launch.`, in the hint
  row as release 6's notices are. While any kind is off, each launch prints one warning line naming
  it.
- A rule the user adds only makes the check stricter: it gets an ordinary notice, and applies at
  once.
- A switched-off kind is shown as off wherever the kinds are listed, so what is not checked stays
  visible.

The plan settles the exact rules, each with a test, including commands that look close but are
fine, such as `git push` without `--force`.

## Shift+Enter in Windows Terminal

As already decided (main design, Decisions, "Shift+Enter in Windows Terminal"): first re-test
whether the user's Windows Terminal now answers the kitty keyboard protocol; if it still does not,
read Windows Terminal's own win32 input mode, which reports each key with its Shift, Ctrl and Alt
state.

## Setup

`tachi setup` (release 13) gains release 7's choices: building the image, picking the judge, and
the sandbox and network defaults (user, 2026-10-30: "We'll need a setup wizard for all this at some
stage"). Until then, the first launch with the sandbox asks before building the image.

## When something goes wrong

- Docker missing or not running, with the sandbox asked for: the launch stops with one line.
- The image not built, headless: the launch stops with one line naming `tachi sandbox build`.
- A git include in live link that is a link or cannot be read: live link is refused with one line
  naming it, and copy mode is offered.
- Docker failing during a session: shell and file tools refuse to run, with the error; they never
  fall back to the host (main design, "Safeguards").
- The image build failing: the launch stops, showing the build's last lines.
- The judge failing: its no-answer counts as a no (above), and the error goes to the error log.
- A command over the box's memory limit: stopped by the kernel; Tachikoma says so and names the
  setting (see "Resource limits").
- A copy-then-review session that crashes or is stopped: its copy is kept for `tachi review`.

## Before the build

**The resource limits are measured first,** as the plan's first step, with a script whose results
are recorded:
- the peak memory, CPU and number of processes in the box for real work: Tachikoma's own `npm ci`,
  test suite and build, run in the sandbox image;
- how much memory and how many CPUs Docker Desktop has on the user's PC;
- whether a container's disk can be limited on Docker Desktop.

The user chooses the defaults from those numbers; none is guessed. The other numbers in this
design are auto mode's 3 and 20, which are Claude Code's, labelled as such, with its docs as the
source. The name-lookup measurement moves to release 8 with the site list.

## Testing

- **The check:** a table of commands for each kind, in bash and PowerShell, each expected to match
  or pass, including near misses.
- **Auto mode:** against a fake provider as judge: yes, no, an answer that cannot be read, the 3 and
  20 limits, approving one action to resume, headless, and that tool results never reach the judge.
  A pending answer: thrown away on Esc, on a mode switch (the action then asks), and when a rule
  added meanwhile matches.
- **Protected paths:** a write to each kind of path in each mode, including one reached through a
  link, and `project` mode now asking for them.
- **The modes:** `never` refused without `--sandbox copy`, live link included; Shift+Tab's cycle;
  live edits waiting.
- **The sandbox:** integration tests on real Docker, skipped with a message when Docker is not
  running:
  - the container's settings: not root, no special powers, network off, and the memory, CPU and
    process limits, with a command stopped over the memory limit and the message naming it;
  - in live link: all of `.git` read-only (a commit fails, `git log` and `git diff` work); a file
    included from `.git/config`, through `include` and through an `includeIf` whose condition is
    not met, read-only; a hooks folder named by `core.hooksPath` (`.husky`) read-only; an existing
    top-level `HEAD` or `config` read-only; a `.git` file read-only; `.tachikoma` hidden; an
    included path that is a link refusing live link;
  - the file tools, the `@` menu and the branch going through the box: in copy mode they read,
    list and search the copy, never the real folder; a link made in the box to a folder outside
    `/work` leads nowhere on the host; and nothing on the host opens a path in the box's folder
    while the box runs;
  - headless with no image: the one line, at once, and nothing built;
  - Esc stopping a command, and copy-then-review's apply, conflicts and `tachi review`.
- **In the user's terminal,** a checklist run once: launching each sandbox mode, a command in the
  box, network off, a dangerous command in each mode, auto mode's judge, the review at the end of a
  copy session, and Shift+Enter.

## Not in this release

- The list of allowed sites, and its proxy: release 8, with the MCP client.
- The operating systems' built-in sandboxes for macOS and Linux: a possible later addition, with no
  release yet.
- Containers for workers: release 11, with delegation.
- MCP servers inside the box: release 8.
- Loops in the sandbox: release 12.
- A settings file in each project.
