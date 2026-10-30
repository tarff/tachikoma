// The dangerous-command check's rules (release 7 design, "The dangerous-command check"; plan, Task 3 and choices 4 and
// 43-46). A line is split into its commands (split.ts), and each command is matched by its first word, its name without a
// folder or .exe, and where a rule says, by its arguments. A line the reader cannot read counts as dangerous.

import path from "node:path";
import { nameOf, scriptOf, type Shell, split, WSL_VALUES } from "./split.js";

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
  // A line starts in the project's root. A cd anywhere on it leaves the folder unknown: the reader does not follow
  // subshells, so it cannot tell where the cd still holds.
  const where: Where = { ...ctx, cwd: result.commands.some(({ words }) => moves(words)) ? undefined : ctx.root };
  const found: Danger[] = [];
  for (const { words, text } of result.commands) {
    for (const kind of matched(words, where)) {
      if (!found.some((d) => d.kind === kind && d.command === text)) found.push({ kind, command: text });
    }
  }
  return found;
}

// The context, with the folder the line's commands run in, undefined when a cd leaves it unknown.
interface Where extends Context {
  cwd: string | undefined;
}

// Commands that change the folder the rest of the line runs in: cd and its PowerShell names (Set-Location's cd, chdir and
// sl; pushd and popd), and env -C or --chdir and sudo -D or --chdir, which run their command elsewhere.
const MOVES = ["cd", "chdir", "pushd", "popd", "set-location", "sl", "push-location", "pop-location"];
function moves(words: string[]): boolean {
  const [first = "", ...args] = words;
  const name = nameOf(first);
  if (MOVES.includes(name)) return true;
  const option = name === "env" ? "C" : name === "sudo" ? "D" : undefined;
  return !!option && args.some((a) => !!long(a, ["chdir"]) || (/^-[A-Za-z]+/.test(a) && !a.startsWith("--") && a.includes(option)));
}

// A rule's test of a command's arguments; ANY for a command named alone. `first` is the command's first word as written.
type Test = (args: string[], ctx: Where, first: string) => boolean;
const ANY: Test = () => true;

// The kinds a command matches. Names are matched without case everywhere: Windows and PowerShell ignore it, macOS's disks
// do by default, and PowerShell's text can reach a bash line through pwsh -c.
function matched(words: string[], ctx: Where): Kind[] {
  const [first, ...args] = words;
  if (first === undefined) return [];
  const name = nameOf(first)
    .replace(/\.com$/, "")
    .replace(/^mkfs\..+/, "mkfs")
    .replace(/^pip[\d.]+$/, "pip")
    .replace(/^(python|pypy)[\d.]*$|^py$/, "python");
  const kinds = KINDS.filter((kind) => Object.hasOwn(RULES[kind], name) && RULES[kind][name]!(args, ctx, first)); // not toString
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

// Where a command's subcommand may be: its first word that is not an option (- or +, as cargo's +nightly), and while each
// such word follows an option whose value it may be, the next one too. So a tool's own options before its subcommand
// need not be known: `npm --prefix d install` finds install, and `npm -g install` too.
function subs(args: string[]): number[] {
  const at: number[] = [];
  for (let k = 0; k < args.length; k++) {
    if (/^[-+]/.test(args[k]!)) continue;
    at.push(k);
    const before = args[k - 1];
    if (!before?.startsWith("-") || before.includes("=")) break;
  }
  return at;
}
// The words after a command's subcommand, when it is one of `names` (in any case).
function after(args: string[], ...names: string[]): string[] | undefined {
  const k = subs(args).find((i) => names.includes(args[i]!.toLowerCase()));
  return k === undefined ? undefined : args.slice(k + 1);
}
const named = (...names: string[]): Test => (args) => after(args, ...names) !== undefined;
const anyWord = (...words: string[]): Test => (args) => args.some((a) => words.includes(a.toLowerCase()));
// Whether a word is a bundle of short options holding a letter, as -rf holds r.
const short = (a: string, letter: string) => /^-[A-Za-z]+$/.test(a) && a.includes(letter);
// The long option a word names (--name or --name=value), read as GNU's getopt_long and git read them: the name itself, or
// any start of it. An ambiguous start makes the tool refuse to run, so the first of `names` it starts is taken.
function long(a: string, names: string[]): string | undefined {
  const given = /^--([^=]+)/.exec(a)?.[1];
  return given === undefined ? undefined : (names.find((n) => n === given) ?? names.find((n) => n.startsWith(given)));
}
// Whether a word is a PowerShell parameter, written as any start of its name, with or without :value.
const param = (a: string, full: string) => {
  const m = /^-([A-Za-z]+)(:.*)?$/.exec(a);
  return !!m && full.startsWith(m[1]!.toLowerCase());
};
// Invoke-WebRequest's and Invoke-RestMethod's -InFile, which uploads a file. Windows PowerShell 5.1's curl and wget name
// Invoke-WebRequest; there -InFile is taken from -in on, as curl's own -I (only the headers) is the same letter.
const inFile: Test = (args) => args.some((a) => param(a, "infile"));
const aliasInFile = (args: string[], ctx: Where, first: string) =>
  ctx.shell === "powershell" && /^(curl|wget)$/i.test(first) && args.some((a) => a.length > 2 && param(a, "infile"));

// Every built-in name of Remove-Item (its documentation's Notes), and cmd's rd, rmdir, del and erase, which take /s.
const REMOVE = ["rm", "remove-item", "ri", "rd", "rmdir", "del", "erase"];
const CMD_REMOVE = ["rd", "rmdir", "del", "erase"];

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
    wsl: (args) => wslOwn(args).includes("--unregister"), // choice 43: it deletes the distribution's disk
  },
  "deleting whole folders": Object.fromEntries(REMOVE.map((n): [string, Test] => [n, deletesWhole(CMD_REMOVE.includes(n))])),
  "permissions and system settings": {
    icacls: ANY,
    takeown: ANY,
    cacls: ANY,
    "set-acl": ANY,
    chmod: (args) => args.some((a) => !!long(a, ["recursive"]) || short(a, "R")),
    chown: (args) => args.some((a) => !!long(a, ["recursive"]) || short(a, "R")),
    reg: ANY,
    "set-itemproperty": (args) => args.some((a) => /^(hklm|hkcu):/i.test(a)),
    sp: (args) => args.some((a) => /^(hklm|hkcu):/i.test(a)), // Set-ItemProperty's built-in name
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
    kill: ANY, // also Stop-Process's built-in name, as spps is
    spps: ANY,
    pkill: ANY,
    killall: ANY,
    shutdown: ANY,
    reboot: ANY,
    halt: ANY,
    poweroff: ANY,
    "stop-computer": ANY,
    "restart-computer": ANY,
    systemctl: named("stop", "poweroff", "reboot"),
    wsl: (args) => wslOwn(args).some((a) => ["--shutdown", "--terminate", "-t"].includes(a)), // choice 43
  },
  "rewriting or deleting git history": { git: rewritesHistory },
  "sending files out": {
    curl: (args, ctx, first) => uploads(args) || aliasInFile(args, ctx, first),
    wget: (args, ctx, first) => args.some((a) => !!long(a, ["post-file"])) || aliasInFile(args, ctx, first),
    scp: ANY,
    rsync: (args) => remote(args.filter((a) => !a.startsWith("-")).at(-1) ?? ""),
    sftp: ANY,
    "invoke-webrequest": inFile,
    iwr: inFile,
    "invoke-restmethod": inFile,
    irm: inFile,
    nc: ANY,
    ncat: ANY,
  },
  "installing software": {
    npm: (args) => addsPackage(args, NPM_INSTALL) || runsPackage(after(args, "exec", "x")),
    pnpm: (args, ctx, first) => addsPackage(args, INSTALL) || named("dlx")(args, ctx, first),
    yarn: (args, ctx, first) => addsPackage(args, INSTALL) || named("dlx")(args, ctx, first),
    bun: (args) => addsPackage(args, [...INSTALL, "a"]) || runsPackage(after(args, "x")),
    npx: ANY,
    bunx: ANY,
    pip: (args) => pipPackage(after(args, "install")),
    python: (args) => pipPackage(after(pipOf(args) ?? [], "install")), // python -m pip, and py's
    uv: (args) => after(args, "add") !== undefined || pipPackage(after(after(args, "pip") ?? [], "install")),
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
    inmo: ANY, // Install-Module's built-in name
    "install-package": ANY,
  },
  // Also curl ... | sh and iex (iwr ...), which are unreadable, and a script from a web address (fetched).
  "downloading and running code": {},
  "acting outside the machine": {
    gh: (args) => {
      if (after(args, "api") !== undefined) {
        return args.some((w, k) => /^(-X|--method)=?DELETE$/i.test(w) || (/^(-X|--method)$/.test(w) && /^delete$/i.test(args[k + 1] ?? "")));
      }
      const pr = after(args, "pr");
      const repo = after(args, "repo", "release");
      return (!!pr && after(pr, "merge") !== undefined) || (!!repo && after(repo, "delete") !== undefined);
    },
    terraform: named("apply", "destroy"),
    pulumi: named("up", "destroy"),
    kubectl: anyWord("delete", "apply"),
    helm: anyWord("uninstall", "del", "delete", "un"), // uninstall's other names, from helm's source
    // An operation named delete... or terminate..., s3 rm, and s3 sync --delete, which deletes what is not on the source.
    aws: (args) =>
      args.some((a) => /^(delete|terminate)/i.test(a) || /^rm$/i.test(a))
      || (args.some((a) => /^sync$/i.test(a)) && args.some((a) => !!long(a, ["delete"]))),
    gcloud: anyWord("delete"),
    az: anyWord("delete"),
    docker: named("push"),
    npm: named("publish"),
  },
};

// wsl's own options, before the command it runs (as split.ts reads them): a -t after that is the command's.
function wslOwn(args: string[]): string[] {
  const own: string[] = [];
  for (let k = args[0] === "~" ? 1 : 0; k < args.length; k++) {
    const a = args[k]!;
    if (!a.startsWith("-") || ["-e", "--exec", "--"].includes(a)) break;
    own.push(a);
    if (WSL_VALUES.includes(a)) k++;
  }
  return own;
}

// rm with -r, -R or --recursive (any order with -f, until --), Remove-Item and its names with -Recurse, or cmd's rd,
// rmdir, del and erase with /s (`cmd` here), whose target is a whole folder.
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
      else recursive ||= !!long(a, ["recursive"]) || (/^-[dfiIrRv]+$/.test(a) && /[rR]/.test(a)) || param(a, "recurse");
    }
    return recursive && targets.some((t) => whole(t, ctx));
  };
}

// The names that stand for the home folder and the current one, as a delete's target starts with them (any case, as
// PowerShell reads them).
const HOME = ["~", "$home", "${home}", "$env:userprofile", "${env:userprofile}"];
const PWD = ["$pwd", "${pwd}"];

// Whether a delete's target is a whole folder: a drive root, the home folder or the project's root, or a folder above one
// of them, once its path is worked out (the home names and $PWD filled in, a relative path taken from the line's folder,
// . and .. resolved). A trailing /* (or \*) and a lone * stand for the folder itself. A target that starts with a variable
// counts when the rest of it adds nothing below the variable (choice 45: "$d", "$d/*", "$S/.."), as an empty or wrong
// value deletes some other folder; so does one relative to a folder a cd left unknown.
function whole(target: string, ctx: Where): boolean {
  const windows = ctx.shell === "powershell" || /^[A-Za-z]:/.test(target);
  const p = windows ? path.win32 : path.posix;
  const t = (target === "*" ? "." : target).replace(windows ? /[\\/]\*$/ : /\/\*$/, "/");
  if (/^[A-Za-z]:$/.test(t)) return true; // a drive's own letter
  const start = /^(~|\$\{[\w:]+\}|\$[\w:]+)(?=$|[\\/])/.exec(t)?.[1];
  let base: string | undefined;
  let rest = t;
  if (start !== undefined) {
    rest = t.slice(start.length);
    base = HOME.includes(start.toLowerCase()) ? ctx.home : PWD.includes(start.toLowerCase()) ? ctx.cwd : undefined;
  } else if (!p.isAbsolute(t)) base = ctx.cwd;
  else return above(p.normalize(t), ctx, p);
  // A base known only when the line runs: whole if the rest stays at it or climbs out of it.
  if (base === undefined) {
    const below = p.normalize(rest.replace(/^[\\/]+/, "") || ".");
    return below === "." || below === ".." || below.startsWith(`..${p.sep}`);
  }
  return above(p.join(base, rest), ctx, p);
}

// Whether a worked-out path is a drive root, or the home folder or the project's root, or a folder they are in.
function above(full: string, ctx: Where, p: path.PlatformPath): boolean {
  const fold = (s: string) => (p === path.win32 ? s.toLowerCase() : s);
  const trim = (s: string) => {
    const n = p.normalize(s);
    return n.length > p.parse(n).root.length ? n.replace(/[\\/]+$/, "") : n;
  };
  const f = fold(trim(full));
  if (f === fold(p.parse(f).root)) return true;
  return [ctx.home, ctx.root].some((folder) => {
    const g = fold(trim(folder));
    return g === f || g.startsWith(f.endsWith(p.sep) ? f : f + p.sep);
  });
}

// git's options before its subcommand that take the next word (`git --help`).
const GIT_VALUES = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"];
function rewritesHistory(args: string[]): boolean {
  let k = 0;
  while (k < args.length && args[k]!.startsWith("-")) k += GIT_VALUES.includes(args[k]!) ? 2 : 1;
  const command = args[k]?.toLowerCase();
  const rest = args.slice(k + 1);
  const has = (name: string, letter: string) => rest.some((a) => long(a, [name]) === name || short(a, letter));
  const dot = rest.some((a) => /^\.[\\/]?$/.test(a));
  switch (command) {
    case "push": {
      // --force, -f, --force-with-lease, --delete, -d, a :branch refspec, or a +branch one, which forces it.
      // --force-if-includes changes nothing on its own.
      const options = rest.map((a) => long(a, ["force", "force-with-lease", "delete", "force-if-includes"]));
      return options.some((o) => o === "force" || o === "force-with-lease" || o === "delete")
        || rest.some((a) => short(a, "f") || short(a, "d") || /^[:+]./.test(a));
    }
    case "reset":
      return rest.some((a) => long(a, ["hard"]));
    case "clean":
      return has("force", "f") && rest.some((a) => short(a, "d"));
    case "checkout":
      return dot;
    case "restore": // --staged alone only unstages
      return dot && (!has("staged", "S") || has("worktree", "W"));
    case "branch":
      return rest.some((a) => short(a, "D")) || (has("delete", "d") && has("force", "f"));
    case "filter-branch":
    case "filter-repo":
    case "rebase":
      return true;
    default:
      return false;
  }
}

// curl sending a file: -T or --upload-file, -F or --form..., -K or --config (whose file can hold any of these), or -d,
// --data..., --json or -H and --header with a value starting with @ (a file's contents); --data-urlencode with @ before
// any = (name@file). A bundle of short options holding T, F or K counts, and one holding d or H whose value, after it or
// in the next word, starts with @.
const CURL_LONG = ["upload-file", "form", "form-string", "config", "json", "header", "data", "data-ascii", "data-binary", "data-raw", "data-urlencode"];
function uploads(args: string[]): boolean {
  return args.some((a, k) => {
    const next = args[k + 1] ?? "";
    const option = long(a, CURL_LONG);
    if (option === "data-urlencode") return /^[^=]*@/.test(next);
    if (option) return ["upload-file", "form", "form-string", "config"].includes(option) || next.startsWith("@");
    const m = /^-([A-Za-z]*?)[dH](.*)$/.exec(a);
    return /^-[A-Za-z]*[TFK]/.test(a) || (!!m && /^[A-Za-z]*$/.test(m[1]!) && (m[2] || next).startsWith("@"));
  });
}

// rsync's target on another machine: host:path or user@host:path, not a drive letter, or an rsync:// address.
const remote = (target: string) => /^rsync:\/\//i.test(target) || /^[^/:]{2,}:/.test(target);

// npm's names for install (`npm help install`'s aliases), and the plan's for pnpm, yarn and bun (bun's add is also a).
const NPM_INSTALL = ["install", "add", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall"];
const INSTALL = ["install", "i", "add"];
// An install subcommand with a package named: a word after it not starting with -.
function addsPackage(args: string[], names: string[]): boolean {
  return !!after(args, ...names)?.some((a) => !a.startsWith("-"));
}
// npm exec (or x) and bun x with a package: a word after them that is not an option, or npm's --package.
const runsPackage = (rest: string[] | undefined) => !!rest?.some((a) => !a.startsWith("-") || !!long(a, ["package"]) || a === "-p");

// python -m pip: the words pip is given.
function pipOf(args: string[]): string[] | undefined {
  const k = args.findIndex((a, i) => a === "-mpip" || (a === "-m" && args[i + 1] === "pip"));
  return k < 0 ? undefined : args.slice(k + (args[k] === "-m" ? 2 : 1));
}

// pip's options that take a value (pip's documentation: pip install's options and pip's general ones). pip also reads a
// long option from any start of its name, but only a name written in full has its value skipped: a start such as --pre
// may be a flag of its own (pip install --pre), and skipping the word after it could hide a package.
const PIP_SHORT = ["-r", "-c", "-t", "-C", "-i", "-f"];
const PIP_LONG = [
  "requirement", "constraint", "target", "config-settings", "index-url", "find-links", "build-constraint", "requirements-from-script",
  "platform", "python-version", "implementation", "abi", "root", "prefix", "src", "upgrade-strategy", "progress-bar", "root-user-action",
  "report", "group", "extra-index-url", "refresh-package", "uploaded-prior-to", "all-releases", "only-final", "no-binary", "only-binary",
  "log", "python", "proxy", "retries", "resume-retries", "timeout", "exists-action", "trusted-host", "cert", "client-cert", "cache-dir",
  "keyring-provider", "use-feature", "use-deprecated",
];
// pip install's words name a package: a word not starting with - that is no option's value.
function pipPackage(rest: string[] | undefined): boolean {
  for (let k = 0; k < (rest?.length ?? 0); k++) {
    const a = rest![k]!;
    if (PIP_SHORT.includes(a) || PIP_LONG.includes(a.slice(2))) k++;
    else if (!a.startsWith("-")) return true;
  }
  return false;
}
