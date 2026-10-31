// The dangerous-command check's rules (release 7 design, "The dangerous-command check"; plan, Task 3 and choices 4 and
// 43-52). A line is split into its commands (split.ts), and each command is matched by its first word, its name without a
// folder or .exe, and where a rule says, by its arguments. A line the reader cannot read counts as dangerous.

import { existsSync } from "node:fs";
import path from "node:path";
import { type Command, nameOf, scriptOf, type Shell, split, WSL_VALUES } from "./split.js";

export const KINDS = ["wiping or formatting disks", "deleting whole folders", "permissions and system settings",
  "stopping processes or the machine", "rewriting or deleting git history", "sending files out", "installing software",
  "downloading and running code", "acting outside the machine"] as const;
export type Kind = (typeof KINDS)[number];
// `command` is the command's own text, for the red line; for the one danger of an unreadable line, it is why.
export interface Danger {
  kind: Kind | "unreadable";
  command: string;
}
// The project's root (/work in the box), the home folder, the shell the line runs in (choice 3), and whether a file
// exists, for npx of a program the project has (choice 47; fs.existsSync unless given).
export interface Context {
  root: string;
  home: string;
  shell: Shell;
  has?: (file: string) => boolean;
}

// How a danger is shown, in the red line and in a refusal.
export function shown(d: Danger): string {
  return d.kind === "unreadable" ? `the check cannot read it: ${d.command}` : `${d.kind}: ${d.command}`;
}

export function dangers(line: string, ctx: Context): Danger[] {
  const result = split(line, ctx.shell);
  if ("unreadable" in result) return [{ kind: "unreadable", command: result.unreadable }];
  const where: Where = { ...ctx, cwds: folders(result.all, ctx, line) };
  const found: Danger[] = [];
  for (const { words, text } of result.commands) {
    for (const kind of matched(words, where)) {
      if (!found.some((d) => d.kind === kind && d.command === text)) found.push({ kind, command: text });
    }
  }
  return found;
}

// The context, with the folders the line's commands may run in, undefined when a change of folder leaves them unknown.
interface Where extends Context {
  cwds: string[] | undefined;
}

// The folders a line's commands may run in (choice 52, and Task 3's final check). Each call starts a new shell in the
// project's root (tools/shell.ts), and each literal cd is followed, in the order written (split's `all`, which keeps a
// repeated cd). Every folder met counts for every command, as the reader does not follow subshells or a cd that fails:
// `(cd sub)`, `bash -c 'cd sub'`, or a cd to a folder that is not there, leaves the line where it was. So a cd's folder is
// added beside those before it, and a cd from the current folder is worked out from each of them. More than one such cd
// leaves the folder unknown, as each would double the list, and so does one on a line with a loop or a function, which
// may run it more than once. Undefined too when a change of folder cannot be placed, the line makes a link, or bash's
// CDPATH, HOME or PWD is set, read or declared anywhere on it (bare, in any quoting, or by ${NAME=} or ${NAME:=});
// $HOME, ${HOME} and ${HOME:-x} only read it.
function folders(commands: Command[], ctx: Context, line: string): string[] | undefined {
  const named = /(?<![\w$]|\$\{)(CDPATH|HOME|PWD)\b|\$\{(CDPATH|HOME|PWD):?=/.test(line) || commands.some(({ words }) => words.some((w) => BARE.test(w)));
  if (ctx.shell === "bash" && named) return undefined;
  const repeats = REPEATS.test(line);
  const found = new Set([ctx.root]);
  let relative = 0;
  for (const { words } of commands) {
    const to = movedTo(words, ctx);
    if (to === undefined) return undefined;
    if (to === null) continue;
    const here = fromHere(to, ctx);
    if (here && (repeats || ++relative > 1)) return undefined;
    // A cd from the current folder is worked out from each folder met (from a copy, as the set grows here); a cd to a
    // folder of its own (absolute, ~ or $HOME) is worked out once, except PowerShell's \x, which keeps the current drive.
    for (const from of here || driveRooted(to, ctx) ? [...found] : [ctx.root]) {
      const folder = placed(to, from, ctx);
      if (folder === undefined) return undefined;
      found.add(folder);
    }
  }
  return [...found];
}
// bash's CDPATH, HOME or PWD as a word of a command, after its quotes are taken off: the name alone, NAME=..., or a
// declare -n's target (r=HOME).
const BARE = /(^|=)(CDPATH|HOME|PWD)(\+?=|$)/;
// Loops and functions, found in the line's text: bash's for, while, until and select, and its functions (`name() {` and
// `function name`); PowerShell's foreach, for, while and do, ForEach-Object and Where-Object (and %, ?, .ForEach() and
// .Where()), which run a block for each item, and its function and filter.
const REPEATS = new RegExp(
  [
    /(^|[\s;&|(){}])(for|while|until|select|function|foreach|do|filter|foreach-object|where-object|%|\?)(?=[\s{(]|$)/.source,
    /(^|[\s;&|(){}])[\w.:-]+\s*\(\s*\)\s*[{(]/.source,
    /\.(foreach|where)\s*\(/.source,
  ].join("|"),
  "i",
);

// Whether a cd's target is worked out from the current folder: a relative path, or one that starts with $PWD or ~+.
function fromHere(target: string, ctx: Context): boolean {
  const t = plain(target, ctx);
  const start = leading(t, ctx.shell);
  return start !== undefined ? PWD.includes(start.toLowerCase()) : !paths(t, undefined, ctx).isAbsolute(t);
}
// A Windows path from the current drive's root (\x), which has no drive of its own.
const driveRooted = (target: string, ctx: Context) => paths(plain(target, ctx), undefined, ctx) === path.win32 && /^[\\/](?![\\/])/.test(plain(target, ctx));

// Commands that change the folder: cd and its PowerShell and cmd names (Set-Location's cd, chdir and sl), and pushd and
// Push-Location, which are followed; popd and Pop-Location go back to a folder the check does not keep.
const FOLLOWED = ["cd", "chdir", "pushd", "set-location", "sl", "push-location"];
const BACK = ["popd", "pop-location"];
// PowerShell's parameters of Set-Location and Remove-Item that name the path, by their full names and other names.
const PATH_PARAMS = ["path", "literalpath", "pspath", "lp"];
const pathParam = (a: string) => PATH_PARAMS.some((n) => param(a, n));

// The target of a command that changes the line's folder: null when it does not change it, undefined when the check cannot
// place it: popd; cmd's and PowerShell's cd\ and cd.. (joined to their name, as cmd also ends it at ; , = and +); a cd
// behind builtin or command; a target of -, cmd's /d, or more than one word; and commands that run another elsewhere or
// make a link (elsewhere).
function movedTo(words: string[], ctx: Context): string | null | undefined {
  const [first = "", ...args] = words;
  const name = nameOf(first);
  if (/^(cd|chdir)[\\/.;,=+]/i.test(first) || BACK.includes(name)) return undefined;
  if ((name === "builtin" || name === "command") && FOLLOWED.includes(nameOf(args[0] ?? ""))) return undefined;
  if (elsewhere(name, args)) return undefined;
  if (!FOLLOWED.includes(name)) return null;
  const targets: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a === "--") {
      targets.push(...args.slice(k + 1));
      break;
    }
    if (/^-[LPe@]+$/.test(a) || param(a, "passthru")) continue; // bash's cd -L, -P, -e and -@; PowerShell's -PassThru
    if (pathParam(a)) {
      const value = psValue(a);
      if (value !== undefined) targets.push(value); // -Path:value; with no value, the target is the next word
    } else if (/^[-+]/.test(a) || /^\/d$/i.test(a)) return undefined; // cd -, the folder stack, an option not known, cmd's /d
    else targets.push(a);
  }
  if (targets.length > 1) return undefined;
  if (targets.length === 0) return ctx.shell === "bash" && name === "cd" ? "~" : undefined; // bash's cd alone goes home
  return targets[0]!;
}

// Commands that run another in a folder of their own: find -execdir and -okdir, env -C or --chdir, sudo -D or --chdir,
// pwsh -WorkingDirectory (-wo... or -wd), Start-Process -WorkingDirectory, wsl --cd, unshare --root or --wd, chroot, and
// systemd-run, whose service starts in / or the home folder. And commands that make a link, through which any relative
// path may lead anywhere: ln, cmd's mklink, and New-Item with an -ItemType that may be SymbolicLink, Junction or HardLink.
function elsewhere(name: string, args: string[]): boolean {
  const letter = (l: string) => args.some((a) => /^-[A-Za-z]+/.test(a) && !a.startsWith("--") && a.includes(l));
  switch (name) {
    case "find":
      return args.some((a) => a === "-execdir" || a === "-okdir");
    case "env":
      return letter("C") || args.some((a) => !!long(a, ["chdir"]));
    case "sudo":
      return letter("D") || args.some((a) => !!long(a, ["chdir"]));
    case "pwsh":
    case "powershell":
      return args.some((a) => (param(a, "workingdirectory") && /^-wo/i.test(a)) || /^-wd(:|$)/i.test(a));
    case "start-process":
    case "saps":
    case "start":
      return args.some((a) => param(a, "workingdirectory"));
    case "wsl":
      return wslOwn(args).includes("--cd");
    case "unshare":
      return letter("R") || letter("w") || args.some((a) => !!long(a, ["root", "wd"]));
    case "chroot":
    case "systemd-run":
    case "ln":
    case "mklink":
      return true;
    case "new-item":
    case "ni": // -ItemType's other name is -Type
      return args.some((a, k) => (param(a, "itemtype") || param(a, "type")) && !plainItem(psValue(a) ?? args[k + 1] ?? ""));
    default:
      return false;
  }
}

// New-Item's FileSystem provider matches -ItemType as `<value>*`, with wildcards, against directory and container, then
// file, then symboliclink, junction and hardlink. A value without a wildcard that starts directory, file or container makes
// no link; any other may.
const plainItem = (v: string) => v !== "" && !/[*?[\]]/.test(v) && ["directory", "file", "container"].some((t) => t.startsWith(v.toLowerCase()));

// The folder a cd's target names, from folder `from`; undefined when it is known only when the line runs: a drive's own
// folder (D:) or another kind of drive (HKLM:, Env:), a variable other than the home names and $PWD, a ~ form other than
// ~ and ~+, a command's output, or a glob.
function placed(target: string, from: string, ctx: Context): string | undefined {
  const t = plain(target, ctx);
  const p = paths(t, from, ctx);
  const start = leading(t, ctx.shell);
  if (start !== undefined) {
    const base = baseOf(start, from, ctx);
    const rest = t.slice(start.length);
    return base === undefined || /[$`*?[{]/.test(rest) ? undefined : p.join(base, rest);
  }
  if (/^[^\\/]+:(?![\\/])|^[^\\/]{2,}:/.test(t)) return undefined;
  return /[$`*?[{]/.test(t) ? undefined : p.resolve(from, t);
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
// is named by one (uv run https://...), or one given to deno install or deno x. Choice 50: deno's npm: and jsr: packages.
const WEB = /^https?:\/\//i;
const DENO_PACKAGE = /^(npm|jsr):/i;
function fetched(first: string, words: string[], name: string, args: string[]): boolean {
  const script = scriptOf(words) ?? "";
  if (WEB.test(first) || WEB.test(script) || (name === "deno" && DENO_PACKAGE.test(script))) return true;
  return name === "deno" && ["install", "x"].includes(args[0] ?? "") && args.some((a) => WEB.test(a) || DENO_PACKAGE.test(a));
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
// The value of a PowerShell parameter written -Name:value, or undefined.
const psValue = (a: string) => /^-[A-Za-z]+:(.+)$/.exec(a)?.[1];
// chmod's and chown's -R or --recursive.
const recursiveOption: Test = (args) => args.some((a) => !!long(a, ["recursive"]) || short(a, "R"));
// Invoke-WebRequest's and Invoke-RestMethod's -InFile, which uploads a file. Windows PowerShell 5.1's curl and wget name
// Invoke-WebRequest; there -InFile is taken from -in on, as curl's own -I (only the headers) is the same letter.
const inFile: Test = (args) => args.some((a) => param(a, "infile"));
const aliasInFile = (args: string[], ctx: Where, first: string) =>
  ctx.shell === "powershell" && /^(curl|wget)$/i.test(first) && args.some((a) => a.length > 2 && param(a, "infile"));
// A key under HKLM: or HKCU:, or any written with the Registry:: provider (choice 52), also as -Path:value or in a comma list.
const REGISTRY = /^(hklm|hkcu):|^(microsoft\.powershell\.core\\)?registry::/i;
const registry: Test = (args) => args.some((a) => (psValue(a) ?? a).split(",").some((v) => REGISTRY.test(v)));

// Every built-in name of Remove-Item (its documentation's Notes), and cmd's rd, rmdir, del and erase, which take /s.
const REMOVE = ["rm", "remove-item", "ri", "rd", "rmdir", "del", "erase"];
const CMD_REMOVE = ["rd", "rmdir", "del", "erase"];

// icacls's switches that change nothing (`icacls /?`): /save writes the lists to a file, /findsid and /verify look, and
// /t, /c, /l and /q change how it walks and reports, and /? prints its help. Any other switch changes something, or is not
// known (choice 48).
const ICACLS_LOOK = ["/save", "/findsid", "/verify", "/t", "/c", "/l", "/q", "/?"];

const RULES: Record<Kind, Record<string, Test>> = {
  "wiping or formatting disks": {
    format: ANY,
    diskpart: ANY,
    "clear-disk": ANY,
    "format-volume": ANY,
    "initialize-disk": ANY,
    mkfs: ANY,
    wipefs: ANY,
    // Choice 51: fdisk -l only lists, and parted -l too when it is given nothing else to do.
    fdisk: (args) => !args.some((a) => /^-[lu]*l[lu]*$/.test(a) || long(a, ["list"]) === "list"),
    parted: (args) => !(args.some((a) => a === "-l" || long(a, ["list"]) === "list") && args.every((a) => a.startsWith("-"))),
    dd: (args) => args.some((a) => a.startsWith("of=/dev/") && !/^of=\/dev\/(null|stdout|stderr)$/.test(a)),
    cipher: (args) => args.some((a) => /^\/w(:|$)/i.test(a)),
    wsl: (args) => wslOwn(args).includes("--unregister"), // choice 43: it deletes the distribution's disk
  },
  "deleting whole folders": Object.fromEntries(REMOVE.map((n): [string, Test] => [n, deletesWhole])),
  "permissions and system settings": {
    icacls: (args) => args.some((a) => /^[/-]./.test(a) && !ICACLS_LOOK.includes(a.toLowerCase())),
    takeown: ANY,
    cacls: ANY,
    "set-acl": ANY,
    chmod: recursiveOption,
    chown: recursiveOption,
    // Choice 48: reg query only reads, and /? straight after reg or its subcommand only prints help.
    reg: (args) => !/^query$/i.test(args[0] ?? "") && args[0] !== "/?" && args[1] !== "/?",
    "set-itemproperty": registry,
    sp: registry, // Set-ItemProperty's built-in name
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
    systemctl: named("stop", "poweroff", "reboot", "halt", "kill"),
    wsl: (args) => wslOwn(args).some((a) => ["--shutdown", "--terminate", "-t"].includes(a)), // choice 43
  },
  "rewriting or deleting git history": { git: rewritesHistory },
  "sending files out": {
    curl: (args, ctx, first) => uploads(args) || aliasInFile(args, ctx, first),
    wget: (args, ctx, first) => args.some((a) => !!long(a, ["post-file", "body-file"])) || aliasInFile(args, ctx, first),
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
    npm: (args) => addsPackage(args, NPM_INSTALL, NPM_VALUES) || runsPackage(after(args, "exec", "x")),
    pnpm: (args, ctx, first) => addsPackage(args, INSTALL, PNPM_VALUES) || named("dlx")(args, ctx, first),
    // yarn global add, and yarn workspace <name> add, which install as yarn add does.
    yarn: (args, ctx, first) =>
      [args, after(args, "global") ?? [], after(args, "workspace")?.slice(1) ?? []].some((w) => addsPackage(w, INSTALL, YARN_VALUES))
      || named("dlx")(args, ctx, first),
    bun: (args) => addsPackage(args, [...INSTALL, "a"], BUN_VALUES) || runsPackage(after(args, "x")),
    npx: (args, ctx) => !local(args, ctx),
    pnpx: ANY, // pnpm dlx's other name
    bunx: ANY,
    pip: (args) => pipPackage(after(args, "install")),
    python: (args) => pipPackage(after(pipOf(args) ?? [], "install")), // python -m pip, and py's
    // uv add, uv pip install with a package, and uv tool install or run (uvx's long form).
    uv: (args) =>
      after(args, "add") !== undefined || pipPackage(after(after(args, "pip") ?? [], "install"))
      || after(after(args, "tool") ?? [], "install", "run") !== undefined,
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
      if (pr && after(pr, "merge") !== undefined) return true;
      return GH_DELETES.some(([group, names]) => {
        const rest = group.reduce<string[] | undefined>((w, n) => w && after(w, n), args);
        return !!rest && after(rest, ...names) !== undefined;
      });
    },
    terraform: named("apply", "destroy"),
    pulumi: named("up", "update", "destroy", "down"), // up's and destroy's other names, from pulumi's source
    kubectl: anyWord("delete", "apply"),
    helm: named("uninstall", "del", "delete", "un"), // uninstall's other names, from helm's source
    aws: awsDeletes,
    gcloud: anyWord("delete"),
    az: anyWord("delete"),
    // docker push and docker image push, docker compose push, and a build that pushes (buildx's --push, or build's).
    docker: (args) =>
      after(args, "push") !== undefined || after(after(args, "image", "compose") ?? [], "push") !== undefined
      || !!after(args, "buildx", "build")?.some((a) => a === "--push" || /^--push=(true|t|1)$/i.test(a)),
    "docker-compose": named("push"),
    npm: named("publish"),
    pnpm: named("publish"),
    yarn: (args) => after(args, "publish") !== undefined || after(after(args, "npm") ?? [], "publish") !== undefined,
    bun: named("publish"),
  },
};

// gh's commands that delete on GitHub (`gh <command> --help`, gh 2): the command's words, and its deleting subcommands with
// their other names. gh alias delete and gh extension remove change only this machine.
const GH_DELETES: [string[], string[]][] = [
  [["repo"], ["delete"]],
  [["repo", "deploy-key"], ["delete"]],
  [["repo", "autolink"], ["delete"]],
  [["release"], ["delete", "delete-asset"]],
  [["issue"], ["delete"]],
  [["gist"], ["delete"]],
  [["secret"], ["delete", "remove"]],
  [["variable"], ["delete", "remove"]],
  [["label"], ["delete"]],
  [["run"], ["delete"]],
  [["cache"], ["delete"]],
  [["ssh-key"], ["delete"]],
  [["gpg-key"], ["delete"]],
  [["codespace"], ["delete"]],
  [["cs"], ["delete"]],
  [["project"], ["delete", "item-delete", "field-delete"]],
];

// aws's own options (`aws help`, AWS CLI 2): those that take the next word as their value, and those that take none.
const AWS_VALUES = [
  "--region", "--output", "--profile", "--endpoint-url", "--query", "--ca-bundle", "--cli-read-timeout", "--cli-connect-timeout", "--color",
  "--cli-binary-format",
];
const AWS_FLAGS = [
  "--debug", "--no-verify-ssl", "--no-paginate", "--no-sign-request", "--no-cli-pager", "--cli-auto-prompt", "--no-cli-auto-prompt", "--version",
];
// aws's operation, its second word that is not an option (after the service), is a delete when it is named delete... or
// terminate..., s3's rm or rb, or s3 sync with --delete, which deletes what is not on the source (choice 51: only the
// operation counts). An option it does not know is read both with and without the next word as its value.
function awsDeletes(args: string[]): boolean {
  const words = (unknownTakesValue: boolean) => {
    const out: string[] = [];
    for (let k = 0; k < args.length; k++) {
      const a = args[k]!;
      if (!a.startsWith("-")) out.push(a);
      else if (!a.includes("=") && (AWS_VALUES.includes(a) || (unknownTakesValue && !AWS_FLAGS.includes(a)))) k++;
    }
    return out;
  };
  return [words(false)[1], words(true)[1]].some((op = "") =>
    /^(delete|terminate)/i.test(op) || /^(rm|rb)$/i.test(op) || (/^sync$/i.test(op) && args.some((a) => !!long(a, ["delete"]))));
}

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

// A recursive delete whose target, from any folder the line may run in, is a whole folder.
// A target that is not worked out from the current folder is the same from each, so it is worked out once. One that is,
// but does not climb (no ..), names the folder or one below it, so it is whole only from a folder that is whole itself.
function deletesWhole(args: string[], ctx: Where, first: string): boolean {
  const cwds = ctx.cwds ?? [undefined];
  let wholeCwds: (string | undefined)[] | undefined;
  const from = (t: string) => {
    if (!fromHere(t, ctx)) return cwds.slice(0, 1);
    if (/(^|[\\/])\.\.([\\/]|$)/.test(t)) return cwds;
    return (wholeCwds ??= cwds.filter((c) => c === undefined || above(c, ctx, paths(c, c, ctx))));
  };
  return !!targetsOf(nameOf(first), args, ctx)?.some((t) => from(t).some((cwd) => whole(t, ctx, cwd)));
}

// A recursive delete's targets, or undefined when it is not recursive: rm with -r, -R or --recursive (in any bundle of GNU's
// and BSD's letters, until --), Remove-Item and its names with -Recurse, or cmd's rd, rmdir, del and erase with /s (choice
// 52). PowerShell's -Path:value gives a target; a comma list (C:\,dist) is split into its targets, except for bash's rm,
// which reads a comma as part of the name; and cmd's *.* is every file, as * is.
function targetsOf(name: string, args: string[], ctx: Context): string[] | undefined {
  const cmd = CMD_REMOVE.includes(name);
  const comma = !(name === "rm" && ctx.shell === "bash");
  let recursive = false;
  let ended = false;
  const targets: string[] = [];
  const add = (a: string) => {
    for (const t of comma ? a.split(",").filter(Boolean) : [a]) targets.push(cmd ? t.replace(/(^|[\\/])\*\.\*$/, "$1*") : t);
  };
  for (const a of args) {
    const value = psValue(a);
    if (ended || !a.startsWith("-") || a === "-") {
      if (cmd && /^(\/[A-Za-z])+$/.test(a)) recursive ||= /\/s/i.test(a); // cmd's switches, as /s/q
      else add(a);
    } else if (a === "--") ended = true;
    else if (value !== undefined && pathParam(a)) add(value);
    else {
      recursive ||= !!long(a, ["recursive"]) || (/^-[dfiIPrRvWx]+$/.test(a) && /[rR]/.test(a)) || (param(a, "recurse") && !/:\$?(false|0)$/i.test(a));
    }
  }
  return recursive ? targets : undefined;
}

// The names that stand for the home folder and the current one, as a path starts with them (any case, as PowerShell reads
// them); bash's ~+ is the current folder.
const HOME = ["~", "$home", "${home}", "$env:userprofile", "${env:userprofile}"];
const PWD = ["$pwd", "${pwd}", "$pwd.path", "~+"];
const baseOf = (start: string, cwd: string | undefined, ctx: Context) =>
  HOME.includes(start.toLowerCase()) ? ctx.home : PWD.includes(start.toLowerCase()) ? cwd : undefined;
const DRIVE = /^[A-Za-z]:/;

// The path functions for a path: Windows's in PowerShell, for a path with a drive, or from a folder on one.
const paths = (t: string, cwd: string | undefined, ctx: Context) =>
  ctx.shell === "powershell" || DRIVE.test(t) || DRIVE.test(cwd ?? ctx.root) ? path.win32 : path.posix;

// A path as the rules read it (choice 52): PowerShell's FileSystem:: form without its prefix, and Git Bash's /c/... as
// C:\... when the project's root is on Windows.
function plain(target: string, ctx: Context): string {
  const t = target.replace(/^(microsoft\.powershell\.core\\)?filesystem::/i, "");
  const m = ctx.shell === "bash" && DRIVE.test(ctx.root) ? /^\/([A-Za-z])(?=\/|$)(.*)$/.exec(t) : null;
  return m ? `${m[1]}:${m[2] || "\\"}` : t;
}

// Where the variable or command substitution at t[k] ends; k when there is none. $name (and PowerShell's $env:name), ${...}
// and $(...) with what they hold, bash's backtick pairs and $@, $* and the like, and PowerShell's members and subscripts
// after a variable ($d.FullName, $a[0]), which it reads in a command's words.
function token(t: string, k: number, shell: Shell): number {
  if (t[k] === "`" && shell === "bash") {
    const close = t.indexOf("`", k + 1);
    return close < 0 ? k : close + 1;
  }
  if (t[k] !== "$") return k;
  if (t[k + 1] === "{" || t[k + 1] === "(") {
    const [open, close] = t[k + 1] === "{" ? ["{", "}"] : ["(", ")"];
    for (let depth = 0, j = k + 1; j < t.length; j++) {
      if (t[j] === open) depth++;
      else if (t[j] === close && --depth === 0) return j + 1;
    }
    return k;
  }
  const name = /\$(?:[\w:]+|[@*#?$!-])/y;
  name.lastIndex = k;
  if (!name.exec(t)) return k;
  if (shell === "bash") return name.lastIndex;
  const members = /(?:\.\w+|\[[^\]]*\])*/y;
  members.lastIndex = name.lastIndex;
  members.exec(t);
  return members.lastIndex;
}
// Where a run of variables and command substitutions from the start of t ends.
function variables(t: string, shell: Shell): number {
  let k = 0;
  for (let end = token(t, 0, shell); end > k; end = token(t, k, shell)) k = end;
  return k;
}
// The ~ form, or the run of variables and command substitutions, a path starts with, up to a separator or its end. bash
// also has ~+ (the current folder), ~- (the one before) and ~name (another's home).
function leading(t: string, shell: Shell): string | undefined {
  const tilde = (shell === "bash" ? /^~(?:[+-]|[\w.-]+)?(?=$|\/)/ : /^~(?=$|[\\/])/).exec(t)?.[0];
  if (tilde !== undefined) return tilde;
  const k = variables(t, shell);
  return k > 0 && (k === t.length || /[\\/]/.test(t[k]!)) ? t.slice(0, k) : undefined;
}

// Whether a delete's target is a whole folder: a drive root, the home folder or the project's root, or a folder above one
// of them, once its path is worked out from folder `cwd` (the home names and $PWD filled in, a relative path taken from the
// folder, . and .. resolved). A trailing /* (or \*) and a lone * stand for the folder itself. A target that starts with a
// variable or a command's output counts when the rest of it adds nothing below the start (choice 45: "$d", "$d/*",
// "$S/.."), as an empty or wrong value deletes some other folder; parts of the rest that are only variables add nothing, as
// they may be empty (choice 52: "$d/$e"). While the folder is unknown, any relative path counts (choice 53: of 34,507 past
// calls, 10 more ask).
function whole(target: string, ctx: Where, cwd: string | undefined): boolean {
  let t = plain(target, ctx);
  const p = paths(t, cwd, ctx);
  t = (t === "*" ? "." : t).replace(p === path.win32 ? /[\\/]\*$/ : /\/\*$/, "/");
  if (/^[A-Za-z]:$/.test(t)) return true; // a drive's own letter
  const start = leading(t, ctx.shell);
  let base: string | undefined;
  let rest = t;
  if (start !== undefined) {
    const parts = t.slice(start.length).split(/[\\/]/);
    rest = parts.filter((s) => !(s !== "" && variables(s, ctx.shell) === s.length)).join("/");
    base = baseOf(start, cwd, ctx);
  } else if (!p.isAbsolute(t)) {
    if (cwd === undefined) return !DRIVE.test(t);
    base = cwd;
  } else return above(p.normalize(t), ctx, p);
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
  // . or * (which bash expands to every file, and git itself in PowerShell) stands for the whole work tree.
  const all = rest.some((a) => /^(\.[\\/]?|\*)$/.test(a));
  switch (command) {
    case "push": {
      // --force, -f, --force-with-lease, --delete, -d, --mirror, --prune, a :branch refspec, or a +branch one, which forces
      // it. --force-if-includes changes nothing on its own.
      const options = rest.map((a) => long(a, ["force", "force-with-lease", "delete", "force-if-includes", "mirror", "prune"]));
      return options.some((o) => o !== undefined && o !== "force-if-includes")
        || rest.some((a) => short(a, "f") || short(a, "d") || /^[:+]./.test(a));
    }
    case "reset":
      return rest.some((a) => long(a, ["hard"]));
    case "clean": // -n or --dry-run only lists
      return has("force", "f") && rest.some((a) => short(a, "d")) && !has("dry-run", "n");
    case "checkout":
      return all || has("force", "f");
    case "restore": // --staged alone only unstages
      return all && (!has("staged", "S") || has("worktree", "W"));
    case "branch":
      return rest.some((a) => short(a, "D")) || (has("delete", "d") && has("force", "f"));
    case "rebase": // --abort and --continue finish one already started
      return !rest.some((a) => !!long(a, ["abort", "continue"]));
    case "filter-branch":
    case "filter-repo":
      return true;
    default:
      return false;
  }
}

// curl sending a file: -T or --upload-file, -F or --form, -K or --config (whose file can hold any of these), or -d,
// --data..., --json or -H and --header with a value starting with @ (a file's contents); --data-urlencode, --variable and
// --url-query with @ before any = (name@file); and the --expand-* options, whose {{variables}} can hold a file's contents
// (choice 50). --form-string sends no file (choice 51). In a bundle of short options, the first that takes a value takes
// the rest of the word, or the next word, as its value (choice 51: -uFred:pw is -u with Fred:pw).
const CURL_LONG = [
  "upload-file", "form", "form-string", "config", "json", "header", "data", "data-ascii", "data-binary", "data-raw", "data-urlencode",
  "variable", "url", "url-query",
];
// curl's short options that take a value (`curl --help all`).
const CURL_VALUES = "AbcCdDeEFHKmoPQrtTuUwxXyYz";
function uploads(args: string[]): boolean {
  return args.some((a, k) => {
    const next = args[k + 1] ?? "";
    if (a.startsWith("--expand-")) return true;
    const option = long(a, CURL_LONG);
    if (option === "data-urlencode" || option === "variable" || option === "url-query") return /^[^=]*@/.test(next);
    if (option === "url" || option === "form-string") return false;
    if (option) return ["upload-file", "form", "config"].includes(option) || next.startsWith("@");
    if (!/^-[^-]/.test(a)) return false;
    const j = [...a].findIndex((ch, i) => i > 0 && CURL_VALUES.includes(ch));
    if (j < 0) return false;
    const value = a.slice(j + 1) || next;
    return "TFK".includes(a[j]!) || ("dH".includes(a[j]!) && value.startsWith("@"));
  });
}

// rsync's target on another machine: host:path or user@host:path, not a drive letter, or an rsync:// address.
const remote = (target: string) => /^rsync:\/\//i.test(target) || /^[^/:]{2,}:/.test(target);

// npm's names for install (`npm help install`'s aliases, and install-test's, which installs as install does), and the
// plan's for pnpm, yarn and bun (bun's add is also a).
const NPM_INSTALL = [
  "install", "add", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "install-test", "it",
];
const INSTALL = ["install", "i", "add"];
// Each tool's options that take the next word as their value (choice 51; npm's config, pnpm's, yarn's and bun's
// documentation). As with pip, only a name written in full has its value skipped.
const NPM_VALUES = ["-w", "-C", ...[
  "prefix", "omit", "include", "loglevel", "registry", "cache", "userconfig", "globalconfig", "workspace", "tag", "install-strategy",
  "save-prefix", "before", "otp", "scope", "cafile", "ca", "cert", "key", "proxy", "https-proxy", "noproxy", "fetch-retries",
  "fetch-timeout", "script-shell", "node-options", "location", "lockfile-version", "cpu", "os", "libc",
].map((n) => `--${n}`)];
const PNPM_VALUES = ["-C", "-F", ...[
  "dir", "filter", "filter-prod", "reporter", "loglevel", "store-dir", "virtual-store-dir", "modules-dir", "lockfile-dir", "registry",
  "network-concurrency", "child-concurrency", "node-linker", "resolution-mode", "workspace-concurrency", "package-import-method",
  "test-pattern", "changed-files-ignore-pattern",
].map((n) => `--${n}`)];
const YARN_VALUES = [
  "cwd", "modules-folder", "cache-folder", "mutex", "network-timeout", "registry", "use-yarnrc", "global-folder", "link-folder",
  "network-concurrency", "otp", "preferred-cache-folder", "proxy", "https-proxy", "mode",
].map((n) => `--${n}`);
const BUN_VALUES = ["-c", ...[
  "cwd", "registry", "cache-dir", "config", "backend", "concurrent-scripts", "network-concurrency", "omit", "filter", "linker", "cpu",
  "os", "ca", "cafile", "minimum-release-age",
].map((n) => `--${n}`)];
// An install subcommand with a package named: a word after it not starting with - that is no option's value.
function addsPackage(args: string[], names: string[], values: string[]): boolean {
  const rest = after(args, ...names) ?? [];
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k]!;
    if (values.includes(a)) k++;
    else if (!a.startsWith("-")) return true;
  }
  return false;
}
// npm exec (or x) and bun x with a package: a word after them that is not an option, or npm's --package.
const runsPackage = (rest: string[] | undefined) => !!rest?.some((a) => !a.startsWith("-") || !!long(a, ["package"]) || a === "-p");

// Choice 47: npx runs a program the project holds, without downloading, when it is named plainly and every folder the line
// may run in has it in node_modules/.bin (as itself, or as Windows's .cmd). Its options (split.ts reads them) that take the
// next word are skipped; a package (-p, --package), shell text (-c, --call), another folder (--prefix) or the global one
// (-g, --global) run something else.
const NPX_VALUES = ["--workspace", "--loglevel", "--registry", "--cache", "--userconfig"];
function local(args: string[], ctx: Where): boolean {
  let k = 0;
  for (; k < args.length && args[k]!.startsWith("-"); k++) {
    const a = args[k]!;
    if (a === "--") {
      k++;
      break;
    }
    if (/^--(package|call|prefix|global)(=|$)/.test(a) || /^-[a-z]*[pcg]/.test(a)) return false;
    if (NPX_VALUES.includes(a) || /^-[a-z]*w$/.test(a)) k++;
  }
  const program = args[k] ?? "";
  if (!/^\w[\w.-]*$/.test(program) || ctx.cwds === undefined) return false;
  const has = ctx.has ?? existsSync;
  return ctx.cwds.every((cwd) => {
    const p = paths("", cwd, ctx);
    return [program, `${program}.cmd`].some((n) => has(p.join(cwd, "node_modules", ".bin", n)));
  });
}

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
