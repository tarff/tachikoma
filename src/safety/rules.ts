// The dangerous-command check's rules (release 7 design, "The dangerous-command check"; plan, Task 3 and choices 4, 43 and
// 44). A line is split into its commands (split.ts), and each command is matched by its first word, its name without a
// folder or .exe, and where a rule says, by its arguments. A line the reader cannot read counts as dangerous.

import { nameOf, scriptOf, type Shell, split } from "./split.js";

export const KINDS = ["wiping or formatting disks", "deleting whole folders", "permissions and system settings",
  "stopping processes or the machine", "rewriting or deleting git history", "sending files out", "installing software",
  "downloading and running code", "acting outside the machine"] as const;
export type Kind = (typeof KINDS)[number];
// `command` is the command's own text, for the red line; for the one danger of an unreadable line, it is why.
export interface Danger {
  kind: Kind | "unreadable";
  command: string;
}
// The project's root (/work in the box), the home folder, and the shell the line runs in (choice 3).
export interface Context {
  root: string;
  home: string;
  shell: Shell;
}

// How a danger is shown, in the red line and in a refusal.
export function shown(d: Danger): string {
  return d.kind === "unreadable" ? `the check cannot read it: ${d.command}` : `${d.kind}: ${d.command}`;
}

export function dangers(line: string, ctx: Context): Danger[] {
  const result = split(line, ctx.shell);
  if ("unreadable" in result) return [{ kind: "unreadable", command: result.unreadable }];
  const found: Danger[] = [];
  for (const { words, text } of result.commands) {
    for (const kind of matched(words, ctx)) {
      if (!found.some((d) => d.kind === kind && d.command === text)) found.push({ kind, command: text });
    }
  }
  return found;
}

// A rule's test of a command's arguments; ANY for a command named alone.
type Test = (args: string[], ctx: Context) => boolean;
const ANY: Test = () => true;

// The kinds a command matches. Names are matched without case everywhere: Windows and PowerShell ignore it, macOS's disks
// do by default, and PowerShell's text can reach a bash line through pwsh -c.
function matched(words: string[], ctx: Context): Kind[] {
  const [first, ...args] = words;
  if (first === undefined) return [];
  const name = nameOf(first).replace(/\.com$/, "").replace(/^mkfs\..+/, "mkfs").replace(/^pip[\d.]+$/, "pip");
  const kinds = KINDS.filter((kind) => RULES[kind][name]?.(args, ctx));
  if (!kinds.includes("downloading and running code") && fetched(first, words, name, args)) kinds.push("downloading and running code");
  return kinds;
}

// Choice 44: a script given as a web address to an interpreter the reader knows (scriptOf), a command a runner starts that
// is named by one (uv run https://...), or one given to deno install or deno x.
const WEB = /^https?:\/\//i;
function fetched(first: string, words: string[], name: string, args: string[]): boolean {
  if (WEB.test(first) || WEB.test(scriptOf(words) ?? "")) return true;
  return name === "deno" && ["install", "x"].includes(args[0] ?? "") && args.some((a) => WEB.test(a));
}

// The first word not starting with -, in lower case, and the words after it: a command's subcommand.
function sub(args: string[]): [string, string[]] {
  const k = args.findIndex((a) => !a.startsWith("-"));
  return k < 0 ? ["", []] : [args[k]!.toLowerCase(), args.slice(k + 1)];
}
// Whether a word is a bundle of short options holding a letter, as -rf holds r.
const short = (a: string, letter: string) => /^-[A-Za-z]+$/.test(a) && a.includes(letter);
// Whether a word is a PowerShell parameter, written as any start of its name, with or without :value.
const param = (a: string, full: string) => {
  const m = /^-([A-Za-z]+)(:.*)?$/.exec(a);
  return !!m && full.startsWith(m[1]!.toLowerCase());
};
const named = (...subs: string[]): Test => (args) => subs.includes(sub(args)[0]);
const anyWord = (...words: string[]): Test => (args) => args.some((a) => words.includes(a.toLowerCase()));

const RULES: Record<Kind, Record<string, Test>> = {
  "wiping or formatting disks": {
    format: ANY,
    diskpart: ANY,
    "clear-disk": ANY,
    "format-volume": ANY,
    "initialize-disk": ANY,
    mkfs: ANY,
    wipefs: ANY,
    fdisk: ANY,
    parted: ANY,
    dd: (args) => args.some((a) => a.startsWith("of=/dev/")),
    cipher: (args) => args.some((a) => /^\/w(:|$)/i.test(a)),
    wsl: (args) => args.includes("--unregister"), // choice 43: it deletes the distribution's disk
  },
  "deleting whole folders": {
    rm: deletesWhole(false),
    "remove-item": deletesWhole(false),
    del: deletesWhole(false),
    ri: deletesWhole(false),
    rd: deletesWhole(true),
    rmdir: deletesWhole(true),
  },
  "permissions and system settings": {
    icacls: ANY,
    takeown: ANY,
    cacls: ANY,
    "set-acl": ANY,
    chmod: (args) => args.some((a) => a === "--recursive" || short(a, "R")),
    chown: (args) => args.some((a) => a === "--recursive" || short(a, "R")),
    reg: ANY,
    "set-itemproperty": (args) => args.some((a) => /^(hklm|hkcu):/i.test(a)),
    bcdedit: ANY,
    "set-executionpolicy": ANY,
    netsh: ANY,
    sudo: ANY,
    su: ANY,
    doas: ANY,
    runas: ANY,
    // Start-Process makes the line unreadable (split.ts, choice 37), so this is met only if that changes.
    "start-process": (args) => args.some((a, k) => param(a, "verb") && /^runas$/i.test(args[k + 1] ?? "")),
    setx: ANY,
  },
  "stopping processes or the machine": {
    taskkill: ANY,
    "stop-process": ANY,
    kill: ANY,
    pkill: ANY,
    killall: ANY,
    shutdown: ANY,
    reboot: ANY,
    halt: ANY,
    poweroff: ANY,
    "stop-computer": ANY,
    "restart-computer": ANY,
    systemctl: named("stop", "poweroff", "reboot"),
    wsl: (args) => args.some((a) => ["--shutdown", "--terminate", "-t"].includes(a)), // choice 43
  },
  "rewriting or deleting git history": { git: rewritesHistory },
  "sending files out": {
    curl: uploads,
    wget: (args) => args.some((a) => a === "--post-file" || a.startsWith("--post-file=")),
    scp: ANY,
    rsync: (args) => remote(args.filter((a) => !a.startsWith("-")).at(-1) ?? ""),
    sftp: ANY,
    "invoke-webrequest": (args) => args.some((a) => param(a, "infile")),
    iwr: (args) => args.some((a) => param(a, "infile")),
    "invoke-restmethod": (args) => args.some((a) => param(a, "infile")),
    irm: (args) => args.some((a) => param(a, "infile")),
    nc: ANY,
    ncat: ANY,
  },
  "installing software": {
    npm: addsPackage,
    pnpm: (args, ctx) => addsPackage(args) || named("dlx")(args, ctx),
    yarn: (args, ctx) => addsPackage(args) || named("dlx")(args, ctx),
    bun: addsPackage,
    npx: ANY,
    bunx: ANY,
    pip: (args) => sub(args)[0] === "install" && pipPackage(sub(args)[1]),
    uv: (args) => {
      const [first, rest] = sub(args);
      return first === "add" || (first === "pip" && sub(rest)[0] === "install" && pipPackage(sub(rest)[1]));
    },
    uvx: ANY,
    pipx: ANY,
    cargo: named("install"),
    go: named("install"),
    gem: named("install"),
    winget: ANY,
    choco: ANY,
    scoop: ANY,
    apt: ANY,
    "apt-get": ANY,
    brew: ANY,
    dnf: ANY,
    yum: ANY,
    pacman: ANY,
    "install-module": ANY,
    "install-package": ANY,
  },
  // Also curl ... | sh and iex (iwr ...), which are unreadable, and a script from a web address (fetched).
  "downloading and running code": {},
  "acting outside the machine": {
    gh: (args) => {
      const [a = "", b = ""] = args.map((w) => w.toLowerCase());
      if (a === "api") return args.some((w, k) => /^(-X|--method)=?DELETE$/i.test(w) || (/^(-X|--method)$/.test(w) && /^delete$/i.test(args[k + 1] ?? "")));
      return (a === "pr" && b === "merge") || (["repo", "release"].includes(a) && b === "delete");
    },
    terraform: named("apply", "destroy"),
    pulumi: anyWord("up", "destroy"),
    kubectl: anyWord("delete", "apply"),
    helm: anyWord("uninstall"),
    aws: (args) => args.some((a) => /^(delete|terminate)/i.test(a) || /^rm$/i.test(a)),
    gcloud: anyWord("delete"),
    az: anyWord("delete"),
    docker: named("push"),
    npm: named("publish"),
  },
};

// rm with -r, -R or --recursive (any order with -f, until --), Remove-Item and its names with -Recurse, or cmd's rd and
// rmdir with /s (`cmd` here), whose target is a whole folder.
function deletesWhole(cmd: boolean): Test {
  return (args, ctx) => {
    let recursive = false;
    let ended = false;
    const targets: string[] = [];
    for (const a of args) {
      if (ended || !a.startsWith("-") || a === "-") {
        if (cmd && /^(\/[A-Za-z])+$/.test(a)) recursive ||= /\/s/i.test(a); // cmd's switches, as /s/q
        else targets.push(a);
      } else if (a === "--") ended = true;
      else recursive ||= a === "--recursive" || (/^-[dfiIrRv]+$/.test(a) && /[rR]/.test(a)) || param(a, "recurse");
    }
    return recursive && targets.some((t) => whole(t, ctx));
  };
}

// A drive root, the home folder, the project's root, or a folder written only with . and .. (., .., ../..), or *. A
// trailing / and a trailing /* are taken off, so ~/ and ~/* are the home folder. Windows paths compare without case.
function whole(target: string, ctx: Context): boolean {
  const t = tidy(target);
  if (/^([A-Za-z]:\/?|\/)$/.test(t) || t === "*" || t.split("/").every((p) => p === "." || p === "..")) return true;
  if (["~", "$home", "${home}", "$env:userprofile"].includes(t.toLowerCase())) return true;
  return [ctx.home, ctx.root].some((p) => same(t, tidy(p), ctx));
}
function tidy(path: string): string {
  const t = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/\*$/, "/");
  return t.length > 1 && !/^[A-Za-z]:\/$/.test(t) ? t.replace(/\/$/, "") : t;
}
function same(a: string, b: string, ctx: Context): boolean {
  const windows = ctx.shell === "powershell" || /^[A-Za-z]:/.test(a) || /^[A-Za-z]:/.test(b);
  return windows ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// git's options before its subcommand that take the next word (`git --help`).
const GIT_VALUES = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"];
function rewritesHistory(args: string[]): boolean {
  let k = 0;
  while (k < args.length && args[k]!.startsWith("-")) k += GIT_VALUES.includes(args[k]!) ? 2 : 1;
  const command = args[k]?.toLowerCase();
  const rest = args.slice(k + 1);
  const has = (long: string, letter: string) => rest.some((a) => a === long || short(a, letter));
  const dot = rest.some((a) => tidy(a) === ".");
  switch (command) {
    case "push": // --force, -f, --force-with-lease, --delete, -d, a :branch refspec, or a +branch one, which forces it
      return has("--force", "f") || has("--delete", "d") || rest.some((a) => a.startsWith("--force-with-lease") || /^[:+]./.test(a));
    case "reset":
      return rest.includes("--hard");
    case "clean":
      return has("--force", "f") && has("-d", "d");
    case "checkout":
      return dot;
    case "restore": // --staged alone only unstages
      return dot && (!has("--staged", "S") || has("--worktree", "W"));
    case "branch":
      return rest.some((a) => short(a, "D")) || (has("--delete", "d") && has("--force", "f"));
    case "filter-branch":
    case "filter-repo":
    case "rebase":
      return true;
    default:
      return false;
  }
}

// curl with -T, --upload-file, -F, --form..., or -d or --data... whose value starts with @ (a file's contents). A bundle
// of short options holding T or F counts, as does a d whose value, after it or in the next word, starts with @.
function uploads(args: string[]): boolean {
  return args.some((a, k) => {
    const next = args[k + 1] ?? "";
    if (a === "--upload-file" || a.startsWith("--form")) return true;
    if (a.startsWith("--data")) return next.startsWith("@");
    const m = /^-([A-Za-z]*?)d(.*)$/.exec(a);
    return /^-[A-Za-z]*[TF]/.test(a) || (!!m && /^[A-Za-z]*$/.test(m[1]!) && (m[2] || next).startsWith("@"));
  });
}

// rsync's target on another machine: host:path or user@host:path, not a drive letter, or an rsync:// address.
const remote = (target: string) => /^rsync:\/\//i.test(target) || /^[^/:]{2,}:/.test(target);

// npm, pnpm, yarn and bun's install, i or add with a package named: a word after it not starting with -.
function addsPackage(args: string[]): boolean {
  const [command, rest] = sub(args);
  return ["install", "i", "add"].includes(command) && rest.some((a) => !a.startsWith("-"));
}

// pip install's words name a package: a word not starting with -, other than the file -r or -c names.
function pipPackage(rest: string[]): boolean {
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k]!;
    if (["-r", "--requirement", "-c", "--constraint"].includes(a)) k++;
    else if (!a.startsWith("-")) return true;
  }
  return false;
}
